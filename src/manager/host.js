// @ts-check

import { domainSeparatedDigest } from '../composition/index.js'
import {
  RUNTIME_MANAGER_API_VERSION,
  RuntimeManagerError,
  TRUST_FAILURE_CODE_MAP,
  assertCanonicalByteBound,
  assertSecretFree,
  computeManagerDocumentDigest,
  computeSemanticRequestDigest,
  digest,
  exactKeys,
  fail,
  identity as validateIdentity,
  mapTrustAuthorityFailureCode,
  plainRecord,
  requiresTrustAcceptanceFailureDigest,
  text,
  uint64,
  validateFailureDetails,
  validateRuntimeAssertion,
} from './contracts.js'

const ACTION_CLASSES = Object.freeze([
  'filesystem-read', 'filesystem-write', 'network-connect',
  'subprocess-template', 'clock-read', 'random-read', 'provider-read',
  'provider-write', 'credential-use',
])
const EFFECTFUL_ACTIONS = new Set([
  'filesystem-write', 'network-connect', 'subprocess-template',
  'provider-write', 'credential-use',
])
const UINT_KEYS = /^[a-z][a-z0-9._-]{0,63}$/u
const HOST_STATES = new Set([
  'Locked', 'Starting', 'Running', 'Interrupting', 'Interrupted',
  'Draining', 'Drained', 'Stopping', 'Stopped', 'Quarantined',
])
const HOST_RETRYABLE_FAILURE_CODES = new Set([
  'trust-head-stale', 'time-revision-conflict',
  'trust-authority-clock-unavailable', 'trust-authority-unavailable',
])
const HOST_FAILURE_CODES = new Set([
  'invalid-request', 'unsupported-kind', 'unknown-field', 'schema-invalid',
  'seal-invalid',
  'assertion-invalid', 'assertion-stale', 'assertion-expired',
  'assertion-revoked', 'state-conflict', 'idempotency-conflict',
  'action-denied', 'scope-denied', 'target-denied', 'resource-denied',
  'budget-exceeded', 'epoch-conflict', 'credential-denied',
  'broker-route-required', 'broker-state-conflict',
  ...Object.values(TRUST_FAILURE_CODE_MAP),
])
const ACCEPTANCE_MAPPED_FAILURE_CODES = new Set(Object.values(TRUST_FAILURE_CODE_MAP))
const HOST_ADAPTER_FAILURE_CODES = new Set([
  'invalid-request', 'unsupported-kind', 'unknown-field', 'schema-invalid',
  'seal-invalid', 'assertion-invalid', 'assertion-stale', 'assertion-expired',
  'assertion-revoked', 'state-conflict', 'idempotency-conflict',
  'action-denied', 'scope-denied', 'target-denied', 'resource-denied',
  'budget-exceeded', 'epoch-conflict', 'credential-denied',
  'broker-route-required', 'broker-state-conflict',
])

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** @param {unknown} value */
export function validateMediatedHostActionRequest(value) {
  assertCanonicalByteBound(value, 'MediatedHostActionRequest')
  const request = plainRecord(value, 'MediatedHostActionRequest')
  exactKeys(request, [
    'apiVersion', 'kind', 'requestId', 'identity', 'pluginDescriptorDigest',
    'pluginId', 'actionId', 'actionClass', 'inputSchemaDigest',
    'outputSchemaDigest', 'payload', 'targetScopeDigest', 'budgetDebit',
    'expectedState', 'publisherEpoch', 'actionNonce', 'idempotencyKey',
    'requestDigest', 'runtimeAssertion', 'runtimeAssertionDigest',
  ], [], 'MediatedHostActionRequest')
  if (request.apiVersion !== RUNTIME_MANAGER_API_VERSION || request.kind !== 'MediatedHostActionRequest') fail('unsupported-kind', 'mediated host request identity is invalid')
  text(request.requestId, 'MediatedHostActionRequest.requestId', 256)
  validateIdentity(request.identity)
  digest(request.pluginDescriptorDigest, 'MediatedHostActionRequest.pluginDescriptorDigest')
  text(request.pluginId, 'MediatedHostActionRequest.pluginId', 128)
  text(request.actionId, 'MediatedHostActionRequest.actionId', 128)
  if (!ACTION_CLASSES.includes(request.actionClass)) fail('schema-invalid', 'mediated host action class is invalid')
  digest(request.inputSchemaDigest, 'MediatedHostActionRequest.inputSchemaDigest')
  digest(request.outputSchemaDigest, 'MediatedHostActionRequest.outputSchemaDigest')
  if (request.payload === undefined) fail('schema-invalid', 'mediated host payload is required')
  assertSecretFree(request.payload, 'MediatedHostActionRequest.payload')
  digest(request.targetScopeDigest, 'MediatedHostActionRequest.targetScopeDigest')
  const budget = plainRecord(request.budgetDebit, 'MediatedHostActionRequest.budgetDebit')
  const keys = Object.keys(budget)
  if (keys.length > 64 || keys.join('\0') !== [...keys].sort().join('\0')) fail('schema-invalid', 'budget debit keys must be sorted and bounded')
  for (const key of keys) {
    if (!UINT_KEYS.test(key)) fail('schema-invalid', 'budget debit key is invalid')
    uint64(budget[key], `MediatedHostActionRequest.budgetDebit.${key}`)
  }
  if (!['Locked', 'Running', 'Interrupted', 'Drained'].includes(request.expectedState)) fail('schema-invalid', 'mediated host expected state is invalid')
  if (request.publisherEpoch !== null) uint64(request.publisherEpoch, 'MediatedHostActionRequest.publisherEpoch')
  text(request.actionNonce, 'MediatedHostActionRequest.actionNonce', 256)
  text(request.idempotencyKey, 'MediatedHostActionRequest.idempotencyKey', 256)
  digest(request.requestDigest, 'MediatedHostActionRequest.requestDigest')
  digest(request.runtimeAssertionDigest, 'MediatedHostActionRequest.runtimeAssertionDigest')
  if (request.runtimeAssertion?.metadata?.digest !== request.runtimeAssertionDigest) fail('assertion-invalid', 'mediated host assertion digest mismatch')
  if (computeSemanticRequestDigest(request) !== request.requestDigest) fail('invalid-request', 'mediated host semantic request digest is invalid')
  return request
}

