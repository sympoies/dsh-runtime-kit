// @ts-check

import { randomUUID } from 'node:crypto'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDispatchExecution} ToolDispatchExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionResult} ToolExecutionResult */

const DEFAULT_MAX_SAME_TURN_STEERS = 2
const HARD_MAX_SAME_TURN_STEERS = 4
const MAX_STEERING_TEXT_BYTES = 4 * 1024
const CAPABILITY_REFRESH_INTERVAL_MS = 60 * 60 * 1_000
const MUTATING_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/**
 * @typedef FinishLineIdentity
 * @property {'dsh'} product
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} cwd
 */

/**
 * @typedef FinishLineClient
 * @property {(request: FinishLineIdentity, signal?: AbortSignal) => Promise<{runnerCapability: string, correlationId: string}>} open
 * @property {(request: FinishLineIdentity) => void} abandonOpen
 * @property {(request: FinishLineIdentity & {operationId: string}, signal?: AbortSignal) => Promise<{status: 'registered' | 'duplicate', operationId: string, generation: number, correlationId: string}>} beginEdit
 * @property {(request: FinishLineIdentity & {operationId: string}) => void} abandonBegin
 * @property {(request: FinishLineIdentity & {runnerCapability: string}, signal?: AbortSignal) => Promise<{correlationId: string}>} release
 * @property {(request: FinishLineIdentity & {operationId: string, runnerCapability: string, intent: string, command: string, timeoutMs: number, execution?: unknown, environment?: Record<string, string>}, signal?: AbortSignal) => Promise<{status: 'not-applicable' | 'ordinary-ready' | 'ready' | 'ordinary-applied' | 'applied' | 'duplicate' | 'stale' | 'superseded', operationId: string, generation?: number, correlationId: string, execution?: {exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean, timeoutMs: number, stdout: {text: string, truncated: boolean}, stderr: {text: string, truncated: boolean}, sandbox?: {mode: string, denied: boolean, enforcement?: string}}}>} run
 * @property {(request: FinishLineIdentity, signal?: AbortSignal) => Promise<{action: 'allow' | 'block', generation: number, contractDigest: string, correlationId: string, reasonCodes: string[], remediation: string[]}>} stop
 * @property {() => Promise<void>} drain
 * @property {() => Promise<void>} dispose
 * @property {number} active
 * @property {boolean} degraded
 */

/**
 * @typedef CallIdentity
 * @property {Readonly<ToolExecution>} exec
 * @property {ToolExecution['token']} token
 * @property {ToolExecution['parent']} parent
 * @property {unknown} arguments
 * @property {ToolExecution['agent']} agent
 * @property {Agent['session']} session
 * @property {AbortSignal} signal
 * @property {string} callId
 * @property {string} rootCallId
 * @property {string} name
 * @property {FinishLineIdentity} identity
 */

/**
 * @typedef SessionLedger
 * @property {Agent['session']} session
 * @property {FinishLineIdentity} identity
 * @property {string | undefined} runnerCapability
 * @property {Promise<void> | undefined} runnerCapabilityOpening
 * @property {number | undefined} runnerCapabilityRefreshedAt
 * @property {string | undefined} correlationId
 * @property {string | undefined} poison
 * @property {number | undefined} steeringTurn
 * @property {number} steeringCount
 */

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function boundedPositiveInteger(value, fallback, maximum) {
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

/** @param {string} value @param {number} maximum */
function boundedUtf8(value, maximum) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximum) return value
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = maximum; end >= Math.max(0, maximum - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {}
  }
  return ''
}

/** @param {FinishLineIdentity} identity */
function finishLineIdentityKey(identity) {
  return JSON.stringify([identity.product, identity.sessionId, identity.cwd])
}

/** @param {ToolExecution} exec */
function operationFor(exec) {
  if (exec.name === 'write' || exec.name === 'edit') return { kind: /** @type {const} */ ('edit') }
  const args = record(exec.arguments)
  if (exec.name === 'str_replace_editor') {
    return typeof args?.command === 'string' && MUTATING_EDITOR_COMMANDS.has(args.command)
      ? { kind: /** @type {const} */ ('edit') }
      : undefined
  }
  if (exec.name !== 'bash') return undefined
  if (args?.run_in_background === true) {
    return { unsupported: /** @type {const} */ ('background') }
  }
  if (typeof args?.command !== 'string'
    || args.command.trim().length === 0
    || args.command.includes('\0')
    || typeof args.description !== 'string'
    || args.description.trim().length === 0) {
    return { invalid: /** @type {const} */ (true) }
  }
  if (args.timeoutMs !== undefined
    && (typeof args.timeoutMs !== 'number'
      || !Number.isFinite(args.timeoutMs)
      || args.timeoutMs <= 0)) {
    return { invalid: /** @type {const} */ (true) }
  }
  return {
    kind: /** @type {const} */ ('validation'),
    intent: 'project-dev',
    command: args.command,
    timeoutMs: args.timeoutMs,
    workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
    sandboxPermissions: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : undefined,
    justification: typeof args.justification === 'string' ? args.justification : undefined,
  }
}

