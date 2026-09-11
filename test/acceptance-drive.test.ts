import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  loadAcceptanceCatalog,
  runAcceptanceDrive,
} from '../dist/src/acceptance/drive.js'

const ROOT = resolve(import.meta.dirname, '..')
const CATALOG = join(ROOT, 'compatibility', 'acceptance-scenarios.json')
const PACK = join(ROOT, 'compatibility', 'acceptance-scenario-pack.json')

function executable(path: string, source: string) {
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function fixtureProvider(path: string) {
  return executable(path, `
const fs = await import('node:fs')
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const stage = value('--stage')
if (stage === 'recover') fs.writeFileSync('.fixture-recovered', 'ok\\n')
process.stdout.write(JSON.stringify({
  schema_version:'dsh-runtime-kit.acceptance-fixture-result.v1',ok:true,
  data:{status:'pass',stage,phase:value('--phase'),family:value('--family'),scenario_id:value('--scenario'),
    evidence:[{kind:'fixture-receipt',reference:'fixture-'+stage+'.json',sha256:'${'a'.repeat(64)}'}]},
})+'\\n')
`)
}

function fixtureCatalog(
  path: string,
  folderKind: 'git-repo' | 'non-git' | 'managed-worktree' = 'non-git',
  overrides: Record<string, unknown> = {},
) {
  const value = {
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v2',
    scenarios: [{
      id: 'scripted-provider.non-git',
      owner: { program_child: '#D', feature_issue: '#57' },
      preconditions: ['A healthy installed headless profile is available.'],
      folder_kind: folderKind,
      task: 'Create result.txt and finish with DSH_ACCEPTANCE_PASS:scripted-provider.non-git.',
      success_marker: 'DSH_ACCEPTANCE_PASS:scripted-provider.non-git',
      deliberate_failure_task: 'Create result.txt and finish with DSH_ACCEPTANCE_RECOVERED:scripted-provider.non-git.',
      deliberate_failure_success_marker: 'DSH_ACCEPTANCE_RECOVERED:scripted-provider.non-git',
      expected_observable_outcome: 'result.txt exists and the final response carries the success marker.',
      expected_reminders: [],
      forbidden_outcomes: ['policy denial', 'silent stop'],
      ...overrides,
    }],
  }
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

function rows(path: string) {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

test('catalog expands every planned owner into stable folder-kind scenarios', () => {
  const catalog = loadAcceptanceCatalog(CATALOG)
  assert.equal(catalog.schema_version, 'dsh-runtime-kit.acceptance-scenarios.v2')
  assert.equal(catalog.scenarios.length, 40)
  assert.equal(new Set(catalog.scenarios.map(row => row.id)).size, 40)
  assert.deepEqual(
    catalog.scenarios.map(row => [row.id, row.owner.program_child, row.owner.feature_issue, row.folder_kind]),
    [
      ['workspace-identity.git-repo', '#D', '#56', 'git-repo'],
      ['workspace-identity.non-git', '#D', '#56', 'non-git'],
      ['workspace-identity.managed-worktree', '#D', '#56', 'managed-worktree'],
      ['governed-commit.git-repo', '#D', '#55', 'git-repo'],
      ['governed-commit.managed-worktree', '#D', '#55', 'managed-worktree'],
      ['automatic-prerequisite.git-repo', '#D', '#57', 'git-repo'],
      ['automatic-prerequisite.non-git', '#D', '#57', 'non-git'],
      ['automatic-prerequisite.managed-worktree', '#D', '#57', 'managed-worktree'],
      ['runtime-health.git-repo', '#D', '#58', 'git-repo'],
      ['runtime-health.non-git', '#D', '#58', 'non-git'],
      ['runtime-health.managed-worktree', '#D', '#58', 'managed-worktree'],
      ['authoritative-acceptance.git-repo', '#D', '#59', 'git-repo'],
      ['authoritative-acceptance.non-git', '#D', '#59', 'non-git'],
      ['authoritative-acceptance.managed-worktree', '#D', '#59', 'managed-worktree'],
      ['managed-subagent-workspace.git-repo', '#D', '#60', 'git-repo'],
      ['managed-subagent-workspace.managed-worktree', '#D', '#60', 'managed-worktree'],
      ['data-policy.git-repo', '#D', '#61', 'git-repo'],
      ['data-policy.non-git', '#D', '#61', 'non-git'],
      ['data-policy.managed-worktree', '#D', '#61', 'managed-worktree'],
      ['restricted-role.git-repo', '#D', '#62', 'git-repo'],
      ['restricted-role.non-git', '#D', '#62', 'non-git'],
      ['restricted-role.managed-worktree', '#D', '#62', 'managed-worktree'],
      ['session-artifact.git-repo', '#D', '#63', 'git-repo'],
      ['session-artifact.non-git', '#D', '#63', 'non-git'],
      ['session-artifact.managed-worktree', '#D', '#63', 'managed-worktree'],
      ['profile-lifecycle.git-repo', '#D', '#64', 'git-repo'],
      ['profile-lifecycle.non-git', '#D', '#64', 'non-git'],
      ['profile-lifecycle.managed-worktree', '#D', '#64', 'managed-worktree'],
      ['deploy-dispatcher.git-repo', '#D', '#79', 'git-repo'],
      ['deploy-dispatcher.managed-worktree', '#D', '#79', 'managed-worktree'],
      ['retired-surfaces.git-repo', '#D', '#65', 'git-repo'],
      ['retired-surfaces.non-git', '#D', '#65', 'non-git'],
      ['retired-surfaces.managed-worktree', '#D', '#65', 'managed-worktree'],
      ['diagnostics.tool-denial.non-git', '#C', '#215', 'non-git'],
      ['diagnostics.unhealthy-companion.non-git', '#C', '#215', 'non-git'],
      ['diagnostics.stale-plan-digest.non-git', '#C', '#215', 'non-git'],
      ['diagnostics.provider-unavailable.non-git', '#C', '#215', 'non-git'],
      ['diagnostics.dirty-anchor.git-repo', '#C', '#215', 'git-repo'],
      ['diagnostics.finish-line-refusal.managed-worktree', '#C', '#215', 'managed-worktree'],
      ['github-pr-delivery.managed-worktree', '#E', '#197', 'managed-worktree'],
    ],
  )
  for (const row of catalog.scenarios) {
    if (row.owner.program_child === '#D') {
      assert.ok(row.deliberate_failure_task.length > 0)
      assert.equal(
        row.deliberate_failure_success_marker,
        `DSH_ACCEPTANCE_RECOVERED:${row.id}`,
      )
    } else {
      assert.equal(row.deliberate_failure_task, null)
      assert.equal(row.deliberate_failure_success_marker, null)
    }
  }
})

test('acceptance-harness is a Codex and Claude project intent', () => {
  const catalog = readFileSync(join(ROOT, 'AGENT_DOCS.toml'), 'utf8')
  const runbook = readFileSync(join(ROOT, 'docs', 'acceptance-harness.md'), 'utf8')
  assert.match(catalog, /context = "acceptance-harness"/u)
  assert.match(catalog, /path = "docs\/acceptance-harness\.md"/u)
  assert.match(catalog, /product = \["codex", "claude"\]/u)
  assert.match(runbook, /DSH_PERMISSION_MODE=danger-full-access/u)
  assert.match(runbook, /disposable\s+scratch repositories/u)
  assert.match(runbook, /outer OS sandbox/u)
  assert.match(runbook, /--ro-bind \/ \/[\s\S]*--bind <family-root> <family-root>/u)
  assert.match(runbook, /--unshare-user --uid 0 --gid 0/u)
  assert.match(runbook, /finish-line-containment-untrusted/u)
  assert.match(runbook, /--ro-bind <staged-systemd-run> \/usr\/bin\/systemd-run/u)
  assert.match(runbook, /--ro-bind <staged-git> \/usr\/bin\/git/u)
  assert.match(runbook, /--ro-bind <staged-loader> \/usr\/lib\/<platform-loader>/u)
  assert.match(runbook, /git config user\.name 'DSH Acceptance Fixture'/u)
  assert.match(runbook, /git config user\.email dsh-acceptance-fixture@example\.invalid/u)
  assert.match(runbook, /commit\.gpgSign true/u)
  assert.match(runbook, /--overlay-src <signing-home>[\s\S]*--tmp-overlay <signing-home>/u)
  assert.match(runbook, /--chmod 0700 <signing-home>/u)
  assert.match(runbook, /independently verify the resulting commit signature/iu)
  assert.match(runbook, /repository-local test identity/u)
  assert.match(runbook, /fresh dedicated Agent Console controller\s+principal/iu)
  assert.match(runbook, /DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG/u)
  assert.match(runbook, /XDG_CONFIG_HOME/u)
  assert.match(runbook, /precondition-unmet/u)
  assert.doesNotMatch(runbook, /set `DSH_PERMISSION_MODE=danger-full-access` in the\s+owner-only DSH wrapper before boot/u)
})

test('#D tasks run fixture commands in the current session without launching nested DSH', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.owner.program_child === '#D',
  )

  assert.equal(scenarios.length, 33)
  for (const scenario of scenarios) {
    for (const task of [scenario.task, scenario.deliberate_failure_task]) {
      assert.equal(typeof task, 'string', `${scenario.id} must declare both phases`)
      assert.doesNotMatch(task!, /through DSH/u, scenario.id)
      assert.match(task!, /executable command ending in \.mjs[\s\S]*Bash tool in the current DSH session/u, scenario.id)
      assert.match(task!, /Bash calls?[\s\S]*do not include sandbox_permissions or justification/iu, scenario.id)
      assert.match(task!, /do not launch dsh, dsh-host, or another nested agent session/iu, scenario.id)
      assert.doesNotMatch(task!, /Bash tool[\s\S]*every command/u, scenario.id)
    }
  }
})

test('governed commit tasks omit escalation fields from every Bash call', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id === 'governed-commit.managed-worktree',
  )

  assert.equal(scenarios.length, 1)
  for (const task of [scenarios[0]!.task, scenarios[0]!.deliberate_failure_task]) {
    assert.match(
      task!,
      /For every Bash call in this task, do not include sandbox_permissions or justification/iu,
    )
  }
})

