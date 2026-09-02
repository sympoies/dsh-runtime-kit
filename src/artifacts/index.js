// @ts-check

import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readlink, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { Service } from '@deepseek-ai/cordis'

import { ARTIFACT_CODES, ArtifactError, isArtifactError, isErrno } from './errors.js'
import {
  ARTIFACT_RECORD_SCHEMA,
  CONTAINS_CONTROL,
  CONTROL_CLASS,
  MEDIA_TYPE_PATTERN,
  RETENTION_CLASSES,
  TEXT_MEDIA_PATTERN,
  digestBytes,
  projectRecord,
} from './record.js'
import { createArtifactTools, ARTIFACT_TOOL_NAMES } from './tools.js'

export { ARTIFACT_CODES, ArtifactError, artifactFailureCode, isArtifactError } from './errors.js'
export { ARTIFACT_RECORD_SCHEMA, CAPABILITIES, RETENTION_CLASSES, TEXT_MEDIA_PATTERN, digestBytes, projectRecord } from './record.js'
export { createArtifactTools, ARTIFACT_TOOL_NAMES }

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('./record.js').ArtifactRecord} ArtifactRecord */
/** @typedef {import('./record.js').ArtifactProjection} ArtifactProjection */
/** @typedef {import('./record.js').RetentionClass} RetentionClass */
/** @typedef {import('./record.js').ArtifactCapability} ArtifactCapability */
/** @typedef {import('./local-provider.js').ArtifactProvider} ArtifactProvider */

export const ARTIFACT_EXPORT_RECEIPT_SCHEMA = 'dsh-runtime-kit.artifact-export-receipt.v1'
export const ARTIFACT_SERVICE_NAME = 'dshRuntimeArtifacts'

const DEFAULT_LIMITS = Object.freeze({
  maxArtifactBytes: 64 * 1024 * 1024,
  sessionQuotaBytes: 256 * 1024 * 1024,
  sessionMaxCount: 256,
  readMaxBytes: 256 * 1024,
  previewMaxBytes: 4 * 1024,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  retainedTtlMs: 7 * 24 * 60 * 60 * 1000,
})
const HARD_LIMITS = Object.freeze({
  maxArtifactBytes: 1024 * 1024 * 1024,
  sessionQuotaBytes: 8 * 1024 * 1024 * 1024,
  sessionMaxCount: 4096,
  readMaxBytes: 16 * 1024 * 1024,
  previewMaxBytes: 64 * 1024,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  retainedTtlMs: 365 * 24 * 60 * 60 * 1000,
})
const REF_PATTERN = /^artifact:([0-9a-f]{32})$/
const STRIP_CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'gu')

/** @typedef {typeof DEFAULT_LIMITS} ArtifactLimits */

/**
 * @typedef ArtifactWriteRequest
 * @property {string} [name]
 * @property {string} mediaType
 * @property {RetentionClass} [retention]
 * @property {string} producerTool
 */

/**
 * @typedef ArtifactServiceConfig
 * @property {ArtifactProvider} provider
 * @property {Partial<ArtifactLimits>} [limits]
 * @property {readonly string[]} [protectedRoots]
 * @property {() => number} [now]
 */

/**
 * @typedef ArtifactWriter
 * @property {(chunk: Uint8Array) => Promise<void>} write
 * @property {() => Promise<ArtifactProjection>} commit
 * @property {() => Promise<void>} abort
 */

/**
 * Filesystem and provider errors may carry store paths, so only an errno code
 * is retained in the message and no raw cause is attached.
 * @param {string} message @param {import('./errors.js').ArtifactCode} code @param {unknown} [cause]
 */
function failure(message, code, cause) {
  return new ArtifactError(isErrno(cause) ? `${message} (${cause.code})` : message, code)
}

/** @param {Partial<ArtifactLimits> | undefined} configured */
function resolveLimits(configured) {
  /** @type {Record<string, number>} */
  const limits = {}
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const field = /** @type {keyof ArtifactLimits} */ (key)
    const value = configured?.[field]
    if (value === undefined) {
      limits[field] = DEFAULT_LIMITS[field]
      continue
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`dsh-runtime-kit: artifact limit ${field} must be a positive integer`)
    }
    limits[field] = Math.min(value, HARD_LIMITS[field])
  }
  return Object.freeze(/** @type {ArtifactLimits} */ (limits))
}

/** @param {unknown} value @returns {value is ArtifactProvider} */
function isProvider(value) {
  if (value === null || typeof value !== 'object') return false
  const candidate = /** @type {Record<string, unknown>} */ (value)
  return Array.isArray(candidate.capabilities)
    && ['init', 'list', 'load', 'begin', 'publish', 'read', 'remove', 'removeMany', 'claimGeneration', 'releaseGeneration', 'generationAlive', 'listGenerations']
      .every(name => typeof candidate[name] === 'function')
}

