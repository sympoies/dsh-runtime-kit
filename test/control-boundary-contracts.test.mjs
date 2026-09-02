import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RuntimeManagerError,
  MANAGER_REQUEST_KINDS,
  MANAGER_RESULT_KINDS,
  MANAGER_RESULT_KINDS_BY_REQUEST,
  MANAGER_CONTROL_MAX_DATAGRAM_BYTES,
  TRUST_FAILURE_CODE_MAP,
  TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED_CODES,
  computeManagerDocumentDigest,
  computeSemanticRequestDigest,
  computeTrustAuthorityObservationDigest,
  createManagerControlRequestFrame,
  createManagerControlResponseFrame,
  createManagerControlService,
  createMediatedHostService,
  createMemoryRuntimeStore,
  createTrustVerifier,
  createWorkloadManager,
  validateManagerControlRequestFrame,
  validateManagerControlResponseFrame,
  validateMediatedHostActionRequest,
  validateMediatedHostActionResult,
  validateTrustBundle,
  validateTrustBundleTransition,
  validateTrustLineageHead,
  verifyProtocolSignatureDigest,
  mapTrustAuthorityFailureCode,
} from '../src/manager/index.js'
import {
  ONE_DIGEST,
  THREE_DIGEST,
  TWO_DIGEST,
  ZERO_DIGEST,
  acceptingTrustVerifier,
  admissionSeal,
  baseLockRequest,
  composition,
  compositionLock,
  compositionProtocolRequests,
  identity,
  runtimeAssertion,
  signingFixture,
  trustBundle,
  trustTransition,
} from './helpers/manager-fixtures.mjs'

test('trust bundles and lineage heads are strict, digest-addressed, and verifier-pinned', () => {
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  assert.equal(validateTrustBundle(bundle), bundle)
  assert.throws(
    () => validateTrustBundle({ ...bundle, privateKey: 'forbidden' }),
    error => error instanceof RuntimeManagerError && error.code === 'unknown-field',
  )
  const head = {
    apiVersion: 'infra.serenvia.dev/v1',
    kind: 'DshTrustLineageHead',
    digest: ZERO_DIGEST,
    namespace: 'review-service',
    genesisBundleDigest: bundle.metadata.digest,
    sequence: '0',
    bundleDigest: bundle.metadata.digest,
    transitionDigest: null,
    casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  assert.equal(validateTrustLineageHead(head).digest, head.digest)
})

test('manager control frames bind nonce, payload kind, semantic payload, and request frame digest', () => {
  const payload = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'StatusInstanceRequest',
    requestId: 'status-1',
    identity: {
      deploymentId: 'review-service', profileId: 'mes-bot-review',
      generationId: 'generation-1', instanceId: 'instance-1',
      namespace: 'review-service/mes-bot-review/generation-1/instance-1',
    },
    receiptChainHead: null,
  }
  const request = createManagerControlRequestFrame({ connectionNonce: '1', payload })
  assert.equal(validateManagerControlRequestFrame(request).frameDigest, request.frameDigest)
  const response = createManagerControlResponseFrame({
    requestFrame: request,
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: 'StatusInstanceFailed',
      requestId: 'status-1',
      code: 'not-found', retryable: false, observedState: null,
      identity: payload.identity, receiptDigest: null, details: {},
    },
  })
  assert.equal(validateManagerControlResponseFrame(response, request).requestFrameDigest, request.frameDigest)
  assert.throws(
    () => validateManagerControlRequestFrame({ ...request, payloadKind: 'StopInstanceRequest' }),
    error => error instanceof RuntimeManagerError,
  )
})

test('control frames preserve typed status failures and reject same-kind cross-request substitution', () => {
  const firstIdentity = identity()
  const secondIdentity = identity({ instanceId: 'instance-2' })
  const request = createManagerControlRequestFrame({
    connectionNonce: '2',
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
      requestId: 'status-current-state', identity: firstIdentity,
      receiptChainHead: ONE_DIGEST,
    },
  })
  const currentStateFailure = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceFailed',
    requestId: 'status-current-state', code: 'receipt-chain-invalid',
    retryable: false, observedState: 'Running', identity: firstIdentity,
    receiptDigest: null, details: {},
  }
  const response = createManagerControlResponseFrame({
    requestFrame: request, payload: currentStateFailure,
  })
  assert.equal(validateManagerControlResponseFrame(response, request).payload.observedState, 'Running')
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame: request,
      payload: { ...currentStateFailure, identity: secondIdentity },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'cross-kind-substitution',
  )
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame: request,
      payload: { ...currentStateFailure, requestId: 'status-other-request' },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'cross-kind-substitution',
  )
})

test('control request validation rejects operation-invalid state and missing assertions', () => {
  const instanceIdentity = identity()
  const signing = signingFixture()
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest',
    requestId: 'invalid-start-frame', idempotencyKey: 'invalid-start-frame',
    requestDigest: ZERO_DIGEST, identity: instanceIdentity,
    priorReceiptDigest: ONE_DIGEST, admissionSealDigest: seal.metadata.digest,
    runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Stopped',
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  assert.throws(
    () => createManagerControlRequestFrame({ connectionNonce: '3', payload: request }),
    error => error instanceof RuntimeManagerError && error.code === 'invalid-request',
  )
})

test('authenticated manager control dispatch enforces peer ACL, namespace, nonce high-water, and result union', async () => {
  const instanceIdentity = identity()
  const payload = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
    requestId: 'status-control-1', identity: instanceIdentity, receiptChainHead: null,
  }
  const request = createManagerControlRequestFrame({ connectionNonce: '7', payload })
  let calls = 0
  const service = createManagerControlService({
    manager: {
      status(input) {
        calls += 1
        return {
          apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceFailed',
          requestId: input.requestId, code: 'not-found', retryable: false,
          observedState: null, identity: input.identity, receiptDigest: null, details: {},
        }
      },
    },
    peers: {
      controller: { operations: ['status'], namespacePrefixes: ['review-service'] },
      operator: { operations: ['doctor'], namespacePrefixes: ['review-service'] },
      foreign: { operations: ['status'], namespacePrefixes: ['another-service'] },
    },
  })
  const response = await service.handle(request, { peerIdentity: 'controller' })
  assert.equal(response.payloadKind, 'StatusInstanceFailed')
  assert.equal(calls, 1)
  await assert.rejects(
    () => service.handle(request, { peerIdentity: 'controller' }),
    error => error instanceof RuntimeManagerError && error.code === 'replayed-nonce',
  )
  await assert.rejects(
    () => service.handle(createManagerControlRequestFrame({ connectionNonce: '8', payload }), { peerIdentity: 'operator' }),
    error => error instanceof RuntimeManagerError && error.code === 'unauthorized',
  )
  await assert.rejects(
    () => service.handle(createManagerControlRequestFrame({ connectionNonce: '8', payload }), { peerIdentity: 'foreign' }),
    error => error instanceof RuntimeManagerError && error.code === 'unauthorized',
  )
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame: request,
      payload: {
        apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceFailed',
        requestId: payload.requestId, code: 'not-found', retryable: false,
        observedState: null, identity: instanceIdentity, receiptDigest: null, details: {},
      },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'cross-kind-substitution',
  )
})

test('control service returns real stale receipt status with its observed state', async () => {
  const instanceIdentity = identity()
  const signing = signingFixture()
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
  const lockRequest = baseLockRequest(resolved, lockReceipt, instanceIdentity, seal)
  lockRequest.requestDigest = computeSemanticRequestDigest(lockRequest)
  lockRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'lock', lockRequest.requestDigest,
  )
  lockRequest.runtimeAssertionDigest = lockRequest.runtimeAssertion.metadata.digest
  const manager = createWorkloadManager({
    trustVerifier: acceptingTrustVerifier(),
    health: async () => ({ state: 'ready', code: 'READY' }),
  })
  await manager.lock(lockRequest)
  const service = createManagerControlService({
    manager,
    peers: { controller: { operations: ['status'], namespacePrefixes: ['review-service'] } },
  })
  const request = createManagerControlRequestFrame({
    connectionNonce: '1',
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
      requestId: 'status-stale-head', identity: instanceIdentity,
      receiptChainHead: THREE_DIGEST,
    },
  })
  const response = await service.handle(request, { peerIdentity: 'controller' })
  assert.equal(response.payload.kind, 'StatusInstanceFailed')
  assert.equal(response.payload.code, 'receipt-chain-invalid')
  assert.equal(response.payload.observedState, 'Locked')
  assert.equal(validateManagerControlResponseFrame(response, request), response)
})

test('authenticated control reconciliation resolves and validates external evidence for the real manager', async () => {
  const cases = [
    ['committed', 'ReconcileInstanceProvedTerminal'],
    ['not-committed', 'ReconcileInstanceProvedSource'],
    ['temporary-unavailable', 'ReconcileInstanceIndeterminate'],
    ['resolver-throws', 'ReconcileInstanceIndeterminate'],
    ['conflict', 'ReconcileInstanceQuarantined'],
  ]
  let nonce = 0
  for (const [evidenceStatus, expectedKind] of cases) {
    const resolved = composition()
    const lockReceipt = compositionLock(resolved)
    const instanceIdentity = identity({ instanceId: `control-reconcile-${evidenceStatus}` })
    const signing = signingFixture()
    const bundle = trustBundle(signing)
    const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
    const lockRequest = baseLockRequest(resolved, lockReceipt, instanceIdentity, seal)
    lockRequest.requestId = `control-lock-${evidenceStatus}`
    lockRequest.idempotencyKey = `control-lock-${evidenceStatus}`
    lockRequest.requestDigest = computeSemanticRequestDigest(lockRequest)
    lockRequest.runtimeAssertion = runtimeAssertion(
      seal, instanceIdentity, signing, bundle, 'lock', lockRequest.requestDigest,
      { nonce: Buffer.alloc(16, ++nonce).toString('base64url'), revocationId: `control-lock-${evidenceStatus}` },
    )
    lockRequest.runtimeAssertionDigest = lockRequest.runtimeAssertion.metadata.digest
    const store = createMemoryRuntimeStore()
    const manager = createWorkloadManager({
      store, trustVerifier: acceptingTrustVerifier(),
      health: async () => ({ state: 'ready', code: 'READY' }),
      effects: { start: async () => ({ status: 'indeterminate' }) },
    })
    const locked = await manager.lock(lockRequest)
    const start = {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest',
      requestId: `control-start-${evidenceStatus}`, idempotencyKey: `control-start-${evidenceStatus}`,
      requestDigest: ZERO_DIGEST, identity: structuredClone(instanceIdentity),
      priorReceiptDigest: locked.receipt.digest, admissionSealDigest: seal.metadata.digest,
      runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Locked',
    }
    start.requestDigest = computeSemanticRequestDigest(start)
    start.runtimeAssertion = runtimeAssertion(
      seal, instanceIdentity, signing, bundle, 'start', start.requestDigest,
      { nonce: Buffer.alloc(16, ++nonce).toString('base64url'), revocationId: `control-start-${evidenceStatus}` },
    )
    start.runtimeAssertionDigest = start.runtimeAssertion.metadata.digest
    assert.equal((await manager.start(start)).kind, 'StartInstanceIndeterminate')
    const reconcile = {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest',
      requestId: `control-reconcile-${evidenceStatus}`,
      originalOperation: 'start', originalIdempotencyKey: start.idempotencyKey,
      originalRequestDigest: start.requestDigest, identity: structuredClone(instanceIdentity),
      journalEvidenceDigest: TWO_DIGEST,
      dshEvidenceDigest: THREE_DIGEST,
      expectedSourceStates: ['Locked'], expectedTerminalState: 'Running',
    }
    const frame = createManagerControlRequestFrame({ connectionNonce: String(++nonce), payload: reconcile })
    const service = createManagerControlService({
      manager,
      peers: { controller: { operations: ['reconcile'], namespacePrefixes: ['review-service'] } },
      reconcileEvidence: async request => {
        assert.equal(request.journalEvidenceDigest, reconcile.journalEvidenceDigest)
        if (evidenceStatus === 'resolver-throws') throw new Error('evidence transport unavailable')
        return evidenceStatus === 'committed'
          ? { status: evidenceStatus, sessionIdentity: 'session-1' }
          : { status: evidenceStatus }
      },
    })
    const response = await service.handle(frame, { peerIdentity: 'controller' })
    assert.equal(response.payload.kind, expectedKind)
    assert.equal(validateManagerControlResponseFrame(response, frame), response)
  }

  const missingResolver = createManagerControlService({
    manager: { reconcile: async () => { throw new Error('must not dispatch') } },
    peers: { controller: { operations: ['reconcile'], namespacePrefixes: ['review-service'] } },
  })
  const instanceIdentity = identity({ instanceId: 'missing-reconcile-resolver' })
  const request = createManagerControlRequestFrame({
    connectionNonce: '999',
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest',
      requestId: 'missing-reconcile-resolver', originalOperation: 'start',
      originalIdempotencyKey: 'missing-reconcile-resolver', originalRequestDigest: ONE_DIGEST,
      identity: instanceIdentity, journalEvidenceDigest: TWO_DIGEST,
      dshEvidenceDigest: THREE_DIGEST, expectedSourceStates: ['Locked'],
      expectedTerminalState: 'Running',
    },
  })
  await assert.rejects(
    () => missingResolver.handle(request, { peerIdentity: 'controller' }),
    error => error instanceof RuntimeManagerError && error.code === 'unsupported-kind',
  )
})

