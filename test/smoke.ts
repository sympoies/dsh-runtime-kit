import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { parse as parseYaml } from 'yaml'

import { manageDshPatch } from '../dist/src/compat/dsh-patch.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const agentDocsBin = resolve(process.env.AGENT_DOCS_BIN ?? '')
const pnpmBin = process.env.PNPM_BIN ?? 'pnpm'

// pnpm derives its store directory from HOME unless PNPM_HOME is set. This
// smoke deliberately overrides HOME for isolation, which moves the resolved
// store away from the one the DSH checkout was installed against. pnpm's
// checkCompatibility then throws UnexpectedStoreError, every workspace project
// becomes a purge candidate, and the run aborts as
// ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. CI never meets this because
// pnpm/action-setup exports PNPM_HOME, which pins the store independently of
// HOME. Pin it here to the store the checkout itself records, so its
// node_modules is never a purge candidate. Setting CI=true would authorize the
// purge instead of preventing it, and must not be used for this.
// See sympoies/dsh-runtime-kit#191.
function resolveDshPnpmHome() {
  if (process.env.PNPM_HOME !== undefined) return process.env.PNPM_HOME
  const modulesManifest = join(dshRoot, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesManifest)) return undefined
  const storeDir = parseYaml(readFileSync(modulesManifest, 'utf8'))?.storeDir
  if (typeof storeDir !== 'string' || storeDir.length === 0) return undefined
  // pnpm lays the store out as <PNPM_HOME>/store/<version>.
  return resolve(storeDir, '..', '..')
}
const dshPnpmHome = resolveDshPnpmHome()

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
  '@deepseek-ai/cordis': '4.0.4',
  '@deepseek-ai/dsh-agent': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-bash-local': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-fs': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-llm': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-sandbox': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-skill-filesystem': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-subagent': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-subprocess': '0.1.7-rc.1 || 0.2.0-rc.2',
  '@deepseek-ai/dsh-tools': '0.1.7-rc.1 || 0.2.0-rc.2',
})
const nilsCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'),
)
assert.equal(nilsCompatibility.schema_version, 'dsh-runtime-kit.nils-compatibility.v1')
assert.equal(nilsCompatibility.status, 'released')
assert.equal(nilsCompatibility.minimum_supported_release, '1.33.0')
assert.equal(nilsCompatibility.validated_release, '1.33.2')
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
const agentHookStateDir = join(runtimeRoot, 'state', 'agent-hook')
const agentHookWrapper = join(temporaryRoot, 'agent-hook-isolation-wrapper')
const providerSessionMarker = join(temporaryRoot, 'provider-session-env-observed')
const agentDocsHome = join(runtimeRoot, 'agent-docs')
const agentDocsStateHome = join(runtimeRoot, 'agent-docs-state')
const ownerLauncher = join(projectRoot, 'dist', 'bin', 'dsh-runtime-kit-launch.js')
const privateSkillsRoot = join(temporaryRoot, 'private-skills')
const projectWorkspace = join(temporaryRoot, 'project')
// A plain directory with no .git ancestor: the non-git session leg runs here.
const plainWorkspace = join(temporaryRoot, 'plain-notes')
const dataPolicyProtectedRoot = join(projectWorkspace, '.data-policy-protected')
const dataPolicyProtectedAlias = join(projectWorkspace, 'data-policy-protected-alias')
const dataPolicySentinel = 'ghp_issue61_synthetic_sensitive_value'
const dataPolicyMachinePath = '/home/fixture/issue61/result.txt'
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
const dataPolicyCandidateEnabled = nilsCandidateFeature !== undefined
  && nilsCandidateFeature === nilsCompatibility.candidate_validation?.feature
const profile = 'runtime-kit-smoke'
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
  DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL: dataPolicySentinel,
  DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_MACHINE_PATH: dataPolicyMachinePath,
  DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_PROTECTED_ROOT: dataPolicyProtectedRoot,
  DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_PROTECTED_ALIAS: dataPolicyProtectedAlias,
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
  ...dshPnpmHome === undefined ? {} : { PNPM_HOME: dshPnpmHome },
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
  rmSync(join(projectWorkspace, 'artifacts'), { recursive: true, force: true })
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

function collectFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? collectFiles(join(directory, entry.name), relative)
      : [relative]
  })
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
  mkdirSync(dataPolicyProtectedRoot, { recursive: true })
  symlinkSync(dataPolicyProtectedRoot, dataPolicyProtectedAlias, 'dir')
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
  mkdirSync(plainWorkspace, { recursive: true })
  writeFileSync(join(plainWorkspace, 'notes.md'), 'notes\n')
  writeFileSync(join(plainWorkspace, 'AGENT_DOCS.toml'), projectDocsConfig)
  assert.equal(existsSync(join(plainWorkspace, '.git')), false)
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
    'index.ts',
    'policy.ts',
    'dist/bin/dsh-runtime-kit-launch.js',
    'dist/bin/dsh-runtime-kit.js',
    'dist/scripts/check-rule-parity-source.js',
    'dist/scripts/manage-dsh-patch.js',
    'dist/src/operations/supervise-command.js',
    'src/compat/dsh-rc7.ts',
    'src/context/index.ts',
    'src/context/nils-context.ts',
    'src/finish-line/index.ts',
    'src/finish-line/nils-client.ts',
    'src/authoritative-acceptance/index.ts',
    'src/policy/index.ts',
    'src/policy/nils-transport.ts',
    'src/prerequisite/index.ts',
    'src/review/index.ts',
    'src/workspace-lease/index.ts',
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
    'agent-home/AGENTS.md',
    'cordis.patch.yml',
    'compatibility/dsh.json',
    'compatibility/dsh-patches.json',
    'compatibility/nils-cli.json',
    'scripts/benchmark-policy.ts',
    'scripts/check-dsh-compatibility.ts',
    'scripts/manage-dsh-patch.ts',
    'scripts/pack-dsh-compatibility-peers.ts',
    'scripts/stage-dsh-compatibility-peers.ts',
    'src/compat/contract.ts',
    'src/compat/dsh-patch.ts',
    'src/compat/git-checkout.ts',
    'src/compat/package-artifact.ts',
    'src/compat/performance.ts',
    'src/compat/upstream-reference.ts',
    'patches/deepseek-harness/native-execution-boundaries-v5-0-1-5-alpha-2.patch',
    'patches/deepseek-harness/native-execution-boundaries-v5-0-2-0-rc-2.patch',
    'policy/dsh-runtime-kit-v1.toml',
    'policy/rule-parity.yaml',
    'policy/runtime-rule-parity.yaml',
    'scripts/check-rule-parity-source.ts',
    'scripts/verify-policy-parity.ts',
    'docs/policies/git-delivery.md',
    'docs/policies/review-thread-convergence.md',
    'docs/workspace-leases.md',
    'skills/bootstrap/SKILL.md',
    'test/workspace-lease-smoke.ts',
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
  assert.match(packedText('scripts/check-rule-parity-source.ts'), /policy\/rule-parity\.yaml/u)
  assert.match(packedText('scripts/verify-policy-parity.ts'), /policy\/runtime-rule-parity\.yaml/u)
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
  runDsh(['plugin', '--profile', profile, 'add', tarball])

  const dump = runDsh(['--profile', profile, '--dump-config']).stdout
  assert.match(dump, /# == @sympoies\/dsh-runtime-kit/)
  assert.match(dump, /id: dsh-runtime-kit/)
  assert.match(dump, /name: '@sympoies\/dsh-runtime-kit'/)
  assert.doesNotMatch(dump, /agent-runtime-kit/u)
  assert.doesNotMatch(dump, /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i)

  const driverPath = join(temporaryRoot, 'smoke-driver.mjs')
  const overlayPath = join(temporaryRoot, 'smoke.patch.yml')
  const codeModeOverlayPath = join(temporaryRoot, 'smoke-code-mode.patch.yml')
  const dataPolicyOverlayPath = join(temporaryRoot, 'smoke-data-policy.patch.yml')
  const sandboxRunnerPath = join(temporaryRoot, 'smoke-sandbox-runner.sh')
  const llmModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'llm', 'llm', 'lib', 'index.js'),
  ).href
  const sessionModuleUrl = pathToFileURL(
    join(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js'),
  ).href
  // The smoke starts DSH from this source checkout. Resolve the scope symbol
  // from that same host graph, including when its profile uses installed bundles.
  const scopeModuleSpecifier = pathToFileURL(join(dshRoot, 'packages', 'core', 'scope', 'src', 'index.ts')).href
  const lifecycleModuleSpecifier = pathToFileURL(
    join(projectRoot, 'dist', 'src', 'compat', 'dsh-agent-lifecycle.js'),
  ).href
  writeFileSync(driverPath, `
import * as llmModule from ${JSON.stringify(llmModuleUrl)}
import { SessionId } from ${JSON.stringify(sessionModuleUrl)}
import { scopeOf } from ${JSON.stringify(scopeModuleSpecifier)}
import { onDshSessionStart } from ${JSON.stringify(lifecycleModuleSpecifier)}
import { rmSync } from 'node:fs'

const { LlmAdapter, createUserMessage } = llmModule
const makeCallId = llmModule.ToolCallId ?? llmModule.CallId

function sessionEvents(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

const smokeRoute = ${JSON.stringify({ provider: 'runtime-kit-smoke', model: 'scripted' })}

export const name = 'dsh-runtime-kit-smoke-driver'
// Required injection makes missing ordinary runtime services fail at activation.
export const inject = [
  'agents',
  'dshAcceptance',
  'goals',
  'llm',
  'skills',
  'tools',
  'dshRuntimeKit',
  'userQuestions',
]

function toolCallResponse(name, value, suffix) {
  const id = makeCallId('dsh-runtime-kit-smoke-' + suffix)
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

function artifactRefs(serialized) {
  const seen = []
  for (const match of serialized.matchAll(/artifact:[0-9a-f]{32}/g)) {
    if (!seen.includes(match[0])) seen.push(match[0])
  }
  return seen
}

function artifactSequence(serialized) {
  const sentinel = process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_SENTINEL ?? 'smoke-artifact-sentinel'
  const foreignRef = process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_FOREIGN_REF
  if (foreignRef) {
    return [
      toolCallResponse('artifact_present', { ref: foreignRef }, 'artifact-foreign-present'),
      toolCallResponse('artifact_read', { ref: foreignRef }, 'artifact-foreign-read'),
      toolCallResponse('artifact_export', {
        ref: foreignRef,
        destination: { class: 'workspace', path: 'artifacts/foreign-leak.json' },
      }, 'artifact-foreign-export'),
      toolCallResponse('artifact_dispose', { ref: foreignRef }, 'artifact-foreign-dispose'),
      textResponse('artifact foreign smoke done'),
    ]
  }
  if (process.env.DSH_RUNTIME_KIT_SMOKE_RESUME === '1') {
    const retainedRef = process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_RETAINED_REF
    const sessionRef = process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_SESSION_REF
    return [
      toolCallResponse('artifact_present', { ref: retainedRef }, 'artifact-resumed-present'),
      toolCallResponse('artifact_read', { ref: retainedRef }, 'artifact-resumed-read'),
      toolCallResponse('artifact_present', { ref: sessionRef }, 'artifact-resumed-session-present'),
      toolCallResponse('artifact_dispose', { ref: retainedRef }, 'artifact-resumed-dispose'),
      textResponse('artifact resume smoke done'),
    ]
  }
  const refs = artifactRefs(serialized)
  const sessionRef = refs[0] ?? 'artifact:' + '0'.repeat(32)
  return [
    toolCallResponse('artifact_write', {
      name: 'smoke-report.md',
      media_type: 'text/markdown',
      content: '# Smoke report\\n\\n' + sentinel + '\\n',
    }, 'artifact-write-session'),
    toolCallResponse('artifact_write', {
      name: 'smoke-evidence.json',
      media_type: 'application/json',
      content: JSON.stringify({ ok: true, sentinel }),
      retention: 'retained',
    }, 'artifact-write-retained'),
    // Left undisposed on purpose: the host must reclaim it when the owner
    // agent is disposed at process exit.
    toolCallResponse('artifact_write', {
      name: 'smoke-orphan.txt',
      media_type: 'text/plain',
      content: 'undisposed session artifact',
    }, 'artifact-write-session-orphan'),
    toolCallResponse('artifact_present', { ref: sessionRef }, 'artifact-present'),
    toolCallResponse('artifact_read', { ref: sessionRef }, 'artifact-read'),
    toolCallResponse('artifact_export', {
      ref: sessionRef,
      destination: { class: 'workspace', path: 'artifacts/smoke-report.md' },
    }, 'artifact-export'),
    toolCallResponse('artifact_export', {
      ref: sessionRef,
      destination: { class: 'download' },
    }, 'artifact-export-download'),
    toolCallResponse('artifact_export', {
      ref: sessionRef,
      destination: { class: 'workspace', path: '../smoke-escape.md' },
    }, 'artifact-export-escape'),
    // The workspace export is a real repository mutation, so the finish-line
    // requires the declared validation before the turn may stop.
    toolCallResponse('bash', {
      command: ${JSON.stringify(validationCommand)},
      description: 'Run the declared validation after the artifact export',
    }, 'artifact-validation-one'),
    toolCallResponse('bash', {
      command: ${JSON.stringify(validationCommand)},
      description: 'Rerun the declared validation after its expected first failure',
    }, 'artifact-validation-two'),
    toolCallResponse('artifact_dispose', { ref: sessionRef }, 'artifact-dispose'),
    toolCallResponse('artifact_present', { ref: sessionRef }, 'artifact-present-disposed'),
    textResponse('artifact smoke done'),
  ]
}

/**
 * The composed system prompt for one request, on either supported contract.
 * 0.1.2-rc.1 renders it into the request's system field; 0.1.5-alpha.2
 * removed that field and projects the same text into session history. The
 * supported window spans both, so the harness reads both surfaces rather than
 * binding to one release's delivery shape.
 * @param options - the adapter request under inspection.
 * @returns every byte the release could have used to carry the prompt.
 */
function composedSystemPrompt(options) {
  return String(options.system ?? '') + ' ' + JSON.stringify(options.messages ?? [])
}

class SmokeAdapter extends LlmAdapter {
  totalCalls = 0
  sessionCalls = 0
  parentCalls = 0
  deliveryCalls = 0
  foreignCalls = 0
  reviewerCalls = 0
  lastMessages = ''
  contextVisibility = []
  providerContextVisibility = []
  policyContextVisibility = []
  userPromptPolicyContextVisibility = []
  healthContextVisibility = []
  healthAuditSentinelVisibility = []
  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'high', name: 'high' }] },
    })
  }
  async *stream(options) {
    this.totalCalls += 1
    if (String(options.sessionId ?? '')
      === String(process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID ?? '')) {
      this.sessionCalls += 1
    }
    // The supported releases deliver the composed system prompt differently:
    // 0.1.2-rc.1 passes it as the request's system field, while
    // 0.1.5-alpha.2 projects it into session history instead. Search both
    // surfaces so one harness identifies the child on either contract; a
    // release-specific read silently stops matching and the scripted child
    // then answers as an ordinary agent.
    const isReviewer = composedSystemPrompt(options)
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
              path: 'test/smoke.ts',
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
              path: 'src/review/index.ts',
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
    this.lastMessages = serializedMessages
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
        .some(message => message.source?.kind === 'dsh-runtime-kit'
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
    const sequence = process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY === '1'
      ? [
          toolCallResponse('native_sensitive_fixture', {
            token: process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL,
          }, 'data-native-sensitive'),
          toolCallResponse('web_fixture', {}, 'data-web-machine-path'),
          toolCallResponse('mcp__fixture__secret', {}, 'data-mcp-sensitive'),
          toolCallResponse('bash', {
            command: "printf 'ghp_%s%s' 'issue61_' 'synthetic_sensitive_value'",
            description: 'Return a synthetic sensitive value from shell output',
          }, 'data-shell-sensitive'),
          toolCallResponse('run_code', {
            code: 'return await tools.mcp__fixture__secret({})',
            description: 'Return a synthetic sensitive value through nested Code Mode',
          }, 'data-code-sensitive'),
          toolCallResponse('write', {
            file_path: process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_PROTECTED_ROOT
              + '/direct.txt',
            content: 'must not be written',
          }, 'data-protected-direct'),
          toolCallResponse('write', {
            file_path: '.data-policy-protected/relative.txt',
            content: 'must not be written',
          }, 'data-protected-relative'),
          toolCallResponse('write', {
            file_path: process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_PROTECTED_ALIAS
              + '/symlink.txt',
            content: 'must not be written',
          }, 'data-protected-symlink'),
          toolCallResponse('bash', {
            command: "printf 'must not be written' > .data-policy-protected/shell.txt",
            description: 'Attempt a delegated protected-root write',
          }, 'data-protected-shell'),
          toolCallResponse('bash', {
            command: ${JSON.stringify(validationCommand)},
            description: 'Run the declared validation after protected writes',
          }, 'data-policy-validation-one'),
          toolCallResponse('bash', {
            command: ${JSON.stringify(validationCommand)},
            description: 'Rerun the declared validation after its expected first failure',
          }, 'data-policy-validation-two'),
          textResponse('data policy smoke done'),
        ]
      : process.env.DSH_RUNTIME_KIT_SMOKE_NON_GIT === '1'
        ? [
            toolCallResponse('runtime_context', { intent: 'project-dev' }, 'non-git-context'),
            toolCallResponse('bash', {
              command: 'cat notes.md',
              description: 'read the notes in a directory that is not a repository',
            }, 'non-git-read'),
            toolCallResponse('write', {
              file_path: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT + '/notes-index.md',
              content: 'index of the notes\\n',
            }, 'non-git-write'),
            toolCallResponse('runtime_kit_governed_commit', {
              type: 'feat',
              subject: 'add the notes index',
              body_bullets: ['Index the notes so the next reader finds them.'],
              expected_head: "dddddddddddddddddddddddddddddddddddddddd",
            }, 'non-git-governed-commit'),
          ]
      : process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS === '1'
        ? artifactSequence(serializedMessages)
      : process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER === '1'
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
      && process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY !== '1'
      && process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS !== '1'
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
      && process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY !== '1'
      && process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS !== '1'
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
      let reviewerChildRole
      let reviewerMutationResult
      let acceptanceGoal
      let acceptanceGoalBlocked
      let acceptanceGoalCompletion
      let acceptanceVerdict
      let nativeSensitiveExecutions = 0
      let webFixtureExecutions = 0
      let mcpFixtureExecutions = 0
      let modelMiddlewareCalls = 0
      const validationResults = []
      const deliveryValidationResults = []
      const dataPolicyAudits = []
      const dataPolicyResults = []
      const artifactResults = []
      const errors = []
      ctx.on('dsh-runtime-kit/data-policy-audit', audit => {
        dataPolicyAudits.push(audit)
      })
      ctx.on('llm/stream', (options, next) => {
        if (String(options.sessionId ?? '') === targetId) modelMiddlewareCalls += 1
        return next()
      })
      onDshSessionStart(ctx, ({ agent, source }) => {
        if (String(agent.id) === targetId) lifecycle.push('session-start:' + source)
      })
      ctx.on('agent/created', ({ agent }) => {
        if (agent.session?.header?.parentSession === targetId) {
          reviewerChild = agent
          reviewerChildRole = ctx.get('subagents')?.roleOf(agent)
        }
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
          if (process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS === '1'
            && String(exec.name).startsWith('artifact_')) {
            const value = finalResult?.isError === true ? undefined : finalResult?.value
            const sentinel = process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_SENTINEL ?? ''
            artifactResults.push({
              callId: exec.callId,
              name: exec.name,
              isError: finalResult?.isError === true,
              code: finalResult?.error?.info?.code
                ?? (/^(ARTIFACT_[A-Z_]+):/.exec(String(finalResult?.error?.message ?? '')) ?? [])[1],
              errorMessage: finalResult?.isError === true
                ? String(finalResult?.error?.message ?? '').slice(0, 200)
                : undefined,
              ref: value?.ref,
              sha256: value?.sha256,
              bytes: value?.bytes,
              mediaType: value?.media_type,
              retentionClass: value?.retention_class,
              destinationClass: value?.destination_class,
              destinationPath: value?.destination_path,
              outcome: value?.outcome,
              encoding: value?.encoding,
              hasPreview: typeof value?.preview === 'string',
              previewHasSentinel: typeof value?.preview === 'string' && value.preview.includes(sentinel),
              contentHasSentinel: typeof value?.content === 'string' && value.content.includes(sentinel),
              capabilities: Array.isArray(value?.capabilities) ? value.capabilities : undefined,
            })
          }
          if (process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY === '1') {
            dataPolicyResults.push({
              callId: exec.callId,
              name: exec.name,
              protectedKind: exec.name === 'write'
                ? exec.arguments?.file_path === '.data-policy-protected/relative.txt'
                  ? 'relative'
                  : exec.arguments?.file_path?.includes('data-policy-protected-alias')
                    ? 'symlink'
                    : 'direct'
                : exec.name === 'bash'
                    && exec.arguments?.command?.includes('.data-policy-protected/shell.txt')
                  ? 'delegated-shell'
                  : undefined,
              isError: finalResult?.isError === true,
              sandboxDenied: finalResult?.value?.sandbox?.denied === true,
              exitCode: Number.isInteger(finalResult?.value?.exitCode)
                ? finalResult.value.exitCode
                : undefined,
              rawPresent: JSON.stringify(finalResult)
                .includes(process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL),
            })
          }
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
      const fixtureOutput = {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      }
      ctx.tools.register({
        name: 'native_sensitive_fixture',
        description: 'Synthetic native pre-call data-policy fixture.',
        parameters: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
          additionalProperties: false,
        },
        output: fixtureOutput,
        async execute() {
          nativeSensitiveExecutions += 1
          return { executed: true }
        },
      })
      ctx.tools.register({
        name: 'web_fixture',
        description: 'Synthetic web result data-policy fixture.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: fixtureOutput,
        async execute() {
          webFixtureExecutions += 1
          return { artifact: process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_MACHINE_PATH }
        },
      })
      ctx.tools.register({
        name: 'mcp__fixture__secret',
        description: 'Synthetic MCP result data-policy fixture.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: fixtureOutput,
        async execute() {
          mcpFixtureExecutions += 1
          return { token: process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL }
        },
      })
      const plusOneDefinition = ctx.tools.get('runtime_kit_plus_one')
      if (plusOneDefinition === undefined) {
        throw new Error('runtime_kit_plus_one definition missing before prerequisite registration')
      }
      ctx.dshRuntimeKit.prerequisites.require(plusOneDefinition, 'project-dev-context')
      const acceptanceEnabled = process.env.DSH_RUNTIME_KIT_SMOKE_ACCEPTANCE === '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_SESSION_ID === 'dsh-runtime-kit-smoke-primary'
      const dataPolicyEnabled = process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY === '1'
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
          setup: undefined,
        })
        : await ctx.agents.create({
          sessionId: SessionId(targetId),
          agentOptions: smokeRoute,
          meta: {
            cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT,
          },
          setup: undefined,
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
      const agentScope = scopeOf(agent.ctx)
      if (agentScope === undefined) throw new Error('smoke agent scope was not mounted')
      const skillOptions = {
        cwd: process.env.DSH_RUNTIME_KIT_SMOKE_PROJECT,
        scope: agentScope,
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
          },
          setup: undefined,
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
          },
          setup: undefined,
        })
        foreignHandle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'attempt the foreign governed commit' }],
          source: { kind: 'user' },
        }))
        await foreignHandle.agent.whenIdle()
      }

      const controllerTools = ctx.tools.schemas(agent).map(tool => tool.name)
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
        reviewerChildRole,
        reviewerChildEvents: reviewerChild === undefined
          ? undefined
          : sessionEvents(reviewerChild.session).map(event => event.type),
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
        dataPolicyEnabled,
        dataPolicyResults,
        dataPolicyAudits,
        dataPolicyAuditCount: ctx.dshRuntimeKit.dataPolicyAuditCount,
        dataPolicyNativeSensitiveExecutions: nativeSensitiveExecutions,
        dataPolicyWebFixtureExecutions: webFixtureExecutions,
        dataPolicyMcpFixtureExecutions: mcpFixtureExecutions,
        dataPolicyRawAbsent: !JSON.stringify({
          dataPolicyResults,
          dataPolicyAudits,
          errors,
          sessionEvents: sessionEvents(agent.session),
        }).includes(process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL),
        artifactResults,
        finishLineSteers: [...adapter.lastMessages.matchAll(/Finish-line blocked: [^"\\\\]{0,400}/g)].map(match => match[0]),
        artifactServiceActive: ctx.get('dshRuntimeArtifacts') !== undefined,
        artifactToolsRegistered: ['artifact_write', 'artifact_present', 'artifact_read', 'artifact_export', 'artifact_dispose']
          .every(name => ctx.tools.get(name) !== undefined),
        artifactRootAbsent: process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_ROOT === undefined
          || !JSON.stringify({
            artifactResults,
            errors,
            sessionEvents: agent.session.events,
            messages: adapter.lastMessages,
          }).includes(process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_ROOT),
        contextVisibility: adapter.contextVisibility,
        providerContextVisibility: adapter.providerContextVisibility,
        policyContextVisibility: adapter.policyContextVisibility,
        userPromptPolicyContextVisibility: adapter.userPromptPolicyContextVisibility,
        healthContextVisibility: adapter.healthContextVisibility,
        healthAuditSentinelVisibility: adapter.healthAuditSentinelVisibility,
        lifecycle,
        errors,
        sessionEvents: sessionEvents(agent.session).map(event => event.type),
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
        && !dataPolicyEnabled
        && process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS !== '1'
        && process.env.DSH_RUNTIME_KIT_SMOKE_CODE_MODE !== '1'
        && (process.env.DSH_RUNTIME_KIT_SMOKE_RESUME === '1'
          ? !adapter.contextVisibility.every(Boolean)
          : adapter.contextVisibility[0] !== false
            || adapter.contextVisibility.length < 2
            || !adapter.contextVisibility.slice(1).every(Boolean))) {
        process.exitCode = 1
      }
      if (process.env.DSH_RUNTIME_KIT_SMOKE_REVIEWER !== '1'
        && !dataPolicyEnabled
        && process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS !== '1'
        && (expectation === 'allow' || expectation === 'health-recovery')
        && result?.value !== 42) process.exitCode = 1
      if (process.env.DSH_RUNTIME_KIT_SMOKE_ARTIFACTS === '1'
        && (artifactResults.length === 0
          || artifactResults.some(candidate => candidate.isError && candidate.code === undefined))) {
        process.exitCode = 1
      }
      if (dataPolicyEnabled
        && (nativeSensitiveExecutions !== 0
          || webFixtureExecutions !== 1
          || mcpFixtureExecutions < 2
          || dataPolicyResults.length < 11
          || dataPolicyResults.some(candidate => candidate.rawPresent)
          || !['direct', 'relative', 'symlink'].every(kind =>
            dataPolicyResults.some(candidate => candidate.protectedKind === kind
              && candidate.isError === true))
          || !dataPolicyResults.some(candidate => candidate.protectedKind === 'delegated-shell'
            && candidate.isError === false
            && candidate.sandboxDenied === true
            && candidate.exitCode !== 0)
          || dataPolicyResults.filter(candidate =>
            candidate.callId?.includes('data-policy-validation-')).length !== 2
          || dataPolicyResults.find(candidate =>
            candidate.callId?.endsWith('data-policy-validation-one'))?.exitCode === 0
          || dataPolicyResults.find(candidate =>
            candidate.callId?.endsWith('data-policy-validation-two'))?.exitCode !== 0
          || dataPolicyResults.filter(candidate =>
            candidate.callId?.includes('data-policy-validation-')).some(candidate =>
              candidate.isError === true)
          || dataPolicyResults.filter(candidate =>
            !candidate.callId?.includes('data-policy-validation-')
              && candidate.protectedKind !== 'delegated-shell').some(candidate =>
                candidate.isError !== true)
          || dataPolicyAudits.length < 9
          || dataPolicyAudits.some(audit => !Array.isArray(audit.matched_rule_ids))
          || JSON.stringify({ dataPolicyAudits, errors, sessionEvents: sessionEvents(agent.session) })
            .includes(process.env.DSH_RUNTIME_KIT_SMOKE_DATA_POLICY_SENTINEL))) {
        process.exitCode = 1
      }
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
  writeFileSync(overlayPath, `
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
    - id: dsh-runtime-kit-smoke-driver
      name: ${JSON.stringify(driverPath)}
`)
  writeFileSync(dataPolicyOverlayPath, `
- id: tools
  config:
    mode: both
- insert:
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
  assert.equal(receipt.tools.includes('runtime_kit_governed_commit'), true)
  assert.equal(receipt.tools.some(tool => tool.startsWith('main_agent_')), false)
  const forbiddenRuntimeSurface = /(?:claude|anthropic|co.?author(?:ship)?[-_ ]?trailer)/i
  assert.equal(receipt.tools.some(name => forbiddenRuntimeSurface.test(name)), false)
  assert.equal(
    receipt.providers.some(name => /co.?author(?:ship)?[-_ ]?trailer/i.test(name)),
    false,
  )
  assert.equal(receipt.providers.some(name => forbiddenRuntimeSurface.test(name)), false)
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
  assert.equal(skillReceipt.count, 29, JSON.stringify(skillReceipt))
  assert.equal(new Set(skillReceipt.names).size, 29)
  assert.equal(skillReceipt.names.includes('main-agent-mode'), false)
  assert.equal(skillReceipt.names.includes('code-review-specialists'), true)
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
    'test/smoke.ts',
    'src/review/index.ts',
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
    /restricted role reviewer-quick cannot execute "write"/,
  )
  assert.equal(reviewerReceipt.reviewerCalls, 2)
  assert.equal(reviewerReceipt.reviewerChildLive, false)
  assert.equal(reviewerReceipt.reviewerChildRole, 'reviewer-quick')
  assert.ok(reviewerReceipt.reviewerChildEvents.includes('sandbox/mode'))
  assert.ok(reviewerReceipt.reviewerChildEvents.includes('approval/policy'))
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
  // alpha.6 makes the PTC sandbox projection observable. Keep the earlier
  // release's exact result shape while authenticating every added alpha.6
  // field instead of accepting an open-ended additive object. Upstream emits
  // the optional enforcement field only when the selected sandbox provider
  // reports it, and this smoke accepts only the independently usable `full`
  // value when present.
  const codeModeSandbox = codeModeReceipt.runCodeResult.value?.sandbox
  assert.ok(
    codeModeSandbox?.enforcement === undefined || codeModeSandbox.enforcement === 'full',
    JSON.stringify(codeModeReceipt),
  )
  assert.deepEqual(
    codeModeReceipt.runCodeResult.value,
    ['0.1.7-rc.1', '0.2.0-rc.2'].includes(dshManifest.version)
      ? {
          logs: [],
          sandbox: {
            mode: environment.DSH_PERMISSION_MODE,
            denied: false,
            ...(codeModeSandbox.enforcement === undefined
              ? {}
              : { enforcement: 'full' }),
          },
          result: 42,
        }
      : { logs: [], result: 42 },
  )
  assert.equal(codeModeReceipt.plusOneExecutions, 1)
  assert.equal(codeModeReceipt.contextVisibility[0], false)
  assert.ok(codeModeReceipt.contextVisibility.length >= 2)
  assert.ok(codeModeReceipt.contextVisibility.slice(1).every(Boolean))
  assert.ok(codeModeReceipt.healthContextVisibility.every(value => value === false))
  // The retained releases emit tool/ptc-dispatch*; accept the earlier event
  // name while the smoke driver still parses historical session fixtures.
  assert.ok(codeModeReceipt.sessionEvents.includes('tool/code-dispatch-start')
    || codeModeReceipt.sessionEvents.includes('tool/ptc-dispatch-start'))
  assert.ok(codeModeReceipt.sessionEvents.includes('tool/code-dispatch')
    || codeModeReceipt.sessionEvents.includes('tool/ptc-dispatch'))
  assert.equal(codeModeReceipt.pendingPrerequisites, 0)
  assert.equal(codeModeReceipt.pendingPolicyMarkers, 0)
  assert.equal(codeModeReceipt.pendingCorrelations, 0)

  resetCheckoutLease()
  const artifactSessionId = 'dsh-runtime-kit-smoke-artifacts'
  const artifactsRoot = join(dshHome, 'dsh-runtime-kit', 'artifacts', 'v1')
  const artifactSentinel = 'dsh-runtime-kit-smoke-artifact-sentinel-' + createHash('sha256')
    .update(temporaryRoot)
    .digest('hex')
    .slice(0, 16)
  const artifactReportContent = '# Smoke report\n\n' + artifactSentinel + '\n'
  const artifactReportSha256 = 'sha256:' + createHash('sha256').update(artifactReportContent).digest('hex')
  const artifactEnvironment = {
    ...environment,
    DSH_RUNTIME_KIT_SMOKE_SESSION_ID: artifactSessionId,
    DSH_RUNTIME_KIT_SMOKE_ARTIFACTS: '1',
    DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_ROOT: artifactsRoot,
    DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_SENTINEL: artifactSentinel,
  }
  function readArtifactReceipt(boot, label) {
    const line = boot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
    assert.ok(line, `missing ${label} ${marker} output:\n${boot.stdout}\n${boot.stderr}`)
    const output = `${boot.stdout}\n${boot.stderr}`
    assert.equal(output.includes(artifactsRoot), false, `${label} output leaked the artifact store root`)
    const receipt = JSON.parse(line.slice(marker.length))
    assert.equal(receipt.artifactServiceActive, true, JSON.stringify(receipt.errors))
    assert.equal(receipt.artifactToolsRegistered, true)
    assert.equal(receipt.artifactRootAbsent, true)
    return receipt
  }
  function artifactResult(receipt, suffix) {
    const result = receipt.artifactResults.find(candidate => candidate.callId === 'dsh-runtime-kit-smoke-' + suffix)
    assert.ok(result, `missing artifact result ${suffix}: ${JSON.stringify(receipt.artifactResults)}`)
    return result
  }
  function artifactStoreState() {
    assert.equal(statSync(artifactsRoot).mode & 0o777, 0o700)
    const objects = []
    for (const bucket of readdirSync(join(artifactsRoot, 'objects'))) {
      objects.push(...readdirSync(join(artifactsRoot, 'objects', bucket)))
    }
    return {
      index: readdirSync(join(artifactsRoot, 'index')).length,
      objects: objects.length,
      staging: readdirSync(join(artifactsRoot, 'tmp')).length,
    }
  }

  const artifactBoot = runDsh(['--profile', profile, '--patch', overlayPath], { env: artifactEnvironment })
  const artifactReceipt = readArtifactReceipt(artifactBoot, 'artifact')
  assert.equal(artifactReceipt.lifecycle[0], 'session-start:startup')
  const artifactWrite = artifactResult(artifactReceipt, 'artifact-write-session')
  assert.equal(artifactWrite.isError, false, JSON.stringify(artifactWrite))
  assert.match(artifactWrite.ref, /^artifact:[0-9a-f]{32}$/)
  assert.equal(artifactWrite.sha256, artifactReportSha256)
  assert.equal(artifactWrite.bytes, Buffer.byteLength(artifactReportContent))
  assert.equal(artifactWrite.mediaType, 'text/markdown')
  assert.equal(artifactWrite.retentionClass, 'session')
  const artifactRetained = artifactResult(artifactReceipt, 'artifact-write-retained')
  assert.equal(artifactRetained.isError, false, JSON.stringify(artifactRetained))
  assert.equal(artifactRetained.retentionClass, 'retained')
  assert.equal(artifactRetained.mediaType, 'application/json')
  assert.notEqual(artifactRetained.ref, artifactWrite.ref)
  const artifactPresent = artifactResult(artifactReceipt, 'artifact-present')
  assert.equal(artifactPresent.isError, false, JSON.stringify(artifactPresent))
  assert.equal(artifactPresent.ref, artifactWrite.ref)
  assert.equal(artifactPresent.sha256, artifactReportSha256)
  assert.equal(artifactPresent.previewHasSentinel, true)
  assert.deepEqual(artifactPresent.capabilities, ['read', 'present', 'export', 'delete'])
  const artifactRead = artifactResult(artifactReceipt, 'artifact-read')
  assert.equal(artifactRead.isError, false, JSON.stringify(artifactRead))
  assert.equal(artifactRead.encoding, 'utf8')
  assert.equal(artifactRead.contentHasSentinel, true)
  const artifactExport = artifactResult(artifactReceipt, 'artifact-export')
  assert.equal(artifactExport.isError, false, JSON.stringify(artifactExport))
  assert.equal(artifactExport.destinationClass, 'workspace')
  assert.equal(artifactExport.destinationPath, 'artifacts/smoke-report.md')
  assert.equal(artifactExport.sha256, artifactReportSha256)
  assert.equal(readFileSync(join(projectWorkspace, 'artifacts', 'smoke-report.md'), 'utf8'), artifactReportContent)
  const artifactDownload = artifactResult(artifactReceipt, 'artifact-export-download')
  assert.equal(artifactDownload.isError, true)
  assert.equal(artifactDownload.code, 'ARTIFACT_CAPABILITY_UNSUPPORTED')
  const artifactEscape = artifactResult(artifactReceipt, 'artifact-export-escape')
  assert.equal(artifactEscape.isError, true)
  assert.equal(artifactEscape.code, 'ARTIFACT_EXPORT_DESTINATION_INVALID')
  assert.equal(existsSync(join(dirname(projectWorkspace), 'smoke-escape.md')), false)
  const artifactDispose = artifactResult(artifactReceipt, 'artifact-dispose')
  assert.equal(artifactDispose.isError, false, JSON.stringify(artifactDispose))
  assert.equal(artifactDispose.outcome, 'disposed')
  const artifactDisposedPresent = artifactResult(artifactReceipt, 'artifact-present-disposed')
  assert.equal(artifactDisposedPresent.isError, true)
  assert.equal(artifactDisposedPresent.code, 'ARTIFACT_NOT_FOUND')
  const artifactOrphan = artifactResult(artifactReceipt, 'artifact-write-session-orphan')
  assert.equal(artifactOrphan.isError, false, JSON.stringify(artifactOrphan))
  assert.equal(artifactOrphan.retentionClass, 'session')
  // The explicitly disposed record is gone. The undisposed session-class
  // record is reclaimed at owner-agent disposal when the host disposes its
  // agents on exit, and otherwise by the next service start's dead-generation
  // sweep; both outcomes are checked deterministically after the next boot.
  const afterFirstBoot = artifactStoreState()
  assert.equal(afterFirstBoot.staging, 0)
  assert.equal(afterFirstBoot.index, afterFirstBoot.objects)
  assert.ok(afterFirstBoot.index === 1 || afterFirstBoot.index === 2, JSON.stringify(afterFirstBoot))
  // The exported file is untracked repository state; remove it so the next
  // session can claim the shared smoke checkout cleanly.
  rmSync(join(projectWorkspace, 'artifacts'), { recursive: true, force: true })

  resetCheckoutLease()
  const foreignArtifactBoot = runDsh(['--profile', profile, '--patch', overlayPath], {
    env: {
      ...artifactEnvironment,
      DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-artifacts-foreign',
      DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_FOREIGN_REF: artifactRetained.ref,
    },
  })
  const foreignArtifactReceipt = readArtifactReceipt(foreignArtifactBoot, 'foreign artifact')
  for (const suffix of ['artifact-foreign-present', 'artifact-foreign-read', 'artifact-foreign-export', 'artifact-foreign-dispose']) {
    const result = artifactResult(foreignArtifactReceipt, suffix)
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.equal(result.code, 'ARTIFACT_ACCESS_DENIED', JSON.stringify(result))
  }
  assert.equal(existsSync(join(projectWorkspace, 'artifacts', 'foreign-leak.json')), false)
  // The foreign boot is a fresh host: its startup sweep reclaims the first
  // host's dead-generation session-class record, so exactly the retained
  // record remains regardless of how the first host exited.
  assert.deepEqual(artifactStoreState(), { index: 1, objects: 1, staging: 0 })

  resetCheckoutLease()
  const resumedArtifactBoot = runDsh(['--profile', profile, '--patch', overlayPath], {
    env: {
      ...artifactEnvironment,
      DSH_RUNTIME_KIT_SMOKE_RESUME: '1',
      DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_RETAINED_REF: artifactRetained.ref,
      DSH_RUNTIME_KIT_SMOKE_ARTIFACTS_SESSION_REF: artifactOrphan.ref,
    },
  })
  const resumedArtifactReceipt = readArtifactReceipt(resumedArtifactBoot, 'resumed artifact')
  assert.equal(resumedArtifactReceipt.lifecycle[0], 'session-start:resume')
  const resumedPresent = artifactResult(resumedArtifactReceipt, 'artifact-resumed-present')
  assert.equal(resumedPresent.isError, false, JSON.stringify(resumedPresent))
  assert.equal(resumedPresent.ref, artifactRetained.ref)
  assert.equal(resumedPresent.sha256, artifactRetained.sha256)
  assert.equal(resumedPresent.previewHasSentinel, true)
  const resumedRead = artifactResult(resumedArtifactReceipt, 'artifact-resumed-read')
  assert.equal(resumedRead.isError, false, JSON.stringify(resumedRead))
  assert.equal(resumedRead.contentHasSentinel, true)
  const resumedSessionPresent = artifactResult(resumedArtifactReceipt, 'artifact-resumed-session-present')
  assert.equal(resumedSessionPresent.isError, true)
  assert.equal(resumedSessionPresent.code, 'ARTIFACT_NOT_FOUND')
  const resumedDispose = artifactResult(resumedArtifactReceipt, 'artifact-resumed-dispose')
  assert.equal(resumedDispose.isError, false, JSON.stringify(resumedDispose))
  assert.deepEqual(artifactStoreState(), { index: 0, objects: 0, staging: 0 })

  if (dataPolicyCandidateEnabled) {
    resetCheckoutLease()
    const dataPolicyBoot = runDsh(
      ['--profile', profile, '--patch', dataPolicyOverlayPath],
      {
        env: {
          ...environment,
          DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-data-policy',
          DSH_RUNTIME_KIT_SMOKE_DATA_POLICY: '1',
          DSH_RUNTIME_KIT_PROTECTED_ROOTS: JSON.stringify([dataPolicyProtectedRoot]),
        },
      },
    )
    const dataPolicyOutput = `${dataPolicyBoot.stdout}\n${dataPolicyBoot.stderr}`
    assert.doesNotMatch(dataPolicyOutput, new RegExp(dataPolicySentinel, 'u'))
    const dataPolicyLine = dataPolicyBoot.stdout
      .split('\n')
      .find(candidate => candidate.startsWith(marker))
    assert.ok(
      dataPolicyLine,
      `missing data-policy ${marker} output:\n${dataPolicyBoot.stdout}\n${dataPolicyBoot.stderr}`,
    )
    const dataPolicyReceipt = JSON.parse(dataPolicyLine.slice(marker.length))
    assert.equal(dataPolicyReceipt.dataPolicyEnabled, true)
    assert.equal(dataPolicyReceipt.dataPolicyNativeSensitiveExecutions, 0)
    assert.equal(dataPolicyReceipt.dataPolicyWebFixtureExecutions, 1)
    assert.ok(dataPolicyReceipt.dataPolicyMcpFixtureExecutions >= 2)
    assert.equal(dataPolicyReceipt.dataPolicyRawAbsent, true)
    assert.equal(dataPolicyReceipt.dataPolicyAuditCount, dataPolicyReceipt.dataPolicyAudits.length)
    assert.ok(dataPolicyReceipt.dataPolicyResults.length >= 11)
    assert.ok(dataPolicyReceipt.dataPolicyResults.every(candidate => candidate.rawPresent === false))
    assert.ok(['direct', 'relative', 'symlink'].every(kind =>
      dataPolicyReceipt.dataPolicyResults.some(candidate =>
        candidate.protectedKind === kind && candidate.isError === true)))
    assert.ok(dataPolicyReceipt.dataPolicyResults.some(candidate =>
      candidate.protectedKind === 'delegated-shell'
        && candidate.isError === false
        && candidate.sandboxDenied === true
        && candidate.exitCode !== 0))
    const dataPolicyValidations = dataPolicyReceipt.dataPolicyResults.filter(candidate =>
      candidate.callId?.includes('data-policy-validation-'))
    assert.equal(dataPolicyValidations.length, 2)
    assert.ok(dataPolicyValidations.every(candidate => candidate.isError === false))
    assert.notEqual(dataPolicyValidations[0].exitCode, 0)
    assert.equal(dataPolicyValidations[1].exitCode, 0)
    assert.deepEqual(
      [...new Set(dataPolicyReceipt.dataPolicyAudits.map(audit => audit.source_id))].sort(),
      ['tool.code', 'tool.mcp', 'tool.native', 'tool.shell', 'tool.web'],
    )
    assert.ok(dataPolicyReceipt.dataPolicyAudits.some(audit =>
      audit.matched_rule_ids.includes('runtime.data-policy.pre.sensitive-deny')))
    assert.ok(dataPolicyReceipt.dataPolicyAudits.some(audit =>
      audit.matched_rule_ids.includes('runtime.data-policy.final.sensitive-deny')))
    assert.ok(dataPolicyReceipt.dataPolicyAudits.some(audit =>
      audit.matched_rule_ids.includes('runtime.data-policy.final.machine-path-quarantine')))
    assert.equal(existsSync(join(dataPolicyProtectedRoot, 'direct.txt')), false)
    assert.equal(existsSync(join(dataPolicyProtectedRoot, 'relative.txt')), false)
    assert.equal(existsSync(join(dataPolicyProtectedRoot, 'symlink.txt')), false)
    assert.equal(existsSync(join(dataPolicyProtectedRoot, 'shell.txt')), false)
  }

  // Non-git folder: the session anchor is context only. Skills, the project
  // context prerequisite, a read, a write, and runtime_kit_plus_one all run
  // with zero denials, and the governed commit answers no-repository instead
  // of failing typed or being denied by the default-delivery seam.
  resetCheckoutLease()
  const nonGitBoot = runDsh(['--profile', profile, '--patch', overlayPath], {
    env: {
      ...environment,
      DSH_RUNTIME_KIT_SMOKE_SESSION_ID: 'dsh-runtime-kit-smoke-non-git',
      DSH_RUNTIME_KIT_SMOKE_NON_GIT: '1',
      DSH_RUNTIME_KIT_SMOKE_PROJECT: plainWorkspace,
    },
  })
  const nonGitLine = nonGitBoot.stdout.split('\n').find(candidate => candidate.startsWith(marker))
  assert.ok(nonGitLine, `missing non-git ${marker} output:\n${nonGitBoot.stdout}\n${nonGitBoot.stderr}`)
  const nonGitReceipt = JSON.parse(nonGitLine.slice(marker.length))
  const nonGitSkillLine = nonGitBoot.stdout.split('\n').find(candidate => candidate.startsWith(skillMarker))
  assert.ok(nonGitSkillLine, `missing non-git ${skillMarker} output:\n${nonGitBoot.stdout}`)
  assert.ok(JSON.parse(nonGitSkillLine.slice(skillMarker.length)).count > 0, 'skills resolve in a non-git cwd')
  assert.equal(nonGitReceipt.contextResult?.isError, false, JSON.stringify(nonGitReceipt.contextResult))
  assert.equal(nonGitReceipt.validationResults.length, 1, JSON.stringify(nonGitReceipt.validationResults))
  assert.equal(nonGitReceipt.validationResults[0].isError, false, JSON.stringify(nonGitReceipt.validationResults[0]))
  assert.equal(nonGitReceipt.validationResults[0].value?.exitCode, 0)
  assert.equal(nonGitReceipt.editResult?.isError, false, JSON.stringify(nonGitReceipt.editResult))
  assert.equal(readFileSync(join(plainWorkspace, 'notes-index.md'), 'utf8'), 'index of the notes\n')
  assert.equal(nonGitReceipt.result?.value, 42, JSON.stringify(nonGitReceipt.result))
  assert.equal(nonGitReceipt.defaultGovernedCommitResult?.isError, false, JSON.stringify(nonGitReceipt.defaultGovernedCommitResult))
  assert.equal(nonGitReceipt.defaultGovernedCommitResult.value.status, 'no-repository')
  assert.match(nonGitReceipt.defaultGovernedCommitResult.value.guidance, /not inside a Git repository/)
  assert.deepEqual(nonGitReceipt.healthDenialCodes, [])
  assert.deepEqual(nonGitReceipt.finishLineSteers, [])
  assert.equal(existsSync(join(plainWorkspace, '.git')), false)
  rmSync(join(plainWorkspace, 'notes-index.md'), { force: true })

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


  // Exercise the ordinary host workspace boundary independently of the reviewer.
  // git-cli owns the worktree; only this trusted fixture holds its opaque selector.
  resetCheckoutLease()
  const nativeWorktreeResult = spawnSync(smokeGitCli, [
    'worktree', 'add', 'native-subagent-workspace', '--from', 'main', '--kind', 'feature', '--format', 'json',
  ], { cwd: projectWorkspace, env: environment, encoding: 'utf8', timeout: 30_000 })
  assert.equal(
    nativeWorktreeResult.status,
    0,
    [nativeWorktreeResult.stdout, nativeWorktreeResult.stderr].filter(Boolean).join('\n'),
  )
  const nativeWorktreeEnvelope = JSON.parse(nativeWorktreeResult.stdout)
  assert.equal(nativeWorktreeEnvelope.ok, true)
  const nativeWorkspace = realpathSync(nativeWorktreeEnvelope.data.path)
  assert.notEqual(nativeWorkspace, realpathSync(projectWorkspace))
  assert.equal(statSync(join(nativeWorkspace, '.git')).isFile(), true)
  const nativeCommonDirectory = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: nativeWorkspace, env: environment, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(nativeCommonDirectory.status, 0, nativeCommonDirectory.stderr)
  assert.equal(realpathSync(nativeCommonDirectory.stdout.trim()), realpathSync(join(projectWorkspace, '.git')))
  const nativeDriverPath = join(temporaryRoot, 'native-subagent-workspace-driver.mjs')
  const nativeOverlayPath = join(temporaryRoot, 'native-subagent-workspace.patch.yml')
  const nativeFixtureUrl = pathToFileURL(join(projectRoot, 'test', 'fixtures', 'native-subagent-workspace.mjs')).href
  writeFileSync(nativeDriverPath, `
import assert from 'node:assert/strict'
import { LlmAdapter } from ${JSON.stringify(llmModuleUrl)}
import { SessionId } from ${JSON.stringify(sessionModuleUrl)}
import { probeNativeSubagentWorkspace } from ${JSON.stringify(nativeFixtureUrl)}
export const name = 'native-subagent-workspace-smoke'
export const inject = ['agents', 'llm', 'subagents', 'workspaceLease']
const route = { provider: 'native-workspace-smoke', model: 'scripted' }
export function apply(ctx) {
  void (async () => {
    let handle
    try {
      let childModelCalls = 0
      const errors = []
      ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
      class Adapter extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model } }
        async *stream(options) {
          if (String(options.sessionId) !== 'native-workspace-parent') childModelCalls += 1
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Native workspace complete.' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native workspace complete.' } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter([route.provider], new Adapter())
      handle = await ctx.agents.create({
        sessionId: SessionId('native-workspace-parent'), agentOptions: route,
        meta: { cwd: ${JSON.stringify(realpathSync(projectWorkspace))} }, setup: undefined,
      })
      const receipt = await probeNativeSubagentWorkspace(ctx, {
        parent: handle.agent, workspace: ${JSON.stringify(nativeWorkspace)},
        agentOptions: route, signal: AbortSignal.timeout(60_000),
      })
      assert.ok(childModelCalls > 0, 'native child must reach the scripted model')
      assert.deepEqual(errors, [])
      process.stdout.write('DSH_NATIVE_SUBAGENT_WORKSPACE=' + JSON.stringify(receipt) + '\\n')
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\\n')
      process.exitCode = 1
    } finally {
      try { await handle?.dispose() } catch (error) {
        process.stderr.write(String(error?.stack ?? error) + '\\n')
        process.exitCode = 1
      }
      ctx.get('appExit')?.(process.exitCode ?? 0)
    }
  })()
}
`)
  writeFileSync(nativeOverlayPath, `
- insert:
    - id: native-subagent-workspace-smoke
      name: ${JSON.stringify(nativeDriverPath)}
`)
  const nativeWorkspaceBoot = runDsh(['--profile', profile, '--patch', nativeOverlayPath])
  const nativeWorkspaceMarker = 'DSH_NATIVE_SUBAGENT_WORKSPACE='
  const nativeWorkspaceLine = nativeWorkspaceBoot.stdout.split('\n')
    .find(line => line.startsWith(nativeWorkspaceMarker))
  assert.ok(nativeWorkspaceLine, `missing native workspace receipt:\n${nativeWorkspaceBoot.stdout}\n${nativeWorkspaceBoot.stderr}`)
  const nativeWorkspaceReceipt = JSON.parse(nativeWorkspaceLine.slice(nativeWorkspaceMarker.length))
  assert.equal(nativeWorkspaceReceipt.schema_version, 'dsh-runtime-kit.native-subagent-workspace.v1')
  assert.equal(nativeWorkspaceReceipt.distinct_workspace, true)
  assert.equal(nativeWorkspaceReceipt.lease_ready_before_first_prompt, true)
  assert.equal(nativeWorkspaceReceipt.child_completed, true)
  assert.equal(nativeWorkspaceReceipt.child_closed, true)
  assert.deepEqual(nativeWorkspaceReceipt.order, ['workspace-issued', 'lease-ready', 'first-prompt', 'child-idle', 'child-closed'])

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
      {
        id: 'edit',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'finish-line:edit-generation-recorded',
          'artifact:session-owned-roundtrip-exported-disposed',
        ],
      },
      { id: 'validate', status: 'passed', producer: 'packed-runtime', evidence: ['finish-line:exact-validation-executed'] },
      { id: 'review', status: 'passed', producer: 'packed-runtime', evidence: ['reviewer:mutation-denied-before-body'] },
      ...(dataPolicyCandidateEnabled
        ? [{
            id: 'data-policy',
            status: 'passed',
            producer: 'packed-runtime',
            evidence: [
              'data-policy:native-pre-call-denied-before-body',
              'data-policy:mcp-web-shell-code-final-result-contained',
              'data-policy:content-free-audit-rule-bound',
              'protected-root:direct-relative-symlink-shell-denied',
            ],
          }]
        : []),
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
      {
        id: 'resume',
        status: 'passed',
        producer: 'packed-runtime',
        evidence: [
          'finish-line:session-resumed',
          'artifact:reference-revalidated-after-restart',
        ],
      },
      {
        id: 'subagent',
        status: 'passed',
        producer: 'packed-runtime',
        workspace: nativeWorkspaceReceipt,
        evidence: [
          'reviewer:native-subagent-completed',
          'subagent:host-issued-distinct-workspace',
          'subagent:lease-ready-before-first-prompt',
        ],
      },
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
        'artifact:cross-session-reference-denied',
        'artifact:unsafe-export-denied-before-write',
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
    codeModeNestedPrerequisiteVerified: true,
    reviewerMutationBlockedBeforeBody: true,
    externalProviderMutationAttempted: false,
    nilsCompatibilityStatus: nilsCompatibility.status,
    nilsCompatibilityCandidateFeature: nilsCandidateFeature,
    skillCount: skillReceipt.count,
    skillPrecedenceVerified: true,
    }) + '\n')
  }
} finally {
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
