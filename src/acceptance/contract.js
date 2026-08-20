// @ts-check

const SUMMARY_SCHEMA = 'dsh-runtime-kit.acceptance-summary.v2'
const CLI_SCHEMA = 'dsh-runtime-kit.acceptance-cli.v1'
const SCENARIO_SCHEMA = 'dsh-runtime-kit.acceptance-scenarios.v1'
const DELIVERY_SCHEMA = 'dsh-runtime-kit.acceptance-delivery.v1'
const DIAGNOSTIC_SCHEMA = 'dsh-runtime-kit.acceptance-diagnostic.v1'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const COMMIT_SHA = /^[0-9a-f]{40,64}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,127}$/u
const REPOSITORY = /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/iu
const ARCHIVE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u
const NILS_ARTIFACTS = Object.freeze([
  'agent-docs',
  'agent-hook',
  'forge-cli',
  'git-cli',
  'review-specialists',
  'semantic-commit',
])

const PRODUCERS = Object.freeze({
  operations: Object.freeze(['bootstrap', 'inspect']),
  'packed-runtime': Object.freeze([
    'edit',
    'validate',
    'review',
    'private-project-skill',
    'resume',
    'subagent',
    'finish-line',
    'failure-paths',
  ]),
})

const REQUIRED_SCENARIO_EVIDENCE = Object.freeze({
  operations: Object.freeze({
    inspect: Object.freeze([
      'coexistence:dsh-agent-runtime-kit-zero-dependency',
      'coexistence:codex-claude-wiring-untouched',
    ]),
  }),
  'packed-runtime': Object.freeze({
    'private-project-skill': Object.freeze([
      'coexistence:no-cross-loaded-hooks-skills-session-state',
      'coexistence:dsh-hook-docs-state-isolated',
    ]),
  }),
})

const RUNTIME_ISOLATION_SCHEMA = 'dsh-runtime-kit.runtime-isolation.v1'

/** @param {Record<string, any>} item @param {'operations'|'packed-runtime'} producer */
function scenarioIsolation(item, producer) {
  if (producer !== 'packed-runtime' || item.id !== 'private-project-skill') return undefined
  const isolation = record(item.isolation, 'packed-runtime isolation')
  if (isolation.schema_version !== RUNTIME_ISOLATION_SCHEMA
    || isolation.provider_skill_loaded !== false
    || isolation.provider_hook_loaded !== false
    || isolation.provider_session_state_loaded !== false
    || !sha256(isolation.provider_skill_fixture_sha256)
    || !sha256(isolation.provider_hook_fixture_sha256)
    || !sha256(isolation.provider_session_fixture_sha256)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'packed-runtime isolation evidence is invalid',
    )
  }
  return Object.freeze({
    schema_version: RUNTIME_ISOLATION_SCHEMA,
    provider_skill_loaded: false,
    provider_hook_loaded: false,
    provider_session_state_loaded: false,
    provider_skill_fixture_sha256: isolation.provider_skill_fixture_sha256,
    provider_hook_fixture_sha256: isolation.provider_hook_fixture_sha256,
    provider_session_fixture_sha256: isolation.provider_session_fixture_sha256,
  })
}

/** @param {'operations'|'packed-runtime'} producer @param {string} id */
function requiredScenarioEvidence(producer, id) {
  if (producer === 'operations' && id === 'inspect') {
    return REQUIRED_SCENARIO_EVIDENCE.operations.inspect
  }
  if (producer === 'packed-runtime' && id === 'private-project-skill') {
    return REQUIRED_SCENARIO_EVIDENCE['packed-runtime']['private-project-skill']
  }
  return []
}

const SCENARIO_ORDER = Object.freeze([
  'bootstrap',
  'inspect',
  'edit',
  'validate',
  'review',
  'private-project-skill',
  'semantic-commit',
  'pr-delivery',
  'resume',
  'subagent',
  'finish-line',
  'failure-paths',
])

export class AcceptanceError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AcceptanceError'
    this.code = code
    this.diagnostic = Object.freeze({
      schema_version: DIAGNOSTIC_SCHEMA,
      ok: false,
      code,
      message,
      ...details,
    })
  }
}

