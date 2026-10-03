import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const read = relative => readFileSync(join(projectRoot, relative), 'utf8')

test('the package ships one DSH home instructions document as a declared activation asset', () => {
  const manifest = JSON.parse(read('package.json'))
  const lifecycle = JSON.parse(read('compatibility/profile-lifecycle.json'))

  assert.ok(manifest.files.includes('agent-home'))
  assert.equal(lifecycle.activation_assets.home, 'agent-home/AGENTS.md')
  assert.ok(lifecycle.owned_surfaces.home.includes('agent-home-instructions'))
})

test('DSH keeps its native instruction loader configuration', () => {
  // Every composition, including agent presets, reads the default
  // `<dshHome>/AGENTS.md`; activation installs the managed file there instead
  // of redirecting the loader.
  assert.doesNotMatch(read('cordis.patch.yml'), /agent-instructions|dshHome|DSH_RUNTIME_KIT_AGENT_HOME/u)
})

test('the DSH home instructions keep the shared home rules and only DSH-native routing', () => {
  const home = read('agent-home/AGENTS.md')

  // 4,096 held the shared rules; peer-coordination routing (#311) needs the rest.
  assert.ok(Buffer.byteLength(home) <= 4608, 'home instructions must stay compact')
  assert.match(home, /^# /u)
  assert.match(home, /voice input as a speech transcript that may contain\s+misrecognized words/u)
  for (const surface of [
    'ask_user_question',
    'runtime_context',
    'project-dev',
    'runtime_kit_governed_commit',
    'git-cli worktree',
    'semantic-commit',
    'forge-cli',
    'artifact_',
  ]) {
    assert.ok(home.includes(surface), `home instructions must name ${surface}`)
  }
  // The governed commit tool is bound to the session cwd; other worktrees commit by path.
  assert.match(home, /runtime_kit_governed_commit[^.]*session cwd/u)
  assert.match(home, /semantic-commit commit --repo/u)
  for (const foreign of [
    /AGENT_DOCS\.toml/u,
    /intent-cards/u,
    /core\/policies/u,
    /task-tools|browser-test|session-coordination/u,
    /AskUserQuestion/u,
    /CLAUDE\.md|Codex|Claude|Hermes/u,
    /agent-out/u,
    /agent-runtime-kit/u,
    /[^\x00-\x7F]/u,
  ]) {
    assert.doesNotMatch(home, foreign)
  }
})

test('the home instructions record their upstream provenance outside the model-facing file', () => {
  const architecture = read('docs/architecture.md')
  assert.ok(/github\.com\/sympoies\/agent-runtime-kit[\s\S]{0,200}AGENT_HOME\.md/u.test(architecture), 'architecture must record the upstream source')
  assert.ok(architecture.includes('agent-home/AGENTS.md'), 'architecture must name the packaged document')
})

// Every packaged policy document, the runtime_context intent that returns it,
// and its phase (`null` for a phaseless intent).
const PACKAGED_POLICIES = [
  ['PROJECT_DEV_EDIT.md', 'project-dev', 'edit'],
  ['WORK_MODES.md', 'project-dev', 'delivery'],
  ['GIT_DELIVERY.md', 'project-dev', 'delivery'],
  ['REVIEW_CONVERGENCE.md', 'project-dev', 'review'],
  ['EVIDENCE.md', 'project-dev', 'review'],
  ['DEVLOG.md', 'devlog', null],
  ['EXTERNAL_FACTS.md', 'external-facts', null],
  ['BROWSER_TESTING.md', 'web-testing', null],
  ['MEMORY.md', 'memory', null],
  ['UPSTREAM_CONTRIBUTION.md', 'upstream-contribution', null],
  ['PEER_COORDINATION.md', 'peer-coordination', null],
]
// The default runtime_context budget is 20 KiB; leave room for project documents.
const MAX_PACKAGED_BYTES_PER_CALL = 18 * 1024

function catalogEntries() {
  return read('agent-docs/AGENT_DOCS.toml').split(/^\[\[document\]\]$/mu).slice(1).map(entry => ({
    path: entry.match(/^path = "([^"]+)"$/mu)?.[1],
    context: entry.match(/^context = "([^"]+)"$/mu)?.[1],
    phase: entry.match(/^phase = "([^"]+)"$/mu)?.[1] ?? null,
    scope: entry.match(/^scope = "([^"]+)"$/mu)?.[1],
    product: entry.match(/^product = "([^"]+)"$/mu)?.[1],
    required: /^required = true$/mu.test(entry),
  }))
}

test('the packaged catalog routes every home policy to one DSH-native intent and phase', () => {
  const entries = catalogEntries()
  assert.deepEqual(
    entries.map(entry => [entry.path, entry.context, entry.phase]).sort(),
    [...PACKAGED_POLICIES].sort(),
  )
  for (const entry of entries) {
    assert.equal(entry.scope, 'home', `${entry.path} must be home scope`)
    assert.equal(entry.product, 'dsh', `${entry.path} must be DSH-only`)
    assert.equal(entry.required, true, `${entry.path} must be required to be returned`)
  }
  // The edit-phase prerequisite injects only the compact edit contract.
  assert.deepEqual(entries.filter(entry => entry.phase === 'edit').map(entry => entry.path), ['PROJECT_DEV_EDIT.md'])
  const packaged = readdirSync(join(projectRoot, 'agent-docs')).filter(name => name.endsWith('.md')).sort()
  assert.deepEqual(packaged, PACKAGED_POLICIES.map(([path]) => path).sort())
})

