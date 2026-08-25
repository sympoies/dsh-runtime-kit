import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  HEALTH_SNAPSHOT_SCHEMA,
  RuntimeHealth,
  RuntimeHealthError,
  installRuntimeHealthAdmission,
  installRuntimeHealthInvariant,
  validateHealthTransition,
} from '../src/health/index.js'
import {
  createChildPluginStatus,
  observeChildPluginActivation,
} from '../src/runtime-status.js'

const CAPABILITY = 'runtime-core'
const OWNER = '@sympoies/dsh-runtime-kit'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

async function harness(config = {}) {
  const ctx = new Context()
  await ctx.plugin(RuntimeHealth, config)
  return ctx
}

test('runtime health publishes frozen typed state without provider-private details', async () => {
  const ctx = await harness({ now: () => 1234 })
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() {
      return {
        state: 'ready',
        code: 'DSH_RUNTIME_HEALTH_READY',
        private_path: '/must/not/be/projected',
      }
    },
  })

  const initial = ctx.dshRuntimeHealth.snapshot(CAPABILITY)
  assert.deepEqual(initial, {
    schema_version: HEALTH_SNAPSHOT_SCHEMA,
    capability: CAPABILITY,
    owner: OWNER,
    scope: 'runtime',
    generation: 0,
    state: 'blocked',
    code: 'DSH_RUNTIME_HEALTH_UNPROBED',
    observed_at: 1234,
  })

  const ready = await ctx.dshRuntimeHealth.probe(CAPABILITY)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.generation, 2)
  assert.equal(Object.isFrozen(ready), true)
  assert.equal('private_path' in ready, false)
})

test('observer failure cannot strand a committed health transition or starve later observers', async () => {
  const ctx = await harness()
  const observed = []
  ctx.dshRuntimeHealth.observe(() => { throw new Error('broken observer') })
  ctx.dshRuntimeHealth.observe(({ next }) => { observed.push(next.state) })
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
  })

  const ready = await ctx.dshRuntimeHealth.probe(CAPABILITY)
  assert.equal(ready.state, 'ready')
  assert.deepEqual(observed, ['recovering', 'ready'])
  assert.equal(ctx.dshRuntimeHealth.snapshot(CAPABILITY).state, 'ready')
})

test('concurrent health probes deduplicate per capability scope and generation', async () => {
  const ctx = await harness()
  const gate = deferred()
  let calls = 0
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() {
      calls += 1
      return gate.promise
    },
  })

  const first = ctx.dshRuntimeHealth.probe(CAPABILITY, { scope: '/workspace' })
  const second = ctx.dshRuntimeHealth.probe(CAPABILITY, { scope: '/workspace' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(ctx.dshRuntimeHealth.snapshot(CAPABILITY, '/workspace').state, 'recovering')

  gate.resolve({ state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(left.state, 'ready')
})

test('blocked health rejects dependents and a forced repair retires stale failure authority', async () => {
  const ctx = await harness()
  let repaired = false
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() {
      return repaired
        ? { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' }
        : { state: 'blocked', code: 'DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE' }
    },
  })

  await ctx.dshRuntimeHealth.probe(CAPABILITY)
  await assert.rejects(
    ctx.dshRuntimeHealth.require(CAPABILITY),
    error => error instanceof RuntimeHealthError
      && error.code === 'DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE'
      && error.snapshot.state === 'blocked',
  )

  repaired = true
  const ready = await ctx.dshRuntimeHealth.probe(CAPABILITY, { force: true })
  assert.equal(ready.state, 'ready')
  assert.equal(ready.code, 'DSH_RUNTIME_HEALTH_READY')
  assert.equal(JSON.stringify(ready).includes('COMPANION_UNAVAILABLE'), false)
  assert.equal((await ctx.dshRuntimeHealth.require(CAPABILITY)).state, 'ready')
})

test('cancellation restores the last stable state and ignores late probe settlement', async () => {
  const ctx = await harness()
  const gate = deferred()
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return gate.promise },
  })
  const controller = new AbortController()
  const pending = ctx.dshRuntimeHealth.probe(CAPABILITY, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancel fixture'))
  await assert.rejects(pending, /cancel fixture/)
  const restored = ctx.dshRuntimeHealth.snapshot(CAPABILITY)
  assert.equal(restored.state, 'blocked')
  assert.equal(restored.code, 'DSH_RUNTIME_HEALTH_UNPROBED')

  gate.resolve({ state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ctx.dshRuntimeHealth.snapshot(CAPABILITY), restored)
})

