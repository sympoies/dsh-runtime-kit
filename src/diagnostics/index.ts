import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'

import { readActivation, resolveActivationRoot } from '../activation/index.js'
import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { packageAsset } from '../package-root.js'

export const DIAGNOSTIC_BUNDLE_SCHEMA = 'dsh-runtime-kit.diagnostic-bundle.v1'
export const DIAGNOSTIC_MANIFEST_SCHEMA = 'dsh-runtime-kit.diagnostic-bundle-manifest.v1'
export const SESSION_OUTCOME_SCHEMA = 'dsh-runtime-kit.session-outcome.v1'

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_TRACE_ROWS = 20
const MAX_SESSION_FILES = 512
const MAX_SESSION_NODES = 4096
const MAX_SESSION_SCAN_BYTES = 32 * 1024 * 1024
const MAX_ZSTD_FRAMES = 16_384
const MAX_DIAGNOSTIC_NODES = 8192
const MAX_DIAGNOSTIC_DEPTH = 32
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/iu
const ABSOLUTE_PATH = /(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|]*/gmu
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+[^\s,;]+/giu
const RUNTIME_HEALTH_COMMAND_CODES = new Set([
  'DSH_RUNTIME_HEALTH_AGENT_HOOK_INVALID',
  'DSH_RUNTIME_HEALTH_AGENT_HOOK_UNAVAILABLE',
  'DSH_RUNTIME_HEALTH_CAPABILITY_UNKNOWN',
  'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED',
  'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID',
  'DSH_RUNTIME_HEALTH_COMPANION_OUTPUT_INVALID',
  'DSH_RUNTIME_HEALTH_COMPANION_QUIESCENCE_UNKNOWN',
  'DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE',
  'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID',
  'DSH_RUNTIME_HEALTH_DISPOSED',
  'DSH_RUNTIME_HEALTH_DSH_IDENTITY_INVALID',
  'DSH_RUNTIME_HEALTH_EXECUTION_BINDING_INVALID',
  'DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED',
  'DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING',
  'DSH_RUNTIME_HEALTH_PROBE_FAILED',
  'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT',
  'DSH_RUNTIME_HEALTH_PROBING',
  'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID',
  'DSH_RUNTIME_HEALTH_PROJECT_INVALID',
  'DSH_RUNTIME_HEALTH_PROJECT_UNAVAILABLE',
  'DSH_RUNTIME_HEALTH_PROVIDER_REMOVED',
  'DSH_RUNTIME_HEALTH_SCOPE_UNAVAILABLE',
  'DSH_RUNTIME_HEALTH_UNPROBED',
])

type JsonRecord = Record<string, unknown>

type TypedSessionError = {
  code: string
  name?: string
  event: string
  details?: Record<string, string>
}

export type SessionOutcome = {
  schema_version: typeof SESSION_OUTCOME_SCHEMA
  status: 'completed' | 'failed' | 'unavailable'
  category: 'success' | 'tool-denial' | 'health-failure' | 'provider-failure'
    | 'finish-line-stop' | 'operations-failure' | 'unknown'
  code: string
  component: 'session' | 'policy' | 'runtime-health' | 'provider' | 'finish-line' | 'operations'
  receipt: string | null
  next_action: string
}

export type OutcomeObservation = {
  exit_code?: number | null
  error_code?: string
  error_receipt?: string
  error_component?: 'operations' | 'provider' | 'runtime-health' | 'session'
  policy_code?: string
  doctor_status?: string
  doctor_code?: string
  policy_decisions?: Array<{ action?: string, rule_ids?: string[] }>
  finish_line?: { code?: string }
}

export type DiagnosticBundle = JsonRecord & {
  schema_version: typeof DIAGNOSTIC_BUNDLE_SCHEMA
  generated_at: string
  profile: string
  status: string
  session_outcome: SessionOutcome
}

class DiagnosticError extends Error {
  code: string
  exitCode: number

  constructor(code: string, message: string, exitCode: number = 64) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function logicalCode(value: unknown, fallback: string) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
    ? value
    : fallback
}

