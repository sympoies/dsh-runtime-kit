import { createHash } from 'node:crypto'

const MAX_POLICY_OUTPUT_BYTES = 64 * 1024
const MAX_POLICY_ERROR_BYTES = 8 * 1024
const MAX_POLICY_INPUT_BYTES = 1024 * 1024
const DEFAULT_POLICY_TIMEOUT_MS = 5_000
const MAX_POLICY_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ACTIVE_POLICY_CHECKS = 4
const MAX_ACTIVE_POLICY_CHECKS = 16
const MAX_POLICY_INPUT_DEPTH = 64
const MAX_POLICY_INPUT_ENTRIES = 10_000
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const DSH_V1_REASON_DISPOSITIONS = new Set(['allow', 'block'])

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

function* ownEnumerableEntries(value) {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const item = value[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
    yield [key, item]
  }
}

/**
 * Measure JSON incrementally without recursive calls or eager whole-container
 * entry arrays. The traversal stops as soon as its byte, depth, or entry
 * contract is exceeded; the later JSON.stringify is therefore bounded to a
 * practical, already-validated shape.
 */
function boundedJsonMeasurement(value, limit) {
  const ancestors = new WeakSet()
  const stack = [{ kind: 'value', value, depth: 0 }]
  let bytes = 0
  let entries = 0

  const addBytes = (amount) => {
    bytes += amount
    return bytes <= limit
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.kind === 'close') {
      ancestors.delete(frame.value)
      continue
    }
    if (frame.kind === 'container') {
      let item
      let key
      if (frame.array) {
        if (frame.index >= frame.value.length) {
          ancestors.delete(frame.value)
          continue
        }
        key = String(frame.index)
        item = Object.hasOwn(frame.value, frame.index) ? frame.value[frame.index] : null
        frame.index += 1
      } else {
        const next = frame.iterator.next()
        if (next.done) {
          ancestors.delete(frame.value)
          continue
        }
        ;[key, item] = next.value
      }
      entries += 1
      if (entries > MAX_POLICY_INPUT_ENTRIES) return { ok: false, reason: 'too-complex' }
      if (!frame.first && !addBytes(1)) return { ok: false, reason: 'too-large' }
      frame.first = false
      if (!frame.array) {
        if (!addBytes(jsonStringBytes(key, limit - bytes) + 1)) {
          return { ok: false, reason: 'too-large' }
        }
      }
      stack.push(frame)
      stack.push({ kind: 'value', value: item, depth: frame.depth + 1 })
      continue
    }

    const item = frame.value
    if (item === null) {
      if (!addBytes(4)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'string') {
      if (!addBytes(jsonStringBytes(item, limit - bytes))) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'boolean') {
      if (!addBytes(item ? 4 : 5)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return { ok: false, reason: 'too-complex' }
      if (!addBytes(String(item).length)) return { ok: false, reason: 'too-large' }
      continue
    }
    if (typeof item !== 'object' || ancestors.has(item)) {
      return { ok: false, reason: 'too-complex' }
    }
    if (frame.depth >= MAX_POLICY_INPUT_DEPTH) return { ok: false, reason: 'too-complex' }

    ancestors.add(item)
    if (!addBytes(2)) return { ok: false, reason: 'too-large' }
    stack.push({
      kind: 'container',
      value: item,
      array: Array.isArray(item),
      index: 0,
      iterator: Array.isArray(item) ? undefined : ownEnumerableEntries(item),
      first: true,
      depth: frame.depth,
    })
  }
  return { ok: true, bytes, entries }
}

function validReason(reason) {
  return reason !== null
    && typeof reason === 'object'
    && typeof reason.rule_id === 'string'
    && reason.rule_id.length > 0
    && typeof reason.code === 'string'
    && reason.code.length > 0
    && typeof reason.disposition === 'string'
    && DSH_V1_REASON_DISPOSITIONS.has(reason.disposition)
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
  if (!(decision !== null
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
    && decision.replacement === undefined)) return false

  const hasBlockReason = decision.reasons.some(reason => reason.disposition === 'block')
  return decision.action === 'block'
    ? hasBlockReason
    : !hasBlockReason && decision.reasons.every(reason => reason.disposition === 'allow')
}

function policyTimeout(value) {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_POLICY_TIMEOUT_MS)
    : DEFAULT_POLICY_TIMEOUT_MS
}