test('a pre-aborted first caller starts no provider work or health transition', async () => {
  const ctx = await harness()
  let calls = 0
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() {
      calls += 1
      return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' }
    },
  })
  const initial = ctx.dshRuntimeHealth.snapshot(CAPABILITY)
  const controller = new AbortController()
  controller.abort(new Error('cancelled before probe'))

  await assert.rejects(
    ctx.dshRuntimeHealth.probe(CAPABILITY, { signal: controller.signal }),
    /cancelled before probe/,
  )
  assert.equal(calls, 0)
  assert.deepEqual(ctx.dshRuntimeHealth.snapshot(CAPABILITY), initial)
})

test('cancelling one of two waiters preserves the shared provider for the remaining waiter', async () => {
  const ctx = await harness()
  const gate = deferred()
  let calls = 0
  let providerAborts = 0
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe({ signal }) {
      calls += 1
      signal.addEventListener('abort', () => { providerAborts += 1 }, { once: true })
      return gate.promise
    },
  })
  const first = ctx.dshRuntimeHealth.probe(CAPABILITY)
  const controller = new AbortController()
  const second = ctx.dshRuntimeHealth.probe(CAPABILITY, { signal: controller.signal })
  controller.abort(new Error('second waiter cancelled'))
  await assert.rejects(second, /second waiter cancelled/)
  assert.equal(calls, 1)
  assert.equal(providerAborts, 0)

  gate.resolve({ state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  assert.equal((await first).state, 'ready')
  assert.equal(providerAborts, 0)
})

test('service disposal aborts and drains owned probes', async () => {
  const ctx = await harness({ disposeTimeoutMs: 1000 })
  let observedAbort = false
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    probe({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true
          reject(signal.reason)
        }, { once: true })
      })
    },
  })
  const pending = ctx.dshRuntimeHealth.probe(CAPABILITY)
  await new Promise(resolve => setImmediate(resolve))
  await ctx.fiber.dispose()
  await assert.rejects(pending, /disposed/)
  assert.equal(observedAbort, true)
})

test('service disposal still drains a provider that settles after its probe deadline', async () => {
  const ctx = await harness({ probeTimeoutMs: 10, disposeTimeoutMs: 1000 })
  const gate = deferred()
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return gate.promise },
  })
  const blocked = await ctx.dshRuntimeHealth.probe(CAPABILITY)
  assert.equal(blocked.code, 'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT')

  let disposed = false
  const disposing = ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  gate.resolve({ state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  await disposing
  assert.equal(disposed, true)
})

test('provider removal retires active authority before a replacement is registered', async () => {
  const ctx = await harness()
  const gate = deferred()
  const dispose = ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return gate.promise },
  })
  const pending = ctx.dshRuntimeHealth.probe(CAPABILITY)
  await new Promise(resolve => setImmediate(resolve))

  dispose()
  await assert.rejects(
    pending,
    error => error instanceof RuntimeHealthError
      && error.code === 'DSH_RUNTIME_HEALTH_PROVIDER_REMOVED',
  )
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: 'runtime-kit-replacement',
    async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
  })
  const replacement = ctx.dshRuntimeHealth.snapshot(CAPABILITY)
  assert.equal(replacement.owner, 'runtime-kit-replacement')
  assert.equal(replacement.generation, 0)

  gate.resolve({ state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ctx.dshRuntimeHealth.snapshot(CAPABILITY), replacement)
})

