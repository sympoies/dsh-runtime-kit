import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The runtime no longer depends on the agent-docs companion: validation
// contracts belong to agent-hook's finish-line service, and the intent
// activation, prerequisite, and catalog-audit surfaces are retired.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
// The packaged docs home directory keeps its name; only the companion goes.
const COMPANION = /agent-docs-bin|AGENT_DOCS_BIN|\bagentDocs\b|cli\.agent-docs\.|agent-docs-version|agent-docs\.(?:session|audit)/u

function sources(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name)
    if (entry.isDirectory()) return sources(child)
    return /\.(?:ts|js|mjs|yml|yaml|json)$/u.test(entry.name) ? [child] : []
  })
}

// Lines that name agent-docs only to read packages released before this
// retirement: the acceptance rollback baseline's companion tuple, the inert
// legacy lifecycle declaration an older target package may still carry, and
// the retired --agent-docs-bin flag that older provisioning still passes and
// the deploy dispatcher and acceptance driver accept and ignore.
const LEGACY_PACKAGE_LINES: Record<string, number> = {
  'src/acceptance/contract.ts': 1,
  'scripts/run-acceptance.ts': 2,
  'src/deploy/index.ts': 1,
  'src/operations/index.ts': 2,
}

test('no agent-docs executable is spawned, resolved, or authenticated by shipped code', () => {
  const offenders = [...sources('src'), ...sources('bin'), ...sources('scripts'), 'index.ts', 'cordis.patch.yml']
    .map(path => relative(ROOT, join(ROOT, path)))
    .filter(path => read(path).split('\n').filter(line => COMPANION.test(line)
      || (/['"`]agent-docs['"`]/u.test(line) && !/\b(?:join|packageAsset)\(/u.test(line))).length
      > (LEGACY_PACKAGE_LINES[path] ?? 0))
  assert.deepEqual(offenders, [])
})

test('the policy bundle no longer binds the retired pre-edit intent gate', () => {
  assert.doesNotMatch(read('policy/dsh-runtime-kit-v1.toml'), /pre-edit-intent-gate/u)
})

test('agent-docs is not a lifecycle dependency, health probe, or authenticated companion', () => {
  const lifecycle = JSON.parse(read('compatibility/profile-lifecycle.json'))
  assert.deepEqual(lifecycle.dependencies, ['agent-hook'])
  assert.ok(!lifecycle.health_probes.includes('agent-docs-version'))
  const nils = JSON.parse(read('compatibility/nils-cli.json'))
  assert.equal(nils.release.artifacts['agent-docs'], undefined)
  for (const platform of Object.values(nils.release.platforms) as Array<{artifacts: Record<string, unknown>}>) {
    assert.equal(platform.artifacts['agent-docs'], undefined)
  }
  assert.ok(nils.commands.every((command: {binary: string}) => command.binary !== 'agent-docs'))
  assert.ok(!JSON.parse(read('package.json')).scripts['test:agent-docs-catalog'])
  assert.equal(existsSync(join(ROOT, 'src/prerequisite/index.ts')), false)
  assert.equal(existsSync(join(ROOT, 'src/context/nils-context.ts')), false)
})

test('the kit neither reads nor sets the retired agent-docs environment', () => {
  const retired = /DSH_RUNTIME_KIT_AGENT_DOCS_(?:BIN|HOME|STATE_HOME)/u
  const offenders = [...sources('src'), ...sources('bin'), ...sources('scripts'), 'index.ts', 'cordis.patch.yml']
    .filter(path => retired.test(read(path)))
  assert.deepEqual(offenders, [])
})
