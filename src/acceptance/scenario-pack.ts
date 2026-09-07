import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { packageAsset } from '../package-root.js'

export const ACCEPTANCE_SCENARIO_PACK_SCHEMA = 'dsh-runtime-kit.acceptance-scenario-pack.v1'
export const ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA = 'dsh-runtime-kit.acceptance-harness-attestation.v1'
export const ACCEPTANCE_DRIVE_PACK_SUMMARY_SCHEMA = 'dsh-runtime-kit.acceptance-drive-pack-summary.v1'

export type AcceptanceScenarioPackPhase = 'success' | 'deliberate-failure'

export type AcceptanceScenarioPackFamily = {
  id: string
  feature_issue: string
  scenario_ids: string[]
  success_observation: string
  deliberate_failure: {
    induction: string
    diagnosis_task: string
    required_diagnosis_fields: string[]
    recovery: string
    recovery_observation: string
  }
}

export type AcceptanceScenarioPack = {
  schema_version: typeof ACCEPTANCE_SCENARIO_PACK_SCHEMA
  program_child: '#D'
  profile_isolation: 'capability-family'
  families: AcceptanceScenarioPackFamily[]
}

type Catalog = {
  scenarios: Array<{
    id: string
    owner: { program_child: string, feature_issue: string }
  }>
}

type JsonRecord = Record<string, unknown>

export class ScenarioPackError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function exactKeys(value: JsonRecord, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function boundedString(value: unknown, label: string, maximum: number = 16_384) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new ScenarioPackError('invalid-scenario-pack', `${label} must be a non-empty bounded string`)
  }
  return value
}

function stringList(value: unknown, label: string, maximum: number = 128) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum
    || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1024 || item.includes('\0'))) {
    throw new ScenarioPackError('invalid-scenario-pack', `${label} must be a non-empty bounded string array`)
  }
  return [...value] as string[]
}

function regularFile(path: string, label: string, maximumBytes: number) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new ScenarioPackError('invalid-path', `${label} must be an absolute path`)
  }
  const canonical = resolve(path)
  const metadata = lstatSync(canonical)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new ScenarioPackError('invalid-path', `${label} must be an owned bounded regular file`)
  }
  return canonical
}

function ownedOutput(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new ScenarioPackError('invalid-path', 'output must be an absolute path')
  }
  const canonical = resolve(path)
  const parent = lstatSync(dirname(canonical))
  if (parent.isSymbolicLink() || !parent.isDirectory()
    || (typeof process.getuid === 'function' && parent.uid !== process.getuid())
    || (parent.mode & 0o077) !== 0) {
    throw new ScenarioPackError('unsafe-output', 'output parent must be an owner-only real directory')
  }
  if (existsSync(canonical)) {
    const metadata = lstatSync(canonical)
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new ScenarioPackError('unsafe-output', 'output must be an owned regular file')
    }
  }
  return canonical
}

