import { existsSync, readFileSync } from 'node:fs'

export function createBodyExecutionCounter() {
  let executions = 0
  let firstTurnExecutions

  return Object.freeze({
    bodyExecuted() {
      executions += 1
    },
    turnStopping(observedExecutions = 0) {
      if (!Number.isSafeInteger(observedExecutions) || observedExecutions < 0) {
        throw new Error('observed body executions must be a nonnegative safe integer')
      }
      if (firstTurnExecutions === undefined) {
        firstTurnExecutions = executions + observedExecutions
      }
    },
    receipt() {
      return firstTurnExecutions ?? executions
    },
  })
}

export function validationBodyExecutions(path, token) {
  if (!existsSync(path)) return 0
  const records = readFileSync(path, 'utf8').split('\n')
  if (records.at(-1) !== '') throw new Error('validation body evidence is invalid')
  records.pop()
  if (records.length === 0 || records.some(record => record !== token)) {
    throw new Error('validation body evidence is invalid')
  }
  return records.length
}
