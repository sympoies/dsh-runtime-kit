import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  appendAcceptanceAttestation,
  loadAcceptanceScenarioPack,
  summarizeAcceptanceScenarioPack,
} from '../dist/src/acceptance/scenario-pack.js'
import { loadAcceptanceCatalog } from '../dist/src/acceptance/drive.js'

const ROOT = resolve(import.meta.dirname, '..')
const CATALOG = join(ROOT, 'compatibility', 'acceptance-scenarios.json')
const PACK = join(ROOT, 'compatibility', 'acceptance-scenario-pack.json')

function taskMetadata(scenarioId: string, phase: 'success' | 'deliberate-failure') {
  const catalog = loadAcceptanceCatalog(CATALOG)
  const scenario = catalog.scenarios.find(row => row.id === scenarioId)!
  const task = phase === 'success' ? scenario.task : scenario.deliberate_failure_task!
  return {
    task_sha256: createHash('sha256').update(task).digest('hex'),
    ...(phase === 'success' ? {} : { success_marker: scenario.deliberate_failure_success_marker }),
  }
}

function fixtureStage(
  stage: 'prepare' | 'induce' | 'recover' | 'cleanup',
  phase: 'success' | 'deliberate-failure',
  family: string,
  scenarioId: string,
) {
  return { receipt: {
    status: 'pass', stage, phase, family, scenario_id: scenarioId,
    evidence: [{ kind: 'fixture', reference: `${scenarioId}.${stage}.json`, sha256: 'f'.repeat(64) }],
  } }
}

function fixtureObserved(
  phase: 'success' | 'deliberate-failure',
  family: string,
  scenarioId: string,
) {
  return { fixture: {
    start: fixtureStage(phase === 'success' ? 'prepare' : 'induce', phase, family, scenarioId),
    ...(phase === 'success' ? {} : {
      recovery: fixtureStage('recover', phase, family, scenarioId),
      clean_retry: {
        status: 'pass', success_gate_passed: true,
        exit_code: 0, signal: null, success_marker_seen: true,
        stdout: { path: '/tmp/retry.stdout', sha256: '1'.repeat(64), bytes: 1 },
        stderr: { path: '/tmp/retry.stderr', sha256: '2'.repeat(64), bytes: 0 },
        missing_reminders: [], forbidden_outcomes_seen: [],
        session_transcripts: [], operation_receipts: [],
        policy_decisions: { source: 'unavailable', actions: [], rule_ids: [] },
        transcript_scan_error: null, evidence_capture_error: null,
        executable_identity_error: null,
      },
    }),
    cleanup: fixtureStage('cleanup', phase, family, scenarioId),
  } }
}

test('canonical scenario pack accounts for every #D row exactly once', () => {
  const catalog = loadAcceptanceCatalog(CATALOG)
  const pack = loadAcceptanceScenarioPack(PACK, catalog)
  const expected = catalog.scenarios
    .filter(row => row.owner.program_child === '#D')
    .map(row => row.id)
    .sort()
  const actual = pack.families.flatMap(family => family.scenario_ids).sort()

  assert.equal(pack.schema_version, 'dsh-runtime-kit.acceptance-scenario-pack.v2')
  assert.equal(pack.program_child, '#D')
  assert.equal(pack.profile_isolation, 'capability-family')
  assert.equal(expected.length, 33)
  assert.deepEqual(actual, expected)
  assert.equal(new Set(actual).size, 33)
  assert.equal(new Set(pack.families.map(family => family.feature_issue)).size, 12)
  for (const family of pack.families) {
    assert.match(family.id, /^[a-z0-9][a-z0-9-]+$/u)
    assert.ok(family.success_observation.length > 0)
    assert.ok(family.deliberate_failure.induction.length > 0)
    assert.ok(family.deliberate_failure.diagnosis_task.includes('dsh-runtime-kit diagnose'))
    assert.deepEqual(family.deliberate_failure.required_diagnosis_fields, [
      'code', 'component', 'evidence_reference', 'next_action', 'observable_state_check',
    ])
    assert.ok(family.deliberate_failure.recovery.length > 0)
    assert.ok(family.deliberate_failure.recovery_observation.length > 0)
    assert.equal(family.task_bindings.length, family.scenario_ids.length)
    for (const binding of family.task_bindings) {
      const scenario = catalog.scenarios.find(row => row.id === binding.scenario_id)!
      assert.equal(binding.success_task_sha256, createHash('sha256').update(scenario.task).digest('hex'))
      assert.equal(
        binding.deliberate_failure_task_sha256,
        createHash('sha256').update(scenario.deliberate_failure_task!).digest('hex'),
      )
      assert.equal(binding.deliberate_failure_success_marker, scenario.deliberate_failure_success_marker)
    }
  }
})

