import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { runtimeContextPhase } from './intents.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import { requiredAbsolutePath } from '../nils/agent-hook-runtime.js'
import {
  authenticatedNilsEnvironment,
  isolatedNilsEnvironment,
  resolveManagedSessionPrincipal,
} from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

export type Context = import('@deepseek-ai/cordis').Context
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle
export type ToolRunContext = import('@deepseek-ai/dsh-tools').ToolRunContext
export type ContextDecision = { schema_version: 'decision.context.v1', request_id: string, product: 'dsh', intent: string, reason: 'prepared' | 'already-current', verified: true, documents: Array<{source: 'home' | 'project', scope: 'home' | 'project' | 'global', content: string}>, document_count: number, total_bytes: number }

const DEFAULT_CONTEXT_BYTES = 20 * 1024
const MAX_CONTEXT_BYTES = 64 * 1024
const CONTEXT_ENVELOPE_BYTES = 32 * 1024
const MAX_CONTEXT_ERROR_BYTES = 8 * 1024
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000
const MAX_CONTEXT_TIMEOUT_MS = 30_000
const DEFAULT_CONTEXT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_CONTEXT_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE_CONTEXT_REQUESTS = 2
const MAX_ACTIVE_CONTEXT_REQUESTS = 16
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,127}$/

export type CancellationCause = 'caller-aborted' | 'timeout' | 'disposed' | 'degraded'

export type ActiveOperation = { controller: AbortController, handle: SubprocessHandle | undefined, cause: CancellationCause | undefined, cancel: (cause: CancellationCause, reason?: unknown) => void, cancelled: Promise<void>, resolveCancelled: () => void, settled: Promise<void>, resolveSettled: () => void }

function failure(reason: string) {
  return new Error(`dsh-runtime-kit:runtime-context-${reason}`)
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

function commandName(value: unknown, fallback: string, field: string) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`dsh-runtime-kit: ${field} must be a non-empty executable name`)
  }
  return value
}

function hasExactKeys(value: unknown, expected: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function validDocument(value: unknown) {
  if (!hasExactKeys(value, ['source', 'scope', 'content'])) return false
  const document = ((value) as Record<string, unknown>)
  return (document.source === 'home' || document.source === 'project')
    && ['home', 'project', 'global'].includes(String(document.scope))
    && typeof document.content === 'string'
}

function parseSuccess(envelope: unknown, requestId: string, intent: string, phase: string | undefined, maxBytes: number) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'data'])) return undefined
  const outer = ((envelope) as Record<string, any>)
  if (outer.schema_version !== 'cli.agent-docs.session.context.v1'
    || outer.ok !== true
    || !hasExactKeys(outer.data, ['decision'])) return undefined
  const decision = outer.data.decision
  const decisionKeys = [
    'schema_version',
    'request_id',
    'product',
    'intent',
    ...(phase === undefined ? [] : ['phase']),
    'reason',
    'verified',
    'documents',
    'document_count',
    'total_bytes',
  ]
  if (!hasExactKeys(decision, decisionKeys)
    || decision.schema_version !== 'decision.context.v1'
    || decision.request_id !== requestId
    || decision.product !== 'dsh'
    || decision.intent !== intent
    || decision.phase !== phase
    || !['prepared', 'already-current'].includes(decision.reason)
    || decision.verified !== true
    || !Array.isArray(decision.documents)
    || !decision.documents.every(validDocument)
    || !Number.isSafeInteger(decision.document_count)
    || decision.document_count !== decision.documents.length
    || !Number.isSafeInteger(decision.total_bytes)
    || decision.total_bytes < 0
    || decision.total_bytes > maxBytes) return undefined
  const measured = decision.documents.reduce(
    (total: number, document: { content: string }) => total + Buffer.byteLength(document.content, 'utf8'),
    0,
  )
  return measured === decision.total_bytes
    ? ((decision) as ContextDecision)
    : undefined
}

function parseFailureCode(envelope: unknown, schemas = ['cli.agent-docs.session.context.v1']) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'error'])) return undefined
  const outer = ((envelope) as Record<string, any>)
  if (!schemas.includes(outer.schema_version)
    || outer.ok !== false
    || outer.error === null
    || typeof outer.error !== 'object'
    || typeof outer.error.code !== 'string'
    || !SAFE_ERROR_CODE.test(outer.error.code)) return undefined
  return outer.error.code
}

