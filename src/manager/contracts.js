// @ts-check

import { createHash, createPublicKey, verify } from 'node:crypto'

import {
  canonicalJson,
  domainSeparatedDigest,
  validateCompositionProtocolRequest,
  validateCompositionProtocolResult,
  validateCompositionLockReceipt,
  validateResolvedComposition,
} from '../composition/index.js'

export const RUNTIME_MANAGER_API_VERSION = 'runtime.sympoies.dev/v1'
export const INFRA_API_VERSION = 'infra.serenvia.dev/v1'
export const CONTROL_PROTOCOL_VERSION = 'runtime.sympoies.dev/control-frame/v1'
export const MANAGER_CONTROL_MAX_DATAGRAM_BYTES = 1024 * 1024

export const TRUST_FAILURE_CODE_MAP = Object.freeze({
  'invalid-request': 'invalid-request',
  unauthenticated: 'trust-acceptance-unauthenticated',
  unauthorized: 'trust-acceptance-unauthorized',
  'namespace-not-found': 'trust-namespace-not-found',
  'stale-expected-head': 'trust-head-stale',
  'time-revision-conflict': 'time-revision-conflict',
  'time-revision-exhausted': 'time-revision-exhausted',
  'bundle-unreachable': 'trust-bundle-unreachable',
  'signature-unsupported': 'signature-unsupported',
  'signature-trust-unapproved': 'signature-trust-unapproved',
  'signature-key-unknown': 'signature-key-unknown',
  'signature-key-revoked': 'signature-key-revoked',
  'signature-key-use-invalid': 'signature-key-use-invalid',
  'signature-invalid': 'signature-invalid',
  'assertion-expired': 'assertion-expired',
  'assertion-stale': 'assertion-stale',
  'assertion-revoked': 'assertion-revoked',
  'acceptance-conflict': 'trust-acceptance-conflict',
  'replayed-nonce': 'trust-acceptance-replay',
  'authority-clock-unavailable': 'trust-authority-clock-unavailable',
  'authority-unavailable': 'trust-authority-unavailable',
})

export const TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED_CODES = Object.freeze([
  'trust-acceptance-unauthenticated',
  'trust-acceptance-unauthorized',
  'trust-namespace-not-found',
  'trust-head-stale',
  'trust-bundle-unreachable',
  'trust-acceptance-conflict',
  'trust-acceptance-replay',
  'time-revision-exhausted',
])

const TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED = new Set(
  TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED_CODES,
)

/** @param {string} code */
export function requiresTrustAcceptanceFailureDigest(code) {
  return TRUST_ACCEPTANCE_FAILURE_DIGEST_REQUIRED.has(code)
}

/** @param {string} code */
export function mapTrustAuthorityFailureCode(code) {
  return /** @type {Record<string, string>} */ (TRUST_FAILURE_CODE_MAP)[code] ?? code
}

export const MANAGER_REQUEST_KINDS = Object.freeze([
  'ValidateCompositionRequest',
  'ResolveCompositionRequest',
  'LockInstanceRequest',
  'StartInstanceRequest',
  'ResumeInstanceRequest',
  'StatusInstanceRequest',
  'InterruptInstanceRequest',
  'DrainInstanceRequest',
  'StopInstanceRequest',
  'DoctorInstanceRequest',
  'ReconcileInstanceRequest',
])

export const MANAGER_RESULT_KINDS = Object.freeze([
  'ValidateCompositionSucceeded', 'ValidateCompositionFailed',
  'ResolveCompositionSucceeded', 'ResolveCompositionFailed',
  'LockInstanceSucceeded', 'LockInstanceFailed', 'LockInstanceIndeterminate',
  'StartInstanceSucceeded', 'StartInstanceFailed', 'StartInstanceIndeterminate',
  'ResumeInstanceSucceeded', 'ResumeInstanceFailed', 'ResumeInstanceIndeterminate',
  'StatusInstanceSucceeded', 'StatusInstanceFailed',
  'InterruptInstanceSucceeded', 'InterruptInstanceFailed', 'InterruptInstanceIndeterminate',
  'DrainInstanceSucceeded', 'DrainInstanceFailed', 'DrainInstanceIndeterminate',
  'StopInstanceSucceeded', 'StopInstanceFailed', 'StopInstanceIndeterminate',
  'DoctorInstanceSucceeded', 'DoctorInstanceFailed',
  'ReconcileInstanceProvedTerminal', 'ReconcileInstanceProvedSource',
  'ReconcileInstanceQuarantined', 'ReconcileInstanceIndeterminate',
  'ReconcileInstanceFailed',
])

export const MANAGER_RESULT_KINDS_BY_REQUEST = Object.freeze({
  ValidateCompositionRequest: Object.freeze(['ValidateCompositionSucceeded', 'ValidateCompositionFailed']),
  ResolveCompositionRequest: Object.freeze(['ResolveCompositionSucceeded', 'ResolveCompositionFailed']),
  LockInstanceRequest: Object.freeze(['LockInstanceSucceeded', 'LockInstanceFailed', 'LockInstanceIndeterminate']),
  StartInstanceRequest: Object.freeze(['StartInstanceSucceeded', 'StartInstanceFailed', 'StartInstanceIndeterminate']),
  ResumeInstanceRequest: Object.freeze(['ResumeInstanceSucceeded', 'ResumeInstanceFailed', 'ResumeInstanceIndeterminate']),
  StatusInstanceRequest: Object.freeze(['StatusInstanceSucceeded', 'StatusInstanceFailed']),
  InterruptInstanceRequest: Object.freeze(['InterruptInstanceSucceeded', 'InterruptInstanceFailed', 'InterruptInstanceIndeterminate']),
  DrainInstanceRequest: Object.freeze(['DrainInstanceSucceeded', 'DrainInstanceFailed', 'DrainInstanceIndeterminate']),
  StopInstanceRequest: Object.freeze(['StopInstanceSucceeded', 'StopInstanceFailed', 'StopInstanceIndeterminate']),
  DoctorInstanceRequest: Object.freeze(['DoctorInstanceSucceeded', 'DoctorInstanceFailed']),
  ReconcileInstanceRequest: Object.freeze([
    'ReconcileInstanceProvedTerminal', 'ReconcileInstanceProvedSource',
    'ReconcileInstanceQuarantined', 'ReconcileInstanceIndeterminate',
    'ReconcileInstanceFailed',
  ]),
})

export const MANAGER_OPERATION_BY_REQUEST = Object.freeze({
  ValidateCompositionRequest: 'validate', ResolveCompositionRequest: 'resolve',
  LockInstanceRequest: 'lock', StartInstanceRequest: 'start',
  ResumeInstanceRequest: 'resume', StatusInstanceRequest: 'status',
  InterruptInstanceRequest: 'interrupt', DrainInstanceRequest: 'drain',
  StopInstanceRequest: 'stop', DoctorInstanceRequest: 'doctor',
  ReconcileInstanceRequest: 'reconcile',
})

const INSTANCE_STATES = Object.freeze([
  'Locked', 'Starting', 'Running', 'Interrupting', 'Interrupted',
  'Draining', 'Drained', 'Stopping', 'Stopped', 'Quarantined',
])

const MUTATION_TRANSITIONS = Object.freeze({
  lock: Object.freeze({ sources: Object.freeze(['Absent']), transient: 'Locked', terminal: 'Locked' }),
  start: Object.freeze({ sources: Object.freeze(['Locked']), transient: 'Starting', terminal: 'Running' }),
  resume: Object.freeze({ sources: Object.freeze(['Interrupted', 'Stopped']), transient: 'Starting', terminal: 'Running' }),
  interrupt: Object.freeze({ sources: Object.freeze(['Running']), transient: 'Interrupting', terminal: 'Interrupted' }),
  drain: Object.freeze({ sources: Object.freeze(['Running', 'Interrupted']), transient: 'Draining', terminal: 'Drained' }),
  stop: Object.freeze({ sources: Object.freeze(['Drained']), transient: 'Stopping', terminal: 'Stopped' }),
})

const MANAGER_RETRYABLE_FAILURE_CODES = new Set([
  'runtime-unavailable', 'cas-conflict', 'trust-head-stale',
  'time-revision-conflict', 'trust-authority-clock-unavailable',
  'trust-authority-unavailable',
])

const AUTHENTICATED_LIFECYCLE_FAILURE_CODES = Object.freeze([
  'assertion-invalid', 'assertion-expired', 'assertion-stale',
  'assertion-revoked', 'signature-unsupported', 'signature-trust-unapproved',
  'signature-key-unknown', 'signature-key-revoked', 'signature-invalid',
  'signature-key-use-invalid', 'trust-acceptance-unauthenticated',
  'trust-acceptance-unauthorized', 'trust-namespace-not-found',
  'trust-head-stale', 'trust-bundle-unreachable', 'trust-acceptance-conflict',
  'trust-acceptance-replay', 'trust-authority-clock-unavailable',
  'trust-authority-unavailable', 'time-revision-conflict',
  'time-revision-exhausted',
])

