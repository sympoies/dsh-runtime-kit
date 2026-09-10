import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import {
  authenticatedNilsEnvironment,
  isolatedNilsEnvironment,
  resolveManagedSessionPrincipal,
} from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

export type Context = import('@deepseek-ai/cordis').Context
export type ToolDefinition = import('@deepseek-ai/dsh-tools').ToolDefinition
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle
export type ActiveGovernedCommit = { controller: AbortController, handle?: SubprocessHandle | undefined, cause?: 'disposed' | 'unavailable' | undefined, interrupt: () => void, settled: Promise<void>, resolveSettled: () => void }

const RESULT_SCHEMA = 'dsh-runtime-kit.governed-commit.result.v1'
const SEMANTIC_RECEIPT_SCHEMA = 'cli.semantic-commit.commit.v1'
const COMMIT_TYPES = Object.freeze([
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
])
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_TEARDOWN_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_ERROR_BYTES = 8 * 1024
const MAX_STAGED_FILES = 4_096
const MAX_SUBJECT_BYTES = 512
const MAX_PATH_BYTES = 4_096

function boundedMs(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

function signingEnvironment(environment: Readonly<NodeJS.ProcessEnv>) {
  const selected = (({}) as NodeJS.ProcessEnv)
  for (const name of ['GNUPGHOME', 'GPG_TTY', 'SSH_AUTH_SOCK'] as const) {
    const value = environment[name]
    if (typeof value === 'string' && value.length > 0) selected[name] = value
  }
  return selected
}

function record(value: unknown): value is Record<string, unknown>  {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function fullObjectId(value: unknown) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

function boundedLine(value: unknown, maxBytes: number) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r')
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function safeGitPath(value: unknown) {
  return boundedLine(value, MAX_PATH_BYTES)
    && !isAbsolute(((value) as string))
    && !((value) as string).split('/').includes('..')
}

export type GovernedCommitArgs = { type: string, scope: string | undefined, subject: string, body_bullets: string[], expected_head: string }

function governedArgs(input: unknown): GovernedCommitArgs  {
  if (!record(input)) {
    throw new TypeError('runtime_kit_governed_commit expects an argument object')
  }
  const required = ['type', 'subject', 'body_bullets', 'expected_head']
  const expected = Object.hasOwn(input, 'scope') ? [...required, 'scope'] : required
  if (!exactKeys(input, expected)) {
    throw new TypeError('runtime_kit_governed_commit expects exactly the governed message and expected-head fields')
  }
  if (typeof input.type !== 'string' || !COMMIT_TYPES.includes(input.type)) {
    throw new TypeError('runtime_kit_governed_commit type is unsupported')
  }
  if (input.scope !== undefined
    && (typeof input.scope !== 'string'
      || !/^[a-z0-9][a-z0-9._/-]{0,48}$/.test(input.scope))) {
    throw new TypeError('runtime_kit_governed_commit scope is invalid')
  }
  if (!boundedLine(input.subject, 100)) {
    throw new TypeError('runtime_kit_governed_commit subject must be one bounded line')
  }
  if (!Array.isArray(input.body_bullets)
    || input.body_bullets.length < 1
    || input.body_bullets.length > 20
    || !input.body_bullets.every(value => boundedLine(value, 500))) {
    throw new TypeError('runtime_kit_governed_commit body_bullets must contain bounded lines')
  }
  if (!fullObjectId(input.expected_head)) {
    throw new TypeError('runtime_kit_governed_commit expected_head must be a full object id')
  }
  return {
    type: input.type,
    scope: ((input.scope) as string | undefined),
    subject: ((input.subject) as string),
    body_bullets: (([...input.body_bullets]) as string[]),
    expected_head: ((input.expected_head) as string),
  }
}

function semanticArgv(args: GovernedCommitArgs) {
  return [
    'commit',
    '--automation',
    '--json',
    '--summary', 'none',
    '--expect-head', args.expected_head,
    '--type', args.type,
    ...(args.scope === undefined ? [] : ['--scope', args.scope]),
    '--subject', args.subject,
    ...args.body_bullets.flatMap(value => ['--body-bullet', value]),
  ]
}

function semanticReceipt(value: unknown) {
  if (!record(value)
    || !exactKeys(value, [
      'schema_version',
      'ok',
      'operation',
      'validate_only',
      'dry_run',
      'commit',
      'target',
      'staged',
    ])
    || value.schema_version !== SEMANTIC_RECEIPT_SCHEMA
    || value.ok !== true
    || value.operation !== 'commit'
    || value.validate_only !== false
    || value.dry_run !== false
    || value.target !== null
    || !record(value.commit)
    || !exactKeys(value.commit, ['sha', 'subject'])
    || !fullObjectId(value.commit.sha)
    || !boundedLine(value.commit.subject, MAX_SUBJECT_BYTES)
    || !record(value.staged)
    || !exactKeys(value.staged, ['file_count', 'files'])
    || typeof value.staged.file_count !== 'number'
    || !Number.isSafeInteger(value.staged.file_count)
    || value.staged.file_count < 1
    || value.staged.file_count > MAX_STAGED_FILES
    || !Array.isArray(value.staged.files)
    || value.staged.files.length !== value.staged.file_count) {
    throw new Error('dsh-runtime-kit:governed-commit-receipt-invalid')
  }
  const fileCount = ((value.staged.file_count) as number)
  const files = value.staged.files.map(entry => {
    if (!record(entry)
      || !exactKeys(entry, ['status', 'path', 'old_path'])
      || !boundedLine(entry.status, 16)
      || !safeGitPath(entry.path)
      || !(entry.old_path === null || safeGitPath(entry.old_path))) {
      throw new Error('dsh-runtime-kit:governed-commit-receipt-invalid')
    }
    return {
      status: ((entry.status) as string),
      path: ((entry.path) as string),
      old_path: ((entry.old_path) as string | null),
    }
  })
  return {
    schema_version: RESULT_SCHEMA,
    status: (('committed') as const),
    commit: {
      sha: ((value.commit.sha) as string),
      subject: ((value.commit.subject) as string),
    },
    staged: {
      file_count: fileCount,
      files,
    },
  }
}

function failure(runtime: {HarnessError?: new (message: string, code: string) => Error, TOOL_ABORTED?: string}, message: string, code: string) {
  if (runtime.HarnessError !== undefined) return new runtime.HarnessError(message, code)
  const error = new Error(message)
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  return error
}

type NoRepositoryResult = { schema_version: typeof RESULT_SCHEMA, status: 'no-repository', cwd: string, guidance: string }

/**
 * Whether any ancestor of `cwd` carries a `.git` entry (directory or the
 * `gitdir:` file of a linked worktree). Mirrors the agent-hook seam, which
 * admits the tool outside every repository for exactly this answer.
 */
function insideRepository(cwd: string): boolean {
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function noRepositoryResult(cwd: string): NoRepositoryResult {
  return {
    schema_version: RESULT_SCHEMA,
    status: 'no-repository',
    cwd,
    guidance: 'The authenticated session cwd is not inside a Git repository, so there is nothing to commit. Start the session from a managed worktree (git-cli worktree add) or an existing repository to deliver a governed commit.',
  }
}

/**
 * Create the first-class DSH governed commit tool. Repository routing is
 * intentionally absent from its model schema: the exact worktree is the
 * authenticated session cwd already covered by WorkspaceLease.
 */
export function createGovernedCommitTool(ctx: Context, config: {
    semanticCommit?: string,
    governedCommitTimeoutMs?: number,
    governedCommitTeardownTimeoutMs?: number,
    canonicalPath: (path: string) => string,
    hasRepository?: (cwd: string) => boolean,
    environment?: Readonly<NodeJS.ProcessEnv>,
    runtime?: { uid?: number, platform?: NodeJS.Platform },
    managedSessionBridge?: { resolve?: (id: string) => unknown },
    HarnessError?: new (message: string, code: string) => Error,
    TOOL_ABORTED?: string,
  }): ToolDefinition  {
  if (config === null || typeof config !== 'object' || typeof config.canonicalPath !== 'function') {
    throw new TypeError('dsh-runtime-kit: governed commit requires DSH canonicalPath')
  }
  const semanticCommit = config.semanticCommit ?? 'semantic-commit'
  const hasRepository = config.hasRepository ?? insideRepository
  const environment = config.environment ?? process.env
  const runtime = config.runtime ?? { uid: process.getuid?.(), platform: process.platform }
  if (typeof semanticCommit !== 'string'
    || semanticCommit.length === 0
    || semanticCommit !== semanticCommit.trim()
    || (!isAbsolute(semanticCommit) && semanticCommit.includes('/'))) {
    throw new TypeError('dsh-runtime-kit: semanticCommit must be an absolute path or bare executable name')
  }
  const timeoutMs = boundedMs(
    config.governedCommitTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  const teardownTimeoutMs = boundedMs(
    config.governedCommitTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    MAX_TEARDOWN_TIMEOUT_MS,
  )
  const active: Set<ActiveGovernedCommit> = new Set()
  let open = true

  function cancel(operation: ActiveGovernedCommit, cause: 'disposed' | 'unavailable') {
    if (operation.cause !== undefined) return
    operation.cause = cause
    operation.controller.abort()
    try { operation.handle?.terminate() } catch {}
    operation.interrupt()
  }

  function degrade() {
    open = false
    for (const operation of active) cancel(operation, 'unavailable')
  }

  async function dispose() {
    if (!open && active.size === 0) return
    open = false
    const pending = [...active]
    for (const operation of pending) cancel(operation, 'disposed')
    await Promise.allSettled(pending.map(operation => operation.settled))
  }

  ctx.effect(() => dispose, 'dsh-runtime-kit governed commit transport')

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        try { handle.terminate() } catch {}
        resolve(false)
      }, teardownTimeoutMs)
    })
    try {
      const observed = Promise.resolve()
        .then(() => handle.waitForExit(controller.signal))
        .then(value => value === true, () => false)
      return await Promise.race([observed, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const definition: ToolDefinition = {
    name: 'runtime_kit_governed_commit',
    description: 'Create one governed commit from the staged changes in this session-owned non-default managed worktree.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...COMMIT_TYPES] },
        scope: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,48}$' },
        subject: { type: 'string', minLength: 1, maxLength: 100 },
        body_bullets: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
        expected_head: { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' },
      },
      required: ['type', 'subject', 'body_bullets', 'expected_head'],
      additionalProperties: false,
    },
    output: {
      // Two variants discriminated by `status`, each with its own required
      // fields, so a committed receipt cannot validate without its commit and
      // staged summary and a no-repository answer cannot validate without its
      // guidance.
      schema: {
        oneOf: [{
          type: 'object',
          properties: {
            schema_version: { type: 'string', const: RESULT_SCHEMA },
            status: { type: 'string', const: 'no-repository' },
            cwd: { type: 'string' },
            guidance: { type: 'string' },
          },
          required: ['schema_version', 'status', 'cwd', 'guidance'],
          additionalProperties: false,
        }, {
        type: 'object',
        properties: {
          schema_version: { type: 'string', const: RESULT_SCHEMA },
          status: { type: 'string', const: 'committed' },
          commit: {
            type: 'object',
            properties: {
              sha: { type: 'string' },
              subject: { type: 'string' },
            },
            required: ['sha', 'subject'],
            additionalProperties: false,
          },
          staged: {
            type: 'object',
            properties: {
              file_count: { type: 'integer' },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    path: { type: 'string' },
                    old_path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                  required: ['status', 'path', 'old_path'],
                  additionalProperties: false,
                },
              },
            },
            required: ['file_count', 'files'],
            additionalProperties: false,
          },
        },
        required: ['schema_version', 'status', 'commit', 'staged'],
        additionalProperties: false,
        }],
      },
      render: (_args, value) => {
        const result = ((value) as ReturnType<typeof semanticReceipt> | NoRepositoryResult)
        if (result.status === 'no-repository') {
          return [{ type: 'text', text: `No governed commit: ${result.guidance}` }]
        }
        return [{
          type: 'text',
          text: `Created governed commit ${result.commit.sha}: ${result.commit.subject} (${result.staged.file_count} staged files).`,
        }]
      },
    },
    async execute(input, exec) {
      const args = governedArgs(input)
      if (!open) {
        throw failure(config, 'governed commit transport is disposed', 'GOVERNED_COMMIT_DISPOSED')
      }
      const sessionId = String(exec.agent?.id ?? '')
      const principal = sessionId.length === 0
        ? undefined
        : resolveManagedSessionPrincipal(ctx, sessionId, config.managedSessionBridge)
      const headerCwd = exec.agent?.session?.header?.cwd
      if (typeof headerCwd !== 'string' || !isAbsolute(headerCwd)) {
        throw failure(config, 'authenticated session worktree is unavailable', 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE')
      }
      let cwd
      try {
        cwd = config.canonicalPath(headerCwd)
      } catch {
        throw failure(config, 'authenticated session worktree is unavailable', 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE')
      }
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        throw failure(config, 'authenticated session worktree is unavailable', 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE')
      }
      // A non-repository cwd is context, not a denial: there is nothing to
      // commit, so the model gets a typed result with the next step instead
      // of an opaque semantic-commit rejection.
      if (!hasRepository(cwd)) {
        return noRepositoryResult(cwd)
      }
      if (exec.signal.aborted) {
        throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
      }

      let resolveSettled = () => {}
      const settled: Promise<void> = new Promise(resolve => { resolveSettled = () => resolve() })
      let interrupt = () => {}
      const interrupted: Promise<void> = new Promise(resolve => { interrupt = () => resolve() })
      const operation: ActiveGovernedCommit = {
        controller: new AbortController(),
        interrupt,
        settled,
        resolveSettled,
      }
      active.add(operation)
      const onCallerAbort = () => {
        operation.controller.abort(exec.signal.reason)
        try { operation.handle?.terminate() } catch {}
        operation.interrupt()
      }
      exec.signal.addEventListener('abort', onCallerAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        timer = setTimeout(() => {
          timedOut = true
          operation.controller.abort()
          try { operation.handle?.terminate() } catch {}
          operation.interrupt()
        }, timeoutMs)
        let handle
        try {
          const resolution = Promise.resolve()
            .then(() => resolveSubprocessArgv(
              ctx,
              [semanticCommit, ...semanticArgv(args)],
              operation.controller.signal,
            ))
            .then(
              argv => ({ status: (('resolved') as const), argv }),
              () => ({ status: (('failed') as const) }),
            )
          const resolved = await Promise.race([
            resolution,
            interrupted.then(() => ({ status: (('interrupted') as const) })),
          ])
          if (resolved.status === 'interrupted') {
            if (timedOut) {
              throw failure(config, 'governed commit timed out', 'GOVERNED_COMMIT_TIMEOUT')
            }
            throw new Error('governed commit interrupted')
          }
          if (resolved.status === 'failed') {
            throw failure(config, 'governed commit transport is unavailable', 'GOVERNED_COMMIT_UNAVAILABLE')
          }
          const argv = resolved.argv
          if (operation.controller.signal.aborted) throw new Error('governed commit cancelled')
          handle = ctx.subprocess.spawn({
            argv,
            cwd,
            env: principal === undefined
              ? isolatedNilsEnvironment(signingEnvironment(environment), environment, runtime)
              : authenticatedNilsEnvironment({
                  ...signingEnvironment(environment),
                  ...principal.environment,
                }, environment, runtime),
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: MAX_OUTPUT_BYTES },
              stderr: { maxBytes: MAX_ERROR_BYTES },
            },
            graceMs: 1_000,
            signal: operation.controller.signal,
          })
          operation.handle = handle
        } catch {
          if (exec.signal.aborted) {
            throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
          }
          if (operation.cause === 'disposed') {
            throw failure(config, 'governed commit disposed', 'GOVERNED_COMMIT_DISPOSED')
          }
          if (timedOut) {
            throw failure(config, 'governed commit timed out', 'GOVERNED_COMMIT_TIMEOUT')
          }
          throw failure(config, 'governed commit transport is unavailable', 'GOVERNED_COMMIT_UNAVAILABLE')
        }
        const outcome = await Promise.race([
          Promise.resolve(handle.done).then(value => value, () => undefined),
          interrupted.then(() => undefined),
        ])
        const quiescent = await boundedQuiescence(handle)
        if (!quiescent) {
          degrade()
          throw failure(config, 'governed commit subprocess did not quiesce', 'GOVERNED_COMMIT_UNAVAILABLE')
        }
        if (exec.signal.aborted) {
          throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
        }
        if (operation.cause === 'disposed') {
          throw failure(config, 'governed commit disposed', 'GOVERNED_COMMIT_DISPOSED')
        }
        if (operation.cause === 'unavailable') {
          throw failure(config, 'governed commit transport is unavailable', 'GOVERNED_COMMIT_UNAVAILABLE')
        }
        if (timedOut) {
          throw failure(config, 'governed commit timed out', 'GOVERNED_COMMIT_TIMEOUT')
        }
        if (outcome === undefined || outcome.signal !== null || outcome.exitCode !== 0) {
          throw failure(config, 'semantic-commit rejected the governed commit', 'GOVERNED_COMMIT_REJECTED')
        }
        let stdout
        try {
          stdout = handle.collected.stdout?.readFrom(0)
        } catch {
          throw failure(config, 'semantic-commit receipt is unavailable', 'GOVERNED_COMMIT_RECEIPT_INVALID')
        }
        if (stdout === undefined
          || stdout.lossy
          || Buffer.byteLength(stdout.text, 'utf8') > MAX_OUTPUT_BYTES) {
          throw failure(config, 'semantic-commit receipt is unavailable', 'GOVERNED_COMMIT_RECEIPT_INVALID')
        }
        let parsed
        try {
          parsed = JSON.parse(stdout.text)
        } catch {
          throw failure(config, 'semantic-commit receipt is invalid', 'GOVERNED_COMMIT_RECEIPT_INVALID')
        }
        try {
          return semanticReceipt(parsed)
        } catch {
          throw failure(config, 'semantic-commit receipt is invalid', 'GOVERNED_COMMIT_RECEIPT_INVALID')
        }
      } catch (error) {
        if (exec.signal.aborted) {
          throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
        }
        if (operation.cause === 'disposed') {
          throw failure(config, 'governed commit disposed', 'GOVERNED_COMMIT_DISPOSED')
        }
        if (operation.cause === 'unavailable') {
          throw failure(config, 'governed commit transport is unavailable', 'GOVERNED_COMMIT_UNAVAILABLE')
        }
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
        active.delete(operation)
        operation.resolveSettled()
      }
    },
  }
  return Object.freeze(definition)
}

export function applyGovernedCommit(ctx: Context, config: Parameters<typeof createGovernedCommitTool>[1]) {
  ctx.tools.register(createGovernedCommitTool(ctx, config))
}
