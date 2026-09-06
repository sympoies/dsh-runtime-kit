import { isAbsolute } from 'node:path'

import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import { isolatedNilsEnvironment } from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'
import {
  WORKSPACE_LEASE_MAX_TARGET_PATH_BYTES as MAX_TARGET_PATH_BYTES,
  WORKSPACE_LEASE_MAX_TARGETS as MAX_TARGETS,
  WORKSPACE_LEASE_PROTOCOL_VERSION,
  WORKSPACE_LEASE_UNAVAILABLE,
  WorkspaceLease,
  WorkspaceLeaseError,
} from './index.js'

export type Context = import('@deepseek-ai/cordis').Context
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle
export type WorkspaceLeaseProvider = import('./index.js').WorkspaceLeaseProvider
export type WorkspaceLeaseTarget = import('./index.js').WorkspaceLeaseTarget

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE = 8
const MAX_ACTIVE = 32
const MAX_INPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_ERROR_BYTES = 8 * 1024
const MAX_TEXT_BYTES = 1_024
const PRINTABLE_TEXT = /^[^\u0000-\u001f\u007f]+$/u
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
const DENIED_STATES = new Set([
  'foreign-active',
  'stale-clean',
  'dirty',
  'uncertain',
  'unavailable',
])

export type ActiveRequest = { action: 'resolve' | 'bind' | 'begin' | 'complete' | 'renew' | 'release', controller: AbortController, handle: SubprocessHandle | undefined, cause: 'caller' | 'timeout' | 'disposed' | 'degraded' | undefined, cancelled: Promise<void>, resolveCancelled: () => void, settled: Promise<void>, resolveSettled: () => void }

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

function record(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? ((value) as Record<string, any>)
    : undefined
}

function exactKeys(value: Record<string, any>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index])
}

function text(value: unknown) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES
    && PRINTABLE_TEXT.test(value)
}

function delay(value: unknown) {
  return Number.isSafeInteger(value) && ((value) as number) > 0
    && ((value) as number) <= 2_147_483_647
}

function providerCode(value: unknown) {
  return typeof value === 'string' && PROVIDER_CODE.test(value)
}

function deniedState(value: unknown) {
  return typeof value === 'string' && DENIED_STATES.has(value)
}

function unavailable(): WorkspaceLeaseError  {
  return new WorkspaceLeaseError(
    'workspace lease authority provider is unavailable',
    WORKSPACE_LEASE_UNAVAILABLE,
    'unavailable',
  )
}

function requiredWireText(value: unknown, field: string) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`dsh-runtime-kit: invalid workspace lease ${field}`)
  }
  return value
}

function bindingWire(request: import('./index.js').WorkspaceLeaseBindingFacts) {
  if (request.version !== WORKSPACE_LEASE_PROTOCOL_VERSION) throw unavailable()
  return {
    version: WORKSPACE_LEASE_PROTOCOL_VERSION,
    request_id: requiredWireText(request.requestId, 'request id'),
    session_id: requiredWireText(request.sessionId, 'session id'),
    ...(request.parentSessionId === undefined
      ? {}
      : { parent_session_id: requiredWireText(request.parentSessionId, 'parent session id') }),
  }
}

/**
 * The runtime never invents a target. It echoes back the exact object the
 * provider authenticated, so a model-supplied path cannot select authority.
 */
function targetWire(target: WorkspaceLeaseTarget) {
  if (target === null || typeof target !== 'object') throw unavailable()
  if (typeof target.root !== 'string'
    || !isAbsolute(target.root)
    || target.root.includes('\0')
    || Buffer.byteLength(target.root, 'utf8') > MAX_TARGET_PATH_BYTES) throw unavailable()
  return {
    workspace_key: requiredWireText(target.workspaceKey, 'target workspace key'),
    root: target.root,
  }
}

function resolveWire(request: import('./index.js').WorkspaceLeaseResolveRequest) {
  if (request.anchorCwd !== undefined
    && (typeof request.anchorCwd !== 'string'
      || !isAbsolute(request.anchorCwd)
      || request.anchorCwd.includes('\0'))) throw unavailable()
  if (typeof request.nested !== 'boolean') throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.resolve.v2',
    ...bindingWire(request),
    ...(request.anchorCwd === undefined ? {} : { anchor_cwd: request.anchorCwd }),
    call_id: requiredWireText(request.callId, 'call id'),
    root_call_id: requiredWireText(request.rootCallId, 'root call id'),
    tool_name: requiredWireText(request.toolName, 'tool name'),
    arguments: request.arguments,
    nested: request.nested,
  }
}

