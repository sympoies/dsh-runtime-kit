import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LIFECYCLE_TRANSITIONS,
  RECONCILIATION_MATRIX,
  RuntimeManagerError,
  computeSemanticRequestDigest,
  createMemoryRuntimeStore,
  createWorkloadManager,
} from '../src/manager/index.js'
import {
  acceptingTrustVerifier,
  admissionSeal,
  baseLockRequest,
  composition,
  compositionLock,
  identity,
  runtimeAssertion,
  signingFixture,
  trustBundle,
} from './helpers/manager-fixtures.mjs'

function setup(effects = {}) {
  const resolved = composition()
  const lock = compositionLock(resolved)
  const instanceIdentity = identity()
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lock, instanceIdentity, signing, bundle)
  const request = baseLockRequest(resolved, lock, instanceIdentity, seal)
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'lock', request.requestDigest)
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  const store = createMemoryRuntimeStore()
  const trustVerifier = acceptingTrustVerifier()
  const manager = createWorkloadManager({
    store,
    trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects,
  })
  return { manager, store, trustVerifier, request, resolved, lock, seal, signing, bundle, identity: instanceIdentity }
}

function mutation(kind, operation, state, input, extra = {}) {
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind,
    requestId: `request-${operation}`,
    idempotencyKey: `${operation}-key-1`,
    requestDigest: `sha256:${'0'.repeat(64)}`,
    identity: structuredClone(input.identity),
    expectedState: state,
    ...extra,
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  if (['start', 'resume'].includes(operation)) {
    request.admissionSealDigest = input.seal.metadata.digest
    request.runtimeAssertion = runtimeAssertion(
      input.seal,
      input.identity,
      input.signing,
      input.bundle,
      operation,
      computeSemanticRequestDigest(request),
    )
    request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
    request.requestDigest = computeSemanticRequestDigest(request)
  }
  return request
}

function indeterminateFixture(operation, source, candidate) {
  const input = setup()
  return input.manager.lock(input.request).then(locked => {
    const details = {
      lock: ['LockInstanceRequest', {}],
      start: ['StartInstanceRequest', { priorReceiptDigest: locked.receipt.digest }],
      resume: ['ResumeInstanceRequest', { priorReceiptDigest: locked.receipt.digest }],
      interrupt: ['InterruptInstanceRequest', { runIdentity: 'session-1' }],
      drain: ['DrainInstanceRequest', { triggerFenceDigest: inputDigest(70), publisherEpoch: '1', deadlinePolicyDigest: inputDigest(71) }],
      stop: ['StopInstanceRequest', { receiptChainHead: locked.receipt.digest }],
    }
    const [kind, extra] = details[operation]
    const original = operation === 'lock'
      ? structuredClone(input.request)
      : mutation(kind, operation, source, input, extra)
    const key = `${original.kind}\0${input.identity.namespace}\0${original.idempotencyKey}`
    input.store.journals.set(key, {
      operation, sourceState: source, requestDigest: original.requestDigest,
      revision: '3', status: 'indeterminate', result: null,
      indeterminate: { kind: `${operation} indeterminate fixture` }, request: structuredClone(original),
      sealAcceptanceDigest: operation === 'lock' ? inputDigest(72) : null,
      assertionAcceptanceDigest: ['lock', 'start', 'resume'].includes(operation) ? inputDigest(73) : null,
    })
    if (candidate === 'Absent') {
      input.store.instances.delete(input.identity.namespace)
      input.store.namespaces.delete(input.identity.namespace)
      input.store.receipts.clear()
    } else {
      const instance = input.store.instances.get(input.identity.namespace)
      instance.state = candidate
      if (['resume', 'interrupt', 'drain', 'stop'].includes(operation)) {
        instance.sessionIdentity = 'session-1'
      }
    }
    return { ...input, original, source, candidate, key }
  })
}

function reconcileRequest(fixture, suffix, firstDigest = 80) {
  return {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest',
    requestId: `reconcile-${fixture.original.kind}-${fixture.candidate}-${suffix}`,
    originalOperation: fixture.original.kind.replace('InstanceRequest', '').toLowerCase(),
    originalIdempotencyKey: fixture.original.idempotencyKey,
    originalRequestDigest: fixture.original.requestDigest,
    identity: structuredClone(fixture.identity),
    journalEvidenceDigest: inputDigest(firstDigest), dshEvidenceDigest: inputDigest(firstDigest + 1),
    expectedSourceStates: [fixture.source],
    expectedTerminalState: RECONCILIATION_MATRIX[fixture.original.kind.replace('InstanceRequest', '').toLowerCase()].terminal,
  }
}

