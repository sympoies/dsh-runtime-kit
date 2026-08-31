import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  createBodyExecutionCounter,
  validationBodyExecutions,
} from './body-execution-counter.js'
import { observableChildPid } from './observable-child-pid.js'
import {
  createScenarioCanaryDeadlineController,
  createScenarioCanaryProgressReporter,
  prepareScenarioCanaryGoal,
  registerScenarioCanaryAgentSettlementProgress,
  registerScenarioCanaryTurnStoppingProgress,
  SCENARIO_CANARY_DEADLINE_ENV,
  SCENARIO_CANARY_MARKER,
  SCENARIO_CANARY_PROGRESS,
  scenarioCanaryServices,
  startScenarioCanaryWhenReady,
} from './receipt-output.js'

export const name = 'dsh-authoritative-acceptance-canary'
const phase = process.env.DSH_ACCEPTANCE_PHASE ?? 'positive'
export const inject = scenarioCanaryServices(phase)

const marker = SCENARIO_CANARY_MARKER
const sessionId = process.env.DSH_ACCEPTANCE_SESSION_ID ?? 'authoritative-acceptance-canary'
const workspace = process.env.DSH_ACCEPTANCE_WORKSPACE
const processInstance = process.env.DSH_ACCEPTANCE_PROCESS_INSTANCE_SHA256
const workspaceSha = process.env.DSH_ACCEPTANCE_WORKSPACE_SHA256
const validationCommand = process.env.DSH_ACCEPTANCE_VALIDATION_COMMAND
const validationMarker = process.env.DSH_ACCEPTANCE_VALIDATION_MARKER
const validationToken = process.env.DSH_ACCEPTANCE_VALIDATION_TOKEN
const cancellationCommand = process.env.DSH_ACCEPTANCE_CANCELLATION_COMMAND
const cancellationMarker = process.env.DSH_ACCEPTANCE_CANCELLATION_MARKER
const cancellationPid = process.env.DSH_ACCEPTANCE_CANCELLATION_PID
const cancellationHeartbeat = process.env.DSH_ACCEPTANCE_CANCELLATION_HEARTBEAT
const crashMarker = process.env.DSH_ACCEPTANCE_CRASH_MARKER
const providerProbePath = process.env.DSH_ACCEPTANCE_PROVIDER_PROBE_PATH

function digest(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(label + ' is required')
  return value
}

function call(name, args, suffix) {
  const id = CallId('authoritative-acceptance-' + suffix)
  const serialized = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name, arguments: serialized },
    },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function stop(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function validation(suffix = 'validation') {
  return call('bash', {
    command: required(validationCommand, 'validation command'),
    description: 'run the exact acceptance validator',
  }, suffix)
}

function cancellation() {
  return call('bash', {
    command: required(cancellationCommand, 'cancellation command'),
    description: 'start the cancellable contained validator',
  }, 'cancellable-validation')
}

function mutation(suffix = 'mutation') {
  return call('write', {
    file_path: '.authoritative-acceptance-mutation',
    content: 'mutation\n',
  }, suffix)
}

class CanaryAdapter extends LlmAdapter {
  calls = 0
  modelCalls = 0

  constructor(planner) {
    super()
    this.planner = planner
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.modelCalls += 1
    this.calls += 1
    const chunks = this.planner()
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('canary adapter aborted')
      yield chunk
    }
  }
}

function verdictView(value) {
  return value === undefined
    ? undefined
    : { action: value.action, aggregate: value.aggregate }
}

function goalView(goal, events) {
  return goal === undefined
    ? undefined
    : { phase: goal.phase, revision: goal.revision, event_count: events.length }
}

function goalRoundFollowups(agent) {
  const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    .filter(message => message.source?.kind === 'goal' && message.source.round > 0)
  const admitted = agent.session.events
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)
  return queued.length + admitted.length
}

function resources(ctx) {
  const runtimeKit = ctx.get('dshRuntimeKit')
  return {
    acceptance_operations: runtimeKit?.activeAcceptanceOperations ?? 0,
    finish_line_requests: runtimeKit?.activeFinishLineRequests ?? 0,
    finish_line_reservations: runtimeKit?.activeFinishLineReservations ?? 0,
    pending_correlations: runtimeKit?.pendingCorrelations ?? 0,
  }
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for ' + label)
}