function bindWire(request: import('./index.js').WorkspaceLeaseBindRequest) {
  if (request.cwd !== undefined
    && (typeof request.cwd !== 'string'
      || !isAbsolute(request.cwd)
      || request.cwd.includes('\0'))) throw unavailable()
  if (!['startup', 'resume', 'clear', 'compact'].includes(request.source)) throw unavailable()
  if (request.target !== undefined && request.cwd !== undefined) throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.bind.v2',
    ...bindingWire(request),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.target === undefined ? {} : { target: targetWire(request.target) }),
    source: request.source,
  }
}

function beginWire(request: import('./index.js').WorkspaceLeaseBeginRequest) {
  if (!['owned', 'unmanaged'].includes(request.bindingState)
    || typeof request.nested !== 'boolean') throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.begin.v2',
    ...bindingWire(request),
    target: targetWire(request.target),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
    binding_state: request.bindingState,
    call_id: requiredWireText(request.callId, 'call id'),
    root_call_id: requiredWireText(request.rootCallId, 'root call id'),
    tool_name: requiredWireText(request.toolName, 'tool name'),
    arguments: request.arguments,
    nested: request.nested,
  }
}

function completeWire(request: import('./index.js').WorkspaceLeaseCompleteRequest) {
  if (!['succeeded', 'failed', 'cancelled'].includes(request.outcome)) throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.complete.v2',
    ...bindingWire(request),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
    operation_id: requiredWireText(request.operationId, 'operation id'),
    fence: requiredWireText(request.fence, 'fence'),
    call_id: requiredWireText(request.callId, 'call id'),
    root_call_id: requiredWireText(request.rootCallId, 'root call id'),
    tool_name: requiredWireText(request.toolName, 'tool name'),
    outcome: request.outcome,
    ...(request.errorCode === undefined
      ? {}
      : { error_code: requiredWireText(request.errorCode, 'error code') }),
  }
}

function renewWire(request: import('./index.js').WorkspaceLeaseRenewRequest) {
  return {
    schema_version: 'agent-hook.workspace-lease.renew.v2',
    ...bindingWire(request),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
  }
}

function releaseWire(request: import('./index.js').WorkspaceLeaseReleaseRequest) {
  if (!['agent-disposed', 'session-rebound', 'provider-disposed'].includes(request.reason)) {
    throw unavailable()
  }
  return {
    schema_version: 'agent-hook.workspace-lease.release.v2',
    ...bindingWire(request),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
    reason: request.reason,
  }
}

function serialize(request: Record<string, unknown>) {
  let payload
  try {
    payload = JSON.stringify(request)
  } catch {
    throw unavailable()
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) throw unavailable()
  return payload
}

function envelopeData(raw: unknown, schema: string) {
  const envelope = record(raw)
  if (envelope === undefined
    || !exactKeys(envelope, ['schema_version', 'ok', 'data'])
    || envelope.schema_version !== schema
    || envelope.ok !== true) throw unavailable()
  const data = record(envelope.data)
  if (data === undefined) throw unavailable()
  return data
}

function denial(data: Record<string, any>, schema: string) {
  if (!exactKeys(data, ['schema_version', 'kind', 'state', 'code', 'reason'])
    || data.schema_version !== schema
    || !deniedState(data.state)
    || !providerCode(data.code)
    || !text(data.reason)) throw unavailable()
  return {
    kind: (('denied') as const),
    state: data.state,
    code: data.code,
    reason: data.reason,
  }
}

function target(value: unknown): WorkspaceLeaseTarget  {
  const data = record(value)
  if (data === undefined
    || !exactKeys(data, ['workspace_key', 'root'])
    || !text(data.workspace_key)
    || typeof data.root !== 'string'
    || !isAbsolute(data.root)
    || data.root.includes('\0')
    || Buffer.byteLength(data.root, 'utf8') > MAX_TARGET_PATH_BYTES) throw unavailable()
  return { workspaceKey: data.workspace_key, root: data.root }
}

function resolveResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.resolve-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-resolve.v1')
  if (data.kind === 'not-required') {
    if (!exactKeys(data, ['schema_version', 'kind']) || data.schema_version !== schema) {
      throw unavailable()
    }
    return { kind: (('not-required') as const) }
  }
  if (!exactKeys(data, ['schema_version', 'kind', 'targets'])
    || data.schema_version !== schema
    || data.kind !== 'targets'
    || !Array.isArray(data.targets)
    || data.targets.length === 0
    || data.targets.length > MAX_TARGETS) throw unavailable()
  const targets = data.targets.map(target)
  if (new Set(targets.map(entry => entry.workspaceKey)).size !== targets.length) {
    throw unavailable()
  }
  return { kind: (('targets') as const), targets }
}

function bindResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.bind-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-bind.v1')
  if (data.kind === 'denied') return denial(data, schema)
  if (data.kind === 'not-required') {
    if (!exactKeys(data, ['schema_version', 'kind']) || data.schema_version !== schema) {
      throw unavailable()
    }
    return { kind: (('not-required') as const) }
  }
  const required = [
    'schema_version',
    'kind',
    'binding_id',
    'workspace_id',
    'generation',
    'state',
    'target',
  ]
  const expected = data.renew_after_ms === undefined ? required : [...required, 'renew_after_ms']
  if (!exactKeys(data, expected)
    || data.schema_version !== schema
    || data.kind !== 'bound'
    || !text(data.binding_id)
    || !text(data.workspace_id)
    || !text(data.generation)
    || !['owned', 'unmanaged'].includes(data.state)
    || (data.renew_after_ms !== undefined && !delay(data.renew_after_ms))) throw unavailable()
  return {
    kind: (('bound') as const),
    bindingId: data.binding_id,
    workspaceId: data.workspace_id,
    generation: data.generation,
    state: data.state,
    target: target(data.target),
    ...(data.renew_after_ms === undefined ? {} : { renewAfterMs: data.renew_after_ms }),
  }
}

function beginResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.begin-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-begin.v1')
  if (data.kind === 'denied') return denial(data, schema)
  if (data.kind === 'not-required') {
    if (!exactKeys(data, ['schema_version', 'kind']) || data.schema_version !== schema) {
      throw unavailable()
    }
    return { kind: (('not-required') as const) }
  }
  if (!exactKeys(data, ['schema_version', 'kind', 'operation_id', 'fence'])
    || data.schema_version !== schema
    || data.kind !== 'granted'
    || !text(data.operation_id)
    || !text(data.fence)) throw unavailable()
  return {
    kind: (('granted') as const),
    operationId: data.operation_id,
    fence: data.fence,
  }
}

function completeResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.complete-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-complete.v1')
  if (!exactKeys(data, ['schema_version', 'kind'])
    || data.schema_version !== schema
    || !['completed', 'duplicate'].includes(data.kind)) throw unavailable()
}

function renewResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.renew-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-renew.v1')
  if (data.kind === 'lost') {
    const lost = denial({ ...data, kind: 'denied' }, schema)
    return { ...lost, kind: (('lost') as const) }
  }
  const required = ['schema_version', 'kind']
  const expected = data.renew_after_ms === undefined ? required : [...required, 'renew_after_ms']
  if (!exactKeys(data, expected)
    || data.schema_version !== schema
    || data.kind !== 'renewed'
    || (data.renew_after_ms !== undefined && !delay(data.renew_after_ms))) throw unavailable()
  return {
    kind: (('renewed') as const),
    ...(data.renew_after_ms === undefined ? {} : { renewAfterMs: data.renew_after_ms }),
  }
}

function releaseResult(raw: unknown) {
  const schema = 'agent-hook.workspace-lease.release-result.v2'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-release.v1')
  if (!exactKeys(data, ['schema_version', 'kind'])
    || data.schema_version !== schema
    || !['released', 'duplicate'].includes(data.kind)) throw unavailable()
}

/**
 * Create the same-process WorkspaceLease provider backed by the strict nils
 * automation service. JavaScript owns only lifecycle projection and transport;
 * canonical Git identity, persistence, conflicts, and recovery remain inside
 * agent-hook.
 */
