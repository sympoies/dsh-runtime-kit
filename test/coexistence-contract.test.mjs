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
  assert.equal(manifest.validated_release, '1.27.21')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.21',
    source_commit: '2d077ec976e66be425e519222967cb1a5e9fed18',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.21-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'bd5dde2ab71964509a80d98d4258e0301b63c4b50de1e56d0d108d812e81e6fe',
    },
    artifacts: {
      'agent-hook': { sha256: '23bcbc98cd701c052013b0e4455fed4865f1717fb08bb4c7b7f8f10c21e0871a' },
      'agent-docs': { sha256: '8f0d8cde47c594a9e4759fef78c4101601fc5ededea7d84ba5e56f450f7fd831' },
      'forge-cli': { sha256: '39d8cd5670245121d9db4a2569f2ba89bc9b30ac262bdf90167b9b1d6bfcd95e' },
      'git-cli': { sha256: 'c99f23a052aa3f0e9e4ec6b054a19271ba8e572c7c14178430c964132c3277a8' },
      'review-specialists': { sha256: 'b62809585c261b3f33bc2ee1d63e7edeaf08fc87da776aee5965a40e8f0126b9' },
      'semantic-commit': { sha256: 'c5e83445883d41dc7a1997e1373c49b4e7e466d5ee82ab463ed32d7a28eebd07' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.21-aarch64-apple-darwin.tar.gz',
          sha256: '639fd89ed339683adca415943d88fa31faa5410a5188a10a4b61f2d543922773',
        },
        artifacts: {
          'agent-hook': { sha256: '0d16231df02fb08ed9de4a0306a2e8e583a3dd9f414e7460d18cf7395d4e0865' },
          'agent-docs': { sha256: '262d2e9d8e7a7c5b314404c4a41a41796eb634b649163b59c298c13ee09a566a' },
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
