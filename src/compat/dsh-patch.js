// @ts-check

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { checkUpstreamReference } from './upstream-reference.js'

const run = promisify(execFile)
const SCHEMA = 'dsh-runtime-kit.dsh-patches.v1'
const RECEIPT_SCHEMA = 'dsh-runtime-kit.dsh-patch-receipt.v1'
const SHA1 = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export class DshPatchError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DshPatchError'
    this.code = code
    this.diagnostic = Object.freeze({
      schema_version: 'dsh-runtime-kit.dsh-patch-diagnostic.v1',
      code,
      ...details,
    })
  }
}

/** @param {unknown} value @param {string} message */
function record(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshPatchError('DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID', message)
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {string} path */
function relativePath(path) {
  return path.length > 0
    && !isAbsolute(path)
    && !path.split(/[\\/]/u).includes('..')
}

/** @param {unknown} value */
function validHashPair(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const pair = /** @type {Record<string, unknown>} */ (value)
  return typeof pair.before_sha256 === 'string' && SHA256.test(pair.before_sha256)
    && typeof pair.after_sha256 === 'string' && SHA256.test(pair.after_sha256)
    && pair.before_sha256 !== pair.after_sha256
}

/** Validate the complete checked-in patch contract before it can mutate DSH. */
export function validateDshPatchManifest(/** @type {unknown} */ value) {
  const manifest = record(value, 'DSH patch manifest must be an object')
  if (manifest.schema_version !== SCHEMA
    || !Array.isArray(manifest.patches)
    || manifest.patches.length !== 1) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH patch manifest identity or patch set is invalid',
    )
  }
  const patch = record(manifest.patches[0], 'DSH patch entry is invalid')
  if (typeof patch.id !== 'string' || !SAFE_ID.test(patch.id)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH patch identity is invalid',
    )
  }
  const upstream = checkUpstreamReference(patch.upstream_reference)
  if (upstream !== undefined) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      `DSH patch ${upstream}`,
    )
  }
  const directArtifact = typeof patch.path === 'string' && relativePath(patch.path)
    && typeof patch.sha256 === 'string' && SHA256.test(patch.sha256)
  const releaseArtifacts = patch.release_artifacts === undefined
    ? undefined
    : record(patch.release_artifacts, 'DSH release patch artifacts are invalid')
  const versionedArtifacts = releaseArtifacts !== undefined
    && Object.keys(releaseArtifacts).length > 0
    && Object.values(releaseArtifacts).every(value => {
      const artifact = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? /** @type {Record<string, unknown>} */ (value)
        : undefined
      return artifact !== undefined
        && typeof artifact.path === 'string' && relativePath(artifact.path)
        && typeof artifact.sha256 === 'string' && SHA256.test(artifact.sha256)
        && Object.keys(artifact).length === 2
    })
  if (directArtifact === versionedArtifacts
    || (versionedArtifacts && new Set(Object.values(releaseArtifacts).map(value => value.path)).size
      !== Object.keys(releaseArtifacts).length)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH patch artifact identity is invalid',
    )
  }
  const targets = record(patch.targets, 'DSH patch targets are invalid')
  if (Object.keys(targets).length === 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH patch must authenticate at least one target',
    )
  }
  for (const [path, value] of Object.entries(targets)) {
    const target = record(value, `DSH patch target ${path} is invalid`)
    const direct = validHashPair(target)
    const releaseHashes = target.release_hashes === undefined
      ? undefined
      : record(target.release_hashes, `DSH patch target ${path} release hashes are invalid`)
    const versioned = releaseHashes !== undefined
      && Object.keys(releaseHashes).length > 0
      && Object.values(releaseHashes).every(validHashPair)
    if (!relativePath(path) || direct === versioned) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
        `DSH patch target ${path} hashes are invalid`,
      )
    }
  }
  const releases = record(
    patch.validated_releases,
    'DSH patch validated releases are invalid',
  )
  if (Object.keys(releases).length === 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH patch validated releases are empty',
    )
  }
  const revisions = new Set()
  for (const [version, value] of Object.entries(releases)) {
    const release = record(value, `DSH patch release ${version} is invalid`)
    if (version.length === 0 || typeof release.revision !== 'string'
      || !SHA1.test(release.revision) || revisions.has(release.revision)) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
        `DSH patch release ${version} identity is invalid`,
      )
    }
    revisions.add(release.revision)
  }
  const releaseNames = Object.keys(releases).sort().join('\0')
  if (releaseArtifacts !== undefined
    && Object.keys(releaseArtifacts).sort().join('\0') !== releaseNames) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
      'DSH release patch artifacts do not match the validated release set',
    )
  }
  for (const [path, target] of Object.entries(targets)) {
    if (target.release_hashes !== undefined
      && Object.keys(target.release_hashes).some(version => releases[version] === undefined)) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
        `DSH patch target ${path} names an unknown validated release`,
      )
    }
  }
  for (const version of Object.keys(releases)) {
    if (!Object.values(targets).some(target => target.release_hashes?.[version] !== undefined
      || target.release_hashes === undefined)) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
        `DSH patch release ${version} has no authenticated targets`,
      )
    }
  }
  return Object.freeze(structuredClone(manifest))
}