export function createNilsWorkspaceLeaseProvider(ctx: Context, config: {
    agentHook?: string,
    agentHookConfig?: string,
    agentHookPolicy?: string,
    agentHookStateDir?: string,
    workspaceLeaseTimeoutMs?: number,
    workspaceLeaseTeardownTimeoutMs?: number,
    maxActiveWorkspaceLeaseRequests?: number,
    [key: string]: unknown,
  } = {}): WorkspaceLeaseProvider  {
  const agentHook = resolveAgentHookRuntime(config)
  const timeoutMs = positiveInteger(config.workspaceLeaseTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const teardownTimeoutMs = positiveInteger(
    config.workspaceLeaseTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    MAX_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = positiveInteger(
    config.maxActiveWorkspaceLeaseRequests,
    DEFAULT_MAX_ACTIVE,
    MAX_ACTIVE,
  )
  const authenticatedExecution = resolveAuthenticatedNilsExecution(ctx, config)
  const active: Set<ActiveRequest> = new Set()
  let open = true
  let degraded = false

  function cancel(operation: ActiveRequest, cause: ActiveRequest['cause']) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(unavailable())
    try { operation.handle?.terminate() } catch {}
  }

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(unavailable())
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

  function degrade() {
    degraded = true
    open = false
    for (const operation of active) cancel(operation, 'degraded')
  }

  async function dispose() {
    if (open || active.size > 0) {
      open = false
      const pending = [...active]
      for (const operation of pending) cancel(operation, 'disposed')
      await Promise.allSettled(pending.map(operation => operation.settled))
    }
    await authenticatedExecution.dispose()
  }

  // Registered before WorkspaceLease.registerProvider(), so reverse disposal
  // drains and releases provider bindings while this transport is still open.
  ctx.effect(() => dispose, 'dsh-runtime-kit nils workspace lease provider')

  async function invoke(action: 'resolve' | 'bind' | 'begin' | 'complete' | 'renew' | 'release', request: Record<string, unknown>, signal: AbortSignal) {
    const payload = serialize(request)
    if (!open || degraded || signal.aborted || active.size >= maxActive) throw unavailable()
    let resolveCancelled = () => {}
    const cancelled: Promise<void> = new Promise(resolve => { resolveCancelled = () => resolve() })
    let resolveSettled = () => {}
    const settled: Promise<void> = new Promise(resolve => { resolveSettled = () => resolve() })
    const operation: ActiveRequest = {
      action,
      controller: new AbortController(),
      handle: undefined,
      cause: undefined,
      cancelled,
      resolveCancelled,
      settled,
      resolveSettled,
    }
    active.add(operation)
    const onCallerAbort = () => cancel(operation, 'caller')
    signal.addEventListener('abort', onCallerAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let executionLease: {signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined
    try {
      if (signal.aborted) cancel(operation, 'caller')
      if (!open) cancel(operation, 'disposed')
      if (operation.cause !== undefined) throw unavailable()
      timer = setTimeout(() => cancel(operation, 'timeout'), timeoutMs)
      try {
        executionLease = authenticatedExecution.acquire(operation.controller.signal)
        const executionSignal = executionLease.signal
        const argv = await resolveSubprocessArgv(
          ctx,
          agentHook.argv(['workspace-lease', action, '--format', 'json']),
          executionSignal,
        )
        operation.handle = executionLease.spawn({
          argv,
          // The request carries the authoritative workspace. Shell cwd is a
          // fixed runtime directory and never participates in canonicalization.
          cwd: agentHook.stateDir,
          stdio: {
            stdin: { data: payload },
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: executionSignal,
          env: isolatedNilsEnvironment(undefined),
        })
      } catch {
        throw unavailable()
      }
      const handle = operation.handle
      const done = Promise.resolve(handle.done).then(
        outcome => ({ kind: (('done') as const), outcome }),
        () => ({ kind: (('failed') as const), outcome: undefined }),
      )
      const first = await Promise.race([
        done,
        operation.cancelled.then(() => ({
          kind: (('cancelled') as const),
          outcome: undefined,
        })),
      ])
      const quiescent = await boundedQuiescence(handle)
      if (!quiescent) degrade()
      if (operation.cause !== undefined
        || first.kind !== 'done'
        || first.outcome === undefined
        || first.outcome.exitCode !== 0
        || first.outcome.signal !== null
        || !quiescent) throw unavailable()
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined
        || stdout.lossy
        || Buffer.byteLength(stdout.text, 'utf8') > MAX_OUTPUT_BYTES) throw unavailable()
      try {
        return JSON.parse(stdout.text)
      } catch {
        throw unavailable()
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      executionLease?.release()
      signal.removeEventListener('abort', onCallerAbort)
      active.delete(operation)
      operation.resolveSettled()
    }
  }

  return Object.freeze({
    protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
    async resolve(request, signal) {
      return resolveResult(await invoke('resolve', resolveWire(request), signal))
    },
    async bind(request, signal) {
      return bindResult(await invoke('bind', bindWire(request), signal))
    },
    async begin(request, signal) {
      return beginResult(await invoke('begin', beginWire(request), signal))
    },
    async complete(request, signal) {
      completeResult(await invoke('complete', completeWire(request), signal))
    },
    async renew(request, signal) {
      return renewResult(await invoke('renew', renewWire(request), signal))
    },
    async release(request, signal) {
      releaseResult(await invoke('release', releaseWire(request), signal))
    },
  })
}

/**
 * Activate the runtime-owned service and register exactly one nils provider.
 * The provider transport effect is installed before registration so Cordis'
 * reverse disposal order releases durable authority before closing transport.
 */
export async function applyNilsWorkspaceLease(ctx: Context, config: Parameters<typeof createNilsWorkspaceLeaseProvider>[1] = {}) {
  await ctx.plugin(WorkspaceLease)
  const service = ((ctx.get('workspaceLease')) as {registerProvider(provider: WorkspaceLeaseProvider): unknown} | undefined)
  if (service === undefined || typeof service.registerProvider !== 'function') throw unavailable()
  const provider = createNilsWorkspaceLeaseProvider(ctx, config)
  service.registerProvider(provider)
}
