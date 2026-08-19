// @ts-check

import { DshCompatibilityError } from './contract.js'

/**
 * @param {{samplesMs: number[], retainedHeapBytes: number, retainedGrowthBytes?: number, batchRetainedHeapBytes?: number[], activeAfter: number, liveHandlesAfter: number}} measurement
 * @param {{p95_ms: number, retained_heap_bytes: number, retained_growth_bytes?: number, max_active_after: number}} budget
 */
export function evaluatePolicyPerformanceBudget(measurement, budget) {
  if (!Array.isArray(measurement.samplesMs)
    || measurement.samplesMs.length === 0
    || !measurement.samplesMs.every(value => typeof value === 'number'
      && Number.isFinite(value) && value >= 0)
    || !Number.isSafeInteger(measurement.retainedHeapBytes)
    || measurement.retainedHeapBytes < 0
    || !Number.isSafeInteger(measurement.activeAfter)
    || measurement.activeAfter < 0
    || !Number.isSafeInteger(measurement.liveHandlesAfter)
    || measurement.liveHandlesAfter < 0
    || (measurement.retainedGrowthBytes !== undefined
      && (!Number.isSafeInteger(measurement.retainedGrowthBytes)
        || measurement.retainedGrowthBytes < 0))) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_PERFORMANCE_MEASUREMENT_INVALID',
      'Policy performance measurement is invalid',
    )
  }
  const sorted = [...measurement.samplesMs].sort((left, right) => left - right)
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
  const result = {
    schema_version: 'dsh-runtime-kit.policy-performance.v1',
    status: 'pass',
    samples: sorted.length,
    p95_ms: p95,
    retained_heap_bytes: measurement.retainedHeapBytes,
    active_after: measurement.activeAfter,
    live_handles_after: measurement.liveHandlesAfter,
    ...measurement.batchRetainedHeapBytes === undefined
      ? {}
      : { batch_retained_heap_bytes: [...measurement.batchRetainedHeapBytes] },
    ...measurement.retainedGrowthBytes === undefined
      ? {}
      : { retained_growth_bytes: measurement.retainedGrowthBytes },
    budget,
  }
  const exceeded = []
  if (p95 > budget.p95_ms) exceeded.push('p95_ms')
  if (measurement.retainedHeapBytes > budget.retained_heap_bytes) {
    exceeded.push('retained_heap_bytes')
  }
  if (measurement.retainedGrowthBytes !== undefined
    && budget.retained_growth_bytes !== undefined
    && measurement.retainedGrowthBytes > budget.retained_growth_bytes) {
    exceeded.push('retained_growth_bytes')
  }
  if (measurement.activeAfter > budget.max_active_after) exceeded.push('active_after')
  if (measurement.liveHandlesAfter !== 0) exceeded.push('live_handles_after')
  if (exceeded.length > 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_PERFORMANCE_BUDGET_EXCEEDED',
      `Policy performance promotion budget exceeded: ${exceeded.join(', ')}`,
      { exceeded, measurement: result },
    )
  }
  return result
}