test('the frozen lifecycle and reconciliation matrices expose no stop shortcut', () => {
  assert.deepEqual(LIFECYCLE_TRANSITIONS.stop.sources, ['Drained'])
  assert.equal(LIFECYCLE_TRANSITIONS.stop.transient, 'Stopping')
  assert.equal(LIFECYCLE_TRANSITIONS.stop.terminal, 'Stopped')
  assert.deepEqual(RECONCILIATION_MATRIX.resume.sources, ['Interrupted', 'Stopped'])
  assert.deepEqual(RECONCILIATION_MATRIX.drain.sources, ['Running', 'Interrupted'])
})

test('lock/start/interrupt/drain/stop is hash-linked and stop-before-drain fails', async () => {
  const input = setup({
    start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1', effectSummaryDigest: inputDigest(4) }),
    interrupt: async () => ({ status: 'succeeded', retainedStateDigest: inputDigest(5), effectSummaryDigest: inputDigest(6) }),
    drain: async () => ({ status: 'succeeded', effectSummaryDigest: inputDigest(7) }),
    stop: async () => ({ status: 'succeeded', retainedStateDisposition: 'retained', effectSummaryDigest: inputDigest(8) }),
  })
  const locked = await input.manager.lock(input.request)
  assert.equal(locked.observedState, 'Locked')

  const start = mutation('StartInstanceRequest', 'start', 'Locked', input, {
    priorReceiptDigest: locked.receipt.digest,
  })
  const running = await input.manager.start(start)
  assert.equal(running.observedState, 'Running')

  const earlyStop = mutation('StopInstanceRequest', 'stop', 'Drained', input, {
    receiptChainHead: running.receipt.digest,
  })
  const denied = await input.manager.stop(earlyStop)
  assert.equal(denied.code, 'state-conflict')

  const interrupt = mutation('InterruptInstanceRequest', 'interrupt', 'Running', input, {
    runIdentity: 'session-1',
  })
  const interrupted = await input.manager.interrupt(interrupt)
  const drain = mutation('DrainInstanceRequest', 'drain', 'Interrupted', input, {
    triggerFenceDigest: inputDigest(9),
    publisherEpoch: '1',
    deadlinePolicyDigest: inputDigest(10),
  })
  const drained = await input.manager.drain(drain)
  const stop = mutation('StopInstanceRequest', 'stop', 'Drained', input, {
    receiptChainHead: drained.receipt.digest,
  })
  const stopped = await input.manager.stop(stop)
  assert.equal(stopped.observedState, 'Stopped')
  assert.equal(stopped.receipt.priorReceiptDigest, drained.receipt.digest)
  assert.equal(interrupted.receipt.priorReceiptDigest, running.receipt.digest)
})

test('same-key same-digest replays exactly and changed semantic bytes conflict', async () => {
  let effects = 0
  const input = setup({ start: async () => {
    effects += 1
    return { status: 'succeeded', sessionIdentity: 'session-1', effectSummaryDigest: inputDigest(11) }
  } })
  const locked = await input.manager.lock(input.request)
  const request = mutation('StartInstanceRequest', 'start', 'Locked', input, { priorReceiptDigest: locked.receipt.digest })
  const acceptedAssertionDigests = new Set()
  const accept = input.trustVerifier.acceptSignedDocument.bind(input.trustVerifier)
  input.trustVerifier.acceptSignedDocument = async acceptance => {
    if (acceptance.acceptanceKind === 'assertion') {
      const assertionDigest = acceptance.signedDocument.metadata.digest
      if (acceptedAssertionDigests.has(assertionDigest)) {
        throw new RuntimeManagerError('replayed-nonce', 'runtime assertion was already accepted', {
          digest: inputDigest(63), authorityFailureKind: 'DshTrustAcceptanceFailed',
        })
      }
      acceptedAssertionDigests.add(assertionDigest)
    }
    return accept(acceptance)
  }
  const first = await input.manager.start(request)
  const acceptanceCalls = input.trustVerifier.calls.length
  const staleReplay = await input.manager.start({ ...request, requestId: 'request-start-stale-replay' })
  assert.equal(staleReplay.code, 'trust-acceptance-replay')
  const replayRequest = structuredClone(request)
  replayRequest.requestId = 'request-start-replay'
  replayRequest.runtimeAssertion = runtimeAssertion(
    input.seal, input.identity, input.signing, input.bundle, 'start', request.requestDigest,
    { nonce: 'AQEBAQEBAQEBAQEBAQEBAQ', revocationId: 'assertion-replay-2' },
  )
  replayRequest.runtimeAssertionDigest = replayRequest.runtimeAssertion.metadata.digest
  const replay = await input.manager.start(replayRequest)
  assert.deepEqual(replay, first)
  assert.equal(effects, 1)
  assert.equal(input.trustVerifier.calls.length, acceptanceCalls + 1)

  const changed = structuredClone(request)
  changed.requestId = 'request-start-conflict'
  changed.priorReceiptDigest = inputDigest(12)
  changed.requestDigest = computeSemanticRequestDigest(changed)
  const conflict = await input.manager.start(changed)
  assert.equal(conflict.code, 'idempotency-conflict')
  assert.equal(effects, 1)
})

