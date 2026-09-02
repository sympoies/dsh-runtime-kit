import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { manageDshPatch } from '../src/compat/dsh-patch.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const gitCliBin = resolve(process.env.GIT_CLI_BIN ?? '')
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

assert.notEqual(
  process.env.DSH_SOURCE_ROOT,
  undefined,
  'set DSH_SOURCE_ROOT to a clean, built DeepSeek Harness source checkout',
)
assert.notEqual(process.env.AGENT_HOOK_BIN, undefined, 'set AGENT_HOOK_BIN')
assert.notEqual(process.env.GIT_CLI_BIN, undefined, 'set GIT_CLI_BIN')
assert.equal(isAbsolute(agentHookBin), true, 'AGENT_HOOK_BIN must be absolute')
assert.equal(isAbsolute(gitCliBin), true, 'GIT_CLI_BIN must be absolute')
if (process.env.PNPM_BIN !== undefined) {
  assert.equal(isAbsolute(pnpmBin), true, 'PNPM_BIN must be absolute when supplied')
}

const dshManifest = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
assert.equal(dshManifest.name, '@deepseek-ai/dsh-root')
const compatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
)
const selectedRelease = compatibility.validated_releases?.[dshManifest.version]
assert.ok(selectedRelease, `unsupported DSH release ${dshManifest.version}`)
const patchManifest = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
)
const initialCheckout = await manageDshPatch({
  action: 'check',
  sourceRoot: dshRoot,
  patchRoot: projectRoot,
  manifest: patchManifest,
  gitBin: '/usr/bin/git',
})
assert.equal(initialCheckout.revision, selectedRelease.revision)
assert.equal(initialCheckout.after, 'patched')

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-lease-native-smoke-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const repository = join(temporaryRoot, 'repository')
const linkedWorktree = join(temporaryRoot, 'linked-worktree')
const dirtyRepository = join(temporaryRoot, 'dirty-repository')
const agentHookStateDir = join(temporaryRoot, 'agent-hook-state')
const agentHookPolicy = join(temporaryRoot, 'agent-hook-policy.toml')
const agentHookConfig = join(temporaryRoot, 'agent-hook-config.toml')
const profile = 'workspace-lease-native-smoke'
const marker = 'DSH_WORKSPACE_LEASE_NATIVE_SMOKE='
const environment = { ...process.env }
for (const name of Object.keys(environment)) {
  if (name.startsWith('AGENT_SESSION_')
    || /(?:^|_)(?:API_KEY|CREDENTIAL|CREDENTIALS|PASSWORD|SECRET|TOKEN)$/iu.test(name)) {
    delete environment[name]
  }
}
Object.assign(environment, {
  CI: 'true',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  HOME: join(temporaryRoot, 'home'),
  AGENT_HOME: join(temporaryRoot, 'agent-home'),
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  DSH_WORKSPACE_LEASE_NATIVE_ROOT: repository,
  DSH_WORKSPACE_LEASE_NATIVE_LINKED: linkedWorktree,
  DSH_WORKSPACE_LEASE_NATIVE_DIRTY: dirtyRepository,
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
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
      `${command} ${args.join(' ')} failed`,
      result.error?.stack ?? '',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'),
  )
  return result
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileBytesSnapshot(repositoryPath, relativePaths) {
  return Object.fromEntries(relativePaths.map((relativePath) => {
    const path = join(repositoryPath, relativePath)
    return [relativePath, {
      bytes: statSync(path).size,
      sha256: digestFile(path),
    }]
  }))
}

function checkoutSnapshot(repositoryPath) {
  const gitDirectory = join(repositoryPath, '.git')
  return {
    branch: run('/usr/bin/git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: repositoryPath,
    }).stdout,
    headOid: run('/usr/bin/git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryPath,
    }).stdout,
    upstream: run('/usr/bin/git', ['for-each-ref', '--format=%(upstream)', 'refs/heads/main'], {
      cwd: repositoryPath,
    }).stdout,
    head: digestFile(join(gitDirectory, 'HEAD')),
    index: digestFile(join(gitDirectory, 'index')),
    config: digestFile(join(gitDirectory, 'config')),
  }
}

