import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  loadAcceptanceFixtureManifest,
  renewAcceptanceFixtureLease,
  runAcceptanceFixture,
} from '../dist/src/acceptance/fixtures.js'

const ROOT = resolve(import.meta.dirname, '..')

test('package ships a complete executable #D fixture provider', () => {
  const fixtureManifest = join(ROOT, 'compatibility', 'acceptance-fixtures.json')
  const fixtureSource = join(ROOT, 'src', 'acceptance', 'fixtures.ts')
  const fixtureBin = join(ROOT, 'bin', 'dsh-runtime-kit-acceptance-fixture.ts')
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  assert.equal(existsSync(fixtureManifest), true, 'missing packaged fixture manifest')
  assert.equal(existsSync(fixtureSource), true, 'missing packaged fixture implementation')
  assert.equal(existsSync(fixtureBin), true, 'missing packaged fixture executable')
  assert.equal(
    packageJson.bin['dsh-runtime-kit-acceptance-fixture'],
    './dist/bin/dsh-runtime-kit-acceptance-fixture.js',
  )
})

test('fixture manifest owns every #D row exactly once with bounded inverse recipes', () => {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'compatibility', 'acceptance-scenarios.json'), 'utf8'))
  const manifest = loadAcceptanceFixtureManifest()
  const expected = catalog.scenarios
    .filter((row: { owner: { program_child: string } }) => row.owner.program_child === '#D')
    .map((row: { id: string }) => row.id)
    .sort()
  const observed = manifest.families.flatMap(family => family.scenario_ids).sort()

  assert.equal(manifest.schema_version, 'dsh-runtime-kit.acceptance-fixtures.v1')
  assert.equal(manifest.families.length, 12)
  assert.deepEqual(observed, expected)
  for (const family of manifest.families) {
    assert.deepEqual(family.transitions, {
      prepare: ['stage-fixture'],
      induce: ['stage-fixture', 'induce-failure'],
      recover: ['recover-failure'],
      cleanup: ['cleanup-fixture'],
    })
  }
})

test('fixture manifest rejects unknown keys, unsafe paths, and incomplete inverse recipes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-manifest-'))
  chmodSync(root, 0o700)
  const original = JSON.parse(readFileSync(join(ROOT, 'compatibility', 'acceptance-fixtures.json'), 'utf8'))
  const cases = [
    { name: 'unknown-key', mutate: (value: any) => { value.families[0].unexpected = true } },
    { name: 'unsafe-path', mutate: (value: any) => { value.families[0].fixture_files[0] = '../escape' } },
    { name: 'missing-recovery', mutate: (value: any) => { value.families[0].transitions.recover = [] } },
    { name: 'unsupported-operation', mutate: (value: any) => { value.families[0].transitions.prepare = ['shell'] } },
  ]
  for (const item of cases) {
    const value = structuredClone(original)
    item.mutate(value)
    const path = join(root, `${item.name}.json`)
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    assert.throws(() => loadAcceptanceFixtureManifest(path), /fixture manifest/u, item.name)
  }
})

