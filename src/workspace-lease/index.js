// @ts-check

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-agent').SessionStartSource} SessionStartSource */
/** @typedef {import('@deepseek-ai/dsh-tools').PostToolDecision} PostToolDecision */
/** @typedef {import('@deepseek-ai/dsh-tools').PreToolDecision} PreToolDecision */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDispatchExecution} ToolDispatchExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionResult} ToolExecutionResult */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */

/**
 * Protocol version stamped on every trusted provider request.
 *
 * v1 bound one immutable session cwd, so one dirty checkout denied every later
 * tool in that session. v2 keeps the session anchor as context only and gives
 * a live lineage an authority *set*: zero or more lazily acquired repository
 * bindings, each with independent identity, generation, fencing, renewal,
 * failure, and release state.
 */
export const WORKSPACE_LEASE_PROTOCOL_VERSION = 2

/** @typedef {'owned' | 'foreign-active' | 'stale-clean' | 'dirty' | 'uncertain' | 'unavailable' | 'unmanaged'} WorkspaceLeaseState */
/** @typedef {'agent-disposed' | 'session-rebound' | 'provider-disposed'} WorkspaceLeaseReleaseReason */
/** @typedef {'succeeded' | 'failed' | 'cancelled'} WorkspaceLeaseOperationOutcome */

/**
 * Opaque, non-bearer reference to one live session's authority set. Its
 * provenance is retained only in a private WeakMap and is rechecked against
 * the exact live Agent on every use.
 * @typedef {Readonly<Record<never, never>>} WorkspaceRef
 */

/**
 * Exact canonical repository target authenticated by the provider. The runtime
 * never constructs one from a model-supplied path: it only echoes back what
 * the provider returned for this exact operation.
 * @typedef WorkspaceLeaseTarget
 * @property {string} workspaceKey
 * @property {string} root
 */

/**
 * @typedef WorkspaceLeaseBindingFacts
 * @property {typeof WORKSPACE_LEASE_PROTOCOL_VERSION} version
 * @property {string} requestId
 * @property {Agent['id']} sessionId
 * @property {Agent['id']} [parentSessionId]
 */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   anchorCwd?: string,
 *   callId: ToolExecution['callId'],
 *   rootCallId: ToolExecution['rootCallId'],
 *   toolName: string,
 *   arguments: unknown,
 *   nested: boolean,
 * }} WorkspaceLeaseResolveRequest
 */

/**
 * @typedef {{kind: 'not-required'}
 *   | {kind: 'targets', targets: readonly WorkspaceLeaseTarget[]}} WorkspaceLeaseResolveResult
 */

/**
 * A bind selects authority either from one exact resolved target or from the
 * session anchor. The anchor form is an optional eager optimization only.
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   target?: WorkspaceLeaseTarget,
 *   cwd?: string,
 *   source: SessionStartSource,
 * }} WorkspaceLeaseBindRequest
 */

/**
 * @typedef WorkspaceLeaseBound
 * @property {'bound'} kind
 * @property {string} bindingId
 * @property {string} workspaceId
 * @property {string} generation
 * @property {'owned' | 'unmanaged'} state
 * @property {WorkspaceLeaseTarget} target
 * @property {number} [renewAfterMs]
 */

/**
 * @typedef WorkspaceLeaseDenied
 * @property {'denied'} kind
 * @property {Exclude<WorkspaceLeaseState, 'owned' | 'unmanaged'>} state
 * @property {string} code
 * @property {string} reason
 */

/**
 * @typedef {WorkspaceLeaseBound
 *   | {kind: 'not-required'}
 *   | WorkspaceLeaseDenied} WorkspaceLeaseBindResult
 */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   bindingId: string,
 *   workspaceId: string,
 *   generation: string,
 *   bindingState: 'owned' | 'unmanaged',
 *   target: WorkspaceLeaseTarget,
 *   callId: ToolExecution['callId'],
 *   rootCallId: ToolExecution['rootCallId'],
 *   toolName: string,
 *   arguments: unknown,
 *   nested: boolean,
 * }} WorkspaceLeaseBeginRequest
 */

/**
 * @typedef {{kind: 'not-required'}
 *   | {kind: 'granted', operationId: string, fence: string}
 *   | WorkspaceLeaseDenied} WorkspaceLeaseBeginResult
 */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   bindingId: string,
 *   workspaceId: string,
 *   generation: string,
 *   operationId: string,
 *   fence: string,
 *   callId: ToolExecution['callId'],
 *   rootCallId: ToolExecution['rootCallId'],
 *   toolName: string,
 *   outcome: WorkspaceLeaseOperationOutcome,
 *   errorCode?: string,
 * }} WorkspaceLeaseCompleteRequest
 */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   bindingId: string,
 *   workspaceId: string,
 *   generation: string,
 * }} WorkspaceLeaseRenewRequest
 */

/**
 * @typedef {{kind: 'renewed', renewAfterMs?: number}
 *   | {kind: 'lost', state: Exclude<WorkspaceLeaseState, 'owned' | 'unmanaged'>, code: string, reason: string}}
 *   WorkspaceLeaseRenewResult
 */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   bindingId: string,
 *   workspaceId: string,
 *   generation: string,
 *   reason: WorkspaceLeaseReleaseReason,
 * }} WorkspaceLeaseReleaseRequest
 */

/**
 * Same-process trusted provider. It owns canonical Git/worktree identity,
 * operation classification, durable cross-process leases, fencing,
 * reconciliation, and stable reason codes. The runtime-owned plugin supplies
 * only host-authenticated facts.
 * @typedef WorkspaceLeaseProvider
 * @property {typeof WORKSPACE_LEASE_PROTOCOL_VERSION} protocolVersion
 * @property {(request: WorkspaceLeaseResolveRequest, signal: AbortSignal) => Promise<WorkspaceLeaseResolveResult>} resolve
 * @property {(request: WorkspaceLeaseBindRequest, signal: AbortSignal) => Promise<WorkspaceLeaseBindResult>} bind
 * @property {(request: WorkspaceLeaseBeginRequest, signal: AbortSignal) => Promise<WorkspaceLeaseBeginResult>} begin
 * @property {(request: WorkspaceLeaseCompleteRequest, signal: AbortSignal) => Promise<void>} complete
 * @property {(request: WorkspaceLeaseRenewRequest, signal: AbortSignal) => Promise<WorkspaceLeaseRenewResult>} renew
 * @property {(request: WorkspaceLeaseReleaseRequest, signal: AbortSignal) => Promise<void>} release
 */

/**
 * @typedef ProviderSlot
 * @property {WorkspaceLeaseProvider} provider
 * @property {Set<BoundWorkspace>} bindings
 * @property {boolean} stopping
 */

/**
 * One live DSH lineage owns one authority set. A child created by this exact
 * runtime shares its live ancestor's set so a managed reviewer never
 * impersonates a second external owner on the same worktree. An independent
 * top-level session always reaches the provider and contends normally.
 * @typedef AgentSlot
 * @property {Agent} agent
 * @property {Agent['session']} session
 * @property {number} epoch
 * @property {SessionStartSource} source
 * @property {boolean} disposed
 * @property {Map<string, BoundWorkspace>} bindings
 * @property {Map<string, Promise<BoundWorkspace | undefined>>} acquisitions
 * @property {AbortController} lifecycle
 * @property {Promise<void> | undefined} draining
 * @property {Promise<AnchorClassification> | undefined} anchor
 * @property {AbortController | undefined} anchorController
 * @property {string | undefined} anchorTarget
 * @property {WorkspaceRef | undefined} ref
 */

/**
 * The anchor is context, never a permission boundary. Its classification is
 * projected for diagnostics and never gates an unrelated operation.
 * @typedef AnchorClassification
 * @property {'owned' | 'unmanaged'} state
 */

