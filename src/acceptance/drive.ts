import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { packageAsset } from '../package-root.js'
import {
  collectDiagnosticBundle,
  runtimeHealthCodeFromCommandOutput,
  sanitizeDiagnosticValue,
} from '../diagnostics/index.js'
import {
  appendAcceptanceAttestation,
  appendAcceptanceScenarioPackSummary,
  loadAcceptanceScenarioPack,
  ScenarioPackError,
  scenarioPackCase,
  type AcceptanceScenarioPackPhase,
} from './scenario-pack.js'

const CATALOG_SCHEMA = 'dsh-runtime-kit.acceptance-scenarios.v2'
const RESULT_SCHEMA = 'dsh-runtime-kit.acceptance-drive-result.v1'
const SUMMARY_SCHEMA = 'dsh-runtime-kit.acceptance-drive-summary.v1'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/u
const FEATURE_ISSUE_PATTERN = /^#(?:55|56|57|58|59|60|61|62|63|64|65|79|197|215)$/u
const FOLDER_KINDS = ['git-repo', 'non-git', 'managed-worktree'] as const
const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_SCENARIOS = 128
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_FILES = 512
const MAX_CAPTURE_NODES = 4096
const MAX_CAPTURE_DEPTH = 32
const MAX_CAPTURE_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_CAPTURE_FILE_BYTES = 8 * 1024 * 1024
const MAX_ZSTD_FRAMES = 16_384
const DEFAULT_TIMEOUT_MS = 30 * 60_000

type FolderKind = typeof FOLDER_KINDS[number]

export type AcceptanceScenario = {
  id: string
  owner: { program_child: '#C' | '#D' | '#E', feature_issue: string }
  preconditions: string[]
  folder_kind: FolderKind
  task: string
  success_marker: string
  deliberate_failure_task: string | null
  deliberate_failure_success_marker: string | null
  expected_observable_outcome: string
  expected_reminders: string[]
  forbidden_outcomes: string[]
}

export type AcceptanceCatalog = {
  schema_version: typeof CATALOG_SCHEMA
  scenarios: AcceptanceScenario[]
}

export type AcceptanceDriveInput = {
  profile: string
  catalogPath: string
  scenarioIds: string[]
  workdir: string
  retryWorkdir?: string
  outputPath: string
  artifactDir: string
  dshBin: string
  runtimeKitBin: string
  dshHome: string
  timeoutMs?: number
  runId?: string
  packageSpec?: string
  reportIssuePath?: string
  scenarioPackPath?: string
  phase?: AcceptanceScenarioPackPhase
  fixtureBin?: string
}

type CapturedCommand = {
  argv: string[]
  cwd: string
  exit_code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: string
}

type FileIdentity = {
  path: string
  sha256: string
  bytes: number
  mode: number
  device: number
  inode: number
}

type TranscriptScan = {
  digests: ReturnType<typeof digestFile>[]
  missingReminders: string[]
  forbiddenOutcomes: string[]
  policyDecisions: {
    source: 'session-transcript' | 'unavailable'
    actions: string[]
    rule_ids: string[]
  }
  inducedFailure?: { code: string }
  error?: { code: string, message: string, path: string }
}

class DriveError extends Error {
  code: string
  exitCode: number

  constructor(code: string, message: string, exitCode: number = 64) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function boundedString(value: unknown, label: string, maximum: number = 16_384) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new DriveError('invalid-catalog', `${label} must be a non-empty bounded string`)
  }
  return value
}

function stringList(value: unknown, label: string, allowEmpty: boolean = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64
    || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1024 || item.includes('\0'))) {
    throw new DriveError('invalid-catalog', `${label} must be a bounded string array`)
  }
  return [...value] as string[]
}

function scenario(value: unknown, index: number): AcceptanceScenario {
  const row = record(value)
  const keys = [
    'id', 'owner', 'preconditions', 'folder_kind', 'task', 'success_marker',
    'deliberate_failure_task', 'deliberate_failure_success_marker',
    'expected_observable_outcome', 'expected_reminders', 'forbidden_outcomes',
  ]
  if (row === undefined || !exactKeys(row, keys)) {
    throw new DriveError('invalid-catalog', `scenario ${index} has missing or unknown keys`)
  }
  const id = boundedString(row.id, `scenario ${index} id`, 96)
  if (!SCENARIO_ID_PATTERN.test(id)) {
    throw new DriveError('invalid-catalog', `scenario ${index} id is invalid`)
  }
  const owner = record(row.owner)
  if (owner === undefined || !exactKeys(owner, ['program_child', 'feature_issue'])
    || (owner.program_child !== '#C' && owner.program_child !== '#D' && owner.program_child !== '#E')
    || typeof owner.feature_issue !== 'string' || !FEATURE_ISSUE_PATTERN.test(owner.feature_issue)
    || (owner.program_child === '#E' && owner.feature_issue !== '#197')
    || (owner.program_child === '#C' && owner.feature_issue !== '#215')
    || (owner.program_child === '#D' && (owner.feature_issue === '#197' || owner.feature_issue === '#215'))) {
    throw new DriveError('invalid-catalog', `scenario ${id} has an invalid owner`)
  }
  if (typeof row.folder_kind !== 'string' || !FOLDER_KINDS.includes(row.folder_kind as FolderKind)) {
    throw new DriveError('invalid-catalog', `scenario ${id} has an invalid folder_kind`)
  }
  const task = boundedString(row.task, `scenario ${id} task`)
  const successMarker = boundedString(row.success_marker, `scenario ${id} success_marker`, 256)
  if (!task.includes(successMarker)) {
    throw new DriveError('invalid-catalog', `scenario ${id} task must name its success_marker`)
  }
  let deliberateFailureTask: string | null = null
  let deliberateFailureSuccessMarker: string | null = null
  if (owner.program_child === '#D') {
    deliberateFailureTask = boundedString(
      row.deliberate_failure_task,
      `scenario ${id} deliberate_failure_task`,
    )
    deliberateFailureSuccessMarker = boundedString(
      row.deliberate_failure_success_marker,
      `scenario ${id} deliberate_failure_success_marker`,
      256,
    )
    if (deliberateFailureSuccessMarker !== `DSH_ACCEPTANCE_RECOVERED:${id}`
      || !deliberateFailureTask.includes(deliberateFailureSuccessMarker)) {
      throw new DriveError(
        'invalid-catalog',
        `scenario ${id} deliberate-failure task must name its canonical recovery marker`,
      )
    }
  } else if (row.deliberate_failure_task !== null || row.deliberate_failure_success_marker !== null) {
    throw new DriveError('invalid-catalog', `scenario ${id} must not declare a #D deliberate-failure task`)
  }
  return {
    id,
    owner: {
      program_child: owner.program_child as '#C' | '#D' | '#E',
      feature_issue: owner.feature_issue,
    },
    preconditions: stringList(row.preconditions, `scenario ${id} preconditions`, false),
    folder_kind: row.folder_kind as FolderKind,
    task,
    success_marker: successMarker,
    deliberate_failure_task: deliberateFailureTask,
    deliberate_failure_success_marker: deliberateFailureSuccessMarker,
    expected_observable_outcome: boundedString(
      row.expected_observable_outcome,
      `scenario ${id} expected_observable_outcome`,
      4096,
    ),
    expected_reminders: stringList(row.expected_reminders, `scenario ${id} expected_reminders`),
    forbidden_outcomes: stringList(row.forbidden_outcomes, `scenario ${id} forbidden_outcomes`),
  }
}

// A deliberate-failure induction is not always a runtime fault. Several families
// stage a condition the runtime then handles correctly, and the fixture's own probe
// reports it as a typed JSON line on the command output surface:
//
//   {"status":"induced","code":"retired-surface-unreachable", ...}
//
// Only `induced` counts. A probe writing `status:"failed"` has found a real contract
// violation, and laundering that into an accepted induced failure would turn a
// genuine defect into a pass.
const FIXTURE_INDUCED_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

// The caller supplies only output from a call/result-correlated registered probe.
// Its object may be embedded in the Bash tool-result wrapper, so parse either the
// exact runtime-kit error row or the fixture-induced schema without consulting
// model/process output.
function fixtureInducedFailure(surface: string) {
  for (const line of surface.split(/\r?\n/gu)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const row = record(parsed)
    const error = record(row?.error)
    if (row?.schema_version === 'cli.dsh-runtime-kit.acceptance-fixture.v1'
      && row.ok === false
      && error?.code === 'acceptance-fixture-induced-failure') {
      return { code: error.code }
    }
  }
  for (const match of surface.matchAll(/\{[^{}]*"schema_version"\s*:\s*"dsh-runtime-kit\.acceptance-fixture-induced\.v1"[^{}]*\}/gu)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[0])
    } catch {
      continue
    }
    const row = record(parsed)
    if (row === undefined
      || row.schema_version !== 'dsh-runtime-kit.acceptance-fixture-induced.v1'
      || row.status !== 'induced') continue
    if (typeof row.code !== 'string' || !FIXTURE_INDUCED_CODE.test(row.code)) continue
    return { code: row.code }
  }
  return undefined
}

const MAIN_AGENT_REFUSAL_PREFIX = 'Error: dsh-runtime-kit:main-agent-cli-refused '

// DSH's MCP transcript preserves a failed runtime-kit tool call as an error
// tool-result, but some hosts flatten the thrown Error to its text and omit the
// custom top-level `code` property. Accept only the runtime-kit's fixed prefix
// followed by a valid JSON object from that error-only surface. Model prose and
// successful tool output are deliberately excluded by the caller.
function mainAgentInducedFailure(surface: string) {
  for (const line of surface.split(/\r?\n/gu)) {
    if (!line.startsWith(MAIN_AGENT_REFUSAL_PREFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(MAIN_AGENT_REFUSAL_PREFIX.length))
    } catch {
      continue
    }
    const row = record(parsed)
    if (typeof row?.code !== 'string' || !FIXTURE_INDUCED_CODE.test(row.code)) continue
    return { code: row.code }
  }
  return undefined
}

