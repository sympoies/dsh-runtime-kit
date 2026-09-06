import { createHash } from 'node:crypto'

import { resolveAgentHookRuntime, requiredAbsolutePath } from '../nils/agent-hook-runtime.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import {
  authenticatedNilsEnvironment,
  isolatedNilsEnvironment,
  resolveManagedSessionPrincipal,
} from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

export { selectManagedSessionEnvironment } from '../nils/session-environment.js'

export type Context = import('@deepseek-ai/cordis').Context
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle
export type ToolExecution = import('@deepseek-ai/dsh-tools').ToolExecution

const MAX_POLICY_OUTPUT_BYTES = 64 * 1024
const MAX_POLICY_ERROR_BYTES = 8 * 1024
const MAX_POLICY_INPUT_BYTES = 1024 * 1024
const DEFAULT_POLICY_TIMEOUT_MS = 5_000
const MAX_POLICY_TIMEOUT_MS = 30_000
const DEFAULT_POLICY_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_POLICY_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE_POLICY_CHECKS = 4
const MAX_ACTIVE_POLICY_CHECKS = 16
const MAX_POLICY_INPUT_DEPTH = 64
const MAX_POLICY_INPUT_ENTRIES = 10_000
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const DSH_V1_REASON_DISPOSITIONS = new Set(['allow', 'warn', 'context', 'block'])

export type CancellationCause = 'caller-aborted' | 'timeout' | 'disposed' | 'degraded'

export type JsonValueFrame = { kind: 'value', value: unknown, depth: number }

export type JsonContainerFrame = { kind: 'container', value: any, array: boolean, index: number, iterator: Iterator<[string, any]> | undefined, first: boolean, depth: number }

export type JsonFrame = JsonValueFrame | JsonContainerFrame
export type JsonMeasurement = { ok: true, bytes: number, entries: number } | { ok: false, reason: 'too-large' | 'too-complex' }

export type ActiveOperation = { controller: AbortController, handle: SubprocessHandle | undefined, cause: CancellationCause | undefined, cancel: (cause: CancellationCause, reason?: unknown) => void, cancelled: Promise<void>, resolveCancelled: () => void, settled: Promise<void>, resolveSettled: () => void }

function denial(reason: string) {
  return { kind: (('deny') as const), reason: `dsh-runtime-kit:${reason}` }
}

function policyReason(decision: Record<string, any>) {
  const blockingReasons = Array.isArray(decision.reasons)
    ? decision.reasons.filter(reason => reason?.disposition === 'block')
    : []
  const codes = [...new Set(blockingReasons
    .map(reason => reason?.code)
    .filter(code => typeof code === 'string' && code.length > 0))]
  const ruleIds = [...new Set(blockingReasons
    .map(reason => reason?.rule_id)
    .filter(ruleId => typeof ruleId === 'string' && ruleId.length > 0))]
  const summary = codes.length > 0 ? `agent-hook:${codes.join(',')}` : 'agent-hook:blocked'
  // The tiered engine (nils-cli >= 1.28.1) blocks an unclassifiable shell
  // command only for the integrity groups and the governed seams whose subject
  // the command names, and it carries its own guidance as context, so the
  // former "opaque to multiple classifiers" fan-out is no longer a reachable
  // shape and needs no runtime-kit fallback text.
  const unsafeDefaultDelivery = codes.length === 1
    && codes[0] === 'block-unsafe-default-delivery'
  const guidance = unsafeDefaultDelivery
    ? 'The command was blocked before command dispatch because policy could not prove a safe read-only inspection or governed delivery shape. Retry now with one read-only command per Bash call (for example, first `pwd`, then `git status --short --branch`) and set the Bash tool workdir to the exact target checkout; do not include delivery commands in an inspection call. No operator intervention is required.\nFor a genuine delivery from a managed session whose cwd differs, run `semantic-commit commit --repo <absolute managed-worktree path> ...`, then use the repository PR workflow instead of direct default-branch mutation.'
    : undefined
  // nils owns the remediation for a blocked shape; the runtime-kit text below
  // is only a fallback for a decision that carries no context of its own.
  const context = typeof decision.context === 'string' ? decision.context.trim() : ''
  const promotedGuidance = context.length > 0 ? context : guidance
  if (promotedGuidance === undefined || promotedGuidance.length === 0) {
    return [summary, context].filter(Boolean).join('\n')
  }
  const guidanceLines = promotedGuidance
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const primaryCode = codes.length === 1 ? codes[0] : 'blocked'
  const policyCodes = codes.length > 1 ? `Policy codes: ${codes.join(',')}` : undefined
  const policyRules = ruleIds.length > codes.length
    ? `Policy rules: ${ruleIds.join(',')}`
    : undefined
  const remainingContext = promotedGuidance === context
    ? []
    : context.split(/\r?\n/).filter(Boolean)
  return [
    `agent-hook:${primaryCode} — ${guidanceLines[0]}`,
    ...guidanceLines.slice(1),
    policyCodes,
    policyRules,
    ...remainingContext,
  ].filter(Boolean).join('\n')
}