test('start with missing post-effect session evidence is indeterminate and resume requires retained identity', async () => {
  let startEffects = 0
  const startInput = setup({ start: async () => {
    startEffects += 1
    return { status: 'succeeded' }
  } })
  const locked = await startInput.manager.lock(startInput.request)
  const start = mutation('StartInstanceRequest', 'start', 'Locked', startInput, {
    priorReceiptDigest: locked.receipt.digest,
  })
  const missingStartIdentity = await startInput.manager.start(start)
  assert.equal(missingStartIdentity.kind, 'StartInstanceIndeterminate')
  assert.equal(missingStartIdentity.code, 'effect-unknown')
  assert.equal(startInput.store.instances.get(startInput.identity.namespace).state, 'Starting')
  assert.equal(startInput.store.instances.get(startInput.identity.namespace).sessionIdentity, null)
  assert.deepEqual(
    await startInput.manager.start({ ...start, requestId: 'missing-session-replay' }),
    missingStartIdentity,
  )
  assert.equal(startEffects, 1)

  let resumeEffects = 0
  const resumeInput = setup({ resume: async () => {
    resumeEffects += 1
    return { status: 'succeeded' }
  } })
  const resumeLock = await resumeInput.manager.lock(resumeInput.request)
  resumeInput.store.instances.get(resumeInput.identity.namespace).state = 'Interrupted'
  const resume = mutation('ResumeInstanceRequest', 'resume', 'Interrupted', resumeInput, {
    priorReceiptDigest: resumeLock.receipt.digest,
  })
  const missingRetainedIdentity = await resumeInput.manager.resume(resume)
  assert.equal(missingRetainedIdentity.kind, 'ResumeInstanceFailed')
  assert.equal(missingRetainedIdentity.code, 'retained-state-missing')
  assert.equal(resumeEffects, 0)
})

test('resume preserves one retained session identity from Interrupted and Stopped', async () => {
  for (const source of ['Interrupted', 'Stopped']) {
    let resumeEffects = 0
    const input = setup({
      start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1' }),
      interrupt: async () => ({ status: 'succeeded', retainedStateDigest: inputDigest(20) }),
      drain: async () => ({ status: 'succeeded', effectSummaryDigest: inputDigest(21) }),
      stop: async () => ({ status: 'succeeded', retainedStateDisposition: 'retained' }),
      resume: async () => { resumeEffects += 1; return { status: 'succeeded', sessionIdentity: 'session-1' } },
    })
    const locked = await input.manager.lock(input.request)
    const started = await input.manager.start(mutation('StartInstanceRequest', 'start', 'Locked', input, {
      priorReceiptDigest: locked.receipt.digest,
    }))
    let prior = started.receipt.digest
    if (source === 'Interrupted') {
      const interrupted = await input.manager.interrupt(mutation('InterruptInstanceRequest', 'interrupt', 'Running', input, {
        runIdentity: 'session-1',
      }))
      prior = interrupted.receipt.digest
    } else {
      const drained = await input.manager.drain(mutation('DrainInstanceRequest', 'drain', 'Running', input, {
        triggerFenceDigest: inputDigest(22), publisherEpoch: '1', deadlinePolicyDigest: inputDigest(23),
      }))
      const stopped = await input.manager.stop(mutation('StopInstanceRequest', 'stop', 'Drained', input, {
        receiptChainHead: drained.receipt.digest,
      }))
      prior = stopped.receipt.digest
    }
    const resumed = await input.manager.resume(mutation('ResumeInstanceRequest', 'resume', source, input, {
      priorReceiptDigest: prior,
    }))
    assert.equal(resumed.kind, 'ResumeInstanceSucceeded')
    assert.equal(resumed.sessionIdentity, 'session-1')
    assert.equal(resumed.receipt.sessionIdentity, 'session-1')
    assert.equal(input.store.instances.get(input.identity.namespace).sessionIdentity, 'session-1')
    assert.equal(resumeEffects, 1)
  }
})

test('resume with substituted post-effect session evidence is indeterminate without a success receipt', async () => {
  let resumeEffects = 0
  const input = setup({
    start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1' }),
    interrupt: async () => ({ status: 'succeeded', retainedStateDigest: inputDigest(24) }),
    resume: async () => { resumeEffects += 1; return { status: 'succeeded', sessionIdentity: 'session-2' } },
  })
  const locked = await input.manager.lock(input.request)
  const started = await input.manager.start(mutation('StartInstanceRequest', 'start', 'Locked', input, {
    priorReceiptDigest: locked.receipt.digest,
  }))
  const interrupted = await input.manager.interrupt(mutation('InterruptInstanceRequest', 'interrupt', 'Running', input, {
    runIdentity: 'session-1',
  }))
  const receiptCount = input.store.receipts.size
  const result = await input.manager.resume(mutation('ResumeInstanceRequest', 'resume', 'Interrupted', input, {
    priorReceiptDigest: interrupted.receipt.digest,
  }))
  assert.equal(result.kind, 'ResumeInstanceIndeterminate')
  assert.equal(result.code, 'effect-unknown')
  assert.equal(input.store.instances.get(input.identity.namespace).state, 'Starting')
  assert.equal(input.store.instances.get(input.identity.namespace).sessionIdentity, 'session-1')
  assert.equal(input.store.instances.get(input.identity.namespace).receiptHead, interrupted.receipt.digest)
  assert.equal(input.store.receipts.size, receiptCount)
  assert.deepEqual(
    await input.manager.resume({
      ...mutation('ResumeInstanceRequest', 'resume', 'Interrupted', input, {
        priorReceiptDigest: interrupted.receipt.digest,
      }),
      requestId: 'substituted-session-replay',
    }),
    result,
  )
  assert.equal(resumeEffects, 1)
  assert.notEqual(started.receipt.digest, interrupted.receipt.digest)
})