/** @param {Record<string, any>} target @param {string} release */
function targetHashes(target, release) {
  return target.release_hashes?.[release] ?? target
}

/** @param {string | NodeJS.ArrayBufferView} value */
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {string} root @param {string} child */
function contained(root, child) {
  const candidate = resolve(root, child)
  const rel = relative(root, candidate)
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return candidate
  }
  throw new DshPatchError(
    'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
    'DSH patch path escapes its trusted root',
  )
}

/** @param {string} gitBin */
async function trustedGit(gitBin) {
  if (!isAbsolute(gitBin)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'git-bin must be absolute',
    )
  }
  let canonical
  let metadata
  try {
    canonical = await realpath(gitBin)
    metadata = await stat(canonical)
  } catch {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'git-bin must resolve to a trusted executable file',
    )
  }
  const callerUid = process.getuid?.()
  if (!metadata.isFile()
    || (metadata.uid !== 0 && callerUid !== undefined && metadata.uid !== callerUid)
    || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'git-bin must resolve to a trusted executable file',
    )
  }
  return canonical
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptionsWithStringEncoding} options
 * @param {Buffer} input
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    /** @type {Error | undefined} */
    let stdinError
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (stdinError !== undefined) {
        reject(stdinError)
        return
      }
      resolve({ stdout, stderr })
    })
    if (child.stdin === null) {
      reject(new Error('authenticated Git subprocess has no stdin'))
      return
    }
    // A trusted Git wrapper can exit before consuming the authenticated patch
    // bytes. Consume and retain EPIPE before writing, but let the execFile
    // completion remain authoritative for the child's numeric exit status.
    // If the child otherwise succeeds, the retained pipe error still fails
    // closed rather than accepting a partial authenticated patch.
    child.stdin.once('error', error => { stdinError = error })
    child.stdin.end(input)
  })
}

/**
 * @param {string} gitBin @param {string} cwd @param {string[]} args @param {Buffer} [input]
 * @returns {Promise<string>}
 */
async function git(gitBin, cwd, args, input) {
  try {
    const argv = [
      '--no-optional-locks',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.attributesFile=/dev/null',
      '-c', 'core.excludesFile=/dev/null',
      '-c', `safe.directory=${cwd}`,
      '-C', cwd,
      ...args,
    ]
    /** @type {import('node:child_process').ExecFileOptionsWithStringEncoding} */
    const options = {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        HOME: '/nonexistent-dsh-runtime-kit-patch-home',
        XDG_CONFIG_HOME: '/nonexistent-dsh-runtime-kit-patch-config',
        PATH: dirname(gitBin),
        LANG: 'C',
        LC_ALL: 'C',
      },
    }
    const result = input === undefined
      ? await run(gitBin, argv, options)
      : await execFileWithInput(gitBin, argv, options, input)
    return result.stdout.trimEnd()
  } catch (error) {
    const operation = args[0] === 'rev-parse'
      ? 'inspect-repository'
      : args[0] === 'ls-files'
        ? 'inspect-index'
        : args[0] === 'status'
          ? 'inspect-worktree'
          : args[0] === 'apply' && args.includes('--reverse')
            ? args.includes('--check') ? 'reverse-check' : 'reverse'
            : args[0] === 'apply'
              ? args.includes('--check') ? 'apply-check' : 'apply'
              : 'repository-operation'
    const exitCode = /** @type {any} */ (error).code
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_GIT_FAILED',
      'Git could not complete the authenticated DSH patch operation',
      {
        operation,
        ...Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {},
      },
    )
  }
}

