// @ts-check

import { randomUUID } from 'node:crypto'

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

/** Protocol version stamped on every trusted provider request. */
export const WORKSPACE_LEASE_PROTOCOL_VERSION = 1

/** @typedef {'owned' | 'foreign-active' | 'stale-clean' | 'dirty' | 'uncertain' | 'unavailable' | 'unmanaged'} WorkspaceLeaseState */
/** @typedef {'agent-disposed' | 'session-rebound' | 'provider-disposed'} WorkspaceLeaseReleaseReason */
/** @typedef {'succeeded' | 'failed' | 'cancelled'} WorkspaceLeaseOperationOutcome */

/**
 * Opaque, non-bearer reference. Its provenance is retained only in a private
 * WeakMap and is rechecked against the exact live Agent on every use.
 * @typedef {Readonly<Record<never, never>>} WorkspaceRef
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
 * @property {number} [renewAfterMs]
 */

/**
 * @typedef WorkspaceLeaseDenied
 * @property {'denied'} kind
 * @property {Exclude<WorkspaceLeaseState, 'owned' | 'unmanaged'>} state
 * @property {string} code
 * @property {string} reason
 */

/** @typedef {WorkspaceLeaseBound | WorkspaceLeaseDenied} WorkspaceLeaseBindResult */

/**
 * @typedef {WorkspaceLeaseBindingFacts & {
 *   bindingId: string,
 *   workspaceId: string,
 *   generation: string,
 *   bindingState: 'owned' | 'unmanaged',
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
 * durable cross-process leases, fencing, reconciliation, and stable reason
 * codes. The runtime-owned plugin supplies only host-authenticated facts.
 * @typedef WorkspaceLeaseProvider
 * @property {typeof WORKSPACE_LEASE_PROTOCOL_VERSION} protocolVersion
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
 * @typedef AgentSlot
 * @property {Agent} agent
 * @property {Agent['session']} session
 * @property {number} epoch
 * @property {SessionStartSource} source
 * @property {AbortController | undefined} bindController
 * @property {Promise<BoundWorkspace> | undefined} attempt
 * @property {BoundWorkspace | undefined} bound
 * @property {WorkspaceRef | undefined} ref
 * @property {boolean} disposed
 */

/**
 * @typedef BoundWorkspace
 * @property {AgentSlot} owner
 * @property {Set<AgentSlot>} owners
 * @property {Agent['session']} session
 * @property {ProviderSlot} provider
 * @property {string} bindingId
 * @property {string} workspaceId
 * @property {string} generation
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
 * @property {ExecutionAuthorization} authorization
 * @property {string} operationId
 * @property {string} fence
 * @property {ToolExecution} exec
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

/** @typedef {ExecutionIdentity & {binding: BoundWorkspace}} ExecutionAuthorization */

/**
 * @typedef WorkspaceRefMeta
 * @property {Agent} agent
 * @property {BoundWorkspace} binding
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
  for (const method of ['bind', 'begin', 'complete', 'renew', 'release']) {
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

/** @param {ExecutionAuthorization} authorization @param {Readonly<ToolExecution>} exec */
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

/** @param {AbortSignal} left @param {AbortSignal} right @returns {FusedSignal} */
function fuseSignals(left, right) {
  const controller = new AbortController()
  const abortLeft = () => { controller.abort(left.reason) }
  const abortRight = () => { controller.abort(right.reason) }
  if (left.aborted) abortLeft()
  else left.addEventListener('abort', abortLeft, { once: true })
  if (right.aborted) abortRight()
  else right.addEventListener('abort', abortRight, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      left.removeEventListener('abort', abortLeft)
      right.removeEventListener('abort', abortRight)
    },
  }
}

/** @param {ToolExecutionResult | undefined} result */
function errorCode(result) {
  return result?.error?.info?.code
}