const MANAGER_FAILURE_CODES_BY_KIND = Object.freeze({
  LockInstanceFailed: new Set([
    'invalid-request', 'identity-conflict', 'state-conflict', 'stale-resolution',
    'seal-invalid', 'authority-widening', 'namespace-conflict', 'cas-conflict',
    'receipt-chain-invalid', 'idempotency-conflict',
    ...AUTHENTICATED_LIFECYCLE_FAILURE_CODES,
  ]),
  StartInstanceFailed: new Set([
    'invalid-request', 'state-conflict', 'lock-invalid', 'seal-invalid',
    'required-health-failed', 'namespace-conflict', 'runtime-unavailable',
    'cas-conflict', 'idempotency-conflict',
    ...AUTHENTICATED_LIFECYCLE_FAILURE_CODES,
  ]),
  ResumeInstanceFailed: new Set([
    'invalid-request', 'state-conflict', 'identity-mismatch', 'seal-invalid',
    'retained-state-missing', 'receipt-chain-invalid', 'runtime-unavailable',
    'cas-conflict', 'idempotency-conflict',
    ...AUTHENTICATED_LIFECYCLE_FAILURE_CODES,
  ]),
  StatusInstanceFailed: new Set(['invalid-request', 'not-found', 'receipt-chain-invalid', 'runtime-unavailable']),
  InterruptInstanceFailed: new Set([
    'invalid-request', 'state-conflict', 'cancellation-identity-mismatch',
    'runtime-unavailable', 'cas-conflict', 'idempotency-conflict',
  ]),
  DrainInstanceFailed: new Set([
    'invalid-request', 'state-conflict', 'trigger-fence-invalid',
    'publisher-epoch-stale', 'inflight-timeout', 'ambiguous-external-write',
    'receipt-chain-invalid', 'cas-conflict', 'idempotency-conflict',
  ]),
  StopInstanceFailed: new Set([
    'invalid-request', 'state-conflict', 'active-publisher', 'unreconciled-work',
    'receipt-chain-invalid', 'runtime-unavailable', 'cas-conflict',
    'idempotency-conflict',
  ]),
  DoctorInstanceFailed: new Set(['invalid-request', 'not-found', 'lock-invalid', 'seal-invalid', 'receipt-chain-invalid', 'runtime-unavailable']),
  ReconcileInstanceFailed: new Set([
    'invalid-request', 'not-found', 'state-conflict', 'evidence-digest-invalid',
    'receipt-chain-invalid', 'idempotency-conflict', 'unauthorized-state-mutation',
  ]),
})

/** @param {string} kind @param {string} code */
export function isManagerFailureCode(kind, code) {
  return /** @type {Record<string, Set<string>>} */ (MANAGER_FAILURE_CODES_BY_KIND)[kind]?.has(code) === true
}

export const RUNTIME_MANAGER_DOMAIN_TAGS = Object.freeze({
  DshDeploymentAdmissionSeal: 'serenvia/dsh-deployment-admission-seal/v1',
  DshDeploymentRuntimeAssertion: 'serenvia/dsh-deployment-runtime-assertion/v1',
  DshTrustBundle: 'serenvia/dsh-trust-bundle/v1',
  DshTrustBundleTransition: 'serenvia/dsh-trust-bundle-transition/v1',
  DshTrustLineageHead: 'serenvia/dsh-trust-lineage-head/v1',
  DshTrustLineageReadRequest: 'serenvia/dsh-trust-lineage-read-request/v1',
  DshTrustLineageReadSucceeded: 'serenvia/dsh-trust-lineage-read-succeeded/v1',
  DshTrustLineageReadFailed: 'serenvia/dsh-trust-lineage-read-failed/v1',
  DshTrustBundleReadRequest: 'serenvia/dsh-trust-bundle-read-request/v1',
  DshTrustBundleReadSucceeded: 'serenvia/dsh-trust-bundle-read-succeeded/v1',
  DshTrustBundleReadFailed: 'serenvia/dsh-trust-bundle-read-failed/v1',
  DshTrustAcceptanceRequest: 'serenvia/dsh-trust-acceptance-request/v1',
  DshTrustAcceptanceSucceeded: 'serenvia/dsh-trust-acceptance-succeeded/v1',
  DshTrustAcceptanceFailed: 'serenvia/dsh-trust-acceptance-failed/v1',
  ManagerControlRequestFrame: 'sympoies/manager-control-request-frame/v1',
  ManagerControlResponseFrame: 'sympoies/manager-control-response-frame/v1',
  MediatedHostActionRequest: 'sympoies/mediated-host-action-request/v1',
  MediatedHostActionSucceeded: 'sympoies/mediated-host-action-succeeded/v1',
  MediatedHostActionFailed: 'sympoies/mediated-host-action-failed/v1',
  MediatedHostActionIndeterminate: 'sympoies/mediated-host-action-indeterminate/v1',
  LockInstanceRequest: 'sympoies/lock-instance-request/v1',
  StartInstanceRequest: 'sympoies/start-instance-request/v1',
  ResumeInstanceRequest: 'sympoies/resume-instance-request/v1',
  InterruptInstanceRequest: 'sympoies/interrupt-instance-request/v1',
  DrainInstanceRequest: 'sympoies/drain-instance-request/v1',
  StopInstanceRequest: 'sympoies/stop-instance-request/v1',
  InstanceLockReceipt: 'sympoies/instance-lock-receipt/v1',
  InstanceStartReceipt: 'sympoies/instance-start-receipt/v1',
  InstanceResumeReceipt: 'sympoies/instance-resume-receipt/v1',
  InstanceInterruptReceipt: 'sympoies/instance-interrupt-receipt/v1',
  InstanceDrainReceipt: 'sympoies/instance-drain-receipt/v1',
  InstanceStopReceipt: 'sympoies/instance-stop-receipt/v1',
  InstanceQuarantineReceipt: 'sympoies/instance-quarantine-receipt/v1',
})

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const KEY_ID_PATTERN = /^ed25519:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u
const UINT64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u
const UTC_PATTERN = /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/u
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{4,}/u,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}/u,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{4,}/u,
])
const SIGNATURE_DOMAINS = Object.freeze({
  DshDeploymentAdmissionSeal: 'serenvia/dsh-deployment-admission-seal/signature/v1',
  DshDeploymentRuntimeAssertion: 'serenvia/dsh-deployment-runtime-assertion/signature/v1',
  DshTrustBundleTransition: 'serenvia/dsh-trust-bundle-transition/signature/v1',
})

export class RuntimeManagerError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RuntimeManagerError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
export function fail(code, message, details) {
  throw new RuntimeManagerError(code, message, details)
}

/** @param {unknown} value @param {string} path */
export function plainRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('schema-invalid', `${path} must be an object`, { path })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('schema-invalid', `${path} must be a plain data object`, { path })
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) {
      fail('schema-invalid', `${path} must contain only enumerable data properties`, { path })
    }
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {Record<string, any>} value @param {string[]} required @param {string[]} optional @param {string} path */
export function exactKeys(value, required, optional = [], path = 'document') {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown-field', `${path} has an unknown field`, { path, field: key })
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('schema-invalid', `${path}.${key} is required`, { path, field: key })
  }
}

/** @param {unknown} value @param {string} path @param {number} [maximum] */
export function text(value, path, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum
    || value.includes('\0')) fail('schema-invalid', `${path} is invalid`, { path })
  return value
}

/** @param {unknown} value @param {string} path */
export function digest(value, path) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('digest-invalid', `${path} must be a normalized SHA-256 digest`, { path })
  }
  return value
}

/** @param {unknown} value @param {string} path */
export function uint64(value, path) {
  if (typeof value !== 'string' || !UINT64_PATTERN.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    fail('schema-invalid', `${path} must be a canonical unsigned 64-bit decimal`, { path })
  }
  return value
}

/** @param {unknown} value @param {string} path */
export function utc(value, path) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (typeof value !== 'string' || !UTC_PATTERN.test(value) || Number.isNaN(milliseconds)
    || new Date(milliseconds).toISOString() !== value.replace(/Z$/u, '.000Z')) {
    fail('schema-invalid', `${path} must be canonical UTC time`, { path })
  }
  return value
}

/** @param {unknown} value @param {string} path */
export function nonce(value, path) {
  if (typeof value !== 'string' || !NONCE_PATTERN.test(value)) {
    fail('schema-invalid', `${path} must be a 128-bit unpadded base64url nonce`, { path })
  }
  return value
}

/** @param {unknown} value @param {string} path */
export function identity(value, path = 'identity') {
  const candidate = plainRecord(value, path)
  exactKeys(candidate, [
    'deploymentId', 'profileId', 'generationId', 'instanceId', 'namespace',
  ], [], path)
  for (const key of ['deploymentId', 'profileId', 'generationId', 'instanceId']) {
    if (!ID_PATTERN.test(text(candidate[key], `${path}.${key}`, 128))) {
      fail('schema-invalid', `${path}.${key} is invalid`, { path: `${path}.${key}` })
    }
  }
  const expected = `${candidate.deploymentId}/${candidate.profileId}/${candidate.generationId}/${candidate.instanceId}`
  if (candidate.namespace !== expected) fail('schema-invalid', `${path}.namespace is not canonical`, { path })
  return candidate
}

/** @param {unknown} value @param {string} path */
function sortedIdentities(value, path) {
  if (!Array.isArray(value) || value.length > 1024) fail('schema-invalid', `${path} must be a bounded array`, { path })
  const output = value.map((item, index) => {
    const candidate = text(item, `${path}[${index}]`, 128)
    if (!ID_PATTERN.test(candidate)) fail('schema-invalid', `${path}[${index}] is invalid`, { path })
    return candidate
  })
  if (new Set(output).size !== output.length || output.join('\0') !== [...output].sort().join('\0')) {
    fail('schema-invalid', `${path} must be sorted and unique`, { path })
  }
  return output
}

/** @param {unknown} value @param {string} path */
export function assertSecretFree(value, path = 'document') {
  const seen = new Set()
  const walk = (/** @type {unknown} */ item, /** @type {string} */ itemPath, /** @type {number} */ depth) => {
    if (depth > 64) fail('schema-invalid', `${path} exceeds traversal depth`, { path })
    if (typeof item === 'string') {
      if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(item))) {
        fail('secret-shaped-value', `${itemPath} contains a secret-shaped value`, { path: itemPath })
      }
      return
    }
    if (item === null || typeof item !== 'object') return
    if (seen.has(item)) fail('schema-invalid', `${path} contains a cycle`, { path })
    seen.add(item)
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) walk(item[index], `${itemPath}[${index}]`, depth + 1)
    } else {
      const record = plainRecord(item, itemPath)
      for (const [key, child] of Object.entries(record)) walk(child, `${itemPath}.${key}`, depth + 1)
    }
    seen.delete(item)
  }
  walk(value, path, 0)
}

