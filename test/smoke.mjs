import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

import { manageDshPatch } from '../src/compat/dsh-patch.js'
import { manageDshTuiPatch } from '../src/compat/dsh-tui-patch.js'
import { fetchAuthenticatedAgentConsoleArtifact } from '../src/compat/agent-console-artifact.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const agentDocsBin = resolve(process.env.AGENT_DOCS_BIN ?? '')
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

assert.notEqual(
  process.env.DSH_SOURCE_ROOT,
  undefined,
  'set DSH_SOURCE_ROOT to a DeepSeek Harness source checkout',
)
if (process.env.PNPM_BIN !== undefined) {
  assert.equal(isAbsolute(pnpmBin), true, 'PNPM_BIN must be absolute when supplied')
}
assert.notEqual(
  process.env.AGENT_HOOK_BIN,
  undefined,
  'set AGENT_HOOK_BIN to the nils-cli agent-hook binary under test',
)
assert.notEqual(
  process.env.AGENT_DOCS_BIN,
  undefined,
  'set AGENT_DOCS_BIN to the nils-cli agent-docs binary under test',
)

const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@sympoies/dsh-runtime-kit')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(manifest.files.includes('src'))
assert.deepEqual(manifest.peerDependencies, {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-bash-local': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-fs': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-sandbox': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-skill-filesystem': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-subagent': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-subprocess': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.2',
})
const nilsCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'),
)
const agentConsoleCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'agent-console.json'), 'utf8'),
)
assert.equal(
  agentConsoleCompatibility.tui.specifier,
  '@deepseek-harness-tui/dsh-tui@0.9.3',
)
assert.equal(
  agentConsoleCompatibility.tui.source.revision,
  'a3439a3c7d7e7b3c9cfc505e833525376e8558d0',
)
assert.equal(
  agentConsoleCompatibility.tui.artifact.integrity,
  'sha512-8AR+/EO+5iBlS9a8OWFqPHtmRXa1EFM8L/0rlTvgLn1YVa2sKIqECfOpuBLxWRQ1ABUb+iSkoyJ1p0bsCC0FTA==',
)
assert.equal(nilsCompatibility.schema_version, 'dsh-runtime-kit.nils-compatibility.v1')
assert.equal(nilsCompatibility.status, 'released')
assert.equal(nilsCompatibility.minimum_supported_release, '1.27.17')
assert.equal(nilsCompatibility.validated_release, '1.27.27')
const dshIngressCompatibility = nilsCompatibility.commands.find(
  command => command.id === 'agent-hook.dispatch.dsh',
)
assert.equal(dshIngressCompatibility?.status, 'released')
assert.equal(dshIngressCompatibility?.validation, 'release-artifact-validated')
assert.deepEqual(dshIngressCompatibility?.contracts, [
  'agent-hook.dsh-ingress.v1',
  'agent-hook.dsh-ingress.v2',
  'agent-hook.dsh-ingress.v3',
  'agent-hook.dsh-ingress.v4',
  'agent-hook.dsh-ingress.v5',
  'agent-hook.policy.v1',
  'dsh.policy.v1',
  'cli.agent-hook.dispatch.v1',
  'agent-hook.normalized-decision.v1',
])
const dshManifest = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
assert.equal(dshManifest.name, '@deepseek-ai/dsh-root')
const dshCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
)
const selectedDshRelease = dshCompatibility.validated_releases?.[dshManifest.version]
assert.ok(selectedDshRelease, `unsupported DSH release ${dshManifest.version}`)
const dshRevision = selectedDshRelease.revision
const dshPatchManifest = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
)
const dshTuiPatchManifest = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh-tui-patches.json'), 'utf8'),
)
const initialDshCheckout = await manageDshPatch({
  action: 'check',
  sourceRoot: dshRoot,
  patchRoot: projectRoot,
  manifest: dshPatchManifest,
  gitBin: '/usr/bin/git',
})
assert.equal(initialDshCheckout.revision, dshRevision)
assert.equal(initialDshCheckout.after, 'patched')

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-smoke-'))
const nativeControllerSessions = []
const agentConsoleTuiArchive = join(temporaryRoot, 'authenticated-agent-console-tui.tgz')
const userHome = join(temporaryRoot, 'home')
const dshHome = join(temporaryRoot, 'dsh-home')
const codexHome = join(userHome, '.codex')
const claudeHome = join(userHome, '.claude')
const configHome = join(temporaryRoot, 'config')
const stateHome = join(temporaryRoot, 'state')
const runtimeRoot = join(temporaryRoot, 'dsh-runtime')
const agentHookRoot = join(runtimeRoot, 'agent-hook')
const agentHookConfig = join(agentHookRoot, 'config.toml')
const agentHookPolicy = join(agentHookRoot, 'policy.toml')
const agentHookStateDir = join(agentHookRoot, 'state')
const agentHookWrapper = join(temporaryRoot, 'agent-hook-isolation-wrapper')
const providerSessionMarker = join(temporaryRoot, 'provider-session-env-observed')
const agentDocsHome = join(runtimeRoot, 'agent-docs')
const agentDocsStateHome = join(runtimeRoot, 'agent-docs-state')
const ownerLauncher = join(projectRoot, 'bin', 'dsh-runtime-kit-launch.js')
const agentConsoleProfileWorkspace = join(
  projectRoot,
  'compatibility',
  'agent-console-pnpm-workspace.yaml',
)
const privateSkillsRoot = join(temporaryRoot, 'private-skills')
const projectWorkspace = join(temporaryRoot, 'project')
const agentConsoleTuiPackage = process.env.DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_PACKAGE
const deliveryRehearsal = process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL === '1'
const healthOnly = process.env.DSH_RUNTIME_KIT_SMOKE_HEALTH_ONLY === '1'
const authoritativeAcceptance = process.env.DSH_RUNTIME_KIT_SMOKE_ACCEPTANCE === '1'
const fullHostAuthority = process.env.DSH_RUNTIME_KIT_SMOKE_FULL_HOST === '1'
const nativeFullHostCapabilities = Object.freeze([
  'af-unix',
  'af-netlink',
  'host-netns',
  'localhost',
  'systemd-user',
  'docker',
  'supplementary-groups',
])
if (fullHostAuthority) assert.equal(process.platform, 'linux')
const nilsCandidateFeature = process.env.DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE
const profile = agentConsoleTuiPackage === undefined ? 'runtime-kit-smoke' : 'dsh-tui'
const marker = 'DSH_RUNTIME_KIT_SMOKE='
const skillMarker = 'DSH_RUNTIME_KIT_SKILLS='
const fullHostProbeFile = '.dsh-full-host-probe.mjs'
const fullHostProbeSource = `#!/usr/bin/env node
import { existsSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { spawnSync } from 'node:child_process'

const fail = (capability, detail) => {
  process.stderr.write(\`dsh-runtime-kit-full-host:\${capability}:failed\\n\`)
  if (detail) process.stderr.write(String(detail) + '\\n')
  process.exit(1)
}
const unlinkSocket = () => {
  try { unlinkSync('.git/dsh-full-host.sock') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
const listen = (server, options, capability, close) => new Promise(resolve => {
  server.once('error', error => fail(capability, error.code ?? error.message))
  server.listen(options, () => server.close(() => {
    try { close?.() } catch (error) { fail(capability, error.message) }
    resolve()
  }))
})
const run = (capability, command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) fail(capability, result.stderr.trim() || result.error?.message)
  return result.stdout.trim()
}

if (process.argv[2] === 'validation' && !existsSync('.dsh-validation-count')) {
  writeFileSync('.dsh-validation-count', 'validated')
  process.exit(1)
}
unlinkSocket()
await listen(net.createServer(), '.git/dsh-full-host.sock', 'af-unix', unlinkSocket)
await listen(net.createServer(), { host: '127.0.0.1', port: 0 }, 'localhost')
run('af-netlink', 'ip', ['link', 'show', 'lo'])
const expectedNetworkNamespace = readFileSync('.git/dsh-host-netns', 'utf8').trim()
const actualNetworkNamespace = readlinkSync('/proc/self/ns/net')
if (actualNetworkNamespace !== expectedNetworkNamespace) {
  fail('host-netns', \`expected \${expectedNetworkNamespace}; received \${actualNetworkNamespace}\`)
}
run('systemd-user', 'systemctl', ['--user', 'show-environment'])
run('docker', 'docker', ['version', '--format', '{{.Server.Version}}'])
const expectedGroups = readFileSync('.git/dsh-host-groups', 'utf8').trim()
const actualGroups = run('supplementary-groups', 'id', ['-G'])
if (actualGroups !== expectedGroups) fail('supplementary-groups', \`expected \${expectedGroups}; received \${actualGroups}\`)
if (process.argv[2] === 'ordinary') {
  writeFileSync('finish-line-native-mutation.txt', 'ordinary mutation\\n')
}
`
const validationCommand = fullHostAuthority
  ? `./${fullHostProbeFile} validation`
  : 'test -f .dsh-validation-count && exit 0; printf validated > .dsh-validation-count; exit 1'
const projectDocsConfig = `
[[validation]]
context = "project-dev"
product = "dsh"
commands = [${JSON.stringify(validationCommand)}]
description = "packed ${dshManifest.version} finish-line smoke"
`
const ordinaryCommand = fullHostAuthority
  ? `./${fullHostProbeFile} ordinary`
  : "printf 'ordinary mutation\\n' > finish-line-native-mutation.txt"
const smokeGitCli = process.env.DSH_RUNTIME_KIT_SMOKE_GIT_CLI_BIN ?? 'git-cli'
const smokeSemanticCommit = process.env.DSH_RUNTIME_KIT_SMOKE_SEMANTIC_COMMIT_BIN ?? 'semantic-commit'
const managedWorktreeCommand = `${JSON.stringify(smokeGitCli)} worktree add dsh-delivery-rehearsal --from main --format json`
const unsafeDefaultCommand = 'git merge feat/dsh-delivery-rehearsal'
const stageDeliveryCommand = 'git add --all'
const switchIntegrationCommand = 'git switch --quiet -c integration-smoke'
const privateIdentityPattern = new RegExp(
  `\\b${'ter' + 'ry'}\\b|${'ter' + 'ry'}-ai-tech`,
  'i',
)

function fixtureDigest(values) {
  const hash = createHash('sha256')
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value)))
    hash.update('\0')
    hash.update(value)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function providerSkillDocument(provider) {
  return `---
name: ${provider}-only
description: >
  Valid provider-only skill that DSH must never load.
---

# ${provider}-only

${provider.toUpperCase()}_PROVIDER_SKILL_MUST_NOT_LOAD
`
}

