#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DshPatchError, manageDshPatch } from '../src/compat/dsh-patch.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function argumentsFromCli() {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        action: { type: 'string' },
        'source-root': { type: 'string' },
        'git-bin': { type: 'string', default: '/usr/bin/git' },
      },
    })
  } catch {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'usage: manage-dsh-patch --action check|apply|reverse --source-root ABSOLUTE [--git-bin ABSOLUTE]',
    )
  }
  const action = parsed.values.action
  const sourceRoot = parsed.values['source-root']
  const gitBin = parsed.values['git-bin']
  if (!['check', 'apply', 'reverse'].includes(action ?? '')
    || typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)
    || typeof gitBin !== 'string' || !isAbsolute(gitBin)) {
    throw new DshPatchError(
      'DSH_RUNTIME_KIT_DSH_PATCH_ARGUMENT_INVALID',
      'usage: manage-dsh-patch --action check|apply|reverse --source-root ABSOLUTE [--git-bin ABSOLUTE]',
    )
  }
  return { action, sourceRoot, gitBin }
}

try {
  const input = argumentsFromCli()
  const manifest = JSON.parse(
    await readFile(resolve(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
  )
  const receipt = await manageDshPatch({
    ...input,
    patchRoot: projectRoot,
    manifest,
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`)
} catch (error) {
  const failure = error instanceof DshPatchError
    ? error
    : new DshPatchError(
        'DSH_RUNTIME_KIT_DSH_PATCH_FAILED',
        'Unexpected DSH patch lifecycle failure',
      )
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { message: failure.message, ...failure.diagnostic },
  })}\n`)
  process.exitCode = 1
}
