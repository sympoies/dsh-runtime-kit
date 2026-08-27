// @ts-check

import { isAbsolute } from 'node:path'

import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import { isolatedNilsEnvironment } from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolRunContext} ToolRunContext */

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE = 2
const MAX_ACTIVE = 8
const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 192 * 1024
const MAX_ERROR_BYTES = 8 * 1024
const MAX_WORKTREES = 512
const MAX_DIRTY_ENTRIES = 2_048
const MAX_PATH_BYTES = 16 * 1024
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const DIRTY_STATES = new Set([
  'index-new',
  'index-modified',
  'index-deleted',
  'index-renamed',
  'index-typechange',
  'worktree-new',
  'worktree-modified',
  'worktree-deleted',
  'worktree-renamed',
  'worktree-typechange',
  'worktree-unreadable',
  'conflicted',
])
const EXPECTED_NILS_FAILURES = new Map([
  ['workspace-recovery-handoff-ineligible', 'WORKSPACE_RECOVERY_HANDOFF_INELIGIBLE'],
  ['workspace-recovery-handoff-dirty', 'WORKSPACE_RECOVERY_HANDOFF_DIRTY'],
  ['workspace-recovery-handoff-invalid', 'WORKSPACE_RECOVERY_HANDOFF_INVALID'],
  ['workspace-recovery-handoff-unavailable', 'WORKSPACE_RECOVERY_HANDOFF_UNAVAILABLE'],
])

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

/** @param {unknown} value @param {boolean} absolute */
function safePath(value, absolute) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES
    && !value.includes('\0')
    && (!absolute || isAbsolute(value))
}

/** @param {ToolRunContext} exec @param {(new (message: string, code: string) => Error) | undefined} HarnessError */
function executionScope(exec, HarnessError) {
  const agent = exec.agent
  const session = agent?.session
  const sessionId = session?.header?.id
  const cwd = session?.header?.cwd
  if (agent === undefined
    || session === undefined
    || typeof sessionId !== 'string'
    || sessionId.length === 0
    || agent.id !== session.id
    || session.id !== sessionId
    || !safePath(cwd, true)) {
    throw failure(
      HarnessError,
      'workspace recovery identity is invalid',
      'WORKSPACE_RECOVERY_IDENTITY_INVALID',
    )
  }
  return { cwd: /** @type {string} */ (cwd) }
}

/**
 * @param {(new (message: string, code: string) => Error) | undefined} HarnessError
 * @param {string} message
 * @param {string} code
 */
function failure(HarnessError, message, code) {
  if (HarnessError !== undefined) return new HarnessError(message, code)
  return Object.assign(new Error(message), { code })
}

/** @param {Record<string, unknown>} request @param {(new (message: string, code: string) => Error) | undefined} HarnessError */
function serialize(request, HarnessError) {
  let payload
  try { payload = JSON.stringify(request) } catch {
    throw failure(HarnessError, 'workspace recovery request is invalid', 'WORKSPACE_RECOVERY_REQUEST_INVALID')
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) {
    throw failure(HarnessError, 'workspace recovery request is too large', 'WORKSPACE_RECOVERY_REQUEST_INVALID')
  }
  return payload
}

