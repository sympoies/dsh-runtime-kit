import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createBodyExecutionCounter,
  validationBodyExecutions,
} from './fixtures/authoritative-acceptance-canary/body-execution-counter.js'
import { observableChildPid } from './fixtures/authoritative-acceptance-canary/observable-child-pid.js'
import {
  finalizeScenarioCanary,
  startScenarioCanaryWhenReady,
} from './fixtures/authoritative-acceptance-canary/receipt-output.js'

const fixtureManifest = new URL('./fixtures/authoritative-acceptance-canary/package.json', import.meta.url)

test('runtime canary phases activate only after runtime stop listeners are registered', async () => {
  const { scenarioCanaryServices } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  assert.deepEqual(scenarioCanaryServices('positive'), [
    'agents', 'dshRuntimeKit', 'sessions', 'goals', 'llm', 'tools',
  ])
  assert.deepEqual(scenarioCanaryServices('candidate-upgrade'), [
    'agents', 'dshRuntimeKit', 'sessions', 'goals', 'llm', 'tools',
  ])
  assert.deepEqual(scenarioCanaryServices('unpatched-smoke'), [
    'agents', 'goals', 'llm', 'tools',
  ])
  assert.deepEqual(scenarioCanaryServices('provider-mismatch-probe'), [
    'agents', 'goals', 'llm', 'tools',
  ])
  const canary = readFileSync(
    new URL('./fixtures/authoritative-acceptance-canary/index.js', import.meta.url),
    'utf8',
  )
  assert.match(canary, /export const inject = scenarioCanaryServices\(phase\)/u)
})

test('the packed canary includes its host-visible child lookup helper', () => {
  const manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8'))
  assert.equal(manifest.files.includes('observable-child-pid.js'), true)
  assert.equal(manifest.files.includes('body-execution-counter.js'), true)
  assert.equal(manifest.files.includes('receipt-output.js'), true)
})

test('the canary disarms its goal before waiting for manual completion', async () => {
  const { prepareScenarioCanaryGoal } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  assert.equal(typeof prepareScenarioCanaryGoal, 'function')

  const agent = Object.freeze({ id: 'acceptance-agent' })
  const created = Object.freeze({
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    activation: 'armed',
  })
  const disarmed = Object.freeze({ ...created, activation: 'disarmed' })
  const calls = []
  const goals = {
    get(subject) {
      assert.equal(subject, agent)
      calls.push('get')
      return undefined
    },
    create(subject, request) {
      assert.equal(subject, agent)
      assert.deepEqual(request, { objective: 'prove authoritative acceptance' })
      calls.push('create')
      return created
    },
    disarm(subject) {
      assert.equal(subject, agent)
      calls.push('disarm')
      return disarmed
    },
  }

  assert.equal(prepareScenarioCanaryGoal(goals, agent), disarmed)
  assert.deepEqual(calls, ['get', 'create', 'disarm'])
})

test('the canary rejects an inexact goal disarm result', async () => {
  const { prepareScenarioCanaryGoal } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  const agent = Object.freeze({ id: 'acceptance-agent' })
  const selected = Object.freeze({
    id: 'goal-1',
    revision: 2,
    phase: 'active',
    activation: 'armed',
  })
  const invalidResults = [
    undefined,
    { ...selected, id: 'goal-2', activation: 'disarmed' },
    { ...selected, revision: 3, activation: 'disarmed' },
    { ...selected, phase: 'completed', activation: 'disarmed' },
    { ...selected, activation: 'armed' },
  ]

  for (const result of invalidResults) {
    assert.throws(
      () => prepareScenarioCanaryGoal({
        get: subject => {
          assert.equal(subject, agent)
          return selected
        },
        create: () => assert.fail('an existing goal must be reused'),
        disarm: subject => {
          assert.equal(subject, agent)
          return result
        },
      }, agent),
      /scenario canary goal did not disarm/u,
    )
  }
})