function workspaceStateFiles(stateRoot, workspaceRoot) {
  const matches = []
  const pending = [stateRoot]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const metadata = statSync(path)
      if (metadata.isDirectory()) {
        pending.push(path)
        continue
      }
      if (name !== 'state.json') continue
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value?.identity?.kind === 'managed'
        && value.identity.identity?.root === workspaceRoot) matches.push(path)
    }
  }
  return matches
}

try {
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  run('/usr/bin/git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository })
  writeFileSync(join(repository, 'tracked.txt'), 'baseline\n', { mode: 0o600 })
  run('/usr/bin/git', ['add', 'tracked.txt'], { cwd: repository })
  run('/usr/bin/git', [
    '-c', 'user.name=DSH Runtime Kit',
    '-c', 'user.email=dsh-runtime-kit@example.invalid',
    'commit', '--quiet', '-m', 'test: initialize workspace fixture',
  ], { cwd: repository })
  run('/usr/bin/git', [
    'worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD',
  ], { cwd: repository })

  mkdirSync(dirtyRepository, { recursive: true, mode: 0o700 })
  run('/usr/bin/git', ['init', '--quiet', '--initial-branch=main'], { cwd: dirtyRepository })
  writeFileSync(join(dirtyRepository, 'tracked.txt'), 'base\n', { mode: 0o600 })
  run('/usr/bin/git', ['add', 'tracked.txt'], { cwd: dirtyRepository })
  run('/usr/bin/git', [
    '-c', 'user.name=DSH Runtime Kit',
    '-c', 'user.email=dsh-runtime-kit@example.invalid',
    'commit', '--quiet', '-m', 'test: initialize dirty workspace fixture',
  ], { cwd: dirtyRepository })
  const handoffAdd = run(gitCliBin, [
    'worktree', 'add', 'issue102-handoff', '--from', 'main', '--kind', 'bug', '--format', 'json',
  ], { cwd: dirtyRepository })
  const handoffWorktree = JSON.parse(handoffAdd.stdout).data.path
  assert.equal(isAbsolute(handoffWorktree), true)
  writeFileSync(join(dirtyRepository, '.gitattributes'), 'tracked.txt filter=hostile\n', { mode: 0o600 })
  run('/usr/bin/git', ['add', '.gitattributes'], { cwd: dirtyRepository })
  run('/usr/bin/git', [
    '-c', 'user.name=DSH Runtime Kit',
    '-c', 'user.email=dsh-runtime-kit@example.invalid',
    'commit', '--quiet', '-m', 'test: configure hostile filter fixture',
  ], { cwd: dirtyRepository })
  const hostileFilterMarker = join(dirtyRepository, 'filter-executed')
  const hostileFilter = join(dirtyRepository, 'hostile-filter.sh')
  writeFileSync(
    hostileFilter,
    `#!/bin/sh\n: > ${JSON.stringify(hostileFilterMarker)}\n/bin/cat\n`,
    { mode: 0o700 },
  )
  run('/usr/bin/git', ['config', 'filter.hostile.clean', hostileFilter], { cwd: dirtyRepository })
  writeFileSync(join(dirtyRepository, 'tracked.txt'), 'next\n', { mode: 0o600 })
  writeFileSync(join(dirtyRepository, 'dirty-untracked.txt'), 'must remain untouched\n', { mode: 0o600 })
  environment.DSH_WORKSPACE_LEASE_NATIVE_HANDOFF = handoffWorktree
  const dirtyCheckoutBefore = checkoutSnapshot(dirtyRepository)
  const dirtyBytesBefore = fileBytesSnapshot(dirtyRepository, [
    'tracked.txt',
    'dirty-untracked.txt',
  ])

  const policy = readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')
  const digest = `sha256:${createHash('sha256').update(policy).digest('hex')}`
  mkdirSync(agentHookStateDir, { recursive: true, mode: 0o700 })
  assert.deepEqual(workspaceStateFiles(agentHookStateDir, dirtyRepository), [])
  writeFileSync(agentHookPolicy, policy, { mode: 0o600 })
  writeFileSync(agentHookConfig, `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(agentHookPolicy)}
digest = ${JSON.stringify(digest)}
`, { mode: 0o600 })

  const packed = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], { cwd: projectRoot })
  const packReceipt = JSON.parse(packed.stdout)[0]
  const packedFiles = new Set(packReceipt.files.map(file => file.path))
  assert.ok(packedFiles.has('src/workspace-lease/index.js'))
  assert.ok(packedFiles.has('src/workspace-lease/nils-provider.js'))
  assert.ok(packedFiles.has('src/workspace-recovery/index.js'))
  assert.ok(packedFiles.has('src/workspace-recovery/nils-client.js'))
  const tarball = join(temporaryRoot, packReceipt.filename)

  run(pnpmBin, ['dsh', 'plugin', '--profile', profile, 'add', tarball])
  const profileDirectory = join(dshHome, 'profiles', profile)
  const providerModuleUrl = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
    'src',
    'workspace-lease',
    'nils-provider.js',
  )).href
  const recoveryModuleUrl = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
    'src',
    'workspace-recovery',
    'index.js',
  )).href
  const recoveryClientModuleUrl = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
    'src',
    'workspace-recovery',
    'nils-client.js',
  )).href
  const contextModuleUrl = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
    'src',
    'context',
    'index.js',
  )).href
  const llmModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'llm', 'llm', 'src', 'index.ts'),
  ).href
  const toolsModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'tools', 'src', 'index.ts'),
  ).href
  const driverPath = join(temporaryRoot, 'workspace-lease-native-driver.mjs')
  const overlayPath = join(temporaryRoot, 'workspace-lease-native.patch.yml')

  writeFileSync(driverPath, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as llmModule from ${JSON.stringify(llmModuleUrl)}
import { defineTool } from ${JSON.stringify(toolsModuleUrl)}
import { applyNilsWorkspaceLease } from ${JSON.stringify(providerModuleUrl)}
import { createWorkspaceRecoveryTools } from ${JSON.stringify(recoveryModuleUrl)}
import { createNilsWorkspaceRecoveryClient } from ${JSON.stringify(recoveryClientModuleUrl)}
import { createRuntimeContextTool } from ${JSON.stringify(contextModuleUrl)}

const { createUserMessage, LlmAdapter } = llmModule
const CallId = llmModule.ToolCallId ?? llmModule.CallId

function sessionEvents(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

const marker = ${JSON.stringify(marker)}
const root = process.env.DSH_WORKSPACE_LEASE_NATIVE_ROOT
const linked = process.env.DSH_WORKSPACE_LEASE_NATIVE_LINKED
const dirty = process.env.DSH_WORKSPACE_LEASE_NATIVE_DIRTY
const handoff = process.env.DSH_WORKSPACE_LEASE_NATIVE_HANDOFF

export const name = 'workspace-lease-native-smoke-driver'
export const inject = ['agents', 'goals', 'llm', 'skills', 'subprocess', 'tools']

class QuarantineGoalAdapter extends LlmAdapter {
  request = 0

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream() {
    this.request += 1
    if (this.request === 1) {
      const argumentsJson = JSON.stringify({
        objective: 'Complete packed dirty-workspace quarantine acceptance.',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: CallId('workspace-native-dirty-goal'),
          name: 'create_goal',
          arguments: argumentsJson,
        },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  void (async () => {
    const handles = []
    const bodyStarts = []
    const bodyWrites = []
    let releaseParallel
    const parallel = new Promise(resolve => { releaseParallel = resolve })
    let peerResult
    let rootResult
    let linkedResult
    let dirtyRecoveryResult
    let dirtyHandoffResult
    let dirtyMutationResult
    let dirtySkillResult
    let dirtyContextResult
    let dirtyGoalResult
    try {
      await applyNilsWorkspaceLease(ctx, {
        agentHook: ${JSON.stringify(agentHookBin)},
        agentHookConfig: ${JSON.stringify(agentHookConfig)},
        agentHookPolicy: ${JSON.stringify(agentHookPolicy)},
        agentHookStateDir: ${JSON.stringify(agentHookStateDir)},
        workspaceLeaseTimeoutMs: 5_000,
        workspaceLeaseTeardownTimeoutMs: 2_000,
        maxActiveWorkspaceLeaseRequests: 8,
      })
      const service = ctx.get('workspaceLease')
      if (service === undefined) throw new Error('workspace lease service did not activate')
      const recovery = createWorkspaceRecoveryTools(createNilsWorkspaceRecoveryClient(ctx, {
        agentHook: ${JSON.stringify(agentHookBin)},
        agentHookConfig: ${JSON.stringify(agentHookConfig)},
        agentHookPolicy: ${JSON.stringify(agentHookPolicy)},
        agentHookStateDir: ${JSON.stringify(agentHookStateDir)},
        workspaceRecoveryTimeoutMs: 5_000,
        workspaceRecoveryTeardownTimeoutMs: 2_000,
        maxActiveWorkspaceRecoveryRequests: 2,
      }))
      for (const definition of recovery) {
        ctx.tools.register(definition)
        service.registerQuarantineCapability(definition)
      }
      ctx.skills.register({
        name: 'quarantine-smoke',
        description: 'Packed native dirty-workspace quarantine smoke fixture.',
        source: 'runtime',
        content: '# Quarantine smoke\\n\\nThe real DSH skill loader reached this fixture.',
      })
      const skill = ctx.tools.get('skill')
      if (skill === undefined) throw new Error('real DSH skill tool is unavailable')
      service.registerQuarantineCapability(skill)
      for (const name of ['get_goal', 'create_goal', 'update_goal']) {
        const goal = ctx.tools.get(name)
        if (goal === undefined) throw new Error('real DSH ' + name + ' tool is unavailable')
        service.registerQuarantineCapability(goal)
      }
      const policyContent = '# Quarantine project policy'
      const runtimeContext = createRuntimeContextTool({
        async prepare(_exec, intent) {
          return {
            schema_version: 'decision.context.v1',
            request_id: 'quarantine-native-smoke',
            product: 'dsh',
            intent,
            reason: 'prepared',
            verified: true,
            documents: [{
              source: 'project',
              scope: 'project',
              content: policyContent,
            }],
            document_count: 1,
            total_bytes: Buffer.byteLength(policyContent, 'utf8'),
          }
        },
      })
      ctx.tools.register(runtimeContext)
      service.registerQuarantineCapability(runtimeContext)
      ctx.llm.registerAdapter(['quarantine-goal-smoke'], new QuarantineGoalAdapter())
      ctx.tools.register(defineTool({
        name: 'workspace_mutation_probe',
        description: 'mutate one accepted workspace after the native lease gate',
        parameters: {
          label: { type: 'string' },
          target: { type: 'string' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          bodyStarts.push(args.label)
          if (bodyStarts.length === 2) releaseParallel()
          await Promise.race([
            parallel,
            new Promise((_, reject) => setTimeout(
              () => reject(new Error('parallel workspace mutation did not overlap')),
              5_000,
            )),
          ])
          writeFileSync(join(args.target, args.label + '.txt'), args.label + '\\n')
          bodyWrites.push(args.label)
          return args.label
        },
      }))

      const rootHandle = await ctx.agents.create({
        sessionId: 'workspace-native-root',
        agentOptions: { provider: 'unused', model: 'unused' },
        meta: { cwd: root },
      })
      handles.push(rootHandle)
      await service.ref(rootHandle.agent)

      const peerHandle = await ctx.agents.create({
        sessionId: 'workspace-native-peer',
        agentOptions: { provider: 'unused', model: 'unused' },
        meta: { cwd: root },
      })
      handles.push(peerHandle)
      peerResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-peer-call'),
        name: 'workspace_mutation_probe',
        arguments: { label: 'peer-must-not-run', target: root },
        agent: peerHandle.agent,
      })

      const linkedHandle = await ctx.agents.create({
        sessionId: 'workspace-native-linked',
        agentOptions: { provider: 'unused', model: 'unused' },
        meta: { cwd: linked },
      })
      handles.push(linkedHandle)
      await service.ref(linkedHandle.agent)

      ;[rootResult, linkedResult] = await Promise.all([
        ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('workspace-native-root-call'),
          name: 'workspace_mutation_probe',
          arguments: { label: 'root', target: root },
          agent: rootHandle.agent,
        }),
        ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('workspace-native-linked-call'),
          name: 'workspace_mutation_probe',
          arguments: { label: 'linked', target: linked },
          agent: linkedHandle.agent,
        }),
      ])

      const dirtyHandle = await ctx.agents.create({
        sessionId: 'workspace-native-dirty',
        agentOptions: { provider: 'quarantine-goal-smoke', model: 'local' },
        meta: { cwd: dirty },
      })
      handles.push(dirtyHandle)
      dirtyRecoveryResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-dirty-recovery'),
        name: 'workspace_recovery',
        arguments: {},
        agent: dirtyHandle.agent,
      })
      dirtySkillResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-dirty-skill'),
        name: 'skill',
        arguments: { name: 'quarantine-smoke' },
        agent: dirtyHandle.agent,
      })
      dirtyContextResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-dirty-context'),
        name: 'runtime_context',
        arguments: { intent: 'project-dev' },
        agent: dirtyHandle.agent,
      })
      dirtyHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Continue this packed quarantine acceptance.' }],
        source: { kind: 'user' },
      }))
      await dirtyHandle.agent.whenIdle()
      const goal = ctx.goals.get(dirtyHandle.agent)
      const goalEvent = sessionEvents(dirtyHandle.agent.session).find(event =>
        event.type === 'tool/result'
          && event.data.message.source.callId === 'workspace-native-dirty-goal')
      dirtyGoalResult = {
        tool_succeeded: goalEvent?.type === 'tool/result'
          && goalEvent.data.message.content[0]?.isError === false,
        goal: goal === undefined ? null : {
          objective: goal.objective,
          phase: goal.phase,
        },
      }
      dirtyMutationResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-dirty-mutation'),
        name: 'workspace_mutation_probe',
        arguments: { label: 'dirty-must-not-run', target: dirty },
        agent: dirtyHandle.agent,
      })
      dirtyHandoffResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-native-dirty-handoff'),
        name: 'workspace_recovery_handoff',
        arguments: { path: handoff },
        agent: dirtyHandle.agent,
      })
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      for (const handle of handles.reverse()) {
        try { await handle.dispose() } catch (error) {
          process.stderr.write(String(error?.stack ?? error) + '\\n')
          process.exitCode = 1
        }
      }
      process.stdout.write(marker + JSON.stringify({
        schema_version: 'dsh-runtime-kit.workspace-lease-native-smoke.v1',
        bodyStarts,
        bodyWrites,
        peerResult,
        rootResult,
        linkedResult,
        dirtyRecoveryResult,
        dirtyHandoffResult,
        dirtyMutationResult,
        dirtySkillResult,
        dirtyContextResult,
        dirtyGoalResult,
      }) + '\\n')
      ctx.get('appExit')?.(process.exitCode ?? 0)
    }
  })()
}
`, { mode: 0o600 })
  writeFileSync(overlayPath, `
