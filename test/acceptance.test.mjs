import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  AcceptanceError,
  buildAcceptanceCliResult,
  buildAcceptanceSummary,
  resolveSourceCandidateAcceptance,
  scenarioFailureDiagnostic,
} from '../src/acceptance/contract.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)
const DSH_REVISION = '9'.repeat(40)
const HEAD = '1'.repeat(40)
const HOOK_SHA = 'a'.repeat(64)
const DOCS_SHA = 'b'.repeat(64)
const GIT_CLI_SHA = 'c'.repeat(64)
const REVIEW_SHA = 'd'.repeat(64)
const SEMANTIC_COMMIT_SHA = 'e'.repeat(64)
const FORGE_CLI_SHA = 'f'.repeat(64)
const PACKAGE_SHA = '9'.repeat(64)
const SOURCE_COMMIT = '7'.repeat(40)
const ARCHIVE_SHA = '8'.repeat(64)
const PROVIDER_SKILL_SHA = '4'.repeat(64)
const PROVIDER_HOOK_SHA = '5'.repeat(64)
const PROVIDER_SESSION_SHA = '6'.repeat(64)
const BASELINE_PACKAGE_SHA = '2'.repeat(64)
const BASELINE_SOURCE_COMMIT = '3'.repeat(40)
const BASELINE_NILS_ARTIFACTS = Object.freeze({
  'agent-hook': '0'.repeat(64),
  'agent-docs': '1'.repeat(64),
  'forge-cli': '2'.repeat(64),
  'git-cli': '3'.repeat(64),
  'review-specialists': '4'.repeat(64),
  'semantic-commit': '5'.repeat(64),
})
const WORKSPACE_SHA = 'sha256:' + '4'.repeat(64)
const PATCHED_BUILD_SHA = '5'.repeat(64)
const PRISTINE_BUILD_SHA = '6'.repeat(64)

const authoritativeLegIds = [
  'happy-completion',
  'post-admission-denial',
  'concurrent-mutation-denial',
  'active-contained-cancellation',
  'agent-disposal',
  'graceful-restart',
  'crash-recovery',
  'candidate-old-provider-mismatch',
  'candidate-upgrade',
  'baseline-rollback',
]

function zeroResources() {
  return {
    acceptance_operations: 0,
    finish_line_requests: 0,
    finish_line_reservations: 0,
    pending_correlations: 0,
  }
}

