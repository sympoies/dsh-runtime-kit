// @ts-check

import { createHash } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'

export const HEALTH_SNAPSHOT_SCHEMA = 'dsh-runtime-kit.health-snapshot.v1'

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const OWNER_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z][a-z0-9._-]*)$/u
const CODE_PATTERN = /^DSH_RUNTIME_HEALTH_[A-Z0-9_]{1,96}$/u
const STABLE_STATES = new Set(['ready', 'degraded', 'blocked'])
const ALL_STATES = new Set([...STABLE_STATES, 'recovering'])
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000
const MAX_TIMEOUT_MS = 60_000

/** @typedef {'ready' | 'degraded' | 'blocked' | 'recovering'} HealthState */
/**
 * @typedef HealthSnapshot
 * @property {typeof HEALTH_SNAPSHOT_SCHEMA} schema_version
 * @property {string} capability
 * @property {string} owner
 * @property {string} scope
 * @property {number} generation
 * @property {HealthState} state
 * @property {string} code
 * @property {number} observed_at
 */
/**
 * @typedef HealthProvider
 * @property {string} capability
 * @property {string} owner
 * @property {(input: {scope: string, signal: AbortSignal}) => Promise<{state: 'ready' | 'degraded' | 'blocked', code: string}> | {state: 'ready' | 'degraded' | 'blocked', code: string}} probe
 */

/** Machine-readable admission error whose message never includes provider output. */
export class RuntimeHealthError extends Error {
  /** @param {string} code @param {string} message @param {HealthSnapshot} snapshot */
  constructor(code, message, snapshot) {
    super(message)
    this.name = 'RuntimeHealthError'
    this.code = code
    this.snapshot = snapshot
  }
}

/** @param {unknown} value @param {string} field @param {number} fallback */
function boundedTimeout(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0
    || /** @type {number} */ (value) > MAX_TIMEOUT_MS) {
    throw new TypeError(`dsh-runtime-kit: ${field} must be a positive integer no greater than ${MAX_TIMEOUT_MS}`)
  }
  return /** @type {number} */ (value)
}

/** @param {unknown} value @param {string} field @param {RegExp} pattern */
function boundedIdentity(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`dsh-runtime-kit: ${field} is invalid`)
  }
  return value
}

/** @param {string} scope */
function publicScope(scope) {
  return scope === 'runtime'
    ? scope
    : `sha256:${createHash('sha256').update(scope).digest('hex')}`
}

/** @param {HealthSnapshot} value */
function frozenSnapshot(value) {
  return Object.freeze({ ...value })
}

/**
 * Validate the package-owned health transition protocol.
 * @param {HealthSnapshot} previous
 * @param {HealthSnapshot} next
 */
export function validateHealthTransition(previous, next) {
  if (previous.schema_version !== HEALTH_SNAPSHOT_SCHEMA
    || next.schema_version !== HEALTH_SNAPSHOT_SCHEMA
    || previous.capability !== next.capability
    || previous.scope !== next.scope) {
    throw new Error('dsh-runtime-kit health transition identity changed')
  }
  if (previous.owner !== next.owner) {
    throw new Error('dsh-runtime-kit health transition owner changed')
  }
  if (next.generation !== previous.generation + 1) {
    throw new Error('dsh-runtime-kit health transition generation is not consecutive')
  }
  if (!ALL_STATES.has(previous.state) || !ALL_STATES.has(next.state)) {
    throw new Error('dsh-runtime-kit health transition state is invalid')
  }
  const allowed = previous.state === 'recovering'
    ? STABLE_STATES.has(next.state)
    : next.state === 'recovering'
  if (!allowed) throw new Error('dsh-runtime-kit health state transition is invalid')
  if (!CODE_PATTERN.test(next.code)
    || !Number.isSafeInteger(next.observed_at)
    || next.observed_at < 0) {
    throw new Error('dsh-runtime-kit health transition projection is invalid')
  }
}

/** @param {AbortSignal | undefined} signal */
function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('dsh-runtime-kit health probe aborted')
}