/**
 * DSH executes Bash without an explicit workdir from the immutable session
 * cwd. Project that same authoritative default into both policy lifecycle
 * events so nils sees one stable target while the original tool arguments
 * remain untouched.
 */
function policyToolArguments(exec: ToolExecution, cwd: string) {
  const arguments_ = ((exec.arguments) as Record<string, unknown>)
  if (exec.name !== 'bash'
    || exec.arguments === null
    || typeof exec.arguments !== 'object'
    || Array.isArray(exec.arguments)
    || (Object.hasOwn(arguments_, 'workdir') && arguments_.workdir !== undefined)) {
    return exec.arguments
  }
  if (!boundedJsonMeasurement(arguments_, MAX_POLICY_INPUT_BYTES).ok) {
    return exec.arguments
  }
  return {
    ...arguments_,
    workdir: cwd,
  }
}

function jsonStringBytes(value: string, remaining: number) {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09
      || unit === 0x0a || unit === 0x0c || unit === 0x0d) {
      bytes += 2
    } else if (unit < 0x20) {
      bytes += 6
    } else if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
    if (bytes > remaining) return bytes
  }
  return bytes
}

function* ownEnumerableEntries(value: Record<string, any>): Generator<[string, any], void, unknown>  {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const item = value[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
    yield [key, item]
  }
}

/**
 * Bound JSON traversal before serialization without recursion or eager entry
 * arrays. Rejected shapes never reach the subprocess service.
 */
