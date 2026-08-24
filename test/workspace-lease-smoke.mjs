import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { inspectExactDshCheckoutIdentity } from '../src/compat/git-checkout.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

assert.notEqual(
  process.env.DSH_SOURCE_ROOT,
  undefined,
  'set DSH_SOURCE_ROOT to a clean, built DeepSeek Harness source checkout',
)
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
const initialCheckout = await inspectExactDshCheckoutIdentity({
  sourceRoot: dshRoot,
  expectedRevision: selectedRelease.revision,
  gitBin: '/usr/bin/git',
})

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-lease-smoke-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const workspaceRoot = join(temporaryRoot, 'workspace')
const profile = 'workspace-lease-smoke'
const marker = 'DSH_WORKSPACE_LEASE_SMOKE='
const environment = { ...process.env }
for (const name of Object.keys(environment)) {
  if (name.startsWith('AGENT_SESSION_')
    || /(?:^|_)(?:API_KEY|CREDENTIAL|CREDENTIALS|PASSWORD|SECRET|TOKEN)$/iu.test(name)) {
    delete environment[name]
  }
}
Object.assign(environment, {
  HOME: join(temporaryRoot, 'home'),
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  DSH_WORKSPACE_LEASE_SMOKE_CWD: workspaceRoot,
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

try {
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
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
  assert.ok(packedFiles.has('docs/workspace-leases.md'))
  const tarball = join(temporaryRoot, packReceipt.filename)

  run(pnpmBin, ['dsh', 'plugin', '--profile', profile, 'add', tarball])
  const profileDirectory = join(dshHome, 'profiles', profile)
  const workspaceLeaseModuleUrl = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
    'src',
    'workspace-lease',
    'index.js',
  )).href
  const llmModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'llm', 'llm', 'src', 'index.ts'),
  ).href
  const sessionModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'session', 'src', 'index.ts'),
  ).href
  const toolsModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'tools', 'src', 'index.ts'),
  ).href
  const driverPath = join(temporaryRoot, 'workspace-lease-driver.mjs')
  const overlayPath = join(temporaryRoot, 'workspace-lease.patch.yml')

  writeFileSync(driverPath, `
import { CallId, LlmAdapter, createUserMessage } from ${JSON.stringify(llmModuleUrl)}
import { SessionId } from ${JSON.stringify(sessionModuleUrl)}
import { defineTool } from ${JSON.stringify(toolsModuleUrl)}
import WorkspaceLease, { WORKSPACE_LEASE_PROTOCOL_VERSION } from ${JSON.stringify(workspaceLeaseModuleUrl)}

const marker = ${JSON.stringify(marker)}
const sessionId = SessionId('workspace-lease-packed-smoke')

class SmokeAdapter extends LlmAdapter {
  calls = 0
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream() {
    const chunks = this.calls++ === 0
      ? [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id: CallId('workspace-call'), name: 'workspace_mutation_probe', argumentsDelta: '{}' },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('workspace-call'), name: 'workspace_mutation_probe', arguments: '{}' } },
          { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]
      : [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'done' },
          { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
          { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
    for (const chunk of chunks) yield chunk
  }
}

export const name = 'workspace-lease-packed-smoke-driver'
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx) {
  void (async () => {
    const sequence = []
    let handle
    let disposeProvider
    let toolResult
    let state
    let opaque = false
    try {
      await ctx.plugin(WorkspaceLease)
      const service = ctx.get('workspaceLease')
      if (service === undefined) throw new Error('workspace lease service did not activate')
      disposeProvider = service.registerProvider({
        protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
        async bind(request) {
          sequence.push('bind')
          return {
            kind: 'bound',
            bindingId: 'binding:' + request.sessionId,
            workspaceId: 'workspace:packed-smoke',
            generation: 'generation:1',
            state: 'owned',
          }
        },
        async begin() {
          sequence.push('begin')
          return { kind: 'granted', operationId: 'operation:1', fence: 'fence:1' }
        },
        async complete(request) { sequence.push('complete:' + request.outcome) },
        async renew() { return { kind: 'renewed' } },
        async release() { sequence.push('release') },
      })
      ctx.tools.register(defineTool({
        name: 'workspace_mutation_probe',
        description: 'exercise packed workspace authority',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          sequence.push('body')
          return 'mutated'
        },
      }))
      ctx.on('tools/result', (exec, result) => {
        if (exec.agent?.id === sessionId && exec.name === 'workspace_mutation_probe') {
          toolResult = result
        }
      })
      ctx.llm.registerAdapter(['workspace-lease-smoke'], new SmokeAdapter())
      handle = await ctx.agents.create({
        sessionId,
        agentOptions: { provider: 'workspace-lease-smoke', model: 'scripted' },
        meta: { cwd: process.env.DSH_WORKSPACE_LEASE_SMOKE_CWD },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run the workspace mutation probe' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      const ref = await service.ref(handle.agent)
      state = service.state(handle.agent, ref)
      opaque = Object.isFrozen(ref)
        && Object.keys(ref).length === 0
        && JSON.stringify(ref) === '{}'
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      try { await handle?.dispose() } catch (error) {
        process.stderr.write(String(error?.stack ?? error) + '\\n')
        process.exitCode = 1
      }
      try { await disposeProvider?.() } catch (error) {
        process.stderr.write(String(error?.stack ?? error) + '\\n')
        process.exitCode = 1
      }
      process.stdout.write(marker + JSON.stringify({
        schema_version: 'dsh-runtime-kit.workspace-lease-smoke.v1',
        dshVersion: ${JSON.stringify(dshManifest.version)},
        protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
        state,
        opaque,
        sequence,
        result: toolResult,
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
    - id: workspace-lease-packed-smoke-driver
      name: ${JSON.stringify(driverPath)}
`, { mode: 0o600 })

  const boot = run(pnpmBin, ['dsh', '--profile', profile, '--patch', overlayPath])
  const line = boot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  assert.ok(line, `missing ${marker} output:\n${boot.stdout}\n${boot.stderr}`)
  const receipt = JSON.parse(line.slice(marker.length))
  assert.deepEqual(receipt, {
    schema_version: 'dsh-runtime-kit.workspace-lease-smoke.v1',
    dshVersion: dshManifest.version,
    protocolVersion: 1,
    state: 'owned',
    opaque: true,
    sequence: ['bind', 'begin', 'body', 'complete:succeeded', 'release'],
    result: {
      isError: false,
      value: 'mutated',
      content: [{ type: 'text', text: 'mutated' }],
    },
  })

  const finalCheckout = await inspectExactDshCheckoutIdentity({
    sourceRoot: dshRoot,
    expectedRevision: selectedRelease.revision,
    gitBin: '/usr/bin/git',
  })
  assert.deepEqual(finalCheckout, initialCheckout)
  process.stdout.write(JSON.stringify(receipt) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