/** @param {unknown} value @param {string} path @param {number} [maximum] */
export function assertCanonicalByteBound(
  value,
  path,
  maximum = MANAGER_CONTROL_MAX_DATAGRAM_BYTES,
) {
  assertSecretFree(value, path)
  let serialized
  try {
    serialized = canonicalJson(value)
  } catch (error) {
    if (error instanceof RuntimeManagerError) throw error
    fail('schema-invalid', `${path} must be canonical JSON`, { path })
  }
  if (Buffer.byteLength(serialized) > maximum) {
    fail('schema-invalid', `${path} exceeds the ${maximum}-byte limit`, { path, maximum })
  }
  return value
}

/** @param {Record<string, any>} source */
function digestProjection(source) {
  const document = structuredClone(source)
  if (document.metadata && typeof document.metadata === 'object') delete document.metadata.digest
  delete document.digest
  delete document.frameDigest
  if (['DshDeploymentAdmissionSeal', 'DshDeploymentRuntimeAssertion', 'DshTrustBundleTransition'].includes(document.kind)) {
    delete document.signature
  }
  if (['LockInstanceRequest', 'StartInstanceRequest', 'ResumeInstanceRequest', 'MediatedHostActionRequest'].includes(document.kind)) {
    delete document.requestId
    delete document.requestDigest
    delete document.runtimeAssertion
    delete document.runtimeAssertionDigest
  } else if (['InterruptInstanceRequest', 'DrainInstanceRequest', 'StopInstanceRequest'].includes(document.kind)
    || document.kind?.startsWith('DshTrust') && document.kind?.endsWith('Request')) {
    delete document.requestId
    delete document.requestDigest
  }
  return document
}

/** @param {unknown} value */
export function computeManagerDocumentDigest(value) {
  const document = plainRecord(value, 'document')
  const domain = /** @type {Record<string, string>} */ (RUNTIME_MANAGER_DOMAIN_TAGS)[document.kind]
  if (domain === undefined) fail('unsupported-kind', 'document kind has no frozen digest domain')
  return domainSeparatedDigest(domain, digestProjection(document))
}

/** @param {unknown} value */
export function computeSemanticRequestDigest(value) {
  const request = plainRecord(value, 'request')
  const domain = /** @type {Record<string, string>} */ (RUNTIME_MANAGER_DOMAIN_TAGS)[request.kind]
  if (domain === undefined || !request.kind.endsWith('Request')) {
    fail('unsupported-kind', 'request kind has no semantic digest domain')
  }
  return domainSeparatedDigest(domain, digestProjection(request))
}

/** @param {Record<string, any>} value */
export function computeTrustAuthorityObservationDigest(value) {
  return domainSeparatedDigest('serenvia/dsh-trust-authority-observation/v1', {
    namespace: value.namespace,
    snapshotHeadDigest: value.snapshotHeadDigest,
    currentHeadDigest: value.currentHeadDigest,
    authorityTime: value.authorityTime,
    priorAuthorityTime: value.priorAuthorityTime,
    timeRevision: value.timeRevision,
    priorTimeRevision: value.priorTimeRevision,
    clockHealth: value.clockHealth,
    controllerReceiptDigest: value.controllerReceiptDigest,
  })
}

/** @param {unknown} value */
export function protocolSignatureMessage(value) {
  const document = plainRecord(value, 'signedDocument')
  const signatureDomain = /** @type {Record<string, string>} */ (SIGNATURE_DOMAINS)[document.kind]
  const documentDomain = /** @type {Record<string, string>} */ (RUNTIME_MANAGER_DOMAIN_TAGS)[document.kind]
  if (signatureDomain === undefined || documentDomain === undefined) fail('signature-unsupported', 'signed kind is unsupported')
  const canonicalPreimage = Buffer.concat([
    Buffer.from(documentDomain, 'ascii'), Buffer.from([0]),
    Buffer.from(canonicalJson(digestProjection(document)), 'utf8'),
  ])
  const rawDigest = createHash('sha256').update(canonicalPreimage).digest()
  return Buffer.concat([Buffer.from(signatureDomain, 'ascii'), Buffer.from([0]), rawDigest])
}

/** @param {{signedKind: string, rawDocumentDigest: string, keyId: string, rawPublicKeyHex: string, signature: string}} input */
export function verifyProtocolSignatureDigest(input) {
  const domain = /** @type {Record<string, string>} */ (SIGNATURE_DOMAINS)[input.signedKind]
  if (domain === undefined || !KEY_ID_PATTERN.test(input.keyId)
    || !/^[0-9a-f]{64}$/u.test(input.rawDocumentDigest)
    || !/^[0-9a-f]{64}$/u.test(input.rawPublicKeyHex)
    || !SIGNATURE_PATTERN.test(input.signature)) return false
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(input.rawPublicKeyHex, 'hex'),
    ]),
    format: 'der', type: 'spki',
  })
  const message = Buffer.concat([
    Buffer.from(domain, 'ascii'), Buffer.from([0]), Buffer.from(input.rawDocumentDigest, 'hex'),
  ])
  return verify(null, message, key, Buffer.from(input.signature, 'base64url'))
}

/** @param {unknown} value @param {unknown} bundle @param {'seal'|'assertion'|'trust-transition'} expectedUse */
export function verifyProtocolSignature(value, bundle, expectedUse) {
  const document = plainRecord(value, 'signedDocument')
  const trustBundle = validateTrustBundle(bundle)
  if (document.signatureSuite !== undefined && document.signatureSuite !== 'Ed25519') {
    fail('signature-unsupported', 'signature suite is unsupported')
  }
  const documentKeyId = document.kind === 'DshTrustBundleTransition' ? document.signerKeyId : document.keyId
  if (typeof documentKeyId !== 'string' || !KEY_ID_PATTERN.test(documentKeyId)
    || typeof document.signature !== 'string' || !SIGNATURE_PATTERN.test(document.signature)) {
    fail('signature-invalid', 'signature encoding is invalid')
  }
  const key = trustBundle.keys.find((/** @type {Record<string, any>} */ item) => item.keyId === documentKeyId)
  if (key === undefined) fail('signature-key-unknown', 'signature key is not in the authorized bundle')
  if (key.use !== expectedUse) fail('signature-key-use-invalid', 'signature key use is invalid')
  if (key.state === 'revoked') fail('signature-key-revoked', 'signature key is revoked')
  if (!verifyProtocolSignatureDigest({
    signedKind: document.kind,
    rawDocumentDigest: computeManagerDocumentDigest(document).slice(7),
    keyId: documentKeyId,
    rawPublicKeyHex: key.rawPublicKeyHex,
    signature: document.signature,
  })) fail('signature-invalid', 'signature verification failed')
  return true
}

