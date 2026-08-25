// @ts-check

/** @typedef {'main_agent_mode' | 'review_specialists'} ChildPluginName */
/** @typedef {{state: 'pending' | 'active' | 'unloaded' | 'failed', reason?: 'activation-rejected' | 'lifecycle-failed', error_name?: string}} ChildPluginState */
/** @typedef {Record<ChildPluginName, ChildPluginState>} ChildPluginStatus */

const CHILD_PLUGIN_NAMES = /** @type {readonly ChildPluginName[]} */ (
  Object.freeze(['main_agent_mode', 'review_specialists'])
)

/** @returns {ChildPluginStatus} */
export function createChildPluginStatus() {
  return {
    main_agent_mode: { state: 'pending' },
    review_specialists: { state: 'pending' },
  }
}

/** @param {ReturnType<typeof createChildPluginStatus>} status */
export function snapshotChildPluginStatus(status) {
  return Object.freeze(Object.fromEntries(CHILD_PLUGIN_NAMES.map(name => [
    name,
    Object.freeze({ ...status[name] }),
  ])))
}

/**
 * Coalesce child lifecycle refreshes without losing a transition to an
 * already-active RuntimeHealth probe. If the epoch advances while a probe is
 * settling, force another probe until the latest state has been observed.
 *
 * @param {{probe: (capability: string, options: {force: true}) => Promise<unknown>}} health
 */
export function createChildHealthRefresh(health) {
  /** @type {Map<string, number>} */
  const epochs = new Map()
  /** @type {Map<string, Promise<void>>} */
  const active = new Map()

  /** @param {string} capability */
  return function refresh(capability) {
    epochs.set(capability, (epochs.get(capability) ?? 0) + 1)
    const current = active.get(capability)
    if (current !== undefined) return current
    const operation = (async () => {
      let observed
      do {
        observed = epochs.get(capability)
        try {
          await health.probe(capability, { force: true })
        } catch {
          // Health owns the typed failure snapshot. A newer epoch still gets
          // another attempt; a stable failed epoch needs no unhandled task.
        }
      } while (epochs.get(capability) !== observed)
    })()
    active.set(capability, operation)
    void operation.finally(() => {
      if (active.get(capability) === operation) active.delete(capability)
    })
    return operation
  }
}

/**
 * Project Cordis' public fiber lifecycle without retaining error text.
 * @param {{state?: unknown}} fiber
 * @returns {ChildPluginState}
 */
function projectFiberState(fiber) {
  if (fiber.state === 2) return { state: 'active' }
  if (fiber.state === 3) {
    return {
      state: 'failed',
      reason: 'lifecycle-failed',
      error_name: 'Error',
    }
  }
  if (fiber.state === 0 || fiber.state === 1) return { state: 'pending' }
  return { state: 'unloaded' }
}

/**
 * @param {ReturnType<typeof createChildPluginStatus>} status
 * @param {'main_agent_mode' | 'review_specialists'} name
 * @param {() => unknown | Promise<unknown>} activate
 * @param {{warn?: (...args: unknown[]) => void} | undefined} logger
 * @param {((name: 'main_agent_mode' | 'review_specialists', state: ChildPluginState) => void) | undefined} onTransition
 * @param {{effect?: (install: () => (() => void), name?: string) => unknown, on?: (name: string, listener: (...args: any[]) => void) => unknown} | undefined} lifecycleContext
 */
export function observeChildPluginActivation(
  status,
  name,
  activate,
  logger,
  onTransition,
  lifecycleContext,
) {
  if (!CHILD_PLUGIN_NAMES.includes(name) || status[name]?.state !== 'pending') {
    throw new TypeError('dsh-runtime-kit: child plugin status transition is invalid')
  }
  let active = true
  lifecycleContext?.effect?.(
    () => () => { active = false },
    `dsh-runtime-kit ${name.replaceAll('_', ' ')} lifecycle observer`,
  )
  void Promise.resolve()
    .then(activate)
    .then(fiber => {
      if (!active) return
      const candidate = fiber !== null && typeof fiber === 'object'
        ? /** @type {{state?: unknown}} */ (fiber)
        : undefined
      status[name] = candidate === undefined ? { state: 'active' } : projectFiberState(candidate)
      onTransition?.(name, status[name])
      if (candidate === undefined || typeof lifecycleContext?.on !== 'function') return
      lifecycleContext.on('internal/status', changed => {
        if (!active) return
        if (changed !== fiber) return
        const next = projectFiberState(candidate)
        if (JSON.stringify(status[name]) === JSON.stringify(next)) return
        status[name] = next
        onTransition?.(name, status[name])
      })
    }, error => {
      if (!active) return
      status[name] = {
        state: 'failed',
        reason: 'activation-rejected',
        error_name: error instanceof Error && error.name.length > 0 ? error.name : 'Error',
      }
      logger?.warn?.(
        `dsh-runtime-kit: ${name.replaceAll('_', ' ')} failed to activate: %s`,
        String(error?.stack ?? error),
      )
      onTransition?.(name, status[name])
    })
    .catch(error => {
      if (!active) return
      try {
        logger?.warn?.(
          `dsh-runtime-kit: ${name.replaceAll('_', ' ')} lifecycle observation failed: %s`,
          String(error?.stack ?? error),
        )
      } catch {
        // A diagnostic observer must not create an unhandled lifecycle task.
      }
    })
}