/** @param {unknown} value */
export function validateMediatedHostActionResult(value) {
  assertCanonicalByteBound(value, 'mediated host result')
  const result = plainRecord(value, 'mediated host result')
  const common = [
    'apiVersion', 'kind', 'digest', 'requestId', 'requestDigest', 'identity',
    'pluginDescriptorDigest', 'pluginId', 'actionId', 'idempotencyKey',
    'trustAcceptanceReceiptDigest', 'trustAcceptanceFailureDigest',
    'observedState', 'publisherEpoch', 'budgetDecision',
  ]
  if (result.kind === 'MediatedHostActionSucceeded') {
    exactKeys(result, [...common, 'outputPayload', 'outputSchemaDigest', 'externalEffectReceipt'], [], result.kind)
  } else if (result.kind === 'MediatedHostActionFailed') {
    exactKeys(result, [...common, 'code', 'retryable', 'details'], [], result.kind)
  } else if (result.kind === 'MediatedHostActionIndeterminate') {
    exactKeys(result, [...common, 'code', 'externalIdempotencyToken', 'mandatoryRecovery'], [], result.kind)
    if (result.code !== 'external-effect-unknown') fail('schema-invalid', 'mediated host indeterminate code is invalid')
  } else fail('unsupported-kind', 'mediated host result kind is invalid')
  if (result.apiVersion !== RUNTIME_MANAGER_API_VERSION) fail('unsupported-api-version', 'mediated host result apiVersion is invalid')
  digest(result.digest, `${result.kind}.digest`)
  digest(result.requestDigest, `${result.kind}.requestDigest`)
  const failedResult = result.kind === 'MediatedHostActionFailed'
  if (result.requestId === null && failedResult) {
    if (result.identity !== null || result.pluginId !== null || result.actionId !== null
      || result.idempotencyKey !== null) fail('schema-invalid', 'uncorrelated host failure fields are inconsistent')
  } else text(result.requestId, `${result.kind}.requestId`, 256)
  if (result.identity === null) {
    if (!failedResult) fail('schema-invalid', 'host result identity is required')
  } else validateIdentity(result.identity)
  digest(result.pluginDescriptorDigest, `${result.kind}.pluginDescriptorDigest`)
  for (const field of ['pluginId', 'actionId', 'idempotencyKey']) {
    if (result[field] === null) {
      if (!failedResult) fail('schema-invalid', `${result.kind}.${field} is required`)
    } else text(result[field], `${result.kind}.${field}`, 256)
  }
  if (result.trustAcceptanceReceiptDigest !== null) digest(result.trustAcceptanceReceiptDigest, `${result.kind}.trustAcceptanceReceiptDigest`)
  if (result.trustAcceptanceFailureDigest !== null) digest(result.trustAcceptanceFailureDigest, `${result.kind}.trustAcceptanceFailureDigest`)
  if (result.trustAcceptanceReceiptDigest !== null && result.trustAcceptanceFailureDigest !== null) fail('schema-invalid', 'mediated host result has conflicting trust evidence')
  if (result.observedState !== null && !HOST_STATES.has(result.observedState)) fail('schema-invalid', 'mediated host observed state is invalid')
  if (result.publisherEpoch !== null) uint64(result.publisherEpoch, `${result.kind}.publisherEpoch`)
  if (result.kind === 'MediatedHostActionSucceeded') {
    if (result.trustAcceptanceReceiptDigest === null || result.trustAcceptanceFailureDigest !== null
      || result.budgetDecision !== 'committed') fail('schema-invalid', 'mediated host success evidence is invalid')
    assertSecretFree(result.outputPayload, `${result.kind}.outputPayload`)
    digest(result.outputSchemaDigest, `${result.kind}.outputSchemaDigest`)
    if (result.externalEffectReceipt !== null) validateExternalEffectReceipt(result.externalEffectReceipt)
  } else if (result.kind === 'MediatedHostActionFailed') {
    if (!HOST_FAILURE_CODES.has(result.code)
      || result.retryable !== HOST_RETRYABLE_FAILURE_CODES.has(result.code)
      || result.budgetDecision !== 'denied') fail('schema-invalid', 'mediated host failure is invalid')
    validateFailureDetails(result.details, result.code, `${result.kind}.details`)
    if (result.trustAcceptanceFailureDigest !== null
      && !ACCEPTANCE_MAPPED_FAILURE_CODES.has(result.code)) {
      fail('schema-invalid', 'mediated host trust failure digest is invalid for its code')
    }
    if (requiresTrustAcceptanceFailureDigest(result.code)
      && result.trustAcceptanceFailureDigest === null) {
      fail('schema-invalid', 'mediated host failure requires its authenticated trust failure digest')
    }
  } else {
    if (result.trustAcceptanceReceiptDigest === null || result.trustAcceptanceFailureDigest !== null
      || result.budgetDecision !== 'reserved') fail('schema-invalid', 'mediated host indeterminate evidence is invalid')
    digest(result.externalIdempotencyToken, `${result.kind}.externalIdempotencyToken`)
    const recovery = plainRecord(result.mandatoryRecovery, `${result.kind}.mandatoryRecovery`)
    exactKeys(recovery, ['reconcileSameToken', 'retryBeforeReconcile'], [], `${result.kind}.mandatoryRecovery`)
    if (recovery.reconcileSameToken !== true || recovery.retryBeforeReconcile !== false) fail('schema-invalid', 'mediated host recovery is invalid')
  }
  if (computeManagerDocumentDigest(result) !== result.digest) fail('digest-invalid', 'mediated host result digest is invalid')
  assertSecretFree(result, result.kind)
  return value
}