/**
 * @typedef BoundWorkspace
 * @property {AgentSlot} owner
 * @property {AgentSlot} acquirer
 * @property {Agent['session']} session
 * @property {ProviderSlot} provider
 * @property {string} workspaceKey
 * @property {string} bindingId
 * @property {string} workspaceId
 * @property {string} generation
 * @property {WorkspaceLeaseTarget} target
 * @property {'owned' | 'unmanaged'} initialState
 * @property {AbortController} lifecycle
 * @property {Set<Promise<void>>} admissions
 * @property {Set<LeaseOperation>} operations
 * @property {number | undefined} renewAfterMs
 * @property {ReturnType<typeof setTimeout> | undefined} renewTimer
 * @property {AbortController | undefined} renewController
 * @property {Promise<void> | undefined} renewing
 * @property {WorkspaceLeaseError | undefined} failure
 * @property {boolean} released
 * @property {Promise<void> | undefined} releaseTask
 */

/**
 * @typedef LeaseOperation
 * @property {BoundWorkspace} binding
 * @property {ExecutionIdentity} identity
 * @property {string} operationId
 * @property {string} fence
 * @property {AbortController} authority
 * @property {AbortController} completion
 * @property {Promise<void>} settled
 * @property {() => void} settle
 * @property {boolean} completing
 */

/**
 * Exact DSH execution identity classified by the provider. The final native
 * guard consumes this marker after every extensible pre-execute middleware and
 * approval decision, immediately before the tool body can be dispatched.
 * @typedef ExecutionIdentity
 * @property {ToolExecution['token']} token
 * @property {ToolExecution['callId']} callId
 * @property {ToolExecution['rootCallId']} rootCallId
 * @property {string} toolName
 * @property {unknown} arguments
 * @property {Agent} agent
 * @property {Agent['session']} session
 * @property {ToolExecution['parent']} parent
 * @property {AbortSignal} signal
 */

/**
 * An admitted execution carries the exact operations acquired for it. An
 * unscoped native host operation carries an empty operation list: the runtime
 * claims no repository fence it cannot enforce.
 * @typedef {ExecutionIdentity & {
 *   slot: AgentSlot,
 *   epoch: number,
 *   operations: readonly LeaseOperation[],
 * }} ExecutionAuthorization
 */

/**
 * @typedef WorkspaceRefMeta
 * @property {Agent} agent
 * @property {AgentSlot} slot
 */

/**
 * @typedef FusedSignal
 * @property {AbortSignal} signal
 * @property {() => void} dispose
 */

export const WORKSPACE_LEASE_UNAVAILABLE = 'WORKSPACE_LEASE_UNAVAILABLE'
export const WORKSPACE_LEASE_UNBOUND = 'WORKSPACE_LEASE_UNBOUND'
export const WORKSPACE_LEASE_RELEASE_FAILED = 'WORKSPACE_LEASE_RELEASE_FAILED'
export const WORKSPACE_REF_INVALID = 'WORKSPACE_REF_INVALID'

/** Conservative bound on the repository targets one execution may claim. */
export const WORKSPACE_LEASE_MAX_TARGETS = 16
/**
 * A canonical repository root is a filesystem path, so it is bounded by the
 * path limit rather than by the 512-byte bound the generic provider-text
 * helper applies to opaque identifiers. Both the transport and the service
 * must agree on it: a root the transport accepts and the service then rejects
 * would surface an authenticated target as an opaque provider fault.
 */
export const WORKSPACE_LEASE_MAX_TARGET_PATH_BYTES = 4_096

/** Stable, typed workspace authority failure preserved by the DSH tool pipeline. */
export class WorkspaceLeaseError extends HarnessError {
  /**
   * @param {string} message
   * @param {string} code
   * @param {WorkspaceLeaseState} state
   * @param {ErrorOptions} [options]
   */
  constructor(message, code, state, options) {
    super(message, code, options)
    this.state = state
  }
}

/** A copied, stale, or wrong-Agent WorkspaceRef. */
export class WorkspaceLeaseInvalidRefError extends WorkspaceLeaseError {
  constructor() {
    super(
      'workspace reference is not valid for this live agent incarnation',
      WORKSPACE_REF_INVALID,
      'unavailable',
    )
  }
}

const providerCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/
const deniedStates = new Set([
  'foreign-active',
  'stale-clean',
  'dirty',
  'uncertain',
  'unavailable',
])
const printableProviderText = /^[^\u0000-\u001f\u007f]+$/u
const changedAuthorizationReason =
  'dsh-runtime-kit: workspace lease authorization changed before tool dispatch'

/** @param {WorkspaceLeaseDenied} result */
function providerError(result) {
  if (!deniedStates.has(result.state)
    || typeof result.reason !== 'string'
    || !printableProviderText.test(result.reason)
    || Buffer.byteLength(result.reason, 'utf8') > 1024) {
    return unavailable('workspace lease provider returned an invalid denial')
  }
  const code = providerCodePattern.test(result.code)
    ? result.code
    : WORKSPACE_LEASE_UNAVAILABLE
  return new WorkspaceLeaseError(result.reason, code, result.state)
}

/** @param {string} message @param {unknown} [cause] */
function unavailable(message, cause) {
  return new WorkspaceLeaseError(
    message,
    WORKSPACE_LEASE_UNAVAILABLE,
    'unavailable',
    cause === undefined ? undefined : { cause },
  )
}

function requestId() {
  return randomUUID()
}

/** @param {unknown} value @param {string} operation */
function assertProviderResult(value, operation) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable(`workspace lease provider returned an invalid ${operation} result`)
  }
}

/** @param {unknown} value */
function assertProvider(value) {
  if (value === null || typeof value !== 'object') {
    throw unavailable('workspace lease provider is invalid')
  }
  const candidate = /** @type {Partial<WorkspaceLeaseProvider>} */ (value)
  if (candidate.protocolVersion !== WORKSPACE_LEASE_PROTOCOL_VERSION) {
    throw unavailable(
      `workspace lease provider protocol is unsupported; expected ${WORKSPACE_LEASE_PROTOCOL_VERSION}`,
    )
  }
  for (const method of ['resolve', 'bind', 'begin', 'complete', 'renew', 'release']) {
    if (typeof candidate[/** @type {keyof WorkspaceLeaseProvider} */ (method)] !== 'function') {
      throw unavailable(`workspace lease provider is missing ${method}()`)
    }
  }
}

/** @param {number | undefined} value */
function positiveDelay(value) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw unavailable('workspace lease provider returned an invalid renewal delay')
  }
  return value
}

/** @param {unknown} value @param {string} field */
function nonEmpty(value, field) {
  if (typeof value !== 'string'
    || !printableProviderText.test(value)
    || Buffer.byteLength(value, 'utf8') > 512) {
    throw unavailable(`workspace lease provider returned an invalid ${field}`)
  }
  return value
}

/**
 * Freeze the exact target the provider authenticated. The runtime treats it as
 * an opaque selector: it is echoed back to the provider and never parsed,
 * joined, compared to a model argument, or projected into tool output.
 * @param {unknown} value
 * @returns {WorkspaceLeaseTarget}
 */
function frozenTarget(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable('workspace lease provider returned an invalid target')
  }
  const candidate = /** @type {Partial<WorkspaceLeaseTarget>} */ (value)
  const root = candidate.root
  if (typeof root !== 'string'
    || !printableProviderText.test(root)
    || Buffer.byteLength(root, 'utf8') > WORKSPACE_LEASE_MAX_TARGET_PATH_BYTES
    || !isAbsolute(root)) {
    throw unavailable('workspace lease provider returned an invalid target root')
  }
  return Object.freeze({
    workspaceKey: nonEmpty(candidate.workspaceKey, 'target workspace key'),
    root,
  })
}

/**
 * @param {Agent['session']} session
 * @returns {Omit<WorkspaceLeaseBindingFacts, 'requestId'>}
 */
