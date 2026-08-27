import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DshAcceptanceBlockedError,
  createAcceptanceProjection,
  createAuthoritativeAcceptanceCoordinator,
  toolDefinitionDigest,
} from '../src/authoritative-acceptance/index.js'

const contractDigest = `sha256:${'a'.repeat(64)}`
const correlationId = 'correlation:acceptance'

function definition(name) {
  return Object.freeze({
    name,
    description: `${name} test tool`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'null' },
      render: () => [],
    },
    async execute() { return null },
  })
}

function agent(id = 'session-1') {
  const appended = []
  const session = {
    header: { id, cwd: '/workspace/project' },
    events: [],
    append(type, data) { appended.push({ type, data }) },
  }
  const steers = []
  return {
    id,
    session,
    appended,
    steers,
    steer(message) { steers.push(message) },
  }
}

function verdict(requirements, aggregate = 'missing', generation = 0) {
  return {
    action: aggregate === 'satisfied' ? 'allow' : 'block',
    aggregate,
    generation,
    contractDigest,
    correlationId,
    reasonCodes: aggregate === 'satisfied' ? [] : [aggregate],
    requirements: requirements.map(([name, status, attemptGeneration]) => ({
      name,
      status,
      attemptGeneration,
    })),
  }
}

function fixture({ useDefaultOperationId = false, ...coordinatorOverrides } = {}) {
  const mutation = definition('edit')
  const unit = definition('runtime_kit_plus_one')
  const packageCheck = definition('package_check')
  const bash = definition('bash')
  const visible = new Map([
    [mutation.name, mutation],
    [unit.name, unit],
    [packageCheck.name, packageCheck],
    [bash.name, bash],
  ])
  const currentAgents = new Map()
  const effects = []
  const calls = {
    register: [],
    admit: [],
    observe: [],
    verdict: [],
    abandon: [],
    authorityRelease: [],
  }
  const sources = new Map()
  let currentVerdict = verdict([
    ['package', 'missing', undefined],
    ['unit', 'missing', undefined],
  ])
  const ctx = {
    agents: {
      get(id) { return currentAgents.get(id) },
      list() { return [...currentAgents.values()] },
    },
    tools: { get(name) { return visible.get(name) } },
    effect(start) { effects.push(start()); return effects.at(-1) },
    provide(name, value) { this[name] = value },
  }
  const client = {
    async registerAcceptance(request) {
      calls.register.push(request)
      return {
        status: 'registered',
        contractDigest,
        requirementCount: request.requirements.length,
        correlationId,
      }
    },
    async admitAcceptance(request) {
      calls.admit.push(request)
      currentVerdict = verdict([
        ['package', 'active', request.operation.kind === 'validator' ? 1 : undefined],
        ['unit', 'missing', undefined],
      ], 'active', 1)
      return {
        status: 'admitted',
        operationId: request.operationId,
        operationKind: request.operation.kind,
        generation: 1,
        contractDigest,
        correlationId,
      }
    },
    async observeAcceptance(request) {
      calls.observe.push(request)
      if (request.observation.status === 'infrastructure-blocked') {
        currentVerdict = verdict([
          ['package', 'infrastructure-blocked', undefined],
          ['unit', 'infrastructure-blocked', undefined],
        ], 'infrastructure-blocked', 1)
      } else if (request.operationId.includes('runtime-plus-one')) {
        currentVerdict = verdict([
          ['package', 'satisfied', 1],
          ['unit', 'satisfied', 1],
        ], 'satisfied', 1)
      } else if (request.operationId.includes('package')) {
        currentVerdict = verdict([
          ['package', 'satisfied', 1],
          ['unit', 'missing', undefined],
        ], 'missing', 1)
      } else {
        currentVerdict = verdict([
          ['package', 'missing', undefined],
          ['unit', 'missing', undefined],
        ], 'missing', 1)
      }
      return {
        status: 'applied',
        operationId: request.operationId,
        generation: 1,
        observation: request.observation.status ?? 'succeeded',
        correlationId,
      }
    },
    async acceptanceVerdict(request) {
      calls.verdict.push(request)
      return request.completionReservation === undefined || currentVerdict.action !== 'allow'
        ? currentVerdict
        : {
            ...currentVerdict,
            completionReservation: {
              operationId: request.completionReservation,
              status: 'reserved',
            },
          }
    },
    abandonAcceptance(request) { calls.abandon.push(request) },
  }
  const authority = {
    async withAuthority(owner, turnId, signal, invoke) {
      assert.equal(currentAgents.get(owner.id), owner)
      assert.equal(signal.aborted, false)
      return invoke({
        identity: {
          product: 'dsh',
          sessionId: owner.id,
          turnId,
          cwd: owner.session.header.cwd,
        },
        runnerCapability: 'runner:private',
        acceptCorrelation(value) { assert.equal(value, correlationId) },
      })
    },
    async releaseAfterAcceptance(owner) {
      assert.equal(currentAgents.get(owner.id), owner)
      assert.equal(calls.observe.at(-1)?.observation?.status, 'succeeded')
      calls.authorityRelease.push(owner.id)
    },
    sourceOperation(exec) { return sources.get(exec) },
  }
  let operationSequence = 0
  const coordinatorOptions = {
    client,
    authority,
    ...coordinatorOverrides,
  }
  if (!useDefaultOperationId) {
    coordinatorOptions.createOperationId = (kind, binding) => {
      operationSequence += 1
      return `acceptance:${binding.id ?? kind}:${operationSequence}`
    }
  }
  const coordinator = createAuthoritativeAcceptanceCoordinator(ctx, coordinatorOptions)
  const owner = agent()
  currentAgents.set(owner.id, owner)
  return {
    coordinator,
    service: ctx.dshAcceptance,
    owner,
    mutation,
    unit,
    packageCheck,
    bash,
    visible,
    sources,
    calls,
    client,
    authority,
    addAgent(selected) { currentAgents.set(selected.id, selected) },
    removeAgent(selected) { currentAgents.delete(selected.id) },
    setVerdict(value) { currentVerdict = value },
  }
}

