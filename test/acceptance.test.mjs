import assert from 'node:assert/strict'
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
      ]),
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
  for (const mutate of [
    nils => { nils.source_commit = '0'.repeat(40) },
    nils => { nils.archive.name = 'substituted-bundle.tar.gz' },
    nils => { nils.archive.sha256 = '0'.repeat(64) },
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
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
    )
  }
})

test('release gate rejects unknown revisions and version-only substitute binaries', () => {
  const input = baseInput()
  for (const nils of [
    nilsIdentity('unknown'),
    nilsIdentity('v1.26.4-1-gdeadbeef'),
    {
      ...nilsIdentity('v1.26.4'),
      artifacts: {
        ...nilsIdentity().artifacts,
        'agent-hook': { sha256: 'c'.repeat(64) },
      },
    },
  ]) {
    assert.throws(
      () => buildAcceptanceSummary({
        ...input,
        compatibility: releasedCompatibility(),
        nils,
        allow_source_nils: false,
      }),
      error => error instanceof AcceptanceError
        && error.code === 'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
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
  const runner = readFileSync(join(projectRoot, 'scripts', 'run-acceptance.mjs'), 'utf8')
  assert.match(runner, /'semantic-commit-bin'/u)
  assert.match(runner, /'forge-cli-bin'/u)
  assert.match(runner, /'nils-source-commit'/u)
  assert.match(runner, /'nils-archive-name'/u)
  assert.match(runner, /'nils-archive-sha256'/u)
  assert.match(runner, /KillMode=control-group/u)
  assert.match(runner, /verifyControlPlane/u)
  assert.match(runner, /digestDshBuildClosure/u)
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
  assert.match(runner, /resolveSourceCandidateAcceptance/u)
  assert.match(runner, /DSH_RUNTIME_KIT_SMOKE_ACCEPTANCE: '1'/u)
  assert.match(
    runner,
    /DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: sourceCandidate\.feature/u,
  )
  assert.match(runner, /'run-id'/u)
  assert.match(runner, /'package-tarball'/u)
  assert.match(runner, /packageSha256/u)
  assert.match(runner, /safe\.directory=/u)
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