test('DSH project guidance names the governed commit surface and keeps direct default delivery refused', () => {
  const guidance = readFileSync(join(ROOT, 'agent-docs', 'PROJECT_DEV_EDIT.md'), 'utf8')
  assert.match(guidance, /runtime_kit_governed_commit/u)
  assert.match(guidance, /default branch/u)
  assert.match(guidance, /refus/u)
})

test('workspace recovery tasks distinguish the absolute request target from the literal write argument', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('workspace-identity.'),
  )
  for (const scenario of scenarios) {
    assert.match(scenario.deliberate_failure_task!, /target field is an absolute path/u)
    assert.match(scenario.deliberate_failure_task!, /scenario workdir's child named leased\.txt/u)
    assert.match(scenario.deliberate_failure_task!, /file_path=leased\.txt/u)
    assert.doesNotMatch(scenario.deliberate_failure_task!, /require its target resolves exactly to \.\/leased\.txt/u)
  }
})

test('workspace success tasks exercise the write-tool lease boundary without a Bash mutation', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('workspace-identity.'),
  )

  assert.equal(scenarios.length, 3)
  for (const scenario of scenarios) {
    assert.match(scenario.task, /Call write exactly once/u)
    assert.match(scenario.task, /Do not use Bash for the mutation/u)
  }
})

test('governed failure tasks bind exact request actions to each folder kind', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('governed-commit.'),
  )
  const git = scenarios.find(row => row.folder_kind === 'git-repo')!
  const managed = scenarios.find(row => row.folder_kind === 'managed-worktree')!
  for (const scenario of [git, managed]) {
    assert.match(scenario.deliberate_failure_task!, /exact ordered sequence/u)
    assert.match(scenario.deliberate_failure_task!, /do not substitute/u)
    assert.match(scenario.deliberate_failure_task!, /stop-on-governed-precondition-refusal/u)
    assert.match(scenario.deliberate_failure_task!, /validation action first/u)
  }
  assert.match(git.deliberate_failure_task!, /typed-default-branch-refusal/u)
  assert.doesNotMatch(git.deliberate_failure_task!, /signed commit are verified/u)
  assert.match(git.deliberate_failure_task!, /choose exactly one mutually exclusive branch/u)
  assert.match(git.deliberate_failure_task!, /do not edit, stage, inspect Git, or execute any action from the other branch/u)
  assert.match(git.deliberate_failure_task!, /must not contain any DSH_ACCEPTANCE_ token/u)
  assert.match(git.deliberate_failure_task!, /Only the typed-default-branch-refusal branch may emit the recovery marker/u)
  assert.match(managed.deliberate_failure_task!, /signed-feature-commit/u)
  assert.match(managed.deliberate_failure_task!, /choose exactly one mutually exclusive branch/u)
  assert.match(managed.deliberate_failure_task!, /do not edit, stage, inspect Git, or execute any action from the other branch/u)
  assert.match(managed.deliberate_failure_task!, /must not contain any DSH_ACCEPTANCE_ token/u)
  assert.match(managed.deliberate_failure_task!, /Only the signed-feature-commit branch may emit the recovery marker/u)
  assert.match(managed.task, /Read governed-request\.json/u)
  assert.match(managed.task, /exact ordered sequence/u)
  assert.match(managed.task, /stage action/u)
  assert.match(managed.task, /Do not deliver, open a PR, or run a delivery review/u)
  assert.match(managed.task, /external harness owns post-run delivery review/u)
  assert.match(managed.task, /final output line must be exactly DSH_ACCEPTANCE_PASS:governed-commit\.managed-worktree/u)
  assert.match(managed.deliberate_failure_task!, /final output line must be exactly DSH_ACCEPTANCE_RECOVERED:governed-commit\.managed-worktree/u)
  for (const task of [managed.task, managed.deliberate_failure_task!]) {
    assert.match(task, /no backticks, prefix, suffix, or sentence around it/u)
    assert.match(task, /after any finish-line steering/iu)
  }
})

test('governed read-only task permits its required fixture validation command', () => {
  const scenario = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'governed-commit.git-repo',
  )!

  assert.doesNotMatch(scenario.task, /do not invoke Git, Bash, or any commit tool/u)
  assert.match(
    scenario.task,
    /Do not invoke Bash except for the exact registered \.\/fixture-validation\.mjs command/u,
  )
})

test('workspace recovery tasks satisfy read-before-write before their single mutation', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('workspace-identity.'),
  )

  assert.equal(scenarios.length, 3)
  for (const scenario of scenarios) {
    assert.match(
      scenario.deliberate_failure_task!,
      /Read the target's current bytes from \.\/leased\.txt, then make exactly one write attempt/u,
    )
    assert.match(
      scenario.deliberate_failure_task!,
      /Call write with only file_path and content; do not include sandbox_permissions or justification/u,
    )
    assert.match(
      scenario.deliberate_failure_task!,
      /Use exactly the two literal arguments file_path=leased\.txt and content=lease-recovered/u,
    )
    assert.match(scenario.deliberate_failure_task!, /Do not reconstruct the absolute target path/u)
  }
})

test('authoritative acceptance failure tasks make request array order explicit', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('authoritative-acceptance.'),
  )
  assert.equal(scenarios.length, 3)
  for (const scenario of scenarios) {
    assert.match(scenario.deliberate_failure_task!, /array order is authoritative/u)
    assert.match(scenario.deliberate_failure_task!, /exactly edit, validate, finish/u)
    assert.match(scenario.deliberate_failure_task!, /acceptance-target\.txt/u)
    assert.match(scenario.deliberate_failure_task!, /acceptance-after followed by one newline/u)
    assert.match(scenario.deliberate_failure_task!, /stop without editing and without a recovery marker/u)
    assert.match(scenario.deliberate_failure_task!, /run exactly \.\/fixture-validation\.mjs once to surface the induced failure/u)
  }
  const nonGit = scenarios.find(row => row.folder_kind === 'non-git')!
  assert.match(nonGit.deliberate_failure_task!, /validate means run exactly \.\/fixture-validation\.mjs/u)
  assert.match(nonGit.deliberate_failure_task!, /Do not run acceptance-validation\.mjs/u)
  for (const scenario of scenarios.filter(row => row.folder_kind !== 'non-git')) {
    assert.match(scenario.deliberate_failure_task!, /validate means run exactly node acceptance-validation\.mjs/u)
  }
})

