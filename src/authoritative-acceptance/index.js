// @ts-check

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionResult} ToolExecutionResult */

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/u
const VERDICT_STATUSES = new Set([
  'satisfied',
  'missing',
  'failed',
  'active',
  'uncertain',
  'infrastructure-blocked',
])

/** Locale-independent ordering shared with nils' default string sort. */
/** @type {(left: string, right: string) => number} */
const lexicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0

/**
 * Synchronous completion denial thrown through the patched GoalService seam.
 * It carries only the sanitized aggregate and reason codes; provider
 * capabilities, operation ids, tool arguments, and output never cross it.
 */
export class DshAcceptanceBlockedError extends Error {
  /** @param {string} aggregate @param {readonly string[]} [reasonCodes] */
  constructor(aggregate, reasonCodes = []) {
    super(`dsh-runtime-kit: authoritative acceptance blocked completion (${aggregate})`)
    this.name = 'DshAcceptanceBlockedError'
    this.code = 'DSH_ACCEPTANCE_BLOCKED'
    this.aggregate = aggregate
    this.reasonCodes = Object.freeze([...reasonCodes])
  }
}

/** @param {unknown} value */
function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/** @param {unknown} error */
function temporaryProviderError(error) {
  return error !== null && typeof error === 'object'
    && /** @type {{code?: unknown}} */ (error).code === 'DSH_FINISH_LINE_TEMPORARY'
}

/**
 * Canonical lossless-JSON encoder with lexical object keys. Tool callbacks are
 * trusted code, not wire identity; the public schema plus execution metadata
 * is the stable definition identity shared with nils.
 * @param {unknown} value
 * @param {Set<object>} [ancestors]
 * @returns {string}
 */
function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('dsh-runtime-kit: acceptance definition is not lossless JSON')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('dsh-runtime-kit: acceptance definition is cyclic')
    ancestors.add(value)
    try {
      const items = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('dsh-runtime-kit: acceptance definition contains a sparse array')
        }
        items.push(canonicalJson(value[index], ancestors))
      }
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  const record = plainRecord(value)
  if (record === undefined) {
    throw new TypeError('dsh-runtime-kit: acceptance definition is not plain JSON')
  }
  if (ancestors.has(record)) throw new TypeError('dsh-runtime-kit: acceptance definition is cyclic')
  ancestors.add(record)
  try {
    const entries = []
    for (const key of Object.keys(record).sort()) {
      const entry = record[key]
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
        || typeof entry === 'bigint') {
        throw new TypeError('dsh-runtime-kit: acceptance definition is not lossless JSON')
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`)
    }
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(record)
  }
}

/** @param {ToolDefinition} definition */
function definitionProjection(definition) {
  if (definition === null || typeof definition !== 'object'
    || typeof definition.name !== 'string' || !IDENTIFIER.test(definition.name)
    || typeof definition.description !== 'string'
    || plainRecord(definition.parameters) === undefined
    || plainRecord(definition.output) === undefined
    || plainRecord(definition.output.schema) === undefined) {
    throw new TypeError('dsh-runtime-kit: acceptance definition must be an exact DSH tool')
  }
  if (definition.timeoutMs !== undefined
    && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
    throw new TypeError('dsh-runtime-kit: acceptance tool timeout is invalid')
  }
  return {
    schema_version: 'dsh-runtime-kit.tool-definition.v1',
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output_schema: definition.output.schema,
    ...definition.timeoutMs === undefined ? {} : { timeout_ms: definition.timeoutMs },
    has_concurrency_classifier: typeof definition.isConcurrencySafe === 'function',
    has_final_content: typeof definition.finalizeContent === 'function',
  }
}

/**
 * Stable digest of the public, execution-relevant DSH ToolDefinition shape.
 * Exact in-process object identity is checked separately at every lifecycle
 * boundary, so a same-schema replacement is never accepted mid-execution.
 * @param {ToolDefinition} definition
 */
export function toolDefinitionDigest(definition) {
  const encoded = canonicalJson(definitionProjection(definition))
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`
}

/** @param {unknown} value @param {string} what */
function identifier(value, what) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`dsh-runtime-kit: acceptance ${what} is invalid`)
  }
  return value
}

/** @param {unknown} input */
function normalizeRegistration(input) {
  const value = plainRecord(input)
  if (value === undefined || !Array.isArray(value.requirements)
    || value.requirements.length < 1 || value.requirements.length > 128
    || !Array.isArray(value.invalidators) || value.invalidators.length > 128) {
    throw new TypeError('dsh-runtime-kit: acceptance registration is invalid')
  }
  const requirementNames = new Set()
  /** @type {Map<ToolDefinition, readonly any[]>} */
  const validatorBindings = new Map()
  /** @type {Map<string, ToolDefinition>} */
  const toolDefinitionsByName = new Map()
  /** @type {Map<ToolDefinition, string>} */
  const definitionDigests = new Map()
  const requirements = value.requirements.map(rawRequirement => {
    const requirement = plainRecord(rawRequirement)
    const name = identifier(requirement?.name, 'requirement name')
    if (requirementNames.has(name) || !Array.isArray(requirement?.validators)
      || requirement.validators.length < 1 || requirement.validators.length > 16) {
      throw new TypeError('dsh-runtime-kit: acceptance requirement is invalid')
    }
    requirementNames.add(name)
    const validatorIds = new Set()
    const validators = requirement.validators.map(rawValidator => {
      const validator = plainRecord(rawValidator)
      const id = identifier(validator?.id, 'validator id')
      const definition = /** @type {ToolDefinition} */ (validator?.definition)
      const execution = plainRecord(validator?.execution)
      if (validatorIds.has(id) || definition === undefined || execution === undefined) {
        throw new TypeError('dsh-runtime-kit: acceptance validator is invalid')
      }
      validatorIds.add(id)
      let normalizedExecution
      if (execution.kind === 'host-observed' && Object.keys(execution).length === 1) {
        normalizedExecution = Object.freeze({ kind: /** @type {const} */ ('host-observed') })
      } else if (execution.kind === 'contained-bash'
        && Object.keys(execution).sort().join('\0') === 'command\0intent\0kind'
        && definition.name === 'bash'
        && typeof execution.intent === 'string' && IDENTIFIER.test(execution.intent)
        && typeof execution.command === 'string' && execution.command.trim().length > 0
        && !execution.command.includes('\0')) {
        normalizedExecution = Object.freeze({
          kind: /** @type {const} */ ('contained-bash'),
          intent: execution.intent,
          command: execution.command,
        })
      } else {
        throw new TypeError('dsh-runtime-kit: acceptance validator execution is invalid')
      }
      const digest = toolDefinitionDigest(definition)
      definitionDigests.set(definition, digest)
      const visibleDefinition = toolDefinitionsByName.get(definition.name)
      if (visibleDefinition !== undefined && visibleDefinition !== definition) {
        throw new TypeError('dsh-runtime-kit: one visible tool name cannot bind different definitions')
      }
      toolDefinitionsByName.set(definition.name, definition)
      const binding = Object.freeze({ name, id, definition, digest, execution: normalizedExecution })
      const prior = validatorBindings.get(definition) ?? []
      if (normalizedExecution.kind === 'host-observed' || prior.some(entry => (
        entry.execution.kind === 'host-observed'
        || (entry.execution.intent === normalizedExecution.intent
          && entry.execution.command === normalizedExecution.command)
      ))) {
        if (prior.length > 0) {
          throw new TypeError('dsh-runtime-kit: acceptance validator binding is ambiguous')
        }
      }
      validatorBindings.set(definition, Object.freeze([...prior, binding]))
      return binding
    }).sort((left, right) => lexicalCompare(left.id, right.id))
    return Object.freeze({ name, validators: Object.freeze(validators) })
  }).sort((left, right) => lexicalCompare(left.name, right.name))

  const invalidatorDefinitions = new Set()
  const invalidators = value.invalidators.map(rawDefinition => {
    const definition = /** @type {ToolDefinition} */ (rawDefinition)
    if (invalidatorDefinitions.has(definition) || validatorBindings.has(definition)) {
      throw new TypeError('dsh-runtime-kit: acceptance invalidator is duplicated or conflicts with a validator')
    }
    const digest = toolDefinitionDigest(definition)
    definitionDigests.set(definition, digest)
    const visibleDefinition = toolDefinitionsByName.get(definition.name)
    if (visibleDefinition !== undefined && visibleDefinition !== definition) {
      throw new TypeError('dsh-runtime-kit: one visible tool name cannot bind different definitions')
    }
    toolDefinitionsByName.set(definition.name, definition)
    invalidatorDefinitions.add(definition)
    return Object.freeze({
      definition,
      name: definition.name,
      digest,
    })
  }).sort((left, right) => lexicalCompare(left.name, right.name))

  return Object.freeze({
    requirements: Object.freeze(requirements),
    invalidators: Object.freeze(invalidators),
    validatorBindings,
    invalidatorDefinitions,
    toolDefinitionsByName,
    definitionDigests,
  })
}

