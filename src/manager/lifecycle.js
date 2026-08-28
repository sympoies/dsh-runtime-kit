// @ts-check

import {
  RUNTIME_MANAGER_API_VERSION,
  RuntimeManagerError,
  assertSecretFree,
  computeManagerDocumentDigest,
  computeSemanticRequestDigest,
  digest,
  exactKeys,
  fail,
  identity as validateIdentity,
  isManagerFailureCode,
  mapTrustAuthorityFailureCode,
  plainRecord,
  requiresTrustAcceptanceFailureDigest,
  text,
  uint64,
  validateAdmissionSeal,
  validateManagerPayload,
  validateRuntimeReceipt,
  validateRuntimeAssertion,
} from './contracts.js'
import {
  validateCompositionLockReceipt,
  validateResolvedComposition,
} from '../composition/index.js'

export const LIFECYCLE_TRANSITIONS = Object.freeze({
  lock: Object.freeze({ sources: Object.freeze(['Absent']), transient: null, terminal: 'Locked' }),
  start: Object.freeze({ sources: Object.freeze(['Locked']), transient: 'Starting', terminal: 'Running' }),
  resume: Object.freeze({ sources: Object.freeze(['Interrupted', 'Stopped']), transient: 'Starting', terminal: 'Running' }),
  interrupt: Object.freeze({ sources: Object.freeze(['Running']), transient: 'Interrupting', terminal: 'Interrupted' }),
  drain: Object.freeze({ sources: Object.freeze(['Running', 'Interrupted']), transient: 'Draining', terminal: 'Drained' }),
  stop: Object.freeze({ sources: Object.freeze(['Drained']), transient: 'Stopping', terminal: 'Stopped' }),
})

export const RECONCILIATION_MATRIX = Object.freeze({
  lock: Object.freeze({ sources: Object.freeze(['Absent']), transient: null, terminal: 'Locked', candidates: Object.freeze(['Absent', 'Locked']) }),
  start: Object.freeze({ sources: Object.freeze(['Locked']), transient: 'Starting', terminal: 'Running', candidates: Object.freeze(['Locked', 'Starting', 'Running']) }),
  resume: Object.freeze({ sources: Object.freeze(['Interrupted', 'Stopped']), transient: 'Starting', terminal: 'Running', candidates: Object.freeze(['Interrupted', 'Stopped', 'Starting', 'Running']) }),
  interrupt: Object.freeze({ sources: Object.freeze(['Running']), transient: 'Interrupting', terminal: 'Interrupted', candidates: Object.freeze(['Running', 'Interrupting', 'Interrupted']) }),
  drain: Object.freeze({ sources: Object.freeze(['Running', 'Interrupted']), transient: 'Draining', terminal: 'Drained', candidates: Object.freeze(['Running', 'Interrupted', 'Draining', 'Drained']) }),
  stop: Object.freeze({ sources: Object.freeze(['Drained']), transient: 'Stopping', terminal: 'Stopped', candidates: Object.freeze(['Drained', 'Stopping', 'Stopped']) }),
})

const MUTATION_KINDS = Object.freeze({
  lock: 'LockInstanceRequest', start: 'StartInstanceRequest', resume: 'ResumeInstanceRequest',
  interrupt: 'InterruptInstanceRequest', drain: 'DrainInstanceRequest', stop: 'StopInstanceRequest',
})
const RECEIPT_KINDS = Object.freeze({
  lock: 'InstanceLockReceipt', start: 'InstanceStartReceipt', resume: 'InstanceResumeReceipt',
  interrupt: 'InstanceInterruptReceipt', drain: 'InstanceDrainReceipt', stop: 'InstanceStopReceipt',
})
const TRANSIENT_RECEIPT_SOURCES = Object.freeze({
  Starting: Object.freeze(['Locked', 'Interrupted', 'Stopped']),
  Interrupting: Object.freeze(['Running']),
  Draining: Object.freeze(['Running', 'Interrupted']),
  Stopping: Object.freeze(['Drained']),
})

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Publicly constructible in-memory store. Production adapters may persist the same maps transactionally. */
export function createMemoryRuntimeStore() {
  return {
    instances: new Map(),
    namespaces: new Map(),
    journals: new Map(),
    reconciliations: new Map(),
    receipts: new Map(),
    mutationLocks: new Map(),
  }
}

/** @param {Record<string, any>} request */
function journalIdentity(request) {
  return `${request.kind}\0${request.identity.namespace}\0${request.idempotencyKey}`
}

/** @param {Record<string, any>} request @param {'lock'|'start'|'resume'|'interrupt'|'drain'|'stop'} operation */
function validateCommonMutation(request, operation) {
  if (request.apiVersion !== RUNTIME_MANAGER_API_VERSION || request.kind !== MUTATION_KINDS[operation]) fail('invalid-request', 'lifecycle request identity is invalid')
  text(request.requestId, `${request.kind}.requestId`, 256)
  text(request.idempotencyKey, `${request.kind}.idempotencyKey`, 256)
  digest(request.requestDigest, `${request.kind}.requestDigest`)
  validateIdentity(request.identity)
  if (computeSemanticRequestDigest(request) !== request.requestDigest) fail('invalid-request', 'lifecycle request digest is invalid')
  return request
}

/** @param {unknown} value */
function validateLockRequest(value) {
  const request = plainRecord(value, 'LockInstanceRequest')
  exactKeys(request, [
    'apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest',
    'identity', 'resolvedComposition', 'resolvedCompositionDigest',
    'compositionLockReceipt', 'admissionSeal', 'admissionSealDigest',
    'runtimeAssertion', 'runtimeAssertionDigest', 'expectedState',
  ], [], 'LockInstanceRequest')
  validateCommonMutation(request, 'lock')
  if (request.expectedState !== 'Absent') fail('invalid-request', 'lock expected state must be Absent')
  const composition = /** @type {Record<string, any>} */ (validateResolvedComposition(request.resolvedComposition))
  const lock = /** @type {Record<string, any>} */ (validateCompositionLockReceipt(request.compositionLockReceipt, composition))
  if (request.resolvedCompositionDigest !== composition.metadata.digest) fail('stale-resolution', 'lock resolved composition digest is stale')
  digest(request.admissionSealDigest, 'LockInstanceRequest.admissionSealDigest')
  if (request.admissionSealDigest !== request.admissionSeal?.metadata?.digest) fail('seal-invalid', 'lock admission seal digest mismatch')
  if (request.runtimeAssertion === null || request.runtimeAssertionDigest === null) fail('assertion-invalid', 'lock requires a current runtime assertion')
  digest(request.runtimeAssertionDigest, 'LockInstanceRequest.runtimeAssertionDigest')
  return { request, composition, lock }
}