/** @param {CallIdentity} prepared @param {Readonly<ToolExecution>} exec */
function matches(prepared, exec) {
  return prepared.exec === exec
    && prepared.token === exec.token
    && prepared.parent === exec.parent
    && prepared.arguments === exec.arguments
    && prepared.agent === exec.agent
    && prepared.session === exec.agent?.session
    && prepared.signal === exec.signal
    && prepared.callId === exec.callId
    && prepared.rootCallId === exec.rootCallId
    && prepared.name === exec.name
}

/**
 * @param {Context} ctx
 * @param {{client: FinishLineClient, HarnessError?: new (message: string, code?: string) => Error, TOOL_ABORTED?: string, maxSameTurnSteers?: number, createOperationId?: () => string, now?: () => number, prepareValidationRuntime?: (exec: ToolDispatchExecution, operation: {kind: 'validation' | 'ordinary', intent: string, command: string, timeoutMs: number | undefined, workdir: string | undefined, sandboxPermissions: string | undefined, justification: string | undefined}) => Promise<{timeoutMs: number, execution: unknown, environment?: Record<string, string>}>, createSteeringMessage: (text: string) => import('@deepseek-ai/dsh-llm').UserMessage}} options
 */
export function createFinishLineCoordinator(ctx, options) {
  const HarnessError = options.HarnessError ?? Error
  const TOOL_ABORTED = options.TOOL_ABORTED ?? 'ABORTED'
  const client = options.client
  const maxSameTurnSteers = boundedPositiveInteger(
    options.maxSameTurnSteers,
    DEFAULT_MAX_SAME_TURN_STEERS,
    HARD_MAX_SAME_TURN_STEERS,
  )
  const createOperationId = options.createOperationId ?? (() => `dsh:${randomUUID()}`)
  const now = options.now ?? Date.now
  const prepareValidationRuntime = options.prepareValidationRuntime ?? (async (_exec, operation) => ({
    timeoutMs: operation.timeoutMs ?? 30 * 60 * 1_000,
    execution: {
      kind: 'bash-v1',
      workdir: process.cwd(),
      outputMaxBytes: 64 * 1024,
      runner: { kind: 'unsandboxed' },
    },
    environment: undefined,
  }))
  /** @type {Map<Readonly<ToolExecution>, CallIdentity>} */
  const preparedEdits = new Map()
  /** @type {Map<Readonly<ToolExecution>, CallIdentity>} */
  const validationCalls = new Map()
  /** @type {WeakSet<Readonly<ToolExecution>>} */
  const settledValidations = new WeakSet()
  /** @type {Map<Agent['session'], SessionLedger>} */
  const ledgers = new Map()
  /** @type {Set<Promise<void>>} */
  const releaseTasks = new Set()
  /** @type {Map<string, Promise<void>>} */
  const releaseTasksByIdentity = new Map()
  let open = true
  let releaseDegraded = false

  /** @param {Agent['session']} session @param {FinishLineIdentity} identity */
  function ledgerFor(session, identity) {
    const existing = ledgers.get(session)
    if (existing !== undefined) {
      if (existing.identity.sessionId !== identity.sessionId || existing.identity.cwd !== identity.cwd) {
        existing.poison = 'identity'
      }
      return existing
    }
    /** @type {SessionLedger} */
    const created = {
      session,
      identity,
      runnerCapability: undefined,
      runnerCapabilityOpening: undefined,
      runnerCapabilityRefreshedAt: undefined,
      correlationId: undefined,
      poison: undefined,
      steeringTurn: undefined,
      steeringCount: 0,
    }
    ledgers.set(session, created)
    return created
  }

  /** @param {SessionLedger} ledger @param {string} reason */
  function poison(ledger, reason) {
    ledger.poison ??= reason
  }

  /** @param {SessionLedger} ledger @param {string} correlationId */
  function acceptCorrelation(ledger, correlationId) {
    if (ledger.correlationId === undefined) {
      ledger.correlationId = correlationId
      return
    }
    if (ledger.correlationId !== correlationId) {
      poison(ledger, 'response-correlation')
      throw new Error('dsh-runtime-kit: finish-line response correlation invalid')
    }
  }

  /** @param {SessionLedger} ledger @param {FinishLineIdentity} identity @param {AbortSignal} signal */
  async function ensureRunnerCapability(ledger, identity, signal) {
    const currentCapability = ledger.runnerCapability
    if (currentCapability !== undefined
      && ledger.runnerCapabilityRefreshedAt !== undefined
      && now() - ledger.runnerCapabilityRefreshedAt < CAPABILITY_REFRESH_INTERVAL_MS) return
    if (ledger.runnerCapabilityOpening === undefined) {
      /** @type {Promise<void>} */
      let opening
      opening = (async () => {
        let opened
        try {
          opened = await client.open(identity, signal)
        } catch (error) {
          if (signal.aborted) throw error
          opened = await client.open(identity, signal)
        }
        acceptCorrelation(ledger, opened.correlationId)
        if (currentCapability !== undefined && opened.runnerCapability !== currentCapability) {
          throw new Error('dsh-runtime-kit: finish-line capability changed during renewal')
        }
        ledger.runnerCapability = opened.runnerCapability
        ledger.runnerCapabilityRefreshedAt = now()
      })().catch(error => {
        if (ledger.runnerCapability === undefined) client.abandonOpen(identity)
        throw error
      }).finally(() => {
        if (ledger.runnerCapabilityOpening === opening) {
          ledger.runnerCapabilityOpening = undefined
        }
      })
      ledger.runnerCapabilityOpening = opening
    }
    await ledger.runnerCapabilityOpening
    if (ledger.runnerCapability === undefined) {
      throw new Error('dsh-runtime-kit: finish-line capability unavailable')
    }
  }

  /** @param {Agent['session']} session @param {SessionLedger} ledger */
  async function releaseLedger(session, ledger) {
    for (const prepared of preparedEdits.values()) {
      if (prepared.session === session) {
        releaseDegraded = true
        poison(ledger, 'release-active')
        return
      }
    }
    for (const prepared of validationCalls.values()) {
      if (prepared.session === session) {
        releaseDegraded = true
        poison(ledger, 'release-active')
        return
      }
    }
    if (ledger.runnerCapabilityOpening !== undefined) {
      try { await ledger.runnerCapabilityOpening } catch {}
    }
    if (ledger.runnerCapability === undefined) {
      client.abandonOpen(ledger.identity)
      ledgers.delete(session)
      return
    }
    const request = {
      ...ledger.identity,
      runnerCapability: ledger.runnerCapability,
    }
    try {
      let released
      try {
        released = await client.release(request)
      } catch {
        released = await client.release(request)
      }
      acceptCorrelation(ledger, released.correlationId)
      ledgers.delete(session)
    } catch {
      releaseDegraded = true
      poison(ledger, 'release-persistence')
    }
  }

  /** @param {Agent['session']} session */
  function queueRelease(session) {
    const ledger = ledgers.get(session)
    if (ledger === undefined) return Promise.resolve()
    const identityKey = finishLineIdentityKey(ledger.identity)
    const existing = releaseTasksByIdentity.get(identityKey)
    if (existing !== undefined) return existing
    const task = releaseLedger(session, ledger)
    releaseTasks.add(task)
    releaseTasksByIdentity.set(identityKey, task)
    const settled = () => {
      releaseTasks.delete(task)
      if (releaseTasksByIdentity.get(identityKey) === task) {
        releaseTasksByIdentity.delete(identityKey)
      }
    }
    void task.then(settled, settled)
    return task
  }

  /** @param {FinishLineIdentity} identity */
  async function awaitPriorRelease(identity) {
    const pending = releaseTasksByIdentity.get(finishLineIdentityKey(identity))
    if (pending !== undefined) await pending
  }

  async function drainReleaseTasks() {
    for (;;) {
      const pending = [...releaseTasks]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /** @param {SessionLedger} ledger @param {number} turn @param {string} text @param {Agent} agent */
  function steer(ledger, turn, text, agent) {
    if (ledger.steeringTurn !== turn) {
      ledger.steeringTurn = turn
      ledger.steeringCount = 0
    }
    if (ledger.steeringCount >= maxSameTurnSteers) {
      throw new Error('dsh-runtime-kit: finish-line same-turn steering limit reached')
    }
    ledger.steeringCount += 1
    agent.steer(options.createSteeringMessage(boundedUtf8(text, MAX_STEERING_TEXT_BYTES)))
  }

  async function dispose() {
    if (!open) return
    open = false
    await client.drain()
    for (const session of ledgers.keys()) queueRelease(session)
    await drainReleaseTasks()
    preparedEdits.clear()
    validationCalls.clear()
    await client.dispose()
    ledgers.clear()
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit finish-line coordinator')

  return Object.freeze({
    /**
     * @param {ToolExecution} exec
     * @param {{sessionId: string, cwd: string, turn: number, callId: string, rootCallId: string, name: string}} call
     */
    async begin(exec, call) {
      if (!open) return { ok: false, reason: 'finish-line-disposed' }
      if (releaseDegraded) return { ok: false, reason: 'finish-line-unavailable' }
      const operation = operationFor(exec)
      if (operation === undefined) return { ok: true }
      if ('invalid' in operation) return { ok: false, reason: 'finish-line-operation-invalid' }
      if ('unsupported' in operation) {
        return { ok: false, reason: 'finish-line-background-unsupported' }
      }
      const session = exec.agent?.session
      if (session === undefined) return { ok: false, reason: 'finish-line-session-missing' }
      const identity = {
        product: /** @type {const} */ ('dsh'),
        sessionId: call.sessionId,
        turnId: String(call.turn),
        cwd: call.cwd,
      }
      await awaitPriorRelease(identity)
      if (!open) return { ok: false, reason: 'finish-line-disposed' }
      if (releaseDegraded) return { ok: false, reason: 'finish-line-unavailable' }
      const ledger = ledgerFor(session, identity)
      if (ledger.poison !== undefined) return { ok: false, reason: 'finish-line-unavailable' }
      /** @type {CallIdentity} */
      const prepared = {
        exec,
        token: exec.token,
        parent: exec.parent,
        arguments: exec.arguments,
        agent: exec.agent,
        session,
        signal: exec.signal,
        callId: call.callId,
        rootCallId: call.rootCallId,
        name: call.name,
        identity,
      }
      if (operation.kind === 'validation') {
        validationCalls.set(exec, prepared)
        return { ok: true }
      }
      const operationId = createOperationId()
      const beginRequest = { ...identity, operationId }
      try {
        let result
        try {
          result = await client.beginEdit(beginRequest, exec.signal)
        } catch (error) {
          if (exec.signal.aborted) throw error
          result = await client.beginEdit(beginRequest, exec.signal)
        }
        if (result.operationId !== operationId || result.correlationId.length === 0) {
          poison(ledger, 'begin-correlation')
          return { ok: false, reason: 'finish-line-correlation-invalid' }
        }
        acceptCorrelation(ledger, result.correlationId)
        preparedEdits.set(exec, prepared)
        return { ok: true }
      } catch {
        client.abandonBegin(beginRequest)
        poison(ledger, 'begin-persistence')
        return { ok: false, reason: 'finish-line-unavailable' }
      }
    },

    /**
     * @param {ToolDispatchExecution} exec
     * @returns {Promise<{kind: 'delegate'} | {kind: 'result', result: ToolExecutionResult}>}
     */
    async execute(exec) {
      const operation = operationFor(/** @type {ToolExecution} */ (exec))
      if (operation?.kind !== 'validation') return { kind: 'delegate' }
      const prepared = validationCalls.get(exec)
      validationCalls.delete(exec)
      if (prepared === undefined || !matches(prepared, exec)) {
        if (prepared !== undefined) poison(ledgerFor(prepared.session, prepared.identity), 'execute-correlation')
        throw new Error('dsh-runtime-kit: finish-line validation correlation invalid')
      }
      const ledger = ledgerFor(prepared.session, prepared.identity)
      try {
        await ensureRunnerCapability(ledger, prepared.identity, exec.signal)
        const operationId = createOperationId()
        const candidate = {
          ...prepared.identity,
          operationId,
          runnerCapability: /** @type {string} */ (ledger.runnerCapability),
          intent: operation.intent,
          command: operation.command,
          timeoutMs: 1,
        }
        let result = await client.run(candidate, exec.signal)
        acceptCorrelation(ledger, result.correlationId)
        if (result.operationId !== operationId && result.status !== 'not-applicable') {
          throw new Error('finish-line run correlation invalid')
        }
        if (!['ready', 'ordinary-ready'].includes(result.status)) {
          throw new Error('finish-line probe response invalid')
        }
        const ordinary = result.status === 'ordinary-ready'
        const runtime = await prepareValidationRuntime(exec, {
          ...operation,
          kind: ordinary ? 'ordinary' : 'validation',
        })
        result = await client.run({
          ...candidate,
          timeoutMs: runtime.timeoutMs,
          execution: runtime.execution,
          ...runtime.environment === undefined ? {} : { environment: runtime.environment },
        }, exec.signal)
        acceptCorrelation(ledger, result.correlationId)
        if (result.operationId !== operationId
          || ['not-applicable', 'ordinary-ready', 'ready'].includes(result.status)
          || (ordinary && !['ordinary-applied', 'duplicate'].includes(result.status))
          || (!ordinary && result.status === 'ordinary-applied')) {
          throw new Error('finish-line run correlation invalid')
        }
        if (result.execution === undefined) throw new Error('finish-line execution missing')
        settledValidations.add(exec)
        if (result.execution.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        return {
          kind: 'result',
          result: {
            isError: false,
            content: [],
            value: {
              kind: 'foreground',
              exitCode: result.execution.exitCode,
              signal: result.execution.signal,
              timedOut: result.execution.timedOut,
              aborted: result.execution.aborted,
              timeoutMs: result.execution.timeoutMs,
              stdout: result.execution.stdout,
              stderr: result.execution.stderr,
              ...result.execution.sandbox === undefined ? {} : { sandbox: result.execution.sandbox },
            },
          },
        }
      } catch (error) {
        poison(ledger, 'validation-runner')
        throw error
      }
    },

    /** @param {unknown} _target @param {unknown} _observation @param {unknown} _actor */
    observeFs(_target, _observation, _actor) {},

    /** @param {Readonly<ToolExecution>} exec @param {Readonly<ToolExecutionResult>} _result */
    result(exec, _result) {
      preparedEdits.delete(exec)
      if (settledValidations.has(exec)) {
        settledValidations.delete(exec)
        return
      }
      const prepared = validationCalls.get(exec)
      validationCalls.delete(exec)
      if (prepared !== undefined) poison(ledgerFor(prepared.session, prepared.identity), 'validation-dispatch-missing')
    },

    /** @param {{agent: Agent, turn: number, signal: AbortSignal}} payload @param {boolean} correlated */
    async turnStopping(payload, correlated) {
      const sessionId = String(payload.agent?.id ?? '')
      const cwd = payload.agent?.session?.header?.cwd
      if (sessionId.length === 0 || typeof cwd !== 'string') {
        throw new Error('dsh-runtime-kit: finish-line stop identity invalid')
      }
      const identity = {
        product: /** @type {const} */ ('dsh'),
        sessionId,
        turnId: String(payload.turn),
        cwd,
      }
      await awaitPriorRelease(identity)
      if (!open || releaseDegraded) {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const ledger = ledgerFor(payload.agent.session, identity)
      if (!correlated) poison(ledger, 'stop-correlation')
      if (ledger.poison !== undefined) {
        steer(ledger, payload.turn, 'Finish-line state is unavailable. Do not stop; repair the runtime boundary and retry.', payload.agent)
        return false
      }
      const decision = await client.stop(identity, payload.signal)
      try {
        acceptCorrelation(ledger, decision.correlationId)
      } catch {
        steer(ledger, payload.turn, 'Finish-line response identity changed. Do not stop; repair the runtime boundary and retry.', payload.agent)
        return false
      }
      if (decision.action === 'block') {
        const details = [...decision.reasonCodes, ...decision.remediation].join('; ')
        steer(ledger, payload.turn, `Finish-line blocked: ${details}`, payload.agent)
        return false
      }
      await queueRelease(payload.agent.session)
      if (releaseDegraded || ledgers.has(payload.agent.session)) {
        steer(ledger, payload.turn, 'Finish-line release is unavailable. Do not stop; repair the runtime boundary and retry.', payload.agent)
        return false
      }
      return true
    },

    /** @param {Agent} agent */
    agentDisposed(agent) {
      return queueRelease(agent.session)
    },

    async dispose() { await dispose() },
    get activeReservations() { return preparedEdits.size + validationCalls.size },
    get trackedSessions() { return ledgers.size },
    get maxSameTurnSteers() { return maxSameTurnSteers },
    get degraded() {
      return releaseDegraded || [...ledgers.values()].some(ledger => ledger.poison !== undefined)
    },
  })
}
