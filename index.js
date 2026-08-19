import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { applyPolicy, plusOneTool } from './policy.js'
import { assertDshRc7Runtime, loadDshRc7Runtime } from './src/compat/contract.js'
import { installReviewSpecialists } from './src/review/index.js'

export { plusOneTool }

export const name = 'dsh-runtime-kit'
export const inject = ['agents', 'sessions', 'shell', 'shellEnv', 'skills', 'subagents', 'subprocess', 'tools']

const bundledSkillDir = fileURLToPath(new URL('./skills/', import.meta.url))
const DEFAULT_PRIVATE_MAX_DEPTH = 32
const HARD_PRIVATE_MAX_DEPTH = 64
const DEFAULT_PRIVATE_MAX_ENTRIES = 10_000
const HARD_PRIVATE_MAX_ENTRIES = 20_000
const MAX_PRIVATE_FILE_BYTES = 4 * 1024 * 1024
const MAX_PRIVATE_TOTAL_BYTES = 32 * 1024 * 1024
const PRIVATE_PROVIDER = 'dsh-runtime-kit-private-snapshot'

function configuredPrivateSkillsDir(config) {
  const configured = config.privateSkillsDir
    ?? process.env.DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR
  if (configured === undefined || configured === '') return undefined
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be an absolute path')
  }
  if (process.platform === 'win32') {
    throw new Error('dsh-runtime-kit: privateSkillsDir is disabled on Windows until ACL trust checks are available')
  }
  return resolve(configured)
}