/** @param {unknown} value */
export function validateTrustBundle(value) {
  const bundle = plainRecord(value, 'DshTrustBundle')
  exactKeys(bundle, ['apiVersion', 'kind', 'metadata', 'namespace', 'bundleId', 'createdAt', 'keys'], [], 'DshTrustBundle')
  if (bundle.apiVersion !== INFRA_API_VERSION || bundle.kind !== 'DshTrustBundle') fail('unsupported-kind', 'trust bundle identity is unsupported')
  const metadata = plainRecord(bundle.metadata, 'DshTrustBundle.metadata')
  exactKeys(metadata, ['digest'], [], 'DshTrustBundle.metadata')
  digest(metadata.digest, 'DshTrustBundle.metadata.digest')
  text(bundle.namespace, 'DshTrustBundle.namespace', 512)
  text(bundle.bundleId, 'DshTrustBundle.bundleId', 128)
  utc(bundle.createdAt, 'DshTrustBundle.createdAt')
  if (!Array.isArray(bundle.keys) || bundle.keys.length === 0 || bundle.keys.length > 2048) {
    fail('schema-invalid', 'DshTrustBundle.keys must be a bounded non-empty array')
  }
  const ids = []
  for (let index = 0; index < bundle.keys.length; index += 1) {
    const key = plainRecord(bundle.keys[index], `DshTrustBundle.keys[${index}]`)
    exactKeys(key, ['keyId', 'algorithm', 'use', 'rawPublicKeyHex', 'state'], [], `DshTrustBundle.keys[${index}]`)
    if (!KEY_ID_PATTERN.test(key.keyId) || key.algorithm !== 'Ed25519'
      || !['seal', 'assertion', 'trust-transition'].includes(key.use)
      || !/^[0-9a-f]{64}$/u.test(key.rawPublicKeyHex)
      || !['active', 'retired', 'revoked'].includes(key.state)) {
      fail('schema-invalid', 'DshTrustBundle contains an invalid key entry')
    }
    ids.push(key.keyId)
  }
  if (new Set(ids).size !== ids.length || ids.join('\0') !== [...ids].sort().join('\0')) {
    fail('schema-invalid', 'DshTrustBundle keys must be byte-sorted and unique')
  }
  if (Buffer.byteLength(canonicalJson(bundle)) > 256 * 1024) fail('schema-invalid', 'DshTrustBundle exceeds 256 KiB')
  if (computeManagerDocumentDigest(bundle) !== metadata.digest) fail('digest-invalid', 'DshTrustBundle digest is invalid')
  assertSecretFree(bundle)
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value */
export function validateTrustLineageHead(value) {
  const head = plainRecord(value, 'DshTrustLineageHead')
  exactKeys(head, ['apiVersion', 'kind', 'digest', 'namespace', 'genesisBundleDigest', 'sequence', 'bundleDigest', 'transitionDigest', 'casRevision'], [], 'DshTrustLineageHead')
  if (head.apiVersion !== INFRA_API_VERSION || head.kind !== 'DshTrustLineageHead') fail('unsupported-kind', 'lineage head identity is unsupported')
  digest(head.digest, 'DshTrustLineageHead.digest')
  text(head.namespace, 'DshTrustLineageHead.namespace', 512)
  digest(head.genesisBundleDigest, 'DshTrustLineageHead.genesisBundleDigest')
  uint64(head.sequence, 'DshTrustLineageHead.sequence')
  digest(head.bundleDigest, 'DshTrustLineageHead.bundleDigest')
  if (head.transitionDigest !== null) digest(head.transitionDigest, 'DshTrustLineageHead.transitionDigest')
  uint64(head.casRevision, 'DshTrustLineageHead.casRevision')
  if (head.sequence === '0' && (head.bundleDigest !== head.genesisBundleDigest || head.transitionDigest !== null)) {
    fail('lineage-invalid', 'genesis lineage head is inconsistent')
  }
  if (computeManagerDocumentDigest(head) !== head.digest) fail('digest-invalid', 'DshTrustLineageHead digest is invalid')
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value @param {{composition: unknown, compositionLockReceipt: unknown, identity: unknown}} expected */
export function validateAdmissionSeal(value, expected) {
  const seal = plainRecord(value, 'DshDeploymentAdmissionSeal')
  exactKeys(seal, [
    'apiVersion', 'kind', 'metadata', 'compositionLockReceiptDigest',
    'resolvedCompositionDigest', 'bindingDigest', 'trustPolicyDigest',
    'trustPolicyEvidenceDigest', 'identity', 'effectiveAuthority',
    'effectiveAuthorityDigest', 'resourceClasses', 'credentialHandleClasses',
    'controllerIdentity', 'priorControllerReceiptDigest', 'signatureSuite',
    'keyId', 'bundleDigest', 'signature',
  ], [], 'DshDeploymentAdmissionSeal')
  if (seal.apiVersion !== INFRA_API_VERSION || seal.kind !== 'DshDeploymentAdmissionSeal') fail('seal-invalid', 'admission seal identity is invalid')
  const metadata = plainRecord(seal.metadata, 'DshDeploymentAdmissionSeal.metadata')
  exactKeys(metadata, ['digest'], [], 'DshDeploymentAdmissionSeal.metadata')
  digest(metadata.digest, 'DshDeploymentAdmissionSeal.metadata.digest')
  for (const field of ['compositionLockReceiptDigest', 'resolvedCompositionDigest', 'bindingDigest', 'trustPolicyDigest', 'trustPolicyEvidenceDigest', 'effectiveAuthorityDigest', 'bundleDigest']) digest(seal[field], `DshDeploymentAdmissionSeal.${field}`)
  const sealIdentity = identity(seal.identity, 'DshDeploymentAdmissionSeal.identity')
  const expectedIdentity = identity(expected.identity, 'expected.identity')
  if (canonicalJson(sealIdentity) !== canonicalJson(expectedIdentity)) fail('identity-conflict', 'seal identity does not match the instance request')
  const composition = /** @type {Record<string, any>} */ (validateResolvedComposition(expected.composition))
  const lock = /** @type {Record<string, any>} */ (validateCompositionLockReceipt(expected.compositionLockReceipt, composition))
  if (seal.compositionLockReceiptDigest !== lock.digest || seal.resolvedCompositionDigest !== composition.metadata.digest) {
    fail('seal-invalid', 'seal does not bind the complete composition lock pair')
  }
  const authority = plainRecord(seal.effectiveAuthority, 'DshDeploymentAdmissionSeal.effectiveAuthority')
  exactKeys(authority, ['capabilities', 'networkClasses', 'workspaceClasses', 'resourceClasses'], [], 'DshDeploymentAdmissionSeal.effectiveAuthority')
  for (const field of ['capabilities', 'networkClasses', 'workspaceClasses', 'resourceClasses']) sortedIdentities(authority[field], `DshDeploymentAdmissionSeal.effectiveAuthority.${field}`)
  /** @type {Record<string, string[]>} */
  const ceilings = {
    capabilities: composition.authorityCeiling.capabilities,
    networkClasses: composition.authorityCeiling.networkClasses,
    workspaceClasses: composition.authorityCeiling.workspaceClasses,
    resourceClasses: composition.resources.classes,
  }
  for (const field of Object.keys(ceilings)) {
    if (authority[field].some((/** @type {string} */ item) => !ceilings[field].includes(item))) fail('authority-widening', 'seal widens the public composition ceiling', { field })
  }
  if (composition.profile.scopeClass === 'non-project'
    && (authority.workspaceClasses.length > 0 || authority.capabilities.some((/** @type {string} */ item) => item.startsWith('coding.')))) {
    fail('authority-widening', 'non-project admission cannot inherit project or coding authority')
  }
  if (domainSeparatedDigest('sympoies/private-effective-authority/v1', authority) !== seal.effectiveAuthorityDigest) fail('digest-invalid', 'effective authority digest is invalid')
  sortedIdentities(seal.resourceClasses, 'DshDeploymentAdmissionSeal.resourceClasses')
  sortedIdentities(seal.credentialHandleClasses, 'DshDeploymentAdmissionSeal.credentialHandleClasses')
  text(seal.controllerIdentity, 'DshDeploymentAdmissionSeal.controllerIdentity', 256)
  if (seal.priorControllerReceiptDigest !== null) digest(seal.priorControllerReceiptDigest, 'DshDeploymentAdmissionSeal.priorControllerReceiptDigest')
  if (seal.signatureSuite !== 'Ed25519' || !KEY_ID_PATTERN.test(seal.keyId) || !SIGNATURE_PATTERN.test(seal.signature)) fail('signature-invalid', 'admission seal signature fields are invalid')
  if (computeManagerDocumentDigest(seal) !== metadata.digest) fail('digest-invalid', 'admission seal digest is invalid')
  assertSecretFree(seal)
  return value
}

/** @param {unknown} value @param {{sealDigest: string, identity: unknown, operation: string, semanticRequestDigest: string}} expected */
export function validateRuntimeAssertion(value, expected) {
  const assertion = plainRecord(value, 'DshDeploymentRuntimeAssertion')
  exactKeys(assertion, [
    'apiVersion', 'kind', 'metadata', 'admissionSealDigest', 'identity',
    'operation', 'semanticRequestDigest', 'bundleDigest', 'controllerCasRevision',
    'controllerReceiptHead', 'generationEligible', 'trafficScopeDigest',
    'publisherEpoch', 'nonce', 'issuedAt', 'expiresAt', 'revocationId',
    'signatureSuite', 'keyId', 'signature',
  ], [], 'DshDeploymentRuntimeAssertion')
  if (assertion.apiVersion !== INFRA_API_VERSION || assertion.kind !== 'DshDeploymentRuntimeAssertion') fail('assertion-invalid', 'runtime assertion identity is invalid')
  const metadata = plainRecord(assertion.metadata, 'DshDeploymentRuntimeAssertion.metadata')
  exactKeys(metadata, ['digest'], [], 'DshDeploymentRuntimeAssertion.metadata')
  digest(metadata.digest, 'DshDeploymentRuntimeAssertion.metadata.digest')
  digest(assertion.admissionSealDigest, 'DshDeploymentRuntimeAssertion.admissionSealDigest')
  if (assertion.admissionSealDigest !== expected.sealDigest) fail('assertion-invalid', 'runtime assertion names another admission seal')
  if (canonicalJson(identity(assertion.identity)) !== canonicalJson(identity(expected.identity))) fail('assertion-invalid', 'runtime assertion identity mismatch')
  if (assertion.operation !== expected.operation || assertion.semanticRequestDigest !== expected.semanticRequestDigest) fail('assertion-invalid', 'runtime assertion operation or request digest mismatch')
  digest(assertion.semanticRequestDigest, 'DshDeploymentRuntimeAssertion.semanticRequestDigest')
  digest(assertion.bundleDigest, 'DshDeploymentRuntimeAssertion.bundleDigest')
  uint64(assertion.controllerCasRevision, 'DshDeploymentRuntimeAssertion.controllerCasRevision')
  digest(assertion.controllerReceiptHead, 'DshDeploymentRuntimeAssertion.controllerReceiptHead')
  if (assertion.generationEligible !== true) fail('assertion-stale', 'runtime assertion generation is not eligible')
  digest(assertion.trafficScopeDigest, 'DshDeploymentRuntimeAssertion.trafficScopeDigest')
  if (assertion.publisherEpoch !== null) uint64(assertion.publisherEpoch, 'DshDeploymentRuntimeAssertion.publisherEpoch')
  nonce(assertion.nonce, 'DshDeploymentRuntimeAssertion.nonce')
  utc(assertion.issuedAt, 'DshDeploymentRuntimeAssertion.issuedAt')
  utc(assertion.expiresAt, 'DshDeploymentRuntimeAssertion.expiresAt')
  if (Date.parse(assertion.expiresAt) <= Date.parse(assertion.issuedAt)) fail('assertion-invalid', 'runtime assertion expiry is invalid')
  text(assertion.revocationId, 'DshDeploymentRuntimeAssertion.revocationId', 256)
  if (assertion.signatureSuite !== 'Ed25519' || !KEY_ID_PATTERN.test(assertion.keyId) || !SIGNATURE_PATTERN.test(assertion.signature)) fail('signature-invalid', 'runtime assertion signature fields are invalid')
  if (computeManagerDocumentDigest(assertion) !== metadata.digest) fail('digest-invalid', 'runtime assertion digest is invalid')
  assertSecretFree(assertion)
  return value
}

/** @param {unknown} value @param {string} path @param {boolean} [nullable] */
function instanceState(value, path, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !INSTANCE_STATES.includes(value)) {
    fail('schema-invalid', `${path} is not a lifecycle state`, { path })
  }
  return value
}

/** @param {unknown} value @param {string} path @param {number} [limit] */
function boundedStrings(value, path, limit = 1024) {
  if (!Array.isArray(value) || value.length > limit) {
    fail('schema-invalid', `${path} must be a bounded array`, { path })
  }
  return value.map((item, index) => text(item, `${path}[${index}]`, 256))
}

/** @param {unknown} value @param {string} code @param {string} path */
export function validateFailureDetails(value, code, path) {
  const details = plainRecord(value, path)
  if (code === 'required-health-failed') {
    exactKeys(details, ['probe'], [], path)
    text(details.probe, `${path}.probe`, 256)
  } else {
    exactKeys(details, [], [], path)
  }
  assertSecretFree(details, path)
  assertCanonicalByteBound(details, path, 8 * 1024)
  return details
}

/** @param {unknown} left @param {unknown} right */
function sameIdentity(left, right) {
  return canonicalJson(identity(left)) === canonicalJson(identity(right))
}

/** @param {unknown} value */
function validateLifecycleReceipt(value) {
  const receipt = plainRecord(value, 'lifecycle receipt')
  exactKeys(receipt, [
    'apiVersion', 'kind', 'digest', 'operation', 'identity', 'idempotencyKey',
    'sourceState', 'observedState', 'compositionLockReceiptDigest',
    'resolvedCompositionDigest', 'admissionSealDigest', 'requestDigest',
    'priorReceiptDigest', 'sealTrustAcceptanceReceiptDigest',
    'assertionTrustAcceptanceReceiptDigest', 'sessionIdentity',
    'effectSummaryDigest', 'timestamp',
  ], [], receipt.kind ?? 'lifecycle receipt')
  const expectedKinds = {
    lock: 'InstanceLockReceipt', start: 'InstanceStartReceipt',
    resume: 'InstanceResumeReceipt', interrupt: 'InstanceInterruptReceipt',
    drain: 'InstanceDrainReceipt', stop: 'InstanceStopReceipt',
  }
  const transition = /** @type {Record<string, {sources: readonly string[], terminal: string}>} */ (MUTATION_TRANSITIONS)[receipt.operation]
  if (receipt.apiVersion !== RUNTIME_MANAGER_API_VERSION
    || transition === undefined
    || receipt.kind !== /** @type {Record<string, string>} */ (expectedKinds)[receipt.operation]) {
    fail('schema-invalid', 'lifecycle receipt identity is invalid')
  }
  digest(receipt.digest, `${receipt.kind}.digest`)
  identity(receipt.identity)
  text(receipt.idempotencyKey, `${receipt.kind}.idempotencyKey`, 256)
  if (!transition.sources.includes(receipt.sourceState) || receipt.observedState !== transition.terminal) {
    fail('schema-invalid', `${receipt.kind} states are invalid`)
  }
  for (const field of [
    'compositionLockReceiptDigest', 'resolvedCompositionDigest',
    'admissionSealDigest', 'requestDigest',
  ]) digest(receipt[field], `${receipt.kind}.${field}`)
  for (const field of [
    'priorReceiptDigest', 'sealTrustAcceptanceReceiptDigest',
    'assertionTrustAcceptanceReceiptDigest', 'effectSummaryDigest',
  ]) if (receipt[field] !== null) digest(receipt[field], `${receipt.kind}.${field}`)
  const sealAccepted = receipt.sealTrustAcceptanceReceiptDigest !== null
  const assertionAccepted = receipt.assertionTrustAcceptanceReceiptDigest !== null
  if ((receipt.operation === 'lock' && (!sealAccepted || !assertionAccepted))
    || (['start', 'resume'].includes(receipt.operation) && (sealAccepted || !assertionAccepted))
    || (['interrupt', 'drain', 'stop'].includes(receipt.operation) && (sealAccepted || assertionAccepted))) {
    fail('schema-invalid', `${receipt.kind} trust acceptance evidence is invalid`)
  }
  if (receipt.operation === 'lock') {
    if (receipt.sessionIdentity !== null) fail('schema-invalid', `${receipt.kind}.sessionIdentity must be null`)
  } else {
    text(receipt.sessionIdentity, `${receipt.kind}.sessionIdentity`, 256)
  }
  utc(receipt.timestamp, `${receipt.kind}.timestamp`)
  if (computeManagerDocumentDigest(receipt) !== receipt.digest) fail('digest-invalid', `${receipt.kind} digest is invalid`)
  assertSecretFree(receipt, receipt.kind)
  return receipt
}

/** @param {unknown} value */
function validateQuarantineReceipt(value) {
  const receipt = plainRecord(value, 'InstanceQuarantineReceipt')
  exactKeys(receipt, [
    'apiVersion', 'kind', 'digest', 'originalOperation',
    'originalIdempotencyKey', 'originalRequestDigest', 'identity',
    'sourceState', 'lastObservedState', 'journalEvidenceDigest',
    'dshEvidenceDigest', 'priorReceiptDigest', 'reasonCode', 'observedState',
  ], [], 'InstanceQuarantineReceipt')
  const transition = /** @type {Record<string, {sources: readonly string[]}>} */ (MUTATION_TRANSITIONS)[receipt.originalOperation]
  if (receipt.apiVersion !== RUNTIME_MANAGER_API_VERSION
    || receipt.kind !== 'InstanceQuarantineReceipt' || transition === undefined
    || !transition.sources.includes(receipt.sourceState)
    || ![...INSTANCE_STATES, 'Absent'].includes(receipt.lastObservedState)
    || !['authoritative-truth-unavailable', 'stable-conflict'].includes(receipt.reasonCode)
    || receipt.observedState !== 'Quarantined') fail('schema-invalid', 'quarantine receipt is invalid')
  digest(receipt.digest, 'InstanceQuarantineReceipt.digest')
  text(receipt.originalIdempotencyKey, 'InstanceQuarantineReceipt.originalIdempotencyKey', 256)
  identity(receipt.identity)
  for (const field of ['originalRequestDigest', 'journalEvidenceDigest', 'dshEvidenceDigest']) {
    digest(receipt[field], `InstanceQuarantineReceipt.${field}`)
  }
  if (receipt.priorReceiptDigest !== null) digest(receipt.priorReceiptDigest, 'InstanceQuarantineReceipt.priorReceiptDigest')
  if (computeManagerDocumentDigest(receipt) !== receipt.digest) fail('digest-invalid', 'quarantine receipt digest is invalid')
  assertSecretFree(receipt, receipt.kind)
  return receipt
}

/** @param {unknown} value */
export function validateRuntimeReceipt(value) {
  const receipt = plainRecord(value, 'runtime receipt')
  return receipt.kind === 'InstanceQuarantineReceipt'
    ? validateQuarantineReceipt(receipt)
    : validateLifecycleReceipt(receipt)
}

/** @param {unknown} value */
function validateStatusRequest(value) {
  const payload = plainRecord(value, 'StatusInstanceRequest')
  exactKeys(payload, ['apiVersion', 'kind', 'requestId', 'identity', 'receiptChainHead'], [], 'StatusInstanceRequest')
  if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION || payload.kind !== 'StatusInstanceRequest') fail('unsupported-kind', 'status request identity is invalid')
  text(payload.requestId, 'StatusInstanceRequest.requestId', 256)
  identity(payload.identity)
  if (payload.receiptChainHead !== null) digest(payload.receiptChainHead, 'StatusInstanceRequest.receiptChainHead')
  return payload
}