/** @param {string} output */
function indexEntries(output) {
  const entries = new Map()
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^([0-9]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/u.exec(record)
    if (match === null || match[3] !== '0' || entries.has(match[4])) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
        'DSH index does not contain one ordinary stage-zero entry per path',
      )
    }
    entries.set(match[4], Object.freeze({ mode: match[1], hash: match[2] }))
  }
  return entries
}

/** @param {string} output */
function headEntries(output) {
  const entries = new Map()
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(record)
    if (match === null || match[2] !== 'blob' || entries.has(match[4])) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
        'DSH HEAD contains an unsupported tracked entry',
      )
    }
    entries.set(match[4], Object.freeze({ mode: match[1], hash: match[3] }))
  }
  return entries
}

/** @param {Buffer} bytes @param {'sha1'|'sha256'} algorithm */
function gitBlobDigest(bytes, algorithm) {
  return createHash(algorithm)
    .update(`blob ${bytes.length}\0`, 'utf8')
    .update(bytes)
    .digest('hex')
}

/**
 * Authenticate HEAD, index, and raw worktree bytes without Git clean filters,
 * attributes, fileMode config, or status heuristics.
 * @param {string} gitBin
 * @param {string} sourceRoot
 * @param {Map<string, string>} expectedModified
 */
async function verifyRawCheckout(gitBin, sourceRoot, expectedModified) {
  const [format, index, head, flags, excludePath, commonDirectory] = await Promise.all([
    git(gitBin, sourceRoot, ['rev-parse', '--show-object-format']),
    git(gitBin, sourceRoot, ['ls-files', '-s', '-z']),
    git(gitBin, sourceRoot, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']),
    git(gitBin, sourceRoot, ['ls-files', '-v', '-z']),
    git(gitBin, sourceRoot, ['rev-parse', '--git-path', 'info/exclude']),
    git(gitBin, sourceRoot, ['rev-parse', '--git-common-dir']),
  ])
  if (format !== 'sha1' && format !== 'sha256') {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
      'DSH repository uses an unsupported object format',
    )
  }
  const flaggedCount = flags.split('\0').filter(Boolean)
    .filter(entry => entry[0] !== 'H').length
  if (flaggedCount > 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH checkout uses unsupported index visibility flags',
      { flagged_count: flaggedCount },
    )
  }
  const indexed = indexEntries(index)
  const committed = headEntries(head)
  if (indexed.size !== committed.size
    || [...indexed].some(([path, entry]) => {
      const expected = committed.get(path)
      return expected === undefined
        || expected.mode !== entry.mode
        || expected.hash !== entry.hash
    })) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH index differs from the authenticated HEAD tree',
      { indexed_count: indexed.size, head_count: committed.size },
    )
  }

  let driftCount = 0
  for (const [path, entry] of indexed) {
    let metadata
    let bytes
    try {
      const worktreePath = contained(sourceRoot, path)
      metadata = await lstat(worktreePath)
      if (entry.mode === '120000') {
        if (!metadata.isSymbolicLink()) {
          driftCount += 1
          continue
        }
        bytes = Buffer.from(await readlink(worktreePath), 'utf8')
      } else if (entry.mode === '100644' || entry.mode === '100755') {
        const executable = (metadata.mode & 0o111) !== 0
        if (!metadata.isFile() || metadata.isSymbolicLink()
          || executable !== (entry.mode === '100755')) {
          driftCount += 1
          continue
        }
        bytes = await readFile(worktreePath)
      } else {
        throw new DshPatchError(
          'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
          'DSH repository contains an unsupported tracked mode',
        )
      }
    } catch (error) {
      if (error instanceof DshPatchError) throw error
      driftCount += 1
      continue
    }
    const expectedSha256 = expectedModified.get(path)
    if (expectedSha256 !== undefined
      ? digest(bytes) !== expectedSha256
      : gitBlobDigest(bytes, format) !== entry.hash) {
      driftCount += 1
    }
  }
  if (driftCount > 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH tracked worktree bytes or modes differ from authenticated HEAD',
      { drift_count: driftCount },
    )
  }

  let commonRoot
  try {
    commonRoot = await realpath(isAbsolute(commonDirectory)
      ? commonDirectory
      : resolve(sourceRoot, commonDirectory))
  } catch (error) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
      'DSH common Git directory could not be authenticated',
    )
  }
  const expectedExclude = resolve(commonRoot, 'info', 'exclude')
  const resolvedExclude = resolve(isAbsolute(excludePath)
    ? excludePath
    : resolve(sourceRoot, excludePath))
  if (resolvedExclude !== expectedExclude) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
      'DSH repository-local exclude path could not be authenticated',
    )
  }
  let localExclude = ''
  try {
    const infoMetadata = await lstat(resolve(commonRoot, 'info'))
    const excludeMetadata = await lstat(expectedExclude)
    if (!infoMetadata.isDirectory() || infoMetadata.isSymbolicLink()
      || !excludeMetadata.isFile() || excludeMetadata.isSymbolicLink()) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
        'DSH repository-local exclude path has an unsupported file type',
      )
    }
    localExclude = await readFile(expectedExclude, 'utf8')
  } catch (error) {
    if (error instanceof DshPatchError) throw error
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  const localExcludeCount = localExclude.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#')).length
  if (localExcludeCount > 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH checkout uses unsupported repository-local exclude patterns',
      { local_exclude_count: localExcludeCount },
    )
  }
  const untracked = await git(gitBin, sourceRoot, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ])
  const untrackedCount = untracked.split('\0').filter(Boolean).length
  if (untrackedCount > 0) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH checkout contains untracked files outside the reviewed patch state',
      { untracked_count: untrackedCount },
    )
  }
}

