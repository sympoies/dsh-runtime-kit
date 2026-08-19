// @ts-check

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { runtimeContextPhase } from './intents.js'
import { requiredAbsolutePath } from '../nils/agent-hook-runtime.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolRunContext} ToolRunContext */

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

/** @typedef {'caller-aborted' | 'timeout' | 'disposed' | 'degraded'} CancellationCause */

/**
 * @typedef ActiveOperation
 * @property {AbortController} controller
 * @property {SubprocessHandle | undefined} handle
 * @property {CancellationCause | undefined} cause
 * @property {(cause: CancellationCause, reason?: unknown) => void} cancel
 * @property {Promise<void>} cancelled
 * @property {() => void} resolveCancelled
 * @property {Promise<void>} settled
 * @property {() => void} resolveSettled
 */

/** @param {string} reason */
function failure(reason) {
  return new Error(`dsh-runtime-kit:runtime-context-${reason}`)
}

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function boundedPositiveInteger(value, fallback, maximum) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

/** @param {unknown} value @param {string} field */
function optionalAbsolutePath(value, field) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`dsh-runtime-kit: ${field} must be an absolute path`)
  }
  return value
}

/** @param {unknown} value @param {string} fallback @param {string} field */
function commandName(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`dsh-runtime-kit: ${field} must be a non-empty executable name`)
  }
  return value
}

/** @param {unknown} value @param {readonly string[]} expected */
function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

/** @param {unknown} value */
function validDocument(value) {
  if (!hasExactKeys(value, ['source', 'scope', 'content'])) return false
  const document = /** @type {Record<string, unknown>} */ (value)
  return (document.source === 'home' || document.source === 'project')
    && ['home', 'project', 'global'].includes(String(document.scope))
    && typeof document.content === 'string'
}

/**
 * @param {unknown} envelope
 * @param {string} requestId
 * @param {string} intent
 * @param {string | undefined} phase
 * @param {number} maxBytes
 */
function parseSuccess(envelope, requestId, intent, phase, maxBytes) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'data'])) return undefined
  const outer = /** @type {Record<string, any>} */ (envelope)
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
    /** @param {number} total @param {{ content: string }} document */
    (total, document) => total + Buffer.byteLength(document.content, 'utf8'),
    0,
  )
  return measured === decision.total_bytes ? decision : undefined
}

/** @param {unknown} envelope */
function parseFailureCode(envelope) {
  if (!hasExactKeys(envelope, ['schema_version', 'ok', 'error'])) return undefined
  const outer = /** @type {Record<string, any>} */ (envelope)
  if (outer.schema_version !== 'cli.agent-docs.session.context.v1'
    || outer.ok !== false
    || outer.error === null
    || typeof outer.error !== 'object'
    || typeof outer.error.code !== 'string'
    || !SAFE_ERROR_CODE.test(outer.error.code)) return undefined
  return outer.error.code
}

/** @param {ToolRunContext} exec */
function executionScope(exec) {
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
 *
 * @param {Context} ctx
 * @param {{ agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number }} config
 */
export function createNilsContextClient(ctx, config = {}) {
  const command = commandName(config.agentDocs, 'agent-docs', 'agentDocs')
  const docsHome = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
  const stateHome = requiredAbsolutePath(config.agentDocsStateHome, 'agentDocsStateHome')
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
  // JSON may encode one input byte as a six-byte escape (for example a
  // control character). Bound the worst valid encoding rather than silently
  // rejecting content that was within the advertised document budget.
  const stdoutBytes = maxBytes * 6 + CONTEXT_ENVELOPE_BYTES
  /** @type {Set<ActiveOperation>} */
  const active = new Set()
  let open = true
  let degraded = false

  /** @param {ActiveOperation} operation @param {CancellationCause} cause @param {unknown} [reason] */
  function cancelOperation(operation, cause, reason) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(reason)
    try { operation.handle?.terminate() } catch {}
  }

  /** @param {SubprocessHandle} handle */
  async function boundedQuiescence(handle) {
    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
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
    if (!open && active.size === 0) return
    open = false
    const pending = [...active]
    for (const operation of pending) {
      operation.cancel('disposed', failure('disposed'))
    }
    await Promise.allSettled(pending.map(operation => operation.settled))
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit agent-docs context transport')

  return Object.freeze({
    /** @param {ToolRunContext} exec @param {string} intent */
    async prepare(exec, intent) {
      const phase = runtimeContextPhase(intent)
      const { sessionId, cwd } = executionScope(exec)
      if (!open) throw failure(degraded ? 'unavailable' : 'disposed')
      if (exec.signal.aborted) throw failure('caller-aborted')
      if (active.size >= maxActive) throw failure('overloaded')

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

      let resolveSettled = () => {}
      /** @type {Promise<void>} */
      const settled = new Promise(resolve => { resolveSettled = () => resolve() })
      let resolveCancelled = () => {}
      /** @type {Promise<void>} */
      const cancelled = new Promise(resolve => { resolveCancelled = () => resolve() })
      /** @type {ActiveOperation} */
      const operation = {
        controller: new AbortController(),
        handle: undefined,
        cause: undefined,
        cancel: /** @type {ActiveOperation['cancel']} */ ((cause, reason) => {
          cancelOperation(operation, cause, reason)
        }),
        cancelled,
        resolveCancelled,
        settled,
        resolveSettled,
      }
      active.add(operation)
      const onCallerAbort = () => operation.cancel('caller-aborted', exec.signal.reason)
      exec.signal.addEventListener('abort', onCallerAbort, { once: true })
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      try {
        if (exec.signal.aborted) operation.cancel('caller-aborted', exec.signal.reason)
        if (!open) operation.cancel('disposed')
        if (operation.cause !== undefined) throw failure(operation.cause)
        try {
          operation.handle = ctx.subprocess.spawn({
            argv,
            cwd,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: stdoutBytes },
              stderr: { maxBytes: MAX_CONTEXT_ERROR_BYTES },
            },
            graceMs: 1_000,
            signal: operation.controller.signal,
          })
        } catch {
          if (operation.cause !== undefined) throw failure(operation.cause)
          throw failure('unavailable')
        }
        const handle = operation.handle
        if (operation.cause !== undefined) {
          try { handle.terminate() } catch {}
        }
        timer = setTimeout(() => {
          operation.cancel('timeout', failure('timeout'))
        }, timeoutMs)
        const doneObserved = Promise.resolve(handle.done).then(
          outcome => ({ kind: /** @type {const} */ ('done'), outcome, failed: false }),
          () => ({ kind: /** @type {const} */ ('done'), outcome: undefined, failed: true }),
        )
        const first = await Promise.race([
          doneObserved,
          operation.cancelled.then(() => ({
            kind: /** @type {const} */ ('cancelled'),
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
          const decision = parseSuccess(envelope, requestId, intent, phase, maxBytes)
          if (decision === undefined) throw failure('output-invalid')
          return decision
        }
        if (first.outcome.exitCode === null || first.outcome.signal !== null) {
          throw failure('exit-mismatch')
        }
        const code = parseFailureCode(envelope)
        if (code === undefined) throw failure('output-invalid')
        throw failure(`agent-docs-${code}`)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
        active.delete(operation)
        operation.resolveSettled()
      }
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
