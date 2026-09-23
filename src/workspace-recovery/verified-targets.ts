import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative } from 'node:path'

type Handoff = { handoff: null | { status: 'verified', path: string, head: string } }

export class UnverifiedWorktreeTargetError extends Error {
  readonly targetPath: string

  constructor(targetPath: string) {
    super('dsh-runtime-kit:verified-worktree-target-unverified')
    this.targetPath = targetPath
  }
}

function inside(root: string, path: string) {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
}

/** Bind a verified managed worktree to the current DSH session lifecycle. */
export function createVerifiedWorktreeTargets(
  ctx: import('@deepseek-ai/cordis').Context,
  recovery: { verifyHandoff(exec: ToolRunContext, path: string): Promise<Handoff> },
) {
  let verified = new WeakMap<object, string>()
  ctx.effect(() => () => { verified = new WeakMap() }, 'verified worktree targets')

  function session(exec: ToolExecution) {
    const agent = exec.agent
    const value = agent?.session
    if (agent === undefined || value === undefined || agent.id !== value.id || value.header.id !== value.id) {
      throw new Error('dsh-runtime-kit:verified-worktree-session-invalid')
    }
    return value
  }

  return Object.freeze({
    async verify(exec: ToolRunContext, path: string) {
      const current = session(exec)
      const result = await recovery.verifyHandoff(exec, path)
      if (result.handoff?.status !== 'verified' || result.handoff.path !== path) {
        throw new Error('dsh-runtime-kit:verified-worktree-path-invalid')
      }
      return Object.freeze({ session: current, path })
    },
    authorize(proof: { session: object, path: string }) {
      verified.set(proof.session, proof.path)
    },
    async resolve(exec: ToolExecution, sessionCwd: string) {
      const lease = ctx.get('workspaceLease') as { targets?: (exec: ToolExecution) => Promise<readonly string[]> } | undefined
      if (typeof lease?.targets !== 'function') {
        throw new Error('dsh-runtime-kit:verified-worktree-lease-unavailable')
      }
      const roots = await lease.targets(exec)
      if (roots.length > 1) throw new Error('dsh-runtime-kit:verified-worktree-target-ambiguous')
      const root = roots[0] ?? sessionCwd
      if (!inside(root, sessionCwd) && verified.get(session(exec)) !== root) {
        throw new UnverifiedWorktreeTargetError(root)
      }
      if (exec.name === 'bash' && exec.arguments !== null && typeof exec.arguments === 'object') {
        const workdir = (exec.arguments as Record<string, unknown>).workdir
        if (workdir !== undefined && (typeof workdir !== 'string'
          || !isAbsolute(workdir) || workdir.includes('\0')
          || !inside(root, workdir))) {
          throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
        }
      }
      return root
    },
  })
}