/** @param {unknown} output */
export function scenarioFailureDiagnostic(output) {
  if (typeof output !== 'string') return Object.freeze({})
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean).reverse()
  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const hasOperationExitStatus = Object.hasOwn(parsed, 'operation_exit_status')
    const expectedKeys = [
      'cause_code',
      'ok',
      'producer',
      'schema_version',
      'step',
      ...(hasOperationExitStatus ? ['operation_exit_status'] : []),
    ].sort().join('\0')
    if (Object.keys(parsed).sort().join('\0') !== expectedKeys
      || parsed.schema_version !== 'dsh-runtime-kit.acceptance-scenario-diagnostic.v1'
      || parsed.ok !== false
      || !['operations', 'packed-runtime'].includes(parsed.producer)
      || typeof parsed.step !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(parsed.step)
      || typeof parsed.cause_code !== 'string'
      || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(parsed.cause_code)
      || (hasOperationExitStatus
        && (!Number.isSafeInteger(parsed.operation_exit_status)
          || parsed.operation_exit_status < 1
          || parsed.operation_exit_status > 255))) continue
    return Object.freeze({
      scenario_producer: parsed.producer,
      scenario_step: parsed.step,
      scenario_cause_code: parsed.cause_code,
      ...(hasOperationExitStatus
        ? { scenario_operation_exit_status: parsed.operation_exit_status }
        : {}),
    })
  }
  return Object.freeze({})
}

/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      label + ' receipt is invalid',
    )
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value */
function sha256(value) {
  return typeof value === 'string' && SHA256.test(value)
}

/** @param {string} value */
function parsedVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u)
  if (match === null) return undefined
  const core = match.slice(1, 4).map(Number)
  if (core.some(item => !Number.isSafeInteger(item))) return undefined
  return { core, prerelease: match[4]?.split('.') }
}

/** @param {string} current @param {string} minimum */
function versionAtLeast(current, minimum) {
  const left = parsedVersion(current)
  const right = parsedVersion(minimum)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index]
  }
  if (left.prerelease === undefined) return true
  if (right.prerelease === undefined) return false
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === b) continue
    if (a === undefined) return false
    if (b === undefined) return true
    const aNumber = /^\d+$/u.test(a) ? Number(a) : undefined
    const bNumber = /^\d+$/u.test(b) ? Number(b) : undefined
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber
    if (aNumber !== undefined) return false
    if (bNumber !== undefined) return true
    return a > b
  }
  return true
}

/** @param {Record<string, any>} artifacts */
function exactArtifacts(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return false
  }
  const names = Object.keys(artifacts).sort()
  return names.join('\0') === NILS_ARTIFACTS.join('\0')
    && names.every(name => sha256(artifacts[name]?.sha256))
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameArtifacts(left, right) {
  return exactArtifacts(left)
    && exactArtifacts(right)
    && NILS_ARTIFACTS.every(name => left[name].sha256 === right[name].sha256)
}

/**
 * @param {unknown} input
 * @param {'operations'|'packed-runtime'} producer
 */
function scenariosFrom(input, producer) {
  const receipt = record(input, producer + ' scenarios')
  const expected = PRODUCERS[producer]
  if (receipt.schema_version !== SCENARIO_SCHEMA
    || receipt.ok !== true
    || receipt.producer !== producer
    || !Array.isArray(receipt.scenarios)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      producer + ' scenario receipt is invalid',
    )
  }
  const seen = new Set()
  const scenarios = receipt.scenarios.map(raw => {
    const item = record(raw, producer + ' scenario')
    const requiredEvidence = requiredScenarioEvidence(producer, item.id)
    if (!expected.includes(item.id)
      || seen.has(item.id)
      || !['passed', 'failed'].includes(item.status)
      || item.producer !== producer
      || !Array.isArray(item.evidence)
      || item.evidence.length === 0
      || item.evidence.some(value => typeof value !== 'string' || value.length === 0)
      || requiredEvidence.some(value => !item.evidence.includes(value))) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        producer + ' scenario evidence is invalid',
      )
    }
    seen.add(item.id)
    const isolation = scenarioIsolation(item, producer)
    return Object.freeze({
      id: item.id,
      status: item.status,
      producer,
      evidence: Object.freeze([...item.evidence]),
      ...isolation === undefined ? {} : { isolation },
    })
  })
  if (seen.size !== expected.length || expected.some(id => !seen.has(id))) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      producer + ' scenario set is incomplete',
    )
  }
  return scenarios
}

/** @param {Record<string, any>} actual @param {Record<string, any>} expected */
function dshAccepted(actual, expected) {
  return actual.schema_version === 'dsh-runtime-kit.dsh-source-report.v1'
    && actual.compatible === true
    && actual.channel === expected.channel
    && actual.revision === expected.revision
    && actual.version === expected.version
    && expected.repository === 'https://github.com/deepseek-ai/deepseek-harness'
    && expected.channel === 'pinned'
    && typeof expected.revision === 'string'
    && /^[0-9a-f]{40}$/u.test(expected.revision)
    && typeof expected.version === 'string'
    && EXACT_VERSION.test(expected.version)
}

