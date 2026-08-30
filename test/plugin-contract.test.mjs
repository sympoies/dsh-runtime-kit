import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { ENV_OVERRIDES } from '@deepseek-ai/dsh-bash-local'
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'
import { approveEscalation, canonicalPath, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { applyPolicy } from '../policy.js'
import {
  boundedUtf8Segments,
  createWorkspaceDisposalBarrier,
  requiresAuthoritativeFinishLine,
} from '../src/policy/index.js'
import { createManagedSessionBridge } from '../src/main-agent/session-bridge.js'
import { createSnapshotExecutionOwner } from '../src/health/nils-provider.js'
import {
  createChildHealthRefresh,
  createChildPluginStatus,
  observeChildPluginActivation,
  snapshotChildPluginStatus,
} from '../src/runtime-status.js'
import { selectManagedSessionEnvironment } from '../src/policy/nils-transport.js'
import { createPrerequisiteCoordinator } from '../src/prerequisite/index.js'
import {
  registerScenarioCanaryTurnStoppingProgress,
  SCENARIO_CANARY_PROGRESS,
} from './fixtures/authoritative-acceptance-canary/receipt-output.js'

const sha256 = `sha256:${'0'.repeat(64)}`
const isNonWideningSandboxEcho = (permissions, effectiveMode) => permissions === effectiveMode
  || (permissions === 'workspace-write' && effectiveMode === 'danger-full-access')
const dshRuntime = Object.freeze({
  ENV_OVERRIDES,
  HarnessError,
  TOOL_ABORTED,
  createUserMessage,
  approveEscalation,
  canonicalPath,
  isNonWideningSandboxEcho,
  validateEscalationArgs,
})

test('policy activation requires the authenticated DSH echo classifier', () => {
  assert.throws(
    () => applyPolicy({}, {}, undefined, {
      ...dshRuntime,
      isNonWideningSandboxEcho: undefined,
    }),
    /authenticated DSH sandbox echo classifier is required/,
  )
})

async function waitForAbort(signal, timeoutMs = 1_000) {
  if (signal.aborted) return
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`signal did not abort within ${timeoutMs}ms`))
    }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

test('workspace disposal cleanup completes before a replacement session starts', async () => {
  const barrier = createWorkspaceDisposalBarrier()
  const first = { session: { header: { cwd: '/workspace/one' } } }
  const replacement = { session: { header: { cwd: '/workspace/one' } } }
  let releaseCleanup
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve })
  const cleanup = barrier.track(first, async () => cleanupGate)
  assert.equal(barrier.ready(replacement), false)
  let replacementStarted = false
  const start = barrier.wait(replacement).then(() => { replacementStarted = true })

  await Promise.resolve()
  assert.equal(replacementStarted, false)
  releaseCleanup()
  await Promise.all([cleanup, start])
  assert.equal(replacementStarted, true)
  assert.equal(barrier.ready(replacement), true)

  await barrier.wait({ session: { header: { cwd: '/workspace/two' } } })
})

test('only authenticated non-Linux advisory sessions bypass authoritative finish-line', () => {
  const principal = mode => ({
    environment: { AGENT_SESSION_COORDINATION_MODE: mode },
  })
  assert.equal(requiresAuthoritativeFinishLine('linux', principal('advisory')), true)
  assert.equal(requiresAuthoritativeFinishLine('darwin', undefined), true)
  assert.equal(requiresAuthoritativeFinishLine('darwin', principal('enforce')), true)
  assert.equal(requiresAuthoritativeFinishLine('darwin', principal('advisory')), false)
  assert.equal(requiresAuthoritativeFinishLine('darwin', principal('off')), false)
})

test('lifecycle prompt projection stops consuming segments at its UTF-8 budget', () => {
  function *segments() {
    yield '好'.repeat(30_000)
    throw new Error('bounded projection consumed a discarded prompt suffix')
  }
  const projected = boundedUtf8Segments(segments(), 64 * 1024)
  assert.equal(Buffer.byteLength(projected, 'utf8') <= 64 * 1024, true)
  assert.doesNotMatch(projected, /\uFFFD/)
})

test('optional child-plugin activation distinguishes pending active and failed states', async () => {
  const status = createChildPluginStatus()
  const transitions = []
  assert.deepEqual(snapshotChildPluginStatus(status), {
    main_agent_mode: { state: 'pending' },
    review_specialists: { state: 'pending' },
  })
  const warnings = []
  observeChildPluginActivation(
    status,
    'review_specialists',
    async () => {},
    { warn: (...args) => warnings.push(args) },
    (name, state) => transitions.push([name, state.state]),
  )
  observeChildPluginActivation(
    status,
    'main_agent_mode',
    async () => { throw new TypeError('fixture detail must stay out of status') },
    { warn: (...args) => warnings.push(args) },
    (name, state) => transitions.push([name, state.state]),
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshotChildPluginStatus(status), {
    main_agent_mode: { state: 'failed', reason: 'activation-rejected', error_name: 'TypeError' },
    review_specialists: { state: 'active' },
  })
  assert.equal(warnings.length, 1)
  assert.deepEqual(transitions.sort(), [
    ['main_agent_mode', 'failed'],
    ['review_specialists', 'active'],
  ])
  assert.doesNotMatch(JSON.stringify(snapshotChildPluginStatus(status)), /fixture detail/)
})

