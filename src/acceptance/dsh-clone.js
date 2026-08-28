import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

import { AcceptanceError } from './contract.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * @param {string} gitBin
 * @param {string[]} args
 * @param {Record<string,string>} env
 * @param {string} label
 * @param {number} timeout
 * @param {number} maxBuffer
 */
function runGit(gitBin, args, env, label, timeout, maxBuffer) {
  const result = spawnSync(gitBin, args, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer,
  })
  if (result.status !== 0 || result.error !== undefined) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      label + ' failed',
    )
  }
}

/**
 * Clone one already-authenticated, canonical DSH source through the private
 * acceptance Git context and check out its pinned revision.
 *
 * @param {{
 *   sourceRoot:string,
 *   destination:string,
 *   revision:string,
 *   gitBin:string,
 *   env:Record<string,string>,
 *   uploadPackBin?:string,
 *   timeout?:number,
 *   maxBuffer?:number,
 * }} input
 */
export function cloneAuthenticatedDshSource(input) {
  const gitConfig = input.env.GIT_CONFIG_GLOBAL
  if (!isAbsolute(input.sourceRoot)
    || !isAbsolute(input.destination)
    || !isAbsolute(input.gitBin)
    || typeof gitConfig !== 'string'
    || !isAbsolute(gitConfig)
    || input.env.GIT_CONFIG_NOSYSTEM !== '1'
    || (input.uploadPackBin !== undefined && !isAbsolute(input.uploadPackBin))) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'authenticated DSH clone Git context is invalid',
    )
  }
  const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
  const maxBuffer = input.maxBuffer ?? DEFAULT_MAX_BUFFER
  const repositoryIdentity = resolve(input.sourceRoot, '.git')
  for (const [identity, label] of [
    [input.sourceRoot, 'authenticated DSH worktree trust configuration'],
    [repositoryIdentity, 'authenticated DSH repository trust configuration'],
  ]) {
    runGit(input.gitBin, [
      'config', '--file', gitConfig, '--add', 'safe.directory', identity,
    ], input.env, label, timeout, maxBuffer)
  }
  const cloneArgs = [
    'clone',
    '--no-hardlinks',
    '--no-checkout',
  ]
  if (input.uploadPackBin !== undefined) {
    cloneArgs.push('--upload-pack=' + input.uploadPackBin)
  }
  cloneArgs.push(input.sourceRoot, input.destination)
  runGit(
    input.gitBin,
    cloneArgs,
    input.env,
    'fresh DSH source clone',
    timeout,
    maxBuffer,
  )
  runGit(
    input.gitBin,
    ['-C', input.destination, 'checkout', '--detach', input.revision],
    input.env,
    'pinned DSH source checkout',
    timeout,
    maxBuffer,
  )
}
