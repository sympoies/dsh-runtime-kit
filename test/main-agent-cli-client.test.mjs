import assert from 'node:assert/strict'
import test from 'node:test'

import { createCliClient } from '../src/main-agent/cli-client.js'
import { parseStartTime } from '../src/main-agent/lanes.js'

function createHarness({ handleFactory } = {}) {
  const effects = []
  const spawned = []
  const ctx = {
    effect(callback, label) {
      effects.push({ callback, label })
    },
    subprocess: {
      spawn(spec) {
        spawned.push(spec)
        if (handleFactory === undefined) throw new Error('no handle factory')
        return handleFactory(spec, spawned.length)
      },
    },
  }
  return { ctx, effects, spawned }
}

function settledHandle(envelope, { exitCode = 0, lossy = false, text } = {}) {
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    terminate() {},
    async waitForExit() { return true },
    collected: {
      stdout: {
        readFrom() {
          return { text: text ?? JSON.stringify(envelope), lossy }
        },
      },
    },
  }
}

test('the deadline terminates a wedged child and fails closed without hanging', async () => {
  let terminated = 0
  const harness = createHarness({
    handleFactory: () => ({
      done: new Promise(() => {}),
      terminate() { terminated += 1 },
      async waitForExit() { return true },
      collected: { stdout: { readFrom: () => ({ text: '{}', lossy: false }) } },
    }),
  })
  const client = createCliClient(harness.ctx, { cliTimeoutMs: 20 })
  const result = await client.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'dsh-runtime-kit:cli-unavailable')
  assert.ok(terminated >= 1, 'the deadline terminates the child')
  assert.equal(client.degraded, false, 'a proven-quiescent teardown does not degrade admission')
})

test('unknown process-tree quiescence permanently degrades admission', async () => {
  const harness = createHarness({
    handleFactory: () => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {},
      async waitForExit() {
        await new Promise(() => {})
        return true
      },
      collected: { stdout: { readFrom: () => ({ text: '{"ok":true}', lossy: false }) } },
    }),
  })
  const client = createCliClient(harness.ctx, { cliTeardownTimeoutMs: 20 })
  const first = await client.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'dsh-runtime-kit:cli-unavailable')
  assert.equal(client.degraded, true, 'unproven quiescence latches degradation')
  const second = await client.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'dsh-runtime-kit:cli-unavailable')
  assert.equal(harness.spawned.length, 1, 'degraded admission never spawns again')
})

test('admission is bounded, caller aborts refuse, and disposal closes the client', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const harness = createHarness({
    handleFactory: () => ({
      done: gate.then(() => ({ exitCode: 0, signal: null })),
      terminate() {},
      async waitForExit() { return true },
      collected: { stdout: { readFrom: () => ({ text: '{"ok":true}', lossy: false }) } },
    }),
  })
  const client = createCliClient(harness.ctx, { maxActiveCliCalls: 1 })
  const inFlight = client.run(['main-agent', 'status'], { cwd: '/checkout' })
  const overloaded = await client.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(overloaded.ok, false)
  assert.equal(overloaded.code, 'dsh-runtime-kit:cli-overloaded')

  const aborted = new AbortController()
  aborted.abort()
  const refused = await client.run(['main-agent', 'status'], {
    cwd: '/checkout',
    signal: aborted.signal,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'dsh-runtime-kit:cli-caller-aborted')

  release()
  const settled = await inFlight
  assert.equal(settled.ok, true)

  for (const effect of harness.effects) {
    const dispose = effect.callback()
    if (typeof dispose === 'function') dispose()
  }
  const disposed = await client.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(disposed.ok, false)
  assert.equal(disposed.code, 'dsh-runtime-kit:cli-disposed')
})

test('malformed, lossy, and signal-killed outputs fail closed; typed CLI errors pass through', async () => {
  const lossy = createHarness({
    handleFactory: () => settledHandle({}, { lossy: true }),
  })
  const lossyClient = createCliClient(lossy.ctx, {})
  const lossyResult = await lossyClient.run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(lossyResult.code, 'dsh-runtime-kit:cli-output-invalid')

  const malformed = createHarness({
    handleFactory: () => settledHandle(undefined, { text: 'not json' }),
  })
  const malformedResult = await createCliClient(malformed.ctx, {})
    .run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(malformedResult.code, 'dsh-runtime-kit:cli-output-invalid')

  const killed = createHarness({
    handleFactory: () => ({
      done: Promise.resolve({ exitCode: null, signal: 'SIGKILL' }),
      terminate() {},
      async waitForExit() { return true },
      collected: { stdout: { readFrom: () => ({ text: '{"ok":true}', lossy: false }) } },
    }),
  })
  const killedResult = await createCliClient(killed.ctx, {})
    .run(['main-agent', 'status'], { cwd: '/checkout' })
  assert.equal(killedResult.code, 'dsh-runtime-kit:cli-unavailable')

  const typedError = createHarness({
    handleFactory: () => settledHandle(
      { schema_version: 'cli.main-agent.worker-start.v1', ok: false, error: { code: 'claim-not-active' } },
      { exitCode: 1 },
    ),
  })
  const typedResult = await createCliClient(typedError.ctx, {})
    .run(['main-agent', 'worker', 'start'], { cwd: '/checkout' })
  assert.equal(typedResult.ok, true, 'typed CLI refusals surface as envelopes, not transport failures')
  assert.equal(typedResult.envelope.ok, false)
  assert.equal(typedResult.envelope.error.code, 'claim-not-active')
  assert.equal(typedResult.exitCode, 1)
})

test('proc stat starttime parsing survives hostile comm values', () => {
  const stat = '1234 ((dsh) worker)) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 8 0 987654 1000000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0'
  assert.equal(parseStartTime(stat), 987654)
  assert.equal(parseStartTime('garbage'), undefined)
  assert.equal(parseStartTime('1 (x) S'), undefined)
})
