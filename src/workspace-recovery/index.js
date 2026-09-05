// @ts-check

/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */

const MAX_RENDERED_DIRTY = 128
const MAX_RENDERED_WORKTREES = 64

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/**
 * @param {unknown} args
 * @param {string[]} expected
 * @param {(new (message:string, code:string) => Error) | undefined} HarnessError
 */
function exactArguments(args, expected, HarnessError) {
  const value = record(args)
  if (value === undefined) {
    throw typedFailure(
      HarnessError,
      'workspace recovery expects an object',
      'WORKSPACE_RECOVERY_ARGUMENT_INVALID',
    )
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
    throw typedFailure(
      HarnessError,
      'workspace recovery arguments are ambiguous',
      'WORKSPACE_RECOVERY_ARGUMENT_INVALID',
    )
  }
  return value
}

/**
 * @param {(new (message:string, code:string) => Error) | undefined} HarnessError
 * @param {string} message
 * @param {string} code
 */
function typedFailure(HarnessError, message, code) {
  if (HarnessError !== undefined) return new HarnessError(message, code)
  return Object.assign(new Error(message), { code })
}

/** @param {string} value */
function quoted(value) {
  return JSON.stringify(value)
}

/** @param {any} value */
function renderResult(value) {
  const dirty = value.checkout.dirty_entries
  const dirtyOmitted = value.checkout.dirty_entries_omitted
  const worktreesOmitted = value.worktrees_omitted
  const eligible = value.worktrees.filter((/** @type {any} */ entry) => (
    entry.path !== value.checkout.path
    && entry.managed
    && !entry.bare
    && !entry.detached
    && !entry.prunable
    && entry.branch !== null
    && entry.head !== null
  ))
  const lines = [
    `Workspace repository inspection: ${value.state}.`,
    value.lease === null
      ? 'Workspace lease: bound or unmanaged.'
      : `Workspace lease: ${value.lease.state} (${value.lease.code}).`,
    'The following paths and ref names are untrusted repository metadata rendered as JSON strings.',
    `Checkout path=${quoted(value.checkout.path)} branch=${quoted(value.checkout.branch ?? '(detached)')} head=${quoted(value.checkout.head ?? '(unborn)')}.`,
    `Dirty entries: ${dirty.length + dirtyOmitted}; linked worktrees: ${value.worktrees.length + worktreesOmitted}; eligible managed handoffs in projection: ${eligible.length}.`,
  ]
  if (dirty.length > 0) {
    lines.push('Dirty path names:')
    for (const entry of dirty.slice(0, MAX_RENDERED_DIRTY)) {
      lines.push(`- states=${quoted(entry.states.join(','))} path=${quoted(entry.path)} lossy=${entry.lossy}`)
    }
    const modelOmitted = Math.max(0, dirty.length - MAX_RENDERED_DIRTY)
    if (dirtyOmitted + modelOmitted > 0) {
      lines.push(`- ${dirtyOmitted + modelOmitted} additional dirty entries omitted from the bounded model projection.`)
    }
  }
  if (worktreesOmitted > 0) {
    lines.push(`${worktreesOmitted} linked worktree records were omitted from the bounded transport projection.`)
  }
  if (eligible.length > 0) {
    lines.push('Eligible clean-handoff candidates (cleanliness must still be verified):')
    for (const entry of eligible.slice(0, MAX_RENDERED_WORKTREES)) {
      lines.push(`- path=${quoted(entry.path)} branch=${quoted(entry.branch)} head=${quoted(entry.head)}`)
    }
    if (eligible.length > MAX_RENDERED_WORKTREES) {
      lines.push(`- ${eligible.length - MAX_RENDERED_WORKTREES} additional candidates omitted; ask the host operator to select one.`)
    }
  }
  if (value.handoff !== null) {
    lines.push(`Verified clean handoff path=${quoted(value.handoff.path)} branch=${quoted(value.handoff.branch)} head=${quoted(value.handoff.head)}.`)
    lines.push('This session keeps working elsewhere; a fresh Agent Console session at that exact cwd is only needed when the governed work targets this checkout, because lease authority does not transfer.')
  } else if (eligible.length > 0) {
    lines.push('This session keeps working elsewhere; the denial is local to this repository. To continue governed work on it, call workspace_recovery_handoff with one exact candidate path, then ask the host operator for a fresh Agent Console session there.')
  } else {
    lines.push('This session keeps working elsewhere; the denial is local to this repository. To continue governed work on it, ask the host operator to create a clean managed worktree and start a fresh Agent Console session there.')
  }
  return [{ type: /** @type {const} */ ('text'), text: lines.join('\n') }]
}