test('external harness attestation is append-only, portable, and phase-bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-pack-attestation-'))
  const output = join(root, 'results.jsonl')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  appendFileSync(output, `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-drive-result.v1',
    run_id: 'pack-success-1',
    scenario_id: 'automatic-prerequisite.non-git',
    status: 'pass',
    scenario_pack: {
      schema_version: 'dsh-runtime-kit.acceptance-scenario-pack.v2',
      phase: 'success',
      family: 'automatic-prerequisite',
      case_id: 'automatic-prerequisite.non-git.success',
      isolation_key: '0'.repeat(64),
      ...taskMetadata('automatic-prerequisite.non-git', 'success'),
    },
    observed: fixtureObserved('success', 'automatic-prerequisite', 'automatic-prerequisite.non-git'),
  })}\n`)
  const attestationPath = join(root, 'attestation.json')
  writeFileSync(attestationPath, `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-harness-attestation.v1',
    run_id: 'pack-success-1',
    scenario_id: 'automatic-prerequisite.non-git',
    phase: 'success',
    status: 'pass',
    observable_state: {
      kind: 'file-content',
      reference: 'prerequisite.txt',
      sha256: 'a'.repeat(64),
      summary: 'The independently read file contains the required marker.',
    },
  }, undefined, 2)}\n`)

  const appended = appendAcceptanceAttestation({ outputPath: output, attestationPath })
  assert.equal(appended.case_id, 'automatic-prerequisite.non-git.success')
  assert.equal(appended.status, 'pass')
  assert.throws(
    () => appendAcceptanceAttestation({ outputPath: output, attestationPath }),
    /already has an external-harness attestation/u,
  )
  const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 2)
  assert.equal(rows[1].schema_version, 'dsh-runtime-kit.acceptance-harness-attestation.v1')
  assert.equal(rows[1].case_id, 'automatic-prerequisite.non-git.success')
})

test('deliberate-failure attestation requires diagnosis and recovery evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-pack-failure-'))
  const output = join(root, 'results.jsonl')
  appendFileSync(output, `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-drive-result.v1',
    run_id: 'pack-failure-1',
    scenario_id: 'runtime-health.non-git',
    status: 'pass',
    scenario_pack: {
      schema_version: 'dsh-runtime-kit.acceptance-scenario-pack.v2',
      phase: 'deliberate-failure',
      family: 'runtime-health',
      case_id: 'runtime-health.non-git.deliberate-failure',
      isolation_key: '1'.repeat(64),
      ...taskMetadata('runtime-health.non-git', 'deliberate-failure'),
    },
    diagnostic_bundle: { name: 'runtime-health.non-git.diagnostic.json', sha256: '2'.repeat(64), bytes: 128 },
    session_outcome: {
      schema_version: 'dsh-runtime-kit.session-outcome.v1',
      status: 'failed',
      category: 'runtime-health',
      code: 'dsh-runtime-health-companion-identity-invalid',
      component: 'runtime-health',
      receipt: 'session.latest',
      next_action: 'Restore the authenticated companion and rerun doctor.',
    },
    observed: fixtureObserved('deliberate-failure', 'runtime-health', 'runtime-health.non-git'),
  })}\n`)
  const attestationPath = join(root, 'attestation.json')
  writeFileSync(attestationPath, `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-harness-attestation.v1',
    run_id: 'pack-failure-1',
    scenario_id: 'runtime-health.non-git',
    phase: 'deliberate-failure',
    status: 'pass',
    observable_state: {
      kind: 'diagnostic-bundle',
      reference: 'runtime-health.non-git.diagnostic.json',
      sha256: 'b'.repeat(64),
      summary: 'The failed companion remained inactive before recovery.',
    },
    diagnosis: {
      code: 'dsh-runtime-health-companion-identity-invalid',
      component: 'runtime-health',
      evidence_reference: 'runtime-health.non-git.diagnostic.json',
      next_action: 'Restore the authenticated companion and rerun doctor.',
      observable_state_check: 'Doctor is healthy and the clean retry passes.',
    },
    recovery: {
      status: 'pass',
      evidence_reference: 'runtime-health.non-git.recovery.json',
      summary: 'The repaired profile is healthy without residual mutation.',
    },
  }, undefined, 2)}\n`)

  const validAttestation = readFileSync(attestationPath, 'utf8')
  const mismatched = JSON.parse(validAttestation)
  mismatched.diagnosis.code = 'wrong-code'
  writeFileSync(attestationPath, `${JSON.stringify(mismatched, undefined, 2)}\n`)
  assert.throws(
    () => appendAcceptanceAttestation({ outputPath: output, attestationPath }),
    /diagnosis must match the result outcome/u,
  )
  const incompleteRows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  delete incompleteRows[0].observed.fixture.clean_retry.missing_reminders
  writeFileSync(output, `${incompleteRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(attestationPath, validAttestation)
  assert.throws(
    () => appendAcceptanceAttestation({ outputPath: output, attestationPath }),
    /complete fixture stage chain/u,
  )
  incompleteRows[0].observed = fixtureObserved(
    'deliberate-failure', 'runtime-health', 'runtime-health.non-git',
  )
  writeFileSync(output, `${incompleteRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(attestationPath, validAttestation)
  const appended = appendAcceptanceAttestation({ outputPath: output, attestationPath })
  assert.equal(appended.phase, 'deliberate-failure')
  assert.equal(appended.diagnosis.code, 'dsh-runtime-health-companion-identity-invalid')
  assert.equal(appended.recovery.status, 'pass')
})

