#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { validateDshCompatibilityManifest } from '../src/compat/contract.js'
import { createNilsTransport } from '../src/policy/nils-transport.js'

const PACKED_MARKER = 'DSH_RUNTIME_KIT_REAL_BENCHMARK_PACKED'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function executable(input) {
  const candidates = input.includes('/')
    ? [resolve(input)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, input))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {}
  }
  throw new Error(`required executable is unavailable: ${input}`)
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${bin} failed with status ${result.status}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function runPackedCopy() {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-real-benchmark-pack-'))
  try {
    const packed = JSON.parse(run(executable('npm'), [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
    ], { cwd: projectRoot }))
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
      throw new Error('npm pack returned an invalid artifact receipt')
    }
    run(executable('tar'), ['-xzf', join(temporary, packed[0].filename), '-C', temporary])
    const child = spawnSync(process.execPath, [
      join(temporary, 'package', 'scripts', 'benchmark-policy-real.mjs'),
    ], {
      cwd: join(temporary, 'package'),
      env: { ...process.env, [PACKED_MARKER]: '1' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    process.stdout.write(child.stdout)
    process.stderr.write(child.stderr)
    if (child.status !== 0) process.exitCode = child.status ?? 1
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function safeChildEnvironment(overrides) {
  const output = {}
  for (const name of [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LANGUAGE', 'TZ',
    'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'NO_PROXY', 'no_proxy',
  ]) {
    if (process.env[name] !== undefined) output[name] = process.env[name]
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete output[name]
    else output[name] = value
  }
  return output
}

function realSubprocessService(live) {
  return {
    spawn(spec) {
      const [bin, ...args] = spec.argv
      const stdoutLimit = spec.stdio.stdout?.maxBytes ?? 64 * 1024
      const stderrLimit = spec.stdio.stderr?.maxBytes ?? 8 * 1024
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let stdoutLossy = false
      let stderrLossy = false
      const child = spawn(bin, args, {
        cwd: spec.cwd,
        env: safeChildEnvironment(spec.env),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      live.add(child)
      if (spec.stdio.stdin?.data !== undefined) child.stdin.end(spec.stdio.stdin.data)
      else child.stdin.end()
      child.stdout.on('data', chunk => {
        const remaining = stdoutLimit - stdout.byteLength
        if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)])
        if (chunk.byteLength > remaining) stdoutLossy = true
      })
      child.stderr.on('data', chunk => {
        const remaining = stderrLimit - stderr.byteLength
        if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
        if (chunk.byteLength > remaining) stderrLossy = true
      })
      const done = new Promise((resolveDone, rejectDone) => {
        child.once('error', rejectDone)
        child.once('close', (exitCode, signal) => {
          live.delete(child)
          resolveDone({ exitCode, signal })
        })
      })
      const terminate = () => {
        if (child.pid === undefined) return
        try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
      }
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate()
        else spec.signal.addEventListener('abort', terminate, { once: true })
      }
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout.toString('utf8'), lossy: stdoutLossy }) },
          stderr: { readFrom: () => ({ text: stderr.toString('utf8'), lossy: stderrLossy }) },
        },
        terminate,
        async waitForExit(signal) {
          if (signal?.aborted) return false
          const aborted = signal === undefined
            ? new Promise(() => {})
            : new Promise(resolveAbort => signal.addEventListener('abort', () => resolveAbort(false), { once: true }))
          const closed = Promise.resolve(done).then(() => {
            if (child.pid === undefined) return true
            try {
              process.kill(-child.pid, 0)
              return false
            } catch {
              return true
            }
          }, () => false)
          return Promise.race([closed, aborted])
        },
      }
    },
  }
}

function percentile95(samples) {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]
}