/** @param {unknown} raw @param {'inspect'|'verify-handoff'} action */
function result(raw, action) {
  const envelope = record(raw)
  const expectedEnvelope = `cli.agent-hook.workspace-recovery-${action}.v1`
  if (envelope === undefined
    || envelope.schema_version !== expectedEnvelope
    || envelope.ok !== true) return undefined
  const data = record(envelope.data)
  if (data === undefined
    || data.schema_version !== 'agent-hook.workspace-recovery.result.v1'
    || data.action !== action
    || !['dirty', 'clean-now'].includes(data.state)) return undefined
  let serializedData
  try { serializedData = JSON.stringify(data) } catch { return undefined }
  if (Buffer.byteLength(serializedData, 'utf8') > MAX_RESULT_BYTES) return undefined
  const checkout = parseCheckout(data.checkout)
  if (checkout === undefined
    || !Array.isArray(data.worktrees)
    || data.worktrees.length > MAX_WORKTREES
    || !nonnegativeInteger(data.worktrees_omitted, true)) return undefined
  const worktrees = data.worktrees.map(parseWorktree)
  if (worktrees.some(value => value === undefined)) return undefined
  let handoff = null
  if (data.handoff !== null) {
    const value = record(data.handoff)
    if (value === undefined
      || value.status !== 'verified'
      || !safePath(value.path, true)
      || !safeText(value.branch)
      || !SHA.test(value.head)) return undefined
    handoff = Object.freeze({
      status: value.status,
      path: value.path,
      branch: value.branch,
      head: value.head,
    })
  }
  if (action === 'inspect' && handoff !== null) return undefined
  return Object.freeze({
    schema_version: data.schema_version,
    action,
    state: data.state,
    checkout,
    worktrees: /** @type {any[]} */ (worktrees),
    worktrees_omitted: data.worktrees_omitted ?? 0,
    handoff,
  })
}