test('optional child-plugin health follows a child-only Cordis unload', async () => {
  const root = new Context()
  const status = createChildPluginStatus()
  const transitions = []
  let child
  observeChildPluginActivation(
    status,
    'main_agent_mode',
    () => {
      child = root.plugin(() => {})
      return child
    },
    { warn() {} },
    (name, state) => transitions.push([name, state.state]),
    root,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(status.main_agent_mode.state, 'active')

  await child.dispose()
  assert.equal(status.main_agent_mode.state, 'unloaded')
  assert.deepEqual(transitions, [
    ['main_agent_mode', 'active'],
    ['main_agent_mode', 'unloaded'],
  ])
  await root.fiber.dispose()
})

test('optional child health refresh converges across pending and unloaded activation races', async () => {
  let state = 'pending'
  let observed = 'unknown'
  let calls = 0
  let releaseFirst
  const firstBarrier = new Promise(resolve => { releaseFirst = resolve })
  const health = {
    async probe() {
      const candidate = state
      calls += 1
      if (calls === 1) await firstBarrier
      observed = candidate
    },
  }
  const refresh = createChildHealthRefresh(health)

  const pending = refresh('main-agent-mode')
  await new Promise(resolve => setImmediate(resolve))
  state = 'active'
  const active = refresh('main-agent-mode')
  releaseFirst()
  await Promise.all([pending, active])
  assert.equal(observed, 'active')
  assert.equal(calls, 2)

  state = 'unloaded'
  await refresh('main-agent-mode')
  state = 'active'
  await refresh('main-agent-mode')
  assert.equal(observed, 'active')
  assert.equal(calls, 4)
})

test('policy subprocess never restores ambient provider session identity', () => {
  assert.deepEqual(
    selectManagedSessionEnvironment({
      AGENT_SESSION_ID: 'codex-provider-session',
      AGENT_SESSION_RUNTIME_ID: 'claude-runtime-1',
      AGENT_SESSION_BIN: '/provider/agent-session',
      AGENT_SESSION_CAPABILITY_FILE: '/provider/capability',
      AGENT_SESSION_STATE_DIR: '/provider/state',
      AGENT_SESSION_TOKEN: 'must-not-cross',
      AGENT_SESSION_CHECKPOINT_FILE: '/must/not/cross',
      UNRELATED_SECRET: 'must-not-cross',
    }),
    {
      AGENT_SESSION_ID: undefined,
      AGENT_SESSION_RUNTIME_ID: undefined,
      AGENT_SESSION_BIN: undefined,
      AGENT_SESSION_CAPABILITY_FILE: undefined,
      AGENT_SESSION_STATE_DIR: undefined,
      AGENT_SESSION_TOKEN: undefined,
      AGENT_SESSION_CHECKPOINT_FILE: undefined,
    },
  )
  assert.deepEqual(selectManagedSessionEnvironment({}), {})
})

function decision(action = 'allow', overrides = {}) {
  const disposition = action === 'block'
    ? 'block'
    : action === 'context'
      ? 'context'
      : action === 'warn'
        ? 'warn'
        : undefined
  return {
    schema_version: 'cli.agent-hook.dispatch.v1',
    ok: true,
    data: {
      schema_version: 'agent-hook.normalized-decision.v1',
      request_id: '__CURRENT_REQUEST__',
      product: 'dsh',
      event: 'PreToolUse',
      action,
      reasons: disposition === undefined
        ? []
        : [{
            rule_id: `dsh.${action}`,
            code: action === 'block' ? 'blocked' : action,
            disposition,
          }],
      config_digest: sha256,
      policy_digest: sha256,
      recovery_applied: false,
      ...overrides,
    },
  }
}

function acceptanceStopEnvelope(actions, selectStopDecision) {
  return spec => {
    const finishLineIndex = spec.argv.indexOf('finish-line')
    if (finishLineIndex >= 0) {
      const action = spec.argv[finishLineIndex + 1]
      const request = JSON.parse(spec.stdio.stdin.data)
      actions.push(action === 'observe'
        ? `observe:${request.observation.status}`
        : action)
      const data = {
        open: {
          schema_version: 'agent-hook.finish-line.open-result.v1',
          status: 'opened',
          runner_capability: 'runner:opaque',
          correlation_id: 'correlation:opaque',
        },
        register: {
          schema_version: 'agent-hook.finish-line.register-result.v1',
          status: 'registered',
          contract_digest: sha256,
          requirement_count: request.requirements?.length ?? 1,
          correlation_id: 'correlation:opaque',
        },
        verdict: {
          schema_version: 'agent-hook.finish-line.verdict-result.v1',
          action: 'allow',
          aggregate: 'satisfied',
          generation: 1,
          contract_digest: request.contract_digest,
          correlation_id: 'correlation:opaque',
          reason_codes: [],
          requirements: [{
            name: 'unit',
            status: 'satisfied',
            attempt_generation: 1,
          }],
          completion_reservation: request.completion_reservation === undefined
            ? null
            : {
                operation_id: request.completion_reservation.operation_id,
                status: 'reserved',
              },
        },
        observe: {
          schema_version: 'agent-hook.finish-line.observe-result.v1',
          status: 'applied',
          operation_id: request.operation_id,
          generation: 1,
          observation: request.observation?.status ?? 'succeeded',
          correlation_id: 'correlation:opaque',
        },
        release: {
          schema_version: 'agent-hook.finish-line.release-result.v1',
          status: 'released',
          correlation_id: 'correlation:opaque',
        },
      }[action]
      if (data === undefined) throw new Error(`unexpected finish-line action: ${action}`)
      return {
        schema_version: `cli.agent-hook.finish-line-${action}.v1`,
        ok: true,
        data,
      }
    }
    const ingress = JSON.parse(spec.stdio.stdin.data)
    if (ingress.event === 'agent/turn-stopping') return selectStopDecision()
    return decision('allow', {
      event: ingress.event === 'agent/pre-step' ? 'UserPromptSubmit' : 'PostToolUse',
    })
  }
}

function lifecycleStopEnvelope(selectStopDecision) {
  return spec => {
    if (spec.argv.includes('finish-line')) {
      return {
        schema_version: 'cli.agent-hook.finish-line-stop.v1',
        ok: true,
        data: {
          schema_version: 'agent-hook.finish-line.stop-result.v1',
          action: 'allow',
          generation: 0,
          contract_digest: 'contract-1',
          correlation_id: 'correlation-1',
          reason_codes: [],
          remediation: [],
        },
      }
    }
    const ingress = JSON.parse(spec.stdio.stdin.data)
    return ingress.event === 'agent/turn-stopping'
      ? selectStopDecision()
      : decision('allow', { event: 'UserPromptSubmit' })
  }
}

function harness({
  envelope = decision(),
  pending = false,
  outcome,
  stdout,
  lossy = false,
  missingStdout = false,
  throwOnSpawn = false,
  settleOnAbort = true,
  settleOnTerminate = true,
  quiesceOnSettle = true,
  waitNeverSettles = false,
  prerequisiteReason = 'pending',
  prerequisiteCommitFailsAfter = Number.POSITIVE_INFINITY,
  prerequisiteBeginMalformed = false,
  resolutionPending = false,
  config = {},
  onRuntimeKitProvide,
  runtimeStopListenerGate,
  onRuntimeStopListenerRegistered,
  onRuntimeStopListenerEnter,
} = {}) {
  const listeners = new Map()
  const effects = []
  let guard
  let spawnCount = 0
  let terminateCount = 0
  let activeHandles = 0
  let peakActiveHandles = 0
  let signal
  let service
  let acceptanceService
  let prerequisiteCommitted = false
  let prerequisiteCommitCount = 0
  const prerequisiteBindings = new WeakMap()
  const callerSignals = new WeakMap()
  const registeredTools = new Map()
  const scopedTools = new WeakMap()
  const handles = []
  const spawnSpecs = []
  const resolutions = []
  const warnings = []
  const session = {
    id: 'session-1',
    header: { id: 'session-1', cwd: '/tmp' },
    events: [],
  }
  const steered = []
  const agent = {
    id: 'session-1',
    session,
    steer(message) { steered.push(message) },
  }
  const ctx = {
    logger: {
      warn(message) { warnings.push(message) },
    },
    agents: {
      list: () => [agent],
      get: id => id === agent.id ? agent : undefined,
    },
    sessions: {
      async flush(candidate) { return candidate === session },
    },
    get(name) {
      if (name === 'shell') {
        return {
          sandboxMode: 'danger-full-access',
          resolve(request) {
            return {
              ...request,
              timeoutMs: request.timeoutMs ?? 60_000,
              stdoutMaxBytes: 64 * 1024,
            }
          },
        }
      }
      if (name === 'shellEnv') return { collect: () => ({}) }
      if (name === 'sandboxPolicy') {
        return {
          resolve: () => ({
            mode: 'danger-full-access',
            workspaceRoot: session.header.cwd,
          }),
        }
      }
      return undefined
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        for (const observer of listeners.get('tools/change') ?? []) observer()
        return () => {
          if (registeredTools.get(definition.name) === definition) {
            registeredTools.delete(definition.name)
            for (const observer of listeners.get('tools/change') ?? []) observer()
          }
        }
      },
      get(name, scopeAgent) {
        return scopedTools.get(scopeAgent)?.get(name) ?? registeredTools.get(name)
      },
      guard(candidate) {
        guard = candidate
        return () => {
          if (guard === candidate) guard = undefined
        }
      },
      bindPrerequisite(exec, definition, prerequisite) {
        if (ctx.tools.get(exec.name, exec.agent) !== definition) {
          throw new Error('dsh-tools: prerequisite definition is not the exact visible tool')
        }
        if (prerequisiteBindings.has(exec)) {
          throw new Error('dsh-tools: execution already has a prerequisite binding')
        }
        prerequisiteBindings.set(exec, { definition, prerequisite })
      },
    },
    on(event, candidate, options = {}) {
      const candidates = listeners.get(event) ?? []
      let registered = candidate
      if (event === 'agent/turn-stopping'
          && service === undefined
          && runtimeStopListenerGate !== undefined) {
        onRuntimeStopListenerRegistered?.()
        registered = async (...args) => {
          onRuntimeStopListenerEnter?.()
          await runtimeStopListenerGate
          return candidate(...args)
        }
      }
      if (options.prepend === true) candidates.unshift(registered)
      else candidates.push(registered)
      listeners.set(event, candidates)
      return () => {
        const index = candidates.indexOf(registered)
        if (index >= 0) candidates.splice(index, 1)
      }
    },
    effect(execute) {
      const yielded = execute()
      const disposers = []
      if (typeof yielded === 'function') {
        disposers.push(yielded)
      } else if (yielded?.next !== undefined) {
        for (let step = yielded.next(); !step.done; step = yielded.next()) {
          if (typeof step.value === 'function') disposers.push(step.value)
        }
      }
      let disposed = false
      const dispose = async () => {
        if (disposed) return
        disposed = true
        for (const candidate of disposers.reverse()) await candidate()
      }
      effects.push(dispose)
      return dispose
    },
    provide(name, value) {
      if (name === 'dshRuntimeKit') {
        service = value
        onRuntimeKitProvide?.(ctx, value)
      }
      if (name === 'dshAcceptance') acceptanceService = value
    },
    subprocess: {
      async resolveExecutable(command, env, candidateSignal) {
        resolutions.push({ command, env, signal: candidateSignal })
        if (resolutionPending) {
          return new Promise((resolve, reject) => {
            if (candidateSignal?.aborted) reject(candidateSignal.reason)
            candidateSignal?.addEventListener('abort', () => reject(candidateSignal.reason), {
              once: true,
            })
          })
        }
        return `/resolved/${command}`
      },
      spawn(spec) {
        if (typeof throwOnSpawn === 'function' ? throwOnSpawn(spec) : throwOnSpawn) {
          throw new Error('spawn failed')
        }
        const dispatchIngress = spec.argv.includes('dispatch')
          ? JSON.parse(spec.stdio.stdin.data)
          : undefined
        const prerequisiteBegin = spec.argv.includes('prerequisite')
          && !spec.argv.includes('commit-prerequisite')
        const prerequisiteCommit = spec.argv.includes('commit-prerequisite')
        const implicitLifecycle = typeof envelope !== 'function'
          && dispatchIngress !== undefined
          && dispatchIngress.event !== 'tools/pre-execute'
        if (implicitLifecycle) {
          const event = dispatchIngress.event === 'agent/pre-step'
            ? 'UserPromptSubmit'
            : dispatchIngress.event === 'agent/turn-stopping'
              ? 'Stop'
              : dispatchIngress.result?.is_error === true
                ? 'PostToolUseFailure'
                : 'PostToolUse'
          const response = decision('allow', {
            event,
          })
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            terminate() {},
            collected: {
              stdout: { readFrom: () => ({ text: JSON.stringify(response), lossy: false }) },
            },
            async waitForExit() { return true },
          }
        }
        spawnSpecs.push(spec)
        spawnCount += 1
        activeHandles += 1
        peakActiveHandles = Math.max(peakActiveHandles, activeHandles)
        const currentPrerequisiteReason = prerequisiteCommitted
          ? 'already-current'
          : prerequisiteReason
        if (prerequisiteCommit) {
          prerequisiteCommitCount += 1
          if (prerequisiteCommitCount <= prerequisiteCommitFailsAfter) {
            prerequisiteCommitted = true
          }
        }
        const selectedEnvelope = prerequisiteBegin
          ? prerequisiteBeginMalformed
            ? {
                schema_version: 'cli.agent-docs.session.prerequisite.v1',
                ok: true,
                data: { decision: {} },
              }
            : {
              schema_version: 'cli.agent-docs.session.prerequisite.v1',
              ok: true,
              data: {
                decision: {
                  schema_version: 'decision.prerequisite.v1',
                  request_id: spec.argv[spec.argv.indexOf('--request-id') + 1],
                  product: 'dsh',
                  intent: 'project-dev',
                  phase: 'edit',
                  reason: currentPrerequisiteReason,
                  verified: true,
                  documents: [{ source: 'project', scope: 'project', content: 'bounded policy\n' }],
                  document_count: 1,
                  total_bytes: 15,
                  receipt: `{"receipt":"${currentPrerequisiteReason}"}`,
                }
              },
            }
          : prerequisiteCommit
            ? prerequisiteCommitCount > prerequisiteCommitFailsAfter
              ? {
                  schema_version: 'cli.agent-docs.session.commit-prerequisite.v1',
                  ok: false,
                  error: { code: 'prerequisite-stale' },
                }
              : {
                  schema_version: 'cli.agent-docs.session.commit-prerequisite.v1',
                  ok: true,
                  data: {
                  product: 'dsh',
                  intent: 'project-dev',
                  phase: 'edit',
                  reason: prerequisiteCommitCount === 1 ? 'prepared' : 'already-current',
                  verified: true,
                  },
                }
            : typeof envelope === 'function' ? envelope(spec) : envelope
        const response = structuredClone(selectedEnvelope)
        if (response.data?.request_id === '__CURRENT_REQUEST__') {
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
        }
        const output = stdout ?? JSON.stringify(response)
        let settle
        let rejectDone
        let resolveTreeExit
        const treeExit = new Promise(resolve => { resolveTreeExit = resolve })
        const shouldPend = typeof pending === 'function' ? pending(spec) : pending
        const done = shouldPend
          ? new Promise((resolve, reject) => {
            settle = resolve
            rejectDone = reject
          })
          : Promise.resolve(outcome ?? {
            exitCode: response.data?.action === 'block' ? 1 : 0,
            signal: null,
          })
        void done.then(() => {
          activeHandles -= 1
          if (quiesceOnSettle) resolveTreeExit()
        }, () => {
          activeHandles -= 1
          if (quiesceOnSettle) resolveTreeExit()
        })
        signal = spec.signal
        signal?.addEventListener('abort', () => {
          if (settleOnAbort) settle?.({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
        const handle = {
          done,
          terminate() {
            terminateCount += 1
            if (settleOnTerminate) settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          collected: {
            stdout: missingStdout
              ? undefined
              : { readFrom: () => ({ text: output, lossy }) },
          },
          async waitForExit(waitSignal) {
            if (waitNeverSettles) return new Promise(() => {})
            if (waitSignal?.aborted) return false
            if (waitSignal !== undefined) {
              return Promise.race([
                treeExit.then(() => true),
                new Promise(resolve => {
                  waitSignal.addEventListener('abort', () => resolve(false), { once: true })
                }),
              ])
            }
            await treeExit
            return true
          },
        }
        handles.push({
          settle: (result = outcome ?? {
            exitCode: response.data?.action === 'block' ? 1 : 0,
            signal: null,
          }) => settle?.(result),
          reject: error => rejectDone?.(error),
          exit: () => resolveTreeExit(),
        })
        return handle
      },
    },
  }
  function attachAgentTools(candidate) {
    candidate.ctx = {
      tools: {
        get(name) {
          return ctx.tools.get(name, candidate)
        },
        register(definition) {
          let tools = scopedTools.get(candidate)
          if (tools === undefined) {
            tools = new Map()
            scopedTools.set(candidate, tools)
          }
          tools.set(definition.name, definition)
          for (const observer of listeners.get('tools/change') ?? []) observer()
          return () => {
            if (tools.get(definition.name) === definition) {
              tools.delete(definition.name)
              for (const observer of listeners.get('tools/change') ?? []) observer()
            }
          }
        },
      },
    }
  }
  attachAgentTools(agent)
  applyPolicy(ctx, {
    agentHook: '/test/agent-hook',
    agentHookConfig: '/runtime/agent-hook/config.toml',
    agentHookPolicy: '/runtime/agent-hook/dsh-policy.toml',
    agentHookStateDir: '/runtime/agent-hook/state',
    agentDocsHome: '/runtime/docs',
    agentDocsStateHome: '/runtime/state',
    ...config,
  }, undefined, dshRuntime)
  let lifecycleStarted = false
  let nextStep = 1

  async function dispatchWaterfall(event, args, inner) {
    const candidates = [...(listeners.get(event) ?? [])]
    const next = async () => {
      const candidate = candidates.shift()
      return candidate === undefined ? inner() : candidate(...args, next)
    }
    return next()
  }

  async function dispatchSerial(event, args) {
    for (const candidate of [...(listeners.get(event) ?? [])]) {
      await candidate(...args)
    }
  }

  async function prepare(arguments_, {
    callId = 'call-1',
    rootCallId = callId,
    name = 'runtime_kit_plus_one',
    parent,
    downstreamDecision = { kind: 'allow' },
    signal: callerSignal = new AbortController().signal,
    shortCircuit = false,
    token = Symbol(callId),
    agent: executionAgent = agent,
    withoutAgent = false,
    skipLifecycle = false,
    reversePolicyDenial = false,
  } = {}) {
    if (!skipLifecycle && !lifecycleStarted && (listeners.get('agent/session-start')?.length ?? 0) > 0) {
      lifecycleStarted = true
      for (const observer of listeners.get('agent/session-start') ?? []) {
        observer({ agent, source: 'startup' })
      }
      session.events.push({ type: 'turn/start', data: { turn: 1 } })
    }
    if (!skipLifecycle && (listeners.get('agent/pre-step')?.length ?? 0) > 0) {
      const openStep = session.events.findLast(event => event.type === 'step/start')
      const closedStep = session.events.findLast(event => event.type === 'step/end')
      if (openStep !== undefined && openStep.data.step !== closedStep?.data.step) {
        session.events.push({ type: 'step/end', data: openStep.data })
      }
      const step = nextStep
      nextStep += 1
      const decision = await dispatchWaterfall(
        'agent/pre-step',
        [{ agent, messages: [], turn: 1, step, signal: callerSignal }],
        async () => ({ kind: 'enter', messages: [] }),
      )
      if (decision.kind === 'enter' && !callerSignal.aborted) {
        session.events.push({ type: 'step/start', data: { turn: 1, step } })
      }
    }
    const exec = {
      token,
      callId,
      rootCallId,
      name,
      arguments: arguments_,
      signal: callerSignal,
      agent: withoutAgent ? undefined : executionAgent,
      parent,
    }
    callerSignals.set(exec, callerSignal)
    let result = shortCircuit
      ? { kind: 'allow' }
          : await dispatchWaterfall('tools/pre-execute', [exec], async () => (
              typeof downstreamDecision === 'function'
                ? downstreamDecision()
                : downstreamDecision
            ))
    if (reversePolicyDenial && result.kind === 'deny') result = { kind: 'allow' }
    return { exec, result }
  }

  return {
    ctx,
    async invoke(arguments_, options = {}) {
      let delegated = false
      const prepared = await prepare(arguments_, options)
      let result = prepared.result
      if (result.kind === 'ask') {
        result = options.askOutcome === 'approved'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `approval-${options.askOutcome ?? 'denied'}` }
      }
      if (result.kind === 'allow' && guard !== undefined) {
        const reason = guard(prepared.exec)
        if (reason !== undefined) result = { kind: 'deny', reason }
      }
      await options.beforeExecute?.(prepared.exec)
      if (result.kind === 'allow' && prepared.exec.signal.aborted) {
        result = { kind: 'deny', reason: 'caller-aborted-before-dispatch' }
      }
      let executionResult = { isError: result.kind !== 'allow', content: [] }
      let verifiedContexts = []
      if (result.kind === 'allow') {
        const bound = prerequisiteBindings.get(prepared.exec)
        const verifyPrerequisite = async () => {
          if (bound === undefined) return
          if (bound.definition !== ctx.tools.get(prepared.exec.name, prepared.exec.agent)) {
            throw new Error('dsh-tools: prerequisite definition changed before dispatch')
          }
          verifiedContexts = await bound.prerequisite.beforeBody(prepared.exec) ?? []
          if (bound.definition !== ctx.tools.get(prepared.exec.name, prepared.exec.agent)) {
            throw new Error('dsh-tools: prerequisite definition changed before dispatch')
          }
        }
        try {
          await verifyPrerequisite()
          executionResult = await dispatchWaterfall(
            'tools/execute',
            [prepared.exec],
            async () => {
            if (prepared.exec.signal.aborted) {
              return {
                isError: true,
                error: { message: 'caller-aborted-before-dispatch' },
                content: [],
              }
            }
            delegated = true
            const definition = ctx.tools.get(prepared.exec.name, prepared.exec.agent)
            try {
              if (bound !== undefined) {
                if (bound.definition !== definition) {
                  throw new Error('dsh-tools: prerequisite definition changed before body dispatch')
                }
                await verifyPrerequisite()
                if (prepared.exec.signal.aborted) {
                  return {
                    isError: true,
                    error: { message: 'caller-aborted-before-dispatch' },
                    content: [],
                  }
                }
                if (ctx.tools.get(prepared.exec.name, prepared.exec.agent) !== definition) {
                  throw new Error('dsh-tools: prerequisite definition changed before body dispatch')
                }
              }
              const value = definition === undefined
                ? { value: 42 }
                : await definition.execute(prepared.exec.arguments, prepared.exec)
              if (prepared.exec.signal.aborted) {
                return {
                  isError: true,
                  error: { message: 'caller-aborted' },
                  content: [],
                }
              }
              return { isError: false, value, content: [] }
            } catch (error) {
              return {
                isError: true,
                error: { message: error instanceof Error ? error.message : String(error) },
                content: [],
              }
            }
            },
          )
        } catch (error) {
          executionResult = {
            isError: true,
            error: { message: error instanceof Error ? error.message : String(error) },
            content: [],
          }
        }
      }
      let postDecision = await dispatchWaterfall(
        'tools/post-execute',
        [prepared.exec, executionResult],
        async () => ({ kind: 'accept' }),
      )
      await options.beforeCommit?.(prepared.exec)
      const bound = prerequisiteBindings.get(prepared.exec)
      if (!executionResult.isError
        && postDecision.kind === 'accept'
        && verifiedContexts.length > 0) {
        postDecision = {
          ...postDecision,
          additionalContexts: [
            ...postDecision.additionalContexts ?? [],
            ...verifiedContexts,
          ],
        }
      }
      if (bound !== undefined
        && !executionResult.isError
        && postDecision.kind === 'accept'
        && !callerSignals.get(prepared.exec).aborted) {
        try {
          await bound.prerequisite.commit(prepared.exec, executionResult)
        } catch {}
      }
      for (const observer of listeners.get('tools/result') ?? []) {
        observer(prepared.exec, executionResult)
      }
      return { result, delegated, exec: prepared.exec, postDecision, executionResult }
    },
    prepare,
    guard(exec) { return guard?.(exec) },
    release(index, result) { handles[index]?.settle(result) },
    reject(index, error) { handles[index]?.reject(error) },
    releaseTree(index) { handles[index]?.exit() },
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
    emit(event, ...args) {
      for (const observer of listeners.get(event) ?? []) observer(...args)
    },
    serial(event, ...args) {
      return dispatchSerial(event, args)
    },
    waterfall(event, args, inner) {
      return dispatchWaterfall(event, args, inner)
    },
    get listenerNames() {
      return [...listeners]
        .filter(([, candidates]) => candidates.length > 0)
        .map(([event]) => event)
        .sort()
    },
    get registeredToolNames() { return [...registeredTools.keys()].sort() },
    tool(name) { return registeredTools.get(name) },
    attachAgentTools,
    agent,
    steered,
    get spawnCount() { return spawnCount },
    get peakActiveHandles() { return peakActiveHandles },
    get terminateCount() { return terminateCount },
    get signal() { return signal },
    get service() { return service },
    get acceptanceService() { return acceptanceService },
    get spawnSpecs() { return spawnSpecs },
    get resolutions() { return resolutions },
    get warnings() { return warnings },
  }
}

test('runtime service activation places canary progress after the real stop listener', async () => {
  const entered = []
  let releaseRuntimeStopListener
  const runtimeStopListenerGate = new Promise(resolve => {
    releaseRuntimeStopListener = resolve
  })
  let runtimeStopListenerEntered
  const runtimeStopListenerStarted = new Promise(resolve => {
    runtimeStopListenerEntered = resolve
  })
  let runtimeStopListenerRegistrations = 0
  const subject = harness({
    envelope: (spec) => {
      if (spec.argv.includes('finish-line')) {
        return {
          schema_version: 'cli.agent-hook.finish-line-stop.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.stop-result.v1',
            action: 'allow',
            generation: 0,
            contract_digest: 'contract-1',
            correlation_id: 'correlation-1',
            reason_codes: [],
            remediation: [],
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return decision('allow', {
        event: ingress.event === 'agent/turn-stopping' ? 'Stop' : 'UserPromptSubmit',
      })
    },
    runtimeStopListenerGate,
    onRuntimeStopListenerRegistered() { runtimeStopListenerRegistrations += 1 },
    onRuntimeStopListenerEnter() { runtimeStopListenerEntered() },
    onRuntimeKitProvide(ctx) {
      registerScenarioCanaryTurnStoppingProgress(ctx, {
        phase: 'positive',
        progress: { enter(code) { entered.push(code) } },
        isTrackedAgent: agent => agent.id === 'session-1',
        onCompleted() { entered.push('callback') },
      })
    },
  })
  assert.equal(runtimeStopListenerRegistrations, 1)
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  )

  const stop = subject.serial('agent/turn-stopping', {
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  })
  try {
    await runtimeStopListenerStarted
    assert.deepEqual(entered, [SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED])
  } finally {
    releaseRuntimeStopListener()
  }
  await stop
  assert.deepEqual(entered, [
    SCENARIO_CANARY_PROGRESS.TURN_STOPPING_ENTERED,
    SCENARIO_CANARY_PROGRESS.RUNTIME_STOP_LISTENERS_COMPLETED,
    'callback',
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_CALLBACK_COMPLETED,
    SCENARIO_CANARY_PROGRESS.CANARY_STOP_LISTENER_TAIL_COMPLETED,
  ])
})

test('policy ingress resolves a bare agent-hook command before spawning', async () => {
  const subject = harness({ config: { agentHook: 'agent-hook' } })

  const result = await subject.invoke({ value: 41 })
  assert.equal(result.result.kind, 'allow')
  assert.ok(subject.resolutions.length >= 2)
  assert.ok(subject.resolutions.every(candidate => candidate.command === 'agent-hook'))
  assert.ok(subject.resolutions.every(candidate => candidate.env === undefined))
  assert.equal(subject.spawnSpecs[0].argv[0], '/resolved/agent-hook')
})

test('policy holds its authenticated descriptor lease across delayed resolution and HMR disposal', async () => {
  let cleaned = false
  const owner = createSnapshotExecutionOwner(async () => { cleaned = true }, 100)
  const subject = harness({
    resolutionPending: true,
    config: {
      agentHook: 'agent-hook',
      authenticatedNilsExecution: owner,
    },
  })
  const pending = subject.invoke({ value: 41 })
  while (subject.resolutions.length === 0) await new Promise(resolve => setImmediate(resolve))
  await Promise.all([owner.dispose(), subject.dispose()])
  const result = await pending
  assert.equal(result.result.kind, 'deny')
  assert.equal(subject.spawnCount, 0)
  assert.equal(cleaned, true)
})

test('the policy bundle exposes one explicit selective runtime-context tool', () => {
  const subject = harness()

  assert.deepEqual(subject.registeredToolNames, [
    'runtime_context',
    'runtime_kit_plus_one',
  ])
  assert.deepEqual(subject.tool('runtime_context')?.parameters, {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['project-dev'] },
    },
    required: ['intent'],
    additionalProperties: false,
  })
})

test('a declared project-dev prerequisite begins before policy and commits only at execute', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const first = await subject.invoke({ value: 41 }, { callId: 'prerequisite-call-1' })
  assert.equal(first.result.kind, 'allow')
  assert.equal(first.delegated, true)
  const begin = subject.spawnSpecs.find(spec => spec.argv.includes('prerequisite'))
  const commit = subject.spawnSpecs.find(spec => spec.argv.includes('commit-prerequisite'))
  const policies = subject.spawnSpecs.filter(spec => spec.argv.includes('dispatch')
    && JSON.parse(spec.stdio.stdin.data).event === 'tools/pre-execute')
  const policy = policies[0]
  assert.ok(begin)
  assert.ok(commit)
  assert.ok(policy)
  assert.equal(policies.length, 3)
  const ingress = JSON.parse(policy.stdio.stdin.data)
  assert.equal(ingress.schema_version, 'agent-hook.dsh-ingress.v5')
  assert.equal(ingress.call_id, 'prerequisite-call-1')
  assert.equal(typeof ingress.subject.agent_id, 'string')
  assert.equal(typeof ingress.subject.workspace_generation, 'string')
  assert.equal(typeof ingress.tool.definition_id, 'string')
  assert.equal(ingress.tool.prerequisite_receipt, '{"receipt":"pending"}')
  assert.deepEqual(first.postDecision.additionalContexts?.[0]?.content, [
    { type: 'text', text: 'bounded policy\n' },
  ])
})

test('all five default mutator names bind the exact visible definition automatically', async () => {
  for (const name of [
    'bash',
    'write',
    'edit',
    'str_replace_editor',
    'runtime_kit_governed_commit',
  ]) {
    const definition = Object.freeze({ name })
    const session = { header: { id: `session-${name}`, cwd: '/tmp' } }
    const agent = { id: `session-${name}`, session }
    const exec = {
      token: Symbol(name),
      callId: `call-${name}`,
      rootCallId: `call-${name}`,
      name,
      arguments: Object.freeze({}),
      agent,
      signal: new AbortController().signal,
    }
    let bound
    let begins = 0
    let commits = 0
    let policyChecks = 0
    const coordinator = createPrerequisiteCoordinator({
      logger: { warn() {} },
      tools: {
        get(candidateName, candidateAgent) {
          return candidateName === name && candidateAgent === agent ? definition : undefined
        },
        bindPrerequisite(candidateExec, candidateDefinition, prerequisite) {
          assert.equal(candidateExec, exec)
          assert.equal(candidateDefinition, definition)
          bound = prerequisite
        },
      },
    }, {
      async beginPrerequisite() {
        begins += 1
        return {
          reason: 'pending',
          receipt: `receipt-${begins}`,
          documents: [{ source: 'project', scope: 'project', content: 'bounded policy' }],
        }
      },
      async commitPrerequisite() {
        commits += 1
        return { reason: 'prepared' }
      },
    }, createUserMessage, async () => {
      policyChecks += 1
      return undefined
    })

    await coordinator.begin(exec, {
      sessionId: session.header.id,
      cwd: session.header.cwd,
      turn: 1,
      step: 1,
      callId: exec.callId,
      name,
    })
    assert.ok(bound, name)
    const firstContexts = await bound.beforeBody(exec)
    const secondContexts = await bound.beforeBody(exec)
    await bound.commit(exec, { isError: false, value: null, content: [] })
    coordinator.result(exec)

    assert.equal(begins, 3, name)
    assert.equal(policyChecks, 2, name)
    assert.equal(commits, 1, name)
    assert.equal(firstContexts.length, 1, name)
    assert.equal(secondContexts.length, 1, name)
    assert.equal(coordinator.pending, 0, name)
    coordinator.dispose()
  }
})

test('a restored wrapper signal cannot impersonate caller cancellation at completion', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  const wrapper = new AbortController()

  const result = await subject.invoke({ value: 41 }, {
    callId: 'wrapper-signal-completion',
    beforeCommit(exec) {
      wrapper.abort()
      exec.signal = wrapper.signal
    },
  })

  assert.equal(result.executionResult.isError, false)
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    1,
  )
})