/** @param {unknown} value */
function validateStatusFailure(value) {
  const payload = plainRecord(value, 'StatusInstanceFailed')
  exactKeys(payload, ['apiVersion', 'kind', 'requestId', 'code', 'retryable', 'observedState', 'identity', 'receiptDigest', 'details'], [], 'StatusInstanceFailed')
  if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION || payload.kind !== 'StatusInstanceFailed') fail('unsupported-kind', 'status failure identity is invalid')
  if (!['invalid-request', 'not-found', 'receipt-chain-invalid', 'runtime-unavailable'].includes(payload.code)) fail('schema-invalid', 'status failure code is invalid')
  if (payload.retryable !== MANAGER_RETRYABLE_FAILURE_CODES.has(payload.code)) fail('schema-invalid', 'status failure shape is invalid')
  instanceState(payload.observedState, 'StatusInstanceFailed.observedState', true)
  if (payload.identity !== null) identity(payload.identity)
  if (payload.receiptDigest !== null) digest(payload.receiptDigest, 'StatusInstanceFailed.receiptDigest')
  validateFailureDetails(payload.details, payload.code, 'StatusInstanceFailed.details')
  assertSecretFree(payload, payload.kind)
  return payload
}

const REQUEST_KEYS = Object.freeze({
  ValidateCompositionRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'descriptors', 'profile', 'readerSchemas', 'runtime']),
  ResolveCompositionRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'validatedDocumentDigests', 'catalogSnapshotDigest', 'runtime', 'publicPolicyCeilingDigest']),
  LockInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'resolvedComposition', 'resolvedCompositionDigest', 'compositionLockReceipt', 'admissionSeal', 'admissionSealDigest', 'runtimeAssertion', 'runtimeAssertionDigest', 'expectedState']),
  StartInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'priorReceiptDigest', 'admissionSealDigest', 'runtimeAssertion', 'runtimeAssertionDigest', 'expectedState']),
  ResumeInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'priorReceiptDigest', 'admissionSealDigest', 'runtimeAssertion', 'runtimeAssertionDigest', 'expectedState']),
  StatusInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'receiptChainHead']),
  InterruptInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'expectedState', 'runIdentity']),
  DrainInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'expectedState', 'triggerFenceDigest', 'publisherEpoch', 'deadlinePolicyDigest']),
  StopInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'requestDigest', 'identity', 'expectedState', 'receiptChainHead']),
  DoctorInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'expectedCompositionLockReceiptDigest', 'expectedAdmissionSealDigest', 'expectedReceiptChainHead']),
  ReconcileInstanceRequest: Object.freeze(['apiVersion', 'kind', 'requestId', 'originalOperation', 'originalIdempotencyKey', 'originalRequestDigest', 'identity', 'journalEvidenceDigest', 'dshEvidenceDigest', 'expectedSourceStates', 'expectedTerminalState']),
})

