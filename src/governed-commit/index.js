// @ts-check

import { isAbsolute } from 'node:path'

import { isolatedNilsEnvironment } from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */

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

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function boundedMs(value, fallback, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {Record<string, unknown>} value @param {readonly string[]} expected */
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

/** @param {unknown} value */
function fullObjectId(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/** @param {unknown} value @param {number} maxBytes */
function boundedLine(value, maxBytes) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r')
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

/** @param {unknown} value */
function safeGitPath(value) {
  return boundedLine(value, MAX_PATH_BYTES)
    && !isAbsolute(/** @type {string} */ (value))
    && !/** @type {string} */ (value).split('/').includes('..')
}

/**
 * @typedef GovernedCommitArgs
 * @property {string} type
 * @property {string | undefined} scope
 * @property {string} subject
 * @property {string[]} body_bullets
 * @property {string} expected_head
 */

/** @param {unknown} input @returns {GovernedCommitArgs} */
function governedArgs(input) {
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
    scope: /** @type {string | undefined} */ (input.scope),
    subject: /** @type {string} */ (input.subject),
    body_bullets: /** @type {string[]} */ ([...input.body_bullets]),
    expected_head: /** @type {string} */ (input.expected_head),
  }
}

/** @param {GovernedCommitArgs} args */
function semanticArgv(args) {
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

/** @param {unknown} value */
function semanticReceipt(value) {
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
  const fileCount = /** @type {number} */ (value.staged.file_count)
  const files = value.staged.files.map(entry => {
    if (!record(entry)
      || !exactKeys(entry, ['status', 'path', 'old_path'])
      || !boundedLine(entry.status, 16)
      || !safeGitPath(entry.path)
      || !(entry.old_path === null || safeGitPath(entry.old_path))) {
      throw new Error('dsh-runtime-kit:governed-commit-receipt-invalid')
    }
    return {
      status: /** @type {string} */ (entry.status),
      path: /** @type {string} */ (entry.path),
      old_path: /** @type {string | null} */ (entry.old_path),
    }
  })
  return {
    schema_version: RESULT_SCHEMA,
    status: /** @type {const} */ ('committed'),
    commit: {
      sha: /** @type {string} */ (value.commit.sha),
      subject: /** @type {string} */ (value.commit.subject),
    },
    staged: {
      file_count: fileCount,
      files,
    },
  }
}

/**
 * @param {{HarnessError?: new (message: string, code: string) => Error, TOOL_ABORTED?: string}} runtime
 * @param {string} message
 * @param {string} code
 */
function failure(runtime, message, code) {
  if (runtime.HarnessError !== undefined) return new runtime.HarnessError(message, code)
  const error = new Error(message)
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  return error
}

/**
 * Create the first-class DSH governed commit tool. Repository routing is
 * intentionally absent from its model schema: the exact worktree is the
 * authenticated session cwd already covered by WorkspaceLease.
 *
 * @param {Context} ctx
 * @param {{
 *   semanticCommit?: string,
 *   governedCommitTimeoutMs?: number,
 *   governedCommitTeardownTimeoutMs?: number,
 *   canonicalPath: (path: string) => string,
 *   HarnessError?: new (message: string, code: string) => Error,
 *   TOOL_ABORTED?: string,
 * }} config
 * @returns {ToolDefinition}
 */
export function createGovernedCommitTool(ctx, config) {
  if (config === null || typeof config !== 'object' || typeof config.canonicalPath !== 'function') {
    throw new TypeError('dsh-runtime-kit: governed commit requires DSH canonicalPath')
  }
  const semanticCommit = config.semanticCommit ?? 'semantic-commit'
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
  /** @type {Set<{controller: AbortController, handle?: SubprocessHandle}>} */
  const active = new Set()
  let open = true

  ctx.effect(() => () => {
    open = false
    for (const operation of active) {
      operation.controller.abort(failure(config, 'governed commit disposed', 'GOVERNED_COMMIT_DISPOSED'))
      try { operation.handle?.terminate() } catch {}
    }
  }, 'dsh-runtime-kit governed commit transport')

  /** @param {SubprocessHandle} handle */
  async function boundedQuiescence(handle) {
    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        try { handle.terminate() } catch {}
        resolve(false)
      }, teardownTimeoutMs)
    })
    try {
      return await Promise.race([
        Promise.resolve(handle.waitForExit(controller.signal)).then(value => value === true, () => false),
        deadline,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** @type {ToolDefinition} */
  const definition = {
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
      schema: {
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
      },
      render: (_args, value) => {
        const result = /** @type {ReturnType<typeof semanticReceipt>} */ (value)
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
      const headerCwd = exec.agent?.session?.header?.cwd
      if (typeof headerCwd !== 'string' || !isAbsolute(headerCwd)) {
        throw failure(config, 'authenticated session worktree is unavailable', 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE')
      }
      const cwd = config.canonicalPath(headerCwd)
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        throw failure(config, 'authenticated session worktree is unavailable', 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE')
      }
      if (exec.signal.aborted) {
        throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
      }

      /** @type {{controller: AbortController, handle?: SubprocessHandle}} */
      const operation = { controller: new AbortController() }
      active.add(operation)
      const onCallerAbort = () => {
        operation.controller.abort(exec.signal.reason)
        try { operation.handle?.terminate() } catch {}
      }
      exec.signal.addEventListener('abort', onCallerAbort, { once: true })
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      let timedOut = false
      try {
        const argv = await resolveSubprocessArgv(
          ctx,
          [semanticCommit, ...semanticArgv(args)],
          operation.controller.signal,
        )
        if (operation.controller.signal.aborted) {
          throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
        }
        const handle = ctx.subprocess.spawn({
          argv,
          cwd,
          env: isolatedNilsEnvironment(undefined),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_ERROR_BYTES },
          },
          graceMs: 1_000,
          signal: operation.controller.signal,
        })
        operation.handle = handle
        let releaseDeadline = () => {}
        const deadline = new Promise(resolve => { releaseDeadline = () => resolve(undefined) })
        timer = setTimeout(() => {
          timedOut = true
          operation.controller.abort()
          try { handle.terminate() } catch {}
          releaseDeadline()
        }, timeoutMs)
        const outcome = await Promise.race([
          Promise.resolve(handle.done).then(value => value, () => undefined),
          deadline,
        ])
        const quiescent = await boundedQuiescence(handle)
        if (!quiescent) {
          open = false
          throw failure(config, 'governed commit subprocess did not quiesce', 'GOVERNED_COMMIT_UNAVAILABLE')
        }
        if (exec.signal.aborted) {
          throw failure(config, 'governed commit was cancelled', config.TOOL_ABORTED ?? 'GOVERNED_COMMIT_ABORTED')
        }
        if (timedOut) {
          throw failure(config, 'governed commit timed out', 'GOVERNED_COMMIT_TIMEOUT')
        }
        if (outcome === undefined || outcome.signal !== null || outcome.exitCode !== 0) {
          throw failure(config, 'semantic-commit rejected the governed commit', 'GOVERNED_COMMIT_REJECTED')
        }
        const stdout = handle.collected.stdout?.readFrom(0)
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
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
        active.delete(operation)
      }
    },
  }
  return Object.freeze(definition)
}

/**
 * @param {Context} ctx
 * @param {Parameters<typeof createGovernedCommitTool>[1]} config
 */
export function applyGovernedCommit(ctx, config) {
  ctx.tools.register(createGovernedCommitTool(ctx, config))
}
