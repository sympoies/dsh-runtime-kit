// @ts-check

/** @typedef {'main_agent_mode' | 'review_specialists'} ChildPluginName */
/** @typedef {{state: 'pending' | 'active' | 'failed', reason?: 'activation-rejected', error_name?: string}} ChildPluginState */
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
 * @param {ReturnType<typeof createChildPluginStatus>} status
 * @param {'main_agent_mode' | 'review_specialists'} name
 * @param {() => unknown | Promise<unknown>} activate
 * @param {{warn?: (...args: unknown[]) => void} | undefined} logger
 */
export function observeChildPluginActivation(status, name, activate, logger) {
  if (!CHILD_PLUGIN_NAMES.includes(name) || status[name]?.state !== 'pending') {
    throw new TypeError('dsh-runtime-kit: child plugin status transition is invalid')
  }
  void Promise.resolve()
    .then(activate)
    .then(() => {
      status[name] = { state: 'active' }
    }, error => {
      status[name] = {
        state: 'failed',
        reason: 'activation-rejected',
        error_name: error instanceof Error && error.name.length > 0 ? error.name : 'Error',
      }
      logger?.warn?.(
        `dsh-runtime-kit: ${name.replaceAll('_', ' ')} failed to activate: %s`,
        String(error?.stack ?? error),
      )
    })
}