test('restricted-role scenarios invoke the authenticated reviewer surface instead of an ordinary child', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('restricted-role.'),
  )

  assert.equal(scenarios.length, 3)
  for (const scenario of scenarios) {
    for (const task of [scenario.task, scenario.deliberate_failure_task!]) {
      assert.match(task, /Call review_specialists/u)
      assert.match(task, /roles exactly \["reviewer-quick"\]/u)
      assert.match(task, /Do not use the ordinary subagent tool/u)
    }
    assert.match(
      scenario.deliberate_failure_task!,
      /run exactly \.\/fixture-validation\.mjs once to surface the typed induced failure/u,
    )
    assert.match(scenario.deliberate_failure_task!, /typed status induced record[\s\S]*command exits zero/u)
    assert.match(scenario.deliberate_failure_task!, /Only acceptance-fixture-ok permits the recovery marker/u)
  }
})

test('managed subagent controller records reviewed child state before validating the primary last', () => {
  const scenarios = loadAcceptanceCatalog(CATALOG).scenarios.filter(
    row => row.id.startsWith('managed-subagent-workspace.'),
  )
  const pack = JSON.parse(readFileSync(PACK, 'utf8'))
  const family = pack.families.find((row: { id: string }) => row.id === 'managed-subagent-workspace')
  assert.equal(scenarios.length, 2)
  assert.match(family.success_observation, /primary implementation target remains subagent-before/u)
  assert.match(family.success_observation, /controller-owned review file is exactly review-complete/u)
  assert.match(family.success_observation, /distinct retained child target is subagent-after/u)
  assert.match(family.success_observation, /Rerun the registered child validation after DSH exits/u)
  assert.match(family.deliberate_failure.recovery_observation, /retry primary implementation target stayed subagent-before/u)
  assert.match(family.deliberate_failure.recovery_observation, /controller-owned review file became exactly review-complete/u)
  assert.match(family.deliberate_failure.recovery_observation, /distinct retry child remained available with subagent-after/u)
  assert.match(family.deliberate_failure.recovery_observation, /only after attestation/u)
  for (const scenario of scenarios) {
    for (const task of [scenario.task, scenario.deliberate_failure_task!]) {
      assert.match(task, /after (?:the )?run closeout/iu)
      assert.match(task, /primary_worktree/u)
      assert.match(task, /child_worktree/u)
      assert.match(task, /While the lane is still open/u)
      assert.match(task, /read-only/u)
      assert.match(task, /exact command \.\/fixture-validation\.mjs/u)
      assert.match(task, /Do not run Bash in child_worktree/u)
      assert.match(task, /external harness will independently rerun that validation after DSH exits/u)
      assert.match(task, /Accept the submitted current revision/u)
      assert.match(task, /controller-review\.txt/u)
      assert.match(task, /review-complete/u)
      assert.match(task, /primary implementation target/u)
      assert.match(task, /final tool call/u)
      assert.match(task, /without any other tool call/u)
      assert.match(task, /do not append a phase or workdir suffix/iu)
      assert.ok(task.indexOf('Do not run Bash in child_worktree') < task.indexOf('Accept the submitted current revision'))
      assert.ok(task.indexOf('Accept the submitted current revision') < task.indexOf('controller-review.txt'))
      assert.ok(task.indexOf('after the run closeout') < task.indexOf('once from primary_worktree'))
    }
  }
})

test('dsh-runtime-kit routes acceptance-drive and prints its CLI contract', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'dist', 'bin', 'dsh-runtime-kit.js'), 'acceptance-drive', '--help'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Usage: dsh-runtime-kit acceptance-drive /u)
  assert.match(result.stdout, /npm pack does not build this package/u)
  assert.match(result.stdout, /--phase <success\|deliberate-failure>/u)
  assert.match(result.stdout, /--retry-workdir <absolute path>/u)
  assert.match(result.stdout, /--fixture-bin <absolute path>.*packaged sibling fixture bin/u)
  assert.match(result.stdout, /--attest <absolute JSON path>/u)
  assert.match(result.stdout, /--summarize-pack/u)
})