function parsePrerequisiteSuccess(envelope: unknown, requestId: string, intent: string, phase: string, maxBytes: number) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'data'])) return undefined
  const outer = ((envelope) as Record<string, any>)
  if (outer.schema_version !== 'cli.agent-docs.session.prerequisite.v1'
    || outer.ok !== true
    || !hasExactKeys(outer.data, ['decision'])) return undefined
  const decision = outer.data.decision
  const keys = [
    'schema_version', 'request_id', 'product', 'intent', 'phase', 'reason',
    'verified', 'documents', 'document_count', 'total_bytes', 'receipt',
  ]
  if (!hasExactKeys(decision, keys)
    || decision.schema_version !== 'decision.prerequisite.v1'
    || decision.request_id !== requestId
    || decision.product !== 'dsh'
    || decision.intent !== intent
    || decision.phase !== phase
    || !['pending', 'already-current'].includes(decision.reason)
    || decision.verified !== true
    || !Array.isArray(decision.documents)
    || !decision.documents.every(validDocument)
    || !Number.isSafeInteger(decision.document_count)
    || decision.document_count !== decision.documents.length
    || !Number.isSafeInteger(decision.total_bytes)
    || decision.total_bytes < 0
    || decision.total_bytes > maxBytes
    || typeof decision.receipt !== 'string'
      || decision.receipt.length === 0
      || Buffer.byteLength(decision.receipt, 'utf8') > 4096
      || /[\u0000-\u001f\u007f]/u.test(decision.receipt)) return undefined
  const measured = decision.documents.reduce(
    (total: number, document: { content: string }) => total + Buffer.byteLength(document.content, 'utf8'),
    0,
  )
  return measured === decision.total_bytes ? decision : undefined
}

function parsePrerequisiteCommitSuccess(envelope: unknown, intent: string, phase: string) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'data'])) return undefined
  const outer = ((envelope) as Record<string, any>)
  const data = outer.data
  return outer.schema_version === 'cli.agent-docs.session.commit-prerequisite.v1'
    && outer.ok === true
    && hasExactKeys(data, ['product', 'intent', 'phase', 'reason', 'verified'])
    && data.product === 'dsh'
    && data.intent === intent
    && data.phase === phase
    && ['prepared', 'already-current'].includes(data.reason)
    && data.verified === true
    ? data
    : undefined
}

function executionScope(exec: ToolRunContext) {
  const agent = exec.agent
  const session = agent?.session
  const header = session?.header
  const sessionId = header?.id
  const cwd = header?.cwd
  if (agent === undefined
    || session === undefined
    || typeof sessionId !== 'string'
    || sessionId.length === 0
    || Buffer.byteLength(sessionId, 'utf8') > 256
    || sessionId.includes('\0')
    || agent.id !== session.id
    || session.id !== sessionId
    || typeof cwd !== 'string'
    || !isAbsolute(cwd)
    || cwd.includes('\0')) {
    throw failure('identity-invalid')
  }
  return { sessionId, cwd }
}

/**
 * Own the atomic agent-docs context subprocess separately from the Task 2.1
 * pre-tool policy ingress. Unknown process-tree quiescence permanently closes
 * only this context surface; it never relaxes or rewrites policy admission.
 */
