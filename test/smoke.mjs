import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

  process.stdout.write(JSON.stringify({
    ok: true,
    dshVersion: dshManifest.version,
    dshProfile: profile,
    tool: 'runtime_kit_plus_one',
    input: 41,
    output: result.value,
    policyBlockVerified: true,
    skillCount: skillReceipt.count,
    skillPrecedenceVerified: true,
  }) + '\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
