#!/usr/bin/env node

import { PACKAGE_ROOT } from '../src/package-root.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'

import { validateDshCompatibilityManifest } from '../src/compat/contract.js'
import { evaluatePolicyPerformanceBudget } from '../src/compat/performance.js'
import { createNilsTransport } from '../src/policy/nils-transport.js'
import type { Context, ToolExecution } from '../src/policy/nils-transport.js'

type Disposer = () => unknown
/** The part of the transport's spawn request this controlled provider reads. */
type BenchmarkSpawnSpec = { stdio: { stdin: { data: string } } }
type BenchmarkHandle = {
  done: Promise<{ exitCode: number, signal: null }>,
  collected: { stdout: { readFrom: () => { text: string, lossy: boolean } } },
  terminate(): void,
  waitForExit(): Promise<boolean>,
}

const projectRoot = PACKAGE_ROOT
const manifest = validateDshCompatibilityManifest(JSON.parse(
  await readFile(resolve(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
))
const contract = manifest.performance.pre_tool

if (typeof global.gc !== 'function') {
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.policy-performance.v1',
    ok: false,
    error: { code: 'DSH_RUNTIME_KIT_GC_UNAVAILABLE' },
  })}\n`)
  process.exitCode = 1
} else {
  const disposers: Disposer[] = []
  const live = new Set<BenchmarkHandle>()
  const ctx = {
    effect(factory: () => Disposer | void) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    subprocess: {
      spawn(spec: BenchmarkSpawnSpec) {
        const ingress = JSON.parse(spec.stdio.stdin.data)
        const requestId = `request:${createHash('sha256')
          .update(spec.stdio.stdin.data)
          .digest('hex')
          .slice(0, 32)}`
        const envelope = JSON.stringify({
          schema_version: 'cli.agent-hook.dispatch.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.normalized-decision.v1',
            request_id: requestId,
            product: 'dsh',
            event: 'PreToolUse',
            action: 'allow',
            reasons: [],
            config_digest: `sha256:${'0'.repeat(64)}`,
            policy_digest: `sha256:${'0'.repeat(64)}`,
            recovery_applied: false,
          },
        })
        const handle: BenchmarkHandle = {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: envelope, lossy: false }) },
          },
          terminate() { live.delete(handle) },
          async waitForExit() {
            live.delete(handle)
            return true
          },
        }
        if (ingress.event !== 'tools/pre-execute') throw new Error('unexpected benchmark ingress')
        live.add(handle)
        return handle
      },
    },
  }
  const transport = createNilsTransport(ctx as unknown as Context, {
    agentHook: '/benchmark/agent-hook',
    agentHookConfig: '/benchmark/agent-hook/config.toml',
    agentHookPolicy: '/benchmark/agent-hook/policy.toml',
    agentHookStateDir: '/benchmark/agent-hook/state',
    agentDocsHome: '/benchmark/agent-docs',
    agentDocsStateHome: '/benchmark/state',
    maxActivePolicyChecks: 1,
  })
  let sequence = 0
  async function evaluate() {
    sequence += 1
    const signal = new AbortController().signal
    const result = await transport.evaluate({
      token: Symbol(`benchmark-${sequence}`),
      callId: `benchmark-${sequence}`,
      rootCallId: `benchmark-${sequence}`,
      name: 'runtime_kit_plus_one',
      arguments: { value: 41 },
      signal,
    } as unknown as ToolExecution, {
      sessionId: 'benchmark-session',
      cwd: projectRoot,
      turn: 1,
      step: sequence,
    }, undefined)
    if (result !== undefined) throw new Error('controlled policy provider did not allow')
  }

  try {
    for (let index = 0; index < contract.warmup_iterations; index += 1) await evaluate()
    global.gc()
    const heapBefore = process.memoryUsage().heapUsed
    const samplesMs: number[] = []
    const batchRetainedHeapBytes: number[] = []
    for (let batch = 0; batch < contract.batches; batch += 1) {
      for (let index = 0; index < contract.iterations; index += 1) {
        const started = performance.now()
        await evaluate()
        samplesMs.push(performance.now() - started)
      }
      global.gc()
      batchRetainedHeapBytes.push(Math.max(0, process.memoryUsage().heapUsed - heapBefore))
    }
    const retainedHeapBytes = Math.max(...batchRetainedHeapBytes)
    const retainedGrowthBytes = Math.max(
      0,
      (batchRetainedHeapBytes.at(-1) ?? 0) - (batchRetainedHeapBytes[0] ?? 0),
    )
    const report = evaluatePolicyPerformanceBudget({
      samplesMs,
      retainedHeapBytes,
      retainedGrowthBytes,
      batchRetainedHeapBytes,
      activeAfter: transport.active,
      liveHandlesAfter: live.size,
    }, {
      p95_ms: contract.p95_ms,
      retained_heap_bytes: contract.retained_heap_bytes,
      retained_growth_bytes: contract.retained_growth_bytes,
      max_active_after: contract.max_active_after,
    })
    for (const dispose of disposers.reverse()) await dispose()
    if (transport.active !== 0 || live.size !== 0) {
      throw new Error('policy benchmark teardown did not quiesce')
    }
    process.stdout.write(`${JSON.stringify({
      ...report,
      ok: true,
      teardown_active_after: transport.active,
      teardown_live_handles_after: live.size,
    })}\n`)
  } catch (error) {
    const diagnostic = typeof error === 'object' && error !== null && 'diagnostic' in error
      ? error.diagnostic
      : undefined
    process.stdout.write(`${JSON.stringify({
      schema_version: 'dsh-runtime-kit.policy-performance.v1',
      ok: false,
      error: diagnostic ?? { code: 'DSH_RUNTIME_KIT_POLICY_BENCHMARK_FAILED' },
    })}\n`)
    process.exitCode = 1
  }
}
