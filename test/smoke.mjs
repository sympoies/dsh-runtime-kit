import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { applyPolicy } from '../policy.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')

assert.notEqual(
  process.env.DSH_SOURCE_ROOT,
  undefined,
  'set DSH_SOURCE_ROOT to a DeepSeek Harness source checkout',
)
assert.notEqual(
  process.env.AGENT_HOOK_BIN,
  undefined,
  'set AGENT_HOOK_BIN to the nils-cli agent-hook binary under test',
)

const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@sympoies/dsh-runtime-kit')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(manifest.files.includes('src'))
assert.deepEqual(manifest.peerDependencies, {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.7',
  '@deepseek-ai/dsh-skill-filesystem': '0.1.0-rc.7',
  '@deepseek-ai/dsh-subagent': '0.1.0-rc.7',
  '@deepseek-ai/dsh-subprocess': '0.1.0-rc.7',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.7',
})
const nilsCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'),
)
assert.equal(nilsCompatibility.schema_version, 'dsh-runtime-kit.nils-compatibility.v1')
assert.equal(nilsCompatibility.status, 'pending-release')
assert.equal(nilsCompatibility.minimum_supported_release, null)
const dshIngressCompatibility = nilsCompatibility.commands.find(
  command => command.id === 'agent-hook.dispatch.dsh',
)
assert.equal(dshIngressCompatibility?.status, 'pending-release')
assert.equal(dshIngressCompatibility?.validation, 'source-validated')
assert.deepEqual(dshIngressCompatibility?.contracts, [
  'agent-hook.dsh-ingress.v1',
  'cli.agent-hook.dispatch.v1',
  'agent-hook.normalized-decision.v1',
])
const dshManifest = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
assert.equal(dshManifest.name, '@deepseek-ai/dsh-root')
assert.equal(dshManifest.version, '0.1.0-rc.7')

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-smoke-'))
const dshHome = join(temporaryRoot, 'home')
const configHome = join(temporaryRoot, 'config')
const stateHome = join(temporaryRoot, 'state')
const policyPath = join(temporaryRoot, 'policy.toml')
const privateSkillsRoot = join(temporaryRoot, 'private-skills')
const projectWorkspace = join(temporaryRoot, 'project')
const profile = 'runtime-kit-smoke'
const marker = 'DSH_RUNTIME_KIT_SMOKE='
const skillMarker = 'DSH_RUNTIME_KIT_SKILLS='
const environment = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: join(temporaryRoot, 'empty-agents-home'),
  DSH_TELEMETRY_DISABLED: '1',
  DSH_RUNTIME_KIT_AGENT_HOOK_BIN: agentHookBin,
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: privateSkillsRoot,
  DSH_RUNTIME_KIT_SMOKE_PROJECT: projectWorkspace,
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
}

function installPolicy(action) {
  const capability = action === 'block'
    ? 'capability = { id = "decision.block.v1", reason_code = "plus-one-blocked", message = "blocked by the DSH smoke policy" }'
    : 'capability = { id = "decision.allow.v1", reason_code = "plus-one-allowed" }'
  const policy = `schema_version = "agent-hook.policy.v1"
bundle_id = "dsh-runtime-kit-smoke"
version = "2026.08.18.1"

[[rules]]
id = "dsh.plus-one"
products = ["dsh"]
events = ["PreToolUse"]
matcher = "runtime_kit_plus_one"
priority = 10
mode = "enforce"
failure_posture = "closed"
override_class = "locked"
${capability}
`
  const digest = `sha256:${createHash('sha256').update(policy).digest('hex')}`
  const configDir = join(configHome, 'agent-hook')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(policyPath, policy, { mode: 0o600 })
  writeFileSync(join(configDir, 'config.toml'), `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(policyPath)}
digest = "${digest}"
`, { mode: 0o600 })
}

function installSkill(root, name, markerText) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---
name: ${name}
description: >
  Smoke fixture for ${name}.
---

# ${name}

