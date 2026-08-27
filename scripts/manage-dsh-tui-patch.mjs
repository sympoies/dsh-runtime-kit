#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DshTuiPatchError, manageDshTuiPatch } from '../src/compat/dsh-tui-patch.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = 'usage: manage-dsh-tui-patch --action check|apply|reverse --package-root ABSOLUTE [--git-bin ABSOLUTE]'

function argumentsFromCli() {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        action: { type: 'string' },
        'package-root': { type: 'string' },
        'git-bin': { type: 'string', default: '/usr/bin/git' },
      },
    })
  } catch {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
      usage,
    )
  }
  const action = parsed.values.action
  const packageRoot = parsed.values['package-root']
  const gitBin = parsed.values['git-bin']
  if (!['check', 'apply', 'reverse'].includes(action ?? '')
    || typeof packageRoot !== 'string' || !isAbsolute(packageRoot)
    || typeof gitBin !== 'string' || !isAbsolute(gitBin)) {
    throw new DshTuiPatchError(
      'DSH_RUNTIME_KIT_DSH_TUI_PATCH_ARGUMENT_INVALID',
      usage,
    )
  }
  return { action, packageRoot, gitBin }
}

try {
  const input = argumentsFromCli()
  const manifest = JSON.parse(
    await readFile(resolve(projectRoot, 'compatibility', 'dsh-tui-patches.json'), 'utf8'),
  )
  const receipt = await manageDshTuiPatch({
    ...input,
    patchRoot: projectRoot,
    manifest,
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`)
} catch (error) {
  const failure = error instanceof DshTuiPatchError
    ? error
    : new DshTuiPatchError(
        'DSH_RUNTIME_KIT_DSH_TUI_PATCH_FAILED',
        'Unexpected DSH TUI patch lifecycle failure',
      )
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { message: failure.message, ...failure.diagnostic },
  })}\n`)
  process.exitCode = 1
}