function registration(value) {
  return {
    requirements: [
      {
        name: 'unit',
        validators: [{
          id: 'runtime-plus-one',
          definition: value.unit,
          execution: { kind: 'host-observed' },
        }],
      },
      {
        name: 'package',
        validators: [{
          id: 'package-check',
          definition: value.packageCheck,
          execution: { kind: 'host-observed' },
        }],
      },
    ],
    invalidators: [value.mutation],
  }
}

function containedRegistration(value) {
  return {
    requirements: [
      {
        name: 'unit',
        validators: [{
          id: 'unit-bash',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'test', command: 'npm test -- unit' },
        }],
      },
      {
        name: 'package',
        validators: [{
          id: 'package-bash',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'test', command: 'npm test -- package' },
        }],
      },
    ],
    invalidators: [value.mutation],
  }
}

function execution(owner, definition, callId) {
  return {
    token: {},
    callId,
    rootCallId: callId,
    name: definition.name,
    arguments: {},
    agent: owner,
    signal: new AbortController().signal,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function controlledReadiness() {
  let available = true
  let gate = Promise.resolve()
  let settleGate = () => {}
  return {
    block() {
      available = false
      gate = new Promise(resolve => { settleGate = resolve })
    },
    release() {
      available = true
      settleGate()
    },
    async wait(_agent) { await gate },
    ready(_agent) { return available },
  }
}

const call = exec => ({
  sessionId: exec.agent.id,
  cwd: exec.agent.session.header.cwd,
  turn: 1,
  step: 1,
  callId: exec.callId,
  rootCallId: exec.rootCallId,
  name: exec.name,
})

function containedExecution(value, callId, command = 'npm test -- unit') {
  const exec = execution(value.owner, value.bash, callId)
  value.sources.set(exec, {
    operationId: `finish-line-source:${callId}`,
    intent: 'test',
    command,
  })
  return exec
}

test('definition digests bind the complete public schema and ignore callback identity', () => {
  const left = definition('validator')
  const right = { ...left, execute: async () => 'different trusted implementation' }
  assert.match(toolDefinitionDigest(left), /^sha256:[0-9a-f]{64}$/u)
  assert.equal(toolDefinitionDigest(left), toolDefinitionDigest(right))
  assert.notEqual(
    toolDefinitionDigest(left),
    toolDefinitionDigest({ ...left, description: 'drifted description' }),
  )
})

test('registration uses nils-compatible lexical ordering for every public identifier', async () => {
  const value = fixture()
  const validators = ['a', '~', 'Z', '!'].map(id => ({
    id,
    definition: definition(`validator-${id}`),
    execution: { kind: 'host-observed' },
  }))
  for (const validator of validators) {
    value.visible.set(validator.definition.name, validator.definition)
  }
  const secondary = {
    id: 'secondary',
    definition: definition('validator-secondary'),
    execution: { kind: 'host-observed' },
  }
  value.visible.set(secondary.definition.name, secondary.definition)
  const invalidators = ['mutation-a', 'mutation-Z', 'mutation-!'].map(definition)
  for (const invalidator of invalidators) value.visible.set(invalidator.name, invalidator)
  value.service.register({
    requirements: [
      { name: 'a', validators: [secondary] },
      { name: 'Z', validators: [validators[1], validators[0], validators[2], validators[3]] },
    ],
    invalidators,
  })
  value.setVerdict(verdict([
    ['Z', 'missing', undefined],
    ['a', 'missing', undefined],
  ]))

  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  assert.deepEqual(value.calls.register[0].requirements.map(entry => entry.name), ['Z', 'a'])
  assert.deepEqual(
    value.calls.register[0].requirements[0].validators.map(entry => entry.id),
    ['!', 'Z', 'a', '~'],
  )
  assert.deepEqual(
    value.calls.register[0].invalidators.map(entry => entry.toolName),
    ['mutation-!', 'mutation-Z', 'mutation-a'],
  )
  assert.equal(value.service.verdict(value.owner).aggregate, 'missing')
})

test('default operation ids stay bounded for a maximum-length validator id', async () => {
  const value = fixture({ useDefaultOperationId: true })
  const input = registration(value)
  input.requirements[0].validators[0].id = 'v'.repeat(256)
  value.service.register(input)
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const exec = execution(value.owner, value.unit, 'maximum-validator-id')
  await value.coordinator.admit(exec, call(exec))

  const operationId = value.calls.admit.at(-1).operationId
  assert.equal(operationId.length <= 256, true)
  assert.match(operationId, /^dsh-acceptance:validator:[0-9a-f]{64}:[0-9a-f-]{36}$/u)
})

test('replacement readiness gates startup, admission, mutation, stop, and synchronous completion', async () => {
  const readiness = controlledReadiness()
  const value = fixture({ workspaceReadiness: readiness })
  readiness.block()
  value.service.register(registration(value))
  let startupSettled = false
  const startup = value.coordinator.sessionStarted({ agent: value.owner, source: 'resume' })
    .then(() => { startupSettled = true })
  await Promise.resolve()
  assert.equal(startupSettled, false)
  assert.equal(value.calls.register.length, 0)
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError
      && error.aggregate === 'infrastructure-blocked',
  )
  readiness.release()
  await startup
  assert.equal(value.calls.register.length, 1)

  readiness.block()
  const admitted = execution(value.owner, value.unit, 'replacement-validator')
  let admissionSettled = false
  const admission = value.coordinator.admit(admitted, call(admitted))
    .then(result => { admissionSettled = true; return result })
  await Promise.resolve()
  assert.equal(admissionSettled, false)
  assert.equal(value.calls.admit.length, 0)
  readiness.release()
  assert.equal((await admission).kind, 'validator')
  value.coordinator.reject(admitted)

  readiness.block()
  const ordinary = execution(value.owner, value.bash, 'replacement-mutation')
  let mutationSettled = false
  const mutation = value.coordinator.repositoryMutationStarting(ordinary, call(ordinary))
    .then(() => { mutationSettled = true })
  await Promise.resolve()
  assert.equal(mutationSettled, false)
  assert.equal(value.coordinator.activeOperations, 1)
  readiness.release()
  await mutation
  assert.equal(value.coordinator.activeOperations, 1)
  value.coordinator.reject(ordinary)

  readiness.block()
  let stopSettled = false
  const stop = value.coordinator.turnStopping({
    agent: value.owner,
    turn: 2,
    signal: new AbortController().signal,
  }).then(result => { stopSettled = true; return result })
  await Promise.resolve()
  assert.equal(stopSettled, false)
  assert.throws(
    () => value.service.verdict(value.owner),
    /workspace disposal pending/u,
  )
  readiness.release()
  assert.equal(typeof (await stop), 'boolean')
})

test('caller cancellation interrupts every blocked replacement readiness operation', async () => {
  const readiness = controlledReadiness()
  const value = fixture({ workspaceReadiness: readiness })
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  readiness.block()
  const admissionAbort = new AbortController()
  const admitted = {
    ...execution(value.owner, value.unit, 'cancelled-replacement-validator'),
    signal: admissionAbort.signal,
  }
  const admission = value.coordinator.admit(admitted, call(admitted))
  assert.equal(value.coordinator.activeOperations, 1)
  admissionAbort.abort(new Error('replacement admission cancelled'))
  await assert.rejects(admission, /replacement admission cancelled/u)
  assert.equal(value.coordinator.activeOperations, 0)
  assert.equal(value.calls.admit.length, 0)
  readiness.release()

  readiness.block()
  const mutationAbort = new AbortController()
  const ordinary = {
    ...execution(value.owner, value.bash, 'cancelled-replacement-mutation'),
    signal: mutationAbort.signal,
  }
  const mutation = value.coordinator.repositoryMutationStarting(ordinary, call(ordinary))
  assert.equal(value.coordinator.activeOperations, 1)
  mutationAbort.abort(new Error('replacement mutation cancelled'))
  await assert.rejects(mutation, /replacement mutation cancelled/u)
  assert.equal(value.coordinator.activeOperations, 0)
  readiness.release()

  readiness.block()
  const stopAbort = new AbortController()
  const stop = value.coordinator.turnStopping({
    agent: value.owner,
    turn: 3,
    signal: stopAbort.signal,
  })
  assert.equal(value.coordinator.activeOperations, 1)
  stopAbort.abort(new Error('replacement stop cancelled'))
  assert.equal(await stop, false)
  assert.equal(value.coordinator.activeOperations, 0)
  readiness.release()
  assert.equal(value.service.verdict(value.owner).aggregate, 'missing')
})

test('coordinator disposal interrupts and joins blocked replacement readiness', async () => {
  const readiness = controlledReadiness()
  const value = fixture({ workspaceReadiness: readiness })
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  readiness.block()
  const admitted = execution(value.owner, value.unit, 'disposed-replacement-validator')
  const admission = value.coordinator.admit(admitted, call(admitted))
  assert.equal(value.coordinator.activeOperations, 1)

  const disposal = value.coordinator.dispose()
  await assert.rejects(admission, /acceptance coordinator disposed/u)
  await disposal
  assert.equal(value.coordinator.activeOperations, 0)
  assert.equal(value.calls.admit.length, 0)
  readiness.release()
})

test('the session projection folds only standard tool events and exposes no authority material', () => {
  const value = fixture()
  value.service.register(registration(value))
  const projection = createAcceptanceProjection({
    requirements: [{
      name: 'unit',
      validators: [{
        name: 'unit',
        definition: value.unit,
        execution: { kind: 'host-observed' },
      }],
    }],
    invalidators: [{ name: value.mutation.name }],
  })
  let state = projection.init()
  state = projection.apply(state, {
    type: 'tool/call',
    data: { callId: 'call-1', name: value.unit.name, arguments: '{"secret":"omitted"}' },
  })
  state = projection.apply(state, {
    type: 'tool/result',
    data: { message: { source: { callId: 'call-1' }, content: [{ text: 'private output' }] } },
  })
  const view = projection.wire.view(state)
  assert.deepEqual(view, {
    schema_version: 'dsh-runtime-kit.acceptance-projection.v1',
    active_operations: 0,
    last_operation: { kind: 'validator', name: 'unit', status: 'succeeded' },
  })
  assert.doesNotMatch(JSON.stringify(view), /secret|private output|call-1/u)
  assert.deepEqual(projection.stateSchema.parse(state), state)
  assert.deepEqual(projection.wire.viewSchema.parse(view), view)

  const ambiguous = createAcceptanceProjection({
    requirements: [
      {
        name: 'first',
        validators: [{
          name: 'first',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'first', command: 'npm test' },
        }],
      },
      {
        name: 'second',
        validators: [{
          name: 'second',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'second', command: 'npm test' },
        }],
      },
    ],
    invalidators: [],
  })
  const ambiguousState = ambiguous.apply(ambiguous.init(), {
    type: 'tool/call',
    data: { callId: 'call-2', name: value.bash.name, arguments: '{"command":"npm test"}' },
  })
  assert.equal(ambiguousState.active.length, 0,
    'a standard event cannot claim one of two intent-distinct contained Bash validators')
})