// An induced leg that ended because the provider, the host runtime or an
// unclassifiable fault stopped it proves nothing about the staged induction, so
// those categories never satisfy the deliberate-failure contract.
const INFRASTRUCTURE_OUTCOME_CATEGORIES: ReadonlySet<string> = new Set([
  'provider-failure',
  'health-failure',
  'unknown',
])

const EXPECTED_INDUCED_FAILURE_CODES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['workspace-identity', new Set(['WORKSPACE_FOREIGN_ACTIVE'])],
  ['governed-commit', new Set(['GOVERNED_COMMIT_REJECTED'])],
  ['automatic-prerequisite', new Set(['DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID'])],
  ['runtime-health', new Set(['DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID'])],
  ['authoritative-acceptance', new Set(['acceptance-fixture-induced-failure'])],
  ['managed-subagent-workspace', new Set(['assignment-launch-cwd-unavailable'])],
  ['data-policy', new Set(['sandbox-file-access-denied'])],
  ['restricted-role', new Set(['restricted-role-write-unavailable'])],
  ['session-artifact', new Set(['ARTIFACT_REF_INVALID'])],
  ['profile-lifecycle', new Set(['native-dsh-failed'])],
  ['deploy-dispatcher', new Set(['dispatcher-unavailable'])],
  ['retired-surfaces', new Set(['retired-surface-unreachable'])],
])

const FIXTURE_PROBE_BY_FAMILY: ReadonlyMap<string, string> = new Map([
  ['authoritative-acceptance', './fixture-validation.mjs'],
  ['restricted-role', './fixture-validation.mjs'],
  ['profile-lifecycle', './lifecycle-probe.mjs'],
  ['deploy-dispatcher', './deploy-probe.mjs'],
  ['retired-surfaces', './retired-probe.mjs'],
])

function toolArguments(value: unknown) {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  return record(value)
}

function inducedEvidenceCall(value: unknown, family: string) {
  const row = record(value)
  const data = record(row?.data)
  if (row?.type !== 'tool/call' || typeof data?.callId !== 'string' || typeof data.name !== 'string') {
    return undefined
  }
  if (family === 'managed-subagent-workspace' && data.name === 'main_agent_worker_launch') {
    return { callId: data.callId, kind: 'main-agent' as const }
  }
  const expectedProbe = FIXTURE_PROBE_BY_FAMILY.get(family)
  const args = toolArguments(data.arguments)
  if (data.name.toLowerCase() !== 'bash' || expectedProbe === undefined || args?.command !== expectedProbe) {
    return undefined
  }
  return { callId: data.callId, kind: 'fixture' as const }
}

function expectedInducedCode(family: string, code: unknown) {
  return typeof code === 'string' && EXPECTED_INDUCED_FAILURE_CODES.get(family)?.has(code) === true
}

function safeRegularFile(path: string, label: string) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    throw new DriveError('invalid-path', `${label} does not exist: ${path}`)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DriveError('invalid-path', `${label} must be a regular file: ${path}`)
  }
  return metadata
}

export function loadAcceptanceCatalog(path: string = packageAsset('compatibility', 'acceptance-scenarios.json')): AcceptanceCatalog {
  const metadata = safeRegularFile(path, 'acceptance scenario catalog')
  if (metadata.size <= 0 || metadata.size > MAX_CATALOG_BYTES) {
    throw new DriveError('invalid-catalog', 'acceptance scenario catalog exceeds its size bound')
  }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new DriveError('invalid-catalog', 'acceptance scenario catalog is not valid JSON')
  }
  const root = record(value)
  if (root === undefined || !exactKeys(root, ['schema_version', 'scenarios'])
    || root.schema_version !== CATALOG_SCHEMA || !Array.isArray(root.scenarios)
    || root.scenarios.length === 0 || root.scenarios.length > MAX_SCENARIOS) {
    throw new DriveError('invalid-catalog', `acceptance scenario catalog must carry ${CATALOG_SCHEMA}`)
  }
  const scenarios = root.scenarios.map(scenario)
  if (new Set(scenarios.map(row => row.id)).size !== scenarios.length) {
    throw new DriveError('invalid-catalog', 'acceptance scenario ids must be unique')
  }
  return { schema_version: CATALOG_SCHEMA, scenarios }
}

function ensureAbsoluteDirectory(path: string, label: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new DriveError('invalid-path', `${label} must be absolute`)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0) {
    throw new DriveError('unsafe-output', `${label} must be an owner-only real directory`)
  }
  return realpathSync(path)
}

function assertAbsoluteDirectory(path: string, label: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new DriveError('invalid-path', `${label} must be absolute`)
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new DriveError('invalid-path', `${label} must be a real directory`)
  }
  return realpathSync(path)
}

function executable(path: string, label: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new DriveError('invalid-path', `${label} must be absolute`)
  const canonical = realpathSync(path)
  const metadata = safeRegularFile(canonical, label)
  if ((typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & 0o022) !== 0) {
    throw new DriveError('invalid-path', `${label} must be current-user-owned and not group/other-writable`)
  }
  let cursor = dirname(canonical)
  for (;;) {
    const ancestor = lstatSync(cursor)
    const ownerTrusted = typeof process.getuid !== 'function'
      || ancestor.uid === process.getuid() || ancestor.uid === 0
    const writableByOthers = (ancestor.mode & 0o022) !== 0
    const sticky = (ancestor.mode & 0o1000) !== 0
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory() || !ownerTrusted
      || (writableByOthers && !sticky)) {
      throw new DriveError('invalid-path', `${label} has an unsafe containing directory`)
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  try {
    accessSync(canonical, constants.X_OK)
  } catch {
    throw new DriveError('invalid-path', `${label} must be executable`)
  }
  return canonical
}

function fileIdentity(path: string): FileIdentity {
  const metadata = safeRegularFile(path, 'executable identity')
  const bytes = readFileSync(path)
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    mode: metadata.mode & 0o777,
    device: metadata.dev,
    inode: metadata.ino,
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
}

function command(
  executablePath: string,
  args: string[],
  cwd: string,
  dshHome: string,
  timeoutMs: number,
): CapturedCommand {
  const trustedExecutable = executable(executablePath, 'command executable')
  const argv = [trustedExecutable, ...args]
  const result = spawnSync(trustedExecutable, args, {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_TEXT_BYTES,
    killSignal: 'SIGTERM',
  })
  return {
    argv,
    cwd,
    exit_code: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    ...(result.error === undefined ? {} : { error: result.error.message }),
  }
}

function fixtureCommand(input: {
  executablePath: string
  expectedIdentity: FileIdentity
  stage: 'prepare' | 'induce' | 'recover' | 'cleanup'
  phase: AcceptanceScenarioPackPhase
  family: string
  scenarioId: string
  profile: string
  workdir: string
  dshHome: string
  timeoutMs: number
}) {
  const args = [
    '--schema', 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    '--stage', input.stage,
    '--phase', input.phase,
    '--family', input.family,
    '--scenario', input.scenarioId,
    '--profile', input.profile,
  ]
  let identityMatches = false
  try {
    identityMatches = sameFileIdentity(input.expectedIdentity, fileIdentity(input.executablePath))
  } catch {
    identityMatches = false
  }
  if (!identityMatches) {
    return {
      ok: false as const,
      captured: {
        argv: [input.executablePath, ...args],
        cwd: input.workdir,
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: 'fixture executable identity changed before transition',
      } satisfies CapturedCommand,
      error: {
        code: 'executable-identity-changed',
        message: `fixture provider identity changed before ${input.stage} for ${input.scenarioId}`,
      },
    }
  }
  const captured = command(input.executablePath, args, input.workdir, input.dshHome, input.timeoutMs)
  const envelope = parsedEnvelope(captured.stdout)
  const data = record(envelope?.data)
  const references = Array.isArray(data?.evidence) ? data.evidence.map(record) : []
  const validReferences = references.length > 0 && references.every(item => item !== undefined
    && typeof item.kind === 'string' && item.kind.length > 0 && item.kind.length <= 96
    && typeof item.reference === 'string' && item.reference.length > 0 && item.reference.length <= 1024
    && !isAbsolute(item.reference) && !item.reference.startsWith('~') && !item.reference.includes('..')
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256))
  const ok = captured.exit_code === 0 && captured.signal === null
    && envelope?.schema_version === 'dsh-runtime-kit.acceptance-fixture-result.v1'
    && envelope.ok === true && data?.status === 'pass'
    && data.stage === input.stage && data.phase === input.phase
    && data.family === input.family && data.scenario_id === input.scenarioId
    && validReferences
  return ok ? { ok: true as const, captured, data: data! } : {
    ok: false as const,
    captured,
    error: {
      code: 'fixture-stage-failed',
      message: `fixture provider did not prove ${input.stage} for ${input.scenarioId}`,
    },
  }
}

function fixtureLeaseHolder(input: {
  executablePath: string
  expectedIdentity: FileIdentity
  stage: 'prepare' | 'induce'
  phase: AcceptanceScenarioPackPhase
  family: string
  scenarioId: string
  profile: string
  workdir: string
  dshHome: string
}) {
  if (!sameFileIdentity(input.expectedIdentity, fileIdentity(input.executablePath))) {
    throw new DriveError('executable-identity-changed', 'fixture provider identity changed before lease hold')
  }
  return spawn(input.executablePath, [
    '--schema', 'dsh-runtime-kit.acceptance-fixture-provider.v1',
    '--stage', input.stage,
    '--phase', input.phase,
    '--family', input.family,
    '--scenario', input.scenarioId,
    '--profile', input.profile,
    '--hold-workspace-lease',
  ], {
    cwd: input.workdir,
    env: { ...process.env, DSH_HOME: input.dshHome },
    stdio: 'ignore',
  })
}

