import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { parse } from 'yaml'

import { checkAgentRuntimeDrift } from '../dist/scripts/check-agent-runtime-drift.js'

const run = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
const PIN = '1809e49ea7f14759afde7e154c065cf38e80ee57'
const DISPOSITIONS = ['synced', 'dsh-native', 'retired', 'not-applicable', 'open-issue']

test('the alignment record pins every agent-runtime-kit skill, policy, and home surface', () => {
  const record = JSON.parse(read('compatibility/agent-runtime-alignment.json'))
  assert.equal(record.schema_version, 'dsh-runtime-kit.agent-runtime-alignment.v1')
  assert.deepEqual(record.source, { repository: 'github.com/sympoies/agent-runtime-kit', commit: PIN })
  assert.deepEqual(record.watched_paths, [
    'AGENT_HOME.md',
    'core/hooks/',
    'core/policies/',
    'core/skills/',
    'manifests/hook-rules.yaml',
  ])
  // Both parity manifests and the record bind one source commit.
  assert.equal(parse(read('policy/rule-parity.yaml')).source.commit, PIN)
  assert.equal(parse(read('policy/runtime-rule-parity.yaml')).source.commit, PIN)

  const sources = record.entries.map(entry => entry.source)
  assert.deepEqual(sources, [...sources].sort(), 'entries are sorted by source path')
  assert.equal(new Set(sources).size, sources.length, 'entries are unique')
  const byKind = kind => record.entries.filter(entry => entry.kind === kind)
  assert.equal(byKind('skill').length, 28)
  assert.equal(byKind('policy').length, 16)
  assert.deepEqual(byKind('home').map(entry => entry.source), ['AGENT_HOME.md'])
  assert.deepEqual(byKind('hook-manifest').map(entry => entry.source), ['manifests/hook-rules.yaml'])
  assert.deepEqual(byKind('hooks').map(entry => entry.source), ['core/hooks/'])

  for (const entry of record.entries) {
    assert.ok(DISPOSITIONS.includes(entry.disposition), `${entry.source}: ${entry.disposition}`)
    if (entry.disposition === 'open-issue') {
      assert.match(entry.issue, /^sympoies\/[a-z0-9-]+#\d+$/u, entry.source)
    } else {
      assert.equal(entry.issue, undefined, entry.source)
    }
    if (entry.disposition === 'not-applicable') {
      assert.deepEqual(entry.dsh_paths, [], entry.source)
    } else {
      assert.ok(entry.dsh_paths.length > 0, `${entry.source} names its DSH surface`)
    }
    for (const path of entry.dsh_paths) {
      assert.ok(existsSync(join(projectRoot, path)), `${entry.source} -> missing ${path}`)
    }
    if (entry.kind === 'skill' && entry.disposition !== 'not-applicable') {
      const name = entry.source.split('/').at(-1)
      assert.ok(entry.dsh_paths.includes(`skills/${name}/SKILL.md`), entry.source)
    }
  }
  // The guard fixes reach DSH only through a nils-cli release; the validated
  // release carries them, and test/policy-parity.test.ts proves it against the
  // released agent-hook.
  assert.deepEqual(
    record.entries.find(entry => entry.source === 'core/hooks/'),
    {
      source: 'core/hooks/',
      kind: 'hooks',
      disposition: 'synced',
      dsh_paths: ['policy/dsh-runtime-kit-v1.toml', 'policy/runtime-rule-parity.yaml'],
      note: record.entries.find(entry => entry.source === 'core/hooks/').note,
    },
  )
})

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Drift Test',
  GIT_AUTHOR_EMAIL: 'drift@example.invalid',
  GIT_COMMITTER_NAME: 'Drift Test',
  GIT_COMMITTER_EMAIL: 'drift@example.invalid',
}
const git = (cwd, ...args) => run('git', args, { cwd, encoding: 'utf8', env }).then(result => result.stdout.trim())

async function put(root, relative, content) {
  await mkdir(dirname(join(root, relative)), { recursive: true })
  await writeFile(join(root, relative), content)
}

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-runtime-drift-'))
  await git(root, 'init', '--initial-branch=main', '.')
  await put(root, 'AGENT_HOME.md', '# home\n')
  await put(root, 'manifests/hook-rules.yaml', 'rules: []\n')
  await put(root, 'core/hooks/shared/guard.py', 'pass\n')
  await put(root, 'core/policies/alpha.md', '# alpha\n')
  await put(root, 'core/policies/agent-hook/README.md', 'not a policy file\n')
  await put(root, 'core/skills/group/one/SKILL.md.tera', '# one\n')
  await put(root, 'core/skills/group/one/references/ref.md', 'ref\n')
  await put(root, 'core/skills/group/lifecycle/references/only.md', 'no skill here\n')
  await put(root, 'README.md', 'unwatched\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-q', '-m', 'pin')
  const pin = await git(root, 'rev-parse', 'HEAD')
  const record = {
    schema_version: 'dsh-runtime-kit.agent-runtime-alignment.v1',
    source: { repository: 'github.com/sympoies/agent-runtime-kit', commit: pin },
    watched_paths: ['AGENT_HOME.md', 'core/hooks/', 'core/policies/', 'core/skills/', 'manifests/hook-rules.yaml'],
    entries: [
      { source: 'AGENT_HOME.md', kind: 'home', disposition: 'synced', dsh_paths: ['agent-home/AGENTS.md'] },
      { source: 'core/hooks/', kind: 'hooks', disposition: 'dsh-native', dsh_paths: ['policy/dsh-runtime-kit-v1.toml'] },
      { source: 'core/policies/alpha.md', kind: 'policy', disposition: 'synced', dsh_paths: ['agent-docs/WORK_MODES.md'] },
      { source: 'core/skills/group/one', kind: 'skill', disposition: 'synced', dsh_paths: ['skills/deliver-pr/SKILL.md'] },
      { source: 'manifests/hook-rules.yaml', kind: 'hook-manifest', disposition: 'synced', dsh_paths: ['policy/runtime-rule-parity.yaml'] },
    ],
  }
  return { root, pin, record }
}