test('scenario-pack execution discovers the packaged fixture provider by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-packaged-fixture-'))
  const packageRoot = join(root, 'package')
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  mkdirSync(packageRoot, { mode: 0o700 })
  cpSync(join(ROOT, 'dist'), join(packageRoot, 'dist'), { recursive: true })
  cpSync(join(ROOT, 'compatibility'), join(packageRoot, 'compatibility'), { recursive: true })
  cpSync(join(ROOT, 'package.json'), join(packageRoot, 'package.json'))
  symlinkSync(join(ROOT, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('DSH_ACCEPTANCE_PASS:automatic-prerequisite.non-git\\n')
`)

  const invoked = spawnSync(process.execPath, [
    join(packageRoot, 'dist', 'bin', 'dsh-runtime-kit.js'), 'acceptance-drive',
    '--profile', 'headless-automatic-prerequisite', '--scenario', 'automatic-prerequisite.non-git',
    '--phase', 'success', '--workdir', workdir, '--output', output,
    '--artifact-dir', join(root, 'artifacts'), '--dsh-bin', dsh,
    '--runtime-kit-bin', runtimeKit, '--dsh-home', dshHome,
    '--timeout-ms', '10000', '--run-id', 'packaged-fixture-success',
  ], { cwd: workdir, encoding: 'utf8' })

  assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout)
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.run_context.fixture_executable.path,
    join(packageRoot, 'dist', 'bin', 'dsh-runtime-kit-acceptance-fixture.js'))
  assert.equal(result.observed.fixture.start.receipt.stage, 'prepare')
  assert.equal(result.observed.fixture.cleanup.receipt.stage, 'cleanup')
})

test('scripted provider emits result and summary rows and appends on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-test-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const artifacts = join(root, 'artifacts')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
const args = process.argv.slice(2)
if (args[0] !== 'doctor') process.exit(91)
process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:true,data:{schema_version:'dsh-runtime-kit.doctor.v1',status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
fs.writeFileSync(path.join(sessions, 'scripted.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify({type:'policy/result',data:{content:[{type:'text',text:'decision.context dsh.skill-usage-reminder'}]}})+'\\n')))
fs.writeFileSync(path.join(process.cwd(), 'result.txt'), 'ok\\n')
process.stderr.write('scripted reasoning\\n')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  const input = {
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: artifacts, dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000,
  }
  const first = runAcceptanceDrive({ ...input, runId: 'scripted-1' })
  const second = runAcceptanceDrive({ ...input, runId: 'scripted-2' })
  assert.equal(first.status, 'pass')
  assert.equal(second.status, 'pass')

  const written = rows(output)
  assert.equal(written.length, 4)
  assert.deepEqual(written.map(row => row.schema_version), [
    'dsh-runtime-kit.acceptance-drive-result.v1',
    'dsh-runtime-kit.acceptance-drive-summary.v1',
    'dsh-runtime-kit.acceptance-drive-result.v1',
    'dsh-runtime-kit.acceptance-drive-summary.v1',
  ])
  assert.equal(written[0].status, 'pass')
  assert.equal(written[0].observed.exit_code, 0)
  assert.equal(written[0].observed.session_transcripts.length, 1)
  assert.deepEqual(written[0].observed.policy_decisions.rule_ids, ['dsh.skill-usage-reminder'])
  assert.equal(existsSync(written[0].observed.stdout.path), true)
  assert.equal(existsSync(written[0].observed.stderr.path), true)
})

test('a quoted or negated success marker is not accepted unless it occupies its own line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-marker-line-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('I do not emit DSH_ACCEPTANCE_PASS:scripted-provider.non-git because validation failed.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'marker-line',
  })

  assert.equal(summary.status, 'fail')
  assert.equal(rows(output)[0].observed.success_marker_seen, false)
})

test('deliberate-failure phase sends the unchanged task and requires a typed failed outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-pack-phase-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'assistant/message',data:{message:{content:[{type:'tool-result',content:[{type:'text',text:JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:false,error:{code:'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID'}})}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'failure.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stderr.write('dsh: DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG,
    scenarioPackPath: join(ROOT, 'compatibility', 'acceptance-scenario-pack.json'),
    phase: 'deliberate-failure',
    scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'pack-failure-phase',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })
  assert.equal(summary.status, 'pass')
  assert.deepEqual(summary.scenario_pack.case_ids, [
    'automatic-prerequisite.non-git.deliberate-failure',
  ])
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.expected.success_marker, 'DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git')
  assert.equal(result.observed.success_marker_seen, false)
  assert.equal(result.session_outcome.status, 'failed')
  assert.equal(result.session_outcome.code, 'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID')
  assert.match(result.scenario_pack.isolation_key, /^[a-f0-9]{64}$/u)
  assert.equal(result.scenario_pack.family, 'automatic-prerequisite')
  assert.equal(result.scenario_pack.phase, 'deliberate-failure')
})

test('Git deliberate-failure checks reminders on the distinct clean retry, not the pre-model fault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-git-retry-workdir-'))
  const workdir = join(root, 'induced')
  const retryWorkdir = join(root, 'retry')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  for (const path of [workdir, retryWorkdir]) {
    mkdirSync(path)
    assert.equal(spawnSync('git', ['init', '--initial-branch=main', path]).status, 0)
  }
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const calls = path.join(process.env.DSH_HOME, 'calls.jsonl')
fs.appendFileSync(calls, JSON.stringify({cwd:process.cwd(),task:process.argv.at(-1)})+'\\n')
if (fs.readFileSync(calls, 'utf8').trim().split('\\n').length === 1) {
  const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
  fs.mkdirSync(sessions, {recursive:true})
  const transcript = [
    {type:'session',cwd:process.cwd(),createdAt:Date.now()},
    {type:'assistant/message',data:{message:{content:[{type:'tool-result',content:[{type:'text',text:JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:false,error:{code:'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID'}})}]}]}}},
  ].map(row => JSON.stringify(row)).join('\\n')+'\\n'
  fs.writeFileSync(path.join(sessions, 'failure.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
  process.stderr.write('dsh: DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID\\n')
  process.exit(1)
}
const recoverySessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'recovery')
fs.mkdirSync(recoverySessions, {recursive:true})
const recoveryTranscript = [
  {type:'tool/call',data:{callId:'runtime-context-1',name:'runtime_context',arguments:'{"intent":"project-dev"}'}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId:'runtime-context-1'},content:[{type:'tool-result',isError:false,content:[{type:'text',text:'Follow the current repository instructions'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(recoverySessions, 'success.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(recoveryTranscript)))
process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.git-repo\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.git-repo'],
    workdir, retryWorkdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'git-retry-workdir',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  assert.equal(summary.status, 'pass')
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.git-repo',
  )!.deliberate_failure_task
  const calls = rows(join(dshHome, 'calls.jsonl')).filter(row => row.task === failureTask)
  assert.deepEqual(calls.map(row => row.cwd), [resolve(workdir), resolve(retryWorkdir)])
  assert.equal(calls[0].task, calls[1].task)
  const [result] = rows(output)
  assert.deepEqual(result.observed.missing_reminders, ['Follow the current repository instructions'])
  assert.deepEqual(result.observed.fixture.clean_retry.missing_reminders, [])
  assert.equal(result.observed.fixture.clean_retry.command.cwd, resolve(retryWorkdir))
})

test('deliberate-failure clean retry applies the complete success gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-pack-retry-gate-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('policy-unavailable\\n')
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'assistant/message',data:{message:{content:[{type:'tool-result',content:[{type:'text',text:JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:false,error:{code:'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID'}})}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'failure.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stderr.write('dsh: DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'pack-retry-gate',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.deepEqual(result.observed.fixture.clean_retry.forbidden_outcomes_seen, ['policy-unavailable'])
})

test('deliberate-failure rejects marker-only and ordinary-success output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-pack-false-positive-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  for (const [name, outputText] of [
    ['diagnostic-only', 'DSH_ACCEPTANCE_DIAGNOSED:automatic-prerequisite.non-git\\n'],
    ['ordinary-success', 'DSH_ACCEPTANCE_PASS:automatic-prerequisite.non-git\\n'],
    ['both', 'DSH_ACCEPTANCE_DIAGNOSED:automatic-prerequisite.non-git\\nDSH_ACCEPTANCE_PASS:automatic-prerequisite.non-git\\n'],
  ]) {
    const output = join(root, `${name}.jsonl`)
    const dsh = executable(join(root, `${name}.mjs`), `process.stdout.write(${JSON.stringify(outputText)})`)
    const summary = runAcceptanceDrive({
      profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
      phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.non-git'],
      workdir, outputPath: output, artifactDir: join(root, `${name}-artifacts`), dshBin: dsh,
      runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: `pack-${name}`,
      fixtureBin: fixtureProvider(join(root, `${name}-fixture.mjs`)),
    })
    assert.equal(summary.status, 'fail')
    assert.equal(rows(output)[0].status, 'fail')
  }
})

test('acceptance-drive retrospective modes reject run-only options', () => {
  const command = join(ROOT, 'dist', 'bin', 'dsh-runtime-kit.js')
  for (const args of [
    ['--output', '/tmp/results.jsonl', '--attest', '/tmp/a.json', '--phase', 'success'],
    ['--output', '/tmp/results.jsonl', '--summarize-pack', '--scenario', 'workspace-identity.non-git'],
    ['--profile', 'headless', '--scenario-pack', PACK, '--scenario', 'workspace-identity.non-git', '--workdir', '/tmp', '--output', '/tmp/results.jsonl', '--dsh-home', '/tmp', '--dsh-bin', '/bin/true'],
  ]) {
    const result = spawnSync(process.execPath, [command, 'acceptance-drive', ...args], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(result.status, 64)
    assert.equal(JSON.parse(result.stdout).error.code, 'invalid-mode')
  }
})

test('driver does not attach an older same-directory failure to a new scripted pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-session-window-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(sessions, { recursive: true })
  fixtureCatalog(catalog)
  const staleTranscript = [
    { type: 'session', cwd: workdir, createdAt: Date.now() - 60_000 },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const stalePath = join(sessions, 'stale.jsonl.zstd')
  writeFileSync(stalePath, zstdCompressSync(Buffer.from(staleTranscript)))
  const old = new Date(Date.now() - 60_000)
  utimesSync(stalePath, old, old)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
const args = process.argv.slice(2)
if (args[0] !== 'doctor') process.exit(91)
process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:true,data:{schema_version:'dsh-runtime-kit.doctor.v1',status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'fresh-pass',
  })
  assert.equal(summary.status, 'pass')
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.session_outcome.status, 'completed')
  assert.equal(result.session_outcome.code, 'completed')
})

test('a recovered finish-line steer does not override a success marker and zero process exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-finish-line-stop-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'non-git')
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'user/message',data:{source:{kind:'plugin',plugin:'dsh-runtime-kit'},content:[{type:'text',text:'Finish-line blocked: validation-missing; private details'}]}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'finish-line-stop',
  })
  assert.equal(summary.status, 'pass')
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.observed.success_marker_seen, true)
  assert.equal(result.session_outcome.category, 'finish-line-stop')
  assert.equal(result.session_outcome.code, 'validation-missing')
})

test('unmet folder precondition emits a typed row without spawning DSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-precondition-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  const marker = join(root, 'spawned')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'git-repo')
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:true,data:{schema_version:'dsh-runtime-kit.doctor.v1',status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'spawned')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'precondition',
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.status, 'precondition-unmet')
  assert.equal(result.error.code, 'folder-kind-mismatch')
  assert.equal(existsSync(marker), false)
})

test('scripted setup failure is captured as profile-setup precondition evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-setup-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  const marker = join(root, 'spawned')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
const args = process.argv.slice(2)
if (args[0] === 'setup' && !args.includes('--apply')) {
  process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:true,data:{mode:'dry-run',plan_digest:'${'a'.repeat(64)}'}})+'\\n')
  process.exit(0)
}
process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:false,error:{code:'native-dsh-verification-failed',message:'installed tree differs'}})+'\\n')
process.exit(65)
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'spawned')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'setup-failure',
    packageSpec: join(root, 'already-built-package'),
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.status, 'precondition-unmet')
  assert.equal(result.stage, 'profile-setup')
  assert.equal(result.error.code, 'native-dsh-verification-failed')
  assert.match(result.diagnostic_bundle.name, /\.diagnostic\.json$/u)
  assert.equal(existsSync(join(root, 'artifacts', result.diagnostic_bundle.name)), true)
  assert.equal(result.session_outcome.category, 'operations-failure')
  assert.equal(result.session_outcome.code, 'native-dsh-verification-failed')
  assert.equal(result.session_outcome.component, 'operations')
  assert.equal(existsSync(result.observed.stdout.path), true)
  assert.equal(existsSync(result.observed.stderr.path), true)
  assert.equal(existsSync(marker), false)
})

test('identity drift prevents every post-task diagnostic command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-identity-drift-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  const doctorCount = join(root, 'doctor-count')
  const replacementMarker = join(root, 'replacement-ran')
  const dshPath = join(root, 'dsh.mjs')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
const fs = await import('node:fs')
const count = fs.existsSync(${JSON.stringify(doctorCount)}) ? Number(fs.readFileSync(${JSON.stringify(doctorCount)}, 'utf8')) : 0
fs.writeFileSync(${JSON.stringify(doctorCount)}, String(count + 1))
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const replacement = `#!/usr/bin/env node\nconst fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'ran')\n`
  const dsh = executable(dshPath, `
const fs = await import('node:fs')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
fs.writeFileSync(${JSON.stringify(dshPath)}, ${JSON.stringify(replacement)}, {mode:0o700})
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'identity-drift',
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.error.code, 'executable-identity-changed')
  assert.equal(result.session_outcome.status, 'failed')
  assert.equal(result.session_outcome.code, 'executable-identity-changed')
  assert.equal(readFileSync(doctorCount, 'utf8'), '1')
  assert.equal(existsSync(replacementMarker), false)
})

test('fixture provider drift prevents recovery and cleanup execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-fixture-drift-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const replacementMarker = join(root, 'replacement-ran')
  const fixturePath = join(root, 'fixture.mjs')
  mkdirSync(workdir, { mode: 0o700 })
  mkdirSync(dshHome, { mode: 0o700 })
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  fixtureProvider(fixturePath)
  const replacement = `#!/usr/bin/env node\nconst fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(replacementMarker)}, 'ran')\n`
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
fs.writeFileSync(${JSON.stringify(fixturePath)}, ${JSON.stringify(replacement)}, {mode:0o700})
process.stdout.write('DSH_ACCEPTANCE_PASS:automatic-prerequisite.non-git\\n')
`)
  const summary = runAcceptanceDrive({
    profile: 'headless-fixture-drift', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'success', scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, fixtureBin: fixturePath, dshHome,
    timeoutMs: 10_000, runId: 'fixture-drift',
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.error.code, 'executable-identity-changed')
  assert.equal(result.observed.fixture.cleanup.command.exit_code, null)
  assert.equal(existsSync(replacementMarker), false)
})

test('an unsafe result destination is rejected before DSH starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-output-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const unsafeParent = join(root, 'shared')
  const catalog = join(root, 'catalog.json')
  const marker = join(root, 'spawned')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  mkdirSync(unsafeParent, { mode: 0o755 })
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({schema_version:'cli.dsh-runtime-kit.operations.v1',ok:true,data:{schema_version:'dsh-runtime-kit.doctor.v1',status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'spawned')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  assert.throws(() => runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: join(unsafeParent, 'results.jsonl'), artifactDir: join(root, 'artifacts'),
    dshBin: dsh, runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'unsafe-output',
  }), /result parent must be an owner-only real directory/u)
  assert.equal(existsSync(marker), false)
})

test('task failure scans every zstd frame, accepts typed runtime context, and excludes prompt reminders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-transcript-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'non-git', {
    expected_reminders: ['prompt-only-reminder', 'runtime-context-reminder', 'later-frame-reminder'],
    forbidden_outcomes: ['forbidden-output', 'silent-stop'],
  })
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const first = zlib.zstdCompressSync(Buffer.from(
  JSON.stringify({type:'user/message',data:{content:'prompt-only-reminder'}})+'\\n'+
  JSON.stringify({type:'tool/call',data:{callId:'runtime-context-1',name:'runtime_context',arguments:'{"intent":"project-dev"}'}})+'\\n'+
  JSON.stringify({type:'tool/result',data:{message:{source:{kind:'tool',callId:'runtime-context-1'},content:[{type:'tool-result',isError:false,content:[{type:'text',text:'runtime-context-reminder'}]}]}}})+'\\n'
))
const second = zlib.zstdCompressSync(Buffer.from(JSON.stringify({type:'tool/result',data:{message:{content:[{type:'tool-result',isError:true,content:[{type:'text',text:'later-frame-reminder decision.allow dsh.a-rule decision.block dsh.z-rule'}]}]}}})+'\\n'))
fs.writeFileSync(path.join(sessions, 'multi.jsonl.zstd'), Buffer.concat([first, second]))
process.stdout.write('forbidden-output\\n')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'task-failure',
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.equal(result.error.code, 'scenario-outcome-mismatch')
  assert.equal(result.observed.success_marker_seen, true)
  assert.deepEqual(result.observed.missing_reminders, ['prompt-only-reminder'])
  assert.deepEqual(result.observed.forbidden_outcomes_seen, ['forbidden-output'])
  assert.deepEqual(result.observed.policy_decisions.rule_ids, ['dsh.a-rule', 'dsh.z-rule'])
  assert.equal(result.session_outcome.category, 'tool-denial')
  assert.equal(result.session_outcome.code, 'policy-denied')
})

test('successful tool reads in either transcript shape cannot manufacture decision evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-transcript-read-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'non-git', { forbidden_outcomes: ['owner-unclaimed'] })
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const nested = {type:'tool/result',data:{message:{content:[{type:'tool-result',isError:false,content:[{type:'text',text:'id = "dsh.owner-unclaimed" decision.block'}]}]}}}
const topLevel = {type:'tool/result',data:{content:[{type:'tool-result',isError:false,content:[{type:'text',text:'id = "dsh.owner-unclaimed" decision.block'}]}]}}
fs.writeFileSync(path.join(sessions, 'read.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(nested)+'\\n'+JSON.stringify(topLevel)+'\\n')))
process.stderr.write('reasoning about owner-unclaimed is not an outcome\\n')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'successful-read',
  })
  assert.equal(summary.status, 'pass')
  const [result] = rows(output)
  assert.deepEqual(result.observed.forbidden_outcomes_seen, [])
  assert.deepEqual(result.observed.policy_decisions, {
    source: 'unavailable', actions: [], rule_ids: [],
  })
})

test('structured stderr still reports forbidden runtime outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-structured-stderr-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'non-git', { forbidden_outcomes: ['policy-unavailable'] })
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stderr.write(JSON.stringify({schema_version:'dsh.runtime-error.v1',error:{code:'policy-unavailable'}})+'\\n')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)
  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'structured-stderr',
  })
  assert.equal(summary.status, 'fail')
  assert.deepEqual(rows(output)[0].observed.forbidden_outcomes_seen, ['policy-unavailable'])
})

test('an unscannable changed transcript fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-corrupt-transcript-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
fs.writeFileSync(path.join(sessions, 'corrupt.jsonl.zstd'), 'not-a-zstd-frame')
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'corrupt-transcript',
  })
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.equal(result.error.code, 'transcript-invalid')
  assert.equal(result.observed.transcript_scan_error.code, 'transcript-invalid')
})

test('aggregate transcript expansion is bounded across concatenated frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-transcript-budget-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const line = JSON.stringify({type:'tool/result',data:{message:'x'.repeat(9 * 1024 * 1024)}})+'\\n'
const frame = zlib.zstdCompressSync(Buffer.from(line))
fs.writeFileSync(path.join(sessions, 'oversized.jsonl.zstd'), Buffer.concat([frame, frame]))
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'transcript-budget',
  })
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.equal(result.error.code, 'transcript-budget-exceeded')
})

test('acceptance-drive rejects a writable executable before running setup or DSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-writable-executable-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)
  chmodSync(dsh, 0o777)

  assert.throws(() => runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'writable-executable',
  }), /not group\/other-writable/u)
  assert.equal(existsSync(output), false)
})

test('model stdout cannot impersonate a runtime-health failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-health-stdout-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('HealthProbeFailure: DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID\\n')
process.exit(1)
`)

  runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'health-stdout',
  })
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.equal(result.session_outcome.code, 'session-failed')
  assert.notEqual(result.session_outcome.code, 'dsh-runtime-health-companion-identity-invalid')
  assert.equal(result.session_outcome.component, 'session')
})

