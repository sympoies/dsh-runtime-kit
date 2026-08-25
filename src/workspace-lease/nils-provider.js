// @ts-check

import { isAbsolute } from 'node:path'

import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import { isolatedNilsEnvironment } from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'
import {
  WORKSPACE_LEASE_PROTOCOL_VERSION,
  WORKSPACE_LEASE_UNAVAILABLE,
  WorkspaceLease,
  WorkspaceLeaseError,
} from './index.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */
/** @typedef {import('./index.js').WorkspaceLeaseProvider} WorkspaceLeaseProvider */

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

/**
 * @typedef ActiveRequest
 * @property {'bind' | 'begin' | 'complete' | 'renew' | 'release'} action
 * @property {AbortController} controller
 * @property {SubprocessHandle | undefined} handle
 * @property {'caller' | 'timeout' | 'disposed' | 'degraded' | undefined} cause
 * @property {Promise<void>} cancelled
 * @property {() => void} resolveCancelled
 * @property {Promise<void>} settled
 * @property {() => void} resolveSettled
 */

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function positiveInteger(value, fallback, maximum) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/** @param {Record<string, any>} value @param {readonly string[]} expected */
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index])
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES
    && PRINTABLE_TEXT.test(value)
}

/** @param {unknown} value */
function delay(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0
    && /** @type {number} */ (value) <= 2_147_483_647
}

/** @param {unknown} value */
function providerCode(value) {
  return typeof value === 'string' && PROVIDER_CODE.test(value)
}

/** @param {unknown} value */
function deniedState(value) {
  return typeof value === 'string' && DENIED_STATES.has(value)
}

/** @returns {WorkspaceLeaseError} */
function unavailable() {
  return new WorkspaceLeaseError(
    'workspace lease authority provider is unavailable',
    WORKSPACE_LEASE_UNAVAILABLE,
    'unavailable',
  )
}

/** @param {unknown} value @param {string} field */
function requiredWireText(value, field) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`dsh-runtime-kit: invalid workspace lease ${field}`)
  }
  return value
}

/** @param {import('./index.js').WorkspaceLeaseBindingFacts} request */
function bindingWire(request) {
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

/** @param {import('./index.js').WorkspaceLeaseBindRequest} request */
function bindWire(request) {
  if (request.cwd !== undefined
    && (typeof request.cwd !== 'string'
      || !isAbsolute(request.cwd)
      || request.cwd.includes('\0'))) throw unavailable()
  if (!['startup', 'resume', 'clear', 'compact'].includes(request.source)) throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.bind.v1',
    ...bindingWire(request),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    source: request.source,
  }
}