/** @param {ReturnType<typeof normalizeRegistration>} contract */
function wireRegistration(contract) {
  return {
    requirements: contract.requirements.map(requirement => ({
      name: requirement.name,
      validators: requirement.validators.map(validator => ({
        id: validator.id,
        toolName: validator.definition.name,
        definitionDigest: validator.digest,
        execution: validator.execution,
      })),
    })),
    invalidators: contract.invalidators.map(invalidator => ({
      toolName: invalidator.name,
      definitionDigest: invalidator.digest,
    })),
  }
}

const projectionStateSchema = z.object({
  active: z.array(z.object({
    callId: z.string(),
    kind: z.enum(['mutation', 'validator']),
    name: z.string(),
  })),
  last: z.nullable(z.object({
    kind: z.enum(['mutation', 'validator']),
    name: z.string(),
    status: z.enum(['succeeded', 'failed']),
  })),
}).strict()

const projectionViewSchema = z.object({
  schema_version: z.literal('dsh-runtime-kit.acceptance-projection.v1'),
  active_operations: z.number().int().nonnegative(),
  last_operation: z.nullable(z.object({
    kind: z.enum(['mutation', 'validator']),
    name: z.string(),
    status: z.enum(['succeeded', 'failed']),
  }).strict()),
}).strict()

/**
 * A sanitized, reconstructable projection over DSH's existing standard tool
 * events. It records no verdict, generation, capability, arguments, output,
 * or provider operation id and therefore cannot manufacture acceptance. No
 * custom session event is written, preserving old-runtime rollback reads.
 * @param {ReturnType<typeof normalizeRegistration>} contract
 */
export function createAcceptanceProjection(contract) {
  /** @type {Map<string, readonly any[]>} */
  const bindings = new Map()
  for (const requirement of contract.requirements) {
    for (const validator of requirement.validators) {
      const candidates = bindings.get(validator.definition.name) ?? []
      bindings.set(validator.definition.name, Object.freeze([...candidates, Object.freeze({
        kind: /** @type {const} */ ('validator'),
        name: requirement.name,
        execution: validator.execution,
      })]))
    }
  }
  for (const invalidator of contract.invalidators) {
    const candidates = bindings.get(invalidator.name) ?? []
    bindings.set(invalidator.name, Object.freeze([...candidates, Object.freeze({
      kind: /** @type {const} */ ('mutation'),
      name: invalidator.name,
    })]))
  }
  return Object.freeze({
    key: 'dshRuntimeAcceptance',
    stateSchema: projectionStateSchema,
    init: () => ({ active: [], last: null }),
    /** @param {{active: Array<{callId: string, kind: 'mutation'|'validator', name: string}>, last: null | {kind: 'mutation'|'validator', name: string, status: 'succeeded'|'failed'}}} state @param {any} event */
    apply(state, event) {
      if (event?.type === 'tool/call') {
        const candidates = bindings.get(event.data?.name)
        let binding = candidates?.length === 1 ? candidates[0] : undefined
        if (binding === undefined && candidates !== undefined && candidates.length > 1
          && typeof event.data?.arguments === 'string') {
          let argumentsRecord
          try { argumentsRecord = plainRecord(JSON.parse(event.data.arguments)) } catch {}
          if (typeof argumentsRecord?.command === 'string') {
            const matches = candidates.filter(candidate => (
              candidate.execution?.kind === 'contained-bash'
              && candidate.execution.command === argumentsRecord.command
            ))
            binding = matches.length === 1 ? matches[0] : undefined
          }
        }
        if (binding === undefined || typeof event.data?.callId !== 'string'
          || state.active.some(entry => entry.callId === event.data.callId)) return state
        const active = [...state.active, { callId: event.data.callId, ...binding }]
        if (active.length > 128) active.shift()
        return { active, last: state.last }
      }
      if (event?.type !== 'tool/result') return state
      const callId = event.data?.message?.source?.callId
      if (typeof callId !== 'string') return state
      const index = state.active.findIndex(entry => entry.callId === callId)
      if (index < 0) return state
      const selected = state.active[index]
      const active = [...state.active.slice(0, index), ...state.active.slice(index + 1)]
      return {
        active,
        last: {
          kind: selected.kind,
          name: selected.name,
          status: event.data?.error === undefined ? 'succeeded' : 'failed',
        },
      }
    },
    wire: {
      viewSchema: projectionViewSchema,
      /** @param {{active: Array<unknown>, last: any}} state */
      view: state => ({
        schema_version: 'dsh-runtime-kit.acceptance-projection.v1',
        active_operations: state.active.length,
        last_operation: state.last,
      }),
    },
    stateVersion: 1,
  })
}