test('health transition validator rejects owner, generation, and state-machine drift', () => {
  const blocked = Object.freeze({
    schema_version: HEALTH_SNAPSHOT_SCHEMA,
    capability: CAPABILITY,
    owner: OWNER,
    scope: 'runtime',
    generation: 0,
    state: 'blocked',
    code: 'DSH_RUNTIME_HEALTH_UNPROBED',
    observed_at: 1,
  })
  const recovering = Object.freeze({ ...blocked, generation: 1, state: 'recovering', code: 'DSH_RUNTIME_HEALTH_PROBING' })
  const ready = Object.freeze({ ...recovering, generation: 2, state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' })
  assert.doesNotThrow(() => validateHealthTransition(blocked, recovering))
  assert.doesNotThrow(() => validateHealthTransition(recovering, ready))
  assert.throws(
    () => validateHealthTransition(blocked, { ...ready, generation: 1 }),
    /state transition is invalid/,
  )
  assert.throws(
    () => validateHealthTransition(recovering, { ...ready, owner: '@other/owner' }),
    /owner changed/,
  )
  assert.throws(
    () => validateHealthTransition(recovering, { ...ready, generation: 9 }),
    /generation/,
  )
})

function admissionHarness(health) {
  const session = { header: { cwd: '/workspace/private-project' } }
  let modelGuard
  let toolGuard
  const ctx = {
    llm: {
      guard(candidate) {
        modelGuard = candidate
        return () => { if (modelGuard === candidate) modelGuard = undefined }
      },
    },
    sessions: {
      get(id) { return id === 'session-1' ? session : undefined },
    },
    tools: {
      guard(candidate) {
        toolGuard = candidate
        return () => { if (toolGuard === candidate) toolGuard = undefined }
      },
    },
  }
  installRuntimeHealthAdmission(ctx, health, {
    sessionRequirements: [
      { capability: CAPABILITY, scope: 'runtime' },
      { capability: 'project-docs', scope: 'project' },
    ],
    toolRequirements: {
      runtime_kit_start_worker: [{ capability: 'main-agent-mode', scope: 'runtime' }],
    },
  })
  return {
    session,
    modelGuard: options => modelGuard(options),
    toolGuard: exec => toolGuard(exec),
  }
}

test('blocked project health denies pre-waterfall model dispatch and recovery adds no model context', async () => {
  const ctx = await harness()
  let projectRepaired = false
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
  })
  ctx.dshRuntimeHealth.register({
    capability: 'project-docs',
    owner: OWNER,
    async probe() {
      return projectRepaired
        ? { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' }
        : { state: 'blocked', code: 'DSH_RUNTIME_HEALTH_PROJECT_INVALID' }
    },
  })
  ctx.dshRuntimeHealth.register({
    capability: 'main-agent-mode',
    owner: OWNER,
    async probe() { return { state: 'degraded', code: 'DSH_RUNTIME_HEALTH_OPTIONAL_UNAVAILABLE' } },
  })
  const { modelGuard } = admissionHarness(ctx.dshRuntimeHealth)
  const options = {
    sessionId: 'session-1',
    signal: new AbortController().signal,
  }
  let modelRequests = 0
  const first = await modelGuard(options)
  if (first === undefined) modelRequests += 1
  assert.equal(first, 'DSH_RUNTIME_HEALTH_PROJECT_INVALID')
  assert.equal(modelRequests, 0)
  const blocked = ctx.dshRuntimeHealth.snapshot('project-docs', '/workspace/private-project')
  assert.equal(blocked.state, 'blocked')
  assert.match(blocked.scope, /^sha256:[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(blocked), /private-project/)

  projectRepaired = true
  await ctx.dshRuntimeHealth.probe('project-docs', {
    scope: '/workspace/private-project',
    force: true,
  })
  const entered = await modelGuard(options)
  if (entered === undefined) modelRequests += 1
  assert.equal(entered, undefined)
  assert.equal(modelRequests, 1)
})

test('optional degradation leaves independent tools available but blocks an explicit dependent', async () => {
  const ctx = await harness()
  for (const capability of [CAPABILITY, 'project-docs']) {
    ctx.dshRuntimeHealth.register({
      capability,
      owner: OWNER,
      async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
    })
  }
  ctx.dshRuntimeHealth.register({
    capability: 'main-agent-mode',
    owner: OWNER,
    async probe() { return { state: 'degraded', code: 'DSH_RUNTIME_HEALTH_OPTIONAL_UNAVAILABLE' } },
  })
  await ctx.dshRuntimeHealth.probe('main-agent-mode')
  const { toolGuard } = admissionHarness(ctx.dshRuntimeHealth)
  let bodies = 0
  const signal = new AbortController().signal
  const dependent = toolGuard({ name: 'runtime_kit_start_worker', signal })
  if (dependent === undefined) bodies += 1
  assert.equal(dependent, 'DSH_RUNTIME_HEALTH_OPTIONAL_UNAVAILABLE')
  const independent = toolGuard({ name: 'runtime_kit_plus_one', signal })
  if (independent === undefined) bodies += 1
  assert.equal(independent, undefined)
  assert.equal(bodies, 1)
})

test('project health refreshes at every pre-waterfall model dispatch and skips sessionless auxiliary calls', async () => {
  const ctx = await harness()
  let projectProbes = 0
  ctx.dshRuntimeHealth.register({
    capability: CAPABILITY,
    owner: OWNER,
    async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
  })
  ctx.dshRuntimeHealth.register({
    capability: 'project-docs',
    owner: OWNER,
    async probe() {
      projectProbes += 1
      return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_PROJECT_READY' }
    },
  })
  ctx.dshRuntimeHealth.register({
    capability: 'main-agent-mode',
    owner: OWNER,
    async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_OPTIONAL_READY' } },
  })
  const { modelGuard } = admissionHarness(ctx.dshRuntimeHealth)
  const run = () => modelGuard({
    sessionId: 'session-1',
    signal: new AbortController().signal,
  })
  assert.equal(await run(), undefined)
  assert.equal(await run(), undefined)
  assert.equal(await run(), undefined)
  assert.equal(projectProbes, 3)
  assert.equal(await modelGuard({ signal: new AbortController().signal }), undefined)
  assert.equal(projectProbes, 3)
})

test('admission registration rolls back the model guard when tool guard installation fails', () => {
  const modelGuards = new Set()
  const ctx = {
    llm: {
      guard(candidate) {
        modelGuards.add(candidate)
        return () => modelGuards.delete(candidate)
      },
    },
    sessions: { get() { return undefined } },
    tools: {
      guard() { throw new Error('tool guard fixture failed') },
    },
  }
  const health = { async require() {} }

  assert.throws(
    () => installRuntimeHealthAdmission(ctx, health),
    /tool guard fixture failed/,
  )
  assert.equal(modelGuards.size, 0)

  let toolDisposed = false
  const installed = installRuntimeHealthAdmission({
    ...ctx,
    tools: {
      guard() {
        return () => {
          toolDisposed = true
          throw new Error('tool guard disposal fixture failed')
        }
      },
    },
  }, health)
  assert.equal(modelGuards.size, 1)
  assert.throws(installed, /tool guard disposal fixture failed/)
  assert.equal(toolDisposed, true)
  assert.equal(modelGuards.size, 0)
})

test('same-root dispose and reapply retires old health registrations and late child callbacks', async () => {
  const root = new Context()
  const modelGuards = new Set()
  const toolGuards = new Set()
  const invariants = new Set()
  root.provide('llm', {
    guard(candidate) { modelGuards.add(candidate); return () => modelGuards.delete(candidate) },
  })
  root.provide('sessions', { get() { return { header: { cwd: '/workspace' } } } })
  root.provide('tools', {
    guard(candidate) { toolGuards.add(candidate); return () => toolGuards.delete(candidate) },
  })
  root.provide('invariants', {
    register(_name, installer) { invariants.add(installer); return () => invariants.delete(installer) },
  })

  const mounted = []
  const bundle = {
    inject: ['invariants', 'llm', 'sessions', 'tools'],
    async apply(ctx, config) {
      const healthFiber = ctx.plugin(RuntimeHealth)
      await healthFiber
      const health = healthFiber.ctx.dshRuntimeHealth
      const childPlugins = createChildPluginStatus()
      let providerCalls = 0
      for (const capability of [CAPABILITY, 'project-docs']) {
        health.register({
          capability,
          owner: OWNER,
          async probe() { return { state: 'ready', code: 'DSH_RUNTIME_HEALTH_READY' } },
        })
      }
      health.register({
        capability: 'main-agent-mode',
        owner: OWNER,
        probe() {
          providerCalls += 1
          return childPlugins.main_agent_mode.state === 'active'
            ? { state: 'ready', code: 'DSH_RUNTIME_HEALTH_OPTIONAL_READY' }
            : { state: 'degraded', code: 'DSH_RUNTIME_HEALTH_OPTIONAL_PENDING' }
        },
      })
      ctx.effect(() => installRuntimeHealthInvariant(ctx), 'health invariant fixture')
      ctx.effect(() => installRuntimeHealthAdmission(ctx, health, {
        sessionRequirements: [
          { capability: CAPABILITY, scope: 'runtime' },
          { capability: 'project-docs', scope: 'project' },
        ],
        toolRequirements: {
          main_agent_run_initialize: [
            { capability: 'main-agent-mode', scope: 'runtime' },
          ],
        },
      }), 'health admission fixture')
      await health.probe('main-agent-mode')
      observeChildPluginActivation(
        childPlugins,
        'main_agent_mode',
        () => config.activation.promise,
        { warn() {} },
        () => { void health.probe('main-agent-mode', { force: true }).catch(() => {}) },
      )
      mounted.push({ health, get providerCalls() { return providerCalls } })
    },
  }

  const firstActivation = deferred()
  const firstFiber = root.plugin(bundle, { activation: firstActivation })
  await firstFiber
  assert.deepEqual([modelGuards.size, toolGuards.size, invariants.size], [1, 1, 1])
  const first = mounted[0]
  await firstFiber.dispose()
  assert.deepEqual([modelGuards.size, toolGuards.size, invariants.size], [0, 0, 0])

  const secondActivation = deferred()
  const secondFiber = root.plugin(bundle, { activation: secondActivation })
  await secondFiber
  assert.deepEqual([modelGuards.size, toolGuards.size, invariants.size], [1, 1, 1])
  const second = mounted[1]
  const replacement = second.health.snapshot('main-agent-mode')
  firstActivation.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(first.health.disposed, true)
  assert.equal(first.providerCalls, 1)
  assert.deepEqual(second.health.snapshot('main-agent-mode'), replacement)
  assert.equal(second.providerCalls, 1)

  await secondFiber.dispose()
  assert.deepEqual([modelGuards.size, toolGuards.size, invariants.size], [0, 0, 0])
  secondActivation.resolve()
  await root.fiber.dispose()
})

test('parent disposal fences a pending Cordis child without an unhandled lifecycle callback', async () => {
  const root = new Context()
  const status = createChildPluginStatus()
  const transitions = []
  const rejections = []
  const activation = deferred()
  const onUnhandled = reason => { rejections.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const bundle = {
      async apply(ctx) {
        const child = ctx.plugin({ inject: ['missing-runtime-service'], apply() {} })
        observeChildPluginActivation(
          status,
          'main_agent_mode',
          async () => {
            await activation.promise
            return child
          },
          { warn() {} },
          (name, state) => transitions.push([name, state.state]),
          ctx,
        )
      },
    }
    const parent = root.plugin(bundle)
    await parent
    assert.equal(status.main_agent_mode.state, 'pending')

    await parent.dispose()
    activation.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(status.main_agent_mode.state, 'pending')
    assert.deepEqual(transitions, [])
    assert.deepEqual(rejections, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    await root.fiber.dispose()
  }
})