test('the provider owns mutation generations, exact validator observations, and completion', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'missing',
  )

  const mutationExec = execution(value.owner, value.mutation, 'mutation')
  const mutationAdmission = await value.coordinator.admit(mutationExec, call(mutationExec))
  assert.equal(mutationAdmission.kind, 'mutation')
  assert.equal(mutationAdmission.replacesLegacyEdit, true)
  assert.equal(value.calls.admit[0].operation.kind, 'mutation')
  value.coordinator.result(mutationExec, { isError: false, content: [], value: null })
  await value.coordinator.settle(value.owner)

  const packageExec = execution(value.owner, value.packageCheck, 'package')
  assert.equal((await value.coordinator.admit(packageExec, call(packageExec))).kind, 'validator')
  value.coordinator.result(packageExec, { isError: false, content: [], value: null })
  await value.coordinator.settle(value.owner)
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'missing',
  )

  const unitExec = execution(value.owner, value.unit, 'unit')
  assert.equal((await value.coordinator.admit(unitExec, call(unitExec))).kind, 'validator')
  value.coordinator.result(unitExec, { isError: false, content: [], value: 2 })
  await value.coordinator.settle(value.owner)

  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError,
  )
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)
  assert.doesNotThrow(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
  )
  assert.deepEqual(value.calls.register[0].requirements.map(entry => entry.name), ['package', 'unit'])
  assert.deepEqual(
    value.calls.register[0].requirements.map(entry => entry.validators[0].toolName),
    ['package_check', 'runtime_kit_plus_one'],
    'registration and admission must bind the same exact DSH tool names',
  )
  assert.equal(value.owner.appended.length, 0, 'authority must not write custom rollback-hostile events')
})

