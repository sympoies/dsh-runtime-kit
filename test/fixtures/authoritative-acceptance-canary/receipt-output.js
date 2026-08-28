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