/** @param {number} epochMs */
function isoTime(epochMs) {
  return new Date(epochMs).toISOString()
}

/** @param {string} value */
function digestText(value) {
  return digestBytes(new TextEncoder().encode(value))
}

/** @param {string | undefined} value */
function displayName(value) {
  if (value === undefined) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(STRIP_CONTROL, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

/**
 * Runtime-kit-owned artifact service (`ctx.dshRuntimeArtifacts`). It binds
 * every capability to the exact live executing agent, owns quotas, retention,
 * and typed outcomes, and delegates bytes and durable records to one provider.
 */
export class ArtifactService extends Service {
  static inject = ['agents']

  /** @type {ArtifactProvider} */
  #provider
  /** @type {ArtifactLimits} */
  #limits
  /** @type {readonly string[]} */
  #protectedRoots
  /** @type {() => number} */
  #now
  /** @type {Promise<void>} */
  #tail = Promise.resolve()
  /**
   * Process-generation identity stamped on every record this instance publishes.
   * @type {string}
   */
  generation
  /**
   * Capabilities the configured provider supports.
   * @type {readonly ArtifactCapability[]}
   */
  capabilities
  /**
   * Effective limits.
   * @type {ArtifactLimits}
   */
  limits

  /**
   * @param {Context} ctx
   * @param {ArtifactServiceConfig} config
   */
  constructor(ctx, config) {
    super(ctx, ARTIFACT_SERVICE_NAME)
    if (config === null || typeof config !== 'object' || !isProvider(config.provider)) {
      throw new TypeError('dsh-runtime-kit: artifact service requires a provider')
    }
    this.#provider = config.provider
    this.#limits = resolveLimits(config.limits)
    const roots = config.protectedRoots ?? []
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || root.length === 0 || root.includes('\0'))) {
      throw new TypeError('dsh-runtime-kit: artifact protectedRoots must be non-empty path strings')
    }
    // Relative roots are resolved against the exporting session's workspace at
    // export time; the store root itself is always protected.
    this.#protectedRoots = Object.freeze([
      ...roots,
      ...(typeof config.provider.root === 'string' ? [config.provider.root] : []),
    ])
    if (config.now !== undefined && typeof config.now !== 'function') {
      throw new TypeError('dsh-runtime-kit: artifact clock must be a function')
    }
    this.#now = config.now ?? Date.now
    this.generation = `generation:${randomUUID()}`
    this.capabilities = Object.freeze([...config.provider.capabilities])
    this.limits = this.#limits

    // Cordis presents services through a scoped proxy; bind the public API to
    // the concrete instance so private state stays reachable.
    this.write = this.write.bind(this)
    this.openWriter = this.openWriter.bind(this)
    this.present = this.present.bind(this)
    this.read = this.read.bind(this)
    this.exportArtifact = this.exportArtifact.bind(this)
    this.dispose = this.dispose.bind(this)
    this.list = this.list.bind(this)
    this.records = this.records.bind(this)
    this.sweep = this.sweep.bind(this)
    this.settled = this.settled.bind(this)

    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent.session?.header?.id
      if (sessionId === undefined) return
      void this.#enqueue(() => this.#reclaimOwner(String(sessionId))).catch(() => {})
    })
  }

  /** Resolve once every queued lifecycle mutation has settled. */
  async settled() {
    await this.#tail
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #enqueue(task) {
    const run = this.#tail.then(task, task)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** @param {Agent | undefined} agent */
  #liveSession(agent) {
    if (agent === undefined || agent === null || typeof agent !== 'object') {
      throw failure('artifact capabilities require the executing agent', ARTIFACT_CODES.ACCESS_DENIED)
    }
    if (this.ctx.agents.get(agent.id) !== agent || agent.session === undefined) {
      throw failure('artifact capabilities require a live registered agent', ARTIFACT_CODES.ACCESS_DENIED)
    }
    return agent.session
  }

  /** @param {Agent['session']} session */
  async #workspaceDigest(session) {
    const cwd = session.header.cwd
    if (cwd === undefined) return 'unmanaged'
    let canonical
    try {
      canonical = await realpath(cwd)
    } catch {
      canonical = resolve(cwd)
    }
    return digestText(canonical)
  }

  /** @param {unknown} ref */
  #parseRef(ref) {
    if (typeof ref !== 'string') throw failure('artifact reference must be a string', ARTIFACT_CODES.REF_INVALID)
    const match = REF_PATTERN.exec(ref)
    if (match?.[1] === undefined) throw failure('artifact reference is invalid', ARTIFACT_CODES.REF_INVALID)
    return match[1]
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @param {import('./errors.js').ArtifactCode} fallback
   */
  async #provided(operation, fallback) {
    try {
      return await operation()
    } catch (error) {
      if (isArtifactError(error)) throw error
      throw failure('artifact provider operation failed', fallback, error)
    }
  }

  /** @param {ArtifactRecord} record */
  #expired(record) {
    return Date.parse(record.expires_at) <= this.#now()
  }

  /** @param {ArtifactRecord} record */
  async #reclaim(record) {
    await this.#enqueue(() => this.#provided(() => this.#provider.remove(record), ARTIFACT_CODES.PROVIDER_UNAVAILABLE))
  }

  /**
   * Remove a batch of records in one provider pass. Must run inside the tail.
   * @param {readonly ArtifactRecord[]} targets
   */
  async #removeBatch(targets) {
    if (targets.length === 0) return
    await this.#provided(() => this.#provider.removeMany(targets), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
  }

  /** @param {string} sessionId */
  async #reclaimOwner(sessionId) {
    const records = await this.#provided(() => this.#provider.list(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    await this.#removeBatch(records.filter(record => record.owner_session_id === sessionId
      && record.retention_class === 'session'))
  }

  /**
   * Authorize one capability for the exact live agent and return the
   * revalidated record.
   * @param {Agent | undefined} agent
   * @param {unknown} ref
   * @param {ArtifactCapability} capability
   */
  async #authorize(agent, ref, capability) {
    const session = this.#liveSession(agent)
    const id = this.#parseRef(ref)
    if (!this.#provider.capabilities.includes(capability)) {
      throw failure(`artifact capability ${capability} is unsupported by this provider`, ARTIFACT_CODES.CAPABILITY_UNSUPPORTED)
    }
    const record = await this.#provided(() => this.#provider.load(id), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    if (record === undefined) throw failure('artifact reference is unknown', ARTIFACT_CODES.NOT_FOUND)
    const workspace = await this.#workspaceDigest(session)
    if (record.owner_session_id !== String(session.header.id) || record.workspace_digest !== workspace) {
      throw failure('artifact reference is not owned by this session', ARTIFACT_CODES.ACCESS_DENIED)
    }
    if (this.#expired(record)) {
      await this.#reclaim(record)
      throw failure('artifact reference has expired', ARTIFACT_CODES.EXPIRED)
    }
    return record
  }

  /**
   * @param {string} sessionId
   * @param {string} workspace
   */
  async #owned(sessionId, workspace) {
    const records = await this.#provided(() => this.#provider.list(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    return records.filter(record => record.owner_session_id === sessionId
      && record.workspace_digest === workspace
      && !this.#expired(record))
  }

  /**
   * @param {string} sessionId
   * @param {string} workspace
   * @param {number} additionalBytes
   */
  async #checkQuota(sessionId, workspace, additionalBytes) {
    const owned = await this.#owned(sessionId, workspace)
    const bytes = owned.reduce((sum, record) => sum + record.bytes, 0)
    if (owned.length + 1 > this.#limits.sessionMaxCount || bytes + additionalBytes > this.#limits.sessionQuotaBytes) {
      throw failure('artifact quota for this session is exhausted', ARTIFACT_CODES.QUOTA_EXCEEDED)
    }
  }

  /** @param {unknown} request @returns {{name: string | undefined, mediaType: string, retention: RetentionClass, producerTool: string}} */
  #validateWriteRequest(request) {
    if (request === null || typeof request !== 'object') throw failure('artifact write request must be an object', ARTIFACT_CODES.ARGUMENT_INVALID)
    const value = /** @type {Record<string, unknown>} */ (request)
    if (typeof value.mediaType !== 'string' || !MEDIA_TYPE_PATTERN.test(value.mediaType)) {
      throw failure('artifact media type is invalid', ARTIFACT_CODES.ARGUMENT_INVALID)
    }
    if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 1024)) {
      throw failure('artifact name is invalid', ARTIFACT_CODES.ARGUMENT_INVALID)
    }
    const retention = value.retention ?? 'session'
    if (typeof retention !== 'string' || !RETENTION_CLASSES.includes(/** @type {RetentionClass} */ (retention))) {
      throw failure('artifact retention class is invalid', ARTIFACT_CODES.ARGUMENT_INVALID)
    }
    if (typeof value.producerTool !== 'string' || value.producerTool.length === 0 || value.producerTool.length > 128
      || CONTAINS_CONTROL.test(value.producerTool)) {
      throw failure('artifact producer tool is invalid', ARTIFACT_CODES.ARGUMENT_INVALID)
    }
    return {
      name: displayName(/** @type {string | undefined} */ (value.name)),
      mediaType: value.mediaType,
      retention: /** @type {RetentionClass} */ (retention),
      producerTool: value.producerTool,
    }
  }

  /**
   * Open one streaming writer. Nothing is readable until `commit` resolves.
   * @param {Agent} agent
   * @param {ArtifactWriteRequest} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<ArtifactWriter>}
   */
  async openWriter(agent, request, signal) {
    const session = this.#liveSession(agent)
    const validated = this.#validateWriteRequest(request)
    signal?.throwIfAborted()
    const sessionId = String(session.header.id)
    const workspace = await this.#workspaceDigest(session)
    await this.#enqueue(() => this.#checkQuota(sessionId, workspace, 0))
    const id = randomBytes(16).toString('hex')
    const staging = await this.#provided(
      () => this.#provider.begin({ id, maxBytes: this.#limits.maxArtifactBytes }),
      ARTIFACT_CODES.WRITE_FAILED,
    )
    let bytes = 0
    /** @type {'open' | 'committed' | 'aborted'} */
    let state = 'open'
    const abortStaging = async () => {
      if (state !== 'open') return
      state = 'aborted'
      await staging.abort().catch(() => {})
    }
    const onAbort = () => { void abortStaging() }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = () => { signal?.removeEventListener('abort', onAbort) }
    const aborted = () => failure('artifact write was aborted', ARTIFACT_CODES.ABORTED, signal?.reason)
    return {
      write: async chunk => {
        if (signal?.aborted) {
          await abortStaging()
          finish()
          throw aborted()
        }
        if (state !== 'open') throw failure('artifact writer is not open', ARTIFACT_CODES.WRITE_FAILED)
        if (!(chunk instanceof Uint8Array)) {
          await abortStaging()
          finish()
          throw failure('artifact chunks must be bytes', ARTIFACT_CODES.ARGUMENT_INVALID)
        }
        if (bytes + chunk.byteLength > this.#limits.maxArtifactBytes) {
          await abortStaging()
          finish()
          throw failure('artifact exceeds the configured byte limit', ARTIFACT_CODES.TOO_LARGE)
        }
        try {
          await staging.write(chunk)
        } catch (error) {
          state = 'aborted'
          finish()
          if (isArtifactError(error)) throw error
          throw failure('artifact staging write failed', ARTIFACT_CODES.WRITE_FAILED, error)
        }
        bytes += chunk.byteLength
      },
      commit: async () => {
        if (signal?.aborted) {
          await abortStaging()
          finish()
          throw aborted()
        }
        if (state !== 'open') throw failure('artifact writer is not open', ARTIFACT_CODES.WRITE_FAILED)
        try {
          return await this.#enqueue(async () => {
            try {
              await this.#checkQuota(sessionId, workspace, bytes)
            } catch (error) {
              await abortStaging()
              throw error
            }
            if (state !== 'open') throw failure('artifact writer is not open', ARTIFACT_CODES.WRITE_FAILED)
            state = 'committed'
            let committed
            try {
              committed = await this.#provided(() => staging.commit(), ARTIFACT_CODES.WRITE_FAILED)
            } catch (error) {
              // Providers are expected to discard their own staging on a failed
              // commit; the service still asks so cleanup never depends on it.
              await staging.abort().catch(() => {})
              throw error
            }
            const now = this.#now()
            const ttl = validated.retention === 'session' ? this.#limits.sessionTtlMs : this.#limits.retainedTtlMs
            /** @type {ArtifactRecord} */
            const record = Object.freeze({
              schema_version: ARTIFACT_RECORD_SCHEMA,
              id,
              sha256: committed.sha256,
              bytes: committed.bytes,
              media_type: validated.mediaType,
              ...(validated.name === undefined ? {} : { name: validated.name }),
              owner_session_id: sessionId,
              workspace_digest: workspace,
              producer_tool: validated.producerTool,
              generation: this.generation,
              created_at: isoTime(now),
              retention_class: validated.retention,
              expires_at: isoTime(now + ttl),
            })
            try {
              await this.#provided(() => this.#provider.publish(record), ARTIFACT_CODES.WRITE_FAILED)
            } catch (error) {
              await this.#provider.remove(record).catch(() => {})
              throw error
            }
            return projectRecord(record)
          })
        } finally {
          finish()
        }
      },
      abort: async () => {
        await abortStaging()
        finish()
      },
    }
  }

  /**
   * Write one artifact from bytes, text, or an async byte stream.
   * @param {Agent} agent
   * @param {ArtifactWriteRequest} request
   * @param {Uint8Array | string | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source
   * @param {AbortSignal} [signal]
   */
  async write(agent, request, source, signal) {
    const writer = await this.openWriter(agent, request, signal)
    try {
      if (typeof source === 'string') {
        await writer.write(new TextEncoder().encode(source))
      } else if (source instanceof Uint8Array) {
        await writer.write(source)
      } else {
        for await (const chunk of source) await writer.write(chunk)
      }
    } catch (error) {
      await writer.abort()
      if (isArtifactError(error)) throw error
      if (signal?.aborted) throw failure('artifact write was aborted', ARTIFACT_CODES.ABORTED, signal.reason)
      throw failure('artifact source failed while streaming', ARTIFACT_CODES.WRITE_FAILED, error)
    }
    return writer.commit()
  }

  /**
   * Bounded metadata plus an optional bounded text preview.
   * @param {Agent} agent
   * @param {unknown} ref
   */
  async present(agent, ref) {
    const record = await this.#authorize(agent, ref, 'present')
    const projection = projectRecord(record)
    /** @type {string | undefined} */
    let preview
    if (TEXT_MEDIA_PATTERN.test(record.media_type) && record.bytes <= this.#limits.readMaxBytes) {
      const data = await this.#provided(() => this.#provider.read(record), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
      preview = boundedPreview(data, this.#limits.previewMaxBytes)
    }
    return Object.freeze({
      ...projection,
      capabilities: this.capabilities,
      ...(preview === undefined ? {} : { preview }),
    })
  }

  /**
   * Read verified bytes within the bounded read limit.
   * @param {Agent} agent
   * @param {unknown} ref
   * @param {{signal?: AbortSignal, maxBytes?: number}} [options]
   */
  async read(agent, ref, options = {}) {
    const record = await this.#authorize(agent, ref, 'read')
    const limit = options.maxBytes ?? this.#limits.readMaxBytes
    if (!Number.isSafeInteger(limit) || limit < 1) throw failure('artifact read limit is invalid', ARTIFACT_CODES.ARGUMENT_INVALID)
    if (record.bytes > Math.min(limit, HARD_LIMITS.readMaxBytes)) {
      throw failure('artifact exceeds the bounded read limit; export it instead', ARTIFACT_CODES.READ_TOO_LARGE)
    }
    let data
    try {
      data = await this.#provided(() => this.#provider.read(record, options.signal), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    } catch (error) {
      if (isArtifactError(error) && error.code === ARTIFACT_CODES.CORRUPT) {
        const current = await this.#provided(() => this.#provider.load(record.id), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
        if (current === undefined) throw failure('artifact reference is unknown', ARTIFACT_CODES.NOT_FOUND)
      }
      throw error
    }
    return Object.freeze({ record: projectRecord(record), data })
  }

  /**
   * Export verified bytes to one destination class and return a bounded receipt.
   * @param {Agent} agent
   * @param {unknown} ref
   * @param {unknown} destination
   * @param {AbortSignal} [signal]
   */
  async exportArtifact(agent, ref, destination, signal) {
    const target = validateDestination(destination)
    if (target.class === 'download') {
      // One authorization path: a provider without the capability fails here
      // with the typed outcome; no download sink exists in v1 even when a
      // provider were to declare it.
      await this.#authorize(agent, ref, 'download')
      throw failure('artifact download has no destination sink in this runtime', ARTIFACT_CODES.CAPABILITY_UNSUPPORTED)
    }
    const record = await this.#authorize(agent, ref, 'export')
    const session = /** @type {Agent} */ (agent).session
    const cwd = session.header.cwd
    if (cwd === undefined) throw failure('artifact export requires a session workspace', ARTIFACT_CODES.EXPORT_DENIED)
    const sandboxPolicy = /** @type {{resolve?: (request: {session: unknown}) => {mode?: string, workspaceRoot?: string, protectedRoots?: readonly string[]}} | undefined} */ (this.ctx.get('sandboxPolicy'))
    if (typeof sandboxPolicy?.resolve !== 'function') throw failure('artifact export requires the sandbox policy service', ARTIFACT_CODES.EXPORT_DENIED)
    const policy = sandboxPolicy.resolve({ session })
    if (policy.mode !== 'workspace-write' && policy.mode !== 'danger-full-access') {
      throw failure('artifact export is denied under the current sandbox mode', ARTIFACT_CODES.EXPORT_DENIED)
    }
    let workspaceRoot
    try {
      workspaceRoot = await realpath(cwd)
    } catch (error) {
      throw failure('artifact export workspace is unavailable', ARTIFACT_CODES.EXPORT_DENIED, error)
    }
    // The deny set is the union of the runtime-kit configuration, the store
    // root, and every protected root the host sandbox policy resolves for this
    // session, so export can never write where the DSH file sandbox denies.
    const policyRoots = Array.isArray(policy.protectedRoots)
      ? policy.protectedRoots.filter(root => typeof root === 'string' && root.length > 0)
      : []
    const protectedRoots = [...this.#protectedRoots, ...policyRoots]
      .map(root => (isAbsolute(root) ? resolve(root) : resolve(workspaceRoot, root)))
    const destinationPath = await resolveDestination(workspaceRoot, target.path, protectedRoots)
    signal?.throwIfAborted()
    const data = await this.#provided(() => this.#provider.read(record, signal), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    await writeExport(destinationPath, data, record)
    return Object.freeze({
      schema_version: ARTIFACT_EXPORT_RECEIPT_SCHEMA,
      ref: `artifact:${record.id}`,
      sha256: record.sha256,
      bytes: record.bytes,
      media_type: record.media_type,
      destination_class: /** @type {const} */ ('workspace'),
      destination_path: target.path,
      owner_session_id: record.owner_session_id,
      generation: record.generation,
      exported_at: isoTime(this.#now()),
    })
  }

  /**
   * Explicitly dispose one owned artifact.
   * @param {Agent} agent
   * @param {unknown} ref
   */
  async dispose(agent, ref) {
    const record = await this.#authorize(agent, ref, 'delete')
    await this.#enqueue(async () => {
      const current = await this.#provided(() => this.#provider.load(record.id), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
      if (current === undefined) throw failure('artifact reference is unknown', ARTIFACT_CODES.NOT_FOUND)
      await this.#provided(() => this.#provider.remove(current), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    })
    return Object.freeze({ ref: `artifact:${record.id}`, outcome: /** @type {const} */ ('disposed') })
  }

  /**
   * List live artifacts owned by the exact agent's session and workspace.
   * @param {Agent} agent
   */
  async list(agent) {
    const session = this.#liveSession(agent)
    const workspace = await this.#workspaceDigest(session)
    const owned = await this.#owned(String(session.header.id), workspace)
    return Object.freeze(owned.map(projectRecord))
  }

  /** Every live record across owners (diagnostics and tests only). */
  async records() {
    const records = await this.#provided(() => this.#provider.list(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    return Object.freeze(records.filter(record => !this.#expired(record)).map(projectRecord))
  }

  /**
   * Reclaim every expired record. With `reclaimDeadSessions`, `session`-class
   * records whose owning service generation is provably dead are reclaimed as
   * well: their agent lifecycles ended with that host process, whether or not
   * it disposed its agents cleanly. Records of another live host sharing the
   * store, and this service's own records, are never touched by the sweep.
   * @param {{reclaimDeadSessions?: boolean}} [options]
   */
  async sweep(options = {}) {
    const reclaimDeadSessions = options.reclaimDeadSessions === true
    return this.#enqueue(async () => {
      const records = await this.#provided(() => this.#provider.list(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
      /** @type {Map<string, boolean>} */
      const liveness = new Map()
      const alive = async (/** @type {string} */ generation) => {
        let known = liveness.get(generation)
        if (known === undefined) {
          known = generation === this.generation
            || await this.#provided(() => this.#provider.generationAlive(generation), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
          liveness.set(generation, known)
        }
        return known
      }
      const targets = []
      for (const record of records) {
        if (this.#expired(record)) {
          targets.push(record)
          continue
        }
        if (!reclaimDeadSessions || record.retention_class !== 'session') continue
        if (!await alive(record.generation)) targets.push(record)
      }
      await this.#removeBatch(targets)
      if (reclaimDeadSessions) {
        // Release the claims of dead generations that no surviving record
        // references, so abnormal exits do not accumulate claim files.
        const removed = new Set(targets.map(record => record.id))
        const referenced = new Set(records.filter(record => !removed.has(record.id)).map(record => record.generation))
        const claimed = await this.#provided(() => this.#provider.listGenerations(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
        for (const generation of claimed) {
          if (referenced.has(generation) || await alive(generation)) continue
          await this.#provided(() => this.#provider.releaseGeneration(generation), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
        }
      }
      return Object.freeze({ reclaimed: targets.length })
    })
  }
}

