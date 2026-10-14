const INTENT_PATTERN = /^[A-Za-z0-9._/-]+$/
const MAX_INTENT_BYTES = 128

// The first phase of each intent is its default; an intent with no phases
// resolves its packaged documents without a phase.
export const RUNTIME_CONTEXT_INTENT_PHASES = Object.freeze({
  'project-dev': Object.freeze(['edit', 'delivery', 'review'] as const),
  devlog: Object.freeze([] as const),
  'external-facts': Object.freeze([] as const),
  'web-testing': Object.freeze([] as const),
  memory: Object.freeze([] as const),
  'upstream-contribution': Object.freeze([] as const),
  'peer-coordination': Object.freeze([] as const),
})

/**
 * Packaged home documents, in delivery order, for each intent and phase. The
 * documents ship in the activated, digest-verified docs home; the packaged
 * catalog must route exactly these entries (test/context.test.ts).
 */
export const RUNTIME_CONTEXT_DOCUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'project-dev:edit': Object.freeze(['PROJECT_DEV_EDIT.md']),
  'project-dev:delivery': Object.freeze(['WORK_MODES.md', 'GIT_DELIVERY.md']),
  'project-dev:review': Object.freeze(['REVIEW_CONVERGENCE.md', 'EVIDENCE.md']),
  devlog: Object.freeze(['DEVLOG.md']),
  'external-facts': Object.freeze(['EXTERNAL_FACTS.md']),
  'web-testing': Object.freeze(['BROWSER_TESTING.md']),
  memory: Object.freeze(['MEMORY.md']),
  'upstream-contribution': Object.freeze(['UPSTREAM_CONTRIBUTION.md']),
  'peer-coordination': Object.freeze(['PEER_COORDINATION.md']),
})

export const RUNTIME_CONTEXT_PHASES = Object.freeze(
  [...new Set(Object.values(RUNTIME_CONTEXT_INTENT_PHASES).flat())],
)

export const RUNTIME_CONTEXT_INTENTS = Object.freeze(
  Object.keys(RUNTIME_CONTEXT_INTENT_PHASES),
)

export function normalizeRuntimeContextIntent(value: unknown) {
  if (typeof value !== 'string') {
    throw new TypeError('runtime_context intent must be a string')
  }
  const intent = value.trim()
  if (intent.length === 0
    || Buffer.byteLength(intent, 'utf8') > MAX_INTENT_BYTES
    || !INTENT_PATTERN.test(intent)) {
    throw new TypeError('runtime_context intent must be a bounded policy identifier')
  }
  if (!Object.hasOwn(RUNTIME_CONTEXT_INTENT_PHASES, intent)) {
    throw new TypeError('dsh-runtime-kit:runtime-context-intent-not-allowed')
  }
  return ((intent) as keyof typeof RUNTIME_CONTEXT_INTENT_PHASES)
}

export function runtimeContextPhase(value: unknown, phase?: unknown): string | undefined {
  const phases: readonly string[] = RUNTIME_CONTEXT_INTENT_PHASES[normalizeRuntimeContextIntent(value)]
  if (phase === undefined) return phases[0]
  if (typeof phase !== 'string' || !phases.includes(phase)) {
    throw new TypeError('dsh-runtime-kit:runtime-context-phase-not-allowed')
  }
  return phase
}
