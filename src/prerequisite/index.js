// @ts-check

import { randomUUID } from 'node:crypto'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolRunContext} ToolRunContext */

const PROJECT_DEV_CAPABILITY = 'project-dev-context'
const PROJECT_DEV_INTENT = 'project-dev'
const DEFAULT_PROJECT_DEV_TOOLS = Object.freeze([
  'bash',
  'write',
  'edit',
  'str_replace_editor',
  'runtime_kit_governed_commit',
])

/** @param {unknown} definition */
function validDefinition(definition) {
  return definition !== null
    && typeof definition === 'object'
    && typeof /** @type {Record<string, unknown>} */ (definition).name === 'string'
}

/**
 * Runtime-kit provider for DSH's execution-bound prerequisite seam. Begin and
 * last-mile verification are side-effect free. DSH invokes durable commit only
 * after the exact body and the complete post-execute waterfall have succeeded.
 *
 * @param {Context} ctx
 * @param {{beginPrerequisite(exec: ToolExecution, intent: string, binding: ExecutionBinding): Promise<any>, commitPrerequisite(exec: ToolExecution, pending: {intent: string, phase: string, receipt: string, binding: ExecutionBinding}): Promise<any>}} client
 * @param {(input: any) => import('@deepseek-ai/dsh-llm').UserMessage} createUserMessage
 * @param {(exec: ToolExecution, correlation: ToolCorrelation, proof: PrerequisiteProof) => Promise<{kind?: string, context?: string, reason?: string} | undefined>} revalidatePolicy
 */