function family(value: unknown, index: number): AcceptanceScenarioPackFamily {
  const row = record(value)
  if (row === undefined || !exactKeys(row, [
    'id', 'feature_issue', 'scenario_ids', 'success_observation', 'deliberate_failure',
  ])) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${index} has missing or unknown keys`)
  }
  const id = boundedString(row.id, `family ${index} id`, 96)
  if (!/^[a-z0-9][a-z0-9-]+$/u.test(id)) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${index} id is invalid`)
  }
  const featureIssue = boundedString(row.feature_issue, `family ${id} feature_issue`, 16)
  if (!/^#(?:55|56|57|58|59|60|61|62|63|64|65|79)$/u.test(featureIssue)) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${id} feature_issue is invalid`)
  }
  const scenarioIds = stringList(row.scenario_ids, `family ${id} scenario_ids`)
  if (new Set(scenarioIds).size !== scenarioIds.length
    || scenarioIds.some(item => !/^[a-z0-9][a-z0-9.-]{0,95}$/u.test(item))) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${id} scenario ids are invalid or duplicated`)
  }
  const failure = record(row.deliberate_failure)
  if (failure === undefined || !exactKeys(failure, [
    'induction', 'diagnosis_task', 'required_diagnosis_fields', 'recovery', 'recovery_observation',
  ])) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${id} deliberate_failure is invalid`)
  }
  const required = stringList(failure.required_diagnosis_fields, `family ${id} required diagnosis fields`)
  const expectedFields = [
    'code', 'component', 'evidence_reference', 'next_action', 'observable_state_check',
  ]
  if (required.join(',') !== expectedFields.join(',')) {
    throw new ScenarioPackError('invalid-scenario-pack', `family ${id} diagnosis fields are incomplete`)
  }
  return {
    id,
    feature_issue: featureIssue,
    scenario_ids: scenarioIds,
    success_observation: boundedString(row.success_observation, `family ${id} success observation`, 4096),
    deliberate_failure: {
      induction: boundedString(failure.induction, `family ${id} failure induction`, 4096),
      diagnosis_task: boundedString(failure.diagnosis_task, `family ${id} diagnosis task`, 4096),
      required_diagnosis_fields: required,
      recovery: boundedString(failure.recovery, `family ${id} recovery`, 4096),
      recovery_observation: boundedString(
        failure.recovery_observation,
        `family ${id} recovery observation`,
        4096,
      ),
    },
  }
}

export function loadAcceptanceScenarioPack(
  path: string = packageAsset('compatibility', 'acceptance-scenario-pack.json'),
  catalog?: Catalog,
): AcceptanceScenarioPack {
  const canonical = regularFile(path, 'acceptance scenario pack', 1024 * 1024)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(canonical, 'utf8'))
  } catch {
    throw new ScenarioPackError('invalid-scenario-pack', 'acceptance scenario pack is not valid JSON')
  }
  const root = record(value)
  if (root === undefined || !exactKeys(root, [
    'schema_version', 'program_child', 'profile_isolation', 'families',
  ]) || root.schema_version !== ACCEPTANCE_SCENARIO_PACK_SCHEMA
    || root.program_child !== '#D' || root.profile_isolation !== 'capability-family'
    || !Array.isArray(root.families) || root.families.length === 0 || root.families.length > 32) {
    throw new ScenarioPackError(
      'invalid-scenario-pack',
      `acceptance scenario pack must carry ${ACCEPTANCE_SCENARIO_PACK_SCHEMA}`,
    )
  }
  const families = root.families.map(family)
  if (new Set(families.map(item => item.id)).size !== families.length
    || new Set(families.map(item => item.feature_issue)).size !== families.length) {
    throw new ScenarioPackError('invalid-scenario-pack', 'family ids and feature owners must be unique')
  }
  const scenarioIds = families.flatMap(item => item.scenario_ids)
  if (new Set(scenarioIds).size !== scenarioIds.length) {
    throw new ScenarioPackError('invalid-scenario-pack', 'scenario ids must appear in exactly one family')
  }
  if (catalog !== undefined) {
    const expected = catalog.scenarios.filter(item => item.owner.program_child === '#D')
    const expectedIds = expected.map(item => item.id).sort()
    if (expectedIds.length !== 33 || expectedIds.join(',') !== [...scenarioIds].sort().join(',')) {
      throw new ScenarioPackError('scenario-pack-incomplete', 'scenario pack does not account for all 33 #D rows')
    }
    const byId = new Map(expected.map(item => [item.id, item]))
    for (const entry of families) {
      if (entry.scenario_ids.some(id => byId.get(id)?.owner.feature_issue !== entry.feature_issue)) {
        throw new ScenarioPackError('scenario-pack-owner-mismatch', `family ${entry.id} does not match catalog ownership`)
      }
    }
  }
  return {
    schema_version: ACCEPTANCE_SCENARIO_PACK_SCHEMA,
    program_child: '#D',
    profile_isolation: 'capability-family',
    families,
  }
}

