import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('the published nils release is pinned by exact source, archive, and binary evidence', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.17')
  assert.equal(manifest.validated_release, '1.27.19')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.19',
    source_commit: '07969611cbf99ae6d07c20730e4e46e370bb25f3',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.19-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'a66a2ef122a85b6bb536cd736363cfc88e9c3e2a8f6563a5d13f14810adafeb0',
    },
    artifacts: {
      'agent-hook': { sha256: '2444bd4aa5184d6d4bdb539a4dba40c3cc8bebbc6428dce6de387b5b02eb565a' },
      'agent-docs': { sha256: '8eb517fd2cc17668c5c75c9cb800af7f00e9d8341f14dcfef2ec442ae1551092' },
      'forge-cli': { sha256: '4ca84053a6b3ce2a712c5121c9de1d3c45397aa0b02aaf9599b97ce3d930fa73' },
      'git-cli': { sha256: 'dc0a30b5a7e026083d4b99fbc9ccbd6bd8836034127dd64ca390ac71dd0968e4' },
      'review-specialists': { sha256: '225fd7097d436f49744cf7f0f253138fe9781018f34d7914d14f2ec9c48e27e4' },
      'semantic-commit': { sha256: '584272f1d34056f851123706a4677eb27713a9256b0e9116c2f65b6179332632' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.19-aarch64-apple-darwin.tar.gz',
          sha256: '2a78403f0cae739e6b3e9bb550779616170a69514639dfd8ed2e44ab9a7fc63a',
        },
        artifacts: {
          'agent-hook': { sha256: '3f44e385f93622aac92ceb4ce4e12f8042c785ab31c390752aeca68faad08e1e' },
          'agent-docs': { sha256: '442f030554b4bf2bab90d8d58fcf0a2cff93dabb68face41e3213e7b7e100208' },
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
  assert.equal(manifest.candidate_validation, undefined)
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '1cdb239378d5113bcf0634392d63bcefd4bb11be33bb04bd30049b299f858f7a',
    version: '1.27.9',
    source_revision: 'v1.27.9',
    source_commit: '9458a5e274e4a683eac4d285135061c2fc35aeae',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.9-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '1fb0a8acfe5c6a1d2239d3428c6cd356b25e60e7ec737c2faaa6d14779b1824b',
    },
    artifacts: {
      'agent-hook': { sha256: '1eaee0c0d6dd55822f20cfc6314afa866d8381b17c16711e55fa1052222c80f0' },
      'agent-docs': { sha256: 'b30cbdd920c2c8e564ea25ad46a755d5545adb1d604c8e9df011604c97c74288' },
      'forge-cli': { sha256: 'cf1505392fe68939e0d7944163e99fbaa64ebf0970a8d4885224697517b2eebb' },
      'git-cli': { sha256: '7b161e9ee388578e33ef9c62279ac4e0d7190f32301dd89b8d59f70ba779175e' },
      'review-specialists': { sha256: '8a664f167ec8ab01496d6c7b782618c6ec6ff95c4de4286896b35e4232122edb' },
      'semantic-commit': { sha256: 'f1f9ad4ad3d3e4b040e8250291d7052791b0d81dae058f4b3e1fb3cffaf9f7b8' },
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
