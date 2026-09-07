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
      clean_retry: { exit_code: 0, signal: null, success_marker_seen: true },
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

  assert.equal(pack.schema_version, 'dsh-runtime-kit.acceptance-scenario-pack.v1')
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
      schema_version: 'dsh-runtime-kit.acceptance-scenario-pack.v1',
      phase: 'success',
      family: 'automatic-prerequisite',
      case_id: 'automatic-prerequisite.non-git.success',
      isolation_key: '0'.repeat(64),
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
      schema_version: 'dsh-runtime-kit.acceptance-scenario-pack.v1',
      phase: 'deliberate-failure',
      family: 'runtime-health',
      case_id: 'runtime-health.non-git.deliberate-failure',
      isolation_key: '1'.repeat(64),
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
