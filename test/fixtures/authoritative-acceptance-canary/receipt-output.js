export const SCENARIO_CANARY_MARKER = 'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY='
export const SCENARIO_CANARY_FAILURE_MARKER = 'DSH_AUTHORITATIVE_ACCEPTANCE_FAILURE='
export const SCENARIO_CANARY_DEADLINE_ENV = 'DSH_ACCEPTANCE_CANARY_DEADLINE_EPOCH_MS'
export const SCENARIO_CANARY_EXECUTION_TIMEOUT_MS = 120_000
export const SCENARIO_CANARY_PROCESS_TIMEOUT_MS = 180_000
export const SCENARIO_CANARY_PROGRESS = Object.freeze({
  WAITING_SERVICES: 'DSH_CANARY_DEADLINE_WAITING_SERVICES',
  SCENARIO_STARTED: 'DSH_CANARY_DEADLINE_SCENARIO_STARTED',
  CONTRACT_REGISTERED: 'DSH_CANARY_DEADLINE_CONTRACT_REGISTERED',
  CREATING_AGENT: 'DSH_CANARY_DEADLINE_CREATING_AGENT',
  AGENT_CREATED: 'DSH_CANARY_DEADLINE_AGENT_CREATED',
  WAITING_SESSION_REGISTRATION: 'DSH_CANARY_DEADLINE_WAITING_SESSION_REGISTRATION',
  SESSION_REGISTERED: 'DSH_CANARY_DEADLINE_SESSION_REGISTERED',
  FOLLOWUP_SUBMITTED: 'DSH_CANARY_DEADLINE_FOLLOWUP_SUBMITTED',
  WAITING_AGENT_IDLE: 'DSH_CANARY_DEADLINE_WAITING_AGENT_IDLE',
  VALIDATION_TOOL_REQUESTED: 'DSH_CANARY_DEADLINE_VALIDATION_TOOL_REQUESTED',
  VALIDATION_TOOL_RESULT: 'DSH_CANARY_DEADLINE_VALIDATION_TOOL_RESULT',
  HOST_VALIDATOR_REQUESTED: 'DSH_CANARY_DEADLINE_HOST_VALIDATOR_REQUESTED',
  HOST_VALIDATOR_RESULT: 'DSH_CANARY_DEADLINE_HOST_VALIDATOR_RESULT',
  STOP_REQUESTED: 'DSH_CANARY_DEADLINE_STOP_REQUESTED',
  TURN_STOPPING_ENTERED: 'DSH_CANARY_DEADLINE_TURN_STOPPING_ENTERED',
  RUNTIME_STOP_LISTENERS_COMPLETED:
    'DSH_CANARY_DEADLINE_RUNTIME_STOP_LISTENERS_COMPLETED',
  CANARY_STOP_CALLBACK_COMPLETED:
    'DSH_CANARY_DEADLINE_CANARY_STOP_CALLBACK_COMPLETED',
  CANARY_STOP_LISTENER_TAIL_COMPLETED:
    'DSH_CANARY_DEADLINE_CANARY_STOP_LISTENER_TAIL_COMPLETED',
  CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED',
  CANARY_REPEATED_STOP_POLICY_ALLOWED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_POLICY_ALLOWED',
  CANARY_REPEATED_STOP_POLICY_CONTEXT:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_POLICY_CONTEXT',
  CANARY_REPEATED_STOP_POLICY_DENIED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_POLICY_DENIED',
  CANARY_REPEATED_STOP_CAPABILITY_UNAVAILABLE:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_CAPABILITY_UNAVAILABLE',
  CANARY_REPEATED_STOP_TRANSPORT_FAILED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_TRANSPORT_FAILED',
  CANARY_REPEATED_STOP_PROVIDER_FAILED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_PROVIDER_FAILED',
  CANARY_REPEATED_STOP_CANCELLED:
    'DSH_CANARY_DEADLINE_CANARY_REPEATED_STOP_CANCELLED',
  CANARY_TURN_ENDED_AFTER_STOP:
    'DSH_CANARY_DEADLINE_CANARY_TURN_ENDED_AFTER_STOP',
  CANARY_AGENT_IDLE_STATUS_AFTER_STOP:
    'DSH_CANARY_DEADLINE_CANARY_AGENT_IDLE_STATUS_AFTER_STOP',
  CANARY_AGENT_RESTARTED_AFTER_STOP:
    'DSH_CANARY_DEADLINE_CANARY_AGENT_RESTARTED_AFTER_STOP',
  CANARY_NEXT_TURN_STARTED_AFTER_STOP:
    'DSH_CANARY_DEADLINE_CANARY_NEXT_TURN_STARTED_AFTER_STOP',
  AGENT_IDLE: 'DSH_CANARY_DEADLINE_AGENT_IDLE',
  WAITING_RESOURCE_DRAIN: 'DSH_CANARY_DEADLINE_WAITING_RESOURCE_DRAIN',
  COMPLETION_SETTLEMENT: 'DSH_CANARY_DEADLINE_COMPLETION_SETTLEMENT',
  FINALIZING: 'DSH_CANARY_DEADLINE_FINALIZING',
})