export function scenarioPackCase(
  pack: AcceptanceScenarioPack,
  scenarioId: string,
  phase: AcceptanceScenarioPackPhase,
  isolationKey?: string,
) {
  const matching = pack.families.find(item => item.scenario_ids.includes(scenarioId))
  if (matching === undefined) {
    throw new ScenarioPackError('scenario-pack-unknown-scenario', `scenario pack has no row for ${scenarioId}`)
  }
  return {
    schema_version: pack.schema_version,
    phase,
    family: matching.id,
    case_id: `${scenarioId}.${phase}`,
    profile_isolation: pack.profile_isolation,
    ...(isolationKey === undefined ? {} : { isolation_key: isolationKey }),
    expected_observation: phase === 'success'
      ? matching.success_observation
      : matching.deliberate_failure.recovery_observation,
    ...(phase === 'success' ? {} : {
      induction: matching.deliberate_failure.induction,
      required_diagnosis_fields: matching.deliberate_failure.required_diagnosis_fields,
      recovery: matching.deliberate_failure.recovery,
    }),
  }
}

function readJsonLines(path: string) {
  const canonical = regularFile(path, 'acceptance output', 128 * 1024 * 1024)
  return readFileSync(canonical, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      throw new ScenarioPackError('invalid-acceptance-output', `acceptance output row ${index + 1} is invalid JSON`)
    }
  })
}

function portableReference(value: unknown, label: string) {
  const reference = boundedString(value, label, 1024)
  if (isAbsolute(reference) || reference.startsWith('~') || reference.includes('..')
    || /(?:^|[\\/])home[\\/]|[A-Za-z]:[\\/]/u.test(reference)) {
    throw new ScenarioPackError('non-portable-attestation', `${label} must be portable and relative`)
  }
  return reference
}

function observableState(value: unknown) {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['kind', 'reference', 'sha256', 'summary'])) {
    throw new ScenarioPackError('invalid-attestation', 'observable_state is invalid')
  }
  const sha256 = boundedString(row.sha256, 'observable_state sha256', 64)
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new ScenarioPackError('invalid-attestation', 'observable_state sha256 is invalid')
  }
  return {
    kind: boundedString(row.kind, 'observable_state kind', 96),
    reference: portableReference(row.reference, 'observable_state reference'),
    sha256,
    summary: boundedString(row.summary, 'observable_state summary', 4096),
  }
}

function diagnosis(value: unknown) {
  const row = record(value)
  if (row === undefined || !exactKeys(row, [
    'code', 'component', 'evidence_reference', 'next_action', 'observable_state_check',
  ])) {
    throw new ScenarioPackError('invalid-attestation', 'deliberate-failure diagnosis is incomplete')
  }
  return {
    code: boundedString(row.code, 'diagnosis code', 256),
    component: boundedString(row.component, 'diagnosis component', 256),
    evidence_reference: portableReference(row.evidence_reference, 'diagnosis evidence_reference'),
    next_action: boundedString(row.next_action, 'diagnosis next_action', 4096),
    observable_state_check: boundedString(row.observable_state_check, 'diagnosis observable_state_check', 4096),
  }
}

function recovery(value: unknown) {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['status', 'evidence_reference', 'summary'])
    || row.status !== 'pass') {
    throw new ScenarioPackError('invalid-attestation', 'deliberate-failure recovery must be a passing record')
  }
  return {
    status: 'pass' as const,
    evidence_reference: portableReference(row.evidence_reference, 'recovery evidence_reference'),
    summary: boundedString(row.summary, 'recovery summary', 4096),
  }
}