function authoritativeMatrix() {
  const common = id => ({
    id,
    process_instance_sha256: 'sha256:' + createHash('sha256').update(id).digest('hex'),
    workspace_sha256: WORKSPACE_SHA,
    resources_after: zeroResources(),
  })
  return {
    schema_version: 'dsh-runtime-kit.authoritative-acceptance-matrix.v1',
    dsh: { version: '0.1.0-rc.7', revision: DSH_REVISION },
    dsh_lifecycle: {
      apply: {
        action: 'apply',
        before: 'pristine',
        after: 'patched',
        changed: true,
        runtime_rebuilt: false,
      },
      patched_build: {
        sha256: PATCHED_BUILD_SHA,
        file_count: 123,
        byte_count: 4567,
      },
      reverse: {
        action: 'reverse',
        before: 'patched',
        after: 'pristine',
        changed: true,
        runtime_rebuilt: false,
      },
      pristine_build: {
        sha256: PRISTINE_BUILD_SHA,
        file_count: 123,
        byte_count: 4500,
      },
      unpatched_smoke: {
        process_instance_sha256: 'sha256:'
          + createHash('sha256').update('unpatched-smoke').digest('hex'),
        tool_outcome: 'succeeded',
        acceptance_mode: 'absent',
      },
      final_source_state: 'pristine',
    },
    candidate: {
      runtime_package_sha256: PACKAGE_SHA,
      nils_source_commit: SOURCE_COMMIT,
      nils_artifacts: {
        'agent-hook': HOOK_SHA,
        'agent-docs': DOCS_SHA,
        'forge-cli': FORGE_CLI_SHA,
        'git-cli': GIT_CLI_SHA,
        'review-specialists': REVIEW_SHA,
        'semantic-commit': SEMANTIC_COMMIT_SHA,
      },
    },
    baseline: {
      runtime_package_sha256: BASELINE_PACKAGE_SHA,
      nils_source_commit: BASELINE_SOURCE_COMMIT,
      nils_artifacts: { ...BASELINE_NILS_ARTIFACTS },
    },
    legs: [
      {
        ...common('happy-completion'),
        goal: {
          before: { phase: 'active', revision: 1, event_count: 1 },
          after_denial: { phase: 'active', revision: 1, event_count: 1 },
          after_completion: { phase: 'complete', revision: 2, event_count: 6 },
        },
        denial: { code: 'DSH_ACCEPTANCE_BLOCKED', aggregate: 'missing' },
        tool_outcomes: ['succeeded', 'succeeded'],
        body_executions: 2,
        verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('post-admission-denial'),
        listener_entries: 1,
        body_executions: 0,
        tool_outcome: 'denied',
        execution_order: ['acceptance-admitted', 'downstream-denied'],
        verdict: { action: 'block', aggregate: 'uncertain' },
        resumed_verdict: { action: 'block', aggregate: 'uncertain' },
        recovery_verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('concurrent-mutation-denial'),
        tool_results: [
          {
            call_id: 'authoritative-acceptance-first-mutation',
            outcome: 'succeeded',
          },
          {
            call_id: 'authoritative-acceptance-second-mutation',
            outcome: 'denied',
          },
        ],
        body_executions: 1,
        max_concurrent_bodies: 1,
        execution_order: ['first-body-start', 'second-denied', 'first-body-finish'],
        verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('active-contained-cancellation'),
        recovery_process_instance_sha256: 'sha256:'
          + createHash('sha256').update('active-cancellation-recovery').digest('hex'),
        body_entries: 1,
        abort_observations: 1,
        call_id: 'authoritative-acceptance-cancellable-validation',
        tool_result: {
          outcome: 'cancelled',
          error_class: 'finish-line-request-cancelled',
        },
        child_pid_observed: true,
        child_process_dead: true,
        heartbeat_stopped: true,
        execution_order: ['body-start', 'caller-abort', 'contained-terminal'],
        late_successes: 0,
        turn_stops: 1,
        verdict: { action: 'block', aggregate: 'infrastructure-blocked' },
        recovery_verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('agent-disposal'),
        listener_entries: 1,
        body_executions: 0,
        disposal: 'fulfilled',
        resumed_verdict: { action: 'block', aggregate: 'uncertain' },
      },
      {
        ...common('graceful-restart'),
        previous_process_instance_sha256: 'sha256:'
          + createHash('sha256').update('graceful-restart-before').digest('hex'),
        pre_restart_verdict: { action: 'allow', aggregate: 'satisfied' },
        post_restart_verdict: { action: 'allow', aggregate: 'satisfied' },
        post_restart_validation_executions: 0,
      },
      {
        ...common('crash-recovery'),
        previous_process_instance_sha256: 'sha256:'
          + createHash('sha256').update('crash-recovery-before').digest('hex'),
        crashed_session_sha256: 'sha256:'
          + createHash('sha256').update('crash-recovery-session-before').digest('hex'),
        recovery_session_sha256: 'sha256:'
          + createHash('sha256').update('crash-recovery-session-after').digest('hex'),
        crash_signal: 'SIGKILL',
        workspace_lease_recovery_delay_ms: 31_000,
        mutation_terminal_before_crash: true,
        pre_crash_verdict: { action: 'block', aggregate: 'missing' },
        post_crash_verdict: { action: 'block', aggregate: 'infrastructure-blocked' },
        recovery_verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('candidate-old-provider-mismatch'),
        boot_outcome: 'blocked-before-model',
        denial_code: 'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID',
        probe_loaded: true,
        model_calls: 0,
        session_starts: 0,
      },
      {
        ...common('candidate-upgrade'),
        installed_runtime_package_sha256: PACKAGE_SHA,
        nils_source_commit: SOURCE_COMMIT,
        baseline_seed_runtime_package_sha256: BASELINE_PACKAGE_SHA,
        baseline_seed_acceptance_mode: 'absent',
        baseline_seed_mutation_executions: 1,
        baseline_seed_legacy_stop: 'blocked',
        baseline_seed_steering_observed: true,
        baseline_seed_exact_validation_executions: 1,
        baseline_seed_checkout_clean: true,
        first_verdict: { action: 'block', aggregate: 'missing' },
        goal_unchanged: true,
        validation_executions: 1,
        tool_outcome: 'succeeded',
        verdict: { action: 'allow', aggregate: 'satisfied' },
      },
      {
        ...common('baseline-rollback'),
        rollback_session_sha256: 'sha256:'
          + createHash('sha256').update('baseline-rollback-session').digest('hex'),
        validation_session_sha256: 'sha256:'
          + createHash('sha256').update('baseline-rollback-validation-session').digest('hex'),
        installed_runtime_package_sha256: BASELINE_PACKAGE_SHA,
        nils_source_commit: BASELINE_SOURCE_COMMIT,
        tool_outcome: 'succeeded',
        acceptance_mode: 'absent',
        legacy_stop: 'blocked',
        legacy_steering_observed: true,
        mutation_body_executions: 1,
        exact_validation_executions: 1,
        rollback_checkout_clean: true,
      },
    ],
  }
}

function scenario(id, producer, evidence = [id + ':verified'], extra = {}) {
  return { id, status: 'passed', producer, evidence, ...extra }
}

function runtimeReceipt() {
  return {
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    ok: true,
    producer: 'packed-runtime',
    scenarios: [
      scenario('edit', 'packed-runtime'),
      scenario('automatic-prerequisite', 'packed-runtime', [
        'prerequisite:mutating-tool-body-gated',
        'prerequisite:code-mode-nested-dispatch-gated',
        'prerequisite:context-ferried-through-run-code',
      ]),
      scenario('validate', 'packed-runtime'),
      scenario('review', 'packed-runtime'),
      scenario('private-project-skill', 'packed-runtime', [
        'skills:private-project-precedence',
        'coexistence:no-cross-loaded-hooks-skills-session-state',
        'coexistence:dsh-hook-docs-state-isolated',
      ], {
        isolation: {
          schema_version: 'dsh-runtime-kit.runtime-isolation.v1',
          provider_skill_loaded: false,
          provider_hook_loaded: false,
          provider_session_state_loaded: false,
          provider_skill_fixture_sha256: PROVIDER_SKILL_SHA,
          provider_hook_fixture_sha256: PROVIDER_HOOK_SHA,
          provider_session_fixture_sha256: PROVIDER_SESSION_SHA,
        },
      }),
      scenario('resume', 'packed-runtime'),
      scenario('subagent', 'packed-runtime'),
      scenario('authoritative-acceptance', 'packed-runtime', [
        'acceptance:goal-completion-blocked-pre-mutation',
        'acceptance:exact-provider-verdict-satisfied',
        'acceptance:goal-completion-allowed-post-evidence',
      ], { matrix: authoritativeMatrix() }),
      scenario('finish-line', 'packed-runtime'),
      scenario('failure-paths', 'packed-runtime'),
    ],
  }
}

