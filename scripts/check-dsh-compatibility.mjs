#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DshCompatibilityError,
  validateDshCompatibilityManifest,
} from '../src/compat/contract.js'
import { inspectSelectedDshCheckout } from '../src/compat/git-checkout.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'source-root': { type: 'string' },
      channel: { type: 'string' },
      format: { type: 'string', default: 'json' },
      'git-bin': { type: 'string', default: '/usr/bin/git' },
      },
    })
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'compatibility arguments are invalid',
    )
  }
  if (typeof parsed.values['source-root'] !== 'string'
    || !isAbsolute(parsed.values['source-root'])
    || !['pinned', 'upstream-next'].includes(parsed.values.channel ?? '')
    || parsed.values.format !== 'json'
    || typeof parsed.values['git-bin'] !== 'string'
    || !isAbsolute(parsed.values['git-bin'])) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'usage: check-dsh-compatibility --source-root ABSOLUTE --channel pinned|upstream-next --format json',
    )
  }
  return {
    sourceRoot: resolve(parsed.values['source-root']),
    channel: parsed.values.channel,
    gitBin: parsed.values['git-bin'],
  }
}

async function main() {
  const input = parseCli(process.argv.slice(2))
  const manifest = validateDshCompatibilityManifest(JSON.parse(
    await readFile(resolve(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
  ))
  const report = await inspectSelectedDshCheckout({ ...input, manifest })
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.compatibility-check.v1',
    ok: true,
    data: report,
  })}\n`)
}

try {
  await main()
} catch (error) {
  const failure = error instanceof DshCompatibilityError
    ? error
    : new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_CHECK_FAILED',
        'DSH compatibility inspection failed',
      )
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.compatibility-check.v1',
    ok: false,
    error: failure.diagnostic,
  })}\n`)
  process.exitCode = 1
}