function fixtureReceiptMatches(
  value: unknown,
  expected: { stage: string, phase: AcceptanceScenarioPackPhase, family: string, scenarioId: string },
) {
  const wrapper = record(value)
  const receipt = record(wrapper?.receipt)
  const evidence = receipt?.evidence
  return receipt?.status === 'pass' && receipt.stage === expected.stage
    && receipt.phase === expected.phase && receipt.family === expected.family
    && receipt.scenario_id === expected.scenarioId && Array.isArray(evidence) && evidence.length > 0
    && evidence.every(item => {
      const row = record(item)
      return row !== undefined && typeof row.kind === 'string' && typeof row.reference === 'string'
        && !isAbsolute(row.reference) && !row.reference.startsWith('~') && !row.reference.includes('..')
        && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256)
    })
}

function fixtureChainMatches(result: JsonRecord, phase: AcceptanceScenarioPackPhase, family: string, scenarioId: string) {
  const fixture = record(record(result.observed)?.fixture)
  if (!fixtureReceiptMatches(fixture?.start, {
    stage: phase === 'success' ? 'prepare' : 'induce', phase, family, scenarioId,
  }) || !fixtureReceiptMatches(fixture?.cleanup, { stage: 'cleanup', phase, family, scenarioId })) return false
  if (phase === 'success') return fixture?.recovery === undefined && fixture?.clean_retry === undefined
  const retry = record(fixture?.clean_retry)
  return fixtureReceiptMatches(fixture?.recovery, { stage: 'recover', phase, family, scenarioId })
    && retry?.exit_code === 0 && retry.signal === null && retry.success_marker_seen === true
}

export function appendAcceptanceAttestation(input: { outputPath: string, attestationPath: string }) {
  const outputPath = ownedOutput(input.outputPath)
  if (!existsSync(outputPath)) {
    throw new ScenarioPackError('invalid-acceptance-output', 'acceptance output does not exist')
  }
  const rows = readJsonLines(outputPath)
  const attestationPath = regularFile(input.attestationPath, 'attestation input', 64 * 1024)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(attestationPath, 'utf8'))
  } catch {
    throw new ScenarioPackError('invalid-attestation', 'attestation input is not valid JSON')
  }
  const row = record(raw)
  const baseKeys = ['schema_version', 'run_id', 'scenario_id', 'phase', 'status', 'observable_state']
  if (row === undefined || (row.phase !== 'success' && row.phase !== 'deliberate-failure')
    || !exactKeys(row, row.phase === 'success' ? baseKeys : [...baseKeys, 'diagnosis', 'recovery'])
    || row.schema_version !== ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA || row.status !== 'pass') {
    throw new ScenarioPackError('invalid-attestation', `attestation must carry ${ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA}`)
  }
  const runId = boundedString(row.run_id, 'attestation run_id', 96)
  const scenarioId = boundedString(row.scenario_id, 'attestation scenario_id', 96)
  const phase = row.phase as AcceptanceScenarioPackPhase
  const caseId = `${scenarioId}.${phase}`
  const result = rows.map(record).find(item => item?.schema_version === 'dsh-runtime-kit.acceptance-drive-result.v1'
    && item.run_id === runId && item.scenario_id === scenarioId
    && record(item.scenario_pack)?.phase === phase && record(item.scenario_pack)?.case_id === caseId)
  if (result === undefined || result.status !== 'pass') {
    throw new ScenarioPackError('attestation-result-mismatch', 'attestation requires one matching passing result row')
  }
  const resultPack = record(result.scenario_pack)
  if (!fixtureChainMatches(result, phase, String(resultPack?.family), scenarioId)) {
    throw new ScenarioPackError('attestation-fixture-mismatch', 'attestation requires the complete fixture stage chain')
  }
  if (rows.map(record).some(item => item?.schema_version === ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA
    && item.run_id === runId && item.scenario_id === scenarioId && item.phase === phase)) {
    throw new ScenarioPackError('duplicate-attestation', `case ${caseId} already has an external-harness attestation`)
  }
  const normalizedDiagnosis = phase === 'deliberate-failure' ? diagnosis(row.diagnosis) : undefined
  if (phase === 'deliberate-failure') {
    const outcome = record(result.session_outcome)
    const bundle = record(result.diagnostic_bundle)
    if (outcome?.status !== 'failed' || typeof outcome.code !== 'string'
      || typeof outcome.component !== 'string' || typeof outcome.next_action !== 'string'
      || typeof bundle?.name !== 'string' || normalizedDiagnosis === undefined
      || normalizedDiagnosis.code !== outcome.code
      || normalizedDiagnosis.component !== outcome.component
      || normalizedDiagnosis.next_action !== outcome.next_action
      || normalizedDiagnosis.evidence_reference !== bundle.name) {
      throw new ScenarioPackError(
        'attestation-diagnosis-mismatch',
        'deliberate-failure diagnosis must match the result outcome and diagnostic bundle',
      )
    }
  }
  const normalized = {
    schema_version: ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA,
    run_id: runId,
    scenario_id: scenarioId,
    case_id: caseId,
    phase,
    status: 'pass' as const,
    observable_state: observableState(row.observable_state),
    ...(phase === 'success' ? {} : {
      diagnosis: normalizedDiagnosis!,
      recovery: recovery(row.recovery),
    }),
  }
  appendFileSync(outputPath, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  chmodSync(outputPath, 0o600)
  return normalized
}

