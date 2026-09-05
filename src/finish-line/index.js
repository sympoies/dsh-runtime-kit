// @ts-check

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDispatchExecution} ToolDispatchExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionResult} ToolExecutionResult */

const DEFAULT_MAX_SAME_TURN_STEERS = 2
const DEFAULT_FINISH_LINE_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000
const HARD_MAX_SAME_TURN_STEERS = 4
const MAX_STEERING_TEXT_BYTES = 4 * 1024
const CAPABILITY_REFRESH_INTERVAL_MS = 60 * 60 * 1_000
const MUTATING_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/**
 * Keep ordinary shell calls on the shell provider's default while preserving
 * the finish-line contract for an exact validation that omits a timeout.
 *
 * @param {'validation' | 'ordinary'} kind
 * @param {number | undefined} timeoutMs
 */
export function resolveFinishLineShellTimeout(kind, timeoutMs) {
  return timeoutMs ?? (kind === 'validation' ? DEFAULT_FINISH_LINE_COMMAND_TIMEOUT_MS : undefined)
}

/**
 * @typedef FinishLineIdentity
 * @property {'dsh'} product
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} cwd
 */

/**
 * @typedef FinishLineClient
 * @property {(request: FinishLineIdentity & {command?: string}, signal?: AbortSignal) => Promise<{runnerCapability: string, correlationId: string} | {kind: 'not-in-repository'}>} open
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
 * @property {string} callId
 * @property {string} rootCallId
 * @property {string} name
 * @property {FinishLineIdentity} identity
 */

/**
 * @typedef ValidationCall
 * @property {CallIdentity} prepared
 * @property {{kind: 'validation', intent: string, command: string, timeoutMs: number | undefined, workdir: string | undefined, sandboxPermissions: string | undefined, justification: string | undefined}} operation
 * @property {string | undefined} operationId
 * @property {'validation' | 'ordinary' | undefined} readiness
 */

/**
 * @typedef SessionLedger
 * @property {Agent['session']} session
 * @property {FinishLineIdentity} identity
 * @property {string | undefined} runnerCapability
 * @property {Promise<boolean> | undefined} runnerCapabilityOpening
 * @property {string | undefined} runnerCapabilityOpeningCommand
 * @property {number | undefined} runnerCapabilityRefreshedAt
 * @property {string | undefined} correlationId
 * @property {string | undefined} poison
 */

/**
 * @typedef SessionLedgerSet
 * @property {Map<string, SessionLedger>} ledgers
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
/**
 * The workspace lease returns no target both when it proved the path lies
 * outside every repository and when it simply claimed no fence it could
 * enforce for that tool. Those are not the same thing, and the difference
 * decides whether an edit owes Git validation, so do not read an empty
 * projection as proof on its own: fall back to the anchor obligation whenever
 * the edit's own declared path is inside the anchor checkout. A provider that
 * declines to classify an in-repository edit then cannot erase its obligation,
 * while a genuine write outside every checkout still owes nothing.
 * @param {ToolExecution} exec
 * @param {string | undefined} anchorCwd
 * @returns {boolean}
 */
function editPathIsInsideAnchor(exec, anchorCwd) {
  if (anchorCwd === undefined) return false
  const args = record(exec.arguments)
  const declared = args?.file_path ?? args?.path
  if (typeof declared !== 'string' || declared.length === 0 || declared.includes('\0')) {
    // An unreadable path argument is not a proof of anything, so keep the
    // obligation rather than dropping it on an unverifiable claim.
    return true
  }
  const absolute = isAbsolute(declared) ? resolvePath(declared) : resolvePath(anchorCwd, declared)
  const root = resolvePath(anchorCwd)
  return absolute === root || absolute.startsWith(`${root}/`)
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
  // Use a lookup-independent executable for the one shell primitive that the
  // non-repository finish-line contract can authenticate. This preserves the
  // ordinary `pwd` UX without allowing an imported shell function to shadow it.
  const command = args.command === 'pwd' ? '/usr/bin/pwd' : args.command
  return {
    kind: /** @type {const} */ ('validation'),
    intent: 'project-dev',
    command,
    timeoutMs: args.timeoutMs,
    workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
    sandboxPermissions: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : undefined,
    justification: typeof args.justification === 'string' ? args.justification : undefined,
  }
}

/**
 * Bind Bash authority to the tool's actual working directory. Editor tools do
 * not expose an equivalent complete target root, so they retain the session
 * identity and fail closed when that identity has no repository authority.
 *
 * @param {{sessionId: string, cwd: string, turn: number}} call
 * @param {{kind: 'edit'} | {kind: 'validation', workdir: string | undefined}} operation
 * @returns {FinishLineIdentity}
 */
