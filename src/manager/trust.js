// @ts-check

import { randomBytes } from 'node:crypto'

import {
  INFRA_API_VERSION,
  RuntimeManagerError,
  TRUST_FAILURE_CODE_MAP,
  assertCanonicalByteBound,
  assertSecretFree,
  computeManagerDocumentDigest,
  computeTrustAuthorityObservationDigest,
  digest,
  exactKeys,
  fail,
  nonce as validateNonce,
  plainRecord,
  text,
  uint64,
  utc,
  validateTrustBundle,
  validateTrustLineageHead,
  verifyProtocolSignature,
} from './contracts.js'

const MAX_DATAGRAM_BYTES = 1024 * 1024
const MAX_TRANSITION_BYTES = 8 * 1024
/** @type {WeakMap<Map<any, any>, Map<string, Promise<any>>>} */
const TRUST_STATE_COORDINATORS = new WeakMap()
const AUTHORITY_FAILURE_CODES = Object.freeze({
  DshTrustLineageReadFailed: new Set([
    'invalid-request', 'unauthenticated', 'unauthorized', 'namespace-not-found',
    'stale-expected-head', 'snapshot-unavailable', 'time-revision-conflict',
    'time-revision-exhausted', 'replayed-nonce', 'authority-clock-unavailable',
    'lineage-unavailable', 'lineage-invalid',
  ]),
  DshTrustBundleReadFailed: new Set([
    'invalid-request', 'unauthenticated', 'unauthorized', 'namespace-not-found',
    'snapshot-unavailable', 'bundle-not-found', 'bundle-unreachable',
    'replayed-nonce', 'lineage-unavailable', 'bundle-invalid',
  ]),
  DshTrustAcceptanceFailed: new Set(Object.keys(TRUST_FAILURE_CODE_MAP)),
})
const AUTHORITY_RETRYABLE_CODES = Object.freeze({
  DshTrustLineageReadFailed: new Set([
    'stale-expected-head', 'snapshot-unavailable', 'time-revision-conflict',
    'authority-clock-unavailable', 'lineage-unavailable',
  ]),
  DshTrustBundleReadFailed: new Set(['snapshot-unavailable', 'lineage-unavailable']),
  DshTrustAcceptanceFailed: new Set([
    'stale-expected-head', 'time-revision-conflict',
    'authority-clock-unavailable', 'authority-unavailable',
  ]),
})

/** @param {unknown} value @param {string} path */
function boundedDatagram(value, path) {
  assertCanonicalByteBound(value, path, MAX_DATAGRAM_BYTES)
}

/** @param {unknown} value */
function validateTransition(value) {
  const transition = plainRecord(value, 'DshTrustBundleTransition')
  exactKeys(transition, [
    'apiVersion', 'kind', 'metadata', 'priorBundleDigest', 'nextBundleDigest',
    'sequence', 'effectiveAt', 'keyStateChanges', 'retirementOverlapEnds',
    'reasonCode', 'signerKeyId', 'signature',
  ], [], 'DshTrustBundleTransition')
  if (transition.apiVersion !== INFRA_API_VERSION || transition.kind !== 'DshTrustBundleTransition') fail('lineage-invalid', 'trust transition identity is invalid')
  const metadata = plainRecord(transition.metadata, 'DshTrustBundleTransition.metadata')
  exactKeys(metadata, ['digest'], [], 'DshTrustBundleTransition.metadata')
  digest(metadata.digest, 'DshTrustBundleTransition.metadata.digest')
  digest(transition.priorBundleDigest, 'DshTrustBundleTransition.priorBundleDigest')
  digest(transition.nextBundleDigest, 'DshTrustBundleTransition.nextBundleDigest')
  uint64(transition.sequence, 'DshTrustBundleTransition.sequence')
  utc(transition.effectiveAt, 'DshTrustBundleTransition.effectiveAt')
  if (!Array.isArray(transition.keyStateChanges) || transition.keyStateChanges.length > 2048
    || !Array.isArray(transition.retirementOverlapEnds) || transition.retirementOverlapEnds.length > 2048) {
    fail('lineage-invalid', 'trust transition arrays are invalid')
  }
  for (const [index, item] of transition.keyStateChanges.entries()) {
    const change = plainRecord(item, `DshTrustBundleTransition.keyStateChanges[${index}]`)
    exactKeys(change, ['keyId', 'priorState', 'nextState'], [], `DshTrustBundleTransition.keyStateChanges[${index}]`)
    text(change.keyId, `DshTrustBundleTransition.keyStateChanges[${index}].keyId`, 72)
    if (change.priorState !== null && !['active', 'retired', 'revoked'].includes(change.priorState)) fail('lineage-invalid', 'trust transition prior state is invalid')
    if (!['active', 'retired', 'revoked', 'removed'].includes(change.nextState)) fail('lineage-invalid', 'trust transition next state is invalid')
  }
  for (const [index, item] of transition.retirementOverlapEnds.entries()) {
    const overlap = plainRecord(item, `DshTrustBundleTransition.retirementOverlapEnds[${index}]`)
    exactKeys(overlap, ['keyId', 'endsAt'], [], `DshTrustBundleTransition.retirementOverlapEnds[${index}]`)
    text(overlap.keyId, `DshTrustBundleTransition.retirementOverlapEnds[${index}].keyId`, 72)
    utc(overlap.endsAt, `DshTrustBundleTransition.retirementOverlapEnds[${index}].endsAt`)
    if (Date.parse(overlap.endsAt) <= Date.parse(transition.effectiveAt)) fail('lineage-invalid', 'retirement overlap must end after transition activation')
  }
  text(transition.reasonCode, 'DshTrustBundleTransition.reasonCode', 128)
  text(transition.signerKeyId, 'DshTrustBundleTransition.signerKeyId', 72)
  text(transition.signature, 'DshTrustBundleTransition.signature', 128)
  if (computeManagerDocumentDigest(transition) !== metadata.digest) fail('digest-invalid', 'trust transition digest is invalid')
  if (Buffer.byteLength(JSON.stringify(transition)) > MAX_TRANSITION_BYTES) fail('lineage-invalid', 'trust transition exceeds 8 KiB')
  return transition
}