test('health exceptions and malformed successful effect evidence converge to stable typed journal results', async () => {
  let rejectHealth = false
  let effectCalls = 0
  const fixture = setup()
  const healthManager = createWorkloadManager({
    store: fixture.store,
    trustVerifier: fixture.trustVerifier,
    health: async () => {
      if (rejectHealth) throw new Error('probe transport unavailable')
      return { state: 'ready', code: 'READY' }
    },
    effects: { start: async () => { effectCalls += 1; return { status: 'succeeded', sessionIdentity: 'session-1' } } },
  })
  const locked = await healthManager.lock(fixture.request)
  rejectHealth = true
  const healthRequest = mutation('StartInstanceRequest', 'start', 'Locked', fixture, {
    priorReceiptDigest: locked.receipt.digest,
  })
  const unavailable = await healthManager.start(healthRequest)
  assert.equal(unavailable.kind, 'StartInstanceFailed')
  assert.equal(unavailable.code, 'required-health-failed')
  assert.deepEqual(await healthManager.start({ ...healthRequest, requestId: 'health-replay' }), unavailable)
  assert.equal(fixture.store.instances.get(fixture.identity.namespace).state, 'Locked')
  assert.equal(effectCalls, 0)

  let malformedEffects = 0
  const malformed = setup({ start: async () => {
    malformedEffects += 1
    return { status: 'succeeded', sessionIdentity: 'session-1', effectSummaryDigest: 'not-a-digest' }
  } })
  const malformedLock = await malformed.manager.lock(malformed.request)
  const malformedRequest = mutation('StartInstanceRequest', 'start', 'Locked', malformed, {
    priorReceiptDigest: malformedLock.receipt.digest,
  })
  const unknown = await malformed.manager.start(malformedRequest)
  assert.equal(unknown.kind, 'StartInstanceIndeterminate')
  assert.equal(unknown.lastObservedState, 'Starting')
  assert.deepEqual(await malformed.manager.start({ ...malformedRequest, requestId: 'malformed-replay' }), unknown)
  assert.equal(malformed.store.instances.get(malformed.identity.namespace).state, 'Starting')
  assert.equal(malformed.store.receipts.size, 1)
  assert.equal(malformedEffects, 1)
})

test('successful start refreshes optional health and terminal replay retains bounded acceptance evidence', async () => {
  const base = setup()
  let degraded = false
  const manager = createWorkloadManager({
    store: base.store,
    trustVerifier: base.trustVerifier,
    health: async probe => probe.endsWith('.metrics') && degraded
      ? { state: 'degraded', code: 'LATE' }
      : { state: 'ready', code: 'READY' },
    effects: { start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1' }) },
  })
  const locked = await manager.lock(base.request)
  degraded = true
  const request = mutation('StartInstanceRequest', 'start', 'Locked', base, {
    priorReceiptDigest: locked.receipt.digest,
  })
  const started = await manager.start(request)
  for (let index = 0; index < 32; index += 1) {
    const replay = structuredClone(request)
    replay.requestId = `bounded-replay-${index}`
    replay.runtimeAssertion = runtimeAssertion(
      base.seal, base.identity, base.signing, base.bundle, 'start', request.requestDigest,
      { nonce: Buffer.alloc(16, index + 1).toString('base64url'), revocationId: `bounded-replay-${index}` },
    )
    replay.runtimeAssertionDigest = replay.runtimeAssertion.metadata.digest
    assert.deepEqual(await manager.start(replay), started)
  }
  const journal = base.store.journals.get(`StartInstanceRequest\0${base.identity.namespace}\0${request.idempotencyKey}`)
  assert.equal(Object.hasOwn(journal, 'replayAssertionAcceptanceDigests'), false)
  assert.equal(typeof journal.replayAssertionAcceptanceDigest, 'string')
  const status = await manager.status({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
    requestId: 'refreshed-optional-health', identity: base.identity,
    receiptChainHead: started.receipt.digest,
  })
  assert.deepEqual(status.health.optional, ['github-review.metrics'])
})

test('indeterminate effects require runtime-kit reconcile and stable conflict quarantines once', async () => {
  const input = setup({ start: async () => ({ status: 'indeterminate' }) })
  const locked = await input.manager.lock(input.request)
  const request = mutation('StartInstanceRequest', 'start', 'Locked', input, { priorReceiptDigest: locked.receipt.digest })
  const unknown = await input.manager.start(request)
  assert.equal(unknown.kind, 'StartInstanceIndeterminate')
  assert.equal(unknown.lastObservedState, 'Starting')

  const reconcile = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ReconcileInstanceRequest',
    requestId: 'reconcile-1',
    originalOperation: 'start',
    originalIdempotencyKey: request.idempotencyKey,
    originalRequestDigest: request.requestDigest,
    identity: structuredClone(input.identity),
    journalEvidenceDigest: inputDigest(13),
    dshEvidenceDigest: inputDigest(14),
    expectedSourceStates: ['Locked'],
    expectedTerminalState: 'Running',
  }
  const quarantined = await input.manager.reconcile(reconcile, {
    authorized: true,
    evidence: { status: 'conflict' },
  })
  assert.equal(quarantined.kind, 'ReconcileInstanceQuarantined')
  assert.equal(quarantined.receipt.observedState, 'Quarantined')
  const replay = await input.manager.reconcile(reconcile, {
    authorized: true,
    evidence: { status: 'conflict' },
  })
  assert.deepEqual(replay, quarantined)
})