test('provider stages, induces, recovers, and cleans one scenario without touching caller files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-transitions-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  writeFileSync(join(workdir, 'caller-owned.txt'), 'retain\n', { mode: 0o600 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    phase: 'deliberate-failure' as const,
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.non-git',
    profile: 'headless-automatic-prerequisite',
    workdir,
    dshHome,
  }

  const induced = runAcceptanceFixture({ ...input, stage: 'induce' })
  assert.equal(induced.data.status, 'pass')
  assert.equal(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), '[[document]\n')
  assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), true)
  assert.equal(statSync(join(workdir, 'fixture-validation.mjs')).mode & 0o777, 0o700)
  assert.match(
    readFileSync(join(workdir, 'PROJECT_DEV_EDIT.md'), 'utf8'),
    /Follow the current repository instructions/u,
  )
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)
  assert.equal(readFileSync(join(workdir, 'prerequisite-marker.txt'), 'utf8'), 'project-dev-prerequisite-ready\n')
  assert.equal(existsSync(join(workdir, 'prerequisite.txt')), false)
  assert.equal(
    readFileSync(join(workdir, '.dsh-acceptance', 'protected', '.fixture-root'), 'utf8'),
    'dsh-acceptance-protected-root\n',
  )
  assert.equal(existsSync(join(workdir, '.dsh-acceptance', 'failure.json')), true)

  const recovered = runAcceptanceFixture({ ...input, stage: 'recover' })
  assert.equal(recovered.data.status, 'pass')
  assert.match(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), /context = "project-dev"/u)
  assert.match(
    readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'),
    /commands = \["\.\/fixture-validation\.mjs"\]/u,
  )
  assert.equal(existsSync(join(workdir, '.dsh-acceptance', 'failure.json')), false)
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)

  const cleaned = runAcceptanceFixture({ ...input, stage: 'cleanup' })
  assert.equal(cleaned.data.status, 'pass')
  assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)
  assert.equal(existsSync(join(workdir, 'prerequisite-marker.txt')), true)
  assert.equal(readFileSync(join(workdir, 'caller-owned.txt'), 'utf8'), 'retain\n')
  assert.equal(cleaned.data.evidence.every(row => !row.reference.startsWith('/') && !row.reference.includes('..')), true)
})

test('provider refuses to replace caller-owned fixture paths and symlinked roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-collision-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  writeFileSync(join(workdir, 'AGENT_DOCS.toml'), 'caller\n', { mode: 0o600 })

  assert.throws(() => runAcceptanceFixture({
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    stage: 'prepare',
    phase: 'success',
    family: 'restricted-role',
    scenarioId: 'restricted-role.non-git',
    profile: 'headless-restricted-role',
    workdir,
    dshHome,
  }), /caller-owned/u)
  assert.equal(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), 'caller\n')
  assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)
  assert.equal(existsSync(join(workdir, '.dsh-acceptance')), false)

  const linkedHome = join(root, 'linked-home')
  const anotherWorkdir = join(root, 'another-workdir')
  mkdirSync(anotherWorkdir, { mode: 0o700 })
  symlinkSync(dshHome, linkedHome)
  assert.throws(() => runAcceptanceFixture({
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    stage: 'prepare',
    phase: 'success',
    family: 'restricted-role',
    scenarioId: 'restricted-role.non-git',
    profile: 'headless-restricted-role',
    workdir: anotherWorkdir,
    dshHome: linkedHome,
  }), /real directory/u)
})

test('automatic prerequisite source scenarios register the focused task validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-source-validation-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })

  runAcceptanceFixture({
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    stage: 'prepare',
    phase: 'success',
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.git-repo',
    profile: 'headless-source-validation',
    workdir,
    dshHome,
  })

  const catalog = readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8')
  assert.match(
    catalog,
    /commands = \["\.\/fixture-validation\.mjs","node fixture-source\.test\.mjs"\]/u,
  )
})