test('a stale refresh cannot restore completion after a newer admission', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)
  value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 })
  await value.coordinator.settle(value.owner)
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))

  const started = deferred()
  const release = deferred()
  const providerVerdict = value.client.acceptanceVerdict
  let delayed = true
  value.client.acceptanceVerdict = async request => {
    if (!delayed) return providerVerdict(request)
    delayed = false
    const captured = verdict([
      ['package', 'satisfied', 0],
      ['unit', 'satisfied', 0],
    ], 'satisfied', 0)
    started.resolve()
    await release.promise
    return request.completionReservation === undefined
      ? captured
      : {
          ...captured,
          completionReservation: {
            operationId: request.completionReservation,
            status: 'reserved',
          },
        }
  }
  const staleStop = value.coordinator.turnStopping({
    agent: value.owner,
    turn: 2,
    signal: new AbortController().signal,
  })
  await started.promise

  const mutation = execution(value.owner, value.mutation, 'newer-mutation')
  const mutationAdmission = value.coordinator.admit(mutation, call(mutation))
  release.resolve()
  await mutationAdmission
  assert.equal(await staleStop, false)
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )
})

test('goal completion consumes the exact reservation before releasing its authority', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))

  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)
  assert.deepEqual(value.calls.authorityRelease, [])

  value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 })
  await value.coordinator.settle(value.owner)

  assert.equal(value.calls.observe.at(-1).observation.status, 'succeeded')
  assert.deepEqual(value.calls.authorityRelease, [value.owner.id])
  assert.deepEqual(value.service.completionSettlement(value.owner), { status: 'succeeded' })
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 2 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )
})

test('goal settlement reports failure after observation or authority release rejects', async () => {
  for (const failure of ['observation', 'release']) {
    const value = fixture()
    value.service.register(registration(value))
    await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
    value.setVerdict(verdict([
      ['package', 'satisfied', 0],
      ['unit', 'satisfied', 0],
    ], 'satisfied', 0))
    assert.equal(await value.coordinator.turnStopping({
      agent: value.owner,
      turn: 1,
      signal: new AbortController().signal,
    }), true)
    if (failure === 'observation') {
      const observe = value.client.observeAcceptance
      value.client.observeAcceptance = async (request, signal) => {
        if (request.observation.status === 'succeeded') {
          throw new Error('completion observation rejected')
        }
        return observe(request, signal)
      }
    } else {
      value.authority.releaseAfterAcceptance = async () => {
        throw new Error('completion authority release rejected')
      }
    }

    value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 })
    assert.deepEqual(value.service.completionSettlement(value.owner), { status: 'pending' })
    await value.coordinator.settle(value.owner)

    assert.deepEqual(value.service.completionSettlement(value.owner), { status: 'failed' }, failure)
    assert.equal(value.coordinator.activeOperations, 0, failure)
    assert.equal(value.service.verdict(value.owner).aggregate, 'infrastructure-blocked', failure)
  }
})

test('goal consumption is claimed before same-repository mutation and remains resource-visible', async () => {
  const value = fixture()
  const other = agent('session-2')
  value.addAgent(other)
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)

  const observeStarted = deferred()
  const finishObserve = deferred()
  const releaseStarted = deferred()
  const finishRelease = deferred()
  const completionObservations = []
  const providerObserve = value.client.observeAcceptance
  value.client.observeAcceptance = async (request, signal) => {
    if (request.observation.status === 'succeeded') {
      completionObservations.push(request.observation.status)
      observeStarted.resolve()
      await finishObserve.promise
    } else if (request.observation.status === 'cancelled') {
      completionObservations.push(request.observation.status)
    }
    return providerObserve(request, signal)
  }
  const releaseAuthority = value.authority.releaseAfterAcceptance
  value.authority.releaseAfterAcceptance = async owner => {
    releaseStarted.resolve()
    await finishRelease.promise
    return releaseAuthority(owner)
  }

  value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 })
  await observeStarted.promise
  const activeDuringObservation = value.coordinator.activeOperations
  const ordinary = execution(other, value.bash, 'mutation-during-goal-consumption')
  await value.coordinator.repositoryMutationStarting(ordinary, call(ordinary))
  const observationsDuringMutation = [...completionObservations]

  finishObserve.resolve()
  await releaseStarted.promise
  const activeDuringRelease = value.coordinator.activeOperations
  finishRelease.resolve()
  await value.coordinator.settle(value.owner)
  const activeAfterConsumption = value.coordinator.activeOperations
  value.coordinator.reject(ordinary)

  assert.equal(activeDuringObservation, 1)
  assert.deepEqual(observationsDuringMutation, ['succeeded'])
  assert.equal(activeDuringRelease, 2)
  assert.equal(activeAfterConsumption, 1)
  assert.equal(value.coordinator.activeOperations, 0)
  assert.deepEqual(value.calls.authorityRelease, [value.owner.id])
})