test('unauthorized reconciliation and changed evidence cannot mutate instance truth', async () => {
  const input = setup({ start: async () => ({ status: 'indeterminate' }) })
  const locked = await input.manager.lock(input.request)
  const request = mutation('StartInstanceRequest', 'start', 'Locked', input, { priorReceiptDigest: locked.receipt.digest })
  await input.manager.start(request)
  const reconcile = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ReconcileInstanceRequest',
    requestId: 'reconcile-2',
    originalOperation: 'start',
    originalIdempotencyKey: request.idempotencyKey,
    originalRequestDigest: request.requestDigest,
    identity: structuredClone(input.identity),
    journalEvidenceDigest: inputDigest(15),
    dshEvidenceDigest: inputDigest(16),
    expectedSourceStates: ['Locked'],
    expectedTerminalState: 'Running',
  }
  const denied = await input.manager.reconcile(reconcile, { authorized: false, evidence: { status: 'committed' } })
  assert.equal(denied.code, 'unauthorized-state-mutation')
  assert.equal(input.store.instances.get(input.identity.namespace).state, 'Starting')
})

test('every disallowed lifecycle source is rejected before an effect', async () => {
  const states = ['Locked', 'Starting', 'Running', 'Interrupting', 'Interrupted', 'Draining', 'Drained', 'Stopping', 'Stopped', 'Quarantined']
  const cases = {
    start: { kind: 'StartInstanceRequest', allowed: ['Locked'] },
    resume: { kind: 'ResumeInstanceRequest', allowed: ['Interrupted', 'Stopped'] },
    interrupt: { kind: 'InterruptInstanceRequest', allowed: ['Running'] },
    drain: { kind: 'DrainInstanceRequest', allowed: ['Running', 'Interrupted'] },
    stop: { kind: 'StopInstanceRequest', allowed: ['Drained'] },
  }
  for (const [operation, spec] of Object.entries(cases)) {
    for (const state of states.filter(candidate => !spec.allowed.includes(candidate))) {
      let effects = 0
      const input = setup({ [operation]: async () => { effects += 1; return { status: 'succeeded' } } })
      const locked = await input.manager.lock(input.request)
      input.store.instances.get(input.identity.namespace).state = state
      const expected = operation === 'start' ? 'Locked'
        : operation === 'resume' ? 'Interrupted'
          : operation === 'interrupt' ? 'Running'
            : operation === 'drain' ? 'Running' : 'Drained'
      const extra = operation === 'start' || operation === 'resume'
        ? { priorReceiptDigest: locked.receipt.digest }
        : operation === 'interrupt'
          ? { runIdentity: 'session-1' }
          : operation === 'drain'
            ? { triggerFenceDigest: inputDigest(30), publisherEpoch: '1', deadlinePolicyDigest: inputDigest(31) }
            : { receiptChainHead: locked.receipt.digest }
      const request = mutation(spec.kind, operation, expected, input, extra)
      const result = await input.manager[operation](request)
      assert.equal(result.code, 'state-conflict', `${operation} from ${state}`)
      assert.equal(effects, 0, `${operation} from ${state} executed an effect`)
      assert.equal(input.store.instances.get(input.identity.namespace).state, state)
    }
  }
})

