// @ts-check

const INTENT_PATTERN = /^[A-Za-z0-9._/-]+$/
const MAX_INTENT_BYTES = 128

export const RUNTIME_CONTEXT_INTENT_PHASES = Object.freeze({
  'project-dev': 'edit',
})

export const RUNTIME_CONTEXT_INTENTS = Object.freeze(
  Object.keys(RUNTIME_CONTEXT_INTENT_PHASES),
)

/** @param {unknown} value */
export function normalizeRuntimeContextIntent(value) {
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
  return /** @type {keyof typeof RUNTIME_CONTEXT_INTENT_PHASES} */ (intent)
}

/** @param {unknown} value */
export function runtimeContextPhase(value) {
  return RUNTIME_CONTEXT_INTENT_PHASES[normalizeRuntimeContextIntent(value)]
}