/** @param {unknown} input */
function sanitizeVerdict(input) {
  const value = plainRecord(input)
  if (value === undefined
    || !['allow', 'block'].includes(/** @type {string} */ (value.action))
    || !VERDICT_STATUSES.has(/** @type {string} */ (value.aggregate))
    || !Number.isSafeInteger(value.generation) || /** @type {number} */ (value.generation) < 0
    || typeof value.contractDigest !== 'string' || !DIGEST.test(value.contractDigest)
    || !Array.isArray(value.reasonCodes)
    || !value.reasonCodes.every(code => typeof code === 'string' && VERDICT_STATUSES.has(code))
    || !Array.isArray(value.requirements)) {
    throw new Error('dsh-runtime-kit: acceptance verdict invalid')
  }
  const requirements = value.requirements.map(raw => {
    const entry = plainRecord(raw)
    const attemptGeneration = entry?.attemptGeneration
    if (entry === undefined || typeof entry.name !== 'string' || !IDENTIFIER.test(entry.name)
      || typeof entry.status !== 'string' || !VERDICT_STATUSES.has(entry.status)
      || (attemptGeneration !== undefined && attemptGeneration !== null
        && (typeof attemptGeneration !== 'number'
          || !Number.isSafeInteger(attemptGeneration) || attemptGeneration < 0))) {
      throw new Error('dsh-runtime-kit: acceptance verdict invalid')
    }
    return Object.freeze({
      name: entry.name,
      status: entry.status,
      ...attemptGeneration === undefined || attemptGeneration === null
        ? {}
        : { attemptGeneration },
    })
  })
  const names = requirements.map(entry => entry.name)
  const reasonCodes = /** @type {string[]} */ (value.reasonCodes)
  const rawReservation = value.completionReservation
  const completionReservation = rawReservation === undefined
    ? undefined
    : plainRecord(rawReservation)
  if (rawReservation !== undefined
    && (completionReservation === undefined
      || typeof completionReservation.operationId !== 'string'
      || !IDENTIFIER.test(completionReservation.operationId)
      || !['reserved', 'duplicate'].includes(
        /** @type {string} */ (completionReservation.status),
      ))) {
    throw new Error('dsh-runtime-kit: acceptance verdict invalid')
  }
  if (new Set(names).size !== names.length
    || names.join('\0') !== [...names].sort().join('\0')
    || new Set(reasonCodes).size !== reasonCodes.length
    || reasonCodes.join('\0') !== [...reasonCodes].sort().join('\0')
    || reasonCodes.includes('satisfied')
    || (value.action === 'allow') !== (value.aggregate === 'satisfied')
    || (value.action === 'allow'
      ? reasonCodes.length !== 0 || requirements.some(entry => entry.status !== 'satisfied')
      : reasonCodes.length === 0 || !reasonCodes.includes(/** @type {string} */ (value.aggregate)))) {
    throw new Error('dsh-runtime-kit: acceptance verdict invalid')
  }
  return Object.freeze({
    action: /** @type {'allow' | 'block'} */ (value.action),
    aggregate: /** @type {string} */ (value.aggregate),
    generation: /** @type {number} */ (value.generation),
    contractDigest: /** @type {string} */ (value.contractDigest),
    reasonCodes: Object.freeze([...reasonCodes]),
    requirements: Object.freeze(requirements),
    ...completionReservation === undefined
      ? {}
      : {
          completionReservation: Object.freeze({
            operationId: /** @type {string} */ (completionReservation.operationId),
            status: /** @type {'reserved' | 'duplicate'} */ (completionReservation.status),
          }),
        },
  })
}

/** @param {ToolExecutionResult} result @param {string} abortedCode */
function observedStatus(result, abortedCode) {
  const value = plainRecord(result.value)
  if (value?.aborted === true || result.error?.info?.code === abortedCode) return 'cancelled'
  if (value?.timedOut === true) return 'timed-out'
  if (typeof value?.signal === 'string') return 'signalled'
  return result.isError === false ? 'succeeded' : 'failed'
}

/**
 * Native DSH acceptance integration. Nils owns every durable policy decision;
 * this coordinator binds exact DSH objects and lifecycle facts, caches only a
 * detached verdict for the synchronous goal seam, and keeps a missing or
 * uncertain cache fail-closed.
 *
 * @param {Context} ctx
 * @param {{
 *   client: {
 *     registerAcceptance(request: any, signal?: AbortSignal): Promise<any>,
 *     admitAcceptance(request: any, signal?: AbortSignal): Promise<any>,
 *     observeAcceptance(request: any, signal?: AbortSignal): Promise<any>,
 *     acceptanceVerdict(request: any, signal?: AbortSignal): Promise<any>,
 *     abandonAcceptance?(request: any): void
 *   },
 *   authority: {
 *     withAuthority(agent: Agent, turnId: string, signal: AbortSignal, invoke: (authority: any) => Promise<any>): Promise<any>,
 *     releaseAfterAcceptance(agent: Agent): Promise<any>,
 *     sourceOperation(exec: ToolExecution): {operationId: string, intent: string, command: string} | undefined
 *   },
 *   createOperationId?: (kind: string, binding: any) => string,
 *   controlTimeoutMs?: number,
 *   workspaceReadiness?: {
 *     wait(agent: Agent): Promise<void>,
 *     ready(agent: Agent): boolean
 *   },
 *   createSteeringMessage?: (text: string) => any,
 *   abortedCode?: string,
 * }} options
 */