test('allowed lifecycle faults restore the exact source or retain the required transient', async () => {
  const cases = [
    ['start', 'StartInstanceRequest', 'Locked', 'Starting'],
    ['resume', 'ResumeInstanceRequest', 'Interrupted', 'Starting'],
    ['resume', 'ResumeInstanceRequest', 'Stopped', 'Starting'],
    ['interrupt', 'InterruptInstanceRequest', 'Running', 'Interrupting'],
    ['drain', 'DrainInstanceRequest', 'Running', 'Draining'],
    ['drain', 'DrainInstanceRequest', 'Interrupted', 'Draining'],
    ['stop', 'StopInstanceRequest', 'Drained', 'Stopping'],
  ]
  for (const [operation, kind, source, transient] of cases) {
    const extraFor = receiptHead => operation === 'start' || operation === 'resume'
      ? { priorReceiptDigest: receiptHead }
      : operation === 'interrupt'
        ? { runIdentity: 'session-1' }
        : operation === 'drain'
          ? { triggerFenceDigest: inputDigest(40), publisherEpoch: '1', deadlinePolicyDigest: inputDigest(41) }
          : { receiptChainHead: receiptHead }

    const failureCode = operation === 'drain' ? 'inflight-timeout' : 'runtime-unavailable'
    const failedInput = setup({ [operation]: async () => ({ status: 'failed', code: failureCode }) })
    const failedLock = await failedInput.manager.lock(failedInput.request)
    failedInput.store.instances.get(failedInput.identity.namespace).state = source
    if (operation !== 'start') failedInput.store.instances.get(failedInput.identity.namespace).sessionIdentity = 'session-1'
    const failed = await failedInput.manager[operation](mutation(kind, operation, source, failedInput, extraFor(failedLock.receipt.digest)))
    assert.equal(failed.code, failureCode, `${operation} failed result`)
    assert.equal(failedInput.store.instances.get(failedInput.identity.namespace).state, source, `${operation} source restore`)

    const unknownInput = setup({ [operation]: async () => ({ status: 'indeterminate' }) })
    const unknownLock = await unknownInput.manager.lock(unknownInput.request)
    unknownInput.store.instances.get(unknownInput.identity.namespace).state = source
    if (operation !== 'start') unknownInput.store.instances.get(unknownInput.identity.namespace).sessionIdentity = 'session-1'
    const unknown = await unknownInput.manager[operation](mutation(kind, operation, source, unknownInput, extraFor(unknownLock.receipt.digest)))
    assert.equal(unknown.kind, `${operation[0].toUpperCase()}${operation.slice(1)}InstanceIndeterminate`)
    assert.equal(unknown.lastObservedState, transient)
    assert.equal(unknownInput.store.instances.get(unknownInput.identity.namespace).state, transient)
  }
})

test('concurrent lifecycle mutations serialize to one effect and receipt', async () => {
  let effects = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const input = setup({ start: async () => {
    effects += 1
    await gate
    return { status: 'succeeded', sessionIdentity: 'session-1', effectSummaryDigest: inputDigest(50) }
  } })
  const locked = await input.manager.lock(input.request)
  const request = mutation('StartInstanceRequest', 'start', 'Locked', input, { priorReceiptDigest: locked.receipt.digest })
  const first = input.manager.start(request)
  const second = input.manager.start({ ...request, requestId: 'concurrent-replay' })
  await Promise.resolve()
  release()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(right, left)
  assert.equal(effects, 1)
  assert.equal(input.store.receipts.size, 2)
})

test('receipt-chain corruption is diagnosed and blocks stop', async () => {
  const input = setup()
  const locked = await input.manager.lock(input.request)
  input.store.instances.get(input.identity.namespace).state = 'Drained'
  input.store.receipts.delete(locked.receipt.digest)
  const stopped = await input.manager.stop(mutation('StopInstanceRequest', 'stop', 'Drained', input, {
    receiptChainHead: locked.receipt.digest,
  }))
  assert.equal(stopped.code, 'receipt-chain-invalid')
  const doctor = await input.manager.doctor({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest',
    requestId: 'doctor-corrupt', identity: input.identity,
    expectedCompositionLockReceiptDigest: input.lock.digest,
    expectedAdmissionSealDigest: input.seal.metadata.digest,
    expectedReceiptChainHead: locked.receipt.digest,
  })
  assert.equal(doctor.receiptChainVerified, false)
  assert.equal(doctor.recoveryRecommendation, 'reconcile')
})