function boundedJsonMeasurement(value: unknown, limit: number): JsonMeasurement  {
  const ancestors = new WeakSet()
  const stack: JsonFrame[] = [{ kind: 'value', value, depth: 0 }]
  let bytes = 0
  let entries = 0

  const addBytes = (amount: number) => {
    bytes += amount
    return bytes <= limit
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if (frame.kind === 'container') {
      let item
      let key
      if (frame.array) {
        if (frame.index >= frame.value.length) {
          ancestors.delete(frame.value)
          continue
        }
        key = String(frame.index)
        item = Object.hasOwn(frame.value, frame.index) ? frame.value[frame.index] : null
        frame.index += 1
      } else {
        const next = frame.iterator?.next()
        if (next === undefined) return { ok: false, reason: 'too-complex' }
        if (next.done) {
          ancestors.delete(frame.value)
          continue
        }
        ;[key, item] = next.value
      }
      entries += 1
      if (entries > MAX_POLICY_INPUT_ENTRIES) return { ok: false, reason: 'too-complex' }
      if (!frame.first && !addBytes(1)) return { ok: false, reason: 'too-large' }
      frame.first = false
      if (!frame.array && !addBytes(jsonStringBytes(key, limit - bytes) + 1)) {
        return { ok: false, reason: 'too-large' }
      }
      stack.push(frame)
      stack.push({ kind: 'value', value: item, depth: frame.depth + 1 })
      continue
    }

    const item = frame.value
    if (item === null) {
      if (!addBytes(4)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'string') {
      if (!addBytes(jsonStringBytes(item, limit - bytes))) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'boolean') {
      if (!addBytes(item ? 4 : 5)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return { ok: false, reason: 'too-complex' }
      if (!addBytes(String(item).length)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item !== 'object' || ancestors.has(item)) {
      return { ok: false, reason: 'too-complex' }
    }
    if (frame.depth >= MAX_POLICY_INPUT_DEPTH) return { ok: false, reason: 'too-complex' }

    ancestors.add(item)
    if (!addBytes(2)) return { ok: false, reason: 'too-large' }
    const record = ((item) as Record<string, any>)
    stack.push({
      kind: 'container',
      value: record,
      array: Array.isArray(record),
      index: 0,
      iterator: Array.isArray(record) ? undefined : ownEnumerableEntries(record),
      first: true,
      depth: frame.depth,
    })
  }
  return { ok: true, bytes, entries }
}

function validReason(reason: unknown) {
  if (reason === null || typeof reason !== 'object') return false
  const candidate = ((reason) as Record<string, unknown>)
  return typeof candidate.rule_id === 'string'
    && candidate.rule_id.length > 0
    && typeof candidate.code === 'string'
    && candidate.code.length > 0
    && typeof candidate.disposition === 'string'
    && DSH_V1_REASON_DISPOSITIONS.has(candidate.disposition)
}

function actionRank(action: unknown) {
  switch (action) {
    case 'allow': return 0
    case 'warn': return 1
    case 'context': return 2
    case 'block': return 3
    default: return -1
  }
}

function validShadow(observation: unknown) {
  if (observation === null || typeof observation !== 'object') return false
  const candidate = ((observation) as Record<string, unknown>)
  return typeof candidate.rule_id === 'string'
    && candidate.rule_id.length > 0
    && typeof candidate.action === 'string'
    && ['allow', 'warn', 'context', 'transform', 'block'].includes(candidate.action)
    && typeof candidate.code === 'string'
    && candidate.code.length > 0
}

function validDecision(decision: any, expectedRequestId: string, expectedEvent: string) {
  if (!(decision !== null
    && typeof decision === 'object'
    && decision.schema_version === 'agent-hook.normalized-decision.v1'
    && typeof decision.request_id === 'string'
    && decision.request_id === expectedRequestId
    && decision.product === 'dsh'
    && decision.event === expectedEvent
    && ['allow', 'warn', 'context', 'block'].includes(decision.action)
    && Array.isArray(decision.reasons)
    && decision.reasons.every(validReason)
    && (decision.action !== 'block' || decision.reasons.length > 0)
    && SHA256_PATTERN.test(decision.config_digest)
    && SHA256_PATTERN.test(decision.policy_digest)
    && typeof decision.recovery_applied === 'boolean'
    && (decision.shadow === undefined
      || (Array.isArray(decision.shadow) && decision.shadow.every(validShadow)))
    && (decision.context === undefined
      || (['warn', 'context', 'block'].includes(decision.action)
        && typeof decision.context === 'string'
        && decision.context.length > 0
        && Buffer.byteLength(decision.context, 'utf8') <= 16 * 1024))
    && (!['warn', 'context'].includes(decision.action)
      || typeof decision.context === 'string')
    && decision.replacement === undefined)) return false

  const expectedRank = actionRank(decision.action)
  const reasonRank = decision.reasons.reduce(
    (highest: number, reason: Record<string, unknown>) => Math.max(highest, actionRank(reason.disposition)),
    0,
  )
  return reasonRank === expectedRank
}

function validDataPolicyDecision(decision: any, expectedRequestId: string, sourceId: string, sinkId: string) {
  if (!(decision !== null
    && typeof decision === 'object'
    && decision.schema_version === 'agent-hook.data-policy.decision.v1'
    && decision.request_id === expectedRequestId
    && ['allow', 'deny', 'redact', 'quarantine'].includes(decision.action)
    && typeof decision.code === 'string'
    && decision.code.length > 0
    && decision.code.length <= 256
    && decision.audit !== null
    && typeof decision.audit === 'object'
    && decision.audit.action === decision.action
    && decision.audit.code === decision.code
    && decision.audit.source_id === sourceId
    && decision.audit.sink_id === sinkId
    && Array.isArray(decision.audit.classes)
    && decision.audit.classes.every((classId: unknown) => typeof classId === 'string'
      && ['sensitive', 'machine-local-path', 'protected-root'].includes(classId))
    && Array.isArray(decision.audit.matched_rule_ids)
    && decision.audit.matched_rule_ids.every((ruleId: unknown) => typeof ruleId === 'string'
      && ruleId.length > 0
      && ruleId.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(ruleId))
    && new Set(decision.audit.matched_rule_ids).size === decision.audit.matched_rule_ids.length
    && SHA256_PATTERN.test(decision.audit.payload_digest)
    && SHA256_PATTERN.test(decision.audit.binding_digest)
    && ((decision.action === 'redact' || decision.action === 'quarantine')
      ? Object.hasOwn(decision, 'replacement')
      : decision.replacement === undefined))) return false
  return decision.replacement === undefined
    || boundedJsonMeasurement(decision.replacement, MAX_POLICY_INPUT_BYTES).ok
}

function policyTimeout(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_POLICY_TIMEOUT_MS)
    : DEFAULT_POLICY_TIMEOUT_MS
}

function policyConcurrency(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_ACTIVE_POLICY_CHECKS)
    : DEFAULT_MAX_ACTIVE_POLICY_CHECKS
}

function policyTeardownTimeout(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_POLICY_TEARDOWN_TIMEOUT_MS)
    : DEFAULT_POLICY_TEARDOWN_TIMEOUT_MS
}

