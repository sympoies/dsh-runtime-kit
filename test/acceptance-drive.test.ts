import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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

function executable(path: string, source: string) {
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function fixtureCatalog(
  path: string,
  folderKind: 'git-repo' | 'non-git' | 'managed-worktree' = 'non-git',
  overrides: Record<string, unknown> = {},
) {
  const value = {
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    scenarios: [{
      id: 'scripted-provider.non-git',
      owner: { program_child: '#D', feature_issue: '#57' },
      preconditions: ['A healthy installed headless profile is available.'],
      folder_kind: folderKind,
      task: 'Create result.txt and finish with DSH_ACCEPTANCE_PASS:scripted-provider.non-git.',
      success_marker: 'DSH_ACCEPTANCE_PASS:scripted-provider.non-git',
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
  assert.equal(catalog.schema_version, 'dsh-runtime-kit.acceptance-scenarios.v1')
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
})

test('acceptance-harness is a Codex and Claude project intent', () => {
  const catalog = readFileSync(join(ROOT, 'AGENT_DOCS.toml'), 'utf8')
  assert.match(catalog, /context = "acceptance-harness"/u)
  assert.match(catalog, /path = "docs\/acceptance-harness\.md"/u)
  assert.match(catalog, /product = \["codex", "claude"\]/u)
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
fs.writeFileSync(path.join(sessions, 'scripted.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify({type:'tool/result',data:{content:[{type:'text',text:'decision.context dsh.skill-usage-reminder'}]}})+'\\n')))
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

test('task failure scans every zstd frame and excludes user prompt reminders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-drive-transcript-'))
  const workdir = join(root, 'plain')
  const dshHome = join(root, 'dsh-home')
  const output = join(root, 'results.jsonl')
  const catalog = join(root, 'catalog.json')
  mkdirSync(workdir)
  mkdirSync(dshHome)
  fixtureCatalog(catalog, 'non-git', {
    expected_reminders: ['prompt-only-reminder', 'later-frame-reminder'],
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
const first = zlib.zstdCompressSync(Buffer.from(JSON.stringify({type:'user/message',data:{content:'prompt-only-reminder'}})+'\\n'))
const second = zlib.zstdCompressSync(Buffer.from(JSON.stringify({type:'tool/result',data:{message:'later-frame-reminder decision.allow dsh.a-rule decision.block dsh.z-rule'}})+'\\n'))
fs.writeFileSync(path.join(sessions, 'multi.jsonl.zstd'), Buffer.concat([first, second]))
process.stderr.write('forbidden-output\\n')
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