function bindingFacts(session) {
  return {
    version: WORKSPACE_LEASE_PROTOCOL_VERSION,
    sessionId: session.header.id,
    ...(session.header.parentSession === undefined
      ? {}
      : { parentSessionId: session.header.parentSession }),
  }
}

/** @param {ToolExecution} exec @param {Agent} agent @returns {ExecutionIdentity} */
function executionIdentity(exec, agent) {
  return {
    token: exec.token,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    toolName: exec.name,
    arguments: exec.arguments,
    agent,
    session: agent.session,
    parent: exec.parent,
    signal: exec.signal,
  }
}

/** @param {ExecutionIdentity} authorization @param {Readonly<ToolExecution>} exec */
function matchesExecution(authorization, exec) {
  return authorization.token === exec.token
    && authorization.callId === exec.callId
    && authorization.rootCallId === exec.rootCallId
    && authorization.toolName === exec.name
    && authorization.arguments === exec.arguments
    && authorization.agent === exec.agent
    && authorization.session === exec.agent?.session
    && authorization.parent === exec.parent
    && authorization.signal === exec.signal
}

function deferred() {
  let resolve = () => {}
  /** @type {Promise<void>} */
  const promise = new Promise(accept => {
    resolve = () => { accept() }
  })
  return { promise, resolve }
}

/** @param {readonly AbortSignal[]} signals @returns {FusedSignal} */
function fuseSignals(signals) {
  const controller = new AbortController()
  /** @type {{signal: AbortSignal, listener: () => void}[]} */
  const attached = []
  for (const signal of signals) {
    const listener = () => { controller.abort(signal.reason) }
    if (signal.aborted) listener()
    else {
      signal.addEventListener('abort', listener, { once: true })
      attached.push({ signal, listener })
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const entry of attached) entry.signal.removeEventListener('abort', entry.listener)
    },
  }
}

/** @param {ToolExecutionResult | undefined} result */
function errorCode(result) {
  return result?.error?.info?.code
}

/**
 * Runtime-kit-owned native workspace authority service. It mints no Git or
 * lease policy: the provider classifies operations and owns canonicalization,
 * persistence, fencing, recovery, and conflicts. The service owns exact DSH
 * lifecycle attribution, per-repository authority selection, and pre-body
 * admission.
 *
 * A repository lease coordinates governed Git mutation. It does not authorize
 * ordinary OS reads and writes, and a lease *denial* is local to the exact
 * repository target it names: it never reduces this session's host authority
 * over other repositories or non-repository paths. A provider *integrity*
 * failure still fails closed, because an untrustworthy protocol cannot make
 * an honest coverage claim about anything. Future access isolation is
 * implemented by containing the whole DSH runtime, not by workspace leases.
 */
export class WorkspaceLease extends Service {
  static inject = ['agents', 'tools']

  /** @type {ProviderSlot | undefined} */
  #provider
  /** @type {WeakMap<Agent, AgentSlot>} */
  #agentSlots = new WeakMap()
  /** @type {Set<AgentSlot>} */
  #liveSlots = new Set()
  /** @type {WeakMap<WorkspaceRef, WorkspaceRefMeta>} */
  #refs = new WeakMap()
  /** @type {WeakMap<ToolExecution, readonly LeaseOperation[]>} */
  #executions = new WeakMap()
  /** @type {WeakMap<ToolExecution, ExecutionAuthorization>} */
  #authorizations = new WeakMap()
  /** @type {WeakMap<ToolExecution, Promise<readonly WorkspaceLeaseTarget[]>>} */
  #resolutions = new WeakMap()
  /**
   * Executions this boundary has taken responsibility for admitting. Only
   * these may have their canonical repository targets projected.
   * @type {WeakSet<ToolExecution>}
   */
  #admitting = new WeakSet()