const SCENARIO_CANARY_PROGRESS_CODES = new Set(Object.values(SCENARIO_CANARY_PROGRESS))

/** @param {string} phase */
export function scenarioCanaryServices(phase) {
  const observesRuntime = !['provider-mismatch-probe', 'unpatched-smoke'].includes(phase)
  return [
    'agents',
    ...observesRuntime ? ['dshRuntimeKit', 'sessions'] : [],
    'goals',
    'llm',
    'tools',
  ]
}

function parseScenarioCanaryDeadlineEpoch(deadlineEpoch) {
  if (typeof deadlineEpoch !== 'string' || !/^[1-9][0-9]{12}$/u.test(deadlineEpoch)) {
    throw new Error('scenario canary execution deadline is invalid')
  }
  const deadline = Number(deadlineEpoch)
  if (!Number.isSafeInteger(deadline)) {
    throw new Error('scenario canary execution deadline is invalid')
  }
  return deadline
}

function scenarioCanaryDeadlineDelayFromEpoch(deadlineEpoch, now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('scenario canary execution deadline is invalid')
  }
  return Math.max(0, deadlineEpoch - now)
}

/**
 * Derive the remaining canary execution budget from the parent-authenticated
 * process-start deadline. A canary loaded late receives only the remaining
 * budget, so its deadline cannot drift beyond the outer process supervisor.
 *
 * @param {unknown} deadlineEpoch
 * @param {number} [now]
 */
export function scenarioCanaryDeadlineDelay(deadlineEpoch, now = Date.now()) {
  return scenarioCanaryDeadlineDelayFromEpoch(
    parseScenarioCanaryDeadlineEpoch(deadlineEpoch),
    now,
  )
}

/**
 * @param {unknown} deadlineEpoch
 * @param {()=>void} onDeadline
 * @param {{
 *   now?:()=>number,
 *   setTimer?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>,
 * }} [options]
 */
export function scheduleScenarioCanaryDeadline(deadlineEpoch, onDeadline, options = {}) {
  if (typeof onDeadline !== 'function') {
    throw new Error('scenario canary deadline callback is invalid')
  }
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  return setTimer(onDeadline, scenarioCanaryDeadlineDelay(deadlineEpoch, now()))
}

