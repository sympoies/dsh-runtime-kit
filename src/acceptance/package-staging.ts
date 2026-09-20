import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { AcceptanceError } from './contract.js'

async function digest(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function requireDeclaredRuntimeEntrypoints(
  root: string,
  manifest: Record<string, unknown>,
  label: string,
) {
  const bin = manifest.bin
  const targets = [
    manifest.main,
    ...(bin !== null && typeof bin === 'object' && !Array.isArray(bin)
      ? Object.values(bin)
      : []),
  ]
  if (typeof manifest.main !== 'string'
    || bin === null || typeof bin !== 'object' || Array.isArray(bin)
    || Object.keys(bin).length === 0
    || targets.some(target => typeof target !== 'string')) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      label + ' package runtime entrypoint declarations are invalid',
    )
  }
  for (const target of targets as string[]) {
    const path = resolve(root, target)
    if (!target.startsWith('./') || (path !== root && !path.startsWith(root + sep))) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        label + ' declared runtime entrypoint is unavailable',
      )
    }
    try {
      const details = await lstat(path)
      if (details.isSymbolicLink() || !details.isFile()) throw new Error('invalid runtime entrypoint')
    } catch {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        label + ' declared runtime entrypoint is unavailable',
      )
    }
  }
}

/**
 * Extract one package tree from the authenticated candidate artifact. A new
 * destination is mandatory so one candidate leg cannot supply files to the
 * next leg through a reused extraction.
 */
export async function extractFreshPackage(input: {
    tarball:string,
    tarballSha256:string,
    destination:string,
    tarBin:string,
    env:Record<string,string>,
    label:string,
  }) {
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
  await requireDeclaredRuntimeEntrypoints(input.destination, manifest, input.label)
  return input.destination
}