/** @param {unknown} value @param {'start'|'resume'} operation */
function validateAssertionMutation(value, operation) {
  const request = plainRecord(value, `${operation} request`)
  const sourceKey = operation === 'start' ? 'priorReceiptDigest' : 'priorReceiptDigest'
  exactKeys(request, [
    'apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest',
    'identity', sourceKey, 'admissionSealDigest', 'runtimeAssertion',
    'runtimeAssertionDigest', 'expectedState',
  ], [], request.kind)
  validateCommonMutation(request, operation)
  digest(request.priorReceiptDigest, `${request.kind}.priorReceiptDigest`)
  digest(request.admissionSealDigest, `${request.kind}.admissionSealDigest`)
  digest(request.runtimeAssertionDigest, `${request.kind}.runtimeAssertionDigest`)
  if (request.runtimeAssertion?.metadata?.digest !== request.runtimeAssertionDigest) fail('assertion-invalid', 'runtime assertion digest mismatch')
  if (operation === 'start' && request.expectedState !== 'Locked') fail('invalid-request', 'start expected state must be Locked')
  if (operation === 'resume' && !['Interrupted', 'Stopped'].includes(request.expectedState)) fail('invalid-request', 'resume expected state is invalid')
  return request
}

/** @param {unknown} value @param {'interrupt'|'drain'|'stop'} operation */
function validateUnauthenticatedMutation(value, operation) {
  const request = plainRecord(value, `${operation} request`)
  const extras = operation === 'interrupt'
    ? ['runIdentity']
    : operation === 'drain'
      ? ['triggerFenceDigest', 'publisherEpoch', 'deadlinePolicyDigest']
      : ['receiptChainHead']
  exactKeys(request, [
    'apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest',
    'identity', 'expectedState', ...extras,
  ], [], request.kind)
  validateCommonMutation(request, operation)
  if (operation === 'interrupt') {
    if (request.expectedState !== 'Running') fail('invalid-request', 'interrupt expected state must be Running')
    text(request.runIdentity, 'InterruptInstanceRequest.runIdentity', 256)
  }
  if (operation === 'drain') {
    if (!['Running', 'Interrupted'].includes(request.expectedState)) fail('invalid-request', 'drain expected state is invalid')
    digest(request.triggerFenceDigest, 'DrainInstanceRequest.triggerFenceDigest')
    if (request.publisherEpoch !== null) uint64(request.publisherEpoch, 'DrainInstanceRequest.publisherEpoch')
    digest(request.deadlinePolicyDigest, 'DrainInstanceRequest.deadlinePolicyDigest')
  }
  if (operation === 'stop') {
    if (request.expectedState !== 'Drained') fail('invalid-request', 'stop expected state must be Drained')
    digest(request.receiptChainHead, 'StopInstanceRequest.receiptChainHead')
  }
  return request
}

/** @param {unknown} value */
function safeFailureRequestId(value) {
  try {
    text(value, 'failure requestId', 256)
    assertSecretFree(value, 'failure requestId')
    return value
  } catch {
    return null
  }
}

/** @param {unknown} value */
function safeFailureIdentity(value) {
  try {
    validateIdentity(value)
    assertSecretFree(value, 'failure identity')
    return structuredClone(value)
  } catch {
    return null
  }
}

/** @param {unknown} value */
function safeSessionIdentity(value) {
  try {
    text(value, 'DSH session identity', 256)
    assertSecretFree(value, 'DSH session identity')
    return /** @type {string} */ (value)
  } catch {
    return null
  }
}

/** @param {unknown} error @param {string} failureKind */
function trustFailureEvidence(error, failureKind) {
  const rawCode = error instanceof RuntimeManagerError ? error.code : 'authority-unavailable'
  const mapped = mapTrustAuthorityFailureCode(rawCode)
  const authenticatedAcceptance = error instanceof RuntimeManagerError
    && error.details.authorityFailureKind === 'DshTrustAcceptanceFailed'
    && typeof error.details.digest === 'string'
  if (authenticatedAcceptance && isManagerFailureCode(failureKind, mapped)) {
    return { code: mapped, failureDigest: /** @type {string} */ (error.details.digest) }
  }
  const localCode = requiresTrustAcceptanceFailureDigest(mapped)
    ? 'trust-authority-unavailable'
    : mapped
  return {
    code: isManagerFailureCode(failureKind, localCode)
      ? localCode : 'trust-authority-unavailable',
    failureDigest: null,
  }
}

/** @param {string} operation @param {Record<string, any>} request @param {string} code @param {string | null} state @param {Record<string, unknown>} [details] @param {string | null} [trustAcceptanceFailureDigest] */
function failure(operation, request, code, state, details = {}, trustAcceptanceFailureDigest = null) {
  const kind = `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`
  if (!isManagerFailureCode(kind, code)) code = 'invalid-request'
  if (requiresTrustAcceptanceFailureDigest(code) && trustAcceptanceFailureDigest === null) {
    code = isManagerFailureCode(kind, 'trust-authority-unavailable')
      ? 'trust-authority-unavailable' : 'invalid-request'
  }
  const retryable = ['runtime-unavailable', 'cas-conflict', 'trust-head-stale', 'time-revision-conflict', 'trust-authority-clock-unavailable', 'trust-authority-unavailable'].includes(code)
  /** @type {Record<string, any>} */
  const value = {
    apiVersion: RUNTIME_MANAGER_API_VERSION,
    kind,
    requestId: safeFailureRequestId(request.requestId),
    code,
    retryable,
    observedState: state === 'Absent' ? null : state,
    identity: safeFailureIdentity(request.identity),
    receiptDigest: null,
    details: structuredClone(details),
  }
  if (['lock', 'start', 'resume'].includes(operation)) value.trustAcceptanceFailureDigest = trustAcceptanceFailureDigest
  validateManagerPayload(value)
  return deepFreeze(value)
}

