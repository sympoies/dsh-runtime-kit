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

function fixture() {
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
  const calls = { register: [], admit: [], observe: [], verdict: [] }
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
        requirementCount: 2,
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
      return currentVerdict
    },
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
    sourceOperation(exec) { return sources.get(exec) },
  }
  let operationSequence = 0
  const coordinator = createAuthoritativeAcceptanceCoordinator(ctx, {
    client,
    authority,
    createOperationId(kind, binding) {
      operationSequence += 1
      return `acceptance:${binding.id ?? kind}:${operationSequence}`
    },
  })
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

const call = exec => ({
  sessionId: exec.agent.id,
  cwd: exec.agent.session.header.cwd,
  turn: 1,
  step: 1,
  callId: exec.callId,
  rootCallId: exec.rootCallId,
  name: exec.name,
})

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

  assert.doesNotThrow(
    () => value.service.assertGoalCompletion(value.owner, { id: 'goal', revision: 1 }),
  )
  assert.equal(await value.coordinator.turnStopping({
    agent: value.owner,
    turn: 1,
    signal: new AbortController().signal,
  }), true)
  assert.deepEqual(value.calls.register[0].requirements.map(entry => entry.name), ['package', 'unit'])
  assert.deepEqual(
    value.calls.register[0].requirements.map(entry => entry.validators[0].toolName),
    ['package_check', 'runtime_kit_plus_one'],
    'registration and admission must bind the same exact DSH tool names',
  )
  assert.equal(value.owner.appended.length, 0, 'authority must not write custom rollback-hostile events')
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
