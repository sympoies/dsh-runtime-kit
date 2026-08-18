import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { applyPolicy } from '../policy.js'

const sha256 = `sha256:${'0'.repeat(64)}`

function decision(action = 'allow', overrides = {}) {
  return {
    schema_version: 'cli.agent-hook.dispatch.v1',
    ok: true,
    data: {
      schema_version: 'agent-hook.normalized-decision.v1',
      request_id: '__CURRENT_REQUEST__',
      product: 'dsh',
      event: 'PreToolUse',
      action,
      reasons: action === 'block'
        ? [{ rule_id: 'dsh.block', code: 'blocked', disposition: 'block' }]
        : [],
      config_digest: sha256,
      policy_digest: sha256,
      recovery_applied: false,
      ...overrides,
    },
  }
}

function harness({
  envelope = decision(),
  pending = false,
  outcome,
  stdout,
  lossy = false,
  missingStdout = false,
  throwOnSpawn = false,
  settleOnAbort = true,
  config = {},
} = {}) {
  let listener
  let guard
  const resultListeners = []
  let spawnCount = 0
  let terminateCount = 0
  let activeHandles = 0
  let peakActiveHandles = 0
  let signal
  let service
  const handles = []
  const ctx = {
    tools: {
      register() {},
      guard(candidate) { guard = candidate },
    },
    on(event, candidate) {
      if (event === 'tools/pre-execute') listener = candidate
      if (event === 'tools/result') resultListeners.push(candidate)
    },
    provide(name, value) {
      if (name === 'dshRuntimeKit') service = value
    },
    subprocess: {
      spawn(spec) {
        if (throwOnSpawn) throw new Error('spawn failed')
        spawnCount += 1
        activeHandles += 1
        peakActiveHandles = Math.max(peakActiveHandles, activeHandles)
        const response = structuredClone(envelope)
        if (response.data?.request_id === '__CURRENT_REQUEST__') {
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
        }
        const output = stdout ?? JSON.stringify(response)
        let settle
        const done = pending
          ? new Promise(resolve => { settle = resolve })
          : Promise.resolve(outcome ?? {
            exitCode: envelope.data?.action === 'block' ? 1 : 0,
            signal: null,
          })
        void done.finally(() => { activeHandles -= 1 })
        signal = spec.signal
        signal?.addEventListener('abort', () => {
          if (settleOnAbort) settle?.({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
        const handle = {
          done,
          terminate() {
            terminateCount += 1
            settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          collected: {
            stdout: missingStdout
              ? undefined
              : { readFrom: () => ({ text: output, lossy }) },
          },
        }
        handles.push({
          settle: (result = outcome ?? {
            exitCode: envelope.data?.action === 'block' ? 1 : 0,
            signal: null,
          }) => settle?.(result),
        })
        return handle
      },
    },
  }
  applyPolicy(ctx, { agentHook: '/test/agent-hook', ...config })

  async function prepare(arguments_, {
    callId = 'call-1',
    downstreamDecision = { kind: 'allow' },
    signal: callerSignal = new AbortController().signal,
    shortCircuit = false,
    token = Symbol(callId),
  } = {}) {
    const exec = {
      token,
      callId,
      name: 'runtime_kit_plus_one',
      arguments: arguments_,
      signal: callerSignal,
      agent: { session: { header: { cwd: '/tmp' } } },
    }
    const result = shortCircuit
      ? { kind: 'allow' }
      : await listener(exec, async () => downstreamDecision)
    return { exec, result }
  }

  return {
    ctx,
    async invoke(arguments_, options = {}) {
      let delegated = false
      const prepared = await prepare(arguments_, options)
      let result = prepared.result
      if (result.kind === 'ask') {
        result = options.askOutcome === 'approved'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `approval-${options.askOutcome ?? 'denied'}` }
      }
      if (result.kind === 'allow' && guard !== undefined) {
        const reason = guard(prepared.exec)
        if (reason !== undefined) result = { kind: 'deny', reason }
      }
      if (result.kind === 'allow') {
        delegated = true
      }
      for (const observer of resultListeners) {
        observer(prepared.exec, { isError: result.kind !== 'allow', content: [] })
      }
      return { result, delegated, exec: prepared.exec }
    },
    prepare,
    guard(exec) { return guard?.(exec) },
    release(index, result) { handles[index]?.settle(result) },
    get spawnCount() { return spawnCount },
    get peakActiveHandles() { return peakActiveHandles },
    get terminateCount() { return terminateCount },
    get signal() { return signal },
    get service() { return service },
  }
}

test('malformed normalized decisions fail closed without delegating', async () => {
  const malformed = [
    decision('allow', { schema_version: undefined }),
    decision('allow', { request_id: undefined }),
    decision('allow', { policy_digest: 'not-a-digest' }),
    decision('allow', { reasons: 'not-an-array' }),
    decision('allow', { action: 'context' }),
    decision('allow', {
      reasons: [{ rule_id: 'contradiction', code: 'blocked', disposition: 'block' }],
    }),
    decision('allow', {
      reasons: [{ rule_id: 'unknown', code: 'unknown', disposition: 'permit' }],
    }),
    decision('block', {
      reasons: [{ rule_id: 'contradiction', code: 'allowed', disposition: 'allow' }],
    }),
  ]

  for (const envelope of malformed) {
    const subject = harness({ envelope })
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.equal(delegated, false)
    assert.match(result.reason, /policy-(output-invalid|action-unsupported)/)
  }
})

test('oversized DSH ingress is denied before spawning agent-hook', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke({
    content: '好'.repeat(400_000),
  })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-input-too-large/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('a stalled policy subprocess is terminated and fails closed on deadline', async () => {
  const subject = harness({ pending: true, config: { policyTimeoutMs: 20 } })
  const started = Date.now()
  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-timeout/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 1)
  assert.equal(subject.signal.aborted, true)
  assert.ok(subject.terminateCount >= 1)
  assert.ok(Date.now() - started < 1_000)
})

test('policy transport and exit failures fail closed without delegating', async () => {
  const cases = [
    [harness({ stdout: '{' }), /policy-output-invalid/],
    [harness({ lossy: true }), /policy-output-invalid/],
    [harness({ missingStdout: true }), /policy-output-invalid/],
    [harness({ outcome: { exitCode: 1, signal: null } }), /policy-exit-mismatch/],
    [harness({ outcome: { exitCode: null, signal: 'SIGTERM' } }), /policy-exit-mismatch/],
    [harness({ throwOnSpawn: true }), /policy-unavailable/],
  ]

  for (const [subject, reason] of cases) {
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, reason)
    assert.equal(delegated, false)
  }

  const wrongBlockExit = harness({
    envelope: decision('block'),
    outcome: { exitCode: 0, signal: null },
  })
  const { result, delegated } = await wrongBlockExit.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-exit-mismatch/)
  assert.equal(delegated, false)
})

test('a policy response for another ingress payload cannot be replayed', async () => {
  const subject = harness({
    envelope: decision('allow', {
      request_id: 'request:0123456789abcdef0123456789abcdef',
    }),
  })
  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-output-invalid/)
  assert.equal(delegated, false)
})

test('a prepended short-circuit allow cannot bypass the exact-token monotonic guard', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { shortCircuit: true },
  )

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('allow markers are bound to one opaque execution token and consumed once', async () => {
  const subject = harness()
  const prepared = await subject.prepare({ value: 41 }, { callId: 'same-call' })
  assert.equal(prepared.result.kind, 'allow')

  const stale = {
    ...prepared.exec,
    token: Symbol('stale-token'),
  }
  assert.match(subject.guard(stale), /policy-marker-missing/)
  assert.equal(subject.guard(prepared.exec), undefined)
  assert.match(subject.guard(prepared.exec), /policy-marker-missing/)
})

test('downstream ask decisions preserve exact-token authorization through approval', async () => {
  const approved = harness()
  const approvedResult = await approved.invoke({ value: 41 }, {
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
    askOutcome: 'approved',
  })
  assert.equal(approvedResult.result.kind, 'allow')
  assert.equal(approvedResult.delegated, true)
  assert.equal(approved.service.pendingPolicyMarkers, 0)

  for (const askOutcome of ['denied', 'cancelled']) {
    const rejected = harness()
    const rejectedResult = await rejected.invoke({ value: 41 }, {
      downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
      askOutcome,
    })
    assert.equal(rejectedResult.result.kind, 'deny')
    assert.equal(rejectedResult.delegated, false)
    assert.equal(rejected.service.pendingPolicyMarkers, 0)
  }
})

test('caller abort during policy evaluation is a terminal denial and never delegates', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    config: { maxActivePolicyChecks: 1 },
  })
  const controller = new AbortController()
  const invocation = subject.invoke({ value: 41 }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller stopped'))

  const { result, delegated } = await Promise.race([
    invocation,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abort denial stalled')), 100)),
  ])
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-caller-aborted/)
  assert.equal(delegated, false)
  assert.equal(subject.service.activePolicyChecks, 1)

  const overloaded = await subject.invoke({ value: 42 }, { callId: 'after-abort' })
  assert.match(overloaded.result.reason, /policy-overloaded/)
  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.service.activePolicyChecks, 0)
})