/** @param {string} operation @param {Record<string, any>} request @param {string} state @param {string | null} receiptDigest */
function indeterminate(operation, request, state, receiptDigest) {
  return deepFreeze({
    apiVersion: RUNTIME_MANAGER_API_VERSION,
    kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceIndeterminate`,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    code: 'effect-unknown',
    retryable: false,
    lastObservedState: state,
    identity: structuredClone(request.identity),
    receiptDigest,
    mandatoryRecovery: {
      statusRequired: true, doctorRequired: true,
      repeatSameOperationAndKey: true, quarantineIfStillUnknown: true,
    },
  })
}

/** @param {'lock'|'start'|'resume'|'interrupt'|'drain'|'stop'} operation @param {Record<string, any>} request @param {Record<string, any>} instance @param {string} sourceState @param {string} observedState @param {Record<string, any>} effect @param {string | null} sealAcceptance @param {string | null} assertionAcceptance @param {() => number} now @returns {Record<string, any>} */
function receipt(operation, request, instance, sourceState, observedState, effect, sealAcceptance, assertionAcceptance, now) {
  const value = {
    apiVersion: RUNTIME_MANAGER_API_VERSION,
    kind: RECEIPT_KINDS[operation],
    digest: `sha256:${'0'.repeat(64)}`,
    operation,
    identity: structuredClone(request.identity),
    idempotencyKey: request.idempotencyKey,
    sourceState,
    observedState,
    compositionLockReceiptDigest: instance.compositionLockReceiptDigest,
    resolvedCompositionDigest: instance.resolvedCompositionDigest,
    admissionSealDigest: instance.admissionSealDigest,
    requestDigest: request.requestDigest,
    priorReceiptDigest: instance.receiptHead,
    sealTrustAcceptanceReceiptDigest: sealAcceptance,
    assertionTrustAcceptanceReceiptDigest: assertionAcceptance,
    sessionIdentity: effect.sessionIdentity ?? instance.sessionIdentity ?? null,
    effectSummaryDigest: effect.effectSummaryDigest ?? null,
    timestamp: new Date(now()).toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  }
  value.digest = computeManagerDocumentDigest(value)
  validateRuntimeReceipt(value)
  return deepFreeze(value)
}

/**
 * Additive public runtime manager. It owns instance truth and journals but never
 * persists a DshDeploymentBinding, provider credential, or private locator.
 * @param {{
 *   store?: ReturnType<typeof createMemoryRuntimeStore>,
 *   trustVerifier: {acceptSignedDocument: (input: any) => Promise<{digest: string}>},
 *   health: (probe: string, context: {namespace: string}) => Promise<{state: string, code: string}> | {state: string, code: string},
 *   effects?: Record<string, (request: any, context: any) => Promise<any> | any>,
 *   compositionService?: {validate: (request: unknown) => any, resolve: (request: unknown) => any},
 *   now?: () => number,
 * }} options
 */
export function createWorkloadManager(options) {
  const store = options.store ?? createMemoryRuntimeStore()
  const effects = options.effects ?? {}
  const now = options.now ?? Date.now

  /** @param {unknown} value @param {() => Promise<any>} action */
  const serialize = async (value, action) => {
    const namespace = value && typeof value === 'object' && typeof /** @type {any} */ (value).identity?.namespace === 'string'
      ? /** @type {any} */ (value).identity.namespace : null
    if (namespace === null) return action()
    const previous = store.mutationLocks.get(namespace) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    store.mutationLocks.set(namespace, current)
    try { return await current } finally {
      if (store.mutationLocks.get(namespace) === current) store.mutationLocks.delete(namespace)
    }
  }

  /** @param {'validate'|'resolve'} operation @param {unknown} value */
  const composition = (operation, value) => {
    const service = options.compositionService
    if (service !== undefined && typeof service[operation] === 'function') return service[operation](value)
    return deepFreeze({
      apiVersion: RUNTIME_MANAGER_API_VERSION,
      kind: operation === 'validate' ? 'ValidateCompositionFailed' : 'ResolveCompositionFailed',
      requestId: value && typeof value === 'object' && typeof /** @type {any} */ (value).requestId === 'string'
        ? /** @type {any} */ (value).requestId : null,
      code: 'invalid-request', retryable: false, observedState: null,
      identity: null, receiptDigest: null, details: {},
    })
  }

  /** @param {Record<string, any>} request @param {string} operation */
  const replayOrConflict = (request, operation) => {
    const existing = store.journals.get(journalIdentity(request))
    if (existing === undefined) return null
    if (existing.requestDigest !== request.requestDigest) return failure(operation, request, 'idempotency-conflict', existing.sourceState)
    if (existing.result !== null) return existing.result
    return existing.indeterminate
  }

  /** @param {Record<string, any>} composition @param {string} namespace */
  const healthDecision = async (composition, namespace) => {
    /** @type {string[]} */
    const degraded = []
    let blocked = null
    for (const probe of composition.health.required) {
      try {
        const result = await options.health(probe, { namespace })
        if (result?.state !== 'ready' && blocked === null) blocked = probe
      } catch {
        if (blocked === null) blocked = probe
      }
    }
    for (const probe of composition.health.optional) {
      try {
        const result = await options.health(probe, { namespace })
        if (result?.state !== 'ready') degraded.push(probe)
      } catch {
        degraded.push(probe)
      }
    }
    return { blocked, degraded }
  }

  /** @param {Record<string, any>} assertion @param {Record<string, any>} instance @param {Record<string, any>} request @param {string} operation @param {string} revision */
  const acceptAssertion = async (assertion, instance, request, operation, revision) => {
    const protocolOperation = `instance.${operation}`
    validateRuntimeAssertion(assertion, {
      sealDigest: instance.admissionSealDigest,
      identity: request.identity,
      operation: protocolOperation,
      semanticRequestDigest: request.requestDigest,
    })
    return options.trustVerifier.acceptSignedDocument({
      namespace: request.identity.deploymentId,
      acceptanceKind: 'assertion', signedDocument: assertion,
      operation: protocolOperation, semanticRequestDigest: request.requestDigest,
      expectedEffectJournalRevision: revision,
    })
  }

  /** @param {Record<string, any>} request @param {string} operation @param {any} replay */
  const authorizeTerminalReplay = async (request, operation, replay) => {
    if (!['lock', 'start', 'resume'].includes(operation) || replay?.code === 'idempotency-conflict') return replay
    const journal = store.journals.get(journalIdentity(request))
    if (journal?.result === null || journal?.result === undefined || journal.requestDigest !== request.requestDigest) return replay
    const instance = store.instances.get(request.identity.namespace) ?? { admissionSealDigest: request.admissionSealDigest }
    try {
      const acceptance = await acceptAssertion(request.runtimeAssertion, instance, request, operation, journal.revision)
      journal.revision = String(BigInt(journal.revision) + 1n)
      journal.replayAssertionAcceptanceDigest = acceptance.digest
      return replay
    } catch (error) {
      const kind = `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`
      const { code, failureDigest } = trustFailureEvidence(error, kind)
      return failure(operation, request, code, instance.state ?? null, {}, failureDigest)
    }
  }

  /** @param {Record<string, any>} instance */
  const receiptChainValid = instance => {
    let next = instance.receiptHead
    const seen = new Set()
    let requiredObservedState = null
    while (next !== null) {
      if (seen.has(next)) return false
      seen.add(next)
      const document = store.receipts.get(next)
      if (document === undefined) return false
      try {
        validateRuntimeReceipt(document)
      } catch {
        return false
      }
      if (document.digest !== next
        || canonicalIdentity(document.identity) !== canonicalIdentity(instance.identity)
        || (requiredObservedState !== null && document.observedState !== requiredObservedState)) return false
      requiredObservedState = document.sourceState
      next = document.priorReceiptDigest
    }
    return seen.size > 0 && requiredObservedState === 'Absent'
  }

  /** @param {Record<string, any>} instance */
  const receiptHeadValid = instance => {
    if (instance.receiptHead === null) return false
    const document = store.receipts.get(instance.receiptHead)
    if (document === undefined) return false
    try {
      validateRuntimeReceipt(document)
    } catch {
      return false
    }
    if (document.digest !== instance.receiptHead
      || canonicalIdentity(document.identity) !== canonicalIdentity(instance.identity)) return false
    if (document.kind === 'InstanceQuarantineReceipt') {
      return instance.state === 'Quarantined' && document.observedState === 'Quarantined'
    }
    const transientSources = /** @type {Record<string, readonly string[]>} */ (TRANSIENT_RECEIPT_SOURCES)[instance.state]
    const stateMatches = document.observedState === instance.state
      || (instance.pendingSourceReceiptHead === instance.receiptHead
        && transientSources?.includes(document.observedState) === true)
    return stateMatches
      && document.sessionIdentity === instance.sessionIdentity
      && document.compositionLockReceiptDigest === instance.compositionLockReceiptDigest
      && document.resolvedCompositionDigest === instance.resolvedCompositionDigest
      && document.admissionSealDigest === instance.admissionSealDigest
  }

  /** @param {unknown} value */
  const lock = async value => {
    let parsed
    try { parsed = validateLockRequest(value) } catch (error) {
      const request = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
      return failure('lock', request, 'invalid-request', null)
    }
    const { request, composition, lock: compositionReceipt } = parsed
    const replay = replayOrConflict(request, 'lock')
    if (replay !== null) return authorizeTerminalReplay(request, 'lock', replay)
    if (store.instances.has(request.identity.namespace)) return failure('lock', request, 'state-conflict', store.instances.get(request.identity.namespace).state)
    const namespaceOwner = store.namespaces.get(request.identity.namespace)
    if (namespaceOwner !== undefined && namespaceOwner !== canonicalIdentity(request.identity)) return failure('lock', request, 'namespace-conflict', null)
    const health = await healthDecision(composition, request.identity.namespace)
    try {
      validateAdmissionSeal(request.admissionSeal, {
        composition, compositionLockReceipt: compositionReceipt, identity: request.identity,
      })
    } catch (error) {
      return failure('lock', request, error instanceof RuntimeManagerError ? error.code : 'seal-invalid', null)
    }
    /** @type {Record<string, any>} */
    const journal = {
      operation: 'lock', sourceState: 'Absent', requestDigest: request.requestDigest,
      revision: '0', status: 'pending', result: null, indeterminate: null,
      request: structuredClone(request), sealAcceptanceDigest: null,
      assertionAcceptanceDigest: null,
    }
    store.journals.set(journalIdentity(request), journal)
    /** @type {{digest: string}} */
    let sealAcceptance
    /** @type {{digest: string}} */
    let assertionAcceptance
    try {
      sealAcceptance = /** @type {{digest: string}} */ (await options.trustVerifier.acceptSignedDocument({
        namespace: request.identity.deploymentId,
        acceptanceKind: 'seal', signedDocument: request.admissionSeal,
        operation: 'instance.lock', semanticRequestDigest: request.requestDigest,
        expectedEffectJournalRevision: journal.revision,
      }))
      journal.sealAcceptanceDigest = sealAcceptance.digest
      journal.revision = '1'
      const provisional = {
        admissionSealDigest: request.admissionSealDigest,
      }
      assertionAcceptance = /** @type {{digest: string}} */ (await acceptAssertion(request.runtimeAssertion, provisional, request, 'lock', journal.revision))
      journal.assertionAcceptanceDigest = assertionAcceptance.digest
      journal.revision = '2'
    } catch (error) {
      const { code, failureDigest } = trustFailureEvidence(error, 'LockInstanceFailed')
      const result = failure('lock', request, code, null, {}, failureDigest)
      journal.status = 'failed'; journal.result = result
      return result
    }
    const instance = {
      identity: structuredClone(request.identity), state: 'Locked',
      compositionLockReceiptDigest: compositionReceipt.digest,
      resolvedCompositionDigest: composition.metadata.digest,
      admissionSealDigest: request.admissionSealDigest,
      scopeClass: composition.profile.scopeClass,
      degradedHealth: [...health.degraded], receiptHead: null, sessionIdentity: null,
      health: { required: [...composition.health.required], optional: [...composition.health.optional] },
      resources: { classes: [...composition.resources.classes] },
    }
    const lockReceipt = receipt('lock', request, instance, 'Absent', 'Locked', {}, sealAcceptance.digest, assertionAcceptance.digest, now)
    instance.receiptHead = lockReceipt.digest
    store.receipts.set(lockReceipt.digest, lockReceipt)
    store.instances.set(request.identity.namespace, instance)
    store.namespaces.set(request.identity.namespace, canonicalIdentity(request.identity))
    const result = deepFreeze({
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'LockInstanceSucceeded',
      requestId: request.requestId, idempotencyKey: request.idempotencyKey,
      identity: structuredClone(request.identity), observedState: 'Locked',
      receipt: lockReceipt,
    })
    journal.status = 'succeeded'; journal.result = result
    return result
  }

  /** @param {'start'|'resume'|'interrupt'|'drain'|'stop'} operation @param {unknown} value */
  const mutate = async (operation, value) => {
    let request
    try {
      request = ['start', 'resume'].includes(operation)
        ? validateAssertionMutation(value, /** @type {'start'|'resume'} */ (operation))
        : validateUnauthenticatedMutation(value, /** @type {'interrupt'|'drain'|'stop'} */ (operation))
    } catch (error) {
      const candidate = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
      return failure(operation, candidate, 'invalid-request', null)
    }
    const replay = replayOrConflict(request, operation)
    if (replay !== null) return authorizeTerminalReplay(request, operation, replay)
    const instance = store.instances.get(request.identity.namespace)
    if (instance === undefined || canonicalIdentity(instance.identity) !== canonicalIdentity(request.identity)) return failure(operation, request, 'state-conflict', null)
    const transition = LIFECYCLE_TRANSITIONS[operation]
    if (!transition.sources.includes(instance.state) || request.expectedState !== instance.state) return failure(operation, request, 'state-conflict', instance.state)
    if (operation === 'stop' && request.receiptChainHead !== instance.receiptHead) return failure(operation, request, 'receipt-chain-invalid', instance.state)
    if (operation === 'stop' && !receiptChainValid(instance)) return failure(operation, request, 'receipt-chain-invalid', instance.state)
    if (['start', 'resume'].includes(operation) && request.admissionSealDigest !== instance.admissionSealDigest) return failure(operation, request, 'seal-invalid', instance.state)
    if (operation === 'start' && request.priorReceiptDigest !== instance.receiptHead) return failure(operation, request, 'lock-invalid', instance.state)
    if (operation === 'resume' && request.priorReceiptDigest !== instance.receiptHead) return failure(operation, request, 'receipt-chain-invalid', instance.state)
    if (operation === 'resume' && safeSessionIdentity(instance.sessionIdentity) === null) return failure(operation, request, 'retained-state-missing', instance.state)
    if (['interrupt', 'drain', 'stop'].includes(operation)
      && safeSessionIdentity(instance.sessionIdentity) === null) return failure(operation, request, 'state-conflict', instance.state)
    if (operation === 'interrupt' && instance.sessionIdentity !== null && request.runIdentity !== instance.sessionIdentity) return failure(operation, request, 'cancellation-identity-mismatch', instance.state)
    const sourceState = instance.state
    /** @type {Record<string, any>} */
    const journal = {
      operation, sourceState, requestDigest: request.requestDigest, revision: '0',
      status: 'pending', result: null, indeterminate: null,
      request: structuredClone(request), assertionAcceptanceDigest: null,
    }
    store.journals.set(journalIdentity(request), journal)
    let assertionAcceptance = null
    let refreshedDegradedHealth = null
    if (['start', 'resume'].includes(operation)) {
      try {
        assertionAcceptance = await acceptAssertion(request.runtimeAssertion, instance, request, operation, journal.revision)
        journal.assertionAcceptanceDigest = assertionAcceptance.digest
        journal.revision = '1'
      } catch (error) {
        const kind = `${operation[0].toUpperCase()}${operation.slice(1)}InstanceFailed`
        const { code, failureDigest } = trustFailureEvidence(error, kind)
        const result = failure(operation, request, code, instance.state, {}, failureDigest)
        journal.status = 'failed'; journal.result = result
        return result
      }
      const health = operation === 'start'
        ? await healthDecision(instance, request.identity.namespace)
        : { blocked: null, degraded: [] }
      if (operation === 'start' && health.blocked !== null) {
        const result = failure(operation, request, 'required-health-failed', instance.state, { probe: health.blocked })
        journal.status = 'failed'; journal.result = result
        return result
      }
      if (operation === 'start') refreshedDegradedHealth = health.degraded
    }
    if (transition.transient !== null) {
      instance.pendingSourceReceiptHead = instance.receiptHead
      instance.state = transition.transient
    }
    let effect
    try {
      effect = typeof effects[operation] === 'function'
        ? await effects[operation](structuredClone(request), { instance: structuredClone(instance) })
        : { status: 'succeeded' }
    } catch {
      effect = { status: 'indeterminate' }
    }
    if (effect?.status === 'failed') {
      instance.state = sourceState
      delete instance.pendingSourceReceiptHead
      const result = failure(operation, request, effect.code ?? 'runtime-unavailable', sourceState)
      journal.status = 'failed'; journal.result = result
      return result
    }
    if (effect?.status !== 'succeeded') {
      const result = indeterminate(operation, request, instance.state, instance.receiptHead)
      journal.status = 'indeterminate'; journal.indeterminate = result
      return result
    }
    if (operation === 'start' && safeSessionIdentity(effect.sessionIdentity) === null) {
      const unknown = indeterminate(operation, request, instance.state, instance.receiptHead)
      journal.status = 'indeterminate'; journal.indeterminate = unknown
      return unknown
    }
    if (operation === 'resume' && effect.sessionIdentity !== undefined
      && (safeSessionIdentity(effect.sessionIdentity) === null
        || effect.sessionIdentity !== instance.sessionIdentity)) {
      const unknown = indeterminate(operation, request, instance.state, instance.receiptHead)
      journal.status = 'indeterminate'; journal.indeterminate = unknown
      return unknown
    }
    const prospectiveInstance = {
      ...instance,
      state: transition.terminal,
      sessionIdentity: operation === 'start' ? effect.sessionIdentity : instance.sessionIdentity,
      degradedHealth: operation === 'start' && refreshedDegradedHealth !== null
        ? [...refreshedDegradedHealth] : [...instance.degradedHealth],
    }
    let operationReceipt
    let result
    try {
      operationReceipt = receipt(
        operation, request, prospectiveInstance, sourceState, transition.terminal,
        effect, null, assertionAcceptance?.digest ?? null, now,
      )
      result = {
        apiVersion: RUNTIME_MANAGER_API_VERSION,
        kind: `${operation[0].toUpperCase()}${operation.slice(1)}InstanceSucceeded`,
        requestId: request.requestId, idempotencyKey: request.idempotencyKey,
        identity: structuredClone(request.identity), observedState: transition.terminal,
        receipt: operationReceipt,
        ...(['start', 'resume'].includes(operation) ? { sessionIdentity: prospectiveInstance.sessionIdentity } : {}),
        ...(operation === 'interrupt' ? { retainedStateDigest: effect.retainedStateDigest ?? null } : {}),
        ...(operation === 'drain' ? { reconciledEffectSummaryDigest: effect.effectSummaryDigest ?? null } : {}),
        ...(operation === 'stop' ? { retainedStateDisposition: effect.retainedStateDisposition ?? 'retained' } : {}),
      }
      validateManagerPayload(result)
      result = deepFreeze(result)
    } catch {
      const unknown = indeterminate(operation, request, instance.state, instance.receiptHead)
      journal.status = 'indeterminate'; journal.indeterminate = unknown
      return unknown
    }
    instance.state = prospectiveInstance.state
    instance.sessionIdentity = prospectiveInstance.sessionIdentity
    instance.degradedHealth = prospectiveInstance.degradedHealth
    delete instance.pendingSourceReceiptHead
    instance.receiptHead = operationReceipt.digest
    store.receipts.set(operationReceipt.digest, operationReceipt)
    journal.status = 'succeeded'; journal.result = result
    return result
  }

  /** @param {unknown} value */
  const status = async value => {
    let request
    try {
      request = plainRecord(value, 'StatusInstanceRequest')
      exactKeys(request, ['apiVersion', 'kind', 'requestId', 'identity', 'receiptChainHead'], [], 'StatusInstanceRequest')
      if (request.apiVersion !== RUNTIME_MANAGER_API_VERSION || request.kind !== 'StatusInstanceRequest') fail('invalid-request', 'status request identity is invalid')
      text(request.requestId, 'StatusInstanceRequest.requestId', 256)
      validateIdentity(request.identity)
      if (request.receiptChainHead !== null) digest(request.receiptChainHead, 'StatusInstanceRequest.receiptChainHead')
    } catch (error) {
      return failure('status', value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}, 'invalid-request', null)
    }
    const instance = store.instances.get(request.identity.namespace)
    if (instance === undefined || canonicalIdentity(instance.identity) !== canonicalIdentity(request.identity)) return failure('status', request, 'not-found', null)
    if (!receiptHeadValid(instance)) return failure('status', request, 'receipt-chain-invalid', instance.state)
    if (request.receiptChainHead !== null && request.receiptChainHead !== instance.receiptHead) return failure('status', request, 'receipt-chain-invalid', instance.state)
    return deepFreeze({
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'StatusInstanceSucceeded',
      requestId: request.requestId, identity: structuredClone(instance.identity),
      observedState: instance.state, sessionIdentity: instance.sessionIdentity,
      receiptChainHead: instance.receiptHead,
      health: { required: [...instance.health.required], optional: [...instance.degradedHealth] },
      resources: structuredClone(instance.resources),
    })
  }

  /** @param {unknown} value */
  const doctor = async value => {
    let request
    try {
      request = plainRecord(value, 'DoctorInstanceRequest')
      exactKeys(request, ['apiVersion', 'kind', 'requestId', 'identity', 'expectedCompositionLockReceiptDigest', 'expectedAdmissionSealDigest', 'expectedReceiptChainHead'], [], 'DoctorInstanceRequest')
      if (request.apiVersion !== RUNTIME_MANAGER_API_VERSION || request.kind !== 'DoctorInstanceRequest') fail('invalid-request', 'doctor request identity is invalid')
      text(request.requestId, 'DoctorInstanceRequest.requestId', 256)
      validateIdentity(request.identity)
      digest(request.expectedCompositionLockReceiptDigest, 'DoctorInstanceRequest.expectedCompositionLockReceiptDigest')
      digest(request.expectedAdmissionSealDigest, 'DoctorInstanceRequest.expectedAdmissionSealDigest')
      digest(request.expectedReceiptChainHead, 'DoctorInstanceRequest.expectedReceiptChainHead')
    } catch (error) {
      return failure('doctor', value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}, 'invalid-request', null)
    }
    const instance = store.instances.get(request.identity?.namespace)
    if (instance === undefined
      || canonicalIdentity(instance.identity) !== canonicalIdentity(request.identity)) {
      return failure('doctor', request, 'not-found', null)
    }
    const checks = [
      ['composition-lock', request.expectedCompositionLockReceiptDigest === instance.compositionLockReceiptDigest],
      ['admission-seal', request.expectedAdmissionSealDigest === instance.admissionSealDigest],
      ['receipt-chain', request.expectedReceiptChainHead === instance.receiptHead
        && receiptHeadValid(instance) && receiptChainValid(instance)],
    ].map(([id, passed]) => ({ id, state: passed ? 'pass' : 'fail' }))
    return deepFreeze({
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'DoctorInstanceSucceeded',
      requestId: request.requestId, identity: structuredClone(instance.identity),
      observedState: instance.state, checks,
      recoveryRecommendation: checks.every(item => item.state === 'pass') ? 'none' : 'reconcile',
      receiptChainVerified: checks[2].state === 'pass',
    })
  }

  /** @param {unknown} value @param {{authorized?: boolean, evidence?: {status?: string, sessionIdentity?: string}}} [context] */
  const reconcile = async (value, context = {}) => {
    let request
    try {
      request = plainRecord(value, 'ReconcileInstanceRequest')
      exactKeys(request, [
        'apiVersion', 'kind', 'requestId', 'originalOperation',
        'originalIdempotencyKey', 'originalRequestDigest', 'identity',
        'journalEvidenceDigest', 'dshEvidenceDigest', 'expectedSourceStates',
        'expectedTerminalState',
      ], [], 'ReconcileInstanceRequest')
      if (request.apiVersion !== RUNTIME_MANAGER_API_VERSION || request.kind !== 'ReconcileInstanceRequest') fail('invalid-request', 'reconcile request identity is invalid')
      if (!Object.hasOwn(RECONCILIATION_MATRIX, request.originalOperation)) fail('invalid-request', 'reconcile original operation is invalid')
      text(request.originalIdempotencyKey, 'ReconcileInstanceRequest.originalIdempotencyKey', 256)
      digest(request.originalRequestDigest, 'ReconcileInstanceRequest.originalRequestDigest')
      validateIdentity(request.identity)
      digest(request.journalEvidenceDigest, 'ReconcileInstanceRequest.journalEvidenceDigest')
      digest(request.dshEvidenceDigest, 'ReconcileInstanceRequest.dshEvidenceDigest')
      if (!Array.isArray(request.expectedSourceStates)) fail('invalid-request', 'reconcile expected source states are invalid')
    } catch (error) {
      const candidate = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
      return reconcileFailure(candidate, error instanceof RuntimeManagerError ? error.code : 'invalid-request')
    }
    if (context.authorized !== true) return reconcileFailure(request, 'unauthorized-state-mutation')
    const originalOperation = /** @type {'lock'|'start'|'resume'|'interrupt'|'drain'|'stop'} */ (request.originalOperation)
    const originalKind = MUTATION_KINDS[originalOperation]
    const originalKey = `${originalKind}\0${request.identity.namespace}\0${request.originalIdempotencyKey}`
    const journal = store.journals.get(originalKey)
    let instance = store.instances.get(request.identity.namespace)
    if (journal === undefined) return reconcileFailure(request, 'not-found')
    if (canonicalIdentity(journal.request.identity) !== canonicalIdentity(request.identity)
      || (instance !== undefined
        && canonicalIdentity(instance.identity) !== canonicalIdentity(request.identity))) {
      return reconcileFailure(request, 'state-conflict')
    }
    if (journal.requestDigest !== request.originalRequestDigest) return reconcileFailure(request, 'idempotency-conflict')
    const matrix = RECONCILIATION_MATRIX[originalOperation]
    const reconciliationKey = `${originalKey}\0${request.journalEvidenceDigest}\0${request.dshEvidenceDigest}`
    const existing = store.reconciliations.get(reconciliationKey)
    if (existing !== undefined) return existing
    if (journal.status !== 'indeterminate'
      || (instance === undefined && request.originalOperation !== 'lock')) return reconcileFailure(request, 'state-conflict')
    const currentState = instance?.state ?? 'Absent'
    const candidates = [...new Set([journal.sourceState, matrix.transient, matrix.terminal].filter(Boolean))]
    if (!candidates.includes(currentState)
      || request.expectedTerminalState !== matrix.terminal
      || request.expectedSourceStates.join('\0') !== [journal.sourceState].join('\0')) return reconcileFailure(request, 'state-conflict')
    const evidence = context.evidence?.status
    if (evidence === 'temporary-unavailable') {
      const result = deepFreeze({
        apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'ReconcileInstanceIndeterminate',
        requestId: request.requestId, code: 'evidence-temporarily-unavailable',
        retryable: false, identity: structuredClone(request.identity), observedState: currentState,
        originalOperation: request.originalOperation,
        originalIdempotencyKey: request.originalIdempotencyKey,
        originalRequestDigest: request.originalRequestDigest,
      })
      store.reconciliations.set(reconciliationKey, result)
      return result
    }
    if (evidence === 'committed') {
      const originalRequest = journal.request
      if (instance === undefined) {
        const resolved = originalRequest.resolvedComposition
        instance = {
          identity: structuredClone(request.identity), state: 'Locked',
          compositionLockReceiptDigest: originalRequest.compositionLockReceipt.digest,
          resolvedCompositionDigest: resolved.metadata.digest,
          admissionSealDigest: originalRequest.admissionSealDigest,
          scopeClass: resolved.profile.scopeClass,
          degradedHealth: [], receiptHead: null, sessionIdentity: null,
          health: { required: [...resolved.health.required], optional: [...resolved.health.optional] },
          resources: { classes: [...resolved.resources.classes] },
        }
        store.instances.set(request.identity.namespace, instance)
        store.namespaces.set(request.identity.namespace, canonicalIdentity(request.identity))
      }
      let reconciledSessionIdentity = null
      if (originalOperation === 'start') {
        reconciledSessionIdentity = safeSessionIdentity(context.evidence?.sessionIdentity)
        if (reconciledSessionIdentity === null) return reconcileFailure(request, 'evidence-digest-invalid')
      } else if (originalOperation === 'resume') {
        reconciledSessionIdentity = safeSessionIdentity(instance.sessionIdentity)
        const observedSessionIdentity = context.evidence?.sessionIdentity
        if (reconciledSessionIdentity === null
          || (observedSessionIdentity !== undefined
            && (safeSessionIdentity(observedSessionIdentity) === null
              || observedSessionIdentity !== reconciledSessionIdentity))) {
          return reconcileFailure(request, 'evidence-digest-invalid')
        }
      }
      instance.state = matrix.terminal
      if (reconciledSessionIdentity !== null) instance.sessionIdentity = reconciledSessionIdentity
      delete instance.pendingSourceReceiptHead
      const retainedReceipt = [...store.receipts.values()].find(candidate => candidate.operation === originalOperation
        && candidate.requestDigest === originalRequest.requestDigest
        && canonicalIdentity(candidate.identity) === canonicalIdentity(request.identity))
      const recoveredReceipt = retainedReceipt ?? receipt(
          originalOperation, originalRequest, instance, journal.sourceState,
          matrix.terminal, {
            effectSummaryDigest: request.dshEvidenceDigest,
            ...(['start', 'resume'].includes(originalOperation)
              ? { sessionIdentity: reconciledSessionIdentity } : {}),
          },
          journal.sealAcceptanceDigest ?? null,
          journal.assertionAcceptanceDigest ?? null,
          now,
        )
      instance.receiptHead = recoveredReceipt.digest
      store.receipts.set(recoveredReceipt.digest, recoveredReceipt)
      const originalResult = deepFreeze({
        apiVersion: RUNTIME_MANAGER_API_VERSION,
        kind: `${originalOperation[0].toUpperCase()}${originalOperation.slice(1)}InstanceSucceeded`,
        requestId: originalRequest.requestId, idempotencyKey: originalRequest.idempotencyKey,
        identity: structuredClone(request.identity), observedState: matrix.terminal,
        receipt: recoveredReceipt,
        ...(['start', 'resume'].includes(originalOperation)
          ? { sessionIdentity: instance.sessionIdentity } : {}),
        ...(originalOperation === 'lock' ? {} : {
          ...(originalOperation === 'interrupt' ? { retainedStateDigest: request.dshEvidenceDigest } : {}),
          ...(originalOperation === 'drain' ? { reconciledEffectSummaryDigest: request.dshEvidenceDigest } : {}),
          ...(originalOperation === 'stop' ? { retainedStateDisposition: 'retained' } : {}),
        }),
      })
      const result = deepFreeze({
        apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'ReconcileInstanceProvedTerminal',
        requestId: request.requestId, identity: structuredClone(request.identity),
        observedState: matrix.terminal, originalOperation: request.originalOperation,
        originalIdempotencyKey: request.originalIdempotencyKey,
        originalRequestDigest: request.originalRequestDigest,
      })
      journal.status = 'succeeded'; journal.result = originalResult
      store.reconciliations.set(reconciliationKey, result)
      return result
    }
    if (evidence === 'not-committed') {
      if (originalOperation === 'lock') {
        store.instances.delete(request.identity.namespace)
        store.namespaces.delete(request.identity.namespace)
        instance = undefined
      } else if (instance !== undefined) {
        instance.state = journal.sourceState
        delete instance.pendingSourceReceiptHead
      }
      const result = deepFreeze({
        apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'ReconcileInstanceProvedSource',
        requestId: request.requestId, identity: structuredClone(request.identity),
        observedState: journal.sourceState, originalOperation: request.originalOperation,
        originalIdempotencyKey: request.originalIdempotencyKey,
        originalRequestDigest: request.originalRequestDigest,
      })
      journal.status = 'failed'
      journal.result = failure(originalOperation, journal.request, 'runtime-unavailable', journal.sourceState)
      store.reconciliations.set(reconciliationKey, result)
      return result
    }
    const quarantineReceipt = {
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'InstanceQuarantineReceipt',
      digest: `sha256:${'0'.repeat(64)}`, originalOperation: request.originalOperation,
      originalIdempotencyKey: request.originalIdempotencyKey,
      originalRequestDigest: request.originalRequestDigest,
      identity: structuredClone(request.identity), sourceState: journal.sourceState,
      lastObservedState: currentState, journalEvidenceDigest: request.journalEvidenceDigest,
      dshEvidenceDigest: request.dshEvidenceDigest, priorReceiptDigest: instance?.receiptHead ?? null,
      reasonCode: evidence === 'authority-unavailable' ? 'authoritative-truth-unavailable' : 'stable-conflict',
      observedState: 'Quarantined',
    }
    quarantineReceipt.digest = computeManagerDocumentDigest(quarantineReceipt)
    validateRuntimeReceipt(quarantineReceipt)
    if (instance === undefined) {
      const originalRequest = journal.request
      const resolved = originalRequest.resolvedComposition
      instance = {
        identity: structuredClone(request.identity), state: 'Quarantined',
        compositionLockReceiptDigest: originalRequest.compositionLockReceipt.digest,
        resolvedCompositionDigest: resolved.metadata.digest,
        admissionSealDigest: originalRequest.admissionSealDigest,
        scopeClass: resolved.profile.scopeClass, degradedHealth: [],
        receiptHead: null, sessionIdentity: null,
        health: { required: [...resolved.health.required], optional: [...resolved.health.optional] },
        resources: { classes: [...resolved.resources.classes] },
      }
      store.instances.set(request.identity.namespace, instance)
      store.namespaces.set(request.identity.namespace, canonicalIdentity(request.identity))
    }
    instance.state = 'Quarantined'; instance.receiptHead = quarantineReceipt.digest
    delete instance.pendingSourceReceiptHead
    store.receipts.set(quarantineReceipt.digest, deepFreeze(quarantineReceipt))
    const result = deepFreeze({
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'ReconcileInstanceQuarantined',
      requestId: request.requestId, identity: structuredClone(request.identity),
      observedState: 'Quarantined', receipt: quarantineReceipt,
      originalOperation: request.originalOperation,
      originalIdempotencyKey: request.originalIdempotencyKey,
      originalRequestDigest: request.originalRequestDigest,
    })
    store.reconciliations.set(reconciliationKey, result)
    return result
  }

  return Object.freeze({
    store,
    validate: (/** @type {unknown} */ value) => composition('validate', value),
    resolve: (/** @type {unknown} */ value) => composition('resolve', value),
    lock: (/** @type {unknown} */ value) => serialize(value, () => lock(value)),
    start: (/** @type {unknown} */ value) => serialize(value, () => mutate('start', value)),
    resume: (/** @type {unknown} */ value) => serialize(value, () => mutate('resume', value)),
    interrupt: (/** @type {unknown} */ value) => serialize(value, () => mutate('interrupt', value)),
    drain: (/** @type {unknown} */ value) => serialize(value, () => mutate('drain', value)),
    stop: (/** @type {unknown} */ value) => serialize(value, () => mutate('stop', value)),
    status, doctor,
    reconcile: (/** @type {unknown} */ value, /** @type {any} */ context) => serialize(value, () => reconcile(value, context)),
  })
}

/** @param {Record<string, any>} value */
function canonicalIdentity(value) {
  return `${value.deploymentId}\0${value.profileId}\0${value.generationId}\0${value.instanceId}\0${value.namespace}`
}

/** @param {Record<string, any>} request @param {string} code */
function reconcileFailure(request, code) {
  return failure('reconcile', request, code, null)
}
