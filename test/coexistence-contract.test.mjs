import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('issue 62 rollback is pinned to the exact accepted issue 61 baseline', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.17')
  assert.equal(manifest.validated_release, '1.27.34')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.34',
    source_commit: '5e8564357f6deb524e36d1a0cbdcf124f034c3f2',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.34-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'a9c4a88038d66d538605fd1ded630fca342e1025372f24896254f4e34e5916a8',
    },
    artifacts: {
      'agent-hook': { sha256: 'b97eb058b756168249d8adc6b35b7e57333196c05e1380eecd9a43e3b423dd3a' },
      'agent-docs': { sha256: '83080958f26bffd11a5b60081267367d95f9a25b0823f80d56f4f319595890b3' },
      'agent-session': { sha256: '316d86e4e9faa6e240b12823091a4e8e6fa161fb79791501d6c2b8729d01cae6' },
      'forge-cli': { sha256: '27215e78ac042cf1334c68776e1d49a93b2d62332c0abeb14b262608540cfd0e' },
      'git-cli': { sha256: '331d0dc8e1f58e082fd9d6984987fdb6d38fe37c3f31824867abcc56ca2b5962' },
      'review-specialists': { sha256: 'f5add3b378ffe053bb8a742f7c37186d357d550cef83aa303fbb8633dab36e85' },
      'semantic-commit': { sha256: '9d3f1bf99cbe18414e5692ee00d4f4e17f5b737acfdbec604672c73500f38d85' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.34-aarch64-apple-darwin.tar.gz',
          sha256: '9abc71134df9bdb04ff0a8d718fe91ad2e034c6f74b47c5af8d23a94735964e2',
        },
        artifacts: {
          'agent-hook': { sha256: '60ae88def2459e35e1c672f40650d44f433146571674b909caead7bad710d65c' },
          'agent-docs': { sha256: 'c6128a9d16610c536882116b2256aa1fc3786749c4a8f89f602f2a65912c7870' },
          'agent-session': { sha256: '47595ae1c84cfae19305085721c93adfc55a8bd792a20b08287bf3dbfa88369f' },
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
  assert.ok(
    manifest.commands
      .find(command => command.id === 'agent-session.work-context-set-if-absent')
      ?.source_tasks.includes('sympoies/nils-cli#1591'),
  )
  assert.equal(manifest.candidate_validation?.feature, 'typed-data-policy-protected-roots')
  assert.equal(manifest.candidate_validation?.status, 'reviewed-source-candidate')
  assert.equal(manifest.candidate_validation?.validation, 'exact-reviewed-source')
  assert.equal(
    manifest.candidate_validation?.source_commit,
    '81be602378e3790e042aae5000befd78c1d584bc',
  )
  // #66 and Gate 0 select the serial predecessor. This assertion freezes that
  // reviewed selection for #62; it does not discover a future child baseline.
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: 'd49cdea6d1681ac752e2bf81ad10e10c056693d19b752e243359e92e139d1411',
    version: '1.27.29',
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
      source_tasks: [
        'serenvia/sympoies-infra#213',
        'sympoies/nils-cli#1591',
      ],
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