export function classifySessionOutcome(observation: OutcomeObservation): SessionOutcome {
  const decisions = observation.policy_decisions ?? []
  if (observation.doctor_status !== undefined
    && observation.doctor_status !== 'healthy'
    && observation.doctor_status !== 'unavailable') {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'health-failure',
      code: logicalCode(observation.doctor_code, 'profile-unhealthy'),
      component: 'runtime-health',
      receipt: 'doctor',
      next_action: 'Repair the unhealthy companion or activation reported by doctor, then rerun doctor before retrying the task.',
    }
  }
  if (observation.error_code === 'WORKSPACE_FOREIGN_ACTIVE') {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'tool-denial',
      code: observation.error_code,
      component: 'policy',
      receipt: observation.error_receipt ?? 'session.typed_errors[0]',
      next_action: 'Wait for or release the authenticated owning session, then retry the unchanged task in the same workspace.',
    }
  }
  if (observation.finish_line !== undefined) {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'finish-line-stop',
      code: logicalCode(observation.finish_line.code, 'finish-line-refused'),
      component: 'finish-line',
      receipt: 'session.finish_line',
      next_action: 'Complete the exact outstanding acceptance evidence reported by the finish line and retry completion.',
    }
  }
  const blockedIndex = decisions.findIndex(row => row.action === 'block')
  const blocked = blockedIndex < 0 ? undefined : decisions[blockedIndex]
  const policyOutcome = (): SessionOutcome | undefined => {
    if (blocked === undefined && observation.policy_code === undefined) return undefined
    const selectedRule = observation.policy_code ?? blocked?.rule_ids?.[0]
    const denialCode = logicalCode(selectedRule, 'policy-denied')
    const dirtyAnchor = /checkout|dirty|workspace|lease/iu.test(denialCode)
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'tool-denial',
      code: denialCode,
      component: 'policy',
      receipt: blocked === undefined
        ? observation.error_receipt ?? 'session.typed_errors[0]'
        : `policy.decisions[${blockedIndex}]`,
      next_action: dirtyAnchor
        ? 'Preserve user changes, clean the intended anchor or move the task to an owned managed worktree, then retry.'
        : 'Inspect the named policy rule and the denied operation; change authority or inputs, not the policy record.',
    }
  }
  const explicitCode = logicalCode(observation.error_code, observation.exit_code === 0 ? 'completed' : 'session-failed')
  if (observation.error_component === 'runtime-health'
    && RUNTIME_HEALTH_COMMAND_CODES.has(explicitCode)) {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'health-failure',
      code: explicitCode,
      component: 'runtime-health',
      receipt: observation.error_receipt ?? 'command.stderr',
      next_action: 'Restore the authenticated runtime companion or activation input, rerun doctor, then retry the unchanged task.',
    }
  }
  if (observation.policy_code !== undefined) {
    const exactPolicyOutcome = policyOutcome()
    if (exactPolicyOutcome !== undefined) return exactPolicyOutcome
  }
  if (explicitCode === 'WORKSPACE_DIRTY') {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'tool-denial',
      code: explicitCode,
      component: 'policy',
      receipt: observation.error_receipt ?? 'session.typed_errors[0]',
      next_action: 'Preserve user changes, clean the intended anchor or move the task to an owned managed worktree, then retry.',
    }
  }
  if (observation.error_component === 'operations'
    || /plan|digest|operation|rollback|install|package|drift/iu.test(explicitCode)) {
    const stateUnavailable = /lock|state|command-unavailable/iu.test(explicitCode)
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'operations-failure',
      code: explicitCode,
      component: 'operations',
      receipt: observation.error_receipt ?? 'operation_receipts.state',
      next_action: stateUnavailable
        ? 'Restore the trusted lifecycle executable or owner-writable operations state, then regenerate the plan before retrying.'
        : 'Regenerate the reviewed lifecycle plan from current state and apply only its exact digest.',
    }
  }
  const code = explicitCode
  if (observation.error_component === 'provider'
    || /provider|model|quota|rate-limit|unavailable|authentication|credential/iu.test(code)) {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'failed',
      category: 'provider-failure',
      code,
      component: 'provider',
      receipt: observation.error_receipt ?? 'session.typed_errors[0]',
      next_action: 'Restore provider availability or credentials outside the evidence bundle, then retry the unchanged task.',
    }
  }
  const genericPolicyOutcome = policyOutcome()
  if (genericPolicyOutcome !== undefined) return genericPolicyOutcome
  if (observation.exit_code === 0 && observation.error_code === undefined) {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'completed',
      category: 'success',
      code: 'completed',
      component: 'session',
      receipt: 'session.latest',
      next_action: 'No diagnostic action is required.',
    }
  }
  if (observation.exit_code === undefined && observation.error_code === undefined) {
    return {
      schema_version: SESSION_OUTCOME_SCHEMA,
      status: 'unavailable',
      category: 'unknown',
      code: 'session-outcome-unavailable',
      component: 'session',
      receipt: null,
      next_action: 'Run the task through DSH or acceptance-drive, then rerun diagnose to bind a session outcome.',
    }
  }
  return {
    schema_version: SESSION_OUTCOME_SCHEMA,
    status: 'failed',
    category: 'unknown',
    code,
    component: 'session',
    receipt: 'session.latest',
    next_action: 'Inspect the bounded typed errors and command exit in this diagnostic bundle before retrying.',
  }
}

export function runtimeHealthCodeFromCommandOutput(output: string) {
  if (typeof output !== 'string' || output.length === 0 || output.length > 2 * MAX_TEXT_BYTES) return undefined
  const matches = [...output.matchAll(/(?:^|\n)HealthProbeFailure:\s*(DSH_RUNTIME_HEALTH_[A-Z0-9_]+)(?:\r?\n|$)/gu)]
    .map(match => match[1]!)
    .filter(code => RUNTIME_HEALTH_COMMAND_CODES.has(code))
  const unique = [...new Set(matches)]
  return unique.length === 1 ? unique[0] : undefined
}

