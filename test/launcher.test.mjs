import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const launcher = join(projectRoot, 'bin', 'dsh-runtime-kit-launch.js')

function invoke(runtimeRoot, extraEnvironment = {}) {
  return spawnSync(process.execPath, [
    launcher,
    '--runtime-root', runtimeRoot,
    '--',
    process.execPath,
    '-e',
    `process.stdout.write(JSON.stringify({
      root: process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT,
      hookConfig: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG,
      hookPolicy: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY,
      hookState: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR,
      docsHome: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_HOME,
      docsState: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME,
      argument: process.argv[1],
    }))`,
    'argument preserved',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: '/ambient/provider/config.toml',
      ...extraEnvironment,
    },
  })
}

test('owner launcher derives the complete DSH isolation environment from one runtime root', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const runtimeRoot = join(temporary, 'runtime')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  try {
    const result = invoke(runtimeRoot)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      root: runtimeRoot,
      hookConfig: join(runtimeRoot, 'agent-hook', 'config.toml'),
      hookPolicy: join(runtimeRoot, 'agent-hook', 'policy.toml'),
      hookState: join(runtimeRoot, 'agent-hook', 'state'),
      docsHome: join(runtimeRoot, 'agent-docs'),
      docsState: join(runtimeRoot, 'agent-docs-state'),
      argument: 'argument preserved',
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('owner launcher rejects a non-private, relative, or missing runtime root', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const runtimeRoot = join(temporary, 'runtime')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  try {
    chmodSync(runtimeRoot, 0o750)
    const unsafe = invoke(runtimeRoot)
    assert.equal(unsafe.status, 64)
    assert.match(unsafe.stderr, /owner-only directory/u)

    const relative = invoke('runtime')
    assert.equal(relative.status, 64)
    assert.match(relative.stderr, /absolute path/u)

    const absent = invoke(join(temporary, 'absent'))
    assert.equal(absent.status, 64)
    assert.match(absent.stderr, /real directory/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('owner launcher rejects provider-home aliases and nested asset/state activation paths', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const runtimeRoot = join(temporary, 'runtime')
  const providerAlias = join(temporary, 'codex-alias')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  symlinkSync(runtimeRoot, providerAlias, 'dir')
  try {
    const provider = invoke(runtimeRoot, { CODEX_HOME: providerAlias })
    assert.equal(provider.status, 64)
    assert.match(provider.stderr, /disjoint from Codex and Claude runtime homes/u)

    const digest = '0'.repeat(64)
    writeFileSync(join(runtimeRoot, 'activation.json'), `${JSON.stringify({
      schema_version: 'dsh-runtime-kit.activation.v1',
      profile: 'headless',
      package_version: '1.0.0',
      package_artifact_sha256: digest,
      package_installed_sha256: digest,
      asset_set_sha256: digest,
      assets: {
        policy_sha256: digest,
        catalog_sha256: digest,
        document_sha256: digest,
      },
      agent_hook: {
        config: `assets/${digest}/agent-hook/config.toml`,
        policy: `assets/${digest}/agent-hook/policy.toml`,
        state: `assets/${digest}/agent-hook/state`,
      },
      agent_docs: {
        home: `assets/${digest}/agent-docs`,
        state: 'state/agent-docs',
      },
    })}\n`, { mode: 0o600 })
    const nested = invoke(runtimeRoot)
    assert.equal(nested.status, 64)
    assert.match(nested.stderr, /incompatible contract|disjoint/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('owner launcher rejects provider-home nesting in both directions', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const providerParent = join(temporary, 'provider-parent')
  const runtimeChild = join(providerParent, 'runtime')
  const runtimeParent = join(temporary, 'runtime-parent')
  const providerChild = join(runtimeParent, 'provider-child')
  for (const path of [runtimeChild, providerChild]) mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    const underProvider = invoke(runtimeChild, { CODEX_HOME: providerParent })
    assert.equal(underProvider.status, 64)
    assert.match(underProvider.stderr, /disjoint from Codex and Claude runtime homes/u)

    const containsProvider = invoke(runtimeParent, { CLAUDE_CONFIG_DIR: providerChild })
    assert.equal(containsProvider.status, 64)
    assert.match(containsProvider.stderr, /disjoint from Codex and Claude runtime homes/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
