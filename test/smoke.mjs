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

async function verifyApprovalComposition() {
  const dshRequire = createRequire(join(dshRoot, 'packages', 'core', 'tools', 'package.json'))
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, { default: ApprovalService }] = await Promise.all([
    import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
    import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-tools')).href),
    import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-user-approval')).href),
  ])

  for (const [approvalOutcome, shouldExecute] of [
    ['allowed-once', true],
    ['rejected', false],
    ['cancelled', false],
  ]) {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService)
      ctx.provide('subprocess', {
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
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            terminate() {},
            collected: {
              stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
            },
          }
        },
      })
      applyPolicy(ctx, { agentHook: '/approval-contract/agent-hook' })
      ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'approval contract' }))
      ctx.on('approval/request', () => Promise.resolve(approvalOutcome))

      const result = await ctx.tools.execute({
        callId: `approval-${approvalOutcome}`,
        name: 'runtime_kit_plus_one',
        arguments: { value: 41 },
        signal: new AbortController().signal,
        agent: {
          session: {
            header: { cwd: projectWorkspace },
            events: [{ type: 'turn/start' }],
            append() { return {} },
          },
        },
      })
      assert.equal(result.isError, !shouldExecute)
      assert.equal(ctx.dshRuntimeKit.plusOneExecutions, shouldExecute ? 1 : 0)
      if (shouldExecute) assert.equal(result.value, 42)
      assert.equal(ctx.dshRuntimeKit.pendingPolicyMarkers, 0)
    } finally {
      await ctx.root.fiber.dispose()
    }
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

  const driverPath = join(temporaryRoot, 'smoke-driver.mjs')
  const overlayPath = join(temporaryRoot, 'smoke.patch.yml')
  writeFileSync(driverPath, `
export const name = 'dsh-runtime-kit-smoke-driver'
export const inject = ['tools', 'skills', 'dshRuntimeKit']

export function apply(ctx) {
  ctx.on('tools/pre-execute', (_exec, next) => {
    if (process.env.DSH_RUNTIME_KIT_SMOKE_SHORT_CIRCUIT === '1') {
      return Promise.resolve({ kind: 'allow' })
    }
    return next()
  }, { prepend: true })
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
      const result = await ctx.tools.execute({
        callId: 'dsh-runtime-kit-smoke-1',
        name: 'runtime_kit_plus_one',
        arguments: { value: 41 },
        signal: new AbortController().signal,
      })
      process.stdout.write('${marker}' + JSON.stringify({
        result,
        plusOneExecutions: ctx.dshRuntimeKit.plusOneExecutions,
        activePolicyChecks: ctx.dshRuntimeKit.activePolicyChecks,
        pendingPolicyMarkers: ctx.dshRuntimeKit.pendingPolicyMarkers,
      }) + '\\n')
      const expectation = process.env.DSH_RUNTIME_KIT_SMOKE_EXPECT ?? 'allow'
      if (expectation === 'allow' && result.value !== 42) process.exitCode = 1
      if (expectation === 'block' && !result.isError) process.exitCode = 1
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
  assert.match(shortCircuitedReceipt.result.content[0].text, /policy-marker-missing/)
  assert.equal(shortCircuitedReceipt.plusOneExecutions, 0)
  assert.equal(shortCircuitedReceipt.activePolicyChecks, 0)
  assert.equal(shortCircuitedReceipt.pendingPolicyMarkers, 0)

  await verifyApprovalComposition()

  process.stdout.write(JSON.stringify({
    ok: true,
    dshVersion: dshManifest.version,
    dshProfile: profile,
    tool: 'runtime_kit_plus_one',
    input: 41,
    output: result.value,
    policyBlockVerified: true,
    shortCircuitGuardVerified: true,
    approvalCompositionVerified: true,
    nilsCompatibilityStatus: nilsCompatibility.status,
    skillCount: skillReceipt.count,
    skillPrecedenceVerified: true,
  }) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
