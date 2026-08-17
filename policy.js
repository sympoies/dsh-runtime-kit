import { createHash } from 'node:crypto'

const MAX_POLICY_OUTPUT_BYTES = 64 * 1024
const MAX_POLICY_ERROR_BYTES = 8 * 1024
const MAX_POLICY_INPUT_BYTES = 1024 * 1024
const DEFAULT_POLICY_TIMEOUT_MS = 5_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * Minimal native-tool probe used to prove the external-bundle seam before the
 * legacy runtime policies are migrated. It intentionally has no DSH package
 * imports: the host owns the tools service and passes that public capability
 * through Cordis.
 */
function createPlusOneTool(onExecute = () => {}) {
  return Object.freeze({
  name: 'runtime_kit_plus_one',
  description: 'Add exactly one to an integer.',
  parameters: {
    type: 'object',
    properties: {
      value: {
        type: 'integer',
        description: 'The integer to increment.',
      },
    },
    required: ['value'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'integer' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError('runtime_kit_plus_one expects an argument object')
    }
    const keys = Object.keys(args)
    if (keys.length !== 1 || keys[0] !== 'value' || !Number.isSafeInteger(args.value)) {
      throw new TypeError('runtime_kit_plus_one expects exactly one safe integer named value')
    }
    onExecute()
    return args.value + 1
  },
  })
}

export const plusOneTool = createPlusOneTool()

function denial(reason) {
  return { kind: 'deny', reason: `dsh-runtime-kit:${reason}` }
}

function policyReason(decision) {
  const codes = Array.isArray(decision.reasons)
    ? decision.reasons
      .map(reason => reason?.code)
      .filter(code => typeof code === 'string' && code.length > 0)
    : []
  return codes.length > 0 ? `agent-hook:${codes.join(',')}` : 'agent-hook:blocked'
}

function jsonStringBytes(value, remaining) {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09
      || unit === 0x0a || unit === 0x0c || unit === 0x0d) {
      bytes += 2
    } else if (unit < 0x20) {
      bytes += 6
    } else if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
    if (bytes > remaining) return bytes
  }
  return bytes
}

function boundedJsonBytes(value, limit, seen = new WeakSet()) {
  if (value === null) return 4
  if (typeof value === 'string') return jsonStringBytes(value, limit)
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4
  if (typeof value !== 'object' || seen.has(value)) return limit + 1

  seen.add(value)
  let bytes = 2
  const array = Array.isArray(value)
  const entries = array
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)
  for (let index = 0; index < entries.length; index += 1) {
    const [key, item] = entries[index]
    if (index > 0) bytes += 1
    if (!array) bytes += jsonStringBytes(key, limit - bytes) + 1
    bytes += boundedJsonBytes(item, limit - bytes, seen)
    if (bytes > limit) break
  }
  seen.delete(value)
  return bytes
}

function validReason(reason) {
  return reason !== null
    && typeof reason === 'object'
    && typeof reason.rule_id === 'string'
    && reason.rule_id.length > 0
    && typeof reason.code === 'string'
    && reason.code.length > 0
    && typeof reason.disposition === 'string'
    && reason.disposition.length > 0
}

function validShadow(observation) {
  return observation !== null
    && typeof observation === 'object'
    && typeof observation.rule_id === 'string'
    && observation.rule_id.length > 0
    && ['allow', 'warn', 'context', 'transform', 'block'].includes(observation.action)
    && typeof observation.code === 'string'
    && observation.code.length > 0
}

function validDecision(decision, expectedRequestId) {
  return decision !== null
    && typeof decision === 'object'
    && decision.schema_version === 'agent-hook.normalized-decision.v1'
    && typeof decision.request_id === 'string'
    && decision.request_id === expectedRequestId
    && decision.product === 'dsh'
    && decision.event === 'PreToolUse'
    && ['allow', 'block'].includes(decision.action)
    && Array.isArray(decision.reasons)
    && decision.reasons.every(validReason)
    && (decision.action !== 'block' || decision.reasons.length > 0)
    && SHA256_PATTERN.test(decision.config_digest)
    && SHA256_PATTERN.test(decision.policy_digest)
    && typeof decision.recovery_applied === 'boolean'
    && (decision.shadow === undefined
      || (Array.isArray(decision.shadow) && decision.shadow.every(validShadow)))
    && (decision.context === undefined
      || (decision.action === 'block'
        && typeof decision.context === 'string'
        && decision.context.length > 0
        && Buffer.byteLength(decision.context, 'utf8') <= 16 * 1024))
    && decision.replacement === undefined
}