test('the drift check reports nothing when the source still matches its pin', async () => {
  const { root, record } = await sourceFixture()
  try {
    await put(root, 'README.md', 'an unwatched change\n')
    await git(root, 'commit', '-q', '-am', 'unwatched change')
    const report = await checkAgentRuntimeDrift({ sourceRoot: root, ref: 'HEAD', record })
    assert.equal(report.drift, false)
    assert.deepEqual(report.commits, [])
    assert.deepEqual(report.changed_paths, [])
    assert.deepEqual(report.unrecorded, [])
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.record_mismatch_at_pin, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the drift check reports changed paths, commits, and unrecorded sources after the pin', async () => {
  const { root, pin, record } = await sourceFixture()
  try {
    await put(root, 'core/policies/alpha.md', '# alpha, changed\n')
    await put(root, 'core/skills/group/two/SKILL.md.tera', '# two\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'feat: change a policy and add a skill')
    const head = await git(root, 'rev-parse', 'HEAD')
    const report = await checkAgentRuntimeDrift({ sourceRoot: root, ref: 'HEAD', record })
    assert.equal(report.pin, pin)
    assert.equal(report.ref_commit, head)
    assert.equal(report.drift, true)
    assert.deepEqual(report.commits, [{ commit: head, subject: 'feat: change a policy and add a skill' }])
    assert.deepEqual(report.changed_paths, [
      { status: 'M', path: 'core/policies/alpha.md', entry: 'core/policies/alpha.md' },
      { status: 'A', path: 'core/skills/group/two/SKILL.md.tera', entry: null },
    ])
    assert.deepEqual(report.unrecorded, ['core/skills/group/two'])
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.record_mismatch_at_pin, [])

    // A record that no longer matches its own pin is a defect, not drift.
    const stale = { ...record, entries: record.entries.filter(entry => entry.kind !== 'policy') }
    const mismatch = await checkAgentRuntimeDrift({ sourceRoot: root, ref: pin, record: stale })
    assert.equal(mismatch.drift, false)
    assert.deepEqual(mismatch.record_mismatch_at_pin, ['unrecorded core/policies/alpha.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the drift check reports removed sources, nested skill edits, and an unknown pin', async () => {
  const { root, record } = await sourceFixture()
  try {
    await put(root, 'core/skills/group/one/references/ref.md', 'ref, changed\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'docs: edit a nested skill reference')
    const nested = await checkAgentRuntimeDrift({ sourceRoot: root, ref: 'HEAD', record })
    assert.equal(nested.drift, true)
    assert.deepEqual(nested.changed_paths, [
      { status: 'M', path: 'core/skills/group/one/references/ref.md', entry: 'core/skills/group/one' },
    ])

    await git(root, 'rm', '-rq', 'core/skills/group/one')
    await git(root, 'commit', '-q', '-m', 'feat: retire a skill')
    const removed = await checkAgentRuntimeDrift({ sourceRoot: root, ref: 'HEAD', record })
    assert.equal(removed.drift, true)
    assert.deepEqual(removed.removed, ['core/skills/group/one'])
    assert.ok(removed.changed_paths.some(row => row.status === 'D' && row.entry === 'core/skills/group/one'))

    const unknownPin = { ...record, source: { ...record.source, commit: '0'.repeat(40) } }
    await assert.rejects(checkAgentRuntimeDrift({ sourceRoot: root, ref: 'HEAD', record: unknownPin }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the hook manifest stays open on R1 while removed reminders are still selected', () => {
  const record = JSON.parse(read('compatibility/agent-runtime-alignment.json'))
  const manifest = record.entries.find(entry => entry.source === 'manifests/hook-rules.yaml')
  const runtime = read('policy/runtime-rule-parity.yaml')
  if (/follow_up: sympoies\/dsh-runtime-kit#313/u.test(runtime)) {
    assert.equal(manifest.disposition, 'open-issue')
    assert.equal(manifest.issue, 'sympoies/dsh-runtime-kit#313')
  }
})

test('a scheduled non-blocking workflow runs the drift check against agent-runtime-kit main', () => {
  const workflow = read('.github/workflows/agent-runtime-drift.yml')
  assert.match(workflow, /schedule:\s*\n\s*- cron: '[^']+'/u)
  assert.match(workflow, /workflow_dispatch:/u)
  assert.match(workflow, /repository: sympoies\/agent-runtime-kit/u)
  assert.match(workflow, /ref: main/u)
  assert.match(workflow, /continue-on-error: true/u)
  assert.match(workflow, /npm run check:agent-runtime-drift -- --source /u)
  assert.match(workflow, /--format github/u)
  assert.doesNotMatch(workflow, /pull_request|push:/u, 'drift must never gate delivery')
  const manifest = JSON.parse(read('package.json'))
  assert.equal(
    manifest.scripts['check:agent-runtime-drift'],
    'node dist/scripts/check-agent-runtime-drift.js',
  )
})