test('automatic-prerequisite accepts its induced pre-model project-audit refusal and clean retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-project-audit-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
if (!fs.existsSync('.fixture-recovered')) {
  process.stderr.write('dsh: DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID: LLM call denied by a monotonic guard\\n')
  process.exit(70)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'recovery')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'tool/call',data:{callId:'runtime-context-1',name:'runtime_context',arguments:'{"intent":"project-dev"}'}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId:'runtime-context-1'},content:[{type:'tool-result',isError:false,content:[{type:'text',text:'Follow the current repository instructions'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'success.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'project-audit-refusal',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  assert.equal(summary.status, 'pass')
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.session_outcome.category, 'health-failure')
  assert.equal(result.session_outcome.component, 'runtime-health')
  assert.equal(result.session_outcome.code, 'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID')
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.observed.fixture.clean_retry.status, 'pass')
})

test('runtime-health accepts only its induced companion-identity refusal and clean retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-companion-health-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
if (!fs.existsSync('.fixture-recovered')) {
  process.stderr.write('HealthProbeFailure: DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID\\n')
  process.exit(1)
}
process.stdout.write('DSH_ACCEPTANCE_RECOVERED:runtime-health.non-git\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['runtime-health.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'companion-health-refusal',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  assert.equal(summary.status, 'pass')
  const [result] = rows(output)
  assert.equal(result.status, 'pass')
  assert.equal(result.session_outcome.category, 'health-failure')
  assert.equal(result.session_outcome.code, 'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.observed.fixture.clean_retry.status, 'pass')
})

test('evidence traversal fails the row on an aggregate tree budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-evidence-budget-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const sessions = path.join(process.env.DSH_HOME, 'sessions')
for (let index = 0; index < 4100; index += 1) fs.mkdirSync(path.join(sessions, String(index)), {recursive:true})
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'evidence-budget',
  })
  const [result] = rows(output)
  assert.equal(result.status, 'fail')
  assert.equal(result.error.code, 'evidence-budget-exceeded')
  assert.equal(result.observed.evidence_capture_error.code, 'evidence-budget-exceeded')
})

