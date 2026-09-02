// @ts-check

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { ARTIFACT_CODES, ArtifactError, isArtifactError, isErrno } from './errors.js'
import { ARTIFACT_ID_PATTERN, digestBytes, validateArtifactRecord } from './record.js'

/** @typedef {import('./record.js').ArtifactRecord} ArtifactRecord */
/** @typedef {import('./record.js').ArtifactCapability} ArtifactCapability */

/**
 * Storage provider contract shared by the local filesystem provider, the
 * deterministic in-memory provider, and any future remote provider. Providers
 * own bytes and durable index records; the service owns authorization,
 * quotas, lifecycle, and typed outcomes.
 * @typedef ArtifactProvider
 * @property {readonly ArtifactCapability[]} capabilities
 * @property {string} [root]
 * @property {() => Promise<void>} init
 * @property {() => Promise<readonly ArtifactRecord[]>} list
 * @property {(id: string) => Promise<ArtifactRecord | undefined>} load
 * @property {(draft: {id: string, maxBytes: number}) => Promise<ArtifactStaging>} begin
 * @property {(record: ArtifactRecord) => Promise<void>} publish
 * @property {(record: ArtifactRecord, signal?: AbortSignal) => Promise<Uint8Array>} read
 * @property {(record: ArtifactRecord) => Promise<void>} remove
 * @property {(records: readonly ArtifactRecord[]) => Promise<void>} removeMany
 * @property {(generation: string) => Promise<void>} claimGeneration
 * @property {(generation: string) => Promise<void>} releaseGeneration
 * @property {(generation: string) => Promise<boolean>} generationAlive
 */

/**
 * One in-progress write. `commit` publishes the bytes or rejects; a rejected
 * commit must leave no staging behind, and `abort` after any outcome is a
 * harmless no-op so the service can always ask for cleanup.
 * @typedef ArtifactStaging
 * @property {(chunk: Uint8Array) => Promise<void>} write
 * @property {() => Promise<{sha256: string, bytes: number}>} commit
 * @property {() => Promise<void>} abort
 */

const OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW
const GENERATION_PATTERN = /^generation:([0-9a-f-]{36})$/

/**
 * Filesystem errors carry absolute store paths in their messages, so only the
 * errno code is retained; the raw error is never attached as a cause.
 * @param {string} message @param {unknown} [cause]
 */
function describe(message, cause) {
  return isErrno(cause) ? `${message} (${cause.code})` : message
}