test('policy timeout and active subprocess configuration are capped', () => {
  const subject = harness({
    config: {
      policyTimeoutMs: Number.MAX_SAFE_INTEGER,
      maxActivePolicyChecks: Number.MAX_SAFE_INTEGER,
    },
  })
  assert.equal(subject.service.policyTimeoutMs, 30_000)
  assert.equal(subject.service.maxActivePolicyChecks, 16)
})

test('policy subprocess concurrency rejects overload and releases slots after settlement', async () => {
  const subject = harness({ pending: true, config: { maxActivePolicyChecks: 2 } })
  const controllers = [new AbortController(), new AbortController(), new AbortController()]
  const first = subject.invoke({ value: 1 }, { callId: 'one', signal: controllers[0].signal })
  const second = subject.invoke({ value: 2 }, { callId: 'two', signal: controllers[1].signal })
  const overloaded = subject.invoke({ value: 3 }, { callId: 'three', signal: controllers[2].signal })
  await new Promise(resolve => setImmediate(resolve))

  try {
    assert.equal(subject.spawnCount, 2)
    const rejected = await overloaded
    assert.equal(rejected.result.kind, 'deny')
    assert.match(rejected.result.reason, /policy-overloaded/)

    subject.release(0)
    assert.equal((await first).delegated, true)
    const fourth = subject.invoke({ value: 4 }, { callId: 'four' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(subject.spawnCount, 3)
    assert.equal(subject.peakActiveHandles, 2)
    subject.release(2)
    assert.equal((await fourth).delegated, true)
  } finally {
    controllers.forEach(controller => controller.abort())
    subject.release(0)
    subject.release(1)
    subject.release(2)
    await Promise.allSettled([first, second, overloaded])
  }
})

test('high-cardinality and excessive-depth ingress are rejected without recursion or spawn', async () => {
  const broad = harness()
  const broadResult = await broad.invoke({ values: Array.from({ length: 20_000 }, () => 0) })
  assert.equal(broadResult.result.kind, 'deny')
  assert.match(broadResult.result.reason, /policy-input-too-complex/)
  assert.equal(broad.spawnCount, 0)

  let nested = { value: 41 }
  for (let depth = 0; depth < 2_000; depth += 1) nested = { nested }
  const deep = harness()
  const deepResult = await deep.invoke(nested)
  assert.equal(deepResult.result.kind, 'deny')
  assert.match(deepResult.result.reason, /policy-input-too-complex/)
  assert.equal(deep.spawnCount, 0)
})
