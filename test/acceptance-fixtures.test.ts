import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Acceptance Fixture',
      GIT_AUTHOR_EMAIL: 'acceptance-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Acceptance Fixture',
      GIT_COMMITTER_EMAIL: 'acceptance-fixture@example.invalid',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function managedWorktree(primary: string, child: string, branch: string) {
  mkdirSync(primary, { recursive: true, mode: 0o700 })
  git(primary, ['init', '--initial-branch', 'main'])
  writeFileSync(join(primary, 'seed.txt'), 'seed\n', { mode: 0o600 })
  git(primary, ['add', '--', 'seed.txt'])
  const tree = git(primary, ['write-tree'])
  const commit = git(primary, ['commit-tree', tree, '-m', 'acceptance fixture seed'])
  git(primary, ['update-ref', 'refs/heads/main', commit])
  git(primary, ['reset', '--hard', commit])
  git(primary, ['worktree', 'add', '-b', branch, child, 'HEAD'])
}

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
  const inducedValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
    cwd: workdir,
    encoding: 'utf8',
  })
  assert.equal(inducedValidation.status, 0, inducedValidation.stderr)

  const recovered = runAcceptanceFixture({ ...input, stage: 'recover' })
  assert.equal(recovered.data.status, 'pass')
  assert.match(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), /context = "project-dev"/u)
  assert.match(
    readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'),
    /commands = \["\.\/fixture-validation\.mjs"\]/u,
  )
  assert.equal(existsSync(join(workdir, '.dsh-acceptance', 'failure.json')), false)
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)
  const recoveredValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
    cwd: workdir,
    encoding: 'utf8',
  })
  assert.equal(recoveredValidation.status, 0, recoveredValidation.stderr)
  assert.equal(recoveredValidation.stdout, 'acceptance-fixture-ok\n')

  const cleaned = runAcceptanceFixture({ ...input, stage: 'cleanup' })
  assert.equal(cleaned.data.status, 'pass')
  assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)
  assert.equal(existsSync(join(workdir, 'fixture-source.mjs')), true)
  assert.equal(existsSync(join(workdir, 'prerequisite-marker.txt')), true)
  assert.equal(readFileSync(join(workdir, 'caller-owned.txt'), 'utf8'), 'retain\n')
  assert.equal(cleaned.data.evidence.every(row => !row.reference.startsWith('/') && !row.reference.includes('..')), true)
})

test('authoritative fixture validation emits a typed failure only while its fault is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-authoritative-failure-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    phase: 'deliberate-failure' as const,
    family: 'authoritative-acceptance',
    scenarioId: 'authoritative-acceptance.non-git',
    profile: 'headless-authoritative-acceptance',
    workdir,
    dshHome,
  }

  runAcceptanceFixture({ ...input, stage: 'induce' })
  const induced = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
    cwd: workdir,
    encoding: 'utf8',
  })
  assert.equal(induced.status, 1)
  assert.deepEqual(JSON.parse(induced.stderr), {
    schema_version: 'cli.dsh-runtime-kit.acceptance-fixture.v1',
    ok: false,
    error: {
      code: 'acceptance-fixture-induced-failure',
      message: 'The authenticated fixture fault is active.',
    },
  })

  runAcceptanceFixture({ ...input, stage: 'recover' })
  const recovered = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
    cwd: workdir,
    encoding: 'utf8',
  })
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(recovered.stdout, 'acceptance-fixture-ok\n')
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

test('governed request gives the harness one concrete ordered operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-governed-request-'))
  const workdir = join(root, 'workdir')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const input = {
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
    phase: 'deliberate-failure' as const,
    family: 'governed-commit',
    scenarioId: 'governed-commit.managed-worktree',
    profile: 'headless-governed-request',
    workdir,
    dshHome,
  }

  runAcceptanceFixture({ ...input, stage: 'induce' })
  const induced = JSON.parse(readFileSync(join(workdir, 'governed-request.json'), 'utf8'))
  assert.deepEqual(induced.sequence, ['validate', 'governed-commit'])
  assert.equal(induced.expected_outcome, 'stop-on-governed-precondition-refusal')
  assert.deepEqual(induced.edit, { path: 'governed.txt', content: 'committed\n' })
  assert.equal(induced.stage_command, 'git add -- governed.txt')
  assert.equal(induced.validation_command, './fixture-validation.mjs')
  assert.deepEqual(induced.commit, {
    tool: 'runtime_kit_governed_commit',
    type: 'test',
    scope: 'acceptance',
    subject: 'prove governed acceptance',
    body_bullets: ['Commit only the bounded acceptance fixture output.'],
    expected_head_command: 'git rev-parse HEAD',
  })

  runAcceptanceFixture({ ...input, stage: 'recover' })
  const recovered = JSON.parse(readFileSync(join(workdir, 'governed-request.json'), 'utf8'))
  assert.deepEqual(recovered.sequence, ['edit', 'stage', 'governed-commit', 'validate'])
  assert.equal(recovered.expected_outcome, 'signed-feature-commit')
  assert.deepEqual(recovered.edit, induced.edit)
  assert.deepEqual(recovered.commit, induced.commit)
})

