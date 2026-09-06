export type Context = import('@deepseek-ai/cordis').Context
export type SubprocessHandle = import('@deepseek-ai/dsh-subprocess').SubprocessHandle

const MAX_CLI_OUTPUT_BYTES = 256 * 1024
const MAX_CLI_ERROR_BYTES = 8 * 1024
const DEFAULT_CLI_TIMEOUT_MS = 20_000
const MAX_CLI_TIMEOUT_MS = 120_000
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_TEARDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ACTIVE_CLI_CALLS = 4
const MAX_ACTIVE_CLI_CALLS = 16

function boundedMs(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

function boundedConcurrency(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_ACTIVE_CLI_CALLS)
    : DEFAULT_MAX_ACTIVE_CLI_CALLS
}

export type CliFailure = { ok: false, code: string, error?: Record<string, unknown> | undefined }

export type CliSuccess = { ok: true, envelope: Record<string, any>, exitCode: number }

export type CliResult = CliFailure | CliSuccess

function failure(code: string, error?: Record<string, unknown>): CliFailure  {
  return { ok: false, code: `dsh-runtime-kit:${code}`, error }
}

/**
 * One bounded, cancellation-aware runner for released nils CLI verbs
 * (`main-agent`, `agent-session`). It mirrors the policy transport's
 * subprocess conventions: fixed argv vectors, bounded stdio, an owned
 * deadline that terminates the child, and a whole-tree quiescence check that
 * permanently closes admission when a survivor cannot be ruled out.
 */

export function createCliClient(ctx: Context, config: { cliTimeoutMs?: number, cliTeardownTimeoutMs?: number, maxActiveCliCalls?: number } = {}) {
  const timeoutMs = boundedMs(config.cliTimeoutMs, DEFAULT_CLI_TIMEOUT_MS, MAX_CLI_TIMEOUT_MS)
  const teardownTimeoutMs = boundedMs(
    config.cliTeardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    MAX_TEARDOWN_TIMEOUT_MS,
  )
  const maxActive = boundedConcurrency(config.maxActiveCliCalls)
  const active: Set<AbortController> = new Set()
  let open = true
  let degraded = false

  async function boundedQuiescence(handle: SubprocessHandle) {
    const controller = new AbortController()
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
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
 * `env` entries are layered onto the provider's scrubbed base, so a caller
 * that needs the CLI to authenticate as a specific principal passes that
 * principal's environment explicitly instead of relying on ambient state.
 */

    async run(argv: readonly string[], options: {
    cwd: string,
    signal?: AbortSignal,
    stdinData?: string,
    timeoutMs?: number,
    env?: Readonly<Record<string, string>>,
  }): Promise<CliResult>  {
      if (!open || degraded) return failure(degraded ? 'cli-unavailable' : 'cli-disposed')
      if (options.signal?.aborted) return failure('cli-caller-aborted')
      if (active.size >= maxActive) return failure('cli-overloaded')
      const controller = new AbortController()
      active.add(controller)
      const onCallerAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onCallerAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let handle: SubprocessHandle
      try {
        try {
          handle = ctx.subprocess.spawn({
            argv: [...argv],
            cwd: options.cwd,
            ...options.env === undefined ? {} : { env: { ...options.env } },
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
        let onDeadline: () => void = () => {}
        const deadline = new Promise<undefined>(resolve => { onDeadline = () => resolve(undefined) })
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