/**
 * @param {Uint8Array} data
 * @param {number} maxBytes
 */
function boundedPreview(data, maxBytes) {
  const slice = data.subarray(0, Math.min(data.byteLength, maxBytes))
  let text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  if (slice.byteLength < data.byteLength && text.endsWith('�')) text = text.slice(0, -1)
  return text
}

/** @param {unknown} destination @returns {{class: 'workspace', path: string} | {class: 'download'}} */
function validateDestination(destination) {
  if (destination === null || typeof destination !== 'object' || Array.isArray(destination)) {
    throw failure('artifact export destination must be an object', ARTIFACT_CODES.ARGUMENT_INVALID)
  }
  const value = /** @type {Record<string, unknown>} */ (destination)
  const keys = Object.keys(value).sort()
  if (value.class === 'download') {
    if (keys.join(',') !== 'class') throw failure('artifact download destination accepts only a class', ARTIFACT_CODES.ARGUMENT_INVALID)
    return { class: 'download' }
  }
  if (value.class !== 'workspace') throw failure('artifact export destination class is unsupported', ARTIFACT_CODES.ARGUMENT_INVALID)
  if (keys.join(',') !== 'class,path' || typeof value.path !== 'string') {
    throw failure('artifact workspace destination requires exactly class and path', ARTIFACT_CODES.ARGUMENT_INVALID)
  }
  return { class: 'workspace', path: value.path }
}