export function createPrerequisiteCoordinator(ctx, client, createUserMessage, revalidatePolicy) {
  /** @type {WeakMap<ToolDefinition, RequirementRegistration>} */
  let requirements = new WeakMap()
  /** @type {Map<string, string>} */
  const namedRequirements = new Map(
    DEFAULT_PROJECT_DEV_TOOLS.map(name => [name, PROJECT_DEV_CAPABILITY]),
  )
  /** @type {WeakMap<ToolDefinition, string>} */
  let definitionIds = new WeakMap()
  /** @type {WeakMap<Agent, string>} */
  let agentIds = new WeakMap()
  /** @type {Map<Readonly<ToolExecution>, PendingPrerequisite>} */
  const pending = new Map()
  const workspaceGeneration = `workspace:${randomUUID()}`
  let open = true

  /** @param {ToolDefinition} definition */
  function definitionId(definition) {
    let id = definitionIds.get(definition)
    if (id === undefined) {
      id = `definition:${randomUUID()}`
      definitionIds.set(definition, id)
    }
    return id
  }

  /** @param {Agent} agent */
  function agentId(agent) {
    let id = agentIds.get(agent)
    if (id === undefined) {
      id = `agent:${randomUUID()}`
      agentIds.set(agent, id)
    }
    return id
  }

  /** @param {Readonly<ToolExecution>} exec */
  function visibleDefinition(exec) {
    if (typeof ctx.tools.get !== 'function') {
      throw new Error('dsh-runtime-kit:prerequisite-native-seam-unavailable')
    }
    return ctx.tools.get(exec.name, exec.agent)
  }

  /** @param {Readonly<ToolExecution>} exec */
  function requirement(exec) {
    const definition = visibleDefinition(exec)
    if (definition === undefined) return undefined
    const registration = requirements.get(definition)
    const capability = registration?.capability ?? namedRequirements.get(exec.name)
    return capability === undefined
      ? undefined
      : { capability, definition, registration }
  }

  /** @param {Readonly<ToolExecution>} exec @param {PendingPrerequisite} record */
  function recordMismatch(exec, record) {
    const requirementCurrent = record.registration === undefined
      ? namedRequirements.get(record.binding.toolName) === record.capability
      : requirements.get(record.definition) === record.registration
    if (!open) return 'registry-closed'
    if (!requirementCurrent) return 'requirement-changed'
    if (visibleDefinition(exec) !== record.definition) return 'definition-changed'
    if (exec.token !== record.token) return 'token-changed'
    if (exec.callId !== record.binding.callId) return 'call-changed'
    if (exec.rootCallId !== record.rootCallId) return 'root-call-changed'
    if (exec.name !== record.binding.toolName) return 'tool-changed'
    if (exec.arguments !== record.arguments) return 'arguments-changed'
    if (exec.parent !== record.parent) return 'parent-changed'
    if (exec.agent === undefined) return 'agent-missing'
    if (exec.agent !== record.agent) return 'agent-changed'
    if (agentId(exec.agent) !== record.binding.agentId) return 'agent-changed'
    if (exec.agent.session !== record.session) return 'session-changed'
    if (exec.agent.session.header !== record.sessionHeader) return 'session-header-changed'
    if (exec.agent.session.header.id !== record.correlation.sessionId) return 'session-id-changed'
    if (exec.agent.session.header.cwd !== record.correlation.cwd) return 'cwd-changed'
    return undefined
  }

  /** @param {Readonly<ToolExecution>} exec @param {PendingPrerequisite} record */
  function requireMatchingRecord(exec, record) {
    const mismatch = recordMismatch(exec, record)
    if (mismatch !== undefined) {
      pending.delete(exec)
      throw new Error(`dsh-runtime-kit:prerequisite-binding-invalid:${mismatch}`)
    }
  }

  /**
   * @param {ToolRunContext} exec
   * @param {PendingPrerequisite} record
   * @param {'dispatch' | 'body'} phase
   */
  async function beforeBody(exec, record, phase) {
    if (phase !== 'dispatch' && phase !== 'body') {
      pending.delete(exec)
      throw new Error('dsh-runtime-kit:prerequisite-binding-invalid:phase')
    }
    if (exec.signal.aborted) {
      pending.delete(exec)
      throw new Error('dsh-runtime-kit:prerequisite-binding-invalid:cancelled')
    }
    requireMatchingRecord(exec, record)
    let verified
    let policyDecision
    try {
      verified = await client.beginPrerequisite(exec, record.intent, record.binding)
      if (typeof verified.receipt !== 'string') {
        throw new Error('dsh-runtime-kit:prerequisite-decision-invalid')
      }
      if (phase === 'body') {
        policyDecision = await revalidatePolicy(exec, record.correlation, {
          agentId: record.binding.agentId,
          workspaceGeneration: record.binding.workspaceGeneration,
          definitionId: record.binding.definitionId,
          receipt: verified.receipt,
        })
      }
    } catch {
      pending.delete(exec)
      throw new Error('dsh-runtime-kit:prerequisite-verification-failed')
    }
    if (exec.signal.aborted) {
      pending.delete(exec)
      throw new Error('dsh-runtime-kit:prerequisite-binding-invalid')
    }
    if (policyDecision?.kind === 'deny') {
      pending.delete(exec)
      throw new Error(
        typeof policyDecision.reason === 'string' && policyDecision.reason.length > 0
          ? policyDecision.reason
          : 'dsh-runtime-kit:prerequisite-binding-invalid',
      )
    }
    requireMatchingRecord(exec, record)
    record.receipt = verified.receipt
    record.documents = verified.reason === 'pending' ? verified.documents : []
    record.verified = true
    const contexts = []
    if (record.documents.length > 0) {
      contexts.push(createUserMessage({
        content: record.documents.map(document => ({
          type: /** @type {const} */ ('text'),
          text: document.content,
        })),
        source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
      }))
    }
    return contexts
  }

  /** @param {Readonly<ToolExecution>} exec @param {PendingPrerequisite} record */
  async function commit(exec, record) {
    // DSH owns original-caller cancellation and invokes commit only after
    // successful completion has linearized. At this point exec.signal may be
    // the restored tools/execute wrapper signal, not the immutable caller
    // signal, so treating it as caller cancellation would reject valid work.
    if (!record.verified) {
      pending.delete(exec)
      throw new Error('dsh-runtime-kit:prerequisite-binding-invalid:not-verified')
    }
    requireMatchingRecord(exec, record)
    // DSH has linearized successful completion before invoking this hook.
    // Detach only caller cancellation; the client still owns timeout,
    // disposal, quiescence, and fail-closed admission.
    const completionExec = /** @type {ToolExecution} */ ({
      ...exec,
      signal: new AbortController().signal,
    })
    let committed
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        committed = await client.commitPrerequisite(completionExec, {
          intent: record.intent,
          phase: record.phase,
          receipt: record.receipt,
          binding: record.binding,
        })
        break
      } catch {}
    }
    if (committed === undefined) {
      // The exact receipt is idempotent, so retry it once. If both bounded
      // attempts remain uncertain, keep the already-finalized mutation and its
      // pre-body verified context; the next call revalidates this cache state.
      try {
        ctx.logger?.warn?.('prerequisite cache completion remained uncertain after bounded reconciliation')
      } catch {}
      return
    }
    record.committed = true
  }

  const service = Object.freeze({
    /**
     * Declare a prerequisite for one exact ToolDefinition. The returned
     * disposer cannot remove a later replacement declaration.
     * @param {ToolDefinition} definition
     * @param {string} capability
     */
    require(definition, capability) {
      if (!open) throw new Error('dsh-runtime-kit:prerequisite-registry-disposed')
      if (!validDefinition(definition)) {
        throw new TypeError('dsh-runtime-kit: prerequisite definition must be a DSH tool')
      }
      if (capability !== PROJECT_DEV_CAPABILITY) {
        throw new TypeError('dsh-runtime-kit: unsupported prerequisite capability')
      }
      const registration = Object.freeze({ capability })
      requirements.set(definition, registration)
      return () => {
        if (requirements.get(definition) === registration) requirements.delete(definition)
      }
    },
  })

  return Object.freeze({
    service,

    // Native DSH owns definition binding; attachment remains a compatibility no-op.
    /** @param {Agent} _agent */
    attachAgent(_agent) {},
    /** @param {Agent} _agent */
    detachAgent(_agent) {},
    /** @param {ToolExecution} _exec */
    prepare(_exec) {},

    /**
     * @param {ToolExecution} exec
     * @param {{sessionId: string, cwd: string, turn: number, step: number, callId: string, name: string}} correlation
     */
    async begin(exec, correlation) {
      if (!open) throw new Error('dsh-runtime-kit:prerequisite-registry-disposed')
      const required = requirement(exec)
      if (required === undefined) return undefined
      if (required.capability !== PROJECT_DEV_CAPABILITY
        || exec.agent === undefined
        || correlation.callId !== exec.callId
        || correlation.name !== exec.name) {
        throw new Error('dsh-runtime-kit:prerequisite-binding-invalid')
      }
      /** @type {ExecutionBinding} */
      const binding = Object.freeze({
        agentId: agentId(exec.agent),
        workspaceGeneration,
        callId: correlation.callId,
        turn: correlation.turn,
        step: correlation.step,
        toolName: correlation.name,
        definitionId: definitionId(required.definition),
      })
      const decision = await client.beginPrerequisite(exec, PROJECT_DEV_INTENT, binding)
      if (typeof decision.receipt !== 'string') {
        throw new Error('dsh-runtime-kit:prerequisite-decision-invalid')
      }
      /** @type {PendingPrerequisite} */
      const record = {
        intent: PROJECT_DEV_INTENT,
        phase: 'edit',
        capability: required.capability,
        registration: required.registration,
        binding,
        token: exec.token,
        rootCallId: exec.rootCallId,
        arguments: exec.arguments,
        agent: exec.agent,
        session: exec.agent.session,
        sessionHeader: exec.agent.session.header,
        parent: exec.parent,
        correlation: Object.freeze({ ...correlation }),
        definition: required.definition,
        receipt: decision.receipt,
        documents: decision.reason === 'pending' ? decision.documents : [],
      }
      pending.set(exec, record)
      try {
        const tools = /** @type {Context['tools'] & {bindPrerequisite?: Function}} */ (ctx.tools)
        if (typeof tools.bindPrerequisite !== 'function') {
          throw new Error('dsh-runtime-kit:prerequisite-native-seam-unavailable')
        }
        tools.bindPrerequisite(exec, required.definition, Object.freeze({
          beforeBody: (/** @type {ToolRunContext} */ runtimeExec, /** @type {'dispatch' | 'body'} */ phase) => (
            beforeBody(runtimeExec, record, phase)
          ),
          commit: (/** @type {Readonly<ToolExecution>} */ runtimeExec) => commit(runtimeExec, record),
        }))
      } catch (error) {
        pending.delete(exec)
        throw error
      }
      return {
        agentId: binding.agentId,
        workspaceGeneration: binding.workspaceGeneration,
        definitionId: binding.definitionId,
        receipt: decision.receipt,
      }
    },

    /** @param {Readonly<ToolExecution>} exec */
    reject(exec) { pending.delete(exec) },
    /** @param {Readonly<ToolExecution>} exec */
    result(exec) { pending.delete(exec) },

    get pending() { return pending.size },

    dispose() {
      open = false
      pending.clear()
      requirements = new WeakMap()
      definitionIds = new WeakMap()
      agentIds = new WeakMap()
    },
  })
}

