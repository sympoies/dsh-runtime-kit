import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

type Handoff = { handoff: null | { status: 'verified', path: string, head: string } }

export class UnverifiedWorktreeTargetError extends Error {
  readonly targetPath: string
  readonly isWorkdir: boolean

  constructor(targetPath: string, isWorkdir = false) {
    super('dsh-runtime-kit:verified-worktree-target-unverified')
    this.targetPath = targetPath
    this.isWorkdir = isWorkdir
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
      const workdir = exec.name === 'bash' && exec.arguments !== null && typeof exec.arguments === 'object'
        ? (exec.arguments as Record<string, unknown>).workdir
        : undefined
      if (workdir !== undefined && (typeof workdir !== 'string'
        || !isAbsolute(workdir) || workdir.includes('\0'))) {
        throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
      }
      const authorized = verified.get(session(exec))
      if (roots.length === 0 && typeof workdir === 'string'
        && !inside(sessionCwd, workdir)
        && (authorized === undefined || !inside(authorized, workdir))) {
        throw new UnverifiedWorktreeTargetError(workdir, true)
      }
      const root = roots[0] ?? (typeof workdir === 'string' && authorized !== undefined
        && inside(authorized, workdir) ? authorized : sessionCwd)
      if (!inside(root, sessionCwd) && authorized !== root) {
        throw new UnverifiedWorktreeTargetError(root)
      }
      if (exec.name === 'bash' && !inside(root, sessionCwd)) {
        if (typeof workdir !== 'string') {
          throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
        }
        try {
          const [physicalRoot, physicalWorkdir] = await Promise.all([realpath(root), realpath(workdir)])
          if (physicalRoot !== root || !inside(physicalRoot, physicalWorkdir)) {
            throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
          }
        } catch {
          throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
        }
      }
      if (typeof workdir === 'string' && !inside(root, workdir)) {
        throw new Error('dsh-runtime-kit:verified-worktree-workdir-mismatch')
      }
      return root
    },
  })
}
