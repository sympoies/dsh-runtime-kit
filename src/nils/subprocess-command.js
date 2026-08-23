// @ts-check

import { isAbsolute } from 'node:path'

/**
 * DSH's subprocess seam requires argv[0] to be fully resolved. Preserve an
 * explicitly configured absolute executable, but resolve a portable bare name
 * through the subprocess service before handing it to spawn.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} argv
 * @param {Readonly<NodeJS.ProcessEnv> | undefined} environment
 * @param {AbortSignal | undefined} signal
 */
export async function resolveSubprocessArgv(ctx, argv, environment, signal) {
  const [command, ...args] = argv
  if (command === undefined || command.length === 0) {
    throw new TypeError('dsh-runtime-kit: subprocess command is required')
  }
  if (isAbsolute(command)) return argv
  // The resolver contract accepts string overrides only. Undefined entries are
  // spawn-time tombstones and cannot affect PATH lookup, so omit them here and
  // retain the complete environment on the subsequent spawn call.
  /** @type {Record<string, string> | undefined} */
  let resolverEnvironment
  if (environment !== undefined) {
    resolverEnvironment = {}
    for (const [name, value] of Object.entries(environment)) {
      if (typeof value === 'string') resolverEnvironment[name] = value
    }
  }
  const executable = await ctx.subprocess.resolveExecutable(command, resolverEnvironment, signal)
  return [executable, ...args]
}