function writeScenarioCanaryLine(stream, marker, value, invalidMessage) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    return Promise.reject(error)
  }
  if (serialized === undefined) return Promise.reject(new Error(invalidMessage))
  return new Promise((resolve, reject) => {
    try {
      stream.write(marker + serialized + '\n', error => {
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Retain only a fixed canary milestone and emit it once at the deadline. The
 * marker binds the expected phase and process without exposing child state,
 * output, arguments, messages, or stacks.
 *
 * @param {{
 *   phase:unknown,
 *   processInstance:unknown,
 *   stream:{write:(chunk:string,callback:(error?:Error|null)=>void)=>unknown},
 * }} options
 */
export function createScenarioCanaryProgressReporter(options) {
  if (typeof options?.phase !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(options.phase)
    || typeof options?.processInstance !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(options.processInstance)
    || typeof options?.stream?.write !== 'function') {
    throw new Error('scenario canary progress reporter is invalid')
  }
  let causeCode = SCENARIO_CANARY_PROGRESS.WAITING_SERVICES
  let report
  return Object.freeze({
    /** @param {unknown} nextCauseCode */
    enter(nextCauseCode) {
      if (!SCENARIO_CANARY_PROGRESS_CODES.has(nextCauseCode)) {
        throw new Error('scenario canary progress milestone is invalid')
      }
      causeCode = nextCauseCode
    },
    reportDeadline() {
      if (report !== undefined) return report
      const diagnostic = {
        schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary-failure.v1',
        phase: options.phase,
        process_instance_sha256: options.processInstance,
        cause_code: causeCode,
      }
      report = writeScenarioCanaryLine(
        options.stream,
        SCENARIO_CANARY_FAILURE_MARKER,
        diagnostic,
        'scenario canary failure diagnostic is not serializable',
      )
      return report
    },
  })
}

/**
 * Mark entry before the existing turn-stopping listeners, callback
 * settlement, and the following canary-owned tail. For phases that exercise
 * runtime-kit, the canary's runtime service dependency activates this
 * registration only after runtime-kit has registered its listeners. The
 * observers never return a decision or consume event content.
 *
 * @param {{on:(event:string,listener:(event:any)=>unknown,options?:{prepend?:boolean})=>unknown}} ctx
 * @param {{
 *   phase:string,
 *   progress:{enter:(causeCode:string)=>void},
 *   isTrackedAgent:(agent:any)=>boolean,
 *   stopPolicyOutcome?:(agent:any,turn:number)=>string|undefined,
 *   onCompleted:(agent:any,turn:number)=>unknown,
 * }} options
 */
export function registerScenarioCanaryTurnStoppingProgress(ctx, options) {
  const reportsProgress = ['positive', 'candidate-upgrade'].includes(options.phase)
  const repeatedStopProgress = Object.freeze({
    allow: SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_POLICY_ALLOWED,
    context: SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_POLICY_CONTEXT,
    'policy-denied': SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_POLICY_DENIED,
    'capability-unavailable':
      SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_CAPABILITY_UNAVAILABLE,
    'transport-failed': SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_TRANSPORT_FAILED,
    'provider-failed': SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_PROVIDER_FAILED,
    cancelled: SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_CANCELLED,
  })
  let completedStops = 0
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (reportsProgress && options.isTrackedAgent(agent)) {
      options.progress.enter(SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED)
    }
  }, { prepend: true })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!options.isTrackedAgent(agent)) return
    if (reportsProgress) {
      options.progress.enter(SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED)
    }
    const completed = options.onCompleted(agent, turn)
    if (!reportsProgress) return completed
    return Promise.resolve(completed).then(() => {
      completedStops += 1
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_STOP_CALLBACK_COMPLETED)
    })
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!reportsProgress || !options.isTrackedAgent(agent)) return
    if (completedStops <= 1) {
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_STOP_LISTENER_TAIL_COMPLETED)
      return
    }
    const outcome = options.stopPolicyOutcome?.(agent, turn)
    options.progress.enter(repeatedStopProgress[outcome]
      ?? SCENARIO_CANARY_PROGRESS.CANARY_REPEATED_STOP_LISTENER_TAIL_COMPLETED)
  })
}

