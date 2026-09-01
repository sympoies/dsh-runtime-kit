import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createManagedSessionBridge } from '../src/main-agent/session-bridge.js'
import { applyManagedSessionAuthentication } from '../src/nils/managed-session-authentication.js'

const principalEnvironment = Object.freeze({
  AGENT_SESSION_ID: 'console-session-one',
  AGENT_SESSION_RUNTIME_ID: 'runtime-one',
  AGENT_SESSION_STATE_DIR: '/private/agent-session',
  AGENT_SESSION_COORDINATION_MODE: 'advisory',
  AGENT_SESSION_CAPABILITY_FILE: '/private/agent-session/capability',
  AGENT_SESSION_CHECKPOINT_FILE: '/private/agent-session/checkpoint',
  AGENT_SESSION_BIN: '/bin/true',
})

function readiness(environment = principalEnvironment) {
  return {
    schema_version: 'cli.main-agent.self-readiness.v1',
    ok: true,
    data: {
      schema_version: 'main-agent.runtime-readiness.v1',
      ready: true,
      session_id: environment.AGENT_SESSION_ID,
      session_incarnation: environment.AGENT_SESSION_RUNTIME_ID,
      checkpoint_file: environment.AGENT_SESSION_CHECKPOINT_FILE,
    },
  }
}

function publicWorkContext(environment = principalEnvironment, overrides = {}) {
  return {
    schema_version: 'agent-session.work-context.v1',
    session_id: environment.AGENT_SESSION_ID,
    session_incarnation: environment.AGENT_SESSION_RUNTIME_ID,
    claim_id: 'claim-one',
    revision: 1,
    state: 'active',
    intent: 'project-dev',
    tier: 'L2',
    repositories: ['sympoies/example'],
    worktrees: ['hmac-sha256:1:opaque'],
    provider_refs: [],
    plan_refs: [],
    scopes: [],
    summary: 'DSH project-dev session',
    updated_at: '2026-08-27T00:00:00Z',
    expires_at: '2026-08-27T00:30:00Z',
    ...overrides,
  }
}

function conflictEvaluation(overrides = {}) {
  return {
    schema_version: 'agent-session.conflict-evaluation.v1',
    classification: 'clear',
    complete: true,
    reasons: [],
    peers: [],
    ...overrides,
  }
}

function workContextSet(
  environment = principalEnvironment,
  overrides = {},
  envelopeOverrides = {},
) {
  return {
    schema_version: 'cli.agent-session.work-context-set.v1',
    ok: true,
    data: {
      schema_version: 'agent-session.work-context-set-result.v1',
      changed: true,
      context: publicWorkContext(environment),
      evaluation: conflictEvaluation(),
      mode: environment.AGENT_SESSION_COORDINATION_MODE,
      ...overrides,
    },
    ...envelopeOverrides,
  }
}

function workContextFailure(code) {
  return {
    schema_version: 'cli.agent-session.work-context-set.v1',
    ok: false,
    error: {
      code,
      message: 'operation target could not be proven inside the physical checkout boundary',
    },
  }
}