function parsedEnvelope(output: string): Record<string, unknown> | undefined {
  const lines = output.trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = record(JSON.parse(lines[index]!))
      if (value !== undefined) return value
    } catch {}
  }
  return undefined
}

function errorFrom(result: CapturedCommand, fallback: string) {
  const envelope = parsedEnvelope(result.stdout)
  const error = record(envelope?.error)
  return {
    code: typeof error?.code === 'string' ? error.code : fallback,
    message: typeof error?.message === 'string'
      ? error.message
      : result.error ?? (result.stderr.trim() || `${fallback} (exit ${String(result.exit_code)})`),
  }
}

function setupProfile(input: Required<Pick<AcceptanceDriveInput,
  'profile' | 'runtimeKitBin' | 'workdir' | 'dshHome' | 'timeoutMs' | 'packageSpec'>>) {
  const base = ['setup', '--profile', input.profile, '--package', input.packageSpec, '--format', 'json']
  const preview = command(input.runtimeKitBin, base, input.workdir, input.dshHome, input.timeoutMs)
  const previewEnvelope = parsedEnvelope(preview.stdout)
  const previewData = record(previewEnvelope?.data)
  const digest = previewData?.plan_digest
  if (preview.exit_code !== 0 || previewEnvelope?.ok !== true
    || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
    return {
      ok: false as const,
      command: preview,
      error: errorFrom(preview, 'profile-setup-preview-failed'),
    }
  }
  const applied = command(
    input.runtimeKitBin,
    [...base, '--apply', '--expected-plan-digest', digest],
    input.workdir,
    input.dshHome,
    input.timeoutMs,
  )
  const appliedEnvelope = parsedEnvelope(applied.stdout)
  if (applied.exit_code !== 0 || appliedEnvelope?.ok !== true) {
    return {
      ok: false as const,
      command: applied,
      error: errorFrom(applied, 'profile-setup-apply-failed'),
    }
  }
  return { ok: true as const, preview, applied, planDigest: digest }
}

function doctorProfile(input: Required<Pick<AcceptanceDriveInput,
  'profile' | 'runtimeKitBin' | 'workdir' | 'dshHome' | 'timeoutMs'>>) {
  const result = command(
    input.runtimeKitBin,
    ['doctor', '--profile', input.profile, '--format', 'json'],
    input.workdir,
    input.dshHome,
    input.timeoutMs,
  )
  const envelope = parsedEnvelope(result.stdout)
  const data = record(envelope?.data)
  if (result.exit_code !== 0 || envelope?.ok !== true || data?.status !== 'healthy') {
    return { ok: false as const, command: result, error: errorFrom(result, 'profile-unhealthy') }
  }
  return { ok: true as const, command: result }
}

function gitValue(workdir: string, argument: string) {
  const result = spawnSync('git', ['-C', workdir, 'rev-parse', argument], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  })
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : undefined
}

function observedFolderKind(workdir: string): FolderKind {
  if (gitValue(workdir, '--is-inside-work-tree') !== 'true') return 'non-git'
  const gitDir = gitValue(workdir, '--absolute-git-dir')
  const commonDirValue = gitValue(workdir, '--git-common-dir')
  if (gitDir === undefined || commonDirValue === undefined) return 'git-repo'
  const commonDir = isAbsolute(commonDirValue) ? resolve(commonDirValue) : resolve(workdir, commonDirValue)
  return realpathSync(gitDir) === realpathSync(commonDir) ? 'git-repo' : 'managed-worktree'
}

type FileSnapshot = Map<string, { mtimeMs: number, size: number }>
type WalkBudget = { nodes: number, files: number, bytes: number }

function within(root: string, child: string) {
  const fragment = relative(root, child)
  return fragment === '' || (!fragment.startsWith(`..${sep}`) && fragment !== '..' && !isAbsolute(fragment))
}

function walkFiles(root: string, budget: WalkBudget): FileSnapshot {
  const snapshot: FileSnapshot = new Map()
  if (!existsSync(root)) return snapshot
  const canonicalRoot = realpathSync(root)
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_CAPTURE_DEPTH) {
      throw new DriveError('evidence-budget-exceeded', 'evidence tree exceeds the depth limit')
    }
    for (const name of readdirSync(directory).sort()) {
      budget.nodes += 1
      if (budget.nodes > MAX_CAPTURE_NODES) {
        throw new DriveError('evidence-budget-exceeded', 'evidence tree exceeds the node limit')
      }
      const path = join(directory, name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) {
        visit(path, depth + 1)
      } else if (metadata.isFile() && within(canonicalRoot, realpathSync(path))) {
        if (metadata.size > MAX_CAPTURE_FILE_BYTES) {
          throw new DriveError('evidence-budget-exceeded', 'an evidence file exceeds the per-file limit')
        }
        budget.files += 1
        budget.bytes += metadata.size
        if (budget.files > MAX_CAPTURE_FILES || budget.bytes > MAX_CAPTURE_TOTAL_BYTES) {
          throw new DriveError('evidence-budget-exceeded', 'evidence files exceed the aggregate capture limit')
        }
        snapshot.set(realpathSync(path), { mtimeMs: metadata.mtimeMs, size: metadata.size })
      }
    }
  }
  visit(canonicalRoot, 0)
  return snapshot
}

function evidenceRoots(workdir: string, dshHome: string) {
  return [
    join(workdir, '.dsh', 'sessions'),
    join(workdir, '.sessions'),
    join(dshHome, 'sessions'),
    join(dshHome, 'runtime-kit', 'state'),
  ]
}

function snapshotEvidence(workdir: string, dshHome: string) {
  const budget: WalkBudget = { nodes: 0, files: 0, bytes: 0 }
  return evidenceRoots(workdir, dshHome).map(root => ({ root, files: walkFiles(root, budget) }))
}

function changedEvidence(before: ReturnType<typeof snapshotEvidence>) {
  const changed: string[] = []
  const budget: WalkBudget = { nodes: 0, files: 0, bytes: 0 }
  for (const entry of before) {
    for (const [path, identity] of walkFiles(entry.root, budget)) {
      const prior = entry.files.get(path)
      if (prior === undefined || prior.mtimeMs !== identity.mtimeMs || prior.size !== identity.size) changed.push(path)
    }
  }
  return changed.sort()
}

function digestFile(path: string) {
  const bytes = readFileSync(path)
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

function concatenatedZstd(bytes: Buffer, maximum: number) {
  const chunks: Buffer[] = []
  let offset = 0
  let outputBytes = 0
  let frames = 0
  while (offset < bytes.byteLength) {
    frames += 1
    if (frames > MAX_ZSTD_FRAMES || outputBytes >= maximum) {
      throw new DriveError('transcript-budget-exceeded', 'zstd transcript exceeds its frame or output limit')
    }
    const decoded = zstdDecompressSync(bytes.subarray(offset), {
      info: true,
      maxOutputLength: maximum - outputBytes,
    } as never) as unknown as { buffer: Buffer, engine: { bytesWritten: number } }
    const consumed = decoded.engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || offset + consumed > bytes.byteLength) {
      throw new DriveError('transcript-invalid', 'zstd transcript frame boundary is invalid')
    }
    chunks.push(decoded.buffer)
    outputBytes += decoded.buffer.byteLength
    offset += consumed
  }
  return Buffer.concat(chunks, outputBytes)
}

function decodedTranscript(path: string, maximum: number) {
  const bytes = readFileSync(path)
  if (path.endsWith('.gz')) return gunzipSync(bytes, { maxOutputLength: maximum })
  if (path.endsWith('.zstd')) return concatenatedZstd(bytes, maximum)
  if (bytes.byteLength > maximum) {
    throw new DriveError('transcript-budget-exceeded', 'plain transcript exceeds its output limit')
  }
  return bytes
}

function observedTranscriptRecord(value: unknown) {
  const row = record(value)
  const type = row?.type
  return typeof type === 'string' && (
    type === 'tool/result'
    || type.startsWith('policy/')
    || type.startsWith('approval/')
    || type.startsWith('runtime-health/')
    || type.startsWith('finish-line/')
  )
}

function transcriptDecisionSurface(value: unknown, runtimeContextCallIds: Set<string>) {
  const row = record(value)
  if (row?.type !== 'tool/result') return JSON.stringify(value)
  const data = record(row.data)
  const message = record(data?.message)
  const source = record(message?.source)
  if (source?.kind === 'tool' && typeof source.callId === 'string'
    && runtimeContextCallIds.has(source.callId)) {
    const content = Array.isArray(message?.content) ? message.content : []
    const failed = content.some(item => record(item)?.isError === true)
    return failed ? '{}' : JSON.stringify({ runtime_context: content })
  }
  if (Array.isArray(data?.content)) {
    const errors = data.content.filter(item => {
      const result = record(item)
      return result?.type === 'tool-result' && result.isError === true
    })
    const directErrors = [row.error, data?.error].filter(item => item !== undefined)
    return JSON.stringify({ errors, direct_errors: directErrors })
  }
  const content = Array.isArray(message?.content) ? message.content : []
  const errors = content.filter(item => {
    const result = record(item)
    return result?.type === 'tool-result' && result.isError === true
  })
  const directErrors = [row.error, data?.error, message?.error]
    .filter(item => item !== undefined)
  return JSON.stringify({ errors, direct_errors: directErrors })
}

