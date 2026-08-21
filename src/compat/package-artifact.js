// @ts-check

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { DSH_RC7_ARTIFACT_LIMITS, DshCompatibilityError } from './contract.js'

function artifactLimitError() {
  return new DshCompatibilityError(
    'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
    'Selected DSH artifact exceeds the bounded artifact limits',
  )
}

function unsafeInstallScope() {
  return new DshCompatibilityError(
    'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
    'DSH peer install scope is not a stable, real directory tree',
  )
}

/** @param {string} path */
async function ensureRealDirectory(path) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw unsafeInstallScope()
    try {
      await mkdir(path, { recursive: false, mode: 0o700 })
    } catch (mkdirError) {
      if (/** @type {NodeJS.ErrnoException} */ (mkdirError).code !== 'EEXIST') {
        throw unsafeInstallScope()
      }
    }
    try {
      info = await lstat(path)
    } catch {
      throw unsafeInstallScope()
    }
  }
  let canonical
  try {
    canonical = await realpath(path)
  } catch {
    throw unsafeInstallScope()
  }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path) {
    throw unsafeInstallScope()
  }
  return Object.freeze({ path, dev: info.dev, ino: info.ino })
}

/** @param {{path: string, dev: number, ino: number}} identity */
async function assertDirectoryIdentity(identity) {
  let info
  let canonical
  try {
    [info, canonical] = await Promise.all([lstat(identity.path), realpath(identity.path)])
  } catch {
    throw unsafeInstallScope()
  }
  if (!info.isDirectory()
    || info.isSymbolicLink()
    || canonical !== identity.path
    || info.dev !== identity.dev
    || info.ino !== identity.ino) {
    throw unsafeInstallScope()
  }
}

/**
 * Resolve and pin the two install ancestors that the compatibility stager may
 * mutate. Existing symlinks are never followed, and callers can revalidate
 * both directory identities immediately before each replacement.
 * @param {string} consumerRoot
 * @param {string} scopeName
 */
export async function prepareAuthenticatedPackageScope(consumerRoot, scopeName) {
  if (!isAbsolute(consumerRoot)
    || !/^@[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(scopeName)) {
    throw unsafeInstallScope()
  }
  let canonicalConsumer
  try {
    canonicalConsumer = await realpath(consumerRoot)
  } catch {
    throw unsafeInstallScope()
  }
  if (canonicalConsumer !== consumerRoot) throw unsafeInstallScope()

  const nodeModulesIdentity = await ensureRealDirectory(resolve(consumerRoot, 'node_modules'))
  await assertDirectoryIdentity(nodeModulesIdentity)
  const scopeIdentity = await ensureRealDirectory(resolve(nodeModulesIdentity.path, scopeName))

  let scopeHandle
  try {
    if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
      throw unsafeInstallScope()
    }
    scopeHandle = await open(
      scopeIdentity.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const opened = await scopeHandle.stat()
    const descriptorRoot = `/proc/self/fd/${scopeHandle.fd}`
    if (!opened.isDirectory()
      || opened.dev !== scopeIdentity.dev
      || opened.ino !== scopeIdentity.ino
      || await realpath(descriptorRoot) !== scopeIdentity.path) {
      throw unsafeInstallScope()
    }
  } catch (error) {
    await scopeHandle?.close().catch(() => {})
    if (error instanceof DshCompatibilityError) throw error
    throw unsafeInstallScope()
  }

  const descriptorRoot = `/proc/self/fd/${scopeHandle.fd}`
  let closed = false

  const assertStable = async () => {
    if (closed) throw unsafeInstallScope()
    const opened = await scopeHandle.stat().catch(() => undefined)
    if (opened === undefined
      || !opened.isDirectory()
      || opened.dev !== scopeIdentity.dev
      || opened.ino !== scopeIdentity.ino) {
      throw unsafeInstallScope()
    }
    await assertDirectoryIdentity(nodeModulesIdentity)
    await assertDirectoryIdentity(scopeIdentity)
  }
  /** @param {string} base */
  const resolveTarget = base => {
    if (closed || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(base)) throw unsafeInstallScope()
    return resolve(descriptorRoot, base)
  }
  const close = async () => {
    if (closed) return
    closed = true
    await scopeHandle.close()
  }
  await assertStable()
  return Object.freeze({
    nodeModules: nodeModulesIdentity.path,
    scopeRoot: scopeIdentity.path,
    assertStable,
    resolveTarget,
    close,
  })
}

/** @param {unknown} value @returns {unknown} */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]))
  }
  return value
}