/** @param {Record<string, any>} transition @param {Record<string, any>} prior @param {Record<string, any>} next @param {string} authorityTime @param {Set<string>} tombstones */
function validateTransitionEdge(transition, prior, next, authorityTime, tombstones) {
  if (prior.namespace !== next.namespace || transition.priorBundleDigest !== prior.metadata.digest
    || transition.nextBundleDigest !== next.metadata.digest) fail('lineage-invalid', 'trust transition bundle identity is inconsistent')
  if (Date.parse(transition.effectiveAt) > Date.parse(authorityTime)) fail('lineage-invalid', 'future-effective trust transition is not authoritative')
  const priorKeys = new Map(prior.keys.map((/** @type {Record<string, any>} */ key) => [key.keyId, key]))
  const nextKeys = new Map(next.keys.map((/** @type {Record<string, any>} */ key) => [key.keyId, key]))
  const signer = priorKeys.get(transition.signerKeyId)
  if (signer === undefined || signer.use !== 'trust-transition' || signer.state !== 'active') fail('signature-trust-unapproved', 'trust transition signer is not active in the prior bundle')
  /** @type {Record<string, any>[]} */
  const expectedChanges = []
  const keyIds = [...new Set([...priorKeys.keys(), ...nextKeys.keys()])].sort()
  for (const keyId of keyIds) {
    const before = priorKeys.get(keyId)
    const after = nextKeys.get(keyId)
    if (before === undefined) {
      if (tombstones.has(keyId) || after.state !== 'active') fail('lineage-invalid', 'trust key was reactivated or did not enter active')
      expectedChanges.push({ keyId, priorState: null, nextState: 'active' })
      continue
    }
    if (after === undefined) {
      if (before.state !== 'revoked') fail('lineage-invalid', 'only a revoked trust key may be removed')
      expectedChanges.push({ keyId, priorState: 'revoked', nextState: 'removed' })
      tombstones.add(keyId)
      continue
    }
    if (before.algorithm !== after.algorithm || before.use !== after.use || before.rawPublicKeyHex !== after.rawPublicKeyHex) {
      fail('lineage-invalid', 'trust key material or use is immutable')
    }
    if (before.state === after.state) continue
    const allowed = before.state === 'active'
      ? ['retired', 'revoked']
      : before.state === 'retired'
        ? ['revoked']
        : []
    if (!allowed.includes(after.state)) fail('lineage-invalid', 'trust key state transition is irreversible')
    expectedChanges.push({ keyId, priorState: before.state, nextState: after.state })
  }
  if (transition.keyStateChanges.map((/** @type {Record<string, any>} */ change) => change.keyId).join('\0')
    !== [...transition.keyStateChanges].map((/** @type {Record<string, any>} */ change) => change.keyId).sort().join('\0')
    || JSON.stringify(transition.keyStateChanges) !== JSON.stringify(expectedChanges)) {
    fail('lineage-invalid', 'trust transition state changes do not equal the bundle diff')
  }
  const requiredOverlaps = expectedChanges
    .filter(change => change.priorState === 'active' && change.nextState === 'retired' && priorKeys.get(change.keyId)?.use === 'assertion')
    .map(change => change.keyId)
  const overlapIds = transition.retirementOverlapEnds.map((/** @type {Record<string, any>} */ overlap) => overlap.keyId)
  if (overlapIds.join('\0') !== [...overlapIds].sort().join('\0')
    || overlapIds.join('\0') !== requiredOverlaps.join('\0')) {
    fail('lineage-invalid', 'trust transition retirement overlaps are not exact')
  }
}