export function summarizeAcceptanceScenarioPack(input: {
  outputPath: string
  pack: AcceptanceScenarioPack
}) {
  const rows = readJsonLines(input.outputPath).map(record).filter(item => item !== undefined) as JsonRecord[]
  const expectedCases = input.pack.families.flatMap(item => item.scenario_ids.flatMap(scenarioId => [
    `${scenarioId}.success`, `${scenarioId}.deliberate-failure`,
  ]))
  const expectedFamilyByCase = new Map<string, string>(input.pack.families.flatMap(item => item.scenario_ids.flatMap(scenarioId => [
    [`${scenarioId}.success`, item.id] as const,
    [`${scenarioId}.deliberate-failure`, item.id] as const,
  ])))
  const resultRows = rows.filter(item => item.schema_version === 'dsh-runtime-kit.acceptance-drive-result.v1')
  const attestations = rows.filter(item => item.schema_version === ACCEPTANCE_HARNESS_ATTESTATION_SCHEMA)
  const validResults = resultRows.filter(item => {
    const pack = record(item.scenario_pack)
    const caseId = typeof pack?.case_id === 'string' ? pack.case_id : ''
    const expectedFamily = expectedFamilyByCase.get(caseId)
    if (item.status !== 'pass' || typeof item.run_id !== 'string' || typeof item.scenario_id !== 'string'
      || expectedFamily === undefined || pack?.family !== expectedFamily
      || (pack.phase !== 'success' && pack.phase !== 'deliberate-failure')
      || caseId !== `${item.scenario_id}.${pack.phase}`
      || typeof pack.isolation_key !== 'string' || !/^[a-f0-9]{64}$/u.test(pack.isolation_key)) return false
    if (!fixtureChainMatches(item, pack.phase, expectedFamily, item.scenario_id)) return false
    if (pack.phase === 'deliberate-failure') {
      const outcome = record(item.session_outcome)
      const bundle = record(item.diagnostic_bundle)
      return outcome?.status === 'failed' && typeof outcome.code === 'string'
        && typeof outcome.component === 'string' && typeof outcome.next_action === 'string'
        && typeof bundle?.name === 'string'
    }
    return true
  })
  const passingResults = new Set(validResults.map(item => String(record(item.scenario_pack)?.case_id)))
  const resultByPair = new Map(validResults.map(item => [
    `${String(record(item.scenario_pack)?.case_id)}\0${String(item.run_id)}`,
    item,
  ]))
  const validAttestations = attestations.filter(item => {
    if (item.status !== 'pass' || typeof item.case_id !== 'string' || typeof item.run_id !== 'string') return false
    const result = resultByPair.get(`${item.case_id}\0${item.run_id}`)
    const pack = record(result?.scenario_pack)
    if (result === undefined || pack === undefined
      || item.scenario_id !== result.scenario_id || item.phase !== pack.phase) return false
    try {
      observableState(item.observable_state)
      if (pack.phase === 'success') return true
      const normalizedDiagnosis = diagnosis(item.diagnosis)
      recovery(item.recovery)
      const outcome = record(result.session_outcome)!
      const bundle = record(result.diagnostic_bundle)!
      return normalizedDiagnosis.code === outcome.code
        && normalizedDiagnosis.component === outcome.component
        && normalizedDiagnosis.next_action === outcome.next_action
        && normalizedDiagnosis.evidence_reference === bundle.name
    } catch {
      return false
    }
  })
  const passingAttestations = new Set(validAttestations.map(item => String(item.case_id)))
  const validAttestationSet = new Set(validAttestations)
  const invalidPairs = attestations.filter(item => item.status === 'pass'
    && expectedCases.includes(String(item.case_id)) && !validAttestationSet.has(item)).length
  const runIds = validResults.map(item => item.run_id as string)
  const isolationByFamily = new Map<string, Set<string>>()
  for (const item of validResults) {
    const pack = record(item.scenario_pack)!
    const keys = isolationByFamily.get(String(pack.family)) ?? new Set<string>()
    keys.add(String(pack.isolation_key))
    isolationByFamily.set(String(pack.family), keys)
  }
  const reusedIsolationKeys = new Set<string>()
  const isolationOwners = new Map<string, string>()
  for (const [family, keys] of isolationByFamily) {
    if (keys.size !== 1) continue
    const key = [...keys][0]!
    const previous = isolationOwners.get(key)
    if (previous === undefined) isolationOwners.set(key, family)
    else {
      reusedIsolationKeys.add(key)
    }
  }
  const invalidIsolationFamilies = input.pack.families.filter(item => {
    const keys = isolationByFamily.get(item.id)
    return keys === undefined || keys.size !== 1 || reusedIsolationKeys.has([...keys][0]!)
  }).map(item => item.id)
  const missingResults = expectedCases.filter(item => !passingResults.has(item))
  const missingAttestations = expectedCases.filter(item => !passingAttestations.has(item))
  const duplicateRunIds = runIds.length - new Set(runIds).size
  const counts = {
    expected_cases: expectedCases.length,
    result_pass: expectedCases.filter(item => passingResults.has(item)).length,
    attestation_pass: expectedCases.filter(item => passingAttestations.has(item)).length,
    missing_results: missingResults.length,
    missing_attestations: missingAttestations.length,
    invalid_pairs: invalidPairs,
    invalid_isolation_families: invalidIsolationFamilies.length,
  }
  return {
    schema_version: ACCEPTANCE_DRIVE_PACK_SUMMARY_SCHEMA,
    status: counts.expected_cases === 66 && missingResults.length === 0
      && missingAttestations.length === 0 && duplicateRunIds === 0 && invalidPairs === 0
      && invalidIsolationFamilies.length === 0 ? 'pass' as const : 'fail' as const,
    pack_schema_version: input.pack.schema_version,
    program_child: input.pack.program_child,
    profile_isolation: input.pack.profile_isolation,
    counts,
    missing_results: missingResults,
    missing_attestations: missingAttestations,
    duplicate_run_ids: duplicateRunIds,
    invalid_isolation_families: invalidIsolationFamilies,
  }
}

export function appendAcceptanceScenarioPackSummary(input: {
  outputPath: string
  pack: AcceptanceScenarioPack
}) {
  const summary = summarizeAcceptanceScenarioPack(input)
  const outputPath = ownedOutput(input.outputPath)
  appendFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  chmodSync(outputPath, 0o600)
  return summary
}
