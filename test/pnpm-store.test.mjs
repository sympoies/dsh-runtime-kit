import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createToolPath,
  discoverPreparedPnpmStore,
} from '../src/acceptance/tool-path.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('source acceptance binds pnpm 11 action layout to the acquired store root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-pnpm-store-'))
  try {
    const home = join(root, 'home')
    const packageRoot = join(root, 'action', 'node_modules', 'pnpm')
    const launcherRoot = join(root, 'action', 'node_modules', '.bin')
    const storeRoot = join(home, '.local', 'share', 'pnpm', 'store')
    const store = join(storeRoot, 'v11')
    const log = join(root, 'pnpm.json')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(launcherRoot, { recursive: true })
    mkdirSync(store, { recursive: true })
    writeFileSync(
      join(packageRoot, 'bin', 'pnpm.mjs'),
      `import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const expectedHome = process.env.FAKE_EXPECTED_HOME
const expectedStoreRoot = resolve(expectedHome, '.local/share/pnpm/store')
const valid = JSON.stringify(process.argv.slice(2)) === JSON.stringify([
  'store', 'path', '--silent', '--store-dir', expectedStoreRoot,
]) && process.env.HOME === expectedHome
  && process.env.XDG_DATA_HOME === resolve(expectedHome, '.local/share')
  && process.env.PNPM_HOME === resolve(expectedHome, '.local/share/pnpm')
writeFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ valid, args: process.argv.slice(2) }))
if (!valid) process.exit(64)
process.stdout.write(resolve(expectedStoreRoot, 'v11') + '\\n')
`,
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
    const actual = await discoverPreparedPnpmStore({
      cwd: projectRoot,
      env: {
        HOME: join(runRoot, 'isolated-home'),
        PATH: toolPath + ':/usr/bin:/bin',
        FAKE_EXPECTED_HOME: home,
        FAKE_PNPM_LOG: log,
      },
      home,
      pnpmBin: join(toolPath, 'pnpm'),
    })

    assert.equal(actual, store)
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), {
      valid: true,
      args: ['store', 'path', '--silent', '--store-dir', storeRoot],
    })
    const runner = readFileSync(join(projectRoot, 'scripts', 'run-acceptance.mjs'), 'utf8')
    assert.match(runner, /discoverPreparedPnpmStore/u)
    assert.match(
      runner,
      /'--offline',\s*'--frozen-lockfile',\s*'--trust-lockfile',\s*'--ignore-scripts'/u,
      'the authenticated DSH lockfile must not trigger registry policy lookups offline',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
