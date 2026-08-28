import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RuntimeManagerError,
  computeSemanticRequestDigest,
  createMemoryRuntimeStore,
  createWorkloadManager,
  validateAdmissionSeal,
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

function fixture(scopeClass = 'non-project') {
  const resolved = composition(scopeClass)
  const lock = compositionLock(resolved)
  const instanceIdentity = identity()
  const signing = signingFixture()
  const bundle = trustBundle(signing)
  const seal = admissionSeal(resolved, lock, instanceIdentity, signing, bundle)
  const request = baseLockRequest(resolved, lock, instanceIdentity, seal)
  request.requestDigest = computeSemanticRequestDigest(request)
  request.runtimeAssertion = runtimeAssertion(
    seal,
    instanceIdentity,
    signing,
    bundle,
    'lock',
    request.requestDigest,
  )
  request.runtimeAssertionDigest = request.runtimeAssertion.metadata.digest
  return { resolved, lock, instanceIdentity, signing, bundle, seal, request }
}

test('non-project admission needs no dummy repository and rejects inherited coding authority', async () => {
  const input = fixture('non-project')
  const trustVerifier = acceptingTrustVerifier()
  const manager = createWorkloadManager({
    store: createMemoryRuntimeStore(),
    trustVerifier,
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: {},
  })
  const result = await manager.lock(input.request)
  assert.equal(result.kind, 'LockInstanceSucceeded')
  assert.equal(result.receipt.identity.namespace, input.instanceIdentity.namespace)
  assert.equal(JSON.stringify(result).includes('repository'), false)

  const widened = structuredClone(input.seal)
  widened.effectiveAuthority.capabilities.push('coding.write')
  assert.throws(
    () => validateAdmissionSeal(widened, {
      composition: input.resolved,
      compositionLockReceipt: input.lock,
      identity: input.instanceIdentity,
    }),
    error => error instanceof RuntimeManagerError && error.code === 'authority-widening',
  )
})

test('required health blocks admission and optional health degrades only its dependents', async () => {
  const blocked = fixture()
  const blockedVerifier = acceptingTrustVerifier()
  const blockedManager = createWorkloadManager({
    store: createMemoryRuntimeStore(),
    trustVerifier: blockedVerifier,
    health: async probe => probe.endsWith('.ready')
      ? { state: 'blocked', code: 'DOWN' }
      : { state: 'degraded', code: 'LATE' },
    effects: {},
  })
  const locked = await blockedManager.lock(blocked.request)
  assert.equal(locked.kind, 'LockInstanceSucceeded')
  const startRequest = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StartInstanceRequest',
    requestId: 'health-start', idempotencyKey: 'health-start',
    requestDigest: '', identity: structuredClone(blocked.instanceIdentity),
    priorReceiptDigest: locked.receipt.digest,
    admissionSealDigest: blocked.seal.metadata.digest,
    runtimeAssertion: null, runtimeAssertionDigest: null, expectedState: 'Locked',
  }
  startRequest.requestDigest = computeSemanticRequestDigest(startRequest)
  startRequest.runtimeAssertion = runtimeAssertion(
    blocked.seal, blocked.instanceIdentity, blocked.signing, blocked.bundle,
    'start', startRequest.requestDigest,
  )
  startRequest.runtimeAssertionDigest = startRequest.runtimeAssertion.metadata.digest
  const denied = await blockedManager.start(startRequest)
  assert.equal(denied.kind, 'StartInstanceFailed')
  assert.equal(denied.code, 'required-health-failed')
  assert.equal(blockedVerifier.calls.length, 3)

  const degraded = fixture()
  const manager = createWorkloadManager({
    store: createMemoryRuntimeStore(),
    trustVerifier: acceptingTrustVerifier(),
    health: async probe => probe.endsWith('.metrics')
      ? { state: 'degraded', code: 'LATE' }
      : { state: 'ready', code: 'READY' },
    effects: {},
  })
  const admitted = await manager.lock(degraded.request)
  assert.equal(admitted.kind, 'LockInstanceSucceeded')
  const status = await manager.status({
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'StatusInstanceRequest',
    requestId: 'degraded-status', identity: degraded.instanceIdentity,
    receiptChainHead: admitted.receipt.digest,
  })
  assert.deepEqual(status.health.optional, ['github-review.metrics'])
})

test('namespace ownership is exclusive and bounded projections cannot bleed instance state', async () => {
  const first = fixture()
  const second = fixture()
  second.request.requestId = 'request-lock-2'
  second.request.idempotencyKey = 'lock-key-2'
  second.request.requestDigest = computeSemanticRequestDigest(second.request)

  const store = createMemoryRuntimeStore()
  const manager = createWorkloadManager({
    store,
    trustVerifier: acceptingTrustVerifier(),
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: {},
  })
  assert.equal((await manager.lock(first.request)).kind, 'LockInstanceSucceeded')
  const collision = await manager.lock(second.request)
  assert.equal(collision.kind, 'LockInstanceFailed')
  assert.equal(collision.code, 'state-conflict')
  assert.equal(JSON.stringify(store.instances.get(first.instanceIdentity.namespace)).includes('bindingDigest'), false)
  const projection = await manager.status({
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'StatusInstanceRequest',
    requestId: 'status-1',
    identity: first.instanceIdentity,
    receiptChainHead: null,
  })
  assert.deepEqual(Object.keys(projection).sort(), [
    'apiVersion', 'health', 'identity', 'kind', 'observedState', 'receiptChainHead',
    'requestId', 'resources', 'sessionIdentity',
  ])
})

test('instance receipts are secret-free non-bearer evidence', async () => {
  const input = fixture()
  const manager = createWorkloadManager({
    store: createMemoryRuntimeStore(),
    trustVerifier: acceptingTrustVerifier(),
    health: async () => ({ state: 'ready', code: 'READY' }),
    effects: {},
  })
  const result = await manager.lock(input.request)
  const serialized = JSON.stringify(result.receipt)
  for (const forbidden of ['token', 'secret', 'password', 'privateKey', 'bindingDigest']) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
})