/** @param {Record<string, any>} compatibility @param {Record<string, any>} nils */
function releaseAccepted(compatibility, nils) {
  return compatibility.schema_version === 'dsh-runtime-kit.nils-compatibility.v1'
    && compatibility.status === 'released'
    && typeof compatibility.validated_release === 'string'
    && compatibility.validated_release === nils.version
    && typeof compatibility.minimum_supported_release === 'string'
    && versionAtLeast(nils.version, compatibility.minimum_supported_release)
    && compatibility.release?.source_revision === nils.source_revision
    && nils.source_revision === 'v' + nils.version
    && compatibility.release?.source_commit === nils.source_commit
    && typeof nils.source_commit === 'string'
    && COMMIT_SHA.test(nils.source_commit)
    && typeof compatibility.release?.platform === 'string'
    && compatibility.release.platform.length > 0
    && compatibility.release?.archive?.name === nils.archive?.name
    && typeof nils.archive?.name === 'string'
    && ARCHIVE_NAME.test(nils.archive.name)
    && compatibility.release?.archive?.sha256 === nils.archive?.sha256
    && sha256(nils.archive?.sha256)
    && sameArtifacts(compatibility.release.artifacts, nils.artifacts)
}

/** @param {string} repository */
function repositorySlug(repository) {
  const match = repository.match(REPOSITORY)
  return match === null ? undefined : match[1] + '/' + match[2]
}

/** @param {Record<string, any>} delivery @param {string} runId @param {Record<string, any>} expected */
function deliveryBindingAccepted(delivery, runId, expected) {
  return delivery.schema_version === DELIVERY_SCHEMA
    && delivery.run_id === runId
    && delivery.repository === expected.repository
    && delivery.head_sha === expected.head_sha
    && delivery.package_sha256 === expected.package_sha256
    && RUN_ID.test(runId)
    && repositorySlug(expected.repository) !== undefined
    && COMMIT_SHA.test(expected.head_sha)
    && sha256(expected.package_sha256)
}

/** @param {Record<string, any>} delivery @param {string} runId @param {Record<string, any>} expected */
function semanticCommitAccepted(delivery, runId, expected) {
  if (!deliveryBindingAccepted(delivery, runId, expected)) return false
  const receipt = delivery.semantic_commit
  return receipt?.schema_version === 'cli.semantic-commit.commit.v1'
    && receipt.ok === true
    && receipt.operation === 'commit'
    && receipt.validate_only === false
    && receipt.dry_run === false
    && receipt.commit?.sha === expected.head_sha
    && typeof receipt.commit?.subject === 'string'
    && receipt.commit.subject.length > 0
}