// `transcriptDecisionSurface` is deliberately restricted to error content because
// it feeds reminder and forbidden-outcome matching. The fixture parser consumes
// non-error text only after the enclosing result has been correlated to the exact
// registered probe call.
function transcriptToolResultText(value: unknown, errorsOnly = false) {
  const row = record(value)
  const data = record(row?.data)
  const message = record(data?.message)
  const groups = [data?.content, message?.content].filter(Array.isArray) as unknown[][]
  const texts: string[] = []
  for (const group of groups) {
    for (const item of group) {
      const result = record(item)
      if (result?.type !== 'tool-result') continue
      if (errorsOnly && result.isError !== true) continue
      const inner = Array.isArray(result.content) ? result.content : []
      for (const part of inner) {
        const text = record(part)?.text
        if (typeof text === 'string') texts.push(text)
      }
      if (typeof result.text === 'string') texts.push(result.text)
    }
  }
  return texts.join('\n')
}

function scanTranscripts(
  transcripts: string[],
  expectedReminders: string[],
  forbiddenOutcomes: string[],
  family: string | undefined,
): TranscriptScan {
  const actions = new Set<string>()
  const ruleIds = new Set<string>()
  const reminders = new Set<string>()
  const forbidden = new Set<string>()
  const digests: ReturnType<typeof digestFile>[] = []
  let compressedBytes = 0
  let decompressedBytes = 0
  let inducedFailure: { code: string } | undefined
  for (const path of transcripts) {
    const runtimeContextCallIds = new Set<string>()
    const inducedEvidenceCallIds = new Map<string, 'fixture' | 'main-agent'>()
    try {
      const metadata = safeRegularFile(path, 'session transcript')
      compressedBytes += metadata.size
      if (compressedBytes > MAX_TEXT_BYTES || decompressedBytes >= MAX_TEXT_BYTES) {
        throw new DriveError('transcript-budget-exceeded', 'transcripts exceed the aggregate scan limit')
      }
      const decoded = decodedTranscript(path, MAX_TEXT_BYTES - decompressedBytes)
      decompressedBytes += decoded.byteLength
      digests.push(digestFile(path))
      for (const line of decoded.toString('utf8').split('\n')) {
        if (line.length === 0) continue
        let value
        try {
          value = JSON.parse(line)
        } catch {
          throw new DriveError('transcript-invalid', 'session transcript contains invalid JSONL')
        }
        const row = record(value)
        const data = record(row?.data)
        if (row?.type === 'tool/call' && data?.name === 'runtime_context'
          && typeof data.callId === 'string') {
          runtimeContextCallIds.add(data.callId)
        }
        if (family !== undefined) {
          const evidenceCall = inducedEvidenceCall(value, family)
          if (evidenceCall !== undefined) {
            inducedEvidenceCallIds.set(evidenceCall.callId, evidenceCall.kind)
          }
          const source = record(record(data?.message)?.source)
          const evidenceKind = source?.kind === 'tool' && typeof source.callId === 'string'
            ? inducedEvidenceCallIds.get(source.callId)
            : undefined
          if (evidenceKind === 'fixture') {
            inducedFailure ??= fixtureInducedFailure(transcriptToolResultText(value))
          } else if (evidenceKind === 'main-agent') {
            inducedFailure ??= mainAgentInducedFailure(transcriptToolResultText(value, true))
          }
        }
        if (!observedTranscriptRecord(value)) continue
        const decisionSurface = transcriptDecisionSurface(value, runtimeContextCallIds)
        for (const marker of expectedReminders) if (decisionSurface.includes(marker)) reminders.add(marker)
        for (const marker of forbiddenOutcomes) if (decisionSurface.includes(marker)) forbidden.add(marker)
        for (const match of decisionSurface.matchAll(/\bdecision\.(allow|block|context|warn|transform)\b/gu)) {
          actions.add(match[1]!)
        }
        for (const match of decisionSurface.matchAll(/\bdsh\.[a-z0-9][a-z0-9-]{0,63}\b/gu)) {
          ruleIds.add(match[0])
        }
      }
    } catch (error) {
      const errorCode = record(error)?.code
      const normalized = error instanceof DriveError
        ? error
        : new DriveError(
          errorCode === 'ERR_BUFFER_TOO_LARGE'
            ? 'transcript-budget-exceeded'
            : 'transcript-invalid',
          error instanceof Error ? error.message : String(error),
        )
      return {
        digests,
        missingReminders: expectedReminders.filter(marker => !reminders.has(marker)),
        forbiddenOutcomes: [...forbidden].sort(),
        policyDecisions: {
          source: actions.size > 0 || ruleIds.size > 0 ? 'session-transcript' : 'unavailable',
          actions: [...actions].sort(),
          rule_ids: [...ruleIds].sort(),
        },
        ...(inducedFailure === undefined ? {} : { inducedFailure }),
        error: { code: normalized.code, message: normalized.message, path },
      }
    }
  }
  return {
    digests,
    missingReminders: expectedReminders.filter(marker => !reminders.has(marker)),
    forbiddenOutcomes: [...forbidden].sort(),
    policyDecisions: {
      source: actions.size > 0 || ruleIds.size > 0 ? 'session-transcript' : 'unavailable',
      actions: [...actions].sort(),
      rule_ids: [...ruleIds].sort(),
    },
    ...(inducedFailure === undefined ? {} : { inducedFailure }),
  }
}

function artifactName(runId: string, scenarioId: string, stream: 'stdout' | 'stderr') {
  const safeRun = runId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  const safeScenario = scenarioId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  return `${safeRun}-${safeScenario}.${stream}.txt`
}

function diagnosticArtifactName(runId: string, scenarioId: string) {
  const safeRun = runId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  const safeScenario = scenarioId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  return `${safeRun}-${safeScenario}.diagnostic.json`
}

function writeArtifact(directory: string, name: string, value: string) {
  const path = join(directory, name)
  if (!within(directory, path)) throw new DriveError('unsafe-output', 'artifact path escaped its root')
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return digestFile(path)
}

function resultPath(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new DriveError('invalid-path', 'output must be absolute')
  }
  const parent = ensureAbsoluteDirectory(dirname(path), 'result parent')
  const resolved = resolve(path)
  if (!within(parent, resolved) || resolved === parent) {
    throw new DriveError('unsafe-output', 'result path escapes its owner-only parent')
  }
  if (existsSync(resolved)) {
    const metadata = lstatSync(resolved)
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new DriveError('unsafe-output', 'result path must be an owned regular file')
    }
  }
  return resolved
}