function boundedLimit(value, fallback, hardMaximum, field) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-runtime-kit: ${field} must be a positive integer`)
  }
  return Math.min(value, hardMaximum)
}

function privateLimits(options = {}) {
  return {
    maxDepth: boundedLimit(
      options.maxDepth,
      DEFAULT_PRIVATE_MAX_DEPTH,
      HARD_PRIVATE_MAX_DEPTH,
      'private skill maximum depth',
    ),
    maxEntries: boundedLimit(
      options.maxEntries,
      DEFAULT_PRIVATE_MAX_ENTRIES,
      HARD_PRIVATE_MAX_ENTRIES,
      'private skill maximum entry count',
    ),
  }
}

function writableByGroupOrWorld(metadata) {
  return (metadata.mode & 0o022) !== 0
}

function assertCurrentUserOwner(metadata, subject) {
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`dsh-runtime-kit: ${subject} must be owned by the current user`)
  }
}

async function assertTrustedAncestor(directory) {
  const metadata = await stat(directory)
  if (!metadata.isDirectory()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir ancestors must be directories')
  }
  if (!writableByGroupOrWorld(metadata)) return
  const stickyOwner = (metadata.mode & 0o1000) !== 0
    && (metadata.uid === 0
      || (typeof process.getuid === 'function' && metadata.uid === process.getuid()))
  if (!stickyOwner) {
    throw new Error('dsh-runtime-kit: privateSkillsDir has an unsafe writable ancestor')
  }
}

function entryFingerprint(path, type, metadata) {
  return {
    path,
    type,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  }
}

function sameFingerprint(expected, metadata) {
  return expected.dev === metadata.dev
    && expected.ino === metadata.ino
    && expected.mode === metadata.mode
    && expected.uid === metadata.uid
    && expected.size === metadata.size
    && expected.mtimeMs === metadata.mtimeMs
    && expected.ctimeMs === metadata.ctimeMs
}

async function trustedPrivateTree(root, limits) {
  const rootLinkMetadata = await lstat(root)
  if (rootLinkMetadata.isSymbolicLink()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must not be a symbolic link')
  }
  const canonical = await realpath(root)
  const rootMetadata = await stat(canonical)
  if (!rootMetadata.isDirectory()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be a directory')
  }
  assertCurrentUserOwner(rootMetadata, 'privateSkillsDir')
  if (writableByGroupOrWorld(rootMetadata)) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must not be group- or world-writable')
  }

  const filesystemRoot = parse(canonical).root
  for (let cursor = dirname(canonical);; cursor = dirname(cursor)) {
    await assertTrustedAncestor(cursor)
    if (cursor === filesystemRoot) break
  }

  const entries = []
  const stack = [{ directory: canonical, depth: 0 }]
  let totalBytes = 0
  while (stack.length > 0) {
    const current = stack.pop()
    const children = await readdir(current.directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (entries.length >= limits.maxEntries) {
        throw new Error(`dsh-runtime-kit: privateSkillsDir exceeds maximum entry count ${limits.maxEntries}`)
      }
      const path = join(current.directory, child.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error('dsh-runtime-kit: privateSkillsDir must not contain symbolic links')
      }
      assertCurrentUserOwner(metadata, 'privateSkillsDir entries')
      if (writableByGroupOrWorld(metadata)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir entries must not be group- or world-writable')
      }
      const canonicalEntry = await realpath(path)
      if (!canonicalEntry.startsWith(`${canonical}${sep}`)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir entries must remain inside the configured root')
      }
      const childPath = relative(canonical, canonicalEntry)
      if (metadata.isDirectory()) {
        const depth = current.depth + 1
        if (depth > limits.maxDepth) {
          throw new Error(`dsh-runtime-kit: privateSkillsDir exceeds maximum traversal depth ${limits.maxDepth}`)
        }
        entries.push(entryFingerprint(childPath, 'directory', metadata))
        stack.push({ directory: canonicalEntry, depth })
        continue
      }
      if (!metadata.isFile()) {
        throw new Error('dsh-runtime-kit: privateSkillsDir may contain only regular files and directories')
      }
      if (metadata.size > MAX_PRIVATE_FILE_BYTES) {
        throw new Error(`dsh-runtime-kit: privateSkillsDir file exceeds ${MAX_PRIVATE_FILE_BYTES} bytes`)
      }
      totalBytes += metadata.size
      if (totalBytes > MAX_PRIVATE_TOTAL_BYTES) {
        throw new Error(`dsh-runtime-kit: privateSkillsDir exceeds ${MAX_PRIVATE_TOTAL_BYTES} total file bytes`)
      }
      entries.push(entryFingerprint(childPath, 'file', metadata))
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    root: canonical,
    rootFingerprint: entryFingerprint('.', 'directory', rootMetadata),
    entries,
  }
}

function sameTree(left, right) {
  return JSON.stringify(left.rootFingerprint) === JSON.stringify(right.rootFingerprint)
    && JSON.stringify(left.entries) === JSON.stringify(right.entries)
}

function containedDestination(root, child) {
  const destination = resolve(root, child)
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error('dsh-runtime-kit: private snapshot destination escaped its root')
  }
  return destination
}

async function copyPrivateTree(observation, snapshotRoot) {
  const fileContents = new Map()
  const directories = observation.entries
    .filter(entry => entry.type === 'directory')
    .sort((left, right) => left.path.split(sep).length - right.path.split(sep).length)
  for (const entry of directories) {
    await mkdir(containedDestination(snapshotRoot, entry.path), { mode: 0o700 })
  }

  for (const entry of observation.entries.filter(candidate => candidate.type === 'file')) {
    const source = containedDestination(observation.root, entry.path)
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    let content
    try {
      const before = await sourceHandle.stat()
      if (!sameFingerprint(entry, before)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir changed before snapshot read')
      }
      content = await sourceHandle.readFile()
      const after = await sourceHandle.stat()
      if (!sameFingerprint(entry, after)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir changed during snapshot read')
      }
    } finally {
      await sourceHandle.close()
    }
    const destination = containedDestination(snapshotRoot, entry.path)
    const destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await destinationHandle.writeFile(content)
    } finally {
      await destinationHandle.close()
    }
    fileContents.set(entry.path, content)
  }
  return fileContents
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const closing = findClosingFrontmatter(raw, firstLineEnd + 1)
  if (closing === undefined) return undefined
  const data = parseYaml(raw.slice(firstLineEnd + 1, closing.start))
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return { data, body: raw.slice(closing.bodyStart).trim() }
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function parseInvocationPolicy(data) {
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported in private snapshots`)
    }
  }
  return {
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
  }
}

function parsePrivateSkill(raw, path, resourcePath) {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = parsed.data.name
  const description = parsed.data.description
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined
  if (typeof description !== 'string' || description.length === 0) return undefined
  const whenToUse = parsed.data.whenToUse
  const metadata = parsed.data.metadata
  return Object.freeze({
    name,
    description,
    ...typeof whenToUse === 'string' && whenToUse.length > 0 ? { whenToUse } : {},
    invocation: Object.freeze(parseInvocationPolicy(parsed.data)),
    source: 'custom',
    provider: PRIVATE_PROVIDER,
    resourceBase: Object.freeze({ kind: 'directory', path: resourcePath }),
    path,
    ...typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? { metadata: Object.freeze(structuredClone(metadata)) }
      : {},
    content: parsed.body,
  })
}

