import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWorkspaceRecoveryTools } from '../src/workspace-recovery/index.js'
import { createNilsWorkspaceRecoveryClient } from '../src/workspace-recovery/nils-client.js'

const DSH_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'title', 'description', 'default', 'examples',
])

function assertDshSchemaSubset(schema, path = 'schema') {
  assert.equal(schema !== null && typeof schema === 'object' && !Array.isArray(schema), true)
  for (const key of Object.keys(schema)) {
    assert.equal(DSH_SCHEMA_KEYWORDS.has(key), true, `${path}.${key} is unsupported by DSH`)
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertDshSchemaSubset(child, `${path}.properties.${name}`)
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    assertDshSchemaSubset(child, `${path}.oneOf[${index}]`)
  }
  if (schema.items !== undefined) assertDshSchemaSubset(schema.items, `${path}.items`)
}

class HarnessError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function execution(signal = new AbortController().signal) {
  const session = {
    id: 'dirty-session',
    header: { id: 'dirty-session', cwd: '/workspace/dirty' },
  }
  return {
    token: Symbol('workspace-recovery'),
    callId: 'workspace-recovery',
    rootCallId: 'workspace-recovery',
    name: 'workspace_recovery',
    arguments: {},
    signal,
    agent: { id: 'dirty-session', session },
    deferContext() {},
    concludeTurn() {},
  }
}

function payload(action = 'inspect') {
  return {
    schema_version: 'agent-hook.workspace-recovery.result.v1',
    action,
    state: 'dirty',
    checkout: {
      path: '/workspace/dirty',
      branch: 'main',
      head: 'a'.repeat(40),
      managed: false,
      dirty_entries: [{ states: ['worktree-new'], path: 'notes.txt', lossy: false }],
      dirty_entries_omitted: 0,
    },
    worktrees: [
      {
        path: '/workspace/dirty',
        branch: 'main',
        head: 'a'.repeat(40),
        bare: false,
        detached: false,
        prunable: false,
        managed: false,
      },
      {
        path: '/managed/fix-recovery',
        branch: 'fix/recovery',
        head: 'b'.repeat(40),
        bare: false,
        detached: false,
        prunable: false,
        managed: true,
      },
    ],
    worktrees_omitted: 0,
    handoff: action === 'verify-handoff'
      ? {
          status: 'verified',
          path: '/managed/fix-recovery',
          branch: 'fix/recovery',
          head: 'b'.repeat(40),
        }
      : null,
  }
}

function envelope(action = 'inspect') {
  return JSON.stringify({
    schema_version: `cli.agent-hook.workspace-recovery-${action}.v1`,
    ok: true,
    data: payload(action),
  })
}

function harness({
  stdout = () => envelope(),
  outcome = { exitCode: 0, signal: null },
  waitForExit = async () => true,
  resolveExecutable,
} = {}) {
  const specs = []
  const effects = []
  let resolveCalls = 0
  const ctx = {
    get(name) {
      return name === 'workspaceLease'
        ? { async denialState() { return { state: 'dirty', code: 'WORKSPACE_DIRTY' } } }
        : undefined
    },
    effect(start) {
      const dispose = start()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    subprocess: {
      async resolveExecutable(command, _cwd, signal) {
        resolveCalls += 1
        if (resolveExecutable !== undefined) return resolveExecutable(command, signal)
        return `/resolved/${command}`
      },
      spawn(spec) {
        specs.push(spec)
        const text = stdout(spec)
        return {
          done: Promise.resolve(outcome),
          terminate() {},
          collected: { stdout: { readFrom: () => ({ text, lossy: false }) } },
          waitForExit,
        }
      },
    },
  }
  const config = {
    agentHook: 'agent-hook',
    agentHookConfig: '/runtime/config.toml',
    agentHookPolicy: '/runtime/policy.toml',
    agentHookStateDir: '/runtime/state',
    HarnessError,
  }
  return {
    ctx,
    config,
    specs,
    get resolveCalls() { return resolveCalls },
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
  }
}

test('workspace recovery uses only the authenticated agent-hook protocol and strict projection', async () => {
  const subject = harness()
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, subject.config)

  const result = await client.inspect(execution())

  assert.equal(result.schema_version, 'dsh-runtime-kit.workspace-recovery.v1')
  assert.deepEqual(result.lease, { state: 'dirty', code: 'WORKSPACE_DIRTY' })
  assert.deepEqual(result.checkout.dirty_entries, [
    { states: ['worktree-new'], path: 'notes.txt', lossy: false },
  ])
  assert.equal(result.worktrees[1].managed, true)
  assert.equal(subject.specs.length, 1)
  assert.deepEqual(subject.specs[0].argv, [
    '/resolved/agent-hook',
    '--config', '/runtime/config.toml',
    '--policy', '/runtime/policy.toml',
    '--state-dir', '/runtime/state',
    'workspace-recovery', 'inspect', '--format', 'json',
  ])
  assert.deepEqual(JSON.parse(subject.specs[0].stdio.stdin.data), {
    schema_version: 'agent-hook.workspace-recovery.inspect.v1',
    version: 1,
    cwd: '/workspace/dirty',
  })
  assert.equal(subject.specs[0].cwd, '/runtime/state')
  assert.equal(JSON.stringify(subject.specs).includes('git-cli'), false)
  assert.equal(JSON.stringify(result).includes('file contents'), false)
  await subject.dispose()
})

