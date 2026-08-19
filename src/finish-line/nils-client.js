// @ts-check

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000
const HARD_TIMEOUT_MS = 60 * 60 * 1_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const HARD_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE = 4
const HARD_MAX_ACTIVE = 16
const MAX_OPEN_RETRY_TOKENS = 64
const MAX_BEGIN_RETRY_TOKENS = 128
const VALIDATION_SETTLEMENT_GRACE_MS = 1_000
const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const MAX_PROVIDER_ARGV_ENTRIES = 256
const MAX_PROVIDER_ARGV_BYTES = 48 * 1024
const MAX_ENVIRONMENT_ENTRIES = 128
const SHELL_ENV_KEYS = new Set(['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER'])
const NODE_SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP',
  'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL',
  'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS',
  'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG',
  'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
  'SIGBREAK', 'SIGLOST', 'SIGINFO',
])
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/

/**
 * @typedef ActiveRequest
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
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/** @param {unknown} value */
function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

/** @param {import('./index.js').FinishLineIdentity} identity */
function identityPayload(identity) {
  if (identity.product !== 'dsh'
    || !identifier(identity.sessionId)
    || !identifier(identity.turnId)
    || typeof identity.cwd !== 'string'
    || !isAbsolute(identity.cwd)
    || identity.cwd.includes('\0')) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return {
    product: 'dsh',
    session_id: identity.sessionId,
    turn_id: identity.turnId,
    cwd: identity.cwd,
  }
}

/** @param {import('./index.js').FinishLineIdentity & {operationId: string}} request */
function beginRetryKey(request) {
  return JSON.stringify([
    request.product,
    request.sessionId,
    request.turnId,
    request.cwd,
    request.operationId,
  ])
}

/** @param {import('./index.js').FinishLineIdentity} identity */
function openRetryKey(identity) {
  return JSON.stringify([
    identity.product,
    identity.sessionId,
    identity.cwd,
  ])
}

/** @param {Record<string, unknown>} request */
function serialize(request) {
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return payload
}

/** @param {unknown} envelope @param {string} schema */
function envelopeData(envelope, schema) {
  const value = record(envelope)
  const data = record(value?.data)
  if (value?.schema_version !== schema || value?.ok !== true || data === undefined) {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return data
}

/** @param {unknown} value */
function stream(value) {
  const data = record(value)
  if (typeof data?.text !== 'string' || typeof data?.truncated !== 'boolean') {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return { text: data.text, truncated: data.truncated }
}

/** @param {unknown} value */
function execution(value) {
  const data = record(value)
  const hasExit = typeof data?.exit_code === 'number' && Number.isInteger(data.exit_code)
  const hasSignal = typeof data?.signal === 'string' && NODE_SIGNALS.has(data.signal)
  if (data === undefined
    || !(data.exit_code === null || hasExit)
    || !(data.signal === null || hasSignal)
    || hasExit === hasSignal
    || typeof data.timed_out !== 'boolean'
    || typeof data.aborted !== 'boolean'
    || (data.timed_out && data.aborted)
    || typeof data.timeout_ms !== 'number'
    || !Number.isInteger(data.timeout_ms)
    || data.timeout_ms <= 0) {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  const sandbox = record(data.sandbox)
  if (sandbox !== undefined
    && (!['read-only', 'workspace-write', 'danger-full-access'].includes(/** @type {string} */ (sandbox.mode))
      || typeof sandbox.denied !== 'boolean'
      || (sandbox.enforcement !== undefined && !['full', 'partial'].includes(/** @type {string} */ (sandbox.enforcement))))) {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return {
    exitCode: /** @type {number | null} */ (data.exit_code),
    signal: /** @type {NodeJS.Signals | null} */ (data.signal),
    timedOut: data.timed_out,
    aborted: data.aborted,
    timeoutMs: data.timeout_ms,
    stdout: stream(data.stdout),
    stderr: stream(data.stderr),
    ...sandbox === undefined ? {} : {
      sandbox: {
        mode: /** @type {string} */ (sandbox.mode),
        denied: /** @type {boolean} */ (sandbox.denied),
        ...sandbox.enforcement === undefined
          ? {}
          : { enforcement: /** @type {string} */ (sandbox.enforcement) },
      },
    },
  }
}

/** @param {unknown} value @param {string} command */
function providerArgv(value, command) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)
    || value.length < 4
    || value.length > MAX_PROVIDER_ARGV_ENTRIES
    || !value.every(argument => typeof argument === 'string' && argument.length > 0 && !argument.includes('\0'))
    || Buffer.byteLength(value.join(''), 'utf8') > MAX_PROVIDER_ARGV_BYTES
    || value.at(-4) !== '--'
    || value.at(-3) !== 'bash'
    || value.at(-2) !== '-c'
    || value.at(-1) !== command) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return /** @type {string[]} */ (value)
}

/** @param {unknown} value */
function environment(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_ENVIRONMENT_ENTRIES
    || entries.some(([key, entry]) => (!SHELL_ENV_KEYS.has(key) && !/^DSH_[A-Z0-9_]+$/u.test(key))
      || typeof entry !== 'string'
      || entry.includes('\0'))) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
}