test('a later lifecycle denial cancels the reservation without releasing retry authority', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)

  await value.coordinator.cancelCompletion(value.owner, '1')

  assert.equal(value.calls.observe.at(-1).observation.status, 'cancelled')
  assert.deepEqual(value.calls.authorityRelease, [])
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )
})

test('goal completion blocks while provider admission is in flight', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)

  const started = deferred()
  const release = deferred()
  const providerAdmit = value.client.admitAcceptance
  value.client.admitAcceptance = async request => {
    started.resolve()
    await release.promise
    return providerAdmit(request)
  }
  const exec = execution(value.owner, value.mutation, 'delayed-admission')
  const admission = value.coordinator.admit(exec, call(exec))
  await started.promise
  try {
    assert.throws(
      () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
      error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
    )
  } finally {
    release.resolve()
    await admission
  }
})

test('an external completion reservation denies one mutation without poisoning its session', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const originalAdmit = value.client.admitAcceptance
  let reserved = true
  value.client.admitAcceptance = async request => {
    if (reserved) {
      const error = new Error('temporary provider conflict')
      error.code = 'DSH_FINISH_LINE_TEMPORARY'
      throw error
    }
    return originalAdmit(request)
  }

  const blocked = execution(value.owner, value.mutation, 'externally-reserved')
  await assert.rejects(
    value.coordinator.admit(blocked, call(blocked)),
    error => error?.code === 'DSH_FINISH_LINE_TEMPORARY',
  )
  assert.equal(value.calls.abandon.length, 1)

  reserved = false
  const retried = execution(value.owner, value.mutation, 'after-external-reservation')
  assert.equal((await value.coordinator.admit(retried, call(retried))).kind, 'mutation')
})

test('a repository mutation invalidates completion reservations in every live session', async () => {
  const value = fixture()
  const other = agent('session-2')
  value.addAgent(other)
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  await value.coordinator.sessionStarted({ agent: other, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)

  const mutation = execution(other, value.mutation, 'cross-session-mutation')
  await value.coordinator.admit(mutation, {
    ...call(mutation),
    sessionId: other.id,
  })
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )
  assert.equal(value.calls.observe.some(entry => (
    entry.operationId.includes('goal-completion')
      && entry.observation.status === 'cancelled'
  )), true)
})

test('a repository mutation does not revoke another workspace completion reservation', async () => {
  const value = fixture()
  const other = agent('session-2')
  other.session.header.cwd = '/workspace/other-project'
  value.addAgent(other)
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  await value.coordinator.sessionStarted({ agent: other, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)

  const mutation = execution(other, value.mutation, 'other-workspace-mutation')
  await value.coordinator.admit(mutation, {
    ...call(mutation),
    sessionId: other.id,
  })

  assert.doesNotThrow(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
  )
  value.coordinator.reject(mutation)
  await Promise.all([
    value.coordinator.settle(value.owner),
    value.coordinator.settle(other),
  ])
})

test('ordinary Bash invalidates a held completion reservation before provider execution', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['package', 'satisfied', 0],
    ['unit', 'satisfied', 0],
  ], 'satisfied', 0))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)
  const ordinary = execution(value.owner, value.bash, 'ordinary-bash-mutation')
  await value.coordinator.repositoryMutationStarting(ordinary, call(ordinary))
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )
  value.coordinator.reject(ordinary)
  assert.equal(value.coordinator.activeOperations, 0)
})

test('turn stop fails active before requesting a completion reservation', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const ordinary = execution(value.owner, value.bash, 'active-ordinary-bash')
  await value.coordinator.repositoryMutationStarting(ordinary, call(ordinary))
  const verdictCalls = value.calls.verdict.length

  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), false)
  assert.equal(value.calls.verdict.length, verdictCalls)
  assert.match(value.owner.steers.at(-1), /repository mutations/u)
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError && error.aggregate === 'active',
  )

  value.coordinator.reject(ordinary)
  assert.equal(value.coordinator.activeOperations, 0)
})

test('acceptance control timeout bounds disposal and prevents a second long observe attempt', async () => {
  const value = fixture({ controlTimeoutMs: 10 })
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const blocked = deferred()
  let attempts = 0
  value.client.observeAcceptance = async (_request, signal) => {
    attempts += 1
    return Promise.race([
      blocked.promise,
      new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  }
  const exec = execution(value.owner, value.unit, 'wedged-observation')
  await value.coordinator.admit(exec, call(exec))
  value.coordinator.result(exec, { isError: false, content: [], value: 2 })

  const disposal = value.coordinator.agentDisposed(value.owner)
  const settledWithinControlBound = await Promise.race([
    disposal.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 80)),
  ])
  if (!settledWithinControlBound) {
    blocked.reject(new Error('release pre-fix wedged observation'))
    await disposal
  }

  assert.equal(settledWithinControlBound, true)
  assert.equal(attempts, 1)
  assert.equal(value.coordinator.activeOperations, 0)
})