function operationsReceipt() {
  return {
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    ok: true,
    producer: 'operations',
    scenarios: [
      scenario('bootstrap', 'operations'),
      scenario('inspect', 'operations', [
        'doctor:healthy',
        'upstream:patch-state-unchanged',
        'coexistence:dsh-agent-runtime-kit-zero-dependency',
        'coexistence:codex-claude-wiring-untouched',
      ]),
    ],
  }
}

function dshIdentity() {
  return {
    schema_version: 'dsh-runtime-kit.dsh-source-report.v1',
    compatible: true,
    channel: 'pinned',
    revision: DSH_REVISION,
    version: '0.1.0-rc.7',
    patch: {
      schema_version: 'dsh-runtime-kit.dsh-patch-receipt.v1',
      patch_id: 'native-execution-boundaries-v2',
      version: '0.1.0-rc.7',
      revision: DSH_REVISION,
      action: 'check',
      before: 'patched',
      after: 'patched',
      changed: false,
      upstream_checkout_clean: false,
    },
  }
}

function expectedDsh() {
  return {
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    channel: 'pinned',
    revision: DSH_REVISION,
    version: '0.1.0-rc.7',
  }
}

function nilsIdentity(
  revision = 'v1.26.4-7-gec8b6021-dirty',
  version = '1.26.4',
) {
  return {
    version,
    source_revision: revision,
    source_commit: SOURCE_COMMIT,
    archive: {
      name: `nils-cli-v${version}-x86_64-unknown-linux-gnu.tar.gz`,
      sha256: ARCHIVE_SHA,
    },
    artifacts: {
      'agent-hook': { sha256: HOOK_SHA },
      'agent-docs': { sha256: DOCS_SHA },
      'git-cli': { sha256: GIT_CLI_SHA },
      'review-specialists': { sha256: REVIEW_SHA },
      'semantic-commit': { sha256: SEMANTIC_COMMIT_SHA },
      'forge-cli': { sha256: FORGE_CLI_SHA },
    },
  }
}

function pendingCompatibility() {
  const nils = nilsIdentity()
  return {
    schema_version: 'dsh-runtime-kit.nils-compatibility.v1',
    status: 'pending-release',
    minimum_supported_release: null,
    validated_release: null,
    release: null,
    candidate_validation: {
      feature: 'authoritative-finish-line-acceptance',
      status: 'reviewed-source-candidate',
      validation: 'exact-reviewed-source',
      source_commit: nils.source_commit,
      version: nils.version,
      platform: 'x86_64-unknown-linux-gnu',
      artifacts: nils.artifacts,
    },
  }
}