function stageProviderSentinel(root, provider) {
  mkdirSync(join(root, 'hooks'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'sessions'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'skills', `${provider}-only`), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(root, 'hooks', `${provider}-only.txt`),
    `${provider}:hooks:must-not-load\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(root, 'sessions', `${provider}-only.txt`),
    `${provider}:sessions:must-not-load\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(root, 'skills', `${provider}-only`, 'SKILL.md'),
    providerSkillDocument(provider),
    { mode: 0o600 },
  )
  writeFileSync(
    join(root, provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'),
    '# Provider-only runtime docs\n\nARK_PROVIDER_DOCS_MUST_NOT_LOAD\n',
    { mode: 0o600 },
  )
}

function assertProviderSentinel(root, provider) {
  assert.deepEqual(
    readdirSync(root).sort(),
    [provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md', 'hooks', 'sessions', 'skills'],
  )
  for (const directory of ['hooks', 'skills', 'sessions']) {
    assert.deepEqual(readdirSync(join(root, directory)), [
      directory === 'skills' ? `${provider}-only` : `${provider}-only.txt`,
    ])
    if (directory === 'skills') {
      assert.equal(
        readFileSync(join(root, directory, `${provider}-only`, 'SKILL.md'), 'utf8'),
        providerSkillDocument(provider),
      )
      continue
    }
    assert.equal(
      readFileSync(join(root, directory, `${provider}-only.txt`), 'utf8'),
      `${provider}:${directory}:must-not-load\n`,
    )
  }
}

stageProviderSentinel(codexHome, 'codex')
stageProviderSentinel(claudeHome, 'claude')
const providerSkillFixtureSha256 = fixtureDigest([
  providerSkillDocument('codex'),
  providerSkillDocument('claude'),
])
const providerSessionFixture = Object.freeze({
  AGENT_SESSION_ID: 'codex-provider-session',
  AGENT_SESSION_RUNTIME_ID: 'claude-provider-runtime',
  AGENT_SESSION_BIN: join(codexHome, 'sessions', 'provider-agent-session'),
  AGENT_SESSION_CAPABILITY_FILE: join(codexHome, 'sessions', 'provider-capability'),
  AGENT_SESSION_STATE_DIR: join(claudeHome, 'sessions'),
})
const providerSessionFixtureSha256 = fixtureDigest(
  Object.entries(providerSessionFixture).flatMap(([name, value]) => [name, value]),
)
let providerHookFixtureSha256
const environment = {
  ...process.env,
  HOME: userHome,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: join(temporaryRoot, 'empty-agents-home'),
  DSH_TELEMETRY_DISABLED: '1',
  // Native runtime health authenticates the exact released companion. The
  // subprocess-environment isolation contract is covered by focused transport
  // tests; an unauthenticated shell wrapper must not become the live binary.
  DSH_RUNTIME_KIT_AGENT_HOOK_BIN: agentHookBin,
  DSH_RUNTIME_KIT_AGENT_DOCS_BIN: agentDocsBin,
  ...nilsCandidateFeature === undefined
    ? {}
    : { DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: nilsCandidateFeature },
  DSH_RUNTIME_KIT_SEMANTIC_COMMIT_BIN: smokeSemanticCommit,
  DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL: '0',
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: privateSkillsRoot,
  DSH_RUNTIME_KIT_SMOKE_PROJECT: projectWorkspace,
  DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-primary',
  DSH_PERMISSION_MODE: fullHostAuthority ? 'danger-full-access' : 'workspace-write',
  ...providerSessionFixture,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  PATH: [
    dirname(agentHookBin),
    ...(process.env.PNPM_BIN === undefined ? [] : [dirname(pnpmBin)]),
    process.env.PATH ?? '',
  ].join(':'),
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
}
// The provider-isolation fixture is intentionally an incomplete ambient
// Agent Session sentinel. Do not let the parent agent's real checkpoint value
// silently complete the mixed principal after spreading process.env above.
delete environment.AGENT_SESSION_CHECKPOINT_FILE

function installPolicy(action) {
  const capability = action === 'block'
    ? 'capability = { id = "decision.block.v1", reason_code = "plus-one-blocked", message = "blocked by the DSH smoke policy" }'
    : 'capability = { id = "decision.allow.v1", reason_code = "plus-one-allowed" }'
  const policy = `${readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')}

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

[[rules]]
id = "dsh.runtime-context"
products = ["dsh"]
events = ["PreToolUse"]
matcher = "runtime_context"
priority = 20
mode = "enforce"
failure_posture = "closed"
override_class = "locked"
capability = { id = "decision.allow.v1", reason_code = "runtime-context-allowed" }
`
  const digest = `sha256:${createHash('sha256').update(policy).digest('hex')}`
  mkdirSync(agentHookRoot, { recursive: true, mode: 0o700 })
  mkdirSync(agentHookStateDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(configHome, 'agent-hook'), { recursive: true, mode: 0o700 })
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(agentHookPolicy, policy, { mode: 0o600 })
  writeFileSync(agentHookConfig, `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(agentHookPolicy)}
digest = "${digest}"
`, { mode: 0o600 })
  const providerPolicy = `${policy}

[[rules]]
id = "ambient.provider-hook-must-not-load"
products = ["dsh"]
events = ["PreToolUse"]
matcher = "runtime_kit_plus_one"
priority = 1000
mode = "enforce"
failure_posture = "closed"
override_class = "locked"
capability = { id = "decision.block.v1", reason_code = "ambient-provider-hook-must-not-load", message = "ambient provider hook loaded" }
`
  const providerPolicyPath = join(configHome, 'agent-hook', 'provider-policy.toml')
  const providerPolicyDigest = `sha256:${createHash('sha256').update(providerPolicy).digest('hex')}`
  const providerConfig = `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(providerPolicyPath)}
digest = "${providerPolicyDigest}"
`
  writeFileSync(providerPolicyPath, providerPolicy, { mode: 0o600 })
  writeFileSync(join(configHome, 'agent-hook', 'config.toml'), providerConfig, { mode: 0o600 })
  providerHookFixtureSha256 = fixtureDigest([providerConfig, providerPolicy])
const wrapper = `#!/bin/sh
if /usr/bin/env | /usr/bin/grep -q '^AGENT_SESSION_'; then
  /usr/bin/printf '%s\\n' 'provider-session-env-observed' > ${JSON.stringify(providerSessionMarker)}
  exit 91
fi
exec ${JSON.stringify(agentHookBin)} "$@"
`
  writeFileSync(agentHookWrapper, wrapper, { mode: 0o700 })
  for (const path of [agentHookConfig, agentHookPolicy]) {
    const metadata = statSync(path)
    assert.equal(metadata.isFile(), true)
    assert.equal(metadata.nlink, 1)
    assert.equal(metadata.mode & 0o077, 0)
  }
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

function cleanSmokeMutations() {
  for (const name of [
    '.dsh-validation-count',
    'finish-line-edit.txt',
    'finish-line-native-mutation.txt',
    'finish-line-resumable-edit.txt',
    'finish-line-resumed-edit.txt',
    'reviewer-mutation-must-not-exist.txt',
  ]) {
    rmSync(join(projectWorkspace, name), { force: true })
  }
}

function resetCheckoutLease() {
  cleanSmokeMutations()
  const reset = spawnSync('git', ['reset', '--hard', '--quiet', 'HEAD'], {
    cwd: projectWorkspace,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(reset.status, 0, reset.stderr)
  rmSync(join(agentDocsStateHome, 'agent-hook', 'dsh-checkout-leases'), {
    recursive: true,
    force: true,
  })
}

function spawnDsh(args, options = {}) {
  return spawnSync(process.execPath, [
    ownerLauncher,
    '--runtime-root', runtimeRoot,
    '--',
    pnpmBin, 'dsh', ...args,
  ], {
    cwd: dshRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })
}

function runDsh(args, options = {}) {
  const result = spawnDsh(args, options)

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

function runNativeMainAgentSmoke({ llmModuleUrl, sessionModuleUrl, profile, mode = 'happy' }) {
  const processLoss = mode === 'process-loss'
  const nativeRoot = join(temporaryRoot, `native-main-agent-${mode}`)
  const nativeProject = join(nativeRoot, 'project')
  const nativeWorktrees = join(nativeRoot, 'worktrees')
  const nativeLane = join(nativeWorktrees, 'lane-one')
  const nativeState = join(nativeRoot, 'state')
  const nativeDriver = join(nativeRoot, 'driver.mjs')
  const nativeObservation = join(nativeRoot, 'observation.json')
  const nativeOverlay = join(nativeRoot, 'driver.patch.yml')
  const mainAgentBinDir = resolve(process.env.NILS_BIN_DIR ?? dirname(agentHookBin))
  const mainAgentBin = join(mainAgentBinDir, 'main-agent')
  const agentSessionBin = join(mainAgentBinDir, 'agent-session')
  for (const binary of [mainAgentBin, agentSessionBin]) {
    assert.equal(existsSync(binary), true, `native Main Agent smoke missing ${binary}`)
  }
  mkdirSync(nativeRoot, { recursive: true, mode: 0o700 })
  mkdirSync(nativeWorktrees, { recursive: true, mode: 0o700 })
  mkdirSync(nativeState, { recursive: true, mode: 0o700 })
  const git = (args, cwd = nativeProject) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const initialized = spawnSync('git', ['init', '--quiet', '--initial-branch=main', nativeProject], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(initialized.status, 0, initialized.stderr)
  writeFileSync(join(nativeProject, 'README.md'), '# native main-agent smoke\n')
  writeFileSync(join(nativeProject, 'native-lane.txt'), 'baseline\n')
  mkdirSync(join(nativeProject, 'agent-docs'), { recursive: true, mode: 0o700 })
  const nativeAgentDocs = `
[[validation]]
context = "project-dev"
product = "dsh"
commands = ["test -f native-lane.txt"]
description = "packed native Main Agent lane"
`
  writeFileSync(join(nativeProject, 'AGENT_DOCS.toml'), nativeAgentDocs)
  writeFileSync(join(nativeProject, 'agent-docs', 'AGENT_DOCS.toml'), nativeAgentDocs)
  git(['add', '-A'])
  git(['-c', 'user.name=runtime-kit-smoke', '-c', 'user.email=smoke@example.invalid',
    'commit', '--quiet', '-m', 'test: seed native lane'])
  git(['remote', 'add', 'origin', 'https://example.invalid/example/native-smoke.git'])
  git(['worktree', 'add', '--quiet', '-b', 'feat/native-lane', nativeLane, 'HEAD'])

  const controllerStart = spawnSync(agentSessionBin, [
    '--state-dir', nativeState,
    'start',
    '--agent', 'hermes',
    '--cwd', nativeProject,
    '--coordination-mode', 'off',
    '--format', 'json',
  ], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(controllerStart.status, 0, controllerStart.stderr)
  const controller = JSON.parse(controllerStart.stdout).data
  nativeControllerSessions.push({ agentSessionBin, stateDir: nativeState, sessionId: controller.id })
  const coordination = join(nativeState, 'sessions', controller.id, 'coordination')
  const pickCoordination = prefix => join(
    coordination,
    readdirSync(coordination).find(name => name.startsWith(prefix)),
  )
  const objectiveFile = join(nativeRoot, 'objective.json')
  const assignmentFile = join(nativeRoot, 'assignment.json')
  const closeoutFile = join(nativeRoot, 'closeout.json')
  writeFileSync(objectiveFile, `${JSON.stringify({
    schema_version: 'main-agent.objective-packet.v1',
    tier: 'L0',
    objective_summary: 'prove the packed native host workspace lane',
    objective: { goal: 'complete one reviewed native DSH lane' },
    done_criteria: ['lane accepted', 'run closed'],
    constraints: ['no commits', 'no delivery'],
    durable_refs: [],
    next_action: null,
    work_context: {
      schema_version: 'agent-session.work-context-input.v1',
      intent: 'project-dev',
      tier: 'L2',
      repositories: ['example/native-smoke'],
      summary: 'DSH project-dev session',
    },
  }, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(assignmentFile, `${JSON.stringify({
    schema_version: 'main-agent.assignment-input.v1',
    assignment_id: 'native-lane',
    task_summary: 'edit and validate native-lane.txt',
    task: { objective: 'edit native-lane.txt, validate, and submit' },
    launch: {
      agent: 'dsh',
      cwd: nativeLane,
      title: null,
      session_id: 'worker-native-lane',
      coordination_mode: 'enforce',
      agent_args: [],
    },
    repository: 'example/native-smoke',
    worktree: nativeLane,
    base_ref: 'main',
    scopes: ['native-lane.txt'],
    durable_refs: [],
  }, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(closeoutFile, `${JSON.stringify({
    schema_version: 'main-agent.checkpoint-input.v1',
    summary: 'native lane accepted and drained',
    next_action: 'report the packed evidence',
    result_summary: 'one reviewed lane completed',
  }, null, 2)}\n`, { mode: 0o600 })

  writeFileSync(nativeDriver, `
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { CallId, LlmAdapter, createUserMessage } from ${JSON.stringify(llmModuleUrl)}
import { SessionId } from ${JSON.stringify(sessionModuleUrl)}

export const name = 'dsh-runtime-kit-native-main-agent-smoke'
export const inject = ['agents', 'llm', 'tools', 'workspaceLease', 'subagents', 'mainAgentOrchestration']
const controllerId = process.env.DSH_RUNTIME_KIT_NATIVE_CONTROLLER_ID
const assignmentId = 'native-lane'
const crashAfterAccept = process.env.DSH_RUNTIME_KIT_NATIVE_CRASH_AFTER_ACCEPT === '1'
let controllerCalls = 0
let childCalls = 0
let childId
let childCwd
let leaseReadyBeforePrompt = false
let firstSubmissionRevision = 0
let closeoutRevision = 0
let listed = []
let acceptedObserved = false
let laneCloseObserved = false
let crashTriggered = false
const childTools = []

function call(name, value, suffix) {
  const id = CallId('native-main-agent-' + suffix)
  const args = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
function text(value) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: value.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function store(args) {
  const result = spawnSync(process.env.DSH_RUNTIME_KIT_MAIN_AGENT_BIN, [
    '--state-dir', process.env.DSH_RUNTIME_KIT_NATIVE_STATE,
    ...args,
    '--format', 'json',
  ], { cwd: process.env.DSH_RUNTIME_KIT_NATIVE_PROJECT, env: process.env, encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error('store call failed: ' + result.stdout + result.stderr)
  return JSON.parse(result.stdout).data
}
function assignment() {
  return store(['worker', 'list']).workers.find(worker => worker.assignment_id === assignmentId)
}
function runRevision() { return store(['status']).run.revision }
function bootstrapKey(messages) {
  const source = JSON.stringify(messages)
  const tick = String.fromCharCode(96)
  const start = source.indexOf('set to ' + tick)
  if (start < 0) throw new Error('native bootstrap key not found')
  const tail = source.slice(start + ('set to ' + tick).length)
  return tail.slice(0, tail.indexOf(tick))
}
function writeObservation() {
  writeFileSync(process.env.DSH_RUNTIME_KIT_NATIVE_OBSERVATION, JSON.stringify({
    controller_id: controllerId,
    child_id: childId,
    child_cwd: childCwd,
    lease_ready_before_prompt: leaseReadyBeforePrompt,
    listed_children: listed.map(entry => entry.id),
    anchor_visible: listed.some(entry => entry.id !== childId),
    accepted_observed: acceptedObserved,
    lane_close_observed: laneCloseObserved,
    crash_triggered: crashTriggered,
    closeout_revision: closeoutRevision,
    child_tools: childTools,
  }) + '\\n', { mode: 0o600 })
}
async function waitFor(probe, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(description)
}

class NativeAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options) {
    const isController = String(options.sessionId) === controllerId
    let chunks
    const agentLoopRequest = options.tools?.some(tool => (
      tool.name === 'main_agent_run_initialize' || tool.name === 'main_agent_bootstrap'
    )) === true
    if (!agentLoopRequest) {
      chunks = text('native auxiliary response')
    } else if (isController) {
      const happySequence = [
        () => call('main_agent_run_initialize', {
          objective_file: process.env.DSH_RUNTIME_KIT_NATIVE_OBJECTIVE,
          idempotency_key: 'native-init-0001',
        }, 'initialize'),
        () => call('main_agent_worker_launch', {
          assignment_file: process.env.DSH_RUNTIME_KIT_NATIVE_ASSIGNMENT,
          idempotency_key: 'native-launch-0001',
        }, 'launch'),
        () => call('native_wait_for_submission', { after_revision: 0 }, 'wait-first'),
        () => {
          firstSubmissionRevision = assignment().revision
          return call('main_agent_worker_supervise', { assignment_id: assignmentId }, 'supervise')
        },
        () => call('main_agent_worker_request_changes', {
          assignment_id: assignmentId,
          if_revision: firstSubmissionRevision,
          reason: 'record the reviewed second pass',
          idempotency_key: 'native-changes-0001',
        }, 'changes'),
        () => call('native_wait_for_submission', {
          after_revision: firstSubmissionRevision,
        }, 'wait-second'),
        () => call('main_agent_worker_accept', {
          assignment_id: assignmentId,
          if_revision: assignment().revision,
          idempotency_key: 'native-accept-0001',
        }, 'accept'),
        () => call('main_agent_lane_close', { assignment_id: assignmentId }, 'lane-close'),
        () => {
          closeoutRevision = runRevision()
          writeObservation()
          return text('native lane accepted and drained; durable closeout ready')
        },
      ]
      const lossSequence = [
        happySequence[0],
        happySequence[1],
        () => call('native_wait_for_working', {}, 'wait-working'),
        () => {
          crashTriggered = true
          writeObservation()
          process.kill(process.pid, 'SIGKILL')
          return text('unreachable after forced harness loss')
        },
      ]
      const sequence = crashAfterAccept ? lossSequence : happySequence
      const next = sequence[controllerCalls++]
      if (next !== undefined) {
        chunks = await next()
      } else {
        chunks = text('native run closed')
      }
    } else {
      const sequence = [
        () => call('main_agent_bootstrap', {
          idempotency_key: bootstrapKey(options.messages),
        }, 'bootstrap'),
        () => call('runtime_context', { intent: 'project-dev' }, 'runtime-context'),
        () => call('read', {
          file_path: process.env.DSH_RUNTIME_KIT_NATIVE_LANE + '/native-lane.txt',
        }, 'read-baseline'),
        () => call('write', {
          file_path: process.env.DSH_RUNTIME_KIT_NATIVE_LANE + '/native-lane.txt',
          content: 'first pass\\n',
        }, 'first-write'),
        () => call('bash', {
          command: 'test -f native-lane.txt',
          description: 'validate the first native lane pass',
        }, 'first-validation'),
        () => call('main_agent_checkpoint', {
          summary: 'completed the first native pass',
          next_action: 'await review',
          state: 'submitted',
          result_summary: 'first pass validated',
          if_revision: assignment().revision,
          idempotency_key: 'native-checkpoint-0001',
        }, 'first-checkpoint'),
        () => text('first pass submitted'),
        () => call('read', {
          file_path: process.env.DSH_RUNTIME_KIT_NATIVE_LANE + '/native-lane.txt',
        }, 'read-first-pass'),
        () => call('write', {
          file_path: process.env.DSH_RUNTIME_KIT_NATIVE_LANE + '/native-lane.txt',
          content: 'reviewed second pass\\n',
        }, 'second-write'),
        () => call('bash', {
          command: 'test -f native-lane.txt',
          description: 'validate the reviewed native lane pass',
        }, 'second-validation'),
        () => call('main_agent_checkpoint', {
          summary: 'completed the reviewed second pass',
          next_action: 'await acceptance',
          state: 'submitted',
          result_summary: 'reviewed pass validated',
          if_revision: assignment().revision,
          idempotency_key: 'native-checkpoint-0002',
        }, 'second-checkpoint'),
        () => text('reviewed pass submitted'),
      ]
      chunks = (sequence[childCalls++] ?? (() => text('lane done')))()
    }
    for (const chunk of chunks) yield chunk
  }
}

export function apply(ctx) {
  void (async () => {
    let handle
    try {
      ctx.on('agent/error', ({ agent, error }) => {
        process.stderr.write('native agent error ' + String(agent.id) + ': '
          + String(error?.stack ?? error) + '\\n')
      })
      ctx.on('agent/created', ({ agent }) => {
        if (String(agent.session?.header?.parentSession) === controllerId) {
          childId = String(agent.id)
          childCwd = agent.session.header.cwd
          writeObservation()
        }
      })
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        if (String(agent.session?.header?.parentSession) === controllerId) {
          await ctx.workspaceLease.ref(agent)
          leaseReadyBeforePrompt = true
          writeObservation()
        }
        const decision = await next()
        if (String(agent.id) === controllerId && decision?.kind === 'reject') {
          process.stderr.write('native controller pre-step: ' + JSON.stringify(decision) + '\\n')
        }
        return decision
      }, { prepend: true })
      ctx.on('tools/result', (exec, result) => {
        if (result?.isError === true) {
          process.stderr.write('native tool error: ' + JSON.stringify({
            agent_id: String(exec.agent?.id),
            name: exec.name,
            content: result.content,
          }) + '\\n')
        }
        if (String(exec.agent?.session?.header?.parentSession) === controllerId) {
          childTools.push(exec.name)
          writeObservation()
          if (exec.agent.session.header.cwd !== process.env.DSH_RUNTIME_KIT_NATIVE_LANE) {
            throw new Error('native child cwd changed during tool execution')
          }
        }
        if (String(exec.agent?.id) === controllerId
          && exec.name === 'main_agent_worker_accept'
          && result?.isError !== true) {
          acceptedObserved = assignment()?.state === 'accepted'
          writeObservation()
        }
        if (String(exec.agent?.id) === controllerId
          && exec.name === 'main_agent_lane_close'
          && result?.isError !== true) {
          laneCloseObserved = true
          writeObservation()
        }
      })
      ctx.tools.register({
        name: 'native_wait_for_submission',
        description: 'Wait for the packed native lane to publish a newer submitted revision.',
        parameters: {
          type: 'object',
          properties: { after_revision: { type: 'integer' } },
          required: ['after_revision'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          await waitFor(() => {
            const current = assignment()
            return current?.state === 'submitted' && current.revision > args.after_revision
          }, 'native submission did not arrive')
          if (args.after_revision === 0) {
            listed = await ctx.subagents.listChildren(SessionId(controllerId), exec.signal)
            writeObservation()
          }
          return { submitted_revision: assignment().revision }
        },
      })
      ctx.tools.register({
        name: 'native_wait_for_working',
        description: 'Wait for the packed native lane to acquire its assignment claim.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(_args, exec) {
          await waitFor(() => assignment()?.state === 'working', 'native lane never started working')
          listed = await ctx.subagents.listChildren(SessionId(controllerId), exec.signal)
          writeObservation()
          return { assignment_revision: assignment().revision }
        },
      })
      ctx.llm.registerAdapter(['native-main-agent'], new NativeAdapter())
      handle = await ctx.agents.create({
        sessionId: SessionId(controllerId),
        agentOptions: { provider: 'native-main-agent', model: 'scripted' },
        meta: { cwd: process.env.DSH_RUNTIME_KIT_NATIVE_PROJECT },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'complete the packed native lane lifecycle' }],
        source: { kind: 'user' },
      }))
      try {
        await waitFor(() => {
          try {
            return assignment()?.state === 'accepted'
              && ctx.mainAgentOrchestration.laneCount === 0
              && laneCloseObserved
          } catch {
            return false
          }
        }, 'native lane did not reach its accepted and drained state')
      } catch (error) {
        let status
        let workers
        try { status = store(['status']) } catch {}
        try { workers = store(['worker', 'list']) } catch {}
        process.stderr.write('native resumable timeout state: ' + JSON.stringify({
          controller_calls: controllerCalls,
          child_calls: childCalls,
          child_id: childId,
          status,
          workers,
        }) + '\\n')
        throw error
      }
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      await handle?.dispose().catch(() => undefined)
      ctx.get('appExit')?.(process.exitCode ?? 0)
    }
  })()
}
`, { mode: 0o600 })
  writeFileSync(nativeOverlay, `
- insert:
    - id: dsh-runtime-kit-native-main-agent-smoke
      name: ${JSON.stringify(nativeDriver)}
`, { mode: 0o600 })

  const nativeEnv = {
    ...environment,
    AGENT_SESSION_STATE_DIR: nativeState,
    AGENT_SESSION_ID: controller.id,
    AGENT_SESSION_RUNTIME_ID: controller.session_incarnation,
    AGENT_SESSION_COORDINATION_MODE: 'off',
    AGENT_SESSION_BIN: agentSessionBin,
    AGENT_SESSION_CAPABILITY_FILE: pickCoordination('capability-'),
    AGENT_SESSION_CHECKPOINT_FILE: pickCoordination('main-agent-checkpoint-'),
    DSH_RUNTIME_KIT_MAIN_AGENT_BIN: mainAgentBin,
    DSH_RUNTIME_KIT_AGENT_SESSION_BIN: agentSessionBin,
    DSH_RUNTIME_KIT_NATIVE_CONTROLLER_ID: controller.id,
    DSH_RUNTIME_KIT_NATIVE_STATE: nativeState,
    DSH_RUNTIME_KIT_NATIVE_PROJECT: nativeProject,
    DSH_RUNTIME_KIT_NATIVE_LANE: nativeLane,
    DSH_RUNTIME_KIT_NATIVE_OBJECTIVE: objectiveFile,
    DSH_RUNTIME_KIT_NATIVE_ASSIGNMENT: assignmentFile,
    DSH_RUNTIME_KIT_NATIVE_CLOSEOUT: closeoutFile,
    DSH_RUNTIME_KIT_NATIVE_OBSERVATION: nativeObservation,
    DSH_RUNTIME_KIT_NATIVE_CRASH_AFTER_ACCEPT: processLoss ? '1' : '0',
    DSH_RUNTIME_KIT_SMOKE_PROJECT: nativeProject,
  }
  const result = processLoss
    ? spawnDsh(['--profile', profile, '--patch', nativeOverlay], { env: nativeEnv })
    : runDsh(['--profile', profile, '--patch', nativeOverlay], { env: nativeEnv })
  if (processLoss) {
    assert.notEqual(result.status, 0, 'forced DSH harness loss unexpectedly exited cleanly')
  }
  assert.equal(
    existsSync(nativeObservation),
    true,
    `missing native Main Agent observation:\n${result.stdout}\n${result.stderr}`,
  )
  const observation = JSON.parse(readFileSync(nativeObservation, 'utf8'))
  const nativeStoreAttempt = args => {
    const storeResult = spawnSync(mainAgentBin, [
      '--state-dir', nativeState,
      ...args,
      '--format', 'json',
    ], { cwd: nativeProject, env: nativeEnv, encoding: 'utf8', timeout: 30_000 })
    return {
      status: storeResult.status,
      output: storeResult.stdout + storeResult.stderr,
      envelope: JSON.parse(storeResult.stdout),
    }
  }
  const nativeStore = args => {
    const attempt = nativeStoreAttempt(args)
    assert.equal(attempt.status, 0, attempt.output)
    return attempt.envelope.data
  }
  let status = nativeStore(['status'])
  const workerRuntime = JSON.parse(readFileSync(
    join(nativeState, 'sessions', 'worker-native-lane', 'session.json'),
    'utf8',
  )).runtime
  let lastCloseoutResult
  let retirement
  let reconciliation
  let staleSidecarObserved = false
  if (status.run.state !== 'closed') {
    assert.equal(status.run.state, 'active')
    if (processLoss) {
      assert.equal(status.assignments.every(entry => entry.state === 'working'), true)
      assert.equal(observation.crash_triggered, true)
      assert.equal(observation.lane_close_observed, false)
      const sidecarPath = join(
        nativeState,
        'sessions',
        'worker-native-lane',
        'dsh-runtime-liveness.json',
      )
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
      assert.equal(sidecar.lane.state, 'open')
      staleSidecarObserved = true
      const stoppedDeadline = Date.now() + 90_000
      let workerStatus
      while (Date.now() < stoppedDeadline) {
        const listResult = spawnSync(agentSessionBin, [
          '--state-dir', nativeState,
          'list',
          '--format', 'json',
        ], { encoding: 'utf8', timeout: 30_000 })
        assert.equal(listResult.status, 0, listResult.stdout + listResult.stderr)
        workerStatus = JSON.parse(listResult.stdout).data
          .find(session => session.id === 'worker-native-lane')?.status
        if (workerStatus === 'stopped') break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      }
      assert.equal(workerStatus, 'stopped', 'lost DSH lane did not converge to stopped')
      const lostAssignment = status.assignments[0]
      reconciliation = nativeStore([
        'worker',
        'reconcile-stopped',
        lostAssignment.assignment_id,
        '--if-revision', String(lostAssignment.revision),
        '--reason', 'the packed DSH harness process was forcibly stopped',
        '--idempotency-key', 'native-reconcile-stopped-0001',
      ])
      status = nativeStore(['status'])
      assert.notEqual(status.assignments[0].state, 'working')
    } else {
      assert.equal(status.assignments.every(entry => entry.state === 'accepted'), true)
      const assignmentToRetire = status.assignments[0]
      const retireArgs = [
        'worker',
        'retire',
        assignmentToRetire.assignment_id,
        '--if-revision', String(assignmentToRetire.revision),
        '--idempotency-key', 'native-retire-0001',
      ]
      const retirementDeadline = Date.now() + 60_000
      while (retirement === undefined && Date.now() < retirementDeadline) {
        const attempt = nativeStoreAttempt(retireArgs)
        if (attempt.status === 0) {
          retirement = attempt.envelope.data
          break
        }
        assert.equal(attempt.envelope.error?.code, 'dsh-runtime-plugin-owned', attempt.output)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      assert.notEqual(retirement, undefined, 'native lane broker did not publish terminal proof')
      assert.equal(retirement.schema_version, 'main-agent.worker-retire-result.v1')
      assert.equal(retirement.cleanup_pending, false)
      assert.equal(retirement.retired, true)
      status = nativeStore(['status'])
    }
    const closeoutRevision = status.run.revision
    const closeoutArgs = [
      'closeout',
      '--if-run-revision', String(closeoutRevision),
      '--checkpoint-file', closeoutFile,
      '--idempotency-key', 'native-closeout-0001',
    ]
    const closeoutDeadline = Date.now() + 60_000
    while (status.run.state !== 'closed' && Date.now() < closeoutDeadline) {
      lastCloseoutResult = nativeStore(closeoutArgs)
      status = nativeStore(['status'])
      if (status.run.state !== 'closed') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  }
  const finalAssignment = status.assignments
    .find(assignment => assignment.assignment_id === 'native-lane')
  const receipt = {
    schema_version: 'dsh-runtime-kit.native-main-agent-smoke.v1',
    ok: true,
    ...observation,
    worker_runtime: workerRuntime,
    final_assignment: finalAssignment,
    retirement,
    reconciliation,
    closeout: lastCloseoutResult,
    process_loss: processLoss
      ? { forced: true, stale_open_sidecar_observed: staleSidecarObserved }
      : { forced: false, stale_open_sidecar_observed: false },
    run: status.run,
    remaining_assignments: status.assignments
      .filter(entry => entry.state !== 'released' && entry.state !== 'cancelled').length,
    file: readFileSync(join(nativeLane, 'native-lane.txt'), 'utf8'),
  }
  assert.equal(receipt.ok, true)
  assert.equal(receipt.child_cwd, nativeLane)
  assert.equal(receipt.lease_ready_before_prompt, true)
  assert.deepEqual(receipt.listed_children, [receipt.child_id])
  assert.equal(receipt.anchor_visible, false)
  assert.equal(receipt.worker_runtime.kind, 'dsh_external')
  assert.equal(receipt.accepted_observed, !processLoss)
  assert.equal(receipt.lane_close_observed, !processLoss)
  assert.equal(receipt.final_assignment.state, processLoss ? 'cancelled' : 'released')
  assert.equal(receipt.run.state, 'closed', JSON.stringify({ status, lastCloseoutResult }))
  assert.equal(receipt.closeout.handoff_ready, true)
  assert.equal(receipt.process_loss.forced, processLoss)
  assert.equal(receipt.process_loss.stale_open_sidecar_observed, processLoss)
  assert.equal(receipt.remaining_assignments, 0)
  assert.equal(receipt.file, processLoss ? 'baseline\n' : 'reviewed second pass\n')
  const requiredChildTools = processLoss
    ? ['main_agent_bootstrap']
    : ['main_agent_bootstrap', 'read', 'write', 'bash', 'main_agent_checkpoint']
  for (const tool of requiredChildTools) {
    assert.ok(receipt.child_tools.includes(tool), `native lane did not execute ${tool}`)
  }
  return receipt
}

function runAgentConsoleTuiStartupSmoke() {
  if (process.platform !== 'linux') return false
  const launcher = join(temporaryRoot, 'dsh-tui-startup-smoke.mjs')
  writeFileSync(launcher, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const result = spawnSync('timeout', [
  '--foreground',
  '--signal=TERM',
  '--kill-after=2s',
  '8s',
  process.execPath,
  ${JSON.stringify(ownerLauncher)},
  '--runtime-root',
  ${JSON.stringify(runtimeRoot)},
  '--',
  ${JSON.stringify(pnpmBin)},
  'dsh',
  '--profile',
  ${JSON.stringify(profile)},
], { stdio: 'inherit' })

process.exit(result.status ?? 125)
`, { mode: 0o700 })
  const result = spawnSync('script', ['-qefc', launcher, '/dev/null'], {
    cwd: dshRoot,
    env: { ...environment, TERM: 'xterm-256color' },
    encoding: 'utf8',
    timeout: 15_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const bytes = Buffer.byteLength(output)
  const sha256 = createHash('sha256').update(output).digest('hex')
  assert.equal(
    result.status,
    124,
    `enabled dsh-tui did not stay live for the bounded PTY window (status=${result.status}, bytes=${bytes}, sha256=${sha256})`,
  )
  assert.ok(
    bytes > 0,
    `enabled dsh-tui emitted no PTY readiness output (sha256=${sha256})`,
  )
  assert.equal(
    /(?:ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError)/u.test(output),
    false,
    `enabled dsh-tui reported a startup/import failure (bytes=${bytes}, sha256=${sha256})`,
  )
  return true
}

function runAgentConsoleTuiHistoryLockSmoke(packageRoot) {
  const historyHome = join(temporaryRoot, 'tui-history-home')
  mkdirSync(join(historyHome, '.dsh-tui', 'history.jsonl.lock'), { recursive: true })
  const historyModule = pathToFileURL(join(packageRoot, 'lib/types/history.js')).href
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
const { appendHistory } = await import(${JSON.stringify(historyModule)})
const started = performance.now()
appendHistory('dsh-runtime-kit nonblocking history lock smoke')
const elapsed = performance.now() - started
if (elapsed > 100) throw new Error('history append blocked input dispatch')
process.stdout.write(JSON.stringify({ accepted: true, elapsed_ms: elapsed }) + '\\n')
`], {
    cwd: packageRoot,
    env: { ...environment, HOME: historyHome },
    encoding: 'utf8',
    timeout: 2_000,
  })
  assert.equal(
    result.status,
    0,
    `patched dsh-tui history append did not return promptly (signal=${result.signal ?? 'none'})`,
  )
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.accepted, true)
  assert.ok(receipt.elapsed_ms <= 100)
  return true
}

function collectFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? collectFiles(join(directory, entry.name), relative)
      : [relative]
  })
}

function collectDumpRowIds(dump) {
  return [...dump.matchAll(/^\s*- id:\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)]
    .map(match => match[1])
}

try {
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
  mkdirSync(agentDocsHome, { recursive: true, mode: 0o700 })
  mkdirSync(agentDocsStateHome, { recursive: true, mode: 0o700 })
  for (const name of ['AGENT_DOCS.toml', 'PROJECT_DEV_EDIT.md']) {
    writeFileSync(
      join(agentDocsHome, name),
      readFileSync(join(projectRoot, 'agent-docs', name)),
      { mode: 0o600 },
    )
  }
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const forbiddenEnvironmentPath = join(dshHome, '.env')
  writeFileSync(
    forbiddenEnvironmentPath,
    `DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG=${agentHookConfig}\n`,
    { mode: 0o600 },
  )
  const forbiddenEnvironment = spawnSync(
    pnpmBin,
    ['dsh', '--profile', 'headless', 'bootstrap environment rejection probe'],
    {
    cwd: dshRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    },
  )
  assert.notEqual(forbiddenEnvironment.status, 0)
  const forbiddenEnvironmentOutput = `${forbiddenEnvironment.stdout}\n${forbiddenEnvironment.stderr}`
  assert.match(
    forbiddenEnvironmentOutput,
    /DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG/u,
    JSON.stringify({ status: forbiddenEnvironment.status, error: forbiddenEnvironment.error?.message }),
  )
  assert.match(forbiddenEnvironmentOutput, /export/u)
  rmSync(forbiddenEnvironmentPath)

  mkdirSync(projectWorkspace, { recursive: true })
  const initializedProject = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: projectWorkspace,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(initializedProject.status, 0, initializedProject.stderr)
  if (fullHostAuthority) {
    const hostGroups = spawnSync('/usr/bin/id', ['-G'], {
      cwd: projectWorkspace,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(hostGroups.status, 0, hostGroups.stderr)
    writeFileSync(
      join(projectWorkspace, '.git', 'dsh-host-groups'),
      `${hostGroups.stdout.trim()}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(projectWorkspace, '.git', 'dsh-host-netns'),
      `${readlinkSync('/proc/self/ns/net')}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(projectWorkspace, fullHostProbeFile),
      fullHostProbeSource,
      { mode: 0o700 },
    )
  }
  mkdirSync(agentDocsStateHome, { recursive: true })
  writeFileSync(join(projectWorkspace, 'AGENT_DOCS.toml'), projectDocsConfig)
  writeFileSync(join(projectWorkspace, '.gitignore'), '.dsh-validation-count\n')
  installSkill(privateSkillsRoot, 'bootstrap', 'private-bootstrap-marker')
  installSkill(privateSkillsRoot, 'private-only', 'private-only-marker')
  installSkill(privateSkillsRoot, 'topic-radar', 'private-topic-radar-marker')
  installSkill(join(projectWorkspace, '.agents', 'skills'), 'bootstrap', 'project-bootstrap-marker')
  installSkill(join(projectWorkspace, '.agents', 'skills'), 'project-only', 'project-only-marker')
  const signingKey = join(temporaryRoot, 'smoke-signing-key')
  const generatedSigningKey = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey],
    { env: environment, encoding: 'utf8', timeout: 10_000 },
  )
  assert.equal(generatedSigningKey.status, 0, generatedSigningKey.stderr)
  const allowedSigners = join(temporaryRoot, 'allowed-signers')
  writeFileSync(
    allowedSigners,
    `dsh-runtime-kit@example.invalid ${readFileSync(`${signingKey}.pub`, 'utf8').trim()}\n`,
    { mode: 0o600 },
  )
  for (const args of [
    ['config', 'user.email', 'dsh-runtime-kit@example.invalid'],
    ['config', 'user.name', 'DSH Runtime Kit Smoke'],
    ['config', 'gpg.format', 'ssh'],
    ['config', 'user.signingkey', signingKey],
    ['config', 'commit.gpgsign', 'true'],
    ['config', 'gpg.ssh.allowedSignersFile', allowedSigners],
    ['add', '--all'],
    ['commit', '--quiet', '-m', 'test: establish clean smoke fixture'],
  ]) {
    const prepared = spawnSync('git', args, {
      cwd: projectWorkspace,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(prepared.status, 0, prepared.stderr)
  }
  const remoteHeadDirectory = join(projectWorkspace, '.git', 'refs', 'remotes', 'origin')
  mkdirSync(remoteHeadDirectory, { recursive: true })
  writeFileSync(join(remoteHeadDirectory, 'HEAD'), 'ref: refs/remotes/origin/main\n')
  const remoteRepository = join(temporaryRoot, 'origin.git')
  const initializedRemote = spawnSync(
    'git',
    ['init', '--bare', '--quiet', '--initial-branch=main', remoteRepository],
    { env: environment, encoding: 'utf8', timeout: 10_000 },
  )
  assert.equal(initializedRemote.status, 0, initializedRemote.stderr)
  for (const args of [
    ['remote', 'add', 'origin', remoteRepository],
    ['push', '--quiet', '--set-upstream', 'origin', 'main'],
    ['remote', 'set-head', 'origin', 'main'],
  ]) {
    const prepared = spawnSync('git', args, {
      cwd: projectWorkspace,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(prepared.status, 0, prepared.stderr)
  }
  const resolvedHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: projectWorkspace,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(resolvedHead.status, 0, resolvedHead.stderr)
  const deliveryHead = resolvedHead.stdout.trim()
  assert.match(deliveryHead, /^[0-9a-f]{40,64}$/)
  const shellQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`
  const governedDeliveryCommand = [
    `${shellQuote(smokeSemanticCommit)} default-branch`,
    `--expect-head ${deliveryHead}`,
    '--dry-run --automation --format json',
    `--repo ${shellQuote(projectWorkspace)}`,
    `--message ${shellQuote('chore: rehearse governed delivery\\n\\nValidate the default-branch recovery contract.')}`,
  ].join(' ')
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
  assert.equal(manifest.dependencies?.['agent-runtime-kit'], undefined)
  const tarball = join(temporaryRoot, packReceipt.filename)
  for (const required of [
    'package.json',
    'index.js',
    'policy.js',
    'bin/dsh-runtime-kit-launch.js',
    'src/compat/dsh-rc7.js',
    'src/compat/agent-console.js',
    'src/compat/agent-console-artifact.js',
    'src/context/index.js',
    'src/context/nils-context.js',
    'src/finish-line/index.js',
    'src/finish-line/nils-client.js',
    'src/authoritative-acceptance/index.js',
    'src/policy/index.js',
    'src/policy/nils-transport.js',
    'src/prerequisite/index.js',
    'src/review/index.js',
    'src/workspace-lease/index.js',
    'agents/reviewers/reviewer-api-contract.md',
    'agents/reviewers/reviewer-data-migration.md',
    'agents/reviewers/reviewer-maintainability.md',
    'agents/reviewers/reviewer-performance.md',
    'agents/reviewers/reviewer-quick.md',
    'agents/reviewers/reviewer-red-team.md',
    'agents/reviewers/reviewer-security.md',
    'agents/reviewers/reviewer-testing.md',
    'agent-docs/AGENT_DOCS.toml',
    'agent-docs/PROJECT_DEV_EDIT.md',
    'cordis.patch.yml',
    'compatibility/dsh.json',
    'compatibility/dsh-patches.json',
    'compatibility/dsh-tui-patches.json',
    'compatibility/agent-console.json',
    'compatibility/nils-cli.json',
    'scripts/benchmark-policy.mjs',
    'scripts/check-dsh-compatibility.mjs',
    'scripts/manage-dsh-patch.mjs',
    'scripts/manage-dsh-tui-patch.mjs',
    'scripts/pack-dsh-compatibility-peers.mjs',
    'scripts/stage-dsh-compatibility-peers.mjs',
    'src/compat/contract.js',
    'src/compat/dsh-patch.js',
    'src/compat/dsh-tui-patch.js',
    'src/compat/git-checkout.js',
    'src/compat/package-artifact.js',
    'src/compat/performance.js',
    'patches/deepseek-harness/native-execution-boundaries-v3.patch',
    'patches/dsh-tui/nonblocking-history-lock.patch',
    'policy/dsh-runtime-kit-v1.toml',
    'policy/rule-parity.yaml',
    'policy/runtime-rule-parity.yaml',
    'scripts/check-rule-parity-source.mjs',
    'scripts/verify-policy-parity.mjs',
    'docs/policies/git-delivery.md',
    'docs/policies/review-thread-convergence.md',
    'docs/workspace-leases.md',
    'skills/bootstrap/SKILL.md',
    'test/workspace-lease-smoke.mjs',
  ]) {
    assert.ok(packedFiles.has(required), `packed artifact is missing ${required}`)
  }
  const packedText = relative => {
    const extracted = spawnSync('tar', ['-xOf', tarball, `package/${relative}`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(extracted.status, 0, `could not inspect packed ${relative}`)
    return extracted.stdout
  }
  assert.equal(
    parseYaml(packedText('policy/rule-parity.yaml')).schema_version,
    'dsh-runtime-kit.rule-parity.v1',
  )
  assert.equal(
    parseYaml(packedText('policy/runtime-rule-parity.yaml')).schema_version,
    'dsh-runtime-kit.runtime-rule-parity.v1',
  )
  assert.match(packedText('scripts/check-rule-parity-source.mjs'), /policy\/rule-parity\.yaml/u)
  assert.match(packedText('scripts/verify-policy-parity.mjs'), /policy\/runtime-rule-parity\.yaml/u)
  const sourceSkillFiles = collectFiles(join(projectRoot, 'skills'))
    .map(relative => `skills/${relative}`)
    .sort()
  const packedSkillFiles = [...packedFiles]
    .filter(relative => relative.startsWith('skills/'))
    .sort()
  assert.deepEqual(packedSkillFiles, sourceSkillFiles)
  const sourceReviewerFiles = collectFiles(join(projectRoot, 'agents', 'reviewers'))
    .map(relative => `agents/reviewers/${relative}`)
    .sort()
  const packedReviewerFiles = [...packedFiles]
    .filter(relative => relative.startsWith('agents/reviewers/'))
    .sort()
  assert.deepEqual(packedReviewerFiles, sourceReviewerFiles)

  for (const relative of packedFiles) {
    if (!/\.(?:js|json|md|mjs|py|sh|toml|ya?ml)$/.test(relative)) continue
    const extracted = spawnSync('tar', ['-xOf', tarball, `package/${relative}`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(extracted.status, 0, `could not inspect packed ${relative}`)
    assert.doesNotMatch(extracted.stdout, privateIdentityPattern)
  }
  const profileDirectory = join(dshHome, 'profiles', profile)
  const agentConsoleTuiPackageRoot = join(
    profileDirectory,
    'node_modules',
    '@deepseek-harness-tui',
    'dsh-tui',
  )
  let agentConsoleTuiArtifactVerified = false
  let agentConsoleTuiPatchVerified = false
  let agentConsoleTuiHistoryNonblockingVerified = false
  if (agentConsoleTuiPackage !== undefined) {
    assert.equal(
      agentConsoleTuiPackage,
      agentConsoleCompatibility.tui.specifier,
      'the Agent Console smoke accepts only the authenticated TUI release',
    )
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(profileDirectory, 'pnpm-workspace.yaml'),
      readFileSync(agentConsoleProfileWorkspace, 'utf8'),
      { mode: 0o600 },
    )
    const authenticated = await fetchAuthenticatedAgentConsoleArtifact(
      agentConsoleCompatibility.tui.artifact,
    )
    writeFileSync(agentConsoleTuiArchive, authenticated.bytes, { mode: 0o600 })
    agentConsoleTuiArtifactVerified = authenticated.integrity
      === agentConsoleCompatibility.tui.artifact.integrity
      && authenticated.shasum === agentConsoleCompatibility.tui.artifact.shasum
    assert.equal(agentConsoleTuiArtifactVerified, true)
    runDsh(['plugin', '--profile', profile, 'add', agentConsoleTuiArchive])
    const appliedTuiPatch = await manageDshTuiPatch({
      action: 'apply',
      packageRoot: agentConsoleTuiPackageRoot,
      patchRoot: projectRoot,
      manifest: dshTuiPatchManifest,
      gitBin: '/usr/bin/git',
    })
    assert.equal(appliedTuiPatch.before, 'pristine')
    assert.equal(appliedTuiPatch.after, 'patched')
    agentConsoleTuiPatchVerified = true
    agentConsoleTuiHistoryNonblockingVerified = runAgentConsoleTuiHistoryLockSmoke(
      agentConsoleTuiPackageRoot,
    )
  }
  runDsh(['plugin', '--profile', profile, 'add', tarball])

  const installedProfileManifest = JSON.parse(
    readFileSync(join(profileDirectory, 'package.json'), 'utf8'),
  )
  const installedBundles = installedProfileManifest.dsh?.profile?.bundles
  const dump = runDsh(['--profile', profile, '--dump-config']).stdout
  const composedRowIds = collectDumpRowIds(dump)
  assert.match(dump, /# == @sympoies\/dsh-runtime-kit/)
  assert.match(dump, /id: dsh-runtime-kit/)
  assert.match(dump, /name: '@sympoies\/dsh-runtime-kit'/)
  let installedTuiVersion
  let agentConsoleTuiStartupVerified = false
  if (agentConsoleTuiPackage !== undefined) {
    const profileWorkspace = parseYaml(readFileSync(
      join(profileDirectory, 'pnpm-workspace.yaml'),
      'utf8',
    ))
    assert.equal(profileWorkspace.nodeLinker, 'hoisted')
    assert.equal(profileWorkspace.autoInstallPeers, false)
    assert.deepEqual(profileWorkspace.allowBuilds, {
      '@google/genai': false,
      esbuild: false,
      koffi: false,
      protobufjs: false,
    })
    assert.deepEqual(installedBundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-harness-tui/dsh-tui',
      '@sympoies/dsh-runtime-kit',
    ])
    const installedTuiManifest = JSON.parse(readFileSync(
      join(agentConsoleTuiPackageRoot, 'package.json'),
      'utf8',
    ))
    installedTuiVersion = installedTuiManifest.version
    assert.equal(installedTuiVersion, agentConsoleCompatibility.tui.version)
    assert.match(dump, /# == @deepseek-harness-tui\/dsh-tui/)
    assert.match(dump, /id: dsh-tui/)
    assert.match(dump, /id: user-questions/)
    agentConsoleTuiStartupVerified = runAgentConsoleTuiStartupSmoke()
  }
  assert.doesNotMatch(dump, /agent-runtime-kit/u)
  assert.doesNotMatch(dump, /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i)

  const driverPath = agentConsoleTuiPackage === undefined
    ? join(temporaryRoot, 'smoke-driver.mjs')
    : join(profileDirectory, 'smoke-driver.mjs')
  const overlayPath = join(temporaryRoot, 'smoke.patch.yml')
  const codeModeOverlayPath = join(temporaryRoot, 'smoke-code-mode.patch.yml')
  const sandboxRunnerPath = join(temporaryRoot, 'smoke-sandbox-runner.sh')
  const llmModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'llm', 'llm', 'src', 'index.ts'),
  ).href
  const sessionModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'session', 'src', 'index.ts'),
  ).href
  const scopeModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'scope', 'src', 'index.ts'),
  ).href
  writeFileSync(driverPath, `
import { CallId, LlmAdapter, createUserMessage } from ${JSON.stringify(llmModuleUrl)}
import { SessionId } from ${JSON.stringify(sessionModuleUrl)}
import { scopeOf } from ${JSON.stringify(scopeModuleUrl)}
import { rmSync } from 'node:fs'
${agentConsoleTuiPackage === undefined
    ? ''
    : "import { inspectAgentConsoleRc7Profile } from '@sympoies/dsh-runtime-kit/agent-console-profile'"}

const agentConsoleProfileFacts = ${JSON.stringify(agentConsoleTuiPackage === undefined
    ? undefined
    : {
        profile,
        dsh: { version: dshManifest.version, revision: dshRevision },
        tui: { package: '@deepseek-harness-tui/dsh-tui', version: installedTuiVersion },
        bundles: installedBundles,
        rowIds: composedRowIds,
      })}
const smokeRoute = ${JSON.stringify(agentConsoleTuiPackage === undefined
    ? { provider: 'runtime-kit-smoke', model: 'scripted' }
    : { provider: 'codex-proxy', model: 'gpt-5.6-sol', reasoningEffort: 'high' })}

export const name = 'dsh-runtime-kit-smoke-driver'
// Cordis inject is required-only, so listing the orchestration service here
// makes "Main Agent Mode activated" a load-time condition of this driver: an
// absent service fails the smoke at plugin activation instead of silently
// skipping the lane assertions below.
export const inject = [
  'agents',
  'dshAcceptance',
  'goals',
  'llm',
  'skills',
  'tools',
  'dshRuntimeKit',
  'mainAgentOrchestration',
  'userQuestions',
  ${agentConsoleTuiPackage === undefined ? '' : "'agentPresets',"}
]

function toolCallResponse(name, value, suffix) {
  const id = CallId('dsh-runtime-kit-smoke-' + suffix)
  const args = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
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
  totalCalls = 0
  sessionCalls = 0
  parentCalls = 0
  deliveryCalls = 0
  foreignCalls = 0
  reviewerCalls = 0
  contextVisibility = []
  providerContextVisibility = []
  policyContextVisibility = []
  userPromptPolicyContextVisibility = []
  healthContextVisibility = []
  healthAuditSentinelVisibility = []
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options) {
    this.totalCalls += 1
    if (String(options.sessionId ?? '')
      === String(process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID ?? '')) {
      this.sessionCalls += 1
    }
    const isReviewer = String(options.system ?? '')
      .includes('read-only quick-pass reviewer')
    if (isReviewer) {
      const call = this.reviewerCalls++
      const chunks = call === 0
        ? toolCallResponse('write', {
            file_path: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT
              + '/reviewer-mutation-must-not-exist.txt',
            content: 'reviewer mutation escaped',
          }, 'reviewer-forbidden-write')
        : toolCallResponse('structured_output', {
            verdict: 'findings',
            summary: 'reviewer completed after the denied mutation',
            findings: [{
              severity: 'medium',
              confidence: 0.9,
              path: 'test/smoke.mjs',
              line: 1,
              category: 'testing',
              summary: 'The reviewer write attempt was denied.',
              evidence: 'The scoped reviewer guard returned a pre-body tool error.',
              recommendation: 'Keep the packed mutation-denial regression.',
              actionable: true,
              fingerprint: 'testing:reviewer:mutation-denial',
            }, {
              severity: 'medium',
              confidence: 0.85,
              path: 'src/review/index.js',
              category: 'testing',
              summary: 'The reviewer result also needs a file-level thread.',
              evidence: 'Provider-review transport accepts actionable findings without a line.',
              recommendation: 'Keep file-level thread generation in the packed smoke.',
              actionable: true,
              fingerprint: 'testing:reviewer:file-level-thread',
            }, {
              severity: 'low',
              confidence: 0.8,
              path: 'README.md',
              category: 'documentation',
              summary: 'The report also retains a non-actionable observation.',
              evidence: 'Summary-only findings must not create native diff threads.',
              recommendation: 'Keep report-only classification explicit in the smoke.',
              actionable: false,
              fingerprint: 'documentation:reviewer:report-only',
            }],
          }, 'reviewer-structured-output')
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('reviewer smoke adapter aborted')
        yield chunk
      }
      return
    }
    const isAgentLoopRequest = options.tools?.some(tool => tool.name === 'runtime_context') === true
    if (!isAgentLoopRequest) {
      for (const chunk of textResponse('smoke title')) yield chunk
      return
    }
    const serializedMessages = JSON.stringify(options.messages)
    const isForeignDelivery = serializedMessages.includes('attempt the foreign governed commit')
    if (isForeignDelivery) {
      const sequence = [
        toolCallResponse('runtime_kit_governed_commit', {
          type: 'feat',
          scope: 'runtime',
          subject: 'exercise native governed commit',
          body_bullets: ['Bind the commit to the session-owned feature worktree.'],
          expected_head: process.env.DSH_RUNTIME_KIT_SMOKE_FOREIGN_EXPECTED_HEAD,
        }, 'foreign-governed-commit'),
        textResponse('foreign governed commit denied'),
      ]
      const chunks = sequence[this.foreignCalls++] ?? textResponse('foreign governed commit denied')
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('foreign delivery smoke adapter aborted')
        yield chunk
      }
      return
    }
    const isGovernedDelivery = serializedMessages
      .includes('create the governed feature commit')
    if (isGovernedDelivery) {
      const sequence = [
        toolCallResponse('runtime_context', { intent: 'project-dev' }, 'delivery-context'),
        toolCallResponse('write', {
          file_path: process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_WORKTREE
            + '/governed-feature-commit.txt',
          content: 'native governed commit\\n',
        }, 'delivery-edit'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'fail feature validation once',
        }, 'delivery-validation-failure'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'pass feature validation',
        }, 'delivery-validation-success'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(stageDeliveryCommand)},
          description: 'stage only the feature-worktree payload',
        }, 'delivery-stage'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'validate the staged feature payload',
        }, 'delivery-validation-staged'),
        toolCallResponse('runtime_kit_governed_commit', {
          type: 'feat',
          scope: 'runtime',
          subject: 'must reject a stale expected head',
          body_bullets: ['A stale expected head must not create a commit.'],
          expected_head: ${JSON.stringify('c'.repeat(deliveryHead.length))},
        }, 'delivery-stale-governed-commit'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after the rejected stale commit',
        }, 'delivery-validation-after-stale'),
        toolCallResponse('runtime_kit_governed_commit', {
          type: 'feat',
          scope: 'runtime',
          subject: 'exercise native governed commit',
          body_bullets: ['Bind the commit to the session-owned feature worktree.'],
          expected_head: ${JSON.stringify(deliveryHead)},
        }, 'delivery-governed-commit'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after the governed commit',
        }, 'delivery-validation-after-commit'),
        textResponse('governed feature commit complete'),
      ]
      const chunks = sequence[this.deliveryCalls++] ?? textResponse('governed feature commit complete')
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('delivery smoke adapter aborted')
        yield chunk
      }
      return
    }
    this.contextVisibility.push(serializedMessages.includes('# DSH project development'))
    this.providerContextVisibility.push(serializedMessages.includes('ARK_PROVIDER_DOCS_MUST_NOT_LOAD'))
    this.policyContextVisibility.push(serializedMessages.includes('skill-backed workflow'))
    let userPromptIndex = -1
    for (const [index, message] of options.messages.entries()) {
      if (message.source?.kind === 'user'
        && message.content?.some(block => block.type === 'text'
          && block.text === 'review and run plus one')) userPromptIndex = index
    }
    if (userPromptIndex >= 0) {
      this.userPromptPolicyContextVisibility.push(options.messages
        .slice(userPromptIndex + 1)
        .some(message => message.source?.kind === 'plugin'
          && message.source.plugin === 'dsh-runtime-kit'
          && message.content?.some(block => block.type === 'text'
            && block.text.includes('skill-backed workflow'))))
    }
    this.healthContextVisibility.push(
      serializedMessages.includes("Session health could not verify this repository's agent-docs catalog")
      || serializedMessages.includes('Session health found an agent-docs catalog problem')
      || /DSH_RUNTIME_HEALTH_[A-Z0-9_]+/u.test(serializedMessages),
    )
    this.healthAuditSentinelVisibility.push(
      serializedMessages.includes('private-health-audit-sentinel'),
    )
    const call = this.parentCalls++
    const sequence = process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER === '1'
      ? [
          toolCallResponse('review_specialists', {
            task: 'Inspect the packed smoke fixture without mutating it.',
            roles: ['reviewer-quick'],
          }, 'review-specialists-call'),
          textResponse('review smoke done'),
        ]
      : process.env.DSH_RUNTIME_KIT_SMOKE_CODE_MODE === '1'
        ? [
            toolCallResponse('run_code', {
              code: 'return await tools.runtime_kit_plus_one({ value: 41 })',
              description: 'Run nested prerequisite smoke',
            }, 'run-code-call'),
            textResponse('code mode smoke done'),
          ]
      : [
      toolCallResponse('write', {
          file_path: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT
            + (process.env.DSH_RUNTIME_KIT_SMOKE_RESUME === '1'
              ? '/finish-line-resumed-edit.txt'
              : process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID
                ? '/finish-line-resumable-edit.txt'
                : '/finish-line-edit.txt'),
          content: 'committed edit',
      }, 'finish-line-edit'),
      toolCallResponse('runtime_context', { intent: 'project-dev' }, 'context-call'),
      toolCallResponse('bash', {
        command: ${JSON.stringify(validationCommand)},
        description: 'fail the declared validation once',
      }, 'validation-failure'),
      textResponse('attempt to stop before validation succeeds'),
      toolCallResponse('bash', {
        command: ${JSON.stringify(validationCommand)},
        description: 'rerun the exact declared validation',
      }, 'validation-success'),
      toolCallResponse('bash', {
        command: ${JSON.stringify(ordinaryCommand)},
        description: 'mutate through an ordinary foreground shell',
      }, 'ordinary-mutation'),
      textResponse('attempt to stop after ordinary mutation'),
      toolCallResponse('bash', {
        command: ${JSON.stringify(validationCommand)},
        description: 'revalidate after the ordinary mutation',
      }, 'validation-after-ordinary'),
      ]
    if (process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
      && process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL === '1') {
      sequence.push(
        toolCallResponse('bash', {
          command: ${JSON.stringify(managedWorktreeCommand)},
          description: 'create a managed feature worktree through git-cli',
        }, 'managed-worktree'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after managed worktree creation',
        }, 'validation-after-worktree'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(unsafeDefaultCommand)},
          description: 'prove raw default-branch delivery stays blocked',
        }, 'unsafe-default-delivery'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(stageDeliveryCommand)},
          description: 'stage the smoke changes for governed preflight',
        }, 'stage-delivery'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after staging',
        }, 'validation-after-stage'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(governedDeliveryCommand)},
          description: 'rehearse governed default-branch delivery without committing',
        }, 'governed-delivery'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after governed delivery preflight',
        }, 'validation-after-delivery'),
        toolCallResponse('runtime_kit_governed_commit', {
          type: 'feat',
          scope: 'runtime',
          subject: 'must not commit on the default checkout',
          body_bullets: ['The native default-branch policy must deny this call before execution.'],
          expected_head: ${JSON.stringify(deliveryHead)},
        }, 'native-default-denial'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(switchIntegrationCommand)},
          description: 'move the primary checkout onto an integration branch',
        }, 'primary-integration-switch'),
        toolCallResponse('bash', {
          command: ${JSON.stringify(validationCommand)},
          description: 'revalidate after changing only the primary checkout branch',
        }, 'validation-after-integration-switch'),
      )
    }
    if (process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
      && process.env.DSH_RUNTIME_KIT_SMOKE_CODE_MODE !== '1') {
      sequence.push(
        toolCallResponse('runtime_kit_plus_one', { value: 41 }, 'plus-one-call'),
        textResponse('done'),
      )
    }
    const chunks = sequence[call] ?? textResponse('done')
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('smoke adapter aborted')
      yield chunk
    }
  }
}

