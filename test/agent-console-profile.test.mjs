import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import * as runtimeKit from '../index.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const CONTROLLER_TOOLS = [
  'runtime_kit_plus_one',
  'runtime_context',
  'workspace_recovery',
  'workspace_recovery_handoff',
  'review_specialists',
  'main_agent_run_initialize',
  'main_agent_worker_launch',
  'main_agent_worker_interrupt',
  'main_agent_lane_close',
  'main_agent_worker_supervise',
  'main_agent_worker_request_changes',
  'main_agent_worker_accept',
  'main_agent_run_closeout',
]

const LANE_DENIED_TOOLS = [
  'main_agent_run_initialize',
  'main_agent_worker_launch',
  'main_agent_worker_interrupt',
  'main_agent_lane_close',
  'main_agent_worker_supervise',
  'main_agent_worker_request_changes',
  'main_agent_worker_accept',
  'main_agent_run_closeout',
]

const EXPECTED_CONTRACT = Object.freeze({
  schema_version: 'dsh-runtime-kit.agent-console-profile.v2',
  profile: 'dsh-tui',
  dsh: {
    version: '0.1.1-rc.2',
    revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
  },
  tui: {
    package: '@deepseek-harness-tui/dsh-tui',
    version: '0.10.0-beta.2',
    specifier: '@deepseek-harness-tui/dsh-tui@0.10.0-beta.2',
    source: {
      repository: 'https://github.com/ccch1mneyyy/dsh-TUI',
      tag: 'v0.10.0-beta.2',
      tag_ref_type: 'commit',
      revision: '655c0f16088879890d9c6ce5d160651433223e09',
    },
    artifact: {
      tarball: 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.10.0-beta.2.tgz',
      integrity: 'sha512-qWuTmsjNJp4rUxLePZdKXMp9mHs2wLEtMnED+ayd+fgmppYvf9AU2btNW7Nb4oHN6lvcsx+PqK795nFJ3Sgsyg==',
      shasum: 'dd5d0cc8233bd9266c3d2ff97d30ad34bc37455e',
    },
  },
  bundles: [
    '@deepseek-ai/dsh-base',
    '@deepseek-harness-tui/dsh-tui',
    '@sympoies/dsh-runtime-kit',
  ],
  required_rows: ['user-questions', 'dsh-tui', 'dsh-runtime-kit'],
  tool_surfaces: {
    controller: {
      required: CONTROLLER_TOOLS,
      forbidden: ['main_agent_checkpoint'],
    },
    lane: {
      required: ['main_agent_bootstrap', 'main_agent_checkpoint'],
      forbidden: LANE_DENIED_TOOLS,
    },
  },
  required_skills: ['main-agent-mode', 'code-review-specialists'],
  required_services: ['userQuestions', 'mainAgentOrchestration'],
  default_route: {
    provider: 'codex-proxy',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'high',
  },
  authority: {
    runtime_kit_patch_rows: ['dsh-runtime-kit'],
    permission_mode_source: 'DSH_PERMISSION_MODE',
    sandbox_approval_pairs: [
      { sandbox_mode: 'workspace-write', approval_policy: 'ask' },
      { sandbox_mode: 'danger-full-access', approval_policy: 'never' },
    ],
    provider_credentials: [{
      provider: 'codex-proxy',
      api_key_env: 'DSH_CODEX_PROXY_TOKEN',
    }],
  },
})