/** @param {Record<string, any>} delivery @param {string} runId @param {Record<string, any>} expected */
function prDeliveryAccepted(delivery, runId, expected) {
  if (!deliveryBindingAccepted(delivery, runId, expected)) return false
  const receipt = delivery.pr_delivery
  const data = receipt?.data
  const steps = Array.isArray(data?.steps)
    ? /** @type {Array<Record<string, any>>} */ (data.steps)
    : []
  const middle = steps[2]?.step
  const expectedSteps = ['auth_status', 'repo_view', middle, 'wait_checks']
  const schemas = [
    'cli.forge-cli.auth.status.v1',
    'cli.forge-cli.repo.view.v1',
    middle === 'create' ? 'cli.forge-cli.pr.create.v1' : 'cli.forge-cli.pr.view.v1',
    'cli.forge-cli.pr.checks.v1',
  ]
  const slug = repositorySlug(expected.repository)
  const pr = data?.pr
  const readback = delivery.provider_readback
  const view = readback?.view
  const providerChecks = readback?.checks
  const slugMarker = 'Acceptance-Run: ' + runId
  const noMergeSha = !Object.hasOwn(pr ?? {}, 'merge_sha') || pr.merge_sha === null
  return receipt?.schema_version === 'cli.forge-cli.pr.deliver.v1'
    && receipt.ok === true
    && data?.provider === 'github'
    && ['create', 'adopt'].includes(middle)
    && steps.length === expectedSteps.length
    && steps.every((step, index) => step.step === expectedSteps[index]
      && step.ok === true
      && step.schema_version === schemas[index])
    && steps[1].payload?.owner + '/' + steps[1].payload?.name === slug
    && steps[2].payload?.head_sha === expected.head_sha
    && steps[3].payload?.state === 'success'
    && Number.isSafeInteger(steps[3].payload?.required_count)
    && steps[3].payload.required_count > 0
    && steps[3].payload?.success_count >= steps[3].payload.required_count
    && Array.isArray(steps[3].payload?.failed)
    && steps[3].payload.failed.length === 0
    && Array.isArray(steps[3].payload?.pending)
    && steps[3].payload.pending.length === 0
    && Number.isSafeInteger(pr?.number)
    && pr.number > 0
    && pr.merged === false
    && noMergeSha
    && pr.url === expected.repository + '/pull/' + pr.number
    && view?.schema_version === 'cli.forge-cli.pr.view.v1'
    && view.ok === true
    && view.data?.provider === 'github'
    && view.data?.number === pr.number
    && view.data?.url === pr.url
    && view.data?.state === 'open'
    && view.data?.head_sha === expected.head_sha
    && view.data?.head_repository === slug
    && view.data?.merge_commit_sha === null
    && typeof view.data?.body === 'string'
    && view.data.body.split(/\r?\n/u).includes(slugMarker)
    && providerChecks?.schema_version === 'cli.forge-cli.pr.checks.v1'
    && providerChecks.ok === true
    && providerChecks.data?.provider === 'github'
    && providerChecks.data?.state === 'success'
    && providerChecks.data?.required_count > 0
    && providerChecks.data?.success_count >= providerChecks.data.required_count
    && Array.isArray(providerChecks.data?.failed)
    && providerChecks.data.failed.length === 0
    && Array.isArray(providerChecks.data?.pending)
    && providerChecks.data.pending.length === 0
}

/**
 * @param {{
 *   runtime: unknown,
 *   operations: unknown,
 *   dsh: unknown,
 *   expected_dsh: unknown,
 *   compatibility: unknown,
 *   nils: unknown,
 *   package_sha256: string,
 *   environment: unknown,
 *   run_id: string,
 *   expected_delivery: unknown,
 *   delivery?: unknown,
 *   allow_source_nils?: boolean,
 * }} input
 */