/** @param {Record<string, any>} payload */
function validateKnownRequest(payload) {
  const keys = /** @type {Record<string, readonly string[]>} */ (REQUEST_KEYS)[payload.kind]
  if (keys === undefined) fail('unsupported-kind', 'manager request kind is unsupported')
  exactKeys(payload, [...keys], [], payload.kind)
  if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION) fail('unsupported-api-version', 'manager request apiVersion is unsupported')
  text(payload.requestId, `${payload.kind}.requestId`, 256)
  if (payload.kind === 'ValidateCompositionRequest') {
    return /** @type {Record<string, any>} */ (validateCompositionProtocolRequest(payload))
  }
  if (payload.kind === 'ResolveCompositionRequest') {
    return /** @type {Record<string, any>} */ (validateCompositionProtocolRequest(payload))
  }
  identity(payload.identity)
  if (payload.kind === 'StatusInstanceRequest') return validateStatusRequest(payload)
  if (payload.kind === 'DoctorInstanceRequest') {
    for (const field of [
      'expectedCompositionLockReceiptDigest', 'expectedAdmissionSealDigest',
      'expectedReceiptChainHead',
    ]) digest(payload[field], `DoctorInstanceRequest.${field}`)
    return payload
  }
  if (payload.kind === 'ReconcileInstanceRequest') {
    const transition = /** @type {Record<string, {sources: readonly string[], terminal: string}>} */ (MUTATION_TRANSITIONS)[payload.originalOperation]
    if (transition === undefined) fail('invalid-request', 'reconcile original operation is invalid')
    text(payload.originalIdempotencyKey, 'ReconcileInstanceRequest.originalIdempotencyKey', 256)
    for (const field of ['originalRequestDigest', 'journalEvidenceDigest', 'dshEvidenceDigest']) {
      digest(payload[field], `ReconcileInstanceRequest.${field}`)
    }
    const sources = boundedStrings(payload.expectedSourceStates, 'ReconcileInstanceRequest.expectedSourceStates', 2)
    if (sources.length === 0 || sources.some(source => !transition.sources.includes(source))
      || payload.expectedTerminalState !== transition.terminal) {
      fail('invalid-request', 'reconcile expected states are invalid')
    }
    return payload
  }
  text(payload.idempotencyKey, `${payload.kind}.idempotencyKey`, 256)
  digest(payload.requestDigest, `${payload.kind}.requestDigest`)
  if (computeSemanticRequestDigest(payload) !== payload.requestDigest) fail('invalid-request', `${payload.kind} semantic digest is invalid`)
  if (payload.kind === 'LockInstanceRequest') {
    if (payload.expectedState !== 'Absent') fail('invalid-request', 'lock expected state must be Absent')
    const composition = /** @type {Record<string, any>} */ (validateResolvedComposition(payload.resolvedComposition))
    const lock = /** @type {Record<string, any>} */ (validateCompositionLockReceipt(payload.compositionLockReceipt, composition))
    if (payload.resolvedCompositionDigest !== composition.metadata.digest) fail('stale-resolution', 'lock resolved composition digest is stale')
    digest(payload.admissionSealDigest, 'LockInstanceRequest.admissionSealDigest')
    if (payload.admissionSealDigest !== payload.admissionSeal?.metadata?.digest) fail('seal-invalid', 'lock admission seal digest mismatch')
    validateAdmissionSeal(payload.admissionSeal, {
      composition, compositionLockReceipt: lock, identity: payload.identity,
    })
    if (payload.runtimeAssertion === null || payload.runtimeAssertionDigest === null) fail('assertion-invalid', 'lock requires a current runtime assertion')
    digest(payload.runtimeAssertionDigest, 'LockInstanceRequest.runtimeAssertionDigest')
    if (payload.runtimeAssertion?.metadata?.digest !== payload.runtimeAssertionDigest) fail('assertion-invalid', 'lock runtime assertion digest mismatch')
    validateRuntimeAssertion(payload.runtimeAssertion, {
      sealDigest: payload.admissionSealDigest, identity: payload.identity,
      operation: 'instance.lock', semanticRequestDigest: payload.requestDigest,
    })
  } else if (['StartInstanceRequest', 'ResumeInstanceRequest'].includes(payload.kind)) {
    const operation = payload.kind === 'StartInstanceRequest' ? 'start' : 'resume'
    if (operation === 'start' && payload.expectedState !== 'Locked') fail('invalid-request', 'start expected state must be Locked')
    if (operation === 'resume' && !['Interrupted', 'Stopped'].includes(payload.expectedState)) fail('invalid-request', 'resume expected state is invalid')
    digest(payload.priorReceiptDigest, `${payload.kind}.priorReceiptDigest`)
    digest(payload.admissionSealDigest, `${payload.kind}.admissionSealDigest`)
    digest(payload.runtimeAssertionDigest, `${payload.kind}.runtimeAssertionDigest`)
    if (payload.runtimeAssertion?.metadata?.digest !== payload.runtimeAssertionDigest) fail('assertion-invalid', `${payload.kind} runtime assertion digest mismatch`)
    validateRuntimeAssertion(payload.runtimeAssertion, {
      sealDigest: payload.admissionSealDigest, identity: payload.identity,
      operation: `instance.${operation}`, semanticRequestDigest: payload.requestDigest,
    })
  } else if (payload.kind === 'InterruptInstanceRequest') {
    if (payload.expectedState !== 'Running') fail('invalid-request', 'interrupt expected state must be Running')
    text(payload.runIdentity, 'InterruptInstanceRequest.runIdentity', 256)
  } else if (payload.kind === 'DrainInstanceRequest') {
    if (!['Running', 'Interrupted'].includes(payload.expectedState)) fail('invalid-request', 'drain expected state is invalid')
    digest(payload.triggerFenceDigest, 'DrainInstanceRequest.triggerFenceDigest')
    if (payload.publisherEpoch !== null) uint64(payload.publisherEpoch, 'DrainInstanceRequest.publisherEpoch')
    digest(payload.deadlinePolicyDigest, 'DrainInstanceRequest.deadlinePolicyDigest')
  } else if (payload.kind === 'StopInstanceRequest') {
    if (payload.expectedState !== 'Drained') fail('invalid-request', 'stop expected state must be Drained')
    digest(payload.receiptChainHead, 'StopInstanceRequest.receiptChainHead')
  }
  assertSecretFree(payload, payload.kind)
  return payload
}

const SUCCESS_KEYS = Object.freeze({
  LockInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'receipt']),
  StartInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'sessionIdentity', 'receipt']),
  ResumeInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'sessionIdentity', 'receipt']),
  StatusInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'observedState', 'sessionIdentity', 'receiptChainHead', 'health', 'resources']),
  InterruptInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'receipt', 'retainedStateDigest']),
  DrainInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'receipt', 'reconciledEffectSummaryDigest']),
  StopInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'identity', 'observedState', 'receipt', 'retainedStateDisposition']),
  DoctorInstanceSucceeded: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'observedState', 'checks', 'recoveryRecommendation', 'receiptChainVerified']),
  ReconcileInstanceProvedTerminal: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'observedState', 'originalOperation', 'originalIdempotencyKey', 'originalRequestDigest']),
  ReconcileInstanceProvedSource: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'observedState', 'originalOperation', 'originalIdempotencyKey', 'originalRequestDigest']),
  ReconcileInstanceQuarantined: Object.freeze(['apiVersion', 'kind', 'requestId', 'identity', 'observedState', 'receipt', 'originalOperation', 'originalIdempotencyKey', 'originalRequestDigest']),
  ReconcileInstanceIndeterminate: Object.freeze(['apiVersion', 'kind', 'requestId', 'code', 'retryable', 'identity', 'observedState', 'originalOperation', 'originalIdempotencyKey', 'originalRequestDigest']),
})