/** @param {Buffer} header @param {number} offset @param {number} length */
function textField(header, offset, length) {
  const zero = header.indexOf(0, offset)
  const end = zero >= offset && zero < offset + length ? zero : offset + length
  return header.subarray(offset, end).toString('utf8')
}

/** @param {Buffer} header @param {number} offset @param {number} length */
function octalField(header, offset, length) {
  const value = textField(header, offset, length).trim().replace(/^0+/u, '')
  if (value === '') return 0
  if (!/^[0-7]+$/u.test(value)) throw new Error('invalid tar octal field')
  return Number.parseInt(value, 8)
}

/** @param {Buffer} tarball */
function parsePackageArtifact(tarball) {
  if (!Buffer.isBuffer(tarball)
    || tarball.byteLength > DSH_RC7_ARTIFACT_LIMITS.compressed_bytes) {
    throw artifactLimitError()
  }
  let archive
  try {
    archive = gunzipSync(tarball, {
      maxOutputLength: DSH_RC7_ARTIFACT_LIMITS.expanded_bytes,
    })
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ERR_BUFFER_TOO_LARGE') {
      throw artifactLimitError()
    }
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'Selected DSH artifact is not a valid gzip-compressed tar archive',
    )
  }
  /** @type {Array<{path: string, mode: number, bytes: Buffer}>} */
  const entries = []
  const paths = new Set()
  let contentBytes = 0
  try {
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512)
      if (header.every(byte => byte === 0)) break
      const name = textField(header, 0, 100)
      const prefix = textField(header, 345, 155)
      const path = prefix.length > 0 ? `${prefix}/${name}` : name
      const mode = octalField(header, 100, 8)
      const size = octalField(header, 124, 12)
      const type = String.fromCharCode(header[156] || 48)
      const contentOffset = offset + 512
      const nextOffset = contentOffset + Math.ceil(size / 512) * 512
      if (entries.length >= DSH_RC7_ARTIFACT_LIMITS.entries
        || size > DSH_RC7_ARTIFACT_LIMITS.entry_bytes
        || contentBytes + size > DSH_RC7_ARTIFACT_LIMITS.expanded_bytes) {
        throw artifactLimitError()
      }
      if (nextOffset > archive.length
        || (type !== '0' && type !== '\0')
        || !path.startsWith('package/')
        || path.includes('/../')
        || paths.has(path)) {
        throw new Error('unsupported tar entry')
      }
      paths.add(path)
      contentBytes += size
      entries.push({ path, mode, bytes: archive.subarray(contentOffset, contentOffset + size) })
      offset = nextOffset
    }
  } catch (error) {
    if (error instanceof DshCompatibilityError) throw error
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'Selected DSH artifact contains an unsupported tar structure',
    )
  }
  const packageJson = entries.find(entry => entry.path === 'package/package.json')
  if (entries.length === 0 || packageJson === undefined) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'Selected DSH artifact has no package manifest',
    )
  }
  let manifest
  try {
    manifest = JSON.parse(packageJson.bytes.toString('utf8'))
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'Selected DSH artifact package manifest is invalid',
    )
  }
  return { entries, manifest }
}

/**
 * Hash semantic package contents rather than nondeterministic gzip bytes or
 * package.json object insertion order.
 * @param {Buffer} tarball
 */
export function inspectCanonicalPackageArtifact(tarball) {
  const { entries, manifest } = parsePackageArtifact(tarball)
  const digest = createHash('sha256')
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    const bytes = entry.path === 'package/package.json'
      ? Buffer.from(`${JSON.stringify(canonicalJson(manifest))}\n`)
      : entry.bytes
    digest.update(entry.path)
    digest.update('\0')
    digest.update(String(entry.mode))
    digest.update('\0')
    digest.update(String(bytes.length))
    digest.update('\0')
    digest.update(bytes)
  }
  return Object.freeze({
    name: manifest.name,
    version: manifest.version,
    artifact_sha256: digest.digest('hex'),
    files: entries.length,
  })
}

/**
 * Extract one already-authenticated regular-file-only package into a fresh
 * descriptor-anchored root without invoking package lifecycle scripts.
 * @param {Buffer} tarball
 * @param {string} targetRoot
 * @param {{afterTargetOpened?: () => Promise<void>}} [options]
 */