test('control frames admit exactly all ten public requests plus reconcile and their exhaustive result unions', () => {
  const instanceIdentity = identity()
  const signing = signingFixture()
  const resolved = composition()
  const compositionReceipt = compositionLock(resolved)
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, compositionReceipt, instanceIdentity, signing, bundle)
  const semantic = payload => {
    payload.requestDigest = computeSemanticRequestDigest(payload)
    return payload
  }
  const asserted = (payload, operation, nonce) => {
    semantic(payload)
    payload.runtimeAssertion = runtimeAssertion(
      seal, instanceIdentity, signing, bundle, operation, payload.requestDigest,
      { nonce, revocationId: `${operation}-frame-assertion` },
    )
    payload.runtimeAssertionDigest = payload.runtimeAssertion.metadata.digest
    return payload
  }
  const requests = [
    compositionProtocolRequests().validate,
    compositionProtocolRequests().resolve,
    asserted(baseLockRequest(resolved, compositionReceipt, instanceIdentity, seal), 'lock', 'AAAAAAAAAAAAAAAAAAAAAA'),
    asserted({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest', requestId: 'start-frame', idempotencyKey: 'start-frame', requestDigest: ZERO_DIGEST, identity: instanceIdentity, priorReceiptDigest: ONE_DIGEST, admissionSealDigest: seal.metadata.digest, runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Locked' }, 'start', 'AQEBAQEBAQEBAQEBAQEBAQ'),
    asserted({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'ResumeInstanceRequest', requestId: 'resume-frame', idempotencyKey: 'resume-frame', requestDigest: ZERO_DIGEST, identity: instanceIdentity, priorReceiptDigest: ONE_DIGEST, admissionSealDigest: seal.metadata.digest, runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Interrupted' }, 'resume', 'AgICAgICAgICAgICAgICAg'),
    { apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest', requestId: 'status-frame', identity: instanceIdentity, receiptChainHead: null },
    semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'InterruptInstanceRequest', requestId: 'interrupt-frame', idempotencyKey: 'interrupt-frame', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Running', runIdentity: 'run-1' }),
    semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'DrainInstanceRequest', requestId: 'drain-frame', idempotencyKey: 'drain-frame', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Running', triggerFenceDigest: ONE_DIGEST, publisherEpoch: '1', deadlinePolicyDigest: TWO_DIGEST }),
    semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'StopInstanceRequest', requestId: 'stop-frame', idempotencyKey: 'stop-frame', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Drained', receiptChainHead: ONE_DIGEST }),
    { apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest', requestId: 'doctor-frame', identity: instanceIdentity, expectedCompositionLockReceiptDigest: ONE_DIGEST, expectedAdmissionSealDigest: TWO_DIGEST, expectedReceiptChainHead: THREE_DIGEST },
    { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest', requestId: 'reconcile-frame', originalOperation: 'start', originalIdempotencyKey: 'start-frame', originalRequestDigest: ONE_DIGEST, identity: instanceIdentity, journalEvidenceDigest: TWO_DIGEST, dshEvidenceDigest: THREE_DIGEST, expectedSourceStates: ['Locked'], expectedTerminalState: 'Running' },
  ]
  assert.deepEqual(requests.map(request => request.kind), MANAGER_REQUEST_KINDS)
  for (const [index, payload] of requests.entries()) {
    const frame = createManagerControlRequestFrame({ connectionNonce: String(index + 1), payload })
    assert.equal(validateManagerControlRequestFrame(frame).payloadKind, payload.kind)
    assert.throws(
      () => createManagerControlRequestFrame({ connectionNonce: String(index + 20), payload: { ...payload, unexpected: true } }),
      error => error instanceof RuntimeManagerError && error.code === 'unknown-field',
    )
  }
  const flattened = Object.values(MANAGER_RESULT_KINDS_BY_REQUEST).flat()
  assert.deepEqual(flattened, MANAGER_RESULT_KINDS)
  assert.equal(new Set(flattened).size, flattened.length)
})

test('control response frames validate every lifecycle result variant with strict nested receipts', () => {
  const instanceIdentity = identity()
  const signing = signingFixture()
  const resolved = composition()
  const compositionReceipt = compositionLock(resolved)
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, compositionReceipt, instanceIdentity, signing, bundle)
  const semantic = payload => {
    payload.requestDigest = computeSemanticRequestDigest(payload)
    return payload
  }
  const asserted = (payload, operation, nonce) => {
    semantic(payload)
    payload.runtimeAssertion = runtimeAssertion(
      seal, instanceIdentity, signing, bundle, operation, payload.requestDigest,
      { nonce, revocationId: `${operation}-result-assertion` },
    )
    payload.runtimeAssertionDigest = payload.runtimeAssertion.metadata.digest
    return payload
  }
  const requests = {
    lock: asserted(baseLockRequest(resolved, compositionReceipt, instanceIdentity, seal), 'lock', 'AAAAAAAAAAAAAAAAAAAAAA'),
    start: asserted({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest', requestId: 'result-start', idempotencyKey: 'result-start', requestDigest: ZERO_DIGEST, identity: instanceIdentity, priorReceiptDigest: ONE_DIGEST, admissionSealDigest: seal.metadata.digest, runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Locked' }, 'start', 'AQEBAQEBAQEBAQEBAQEBAQ'),
    resume: asserted({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'ResumeInstanceRequest', requestId: 'result-resume', idempotencyKey: 'result-resume', requestDigest: ZERO_DIGEST, identity: instanceIdentity, priorReceiptDigest: ONE_DIGEST, admissionSealDigest: seal.metadata.digest, runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Interrupted' }, 'resume', 'AgICAgICAgICAgICAgICAg'),
    status: { apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest', requestId: 'result-status', identity: instanceIdentity, receiptChainHead: null },
    interrupt: semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'InterruptInstanceRequest', requestId: 'result-interrupt', idempotencyKey: 'result-interrupt', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Running', runIdentity: 'session-1' }),
    drain: semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'DrainInstanceRequest', requestId: 'result-drain', idempotencyKey: 'result-drain', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Running', triggerFenceDigest: ONE_DIGEST, publisherEpoch: '1', deadlinePolicyDigest: TWO_DIGEST }),
    stop: semantic({ apiVersion: 'runtime.sympoies.dev/v1', kind: 'StopInstanceRequest', requestId: 'result-stop', idempotencyKey: 'result-stop', requestDigest: ZERO_DIGEST, identity: instanceIdentity, expectedState: 'Drained', receiptChainHead: ONE_DIGEST }),
    doctor: { apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest', requestId: 'result-doctor', identity: instanceIdentity, expectedCompositionLockReceiptDigest: compositionReceipt.digest, expectedAdmissionSealDigest: seal.metadata.digest, expectedReceiptChainHead: ONE_DIGEST },
    reconcile: { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceRequest', requestId: 'result-reconcile', originalOperation: 'start', originalIdempotencyKey: 'result-start', originalRequestDigest: ZERO_DIGEST, identity: instanceIdentity, journalEvidenceDigest: TWO_DIGEST, dshEvidenceDigest: THREE_DIGEST, expectedSourceStates: ['Locked'], expectedTerminalState: 'Running' },
  }
  requests.reconcile.originalRequestDigest = requests.start.requestDigest

  const transitions = {
    lock: ['Absent', 'Locked'], start: ['Locked', 'Running'],
    resume: ['Interrupted', 'Running'], interrupt: ['Running', 'Interrupted'],
    drain: ['Running', 'Drained'], stop: ['Drained', 'Stopped'],
  }
  const receiptKinds = {
    lock: 'InstanceLockReceipt', start: 'InstanceStartReceipt',
    resume: 'InstanceResumeReceipt', interrupt: 'InstanceInterruptReceipt',
    drain: 'InstanceDrainReceipt', stop: 'InstanceStopReceipt',
  }
  const transients = {
    lock: 'Locked', start: 'Starting', resume: 'Starting',
    interrupt: 'Interrupting', drain: 'Draining', stop: 'Stopping',
  }
  const receipt = operation => {
    const request = requests[operation]
    const [sourceState, observedState] = transitions[operation]
    const value = {
      apiVersion: 'runtime.sympoies.dev/v1', kind: receiptKinds[operation],
      digest: ZERO_DIGEST, operation, identity: structuredClone(instanceIdentity),
      idempotencyKey: request.idempotencyKey, sourceState, observedState,
      compositionLockReceiptDigest: compositionReceipt.digest,
      resolvedCompositionDigest: resolved.metadata.digest,
      admissionSealDigest: seal.metadata.digest, requestDigest: request.requestDigest,
      priorReceiptDigest: operation === 'lock' ? null : ONE_DIGEST,
      sealTrustAcceptanceReceiptDigest: operation === 'lock' ? TWO_DIGEST : null,
      assertionTrustAcceptanceReceiptDigest: ['lock', 'start', 'resume'].includes(operation) ? THREE_DIGEST : null,
      sessionIdentity: operation === 'lock' ? null : 'session-1',
      effectSummaryDigest: null, timestamp: '2026-08-28T00:00:00Z',
    }
    value.digest = computeManagerDocumentDigest(value)
    return value
  }
  const results = []
  const successes = {}
  for (const operation of ['lock', 'start', 'resume', 'interrupt', 'drain', 'stop']) {
    const request = requests[operation]
    const operationReceipt = receipt(operation)
    const success = {
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceSucceeded`,
      requestId: request.requestId, idempotencyKey: request.idempotencyKey,
      identity: structuredClone(instanceIdentity), observedState: transitions[operation][1],
      receipt: operationReceipt,
      ...(['start', 'resume'].includes(operation) ? { sessionIdentity: 'session-1' } : {}),
      ...(operation === 'interrupt' ? { retainedStateDigest: null } : {}),
      ...(operation === 'drain' ? { reconciledEffectSummaryDigest: null } : {}),
      ...(operation === 'stop' ? { retainedStateDisposition: 'retained' } : {}),
    }
    successes[operation] = success
    const failure = {
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`,
      requestId: request.requestId, code: 'state-conflict', retryable: false,
      observedState: operation === 'lock' ? null : transitions[operation][0],
      identity: structuredClone(instanceIdentity), receiptDigest: null, details: {},
      ...(['lock', 'start', 'resume'].includes(operation)
        ? { trustAcceptanceFailureDigest: null } : {}),
    }
    const indeterminate = {
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceIndeterminate`,
      requestId: request.requestId, idempotencyKey: request.idempotencyKey,
      code: 'effect-unknown', retryable: false,
      lastObservedState: transients[operation],
      identity: structuredClone(instanceIdentity), receiptDigest: null,
      mandatoryRecovery: {
        statusRequired: true, doctorRequired: true,
        repeatSameOperationAndKey: true, quarantineIfStillUnknown: true,
      },
    }
    results.push([operation, success], [operation, failure], [operation, indeterminate])
  }
  results.push(
    ['status', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceSucceeded', requestId: requests.status.requestId, identity: structuredClone(instanceIdentity), observedState: 'Running', sessionIdentity: 'session-1', receiptChainHead: ONE_DIGEST, health: { required: ['github-review.ready'], optional: [] }, resources: { classes: ['shared'] } }],
    ['status', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceFailed', requestId: requests.status.requestId, code: 'not-found', retryable: false, observedState: null, identity: structuredClone(instanceIdentity), receiptDigest: null, details: {} }],
    ['doctor', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceSucceeded', requestId: requests.doctor.requestId, identity: structuredClone(instanceIdentity), observedState: 'Running', checks: [{ id: 'composition-lock', state: 'pass' }, { id: 'admission-seal', state: 'pass' }, { id: 'receipt-chain', state: 'pass' }], recoveryRecommendation: 'none', receiptChainVerified: true }],
    ['doctor', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceFailed', requestId: requests.doctor.requestId, code: 'not-found', retryable: false, observedState: null, identity: structuredClone(instanceIdentity), receiptDigest: null, details: {} }],
    ['reconcile', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceProvedTerminal', requestId: requests.reconcile.requestId, identity: structuredClone(instanceIdentity), observedState: 'Running', originalOperation: 'start', originalIdempotencyKey: requests.reconcile.originalIdempotencyKey, originalRequestDigest: requests.reconcile.originalRequestDigest }],
    ['reconcile', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceProvedSource', requestId: requests.reconcile.requestId, identity: structuredClone(instanceIdentity), observedState: 'Locked', originalOperation: 'start', originalIdempotencyKey: requests.reconcile.originalIdempotencyKey, originalRequestDigest: requests.reconcile.originalRequestDigest }],
  )
  const quarantineReceipt = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'InstanceQuarantineReceipt', digest: ZERO_DIGEST,
    originalOperation: 'start', originalIdempotencyKey: requests.reconcile.originalIdempotencyKey,
    originalRequestDigest: requests.reconcile.originalRequestDigest,
    identity: structuredClone(instanceIdentity), sourceState: 'Locked',
    lastObservedState: 'Starting', journalEvidenceDigest: requests.reconcile.journalEvidenceDigest,
    dshEvidenceDigest: requests.reconcile.dshEvidenceDigest, priorReceiptDigest: ONE_DIGEST,
    reasonCode: 'stable-conflict', observedState: 'Quarantined',
  }
  quarantineReceipt.digest = computeManagerDocumentDigest(quarantineReceipt)
  results.push(
    ['reconcile', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceQuarantined', requestId: requests.reconcile.requestId, identity: structuredClone(instanceIdentity), observedState: 'Quarantined', receipt: quarantineReceipt, originalOperation: requests.reconcile.originalOperation, originalIdempotencyKey: requests.reconcile.originalIdempotencyKey, originalRequestDigest: requests.reconcile.originalRequestDigest }],
    ['reconcile', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceIndeterminate', requestId: requests.reconcile.requestId, code: 'evidence-temporarily-unavailable', retryable: false, identity: structuredClone(instanceIdentity), observedState: 'Starting', originalOperation: requests.reconcile.originalOperation, originalIdempotencyKey: requests.reconcile.originalIdempotencyKey, originalRequestDigest: requests.reconcile.originalRequestDigest }],
    ['reconcile', { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ReconcileInstanceFailed', requestId: requests.reconcile.requestId, code: 'not-found', retryable: false, identity: structuredClone(instanceIdentity), observedState: null, receiptDigest: null, details: {} }],
  )

  const framedKinds = []
  let nonce = 100
  for (const [operation, payload] of results) {
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    const response = createManagerControlResponseFrame({ requestFrame, payload })
    assert.equal(validateManagerControlResponseFrame(response, requestFrame), response)
    framedKinds.push(payload.kind)
  }
  assert.deepEqual(
    framedKinds.sort(),
    MANAGER_RESULT_KINDS.filter(kind => !kind.startsWith('ValidateComposition')
      && !kind.startsWith('ResolveComposition')).sort(),
  )

  const substitutions = [
    ['lock', 'requestDigest', ONE_DIGEST],
    ['lock', 'compositionLockReceiptDigest', ONE_DIGEST],
    ['lock', 'resolvedCompositionDigest', ONE_DIGEST],
    ['lock', 'admissionSealDigest', ONE_DIGEST],
    ['start', 'priorReceiptDigest', TWO_DIGEST],
    ['start', 'admissionSealDigest', ONE_DIGEST],
    ['drain', 'sourceState', 'Interrupted'],
    ['stop', 'priorReceiptDigest', TWO_DIGEST],
  ]
  for (const [operation, field, substituted] of substitutions) {
    const payload = structuredClone(successes[operation])
    payload.receipt[field] = substituted
    payload.receipt.digest = ZERO_DIGEST
    payload.receipt.digest = computeManagerDocumentDigest(payload.receipt)
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    assert.throws(
      () => createManagerControlResponseFrame({ requestFrame, payload }),
      error => error instanceof RuntimeManagerError && error.code === 'cross-kind-substitution',
      `${operation} receipt ${field} substitution`,
    )
  }

  for (const operation of ['lock', 'start', 'resume', 'interrupt', 'drain', 'stop']) {
    const payload = structuredClone(successes[operation])
    if (operation === 'lock') payload.receipt.sealTrustAcceptanceReceiptDigest = null
    else if (['start', 'resume'].includes(operation)) payload.receipt.sealTrustAcceptanceReceiptDigest = ONE_DIGEST
    else payload.receipt.assertionTrustAcceptanceReceiptDigest = ONE_DIGEST
    payload.receipt.digest = ZERO_DIGEST
    payload.receipt.digest = computeManagerDocumentDigest(payload.receipt)
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    assert.throws(
      () => createManagerControlResponseFrame({ requestFrame, payload }),
      error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
      `${operation} receipt acceptance evidence`,
    )
  }

  for (const [operation, field, value] of [
    ['lock', 'degradedHealth', []],
    ['interrupt', 'sessionIdentity', 'session-1'],
    ['drain', 'sessionIdentity', 'session-1'],
    ['stop', 'sessionIdentity', 'session-1'],
  ]) {
    const payload = { ...structuredClone(successes[operation]), [field]: value }
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    assert.throws(
      () => createManagerControlResponseFrame({ requestFrame, payload }),
      error => error instanceof RuntimeManagerError && error.code === 'unknown-field',
      `${operation} implementation-only success field`,
    )
  }

  for (const operation of ['start', 'resume']) {
    const payload = structuredClone(successes[operation])
    payload.sessionIdentity = null
    payload.receipt.sessionIdentity = null
    payload.receipt.digest = ZERO_DIGEST
    payload.receipt.digest = computeManagerDocumentDigest(payload.receipt)
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    assert.throws(
      () => createManagerControlResponseFrame({ requestFrame, payload }),
      error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
      `${operation} missing DSH session identity`,
    )
  }

  const authenticatedCodes = [
    'assertion-invalid', 'assertion-expired', 'assertion-stale', 'assertion-revoked',
    'signature-unsupported', 'signature-trust-unapproved', 'signature-key-unknown',
    'signature-key-revoked', 'signature-invalid', 'signature-key-use-invalid',
    'trust-acceptance-unauthenticated', 'trust-acceptance-unauthorized',
    'trust-namespace-not-found', 'trust-head-stale', 'trust-bundle-unreachable',
    'trust-acceptance-conflict', 'trust-acceptance-replay',
    'trust-authority-clock-unavailable', 'trust-authority-unavailable',
    'time-revision-conflict', 'time-revision-exhausted',
  ]
  const failureCodes = {
    lock: ['invalid-request', 'identity-conflict', 'state-conflict', 'stale-resolution', 'seal-invalid', 'authority-widening', 'namespace-conflict', 'cas-conflict', 'receipt-chain-invalid', 'idempotency-conflict', ...authenticatedCodes],
    start: ['invalid-request', 'state-conflict', 'lock-invalid', 'seal-invalid', 'required-health-failed', 'namespace-conflict', 'runtime-unavailable', 'cas-conflict', 'idempotency-conflict', ...authenticatedCodes],
    resume: ['invalid-request', 'state-conflict', 'identity-mismatch', 'seal-invalid', 'retained-state-missing', 'receipt-chain-invalid', 'runtime-unavailable', 'cas-conflict', 'idempotency-conflict', ...authenticatedCodes],
    status: ['invalid-request', 'not-found', 'receipt-chain-invalid', 'runtime-unavailable'],
    interrupt: ['invalid-request', 'state-conflict', 'cancellation-identity-mismatch', 'runtime-unavailable', 'cas-conflict', 'idempotency-conflict'],
    drain: ['invalid-request', 'state-conflict', 'trigger-fence-invalid', 'publisher-epoch-stale', 'inflight-timeout', 'ambiguous-external-write', 'receipt-chain-invalid', 'cas-conflict', 'idempotency-conflict'],
    stop: ['invalid-request', 'state-conflict', 'active-publisher', 'unreconciled-work', 'receipt-chain-invalid', 'runtime-unavailable', 'cas-conflict', 'idempotency-conflict'],
    doctor: ['invalid-request', 'not-found', 'lock-invalid', 'seal-invalid', 'receipt-chain-invalid', 'runtime-unavailable'],
    reconcile: ['invalid-request', 'not-found', 'state-conflict', 'evidence-digest-invalid', 'receipt-chain-invalid', 'idempotency-conflict', 'unauthorized-state-mutation'],
  }
  const retryableCodes = new Set([
    'runtime-unavailable', 'cas-conflict', 'trust-head-stale', 'time-revision-conflict',
    'trust-authority-clock-unavailable', 'trust-authority-unavailable',
  ])
  const digestRequiredCodes = new Set(TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED_CODES)
  for (const [operation, codes] of Object.entries(failureCodes)) {
    for (const code of codes) {
      const request = requests[operation]
      const authenticated = ['lock', 'start', 'resume'].includes(operation)
      const payload = {
        apiVersion: 'runtime.sympoies.dev/v1',
        kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`,
        requestId: request.requestId, code, retryable: retryableCodes.has(code),
        observedState: null, identity: structuredClone(instanceIdentity),
        receiptDigest: null,
        details: code === 'required-health-failed' ? { probe: 'github-review.ready' } : {},
        ...(authenticated ? {
          trustAcceptanceFailureDigest: digestRequiredCodes.has(code) ? ONE_DIGEST : null,
        } : {}),
      }
      const requestFrame = createManagerControlRequestFrame({
        connectionNonce: String(++nonce), payload: request,
      })
      assert.equal(createManagerControlResponseFrame({ requestFrame, payload }).payload.code, code)
    }
  }
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame: createManagerControlRequestFrame({ connectionNonce: String(++nonce), payload: requests.start }),
      payload: {
        apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceFailed',
        requestId: requests.start.requestId, code: 'trigger-fence-invalid', retryable: false,
        observedState: 'Locked', identity: structuredClone(instanceIdentity),
        receiptDigest: null, details: {}, trustAcceptanceFailureDigest: null,
      },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )

  for (const operation of ['lock', 'start', 'resume']) {
    const code = 'trust-acceptance-unauthorized'
    const requestFrame = createManagerControlRequestFrame({
      connectionNonce: String(++nonce), payload: requests[operation],
    })
    assert.throws(
      () => createManagerControlResponseFrame({
        requestFrame,
        payload: {
          apiVersion: 'runtime.sympoies.dev/v1',
          kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`,
          requestId: requests[operation].requestId, code, retryable: false,
          observedState: null, identity: structuredClone(instanceIdentity),
          receiptDigest: null, details: {}, trustAcceptanceFailureDigest: null,
        },
      }),
      error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
      `${operation} authority-only denial without failure digest`,
    )
  }

  const requiredHealthFrame = createManagerControlRequestFrame({
    connectionNonce: String(++nonce), payload: requests.start,
  })
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame: requiredHealthFrame,
      payload: {
        apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceFailed',
        requestId: requests.start.requestId, code: 'required-health-failed',
        retryable: false, observedState: 'Locked', identity: structuredClone(instanceIdentity),
        receiptDigest: null, details: {}, trustAcceptanceFailureDigest: null,
      },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
})

test('doctor control results admit the frozen degraded check state without claiming full health', () => {
  const instanceIdentity = identity()
  const request = createManagerControlRequestFrame({
    connectionNonce: '44',
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceRequest',
      requestId: 'doctor-degraded', identity: instanceIdentity,
      expectedCompositionLockReceiptDigest: ONE_DIGEST,
      expectedAdmissionSealDigest: TWO_DIGEST,
      expectedReceiptChainHead: THREE_DIGEST,
    },
  })
  const response = createManagerControlResponseFrame({
    requestFrame: request,
    payload: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'DoctorInstanceSucceeded',
      requestId: 'doctor-degraded', identity: instanceIdentity, observedState: 'Running',
      checks: [
        { id: 'composition-lock', state: 'pass' },
        { id: 'admission-seal', state: 'degraded' },
        { id: 'receipt-chain', state: 'pass' },
      ],
      recoveryRecommendation: 'reconcile', receiptChainVerified: true,
    },
  })
  assert.equal(validateManagerControlResponseFrame(response, request), response)
})

test('manager control datagrams reject oversize request and response frames before dispatch or cloning', () => {
  const statusRequest = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
    requestId: 'bounded-status', identity: identity(), receiptChainHead: null,
  }
  const requestFrame = createManagerControlRequestFrame({ connectionNonce: '900', payload: statusRequest })
  assert.throws(
    () => validateManagerControlRequestFrame({
      ...requestFrame, padding: 'x'.repeat(MANAGER_CONTROL_MAX_DATAGRAM_BYTES),
    }),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
  const bounded = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceSucceeded',
    requestId: statusRequest.requestId, identity: structuredClone(statusRequest.identity),
    observedState: 'Running', sessionIdentity: 'session-1', receiptChainHead: null,
    health: { required: [], optional: [] }, resources: { data: 'x'.repeat(900 * 1024) },
  }
  assert.equal(
    createManagerControlResponseFrame({ requestFrame, payload: bounded }).payload.resources.data.length,
    900 * 1024,
  )
  assert.throws(
    () => createManagerControlResponseFrame({
      requestFrame,
      payload: { ...bounded, resources: { data: 'x'.repeat(MANAGER_CONTROL_MAX_DATAGRAM_BYTES) } },
    }),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
})

test('protocol signature primitive matches the frozen RFC 8032 fixture', () => {
  assert.equal(
    verifyProtocolSignatureDigest({
      signedKind: 'DshDeploymentAdmissionSeal',
      rawDocumentDigest: '412a943a8e0b3a68d3447c7539e3bb18bbc62bab5121b5592c2c8f376ce3e583',
      keyId: 'ed25519:rfc8032-test-1',
      rawPublicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      signature: 'NmrwuURMwyeZ4RIHH2OBfQfhVWuDxNvj1jL4ZGwimdfHc4bc3Sqls2_UNTIijNOB9-Qzh8nBohMxTGJstYa_CA',
    }),
    true,
  )
})

test('trust transitions reject material substitution, reactivation, and future activation', () => {
  const signing = signingFixture()
  const prior = trustBundle(signing)
  const addedKey = {
    keyId: 'ed25519:rotated-assertion', algorithm: 'Ed25519', use: 'assertion',
    rawPublicKeyHex: signing.publicKeyHex, state: 'active',
  }
  const next = trustBundle(signing, { bundleId: 'bundle-2', keys: [...prior.keys, addedKey] })
  const valid = trustTransition(prior, next, signing, 1, [{
    keyId: addedKey.keyId, priorState: null, nextState: 'active',
  }])
  assert.equal(validateTrustBundleTransition(valid, prior, next, { authorityTime: '2026-08-28T00:00:01Z' }), valid)
  assert.throws(
    () => validateTrustBundleTransition(valid, prior, next, { authorityTime: '2026-08-28T00:00:00Z' }),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )

  const substituted = trustBundle(signing, {
    bundleId: 'bundle-substituted',
    keys: prior.keys.map(key => key.keyId === signing.keyId ? { ...key, rawPublicKeyHex: 'f'.repeat(64) } : key),
  })
  const substitution = trustTransition(prior, substituted, signing, 1, [])
  assert.throws(
    () => validateTrustBundleTransition(substitution, prior, substituted, { authorityTime: '2026-08-28T00:00:01Z' }),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )

  const revoked = trustBundle(signing, {
    bundleId: 'bundle-revoked',
    keys: prior.keys.map(key => key.keyId === signing.keyId ? { ...key, state: 'revoked' } : key),
  })
  const reactivated = trustBundle(signing, { bundleId: 'bundle-reactivated', keys: structuredClone(prior.keys) })
  const reactivation = trustTransition(revoked, reactivated, signing, 2, [{
    keyId: signing.keyId, priorState: 'revoked', nextState: 'active',
  }])
  assert.throws(
    () => validateTrustBundleTransition(reactivation, revoked, reactivated, { authorityTime: '2026-08-28T00:00:01Z' }),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )
  const nonexistentDate = structuredClone(valid)
  nonexistentDate.effectiveAt = '2026-02-31T00:00:00Z'
  assert.throws(
    () => validateTrustBundleTransition(nonexistentDate, prior, next, { authorityTime: '2026-08-28T00:00:01Z' }),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
})

test('trust verifier paginates one retained snapshot and rejects authority-time replay', async () => {
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: bundle.metadata.digest,
    sequence: '0', bundleDigest: bundle.metadata.digest, transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  let revision = 0
  const authority = {
    async readLineage(request) {
      revision += 1
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHead: head,
        snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
        pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
        complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
        priorAuthorityTime: revision === 1 ? null : '2026-08-28T00:00:01Z',
        timeRevision: String(revision), priorTimeRevision: revision === 1 ? null : String(revision - 1),
        clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
      }
      response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
    async readBundle(request) {
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest, bundleDigest: bundle.metadata.digest,
        bundle, controllerReceiptDigest: TWO_DIGEST,
      }
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
  }
  const verifier = createTrustVerifier({
    authority,
    bootstrap: { 'review-service': { genesisBundleDigest: bundle.metadata.digest, controllerIdentity: 'controller.review-service' } },
    nonce: (() => { let value = 0; return () => Buffer.alloc(16, ++value).toString('base64url') })(),
  })
  const first = await verifier.readCurrent('review-service')
  assert.equal(first.head.digest, head.digest)
  await verifier.readCurrent('review-service')
  authority.readLineage = async request => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
      requestId: request.requestId, requestDigest: request.requestDigest,
      challengeNonce: request.challengeNonce, namespace: request.namespace,
      controllerIdentity: 'controller.review-service', snapshotHead: head,
      snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
      snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
      pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
      complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
      priorAuthorityTime: '2026-08-28T00:00:01Z', timeRevision: '2',
      priorTimeRevision: '1', clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
    }
    response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  await assert.rejects(
    () => verifier.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'time-revision-conflict',
  )
})

test('trust verifiers sharing retained state serialize namespace refresh and preserve the newest revision', async () => {
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: bundle.metadata.digest,
    sequence: '0', bundleDigest: bundle.metadata.digest, transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let lineageCalls = 0
  let bundleCalls = 0
  const authority = {
    async readLineage(request) {
      lineageCalls += 1
      const revision = lineageCalls
      if (revision === 1) await firstGate
      const authorityTime = `2026-08-28T00:00:0${revision}Z`
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHead: head,
        snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
        pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
        complete: true, transitions: [], authorityTime,
        priorAuthorityTime: revision === 1 ? null : '2026-08-28T00:00:01Z',
        timeRevision: String(revision), priorTimeRevision: revision === 1 ? null : '1',
        clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
      }
      response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
    async readBundle(request) {
      bundleCalls += 1
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
        bundleDigest: bundle.metadata.digest, bundle, controllerReceiptDigest: THREE_DIGEST,
      }
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
  }
  const state = new Map()
  const bootstrap = {
    'review-service': {
      genesisBundleDigest: bundle.metadata.digest,
      controllerIdentity: 'controller.review-service',
    },
  }
  const first = createTrustVerifier({
    authority, bootstrap, state, nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  const second = createTrustVerifier({
    authority, bootstrap, state, nonce: () => 'AQEBAQEBAQEBAQEBAQEBAQ',
  })
  const older = first.readCurrent('review-service')
  await new Promise(resolve => setImmediate(resolve))
  const newer = second.readCurrent('review-service')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lineageCalls, 1)
  releaseFirst()
  const [olderSnapshot, newerSnapshot] = await Promise.all([older, newer])
  assert.equal(olderSnapshot.timeRevision, '1')
  assert.equal(newerSnapshot.timeRevision, '2')
  assert.equal(state.get('review-service').timeRevision, '2')
  assert.equal(lineageCalls, 2)
  assert.equal(bundleCalls, 1)
})

test('trust reads reject current-head and nested namespace substitution', async () => {
  const signing = signingFixture()
  const trustedBundle = trustBundle(signing)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: trustedBundle.metadata.digest,
    sequence: '0', bundleDigest: trustedBundle.metadata.digest, transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  const lineage = (request, selectedHead = head, currentHeadDigest = selectedHead.digest) => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
      requestId: request.requestId, requestDigest: request.requestDigest,
      challengeNonce: request.challengeNonce, namespace: request.namespace,
      controllerIdentity: 'controller.review-service', snapshotHead: selectedHead,
      snapshotHeadDigest: selectedHead.digest, currentHeadDigest,
      snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
      pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
      complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
      priorAuthorityTime: null, timeRevision: '1', priorTimeRevision: null,
      clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
    }
    response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  const bootstrap = bundle => ({
    'review-service': {
      genesisBundleDigest: bundle.metadata.digest,
      controllerIdentity: 'controller.review-service',
    },
  })
  let bundleCalls = 0
  const staleCurrent = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineage(request, head, ONE_DIGEST) },
      async readBundle() { bundleCalls += 1; throw new Error('must not read bundle') },
    },
    bootstrap: bootstrap(trustedBundle), nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  await assert.rejects(
    () => staleCurrent.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )
  assert.equal(bundleCalls, 0)

  const foreignHead = structuredClone(head)
  foreignHead.namespace = 'another-service'
  foreignHead.digest = ZERO_DIGEST
  foreignHead.digest = computeManagerDocumentDigest(foreignHead)
  const wrongHeadNamespace = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineage(request, foreignHead) },
      async readBundle() { throw new Error('must not read bundle') },
    },
    bootstrap: bootstrap(trustedBundle), nonce: () => 'AQEBAQEBAQEBAQEBAQEBAQ',
  })
  await assert.rejects(
    () => wrongHeadNamespace.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )

  const foreignBundle = trustBundle(signing, { namespace: 'another-service', bundleId: 'foreign-bundle' })
  const crossWiredHead = {
    ...head, digest: ZERO_DIGEST, genesisBundleDigest: foreignBundle.metadata.digest,
    bundleDigest: foreignBundle.metadata.digest,
  }
  crossWiredHead.digest = computeManagerDocumentDigest(crossWiredHead)
  const wrongBundleNamespace = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineage(request, crossWiredHead) },
      async readBundle(request) {
        const response = {
          apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
          requestId: request.requestId, requestDigest: request.requestDigest,
          challengeNonce: request.challengeNonce, namespace: request.namespace,
          controllerIdentity: 'controller.review-service', snapshotHeadDigest: request.snapshotHeadDigest,
          snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
          bundleDigest: request.bundleDigest, bundle: foreignBundle, controllerReceiptDigest: THREE_DIGEST,
        }
        response.digest = computeManagerDocumentDigest(response)
        return response
      },
    },
    bootstrap: bootstrap(foreignBundle), nonce: () => 'AgICAgICAgICAgICAgICAg',
  })
  await assert.rejects(
    () => wrongBundleNamespace.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'bundle-invalid',
  )
})

test('trust verifier cold-reads 257 transitions beyond one cumulative datagram without a global cap', async () => {
  const signing = signingFixture()
  const genesis = trustBundle(signing)
  const bundles = new Map([[genesis.metadata.digest, genesis]])
  const transitions = []
  let prior = genesis
  let rotating = []
  for (let sequence = 1; sequence <= 257; sequence += 1) {
    const phase = (sequence - 1) % 3
    let nextKeys = structuredClone(prior.keys)
    let changes
    if (phase === 0) {
      rotating = Array.from({ length: 50 }, (_, index) => `ed25519:e${String(sequence).padStart(4, '0')}-k${String(index).padStart(2, '0')}`)
      const additions = rotating.map(keyId => ({
        keyId, algorithm: 'Ed25519', use: 'assertion',
        rawPublicKeyHex: signing.publicKeyHex, state: 'active',
      }))
      nextKeys.push(...additions)
      changes = rotating.map(keyId => ({ keyId, priorState: null, nextState: 'active' }))
    } else if (phase === 1) {
      nextKeys = nextKeys.map(key => rotating.includes(key.keyId) ? { ...key, state: 'revoked' } : key)
      changes = rotating.map(keyId => ({ keyId, priorState: 'active', nextState: 'revoked' }))
    } else {
      nextKeys = nextKeys.filter(key => !rotating.includes(key.keyId))
      changes = rotating.map(keyId => ({ keyId, priorState: 'revoked', nextState: 'removed' }))
    }
    nextKeys.sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0)
    changes.sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0)
    const next = trustBundle(signing, { bundleId: `bundle-${sequence + 1}`, keys: nextKeys })
    const transition = trustTransition(prior, next, signing, sequence, changes)
    transitions.push(transition)
    bundles.set(next.metadata.digest, next)
    prior = next
  }
  assert.ok(transitions.reduce((total, transition) => total + Buffer.byteLength(JSON.stringify(transition)), 0) > 1024 * 1024)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: genesis.metadata.digest,
    sequence: '257', bundleDigest: prior.metadata.digest,
    transitionDigest: transitions.at(-1).metadata.digest, casRevision: '257',
  }
  head.digest = computeManagerDocumentDigest(head)
  let pageCalls = 0
  let bundleCalls = 0
  const authority = {
    async readLineage(request) {
      pageCalls += 1
      const after = Number(request.afterSequence)
      const page = transitions.slice(after, after + request.pageLimit)
      const complete = after + page.length === transitions.length
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHead: head,
        snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
        pageStartSequence: page[0]?.sequence ?? null,
        pageEndSequence: page.at(-1)?.sequence ?? null,
        nextAfterSequence: complete ? null : page.at(-1).sequence,
        complete, transitions: page, authorityTime: '2026-08-28T00:00:02Z',
        priorAuthorityTime: null, timeRevision: '1', priorTimeRevision: null,
        clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
      }
      response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
    async readBundle(request) {
      bundleCalls += 1
      const bundle = bundles.get(request.bundleDigest)
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHeadDigest: request.snapshotHeadDigest,
        snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
        bundleDigest: request.bundleDigest, bundle, controllerReceiptDigest: TWO_DIGEST,
      }
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
  }
  const verifier = createTrustVerifier({
    authority,
    bootstrap: { 'review-service': { genesisBundleDigest: genesis.metadata.digest, controllerIdentity: 'controller.review-service' } },
    nonce: (() => { let value = 0n; return () => { const bytes = Buffer.alloc(16); bytes.writeBigUInt64BE(++value, 8); return bytes.toString('base64url') } })(),
  })
  const snapshot = await verifier.readCurrent('review-service')
  assert.equal(snapshot.head.digest, head.digest)
  assert.ok(pageCalls >= 5)
  assert.equal(bundleCalls, 258)
})

test('one-use trust acceptance verifies every response field and advances persisted authority time', async () => {
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: bundle.metadata.digest,
    sequence: '0', bundleDigest: bundle.metadata.digest, transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  const makeAuthority = acceptanceExtra => ({
    async readLineage(request) {
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHead: head,
        snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: '0',
        pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
        complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
        priorAuthorityTime: null, timeRevision: '1', priorTimeRevision: null,
        clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
      }
      response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
    async readBundle(request) {
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, namespace: request.namespace,
        controllerIdentity: 'controller.review-service', snapshotHeadDigest: head.digest,
        snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
        bundleDigest: bundle.metadata.digest, bundle, controllerReceiptDigest: TWO_DIGEST,
      }
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
    async accept(request) {
      const response = {
        apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustAcceptanceSucceeded', digest: ZERO_DIGEST,
        requestId: request.requestId, requestDigest: request.requestDigest,
        challengeNonce: request.challengeNonce, controllerIdentity: 'controller.review-service',
        namespace: request.namespace, acceptanceKind: request.acceptanceKind,
        signedDocumentKind: request.signedDocumentKind,
        signedDocumentDigest: request.signedDocumentDigest,
        keyId: request.signedDocument.keyId, keyUse: request.acceptanceKind,
        bundleDigest: request.signedDocument.bundleDigest, operation: request.operation,
        semanticRequestDigest: request.semanticRequestDigest,
        expectedEffectJournalRevision: request.expectedEffectJournalRevision,
        acceptedCurrentHeadDigest: head.digest, authorityTime: '2026-08-28T00:00:02Z',
        priorAuthorityTime: '2026-08-28T00:00:01Z', timeRevision: '2',
        priorTimeRevision: '1', controllerReceiptDigest: THREE_DIGEST,
        acceptedAt: '2026-08-28T00:00:02Z', ...acceptanceExtra,
      }
      response.digest = computeManagerDocumentDigest(response)
      return response
    },
  })
  const resolved = composition()
  const compositionReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const seal = admissionSeal(resolved, compositionReceipt, instanceIdentity, signing, bundle)
  const assertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'instance.start', ONE_DIGEST)
  const verifier = createTrustVerifier({
    authority: makeAuthority({}),
    bootstrap: { 'review-service': { genesisBundleDigest: bundle.metadata.digest, controllerIdentity: 'controller.review-service' } },
    nonce: (() => { let value = 0; return () => Buffer.alloc(16, ++value).toString('base64url') })(),
  })
  const accepted = await verifier.acceptSignedDocument({
    namespace: 'review-service', acceptanceKind: 'assertion', signedDocument: assertion,
    operation: 'instance.start', semanticRequestDigest: ONE_DIGEST,
    expectedEffectJournalRevision: '0',
  })
  assert.equal(accepted.timeRevision, '2')
  assert.equal(verifier.state.get('review-service').timeRevision, '2')

  const invalid = createTrustVerifier({
    authority: makeAuthority({ unexpected: true }),
    bootstrap: { 'review-service': { genesisBundleDigest: bundle.metadata.digest, controllerIdentity: 'controller.review-service' } },
    nonce: (() => { let value = 10; return () => Buffer.alloc(16, ++value).toString('base64url') })(),
  })
  await assert.rejects(
    () => invalid.acceptSignedDocument({
      namespace: 'review-service', acceptanceKind: 'assertion', signedDocument: assertion,
      operation: 'instance.start', semanticRequestDigest: ONE_DIGEST,
      expectedEffectJournalRevision: '0',
    }),
    error => error instanceof RuntimeManagerError && error.code === 'unknown-field',
  )
})

test('trust failures are strict and correlated before their typed code is exposed', async () => {
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: bundle.metadata.digest,
    sequence: '0', bundleDigest: bundle.metadata.digest, transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  const lineageSuccess = request => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
      requestId: request.requestId, requestDigest: request.requestDigest,
      challengeNonce: request.challengeNonce, namespace: request.namespace,
      controllerIdentity: 'controller.review-service', snapshotHead: head,
      snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
      snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
      pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
      complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
      priorAuthorityTime: null, timeRevision: '1', priorTimeRevision: null,
      clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
    }
    response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  const bundleSuccess = request => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
      requestId: request.requestId, requestDigest: request.requestDigest,
      challengeNonce: request.challengeNonce, namespace: request.namespace,
      controllerIdentity: 'controller.review-service', snapshotHeadDigest: request.snapshotHeadDigest,
      snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
      bundleDigest: request.bundleDigest, bundle, controllerReceiptDigest: THREE_DIGEST,
    }
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  const authorityFailure = (kind, request, code, retryable, extra = {}) => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind, digest: ZERO_DIGEST,
      requestId: request.requestId, requestDigest: request.requestDigest,
      challengeNonce: request.challengeNonce, namespace: request.namespace,
      controllerIdentity: 'controller.review-service', code, retryable,
      currentHeadDigest: head.digest, currentTimeRevision: '1', details: {}, ...extra,
    }
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  const bootstrap = {
    'review-service': {
      genesisBundleDigest: bundle.metadata.digest,
      controllerIdentity: 'controller.review-service',
    },
  }
  const malformed = createTrustVerifier({
    authority: {
      async readLineage() { return { kind: 'DshTrustLineageReadFailed', code: 'invented-code', retryable: true } },
      async readBundle() { throw new Error('must not read a bundle') },
    },
    bootstrap, nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  await assert.rejects(
    () => malformed.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
  const rawLineageFailure = (request, details) => ({
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadFailed', digest: ZERO_DIGEST,
    requestId: request.requestId, requestDigest: request.requestDigest,
    challengeNonce: request.challengeNonce, namespace: request.namespace,
    controllerIdentity: 'controller.review-service', code: 'lineage-unavailable', retryable: true,
    currentHeadDigest: head.digest, currentTimeRevision: '1', details,
  })
  const cyclicDetails = {}
  cyclicDetails.self = cyclicDetails
  let deepDetails = { leaf: true }
  for (let depth = 0; depth < 70; depth += 1) deepDetails = { nested: deepDetails }
  for (const details of [
    { data: 'x'.repeat(9 * 1024) },
    cyclicDetails,
    deepDetails,
  ]) {
    let bundleReads = 0
    const boundedFailure = createTrustVerifier({
      authority: {
        async readLineage(request) { return rawLineageFailure(request, details) },
        async readBundle() { bundleReads += 1; throw new Error('must not read a bundle') },
      },
      bootstrap, nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    })
    await assert.rejects(
      () => boundedFailure.readCurrent('review-service'),
      error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
    )
    assert.equal(bundleReads, 0)
  }
  const wrongCorrelation = createTrustVerifier({
    authority: {
      async readLineage(request) {
        return authorityFailure('DshTrustLineageReadFailed', request, 'lineage-unavailable', true, { requestId: 'another-request' })
      },
      async readBundle() { throw new Error('must not read a bundle') },
    },
    bootstrap, nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  await assert.rejects(
    () => wrongCorrelation.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid',
  )

  let lineageFailureDigest
  const lineageFailure = createTrustVerifier({
    authority: {
      async readLineage(request) {
        const response = authorityFailure('DshTrustLineageReadFailed', request, 'snapshot-unavailable', true)
        lineageFailureDigest = response.digest
        return response
      },
      async readBundle() { throw new Error('must not read a bundle') },
    },
    bootstrap, nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  await assert.rejects(
    () => lineageFailure.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'snapshot-unavailable'
      && error.details.digest === lineageFailureDigest,
  )

  let bundleFailureDigest
  const bundleFailure = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineageSuccess(request) },
      async readBundle(request) {
        const response = authorityFailure('DshTrustBundleReadFailed', request, 'bundle-not-found', false, {
          bundleDigest: request.bundleDigest, snapshotHeadDigest: request.snapshotHeadDigest,
        })
        bundleFailureDigest = response.digest
        return response
      },
    },
    bootstrap, nonce: () => 'AQEBAQEBAQEBAQEBAQEBAQ',
  })
  await assert.rejects(
    () => bundleFailure.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'bundle-not-found'
      && error.details.digest === bundleFailureDigest,
  )

  const resolved = composition()
  const lock = compositionLock(resolved)
  const instanceIdentity = identity()
  const seal = admissionSeal(resolved, lock, instanceIdentity, signing, bundle)
  const assertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'start', ONE_DIGEST)
  let acceptanceFailureDigest
  const acceptanceFailure = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineageSuccess(request) },
      async readBundle(request) { return bundleSuccess(request) },
      async accept(request) {
        const response = authorityFailure('DshTrustAcceptanceFailed', request, 'assertion-revoked', false, {
          acceptanceKind: request.acceptanceKind,
          signedDocumentDigest: request.signedDocumentDigest,
          semanticRequestDigest: request.semanticRequestDigest,
        })
        acceptanceFailureDigest = response.digest
        return response
      },
    },
    bootstrap, nonce: () => 'AgICAgICAgICAgICAgICAg',
  })
  await assert.rejects(
    () => acceptanceFailure.acceptSignedDocument({
      namespace: 'review-service', acceptanceKind: 'assertion', signedDocument: assertion,
      operation: 'instance.start', semanticRequestDigest: ONE_DIGEST,
      expectedEffectJournalRevision: '0',
    }),
    error => error instanceof RuntimeManagerError && error.code === 'assertion-revoked'
      && error.details.digest === acceptanceFailureDigest,
  )

  const lineageCodes = [
    'invalid-request', 'unauthenticated', 'unauthorized', 'namespace-not-found',
    'stale-expected-head', 'snapshot-unavailable', 'time-revision-conflict',
    'time-revision-exhausted', 'replayed-nonce', 'authority-clock-unavailable',
    'lineage-unavailable', 'lineage-invalid',
  ]
  const lineageRetryable = new Set([
    'stale-expected-head', 'snapshot-unavailable', 'time-revision-conflict',
    'authority-clock-unavailable', 'lineage-unavailable',
  ])
  for (const code of lineageCodes) {
    const verifier = createTrustVerifier({
      authority: {
        async readLineage(request) {
          return authorityFailure('DshTrustLineageReadFailed', request, code, lineageRetryable.has(code))
        },
        async readBundle() { throw new Error('must not read a bundle') },
      },
      bootstrap, nonce: () => 'AwMDAwMDAwMDAwMDAwMDAw',
    })
    await assert.rejects(
      () => verifier.readCurrent('review-service'),
      error => error instanceof RuntimeManagerError && error.code === code
        && error.details.retryable === lineageRetryable.has(code),
      `lineage failure ${code}`,
    )
  }

  const bundleCodes = [
    'invalid-request', 'unauthenticated', 'unauthorized', 'namespace-not-found',
    'snapshot-unavailable', 'bundle-not-found', 'bundle-unreachable',
    'replayed-nonce', 'lineage-unavailable', 'bundle-invalid',
  ]
  const bundleRetryable = new Set(['snapshot-unavailable', 'lineage-unavailable'])
  for (const code of bundleCodes) {
    const verifier = createTrustVerifier({
      authority: {
        async readLineage(request) { return lineageSuccess(request) },
        async readBundle(request) {
          return authorityFailure('DshTrustBundleReadFailed', request, code, bundleRetryable.has(code), {
            bundleDigest: request.bundleDigest, snapshotHeadDigest: request.snapshotHeadDigest,
          })
        },
      },
      bootstrap, nonce: () => 'BAQEBAQEBAQEBAQEBAQEBA',
    })
    await assert.rejects(
      () => verifier.readCurrent('review-service'),
      error => error instanceof RuntimeManagerError && error.code === code
        && error.details.retryable === bundleRetryable.has(code),
      `bundle failure ${code}`,
    )
  }

  const acceptanceCodes = Object.keys(TRUST_FAILURE_CODE_MAP)
  const acceptanceRetryable = new Set([
    'stale-expected-head', 'time-revision-conflict',
    'authority-clock-unavailable', 'authority-unavailable',
  ])
  for (const code of acceptanceCodes) {
    const verifier = createTrustVerifier({
      authority: {
        async readLineage(request) { return lineageSuccess(request) },
        async readBundle(request) { return bundleSuccess(request) },
        async accept(request) {
          return authorityFailure('DshTrustAcceptanceFailed', request, code, acceptanceRetryable.has(code), {
            acceptanceKind: request.acceptanceKind,
            signedDocumentDigest: request.signedDocumentDigest,
            semanticRequestDigest: request.semanticRequestDigest,
          })
        },
      },
      bootstrap, nonce: () => 'BQUFBQUFBQUFBQUFBQUFBQ',
    })
    await assert.rejects(
      () => verifier.acceptSignedDocument({
        namespace: 'review-service', acceptanceKind: 'assertion', signedDocument: assertion,
        operation: 'instance.start', semanticRequestDigest: ONE_DIGEST,
        expectedEffectJournalRevision: '0',
      }),
      error => error instanceof RuntimeManagerError && error.code === code
        && error.details.retryable === acceptanceRetryable.has(code),
      `acceptance failure ${code}`,
    )
  }

  const nullableFailure = createTrustVerifier({
    authority: {
      async readLineage() {
        const response = {
          apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadFailed',
          digest: ZERO_DIGEST, requestId: null, requestDigest: null,
          challengeNonce: null, namespace: null, controllerIdentity: null,
          code: 'unauthenticated', retryable: false, currentHeadDigest: null,
          currentTimeRevision: null, details: {},
        }
        response.digest = computeManagerDocumentDigest(response)
        return response
      },
      async readBundle() { throw new Error('must not read a bundle') },
    },
    bootstrap, nonce: () => 'BgYGBgYGBgYGBgYGBgYGBg',
  })
  await assert.rejects(
    () => nullableFailure.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'unauthenticated',
  )

  const nullFailureDocument = (kind, code, extra = {}) => {
    const response = {
      apiVersion: 'infra.serenvia.dev/v1', kind, digest: ZERO_DIGEST,
      requestId: null, requestDigest: null, challengeNonce: null,
      namespace: null, controllerIdentity: null, code, retryable: false,
      currentHeadDigest: null, currentTimeRevision: null, details: {}, ...extra,
    }
    response.digest = computeManagerDocumentDigest(response)
    return response
  }
  const nullSemanticLineage = createTrustVerifier({
    authority: {
      async readLineage() { return nullFailureDocument('DshTrustLineageReadFailed', 'lineage-invalid') },
      async readBundle() { throw new Error('must not read a bundle') },
    },
    bootstrap, nonce: () => 'BwcHBwcHBwcHBwcHBwcHBw',
  })
  await assert.rejects(
    () => nullSemanticLineage.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'lineage-invalid'
      && error.details.digest === undefined,
  )
  const nullSemanticBundle = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineageSuccess(request) },
      async readBundle() {
        return nullFailureDocument('DshTrustBundleReadFailed', 'bundle-not-found', {
          bundleDigest: null, snapshotHeadDigest: null,
        })
      },
    },
    bootstrap, nonce: () => 'CAgICAgICAgICAgICAgICA',
  })
  await assert.rejects(
    () => nullSemanticBundle.readCurrent('review-service'),
    error => error instanceof RuntimeManagerError && error.code === 'bundle-invalid',
  )
  const nullSemanticAcceptance = createTrustVerifier({
    authority: {
      async readLineage(request) { return lineageSuccess(request) },
      async readBundle(request) { return bundleSuccess(request) },
      async accept() {
        return nullFailureDocument('DshTrustAcceptanceFailed', 'assertion-revoked', {
          acceptanceKind: null, signedDocumentDigest: null, semanticRequestDigest: null,
        })
      },
    },
    bootstrap, nonce: () => 'CQkJCQkJCQkJCQkJCQkJCQ',
  })
  await assert.rejects(
    () => nullSemanticAcceptance.acceptSignedDocument({
      namespace: 'review-service', acceptanceKind: 'assertion', signedDocument: assertion,
      operation: 'instance.start', semanticRequestDigest: ONE_DIGEST,
      expectedEffectJournalRevision: '0',
    }),
    error => error instanceof RuntimeManagerError && error.code === 'trust-authority-unavailable',
  )
})

test('signed documents cannot select a digest-valid bundle outside the verified lineage', async () => {
  const trustedSigning = signingFixture()
  const untrustedSigning = signingFixture('untrusted')
  const trustedBundle = trustBundle(trustedSigning)
  const untrustedBundle = trustBundle(untrustedSigning, { bundleId: 'unreachable-bundle' })
  const head = {
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageHead', digest: ZERO_DIGEST,
    namespace: 'review-service', genesisBundleDigest: trustedBundle.metadata.digest,
    sequence: '0', bundleDigest: trustedBundle.metadata.digest,
    transitionDigest: null, casRevision: '0',
  }
  head.digest = computeManagerDocumentDigest(head)
  let acceptanceCalls = 0
  const verifier = createTrustVerifier({
    authority: {
      async readLineage(request) {
        const response = {
          apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustLineageReadSucceeded', digest: ZERO_DIGEST,
          requestId: request.requestId, requestDigest: request.requestDigest,
          challengeNonce: request.challengeNonce, namespace: request.namespace,
          controllerIdentity: 'controller.review-service', snapshotHead: head,
          snapshotHeadDigest: head.digest, currentHeadDigest: head.digest,
          snapshotAuthorityObservationDigest: ZERO_DIGEST, afterSequence: request.afterSequence,
          pageStartSequence: null, pageEndSequence: null, nextAfterSequence: null,
          complete: true, transitions: [], authorityTime: '2026-08-28T00:00:01Z',
          priorAuthorityTime: null, timeRevision: '1', priorTimeRevision: null,
          clockHealth: 'healthy', controllerReceiptDigest: TWO_DIGEST,
        }
        response.snapshotAuthorityObservationDigest = computeTrustAuthorityObservationDigest(response)
        response.digest = computeManagerDocumentDigest(response)
        return response
      },
      async readBundle(request) {
        const selected = request.bundleDigest === trustedBundle.metadata.digest
          ? trustedBundle : untrustedBundle
        const response = {
          apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleReadSucceeded', digest: ZERO_DIGEST,
          requestId: request.requestId, requestDigest: request.requestDigest,
          challengeNonce: request.challengeNonce, namespace: request.namespace,
          controllerIdentity: 'controller.review-service', snapshotHeadDigest: request.snapshotHeadDigest,
          snapshotAuthorityObservationDigest: request.snapshotAuthorityObservationDigest,
          bundleDigest: selected.metadata.digest, bundle: selected,
          controllerReceiptDigest: TWO_DIGEST,
        }
        response.digest = computeManagerDocumentDigest(response)
        return response
      },
      async accept() { acceptanceCalls += 1; throw new Error('must not accept') },
    },
    bootstrap: {
      'review-service': {
        genesisBundleDigest: trustedBundle.metadata.digest,
        controllerIdentity: 'controller.review-service',
      },
    },
    nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
  })
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const seal = admissionSeal(
    resolved, lockReceipt, instanceIdentity, untrustedSigning, untrustedBundle,
  )
  await assert.rejects(
    () => verifier.acceptSignedDocument({
      namespace: 'review-service', acceptanceKind: 'seal', signedDocument: seal,
      operation: 'instance.lock', semanticRequestDigest: ONE_DIGEST,
      expectedEffectJournalRevision: '0',
    }),
    error => error instanceof RuntimeManagerError && error.code === 'bundle-unreachable',
  )
  assert.equal(acceptanceCalls, 0)
})

test('trust authority failures have one exhaustive lifecycle and host mapping', () => {
  const expected = {
    'invalid-request': 'invalid-request', unauthenticated: 'trust-acceptance-unauthenticated',
    unauthorized: 'trust-acceptance-unauthorized', 'namespace-not-found': 'trust-namespace-not-found',
    'stale-expected-head': 'trust-head-stale', 'time-revision-conflict': 'time-revision-conflict',
    'time-revision-exhausted': 'time-revision-exhausted', 'bundle-unreachable': 'trust-bundle-unreachable',
    'signature-unsupported': 'signature-unsupported', 'signature-trust-unapproved': 'signature-trust-unapproved',
    'signature-key-unknown': 'signature-key-unknown', 'signature-key-revoked': 'signature-key-revoked',
    'signature-key-use-invalid': 'signature-key-use-invalid', 'signature-invalid': 'signature-invalid',
    'assertion-expired': 'assertion-expired', 'assertion-stale': 'assertion-stale',
    'assertion-revoked': 'assertion-revoked', 'acceptance-conflict': 'trust-acceptance-conflict',
    'replayed-nonce': 'trust-acceptance-replay', 'authority-clock-unavailable': 'trust-authority-clock-unavailable',
    'authority-unavailable': 'trust-authority-unavailable',
  }
  assert.deepEqual(TRUST_FAILURE_CODE_MAP, expected)
  for (const [source, target] of Object.entries(expected)) assert.equal(mapTrustAuthorityFailureCode(source), target)
})

test('mediated host failures bind authority-only denials and exact empty details', () => {
  const base = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'MediatedHostActionFailed',
    digest: ZERO_DIGEST, requestId: 'host-failure-contract', requestDigest: ONE_DIGEST,
    identity: identity(), pluginDescriptorDigest: TWO_DIGEST,
    pluginId: 'github-review', actionId: 'publish-review', idempotencyKey: 'host-failure-key',
    trustAcceptanceReceiptDigest: null, trustAcceptanceFailureDigest: THREE_DIGEST,
    observedState: 'Locked', publisherEpoch: '1', budgetDecision: 'denied',
    code: 'trust-acceptance-unauthorized', retryable: false, details: {},
  }
  base.digest = computeManagerDocumentDigest(base)
  assert.equal(validateMediatedHostActionResult(base), base)

  const missingDigest = { ...base, digest: ZERO_DIGEST, trustAcceptanceFailureDigest: null }
  missingDigest.digest = computeManagerDocumentDigest(missingDigest)
  assert.throws(
    () => validateMediatedHostActionResult(missingDigest),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )

  const unexpectedDetails = {
    ...base, digest: ZERO_DIGEST, code: 'action-denied',
    trustAcceptanceFailureDigest: null, details: { reason: 'implementation-private' },
  }
  unexpectedDetails.digest = computeManagerDocumentDigest(unexpectedDetails)
  assert.throws(
    () => validateMediatedHostActionResult(unexpectedDetails),
    error => error instanceof RuntimeManagerError && error.code === 'unknown-field',
  )
})

test('mediated host request documents enforce the shared one-mebibyte bound', () => {
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'MediatedHostActionRequest',
    requestId: 'host-bounded-request', identity: structuredClone(instanceIdentity),
    pluginDescriptorDigest: TWO_DIGEST, pluginId: 'github-review', actionId: 'publish-review',
    actionClass: 'provider-write', inputSchemaDigest: ONE_DIGEST,
    outputSchemaDigest: THREE_DIGEST, payload: { reviewDigest: ONE_DIGEST },
    targetScopeDigest: TWO_DIGEST, budgetDebit: { 'provider-writes': '1' },
    expectedState: 'Locked', publisherEpoch: '1', actionNonce: 'bounded-action',
    idempotencyKey: 'bounded-action-key', requestDigest: ZERO_DIGEST,
    runtimeAssertion: null, runtimeAssertionDigest: null,
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', request.requestDigest,
  )
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  assert.equal(validateMediatedHostActionRequest(request), request)

  const oversized = structuredClone(request)
  oversized.payload = { data: 'x'.repeat(MANAGER_CONTROL_MAX_DATAGRAM_BYTES) }
  oversized.requestDigest = computeSemanticRequestDigest(oversized)
  oversized.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', oversized.requestDigest,
    { nonce: 'AQEBAQEBAQEBAQEBAQEBAQ' },
  )
  oversized.runtimeAssertionDigest = oversized.runtimeAssertion.metadata.digest
  assert.throws(
    () => validateMediatedHostActionRequest(oversized),
    error => error instanceof RuntimeManagerError && error.code === 'schema-invalid',
  )
})

test('mediated GitHub effects require broker routing and bind one-use acceptance to every semantic field', async () => {
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
  const lockRequest = baseLockRequest(resolved, lockReceipt, instanceIdentity, seal)
  lockRequest.requestDigest = computeSemanticRequestDigest(lockRequest)
  lockRequest.runtimeAssertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'lock', lockRequest.requestDigest)
  lockRequest.runtimeAssertionDigest = lockRequest.runtimeAssertion.metadata.digest
  const store = createMemoryRuntimeStore()
  const trustVerifier = acceptingTrustVerifier()
  assert.throws(
    () => createMediatedHostService({
      store: { instances: new Map() }, trustVerifier,
      authorize: async () => ({ allowed: false, admissionSealDigest: ZERO_DIGEST }),
    }),
    error => error instanceof RuntimeManagerError && error.code === 'invalid-request',
  )
  const manager = createWorkloadManager({
    store, trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }), effects: {},
  })
  await manager.lock(lockRequest)

  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'MediatedHostActionRequest',
    requestId: 'host-action-1', identity: structuredClone(instanceIdentity),
    pluginDescriptorDigest: TWO_DIGEST, pluginId: 'github-review', actionId: 'publish-review',
    actionClass: 'provider-write', inputSchemaDigest: ONE_DIGEST,
    outputSchemaDigest: THREE_DIGEST, payload: { reviewDigest: ONE_DIGEST },
    targetScopeDigest: TWO_DIGEST, budgetDebit: { 'provider-writes': '1' },
    expectedState: 'Locked', publisherEpoch: '1', actionNonce: 'action-1',
    idempotencyKey: 'host-action-key-1', requestDigest: ZERO_DIGEST,
    runtimeAssertion: null, runtimeAssertionDigest: null,
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'host.action', request.requestDigest)
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  let guardAuthorizations = 0
  let guardBrokerCalls = 0
  const identityGuard = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => {
      guardAuthorizations += 1
      return { allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }
    },
    broker: async (_request, context) => {
      guardBrokerCalls += 1
      return {
        status: 'succeeded', outputPayload: { published: true },
        brokerReceipt: { digest: ONE_DIGEST, idempotencyToken: context.externalIdempotencyToken },
      }
    },
  })
  const storedInstance = store.instances.get(instanceIdentity.namespace)
  const storedIdentity = storedInstance.identity
  const trustCallsBeforeGuard = trustVerifier.calls.length
  storedInstance.identity = identity({ instanceId: 'stored-host-substitute' })
  const freshIdentityDenial = await identityGuard.execute(request)
  assert.equal(freshIdentityDenial.code, 'state-conflict')
  assert.equal(freshIdentityDenial.observedState, null)
  assert.equal(guardAuthorizations, 0)
  assert.equal(guardBrokerCalls, 0)
  assert.equal(trustVerifier.calls.length, trustCallsBeforeGuard)
  storedInstance.identity = storedIdentity
  assert.equal((await identityGuard.execute(request)).kind, 'MediatedHostActionSucceeded')
  assert.equal(guardAuthorizations, 1)
  assert.equal(guardBrokerCalls, 1)
  storedInstance.identity = identity({ instanceId: 'stored-host-replay-substitute' })
  const replayIdentityDenial = await identityGuard.execute({ ...request, requestId: 'host-identity-replay' })
  assert.equal(replayIdentityDenial.code, 'state-conflict')
  assert.equal(guardAuthorizations, 1)
  assert.equal(guardBrokerCalls, 1)
  storedInstance.identity = storedIdentity
  const callsBefore = trustVerifier.calls.length
  const unrouted = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }),
  })
  const denied = await unrouted.execute(request)
  assert.equal(denied.code, 'broker-route-required')
  assert.equal(trustVerifier.calls.length, callsBefore)

  let brokerCalls = 0
  const routed = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }),
    broker: async (_request, context) => {
      brokerCalls += 1
      return {
        status: 'succeeded', outputPayload: { published: true },
        brokerReceipt: { digest: ONE_DIGEST, idempotencyToken: context.externalIdempotencyToken },
      }
    },
  })
  const published = await routed.execute(request)
  assert.equal(published.kind, 'MediatedHostActionSucceeded')
  assert.equal(validateMediatedHostActionResult(published), published)
  assert.equal(brokerCalls, 1)
  assert.equal((await routed.execute({ ...request, requestId: 'host-action-replay' })).digest, published.digest)
  assert.equal(brokerCalls, 1)

  let oversizedBrokerCalls = 0
  const oversizedOutput = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }),
    broker: async (_request, context) => {
      oversizedBrokerCalls += 1
      return {
        status: 'succeeded', outputPayload: { data: 'x'.repeat(MANAGER_CONTROL_MAX_DATAGRAM_BYTES) },
        brokerReceipt: { digest: TWO_DIGEST, idempotencyToken: context.externalIdempotencyToken },
      }
    },
  })
  const oversizedRequest = structuredClone(request)
  oversizedRequest.requestId = 'host-action-oversized-output'
  oversizedRequest.idempotencyKey = 'host-action-oversized-output'
  oversizedRequest.requestDigest = computeSemanticRequestDigest(oversizedRequest)
  oversizedRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', oversizedRequest.requestDigest,
    { nonce: 'AgICAgICAgICAgICAgICAg', revocationId: 'host-action-oversized-output' },
  )
  oversizedRequest.runtimeAssertionDigest = oversizedRequest.runtimeAssertion.metadata.digest
  const oversized = await oversizedOutput.execute(oversizedRequest)
  assert.equal(oversized.kind, 'MediatedHostActionIndeterminate')
  assert.equal(oversized.budgetDecision, 'reserved')
  assert.equal(oversized.mandatoryRecovery.reconcileSameToken, true)
  assert.equal(validateMediatedHostActionResult(oversized), oversized)
  assert.equal((await oversizedOutput.execute({ ...oversizedRequest, requestId: 'host-action-oversized-replay' })).digest, oversized.digest)
  assert.equal(oversizedBrokerCalls, 1)

  let malformedDirectCalls = 0
  const malformedDirect = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'host' }),
    effect: async (_request, context) => {
      malformedDirectCalls += 1
      return {
        status: 'succeeded', outputPayload: { written: true },
        externalEffectReceipt: {
          digest: TWO_DIGEST, idempotencyToken: context.externalIdempotencyToken,
          credential: 'must-not-cross',
        },
      }
    },
  })
  const malformedDirectRequest = structuredClone(request)
  malformedDirectRequest.requestId = 'host-action-malformed-direct-receipt'
  malformedDirectRequest.idempotencyKey = 'host-action-malformed-direct-receipt'
  malformedDirectRequest.actionClass = 'filesystem-write'
  malformedDirectRequest.publisherEpoch = null
  malformedDirectRequest.requestDigest = computeSemanticRequestDigest(malformedDirectRequest)
  malformedDirectRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', malformedDirectRequest.requestDigest,
    { nonce: 'AwMDAwMDAwMDAwMDAwMDAw', revocationId: 'host-action-malformed-direct-receipt' },
  )
  malformedDirectRequest.runtimeAssertionDigest = malformedDirectRequest.runtimeAssertion.metadata.digest
  const malformedDirectResult = await malformedDirect.execute(malformedDirectRequest)
  assert.equal(malformedDirectResult.kind, 'MediatedHostActionIndeterminate')
  assert.equal(malformedDirectResult.mandatoryRecovery.retryBeforeReconcile, false)
  assert.equal((await malformedDirect.execute({
    ...malformedDirectRequest, requestId: 'host-action-malformed-direct-replay',
  })).digest, malformedDirectResult.digest)
  assert.equal(malformedDirectCalls, 1)

  let wrongDirectCalls = 0
  const wrongDirect = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'host' }),
    effect: async () => {
      wrongDirectCalls += 1
      return {
        status: 'succeeded', outputPayload: { written: true },
        externalEffectReceipt: { digest: TWO_DIGEST, idempotencyToken: ONE_DIGEST },
      }
    },
  })
  const wrongDirectRequest = structuredClone(malformedDirectRequest)
  wrongDirectRequest.requestId = 'host-action-wrong-direct-token'
  wrongDirectRequest.idempotencyKey = 'host-action-wrong-direct-token'
  wrongDirectRequest.requestDigest = computeSemanticRequestDigest(wrongDirectRequest)
  wrongDirectRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', wrongDirectRequest.requestDigest,
    { nonce: 'BAQEBAQEBAQEBAQEBAQEBA', revocationId: 'host-action-wrong-direct-token' },
  )
  wrongDirectRequest.runtimeAssertionDigest = wrongDirectRequest.runtimeAssertion.metadata.digest
  const wrongDirectResult = await wrongDirect.execute(wrongDirectRequest)
  assert.equal(wrongDirectResult.kind, 'MediatedHostActionIndeterminate')
  assert.equal(wrongDirectResult.mandatoryRecovery.retryBeforeReconcile, false)
  assert.equal((await wrongDirect.execute({
    ...wrongDirectRequest, requestId: 'host-action-wrong-direct-token-replay',
  })).digest, wrongDirectResult.digest)
  assert.equal(wrongDirectCalls, 1)

  const changed = structuredClone(request)
  changed.requestId = 'host-action-changed'
  changed.targetScopeDigest = THREE_DIGEST
  changed.requestDigest = computeSemanticRequestDigest(changed)
  const conflict = await routed.execute(changed)
  assert.equal(conflict.code, 'idempotency-conflict')
  assert.equal(brokerCalls, 1)

  const reused = structuredClone(request)
  reused.requestId = 'host-action-reused-assertion'
  reused.idempotencyKey = 'host-action-key-2'
  reused.actionId = 'publish-another-review'
  reused.requestDigest = computeSemanticRequestDigest(reused)
  const assertionDenied = await routed.execute(reused)
  assert.equal(assertionDenied.code, 'assertion-invalid')
  assert.equal(brokerCalls, 1)

  for (const [field, mutate] of [
    ['plugin', candidate => { candidate.pluginId = 'another-plugin' }],
    ['descriptor', candidate => { candidate.pluginDescriptorDigest = THREE_DIGEST }],
    ['target', candidate => { candidate.targetScopeDigest = THREE_DIGEST }],
    ['resource', candidate => { candidate.actionClass = 'network-connect' }],
    ['payload', candidate => { candidate.payload = { reviewDigest: THREE_DIGEST } }],
    ['budget', candidate => { candidate.budgetDebit = { 'provider-writes': '2' } }],
    ['state', candidate => { candidate.expectedState = 'Running' }],
    ['epoch', candidate => { candidate.publisherEpoch = '2' }],
  ]) {
    const candidate = structuredClone(request)
    candidate.requestId = `host-action-substitute-${field}`
    candidate.idempotencyKey = `host-action-substitute-${field}`
    mutate(candidate)
    candidate.requestDigest = computeSemanticRequestDigest(candidate)
    const result = await routed.execute(candidate)
    assert.notEqual(result.kind, 'MediatedHostActionSucceeded', field)
  }
  assert.equal(brokerCalls, 1)

  const substitutedReceipt = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }),
    broker: async () => ({
      status: 'succeeded', outputPayload: { published: true },
      brokerReceipt: { digest: ONE_DIGEST, idempotencyToken: 'wrong-effect-token' },
    }),
  })
  const separate = structuredClone(request)
  separate.requestId = 'host-action-cross-effect'
  separate.idempotencyKey = 'host-action-cross-effect'
  separate.requestDigest = computeSemanticRequestDigest(separate)
  separate.runtimeAssertion = runtimeAssertion(seal, instanceIdentity, signing, bundle, 'host.action', separate.requestDigest)
  separate.runtimeAssertionDigest = separate.runtimeAssertion.metadata.digest
  const crossEffect = await substitutedReceipt.execute(separate)
  assert.equal(crossEffect.kind, 'MediatedHostActionIndeterminate')
  assert.equal(crossEffect.mandatoryRecovery.retryBeforeReconcile, false)
  assert.equal((await substitutedReceipt.execute({ ...separate, requestId: 'host-action-cross-effect-replay' })).digest, crossEffect.digest)
})

test('mediated host serializes same-key writes and rejects receipt overexposure', async () => {
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, bundle)
  const lockRequest = baseLockRequest(resolved, lockReceipt, instanceIdentity, seal)
  lockRequest.requestDigest = computeSemanticRequestDigest(lockRequest)
  lockRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'lock', lockRequest.requestDigest,
  )
  lockRequest.runtimeAssertionDigest = lockRequest.runtimeAssertion.metadata.digest
  const store = createMemoryRuntimeStore()
  const trustVerifier = acceptingTrustVerifier()
  let drainRelease
  let drainStartedRelease
  const drainGate = new Promise(resolve => { drainRelease = resolve })
  const drainStarted = new Promise(resolve => { drainStartedRelease = resolve })
  const manager = createWorkloadManager({
    store, trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: {
      start: async () => ({ status: 'succeeded', sessionIdentity: 'session-1' }),
      drain: async () => {
        drainStartedRelease()
        await drainGate
        return { status: 'succeeded', effectSummaryDigest: THREE_DIGEST }
      },
    },
  })
  await manager.lock(lockRequest)
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'MediatedHostActionRequest',
    requestId: 'host-concurrent-1', identity: structuredClone(instanceIdentity),
    pluginDescriptorDigest: TWO_DIGEST, pluginId: 'github-review', actionId: 'publish-review',
    actionClass: 'provider-write', inputSchemaDigest: ONE_DIGEST,
    outputSchemaDigest: THREE_DIGEST, payload: { reviewDigest: ONE_DIGEST },
    targetScopeDigest: TWO_DIGEST, budgetDebit: { 'provider-writes': '1' },
    expectedState: 'Locked', publisherEpoch: '1', actionNonce: 'action-concurrent-1',
    idempotencyKey: 'host-concurrent-key', requestDigest: ZERO_DIGEST,
    runtimeAssertion: null, runtimeAssertionDigest: null,
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', request.requestDigest,
  )
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  let directEffects = 0
  const missingRoute = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({ allowed: true, admissionSealDigest: seal.metadata.digest }),
    effect: async () => { directEffects += 1; return { status: 'succeeded' } },
  })
  const missingRouteRequest = structuredClone(request)
  missingRouteRequest.requestId = 'host-missing-route'
  missingRouteRequest.idempotencyKey = 'host-missing-route'
  missingRouteRequest.requestDigest = computeSemanticRequestDigest(missingRouteRequest)
  missingRouteRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', missingRouteRequest.requestDigest,
    { nonce: 'BwcHBwcHBwcHBwcHBwcHBw' },
  )
  missingRouteRequest.runtimeAssertionDigest = missingRouteRequest.runtimeAssertion.metadata.digest
  const missingRouteResult = await missingRoute.execute(missingRouteRequest)
  assert.equal(missingRouteResult.code, 'broker-route-required')
  assert.equal(directEffects, 0)
  let authorizeRelease
  const authorizeGate = new Promise(resolve => { authorizeRelease = resolve })
  let authorizeCalls = 0
  let brokerCalls = 0
  const service = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => {
      authorizeCalls += 1
      await authorizeGate
      return { allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker' }
    },
    broker: async (_input, context) => {
      brokerCalls += 1
      return {
        status: 'succeeded', outputPayload: { published: true },
        brokerReceipt: {
          digest: ONE_DIGEST, idempotencyToken: context.externalIdempotencyToken,
        },
      }
    },
  })
  const first = service.execute(request)
  const second = service.execute({ ...request, requestId: 'host-concurrent-2' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(authorizeCalls, 1)
  authorizeRelease()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.digest, secondResult.digest)
  assert.equal(authorizeCalls, 1)
  assert.equal(brokerCalls, 1)

  const leaking = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({
      allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker',
    }),
    broker: async (_input, context) => ({
      status: 'succeeded', outputPayload: { published: true },
      brokerReceipt: {
        digest: TWO_DIGEST, idempotencyToken: context.externalIdempotencyToken,
        authorization: 'Bearer private-provider-material',
      },
    }),
  })
  const leakRequest = structuredClone(request)
  leakRequest.requestId = 'host-receipt-leak'
  leakRequest.idempotencyKey = 'host-receipt-leak'
  leakRequest.requestDigest = computeSemanticRequestDigest(leakRequest)
  leakRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', leakRequest.requestDigest,
    { nonce: 'AQEBAQEBAQEBAQEBAQEBAQ' },
  )
  leakRequest.runtimeAssertionDigest = leakRequest.runtimeAssertion.metadata.digest
  const leak = await leaking.execute(leakRequest)
  assert.equal(leak.kind, 'MediatedHostActionIndeterminate')
  assert.equal(leak.mandatoryRecovery.retryBeforeReconcile, false)
  assert.equal(leaking.journal.values().next().value.result.kind, 'MediatedHostActionIndeterminate')
  const malformed = await leaking.execute(null)
  assert.equal(validateMediatedHostActionResult(malformed), malformed)
  const malformedFields = await leaking.execute({
    requestId: {}, requestDigest: 'not-a-digest', identity: { token: 'must-not-echo' },
    pluginDescriptorDigest: 'not-a-digest', pluginId: {}, actionId: [],
    idempotencyKey: { value: 'bad' }, publisherEpoch: '-1',
  })
  assert.equal(validateMediatedHostActionResult(malformedFields), malformedFields)
  assert.equal(malformedFields.requestId, null)
  assert.equal(JSON.stringify(malformedFields).includes('must-not-echo'), false)

  const start = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest',
    requestId: 'host-race-start', idempotencyKey: 'host-race-start',
    requestDigest: ZERO_DIGEST, identity: structuredClone(instanceIdentity),
    priorReceiptDigest: store.instances.get(instanceIdentity.namespace).receiptHead,
    admissionSealDigest: seal.metadata.digest, runtimeAssertion: null,
    runtimeAssertionDigest: null, expectedState: 'Locked',
  }
  start.requestDigest = computeSemanticRequestDigest(start)
  start.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'start', start.requestDigest,
    { nonce: 'AwMDAwMDAwMDAwMDAwMDAw' },
  )
  start.runtimeAssertionDigest = start.runtimeAssertion.metadata.digest
  const running = await manager.start(start)
  assert.equal(running.observedState, 'Running')
  const drain = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'DrainInstanceRequest',
    requestId: 'host-race-drain', idempotencyKey: 'host-race-drain',
    requestDigest: ZERO_DIGEST, identity: structuredClone(instanceIdentity),
    expectedState: 'Running', triggerFenceDigest: ONE_DIGEST,
    publisherEpoch: '1', deadlinePolicyDigest: TWO_DIGEST,
  }
  drain.requestDigest = computeSemanticRequestDigest(drain)
  const draining = manager.drain(drain)
  await drainStarted
  let staleBrokerCalls = 0
  const staleService = createMediatedHostService({
    store, trustVerifier,
    authorize: async () => ({
      allowed: true, admissionSealDigest: seal.metadata.digest, route: 'github-broker',
    }),
    broker: async (_input, context) => {
      staleBrokerCalls += 1
      return {
        status: 'succeeded', outputPayload: { published: true },
        brokerReceipt: { digest: ONE_DIGEST, idempotencyToken: context.externalIdempotencyToken },
      }
    },
  })
  const staleRequest = structuredClone(request)
  staleRequest.requestId = 'host-race-action'
  staleRequest.idempotencyKey = 'host-race-action'
  staleRequest.expectedState = 'Running'
  staleRequest.requestDigest = computeSemanticRequestDigest(staleRequest)
  staleRequest.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, bundle, 'host.action', staleRequest.requestDigest,
    { nonce: 'BAQEBAQEBAQEBAQEBAQEBA' },
  )
  staleRequest.runtimeAssertionDigest = staleRequest.runtimeAssertion.metadata.digest
  const staleAction = staleService.execute(staleRequest)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(staleBrokerCalls, 0)
  drainRelease()
  assert.equal((await draining).observedState, 'Drained')
  const staleResult = await staleAction
  assert.equal(staleResult.code, 'state-conflict')
  assert.equal(staleResult.observedState, 'Drained')
  assert.equal(staleBrokerCalls, 0)
})

test('manager fixture signing is deterministic so no signature can trip the secret guard', () => {
  const signing = signingFixture()
  assert.equal(signingFixture().publicKeyHex, signing.publicKeyHex)
  assert.notEqual(signingFixture('untrusted').publicKeyHex, signing.publicKeyHex)

  const prior = trustBundle(signing)
  const next = trustBundle(signing, { bundleId: 'bundle-2' })
  const transition = trustTransition(prior, next, signing, 1, [])
  assert.equal(trustTransition(prior, next, signing, 1, []).signature, transition.signature)

  // A fixture signature is the value that used to reach assertSecretFree by
  // chance: a random base64url signature can contain an `sk-` run about once in
  // 75,000 signatures. The accepting assertion below is what pins this, because
  // validateMediatedHostActionRequest runs the real guard over the fixture
  // signature in `runtimeAssertion.signature` — the exact field that flaked. It
  // cannot drift from the production pattern list the way a copy of it here
  // would.
  const resolved = composition()
  const lockReceipt = compositionLock(resolved)
  const instanceIdentity = identity()
  const seal = admissionSeal(resolved, lockReceipt, instanceIdentity, signing, prior)
  const request = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'MediatedHostActionRequest',
    requestId: 'host-secret-guard-request', identity: structuredClone(instanceIdentity),
    pluginDescriptorDigest: TWO_DIGEST, pluginId: 'github-review', actionId: 'publish-review',
    actionClass: 'provider-write', inputSchemaDigest: ONE_DIGEST,
    outputSchemaDigest: THREE_DIGEST, payload: { reviewDigest: ONE_DIGEST },
    targetScopeDigest: TWO_DIGEST, budgetDebit: { 'provider-writes': '1' },
    expectedState: 'Locked', publisherEpoch: '1', actionNonce: 'secret-guard-action',
    idempotencyKey: 'secret-guard-action-key', requestDigest: ZERO_DIGEST,
    runtimeAssertion: null, runtimeAssertionDigest: null,
  }
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(
    seal, instanceIdentity, signing, prior, 'host.action', request.requestDigest,
  )
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  assert.equal(validateMediatedHostActionRequest(request), request)

  const leaked = structuredClone(request)
  leaked.runtimeAssertion.signature = `sk-${'livesyntheticfixture'}`
  assert.throws(
    () => validateMediatedHostActionRequest(leaked),
    error => error instanceof RuntimeManagerError && error.code === 'secret-shaped-value',
  )
})