test('all twelve typed failure recipes induce and recover exact inputs', { concurrency: false }, async () => {
  const manifest = loadAcceptanceFixtureManifest()
  for (const family of manifest.families) {
    const root = await mkdtemp(join(tmpdir(), `acceptance-fixture-${family.id}-`))
    const workdir = join(root, 'workdir')
    const dshHome = join(root, 'dsh-home')
    const companions = join(dshHome, 'companions')
    const hookState = join(dshHome, 'hook-state')
    mkdirSync(workdir, { mode: 0o700 })
    mkdirSync(dshHome, { mode: 0o700 })
    mkdirSync(companions, { mode: 0o700 })
    mkdirSync(hookState, { mode: 0o700 })
    const observedRequests = join(hookState, 'requests.jsonl')
    writeFileSync(join(workdir, 'caller-owned.txt'), 'retain\n', { mode: 0o600 })
    const hook = join(companions, 'agent-hook')
    writeFileSync(hook, `#!${process.execPath}
const fs = await import('node:fs')
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const action = process.argv.at(-3)
fs.appendFileSync(${JSON.stringify(observedRequests)}, JSON.stringify({ action, request }) + '\\n')
process.stdout.write(JSON.stringify({ ok: true, data: action === 'release' ? {
  schema_version: 'agent-hook.workspace-lease.release-result.v2', status: 'released'
} : action === 'renew' ? {
  schema_version: 'agent-hook.workspace-lease.renew-result.v2', kind: 'renewed', renew_after_ms: 10000
} : {
  schema_version: 'agent-hook.workspace-lease.bind-result.v2',
  binding_id: 'fixture-binding', workspace_id: 'fixture-workspace', generation: 'fixture-generation',
  session_id: request.session_id
} }) + '\\n')
`, { mode: 0o700 })
    const hookConfig = join(companions, 'config.toml')
    const hookPolicy = join(companions, 'policy.toml')
    writeFileSync(hookConfig, 'fixture = true\n', { mode: 0o600 })
    writeFileSync(hookPolicy, 'fixture = true\n', { mode: 0o600 })
    const dispatcher = join(workdir, '.agents', 'scripts', 'deploy.sh')
    const priorHook = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN
    const priorHookConfig = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG
    const priorHookPolicy = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY
    const priorHookState = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN = hook
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG = hookConfig
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY = hookPolicy
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR = hookState
    const input = {
      schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
      phase: 'deliberate-failure' as const,
      family: family.id,
      scenarioId: family.id === 'workspace-identity'
        ? 'workspace-identity.non-git'
        : family.scenario_ids[0]!,
      profile: `headless-${family.id}`,
      workdir,
      dshHome,
    }
    try {
      if (family.id === 'workspace-identity') {
        const successInput = {
          ...input,
          stage: 'prepare' as const,
          phase: 'success' as const,
        }
        runAcceptanceFixture(successInput)
        const request = JSON.parse(readFileSync(join(workdir, 'workspace-request.json'), 'utf8'))
        assert.equal(existsSync(request.target), true, 'workspace success prepare must establish its leased target')
        runAcceptanceFixture({ ...successInput, stage: 'cleanup' })
      }
      runAcceptanceFixture({ ...input, stage: 'induce' })
      assert.equal(existsSync(join(workdir, '.dsh-acceptance', 'failure.json')), true, family.id)
      if (family.id === 'workspace-identity') {
        assert.equal(existsSync(join(workdir, '.git')), true)
        assert.equal(renewAcceptanceFixtureLease(input), 10_000)
      }
      runAcceptanceFixture({ ...input, stage: 'recover' })
      if (family.id === 'workspace-identity') {
        assert.equal(existsSync(join(workdir, '.git')), false)
        const leaseBinds = readFileSync(observedRequests, 'utf8').trim().split('\n')
          .map(line => JSON.parse(line))
          .filter(row => row.action === 'bind')
        assert.equal(leaseBinds.at(-1).request.cwd, workdir)
        const request = JSON.parse(readFileSync(join(workdir, 'workspace-request.json'), 'utf8'))
        assert.equal(request.target, join(workdir, 'leased.txt'))
      }
      if (family.id === 'deploy-dispatcher') {
        assert.notEqual(readFileSync(dispatcher, 'utf8'), '', family.id)
        assert.notEqual(statSync(dispatcher).mode & 0o111, 0, family.id)
      }
      runAcceptanceFixture({ ...input, stage: 'cleanup' })
      assert.equal(readFileSync(join(workdir, 'caller-owned.txt'), 'utf8'), 'retain\n', family.id)
      assert.match(readFileSync(hook, 'utf8'), /workspace-lease\.bind-result\.v2/u, family.id)
      assert.equal(existsSync(dispatcher), family.id === 'deploy-dispatcher', family.id)
      assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false, family.id)
    } finally {
      if (priorHook === undefined) delete process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN
      else process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN = priorHook
      if (priorHookConfig === undefined) delete process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG
      else process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG = priorHookConfig
      if (priorHookPolicy === undefined) delete process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY
      else process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY = priorHookPolicy
      if (priorHookState === undefined) delete process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR
      else process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR = priorHookState
    }
  }
})