test('agent and coordinator disposal join in-flight registration before quiescing', async () => {
  for (const mode of ['agent', 'coordinator']) {
    const value = fixture()
    const started = deferred()
    const finishRegister = deferred()
    const registered = deferred()
    const providerRegister = value.client.registerAcceptance
    value.client.registerAcceptance = async request => {
      started.resolve()
      await finishRegister.promise
      try {
        return await providerRegister(request)
      } finally {
        registered.resolve()
      }
    }
    value.service.register(registration(value))
    await started.promise
    const activeDuringRegistration = value.coordinator.activeOperations
    let disposalSettled = false
    const disposal = (mode === 'agent'
      ? value.coordinator.agentDisposed(value.owner)
      : value.coordinator.dispose())
      .then(() => { disposalSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    const settledBeforeRegistration = disposalSettled
    const verdictCallsBeforeRelease = value.calls.verdict.length

    finishRegister.resolve()
    await registered.promise
    await disposal
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(activeDuringRegistration, 1, mode)
    assert.equal(settledBeforeRegistration, false, mode)
    assert.equal(value.calls.verdict.length, verdictCallsBeforeRelease, mode)
    assert.equal(value.coordinator.activeOperations, 0, mode)
  }
})

test('coordinator disposal joins and terminalizes an admission already in flight', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const started = deferred()
  const release = deferred()
  const providerAdmit = value.client.admitAcceptance
  value.client.admitAcceptance = async request => {
    started.resolve()
    await release.promise
    return providerAdmit(request)
  }
  const exec = execution(value.owner, value.unit, 'dispose-during-admission')
  const admission = value.coordinator.admit(exec, call(exec))
  await started.promise
  const disposal = value.coordinator.dispose()
  release.resolve()
  const [admissionResult, disposalResult] = await Promise.allSettled([admission, disposal])
  assert.equal(admissionResult.status, 'rejected')
  assert.equal(disposalResult.status, 'fulfilled')
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'host-observed',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.coordinator.activeOperations, 0)
})

test('definition replacement, provider failure, and unregistered deployments fail safely', async () => {
  const ungoverned = fixture()
  await ungoverned.coordinator.sessionStarted({ agent: ungoverned.owner, source: 'startup' })
  assert.doesNotThrow(
    () => ungoverned.service.assertGoalCompletion(ungoverned.owner, { id: 'goal', revision: 1 }),
  )

  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'resume' })
  value.visible.set(value.unit.name, { ...value.unit })
  const replaced = execution(value.owner, value.unit, 'replaced')
  await assert.rejects(
    value.coordinator.admit(replaced, call(replaced)),
    /acceptance tool definition changed/u,
  )

  value.visible.set(value.unit.name, value.unit)
  value.unit.parameters.additionalProperties = true
  const mutated = execution(value.owner, value.unit, 'mutated-definition')
  await assert.rejects(
    value.coordinator.admit(mutated, call(mutated)),
    /acceptance tool definition changed/u,
  )
  value.unit.parameters.additionalProperties = false

  value.visible.set(value.mutation.name, { ...value.mutation })
  const replacedMutation = execution(value.owner, value.mutation, 'replaced-mutation')
  await assert.rejects(
    value.coordinator.admit(replacedMutation, call(replacedMutation)),
    /acceptance tool definition changed/u,
  )

  value.setVerdict(verdict([
    ['package', 'infrastructure-blocked', undefined],
    ['unit', 'missing', undefined],
  ], 'infrastructure-blocked', 2))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 2,
    signal: new AbortController().signal,
  }), false)
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError
      && error.aggregate === 'infrastructure-blocked',
  )
})

test('a provider verdict cannot omit requirements or claim inconsistent success', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  value.setVerdict(verdict([
    ['unit', 'satisfied', 1],
  ], 'satisfied', 1))
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 2,
    signal: new AbortController().signal,
  }), false)
  assert.equal(value.service.verdict(value.owner).aggregate, 'infrastructure-blocked')

  const inconsistent = fixture()
  inconsistent.service.register(registration(inconsistent))
  await inconsistent.coordinator.sessionStarted({ agent: inconsistent.owner, source: 'startup' })
  inconsistent.setVerdict({
    ...verdict([
      ['package', 'missing', undefined],
      ['unit', 'satisfied', 1],
    ], 'satisfied', 1),
    reasonCodes: [],
  })
  assert.equal(await inconsistent.coordinator.turnStopping({
    agent: inconsistent.owner,
    turn: 2,
    signal: new AbortController().signal,
  }), false)
  assert.equal(
    inconsistent.service.verdict(inconsistent.owner).aggregate,
    'infrastructure-blocked',
  )

  const mismatchedObservation = fixture()
  const observe = mismatchedObservation.client.observeAcceptance
  mismatchedObservation.client.observeAcceptance = async request => ({
    ...await observe(request),
    observation: 'succeeded',
  })
  mismatchedObservation.service.register(registration(mismatchedObservation))
  await mismatchedObservation.coordinator.sessionStarted({
    agent: mismatchedObservation.owner,
    source: 'startup',
  })
  const failed = execution(
    mismatchedObservation.owner,
    mismatchedObservation.unit,
    'mismatched-observation',
  )
  await mismatchedObservation.coordinator.admit(failed, call(failed))
  mismatchedObservation.coordinator.result(failed, { isError: true, content: [], value: null })
  await mismatchedObservation.coordinator.settle(mismatchedObservation.owner)
  assert.equal(
    mismatchedObservation.service.verdict(mismatchedObservation.owner).aggregate,
    'infrastructure-blocked',
  )
})

