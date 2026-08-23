// @ts-check

import { isAbsolute } from 'node:path'

/**
 * DSH's subprocess seam requires argv[0] to be fully resolved. Preserve an
 * explicitly configured absolute executable, but resolve a portable bare name
 * through the subprocess service before handing it to spawn.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} argv
 * @param {AbortSignal | undefined} signal
 */
export async function resolveSubprocessArgv(ctx, argv, signal) {
  const [command, ...args] = argv
  if (command === undefined || command.length === 0) {
    throw new TypeError('dsh-runtime-kit: subprocess command is required')
  }
  if (isAbsolute(command)) return argv
  // Resolve portable helper names against the DSH host execution PATH. The
  // caller still supplies its isolated environment to spawn after resolution.
  const executable = await ctx.subprocess.resolveExecutable(command, undefined, signal)
  return [executable, ...args]
}
