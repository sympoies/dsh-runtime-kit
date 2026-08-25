import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { RuntimeHealth } from '../src/health/index.js'
import {
  installNilsHealthProviders,
  resolveNilsHealthCompatibility,
} from '../src/health/nils-provider.js'

const OWNER = '@sympoies/dsh-runtime-kit'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-health-provider-')))
  const hook = join(root, 'agent-hook')
  const docs = join(root, 'agent-docs')
  const hookBytes = Buffer.from('authenticated agent-hook fixture')
  const docsBytes = Buffer.from('authenticated agent-docs fixture')
  await writeFile(hook, hookBytes, { mode: 0o700 })
  await writeFile(docs, docsBytes, { mode: 0o700 })
  const calls = []
  let terminations = 0
  let quiescenceWaits = 0
  let releaseQuiescence
  const pendingQuiescence = new Promise(resolve => { releaseQuiescence = resolve })
  let audit = {
    schema_version: 'agent-docs.audit.v2',
    target: 'project',
    product: null,
    strict: true,
    docs_home: root,
    project_path: root,
    wiring: [],
    skills: [],
    documents: [],
    problems: 0,
    suggested_actions: [],
  }
  function spawned(spec) {
    calls.push(spec)
    let stdout
    if (spec.argv.includes('doctor')) {
      stdout = JSON.stringify({
        schema_version: 'cli.agent-hook.doctor.v1',
        ok: true,
        data: [{
          product: 'dsh',
          registration_owner: 'dsh-runtime-kit',
          dispatch_supported: true,
        }],
      })
    } else if (spec.argv.includes('--version')) {
      stdout = 'agent-docs 1.27.8 (fixture)\n'
    } else {
      stdout = JSON.stringify(audit)
    }
    return {
      done: overrides.doneReject === true
        ? Promise.reject(new Error('subprocess completion failed'))
        : Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
      terminate() { terminations += 1 },
      async waitForExit() {
        quiescenceWaits += 1
        if (overrides.waitNeverSettles === true) return pendingQuiescence
        if (overrides.waitForExitFalseOnce === true && quiescenceWaits === 1) return false
        if (Number.isSafeInteger(overrides.waitForExitDelayMs)
          && quiescenceWaits === 1) {
          await new Promise(resolve => setTimeout(resolve, overrides.waitForExitDelayMs))
        }
        return true
      },
    }
  }
  const subprocess = {
    descriptorSpawnSupported: overrides.descriptorSpawnSupported ?? true,
    async resolveExecutable(command) {
      if (command === 'agent-hook') return hook
      if (command === 'agent-docs') return docs
      throw new Error('unexpected executable')
    },
    spawn(spec) { return spawned({ ...spec, executionBinding: 'path' }) },
    spawnDescriptor(spec, executableFd) {
      return spawned({ ...spec, executionBinding: 'descriptor', executableFd })
    },
  }
  const compatibility = {
    schema_version: 'dsh-runtime-kit.nils-compatibility.v1',
    release: {
      source_revision: 'v1.27.8',
      artifacts: {
        'agent-hook': { sha256: sha256(hookBytes) },
        'agent-docs': { sha256: sha256(docsBytes) },
      },
    },
  }
  Object.assign(compatibility.release.artifacts, overrides.artifacts)
  const ctx = new Context()
  ctx.provide('subprocess', subprocess)
  await ctx.plugin(RuntimeHealth, overrides.healthConfig)
  const childPlugins = {
    main_agent_mode: { state: 'pending' },
    review_specialists: { state: 'pending' },
  }
  let authenticatedConfig
  let installError
  try {
    authenticatedConfig = await installNilsHealthProviders(ctx, ctx.dshRuntimeHealth, {
      agentHook: 'agent-hook',
      agentHookConfig: join(root, 'hook-config.toml'),
      agentHookPolicy: join(root, 'hook-policy.toml'),
      agentHookStateDir: root,
      agentDocs: 'agent-docs',
      agentDocsHome: root,
      agentDocsStateHome: root,
    }, {
      compatibility,
      dshRuntime: { versions: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' } },
      childPlugins,
      commandQuiescenceMs: overrides.commandQuiescenceMs,
      beforeCommandSpawn: overrides.beforeCommandSpawn,
    })
  } catch (error) {
    if (overrides.captureInstallFailure !== true) throw error
    installError = error
  }
  return {
    root,
    authenticatedConfig,
    installError,
    calls,
    ctx,
    docs,
    hook,
    childPlugins,
    get terminations() { return terminations },
    get quiescenceWaits() { return quiescenceWaits },
    releaseQuiescence(value = true) { releaseQuiescence(value) },
    setAudit(value) { audit = value },
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('authenticated nils providers report runtime and project readiness without projecting paths', async () => {
  const subject = await fixture()
  try {
    const runtime = await subject.ctx.dshRuntimeHealth.require('runtime-core')
    const project = await subject.ctx.dshRuntimeHealth.require('project-docs', {
      scope: subject.root,
    })
    assert.equal(runtime.state, 'ready')
    assert.equal(runtime.code, 'DSH_RUNTIME_HEALTH_RUNTIME_READY')
    assert.equal(project.state, 'ready')
    assert.equal(project.code, 'DSH_RUNTIME_HEALTH_PROJECT_READY')
    assert.doesNotMatch(JSON.stringify({ runtime, project }), new RegExp(subject.root))
    assert.equal(subject.calls.length, 3)
    assert.equal(subject.calls.every(call => call.env?.HOME === undefined), true)
    assert.equal(subject.calls.every(call => call.argv[0] !== subject.hook && call.argv[0] !== subject.docs), true)
    assert.equal(subject.calls.every(call => call.executionBinding === 'descriptor'), true)
    assert.equal(subject.calls.every(call => Number.isSafeInteger(call.executableFd)), true)
    assert.equal(subject.calls[0].argv[0], subject.authenticatedConfig.agentHook)
  } finally {
    await subject.dispose()
  }
})

test('runtime health blocks an unauthenticated companion before executing it', async () => {
  const subject = await fixture({
    artifacts: { 'agent-hook': { sha256: '0'.repeat(64) } },
    captureInstallFailure: true,
  })
  try {
    assert.equal(subject.installError?.code, 'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    assert.equal(subject.calls.length, 0)
  } finally {
    await subject.dispose()
  }
})

test('runtime health fails closed when the subprocess provider lacks descriptor execution', async () => {
  const subject = await fixture({
    descriptorSpawnSupported: false,
    captureInstallFailure: true,
  })
  try {
    assert.equal(subject.installError?.code, 'DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
    assert.equal(subject.calls.length, 0)
  } finally {
    await subject.dispose()
  }
})

test('runtime health selects platform-specific authenticated companion artifacts', () => {
  const compatibility = {
    schema_version: 'dsh-runtime-kit.nils-compatibility.v1',
    release: {
      source_revision: 'v1.27.8',
      platform: 'x86_64-unknown-linux-gnu',
      artifacts: {
        'agent-hook': { sha256: '1'.repeat(64) },
        'agent-docs': { sha256: '2'.repeat(64) },
      },
      platforms: {
        'aarch64-apple-darwin': {
          artifacts: {
            'agent-hook': { sha256: '3'.repeat(64) },
            'agent-docs': { sha256: '4'.repeat(64) },
          },
        },
      },
    },
  }
  assert.deepEqual(
    resolveNilsHealthCompatibility(compatibility, 'aarch64-apple-darwin'),
    {
      version: '1.27.8',
      platform: 'aarch64-apple-darwin',
      hookSha256: '3'.repeat(64),
      docsSha256: '4'.repeat(64),
    },
  )
  assert.throws(
    () => resolveNilsHealthCompatibility(compatibility, 'x86_64-apple-darwin'),
    error => error?.code === 'DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED',
  )
})

test('project audit failures stay typed and recover on the same hashed scope', async () => {
  const subject = await fixture()
  try {
    await subject.ctx.dshRuntimeHealth.require('runtime-core')
    subject.setAudit({ schema_version: 'unexpected', project_path: subject.root })
    const blocked = await subject.ctx.dshRuntimeHealth.probe('project-docs', {
      scope: subject.root,
    })
    assert.equal(blocked.state, 'blocked')
    assert.equal(blocked.code, 'DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID')
    assert.doesNotMatch(JSON.stringify(blocked), new RegExp(subject.root))

    subject.setAudit({
      schema_version: 'agent-docs.audit.v2',
      target: 'project',
      product: null,
      strict: true,
      docs_home: subject.root,
      project_path: subject.root,
      wiring: [],
      skills: [],
      documents: [],
      problems: 0,
      suggested_actions: [],
    })
    const repaired = await subject.ctx.dshRuntimeHealth.probe('project-docs', {
      scope: subject.root,
      force: true,
    })
    assert.equal(repaired.state, 'ready')
    assert.equal(repaired.code, 'DSH_RUNTIME_HEALTH_PROJECT_READY')
  } finally {
    await subject.dispose()
  }
})

test('optional child health is degraded until activation and can be refreshed natively', async () => {
  const subject = await fixture()
  try {
    const pending = await subject.ctx.dshRuntimeHealth.probe('main-agent-mode')
    assert.equal(pending.state, 'degraded')
    assert.equal(pending.code, 'DSH_RUNTIME_HEALTH_OPTIONAL_PENDING')
    subject.childPlugins.main_agent_mode = { state: 'active' }
    const active = await subject.ctx.dshRuntimeHealth.probe('main-agent-mode', { force: true })
    assert.equal(active.state, 'ready')
    assert.equal(active.code, 'DSH_RUNTIME_HEALTH_OPTIONAL_READY')
  } finally {
    await subject.dispose()
  }
})

test('subprocess completion failure still observes process-tree quiescence', async () => {
  const subject = await fixture({ doneReject: true })
  try {
    const runtime = await subject.ctx.dshRuntimeHealth.probe('runtime-core')
    assert.equal(runtime.state, 'blocked')
    assert.equal(runtime.code, 'DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE')
    assert.equal(subject.calls.length, 1)
    assert.equal(subject.terminations, 1)
    assert.equal(subject.quiescenceWaits, 1)
  } finally {
    await subject.dispose()
  }
})

test('a false quiescence observation terminates and drains the tree before blocking', async () => {
  const subject = await fixture({ waitForExitFalseOnce: true })
  try {
    const runtime = await subject.ctx.dshRuntimeHealth.probe('runtime-core')
    assert.equal(runtime.state, 'blocked')
    assert.equal(runtime.code, 'DSH_RUNTIME_HEALTH_COMPANION_QUIESCENCE_UNKNOWN')
    assert.equal(subject.terminations, 1)
    assert.equal(subject.quiescenceWaits, 2)
  } finally {
    await subject.dispose()
  }
})

test('a true quiescence observation after the deadline is drained but never accepted', async () => {
  const subject = await fixture({
    commandQuiescenceMs: 5,
    waitForExitDelayMs: 20,
  })
  try {
    const runtime = await subject.ctx.dshRuntimeHealth.probe('runtime-core')
    assert.equal(runtime.state, 'blocked')
    assert.equal(runtime.code, 'DSH_RUNTIME_HEALTH_COMPANION_QUIESCENCE_UNKNOWN')
    assert.equal(subject.terminations, 1)
    assert.equal(subject.quiescenceWaits, 2)
  } finally {
    await subject.dispose()
  }
})

test('nonsettling tree observation remains owned across bounded health disposal', async () => {
  const subject = await fixture({
    waitNeverSettles: true,
    healthConfig: { probeTimeoutMs: 20, disposeTimeoutMs: 20 },
  })
  const health = subject.ctx.dshRuntimeHealth
  try {
    const runtime = await health.probe('runtime-core')
    assert.equal(runtime.state, 'blocked')
    assert.equal(runtime.code, 'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT')
    assert.equal(subject.terminations >= 1, true)
    let disposed = false
    const disposing = subject.ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(disposed, true)
    assert.equal(health.draining.size, 1)
    subject.releaseQuiescence()
    await disposing
    while (health.draining.size > 0) await new Promise(resolve => setImmediate(resolve))
    assert.equal(health.draining.size, 0)
  } finally {
    subject.releaseQuiescence()
    await rm(subject.root, { recursive: true, force: true })
  }
})

test('post-start source replacement cannot change the authenticated executable snapshot', async () => {
  const subject = await fixture()
  try {
    await writeFile(subject.hook, 'malicious replacement', { mode: 0o700 })
    await writeFile(subject.docs, 'malicious replacement', { mode: 0o700 })
    const runtime = await subject.ctx.dshRuntimeHealth.probe('runtime-core')
    assert.equal(runtime.state, 'ready')
    assert.equal(subject.calls.every(call => call.argv[0] !== subject.hook && call.argv[0] !== subject.docs), true)
  } finally {
    await subject.dispose()
  }
})

test('snapshot execution stays descriptor-bound after its private pathname is retired', async () => {
  const subject = await fixture()
  const snapshotRoot = dirname(subject.authenticatedConfig.agentHook)
  let disposed = false
  try {
    assert.deepEqual(
      Object.keys(subject.authenticatedConfig).sort(),
      ['agentDocs', 'agentHook', 'authenticatedNilsExecution'],
    )
    await assert.rejects(stat(snapshotRoot), { code: 'ENOENT' })
    await mkdir(snapshotRoot, { mode: 0o700 })
    await writeFile(join(snapshotRoot, 'agent-hook'), 'replacement hook', { mode: 0o700 })
    await writeFile(join(snapshotRoot, 'agent-docs'), 'replacement docs', { mode: 0o700 })

    const runtime = await subject.ctx.dshRuntimeHealth.probe('runtime-core')
    assert.equal(runtime.state, 'ready')
    assert.equal(subject.calls.every(call => call.executionBinding === 'descriptor'), true)
    assert.equal(subject.calls.every(call => Number.isSafeInteger(call.executableFd)), true)

    await subject.ctx.fiber.dispose()
    disposed = true
    assert.equal(await readFile(join(snapshotRoot, 'agent-hook'), 'utf8'), 'replacement hook')
    assert.equal(await readFile(join(snapshotRoot, 'agent-docs'), 'utf8'), 'replacement docs')
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true })
    if (!disposed) await subject.ctx.fiber.dispose()
    await subject.dispose()
  }
})

test('snapshot disposal drains a pre-spawn lease before closing its executable descriptor', async () => {
  let enterSpawnBarrier
  let releaseSpawnBarrier
  const entered = new Promise(resolve => { enterSpawnBarrier = resolve })
  const barrier = new Promise(resolve => { releaseSpawnBarrier = resolve })
  let blockSpawn = false
  const subject = await fixture({
    async beforeCommandSpawn() {
      if (!blockSpawn) return
      enterSpawnBarrier()
      await barrier
    },
  })
  await subject.ctx.dshRuntimeHealth.require('runtime-core')
  assert.equal(subject.calls.length, 2)
  const descriptorFd = subject.calls[0].executableFd
  blockSpawn = true
  const probing = subject.ctx.dshRuntimeHealth.probe('runtime-core', { force: true }).catch(error => error)
  await entered

  let disposed = false
  const disposing = subject.ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(subject.calls.length, 2)

  releaseSpawnBarrier()
  await Promise.allSettled([probing, disposing])
  assert.equal(disposed, true)
  assert.equal(subject.calls.length, 2)
  assert.equal(subject.calls[0].executionBinding, 'descriptor')
  assert.throws(() => fstatSync(descriptorFd), { code: 'EBADF' })
  await rm(subject.root, { recursive: true, force: true })
})