export function createAuthoritativeAcceptanceCoordinator(ctx, options) {
  const createOperationId = options.createOperationId
    ?? ((kind, binding) => {
      const bindingIdentity = createHash('sha256')
        .update(String(binding.id ?? binding.name ?? 'mutation'))
        .digest('hex')
      return `dsh-acceptance:${kind}:${bindingIdentity}:${randomUUID()}`
    })
  const workspaceReadiness = options.workspaceReadiness ?? Object.freeze({
    async wait(_agent) {},
    ready(_agent) { return true },
  })
  const createSteeringMessage = options.createSteeringMessage ?? (text => text)
  const abortedCode = options.abortedCode ?? 'ABORTED'
  const controlTimeoutMs = typeof options.controlTimeoutMs === 'number'
    && Number.isInteger(options.controlTimeoutMs)
    && options.controlTimeoutMs > 0
    ? Math.min(options.controlTimeoutMs, 10_000)
    : 2_000
  /** @type {ReturnType<typeof normalizeRegistration> | undefined} */
  let contract
  /** @type {WeakMap<Agent['session'], SessionState>} */
  let sessions = new WeakMap()
  /** @type {Set<SessionState>} */
  const liveStates = new Set()
  /** @type {Map<Readonly<ToolExecution>, OperationState>} */
  const operations = new Map()
  /** @type {Map<Readonly<ToolExecution>, string>} */
  const repositoryMutations = new Map()
  /** @type {Set<Promise<void>>} */
  const readinessWaits = new Set()
  const lifecycleAbort = new AbortController()
  let open = true

  /** @param {string} repositoryKey */
  function hasRepositoryMutation(repositoryKey) {
    for (const selected of repositoryMutations.values()) {
      if (selected === repositoryKey) return true
    }
    return false
  }

  /**
   * Bound every acceptance control RPC to caller, coordinator, and teardown
   * lifecycle authority. One deadline spans both idempotent transport
   * attempts, so a locally timed-out request cannot restart with a fresh
   * validation-length timeout while disposal is waiting.
   * @template T
   * @param {AbortSignal} callerSignal
   * @param {(signal: AbortSignal) => Promise<T>} invoke
   * @param {boolean} [includeLifecycle]
   * @returns {Promise<T>}
   */
  async function withControlSignal(callerSignal, invoke, includeLifecycle = true) {
    const controller = new AbortController()
    const signals = includeLifecycle
      ? [callerSignal, lifecycleAbort.signal]
      : [callerSignal]
    /** @type {Map<AbortSignal, () => void>} */
    const listeners = new Map()
    /** @param {AbortSignal} signal */
    const abortFrom = signal => controller.abort(
      signal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled'),
    )
    for (const signal of signals) {
      if (signal.aborted) {
        abortFrom(signal)
        break
      }
      const listener = () => abortFrom(signal)
      listeners.set(signal, listener)
      signal.addEventListener('abort', listener, { once: true })
    }
    const timer = setTimeout(() => controller.abort(
      new Error('dsh-runtime-kit: acceptance control deadline exceeded'),
    ), controlTimeoutMs)
    try {
      return await invoke(controller.signal)
    } finally {
      clearTimeout(timer)
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener)
      }
    }
  }

  /**
   * Join prior workspace disposal without letting that provider-owned cleanup
   * hide a live public operation from cancellation, quiescence, or resource
   * accounting.
   * @param {Agent} agent
   * @param {AbortSignal} [callerSignal]
   */
  async function awaitWorkspaceReady(agent, callerSignal) {
    const signals = callerSignal === undefined
      ? [lifecycleAbort.signal]
      : [callerSignal, lifecycleAbort.signal]
    /** @type {Promise<void>} */
    let tracked
    tracked = new Promise((resolve, reject) => {
      let settled = false
      /** @type {Map<AbortSignal, () => void>} */
      const listeners = new Map()
      const cleanup = () => {
        for (const [signal, listener] of listeners) {
          signal.removeEventListener('abort', listener)
        }
      }
      const succeed = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve(undefined)
      }
      /** @param {unknown} error */
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      for (const signal of signals) {
        if (signal.aborted) {
          fail(signal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled'))
          return
        }
        const listener = () => fail(
          signal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled'),
        )
        listeners.set(signal, listener)
        signal.addEventListener('abort', listener, { once: true })
      }
      Promise.resolve()
        .then(() => workspaceReadiness.wait(agent))
        .then(
          succeed,
          fail,
        )
    }).finally(() => { readinessWaits.delete(tracked) })
    readinessWaits.add(tracked)
    await tracked
    if (!open) throw new Error('dsh-runtime-kit: acceptance coordinator disposed')
  }

  /** @param {Agent} agent */
  function isWorkspaceReady(agent) {
    try {
      return workspaceReadiness.ready(agent)
    } catch {
      return false
    }
  }

  /**
   * Preserve nils' exact contained source on every lifecycle path. Natural
   * contained results carry no caller status so nils derives execution facts;
   * host denial, drift, and disposal can only degrade them to the one explicit
   * fail-closed terminal the provider accepts.
   * @param {OperationState} operation
   * @param {string | undefined} status
   */
  function operationObservation(operation, status) {
    if (operation.binding.kind === 'validator'
      && operation.binding.execution.kind === 'contained-bash') {
      return {
        kind: /** @type {const} */ ('contained-bash'),
        operationId: operation.sourceOperationId,
        ...status === undefined ? {} : { status: 'infrastructure-blocked' },
      }
    }
    if (status === undefined) {
      throw new Error('dsh-runtime-kit: host-observed acceptance status unavailable')
    }
    return { kind: /** @type {const} */ ('host-observed'), status }
  }

  /**
   * Retry one ambiguous provider transport failure with the exact semantic
   * request. Admission keeps its private attempt token inside the client;
   * register, observe, and verdict are provider-idempotent at their own keys.
   * Caller cancellation is never retried.
   * @template T
   * @param {AbortSignal} signal
   * @param {(signal: AbortSignal) => Promise<T>} invoke
   * @param {boolean} [includeLifecycle]
   * @returns {Promise<T>}
   */
  async function retryProvider(signal, invoke, includeLifecycle = true) {
    return withControlSignal(signal, async controlSignal => {
      let lastError
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (controlSignal.aborted) {
          throw controlSignal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled')
        }
        try {
          return await invoke(controlSignal)
        } catch (error) {
          lastError = error
          if (controlSignal.aborted) throw error
          if (temporaryProviderError(error)) throw error
        }
      }
      throw lastError
    }, includeLifecycle)
  }

  /** @param {Agent} agent */
  function assertLive(agent) {
    if (ctx.agents.get(agent.id) !== agent || agent.session?.header?.id !== agent.id
      || typeof agent.session.header.cwd !== 'string') {
      throw new Error('dsh-runtime-kit: acceptance agent identity invalid')
    }
  }

  /** @param {Agent} agent */
  async function awaitPublication(agent) {
    if (agent.session?.header?.id !== agent.id
      || typeof agent.session.header.cwd !== 'string') {
      throw new Error('dsh-runtime-kit: acceptance agent identity invalid')
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!open) throw new Error('dsh-runtime-kit: acceptance coordinator disposed')
      const published = ctx.agents.get(agent.id)
      if (published === agent) return
      if (published !== undefined) {
        throw new Error('dsh-runtime-kit: acceptance agent identity invalid')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('dsh-runtime-kit: acceptance agent publication unavailable')
  }

  /** @param {SessionState} state @param {unknown} error */
  function poison(state, error) {
    state.revision += 1
    state.poison = error instanceof Error ? error.message : 'acceptance provider unavailable'
    state.verdict = Object.freeze({
      action: /** @type {const} */ ('block'),
      aggregate: 'infrastructure-blocked',
      generation: state.verdict?.generation ?? 0,
      contractDigest: state.contractDigest ?? `sha256:${'0'.repeat(64)}`,
      reasonCodes: Object.freeze(['infrastructure-blocked']),
      requirements: state.verdict?.requirements ?? Object.freeze([]),
    })
  }

  /** @param {SessionState} state */
  function invalidate(state) {
    state.revision += 1
    state.verdict = Object.freeze({
      action: /** @type {const} */ ('block'),
      aggregate: 'active',
      generation: state.verdict?.generation ?? 0,
      contractDigest: state.contractDigest ?? `sha256:${'0'.repeat(64)}`,
      reasonCodes: Object.freeze(['active']),
      requirements: state.verdict?.requirements ?? Object.freeze([]),
    })
  }

  /** @param {SessionState} state @param {Promise<unknown>} promise */
  function track(state, promise) {
    const task = promise.catch(error => { poison(state, error) }).finally(() => {
      state.pending.delete(task)
    })
    state.pending.add(task)
    return task
  }

  /**
   * @param {SessionState} state
   * @param {Promise<unknown>} promise
   * @param {'succeeded' | 'cancelled' | undefined} successStatus
   * @param {boolean} [preserveRejection]
   */
  function trackCompletion(state, promise, successStatus, preserveRejection = false) {
    const task = promise.then(
      () => {
        if (successStatus !== undefined) state.completionSettlement = successStatus
      },
      error => {
        state.completionSettlement = 'failed'
        poison(state, error)
        if (preserveRejection) throw error
      },
    ).finally(() => {
      state.pending.delete(task)
      state.completionTasks.delete(task)
    })
    state.pending.add(task)
    state.completionTasks.add(task)
    return task
  }

  /**
   * @param {SessionState} state
   * @param {string} turnId
   * @param {AbortSignal} signal
   * @param {boolean} [reserveCompletion]
   */
  async function refresh(state, turnId, signal, reserveCompletion = false) {
    if (state.contractDigest === undefined) {
      throw new Error('dsh-runtime-kit: acceptance contract unavailable')
    }
    const revision = state.revision
    const sequence = ++state.refreshSequence
    const completionReservation = reserveCompletion
      ? state.completionReservationId
        ?? (state.completionReservationId = createOperationId('completion', {
          id: 'goal-completion',
        }))
      : undefined
    const response = await retryProvider(signal, controlSignal => options.authority.withAuthority(
      state.agent,
      turnId,
      controlSignal,
      async authority => {
        const result = await options.client.acceptanceVerdict({
          ...authority.identity,
          runnerCapability: authority.runnerCapability,
          contractDigest: state.contractDigest,
          ...completionReservation === undefined ? {} : { completionReservation },
        }, controlSignal)
        authority.acceptCorrelation(result.correlationId)
        return result
      },
    ))
    const selected = sanitizeVerdict(response)
    if (selected.contractDigest !== state.contractDigest) {
      throw new Error('dsh-runtime-kit: acceptance verdict contract changed')
    }
    const expectedRequirements = contract?.requirements.map(requirement => requirement.name) ?? []
    if (selected.requirements.map(requirement => requirement.name).join('\0')
      !== expectedRequirements.join('\0')) {
      throw new Error('dsh-runtime-kit: acceptance verdict requirements changed')
    }
    assertContractBindings(state.agent)
    if (reserveCompletion && selected.action === 'allow'
      && selected.completionReservation?.operationId !== completionReservation) {
      throw new Error('dsh-runtime-kit: acceptance completion reservation invalid')
    }
    const stale = !open || state.disposed || revision !== state.revision
      || sequence < state.appliedRefreshSequence
      || (state.verdict !== undefined && selected.generation < state.verdict.generation)
    if (stale) {
      if (selected.completionReservation !== undefined) {
        await trackCompletion(
          state,
          releaseCompletion(
            state,
            turnId,
            new AbortController().signal,
            selected.completionReservation.operationId,
            'cancelled',
          ),
          undefined,
          true,
        )
      }
      return state.verdict ?? selected
    }
    state.appliedRefreshSequence = sequence
    state.verdict = selected
    state.completionReservationActive = selected.completionReservation !== undefined
    if (reserveCompletion) {
      state.completionSettlement = selected.completionReservation === undefined
        ? 'idle'
        : 'reserved'
    }
    state.poison = undefined
    return selected
  }

  /**
   * @param {SessionState} state
   * @param {string} turnId
   * @param {AbortSignal} signal
   * @param {string} operationId
   * @param {string} status
   */
  async function releaseCompletion(state, turnId, signal, operationId, status) {
    await retryProvider(signal, controlSignal => options.authority.withAuthority(
      state.agent,
      turnId,
      controlSignal,
      async authority => {
        const response = await options.client.observeAcceptance({
          ...authority.identity,
          runnerCapability: authority.runnerCapability,
          operationId,
          observation: { kind: 'host-observed', status },
        }, controlSignal)
        authority.acceptCorrelation(response.correlationId)
        if (!['applied', 'stale', 'superseded', 'duplicate'].includes(response.status)
          || response.operationId !== operationId || response.observation !== status) {
          throw new Error('dsh-runtime-kit: acceptance completion release invalid')
        }
      },
    ), !(state.disposed || !open))
    if (state.completionReservationId === operationId) {
      state.completionReservationId = undefined
      state.completionReservationActive = false
    }
  }

  /**
   * @param {SessionState} state
   * @param {string} turnId
   * @param {AbortSignal} signal
   * @param {boolean} [reserveCompletion]
   */
  function runRefresh(state, turnId, signal, reserveCompletion = false) {
    const task = refresh(state, turnId, signal, reserveCompletion).finally(() => {
      state.refreshes.delete(task)
    })
    state.refreshes.add(task)
    return task
  }

  /** @param {SessionState} state @param {AbortSignal} signal */
  async function registerState(state, signal) {
    if (contract === undefined) return
    const wire = wireRegistration(contract)
    const response = await retryProvider(signal, controlSignal => options.authority.withAuthority(
      state.agent,
      'acceptance-register',
      controlSignal,
      async authority => {
        const result = await options.client.registerAcceptance({
          ...authority.identity,
          runnerCapability: authority.runnerCapability,
          ...wire,
        }, controlSignal)
        authority.acceptCorrelation(result.correlationId)
        return result
      },
    ))
    if (!['registered', 'duplicate'].includes(response.status)
      || typeof response.contractDigest !== 'string' || !DIGEST.test(response.contractDigest)
      || response.requirementCount !== contract.requirements.length) {
      throw new Error('dsh-runtime-kit: acceptance registration response invalid')
    }
    state.contractDigest = response.contractDigest
    if (state.disposed || !open) return
    await runRefresh(state, 'acceptance-register', signal)
  }

  /** @param {Agent} agent */
  function stateFor(agent) {
    assertLive(agent)
    let state = sessions.get(agent.session)
    if (state !== undefined) {
      if (state.disposed && state.agent !== agent) {
        sessions.delete(agent.session)
        state = undefined
      }
    }
    if (state !== undefined) {
      if (state.agent !== agent) throw new Error('dsh-runtime-kit: acceptance session rebound')
      if (state.disposed) throw new Error('dsh-runtime-kit: acceptance session disposed')
      return state
    }
    /** @type {SessionState} */
    const created = {
      agent,
      session: agent.session,
      repositoryKey: /** @type {string} */ (agent.session.header.cwd),
      contractDigest: undefined,
      verdict: undefined,
      poison: undefined,
      registration: undefined,
      registrationPending: false,
      pending: new Set(),
      completionTasks: new Set(),
      admissions: new Set(),
      refreshes: new Set(),
      revision: 0,
      refreshSequence: 0,
      appliedRefreshSequence: 0,
      activeOperations: 0,
      completionReservationId: undefined,
      completionReservationActive: false,
      completionSettlement: 'idle',
      disposed: false,
    }
    sessions.set(agent.session, created)
    liveStates.add(created)
    return created
  }

  /** @param {Agent} agent */
  function assertContractBindings(agent) {
    if (contract === undefined) return
    for (const [name, expected] of contract.toolDefinitionsByName) {
      const current = ctx.tools.get(name, agent)
      if (current !== expected
        || toolDefinitionDigest(current) !== contract.definitionDigests.get(expected)) {
        throw new Error('dsh-runtime-kit: acceptance tool definition changed')
      }
    }
  }

  /** @param {Agent} agent @param {AbortSignal} [signal] */
  async function ensureRegistered(agent, signal = new AbortController().signal) {
    if (contract === undefined) return undefined
    const state = stateFor(agent)
    if (state.registration === undefined) {
      state.registrationPending = true
      state.registration = registerState(state, signal)
        .catch(error => { poison(state, error) })
        .finally(() => { state.registrationPending = false })
    }
    await state.registration
    if (state.disposed || !open) {
      throw new Error('dsh-runtime-kit: acceptance session disposed')
    }
    if (state.poison !== undefined || state.contractDigest === undefined) {
      throw new Error('dsh-runtime-kit: acceptance provider unavailable')
    }
    return state
  }

  /** @param {Readonly<ToolExecution>} exec */
  function bindingFor(exec) {
    if (contract === undefined || exec.agent === undefined) return undefined
    const definition = ctx.tools.get(exec.name, exec.agent)
    if (definition === undefined) return undefined
    const registeredDefinition = contract.toolDefinitionsByName.get(exec.name)
    if (registeredDefinition !== undefined && registeredDefinition !== definition) {
      throw new Error('dsh-runtime-kit: acceptance tool definition changed')
    }
    const registeredDigest = contract.definitionDigests.get(definition)
    if (registeredDigest !== undefined && toolDefinitionDigest(definition) !== registeredDigest) {
      throw new Error('dsh-runtime-kit: acceptance tool definition changed')
    }
    const validators = contract.validatorBindings.get(definition)
    if (validators !== undefined) {
      const hostObserved = validators.find(entry => entry.execution.kind === 'host-observed')
      if (hostObserved !== undefined) {
        return { kind: /** @type {const} */ ('validator'), ...hostObserved }
      }
      const source = options.authority.sourceOperation(exec)
      if (source === undefined) return undefined
      const contained = validators.find(entry => entry.execution.kind === 'contained-bash'
        && entry.execution.intent === source.intent
        && entry.execution.command === source.command)
      if (contained === undefined) return undefined
      return {
        kind: /** @type {const} */ ('validator'),
        ...contained,
        sourceOperationId: source.operationId,
      }
    }
    const invalidator = contract.invalidators.find(entry => entry.definition === definition)
    return invalidator === undefined
      ? undefined
      : { kind: /** @type {const} */ ('mutation'), ...invalidator }
  }

  /** @param {OperationState} operation @param {any} observation */
  async function observe(operation, observation) {
    const state = operation.state
    if (state.disposed && observation.kind !== 'host-observed'
      && observation.status !== 'infrastructure-blocked') {
      throw new Error('dsh-runtime-kit: acceptance session disposed')
    }
    const signal = new AbortController().signal
    await retryProvider(signal, controlSignal => options.authority.withAuthority(
      state.agent,
      String(operation.call.turn),
      controlSignal,
      async authority => {
        const response = await options.client.observeAcceptance({
          ...authority.identity,
          runnerCapability: authority.runnerCapability,
          operationId: operation.operationId,
          observation,
        }, controlSignal)
        authority.acceptCorrelation(response.correlationId)
        if (!['applied', 'stale', 'superseded', 'duplicate'].includes(response.status)
          || response.operationId !== operation.operationId
          || (observation.status !== undefined
            && response.observation !== observation.status)) {
          throw new Error('dsh-runtime-kit: acceptance observation response invalid')
        }
      },
    ), !(state.disposed || !open))
    if (state.disposed || !open) return
    await runRefresh(state, String(operation.call.turn), signal)
  }

  /**
   * Invalidate detached caches bound to the same canonical repository before
   * a repository-changing tool can await provider admission. Any completion
   * reservation already held by this runtime for that repository is
   * terminalized first; reservations held by another process remain
   * provider-owned blockers.
   * @param {Readonly<ToolExecution>} exec
   * @param {{turn: number}} call
   */
  async function prepareRepositoryMutation(exec, call) {
    if (contract === undefined || repositoryMutations.has(exec)) return
    if (exec.agent === undefined || typeof exec.agent.session?.header?.cwd !== 'string') {
      throw new Error('dsh-runtime-kit: acceptance repository identity unavailable')
    }
    const repositoryKey = exec.agent.session.header.cwd
    repositoryMutations.set(exec, repositoryKey)
    const states = [...liveStates].filter(state => state.repositoryKey === repositoryKey)
    for (const state of states) invalidate(state)
    const refreshing = states.flatMap(state => [...state.refreshes])
    const settled = await Promise.allSettled(refreshing)
    if (settled.some(result => result.status === 'rejected')) {
      throw new Error('dsh-runtime-kit: acceptance refresh did not quiesce')
    }
    for (const state of states) {
      if (!state.completionReservationActive || state.completionReservationId === undefined) {
        if (state.completionTasks.size === 0) state.completionReservationId = undefined
        continue
      }
      state.completionSettlement = 'cancelling'
      await trackCompletion(
        state,
        releaseCompletion(
          state,
          String(call.turn),
          new AbortController().signal,
          state.completionReservationId,
          'cancelled',
        ),
        'cancelled',
        true,
      )
    }
    const ownerState = sessions.get(exec.agent.session)
    if (!open || ownerState?.disposed) {
      throw new Error('dsh-runtime-kit: acceptance coordinator disposed')
    }
    if (exec.signal.aborted) {
      throw exec.signal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled')
    }
  }

  const service = Object.freeze({
    /**
     * Install the one complete immutable contract. Registration is inert when
     * absent, preserving ungoverned DSH behavior. The returned disposer cannot
     * remove a replacement contract because replacement is rejected.
     * @param {unknown} input
     */
    register(input) {
      if (!open || contract !== undefined) {
        throw new Error('dsh-runtime-kit: acceptance contract already registered or disposed')
      }
      const selected = normalizeRegistration(input)
      contract = selected
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sessionProjections'], projectionCtx => {
          const projections = /** @type {{register(definition: any): () => void}} */ (
            /** @type {any} */ (projectionCtx).sessionProjections
          )
          projections.register(createAcceptanceProjection(selected))
        })
      }
      for (const agent of ctx.agents.list()) {
        const ready = isWorkspaceReady(agent)
        const registration = ready
          ? ensureRegistered(agent)
          : awaitWorkspaceReady(agent).then(() => ensureRegistered(agent))
        void registration
          .catch(error => {
            const state = sessions.get(agent.session)
            if (state !== undefined && open) poison(state, error)
          })
      }
      let registrationDisposed = false
      return () => {
        if (registrationDisposed) return
        registrationDisposed = true
        // Registration is process-lifetime immutable. A provider fiber may be
        // torn down after the last live Agent and before that session resumes;
        // withdrawing the contract there would silently turn governed DSH into
        // an ungoverned deployment. Tool/service withdrawal is instead caught
        // by binding authentication, while coordinator disposal closes the
        // entire runtime boundary.
      }
    },

    /** @param {Agent} agent */
    verdict(agent) {
      if (contract === undefined) return undefined
      assertLive(agent)
      if (!isWorkspaceReady(agent)) {
        throw new Error('dsh-runtime-kit: acceptance workspace disposal pending')
      }
      const state = sessions.get(agent.session)
      if (state === undefined) {
        throw new Error('dsh-runtime-kit: acceptance session unavailable')
      }
      if (state.verdict === undefined) {
        throw new Error('dsh-runtime-kit: acceptance verdict unavailable')
      }
      try {
        assertContractBindings(agent)
      } catch (error) {
        if (state !== undefined) poison(state, error)
      }
      return state.verdict
    },

    /**
     * Return only the lifecycle result needed to authenticate canary drain.
     * Capability, operation, generation, and provider diagnostics remain
     * private to the coordinator and nils sidecar.
     * @param {Agent} agent
     */
    completionSettlement(agent) {
      if (contract === undefined) return Object.freeze({ status: 'not-governed' })
      assertLive(agent)
      const state = sessions.get(agent.session)
      if (state === undefined) {
        throw new Error('dsh-runtime-kit: acceptance session unavailable')
      }
      return Object.freeze({ status: state.completionSettlement })
    },

    /** @param {Agent} agent @param {unknown} _ref */
    assertGoalCompletion(agent, _ref) {
      if (contract === undefined) return
      assertLive(agent)
      const state = sessions.get(agent.session)
      try {
        assertContractBindings(agent)
      } catch (error) {
        if (state !== undefined) poison(state, error)
      }
      const selected = state?.verdict
      if (!isWorkspaceReady(agent)
        || state === undefined || state.disposed || state.poison !== undefined
        || state.admissions.size > 0 || state.activeOperations > 0
        || state.pending.size > 0 || hasRepositoryMutation(state.repositoryKey)
        || selected?.action !== 'allow'
        || selected.completionReservation === undefined
        || !state.completionReservationActive) {
        throw new DshAcceptanceBlockedError(
          selected?.aggregate ?? 'infrastructure-blocked',
          selected?.reasonCodes ?? ['infrastructure-blocked'],
        )
      }
      const operationId = selected.completionReservation.operationId
      // Claim the reservation synchronously with GoalService's pre-mutation
      // assertion. Repository preparation may now rely on the provider-held
      // reservation for contention, but it can no longer cancel this runtime's
      // already-consumed completion operation.
      state.completionReservationActive = false
      state.completionSettlement = 'pending'
      invalidate(state)
      trackCompletion(state, (async () => {
        await releaseCompletion(
          state,
          'goal-completion',
          new AbortController().signal,
          operationId,
          'succeeded',
        )
        await options.authority.releaseAfterAcceptance(agent)
      })(), 'succeeded')
    },
  })
  ctx.provide('dshAcceptance', service)

  const coordinator = Object.freeze({
    service,

    /** @param {Agent} _agent */
    governs(_agent) { return contract !== undefined },

    /** @param {{agent: Agent, source: unknown}} payload */
    async sessionStarted(payload) {
      if (contract === undefined) return
      if (!open) throw new Error('dsh-runtime-kit: acceptance coordinator disposed')
      await awaitPublication(payload.agent)
      if (!isWorkspaceReady(payload.agent)) await awaitWorkspaceReady(payload.agent)
      await ensureRegistered(payload.agent)
    },

    /** @param {Readonly<ToolExecution>} exec @param {{turn: number}} call */
    async repositoryMutationStarting(exec, call) {
      if (!open || contract === undefined) return
      if (exec.agent === undefined) {
        throw new Error('dsh-runtime-kit: acceptance agent unavailable')
      }
      if (!isWorkspaceReady(exec.agent)) await awaitWorkspaceReady(exec.agent, exec.signal)
      assertLive(exec.agent)
      await prepareRepositoryMutation(exec, call)
    },

    /**
     * Admit only an exact visible registered ToolDefinition. Mutation
     * admission replaces the legacy edit generation advance; validator
     * admission composes with a contained finish-line reservation when one was
     * declared.
     * @param {ToolExecution} exec
     * @param {{sessionId: string, cwd: string, turn: number, step?: number, callId: string, rootCallId: string, name: string}} call
     */
    async admit(exec, call) {
      if (!open || contract === undefined) return { kind: /** @type {const} */ ('none') }
      const binding = bindingFor(exec)
      if (binding === undefined) return { kind: /** @type {const} */ ('none') }
      if (exec.agent === undefined || exec.agent.id !== call.sessionId
        || exec.agent.session.header.cwd !== call.cwd || exec.callId !== call.callId
        || exec.rootCallId !== call.rootCallId || exec.name !== call.name) {
        throw new Error('dsh-runtime-kit: acceptance execution correlation invalid')
      }
      const agent = exec.agent
      if (!isWorkspaceReady(agent)) await awaitWorkspaceReady(agent, exec.signal)
      const state = await ensureRegistered(agent, exec.signal)
      if (state === undefined || state.contractDigest === undefined) {
        throw new Error('dsh-runtime-kit: acceptance contract unavailable')
      }
      const contractDigest = state.contractDigest
      if (binding.kind === 'mutation') {
        await prepareRepositoryMutation(exec, call)
      } else if (state.completionReservationActive
        && state.completionReservationId !== undefined) {
        state.completionSettlement = 'cancelling'
        await trackCompletion(
          state,
          releaseCompletion(
            state,
            String(call.turn),
            exec.signal,
            state.completionReservationId,
            'cancelled',
          ),
          'cancelled',
          true,
        )
        if (!open || state.disposed) {
          throw new Error('dsh-runtime-kit: acceptance coordinator disposed')
        }
        if (exec.signal.aborted) {
          throw exec.signal.reason ?? new Error('dsh-runtime-kit: acceptance request cancelled')
        }
      }
      invalidate(state)
      const operationId = createOperationId(binding.kind, binding)
      identifier(operationId, 'operation id')
      const sourceOperationId = binding.kind === 'validator'
        && binding.execution.kind === 'contained-bash'
        ? binding.sourceOperationId
        : undefined
      const operation = binding.kind === 'mutation'
        ? {
            kind: /** @type {const} */ ('mutation'),
            toolName: binding.name,
            definitionDigest: binding.digest,
          }
        : {
            kind: /** @type {const} */ ('validator'),
            requirement: binding.name,
            validatorId: binding.id,
            toolName: binding.definition.name,
            definitionDigest: binding.digest,
            ...sourceOperationId === undefined ? {} : { sourceOperationId },
          }
      const admission = (async () => {
        let response
        try {
          response = await retryProvider(exec.signal, controlSignal => options.authority.withAuthority(
            agent,
            String(call.turn),
            controlSignal,
            async authority => {
              const result = await options.client.admitAcceptance({
                ...authority.identity,
                runnerCapability: authority.runnerCapability,
                contractDigest,
                operationId,
                operation,
              }, controlSignal)
              authority.acceptCorrelation(result.correlationId)
              return result
            },
          ))
          if (!['admitted', 'duplicate'].includes(response.status)
            || response.operationId !== operationId
            || response.operationKind !== binding.kind
            || response.contractDigest !== contractDigest
            || !Number.isSafeInteger(response.generation) || response.generation < 0) {
            throw new Error('dsh-runtime-kit: acceptance admission response invalid')
          }
        } catch (error) {
          options.client.abandonAcceptance?.({
            product: 'dsh',
            sessionId: agent.id,
            turnId: String(call.turn),
            cwd: call.cwd,
            operationId,
          })
          if (!exec.signal.aborted && !temporaryProviderError(error)) {
            poison(state, error)
          }
          throw error
        }
        /** @type {OperationState} */
        const record = { exec, state, binding, operationId, sourceOperationId, call }
        if (!open || state.disposed) {
          await observe(record, operationObservation(record, 'infrastructure-blocked'))
          throw new Error('dsh-runtime-kit: acceptance session disposed')
        }
        state.verdict = Object.freeze({
          action: /** @type {const} */ ('block'),
          aggregate: 'active',
          generation: Math.max(state.verdict?.generation ?? 0, response.generation),
          contractDigest,
          reasonCodes: Object.freeze(['active']),
          requirements: state.verdict?.requirements ?? Object.freeze([]),
        })
        operations.set(exec, record)
        state.activeOperations += 1
        return Object.freeze({
          kind: binding.kind,
          replacesLegacyEdit: binding.kind === 'mutation',
          ...sourceOperationId === undefined ? {} : { sourceOperationId },
        })
      })()
      state.admissions.add(admission)
      try {
        return await admission
      } catch (error) {
        repositoryMutations.delete(exec)
        throw error
      } finally {
        state.admissions.delete(admission)
      }
    },

    /** @param {Readonly<ToolExecution>} exec @param {ToolExecutionResult} result */
    result(exec, result) {
      repositoryMutations.delete(exec)
      const operation = operations.get(exec)
      if (operation === undefined) return
      operations.delete(exec)
      operation.state.activeOperations = Math.max(0, operation.state.activeOperations - 1)
      let bindingChanged = false
      try { assertContractBindings(operation.state.agent) } catch { bindingChanged = true }
      const observation = bindingChanged || operation.state.disposed || !open
        ? operationObservation(operation, 'infrastructure-blocked')
        : operation.binding.kind === 'validator'
          && operation.binding.execution.kind === 'contained-bash'
          ? operationObservation(operation, undefined)
          : operationObservation(operation, observedStatus(result, abortedCode))
      track(operation.state, observe(operation, observation))
    },

    /** @param {Readonly<ToolExecution>} exec @param {string} [status] */
    reject(exec, status = 'cancelled') {
      repositoryMutations.delete(exec)
      const operation = operations.get(exec)
      if (operation === undefined) return
      operations.delete(exec)
      operation.state.activeOperations = Math.max(0, operation.state.activeOperations - 1)
      track(operation.state, observe(operation, operationObservation(operation, status)))
    },

    /** @param {Agent} agent */
    async settle(agent) {
      if (contract === undefined) return
      const state = sessions.get(agent.session)
      if (state === undefined) return
      for (;;) {
        const pending = [
          ...state.pending,
          ...state.admissions,
          ...state.refreshes,
          ...state.registrationPending && state.registration !== undefined
            ? [state.registration]
            : [],
        ]
        if (pending.length === 0) return
        await Promise.allSettled(pending)
      }
    },

    /** @param {{agent: Agent, turn: number, signal: AbortSignal}} payload */
    async turnStopping(payload) {
      if (contract === undefined) return true
      if (!open) return false
      let state
      try {
        if (!isWorkspaceReady(payload.agent)) {
          await awaitWorkspaceReady(payload.agent, payload.signal)
        }
        state = await ensureRegistered(payload.agent, payload.signal)
      } catch (error) {
        const existing = sessions.get(payload.agent.session)
        if (existing !== undefined && !payload.signal.aborted && open) poison(existing, error)
        if (!payload.signal.aborted) {
          payload.agent.steer(createSteeringMessage(
            'Authoritative acceptance infrastructure is unavailable. Restore it and retry.',
          ))
        }
        return false
      }
      if (state === undefined) return true
      await coordinator.settle(payload.agent)
      if (hasRepositoryMutation(state.repositoryKey)) {
        if (!payload.signal.aborted) {
          payload.agent.steer(createSteeringMessage(
            'Authoritative acceptance blocked completion: active. Wait for repository mutations to terminalize and retry.',
          ))
        }
        return false
      }
      if (state.verdict?.action === 'allow'
        && state.verdict.completionReservation !== undefined
        && state.completionReservationActive) return true
      let selected
      try {
        selected = await runRefresh(state, String(payload.turn), payload.signal, true)
      } catch (error) {
        poison(state, error)
        selected = state.verdict
      }
      if (selected?.action === 'allow'
        && selected.completionReservation !== undefined
        && state.completionReservationActive) return true
      if (!payload.signal.aborted) {
        const details = selected?.reasonCodes.join(', ') || 'infrastructure-blocked'
        payload.agent.steer(createSteeringMessage(
          `Authoritative acceptance blocked completion: ${details}. Run the exact required validators and retry.`,
        ))
      }
      return false
    },

    /**
     * Terminalize a reserved stop that a later lifecycle policy boundary did
     * not accept. The shared runner capability remains live for the retrying
     * session; only successful GoalService consumption releases it.
     * @param {Agent} agent
     * @param {string} turnId
     */
    async cancelCompletion(agent, turnId) {
      if (contract === undefined) return
      assertLive(agent)
      const state = sessions.get(agent.session)
      if (state === undefined || state.disposed
        || !state.completionReservationActive
        || state.completionReservationId === undefined) return
      const operationId = state.completionReservationId
      invalidate(state)
      state.completionSettlement = 'cancelling'
      await trackCompletion(
        state,
        releaseCompletion(
          state,
          turnId,
          new AbortController().signal,
          operationId,
          'cancelled',
        ),
        'cancelled',
        true,
      )
    },

    /** @param {Agent} agent */
    async agentDisposed(agent) {
      const state = sessions.get(agent.session)
      if (state === undefined) return
      state.disposed = true
      invalidate(state)
      for (const [exec, operation] of operations) {
        if (operation.state !== state) continue
        operations.delete(exec)
        repositoryMutations.delete(exec)
        state.activeOperations = Math.max(0, state.activeOperations - 1)
        track(state, observe(
          operation,
          operationObservation(operation, 'infrastructure-blocked'),
        ))
      }
      await coordinator.settle(agent)
      liveStates.delete(state)
    },

    async dispose() {
      if (!open) return
      open = false
      lifecycleAbort.abort(new Error('dsh-runtime-kit: acceptance coordinator disposed'))
      for (const state of liveStates) {
        state.disposed = true
        invalidate(state)
      }
      for (const [exec, operation] of operations) {
        operations.delete(exec)
        repositoryMutations.delete(exec)
        operation.state.activeOperations = Math.max(0, operation.state.activeOperations - 1)
        track(operation.state, observe(
          operation,
          operationObservation(operation, 'infrastructure-blocked'),
        ))
      }
      await Promise.allSettled([...liveStates].flatMap(state => [
        ...state.pending,
        ...state.admissions,
        ...state.refreshes,
        ...state.registrationPending && state.registration !== undefined
          ? [state.registration]
          : [],
      ]))
      await Promise.allSettled([...readinessWaits])
      repositoryMutations.clear()
      liveStates.clear()
      sessions = new WeakMap()
    },

    get activeOperations() {
      let untrackedRepositoryMutations = 0
      for (const exec of repositoryMutations.keys()) {
        if (!operations.has(exec)) untrackedRepositoryMutations += 1
      }
      let sessionControlOperations = 0
      for (const state of liveStates) {
        sessionControlOperations += state.completionTasks.size
        if (state.registrationPending) sessionControlOperations += 1
      }
      return operations.size + untrackedRepositoryMutations + readinessWaits.size
        + sessionControlOperations
    },
  })

  ctx.effect(() => () => coordinator.dispose(), 'dsh-runtime-kit authoritative acceptance')
  return coordinator
}

