import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsHome = join(projectRoot, 'agent-docs')
const agentDocsBin = resolve(process.env.AGENT_DOCS_BIN ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const validationCommands = [
  'npm test',
  'npm run typecheck',
  'npm run benchmark:policy',
]

assert.notEqual(process.env.AGENT_DOCS_BIN, undefined, 'set AGENT_DOCS_BIN')
assert.notEqual(process.env.AGENT_HOOK_BIN, undefined, 'set AGENT_HOOK_BIN')
assert.equal(existsSync(agentDocsBin), true, `agent-docs not found: ${agentDocsBin}`)
assert.equal(existsSync(agentHookBin), true, `agent-hook not found: ${agentHookBin}`)
assert.equal(dirname(agentDocsBin), dirname(agentHookBin), 'use one released nils-cli binary set')

function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    input: options.input === undefined ? undefined : JSON.stringify(options.input),
    env: options.env ?? process.env,
    timeout: 30_000,
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`,
  )
  assert.equal(result.signal, null)
  return JSON.parse(result.stdout)
}

function runAgentDocs(args) {
  return runJson(agentDocsBin, [
    '--docs-home', docsHome,
    '--project-path', projectRoot,
    '--worktree-fallback', 'local-only',
    ...args,
  ])
}

const audit = runAgentDocs(['audit', '--target', 'project', '--strict', '--format', 'json'])
assert.equal(audit.schema_version, 'agent-docs.audit.v2')
assert.equal(audit.problems, 0)

const expectedPhases = new Map([
  ['edit', [
    ['PROJECT_DEV_EDIT.md', true],
    ['DEVELOPMENT.md', false],
  ]],
  ['delivery', [
    ['DEVELOPMENT.md', false],
    ['docs/policies/upstream-contribution.md', false],
  ]],
])

for (const product of ['codex', 'claude', 'hermes']) {
  for (const [phase, expectedDocuments] of expectedPhases) {
    const preflight = runAgentDocs([
      'preflight',
      '--intent', 'project-dev',
      '--product', product,
      '--phase', phase,
      '--strict',
      '--require-declared-intent',
      '--format', 'json',
    ])
    assert.equal(preflight.schema_version, 'agent-docs.preflight.v2')
    assert.equal(preflight.product, product)
    assert.equal(preflight.phase, phase)
    assert.deepEqual(preflight.validation.commands, validationCommands)
    assert.deepEqual(
      preflight.documents.map(document => [
        relative(projectRoot, document.path),
        document.required,
      ]),
      expectedDocuments,
    )
    assert.equal(preflight.documents.every(document => document.validation.valid), true)
  }
}

assert.equal(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
assert.doesNotMatch(
  readFileSync(join(projectRoot, 'PROJECT_DEV_EDIT.md'), 'utf8'),
  /DeepSeek|\bDSH\b|DSH runtime/iu,
)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-agent-docs-catalog-'))
try {
  const context = runJson(agentDocsBin, [
    '--docs-home', docsHome,
    '--project-path', projectRoot,
    '--worktree-fallback', 'local-only',
    'session', 'context',
    '--session-id', 'repository-catalog-smoke',
    '--product', 'dsh',
    '--state-home', join(temporaryRoot, 'agent-docs-state'),
    '--intent', 'project-dev',
    '--phase', 'edit',
    '--request-id', 'repository-catalog-smoke-request',
    '--format', 'json',
  ])
  assert.equal(context.ok, true)
  assert.equal(context.data.decision.verified, true)
  assert.equal(context.data.decision.document_count, 1)
  assert.equal(context.data.decision.documents[0].source, 'home')
  assert.equal(
    context.data.decision.documents[0].content,
    readFileSync(join(docsHome, 'PROJECT_DEV_EDIT.md'), 'utf8'),
  )

  const hookState = join(temporaryRoot, 'agent-hook-state')
  const hookEnvironment = {
    ...process.env,
    AGENT_DOCS_HOME: docsHome,
    HOME: join(temporaryRoot, 'home'),
    XDG_CONFIG_HOME: join(temporaryRoot, 'config'),
    XDG_STATE_HOME: join(temporaryRoot, 'state'),
    PATH: [dirname(agentHookBin), process.env.PATH ?? ''].join(':'),
  }
  const identity = {
    product: 'dsh',
    session_id: 'repository-catalog-smoke',
    turn_id: 'turn-1',
    cwd: projectRoot,
  }
  const callFinishLine = (action, input) => runJson(
    agentHookBin,
    ['finish-line', action, '--state-dir', hookState, '--format', 'json'],
    { input, env: hookEnvironment },
  ).data
  const opened = callFinishLine('open', {
    schema_version: 'agent-hook.finish-line.open.v1',
    ...identity,
    attempt_token: 'repository-catalog-smoke-open',
  })
  assert.equal(opened.status, 'opened')

  for (const [index, command] of validationCommands.entries()) {
    const probe = callFinishLine('run', {
      schema_version: 'agent-hook.finish-line.run.v1',
      ...identity,
      operation_id: `repository-catalog-validation-${index}`,
      runner_capability: opened.runner_capability,
      intent: 'project-dev',
      command,
      timeout_ms: 30_000,
    })
    assert.equal(probe.status, 'ready', `${command} must resolve as DSH validation`)
  }

  const undeclared = callFinishLine('run', {
    schema_version: 'agent-hook.finish-line.run.v1',
    ...identity,
    operation_id: 'repository-catalog-validation-negative',
    runner_capability: opened.runner_capability,
    intent: 'project-dev',
    command: 'npm run undeclared-agent-docs-command',
    timeout_ms: 30_000,
  })
  assert.equal(undeclared.status, 'ordinary-ready')

  const released = callFinishLine('release', {
    schema_version: 'agent-hook.finish-line.release.v1',
    ...identity,
    runner_capability: opened.runner_capability,
  })
  assert.equal(released.status, 'released')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

console.log('repository agent-docs catalog loading contract passed')
