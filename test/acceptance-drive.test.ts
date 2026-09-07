import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

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

function fixtureCatalog(path: string, folderKind: 'git-repo' | 'non-git' | 'managed-worktree' = 'non-git') {
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
  assert.equal(catalog.scenarios.length, 34)
  assert.equal(new Set(catalog.scenarios.map(row => row.id)).size, 34)
  for (const owner of ['#55', '#56', '#57', '#58', '#59', '#60', '#61', '#62', '#63', '#64', '#65', '#79']) {
    assert.ok(catalog.scenarios.some(row => row.owner.feature_issue === owner), `${owner} owns no scenario`)
  }
  assert.ok(catalog.scenarios.some(row => row.owner.program_child === '#E'))
  assert.deepEqual(
    [...new Set(catalog.scenarios.map(row => row.folder_kind))].sort(),
    ['git-repo', 'managed-worktree', 'non-git'],
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
  assert.equal(existsSync(result.observed.stdout.path), true)
  assert.equal(existsSync(result.observed.stderr.path), true)
  assert.equal(existsSync(marker), false)
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
