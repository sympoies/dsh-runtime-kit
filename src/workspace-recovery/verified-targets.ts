import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

export class WorktreeTargetError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`dsh-runtime-kit:${code}`)
    this.code = code
  }
}

function inside(root: string, path: string) {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
}

/** Resolve each call against its authenticated checkout target, independent of the session cwd. */
export function createVerifiedWorktreeTargets(ctx: import('@deepseek-ai/cordis').Context) {
  return Object.freeze({
    async resolve(exec: ToolExecution, sessionCwd: string) {
      const lease = ctx.get('workspaceLease') as { targets?: (exec: ToolExecution) => Promise<readonly string[]> } | undefined
      if (typeof lease?.targets !== 'function') {
        throw new WorktreeTargetError('worktree-target-lease-unavailable')
      }
      const roots = await lease.targets(exec)
      if (roots.length > 1) throw new WorktreeTargetError('worktree-target-ambiguous')
      const workdir = exec.name === 'bash' && exec.arguments !== null && typeof exec.arguments === 'object'
        ? (exec.arguments as Record<string, unknown>).workdir
        : undefined
      if (workdir !== undefined && (typeof workdir !== 'string'
        || !isAbsolute(workdir) || workdir.includes('\0'))) {
        throw new WorktreeTargetError('worktree-target-workdir-invalid')
      }
      const root = roots[0] ?? (typeof workdir === 'string' ? workdir : sessionCwd)
      if (typeof workdir === 'string') {
        try {
          const [physicalRoot, physicalWorkdir] = await Promise.all([realpath(root), realpath(workdir)])
          if (physicalRoot !== root || physicalWorkdir !== workdir || !inside(root, workdir)) {
            throw new WorktreeTargetError('worktree-target-workdir-mismatch')
          }
        } catch {
          throw new WorktreeTargetError('worktree-target-workdir-mismatch')
        }
      }
      return root
    },
  })
}
