export const SCENARIO_CANARY_MARKER = 'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY='

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