/**
 * Validate one complete authorized lineage edge, including immutable key
 * material/use, irreversible state changes, exact overlap declarations, and
 * the prior-bundle transition signature.
 * @param {unknown} value
 * @param {unknown} priorValue
 * @param {unknown} nextValue
 * @param {{authorityTime: string, tombstones?: Set<string>}} options
 */
export function validateTrustBundleTransition(value, priorValue, nextValue, options) {
  const transition = validateTransition(value)
  const prior = validateTrustBundle(priorValue)
  const next = validateTrustBundle(nextValue)
  utc(options.authorityTime, 'trust transition authorityTime')
  validateTransitionEdge(transition, prior, next, options.authorityTime, options.tombstones ?? new Set())
  verifyProtocolSignature(transition, prior, 'trust-transition')
  return value
}

/** @param {Record<string, any>} response @param {Record<string, any>} request @param {string} controllerIdentity */
function validateLineageSuccess(response, request, controllerIdentity) {
  exactKeys(response, [
    'apiVersion', 'kind', 'digest', 'requestId', 'requestDigest',
    'challengeNonce', 'namespace', 'controllerIdentity', 'snapshotHead',
    'snapshotHeadDigest', 'currentHeadDigest',
    'snapshotAuthorityObservationDigest', 'afterSequence', 'pageStartSequence',
    'pageEndSequence', 'nextAfterSequence', 'complete', 'transitions',
    'authorityTime', 'priorAuthorityTime', 'timeRevision', 'priorTimeRevision',
    'clockHealth', 'controllerReceiptDigest',
  ], [], 'DshTrustLineageReadSucceeded')
  if (response.apiVersion !== INFRA_API_VERSION || response.kind !== 'DshTrustLineageReadSucceeded') fail('lineage-invalid', 'lineage response identity is invalid')
  if (response.requestId !== request.requestId || response.requestDigest !== request.requestDigest
    || response.challengeNonce !== request.challengeNonce || response.namespace !== request.namespace
    || response.controllerIdentity !== controllerIdentity || response.afterSequence !== request.afterSequence) {
    fail('lineage-invalid', 'lineage response correlation is invalid')
  }
  digest(response.digest, 'DshTrustLineageReadSucceeded.digest')
  const head = validateTrustLineageHead(response.snapshotHead)
  if (head.namespace !== request.namespace
    || response.snapshotHeadDigest !== head.digest
    || response.currentHeadDigest !== response.snapshotHeadDigest) {
    fail('lineage-invalid', 'lineage response substitutes its snapshot or namespace')
  }
  digest(response.currentHeadDigest, 'DshTrustLineageReadSucceeded.currentHeadDigest')
  digest(response.snapshotAuthorityObservationDigest, 'DshTrustLineageReadSucceeded.snapshotAuthorityObservationDigest')
  uint64(response.afterSequence, 'DshTrustLineageReadSucceeded.afterSequence')
  for (const field of ['pageStartSequence', 'pageEndSequence', 'nextAfterSequence']) if (response[field] !== null) uint64(response[field], `DshTrustLineageReadSucceeded.${field}`)
  if (typeof response.complete !== 'boolean' || !Array.isArray(response.transitions)
    || response.transitions.length > 64 || response.transitions.length > request.pageLimit) fail('lineage-invalid', 'lineage page shape is invalid')
  for (const transition of response.transitions) validateTransition(transition)
  utc(response.authorityTime, 'DshTrustLineageReadSucceeded.authorityTime')
  if (response.priorAuthorityTime !== null) utc(response.priorAuthorityTime, 'DshTrustLineageReadSucceeded.priorAuthorityTime')
  uint64(response.timeRevision, 'DshTrustLineageReadSucceeded.timeRevision')
  if (response.priorTimeRevision !== null) uint64(response.priorTimeRevision, 'DshTrustLineageReadSucceeded.priorTimeRevision')
  if (response.clockHealth !== 'healthy') fail('authority-clock-unavailable', 'trust authority clock is unavailable')
  digest(response.controllerReceiptDigest, 'DshTrustLineageReadSucceeded.controllerReceiptDigest')
  if (computeTrustAuthorityObservationDigest(response) !== response.snapshotAuthorityObservationDigest) fail('lineage-invalid', 'lineage authority observation digest is invalid')
  if (computeManagerDocumentDigest(response) !== response.digest) fail('digest-invalid', 'lineage response digest is invalid')
  boundedDatagram(response, 'lineage response')
  return { response, head }
}