/** @param {Promise<unknown>} promise @param {number} timeoutMs */
async function boundedDrain(promise, timeoutMs) {
  let timer
  try {
    await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Native host health registry, projection, probe scheduler, and admission API. */
export class RuntimeHealth extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{now?: () => number, probeTimeoutMs?: number, disposeTimeoutMs?: number}} [config]
   */
  constructor(ctx, config = {}) {
    super(ctx, 'dshRuntimeHealth')
    this.now = typeof config.now === 'function' ? config.now : Date.now
    this.probeTimeoutMs = boundedTimeout(
      config.probeTimeoutMs,
      'health probeTimeoutMs',
      DEFAULT_PROBE_TIMEOUT_MS,
    )
    this.disposeTimeoutMs = boundedTimeout(
      config.disposeTimeoutMs,
      'health disposeTimeoutMs',
      DEFAULT_DISPOSE_TIMEOUT_MS,
    )
    /** @type {Map<string, HealthProvider>} */
    this.providers = new Map()
    /** @type {Map<string, HealthSnapshot>} */
    this.records = new Map()
    /** @type {Map<string, {controller: AbortController, waiters: Set<symbol>, promise: Promise<HealthSnapshot>, raw: Promise<unknown>, previous: HealthSnapshot}>} */
    this.active = new Map()
    /** @type {Set<Promise<unknown>>} */
    this.draining = new Set()
    /** @type {Set<(transition: {previous: HealthSnapshot, next: HealthSnapshot}) => void>} */
    this.observers = new Set()
    this.disposed = false

    ctx.effect(() => async () => {
      if (this.disposed) return
      this.disposed = true
      const active = [...this.active.values()]
      for (const operation of active) {
        operation.controller.abort(new RuntimeHealthError(
          'DSH_RUNTIME_HEALTH_DISPOSED',
          'runtime health service was disposed',
          operation.previous,
        ))
      }
      const pending = new Set([
        ...this.draining,
        ...active.flatMap(operation => [operation.promise, operation.raw]),
      ])
      await boundedDrain(Promise.allSettled([...pending]), this.disposeTimeoutMs)
      this.active.clear()
      this.providers.clear()
      this.records.clear()
      this.observers.clear()
    }, 'dsh-runtime-kit health service')
  }

  /** @param {string} capability @param {string} scope */
  key(capability, scope) {
    return `${capability}\0${scope}`
  }

  /** @param {string} capability @param {string} scope */
  initial(capability, scope) {
    const provider = this.providers.get(capability)
    if (provider === undefined) {
      throw new RuntimeHealthError(
        'DSH_RUNTIME_HEALTH_CAPABILITY_UNKNOWN',
        'runtime health capability is not registered',
        frozenSnapshot({
          schema_version: HEALTH_SNAPSHOT_SCHEMA,
          capability,
          owner: 'unregistered',
          scope: publicScope(scope),
          generation: 0,
          state: 'blocked',
          code: 'DSH_RUNTIME_HEALTH_CAPABILITY_UNKNOWN',
          observed_at: Math.max(0, Math.floor(this.now())),
        }),
      )
    }
    return frozenSnapshot({
      schema_version: HEALTH_SNAPSHOT_SCHEMA,
      capability,
      owner: provider.owner,
      scope: publicScope(scope),
      generation: 0,
      state: 'blocked',
      code: 'DSH_RUNTIME_HEALTH_UNPROBED',
      observed_at: Math.max(0, Math.floor(this.now())),
    })
  }

  /** @param {string} key @param {HealthSnapshot} previous @param {HealthState} state @param {string} code */
  transition(key, previous, state, code) {
    const next = frozenSnapshot({
      ...previous,
      generation: previous.generation + 1,
      state,
      code,
      observed_at: Math.max(0, Math.floor(this.now())),
    })
    validateHealthTransition(previous, next)
    this.records.set(key, next)
    const notification = Object.freeze({ previous, next })
    for (const observer of [...this.observers]) {
      try {
        observer(notification)
      } catch {
        try { this.ctx.logger?.warn?.('dsh-runtime-kit: a runtime health observer failed') } catch {}
      }
    }
    return next
  }

  /**
   * Reserve one package-owned capability.
   * @param {HealthProvider} provider
   */
  register(provider) {
    if (this.disposed) throw new Error('dsh-runtime-kit: health service is disposed')
    const capability = boundedIdentity(provider?.capability, 'health capability', CAPABILITY_PATTERN)
    const owner = boundedIdentity(provider?.owner, 'health owner', OWNER_PATTERN)
    if (typeof provider?.probe !== 'function') {
      throw new TypeError('dsh-runtime-kit: health provider probe is required')
    }
    if (this.providers.has(capability)) {
      throw new Error(`dsh-runtime-kit: health capability ${JSON.stringify(capability)} is already registered`)
    }
    const retained = Object.freeze({ capability, owner, probe: provider.probe })
    this.providers.set(capability, retained)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.providers.get(capability) !== retained) return
      this.providers.delete(capability)
      for (const [key, operation] of this.active) {
        if (!key.startsWith(`${capability}\0`)) continue
        // Retire the operation's authority before aborting it. Otherwise its
        // rejection handler can restore a stale snapshot after this provider
        // has already been removed or replaced.
        this.active.delete(key)
        operation.controller.abort(new RuntimeHealthError(
          'DSH_RUNTIME_HEALTH_PROVIDER_REMOVED',
          'runtime health provider was removed',
          operation.previous,
        ))
      }
      for (const key of [...this.records.keys()]) {
        if (key.startsWith(`${capability}\0`)) this.records.delete(key)
      }
    }
  }

  /** @param {(transition: {previous: HealthSnapshot, next: HealthSnapshot}) => void} observer */
  observe(observer) {
    if (typeof observer !== 'function') throw new TypeError('dsh-runtime-kit: health observer is invalid')
    this.observers.add(observer)
    return () => { this.observers.delete(observer) }
  }

  /** @param {string} capability @param {string} [scope] */
  snapshot(capability, scope = 'runtime') {
    boundedIdentity(capability, 'health capability', CAPABILITY_PATTERN)
    if (typeof scope !== 'string' || scope.length === 0 || scope.includes('\0')) {
      throw new TypeError('dsh-runtime-kit: health scope is invalid')
    }
    const key = this.key(capability, scope)
    const current = this.records.get(key)
    if (current !== undefined) return current
    const initial = this.initial(capability, scope)
    this.records.set(key, initial)
    return initial
  }

  /** @param {string} capability @param {{scope?: string, signal?: AbortSignal, force?: boolean}} [options] */
  probe(capability, options = {}) {
    if (this.disposed) return Promise.reject(new Error('dsh-runtime-kit health service disposed'))
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal))
    const scope = options.scope ?? 'runtime'
    const previous = this.snapshot(capability, scope)
    const key = this.key(capability, scope)
    const existing = this.active.get(key)
    if (existing !== undefined) return this.waiter(existing, options.signal)
    if (previous.state === 'ready' && options.force !== true) return Promise.resolve(previous)
    const provider = this.providers.get(capability)
    if (provider === undefined) return Promise.reject(new Error('dsh-runtime-kit health provider disappeared'))

    const recovering = this.transition(
      key,
      previous,
      'recovering',
      'DSH_RUNTIME_HEALTH_PROBING',
    )
    const controller = new AbortController()
    let timeout
    let raw = /** @type {Promise<unknown>} */ (Promise.resolve())
    /** @type {{controller: AbortController, waiters: Set<symbol>, promise: Promise<HealthSnapshot>, raw: Promise<unknown>, previous: HealthSnapshot}} */
    const operation = {
      controller,
      waiters: new Set(),
      previous,
      raw,
      promise: /** @type {any} */ (undefined),
    }
    const abort = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true })
    })
    raw = Promise.resolve().then(() => provider.probe({ scope, signal: controller.signal }))
    // Always observe late rejection even when the abort race has already settled.
    this.draining.add(raw)
    void raw.then(
      () => { this.draining.delete(raw) },
      () => { this.draining.delete(raw) },
    )
    operation.raw = raw
    timeout = setTimeout(() => {
      controller.abort(new RuntimeHealthError(
        'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT',
        'runtime health probe exceeded its deadline',
        recovering,
      ))
    }, this.probeTimeoutMs)
    operation.promise = Promise.race([raw, abort])
      .then(result => {
        if (this.active.get(key) !== operation || this.disposed) return previous
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('health provider result is not an object')
        }
        const state = /** @type {{state?: unknown}} */ (result).state
        const code = /** @type {{code?: unknown}} */ (result).code
        if (!STABLE_STATES.has(/** @type {string} */ (state))
          || typeof code !== 'string' || !CODE_PATTERN.test(code)) {
          throw new Error('health provider result is invalid')
        }
        return this.transition(key, recovering, /** @type {'ready' | 'degraded' | 'blocked'} */ (state), code)
      })
      .catch(error => {
        if (this.active.get(key) !== operation || this.disposed) throw error
        const reason = controller.signal.reason
        if (controller.signal.aborted
          && !(reason instanceof RuntimeHealthError
            && reason.code === 'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT')) {
          this.transition(key, recovering, previous.state, previous.code)
          throw error
        }
        const code = reason instanceof RuntimeHealthError
          && reason.code === 'DSH_RUNTIME_HEALTH_PROBE_TIMEOUT'
          ? reason.code
          : 'DSH_RUNTIME_HEALTH_PROBE_FAILED'
        return this.transition(key, recovering, 'blocked', code)
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.active.get(key) === operation) this.active.delete(key)
      })
    this.active.set(key, operation)
    return this.waiter(operation, options.signal)
  }

  /**
   * @param {{controller: AbortController, waiters: Set<symbol>, promise: Promise<HealthSnapshot>}} operation
   * @param {AbortSignal | undefined} signal
   */
  waiter(operation, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const token = Symbol('health-waiter')
    operation.waiters.add(token)
    return new Promise((resolve, reject) => {
      let settled = false
      const release = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        operation.waiters.delete(token)
      }
      const onAbort = () => {
        release()
        reject(abortReason(signal))
        if (operation.waiters.size === 0) operation.controller.abort(abortReason(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      operation.promise.then(
        value => { release(); resolve(value) },
        error => { release(); reject(error) },
      )
    })
  }

  /** @param {string} capability @param {{scope?: string, signal?: AbortSignal, allowDegraded?: boolean, force?: boolean}} [options] */
  async require(capability, options = {}) {
    const scope = options.scope ?? 'runtime'
    let snapshot = this.snapshot(capability, scope)
    if (options.force === true
      || snapshot.code === 'DSH_RUNTIME_HEALTH_UNPROBED'
      || snapshot.state === 'recovering') {
      snapshot = await this.probe(capability, {
        scope,
        signal: options.signal,
        force: options.force,
      })
    }
    if (snapshot.state === 'ready' || (snapshot.state === 'degraded' && options.allowDegraded === true)) {
      return snapshot
    }
    throw new RuntimeHealthError(
      snapshot.code,
      'required runtime capability is not ready',
      snapshot,
    )
  }
}

/**
 * Register package-owned health transition invariants with DSH's public registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function installRuntimeHealthInvariant(ctx) {
  const invariants = /** @type {{register?: (name: string, installer: unknown) => () => void} | undefined} */ (
    ctx.get('invariants')
  )
  if (invariants === undefined || typeof invariants.register !== 'function') {
    throw new TypeError('dsh-runtime-kit: DSH invariant registry is required')
  }
  /** @param {import('@deepseek-ai/cordis').Context} child @param {(message: string) => never} fail */
  const installer = (child, fail) => {
    const health = /** @type {RuntimeHealth} */ (child.get('dshRuntimeHealth'))
    child.effect(() => health.observe(
        /** @param {{previous: HealthSnapshot, next: HealthSnapshot}} transition */
        ({ previous, next }) => {
          try {
            validateHealthTransition(previous, next)
          } catch (error) {
            fail(error instanceof Error ? error.message : 'health transition is invalid')
          }
        },
      ),
    '@sympoies/dsh-runtime-kit health invariant')
  }
  installer.inject = ['dshRuntimeHealth']
  return invariants.register('@sympoies/dsh-runtime-kit', installer)
}