test('the positive canary reports bounded validator and stop-request boundaries', async () => {
  const { SCENARIO_CANARY_PROGRESS } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  const canary = readFileSync(
    new URL('./fixtures/authoritative-acceptance-canary/index.js', import.meta.url),
    'utf8',
  )
  const milestones = [
    'VALIDATION_TOOL_REQUESTED',
    'VALIDATION_TOOL_RESULT',
    'HOST_VALIDATOR_REQUESTED',
    'HOST_VALIDATOR_RESULT',
    'STOP_REQUESTED',
  ]
  for (const milestone of milestones) {
    assert.match(
      SCENARIO_CANARY_PROGRESS[milestone],
      /^DSH_CANARY_DEADLINE_[A-Z_]+$/u,
    )
    assert.match(
      canary,
      new RegExp(`progress\\.enter\\(SCENARIO_CANARY_PROGRESS\\.${milestone}\\)`, 'u'),
    )
  }
})

test('turn-stopping progress follows the observable listener waterfall', async () => {
  const {
    createScenarioCanaryProgressReporter,
    registerScenarioCanaryTurnStoppingProgress,
    SCENARIO_CANARY_FAILURE_MARKER,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')
  assert.equal(typeof registerScenarioCanaryTurnStoppingProgress, 'function')
  assert.equal(
    SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    'DSH_CANARY_DEADLINE_RUNTIME_STOP_LISTENERS_COMPLETED',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_CALLBACK_COMPLETED,
    'DSH_CANARY_DEADLINE_CANARY_STOP_CALLBACK_COMPLETED',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_LISTENER_TAIL_COMPLETED,
    'DSH_CANARY_DEADLINE_CANARY_STOP_LISTENER_TAIL_COMPLETED',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED,
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED',
  )
  assert.equal('TURN_STOPPING_COMPLETED' in SCENARIO_CANARY_PROGRESS, false)

  const listeners = []
  const ctx = {
    on(event, listener, options = {}) {
      assert.equal(event, 'agent/turn-stopping')
      if (options.prepend === true) listeners.unshift(listener)
      else listeners.push(listener)
    },
  }
  let releaseRuntimeListener
  let runtimeListenerEntered
  const runtimeListenerStarted = new Promise(resolve => { runtimeListenerEntered = resolve })
  ctx.on('agent/turn-stopping', async () => {
    runtimeListenerEntered()
    await new Promise(resolve => { releaseRuntimeListener = resolve })
  })

  const writes = []
  const processInstance = 'sha256:' + 'b'.repeat(64)
  const reporter = createScenarioCanaryProgressReporter({
    phase: 'positive',
    processInstance,
    stream: {
      write(chunk, callback) {
        writes.push(chunk)
        callback()
        return true
      },
    },
  })
  const entered = []
  const progress = {
    enter(code) {
      entered.push(code)
      reporter.enter(code)
    },
  }
  let releaseCanaryCallback
  let canaryCallbackEntered
  const canaryCallbackStarted = new Promise(resolve => { canaryCallbackEntered = resolve })
  registerScenarioCanaryTurnStoppingProgress(ctx, {
    phase: 'positive',
    progress,
    isTrackedAgent: agent => agent.id === 'tracked-agent',
    onCompleted() {
      entered.push('callback-entered')
      canaryCallbackEntered()
      return new Promise(resolve => {
        releaseCanaryCallback = () => {
          entered.push('callback-completed')
          resolve()
        }
      })
    },
  })

  const dispatch = (async () => {
    for (const listener of listeners) {
      await listener({ agent: { id: 'tracked-agent' } })
    }
  })()
  await runtimeListenerStarted
  await reporter.reportDeadline()
  assert.deepEqual(entered, [SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED])
  assert.deepEqual(writes, [
    SCENARIO_CANARY_FAILURE_MARKER + JSON.stringify({
      schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary-failure.v1',
      phase: 'positive',
      process_instance_sha256: processInstance,
      cause_code: SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
    }) + '\n',
  ])

  releaseRuntimeListener()
  await canaryCallbackStarted
  assert.deepEqual(entered, [
    SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
    SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    'callback-entered',
  ])
  releaseCanaryCallback()
  await dispatch
  assert.deepEqual(entered, [
    SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
    SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    'callback-entered',
    'callback-completed',
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_CALLBACK_COMPLETED,
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_LISTENER_TAIL_COMPLETED,
  ])
})

test('a repeated tracked stop is distinguished at the listener tail', async () => {
  const {
    registerScenarioCanaryTurnStoppingProgress,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')
  const listeners = []
  const ctx = {
    on(event, listener, options = {}) {
      assert.equal(event, 'agent/turn-stopping')
      if (options.prepend === true) listeners.unshift(listener)
      else listeners.push(listener)
    },
  }
  const entered = []
  let outcome = 'allow'
  registerScenarioCanaryTurnStoppingProgress(ctx, {
    phase: 'positive',
    progress: { enter(code) { entered.push(code) } },
    isTrackedAgent: agent => agent.id === 'tracked-agent',
    stopPolicyOutcome: (_agent, turn) => turn === 1 ? outcome : undefined,
    onCompleted() {},
  })

  const dispatch = async () => {
    for (const listener of listeners) {
      await listener({ agent: { id: 'tracked-agent' }, turn: 1 })
    }
  }
  await dispatch()

  const scenarios = [
    ['allow', 'CANARY_REPEATED_STOP_POLICY_ALLOWED'],
    ['context', 'CANARY_REPEATED_STOP_POLICY_CONTEXT'],
    ['policy-denied', 'CANARY_REPEATED_STOP_POLICY_DENIED'],
    ['capability-unavailable', 'CANARY_REPEATED_STOP_CAPABILITY_UNAVAILABLE'],
    ['transport-failed', 'CANARY_REPEATED_STOP_TRANSPORT_FAILED'],
    ['provider-failed', 'CANARY_REPEATED_STOP_PROVIDER_FAILED'],
    ['cancelled', 'CANARY_REPEATED_STOP_CANCELLED'],
  ]
  for (const [nextOutcome, progressName] of scenarios) {
    outcome = nextOutcome
    await dispatch()
    assert.equal(
      entered.at(-1),
      SCENARIO_CANARY_PROGRESS[progressName],
      nextOutcome,
    )
    assert.equal(
      SCENARIO_CANARY_PROGRESS[progressName],
      `DSH_CANARY_DEADLINE_${progressName}`,
      nextOutcome,
    )
  }

  outcome = undefined
  await dispatch()
  assert.equal(
    entered.at(-1),
    SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED,
  )
})

test('post-stop settlement progress distinguishes turn end, idle, and a restarted turn', async () => {
  const {
    registerScenarioCanaryAgentSettlementProgress,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_TURN_ENDED_AFTER_STOP,
    'DSH_CANARY_DEADLINE_CANARY_TURN_ENDED_AFTER_STOP',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_AGENT_IDLE_STATUS_AFTER_STOP,
    'DSH_CANARY_DEADLINE_CANARY_AGENT_IDLE_STATUS_AFTER_STOP',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_AGENT_RESTARTED_AFTER_STOP,
    'DSH_CANARY_DEADLINE_CANARY_AGENT_RESTARTED_AFTER_STOP',
  )
  assert.equal(
    SCENARIO_CANARY_PROGRESS.CANARY_NEXT_TURN_STARTED_AFTER_STOP,
    'DSH_CANARY_DEADLINE_CANARY_NEXT_TURN_STARTED_AFTER_STOP',
  )

  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      listeners.set(event, [...registered, listener])
    },
  }
  const entered = []
  let completedStops = 0
  registerScenarioCanaryAgentSettlementProgress(ctx, {
    phase: 'positive',
    progress: { enter(code) { entered.push(code) } },
    isTrackedAgent: agent => agent.id === 'tracked-agent',
    isTrackedSession: session => session.id === 'tracked-session',
    hasCompletedStop: () => completedStops > 0,
  })
  const emit = async (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) await listener(...args)
  }

  await emit('session/event', { id: 'tracked-session' }, { type: 'turn/end' })
  await emit('agent/status', { agent: { id: 'tracked-agent' }, status: 'idle' })
  assert.deepEqual(entered, [])

  completedStops = 1
  await emit('session/event', { id: 'tracked-session' }, { type: 'turn/end' })
  await emit('agent/status', { agent: { id: 'tracked-agent' }, status: 'idle' })
  await emit('agent/status', { agent: { id: 'tracked-agent' }, status: 'running' })
  await emit('session/event', { id: 'tracked-session' }, { type: 'turn/start' })
  assert.deepEqual(entered, [
    SCENARIO_CANARY_PROGRESS.CANARY_TURN_ENDED_AFTER_STOP,
    SCENARIO_CANARY_PROGRESS.CANARY_AGENT_IDLE_STATUS_AFTER_STOP,
    SCENARIO_CANARY_PROGRESS.CANARY_AGENT_RESTARTED_AFTER_STOP,
    SCENARIO_CANARY_PROGRESS.CANARY_NEXT_TURN_STARTED_AFTER_STOP,
  ])
})