/**
 * Runtime-kit-owned native workspace authority service. It mints no Git or
 * lease policy: providers classify tools and own canonicalization,
 * persistence, fencing, recovery, and conflicts. The service owns exact DSH
 * lifecycle attribution and pre-body admission.
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
  /** @type {WeakMap<ToolExecution, LeaseOperation>} */
  #executions = new WeakMap()
  /** @type {WeakMap<ToolExecution, ExecutionAuthorization>} */
  #authorizations = new WeakMap()

  /** @param {Context} ctx */
  constructor(ctx) {
    super(ctx, 'workspaceLease')

    // Cordis presents services through a scoped Proxy. Bind the public methods
    // to the concrete instance so native private state stays inaccessible while
    // calls through ctx.workspaceLease still carry the correct receiver.
    this.registerProvider = this.registerProvider.bind(this)
    this.ref = this.ref.bind(this)
    this.state = this.state.bind(this)

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
    })
  }

  /**
   * Register the one trusted provider. Its disposer aborts and drains exact
   * operations before releasing the binding generations it owns.
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
      for (const agentSlot of this.#liveSlots) {
        this.#startBinding(agentSlot, agentSlot.source)
      }
      return async () => {
        slot.stopping = true
        const lifecycleCause = unavailable('workspace lease provider is stopping')
        const attempts = []
        for (const agentSlot of this.#liveSlots) {
          agentSlot.bindController?.abort(lifecycleCause)
          if (agentSlot.attempt !== undefined) attempts.push(agentSlot.attempt)
        }

        const attemptResults = await Promise.allSettled(attempts)
        const releaseResults = await Promise.allSettled(
          [...slot.bindings].map(binding => this.#releaseBinding(binding, 'provider-disposed')),
        )

        for (const agentSlot of this.#liveSlots) this.#installUnavailableAttempt(agentSlot)

        /** @type {unknown[]} */
        const failures = []
        for (const result of attemptResults) {
          if (result.status === 'rejected'
            && result.reason instanceof WorkspaceLeaseError
            && result.reason.code === WORKSPACE_LEASE_RELEASE_FAILED) {
            failures.push(result.reason)
          }
        }
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
   * Resolve the opaque reference for one exact live Agent.
   * @param {Agent} agent
   * @returns {Promise<WorkspaceRef>}
   */
  async ref(agent) {
    this.#assertLive(agent)
    const slot = this.#agentSlots.get(agent)
    if (slot?.attempt === undefined) {
      throw new WorkspaceLeaseError(
        'workspace identity is not bound: agent/session-start has not established a lifecycle',
        WORKSPACE_LEASE_UNBOUND,
        'unavailable',
      )
    }
    const binding = await slot.attempt
    if (slot.bound !== binding
      || agent.session !== slot.session
      || !binding.owners.has(slot)
      || binding.released
      || binding.failure !== undefined) {
      throw binding.failure ?? new WorkspaceLeaseInvalidRefError()
    }
    if (slot.ref === undefined) throw new WorkspaceLeaseInvalidRefError()
    return slot.ref
  }

  /**
   * Return state only after validating the exact Agent/ref pairing.
   * @param {Agent} agent
   * @param {WorkspaceRef} ref
   * @returns {WorkspaceLeaseState}
   */
  state(agent, ref) {
    this.#assertLive(agent)
    const meta = this.#refs.get(ref)
    const slot = this.#agentSlots.get(agent)
    if (meta === undefined
      || meta.agent !== agent
      || slot === undefined
      || !meta.binding.owners.has(slot)
      || agent.session !== slot.session
      || slot.bound !== meta.binding
      || meta.binding.released) {
      throw new WorkspaceLeaseInvalidRefError()
    }
    return meta.binding.failure?.state ?? meta.binding.initialState
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
        bindController: undefined,
        attempt: undefined,
        bound: undefined,
        ref: undefined,
        disposed: false,
      }
      this.#agentSlots.set(agent, slot)
      this.#liveSlots.add(slot)
      const exact = slot
      agent.ctx.effect(() => async () => {
        exact.disposed = true
        exact.epoch += 1
        exact.bindController?.abort(unavailable('workspace lease binding owner was disposed'))
        const pending = exact.attempt
        /** @type {BoundWorkspace | undefined} */
        let binding
        try {
          try {
            binding = await pending
          } catch (error) {
            if (error instanceof WorkspaceLeaseError
              && error.code === WORKSPACE_LEASE_RELEASE_FAILED) throw error
            // An unbound lifecycle owns no authority to release.
          }
          if (binding !== undefined) {
            if (binding.owner === exact) {
              await this.#releaseBinding(binding, 'agent-disposed')
            } else {
              this.#detachOwner(binding, exact)
            }
          }
        } finally {
          exact.bound = undefined
          exact.ref = undefined
          this.#liveSlots.delete(exact)
        }
      }, 'workspaceLease.agentBinding()')
    }
    slot.session = agent.session
    slot.source = source
    this.#startBinding(slot, source)
  }

  /**
   * A child created by this exact DSH runtime may share its live ancestor's
   * provider binding only when the immutable session lineage and cwd agree.
   * Independent top-level sessions still reach the provider and contend on
   * the canonical workspace lease.
   * @param {AgentSlot} slot
   */
  #parentSlot(slot) {
    const parentSession = slot.session.header.parentSession
    if (parentSession === undefined) return undefined
    for (const candidate of this.#liveSlots) {
      if (candidate === slot || candidate.disposed) continue
      if (candidate.session.header.id === parentSession
        && candidate.session.header.cwd === slot.session.header.cwd) return candidate
    }
    return undefined
  }

  /** @param {BoundWorkspace} binding @param {AgentSlot} slot */
  #attachOwner(binding, slot) {
    const ref = /** @type {WorkspaceRef} */ (Object.freeze(Object.create(null)))
    binding.owners.add(slot)
    slot.bound = binding
    slot.ref = ref
    this.#refs.set(ref, { agent: slot.agent, binding })
  }

  /** @param {BoundWorkspace} binding @param {AgentSlot} slot */
  #detachOwner(binding, slot) {
    binding.owners.delete(slot)
    if (slot.ref !== undefined) this.#refs.delete(slot.ref)
    slot.ref = undefined
    if (slot.bound === binding) slot.bound = undefined
  }

  /** @param {AgentSlot} slot @param {SessionStartSource} source */
  #startBinding(slot, source) {
    if (slot.disposed) return
    const epoch = ++slot.epoch
    const previous = slot.attempt
    if (slot.ref !== undefined) this.#refs.delete(slot.ref)
    slot.ref = undefined
    slot.bindController?.abort(unavailable('workspace lease session lifecycle was rebound'))
    const controller = new AbortController()
    slot.bindController = controller
    slot.bound = undefined
    const session = slot.session
    const parent = this.#parentSlot(slot)
    /** @type {{slot: AgentSlot, epoch: number, session: Agent['session']}[]} */
    const dependents = []

    const attempt = (async () => {
      if (previous !== undefined) {
        /** @type {BoundWorkspace | undefined} */
        let prior
        try {
          prior = await previous
        } catch (error) {
          if (error instanceof WorkspaceLeaseError
            && error.code === WORKSPACE_LEASE_RELEASE_FAILED) throw error
          // A failed or aborted prior bind owns no usable authority.
        }
        if (prior !== undefined) {
          if (prior.owner === slot) {
            for (const owner of prior.owners) {
              if (owner !== slot) {
                dependents.push({ slot: owner, epoch: owner.epoch, session: owner.session })
              }
            }
            await this.#releaseBinding(prior, 'session-rebound')
          } else this.#detachOwner(prior, slot)
        }
      }
      if (slot.disposed || slot.epoch !== epoch) {
        throw unavailable('workspace lease binding lifecycle changed before bind')
      }
      if (parent !== undefined) {
        const parentAttempt = parent.attempt
        if (parentAttempt === undefined) {
          throw unavailable('workspace lease parent authority is unavailable')
        }
        const binding = await parentAttempt
        if (slot.disposed
          || slot.epoch !== epoch
          || parent.disposed
          || parent.bound !== binding
          || binding.released
          || binding.failure !== undefined
          || binding.provider.stopping) {
          throw binding.failure ?? unavailable('workspace lease parent authority is unavailable')
        }
        this.#attachOwner(binding, slot)
        return binding
      }
      const provider = this.#provider
      if (provider === undefined || provider.stopping) {
        throw unavailable('workspace lease provider is unavailable')
      }
      const agent = slot.agent
      /** @type {WorkspaceLeaseBindResult} */
      let result
      try {
        result = await provider.provider.bind({
          ...bindingFacts(session),
          requestId: requestId(),
          ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
          source,
        }, controller.signal)
      } catch (error) {
        throw error instanceof WorkspaceLeaseError
          ? error
          : unavailable('workspace lease provider failed to bind the session', error)
      }
      assertProviderResult(result, 'bind')
      if (result.kind === 'denied') throw providerError(result)
      if (result.kind !== 'bound') {
        throw unavailable('workspace lease provider returned an invalid bind result')
      }
      if (result.state !== 'owned' && result.state !== 'unmanaged') {
        throw unavailable('workspace lease provider returned an invalid bound state')
      }
      /** @type {BoundWorkspace} */
      const binding = {
        owner: slot,
        owners: new Set([slot]),
        session,
        provider,
        bindingId: nonEmpty(result.bindingId, 'bindingId'),
        workspaceId: nonEmpty(result.workspaceId, 'workspaceId'),
        generation: nonEmpty(result.generation, 'generation'),
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
      if (this.#bindingLifecycleChanged(slot, epoch, provider, session)) {
        await this.#releaseBinding(binding, this.#releaseReason(slot))
        throw unavailable('workspace lease binding lifecycle changed after bind')
      }
      this.#attachOwner(binding, slot)
      for (const dependent of dependents) {
        if (dependent.slot.disposed
          || dependent.slot.epoch !== dependent.epoch
          || dependent.slot.session !== dependent.session
          || dependent.slot.agent.session !== dependent.session
          || dependent.session.header.cwd !== session.header.cwd) continue
        this.#attachOwner(binding, dependent.slot)
        dependent.slot.attempt = Promise.resolve(binding)
      }
      this.#armRenewal(binding)
      return binding
    })()
    slot.attempt = attempt
    void attempt.catch(() => {})
  }

  /** @param {AgentSlot} slot */
  #installUnavailableAttempt(slot) {
    slot.epoch += 1
    slot.bindController?.abort(unavailable('workspace lease provider was disposed'))
    slot.bound = undefined
    const attempt = /** @type {Promise<BoundWorkspace>} */ (
      Promise.reject(unavailable('workspace lease provider is unavailable'))
    )
    slot.attempt = attempt
    void attempt.catch(() => {})
  }

  /**
   * @param {AgentSlot} slot
   * @param {number} epoch
   * @param {ProviderSlot} provider
   * @param {Agent['session']} session
   */
  #bindingLifecycleChanged(slot, epoch, provider, session) {
    return slot.disposed
      || slot.epoch !== epoch
      || slot.session !== session
      || slot.agent.session !== session
      || provider.stopping
  }

  /** @param {AgentSlot} slot @returns {'agent-disposed' | 'session-rebound'} */
  #releaseReason(slot) {
    return slot.disposed ? 'agent-disposed' : 'session-rebound'
  }

  /**
   * @param {ToolExecution} exec
   * @param {() => Promise<PreToolDecision>} next
   * @returns {Promise<PreToolDecision>}
   */
  async #preExecute(exec, next) {
    const downstream = await next()
    if ((downstream.kind !== 'allow' && downstream.kind !== 'ask')
      || exec.agent === undefined
      || exec.signal.aborted) {
      return downstream
    }
    const agent = exec.agent
    const identity = executionIdentity(exec, agent)
    const slot = this.#agentSlots.get(agent)
    if (slot?.attempt === undefined) {
      throw new WorkspaceLeaseError(
        'workspace identity is unavailable for this agent lifecycle',
        WORKSPACE_LEASE_UNAVAILABLE,
        'unavailable',
      )
    }
    const binding = await slot.attempt
    const authorization = { ...identity, binding }
    if (slot.bound !== binding
      || !binding.owners.has(slot)
      || agent.session !== slot.session
      || !matchesExecution(authorization, exec)
      || binding.released) throw new WorkspaceLeaseInvalidRefError()
    if (binding.failure !== undefined) throw binding.failure
    if (binding.provider.stopping) throw unavailable('workspace lease provider is stopping')

    const admission = deferred()
    binding.admissions.add(admission.promise)
    this.#syncRenewalTimerRef(binding)
    const admissionSignal = fuseSignals(identity.signal, binding.lifecycle.signal)
    try {
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
          callId: identity.callId,
          rootCallId: identity.rootCallId,
          toolName: identity.toolName,
          arguments: identity.arguments,
          nested: identity.parent !== undefined,
        }, admissionSignal.signal)
      } catch (error) {
        if (binding.failure !== undefined) throw binding.failure
        if (binding.released || binding.provider.stopping || binding.lifecycle.signal.aborted) {
          throw unavailable('workspace lease admission lost lifecycle authority')
        }
        throw error instanceof WorkspaceLeaseError
          ? error
          : unavailable('workspace lease provider failed before tool dispatch', error)
      }

      assertProviderResult(result, 'begin')
      const lifecycleChanged = binding.released
        || binding.failure !== undefined
        || binding.provider.stopping
        || slot.bound !== binding
        || !binding.owners.has(slot)
        || agent.session !== slot.session
        || !matchesExecution(authorization, exec)
        || admissionSignal.signal.aborted
      if (result.kind === 'not-required') {
        if (lifecycleChanged) {
          throw binding.failure ?? unavailable('workspace lease admission lost lifecycle authority')
        }
        this.#authorizations.set(exec, authorization)
        return downstream
      }
      if (result.kind === 'denied') throw providerError(result)
      if (result.kind !== 'granted') {
        throw unavailable('workspace lease provider returned an invalid begin result')
      }

      const done = deferred()
      /** @type {LeaseOperation} */
      const operation = {
        binding,
        authorization,
        operationId: nonEmpty(result.operationId, 'operationId'),
        fence: nonEmpty(result.fence, 'fence'),
        exec,
        authority: new AbortController(),
        completion: new AbortController(),
        settled: done.promise,
        settle: done.resolve,
        completing: false,
      }
      binding.operations.add(operation)
      this.#executions.set(exec, operation)
      if (lifecycleChanged) {
        const outcome = identity.signal.aborted || binding.lifecycle.signal.aborted
          ? 'cancelled'
          : 'failed'
        await this.#completeOperation(operation, outcome)
        throw binding.failure ?? unavailable('workspace lease admission lost lifecycle authority')
      }
      this.#authorizations.set(exec, authorization)
      return downstream
    } finally {
      admissionSignal.dispose()
      binding.admissions.delete(admission.promise)
      admission.resolve()
      this.#syncRenewalTimerRef(binding)
    }
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
    const { binding } = authorization
    const slot = this.#agentSlots.get(authorization.agent)
    if (!matchesExecution(authorization, exec)
      || slot === undefined
      || !binding.owners.has(slot)
      || slot.bound !== binding
      || authorization.agent.session !== slot.session
      || binding.released
      || binding.failure !== undefined
      || binding.provider.stopping) {
      return changedAuthorizationReason
    }
    return undefined
  }

  /**
   * @param {ToolDispatchExecution} exec
   * @param {() => Promise<ToolExecutionResult>} next
   * @returns {Promise<ToolExecutionResult>}
   */
  async #execute(exec, next) {
    const operation = this.#executions.get(exec)
    if (operation === undefined) return next()
    const originalSignal = exec.signal
    const fused = fuseSignals(originalSignal, operation.authority.signal)
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
      await this.#completeOperation(operation, outcome, errorCode(result))
    }
  }

  /**
   * Complete an acquired operation when a guard or another pre-body boundary
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
      const operation = this.#executions.get(exec)
      if (operation !== undefined) {
        /** @type {WorkspaceLeaseOperationOutcome} */
        const outcome = exec.signal.aborted
          ? 'cancelled'
          : thrown || result.isError || decision?.kind === 'block' ? 'failed' : 'succeeded'
        await this.#completeOperation(operation, outcome, errorCode(result))
      }
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
    const { authorization, binding, exec } = operation
    try {
      await binding.provider.provider.complete({
        ...bindingFacts(binding.session),
        requestId: requestId(),
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        generation: binding.generation,
        operationId: operation.operationId,
        fence: operation.fence,
        callId: authorization.callId,
        rootCallId: authorization.rootCallId,
        toolName: authorization.toolName,
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
      this.#authorizations.delete(exec)
      this.#executions.delete(exec)
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

  /** @param {BoundWorkspace} binding @param {WorkspaceLeaseError} failure */
  #markLost(binding, failure) {
    if (binding.failure !== undefined || binding.released) return
    binding.failure = failure
    if (binding.renewTimer !== undefined) clearTimeout(binding.renewTimer)
    binding.renewTimer = undefined
    binding.lifecycle.abort(failure)
    for (const operation of binding.operations) operation.authority.abort(failure)
    if (binding.operations.size > 0) {
      for (const owner of new Set(
        [...binding.operations].map(operation => operation.authorization.agent),
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

  /** @param {BoundWorkspace} binding @param {WorkspaceLeaseReleaseReason} reason */
  async #releaseBinding(binding, reason) {
    if (binding.releaseTask !== undefined) return binding.releaseTask
    const releaseTask = (async () => {
      binding.released = true
      for (const owner of [...binding.owners]) this.#detachOwner(binding, owner)
      if (binding.renewTimer !== undefined) clearTimeout(binding.renewTimer)
      binding.renewTimer = undefined
      const releaseCause = unavailable(`workspace lease binding is releasing (${reason})`)
      binding.lifecycle.abort(releaseCause)
      binding.renewController?.abort(releaseCause)
      for (const operation of binding.operations) {
        operation.authority.abort(releaseCause)
        operation.completion.abort(releaseCause)
      }
      if (binding.operations.size > 0) {
        for (const owner of new Set(
          [...binding.operations].map(operation => operation.authorization.agent),
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