/** Authenticate that a reviewed patch can touch exactly and only manifest targets. */
function validatePatchTargets(/** @type {Buffer} */ bytes, /** @type {string[]} */ expected) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
      'DSH patch artifact is not valid UTF-8',
    )
  }
  const paths = []
  const oldHeaders = []
  const newHeaders = []
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u.exec(line)
      if (match === null || match[1] !== match[2] || !relativePath(match[1])) {
        throw new DshPatchError(
          'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
          'DSH patch contains an unsupported path or rename',
        )
      }
      paths.push(match[1])
    } else if (line.startsWith('--- ')) {
      const match = /^--- a\/([^\s]+)$/u.exec(line)
      if (match === null || !relativePath(match[1])) {
        throw new DshPatchError(
          'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
          'DSH patch contains an unsupported original-file header',
        )
      }
      oldHeaders.push(match[1])
    } else if (line.startsWith('+++ ')) {
      const match = /^\+\+\+ b\/([^\s]+)$/u.exec(line)
      if (match === null || !relativePath(match[1])) {
        throw new DshPatchError(
          'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
          'DSH patch contains an unsupported result-file header',
        )
      }
      newHeaders.push(match[1])
    } else if (/^(?:rename|copy) (?:from|to) |^(?:new|deleted) file mode |^Binary files /u.test(line)) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
        'DSH patch may only modify existing authenticated text targets',
      )
    }
  }
  const canonicalExpected = [...expected].sort()
  /** @param {string[]} values */
  const exact = values => values.length === new Set(values).size
    && [...values].sort().join('\n') === canonicalExpected.join('\n')
  if (!exact(paths) || !exact(oldHeaders) || !exact(newHeaders)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
      'DSH patch touched paths do not exactly match its authenticated targets',
      { expected: canonicalExpected, actual: [...paths].sort() },
    )
  }
}

/**
 * Inspect, apply, or reverse the one reviewed downstream DSH patch.
 * @param {{
 *   action: 'check' | 'apply' | 'reverse', sourceRoot: string, patchRoot: string,
 *   manifest: unknown, gitBin: string
 * }} input
 */
