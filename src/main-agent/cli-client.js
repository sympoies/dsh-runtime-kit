// @ts-check

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */

const MAX_CLI_OUTPUT_BYTES = 256 * 1024
const MAX_CLI_ERROR_BYTES = 8 * 1024
const DEFAULT_CLI_TIMEOUT_MS = 20_000
const MAX_CLI_TIMEOUT_MS = 120_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE_CLI_CALLS = 4
const MAX_ACTIVE_CLI_CALLS = 16

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function boundedMs(value, fallback, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

/** @param {unknown} value */
function boundedConcurrency(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_ACTIVE_CLI_CALLS)
    : DEFAULT_MAX_ACTIVE_CLI_CALLS
}

/**
 * @typedef CliFailure
 * @property {false} ok
 * @property {string} code
 * @property {Record<string, unknown> | undefined} [error]
 */

/**
 * @typedef CliSuccess
 * @property {true} ok
 * @property {Record<string, any>} envelope
 * @property {number} exitCode
 */

/** @typedef {CliFailure | CliSuccess} CliResult */

/** @param {string} code @param {Record<string, unknown>} [error] @returns {CliFailure} */
function failure(code, error) {
  return { ok: false, code: `dsh-runtime-kit:${code}`, error }
}

/**
 * One bounded, cancellation-aware runner for released nils CLI verbs
 * (`main-agent`, `agent-session`). It mirrors the policy transport's
 * subprocess conventions: fixed argv vectors, bounded stdio, an owned
 * deadline that terminates the child, and a whole-tree quiescence check that
 * permanently closes admission when a survivor cannot be ruled out.
 *
 * @param {Context} ctx
 * @param {{ cliTimeoutMs?: number, cliTeardownTimeoutMs?: number, maxActiveCliCalls?: number }} [config]
 */
export function createCliClient(ctx, config = {}) {
  const timeoutMs = boundedMs(config.cliTimeoutMs, DEFAULT_CLI_TIMEOUT_MS, MAX_CLI_TIMEOUT_MS)
  const teardownTimeoutMs = boundedMs(
    config.cliTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    MAX_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = boundedConcurrency(config.maxActiveCliCalls)
  /** @type {Set<AbortController>} */
  const active = new Set()
  let open = true
  let degraded = false

  /** @param {SubprocessHandle} handle */
  async function boundedQuiescence(handle) {
    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadlineTimer
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimeout(() => {
        controller.abort(new Error('dsh-runtime-kit main-agent CLI teardown deadline exceeded'))
        try { handle.terminate() } catch {}
        resolve(false)
      }, teardownTimeoutMs)
    })
    const observed = Promise.resolve()
      .then(() => handle.waitForExit(controller.signal))
      .then(value => value === true, () => false)
    try {
      return await Promise.race([observed, deadline])
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    }
  }

  ctx.effect(() => () => {
    open = false
    for (const controller of active) {
      controller.abort(new Error('dsh-runtime-kit main-agent CLI client disposed'))
    }
  }, 'dsh-runtime-kit main-agent cli client')

  return Object.freeze({
    get degraded() { return degraded },
    get active() { return active.size },
    timeoutMs,

    /**
     * Run one CLI invocation to completion and parse its single JSON
     * envelope. Non-zero exits still parse: typed CLI errors surface as
     * `{ok: true, envelope: {ok: false, error}}` so callers branch on the
     * envelope, not the exit code alone.
     *
     * @param {readonly string[]} argv
     * @param {{ cwd: string, signal?: AbortSignal, stdinData?: string, timeoutMs?: number }} options
     * @returns {Promise<CliResult>}
     */
    async run(argv, options) {
      if (!open || degraded) return failure(degraded ? 'cli-unavailable' : 'cli-disposed')
      if (options.signal?.aborted) return failure('cli-caller-aborted')
      if (active.size >= maxActive) return failure('cli-overloaded')
      const controller = new AbortController()
      active.add(controller)
      const onCallerAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onCallerAbort, { once: true })
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      /** @type {SubprocessHandle} */
      let handle
      try {
        try {
          handle = ctx.subprocess.spawn({
            argv: [...argv],
            cwd: options.cwd,
            stdio: {
              stdin: options.stdinData === undefined ? 'ignore' : { data: options.stdinData },
              stdout: { maxBytes: MAX_CLI_OUTPUT_BYTES },
              stderr: { maxBytes: MAX_CLI_ERROR_BYTES },
            },
            graceMs: 1_000,
            signal: controller.signal,
          })
        } catch {
          return failure('cli-unavailable')
        }
        /** @type {() => void} */
        let onDeadline = () => {}
        const deadline = new Promise(resolve => { onDeadline = () => resolve(undefined) })
        timer = setTimeout(() => {
          controller.abort(new Error('dsh-runtime-kit main-agent CLI deadline exceeded'))
          try { handle.terminate() } catch {}
          onDeadline()
        }, boundedMs(options.timeoutMs, timeoutMs, MAX_CLI_TIMEOUT_MS))

        // The deadline races completion so a wedged child cannot pin this
        // call; quiescence below still bounds the process tree either way.
        const outcome = await Promise.race([
          Promise.resolve(handle.done).then(value => value, () => undefined),
          deadline,
        ])
        const quiescent = await boundedQuiescence(handle)
        if (!quiescent) {
          degraded = true
          return failure('cli-unavailable')
        }
        if (options.signal?.aborted) return failure('cli-caller-aborted')
        if (outcome === undefined || outcome.signal !== null) {
          return failure('cli-unavailable')
        }
        const stdout = handle.collected.stdout?.readFrom(0)
        if (stdout === undefined || stdout.lossy) return failure('cli-output-invalid')
        let envelope
        try {
          envelope = JSON.parse(stdout.text)
        } catch {
          return failure('cli-output-invalid')
        }
        if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
          return failure('cli-output-invalid')
        }
        return { ok: true, envelope, exitCode: outcome.exitCode ?? -1 }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onCallerAbort)
        active.delete(controller)
      }
    },
  })
}
