import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('the published nils release is pinned by exact source, archive, and binary evidence', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.14')
  assert.equal(manifest.validated_release, '1.27.14')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.14',
    source_commit: 'f3c372a2424096f81de05b4f6b96c179023174f7',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.14-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '349941aa80aa224294f02d531d8865b2a810249b35f37e2963a84d31b75004d4',
    },
    artifacts: {
      'agent-hook': { sha256: '0dd0fc857035498bdbf40c9a826050738203df8634b9088da544945534a672ea' },
      'agent-docs': { sha256: '1c5c36e45694c3180e5a2a0a4c6ddf4bd3c78327b169918e796446e5481770a1' },
      'forge-cli': { sha256: 'ae32e2f1bb0297f4583ddc26ad162c6c0cb8b3b741e57222bf0c65a6611cc9a2' },
      'git-cli': { sha256: 'abc1423f1c45465d2a2a67324c1cfbbad0ef729ce028e0b16582ff331f9cfcc2' },
      'review-specialists': { sha256: '508dc3d88bf94b64404e811b1376275ad5d660dad2ae484eb0fb4acdcd81c435' },
      'semantic-commit': { sha256: '7dabad72e07fd3cd23d5738fc3f01ae5cc1f0787928dc9493458d9775d70ed4a' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.14-aarch64-apple-darwin.tar.gz',
          sha256: '157f38e6b4b655867ea17ef503df0ce138366ff26afce0274435a4b975efaa65',
        },
        artifacts: {
          'agent-hook': { sha256: '3d2202efe45241fff2d3306b647a8b550b78f85ef8933012ddcae458062aefcc' },
          'agent-docs': { sha256: '6486a83da0bc8a1286d175f7be8a2514d041fb12ddd08f552ccb34b9d6a5f19b' },
        },
      },
    },
  })
  assert.ok(manifest.commands.every(command => command.status === 'released'))
  assert.deepEqual(manifest.candidate_validation, {
    feature: 'authoritative-finish-line-acceptance',
    status: 'reviewed-source-candidate',
    pull_request: 'https://github.com/sympoies/nils-cli/pull/1507',
    source_commit: '41329f0fe73e9704c74b0fbcf2ee7e1a098893ee',
    source_parent: '5be20fe1b5f99852fef0657dc00a0d26fc4d6e31',
    source_tree: 'b5443934d9b0f5704181b5f52571312d1ccc51c1',
    merge_base: '5f74d50bc4cf4acc8b0e365e667ddf933b5d9cbd',
    version: '1.27.10',
    platform: 'x86_64-unknown-linux-gnu',
    artifacts: {
      'agent-hook': {
        sha256: 'b4138843dce69587ebbc5a5a6dfdd51e92d503e397f60c905c76bd86db168417',
      },
      'agent-docs': {
        sha256: '1cca26d9b99cb4dc5301e1f75897561030ca18d6b7e949d6e0d34a9981548b27',
      },
      'review-specialists': {
        sha256: '874ecfb5f9389ce10bd73c0d0307c7e0660dc0eef9b893cbe6f714384b46d92e',
      },
    },
    validation: 'exact-reviewed-source',
    contracts: [
      'agent-hook.finish-line.register.v1',
      'cli.agent-hook.finish-line-register.v1',
      'agent-hook.finish-line.register-result.v1',
      'agent-hook.finish-line.admit.v1',
      'cli.agent-hook.finish-line-admit.v1',
      'agent-hook.finish-line.admit-result.v1',
      'agent-hook.finish-line.observe.v1',
      'cli.agent-hook.finish-line-observe.v1',
      'agent-hook.finish-line.observe-result.v1',
      'agent-hook.finish-line.verdict.v1',
      'cli.agent-hook.finish-line-verdict.v1',
      'agent-hook.finish-line.verdict-result.v1',
    ],
  })
  assert.equal(
    manifest.commands.find(command => command.id === 'main-agent.lane-orchestration')?.validation,
    'release-bundle-validated',
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-session.work-context-set-if-absent'),
    {
      id: 'agent-session.work-context-set-if-absent',
      binary: 'agent-session',
      status: 'released',
      validation: 'release-bundle-validated',
      contracts: [
        'agent-session work-context set --if-absent',
        'cli.agent-session.work-context-set.v1',
        'agent-session.work-context-set-result.v1',
      ],
      source_task: 'serenvia/sympoies-infra#213',
    },
  )
})

test('retained migration docs define isolated coexistence instead of repository retirement', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const source = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md')
  const plan = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md')
  const state = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-execution-state.md')
  const readme = read('README.md')

  for (const document of [source, plan, state, readme]) {
    assert.match(document, /Codex[\s\S]{0,120}Claude Code[\s\S]{0,180}agent-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /DSH[\s\S]{0,180}dsh-runtime-kit[\s\S]{0,80}nils-cli/i)
  }
  assert.match(plan, /Task 6\.2: Activate the local DSH profile reversibly/)
  assert.match(plan, /Task 6\.3: Prove coexistence isolation and close dispatch/)
  assert.match(state, /agent-runtime-kit remains active for Codex and Claude\s+Code/i)
  assert.doesNotMatch(source, /old repository is then archived\/read-only/i)
  assert.doesNotMatch(plan, /Retire active agent-runtime-kit usage/i)
  assert.doesNotMatch(state, /Retire active old runtime/i)
  assert.doesNotMatch(readme, /will replace `agent-runtime-kit`/i)
})

test('the package owns a DSH-only docs catalog and explicit isolated activation contract', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const manifest = JSON.parse(read('package.json'))
  const catalog = read('agent-docs/AGENT_DOCS.toml')
  const context = read('agent-docs/PROJECT_DEV_EDIT.md')
  const patch = read('cordis.patch.yml')
  const operations = read('docs/operations.md')
  const plan = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md')

  assert.ok(manifest.files.includes('agent-docs'))
  assert.match(catalog, /context = "project-dev"/)
  assert.match(catalog, /product = "dsh"/)
  assert.match(catalog, /phase = "edit"/)
  assert.doesNotMatch(`${catalog}\n${context}`, /agent-runtime-kit/u)
  for (const variable of [
    'DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG',
    'DSH_RUNTIME_KIT_AGENT_HOOK_POLICY',
    'DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR',
    'DSH_RUNTIME_KIT_AGENT_DOCS_HOME',
    'DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME',
  ]) {
    assert.match(patch, new RegExp(variable))
    assert.match(operations, new RegExp(variable))
  }
  assert.match(
    patch,
    /mainAgentCli: !!js process\.env\.DSH_RUNTIME_KIT_MAIN_AGENT_BIN \?\? 'main-agent'/,
  )
  assert.match(
    patch,
    /agentSessionCli: !!js process\.env\.DSH_RUNTIME_KIT_AGENT_SESSION_BIN \?\? 'agent-session'/,
  )
  assert.match(operations, /native `headless` profile/i)
  assert.match(operations, /link count[\s\S]{0,120}one/i)
  assert.match(operations, /Codex[\s\S]{0,120}Claude[\s\S]{0,180}(?:unchanged|untouched)/i)
  assert.match(plan, /native `headless` profile/i)
})
