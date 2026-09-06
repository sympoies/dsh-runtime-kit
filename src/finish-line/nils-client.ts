import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { resolveAuthenticatedNilsExecution } from '../nils/authenticated-execution.js'
import {
  authenticatedNilsEnvironment,
  isolatedNilsEnvironment,
  resolveManagedSessionPrincipal,
} from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

export type Context = import('@deepseek-ai/cordis').Context
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000
const HARD_TIMEOUT_MS = 60 * 60 * 1_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const HARD_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE = 4
const HARD_MAX_ACTIVE = 16
const MAX_OPEN_RETRY_TOKENS = 64
const MAX_BEGIN_RETRY_TOKENS = 128
const MAX_ACCEPTANCE_RETRY_TOKENS = 256
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
 * A provider-authoritative temporary conflict is a complete response, not an
 * ambiguous transport failure. Callers may reject the current host operation
 * without poisoning the session or retrying the same request under the live
 * repository reservation.
 */
export class DshFinishLineTemporaryError extends Error {
  name
  code
  providerCode

  constructor(providerCode: string) {
    super('dsh-runtime-kit: finish-line operation temporarily blocked')
    this.name = 'DshFinishLineTemporaryError'
    this.code = 'DSH_FINISH_LINE_TEMPORARY'
    this.providerCode = providerCode
  }
}

export type ActiveRequest = { action: 'open' | 'begin' | 'run' | 'stop' | 'release' | 'register' | 'admit' | 'observe' | 'verdict', controller: AbortController, handle: SubprocessHandle | undefined, cause: 'caller' | 'timeout' | 'disposed' | 'degraded' | undefined, cancelled: Promise<void>, resolveCancelled: () => void, settled: Promise<void>, resolveSettled: () => void }

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

function record(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? ((value) as Record<string, unknown>)
    : undefined
}