async function prepareScenarioCanaryGoalAtDriverCheckpoint(ctx, agent) {
  let entered = false
  let release
  const released = new Promise(resolve => { release = resolve })
  const stopObserving = ctx.on('session/flush', async session => {
    if (session !== agent.session || entered) return
    entered = true
    await released
  })
  try {
    const goal = prepareScenarioCanaryGoal(ctx.goals, agent)
    await waitUntil(() => entered, 'goal-round driver durability checkpoint')
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    if (goalRoundFollowups(agent) !== 0) {
      throw new Error('disarmed canary goal queued an automatic round')
    }
    return goal
  } finally {
    release()
    stopObserving()
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export function apply(ctx) {
  if (phase === 'provider-mismatch-probe') {
    const path = required(providerProbePath, 'provider probe path')
    const state = {
      schema_version: 'dsh-runtime-kit.provider-mismatch-probe.v1',
      loaded: true,
      model_calls: 0,
      session_starts: 0,
    }
    const persist = () => writeFileSync(path, JSON.stringify(state) + '\n', { mode: 0o600 })
    persist()
    ctx.llm.registerAdapter(['authoritative-acceptance-probe'], new class extends LlmAdapter {
      resolveModel(provider, model) {
        return Promise.resolve({ provider, id: model, name: model })
      }

      async *stream() {
        state.model_calls += 1
        persist()
        yield * stop('provider mismatch probe model must not run')
      }
    }())
    ctx.on('agent/session-start', () => {
      state.session_starts += 1
      persist()
    })
    return
  }
  const acceptanceRequired = ![
    'baseline-seed',
    'baseline-seed-validation',
    'baseline-rollback',
    'baseline-rollback-validation',
    'unpatched-smoke',
  ].includes(phase)
  rmSync(required(validationMarker, 'validation marker'), { force: true })
  let handle
  let resumedHandle
  let receipt
  const progress = createScenarioCanaryProgressReporter({
    phase,
    processInstance,
    stream: process.stderr,
  })
  const deadlineController = createScenarioCanaryDeadlineController({
    deadlineEpoch: process.env[SCENARIO_CANARY_DEADLINE_ENV],
    stream: process.stdout,
    reportFailure: error => process.stderr.write(String(error?.stack ?? error) + '\n'),
    dispose: async () => {
      try { await resumedHandle?.dispose() } catch {}
      try { await handle?.dispose() } catch {}
    },
    successStatus: () => process.exitCode ?? 0,
    setExitCode: status => { process.exitCode = status },
    exit: status => ctx.get('appExit')?.(status),
    onDeadline: () => progress.reportDeadline(),
    onUnhandledFailure: error => {
      process.exitCode = 1
      process.stderr.write(String(error?.stack ?? error) + '\n')
    },
  })
  const sequence = []
  const bodyExecutions = createBodyExecutionCounter()
  let maxConcurrentBodies = 0
  let activeBodies = 0
  let hostValidationExecutions = 0
  let mutationExecutions = 0
  const hostValidator = defineTool({
    name: 'canary_host_validator',
    description: 'record exact host-observed acceptance evidence',
    parameters: {},
    isConcurrencySafe: true,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      bodyExecutions.bodyExecuted()
      hostValidationExecutions += 1
      return 'validated'
    },
  })
  const mutationDefinition = defineTool({
    name: 'canary_mutation',
    description: 'hold one repository mutation at its body barrier',
    parameters: { label: { type: 'string' } },
    isConcurrencySafe: true,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      bodyExecutions.bodyExecuted()
      mutationExecutions += 1
      activeBodies += 1
      maxConcurrentBodies = Math.max(maxConcurrentBodies, activeBodies)
      sequence.push(args.label + '-body-start')
      if (args.label === 'first') {
        await waitUntil(() => sequence.includes('second-denied'), 'second mutation denial')
      }
      activeBodies -= 1
      sequence.push(args.label + '-body-finish')
      return args.label
    },
  })
  ctx.tools.register(hostValidator)
  ctx.tools.register(mutationDefinition)
  ctx.tools.register(defineTool({
    name: 'canary_parallel_mutations',
    description: 'dispatch two nested mutations through the real tools pipeline',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, outer) {
      const first = ctx.tools.execute({
        signal: outer.signal,
        callId: CallId('authoritative-acceptance-first-mutation'),
        rootCallId: outer.rootCallId,
        parent: outer.token,
        name: 'canary_mutation',
        arguments: { label: 'first' },
        agent: outer.agent,
      })
      await waitUntil(() => sequence.includes('first-body-start'), 'first mutation body')
      const second = await ctx.tools.execute({
        signal: outer.signal,
        callId: CallId('authoritative-acceptance-second-mutation'),
        rootCallId: outer.rootCallId,
        parent: outer.token,
        name: 'canary_mutation',
        arguments: { label: 'second' },
        agent: outer.agent,
      })
      if (second.isError) sequence.push('second-denied')
      return { first: await first, second }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'canary_crash_mutation',
    description: 'complete a mutation immediately before the process is killed',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      bodyExecutions.bodyExecuted()
      mutationExecutions += 1
      return 'mutated'
    },
  }))
  const run = async (initialAcceptance) => {
    if (deadlineController.isFinalizing()) return deadlineController.wait()
    progress.enter(SCENARIO_CANARY_PROGRESS.SCENARIO_STARTED)
    let acceptance = initialAcceptance
    const acceptanceEnabled = acceptanceRequired
    const results = []
    let goal
    let goalBefore
    let goalAfterDenial
    let goalAfterCompletion
    let denial
    let firstVerdict
    let finalVerdict
    let completionSettlement
    let observedGoalRoundFollowups = 0
    let resumedVerdict
    let disposalPromise
    let acceptanceContract
    let resumeEventAgent
    let resumeEventPublished
    let turnStops = 0
    let abortObservations = 0
    let lateSuccesses = 0
    let cancellationBodyEntries = 0
    let cancellationCallId
    let cancellationResult
    let cancellationChildPidObserved = false
    let cancellationChildProcessDead = false
    let cancellationHeartbeatStopped = false
    const turnVerdicts = []
    let listenerEntries = 0
    let validationExecutions = 0
    let recoveryAgentReady = false
    let recoveryTransitionRequested = false
    let legacySteeringObserved = false
    let recoverySessionSha
    let failure
    let resolveRecoveryTransition
    const recoveryTransition = new Promise(resolve => { resolveRecoveryTransition = resolve })
    let resolveLegacySteering
    const legacySteering = new Promise(resolve => { resolveLegacySteering = resolve })
    const matchingResults = name => results.filter(result => result.name === name)
    const succeeded = name => matchingResults(name).some(result => !result.is_error)
    const settled = name => matchingResults(name).length > 0
    const adapter = new CanaryAdapter(() => {
      const hostResults = matchingResults('canary_host_validator')
      switch (phase) {
        case 'positive':
        case 'restart-seed':
        case 'candidate-upgrade':
          if (!settled('bash')) {
            if (phase !== 'restart-seed') {
              progress.enter(SCENARIO_CANARY_PROGRESS.VALIDATION_TOOL_REQUESTED)
            }
            return validation(phase === 'candidate-upgrade' ? 'upgrade-validation' : 'validation')
          }
          if (!succeeded('bash')) return stop('contained validation failed')
          if (hostResults.length === 0) {
            if (phase !== 'restart-seed') {
              progress.enter(SCENARIO_CANARY_PROGRESS.HOST_VALIDATOR_REQUESTED)
            }
            return call(
              'canary_host_validator',
              {},
              phase === 'candidate-upgrade' ? 'upgrade-host-validator' : 'host-validator',
            )
          }
          if (!succeeded('canary_host_validator')) return stop('host validation failed')
          if (phase !== 'restart-seed') {
            progress.enter(SCENARIO_CANARY_PROGRESS.STOP_REQUESTED)
          }
          return stop(phase === 'candidate-upgrade'
            ? 'upgrade revalidation complete'
            : 'acceptance complete')
        case 'downstream-denial':
          if (hostResults.length === 0) {
            return call('canary_host_validator', {}, 'downstream-denied')
          }
          if (turnStops === 0) return stop('downstream denial must block this stop')
          if (!settled('bash')) return validation('downstream-recovery-validation')
          if (!succeeded('bash')) return stop('downstream recovery validation failed')
          if (!succeeded('canary_host_validator')) {
            return call('canary_host_validator', {}, 'downstream-recovery-host')
          }
          return stop('downstream recovery complete')
        case 'concurrent-mutation':
          if (!settled('canary_parallel_mutations')) {
            return call('canary_parallel_mutations', {}, 'parallel-mutations')
          }
          if (!settled('bash')) return validation('parallel-recovery-validation')
          if (!succeeded('bash')) return stop('parallel recovery validation failed')
          if (hostResults.length === 0) {
            return call('canary_host_validator', {}, 'parallel-recovery-host')
          }
          return stop('concurrency recovery complete')
        case 'active-cancellation':
          return !settled('bash')
            ? cancellation()
            : stop('cancelled acceptance must remain blocked')
        case 'cancellation-recover':
          if (!settled('bash')) return validation('recovery-validation')
          if (!succeeded('bash')) return stop('recovery validation failed')
          if (hostResults.length === 0) {
            return call('canary_host_validator', {}, 'recovery-host-validator')
          }
          return stop('recovery complete')
        case 'agent-disposal':
          return hostResults.length === 0
            ? call('canary_host_validator', {}, 'dispose-after-admission')
            : stop('disposed acceptance session')
        case 'restart-check':
          return stop('restart retained evidence')
        case 'crash-start':
          return !settled('canary_crash_mutation')
            ? call('canary_crash_mutation', {}, 'crash-mutation')
            : stop('terminal mutation must remain fail closed')
        case 'crash-recover':
          if (!recoveryAgentReady) return stop('observe recovered missing evidence')
          if (!settled('bash')) return validation('crash-recovery-validation')
          if (!succeeded('bash')) return stop('crash recovery validation failed')
          if (hostResults.length === 0) {
            return call('canary_host_validator', {}, 'crash-recovery-host')
          }
          return stop('crash recovery complete')
        case 'baseline-seed':
        case 'baseline-rollback':
          if (!settled('write')) return mutation('legacy-mutation')
          if (turnStops === 0) return stop('legacy stop must block before validation')
          if (!legacySteeringObserved) {
            legacySteeringObserved = true
            handle.agent.cancel({ kind: 'user' })
            resolveLegacySteering()
          }
          return stop('legacy mutation remains blocked before validation')
        case 'baseline-seed-validation':
        case 'baseline-rollback-validation':
          if (!settled('bash')) return validation('legacy-validation')
          return stop('legacy validation complete')
        case 'unpatched-smoke':
          return hostResults.length === 0
            ? call('canary_host_validator', {}, 'unpatched-tools-smoke')
            : stop('unpatched tools smoke complete')
        default:
          throw new Error('unsupported canary phase')
      }
    })

    try {
      required(workspace, 'workspace')
      required(processInstance, 'process instance')
      required(workspaceSha, 'workspace digest')
      ctx.llm.registerAdapter(['authoritative-acceptance-canary'], adapter)

      ctx.on('tools/result', (exec, result) => {
        if (exec.agent?.id === handle?.agent.id || exec.agent?.id === resumedHandle?.agent.id) {
          if (['positive', 'candidate-upgrade'].includes(phase)) {
            if (exec.name === 'bash' && exec.arguments?.command === validationCommand) {
              progress.enter(SCENARIO_CANARY_PROGRESS.VALIDATION_TOOL_RESULT)
            } else if (exec.name === 'canary_host_validator') {
              progress.enter(SCENARIO_CANARY_PROGRESS.HOST_VALIDATOR_RESULT)
            }
          }
          if (!result.isError && exec.name === 'bash'
            && exec.arguments?.command === validationCommand) {
            validationExecutions += 1
          }
          if (!result.isError && exec.name === 'write') mutationExecutions += 1
          if (phase === 'active-cancellation' && abortObservations > 0
            && exec.name === 'bash' && exec.arguments?.command === cancellationCommand
            && !result.isError) lateSuccesses += 1
          results.push({
            call_id: String(exec.callId),
            name: exec.name,
            is_error: result.isError,
            ...result.isError && typeof result.error?.message === 'string'
              ? { error_message: result.error.message.slice(0, 512) }
              : {},
            ...typeof result.error?.info?.code === 'string'
              ? { error_code: result.error.info.code }
              : {},
          })
        }
      })
      ctx.on('agent/session-start', ({ agent, source }) => {
        if (phase === 'agent-disposal' && agent.id === sessionId) {
          sequence.push('session-start:' + String(source))
          if (source === 'resume') {
            resumeEventAgent = agent
            resumeEventPublished = ctx.agents.get(sessionId) === agent
          }
        }
      })
      registerScenarioCanaryTurnStoppingProgress(ctx, {
        phase,
        progress,
        isTrackedAgent: agent => (
          agent.id === handle?.agent.id || agent.id === resumedHandle?.agent.id
        ),
        stopPipelineOutcome: (agent, turn) => (
          ctx.get('dshRuntimeKit')?.stopPipelineOutcome?.(agent, turn)
        ),
        onCompleted(agent) {
          bodyExecutions.turnStopping(validationBodyExecutions(
            required(validationMarker, 'validation marker'),
            required(validationToken, 'validation token'),
          ))
          turnStops += 1
          if (acceptanceEnabled) turnVerdicts.push(verdictView(acceptance.verdict(agent)))
          if (phase === 'crash-recover' && !recoveryTransitionRequested) {
            firstVerdict = verdictView(acceptance?.verdict(agent))
            recoveryTransitionRequested = true
            agent.cancel({ kind: 'user' })
            resolveRecoveryTransition()
          }
        },
      })
      registerScenarioCanaryAgentSettlementProgress(ctx, {
        phase,
        progress,
        isTrackedAgent: agent => (
          agent.id === handle?.agent.id || agent.id === resumedHandle?.agent.id
        ),
        isTrackedSession: session => (
          session === handle?.agent.session || session === resumedHandle?.agent.session
        ),
        hasCompletedStop: () => turnStops > 0,
      })
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (exec.agent?.id !== handle?.agent.id || exec.name !== 'canary_host_validator') {
          return decision
        }
        if (phase === 'downstream-denial' && listenerEntries === 0) {
          listenerEntries += 1
          sequence.push('acceptance-admitted', 'downstream-denied')
          return { kind: 'deny', reason: 'canary downstream denial after acceptance admission' }
        }
        if (phase === 'agent-disposal' && listenerEntries === 0) {
          listenerEntries += 1
          disposalPromise = handle.dispose()
          return { kind: 'deny', reason: 'canary disposal after acceptance admission' }
        }
        return decision
      })

      const currentAcceptanceContract = () => {
        const currentHostValidator = ctx.tools.get('canary_host_validator')
        const currentBash = ctx.tools.get('bash')
        const currentMutation = ctx.tools.get('canary_mutation')
        const currentCrashMutation = ctx.tools.get('canary_crash_mutation')
        if (currentHostValidator === undefined || currentBash === undefined
          || currentMutation === undefined || currentCrashMutation === undefined) {
          throw new Error('acceptance definitions unavailable')
        }
        return {
          requirements: [
            {
              name: 'host',
              validators: [{
                id: 'host-validator',
                definition: currentHostValidator,
                execution: { kind: 'host-observed' },
              }],
            },
            {
              name: 'shell',
              validators: [
                {
                  id: 'contained-validator',
                  definition: currentBash,
                  execution: {
                    kind: 'contained-bash',
                    intent: 'project-dev',
                    command: required(validationCommand, 'validation command'),
                  },
                },
                {
                  id: 'cancellable-contained-validator',
                  definition: currentBash,
                  execution: {
                    kind: 'contained-bash',
                    intent: 'project-dev',
                    command: required(cancellationCommand, 'cancellation command'),
                  },
                },
              ],
            },
          ],
          invalidators: [currentMutation, currentCrashMutation],
        }
      }

      if (acceptanceEnabled) {
        acceptanceContract = currentAcceptanceContract()
        acceptance.register(acceptanceContract)
        progress.enter(SCENARIO_CANARY_PROGRESS.CONTRACT_REGISTERED)
      }

      progress.enter(SCENARIO_CANARY_PROGRESS.CREATING_AGENT)
      handle = phase === 'restart-check' || phase === 'crash-recover'
        || phase === 'candidate-upgrade' || phase === 'baseline-rollback'
        ? await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: 'authoritative-acceptance-canary', model: 'scripted' },
          })
        : await ctx.agents.create({
            sessionId,
            agentOptions: { provider: 'authoritative-acceptance-canary', model: 'scripted' },
            meta: { cwd: workspace },
          })
      progress.enter(SCENARIO_CANARY_PROGRESS.AGENT_CREATED)
      if (acceptanceEnabled) {
        progress.enter(SCENARIO_CANARY_PROGRESS.WAITING_SESSION_REGISTRATION)
        await waitUntil(() => {
          try { return acceptance.verdict(handle.agent) !== undefined } catch { return false }
        }, 'acceptance session registration')
        progress.enter(SCENARIO_CANARY_PROGRESS.SESSION_REGISTERED)
      }

      if (['positive', 'candidate-upgrade'].includes(phase)) {
        goal = await prepareScenarioCanaryGoalAtDriverCheckpoint(ctx, handle.agent)
        goalBefore = goalView(goal, handle.agent.session.events)
        firstVerdict = verdictView(acceptance?.verdict(handle.agent))
        try {
          ctx.goals.complete(handle.agent, goal)
        } catch (error) {
          denial = { code: error?.code, aggregate: error?.aggregate }
        }
        goalAfterDenial = goalView(ctx.goals.get(handle.agent), handle.agent.session.events)
      } else if (acceptanceEnabled && !['agent-disposal', 'crash-start'].includes(phase)) {
        const existing = ctx.goals.get(handle.agent)
        goal = existing === undefined || existing.phase === 'complete'
          ? ctx.goals.create(handle.agent, { objective: 'prove authoritative acceptance' })
          : existing
        goalBefore = goalView(goal, handle.agent.session.events)
      }

      if (phase === 'restart-check') {
        firstVerdict = verdictView(acceptance?.verdict(handle.agent))
      }

      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run the authoritative acceptance canary' }],
        source: { kind: 'user' },
      }))
      progress.enter(SCENARIO_CANARY_PROGRESS.FOLLOWUP_SUBMITTED)

      if (phase === 'crash-start') {
        await waitUntil(
          () => succeeded('canary_crash_mutation'),
          'terminal crash mutation result',
        )
        await waitUntil(
          () => verdictView(acceptance?.verdict(handle.agent)).aggregate === 'missing',
          'terminal crash mutation verdict',
        )
        writeFileSync(required(crashMarker, 'crash marker'), 'mutation-terminal\n')
        await new Promise(() => {})
      }

      if (phase === 'crash-recover') {
        await recoveryTransition
        await handle.agent.whenIdle()
        const previousHandle = handle
        await previousHandle.dispose()
        const recoverySessionId = sessionId + '-recovery'
        const recoveryHandle = await ctx.agents.create({
          sessionId: recoverySessionId,
          agentOptions: { provider: 'authoritative-acceptance-canary', model: 'scripted' },
          meta: { cwd: workspace },
        })
        await waitUntil(() => {
          try { return acceptance.verdict(recoveryHandle.agent) !== undefined } catch { return false }
        }, 'post-crash recovery session registration')
        handle = recoveryHandle
        recoverySessionSha = digest(recoverySessionId)
        recoveryAgentReady = true
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'revalidate in a replacement session after crash' }],
          source: { kind: 'user' },
        }))
      }

      if (phase === 'active-cancellation') {
        await Promise.race([
          waitUntil(
            () => existsSync(required(cancellationMarker, 'cancellation marker')),
            'contained body marker',
          ),
          handle.agent.whenIdle().then(() => {
            throw new Error('agent became idle before contained body marker: ' + JSON.stringify({
              results,
              verdict: verdictView(acceptance?.verdict(handle.agent)),
            }))
          }),
        ])
        const matchingCalls = handle.agent.session.events.filter(event => {
          if (event.type !== 'tool/call' || event.data.name !== 'bash') return false
          try {
            return JSON.parse(event.data.arguments).command === cancellationCommand
          } catch {
            return false
          }
        })
        if (matchingCalls.length !== 1) {
          throw new Error('expected one exact cancellable Bash call, got '
            + JSON.stringify(matchingCalls.map(event => event.data.callId)))
        }
        cancellationCallId = String(matchingCalls[0].data.callId)
        const pidPath = required(cancellationPid, 'cancellation pid path')
        const heartbeatPath = required(cancellationHeartbeat, 'cancellation heartbeat path')
        await waitUntil(
          () => existsSync(pidPath) && existsSync(heartbeatPath)
            && Number.parseInt(readFileSync(heartbeatPath, 'utf8'), 10) > 0,
          'cancellable child PID and live heartbeat',
        )
        const namespacePid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10)
        if (!Number.isSafeInteger(namespacePid) || namespacePid <= 1) {
          throw new Error('cancellable child did not publish a valid namespace PID')
        }
        const childPid = observableChildPid(namespacePid, pidPath, heartbeatPath)
        if (!processAlive(childPid)) {
          throw new Error('cancellable child PID was not live before caller abort')
        }
        cancellationChildPidObserved = true
        cancellationBodyEntries += 1
        sequence.push('body-start', 'caller-abort')
        handle.agent.cancel({ kind: 'user' })
        abortObservations += 1
        await handle.agent.whenIdle()
        await waitUntil(
          () => results.some(result => result.call_id === cancellationCallId),
          'cancellable Bash terminal result',
        )
        cancellationResult = results.find(result => result.call_id === cancellationCallId)
        if (cancellationResult?.is_error !== true
          || cancellationResult.error_message
            !== 'dsh-runtime-kit: finish-line request cancelled') {
          throw new Error('cancellable Bash did not terminalize through finish-line cancellation: '
            + JSON.stringify(cancellationResult))
        }
        await waitUntil(() => !processAlive(childPid), 'cancellable child process death')
        cancellationChildProcessDead = true
        const terminalHeartbeat = readFileSync(heartbeatPath, 'utf8')
        await new Promise(resolve => setTimeout(resolve, 150))
        cancellationHeartbeatStopped = readFileSync(heartbeatPath, 'utf8') === terminalHeartbeat
        if (!cancellationHeartbeatStopped) {
          throw new Error('cancellable child heartbeat continued after terminal result')
        }
        sequence.push('contained-terminal')
        firstVerdict = verdictView(acceptance?.verdict(handle.agent))
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'prove cancellation remains fail closed' }],
          source: { kind: 'user' },
        }))
        await waitUntil(() => turnStops === 1, 'post-cancellation stop denial')
        handle.agent.cancel({ kind: 'user' })
        await handle.agent.whenIdle()
      }

      if (phase === 'baseline-seed' || phase === 'baseline-rollback') {
        await legacySteering
        await handle.agent.whenIdle()
      }

      if (phase === 'baseline-seed-validation'
        || phase === 'baseline-rollback-validation') {
        try {
          await waitUntil(
            () => succeeded('bash') && turnStops >= 1,
            'exact legacy validation in a fresh process',
          )
        } catch {
          throw new Error('legacy validation unavailable: ' + JSON.stringify({
            results,
            turn_stops: turnStops,
            events: handle.agent.session.events.flatMap(event => {
              if (event.type === 'tool/call') {
                return [{ type: event.type, name: event.data.name, call_id: event.data.callId }]
              }
              if (event.type === 'tool/result') {
                return [{ type: event.type, call_id: event.data.message.callId }]
              }
              if (event.type === 'turn/end') return [{ type: event.type, reason: event.data.reason }]
              return []
            }).slice(-20),
          }))
        }
      }

      progress.enter(SCENARIO_CANARY_PROGRESS.WAITING_AGENT_IDLE)
      await handle.agent.whenIdle()
      progress.enter(SCENARIO_CANARY_PROGRESS.AGENT_IDLE)
      if (disposalPromise !== undefined) {
        await disposalPromise
        resumedHandle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: 'authoritative-acceptance-canary', model: 'scripted' },
        })
        await waitUntil(
          () => ctx.get('dshRuntimeKit') !== undefined && ctx.get('dshAcceptance') !== undefined,
          'runtime and acceptance service rebind',
        )
        acceptance = ctx.get('dshAcceptance')
        if (acceptance === undefined) throw new Error('acceptance service unavailable after rebind')
        await waitUntil(() => {
          try { currentAcceptanceContract(); return true } catch { return false }
        }, 'acceptance definition rebind')
        acceptanceContract = currentAcceptanceContract()
        try {
          acceptance.register(acceptanceContract)
        } catch (error) {
          if (!(error instanceof Error)
            || !/acceptance contract already registered or disposed/u.test(error.message)) throw error
        }
        let resumeError
        try {
          await waitUntil(() => {
            try { return acceptance?.verdict(resumedHandle.agent) !== undefined } catch (error) {
              resumeError = error instanceof Error ? error.message : 'unknown resume failure'
              return false
            }
          }, 'disposed session resume')
        } catch {
          throw new Error('disposed session resume failed: ' + JSON.stringify({
            same_agent: resumedHandle.agent === handle.agent,
            live_agent: ctx.agents.get(sessionId) === resumedHandle.agent,
            resume_event_is_returned: resumeEventAgent === resumedHandle.agent,
            resume_event_published: resumeEventPublished,
            sequence,
            cause: resumeError,
          }))
        }
        resumedVerdict = verdictView(acceptance?.verdict(resumedHandle.agent))
        resumedHandle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'resume the disposed acceptance session' }],
          source: { kind: 'user' },
        }))
        resumedHandle.agent.cancel({ kind: 'user' })
        await resumedHandle.agent.whenIdle()
      } else if (acceptanceEnabled) {
        finalVerdict = verdictView(acceptance.verdict(handle.agent))
      }

      if (goal !== undefined && finalVerdict?.action === 'allow'
        && ['positive', 'candidate-upgrade'].includes(phase)) {
        goalAfterCompletion = goalView(
          ctx.goals.complete(handle.agent, goal),
          handle.agent.session.events,
        )
      }

      progress.enter(SCENARIO_CANARY_PROGRESS.WAITING_RESOURCE_DRAIN)
      await waitUntil(() => Object.values(resources(ctx)).every(value => value === 0), 'resource drain')
      if (goalAfterCompletion !== undefined) {
        progress.enter(SCENARIO_CANARY_PROGRESS.COMPLETION_SETTLEMENT)
        const settlement = acceptance.completionSettlement(handle.agent)
        const finishLineDegraded = ctx.get('dshRuntimeKit')?.finishLineDegraded
        completionSettlement = {
          status: settlement?.status,
          finish_line_degraded: finishLineDegraded,
        }
        if (settlement?.status !== 'succeeded' || finishLineDegraded !== false) {
          throw new Error('completion settlement failed closed')
        }
      }
      observedGoalRoundFollowups = goalRoundFollowups(handle.agent)
      if (['positive', 'candidate-upgrade'].includes(phase)
        && observedGoalRoundFollowups !== 0) {
        throw new Error('disarmed canary goal produced an automatic round')
      }
      receipt = {
        schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary.v1',
        phase,
        process_instance_sha256: processInstance,
        workspace_sha256: workspaceSha,
        session_sha256: digest(sessionId),
        recovery_session_sha256: recoverySessionSha,
        acceptance_mode: acceptanceEnabled ? 'present' : 'absent',
        model_calls: adapter.modelCalls,
        sequence,
        results,
        goal: {
          before: goalBefore,
          after_denial: goalAfterDenial,
          after_completion: goalAfterCompletion,
        },
        denial,
        first_verdict: firstVerdict,
        final_verdict: finalVerdict,
        completion_settlement: completionSettlement,
        resumed_verdict: resumedVerdict,
        turn_verdicts: turnVerdicts,
        listener_entries: listenerEntries,
        body_executions: bodyExecutions.receipt(),
        mutation_executions: mutationExecutions,
        validation_executions: validationExecutions,
        host_validation_executions: hostValidationExecutions,
        max_concurrent_bodies: maxConcurrentBodies,
        turn_stops: turnStops,
        goal_round_followups: observedGoalRoundFollowups,
        legacy_steering_observed: legacySteeringObserved,
        abort_observations: abortObservations,
        late_successes: lateSuccesses,
        cancellation_body_entries: cancellationBodyEntries,
        cancellation_call_id: cancellationCallId,
        cancellation_result: cancellationResult === undefined ? undefined : {
          outcome: cancellationResult.is_error ? 'cancelled' : 'succeeded',
          error_class: cancellationResult.error_message
            === 'dsh-runtime-kit: finish-line request cancelled'
            ? 'finish-line-request-cancelled'
            : 'unexpected',
        },
        cancellation_child_pid_observed: cancellationChildPidObserved,
        cancellation_child_process_dead: cancellationChildProcessDead,
        cancellation_heartbeat_stopped: cancellationHeartbeatStopped,
        resources_after: resources(ctx),
      }
    } catch (error) {
      failure = { error }
    }
    if (failure === undefined) progress.enter(SCENARIO_CANARY_PROGRESS.FINALIZING)
    await deadlineController.finish(receipt, failure)
  }
  if (phase === 'unpatched-smoke') return run(undefined)
  startScenarioCanaryWhenReady(ctx, acceptanceRequired, run)
}