test('status and doctor reject a valid receipt prefix grafted onto newer instance truth', async () => {
  const input = setup({ start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1' }) })
  const locked = await input.manager.lock(input.request)
  const started = await input.manager.start(mutation('StartInstanceRequest', 'start', 'Locked', input, {
    priorReceiptDigest: locked.receipt.digest,
  }))
  const instance = input.store.instances.get(input.identity.namespace)
  instance.receiptHead = locked.receipt.digest
  const status = await input.manager.status({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
    requestId: 'prefix-graft-status', identity: input.identity, receiptChainHead: null,
  })
  assert.equal(status.kind, 'StatusInstanceFailed')
  assert.equal(status.code, 'receipt-chain-invalid')
  const doctor = await input.manager.doctor({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest',
    requestId: 'prefix-graft-doctor', identity: input.identity,
    expectedCompositionLockReceiptDigest: input.lock.digest,
    expectedAdmissionSealDigest: input.seal.metadata.digest,
    expectedReceiptChainHead: locked.receipt.digest,
  })
  assert.equal(doctor.kind, 'DoctorInstanceSucceeded')
  assert.equal(doctor.receiptChainVerified, false)
  assert.equal(doctor.recoveryRecommendation, 'reconcile')
  assert.notEqual(started.receipt.digest, locked.receipt.digest)
})

test('doctor and reconcile fail closed on stored identity substitution before disclosure or mutation', async () => {
  const doctorInput = setup()
  await doctorInput.manager.lock(doctorInput.request)
  const doctorInstance = doctorInput.store.instances.get(doctorInput.identity.namespace)
  doctorInstance.identity = identity({ instanceId: 'stored-substitute' })
  const doctor = await doctorInput.manager.doctor({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest',
    requestId: 'stored-identity-doctor', identity: doctorInput.identity,
    expectedCompositionLockReceiptDigest: doctorInput.lock.digest,
    expectedAdmissionSealDigest: doctorInput.seal.metadata.digest,
    expectedReceiptChainHead: doctorInstance.receiptHead,
  })
  assert.equal(doctor.kind, 'DoctorInstanceFailed')
  assert.equal(doctor.code, 'not-found')
  assert.equal(doctor.identity.namespace, doctorInput.identity.namespace)

  const reconcileInput = setup({ start: async () => ({ status: 'indeterminate' }) })
  const locked = await reconcileInput.manager.lock(reconcileInput.request)
  const start = mutation('StartInstanceRequest', 'start', 'Locked', reconcileInput, {
    priorReceiptDigest: locked.receipt.digest,
  })
  await reconcileInput.manager.start(start)
  const journalKey = `StartInstanceRequest\0${reconcileInput.identity.namespace}\0${start.idempotencyKey}`
  const journal = reconcileInput.store.journals.get(journalKey)
  journal.request.identity = identity({ instanceId: 'journal-substitute' })
  const stateBefore = reconcileInput.store.instances.get(reconcileInput.identity.namespace).state
  const receiptsBefore = reconcileInput.store.receipts.size
  const result = await reconcileInput.manager.reconcile({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest',
    requestId: 'stored-identity-reconcile', originalOperation: 'start',
    originalIdempotencyKey: start.idempotencyKey, originalRequestDigest: start.requestDigest,
    identity: reconcileInput.identity, journalEvidenceDigest: inputDigest(64),
    dshEvidenceDigest: inputDigest(65), expectedSourceStates: ['Locked'],
    expectedTerminalState: 'Running',
  }, { authorized: true, evidence: { status: 'committed', sessionIdentity: 'session-1' } })
  assert.equal(result.kind, 'ReconcileInstanceFailed')
  assert.equal(result.code, 'state-conflict')
  assert.equal(reconcileInput.store.instances.get(reconcileInput.identity.namespace).state, stateBefore)
  assert.equal(reconcileInput.store.receipts.size, receiptsBefore)
  assert.equal(reconcileInput.store.reconciliations.size, 0)
})

test('authenticated trust denial keeps its exact failure digest and executes no effect', async () => {
  const base = setup()
  let deny = false
  let effects = 0
  const trustVerifier = {
    async acceptSignedDocument(input) {
      if (deny) throw new RuntimeManagerError('unauthorized', 'denied', {
        digest: inputDigest(60), authorityFailureKind: 'DshTrustAcceptanceFailed',
      })
      return { digest: inputDigest(input.acceptanceKind === 'seal' ? 61 : 62) }
    },
  }
  const store = createMemoryRuntimeStore()
  const manager = createWorkloadManager({
    store, trustVerifier, health: async () => ({ state: 'ready', code: 'READY' }),
    effects: { start: async () => { effects += 1; return { status: 'succeeded' } } },
  })
  const locked = await manager.lock(base.request)
  assert.equal(locked.kind, 'LockInstanceSucceeded')
  deny = true
  const request = mutation('StartInstanceRequest', 'start', 'Locked', base, {
    priorReceiptDigest: locked.receipt.digest,
  })
  const result = await manager.start(request)
  assert.equal(result.code, 'trust-acceptance-unauthorized')
  assert.equal(result.trustAcceptanceFailureDigest, inputDigest(60))
  assert.equal(effects, 0)
  assert.equal(store.instances.get(base.identity.namespace).state, 'Locked')
})

test('reconcile covers every exact source, transient, and terminal candidate under all evidence classes', async () => {
  const rows = []
  for (const [operation, matrix] of Object.entries(RECONCILIATION_MATRIX)) {
    for (const source of matrix.sources) {
      for (const candidate of [...new Set([source, matrix.transient, matrix.terminal].filter(Boolean))]) {
        rows.push([operation, source, candidate, matrix.terminal])
      }
    }
  }
  for (const [operation, source, candidate, terminal] of rows) {
    const committedFixture = await indeterminateFixture(operation, source, candidate)
    const temporaryRequest = reconcileRequest(committedFixture, 'temporary', 80)
    const temporary = await committedFixture.manager.reconcile(temporaryRequest, {
      authorized: true, evidence: { status: 'temporary-unavailable' },
    })
    assert.equal(temporary.kind, 'ReconcileInstanceIndeterminate', `${operation}/${source}/${candidate} temporary`)
    assert.equal(committedFixture.store.instances.get(committedFixture.identity.namespace)?.state ?? 'Absent', candidate)
    const committedRequest = reconcileRequest(committedFixture, 'committed', 82)
    const committedEvidence = {
      status: 'committed',
      ...(operation === 'start' ? { sessionIdentity: 'session-1' } : {}),
    }
    const committed = await committedFixture.manager.reconcile(committedRequest, {
      authorized: true, evidence: committedEvidence,
    })
    assert.equal(committed.kind, 'ReconcileInstanceProvedTerminal', `${operation}/${source}/${candidate} committed`)
    assert.equal(committedFixture.store.instances.get(committedFixture.identity.namespace).state, terminal)
    assert.equal(committedFixture.store.receipts.has(committedFixture.store.instances.get(committedFixture.identity.namespace).receiptHead), true)
    assert.deepEqual(await committedFixture.manager.reconcile({ ...committedRequest, requestId: `${committedRequest.requestId}-replay` }, {
      authorized: true, evidence: committedEvidence,
    }), committed)

    const sourceFixture = await indeterminateFixture(operation, source, candidate)
    const sourceResult = await sourceFixture.manager.reconcile(reconcileRequest(sourceFixture, 'source', 84), {
      authorized: true, evidence: { status: 'not-committed' },
    })
    assert.equal(sourceResult.kind, 'ReconcileInstanceProvedSource', `${operation}/${source}/${candidate} source`)
    assert.equal(sourceFixture.store.instances.get(sourceFixture.identity.namespace)?.state ?? 'Absent', source)

    const conflictFixture = await indeterminateFixture(operation, source, candidate)
    const priorReceipt = conflictFixture.store.instances.get(conflictFixture.identity.namespace)?.receiptHead ?? null
    const quarantined = await conflictFixture.manager.reconcile(reconcileRequest(conflictFixture, 'conflict', 86), {
      authorized: true, evidence: { status: 'conflict' },
    })
    assert.equal(quarantined.kind, 'ReconcileInstanceQuarantined', `${operation}/${source}/${candidate} conflict`)
    assert.equal(quarantined.receipt.priorReceiptDigest, priorReceipt)
    assert.equal(conflictFixture.store.instances.get(conflictFixture.identity.namespace).state, 'Quarantined')
    assert.equal(conflictFixture.store.receipts.get(quarantined.receipt.digest).digest, quarantined.receipt.digest)
  }
})

test('restart recovery adopts one committed effect and replays without a second effect', async () => {
  let effects = 0
  const input = setup({ start: async () => { effects += 1; return { status: 'indeterminate' } } })
  const locked = await input.manager.lock(input.request)
  const original = mutation('StartInstanceRequest', 'start', 'Locked', input, {
    priorReceiptDigest: locked.receipt.digest,
  })
  assert.equal((await input.manager.start(original)).kind, 'StartInstanceIndeterminate')
  assert.equal(effects, 1)
  const recoveredManager = createWorkloadManager({
    store: input.store, trustVerifier: input.trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: { start: async () => { effects += 1; return { status: 'succeeded' } } },
  })
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest',
    requestId: 'restart-reconcile', originalOperation: 'start',
    originalIdempotencyKey: original.idempotencyKey,
    originalRequestDigest: original.requestDigest, identity: input.identity,
    journalEvidenceDigest: inputDigest(90), dshEvidenceDigest: inputDigest(91),
    expectedSourceStates: ['Locked'], expectedTerminalState: 'Running',
  }
  const recovered = await recoveredManager.reconcile(request, {
    authorized: true, evidence: { status: 'committed', sessionIdentity: 'session-1' },
  })
  assert.equal(recovered.kind, 'ReconcileInstanceProvedTerminal')
  assert.equal(effects, 1)

  const secondRestart = createWorkloadManager({
    store: input.store, trustVerifier: input.trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: { start: async () => { effects += 1; return { status: 'succeeded' } } },
  })
  assert.deepEqual(await secondRestart.reconcile({ ...request, requestId: 'restart-reconcile-replay' }, {
    authorized: true, evidence: { status: 'committed', sessionIdentity: 'session-1' },
  }), recovered)
  const replay = await secondRestart.start({ ...original, requestId: 'restart-original-replay' })
  assert.equal(replay.kind, 'StartInstanceSucceeded')
  assert.equal(effects, 1)
})

function inputDigest(value) {
  return `sha256:${value.toString(16).padStart(64, '0')}`
}