/** @param {unknown} value */
function boundedSignatures(value) {
  if (!Array.isArray(value)
    || value.length > 32
    || !value.every(entry => typeof entry === 'string'
      && entry.trim().length > 0
      && Buffer.byteLength(entry, 'utf8') <= 512
      && !/[\r\n\0]/u.test(entry))) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return /** @type {string[]} */ (value)
}

/** @param {unknown} value */
function runnerFailureRules(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return value.map(raw => {
    const rule = record(raw)
    const allowed = rule?.allowedExitCodes
    if (rule === undefined
      || (allowed !== undefined && (!Array.isArray(allowed)
        || allowed.length === 0
        || allowed.length > 32
        || !allowed.every(code => Number.isInteger(code) && code > 0 && code <= 255)))) {
      throw new Error('dsh-runtime-kit: finish-line request invalid')
    }
    const fatal = boundedSignatures(rule.fatalSignatures)
    const informational = boundedSignatures(rule.informationalLines ?? [])
    if (fatal.length === 0) throw new Error('dsh-runtime-kit: finish-line request invalid')
    return {
      ...allowed === undefined ? {} : { allowed_exit_codes: allowed },
      fatal_signatures: fatal,
      informational_lines: informational,
    }
  })
}

/** @param {unknown} value @param {string} command */
function runExecution(value, command) {
  const execution = record(value)
  const runner = record(execution?.runner)
  if (execution?.kind !== 'bash-v1'
    || typeof execution.workdir !== 'string'
    || !isAbsolute(execution.workdir)
    || execution.workdir.includes('\0')
    || !Number.isInteger(execution.outputMaxBytes)
    || /** @type {number} */ (execution.outputMaxBytes) <= 0
    || /** @type {number} */ (execution.outputMaxBytes) > 64 * 1024
    || runner === undefined) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  let wireRunner
  if (runner.kind === 'unsandboxed' || runner.kind === 'danger-full-access') {
    if (Object.keys(runner).length !== 1) throw new Error('dsh-runtime-kit: finish-line request invalid')
    wireRunner = { kind: runner.kind }
  } else if (runner.kind === 'confined') {
    if (!['read-only', 'workspace-write'].includes(/** @type {string} */ (runner.mode))
      || !['full', 'partial'].includes(/** @type {string} */ (runner.enforcement))) {
      throw new Error('dsh-runtime-kit: finish-line request invalid')
    }
    wireRunner = {
      kind: 'confined',
      argv: providerArgv(runner.providerArgv, command),
      mode: runner.mode,
      enforcement: runner.enforcement,
      denial_signatures: boundedSignatures(runner.denialSignatures),
      runner_failure_rules: runnerFailureRules(runner.runnerFailureRules),
    }
  } else {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return {
    kind: 'bash-v1',
    workdir: execution.workdir,
    output_max_bytes: execution.outputMaxBytes,
    runner: wireRunner,
  }
}

/**
 * @param {Context} ctx
 * @param {{agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, finishLineTimeoutMs?: number, finishLineTeardownTimeoutMs?: number, maxActiveFinishLineRequests?: number}} config
 */
export function createNilsFinishLineClient(ctx, config = {}) {
  const agentHook = resolveAgentHookRuntime(config)
  const timeoutMs = positiveInteger(config.finishLineTimeoutMs, DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS)
  const teardownTimeoutMs = positiveInteger(
    config.finishLineTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    HARD_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = positiveInteger(config.maxActiveFinishLineRequests, DEFAULT_MAX_ACTIVE, HARD_MAX_ACTIVE)
  /** @type {Set<ActiveRequest>} */
  const active = new Set()
  /** @type {Set<Promise<boolean>>} */
  const cleanups = new Set()
  /** @type {Map<string, string>} */
  const openRetryTokens = new Map()
  /** @type {Map<string, string>} */
  const beginRetryTokens = new Map()
  let open = true
  let accepting = true
  let degraded = false

  /** @param {ActiveRequest} operation @param {ActiveRequest['cause']} cause */
  function cancel(operation, cause) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(new Error('dsh-runtime-kit finish-line request cancelled'))
    try { operation.handle?.terminate() } catch {}
  }

  /** @param {SubprocessHandle} handle */
  async function boundedQuiescence(handle) {
    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(new Error('dsh-runtime-kit finish-line teardown deadline exceeded'))
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

  /**
   * @param {Record<string, unknown>} request
   * @param {Readonly<Record<string, string>> | undefined} childEnvironment
   */
  async function quiesceCancelledRun(request, childEnvironment) {
    const payload = serialize({
      schema_version: 'agent-hook.finish-line.quiesce.v1',
      product: request.product,
      session_id: request.session_id,
      turn_id: request.turn_id,
      cwd: request.cwd,
      operation_id: request.operation_id,
      runner_capability: request.runner_capability,
    })
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: agentHook.argv(['finish-line', 'quiesce', '--format', 'json']),
        cwd: /** @type {string} */ (request.cwd),
        stdio: {
          stdin: { data: payload },
          stdout: { maxBytes: MAX_OUTPUT_BYTES },
          stderr: { maxBytes: MAX_ERROR_BYTES },
        },
        graceMs: 1_000,
        ...childEnvironment === undefined ? {} : { env: childEnvironment },
      })
    } catch {
      return false
    }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        try { handle.terminate() } catch {}
        resolve(undefined)
      }, teardownTimeoutMs + VALIDATION_SETTLEMENT_GRACE_MS)
    })
    try {
      const outcome = await Promise.race([
        Promise.resolve(handle.done).catch(() => undefined),
        deadline,
      ])
      const quiescent = await boundedQuiescence(handle)
      if (outcome === undefined
        || outcome.exitCode !== 0
        || outcome.signal !== null
        || !quiescent) {
        return false
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy) return false
      let envelope
      try { envelope = JSON.parse(stdout.text) } catch { return false }
      let data
      try {
        data = envelopeData(envelope, 'cli.agent-hook.finish-line-quiesce.v1')
      } catch {
        return false
      }
      return data.schema_version === 'agent-hook.finish-line.quiesce-result.v1'
        && data.status === 'quiescent'
        && data.operation_id === request.operation_id
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * @param {Record<string, unknown>} request
   * @param {Readonly<Record<string, string>> | undefined} childEnvironment
   */
  async function trackedQuiescence(request, childEnvironment) {
    const cleanup = quiesceCancelledRun(request, childEnvironment)
    cleanups.add(cleanup)
    try {
      return await cleanup
    } finally {
      cleanups.delete(cleanup)
    }
  }

  function degrade() {
    degraded = true
    accepting = false
    open = false
    for (const operation of active) cancel(operation, 'degraded')
  }

  /**
   * @param {'open' | 'begin' | 'run' | 'stop' | 'release'} action
   * @param {Record<string, unknown>} request
   * @param {AbortSignal | undefined} callerSignal
   * @param {Readonly<Record<string, string>> | undefined} childEnvironment
   * @param {number} requestTimeoutMs
   */
  async function invoke(
    action,
    request,
    callerSignal,
    childEnvironment = undefined,
    requestTimeoutMs = timeoutMs,
  ) {
    const payload = serialize(request)
    if (!open || degraded || (!accepting && action !== 'release')) {
      throw new Error('dsh-runtime-kit: finish-line unavailable')
    }
    if (callerSignal?.aborted) throw new Error('dsh-runtime-kit: finish-line request cancelled')
    if (active.size >= maxActive) throw new Error('dsh-runtime-kit: finish-line overloaded')

    let resolveCancelled = () => {}
    /** @type {Promise<void>} */
    const cancelled = new Promise(resolve => { resolveCancelled = () => resolve() })
    let resolveSettled = () => {}
    /** @type {Promise<void>} */
    const settled = new Promise(resolve => { resolveSettled = () => resolve() })
    /** @type {ActiveRequest} */
    const operation = {
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
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    try {
      if (callerSignal?.aborted) cancel(operation, 'caller')
      if (!open || (!accepting && action !== 'release')) cancel(operation, 'disposed')
      if (operation.cause !== undefined) throw new Error('dsh-runtime-kit: finish-line request cancelled')
      try {
        operation.handle = ctx.subprocess.spawn({
          argv: agentHook.argv(['finish-line', action, '--format', 'json']),
          cwd: /** @type {string} */ (request.cwd),
          stdio: {
            stdin: { data: payload },
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: operation.controller.signal,
          ...childEnvironment === undefined ? {} : { env: childEnvironment },
        })
      } catch {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const handle = operation.handle
      timer = setTimeout(() => cancel(operation, 'timeout'), requestTimeoutMs)
      const done = Promise.resolve(handle.done).then(
        outcome => ({ kind: /** @type {const} */ ('done'), outcome }),
        () => ({ kind: /** @type {const} */ ('failed'), outcome: undefined }),
      )
      const first = await Promise.race([
        done,
        operation.cancelled.then(() => ({ kind: /** @type {const} */ ('cancelled'), outcome: undefined })),
      ])
      const quiescent = await boundedQuiescence(handle)
      if (!quiescent) degrade()
      if (operation.cause !== undefined) throw new Error('dsh-runtime-kit: finish-line request cancelled')
      if (first.kind !== 'done' || first.outcome === undefined || !quiescent) {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy || Buffer.byteLength(stdout.text, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      try { return { envelope: JSON.parse(stdout.text), outcome: first.outcome } } catch {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      active.delete(operation)
      operation.resolveSettled()
    }
  }

  async function drain() {
    accepting = false
    const pending = [...active]
    for (const operation of pending) cancel(operation, 'disposed')
    await Promise.allSettled(pending.map(operation => operation.settled))
    for (;;) {
      await Promise.resolve()
      const pendingCleanups = [...cleanups]
      if (pendingCleanups.length === 0) {
        await Promise.resolve()
        if (cleanups.size === 0) break
      } else {
        await Promise.allSettled(pendingCleanups)
      }
    }
  }

  async function dispose() {
    await drain()
    open = false
    openRetryTokens.clear()
    beginRetryTokens.clear()
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit nils finish-line client')

  return Object.freeze({
    drain,
    /** @param {import('./index.js').FinishLineIdentity} identity @param {AbortSignal} [signal] */
    async open(identity, signal) {
      const retryKey = openRetryKey(identity)
      let attemptToken = openRetryTokens.get(retryKey)
      if (attemptToken === undefined) {
        if (openRetryTokens.size >= MAX_OPEN_RETRY_TOKENS) {
          throw new Error('dsh-runtime-kit: finish-line overloaded')
        }
        attemptToken = `finish-line-open:${randomUUID()}`
        openRetryTokens.set(retryKey, attemptToken)
      }
      const { envelope, outcome } = await invoke('open', {
        schema_version: 'agent-hook.finish-line.open.v1',
        ...identityPayload(identity),
        attempt_token: attemptToken,
      }, signal)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-open.v1')
      if (data.schema_version !== 'agent-hook.finish-line.open-result.v1'
        || !['opened', 'duplicate'].includes(/** @type {string} */ (data.status))
        || !identifier(data.runner_capability)
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        runnerCapability: /** @type {string} */ (data.runner_capability),
        correlationId: /** @type {string} */ (data.correlation_id),
      }
    },

    /** @param {import('./index.js').FinishLineIdentity} identity */
    abandonOpen(identity) {
      openRetryTokens.delete(openRetryKey(identity))
    },

    /** @param {import('./index.js').FinishLineIdentity & {operationId: string}} request @param {AbortSignal} [signal] */
    async beginEdit(request, signal) {
      if (!identifier(request.operationId)) throw new Error('dsh-runtime-kit: finish-line request invalid')
      const retryKey = beginRetryKey(request)
      let attemptToken = beginRetryTokens.get(retryKey)
      if (attemptToken === undefined) {
        if (beginRetryTokens.size >= MAX_BEGIN_RETRY_TOKENS) {
          throw new Error('dsh-runtime-kit: finish-line overloaded')
        }
        attemptToken = `finish-line-edit:${randomUUID()}`
        beginRetryTokens.set(retryKey, attemptToken)
      }
      const { envelope, outcome } = await invoke('begin', {
        schema_version: 'agent-hook.finish-line.begin.v1',
        ...identityPayload(request),
        operation_id: request.operationId,
        attempt_token: attemptToken,
        operation: { kind: 'edit' },
      }, signal)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-begin.v1')
      if (data.schema_version !== 'agent-hook.finish-line.begin-result.v1'
        || !['registered', 'duplicate'].includes(/** @type {string} */ (data.status))
        || data.operation_id !== request.operationId
        || typeof data.generation !== 'number'
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      beginRetryTokens.delete(retryKey)
      return {
        status: /** @type {'registered' | 'duplicate'} */ (data.status),
        operationId: /** @type {string} */ (data.operation_id),
        generation: data.generation,
        correlationId: /** @type {string} */ (data.correlation_id),
      }
    },

    /** @param {import('./index.js').FinishLineIdentity & {operationId: string}} request */
    abandonBegin(request) {
      if (!identifier(request.operationId)) return
      beginRetryTokens.delete(beginRetryKey(request))
    },

    /** @param {import('./index.js').FinishLineIdentity & {runnerCapability: string}} request @param {AbortSignal} [signal] */
    async release(request, signal) {
      if (!identifier(request.runnerCapability)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const { envelope, outcome } = await invoke('release', {
        schema_version: 'agent-hook.finish-line.release.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
      }, signal)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-release.v1')
      if (data.schema_version !== 'agent-hook.finish-line.release-result.v1'
        || !['released', 'duplicate'].includes(/** @type {string} */ (data.status))
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      openRetryTokens.delete(openRetryKey(request))
      return { correlationId: /** @type {string} */ (data.correlation_id) }
    },

    /** @param {import('./index.js').FinishLineIdentity & {operationId: string, runnerCapability: string, intent: string, command: string, timeoutMs: number, execution?: unknown, environment?: Record<string, string>}} request @param {AbortSignal} [signal] */
    async run(request, signal) {
      if (!identifier(request.operationId)
        || !identifier(request.runnerCapability)
        || typeof request.intent !== 'string'
        || typeof request.command !== 'string'
        || !Number.isInteger(request.timeoutMs)
        || request.timeoutMs <= 0
        || request.timeoutMs > HARD_TIMEOUT_MS) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const resolvedExecution = request.execution === undefined
        ? undefined
        : runExecution(request.execution, request.command)
      const childEnvironment = environment(request.environment)
      if (resolvedExecution === undefined && childEnvironment !== undefined) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const requestTimeoutMs = resolvedExecution === undefined
        ? timeoutMs
        : Math.min(
          request.timeoutMs + teardownTimeoutMs + VALIDATION_SETTLEMENT_GRACE_MS,
          HARD_TIMEOUT_MS + HARD_TEARDOWN_TIMEOUT_MS + VALIDATION_SETTLEMENT_GRACE_MS,
        )
      const wireRequest = {
        schema_version: 'agent-hook.finish-line.run.v1',
        ...identityPayload(request),
        operation_id: request.operationId,
        runner_capability: request.runnerCapability,
        intent: request.intent,
        command: request.command,
        timeout_ms: request.timeoutMs,
        ...resolvedExecution === undefined ? {} : { execution: resolvedExecution },
      }
      let response
      try {
        response = await invoke(
          'run',
          wireRequest,
          signal,
          childEnvironment,
          requestTimeoutMs,
        )
      } catch (error) {
        if (resolvedExecution !== undefined
          && !await trackedQuiescence(wireRequest, childEnvironment)) {
          degrade()
        }
        throw error
      }
      const { envelope, outcome } = response
      try {
        if (outcome.exitCode !== 0 || outcome.signal !== null) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        const data = envelopeData(envelope, 'cli.agent-hook.finish-line-run.v1')
        const statuses = [
          'not-applicable',
          'ordinary-ready',
          'ready',
          'ordinary-applied',
          'applied',
          'duplicate',
          'stale',
          'superseded',
        ]
        if (data.schema_version !== 'agent-hook.finish-line.run-result.v1'
          || !statuses.includes(/** @type {string} */ (data.status))
          || data.operation_id !== request.operationId
          || !identifier(data.correlation_id)) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        if (data.status === 'not-applicable') {
          return {
            status: /** @type {const} */ ('not-applicable'),
            operationId: /** @type {string} */ (data.operation_id),
            correlationId: /** @type {string} */ (data.correlation_id),
          }
        }
        if (data.status === 'ready') {
          return {
            status: /** @type {const} */ ('ready'),
            operationId: /** @type {string} */ (data.operation_id),
            correlationId: /** @type {string} */ (data.correlation_id),
          }
        }
        if (data.status === 'ordinary-ready') {
          return {
            status: /** @type {const} */ ('ordinary-ready'),
            operationId: /** @type {string} */ (data.operation_id),
            correlationId: /** @type {string} */ (data.correlation_id),
          }
        }
        if (typeof data.generation !== 'number' || !Number.isInteger(data.generation)) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        return {
          status: /** @type {'ordinary-applied' | 'applied' | 'duplicate' | 'stale' | 'superseded'} */ (data.status),
          operationId: /** @type {string} */ (data.operation_id),
          generation: /** @type {number} */ (data.generation),
          correlationId: /** @type {string} */ (data.correlation_id),
          execution: execution(data.execution),
        }
      } catch (error) {
        if (resolvedExecution !== undefined
          && !await trackedQuiescence(wireRequest, childEnvironment)) {
          degrade()
        }
        throw error
      }
    },

    /** @param {import('./index.js').FinishLineIdentity} request @param {AbortSignal} [signal] */
    async stop(request, signal) {
      const { envelope, outcome } = await invoke('stop', {
        schema_version: 'agent-hook.finish-line.stop.v1',
        ...identityPayload(request),
      }, signal)
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-stop.v1')
      if (data.schema_version !== 'agent-hook.finish-line.stop-result.v1'
        || !['allow', 'block'].includes(/** @type {string} */ (data.action))
        || typeof data.generation !== 'number'
        || !identifier(data.contract_digest)
        || !identifier(data.correlation_id)
        || !Array.isArray(data.reason_codes)
        || !data.reason_codes.every(reason => typeof reason === 'string')
        || !Array.isArray(data.remediation)
        || !data.remediation.every(step => typeof step === 'string')) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const expectedExit = data.action === 'block' ? 1 : 0
      if (outcome.exitCode !== expectedExit || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        action: /** @type {'allow' | 'block'} */ (data.action),
        generation: data.generation,
        contractDigest: /** @type {string} */ (data.contract_digest),
        correlationId: /** @type {string} */ (data.correlation_id),
        reasonCodes: /** @type {string[]} */ (data.reason_codes),
        remediation: /** @type {string[]} */ (data.remediation),
      }
    },

    dispose,
    get active() { return active.size + cleanups.size },
    get degraded() { return degraded },
    timeoutMs,
    teardownTimeoutMs,
    maxActive,
  })
}