  /** @param {Context} ctx */
  constructor(ctx) {
    super(ctx, 'workspaceLease')

    // Cordis presents services through a scoped Proxy. Bind the public methods
    // to the concrete instance so native private state stays inaccessible while
    // calls through ctx.workspaceLease still carry the correct receiver.
    this.registerProvider = this.registerProvider.bind(this)
    this.denialState = this.denialState.bind(this)
    this.ref = this.ref.bind(this)
    this.state = this.state.bind(this)
    this.targets = this.targets.bind(this)

    ctx.on('agent/session-start', ({ agent, source }) => {
      this.#sessionStarted(agent, source)
    })
    ctx.on('tools/pre-execute', (exec, next) => this.#preExecute(exec, next), { prepend: true })
    ctx.on('tools/execute', (exec, next) => this.#execute(exec, next), { prepend: true })
    ctx.on(
      'tools/post-execute',
      (exec, result, next) => this.#postExecute(exec, result, next),
      { prepend: true },
    )
    ctx.tools.guard(exec => this.#guard(exec))
    ctx.on('tools/result', exec => {
      this.#authorizations.delete(exec)
      this.#resolutions.delete(exec)
    })
  }

  /**
   * Register the one trusted provider. Its disposer aborts and drains exact
   * operations before releasing every binding generation it owns.
   * @param {WorkspaceLeaseProvider} provider
   * @returns {() => Promise<void>}
   */
  registerProvider(provider) {
    assertProvider(provider)
    return this.ctx.effect(() => {
      if (this.#provider !== undefined) {
        throw unavailable('a workspace lease provider is already registered')
      }
      /** @type {ProviderSlot} */
      const slot = { provider, bindings: new Set(), stopping: false }
      this.#provider = slot
      for (const agentSlot of this.#liveSlots) this.#startAnchor(agentSlot)
      return async () => {
        slot.stopping = true
        const lifecycleCause = unavailable('workspace lease provider is stopping')
        /** @type {Promise<unknown>[]} */
        const anchors = []
        for (const agentSlot of this.#liveSlots) {
          agentSlot.anchorController?.abort(lifecycleCause)
          if (agentSlot.anchor !== undefined) anchors.push(agentSlot.anchor)
          for (const acquisition of agentSlot.acquisitions.values()) anchors.push(acquisition)
        }
        await Promise.allSettled(anchors)

        const releaseResults = await Promise.allSettled(
          [...slot.bindings].map(binding => this.#releaseBinding(binding, 'provider-disposed')),
        )
        for (const agentSlot of this.#liveSlots) {
          agentSlot.bindings.clear()
          agentSlot.acquisitions.clear()
          agentSlot.anchor = undefined
        }

        /** @type {unknown[]} */
        const failures = []
        for (const result of releaseResults) {
          if (result.status === 'rejected') failures.push(result.reason)
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'workspace lease provider disposal failed to release authority',
          )
        }
        if (this.#provider === slot) this.#provider = undefined
      }
    }, 'workspaceLease.registerProvider()')
  }

  /**
   * Resolve the opaque authority-set reference for one exact live Agent. A
   * session always owns an authority set, so this proves only that the exact
   * live lifecycle and provider are available. It grants no repository lease.
   * @param {Agent} agent
   * @returns {Promise<WorkspaceRef>}
   */
  async ref(agent) {
    this.#assertLive(agent)
    const slot = this.#agentSlots.get(agent)
    if (slot === undefined
      || slot.disposed
      || slot.ref === undefined
      || agent.session !== slot.session) {
      throw new WorkspaceLeaseError(
        'workspace identity is not bound: agent/session-start has not established a lifecycle',
        WORKSPACE_LEASE_UNBOUND,
        'unavailable',
      )
    }
    const provider = this.#provider
    if (provider === undefined || provider.stopping) {
      throw unavailable('workspace lease provider is unavailable')
    }
    return slot.ref
  }

  /**
   * Project the canonical repository roots the provider authenticated for one
   * exact live execution.
   *
   * A trusted downstream boundary — the finish-line ledger — needs the same
   * classification before this service admits the call, so that it can attribute
   * an edit generation to the repository the operation actually targets instead
   * of to the session anchor. Both paths observe one provider decision: the
   * resolution is memoized per exact execution object.
   *
   * The result is the provider's own authenticated roots. It is never derived
   * from a model-supplied path here, carries no lease authority, and an empty
   * array means the provider proved the operation touches no repository.
   * @param {ToolExecution} exec
   * @returns {Promise<readonly string[]>}
   */
  async targets(exec) {
    const agent = exec.agent
    if (agent === undefined) return Object.freeze([])
    // No `#assertLive` here: it was the one rejection cause `#preExecute` did
    // not mirror, and `#admitting` membership already proves this boundary
    // took the execution.
    // Only an execution this service is admitting may be projected. The
    // canonical repository root is exactly what `denialState` withholds, so
    // without this a composed plugin could hand in a fabricated execution and
    // use the boundary as a path-disclosure and provider-probe oracle. The
    // lease's `tools/pre-execute` is prepended, so it has always recorded the
    // execution before any downstream boundary can ask about it.
    if (!this.#admitting.has(exec)) {
      throw new WorkspaceLeaseError(
        'workspace targets are available only for an execution this boundary is admitting',
        WORKSPACE_LEASE_UNAVAILABLE,
        'unavailable',
      )
    }
    // Every remaining rejection cause below is mirrored by an identical guard
    // in `#preExecute`, so no projection failure can exist that admission does
    // not also refuse. That symmetry is what lets the finish-line boundary
    // reserve nothing on a projection failure and rely on the lease's own
    // typed denial arriving immediately afterwards.
    const slot = this.#agentSlots.get(agent)
    if (slot === undefined || slot.disposed || agent.session !== slot.session) {
      throw new WorkspaceLeaseError(
        'workspace identity is unavailable for this agent lifecycle',
        WORKSPACE_LEASE_UNAVAILABLE,
        'unavailable',
      )
    }
    const provider = this.#provider
    if (provider === undefined) throw unavailable('workspace lease provider is unavailable')
    if (provider.stopping) throw unavailable('workspace lease provider is stopping')
    const identity = executionIdentity(exec, agent)
    const fused = fuseSignals([identity.signal, slot.lifecycle.signal])
    try {
      const resolved = await this.#resolutionFor(exec, provider, slot, identity, fused.signal)
      return Object.freeze(resolved.map(target => target.root))
    } finally {
      fused.dispose()
    }
  }

  /**
   * Resolve one execution's canonical repository targets exactly once.
   * @param {ToolExecution} exec
   * @param {ProviderSlot} provider
   * @param {AgentSlot} slot
   * @param {ExecutionIdentity} identity
   * @param {AbortSignal} signal
   * @returns {Promise<readonly WorkspaceLeaseTarget[]>}
   */
  #resolutionFor(exec, provider, slot, identity, signal) {
    const existing = this.#resolutions.get(exec)
    if (existing !== undefined) return existing
    const resolution = this.#resolveTargets(provider, slot, identity, signal)
    this.#resolutions.set(exec, resolution)
    void resolution.catch(() => {})
    return resolution
  }

  /**
   * Project only the stable anchor denial state for one exact live Agent. This
   * grants no reference or authority and never exposes provider reason text,
   * owner identity, lease IDs, generations, or durable record contents.
   *
   * A non-null result means the session anchor repository cannot currently be
   * coordinated. It never means the session lost host authority.
   * @param {Agent} agent
   * @returns {Promise<{state: Exclude<WorkspaceLeaseState, 'owned' | 'unmanaged'>, code: string} | null>}
   */
  async denialState(agent) {
    this.#assertLive(agent)
    const slot = this.#agentSlots.get(agent)
    if (slot === undefined || slot.disposed) {
      return { state: 'unavailable', code: WORKSPACE_LEASE_UNBOUND }
    }
    const anchor = slot.anchor ?? this.#startAnchor(slot)
    if (anchor === undefined) {
      return { state: 'unavailable', code: WORKSPACE_LEASE_UNAVAILABLE }
    }
    try {
      await anchor
      return null
    } catch (error) {
      if (error instanceof WorkspaceLeaseError
        && deniedStates.has(error.state)
        && providerCodePattern.test(error.code)) {
        return {
          state: /** @type {Exclude<WorkspaceLeaseState, 'owned' | 'unmanaged'>} */ (error.state),
          code: error.code,
        }
      }
      return { state: 'unavailable', code: WORKSPACE_LEASE_UNAVAILABLE }
    }
  }

  /**
   * Return the session anchor classification only after validating the exact
   * Agent/ref pairing. The anchor is context: `unmanaged` means the anchor is
   * not a repository, not that the session lacks host authority.
   * @param {Agent} agent
   * @param {WorkspaceRef} ref
   * @returns {Promise<WorkspaceLeaseState>}
   */
  async state(agent, ref) {
    const slot = this.#requireRef(agent, ref)
    const anchor = slot.anchor ?? this.#startAnchor(slot)
    if (anchor === undefined) return 'unavailable'
    try {
      return (await anchor).state
    } catch (error) {
      if (error instanceof WorkspaceLeaseError && deniedStates.has(error.state)) {
        return error.state
      }
      return 'unavailable'
    }
  }

  /** @param {Agent} agent @param {WorkspaceRef} ref @returns {AgentSlot} */
  #requireRef(agent, ref) {
    this.#assertLive(agent)
    const meta = this.#refs.get(ref)
    const slot = this.#agentSlots.get(agent)
    if (meta === undefined
      || meta.agent !== agent
      || slot === undefined
      || meta.slot !== slot
      || slot.disposed
      || slot.ref !== ref
      || agent.session !== slot.session) {
      throw new WorkspaceLeaseInvalidRefError()
    }
    return slot
  }

  /** @param {Agent} agent */
  #assertLive(agent) {
    if (this.ctx.agents.get(agent.id) !== agent) throw new WorkspaceLeaseInvalidRefError()
  }

  /** @param {Agent} agent @param {SessionStartSource} source */
  #sessionStarted(agent, source) {
    let slot = this.#agentSlots.get(agent)
    if (slot === undefined) {
      slot = {
        agent,
        session: agent.session,
        epoch: 0,
        source,
        disposed: false,
        bindings: new Map(),
        acquisitions: new Map(),
        lifecycle: new AbortController(),
        draining: undefined,
        anchor: undefined,
        anchorController: undefined,
        anchorTarget: undefined,
        ref: undefined,
      }
      this.#agentSlots.set(agent, slot)
      this.#liveSlots.add(slot)
      const exact = slot
      agent.ctx.effect(() => async () => {
        exact.disposed = true
        exact.epoch += 1
        const cause = unavailable('workspace lease authority owner was disposed')
        exact.anchorController?.abort(cause)
        exact.lifecycle.abort(cause)
        try {
          await this.#releaseAll(exact, 'agent-disposed')
        } finally {
          if (exact.ref !== undefined) this.#refs.delete(exact.ref)
          exact.ref = undefined
          this.#liveSlots.delete(exact)
        }
      }, 'workspaceLease.agentAuthority()')
    }
    slot.session = agent.session
    slot.source = source
    this.#rebind(slot)
  }

  /**
   * A session lifecycle change retires every repository generation this slot
   * acquired before the replacement set may acquire anything.
   * @param {AgentSlot} slot
   */
  #rebind(slot) {
    if (slot.disposed) return
    const epoch = ++slot.epoch
    const cause = unavailable('workspace lease session lifecycle was rebound')
    slot.anchorController?.abort(cause)
    slot.lifecycle.abort(cause)
    slot.lifecycle = new AbortController()
    slot.anchor = undefined
    slot.anchorController = undefined
    slot.anchorTarget = undefined
    if (slot.ref !== undefined) this.#refs.delete(slot.ref)
    const ref = /** @type {WorkspaceRef} */ (Object.freeze(Object.create(null)))
    slot.ref = ref
    this.#refs.set(ref, { agent: slot.agent, slot })
    // Acquisition must never overlap the release of the generation it
    // replaces: the same durable workspace would report a live foreign owner.
    // A generation that could not be surrendered may still be held durably, so
    // the drain's failure has to reach whoever waits on it: minting a second
    // generation for that workspace would contend with our own stale one and
    // report it as a foreign owner. The separate no-op catch only stops the
    // rejection from being unhandled; it does not hide it from awaiters.
    const drained = this.#releaseAll(slot, 'session-rebound')
    void drained.catch(() => {})
    slot.draining = drained
    void drained.then(
      () => {
        if (slot.disposed || slot.epoch !== epoch) return
        this.#startAnchor(slot)
      },
      () => {},
    )
  }