function appendRow(path: string, value: unknown) {
  const resolved = resultPath(path)
  appendFileSync(resolved, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  chmodSync(resolved, 0o600)
}

function preconditionRow(
  input: AcceptanceDriveInput,
  scenarioValue: AcceptanceScenario,
  runId: string,
  stage: string,
  error: { code: string, message: string },
  captured?: CapturedCommand,
) {
  const timestamp = new Date().toISOString()
  const observed = captured === undefined ? null : {
    command: { argv: captured.argv, cwd: captured.cwd },
    exit_code: captured.exit_code,
    signal: captured.signal,
    stdout: writeArtifact(
      input.artifactDir,
      artifactName(runId, scenarioValue.id, 'stdout'),
      captured.stdout,
    ),
    stderr: writeArtifact(
      input.artifactDir,
      artifactName(runId, scenarioValue.id, 'stderr'),
      captured.stderr,
    ),
  }
  return {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    scenario_id: scenarioValue.id,
    owner: scenarioValue.owner,
    profile: input.profile,
    folder_kind: scenarioValue.folder_kind,
    workdir: input.workdir,
    stage,
    status: 'precondition-unmet',
    started_at: timestamp,
    finished_at: timestamp,
    expected: {
      observable_outcome: scenarioValue.expected_observable_outcome,
      reminders: scenarioValue.expected_reminders,
      forbidden_outcomes: scenarioValue.forbidden_outcomes,
    },
    observed,
    error,
  }
}

export function runAcceptanceDrive(input: AcceptanceDriveInput) {
  if (!PROFILE_PATTERN.test(input.profile)) throw new DriveError('invalid-profile', 'profile is invalid')
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new DriveError('invalid-timeout', 'timeout must be between 100 and 1800000 milliseconds')
  }
  const runId = input.runId ?? `acceptance-drive-${randomUUID()}`
  if (!SCENARIO_ID_PATTERN.test(runId)) throw new DriveError('invalid-run-id', 'run id is invalid')
  const workdir = assertAbsoluteDirectory(input.workdir, 'workdir')
  const retryWorkdir = input.retryWorkdir === undefined
    ? undefined
    : assertAbsoluteDirectory(input.retryWorkdir, 'retry workdir')
  const dshHome = assertAbsoluteDirectory(input.dshHome, 'DSH home')
  const outputPath = resultPath(input.outputPath)
  const artifactDir = ensureAbsoluteDirectory(input.artifactDir, 'artifact directory')
  const dshBin = executable(input.dshBin, 'DSH executable')
  const runtimeKitBin = executable(input.runtimeKitBin, 'runtime-kit executable')
  const dshIdentity = fileIdentity(dshBin)
  const runtimeKitIdentity = fileIdentity(runtimeKitBin)
  const catalog = loadAcceptanceCatalog(input.catalogPath)
  if (!Array.isArray(input.scenarioIds) || input.scenarioIds.length === 0
    || new Set(input.scenarioIds).size !== input.scenarioIds.length) {
    throw new DriveError('invalid-scenarios', 'select at least one unique scenario id')
  }
  const byId = new Map(catalog.scenarios.map(row => [row.id, row]))
  const selected = input.scenarioIds.map(id => {
    const selectedScenario = byId.get(id)
    if (selectedScenario === undefined) throw new DriveError('unknown-scenario', `unknown scenario: ${id}`)
    return selectedScenario
  })
  if (input.phase !== undefined && input.phase !== 'success' && input.phase !== 'deliberate-failure') {
    throw new DriveError('invalid-phase', 'phase must be success or deliberate-failure')
  }
  const scenarioPack = input.phase === undefined
    ? undefined
    : loadAcceptanceScenarioPack(
        input.scenarioPackPath ?? packageAsset('compatibility', 'acceptance-scenario-pack.json'),
        catalog,
      )
  if (scenarioPack !== undefined && selected.some(item => item.owner.program_child !== '#D')) {
    throw new DriveError('invalid-phase', 'scenario-pack phases apply only to #D scenarios')
  }
  const needsDistinctRetry = input.phase === 'deliberate-failure'
    && selected.some(item => item.folder_kind !== 'non-git')
  if (retryWorkdir !== undefined && input.phase !== 'deliberate-failure') {
    throw new DriveError('invalid-retry-workdir', 'retry workdir requires the deliberate-failure phase')
  }
  if (needsDistinctRetry && retryWorkdir === undefined) {
    throw new DriveError(
      'missing-retry-workdir',
      'Git deliberate-failure scenarios require a distinct clean retry workdir',
    )
  }
  if (needsDistinctRetry && retryWorkdir === workdir) {
    throw new DriveError('invalid-retry-workdir', 'Git clean retry workdir must be physically distinct')
  }
  if (!needsDistinctRetry && retryWorkdir !== undefined) {
    throw new DriveError('invalid-retry-workdir', 'retry workdir is supported only for Git deliberate-failure scenarios')
  }
  const fixtureCandidate = scenarioPack === undefined
    ? undefined
    : input.fixtureBin ?? packageAsset('dist', 'bin', 'dsh-runtime-kit-acceptance-fixture.js')
  const fixtureBin = fixtureCandidate === undefined
    ? undefined
    : executable(fixtureCandidate, 'fixture provider')
  const fixtureIdentity = fixtureBin === undefined ? undefined : fileIdentity(fixtureBin)
  const isolationKey = createHash('sha256')
    .update(JSON.stringify({ profile: input.profile, dsh_home: dshHome }))
    .digest('hex')
  const packMetadata = (scenarioValue: AcceptanceScenario) => scenarioPack === undefined
    ? undefined
    : scenarioPackCase(scenarioPack, scenarioValue.id, input.phase!, isolationKey)
  const normalized = {
    ...input,
    timeoutMs,
    workdir,
    ...(retryWorkdir === undefined ? {} : { retryWorkdir }),
    dshHome,
    outputPath,
    artifactDir,
    dshBin,
    runtimeKitBin,
  }
  const results: Array<Record<string, unknown>> = []
  let setupEvidence: Record<string, unknown> | null = null
  let doctorEvidence: Record<string, unknown> | null = null

  const commandEvidence = (label: string, captured: CapturedCommand) => ({
    command: { argv: captured.argv, cwd: captured.cwd },
    exit_code: captured.exit_code,
    signal: captured.signal,
    stdout: writeArtifact(artifactDir, runId + '.' + label + '.stdout.txt', captured.stdout),
    stderr: writeArtifact(artifactDir, runId + '.' + label + '.stderr.txt', captured.stderr),
  })

  const runContext = () => ({
    dsh_executable: dshIdentity,
    runtime_kit_executable: runtimeKitIdentity,
    ...(fixtureIdentity === undefined ? {} : { fixture_executable: fixtureIdentity }),
    package_setup: setupEvidence,
    doctor: doctorEvidence,
  })

  const executableIdentityError = () => {
    try {
      if (sameFileIdentity(dshIdentity, fileIdentity(dshBin))
        && sameFileIdentity(runtimeKitIdentity, fileIdentity(runtimeKitBin))
        && (fixtureIdentity === undefined || sameFileIdentity(fixtureIdentity, fileIdentity(fixtureBin!)))) return undefined
      return {
        code: 'executable-identity-changed',
        message: 'the DSH or runtime-kit executable identity changed during the run',
      }
    } catch (error) {
      return {
        code: 'executable-identity-changed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const taskEvidence = (
    scenarioValue: AcceptanceScenario,
    successMarker: string,
    captured: CapturedCommand,
    evidenceBefore: ReturnType<typeof snapshotEvidence>,
    family: string | undefined,
  ) => {
    let changed: string[] = []
    let captureError: { code: string, message: string } | undefined
    try {
      changed = changedEvidence(evidenceBefore)
    } catch (error) {
      const normalizedError = error instanceof DriveError
        ? error
        : new DriveError('evidence-scan-failed', error instanceof Error ? error.message : String(error))
      captureError = { code: normalizedError.code, message: normalizedError.message }
    }
    const transcripts = changed.filter(path => path.includes(sep + 'sessions' + sep)
      && (path.endsWith('.jsonl') || path.endsWith('.jsonl.gz') || path.endsWith('.jsonl.zstd')))
    const receipts = changed.filter(path => path.startsWith(join(dshHome, 'runtime-kit', 'state') + sep))
    const transcriptScan = scanTranscripts(
      transcripts,
      scenarioValue.expected_reminders,
      scenarioValue.forbidden_outcomes.filter(marker => marker !== 'silent-stop'),
      family,
    )
    const structuredStderr = captured.stderr.split('\n').flatMap(line => {
      if (line.length === 0) return []
      try {
        const value = JSON.parse(line)
        const row = record(value)
        return row !== undefined && (
          typeof row.schema_version === 'string'
          || typeof row.code === 'string'
          || record(row.error) !== undefined
          || record(row.outcome) !== undefined
        ) ? [JSON.stringify(value)] : []
      } catch {
        return []
      }
    }).join('\n')
    const commandOutput = `${captured.stdout}\n${structuredStderr}`
    const missingReminders = transcriptScan.missingReminders
    const forbidden = [...new Set([
      ...scenarioValue.forbidden_outcomes.filter(marker => (
        marker === 'silent-stop'
          ? captured.stdout.trim().length === 0 && captured.stderr.trim().length === 0
          : commandOutput.includes(marker)
      )),
      ...transcriptScan.forbiddenOutcomes,
    ])].sort()
    // The marker is a protocol token proving the session reached its declared end, not the
    // acceptance gate itself — independent state attestation is. Requiring the whole trimmed
    // line to equal it rejects a correct marker that carries trailing prose, so the marker
    // only has to lead its line, followed by a whitespace boundary. Prose that merely
    // mentions or negates the marker keeps failing, because that puts words in front of it,
    // and a marker fused into a longer token still does not match.
    const markerSeen = captured.stdout.split(/\r?\n/u).some(line => {
      const trimmed = line.trim()
      return trimmed === successMarker
        || (trimmed.startsWith(successMarker) && /^\s/u.test(trimmed.slice(successMarker.length)))
    })
    const identityError = executableIdentityError()
    return {
      captureError,
      transcripts,
      receipts,
      transcriptScan,
      missingReminders,
      forbidden,
      markerSeen,
      identityError,
      pass: missingReminders.length === 0 && forbidden.length === 0
        && captureError === undefined && transcriptScan.error === undefined
        && identityError === undefined,
    }
  }

  const diagnosticEvidence = (
    scenarioId: string,
    observation: Parameters<typeof collectDiagnosticBundle>[0]['observation'],
    options: {
      skipDsh?: boolean
      skipCommands?: boolean
      sessionWindow?: { started_at_ms: number, finished_at_ms: number }
    } = {},
  ) => {
    const bundle = collectDiagnosticBundle({
      profile: input.profile,
      dshHome,
      workdir,
      runtimeKitEntry: runtimeKitBin,
      dshBin,
      observation,
      ...options,
    })
    const artifact = writeArtifact(
        artifactDir,
        diagnosticArtifactName(runId, scenarioId),
        `${JSON.stringify(bundle, undefined, 2)}\n`,
      )
    const session = record(bundle.session)
    const typedErrorCodes = (Array.isArray(session?.typed_errors) ? session.typed_errors : [])
      .flatMap(value => {
        const code = record(value)?.code
        return typeof code === 'string' ? [code] : []
      })
    return {
      identity: { name: basename(artifact.path), sha256: artifact.sha256, bytes: artifact.bytes },
      outcome: bundle.session_outcome,
      typedErrorCodes,
    }
  }

  const emitSharedFailure = (
    stage: string,
    error: { code: string, message: string },
    captured?: CapturedCommand,
  ) => {
    const identityError = executableIdentityError()
    const effectiveError = identityError ?? error
    for (const selectedScenario of selected) {
      const diagnostic = diagnosticEvidence(selectedScenario.id, {
        exit_code: captured?.exit_code,
        error_code: effectiveError.code,
        ...(stage === 'profile-doctor'
          ? { doctor_status: 'needs-attention', doctor_code: effectiveError.code }
          : { error_component: identityError === undefined ? 'operations' as const : 'session' as const }),
      }, { skipDsh: true, skipCommands: identityError !== undefined })
      const row = {
        ...preconditionRow(normalized, selectedScenario, runId, stage, effectiveError, captured),
        ...(packMetadata(selectedScenario) === undefined ? {} : { scenario_pack: packMetadata(selectedScenario) }),
        diagnostic_bundle: diagnostic.identity,
        session_outcome: diagnostic.outcome,
      }
      appendRow(outputPath, row)
      results.push(row)
    }
  }

  if (input.packageSpec !== undefined) {
    const setup = setupProfile({
      profile: input.profile,
      runtimeKitBin,
      workdir,
      dshHome,
      timeoutMs,
      packageSpec: input.packageSpec,
    })
    if (!setup.ok) {
      emitSharedFailure('profile-setup', setup.error, setup.command)
    } else {
      setupEvidence = {
        package_spec_sha256: createHash('sha256').update(input.packageSpec).digest('hex'),
        plan_digest: setup.planDigest,
        preview: commandEvidence('profile-setup-preview', setup.preview),
        apply: commandEvidence('profile-setup-apply', setup.applied),
      }
    }
  }

  if (results.length === 0) {
    const doctor = doctorProfile({ profile: input.profile, runtimeKitBin, workdir, dshHome, timeoutMs })
    if (!doctor.ok) {
      emitSharedFailure('profile-doctor', doctor.error, doctor.command)
    } else {
      doctorEvidence = commandEvidence('profile-doctor', doctor.command)
    }
  }

  if (results.length === 0) {
    const actualFolderKind = observedFolderKind(workdir)
    for (const selectedScenario of selected) {
      if (selectedScenario.folder_kind !== actualFolderKind) {
        const row = {
          ...preconditionRow(normalized, selectedScenario, runId, 'scenario-precondition', {
            code: 'folder-kind-mismatch',
            message: `scenario requires ${selectedScenario.folder_kind}; workdir is ${actualFolderKind}`,
          }),
          ...(packMetadata(selectedScenario) === undefined ? {} : { scenario_pack: packMetadata(selectedScenario) }),
        }
        appendRow(outputPath, row)
        results.push(row)
        continue
      }
      if (retryWorkdir !== undefined) {
        const retryFolderKind = observedFolderKind(retryWorkdir)
        if (selectedScenario.folder_kind !== retryFolderKind) {
          const row = {
            ...preconditionRow(normalized, selectedScenario, runId, 'scenario-precondition', {
              code: 'retry-folder-kind-mismatch',
              message: `scenario requires ${selectedScenario.folder_kind}; retry workdir is ${retryFolderKind}`,
            }),
            ...(packMetadata(selectedScenario) === undefined ? {} : { scenario_pack: packMetadata(selectedScenario) }),
          }
          appendRow(outputPath, row)
          results.push(row)
          continue
        }
      }
      const startedAt = new Date()
      let before
      try {
        before = snapshotEvidence(workdir, dshHome)
      } catch (error) {
        const normalizedError = error instanceof DriveError
          ? error
          : new DriveError('evidence-scan-failed', error instanceof Error ? error.message : String(error))
        const row = {
          ...preconditionRow(normalized, selectedScenario, runId, 'scenario-precondition', {
            code: normalizedError.code,
            message: normalizedError.message,
          }),
          ...(packMetadata(selectedScenario) === undefined ? {} : { scenario_pack: packMetadata(selectedScenario) }),
        }
        appendRow(outputPath, row)
        results.push(row)
        continue
      }
      const packRow = packMetadata(selectedScenario)
      const fixtureStartStage = input.phase === 'deliberate-failure' ? 'induce' as const : 'prepare' as const
      const fixtureStart = fixtureBin === undefined || packRow === undefined ? undefined : fixtureCommand({
        executablePath: fixtureBin,
        expectedIdentity: fixtureIdentity!,
        stage: fixtureStartStage,
        phase: input.phase!,
        family: packRow.family,
        scenarioId: selectedScenario.id,
        profile: input.profile,
        workdir,
        dshHome,
        timeoutMs,
      })
      if (fixtureStart !== undefined && !fixtureStart.ok) {
        const fixtureCleanup = fixtureCommand({
          executablePath: fixtureBin!,
          expectedIdentity: fixtureIdentity!,
          stage: 'cleanup',
          phase: input.phase!,
          family: packRow!.family,
          scenarioId: selectedScenario.id,
          profile: input.profile,
          workdir,
          dshHome,
          timeoutMs,
        })
        const row = {
          ...preconditionRow(
            normalized,
            selectedScenario,
            runId,
            `fixture-${fixtureStartStage}`,
            fixtureStart.error,
            fixtureStart.captured,
          ),
          scenario_pack: packRow,
          fixture_cleanup: fixtureCleanup.ok ? {
            status: 'pass',
            receipt: fixtureCleanup.data,
            command: commandEvidence('fixture-cleanup', fixtureCleanup.captured),
          } : {
            status: 'fail',
            error: fixtureCleanup.error,
            command: commandEvidence('fixture-cleanup', fixtureCleanup.captured),
          },
        }
        appendRow(outputPath, row)
        results.push(row)
        continue
      }
      const task = input.phase === 'deliberate-failure'
        ? selectedScenario.deliberate_failure_task!
        : selectedScenario.task
      const expectedMarker = input.phase === 'deliberate-failure'
        ? selectedScenario.deliberate_failure_success_marker!
        : selectedScenario.success_marker
      const holdWorkspaceLease = packRow?.family === 'workspace-identity'
        && (input.phase === 'deliberate-failure' || selectedScenario.id !== 'workspace-identity.non-git')
      const leaseHolder = holdWorkspaceLease ? fixtureLeaseHolder({
        executablePath: fixtureBin!,
        expectedIdentity: fixtureIdentity!,
        stage: fixtureStartStage,
        phase: input.phase!,
        family: packRow!.family,
        scenarioId: selectedScenario.id,
        profile: input.profile,
        workdir,
        dshHome,
      }) : undefined
      let executed: CapturedCommand
      try {
        executed = command(
          dshBin,
          ['--profile', input.profile, task],
          workdir,
          dshHome,
          timeoutMs,
        )
      } finally {
        leaseHolder?.kill('SIGTERM')
      }
      const evidence = taskEvidence(selectedScenario, expectedMarker, executed, before, packRow?.family)
      const commandOutput = executed.stdout + '\n' + executed.stderr
      const {
        captureError, transcripts, receipts, transcriptScan, missingReminders, forbidden, markerSeen, identityError,
      } = evidence
      const stdout = writeArtifact(artifactDir, artifactName(runId, selectedScenario.id, 'stdout'), executed.stdout)
      const stderr = writeArtifact(artifactDir, artifactName(runId, selectedScenario.id, 'stderr'), executed.stderr)
      const taskFinishedAt = new Date()
      const executionCode = executed.exit_code !== 0
        && /MISSING_CREDENTIAL|no API key for provider|provider[^\n]*(?:unavailable|failed|error)|(?:unavailable|failed)[^\n]*provider/iu.test(commandOutput)
        ? 'provider-unavailable'
        : executed.error !== undefined || executed.exit_code !== 0 || executed.signal !== null
          ? 'scenario-execution-failed'
          : 'scenario-outcome-mismatch'
      const runtimeHealthCode = runtimeHealthCodeFromCommandOutput(executed.stderr)
      const diagnostic = diagnosticEvidence(selectedScenario.id, {
        exit_code: executed.exit_code,
        error_code: identityError?.code ?? runtimeHealthCode
          ?? (executionCode === 'provider-unavailable' ? executionCode : undefined),
        ...(identityError !== undefined
          ? { error_component: 'session' as const }
          : runtimeHealthCode !== undefined
            ? { error_component: 'runtime-health' as const, error_receipt: 'command.stderr' }
            : {}),
        policy_decisions: transcriptScan.policyDecisions.actions.map(action => ({
          action,
        })),
      }, {
        skipCommands: identityError !== undefined,
        sessionWindow: { started_at_ms: startedAt.getTime(), finished_at_ms: taskFinishedAt.getTime() },
      })
      const commonEvidencePass = evidence.pass
      const inducedFailureEvidencePass = forbidden.length === 0
        && captureError === undefined && transcriptScan.error === undefined
        && identityError === undefined
      const inducedFailure = input.phase === 'deliberate-failure'
        ? transcriptScan.inducedFailure
        : undefined
      // The first leg must expose this family's exact typed code. Correlated probe
      // evidence proves where a completed-session induction came from; the
      // byte-identical clean retry then proves recovery without replacing that
      // identity check.
      const expectedFamilyFailure = packRow !== undefined && (
        expectedInducedCode(packRow.family, diagnostic.outcome.code)
        || expectedInducedCode(packRow.family, inducedFailure?.code)
      )
      const expectedFailureObserved = input.phase === 'deliberate-failure'
        && !markerSeen
        && expectedFamilyFailure
        && (!INFRASTRUCTURE_OUTCOME_CATEGORIES.has(diagnostic.outcome.category)
          || expectedInducedCode(packRow!.family, inducedFailure?.code)
          || (diagnostic.outcome.category === 'health-failure'
            && diagnostic.outcome.component === 'runtime-health'))
        && (diagnostic.outcome.status === 'failed' || inducedFailure !== undefined)
      const fixtureRecovery = fixtureBin === undefined || packRow === undefined
        || input.phase !== 'deliberate-failure' || !expectedFailureObserved ? undefined : fixtureCommand({
          executablePath: fixtureBin,
          expectedIdentity: fixtureIdentity!,
          stage: 'recover',
          phase: input.phase,
          family: packRow.family,
          scenarioId: selectedScenario.id,
          profile: input.profile,
          workdir,
          dshHome,
          timeoutMs,
        })
      const cleanRetryWorkdir = retryWorkdir ?? workdir
      const fixtureRetryInduce = fixtureRecovery?.ok !== true || retryWorkdir === undefined
        ? undefined
        : fixtureCommand({
            executablePath: fixtureBin!,
            expectedIdentity: fixtureIdentity!,
            stage: 'induce',
            phase: 'deliberate-failure',
            family: packRow!.family,
            scenarioId: selectedScenario.id,
            profile: input.profile,
            workdir: cleanRetryWorkdir,
            dshHome,
            timeoutMs,
          })
      const fixtureRetryRecovery = fixtureRetryInduce?.ok !== true
        ? undefined
        : fixtureCommand({
            executablePath: fixtureBin!,
            expectedIdentity: fixtureIdentity!,
            stage: 'recover',
            phase: 'deliberate-failure',
            family: packRow!.family,
            scenarioId: selectedScenario.id,
            profile: input.profile,
            workdir: cleanRetryWorkdir,
            dshHome,
            timeoutMs,
          })
      const cleanRetryFixtureReady = fixtureRecovery?.ok === true
        && (retryWorkdir === undefined || fixtureRetryRecovery?.ok === true)
      let recoveryBefore: ReturnType<typeof snapshotEvidence> | undefined
      let recoveryCaptureError: { code: string, message: string } | undefined
      if (cleanRetryFixtureReady) {
        try {
          recoveryBefore = snapshotEvidence(cleanRetryWorkdir, dshHome)
        } catch (error) {
          const normalizedError = error instanceof DriveError
            ? error
            : new DriveError('evidence-scan-failed', error instanceof Error ? error.message : String(error))
          recoveryCaptureError = { code: normalizedError.code, message: normalizedError.message }
        }
      }
      const recoveryExecuted = cleanRetryFixtureReady && recoveryBefore !== undefined
        ? command(dshBin, ['--profile', input.profile, task], cleanRetryWorkdir, dshHome, timeoutMs)
        : undefined
      const recoveryEvidence = recoveryExecuted === undefined || recoveryBefore === undefined
        ? undefined
        : taskEvidence(selectedScenario, expectedMarker, recoveryExecuted, recoveryBefore, packRow?.family)
      const recoveryTaskByteIdentical = recoveryExecuted === undefined
        ? false
        : JSON.stringify(recoveryExecuted.argv) === JSON.stringify(executed.argv)
      const recoveryPass = input.phase !== 'deliberate-failure' || (
        fixtureRecovery?.ok === true && recoveryExecuted?.exit_code === 0
        && recoveryExecuted.signal === null && recoveryEvidence?.markerSeen === true
        && recoveryEvidence.pass && recoveryTaskByteIdentical
      )
      const fixtureCleanup = fixtureBin === undefined || packRow === undefined ? undefined : fixtureCommand({
        executablePath: fixtureBin,
        expectedIdentity: fixtureIdentity!,
        stage: 'cleanup',
        phase: input.phase!,
        family: packRow.family,
        scenarioId: selectedScenario.id,
        profile: input.profile,
        workdir,
        dshHome,
        timeoutMs,
      })
      const fixtureRetryCleanup = fixtureBin === undefined || packRow === undefined
        || retryWorkdir === undefined ? undefined : fixtureCommand({
          executablePath: fixtureBin,
          expectedIdentity: fixtureIdentity!,
          stage: 'cleanup',
          phase: input.phase!,
          family: packRow.family,
          scenarioId: selectedScenario.id,
          profile: input.profile,
          workdir: cleanRetryWorkdir,
          dshHome,
          timeoutMs,
        })
      const fixturePass = fixtureCleanup?.ok !== false
        && fixtureRetryCleanup?.ok !== false
        && fixtureRetryInduce?.ok !== false
        && fixtureRetryRecovery?.ok !== false
        && recoveryPass
      const governedCommitPass = selectedScenario.id !== 'governed-commit.managed-worktree'
        || !diagnostic.typedErrorCodes.includes('GOVERNED_COMMIT_REJECTED')
      const status = fixturePass && (input.phase === 'deliberate-failure'
        ? inducedFailureEvidencePass && expectedFailureObserved
        : commonEvidencePass && governedCommitPass
          && executed.exit_code === 0 && executed.signal === null && markerSeen)
        ? 'pass' : 'fail'
      const finishedAt = new Date()
      const row = {
        schema_version: RESULT_SCHEMA,
        run_id: runId,
        scenario_id: selectedScenario.id,
        owner: selectedScenario.owner,
        profile: input.profile,
        folder_kind: selectedScenario.folder_kind,
        workdir,
        ...(packMetadata(selectedScenario) === undefined ? {} : { scenario_pack: packMetadata(selectedScenario) }),
        run_context: runContext(),
        stage: 'dsh-task',
        status,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        expected: {
          observable_outcome: selectedScenario.expected_observable_outcome,
          reminders: selectedScenario.expected_reminders,
          forbidden_outcomes: selectedScenario.forbidden_outcomes,
          success_marker: expectedMarker,
        },
        observed: {
          command: { argv: executed.argv, cwd: executed.cwd },
          exit_code: executed.exit_code,
          signal: executed.signal,
          stdout,
          stderr,
          success_marker_seen: markerSeen,
          expected_failure_observed: expectedFailureObserved,
          ...(inducedFailure === undefined ? {} : { induced_failure: inducedFailure }),
          ...(fixtureStart === undefined ? {} : {
            fixture: {
              start: {
                stage: fixtureStartStage,
                receipt: fixtureStart.data,
                command: commandEvidence(`fixture-${fixtureStartStage}`, fixtureStart.captured),
              },
              ...(fixtureRecovery === undefined ? {} : {
                recovery: {
                  receipt: fixtureRecovery.data,
                  command: commandEvidence('fixture-recover', fixtureRecovery.captured),
                },
              }),
              ...(recoveryExecuted === undefined && recoveryCaptureError === undefined ? {} : {
                clean_retry: {
                  status: recoveryPass ? 'pass' : 'fail',
                  success_gate_passed: recoveryEvidence?.pass === true,
                  task_byte_identical: recoveryTaskByteIdentical,
                  workdir: cleanRetryWorkdir,
                  ...(fixtureRetryInduce === undefined ? {} : {
                    fixture_induce: fixtureRetryInduce.ok ? {
                      receipt: fixtureRetryInduce.data,
                      command: commandEvidence('fixture-retry-induce', fixtureRetryInduce.captured),
                    } : {
                      error: fixtureRetryInduce.error,
                      command: commandEvidence('fixture-retry-induce', fixtureRetryInduce.captured),
                    },
                  }),
                  ...(fixtureRetryRecovery === undefined ? {} : {
                    fixture_recovery: fixtureRetryRecovery.ok ? {
                      receipt: fixtureRetryRecovery.data,
                      command: commandEvidence('fixture-retry-recover', fixtureRetryRecovery.captured),
                    } : {
                      error: fixtureRetryRecovery.error,
                      command: commandEvidence('fixture-retry-recover', fixtureRetryRecovery.captured),
                    },
                  }),
                  ...(recoveryExecuted === undefined ? {} : {
                    command: { argv: recoveryExecuted.argv, cwd: recoveryExecuted.cwd },
                    exit_code: recoveryExecuted.exit_code,
                    signal: recoveryExecuted.signal,
                    success_marker_seen: recoveryEvidence?.markerSeen === true,
                    stdout: writeArtifact(
                      artifactDir,
                      `${runId}-${selectedScenario.id}.recovery.stdout.txt`,
                      recoveryExecuted.stdout,
                    ),
                    stderr: writeArtifact(
                      artifactDir,
                      `${runId}-${selectedScenario.id}.recovery.stderr.txt`,
                      recoveryExecuted.stderr,
                    ),
                    missing_reminders: recoveryEvidence?.missingReminders ?? [],
                    forbidden_outcomes_seen: recoveryEvidence?.forbidden ?? [],
                    session_transcripts: recoveryEvidence?.transcriptScan.digests ?? [],
                    operation_receipts: recoveryEvidence?.receipts.map(digestFile) ?? [],
                    policy_decisions: recoveryEvidence?.transcriptScan.policyDecisions ?? null,
                    transcript_scan_error: recoveryEvidence?.transcriptScan.error ?? null,
                    executable_identity_error: recoveryEvidence?.identityError ?? null,
                  }),
                  evidence_capture_error: recoveryCaptureError ?? recoveryEvidence?.captureError ?? null,
                },
              }),
              ...(fixtureCleanup === undefined ? {} : {
                cleanup: {
                  receipt: fixtureCleanup.data,
                  command: commandEvidence('fixture-cleanup', fixtureCleanup.captured),
                },
              }),
              ...(fixtureRetryCleanup === undefined ? {} : {
                retry_cleanup: fixtureRetryCleanup.ok ? {
                  receipt: fixtureRetryCleanup.data,
                  command: commandEvidence('fixture-retry-cleanup', fixtureRetryCleanup.captured),
                } : {
                  error: fixtureRetryCleanup.error,
                  command: commandEvidence('fixture-retry-cleanup', fixtureRetryCleanup.captured),
                },
              }),
            },
          }),
          missing_reminders: missingReminders,
          forbidden_outcomes_seen: forbidden,
          session_transcripts: transcriptScan.digests,
          operation_receipts: receipts.map(digestFile),
          policy_decisions: transcriptScan.policyDecisions,
          transcript_scan_error: transcriptScan.error ?? null,
          evidence_capture_error: captureError ?? null,
          outcome_verification: {
            basis: 'dsh-success-marker',
            external_harness_verification_required: true,
          },
        },
        diagnostic_bundle: diagnostic.identity,
        session_outcome: diagnostic.outcome,
        ...(status === 'pass' ? {} : {
          error: identityError ?? transcriptScan.error ?? captureError ?? {
            code: fixtureCleanup?.ok === false
              ? 'fixture-cleanup-failed'
              : input.phase === 'deliberate-failure' && expectedFailureObserved && !recoveryPass
                ? 'fixture-recovery-failed'
                : input.phase === 'deliberate-failure' && !expectedFailureObserved
              ? 'expected-failure-not-observed'
              : executionCode,
            message: executed.error
              ?? (executed.exit_code !== 0 || executed.signal !== null
                ? 'DSH did not exit successfully'
                : 'DSH did not produce the complete expected observable outcome'),
          },
        }),
      }
      appendRow(outputPath, row)
      results.push(row)
    }
  }

  const counts = {
    pass: results.filter(row => row.status === 'pass').length,
    fail: results.filter(row => row.status === 'fail').length,
    precondition_unmet: results.filter(row => row.status === 'precondition-unmet').length,
  }
  let reportIssueDraft = null
  if (input.reportIssuePath !== undefined && counts.pass !== results.length) {
    const path = resultPath(input.reportIssuePath)
    if (existsSync(path)) throw new DriveError('unsafe-output', 'report issue draft already exists')
    const failures = results.filter(row => row.status !== 'pass')
    const observations = failures.map(row => {
      const outcome = record(row.session_outcome)
      const diagnostic = record(row.diagnostic_bundle)
      return `- \`${String(row.scenario_id)}\`: \`${String(outcome?.code ?? 'unknown')}\` in \`${String(outcome?.component ?? 'session')}\`; receipt \`${String(outcome?.receipt ?? 'unavailable')}\`; bundle \`${String(diagnostic?.name ?? 'unavailable')}\` SHA-256 \`${String(diagnostic?.sha256 ?? 'unavailable')}\`; next: ${String(outcome?.next_action ?? 'inspect the diagnostic bundle')}`
    })
    const body = sanitizeDiagnosticValue([
      '<!-- dsh-runtime-kit.heuristic-issue-draft.v1 -->',
      '# Acceptance harness diagnostic follow-up',
      '',
      'Suggested label: `workflow::heuristic-records`',
      '',
      '## Observed',
      '',
      ...observations,
      '',
      '## Expected',
      '',
      'The harness should complete the selected scenario or expose one typed, actionable failure without human diagnosis hints.',
      '',
      '## Bounded impact',
      '',
      `Affected scenarios: ${failures.map(row => `\`${String(row.scenario_id)}\``).join(', ')}. No broader impact is asserted.`,
      '',
      '## Reproduction',
      '',
      `Run acceptance-drive with run id \`${runId}\` and the same scenario ids, then inspect each referenced diagnostic bundle digest.`,
      '',
      '## Current workaround',
      '',
      'Follow the session outcome next action and rerun the unchanged scenario. Do not weaken policy or edit retained evidence.',
      '',
      '## Actionability',
      '',
      'This is a draft only. A human must verify scope and submit it if the failure is reproducible.',
      '',
    ].join('\n')) as string
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    const identity = digestFile(path)
    reportIssueDraft = { name: basename(identity.path), sha256: identity.sha256, bytes: identity.bytes }
  }
  const summary = {
    schema_version: SUMMARY_SCHEMA,
    run_id: runId,
    status: counts.pass === results.length ? 'pass' : 'fail',
    profile: input.profile,
    run_context: runContext(),
    catalog: {
      path: realpathSync(input.catalogPath),
      sha256: createHash('sha256').update(readFileSync(input.catalogPath)).digest('hex'),
      schema_version: CATALOG_SCHEMA,
    },
    output: outputPath,
    scenario_ids: selected.map(row => row.id),
    counts,
    report_issue_draft: reportIssueDraft,
    ...(scenarioPack === undefined ? {} : {
      scenario_pack: {
        schema_version: scenarioPack.schema_version,
        phase: input.phase,
        case_ids: selected.map(row => `${row.id}.${input.phase}`),
      },
    }),
  }
  appendRow(outputPath, summary)
  return summary
}

