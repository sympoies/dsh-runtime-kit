import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import * as runtimeKit from '../dist/index.js'

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
  schema_version: 'dsh-runtime-kit.agent-console-profile.v4',
  profile: 'dsh-tui',
  dsh: {
    version: '0.1.6-alpha.2',
    revision: 'ddefc45fbc7f8e46dd73185e68295696d1297887',
  },
  tui: {
    package: '@deepseek-harness-tui/dsh-tui',
    version: '0.10.2',
    specifier: '@deepseek-harness-tui/dsh-tui@0.10.2',
    source: {
      repository: 'https://github.com/ccch1mneyyy/dsh-TUI',
      tag: 'v0.10.2',
      tag_ref_type: 'annotated',
      revision: '9abb9101fbaead9dd37da28193618da5f07322c0',
    },
    artifact: {
      tarball: 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.10.2.tgz',
      integrity: 'sha512-jHAx/bYgvuMDnu7ivFPTdRll4c26dbAjE/eZht4fjbXvhBONHeF5nSC774ix3B5x6cl7hA5CU5CAuIhimSC2DA==',
      shasum: '85db2801a478ff6207ed68894127fedcd16499c1',
    },
  },
  bundles: [
    '@deepseek-ai/dsh-base',
    '@sympoies/dsh-tui-016-profile-compat',
    '@deepseek-harness-tui/dsh-tui',
    '@sympoies/dsh-runtime-kit',
  ],
  required_rows: ['user-questions', 'ptc-runtime', 'workflow-worker-thread', 'dsh-tui-code-runtime', 'dsh-tui', 'dsh-runtime-kit'],
  required_disabled_rows: ['workflow-worker-thread', 'dsh-tui-code-runtime'],
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
    disabledRowIds: EXPECTED_CONTRACT.required_disabled_rows,
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
    schema_version: 'dsh-runtime-kit.agent-console-profile-inspection.v4',
    compatible: true,
    profile: 'dsh-tui',
    dsh_version: '0.1.6-alpha.2',
    tui_version: '0.10.2',
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

test('the Agent Console profile composes the pristine TUI after its 0.1.6 compatibility bundle', () => {
  const patchManifest = JSON.parse(readFileSync(
    join(projectRoot, 'compatibility', 'dsh-tui-patches.json'),
    'utf8',
  ))
  assert.equal(patchManifest.package_name, EXPECTED_CONTRACT.tui.package)
  assert.equal(
    patchManifest.patches.some(entry => Object.hasOwn(entry.validated_releases, EXPECTED_CONTRACT.tui.version)),
    false,
  )
  const bundleRoot = join(projectRoot, 'compatibility', 'dsh-tui-016-profile-compat')
  const bundle = JSON.parse(readFileSync(join(bundleRoot, 'package.json'), 'utf8'))
  assert.equal(bundle.name, EXPECTED_CONTRACT.bundles[1])
  assert.deepEqual(bundle.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.deepEqual(parseYaml(readFileSync(join(bundleRoot, 'cordis.patch.yml'), 'utf8')), [{
    insert: [{
      id: 'workflow-worker-thread',
      name: '@deepseek-ai/dsh-tool-workflow',
      disabled: true,
    }],
  }])
})

test('the Agent Console smoke adapter advertises its configured reasoning effort', () => {
  const smokeSource = readFileSync(join(projectRoot, 'test', 'smoke.ts'), 'utf8')
  assert.match(smokeSource, /reasoning:\s*\{\s*efforts:\s*\[\{ id: 'high', name: 'high' \}\]\s*\}/)
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

test('the headless candidate workflow does not mutate the frozen Agent Console lane', () => {
  const workflow = parseYaml(readFileSync(join(
    projectRoot,
    '.github',
    'workflows',
    'compatibility.yml',
  ), 'utf8'))
  const step = workflow.jobs.upstream.steps.find(
    candidate => candidate.name === 'Run exact Agent Console TUI composition smoke',
  )
  assert.equal(step, undefined)
})

test('public Agent Console smoke authenticates the contract tarball before local install', () => {
  const source = readFileSync(join(projectRoot, 'test', 'smoke.ts'), 'utf8')
  const fetched = source.indexOf('fetchAuthenticatedAgentConsoleArtifact(')
  const written = source.indexOf('writeFileSync(agentConsoleTuiArchive')
  const installed = source.indexOf("    runDsh([\n      'plugin', '--profile', profile, 'add',")
  const inspected = source.indexOf('const installedProfileManifest = JSON.parse(', installed)
  const pristine = source.indexOf('const pristineInspection = inspectDshTuiPristine({', inspected)
  const startup = source.indexOf('runAgentConsoleTuiStartupSmoke()', pristine)

  assert.ok(fetched >= 0, 'the smoke must fetch through the authenticated artifact owner')
  assert.ok(written > fetched, 'the smoke may write the archive only after authentication')
  assert.ok(
    installed > written,
    'the smoke must install the verified TUI archive and runtime-kit in one profile transaction',
  )
  assert.ok(
    inspected > installed && inspected < pristine,
    'the smoke must inspect the installed profile tuple before authenticating the installed package',
  )
  assert.ok(pristine > installed, 'the smoke must authenticate the pristine installed release')
  assert.ok(startup > pristine, 'the smoke must exercise the pristine TUI runtime')
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
    ...EXPECTED_CONTRACT.required_disabled_rows.map(row => [
      `enabled legacy row ${row}`,
      value => { removeValue(value.composition.disabledRowIds, row) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_DISABLED_ROW_MISMATCH',
    ]),
    ...EXPECTED_CONTRACT.required_rows
      .filter(row => !EXPECTED_CONTRACT.required_disabled_rows.includes(row))
      .map(row => [
      `disabled required row ${row}`,
      value => { value.composition.disabledRowIds.push(row) },
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_DISABLED_ROW_MISMATCH',
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
