import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as runtimeKit from '../index.js'

const VALID_OBSERVATION = Object.freeze({
  profile: 'dsh-tui',
  dsh: {
    version: '0.1.0-rc.7',
    revision: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  },
  tui: {
    package: '@deepseek-harness-tui/dsh-tui',
    version: '0.8.1',
  },
  bundles: [
    '@deepseek-ai/dsh-base',
    '@deepseek-harness-tui/dsh-tui',
    '@sympoies/dsh-runtime-kit',
  ],
  composition: {
    rowIds: [
      'user-questions',
      'dsh-tui',
      'dsh-runtime-kit',
    ],
    tools: [
      'runtime_kit_plus_one',
      'runtime_context',
      'review_specialists',
      'main_agent_worker_launch',
      'main_agent_worker_interrupt',
      'main_agent_lane_close',
      'main_agent_worker_supervise',
      'main_agent_worker_request_changes',
      'main_agent_worker_accept',
      'main_agent_run_closeout',
      'main_agent_checkpoint',
    ],
    skills: ['main-agent-mode', 'code-review-specialists'],
    services: ['userQuestions', 'mainAgentOrchestration'],
  },
  controllerRoute: { provider: 'codex-proxy', model: 'gpt-5.6-sol' },
  workerRoute: { provider: 'codex-proxy', model: 'gpt-5.6-sol' },
  authority: {
    runtimeKitPatchRowIds: ['dsh-runtime-kit'],
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
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

test('the package publishes an exact Agent Console rc.7 composition contract', async () => {
  assert.equal(
    typeof runtimeKit.inspectAgentConsoleRc7Profile,
    'function',
    'the non-headless Agent Console profile has no authenticated composition boundary',
  )
  const contract = JSON.parse(await readFile(
    new URL('../compatibility/agent-console.json', import.meta.url),
    'utf8',
  ))
  assert.equal(contract.schema_version, 'dsh-runtime-kit.agent-console-profile.v1')
  assert.deepEqual(contract.bundles, VALID_OBSERVATION.bundles)
  assert.deepEqual(contract.default_route, VALID_OBSERVATION.controllerRoute)

  const result = runtimeKit.inspectAgentConsoleRc7Profile(copyObservation())
  assert.equal(result.compatible, true)
  assert.equal(result.profile, 'dsh-tui')
  assert.deepEqual(result.controller_route, VALID_OBSERVATION.controllerRoute)
  assert.deepEqual(result.worker_route, VALID_OBSERVATION.workerRoute)
})

test('unknown and headless profiles cannot masquerade as the Agent Console composition', () => {
  for (const profile of ['work', 'headless']) {
    const observation = copyObservation()
    observation.profile = profile
    assert.throws(
      () => runtimeKit.inspectAgentConsoleRc7Profile(observation),
      error => error?.code === 'DSH_RUNTIME_KIT_UNSUPPORTED_AGENT_CONSOLE_PROFILE',
    )
  }
})

test('the Agent Console contract refuses incomplete or reordered runtime surfaces', () => {
  const mutations = [
    observation => { observation.bundles.reverse() },
    observation => { observation.composition.rowIds.splice(0, 1) },
    observation => { observation.composition.tools.splice(0, 1) },
    observation => { observation.composition.skills.splice(0, 1) },
    observation => { observation.composition.services.splice(0, 1) },
  ]
  for (const mutate of mutations) {
    const observation = copyObservation()
    mutate(observation)
    assert.throws(
      () => runtimeKit.inspectAgentConsoleRc7Profile(observation),
      error => error?.code === 'DSH_RUNTIME_KIT_INVALID_AGENT_CONSOLE_COMPOSITION',
    )
  }
})

test('Sol workers must inherit the controller route without an implicit override', () => {
  for (const [field, value] of [['provider', 'deepseek-official'], ['model', 'gpt-5.6-terra']]) {
    const observation = copyObservation()
    observation.workerRoute[field] = value
    assert.throws(
      () => runtimeKit.inspectAgentConsoleRc7Profile(observation),
      error => error?.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_MISMATCH',
    )
  }
})

test('runtime-kit cannot weaken sandbox, approval, or credential-reference authority', () => {
  const protectedRow = copyObservation()
  protectedRow.authority.runtimeKitPatchRowIds.push('sandbox-policy')
  assert.throws(
    () => runtimeKit.inspectAgentConsoleRc7Profile(protectedRow),
    error => error?.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_AUTHORITY_MISMATCH',
  )

  const implicitPermission = copyObservation()
  implicitPermission.authority.permissionModeSource = 'default'
  assert.throws(
    () => runtimeKit.inspectAgentConsoleRc7Profile(implicitPermission),
    error => error?.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_AUTHORITY_MISMATCH',
  )

  const rawCredential = copyObservation()
  rawCredential.authority.providerCredentials[0].inlineValuePresent = true
  assert.throws(
    () => runtimeKit.inspectAgentConsoleRc7Profile(rawCredential),
    error => error?.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_AUTHORITY_MISMATCH',
  )
})
