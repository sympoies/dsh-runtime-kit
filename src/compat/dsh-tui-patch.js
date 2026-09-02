// @ts-check

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { checkUpstreamReference } from './upstream-reference.js'

const SCHEMA = 'dsh-runtime-kit.dsh-tui-patches.v1'
const RECEIPT_SCHEMA = 'dsh-runtime-kit.dsh-tui-patch-receipt.v1'
const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export class DshTuiPatchError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DshTuiPatchError'
    this.code = code
    this.diagnostic = Object.freeze({
      schema_version: 'dsh-runtime-kit.dsh-tui-patch-diagnostic.v1',
      code,
      ...details,
    })
  }
}

/** @param {unknown} value @param {string} message */
function record(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      message,
    )
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {string} path */
function relativePath(path) {
  return path.length > 0
    && !isAbsolute(path)
    && !path.split(/[\\/]/u).includes('..')
}

/** @param {string | NodeJS.ArrayBufferView} value */
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Validate the complete checked-in TUI patch contract before mutation. */
export function validateDshTuiPatchManifest(/** @type {unknown} */ value) {
  const manifest = record(value, 'DSH TUI patch manifest must be an object')
  if (manifest.schema_version !== SCHEMA
    || manifest.package_name !== PACKAGE_NAME
    || !Array.isArray(manifest.patches)
    || manifest.patches.length !== 1) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      'DSH TUI patch manifest identity or patch set is invalid',
    )
  }
  const patch = record(manifest.patches[0], 'DSH TUI patch entry is invalid')
  if (typeof patch.id !== 'string' || !SAFE_ID.test(patch.id)
    || typeof patch.path !== 'string' || !relativePath(patch.path)
    || typeof patch.sha256 !== 'string' || !SHA256.test(patch.sha256)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      'DSH TUI patch identity is invalid',
    )
  }
  const upstream = checkUpstreamReference(patch.upstream_reference)
  if (upstream !== undefined) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      `DSH TUI patch ${upstream}`,
    )
  }
  const targets = record(patch.targets, 'DSH TUI patch targets are invalid')
  if (Object.keys(targets).length === 0) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      'DSH TUI patch must authenticate at least one target',
    )
  }
  for (const [path, value] of Object.entries(targets)) {
    const target = record(value, `DSH TUI patch target ${path} is invalid`)
    if (!relativePath(path)
      || typeof target.before_sha256 !== 'string' || !SHA256.test(target.before_sha256)
      || typeof target.after_sha256 !== 'string' || !SHA256.test(target.after_sha256)
      || target.before_sha256 === target.after_sha256) {
      throw new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
        `DSH TUI patch target ${path} hashes are invalid`,
      )
    }
  }
  const releases = record(
    patch.validated_releases,
    'DSH TUI patch validated releases are invalid',
  )
  if (Object.keys(releases).length === 0) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
      'DSH TUI patch validated releases are empty',
    )
  }
  for (const [version, value] of Object.entries(releases)) {
    const release = record(value, `DSH TUI patch release ${version} is invalid`)
    if (!RELEASE.test(version)
      || typeof release.package_json_sha256 !== 'string'
      || !SHA256.test(release.package_json_sha256)) {
      throw new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
        `DSH TUI patch release ${version} identity is invalid`,
      )
    }
  }
  return Object.freeze(structuredClone(manifest))
}

/** @param {string} root @param {string} child */
function contained(root, child) {
  const candidate = resolve(root, child)
  const rel = relative(root, candidate)
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return candidate
  }
  throw new DshTuiPatchError(
    'DSH_RUNTIME_KIT_DSH_TUI_PATCH_MANIFEST_INVALID',
    'DSH TUI patch path escapes its trusted root',
  )
}

/** @param {string} root @param {string} child @param {string} label */
async function regularContainedFile(root, child, label) {
  const path = contained(root, child)
  let metadata
  try {
    metadata = await lstat(path)
    const parent = await realpath(dirname(path))
    if (!metadata.isFile() || metadata.isSymbolicLink() || parent !== dirname(path)) {
      throw new Error('unsupported file shape')
    }
  } catch {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_TARGET_INVALID',
      `${label} must be an ordinary file inside its trusted root`,
    )
  }
  return path
}

