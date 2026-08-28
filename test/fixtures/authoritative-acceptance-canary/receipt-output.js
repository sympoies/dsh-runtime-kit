export const SCENARIO_CANARY_MARKER = 'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY='
export const SCENARIO_CANARY_DEADLINE_ENV = 'DSH_ACCEPTANCE_CANARY_DEADLINE_EPOCH_MS'
export const SCENARIO_CANARY_EXECUTION_TIMEOUT_MS = 120_000
export const SCENARIO_CANARY_PROCESS_TIMEOUT_MS = 180_000

/**
 * Derive the remaining canary execution budget from the parent-authenticated
 * process-start deadline. A canary loaded late receives only the remaining
 * budget, so its deadline cannot drift beyond the outer process supervisor.
 *
 * @param {unknown} deadlineEpoch
 * @param {number} [now]
 */
export function scenarioCanaryDeadlineDelay(deadlineEpoch, now = Date.now()) {
  if (typeof deadlineEpoch !== 'string' || !/^[1-9][0-9]{12}$/u.test(deadlineEpoch)
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('scenario canary execution deadline is invalid')
  }
  const deadline = Number(deadlineEpoch)
  if (!Number.isSafeInteger(deadline)) {
    throw new Error('scenario canary execution deadline is invalid')
  }
  return Math.max(0, deadline - now)
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
 *   onUnhandledFailure?:(error:unknown)=>void,
 *   now?:()=>number,
 *   setTimer?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>,
 *   clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void,
 * }} options
 */
export function createScenarioCanaryDeadlineController(options) {
  let finalization
  let postDeadlineCleanup
  const finalizeOnce = (receipt, failure) => {
    if (finalization !== undefined) return finalization
    finalization = finalizeScenarioCanary({
      stream: options.stream,
      receipt,
      failure,
      reportFailure: options.reportFailure,
      dispose: options.dispose,
      successStatus: options.successStatus(),
      setExitCode: options.setExitCode,
      exit: options.exit,
    })
    return finalization
  }
  const deadlineTimer = scheduleScenarioCanaryDeadline(
    options.deadlineEpoch,
    () => {
      const failure = { error: new Error('scenario execution deadline exceeded') }
      void finalizeOnce(undefined, failure).catch(error => options.onUnhandledFailure?.(error))
    },
    { now: options.now, setTimer: options.setTimer },
  )
  const clearTimer = options.clearTimer ?? clearTimeout
  return Object.freeze({
    isFinalizing() { return finalization !== undefined },
    wait() { return finalization ?? Promise.resolve() },
    finish(receipt, failure) {
      clearTimer(deadlineTimer)
      if (finalization === undefined) return finalizeOnce(receipt, failure)
      postDeadlineCleanup ??= finalization.finally(options.dispose)
      return postDeadlineCleanup
    },
  })
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
  const serialized = JSON.stringify(receipt)
  if (serialized === undefined) {
    return Promise.reject(new Error('scenario canary receipt is not serializable'))
  }
  return new Promise((resolve, reject) => {
    try {
      stream.write(SCENARIO_CANARY_MARKER + serialized + '\n', error => {
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
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
