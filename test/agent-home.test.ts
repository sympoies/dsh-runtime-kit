import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

  assert.ok(Buffer.byteLength(home) <= 4096, 'home instructions must stay compact')
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

test('the packaged catalog routes the work-modes policy to the project-dev delivery phase', () => {
  const catalog = read('agent-docs/AGENT_DOCS.toml')
  const entries = catalog.split(/^\[\[document\]\]$/mu).slice(1)
  const workModes = entries.find(entry => /^path = "WORK_MODES\.md"$/mu.test(entry))
  assert.ok(workModes, 'the packaged catalog must declare WORK_MODES.md')
  assert.match(workModes, /^context = "project-dev"$/mu)
  assert.match(workModes, /^scope = "home"$/mu)
  assert.match(workModes, /^product = "dsh"$/mu)
  assert.match(workModes, /^phase = "delivery"$/mu)
  assert.match(workModes, /^required = true$/mu)
  // The edit-phase prerequisite injects only the compact edit contract.
  const edit = entries.filter(entry => /^phase = "edit"$/mu.test(entry))
  assert.deepEqual(edit.map(entry => entry.match(/^path = "([^"]+)"$/mu)?.[1]), ['PROJECT_DEV_EDIT.md'])

  const policy = read('agent-docs/WORK_MODES.md')
  assert.ok(Buffer.byteLength(policy) <= 12 * 1024, 'work modes must fit the default runtime_context budget')
  for (const heading of [
    '# Work modes',
    '## Tracking modes',
    '## Authority',
    '## Execution mapping',
    '## Program records',
    '## Program closeout',
    '## Capture lifecycle',
  ]) {
    assert.ok(policy.includes(`\n${heading}\n`) || policy.startsWith(`${heading}\n`), `work modes must keep ${heading}`)
  }
  for (const mode of ['`direct`', '`issue`', '`program`', '`program/dispatch`']) {
    assert.ok(policy.includes(mode), `work modes must name ${mode}`)
  }
  for (const foreign of [
    /core\/policies/u,
    /AGENT_HOME\.md|AGENT_DOCS\.toml/u,
    /CLAUDE\.md|Codex|Claude|Hermes/u,
    /agent-out|agent-runtime/u,
    /plan-issue|plan-tooling|\bL[0-3]\b/u,
  ]) {
    assert.doesNotMatch(policy, foreign)
  }

  const home = read('agent-home/AGENTS.md')
  assert.match(home, /`direct`/u)
  assert.match(home, /runtime_context[^.]*`delivery`/u)
})