/** @param {unknown} input @param {string} field */
function requirements(input, field) {
  if (!Array.isArray(input)) throw new TypeError(`dsh-runtime-kit: ${field} must be an array`)
  const seen = new Set()
  return Object.freeze(input.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`dsh-runtime-kit: ${field} entry is invalid`)
    }
    const value = /** @type {{capability?: unknown, scope?: unknown, allowDegraded?: unknown}} */ (candidate)
    const capability = boundedIdentity(value.capability, `${field} capability`, CAPABILITY_PATTERN)
    const scope = value.scope
    if (!['runtime', 'project'].includes(/** @type {string} */ (scope))) {
      throw new TypeError(`dsh-runtime-kit: ${field} scope is invalid`)
    }
    if (value.allowDegraded !== undefined && typeof value.allowDegraded !== 'boolean') {
      throw new TypeError(`dsh-runtime-kit: ${field} allowDegraded is invalid`)
    }
    const identity = `${capability}\0${scope}`
    if (seen.has(identity)) throw new TypeError(`dsh-runtime-kit: ${field} contains a duplicate`)
    seen.add(identity)
    return Object.freeze({
      capability,
      scope: /** @type {'runtime' | 'project'} */ (scope),
      allowDegraded: value.allowDegraded === true,
    })
  }))
}