  /**
   * The eager anchor classification is an optimization: it lets a clean anchor
   * repository contend across sessions before any tool runs. Its failure is
   * local to that repository and never poisons an unrelated operation.
   * @param {AgentSlot} slot
   * @returns {Promise<AnchorClassification> | undefined}
   */
  #startAnchor(slot) {
    if (slot.disposed) return undefined
    const provider = this.#provider
    if (provider === undefined || provider.stopping) return undefined
    if (slot.anchor !== undefined) return slot.anchor
    // A child lineage inherits its ancestor's anchor authority when it starts
    // in the same worktree; binding again would make one lineage contend with
    // itself on one physical worktree. A member that starts in a *different*
    // worktree classifies its own anchor instead, so its `state()` and
    // `denialState()` describe the repository it is actually in rather than
    // its ancestor's.
    const owner = this.#authoritySlot(slot)
    if (owner !== slot && owner.session.header.cwd === slot.session.header.cwd) {
      const inherited = this.#startAnchor(owner)
      if (inherited === undefined) return undefined
      slot.anchor = inherited
      void inherited.then(
        () => { slot.anchorTarget = owner.anchorTarget },
        () => {},
      )
      return inherited
    }
    const session = slot.session
    const cwd = session.header.cwd
    const controller = new AbortController()
    slot.anchorController = controller
    const anchor = (async () => {
      await slot.draining
      if (slot.disposed || slot.session !== session) {
        throw unavailable('workspace lease anchor lifecycle changed before bind')
      }
      if (cwd === undefined) return { state: /** @type {const} */ ('unmanaged') }
      const result = await this.#invokeBind(
        provider,
        {
          ...bindingFacts(session),
          requestId: requestId(),
          cwd,
          source: slot.source,
        },
        controller.signal,
      )
      if (result.kind === 'not-required') return { state: /** @type {const} */ ('unmanaged') }
      if (result.kind === 'denied') throw providerError(result)
      if (slot.disposed || slot.session !== session) {
        await this.#releaseGeneration(provider, session, result, 'session-rebound')
        throw unavailable('workspace lease anchor lifecycle changed after bind')
      }
      const binding = this.#adoptBinding(owner, slot, provider, session, result)
      slot.anchorTarget = binding.workspaceKey
      return { state: binding.initialState }
    })()
    slot.anchor = anchor
    void anchor.catch(() => {})
    return anchor
  }

  /**
   * Resolve the live lineage root that owns the shared authority set.
   * @param {AgentSlot} slot
   * @returns {AgentSlot}
   */
  #authoritySlot(slot) {
    /** @type {Set<AgentSlot>} */
    const seen = new Set()
    let current = slot
    while (!seen.has(current)) {
      seen.add(current)
      const parentSession = current.session.header.parentSession
      if (parentSession === undefined) return current
      /** @type {AgentSlot | undefined} */
      let parent
      for (const candidate of this.#liveSlots) {
        if (candidate === current || candidate.disposed) continue
        if (candidate.session.header.id === parentSession) {
          parent = candidate
          break
        }
      }
      if (parent === undefined) return current
      current = parent
    }
    return current
  }

  /**
   * @param {ProviderSlot} provider
   * @param {WorkspaceLeaseBindRequest} request
   * @param {AbortSignal} signal
   * @returns {Promise<WorkspaceLeaseBindResult>}
   */
  async #invokeBind(provider, request, signal) {
    /** @type {WorkspaceLeaseBindResult} */
    let result
    try {
      result = await provider.provider.bind(request, signal)
    } catch (error) {
      throw error instanceof WorkspaceLeaseError
        ? error
        : unavailable('workspace lease provider failed to bind a repository target', error)
    }
    assertProviderResult(result, 'bind')
    if (result.kind === 'not-required' || result.kind === 'denied') return result
    if (result.kind !== 'bound') {
      throw unavailable('workspace lease provider returned an invalid bind result')
    }
    if (result.state !== 'owned' && result.state !== 'unmanaged') {
      throw unavailable('workspace lease provider returned an invalid bound state')
    }
    return result
  }

  /**
   * @param {ProviderSlot} provider
   * @param {Agent['session']} session
   * @param {WorkspaceLeaseBound} result
   * @param {WorkspaceLeaseReleaseReason} reason
   */
  async #releaseGeneration(provider, session, result, reason) {
    try {
      await provider.provider.release({
        ...bindingFacts(session),
        requestId: requestId(),
        bindingId: result.bindingId,
        workspaceId: result.workspaceId,
        generation: result.generation,
        reason,
      }, new AbortController().signal)
    } catch (error) {
      throw new WorkspaceLeaseError(
        'workspace lease provider failed to release authority',
        WORKSPACE_LEASE_RELEASE_FAILED,
        'unavailable',
        { cause: error },
      )
    }
  }

  /**
   * The authority slot owns the durable generation, but the slot that acquired
   * it owns its release: a descendant that binds a repository its ancestor
   * never touched must surrender that generation when the descendant is
   * disposed, not when the whole lineage ends.
   * @param {AgentSlot} owner
   * @param {AgentSlot} acquirer
   * @param {ProviderSlot} provider
   * @param {Agent['session']} session
   * @param {WorkspaceLeaseBound} result
   * @returns {BoundWorkspace}
   */
  #adoptBinding(owner, acquirer, provider, session, result) {
    const target = frozenTarget(result.target)
    /** @type {BoundWorkspace} */
    const binding = {
      owner,
      acquirer,
      session,
      provider,
      workspaceKey: target.workspaceKey,
      bindingId: nonEmpty(result.bindingId, 'bindingId'),
      workspaceId: nonEmpty(result.workspaceId, 'workspaceId'),
      generation: nonEmpty(result.generation, 'generation'),
      target,
      initialState: result.state,
      lifecycle: new AbortController(),
      admissions: new Set(),
      operations: new Set(),
      renewAfterMs: positiveDelay(result.renewAfterMs),
      renewTimer: undefined,
      renewController: undefined,
      renewing: undefined,
      failure: undefined,
      released: false,
      releaseTask: undefined,
    }
    provider.bindings.add(binding)
    const superseded = owner.bindings.get(target.workspaceKey)
    owner.bindings.set(target.workspaceKey, binding)
    if (superseded !== undefined && superseded !== binding) {
      // A superseded generation must stop renewing and fencing at once.
      void this.#releaseBinding(superseded, 'session-rebound').catch(() => {})
    }
    this.#armRenewal(binding)
    return binding
  }

  /**
   * Acquire or reuse the exact repository binding for one resolved target.
   * A denial is thrown as a typed target-local failure; unrelated repositories
   * in the same authority set are untouched.
   * @param {AgentSlot} slot
   * @param {ProviderSlot} provider
   * @param {WorkspaceLeaseTarget} target
   * @param {AbortSignal} signal
   * @returns {Promise<BoundWorkspace | undefined>}
   */
  async #acquire(slot, provider, target, signal) {
    const owner = this.#authoritySlot(slot)
    await owner.draining
    if (owner !== slot) await slot.draining
    // The eager anchor binding must settle before a lazy acquisition, or the
    // anchor repository would be bound twice and supersede its own generation.
    const anchor = owner.anchor ?? this.#startAnchor(owner)
    if (anchor !== undefined) await anchor.catch(() => {})
    if (slot.disposed || owner.disposed) {
      throw unavailable('workspace lease acquisition lost lifecycle authority')
    }
    const key = target.workspaceKey
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = owner.bindings.get(key)
      if (existing !== undefined && this.#bindingUsable(existing)) return existing
      const inflight = owner.acquisitions.get(key)
      if (inflight !== undefined) {
        await inflight.catch(() => {})
        continue
      }
      // The durable generation is owned by the lineage root, so the root is the
      // principal recorded at bind and replayed by every later begin, complete
      // and release. It has to be the same identity throughout: the boundary
      // authenticates each call against the session digest captured at bind,
      // so acquiring as a descendant and then operating as the root would be
      // rejected as a stale binding.
      const session = owner.session
      const exact = slot.session
      const acquisition = (async () => {
        const result = await this.#invokeBind(
          provider,
          {
            ...bindingFacts(session),
            requestId: requestId(),
            target,
            source: slot.source,
          },
          signal,
        )
        if (result.kind === 'denied') throw providerError(result)
        if (result.kind === 'not-required') return undefined
        if (slot.disposed
          || slot.session !== exact
          || owner.disposed
          || owner.session !== session
          || provider.stopping) {
          await this.#releaseGeneration(provider, session, result, 'session-rebound')
          throw unavailable('workspace lease acquisition lost lifecycle authority')
        }
        return this.#adoptBinding(owner, slot, provider, session, result)
      })()
      owner.acquisitions.set(key, acquisition)
      try {
        return await acquisition
      } finally {
        if (owner.acquisitions.get(key) === acquisition) owner.acquisitions.delete(key)
      }
    }
    throw unavailable('workspace lease repository authority could not be acquired')
  }

  /**
   * @param {ToolExecution} exec
   * @param {() => Promise<PreToolDecision>} next
   * @returns {Promise<PreToolDecision>}
   */
  async #preExecute(exec, next) {
    // Take responsibility for the execution before the downstream waterfall
    // runs: `next()` is what invokes the finish-line boundary, and that is
    // where `targets()` is asked. Recording afterwards would refuse the very
    // execution this boundary is admitting.
    if (exec.agent !== undefined) this.#admitting.add(exec)
    const downstream = await next()
    if ((downstream.kind !== 'allow' && downstream.kind !== 'ask')
      || exec.agent === undefined
      || exec.signal.aborted) {
      return downstream
    }
    const agent = exec.agent
    const identity = executionIdentity(exec, agent)
    const slot = this.#agentSlots.get(agent)
    if (slot === undefined || slot.disposed || agent.session !== slot.session) {
      throw new WorkspaceLeaseError(
        'workspace identity is unavailable for this agent lifecycle',
        WORKSPACE_LEASE_UNAVAILABLE,
        'unavailable',
      )
    }
    const provider = this.#provider
    if (provider === undefined) throw unavailable('workspace lease provider is unavailable')
    if (provider.stopping) throw unavailable('workspace lease provider is stopping')
    const epoch = slot.epoch

    const admission = deferred()
    const admissionSignal = fuseSignals([identity.signal, slot.lifecycle.signal])
    /** @type {Set<BoundWorkspace>} */
    const admitted = new Set()
    /** @type {LeaseOperation[]} */
    const operations = []
    try {
      const targets = await this.#resolutionFor(
        exec,
        provider,
        slot,
        identity,
        admissionSignal.signal,
      )
      if (targets.length === 0) {
        // An unscoped native host operation. The runtime claims no repository
        // fence it cannot enforce, and denies nothing on that basis.
        this.#admit(exec, identity, slot, epoch, [])
        return downstream
      }

      // Canonical targets are acquired in the provider's deterministic order
      // before any fence is granted, so a denied target cannot leave an
      // already-fenced sibling free to dispatch.
      /** @type {BoundWorkspace[]} */
      const bindings = []
      for (const target of targets) {
        const binding = await this.#acquire(slot, provider, target, admissionSignal.signal)
        if (binding === undefined) continue
        if (binding.failure !== undefined) throw binding.failure
        bindings.push(binding)
        binding.admissions.add(admission.promise)
        admitted.add(binding)
        this.#syncRenewalTimerRef(binding)
      }
      if (bindings.length === 0) {
        this.#admit(exec, identity, slot, epoch, [])
        return downstream
      }

      for (const binding of bindings) {
        const granted = await this.#begin(binding, identity, admissionSignal.signal)
        if (granted !== undefined) operations.push(granted)
      }
      for (const operation of operations) operation.binding.operations.add(operation)

      if (this.#admissionChanged(slot, epoch, identity, exec, bindings, admissionSignal.signal)) {
        throw this.#firstFailure(bindings)
          ?? unavailable('workspace lease admission lost lifecycle authority')
      }
      if (operations.length > 0) this.#executions.set(exec, operations)
      this.#admit(exec, identity, slot, epoch, operations)
      return downstream
    } catch (error) {
      // Nothing may reach a tool body after a partial acquisition.
      this.#executions.delete(exec)
      this.#authorizations.delete(exec)
      const cancelled = identity.signal.aborted || slot.lifecycle.signal.aborted
      for (const operation of operations) operation.binding.operations.add(operation)
      await Promise.allSettled(operations.map(
        operation => this.#completeOperation(operation, cancelled ? 'cancelled' : 'failed'),
      ))
      throw error
    } finally {
      admissionSignal.dispose()
      for (const binding of admitted) {
        binding.admissions.delete(admission.promise)
        this.#syncRenewalTimerRef(binding)
      }
      admission.resolve()
    }
  }

  /**
   * @param {ToolExecution} exec
   * @param {ExecutionIdentity} identity
   * @param {AgentSlot} slot
   * @param {number} epoch
   * @param {readonly LeaseOperation[]} operations
   */
  #admit(exec, identity, slot, epoch, operations) {
    this.#authorizations.set(exec, { ...identity, slot, epoch, operations })
  }

  /**
   * @param {ProviderSlot} provider
   * @param {AgentSlot} slot
   * @param {ExecutionIdentity} identity
   * @param {AbortSignal} signal
   * @returns {Promise<readonly WorkspaceLeaseTarget[]>}
   */
  async #resolveTargets(provider, slot, identity, signal) {
    const cwd = slot.session.header.cwd
    /** @type {WorkspaceLeaseResolveResult} */
    let result
    try {
      result = await provider.provider.resolve({
        ...bindingFacts(slot.session),
        requestId: requestId(),
        ...(cwd === undefined ? {} : { anchorCwd: cwd }),
        callId: identity.callId,
        rootCallId: identity.rootCallId,
        toolName: identity.toolName,
        arguments: identity.arguments,
        nested: identity.parent !== undefined,
      }, signal)
    } catch (error) {
      throw error instanceof WorkspaceLeaseError
        ? error
        : unavailable('workspace lease provider failed to classify a tool operation', error)
    }
    assertProviderResult(result, 'resolve')
    if (result.kind === 'not-required') return []
    if (result.kind !== 'targets' || !Array.isArray(result.targets)) {
      throw unavailable('workspace lease provider returned an invalid resolve result')
    }
    if (result.targets.length === 0 || result.targets.length > WORKSPACE_LEASE_MAX_TARGETS) {
      throw unavailable('workspace lease provider returned an invalid target count')
    }
    /** @type {WorkspaceLeaseTarget[]} */
    const targets = []
    const seen = new Set()
    for (const candidate of result.targets) {
      const target = frozenTarget(candidate)
      if (seen.has(target.workspaceKey)) {
        throw unavailable('workspace lease provider returned a duplicate target')
      }
      seen.add(target.workspaceKey)
      targets.push(target)
    }
    return targets
  }

  /**
   * @param {BoundWorkspace} binding
   * @param {ExecutionIdentity} identity
   * @param {AbortSignal} signal
   * @returns {Promise<LeaseOperation | undefined>}
   */
  async #begin(binding, identity, signal) {
    /** @type {WorkspaceLeaseBeginResult} */
    let result
    try {
      result = await binding.provider.provider.begin({
        ...bindingFacts(binding.session),
        requestId: requestId(),
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        generation: binding.generation,
        bindingState: binding.initialState,
        target: binding.target,
        callId: identity.callId,
        rootCallId: identity.rootCallId,
        toolName: identity.toolName,
        arguments: identity.arguments,
        nested: identity.parent !== undefined,
      }, signal)
    } catch (error) {
      if (binding.failure !== undefined) throw binding.failure
      // A transport error is only ambiguous while the generation is still
      // usable; once it is retired the loss of authority is the honest cause.
      if (!this.#bindingUsable(binding) || binding.lifecycle.signal.aborted) {
        throw unavailable('workspace lease admission lost lifecycle authority')
      }
      throw error instanceof WorkspaceLeaseError
        ? error
        : unavailable('workspace lease provider failed before tool dispatch', error)
    }
    assertProviderResult(result, 'begin')
    if (result.kind === 'not-required') return undefined
    if (result.kind === 'denied') throw providerError(result)
    if (result.kind !== 'granted') {
      throw unavailable('workspace lease provider returned an invalid begin result')
    }
    const done = deferred()
    return {
      binding,
      identity,
      operationId: nonEmpty(result.operationId, 'operationId'),
      fence: nonEmpty(result.fence, 'fence'),
      authority: new AbortController(),
      completion: new AbortController(),
      settled: done.promise,
      settle: done.resolve,
      completing: false,
    }
  }

  /**
   * One place that decides whether a generation is still usable authority. A
   * new terminal condition must be added here and nowhere else; the admission
   * and guard paths below ask this question about the same binding at
   * different times, and they must not be able to disagree.
   * @param {BoundWorkspace} binding
   * @returns {boolean}
   */
  #bindingUsable(binding) {
    return !binding.released
      && binding.failure === undefined
      && !binding.provider.stopping
  }

  /**
   * Whether this generation is still the one its owning authority set names
   * for that repository. Identity is read through `binding.owner`, the same
   * map the retirement paths delete from, so a lineage change cannot make the
   * check and the mutation disagree about which map they mean.
   * @param {BoundWorkspace} binding
   * @returns {boolean}
   */
  #bindingCurrent(binding) {
    return this.#bindingUsable(binding)
      && binding.owner.bindings.get(binding.workspaceKey) === binding
  }

  /**
   * @param {AgentSlot} slot
   * @param {number} epoch
   * @param {ExecutionIdentity} identity
   * @param {ToolExecution} exec
   * @param {readonly BoundWorkspace[]} bindings
   * @param {AbortSignal} signal
   */
  #admissionChanged(slot, epoch, identity, exec, bindings, signal) {
    if (slot.disposed
      || slot.epoch !== epoch
      || identity.agent.session !== slot.session
      || !matchesExecution(identity, exec)
      || signal.aborted) return true
    return bindings.some(binding => !this.#bindingCurrent(binding))
  }

  /** @param {readonly BoundWorkspace[]} bindings */
  #firstFailure(bindings) {
    for (const binding of bindings) {
      if (binding.failure !== undefined) return binding.failure
    }
    return undefined
  }

  /**
   * Final monotonic DSH boundary: every agent execution that survived policy
   * and approval must carry one exact, live provider classification.
   * @param {Readonly<ToolExecution>} exec
   * @returns {string | undefined}
   */
  #guard(exec) {
    if (exec.agent === undefined) return undefined
    const authorization = this.#authorizations.get(exec)
    this.#authorizations.delete(exec)
    if (authorization === undefined) return changedAuthorizationReason
    const { slot, epoch, operations } = authorization
    if (!matchesExecution(authorization, exec)
      || this.#agentSlots.get(authorization.agent) !== slot
      || slot.disposed
      || slot.epoch !== epoch
      || authorization.agent.session !== slot.session) {
      return changedAuthorizationReason
    }
    for (const operation of operations) {
      if (!this.#bindingCurrent(operation.binding)) return changedAuthorizationReason
    }
    return undefined
  }

  /**
   * @param {ToolDispatchExecution} exec
   * @param {() => Promise<ToolExecutionResult>} next
   * @returns {Promise<ToolExecutionResult>}
   */
  async #execute(exec, next) {
    const operations = this.#executions.get(exec)
    if (operations === undefined || operations.length === 0) return next()
    const originalSignal = exec.signal
    const fused = fuseSignals([
      originalSignal,
      ...operations.map(operation => operation.authority.signal),
    ])
    exec.signal = fused.signal
    /** @type {ToolExecutionResult | undefined} */
    let result
    let thrown = false
    try {
      result = await next()
      return result
    } catch (error) {
      thrown = true
      throw error
    } finally {
      exec.signal = originalSignal
      fused.dispose()
      /** @type {WorkspaceLeaseOperationOutcome} */
      const outcome = fused.signal.aborted
        ? 'cancelled'
        : thrown || result?.isError === true ? 'failed' : 'succeeded'
      await this.#completeAll(exec, operations, outcome, errorCode(result))
    }
  }

  /**
   * Complete acquired operations when a guard or another pre-body boundary
   * prevents tools/execute from running.
   * @param {ToolExecution} exec
   * @param {Readonly<ToolExecutionResult>} result
   * @param {() => Promise<PostToolDecision>} next
   * @returns {Promise<PostToolDecision>}
   */
  async #postExecute(exec, result, next) {
    /** @type {PostToolDecision | undefined} */
    let decision
    let thrown = false
    try {
      decision = await next()
      return decision
    } catch (error) {
      thrown = true
      throw error
    } finally {
      const operations = this.#executions.get(exec)
      if (operations !== undefined && operations.length > 0) {
        /** @type {WorkspaceLeaseOperationOutcome} */
        const outcome = exec.signal.aborted
          ? 'cancelled'
          : thrown || result.isError || decision?.kind === 'block' ? 'failed' : 'succeeded'
        await this.#completeAll(exec, operations, outcome, errorCode(result))
      }
    }
  }

  /**
   * @param {ToolExecution} exec
   * @param {readonly LeaseOperation[]} operations
   * @param {WorkspaceLeaseOperationOutcome} outcome
   * @param {string} [code]
   */
  async #completeAll(exec, operations, outcome, code) {
    const results = await Promise.allSettled(
      operations.map(operation => this.#completeOperation(operation, outcome, code)),
    )
    this.#executions.delete(exec)
    this.#authorizations.delete(exec)
    /** @type {unknown[]} */
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'workspace lease provider failed to complete tool operations',
      )
    }
  }

  /**
   * @param {LeaseOperation} operation
   * @param {WorkspaceLeaseOperationOutcome} outcome
   * @param {string} [code]
   */
  async #completeOperation(operation, outcome, code) {
    if (operation.completing) {
      await operation.settled
      return
    }
    operation.completing = true
    const { identity, binding } = operation
    try {
      await binding.provider.provider.complete({
        ...bindingFacts(binding.session),
        requestId: requestId(),
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        generation: binding.generation,
        operationId: operation.operationId,
        fence: operation.fence,
        callId: identity.callId,
        rootCallId: identity.rootCallId,
        toolName: identity.toolName,
        outcome,
        ...(code === undefined ? {} : { errorCode: code }),
      }, operation.completion.signal)
    } catch (error) {
      const failure = unavailable(
        'workspace lease provider failed to complete a tool operation',
        error,
      )
      this.#markLost(binding, failure)
      throw failure
    } finally {
      binding.operations.delete(operation)
      operation.settle()
      this.#syncRenewalTimerRef(binding)
    }
  }

  /** @param {BoundWorkspace} binding */
  #armRenewal(binding) {
    if (binding.released || binding.failure !== undefined || binding.renewAfterMs === undefined) {
      return
    }
    binding.renewTimer = setTimeout(() => {
      const renewal = this.#renewBinding(binding)
      binding.renewing = renewal
      void renewal.finally(() => {
        if (binding.renewing === renewal) binding.renewing = undefined
      }).catch(() => {})
    }, binding.renewAfterMs)
    this.#syncRenewalTimerRef(binding)
  }

  /**
   * Idle bindings must not keep the process alive, while an admission or an
   * acquired operation must keep its renewal deadline observable.
   * @param {BoundWorkspace} binding
   */
  #syncRenewalTimerRef(binding) {
    if (binding.renewTimer === undefined) return
    if (binding.admissions.size > 0 || binding.operations.size > 0) {
      binding.renewTimer.ref()
    } else binding.renewTimer.unref()
  }

  /** @param {BoundWorkspace} binding */
  async #renewBinding(binding) {
    binding.renewTimer = undefined
    if (binding.released || binding.failure !== undefined || binding.provider.stopping) return
    const controller = new AbortController()
    binding.renewController = controller
    /** @type {WorkspaceLeaseRenewResult} */
    let result
    try {
      result = await binding.provider.provider.renew({
        ...bindingFacts(binding.session),
        requestId: requestId(),
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        generation: binding.generation,
      }, controller.signal)
    } catch (error) {
      if (binding.released || binding.provider.stopping) return
      this.#markLost(binding, unavailable('workspace lease renewal failed', error))
      return
    } finally {
      if (binding.renewController === controller) binding.renewController = undefined
    }
    if (binding.released || binding.provider.stopping) return
    try {
      assertProviderResult(result, 'renewal')
    } catch (error) {
      this.#markLost(
        binding,
        error instanceof WorkspaceLeaseError
          ? error
          : unavailable('workspace lease renewal response is invalid', error),
      )
      return
    }
    if (result.kind === 'lost') {
      this.#markLost(binding, providerError({ ...result, kind: 'denied' }))
      return
    }
    if (result.kind !== 'renewed') {
      this.#markLost(binding, unavailable('workspace lease provider returned an invalid renewal result'))
      return
    }
    try {
      binding.renewAfterMs = positiveDelay(result.renewAfterMs ?? binding.renewAfterMs)
      this.#armRenewal(binding)
    } catch (error) {
      this.#markLost(
        binding,
        error instanceof WorkspaceLeaseError
          ? error
          : unavailable('workspace lease renewal response is invalid', error),
      )
    }
  }

  /**
   * Drop any anchor classification that was derived from this generation, in
   * the owning slot and in every lineage member aliasing it, so the next
   * `state()` or `denialState()` re-derives instead of reporting a retired
   * generation as live authority.
   * @param {BoundWorkspace} binding
   */
  #forgetAnchor(binding) {
    if (binding.owner.anchorTarget !== binding.workspaceKey) return
    binding.owner.anchor = undefined
    binding.owner.anchorController = undefined
    binding.owner.anchorTarget = undefined
    for (const candidate of this.#liveSlots) {
      if (candidate.anchorController === undefined
        && candidate.anchorTarget === binding.workspaceKey) {
        candidate.anchor = undefined
        candidate.anchorTarget = undefined
      }
    }
  }

  /**
   * Losing one repository generation aborts only that repository's operations
   * and retires only its slot in the authority set. Unrelated repositories
   * keep independent authority, and the next operation targeting the lost
   * repository re-acquires it honestly.
   * @param {BoundWorkspace} binding
   * @param {WorkspaceLeaseError} failure
   */
  #markLost(binding, failure) {
    if (binding.failure !== undefined || binding.released) return
    binding.failure = failure
    if (binding.renewTimer !== undefined) clearTimeout(binding.renewTimer)
    binding.renewTimer = undefined
    binding.lifecycle.abort(failure)
    if (binding.owner.bindings.get(binding.workspaceKey) === binding) {
      binding.owner.bindings.delete(binding.workspaceKey)
    }
    this.#forgetAnchor(binding)
    // A generation lost to a transport failure may still be held durably by
    // the boundary: the renew and complete failure paths cannot tell a lost
    // lease from an unreachable one. Retiring the map entry alone would leave
    // it held until process exit, so surrender it the way a superseded
    // generation is surrendered.
    void this.#releaseBinding(binding, 'session-rebound').catch(() => {})
    for (const operation of binding.operations) operation.authority.abort(failure)
    if (binding.operations.size > 0) {
      for (const owner of new Set(
        [...binding.operations].map(operation => operation.identity.agent),
      )) {
        try {
          owner.cancel({
            kind: 'hook',
            reason: `workspace-lease-lost:${failure.code}`,
          })
        } catch {
          // The operation authority signal remains the mandatory cancellation path.
        }
      }
    }
  }

  /**
   * @param {AgentSlot} slot
   * @param {WorkspaceLeaseReleaseReason} reason
   * @returns {Promise<void>}
   */
  async #releaseAll(slot, reason) {
    const pending = [...slot.acquisitions.values()]
    slot.acquisitions.clear()
    await Promise.allSettled(pending)
    const bindings = [...slot.bindings.values()]
    slot.bindings.clear()
    // A generation this slot acquired lives in its lineage root's authority
    // set, not its own, so releasing only `slot.bindings` would strand it --
    // still renewing, still holding the durable worktree -- for as long as the
    // ancestor session lives. Surrender exactly what this slot acquired.
    for (const candidate of this.#liveSlots) {
      if (candidate === slot) continue
      for (const binding of candidate.bindings.values()) {
        if (binding.acquirer === slot && !bindings.includes(binding)) bindings.push(binding)
      }
    }
    const results = await Promise.allSettled(
      bindings.map(binding => this.#releaseBinding(binding, reason)),
    )
    /** @type {unknown[]} */
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'workspace lease failed to release repository authority',
      )
    }
  }

  /** @param {BoundWorkspace} binding @param {WorkspaceLeaseReleaseReason} reason */
  async #releaseBinding(binding, reason) {
    if (binding.releaseTask !== undefined) return binding.releaseTask
    const releaseTask = (async () => {
      binding.released = true
      if (binding.owner.bindings.get(binding.workspaceKey) === binding) {
        binding.owner.bindings.delete(binding.workspaceKey)
      }
      this.#forgetAnchor(binding)
      if (binding.renewTimer !== undefined) clearTimeout(binding.renewTimer)
      binding.renewTimer = undefined
      const releaseCause = unavailable(`workspace lease binding is releasing (${reason})`)
      binding.lifecycle.abort(releaseCause)
      binding.renewController?.abort(releaseCause)
      for (const operation of binding.operations) {
        operation.authority.abort(releaseCause)
      }
      if (binding.operations.size > 0) {
        for (const owner of new Set(
          [...binding.operations].map(operation => operation.identity.agent),
        )) {
          try {
            owner.cancel({
              kind: 'hook',
              reason: `workspace-lease-release:${reason}`,
            })
          } catch {
            // Exact operation signals still enforce the local lifecycle boundary.
          }
        }
      }
      const drains = [
        ...binding.admissions,
        ...[...binding.operations].map(operation => operation.settled),
        ...(binding.renewing === undefined ? [] : [binding.renewing]),
      ]
      await Promise.allSettled(drains)
      try {
        await binding.provider.provider.release({
          ...bindingFacts(binding.session),
          requestId: requestId(),
          bindingId: binding.bindingId,
          workspaceId: binding.workspaceId,
          generation: binding.generation,
          reason,
        }, new AbortController().signal)
      } catch (error) {
        throw new WorkspaceLeaseError(
          'workspace lease provider failed to release authority',
          WORKSPACE_LEASE_RELEASE_FAILED,
          'unavailable',
          { cause: error },
        )
      } finally {
        binding.provider.bindings.delete(binding)
      }
    })()
    binding.releaseTask = releaseTask
    return releaseTask
  }
}

export default WorkspaceLease