/**
 * Observe only public, content-free DSH settlement boundaries after the
 * tracked canary has completed at least one stopping callback.
 *
 * @param {{on:(event:string,listener:(...args:any[])=>unknown)=>unknown}} ctx
 * @param {{
 *   phase:string,
 *   progress:{enter:(causeCode:string)=>void},
 *   isTrackedAgent:(agent:any)=>boolean,
 *   isTrackedSession:(session:any)=>boolean,
 *   hasCompletedStop:()=>boolean,
 * }} options
 */
export function registerScenarioCanaryAgentSettlementProgress(ctx, options) {
  if (!['positive', 'candidate-upgrade'].includes(options.phase)) return
  let turnEnded = false
  let idleObserved = false
  ctx.on('session/event', (session, event) => {
    if (!options.hasCompletedStop() || !options.isTrackedSession(session)) return
    if (event?.type === 'turn/end') {
      turnEnded = true
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_TURN_ENDED_AFTER_STOP)
    } else if (turnEnded && event?.type === 'turn/start') {
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_NEXT_TURN_STARTED_AFTER_STOP)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (!options.hasCompletedStop() || !options.isTrackedAgent(agent)) return
    if (status === 'idle') {
      idleObserved = true
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_AGENT_IDLE_STATUS_AFTER_STOP)
    } else if (status === 'running' && idleObserved) {
      options.progress.enter(SCENARIO_CANARY_PROGRESS.CANARY_AGENT_RESTARTED_AFTER_STOP)
    }
  })
}

/**
 * Arm the process-origin canary deadline before service readiness and arbitrate
 * deadline and normal completion through one finalization promise.
 *
 * @param {{
 *   deadlineEpoch:unknown,
 *   stream:{write:(chunk:string, callback:(error?:Error|null)=>void)=>unknown},
 *   reportFailure:(error:unknown)=>void,
 *   dispose:()=>Promise<void>,
 *   successStatus:()=>number,
 *   setExitCode:(status:number)=>void,
 *   exit:(status:number)=>void,
 *   onDeadline?:()=>Promise<void>|void,
 *   onUnhandledFailure?:(error:unknown)=>void,
 *   now?:()=>number,
 *   setTimer?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>,
 *   clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void,
 * }} options
 */
export function createScenarioCanaryDeadlineController(options) {
  let finalization
  let postDeadlineCleanup
  const deadlineEpoch = parseScenarioCanaryDeadlineEpoch(options.deadlineEpoch)
  const now = options.now ?? Date.now
  const finalize = (receipt, failure) => finalizeScenarioCanary({
    stream: options.stream,
    receipt,
    failure,
    reportFailure: options.reportFailure,
    dispose: options.dispose,
    successStatus: options.successStatus(),
    setExitCode: options.setExitCode,
    exit: options.exit,
  })
  const finalizeOnce = (receipt, failure) => {
    if (finalization !== undefined) return finalization
    finalization = finalize(receipt, failure)
    return finalization
  }
  const finalizeDeadline = () => {
    if (finalization !== undefined) return finalization
    finalization = (async () => {
      let failure = { error: new Error('scenario execution deadline exceeded') }
      try {
        await options.onDeadline?.()
      } catch (error) {
        failure = { error }
      }
      return finalize(undefined, failure)
    })()
    return finalization
  }
  const deadlineTimer = scheduleScenarioCanaryDeadline(
    String(deadlineEpoch),
    () => {
      void finalizeDeadline().catch(error => options.onUnhandledFailure?.(error))
    },
    { now, setTimer: options.setTimer },
  )
  const clearTimer = options.clearTimer ?? clearTimeout
  return Object.freeze({
    isFinalizing() { return finalization !== undefined },
    wait() { return finalization ?? Promise.resolve() },
    finish(receipt, failure) {
      const deadlineElapsed = finalization === undefined
        && scenarioCanaryDeadlineDelayFromEpoch(deadlineEpoch, now()) === 0
      clearTimer(deadlineTimer)
      if (deadlineElapsed) return finalizeDeadline()
      if (finalization === undefined) return finalizeOnce(receipt, failure)
      postDeadlineCleanup ??= finalization.finally(options.dispose)
      return postDeadlineCleanup
    },
  })
}