/** @param {string} message @param {unknown} [cause] */
function unavailable(message, cause) {
  return new ArtifactError(describe(message, cause), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
}

/** @param {string} message @param {unknown} [cause] */
function corrupt(message, cause) {
  return new ArtifactError(describe(message, cause), ARTIFACT_CODES.CORRUPT)
}

/** @param {string} message @param {unknown} [cause] */
function writeFailed(message, cause) {
  return new ArtifactError(describe(message, cause), ARTIFACT_CODES.WRITE_FAILED)
}

/** @param {string} path */
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** @param {string} path */
async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/** @param {import('node:fs').Stats} metadata */
function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

/**
 * Content-addressed, owner-private local artifact storage below one 0700
 * root: `tmp/` staging, `objects/<aa>/<sha256>` immutable bytes, and
 * `index/<id>.json` durable records.
 * @implements {ArtifactProvider}
 */
export class LocalArtifactProvider {
  /** @type {readonly ArtifactCapability[]} */
  capabilities = Object.freeze(/** @type {const} */ (['read', 'present', 'export', 'delete']))
  /** @type {string} */
  root
  #initialized = false

  /** @param {{root: string}} config */
  constructor(config) {
    if (config === null || typeof config !== 'object' || typeof config.root !== 'string') {
      throw new TypeError('dsh-runtime-kit: artifact provider root must be a string')
    }
    this.root = config.root
  }

  async init() {
    if (this.#initialized) return
    if (!isAbsolute(this.root) || this.root.includes('\0')) {
      throw unavailable('artifact store root must be an absolute path')
    }
    const root = resolve(this.root)
    let metadata
    try {
      metadata = await lstat(root)
    } catch (error) {
      if (!isErrno(error) || error.code !== 'ENOENT') throw unavailable('artifact store root is unreadable', error)
      try {
        await ensurePrivateDirectory(root)
        metadata = await lstat(root)
      } catch (createError) {
        throw unavailable('artifact store root could not be created', createError)
      }
    }
    if (metadata.isSymbolicLink()) throw unavailable('artifact store root must not be a symbolic link')
    if (!metadata.isDirectory()) throw unavailable('artifact store root must be a directory')
    if (!ownedByCurrentUser(metadata)) throw unavailable('artifact store root must be owned by the current user')
    if ((metadata.mode & 0o077) !== 0) throw unavailable('artifact store root must be private (0700)')
    try {
      for (const child of ['tmp', 'objects', 'index', 'generations']) await ensurePrivateDirectory(join(root, child))
      await syncDirectory(root)
    } catch (error) {
      throw unavailable('artifact store layout could not be prepared', error)
    }
    this.root = root
    this.#initialized = true
  }

  #requireInit() {
    if (!this.#initialized) throw unavailable('artifact store is not initialized')
  }

  /** @param {string} sha256 */
  #objectPath(sha256) {
    const hex = sha256.slice('sha256:'.length)
    return join(this.root, 'objects', hex.slice(0, 2), hex)
  }

  /** @param {string} id */
  #indexPath(id) {
    return join(this.root, 'index', `${id}.json`)
  }

  async list() {
    this.#requireInit()
    let entries
    try {
      entries = await readdir(join(this.root, 'index'))
    } catch (error) {
      throw unavailable('artifact index is unreadable', error)
    }
    /** @type {ArtifactRecord[]} */
    const records = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      if (!ARTIFACT_ID_PATTERN.test(id)) continue
      try {
        const record = await this.load(id)
        if (record !== undefined) records.push(record)
      } catch (error) {
        if (isArtifactError(error) && error.code === ARTIFACT_CODES.METADATA_INVALID) continue
        throw error
      }
    }
    return Object.freeze(records)
  }

  /** @param {string} id */
  async load(id) {
    this.#requireInit()
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new ArtifactError('artifact id is invalid', ARTIFACT_CODES.REF_INVALID)
    let handle
    try {
      handle = await open(this.#indexPath(id), OBJECT_FLAGS)
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') return undefined
      if (isErrno(error) && error.code === 'ELOOP') throw new ArtifactError('artifact index entry is not a regular file', ARTIFACT_CODES.METADATA_INVALID)
      throw unavailable('artifact index entry is unreadable', error)
    }
    let raw
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size > 16 * 1024) throw new ArtifactError('artifact index entry is malformed', ARTIFACT_CODES.METADATA_INVALID)
      raw = await handle.readFile('utf8')
    } catch (error) {
      if (isArtifactError(error)) throw error
      throw unavailable('artifact index entry is unreadable', error)
    } finally {
      await handle.close()
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ArtifactError('artifact index entry is malformed', ARTIFACT_CODES.METADATA_INVALID)
    }
    return validateArtifactRecord(parsed, id)
  }

  /** @param {{id: string, maxBytes: number}} draft */
  async begin(draft) {
    this.#requireInit()
    if (!ARTIFACT_ID_PATTERN.test(draft.id)) throw writeFailed('artifact staging id is invalid')
    const temporary = join(this.root, 'tmp', draft.id)
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      throw writeFailed('artifact staging file could not be created', error)
    }
    const hash = createHash('sha256')
    let bytes = 0
    let open_ = true
    const root = this.root
    const objectPath = (/** @type {string} */ sha256) => this.#objectPath(sha256)
    const discard = async () => {
      if (handle !== undefined) {
        const current = handle
        handle = undefined
        await current.close().catch(() => {})
      }
      await unlink(temporary).catch((/** @type {unknown} */ error) => {
        if (!(isErrno(error) && error.code === 'ENOENT')) throw error
      })
    }
    return {
      /** @param {Uint8Array} chunk */
      async write(chunk) {
        if (!open_ || handle === undefined) throw writeFailed('artifact writer is not open')
        if (!(chunk instanceof Uint8Array)) throw writeFailed('artifact chunks must be bytes')
        if (bytes + chunk.byteLength > draft.maxBytes) {
          open_ = false
          await discard()
          throw new ArtifactError('artifact exceeds the configured byte limit', ARTIFACT_CODES.TOO_LARGE)
        }
        try {
          await handle.write(chunk)
        } catch (error) {
          open_ = false
          await discard()
          throw writeFailed('artifact staging write failed', error)
        }
        hash.update(chunk)
        bytes += chunk.byteLength
      },
      async commit() {
        if (!open_ || handle === undefined) throw writeFailed('artifact writer is not open')
        open_ = false
        const sha256 = `sha256:${hash.digest('hex')}`
        const target = objectPath(sha256)
        try {
          await handle.sync()
          await handle.close()
          handle = undefined
          await ensurePrivateDirectory(dirname(target))
          try {
            await link(temporary, target)
          } catch (error) {
            if (!(isErrno(error) && error.code === 'EEXIST')) throw error
            // Dedupe: another live record already published these exact
            // bytes. Verify before trusting the existing object.
            await verifyObject(target, sha256, bytes)
          }
          await syncDirectory(dirname(target))
          await syncDirectory(join(root, 'objects'))
          await unlink(temporary)
          await syncDirectory(join(root, 'tmp'))
        } catch (error) {
          await discard()
          if (isArtifactError(error)) throw error
          throw writeFailed('artifact object could not be published', error)
        }
        return { sha256, bytes }
      },
      async abort() {
        open_ = false
        await discard()
      },
    }
  }

  /** @param {ArtifactRecord} record */
  async publish(record) {
    this.#requireInit()
    const validated = validateArtifactRecord(record)
    const final = this.#indexPath(validated.id)
    const temporary = `${final}.tmp`
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(JSON.stringify(validated), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await lstat(final)
        throw writeFailed('artifact record already exists')
      } catch (error) {
        if (!(isErrno(error) && error.code === 'ENOENT')) throw error
      }
      await rename(temporary, final)
      await syncDirectory(dirname(final))
    } catch (error) {
      await unlink(temporary).catch(() => {})
      if (isArtifactError(error)) throw error
      throw writeFailed('artifact record could not be published', error)
    }
  }

  /** @param {ArtifactRecord} record @param {AbortSignal} [signal] */
  async read(record, signal) {
    this.#requireInit()
    signal?.throwIfAborted()
    const target = this.#objectPath(record.sha256)
    let handle
    try {
      handle = await open(target, OBJECT_FLAGS)
    } catch (error) {
      if (isErrno(error) && (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR')) {
        throw corrupt('artifact object is missing or not a regular file', error)
      }
      throw unavailable('artifact object is unreadable', error)
    }
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== record.bytes || !ownedByCurrentUser(metadata)) {
        throw corrupt('artifact object failed identity verification')
      }
      const data = new Uint8Array(await handle.readFile())
      signal?.throwIfAborted()
      if (digestBytes(data) !== record.sha256 || data.byteLength !== record.bytes) throw corrupt('artifact object failed digest verification')
      const after = await handle.stat()
      if (after.nlink !== 1 || after.size !== record.bytes || after.ino !== metadata.ino) throw corrupt('artifact object changed during read')
      return data
    } catch (error) {
      if (isArtifactError(error)) throw error
      if (signal?.aborted) throw error
      throw unavailable('artifact object is unreadable', error)
    } finally {
      await handle.close()
    }
  }

  /** @param {ArtifactRecord} record */
  async remove(record) {
    await this.removeMany([record])
  }

  /**
   * Remove a batch of records with one index scan: unlink every target index
   * entry first, list the survivors once, then remove only objects no
   * surviving record still references.
   * @param {readonly ArtifactRecord[]} records
   */
  async removeMany(records) {
    this.#requireInit()
    if (records.length === 0) return
    for (const record of records) {
      try {
        await unlink(this.#indexPath(record.id))
      } catch (error) {
        if (!(isErrno(error) && error.code === 'ENOENT')) throw unavailable('artifact record could not be removed', error)
      }
    }
    try {
      await syncDirectory(join(this.root, 'index'))
      const surviving = new Set((await this.list()).map(candidate => candidate.sha256))
      const orphaned = new Set(records.map(record => record.sha256).filter(sha256 => !surviving.has(sha256)))
      for (const sha256 of orphaned) {
        await rm(this.#objectPath(sha256), { force: true })
      }
      for (const bucket of new Set([...orphaned].map(sha256 => dirname(this.#objectPath(sha256))))) {
        await syncDirectory(bucket).catch(() => {})
      }
    } catch (error) {
      if (isArtifactError(error)) throw error
      throw unavailable('artifact object could not be removed', error)
    }
  }

  /** @param {string} generation */
  #generationPath(generation) {
    const match = GENERATION_PATTERN.exec(generation)
    return match?.[1] === undefined ? undefined : join(this.root, 'generations', `${match[1]}.json`)
  }

  /**
   * Record that this process owns one service generation. The record names
   * the owning pid so a later host can tell a live sibling from a dead one.
   * @param {string} generation
   */
  async claimGeneration(generation) {
    this.#requireInit()
    const path = this.#generationPath(generation)
    if (path === undefined) throw unavailable('artifact generation identity is invalid')
    try {
      await ensurePrivateDirectory(join(this.root, 'generations'))
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(join(this.root, 'generations'))
    } catch (error) {
      throw unavailable('artifact generation could not be claimed', error)
    }
  }

  /** @param {string} generation */
  async releaseGeneration(generation) {
    this.#requireInit()
    const path = this.#generationPath(generation)
    if (path === undefined) return
    await unlink(path).catch((/** @type {unknown} */ error) => {
      if (!(isErrno(error) && error.code === 'ENOENT')) throw unavailable('artifact generation could not be released', error)
    })
  }

  /**
   * Whether the process that claimed a generation is still alive. A missing
   * or unreadable claim means the owner is gone; an existing pid that cannot
   * be signalled is treated as alive so a sibling host is never reclaimed.
   * @param {string} generation
   */
  async generationAlive(generation) {
    this.#requireInit()
    const path = this.#generationPath(generation)
    if (path === undefined) return false
    let raw
    try {
      const handle = await open(path, OBJECT_FLAGS)
      try {
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isErrno(error) && (error.code === 'ENOENT' || error.code === 'ELOOP')) return false
      return true
    }
    let pid
    try {
      const parsed = JSON.parse(raw)
      pid = parsed?.pid
    } catch {
      return false
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return !(isErrno(error) && error.code === 'ESRCH')
    }
  }

  /** Number of staging files currently present (diagnostic only). */
  async stagingCount() {
    this.#requireInit()
    return (await readdir(join(this.root, 'tmp'))).length
  }
}

/**
 * @param {string} target
 * @param {string} sha256
 * @param {number} bytes
 */
async function verifyObject(target, sha256, bytes) {
  const handle = await open(target, OBJECT_FLAGS)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size !== bytes) throw corrupt('existing artifact object failed identity verification')
    if (digestBytes(new Uint8Array(await handle.readFile())) !== sha256) throw corrupt('existing artifact object failed digest verification')
  } finally {
    await handle.close()
  }
}

export default LocalArtifactProvider
