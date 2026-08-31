import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('issue 60 rollback is pinned to the exact accepted issue 59 baseline', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.17')
  assert.equal(manifest.validated_release, '1.27.29')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.29',
    source_commit: 'e6f50a34d68e7a6638eb104e423dcacd116c4071',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.29-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '4a169d28032ace8e6d696c9385e3096dbea6e5e1ea17c492b9b0f4094f8b5f21',
    },
    artifacts: {
      'agent-hook': { sha256: '75ac5435d3afb6dc129cf6179f71d3289004ef335942674a9bbce58cd0ad8cd0' },
      'agent-docs': { sha256: '095f0a33e73727be984e8601871034353e70bea7229e95f304b6e37195e96c71' },
      'agent-session': { sha256: 'ad519863bd0bd3c2d3120ddb41f6f932ab10d98fa8ebeae8fa9fe265858e0059' },
      'forge-cli': { sha256: '10101f48242733028afa2a77183f22a7173c1f95af3fa2fc1893b10aa4b87ca7' },
      'git-cli': { sha256: '899ec620a08b09d5a7be628fbc504a70063e05ddefc71071ae2c19725e7bda4e' },
      'review-specialists': { sha256: '70b68cb2b5de2ba29a5c8c2e4661808a40ed7ac00ee8546f19d3f351b262e1bc' },
      'semantic-commit': { sha256: 'c628a41e09f8354f13dd5c2678e2a52382cb1c4940c69fa14a604e91dc72fa6e' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.29-aarch64-apple-darwin.tar.gz',
          sha256: '5d65f5f7982910d7aa69466e054b9a05cf4453d6ce7aa26df47ad1643bdff5cf',
        },
        artifacts: {
          'agent-hook': { sha256: '6cf18e4e86563704284835d4c04437f7d74aadf8caa2ce0f2b0f81d1a84d2195' },
          'agent-docs': { sha256: '1ea127194cee10b382ac016da15ac6a9dcc5d08b1a8c57819adadb288af7e230' },
          'agent-session': { sha256: '4ec55b05809068e9b067eadb54bfcb478afca711a6ad4d5394aa2ce25713938b' },
        },
      },
    },
  })
  assert.ok(manifest.commands.every(command => command.status === 'released'))
  assert.ok(manifest.commands.some(command => command.id === 'agent-hook.workspace-recovery.dsh'))
  assert.ok(
    manifest.commands
      .find(command => command.id === 'agent-hook.dispatch.dsh')
      ?.source_tasks.includes('sympoies/nils-cli#1541'),
  )
  assert.equal(manifest.candidate_validation?.feature, 'typed-data-policy-protected-roots')
  assert.equal(manifest.candidate_validation?.status, 'reviewed-source-candidate')
  assert.equal(manifest.candidate_validation?.validation, 'exact-reviewed-source')
  assert.equal(
    manifest.candidate_validation?.source_commit,
    '81be602378e3790e042aae5000befd78c1d584bc',
  )
  // #66 and Gate 0 select the serial predecessor. This assertion freezes that
  // reviewed selection for #60; it does not discover a future child baseline.
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '0720c53a156459a1b888689a98815dcd5493ad6736b627507b7cdef6f3edd1b3',
    version: '1.27.27',
    source_revision: 'v1.27.27',
    source_commit: '1e93e23cdf89cc82eac0e81d796fa13136d3782f',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.27-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '8c9fc05c37a575e639265ad11608312723d81f8cbaca19452824d995deeee2df',
    },
    artifacts: {
      'agent-hook': { sha256: '791ee0bc5cfae83d639a6ebc4eccc13049b47b2967f5d3cfb93706faf40b3381' },
      'agent-docs': { sha256: '8e3beb884efd3c2ca1bbc91f023db2dc246a56b5325b7f73394319f46c10a169' },
      'forge-cli': { sha256: '3940bc6c8be3983b8221d5287aba2e8affe41a539c5586ea00e1cb3ac5949528' },
      'git-cli': { sha256: '5a0ae9be1e7e2f0c7d383ace6fc08c7834d39112657ce4c9949e745f1365b569' },
      'review-specialists': { sha256: '6991a6926de1c9e3453321ce4725461464b14977a5add5c21ab5adf466e92992' },
      'semantic-commit': { sha256: '7c24dddc5fdab8a042a999f7794d913d87acfbd204e11c2feb9aeeace1859e88' },
    },
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
