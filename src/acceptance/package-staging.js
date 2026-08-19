// @ts-check

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'

import { AcceptanceError } from './contract.js'

/** @param {string} path */
async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Extract one package tree from the authenticated candidate artifact. A new
 * destination is mandatory so one candidate leg cannot supply files to the
 * next leg through a reused extraction.
 *
 * @param {{
 *   tarball:string,
 *   tarballSha256:string,
 *   destination:string,
 *   tarBin:string,
 *   env:Record<string,string>,
 *   label:string,
 * }} input
 */
export async function extractFreshPackage(input) {
  if (await digest(input.tarball) !== input.tarballSha256) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      'candidate package changed before ' + input.label + ' extraction',
    )
  }
  try {
    await mkdir(input.destination, { mode: 0o700 })
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      input.label + ' extraction destination already exists',
    )
  }
  const extracted = spawnSync(input.tarBin, [
    '-xf', input.tarball,
    '-C', input.destination,
    '--strip-components=1',
  ], {
    env: input.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (extracted.status !== 0 || extracted.error !== undefined) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      input.label + ' package extraction failed',
    )
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(input.destination + '/package.json', 'utf8'))
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      input.label + ' package manifest is invalid',
    )
  }
  if (manifest?.name !== '@sympoies/dsh-runtime-kit'
    || await digest(input.tarball) !== input.tarballSha256) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      input.label + ' package identity is invalid',
    )
  }
  return input.destination
}