/** @param {Record<string, any>} response @param {Record<string, any>} request @param {string} controllerIdentity @param {string} observationDigest */
function validateBundleSuccess(response, request, controllerIdentity, observationDigest) {
  exactKeys(response, [
    'apiVersion', 'kind', 'digest', 'requestId', 'requestDigest',
    'challengeNonce', 'namespace', 'controllerIdentity', 'snapshotHeadDigest',
    'snapshotAuthorityObservationDigest', 'bundleDigest', 'bundle',
    'controllerReceiptDigest',
  ], [], 'DshTrustBundleReadSucceeded')
  if (response.apiVersion !== INFRA_API_VERSION || response.kind !== 'DshTrustBundleReadSucceeded') fail('bundle-invalid', 'bundle response identity is invalid')
  if (response.requestId !== request.requestId || response.requestDigest !== request.requestDigest
    || response.challengeNonce !== request.challengeNonce || response.namespace !== request.namespace
    || response.controllerIdentity !== controllerIdentity
    || response.snapshotHeadDigest !== request.snapshotHeadDigest
    || response.snapshotAuthorityObservationDigest !== observationDigest
    || response.bundleDigest !== request.bundleDigest) fail('bundle-invalid', 'bundle response correlation is invalid')
  const bundle = validateTrustBundle(response.bundle)
  if (bundle.namespace !== request.namespace || bundle.metadata.digest !== response.bundleDigest) {
    fail('bundle-invalid', 'bundle material namespace or digest is substituted')
  }
  digest(response.controllerReceiptDigest, 'DshTrustBundleReadSucceeded.controllerReceiptDigest')
  if (computeManagerDocumentDigest(response) !== response.digest) fail('digest-invalid', 'bundle response digest is invalid')
  boundedDatagram(response, 'bundle response')
  return bundle
}

/**
 * @param {'lineage'|'bundle'|'acceptance'} port
 * @param {Record<string, any>} response
 * @param {Record<string, any>} request
 * @param {string} controllerIdentity
 */
function validateAuthorityFailure(port, response, request, controllerIdentity) {
  assertCanonicalByteBound(response, 'trust authority failure', MAX_DATAGRAM_BYTES)
  const expectedKind = port === 'lineage'
    ? 'DshTrustLineageReadFailed'
    : port === 'bundle'
      ? 'DshTrustBundleReadFailed'
      : 'DshTrustAcceptanceFailed'
  const common = [
    'apiVersion', 'kind', 'digest', 'requestId', 'requestDigest',
    'challengeNonce', 'namespace', 'controllerIdentity',
    'code', 'retryable', 'currentHeadDigest', 'currentTimeRevision', 'details',
  ]
  const correlation = port === 'lineage'
    ? []
    : port === 'bundle'
      ? ['bundleDigest', 'snapshotHeadDigest']
      : ['acceptanceKind', 'signedDocumentDigest', 'semanticRequestDigest']
  exactKeys(response, [...common, ...correlation], [], expectedKind)
  if (response.apiVersion !== INFRA_API_VERSION || response.kind !== expectedKind) {
    fail('schema-invalid', `${expectedKind} identity is invalid`)
  }
  const allowedCodes = /** @type {Record<string, Set<string>>} */ (AUTHORITY_FAILURE_CODES)[expectedKind]
  const retryableCodes = /** @type {Record<string, Set<string>>} */ (AUTHORITY_RETRYABLE_CODES)[expectedKind]
  if (!allowedCodes.has(response.code)
    || response.retryable !== retryableCodes.has(response.code)) {
    fail('schema-invalid', `${expectedKind} code or retryability is invalid`)
  }
  digest(response.digest, `${expectedKind}.digest`)
  if (response.requestId !== null) text(response.requestId, `${expectedKind}.requestId`, 256)
  if (response.requestDigest !== null) digest(response.requestDigest, `${expectedKind}.requestDigest`)
  if (response.challengeNonce !== null) validateNonce(response.challengeNonce, `${expectedKind}.challengeNonce`)
  if (response.controllerIdentity !== null) text(response.controllerIdentity, `${expectedKind}.controllerIdentity`, 256)
  if (response.namespace !== null) text(response.namespace, `${expectedKind}.namespace`, 256)
  if (response.currentHeadDigest !== null) digest(response.currentHeadDigest, `${expectedKind}.currentHeadDigest`)
  if (response.currentTimeRevision !== null) uint64(response.currentTimeRevision, `${expectedKind}.currentTimeRevision`)
  const mismatchCode = port === 'lineage'
    ? 'lineage-invalid' : port === 'bundle' ? 'bundle-invalid' : 'trust-authority-unavailable'
  const expectedCorrelation = {
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    challengeNonce: request.challengeNonce,
    namespace: request.namespace,
    controllerIdentity,
    ...(port === 'bundle' ? {
      bundleDigest: request.bundleDigest,
      snapshotHeadDigest: request.snapshotHeadDigest,
    } : {}),
    ...(port === 'acceptance' ? {
      acceptanceKind: request.acceptanceKind,
      signedDocumentDigest: request.signedDocumentDigest,
      semanticRequestDigest: request.semanticRequestDigest,
    } : {}),
  }
  const correlationMatches = Object.entries(expectedCorrelation)
    .every(([field, expected]) => response[field] === null || response[field] === expected)
  const nullableCorrelation = ['invalid-request', 'unauthenticated', 'unauthorized'].includes(response.code)
  const completeCorrelation = Object.keys(expectedCorrelation).every(field => response[field] !== null)
  if (!correlationMatches || (!nullableCorrelation && !completeCorrelation)) {
    fail(mismatchCode, `${expectedKind} correlation is invalid`)
  }
  for (const field of correlation) {
    if (response[field] !== null && field === 'acceptanceKind'
      && !['seal', 'assertion'].includes(response[field])) fail('schema-invalid', `${expectedKind}.${field} is invalid`)
    if (response[field] !== null && field !== 'acceptanceKind') digest(response[field], `${expectedKind}.${field}`)
  }
  plainRecord(response.details, `${expectedKind}.details`)
  assertCanonicalByteBound(response.details, `${expectedKind}.details`, 8 * 1024)
  if (computeManagerDocumentDigest(response) !== response.digest) fail('digest-invalid', `${expectedKind} digest is invalid`)
  assertSecretFree(response, expectedKind)
  return response
}

