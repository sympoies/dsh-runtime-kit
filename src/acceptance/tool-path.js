import { spawnSync } from 'node:child_process'
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { AcceptanceError } from './contract.js'

/** @param {string} value */
function shellLiteral(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Build a scenario PATH without relocating package-relative launchers.
 *
 * @param {string} root
 * @param {Record<string,{path:string}>} tools
 */
export async function createToolPath(root, tools) {
  const path = resolve(root, 'tool-path')
  await mkdir(path, { mode: 0o700 })
  const entries = {
    git: tools.git.path,
    npm: tools.npm.path,
    pnpm: tools.pnpm.path,
    tar: tools.tar.path,
    node: process.execPath,
  }
  for (const [name, target] of Object.entries(entries)) {
    const destination = resolve(path, name)
    await writeFile(
      destination,
      `#!/bin/sh\nexec ${shellLiteral(target)} "$@"\n`,
      { mode: 0o500, flag: 'wx' },
    )
    await chmod(destination, 0o500)
  }
  return path
}

/**
 * Resolve the content-addressed pnpm store prepared by the trusted acquisition
 * leg. pnpm's defaults are deliberately not used here: the hosted action
 * runtime and the credentialless candidate run under different homes.
 *
 * @param {{
 *   cwd:string,
 *   env:Record<string,string>,
 *   home:string,
 *   pnpmBin:string,
 *   maxBuffer?:number,
 *   timeout?:number,
 * }} input
 */
export async function discoverPreparedPnpmStore(input) {
  if (!isAbsolute(input.home)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'prepared pnpm store home must be absolute',
    )
  }
  const dataHome = resolve(input.home, '.local', 'share')
  const pnpmHome = resolve(dataHome, 'pnpm')
  const storeRoot = resolve(pnpmHome, 'store')
  const result = spawnSync(input.pnpmBin, [
    'store',
    'path',
    '--silent',
    '--store-dir', storeRoot,
  ], {
    cwd: input.cwd,
    env: {
      ...input.env,
      HOME: input.home,
      XDG_DATA_HOME: dataHome,
      PNPM_HOME: pnpmHome,
    },
    encoding: 'utf8',
    timeout: input.timeout,
    maxBuffer: input.maxBuffer,
  })
  if (result.status !== 0 || result.error !== undefined) {
    const details = Number.isInteger(result.status)
      ? { pnpm_exit_status: result.status }
      : {}
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      'pnpm prepared store discovery failed',
      details,
    )
  }
  const store = result.stdout.trim()
  if (!isAbsolute(store)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'pnpm store path is invalid',
    )
  }
  let canonicalRoot
  let canonicalStore
  try {
    [canonicalRoot, canonicalStore] = await Promise.all([
      realpath(storeRoot),
      realpath(store),
    ])
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'prepared pnpm store is unavailable',
    )
  }
  const storeVersion = relative(canonicalRoot, canonicalStore)
  if (!/^v[0-9]+$/u.test(storeVersion)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'pnpm store path is outside the prepared store root',
    )
  }
  return canonicalStore
}