function cancellationDenial(cause: CancellationCause) {
  if (cause === 'caller-aborted') return denial('policy-caller-aborted')
  if (cause === 'timeout') return denial('policy-timeout')
  if (cause === 'disposed') return denial('policy-disposed')
  return denial('policy-unavailable')
}

/**
 * Create the only nils subprocess boundary. Admission, cancellation, process
 * settlement, and whole-tree quiescence are one owned operation. Confirmed
 * quiescence releases capacity normally. Unknown quiescence releases local
 * bookkeeping only after permanently closing admission and cancelling every
 * sibling operation, so possible survivors can never create reusable capacity.
 */
export function createNilsTransport(ctx: Context, config: { agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, agentDocsHome?: string, agentDocsStateHome?: string, policyTimeoutMs?: number, policyTeardownTimeoutMs?: number, maxActivePolicyChecks?: number, managedSessionBridge?: {resolve?: (id:string) => unknown} } = {}) {
  const agentHook = resolveAgentHookRuntime(config)
  const timeoutMs = policyTimeout(config.policyTimeoutMs)
  const teardownTimeoutMs = policyTeardownTimeout(config.policyTeardownTimeoutMs)
  const maxActive = policyConcurrency(config.maxActivePolicyChecks)
  const agentDocsHome = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
  const agentDocsStateHome = requiredAbsolutePath(config.agentDocsStateHome, 'agentDocsStateHome')
  const authenticatedExecution = resolveAuthenticatedNilsExecution(ctx, config)
  const managedSessionBridge = config.managedSessionBridge
  const active: Set<ActiveOperation> = new Set()
  let open = true
  let degraded = false
  let admissionEpoch = 0

  function cancelOperation(operation: ActiveOperation, cause: CancellationCause, reason?: unknown) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(reason)
    try {
      operation.handle?.terminate()
    } catch {
      // waitForExit remains the authoritative quiescence observation.
    }
  }

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimeout(() => {
        controller.abort(new Error('dsh-runtime-kit process-tree teardown deadline exceeded'))
        try { handle.terminate() } catch {}
        resolve(false)
      }, teardownTimeoutMs)
    })
    const observed = Promise.resolve()
      .then(() => handle.waitForExit(controller.signal))
      .then(value => value === true, () => false)
    try {
      return await Promise.race([observed, deadline])
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    }
  }

  function degradeAdmission() {
    if (!degraded) admissionEpoch += 1
    degraded = true
    open = false
    for (const operation of active) {
      operation.cancel(
        'degraded',
        new Error('dsh-runtime-kit process-tree quiescence is unknown'),
      )
    }
  }

  async function dispose() {
    if (open || active.size > 0) {
      open = false
      const pending = [...active]
      for (const operation of pending) {
        operation.cancel('disposed', new Error('dsh-runtime-kit policy transport disposed'))
      }
      await Promise.allSettled(pending.map(operation => operation.settled))
    }
    await authenticatedExecution.dispose()
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit nils transport')

  async function evaluateIngress(
    ingress: Record<string, unknown>,
    signal: AbortSignal,
    cwd: string,
    expectedEvent: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit' | 'Stop' | 'DataPolicy',
    principal: {sessionId:string, environment:Readonly<Record<string,string>>} | undefined,
    providerSessionId: string,
    contract: 'dispatch' | 'data-policy' = 'dispatch',
  ) {
    const measurement = boundedJsonMeasurement(ingress, MAX_POLICY_INPUT_BYTES)
    if (!measurement.ok) return denial(`policy-input-${measurement.reason}`)
    let payload
    try {
      payload = JSON.stringify(ingress)
    } catch {
      return denial('policy-input-too-complex')
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_POLICY_INPUT_BYTES) {
      return denial('policy-input-too-large')
    }
    const expectedRequestId = `request:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`

    if (!open) return denial(degraded ? 'policy-unavailable' : 'policy-disposed')
    if (signal.aborted) return denial('policy-caller-aborted')
    if (active.size >= maxActive) return denial('policy-overloaded')

    let resolveSettled = () => {}
    const settled: Promise<void> = new Promise(resolve => { resolveSettled = () => resolve() })
    let resolveCancelled = () => {}
    const cancelled: Promise<void> = new Promise(resolve => { resolveCancelled = () => resolve() })
    const operation: ActiveOperation = {
      controller: new AbortController(),
      handle: undefined,
      cause: undefined,
      cancel: (((cause, reason) => {
        cancelOperation(operation, cause, reason)
      }) as ActiveOperation['cancel']),
      cancelled,
      resolveCancelled,
      settled,
      resolveSettled,
    }
    active.add(operation)

    const onCallerAbort = () => operation.cancel('caller-aborted', signal.reason)
    signal.addEventListener('abort', onCallerAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let executionLease: {signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined
    try {
      if (signal.aborted) operation.cancel('caller-aborted', signal.reason)
      if (!open) operation.cancel('disposed')
      if (operation.cause !== undefined) return cancellationDenial(operation.cause)
      timer = setTimeout(() => {
        operation.cancel('timeout', new Error('dsh-runtime-kit policy deadline exceeded'))
      }, timeoutMs)

      try {
        executionLease = authenticatedExecution.acquire(operation.controller.signal)
        const executionSignal = executionLease.signal
        const childEnvironment = principal === undefined
          ? isolatedNilsEnvironment(undefined)
          : {
              ...authenticatedNilsEnvironment(principal.environment),
              // The ingress subject changes to the authenticated coordination
              // owner once a Main Agent controller/lane binds. Activity still
              // belongs to the stable DSH provider session, so carry that
              // metadata on this private subprocess edge instead of widening
              // the public ingress schema or overloading owner identity.
              DSH_RUNTIME_KIT_PROVIDER_SESSION_ID: providerSessionId,
            }
        const argv = await resolveSubprocessArgv(
          ctx,
          agentHook.argv(contract === 'data-policy'
            ? ['data-policy', 'evaluate', '--format', 'json']
            : ['dispatch', '--product', 'dsh', '--format', 'json']),
          executionSignal,
        )
        operation.handle = executionLease.spawn({
          argv,
          cwd,
          stdio: {
            stdin: { data: payload },
            stdout: { maxBytes: MAX_POLICY_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_POLICY_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: executionSignal,
          env: childEnvironment,
        })
      } catch {
        return operation.cause === undefined
          ? denial('policy-unavailable')
          : cancellationDenial(operation.cause)
      }
      const handle = operation.handle
      if (operation.cause !== undefined) {
        try { handle.terminate() } catch {}
      }

      const doneObserved = Promise.resolve(handle.done).then(
        outcome => ({ kind: (('done') as const), outcome, failed: false }),
        () => ({ kind: (('done') as const), outcome: undefined, failed: true }),
      )
      const first = await Promise.race([
        doneObserved,
        operation.cancelled.then(() => ({
          kind: (('cancelled') as const),
          outcome: undefined,
          failed: false,
        })),
      ])
      const quiescent = await boundedQuiescence(handle)
      if (!quiescent) degradeAdmission()

      if (operation.cause !== undefined) return cancellationDenial(operation.cause)
      if (first.kind !== 'done' || first.failed || first.outcome === undefined || !quiescent) {
        return denial('policy-unavailable')
      }
      const outcome = first.outcome

      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy) return denial('policy-output-invalid')
      let envelope
      try {
        envelope = JSON.parse(stdout.text)
      } catch {
        return denial('policy-output-invalid')
      }
      if (contract === 'data-policy') {
        const sourceId = typeof ingress.source_id === 'string' ? ingress.source_id : ''
        const sinkId = typeof ingress.sink_id === 'string' ? ingress.sink_id : ''
        if (envelope?.schema_version !== 'cli.agent-hook.data-policy-evaluate.v1'
          || envelope.ok !== true
          || !validDataPolicyDecision(envelope.data, expectedRequestId, sourceId, sinkId)) {
          return denial('policy-output-invalid')
        }
        if (outcome.exitCode !== 0 || outcome.signal !== null) {
          return denial('policy-exit-mismatch')
        }
        return { kind: (('data-policy') as const), decision: envelope.data }
      }
      if (envelope?.schema_version !== 'cli.agent-hook.dispatch.v1'
        || envelope.ok !== true
        || !validDecision(envelope.data, expectedRequestId, expectedEvent)) {
        return denial('policy-output-invalid')
      }

      const decision = envelope.data
      if (decision.action === 'block') {
        return outcome.exitCode === 1 && outcome.signal === null
          ? { kind: (('deny') as const), reason: policyReason(decision) }
          : denial('policy-exit-mismatch')
      }
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        return denial('policy-exit-mismatch')
      }
      return decision.action === 'context' || decision.action === 'warn'
        ? { kind: (('context') as const), context: decision.context }
        : undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      executionLease?.release()
      signal.removeEventListener('abort', onCallerAbort)
      active.delete(operation)
      operation.resolveSettled()
    }
  }

  return Object.freeze({
    async evaluate(exec: ToolExecution, context: {sessionId: string, cwd: string, turn: number, step: number}, prerequisite: {agentId: string, workspaceGeneration: string, definitionId: string, receipt: string} | undefined) {
      const principal = resolveManagedSessionPrincipal(ctx, context.sessionId, managedSessionBridge)
      return evaluateIngress({
        schema_version: prerequisite === undefined
          ? 'agent-hook.dsh-ingress.v2'
          : 'agent-hook.dsh-ingress.v5',
        event: 'tools/pre-execute',
        call_id: String(exec.callId),
        cwd: context.cwd,
        subject: {
          session_id: principal?.sessionId ?? context.sessionId,
          turn: context.turn,
          step: context.step,
          agent_docs_home: agentDocsHome,
          agent_docs_state_home: agentDocsStateHome,
          ...prerequisite === undefined
            ? {}
            : {
                agent_id: prerequisite.agentId,
                workspace_generation: prerequisite.workspaceGeneration,
              },
        },
        tool: {
          name: exec.name,
          arguments: policyToolArguments(exec, context.cwd),
          ...prerequisite === undefined
            ? {}
            : {
                definition_id: prerequisite.definitionId,
                prerequisite_receipt: prerequisite.receipt,
              },
        },
      }, exec.signal, context.cwd, 'PreToolUse', principal, context.sessionId)
    },

    /**
 * Complete the exact operation lifecycle without forwarding candidate
 * output. Caller cancellation has already become an observed tool result
 * at this boundary, so cleanup receives its own signal and remains bounded
 * by the transport deadline/disposal controls.
 */

    async evaluatePost(exec: ToolExecution, result: Readonly<import('@deepseek-ai/dsh-tools').ToolExecutionResult>, context: {sessionId: string, cwd: string, turn: number, step: number}) {
      const principal = resolveManagedSessionPrincipal(ctx, context.sessionId, managedSessionBridge)
      return evaluateIngress({
        schema_version: 'agent-hook.dsh-ingress.v4',
        event: 'tools/post-execute',
        call_id: String(exec.callId),
        cwd: context.cwd,
        subject: {
          session_id: principal?.sessionId ?? context.sessionId,
          turn: context.turn,
          step: context.step,
          agent_docs_home: agentDocsHome,
          agent_docs_state_home: agentDocsStateHome,
        },
        tool: {
          name: exec.name,
          arguments: policyToolArguments(exec, context.cwd),
        },
        result: { is_error: result.isError === true },
      }, new AbortController().signal, context.cwd, result.isError ? 'PostToolUseFailure' : 'PostToolUse', principal, context.sessionId)
    },

    /** Evaluate a typed candidate through nils without provider-native adaptation. */

    async evaluateData(request: Record<string, unknown>, signal: AbortSignal, context: {sessionId: string, cwd: string}) {
      const principal = resolveManagedSessionPrincipal(ctx, context.sessionId, managedSessionBridge)
      return evaluateIngress(
        request,
        signal,
        context.cwd,
        'DataPolicy',
        principal,
        context.sessionId,
        'data-policy',
      )
    },

    async evaluateLifecycle(request: {event: 'agent/pre-step', prompt: string, sessionStartSource?: string, signal: AbortSignal, context: {sessionId: string, cwd: string, turn: number, step: number}} | {event: 'agent/turn-stopping', signal: AbortSignal, context: {sessionId: string, cwd: string, turn: number}}) {
      const preStep = request.event === 'agent/pre-step'
      const principal = resolveManagedSessionPrincipal(ctx, request.context.sessionId, managedSessionBridge)
      const ingress = {
        schema_version: 'agent-hook.dsh-ingress.v3',
        event: request.event,
        cwd: request.context.cwd,
        ...preStep ? { prompt: request.prompt } : {},
        subject: {
          session_id: principal?.sessionId ?? request.context.sessionId,
          turn: request.context.turn,
          ...preStep ? { step: request.context.step } : {},
          ...preStep && request.sessionStartSource !== undefined
            ? { session_start_source: request.sessionStartSource }
            : {},
          agent_docs_home: agentDocsHome,
          agent_docs_state_home: agentDocsStateHome,
        },
      }
      return evaluateIngress(
        ingress,
        request.signal,
        request.context.cwd,
        preStep ? 'UserPromptSubmit' : 'Stop',
        principal,
        request.context.sessionId,
      )
    },

    dispose,
    get active() { return active.size },
    get open() { return open },
    get degraded() { return degraded },
    get admissionEpoch() { return admissionEpoch },
    timeoutMs,
    teardownTimeoutMs,
    maxActive,
  })
}