test('native tools publish exact schemas and render eligible handoff paths as quoted metadata', async () => {
  const client = {
    async inspect() { return { ...payload(), schema_version: 'dsh-runtime-kit.workspace-recovery.v1', lease: null } },
    async verifyHandoff() {
      return {
        ...payload('verify-handoff'),
        schema_version: 'dsh-runtime-kit.workspace-recovery.v1',
        lease: null,
      }
    },
  }
  const [inspect, handoff] = createWorkspaceRecoveryTools(client, HarnessError)
  assertDshSchemaSubset(inspect.output.schema)
  assertDshSchemaSubset(handoff.output.schema)
  assert.deepEqual(inspect.parameters, {
    type: 'object', properties: {}, additionalProperties: false,
  })
  assert.deepEqual(handoff.parameters.required, ['path'])
  await assert.rejects(
    inspect.execute({ action: 'inspect' }, execution()),
    error => error instanceof HarnessError && error.code === 'WORKSPACE_RECOVERY_ARGUMENT_INVALID',
  )
  await assert.rejects(
    handoff.execute({}, execution()),
    error => error instanceof HarnessError && error.code === 'WORKSPACE_RECOVERY_ARGUMENT_INVALID',
  )
  await assert.rejects(
    handoff.execute({ path: '' }, execution()),
    error => error instanceof HarnessError && error.code === 'WORKSPACE_RECOVERY_HANDOFF_INVALID',
  )
  const inspected = await inspect.execute({}, execution())
  const text = inspect.output.render({}, inspected)[0].text
  assert.match(text, /path="\/managed\/fix-recovery"/)
  assert.match(text, /untrusted repository metadata/)
  assert.match(text, /workspace_recovery_handoff/)
  const verified = await handoff.execute({ path: '/managed/fix-recovery' }, execution())
  assert.equal(verified.handoff.status, 'verified')
})

test('workspace recovery preserves typed nils handoff denials', async () => {
  const subject = harness({
    outcome: { exitCode: 65, signal: null },
    stdout: () => JSON.stringify({
      schema_version: 'cli.agent-hook.workspace-recovery-verify-handoff.v1',
      ok: false,
      error: {
        code: 'workspace-recovery-handoff-dirty',
        message: 'workspace recovery handoff checkout is dirty',
        details: {
          retryable: true,
          next_action: 'verify the exact checkout and retry once',
          recovery: { kind: 'bounded-retry', max_attempts: 1 },
        },
      },
    }),
  })
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, subject.config)
  await assert.rejects(
    client.verifyHandoff(execution(), '/managed/fix-recovery'),
    error => error instanceof HarnessError && error.code === 'WORKSPACE_RECOVERY_HANDOFF_DIRTY',
  )
  await subject.dispose()
})