/** @param {string} gitBin */
async function trustedGit(gitBin) {
  if (!isAbsolute(gitBin)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
      'git-bin must be absolute',
    )
  }
  let canonical
  let metadata
  try {
    canonical = await realpath(gitBin)
    metadata = await stat(canonical)
  } catch {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
      'git-bin must resolve to a trusted executable file',
    )
  }
  const callerUid = process.getuid?.()
  if (!metadata.isFile()
    || (metadata.uid !== 0 && callerUid !== undefined && metadata.uid !== callerUid)
    || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
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
    child.stdin.once('error', error => { stdinError = error })
    child.stdin.end(input)
  })
}

/** @param {string} gitBin @param {string} packageRoot @param {string[]} args @param {Buffer} input */
async function gitApply(gitBin, packageRoot, args, input) {
  const argv = ['-C', packageRoot, 'apply', '--no-index', ...args, '-']
  try {
    await execFileWithInput(gitBin, argv, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        HOME: '/nonexistent-dsh-runtime-kit-tui-patch-home',
        XDG_CONFIG_HOME: '/nonexistent-dsh-runtime-kit-tui-patch-config',
        PATH: dirname(gitBin),
        LANG: 'C',
        LC_ALL: 'C',
      },
    }, input)
  } catch (error) {
    const exitCode = /** @type {any} */ (error).code
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_GIT_FAILED',
      'Git could not complete the authenticated DSH TUI patch operation',
      {
        operation: args.includes('--reverse') ? 'reverse' : 'apply',
        ...Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {},
      },
    )
  }
}

/** Authenticate that the patch touches exactly and only its manifest targets. */
function validatePatchTargets(/** @type {Buffer} */ bytes, /** @type {string[]} */ expected) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
      'DSH TUI patch artifact is not valid UTF-8',
    )
  }
  const paths = []
  const oldHeaders = []
  const newHeaders = []
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u.exec(line)
      if (match === null || match[1] !== match[2] || !relativePath(match[1])) {
        throw new DshTuiPatchError(
          'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
          'DSH TUI patch contains an unsupported path or rename',
        )
      }
      paths.push(match[1])
    } else if (line.startsWith('--- ')) {
      const match = /^--- a\/([^\s]+)$/u.exec(line)
      if (match === null || !relativePath(match[1])) {
        throw new DshTuiPatchError(
          'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
          'DSH TUI patch contains an unsupported original-file header',
        )
      }
      oldHeaders.push(match[1])
    } else if (line.startsWith('+++ ')) {
      const match = /^\+\+\+ b\/([^\s]+)$/u.exec(line)
      if (match === null || !relativePath(match[1])) {
        throw new DshTuiPatchError(
          'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
          'DSH TUI patch contains an unsupported result-file header',
        )
      }
      newHeaders.push(match[1])
    } else if (/^(?:rename|copy) (?:from|to) |^(?:new|deleted) file mode |^Binary files /u.test(line)) {
      throw new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
        'DSH TUI patch may only modify existing authenticated text targets',
      )
    }
  }
  const canonicalExpected = [...expected].sort()
  /** @param {string[]} values */
  const exact = values => values.length === new Set(values).size
    && [...values].sort().join('\n') === canonicalExpected.join('\n')
  if (!exact(paths) || !exact(oldHeaders) || !exact(newHeaders)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
      'DSH TUI patch touched paths do not exactly match its authenticated targets',
      { expected: canonicalExpected, actual: [...paths].sort() },
    )
  }
}

/**
 * Inspect, apply, or reverse the reviewed patch in one installed DSH TUI package.
 * @param {{
 *   action: 'check' | 'apply' | 'reverse', packageRoot: string, patchRoot: string,
 *   manifest: unknown, gitBin: string
 * }} input
 */