const VALID_OBSERVATION = Object.freeze({
  profile: 'dsh-tui',
  dsh: EXPECTED_CONTRACT.dsh,
  tui: {
    package: EXPECTED_CONTRACT.tui.package,
    version: EXPECTED_CONTRACT.tui.version,
  },
  bundles: EXPECTED_CONTRACT.bundles,
  composition: {
    rowIds: EXPECTED_CONTRACT.required_rows,
    controllerTools: CONTROLLER_TOOLS,
    laneTools: ['main_agent_bootstrap', 'main_agent_checkpoint'],
    skills: EXPECTED_CONTRACT.required_skills,
    services: EXPECTED_CONTRACT.required_services,
  },
  controllerRoute: {
    provider: 'codex-proxy',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  workerRoute: {
    provider: 'codex-proxy',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  authority: {
    runtimeKitPatchRowIds: ['dsh-runtime-kit'],
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    permissionModeSource: 'DSH_PERMISSION_MODE',
    providerCredentials: [{
      provider: 'codex-proxy',
      apiKeyEnv: 'DSH_CODEX_PROXY_TOKEN',
      inlineValuePresent: false,
    }],
  },
})

function copyObservation() {
  return structuredClone(VALID_OBSERVATION)
}

function removeValue(values, target) {
  values.splice(values.indexOf(target), 1)
}

function expectCode(observation, code) {
  assert.throws(
    () => runtimeKit.inspectAgentConsoleRc7Profile(observation),
    error => error?.code === code,
  )
}

test('the package pins the complete latest Agent Console composition contract', () => {
  assert.equal(typeof runtimeKit.inspectAgentConsoleRc7Profile, 'function')
  assert.deepEqual(runtimeKit.agentConsoleRc7ProfileContract(), EXPECTED_CONTRACT)

  const result = runtimeKit.inspectAgentConsoleRc7Profile(copyObservation())
  assert.deepEqual(result, {
    schema_version: 'dsh-runtime-kit.agent-console-profile-inspection.v2',
    compatible: true,
    profile: 'dsh-tui',
    dsh_version: '0.1.1-rc.2',
    tui_version: '0.10.0-beta.2',
    controller_route: {
      provider: 'codex-proxy',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
    worker_route: {
      provider: 'codex-proxy',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
    authority: {
      runtime_kit_patch_rows: ['dsh-runtime-kit'],
      sandbox_mode: 'workspace-write',
      approval_policy: 'ask',
      credentials: 'environment-reference-only',
    },
  })
})

test('the Agent Console release and installed-package patch select the same TUI', () => {
  const patchManifest = JSON.parse(readFileSync(
    join(projectRoot, 'compatibility', 'dsh-tui-patches.json'),
    'utf8',
  ))
  assert.equal(patchManifest.package_name, EXPECTED_CONTRACT.tui.package)
  assert.deepEqual(
    Object.keys(patchManifest.patches[0].validated_releases),
    [EXPECTED_CONTRACT.tui.version],
  )
})

test('the Agent Console install contract preserves DSH profile settings and disables unneeded TUI builds', () => {
  const workspace = parseYaml(readFileSync(join(
    projectRoot,
    'compatibility',
    'agent-console-pnpm-workspace.yaml',
  ), 'utf8'))
  assert.deepEqual(workspace, {
    packages: ['.'],
    nodeLinker: 'hoisted',
    autoInstallPeers: false,
    allowBuilds: {
      '@google/genai': false,
      esbuild: false,
      koffi: false,
      protobufjs: false,
    },
  })
})

test('public Agent Console smoke consumes the contract-pinned TUI specifier', () => {
  const workflow = parseYaml(readFileSync(join(
    projectRoot,
    '.github',
    'workflows',
    'compatibility.yml',
  ), 'utf8'))
  const step = workflow.jobs.upstream.steps.find(
    candidate => candidate.name === 'Run exact Agent Console TUI composition smoke',
  )
  assert.equal(
    step?.env?.DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_PACKAGE,
    EXPECTED_CONTRACT.tui.specifier,
  )
})

test('public Agent Console smoke authenticates the contract tarball before local install', () => {
  const source = readFileSync(join(projectRoot, 'test', 'smoke.mjs'), 'utf8')
  const fetched = source.indexOf('fetchAuthenticatedAgentConsoleArtifact(')
  const written = source.indexOf('writeFileSync(agentConsoleTuiArchive')
  const installed = source.indexOf("runDsh(['plugin', '--profile', profile, 'add', agentConsoleTuiArchive])")
  const patched = source.indexOf("action: 'apply',", installed)
  const startup = source.indexOf('runAgentConsoleTuiStartupSmoke()', patched)

  assert.ok(fetched >= 0, 'the smoke must fetch through the authenticated artifact owner')
  assert.ok(written > fetched, 'the smoke may write the archive only after authentication')
  assert.ok(installed > written, 'the smoke must install the verified local archive')
  assert.ok(patched > installed, 'the smoke must patch only the installed authenticated release')
  assert.ok(startup > patched, 'the smoke must exercise the patched TUI runtime')
  assert.equal(
    source.includes("runDsh(['plugin', '--profile', profile, 'add', agentConsoleTuiPackage])"),
    false,
    'the smoke must not install the unauthenticated registry specifier',
  )
})

test('unknown and headless profiles cannot masquerade as Agent Console', () => {
  for (const profile of ['work', 'headless']) {
    const observation = copyObservation()
    observation.profile = profile
    expectCode(observation, 'DSH_RUNTIME_KIT_UNSUPPORTED_AGENT_CONSOLE_PROFILE')
  }
})

test('every pinned version and ordered bundle has a specific failing owner', () => {
  const mutations = [
    ['DSH version', value => { value.dsh.version = '0.1.0-rc.8' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_DSH_MISMATCH'],
    ['DSH revision', value => { value.dsh.revision = '0'.repeat(40) }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_DSH_MISMATCH'],
    ['TUI package', value => { value.tui.package = '@deepseek-harness-tui/other' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_MISMATCH'],
    ['TUI version', value => { value.tui.version = '0.8.1' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_MISMATCH'],
    ...EXPECTED_CONTRACT.bundles.map(bundle => [
      `bundle ${bundle}`,
      value => { removeValue(value.bundles, bundle) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_BUNDLE_MISMATCH',
    ]),
    ['bundle order', value => { value.bundles.reverse() }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_BUNDLE_MISMATCH'],
  ]
  for (const [name, mutate, code] of mutations) {
    const observation = copyObservation()
    mutate(observation)
    assert.doesNotThrow(() => expectCode(observation, code), name)
  }
})

test('every required row, scoped tool, skill, and service has a specific failing owner', () => {
  const mutations = [
    ...EXPECTED_CONTRACT.required_rows.map(row => [
      `row ${row}`,
      value => { removeValue(value.composition.rowIds, row) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROW_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.tool_surfaces.controller.required.map(tool => [
      `controller tool ${tool}`,
      value => { removeValue(value.composition.controllerTools, tool) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_CONTROLLER_TOOL_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.tool_surfaces.controller.forbidden.map(tool => [
      `controller forbidden tool ${tool}`,
      value => { value.composition.controllerTools.push(tool) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_CONTROLLER_TOOL_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.tool_surfaces.lane.required.map(tool => [
      `lane tool ${tool}`,
      value => { removeValue(value.composition.laneTools, tool) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_LANE_TOOL_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.tool_surfaces.lane.forbidden.map(tool => [
      `lane forbidden tool ${tool}`,
      value => { value.composition.laneTools.push(tool) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_LANE_TOOL_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.required_skills.map(skill => [
      `skill ${skill}`,
      value => { removeValue(value.composition.skills, skill) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_SKILL_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.required_services.map(service => [
      `service ${service}`,
      value => { removeValue(value.composition.services, service) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_SERVICE_MISMATCH',
    ]),
  ]
  for (const [name, mutate, code] of mutations) {
    const observation = copyObservation()
    mutate(observation)
    assert.doesNotThrow(() => expectCode(observation, code), name)
  }
})

test('Sol workers inherit the exact high-effort controller route and route evidence is closed', () => {
  const mutations = [
    value => { value.controllerRoute.provider = 'deepseek-official' },
    value => { value.controllerRoute.model = 'gpt-5.6-terra' },
    value => { value.controllerRoute.reasoningEffort = 'max' },
    value => { value.workerRoute.provider = 'deepseek-official' },
    value => { value.workerRoute.model = 'gpt-5.6-terra' },
    value => { value.workerRoute.reasoningEffort = 'max' },
  ]
  for (const mutate of mutations) {
    const observation = copyObservation()
    mutate(observation)
    expectCode(observation, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_MISMATCH')
  }

  for (const [route, key] of [
    ['controllerRoute', 'apiKey'],
    ['workerRoute', 'token'],
    ['controllerRoute', 'unrelatedExtension'],
  ]) {
    const observation = copyObservation()
    observation[route][key] = 'must-not-serialize'
    assert.throws(
      () => runtimeKit.inspectAgentConsoleRc7Profile(observation),
      error => error?.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_SHAPE_INVALID'
        && !JSON.stringify(error).includes('must-not-serialize'),
    )
  }

  for (const route of ['controllerRoute', 'workerRoute']) {
    const observation = copyObservation()
    delete observation[route].reasoningEffort
    expectCode(observation, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_SHAPE_INVALID')
  }
})

test('every runtime, permission, and credential authority field has a failing owner', () => {
  const mutations = [
    [value => { value.authority.runtimeKitPatchRowIds = [] }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_RUNTIME_AUTHORITY_MISMATCH'],
    [value => { value.authority.runtimeKitPatchRowIds.push('sandbox-policy') }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_RUNTIME_AUTHORITY_MISMATCH'],
    [value => { value.authority.permissionModeSource = 'default' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_PERMISSION_AUTHORITY_MISMATCH'],
    [value => { value.authority.sandboxMode = 'read-only' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_PERMISSION_AUTHORITY_MISMATCH'],
    [value => { value.authority.approvalPolicy = 'never' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_PERMISSION_AUTHORITY_MISMATCH'],
    [value => { value.authority.providerCredentials[0].provider = 'other' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH'],
    [value => { value.authority.providerCredentials[0].apiKeyEnv = 'OTHER_TOKEN' }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH'],
    [value => { value.authority.providerCredentials[0].inlineValuePresent = true }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH'],
    [value => { value.authority.providerCredentials.push(structuredClone(value.authority.providerCredentials[0])) }, 'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH'],
  ]
  for (const [mutate, code] of mutations) {
    const observation = copyObservation()
    mutate(observation)
    expectCode(observation, code)
  }

  const danger = copyObservation()
  danger.authority.sandboxMode = 'danger-full-access'
  danger.authority.approvalPolicy = 'never'
  assert.equal(runtimeKit.inspectAgentConsoleRc7Profile(danger).compatible, true)
})

test('sparse arrays cannot bypass bundle, runtime-row, or credential checks', () => {
  for (const [mutate, code] of [
    [
      value => { value.bundles = Array(EXPECTED_CONTRACT.bundles.length) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_BUNDLE_MISMATCH',
    ],
    [
      value => { value.authority.runtimeKitPatchRowIds = Array(1) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_RUNTIME_AUTHORITY_MISMATCH',
    ],
    [
      value => { value.authority.providerCredentials = Array(1) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH',
    ],
  ]) {
    const observation = copyObservation()
    mutate(observation)
    expectCode(observation, code)
  }
})
