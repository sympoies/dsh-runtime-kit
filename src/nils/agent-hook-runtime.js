// @ts-check

import { isAbsolute } from 'node:path'

/** @param {unknown} value @param {string} field */
export function requiredAbsolutePath(value, field) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !isAbsolute(value)) {
    throw new TypeError(`dsh-runtime-kit: ${field} is required and must be an absolute path`)
  }
  return value
}

/**
 * Keep every agent-hook surface on the same explicit DSH-only config, policy,
 * and state roots. Ambient XDG/HOME selection belongs to other providers and
 * is never an acceptable fallback for this bundle.
 *
 * @param {{agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string}} config
 */
export function resolveAgentHookRuntime(config = {}) {
  const command = config.agentHook === undefined ? 'agent-hook' : config.agentHook
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) {
    throw new TypeError('dsh-runtime-kit: agentHook must be a non-empty executable name')
  }
  const configPath = requiredAbsolutePath(config.agentHookConfig, 'agentHookConfig')
  const policyPath = requiredAbsolutePath(config.agentHookPolicy, 'agentHookPolicy')
  const stateDir = requiredAbsolutePath(config.agentHookStateDir, 'agentHookStateDir')

  return Object.freeze({
    command,
    configPath,
    policyPath,
    stateDir,
    /** @param {string[]} args */
    argv(args) {
      return [
        command,
        '--config', configPath,
        '--policy', policyPath,
        '--state-dir', stateDir,
        ...args,
      ]
    },
  })
}
