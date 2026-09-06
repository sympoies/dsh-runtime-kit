import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('issue 65 rollback is pinned to the exact accepted issue 79 baseline', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.28.3')
  assert.equal(manifest.validated_release, '1.28.3')
  assert.deepEqual(manifest.release, {
      source_revision: 'v1.28.3',
      source_commit: '9e24e70fadf07007bab0b2bbb85dc6a6d784cca0',
      platform: 'x86_64-unknown-linux-gnu',
      archive: {
          name: 'nils-cli-v1.28.3-x86_64-unknown-linux-gnu.tar.gz',
          'sha256': 'b5cdc02deacc43cc1cad507ad6e9019d71d983fe508426ace4fa46ff4c2996b2'
      },
      artifacts: {
          'agent-hook': {
              'sha256': 'c5b3ce55af477f87f6688b7d31c55205e657feb895328a974ea94a97c676a8a4'
          },
          'agent-docs': {
              'sha256': '54858bb2d98f8bd99983cefa913baa5b56169d476f8805ac7125df2fa18f8af6'
          },
          'agent-session': {
              'sha256': 'a3d6fe196cb440f5afa23be464165f0668c20586efebfab739ae1d1d25ce0f65'
          },
          'forge-cli': {
              'sha256': 'dc80058dc6974bd9fb3cc627ff9435f63422ba2b69767385f7a2dc7da4d68b2f'
          },
          'git-cli': {
              'sha256': '84d16e701638307beb0be0f36ccab62f5a614934e88f3e974fa91e4b7130006d'
          },
          'review-specialists': {
              'sha256': '91f89a0124846b0bd48fd4139c45252771c225797b538cfc9557caa0bf02fb35'
          },
          'semantic-commit': {
              'sha256': '49697a9c50a616d95e995d4c60d07dcc03ef117f363d339b0fa5a56533bb90a0'
          }
      },
      platforms: {
          'aarch64-apple-darwin': {
              archive: {
                  name: 'nils-cli-v1.28.3-aarch64-apple-darwin.tar.gz',
                  'sha256': '83214cd53b95196e4d3a346c6caddfa181225121b9c324e85b889d85fa283b44'
              },
              artifacts: {
                  'agent-hook': {
                      'sha256': 'f1911063964a72440df98c86bf5c353a7a782a7f9eda6fbc0ab74b7a305fafb3'
                  },
                  'agent-docs': {
                      'sha256': 'd0cd7cdd707eaf17bfe6f46cf7bc5116533b36251c4c48a106b2a18a79a8e32f'
                  },
                  'agent-session': {
                      'sha256': '95ce1501d5a34b9221313567bd585e8532a57a6843af9becf8f8efdbe9d6d3f5'
                  }
              }
          }
      }
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
  // #66 and Gate 0 select the serial predecessor. The Issue 79 acceptance
  // (main ae248830) admits the pinned rc.1 host, so it is the executable
  // rollback baseline for #65. The package identity is the hosted acceptance
  // artifact (npm 11.19.0 pack under Node 24.16.0, recompressed by the
  // authenticated zlib-ng helper), not raw `npm pack` output. This assertion
  // freezes that reviewed selection for #65; it does not discover a future
  // child baseline.
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '4b21c79c3dda7e4715755a867fed2ad833f4a8f1f2c3d593eb7fcfcf45cff6dd',
    version: '1.27.37',
    source_revision: 'v1.27.37',
    source_commit: '3fd3a9bd089247405ec2be219234a7a24f54a98c',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.37-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'bda942ee83e9cdc02ab29a7ba3ac97a4c76aafeb2b53f88297bdc330a255577b',
    },
    artifacts: {
      'agent-hook': { sha256: '0bddef9a486880d50bc866cabbfec459467b243143e6a875a34f7e0b7e469177' },
      'agent-docs': { sha256: '0c85379d4628f3a30c3df5377df95d2fddbefc2eb00e7c8ae0359f7db779c7bc' },
      'agent-session': { sha256: '57a8e8aed9ba57fc63b5949d20352b0f5fd88e1071a50840d9f05af1ac14f594' },
      'forge-cli': { sha256: '57d17797367d7b9597f849af4c34a963204d40b3f6f2fe2bb3b858ea49d84d3f' },
      'git-cli': { sha256: '5c1e8c789928d8568c554f113058c5bd05b1a7702a56076dd4f3e0a6f32cef2c' },
      'review-specialists': { sha256: '5038f1a438917523969314b3ca6c6189020b6ab5f550a2a55e8e62dd64b6717c' },
      'semantic-commit': { sha256: '1919018a9753a1ee95b68bf821fd202aab30c9700b9b5da0ff3b76f4d974b1a3' },
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
