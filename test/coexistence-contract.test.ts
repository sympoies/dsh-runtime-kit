import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('released nils-cli compatibility is pinned to the exact authenticated artifacts', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.29.0')
  assert.equal(manifest.validated_release, '1.31.24')
  assert.deepEqual(manifest.release, {
    "source_revision": "v1.31.24",
    "source_commit": "d4e014bb882e1a7c75e47124b636574256ecd189",
    "platform": "x86_64-unknown-linux-gnu",
    "archive": {
      "name": "nils-cli-v1.31.24-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "b6c74345bc4de1f55a42db13f59ac6942cb3a275690d5876ac2b1d89c5aed91c"
    },
    "artifacts": {
      "agent-hook": {
        "sha256": "e88c96951f66d6ceaf86027c1826b58a59ae2378d72c36abb8d635b03e46f610"
      },
      "agent-docs": {
        "sha256": "15fc6445082e8d18c832008f88878ce5098a53522c3f1bcf3b9d2f51ef9421ca"
      },
      "agent-session": {
        "sha256": "3bd19d8193a3cf57c05283052f9b88eae0cf7005eae0577e9e7ae3192d38ee87"
      },
      "forge-cli": {
        "sha256": "2828032d50eff36f0f7711ec0309673184b5e961da999a5c2665174aab8c9153"
      },
      "git-cli": {
        "sha256": "e88223d7021f77f4d451db373106e24117570f518b33736d3d1039a2d8852e9d"
      },
      "review-specialists": {
        "sha256": "31fc1083ac359ab44c28ce7bd06a67b05a9b96cfe1e628789c03c6d507ac1393"
      },
      "semantic-commit": {
        "sha256": "dfe7818c6ebd6bf646fc9d3edd4d30c44e1dee06d52b015b414ffc5f8dc40668"
      }
    },
    "platforms": {
      "aarch64-apple-darwin": {
        "archive": {
          "name": "nils-cli-v1.31.24-aarch64-apple-darwin.tar.gz",
          "sha256": "e462b5bbdd4aa36439c32cf1926da6b12b94240f4ca04ffe9160818d025285e6"
        },
        "artifacts": {
          "agent-hook": {
            "sha256": "069b3e787d6670eeb0dd453e8888ef7befc7a02bab15ebc99558edc141d071fd"
          },
          "agent-docs": {
            "sha256": "844006a384c45edc2a590b8b04c48d699620e29f686e8af2994a3acd5c6af8aa"
          },
          "agent-session": {
            "sha256": "4fd8464f0de3a648df0db9aacacc85e332bf1bfe09de59509c2f41380e8fd720"
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
  // #255 and Gate 0 select the serial predecessor. PR #254 acceptance admits
  // the pinned 1.28.25 host, so it is the executable rollback baseline. The
  // package identity is the compiled hosted acceptance artifact (a full build,
  // then npm 11.19.0 production pack under Node 24.16.0, recompressed by the
  // authenticated zlib-ng helper), not raw `npm pack` output. This assertion
  // freezes that reviewed selection for #255; it does not discover a future
  // child baseline.
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '237abe93c57d77fe00cc4b104ea7994644b65dd43061ac2ff71e7a623802177b',
    version: '1.28.25',
    source_revision: 'v1.28.25',
    source_commit: '6657af3a12a61e3cbda349c5e93279db690ca268',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.28.25-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '92f996f9bec38d8c5edfd52cc0966ae6cfb24fef193dbc6c5a6c26a5d22e69e8',
    },
    artifacts: {
      'agent-hook': { sha256: 'fadde034b1d9d7efd3ec296f2858cdfa4dec437408de83d0d94c1d2165d56bc3' },
      'agent-docs': { sha256: '2a736ae29db016c4fdedf2585b556983152a8bf012d01a96c3071539679a5a0d' },
      'agent-session': { sha256: '752c87c5980ac40710dde8043c30d66d4edb71f5e6c86cfa4022b6d0e17ba264' },
      'forge-cli': { sha256: 'ad6e887cc5f691cdfb36baeadde468bdca3d912a17bd6ff726e3286bdfb8659a' },
      'git-cli': { sha256: '904a2912b1bdbe13e2b1c66353b2aa6cc7a8db1bde0cc45827de18708367ea28' },
      'review-specialists': { sha256: 'a0110af730b1e00307aca1c3ba49a98ec77daf1c9ddfc59684f8fdf8fd477a8a' },
      'semantic-commit': { sha256: 'dd7a4dfe2e5df88e38e8e5d8af681fd86455cc9013fd03b07f409a7d1f66631f' },
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

test('maintained docs define isolated coexistence instead of repository retirement', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const readme = read('README.md')
  const migration = read('docs/migration.md')

  for (const document of [readme, migration]) {
    assert.match(document, /Codex[\s\S]{0,120}Claude Code[\s\S]{0,180}agent-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /DSH[\s\S]{0,180}dsh-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /native `headless` profile/i)
    assert.doesNotMatch(document, /old repository is then archived\/read-only|Retire active agent-runtime-kit usage|will replace `agent-runtime-kit`/i)
  }
})

test('the package owns a DSH-only docs catalog and explicit isolated activation contract', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const manifest = JSON.parse(read('package.json'))
  const catalog = read('agent-docs/AGENT_DOCS.toml')
  const context = read('agent-docs/PROJECT_DEV_EDIT.md')
  const patch = read('cordis.patch.yml')
  const operations = read('docs/operations.md')

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
})
