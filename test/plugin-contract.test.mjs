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
} = {}) {
  let listener
  let spawnCount = 0
  let terminateCount = 0
  let signal
  let settle
  const done = pending
    ? new Promise(resolve => { settle = resolve })
    : Promise.resolve(outcome ?? {
      exitCode: envelope.data?.action === 'block' ? 1 : 0,
      signal: null,
    })
  const ctx = {
    tools: { register() {} },
    on(event, candidate) {
      if (event === 'tools/pre-execute') listener = candidate
    },
    provide() {},
    subprocess: {
      spawn(spec) {
        if (throwOnSpawn) throw new Error('spawn failed')
        spawnCount += 1
        const response = structuredClone(envelope)
        if (response.data?.request_id === '__CURRENT_REQUEST__') {
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
        }
        const output = stdout ?? JSON.stringify(response)
        signal = spec.signal
        signal?.addEventListener('abort', () => {
          settle?.({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
        return {
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
      },
    },
  }
  return {
    ctx,
    invoke(arguments_, config = {}) {
      applyPolicy(ctx, { agentHook: '/test/agent-hook', ...config })
      let delegated = false
      return listener({
        callId: 'call-1',
        name: 'runtime_kit_plus_one',
        arguments: arguments_,
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: '/tmp' } } },
      }, async () => {
        delegated = true
        return { kind: 'allow' }
      }).then(result => ({ result, delegated }))
    },
    get spawnCount() { return spawnCount },
    get terminateCount() { return terminateCount },
    get signal() { return signal },
  }
}

test('malformed normalized decisions fail closed without delegating', async () => {
  const malformed = [
    decision('allow', { schema_version: undefined }),
    decision('allow', { request_id: undefined }),
    decision('allow', { policy_digest: 'not-a-digest' }),
    decision('allow', { reasons: 'not-an-array' }),
    decision('allow', { action: 'context' }),
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
  const subject = harness({ pending: true })
  const started = Date.now()
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { policyTimeoutMs: 20 },
  )

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