function releasedCompatibility(version = '1.26.4', minimum = '1.26.4') {
  return {
    schema_version: 'dsh-runtime-kit.nils-compatibility.v1',
    status: 'released',
    minimum_supported_release: minimum,
    validated_release: version,
    release: {
      source_revision: 'v' + version,
      source_commit: SOURCE_COMMIT,
      platform: 'linux-x64',
      archive: {
        name: `nils-cli-v${version}-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: ARCHIVE_SHA,
      },
      artifacts: {
        'agent-hook': { sha256: HOOK_SHA },
        'agent-docs': { sha256: DOCS_SHA },
        'git-cli': { sha256: GIT_CLI_SHA },
        'review-specialists': { sha256: REVIEW_SHA },
        'semantic-commit': { sha256: SEMANTIC_COMMIT_SHA },
        'forge-cli': { sha256: FORGE_CLI_SHA },
      },
    },
  }
}

function delivery(runId = 'acceptance-run-123') {
  return {
    schema_version: 'dsh-runtime-kit.acceptance-delivery.v1',
    run_id: runId,
    repository: 'https://github.com/sympoies/dsh-runtime-kit',
    head_sha: HEAD,
    package_sha256: PACKAGE_SHA,
    semantic_commit: {
      schema_version: 'cli.semantic-commit.commit.v1',
      ok: true,
      operation: 'commit',
      validate_only: false,
      dry_run: false,
      commit: { sha: HEAD, subject: 'feat: deliver runtime kit' },
    },
    pr_delivery: {
      schema_version: 'cli.forge-cli.pr.deliver.v1',
      ok: true,
      data: {
        provider: 'github',
        pr: {
          number: 7,
          url: 'https://github.com/sympoies/dsh-runtime-kit/pull/7',
          merged: false,
        },
        steps: [
          { step: 'auth_status', ok: true, schema_version: 'cli.forge-cli.auth.status.v1', payload: {} },
          { step: 'repo_view', ok: true, schema_version: 'cli.forge-cli.repo.view.v1', payload: { owner: 'sympoies', name: 'dsh-runtime-kit' } },
          { step: 'create', ok: true, schema_version: 'cli.forge-cli.pr.create.v1', payload: { head_sha: HEAD } },
          { step: 'wait_checks', ok: true, schema_version: 'cli.forge-cli.pr.checks.v1', payload: { state: 'success', required_count: 1, success_count: 1, failed: [], pending: [], checks: [] } },
        ],
      },
    },
    provider_readback: {
      view: {
        schema_version: 'cli.forge-cli.pr.view.v1',
        ok: true,
        data: {
          provider: 'github',
          number: 7,
          url: 'https://github.com/sympoies/dsh-runtime-kit/pull/7',
          state: 'open',
          head_sha: HEAD,
          head_repository: 'sympoies/dsh-runtime-kit',
          merge_commit_sha: null,
          body: 'Acceptance-Run: ' + runId,
        },
      },
      checks: {
        schema_version: 'cli.forge-cli.pr.checks.v1',
        ok: true,
        data: {
          provider: 'github',
          state: 'success',
          required_count: 1,
          success_count: 1,
          failed: [],
          pending: [],
          checks: [],
        },
      },
    },
  }
}

function baseInput() {
  return {
    runtime: runtimeReceipt(),
    operations: operationsReceipt(),
    dsh: dshIdentity(),
    expected_dsh: expectedDsh(),
    compatibility: pendingCompatibility(),
    nils: nilsIdentity(),
    package_sha256: PACKAGE_SHA,
    environment: { mode: 'local-source-rehearsal', isolated: false },
    run_id: 'acceptance-run-123',
    expected_delivery: {
      repository: 'https://github.com/sympoies/dsh-runtime-kit',
      head_sha: HEAD,
      package_sha256: PACKAGE_SHA,
    },
    allow_source_nils: true,
  }
}

test('source rehearsal keeps delivery pending and makes only a scoped functional claim', () => {
  const summary = buildAcceptanceSummary(baseInput())

  assert.equal(summary.schema_version, 'dsh-runtime-kit.acceptance-summary.v2')
  assert.equal(summary.status, 'incomplete')
  assert.equal(summary.mode, 'source-rehearsal')
  assert.deepEqual(summary.counts, { passed: 12, pending: 2, failed: 0 })
  assert.deepEqual(
    summary.scenarios.filter(item => item.status === 'pending-authorization').map(item => item.id),
    ['semantic-commit', 'pr-delivery'],
  )
  assert.equal(summary.execution_scope, 'functional-session')
  assert.equal('no_legacy_runtime_execution' in summary, false)
})

test('source rehearsal selects only the exact reviewed nils candidate', () => {
  const input = baseInput()
  assert.deepEqual(
    resolveSourceCandidateAcceptance(input.compatibility, input.nils),
    {
      feature: 'authoritative-finish-line-acceptance',
      source_commit: SOURCE_COMMIT,
      version: '1.26.4',
    },
  )

  for (const mutate of [
    candidate => { candidate.source_commit = '0'.repeat(40) },
    candidate => { candidate.artifacts['forge-cli'].sha256 = '0'.repeat(64) },
    candidate => { candidate.feature = '../untrusted' },
  ]) {
    const compatibility = structuredClone(input.compatibility)
    mutate(compatibility.candidate_validation)
    assert.throws(
      () => resolveSourceCandidateAcceptance(compatibility, input.nils),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
    )
  }
})

test('hosted acceptance rejects receipts that do not prove runtime coexistence isolation', () => {
  const input = baseInput()
  const inspect = input.operations.scenarios.find(item => item.id === 'inspect')
  const skills = input.runtime.scenarios.find(item => item.id === 'private-project-skill')
  inspect.evidence = ['doctor:healthy', 'upstream:clean']
  skills.evidence = ['skills:private-project-precedence']

  assert.throws(
    () => buildAcceptanceSummary(input),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('hosted acceptance rejects ambient provider hook, docs, or state fallback', () => {
  const input = baseInput()
  const skills = input.runtime.scenarios.find(item => item.id === 'private-project-skill')
  skills.evidence = skills.evidence.filter(
    item => item !== 'coexistence:dsh-hook-docs-state-isolated',
  )

  assert.throws(
    () => buildAcceptanceSummary(input),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('hosted acceptance binds structured provider isolation evidence', () => {
  const input = baseInput()
  const skills = input.runtime.scenarios.find(item => item.id === 'private-project-skill')
  skills.isolation.provider_skill_loaded = true

  assert.throws(
    () => buildAcceptanceSummary(input),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )

  skills.isolation.provider_skill_loaded = false
  skills.isolation.provider_session_fixture_sha256 = 'not-a-digest'
  assert.throws(
    () => buildAcceptanceSummary(input),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('automatic prerequisite acceptance requires every native gating marker', () => {
  const required = [
    'prerequisite:mutating-tool-body-gated',
    'prerequisite:code-mode-nested-dispatch-gated',
    'prerequisite:context-ferried-through-run-code',
  ]
  assert.doesNotThrow(() => buildAcceptanceSummary(baseInput()))
  for (const missing of required) {
    const input = baseInput()
    const automatic = input.runtime.scenarios.find(item => item.id === 'automatic-prerequisite')
    automatic.evidence = automatic.evidence.filter(value => value !== missing)
    assert.throws(
      () => buildAcceptanceSummary(input),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      missing,
    )
  }
})

test('authoritative acceptance requires both synchronous goal decisions and the exact verdict', () => {
  const required = [
    'acceptance:goal-completion-blocked-pre-mutation',
    'acceptance:exact-provider-verdict-satisfied',
    'acceptance:goal-completion-allowed-post-evidence',
  ]
  for (const missing of required) {
    const input = baseInput()
    const acceptance = input.runtime.scenarios.find(
      item => item.id === 'authoritative-acceptance',
    )
    acceptance.evidence = acceptance.evidence.filter(value => value !== missing)
    assert.throws(
      () => buildAcceptanceSummary(input),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      missing,
    )
  }
})

test('authoritative acceptance requires the exact real-process lifecycle matrix', () => {
  const input = baseInput()
  assert.doesNotThrow(() => buildAcceptanceSummary(input))
  const acceptance = input.runtime.scenarios.find(
    item => item.id === 'authoritative-acceptance',
  )
  assert.deepEqual(
    acceptance.matrix.legs.map(leg => leg.id),
    authoritativeLegIds,
  )

  for (const missing of authoritativeLegIds) {
    const candidate = baseInput()
    const scenario = candidate.runtime.scenarios.find(
      item => item.id === 'authoritative-acceptance',
    )
    scenario.matrix.legs = scenario.matrix.legs.filter(leg => leg.id !== missing)
    assert.throws(
      () => buildAcceptanceSummary(candidate),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      missing,
    )
  }
})

test('authoritative acceptance rejects fabricated matrix identities and observations', () => {
  const mutations = [
    matrix => { matrix.dsh.revision = 'f'.repeat(40) },
    matrix => { matrix.candidate.runtime_package_sha256 = 'f'.repeat(64) },
    matrix => { matrix.candidate.nils_source_commit = 'f'.repeat(40) },
    matrix => { matrix.baseline.nils_artifacts['agent-hook'] = 'invalid' },
    matrix => { matrix.dsh_lifecycle.reverse.after = 'patched' },
    matrix => { matrix.dsh_lifecycle.pristine_build.sha256 = PATCHED_BUILD_SHA },
    matrix => { matrix.dsh_lifecycle.unpatched_smoke.tool_outcome = 'failed' },
    matrix => { matrix.legs[0].goal.after_denial.revision = 2 },
    matrix => {
      matrix.legs[0].goal.after_completion.event_count = matrix.legs[0].goal.before.event_count
    },
    matrix => { matrix.legs[1].body_executions = 1 },
    matrix => { matrix.legs[1].verdict.aggregate = 'infrastructure-blocked' },
    matrix => { matrix.legs[2].max_concurrent_bodies = 2 },
    matrix => { matrix.legs[2].tool_results[1].call_id = 'fabricated-second-mutation' },
    matrix => { matrix.legs[3].verdict.aggregate = 'satisfied' },
    matrix => { matrix.legs[3].child_process_dead = false },
    matrix => { matrix.legs[4].resumed_verdict.aggregate = 'infrastructure-blocked' },
    matrix => { matrix.legs[5].post_restart_verdict.aggregate = 'active' },
    matrix => {
      matrix.legs[6].recovery_session_sha256 = matrix.legs[6].crashed_session_sha256
    },
    matrix => { matrix.legs[7].model_calls = 1 },
    matrix => { matrix.legs[7].probe_loaded = false },
    matrix => { matrix.legs[7].session_starts = 1 },
    matrix => { matrix.legs[8].installed_runtime_package_sha256 = 'f'.repeat(64) },
    matrix => { matrix.legs[9].acceptance_mode = 'present' },
    matrix => { matrix.legs[9].process_instance_sha256 = matrix.legs[8].process_instance_sha256 },
    matrix => { matrix.legs[0].resources_after.acceptance_operations = 1 },
  ]

  for (const mutate of mutations) {
    const input = baseInput()
    const acceptance = input.runtime.scenarios.find(
      item => item.id === 'authoritative-acceptance',
    )
    mutate(acceptance.matrix)
    assert.throws(
      () => buildAcceptanceSummary(input),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
    )
  }
})

test('only exact released artifacts plus one correlated no-merge delivery completes the matrix', () => {
  const input = baseInput()
  const summary = buildAcceptanceSummary({
    ...input,
    compatibility: releasedCompatibility(),
    nils: nilsIdentity('v1.26.4'),
    environment: { mode: 'disposable-ci', isolated: true },
    delivery: delivery(),
    allow_source_nils: false,
  })

  assert.equal(summary.status, 'pass')
  assert.equal(summary.mode, 'released')
  assert.deepEqual(summary.counts, { passed: 14, pending: 0, failed: 0 })
})

test('a newer exact release may retain an older supported minimum', () => {
  const input = baseInput()
  const summary = buildAcceptanceSummary({
    ...input,
    compatibility: releasedCompatibility('1.27.0', '1.26.4'),
    nils: nilsIdentity('v1.27.0', '1.27.0'),
    environment: { mode: 'disposable-ci', isolated: true },
    delivery: delivery(),
    allow_source_nils: false,
  })
  assert.equal(summary.status, 'pass')

  assert.throws(
    () => buildAcceptanceSummary({
      ...input,
      compatibility: releasedCompatibility('1.26.4', '1.27.0'),
      nils: nilsIdentity('v1.26.4'),
      allow_source_nils: false,
    }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
  )

  const prerelease = baseInput()
  assert.throws(
    () => buildAcceptanceSummary({
      ...prerelease,
      compatibility: releasedCompatibility('1.27.0-alpha', '1.27.0-alpha.1'),
      nils: nilsIdentity('v1.27.0-alpha', '1.27.0-alpha'),
      allow_source_nils: false,
    }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
  )
  assert.doesNotThrow(() => buildAcceptanceSummary({
    ...prerelease,
    compatibility: releasedCompatibility('1.27.0-alpha.1', '1.27.0-alpha'),
    nils: nilsIdentity('v1.27.0-alpha.1', '1.27.0-alpha.1'),
    allow_source_nils: false,
  }))
})

test('release gate rejects source or archive substitution for the nils bundle', () => {
  for (const [mutate, code] of [
    [nils => { nils.source_commit = '0'.repeat(40) }, 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID'],
    [nils => { nils.archive.name = 'substituted-bundle.tar.gz' }, 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED'],
    [nils => { nils.archive.sha256 = '0'.repeat(64) }, 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED'],
  ]) {
    const nils = nilsIdentity('v1.27.0', '1.27.0')
    mutate(nils)
    assert.throws(
      () => buildAcceptanceSummary({
        ...baseInput(),
        compatibility: releasedCompatibility('1.27.0'),
        nils,
        allow_source_nils: false,
      }),
      error => error instanceof AcceptanceError
        && error.code === code,
    )
  }
})

test('release gate rejects unknown revisions and version-only substitute binaries', () => {
  const input = baseInput()
  for (const [nils, code] of [
    [nilsIdentity('unknown'), 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED'],
    [nilsIdentity('v1.26.4-1-gdeadbeef'), 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED'],
    [{
      ...nilsIdentity('v1.26.4'),
      artifacts: {
        ...nilsIdentity().artifacts,
        'agent-hook': { sha256: 'c'.repeat(64) },
      },
    }, 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID'],
  ]) {
    assert.throws(
      () => buildAcceptanceSummary({
        ...input,
        compatibility: releasedCompatibility(),
        nils,
        allow_source_nils: false,
      }),
      error => error instanceof AcceptanceError
        && error.code === code,
    )
  }
})

test('DSH evidence binds pristine provenance to the reviewed downstream patch', () => {
  const input = baseInput()
  assert.throws(
    () => buildAcceptanceSummary({
      ...input,
      dsh: { ...input.dsh, revision: '8'.repeat(40) },
    }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
  assert.throws(
    () => buildAcceptanceSummary({ ...input, dsh: { ...input.dsh, patch: undefined } }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('delivery rejects replay, cross-repository URLs, mismatched heads, and partial chains', () => {
  const input = {
    ...baseInput(),
    compatibility: releasedCompatibility(),
    nils: nilsIdentity('v1.26.4'),
    environment: { mode: 'disposable-ci', isolated: true },
    allow_source_nils: false,
  }
  const complete = delivery()
  const cases = [
    delivery('previous-run'),
    { ...delivery(), repository: 'https://github.com/other/repo' },
    { ...delivery(), head_sha: '2'.repeat(40) },
    { ...delivery(), package_sha256: '8'.repeat(64) },
    {
      ...complete,
      pr_delivery: {
        ...complete.pr_delivery,
        data: { ...complete.pr_delivery.data, steps: complete.pr_delivery.data.steps.slice(0, 3) },
      },
    },
  ]
  for (const candidate of cases) {
    const summary = buildAcceptanceSummary({ ...input, delivery: candidate })
    assert.equal(summary.status, 'failed')
    assert.ok(summary.scenarios.some(item => item.status === 'failed'))
  }

  const otherPackage = '8'.repeat(64)
  assert.throws(
    () => buildAcceptanceSummary({
      ...input,
      expected_delivery: { ...input.expected_delivery, package_sha256: otherPackage },
      delivery: { ...delivery(), package_sha256: otherPackage },
    }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('scenario producers own exact stable IDs and nonempty evidence', () => {
  const input = baseInput()
  const duplicate = runtimeReceipt()
  duplicate.scenarios = [...duplicate.scenarios, scenario('edit', 'packed-runtime')]
  assert.throws(
    () => buildAcceptanceSummary({ ...input, runtime: duplicate }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )

  const missingEvidence = runtimeReceipt()
  missingEvidence.scenarios[0] = { ...missingEvidence.scenarios[0], evidence: [] }
  assert.throws(
    () => buildAcceptanceSummary({ ...input, runtime: missingEvidence }),
    error => error instanceof AcceptanceError
      && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
  )
})

test('failed matrices have a typed nonzero CLI result while incomplete rehearsal is explicit', () => {
  const incomplete = buildAcceptanceCliResult(buildAcceptanceSummary(baseInput()))
  assert.equal(incomplete.exit_code, 0)
  assert.equal(incomplete.envelope.ok, true)
  assert.equal(incomplete.envelope.data.status, 'incomplete')

  const runtime = runtimeReceipt()
  runtime.scenarios[0] = { ...runtime.scenarios[0], status: 'failed' }
  const failed = buildAcceptanceCliResult(buildAcceptanceSummary({ ...baseInput(), runtime }))
  assert.equal(failed.exit_code, 1)
  assert.equal(failed.envelope.ok, false)
  assert.equal(failed.envelope.error.code, 'DSH_RUNTIME_KIT_ACCEPTANCE_MATRIX_FAILED')
  assert.equal(failed.envelope.error.summary.status, 'failed')
})

test('scenario failure diagnostics expose only a bounded producer, step, and cause code', () => {
  const diagnostic = scenarioFailureDiagnostic([
    'untrusted progress with /tmp/private-path',
    JSON.stringify({
      schema_version: 'dsh-runtime-kit.acceptance-scenario-diagnostic.v1',
      ok: false,
      producer: 'operations',
      step: 'profile-setup',
      cause_code: 'ERR_ASSERTION',
      operation_exit_status: 1,
    }),
  ].join('\n'))
  assert.deepEqual(diagnostic, {
    scenario_producer: 'operations',
    scenario_step: 'profile-setup',
    scenario_cause_code: 'ERR_ASSERTION',
    scenario_operation_exit_status: 1,
  })
  assert.deepEqual(scenarioFailureDiagnostic(JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-scenario-diagnostic.v1',
    ok: false,
    producer: 'operations',
    step: '/tmp/private-path',
    cause_code: 'ERR_ASSERTION',
  })), {})
})

test('acceptance runner is packaged with its scenario programs and rejects old receipt injection flags', async () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.acceptance, 'node scripts/run-acceptance.mjs')
  assert.ok(manifest.files.includes('test/smoke.mjs'))
  assert.ok(manifest.files.includes('test/operations-smoke.mjs'))
  assert.ok(manifest.files.includes('test/authoritative-acceptance-smoke.mjs'))
  assert.ok(manifest.files.includes('test/fixtures/authoritative-acceptance-canary'))
  const runner = readFileSync(join(projectRoot, 'scripts', 'run-acceptance.mjs'), 'utf8')
  assert.match(runner, /'semantic-commit-bin'/u)
  assert.match(runner, /'forge-cli-bin'/u)
  assert.match(runner, /'nils-source-commit'/u)
  assert.match(runner, /'nils-archive-name'/u)
  assert.match(runner, /'nils-archive-sha256'/u)
  assert.match(runner, /'baseline-package-tarball'/u)
  assert.match(runner, /'baseline-package-sha256'/u)
  assert.match(runner, /'baseline-nils-bin-dir'/u)
  assert.match(runner, /'baseline-nils-source-commit'/u)
  assert.match(runner, /DSH_ACCEPTANCE_BASELINE_NILS_ARTIFACTS/u)
  assert.match(runner, /rollback_validation/u)
  assert.match(runner, /AUTHORITATIVE_SCENARIO_TIMEOUT_MS/u)
  assert.match(runner, /RuntimeMaxSec=' \+ Math\.ceil\(timeout \/ 1000\) \+ 's'/u)
  assert.match(runner, /KillMode=control-group/u)
  assert.match(runner, /verifyControlPlane/u)
  assert.match(runner, /CI: 'true'/u)
  assert.match(runner, /digestDshBuildClosure/u)
  assert.match(
    runner,
    /\[\s*'exec',\s*'vitest',\s*'run',\s*'packages\/goal\/goal\/tests\/goal\.spec\.ts',?\s*\]/u,
    'the patched DSH GoalService denial and no-provider cases must execute',
  )
  assert.match(runner, /patched DSH GoalService boundary tests/u)
  const controlPlane = runner.slice(
    runner.indexOf('async function verifyControlPlane()'),
    runner.indexOf("enterPhase('operations-scenario')"),
  )
  assert.match(controlPlane, /manageDshPatch/u)
  assert.match(controlPlane, /digestDshBuildClosure/u)
  assert.doesNotMatch(controlPlane, /inspectSelectedDshCheckout\(/u)
  assert.match(runner, /const operationsLeg = await prepareOperationsLeg/u)
  assert.match(runner, /operations acceptance dependency installation/u)
  assert.match(runner, /const runtimeProject = await prepareRuntimeLeg/u)
  assert.match(runner, /'test',\s*'authoritative-acceptance-smoke\.mjs'/u)
  assert.match(runner, /action: 'reverse'/u)
  assert.match(runner, /unpatched DSH host build/u)
  assert.match(runner, /unpatched DSH tools scenario/u)
  assert.match(runner, /resolveSourceCandidateAcceptance/u)
  assert.match(runner, /DSH_ACCEPTANCE_CANDIDATE_PACKAGE_TARBALL/u)
  assert.match(
    runner,
    /DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: sourceCandidate\.feature/u,
  )
  assert.match(runner, /'run-id'/u)
  assert.match(runner, /'package-tarball'/u)
  assert.match(runner, /packageSha256/u)
  assert.match(runner, /safe\.directory=/u)
  const authoritativeSmoke = readFileSync(
    join(projectRoot, 'test', 'authoritative-acceptance-smoke.mjs'),
    'utf8',
  )
  const unpatchedBranch = authoritativeSmoke.slice(
    authoritativeSmoke.indexOf('if (unpatchedOnly)'),
    authoritativeSmoke.indexOf('} else {', authoritativeSmoke.indexOf('if (unpatchedOnly)')),
  )
  assert.match(unpatchedBranch, /installUnpatchedProfile\(profile\)/u)
  assert.doesNotMatch(unpatchedBranch, /installProfile\(profile, candidatePackage/u)
  const canary = readFileSync(
    join(projectRoot, 'test', 'fixtures', 'authoritative-acceptance-canary', 'index.js'),
    'utf8',
  )
  assert.match(canary, /if \(phase === 'unpatched-smoke'\) return run\(undefined\)/u)
  const checkoutInspector = readFileSync(
    join(projectRoot, 'src', 'compat', 'git-checkout.js'),
    'utf8',
  )
  assert.match(checkoutInspector, /safe\.directory=/u)
  const operationsSmoke = readFileSync(join(projectRoot, 'test', 'operations-smoke.mjs'), 'utf8')
  assert.doesNotMatch(operationsSmoke, /function stageBundle/u)
  assert.doesNotMatch(operationsSmoke, /spawnSync\('pnpm', \['dsh'/u)
  assert.match(operationsSmoke, /apps', 'cli', 'lib', 'bin\.js/u)
  assert.match(operationsSmoke, /spawnSync\(process\.execPath, \[dshCli/u)
  assert.match(operationsSmoke, /DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1/u)
  assert.match(operationsSmoke, /DSH_OPERATIONS_/u)
  assert.match(operationsSmoke, /operations:full-package-setup-update-rollback-remove/u)
  assert.match(operationsSmoke, /compatibility', 'dsh\.json/u)
  assert.match(operationsSmoke, /assert\.equal\(doctor\.dsh\.version, pinnedDshVersion\)/u)
  assert.doesNotMatch(operationsSmoke, /assert\.match\(doctor\.dsh\.version/u)
  assert.match(operationsSmoke, /upstream:patch-state-unchanged/u)
  assert.doesNotMatch(operationsSmoke, /assert\.equal\(upstreamBefore, ''\)/u)
  const runtimeSmoke = readFileSync(join(projectRoot, 'test', 'smoke.mjs'), 'utf8')
  assert.doesNotMatch(
    runtimeSmoke,
    /DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: 'authoritative-finish-line-acceptance'/u,
  )
  assert.deepEqual(
    [...runtimeSmoke.matchAll(/(?:from\s+|import\s*\()\s*['"](\.\.\/[^'"]+)['"]/gu)]
      .map(match => match[1]),
    ['../src/compat/dsh-patch.js'],
    'the trusted runtime scenario controller may load only the reviewed patch-state inspector',
  )

  await assert.rejects(
    run(process.execPath, [
      join(projectRoot, 'scripts', 'run-acceptance.mjs'),
      '--semantic-commit-receipt', '/tmp/forged.json',
    ], { cwd: projectRoot, encoding: 'utf8' }),
    error => {
      const envelope = JSON.parse(error.stdout)
      return envelope.schema_version === 'dsh-runtime-kit.acceptance-cli.v1'
        && envelope.ok === false
        && envelope.error?.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID'
    },
  )

  await assert.rejects(
    run(process.execPath, [
      join(projectRoot, 'scripts', 'run-acceptance.mjs'),
      '--dsh-source-root', '/tmp',
      '--agent-hook-bin', '/bin/true',
      '--agent-docs-bin', '/bin/true',
      '--git-cli-bin', '/bin/true',
      '--review-specialists-bin', '/bin/true',
      '--semantic-commit-bin', '/bin/true',
      '--forge-cli-bin', '/bin/true',
      '--nils-source-commit', SOURCE_COMMIT,
      '--nils-archive-name', 'nils-cli-v1.27.0-x86_64-unknown-linux-gnu.tar.gz',
      '--nils-archive-sha256', ARCHIVE_SHA,
      '--pnpm-bin', '/bin/true',
      '--npm-bin', '/bin/true',
    ], { cwd: projectRoot, encoding: 'utf8' }),
    error => {
      const envelope = JSON.parse(error.stdout)
      return envelope.ok === false
        && envelope.error?.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_TRUST_REQUIRED'
    },
  )

  await assert.rejects(
    run(process.execPath, [
      join(projectRoot, 'scripts', 'run-acceptance.mjs'),
      '--dsh-source-root', '/tmp',
      '--agent-hook-bin', '/bin/true',
      '--agent-docs-bin', '/bin/true',
      '--git-cli-bin', '/bin/true',
      '--review-specialists-bin', '/bin/true',
      '--semantic-commit-bin', '/bin/true',
      '--forge-cli-bin', '/bin/true',
      '--nils-source-commit', SOURCE_COMMIT,
      '--nils-archive-name', 'nils-cli-v1.27.0-x86_64-unknown-linux-gnu.tar.gz',
      '--nils-archive-sha256', ARCHIVE_SHA,
      '--pnpm-bin', '/bin/true',
      '--npm-bin', '/bin/true',
      '--run-id', 'acceptance-external-123',
      '--package-tarball', '/tmp/dsh-runtime-kit.tgz',
      '--package-sha256', 'a'.repeat(64),
    ], { cwd: projectRoot, encoding: 'utf8' }),
    error => {
      const envelope = JSON.parse(error.stdout)
      return envelope.ok === false
        && envelope.error?.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_TRUST_REQUIRED'
    },
  )
})

test('acceptance runner reports a sanitized phase for unexpected workspace failures', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-diagnostic-'))
  const invalidTempRoot = join(fixtureRoot, 'not-a-directory')
  writeFileSync(invalidTempRoot, 'fixture\n')
  try {
    await assert.rejects(
      run(process.execPath, [
        join(projectRoot, 'scripts', 'run-acceptance.mjs'),
        '--dsh-source-root', '/tmp',
        '--agent-hook-bin', '/bin/true',
        '--agent-docs-bin', '/bin/true',
        '--git-cli-bin', '/bin/true',
        '--review-specialists-bin', '/bin/true',
        '--semantic-commit-bin', '/bin/true',
        '--forge-cli-bin', '/bin/true',
        '--nils-source-commit', SOURCE_COMMIT,
        '--nils-archive-name', 'nils-cli-v1.27.0-x86_64-unknown-linux-gnu.tar.gz',
        '--nils-archive-sha256', ARCHIVE_SHA,
        '--pnpm-bin', '/bin/true',
        '--npm-bin', '/bin/true',
        '--acknowledge-trusted-code',
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: invalidTempRoot },
      }),
      error => {
        const envelope = JSON.parse(error.stdout)
        return envelope.ok === false
          && envelope.error?.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_INTERNAL_FAILED'
          && envelope.error?.phase === 'workspace'
          && envelope.error?.cause_code === 'ENOTDIR'
          && !JSON.stringify(envelope).includes(fixtureRoot)
      },
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