test('successful package setup binds command artifacts and executable identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-provenance-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
const args = process.argv.slice(2)
const data = args[0] === 'setup' && !args.includes('--apply')
  ? {mode:'dry-run',plan_digest:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}
  : args[0] === 'doctor' ? {status:'healthy'} : {mode:'apply',status:'applied'}
process.stdout.write(JSON.stringify({ok:true,data})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write('DSH_ACCEPTANCE_PASS:scripted-provider.non-git\\n')
`)

  runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'package-provenance',
    packageSpec: join(root, 'built-package'),
  })
  const [result, summary] = rows(output)
  assert.equal(result.status, 'pass')
  assert.match(result.run_context.dsh_executable.sha256, /^[a-f0-9]{64}$/u)
  assert.match(result.run_context.runtime_kit_executable.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(result.run_context.package_setup.plan_digest, 'a'.repeat(64))
  assert.equal(existsSync(result.run_context.package_setup.preview.stdout.path), true)
  assert.equal(existsSync(result.run_context.package_setup.apply.stdout.path), true)
  assert.deepEqual(summary.run_context, result.run_context)
})

test('a failed fixture start still runs and records best-effort cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-fixture-cleanup-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dshMarker = join(root, 'dsh-ran')
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(dshMarker)}, 'ran')
`)
  const partial = join(workdir, '.partial-fixture')
  const fixture = executable(join(root, 'fixture.mjs'), `
const fs = await import('node:fs')
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const stage = value('--stage')
if (stage === 'induce') {
  fs.writeFileSync(${JSON.stringify(partial)}, 'partial')
  process.stdout.write('{"ok":false}\\n')
  process.exit(1)
}
fs.rmSync(${JSON.stringify(partial)}, {force:true})
process.stdout.write(JSON.stringify({
  schema_version:'dsh-runtime-kit.acceptance-fixture-result.v1',ok:true,
  data:{status:'pass',stage,phase:value('--phase'),family:value('--family'),scenario_id:value('--scenario'),
    evidence:[{kind:'fixture-cleanup',reference:'cleanup.json',sha256:'${'b'.repeat(64)}'}]},
})+'\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, fixtureBin: fixture, dshHome, timeoutMs: 10_000,
    runId: 'fixture-start-cleanup',
  })
  assert.equal(summary.status, 'fail')
  const [result] = rows(output)
  assert.equal(result.status, 'precondition-unmet')
  assert.equal(result.error.code, 'fixture-stage-failed')
  assert.equal(result.fixture_cleanup.status, 'pass')
  assert.equal(result.fixture_cleanup.receipt.stage, 'cleanup')
  assert.equal(existsSync(partial), false)
  assert.equal(existsSync(dshMarker), false)
})

test('report-issue writes a bounded draft for failures without invoking a provider command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-report-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  const draft = join(root, 'heuristic-issue.md')
  const providerMarker = join(root, 'provider-was-called')
  const fakeBin = join(root, 'bin')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  mkdirSync(fakeBin)
  fixtureCatalog(catalog)
  executable(join(fakeBin, 'forge-cli'), `
const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(providerMarker)}, 'called')
process.exit(99)
`)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
process.stderr.write('provider unavailable\\n')
process.exit(1)
`)

  const previousPath = process.env.PATH
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
  try {
    const summary = runAcceptanceDrive({
      profile: 'headless', catalogPath: catalog, scenarioIds: ['scripted-provider.non-git'],
      workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
      runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'draft-only',
      reportIssuePath: draft,
    })
    assert.equal(summary.status, 'fail')
    assert.equal(existsSync(providerMarker), false)
    const body = readFileSync(draft, 'utf8')
    assert.match(body, /workflow::heuristic-records/u)
    assert.match(body, /## Observed/u)
    assert.match(body, /## Expected/u)
    assert.match(body, /## Bounded impact/u)
    assert.match(body, /## Reproduction/u)
    assert.match(body, /## Current workaround/u)
    assert.doesNotMatch(body, new RegExp(root, 'u'))
    const [result, writtenSummary] = rows(output)
    assert.equal(result.session_outcome.schema_version, 'dsh-runtime-kit.session-outcome.v1')
    assert.equal(result.session_outcome.category, 'provider-failure')
    assert.match(body, new RegExp(result.diagnostic_bundle.name, 'u'))
    assert.match(body, new RegExp(result.diagnostic_bundle.sha256, 'u'))
    assert.equal(writtenSummary.report_issue_draft.sha256.length, 64)
  } finally {
    process.env.PATH = previousPath
  }
})

test('success marker is recognised as a line token and not as a substring of another marker', async () => {
  const scenario = 'scripted-provider.non-git'
  const marker = `DSH_ACCEPTANCE_PASS:${scenario}`
  for (const [trailer, expected] of [[' immediately', true], ['-success', false]] as const) {
    const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-marker-'))
    const workdir = join(root, 'plain')
    const dshHome = join(root, 'dsh-home')
    const output = join(root, 'results.jsonl')
    const catalog = join(root, 'catalog.json')
    mkdirSync(workdir)
    mkdirSync(dshHome)
    fixtureCatalog(catalog, 'non-git')
    const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
    const dsh = executable(join(root, 'dsh.mjs'), `
process.stdout.write(${JSON.stringify(`${marker}${trailer}\n`)})
`)
    const summary = runAcceptanceDrive({
      profile: 'headless', catalogPath: catalog, scenarioIds: [scenario],
      workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
      runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: `marker-${expected}`,
    })
    const [result] = rows(output)
    assert.equal(
      result.observed.success_marker_seen,
      expected,
      `trailer ${JSON.stringify(trailer)} must ${expected ? 'satisfy' : 'not satisfy'} the marker`,
    )
    assert.equal(summary.status, expected ? 'pass' : 'fail')
  }
})

// A clean retry is necessary but not sufficient evidence: process output is
// model-controlled and cannot prove which fixture induction the first leg saw.
function reportAndStopDsh(root: string, failureTask: string) {
  return executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
// Exactly what the packaged probe writes when it reaches the staged condition.
process.stderr.write(JSON.stringify({status:'induced',code:'retired-surface-unreachable',surface_id:'workspace-lease-quarantine-registry'})+'\\n')
process.stdout.write('The staged probe reported retired-surface-unreachable; stopping without the recovery marker.\\n')
`)
}

test('model-authored induced JSON in process output cannot satisfy deliberate failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-report-and-stop-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.non-git',
  )!.deliberate_failure_task

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG,
    scenarioPackPath: join(ROOT, 'compatibility', 'acceptance-scenario-pack.json'),
    phase: 'deliberate-failure',
    scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'),
    dshBin: reportAndStopDsh(root, failureTask),
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'report-and-stop',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.session_outcome.status, 'completed', 'a complying session exits cleanly')
  assert.equal(result.observed.success_marker_seen, false, 'the induced leg must not claim recovery')
  assert.equal(result.observed.induced_failure, undefined)
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.observed.fixture.clean_retry, undefined)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

test('an infrastructure failure in the induced leg is not an observed induced failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-infra-leg-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.non-git',
  )!.deliberate_failure_task
  // The provider, not the staged induction, ended this leg. Recovering and
  // passing a clean retry must not launder that into an accepted row.
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
process.stderr.write('dsh: QUOTA: usage limit reached\\n')
process.exit(1)
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG,
    scenarioPackPath: join(ROOT, 'compatibility', 'acceptance-scenario-pack.json'),
    phase: 'deliberate-failure',
    scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'infra-leg',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

test('prose about an induced failure is not accepted without the typed probe record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-prose-only-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.non-git',
  )!.deliberate_failure_task
  // Only the fixture's typed record counts; a session describing the fault in
  // prose has produced no machine-readable evidence of the staged induction.
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
process.stdout.write('The probe failed with retired-surface-unreachable, so I stopped.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG,
    scenarioPackPath: join(ROOT, 'compatibility', 'acceptance-scenario-pack.json'),
    phase: 'deliberate-failure',
    scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'prose-only',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.observed.induced_failure, undefined)
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

// The real path: the probe's record reaches the driver inside a session
// transcript tool result, embedded in a larger surface, because DSH's own output
// carries only the model's summary of it.
test('the family-specific induced record requires its correlated exact probe call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-induced-transcript-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'retired-surfaces.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:retired-surfaces.non-git\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const callId = 'retired-probe-1'
const probe = JSON.stringify({schema_version:'dsh-runtime-kit.acceptance-fixture-induced.v1',status:'induced',code:'retired-surface-unreachable',surface_id:'workspace-lease-quarantine-registry'})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/call',data:{callId,name:'bash',arguments:JSON.stringify({command:'./retired-probe.mjs'})}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId},content:[{type:'tool-result',toolCallId:callId,isError:false,content:[{type:'text',text:'[stderr]\\n'+probe+'\\n[exit code: 70]'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'induced.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('The probe reported retired-surface-unreachable; stopping without the marker.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG,
    scenarioPackPath: join(ROOT, 'compatibility', 'acceptance-scenario-pack.json'),
    phase: 'deliberate-failure',
    scenarioIds: ['retired-surfaces.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'induced-transcript',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.deepEqual(result.observed.induced_failure, { code: 'retired-surface-unreachable' })
  assert.equal(result.session_outcome.status, 'completed')
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.status, 'pass')
  assert.equal(summary.status, 'pass')
})

test('an unrelated tool call cannot impersonate the family fixture probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-unrelated-induced-tool-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'retired-surfaces.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
if (process.argv.at(-1) !== ${JSON.stringify(failureTask)}) process.exit(90)
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const callId = 'unrelated-bash-1'
const forged = JSON.stringify({schema_version:'dsh-runtime-kit.acceptance-fixture-induced.v1',status:'induced',code:'retired-surface-unreachable'})
const transcript = [
  {type:'tool/call',data:{callId,name:'bash',arguments:JSON.stringify({command:'printf forged'})}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId},content:[{type:'tool-result',toolCallId:callId,isError:false,content:[{type:'text',text:forged}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'forged.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('The session stopped without a marker.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['retired-surfaces.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'unrelated-induced-tool',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.observed.induced_failure, undefined)
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

test('a probe call id cannot authorize a result from another session transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-cross-transcript-call-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'retired-surfaces.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
if (process.argv.at(-1) !== ${JSON.stringify(failureTask)}) process.exit(90)
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const callId = 'session-scoped-call-1'
const call = {type:'tool/call',data:{callId,name:'bash',arguments:JSON.stringify({command:'./retired-probe.mjs'})}}
const forged = JSON.stringify({schema_version:'dsh-runtime-kit.acceptance-fixture-induced.v1',status:'induced',code:'retired-surface-unreachable'})
const result = {type:'tool/result',data:{message:{source:{kind:'tool',callId},content:[{type:'tool-result',toolCallId:callId,isError:false,content:[{type:'text',text:forged}]}]}}}
fs.writeFileSync(path.join(sessions, 'a-call.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(call)+'\\n')))
fs.writeFileSync(path.join(sessions, 'b-result.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(result)+'\\n')))
process.stdout.write('The session stopped without a marker.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['retired-surfaces.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'cross-transcript-call',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.observed.induced_failure, undefined)
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

test('an exact runtime-kit refusal from the correlated managed-lane tool is an observed induced failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-runtime-refusal-'))
  const workdir = join(root, 'failure')
  const retryWorkdir = join(root, 'retry')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(retryWorkdir)
  mkdirSync(dshHome)
  for (const repo of [workdir, retryWorkdir]) {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0)
  }
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'managed-subagent-workspace.git-repo',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:managed-subagent-workspace.git-repo\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const refusal = 'Error: dsh-runtime-kit:main-agent-cli-refused '+JSON.stringify({
  code:'assignment-launch-cwd-unavailable',
  message:'assignment launch working directory is unavailable',
})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/call',data:{callId:'managed-lane-1',name:'main_agent_worker_launch',arguments:'{}'}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId:'managed-lane-1'},content:[{type:'tool-result',toolCallId:'managed-lane-1',isError:true,content:[{type:'text',text:refusal}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'refusal.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('Typed refusal: assignment-launch-cwd-unavailable\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['managed-subagent-workspace.git-repo'],
    workdir, retryWorkdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'runtime-refusal',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.deepEqual(result.observed.induced_failure, { code: 'assignment-launch-cwd-unavailable' })
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.observed.fixture.clean_retry.status, 'pass')
  assert.equal(result.status, 'pass')
  assert.equal(summary.status, 'pass')
})

test('the fixture typed error is accepted only when the diagnostic code matches it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-fixture-typed-error-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'authoritative-acceptance.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:authoritative-acceptance.non-git\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const fixtureError = JSON.stringify({
  schema_version:'cli.dsh-runtime-kit.acceptance-fixture.v1',
  ok:false,
  error:{code:'acceptance-fixture-induced-failure',message:'The authenticated fixture fault is active.'},
})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/call',data:{callId:'fixture-validation-1',name:'bash',arguments:JSON.stringify({command:'./fixture-validation.mjs'})}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId:'fixture-validation-1'},content:[{type:'tool-result',toolCallId:'fixture-validation-1',isError:false,content:[{type:'text',text:'[stderr]\\n'+fixtureError+'\\n[exit code: 1]'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'fixture-error.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('The exact fixture validation reported its typed induced failure.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['authoritative-acceptance.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'fixture-typed-error',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.deepEqual(result.observed.induced_failure, { code: 'acceptance-fixture-induced-failure' })
  assert.equal(result.session_outcome.category, 'unknown')
  assert.equal(result.session_outcome.code, result.observed.induced_failure.code)
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.observed.fixture.clean_retry.status, 'pass')
  assert.equal(result.status, 'pass')
  assert.equal(summary.status, 'pass')
})

test('the governed family accepts the exact agent-hook default-delivery refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-governed-hook-refusal-'))
  const workdir = join(root, 'failure')
  const retryWorkdir = join(root, 'retry')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(retryWorkdir)
  mkdirSync(dshHome)
  assert.equal(spawnSync('git', ['init', '--initial-branch=acceptance/failure'], { cwd: workdir }).status, 0)
  assert.equal(spawnSync('git', ['init', '--initial-branch=acceptance/retry'], { cwd: retryWorkdir }).status, 0)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'governed-commit.git-repo',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  const recoverySessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'recovery')
  fs.mkdirSync(recoverySessions, {recursive:true})
  const recoveryTranscript = [
    {type:'session',cwd:process.cwd(),createdAt:Date.now()},
    {type:'tool/call',data:{callId:'runtime-context-retry-1',name:'runtime_context',arguments:'{}'}},
    {type:'tool/result',data:{message:{source:{kind:'tool',callId:'runtime-context-retry-1'},content:[{type:'tool-result',toolCallId:'runtime-context-retry-1',isError:false,content:[{type:'text',text:'Use runtime_kit_governed_commit for the governed delivery seam.'}]}]}}},
    {type:'tool/call',data:{callId:'governed-retry-1',name:'runtime_kit_governed_commit',arguments:'{}'}},
    {type:'tool/result',data:{message:{source:{kind:'tool',callId:'governed-retry-1'},content:[{type:'tool-result',toolCallId:'governed-retry-1',isError:false,content:[{type:'text',text:'governed recovery validation passed'}]}]}}},
  ].map(row => JSON.stringify(row)).join('\\n')+'\\n'
  fs.writeFileSync(path.join(recoverySessions, 'success.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(recoveryTranscript)))
  process.stdout.write('runtime_kit_governed_commit\\nDSH_ACCEPTANCE_RECOVERED:governed-commit.git-repo\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/call',data:{callId:'governed-1',name:'runtime_kit_governed_commit',arguments:'{}'}},
  {type:'tool/result',data:{message:{source:{kind:'tool',callId:'governed-1'},content:[{type:'tool-result',toolCallId:'governed-1',isError:true,content:[{type:'text',text:'Error: agent-hook:block-unsafe-default-delivery — Mutating the default branch directly is a governed seam.'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'refusal.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('The exact governed precondition refusal was observed.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['governed-commit.git-repo'],
    workdir, retryWorkdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'governed-hook-refusal',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.session_outcome.status, 'failed')
  assert.equal(result.session_outcome.category, 'tool-denial')
  assert.equal(result.session_outcome.code, 'dsh.block-unsafe-default-delivery')
  assert.equal(result.observed.expected_failure_observed, true)
  assert.equal(result.observed.fixture.clean_retry.status, 'pass')
  assert.equal(result.status, 'pass')
  assert.equal(summary.status, 'pass')
})

test('a cross-family governed-tool rejection cannot satisfy prerequisite induction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-governed-rejection-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const failureTask = loadAcceptanceCatalog(CATALOG).scenarios.find(
    row => row.id === 'automatic-prerequisite.non-git',
  )!.deliberate_failure_task
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const task = process.argv.at(-1)
if (task !== ${JSON.stringify(failureTask)}) process.exit(90)
if (fs.existsSync('.fixture-recovered')) {
  process.stdout.write('DSH_ACCEPTANCE_RECOVERED:automatic-prerequisite.non-git\\n')
  process.exit(0)
}
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/result',data:{error:{name:'HarnessError',code:'GOVERNED_COMMIT_REJECTED'},message:{content:[{type:'tool-result',isError:true,content:[{type:'text',text:'Error: semantic-commit rejected the governed commit'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'failure.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('The governed tool refused the operation, so I stopped without a marker.\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: CATALOG, scenarioPackPath: PACK,
    phase: 'deliberate-failure', scenarioIds: ['automatic-prerequisite.non-git'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'governed-rejection',
    fixtureBin: fixtureProvider(join(root, 'fixture.mjs')),
  })

  const [result] = rows(output)
  assert.equal(result.session_outcome.status, 'failed')
  assert.equal(result.session_outcome.category, 'tool-denial')
  assert.equal(result.session_outcome.code, 'GOVERNED_COMMIT_REJECTED')
  assert.equal(result.observed.expected_failure_observed, false)
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})

test('a governed success marker cannot hide a rejected governed commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-governed-false-pass-'))
  const repo = join(root, 'repo')
  const workdir = join(root, 'worktree')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(repo)
  mkdirSync(dshHome)
  assert.equal(spawnSync('git', ['init', '--initial-branch=main'], { cwd: repo }).status, 0)
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  assert.equal(spawnSync('git', ['add', 'seed.txt'], { cwd: repo }).status, 0)
  assert.equal(spawnSync('git', [
    '-c', 'user.name=Acceptance Fixture',
    '-c', 'user.email=acceptance@example.invalid',
    'commit', '--no-gpg-sign', '-m', 'test: seed fixture',
  ], { cwd: repo }).status, 0)
  assert.equal(spawnSync('git', [
    'worktree', 'add', '-b', 'acceptance/feature', workdir,
  ], { cwd: repo }).status, 0)
  fixtureCatalog(catalog, 'managed-worktree', {
    id: 'governed-commit.managed-worktree',
    task: 'Create a governed commit and finish with DSH_ACCEPTANCE_PASS:governed-commit.managed-worktree.',
    success_marker: 'DSH_ACCEPTANCE_PASS:governed-commit.managed-worktree',
    deliberate_failure_task: 'Recover and finish with DSH_ACCEPTANCE_RECOVERED:governed-commit.managed-worktree.',
    deliberate_failure_success_marker: 'DSH_ACCEPTANCE_RECOVERED:governed-commit.managed-worktree',
    expected_reminders: [],
    forbidden_outcomes: ['silent-stop'],
  })
  const runtimeKit = executable(join(root, 'runtime-kit.mjs'), `
process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')
`)
  const dsh = executable(join(root, 'dsh.mjs'), `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const sessions = path.join(process.env.DSH_HOME, 'sessions', 'fixture', 'session')
fs.mkdirSync(sessions, {recursive:true})
const transcript = [
  {type:'session',cwd:process.cwd(),createdAt:Date.now()},
  {type:'tool/result',data:{error:{name:'HarnessError',code:'GOVERNED_COMMIT_REJECTED'},message:{content:[{type:'tool-result',isError:true,content:[{type:'text',text:'Error: semantic-commit rejected the governed commit'}]}]}}},
].map(row => JSON.stringify(row)).join('\\n')+'\\n'
fs.writeFileSync(path.join(sessions, 'failure.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(transcript)))
process.stdout.write('DSH_ACCEPTANCE_PASS:governed-commit.managed-worktree\\n')
`)

  const summary = runAcceptanceDrive({
    profile: 'headless', catalogPath: catalog,
    scenarioIds: ['governed-commit.managed-worktree'],
    workdir, outputPath: output, artifactDir: join(root, 'artifacts'), dshBin: dsh,
    runtimeKitBin: runtimeKit, dshHome, timeoutMs: 10_000, runId: 'governed-false-pass',
  })

  const [result] = rows(output)
  assert.equal(result.observed.success_marker_seen, true)
  assert.equal(result.session_outcome.code, 'GOVERNED_COMMIT_REJECTED')
  assert.equal(result.status, 'fail')
  assert.equal(summary.status, 'fail')
})