function usage() {
  return [
    'Usage: dsh-runtime-kit acceptance-drive --profile <name> --scenario <id> [--scenario <id> ...] [options]',
    '',
    'Required:',
    '  --workdir <absolute path>       one prepared git repo, non-git folder, or managed worktree',
    '  --output <absolute JSONL path>  append result rows; existing evidence is never overwritten',
    '  --dsh-home <absolute path>      DSH home containing the installed profile',
    '  --dsh-bin <absolute path>       trusted DSH executable or wrapper',
    '',
    'Options:',
    '  --catalog <path>                default: packaged compatibility/acceptance-scenarios.json',
    '  --scenario-pack <path>          default: packaged compatibility/acceptance-scenario-pack.json',
    '  --phase <success|deliberate-failure>  run one #D scenario-pack half',
    '  --retry-workdir <absolute path> distinct clean checkout required by Git deliberate-failure rows',
    '  --fixture-bin <absolute path>  authenticated provider override; default: packaged sibling fixture bin',
    '  --artifact-dir <absolute path>  default: <output>.artifacts',
    '  --runtime-kit-bin <path>        default: this dsh-runtime-kit executable',
    '  --package <spec-or-path>        run setup preview/apply first; local paths MUST be built before use',
    '  --run-id <id>                   stable row correlation id',
    '  --report-issue <absolute path>  draft a heuristic issue body for failures; never submits it',
    '  --attest <absolute JSON path>   append one external-harness attestation to --output',
    '  --summarize-pack                append the 66-case #D completion summary to --output',
    '  --timeout-ms <milliseconds>     per command, 100..1800000',
    '',
    'npm pack does not build this package and install-time lifecycle hooks are refused.',
    'For a local package: run npm run build and npm run build:provenance before --package.',
  ].join('\n')
}