/** @param {unknown} value */
function projectScope(value) {
  const cwd = /** @type {{header?: {cwd?: unknown}}} */ (value)?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\0') ? cwd : undefined
}

/** @param {RuntimeHealth} health @param {ReturnType<typeof requirements>} selected @param {unknown} session @param {AbortSignal | undefined} signal @param {boolean} [refreshProject] */
async function admit(health, selected, session, signal, refreshProject = false) {
  for (const requirement of selected) {
    const scope = requirement.scope === 'runtime' ? 'runtime' : projectScope(session)
    if (scope === undefined) {
      throw new Error('DSH_RUNTIME_HEALTH_SCOPE_UNAVAILABLE')
    }
    await health.require(requirement.capability, {
      scope,
      signal,
      allowDegraded: requirement.allowDegraded,
      force: refreshProject && requirement.scope === 'project',
    })
  }
}

/**
 * Install model-hidden health admission on DSH's native pre-waterfall model
 * guard and monotonic post-waterfall tool guard.
 * @param {{llm: {guard: (guard: (options: any) => Promise<string | undefined>) => () => void}, sessions: {get: (id: string) => unknown}, tools: {guard: (guard: (exec: any) => string | undefined) => () => void}}} ctx
 * @param {RuntimeHealth} health
 * @param {{sessionRequirements?: unknown[], toolRequirements?: Record<string, unknown[]>}} [config]
 */