function identifier(value: unknown) {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function digestIdentifier(value: unknown) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function acceptanceExecution(value: unknown) {
  const input = record(value)
  if (input?.kind === 'host-observed' && Object.keys(input).length === 1) {
    return { kind: 'host-observed' }
  }
  if (input?.kind === 'contained-bash'
    && Object.keys(input).sort().join('\0') === 'command\0intent\0kind'
    && identifier(input.intent)
    && typeof input.command === 'string' && input.command.trim().length > 0
    && !input.command.includes('\0')) {
    return { kind: 'contained-bash', intent: input.intent, command: input.command }
  }
  throw new Error('dsh-runtime-kit: finish-line request invalid')
}

function acceptanceRegistration(value: unknown) {
  const input = record(value)
  if (input === undefined || !Array.isArray(input.requirements)
    || input.requirements.length < 1 || input.requirements.length > 128
    || !Array.isArray(input.invalidators) || input.invalidators.length > 128) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  const requirements = input.requirements.map(rawRequirement => {
    const requirement = record(rawRequirement)
    if (requirement === undefined || !identifier(requirement.name) || !Array.isArray(requirement.validators)
      || requirement.validators.length < 1 || requirement.validators.length > 16) {
      throw new Error('dsh-runtime-kit: finish-line request invalid')
    }
    return {
      name: requirement.name,
      validators: requirement.validators.map(rawValidator => {
        const validator = record(rawValidator)
        if (validator === undefined || !identifier(validator.id) || !identifier(validator.toolName)
          || !digestIdentifier(validator.definitionDigest)) {
          throw new Error('dsh-runtime-kit: finish-line request invalid')
        }
        return {
          id: validator.id,
          tool_name: validator.toolName,
          definition_digest: validator.definitionDigest,
          execution: acceptanceExecution(validator.execution),
        }
      }),
    }
  })
  const invalidators = input.invalidators.map(rawInvalidator => {
    const invalidator = record(rawInvalidator)
    if (invalidator === undefined || !identifier(invalidator.toolName)
      || !digestIdentifier(invalidator.definitionDigest)) {
      throw new Error('dsh-runtime-kit: finish-line request invalid')
    }
    return {
      tool_name: invalidator.toolName,
      definition_digest: invalidator.definitionDigest,
    }
  })
  return { requirements, invalidators }
}

function acceptanceOperation(value: unknown) {
  const input = record(value)
  if (input?.kind === 'mutation'
    && identifier(input.toolName) && digestIdentifier(input.definitionDigest)
    && Object.keys(input).sort().join('\0') === 'definitionDigest\0kind\0toolName') {
    return {
      kind: 'mutation',
      tool_name: input.toolName,
      definition_digest: input.definitionDigest,
    }
  }
  if (input?.kind === 'validator'
    && identifier(input.requirement) && identifier(input.validatorId)
    && identifier(input.toolName) && digestIdentifier(input.definitionDigest)
    && (input.sourceOperationId === undefined || identifier(input.sourceOperationId))) {
    const keys = Object.keys(input).sort().join('\0')
    const expected = input.sourceOperationId === undefined
      ? 'definitionDigest\0kind\0requirement\0toolName\0validatorId'
      : 'definitionDigest\0kind\0requirement\0sourceOperationId\0toolName\0validatorId'
    if (keys === expected) {
      return {
        kind: 'validator',
        requirement: input.requirement,
        validator_id: input.validatorId,
        tool_name: input.toolName,
        definition_digest: input.definitionDigest,
        ...input.sourceOperationId === undefined
          ? {}
          : { source_operation_id: input.sourceOperationId },
      }
    }
  }
  throw new Error('dsh-runtime-kit: finish-line request invalid')
}

function acceptanceObservation(value: unknown) {
  const input = record(value)
  if (input?.kind === 'contained-bash' && identifier(input.operationId)) {
    const keys = Object.keys(input).sort().join('\0')
    if (keys === 'kind\0operationId') {
      return { kind: 'contained-bash', operation_id: input.operationId }
    }
    if (keys === 'kind\0operationId\0status'
      && input.status === 'infrastructure-blocked') {
      return {
        kind: 'contained-bash',
        operation_id: input.operationId,
        status: 'infrastructure-blocked',
      }
    }
  }
  const statuses = [
    'succeeded', 'failed', 'cancelled', 'timed-out', 'signalled', 'uncertain',
    'infrastructure-blocked',
  ]
  if (input?.kind === 'host-observed' && statuses.includes(((input.status) as string))
    && Object.keys(input).sort().join('\0') === 'kind\0status') {
    return { kind: 'host-observed', status: input.status }
  }
  throw new Error('dsh-runtime-kit: finish-line request invalid')
}

function identityPayload(identity: import('./index.js').FinishLineIdentity) {
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

function beginRetryKey(request: import('./index.js').FinishLineIdentity & {operationId: string}) {
  return JSON.stringify([
    request.product,
    request.sessionId,
    request.turnId,
    request.cwd,
    request.operationId,
  ])
}

function openRetryKey(identity: import('./index.js').FinishLineIdentity) {
  return JSON.stringify([
    identity.product,
    identity.sessionId,
    identity.cwd,
  ])
}

function serialize(request: Record<string, unknown>) {
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return payload
}

function envelopeData(envelope: unknown, schema: string) {
  const value = record(envelope)
  const data = record(value?.data)
  if (value?.schema_version !== schema || value?.ok !== true || data === undefined) {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return data
}

function isExactNonRepositoryOpen(envelope: unknown, outcome: unknown) {
  const result = record(outcome)
  const value = record(envelope)
  const error = record(value?.error)
  return result?.exitCode === 65
    && result.signal === null
    && value?.schema_version === 'cli.agent-hook.finish-line-open.v1'
    && value.ok === false
    && error?.code === 'finish-line-not-in-repository'
    && typeof error.message === 'string'
    && error.message.length > 0
    && Buffer.byteLength(error.message, 'utf8') <= MAX_ERROR_BYTES
}

function throwTemporaryProviderError(envelope: unknown, outcome: unknown, schema: string) {
  const result = record(outcome)
  const value = record(envelope)
  const error = record(value?.error)
  const providerCode = typeof error?.code === 'string'
    && [
      'finish-line-completion-reserved',
      'finish-line-acceptance-mutation-active',
    ].includes(error.code)
    ? error.code
    : undefined
  if (result?.exitCode === 75 && result.signal === null
    && value?.schema_version === schema && value.ok === false
    && providerCode !== undefined
    && typeof error?.message === 'string' && error.message.length > 0) {
    throw new DshFinishLineTemporaryError(providerCode)
  }
}

function stream(value: unknown) {
  const data = record(value)
  if (typeof data?.text !== 'string' || typeof data?.truncated !== 'boolean') {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return { text: data.text, truncated: data.truncated }
}

function execution(value: unknown) {
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
    && (!['read-only', 'workspace-write', 'danger-full-access'].includes(((sandbox.mode) as string))
      || typeof sandbox.denied !== 'boolean'
      || (sandbox.enforcement !== undefined && !['full', 'partial'].includes(((sandbox.enforcement) as string))))) {
    throw new Error('dsh-runtime-kit: finish-line response invalid')
  }
  return {
    exitCode: ((data.exit_code) as number | null),
    signal: ((data.signal) as NodeJS.Signals | null),
    timedOut: data.timed_out,
    aborted: data.aborted,
    timeoutMs: data.timeout_ms,
    stdout: stream(data.stdout),
    stderr: stream(data.stderr),
    ...sandbox === undefined ? {} : {
      sandbox: {
        mode: ((sandbox.mode) as string),
        denied: ((sandbox.denied) as boolean),
        ...sandbox.enforcement === undefined
          ? {}
          : { enforcement: ((sandbox.enforcement) as string) },
      },
    },
  }
}

function providerArgv(value: unknown, command: string) {
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
  return ((value) as string[])
}

function environment(value: unknown) {
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

function boundedSignatures(value: unknown) {
  if (!Array.isArray(value)
    || value.length > 32
    || !value.every(entry => typeof entry === 'string'
      && entry.trim().length > 0
      && Buffer.byteLength(entry, 'utf8') <= 512
      && !/[\r\n\0]/u.test(entry))) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  return ((value) as string[])
}

function runnerFailureRules(value: unknown) {
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

function runExecution(value: unknown, command: string) {
  const execution = record(value)
  const runner = record(execution?.runner)
  if (execution?.kind !== 'bash-v1'
    || typeof execution.workdir !== 'string'
    || !isAbsolute(execution.workdir)
    || execution.workdir.includes('\0')
    || !Number.isInteger(execution.outputMaxBytes)
    || ((execution.outputMaxBytes) as number) <= 0
    || ((execution.outputMaxBytes) as number) > 64 * 1024
    || runner === undefined) {
    throw new Error('dsh-runtime-kit: finish-line request invalid')
  }
  let wireRunner
  if (runner.kind === 'unsandboxed' || runner.kind === 'danger-full-access') {
    if (Object.keys(runner).length !== 1) throw new Error('dsh-runtime-kit: finish-line request invalid')
    wireRunner = { kind: runner.kind }
  } else if (runner.kind === 'confined') {
    if (!['read-only', 'workspace-write'].includes(((runner.mode) as string))
      || !['full', 'partial'].includes(((runner.enforcement) as string))) {
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

export function createNilsFinishLineClient(ctx: Context, config: {agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, finishLineTimeoutMs?: number, finishLineTeardownTimeoutMs?: number, maxActiveFinishLineRequests?: number, managedSessionBridge?: {resolve?: (id:string) => unknown}} = {}) {
  const agentHook = resolveAgentHookRuntime(config)
  const timeoutMs = positiveInteger(config.finishLineTimeoutMs, DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS)
  const teardownTimeoutMs = positiveInteger(
    config.finishLineTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    HARD_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = positiveInteger(config.maxActiveFinishLineRequests, DEFAULT_MAX_ACTIVE, HARD_MAX_ACTIVE)
  const authenticatedExecution = resolveAuthenticatedNilsExecution(ctx, config)
  const managedSessionBridge = config.managedSessionBridge
  const active: Set<ActiveRequest> = new Set()
  const cleanups: Set<Promise<boolean>> = new Set()
  const openRetryTokens: Map<string, string> = new Map()
  const beginRetryTokens: Map<string, string> = new Map()
  const acceptanceRetryTokens: Map<string, string> = new Map()
  const pinnedPrincipals: Map<string, ReturnType<typeof resolveManagedSessionPrincipal> | null> = new Map()
  let open = true
  let accepting = true
  let degraded = false

  function principalKey(request: Record<string, unknown>) {
    const sessionId = typeof request.session_id === 'string'
      ? request.session_id
      : typeof request.sessionId === 'string'
        ? request.sessionId
        : ''
    return JSON.stringify([request.product, sessionId, request.cwd])
  }

  function pinnedPrincipal(request: Record<string, unknown>) {
    const key = principalKey(request)
    if (pinnedPrincipals.has(key)) return pinnedPrincipals.get(key) ?? undefined
    const sessionId = typeof request.session_id === 'string' ? request.session_id : ''
    const resolved = resolveManagedSessionPrincipal(ctx, sessionId, managedSessionBridge)
    const principal = resolved === undefined
      ? undefined
      : Object.freeze({
          sessionId: resolved.sessionId,
          environment: Object.freeze({ ...resolved.environment }),
        })
    pinnedPrincipals.set(key, principal ?? null)
    return principal
  }

  function retirePrincipal(request: Record<string, unknown>) {
    pinnedPrincipals.delete(principalKey(request))
  }

  function cancel(operation: ActiveRequest, cause: ActiveRequest['cause']) {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.resolveCancelled()
    operation.controller.abort(new Error('dsh-runtime-kit finish-line request cancelled'))
    try { operation.handle?.terminate() } catch {}
  }

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
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

  async function quiesceCancelledRun(request: Record<string, unknown>, childEnvironment: Readonly<NodeJS.ProcessEnv> | undefined) {
    const principal = pinnedPrincipal(request)
    const payload = serialize({
      schema_version: 'agent-hook.finish-line.quiesce.v1',
      product: request.product,
      session_id: principal?.sessionId ?? request.session_id,
      turn_id: request.turn_id,
      cwd: request.cwd,
      operation_id: request.operation_id,
      runner_capability: request.runner_capability,
    })
    let handle
    let executionLease: {signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined
    try {
      const explicitEnvironment = {
        ...childEnvironment,
        ...principal?.environment,
      }
      const environment = principal === undefined
        ? isolatedNilsEnvironment(childEnvironment)
        : authenticatedNilsEnvironment(explicitEnvironment)
      executionLease = authenticatedExecution.acquire(AbortSignal.timeout(teardownTimeoutMs))
      const argv = await resolveSubprocessArgv(
        ctx,
        agentHook.argv(['finish-line', 'quiesce', '--format', 'json']),
        executionLease.signal,
      )
      handle = executionLease.spawn({
        argv,
        cwd: ((request.cwd) as string),
        stdio: {
          stdin: { data: payload },
          stdout: { maxBytes: MAX_OUTPUT_BYTES },
          stderr: { maxBytes: MAX_ERROR_BYTES },
        },
        graceMs: 1_000,
        signal: executionLease.signal,
        env: environment,
      })
    } catch {
      executionLease?.release()
      return false
    }
    let timer: ReturnType<typeof setTimeout> | undefined
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
      executionLease?.release()
    }
  }

  async function trackedQuiescence(request: Record<string, unknown>, childEnvironment: Readonly<NodeJS.ProcessEnv> | undefined) {
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

  async function invoke(
    action: 'open' | 'begin' | 'run' | 'stop' | 'release' | 'register' | 'admit' | 'observe' | 'verdict',
    request: Record<string, unknown>,
    callerSignal: AbortSignal | undefined,
    childEnvironment: Readonly<NodeJS.ProcessEnv> | undefined = undefined,
    requestTimeoutMs: number = timeoutMs,
  ) {
    const principal = pinnedPrincipal(request)
    const payload = serialize(principal === undefined
      ? request
      : { ...request, session_id: principal.sessionId })
    if (!open || degraded || (!accepting && action !== 'release')) {
      throw new Error('dsh-runtime-kit: finish-line unavailable')
    }
    if (callerSignal?.aborted) throw new Error('dsh-runtime-kit: finish-line request cancelled')
    if (active.size >= maxActive) throw new Error('dsh-runtime-kit: finish-line overloaded')

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
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let executionLease: {signal: AbortSignal, release: () => void, spawn: (spec: Record<string, unknown>) => SubprocessHandle} | undefined
    try {
      if (callerSignal?.aborted) cancel(operation, 'caller')
      if (!open || (!accepting && action !== 'release')) cancel(operation, 'disposed')
      if (operation.cause !== undefined) throw new Error('dsh-runtime-kit: finish-line request cancelled')
      timer = setTimeout(() => cancel(operation, 'timeout'), requestTimeoutMs)
      try {
        executionLease = authenticatedExecution.acquire(operation.controller.signal)
        const executionSignal = executionLease.signal
        const explicitEnvironment = {
          ...childEnvironment,
          ...principal?.environment,
        }
        const environment = principal === undefined
          ? isolatedNilsEnvironment(childEnvironment)
          : authenticatedNilsEnvironment(explicitEnvironment)
        const argv = await resolveSubprocessArgv(
          ctx,
          agentHook.argv(['finish-line', action, '--format', 'json']),
          executionSignal,
        )
        operation.handle = executionLease.spawn({
          argv,
          cwd: ((request.cwd) as string),
          stdio: {
            stdin: { data: payload },
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: executionSignal,
          env: environment,
        })
      } catch {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const handle = operation.handle
      const done = Promise.resolve(handle.done).then(
        outcome => ({ kind: (('done') as const), outcome }),
        () => ({ kind: (('failed') as const), outcome: undefined }),
      )
      const first = await Promise.race([
        done,
        operation.cancelled.then(() => ({ kind: (('cancelled') as const), outcome: undefined })),
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
      executionLease?.release()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      active.delete(operation)
      operation.resolveSettled()
    }
  }

  async function drain() {
    accepting = false
    const releaseDeadlineAt = Date.now() + teardownTimeoutMs
    for (;;) {
      const pending = [...active]
      if (pending.length === 0) {
        await Promise.resolve()
        if (active.size === 0) break
        continue
      }
      const releases: ActiveRequest[] = []
      for (const operation of pending) {
        if (operation.action === 'release') releases.push(operation)
        else cancel(operation, 'disposed')
      }
      const releaseDeadline = releases.length === 0
        ? undefined
        : setTimeout(() => {
            for (const operation of releases) cancel(operation, 'disposed')
          }, Math.max(0, releaseDeadlineAt - Date.now()))
      try {
        await Promise.allSettled(pending.map(operation => operation.settled))
      } finally {
        if (releaseDeadline !== undefined) clearTimeout(releaseDeadline)
      }
    }
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
    try {
      await drain()
      open = false
      openRetryTokens.clear()
      beginRetryTokens.clear()
      acceptanceRetryTokens.clear()
      pinnedPrincipals.clear()
    } finally {
      await authenticatedExecution.dispose()
    }
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit nils finish-line client')

  return Object.freeze({
    drain,
    async open(identity: import('./index.js').FinishLineIdentity & {command?: string}, signal?: AbortSignal) {
      if (identity.command !== undefined
        && (typeof identity.command !== 'string'
          || identity.command.trim().length === 0
          || Buffer.byteLength(identity.command, 'utf8') > 16 * 1024)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
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
        ...(identity.command === undefined ? {} : { command: identity.command }),
      }, signal)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        if (isExactNonRepositoryOpen(envelope, outcome)) {
          openRetryTokens.delete(retryKey)
          retirePrincipal(identity)
          return { kind: (('not-in-repository') as const) }
        }
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-open.v1')
      if (data.schema_version !== 'agent-hook.finish-line.open-result.v1'
        || !['opened', 'duplicate'].includes(((data.status) as string))
        || !identifier(data.runner_capability)
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        runnerCapability: ((data.runner_capability) as string),
        correlationId: ((data.correlation_id) as string),
      }
    },

    abandonOpen(identity: import('./index.js').FinishLineIdentity) {
      openRetryTokens.delete(openRetryKey(identity))
      retirePrincipal(identity)
    },

    async beginEdit(request: import('./index.js').FinishLineIdentity & {operationId: string}, signal?: AbortSignal) {
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
        || !['registered', 'duplicate'].includes(((data.status) as string))
        || data.operation_id !== request.operationId
        || typeof data.generation !== 'number'
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      beginRetryTokens.delete(retryKey)
      return {
        status: ((data.status) as 'registered' | 'duplicate'),
        operationId: ((data.operation_id) as string),
        generation: data.generation,
        correlationId: ((data.correlation_id) as string),
      }
    },

    abandonBegin(request: import('./index.js').FinishLineIdentity & {operationId: string}) {
      if (!identifier(request.operationId)) return
      beginRetryTokens.delete(beginRetryKey(request))
    },

    async release(request: import('./index.js').FinishLineIdentity & {runnerCapability: string}, signal?: AbortSignal) {
      if (!identifier(request.runnerCapability)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const { envelope, outcome } = await invoke('release', {
        schema_version: 'agent-hook.finish-line.release.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
      }, signal, undefined, teardownTimeoutMs)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-release.v1')
      if (data.schema_version !== 'agent-hook.finish-line.release-result.v1'
        || !['released', 'duplicate'].includes(((data.status) as string))
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      openRetryTokens.delete(openRetryKey(request))
      retirePrincipal(request)
      return { correlationId: ((data.correlation_id) as string) }
    },

    async registerAcceptance(request: import('./index.js').FinishLineIdentity & {runnerCapability: string, requirements: unknown[], invalidators: unknown[]}, signal?: AbortSignal) {
      if (!identifier(request.runnerCapability)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const registration = acceptanceRegistration(request)
      const { envelope, outcome } = await invoke('register', {
        schema_version: 'agent-hook.finish-line.register.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
        ...registration,
      }, signal, undefined, teardownTimeoutMs)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-register.v1')
      if (data.schema_version !== 'agent-hook.finish-line.register-result.v1'
        || !['registered', 'duplicate'].includes(((data.status) as string))
        || !digestIdentifier(data.contract_digest)
        || !Number.isSafeInteger(data.requirement_count)
        || data.requirement_count !== registration.requirements.length
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        status: ((data.status) as 'registered' | 'duplicate'),
        contractDigest: ((data.contract_digest) as string),
        requirementCount: ((data.requirement_count) as number),
        correlationId: ((data.correlation_id) as string),
      }
    },

    async admitAcceptance(request: import('./index.js').FinishLineIdentity & {runnerCapability: string, contractDigest: string, operationId: string, operation: unknown}, signal?: AbortSignal) {
      if (!identifier(request.runnerCapability) || !digestIdentifier(request.contractDigest)
        || !identifier(request.operationId)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const operation = acceptanceOperation(request.operation)
      const retryKey = JSON.stringify([
        request.product, request.sessionId, request.cwd, request.operationId,
      ])
      let attemptToken = acceptanceRetryTokens.get(retryKey)
      if (attemptToken === undefined) {
        if (acceptanceRetryTokens.size >= MAX_ACCEPTANCE_RETRY_TOKENS) {
          throw new Error('dsh-runtime-kit: finish-line overloaded')
        }
        attemptToken = `finish-line-acceptance:${randomUUID()}`
        acceptanceRetryTokens.set(retryKey, attemptToken)
      }
      const { envelope, outcome } = await invoke('admit', {
        schema_version: 'agent-hook.finish-line.admit.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
        contract_digest: request.contractDigest,
        operation_id: request.operationId,
        attempt_token: attemptToken,
        operation,
      }, signal, undefined, teardownTimeoutMs)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throwTemporaryProviderError(envelope, outcome, 'cli.agent-hook.finish-line-admit.v1')
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-admit.v1')
      if (data.schema_version !== 'agent-hook.finish-line.admit-result.v1'
        || !['admitted', 'duplicate'].includes(((data.status) as string))
        || data.operation_id !== request.operationId
        || !['mutation', 'validator'].includes(((data.operation_kind) as string))
        || data.operation_kind !== operation.kind
        || typeof data.generation !== 'number'
        || !Number.isSafeInteger(data.generation) || data.generation < 0
        || data.contract_digest !== request.contractDigest
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      acceptanceRetryTokens.delete(retryKey)
      return {
        status: ((data.status) as 'admitted' | 'duplicate'),
        operationId: ((data.operation_id) as string),
        operationKind: ((data.operation_kind) as 'mutation' | 'validator'),
        generation: ((data.generation) as number),
        contractDigest: ((data.contract_digest) as string),
        correlationId: ((data.correlation_id) as string),
      }
    },

    abandonAcceptance(request: import('./index.js').FinishLineIdentity & {operationId: string}) {
      if (!identifier(request.operationId)) return
      const retryKey = JSON.stringify([
        request.product, request.sessionId, request.cwd, request.operationId,
      ])
      acceptanceRetryTokens.delete(retryKey)
    },

    async observeAcceptance(request: import('./index.js').FinishLineIdentity & {runnerCapability: string, operationId: string, observation: unknown}, signal?: AbortSignal) {
      if (!identifier(request.runnerCapability) || !identifier(request.operationId)) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const observation = acceptanceObservation(request.observation)
      const { envelope, outcome } = await invoke('observe', {
        schema_version: 'agent-hook.finish-line.observe.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
        operation_id: request.operationId,
        observation,
      }, signal, undefined, teardownTimeoutMs)
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-observe.v1')
      const statuses = ['applied', 'stale', 'superseded', 'duplicate']
      const observations = [
        'succeeded', 'failed', 'cancelled', 'timed-out', 'signalled', 'uncertain',
        'infrastructure-blocked',
      ]
      if (data.schema_version !== 'agent-hook.finish-line.observe-result.v1'
        || !statuses.includes(((data.status) as string))
        || data.operation_id !== request.operationId
        || typeof data.generation !== 'number'
        || !Number.isSafeInteger(data.generation) || data.generation < 0
        || !observations.includes(((data.observation) as string))
        || !identifier(data.correlation_id)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        status: ((data.status) as 'applied' | 'stale' | 'superseded'),
        operationId: ((data.operation_id) as string),
        generation: ((data.generation) as number),
        observation: ((data.observation) as string),
        correlationId: ((data.correlation_id) as string),
      }
    },

    async acceptanceVerdict(request: import('./index.js').FinishLineIdentity & {runnerCapability: string, contractDigest: string, completionReservation?: string}, signal?: AbortSignal) {
      if (!identifier(request.runnerCapability) || !digestIdentifier(request.contractDigest)
        || (request.completionReservation !== undefined
          && !identifier(request.completionReservation))) {
        throw new Error('dsh-runtime-kit: finish-line request invalid')
      }
      const { envelope, outcome } = await invoke('verdict', {
        schema_version: 'agent-hook.finish-line.verdict.v1',
        ...identityPayload(request),
        runner_capability: request.runnerCapability,
        contract_digest: request.contractDigest,
        ...request.completionReservation === undefined
          ? {}
          : { completion_reservation: { operation_id: request.completionReservation } },
      }, signal, undefined, teardownTimeoutMs)
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-verdict.v1')
      const statuses = [
        'satisfied', 'missing', 'failed', 'active', 'uncertain', 'infrastructure-blocked',
      ]
      if (data.schema_version !== 'agent-hook.finish-line.verdict-result.v1'
        || !['allow', 'block'].includes(((data.action) as string))
        || !statuses.includes(((data.aggregate) as string))
        || typeof data.generation !== 'number'
        || !Number.isSafeInteger(data.generation) || data.generation < 0
        || data.contract_digest !== request.contractDigest
        || !identifier(data.correlation_id)
        || !Array.isArray(data.reason_codes)
        || !data.reason_codes.every(reason => statuses.includes(reason))
        || !Array.isArray(data.requirements)
        || !(data.completion_reservation === null
          || (record(data.completion_reservation) !== undefined
            && identifier(record(data.completion_reservation)?.operation_id)
            && ['reserved', 'duplicate'].includes(
              ((record(data.completion_reservation)?.status) as string),
            )))) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      const requirements = data.requirements.map(raw => {
        const entry = record(raw)
        const attemptGeneration = entry?.attempt_generation
        if (entry === undefined || !identifier(entry.name)
          || !statuses.includes(((entry.status) as string))
          || !(attemptGeneration === null
            || (typeof attemptGeneration === 'number'
              && Number.isSafeInteger(attemptGeneration) && attemptGeneration >= 0))) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        return {
          name: ((entry.name) as string),
          status: ((entry.status) as string),
          attemptGeneration: attemptGeneration === null
            ? undefined
            : attemptGeneration,
        }
      })
      const expectedExit = data.action === 'allow' ? 0 : 1
      const reservation = record(data.completion_reservation)
      if (outcome.exitCode !== expectedExit || outcome.signal !== null
        || (data.action === 'allow') !== (data.aggregate === 'satisfied')
        || (request.completionReservation === undefined
          ? reservation !== undefined
          : data.action === 'allow'
            ? reservation?.operation_id !== request.completionReservation
            : reservation !== undefined)) {
        throw new Error('dsh-runtime-kit: finish-line response invalid')
      }
      return {
        action: ((data.action) as 'allow' | 'block'),
        aggregate: ((data.aggregate) as string),
        generation: ((data.generation) as number),
        contractDigest: ((data.contract_digest) as string),
        correlationId: ((data.correlation_id) as string),
        reasonCodes: ((data.reason_codes) as string[]),
        requirements,
        ...reservation === undefined
          ? {}
          : {
              completionReservation: {
                operationId: ((reservation.operation_id) as string),
                status: ((reservation.status) as 'reserved' | 'duplicate'),
              },
            },
      }
    },

    async run(request: import('./index.js').FinishLineIdentity & {operationId: string, runnerCapability: string, intent: string, command: string, timeoutMs: number, execution?: unknown, environment?: Record<string, string>}, signal?: AbortSignal) {
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
          || !statuses.includes(((data.status) as string))
          || data.operation_id !== request.operationId
          || !identifier(data.correlation_id)) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        if (data.status === 'not-applicable') {
          return {
            status: (('not-applicable') as const),
            operationId: ((data.operation_id) as string),
            correlationId: ((data.correlation_id) as string),
          }
        }
        if (data.status === 'ready') {
          return {
            status: (('ready') as const),
            operationId: ((data.operation_id) as string),
            correlationId: ((data.correlation_id) as string),
          }
        }
        if (data.status === 'ordinary-ready') {
          return {
            status: (('ordinary-ready') as const),
            operationId: ((data.operation_id) as string),
            correlationId: ((data.correlation_id) as string),
          }
        }
        if (typeof data.generation !== 'number' || !Number.isInteger(data.generation)) {
          throw new Error('dsh-runtime-kit: finish-line response invalid')
        }
        return {
          status: ((data.status) as 'ordinary-applied' | 'applied' | 'duplicate' | 'stale' | 'superseded'),
          operationId: ((data.operation_id) as string),
          generation: ((data.generation) as number),
          correlationId: ((data.correlation_id) as string),
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

    async stop(request: import('./index.js').FinishLineIdentity, signal?: AbortSignal) {
      const { envelope, outcome } = await invoke('stop', {
        schema_version: 'agent-hook.finish-line.stop.v1',
        ...identityPayload(request),
      }, signal)
      const data = envelopeData(envelope, 'cli.agent-hook.finish-line-stop.v1')
      if (data.schema_version !== 'agent-hook.finish-line.stop-result.v1'
        || !['allow', 'block'].includes(((data.action) as string))
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
        action: ((data.action) as 'allow' | 'block'),
        generation: data.generation,
        contractDigest: ((data.contract_digest) as string),
        correlationId: ((data.correlation_id) as string),
        reasonCodes: ((data.reason_codes) as string[]),
        remediation: ((data.remediation) as string[]),
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