function identityForOperation(call, operation) {
  const cwd = operation.kind === 'validation' && operation.workdir !== undefined
    ? isAbsolute(operation.workdir)
      ? resolvePath(operation.workdir)
      : resolvePath(call.cwd, operation.workdir)
    : call.cwd
  return {
    product: 'dsh',
    sessionId: call.sessionId,
    turnId: String(call.turn),
    cwd,
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
    // Cancellation is a composable execution channel, not authority identity:
    // trusted tools/execute middleware may fuse an additional abort source on
    // this same exact execution after admission.
    && prepared.callId === exec.callId
    && prepared.rootCallId === exec.rootCallId
    && prepared.name === exec.name
}

/**
 * Materialize the lookup-independent result of the one non-repository command
 * that nils authenticated. No shell name resolution or argument mutation is
 * involved after the exact call identity and operation are rechecked.
 *
 * @param {CallIdentity} prepared
 * @param {ValidationCall['operation']} admitted
 * @param {ValidationCall['operation']} current
 * @param {Readonly<ToolExecution>} exec
 * @returns {{kind: 'result', result: ToolExecutionResult} | undefined}
 */
function nonRepositoryPwdResult(prepared, admitted, current, exec) {
  if (!matches(prepared, exec)
    || record(exec.arguments)?.command !== 'pwd'
    || current.command !== '/usr/bin/pwd'
    || !sameValidationOperation(admitted, current)) return undefined
  return {
    kind: 'result',
    result: {
      isError: false,
      content: [],
      value: {
        kind: 'foreground',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: current.timeoutMs ?? DEFAULT_FINISH_LINE_COMMAND_TIMEOUT_MS,
        stdout: { text: `${prepared.identity.cwd}\n`, truncated: false },
        stderr: { text: '', truncated: false },
      },
    },
  }
}

/** @param {ValidationCall['operation']} admitted @param {ValidationCall['operation']} current */
function sameValidationOperation(admitted, current) {
  return admitted.kind === current.kind
    && admitted.intent === current.intent
    && admitted.command === current.command
    && admitted.timeoutMs === current.timeoutMs
    && admitted.workdir === current.workdir
    && admitted.sandboxPermissions === current.sandboxPermissions
    && admitted.justification === current.justification
}

/**
 * @param {Context} ctx
 * @param {{client: FinishLineClient, HarnessError?: new (message: string, code?: string) => Error, TOOL_ABORTED?: string, maxSameTurnSteers?: number, createOperationId?: () => string, now?: () => number, requiresFinishLine?: (identity: FinishLineIdentity) => boolean, allowsNonRepositoryDelegation?: (identity: FinishLineIdentity) => boolean, resolveEditRoots?: (exec: ToolExecution) => Promise<readonly string[] | undefined>, authenticatePrincipal?: (agent: Agent, signal: AbortSignal) => Promise<unknown>, prepareValidationRuntime?: (exec: ToolDispatchExecution, operation: {kind: 'validation' | 'ordinary', intent: string, command: string, timeoutMs: number | undefined, workdir: string | undefined, sandboxPermissions: string | undefined, justification: string | undefined}, identity: FinishLineIdentity) => Promise<{timeoutMs: number, execution: unknown, environment?: Record<string, string>}>, createSteeringMessage: (text: string) => import('@deepseek-ai/dsh-llm').UserMessage}} options
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
  const requiresFinishLine = options.requiresFinishLine ?? (() => true)
  const allowsNonRepositoryDelegation = options.allowsNonRepositoryDelegation ?? (() => false)
  // Editor tools carry an exact path argument but no repository root. The
  // workspace-lease service already canonicalized and authenticated that
  // operation's repository target, so the ledger reuses that decision instead
  // of deriving Git identity a second time in JavaScript.
  const resolveEditRoots = options.resolveEditRoots
  const authenticatePrincipal = options.authenticatePrincipal ?? (async () => undefined)
  const prepareValidationRuntime = options.prepareValidationRuntime ?? (async (_exec, operation) => ({
    timeoutMs: resolveFinishLineShellTimeout(operation.kind, operation.timeoutMs)
      ?? DEFAULT_FINISH_LINE_COMMAND_TIMEOUT_MS,
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
  /** @type {WeakMap<Readonly<ToolExecution>, {ledger: SessionLedger, operationId: string}>} */
  const editRegistrations = new WeakMap()
  /** @type {Map<Readonly<ToolExecution>, ValidationCall>} */
  const validationCalls = new Map()
  /** @type {WeakSet<Readonly<ToolExecution>>} */
  const advisoryDelegations = new WeakSet()
  /** @type {WeakMap<Readonly<ToolExecution>, {prepared: CallIdentity, operation: ValidationCall['operation']}>} */
  const nonRepositoryPwdCalls = new WeakMap()
  /** @type {WeakSet<Readonly<ToolExecution>>} */
  const settledValidations = new WeakSet()
  /** @type {Map<Agent['session'], SessionLedgerSet>} */
  const ledgers = new Map()
  /** @type {Set<Promise<void>>} */
  const releaseTasks = new Set()
  /** @type {Map<string, Promise<void>>} */
  const releaseTasksByIdentity = new Map()
  let open = true
  let releaseDegraded = false

  /** @param {Agent['session']} session @param {FinishLineIdentity} identity */
  function ledgerFor(session, identity) {
    let ledgerSet = ledgers.get(session)
    if (ledgerSet === undefined) {
      ledgerSet = { ledgers: new Map(), steeringTurn: undefined, steeringCount: 0 }
      ledgers.set(session, ledgerSet)
    }
    const key = finishLineIdentityKey(identity)
    const existing = ledgerSet.ledgers.get(key)
    if (existing !== undefined) return existing
    /** @type {SessionLedger} */
    const created = {
      session,
      identity,
      runnerCapability: undefined,
      runnerCapabilityOpening: undefined,
      runnerCapabilityOpeningCommand: undefined,
      runnerCapabilityRefreshedAt: undefined,
      correlationId: undefined,
      poison: undefined,
    }
    ledgerSet.ledgers.set(key, created)
    return created
  }

  /** @param {SessionLedger} ledger */
  function removeLedger(ledger) {
    const ledgerSet = ledgers.get(ledger.session)
    if (ledgerSet?.ledgers.get(finishLineIdentityKey(ledger.identity)) !== ledger) return
    ledgerSet.ledgers.delete(finishLineIdentityKey(ledger.identity))
    if (ledgerSet.ledgers.size === 0) ledgers.delete(ledger.session)
  }

  /** @param {Agent['session']} session */
  function sessionLedgers(session) {
    return [...(ledgers.get(session)?.ledgers.values() ?? [])]
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

  /**
   * @param {SessionLedger} ledger
   * @param {FinishLineIdentity} identity
   * @param {AbortSignal} signal
   * @param {string} [command]
   * @returns {Promise<boolean>} whether repository authority was opened
   */
  async function ensureRunnerCapability(ledger, identity, signal, command) {
    const currentCapability = ledger.runnerCapability
    if (currentCapability !== undefined
      && ledger.runnerCapabilityRefreshedAt !== undefined
      && now() - ledger.runnerCapabilityRefreshedAt < CAPABILITY_REFRESH_INTERVAL_MS) return true
    if (ledger.runnerCapabilityOpening !== undefined
      && ledger.runnerCapabilityOpeningCommand !== command) {
      try { await ledger.runnerCapabilityOpening } catch {}
      if (signal.aborted) throw signal.reason ?? new Error('dsh-runtime-kit: finish-line aborted')
      return ensureRunnerCapability(ledger, identity, signal, command)
    }
    if (ledger.runnerCapabilityOpening === undefined) {
      /** @type {Promise<boolean>} */
      let opening
      opening = (async () => {
        let opened
        try {
          opened = await client.open({
            ...identity,
            ...(command === undefined ? {} : { command }),
          }, signal)
        } catch (error) {
          if (signal.aborted) throw error
          opened = await client.open({
            ...identity,
            ...(command === undefined ? {} : { command }),
          }, signal)
        }
        if (!('runnerCapability' in opened)) {
          if (opened.kind === 'not-in-repository') return false
          throw new Error('dsh-runtime-kit: finish-line open response invalid')
        }
        acceptCorrelation(ledger, opened.correlationId)
        if (currentCapability !== undefined && opened.runnerCapability !== currentCapability) {
          throw new Error('dsh-runtime-kit: finish-line capability changed during renewal')
        }
        ledger.runnerCapability = opened.runnerCapability
        ledger.runnerCapabilityRefreshedAt = now()
        return true
      })().catch(error => {
        if (ledger.runnerCapability === undefined) client.abandonOpen(identity)
        throw error
      }).finally(() => {
        if (ledger.runnerCapabilityOpening === opening) {
          ledger.runnerCapabilityOpening = undefined
          ledger.runnerCapabilityOpeningCommand = undefined
        }
      })
      ledger.runnerCapabilityOpening = opening
      ledger.runnerCapabilityOpeningCommand = command
    }
    const authoritative = await ledger.runnerCapabilityOpening
    if (!authoritative) {
      if (ledger.runnerCapability === undefined) removeLedger(ledger)
      return false
    }
    if (ledger.runnerCapability === undefined) {
      throw new Error('dsh-runtime-kit: finish-line capability unavailable')
    }
    return true
  }

  /**
   * Register the durable edit generation for an execution every pre-execution
   * gate has admitted. Runs at dispatch, before the tool body, so the
   * generation still precedes the mutation it covers.
   * @param {ToolExecution} exec
   * @param {CallIdentity} prepared
   * @param {{ledger: SessionLedger, operationId: string}} registration
   */
  async function registerEdit(exec, prepared, registration) {
    const { ledger, operationId } = registration
    // Every failure below drops the local reservation: the execution never
    // dispatches, so nothing later will settle it.
    /** @param {unknown} error @returns {never} */
    const fail = error => {
      preparedEdits.delete(exec)
      throw error
    }
    // The lease's execute wrapper fuses its operation authority into the
    // signal, so a cancellation can arrive before anything is sent. A request
    // that never left the process is not a durable ambiguity; surface the
    // abort without poisoning the ledger.
    if (exec.signal.aborted) {
      fail(exec.signal.reason ?? new Error('dsh-runtime-kit: finish-line edit registration aborted'))
    }
    if (!open) fail(new Error('dsh-runtime-kit: finish-line disposed before edit registration'))
    if (releaseDegraded || ledger.poison !== undefined) {
      fail(new Error('dsh-runtime-kit: finish-line edit registration unavailable'))
    }
    const beginRequest = { ...prepared.identity, operationId }
    let result
    try {
      try {
        result = await client.beginEdit(beginRequest, exec.signal)
      } catch (error) {
        if (exec.signal.aborted) throw error
        result = await client.beginEdit(beginRequest, exec.signal)
      }
    } catch (error) {
      // The request may or may not have landed: the durable outcome is
      // ambiguous, so the ledger is poisoned until it is released.
      client.abandonBegin(beginRequest)
      poison(ledger, 'begin-persistence')
      fail(exec.signal.aborted
        ? error
        : new Error('dsh-runtime-kit: finish-line edit registration unavailable'))
    }
    if (result.operationId !== operationId || result.correlationId.length === 0) {
      poison(ledger, 'begin-correlation')
      fail(new Error('dsh-runtime-kit: finish-line edit registration correlation invalid'))
    }
    try {
      // `acceptCorrelation` poisons the ledger and throws its own cause when
      // the provider changed identity mid-session.
      acceptCorrelation(ledger, result.correlationId)
    } catch (error) {
      fail(error)
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
    for (const pending of validationCalls.values()) {
      if (pending.prepared.session === session) {
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
      removeLedger(ledger)
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
      removeLedger(ledger)
    } catch {
      releaseDegraded = true
      poison(ledger, 'release-persistence')
    }
  }

  /** @param {SessionLedger} ledger */
  function queueLedgerRelease(ledger) {
    const identityKey = finishLineIdentityKey(ledger.identity)
    const existing = releaseTasksByIdentity.get(identityKey)
    if (existing !== undefined) return existing
    const task = releaseLedger(ledger.session, ledger)
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

  /** @param {Agent['session']} session */
  function queueRelease(session) {
    return Promise.all(sessionLedgers(session).map(queueLedgerRelease)).then(() => {})
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
    const ledgerSet = ledgers.get(ledger.session)
    if (ledgerSet === undefined) throw new Error('dsh-runtime-kit: finish-line ledger unavailable')
    if (ledgerSet.steeringTurn !== turn) {
      ledgerSet.steeringTurn = turn
      ledgerSet.steeringCount = 0
    }
    if (ledgerSet.steeringCount >= maxSameTurnSteers) {
      throw new Error('dsh-runtime-kit: finish-line same-turn steering limit reached')
    }
    ledgerSet.steeringCount += 1
    agent.steer(options.createSteeringMessage(boundedUtf8(text, MAX_STEERING_TEXT_BYTES)))
  }

  async function dispose() {
    if (!open) return
    open = false
    await client.drain()
    // No new work can enter once `open` is false. A validation probe may still
    // be waiting in an ordinary policy evaluation, so retire that prepared
    // reservation before releasing its durable runner capability.
    preparedEdits.clear()
    validationCalls.clear()
    for (const session of [...ledgers.keys()]) queueRelease(session)
    await drainReleaseTasks()
    await client.dispose()
    ledgers.clear()
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit finish-line coordinator')

  return Object.freeze({
    /**
     * Ask the authoritative finish-line contract whether one Bash call is the
     * exact current validation before the generic opaque-shell policy sees it.
     * Only a typed `ready` response receives the validation classification;
     * every ordinary command remains subject to the normal policy transport.
     *
     * @param {ToolExecution} exec
     * @param {{sessionId: string, cwd: string, turn: number, callId: string, rootCallId: string, name: string}} call
     */
    async probe(exec, call) {
      if (!open) return { ok: false, reason: 'finish-line-disposed' }
      if (releaseDegraded) return { ok: false, reason: 'finish-line-unavailable' }
      const operation = operationFor(exec)
      if (operation === undefined) {
        return { ok: true, kind: /** @type {const} */ ('not-applicable') }
      }
      if ('invalid' in operation) return { ok: false, reason: 'finish-line-operation-invalid' }
      if ('unsupported' in operation) {
        return { ok: false, reason: 'finish-line-background-unsupported' }
      }
      if (operation.kind !== 'validation') {
        return { ok: true, kind: /** @type {const} */ ('not-applicable') }
      }
      const session = exec.agent?.session
      if (session === undefined) return { ok: false, reason: 'finish-line-session-missing' }
      const identity = identityForOperation(call, operation)
      if (requiresFinishLine(identity) === false) {
        advisoryDelegations.add(exec)
        return { ok: true, kind: /** @type {const} */ ('ordinary') }
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
        callId: call.callId,
        rootCallId: call.rootCallId,
        name: call.name,
        identity,
      }
      try {
        if (!await ensureRunnerCapability(ledger, identity, exec.signal, operation.command)) {
          if (allowsNonRepositoryDelegation(identity)) {
            if (record(exec.arguments)?.command !== 'pwd'
              || operation.command !== '/usr/bin/pwd') {
              return { ok: false, reason: 'finish-line-unavailable' }
            }
            nonRepositoryPwdCalls.set(exec, { prepared, operation })
            return { ok: true, kind: /** @type {const} */ ('ordinary') }
          }
          return { ok: false, reason: 'finish-line-unavailable' }
        }
        const operationId = createOperationId()
        const result = await client.run({
          ...identity,
          operationId,
          runnerCapability: /** @type {string} */ (ledger.runnerCapability),
          intent: operation.intent,
          command: operation.command,
          timeoutMs: 1,
        }, exec.signal)
        acceptCorrelation(ledger, result.correlationId)
        if (result.operationId !== operationId
          || !['ready', 'ordinary-ready'].includes(result.status)) {
          throw new Error('finish-line probe response invalid')
        }
        const readiness = result.status === 'ready'
          ? /** @type {const} */ ('validation')
          : /** @type {const} */ ('ordinary')
        validationCalls.set(exec, { prepared, operation, operationId, readiness })
        return { ok: true, kind: readiness }
      } catch {
        poison(ledger, 'validation-probe')
        return { ok: false, reason: 'finish-line-unavailable' }
      }
    },

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
      const anchorIdentity = identityForOperation(call, operation)
      // Session classification is principal-scoped, so the anchor identity is
      // the correct subject for it even when the operation targets elsewhere.
      if (requiresFinishLine(anchorIdentity) === false) {
        advisoryDelegations.add(exec)
        return { ok: true }
      }
      if (advisoryDelegations.has(exec)) return { ok: true }
      if (nonRepositoryPwdCalls.has(exec)) return { ok: true }
      let identity = anchorIdentity
      if (operation.kind === 'edit' && resolveEditRoots !== undefined) {
        // A projection failure is the workspace-lease service's own typed
        // cause. That service resolves this exact execution once and denies it
        // with that cause immediately after this boundary returns, so reserve
        // nothing and let the root cause reach the model unchanged. Replacing
        // it with a finish-line reason would hide a WORKSPACE_DIRTY or
        // WORKSPACE_FOREIGN_ACTIVE denial behind an unrelated failure, and
        // throwing here would skip the pre-execute cleanup path.
        /** @type {readonly string[] | undefined} */
        let roots
        try {
          roots = await resolveEditRoots(exec)
        } catch {
          return { ok: true }
        }
        if (roots !== undefined && roots.length === 0) {
          // See `editPathIsInsideAnchor`: an empty projection alone does not
          // prove this write touches no repository.
          if (!editPathIsInsideAnchor(exec, anchorIdentity.cwd)) return { ok: true }
        }
        if (roots !== undefined && roots.length > 0) {
          if (roots.length > 1) return { ok: false, reason: 'finish-line-edit-target-ambiguous' }
          const root = roots[0]
          if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
            return { ok: false, reason: 'finish-line-edit-target-unavailable' }
          }
          // Normalize the way the bash workdir path does, or a non-canonical
          // root would key a second ledger for one repository and the
          // validations declared there could never satisfy this obligation.
          identity = { ...anchorIdentity, cwd: resolvePath(root) }
        }
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
        callId: call.callId,
        rootCallId: call.rootCallId,
        name: call.name,
        identity,
      }
      if (operation.kind === 'validation') {
        const probed = validationCalls.get(exec)
        if (probed !== undefined) {
          if (!matches(probed.prepared, exec)) {
            poison(ledger, 'begin-correlation')
            return { ok: false, reason: 'finish-line-correlation-invalid' }
          }
          return { ok: true }
        }
        validationCalls.set(exec, {
          prepared,
          operation,
          operationId: undefined,
          readiness: undefined,
        })
        return { ok: true }
      }
      try {
        if (!await ensureRunnerCapability(ledger, identity, exec.signal)) {
          return { ok: false, reason: 'finish-line-unavailable' }
        }
      } catch {
        poison(ledger, 'begin-persistence')
        return { ok: false, reason: 'finish-line-unavailable' }
      }
      // Reserve the edit locally only. The durable edit generation is
      // registered in `execute`, once every pre-execution gate has admitted
      // this exact execution. The workspace lease admits after this boundary
      // returns, so registering here would leave a validation obligation on a
      // repository whose target the lease then denied and never dispatched.
      preparedEdits.set(exec, prepared)
      editRegistrations.set(exec, { ledger, operationId: createOperationId() })
      return { ok: true }
    },

    /**
     * @param {ToolDispatchExecution} exec
     * @returns {Promise<{kind: 'delegate'} | {kind: 'result', result: ToolExecutionResult}>}
     */
    async execute(exec) {
      const operation = operationFor(/** @type {ToolExecution} */ (exec))
      const registration = editRegistrations.get(exec)
      if (registration !== undefined) {
        editRegistrations.delete(exec)
        const prepared = preparedEdits.get(exec)
        if (operation?.kind !== 'edit' || prepared === undefined || !matches(prepared, exec)) {
          preparedEdits.delete(exec)
          poison(registration.ledger, 'execute-correlation')
          throw new Error('dsh-runtime-kit: finish-line edit correlation invalid')
        }
        await registerEdit(/** @type {ToolExecution} */ (exec), prepared, registration)
        return { kind: 'delegate' }
      }
      const nonRepositoryPwd = nonRepositoryPwdCalls.get(exec)
      nonRepositoryPwdCalls.delete(exec)
      if (nonRepositoryPwd !== undefined) {
        if (operation === undefined || 'invalid' in operation || 'unsupported' in operation
          || operation.kind !== 'validation') {
          throw new Error('dsh-runtime-kit: finish-line non-repository correlation invalid')
        }
        const routed = nonRepositoryPwdResult(
          nonRepositoryPwd.prepared,
          nonRepositoryPwd.operation,
          operation,
          exec,
        )
        if (routed === undefined) {
          throw new Error('dsh-runtime-kit: finish-line non-repository correlation invalid')
        }
        return routed
      }
      const pending = validationCalls.get(exec)
      validationCalls.delete(exec)
      if (pending !== undefined) {
        if (operation === undefined || 'invalid' in operation || 'unsupported' in operation
          || operation.kind !== 'validation'
          || !matches(pending.prepared, exec)
          || !sameValidationOperation(pending.operation, operation)) {
          poison(ledgerFor(pending.prepared.session, pending.prepared.identity), 'execute-correlation')
          throw new Error('dsh-runtime-kit: finish-line validation correlation invalid')
        }
      } else {
        if (advisoryDelegations.delete(exec)) return { kind: 'delegate' }
        if (operation?.kind !== 'validation') return { kind: 'delegate' }
      }
      if (pending === undefined) {
        throw new Error('dsh-runtime-kit: finish-line validation correlation invalid')
      }
      const prepared = pending.prepared
      const ledger = ledgerFor(prepared.session, prepared.identity)
      try {
        let operationId = pending.operationId
        let readiness = pending.readiness
        if (operationId === undefined || readiness === undefined) {
          if (!await ensureRunnerCapability(
            ledger,
            prepared.identity,
            exec.signal,
            operation.command,
          )) {
            if (allowsNonRepositoryDelegation(prepared.identity)) {
              const routed = nonRepositoryPwdResult(
                prepared,
                pending.operation,
                operation,
                exec,
              )
              if (routed !== undefined) return routed
            }
            throw new Error('dsh-runtime-kit: finish-line capability unavailable')
          }
          operationId = createOperationId()
          const probe = await client.run({
            ...prepared.identity,
            operationId,
            runnerCapability: /** @type {string} */ (ledger.runnerCapability),
            intent: operation.intent,
            command: operation.command,
            timeoutMs: 1,
          }, exec.signal)
          acceptCorrelation(ledger, probe.correlationId)
          if (probe.operationId !== operationId
            || !['ready', 'ordinary-ready'].includes(probe.status)) {
            throw new Error('finish-line probe response invalid')
          }
          readiness = probe.status === 'ready' ? 'validation' : 'ordinary'
        }
        const candidate = {
          ...prepared.identity,
          operationId,
          runnerCapability: /** @type {string} */ (ledger.runnerCapability),
          intent: operation.intent,
          command: operation.command,
          timeoutMs: 1,
        }
        const ordinary = readiness === 'ordinary'
        const runtime = await prepareValidationRuntime(exec, {
          ...operation,
          kind: ordinary ? 'ordinary' : 'validation',
        }, prepared.identity)
        if (record(runtime.execution)?.workdir !== prepared.identity.cwd) {
          throw new Error('dsh-runtime-kit: finish-line execution identity invalid')
        }
        const result = await client.run({
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

    /** Drop a prepared operation when a later pre-execution gate denies. @param {ToolExecution} exec */
    reject(exec) {
      preparedEdits.delete(exec)
      editRegistrations.delete(exec)
      validationCalls.delete(exec)
      advisoryDelegations.delete(exec)
      nonRepositoryPwdCalls.delete(exec)
    },

    /**
     * Report whether the exact execution has an authenticated declared-
     * validation classification that remains reserved for dispatch.
     * @param {Readonly<ToolExecution>} exec
     */
    isDeclaredValidation(exec) {
      return validationCalls.get(exec)?.readiness === 'validation'
    },

    /**
     * Run one internal acceptance RPC with the exact runner capability already
     * owned by this session ledger. The capability never enters a public
     * service, tool result, prompt, session event, or caller-provided config.
     * @param {Agent} agent
     * @param {string} turnId
     * @param {AbortSignal} signal
     * @param {(authority: {identity: FinishLineIdentity, runnerCapability: string, acceptCorrelation(correlationId: string): void}) => Promise<any>} invoke
     */
    async withAuthority(agent, turnId, signal, invoke) {
      if (!open || releaseDegraded || signal.aborted
        || ctx.agents.get(agent.id) !== agent
        || agent.session?.header?.id !== agent.id
        || typeof agent.session.header.cwd !== 'string'
        || !/^[\x21-\x7e]{1,256}$/u.test(turnId)) {
        throw new Error('dsh-runtime-kit: finish-line acceptance authority unavailable')
      }
      await authenticatePrincipal(agent, signal)
      if (!open || releaseDegraded || signal.aborted
        || ctx.agents.get(agent.id) !== agent
        || agent.session?.header?.id !== agent.id) {
        throw new Error('dsh-runtime-kit: finish-line acceptance authority unavailable')
      }
      const identity = {
        product: /** @type {const} */ ('dsh'),
        sessionId: String(agent.id),
        turnId,
        cwd: agent.session.header.cwd,
      }
      if (requiresFinishLine(identity) === false) {
        throw new Error('dsh-runtime-kit: finish-line acceptance requires an authoritative host')
      }
      await awaitPriorRelease(identity)
      const ledger = ledgerFor(agent.session, identity)
      if (ledger.poison !== undefined) {
        throw new Error('dsh-runtime-kit: finish-line acceptance authority unavailable')
      }
      if (!await ensureRunnerCapability(ledger, identity, signal)) {
        throw new Error('dsh-runtime-kit: finish-line acceptance requires repository authority')
      }
      return invoke(Object.freeze({
        identity: Object.freeze(identity),
        runnerCapability: /** @type {string} */ (ledger.runnerCapability),
        acceptCorrelation(correlationId) { acceptCorrelation(ledger, correlationId) },
      }))
    },

    /**
     * Return the exact future contained-run reservation established by probe.
     * Ordinary Bash and unreserved executions return undefined.
     * @param {Readonly<ToolExecution>} exec
     */
    sourceOperationId(exec) {
      const pending = validationCalls.get(exec)
      return pending?.readiness === 'validation' ? pending.operationId : undefined
    },

    /**
     * Return the exact private validation source reserved by probe. This is
     * used only to select one registered contained-Bash acceptance binding;
     * it never enters a public service, result, event, or model context.
     * @param {Readonly<ToolExecution>} exec
     */
    sourceOperation(exec) {
      const pending = validationCalls.get(exec)
      return pending?.readiness === 'validation' && pending.operationId !== undefined
        ? Object.freeze({
            operationId: pending.operationId,
            intent: pending.operation.intent,
            command: pending.operation.command,
          })
        : undefined
    },

    /** @param {unknown} _target @param {unknown} _observation @param {unknown} _actor */
    observeFs(_target, _observation, _actor) {},

    /** @param {Readonly<ToolExecution>} exec @param {Readonly<ToolExecutionResult>} _result */
    result(exec, _result) {
      preparedEdits.delete(exec)
      editRegistrations.delete(exec)
      if (settledValidations.has(exec)) {
        settledValidations.delete(exec)
        return
      }
      const prepared = validationCalls.get(exec)?.prepared
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
      const headerIdentity = {
        product: /** @type {const} */ ('dsh'),
        sessionId,
        turnId: String(payload.turn),
        cwd,
      }
      if (requiresFinishLine(headerIdentity) === false) return true
      await awaitPriorRelease(headerIdentity)
      if (!open || releaseDegraded) {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const headerLedger = ledgerFor(payload.agent.session, headerIdentity)
      if (!correlated) {
        for (const ledger of sessionLedgers(payload.agent.session)) poison(ledger, 'stop-correlation')
      }
      if (headerLedger.poison !== undefined) {
        steer(headerLedger, payload.turn, 'Finish-line state is unavailable. Do not stop; repair the runtime boundary and retry.', payload.agent)
        return false
      }
      const headerAuthoritative = await ensureRunnerCapability(
        headerLedger,
        headerIdentity,
        payload.signal,
      )
      if (!headerAuthoritative && !allowsNonRepositoryDelegation(headerIdentity)) {
        throw new Error('dsh-runtime-kit: finish-line unavailable')
      }
      const authoritativeLedgers = sessionLedgers(payload.agent.session)
        .filter(ledger => ledger.runnerCapability !== undefined)
        .sort((left, right) => {
          const leftHeader = finishLineIdentityKey(left.identity) === finishLineIdentityKey(headerIdentity)
          const rightHeader = finishLineIdentityKey(right.identity) === finishLineIdentityKey(headerIdentity)
          if (leftHeader !== rightHeader) return leftHeader ? -1 : 1
          return finishLineIdentityKey(left.identity).localeCompare(finishLineIdentityKey(right.identity))
        })
      for (const ledger of authoritativeLedgers) {
        const identity = { ...ledger.identity, turnId: String(payload.turn) }
        if (ledger.poison !== undefined) {
          steer(ledger, payload.turn, 'Finish-line state is unavailable. Do not stop; repair the runtime boundary and retry.', payload.agent)
          return false
        }
        if (!await ensureRunnerCapability(ledger, identity, payload.signal)) {
          throw new Error('dsh-runtime-kit: finish-line unavailable')
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
      }
      await queueRelease(payload.agent.session)
      if (releaseDegraded || ledgers.has(payload.agent.session)) {
        const releaseFailureLedger = sessionLedgers(payload.agent.session)[0] ?? headerLedger
        steer(releaseFailureLedger, payload.turn, 'Finish-line release is unavailable. Do not stop; repair the runtime boundary and retry.', payload.agent)
        return false
      }
      return true
    },

    /** @param {Agent} agent */
    agentDisposed(agent) {
      return queueRelease(agent.session)
    },

    /**
     * Release the shared capability after the authoritative acceptance verdict
     * has allowed stop. This path deliberately does not ask the superseded
     * legacy stop evaluator for a second, contradictory completion verdict.
     * @param {Agent} agent
     */
    async releaseAfterAcceptance(agent) {
      if (!open || releaseDegraded || ctx.agents.get(agent.id) !== agent) {
        throw new Error('dsh-runtime-kit: finish-line release unavailable')
      }
      await queueRelease(agent.session)
      if (releaseDegraded || ledgers.has(agent.session)) {
        throw new Error('dsh-runtime-kit: finish-line release unavailable')
      }
      return true
    },

    async dispose() { await dispose() },
    get activeReservations() { return preparedEdits.size + validationCalls.size },
    get trackedSessions() { return ledgers.size },
    get maxSameTurnSteers() { return maxSameTurnSteers },
    get degraded() {
      return releaseDegraded || [...ledgers.values()]
        .some(ledgerSet => [...ledgerSet.ledgers.values()]
          .some(ledger => ledger.poison !== undefined))
    },
  })
}