test('approval wait cannot carry an earlier allow past fresh last-mile policy', async () => {
  let preToolChecks = 0
  const subject = harness({
    envelope: (spec) => {
      if (!spec.argv.includes('dispatch')) return decision()
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event !== 'tools/pre-execute') return decision()
      preToolChecks += 1
      return preToolChecks === 1 ? decision('allow') : decision('block')
    },
  })
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const result = await subject.invoke({ value: 41 }, {
    callId: 'approval-policy-drift',
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
    askOutcome: 'approved',
  })

  assert.equal(result.result.kind, 'allow')
  assert.equal(result.delegated, false)
  assert.equal(result.executionResult.isError, true)
  assert.equal(subject.service.plusOneExecutions, 0)
  assert.equal(preToolChecks, 2)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
})

test('rejected prerequisite calls never commit or retain model context', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const denied = await subject.invoke(
    { value: 41 },
    { downstreamDecision: { kind: 'deny', reason: 'later-policy-denial' } },
  )
  assert.equal(denied.delegated, false)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
  assert.equal(denied.postDecision.additionalContexts, undefined)
  assert.equal(subject.service.pendingPrerequisites, 0)
})

test('an unchanged prerequisite scope revalidates every execution without a second context copy', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const first = await subject.invoke({ value: 41 }, { callId: 'reuse-1' })
  const second = await subject.invoke({ value: 42 }, { callId: 'reuse-2' })
  assert.equal(first.delegated, true)
  assert.equal(second.delegated, true)
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    2,
  )
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('prerequisite')
      && !spec.argv.includes('commit-prerequisite')).length,
    6,
  )
  assert.equal(first.postDecision.additionalContexts?.length, 1)
  assert.equal(second.postDecision.additionalContexts, undefined)
})