/** @param {unknown} value */
function validateExternalEffectReceipt(value) {
  const receipt = plainRecord(value, 'external effect receipt')
  exactKeys(receipt, ['digest', 'idempotencyToken'], [], 'external effect receipt')
  digest(receipt.digest, 'external effect receipt.digest')
  digest(receipt.idempotencyToken, 'external effect receipt.idempotencyToken')
  assertSecretFree(receipt, 'external effect receipt')
  return receipt
}

/** @param {unknown} value @param {number} maximum */
function safeFailureText(value, maximum) {
  try {
    text(value, 'failure correlation', maximum)
    assertSecretFree(value, 'failure correlation')
    return value
  } catch {
    return null
  }
}

/** @param {unknown} value */
function safeFailureDigest(value) {
  try {
    digest(value, 'failure correlation digest')
    return value
  } catch {
    return `sha256:${'0'.repeat(64)}`
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

/** @param {unknown} left @param {unknown} right */
function sameIdentity(left, right) {
  try {
    const leftIdentity = validateIdentity(left, 'stored instance identity')
    const rightIdentity = validateIdentity(right, 'requested instance identity')
    return ['deploymentId', 'profileId', 'generationId', 'instanceId', 'namespace']
      .every(field => leftIdentity[field] === rightIdentity[field])
  } catch {
    return false
  }
}

/** @param {unknown} value */
function safeFailureEpoch(value) {
  if (value === null || value === undefined) return null
  try {
    uint64(value, 'failure publisher epoch')
    return value
  } catch {
    return null
  }
}

/** @param {unknown} error */
function hostTrustFailureEvidence(error) {
  const rawCode = error instanceof RuntimeManagerError ? error.code : 'authority-unavailable'
  const mapped = mapTrustAuthorityFailureCode(rawCode)
  const authorityKind = error instanceof RuntimeManagerError
    ? error.details.authorityFailureKind : undefined
  const authenticatedAcceptance = authorityKind === 'DshTrustAcceptanceFailed'
    && error instanceof RuntimeManagerError
    && typeof error.details.digest === 'string'
  if (authenticatedAcceptance && HOST_FAILURE_CODES.has(mapped)) {
    return { code: mapped, failureDigest: /** @type {string} */ (error.details.digest) }
  }
  if (authorityKind !== undefined || requiresTrustAcceptanceFailureDigest(mapped)) {
    return { code: 'trust-authority-unavailable', failureDigest: null }
  }
  return {
    code: HOST_FAILURE_CODES.has(mapped) ? mapped : 'trust-authority-unavailable',
    failureDigest: null,
  }
}

/** @param {Record<string, any>} request @param {string} code @param {string | null} state @param {string | null} acceptance @param {string | null} acceptanceFailure */
function failed(request, code, state, acceptance = null, acceptanceFailure = null) {
  if (requiresTrustAcceptanceFailureDigest(code) && acceptanceFailure === null) {
    code = 'trust-authority-unavailable'
  }
  const requestId = safeFailureText(request.requestId, 256)
  const correlated = requestId !== null
  const result = {
    apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'MediatedHostActionFailed',
    digest: `sha256:${'0'.repeat(64)}`, requestId,
    requestDigest: correlated ? safeFailureDigest(request.requestDigest) : `sha256:${'0'.repeat(64)}`,
    identity: correlated ? safeFailureIdentity(request.identity) : null,
    pluginDescriptorDigest: correlated ? safeFailureDigest(request.pluginDescriptorDigest) : `sha256:${'0'.repeat(64)}`,
    pluginId: correlated ? safeFailureText(request.pluginId, 256) : null,
    actionId: correlated ? safeFailureText(request.actionId, 256) : null,
    idempotencyKey: correlated ? safeFailureText(request.idempotencyKey, 256) : null,
    trustAcceptanceReceiptDigest: acceptance,
    trustAcceptanceFailureDigest: acceptanceFailure,
    observedState: state, publisherEpoch: correlated ? safeFailureEpoch(request.publisherEpoch) : null,
    budgetDecision: 'denied', code,
    retryable: HOST_RETRYABLE_FAILURE_CODES.has(code),
    details: {},
  }
  result.digest = computeManagerDocumentDigest(result)
  validateMediatedHostActionResult(result)
  return deepFreeze(result)
}

/** @param {Record<string, any>} request @param {string} state @param {string} acceptance @param {string} externalIdempotencyToken */
function indeterminateEffect(request, state, acceptance, externalIdempotencyToken) {
  const result = {
    apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'MediatedHostActionIndeterminate',
    digest: `sha256:${'0'.repeat(64)}`, requestId: request.requestId,
    requestDigest: request.requestDigest, identity: structuredClone(request.identity),
    pluginDescriptorDigest: request.pluginDescriptorDigest, pluginId: request.pluginId,
    actionId: request.actionId, idempotencyKey: request.idempotencyKey,
    trustAcceptanceReceiptDigest: acceptance, trustAcceptanceFailureDigest: null,
    observedState: state, publisherEpoch: request.publisherEpoch,
    budgetDecision: 'reserved', code: 'external-effect-unknown',
    externalIdempotencyToken,
    mandatoryRecovery: { reconcileSameToken: true, retryBeforeReconcile: false },
  }
  result.digest = computeManagerDocumentDigest(result)
  validateMediatedHostActionResult(result)
  return deepFreeze(result)
}

/**
 * Strict mediated host service. The authorize callback resolves descriptor and
 * seal ceilings without handing private binding state to the plugin.
 * @param {{
 *   store: {instances: Map<string, any>, mutationLocks: Map<string, Promise<any>>},
 *   trustVerifier: {acceptSignedDocument: (input: any) => Promise<{digest: string}>},
 *   authorize: (request: any) => Promise<{allowed: boolean, admissionSealDigest: string, route?: 'github-broker'|'host', code?: string}> | {allowed: boolean, admissionSealDigest: string, route?: 'github-broker'|'host', code?: string},
 *   effect?: (request: any, context: any) => Promise<any> | any,
 *   broker?: (request: any, context: {externalIdempotencyToken: string}) => Promise<any> | any,
 *   journal?: Map<string, any>,
 * }} options
 */
export function createMediatedHostService(options) {
  if (!(options.store.mutationLocks instanceof Map)) fail('invalid-request', 'mediated host requires the workload store shared mutation coordinator')
  const journal = options.journal ?? new Map()
  const mutationLocks = options.store.mutationLocks

  /** @param {unknown} value */
  const executeWithinLock = async value => {
    let request
    try { request = validateMediatedHostActionRequest(value) } catch (error) {
      const candidate = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
      return failed(candidate, error instanceof RuntimeManagerError ? error.code : 'invalid-request', null)
    }
    const instance = options.store.instances.get(request.identity.namespace)
    if (instance === undefined) return failed(request, 'state-conflict', null)
    if (!sameIdentity(instance.identity, request.identity)) return failed(request, 'state-conflict', null)
    if (instance.state !== request.expectedState) return failed(request, 'state-conflict', instance.state)
    const key = `${request.identity.namespace}\0${request.pluginId}\0${request.actionId}\0${request.idempotencyKey}`
    const existing = journal.get(key)
    if (existing !== undefined) {
      if (existing.requestDigest !== request.requestDigest) return failed(request, 'idempotency-conflict', instance.state)
      return existing.result
    }
    const authorization = await options.authorize(structuredClone(request))
    if (authorization?.allowed !== true || authorization.admissionSealDigest !== instance.admissionSealDigest) {
      const code = typeof authorization?.code === 'string' && HOST_ADAPTER_FAILURE_CODES.has(authorization.code)
        ? authorization.code : 'action-denied'
      return failed(request, code, instance.state)
    }
    if (authorization.route !== 'github-broker' && authorization.route !== 'host') {
      const code = ['provider-write', 'credential-use'].includes(request.actionClass)
        ? 'broker-route-required' : 'action-denied'
      return failed(request, code, instance.state)
    }
    if (authorization.route === 'github-broker' && typeof options.broker !== 'function') return failed(request, 'broker-route-required', instance.state)
    try {
      validateRuntimeAssertion(request.runtimeAssertion, {
        sealDigest: instance.admissionSealDigest,
        identity: request.identity, operation: 'host.action',
        semanticRequestDigest: request.requestDigest,
      })
    } catch (error) {
      return failed(request, error instanceof RuntimeManagerError ? error.code : 'assertion-invalid', instance.state)
    }
    /** @type {Record<string, any>} */
    const row = { requestDigest: request.requestDigest, revision: '0', acceptanceDigest: null, result: null }
    journal.set(key, row)
    let acceptance
    try {
      acceptance = await options.trustVerifier.acceptSignedDocument({
        namespace: request.identity.deploymentId,
        acceptanceKind: 'assertion', signedDocument: request.runtimeAssertion,
        operation: 'host.action', semanticRequestDigest: request.requestDigest,
        expectedEffectJournalRevision: row.revision,
      })
      row.acceptanceDigest = acceptance.digest
      row.revision = '1'
    } catch (error) {
      const { code, failureDigest } = hostTrustFailureEvidence(error)
      const result = failed(request, code, instance.state, null, failureDigest)
      row.result = result
      return result
    }
    if (instance.state !== request.expectedState) {
      const result = failed(request, 'state-conflict', instance.state, acceptance.digest)
      row.result = result
      return result
    }
    const externalIdempotencyToken = domainSeparatedDigest('sympoies/mediated-host-effect-idempotency/v1', {
      namespace: request.identity.namespace, pluginId: request.pluginId,
      actionId: request.actionId, idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    })
    let effect
    try {
      const broker = options.broker
      effect = authorization.route === 'github-broker' && typeof broker === 'function'
        ? await broker(structuredClone(request), { externalIdempotencyToken })
        : typeof options.effect === 'function'
          ? await options.effect(structuredClone(request), { externalIdempotencyToken })
          : { status: 'succeeded', outputPayload: null, externalEffectReceipt: null }
    } catch {
      effect = { status: 'indeterminate' }
    }
    if (effect?.status === 'indeterminate' && EFFECTFUL_ACTIONS.has(request.actionClass)) {
      row.result = indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
      return row.result
    }
    if (effect?.status !== 'succeeded') {
      const code = HOST_ADAPTER_FAILURE_CODES.has(effect?.code) ? effect.code : 'resource-denied'
      const result = failed(request, code, instance.state, acceptance.digest)
      row.result = result
      return result
    }
    if (authorization.route === 'github-broker') {
      const brokerReceipt = effect.brokerReceipt
      try {
        validateExternalEffectReceipt(brokerReceipt)
      } catch {
        row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
          ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
          : failed(request, 'broker-state-conflict', instance.state, acceptance.digest)
        return row.result
      }
      if (brokerReceipt.idempotencyToken !== externalIdempotencyToken) {
        row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
          ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
          : failed(request, 'broker-state-conflict', instance.state, acceptance.digest)
        return row.result
      }
    } else if (effect.externalEffectReceipt !== undefined && effect.externalEffectReceipt !== null) {
      try {
        validateExternalEffectReceipt(effect.externalEffectReceipt)
      } catch {
        row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
          ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
          : failed(request, 'resource-denied', instance.state, acceptance.digest)
        return row.result
      }
      if (effect.externalEffectReceipt.idempotencyToken !== externalIdempotencyToken) {
        row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
          ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
          : failed(request, 'resource-denied', instance.state, acceptance.digest)
        return row.result
      }
    }
    try {
      assertCanonicalByteBound(effect.outputPayload ?? null, 'mediated host effect output payload')
    } catch {
      row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
        ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
        : failed(request, 'resource-denied', instance.state, acceptance.digest)
      return row.result
    }
    const result = {
      apiVersion: RUNTIME_MANAGER_API_VERSION, kind: 'MediatedHostActionSucceeded',
      digest: `sha256:${'0'.repeat(64)}`, requestId: request.requestId,
      requestDigest: request.requestDigest, identity: structuredClone(request.identity),
      pluginDescriptorDigest: request.pluginDescriptorDigest, pluginId: request.pluginId,
      actionId: request.actionId, idempotencyKey: request.idempotencyKey,
      trustAcceptanceReceiptDigest: acceptance.digest, trustAcceptanceFailureDigest: null,
      observedState: instance.state, publisherEpoch: request.publisherEpoch,
      budgetDecision: 'committed', outputPayload: structuredClone(effect.outputPayload ?? null),
      outputSchemaDigest: request.outputSchemaDigest,
      externalEffectReceipt: structuredClone(effect.brokerReceipt ?? effect.externalEffectReceipt ?? null),
    }
    try {
      result.digest = computeManagerDocumentDigest(result)
      validateMediatedHostActionResult(result)
    } catch {
      row.result = EFFECTFUL_ACTIONS.has(request.actionClass)
        ? indeterminateEffect(request, instance.state, acceptance.digest, externalIdempotencyToken)
        : failed(request, 'resource-denied', instance.state, acceptance.digest)
      return row.result
    }
    row.result = deepFreeze(result)
    return row.result
  }

  /** @param {unknown} value */
  const execute = async value => {
    const namespace = value !== null && typeof value === 'object'
      && typeof /** @type {any} */ (value).identity?.namespace === 'string'
      ? /** @type {any} */ (value).identity.namespace : null
    if (namespace === null) return executeWithinLock(value)
    const previous = mutationLocks.get(namespace) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => executeWithinLock(value))
    mutationLocks.set(namespace, current)
    try {
      return await current
    } finally {
      if (mutationLocks.get(namespace) === current) mutationLocks.delete(namespace)
    }
  }

  return Object.freeze({ execute, journal })
}
