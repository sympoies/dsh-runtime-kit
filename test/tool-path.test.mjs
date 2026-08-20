import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createToolPath } from '../src/acceptance/tool-path.js'

test('tool path preserves a package-relative pnpm launcher runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-tool-path-'))
  try {
    const packageRoot = join(root, 'node_modules', 'pnpm')
    const launcherRoot = join(root, 'node_modules', '.bin')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(launcherRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, 'bin', 'pnpm.mjs'),
      "process.stdout.write('11.7.0\\n')\n",
    )
    const pnpm = join(launcherRoot, 'pnpm')
    writeFileSync(pnpm, `#!/bin/sh
basedir=$(dirname "$0")
exec node "$basedir/../pnpm/bin/pnpm.mjs" "$@"
`)
    chmodSync(pnpm, 0o755)

    const runRoot = join(root, 'run')
    mkdirSync(runRoot)
    const toolPath = await createToolPath(runRoot, {
      git: { path: process.execPath },
      npm: { path: process.execPath },
      pnpm: { path: pnpm },
      tar: { path: process.execPath },
    })
    const staged = join(toolPath, 'pnpm')
    assert.equal(lstatSync(staged).isSymbolicLink(), false)
    const result = spawnSync(staged, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: toolPath + ':' + process.env.PATH },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '11.7.0\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