export function installRuntimeHealthAdmission(ctx, health, config = {}) {
  if (health === undefined || typeof health.require !== 'function') {
    throw new TypeError('dsh-runtime-kit: runtime health service is required for admission')
  }
  const sessionRequirements = requirements(
    config.sessionRequirements ?? [],
    'session health requirements',
  )
  const rawToolRequirements = config.toolRequirements ?? {}
  if (rawToolRequirements === null || typeof rawToolRequirements !== 'object'
    || Array.isArray(rawToolRequirements)) {
    throw new TypeError('dsh-runtime-kit: tool health requirements must be an object')
  }
  const toolRequirements = new Map()
  for (const [tool, selected] of Object.entries(rawToolRequirements)) {
    boundedIdentity(tool, 'health-dependent tool', CAPABILITY_PATTERN)
    toolRequirements.set(tool, requirements(selected, `tool ${tool} health requirements`))
  }

  /** @param {any} options */
  const modelGuard = async (options) => {
    if (options?.sessionId === undefined) return undefined
    const session = ctx.sessions.get(options.sessionId)
    if (session === undefined) return 'DSH_RUNTIME_HEALTH_SCOPE_UNAVAILABLE'
    try {
      await admit(health, sessionRequirements, session, options?.signal, true)
      return undefined
    } catch (error) {
      return error instanceof RuntimeHealthError
        ? error.code
        : 'DSH_RUNTIME_HEALTH_SCOPE_UNAVAILABLE'
    }
  }
  /** @param {any} exec */
  const toolGuard = (exec) => {
    const selected = toolRequirements.get(exec?.name)
    if (selected === undefined) return undefined
    for (const requirement of selected) {
      if (requirement.scope !== 'runtime') {
        return 'DSH_RUNTIME_HEALTH_SCOPE_UNAVAILABLE'
      }
      const snapshot = health.snapshot(requirement.capability)
      if (snapshot.state === 'ready'
        || (snapshot.state === 'degraded' && requirement.allowDegraded)) continue
      return snapshot.code
    }
    return undefined
  }
  /** @type {Array<() => void>} */
  const disposers = []
  try {
    disposers.push(ctx.llm.guard(modelGuard))
    disposers.push(ctx.tools.guard(toolGuard))
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    let failure
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}