test('concurrent pending prerequisites retain one verified context per mutation', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  await subject.invoke({ intent: 'project-dev' }, {
    callId: 'concurrent-prerequisite-warmup',
    name: 'runtime_context',
  })

  const [first, second] = await Promise.all([
    subject.invoke({ value: 41 }, {
      callId: 'concurrent-prerequisite-1',
      skipLifecycle: true,
    }),
    subject.invoke({ value: 42 }, {
      callId: 'concurrent-prerequisite-2',
      skipLifecycle: true,
    }),
  ])

  assert.equal(first.delegated, true)
  assert.equal(second.delegated, true)
  assert.equal(
    [first, second].filter(result => result.postDecision.additionalContexts !== undefined).length,
    2,
  )
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    2,
  )
})

test('an uncertain prerequisite commit cannot turn a completed mutation into a retryable error', async () => {
  const subject = harness({ prerequisiteCommitFailsAfter: 0 })
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const completed = await subject.invoke({ value: 41 }, {
    callId: 'uncertain-cache-completion',
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
    askOutcome: 'approved',
  })

  assert.equal(completed.delegated, true)
  assert.equal(subject.service.plusOneExecutions, 1)
  assert.deepEqual(completed.executionResult, {
    isError: false,
    value: 42,
    content: [],
  })
  assert.deepEqual(completed.postDecision.additionalContexts?.[0]?.content, [
    { type: 'text', text: 'bounded policy\n' },
  ])
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    2,
  )
  assert.deepEqual(subject.warnings, [
    'prerequisite cache completion remained uncertain after bounded reconciliation',
  ])
  assert.equal(subject.service.pendingPrerequisites, 0)
})

test('a successful mutating execute wrapper linearizes after one prerequisite check', async () => {
  const subject = harness()
  const controller = new AbortController()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  subject.ctx.on('tools/execute', async () => {
    controller.abort('caller stopped after wrapper mutation')
    return { isError: false, value: 42, content: [] }
  })

  const result = await subject.invoke({ value: 41 }, {
    callId: 'mutating-wrapper-late-abort',
    signal: controller.signal,
  })

  assert.equal(result.executionResult.isError, false)
  assert.equal(result.executionResult.value, 42)
  assert.equal(subject.service.plusOneExecutions, 0)
  assert.deepEqual(result.postDecision.additionalContexts?.[0]?.content, [
    { type: 'text', text: 'bounded policy\n' },
  ])
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('prerequisite')
      && !spec.argv.includes('commit-prerequisite')).length,
    2,
  )
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
})

test('malformed prerequisite decisions deny before policy and tool execution', async () => {
  const subject = harness({ prerequisiteBeginMalformed: true })
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const denied = await subject.invoke({ value: 41 }, { callId: 'malformed-prerequisite' })
  assert.equal(denied.result.kind, 'deny')
  assert.equal(denied.delegated, false)
  assert.match(denied.result.reason, /prerequisite-unavailable/)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('dispatch')),
    false,
  )
})

test('nested and code-mode-shaped calls use the same execution-bound prerequisite path', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  const parent = Symbol('code-mode-parent')

  const nested = await subject.invoke({ value: 41 }, {
    callId: 'nested-call',
    rootCallId: 'code-mode-root',
    parent,
  })

  assert.equal(nested.delegated, true)
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('prerequisite')
      && !spec.argv.includes('commit-prerequisite')).length,
    3,
  )
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    1,
  )
  const ingress = subject.spawnSpecs
    .filter(spec => spec.argv.includes('dispatch'))
    .map(spec => JSON.parse(spec.stdio.stdin.data))
    .find(candidate => candidate.event === 'tools/pre-execute')
  assert.equal(ingress.schema_version, 'agent-hook.dsh-ingress.v5')
  assert.equal(ingress.call_id, 'nested-call')
})

test('prerequisite registration disposers cannot remove a newer declaration', async () => {
  const subject = harness()
  const custom = Object.freeze({
    name: 'custom_mutator',
    async execute() { return { value: 42 } },
  })
  subject.ctx.tools.register(custom)
  const disposeFirst = subject.service.prerequisites.require(
    custom,
    'project-dev-context',
  )
  const disposeSecond = subject.service.prerequisites.require(
    custom,
    'project-dev-context',
  )

  disposeFirst()
  const retained = await subject.invoke({}, {
    callId: 'custom-retained',
    name: 'custom_mutator',
  })
  disposeSecond()
  const removed = await subject.invoke({}, {
    callId: 'custom-removed',
    name: 'custom_mutator',
  })

  assert.equal(retained.delegated, true)
  assert.equal(removed.delegated, true)
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('prerequisite')
      && !spec.argv.includes('commit-prerequisite')).length,
    3,
  )
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    1,
  )
})

test('removing a prerequisite after admission tombstones the selected definition', async () => {
  const subject = harness()
  let bodies = 0
  const custom = Object.freeze({
    name: 'late_dispose_mutator',
    async execute() {
      bodies += 1
      return { value: 42 }
    },
  })
  subject.ctx.tools.register(custom)
  const dispose = subject.service.prerequisites.require(
    custom,
    'project-dev-context',
  )

  const invalidated = await subject.invoke({}, {
    name: 'late_dispose_mutator',
    beforeExecute() { dispose() },
  })

  assert.equal(invalidated.executionResult.isError, true)
  assert.equal(bodies, 0)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )

  const fresh = await subject.invoke({}, {
    name: 'late_dispose_mutator',
    callId: 'late-dispose-fresh',
  })
  assert.equal(fresh.executionResult.isError, false)
  assert.equal(bodies, 1)
})

test('execute wrappers cannot hide requirement or workspace identity drift around the body', async () => {
  for (const drift of ['requirement', 'cwd']) {
    const subject = harness()
    let bodies = 0
    const custom = Object.freeze({
      name: `wrapper_drift_${drift}`,
      async execute() { bodies += 1; return { value: 42 } },
    })
    subject.ctx.tools.register(custom)
    const dispose = subject.service.prerequisites.require(custom, 'project-dev-context')
    subject.ctx.on('tools/execute', async (exec, next) => {
      const originalCwd = exec.agent.session.header.cwd
      if (drift === 'requirement') dispose()
      else exec.agent.session.header.cwd = '/tmp/substituted-workspace'
      try {
        return await next()
      } finally {
        exec.agent.session.header.cwd = originalCwd
      }
    })

    const result = await subject.invoke({}, {
      name: custom.name,
      callId: `wrapper-drift-${drift}`,
    })

    assert.equal(result.executionResult.isError, true, drift)
    assert.equal(bodies, 0, drift)
    assert.equal(
      subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
      false,
      drift,
    )
  }
})

test('a replaced visible definition cannot reuse or commit an execution prerequisite', async () => {
  const subject = harness()
  const original = subject.tool('runtime_kit_plus_one')
  subject.service.prerequisites.require(
    original,
    'project-dev-context',
  )

  const substituted = await subject.invoke({ value: 41 }, {
    beforeExecute() {
      subject.ctx.tools.register({
        ...subject.tool('runtime_kit_plus_one'),
        execute: async () => ({ value: 99 }),
      })
      assert.notEqual(
        subject.ctx.tools.get('runtime_kit_plus_one', subject.agent),
        original,
      )
    },
  })
  assert.equal(substituted.delegated, false)
  assert.equal(subject.service.plusOneExecutions, 0)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
  assert.equal(substituted.executionResult.isError, true)
  assert.equal(subject.service.pendingPrerequisites, 0)

  const recovered = await subject.invoke({ value: 42 }, { callId: 'replacement-retry' })
  assert.equal(recovered.delegated, true)
  const ingressDefinitions = subject.spawnSpecs
    .filter(spec => spec.argv.includes('dispatch'))
    .map(spec => JSON.parse(spec.stdio.stdin.data))
    .filter(candidate => candidate.event === 'tools/pre-execute')
    .map(candidate => candidate.tool.definition_id)
  assert.equal(ingressDefinitions.length, 2)
  assert.notEqual(ingressDefinitions[0], ingressDefinitions[1])
})

test('approval rejection cancellation and downstream exceptions abandon pending prerequisites', async () => {
  for (const run of [
    subject => subject.invoke(
      { value: 41 },
      { downstreamDecision: { kind: 'ask' }, askOutcome: 'denied' },
    ),
    subject => {
      const controller = new AbortController()
      return subject.invoke({ value: 41 }, {
        signal: controller.signal,
        beforeExecute() { controller.abort() },
      })
    },
  ]) {
    const subject = harness()
    subject.service.prerequisites.require(
      subject.tool('runtime_kit_plus_one'),
      'project-dev-context',
    )
    const result = await run(subject)
    assert.equal(result.delegated, false)
    assert.equal(
      subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
      false,
    )
    assert.equal(subject.service.pendingPrerequisites, 0)
  }

  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  await assert.rejects(
    subject.prepare({ value: 41 }, {
      downstreamDecision() { throw new Error('later waterfall failed') },
    }),
    /later waterfall failed/,
  )
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
  assert.equal(subject.service.pendingPrerequisites, 0)
})

test('downstream execute veto and cancellation do not commit a prerequisite', async () => {
  for (const installDownstream of [
    subject => subject.ctx.on('tools/execute', async () => ({
      isError: true,
      error: { message: 'downstream-veto' },
      content: [],
    })),
    (subject, controller) => subject.ctx.on('tools/execute', async (_exec, next) => {
      controller.abort()
      return next()
    }),
  ]) {
    const controller = new AbortController()
    const subject = harness()
    subject.service.prerequisites.require(
      subject.tool('runtime_kit_plus_one'),
      'project-dev-context',
    )
    installDownstream(subject, controller)

    const result = await subject.invoke(
      { value: 41 },
      { signal: controller.signal },
    )

    assert.equal(result.delegated, false)
    assert.equal(
      subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
      false,
    )
    assert.equal(subject.service.pendingPrerequisites, 0)
  }
})

