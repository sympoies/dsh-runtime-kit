const INTENT_PATTERN = /^[A-Za-z0-9._/-]+$/
const MAX_INTENT_BYTES = 128

// The first phase of each intent is its default and the one the automatic
// mutation prerequisite prepares; later phases resolve only on demand. An
// intent with no phases resolves its packaged documents without `--phase`.
export const RUNTIME_CONTEXT_INTENT_PHASES = Object.freeze({
  'project-dev': Object.freeze(['edit', 'delivery', 'review'] as const),
  devlog: Object.freeze([] as const),
  'external-facts': Object.freeze([] as const),
  'web-testing': Object.freeze([] as const),
  memory: Object.freeze([] as const),
  'upstream-contribution': Object.freeze([] as const),
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

/** The phase the automatic mutation prerequisite prepares for an intent. */
export function runtimeContextPrerequisitePhase(value: unknown): string {
  const phase = runtimeContextPhase(value)
  if (phase === undefined) {
    throw new TypeError('dsh-runtime-kit:runtime-context-prerequisite-phase-missing')
  }
  return phase
}