function policyConcurrency(value) {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_ACTIVE_POLICY_CHECKS)
    : DEFAULT_MAX_ACTIVE_POLICY_CHECKS
}

function createPolicyLimiter(maxActive) {
  let active = 0
  return {
    acquire() {
      if (active >= maxActive) return undefined
      active += 1
      let released = false
      return () => {
        if (released) return
        released = true
        active -= 1
      }
    },
    get active() { return active },
    maxActive,
  }
}

async function evaluatePreToolPolicy(ctx, exec, command, timeoutMs, limiter) {
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
  const measurement = boundedJsonMeasurement(ingress, MAX_POLICY_INPUT_BYTES)
  if (!measurement.ok) {
    return denial(`policy-input-${measurement.reason}`)
  }
  let payload
  try {
    payload = JSON.stringify(ingress)
  } catch {
    return denial('policy-input-too-complex')
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_POLICY_INPUT_BYTES) {
    return denial('policy-input-too-large')
  }
  const expectedRequestId = `request:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`

  if (exec.signal.aborted) return denial('policy-caller-aborted')
  const release = limiter.acquire()
  if (release === undefined) return denial('policy-overloaded')

  const policyController = new AbortController()
  let resolveCallerAbort
  const callerAborted = new Promise(resolve => { resolveCallerAbort = resolve })
  const onCallerAbort = () => {
    resolveCallerAbort({ kind: 'caller-aborted' })
    policyController.abort(exec.signal.reason)
  }
  exec.signal.addEventListener('abort', onCallerAbort, { once: true })
  if (exec.signal.aborted) {
    onCallerAbort()
    release()
    exec.signal.removeEventListener('abort', onCallerAbort)
    return denial('policy-caller-aborted')
  }
  let handle
  try {
    handle = ctx.subprocess.spawn({
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
  } catch (error) {
    release()
    exec.signal.removeEventListener('abort', onCallerAbort)
    throw error
  }
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
  void settled.then(release, release)
  void settled.then(() => clearTimeout(timer))
  const result = await Promise.race([settled, timeout, callerAborted])
  if (result.kind !== 'caller-aborted') clearTimeout(timer)
  exec.signal.removeEventListener('abort', onCallerAbort)
  if (result.kind === 'caller-aborted') return denial('policy-caller-aborted')
  if (result.kind === 'timeout') {
    await Promise.race([
      settled,
      new Promise(resolve => setTimeout(resolve, 1_100)),
    ])
    return denial('policy-timeout')
  }
  if (exec.signal.aborted) return denial('policy-caller-aborted')
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
  const timeoutMs = policyTimeout(config.policyTimeoutMs)
  const limiter = createPolicyLimiter(policyConcurrency(config.maxActivePolicyChecks))
  const policyMarkers = new Map()

  let plusOneExecutions = 0
  ctx.tools.register(createPlusOneTool(() => { plusOneExecutions += 1 }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const decision = await evaluatePreToolPolicy(ctx, exec, command, timeoutMs, limiter)
      if (decision !== undefined) return decision
      if (exec.signal.aborted) return denial('policy-caller-aborted')
      policyMarkers.set(exec.token, {
        callId: exec.callId,
        name: exec.name,
      })
      let downstream
      try {
        downstream = await next()
      } catch (error) {
        policyMarkers.delete(exec.token)
        throw error
      }
      if (downstream.kind !== 'allow') policyMarkers.delete(exec.token)
      return downstream
    } catch {
      return denial('policy-unavailable')
    }
  })
  ctx.tools.guard((exec) => {
    const marker = policyMarkers.get(exec.token)
    policyMarkers.delete(exec.token)
    if (exec.signal.aborted) return denial('policy-caller-aborted').reason
    if (marker === undefined
      || marker.callId !== exec.callId
      || marker.name !== exec.name) {
      return denial('policy-marker-missing').reason
    }
    return undefined
  })
  ctx.on('tools/result', (exec) => {
    policyMarkers.delete(exec.token)
  })
  ctx.provide('dshRuntimeKit', Object.freeze({
    apiVersion: 1,
    get plusOneExecutions() { return plusOneExecutions },
    get activePolicyChecks() { return limiter.active },
    get pendingPolicyMarkers() { return policyMarkers.size },
    policyTimeoutMs: timeoutMs,
    maxActivePolicyChecks: limiter.maxActive,
  }))
}