test('workspace recovery rejects overload and caller abort before a late spawn', async () => {
  let releaseResolve
  const subject = harness({
    resolveExecutable(_command, signal) {
      return new Promise((resolve, reject) => {
        releaseResolve = resolve
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, {
    ...subject.config,
    maxActiveWorkspaceRecoveryRequests: 1,
  })
  const controller = new AbortController()
  const first = client.inspect(execution(controller.signal))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(
    client.inspect(execution()),
    error => error.code === 'WORKSPACE_RECOVERY_OVERLOADED',
  )
  controller.abort()
  releaseResolve?.('/resolved/agent-hook')
  await assert.rejects(first, error => error.code === 'WORKSPACE_RECOVERY_CANCELLED')
  assert.equal(subject.resolveCalls, 1)
  assert.equal(subject.specs.length, 0)
  await subject.dispose()
})

test('timeout degrades admission and disposal drains whole-tree quiescence', async () => {
  let resolveExit
  const exit = new Promise(resolve => { resolveExit = resolve })
  const subject = harness({
    outcome: new Promise(() => {}),
    waitForExit: async () => exit,
  })
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, {
    ...subject.config,
    workspaceRecoveryTimeoutMs: 20,
    workspaceRecoveryTeardownTimeoutMs: 10,
  })
  await assert.rejects(
    client.inspect(execution()),
    error => error.code === 'WORKSPACE_RECOVERY_TIMEOUT',
  )
  await assert.rejects(
    client.inspect(execution()),
    error => error.code === 'WORKSPACE_RECOVERY_UNAVAILABLE',
  )
  let disposed = false
  const draining = subject.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  resolveExit(true)
  await draining
  assert.equal(disposed, true)
})

test('additive nils metadata is ignored and never crosses the projected contract', async () => {
  const subject = harness({ stdout: () => JSON.stringify({
    schema_version: 'cli.agent-hook.workspace-recovery-inspect.v1',
    ok: true,
    warnings: ['new envelope metadata'],
    data: {
      ...payload(),
      extra: true,
      checkout: {
        ...payload().checkout,
        extra: true,
        dirty_entries: [{
          ...payload().checkout.dirty_entries[0],
          extra: true,
        }],
      },
      worktrees: payload().worktrees.map(entry => ({ ...entry, extra: true })),
    },
  }) })
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, subject.config)

  const projected = await client.inspect(execution())

  assert.equal('extra' in projected, false)
  assert.equal('extra' in projected.checkout, false)
  assert.equal('extra' in projected.checkout.dirty_entries[0], false)
  assert.equal('extra' in projected.worktrees[0], false)
  await subject.dispose()
})

test('malformed or oversized recovery output fails with a typed code', async () => {
  const oversizedPayload = payload()
  oversizedPayload.checkout.dirty_entries = Array.from({ length: 900 }, (_value, index) => ({
    states: ['worktree-new'],
    path: `${String(index).padStart(4, '0')}-${'x'.repeat(180)}`,
    lossy: false,
  }))
  const oversized = JSON.stringify({
    schema_version: 'cli.agent-hook.workspace-recovery-inspect.v1',
    ok: true,
    data: oversizedPayload,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedPayload), 'utf8') > 192 * 1024)
  assert.ok(Buffer.byteLength(oversized, 'utf8') < 256 * 1024)
  for (const text of ['{', JSON.stringify({
    schema_version: 'cli.agent-hook.workspace-recovery-inspect.v1',
    ok: true,
    data: { ...payload(), checkout: null },
  }), oversized]) {
    const subject = harness({ stdout: () => text })
    const client = createNilsWorkspaceRecoveryClient(subject.ctx, subject.config)
    await assert.rejects(
      client.inspect(execution()),
      error => error.code === 'WORKSPACE_RECOVERY_OUTPUT_INVALID',
    )
    await subject.dispose()
  }
})

test('workspace recovery identity failures retain a stable HarnessError code', async () => {
  const subject = harness()
  const client = createNilsWorkspaceRecoveryClient(subject.ctx, subject.config)
  const invalid = execution()
  invalid.agent.session.header.id = 'different-session'

  await assert.rejects(
    client.inspect(invalid),
    error => error instanceof HarnessError && error.code === 'WORKSPACE_RECOVERY_IDENTITY_INVALID',
  )
  assert.equal(subject.specs.length, 0)
  await subject.dispose()
})
