// @ts-check

/**
 * Recognized lifecycle states for the upstream counterpart of a downstream
 * patch. `not-reported` is deliberate: the escalation policy allows a
 * downstream-only concern to live in a patch that must never be sent upstream,
 * and recording that decision keeps it distinguishable from an oversight.
 */
const STATES = new Set([
  'not-reported',
  'reported',
  'accepted',
  'merged',
  'declined',
  'stale',
])
const KEYS = new Set(['state', 'url', 'released_in'])

/** @param {unknown} value */
function publicUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Check a patch entry's optional `upstream_reference`. Returns `undefined` when
 * the field is absent or well formed, and otherwise a failure message the
 * caller raises as its own typed manifest error. Absence is always allowed, so
 * the field can never block patch check, apply, reverse, or acceptance.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function checkUpstreamReference(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'upstream reference must be an object'
  }
  const reference = /** @type {Record<string, unknown>} */ (value)
  if (Object.keys(reference).some(key => !KEYS.has(key))) {
    return 'upstream reference declares an unknown field'
  }
  if (typeof reference.state !== 'string' || !STATES.has(reference.state)) {
    return 'upstream reference state is invalid'
  }
  const reported = reference.state !== 'not-reported'
  if (reported !== (reference.url !== undefined)) {
    return reported
      ? 'upstream reference must record the public url it reports'
      : 'upstream reference must not record a url it has not reported'
  }
  if (reference.url !== undefined && !publicUrl(reference.url)) {
    return 'upstream reference url must be a public https url'
  }
  if (reference.released_in !== undefined
    && (reference.state !== 'merged'
      || typeof reference.released_in !== 'string'
      || reference.released_in.length === 0)) {
    return 'upstream reference released_in is invalid'
  }
  return undefined
}
