import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { activationSha256, renderAgentHookConfig } from '../src/activation/index.js'

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

function activatedRuntimeRoot(temporary) {
  const runtimeRoot = join(temporary, 'runtime')
  const policy = 'schema_version = "dsh.policy.v1"\n'
  const catalog = 'schema_version = "agent-docs.catalog.v1"\n'
  const document = '# Project development\n'
  const assets = {
    policy_sha256: activationSha256(policy),
    catalog_sha256: activationSha256(catalog),
    document_sha256: activationSha256(document),
  }
  const assetDigest = activationSha256(JSON.stringify({
    catalog_sha256: assets.catalog_sha256,
    document_sha256: assets.document_sha256,
    policy_sha256: assets.policy_sha256,
  }))
  const assetRoot = join(runtimeRoot, 'assets', assetDigest)
  const hookAssets = join(assetRoot, 'agent-hook')
  const docsHome = join(assetRoot, 'agent-docs')
  const hookState = join(runtimeRoot, 'state', 'agent-hook')
  const docsState = join(runtimeRoot, 'state', 'agent-docs')
  for (const path of [hookAssets, docsHome, hookState, docsState]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(hookAssets, 'policy.toml'), policy, { mode: 0o600 })
  writeFileSync(
    join(hookAssets, 'config.toml'),
    renderAgentHookConfig(join(hookAssets, 'policy.toml'), assets.policy_sha256),
    { mode: 0o600 },
  )
  writeFileSync(join(docsHome, 'AGENT_DOCS.toml'), catalog, { mode: 0o600 })
  writeFileSync(join(docsHome, 'PROJECT_DEV_EDIT.md'), document, { mode: 0o600 })
  writeFileSync(join(runtimeRoot, 'activation.json'), `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.activation.v1',
    profile: 'headless',
    package_version: '1.0.0',
    package_artifact_sha256: '1'.repeat(64),
    package_installed_sha256: '2'.repeat(64),
    asset_set_sha256: assetDigest,
    assets,
    agent_hook: {
      config: `assets/${assetDigest}/agent-hook/config.toml`,
      policy: `assets/${assetDigest}/agent-hook/policy.toml`,
      state: 'state/agent-hook',
    },
    agent_docs: {
      home: `assets/${assetDigest}/agent-docs`,
      state: 'state/agent-docs',
    },
  })}\n`, { mode: 0o600 })
  return { assetRoot, assets, docsHome, docsState, hookAssets, hookState, runtimeRoot }
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

test('owner launcher replaces itself with the long-lived command on POSIX', async () => {
  if (process.platform === 'win32' || typeof process.execve !== 'function') return
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const runtimeRoot = join(temporary, 'runtime')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  try {
    const child = spawn(process.execPath, [
      launcher,
      '--runtime-root', runtimeRoot,
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(String(process.pid))',
    ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(status, 0, Buffer.concat(stderr).toString('utf8'))
    assert.equal(Number(Buffer.concat(stdout).toString('utf8')), child.pid)
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

test('owner launcher rejects an agent-hook asset symlink redirected into mutable state', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const subject = activatedRuntimeRoot(temporary)
  try {
    rmSync(subject.hookAssets, { recursive: true })
    writeFileSync(join(subject.hookState, 'policy.toml'), 'schema_version = "dsh.policy.v1"\n', { mode: 0o600 })
    writeFileSync(
      join(subject.hookState, 'config.toml'),
      renderAgentHookConfig(join(subject.hookState, 'policy.toml'), subject.assets.policy_sha256),
      { mode: 0o600 },
    )
    symlinkSync(subject.hookState, subject.hookAssets, 'dir')

    const rejected = invoke(subject.runtimeRoot)
    assert.equal(rejected.status, 64, rejected.stderr)
    assert.equal(rejected.stdout, '')
    assert.match(rejected.stderr, /real directory|symlink|disjoint|contained/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('owner launcher rejects an agent-docs asset symlink redirected into mutable state', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const subject = activatedRuntimeRoot(temporary)
  try {
    rmSync(subject.docsHome, { recursive: true })
    writeFileSync(join(subject.docsState, 'AGENT_DOCS.toml'), 'schema_version = "agent-docs.catalog.v1"\n', { mode: 0o600 })
    writeFileSync(join(subject.docsState, 'PROJECT_DEV_EDIT.md'), '# Project development\n', { mode: 0o600 })
    symlinkSync(subject.docsState, subject.docsHome, 'dir')

    const rejected = invoke(subject.runtimeRoot)
    assert.equal(rejected.status, 64, rejected.stderr)
    assert.equal(rejected.stdout, '')
    assert.match(rejected.stderr, /real directory|symlink|disjoint|contained/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('owner launcher canonicalizes a legitimate runtime root below a symlinked parent', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-launcher-'))
  const realParent = join(temporary, 'real-parent')
  const parentAlias = join(temporary, 'parent-alias')
  const subject = activatedRuntimeRoot(realParent)
  symlinkSync(realParent, parentAlias, 'dir')
  try {
    const launched = invoke(join(parentAlias, 'runtime'))
    assert.equal(launched.status, 0, launched.stderr)
    const environment = JSON.parse(launched.stdout)
    assert.equal(environment.root, subject.runtimeRoot)
    assert.equal(environment.hookConfig, join(subject.hookAssets, 'config.toml'))
    assert.equal(environment.hookPolicy, join(subject.hookAssets, 'policy.toml'))
    assert.equal(environment.hookState, subject.hookState)
    assert.equal(environment.docsHome, subject.docsHome)
    assert.equal(environment.docsState, subject.docsState)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
