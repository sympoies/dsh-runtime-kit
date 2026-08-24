import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { inspectExactDshCheckoutIdentity } from '../src/compat/git-checkout.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

assert.notEqual(
  process.env.DSH_SOURCE_ROOT,
  undefined,
  'set DSH_SOURCE_ROOT to a clean, built DeepSeek Harness source checkout',
)
assert.notEqual(process.env.AGENT_HOOK_BIN, undefined, 'set AGENT_HOOK_BIN')
assert.equal(isAbsolute(agentHookBin), true, 'AGENT_HOOK_BIN must be absolute')
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

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-lease-native-smoke-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const repository = join(temporaryRoot, 'repository')
const linkedWorktree = join(temporaryRoot, 'linked-worktree')
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
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  DSH_WORKSPACE_LEASE_NATIVE_ROOT: repository,
  DSH_WORKSPACE_LEASE_NATIVE_LINKED: linkedWorktree,
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

  const policy = readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')
  const digest = `sha256:${createHash('sha256').update(policy).digest('hex')}`
  mkdirSync(agentHookStateDir, { recursive: true, mode: 0o700 })
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
import { CallId } from ${JSON.stringify(llmModuleUrl)}
import { defineTool } from ${JSON.stringify(toolsModuleUrl)}
import { applyNilsWorkspaceLease } from ${JSON.stringify(providerModuleUrl)}

const marker = ${JSON.stringify(marker)}
const root = process.env.DSH_WORKSPACE_LEASE_NATIVE_ROOT
const linked = process.env.DSH_WORKSPACE_LEASE_NATIVE_LINKED

export const name = 'workspace-lease-native-smoke-driver'
export const inject = ['agents', 'subprocess', 'tools']

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
  assert.equal(existsSync(join(repository, 'peer-must-not-run.txt')), false)
  assert.equal(readFileSync(join(repository, 'root.txt'), 'utf8'), 'root\n')
  assert.equal(readFileSync(join(linkedWorktree, 'linked.txt'), 'utf8'), 'linked\n')

  const finalCheckout = await inspectExactDshCheckoutIdentity({
    sourceRoot: dshRoot,
    expectedRevision: selectedRelease.revision,
    gitBin: '/usr/bin/git',
  })
  assert.deepEqual(finalCheckout, initialCheckout)
  process.stdout.write(JSON.stringify({
    ...receipt,
    dshVersion: dshManifest.version,
    sameWorktreeDeniedBeforeBody: true,
    distinctWorktreesOverlapped: true,
  }) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