/** @param {Record<string, any>} payload */
function validateManagerResult(payload) {
  if (payload.kind.startsWith('ValidateComposition') || payload.kind.startsWith('ResolveComposition')) {
    return /** @type {Record<string, any>} */ (validateCompositionProtocolResult(payload))
  }
  const successKeys = /** @type {Record<string, readonly string[]>} */ (SUCCESS_KEYS)[payload.kind]
  if (successKeys !== undefined) {
    exactKeys(payload, [...successKeys], [], payload.kind)
    if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION) fail('unsupported-api-version', 'manager result apiVersion is unsupported')
    text(payload.requestId, `${payload.kind}.requestId`, 256)
    identity(payload.identity)
    if (payload.kind === 'ReconcileInstanceIndeterminate') {
      if (payload.code !== 'evidence-temporarily-unavailable' || payload.retryable !== false) fail('schema-invalid', 'reconcile indeterminate result is invalid')
      instanceState(payload.observedState, `${payload.kind}.observedState`, true)
      if (/** @type {Record<string, any>} */ (MUTATION_TRANSITIONS)[payload.originalOperation] === undefined) fail('schema-invalid', 'reconcile indeterminate operation is invalid')
      text(payload.originalIdempotencyKey, `${payload.kind}.originalIdempotencyKey`, 256)
      digest(payload.originalRequestDigest, `${payload.kind}.originalRequestDigest`)
      assertSecretFree(payload, payload.kind)
      return payload
    }
    if (payload.kind === 'StatusInstanceSucceeded') {
      instanceState(payload.observedState, `${payload.kind}.observedState`)
      if (payload.sessionIdentity !== null) text(payload.sessionIdentity, `${payload.kind}.sessionIdentity`, 256)
      if (payload.receiptChainHead !== null) digest(payload.receiptChainHead, `${payload.kind}.receiptChainHead`)
      const health = plainRecord(payload.health, `${payload.kind}.health`)
      exactKeys(health, ['required', 'optional'], [], `${payload.kind}.health`)
      boundedStrings(health.required, `${payload.kind}.health.required`)
      boundedStrings(health.optional, `${payload.kind}.health.optional`)
      plainRecord(payload.resources, `${payload.kind}.resources`)
    } else if (payload.kind === 'DoctorInstanceSucceeded') {
      instanceState(payload.observedState, `${payload.kind}.observedState`)
      if (!Array.isArray(payload.checks) || payload.checks.length !== 3) fail('schema-invalid', 'doctor checks are invalid')
      const expectedChecks = ['composition-lock', 'admission-seal', 'receipt-chain']
      for (const [index, value] of payload.checks.entries()) {
        const check = plainRecord(value, `${payload.kind}.checks[${index}]`)
        exactKeys(check, ['id', 'state'], [], `${payload.kind}.checks[${index}]`)
        if (check.id !== expectedChecks[index] || !['pass', 'fail'].includes(check.state)) fail('schema-invalid', 'doctor check is invalid')
      }
      if (!['none', 'reconcile'].includes(payload.recoveryRecommendation)
        || typeof payload.receiptChainVerified !== 'boolean') fail('schema-invalid', 'doctor result is invalid')
    } else if (['ReconcileInstanceProvedTerminal', 'ReconcileInstanceProvedSource'].includes(payload.kind)) {
      const transition = /** @type {Record<string, {sources: readonly string[], terminal: string}>} */ (MUTATION_TRANSITIONS)[payload.originalOperation]
      if (transition === undefined) fail('schema-invalid', 'reconcile result operation is invalid')
      const allowed = payload.kind === 'ReconcileInstanceProvedTerminal' ? [transition.terminal] : transition.sources
      if (!allowed.includes(payload.observedState)) fail('schema-invalid', 'reconcile result state is invalid')
      text(payload.originalIdempotencyKey, `${payload.kind}.originalIdempotencyKey`, 256)
      digest(payload.originalRequestDigest, `${payload.kind}.originalRequestDigest`)
    } else if (payload.kind === 'ReconcileInstanceQuarantined') {
      if (payload.observedState !== 'Quarantined') fail('schema-invalid', 'quarantine result state is invalid')
      if (/** @type {Record<string, any>} */ (MUTATION_TRANSITIONS)[payload.originalOperation] === undefined) fail('schema-invalid', 'quarantine result operation is invalid')
      text(payload.originalIdempotencyKey, `${payload.kind}.originalIdempotencyKey`, 256)
      digest(payload.originalRequestDigest, `${payload.kind}.originalRequestDigest`)
      const receipt = validateQuarantineReceipt(payload.receipt)
      if (!sameIdentity(receipt.identity, payload.identity)
        || receipt.originalOperation !== payload.originalOperation
        || receipt.originalIdempotencyKey !== payload.originalIdempotencyKey
        || receipt.originalRequestDigest !== payload.originalRequestDigest) fail('schema-invalid', 'quarantine receipt correlation mismatch')
    } else {
      const operation = payload.kind.replace('InstanceSucceeded', '').toLowerCase()
      const transition = /** @type {Record<string, {terminal: string}>} */ (MUTATION_TRANSITIONS)[operation]
      if (transition === undefined || payload.observedState !== transition.terminal) fail('schema-invalid', `${payload.kind} state is invalid`)
      text(payload.idempotencyKey, `${payload.kind}.idempotencyKey`, 256)
      const receipt = validateLifecycleReceipt(payload.receipt)
      if (receipt.operation !== operation || receipt.idempotencyKey !== payload.idempotencyKey
        || !sameIdentity(receipt.identity, payload.identity)
        || receipt.observedState !== payload.observedState) fail('schema-invalid', `${payload.kind} receipt correlation is invalid`)
      if (['StartInstanceSucceeded', 'ResumeInstanceSucceeded'].includes(payload.kind)) {
        text(payload.sessionIdentity, `${payload.kind}.sessionIdentity`, 256)
        if (payload.sessionIdentity !== receipt.sessionIdentity) fail('schema-invalid', `${payload.kind} session identity mismatch`)
      }
      if (payload.kind === 'InterruptInstanceSucceeded' && payload.retainedStateDigest !== null) digest(payload.retainedStateDigest, `${payload.kind}.retainedStateDigest`)
      if (payload.kind === 'DrainInstanceSucceeded' && payload.reconciledEffectSummaryDigest !== null) digest(payload.reconciledEffectSummaryDigest, `${payload.kind}.reconciledEffectSummaryDigest`)
      if (payload.kind === 'StopInstanceSucceeded' && payload.retainedStateDisposition !== 'retained') fail('schema-invalid', 'stop retained state disposition is invalid')
    }
    assertSecretFree(payload, payload.kind)
    return payload
  }
  if (payload.kind.endsWith('Indeterminate')) {
    exactKeys(payload, ['apiVersion', 'kind', 'requestId', 'idempotencyKey', 'code', 'retryable', 'lastObservedState', 'identity', 'receiptDigest', 'mandatoryRecovery'], [], payload.kind)
    if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION || payload.code !== 'effect-unknown' || payload.retryable !== false) fail('schema-invalid', 'manager indeterminate result is invalid')
    text(payload.requestId, `${payload.kind}.requestId`, 256)
    text(payload.idempotencyKey, `${payload.kind}.idempotencyKey`, 256)
    identity(payload.identity)
    instanceState(payload.lastObservedState, `${payload.kind}.lastObservedState`)
    const operation = payload.kind.replace('InstanceIndeterminate', '').toLowerCase()
    const transition = /** @type {Record<string, {transient: string}>} */ (MUTATION_TRANSITIONS)[operation]
    if (transition === undefined || payload.lastObservedState !== transition.transient) fail('schema-invalid', 'manager indeterminate state is invalid')
    if (payload.receiptDigest !== null) digest(payload.receiptDigest, `${payload.kind}.receiptDigest`)
    const recovery = plainRecord(payload.mandatoryRecovery, `${payload.kind}.mandatoryRecovery`)
    exactKeys(recovery, ['statusRequired', 'doctorRequired', 'repeatSameOperationAndKey', 'quarantineIfStillUnknown'], [], `${payload.kind}.mandatoryRecovery`)
    if (Object.values(recovery).some(value => value !== true)) fail('schema-invalid', 'manager indeterminate recovery is invalid')
    assertSecretFree(payload, payload.kind)
    return payload
  }
  if (payload.kind.endsWith('Failed')) {
    const authenticated = ['LockInstanceFailed', 'StartInstanceFailed', 'ResumeInstanceFailed'].includes(payload.kind)
    const allowedCodes = /** @type {Record<string, Set<string>>} */ (MANAGER_FAILURE_CODES_BY_KIND)[payload.kind]
    if (allowedCodes === undefined) fail('unsupported-kind', 'manager failure result kind is unsupported')
    exactKeys(payload, [
      'apiVersion', 'kind', 'requestId', 'code', 'retryable', 'observedState',
      'identity', 'receiptDigest', 'details',
      ...(authenticated ? ['trustAcceptanceFailureDigest'] : []),
    ], [], payload.kind)
    if (payload.apiVersion !== RUNTIME_MANAGER_API_VERSION || !allowedCodes.has(payload.code)
      || payload.retryable !== MANAGER_RETRYABLE_FAILURE_CODES.has(payload.code)) fail('schema-invalid', 'manager failure result is invalid')
    if (payload.requestId !== null) text(payload.requestId, `${payload.kind}.requestId`, 256)
    if (payload.identity !== null) identity(payload.identity)
    instanceState(payload.observedState, `${payload.kind}.observedState`, true)
    if (payload.receiptDigest !== null) digest(payload.receiptDigest, `${payload.kind}.receiptDigest`)
    if (authenticated && payload.trustAcceptanceFailureDigest !== null) {
      digest(payload.trustAcceptanceFailureDigest, `${payload.kind}.trustAcceptanceFailureDigest`)
      if (!Object.values(TRUST_FAILURE_CODE_MAP).includes(payload.code)) {
        fail('schema-invalid', `${payload.kind} trust failure digest is not valid for its code`)
      }
    }
    if (authenticated && requiresTrustAcceptanceFailureDigest(payload.code)
      && payload.trustAcceptanceFailureDigest === null) {
      fail('schema-invalid', `${payload.kind} requires its authenticated trust failure digest`)
    }
    validateFailureDetails(payload.details, payload.code, `${payload.kind}.details`)
    assertSecretFree(payload, payload.kind)
    return payload
  }
  fail('unsupported-kind', 'manager result kind is unsupported')
}