export function apply(ctx) {
  void (async () => {
    let handle
    let deliveryHandle
    let foreignHandle
    try {
      const targetId = process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID
        ?? 'dsh-runtime-kit-smoke-' + process.pid
      const deliveryId = targetId + '-delivery'
      const foreignId = targetId + '-foreign'
      const lifecycle = []
      let preExec
      let postExec
      let finalExec
      let result
      let runCodeResult
      let contextResult
      let editResult
      let ordinaryResult
      let managedWorktreeResult
      let unsafeDefaultResult
      let stageDeliveryResult
      let governedDeliveryResult
      let defaultGovernedCommitResult
      let switchIntegrationResult
      let deliveryContextResult
      let deliveryEditResult
      let deliveryStageResult
      let staleFeatureCommitResult
      let governedFeatureCommitResult
      let foreignGovernedCommitResult
      let reviewResult
      let reviewerChild
      let reviewerMutationResult
      let acceptanceGoal
      let acceptanceGoalBlocked
      let acceptanceGoalCompletion
      let acceptanceVerdict
      let modelMiddlewareCalls = 0
      const validationResults = []
      const deliveryValidationResults = []
      const errors = []
      ctx.on('llm/stream', (options, next) => {
        if (String(options.sessionId ?? '') === targetId) modelMiddlewareCalls += 1
        return next()
      })
      ctx.on('agent/session-start', ({ agent, source }) => {
        if (String(agent.id) === targetId) lifecycle.push('session-start:' + source)
      })
      ctx.on('agent/created', ({ agent }) => {
        if (agent.session?.header?.parentSession === targetId) reviewerChild = agent
      })
      ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
        if (String(agent.id) === targetId) lifecycle.push('pre-step:' + turn + ':' + step)
        return next()
      })
      ctx.on('tools/pre-execute', (exec, next) => {
        if (String(exec.agent?.id) !== targetId) return next()
        lifecycle.push('pre-tool')
        preExec = exec
        if (exec.name === 'runtime_kit_plus_one'
          && process.env.DSH_RUNTIME_KIT_SMOKE_SHORT_CIRCUIT === '1') {
          return Promise.resolve({ kind: 'allow' })
        }
        return next()
      }, { prepend: true })
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
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
        if (reviewerChild !== undefined && exec.agent === reviewerChild && exec.name === 'write') {
          reviewerMutationResult = finalResult
        }
        if (String(exec.agent?.id) === targetId) {
          lifecycle.push('result')
          if (exec.name === 'runtime_context') {
            contextResult = finalResult
          } else if (exec.name === 'write') {
            editResult = finalResult
          } else if (exec.name === 'bash') {
            if (exec.arguments?.command === ${JSON.stringify(ordinaryCommand)}) {
              ordinaryResult = finalResult
            } else if (exec.arguments?.command === ${JSON.stringify(managedWorktreeCommand)}) {
              managedWorktreeResult = finalResult
            } else if (exec.arguments?.command === ${JSON.stringify(unsafeDefaultCommand)}) {
              unsafeDefaultResult = finalResult
            } else if (exec.arguments?.command === ${JSON.stringify(stageDeliveryCommand)}) {
              stageDeliveryResult = finalResult
            } else if (exec.arguments?.command === ${JSON.stringify(governedDeliveryCommand)}) {
              governedDeliveryResult = finalResult
            } else if (exec.arguments?.command === ${JSON.stringify(switchIntegrationCommand)}) {
              switchIntegrationResult = finalResult
            } else {
              validationResults.push(finalResult)
            }
          } else if (exec.name === 'runtime_kit_governed_commit') {
            defaultGovernedCommitResult = finalResult
          } else if (exec.name === 'runtime_kit_plus_one') {
            finalExec = exec
            result = finalResult
          } else if (exec.name === 'run_code') {
            runCodeResult = finalResult
          } else if (exec.name === 'review_specialists') {
            reviewResult = finalResult
          }
        }
        if (String(exec.agent?.id) === deliveryId) {
          if (exec.name === 'runtime_context') {
            deliveryContextResult = finalResult
          } else if (exec.name === 'write') {
            deliveryEditResult = finalResult
          } else if (exec.name === 'runtime_kit_governed_commit') {
            if (exec.arguments?.expected_head === ${JSON.stringify(deliveryHead)}) {
              governedFeatureCommitResult = finalResult
            } else {
              staleFeatureCommitResult = finalResult
            }
          } else if (exec.name === 'bash') {
            if (exec.arguments?.command === ${JSON.stringify(stageDeliveryCommand)}) {
              deliveryStageResult = finalResult
            } else {
              deliveryValidationResults.push(finalResult)
            }
          }
        }
        if (String(exec.agent?.id) === foreignId
          && exec.name === 'runtime_kit_governed_commit') {
          foreignGovernedCommitResult = finalResult
        }
      })
      ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        if (String(agent.id) === targetId) lifecycle.push('turn-stop:' + turn)
      })
      ctx.on('agent/error', ({ agent, turn, step, error }) => {
        if (String(agent.id) === targetId) {
          errors.push({
            turn,
            step,
            code: typeof error?.code === 'string' ? error.code : undefined,
            message: String(error?.stack ?? error),
          })
        }
      })

      const adapter = new SmokeAdapter()
      ctx.llm.registerAdapter([smokeRoute.provider], adapter)
      const plusOneDefinition = ctx.tools.get('runtime_kit_plus_one')
      if (plusOneDefinition === undefined) {
        throw new Error('runtime_kit_plus_one definition missing before prerequisite registration')
      }
      ctx.dshRuntimeKit.prerequisites.require(plusOneDefinition, 'project-dev-context')
      const acceptanceEnabled = process.env.DSH_RUNTIME_KIT_SMOKE_ACCEPTANCE === '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID === 'dsh-runtime-kit-smoke-primary'
      if (acceptanceEnabled) {
        const bashDefinition = ctx.tools.get('bash')
        const writeDefinition = ctx.tools.get('write')
        if (bashDefinition === undefined || writeDefinition === undefined) {
          throw new Error('acceptance smoke definitions are unavailable')
        }
        ctx.dshAcceptance.register({
          requirements: [
            {
              name: 'package',
              validators: [{
                id: 'declared-bash',
                definition: bashDefinition,
                execution: {
                  kind: 'contained-bash',
                  intent: 'project-dev',
                  command: ${JSON.stringify(validationCommand)},
                },
              }],
            },
            {
              name: 'unit',
              validators: [{
                id: 'runtime-plus-one',
                definition: plusOneDefinition,
                execution: { kind: 'host-observed' },
              }],
            },
          ],
          invalidators: [writeDefinition],
        })
      }
      rmSync(process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT + '/.dsh-validation-count', { force: true })
      rmSync(process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT + '/finish-line-native-mutation.txt', { force: true })
      rmSync(process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT + '/reviewer-mutation-must-not-exist.txt', { force: true })
      handle = process.env.DSH_RUNTIME_KIT_SMOKE_RESUME === '1'
        ? await ctx.agents.resume({
          resumeSessionId: SessionId(targetId),
          agentOptions: smokeRoute,
          setup: ${agentConsoleTuiPackage === undefined
            ? 'undefined'
            : "async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'standard')"},
        })
        : await ctx.agents.create({
          sessionId: SessionId(targetId),
          agentOptions: smokeRoute,
          meta: {
            cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT,
            ${agentConsoleTuiPackage === undefined ? '' : "agentPreset: 'standard',"}
          },
          setup: ${agentConsoleTuiPackage === undefined
            ? 'undefined'
            : "async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'standard')"},
        })
      const agent = handle.agent
      if (acceptanceEnabled) {
        acceptanceGoal = ctx.goals.create(agent, { objective: 'prove authoritative acceptance' })
        try {
          ctx.goals.complete(agent, acceptanceGoal)
        } catch (error) {
          acceptanceGoalBlocked = {
            code: error?.code,
            aggregate: error?.aggregate,
          }
        }
      }
      // Web/TUI profiles keep filesystem-backed skill discovery on the
      // official agent preset. Read through the composed agent scope so this
      // receipt proves the same catalog the model sees, while headless keeps
      // resolving its equivalent global catalog.
      const skillOptions = {
        cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT,
        scope: scopeOf(agent.ctx),
      }
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
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'review and run plus one' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      if (acceptanceEnabled) {
        acceptanceVerdict = ctx.dshAcceptance.verdict(agent)
        acceptanceGoalCompletion = ctx.goals.complete(agent, acceptanceGoal)
        const settlementDeadline = Date.now() + 10_000
        while (ctx.dshAcceptance.completionSettlement(agent).status === 'pending'
          && Date.now() < settlementDeadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        if (ctx.dshAcceptance.completionSettlement(agent).status !== 'succeeded') {
          throw new Error('authoritative acceptance completion did not settle')
        }
      }

      if (process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL === '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1') {
        const managed = JSON.parse(managedWorktreeResult.value.stdout.text.trim())
        const deliveryWorktree = managed.data.path
        process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_WORKTREE = deliveryWorktree
        rmSync(deliveryWorktree + '/.dsh-validation-count', { force: true })
        deliveryHandle = await ctx.agents.create({
          sessionId: SessionId(deliveryId),
          agentOptions: smokeRoute,
          meta: {
            cwd: deliveryWorktree,
            ${agentConsoleTuiPackage === undefined ? '' : "agentPreset: 'standard',"}
          },
          setup: ${agentConsoleTuiPackage === undefined
            ? 'undefined'
            : "async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'standard')"},
        })
        deliveryHandle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'create the governed feature commit' }],
          source: { kind: 'user' },
        }))
        await deliveryHandle.agent.whenIdle()
        process.env.DSH_RUNTIME_KIT_SMOKE_FOREIGN_EXPECTED_HEAD
          = governedFeatureCommitResult.value.commit.sha
        foreignHandle = await ctx.agents.create({
          sessionId: SessionId(foreignId),
          agentOptions: smokeRoute,
          meta: {
            cwd: deliveryWorktree,
            ${agentConsoleTuiPackage === undefined ? '' : "agentPreset: 'standard',"}
          },
          setup: ${agentConsoleTuiPackage === undefined
            ? 'undefined'
            : "async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'standard')"},
        })
        foreignHandle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'attempt the foreign governed commit' }],
          source: { kind: 'user' },
        }))
        await foreignHandle.agent.whenIdle()
      }

      const controllerTools = ctx.tools.schemas(agent).map(tool => tool.name)
      const laneTools = [...ctx.mainAgentOrchestration.tools.lane]
      const requestConfig = agent.session.requestHeader()?.config
      const routeObservation = {
        provider: requestConfig?.provider ?? agent.options.provider,
        model: requestConfig?.model ?? agent.options.model,
        reasoningEffort: requestConfig?.reasoningEffort ?? agent.options.reasoningEffort,
      }
      const sandboxEvent = [...agent.session.events]
        .reverse()
        .find(event => event.type === 'sandbox/mode')
      const approvalEvent = [...agent.session.events]
        .reverse()
        .find(event => event.type === 'approval/policy')
      const agentConsoleObservation = agentConsoleProfileFacts === undefined
        ? undefined
        : {
            profile: agentConsoleProfileFacts.profile,
            dsh: agentConsoleProfileFacts.dsh,
            tui: agentConsoleProfileFacts.tui,
            bundles: agentConsoleProfileFacts.bundles,
            composition: {
              rowIds: agentConsoleProfileFacts.rowIds,
              controllerTools,
              laneTools,
              skills: skills.map(skill => skill.name),
              services: [
                ...(ctx.userQuestions === undefined ? [] : ['userQuestions']),
                ...(ctx.mainAgentOrchestration === undefined ? [] : ['mainAgentOrchestration']),
              ],
            },
            controllerRoute: routeObservation,
            workerRoute: ctx.mainAgentOrchestration.workerRoute(agent),
            authority: {
              runtimeKitPatchRowIds: agentConsoleProfileFacts.rowIds
                .filter(rowId => rowId === 'dsh-runtime-kit'),
              sandboxMode: sandboxEvent?.data?.mode,
              approvalPolicy: approvalEvent?.data?.policy,
              permissionModeSource: process.env.DSH_PERMISSION_MODE === undefined
                ? undefined
                : 'DSH_PERMISSION_MODE',
              providerCredentials: [{
                provider: 'codex-proxy',
                apiKeyEnv: 'DSH_CODEX_PROXY_TOKEN',
                inlineValuePresent: false,
              }],
            },
          }
      const agentConsoleInspection = agentConsoleObservation === undefined
        ? undefined
        : inspectAgentConsoleRc7Profile(agentConsoleObservation)

      process.stdout.write('${marker}' + JSON.stringify({
        result,
        runCodeResult,
        contextResult,
        editResult,
        ordinaryResult,
        managedWorktreeResult,
        unsafeDefaultResult,
        stageDeliveryResult,
        governedDeliveryResult,
        defaultGovernedCommitResult,
        switchIntegrationResult,
        deliveryContextResult,
        deliveryEditResult,
        deliveryStageResult,
        staleFeatureCommitResult,
        governedFeatureCommitResult,
        foreignGovernedCommitResult,
        deliveryValidationResults,
        reviewResult,
        reviewerMutationResult,
        reviewerChildEvents: reviewerChild?.session.events.map(event => event.type),
        reviewerChildLive: reviewerChild === undefined
          ? undefined
          : ctx.agents.get(reviewerChild.id) === reviewerChild,
        reviewerCalls: adapter.reviewerCalls,
        adapterTotalCalls: adapter.totalCalls,
        adapterSessionCalls: adapter.sessionCalls,
        adapterParentCalls: adapter.parentCalls,
        modelMiddlewareCalls,
        healthDenialCodes: [...new Set(errors
          .map(error => error.code)
          .filter(code => /^DSH_RUNTIME_HEALTH_[A-Z0-9_]+$/u.test(code ?? '')))],
        validationResults,
        contextVisibility: adapter.contextVisibility,
        providerContextVisibility: adapter.providerContextVisibility,
        policyContextVisibility: adapter.policyContextVisibility,
        userPromptPolicyContextVisibility: adapter.userPromptPolicyContextVisibility,
        healthContextVisibility: adapter.healthContextVisibility,
        healthAuditSentinelVisibility: adapter.healthAuditSentinelVisibility,
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
        activeFinishLineRequests: ctx.dshRuntimeKit.activeFinishLineRequests,
        activeFinishLineReservations: ctx.dshRuntimeKit.activeFinishLineReservations,
        activeAcceptanceOperations: ctx.dshRuntimeKit.activeAcceptanceOperations,
        acceptanceEnabled,
        acceptanceGoalBlocked,
        acceptanceGoalCompletion,
        acceptanceVerdict,
        finishLineDegraded: ctx.dshRuntimeKit.finishLineDegraded,
        pendingPolicyMarkers: ctx.dshRuntimeKit.pendingPolicyMarkers,
        pendingPrerequisites: ctx.dshRuntimeKit.pendingPrerequisites,
        pendingCorrelations: ctx.dshRuntimeKit.pendingCorrelations,
        providers: ctx.llm.listProviders().map(provider => provider.id),
        tools: controllerTools,
        agentConsoleObservation,
        agentConsoleInspection,
        mainAgentOrchestration: ctx.mainAgentOrchestration === undefined
          ? undefined
          : {
            apiVersion: ctx.mainAgentOrchestration.apiVersion,
            laneCount: ctx.mainAgentOrchestration.laneCount,
            controllerTools: ctx.mainAgentOrchestration.tools.controller,
            laneTools: ctx.mainAgentOrchestration.tools.lane,
          },
        userQuestions: ctx.userQuestions !== undefined,
        permissionMode: process.env.DSH_PERMISSION_MODE,
        nativeFullHostAuthorityVerified:
          process.env.DSH_RUNTIME_KIT_SMOKE_FULL_HOST === '1',
        nativeFullHostCapabilities: process.env.DSH_RUNTIME_KIT_SMOKE_FULL_HOST === '1'
          ? ${JSON.stringify(nativeFullHostCapabilities)}
          : [],
      }) + '\\n')
      const expectation = process.env.DSH_RUNTIME_KIT_SMOKE_EXPECT ?? 'allow'
      if (process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER === '1') {
        if (reviewResult?.value?.status !== 'completed') process.exitCode = 1
        if (reviewerMutationResult?.isError !== true) process.exitCode = 1
      } else if (expectation !== 'health-block'
        && expectation !== 'health-recovery'
        && process.env.DSH_RUNTIME_KIT_SMOKE_CODE_MODE !== '1'
        && (process.env.DSH_RUNTIME_KIT_SMOKE_RESUME === '1'
          ? !adapter.contextVisibility.every(Boolean)
          : adapter.contextVisibility[0] !== false
            || adapter.contextVisibility.length < 2
            || !adapter.contextVisibility.slice(1).every(Boolean))) {
        process.exitCode = 1
      }
      if (process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
        && (expectation === 'allow' || expectation === 'health-recovery')
        && result?.value !== 42) process.exitCode = 1
      if (expectation === 'health-block'
        && (adapter.sessionCalls !== 0
          || modelMiddlewareCalls !== 0
          || result !== undefined
          || !errors.some(error => error.code === 'DSH_RUNTIME_HEALTH_PROJECT_INVALID'))) {
        process.exitCode = 1
      }
      if (adapter.healthContextVisibility.some(Boolean)) process.exitCode = 1
      if (adapter.healthAuditSentinelVisibility.some(Boolean)) process.exitCode = 1
      if (process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL === '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
        && governedFeatureCommitResult?.value?.status !== 'committed') process.exitCode = 1
      if (process.env.DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL === '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
        && foreignGovernedCommitResult?.isError !== true) process.exitCode = 1
      if (expectation === 'block' && !result?.isError) process.exitCode = 1
      if (acceptanceEnabled
        && (acceptanceGoalBlocked?.code !== 'DSH_ACCEPTANCE_BLOCKED'
          || acceptanceVerdict?.action !== 'allow'
          || acceptanceVerdict?.aggregate !== 'satisfied'
          || acceptanceGoalCompletion?.phase !== 'complete')) process.exitCode = 1
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      try {
        await foreignHandle?.dispose()
        await deliveryHandle?.dispose()
        await handle?.dispose()
      } catch (error) {
        process.stderr.write(String(error?.stack ?? error) + '\\n')
        process.exitCode = 1
      }
      ctx.get('appExit')?.(process.exitCode ?? 0)
    }
  })()
}
`)
  writeFileSync(sandboxRunnerPath, `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
