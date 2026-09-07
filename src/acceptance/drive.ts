import { spawnSync } from 'node:child_process'
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

const CATALOG_SCHEMA = 'dsh-runtime-kit.acceptance-scenarios.v1'
const RESULT_SCHEMA = 'dsh-runtime-kit.acceptance-drive-result.v1'
const SUMMARY_SCHEMA = 'dsh-runtime-kit.acceptance-drive-summary.v1'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/u
const FEATURE_ISSUE_PATTERN = /^#(?:55|56|57|58|59|60|61|62|63|64|65|79|197)$/u
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
  owner: { program_child: '#D' | '#E', feature_issue: string }
  preconditions: string[]
  folder_kind: FolderKind
  task: string
  success_marker: string
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
  outputPath: string
  artifactDir: string
  dshBin: string
  runtimeKitBin: string
  dshHome: string
  timeoutMs?: number
  runId?: string
  packageSpec?: string
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
    || (owner.program_child !== '#D' && owner.program_child !== '#E')
    || typeof owner.feature_issue !== 'string' || !FEATURE_ISSUE_PATTERN.test(owner.feature_issue)
    || (owner.program_child === '#E' && owner.feature_issue !== '#197')
    || (owner.program_child === '#D' && owner.feature_issue === '#197')) {
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
  return {
    id,
    owner: {
      program_child: owner.program_child as '#D' | '#E',
      feature_issue: owner.feature_issue,
    },
    preconditions: stringList(row.preconditions, `scenario ${id} preconditions`, false),
    folder_kind: row.folder_kind as FolderKind,
    task,
    success_marker: successMarker,
    expected_observable_outcome: boundedString(
      row.expected_observable_outcome,
      `scenario ${id} expected_observable_outcome`,
      4096,
    ),
    expected_reminders: stringList(row.expected_reminders, `scenario ${id} expected_reminders`),
    forbidden_outcomes: stringList(row.forbidden_outcomes, `scenario ${id} forbidden_outcomes`),
  }
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
  safeRegularFile(canonical, label)
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
  const argv = [executablePath, ...args]
  const result = spawnSync(executablePath, args, {
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

function scanTranscripts(
  transcripts: string[],
  expectedReminders: string[],
  forbiddenOutcomes: string[],
): TranscriptScan {
  const actions = new Set<string>()
  const ruleIds = new Set<string>()
  const reminders = new Set<string>()
  const forbidden = new Set<string>()
  const digests: ReturnType<typeof digestFile>[] = []
  let compressedBytes = 0
  let decompressedBytes = 0
  for (const path of transcripts) {
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
        if (!observedTranscriptRecord(value)) continue
        for (const marker of expectedReminders) if (line.includes(marker)) reminders.add(marker)
        for (const marker of forbiddenOutcomes) if (line.includes(marker)) forbidden.add(marker)
        for (const match of line.matchAll(/\bdecision\.(allow|block|context|warn|transform)\b/gu)) {
          actions.add(match[1]!)
        }
        for (const match of line.matchAll(/\bdsh\.[a-z0-9][a-z0-9-]{0,63}\b/gu)) {
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
  }
}

function artifactName(runId: string, scenarioId: string, stream: 'stdout' | 'stderr') {
  const safeRun = runId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  const safeScenario = scenarioId.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
  return `${safeRun}-${safeScenario}.${stream}.txt`
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
  const normalized = { ...input, timeoutMs, workdir, dshHome, outputPath, artifactDir, dshBin, runtimeKitBin }
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
    package_setup: setupEvidence,
    doctor: doctorEvidence,
  })

  const emitSharedFailure = (
    stage: string,
    error: { code: string, message: string },
    captured?: CapturedCommand,
  ) => {
    for (const selectedScenario of selected) {
      const row = preconditionRow(normalized, selectedScenario, runId, stage, error, captured)
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
        const row = preconditionRow(normalized, selectedScenario, runId, 'scenario-precondition', {
          code: 'folder-kind-mismatch',
          message: `scenario requires ${selectedScenario.folder_kind}; workdir is ${actualFolderKind}`,
        })
        appendRow(outputPath, row)
        results.push(row)
        continue
      }
      const startedAt = new Date()
      let before
      try {
        before = snapshotEvidence(workdir, dshHome)
      } catch (error) {
        const normalizedError = error instanceof DriveError
          ? error
          : new DriveError('evidence-scan-failed', error instanceof Error ? error.message : String(error))
        const row = preconditionRow(normalized, selectedScenario, runId, 'scenario-precondition', {
          code: normalizedError.code,
          message: normalizedError.message,
        })
        appendRow(outputPath, row)
        results.push(row)
        continue
      }
      const executed = command(
        dshBin,
        ['--profile', input.profile, selectedScenario.task],
        workdir,
        dshHome,
        timeoutMs,
      )
      let changed: string[] = []
      let captureError: { code: string, message: string } | undefined
      try {
        changed = changedEvidence(before)
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
        selectedScenario.expected_reminders,
        selectedScenario.forbidden_outcomes.filter(marker => marker !== 'silent-stop'),
      )
      const commandOutput = executed.stdout + '\n' + executed.stderr
      const missingReminders = transcriptScan.missingReminders
      const forbidden = [...new Set([
        ...selectedScenario.forbidden_outcomes.filter(marker => (
          marker === 'silent-stop'
            ? executed.stdout.trim().length === 0
            : commandOutput.includes(marker)
        )),
        ...transcriptScan.forbiddenOutcomes,
      ])].sort()
      const markerSeen = executed.stdout.includes(selectedScenario.success_marker)
      let identityError: { code: string, message: string } | undefined
      try {
        if (!sameFileIdentity(dshIdentity, fileIdentity(dshBin))
          || !sameFileIdentity(runtimeKitIdentity, fileIdentity(runtimeKitBin))) {
          identityError = {
            code: 'executable-identity-changed',
            message: 'the DSH or runtime-kit executable identity changed during the run',
          }
        }
      } catch (error) {
        identityError = {
          code: 'executable-identity-changed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      const status = executed.exit_code === 0 && executed.signal === null && markerSeen
        && missingReminders.length === 0 && forbidden.length === 0
        && captureError === undefined && transcriptScan.error === undefined
        && identityError === undefined ? 'pass' : 'fail'
      const stdout = writeArtifact(artifactDir, artifactName(runId, selectedScenario.id, 'stdout'), executed.stdout)
      const stderr = writeArtifact(artifactDir, artifactName(runId, selectedScenario.id, 'stderr'), executed.stderr)
      const finishedAt = new Date()
      const row = {
        schema_version: RESULT_SCHEMA,
        run_id: runId,
        scenario_id: selectedScenario.id,
        owner: selectedScenario.owner,
        profile: input.profile,
        folder_kind: selectedScenario.folder_kind,
        workdir,
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
          success_marker: selectedScenario.success_marker,
        },
        observed: {
          command: { argv: executed.argv, cwd: executed.cwd },
          exit_code: executed.exit_code,
          signal: executed.signal,
          stdout,
          stderr,
          success_marker_seen: markerSeen,
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
        ...(status === 'pass' ? {} : {
          error: identityError ?? transcriptScan.error ?? captureError ?? {
            code: executed.error !== undefined || executed.exit_code !== 0 || executed.signal !== null
              ? 'scenario-execution-failed'
              : 'scenario-outcome-mismatch',
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
    '  --artifact-dir <absolute path>  default: <output>.artifacts',
    '  --runtime-kit-bin <path>        default: this dsh-runtime-kit executable',
    '  --package <spec-or-path>        run setup preview/apply first; local paths MUST be built before use',
    '  --run-id <id>                   stable row correlation id',
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
        output: { type: 'string' },
        'dsh-home': { type: 'string' },
        'dsh-bin': { type: 'string' },
        catalog: { type: 'string' },
        'artifact-dir': { type: 'string' },
        'runtime-kit-bin': { type: 'string' },
        package: { type: 'string' },
        'run-id': { type: 'string' },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
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
      outputPath: output,
      artifactDir,
      dshHome: parsed.values['dsh-home']!,
      dshBin: parsed.values['dsh-bin']!,
      runtimeKitBin: parsed.values['runtime-kit-bin'] ?? realpathSync(process.argv[1]!),
      catalogPath: parsed.values.catalog ?? packageAsset('compatibility', 'acceptance-scenarios.json'),
      timeoutMs,
      ...(parsed.values['run-id'] === undefined ? {} : { runId: parsed.values['run-id'] }),
      ...(parsed.values.package === undefined ? {} : { packageSpec: parsed.values.package }),
    })
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    return summary.status === 'pass' ? 0 : 1
  } catch (error) {
    const normalized = error instanceof DriveError
      ? error
      : new DriveError('acceptance-drive-failed', error instanceof Error ? error.message : String(error), 70)
    process.stdout.write(`${JSON.stringify({
      schema_version: 'cli.dsh-runtime-kit.acceptance-drive.v1',
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    })}\n`)
    return normalized.exitCode
  }
}
