export type Context = import('@deepseek-ai/cordis').Context

export type ChildPluginName = 'main_agent_mode' | 'review_specialists'
export type ChildPluginState = {state: 'pending' | 'active' | 'unloaded' | 'failed', reason?: 'activation-rejected' | 'lifecycle-failed', error_name?: string}
export type ChildPluginStatus = Record<ChildPluginName, ChildPluginState>

const CHILD_PLUGIN_NAMES = ((Object.freeze(['main_agent_mode', 'review_specialists'])) as readonly ChildPluginName[])

export function createChildPluginStatus(): ChildPluginStatus  {
  return {
    main_agent_mode: { state: 'pending' },
    review_specialists: { state: 'pending' },
  }
}

export function snapshotChildPluginStatus(status: ReturnType<typeof createChildPluginStatus>) {
  return Object.freeze(Object.fromEntries(CHILD_PLUGIN_NAMES.map(name => [
    name,
    Object.freeze({ ...status[name] }),
  ])))
}

/**
 * Coalesce child lifecycle refreshes without losing a transition to an
 * already-active RuntimeHealth probe. If the epoch advances while a probe is
 * settling, force another probe until the latest state has been observed.
 */

export function createChildHealthRefresh(health: {probe: (capability: string, options: {force: true}) => Promise<unknown>}) {
  const epochs: Map<string, number> = new Map()
  const active: Map<string, Promise<void>> = new Map()

  return function refresh(capability: string) {
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

/** Project Cordis' public fiber lifecycle without retaining error text. */

function projectFiberState(fiber: {state?: unknown}): ChildPluginState  {
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

export function observeChildPluginActivation(
  status: ReturnType<typeof createChildPluginStatus>,
  name: 'main_agent_mode' | 'review_specialists',
  activate: () => unknown | Promise<unknown>,
  logger: {warn?: (...args: unknown[]) => void} | undefined,
  onTransition: ((name: 'main_agent_mode' | 'review_specialists', state: ChildPluginState) => void) | undefined,
  lifecycleContext: Context | undefined,
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
        ? ((fiber) as {state?: unknown})
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