test('fixture state is independently bound to each canonical workdir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-state-binding-'))
  const workdir = join(root, 'workdir')
  const otherWorkdir = join(root, 'other-workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(otherWorkdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    phase: 'deliberate-failure' as const,
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.non-git',
    profile: 'headless-state-binding',
    workdir,
    dshHome,
  }
  runAcceptanceFixture({ ...input, stage: 'induce' })
  writeFileSync(join(otherWorkdir, 'AGENT_DOCS.toml'), 'caller-owned\n', { mode: 0o600 })
  runAcceptanceFixture({ ...input, workdir: otherWorkdir, stage: 'cleanup' })
  assert.equal(readFileSync(join(otherWorkdir, 'AGENT_DOCS.toml'), 'utf8'), 'caller-owned\n')
  assert.equal(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), '[[document]\n')
  runAcceptanceFixture({ ...input, stage: 'recover' })
  runAcceptanceFixture({ ...input, stage: 'cleanup' })
})

test('success evidence remains attestable and is reset only for the paired failure phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-phase-pair-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const base = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.non-git',
    profile: 'headless-phase-pair',
    workdir,
    dshHome,
  }
  runAcceptanceFixture({ ...base, stage: 'prepare', phase: 'success' })
  writeFileSync(join(workdir, 'fixture-source.mjs'), 'externally-attested-task-result\n', { mode: 0o600 })
  runAcceptanceFixture({ ...base, stage: 'cleanup', phase: 'success' })
  assert.equal(
    readFileSync(join(workdir, 'fixture-source.mjs'), 'utf8'),
    'externally-attested-task-result\n',
  )

  runAcceptanceFixture({ ...base, stage: 'induce', phase: 'deliberate-failure' })
  assert.equal(
    readFileSync(join(workdir, 'fixture-source.mjs'), 'utf8'),
    'export const plusOne = value => value\n',
  )
  assert.equal(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), '[[document]\n')
  assert.throws(
    () => runAcceptanceFixture({ ...base, stage: 'prepare', phase: 'success' }),
    /active fixture phase does not match/u,
  )
})

test('a cleaned fixture may replay the same phase after a harness-level failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-replay-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    stage: 'prepare' as const,
    phase: 'success' as const,
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.git-repo',
    profile: 'headless-replay',
    workdir,
    dshHome,
  }

  runAcceptanceFixture(input)
  runAcceptanceFixture({ ...input, stage: 'cleanup' })
  const replay = runAcceptanceFixture(input)

  assert.equal(replay.data.status, 'pass')
  assert.equal(replay.data.phase, 'success')
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)
})

test('prepare may follow idempotent cleanup when no fixture was staged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-empty-cleanup-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    phase: 'success' as const,
    family: 'automatic-prerequisite',
    scenarioId: 'automatic-prerequisite.git-repo',
    profile: 'headless-empty-cleanup',
    workdir,
    dshHome,
  }

  runAcceptanceFixture({ ...input, stage: 'cleanup' })
  const prepared = runAcceptanceFixture({ ...input, stage: 'prepare' })

  assert.equal(prepared.data.status, 'pass')
  assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), true)
})

test('fixture staging rejects descendant symlinks before creating outside directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-symlink-parent-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  const external = join(root, 'external')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  mkdirSync(external, { mode: 0o700 })
  symlinkSync(external, join(workdir, '.agents'))
  assert.throws(() => runAcceptanceFixture({
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    stage: 'prepare',
    phase: 'success',
    family: 'deploy-dispatcher',
    scenarioId: 'deploy-dispatcher.git-repo',
    profile: 'headless-symlink-parent',
    workdir,
    dshHome,
  }), /fixture parent is unsafe/u)
  assert.equal(existsSync(join(external, 'scripts')), false)
})
