import { isAbsolute } from 'node:path'

export function requiredAbsolutePath(value: unknown, field: string) {
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
 */

export function resolveAgentHookRuntime(config: {agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string} = {}) {
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
    argv(args: string[]) {
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