${markerText}
`)
}

function runDsh(args, options = {}) {
  const result = spawnSync('pnpm', ['dsh', ...args], {
    cwd: dshRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })

  assert.equal(
    result.status,
    0,
    [
      `dsh ${args.join(' ')} failed`,
      result.error?.stack ?? '',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'),
  )
  return result
}

let localDshModules

async function loadLocalDshModules() {
  if (localDshModules !== undefined) return localDshModules
  const dshRequire = createRequire(join(dshRoot, 'packages', 'core', 'agent-loop', 'package.json'))
  localDshModules = Promise.all([
    import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'llm', 'llm', 'lib', 'index.js')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'core', 'system-prompt', 'lib', 'index.js')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'core', 'tools', 'lib', 'index.js')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'core', 'agent', 'lib', 'index.js')).href),
    import(pathToFileURL(join(dshRoot, 'packages', 'core', 'agent-loop', 'lib', 'index.js')).href),
  ])
  return localDshModules
}

function stalledPolicySubprocess() {
  let resolveSpawned
  let resolveDone
  let resolveTreeExit
  const spawned = new Promise(resolve => { resolveSpawned = resolve })
  const done = new Promise(resolve => { resolveDone = resolve })
  const treeExit = new Promise(resolve => { resolveTreeExit = resolve })
  let terminateCount = 0
  let waitForExitCount = 0
  let childReleased = false
  let treeReleased = false
  return {
    service: {
      spawn(spec) {
        const payload = spec.stdio.stdin.data
        const requestId = `request:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`
        const stdout = JSON.stringify({
          schema_version: 'cli.agent-hook.dispatch.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.normalized-decision.v1',
            request_id: requestId,
            product: 'dsh',
            event: 'PreToolUse',
            action: 'allow',
            reasons: [],
            config_digest: `sha256:${'0'.repeat(64)}`,
            policy_digest: `sha256:${'0'.repeat(64)}`,
            recovery_applied: false,
          },
        })
        const handle = {
          done,
          terminate() { terminateCount += 1 },
          async waitForExit() {
            waitForExitCount += 1
            await treeExit
            return true
          },
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          },
        }
        resolveSpawned({ spec, handle })
        return handle
      },
    },
    spawned,
    releaseChild() {
      if (childReleased) return
      childReleased = true
      resolveDone({ exitCode: null, signal: 'SIGTERM' })
    },
    releaseTree() {
      if (treeReleased) return
      treeReleased = true
      resolveTreeExit()
    },
    release() {
      this.releaseChild()
      this.releaseTree()
    },
    get terminateCount() { return terminateCount },
    get waitForExitCount() { return waitForExitCount },
  }
}

function allowingPolicySubprocess() {
  let spawnCount = 0
  return {
    service: {
      spawn(spec) {
        spawnCount += 1
        const payload = spec.stdio.stdin.data
        const requestId = `request:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
          async waitForExit() { return true },
          collected: {
            stdout: {
              readFrom: () => ({
                text: JSON.stringify({
                  schema_version: 'cli.agent-hook.dispatch.v1',
                  ok: true,
                  data: {
                    schema_version: 'agent-hook.normalized-decision.v1',
                    request_id: requestId,
                    product: 'dsh',
                    event: 'PreToolUse',
                    action: 'allow',
                    reasons: [],
                    config_digest: `sha256:${'0'.repeat(64)}`,
                    policy_digest: `sha256:${'0'.repeat(64)}`,
                    recovery_applied: false,
                  },
                }),
                lossy: false,
              }),
            },
          },
        }
      },
    },
    get spawnCount() { return spawnCount },
  }
}

async function localAgentHarness(label, {
  subprocess = stalledPolicySubprocess(),
  withToolCall = true,
} = {}) {
  const [
    { Context },
    { default: LlmRuntime, LlmAdapter, CallId, createUserMessage },
    { default: SessionStore, SessionId },
    { default: SystemPrompt },
    { default: ToolRuntime },
    { default: AgentRegistry },
    { default: AgentLoop },
  ] = await loadLocalDshModules()

  function toolCallChunks() {
    const id = CallId(`${label}-call`)
    const argumentsJson = JSON.stringify({ value: 41 })
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name: 'runtime_kit_plus_one', argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'runtime_kit_plus_one', arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }

  function textChunks() {
    return [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }

  class LocalAdapter extends LlmAdapter {
    calls = 0
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }
    async *stream(options) {
      const chunks = withToolCall && this.calls++ === 0 ? toolCallChunks() : textChunks()
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('local smoke adapter aborted')
        yield chunk
      }
    }
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('subprocess', subprocess.service)
  ctx.llm.registerAdapter([`runtime-kit-${label}`], new LocalAdapter())
  const policyFiber = await ctx.plugin({
    name: `dsh-runtime-kit-${label}-policy`,
    inject: ['agents', 'subprocess', 'tools'],
    apply(inner) {
      applyPolicy(inner, { agentHook: '/stalled/agent-hook', policyTimeoutMs: 30_000 })
    },
  })
  const service = ctx.dshRuntimeKit
  const agent = ctx.agentLoop.create(
    SessionId(`dsh-runtime-kit-${label}`),
    { provider: `runtime-kit-${label}`, model: 'scripted' },
    { cwd: projectWorkspace },
  )
  const followup = () => agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'run plus one' }],
    source: { kind: 'user' },
  }))
  return { ctx, subprocess, policyFiber, service, agent, followup }
}