export function createNilsContextClient(ctx: Context, config: { agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number, managedSessionBridge?: {resolve?: (id:string) => unknown} } = {}) {
  const command = commandName(config.agentDocs, 'agent-docs', 'agentDocs')
  const docsHome = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
  const stateHome = requiredAbsolutePath(config.agentDocsStateHome, 'agentDocsStateHome')
  const managedSessionBridge = config.managedSessionBridge
  const maxBytes = boundedPositiveInteger(config.contextMaxBytes, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES)
  const timeoutMs = boundedPositiveInteger(
    config.contextTimeoutMs,
    DEFAULT_CONTEXT_TIMEOUT_MS,
    MAX_CONTEXT_TIMEOUT_MS,
  )
  const teardownTimeoutMs = boundedPositiveInteger(
    config.contextTeardownTimeoutMs,
    DEFAULT_CONTEXT_TEARDOWN_TIMEOUT_MS,
    MAX_CONTEXT_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = boundedPositiveInteger(
    config.maxActiveContextRequests,
    DEFAULT_MAX_ACTIVE_CONTEXT_REQUESTS,
    MAX_ACTIVE_CONTEXT_REQUESTS,
  )
  const authenticatedExecution = resolveAuthenticatedNilsExecution(ctx, config)
  // JSON may encode one input byte as a six-byte escape (for example a
  // control character). Bound the worst valid encoding rather than silently
  // rejecting content that was within the advertised document budget.
  const stdoutBytes = maxBytes * 6 + CONTEXT_ENVELOPE_BYTES
  const active: Set<ActiveOperation> = new Set()
  let open = true
  let degraded = false

  function cancelOperation(operation: ActiveOperation, cause: CancellationCause, reason?: unknown) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(reason)
    try { operation.handle?.terminate() } catch {}
  }

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(failure('teardown-timeout'))
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
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  function degradeAdmission() {
    degraded = true
    open = false
    for (const operation of active) {
      operation.cancel('degraded', failure('quiescence-unknown'))
    }
  }

  async function dispose() {
    if (open || active.size > 0) {
      open = false
      const pending = [...active]
      for (const operation of pending) {
        operation.cancel('disposed', failure('disposed'))
      }
      await Promise.allSettled(pending.map(operation => operation.settled))
    }
    await authenticatedExecution.dispose()
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit agent-docs context transport')

  async function executeCommand<T>(exec: ToolRunContext, argv: string[], cwd: string, principal: {environment: Record<string, string>} | undefined, parse: (envelope: unknown) => T | undefined, failureSchemas: string[]): Promise<T>  {
    if (!open) throw failure(degraded ? 'unavailable' : 'disposed')
    if (exec.signal.aborted) throw failure('caller-aborted')
    if (active.size >= maxActive) throw failure('overloaded')

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
    const onCallerAbort = () => operation.cancel('caller-aborted', exec.signal.reason)
    exec.signal.addEventListener('abort', onCallerAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let executionLease: {signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined
    try {
      if (exec.signal.aborted) operation.cancel('caller-aborted', exec.signal.reason)
      if (!open) operation.cancel('disposed')
      if (operation.cause !== undefined) throw failure(operation.cause)
      timer = setTimeout(() => operation.cancel('timeout', failure('timeout')), timeoutMs)
      try {
        executionLease = authenticatedExecution.acquire(operation.controller.signal)
        const executionSignal = executionLease.signal
        const childEnvironment = principal === undefined
          ? isolatedNilsEnvironment(undefined)
          : authenticatedNilsEnvironment(principal.environment)
        const resolvedArgv = await resolveSubprocessArgv(ctx, argv, executionSignal)
        operation.handle = executionLease.spawn({
          argv: resolvedArgv,
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: stdoutBytes },
            stderr: { maxBytes: MAX_CONTEXT_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: executionSignal,
          env: childEnvironment,
        })
      } catch {
        if (operation.cause !== undefined) throw failure(operation.cause)
        throw failure('unavailable')
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
      if (operation.cause !== undefined) throw failure(operation.cause)
      if (first.kind !== 'done' || first.failed || first.outcome === undefined || !quiescent) {
        throw failure('unavailable')
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy) throw failure('output-invalid')
      let envelope
      try { envelope = JSON.parse(stdout.text) } catch { throw failure('output-invalid') }
      if (first.outcome.exitCode === 0 && first.outcome.signal === null) {
        const parsed = parse(envelope)
        if (parsed === undefined) throw failure('output-invalid')
        return parsed
      }
      if (first.outcome.exitCode === null || first.outcome.signal !== null) {
        throw failure('exit-mismatch')
      }
      const code = parseFailureCode(envelope, failureSchemas)
      if (code === undefined) throw failure('output-invalid')
      throw failure(`agent-docs-${code}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      executionLease?.release()
      exec.signal.removeEventListener('abort', onCallerAbort)
      active.delete(operation)
      operation.resolveSettled()
    }
  }

  return Object.freeze({
    async prepare(exec: ToolRunContext, intent: string) {
      const phase = runtimeContextPhase(intent)
      const scope = executionScope(exec)
      const principal = resolveManagedSessionPrincipal(ctx, scope.sessionId, managedSessionBridge)
      const sessionId = principal?.sessionId ?? scope.sessionId
      const { cwd } = scope
      const requestId = `context:${randomUUID()}`
      const argv = [command]
      if (docsHome !== undefined) argv.push('--docs-home', docsHome)
      argv.push(
        '--project-path', cwd,
        'session', 'context',
        '--session-id', sessionId,
        '--product', 'dsh',
        '--state-home', stateHome,
        '--intent', intent,
      )
      argv.push('--phase', phase)
      argv.push('--request-id', requestId, '--max-bytes', String(maxBytes), '--format', 'json')
      return executeCommand(
        exec,
        argv,
        cwd,
        principal,
        envelope => parseSuccess(envelope, requestId, intent, phase, maxBytes),
        ['cli.agent-docs.session.context.v1'],
      )
    },

    async beginPrerequisite(exec: ToolRunContext, intent: string, binding: {agentId: string, workspaceGeneration: string, callId: string, turn: number, step: number, toolName: string, definitionId: string}) {
      const phase = runtimeContextPhase(intent)
      const scope = executionScope(exec)
      const principal = resolveManagedSessionPrincipal(ctx, scope.sessionId, managedSessionBridge)
      const sessionId = principal?.sessionId ?? scope.sessionId
      const requestId = `prerequisite:${randomUUID()}`
      const argv = [command]
      if (docsHome !== undefined) argv.push('--docs-home', docsHome)
      argv.push(
        '--project-path', scope.cwd,
        'session', 'prerequisite',
        '--session-id', sessionId,
        '--product', 'dsh',
        '--state-home', stateHome,
        '--intent', intent,
        '--phase', phase,
        '--request-id', requestId,
        '--agent-id', binding.agentId,
        '--workspace-generation', binding.workspaceGeneration,
        '--call-id', binding.callId,
        '--turn', String(binding.turn),
        '--step', String(binding.step),
        '--tool-name', binding.toolName,
        '--definition-id', binding.definitionId,
        '--max-bytes', String(maxBytes),
        '--format', 'json',
      )
      return executeCommand(
        exec,
        argv,
        scope.cwd,
        principal,
        envelope => parsePrerequisiteSuccess(envelope, requestId, intent, phase, maxBytes),
        ['cli.agent-docs.session.prerequisite.v1'],
      )
    },

    async commitPrerequisite(exec: ToolRunContext, pending: {intent: string, phase: string, receipt: string, binding: {agentId: string, workspaceGeneration: string, callId: string, turn: number, step: number, toolName: string, definitionId: string}}) {
      const scope = executionScope(exec)
      const principal = resolveManagedSessionPrincipal(ctx, scope.sessionId, managedSessionBridge)
      const sessionId = principal?.sessionId ?? scope.sessionId
      const { binding } = pending
      const argv = [command]
      if (docsHome !== undefined) argv.push('--docs-home', docsHome)
      argv.push(
        '--project-path', scope.cwd,
        'session', 'commit-prerequisite',
        '--session-id', sessionId,
        '--product', 'dsh',
        '--state-home', stateHome,
        '--receipt', pending.receipt,
        '--agent-id', binding.agentId,
        '--workspace-generation', binding.workspaceGeneration,
        '--call-id', binding.callId,
        '--turn', String(binding.turn),
        '--step', String(binding.step),
        '--tool-name', binding.toolName,
        '--definition-id', binding.definitionId,
        '--format', 'json',
      )
      return executeCommand(
        exec,
        argv,
        scope.cwd,
        principal,
        envelope => parsePrerequisiteCommitSuccess(envelope, pending.intent, pending.phase),
        ['cli.agent-docs.session.commit-prerequisite.v1'],
      )
    },

    dispose,
    get active() { return active.size },
    get open() { return open },
    get degraded() { return degraded },
    command,
    stateHome,
    maxBytes,
    timeoutMs,
    teardownTimeoutMs,
    maxActive,
  })
}