function privateDefinitions(observation, snapshotRoot, contents) {
  const definitions = []
  const names = new Set()
  for (const entry of observation.entries) {
    if (entry.type !== 'file') continue
    const segments = entry.path.split(sep)
    const directorySkill = segments.length === 2 && segments[1] === 'SKILL.md'
    const flatSkill = segments.length === 1 && segments[0].endsWith('.md')
    if (!directorySkill && !flatSkill) continue
    const content = contents.get(entry.path)
    if (content === undefined) throw new Error('dsh-runtime-kit: private snapshot content is incomplete')
    const snapshotPath = containedDestination(snapshotRoot, entry.path)
    const resourcePath = directorySkill ? dirname(snapshotPath) : snapshotRoot
    const definition = parsePrivateSkill(content.toString('utf8'), snapshotPath, resourcePath)
    if (definition === undefined) continue
    if (names.has(definition.name)) {
      throw new Error(`dsh-runtime-kit: duplicate private skill name "${definition.name}"`)
    }
    names.add(definition.name)
    definitions.push(definition)
  }
  return Object.freeze(definitions.sort((left, right) => left.name.localeCompare(right.name)))
}

async function sealSnapshot(observation, snapshotRoot) {
  for (const entry of observation.entries.filter(candidate => candidate.type === 'file')) {
    const executable = (entry.mode & 0o111) !== 0
    await chmod(containedDestination(snapshotRoot, entry.path), executable ? 0o500 : 0o400)
  }
  const directories = observation.entries
    .filter(entry => entry.type === 'directory')
    .sort((left, right) => right.path.split(sep).length - left.path.split(sep).length)
  for (const entry of directories) {
    await chmod(containedDestination(snapshotRoot, entry.path), 0o500)
  }
  await chmod(snapshotRoot, 0o500)
}

async function removeSnapshot(observation, snapshotRoot) {
  try {
    await chmod(snapshotRoot, 0o700)
    for (const entry of observation.entries.filter(candidate => candidate.type === 'directory')) {
      await chmod(containedDestination(snapshotRoot, entry.path), 0o700)
    }
  } catch {
    // Best-effort unsealing; rm reports an actionable failure if cleanup remains impossible.
  }
  await rm(snapshotRoot, { recursive: true, force: true })
}

/**
 * Validate and detach one private catalog. Traversal is asynchronous and
 * iterative; defaults cap it at 32 levels, 10,000 entries, 4 MiB per file,
 * and 32 MiB total. Every regular file is read through O_NOFOLLOW and matched
 * before/after by inode metadata, the source tree is revalidated after copy,
 * and definitions are parsed from retained bytes rather than reopened paths.
 */
export async function snapshotPrivateSkills(configured, options = {}) {
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be an absolute path')
  }
  const limits = privateLimits(options)
  const before = await trustedPrivateTree(resolve(configured), limits)
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-private-snapshot-'))
  await chmod(snapshotRoot, 0o700)
  try {
    const contents = await copyPrivateTree(before, snapshotRoot)
    const after = await trustedPrivateTree(before.root, limits)
    if (!sameTree(before, after)) {
      throw new Error('dsh-runtime-kit: privateSkillsDir changed while creating its snapshot')
    }
    const definitions = privateDefinitions(before, snapshotRoot, contents)
    await sealSnapshot(before, snapshotRoot)
    let disposed = false
    return Object.freeze({
      root: snapshotRoot,
      definitions,
      limits: Object.freeze({ ...limits }),
      trust: Object.freeze({
        source: 'owner-controlled-posix-tree',
        instructions: 'memory-snapshot',
        resources: 'sealed-process-snapshot',
      }),
      async dispose() {
        if (disposed) return
        disposed = true
        await removeSnapshot(before, snapshotRoot)
      },
    })
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true })
    throw error
  }
}

export async function apply(ctx, config = {}) {
  const privateRoot = configuredPrivateSkillsDir(config)
  const privateSnapshot = privateRoot === undefined
    ? undefined
    : await snapshotPrivateSkills(privateRoot, {
      maxDepth: config.privateSkillMaxDepth,
      maxEntries: config.privateSkillMaxEntries,
    })
  try {
    assertDshRc7Runtime(ctx)
    const dshRuntime = await loadDshRc7Runtime()
    dshRuntime.filesystemSkillsApply(ctx, {
      providerName: 'dsh-runtime-kit',
      includeDefaultRoots: false,
      customSkillDirs: [],
      bundledSkillDir,
      watch: false,
      watchFollowSymlinks: false,
    })
    if (privateSnapshot !== undefined) {
      for (const definition of privateSnapshot.definitions) ctx.skills.register(definition)
      ctx.effect(function* () {
        yield async () => { await privateSnapshot.dispose() }
      }, 'dsh-runtime-kit private skill snapshot')
    }
    const reviewers = installReviewSpecialists(ctx, config)
    applyPolicy(ctx, config, reviewers, dshRuntime)
  } catch (error) {
    await privateSnapshot?.dispose()
    throw error
  }
}