test('pack summary requires distinct successful result and attestation pairs for all 66 cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-pack-summary-'))
  const output = join(root, 'results.jsonl')
  const catalog = loadAcceptanceCatalog(CATALOG)
  const pack = loadAcceptanceScenarioPack(PACK, catalog)
  for (const family of pack.families) {
    const isolationKey = createHash('sha256').update(family.id).digest('hex')
    for (const scenarioId of family.scenario_ids) {
      for (const phase of ['success', 'deliberate-failure'] as const) {
        const runId = `${scenarioId}-${phase}`
        const caseId = `${scenarioId}.${phase}`
        appendFileSync(output, `${JSON.stringify({
          schema_version: 'dsh-runtime-kit.acceptance-drive-result.v1',
          run_id: runId,
          scenario_id: scenarioId,
          status: 'pass',
          scenario_pack: {
            schema_version: pack.schema_version,
            phase,
            family: family.id,
            case_id: caseId,
            isolation_key: isolationKey,
            task_sha256: phase === 'success'
              ? family.task_bindings.find(row => row.scenario_id === scenarioId)!.success_task_sha256
              : family.task_bindings.find(row => row.scenario_id === scenarioId)!.deliberate_failure_task_sha256,
            ...(phase === 'success' ? {} : {
              success_marker: family.task_bindings.find(row => row.scenario_id === scenarioId)!
                .deliberate_failure_success_marker,
            }),
          },
          observed: fixtureObserved(phase, family.id, scenarioId),
          ...(phase === 'success' ? {} : {
            diagnostic_bundle: { name: `${scenarioId}.diagnostic.json`, sha256: 'd'.repeat(64), bytes: 128 },
            session_outcome: {
              schema_version: 'dsh-runtime-kit.session-outcome.v1',
              status: 'failed', category: 'induced-failure', code: 'induced-failure',
              component: 'fixture', receipt: 'session.latest',
              next_action: 'Apply the documented reversible recovery.',
            },
          }),
        })}\n`)
        appendFileSync(output, `${JSON.stringify({
          schema_version: 'dsh-runtime-kit.acceptance-harness-attestation.v1',
          run_id: runId,
          scenario_id: scenarioId,
          case_id: caseId,
          phase,
          status: 'pass',
          observable_state: {
            kind: 'fixture',
            reference: `${scenarioId}.${phase}.json`,
            sha256: 'c'.repeat(64),
            summary: 'Independent observable state matched the scenario contract.',
          },
          ...(phase === 'success' ? {} : {
            diagnosis: {
              code: 'induced-failure',
              component: 'fixture',
              evidence_reference: `${scenarioId}.diagnostic.json`,
              next_action: 'Apply the documented reversible recovery.',
              observable_state_check: 'The clean retry passes after recovery.',
            },
            recovery: {
              status: 'pass',
              evidence_reference: `${scenarioId}.recovery.json`,
              summary: 'Recovery left no residual state.',
            },
          }),
        })}\n`)
      }
    }
  }

  const summary = summarizeAcceptanceScenarioPack({ outputPath: output, pack })
  assert.equal(summary.schema_version, 'dsh-runtime-kit.acceptance-drive-pack-summary.v1')
  assert.equal(summary.status, 'pass')
  assert.deepEqual(summary.counts, {
    expected_cases: 66,
    result_pass: 66,
    attestation_pass: 66,
    missing_results: 0,
    missing_attestations: 0,
    invalid_pairs: 0,
    invalid_isolation_families: 0,
  })

  const validRows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const retryMutations: Array<[string, (retry: Record<string, unknown>) => void]> = [
    ['missing missing_reminders', retry => { delete retry.missing_reminders }],
    ['nonempty missing_reminders', retry => { retry.missing_reminders = ['missing'] }],
    ['missing forbidden_outcomes_seen', retry => { delete retry.forbidden_outcomes_seen }],
    ['nonempty forbidden_outcomes_seen', retry => { retry.forbidden_outcomes_seen = ['forbidden'] }],
    ['missing transcript_scan_error', retry => { delete retry.transcript_scan_error }],
    ['present transcript_scan_error', retry => { retry.transcript_scan_error = { code: 'invalid' } }],
    ['missing evidence_capture_error', retry => { delete retry.evidence_capture_error }],
    ['present evidence_capture_error', retry => { retry.evidence_capture_error = { code: 'invalid' } }],
    ['missing executable_identity_error', retry => { delete retry.executable_identity_error }],
    ['present executable_identity_error', retry => { retry.executable_identity_error = { code: 'invalid' } }],
    ['invalid transcript list', retry => { retry.session_transcripts = [null] }],
    ['invalid receipt list', retry => { retry.operation_receipts = [null] }],
    ['invalid policy decisions', retry => { retry.policy_decisions = null }],
    ['invalid stdout evidence', retry => { retry.stdout = null }],
    ['invalid stderr evidence', retry => { retry.stderr = null }],
  ]
  for (const [name, mutate] of retryMutations) {
    const invalidRows = structuredClone(validRows)
    const result = invalidRows.find(row => row.schema_version === 'dsh-runtime-kit.acceptance-drive-result.v1'
      && row.scenario_pack.phase === 'deliberate-failure')
    mutate(result.observed.fixture.clean_retry)
    const invalidOutput = join(root, `${name.replaceAll(' ', '-')}.jsonl`)
    writeFileSync(invalidOutput, `${invalidRows.map(row => JSON.stringify(row)).join('\n')}\n`)
    const invalid = summarizeAcceptanceScenarioPack({ outputPath: invalidOutput, pack })
    assert.equal(invalid.status, 'fail', name)
    assert.equal(invalid.counts.missing_results, 1, name)
  }

  for (const [name, mutate] of [
    ['wrong task digest', (packRow: Record<string, unknown>) => { packRow.task_sha256 = '0'.repeat(64) }],
    ['wrong recovery marker', (packRow: Record<string, unknown>) => {
      packRow.success_marker = 'DSH_ACCEPTANCE_RECOVERED:wrong'
    }],
  ] as Array<[string, (packRow: Record<string, unknown>) => void]>) {
    const invalidRows = structuredClone(validRows)
    const result = invalidRows.find(row => row.schema_version === 'dsh-runtime-kit.acceptance-drive-result.v1'
      && row.scenario_pack.phase === 'deliberate-failure')
    mutate(result.scenario_pack)
    const invalidOutput = join(root, `${name.replaceAll(' ', '-')}.jsonl`)
    writeFileSync(invalidOutput, `${invalidRows.map(row => JSON.stringify(row)).join('\n')}\n`)
    const invalid = summarizeAcceptanceScenarioPack({ outputPath: invalidOutput, pack })
    assert.equal(invalid.status, 'fail', name)
    assert.equal(invalid.counts.missing_results, 1, name)
  }

  const mismatchedRows = structuredClone(validRows)
  const firstAttestation = mismatchedRows.find(row => row.schema_version === 'dsh-runtime-kit.acceptance-harness-attestation.v1')
  firstAttestation.run_id = 'wrong-run'
  const mismatchOutput = join(root, 'mismatched.jsonl')
  writeFileSync(mismatchOutput, `${mismatchedRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const mismatch = summarizeAcceptanceScenarioPack({ outputPath: mismatchOutput, pack })
  assert.equal(mismatch.status, 'fail')
  assert.equal(mismatch.counts.invalid_pairs, 1)

  const sharedRows = structuredClone(validRows)
  for (const row of sharedRows) {
    if (row.schema_version === 'dsh-runtime-kit.acceptance-drive-result.v1') {
      row.scenario_pack.isolation_key = 'e'.repeat(64)
    }
  }
  const sharedOutput = join(root, 'shared-isolation.jsonl')
  writeFileSync(sharedOutput, `${sharedRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const shared = summarizeAcceptanceScenarioPack({ outputPath: sharedOutput, pack })
  assert.equal(shared.status, 'fail')
  assert.equal(shared.counts.invalid_isolation_families, 12)
})