/** @param {string} label @param {Record<string, any>} response */
function throwAuthorityFailure(label, response) {
  throw new RuntimeManagerError(response.code, `${label} failed`, {
    retryable: response.retryable,
    digest: response.digest,
    authorityFailureKind: response.kind,
  })
}

/**
 * Verifier-owned trust bootstrap and authenticated authority adapter.
 * @param {{
 *   authority: {readLineage: (request: any) => Promise<any>, readBundle: (request: any) => Promise<any>, accept?: (request: any) => Promise<any>},
 *   bootstrap: Record<string, {genesisBundleDigest: string, controllerIdentity: string}>,
 *   nonce?: () => string,
 *   state?: Map<string, {timeRevision: string, authorityTime: string, observationDigest: string, head?: Record<string, any>, bundles?: Map<string, Record<string, any>>, tombstones?: Set<string>}>,
 * }} options
 */
export function createTrustVerifier(options) {
  if (options === null || typeof options !== 'object' || options.authority === undefined) fail('invalid-request', 'trust verifier options are invalid')
  const nonceSource = options.nonce ?? (() => randomBytes(16).toString('base64url'))
  const state = options.state ?? new Map()
  let namespaceLocks = TRUST_STATE_COORDINATORS.get(state)
  if (namespaceLocks === undefined) {
    namespaceLocks = new Map()
    TRUST_STATE_COORDINATORS.set(state, namespaceLocks)
  }
  let requestSequence = 0

  const freshId = (/** @type {string} */ prefix) => `${prefix}-${++requestSequence}`

  /** @param {string} namespace @param {() => Promise<any>} action */
  const serializeNamespace = async (namespace, action) => {
    const previous = namespaceLocks.get(namespace) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    namespaceLocks.set(namespace, current)
    try {
      return await current
    } finally {
      if (namespaceLocks.get(namespace) === current) namespaceLocks.delete(namespace)
    }
  }

  /** @param {string} namespace @param {Record<string, any>} head @param {string} observationDigest @param {string} bundleDigest */
  const readBundle = async (namespace, head, observationDigest, bundleDigest) => {
    const bootstrap = options.bootstrap[namespace]
    const request = {
      apiVersion: INFRA_API_VERSION,
      kind: 'DshTrustBundleReadRequest',
      requestId: freshId('bundle'),
      namespace,
      bundleDigest,
      snapshotHeadDigest: head.digest,
      snapshotAuthorityObservationDigest: observationDigest,
      challengeNonce: nonceSource(),
      requestDigest: `sha256:${'0'.repeat(64)}`,
    }
    validateNonce(request.challengeNonce, 'DshTrustBundleReadRequest.challengeNonce')
    request.requestDigest = computeManagerDocumentDigest(request)
    const result = plainRecord(await options.authority.readBundle(structuredClone(request)), 'bundle authority response')
    if (result.kind === 'DshTrustBundleReadFailed') {
      validateAuthorityFailure('bundle', result, request, bootstrap.controllerIdentity)
      throwAuthorityFailure('bundle read', result)
    }
    return structuredClone(validateBundleSuccess(result, request, bootstrap.controllerIdentity, observationDigest))
  }

  /** @param {string} namespace */
  const refreshCurrent = async namespace => {
    const bootstrap = options.bootstrap[namespace]
    if (bootstrap === undefined) fail('signature-trust-unapproved', 'namespace has no verifier-owned bootstrap')
    digest(bootstrap.genesisBundleDigest, 'bootstrap.genesisBundleDigest')
    text(bootstrap.controllerIdentity, 'bootstrap.controllerIdentity', 256)
    const retained = state.get(namespace)
    let reuseCached = retained?.head !== undefined && retained?.bundles instanceof Map
    let snapshotHeadDigest = reuseCached ? retained.head.digest : null
    let observationDigest = null
    let afterSequence = reuseCached ? retained.head.sequence : '0'
    let expectedCurrentHeadDigest = reuseCached ? retained.head.digest : null
    let startingSequence = afterSequence
    /** @type {Record<string, any> | null} */
    let head = null
    /** @type {Record<string, any> | null} */
    let firstResponse = null
    let transitionCount = 0n
    /** @type {string | null} */
    let lastSequence = null
    /** @type {string | null} */
    let lastTransitionDigest = null
    let expectedBundle = reuseCached ? retained.head.bundleDigest : bootstrap.genesisBundleDigest
    let baseBundles = reuseCached ? retained.bundles : new Map()
    let stagedBundles = new Map()
    /** @type {Record<string, any> | null} */
    let priorBundle = reuseCached ? baseBundles.get(expectedBundle) ?? null : null
    let baseTombstones = reuseCached ? retained.tombstones ?? new Set() : new Set()
    let stagedTombstones = new Set()
    const tombstoneView = () => ({
      has: (/** @type {string} */ key) => baseTombstones.has(key) || stagedTombstones.has(key),
      add: (/** @type {string} */ key) => { stagedTombstones.add(key); return stagedTombstones },
    })
    while (true) {
      const request = {
        apiVersion: INFRA_API_VERSION,
        kind: 'DshTrustLineageReadRequest',
        requestId: freshId('lineage'),
        namespace,
        expectedCurrentHeadDigest,
        snapshotHeadDigest,
        snapshotAuthorityObservationDigest: observationDigest,
        afterSequence,
        pageLimit: 64,
        minimumTimeRevision: firstResponse === null ? retained?.timeRevision ?? null : null,
        challengeNonce: nonceSource(),
        requestDigest: `sha256:${'0'.repeat(64)}`,
      }
      validateNonce(request.challengeNonce, 'DshTrustLineageReadRequest.challengeNonce')
      request.requestDigest = computeManagerDocumentDigest(request)
      const result = plainRecord(await options.authority.readLineage(structuredClone(request)), 'lineage authority response')
      if (result.kind === 'DshTrustLineageReadFailed') {
        validateAuthorityFailure('lineage', result, request, bootstrap.controllerIdentity)
        if (firstResponse === null && reuseCached && result.code === 'stale-expected-head') {
          reuseCached = false
          snapshotHeadDigest = null
          observationDigest = null
          afterSequence = '0'
          startingSequence = '0'
          expectedCurrentHeadDigest = null
          transitionCount = 0n
          lastSequence = null
          lastTransitionDigest = null
          expectedBundle = bootstrap.genesisBundleDigest
          baseBundles = new Map()
          stagedBundles = new Map()
          priorBundle = null
          baseTombstones = new Set()
          stagedTombstones = new Set()
          continue
        }
        throwAuthorityFailure('lineage read', result)
      }
      const validated = validateLineageSuccess(result, request, bootstrap.controllerIdentity)
      if (firstResponse === null) {
        firstResponse = result
        head = validated.head
        snapshotHeadDigest = head.digest
        observationDigest = result.snapshotAuthorityObservationDigest
        if (head.genesisBundleDigest !== bootstrap.genesisBundleDigest) fail('signature-trust-unapproved', 'lineage genesis is not verifier-pinned')
        if (retained !== undefined) {
          if (BigInt(result.timeRevision) <= BigInt(retained.timeRevision)
            || Date.parse(result.authorityTime) < Date.parse(retained.authorityTime)) {
            fail('time-revision-conflict', 'trust authority revision or time did not advance')
          }
          if (result.priorTimeRevision !== retained.timeRevision
            || result.priorAuthorityTime !== retained.authorityTime) {
            fail('time-revision-conflict', 'trust authority prior observation is inconsistent')
          }
        }
      } else if (result.snapshotHeadDigest !== snapshotHeadDigest
        || result.snapshotAuthorityObservationDigest !== observationDigest
        || result.timeRevision !== firstResponse.timeRevision
        || result.authorityTime !== firstResponse.authorityTime) {
        fail('lineage-invalid', 'lineage continuation substituted its retained observation')
      }
      const expectedNext = BigInt(afterSequence) + 1n
      if (result.transitions.length > 0 && BigInt(result.transitions[0].sequence) !== expectedNext) fail('lineage-invalid', 'lineage page contains a gap')
      if (result.transitions.length === 0) {
        if (!result.complete || result.pageStartSequence !== null || result.pageEndSequence !== null
          || BigInt(afterSequence) !== BigInt(validated.head.sequence)) fail('lineage-invalid', 'empty lineage page is not terminal')
      } else {
        const first = result.transitions[0].sequence
        const last = result.transitions.at(-1).sequence
        if (result.pageStartSequence !== first || result.pageEndSequence !== last) fail('lineage-invalid', 'lineage page bounds are inconsistent')
        if (result.complete) {
          if (result.nextAfterSequence !== null || last !== validated.head.sequence) fail('lineage-invalid', 'terminal lineage page does not reach the snapshot head')
        } else if (result.nextAfterSequence !== last || BigInt(last) >= BigInt(validated.head.sequence)) {
          fail('lineage-invalid', 'lineage continuation cursor is inconsistent')
        }
      }
      if (priorBundle === null && (result.transitions.length > 0 || result.complete)) {
        priorBundle = baseBundles.get(expectedBundle)
          ?? stagedBundles.get(expectedBundle)
          ?? await readBundle(namespace, validated.head, result.snapshotAuthorityObservationDigest, expectedBundle)
        stagedBundles.set(expectedBundle, priorBundle)
      }
      for (const transition of result.transitions) {
        const previousSequence = lastSequence ?? startingSequence
        if (BigInt(transition.sequence) !== BigInt(previousSequence) + 1n) fail('lineage-invalid', 'lineage transitions are not contiguous')
        if (transition.priorBundleDigest !== expectedBundle || priorBundle === null) fail('lineage-invalid', 'lineage transition prior bundle is invalid')
        const nextBundle = await readBundle(
          namespace, validated.head, result.snapshotAuthorityObservationDigest,
          transition.nextBundleDigest,
        )
        validateTrustBundleTransition(transition, priorBundle, nextBundle, {
          authorityTime: firstResponse.authorityTime,
          tombstones: /** @type {Set<string>} */ (/** @type {unknown} */ (tombstoneView())),
        })
        expectedBundle = transition.nextBundleDigest
        priorBundle = nextBundle
        stagedBundles.set(expectedBundle, nextBundle)
        lastSequence = transition.sequence
        lastTransitionDigest = transition.metadata.digest
        transitionCount += 1n
      }
      if (result.complete) {
        if (result.nextAfterSequence !== null) fail('lineage-invalid', 'complete lineage page has a continuation')
        break
      }
      if (result.nextAfterSequence === null || BigInt(result.nextAfterSequence) <= BigInt(afterSequence)) fail('lineage-invalid', 'lineage pagination made no progress')
      afterSequence = result.nextAfterSequence
      expectedCurrentHeadDigest = null
    }
    if (head === null || firstResponse === null || observationDigest === null) fail('lineage-invalid', 'lineage observation is incomplete')
    if (BigInt(head.sequence) - BigInt(startingSequence) !== transitionCount) fail('lineage-invalid', 'lineage transition count does not reach its head')
    if (transitionCount > 0n && head.transitionDigest !== lastTransitionDigest) fail('lineage-invalid', 'lineage head does not name its terminal transition')
    if (expectedBundle !== head.bundleDigest) fail('lineage-invalid', 'lineage does not reach the snapshot head bundle')
    if (priorBundle === null) {
      priorBundle = await readBundle(namespace, head, observationDigest, expectedBundle)
      stagedBundles.set(expectedBundle, priorBundle)
    }
    const bundles = baseBundles
    for (const [bundleDigest, bundle] of stagedBundles) bundles.set(bundleDigest, bundle)
    const tombstones = baseTombstones
    for (const keyId of stagedTombstones) tombstones.add(keyId)
    state.set(namespace, {
      timeRevision: firstResponse.timeRevision,
      authorityTime: firstResponse.authorityTime,
      observationDigest,
      head: structuredClone(head),
      bundles,
      tombstones,
    })
    return Object.freeze({
      head,
      bundles,
      observationDigest,
      authorityTime: firstResponse.authorityTime,
      timeRevision: firstResponse.timeRevision,
    })
  }

  /** @param {string} namespace */
  const readCurrent = async namespace => serializeNamespace(namespace, async () => {
    const snapshot = await refreshCurrent(namespace)
    return Object.freeze({
      head: structuredClone(snapshot.head),
      bundles: new Map([...snapshot.bundles].map(([key, value]) => [key, structuredClone(value)])),
      observationDigest: snapshot.observationDigest,
      authorityTime: snapshot.authorityTime,
      timeRevision: snapshot.timeRevision,
    })
  })

  /** @param {{namespace: string, acceptanceKind: 'seal'|'assertion', signedDocument: any, operation: string, semanticRequestDigest: string, expectedEffectJournalRevision: string}} input */
  const acceptSignedDocument = async input => serializeNamespace(input.namespace, async () => {
    if (typeof options.authority.accept !== 'function') fail('trust-authority-unavailable', 'trust acceptance authority is unavailable')
    const snapshot = await refreshCurrent(input.namespace)
    const bundleDigest = input.signedDocument.bundleDigest
    const bundle = snapshot.bundles.get(bundleDigest)
    if (bundle === undefined) fail('bundle-unreachable', 'signed document trust bundle is not reachable from the verified lineage')
    verifyProtocolSignature(input.signedDocument, bundle, input.acceptanceKind)
    const request = {
      apiVersion: INFRA_API_VERSION,
      kind: 'DshTrustAcceptanceRequest',
      requestId: freshId('acceptance'),
      namespace: input.namespace,
      acceptanceKind: input.acceptanceKind,
      signedDocumentKind: input.signedDocument.kind,
      signedDocument: structuredClone(input.signedDocument),
      signedDocumentDigest: input.signedDocument.metadata.digest,
      expectedCurrentHeadDigest: snapshot.head.digest,
      minimumTimeRevision: snapshot.timeRevision,
      operation: input.operation,
      semanticRequestDigest: input.semanticRequestDigest,
      expectedEffectJournalRevision: input.expectedEffectJournalRevision,
      challengeNonce: nonceSource(),
      requestDigest: `sha256:${'0'.repeat(64)}`,
    }
    request.requestDigest = computeManagerDocumentDigest(request)
    const response = plainRecord(await options.authority.accept(structuredClone(request)), 'trust acceptance response')
    if (response.kind === 'DshTrustAcceptanceFailed') {
      validateAuthorityFailure('acceptance', response, request, options.bootstrap[input.namespace].controllerIdentity)
      throwAuthorityFailure('trust acceptance', response)
    }
    if (response.kind !== 'DshTrustAcceptanceSucceeded') fail('trust-authority-unavailable', 'trust acceptance response kind is invalid')
    exactKeys(response, [
      'apiVersion', 'kind', 'digest', 'requestId', 'requestDigest',
      'challengeNonce', 'controllerIdentity', 'namespace', 'acceptanceKind',
      'signedDocumentKind', 'signedDocumentDigest', 'keyId', 'keyUse',
      'bundleDigest', 'operation', 'semanticRequestDigest',
      'expectedEffectJournalRevision', 'acceptedCurrentHeadDigest',
      'authorityTime', 'priorAuthorityTime', 'timeRevision',
      'priorTimeRevision', 'controllerReceiptDigest', 'acceptedAt',
    ], [], 'DshTrustAcceptanceSucceeded')
    if (response.apiVersion !== INFRA_API_VERSION) fail('trust-authority-unavailable', 'trust acceptance response apiVersion is invalid')
    digest(response.digest, 'DshTrustAcceptanceSucceeded.digest')
    if (response.requestId !== request.requestId || response.requestDigest !== request.requestDigest
      || response.challengeNonce !== request.challengeNonce
      || response.controllerIdentity !== options.bootstrap[input.namespace].controllerIdentity
      || response.namespace !== request.namespace
      || response.acceptanceKind !== request.acceptanceKind
      || response.signedDocumentKind !== request.signedDocumentKind
      || response.signedDocumentDigest !== request.signedDocumentDigest
      || response.keyId !== input.signedDocument.keyId
      || response.keyUse !== input.acceptanceKind
      || response.bundleDigest !== input.signedDocument.bundleDigest
      || response.operation !== request.operation
      || response.semanticRequestDigest !== request.semanticRequestDigest
      || response.expectedEffectJournalRevision !== request.expectedEffectJournalRevision
      || response.acceptedCurrentHeadDigest !== snapshot.head.digest) {
      fail('trust-authority-unavailable', 'trust acceptance response correlation is invalid')
    }
    utc(response.authorityTime, 'DshTrustAcceptanceSucceeded.authorityTime')
    if (response.priorAuthorityTime !== snapshot.authorityTime
      || response.priorTimeRevision !== snapshot.timeRevision
      || BigInt(response.timeRevision) !== BigInt(snapshot.timeRevision) + 1n
      || Date.parse(response.authorityTime) < Date.parse(snapshot.authorityTime)) {
      fail('time-revision-conflict', 'trust acceptance response time lineage is invalid')
    }
    uint64(response.timeRevision, 'DshTrustAcceptanceSucceeded.timeRevision')
    digest(response.controllerReceiptDigest, 'DshTrustAcceptanceSucceeded.controllerReceiptDigest')
    utc(response.acceptedAt, 'DshTrustAcceptanceSucceeded.acceptedAt')
    if (computeManagerDocumentDigest(response) !== response.digest) fail('digest-invalid', 'trust acceptance response digest is invalid')
    assertSecretFree(response, 'DshTrustAcceptanceSucceeded')
    state.set(input.namespace, {
      ...state.get(input.namespace),
      timeRevision: response.timeRevision,
      authorityTime: response.authorityTime,
    })
    return Object.freeze(structuredClone(response))
  })

  return Object.freeze({ readCurrent, acceptSignedDocument, state })
}