/**
 * @param {string} workspaceRoot
 * @param {string} relativePath
 * @param {readonly string[]} protectedRoots
 */
async function resolveDestination(workspaceRoot, relativePath, protectedRoots) {
  const invalid = (/** @type {string} */ message) => failure(message, ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  if (relativePath.length === 0 || relativePath.length > 4096 || CONTAINS_CONTROL.test(relativePath) || relativePath.includes('\\')) {
    throw invalid('artifact export path is invalid')
  }
  if (isAbsolute(relativePath)) throw invalid('artifact export path must be workspace-relative')
  const segments = relativePath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || Buffer.byteLength(segment, 'utf8') > 255)) {
    throw invalid('artifact export path contains an invalid segment')
  }
  const destination = join(workspaceRoot, ...segments)
  if (destination !== workspaceRoot && !destination.startsWith(`${workspaceRoot}${sep}`)) {
    throw invalid('artifact export path escapes the workspace')
  }
  for (const root of protectedRoots) {
    let canonicalRoot = root
    try {
      canonicalRoot = await realpath(root)
    } catch {
      // A missing protected root protects nothing yet; the lexical form still applies.
    }
    for (const candidate of new Set([root, canonicalRoot])) {
      if (destination === candidate || destination.startsWith(`${candidate}${sep}`)) {
        throw failure('artifact export destination is inside a protected root', ARTIFACT_CODES.EXPORT_DENIED)
      }
    }
  }
  // Walk each ancestor without following symlinks; create missing directories.
  let cursor = workspaceRoot
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if (!(isErrno(error) && error.code === 'ENOENT')) {
        throw failure('artifact export path is unreadable', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
      }
      try {
        await mkdir(cursor, { mode: 0o755 })
      } catch (createError) {
        // A racing creation of the same directory is fine; anything else is a typed, path-free failure.
        if (!(isErrno(createError) && createError.code === 'EEXIST')) {
          throw failure('artifact export directory could not be created', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, createError)
        }
      }
      continue
    }
    if (metadata.isSymbolicLink()) throw invalid('artifact export path crosses a symbolic link')
    if (!metadata.isDirectory()) throw invalid('artifact export path crosses a non-directory')
  }
  let existing
  try {
    existing = await lstat(destination)
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') return destination
    throw failure('artifact export destination is unreadable', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
  }
  if (existing.isSymbolicLink()) throw invalid('artifact export destination is a symbolic link')
  throw failure('artifact export destination already exists', ARTIFACT_CODES.EXPORT_EXISTS)
}