/**
 * @typedef ExecutionBinding
 * @property {string} agentId
 * @property {string} workspaceGeneration
 * @property {string} callId
 * @property {number} turn
 * @property {number} step
 * @property {string} toolName
 * @property {string} definitionId
 */

/**
 * @typedef ToolCorrelation
 * @property {string} sessionId
 * @property {string} cwd
 * @property {number} turn
 * @property {number} step
 * @property {string} callId
 * @property {string} name
 */

/**
 * @typedef PrerequisiteProof
 * @property {string} agentId
 * @property {string} workspaceGeneration
 * @property {string} definitionId
 * @property {string} receipt
 */

/**
 * @typedef RequirementRegistration
 * @property {string} capability
 */

/**
 * @typedef PendingPrerequisite
 * @property {string} intent
 * @property {string} phase
 * @property {string} capability
 * @property {RequirementRegistration | undefined} registration
 * @property {ExecutionBinding} binding
 * @property {ToolExecution['token']} token
 * @property {ToolExecution['rootCallId']} rootCallId
 * @property {unknown} arguments
 * @property {Agent} agent
 * @property {Agent['session']} session
 * @property {Agent['session']['header']} sessionHeader
 * @property {ToolExecution['parent']} parent
 * @property {ToolCorrelation} correlation
 * @property {ToolDefinition} definition
 * @property {string} receipt
 * @property {Array<{source: string, scope: string, content: string}>} documents
 * @property {boolean} [verified]
 * @property {boolean} [committed]
 */