async function verifyRejectedLifecycleAttempts() {
  const [, { CallId }] = await loadLocalDshModules()
  for (const mode of ['reject', 'error', 'abort', 'closed-step']) {
    const subprocess = allowingPolicySubprocess()
    const subject = await localAgentHarness(`lifecycle-${mode}`, {
      subprocess,
      withToolCall: false,
    })
    try {
      if (mode === 'reject') {
        subject.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      } else if (mode === 'error') {
        subject.ctx.on('agent/pre-step', async () => {
          throw new Error('distinctive real rc.7 pre-step error')
        })
      } else if (mode === 'abort') {
        subject.ctx.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          subject.agent.cancel({ kind: 'user' })
          return decision
        })
      }

      subject.followup()
      await subject.agent.whenIdle()
      const result = await subject.ctx.tools.execute({
        callId: CallId(`lifecycle-${mode}-attempt`),
        name: 'runtime_kit_plus_one',
        arguments: { value: 41 },
        signal: new AbortController().signal,
        agent: subject.agent,
      })
      assert.equal(result.isError, true, mode)
      assert.match(result.content[0].text, /policy-correlation-invalid/, mode)
      assert.equal(subprocess.spawnCount, 0, mode)
      assert.equal(subject.service.plusOneExecutions, 0, mode)
      assert.equal(subject.service.pendingPolicyMarkers, 0, mode)
      assert.equal(subject.service.pendingCorrelations, 0, mode)
    } finally {
      await subject.ctx.root.fiber.dispose()
    }
  }
}

async function verifyCancellationAndDisposalComposition() {
  const cancelled = await localAgentHarness('cancel')
  try {
    cancelled.followup()
    await cancelled.subprocess.spawned
    assert.equal(cancelled.service.activePolicyChecks, 1)
    cancelled.agent.cancel({ kind: 'user' })
    let idle = false
    const waiting = cancelled.agent.whenIdle().then(() => { idle = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(idle, false)
    assert.ok(cancelled.subprocess.terminateCount >= 1)
    cancelled.subprocess.releaseChild()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(idle, false)
    assert.equal(cancelled.service.activePolicyChecks, 1)
    cancelled.subprocess.releaseTree()
    await waiting
    assert.equal(cancelled.service.activePolicyChecks, 0)
    assert.equal(cancelled.service.pendingPolicyMarkers, 0)
    assert.equal(cancelled.service.pendingCorrelations, 0)
    assert.equal(cancelled.service.plusOneExecutions, 0)
    assert.equal(cancelled.subprocess.waitForExitCount, 1)
  } finally {
    cancelled.subprocess.release()
    await cancelled.ctx.root.fiber.dispose()
  }

  const disposed = await localAgentHarness('dispose')
  try {
    disposed.followup()
    await disposed.subprocess.spawned
    let finished = false
    const disposal = disposed.policyFiber.dispose().then(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    assert.ok(disposed.subprocess.terminateCount >= 1)
    assert.equal(disposed.service.activePolicyChecks, 1)
    disposed.subprocess.releaseChild()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    assert.equal(disposed.service.activePolicyChecks, 1)
    disposed.subprocess.releaseTree()
    await disposal
    await disposed.agent.whenIdle()
    assert.equal(disposed.service.activePolicyChecks, 0)
    assert.equal(disposed.service.pendingPolicyMarkers, 0)
    assert.equal(disposed.service.pendingCorrelations, 0)
    assert.equal(disposed.service.plusOneExecutions, 0)
    assert.equal(disposed.subprocess.waitForExitCount, 1)
  } finally {
    disposed.subprocess.release()
    await disposed.ctx.root.fiber.dispose()
  }
}

function collectFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? collectFiles(join(directory, entry.name), relative)
      : [relative]
  })
}