function harness({
  environment = principalEnvironment,
  envelope = readiness(environment),
  response = spec => spec.argv[1] === 'work-context'
    ? workContextSet(environment)
    : envelope,
  pending = false,
  onRead = () => {},
  resolveExecutable = async command => command,
} = {}) {
  const listeners = new Map()
  const effects = []
  const spawned = []
  const pendingSettlements = []
  const ctx = {
    on(event, listener) {
      const candidates = listeners.get(event) ?? []
      candidates.push(listener)
      listeners.set(event, candidates)
      return () => {
        const index = candidates.indexOf(listener)
        if (index >= 0) candidates.splice(index, 1)
      }
    },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    subprocess: {
      resolveExecutable,
      spawn(spec) {
        spawned.push(spec)
        const selectedEnvelope = response(spec)
        const selectedPending = typeof pending === 'function' ? pending(spec) : pending
        let settle
        let settled = false
        const settleOnce = outcome => {
          if (settled) return
          settled = true
          settle?.(outcome)
        }
        const done = selectedPending
          ? new Promise(resolve => {
            settle = resolve
            pendingSettlements.push(settleOnce)
            spec.signal?.addEventListener('abort', () => {
              settleOnce({ exitCode: null, signal: 'SIGTERM' })
            }, { once: true })
          })
          : Promise.resolve({ exitCode: 0, signal: null })
        return {
          done,
          terminate() { settleOnce({ exitCode: null, signal: 'SIGTERM' }) },
          collected: {
            stdout: {
              readFrom: () => {
                onRead(spec)
                return { text: JSON.stringify(selectedEnvelope), lossy: false }
              },
            },
          },
          async waitForExit() { return true },
        }
      },
    },
  }
  return {
    ctx,
    effects,
    listeners,
    spawned,
    settle: () => pendingSettlements.shift()?.({ exitCode: 0, signal: null }),
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before deadline')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function topLevelAgent(id = 'dsh-controller-one', cwd = '/workspace/project') {
  return { session: { header: { id, cwd } } }
}

test('always-on managed-session authentication binds before an optional child plugin activates', async () => {
  const subject = harness({
    response(spec) {
      return spec.argv[1] === 'work-context'
        ? workContextSet()
        : readiness()
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.deepEqual(subject.spawned.map(record => record.argv), [
    ['/bin/true', 'self', 'readiness', '--format', 'json'],
    [
      '/bin/true', 'work-context', 'set', '--if-absent',
      '--intent', 'project-dev', '--tier', 'L2',
      '--summary', 'DSH project-dev session', '--format', 'json',
    ],
  ])
  assert.deepEqual(subject.spawned[0].env, principalEnvironment)
  assert.deepEqual(subject.spawned[1].env, principalEnvironment)
  assert.deepEqual(bridge.resolve('dsh-controller-one'), {
    sessionId: 'console-session-one',
    environment: principalEnvironment,
  })
})

test('managed-session authentication is available to startup lifecycle owners before pre-step', async () => {
  const subject = harness()
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)
  const agent = topLevelAgent()

  const principal = await bridge.authenticate(
    'dsh-controller-one',
    { agent, signal: new AbortController().signal },
  )

  assert.deepEqual(principal, {
    sessionId: 'console-session-one',
    environment: principalEnvironment,
  })
  assert.deepEqual(bridge.resolve('dsh-controller-one'), principal)
  assert.equal(subject.spawned.length, 2)
})

for (const code of ['uncovered-mutation-scope', 'repository-unavailable']) {
  test(`managed-session authentication permits ${code} without a baseline claim`, async () => {
    const subject = harness({
      response(spec) {
        return spec.argv[1] === 'work-context'
          ? workContextFailure(code)
          : readiness()
      },
    })
    const bridge = createManagedSessionBridge()
    applyManagedSessionAuthentication(subject.ctx, {
      mainAgentCli: '/bin/true',
      agentSessionCli: '/bin/true',
    }, bridge, principalEnvironment)

    const entered = await subject.listeners.get('agent/pre-step')[0](
      { agent: topLevelAgent('home-console', '/home/operator'), signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )

    assert.deepEqual(entered, { kind: 'enter', messages: [] })
    assert.equal(subject.spawned.length, 2)
    assert.deepEqual(bridge.resolve('home-console'), {
      sessionId: 'console-session-one',
      environment: principalEnvironment,
      baselineFailureCode: code,
    })
  })
}

for (const [description, mutate] of [
  ['wrong envelope schema', envelope => { envelope.schema_version = 'cli.untrusted.v1' }],
  ['empty error message', envelope => { envelope.error.message = '' }],
  ['oversized error message', envelope => { envelope.error.message = 'x'.repeat(513) }],
]) {
  test(`managed-session authentication rejects allowed scope code with ${description}`, async () => {
    const malformed = workContextFailure('uncovered-mutation-scope')
    mutate(malformed)
    const subject = harness({
      response(spec) {
        return spec.argv[1] === 'work-context' ? malformed : readiness()
      },
    })
    const bridge = createManagedSessionBridge()
    applyManagedSessionAuthentication(subject.ctx, {
      mainAgentCli: '/bin/true',
      agentSessionCli: '/bin/true',
    }, bridge, principalEnvironment)

    const rejected = await subject.listeners.get('agent/pre-step')[0](
      { agent: topLevelAgent(), signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )

    assert.deepEqual(rejected, {
      kind: 'reject',
      reason: 'dsh-runtime-kit:managed-session-authentication-failed',
    })
    assert.equal(bridge.resolve('dsh-controller-one'), undefined)
  })
}

test('managed-session authentication rejects unrelated typed baseline failures', async () => {
  const subject = harness({
    response(spec) {
      return spec.argv[1] === 'work-context'
        ? workContextFailure('coordination-store-corrupt')
        : readiness()
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('managed-session authentication fails before bridge binding on an invalid baseline claim result', async () => {
  const subject = harness({
    response(spec) {
      return spec.argv[1] === 'work-context'
        ? workContextSet(principalEnvironment, { mode: undefined })
        : readiness()
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(subject.spawned.length, 2)
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('managed-session authentication accepts additive output and preserves a richer existing claim', async () => {
  const subject = harness({
    response(spec) {
      return spec.argv[1] === 'work-context'
        ? workContextSet(principalEnvironment, {
          changed: false,
          context: publicWorkContext(principalEnvironment, {
            intent: 'delivery',
            tier: 'L3',
            summary: 'User-owned delivery context',
          }),
          additive_result_metadata: { compatible: true },
        }, {
          warnings: ['compatible additive warning'],
          additive_envelope_metadata: true,
        })
        : readiness()
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.equal(bridge.resolve('dsh-controller-one').sessionId, 'console-session-one')
})

test('managed-session authentication rejects a malformed newly created baseline claim', async () => {
  const subject = harness({
    response(spec) {
      return spec.argv[1] === 'work-context'
        ? workContextSet(principalEnvironment, {
          context: publicWorkContext(principalEnvironment, {
            state: 'released',
            summary: 'unexpected baseline',
          }),
        })
        : readiness()
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('managed-session authentication forwards the authenticated coordination mode to policy children', async () => {
  const subject = harness()
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.equal(
    subject.spawned[0].env.AGENT_SESSION_COORDINATION_MODE,
    principalEnvironment.AGENT_SESSION_COORDINATION_MODE,
  )
  assert.equal(
    bridge.resolve('dsh-controller-one').environment.AGENT_SESSION_COORDINATION_MODE,
    principalEnvironment.AGENT_SESSION_COORDINATION_MODE,
  )
})

test('managed-session authentication stays fail-closed for unmanaged sessions and foreign children', async () => {
  const unmanaged = harness({ environment: {} })
  const unmanagedBridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(unmanaged.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, unmanagedBridge, {})
  const unmanagedResult = await unmanaged.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent('unmanaged'), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(unmanagedResult, { kind: 'enter', messages: [] })
  assert.equal(unmanaged.spawned.length, 0)
  assert.equal(unmanagedBridge.resolve('unmanaged'), undefined)

  const foreign = harness()
  const foreignBridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(foreign.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, foreignBridge, principalEnvironment)
  const foreignResult = await foreign.listeners.get('agent/pre-step')[0](
    {
      agent: { session: { header: { id: 'foreign', parentSession: 'parent', cwd: '/workspace/project' } } },
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(foreignResult, { kind: 'enter', messages: [] })
  assert.equal(foreign.spawned.length, 0)
  assert.equal(foreignBridge.resolve('foreign'), undefined)
})

test('partial Agent Session isolation sentinels do not claim always-on managed authority', async () => {
  const partialEnvironment = { ...principalEnvironment }
  delete partialEnvironment.AGENT_SESSION_CHECKPOINT_FILE
  const subject = harness({ environment: partialEnvironment })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, partialEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent('partial-sentinel'), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.equal(subject.spawned.length, 0)
  assert.equal(bridge.resolve('partial-sentinel'), undefined)
})

test('managed-session authentication rejects invalid producer readiness before policy', async () => {
  const invalid = readiness()
  invalid.data.session_incarnation = 'different-runtime'
  const subject = harness({ envelope: invalid })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('agent disposal during readiness cannot publish a stale principal', async () => {
  const subject = harness({ pending: true })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)
  const agent = topLevelAgent()

  const entering = subject.listeners.get('agent/pre-step')[0](
    { agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.listeners.get('agent/disposed')[0]({ agent })

  assert.deepEqual(await entering, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(subject.spawned[0].signal.aborted, true)
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('agent disposal cancels an in-flight baseline claim before bridge publication', async () => {
  const subject = harness({
    pending: spec => spec.argv[1] === 'work-context',
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)
  const agent = topLevelAgent()

  const entering = subject.listeners.get('agent/pre-step')[0](
    { agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await waitFor(() => subject.spawned.length === 2)
  subject.listeners.get('agent/disposed')[0]({ agent })

  assert.deepEqual(await entering, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(subject.spawned[1].signal.aborted, true)
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('plugin disposal cancels every in-flight baseline claim before bridge publication', async () => {
  const subject = harness({
    pending: spec => spec.argv[1] === 'work-context',
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entering = subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await waitFor(() => subject.spawned.length === 2)
  subject.effects.at(-1)()

  assert.deepEqual(await entering, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(subject.spawned[1].signal.aborted, true)
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('readiness and baseline claim share one authentication deadline', async () => {
  const originalNow = Date.now
  let fakeNow = 1_000
  Date.now = () => fakeNow
  try {
    const subject = harness({
      pending: spec => spec.argv[1] === 'work-context',
      onRead(spec) {
        if (spec.argv[1] === 'self') fakeNow += 40
      },
    })
    const bridge = createManagedSessionBridge()
    applyManagedSessionAuthentication(subject.ctx, {
      mainAgentCli: '/bin/true',
      agentSessionCli: '/bin/true',
      cliTimeoutMs: 50,
      cliTeardownTimeoutMs: 10,
    }, bridge, principalEnvironment)

    const startedAt = originalNow()
    const rejected = await subject.listeners.get('agent/pre-step')[0](
      { agent: topLevelAgent(), signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const elapsedMs = originalNow() - startedAt

    assert.deepEqual(rejected, {
      kind: 'reject',
      reason: 'dsh-runtime-kit:managed-session-authentication-failed',
    })
    assert.equal(subject.spawned.length, 2)
    assert.equal(elapsedMs < 35, true, `authentication took ${elapsedMs}ms`)
    assert.equal(bridge.resolve('dsh-controller-one'), undefined)
  } finally {
    Date.now = originalNow
  }
})

test('authentication deadline aborts a stalled helper executable resolution', async () => {
  let resolutionSignal
  const subject = harness({
    resolveExecutable(command, _options, signal) {
      resolutionSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: 'agent-session',
    cliTimeoutMs: 10,
    cliTeardownTimeoutMs: 10,
  }, bridge, principalEnvironment)

  const startedAt = Date.now()
  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(resolutionSignal.aborted, true)
  assert.equal(Date.now() - startedAt < 40, true)
  assert.equal(subject.spawned.length, 1)
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})