/**
 * Create the canary's goal without leaving automatic continuation authority
 * armed. The canary drives its own exact turn and exercises manual completion
 * only after the acceptance verdict is observable, so a goal-round driver
 * must not race that settlement boundary with another round.
 *
 * @param {{
 *   get:(agent:any)=>any,
 *   create:(agent:any,request:{objective:string})=>any,
 *   disarm:(agent:any)=>any,
 * }} goals
 * @param {any} agent
 */
export function prepareScenarioCanaryGoal(goals, agent) {
  const selected = goals.get(agent)
    ?? goals.create(agent, { objective: 'prove authoritative acceptance' })
  const disarmed = goals.disarm(agent)
  if (disarmed === undefined
    || disarmed.id !== selected.id
    || disarmed.revision !== selected.revision
    || disarmed.phase !== selected.phase
    || disarmed.activation !== 'disarmed') {
    throw new Error('scenario canary goal did not disarm')
  }
  return disarmed
}

/**
 * Start one scenario only after the runtime services required by that phase
 * are present. The runtime and acceptance providers are mounted by separate
 * loader entries, so either can become visible first.
 *
 * @param {{get:(name:string)=>unknown,inject:(names:string[],callback:(ctx:any)=>void)=>unknown}} ctx
 * @param {boolean} acceptanceRequired
 * @param {(acceptance:unknown)=>unknown} run
 */
export function startScenarioCanaryWhenReady(ctx, acceptanceRequired, run) {
  let started = false
  const start = runtimeCtx => {
    if (started || runtimeCtx.get('dshRuntimeKit') === undefined) return
    const acceptance = runtimeCtx.get('dshAcceptance')
    if (acceptanceRequired && acceptance === undefined) return
    started = true
    void run(acceptanceRequired ? acceptance : undefined)
  }
  start(ctx)
  if (started) return
  ctx.inject(
    acceptanceRequired ? ['dshRuntimeKit', 'dshAcceptance'] : ['dshRuntimeKit'],
    start,
  )
}

/**
 * Write one canary receipt and wait until the host stream has accepted the
 * complete line. DSH may terminate the process as soon as the plugin settles,
 * so callers must await this boundary before requesting host exit.
 *
 * @param {{write:(chunk:string, callback:(error?:Error|null)=>void)=>unknown}} stream
 * @param {unknown} receipt
 */
export function writeScenarioCanaryReceipt(stream, receipt) {
  return writeScenarioCanaryLine(
    stream,
    SCENARIO_CANARY_MARKER,
    receipt,
    'scenario canary receipt is not serializable',
  )
}

/**
 * Preserve the canary's final host ordering in one testable boundary: write a
 * successful receipt, report any failure, dispose resources, then request host
 * exit with the matching status.
 *
 * @param {{
 *   stream:{write:(chunk:string, callback:(error?:Error|null)=>void)=>unknown},
 *   receipt:unknown,
 *   failure?:{error:unknown},
 *   reportFailure:(error:unknown)=>void,
 *   dispose:()=>Promise<void>,
 *   successStatus:number,
 *   setExitCode:(status:number)=>void,
 *   exit:(status:number)=>void,
 * }} options
 */
export async function finalizeScenarioCanary(options) {
  let failure = options.failure
  if (failure === undefined) {
    try {
      await writeScenarioCanaryReceipt(options.stream, options.receipt)
    } catch (error) {
      failure = { error }
    }
  }
  try {
    if (failure !== undefined) options.reportFailure(failure.error)
  } finally {
    try {
      await options.dispose()
    } finally {
      const status = failure === undefined ? options.successStatus : 1
      options.setExitCode(status)
      options.exit(status)
    }
  }
}