try {
  mkdirSync(join(projectWorkspace, '.git'), { recursive: true })
  installSkill(privateSkillsRoot, 'bootstrap', 'private-bootstrap-marker')
  installSkill(privateSkillsRoot, 'private-only', 'private-only-marker')
  installSkill(privateSkillsRoot, 'topic-radar', 'private-topic-radar-marker')
  installSkill(join(projectWorkspace, '.agents', 'skills'), 'bootstrap', 'project-bootstrap-marker')
  installSkill(join(projectWorkspace, '.agents', 'skills'), 'project-only', 'project-only-marker')
  installPolicy('allow')
  const packed = spawnSync('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`)
  const packReceipt = JSON.parse(packed.stdout)[0]
  const packedFiles = new Set(packReceipt.files.map(file => file.path))
  const tarball = join(temporaryRoot, packReceipt.filename)
  for (const required of [
    'package.json',
    'index.js',
    'policy.js',
    'src/compat/dsh-rc7.js',
    'src/policy/index.js',
    'src/policy/nils-transport.js',
    'cordis.patch.yml',
    'compatibility/nils-cli.json',
    'docs/policies/git-delivery.md',
    'docs/policies/review-thread-convergence.md',
    'skills/bootstrap/SKILL.md',
  ]) {
    assert.ok(packedFiles.has(required), `packed artifact is missing ${required}`)
  }
  const sourceSkillFiles = collectFiles(join(projectRoot, 'skills'))
    .map(relative => `skills/${relative}`)
    .sort()
  const packedSkillFiles = [...packedFiles]
    .filter(relative => relative.startsWith('skills/'))
    .sort()
  assert.deepEqual(packedSkillFiles, sourceSkillFiles)

  for (const relative of packedFiles) {
    if (!/\.(?:js|json|md|mjs|py|sh|ya?ml)$/.test(relative)) continue
    const extracted = spawnSync('tar', ['-xOf', tarball, `package/${relative}`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(extracted.status, 0, `could not inspect packed ${relative}`)
    assert.doesNotMatch(extracted.stdout, /\bterry\b|terry-ai-tech/i)
  }
  runDsh(['plugin', '--profile', profile, 'add', tarball])

  const dump = runDsh(['--profile', profile, '--dump-config']).stdout
  assert.match(dump, /# == @sympoies\/dsh-runtime-kit/)
  assert.match(dump, /id: dsh-runtime-kit/)
  assert.match(dump, /name: '@sympoies\/dsh-runtime-kit'/)
  assert.doesNotMatch(dump, /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i)

  const driverPath = join(temporaryRoot, 'smoke-driver.mjs')
  const overlayPath = join(temporaryRoot, 'smoke.patch.yml')
  const llmModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'llm', 'llm', 'lib', 'index.js'),
  ).href
  const sessionModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js'),
  ).href
  writeFileSync(driverPath, `
import { CallId, LlmAdapter, createUserMessage } from ${JSON.stringify(llmModuleUrl)}
import { Session, SessionId } from ${JSON.stringify(sessionModuleUrl)}

export const name = 'dsh-runtime-kit-smoke-driver'
export const inject = ['agents', 'llm', 'skills', 'tools', 'dshRuntimeKit']

function toolCallResponse() {
  const id = CallId('dsh-runtime-kit-smoke-call')
  const args = JSON.stringify({ value: 41 })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'runtime_kit_plus_one', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'runtime_kit_plus_one', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class SmokeAdapter extends LlmAdapter {
  calls = 0
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options) {
    const chunks = this.calls++ === 0 ? toolCallResponse() : textResponse('done')
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('smoke adapter aborted')
      yield chunk
    }
  }
}

export function apply(ctx) {
  void (async () => {
    try {
      const skillOptions = { cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT }
      const skills = await ctx.skills.list(skillOptions)
      const bootstrap = await ctx.skills.get('bootstrap', skillOptions)
      const privateOnly = await ctx.skills.get('private-only', skillOptions)
      const projectOnly = await ctx.skills.get('project-only', skillOptions)
      const privateOverride = await ctx.skills.get('topic-radar', skillOptions)
      const bundled = await ctx.skills.get('daily-brief', skillOptions)
      process.stdout.write('${skillMarker}' + JSON.stringify({
        count: skills.length,
        names: skills.map(skill => skill.name),
        bootstrapSource: bootstrap?.source,
        bootstrapContent: bootstrap?.content,
        privateSource: privateOnly?.source,
        privateContent: privateOnly?.content,
        projectSource: projectOnly?.source,
        projectContent: projectOnly?.content,
        privateOverrideSource: privateOverride?.source,
        privateOverrideContent: privateOverride?.content,
        bundledSource: bundled?.source,
        bundledContent: bundled?.content,
      }) + '\\n')

      const targetId = 'dsh-runtime-kit-smoke-' + process.pid
      const lifecycle = []
      let preExec
      let postExec
      let finalExec
      let result
      const errors = []
      ctx.on('agent/session-start', ({ agent, source }) => {
        if (String(agent.id) === targetId) lifecycle.push('session-start:' + source)
      })
      ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
        if (String(agent.id) === targetId) lifecycle.push('pre-step:' + turn + ':' + step)
        return next()
      })
      ctx.on('tools/pre-execute', (exec, next) => {
        if (String(exec.agent?.id) !== targetId) return next()
        lifecycle.push('pre-tool')
        preExec = exec
        if (process.env.DSH_RUNTIME_KIT_SMOKE_SHORT_CIRCUIT === '1') {
          return Promise.resolve({ kind: 'allow' })
        }
        return next()
      }, { prepend: true })
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (String(exec.agent?.id) === targetId
          && process.env.DSH_RUNTIME_KIT_SMOKE_REPLACE_ARGUMENTS === '1') {
          exec.arguments = { value: 99 }
        }
        if (String(exec.agent?.id) === targetId
          && process.env.DSH_RUNTIME_KIT_SMOKE_REPLACE_SESSION === '1') {
          const current = exec.agent.session
          exec.agent.session = Session.create(SessionId(targetId), current.events, current.header)
        }
        if (String(exec.agent?.id) === targetId
          && process.env.DSH_RUNTIME_KIT_SMOKE_REPLACE_TOKEN === '1') {
          exec.token = Symbol('substituted-token')
        }
        return decision
      })
      ctx.on('tools/post-execute', (exec, _candidate, next) => {
        if (String(exec.agent?.id) === targetId) {
          lifecycle.push('post-tool')
          postExec = exec
        }
        return next()
      })
      ctx.on('tools/result', (exec, finalResult) => {
        if (String(exec.agent?.id) === targetId) {
          lifecycle.push('result')
          finalExec = exec
          result = finalResult
        }
      })
      ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        if (String(agent.id) === targetId) lifecycle.push('turn-stop:' + turn)
      })
      ctx.on('agent/error', ({ agent, turn, step, error }) => {
        if (String(agent.id) === targetId) {
          errors.push({ turn, step, message: String(error?.stack ?? error) })
        }
      })

      ctx.llm.registerAdapter(['runtime-kit-smoke'], new SmokeAdapter())
      const handle = await ctx.agents.create({
        sessionId: SessionId(targetId),
        agentOptions: { provider: 'runtime-kit-smoke', model: 'scripted' },
        meta: { cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT },
      })
      const agent = handle.agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run plus one' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      process.stdout.write('${marker}' + JSON.stringify({
        result,
        lifecycle,
        errors,
        sessionEvents: agent.session.events.map(event => event.type),
        exactCorrelation: preExec !== undefined
          && postExec?.token === preExec.token
          && finalExec?.token === preExec.token
          && finalExec.callId === preExec.callId
          && finalExec.rootCallId === preExec.rootCallId,
        plusOneExecutions: ctx.dshRuntimeKit.plusOneExecutions,
        activePolicyChecks: ctx.dshRuntimeKit.activePolicyChecks,
        pendingPolicyMarkers: ctx.dshRuntimeKit.pendingPolicyMarkers,
        pendingCorrelations: ctx.dshRuntimeKit.pendingCorrelations,
        providers: ctx.llm.listProviders().map(provider => provider.id),
        tools: ctx.tools.schemas(agent).map(tool => tool.name),
      }) + '\\n')
      const expectation = process.env.DSH_RUNTIME_KIT_SMOKE_EXPECT ?? 'allow'
      if (expectation === 'allow' && result?.value !== 42) process.exitCode = 1
      if (expectation === 'block' && !result?.isError) process.exitCode = 1
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      void ctx.root.fiber.dispose()
    }
  })()
}
`)
  writeFileSync(overlayPath, `
- insert:
    - id: dsh-runtime-kit-smoke-driver
      name: ${JSON.stringify(driverPath)}
`)

  const boot = runDsh(['--profile', profile, '--patch', overlayPath])
  const line = boot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  assert.ok(line, `missing ${marker} output:\n${boot.stdout}\n${boot.stderr}`)

  const receipt = JSON.parse(line.slice(marker.length))
  const result = receipt.result
  assert.equal(result.isError, false)
  assert.equal(result.value, 42)
  assert.deepEqual(result.content, [{ type: 'text', text: '42' }])
  assert.equal(receipt.plusOneExecutions, 1)
  assert.equal(receipt.activePolicyChecks, 0)
  assert.equal(receipt.pendingPolicyMarkers, 0)
  assert.equal(receipt.pendingCorrelations, 0)
  assert.equal(receipt.exactCorrelation, true)
  for (const laneTool of [
    'main_agent_worker_launch',
    'main_agent_worker_interrupt',
    'main_agent_lane_close',
  ]) {
    assert.ok(
      receipt.tools.includes(laneTool),
      `Main Agent Mode did not activate in real DSH: ${laneTool} is unregistered `
        + `(tools: ${receipt.tools.join(', ')})`,
    )
  }
  assert.equal(
    [...receipt.providers, ...receipt.tools]
      .some(name => /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i.test(name)),
    false,
  )
  assert.deepEqual(receipt.lifecycle, [
    'session-start:startup',
    'pre-step:1:1',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:2',
    'turn-stop:1',
  ])

  const skillLine = boot.stdout.split('\n').find(candidate => candidate.startsWith(skillMarker))
  assert.ok(skillLine, `missing ${skillMarker} output:\n${boot.stdout}\n${boot.stderr}`)
  const skillReceipt = JSON.parse(skillLine.slice(skillMarker.length))
  assert.equal(skillReceipt.count, 31)
  assert.equal(new Set(skillReceipt.names).size, 31)
  assert.equal(skillReceipt.bootstrapSource, 'project-agents')
  assert.match(skillReceipt.bootstrapContent, /project-bootstrap-marker/)
  assert.equal(skillReceipt.privateSource, 'custom')
  assert.match(skillReceipt.privateContent, /private-only-marker/)
  assert.equal(skillReceipt.projectSource, 'project-agents')
  assert.match(skillReceipt.projectContent, /project-only-marker/)
  assert.equal(skillReceipt.privateOverrideSource, 'custom')
  assert.match(skillReceipt.privateOverrideContent, /private-topic-radar-marker/)
  assert.equal(skillReceipt.bundledSource, 'bundled')
  assert.match(skillReceipt.bundledContent, /# Daily Brief/)

  installPolicy('block')
  const blockedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    { env: { ...environment, DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block' } },
  )
  const blockedLine = blockedBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(blockedLine, `missing blocked ${marker} output:\n${blockedBoot.stdout}\n${blockedBoot.stderr}`)
  const blockedReceipt = JSON.parse(blockedLine.slice(marker.length))
  const blocked = blockedReceipt.result
  assert.equal(blocked.isError, true)
  assert.equal(blocked.value, undefined)
  assert.match(blocked.content[0].text, /plus-one-blocked/)
  assert.equal(blockedReceipt.plusOneExecutions, 0)
  assert.equal(blockedReceipt.activePolicyChecks, 0)
  assert.equal(blockedReceipt.pendingPolicyMarkers, 0)
  assert.equal(blockedReceipt.pendingCorrelations, 0)
  assert.equal(blockedReceipt.exactCorrelation, true)

  installPolicy('allow')
  const shortCircuitedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block',
        DSH_RUNTIME_KIT_SMOKE_SHORT_CIRCUIT: '1',
      },
    },
  )
  const shortCircuitedLine = shortCircuitedBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    shortCircuitedLine,
    `missing short-circuit ${marker} output:\n${shortCircuitedBoot.stdout}\n${shortCircuitedBoot.stderr}`,
  )
  const shortCircuitedReceipt = JSON.parse(shortCircuitedLine.slice(marker.length))
  assert.equal(shortCircuitedReceipt.result.isError, true)
  assert.match(shortCircuitedReceipt.result.content[0].text, /policy-correlation-invalid/)
  assert.equal(shortCircuitedReceipt.plusOneExecutions, 0)
  assert.equal(shortCircuitedReceipt.activePolicyChecks, 0)
  assert.equal(shortCircuitedReceipt.pendingPolicyMarkers, 0)
  assert.equal(shortCircuitedReceipt.pendingCorrelations, 0)

  const replacedArgumentsBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block',
        DSH_RUNTIME_KIT_SMOKE_REPLACE_ARGUMENTS: '1',
      },
    },
  )
  const replacedArgumentsLine = replacedArgumentsBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    replacedArgumentsLine,
    `missing argument-replacement ${marker} output:\n${replacedArgumentsBoot.stdout}\n${replacedArgumentsBoot.stderr}`,
  )
  const replacedArgumentsReceipt = JSON.parse(replacedArgumentsLine.slice(marker.length))
  assert.equal(replacedArgumentsReceipt.result.isError, true)
  assert.match(replacedArgumentsReceipt.result.content[0].text, /policy-marker-missing/)
  assert.equal(replacedArgumentsReceipt.plusOneExecutions, 0)
  assert.equal(replacedArgumentsReceipt.activePolicyChecks, 0)
  assert.equal(replacedArgumentsReceipt.pendingPolicyMarkers, 0)
  assert.equal(replacedArgumentsReceipt.pendingCorrelations, 0)

  const replacedSessionBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block',
        DSH_RUNTIME_KIT_SMOKE_REPLACE_SESSION: '1',
      },
    },
  )
  const replacedSessionLine = replacedSessionBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    replacedSessionLine,
    `missing session-replacement ${marker} output:\n${replacedSessionBoot.stdout}\n${replacedSessionBoot.stderr}`,
  )
  const replacedSessionReceipt = JSON.parse(replacedSessionLine.slice(marker.length))
  assert.equal(replacedSessionReceipt.result.isError, true)
  assert.match(replacedSessionReceipt.result.content[0].text, /policy-correlation-invalid/)
  assert.equal(replacedSessionReceipt.plusOneExecutions, 0)
  assert.equal(replacedSessionReceipt.activePolicyChecks, 0)
  assert.equal(replacedSessionReceipt.pendingPolicyMarkers, 0)
  assert.equal(replacedSessionReceipt.pendingCorrelations, 0)

  const replacedTokenBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block',
        DSH_RUNTIME_KIT_SMOKE_REPLACE_TOKEN: '1',
      },
    },
  )
  const replacedTokenLine = replacedTokenBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    replacedTokenLine,
    `missing token-replacement ${marker} output:\n${replacedTokenBoot.stdout}\n${replacedTokenBoot.stderr}`,
  )
  const replacedTokenReceipt = JSON.parse(replacedTokenLine.slice(marker.length))
  assert.equal(replacedTokenReceipt.result.isError, true)
  assert.match(replacedTokenReceipt.result.content[0].text, /policy-correlation-invalid/)
  assert.equal(replacedTokenReceipt.plusOneExecutions, 0)
  assert.equal(replacedTokenReceipt.activePolicyChecks, 0)
  assert.equal(replacedTokenReceipt.pendingPolicyMarkers, 0)
  assert.equal(replacedTokenReceipt.pendingCorrelations, 0)

  await verifyCancellationAndDisposalComposition()
  await verifyRejectedLifecycleAttempts()

  process.stdout.write(JSON.stringify({
    ok: true,
    dshVersion: dshManifest.version,
    dshProfile: profile,
    tool: 'runtime_kit_plus_one',
    input: 41,
    output: result.value,
    policyBlockVerified: true,
    shortCircuitGuardVerified: true,
    argumentReplacementGuardVerified: true,
    sessionReplacementGuardVerified: true,
    tokenReplacementGuardVerified: true,
    lifecycleCorrelationVerified: true,
    cancellationAndDisposalVerified: true,
    rejectedLifecycleAttemptsVerified: true,
    providerRetirementVerified: true,
    nilsCompatibilityStatus: nilsCompatibility.status,
    skillCount: skillReceipt.count,
    skillPrecedenceVerified: true,
  }) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