export async function extractPackageArtifact(tarball, targetRoot, options = {}) {
  if (!isAbsolute(targetRoot)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'DSH artifact extraction target must be absolute',
    )
  }
  const { entries, manifest } = parsePackageArtifact(tarball)
  await mkdir(targetRoot, { recursive: false, mode: 0o700 })
  /** @type {Array<{handle: import('node:fs/promises').FileHandle, path: string, dev: number, ino: number}>} */
  const directories = []
  /** @type {Map<string, typeof directories[number]>} */
  const directoryByPath = new Map()
  /** @type {Array<{parent: typeof directories[number], name: string, dev: number, ino: number, mode: number, bytes: Buffer}>} */
  const files = []
  try {
    const rootInfo = await lstat(targetRoot)
    const rootHandle = await open(
      targetRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const openedRoot = await rootHandle.stat()
    if (!rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || openedRoot.dev !== rootInfo.dev
      || openedRoot.ino !== rootInfo.ino) {
      await rootHandle.close().catch(() => {})
      throw unsafeInstallScope()
    }
    const root = { handle: rootHandle, path: targetRoot, dev: rootInfo.dev, ino: rootInfo.ino }
    directories.push(root)
    directoryByPath.set('', root)
    await options.afterTargetOpened?.()

    for (const entry of entries) {
      const relative = entry.path.slice('package/'.length)
      const segments = relative.split('/')
      if (segments.length === 0
        || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
        throw unsafeInstallScope()
      }
      const name = segments.pop()
      if (name === undefined) throw unsafeInstallScope()
      let parent = root
      let accumulated = ''
      for (const segment of segments) {
        accumulated = accumulated.length === 0 ? segment : `${accumulated}/${segment}`
        const existing = directoryByPath.get(accumulated)
        if (existing !== undefined) {
          parent = existing
          continue
        }
        const childPath = resolve(`/proc/self/fd/${parent.handle.fd}`, segment)
        try {
          await mkdir(childPath, { recursive: false, mode: 0o700 })
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error
        }
        const childInfo = await lstat(childPath)
        const childHandle = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        const openedChild = await childHandle.stat()
        if (!childInfo.isDirectory()
          || childInfo.isSymbolicLink()
          || openedChild.dev !== childInfo.dev
          || openedChild.ino !== childInfo.ino) {
          await childHandle.close().catch(() => {})
          throw unsafeInstallScope()
        }
        parent = {
          handle: childHandle,
          path: childPath,
          dev: childInfo.dev,
          ino: childInfo.ino,
        }
        directories.push(parent)
        directoryByPath.set(accumulated, parent)
      }

      const filePath = resolve(`/proc/self/fd/${parent.handle.fd}`, name)
      const fileHandle = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        entry.mode & 0o777,
      )
      try {
        await fileHandle.writeFile(entry.bytes)
        await fileHandle.chmod(entry.mode & 0o777)
        await fileHandle.sync()
        const info = await fileHandle.stat()
        files.push({
          parent,
          name,
          dev: info.dev,
          ino: info.ino,
          mode: entry.mode & 0o777,
          bytes: entry.bytes,
        })
      } finally {
        await fileHandle.close()
      }
    }

    const visibleRoot = await lstat(targetRoot)
    if (!visibleRoot.isDirectory()
      || visibleRoot.isSymbolicLink()
      || visibleRoot.dev !== root.dev
      || visibleRoot.ino !== root.ino) {
      throw unsafeInstallScope()
    }
    for (const directory of directories.slice(1)) {
      const visible = await lstat(directory.path)
      const opened = await directory.handle.stat()
      if (!visible.isDirectory()
        || visible.isSymbolicLink()
        || visible.dev !== directory.dev
        || visible.ino !== directory.ino
        || opened.dev !== directory.dev
        || opened.ino !== directory.ino) {
        throw unsafeInstallScope()
      }
    }
    for (const file of files) {
      const path = resolve(`/proc/self/fd/${file.parent.handle.fd}`, file.name)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        const bytes = await handle.readFile()
        if (!info.isFile()
          || info.dev !== file.dev
          || info.ino !== file.ino
          || (info.mode & 0o777) !== file.mode
          || !bytes.equals(file.bytes)) {
          throw unsafeInstallScope()
        }
      } finally {
        await handle.close()
      }
    }
  } catch (error) {
    if (error instanceof DshCompatibilityError) throw error
    throw unsafeInstallScope()
  } finally {
    for (const directory of directories.reverse()) {
      await directory.handle.close().catch(() => {})
    }
  }
  return Object.freeze({ name: manifest.name, version: manifest.version, files: entries.length })
}