function sanitizedString(value: string) {
  return value
    .replaceAll(SECRET_VALUE, '[REDACTED]')
    .replaceAll(ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<absolute-path>`)
}

export function sanitizeDiagnosticValue(value: unknown, key: string = ''): unknown {
  const budget = { nodes: 0 }
  const visit = (item: unknown, itemKey: string, depth: number): unknown => {
    budget.nodes += 1
    if (budget.nodes > MAX_DIAGNOSTIC_NODES || depth > MAX_DIAGNOSTIC_DEPTH) return '[TRUNCATED]'
    if (SECRET_KEY.test(itemKey)) return '[REDACTED]'
    if (typeof item === 'string') return sanitizedString(item)
    if (Array.isArray(item)) return item.slice(0, 512).map(child => visit(child, '', depth + 1))
    const row = record(item)
    if (row !== undefined) {
      return Object.fromEntries(Object.entries(row).slice(0, 512)
        .map(([name, child]) => [name, visit(child, name, depth + 1)]))
    }
    return item
  }
  return visit(value, key, 0)
}

function within(root: string, child: string) {
  const fragment = relative(root, child)
  return fragment === '' || (!fragment.startsWith(`..${sep}`) && fragment !== '..' && !isAbsolute(fragment))
}

function ownerOnlyDirectory(path: string, create: boolean = false) {
  if (!isAbsolute(path) || path.includes('\0')) throw new DiagnosticError('invalid-path', 'bundle must be an absolute path')
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0) {
    throw new DiagnosticError('unsafe-bundle', 'bundle must be an owner-only real directory')
  }
  return realpathSync(path)
}

function writeJson(path: string, value: unknown) {
  const rendered = `${JSON.stringify(sanitizeDiagnosticValue(value), undefined, 2)}\n`
  writeFileSync(path, rendered, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return { name: basename(path), sha256: sha256(rendered), bytes: Buffer.byteLength(rendered) }
}

export function writeDiagnosticBundle(destination: string, bundle: DiagnosticBundle) {
  const root = ownerOnlyDirectory(destination)
  const diagnosticPath = join(root, 'diagnostic.json')
  const outcomePath = join(root, 'session-outcome.json')
  if (!within(root, diagnosticPath) || !within(root, outcomePath)) {
    throw new DiagnosticError('unsafe-bundle', 'bundle output escapes its root')
  }
  const files = [writeJson(diagnosticPath, bundle), writeJson(outcomePath, bundle.session_outcome)]
  const manifest = {
    schema_version: DIAGNOSTIC_MANIFEST_SCHEMA,
    files,
  }
  writeJson(join(root, 'manifest.json'), manifest)
  return manifest
}

type Captured = { exit_code: number | null, stdout: string, stderr: string, error?: string }

function command(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Captured {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_TEXT_BYTES,
    killSignal: 'SIGTERM',
  })
  return {
    exit_code: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    ...(result.error === undefined ? {} : { error: result.error.message }),
  }
}

function parsedLastJson(output: string) {
  try {
    const whole = record(JSON.parse(output))
    if (whole !== undefined) return whole
  } catch {}
  const lines = output.trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return record(JSON.parse(lines[index]!)) } catch {}
  }
  return undefined
}

function parsedComposition(output: string) {
  const json = parsedLastJson(output)
  if (json !== undefined) return json
  try {
    const value = parseYaml(output.replaceAll(/!!js(?=\s)/gu, ''))
    return value === null || value === undefined ? undefined : value
  } catch { return undefined }
}

function safeReadJson(path: string) {
  try {
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_TEXT_BYTES) return undefined
    return record(JSON.parse(readFileSync(path, 'utf8')))
  } catch { return undefined }
}

function projectOperationState(state: JsonRecord | undefined) {
  if (state === undefined) return { status: 'unavailable', receipt: 'operation_receipts.state' }
  const current = record(state.current)
  const previous = record(state.previous)
  const pending = record(state.pending)
  const lastApplied = record(state.last_applied)
  const target = record(current?.target)
  const priorTarget = record(previous?.target)
  return sanitizeDiagnosticValue({
    status: 'available',
    receipt: 'operation_receipts.state',
    schema_version: state.schema_version,
    profile: state.profile,
    current: current === undefined ? null : {
      package_version: target?.expected_version ?? current.installed_version,
      package_artifact_sha256: target?.artifact_sha256,
      package_installed_sha256: target?.installed_sha256 ?? current.installed_digest,
    },
    previous: previous === undefined ? null : {
      package_version: priorTarget?.expected_version ?? previous.installed_version,
      package_artifact_sha256: priorTarget?.artifact_sha256,
      package_installed_sha256: priorTarget?.installed_sha256 ?? previous.installed_digest,
    },
    pending: pending === undefined ? null : {
      operation: pending.operation,
      phase: pending.phase,
      plan_digest: pending.plan_digest,
    },
    last_applied: lastApplied === undefined ? null : {
      operation: lastApplied.operation,
      plan_digest: lastApplied.plan_digest,
      completed_at: lastApplied.completed_at,
      recovered: lastApplied.recovered === true,
    },
  })
}

function runtimeRootFromState(state: JsonRecord | undefined) {
  for (const candidate of [record(state?.current), record(state?.pending), record(state?.previous)]) {
    if (typeof candidate?.runtime_root === 'string' && isAbsolute(candidate.runtime_root)) return candidate.runtime_root
    const plan = record(candidate?.plan)
    if (typeof plan?.runtime_root === 'string' && isAbsolute(plan.runtime_root)) return plan.runtime_root
  }
  const lastPlan = record(record(state?.last_applied)?.plan)
  return typeof lastPlan?.runtime_root === 'string' && isAbsolute(lastPlan.runtime_root) ? lastPlan.runtime_root : undefined
}

function profileTree(value: unknown, depth: number = 0, budget: { nodes: number } = { nodes: 0 }): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_DIAGNOSTIC_NODES || depth > MAX_DIAGNOSTIC_DEPTH) return { kind: 'truncated' }
  if (Array.isArray(value)) return {
    kind: 'array',
    length: value.length,
    items: value.slice(0, 512).map(item => profileTree(item, depth + 1, budget)),
  }
  const row = record(value)
  if (row !== undefined) return Object.fromEntries(Object.keys(row).sort().slice(0, 512)
    .map(key => [key, profileTree(row[key], depth + 1, budget)]))
  if (value === null) return { kind: 'null' }
  return { kind: typeof value }
}

function traceDecisions(
  runtimeRoot: string | undefined,
  sessionWindow?: { started_at_ms: number, finished_at_ms: number },
) {
  if (runtimeRoot === undefined) return { source: 'unavailable', rows: [] }
  try {
    const activation = readActivation(resolveActivationRoot(runtimeRoot))
    const path = join(activation.environment.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR, 'trace.jsonl')
    if (!existsSync(path)) return { source: 'agent-hook-trace', rows: [] }
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_TEXT_BYTES) {
      return { source: 'unavailable', rows: [], error: 'agent-hook-trace-invalid' }
    }
    const rows: JsonRecord[] = []
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        const value = record(JSON.parse(line))
        if (value?.schema_version !== 'agent-hook.trace.v1') continue
        const instant = Date.parse(String(value.recorded_at))
        if (sessionWindow !== undefined && (!Number.isFinite(instant)
          || instant < sessionWindow.started_at_ms - 5_000
          || instant > sessionWindow.finished_at_ms + 5_000)) continue
        rows.push({
          recorded_at: value.recorded_at,
          product: value.product,
          event: value.event,
          action: value.action,
          rule_ids: value.rule_ids,
          shadow_rule_ids: value.shadow_rule_ids,
          config_digest: value.config_digest,
          policy_digest: value.policy_digest,
          recovery_applied: value.recovery_applied,
        })
        if (rows.length > MAX_TRACE_ROWS) rows.shift()
      } catch {}
    }
    return {
      source: 'agent-hook-trace',
      correlation: sessionWindow === undefined ? 'unavailable' : 'latest-session',
      rows: sanitizeDiagnosticValue(rows),
    }
  } catch (error) {
    return { source: 'unavailable', rows: [], error: sanitizedString(error instanceof Error ? error.message : String(error)) }
  }
}

function policyRules(runtimeRoot: string | undefined, environment: NodeJS.ProcessEnv, cwd: string) {
  if (runtimeRoot === undefined) return { source: 'unavailable', rows: [] }
  try {
    const activation = readActivation(resolveActivationRoot(runtimeRoot))
    const runtime = resolveAgentHookRuntime({
      agentHook: environment.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook',
      agentHookConfig: activation.environment.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG,
      agentHookPolicy: activation.environment.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY,
      agentHookStateDir: activation.environment.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR,
    })
    const [bin, ...args] = runtime.argv(['inventory', '--format', 'json'])
    const result = command(bin!, args, cwd, environment)
    const envelope = parsedLastJson(result.stdout)
    const data = record(envelope?.data)
    if (result.exit_code !== 0 || !Array.isArray(data?.rules)) {
      return { source: 'unavailable', rows: [], error: 'agent-hook-inventory-unavailable' }
    }
    const allRules = data.rules.flatMap(value => {
      const row = record(value)
      const effective = record(row?.effective_modes)
      if (typeof row?.id !== 'string') return []
      return [{ id: row.id, tier: row.tier, override_class: row.override_class, effective_mode: effective?.dsh }]
    })
    const rows = allRules.slice(0, 512)
    return { source: 'agent-hook-inventory', rows: sanitizeDiagnosticValue(rows), total: allRules.length, truncated: allRules.length > rows.length }
  } catch (error) {
    return { source: 'unavailable', rows: [], error: sanitizedString(error instanceof Error ? error.message : String(error)) }
  }
}

function concatenatedZstd(bytes: Buffer) {
  const chunks: Buffer[] = []
  let offset = 0
  let output = 0
  let frames = 0
  while (offset < bytes.byteLength) {
    frames += 1
    if (frames > MAX_ZSTD_FRAMES || output >= MAX_TEXT_BYTES) throw new Error('session transcript exceeds bounds')
    const decoded = zstdDecompressSync(bytes.subarray(offset), {
      info: true,
      maxOutputLength: MAX_TEXT_BYTES - output,
    } as never) as unknown as { buffer: Buffer, engine: { bytesWritten: number } }
    if (!Number.isSafeInteger(decoded.engine.bytesWritten) || decoded.engine.bytesWritten <= 0) throw new Error('invalid zstd frame')
    offset += decoded.engine.bytesWritten
    output += decoded.buffer.byteLength
    chunks.push(decoded.buffer)
  }
  return Buffer.concat(chunks, output)
}

const OWNED_TOOL_RESULT_SCHEMAS = new Set([
  'cli.dsh-runtime-kit.operations.v1',
  'cli.dsh-runtime-kit.acceptance-drive.v1',
  'cli.dsh-runtime-kit.acceptance-fixture.v1',
  'cli.dsh-runtime-kit.diagnose.v1',
])

function digestDetails(value: unknown) {
  const details = record(value)
  if (details === undefined) return undefined
  const projected = Object.fromEntries(Object.entries(details).flatMap(([key, item]) => (
    /(?:digest|sha256)$/u.test(key) && typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)
      ? [[key, item]]
      : []
  )))
  return Object.keys(projected).length === 0 ? undefined : projected
}

function ownedToolResultErrors(
  message: unknown,
  event: string,
  allowSandboxDenial: boolean = false,
): TypedSessionError[] {
  const content = record(message)?.content
  if (!Array.isArray(content)) return []
  const errors: TypedSessionError[] = []
  for (const item of content) {
    const toolResult = record(item)
    if (toolResult?.type !== 'tool-result' || !Array.isArray(toolResult.content)) continue
    for (const nested of toolResult.content) {
      const text = record(nested)
      if (text?.type !== 'text' || typeof text.text !== 'string' || Buffer.byteLength(text.text) > MAX_TEXT_BYTES) continue
      for (const line of text.text.split('\n')) {
        let envelope: JsonRecord | undefined
        try { envelope = record(JSON.parse(line)) } catch { continue }
        if (!OWNED_TOOL_RESULT_SCHEMAS.has(String(envelope?.schema_version)) || envelope?.ok !== false) continue
        const error = record(envelope.error)
        if (typeof error?.code !== 'string') continue
        const details = digestDetails(error.details)
        errors.push({
          code: logicalCode(error.code, 'session-error'),
          event: `${event}:${String(envelope.schema_version)}`,
          ...(details === undefined ? {} : { details }),
        })
      }
      for (const match of text.text.matchAll(/\bagent-hook:([a-z0-9][a-z0-9.-]{0,127})\b/giu)) {
        const observed = match[1]!.toLowerCase()
        errors.push({
          code: observed === 'blocked' ? 'policy-denied' : observed.startsWith('dsh.') ? observed : `dsh.${observed}`,
          event: `${event}:agent-hook`,
        })
      }
      if (allowSandboxDenial
        && /(?:^|\n)\[sandbox: file access denied under (?:read-only|workspace-write) mode\](?:\n|$)/u.test(text.text)) {
        errors.push({
          code: 'sandbox-file-access-denied',
          event: `${event}:sandbox-policy`,
        })
      }
    }
  }
  return errors
}

function sessionFiles(roots: string[]) {
  const files: Array<{ path: string, mtimeMs: number, size: number }> = []
  let nodes = 0
  const visit = (directory: string, depth: number) => {
    if (files.length >= MAX_SESSION_FILES || nodes >= MAX_SESSION_NODES || depth > MAX_DIAGNOSTIC_DEPTH) return
    let names: string[]
    try { names = readdirSync(directory) } catch { return }
    for (const name of names) {
      nodes += 1
      if (nodes > MAX_SESSION_NODES) return
      const path = join(directory, name)
      let metadata
      try { metadata = lstatSync(path) } catch { continue }
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) visit(path, depth + 1)
      else if (metadata.isFile() && /\.jsonl(?:\.gz|\.zstd)?$/u.test(name)) {
        files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size })
      }
      if (files.length >= MAX_SESSION_FILES) return
    }
  }
  for (const root of roots) visit(root, 0)
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function readSessionTranscript(path: string, maxInputBytes: number) {
  const descriptor = openSync(path, 'r')
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size < 0 || metadata.size > maxInputBytes) {
      throw new Error('session transcript input exceeds bounds')
    }
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.byteLength || readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new Error('session transcript changed during collection')
    }
    const decoded = path.endsWith('.zstd')
      ? concatenatedZstd(bytes)
      : path.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength: MAX_TEXT_BYTES }) : bytes
    if (decoded.byteLength > MAX_TEXT_BYTES) throw new Error('session transcript exceeds bounds')
    return { bytes, decoded }
  } finally {
    closeSync(descriptor)
  }
}

function transcriptWorkdir(decoded: Buffer) {
  for (const line of decoded.toString('utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      const row = record(JSON.parse(line))
      if (row?.type === 'session' && typeof row.cwd === 'string' && isAbsolute(row.cwd)) return resolve(row.cwd)
    } catch {}
  }
  return undefined
}

function latestSession(
  dshHome: string,
  workdir: string,
  sessionWindow?: { started_at_ms: number, finished_at_ms: number },
) {
  const candidates = sessionFiles([
    join(dshHome, 'sessions'),
    join(workdir, '.dsh', 'sessions'),
    join(workdir, '.sessions'),
  ])
  const targetWorkdir = resolve(workdir)
  let scannedBytes = 0
  let selected: { bytes: Buffer, decoded: Buffer } | undefined
  let budgetExceeded = false
  for (const latest of candidates) {
    if (sessionWindow !== undefined
      && (latest.mtimeMs < sessionWindow.started_at_ms - 5_000
        || latest.mtimeMs > sessionWindow.finished_at_ms + 5_000)) continue
    const rawLimit = latest.path.endsWith('.jsonl') ? MAX_TEXT_BYTES : MAX_SESSION_SCAN_BYTES
    const remaining = MAX_SESSION_SCAN_BYTES - scannedBytes
    if (latest.size > rawLimit || latest.size > remaining) {
      budgetExceeded = true
      continue
    }
    try {
      const { bytes, decoded } = readSessionTranscript(latest.path, Math.min(rawLimit, remaining))
      scannedBytes += bytes.byteLength + decoded.byteLength
      if (scannedBytes > MAX_SESSION_SCAN_BYTES) {
        budgetExceeded = true
        break
      }
      if (transcriptWorkdir(decoded) === targetWorkdir) {
        selected = { bytes, decoded }
        break
      }
    } catch {}
  }
  if (selected === undefined) return {
    status: 'unavailable',
    receipt: null,
    typed_errors: [],
    finish_line: null,
    ...(budgetExceeded ? { error: 'session-scan-budget-exceeded' } : {}),
  }
  try {
    const { bytes, decoded } = selected
    const typedErrors: TypedSessionError[] = []
    let finishLine: { code: string, event: string } | null = null
    let provider: { provider?: string, model?: string } | null = null
    const runtimeHealth: Array<{ event: string, code?: string, status?: string, component?: string }> = []
    const appendTypedErrors = (values: TypedSessionError[]) => {
      typedErrors.push(...values)
      if (typedErrors.length > 20) typedErrors.splice(0, typedErrors.length - 20)
    }
    const shellCallIds = new Set<string>()
    let startedAt = Number.POSITIVE_INFINITY
    let finishedAt = Number.NEGATIVE_INFINITY
    for (const line of decoded.toString('utf8').split('\n')) {
      if (line.length === 0) continue
      let row
      try { row = record(JSON.parse(line)) } catch { continue }
      const type = typeof row?.type === 'string' ? row.type : 'unknown'
      const data = record(row?.data)
      if (type === 'tool/call' && (data?.name === 'bash' || data?.name === 'shell')
        && typeof data.callId === 'string') {
        shellCallIds.add(data.callId)
      }
      const eventTime = typeof row?.time === 'number'
        ? row.time
        : typeof row?.createdAt === 'number' ? row.createdAt : undefined
      if (eventTime !== undefined && Number.isFinite(eventTime)) {
        startedAt = Math.min(startedAt, eventTime)
        finishedAt = Math.max(finishedAt, eventTime)
      }
      const error = record(data?.error)
      if (typeof error?.code === 'string') {
        appendTypedErrors([{ code: logicalCode(error.code, 'session-error'), ...(typeof error.name === 'string' ? { name: sanitizedString(error.name) } : {}), event: type }])
        if (/finish-line/iu.test(error.code)) {
          finishLine = { code: logicalCode(error.code, 'finish-line-refused'), event: type }
        }
      }
      const terminalError = record(record(data?.reason)?.error)
      if (typeof terminalError?.code === 'string') {
        appendTypedErrors([{
          code: logicalCode(terminalError.code, 'session-error'),
          ...(typeof terminalError.name === 'string' ? { name: sanitizedString(terminalError.name) } : {}),
          event: type,
        }])
      }
      const message = record(data?.message)
      const messageSource = record(message?.source)
      const shellResult = messageSource?.kind === 'tool' && typeof messageSource.callId === 'string'
        && shellCallIds.has(messageSource.callId)
      appendTypedErrors(ownedToolResultErrors(data?.message, type, shellResult))
      if (type.startsWith('finish-line/')) {
        finishLine = { code: logicalCode(data?.code, 'finish-line-refused'), event: type }
      }
      const source = record(data?.source)
      if (type === 'user/message' && source?.kind === 'plugin' && source.plugin === 'dsh-runtime-kit'
        && Array.isArray(data?.content)) {
        for (const item of data.content) {
          const content = record(item)
          if (content?.type !== 'text' || typeof content.text !== 'string') continue
          const match = /^Finish-line blocked:\s*([A-Za-z0-9._-]{1,128});/u.exec(content.text)
          if (match !== null) finishLine = { code: logicalCode(match[1], 'finish-line-refused'), event: type }
        }
      }
      if (type.startsWith('runtime-health/')) {
        runtimeHealth.push({
          event: type,
          ...(typeof data?.code === 'string' ? { code: logicalCode(data.code, 'runtime-health-event') } : {}),
          ...(typeof data?.status === 'string' ? { status: logicalCode(data.status, 'unknown') } : {}),
          ...(typeof data?.component === 'string' ? { component: logicalCode(data.component, 'runtime') } : {}),
        })
        if (runtimeHealth.length > 20) runtimeHealth.shift()
      }
      if (type === 'request/context') {
        provider = {
          ...(typeof data?.provider === 'string' ? { provider: sanitizedString(data.provider) } : {}),
          ...(typeof data?.model === 'string' ? { model: sanitizedString(data.model) } : {}),
        }
      }
    }
    return {
      status: 'available',
      receipt: 'session.latest',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      typed_errors: typedErrors,
      finish_line: finishLine,
      provider,
      runtime_health: runtimeHealth,
      ...(Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? {
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        started_at_ms: startedAt,
        finished_at_ms: finishedAt,
      } : {}),
    }
  } catch (error) {
    return { status: 'unavailable', receipt: 'session.latest', typed_errors: [], finish_line: null, error: sanitizedString(error instanceof Error ? error.message : String(error)) }
  }
}

function executableIdentity(path: string | undefined) {
  if (path === undefined) return { status: 'unavailable' }
  try {
    const exact = realpathSync(path)
    const metadata = statSync(exact)
    if (!metadata.isFile()) return { status: 'unavailable' }
    const bytes = readFileSync(exact)
    return { status: 'available', name: basename(exact), sha256: sha256(bytes), bytes: bytes.byteLength, executable: (metadata.mode & 0o111) !== 0 }
  } catch { return { status: 'unavailable' } }
}

function expectedNilsDigest(name: 'agent-hook' | 'agent-docs') {
  const compatibility = safeReadJson(packageAsset('compatibility', 'nils-cli.json'))
  const release = record(compatibility?.release)
  const primary = record(release?.artifacts)
  const platformKey = process.platform === 'linux' && process.arch === 'x64'
    ? undefined
    : process.platform === 'darwin' && process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : undefined
  const platform = platformKey === undefined ? undefined : record(record(release?.platforms)?.[platformKey])
  const artifacts = platformKey === undefined ? primary : record(platform?.artifacts)
  const artifact = record(artifacts?.[name])
  return typeof artifact?.sha256 === 'string' ? artifact.sha256 : undefined
}

function nilsIdentity(name: 'agent-hook' | 'agent-docs', path: string | undefined) {
  const identity = executableIdentity(path)
  const expected = expectedNilsDigest(name)
  const actual = record(identity)?.sha256
  return {
    ...identity,
    expected_sha256: expected ?? null,
    matches_expected: typeof actual === 'string' && expected !== undefined ? actual === expected : null,
  }
}

/**
 * Logical failure code for the first unhealthy `doctor` check.
 *
 * Exported so the enumerated check set can be asserted directly: a check that
 * `doctor` can fail but this list omits degrades to `doctor-unavailable`, which
 * tells an operator the report could not be produced rather than what is wrong.
 */
export function healthCode(doctor: JsonRecord | undefined, identities: JsonRecord) {
  // `agent_console_tui` belongs in this list: it is the only check that can be
  // the sole failing conjunct in an otherwise healthy profile, so omitting it
  // would classify a reverted TUI repair as `doctor-unavailable` and send the
  // operator after an unrelated companion.
  for (const name of ['agent_hook', 'agent_docs', 'activation', 'dsh', 'lifecycle', 'agent_console_tui']) {
    const part = record(doctor?.[name])
    if (part?.ok === false || typeof part?.error === 'string') {
      if ((name === 'agent_hook' || name === 'agent_docs')
        && record(identities[name])?.matches_expected === false) {
        return 'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID'
      }
      return logicalCode(part.error, `${name.replaceAll('_', '-')}-unhealthy`)
    }
  }
  return undefined
}

export function collectDiagnosticBundle(input: {
  profile: string
  dshHome: string
  workdir: string
  runtimeKitEntry: string
  dshBin: string
  environment?: NodeJS.ProcessEnv
  observation?: OutcomeObservation
  sessionWindow?: { started_at_ms: number, finished_at_ms: number }
  skipDsh?: boolean
  skipCommands?: boolean
}): DiagnosticBundle {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...input.environment, DSH_HOME: input.dshHome }
  const runtimeKitIsScript = /\.(?:c|m)?js$/u.test(input.runtimeKitEntry)
  const doctorResult = input.skipCommands === true
    ? { exit_code: null, stdout: '', stderr: '' }
    : command(
      runtimeKitIsScript ? process.execPath : input.runtimeKitEntry,
      [...(runtimeKitIsScript ? [input.runtimeKitEntry] : []), 'doctor', '--profile', input.profile, '--format', 'json'],
      input.workdir,
      environment,
    )
  const doctorEnvelope = parsedLastJson(doctorResult.stdout)
  const doctor = record(doctorEnvelope?.data)
  const dump = input.skipDsh === true || input.skipCommands === true
    ? { exit_code: null, stdout: '', stderr: '' }
    : command(input.dshBin, ['--profile', input.profile, '--dump-config'], input.workdir, environment)
  const dumpValue = input.skipDsh === true ? undefined : parsedComposition(dump.stdout)
  const statePath = join(input.dshHome, 'runtime-kit', 'state', `${input.profile}.json`)
  const state = safeReadJson(statePath)
  const runtimeRoot = environment.DSH_RUNTIME_KIT_RUNTIME_ROOT ?? runtimeRootFromState(state)
  const identities = {
    runtime_kit: executableIdentity(input.runtimeKitEntry),
    dsh: executableIdentity(input.dshBin),
    agent_hook: nilsIdentity('agent-hook', resolveExecutableMaybe(environment.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook')),
    agent_docs: nilsIdentity('agent-docs', resolveExecutableMaybe(environment.DSH_RUNTIME_KIT_AGENT_DOCS_BIN ?? 'agent-docs')),
  }
  const session = latestSession(input.dshHome, input.workdir, input.sessionWindow)
  const sessionRow = record(session)!
  const decisions = traceDecisions(runtimeRoot,
    typeof sessionRow.started_at_ms === 'number' && typeof sessionRow.finished_at_ms === 'number'
      ? { started_at_ms: sessionRow.started_at_ms, finished_at_ms: sessionRow.finished_at_ms }
      : undefined)
  const agentHookIdentity = record(identities.agent_hook)
  const rules = input.skipCommands === true
    ? { source: 'unavailable', rows: [], error: 'diagnostic-commands-disabled' }
    : agentHookIdentity?.matches_expected !== true
      ? { source: 'unavailable', rows: [], error: 'agent-hook-identity-invalid' }
      : policyRules(runtimeRoot, environment, input.workdir)
  const typed = session.typed_errors.at(-1)
  const suppliedObservation = Object.fromEntries(Object.entries(input.observation ?? {})
    .filter(([, value]) => value !== undefined)) as OutcomeObservation
  const observation: OutcomeObservation = {
    doctor_status: typeof doctor?.status === 'string' ? doctor.status : undefined,
    doctor_code: healthCode(doctor, identities) ?? (doctorResult.exit_code === 0 ? undefined : 'doctor-unavailable'),
    error_code: typed?.code,
    error_receipt: typed === undefined ? undefined : `session.typed_errors[${session.typed_errors.length - 1}]`,
    error_component: typeof typed?.event === 'string' && typed.event.endsWith(':cli.dsh-runtime-kit.operations.v1')
      ? 'operations'
      : undefined,
    finish_line: session.finish_line ?? undefined,
    policy_decisions: decisions.correlation === 'latest-session' && Array.isArray(decisions.rows) ? decisions.rows.map(value => {
      const row = record(value)
      return { action: typeof row?.action === 'string' ? row.action : undefined, rule_ids: Array.isArray(row?.rule_ids) ? row.rule_ids.filter(id => typeof id === 'string') as string[] : [] }
    }) : [],
    policy_code: typeof typed?.event === 'string'
      && (typed.event.endsWith(':agent-hook') || typed.event.endsWith(':sandbox-policy'))
      ? typed.code
      : undefined,
    ...suppliedObservation,
  }
  const outcome = classifySessionOutcome(observation)
  const bundle: DiagnosticBundle = {
    schema_version: DIAGNOSTIC_BUNDLE_SCHEMA,
    generated_at: new Date().toISOString(),
    profile: input.profile,
    status: outcome.status === 'failed' ? 'needs-attention' : outcome.status,
    identities,
    doctor: {
      status: doctorResult.exit_code === 0 && doctor !== undefined ? 'available' : 'unavailable',
      exit_code: doctorResult.exit_code,
      data: doctor ?? null,
      error: doctorResult.error ?? (doctorResult.exit_code === 0 ? null : doctorResult.stderr),
    },
    native_runtime_health: {
      status: typeof doctor?.status === 'string' ? doctor.status : 'unavailable',
      source: 'doctor-and-session-transcript',
      transcript_events: record(session)?.runtime_health ?? [],
    },
    composed_profile_tree: {
      status: dump.exit_code === 0 && dumpValue !== undefined ? 'available' : 'unavailable',
      exit_code: dump.exit_code,
      tree: dumpValue === undefined ? null : profileTree(dumpValue),
    },
    policy: {
      rules,
      decisions,
    },
    operation_receipts: projectOperationState(state),
    session,
    session_outcome: outcome,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dsh_home_configured: input.dshHome.length > 0,
      runtime_root_configured: runtimeRoot !== undefined,
      home_relative_output: input.dshHome.startsWith(homedir() + sep),
    },
    collection: {
      redacted: true,
      maximum_text_bytes: MAX_TEXT_BYTES,
      policy_decision_limit: MAX_TRACE_ROWS,
      session_file_limit: MAX_SESSION_FILES,
    },
  }
  return sanitizeDiagnosticValue(bundle) as DiagnosticBundle
}

function resolveExecutable(value: string) {
  if (isAbsolute(value)) return realpathSync(value)
  for (const directory of (process.env.PATH ?? '').split(sep === '\\' ? ';' : ':')) {
    const candidate = join(directory, value)
    try {
      const metadata = statSync(candidate)
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return realpathSync(candidate)
    } catch {}
  }
  throw new DiagnosticError('executable-not-found', `executable is unavailable: ${value}`, 69)
}

function resolveExecutableMaybe(value: string) {
  try { return resolveExecutable(value) } catch { return undefined }
}

function usage() {
  return [
    'Usage: dsh-runtime-kit diagnose --profile <name> [--format json] [--bundle <absolute-directory>]',
    '',
    `Emits ${DIAGNOSTIC_BUNDLE_SCHEMA}.`,
    'The summary is redacted; bundle files are owner-only and never contain credentials or machine absolute paths.',
  ].join('\n')
}

export function main(argv: string[] = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        profile: { type: 'string' },
        format: { type: 'string', default: 'json' },
        bundle: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    if (parsed.positionals.length > 0) throw new DiagnosticError('unexpected-argument', 'diagnose accepts only named options')
    if (parsed.values.format !== 'json') throw new DiagnosticError('invalid-format', '--format must be json')
    if (parsed.values.profile === undefined || !PROFILE_PATTERN.test(parsed.values.profile)) {
      throw new DiagnosticError('invalid-profile', '--profile is required and must be a valid profile name')
    }
    const dshHome = process.env.DSH_HOME
    if (dshHome === undefined || !isAbsolute(dshHome)) throw new DiagnosticError('missing-dsh-home', 'DSH_HOME must be an absolute path')
    const runtimeKitEntry = resolve(process.argv[1] ?? '')
    const dshBin = resolveExecutable(process.env.DSH_RUNTIME_KIT_DSH_BIN ?? 'dsh')
    const bundle = collectDiagnosticBundle({
      profile: parsed.values.profile,
      dshHome: resolve(dshHome),
      workdir: process.cwd(),
      runtimeKitEntry,
      dshBin,
    })
    const output = parsed.values.bundle === undefined ? undefined : writeDiagnosticBundle(ownerOnlyDirectory(parsed.values.bundle, true), bundle)
    const rendered = output === undefined ? bundle : { ...bundle, bundle_manifest: output }
    process.stdout.write(`${JSON.stringify(rendered)}\n`)
    return bundle.session_outcome.status === 'failed' ? 1 : 0
  } catch (error) {
    const normalized = error instanceof DiagnosticError
      ? error
      : new DiagnosticError('diagnose-failed', error instanceof Error ? error.message : String(error), 1)
    const envelope = {
      schema_version: 'cli.dsh-runtime-kit.diagnose.v1',
      ok: false,
      error: { code: normalized.code, message: sanitizedString(normalized.message) },
    }
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    return normalized.exitCode
  }
}
