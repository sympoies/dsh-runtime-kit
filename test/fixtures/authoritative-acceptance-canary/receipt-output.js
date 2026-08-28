export const SCENARIO_CANARY_MARKER = 'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY='

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