- id: dsh-runtime-kit
  disabled: true
- insert:
    - id: workspace-lease-native-smoke-driver
      name: ${JSON.stringify(driverPath)}
`, { mode: 0o600 })

  const boot = run(pnpmBin, ['dsh', '--profile', profile, '--patch', overlayPath])
  const line = boot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  assert.ok(line, `missing ${marker} output:\n${boot.stdout}\n${boot.stderr}`)
  const receipt = JSON.parse(line.slice(marker.length))
  assert.equal(receipt.schema_version, 'dsh-runtime-kit.workspace-lease-native-smoke.v1')
  assert.equal(receipt.peerResult.isError, true, JSON.stringify(receipt.peerResult))
  assert.match(receipt.peerResult.content[0].text, /another live session owns this workspace/)
  assert.equal(receipt.rootResult.isError, false, JSON.stringify(receipt.rootResult))
  assert.equal(receipt.rootResult.value, 'root')
  assert.equal(receipt.linkedResult.isError, false, JSON.stringify(receipt.linkedResult))
  assert.equal(receipt.linkedResult.value, 'linked')
  assert.deepEqual([...receipt.bodyStarts].sort(), ['linked', 'root'])
  assert.deepEqual([...receipt.bodyWrites].sort(), ['linked', 'root'])
  assert.equal(receipt.dirtyRecoveryResult.isError, false, JSON.stringify(receipt.dirtyRecoveryResult))
  assert.equal(receipt.dirtyRecoveryResult.value.state, 'dirty')
  assert.deepEqual(receipt.dirtyRecoveryResult.value.lease, {
    state: 'dirty',
    code: 'WORKSPACE_DIRTY',
  })
  assert.deepEqual(receipt.dirtyRecoveryResult.value.checkout.dirty_entries, [
    { states: ['worktree-new'], path: 'dirty-untracked.txt', lossy: false },
    { states: ['worktree-new'], path: 'hostile-filter.sh', lossy: false },
    { states: ['worktree-modified'], path: 'tracked.txt', lossy: false },
  ])
  assert.equal(receipt.dirtySkillResult.isError, false, JSON.stringify(receipt.dirtySkillResult))
  assert.equal(receipt.dirtySkillResult.value.name, 'quarantine-smoke')
  assert.match(receipt.dirtySkillResult.value.content, /real DSH skill loader/)
  assert.equal(receipt.dirtyContextResult.isError, false, JSON.stringify(receipt.dirtyContextResult))
  assert.equal(receipt.dirtyContextResult.value.intent, 'project-dev')
  assert.equal(receipt.dirtyContextResult.value.document_count, 1)
  assert.equal(receipt.dirtyGoalResult.tool_succeeded, true, JSON.stringify(receipt.dirtyGoalResult))
  assert.equal(receipt.dirtyGoalResult.goal.phase, 'active')
  assert.equal(
    receipt.dirtyGoalResult.goal.objective,
    'Complete packed dirty-workspace quarantine acceptance.',
  )
  assert.equal(receipt.dirtyMutationResult.isError, true, JSON.stringify(receipt.dirtyMutationResult))
  assert.match(receipt.dirtyMutationResult.content[0].text, /workspace has uncommitted state/)
  assert.equal(receipt.dirtyHandoffResult.isError, false, JSON.stringify(receipt.dirtyHandoffResult))
  assert.equal(receipt.dirtyHandoffResult.value.handoff.path, handoffWorktree)
  assert.equal(receipt.dirtyHandoffResult.value.handoff.status, 'verified')
  assert.equal(existsSync(join(repository, 'peer-must-not-run.txt')), false)
  assert.equal(existsSync(join(dirtyRepository, 'dirty-must-not-run.txt')), false)
  assert.equal(existsSync(hostileFilterMarker), false, 'lease/recovery inspection executed a repository filter')
  assert.deepEqual(
    fileBytesSnapshot(dirtyRepository, ['tracked.txt', 'dirty-untracked.txt']),
    dirtyBytesBefore,
  )
  assert.deepEqual(checkoutSnapshot(dirtyRepository), dirtyCheckoutBefore)
  assert.deepEqual(workspaceStateFiles(agentHookStateDir, dirtyRepository), [])
  assert.equal(readFileSync(join(repository, 'root.txt'), 'utf8'), 'root\n')
  assert.equal(readFileSync(join(linkedWorktree, 'linked.txt'), 'utf8'), 'linked\n')

  const finalCheckout = await manageDshPatch({
    action: 'check',
    sourceRoot: dshRoot,
    patchRoot: projectRoot,
    manifest: patchManifest,
    gitBin: '/usr/bin/git',
  })
  assert.deepEqual(finalCheckout, initialCheckout)
  process.stdout.write(JSON.stringify({
    ...receipt,
    dshVersion: dshManifest.version,
    sameWorktreeDeniedBeforeBody: true,
    distinctWorktreesOverlapped: true,
    dirtyBootstrapQuarantined: true,
    cleanManagedHandoffVerified: true,
  }) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