async function benchmarkPackedRuntime() {
  const manifest = validateDshCompatibilityManifest(JSON.parse(
    readFileSync(join(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
  ))
  const nils = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))
  const contract = manifest.performance.pre_tool_subprocess
  const agentHook = executable(process.env.AGENT_HOOK_BIN ?? 'agent-hook')
  const observedHash = sha256(readFileSync(agentHook))
  if (observedHash !== nils.release.artifacts['agent-hook'].sha256) {
    throw new Error('agent-hook does not match the released compatibility artifact')
  }
  const version = run(agentHook, ['--version']).trim()
  if (!version.startsWith(`agent-hook ${nils.validated_release} (`)) {
    throw new Error('agent-hook version does not match the released compatibility contract')
  }

  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-real-benchmark-'))
  const disposers = []
  const live = new Set()
  try {
    const home = join(temporary, 'home')
    const runtime = join(temporary, 'runtime')
    const hookRoot = join(runtime, 'agent-hook')
    const docsHome = join(runtime, 'agent-docs')
    const hookState = join(runtime, 'state', 'agent-hook')
    const docsState = join(runtime, 'state', 'agent-docs')
    const workspace = join(temporary, 'workspace')
    for (const directory of [home, runtime, hookRoot, docsHome, hookState, docsState, workspace]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    const policy = join(hookRoot, 'policy.toml')
    const config = join(hookRoot, 'config.toml')
    copyFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), policy)
    copyFileSync(join(projectRoot, 'agent-docs', 'AGENT_DOCS.toml'), join(docsHome, 'AGENT_DOCS.toml'))
    copyFileSync(join(projectRoot, 'agent-docs', 'PROJECT_DEV_EDIT.md'), join(docsHome, 'PROJECT_DEV_EDIT.md'))
    for (const path of [policy, join(docsHome, 'AGENT_DOCS.toml'), join(docsHome, 'PROJECT_DEV_EDIT.md')]) {
      chmodSync(path, 0o600)
    }
    writeFileSync(config, `schema_version = "agent-hook.config.v1"\n\n[policy]\npath = ${JSON.stringify(policy)}\ndigest = "sha256:${sha256(readFileSync(policy))}"\n`, { mode: 0o600 })

    const ctx = {
      effect(factory) {
        const dispose = factory()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      subprocess: realSubprocessService(live),
    }
    const transport = createNilsTransport(/** @type {any} */ (ctx), {
      agentHook,
      agentHookConfig: config,
      agentHookPolicy: policy,
      agentHookStateDir: hookState,
      agentDocsHome: docsHome,
      agentDocsStateHome: docsState,
      maxActivePolicyChecks: 1,
    })
    let sequence = 0
    const evaluate = async () => {
      sequence += 1
      const result = await transport.evaluate({
        token: Symbol(`real-benchmark-${sequence}`),
        callId: `real-benchmark-${randomUUID()}`,
        rootCallId: `real-benchmark-${sequence}`,
        name: 'runtime_kit_plus_one',
        arguments: { value: 41 },
        signal: new AbortController().signal,
      }, {
        sessionId: 'real-benchmark-session',
        cwd: workspace,
        turn: 1,
        step: sequence,
      })
      if (result !== undefined) throw new Error(`released policy did not allow benchmark input: ${JSON.stringify(result)}`)
    }
    for (let index = 0; index < contract.warmup_iterations; index += 1) await evaluate()
    const samplesMs = []
    for (let index = 0; index < contract.iterations; index += 1) {
      const started = performance.now()
      await evaluate()
      samplesMs.push(performance.now() - started)
    }
    for (const dispose of disposers.reverse()) await dispose()
    const p95Ms = percentile95(samplesMs)
    const activeAfter = transport.active
    const liveChildrenAfter = live.size
    const exceeded = []
    if (p95Ms > contract.p95_ms) exceeded.push('p95_ms')
    if (activeAfter !== contract.max_active_after) exceeded.push('active_after')
    if (liveChildrenAfter !== contract.max_live_children_after) exceeded.push('live_children_after')
    if (exceeded.length > 0) throw new Error(`real subprocess performance budget exceeded: ${exceeded.join(', ')}`)
    process.stdout.write(`${JSON.stringify({
      schema_version: 'dsh-runtime-kit.policy-subprocess-performance.v1',
      ok: true,
      runtime: 'packed',
      agent_hook_version: nils.validated_release,
      agent_hook_sha256: observedHash,
      samples: samplesMs.length,
      p95_ms: p95Ms,
      budget_p95_ms: contract.p95_ms,
      active_after: activeAfter,
      live_children_after: liveChildrenAfter,
    })}\n`)
  } finally {
    for (const dispose of disposers.reverse()) {
      try { await dispose() } catch {}
    }
    for (const child of live) {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      }
    }
    rmSync(temporary, { recursive: true, force: true })
  }
}

try {
  if (process.env[PACKED_MARKER] !== '1') runPackedCopy()
  else await benchmarkPackedRuntime()
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.policy-subprocess-performance.v1',
    ok: false,
    error: { code: 'DSH_RUNTIME_KIT_REAL_POLICY_BENCHMARK_FAILED', message: error instanceof Error ? error.message : String(error) },
  })}\n`)
  process.exitCode = 1
}