export async function manageDshTuiPatch(input) {
  if (!['check', 'apply', 'reverse'].includes(input.action)
    || !isAbsolute(input.packageRoot) || !isAbsolute(input.patchRoot)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
      'action and absolute package-root/patch-root are required',
    )
  }
  const manifest = validateDshTuiPatchManifest(input.manifest)
  const patch = manifest.patches[0]
  const [packageRoot, patchRoot, gitBin] = await Promise.all([
    realpath(input.packageRoot),
    realpath(input.patchRoot),
    trustedGit(input.gitBin),
  ])
  if (packageRoot !== input.packageRoot) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_TARGET_INVALID',
      'DSH TUI package root must not traverse a symlink',
    )
  }
  const rootMetadata = await lstat(packageRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_TARGET_INVALID',
      'DSH TUI package root must be an ordinary directory',
    )
  }
  const packageJsonPath = await regularContainedFile(
    packageRoot,
    'package.json',
    'DSH TUI package manifest',
  )
  const packageJsonBytes = await readFile(packageJsonPath)
  let packageJson
  try {
    packageJson = JSON.parse(packageJsonBytes.toString('utf8'))
  } catch {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_PACKAGE_UNSUPPORTED',
      'DSH TUI package manifest is not valid JSON',
    )
  }
  const release = patch.validated_releases[packageJson.version]
  if (packageJson.name !== manifest.package_name || release === undefined) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_PACKAGE_UNSUPPORTED',
      'DSH TUI package identity is not in the reviewed patch set',
    )
  }
  if (digest(packageJsonBytes) !== release.package_json_sha256) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_PACKAGE_UNSUPPORTED',
      'DSH TUI package manifest bytes do not match the reviewed release',
      { version: packageJson.version },
    )
  }
  const patchFile = await regularContainedFile(patchRoot, patch.path, 'DSH TUI patch artifact')
  const patchBytes = await readFile(patchFile)
  if (digest(patchBytes) !== patch.sha256) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARTIFACT_INVALID',
      'DSH TUI patch artifact hash does not match its manifest',
      { patch_id: patch.id },
    )
  }
  validatePatchTargets(patchBytes, Object.keys(patch.targets))

  const inspect = async () => {
    const states = await Promise.all(Object.entries(patch.targets).map(async ([path, hashes]) => {
      const target = await regularContainedFile(packageRoot, path, `DSH TUI patch target ${path}`)
      const actual = digest(await readFile(target))
      if (actual === hashes.before_sha256) return /** @type {const} */ ('pristine')
      if (actual === hashes.after_sha256) return /** @type {const} */ ('patched')
      throw new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_DRIFT',
        `DSH TUI patch target drifted: ${path}`,
        { patch_id: patch.id, path, actual_sha256: actual },
      )
    }))
    if (!states.every(state => state === states[0])) {
      throw new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_DRIFT',
        'DSH TUI patch targets are in a partially applied state',
        { patch_id: patch.id },
      )
    }
    return states[0]
  }

  const before = await inspect()
  let changed = false
  if (input.action === 'apply' && before === 'pristine') {
    await gitApply(gitBin, packageRoot, ['--check', '--whitespace=error-all'], patchBytes)
    await gitApply(gitBin, packageRoot, ['--whitespace=error-all'], patchBytes)
    changed = true
  } else if (input.action === 'reverse' && before === 'patched') {
    await gitApply(gitBin, packageRoot, ['--reverse', '--check'], patchBytes)
    await gitApply(gitBin, packageRoot, ['--reverse'], patchBytes)
    changed = true
  }
  const after = await inspect()
  const expectedAfter = input.action === 'reverse' ? 'pristine'
    : input.action === 'apply' ? 'patched' : before
  if (after !== expectedAfter) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_DRIFT',
      'DSH TUI patch operation did not reach its expected state',
      { patch_id: patch.id, expected: expectedAfter, actual: after },
    )
  }
  return Object.freeze({
    schema_version: RECEIPT_SCHEMA,
    package_name: manifest.package_name,
    patch_id: patch.id,
    version: packageJson.version,
    action: input.action,
    before,
    after,
    changed,
  })
}