/** @param {Record<string, any>} request @param {Record<string, any>} result */
function correlateManagerResult(request, result) {
  if (result.requestId !== request.requestId) fail('cross-kind-substitution', 'manager result requestId does not match its request')
  if (request.identity !== undefined) {
    if (result.identity === null || result.identity === undefined || !sameIdentity(result.identity, request.identity)) {
      fail('cross-kind-substitution', 'manager result identity does not match its request')
    }
  }
  if (request.idempotencyKey !== undefined && result.idempotencyKey !== undefined
    && result.idempotencyKey !== request.idempotencyKey) {
    fail('cross-kind-substitution', 'manager result idempotency key does not match its request')
  }
  if (result.receipt !== undefined && request.requestDigest !== undefined) {
    const receipt = result.receipt
    const operation = /** @type {Record<string, string>} */ (MANAGER_OPERATION_BY_REQUEST)[request.kind]
    let matches = receipt.operation === operation
      && receipt.requestDigest === request.requestDigest
      && receipt.sourceState === request.expectedState
    if (request.kind === 'LockInstanceRequest') {
      matches = matches
        && receipt.priorReceiptDigest === null
        && receipt.compositionLockReceiptDigest === request.compositionLockReceipt.digest
        && receipt.resolvedCompositionDigest === request.resolvedCompositionDigest
        && receipt.admissionSealDigest === request.admissionSealDigest
    } else if (['StartInstanceRequest', 'ResumeInstanceRequest'].includes(request.kind)) {
      matches = matches
        && receipt.priorReceiptDigest === request.priorReceiptDigest
        && receipt.admissionSealDigest === request.admissionSealDigest
    } else if (request.kind === 'InterruptInstanceRequest') {
      matches = matches && receipt.sessionIdentity === request.runIdentity
    } else if (request.kind === 'StopInstanceRequest') {
      matches = matches && receipt.priorReceiptDigest === request.receiptChainHead
    }
    if (!matches) fail('cross-kind-substitution', 'manager result receipt does not match its request')
  }
  if (request.kind === 'ReconcileInstanceRequest' && result.kind !== 'ReconcileInstanceFailed'
    && (result.originalOperation !== request.originalOperation
      || result.originalIdempotencyKey !== request.originalIdempotencyKey
      || result.originalRequestDigest !== request.originalRequestDigest)) {
    fail('cross-kind-substitution', 'reconcile result does not match its original operation')
  }
}

/** @param {unknown} value */
export function validateManagerPayload(value) {
  const payload = plainRecord(value, 'manager payload')
  if (!MANAGER_REQUEST_KINDS.includes(payload.kind) && !MANAGER_RESULT_KINDS.includes(payload.kind)) {
    fail('unsupported-kind', 'manager payload kind is unsupported')
  }
  if (MANAGER_REQUEST_KINDS.includes(payload.kind)) {
    if (payload.kind === 'StatusInstanceRequest') return validateStatusRequest(payload)
    return validateKnownRequest(payload)
  }
  if (payload.kind === 'StatusInstanceFailed') return validateStatusFailure(payload)
  return validateManagerResult(payload)
}

/** @param {{connectionNonce: string, payload: unknown}} input */
export function createManagerControlRequestFrame(input) {
  uint64(input.connectionNonce, 'connectionNonce')
  assertCanonicalByteBound(input.payload, 'manager request payload')
  const payload = validateManagerPayload(input.payload)
  if (!MANAGER_REQUEST_KINDS.includes(payload.kind)) fail('unsupported-kind', 'request frame requires a request payload')
  const frame = {
    apiVersion: RUNTIME_MANAGER_API_VERSION,
    kind: 'ManagerControlRequestFrame',
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    connectionNonce: input.connectionNonce,
    payloadKind: payload.kind,
    payload: structuredClone(payload),
    frameDigest: `sha256:${'0'.repeat(64)}`,
  }
  frame.frameDigest = computeManagerDocumentDigest(frame)
  assertCanonicalByteBound(frame, 'ManagerControlRequestFrame')
  return Object.freeze(frame)
}

/** @param {unknown} value */
export function validateManagerControlRequestFrame(value) {
  assertCanonicalByteBound(value, 'ManagerControlRequestFrame')
  const frame = plainRecord(value, 'ManagerControlRequestFrame')
  exactKeys(frame, ['apiVersion', 'kind', 'protocolVersion', 'connectionNonce', 'payloadKind', 'payload', 'frameDigest'], [], 'ManagerControlRequestFrame')
  if (frame.apiVersion !== RUNTIME_MANAGER_API_VERSION || frame.kind !== 'ManagerControlRequestFrame' || frame.protocolVersion !== CONTROL_PROTOCOL_VERSION) fail('unsupported-kind', 'request frame identity is unsupported')
  uint64(frame.connectionNonce, 'ManagerControlRequestFrame.connectionNonce')
  const payload = validateManagerPayload(frame.payload)
  if (!MANAGER_REQUEST_KINDS.includes(frame.payloadKind) || payload.kind !== frame.payloadKind) fail('cross-kind-substitution', 'request frame payload kind mismatch')
  digest(frame.frameDigest, 'ManagerControlRequestFrame.frameDigest')
  if (computeManagerDocumentDigest(frame) !== frame.frameDigest) fail('digest-invalid', 'request frame digest is invalid')
  return value
}

/** @param {{requestFrame: unknown, payload: unknown}} input */
export function createManagerControlResponseFrame(input) {
  const request = /** @type {Record<string, any>} */ (validateManagerControlRequestFrame(input.requestFrame))
  assertCanonicalByteBound(input.payload, 'manager response payload')
  const payload = validateManagerPayload(input.payload)
  if (!MANAGER_RESULT_KINDS.includes(payload.kind)) fail('unsupported-kind', 'response frame requires a result payload')
  const allowed = /** @type {Record<string, readonly string[]>} */ (MANAGER_RESULT_KINDS_BY_REQUEST)[request.payloadKind]
  if (!allowed.includes(payload.kind)) fail('cross-kind-substitution', 'response payload is not valid for the accepted request kind')
  correlateManagerResult(request.payload, payload)
  const frame = {
    apiVersion: RUNTIME_MANAGER_API_VERSION,
    kind: 'ManagerControlResponseFrame',
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    connectionNonce: request.connectionNonce,
    requestFrameDigest: request.frameDigest,
    payloadKind: payload.kind,
    payload: structuredClone(payload),
    frameDigest: `sha256:${'0'.repeat(64)}`,
  }
  frame.frameDigest = computeManagerDocumentDigest(frame)
  assertCanonicalByteBound(frame, 'ManagerControlResponseFrame')
  return Object.freeze(frame)
}

/** @param {unknown} value @param {unknown} requestFrame */
export function validateManagerControlResponseFrame(value, requestFrame) {
  assertCanonicalByteBound(value, 'ManagerControlResponseFrame')
  const request = /** @type {Record<string, any>} */ (validateManagerControlRequestFrame(requestFrame))
  const frame = plainRecord(value, 'ManagerControlResponseFrame')
  exactKeys(frame, ['apiVersion', 'kind', 'protocolVersion', 'connectionNonce', 'requestFrameDigest', 'payloadKind', 'payload', 'frameDigest'], [], 'ManagerControlResponseFrame')
  if (frame.apiVersion !== RUNTIME_MANAGER_API_VERSION || frame.kind !== 'ManagerControlResponseFrame' || frame.protocolVersion !== CONTROL_PROTOCOL_VERSION) fail('unsupported-kind', 'response frame identity is unsupported')
  if (frame.connectionNonce !== request.connectionNonce || frame.requestFrameDigest !== request.frameDigest) fail('cross-kind-substitution', 'response frame does not bind the accepted request frame')
  const payload = validateManagerPayload(frame.payload)
  if (!MANAGER_RESULT_KINDS.includes(frame.payloadKind) || payload.kind !== frame.payloadKind) fail('cross-kind-substitution', 'response frame payload kind mismatch')
  const allowed = /** @type {Record<string, readonly string[]>} */ (MANAGER_RESULT_KINDS_BY_REQUEST)[request.payloadKind]
  if (!allowed.includes(payload.kind)) fail('cross-kind-substitution', 'response payload is not valid for the accepted request kind')
  correlateManagerResult(request.payload, payload)
  digest(frame.frameDigest, 'ManagerControlResponseFrame.frameDigest')
  if (computeManagerDocumentDigest(frame) !== frame.frameDigest) fail('digest-invalid', 'response frame digest is invalid')
  return value
}

/**
 * Transport-independent authenticated ManagerControl dispatcher. The caller
 * must supply the kernel-authenticated peer identity; body fields never grant
 * access. The nonce high-water map is injectable so production can persist it.
 * @param {{
 *   manager: Record<string, (payload: unknown, context?: any) => Promise<any> | any>,
 *   peers: Record<string, {operations: string[], namespacePrefixes: string[]}>,
 *   nonceHighWater?: Map<string, string>,
 * }} options
 */
export function createManagerControlService(options) {
  const highWater = options.nonceHighWater ?? new Map()
  /** @param {unknown} value @param {{peerIdentity: string}} context */
  const handle = async (value, context) => {
    const frame = /** @type {Record<string, any>} */ (validateManagerControlRequestFrame(value))
    const peer = options.peers[context?.peerIdentity]
    if (peer === undefined) fail('unauthenticated', 'manager control peer is not authenticated')
    const operation = /** @type {Record<string, string>} */ (MANAGER_OPERATION_BY_REQUEST)[frame.payloadKind]
    if (!peer.operations.includes(operation)) fail('unauthorized', 'manager control operation is not allowed for this peer')
    const previous = highWater.get(context.peerIdentity)
    if (previous !== undefined && BigInt(frame.connectionNonce) <= BigInt(previous)) fail('replayed-nonce', 'manager control frame nonce was replayed')
    const namespace = frame.payload?.identity?.namespace
    if (typeof namespace === 'string' && !peer.namespacePrefixes.some(prefix => namespace === prefix || namespace.startsWith(`${prefix}/`))) {
      fail('unauthorized', 'manager control namespace is not allowed for this peer')
    }
    const method = options.manager[operation]
    if (typeof method !== 'function') fail('unsupported-kind', 'manager operation is unavailable')
    highWater.set(context.peerIdentity, frame.connectionNonce)
    const result = await method(structuredClone(frame.payload), operation === 'reconcile' ? { authorized: true } : undefined)
    return createManagerControlResponseFrame({ requestFrame: frame, payload: result })
  }
  return Object.freeze({ handle, nonceHighWater: highWater })
}
