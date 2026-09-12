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
  assert.equal(manifest.validated_release, '1.28.22')
  assert.deepEqual(manifest.release, {
      source_revision: 'v1.28.22',
      source_commit: '17dbe7e4b6e0523db4f7ad21c292173191f8c392',
      platform: 'x86_64-unknown-linux-gnu',
      archive: {
          name: 'nils-cli-v1.28.22-x86_64-unknown-linux-gnu.tar.gz',
          'sha256': '55bca2daa20bde359c61964f22740854c4dc90c08ca309bf184ccc819ea5c485'
      },
      artifacts: {
          'agent-hook': {
              'sha256': '94801dd79cbe913de61c396da4b875291067ba595169cd5c30b5ba37cda07d9d'
          },
          'agent-docs': {
              'sha256': '9161d1e8cb778e0f4938c2b4b20db488366897aa94dc681476e4aafccd53cdb8'
          },
          'agent-session': {
              'sha256': '2d2a72c4c611de72de047f30b3257b91ee557469393ee7b0135b6f2d8e0d43c7'
          },
          'forge-cli': {
              'sha256': '3d5b04a547d5c904ac5a36080332ba110955421d410fbe1a0d5ba1a5dbdbf381'
          },
          'git-cli': {
              'sha256': '36e829f6298d148f6aeef3115209ae9b5fdcf79400316b37f7bf7cb9a8c95fe7'
          },
          'review-specialists': {
              'sha256': '4bbec4c81b4e73bbceca095d42f39178e6074b99ca5107294b82e4635521ca56'
          },
          'semantic-commit': {
              'sha256': '1ceaa80b996a96228a2a69ea2622a19f5f439d42495b0827fa2c388fe63a5a10'
          }
      },
      platforms: {
          'aarch64-apple-darwin': {
              archive: {
                  name: 'nils-cli-v1.28.22-aarch64-apple-darwin.tar.gz',
                  'sha256': 'bc41ba851e1d488fd8fa279848b31e648e2128a49db8f19e98726244c7eb1b30'
              },
              artifacts: {
                  'agent-hook': {
                      'sha256': '786d316170ccf4a2857aed3f2287638759a17797f7fb5dc23746b9f7958e3e4f'
                  },
                  'agent-docs': {
                      'sha256': '53647680a62e65c95a8df120cb4417b9013eab90666d3bfc4baa6e80823d29ad'
                  },
                  'agent-session': {
                      'sha256': '72b3cddfbe23011d4f3aaab94aa0994d06025850474a9c3d7c461e77dbadf0d4'
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