export function main(argv: string[] = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        profile: { type: 'string' },
        scenario: { type: 'string', multiple: true },
        workdir: { type: 'string' },
        'retry-workdir': { type: 'string' },
        output: { type: 'string' },
        'dsh-home': { type: 'string' },
        'dsh-bin': { type: 'string' },
        catalog: { type: 'string' },
        'scenario-pack': { type: 'string' },
        phase: { type: 'string' },
        'fixture-bin': { type: 'string' },
        'artifact-dir': { type: 'string' },
        'runtime-kit-bin': { type: 'string' },
        package: { type: 'string' },
        'run-id': { type: 'string' },
        'report-issue': { type: 'string' },
        attest: { type: 'string' },
        'summarize-pack': { type: 'boolean', default: false },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    const supplied = (name: string) => {
      const value = (parsed.values as Record<string, unknown>)[name]
      return typeof value === 'boolean' ? value : value !== undefined
    }
    const rejectUnexpected = (allowed: string[]) => {
      const unexpected = Object.keys(parsed.values).filter(name => supplied(name) && !allowed.includes(name))
      if (unexpected.length > 0) {
        throw new DriveError('invalid-mode', `unexpected option for acceptance-drive mode: --${unexpected[0]}`)
      }
    }
    if (parsed.values.attest !== undefined && parsed.values['summarize-pack']) {
      throw new DriveError('invalid-mode', '--attest and --summarize-pack are mutually exclusive')
    }
    if (parsed.values.attest !== undefined) {
      rejectUnexpected(['output', 'attest'])
      if (parsed.values.output === undefined) throw new DriveError('missing-argument', '--output is required')
      const attestation = appendAcceptanceAttestation({
        outputPath: parsed.values.output,
        attestationPath: parsed.values.attest,
      })
      process.stdout.write(`${JSON.stringify(attestation)}\n`)
      return 0
    }
    if (parsed.values['summarize-pack']) {
      rejectUnexpected(['output', 'catalog', 'scenario-pack', 'summarize-pack'])
      if (parsed.values.output === undefined) throw new DriveError('missing-argument', '--output is required')
      const catalogPath = parsed.values.catalog ?? packageAsset('compatibility', 'acceptance-scenarios.json')
      const catalog = loadAcceptanceCatalog(catalogPath)
      const pack = loadAcceptanceScenarioPack(
        parsed.values['scenario-pack'] ?? packageAsset('compatibility', 'acceptance-scenario-pack.json'),
        catalog,
      )
      const summary = appendAcceptanceScenarioPackSummary({ outputPath: parsed.values.output, pack })
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      return summary.status === 'pass' ? 0 : 1
    }
    if (parsed.values['scenario-pack'] !== undefined && parsed.values.phase === undefined) {
      throw new DriveError('invalid-mode', '--scenario-pack requires --phase')
    }
    if (parsed.values['fixture-bin'] !== undefined && parsed.values.phase === undefined) {
      throw new DriveError('invalid-mode', '--fixture-bin requires --phase')
    }
    if (parsed.values['retry-workdir'] !== undefined && parsed.values.phase === undefined) {
      throw new DriveError('invalid-mode', '--retry-workdir requires --phase')
    }
    const required = ['profile', 'workdir', 'output', 'dsh-home', 'dsh-bin'] as const
    for (const name of required) {
      if (parsed.values[name] === undefined) throw new DriveError('missing-argument', `--${name} is required`)
    }
    const output = parsed.values.output!
    const artifactDir = parsed.values['artifact-dir']
      ?? `${output.replace(/\.jsonl$/u, '')}.artifacts`
    const timeoutMs = parsed.values['timeout-ms'] === undefined
      ? DEFAULT_TIMEOUT_MS
      : Number(parsed.values['timeout-ms'])
    const summary = runAcceptanceDrive({
      profile: parsed.values.profile!,
      scenarioIds: parsed.values.scenario ?? [],
      workdir: parsed.values.workdir!,
      ...(parsed.values['retry-workdir'] === undefined
        ? {}
        : { retryWorkdir: parsed.values['retry-workdir'] }),
      outputPath: output,
      artifactDir,
      dshHome: parsed.values['dsh-home']!,
      dshBin: parsed.values['dsh-bin']!,
      runtimeKitBin: parsed.values['runtime-kit-bin'] ?? realpathSync(process.argv[1]!),
      catalogPath: parsed.values.catalog ?? packageAsset('compatibility', 'acceptance-scenarios.json'),
      timeoutMs,
      ...(parsed.values['run-id'] === undefined ? {} : { runId: parsed.values['run-id'] }),
      ...(parsed.values.package === undefined ? {} : { packageSpec: parsed.values.package }),
      ...(parsed.values['report-issue'] === undefined ? {} : { reportIssuePath: parsed.values['report-issue'] }),
      ...(parsed.values['scenario-pack'] === undefined ? {} : { scenarioPackPath: parsed.values['scenario-pack'] }),
      ...(parsed.values.phase === undefined ? {} : { phase: parsed.values.phase as AcceptanceScenarioPackPhase }),
      ...(parsed.values['fixture-bin'] === undefined ? {} : { fixtureBin: parsed.values['fixture-bin'] }),
    })
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    return summary.status === 'pass' ? 0 : 1
  } catch (error) {
    const normalized = error instanceof DriveError
      ? error
      : error instanceof ScenarioPackError
        ? new DriveError(error.code, error.message)
        : new DriveError('acceptance-drive-failed', error instanceof Error ? error.message : String(error), 70)
    process.stdout.write(`${JSON.stringify({
      schema_version: 'cli.dsh-runtime-kit.acceptance-drive.v1',
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    })}\n`)
    return normalized.exitCode
  }
}