export function buildAcceptanceSummary(input) {
  const runtimeScenarios = scenariosFrom(input.runtime, 'packed-runtime')
  const operationScenarios = scenariosFrom(input.operations, 'operations')
  const dsh = record(input.dsh, 'DSH identity')
  const expectedDsh = record(input.expected_dsh, 'expected DSH identity')
  const compatibility = record(input.compatibility, 'nils compatibility')
  const nils = record(input.nils, 'nils identity')
  const environment = record(input.environment, 'acceptance environment')
  const expectedDelivery = record(input.expected_delivery, 'expected delivery')

  if (!dshAccepted(dsh, expectedDsh)
    || typeof nils.version !== 'string'
    || !EXACT_VERSION.test(nils.version)
    || typeof nils.source_revision !== 'string'
    || nils.source_revision.length === 0
    || typeof nils.source_commit !== 'string'
    || !COMMIT_SHA.test(nils.source_commit)
    || typeof nils.archive?.name !== 'string'
    || !ARCHIVE_NAME.test(nils.archive.name)
    || !sha256(nils.archive?.sha256)
    || !exactArtifacts(nils.artifacts)
    || !sha256(input.package_sha256)
    || expectedDelivery.package_sha256 !== input.package_sha256
    || typeof environment.mode !== 'string'
    || typeof environment.isolated !== 'boolean'
    || typeof input.run_id !== 'string'
    || !RUN_ID.test(input.run_id)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'acceptance runtime evidence is invalid',
    )
  }

  const releaseReady = releaseAccepted(compatibility, nils)
  if (!releaseReady && input.allow_source_nils !== true) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
      'final acceptance requires exact validated nils release artifacts',
    )
  }

  let semantic
  let pr
  if (input.delivery === undefined) {
    semantic = Object.freeze({
      id: 'semantic-commit',
      status: 'pending-authorization',
      producer: 'live-delivery',
      evidence: Object.freeze([]),
    })
    pr = Object.freeze({
      id: 'pr-delivery',
      status: 'pending-authorization',
      producer: 'live-delivery',
      evidence: Object.freeze([]),
    })
  } else {
    const delivery = record(input.delivery, 'live delivery')
    const semanticPassed = semanticCommitAccepted(delivery, input.run_id, expectedDelivery)
    const prPassed = prDeliveryAccepted(delivery, input.run_id, expectedDelivery)
    semantic = Object.freeze({
      id: 'semantic-commit',
      status: semanticPassed ? 'passed' : 'failed',
      producer: 'live-delivery',
      evidence: Object.freeze(semanticPassed
        ? ['head:' + expectedDelivery.head_sha, 'run:' + input.run_id]
        : ['delivery-binding-invalid']),
    })
    pr = Object.freeze({
      id: 'pr-delivery',
      status: prPassed ? 'passed' : 'failed',
      producer: 'live-delivery',
      evidence: Object.freeze(prPassed
        ? ['head:' + expectedDelivery.head_sha, 'run:' + input.run_id]
        : ['delivery-binding-invalid']),
    })
  }

  const byId = new Map([
    ...operationScenarios,
    ...runtimeScenarios,
    semantic,
    pr,
  ].map(item => [item.id, item]))
  const scenarios = SCENARIO_ORDER.map(id => byId.get(id))
  if (scenarios.some(item => item === undefined) || byId.size !== SCENARIO_ORDER.length) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'acceptance scenario registry is incomplete',
    )
  }
  const frozenScenarios = /** @type {Array<Record<string, any>>} */ (scenarios)
  const counts = Object.freeze({
    passed: frozenScenarios.filter(item => item.status === 'passed').length,
    pending: frozenScenarios.filter(item => item.status === 'pending-authorization').length,
    failed: frozenScenarios.filter(item => item.status === 'failed').length,
  })
  const blockers = []
  if (!releaseReady) blockers.push('released-nils-artifacts')
  if (environment.isolated !== true) blockers.push('disposable-isolated-environment')
  if (counts.pending > 0) blockers.push('authorized-live-delivery')
  const status = counts.failed > 0
    ? 'failed'
    : releaseReady && environment.isolated === true && counts.pending === 0
      ? 'pass'
      : 'incomplete'

  return Object.freeze({
    schema_version: SUMMARY_SCHEMA,
    status,
    mode: releaseReady ? 'released' : 'source-rehearsal',
    run_id: input.run_id,
    execution_scope: 'functional-session',
    runtime_package: Object.freeze({ sha256: input.package_sha256 }),
    dsh: Object.freeze({
      repository: expectedDsh.repository,
      channel: dsh.channel,
      revision: dsh.revision,
      version: dsh.version,
    }),
    nils: Object.freeze({
      version: nils.version,
      source_revision: nils.source_revision,
      source_commit: nils.source_commit,
      archive: Object.freeze({
        name: nils.archive.name,
        sha256: nils.archive.sha256,
      }),
      compatibility_status: compatibility.status,
      validated_release: compatibility.validated_release ?? null,
      artifacts: Object.freeze({
        'agent-hook': Object.freeze({ sha256: nils.artifacts['agent-hook'].sha256 }),
        'agent-docs': Object.freeze({ sha256: nils.artifacts['agent-docs'].sha256 }),
        'forge-cli': Object.freeze({ sha256: nils.artifacts['forge-cli'].sha256 }),
        'git-cli': Object.freeze({ sha256: nils.artifacts['git-cli'].sha256 }),
        'review-specialists': Object.freeze({ sha256: nils.artifacts['review-specialists'].sha256 }),
        'semantic-commit': Object.freeze({ sha256: nils.artifacts['semantic-commit'].sha256 }),
      }),
    }),
    environment: Object.freeze({
      mode: environment.mode,
      isolated: environment.isolated,
    }),
    promotion_blockers: Object.freeze(blockers),
    counts,
    scenarios: Object.freeze(frozenScenarios),
  })
}

/** @param {Record<string, any>} summary */
export function buildAcceptanceCliResult(summary) {
  if (summary.schema_version !== SUMMARY_SCHEMA) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'acceptance summary schema is invalid',
    )
  }
  if (summary.status === 'failed') {
    return Object.freeze({
      exit_code: 1,
      envelope: Object.freeze({
        schema_version: CLI_SCHEMA,
        ok: false,
        error: Object.freeze({
          schema_version: DIAGNOSTIC_SCHEMA,
          code: 'DSH_RUNTIME_KIT_ACCEPTANCE_MATRIX_FAILED',
          summary,
        }),
      }),
    })
  }
  if (!['pass', 'incomplete'].includes(summary.status)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'acceptance summary status is invalid',
    )
  }
  return Object.freeze({
    exit_code: 0,
    envelope: Object.freeze({
      schema_version: CLI_SCHEMA,
      ok: true,
      data: summary,
    }),
  })
}