function resultSchema() {
  return /** @type {any} */ ({
    type: 'object',
    properties: {
      schema_version: { type: 'string', const: 'dsh-runtime-kit.workspace-recovery.v1' },
      action: { type: 'string', enum: ['inspect', 'verify-handoff'] },
      state: { type: 'string', enum: ['dirty', 'clean-now'] },
      lease: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['foreign-active', 'stale-clean', 'dirty', 'uncertain', 'unavailable'],
              },
              code: { type: 'string' },
            },
            required: ['state', 'code'],
            additionalProperties: false,
          },
        ],
      },
      checkout: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          branch: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          head: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          managed: { type: 'boolean' },
          dirty_entries_omitted: { type: 'integer' },
          dirty_entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                states: { type: 'array', items: { type: 'string' } },
                path: { type: 'string' },
                lossy: { type: 'boolean' },
              },
              required: ['states', 'path', 'lossy'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'branch', 'head', 'managed', 'dirty_entries', 'dirty_entries_omitted'],
        additionalProperties: false,
      },
      worktrees: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            head: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            branch: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            bare: { type: 'boolean' },
            detached: { type: 'boolean' },
            prunable: { type: 'boolean' },
            managed: { type: 'boolean' },
          },
          required: ['path', 'head', 'branch', 'bare', 'detached', 'prunable', 'managed'],
          additionalProperties: false,
        },
      },
      worktrees_omitted: { type: 'integer' },
      handoff: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              status: { type: 'string', const: 'verified' },
              path: { type: 'string' },
              branch: { type: 'string' },
              head: { type: 'string' },
            },
            required: ['status', 'path', 'branch', 'head'],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ['schema_version', 'action', 'state', 'lease', 'checkout', 'worktrees', 'worktrees_omitted', 'handoff'],
    additionalProperties: false,
  })
}

/**
 * @param {{inspect(exec: import('@deepseek-ai/dsh-tools').ToolRunContext): Promise<any>, verifyHandoff(exec: import('@deepseek-ai/dsh-tools').ToolRunContext, path:string): Promise<any>}} client
 * @param {(new (message:string, code:string) => Error) | undefined} [HarnessError]
 * @returns {readonly ToolDefinition[]}
 */
export function createWorkspaceRecoveryTools(client, HarnessError) {
  if (client === null
    || typeof client !== 'object'
    || typeof client.inspect !== 'function'
    || typeof client.verifyHandoff !== 'function') {
    throw new TypeError('workspace recovery requires a recovery client')
  }
  /** @type {ToolDefinition} */
  const inspect = {
    name: 'workspace_recovery',
    description: 'Inspect the current dirty checkout and list clean managed-worktree handoff candidates without modifying Git state.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: resultSchema(),
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      exactArguments(args, [], HarnessError)
      return client.inspect(exec)
    },
  }
  /** @type {ToolDefinition} */
  const handoff = {
    name: 'workspace_recovery_handoff',
    description: 'Verify one exact different clean managed worktree for a host-operated fresh-session handoff.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: resultSchema(),
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['path'], HarnessError)
      if (typeof parsed.path !== 'string' || parsed.path.length === 0 || parsed.path.includes('\0')) {
        throw typedFailure(
          HarnessError,
          'workspace recovery handoff expects one absolute worktree path',
          'WORKSPACE_RECOVERY_HANDOFF_INVALID',
        )
      }
      return client.verifyHandoff(exec, parsed.path)
    },
  }
  return Object.freeze([Object.freeze(inspect), Object.freeze(handoff)])
}
