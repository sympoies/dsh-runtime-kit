import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPOSITION_CONTRACT_ERROR_CODES,
  COMPOSITION_PROTOCOL_FAILURE_CODES,
  COMPOSITION_RESOLVE_ERROR_MAP,
  COMPOSITION_VALIDATE_ERROR_MAP,
  CompositionContractError,
  canonicalJson,
  compareSemver,
  computeCatalogSnapshotDigest,
  computeDocumentDigest,
  computePublicPolicyDigest,
  createCompositionService,
  domainSeparatedDigest,
  parseCanonicalJsonText,
  parseSemver,
  parseVersionRange,
  resolveComposition as resolveCompositionContract,
  selectCompositionApiVersion,
  validateBotProfile,
  validateCompositionLockReceipt,
  validateCompositionProtocolResult,
  validatePluginDescriptor,
  validateResolvedComposition,
  versionSatisfies,
} from '../src/composition/index.js'

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`
const ONE_DIGEST = `sha256:${'1'.repeat(64)}`
const TWO_DIGEST = `sha256:${'2'.repeat(64)}`
const THREE_DIGEST = `sha256:${'3'.repeat(64)}`

function seal(document) {
  const copy = structuredClone(document)
  if (copy.kind === 'CompositionLockReceipt') copy.digest = computeDocumentDigest(copy)
  else copy.metadata.digest = computeDocumentDigest(copy)
  return copy
}

function plugin(id, version, options = {}) {
  const requires = options.requires ?? []
  const provides = options.provides ?? [`plugin.${id}`]
  const dependencies = options.dependencies ?? []
  return seal({
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'PluginDescriptor',
    metadata: { id, version, digest: ZERO_DIGEST },
    artifact: {
      package: `@sympoies/${id}`,
      digest: ONE_DIGEST,
      entrypoint: 'dist/index.js',
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      attestationIdentity: 'https://github.com/sympoies/dsh-applications/.github/workflows/release.yml@refs/tags/v1.0.0',
    },
    compatibility: {
      dsh: '>=0.1.1-rc.2 <0.2.0',
      runtimeKit: '>=0.1.0 <1.0.0',
      pluginApi: '=1.0.0',
      platforms: ['linux-x64'],
    },
    capabilities: {
      provides,
      requires,
      tools: options.tools ?? [],
      skills: options.skills ?? [],
      services: options.services ?? [],
      dependencies,
    },
    actions: options.actions ?? [],
    configuration: { schemaDigest: TWO_DIGEST, defaults: options.defaults ?? {} },
    mediation: {
      filesystem: [],
      network: [],
      subprocess: [],
      resources: { cpuClass: 'shared', memoryMb: 128, outputBytes: 65_536 },
      credentialHandleClasses: [],
    },
    health: { probes: [{ id: `${id}.ready`, requirement: 'required' }] },
    composition: {
      conflicts: options.conflicts ?? [],
      cardinality: options.cardinality ?? { min: 1, max: 1 },
      namespaceClaims: options.namespaceClaims ?? [`plugin.${id}`],
      ordering: options.ordering ?? { before: [], after: [] },
    },
    lifecycle: {
      readiness: 'required',
      interrupt: 'supported',
      drain: 'required',
      disposal: 'required',
      recovery: 'reconcile',
    },
  })
}

function profile(options = {}) {
  const workloadClass = options.workloadClass ?? 'event-service'
  const scopeClass = options.scopeClass ?? 'non-project'
  const grants = options.grants ?? ['cap.github.read', 'cap.github.review.publish']
  return seal({
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'BotProfile',
    metadata: {
      id: options.id ?? 'mes-bot-review',
      version: options.version ?? '1.0.0',
      digest: ZERO_DIGEST,
      purpose: 'Bounded pull-request review',
    },
    workload: { class: workloadClass, scopeClass },
    plugins: options.plugins ?? [{ id: 'github-review', range: '>=1.0.0 <2.0.0' }],
    grants,
    requiredHealth: options.requiredHealth ?? ['github-review.ready'],
    artifacts: {
      instructions: 'profiles/mes-bot-review/instructions.md',
      skills: [],
      inputSchemaDigest: TWO_DIGEST,
      outputSchemaDigest: THREE_DIGEST,
    },
    modelRouteClass: 'review-bounded',
    state: {
      session: 'ephemeral',
      memory: 'none',
      workspace: scopeClass === 'project' ? 'project' : 'none',
      retentionSeconds: 3600,
      restart: 'fresh',
    },
    approvals: { requiredFor: ['destructive', 'open-world'] },
    limits: {
      actions: 8,
      networkClasses: ['github-api'],
      workspaceClasses: scopeClass === 'project' ? ['project'] : [],
      budgetUnits: 100,
      ratePerMinute: 8,
    },
    triggers: options.triggers ?? [{ class: 'webhook', inputSchemaDigest: TWO_DIGEST }],
    execution: {
      concurrency: 1,
      overlap: 'forbid',
      timeoutMs: 300_000,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      cancellation: 'cooperative',
      interrupt: 'supported',
      drain: 'required',
    },
  })
}

const runtime = Object.freeze({
  dshVersion: '0.1.1-rc.2',
  runtimeKitVersion: '0.1.0',
  pluginApiVersion: '1.0.0',
  platform: 'linux-x64',
  resolverVersion: '1.0.0',
})

const publicPolicyDocument = {
  digest: ZERO_DIGEST,
  grants: ['cap.github.read', 'cap.github.review.publish'],
  networkClasses: ['github-api'],
  workspaceClasses: [],
  resourceClasses: ['shared'],
}
publicPolicyDocument.digest = computePublicPolicyDigest(publicPolicyDocument)
const publicPolicy = Object.freeze(publicPolicyDocument)

function resolveComposition(input) {
  return resolveCompositionContract({
    ...input,
    catalogSnapshotDigest: computeCatalogSnapshotDigest(input.plugins),
  })
}

function assertContractCode(operation, code) {
  assert.throws(
    operation,
    error => error instanceof CompositionContractError && error.code === code,
  )
}

function assertSecretFreeError(operation, code, forbidden) {
  assert.throws(operation, error => {
    if (!(error instanceof CompositionContractError) || error.code !== code) return false
    const serialized = JSON.stringify({ message: error.message, details: error.details })
    return !serialized.includes(forbidden)
  })
}

const readerSchemas = Object.freeze([
  { apiVersion: 'runtime.sympoies.dev/v1', kind: 'PluginDescriptor' },
  { apiVersion: 'runtime.sympoies.dev/v1', kind: 'BotProfile' },
  { apiVersion: 'runtime.sympoies.dev/v1', kind: 'ResolvedComposition' },
  { apiVersion: 'runtime.sympoies.dev/v1', kind: 'CompositionLockReceipt' },
])

const protocolRuntime = Object.freeze({
  dshVersion: runtime.dshVersion,
  runtimeKitVersion: runtime.runtimeKitVersion,
  pluginApiVersion: runtime.pluginApiVersion,
  platform: runtime.platform,
})

test('RFC 8785 canonical bytes and public domain vectors are frozen', () => {
  const value = { z: [true, null], n: 1, a: 'é' }
  assert.equal(canonicalJson(value), '{"a":"é","n":1,"z":[true,null]}')
  assert.equal(
    domainSeparatedDigest('sympoies/plugin-descriptor/v1', value),
    'sha256:0ac5776c925e58b9b5c00b75a640c1098f4c7787aba2e837fdbade6f4bb6b713',
  )
  assert.equal(
    domainSeparatedDigest('sympoies/bot-profile/v1', value),
    'sha256:2c597cb1797de06c87d24e038d532802064ef688d70b68a3a24d87471c2ab2be',
  )
  assert.equal(
    domainSeparatedDigest('sympoies/resolved-composition/v1', value),
    'sha256:9e8e69a2c9e29110879adf57c07d0fc02e0a8ea39ec277b2f6020eaf148d3903',
  )
  assert.equal(
    domainSeparatedDigest('sympoies/composition-lock-receipt/v1', value),
    'sha256:41bf5f3ee00ba2dd33acbbc4b67913f0217b4db823748404dce8ddabd8c1a71c',
  )
  const numbers = { small: 1e-7, large: 1e30, fraction: 333333333.33333329 }
  assert.equal(
    canonicalJson(numbers),
    '{"fraction":333333333.3333333,"large":1e+30,"small":1e-7}',
  )
  assert.equal(
    domainSeparatedDigest('sympoies/plugin-descriptor/v1', numbers),
    'sha256:d693cf552f1b69bf1fb12264e1fba1a6d2cc27032625a47309f91a25eef7e7a0',
  )
  assert.equal(canonicalJson({
    '€': 'Euro',
    '\r': 'Carriage Return',
    'דּ': 'Hebrew',
    1: 'One',
    '😀': 'Emoji',
    '\u0080': 'Control',
    'ö': 'Latin',
  }), '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin","€":"Euro","😀":"Emoji","דּ":"Hebrew"}')
  assert.equal(
    canonicalJson({ text: '\u000f\n"\\/' }),
    '{"text":"\\u000f\\n\\"\\\\/"}',
  )
  assert.deepEqual(parseCanonicalJsonText('{"a":1,"b":2}'), { a: 1, b: 2 })
  assertContractCode(
    () => parseCanonicalJsonText('{"a":1,"a":2}'),
    'duplicate-json-key',
  )
  assertContractCode(() => canonicalJson({ n: -0 }), 'canonical-number-invalid')
  assertContractCode(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), 'canonical-number-invalid')
  assertContractCode(() => canonicalJson('\ud800'), 'canonical-string-invalid')
  const accessor = {}
  Object.defineProperty(accessor, 'a', { enumerable: true, get: () => 1 })
  assertContractCode(() => canonicalJson(accessor), 'schema-invalid')
  const arrayWithProperty = [1]
  arrayWithProperty.extra = true
  assertContractCode(() => canonicalJson(arrayWithProperty), 'schema-invalid')
  let nested = null
  for (let depth = 0; depth < 66; depth += 1) nested = [nested]
  assertContractCode(() => canonicalJson(nested), 'canonical-value-invalid')
  assertContractCode(
    () => parseCanonicalJsonText(`${'['.repeat(66)}0${']'.repeat(66)}`),
    'json-invalid',
  )
})

test('SemVer and range grammar reject shorthand and preserve prerelease rules', () => {
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0'), -1)
  assert.equal(compareSemver('1.0.0-1a', '1.0.0-1b'), -1)
  assert.equal(compareSemver('1.0.0-1-foo', '1.0.0-2-foo'), -1)
  assert.equal(versionSatisfies('1.4.0', '>=1.0.0 <2.0.0'), true)
  assert.equal(versionSatisfies('1.0.0-rc.2', '>=1.0.0-rc.1 <1.0.0'), true)
  assert.equal(versionSatisfies('1.0.0-rc.2', '>=0.9.0 <1.0.0'), false)
  for (const invalid of ['^1.0.0', '~1.0.0', '1.0.0', '1.x', '>=1.0.0, <2.0.0', '>=1.0.0  <2.0.0']) {
    assertContractCode(() => parseVersionRange(invalid), 'version-invalid')
  }
  assertContractCode(() => parseVersionRange('=1.0.0-01'), 'version-invalid')
  assertSecretFreeError(
    () => parseSemver('invalid', `github_${'pat'}_synthetic_fixture`),
    'version-invalid',
    `github_${'pat'}_synthetic_fixture`,
  )
  assert.equal(
    parseVersionRange('>=1.0.0+two >=1.0.0+one').normalized,
    '>=1.0.0+one',
  )
})

test('contract and protocol error vocabularies are frozen and exhaustive', () => {
  assert.deepEqual(COMPOSITION_CONTRACT_ERROR_CODES, [
    'authority-over-grant',
    'canonical-number-invalid',
    'canonical-string-invalid',
    'canonical-value-invalid',
    'catalog-digest-mismatch',
    'compatibility-unsupported',
    'composition-conflict',
    'dependency-cycle',
    'deprecated-new-lock',
    'digest-domain-invalid',
    'digest-invalid',
    'duplicate-id',
    'duplicate-json-key',
    'input-not-validated',
    'invalid-request',
    'json-invalid',
    'missing-requirement',
    'policy-denied',
    'private-state-in-public-lock',
    'schema-invalid',
    'secret-shaped-value',
    'stale-prior-lock',
    'trigger-widening',
    'unknown-field',
    'unsupported-api-version',
    'unsupported-kind',
    'version-invalid',
  ])
  assert.deepEqual(COMPOSITION_PROTOCOL_FAILURE_CODES, {
    validate: [
      'invalid-request', 'unsupported-api-version', 'unsupported-kind',
      'schema-invalid', 'unknown-field', 'version-invalid', 'digest-invalid',
      'secret-shaped-value', 'compatibility-unsupported',
    ],
    resolve: [
      'invalid-request', 'input-not-validated', 'catalog-digest-mismatch',
      'version-range-unsatisfied', 'dependency-unsatisfied', 'dependency-cycle',
      'conflict', 'capability-overgrant', 'policy-denied', 'digest-invalid',
    ],
  })
  assert.deepEqual(COMPOSITION_VALIDATE_ERROR_MAP, {
    'authority-over-grant': 'schema-invalid',
    'canonical-number-invalid': 'schema-invalid',
    'canonical-string-invalid': 'schema-invalid',
    'canonical-value-invalid': 'schema-invalid',
    'catalog-digest-mismatch': 'invalid-request',
    'compatibility-unsupported': 'compatibility-unsupported',
    'composition-conflict': 'invalid-request',
    'dependency-cycle': 'schema-invalid',
    'deprecated-new-lock': 'invalid-request',
    'digest-domain-invalid': 'invalid-request',
    'digest-invalid': 'digest-invalid',
    'duplicate-id': 'schema-invalid',
    'duplicate-json-key': 'schema-invalid',
    'input-not-validated': 'invalid-request',
    'invalid-request': 'invalid-request',
    'json-invalid': 'schema-invalid',
    'missing-requirement': 'invalid-request',
    'policy-denied': 'invalid-request',
    'private-state-in-public-lock': 'schema-invalid',
    'schema-invalid': 'schema-invalid',
    'secret-shaped-value': 'secret-shaped-value',
    'stale-prior-lock': 'invalid-request',
    'trigger-widening': 'schema-invalid',
    'unknown-field': 'unknown-field',
    'unsupported-api-version': 'unsupported-api-version',
    'unsupported-kind': 'unsupported-kind',
    'version-invalid': 'version-invalid',
  })
  assert.deepEqual(COMPOSITION_RESOLVE_ERROR_MAP, {
    'authority-over-grant': 'capability-overgrant',
    'canonical-number-invalid': 'invalid-request',
    'canonical-string-invalid': 'invalid-request',
    'canonical-value-invalid': 'invalid-request',
    'catalog-digest-mismatch': 'catalog-digest-mismatch',
    'compatibility-unsupported': 'version-range-unsatisfied',
    'composition-conflict': 'conflict',
    'dependency-cycle': 'dependency-cycle',
    'deprecated-new-lock': 'invalid-request',
    'digest-domain-invalid': 'digest-invalid',
    'digest-invalid': 'digest-invalid',
    'duplicate-id': 'invalid-request',
    'duplicate-json-key': 'invalid-request',
    'input-not-validated': 'input-not-validated',
    'invalid-request': 'invalid-request',
    'json-invalid': 'invalid-request',
    'missing-requirement': 'dependency-unsatisfied',
    'policy-denied': 'policy-denied',
    'private-state-in-public-lock': 'invalid-request',
    'schema-invalid': 'invalid-request',
    'secret-shaped-value': 'invalid-request',
    'stale-prior-lock': 'invalid-request',
    'trigger-widening': 'invalid-request',
    'unknown-field': 'invalid-request',
    'unsupported-api-version': 'invalid-request',
    'unsupported-kind': 'invalid-request',
    'version-invalid': 'invalid-request',
  })
  assert.deepEqual(
    Object.keys(COMPOSITION_VALIDATE_ERROR_MAP).sort(),
    [...COMPOSITION_CONTRACT_ERROR_CODES].sort(),
  )
  for (const code of Object.values(COMPOSITION_VALIDATE_ERROR_MAP)) {
    assert.equal(COMPOSITION_PROTOCOL_FAILURE_CODES.validate.includes(code), true)
  }
  assert.deepEqual(
    Object.keys(COMPOSITION_RESOLVE_ERROR_MAP).sort(),
    [...COMPOSITION_CONTRACT_ERROR_CODES].sort(),
  )
  for (const code of Object.values(COMPOSITION_RESOLVE_ERROR_MAP)) {
    assert.equal(COMPOSITION_PROTOCOL_FAILURE_CODES.resolve.includes(code), true)
  }
  assert.equal(Object.isFrozen(COMPOSITION_CONTRACT_ERROR_CODES), true)
  assert.equal(Object.isFrozen(COMPOSITION_PROTOCOL_FAILURE_CODES), true)
  assert.equal(Object.isFrozen(COMPOSITION_PROTOCOL_FAILURE_CODES.validate), true)
  assert.equal(Object.isFrozen(COMPOSITION_PROTOCOL_FAILURE_CODES.resolve), true)
  assert.equal(Object.isFrozen(COMPOSITION_VALIDATE_ERROR_MAP), true)
  assert.equal(Object.isFrozen(COMPOSITION_RESOLVE_ERROR_MAP), true)
})

test('reader and writer negotiation refuses unsupported or deprecated new locks', () => {
  assert.equal(selectCompositionApiVersion({
    kind: 'BotProfile',
    readerApiVersions: ['runtime.sympoies.dev/v1'],
    writerApiVersions: ['runtime.sympoies.dev/v1'],
  }), 'runtime.sympoies.dev/v1')
  assertContractCode(
    () => selectCompositionApiVersion({
      kind: 'BotProfile',
      readerApiVersions: ['runtime.sympoies.dev/v2'],
      writerApiVersions: ['runtime.sympoies.dev/v1'],
    }),
    'compatibility-unsupported',
  )
  assertContractCode(
    () => selectCompositionApiVersion({
      kind: 'BotProfile',
      readerApiVersions: ['runtime.sympoies.dev/v1'],
      writerApiVersions: ['runtime.sympoies.dev/v1'],
      deprecatedApiVersions: ['runtime.sympoies.dev/v1'],
    }),
    'deprecated-new-lock',
  )
  assert.equal(selectCompositionApiVersion({
    kind: 'BotProfile',
    readerApiVersions: ['runtime.sympoies.dev/v1'],
    writerApiVersions: ['runtime.sympoies.dev/v2'],
    deprecatedApiVersions: ['runtime.sympoies.dev/v1'],
    priorLockApiVersion: 'runtime.sympoies.dev/v1',
  }), 'runtime.sympoies.dev/v1')
  assertContractCode(
    () => selectCompositionApiVersion({
      kind: 'BotProfile',
      readerApiVersions: ['runtime.sympoies.dev/v1'],
      writerApiVersions: ['runtime.sympoies.dev/v1'],
      priorLockApiVersion: 'runtime.sympoies.dev/v2',
    }),
    'compatibility-unsupported',
  )
})

test('strict descriptor validation rejects drift, unknown fields, mutable refs, and secrets', () => {
  const valid = plugin('github-review', '1.0.0', {
    requires: ['cap.github.read', 'cap.github.review.publish'],
    actions: [{
      id: 'github.review.publish',
      class: 'write',
      inputSchemaDigest: TWO_DIGEST,
      outputSchemaDigest: THREE_DIGEST,
      sideEffect: 'idempotent',
      idempotency: 'required',
      capability: 'cap.github.review.publish',
    }],
  })
  assert.equal(validatePluginDescriptor(valid), valid)

  const unknown = structuredClone(valid)
  unknown.debug = true
  assertContractCode(() => validatePluginDescriptor(unknown), 'unknown-field')

  const drift = structuredClone(valid)
  drift.metadata.version = '1.0.1'
  assertContractCode(() => validatePluginDescriptor(drift), 'digest-invalid')

  const absolute = structuredClone(valid)
  absolute.artifact.entrypoint = '/tmp/plugin.js'
  absolute.metadata.digest = computeDocumentDigest(absolute)
  assertContractCode(() => validatePluginDescriptor(absolute), 'schema-invalid')

  const secret = plugin('secret-default', '1.0.0', { defaults: { apiToken: 'ghp_fixture' } })
  assertContractCode(() => validatePluginDescriptor(secret), 'secret-shaped-value')
  const secretKey = plugin('secret-key-default', '1.0.0', { defaults: { apiToken: 'placeholder' } })
  assertContractCode(() => validatePluginDescriptor(secretKey), 'secret-shaped-value')
  const fineGrained = plugin('fine-grained-default', '1.0.0', {
    defaults: { mode: `github_${'pat'}_synthetic_fixture` },
  })
  assertContractCode(() => validatePluginDescriptor(fineGrained), 'secret-shaped-value')
  const tokenKey = plugin('token-key-default', '1.0.0', {
    defaults: { [`github_${'pat'}_synthetic_fixture`]: 'placeholder' },
  })
  assertSecretFreeError(
    () => validatePluginDescriptor(tokenKey),
    'secret-shaped-value',
    `github_${'pat'}_synthetic_fixture`,
  )
  const tokenUnknownField = structuredClone(valid)
  tokenUnknownField[`github_${'pat'}_synthetic_fixture`] = true
  assertSecretFreeError(
    () => validatePluginDescriptor(tokenUnknownField),
    'unknown-field',
    `github_${'pat'}_synthetic_fixture`,
  )
  assertSecretFreeError(
    () => parseCanonicalJsonText(`{"github_${'pat'}_synthetic_fixture":1,"github_${'pat'}_synthetic_fixture":2}`),
    'duplicate-json-key',
    `github_${'pat'}_synthetic_fixture`,
  )

  const secretAttestation = structuredClone(valid)
  secretAttestation.artifact.attestationIdentity = `https://example.test/${'github_pat'}_synthetic@refs/tags/v1.0.0`
  secretAttestation.metadata.digest = computeDocumentDigest(secretAttestation)
  assertContractCode(() => validatePluginDescriptor(secretAttestation), 'secret-shaped-value')

  for (const field of [
    'deploymentId', 'deployment_id', 'Deployment-ID',
    'repository', 'privateBindingDigest', 'private_binding_digest',
  ]) {
    const privateDefault = plugin(`private-${field.toLowerCase()}`, '1.0.0', {
      defaults: { [field]: 'synthetic' },
    })
    assertContractCode(
      () => validatePluginDescriptor(privateDefault),
      'private-state-in-public-lock',
    )
  }

  const nonNormalized = structuredClone(valid)
  nonNormalized.compatibility.dsh = '<0.2.0 >=0.1.1-rc.2'
  nonNormalized.metadata.digest = computeDocumentDigest(nonNormalized)
  assertContractCode(() => validatePluginDescriptor(nonNormalized), 'version-invalid')

  const tokenComparator = structuredClone(valid)
  tokenComparator.compatibility.dsh = `github_${'pat'}_synthetic_fixture`
  tokenComparator.metadata.digest = computeDocumentDigest(tokenComparator)
  assertSecretFreeError(
    () => validatePluginDescriptor(tokenComparator),
    'version-invalid',
    `github_${'pat'}_synthetic_fixture`,
  )
  const tokenNormalization = structuredClone(valid)
  tokenNormalization.compatibility.dsh = `<0.2.0 >=0.1.1+sk-${'syntheticfixture'}`
  tokenNormalization.metadata.digest = computeDocumentDigest(tokenNormalization)
  assertSecretFreeError(
    () => validatePluginDescriptor(tokenNormalization),
    'version-invalid',
    `sk-${'syntheticfixture'}`,
  )
})

