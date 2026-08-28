import { generateKeyPairSync, sign } from 'node:crypto'

import {
  computeDocumentDigest,
  domainSeparatedDigest,
} from '../../src/composition/index.js'
import {
  computeManagerDocumentDigest,
  protocolSignatureMessage,
} from '../../src/manager/index.js'

export const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`
export const ONE_DIGEST = `sha256:${'1'.repeat(64)}`
export const TWO_DIGEST = `sha256:${'2'.repeat(64)}`
export const THREE_DIGEST = `sha256:${'3'.repeat(64)}`

export function compositionProtocolRequests() {
  const descriptor = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'PluginDescriptor',
    metadata: { id: 'github-review', version: '1.0.0', digest: ZERO_DIGEST },
    artifact: {
      package: '@sympoies/github-review', digest: ONE_DIGEST,
      entrypoint: 'dist/index.js',
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      attestationIdentity: 'https://github.com/sympoies/dsh-applications/.github/workflows/release.yml@refs/tags/v1.0.0',
    },
    compatibility: {
      dsh: '>=0.1.1-rc.2 <0.2.0', runtimeKit: '>=0.1.0 <1.0.0',
      pluginApi: '=1.0.0', platforms: ['linux-x64'],
    },
    capabilities: {
      provides: ['plugin.github-review'], requires: ['cap.github.read'],
      tools: [], skills: [], services: [], dependencies: [],
    },
    actions: [], configuration: { schemaDigest: TWO_DIGEST, defaults: {} },
    mediation: {
      filesystem: [], network: [], subprocess: [],
      resources: { cpuClass: 'shared', memoryMb: 128, outputBytes: 65_536 },
      credentialHandleClasses: [],
    },
    health: { probes: [{ id: 'github-review.ready', requirement: 'required' }] },
    composition: {
      conflicts: [], cardinality: { min: 1, max: 1 },
      namespaceClaims: ['plugin.github-review'], ordering: { before: [], after: [] },
    },
    lifecycle: {
      readiness: 'required', interrupt: 'supported', drain: 'required',
      disposal: 'required', recovery: 'reconcile',
    },
  }
  descriptor.metadata.digest = computeDocumentDigest(descriptor)
  const profile = {
    apiVersion: 'runtime.sympoies.dev/v1', kind: 'BotProfile',
    metadata: {
      id: 'mes-bot-review', version: '1.0.0', digest: ZERO_DIGEST,
      purpose: 'Bounded pull-request review',
    },
    workload: { class: 'event-service', scopeClass: 'non-project' },
    plugins: [{ id: 'github-review', range: '>=1.0.0 <2.0.0' }],
    grants: ['cap.github.read'], requiredHealth: ['github-review.ready'],
    artifacts: {
      instructions: 'profiles/mes-bot-review/instructions.md', skills: [],
      inputSchemaDigest: TWO_DIGEST, outputSchemaDigest: THREE_DIGEST,
    },
    modelRouteClass: 'review-bounded',
    state: {
      session: 'ephemeral', memory: 'none', workspace: 'none',
      retentionSeconds: 3600, restart: 'fresh',
    },
    approvals: { requiredFor: ['destructive', 'open-world'] },
    limits: {
      actions: 8, networkClasses: ['github-api'], workspaceClasses: [],
      budgetUnits: 100, ratePerMinute: 8,
    },
    triggers: [{ class: 'webhook', inputSchemaDigest: TWO_DIGEST }],
    execution: {
      concurrency: 1, overlap: 'forbid', timeoutMs: 300_000,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      cancellation: 'cooperative', interrupt: 'supported', drain: 'required',
    },
  }
  profile.metadata.digest = computeDocumentDigest(profile)
  const runtime = {
    dshVersion: '0.1.1-rc.2', runtimeKitVersion: '0.1.0',
    pluginApiVersion: '1.0.0', platform: 'linux-x64',
  }
  return {
    validate: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'ValidateCompositionRequest',
      requestId: 'validate-frame', descriptors: [descriptor], profile,
      readerSchemas: [
        'PluginDescriptor', 'BotProfile', 'ResolvedComposition', 'CompositionLockReceipt',
      ].map(kind => ({ apiVersion: 'runtime.sympoies.dev/v1', kind })),
      runtime,
    },
    resolve: {
      apiVersion: 'runtime.sympoies.dev/v1', kind: 'ResolveCompositionRequest',
      requestId: 'resolve-frame',
      validatedDocumentDigests: {
        profile: profile.metadata.digest, descriptors: [descriptor.metadata.digest],
      },
      catalogSnapshotDigest: ONE_DIGEST, runtime,
      publicPolicyCeilingDigest: TWO_DIGEST,
    },
  }
}

export function identity(overrides = {}) {
  const value = {
    deploymentId: 'review-service',
    profileId: 'mes-bot-review',
    generationId: 'generation-1',
    instanceId: 'instance-1',
    ...overrides,
  }
  value.namespace = `${value.deploymentId}/${value.profileId}/${value.generationId}/${value.instanceId}`
  return value
}

export function composition(scopeClass = 'non-project', overrides = {}) {
  const project = scopeClass === 'project'
  const document = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ResolvedComposition',
    metadata: { digest: ZERO_DIGEST },
    runtime: {
      dshVersion: '0.1.1-rc.2',
      runtimeKitVersion: '0.1.0',
      pluginApiVersion: '1.0.0',
      platform: 'linux-x64',
      compatibilityDecision: 'compatible',
    },
    profile: {
      id: 'mes-bot-review',
      version: '1.0.0',
      digest: ONE_DIGEST,
      workloadClass: project ? 'interactive-coding' : 'event-service',
      scopeClass,
    },
    plugins: [{
      id: 'github-review',
      version: '1.0.0',
      descriptorDigest: TWO_DIGEST,
      artifactDigest: THREE_DIGEST,
      dependencyOrder: 0,
      configurationDigest: ONE_DIGEST,
    }],
    authorityCeiling: {
      capabilities: project ? ['coding.read'] : ['cap.github.read'],
      networkClasses: ['github-api'],
      workspaceClasses: project ? ['project'] : [],
    },
    publicPolicyDigest: TWO_DIGEST,
    modelRouteClass: 'review-bounded',
    isolation: {
      workspaceClass: project ? 'project' : 'none',
      sessionClass: 'ephemeral',
      memoryClass: 'none',
    },
    resources: { classes: ['shared'] },
    health: { required: ['github-review.ready'], optional: ['github-review.metrics'] },
    resolver: { version: '1.0.0', reason: 'initial' },
    ...overrides,
  }
  document.metadata.digest = computeDocumentDigest(document)
  return document
}

export function compositionLock(resolved) {
  const receipt = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'CompositionLockReceipt',
    digest: ZERO_DIGEST,
    resolvedCompositionDigest: resolved.metadata.digest,
    resolver: { version: resolved.resolver.version },
    inputDigests: {
      profile: resolved.profile.digest,
      descriptors: resolved.plugins.map(item => item.descriptorDigest).sort(),
      catalogSnapshot: THREE_DIGEST,
      publicPolicy: resolved.publicPolicyDigest,
    },
    reason: resolved.resolver.reason,
  }
  receipt.digest = computeDocumentDigest(receipt)
  return receipt
}

export function signingFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey,
    keyId: 'ed25519:test-assertion',
    publicKeyHex: Buffer.from(der).subarray(-32).toString('hex'),
  }
}

export function trustBundle(signing, overrides = {}) {
  const document = {
    apiVersion: 'infra.serenvia.dev/v1',
    kind: 'DshTrustBundle',
    metadata: { digest: ZERO_DIGEST },
    namespace: 'review-service',
    bundleId: 'bundle-1',
    createdAt: '2026-08-28T00:00:00Z',
    keys: [
      {
        keyId: signing.keyId,
        algorithm: 'Ed25519',
        use: 'assertion',
        rawPublicKeyHex: signing.publicKeyHex,
        state: 'active',
      },
      {
        keyId: 'ed25519:test-seal',
        algorithm: 'Ed25519',
        use: 'seal',
        rawPublicKeyHex: signing.publicKeyHex,
        state: 'active',
      },
      {
        keyId: 'ed25519:test-transition',
        algorithm: 'Ed25519',
        use: 'trust-transition',
        rawPublicKeyHex: signing.publicKeyHex,
        state: 'active',
      },
    ],
    ...overrides,
  }
  document.keys.sort((left, right) => left.keyId.localeCompare(right.keyId))
  document.metadata.digest = computeManagerDocumentDigest(document)
  return document
}

function signedDocument(document, signing) {
  document.metadata.digest = computeManagerDocumentDigest(document)
  document.signature = sign(null, protocolSignatureMessage(document), signing.privateKey)
    .toString('base64url')
  return document
}

export function trustTransition(prior, next, signing, sequence, keyStateChanges, retirementOverlapEnds = []) {
  return signedDocument({
    apiVersion: 'infra.serenvia.dev/v1', kind: 'DshTrustBundleTransition',
    metadata: { digest: ZERO_DIGEST }, priorBundleDigest: prior.metadata.digest,
    nextBundleDigest: next.metadata.digest, sequence: String(sequence),
    effectiveAt: '2026-08-28T00:00:01Z', keyStateChanges,
    retirementOverlapEnds, reasonCode: 'routine-rotation',
    signerKeyId: 'ed25519:test-transition', signature: '',
  }, signing)
}

export function admissionSeal(resolved, lock, instanceIdentity, signing, bundle, overrides = {}) {
  const effectiveAuthority = {
    capabilities: [...resolved.authorityCeiling.capabilities],
    networkClasses: [...resolved.authorityCeiling.networkClasses],
    workspaceClasses: [...resolved.authorityCeiling.workspaceClasses],
    resourceClasses: [...resolved.resources.classes],
  }
  return signedDocument({
    apiVersion: 'infra.serenvia.dev/v1',
    kind: 'DshDeploymentAdmissionSeal',
    metadata: { digest: ZERO_DIGEST },
    compositionLockReceiptDigest: lock.digest,
    resolvedCompositionDigest: resolved.metadata.digest,
    bindingDigest: ONE_DIGEST,
    trustPolicyDigest: TWO_DIGEST,
    trustPolicyEvidenceDigest: THREE_DIGEST,
    identity: structuredClone(instanceIdentity),
    effectiveAuthority,
    effectiveAuthorityDigest: domainSeparatedDigest('sympoies/private-effective-authority/v1', effectiveAuthority),
    resourceClasses: [...resolved.resources.classes],
    credentialHandleClasses: [],
    controllerIdentity: 'controller.review-service',
    priorControllerReceiptDigest: null,
    signatureSuite: 'Ed25519',
    keyId: 'ed25519:test-seal',
    bundleDigest: bundle.metadata.digest,
    signature: '',
    ...overrides,
  }, signing)
}

export function runtimeAssertion(seal, instanceIdentity, signing, bundle, operation, semanticRequestDigest, overrides = {}) {
  return signedDocument({
    apiVersion: 'infra.serenvia.dev/v1',
    kind: 'DshDeploymentRuntimeAssertion',
    metadata: { digest: ZERO_DIGEST },
    admissionSealDigest: seal.metadata.digest,
    identity: structuredClone(instanceIdentity),
    operation: operation.includes('.') ? operation : `instance.${operation}`,
    semanticRequestDigest,
    bundleDigest: bundle.metadata.digest,
    controllerCasRevision: '1',
    controllerReceiptHead: ONE_DIGEST,
    generationEligible: true,
    trafficScopeDigest: TWO_DIGEST,
    publisherEpoch: '1',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: '2026-08-28T00:00:00Z',
    expiresAt: '2026-08-28T00:10:00Z',
    revocationId: 'assertion-1',
    signatureSuite: 'Ed25519',
    keyId: signing.keyId,
    signature: '',
    ...overrides,
  }, signing)
}

export function acceptingTrustVerifier() {
  const calls = []
  return {
    calls,
    async acceptSignedDocument(input) {
      calls.push(structuredClone(input))
      return Object.freeze({
        digest: domainSeparatedDigest('serenvia/dsh-trust-acceptance-succeeded/v1', input),
        authorityTime: '2026-08-28T00:00:01Z',
        timeRevision: String(calls.length),
      })
    },
  }
}

export function baseLockRequest(resolved, lock, instanceIdentity, seal) {
  return {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'LockInstanceRequest',
    requestId: 'request-lock-1',
    idempotencyKey: 'lock-key-1',
    requestDigest: ZERO_DIGEST,
    identity: structuredClone(instanceIdentity),
    resolvedComposition: structuredClone(resolved),
    resolvedCompositionDigest: resolved.metadata.digest,
    compositionLockReceipt: structuredClone(lock),
    admissionSeal: structuredClone(seal),
    admissionSealDigest: seal.metadata.digest,
    runtimeAssertion: null,
    runtimeAssertionDigest: null,
    expectedState: 'Absent',
  }
}