function positiveTimeout(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS
}

async function evaluatePreToolPolicy(ctx, exec, command, timeoutMs) {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const ingress = {
    schema_version: 'agent-hook.dsh-ingress.v1',
    event: 'tools/pre-execute',
    call_id: String(exec.callId),
    cwd,
    tool: {
      name: exec.name,
      arguments: exec.arguments,
    },
  }
  if (boundedJsonBytes(ingress, MAX_POLICY_INPUT_BYTES) > MAX_POLICY_INPUT_BYTES) {
    return denial('policy-input-too-large')
  }
  const payload = JSON.stringify(ingress)
  if (Buffer.byteLength(payload, 'utf8') > MAX_POLICY_INPUT_BYTES) {
    return denial('policy-input-too-large')
  }
  const expectedRequestId = `request:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`

  const policyController = new AbortController()
  const onCallerAbort = () => policyController.abort(exec.signal.reason)
  exec.signal.addEventListener('abort', onCallerAbort, { once: true })
  if (exec.signal.aborted) onCallerAbort()
  const handle = ctx.subprocess.spawn({
    argv: [command, 'dispatch', '--product', 'dsh', '--format', 'json'],
    cwd,
    stdio: {
      stdin: { data: payload },
      stdout: { maxBytes: MAX_POLICY_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_POLICY_ERROR_BYTES },
    },
    graceMs: 1_000,
    signal: policyController.signal,
  })
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' })
      policyController.abort(new Error('dsh-runtime-kit policy deadline exceeded'))
      handle.terminate()
    }, timeoutMs)
  })
  const settled = handle.done.then(
    outcome => ({ kind: 'done', outcome }),
    () => ({ kind: 'error' }),
  )
  const result = await Promise.race([settled, timeout])
  clearTimeout(timer)
  exec.signal.removeEventListener('abort', onCallerAbort)
  if (result.kind === 'timeout') {
    await Promise.race([
      settled,
      new Promise(resolve => setTimeout(resolve, 1_100)),
    ])
    return denial('policy-timeout')
  }
  if (exec.signal.aborted) return undefined
  if (result.kind !== 'done') return denial('policy-unavailable')
  const outcome = result.outcome
  const stdout = handle.collected.stdout?.readFrom(0)
  if (stdout === undefined || stdout.lossy) {
    return denial('policy-output-invalid')
  }

  let envelope
  try {
    envelope = JSON.parse(stdout.text)
  } catch {
    return denial('policy-output-invalid')
  }
  if (envelope?.schema_version !== 'cli.agent-hook.dispatch.v1'
    || envelope.ok !== true
    || !validDecision(envelope.data, expectedRequestId)) {
    return denial('policy-output-invalid')
  }

  const decision = envelope.data
  if (decision.action === 'block') {
    return outcome.exitCode === 1 && outcome.signal === null
      ? { kind: 'deny', reason: policyReason(decision) }
      : denial('policy-exit-mismatch')
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    return denial('policy-exit-mismatch')
  }
  return undefined
}

export function applyPolicy(ctx, config = {}) {
  const command = typeof config.agentHook === 'string' && config.agentHook.length > 0
    ? config.agentHook
    : 'agent-hook'
  const timeoutMs = positiveTimeout(config.policyTimeoutMs)
    ? config.policyTimeoutMs
    : DEFAULT_POLICY_TIMEOUT_MS

  let plusOneExecutions = 0
  ctx.tools.register(createPlusOneTool(() => { plusOneExecutions += 1 }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const decision = await evaluatePreToolPolicy(ctx, exec, command, timeoutMs)
      return decision ?? next()
    } catch {
      return denial('policy-unavailable')
    }
  })
  ctx.provide('dshRuntimeKit', Object.freeze({
    apiVersion: 1,
    get plusOneExecutions() { return plusOneExecutions },
  }))
}