test('prerequisite and pre and post policy contexts are all retained', async () => {
  const subject = harness({
    envelope: (spec) => {
      const ingress = spec.argv.includes('dispatch')
        ? JSON.parse(spec.stdio.stdin.data)
        : undefined
      return ingress?.event === 'tools/pre-execute'
        ? decision('context', { event: 'PreToolUse', context: 'pre policy context' })
        : ingress?.event === 'tools/post-execute'
          ? decision('context', { event: 'PostToolUse', context: 'post policy context' })
          : decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const result = await subject.invoke({ value: 41 })

  assert.deepEqual(
    result.postDecision.additionalContexts.map(context => context.content[0].text),
    ['pre policy context', 'post policy context', 'bounded policy\n'],
  )
})

test('a post-policy failure leaves the prerequisite uncommitted', async () => {
  const subject = harness({
    throwOnSpawn: (spec) => {
      if (!spec.argv.includes('dispatch')) return false
      return JSON.parse(spec.stdio.stdin.data).event === 'tools/post-execute'
    },
  })
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )

  const result = await subject.invoke({ value: 41 })

  assert.equal(result.executionResult.isError, false)
  assert.equal(result.postDecision.kind, 'block')
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
  assert.equal(result.postDecision.additionalContexts, undefined)
})

test('cancellation from the selected tool body leaves the prerequisite uncommitted', async () => {
  const controller = new AbortController()
  const subject = harness()
  const canceling = Object.freeze({
    name: 'canceling_mutator',
    async execute() {
      controller.abort()
      return { value: 42 }
    },
  })
  subject.ctx.tools.register(canceling)
  subject.service.prerequisites.require(canceling, 'project-dev-context')

  const result = await subject.invoke({}, {
    name: 'canceling_mutator',
    signal: controller.signal,
  })

  assert.equal(result.executionResult.isError, true)
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
  assert.equal(result.postDecision.additionalContexts, undefined)
})

test('a downstream post-execute failure leaves the prerequisite uncommitted', async () => {
  const subject = harness()
  subject.service.prerequisites.require(
    subject.tool('runtime_kit_plus_one'),
    'project-dev-context',
  )
  const distinctive = new Error('post-execute rejected the result')
  subject.ctx.on('tools/post-execute', async () => { throw distinctive })

  await assert.rejects(
    subject.invoke({ value: 41 }),
    error => error === distinctive,
  )
  assert.equal(
    subject.spawnSpecs.some(spec => spec.argv.includes('commit-prerequisite')),
    false,
  )
})

test('downstream post-execute exceptions preserve their exact failure', async () => {
  const subject = harness()
  const distinctive = new Error('distinctive downstream post-execute failure')
  subject.ctx.on('tools/post-execute', async () => { throw distinctive })

  await assert.rejects(
    subject.invoke({ value: 41 }),
    error => error === distinctive,
  )
})

test('policy ingress v2 binds the exact DSH session position and agent-docs roots', async () => {
  const subject = harness({
    config: {
      agentHookConfig: '/runtime/agent-hook/config.toml',
      agentHookPolicy: '/runtime/agent-hook/dsh-policy.toml',
      agentHookStateDir: '/runtime/agent-hook/state',
      agentDocsHome: '/runtime/docs',
      agentDocsStateHome: '/runtime/state',
    },
  })

  const { result } = await subject.invoke({ value: 41 }, { callId: 'call-v2' })
  assert.equal(result.kind, 'allow')
  const ingress = JSON.parse(subject.spawnSpecs[0].stdio.stdin.data)
  assert.deepEqual(ingress, {
    schema_version: 'agent-hook.dsh-ingress.v2',
    event: 'tools/pre-execute',
    call_id: 'call-v2',
    cwd: '/tmp',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
    tool: {
      name: 'runtime_kit_plus_one',
      arguments: { value: 41 },
    },
  })
  assert.deepEqual(subject.spawnSpecs[0].argv, [
    '/test/agent-hook',
    '--config', '/runtime/agent-hook/config.toml',
    '--policy', '/runtime/agent-hook/dsh-policy.toml',
    '--state-dir', '/runtime/agent-hook/state',
    'dispatch', '--product', 'dsh', '--format', 'json',
  ])
})

test('policy ingress uses the authenticated managed worker principal for a bridged DSH child', async () => {
  const managedSessionBridge = createManagedSessionBridge()
  managedSessionBridge.register(sessionId => sessionId === 'session-1'
    ? {
        sessionId: 'worker-one',
        environment: {
          AGENT_SESSION_ID: 'worker-one',
          AGENT_SESSION_CAPABILITY_FILE: '/private/capability',
          AGENT_SESSION_STATE_DIR: '/private/state',
          AGENT_SESSION_BIN: '/private/bin/agent-session',
        },
      }
    : undefined)
  const subject = harness({ config: { managedSessionBridge } })

  const { result } = await subject.invoke({ value: 41 }, { callId: 'call-bridged' })
  assert.equal(result.kind, 'allow')
  const ingress = JSON.parse(subject.spawnSpecs[0].stdio.stdin.data)
  assert.equal(ingress.subject.session_id, 'worker-one')
  assert.equal(subject.spawnSpecs[0].env.AGENT_SESSION_ID, 'worker-one')
  assert.equal(subject.spawnSpecs[0].env.AGENT_SESSION_BIN, '/private/bin/agent-session')
  assert.equal(
    subject.spawnSpecs[0].env.DSH_RUNTIME_KIT_PROVIDER_SESSION_ID,
    'session-1',
    'activity correlation keeps the DSH provider session separate from the owner principal',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      subject.spawnSpecs[0].env,
      'AGENT_SESSION_CAPABILITY_FILE',
    ),
    true,
  )
})

test('post-tool ingress v4 sends only the terminal fact and blocks before downstream on lifecycle denial', async () => {
  const seen = []
  const subject = harness({
    config: {
      agentDocsHome: '/runtime/docs',
      agentDocsStateHome: '/runtime/state',
    },
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      seen.push(ingress)
      return ingress.event === 'tools/post-execute'
        ? decision('block', { event: 'PostToolUse' })
        : decision('allow', { event: 'PreToolUse' })
    },
  })
  const prepared = await subject.prepare({ value: 41 }, { callId: 'call-v4' })
  assert.equal(prepared.result.kind, 'allow')
  let delegated = false
  const post = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, {
      isError: false,
      value: { private: 'must-never-reach-agent-hook' },
      content: [{ type: 'text', text: 'must-never-reach-agent-hook' }],
    }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(post.kind, 'block')
  assert.match(post.feedback[0].text, /agent-hook:blocked/)
  const postIngress = seen.find(ingress => ingress.event === 'tools/post-execute')
  assert.deepEqual(postIngress, {
    schema_version: 'agent-hook.dsh-ingress.v4',
    event: 'tools/post-execute',
    call_id: 'call-v4',
    cwd: '/tmp',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
    tool: {
      name: 'runtime_kit_plus_one',
      arguments: { value: 41 },
    },
    result: { is_error: false },
  })
  assert.doesNotMatch(JSON.stringify(postIngress), /must-never-reach-agent-hook/)
})

test('the first accepted pre-step receives one bounded native lifecycle context', async () => {
  const subject = harness({
    config: { agentDocsStateHome: '/runtime/state' },
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      assert.equal(ingress.event, 'agent/pre-step')
      return decision('context', {
        event: 'UserPromptSubmit',
        context: 'startup health and memory context',
      })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'build a high-impact feature' }],
  }
  const payload = {
    agent: subject.agent,
    messages: [userMessage],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  const first = await subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  const duplicate = await subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )

  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.kind, 'plugin')
  assert.equal(first.messages[1].source.plugin, 'dsh-runtime-kit')
  assert.equal(first.messages[1].content[0].text, 'startup health and memory context')
  assert.deepEqual(duplicate, { kind: 'enter', messages: [userMessage] })
  assert.equal(subject.spawnCount, 1)
  assert.deepEqual(JSON.parse(subject.spawnSpecs[0].stdio.stdin.data), {
    schema_version: 'agent-hook.dsh-ingress.v3',
    event: 'agent/pre-step',
    cwd: '/tmp',
    prompt: 'build a high-impact feature',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      session_start_source: 'startup',
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
  })
})

test('post-tool transport denial blocks before downstream when completion is unobserved', async () => {
  const subject = harness({
    throwOnSpawn: (spec) => {
      if (!spec.argv.includes('dispatch')) return false
      return JSON.parse(spec.stdio.stdin.data).event === 'tools/post-execute'
    },
  })
  const prepared = await subject.prepare({ value: 41 }, { callId: 'call-v4-transport' })
  assert.equal(prepared.result.kind, 'allow')
  let delegated = false
  const post = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, { isError: false, value: 42, content: [] }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(post.kind, 'block')
  assert.match(post.feedback[0].text, /policy-unavailable/)
})

test('a concurrent duplicate waits for an accepted pre-step instead of bypassing lifecycle context', async () => {
  const subject = harness({
    pending: true,
    envelope: () => decision('context', {
      event: 'UserPromptSubmit',
      context: 'serialized lifecycle context',
    }),
  })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'build it' }],
  }
  const payload = {
    agent: subject.agent,
    messages: [userMessage],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const first = subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  const second = subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 1)

  subject.release(0)
  const accepted = await first
  const duplicate = await second
  assert.equal(accepted.kind, 'enter')
  assert.equal(accepted.messages.length, 2)
  assert.equal(accepted.messages[1].content[0].text, 'serialized lifecycle context')
  assert.deepEqual(duplicate, { kind: 'enter', messages: [userMessage] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 1)
})

test('lifecycle ingress evaluates only the downstream-accepted user messages', async () => {
  for (const [acceptedMessages, expectedPrompt] of [
    [[{
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'accepted replacement' }],
    }], 'accepted replacement'],
    [[], ''],
  ]) {
    const subject = harness({
      envelope: (spec) => {
        const ingress = JSON.parse(spec.stdio.stdin.data)
        assert.equal(ingress.prompt, expectedPrompt)
        assert.notEqual(ingress.prompt, 'superseded prompt canary')
        return decision('allow', { event: 'UserPromptSubmit' })
      },
    })
    subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
    const payload = {
      agent: subject.agent,
      messages: [{
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'superseded prompt canary' }],
      }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    const result = await subject.waterfall(
      'agent/pre-step',
      [payload],
      async () => ({ kind: 'enter', messages: acceptedMessages }),
    )
    assert.deepEqual(result, { kind: 'enter', messages: acceptedMessages })
    assert.equal(subject.spawnCount, 1)
  }
})