test('pending turn-stopping callbacks retain the preceding deadline boundary', async () => {
  const {
    createScenarioCanaryProgressReporter,
    registerScenarioCanaryTurnStoppingProgress,
    SCENARIO_CANARY_FAILURE_MARKER,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')
  const listeners = []
  const ctx = {
    on(event, listener, options = {}) {
      assert.equal(event, 'agent/turn-stopping')
      if (options.prepend === true) listeners.unshift(listener)
      else listeners.push(listener)
    },
  }
  const writes = []
  const processInstance = 'sha256:' + 'c'.repeat(64)
  const reporter = createScenarioCanaryProgressReporter({
    phase: 'positive',
    processInstance,
    stream: {
      write(chunk, callback) {
        writes.push(chunk)
        callback()
        return true
      },
    },
  })
  const entered = []
  let releaseCallback
  let callbackEntered
  const callbackStarted = new Promise(resolve => { callbackEntered = resolve })
  registerScenarioCanaryTurnStoppingProgress(ctx, {
    phase: 'positive',
    progress: {
      enter(code) {
        entered.push(code)
        reporter.enter(code)
      },
    },
    isTrackedAgent: agent => agent.id === 'tracked-agent',
    onCompleted() {
      callbackEntered()
      return new Promise(resolve => { releaseCallback = resolve })
    },
  })

  const dispatch = (async () => {
    for (const listener of listeners) {
      await listener({ agent: { id: 'tracked-agent' } })
    }
  })()
  await callbackStarted
  await reporter.reportDeadline()
  assert.deepEqual(entered, [
    SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
    SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
  ])
  assert.deepEqual(writes, [
    SCENARIO_CANARY_FAILURE_MARKER + JSON.stringify({
      schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary-failure.v1',
      phase: 'positive',
      process_instance_sha256: processInstance,
      cause_code: SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    }) + '\n',
  ])

  releaseCallback()
  await dispatch
  assert.equal(
    entered.at(-1),
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_LISTENER_TAIL_COMPLETED,
  )
})

test('turn-stopping callback failures cannot advance completion progress', async () => {
  const {
    registerScenarioCanaryTurnStoppingProgress,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')

  for (const scenario of [
    {
      name: 'rejected callback',
      onCompleted() { return Promise.reject(new Error('callback rejected')) },
      expected: /callback rejected/u,
    },
    {
      name: 'throwing callback',
      onCompleted() { throw new Error('callback threw') },
      expected: /callback threw/u,
    },
  ]) {
    const listeners = []
    const ctx = {
      on(event, listener, options = {}) {
        assert.equal(event, 'agent/turn-stopping')
        if (options.prepend === true) listeners.unshift(listener)
        else listeners.push(listener)
      },
    }
    const entered = []
    registerScenarioCanaryTurnStoppingProgress(ctx, {
      phase: 'positive',
      progress: { enter(code) { entered.push(code) } },
      isTrackedAgent: agent => agent.id === 'tracked-agent',
      onCompleted: scenario.onCompleted,
    })

    const dispatch = async () => {
      for (const listener of listeners) {
        await listener({ agent: { id: 'tracked-agent' } })
      }
    }
    await assert.rejects(dispatch(), scenario.expected, scenario.name)
    assert.deepEqual(entered, [
      SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
      SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    ], scenario.name)
  }
})

test('the process supervisor outlives the canary-wide execution deadline', async () => {
  const timeouts = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  assert.equal(timeouts.SCENARIO_CANARY_EXECUTION_TIMEOUT_MS, 120_000)
  assert.equal(timeouts.SCENARIO_CANARY_PROCESS_TIMEOUT_MS, 180_000)
  const supervisor = readFileSync(
    new URL('./authoritative-acceptance-smoke.mjs', import.meta.url),
    'utf8',
  )
  assert.match(supervisor, /timeout: SCENARIO_CANARY_PROCESS_TIMEOUT_MS/u)
  assert.match(supervisor, /\[SCENARIO_CANARY_DEADLINE_ENV\]: String\(executionDeadline\)/u)

  const canary = readFileSync(
    new URL('./fixtures/authoritative-acceptance-canary/index.js', import.meta.url),
    'utf8',
  )
  const controllerIndex = canary.indexOf('createScenarioCanaryDeadlineController({')
  const runIndex = canary.indexOf('const run = async')
  assert.ok(controllerIndex >= 0 && controllerIndex < runIndex)
  assert.doesNotMatch(canary, /setTimeout\([\s\S]*SCENARIO_CANARY_EXECUTION_TIMEOUT_MS/u)
})

test('a late canary start receives only its process-origin execution budget', async () => {
  const { scheduleScenarioCanaryDeadline } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  const processStartedAt = 2_000_000_000_000
  const deadline = String(processStartedAt + 120_000)
  let scheduledDelay
  let scheduledCallback
  let deadlineObserved = false
  const expectedTimer = /** @type {ReturnType<typeof setTimeout>} */ ({})
  const timer = scheduleScenarioCanaryDeadline(deadline, () => {
    deadlineObserved = true
  }, {
    now: () => processStartedAt + 75_000,
    setTimer(callback, delay) {
      scheduledCallback = callback
      scheduledDelay = delay
      return expectedTimer
    },
  })
  assert.equal(timer, expectedTimer)
  assert.equal(scheduledDelay, 45_000)
  assert.equal(typeof scheduledCallback, 'function')
  scheduledCallback()
  assert.equal(deadlineObserved, true)
})

test('deadline finalization fails closed once before service readiness', async () => {
  const { createScenarioCanaryDeadlineController } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  const events = []
  const writes = []
  let handleGeneration = 'initial'
  let deadlineCallback
  const expectedTimer = /** @type {ReturnType<typeof setTimeout>} */ ({})
  const controller = createScenarioCanaryDeadlineController({
    deadlineEpoch: '2000000120000',
    stream: {
      write(chunk, callback) {
        writes.push(chunk)
        callback()
        return true
      },
    },
    reportFailure(error) { events.push('failure:' + error.message) },
    async dispose() { events.push('dispose:' + handleGeneration) },
    successStatus: () => 0,
    setExitCode(status) { events.push('status:' + status) },
    exit(status) { events.push('exit:' + status) },
    now: () => 2_000_000_075_000,
    setTimer(callback, delay) {
      assert.equal(delay, 45_000)
      deadlineCallback = callback
      return expectedTimer
    },
    clearTimer(timer) {
      assert.equal(timer, expectedTimer)
      events.push('clear')
    },
  })
  assert.equal(controller.isFinalizing(), false)
  assert.equal(typeof deadlineCallback, 'function')
  deadlineCallback()
  await controller.wait()
  assert.equal(controller.isFinalizing(), true)
  assert.deepEqual(writes, [])
  assert.deepEqual(events, [
    'failure:scenario execution deadline exceeded',
    'dispose:initial',
    'status:1',
    'exit:1',
  ])

  handleGeneration = 'replacement'
  await controller.finish({ phase: 'positive' }, undefined)
  assert.deepEqual(writes, [])
  assert.deepEqual(events, [
    'failure:scenario execution deadline exceeded',
    'dispose:initial',
    'status:1',
    'exit:1',
    'clear',
    'dispose:replacement',
  ])
})

test('deadline finalization emits one bounded process-bound progress marker', async () => {
  const {
    createScenarioCanaryDeadlineController,
    createScenarioCanaryProgressReporter,
    SCENARIO_CANARY_FAILURE_MARKER,
    SCENARIO_CANARY_PROGRESS,
  } = await import('./fixtures/authoritative-acceptance-canary/receipt-output.js')
  const events = []
  const failureWrites = []
  let deadlineCallback
  let markerFlushed
  const processInstance = 'sha256:' + 'a'.repeat(64)
  const progress = createScenarioCanaryProgressReporter({
    phase: 'positive',
    processInstance,
    stream: {
      write(chunk, callback) {
        events.push('marker-write')
        failureWrites.push(chunk)
        markerFlushed = callback
        return false
      },
    },
  })
  progress.enter(SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED)
  const controller = createScenarioCanaryDeadlineController({
    deadlineEpoch: '2000000120000',
    stream: { write() { assert.fail('a deadline must not write a success receipt') } },
    reportFailure(error) { events.push('failure:' + error.message) },
    async dispose() { events.push('dispose') },
    successStatus: () => 0,
    setExitCode(status) { events.push('status:' + status) },
    exit(status) { events.push('exit:' + status) },
    onDeadline: () => progress.reportDeadline(),
    now: () => 2_000_000_075_000,
    setTimer(callback) {
      deadlineCallback = callback
      return /** @type {ReturnType<typeof setTimeout>} */ ({})
    },
  })

  deadlineCallback()
  deadlineCallback()
  await Promise.resolve()
  assert.equal(typeof markerFlushed, 'function')
  assert.deepEqual(events, ['marker-write'])

  markerFlushed()
  await controller.wait()
  deadlineCallback()
  await controller.wait()

  assert.deepEqual(failureWrites, [
    SCENARIO_CANARY_FAILURE_MARKER + JSON.stringify({
      schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary-failure.v1',
      phase: 'positive',
      process_instance_sha256: processInstance,
      cause_code: 'DSH_CANARY_DEADLINE_TURN_STOPPING_ENTERED',
    }) + '\n',
  ])
  assert.deepEqual(events, [
    'marker-write',
    'failure:scenario execution deadline exceeded',
    'dispose',
    'status:1',
    'exit:1',
  ])
  assert.throws(
    () => progress.enter('PRIVATE_DEADLINE_DETAIL'),
    /progress milestone is invalid/u,
  )
})

test('an elapsed deadline cannot be cleared into a success receipt', async () => {
  const { createScenarioCanaryDeadlineController } = await import(
    './fixtures/authoritative-acceptance-canary/receipt-output.js'
  )
  const events = []
  const writes = []
  let currentTime = 2_000_000_075_000
  let deadlineCallback
  const expectedTimer = /** @type {ReturnType<typeof setTimeout>} */ ({})
  const controller = createScenarioCanaryDeadlineController({
    deadlineEpoch: '2000000120000',
    stream: {
      write(chunk, callback) {
        writes.push(chunk)
        callback()
        return true
      },
    },
    reportFailure(error) { events.push('failure:' + error.message) },
    async dispose() { events.push('dispose') },
    successStatus: () => 0,
    setExitCode(status) { events.push('status:' + status) },
    exit(status) { events.push('exit:' + status) },
    now: () => currentTime,
    setTimer(callback, delay) {
      assert.equal(delay, 45_000)
      deadlineCallback = callback
      return expectedTimer
    },
    clearTimer(timer) {
      assert.equal(timer, expectedTimer)
      events.push('clear')
    },
  })
  assert.equal(typeof deadlineCallback, 'function')

  currentTime = 2_000_000_120_000
  await controller.finish({ phase: 'positive' }, undefined)
  deadlineCallback()
  await controller.wait()

  assert.deepEqual(writes, [])
  assert.deepEqual(events, [
    'clear',
    'failure:scenario execution deadline exceeded',
    'dispose',
    'status:1',
    'exit:1',
  ])
})

test('an acceptance canary waits for both runtime services across staggered activation', () => {
  const runtime = Object.freeze({})
  const acceptance = Object.freeze({})
  const services = new Map([['dshRuntimeKit', runtime]])
  const starts = []
  let dependencies
  let injected
  const ctx = {
    get(name) { return services.get(name) },
    inject(names, callback) {
      dependencies = names
      injected = callback
    },
  }

  startScenarioCanaryWhenReady(ctx, true, service => { starts.push(service) })
  assert.deepEqual(starts, [])
  assert.deepEqual(dependencies, ['dshRuntimeKit', 'dshAcceptance'])

  services.set('dshAcceptance', acceptance)
  injected(ctx)
  injected(ctx)
  assert.deepEqual(starts, [acceptance])
})

test('an acceptance canary starts immediately when both runtime services already exist', () => {
  const acceptance = Object.freeze({})
  const starts = []
  const ctx = {
    get(name) {
      if (name === 'dshRuntimeKit') return Object.freeze({})
      if (name === 'dshAcceptance') return acceptance
    },
    inject() { assert.fail('an already-ready canary must not register a late injection') },
  }
  startScenarioCanaryWhenReady(ctx, true, service => { starts.push(service) })
  assert.deepEqual(starts, [acceptance])
})

test('the canary waits for its receipt line to flush before allowing host exit', async () => {
  const receipt = {
    schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary.v1',
    phase: 'positive',
    process_instance_sha256: 'sha256:' + 'a'.repeat(64),
  }
  const writes = []
  const events = []
  let flushed
  const stream = {
    write(chunk, callback) {
      writes.push(chunk)
      events.push('write')
      flushed = callback
      return false
    },
  }
  const pending = finalizeScenarioCanary({
    stream,
    receipt,
    reportFailure() { events.push('failure') },
    async dispose() { events.push('dispose') },
    successStatus: 0,
    setExitCode(status) { events.push('status:' + status) },
    exit(status) { events.push('exit:' + status) },
  })
  await Promise.resolve()
  assert.deepEqual(events, ['write'])
  assert.deepEqual(writes, [
    'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY=' + JSON.stringify(receipt) + '\n',
  ])
  flushed()
  await pending
  assert.deepEqual(events, ['write', 'dispose', 'status:0', 'exit:0'])
})

test('the canary fails host exit closed when its receipt write fails', async () => {
  for (const mode of ['callback', 'throw']) {
    const failure = new Error('closed output')
    const events = []
    await finalizeScenarioCanary({
      stream: {
        write(_chunk, callback) {
          events.push('write')
          if (mode === 'throw') throw failure
          callback(failure)
          return false
        },
      },
      receipt: { phase: 'positive' },
      reportFailure(error) {
        assert.equal(error, failure)
        events.push('failure')
      },
      async dispose() { events.push('dispose') },
      successStatus: 0,
      setExitCode(status) { events.push('status:' + status) },
      exit(status) { events.push('exit:' + status) },
    })
    assert.deepEqual(events, ['write', 'failure', 'dispose', 'status:1', 'exit:1'])
  }
})

test('the canary retains process failure when host exit is unavailable or throws', async () => {
  for (const mode of ['unavailable', 'throw']) {
    let processStatus = 0
    const hostFailure = new Error('host exit failed')
    const pending = finalizeScenarioCanary({
      stream: {
        write(_chunk, callback) {
          callback(new Error('closed output'))
          return false
        },
      },
      receipt: { phase: 'positive' },
      reportFailure() {},
      async dispose() {},
      successStatus: 0,
      setExitCode(status) { processStatus = status },
      exit() {
        if (mode === 'throw') throw hostFailure
      },
    })
    if (mode === 'throw') await assert.rejects(pending, hostFailure)
    else await pending
    assert.equal(processStatus, 1)
  }
})

test('body evidence freezes body-side observations at the first stopping turn', () => {
  const happy = createBodyExecutionCounter()
  happy.bodyExecuted()
  happy.turnStopping(1)
  happy.bodyExecuted()
  assert.equal(happy.receipt(), 2)

  const denied = createBodyExecutionCounter()
  denied.turnStopping()
  denied.bodyExecuted()
  denied.bodyExecuted()
  assert.equal(denied.receipt(), 0)
})

test('a successful result without body-side marker evidence cannot advance the count', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-body-evidence-'))
  try {
    const marker = join(root, 'validation')
    const token = 'exact-validation-token'
    const resultReportedSuccess = true
    assert.equal(resultReportedSuccess, true)

    const missing = createBodyExecutionCounter()
    missing.bodyExecuted()
    missing.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(missing.receipt(), 1)

    writeFileSync(marker, token + '\n', { mode: 0o600 })
    const observed = createBodyExecutionCounter()
    observed.bodyExecuted()
    observed.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(observed.receipt(), 2)

    writeFileSync(marker, token + '\n' + token + '\n', { mode: 0o600 })
    const duplicated = createBodyExecutionCounter()
    duplicated.bodyExecuted()
    duplicated.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(duplicated.receipt(), 3)

    writeFileSync(marker, 'forged\n', { mode: 0o600 })
    assert.throws(
      () => validationBodyExecutions(marker, token),
      /validation body evidence is invalid/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancellable child lookup fails closed when host process enumeration is unavailable', () => {
  assert.throws(
    () => observableChildPid(
      42,
      '/isolated/cancellable.pid',
      '/isolated/cancellable.heartbeat',
      '/definitely-not-a-proc-root',
    ),
    /host-visible cancellable child lookup unavailable/u,
  )
})