export async function manageDshPatch(input) {
  if (!['check', 'apply', 'reverse'].includes(input.action)
    || !isAbsolute(input.sourceRoot) || !isAbsolute(input.patchRoot)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'action and absolute source-root/patch-root are required',
    )
  }
  const manifest = validateDshPatchManifest(input.manifest)
  const patch = manifest.patches[0]
  const [sourceRoot, patchRoot, gitBin] = await Promise.all([
    realpath(input.sourceRoot),
    realpath(input.patchRoot),
    trustedGit(input.gitBin),
  ])
  const topLevel = await realpath(await git(gitBin, sourceRoot, ['rev-parse', '--show-toplevel']))
  if (topLevel !== sourceRoot) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_SOURCE_INVALID',
      'DSH source root must be the exact Git checkout root',
    )
  }
  const revision = await git(gitBin, sourceRoot, ['rev-parse', 'HEAD'])
  const release = Object.entries(patch.validated_releases)
    .find(([, candidate]) => candidate.revision === revision)
  if (release === undefined) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_REVISION_UNSUPPORTED',
      'DSH revision is not in the reviewed downstream patch set',
      { revision },
    )
  }
  const selectedTargets = Object.fromEntries(
    Object.entries(patch.targets).flatMap(([path, target]) => {
      if (target.release_hashes !== undefined && target.release_hashes[release[0]] === undefined) {
        return []
      }
      return [[path, targetHashes(target, release[0])]]
    }),
  )
  const artifact = patch.release_artifacts?.[release[0]] ?? patch
  const patchFile = contained(patchRoot, artifact.path)
  const patchBytes = await readFile(patchFile)
  if (digest(patchBytes) !== artifact.sha256) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
      'DSH patch artifact hash does not match its manifest',
      { patch_id: patch.id },
    )
  }
  validatePatchTargets(patchBytes, Object.keys(selectedTargets))

  const inspect = async () => {
    const states = await Promise.all(Object.entries(selectedTargets).map(async ([path, hashes]) => {
      let bytes
      try {
        bytes = await readFile(contained(sourceRoot, path))
      } catch {
        throw new DshPatchError(
          'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
          `DSH patch target is missing: ${path}`,
          { patch_id: patch.id, path },
        )
      }
      const actual = digest(bytes)
      if (actual === hashes.before_sha256) return /** @type {const} */ ('pristine')
      if (actual === hashes.after_sha256) return /** @type {const} */ ('patched')
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
        `DSH patch target drifted: ${path}`,
        { patch_id: patch.id, path, actual_sha256: actual },
      )
    }))
    if (!states.every(state => state === states[0])) {
      throw new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
        'DSH patch targets are in a partially applied state',
        { patch_id: patch.id },
      )
    }
    const state = states[0]
    await verifyRawCheckout(gitBin, sourceRoot, new Map(
      state === 'patched'
        ? Object.entries(selectedTargets).map(([path, hashes]) => [path, hashes.after_sha256])
        : [],
    ))
    return state
  }

  const before = await inspect()
  let changed = false
  if (input.action === 'apply' && before === 'pristine') {
    await git(gitBin, sourceRoot, ['apply', '--check', '--whitespace=error-all', '-'], patchBytes)
    await git(gitBin, sourceRoot, ['apply', '--whitespace=error-all', '-'], patchBytes)
    changed = true
  } else if (input.action === 'reverse' && before === 'patched') {
    await git(gitBin, sourceRoot, ['apply', '--reverse', '--check', '-'], patchBytes)
    await git(gitBin, sourceRoot, ['apply', '--reverse', '-'], patchBytes)
    changed = true
  }
  const after = await inspect()
  const expectedAfter = input.action === 'reverse' ? 'pristine'
    : input.action === 'apply' ? 'patched' : before
  if (after !== expectedAfter) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
      'DSH patch operation did not reach its expected state',
      { patch_id: patch.id, expected: expectedAfter, actual: after },
    )
  }
  return Object.freeze({
    schema_version: RECEIPT_SCHEMA,
    patch_id: patch.id,
    version: release[0],
    revision,
    action: input.action,
    before,
    after,
    changed,
    source_checkout_clean: after === 'pristine',
    runtime_rebuilt: false,
    upstream_checkout_clean: after === 'pristine',
  })
}