test('same-position deduplication binds the accepted prompt digest sequentially and concurrently', async () => {
  const makeMessage = text => ({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
  const payloadFor = subject => ({
    agent: subject.agent,
    messages: [makeMessage('proposal')],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  })

  const sequentialPrompts = []
  const sequential = harness({
    envelope: (spec) => {
      sequentialPrompts.push(JSON.parse(spec.stdio.stdin.data).prompt)
      return decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  sequential.emit('agent/session-start', { agent: sequential.agent, source: 'startup' })
  for (const prompt of ['safe accepted text', 'changed accepted text']) {
    const messages = [makeMessage(prompt)]
    const result = await sequential.waterfall(
      'agent/pre-step',
      [payloadFor(sequential)],
      async () => ({ kind: 'enter', messages }),
    )
    assert.deepEqual(result, { kind: 'enter', messages })
  }
  assert.deepEqual(sequentialPrompts, ['safe accepted text', 'changed accepted text'])
  assert.equal(sequential.spawnCount, 2)

  const concurrentPrompts = []
  const concurrent = harness({
    pending: true,
    envelope: (spec) => {
      concurrentPrompts.push(JSON.parse(spec.stdio.stdin.data).prompt)
      return decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  concurrent.emit('agent/session-start', { agent: concurrent.agent, source: 'startup' })
  const first = concurrent.waterfall(
    'agent/pre-step',
    [payloadFor(concurrent)],
    async () => ({ kind: 'enter', messages: [makeMessage('concurrent safe')] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  const second = concurrent.waterfall(
    'agent/pre-step',
    [payloadFor(concurrent)],
    async () => ({ kind: 'enter', messages: [makeMessage('concurrent changed')] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(concurrent.spawnCount, 1)
  concurrent.release(0)
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(concurrent.spawnCount, 2)
  concurrent.release(1)
  await second
  assert.deepEqual(concurrentPrompts, ['concurrent safe', 'concurrent changed'])
})

test('lifecycle prompt projection is UTF-8 bounded and malformed advisory output fails open', async () => {
  let observedPrompt
  const subject = harness({
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      observedPrompt = ingress.prompt
      return decision('context', {
        event: 'UserPromptSubmit',
        context: 'x'.repeat(16 * 1024 + 1),
      })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '好'.repeat(30_000) }],
  }
  const result = await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [userMessage],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )

  assert.equal(Buffer.byteLength(observedPrompt, 'utf8') <= 64 * 1024, true)
  assert.doesNotMatch(observedPrompt, /\uFFFD/)
  assert.deepEqual(result, { kind: 'enter', messages: [userMessage] })
})

test('native tool advisory context is delivered after the exact tool result', async () => {
  const subject = harness({
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'tools/pre-execute'
        ? decision('context', {
            event: 'PreToolUse',
            context: 'apply the portable output reminder',
          })
        : decision('allow', {
            event: ingress.event === 'tools/post-execute' ? 'PostToolUse' : 'UserPromptSubmit',
          })
    },
  })
  const invocation = await subject.invoke({ value: 41 })

  assert.equal(invocation.result.kind, 'allow')
  assert.equal(invocation.delegated, true)
  assert.equal(invocation.postDecision.kind, 'accept')
  assert.equal(invocation.postDecision.additionalContexts.length, 1)
  assert.deepEqual(invocation.postDecision.additionalContexts[0].content, [
    { type: 'text', text: 'apply the portable output reminder' },
  ])
  assert.deepEqual(invocation.postDecision.additionalContexts[0].source, {
    kind: 'plugin',
    plugin: 'dsh-runtime-kit',
  })
})

function bashFinishLineEnvelope({
  actions = [],
  probeStatus = 'ordinary-ready',
  probeOperationId,
  policyAction = 'allow',
} = {}) {
  return (spec) => {
    const finishLineIndex = spec.argv.indexOf('finish-line')
    if (finishLineIndex < 0) return decision(policyAction)
    const action = spec.argv[finishLineIndex + 1]
    actions.push(action)
    const request = JSON.parse(spec.stdio.stdin.data)
    if (action === 'open') {
      return {
        schema_version: 'cli.agent-hook.finish-line-open.v1',
        ok: true,
        data: {
          schema_version: 'agent-hook.finish-line.open-result.v1',
          status: 'opened',
          runner_capability: 'runner:opaque',
          correlation_id: 'correlation:opaque',
        },
      }
    }
    if (action === 'release') {
      return {
        schema_version: 'cli.agent-hook.finish-line-release.v1',
        ok: true,
        data: {
          schema_version: 'agent-hook.finish-line.release-result.v1',
          status: 'released',
          correlation_id: 'correlation:opaque',
        },
      }
    }
    return {
      schema_version: 'cli.agent-hook.finish-line-run.v1',
      ok: true,
      data: {
        schema_version: 'agent-hook.finish-line.run-result.v1',
        status: probeStatus,
        operation_id: probeOperationId ?? request.operation_id,
        correlation_id: 'correlation:opaque',
      },
    }
  }
}

test('an exact declared validation reaches finish-line before opaque shell policy', async () => {
  const finishLineActions = []
  let preExecutePolicies = 0
  const subject = harness({
    envelope: (spec) => {
      const finishLineIndex = spec.argv.indexOf('finish-line')
      if (finishLineIndex >= 0) {
        const action = spec.argv[finishLineIndex + 1]
        finishLineActions.push(action)
        const request = JSON.parse(spec.stdio.stdin.data)
        if (action === 'open') {
          return {
            schema_version: 'cli.agent-hook.finish-line-open.v1',
            ok: true,
            data: {
              schema_version: 'agent-hook.finish-line.open-result.v1',
              status: 'opened',
              runner_capability: 'runner:opaque',
              correlation_id: 'correlation:opaque',
            },
          }
        }
        if (action === 'run' && request.execution === undefined) {
          return {
            schema_version: 'cli.agent-hook.finish-line-run.v1',
            ok: true,
            data: {
              schema_version: 'agent-hook.finish-line.run-result.v1',
              status: 'ready',
              operation_id: request.operation_id,
              correlation_id: 'correlation:opaque',
            },
          }
        }
        if (action === 'run') {
          return {
            schema_version: 'cli.agent-hook.finish-line-run.v1',
            ok: true,
            data: {
              schema_version: 'agent-hook.finish-line.run-result.v1',
              status: 'applied',
              operation_id: request.operation_id,
              generation: 1,
              correlation_id: 'correlation:opaque',
              execution: {
                exit_code: 0,
                signal: null,
                timed_out: false,
                aborted: false,
                timeout_ms: request.timeout_ms,
                stdout: { text: 'validated\n', truncated: false },
                stderr: { text: '', truncated: false },
                sandbox: { mode: 'danger-full-access', denied: false },
              },
            },
          }
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event === 'tools/pre-execute') {
        preExecutePolicies += 1
        return decision('block')
      }
      return decision('allow', {
        event: ingress.event === 'tools/post-execute' ? 'PostToolUse' : 'UserPromptSubmit',
      })
    },
  })
  subject.ctx.tools.register(Object.freeze({
    name: 'bash',
    async execute() { throw new Error('finish-line should own declared validation execution') },
  }))

  const invocation = await subject.invoke({
    command: 'bash scripts/ci/all.sh',
    description: 'Run the exact repository validation',
  }, { name: 'bash' })

  assert.equal(invocation.result.kind, 'allow')
  assert.equal(invocation.delegated, false)
  assert.equal(invocation.executionResult.isError, false)
  assert.equal(invocation.executionResult.value.exitCode, 0)
  assert.equal(preExecutePolicies, 0)
  assert.deepEqual(invocation.postDecision.additionalContexts?.[0]?.content, [
    { type: 'text', text: 'bounded policy\n' },
  ])
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('prerequisite')
      && !spec.argv.includes('commit-prerequisite')).length,
    2,
  )
  assert.equal(
    subject.spawnSpecs.filter(spec => spec.argv.includes('commit-prerequisite')).length,
    1,
  )
  assert.deepEqual(finishLineActions, ['open', 'run', 'run'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
})

test('an ordinary shell script remains subject to generic policy after finish-line probing', async () => {
  const finishLineActions = []
  let preExecutePolicies = 0
  const subject = harness({
    envelope: (spec) => {
      const finishLineIndex = spec.argv.indexOf('finish-line')
      if (finishLineIndex >= 0) {
        const action = spec.argv[finishLineIndex + 1]
        finishLineActions.push(action)
        const request = JSON.parse(spec.stdio.stdin.data)
        if (action === 'open') {
          return {
            schema_version: 'cli.agent-hook.finish-line-open.v1',
            ok: true,
            data: {
              schema_version: 'agent-hook.finish-line.open-result.v1',
              status: 'opened',
              runner_capability: 'runner:opaque',
              correlation_id: 'correlation:opaque',
            },
          }
        }
        return {
          schema_version: 'cli.agent-hook.finish-line-run.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.run-result.v1',
            status: 'ordinary-ready',
            operation_id: request.operation_id,
            correlation_id: 'correlation:opaque',
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event === 'tools/pre-execute') {
        preExecutePolicies += 1
        return decision('block')
      }
      return decision('allow')
    },
  })
  subject.ctx.tools.register(Object.freeze({
    name: 'bash',
    async execute() { return { exitCode: 0 } },
  }))

  const invocation = await subject.invoke({
    command: 'bash arbitrary.sh',
    description: 'Run an arbitrary shell script',
  }, { name: 'bash' })

  assert.equal(invocation.result.kind, 'deny')
  assert.equal(invocation.delegated, false)
  assert.equal(preExecutePolicies, 1)
  assert.deepEqual(finishLineActions, ['open', 'run'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
})

test('ordinary Bash projects an omitted workdir to the session cwd across policy ingress', async () => {
  const policyIngresses = []
  const subject = harness({
    envelope: (spec) => {
      const finishLineIndex = spec.argv.indexOf('finish-line')
      if (finishLineIndex >= 0) {
        const action = spec.argv[finishLineIndex + 1]
        const request = JSON.parse(spec.stdio.stdin.data)
        if (action === 'open') {
          return {
            schema_version: 'cli.agent-hook.finish-line-open.v1',
            ok: true,
            data: {
              schema_version: 'agent-hook.finish-line.open-result.v1',
              status: 'opened',
              runner_capability: 'runner:opaque',
              correlation_id: 'correlation:opaque',
            },
          }
        }
        return {
          schema_version: 'cli.agent-hook.finish-line-run.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.run-result.v1',
            status: 'ordinary-ready',
            operation_id: request.operation_id,
            correlation_id: 'correlation:opaque',
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event === 'tools/pre-execute'
        || ingress.event === 'tools/post-execute') {
        policyIngresses.push(ingress)
      }
      return decision('allow', {
        event: ingress.event === 'tools/post-execute'
          ? ingress.result?.is_error === true ? 'PostToolUseFailure' : 'PostToolUse'
          : 'PreToolUse',
      })
    },
  })
  subject.ctx.tools.register(Object.freeze({
    name: 'bash',
    async execute() { return { exitCode: 0 } },
  }))
  const arguments_ = Object.freeze({
    command: 'pwd',
    description: 'Show current directory',
  })

  const invocation = await subject.invoke(arguments_, { name: 'bash' })

  assert.equal(invocation.result.kind, 'allow')
  assert.equal(policyIngresses.length >= 2, true)
  assert.equal(
    policyIngresses.every(ingress => ingress.tool.arguments.workdir === '/tmp'),
    true,
  )
  assert.equal(invocation.exec.arguments, arguments_)
  assert.equal(Object.hasOwn(arguments_, 'workdir'), false)
})

test('a mismatched Bash finish-line probe cannot bypass policy or retain correlation state', async () => {
  const actions = []
  const subject = harness({
    envelope: bashFinishLineEnvelope({
      actions,
      probeStatus: 'ready',
      probeOperationId: 'operation:substituted',
      policyAction: 'block',
    }),
  })

  const invocation = await subject.invoke({
    command: 'bash scripts/ci/all.sh',
    description: 'Run the exact repository validation',
  }, { name: 'bash' })

  assert.equal(invocation.result.kind, 'deny')
  assert.equal(invocation.delegated, false)
  assert.deepEqual(actions, ['open', 'run'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('a substituted Bash execution identity cannot consume a probed validation', async () => {
  const actions = []
  const subject = harness({
    envelope: bashFinishLineEnvelope({ actions, probeStatus: 'ready' }),
  })

  const invocation = await subject.invoke({
    command: 'bash scripts/ci/all.sh',
    description: 'Run the exact repository validation',
  }, {
    name: 'bash',
    beforeExecute(exec) { exec.token = Symbol('substituted-validation-token') },
  })

  assert.equal(invocation.delegated, false)
  assert.equal(invocation.executionResult.isError, true)
  assert.match(invocation.executionResult.error.message, /finish-line validation correlation invalid/)
  assert.deepEqual(actions, ['open', 'run'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('ordinary Bash downstream denial and failure clear the prepared finish-line probe', async () => {
  for (const downstream of ['deny', 'throw']) {
    const actions = []
    const subject = harness({ envelope: bashFinishLineEnvelope({ actions }) })
    const invoke = () => subject.invoke({
      command: 'bash arbitrary.sh',
      description: 'Run an arbitrary shell script',
    }, {
      name: 'bash',
      downstreamDecision: downstream === 'deny'
        ? { kind: 'deny', reason: 'downstream-denial' }
        : () => { throw new Error('downstream-failure') },
    })

    if (downstream === 'deny') {
      const invocation = await invoke()
      assert.equal(invocation.result.kind, 'deny')
      assert.equal(invocation.delegated, false)
    } else {
      await assert.rejects(invoke(), /downstream-failure/)
    }
    assert.deepEqual(actions, ['open', 'run'], downstream)
    assert.equal(subject.service.activeFinishLineReservations, 0, downstream)
    assert.equal(subject.service.pendingPolicyMarkers, 0, downstream)
    assert.equal(subject.service.pendingCorrelations, 0, downstream)
  }
})

test('caller abort during ordinary Bash policy evaluation clears the prepared probe', async () => {
  const actions = []
  const subject = harness({
    envelope: bashFinishLineEnvelope({ actions }),
    pending: spec => {
      if (!spec.argv.includes('dispatch')) return false
      return JSON.parse(spec.stdio.stdin.data).event === 'tools/pre-execute'
    },
  })
  const controller = new AbortController()
  const invocation = subject.invoke({
    command: 'bash arbitrary.sh',
    description: 'Run an arbitrary shell script',
  }, { name: 'bash', signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller stopped'))
  const result = await invocation

  assert.equal(result.result.kind, 'deny')
  assert.match(result.result.reason, /policy-caller-aborted/)
  assert.equal(result.delegated, false)
  assert.deepEqual(actions, ['open', 'run'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('disposal releases an ordinary Bash capability while generic policy is pending', async () => {
  const actions = []
  const subject = harness({
    envelope: bashFinishLineEnvelope({ actions }),
    pending: spec => {
      if (!spec.argv.includes('dispatch')) return false
      return JSON.parse(spec.stdio.stdin.data).event === 'tools/pre-execute'
    },
  })
  const invocation = subject.invoke({
    command: 'bash arbitrary.sh',
    description: 'Run an arbitrary shell script',
  }, { name: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.service.activeFinishLineReservations, 1)

  await Promise.all([subject.dispose(), invocation])

  assert.deepEqual(actions, ['open', 'run', 'release'])
  assert.equal(subject.service.activeFinishLineReservations, 0)
  assert.equal(subject.service.finishLineDegraded, false)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('stop advisory is steered once only after the authoritative finish-line allows', async () => {
  const subject = harness({
    envelope: (spec) => {
      if (spec.argv.includes('finish-line')) {
        return {
          schema_version: 'cli.agent-hook.finish-line-stop.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.stop-result.v1',
            action: 'allow',
            generation: 0,
            contract_digest: 'contract-1',
            correlation_id: 'correlation-1',
            reason_codes: [],
            remediation: [],
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'agent/turn-stopping'
        ? decision('context', { event: 'Stop', context: 'run the pre-PR check now' })
        : decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  )
  const stopping = {
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)

  assert.equal(subject.steered.length, 1)
  assert.equal(subject.steered[0].content[0].text, 'run the pre-PR check now')
  const stopIngresses = subject.spawnSpecs
    .filter(spec => spec.argv.includes('dispatch'))
    .map(spec => JSON.parse(spec.stdio.stdin.data))
    .filter(ingress => ingress.event === 'agent/turn-stopping')
  assert.equal(stopIngresses.length, 1)
  assert.equal(stopIngresses[0].subject.step, undefined)
  assert.equal(stopIngresses[0].subject.session_start_source, undefined)
})

test('stop policy transport denial steers closed and remains retryable in the same turn', async () => {
  let stopAttempts = 0
  const subject = harness({
    throwOnSpawn: (spec) => {
      if (!spec.argv.includes('dispatch')) return false
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event !== 'agent/turn-stopping') return false
      stopAttempts += 1
      return stopAttempts === 1
    },
    envelope: (spec) => {
      if (spec.argv.includes('finish-line')) {
        return {
          schema_version: 'cli.agent-hook.finish-line-stop.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.stop-result.v1',
            action: 'allow',
            generation: 0,
            contract_digest: 'contract-1',
            correlation_id: 'correlation-1',
            reason_codes: [],
            remediation: [],
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'agent/turn-stopping'
        ? decision('context', { event: 'Stop', context: 'retry reached authoritative policy' })
        : decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  )
  const stopping = {
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }

  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)

  assert.equal(stopAttempts, 2)
  assert.equal(subject.steered.length, 2)
  assert.match(subject.steered[0].content[0].text, /could not verify the stop boundary/)
  assert.equal(subject.steered[1].content[0].text, 'retry reached authoritative policy')
})

test('stop outcome distinguishes provider and transport failure without cross-session replay', async () => {
  const scenarios = [
    {
      name: 'provider-failed',
      options: {
        envelope: lifecycleStopEnvelope(() => decision('allow', {
          event: 'Stop',
          schema_version: undefined,
        })),
      },
    },
    {
      name: 'transport-failed',
      options: {
        envelope: lifecycleStopEnvelope(() => decision('allow', { event: 'Stop' })),
        pending: spec => spec.argv.includes('dispatch')
          && JSON.parse(spec.stdio.stdin.data).event === 'agent/turn-stopping',
        config: { policyTimeoutMs: 10 },
      },
    },
  ]

  for (const scenario of scenarios) {
    const subject = harness(scenario.options)
    subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
    await subject.waterfall(
      'agent/pre-step',
      [{
        agent: subject.agent,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }],
      async () => ({ kind: 'enter', messages: [] }),
    )
    subject.agent.session.events.push(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
    )
    await subject.waterfall('agent/turn-stopping', [{
      agent: subject.agent,
      turn: 1,
      signal: new AbortController().signal,
    }], async () => undefined)

    assert.equal(subject.service.stopPolicyOutcome(subject.agent, 1), scenario.name)
    assert.equal(subject.service.stopPolicyOutcome(subject.agent, 2), undefined)
    assert.equal(subject.service.stopPolicyOutcome({
      ...subject.agent,
      session: {
        id: 'foreign-session',
        header: { id: 'foreign-session', cwd: '/tmp' },
        events: [],
      },
    }, 1), undefined)
  }
})

test('governed stop cancellation terminalizes policy denials and preserves retry authority', async () => {
  const expectedFirstOutcome = {
    context: 'context',
    block: 'policy-denied',
    transport: 'capability-unavailable',
    abort: 'cancelled',
  }
  for (const scenario of ['context', 'block', 'transport', 'abort']) {
    const actions = []
    let policyCalls = 0
    let transportFailed = false
    let pendingStops = 0
    const subject = harness({
      envelope: acceptanceStopEnvelope(actions, () => {
        policyCalls += 1
        if (scenario === 'context' && policyCalls === 1) {
          return decision('context', { event: 'Stop', context: 'run the governed check' })
        }
        if (scenario === 'block' && policyCalls === 1) {
          return decision('block', { event: 'Stop' })
        }
        return decision('allow', { event: 'Stop' })
      }),
      throwOnSpawn: spec => {
        if (scenario !== 'transport' || transportFailed || !spec.argv.includes('dispatch')) {
          return false
        }
        const ingress = JSON.parse(spec.stdio.stdin.data)
        if (ingress.event !== 'agent/turn-stopping') return false
        transportFailed = true
        return true
      },
      pending: spec => {
        if (scenario !== 'abort' || !spec.argv.includes('dispatch')) return false
        const ingress = JSON.parse(spec.stdio.stdin.data)
        if (ingress.event !== 'agent/turn-stopping') return false
        pendingStops += 1
        return pendingStops === 1
      },
    })
    const plusOne = subject.tool('runtime_kit_plus_one')
    subject.acceptanceService.register({
      requirements: [{
        name: 'unit',
        validators: [{
          id: 'runtime-plus-one',
          definition: plusOne,
          execution: { kind: 'host-observed' },
        }],
      }],
      invalidators: [],
    })
    subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
    await subject.waterfall(
      'agent/pre-step',
      [{
        agent: subject.agent,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }],
      async () => ({ kind: 'enter', messages: [] }),
    )
    subject.agent.session.events.push(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
    )
    const firstController = new AbortController()
    const firstStop = subject.waterfall('agent/turn-stopping', [{
      agent: subject.agent,
      turn: 1,
      signal: firstController.signal,
    }], async () => undefined)
    if (scenario === 'abort') {
      await new Promise(resolve => setImmediate(resolve))
      firstController.abort(new Error('caller stopped'))
    }
    await firstStop
    assert.equal(
      subject.service.stopPolicyOutcome(subject.agent, 1),
      expectedFirstOutcome[scenario],
      scenario,
    )
    const actionsAfterDenial = [...actions]

    await subject.waterfall('agent/turn-stopping', [{
      agent: subject.agent,
      turn: 1,
      signal: new AbortController().signal,
    }], async () => undefined)
    assert.equal(
      subject.service.stopPolicyOutcome(subject.agent, 1),
      scenario === 'context' ? 'context' : 'allow',
      scenario,
    )
    try {
      subject.acceptanceService.assertGoalCompletion(
        subject.agent,
        { id: 'goal', revision: 1 },
      )
    } catch (error) {
      throw new Error(`${scenario}: goal completion unavailable after retry (${actions.join(',')})`, {
        cause: error,
      })
    }
    for (let attempt = 0;
      attempt < 100 && subject.service.activeAcceptanceOperations > 0;
      attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }

    assert.equal(actionsAfterDenial.includes('observe:cancelled'), true, scenario)
    assert.equal(actionsAfterDenial.includes('release'), false, scenario)
    assert.equal(actions.filter(action => action === 'observe:cancelled').length, 1, scenario)
    assert.equal(actions.filter(action => action === 'observe:succeeded').length, 1, scenario)
    assert.equal(actions.filter(action => action === 'release').length, 1, scenario)
    assert.equal(subject.service.activeAcceptanceOperations, 0, scenario)
  }
})

test('malformed normalized decisions fail closed without delegating', async () => {
  const malformed = [
    decision('allow', { schema_version: undefined }),
    decision('allow', { request_id: undefined }),
    decision('allow', { policy_digest: 'not-a-digest' }),
    decision('allow', { reasons: 'not-an-array' }),
    decision('allow', { action: 'context' }),
    decision('allow', {
      reasons: [{ rule_id: 'contradiction', code: 'blocked', disposition: 'block' }],
    }),
    decision('allow', {
      reasons: [{ rule_id: 'unknown', code: 'unknown', disposition: 'permit' }],
    }),
    decision('block', {
      reasons: [{ rule_id: 'contradiction', code: 'allowed', disposition: 'allow' }],
    }),
  ]

  for (const envelope of malformed) {
    const subject = harness({ envelope })
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.equal(delegated, false)
    assert.match(result.reason, /policy-(output-invalid|action-unsupported)/)
  }
})

test('oversized DSH ingress is denied before spawning agent-hook', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke({
    content: '好'.repeat(400_000),
  })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-input-too-large/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('a stalled policy subprocess is terminated and fails closed on deadline', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: { policyTimeoutMs: 20 },
  })
  const started = Date.now()
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setImmediate(resolve))
  await waitForAbort(subject.signal)
  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  let settled = false
  void invocation.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  const { result, delegated } = await invocation

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-timeout/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 1)
  assert.equal(subject.signal.aborted, true)
  assert.ok(subject.terminateCount >= 1)
  assert.ok(Date.now() - started < 1_000)
})

test('policy transport and exit failures fail closed without delegating', async () => {
  const cases = [
    [harness({ stdout: '{' }), /policy-output-invalid/],
    [harness({ lossy: true }), /policy-output-invalid/],
    [harness({ missingStdout: true }), /policy-output-invalid/],
    [harness({ outcome: { exitCode: 1, signal: null } }), /policy-exit-mismatch/],
    [harness({ outcome: { exitCode: null, signal: 'SIGTERM' } }), /policy-exit-mismatch/],
    [harness({ throwOnSpawn: true }), /policy-unavailable/],
  ]

  for (const [subject, reason] of cases) {
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, reason)
    assert.equal(delegated, false)
  }

  const wrongBlockExit = harness({
    envelope: decision('block'),
    outcome: { exitCode: 0, signal: null },
  })
  const { result, delegated } = await wrongBlockExit.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-exit-mismatch/)
  assert.equal(delegated, false)
})

test('a policy response for another ingress payload cannot be replayed', async () => {
  const subject = harness({
    envelope: decision('allow', {
      request_id: 'request:0123456789abcdef0123456789abcdef',
    }),
  })
  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-output-invalid/)
  assert.equal(delegated, false)
})

test('a prepended short-circuit allow cannot bypass the exact-token monotonic guard', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { shortCircuit: true },
  )

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('an outer waterfall cannot reverse an authoritative nils denial', async () => {
  const subject = harness({ envelope: decision('block') })
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { reversePolicyDenial: true },
  )
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /agent-hook:blocked/)
  assert.equal(delegated, false)
})

test('policy denials report only blocking reasons from the normalized decision', async () => {
  const subject = harness({
    envelope: decision('block', {
      reasons: [
        {
          rule_id: 'dsh.owner-unclaimed',
          code: 'owner-unclaimed',
          disposition: 'allow',
        },
        {
          rule_id: 'dsh.semantic-conflict',
          code: 'semantic-conflict',
          disposition: 'allow',
        },
        {
          rule_id: 'dsh.pre-edit-intent-gate',
          code: 'pre-edit-intent-gate',
          disposition: 'block',
        },
      ],
    }),
  })

  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /agent-hook:pre-edit-intent-gate/)
  assert.doesNotMatch(result.reason, /owner-unclaimed|semantic-conflict/)
  assert.equal(delegated, false)
})

test('opaque shell fan-out denials explain the direct executable recovery path', async () => {
  const blockingCodes = [
    'block-direct-git-commit',
    'block-direct-git-worktree',
    'block-direct-pr-create',
    'block-direct-python',
    'block-unsafe-default-delivery',
    'checkout-lease-guard',
    'semantic-commit-body-gate',
  ]
  const subject = harness({
    envelope: decision('block', {
      reasons: blockingCodes.map(code => ({
        rule_id: `dsh.${code}`,
        code,
        disposition: 'block',
      })),
    }),
  })

  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /blocked before command dispatch/i)
  assert.match(result.reason, /run executable repository scripts directly/i)
  assert.match(result.reason, /without a bash\/sh wrapper/i)
  assert.match(result.reason, /split compound operations into separate tool calls/i)
  for (const code of blockingCodes) assert.match(result.reason, new RegExp(code))
  assert.equal(delegated, false)

  const partialCodes = blockingCodes.slice(1)
  const partialSubject = harness({
    envelope: decision('block', {
      reasons: partialCodes.map(code => ({
        rule_id: `dsh.${code}`,
        code,
        disposition: 'block',
      })),
    }),
  })
  const partial = await partialSubject.invoke({ value: 41 })

  assert.equal(partial.result.kind, 'deny')
  for (const code of partialCodes) {
    assert.match(partial.result.reason, new RegExp(code))
  }
  assert.doesNotMatch(partial.result.reason, /blocked before command dispatch/i)
  assert.doesNotMatch(partial.result.reason, /run executable repository scripts directly/i)
  assert.doesNotMatch(partial.result.reason, /without a bash\/sh wrapper/i)
  assert.doesNotMatch(partial.result.reason, /split compound operations into separate tool calls/i)
  assert.equal(partial.delegated, false)
})

test('typed shell guidance is the first visible denial line and keeps policy diagnostics', async () => {
  const blockingCodes = [
    'block-direct-git-commit',
    'block-direct-git-worktree',
    'block-direct-pr-create',
    'block-direct-python',
    'block-unsafe-default-delivery',
    'checkout-lease-guard',
    'semantic-commit-body-gate',
  ]
  const context = 'The Bash tool call was blocked before command dispatch because a preceding shell-state command such as `set`, `export`, or `cd` makes later commands impossible to classify safely. Retry now with each command in a separate Bash tool call and use the tool\'s `workdir` field instead of `cd`.'
  const subject = harness({
    envelope: decision('block', {
      context,
      reasons: blockingCodes.map(code => ({
        rule_id: `dsh.${code}`,
        code,
        disposition: 'block',
      })),
    }),
  })

  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  const lines = result.reason.split('\n')
  assert.match(lines[0], /^agent-hook:blocked — /)
  assert.match(lines[0], /blocked before command dispatch/i)
  assert.match(lines[0], /Retry now/i)
  assert.equal(
    lines.filter(line => line.includes('blocked before command dispatch')).length,
    1,
  )
  for (const code of blockingCodes) assert.match(result.reason, new RegExp(code))
  assert.equal(delegated, false)
})

test('a lone unsafe default delivery denial gives an immediate inspection retry', async () => {
  const subject = harness({
    envelope: decision('block', {
      reasons: [{
        rule_id: 'dsh.block-unsafe-default-delivery',
        code: 'block-unsafe-default-delivery',
        disposition: 'block',
      }],
    }),
  })

  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  const lines = result.reason.split('\n')
  assert.match(lines[0], /^agent-hook:block-unsafe-default-delivery — /)
  assert.match(lines[0], /blocked before command dispatch/i)
  assert.match(lines[0], /Retry now/i)
  assert.match(lines[0], /one read-only command per Bash call/i)
  assert.match(lines[0], /No operator intervention is required/i)
  assert.match(result.reason, /Bash tool workdir/i)
  assert.match(result.reason, /semantic-commit commit --repo <absolute managed-worktree path>/i)
  assert.match(result.reason, /repository PR workflow/i)
  assert.equal(delegated, false)
})

test('downstream pre-execute exceptions preserve their exact rc.7 failure', async () => {
  const subject = harness()
  const distinctive = new Error('distinctive downstream pre-execute failure')
  subject.ctx.on('tools/pre-execute', async () => { throw distinctive })

  await assert.rejects(
    subject.invoke({ value: 41 }),
    error => error === distinctive,
  )
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('a later pre-execute listener cannot replace the evaluated argument object', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.arguments = { value: 99 }
    return downstream
  })

  const { result, delegated, exec } = await subject.invoke({ value: 41 })
  assert.deepEqual(exec.arguments, { value: 99 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects another attached Agent object at the same durable position', async () => {
  const subject = harness()
  const replacement = {
    id: subject.agent.id,
    session: subject.agent.session,
  }
  subject.attachAgentTools(replacement)
  subject.emit('agent/session-start', { agent: replacement, source: 'resume' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: replacement,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.agent = replacement
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a replacement Session on the evaluated Agent object', async () => {
  const subject = harness()
  const replacement = {
    id: subject.agent.session.id,
    header: { ...subject.agent.session.header },
    events: [],
  }
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.agent.session = replacement
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a substituted parent execution token', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.parent = Symbol('substituted-parent')
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a substituted cancellation signal', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.signal = new AbortController().signal
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('token substitution denies and clears stable authorization and correlation state', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.token = Symbol('substituted-token')
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('a second same-step execution cannot replay an authorization leaked by token substitution', async () => {
  const subject = harness()
  const arguments_ = { value: 41 }
  const signal = new AbortController().signal
  let originalToken
  const removeSubstitution = subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    originalToken = exec.token
    exec.token = Symbol('substituted-token')
    return downstream
  })

  const first = await subject.invoke(arguments_, { callId: 'replayed-call', signal })
  assert.equal(first.result.kind, 'deny')
  removeSubstitution()
  assert.equal(typeof originalToken, 'symbol')

  const replay = await subject.invoke(arguments_, {
    callId: 'replayed-call',
    signal,
    token: originalToken,
    shortCircuit: true,
    skipLifecycle: true,
  })
  assert.equal(replay.result.kind, 'deny')
  assert.match(replay.result.reason, /policy-marker-missing/)
  assert.equal(replay.delegated, false)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('agentless, pre-step-less, and invalid-cwd calls fail closed without spawning', async () => {
  const agentless = harness()
  const agentlessResult = await agentless.invoke({ value: 41 }, { withoutAgent: true })
  assert.match(agentlessResult.result.reason, /policy-agent-missing/)
  assert.equal(agentless.spawnCount, 0)

  const noStep = harness()
  const noStepResult = await noStep.invoke({ value: 41 }, { skipLifecycle: true })
  assert.match(noStepResult.result.reason, /policy-step-missing/)
  assert.equal(noStep.spawnCount, 0)

  const invalidCwd = harness()
  invalidCwd.agent.session.header.cwd = 'relative/path'
  const invalidCwdResult = await invalidCwd.invoke({ value: 41 })
  assert.match(invalidCwdResult.result.reason, /policy-cwd-invalid/)
  assert.equal(invalidCwd.spawnCount, 0)
})

test('allow markers are bound to one opaque execution token and consumed once', async () => {
  const subject = harness()
  const prepared = await subject.prepare({ value: 41 }, { callId: 'same-call' })
  assert.equal(prepared.result.kind, 'allow')

  const stale = {
    ...prepared.exec,
    token: Symbol('stale-token'),
  }
  assert.match(subject.guard(stale), /policy-marker-missing/)
  assert.equal(subject.guard(prepared.exec), undefined)
  assert.match(subject.guard(prepared.exec), /policy-marker-missing/)
})

test('downstream ask decisions preserve exact-token authorization through approval', async () => {
  const approved = harness()
  const approvedResult = await approved.invoke({ value: 41 }, {
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
    askOutcome: 'approved',
  })
  assert.equal(approvedResult.result.kind, 'allow')
  assert.equal(approvedResult.delegated, true)
  assert.equal(approved.service.pendingPolicyMarkers, 0)

  for (const askOutcome of ['denied', 'cancelled']) {
    const rejected = harness()
    const rejectedResult = await rejected.invoke({ value: 41 }, {
      downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
      askOutcome,
    })
    assert.equal(rejectedResult.result.kind, 'deny')
    assert.equal(rejectedResult.delegated, false)
    assert.equal(rejected.service.pendingPolicyMarkers, 0)
  }
})

test('caller abort joins the policy process tree before returning a terminal denial', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: { maxActivePolicyChecks: 1 },
  })
  const controller = new AbortController()
  const invocation = subject.invoke({ value: 41 }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller stopped'))

  let settled = false
  void invocation.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  assert.ok(subject.terminateCount >= 1)

  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  const { result, delegated } = await invocation
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-caller-aborted/)
  assert.equal(delegated, false)
  assert.equal(subject.service.activePolicyChecks, 0)
})

test('the first cancellation cause remains authoritative while quiescence is pending', async () => {
  const callerFirst = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    config: { policyTimeoutMs: 20 },
  })
  const callerController = new AbortController()
  const callerInvocation = callerFirst.invoke(
    { value: 41 },
    { signal: callerController.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  callerController.abort(new Error('caller first'))
  await new Promise(resolve => setTimeout(resolve, 30))
  callerFirst.release(0, { exitCode: null, signal: 'SIGTERM' })
  assert.match((await callerInvocation).result.reason, /policy-caller-aborted/)

  const timeoutFirst = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    config: { policyTimeoutMs: 10 },
  })
  const timeoutController = new AbortController()
  const timeoutInvocation = timeoutFirst.invoke(
    { value: 41 },
    { signal: timeoutController.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  await waitForAbort(timeoutFirst.signal)
  timeoutController.abort(new Error('caller second'))
  timeoutFirst.release(0, { exitCode: null, signal: 'SIGTERM' })
  assert.match((await timeoutInvocation).result.reason, /policy-timeout/)
})

test('policy disposal stops ingress and waits for every active process tree', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
  })
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setImmediate(resolve))

  let disposed = false
  const disposal = subject.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(subject.terminateCount >= 1)
  assert.equal(disposed, false)
  assert.equal(subject.service.activePolicyChecks, 1)

  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  await Promise.all([disposal, invocation])
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('unknown timeout quiescence returns bounded and permanently closes admission', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: { policyTimeoutMs: 10, policyTeardownTimeoutMs: 20 },
  })
  const started = Date.now()
  const invocation = subject.invoke({ value: 41 })
  const bounded = await Promise.race([
    invocation,
    new Promise(resolve => setTimeout(() => resolve(undefined), 150)),
  ])
  assert.notEqual(bounded, undefined)
  assert.ok(Date.now() - started < 150)
  assert.match(bounded.result.reason, /policy-timeout/)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)

  const rejected = await subject.invoke({ value: 42 })
  assert.match(rejected.result.reason, /policy-unavailable/)
  assert.equal(subject.spawnCount, 1)
  subject.reject(0, new Error('late provider rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('disposal is bounded when provider done and waitForExit never settle', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: { policyTimeoutMs: 30_000, policyTeardownTimeoutMs: 20 },
  })
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setImmediate(resolve))
  const started = Date.now()
  const disposal = subject.dispose()
  const bounded = await Promise.race([
    disposal,
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 150)),
  ])
  assert.notEqual(bounded, 'still-pending')
  assert.ok(Date.now() - started < 150)
  assert.match((await invocation).result.reason, /policy-disposed/)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)
  subject.reject(0, new Error('late disposal rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('unknown quiescence monotonically fails every in-flight sibling', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: {
      policyTimeoutMs: 1_000,
      policyTeardownTimeoutMs: 20,
      maxActivePolicyChecks: 2,
    },
  })
  const firstController = new AbortController()
  const first = subject.invoke(
    { value: 1 },
    { callId: 'degrading', signal: firstController.signal },
  )
  const sibling = subject.invoke({ value: 2 }, { callId: 'sibling' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 2)
  firstController.abort(new Error('first caller stopped'))

  const [firstResult, siblingResult] = await Promise.all([first, sibling])
  assert.match(firstResult.result.reason, /policy-caller-aborted/)
  assert.equal(firstResult.delegated, false)
  assert.match(siblingResult.result.reason, /policy-unavailable/)
  assert.equal(siblingResult.delegated, false)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)
})

test('transport degradation revokes an allow marker awaiting approval', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: {
      policyTimeoutMs: 1_000,
      policyTeardownTimeoutMs: 20,
      maxActivePolicyChecks: 2,
    },
  })
  const awaitingApproval = subject.prepare({ value: 41 }, {
    callId: 'awaiting-approval',
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
  })
  await new Promise(resolve => setImmediate(resolve))
  subject.release(0)
  subject.releaseTree(0)
  const authorized = await awaitingApproval
  assert.equal(authorized.result.kind, 'ask')
  assert.equal(subject.service.pendingPolicyMarkers, 1)

  const controller = new AbortController()
  const degrading = subject.invoke({ value: 42 }, {
    callId: 'degrading-while-approval-waits',
    signal: controller.signal,
    skipLifecycle: true,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('force unknown process-tree quiescence'))
  assert.match((await degrading).result.reason, /policy-caller-aborted/)
  assert.equal(subject.service.policyTransportDegraded, true)

  let bodyExecutions = 0
  const reason = subject.guard(authorized.exec)
  if (reason === undefined) bodyExecutions += 1
  assert.match(reason, /policy-unavailable/)
  assert.equal(bodyExecutions, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('the rc.7 compatibility seam wires every required public lifecycle extension', async () => {
  const subject = harness()
  assert.deepEqual(subject.listenerNames, [
    'agent/disposed',
    'agent/pre-step',
    'agent/session-start',
    'agent/turn-stopping',
    'fs/observed',
    'tools/execute',
    'tools/post-execute',
    'tools/pre-execute',
    'tools/result',
  ])

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'secret' }] }]
  const expected = { kind: 'enter', messages }
  const actual = await subject.waterfall(
    'agent/pre-step',
    [{ agent: subject.agent, messages, turn: 1, step: 1, signal: new AbortController().signal }],
    async () => expected,
  )
  assert.equal(actual, expected)

  const prepared = await subject.prepare({ value: 41 }, { callId: 'post' })
  assert.equal(prepared.result.kind, 'allow')
  const post = { kind: 'accept' }
  const postActual = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, { isError: false, value: 42, content: [] }],
    async () => post,
  )
  assert.equal(postActual, post)
  subject.emit('tools/result', prepared.exec, { isError: false, value: 42, content: [] })
})

test('a stale post-tool identity blocks without delegating the post waterfall', async () => {
  const subject = harness()
  let delegated = false
  const result = await subject.waterfall(
    'tools/post-execute',
    [{ token: Symbol('stale'), callId: 'stale', rootCallId: 'stale', name: 'runtime_kit_plus_one', arguments: {}, signal: new AbortController().signal, agent: subject.agent }, { isError: false, value: 42, content: [] }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(result.kind, 'block')
  assert.match(result.feedback[0].text, /policy-correlation-invalid/)
})

test('policy timeout and active subprocess configuration are capped', () => {
  const subject = harness({
    config: {
      policyTimeoutMs: Number.MAX_SAFE_INTEGER,
      policyTeardownTimeoutMs: Number.MAX_SAFE_INTEGER,
      maxActivePolicyChecks: Number.MAX_SAFE_INTEGER,
    },
  })
  assert.equal(subject.service.policyTimeoutMs, 30_000)
  assert.equal(subject.service.policyTeardownTimeoutMs, 10_000)
  assert.equal(subject.service.maxActivePolicyChecks, 16)
  assert.equal(subject.service.policyTransportDegraded, false)
})

test('policy subprocess concurrency rejects overload and releases slots after settlement', async () => {
  const subject = harness({ pending: true, config: { maxActivePolicyChecks: 2 } })
  const controllers = [new AbortController(), new AbortController(), new AbortController()]
  const first = subject.invoke({ value: 1 }, { callId: 'one', signal: controllers[0].signal })
  await new Promise(resolve => setImmediate(resolve))
  const second = subject.invoke(
    { value: 2 },
    { callId: 'two', signal: controllers[1].signal, skipLifecycle: true },
  )
  const overloaded = subject.invoke(
    { value: 3 },
    { callId: 'three', signal: controllers[2].signal, skipLifecycle: true },
  )
  await new Promise(resolve => setImmediate(resolve))

  try {
    assert.equal(subject.spawnCount, 2)
    const rejected = await overloaded
    assert.equal(rejected.result.kind, 'deny')
    assert.match(rejected.result.reason, /policy-overloaded/)

    subject.release(0)
    assert.equal((await first).delegated, true)
    const fourth = subject.invoke({ value: 4 }, { callId: 'four', skipLifecycle: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(subject.spawnCount, 3)
    assert.equal(subject.peakActiveHandles, 2)
    subject.release(2)
    assert.equal((await fourth).delegated, true)
  } finally {
    controllers.forEach(controller => controller.abort())
    subject.release(0)
    subject.release(1)
    subject.release(2)
    await Promise.allSettled([first, second, overloaded])
  }
})

test('high-cardinality and excessive-depth ingress are rejected without recursion or spawn', async () => {
  const broad = harness()
  const broadResult = await broad.invoke({ values: Array.from({ length: 20_000 }, () => 0) })
  assert.equal(broadResult.result.kind, 'deny')
  assert.match(broadResult.result.reason, /policy-input-too-complex/)
  assert.equal(broad.spawnCount, 0)

  const bashArguments = {
    command: 'pwd',
    description: 'Show current directory',
  }
  for (let index = 0; index < 10_001; index += 1) {
    bashArguments[`field_${String(index).padStart(5, '0')}`] = 0
  }
  Object.defineProperty(bashArguments, 'unbounded_projection', {
    enumerable: true,
    get() {
      throw new Error('Bash workdir projection exceeded the policy input bound')
    },
  })
  const broadBash = harness({ envelope: bashFinishLineEnvelope() })
  const broadBashResult = await broadBash.invoke(bashArguments, { name: 'bash' })
  assert.equal(broadBashResult.result.kind, 'deny')
  assert.match(broadBashResult.result.reason, /policy-input-too-complex/)
  assert.equal(broadBash.spawnSpecs.filter(spec => {
    if (!spec.argv.includes('dispatch')) return false
    return JSON.parse(spec.stdio.stdin.data).event === 'tools/pre-execute'
  }).length, 0)

  let nested = { value: 41 }
  for (let depth = 0; depth < 2_000; depth += 1) nested = { nested }
  const deep = harness()
  const deepResult = await deep.invoke(nested)
  assert.equal(deepResult.result.kind, 'deny')
  assert.match(deepResult.result.reason, /policy-input-too-complex/)
  assert.equal(deep.spawnCount, 0)
})