if [ "$#" -eq 0 ]; then
  printf 'dsh-runtime-kit-smoke-runner: missing separator\\n' >&2
  exit 125
fi
shift
exec "$@"
`, { mode: 0o700 })
  const agentConsoleTuiOverlay = agentConsoleTuiPackage === undefined
    ? ''
    : '- id: dsh-tui\n  disabled: true\n'
  writeFileSync(overlayPath, `
${agentConsoleTuiOverlay}
- id: sandbox
  config:
    runnerCommand:
      - ${JSON.stringify(sandboxRunnerPath)}
    runnerFailureSignatures:
      - 'dsh-runtime-kit-smoke-runner:'
- insert:
    - id: dsh-runtime-kit-smoke-driver
      name: ${JSON.stringify(driverPath)}
`)
  writeFileSync(codeModeOverlayPath, `
${agentConsoleTuiOverlay}
- id: tools
  config:
    mode: both
- id: sandbox
  config:
    runnerCommand:
      - ${JSON.stringify(sandboxRunnerPath)}
    runnerFailureSignatures:
      - 'dsh-runtime-kit-smoke-runner:'
- insert:
    - id: code-runtime
      name: ${JSON.stringify(join(dshRoot, 'packages', 'code-runtime', 'code-runtime-worker-thread', 'lib', 'index.js'))}
    - id: dsh-runtime-kit-smoke-driver
      name: ${JSON.stringify(driverPath)}