/**
 * @typedef SessionState
 * @property {Agent} agent
 * @property {Agent['session']} session
 * @property {string} repositoryKey
 * @property {string | undefined} contractDigest
 * @property {ReturnType<typeof sanitizeVerdict> | undefined} verdict
 * @property {string | undefined} poison
 * @property {Promise<void> | undefined} registration
 * @property {boolean} registrationPending
 * @property {Set<Promise<unknown>>} pending
 * @property {Set<Promise<unknown>>} completionTasks
 * @property {Set<Promise<unknown>>} admissions
 * @property {Set<Promise<unknown>>} refreshes
 * @property {number} revision
 * @property {number} refreshSequence
 * @property {number} appliedRefreshSequence
 * @property {number} activeOperations
 * @property {string | undefined} completionReservationId
 * @property {boolean} completionReservationActive
 * @property {'idle' | 'reserved' | 'pending' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'} completionSettlement
 * @property {boolean} disposed
 */

/**
 * @typedef OperationState
 * @property {Readonly<ToolExecution>} exec
 * @property {SessionState} state
 * @property {any} binding
 * @property {string} operationId
 * @property {string | undefined} sourceOperationId
 * @property {{sessionId: string, cwd: string, turn: number, step?: number, callId: string, rootCallId: string, name: string}} call
 */