test('profile validation keeps non-project workloads outside coding authority', () => {
  const valid = profile()
  assert.equal(validateBotProfile(valid), valid)

  const codingGrant = profile({ grants: ['coding.workspace.write'] })
  assertContractCode(() => validateBotProfile(codingGrant), 'authority-over-grant')

  const secretPurpose = profile()
  secretPurpose.metadata.purpose = `${'github_pat'}_synthetic_fixture`
  secretPurpose.metadata.digest = computeDocumentDigest(secretPurpose)
  assertContractCode(() => validateBotProfile(secretPurpose), 'secret-shaped-value')

  const widenedTrigger = structuredClone(valid)
  widenedTrigger.triggers[0].grants = ['cap.github.admin']
  widenedTrigger.metadata.digest = computeDocumentDigest(widenedTrigger)
  assertContractCode(() => validateBotProfile(widenedTrigger), 'unknown-field')

  const unbounded = structuredClone(valid)
  unbounded.execution.retry.maxAttempts = 0
  unbounded.metadata.digest = computeDocumentDigest(unbounded)
  assertContractCode(() => validateBotProfile(unbounded), 'schema-invalid')
})

test('resolver is deterministic, dependency ordered, and cannot widen profile authority', () => {
  const transport = plugin('github-transport', '1.1.0', {
    provides: ['cap.github.read'],
    requires: ['cap.github.read'],
  })
  const reviewer = plugin('github-review', '1.2.0', {
    provides: ['plugin.github-review'],
    requires: ['cap.github.read', 'cap.github.review.publish'],
    tools: ['github.review.tool'],
    skills: ['github.review.skill'],
    services: ['github.review.service'],
    dependencies: [{ id: 'github-transport', range: '>=1.0.0 <2.0.0', scope: 'required' }],
  })
  const selectedProfile = profile({
    plugins: [{ id: 'github-review', range: '>=1.0.0 <2.0.0' }],
  })
  const first = resolveComposition({
    profile: selectedProfile,
    plugins: [reviewer, transport],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  const second = resolveComposition({
    profile: selectedProfile,
    plugins: [transport, reviewer],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(first, second)
  assert.deepEqual(first.composition.plugins.map(item => item.id), [
    'github-transport',
    'github-review',
  ])
  assert.deepEqual(first.composition.authorityCeiling.capabilities, [
    'cap.github.read',
    'cap.github.review.publish',
  ])
  assert.equal(first.composition.authorityCeiling.capabilities.includes('plugin.github-review'), false)
  assert.equal(first.composition.authorityCeiling.capabilities.includes('github.review.tool'), false)
  assert.equal(first.composition.authorityCeiling.capabilities.includes('github.review.skill'), false)
  assert.equal(first.composition.authorityCeiling.capabilities.includes('github.review.service'), false)

  const actionOnly = plugin('action-only', '1.0.0', {
    actions: [{
      id: 'github.review.publish',
      class: 'write',
      inputSchemaDigest: TWO_DIGEST,
      outputSchemaDigest: THREE_DIGEST,
      sideEffect: 'idempotent',
      idempotency: 'required',
      capability: 'cap.github.review.publish',
    }],
  })
  const actionOnlyResolution = resolveComposition({
    profile: profile({
      plugins: [{ id: 'action-only', range: '=1.0.0' }],
      requiredHealth: ['action-only.ready'],
    }),
    plugins: [actionOnly],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(actionOnlyResolution.composition.authorityCeiling.capabilities, [
    'cap.github.review.publish',
  ])
  assert.equal(first.composition.lockReceiptDigest, undefined)
  assert.equal(first.receipt.resolvedCompositionDigest, first.composition.metadata.digest)
  assert.equal(
    first.receipt.inputDigests.catalogSnapshot,
    computeCatalogSnapshotDigest([reviewer, transport]),
  )
  assert.equal(Object.isFrozen(first.composition.plugins[0]), true)
  assert.equal(validateResolvedComposition(first.composition), first.composition)
  assert.equal(
    validateCompositionLockReceipt(first.receipt, first.composition),
    first.receipt,
  )

  assertContractCode(
    () => resolveCompositionContract({
      profile: selectedProfile,
      plugins: [reviewer, transport],
      runtime,
      publicPolicy,
      reason: 'initial',
      catalogSnapshotDigest: ONE_DIGEST,
    }),
    'catalog-digest-mismatch',
  )

  assertContractCode(
    () => resolveComposition({
      profile: profile({ grants: ['cap.github.read'] }),
      plugins: [reviewer, transport],
      runtime,
      publicPolicy,
      reason: 'initial',
    }),
    'authority-over-grant',
  )

  const restrictedPolicy = structuredClone(publicPolicy)
  restrictedPolicy.grants = ['cap.github.read']
  restrictedPolicy.digest = computePublicPolicyDigest(restrictedPolicy)
  assertContractCode(
    () => resolveComposition({
      profile: selectedProfile,
      plugins: [reviewer, transport],
      runtime,
      publicPolicy: restrictedPolicy,
      reason: 'initial',
    }),
    'authority-over-grant',
  )

  const driftedPolicy = structuredClone(publicPolicy)
  driftedPolicy.resourceClasses = ['shared', 'unbounded']
  assertContractCode(
    () => resolveComposition({
      profile: selectedProfile,
      plugins: [reviewer, transport],
      runtime,
      publicPolicy: driftedPolicy,
      reason: 'initial',
    }),
    'digest-invalid',
  )
})

test('resolver backtracks deterministically to the highest globally compatible versions', () => {
  const alpha = plugin('alpha', '1.0.0', {
    dependencies: [{ id: 'provider', range: '>=1.0.0 <3.0.0', scope: 'required' }],
  })
  const zeta = plugin('zeta', '1.0.0', {
    dependencies: [{ id: 'provider', range: '=1.0.0', scope: 'required' }],
  })
  const providerOne = plugin('provider', '1.0.0')
  const providerTwo = plugin('provider', '2.0.0')
  const overlapProfile = profile({
    plugins: [
      { id: 'alpha', range: '=1.0.0' },
      { id: 'zeta', range: '=1.0.0' },
    ],
    grants: [],
    requiredHealth: ['alpha.ready', 'zeta.ready'],
  })
  const overlap = resolveComposition({
    profile: overlapProfile,
    plugins: [providerTwo, zeta, providerOne, alpha],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(overlap.composition.plugins.map(item => [item.id, item.version]), [
    ['provider', '1.0.0'],
    ['alpha', '1.0.0'],
    ['zeta', '1.0.0'],
  ])
  assert.deepEqual(resolveComposition({
    profile: overlapProfile,
    plugins: [alpha, providerOne, zeta, providerTwo],
    runtime,
    publicPolicy,
    reason: 'initial',
  }), overlap)

  const appTwo = plugin('backtracking-app', '2.0.0', {
    dependencies: [{ id: 'missing-v2-provider', range: '=1.0.0', scope: 'required' }],
  })
  const appOne = plugin('backtracking-app', '1.0.0', {
    dependencies: [{ id: 'stable-provider', range: '=1.0.0', scope: 'required' }],
  })
  const stableProvider = plugin('stable-provider', '1.0.0')
  const fallback = resolveComposition({
    profile: profile({
      plugins: [{ id: 'backtracking-app', range: '>=1.0.0 <3.0.0' }],
      grants: [],
      requiredHealth: ['backtracking-app.ready'],
    }),
    plugins: [appOne, stableProvider, appTwo],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(fallback.composition.plugins.map(item => [item.id, item.version]), [
    ['stable-provider', '1.0.0'],
    ['backtracking-app', '1.0.0'],
  ])

  const incompatibleLatest = structuredClone(plugin('runtime-choice', '2.0.0'))
  incompatibleLatest.compatibility.platforms = ['darwin-arm64']
  incompatibleLatest.metadata.digest = computeDocumentDigest(incompatibleLatest)
  const compatibleOlder = plugin('runtime-choice', '1.0.0')
  const runtimeFallback = resolveComposition({
    profile: profile({
      plugins: [{ id: 'runtime-choice', range: '>=1.0.0 <3.0.0' }],
      grants: [],
      requiredHealth: ['runtime-choice.ready'],
    }),
    plugins: [incompatibleLatest, compatibleOlder],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(runtimeFallback.composition.plugins.map(item => [item.id, item.version]), [
    ['runtime-choice', '1.0.0'],
  ])

  const conflictLatest = plugin('choice-app', '2.0.0', { conflicts: ['choice-helper'] })
  const conflictOlder = plugin('choice-app', '1.0.0')
  const choiceHelper = plugin('choice-helper', '1.0.0')
  const conflictFallback = resolveComposition({
    profile: profile({
      plugins: [
        { id: 'choice-app', range: '>=1.0.0 <3.0.0' },
        { id: 'choice-helper', range: '=1.0.0' },
      ],
      grants: [],
      requiredHealth: ['choice-app.ready', 'choice-helper.ready'],
    }),
    plugins: [conflictLatest, choiceHelper, conflictOlder],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(conflictFallback.composition.plugins.map(item => [item.id, item.version]), [
    ['choice-app', '1.0.0'],
    ['choice-helper', '1.0.0'],
  ])

  const orderedLatest = plugin('ordered-choice', '2.0.0', {
    ordering: { before: ['ordered-helper'], after: [] },
  })
  const orderedOlder = plugin('ordered-choice', '1.0.0')
  const orderedHelper = plugin('ordered-helper', '1.0.0', {
    ordering: { before: ['ordered-choice'], after: [] },
  })
  const orderingFallback = resolveComposition({
    profile: profile({
      plugins: [
        { id: 'ordered-choice', range: '>=1.0.0 <3.0.0' },
        { id: 'ordered-helper', range: '=1.0.0' },
      ],
      grants: [],
      requiredHealth: ['ordered-choice.ready', 'ordered-helper.ready'],
    }),
    plugins: [orderedHelper, orderedOlder, orderedLatest],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(orderingFallback.composition.plugins.map(item => [item.id, item.version]), [
    ['ordered-helper', '1.0.0'],
    ['ordered-choice', '1.0.0'],
  ])
})

test('resolver prunes impossible catalogs and caps combinatorial search deterministically', () => {
  const rootIds = Array.from({ length: 8 }, (_, index) => `search-${String.fromCharCode(97 + index)}`)
  const missingCatalog = rootIds.flatMap((id, index) => Array.from({ length: 4 }, (_, version) => plugin(
    id,
    `${version + 1}.0.0`,
    index === rootIds.length - 1
      ? { dependencies: [{ id: 'absent-provider', range: '=1.0.0', scope: 'required' }] }
      : {},
  )))
  const selectedProfile = profile({
    plugins: rootIds.map(id => ({ id, range: '>=1.0.0 <5.0.0' })),
    grants: [],
    requiredHealth: rootIds.map(id => `${id}.ready`),
  })
  assertContractCode(
    () => resolveComposition({
      profile: selectedProfile,
      plugins: missingCatalog,
      runtime,
      publicPolicy,
      reason: 'initial',
    }),
    'missing-requirement',
  )

  const conflictingCatalog = rootIds.flatMap((id, index) => Array.from({ length: 4 }, (_, version) => plugin(
    id,
    `${version + 1}.0.0`,
    index === rootIds.length - 1 ? { conflicts: [rootIds[0]] } : {},
  )))
  assertContractCode(
    () => resolveComposition({
      profile: selectedProfile,
      plugins: conflictingCatalog,
      runtime,
      publicPolicy,
      reason: 'initial',
    }),
    'compatibility-unsupported',
  )
})

test('resolver accepts the maximum independent singleton catalog without quadratic exhaustion', () => {
  const ids = Array.from({ length: 1024 }, (_, index) => `linear-${String(index).padStart(4, '0')}`)
  const catalog = ids.map(id => plugin(id, '1.0.0'))
  const selectedProfile = profile({
    plugins: ids.map(id => ({ id, range: '=1.0.0' })),
    grants: [],
    requiredHealth: ids.map(id => `${id}.ready`),
  })
  const forward = resolveComposition({
    profile: selectedProfile,
    plugins: catalog,
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  const reverse = resolveComposition({
    profile: selectedProfile,
    plugins: [...catalog].reverse(),
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(reverse, forward)
  assert.equal(forward.composition.plugins.length, 1024)
})

test('resolver expands the maximum singleton dependency chain incrementally', () => {
  const ids = Array.from({ length: 1024 }, (_, index) => `chain-${String(index).padStart(4, '0')}`)
  const catalog = ids.map((id, index) => plugin(id, '1.0.0', index + 1 < ids.length
    ? { dependencies: [{ id: ids[index + 1], range: '=1.0.0', scope: 'required' }] }
    : {}))
  const selectedProfile = profile({
    plugins: [{ id: ids[0], range: '=1.0.0' }],
    grants: [],
    requiredHealth: ids.map(id => `${id}.ready`),
  })
  const forward = resolveComposition({
    profile: selectedProfile,
    plugins: catalog,
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  const reverse = resolveComposition({
    profile: selectedProfile,
    plugins: [...catalog].reverse(),
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(reverse, forward)
  assert.deepEqual(forward.composition.plugins.map(item => item.id), [...ids].reverse())
})

test('resolver rejects missing requirements, duplicates, conflicts, cycles, and stale prior locks', () => {
  const base = plugin('base', '1.0.0')
  const needsMissing = plugin('needs-missing', '1.0.0', {
    dependencies: [{ id: 'missing', range: '=1.0.0', scope: 'required' }],
  })
  const selected = profile({
    plugins: [{ id: 'needs-missing', range: '=1.0.0' }],
    grants: [],
    requiredHealth: ['needs-missing.ready'],
  })
  assertContractCode(
    () => resolveComposition({ profile: selected, plugins: [needsMissing], runtime, publicPolicy, reason: 'initial' }),
    'missing-requirement',
  )
  assertContractCode(
    () => resolveComposition({ profile: profile(), plugins: [base, base], runtime, publicPolicy, reason: 'initial' }),
    'duplicate-id',
  )

  const left = plugin('left', '1.0.0', {
    dependencies: [{ id: 'right', range: '=1.0.0', scope: 'required' }],
  })
  const right = plugin('right', '1.0.0', {
    dependencies: [{ id: 'left', range: '=1.0.0', scope: 'required' }],
  })
  assertContractCode(
    () => resolveComposition({
      profile: profile({ plugins: [{ id: 'left', range: '=1.0.0' }], grants: [], requiredHealth: ['left.ready'] }),
      plugins: [left, right], runtime, publicPolicy, reason: 'initial',
    }),
    'dependency-cycle',
  )

  const optionalConsumer = plugin('optional-consumer', '1.0.0', {
    dependencies: [{ id: 'optional-transport', range: '>=1.0.0 <2.0.0', scope: 'optional' }],
  })
  const withoutOptional = resolveComposition({
    profile: profile({
      plugins: [{ id: 'optional-consumer', range: '=1.0.0' }],
      grants: [],
      requiredHealth: ['optional-consumer.ready'],
    }),
    plugins: [optionalConsumer], runtime, publicPolicy, reason: 'initial',
  })
  assert.deepEqual(withoutOptional.composition.plugins.map(item => item.id), ['optional-consumer'])

  const optionalTransport = plugin('optional-transport', '1.5.0')
  const catalogPresentOptional = resolveComposition({
    profile: profile({
      plugins: [{ id: 'optional-consumer', range: '=1.0.0' }],
      grants: [],
      requiredHealth: ['optional-consumer.ready'],
    }),
    plugins: [optionalConsumer, optionalTransport], runtime, publicPolicy, reason: 'initial',
  })
  assert.deepEqual(
    catalogPresentOptional.composition.plugins.map(item => item.id),
    ['optional-consumer'],
  )
  assert.deepEqual(
    catalogPresentOptional.receipt.inputDigests.descriptors,
    [optionalConsumer.metadata.digest],
  )

  const incompatibleCatalogOptional = plugin('optional-transport', '2.0.0')
  const ignoredIncompatibleOptional = resolveComposition({
    profile: profile({
      plugins: [{ id: 'optional-consumer', range: '=1.0.0' }],
      grants: [],
      requiredHealth: ['optional-consumer.ready'],
    }),
    plugins: [optionalConsumer, incompatibleCatalogOptional],
    runtime,
    publicPolicy,
    reason: 'initial',
  })
  assert.deepEqual(
    ignoredIncompatibleOptional.composition.plugins.map(item => item.id),
    ['optional-consumer'],
  )

  const withOptional = resolveComposition({
    profile: profile({
      plugins: [
        { id: 'optional-consumer', range: '=1.0.0' },
        { id: 'optional-transport', range: '=1.5.0' },
      ],
      grants: [],
      requiredHealth: ['optional-consumer.ready', 'optional-transport.ready'],
    }),
    plugins: [optionalConsumer, optionalTransport], runtime, publicPolicy, reason: 'initial',
  })
  assert.deepEqual(withOptional.composition.plugins.map(item => item.id), [
    'optional-transport', 'optional-consumer',
  ])

  const incompatibleOptional = plugin('optional-transport', '2.0.0')
  assertContractCode(
    () => resolveComposition({
      profile: profile({
        plugins: [
          { id: 'optional-consumer', range: '=1.0.0' },
          { id: 'optional-transport', range: '=2.0.0' },
        ],
        grants: [],
        requiredHealth: ['optional-consumer.ready', 'optional-transport.ready'],
      }),
      plugins: [optionalConsumer, incompatibleOptional], runtime, publicPolicy, reason: 'initial',
    }),
    'compatibility-unsupported',
  )

  const conflict = plugin('github-review', '1.0.0', {
    requires: ['cap.github.read', 'cap.github.review.publish'],
    conflicts: ['github-transport'],
  })
  assertContractCode(
    () => resolveComposition({
      profile: profile({
        plugins: [
          { id: 'github-review', range: '=1.0.0' },
          { id: 'github-transport', range: '=1.0.0' },
        ],
        requiredHealth: ['github-review.ready', 'github-transport.ready'],
      }),
      plugins: [conflict, plugin('github-transport', '1.0.0')],
      runtime,
      publicPolicy,
      reason: 'initial',
    }),
    'composition-conflict',
  )

  const namespaceLeft = plugin('namespace-left', '1.0.0', {
    namespaceClaims: ['shared.state'],
  })
  const namespaceRight = plugin('namespace-right', '1.0.0', {
    namespaceClaims: ['shared.state'],
  })
  assertContractCode(
    () => resolveComposition({
      profile: profile({
        plugins: [
          { id: 'namespace-left', range: '=1.0.0' },
          { id: 'namespace-right', range: '=1.0.0' },
        ],
        grants: [],
        requiredHealth: ['namespace-left.ready', 'namespace-right.ready'],
      }),
      plugins: [namespaceLeft, namespaceRight], runtime, publicPolicy, reason: 'initial',
    }),
    'composition-conflict',
  )

  for (const cardinality of [{ min: 0, max: 2 }, { min: 1, max: 2 }, { min: 2, max: 2 }]) {
    const impossibleCardinality = plugin('many-required', '1.0.0', { cardinality })
    assertContractCode(
      () => validatePluginDescriptor(impossibleCardinality),
      'schema-invalid',
    )
  }

  const orderedFirst = plugin('ordered-first', '1.0.0', {
    ordering: { before: ['ordered-second'], after: [] },
  })
  const orderedSecond = plugin('ordered-second', '1.0.0')
  const orderedResolution = resolveComposition({
    profile: profile({
      plugins: [
        { id: 'ordered-second', range: '=1.0.0' },
        { id: 'ordered-first', range: '=1.0.0' },
      ],
      grants: [],
      requiredHealth: ['ordered-first.ready', 'ordered-second.ready'],
    }),
    plugins: [orderedSecond, orderedFirst], runtime, publicPolicy, reason: 'initial',
  })
  assert.deepEqual(orderedResolution.composition.plugins.map(item => item.id), [
    'ordered-first', 'ordered-second',
  ])

  const orderingCycle = plugin('ordered-second', '1.0.0', {
    ordering: { before: ['ordered-first'], after: [] },
  })
  assertContractCode(
    () => resolveComposition({
      profile: profile({
        plugins: [
          { id: 'ordered-first', range: '=1.0.0' },
          { id: 'ordered-second', range: '=1.0.0' },
        ],
        grants: [],
        requiredHealth: ['ordered-first.ready', 'ordered-second.ready'],
      }),
      plugins: [orderedFirst, orderingCycle], runtime, publicPolicy, reason: 'initial',
    }),
    'dependency-cycle',
  )

  const valid = plugin('github-review', '1.0.0', {
    requires: ['cap.github.read', 'cap.github.review.publish'],
  })
  const resolved = resolveComposition({ profile: profile(), plugins: [valid], runtime, publicPolicy, reason: 'initial' })
  assert.deepEqual(resolveComposition({
    profile: profile(), plugins: [valid], runtime, publicPolicy, reason: 'initial',
    expectedPriorLockDigest: resolved.receipt.digest,
    priorLock: resolved.receipt,
  }), resolved)
  assertContractCode(
    () => resolveComposition({
      profile: profile(), plugins: [valid], runtime, publicPolicy, reason: 'update',
      expectedPriorLockDigest: ONE_DIGEST,
      priorLock: resolved.receipt,
    }),
    'stale-prior-lock',
  )
})

test('public lock validation rejects private state and recursive receipt topology', () => {
  const descriptor = plugin('github-review', '1.0.0', {
    requires: ['cap.github.read', 'cap.github.review.publish'],
  })
  const resolved = resolveComposition({ profile: profile(), plugins: [descriptor], runtime, publicPolicy, reason: 'initial' })

  const privateState = structuredClone(resolved.composition)
  privateState.deploymentId = 'private-deployment'
  privateState.metadata.digest = computeDocumentDigest(privateState)
  assertContractCode(() => validateResolvedComposition(privateState), 'private-state-in-public-lock')

  const recursive = structuredClone(resolved.composition)
  recursive.lockReceiptDigest = resolved.receipt.digest
  recursive.metadata.digest = computeDocumentDigest(recursive)
  assertContractCode(() => validateResolvedComposition(recursive), 'schema-invalid')

  const wrongSibling = structuredClone(resolved.receipt)
  wrongSibling.resolvedCompositionDigest = ONE_DIGEST
  wrongSibling.digest = computeDocumentDigest(wrongSibling)
  assertContractCode(
    () => validateCompositionLockReceipt(wrongSibling, resolved.composition),
    'schema-invalid',
  )
})

test('strict manager protocol returns exhaustive validate and resolve unions', () => {
  const transport = plugin('github-transport', '1.1.0', {
    requires: ['cap.github.read'],
  })
  const reviewer = plugin('github-review', '1.2.0', {
    requires: ['cap.github.read', 'cap.github.review.publish'],
    dependencies: [{ id: 'github-transport', range: '>=1.0.0 <2.0.0', scope: 'required' }],
  })
  const selectedProfile = profile()
  const service = createCompositionService({
    validatorVersion: '1.0.0',
    resolverVersion: runtime.resolverVersion,
    resolvePublicPolicy: digestValue => digestValue === publicPolicy.digest ? publicPolicy : undefined,
  })
  const validateRequest = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ValidateCompositionRequest',
    requestId: 'validate-1',
    descriptors: [reviewer, transport],
    profile: selectedProfile,
    readerSchemas,
    runtime: protocolRuntime,
  }
  const validated = service.validate(validateRequest)
  assert.deepEqual(Object.keys(validated).sort(), [
    'apiVersion', 'compatibilityResult', 'descriptorDigests', 'kind', 'profileDigest',
    'requestId', 'validator', 'warningCodes',
  ])
  assert.equal(validated.kind, 'ValidateCompositionSucceeded')
  assert.equal(validated.compatibilityResult, 'compatible')
  assert.equal(Object.isFrozen(validated.validator), true)
  assert.equal(validateCompositionProtocolResult(validated), validated)
  const unknownWarning = structuredClone(validated)
  unknownWarning.warningCodes = ['future-warning']
  assertContractCode(
    () => validateCompositionProtocolResult(unknownWarning),
    'schema-invalid',
  )

  const resolveRequest = {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ResolveCompositionRequest',
    requestId: 'resolve-1',
    validatedDocumentDigests: {
      profile: selectedProfile.metadata.digest,
      descriptors: [reviewer.metadata.digest, transport.metadata.digest].sort(),
    },
    catalogSnapshotDigest: computeCatalogSnapshotDigest([transport, reviewer]),
    runtime: protocolRuntime,
    publicPolicyCeilingDigest: publicPolicy.digest,
  }
  const resolved = service.resolve(resolveRequest)
  assert.deepEqual(Object.keys(resolved).sort(), [
    'apiVersion', 'compositionLockReceipt', 'compositionLockReceiptDigest',
    'dependencyOrder', 'kind', 'publicEffectiveAuthorityDigest', 'requestId',
    'resolvedComposition', 'resolvedCompositionDigest', 'resolver',
  ])
  assert.equal(resolved.kind, 'ResolveCompositionSucceeded')
  assert.equal(resolved.resolvedCompositionDigest, resolved.resolvedComposition.metadata.digest)
  assert.equal(resolved.compositionLockReceiptDigest, resolved.compositionLockReceipt.digest)
  assert.deepEqual(resolved.dependencyOrder, ['github-transport', 'github-review'])
  assert.equal(validateCompositionProtocolResult(resolved), resolved)

  const unknownRequest = structuredClone(validateRequest)
  unknownRequest.debug = true
  const unknownFailure = service.validate(unknownRequest)
  assert.deepEqual(unknownFailure, {
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ValidateCompositionFailed',
    requestId: 'validate-1',
    code: 'unknown-field',
    retryable: false,
    observedState: null,
    identity: null,
    receiptDigest: null,
    details: {},
  })
  assert.equal(validateCompositionProtocolResult(unknownFailure), unknownFailure)

  const oversizedFailure = service.validate({
    ...validateRequest,
    requestId: 'validate-oversized',
    padding: '\u0000'.repeat(1_398_102),
  })
  assert.equal(oversizedFailure.kind, 'ValidateCompositionFailed')
  assert.equal(oversizedFailure.requestId, 'validate-oversized')
  assert.equal(oversizedFailure.code, 'schema-invalid')

  const secretRequestId = `github_${'pat'}_synthetic_fixture`
  const secretCorrelationFailure = service.validate({
    ...validateRequest,
    requestId: secretRequestId,
  })
  assert.equal(secretCorrelationFailure.kind, 'ValidateCompositionFailed')
  assert.equal(secretCorrelationFailure.code, 'secret-shaped-value')
  assert.equal(secretCorrelationFailure.requestId, null)
  assert.equal(JSON.stringify(secretCorrelationFailure).includes(secretRequestId), false)

  const secretResult = structuredClone(validated)
  secretResult.requestId = secretRequestId
  assertSecretFreeError(
    () => validateCompositionProtocolResult(secretResult),
    'secret-shaped-value',
    secretRequestId,
  )

  for (const [operation, request] of [
    ['validate', validateRequest],
    ['resolve', resolveRequest],
  ]) {
    let getterCalls = 0
    const accessorRequest = { ...request }
    Object.defineProperty(accessorRequest, 'requestId', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('requestId getter must not execute')
      },
    })
    const accessorFailure = service[operation](accessorRequest)
    assert.equal(accessorFailure.kind, operation === 'validate'
      ? 'ValidateCompositionFailed'
      : 'ResolveCompositionFailed')
    assert.equal(accessorFailure.requestId, null)
    assert.equal(getterCalls, 0)

    const inheritedPrototype = {}
    Object.defineProperty(inheritedPrototype, 'requestId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'inherited-request-id'
      },
    })
    const { requestId: _requestId, ...requestWithoutId } = request
    const inheritedRequest = Object.assign(Object.create(inheritedPrototype), requestWithoutId)
    const inheritedFailure = service[operation](inheritedRequest)
    assert.equal(inheritedFailure.kind, operation === 'validate'
      ? 'ValidateCompositionFailed'
      : 'ResolveCompositionFailed')
    assert.equal(inheritedFailure.requestId, null)
    assert.equal(getterCalls, 0)
  }

  const validateFailures = []
  const invalidRequest = structuredClone(validateRequest)
  invalidRequest.requestId = ''
  validateFailures.push([invalidRequest, 'invalid-request'])
  const unsupportedApi = structuredClone(validateRequest)
  unsupportedApi.apiVersion = 'runtime.sympoies.dev/v2'
  validateFailures.push([unsupportedApi, 'unsupported-api-version'])
  const unsupportedKind = structuredClone(validateRequest)
  unsupportedKind.kind = 'ValidatePluginsRequest'
  validateFailures.push([unsupportedKind, 'unsupported-kind'])
  const schemaInvalid = structuredClone(validateRequest)
  delete schemaInvalid.profile
  validateFailures.push([schemaInvalid, 'schema-invalid'])
  const versionInvalid = structuredClone(validateRequest)
  versionInvalid.profile.metadata.version = 'v1.0.0'
  validateFailures.push([versionInvalid, 'version-invalid'])
  const digestInvalid = structuredClone(validateRequest)
  digestInvalid.descriptors[0].metadata.digest = ONE_DIGEST
  validateFailures.push([digestInvalid, 'digest-invalid'])
  const secretShaped = structuredClone(validateRequest)
  secretShaped.profile.metadata.purpose = `${'github_pat'}_synthetic_fixture`
  secretShaped.profile.metadata.digest = computeDocumentDigest(secretShaped.profile)
  validateFailures.push([secretShaped, 'secret-shaped-value'])
  const incompatible = structuredClone(validateRequest)
  incompatible.descriptors[0].compatibility.platforms = ['darwin-arm64']
  incompatible.descriptors[0].metadata.digest = computeDocumentDigest(incompatible.descriptors[0])
  validateFailures.push([incompatible, 'compatibility-unsupported'])
  for (const [request, code] of validateFailures) {
    const failure = service.validate(request)
    assert.equal(failure.kind, 'ValidateCompositionFailed')
    assert.equal(failure.code, code)
    assert.equal(validateCompositionProtocolResult(failure), failure)
  }

  const coldService = createCompositionService({
    validatorVersion: '1.0.0',
    resolverVersion: '1.0.0',
    resolvePublicPolicy: () => publicPolicy,
  })
  const unvalidated = coldService.resolve(resolveRequest)
  assert.equal(unvalidated.kind, 'ResolveCompositionFailed')
  assert.equal(unvalidated.code, 'input-not-validated')
  assert.equal(validateCompositionProtocolResult(unvalidated), unvalidated)
  const secretResolveCorrelation = service.resolve({
    ...resolveRequest,
    requestId: secretRequestId,
  })
  assert.equal(secretResolveCorrelation.kind, 'ResolveCompositionFailed')
  assert.equal(secretResolveCorrelation.code, 'invalid-request')
  assert.equal(secretResolveCorrelation.requestId, null)
  assert.equal(JSON.stringify(secretResolveCorrelation).includes(secretRequestId), false)

  const deniedPolicy = service.resolve({
    ...resolveRequest,
    requestId: 'resolve-policy-denied',
    publicPolicyCeilingDigest: ONE_DIGEST,
  })
  assert.equal(deniedPolicy.kind, 'ResolveCompositionFailed')
  assert.equal(deniedPolicy.code, 'policy-denied')
  assert.equal(validateCompositionProtocolResult(deniedPolicy), deniedPolicy)

  for (const [field, replacement, code] of [
    ['resolvedCompositionDigest', ONE_DIGEST, 'digest-invalid'],
    ['compositionLockReceiptDigest', ONE_DIGEST, 'digest-invalid'],
    ['publicEffectiveAuthorityDigest', ONE_DIGEST, 'digest-invalid'],
    ['dependencyOrder', ['github-review', 'github-transport'], 'schema-invalid'],
    ['kind', 'ResolveCompositionSuccess', 'unsupported-kind'],
  ]) {
    const drifted = structuredClone(resolved)
    drifted[field] = replacement
    assertContractCode(() => validateCompositionProtocolResult(drifted), code)
  }

  for (const mutateReceipt of [
    receipt => { receipt.resolvedCompositionDigest = ONE_DIGEST },
    receipt => { receipt.inputDigests.profile = ONE_DIGEST },
    receipt => { receipt.inputDigests.descriptors = [ONE_DIGEST] },
    receipt => { receipt.inputDigests.publicPolicy = ONE_DIGEST },
    receipt => { receipt.reason = 'update' },
    receipt => { receipt.resolver.version = '1.0.1' },
  ]) {
    const drifted = structuredClone(resolved)
    mutateReceipt(drifted.compositionLockReceipt)
    drifted.compositionLockReceipt.digest = computeDocumentDigest(
      drifted.compositionLockReceipt,
    )
    drifted.compositionLockReceiptDigest = drifted.compositionLockReceipt.digest
    assertContractCode(
      () => validateCompositionProtocolResult(drifted),
      'schema-invalid',
    )
  }
  for (const field of [
    'resolvedComposition', 'resolvedCompositionDigest',
    'compositionLockReceipt', 'compositionLockReceiptDigest',
  ]) {
    const incomplete = structuredClone(resolved)
    delete incomplete[field]
    assertContractCode(
      () => validateCompositionProtocolResult(incomplete),
      'schema-invalid',
    )
  }
})

test('low-level resolver rejects an oversized catalog before reading an element', () => {
  const oversizedCatalog = new Array(1025)
  let accesses = 0
  Object.defineProperty(oversizedCatalog, 0, {
    enumerable: true,
    get() {
      accesses += 1
      throw new Error('oversized catalog elements must not be read')
    },
  })
  assertContractCode(
    () => resolveCompositionContract({
      profile: profile(),
      plugins: oversizedCatalog,
      runtime,
      publicPolicy,
      catalogSnapshotDigest: ONE_DIGEST,
      reason: 'initial',
    }),
    'schema-invalid',
  )
  assert.equal(accesses, 0)
})

test('manager resolve maps every internal resolution class to public codes', () => {
  function resolveFailure(descriptors, selectedProfile, options = {}) {
    const service = createCompositionService({
      validatorVersion: '1.0.0',
      resolverVersion: '1.0.0',
      resolvePublicPolicy: options.resolvePublicPolicy ?? (() => publicPolicy),
    })
    const validated = service.validate({
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: 'ValidateCompositionRequest',
      requestId: `validate-${options.id ?? 'case'}`,
      descriptors,
      profile: selectedProfile,
      readerSchemas,
      runtime: protocolRuntime,
    })
    assert.equal(validated.kind, 'ValidateCompositionSucceeded')
    const failed = service.resolve({
      apiVersion: 'runtime.sympoies.dev/v1',
      kind: 'ResolveCompositionRequest',
      requestId: `resolve-${options.id ?? 'case'}`,
      validatedDocumentDigests: {
        profile: selectedProfile.metadata.digest,
        descriptors: descriptors.map(item => item.metadata.digest).sort(),
      },
      catalogSnapshotDigest: options.catalogSnapshotDigest
        ?? computeCatalogSnapshotDigest(descriptors),
      runtime: protocolRuntime,
      publicPolicyCeilingDigest: options.publicPolicyCeilingDigest ?? publicPolicy.digest,
    })
    assert.equal(failed.kind, 'ResolveCompositionFailed')
    assert.equal(validateCompositionProtocolResult(failed), failed)
    return failed.code
  }

  const needsMissing = plugin('needs-missing', '1.0.0', {
    dependencies: [{ id: 'missing', range: '=1.0.0', scope: 'required' }],
  })
  assert.equal(resolveFailure([needsMissing], profile({
    plugins: [{ id: 'needs-missing', range: '=1.0.0' }],
    grants: [],
    requiredHealth: ['needs-missing.ready'],
  }), { id: 'missing' }), 'dependency-unsatisfied')

  const left = plugin('cycle-left', '1.0.0', {
    dependencies: [{ id: 'cycle-right', range: '=1.0.0', scope: 'required' }],
  })
  const right = plugin('cycle-right', '1.0.0', {
    dependencies: [{ id: 'cycle-left', range: '=1.0.0', scope: 'required' }],
  })
  assert.equal(resolveFailure([left, right], profile({
    plugins: [{ id: 'cycle-left', range: '=1.0.0' }],
    grants: [],
    requiredHealth: ['cycle-left.ready'],
  }), { id: 'cycle' }), 'dependency-cycle')

  const conflict = plugin('conflict-left', '1.0.0', { conflicts: ['conflict-right'] })
  const conflictTarget = plugin('conflict-right', '1.0.0')
  assert.equal(resolveFailure([conflict, conflictTarget], profile({
    plugins: [
      { id: 'conflict-left', range: '=1.0.0' },
      { id: 'conflict-right', range: '=1.0.0' },
    ],
    grants: [],
    requiredHealth: ['conflict-left.ready', 'conflict-right.ready'],
  }), { id: 'conflict' }), 'conflict')

  const overgrant = plugin('overgrant', '1.0.0', { requires: ['cap.denied'] })
  assert.equal(resolveFailure([overgrant], profile({
    plugins: [{ id: 'overgrant', range: '=1.0.0' }],
    grants: ['cap.denied'],
    requiredHealth: ['overgrant.ready'],
  }), { id: 'overgrant' }), 'capability-overgrant')

  const optionalConsumer = plugin('range-consumer', '1.0.0', {
    dependencies: [{ id: 'range-provider', range: '=1.0.0', scope: 'optional' }],
  })
  const optionalProvider = plugin('range-provider', '2.0.0')
  assert.equal(resolveFailure([optionalConsumer, optionalProvider], profile({
    plugins: [
      { id: 'range-consumer', range: '=1.0.0' },
      { id: 'range-provider', range: '=2.0.0' },
    ],
    grants: [],
    requiredHealth: ['range-consumer.ready', 'range-provider.ready'],
  }), { id: 'range' }), 'version-range-unsatisfied')

  const valid = plugin('valid-resolve', '1.0.0')
  const validProfile = profile({
    plugins: [{ id: 'valid-resolve', range: '=1.0.0' }],
    grants: [],
    requiredHealth: ['valid-resolve.ready'],
  })
  assert.equal(resolveFailure([valid], validProfile, {
    id: 'catalog',
    catalogSnapshotDigest: ONE_DIGEST,
  }), 'catalog-digest-mismatch')
  assert.equal(resolveFailure([valid], validProfile, {
    id: 'policy',
    publicPolicyCeilingDigest: ONE_DIGEST,
    resolvePublicPolicy: () => undefined,
  }), 'policy-denied')
  assert.equal(resolveFailure([valid], validProfile, {
    id: 'policy-shape',
    resolvePublicPolicy: () => ({ ...publicPolicy, unexpected: true }),
  }), 'policy-denied')
  assert.equal(resolveFailure([valid], validProfile, {
    id: 'digest',
    publicPolicyCeilingDigest: ONE_DIGEST,
  }), 'digest-invalid')
})