`)

  const invalidAgentDocs = join(temporaryRoot, 'unauthenticated-agent-docs')
  writeFileSync(invalidAgentDocs, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  const blockedHealthBoot = spawnDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_AGENT_DOCS_BIN: invalidAgentDocs,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-health-blocked',
      },
    },
  )
  assert.notEqual(blockedHealthBoot.status, 0, 'unauthenticated health companion must block DSH boot')
  const blockedHealthOutput = `${blockedHealthBoot.stdout}\n${blockedHealthBoot.stderr}`
  assert.match(
    blockedHealthOutput,
    /DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID/u,
    'blocked runtime health must report the exact companion identity denial',
  )
  assert.equal(
    blockedHealthOutput.includes(marker),
    false,
    'blocked runtime health must fail before a model-driven smoke receipt exists',
  )

  const projectHealthSessionId = 'dsh-runtime-kit-smoke-project-health'
  const projectHealthSentinel = join(
    projectWorkspace,
    '.health-audit-sentinel-skills',
  )
  mkdirSync(
    join(projectHealthSentinel, 'private-health-audit-sentinel'),
    { recursive: true },
  )
  writeFileSync(
    join(projectWorkspace, 'AGENT_DOCS.toml'),
    `${projectDocsConfig}\n[skills]\nenforce_name_prefix = true\nallowed_prefixes = ["project"]\ndir = ".health-audit-sentinel-skills"\n`,
  )
  const projectHealthBlockedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'health-block',
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: projectHealthSessionId,
      },
    },
  )
  const projectHealthBlockedLine = projectHealthBlockedBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    projectHealthBlockedLine,
    `missing project-health ${marker} output:\n${projectHealthBlockedBoot.stdout}\n${projectHealthBlockedBoot.stderr}`,
  )
  const projectHealthBlockedReceipt = JSON.parse(
    projectHealthBlockedLine.slice(marker.length),
  )
  assert.equal(projectHealthBlockedReceipt.adapterSessionCalls, 0)
  assert.equal(projectHealthBlockedReceipt.adapterParentCalls, 0)
  assert.equal(projectHealthBlockedReceipt.modelMiddlewareCalls, 0)
  assert.deepEqual(
    projectHealthBlockedReceipt.healthDenialCodes,
    ['DSH_RUNTIME_HEALTH_PROJECT_INVALID'],
  )

  rmSync(projectHealthSentinel, { recursive: true, force: true })
  writeFileSync(join(projectWorkspace, 'AGENT_DOCS.toml'), projectDocsConfig)
  const projectHealthRecoveredBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'health-recovery',
        DSH_RUNTIME_KIT_SMOKE_RESUME: '1',
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: projectHealthSessionId,
      },
    },
  )
  const projectHealthRecoveredLine = projectHealthRecoveredBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    projectHealthRecoveredLine,
    `missing project-health recovery ${marker} output:\n${projectHealthRecoveredBoot.stdout}\n${projectHealthRecoveredBoot.stderr}`,
  )
  const projectHealthRecoveredReceipt = JSON.parse(
    projectHealthRecoveredLine.slice(marker.length),
  )
  assert.equal(projectHealthRecoveredReceipt.result.value, 42)
  assert.ok(projectHealthRecoveredReceipt.adapterSessionCalls > 0)
  assert.ok(projectHealthRecoveredReceipt.healthContextVisibility.every(value => value === false))
  assert.ok(
    projectHealthRecoveredReceipt.healthAuditSentinelVisibility.every(value => value === false),
  )

  if (healthOnly) {
    resetCheckoutLease()
    const finalDshCheckout = await manageDshPatch({
      action: 'check',
      sourceRoot: dshRoot,
      patchRoot: projectRoot,
      manifest: dshPatchManifest,
      gitBin: '/usr/bin/git',
    })
    assert.deepEqual(finalDshCheckout, initialDshCheckout)
    const healthReceipt = {
      schema_version: 'dsh-runtime-kit.runtime-health-smoke.v1',
      ok: true,
      dshVersion: dshManifest.version,
      dshProfile: profile,
      tool: 'runtime_kit_plus_one',
      input: 41,
      output: projectHealthRecoveredReceipt.result.value,
      unauthenticatedCompanionBlockedBeforeModel:
        blockedHealthOutput.includes('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
        && !blockedHealthOutput.includes(marker),
      projectHealthBlockedBeforeModel:
        projectHealthBlockedReceipt.adapterSessionCalls === 0
        && projectHealthBlockedReceipt.adapterParentCalls === 0
        && projectHealthBlockedReceipt.modelMiddlewareCalls === 0,
      sameSessionRecovery:
        projectHealthRecoveredReceipt.result.value === 42
        && projectHealthRecoveredReceipt.adapterSessionCalls > 0,
      healthContextAbsent: [
        projectHealthBlockedReceipt,
        projectHealthRecoveredReceipt,
      ].every(candidate => candidate.healthContextVisibility.every(value => value === false)
        && candidate.healthAuditSentinelVisibility.every(value => value === false)),
      patchState: finalDshCheckout.after,
    }
    assert.deepEqual(healthReceipt, {
      schema_version: 'dsh-runtime-kit.runtime-health-smoke.v1',
      ok: true,
      dshVersion: dshManifest.version,
      dshProfile: profile,
      tool: 'runtime_kit_plus_one',
      input: 41,
      output: 42,
      unauthenticatedCompanionBlockedBeforeModel: true,
      projectHealthBlockedBeforeModel: true,
      sameSessionRecovery: true,
      healthContextAbsent: true,
      patchState: 'patched',
    })
    process.stdout.write(JSON.stringify(healthReceipt) + '\n')
  } else {
    resetCheckoutLease()

    const boot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL: deliveryRehearsal ? '1' : '0',
      },
    },
  )
  const line = boot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  assert.ok(line, `missing ${marker} output:\n${boot.stdout}\n${boot.stderr}`)

  const receipt = JSON.parse(line.slice(marker.length))
  if (agentConsoleTuiPackage !== undefined) {
    assert.equal(
      receipt.agentConsoleInspection?.schema_version,
      'dsh-runtime-kit.agent-console-profile-inspection.v2',
    )
    assert.equal(receipt.agentConsoleInspection.compatible, true)
    assert.equal(receipt.agentConsoleObservation.profile, 'dsh-tui')
    assert.deepEqual(receipt.agentConsoleObservation.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-harness-tui/dsh-tui',
      '@sympoies/dsh-runtime-kit',
    ])
    assert.equal(
      receipt.agentConsoleObservation.composition.controllerTools
        .includes('main_agent_checkpoint'),
      false,
    )
    assert.deepEqual(
      receipt.agentConsoleObservation.composition.laneTools,
      ['main_agent_bootstrap', 'main_agent_checkpoint'],
    )
    assert.deepEqual(
      receipt.agentConsoleInspection.controller_route,
      { provider: 'codex-proxy', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    )
    assert.deepEqual(
      receipt.agentConsoleInspection.worker_route,
      receipt.agentConsoleInspection.controller_route,
    )
    assert.deepEqual(receipt.agentConsoleInspection.authority, {
      runtime_kit_patch_rows: ['dsh-runtime-kit'],
      sandbox_mode: 'workspace-write',
      approval_policy: 'ask',
      credentials: 'environment-reference-only',
    })
  }
  if (deliveryRehearsal) {
    assert.ok(receipt.managedWorktreeResult, 'packed DSH must exercise the managed-worktree route')
    assert.ok(receipt.governedFeatureCommitResult, 'packed DSH must execute the native governed commit tool')
  }
  const result = receipt.result
  const contextResult = receipt.contextResult
  const editResult = receipt.editResult
  const ordinaryResult = receipt.ordinaryResult
  const managedWorktreeResult = receipt.managedWorktreeResult
  const unsafeDefaultResult = receipt.unsafeDefaultResult
  const stageDeliveryResult = receipt.stageDeliveryResult
  const governedDeliveryResult = receipt.governedDeliveryResult
  const defaultGovernedCommitResult = receipt.defaultGovernedCommitResult
  const switchIntegrationResult = receipt.switchIntegrationResult
  const deliveryContextResult = receipt.deliveryContextResult
  const deliveryEditResult = receipt.deliveryEditResult
  const deliveryStageResult = receipt.deliveryStageResult
  const staleFeatureCommitResult = receipt.staleFeatureCommitResult
  const governedFeatureCommitResult = receipt.governedFeatureCommitResult
  const foreignGovernedCommitResult = receipt.foreignGovernedCommitResult
  const deliveryValidationResults = receipt.deliveryValidationResults
  const validationResults = receipt.validationResults
  assert.equal(contextResult.isError, false)
  assert.equal(contextResult.value.schema_version, 'dsh-runtime-context.result.v1')
  assert.equal(contextResult.value.intent, 'project-dev')
  assert.equal(contextResult.value.status, 'already-current')
  assert.equal(contextResult.value.document_count, 1)
  assert.match(contextResult.value.documents[0].content, /# DSH project development/)
  assert.equal(receipt.contextVisibility[0], false)
  assert.ok(receipt.contextVisibility.length >= 2)
  assert.ok(receipt.contextVisibility.slice(1).every(Boolean))
  assert.ok(receipt.providerContextVisibility.every(value => value === false))
  assert.ok(receipt.userPromptPolicyContextVisibility.length > 0)
  assert.ok(receipt.userPromptPolicyContextVisibility.every(Boolean))
  assert.ok(receipt.healthContextVisibility.every(value => value === false))
  assert.equal(editResult.isError, false, JSON.stringify({ editResult, errors: receipt.errors }))
  assert.equal(validationResults.length, deliveryRehearsal ? 7 : 3)
  assert.ok(validationResults[0].value, JSON.stringify(validationResults[0]))
  assert.notEqual(validationResults[0].value.exitCode, 0)
  assert.equal(validationResults[1].value.exitCode, 0, JSON.stringify(validationResults[1]))
  assert.equal(validationResults[2].value.exitCode, 0, JSON.stringify(validationResults[2]))
  if (deliveryRehearsal) {
    assert.equal(validationResults[3].value.exitCode, 0)
    assert.equal(validationResults[4].value.exitCode, 0)
    assert.equal(validationResults[5].value.exitCode, 0)
    assert.equal(validationResults[6].value.exitCode, 0)
  }
  assert.equal(ordinaryResult.value.exitCode, 0, JSON.stringify(ordinaryResult))
  assert.equal(ordinaryResult.value.kind, 'foreground')
  if (fullHostAuthority) {
    assert.equal(receipt.permissionMode, 'danger-full-access')
    assert.equal(receipt.nativeFullHostAuthorityVerified, true)
    assert.deepEqual(receipt.nativeFullHostCapabilities, nativeFullHostCapabilities)
  }
  if (deliveryRehearsal) {
    assert.equal(managedWorktreeResult.isError, false, JSON.stringify(managedWorktreeResult))
    assert.equal(managedWorktreeResult.value.exitCode, 0, JSON.stringify(managedWorktreeResult))
    const managedWorktreeReceipt = JSON.parse(managedWorktreeResult.value.stdout.text.trim())
    assert.equal(managedWorktreeReceipt.schema_version, 'cli.git-cli.worktree.add.v1')
    assert.equal(managedWorktreeReceipt.ok, true)
    assert.equal(managedWorktreeReceipt.data.slug, 'dsh-delivery-rehearsal')
    assert.equal(managedWorktreeReceipt.data.branch, 'feat/dsh-delivery-rehearsal')
    assert.equal(managedWorktreeReceipt.data.managed, undefined)
    assert.equal(existsSync(managedWorktreeReceipt.data.path), true)
    assert.equal(unsafeDefaultResult.isError, true, JSON.stringify(unsafeDefaultResult))
    assert.match(unsafeDefaultResult.content[0].text, /block-unsafe-default-delivery/)
    assert.equal(stageDeliveryResult.isError, false, JSON.stringify(stageDeliveryResult))
    assert.equal(stageDeliveryResult.value.exitCode, 0)
    assert.equal(governedDeliveryResult.isError, false, JSON.stringify(governedDeliveryResult))
    assert.equal(governedDeliveryResult.value.exitCode, 0)
    const governedDeliveryReceipts = governedDeliveryResult.value.stdout.text
      .trim()
      .split('\n')
      .map(entry => JSON.parse(entry))
    const governedDeliveryReceipt = governedDeliveryReceipts.find(
      entry => entry.schema_version === 'cli.semantic-commit.default-branch.preview.v1',
    )
    assert.ok(governedDeliveryReceipt, JSON.stringify(governedDeliveryReceipts))
    assert.equal(governedDeliveryReceipt.ok, true)
    assert.equal(governedDeliveryReceipt.data.mode, 'default-branch')
    assert.equal(governedDeliveryReceipt.data.head, deliveryHead)
    assert.equal(governedDeliveryReceipt.data.completion.default_branch_committed, false)
    assert.equal(governedDeliveryReceipt.data.completion.provider_delivery_attempted, false)
    assert.equal(defaultGovernedCommitResult.isError, true, JSON.stringify(defaultGovernedCommitResult))
    assert.match(defaultGovernedCommitResult.content[0].text, /block-unsafe-default-delivery/)
    assert.equal(switchIntegrationResult.isError, false, JSON.stringify(switchIntegrationResult))
    assert.equal(switchIntegrationResult.value.exitCode, 0)
    assert.equal(deliveryContextResult.isError, false, JSON.stringify(deliveryContextResult))
    assert.equal(deliveryContextResult.value.intent, 'project-dev')
    assert.equal(deliveryEditResult.isError, false, JSON.stringify(deliveryEditResult))
    assert.equal(deliveryStageResult.isError, false, JSON.stringify(deliveryStageResult))
    assert.equal(deliveryStageResult.value.exitCode, 0)
    assert.equal(deliveryValidationResults.length, 5)
    assert.notEqual(deliveryValidationResults[0].value.exitCode, 0)
    assert.ok(deliveryValidationResults.slice(1).every(result => result.value.exitCode === 0))
    assert.equal(staleFeatureCommitResult.isError, true, JSON.stringify(staleFeatureCommitResult))
    assert.match(staleFeatureCommitResult.content[0].text, /semantic-commit rejected/u)
    assert.equal(governedFeatureCommitResult.isError, false, JSON.stringify(governedFeatureCommitResult))
    assert.equal(
      governedFeatureCommitResult.value.schema_version,
      'dsh-runtime-kit.governed-commit.result.v1',
    )
    assert.equal(governedFeatureCommitResult.value.status, 'committed')
    assert.equal(governedFeatureCommitResult.value.staged.file_count, 1)
    assert.deepEqual(governedFeatureCommitResult.value.staged.files, [{
      status: 'A',
      path: 'governed-feature-commit.txt',
      old_path: null,
    }])

    const commitSha = governedFeatureCommitResult.value.commit.sha
    assert.equal(foreignGovernedCommitResult.isError, true, JSON.stringify(foreignGovernedCommitResult))
    assert.match(foreignGovernedCommitResult.content[0].text, /checkout-lease-guard/u)
    const gitValue = (cwd, args) => {
      const output = spawnSync('/usr/bin/git', args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(output.status, 0, output.stderr)
      return output.stdout.trim()
    }
    assert.equal(gitValue(projectWorkspace, ['branch', '--show-current']), 'integration-smoke')
    assert.equal(gitValue(projectWorkspace, ['rev-parse', 'HEAD']), deliveryHead)
    assert.equal(gitValue(projectWorkspace, ['rev-parse', 'refs/heads/main']), deliveryHead)
    assert.equal(gitValue(managedWorktreeReceipt.data.path, ['rev-parse', 'HEAD']), commitSha)
    assert.equal(gitValue(managedWorktreeReceipt.data.path, ['rev-parse', 'HEAD^']), deliveryHead)
    assert.equal(gitValue(managedWorktreeReceipt.data.path, ['status', '--porcelain']), '')
    const verifiedCommit = spawnSync('/usr/bin/git', ['verify-commit', commitSha], {
      cwd: managedWorktreeReceipt.data.path,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(verifiedCommit.status, 0, verifiedCommit.stderr)
    assert.equal(existsSync(join(projectWorkspace, 'governed-feature-commit.txt')), false)
    assert.equal(
      readFileSync(join(managedWorktreeReceipt.data.path, 'governed-feature-commit.txt'), 'utf8'),
      'native governed commit\n',
    )
  }
  assert.equal(readFileSync(join(projectWorkspace, '.dsh-validation-count'), 'utf8'), 'validated')
  assert.equal(
    readFileSync(join(projectWorkspace, 'finish-line-native-mutation.txt'), 'utf8'),
    'ordinary mutation\n',
  )
  assert.equal(result.isError, false)
  assert.equal(result.value, 42)
  assert.deepEqual(result.content, [{ type: 'text', text: '42' }])
  assert.equal(receipt.plusOneExecutions, 1)
  assert.equal(receipt.activePolicyChecks, 0)
  assert.equal(receipt.activeFinishLineRequests, 0)
  assert.equal(receipt.activeFinishLineReservations, 0)
  assert.equal(receipt.activeAcceptanceOperations, 0)
  assert.equal(receipt.finishLineDegraded, false)
  assert.equal(receipt.pendingPolicyMarkers, 0)
  assert.equal(receipt.pendingPrerequisites, 0)
  assert.equal(receipt.pendingCorrelations, 0)
  assert.equal(receipt.exactCorrelation, true)
  if (authoritativeAcceptance) {
    assert.equal(receipt.acceptanceEnabled, true)
    assert.equal(receipt.acceptanceGoalBlocked.code, 'DSH_ACCEPTANCE_BLOCKED')
    assert.ok(
      ['infrastructure-blocked', 'missing'].includes(receipt.acceptanceGoalBlocked.aggregate),
    )
    assert.equal(receipt.acceptanceVerdict.action, 'allow')
    assert.equal(receipt.acceptanceVerdict.aggregate, 'satisfied')
    assert.deepEqual(receipt.acceptanceVerdict.requirements.map(entry => [entry.name, entry.status]), [
      ['package', 'satisfied'],
      ['unit', 'satisfied'],
    ])
    assert.equal(receipt.acceptanceGoalCompletion.phase, 'complete')
  }
  if (agentConsoleTuiPackage !== undefined) assert.equal(receipt.userQuestions, true)
  for (const laneTool of [
    'main_agent_run_initialize',
    'main_agent_worker_launch',
    'main_agent_worker_interrupt',
    'main_agent_lane_close',
    'main_agent_worker_supervise',
    'main_agent_worker_request_changes',
    'main_agent_worker_accept',
    'main_agent_run_closeout',
  ]) {
    assert.ok(
      receipt.tools.includes(laneTool),
      `Main Agent Mode did not activate in real DSH: ${laneTool} is unregistered `
        + `(tools: ${receipt.tools.join(', ')})`,
    )
  }
  // The lane checkpoint tool carries per-lane authority, so it must exist only
  // inside a lane child's own context — never on the controller's tool surface.
  assert.equal(
    receipt.tools.includes('main_agent_checkpoint'),
    false,
    'the lane checkpoint tool must not be globally registered',
  )
  assert.equal(receipt.tools.includes('runtime_kit_governed_commit'), true)
  assert.equal(
    receipt.mainAgentOrchestration?.apiVersion,
    1,
    'the versioned orchestration service is provided in a real DSH composition',
  )
  const forbiddenRuntimeSurface = /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i
  assert.equal(receipt.tools.some(name => forbiddenRuntimeSurface.test(name)), false)
  assert.equal(
    receipt.providers.some(name => /co.?author(?:ship)?[-_ ]?trailer/i.test(name)),
    false,
  )
  if (agentConsoleTuiPackage === undefined) {
    assert.equal(receipt.providers.some(name => forbiddenRuntimeSurface.test(name)), false)
  } else {
    assert.equal(receipt.providers.includes('codex-proxy'), true)
  }
  assert.deepEqual(receipt.lifecycle, [
    'session-start:startup',
    'pre-step:1:1',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:2',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:3',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:4',
    'turn-stop:1',
    'pre-step:1:5',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:6',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:7',
    'turn-stop:1',
    'pre-step:1:8',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:9',
    'pre-tool',
    'post-tool',
    'result',
    'pre-step:1:10',
    ...(deliveryRehearsal ? [
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:11',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:12',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:13',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:14',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:15',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:16',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:17',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:18',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:19',
      'pre-tool',
      'post-tool',
      'result',
      'pre-step:1:20',
    ] : []),
    'turn-stop:1',
    ...(authoritativeAcceptance ? [
      'pre-step:2:1',
      'turn-stop:2',
    ] : []),
  ])

  const skillLine = boot.stdout.split('\n').find(candidate => candidate.startsWith(skillMarker))
  assert.ok(skillLine, `missing ${skillMarker} output:\n${boot.stdout}\n${boot.stderr}`)
  const skillReceipt = JSON.parse(skillLine.slice(skillMarker.length))
  assert.equal(skillReceipt.count, 31, JSON.stringify(skillReceipt))
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
  assert.equal(skillReceipt.names.includes('codex-only'), false)
  assert.equal(skillReceipt.names.includes('claude-only'), false)
  const providerSkillLoaded = skillReceipt.names.some(
    name => name === 'codex-only' || name === 'claude-only',
  ) || JSON.stringify(skillReceipt).includes('PROVIDER_SKILL_MUST_NOT_LOAD')
  const providerHookLoaded = JSON.stringify(receipt).includes('ambient-provider-hook-must-not-load')
  const providerSessionStateLoaded = existsSync(providerSessionMarker)
  assert.equal(providerSkillLoaded, false)
  assert.equal(providerHookLoaded, false)
  assert.equal(providerSessionStateLoaded, false)
  assert.match(providerSkillFixtureSha256, /^[0-9a-f]{64}$/u)
  assert.match(providerHookFixtureSha256, /^[0-9a-f]{64}$/u)
  assert.match(providerSessionFixtureSha256, /^[0-9a-f]{64}$/u)

  resetCheckoutLease()
  const reviewerBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-reviewer',
        DSH_RUNTIME_KIT_SMOKE_REVIEWER: '1',
      },
    },
  )
  const reviewerLine = reviewerBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    reviewerLine,
    `missing reviewer ${marker} output:\n${reviewerBoot.stdout}\n${reviewerBoot.stderr}`,
  )
  const reviewerReceipt = JSON.parse(reviewerLine.slice(marker.length))
  assert.equal(reviewerReceipt.reviewResult.isError, false, JSON.stringify(reviewerReceipt))
  assert.equal(
    reviewerReceipt.reviewResult.value.schema_version,
    'dsh-runtime-kit.review-specialists.result.v1',
  )
  assert.equal(reviewerReceipt.reviewResult.value.status, 'completed')
  assert.deepEqual(reviewerReceipt.reviewResult.value.results.map(entry => entry.role), [
    'reviewer-quick',
  ])
  assert.match(
    reviewerReceipt.reviewResult.value.results[0].summary,
    /reviewer completed after the denied mutation/,
  )
  assert.equal(reviewerReceipt.reviewResult.value.results[0].verdict, 'findings')
  assert.equal(reviewerReceipt.reviewResult.value.results[0].finding_count, 3)
  assert.equal(reviewerReceipt.reviewResult.value.red_team, 'not-run')
  assert.match(reviewerReceipt.reviewResult.value.findings_jsonl, /"specialist":"quick"/)
  const reviewerFindingsPath = join(temporaryRoot, 'reviewer-findings.jsonl')
  writeFileSync(reviewerFindingsPath, reviewerReceipt.reviewResult.value.findings_jsonl)
  const reviewSpecialistsBin = process.env.DSH_RUNTIME_KIT_SMOKE_REVIEW_SPECIALISTS_BIN
    ?? join(dirname(agentHookBin), 'review-specialists')
  const reviewerValidation = spawnSync(
    reviewSpecialistsBin,
    ['validate', '--input', reviewerFindingsPath, '--format', 'json'],
    { encoding: 'utf8', env: environment },
  )
  assert.equal(
    reviewerValidation.status,
    0,
    `review-specialists validate failed:\n${reviewerValidation.stdout}\n${reviewerValidation.stderr}`,
  )
  assert.equal(JSON.parse(reviewerValidation.stdout).data.findings_count, 3)
  const reviewerBundleDir = join(temporaryRoot, 'reviewer-provider-review')
  const reviewerBundle = spawnSync(
    reviewSpecialistsBin,
    [
      'bundle',
      '--mode', 'delivery',
      '--input', reviewerFindingsPath,
      '--out-dir', reviewerBundleDir,
      '--profile', 'provider-review',
      '--repo', 'sympoies/dsh-runtime-kit',
      '--ref', dshRevision,
      '--reviewable', 'sympoies/dsh-runtime-kit#1',
      '--lens', 'quick',
      '--lens-verdict', 'findings',
      '--scope', 'packed reviewer provider-review transport',
      '--evidence-reviewed', 'native reviewer and mutation-denial smoke',
      '--format', 'json',
    ],
    { encoding: 'utf8', env: environment },
  )
  assert.equal(
    reviewerBundle.status,
    0,
    `review-specialists bundle failed:\n${reviewerBundle.stdout}\n${reviewerBundle.stderr}`,
  )
  const reviewerReportPath = join(reviewerBundleDir, 'provider-review.md')
  const reviewerThreadsPath = join(reviewerBundleDir, 'review-threads.json')
  const reviewerReport = readFileSync(reviewerReportPath, 'utf8')
  assert.match(
    reviewerReport,
    /\| Finding \| Severity \| Confidence \| Evidence \| Recommendation \|/u,
  )
  assert.match(reviewerReport, /The report also retains a non-actionable observation\./u)
  const reviewerThreads = JSON.parse(readFileSync(reviewerThreadsPath, 'utf8'))
  assert.equal(reviewerThreads.length, 2)
  assert.deepEqual(reviewerThreads.map(thread => thread.path), [
    'test/smoke.mjs',
    'src/review/index.js',
  ])
  assert.equal(reviewerThreads[0].line, 1)
  assert.equal(reviewerThreads[1].line, undefined)
  const forgeCliBin = join(dirname(agentHookBin), 'forge-cli')
  const providerReviewValidation = spawnSync(
    forgeCliBin,
    [
      '--provider', 'local',
      '--repo', 'local:dsh-runtime-kit-smoke',
      '--format', 'json',
      'pr', 'review', 'validate',
      '--specialist-report',
      '--comment-file', reviewerReportPath,
      '--thread-file', reviewerThreadsPath,
    ],
    { encoding: 'utf8', env: environment },
  )
  assert.equal(
    providerReviewValidation.status,
    0,
    `forge-cli specialist validation failed:\n${providerReviewValidation.stdout}\n${providerReviewValidation.stderr}`,
  )
  assert.equal(JSON.parse(providerReviewValidation.stdout).ok, true)
  const publisherHarnessPath = join(temporaryRoot, 'recording-forge-review-publish.mjs')
  writeFileSync(publisherHarnessPath, `
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) throw new Error('missing ' + name)
  return args[index + 1]
}
if (!args.includes('--submit-review')) throw new Error('missing --submit-review')
const prIndex = args.indexOf('pr')
if (prIndex < 0 || args[prIndex + 1] !== 'review-publish' || args[prIndex + 2] !== '1') {
  throw new Error('invalid review-publish target')
}
const repo = value('--repo')
const head = value('--expected-head')
const commentFile = value('--comment-file')
const threadFile = value('--thread-file')
if (!existsSync(commentFile) || !existsSync(threadFile)) throw new Error('missing review bundle')
const nativeUrl = 'https://github.com/' + repo + '/pull/1#pullrequestreview-1'
const nativeAuthor = 'sympoies-dsh-release-reviewer[bot]'
const app = [
  '--repo', repo,
  'pr', 'review', '1',
  '--decision', value('--decision'),
  '--expected-head', head,
  '--comment-file', commentFile,
  '--thread-file', threadFile,
  '--submit-review',
]
const personal = [
  '--repo', repo,
  'pr', 'review', '1',
  '--decision', value('--decision'),
  '--metadata-only',
  '--expected-head', head,
  '--native-review-url', nativeUrl,
  '--native-review-author', nativeAuthor,
  '--lens', value('--lens'),
]
process.stdout.write(JSON.stringify({ app, personal, nativeUrl, nativeAuthor }))
`)
  const publication = spawnSync(
    process.execPath,
    [
      publisherHarnessPath,
      '--format', 'json',
      '--provider', 'github',
      '--repo', 'sympoies/dsh-runtime-kit',
      'pr', 'review-publish', '1',
      '--decision', 'comments-only',
      '--expected-head', dshRevision,
      '--comment-file', reviewerReportPath,
      '--thread-file', reviewerThreadsPath,
      '--lens', 'quick',
      '--submit-review',
    ],
    { encoding: 'utf8', env: environment },
  )
  assert.equal(
    publication.status,
    0,
    `recording publisher failed:\n${publication.stdout}\n${publication.stderr}`,
  )
  const publishedCalls = JSON.parse(publication.stdout)
  assert.equal(publishedCalls.app.filter(arg => arg === '--comment-file').length, 1)
  assert.equal(publishedCalls.app.filter(arg => arg === '--thread-file').length, 1)
  assert.ok(publishedCalls.app.includes(reviewerReportPath))
  assert.ok(publishedCalls.app.includes(reviewerThreadsPath))
  assert.ok(publishedCalls.app.includes(dshRevision))
  assert.ok(publishedCalls.personal.includes('--metadata-only'))
  assert.ok(publishedCalls.personal.includes(dshRevision))
  assert.ok(publishedCalls.personal.includes(publishedCalls.nativeUrl))
  assert.ok(publishedCalls.personal.includes(publishedCalls.nativeAuthor))
  assert.equal(publishedCalls.personal.includes('--comment-file'), false)
  assert.equal(publishedCalls.personal.includes('--thread-file'), false)
  assert.equal(reviewerReceipt.reviewerMutationResult.isError, true)
  assert.match(
    reviewerReceipt.reviewerMutationResult.content[0].text,
    /read-only reviewer reviewer-quick cannot execute "write"/,
  )
  assert.equal(reviewerReceipt.reviewerCalls, 2)
  assert.equal(reviewerReceipt.reviewerChildLive, false)
  assert.ok(reviewerReceipt.reviewerChildEvents.includes('dsh-runtime-kit/reviewer'))
  assert.ok(reviewerReceipt.reviewerChildEvents.includes('sandbox/mode'))
  assert.equal(
    existsSync(join(projectWorkspace, 'reviewer-mutation-must-not-exist.txt')),
    false,
  )

  resetCheckoutLease()
  const resumeSessionId = 'dsh-runtime-kit-smoke-resume'
  const resumableBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    { env: { ...environment, DSH_RUNTIME_KIT_SMOKE_SESSION_ID: resumeSessionId } },
  )
  const resumableLine = resumableBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    resumableLine,
    `missing resumable ${marker} output:\n${resumableBoot.stdout}\n${resumableBoot.stderr}`,
  )
  const resumableReceipt = JSON.parse(resumableLine.slice(marker.length))
  assert.equal(resumableReceipt.result.value, 42)
  assert.equal(resumableReceipt.editResult.isError, false, JSON.stringify(resumableReceipt))
  assert.equal(resumableReceipt.finishLineDegraded, false)
  assert.equal(resumableReceipt.lifecycle[0], 'session-start:startup')

  const resumedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: resumeSessionId,
        DSH_RUNTIME_KIT_SMOKE_RESUME: '1',
      },
    },
  )
  const resumedLine = resumedBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    resumedLine,
    `missing resumed ${marker} output:\n${resumedBoot.stdout}\n${resumedBoot.stderr}`,
  )
  const resumedReceipt = JSON.parse(resumedLine.slice(marker.length))
  assert.equal(resumedReceipt.result.value, 42)
  assert.equal(resumedReceipt.editResult.isError, false, JSON.stringify(resumedReceipt))
  assert.equal(resumedReceipt.validationResults.length, 3)
  assert.equal(resumedReceipt.activeFinishLineRequests, 0)
  assert.equal(resumedReceipt.activeFinishLineReservations, 0)
  assert.equal(resumedReceipt.finishLineDegraded, false, JSON.stringify({
    finishLineDegraded: resumedReceipt.finishLineDegraded,
    activeFinishLineRequests: resumedReceipt.activeFinishLineRequests,
    activeFinishLineReservations: resumedReceipt.activeFinishLineReservations,
    pendingCorrelations: resumedReceipt.pendingCorrelations,
    errors: resumedReceipt.errors,
  }))
  assert.equal(resumedReceipt.lifecycle[0], 'session-start:resume')

  resetCheckoutLease()
  const codeModeBoot = runDsh(
    ['--profile', profile, '--patch', codeModeOverlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-code-mode',
        DSH_RUNTIME_KIT_SMOKE_CODE_MODE: '1',
      },
    },
  )
  const codeModeLine = codeModeBoot.stdout
    .split('\n')
    .find(candidate => candidate.startsWith(marker))
  assert.ok(
    codeModeLine,
    `missing Code Mode ${marker} output:\n${codeModeBoot.stdout}\n${codeModeBoot.stderr}`,
  )
  const codeModeReceipt = JSON.parse(codeModeLine.slice(marker.length))
  assert.equal(codeModeReceipt.result.isError, false, JSON.stringify(codeModeReceipt))
  assert.equal(codeModeReceipt.result.value, 42)
  assert.equal(codeModeReceipt.runCodeResult.isError, false, JSON.stringify(codeModeReceipt))
  assert.deepEqual(codeModeReceipt.runCodeResult.value, { logs: [], result: 42 })
  assert.equal(codeModeReceipt.plusOneExecutions, 1)
  assert.equal(codeModeReceipt.contextVisibility[0], false)
  assert.ok(codeModeReceipt.contextVisibility.length >= 2)
  assert.ok(codeModeReceipt.contextVisibility.slice(1).every(Boolean))
  assert.ok(codeModeReceipt.healthContextVisibility.every(value => value === false))
  assert.ok(codeModeReceipt.sessionEvents.includes('tool/code-dispatch-start'))
  assert.ok(codeModeReceipt.sessionEvents.includes('tool/code-dispatch'))
  assert.equal(codeModeReceipt.pendingPrerequisites, 0)
  assert.equal(codeModeReceipt.pendingPolicyMarkers, 0)
  assert.equal(codeModeReceipt.pendingCorrelations, 0)

  resetCheckoutLease()
  installPolicy('block')
  const blockedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-blocked',
        DSH_RUNTIME_KIT_SMOKE_EXPECT: 'block',
      },
    },
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
  assert.equal(blockedReceipt.pendingPrerequisites, 0)
  assert.equal(blockedReceipt.pendingCorrelations, 0)
  assert.equal(blockedReceipt.exactCorrelation, true)

  installPolicy('allow')
  resetCheckoutLease()
  const shortCircuitedBoot = runDsh(
    ['--profile', profile, '--patch', overlayPath],
    {
      env: {
        ...environment,
        DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-short-circuit',
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
  assert.equal(shortCircuitedReceipt.pendingPrerequisites, 0)
  assert.equal(shortCircuitedReceipt.pendingCorrelations, 0)

  assertProviderSentinel(codexHome, 'codex')
  assertProviderSentinel(claudeHome, 'claude')

  const nativeMainAgentReceipt = runNativeMainAgentSmoke({
    llmModuleUrl,
    sessionModuleUrl,
    profile,
  })
  const nativeMainAgentLossReceipt = runNativeMainAgentSmoke({
    llmModuleUrl,
    sessionModuleUrl,
    profile,
    mode: 'process-loss',
  })

  const finalDshCheckout = await manageDshPatch({
    action: 'check',
    sourceRoot: dshRoot,
    patchRoot: projectRoot,
    manifest: dshPatchManifest,
    gitBin: '/usr/bin/git',
  })
  assert.deepEqual(finalDshCheckout, initialDshCheckout)

    process.stdout.write(JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    ok: true,
    producer: 'packed-runtime',
    scenarios: [
      { id: 'edit', status: 'passed', producer: 'packed-runtime', evidence: ['finish-line:edit-generation-recorded'] },
      { id: 'validate', status: 'passed', producer: 'packed-runtime', evidence: ['finish-line:exact-validation-executed'] },
      { id: 'review', status: 'passed', producer: 'packed-runtime', evidence: ['reviewer:mutation-denied-before-body'] },
      {
        id: 'private-project-skill',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'skills:private-project-precedence',
          'coexistence:no-cross-loaded-hooks-skills-session-state',
          'coexistence:dsh-hook-docs-state-isolated',
        ],
        isolation: {
          schema_version: 'dsh-runtime-kit.runtime-isolation.v1',
          provider_skill_loaded: providerSkillLoaded,
          provider_hook_loaded: providerHookLoaded,
          provider_session_state_loaded: providerSessionStateLoaded,
          provider_skill_fixture_sha256: providerSkillFixtureSha256,
          provider_hook_fixture_sha256: providerHookFixtureSha256,
          provider_session_fixture_sha256: providerSessionFixtureSha256,
        },
      },
      { id: 'resume', status: 'passed', producer: 'packed-runtime', evidence: ['finish-line:session-resumed'] },
      { id: 'subagent', status: 'passed', producer: 'packed-runtime', evidence: ['reviewer:native-subagent-completed'] },
      {
        id: 'native-main-agent-lane',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'main-agent:host-workspace-before-prompt',
          'main-agent:model-driven-review-loop',
          'main-agent:no-anchor-agent',
          'main-agent:forced-harness-loss-converged-without-stale-sidecar-trust',
        ],
      },
      ...(authoritativeAcceptance ? [{
        id: 'authoritative-acceptance',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'acceptance:goal-completion-blocked-pre-mutation',
          'acceptance:exact-provider-verdict-satisfied',
          'acceptance:goal-completion-allowed-post-evidence',
        ],
      }] : []),
      {
        id: 'automatic-prerequisite',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'prerequisite:mutating-tool-body-gated',
          'prerequisite:code-mode-nested-dispatch-gated',
          'prerequisite:context-ferried-through-run-code',
        ],
      },
      { id: 'finish-line', status: 'passed', producer: 'packed-runtime', evidence: ['finish-line:result-driven-stop-satisfied'] },
      { id: 'failure-paths', status: 'passed', producer: 'packed-runtime', evidence: [
        'policy:blocked-before-body',
        'policy:short-circuit-bypass-rejected',
        ...(deliveryRehearsal ? [
          'governed-commit:stale-expected-head-rejected',
          'governed-commit:foreign-session-denied-before-body',
        ] : []),
        'runtime-health:unauthenticated-companion-blocked-before-model',
        'runtime-health:project-audit-blocked-before-middleware-and-adapter',
        'runtime-health:same-session-project-recovery',
        'runtime-health:authenticated-companion-recovered-on-remount',
      ] },
    ],
    dshVersion: dshManifest.version,
    dshProfile: profile,
    tool: 'runtime_kit_plus_one',
    input: 41,
    output: result.value,
    runtimeContextVerified: true,
    startupContextAbsent: [
      receipt,
      reviewerReceipt,
      resumableReceipt,
      resumedReceipt,
      codeModeReceipt,
      projectHealthBlockedReceipt,
      projectHealthRecoveredReceipt,
      blockedReceipt,
      shortCircuitedReceipt,
    ].every(candidate => candidate.healthContextVisibility.every(value => value === false))
      && !blockedHealthOutput.includes(marker),
    nativeHealthBlockedBeforeModelVerified:
      projectHealthBlockedReceipt.adapterSessionCalls === 0
      && projectHealthBlockedReceipt.modelMiddlewareCalls === 0,
    nativeHealthRecoveryVerified:
      projectHealthRecoveredReceipt.result.value === 42
      && result.value === 42,
    nativeFullHostAuthorityVerified: fullHostAuthority,
    nativeFullHostCapabilities: fullHostAuthority ? nativeFullHostCapabilities : [],
    policyBlockVerified: true,
    shortCircuitGuardVerified: true,
    lifecycleCorrelationVerified: true,
    cancellationAndDisposalVerified: true,
    rejectedLifecycleAttemptsVerified: true,
    providerRetirementVerified: true,
    authoritativeAcceptanceVerified: authoritativeAcceptance,
    authoritativeAcceptanceAggregate: authoritativeAcceptance
      ? receipt.acceptanceVerdict.aggregate
      : undefined,
    authoritativeAcceptanceRequirements: authoritativeAcceptance
      ? receipt.acceptanceVerdict.requirements.map(entry => ({
          name: entry.name,
          status: entry.status,
        }))
      : undefined,
    resultDrivenFinishLineVerified: true,
    resumeFinishLineVerified: true,
    managedWorktreeRehearsalVerified: deliveryRehearsal,
    unsafeDefaultDeliveryBlocked: deliveryRehearsal,
    governedDefaultDeliveryDryRunVerified: deliveryRehearsal,
    governedFeatureCommitVerified: deliveryRehearsal,
    governedStaleHeadRejected: deliveryRehearsal,
    governedForeignSessionBlocked: deliveryRehearsal,
    nativeReviewSpecialistsVerified: true,
    nativeMainAgentLaneVerified: nativeMainAgentReceipt.ok,
    nativeMainAgentProcessLossVerified: nativeMainAgentLossReceipt.ok
      && nativeMainAgentLossReceipt.process_loss.forced
      && nativeMainAgentLossReceipt.process_loss.stale_open_sidecar_observed,
    codeModeNestedPrerequisiteVerified: true,
    reviewerMutationBlockedBeforeBody: true,
    agentConsoleProfileInspectionVerified: agentConsoleTuiPackage === undefined
      ? false
      : receipt.agentConsoleInspection.compatible,
    agentConsoleTuiArtifactVerified,
    agentConsoleTuiPatchVerified,
    agentConsoleTuiHistoryNonblockingVerified,
    agentConsoleTuiStartupVerified,
    agentConsoleScopedToolAuthorityVerified: agentConsoleTuiPackage === undefined
      ? false
      : receipt.agentConsoleObservation.composition.controllerTools
          .includes('main_agent_checkpoint') === false
        && receipt.agentConsoleObservation.composition.laneTools
          .includes('main_agent_checkpoint'),
    agentConsoleSolInheritanceVerified: agentConsoleTuiPackage === undefined
      ? false
      : receipt.agentConsoleInspection.worker_route.provider === 'codex-proxy'
        && receipt.agentConsoleInspection.worker_route.model === 'gpt-5.6-sol'
        && receipt.agentConsoleInspection.worker_route.reasoningEffort === 'high',
    externalProviderMutationAttempted: false,
    nilsCompatibilityStatus: nilsCompatibility.status,
    nilsCompatibilityCandidateFeature: nilsCandidateFeature,
    skillCount: skillReceipt.count,
    skillPrecedenceVerified: true,
    }) + '\n')
  }
} finally {
  for (const controller of nativeControllerSessions) {
    spawnSync(controller.agentSessionBin, [
      '--state-dir', controller.stateDir,
      'delete',
      controller.sessionId,
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 30_000 })
  }
  if (process.env.DSH_RUNTIME_KIT_SMOKE_KEEP_ROOT === '1') {
    process.stderr.write(`DSH_RUNTIME_KIT_SMOKE_ROOT=${temporaryRoot}\n`)
  } else {
    rmSync(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
}