test('every runtime_context intent and phase fits the default context budget', () => {
  const totals = new Map()
  for (const [path, intent, phase] of PACKAGED_POLICIES) {
    const key = `${intent}:${phase ?? 'default'}`
    totals.set(key, (totals.get(key) ?? 0) + Buffer.byteLength(read(`agent-docs/${path}`)))
  }
  for (const [key, bytes] of totals) {
    assert.ok(bytes <= MAX_PACKAGED_BYTES_PER_CALL, `${key} returns ${bytes} bytes`)
  }
})

test('packaged policy documents are DSH-native', () => {
  for (const [path] of PACKAGED_POLICIES) {
    const policy = read(`agent-docs/${path}`)
    assert.match(policy, /^# /u, `${path} must open with a title`)
    for (const foreign of [
      /core\/policies/u,
      /AGENT_HOME\.md|AGENT_DOCS\.toml/u,
      /CLAUDE\.md|Codex|Claude|Hermes/u,
      /agent-out|agent-runtime\b/u,
      /plan-issue|plan-tooling|\bL[0-3]\b/u,
      /task-tools|browser-test|session-coordination/u,
      /[^\x00-\x7F]/u,
    ]) {
      assert.doesNotMatch(policy, foreign, `${path} must not contain ${foreign}`)
    }
  }
  const workModes = read('agent-docs/WORK_MODES.md')
  for (const mode of ['`direct`', '`issue`', '`program`', '`program/dispatch`']) {
    assert.ok(workModes.includes(mode), `work modes must name ${mode}`)
  }
  const delivery = read('agent-docs/GIT_DELIVERY.md')
  for (const surface of ['runtime_kit_governed_commit', 'semantic-commit commit --repo', 'git-cli worktree', 'git-cli push', 'git-cli sync-default', 'forge-cli repo push-default', '[default-delivery: blocked]', '[default-delivery: unverified]']) {
    assert.ok(delivery.includes(surface), `git delivery must name ${surface}`)
  }
  assert.match(read('agent-docs/EVIDENCE.md'), /artifact_/u)
  assert.match(read('agent-docs/REVIEW_CONVERGENCE.md'), /closed-set/u)
  assert.match(read('agent-docs/DEVLOG.md'), /devlog check/u)
  assert.match(read('agent-docs/MEMORY.md'), /Never store:\s+- secrets/u)
  const peers = read('agent-docs/PEER_COORDINATION.md')
  for (const surface of [
    'agent-session board --state live --format json',
    'agent-session message inbox --session "$AGENT_SESSION_ID" --state unread',
    'agent-session message show',
    'agent-session message reply',
    '--if-revision',
    'agent-session message ack',
  ]) {
    assert.ok(peers.includes(surface), `peer coordination must name ${surface}`)
  }
  for (const disposition of ['accepted', 'deferred', 'declined', 'needs-user-authority', 'completed', 'failed']) {
    assert.ok(peers.includes(`\`${disposition}\``), `peer coordination must define ${disposition}`)
  }
  assert.match(peers, /five minutes/u)
  assert.match(peers, /in-flight/u)
  assert.match(peers, /untrusted/u)
  assert.match(peers, /never grant/u)
  assert.match(peers, /`UserPromptSubmit`/u)
  assert.match(peers, /`user-prompt-agent-memory`/u)
  assert.match(peers, /body-free mailbox reminder/u)
  assert.match(peers, /prompt boundary/u)
  assert.doesNotMatch(peers, /no automatic mailbox reminder reaches DSH sessions yet/u)
  // Every mutating mailbox command is shown with the flags the CLI requires.
  const commands = [...peers.replace(/\n\s*/gu, ' ').matchAll(/`agent-session message (ack|reply|send) [^`]*`/gu)]
  assert.deepEqual([...new Set(commands.map(match => match[1]))].sort(), ['ack', 'reply', 'send'])
  for (const [command, verb] of commands) {
    assert.match(command, /--idempotency-key/u, `${verb} must carry --idempotency-key`)
    if (verb !== 'send') assert.match(command, /--if-revision/u, `${verb} must carry --if-revision`)
    if (verb !== 'ack') assert.match(command, /--body-file/u, `${verb} must carry --body-file`)
  }
})

test('the home instructions route every packaged policy intent', () => {
  const home = read('agent-home/AGENTS.md')
  assert.match(home, /`direct`/u)
  assert.match(home, /runtime_context[^.]*`delivery`/u)
  for (const route of ['`review`', '`devlog`', '`external-facts`', '`web-testing`', '`memory`', '`upstream-contribution`', '`peer-coordination`']) {
    assert.ok(home.includes(route), `home instructions must route ${route}`)
  }
  // Peer coordination: checkpoints that never interrupt work, and an answer to every material request.
  assert.match(home, /every five minutes/u)
  assert.match(home, /in-flight/u)
  assert.match(home, /disposition/u)
})