test('ambiguous provider failures retry exact operations and terminal failure blocks stop', async () => {
  const value = fixture()
  const register = value.client.registerAcceptance
  const admit = value.client.admitAcceptance
  const observe = value.client.observeAcceptance
  let registerFailures = 1
  let admitFailures = 1
  let observeFailures = 1
  value.client.registerAcceptance = async request => {
    if (registerFailures-- > 0) throw new Error('ambiguous register transport failure')
    return register(request)
  }
  value.client.admitAcceptance = async request => {
    if (admitFailures-- > 0) {
      value.calls.admit.push(request)
      throw new Error('ambiguous admit transport failure')
    }
    return admit(request)
  }
  value.client.observeAcceptance = async request => {
    if (observeFailures-- > 0) {
      value.calls.observe.push(request)
      throw new Error('ambiguous observe transport failure')
    }
    return observe(request)
  }
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  assert.equal(value.calls.register.length, 1, 'fixture records only the successful register attempt')

  const exec = execution(value.owner, value.unit, 'retry-unit')
  assert.equal((await value.coordinator.admit(exec, call(exec))).kind, 'validator')
  assert.equal(value.calls.admit.length, 2)
  assert.equal(value.calls.admit[0].operationId, value.calls.admit[1].operationId)
  assert.deepEqual(value.calls.admit[0].operation, value.calls.admit[1].operation)
  value.coordinator.result(exec, { isError: false, content: [], value: 2 })
  await value.coordinator.settle(value.owner)
  assert.equal(value.calls.observe.length, 2)
  assert.equal(value.calls.observe[0].operationId, value.calls.observe[1].operationId)
  assert.deepEqual(value.calls.observe[0].observation, value.calls.observe[1].observation)

  const unavailable = fixture()
  unavailable.client.registerAcceptance = async () => {
    throw new Error('provider remains unavailable')
  }
  unavailable.service.register(registration(unavailable))
  assert.equal(await unavailable.coordinator.turnStopping({
    agent: unavailable.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), false)
  assert.equal(unavailable.owner.steers.length, 1)
  assert.throws(
    () => unavailable.service.assertGoalCompletion(unavailable.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError
      && error.aggregate === 'infrastructure-blocked',
  )
})

test('definition drift after admission cannot satisfy a host-observed validator', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const exec = execution(value.owner, value.unit, 'drifted-runtime-plus-one')
  await value.coordinator.admit(exec, call(exec))
  value.unit.parameters.additionalProperties = true
  value.coordinator.result(exec, { isError: false, content: [], value: 2 })
  await value.coordinator.settle(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'host-observed',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.service.verdict(value.owner).aggregate, 'infrastructure-blocked')
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError
      && error.aggregate === 'infrastructure-blocked',
  )
})

test('contained Bash selects the exact reserved validator while ordinary Bash remains provider-owned', async () => {
  const value = fixture()
  value.setVerdict(verdict([
    ['alpha', 'missing', undefined],
    ['beta', 'missing', undefined],
  ]))
  value.service.register({
    requirements: [
      {
        name: 'alpha',
        validators: [{
          id: 'alpha-bash',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'test', command: 'npm test -- alpha' },
        }],
      },
      {
        name: 'beta',
        validators: [{
          id: 'beta-bash',
          definition: value.bash,
          execution: { kind: 'contained-bash', intent: 'test', command: 'npm test -- beta' },
        }],
      },
    ],
    invalidators: [value.mutation],
  })
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const ordinary = execution(value.owner, value.bash, 'ordinary-bash')
  assert.deepEqual(await value.coordinator.admit(ordinary, call(ordinary)), { kind: 'none' })

  const selected = execution(value.owner, value.bash, 'beta-bash')
  value.sources.set(selected, {
    operationId: 'finish-line-source:beta',
    intent: 'test',
    command: 'npm test -- beta',
  })
  const admission = await value.coordinator.admit(selected, call(selected))
  assert.deepEqual(admission, {
    kind: 'validator',
    replacesLegacyEdit: false,
    sourceOperationId: 'finish-line-source:beta',
  })
  assert.equal(value.calls.admit.at(-1).operation.requirement, 'beta')
  assert.equal(value.calls.admit.at(-1).operation.validatorId, 'beta-bash')
  assert.equal(value.calls.admit.at(-1).operation.sourceOperationId, 'finish-line-source:beta')
})

test('contained Bash natural results preserve provider-owned execution facts', async () => {
  const value = fixture()
  value.service.register(containedRegistration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const exec = containedExecution(value, 'contained-success')
  await value.coordinator.admit(exec, call(exec))
  value.coordinator.result(exec, { isError: false, content: [], value: null })
  await value.coordinator.settle(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-success',
  })
})