/** @param {unknown} value @param {boolean} optional */
function nonnegativeInteger(value, optional = false) {
  return (optional && value === undefined)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

/** @param {unknown} value */
function safeText(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** @param {unknown} raw */
function parseCheckout(raw) {
  const value = record(raw)
  if (value === undefined
    || !safePath(value.path, true)
    || (value.branch !== null && !safeText(value.branch))
    || (value.head !== null && !SHA.test(value.head))
    || typeof value.managed !== 'boolean'
    || !Array.isArray(value.dirty_entries)
    || value.dirty_entries.length > MAX_DIRTY_ENTRIES
    || !nonnegativeInteger(value.dirty_entries_omitted, true)) return undefined
  const dirtyEntries = value.dirty_entries.map(rawEntry => {
    const entry = record(rawEntry)
    if (entry === undefined
      || !Array.isArray(entry.states)
      || entry.states.length === 0
      || !entry.states.every(state => typeof state === 'string' && DIRTY_STATES.has(state))
      || !safePath(entry.path, false)
      || typeof entry.lossy !== 'boolean') return undefined
    return Object.freeze({ states: [...entry.states], path: entry.path, lossy: entry.lossy })
  })
  if (dirtyEntries.some(entry => entry === undefined)) return undefined
  return Object.freeze({
    path: value.path,
    branch: value.branch,
    head: value.head,
    managed: value.managed,
    dirty_entries: /** @type {any[]} */ (dirtyEntries),
    dirty_entries_omitted: value.dirty_entries_omitted ?? 0,
  })
}

/** @param {unknown} raw */
function parseWorktree(raw) {
  const value = record(raw)
  if (value === undefined
    || !safePath(value.path, true)
    || (value.branch !== null && !safeText(value.branch))
    || (value.head !== null && !SHA.test(value.head))
    || !['bare', 'detached', 'prunable', 'managed'].every(field => typeof value[field] === 'boolean')) {
    return undefined
  }
  return Object.freeze({
    path: value.path,
    branch: value.branch,
    head: value.head,
    bare: value.bare,
    detached: value.detached,
    prunable: value.prunable,
    managed: value.managed,
  })
}

/** @param {unknown} raw @param {'inspect'|'verify-handoff'} action */
function nilsFailureCode(raw, action) {
  const envelope = record(raw)
  const error = record(envelope?.error)
  if (envelope === undefined
    || envelope.schema_version !== `cli.agent-hook.workspace-recovery-${action}.v1`
    || envelope.ok !== false
    || error === undefined
    || !safeText(error.code)
    || !safeText(error.message)) return undefined
  return EXPECTED_NILS_FAILURES.get(error.code)
}

/**
 * @param {Context} ctx
 * @param {{agentHook?:string, agentHookConfig?:string, agentHookPolicy?:string, agentHookStateDir?:string, authenticatedNilsExecution?:unknown, workspaceRecoveryTimeoutMs?:number, workspaceRecoveryTeardownTimeoutMs?:number, maxActiveWorkspaceRecoveryRequests?:number, HarnessError?:new (message:string, code:string)=>Error}} [config]
 */
export function createNilsWorkspaceRecoveryClient(ctx, config = {}) {
  const workspaceLease = ctx.get('workspaceLease')
  if (workspaceLease === undefined || typeof workspaceLease.denialState !== 'function') {
    throw new TypeError('dsh-runtime-kit: workspace recovery requires workspace lease diagnostics')
  }
  const agentHook = resolveAgentHookRuntime(config)
  const timeoutMs = positiveInteger(config.workspaceRecoveryTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const teardownTimeoutMs = positiveInteger(
    config.workspaceRecoveryTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    MAX_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = positiveInteger(
    config.maxActiveWorkspaceRecoveryRequests,
    DEFAULT_MAX_ACTIVE,
    MAX_ACTIVE,
  )
  const HarnessError = config.HarnessError
  const authenticatedExecution = resolveAuthenticatedNilsExecution(ctx, /** @type {any} */ (config))
  const active = new Set()
  const draining = new Set()
  let open = true
  let degraded = false

  /** @param {any} operation @param {'caller-aborted'|'timeout'|'disposed'|'degraded'} cause */
  function cancel(operation, cause) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(failure(HarnessError, 'workspace recovery cancelled', 'WORKSPACE_RECOVERY_CANCELLED'))
    try { operation.handle?.terminate() } catch {}
  }

  function degrade() {
    degraded = true
    open = false
    for (const operation of active) cancel(operation, 'degraded')
  }

  async function dispose() {
    open = false
    const pending = [...active]
    for (const operation of pending) cancel(operation, 'disposed')
    await Promise.allSettled([
      ...pending.map(operation => operation.settled),
      ...draining,
    ])
    await authenticatedExecution.dispose()
  }
  ctx.effect(() => dispose, 'dsh-runtime-kit nils workspace recovery client')

  /** @param {'inspect'|'verify-handoff'} action @param {Record<string, unknown>} request @param {AbortSignal} signal */
  async function invoke(action, request, signal) {
    if (!open || degraded) {
      throw failure(HarnessError, 'workspace recovery is unavailable', 'WORKSPACE_RECOVERY_UNAVAILABLE')
    }
    if (signal.aborted) {
      throw failure(HarnessError, 'workspace recovery was cancelled', 'WORKSPACE_RECOVERY_CANCELLED')
    }
    if (active.size >= maxActive) {
      throw failure(HarnessError, 'workspace recovery is overloaded', 'WORKSPACE_RECOVERY_OVERLOADED')
    }
    const payload = serialize(request, HarnessError)
    let resolveCancelled = () => {}
    const cancelled = new Promise(resolve => { resolveCancelled = () => { resolve(undefined) } })
    let resolveSettled = () => {}
    const settled = new Promise(resolve => { resolveSettled = () => { resolve(undefined) } })
    const operation = {
      controller: new AbortController(),
      handle: /** @type {SubprocessHandle | undefined} */ (undefined),
      cause: /** @type {string | undefined} */ (undefined),
      resolveCancelled,
      settled,
      resolveSettled,
    }
    active.add(operation)
    const onAbort = () => cancel(operation, 'caller-aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => cancel(operation, 'timeout'), timeoutMs)
    let executionLease
    let quiescence
    try {
      executionLease = authenticatedExecution.acquire(operation.controller.signal)
      const executionSignal = executionLease.signal
      const argv = await resolveSubprocessArgv(
        ctx,
        agentHook.argv(['workspace-recovery', action, '--format', 'json']),
        executionSignal,
      )
      if (operation.cause !== undefined || !open || executionSignal.aborted) {
        throw failure(HarnessError, 'workspace recovery was cancelled', 'WORKSPACE_RECOVERY_CANCELLED')
      }
      operation.handle = executionLease.spawn({
        argv,
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
      const handle = operation.handle
      quiescence = Promise.resolve()
        .then(() => handle.waitForExit())
        .then(value => value === true, () => false)
      const done = Promise.resolve(handle.done).then(
        outcome => ({ kind: /** @type {const} */ ('done'), outcome }),
        () => ({ kind: /** @type {const} */ ('failed'), outcome: undefined }),
      )
      const first = await Promise.race([
        done,
        cancelled.then(() => ({ kind: /** @type {const} */ ('cancelled'), outcome: undefined })),
      ])
      if (first.kind !== 'done') {
        try { handle.terminate() } catch {}
      }
      let teardownTimer
      const quiescent = await Promise.race([
        quiescence,
        new Promise(resolve => {
          teardownTimer = setTimeout(() => resolve(false), teardownTimeoutMs)
        }),
      ])
      if (teardownTimer !== undefined) clearTimeout(teardownTimer)
      if (!quiescent) {
        try { handle.terminate() } catch {}
        degrade()
      }
      if (operation.cause !== undefined) {
        const code = operation.cause === 'timeout'
          ? 'WORKSPACE_RECOVERY_TIMEOUT'
          : 'WORKSPACE_RECOVERY_CANCELLED'
        throw failure(HarnessError, 'workspace recovery did not complete', code)
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy || Buffer.byteLength(stdout.text, 'utf8') > MAX_OUTPUT_BYTES) {
        throw failure(HarnessError, 'workspace recovery output is invalid', 'WORKSPACE_RECOVERY_OUTPUT_INVALID')
      }
      let parsed
      try { parsed = JSON.parse(stdout.text) } catch {
        throw failure(HarnessError, 'workspace recovery output is invalid', 'WORKSPACE_RECOVERY_OUTPUT_INVALID')
      }
      if (first.kind !== 'done' || first.outcome === undefined || first.outcome.signal !== null) {
        throw failure(HarnessError, 'workspace recovery is unavailable', 'WORKSPACE_RECOVERY_UNAVAILABLE')
      }
      if (first.outcome.exitCode !== 0) {
        const code = nilsFailureCode(parsed, action)
        throw failure(
          HarnessError,
          'workspace recovery request was denied',
          code ?? 'WORKSPACE_RECOVERY_UNAVAILABLE',
        )
      }
      const projected = result(parsed, action)
      if (projected === undefined || !quiescent) {
        throw failure(HarnessError, 'workspace recovery output is invalid', 'WORKSPACE_RECOVERY_OUTPUT_INVALID')
      }
      return projected
    } finally {
      clearTimeout(timer)
      executionLease?.release()
      signal.removeEventListener('abort', onAbort)
      active.delete(operation)
      if (quiescence === undefined) {
        resolveSettled()
      } else {
        const drain = Promise.resolve(quiescence).finally(() => {
          draining.delete(drain)
          resolveSettled()
        })
        draining.add(drain)
      }
    }
  }

  return Object.freeze({
    /** @param {ToolRunContext} exec */
    async inspect(exec) {
      const scope = executionScope(exec, HarnessError)
      const lease = await workspaceLease.denialState(exec.agent)
      const projected = await invoke('inspect', {
        schema_version: 'agent-hook.workspace-recovery.inspect.v1',
        version: 1,
        cwd: scope.cwd,
      }, exec.signal)
      return Object.freeze({
        ...projected,
        schema_version: 'dsh-runtime-kit.workspace-recovery.v1',
        lease,
      })
    },
    /** @param {ToolRunContext} exec @param {string} path */
    async verifyHandoff(exec, path) {
      const scope = executionScope(exec, HarnessError)
      if (!safePath(path, true)) {
        throw failure(HarnessError, 'workspace recovery handoff path is invalid', 'WORKSPACE_RECOVERY_HANDOFF_INVALID')
      }
      const lease = await workspaceLease.denialState(exec.agent)
      const projected = await invoke('verify-handoff', {
        schema_version: 'agent-hook.workspace-recovery.verify-handoff.v1',
        version: 1,
        cwd: scope.cwd,
        handoff_path: path,
      }, exec.signal)
      return Object.freeze({
        ...projected,
        schema_version: 'dsh-runtime-kit.workspace-recovery.v1',
        lease,
      })
    },
  })
}