test('managed subagent assignment uses the exact registered child validation command', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-managed-validation-'))
  const workdir = join(root, 'workdir')
  const childWorktree = join(root, 'child-worktree')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(dshHome, { mode: 0o700 })
  managedWorktree(workdir, childWorktree, 'managed-validation-child')
  const names = [
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY',
  ] as const
  const prior = new Map(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, {
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: childWorktree,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY: 'sympoies/acceptance-fixture',
  })

  try {
    runAcceptanceFixture({
      schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
      stage: 'prepare',
      phase: 'success',
      family: 'managed-subagent-workspace',
      scenarioId: 'managed-subagent-workspace.git-repo',
      profile: 'headless-managed-validation',
      workdir,
      dshHome,
    })

    const assignment = JSON.parse(readFileSync(join(workdir, 'main-agent-assignment.json'), 'utf8'))
    const objective = JSON.parse(readFileSync(join(workdir, 'main-agent-objective.json'), 'utf8'))
    assert.match(assignment.task.objective, /run the exact command \.\/fixture-validation\.mjs/u)
    assert.match(assignment.task.objective, /without a wrapper, prefix, suffix, or compound command/u)
    assert.doesNotMatch(assignment.task.objective, /run node fixture-validation\.mjs/u)
    assert.deepEqual(objective.done_criteria, [
      'child worktree differs from the primary',
      'child result accepted',
      'controller review recorded in the primary',
      'lane closed',
    ])
    assert.deepEqual(objective.constraints, [
      'no commit',
      'no delivery',
      'leave the primary implementation target unchanged',
    ])
    assert.equal(readFileSync(join(workdir, 'controller-review.txt'), 'utf8'), 'review-pending\n')

    const primaryValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: childWorktree,
      },
    })
    assert.notEqual(primaryValidation.status, 0)
    writeFileSync(join(workdir, 'controller-review.txt'), 'review-complete\n\n', { mode: 0o600 })
    const malformedValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: childWorktree,
      },
    })
    assert.notEqual(malformedValidation.status, 0)
    writeFileSync(join(workdir, 'controller-review.txt'), 'review-complete\n', { mode: 0o600 })
    const exactValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
        DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: childWorktree,
      },
    })
    assert.equal(exactValidation.status, 0, exactValidation.stderr)
    assert.equal(exactValidation.stdout, 'acceptance-fixture-ok\n')
    assert.equal(readFileSync(join(childWorktree, 'subagent-target.txt'), 'utf8'), 'subagent-before\n')
    assert.equal(existsSync(join(childWorktree, 'AGENT_DOCS.toml')), true)
    assert.equal(existsSync(join(childWorktree, 'fixture-validation.mjs')), true)

    writeFileSync(join(childWorktree, 'subagent-target.txt'), 'subagent-after\n', { mode: 0o600 })
    runAcceptanceFixture({
      schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
      stage: 'cleanup',
      phase: 'success',
      family: 'managed-subagent-workspace',
      scenarioId: 'managed-subagent-workspace.git-repo',
      profile: 'headless-managed-validation',
      workdir,
      dshHome,
    })
    assert.equal(readFileSync(join(childWorktree, 'subagent-target.txt'), 'utf8'), 'subagent-after\n')
    runAcceptanceFixture({
      schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
      stage: 'prepare',
      phase: 'success',
      family: 'managed-subagent-workspace',
      scenarioId: 'managed-subagent-workspace.git-repo',
      profile: 'headless-managed-validation',
      workdir,
      dshHome,
    })
    assert.equal(readFileSync(join(workdir, 'controller-review.txt'), 'utf8'), 'review-pending\n')
    assert.equal(readFileSync(join(childWorktree, 'subagent-target.txt'), 'utf8'), 'subagent-before\n')
  } finally {
    for (const name of names) {
      const value = prior.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('managed subagent distinct retry workdir selects its own host-issued topology', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-managed-retry-topology-'))
  const initialWorkdir = join(root, 'initial-primary')
  const initialChild = join(root, 'initial-child')
  const retryWorkdir = join(root, 'retry-primary')
  const retryChild = join(root, 'retry-child')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(dshHome, { mode: 0o700 })
  managedWorktree(initialWorkdir, initialChild, 'managed-initial-child')
  managedWorktree(retryWorkdir, retryChild, 'managed-retry-child')
  const names = [
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY',
  ] as const
  const prior = new Map(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, {
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: initialWorkdir,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: initialChild,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY: retryWorkdir,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE: retryChild,
    DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY: 'sympoies/acceptance-fixture',
  })

  try {
    const input = {
      schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1' as const,
      phase: 'deliberate-failure' as const,
      family: 'managed-subagent-workspace',
      scenarioId: 'managed-subagent-workspace.managed-worktree',
      profile: 'headless-managed-retry-topology',
      workdir: retryWorkdir,
      dshHome,
    }
    runAcceptanceFixture({ ...input, stage: 'induce' })
    runAcceptanceFixture({ ...input, stage: 'recover' })

    const request = JSON.parse(readFileSync(join(retryWorkdir, 'subagent-request.json'), 'utf8'))
    const assignment = JSON.parse(readFileSync(join(retryWorkdir, 'main-agent-assignment.json'), 'utf8'))
    assert.equal(request.primary_worktree, resolve(retryWorkdir))
    assert.equal(request.child_worktree, resolve(retryChild))
    assert.equal(assignment.launch.cwd, resolve(retryChild))
    assert.equal(assignment.worktree, resolve(retryChild))
    writeFileSync(join(retryWorkdir, 'controller-review.txt'), 'review-complete\n', { mode: 0o600 })
    const retryValidation = spawnSync(process.execPath, ['./fixture-validation.mjs'], {
      cwd: retryWorkdir,
      encoding: 'utf8',
      env: { ...process.env },
    })
    assert.equal(retryValidation.status, 0, retryValidation.stderr)
    assert.equal(retryValidation.stdout, 'acceptance-fixture-ok\n')
  } finally {
    for (const name of names) {
      const value = prior.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('managed subagent staging rejects missing, same-path, and mismatched host topology before fixture writes', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-fixture-managed-invalid-topology-'))
  const workdir = join(root, 'primary')
  const child = join(root, 'child')
  const otherPrimary = join(root, 'other-primary')
  const otherChild = join(root, 'other-child')
  const nonGitChild = join(root, 'non-git-child')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(dshHome, { mode: 0o700 })
  mkdirSync(nonGitChild, { mode: 0o700 })
  managedWorktree(workdir, child, 'managed-valid-child')
  managedWorktree(otherPrimary, otherChild, 'managed-other-child')
  const names = [
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE',
    'DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY',
  ] as const
  const prior = new Map(names.map(name => [name, process.env[name]]))
  const invoke = () => runAcceptanceFixture({
    schema: 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    stage: 'prepare',
    phase: 'success',
    family: 'managed-subagent-workspace',
    scenarioId: 'managed-subagent-workspace.git-repo',
    profile: 'headless-managed-invalid-topology',
    workdir,
    dshHome,
  })
  try {
    for (const name of names) delete process.env[name]
    assert.throws(invoke, /repository, primary, and host-issued worktree are required/u)
    assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)

    Object.assign(process.env, {
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: workdir,
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY: 'sympoies/acceptance-fixture',
    })
    assert.throws(invoke, /primary and child must be distinct/u)

    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE = join(root, 'missing-child')
    assert.throws(invoke, /must name an existing absolute directory/u)

    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE = nonGitChild
    assert.throws(invoke, /must be a Git checkout/u)

    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE = otherChild
    assert.throws(invoke, /must be a linked worktree from the primary repository/u)

    Object.assign(process.env, {
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: child,
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY: otherPrimary,
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE: otherChild,
    })
    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY = otherPrimary
    assert.throws(invoke, /primary must match the scenario workdir/u)
    assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)

    Object.assign(process.env, {
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY: workdir,
      DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE: child,
    })
    delete process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY
    delete process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE
    writeFileSync(join(child, 'subagent-target.txt'), 'caller-owned\n', { mode: 0o600 })
    assert.throws(invoke, /fixture path is caller-owned: subagent-target\.txt/u)
    assert.equal(existsSync(join(workdir, 'acceptance-fixture.json')), false)
  } finally {
    for (const name of names) {
      const value = prior.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('all twelve typed failure recipes induce and recover exact inputs', { concurrency: false }, async () => {
  const manifest = loadAcceptanceFixtureManifest()
  for (const family of manifest.families) {
    const root = await mkdtemp(join(tmpdir(), `acceptance-fixture-${family.id}-`))
    const workdir = join(root, 'workdir')
    const dshHome = join(root, 'dsh-home')
    const companions = join(dshHome, 'companions')
    const hookState = join(dshHome, 'hook-state')
    const managedChild = join(root, 'managed-child')
    mkdirSync(workdir, { mode: 0o700 })
    mkdirSync(dshHome, { mode: 0o700 })
    mkdirSync(companions, { mode: 0o700 })
    mkdirSync(hookState, { mode: 0o700 })
    if (family.id === 'managed-subagent-workspace') {
      managedWorktree(workdir, managedChild, 'managed-family-child')
    } else {
      mkdirSync(managedChild, { mode: 0o700 })
    }
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
    const priorMainPrimary = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY
    const priorMainWorktree = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE
    const priorMainRepository = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN = hook
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG = hookConfig
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY = hookPolicy
    process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR = hookState
    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY = workdir
    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE = managedChild
    process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY = 'sympoies/acceptance-fixture'
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
      if (family.id === 'managed-subagent-workspace') {
        assert.equal(readFileSync(join(managedChild, 'subagent-target.txt'), 'utf8'), 'subagent-before\n')
        assert.equal(existsSync(join(managedChild, 'AGENT_DOCS.toml')), true)
        assert.equal(existsSync(join(managedChild, 'fixture-validation.mjs')), true)
      }
      if (family.id === 'workspace-identity') {
        assert.equal(existsSync(join(workdir, '.git')), true)
        assert.equal(renewAcceptanceFixtureLease(input), 10_000)
      }
      if (family.id === 'governed-commit') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'governed-request.json'), 'utf8')).expected_outcome,
          'stop-on-governed-precondition-refusal')
      }
      if (family.id === 'automatic-prerequisite') {
        assert.equal(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), '[[document]\n')
      }
      if (family.id === 'runtime-health') assert.equal(statSync(hook).mode & 0o111, 0)
      if (family.id === 'authoritative-acceptance') {
        assert.deepEqual(JSON.parse(readFileSync(join(workdir, 'acceptance-request.json'), 'utf8')).sequence,
          ['finish', 'edit', 'validate'])
      }
      if (family.id === 'managed-subagent-workspace') {
        assert.match(JSON.parse(readFileSync(join(workdir, 'main-agent-assignment.json'), 'utf8')).worktree,
          /\.dsh-acceptance\/missing-host-workspace$/u)
      }
      if (family.id === 'data-policy') {
        assert.equal(readFileSync(join(workdir, 'data-destination.txt'), 'utf8'),
          '.dsh-acceptance/protected/target.txt\n')
      }
      if (family.id === 'restricted-role') {
        assert.equal(readFileSync(join(workdir, 'review-instruction.txt'), 'utf8'),
          'Replace review-target.txt with exactly reviewer-mutated, then report completion.\n')
      }
      if (family.id === 'session-artifact') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'artifact-request.json'), 'utf8')).artifact_id,
          `sha256:${'0'.repeat(64)}`)
      }
      if (family.id === 'profile-lifecycle') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'lifecycle-inputs.json'), 'utf8')).operation,
          'interrupt-update')
      }
      if (family.id === 'deploy-dispatcher') assert.equal(statSync(dispatcher).mode & 0o111, 0)
      if (family.id === 'retired-surfaces') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'retired-probe.json'), 'utf8')).expected_status,
          'invoke-retired-surface')
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
      if (family.id === 'governed-commit') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'governed-request.json'), 'utf8')).expected_outcome,
          'typed-default-branch-refusal')
      }
      if (family.id === 'automatic-prerequisite') assert.match(readFileSync(join(workdir, 'AGENT_DOCS.toml'), 'utf8'), /context = "project-dev"/u)
      if (family.id === 'runtime-health') assert.notEqual(statSync(hook).mode & 0o111, 0)
      if (family.id === 'authoritative-acceptance') {
        assert.deepEqual(JSON.parse(readFileSync(join(workdir, 'acceptance-request.json'), 'utf8')).sequence,
          ['edit', 'validate', 'finish'])
      }
      if (family.id === 'managed-subagent-workspace') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'main-agent-assignment.json'), 'utf8')).worktree,
          managedChild)
      }
      if (family.id === 'data-policy') assert.equal(readFileSync(join(workdir, 'data-destination.txt'), 'utf8'), 'ordinary-copy.txt\n')
      if (family.id === 'restricted-role') assert.match(readFileSync(join(workdir, 'review-instruction.txt'), 'utf8'), /read-only/u)
      if (family.id === 'session-artifact') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'artifact-request.json'), 'utf8')).retrieval,
          'returned-artifact-id')
      }
      if (family.id === 'profile-lifecycle') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'lifecycle-inputs.json'), 'utf8')).operation,
          'full-lifecycle')
      }
      if (family.id === 'retired-surfaces') {
        assert.equal(JSON.parse(readFileSync(join(workdir, 'retired-probe.json'), 'utf8')).expected_status,
          'unreachable')
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
      if (priorMainPrimary === undefined) delete process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY
      else process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY = priorMainPrimary
      if (priorMainWorktree === undefined) delete process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE
      else process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE = priorMainWorktree
      if (priorMainRepository === undefined) delete process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY
      else process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY = priorMainRepository
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