/** @param {import('./index.js').WorkspaceLeaseBeginRequest} request */
function beginWire(request) {
  if (!['owned', 'unmanaged'].includes(request.bindingState)
    || typeof request.nested !== 'boolean') throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.begin.v1',
    ...bindingWire(request),
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

/** @param {import('./index.js').WorkspaceLeaseCompleteRequest} request */
function completeWire(request) {
  if (!['succeeded', 'failed', 'cancelled'].includes(request.outcome)) throw unavailable()
  return {
    schema_version: 'agent-hook.workspace-lease.complete.v1',
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

/** @param {import('./index.js').WorkspaceLeaseRenewRequest} request */
function renewWire(request) {
  return {
    schema_version: 'agent-hook.workspace-lease.renew.v1',
    ...bindingWire(request),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
  }
}

/** @param {import('./index.js').WorkspaceLeaseReleaseRequest} request */
function releaseWire(request) {
  if (!['agent-disposed', 'session-rebound', 'provider-disposed'].includes(request.reason)) {
    throw unavailable()
  }
  return {
    schema_version: 'agent-hook.workspace-lease.release.v1',
    ...bindingWire(request),
    binding_id: requiredWireText(request.bindingId, 'binding id'),
    workspace_id: requiredWireText(request.workspaceId, 'workspace id'),
    generation: requiredWireText(request.generation, 'generation'),
    reason: request.reason,
  }
}

/** @param {Record<string, unknown>} request */
function serialize(request) {
  let payload
  try {
    payload = JSON.stringify(request)
  } catch {
    throw unavailable()
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) throw unavailable()
  return payload
}

/** @param {unknown} raw @param {string} schema */
function envelopeData(raw, schema) {
  const envelope = record(raw)
  if (envelope === undefined
    || !exactKeys(envelope, ['schema_version', 'ok', 'data'])
    || envelope.schema_version !== schema
    || envelope.ok !== true) throw unavailable()
  const data = record(envelope.data)
  if (data === undefined) throw unavailable()
  return data
}

/** @param {Record<string, any>} data @param {string} schema */
function denial(data, schema) {
  if (!exactKeys(data, ['schema_version', 'kind', 'state', 'code', 'reason'])
    || data.schema_version !== schema
    || !deniedState(data.state)
    || !providerCode(data.code)
    || !text(data.reason)) throw unavailable()
  return {
    kind: /** @type {const} */ ('denied'),
    state: data.state,
    code: data.code,
    reason: data.reason,
  }
}

/** @param {unknown} raw */
function bindResult(raw) {
  const schema = 'agent-hook.workspace-lease.bind-result.v1'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-bind.v1')
  if (data.kind === 'denied') return denial(data, schema)
  const required = ['schema_version', 'kind', 'binding_id', 'workspace_id', 'generation', 'state']
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
    kind: /** @type {const} */ ('bound'),
    bindingId: data.binding_id,
    workspaceId: data.workspace_id,
    generation: data.generation,
    state: data.state,
    ...(data.renew_after_ms === undefined ? {} : { renewAfterMs: data.renew_after_ms }),
  }
}

/** @param {unknown} raw */
function beginResult(raw) {
  const schema = 'agent-hook.workspace-lease.begin-result.v1'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-begin.v1')
  if (data.kind === 'denied') return denial(data, schema)
  if (data.kind === 'not-required') {
    if (!exactKeys(data, ['schema_version', 'kind']) || data.schema_version !== schema) {
      throw unavailable()
    }
    return { kind: /** @type {const} */ ('not-required') }
  }
  if (!exactKeys(data, ['schema_version', 'kind', 'operation_id', 'fence'])
    || data.schema_version !== schema
    || data.kind !== 'granted'
    || !text(data.operation_id)
    || !text(data.fence)) throw unavailable()
  return {
    kind: /** @type {const} */ ('granted'),
    operationId: data.operation_id,
    fence: data.fence,
  }
}

/** @param {unknown} raw */
function completeResult(raw) {
  const schema = 'agent-hook.workspace-lease.complete-result.v1'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-complete.v1')
  if (!exactKeys(data, ['schema_version', 'kind'])
    || data.schema_version !== schema
    || !['completed', 'duplicate'].includes(data.kind)) throw unavailable()
}

/** @param {unknown} raw */
function renewResult(raw) {
  const schema = 'agent-hook.workspace-lease.renew-result.v1'
  const data = envelopeData(raw, 'cli.agent-hook.workspace-lease-renew.v1')
  if (data.kind === 'lost') {
    const lost = denial({ ...data, kind: 'denied' }, schema)
    return { ...lost, kind: /** @type {const} */ ('lost') }
  }
  const required = ['schema_version', 'kind']
  const expected = data.renew_after_ms === undefined ? required : [...required, 'renew_after_ms']
  if (!exactKeys(data, expected)
    || data.schema_version !== schema
    || data.kind !== 'renewed'
    || (data.renew_after_ms !== undefined && !delay(data.renew_after_ms))) throw unavailable()
  return {
    kind: /** @type {const} */ ('renewed'),
    ...(data.renew_after_ms === undefined ? {} : { renewAfterMs: data.renew_after_ms }),
  }
}

/** @param {unknown} raw */
function releaseResult(raw) {
  const schema = 'agent-hook.workspace-lease.release-result.v1'
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
 *
 * @param {Context} ctx
 * @param {{
 *   agentHook?: string,
 *   agentHookConfig?: string,
 *   agentHookPolicy?: string,
 *   agentHookStateDir?: string,
 *   workspaceLeaseTimeoutMs?: number,
 *   workspaceLeaseTeardownTimeoutMs?: number,
 *   maxActiveWorkspaceLeaseRequests?: number,
 * }} [config]
 * @returns {WorkspaceLeaseProvider}
 */
export function createNilsWorkspaceLeaseProvider(ctx, config = {}) {
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
  /** @type {Set<ActiveRequest>} */
  const active = new Set()
  let open = true
  let degraded = false

  /** @param {ActiveRequest} operation @param {ActiveRequest['cause']} cause */
  function cancel(operation, cause) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(unavailable())
    try { operation.handle?.terminate() } catch {}
  }

  /** @param {SubprocessHandle} handle */
  async function boundedQuiescence(handle) {
    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
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

  /**
   * @param {'bind' | 'begin' | 'complete' | 'renew' | 'release'} action
   * @param {Record<string, unknown>} request
   * @param {AbortSignal} signal
   */
  async function invoke(action, request, signal) {
    const payload = serialize(request)
    if (!open || degraded || signal.aborted || active.size >= maxActive) throw unavailable()
    let resolveCancelled = () => {}
    /** @type {Promise<void>} */
    const cancelled = new Promise(resolve => { resolveCancelled = () => resolve() })
    let resolveSettled = () => {}
    /** @type {Promise<void>} */
    const settled = new Promise(resolve => { resolveSettled = () => resolve() })
    /** @type {ActiveRequest} */
    const operation = {
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
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    /** @type {{signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined} */
    let executionLease
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
        outcome => ({ kind: /** @type {const} */ ('done'), outcome }),
        () => ({ kind: /** @type {const} */ ('failed'), outcome: undefined }),
      )
      const first = await Promise.race([
        done,
        operation.cancelled.then(() => ({
          kind: /** @type {const} */ ('cancelled'),
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
 *
 * @param {Context} ctx
 * @param {Parameters<typeof createNilsWorkspaceLeaseProvider>[1]} [config]
 */
export async function applyNilsWorkspaceLease(ctx, config = {}) {
  await ctx.plugin(WorkspaceLease)
  const service = /** @type {{registerProvider(provider: WorkspaceLeaseProvider): unknown} | undefined} */ (
    ctx.get('workspaceLease')
  )
  if (service === undefined || typeof service.registerProvider !== 'function') throw unavailable()
  const provider = createNilsWorkspaceLeaseProvider(ctx, config)
  service.registerProvider(provider)
}