/**
 * @param {string} destination
 * @param {Uint8Array} data
 * @param {ArtifactRecord} record
 */
async function writeExport(destination, data, record) {
  const digest = digestBytes(data)
  if (digest !== record.sha256 || data.byteLength !== record.bytes) {
    throw failure('artifact bytes failed digest verification before export', ARTIFACT_CODES.CORRUPT)
  }
  let handle
  try {
    handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644)
  } catch (error) {
    if (isErrno(error) && error.code === 'EEXIST') throw failure('artifact export destination already exists', ARTIFACT_CODES.EXPORT_EXISTS)
    throw failure('artifact export destination could not be created', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
  }
  try {
    // The ancestor walk was a check; the open was the use. Prove the created
    // entry is the exact lexical destination (no ancestor was swapped for a
    // symbolic link in between) before a single byte is written. The file is
    // still empty here, so every failure below unlinks the exact inode we
    // created, located through the open descriptor rather than the lexical
    // path, which a racing swap may no longer resolve.
    const created = await handle.stat()
    const actualPath = await descriptorPath(handle.fd)
    const discardCreated = async () => {
      await unlinkCreated(actualPath ?? destination, created)
    }
    let canonical
    try {
      canonical = await realpath(destination)
    } catch (error) {
      await discardCreated()
      throw failure('artifact export destination disappeared', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
    }
    let entry
    try {
      entry = await lstat(destination)
    } catch (error) {
      await discardCreated()
      throw failure('artifact export destination disappeared', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
    }
    if (canonical !== destination || entry.isSymbolicLink() || entry.ino !== created.ino || entry.dev !== created.dev || created.size !== 0
      || (actualPath !== undefined && actualPath !== destination)) {
      await discardCreated()
      throw failure('artifact export destination changed before write', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
    }
    await handle.writeFile(data)
    await handle.sync()
    const written = await handle.stat()
    if (!written.isFile() || written.size !== record.bytes) throw failure('artifact export changed during write', ARTIFACT_CODES.CORRUPT)
    // The descriptor may now live somewhere else if an ancestor directory was
    // renamed while the bytes were being written. Re-read where the kernel
    // places the written inode and refuse to leave bytes anywhere but the
    // exact destination.
    const settledPath = await descriptorPath(handle.fd)
    if (settledPath !== undefined && settledPath !== destination) {
      await unlinkWritten(settledPath, written)
      throw failure('artifact export destination moved during write', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
    }
    let verify
    try {
      verify = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      await unlinkWritten(settledPath ?? destination, written)
      throw failure('artifact export destination disappeared after write', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID, error)
    }
    try {
      const verified = await verify.stat()
      if (verified.ino !== written.ino || verified.dev !== written.dev) {
        await unlinkWritten(settledPath ?? destination, written)
        throw failure('artifact export destination was replaced after write', ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
      }
      const readBack = new Uint8Array(await verify.readFile())
      if (digestBytes(readBack) !== record.sha256) throw failure('artifact export failed digest verification after write', ARTIFACT_CODES.CORRUPT)
    } finally {
      await verify.close()
    }
  } catch (error) {
    if (isArtifactError(error)) throw error
    throw failure('artifact export write failed', ARTIFACT_CODES.WRITE_FAILED, error)
  } finally {
    await handle.close()
  }
}

/**
 * Remove a fully written export that ended up somewhere other than its exact
 * destination, only while it is still the inode we wrote.
 * @param {string} path
 * @param {import('node:fs').Stats} written
 */
async function unlinkWritten(path, written) {
  try {
    const current = await lstat(path)
    if (current.isFile() && current.ino === written.ino && current.dev === written.dev) await unlink(path)
  } catch {
    // Best effort: the entry is already gone or no longer ours.
  }
}

/**
 * Resolve the path the kernel currently associates with an open descriptor.
 * Linux exposes it through procfs; elsewhere the caller falls back to the
 * lexical destination.
 * @param {number} fd
 * @returns {Promise<string | undefined>}
 */
async function descriptorPath(fd) {
  if (process.platform !== 'linux') return undefined
  try {
    const target = await readlink(`/proc/self/fd/${fd}`)
    return isAbsolute(target) ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * Remove the empty file an export race created, only if it is still the exact
 * inode we created.
 * @param {string} path
 * @param {import('node:fs').Stats} created
 */
async function unlinkCreated(path, created) {
  try {
    const current = await lstat(path)
    if (current.isFile() && current.ino === created.ino && current.dev === created.dev && current.size === 0) {
      await unlink(path)
    }
  } catch {
    // Best effort: the entry is already gone or no longer ours.
  }
}

/**
 * Compose the artifact service, protect its store root, and register the five
 * artifact tools.
 * @param {Context} ctx
 * @param {ArtifactServiceConfig} config
 */
export async function applyArtifacts(ctx, config) {
  if (config === null || typeof config !== 'object' || !isProvider(config.provider)) {
    throw new TypeError('dsh-runtime-kit: artifact composition requires a provider')
  }
  await config.provider.init()
  await ctx.plugin(ArtifactService, config)
  const service = /** @type {ArtifactService | undefined} */ (ctx.get(ARTIFACT_SERVICE_NAME))
  if (!(service instanceof ArtifactService)) throw new Error('dsh-runtime-kit: artifact service failed to activate')
  if (typeof config.provider.root === 'string') {
    const root = config.provider.root
    const sandboxPolicy = /** @type {{protect?: (roots: readonly string[]) => () => void} | undefined} */ (ctx.get('sandboxPolicy'))
    if (typeof sandboxPolicy?.protect !== 'function') {
      throw new Error('dsh-runtime-kit: authenticated protected-root registration is unavailable for the artifact store')
    }
    const protect = sandboxPolicy.protect.bind(sandboxPolicy)
    ctx.effect(() => protect([root]), 'dsh-runtime-kit artifact store protected root')
  }
  for (const definition of createArtifactTools(service)) ctx.tools.register(definition)
  // Claim this generation for the service lifetime so a sibling host sharing
  // the store can tell our live session-class records from a dead host's.
  await config.provider.claimGeneration(service.generation)
  ctx.effect(() => () => config.provider.releaseGeneration(service.generation).catch(() => {}), 'dsh-runtime-kit artifact generation claim')
  await service.sweep({ reclaimDeadSessions: true })
  return service
}

export default ArtifactService