test('contained Bash rejection terminalizes through its exact source as infrastructure-blocked', async () => {
  const value = fixture()
  value.service.register(containedRegistration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const exec = containedExecution(value, 'contained-rejected')
  await value.coordinator.admit(exec, call(exec))
  value.coordinator.reject(exec, 'cancelled')
  await value.coordinator.settle(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-rejected',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.coordinator.activeOperations, 0)
})

test('contained Bash definition drift terminalizes without manufacturing a host result', async () => {
  const value = fixture()
  value.service.register(containedRegistration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const exec = containedExecution(value, 'contained-drift')
  await value.coordinator.admit(exec, call(exec))
  value.bash.parameters.additionalProperties = true
  value.coordinator.result(exec, { isError: false, content: [], value: null })
  await value.coordinator.settle(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-drift',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.service.verdict(value.owner).aggregate, 'infrastructure-blocked')
})

test('contained Bash agent and coordinator disposal terminalize exact sources', async () => {
  const agentDisposed = fixture()
  agentDisposed.service.register(containedRegistration(agentDisposed))
  await agentDisposed.coordinator.sessionStarted({
    agent: agentDisposed.owner,
    source: 'startup',
  })
  const agentExec = containedExecution(agentDisposed, 'contained-agent-disposed')
  await agentDisposed.coordinator.admit(agentExec, call(agentExec))
  await agentDisposed.coordinator.agentDisposed(agentDisposed.owner)
  assert.deepEqual(agentDisposed.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-agent-disposed',
    status: 'infrastructure-blocked',
  })
  assert.equal(agentDisposed.coordinator.activeOperations, 0)

  const coordinatorDisposed = fixture()
  coordinatorDisposed.service.register(containedRegistration(coordinatorDisposed))
  await coordinatorDisposed.coordinator.sessionStarted({
    agent: coordinatorDisposed.owner,
    source: 'startup',
  })
  const coordinatorExec = containedExecution(coordinatorDisposed, 'contained-coordinator-disposed')
  await coordinatorDisposed.coordinator.admit(coordinatorExec, call(coordinatorExec))
  await coordinatorDisposed.coordinator.dispose()
  assert.deepEqual(coordinatorDisposed.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-coordinator-disposed',
    status: 'infrastructure-blocked',
  })
  assert.equal(coordinatorDisposed.coordinator.activeOperations, 0)
})

test('contained Bash admission completing during disposal terminalizes its reserved source', async () => {
  const value = fixture()
  value.service.register(containedRegistration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  const started = deferred()
  const release = deferred()
  const providerAdmit = value.client.admitAcceptance
  value.client.admitAcceptance = async request => {
    started.resolve()
    await release.promise
    return providerAdmit(request)
  }
  const exec = containedExecution(value, 'contained-dispose-during-admission')
  const admission = value.coordinator.admit(exec, call(exec))
  await started.promise
  const disposal = value.coordinator.dispose()
  release.resolve()
  const [admissionResult, disposalResult] = await Promise.allSettled([admission, disposal])
  assert.equal(admissionResult.status, 'rejected')
  assert.equal(disposalResult.status, 'fulfilled')
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'contained-bash',
    operationId: 'finish-line-source:contained-dispose-during-admission',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.coordinator.activeOperations, 0)
})

test('cancellation and agent disposal terminalize admitted work and reject session reuse', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const cancelled = execution(value.owner, value.mutation, 'cancelled-mutation')
  await value.coordinator.admit(cancelled, call(cancelled))
  value.coordinator.reject(cancelled)
  await value.coordinator.settle(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'host-observed',
    status: 'cancelled',
  })
  assert.equal(value.coordinator.activeOperations, 0)

  const interrupted = execution(value.owner, value.unit, 'disposed-validator')
  await value.coordinator.admit(interrupted, call(interrupted))
  await value.coordinator.agentDisposed(value.owner)
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'host-observed',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.coordinator.activeOperations, 0)
  await assert.rejects(
    value.coordinator.admit(execution(value.owner, value.unit, 'late-validator'), {
      ...call(interrupted),
      callId: 'late-validator',
      rootCallId: 'late-validator',
    }),
    /acceptance session disposed/u,
  )
})

test('a replacement agent may resume a disposed session from the durable fail-closed verdict', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const interrupted = execution(value.owner, value.unit, 'disposed-before-resume')
  await value.coordinator.admit(interrupted, call(interrupted))
  await value.coordinator.agentDisposed(value.owner)

  const replacement = agent(value.owner.id)
  replacement.session = value.owner.session
  value.addAgent(replacement)
  await value.coordinator.sessionStarted({ agent: replacement, source: 'resume' })

  assert.equal(value.service.verdict(replacement).aggregate, 'infrastructure-blocked')
  assert.throws(
    () => value.service.verdict(value.owner),
    /acceptance agent identity invalid/u,
  )
})

test('the immutable contract survives its registration disposer until coordinator disposal', async () => {
  const value = fixture()
  const unregister = value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })
  await value.coordinator.agentDisposed(value.owner)

  unregister()

  assert.throws(
    () => value.service.register(registration(value)),
    /acceptance contract already registered or disposed/u,
  )
})

test('session start waits for the exact resume agent to become publicly live', async () => {
  const value = fixture()
  value.service.register(registration(value))
  value.removeAgent(value.owner)

  const started = value.coordinator.sessionStarted({ agent: value.owner, source: 'resume' })
  queueMicrotask(() => value.addAgent(value.owner))
  await started

  assert.equal(value.service.verdict(value.owner).aggregate, 'missing')
})

test('caller abort and coordinator quiesce fail closed without orphaned operations', async () => {
  const value = fixture()
  value.service.register(registration(value))
  await value.coordinator.sessionStarted({ agent: value.owner, source: 'startup' })

  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))
  const aborted = {
    ...execution(value.owner, value.unit, 'aborted-validator'),
    signal: controller.signal,
  }
  const admissionCount = value.calls.admit.length
  await assert.rejects(value.coordinator.admit(aborted, call(aborted)), /caller stopped/u)
  assert.equal(value.calls.admit.length, admissionCount)
  assert.equal(value.coordinator.activeOperations, 0)

  const interrupted = execution(value.owner, value.unit, 'quiesced-validator')
  await value.coordinator.admit(interrupted, call(interrupted))
  await value.coordinator.dispose()
  assert.deepEqual(value.calls.observe.at(-1).observation, {
    kind: 'host-observed',
    status: 'infrastructure-blocked',
  })
  assert.equal(value.coordinator.activeOperations, 0)
  assert.equal(
    (await value.coordinator.admit(
      execution(value.owner, value.unit, 'post-quiesce'),
      { ...call(interrupted), callId: 'post-quiesce', rootCallId: 'post-quiesce' },
    )).kind,
    'none',
  )
  assert.throws(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
    error => error instanceof DshAcceptanceBlockedError
      && error.aggregate === 'infrastructure-blocked',
  )
})
