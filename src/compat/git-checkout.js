// @ts-check

import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  DshCompatibilityError,
  inspectDshSource,
  validateDshCompatibilityManifest,
} from './contract.js'

const run = promisify(execFile)

/** @param {string} path */
async function trustedGit(path) {
  let canonical
  let metadata
  try {
    canonical = await realpath(path)
    metadata = await stat(canonical)
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_GIT_INVALID',
      'The compatibility Git executable is unavailable',
    )
  }
  const ownerTrusted = typeof process.getuid !== 'function'
    || metadata.uid === 0
    || metadata.uid === process.getuid()
  if (!metadata.isFile() || !ownerTrusted || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_GIT_INVALID',
      'The compatibility Git executable is not a trusted executable file',
    )
  }
  return canonical
}

/** @param {string} gitBin @param {string} sourceRoot @param {string[]} args */
async function git(gitBin, sourceRoot, args) {
  try {
    const result = await run(gitBin, [
      '--no-optional-locks',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.attributesFile=/dev/null',
      '-c', 'safe.directory=' + sourceRoot,
      '-C', sourceRoot,
      ...args,
    ], {
      encoding: 'utf8',
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        HOME: '/nonexistent-dsh-runtime-kit-home',
        XDG_CONFIG_HOME: '/nonexistent-dsh-runtime-kit-config',
        PATH: dirname(gitBin),
        LANG: 'C',
        LC_ALL: 'C',
      },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
    return result.stdout.trim()
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
      'The selected DSH source root is not an inspectable Git checkout',
    )
  }
}

/** @param {{sourceRoot: string, channel: string, gitBin: string, manifest: unknown}} input */
async function selectedCheckoutState(input) {
  if (!isAbsolute(input.sourceRoot)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
      'DSH source root must be an absolute path',
    )
  }
  const [sourceRoot, gitBin] = await Promise.all([
    realpath(input.sourceRoot),
    trustedGit(input.gitBin),
  ])
  const manifest = validateDshCompatibilityManifest(input.manifest)
  const selected = manifest.channels[input.channel]
  if (selected === undefined) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_CHANNEL_INVALID',
      'Unknown DSH compatibility channel: ' + input.channel,
    )
  }
  const topLevel = await realpath(resolve(await git(gitBin, sourceRoot, [
    'rev-parse', '--show-toplevel',
  ])))
  if (topLevel !== sourceRoot) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
      'DSH source root must be the exact Git checkout root',
    )
  }
  const revision = await git(gitBin, sourceRoot, ['rev-parse', 'HEAD'])
  const before = await git(gitBin, sourceRoot, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ])
  if (revision !== selected.revision) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_UNSELECTED_DSH_REVISION',
      'DSH ' + input.channel + ' revision does not match the reviewed selection',
      { channel: input.channel, expected_revision: selected.revision, actual_revision: revision },
    )
  }
  if (before.length !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
      'DSH compatibility checkout must remain clean',
      { channel: input.channel, revision },
    )
  }
  return Object.freeze({ sourceRoot, gitBin, manifest, revision, before })
}

/**
 * Authenticate an exact clean selected Git checkout before its build outputs exist.
 * @param {{sourceRoot: string, channel: string, gitBin: string, manifest: unknown}} input
 */
export async function inspectSelectedDshCheckoutIdentity(input) {
  const selected = await selectedCheckoutState(input)
  return Object.freeze({
    channel: input.channel,
    revision: selected.revision,
    upstream_checkout_clean: true,
  })
}

/**
 * Bind one built source inspection to an exact clean selected Git checkout.
 * @param {{sourceRoot: string, channel: string, gitBin: string, manifest: unknown}} input
 */
export async function inspectSelectedDshCheckout(input) {
  const selected = await selectedCheckoutState(input)
  const report = await inspectDshSource({
    sourceRoot: selected.sourceRoot,
    channel: input.channel,
    revision: selected.revision,
    clean: true,
    manifest: selected.manifest,
  })
  const after = await git(selected.gitBin, selected.sourceRoot, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ])
  if (after !== selected.before || after.length !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
      'DSH compatibility inspection changed the upstream checkout',
      { channel: input.channel, revision: selected.revision },
    )
  }
  return Object.freeze({ ...report, upstream_checkout_clean: true })
}
