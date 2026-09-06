import { createHash } from 'node:crypto'

export const COMPOSITION_API_VERSION = 'runtime.sympoies.dev/v1'

export const COMPOSITION_KINDS = Object.freeze([
  'PluginDescriptor',
  'BotProfile',
  'ResolvedComposition',
  'CompositionLockReceipt',
])

export const COMPOSITION_DOMAIN_TAGS = Object.freeze({
  PluginDescriptor: 'sympoies/plugin-descriptor/v1',
  BotProfile: 'sympoies/bot-profile/v1',
  ResolvedComposition: 'sympoies/resolved-composition/v1',
  CompositionLockReceipt: 'sympoies/composition-lock-receipt/v1',
})

export const PLUGIN_CATALOG_SNAPSHOT_DOMAIN_TAG = 'sympoies/plugin-catalog-snapshot/v1'
export const PUBLIC_POLICY_CEILING_DOMAIN_TAG = 'sympoies/public-policy-ceiling/v1'
export const PUBLIC_EFFECTIVE_AUTHORITY_DOMAIN_TAG = 'sympoies/public-effective-authority/v1'

export const COMPOSITION_CONTRACT_ERROR_CODES = Object.freeze([
  'authority-over-grant',
  'canonical-number-invalid',
  'canonical-string-invalid',
  'canonical-value-invalid',
  'catalog-digest-mismatch',
  'compatibility-unsupported',
  'composition-conflict',
  'dependency-cycle',
  'deprecated-new-lock',
  'digest-domain-invalid',
  'digest-invalid',
  'duplicate-id',
  'duplicate-json-key',
  'input-not-validated',
  'invalid-request',
  'json-invalid',
  'missing-requirement',
  'policy-denied',
  'private-state-in-public-lock',
  'schema-invalid',
  'secret-shaped-value',
  'stale-prior-lock',
  'trigger-widening',
  'unknown-field',
  'unsupported-api-version',
  'unsupported-kind',
  'version-invalid',
])

export const COMPOSITION_PROTOCOL_FAILURE_CODES = Object.freeze({
  validate: Object.freeze([
    'invalid-request', 'unsupported-api-version', 'unsupported-kind',
    'schema-invalid', 'unknown-field', 'version-invalid', 'digest-invalid',
    'secret-shaped-value', 'compatibility-unsupported',
  ]),
  resolve: Object.freeze([
    'invalid-request', 'input-not-validated', 'catalog-digest-mismatch',
    'version-range-unsatisfied', 'dependency-unsatisfied', 'dependency-cycle',
    'conflict', 'capability-overgrant', 'policy-denied', 'digest-invalid',
  ]),
})

export const COMPOSITION_VALIDATE_ERROR_MAP = Object.freeze({
  'authority-over-grant': 'schema-invalid',
  'canonical-number-invalid': 'schema-invalid',
  'canonical-string-invalid': 'schema-invalid',
  'canonical-value-invalid': 'schema-invalid',
  'catalog-digest-mismatch': 'invalid-request',
  'compatibility-unsupported': 'compatibility-unsupported',
  'composition-conflict': 'invalid-request',
  'dependency-cycle': 'schema-invalid',
  'deprecated-new-lock': 'invalid-request',
  'digest-domain-invalid': 'invalid-request',
  'digest-invalid': 'digest-invalid',
  'duplicate-id': 'schema-invalid',
  'duplicate-json-key': 'schema-invalid',
  'input-not-validated': 'invalid-request',
  'invalid-request': 'invalid-request',
  'json-invalid': 'schema-invalid',
  'missing-requirement': 'invalid-request',
  'policy-denied': 'invalid-request',
  'private-state-in-public-lock': 'schema-invalid',
  'schema-invalid': 'schema-invalid',
  'secret-shaped-value': 'secret-shaped-value',
  'stale-prior-lock': 'invalid-request',
  'trigger-widening': 'schema-invalid',
  'unknown-field': 'unknown-field',
  'unsupported-api-version': 'unsupported-api-version',
  'unsupported-kind': 'unsupported-kind',
  'version-invalid': 'version-invalid',
})

export const COMPOSITION_RESOLVE_ERROR_MAP = Object.freeze({
  'authority-over-grant': 'capability-overgrant',
  'canonical-number-invalid': 'invalid-request',
  'canonical-string-invalid': 'invalid-request',
  'canonical-value-invalid': 'invalid-request',
  'catalog-digest-mismatch': 'catalog-digest-mismatch',
  'compatibility-unsupported': 'version-range-unsatisfied',
  'composition-conflict': 'conflict',
  'dependency-cycle': 'dependency-cycle',
  'deprecated-new-lock': 'invalid-request',
  'digest-domain-invalid': 'digest-invalid',
  'digest-invalid': 'digest-invalid',
  'duplicate-id': 'invalid-request',
  'duplicate-json-key': 'invalid-request',
  'input-not-validated': 'input-not-validated',
  'invalid-request': 'invalid-request',
  'json-invalid': 'invalid-request',
  'missing-requirement': 'dependency-unsatisfied',
  'policy-denied': 'policy-denied',
  'private-state-in-public-lock': 'invalid-request',
  'schema-invalid': 'invalid-request',
  'secret-shaped-value': 'invalid-request',
  'stale-prior-lock': 'invalid-request',
  'trigger-widening': 'invalid-request',
  'unknown-field': 'invalid-request',
  'unsupported-api-version': 'invalid-request',
  'unsupported-kind': 'invalid-request',
  'version-invalid': 'invalid-request',
})

const CONTRACT_ERROR_CODE_SET = new Set(COMPOSITION_CONTRACT_ERROR_CODES)

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z][a-z0-9._-]*)$/u
const SOURCE_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?key|auth(?:orization)?|bearer|cookie|credential|password|private[_-]?key|secret|session|token)(?:$|[_-])/iu
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{4,}/u,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}/u,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{4,}/u,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{4,}/u,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{12,}/u,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{4,}/u,
])
const PRIVATE_FIELD_NAMES = new Set([
  'bindingDigest',
  'channel',
  'credential',
  'deploymentId',
  'environment',
  'generation',
  'host',
  'hostIdentity',
  'installation',
  'installationId',
  'instanceId',
  'osIdentity',
  'privateAllowlist',
  'privateBindingDigest',
  'privateEffectiveAuthority',
  'privateRoute',
  'publisher',
  'publisherEpoch',
  'repository',
  'runtimeRoot',
  'secretLocator',
  'service',
  'serviceIdentity',
  'trafficState',
])
const NORMALIZED_PRIVATE_FIELD_NAMES = new Set(
  [...PRIVATE_FIELD_NAMES].map(normalizedFieldName),
)
const ACTION_CLASSES = new Set(['read', 'write', 'destructive', 'open-world'])
const WORKLOAD_CLASSES = new Set([
  'interactive-coding',
  'conversational-service',
  'event-service',
  'batch',
])
const TRIGGERS_BY_WORKLOAD = Object.freeze({
  'interactive-coding': new Set(['manual']),
  'conversational-service': new Set(['manual', 'message']),
  'event-service': new Set(['event', 'manual', 'webhook']),
  batch: new Set(['manual', 'schedule']),
})
const MAX_COLLECTION = 1024
const MAX_STRING_BYTES = 4096
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100_000
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024
const MAX_RESOLUTION_STATES = 4096
const MAX_RESOLUTION_WORK_UNITS = 25_000

export type NodeCounter = {count: number}

function normalizedFieldName(value: string) {
  return value.replace(/[_-]/gu, '').toLowerCase()
}

function isSecretShapedText(value: string) {
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))
}

function traversalGuard(depth: number, nodes: NodeCounter, path: string, code: string) {
  nodes.count += 1
  if (depth > MAX_JSON_DEPTH || nodes.count > MAX_JSON_NODES) {
    fail(code, `${path} exceeds the bounded JSON traversal limits`, { path })
  }
}

/** Stable, secret-free failure shape for public composition contracts. */
export class CompositionContractError extends Error {
  name
  code
  details

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CompositionContractError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never  {
  if (!CONTRACT_ERROR_CODE_SET.has(code)) throw new Error('unregistered composition contract error code')
  throw new CompositionContractError(code, message, details)
}

function isRecord(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonOwnProperties(value: object, path: string, arrayValue: boolean = false) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('schema-invalid', `${path} contains a symbol property`, { path })
    }
    if (arrayValue && key === 'length') continue
    if (arrayValue && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= ((value) as unknown[]).length)) {
      fail('schema-invalid', `${path} contains a non-JSON array property`, { path })
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('schema-invalid', `${path} must contain only enumerable data properties`, { path })
    }
  }
}

function record(value: unknown, path: string) {
  if (!isRecord(value)) fail('schema-invalid', `${path} must be an object`)
  const candidate = ((value) as Record<string, any>)
  assertJsonOwnProperties(candidate, path)
  return candidate
}

function exactKeys(value: Record<string, any>, keys: string[], path: string) {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown-field', `${path} has an unknown field`, { path })
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail('schema-invalid', `${path}.${key} is required`, { path, field: key })
  }
}

function exactKeysWithOptional(value: Record<string, any>, required: string[], optional: string[], path: string) {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown-field', `${path} has an unknown field`, { path })
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('schema-invalid', `${path}.${key} is required`, { path, field: key })
  }
}

function string(value: unknown, path: string, maximumBytes: number = MAX_STRING_BYTES): string  {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('schema-invalid', `${path} must be a non-empty bounded string`, { path })
  }
  return value
}

function identity(value: unknown, path: string): string  {
  const candidate = string(value, path, 256)
  if (!ID_PATTERN.test(candidate)) fail('schema-invalid', `${path} is not a stable identifier`, { path })
  return candidate
}

function digest(value: unknown, path: string): string  {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('digest-invalid', `${path} must be a normalized sha256 digest`, { path })
  }
  return value
}

function integer(value: unknown, path: string, limits: {minimum?: number, maximum?: number} = {}) {
  if (!Number.isSafeInteger(value)) fail('schema-invalid', `${path} must be a safe integer`, { path })
  const candidate = ((value) as number)
  if ((limits.minimum !== undefined && candidate < limits.minimum)
    || (limits.maximum !== undefined && candidate > limits.maximum)) {
    fail('schema-invalid', `${path} is outside its allowed range`, { path })
  }
  return candidate
}

function array<T>(value: unknown, path: string, validator: (item: unknown, path: string) => T): T[]  {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION) {
    fail('schema-invalid', `${path} must be a bounded array`, { path })
  }
  assertJsonOwnProperties(value, path, true)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail('schema-invalid', `${path} contains an array hole`, { path })
  }
  return value.map((item, index) => validator(item, `${path}[${index}]`))
}

function unique(values: string[], path: string) {
  if (new Set(values).size !== values.length) fail('duplicate-id', `${path} contains a duplicate ID`, { path })
  return values
}

function identityArray(value: unknown, path: string) {
  return unique(array(value, path, identity), path)
}

function digestArray(value: unknown, path: string) {
  return unique(array(value, path, digest), path)
}

function enumeration(value: unknown, path: string, allowed: Set<string>): string  {
  const candidate = string(value, path, 128)
  if (!allowed.has(candidate)) fail('schema-invalid', `${path} has an unsupported value`, { path })
  return candidate
}

function assertUnicodeScalarString(value: string, path: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('canonical-string-invalid', `${path} contains an unpaired surrogate`, { path })
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('canonical-string-invalid', `${path} contains an unpaired surrogate`, { path })
    }
  }
}

function canonicalValue(value: unknown, path: string, depth: number = 0, nodes: NodeCounter = { count: 0 }): string  {
  traversalGuard(depth, nodes, path, 'canonical-value-invalid')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail('canonical-number-invalid', `${path} contains a non-canonical number`, { path })
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    assertJsonOwnProperties(value, path, true)
    const values = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('canonical-value-invalid', `${path} contains an array hole`, { path })
      values.push(canonicalValue(value[index], `${path}[${index}]`, depth + 1, nodes))
    }
    return `[${values.join(',')}]`
  }
  if (!isRecord(value)) fail('canonical-value-invalid', `${path} is not a JSON value`, { path })
  assertJsonOwnProperties(((value) as object), path)
  const entries = []
  for (const key of Object.keys(((value) as Record<string, unknown>)).sort()) {
    assertUnicodeScalarString(key, `${path} key`)
    const member = ((value) as Record<string, unknown>)[key]
    if (member === undefined) fail('canonical-value-invalid', `${path} has an undefined member`, { path })
    entries.push(`${JSON.stringify(key)}:${canonicalValue(member, `${path}.[member]`, depth + 1, nodes)}`)
  }
  return `{${entries.join(',')}}`
}

/** RFC 8785 JCS for the supported JSON data model. */
export function canonicalJson(value: unknown) {
  return canonicalValue(value, '$')
}

export type ByteCounter = {bytes: number}

function consumeCanonicalBytes(counter: ByteCounter, bytes: number, maximumBytes: number, path: string) {
  if (bytes > maximumBytes - counter.bytes) {
    fail('schema-invalid', `${path} exceeds the canonical byte limit`, { path })
  }
  counter.bytes += bytes
}

/**
 * Count the exact UTF-8 bytes emitted by JSON.stringify for a scalar string
 * without first allocating the escaped representation.
 */
function consumeCanonicalStringBytes(counter: ByteCounter, value: string, maximumBytes: number, path: string) {
  assertUnicodeScalarString(value, path)
  consumeCanonicalBytes(counter, 2, maximumBytes, path)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      consumeCanonicalBytes(counter, 2, maximumBytes, path)
    } else if (code <= 0x1f) {
      consumeCanonicalBytes(counter, 6, maximumBytes, path)
    } else if (code <= 0x7f) {
      consumeCanonicalBytes(counter, 1, maximumBytes, path)
    } else if (code <= 0x7ff) {
      consumeCanonicalBytes(counter, 2, maximumBytes, path)
    } else if (code >= 0xd800 && code <= 0xdbff) {
      consumeCanonicalBytes(counter, 4, maximumBytes, path)
      index += 1
    } else {
      consumeCanonicalBytes(counter, 3, maximumBytes, path)
    }
  }
}

/** Validate and count canonical bytes without materializing the complete output. */
function assertCanonicalByteLimit(
  value: unknown,
  maximumBytes: number,
  path: string,
  depth: number = 0,
  nodes: NodeCounter = { count: 0 },
  bytes: ByteCounter = { bytes: 0 },
) {
  traversalGuard(depth, nodes, path, 'schema-invalid')
  if (value === null) {
    consumeCanonicalBytes(bytes, 4, maximumBytes, path)
    return
  }
  if (typeof value === 'boolean') {
    consumeCanonicalBytes(bytes, value ? 4 : 5, maximumBytes, path)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail('canonical-number-invalid', `${path} contains a non-canonical number`, { path })
    }
    consumeCanonicalBytes(bytes, ((JSON.stringify(value)) as string).length, maximumBytes, path)
    return
  }
  if (typeof value === 'string') {
    if (value.length + 2 > maximumBytes - bytes.bytes) {
      fail('schema-invalid', `${path} exceeds the canonical byte limit`, { path })
    }
    consumeCanonicalStringBytes(bytes, value, maximumBytes, path)
    return
  }
  if (Array.isArray(value)) {
    assertJsonOwnProperties(value, path, true)
    consumeCanonicalBytes(bytes, 2, maximumBytes, path)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('schema-invalid', `${path} contains an array hole`, { path })
      if (index > 0) consumeCanonicalBytes(bytes, 1, maximumBytes, path)
      assertCanonicalByteLimit(value[index], maximumBytes, `${path}[${index}]`, depth + 1, nodes, bytes)
    }
    return
  }
  const candidate = record(value, path)
  const keys = Object.keys(candidate)
  consumeCanonicalBytes(bytes, 2, maximumBytes, path)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key.length + 3 > maximumBytes - bytes.bytes) {
      fail('schema-invalid', `${path} exceeds the canonical byte limit`, { path })
    }
    if (index > 0) consumeCanonicalBytes(bytes, 1, maximumBytes, path)
    consumeCanonicalStringBytes(bytes, key, maximumBytes, `${path} key`)
    consumeCanonicalBytes(bytes, 1, maximumBytes, path)
    assertCanonicalByteLimit(candidate[key], maximumBytes, `${path}.[member]`, depth + 1, nodes, bytes)
  }
}

class DuplicateSafeJsonParser {
  source
  offset
  nodes

  constructor(source: string) {
    this.source = source
    this.offset = 0
    this.nodes = 0
  }

  whitespace() {
    while (/[\u0009\u000a\u000d\u0020]/u.test(this.source[this.offset] ?? '')) this.offset += 1
  }

  syntax(message: string): never  {
    fail('json-invalid', `${message} at byte offset ${this.offset}`)
  }

  parse(): unknown  {
    this.whitespace()
    const value = this.value('$', 0)
    this.whitespace()
    if (this.offset !== this.source.length) this.syntax('unexpected trailing JSON input')
    return value
  }

  value(path: string, depth: number): unknown  {
    this.nodes += 1
    if (depth > MAX_JSON_DEPTH) this.syntax('JSON nesting exceeds the supported depth')
    if (this.nodes > MAX_JSON_NODES) this.syntax('JSON node count exceeds the supported limit')
    const token = this.source[this.offset]
    if (token === '{') return this.object(path, depth)
    if (token === '[') return this.list(path, depth)
    if (token === '"') return this.quoted(path)
    const literals: Array<[string, unknown]> = [['true', true], ['false', false], ['null', null]]
    for (const [literal, value] of literals) {
      if (this.source.startsWith(literal, this.offset)) {
        this.offset += literal.length
        return value
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.offset))
    if (match === null) this.syntax('invalid JSON value')
    this.offset += match[0].length
    const number = Number(match[0])
    if (!Number.isFinite(number) || Object.is(number, -0)) {
      fail('canonical-number-invalid', `${path} contains a non-canonical number`, { path })
    }
    return number
  }

  quoted(path: string): string  {
    const start = this.offset
    this.offset += 1
    let escaped = false
    while (this.offset < this.source.length) {
      const token = this.source[this.offset]
      if (!escaped && token === '"') {
        this.offset += 1
        let decoded: unknown
        try { decoded = JSON.parse(this.source.slice(start, this.offset)) } catch { this.syntax('invalid JSON string') }
        if (typeof decoded !== 'string') this.syntax('JSON string decoded to a non-string value')
        assertUnicodeScalarString(decoded, path)
        return decoded
      }
      if (!escaped && token.charCodeAt(0) < 0x20) this.syntax('unescaped control character')
      if (!escaped && token === '\\') escaped = true
      else escaped = false
      this.offset += 1
    }
    this.syntax('unterminated JSON string')
  }

  object(path: string, depth: number): Record<string, unknown>  {
    this.offset += 1
    this.whitespace()
    const output: Record<string, unknown> = {}
    const keys = new Set()
    if (this.source[this.offset] === '}') {
      this.offset += 1
      return output
    }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax('object key must be a string')
      const key = this.quoted(`${path} key`)
      if (keys.has(key)) fail('duplicate-json-key', `${path} contains a duplicate key`, { path })
      keys.add(key)
      this.whitespace()
      if (this.source[this.offset] !== ':') this.syntax('object key must be followed by a colon')
      this.offset += 1
      this.whitespace()
      output[key] = this.value(`${path}.[member]`, depth + 1)
      this.whitespace()
      const token = this.source[this.offset]
      if (token === '}') {
        this.offset += 1
        return output
      }
      if (token !== ',') this.syntax('object member must be followed by comma or close')
      this.offset += 1
      this.whitespace()
    }
  }

  list(path: string, depth: number): unknown[]  {
    this.offset += 1
    this.whitespace()
    const output: unknown[] = []
    if (this.source[this.offset] === ']') {
      this.offset += 1
      return output
    }
    while (true) {
      output.push(this.value(`${path}[${output.length}]`, depth + 1))
      this.whitespace()
      const token = this.source[this.offset]
      if (token === ']') {
        this.offset += 1
        return output
      }
      if (token !== ',') this.syntax('array item must be followed by comma or close')
      this.offset += 1
      this.whitespace()
    }
  }
}

/** Parse JSON without losing duplicate-key evidence. */
export function parseCanonicalJsonText(source: string) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_PROTOCOL_BYTES) {
    fail('json-invalid', 'JSON input must be a bounded string')
  }
  const value = new DuplicateSafeJsonParser(source).parse()
  canonicalJson(value)
  return value
}

export function domainSeparatedDigest(domainTag: string, document: unknown) {
  if (typeof domainTag !== 'string' || !/^[\x21-\x7e]+$/u.test(domainTag)) {
    fail('digest-domain-invalid', 'digest domain tag must be visible ASCII')
  }
  const hash = createHash('sha256')
  hash.update(domainTag, 'ascii')
  hash.update(Buffer.from([0]))
  hash.update(canonicalJson(document), 'utf8')
  return `sha256:${hash.digest('hex')}`
}

export function computeDocumentDigest(document: unknown) {
  canonicalJson(document)
  const candidate = structuredClone(record(document, 'document'))
  const kind = string(candidate.kind, 'document.kind', 64)
  if (!COMPOSITION_KINDS.includes(kind)) fail('unsupported-kind', 'composition document kind is unsupported')
  const domain = ((COMPOSITION_DOMAIN_TAGS) as Record<string, string>)[kind]
  if (kind === 'CompositionLockReceipt') delete candidate.digest
  else {
    const metadata = record(candidate.metadata, 'document.metadata')
    delete metadata.digest
  }
  return domainSeparatedDigest(domain, candidate)
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

export type ParsedSemver = {source: string, major: string, minor: string, patch: string, prerelease: readonly string[], build: readonly string[]}
export type SemverOperator = '<' | '<=' | '=' | '>=' | '>'
export type VersionComparator = {operator: SemverOperator, version: ParsedSemver}
export type ParsedVersionRange = {source: string, normalized: string, sets: readonly (readonly VersionComparator[])[]}

function numericIdentifierCompare(left: string, right: string) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function parseSemver(value: unknown, path: string = 'version'): ParsedSemver  {
  const safePath = typeof path === 'string' && Buffer.byteLength(path, 'utf8') <= 256
    && !isSecretShapedText(path) ? path : 'version'
  if (typeof value !== 'string') fail('version-invalid', `${safePath} must be a SemVer string`, { path: safePath })
  const match = SEMVER_PATTERN.exec(value)
  if (match === null) fail('version-invalid', `${safePath} is not exact SemVer 2.0.0`, { path: safePath })
  return Object.freeze({
    source: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: Object.freeze(match[4] === undefined ? [] : match[4].split('.')),
    build: Object.freeze(match[5] === undefined ? [] : match[5].split('.')),
  })
}

export function compareSemver(left: string | ParsedSemver, right: string | ParsedSemver) {
  const a = typeof left === 'string' ? parseSemver(left) : left
  const b = typeof right === 'string' ? parseSemver(right) : right
  for (const [leftIdentifier, rightIdentifier] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ]) {
    const compared = numericIdentifierCompare(leftIdentifier, rightIdentifier)
    if (compared !== 0) return compared
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const ai = a.prerelease[index]
    const bi = b.prerelease[index]
    if (ai === undefined || bi === undefined) return ai === undefined ? -1 : 1
    const an = /^\d+$/u.test(ai)
    const bn = /^\d+$/u.test(bi)
    if (an && bn) {
      const compared = numericIdentifierCompare(ai, bi)
      if (compared !== 0) return compared
    } else if (an !== bn) return an ? -1 : 1
    else if (ai !== bi) return ai < bi ? -1 : 1
  }
  return 0
}

const OPERATOR_ORDER: Readonly<Record<SemverOperator, number>> = Object.freeze({ '<': 0, '<=': 1, '=': 2, '>=': 3, '>': 4 })

export function parseVersionRange(value: unknown): ParsedVersionRange  {
  if (typeof value !== 'string' || value.length === 0) fail('version-invalid', 'version range must be a string')
  if (value === '*') return Object.freeze({ source: value, normalized: '*', sets: Object.freeze([]) })
  const sourceSets = value.split(' || ')
  if (sourceSets.join(' || ') !== value || sourceSets.some(set => set.length === 0)) {
    fail('version-invalid', 'version range separators are not canonical')
  }
  const sets = sourceSets.map((sourceSet, setIndex) => {
    const tokens = sourceSet.split(' ')
    if (tokens.join(' ') !== sourceSet || tokens.some(token => token.length === 0)) {
      fail('version-invalid', 'version comparator spacing is not canonical')
    }
    const comparators = tokens.map((token, tokenIndex) => {
      const match = /^(<=|>=|=|<|>)(.+)$/u.exec(token)
      if (match === null) fail('version-invalid', 'version comparator is invalid')
      return Object.freeze({
        operator: ((match[1]) as SemverOperator),
        version: parseSemver(match[2], `range[${setIndex}][${tokenIndex}]`),
      })
    })
    const normalized = [...comparators]
      .sort((left, right) => compareSemver(left.version, right.version)
        || OPERATOR_ORDER[left.operator] - OPERATOR_ORDER[right.operator]
        || left.version.source.localeCompare(right.version.source))
      .filter((item, index, all) => index === 0
        || item.operator !== all[index - 1].operator
        || compareSemver(item.version, all[index - 1].version) !== 0)
    return Object.freeze(normalized)
  })
  return Object.freeze({
    source: value,
    normalized: sets.map(set => set.map(item => `${item.operator}${item.version.source}`).join(' ')).join(' || '),
    sets: Object.freeze(sets),
  })
}

function normalizedVersionRange(value: unknown, path: string): ParsedVersionRange  {
  const source = string(value, path, MAX_STRING_BYTES)
  const parsed = parseVersionRange(source)
  if (parsed.normalized !== source) {
    fail('version-invalid', `${path} must use normalized comparator order`, { path })
  }
  return parsed
}

function comparatorMatches(candidate: ParsedSemver, comparator: VersionComparator) {
  const compared = compareSemver(candidate, comparator.version)
  return comparator.operator === '=' ? compared === 0
    : comparator.operator === '<' ? compared < 0
      : comparator.operator === '<=' ? compared <= 0
        : comparator.operator === '>' ? compared > 0
          : compared >= 0
}

export function versionSatisfies(version: string, range: string | ParsedVersionRange) {
  const candidate = parseSemver(version)
  const parsed = typeof range === 'string' ? parseVersionRange(range) : range
  if (parsed.normalized === '*') return candidate.prerelease.length === 0
  return parsed.sets.some(set => {
    if (candidate.prerelease.length > 0) {
      const admitsPrerelease = set.some(comparator => comparator.version.prerelease.length > 0
        && comparator.version.major === candidate.major
        && comparator.version.minor === candidate.minor
        && comparator.version.patch === candidate.patch)
      if (!admitsPrerelease) return false
    }
    return set.every(comparator => comparatorMatches(candidate, comparator))
  })
}

function relativeArtifactPath(value: unknown, path: string) {
  const candidate = string(value, path, 1024)
  const segments = candidate.split('/')
  if (candidate.startsWith('/') || candidate.includes('\\')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail('schema-invalid', `${path} must be an artifact-relative path`, { path })
  }
  return candidate
}

function assertNoSecretShape(value: unknown, path: string, depth: number = 0, nodes: NodeCounter = { count: 0 }, inspectKeys: boolean = true) {
  traversalGuard(depth, nodes, path, 'schema-invalid')
  if (typeof value === 'string') {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) fail('secret-shaped-value', `${path} contains a secret-shaped value`, { path })
    }
    return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION) fail('schema-invalid', `${path} exceeds maximum item count`, { path })
    value.forEach((item, index) => assertNoSecretShape(
      item, `${path}[${index}]`, depth + 1, nodes, inspectKeys,
    ))
    return
  }
  const candidate = record(value, path)
  for (const [key, item] of Object.entries(candidate)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
    if (isSecretShapedText(key)) {
      fail('secret-shaped-value', `${path} contains a secret-shaped field`, { path })
    }
    if (inspectKeys && SECRET_KEY_PATTERN.test(normalizedKey)) {
      fail('secret-shaped-value', `${path} contains a secret-shaped field`, { path })
    }
    assertNoSecretShape(item, `${path}.[member]`, depth + 1, nodes, inspectKeys)
  }
}

function assertPublicState(value: unknown, path: string, depth: number = 0, nodes: NodeCounter = { count: 0 }) {
  traversalGuard(depth, nodes, path, 'schema-invalid')
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicState(item, `${path}[${index}]`, depth + 1, nodes))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(((value) as Record<string, unknown>))) {
    if (NORMALIZED_PRIVATE_FIELD_NAMES.has(normalizedFieldName(key))) {
      fail('private-state-in-public-lock', `${path} contains private state in a public lock`, { path })
    }
    assertPublicState(item, `${path}.[member]`, depth + 1, nodes)
  }
}

function documentIdentity(document: Record<string, any>, kind: string) {
  exactKeys(document, kind === 'CompositionLockReceipt'
    ? ['apiVersion', 'kind', 'digest', 'resolvedCompositionDigest', 'resolver', 'inputDigests', 'reason']
    : Object.keys(document), kind)
  if (document.apiVersion !== COMPOSITION_API_VERSION) fail('unsupported-api-version', `${kind} apiVersion is unsupported`)
  if (document.kind !== kind) fail('unsupported-kind', `${kind} kind is unsupported`)
}

/** Digest the exact public catalog snapshot presented to the resolver. */
export function computeCatalogSnapshotDigest(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION) {
    fail('schema-invalid', 'plugin catalog must be a bounded array')
  }
  const descriptorDigests = value.map(item => {
    validatePluginDescriptor(item)
    return digest(record(item, 'PluginDescriptor').metadata.digest, 'PluginDescriptor.metadata.digest')
  }).sort()
  return domainSeparatedDigest(PLUGIN_CATALOG_SNAPSHOT_DOMAIN_TAG, { descriptorDigests })
}

export function computePublicPolicyDigest(value: unknown) {
  canonicalJson(value)
  const candidate = structuredClone(record(value, 'PublicPolicyCeiling'))
  exactKeys(candidate, [
    'digest', 'grants', 'networkClasses', 'workspaceClasses', 'resourceClasses',
  ], 'PublicPolicyCeiling')
  delete candidate.digest
  return domainSeparatedDigest(PUBLIC_POLICY_CEILING_DOMAIN_TAG, candidate)
}

export function validatePublicPolicy(value: unknown) {
  const policy = record(value, 'PublicPolicyCeiling')
  exactKeys(policy, [
    'digest', 'grants', 'networkClasses', 'workspaceClasses', 'resourceClasses',
  ], 'PublicPolicyCeiling')
  digest(policy.digest, 'PublicPolicyCeiling.digest')
  identityArray(policy.grants, 'PublicPolicyCeiling.grants')
  identityArray(policy.networkClasses, 'PublicPolicyCeiling.networkClasses')
  identityArray(policy.workspaceClasses, 'PublicPolicyCeiling.workspaceClasses')
  identityArray(policy.resourceClasses, 'PublicPolicyCeiling.resourceClasses')
  assertNoSecretShape(policy, 'PublicPolicyCeiling', 0, { count: 0 }, false)
  assertPublicState(policy, 'PublicPolicyCeiling')
  if (computePublicPolicyDigest(policy) !== policy.digest) {
    fail('digest-invalid', 'PublicPolicyCeiling digest does not match canonical bytes')
  }
  return value
}

export function validatePluginDescriptor(value: unknown) {
  const descriptor = record(value, 'PluginDescriptor')
  exactKeys(descriptor, [
    'apiVersion', 'kind', 'metadata', 'artifact', 'compatibility', 'capabilities',
    'actions', 'configuration', 'mediation', 'health', 'composition', 'lifecycle',
  ], 'PluginDescriptor')
  documentIdentity(descriptor, 'PluginDescriptor')

  const metadata = record(descriptor.metadata, 'PluginDescriptor.metadata')
  exactKeys(metadata, ['id', 'version', 'digest'], 'PluginDescriptor.metadata')
  identity(metadata.id, 'PluginDescriptor.metadata.id')
  parseSemver(metadata.version, 'PluginDescriptor.metadata.version')
  digest(metadata.digest, 'PluginDescriptor.metadata.digest')

  const artifact = record(descriptor.artifact, 'PluginDescriptor.artifact')
  exactKeys(artifact, ['package', 'digest', 'entrypoint', 'sourceRevision', 'attestationIdentity'], 'PluginDescriptor.artifact')
  if (!PACKAGE_PATTERN.test(string(artifact.package, 'PluginDescriptor.artifact.package', 256))) {
    fail('schema-invalid', 'PluginDescriptor.artifact.package is invalid')
  }
  digest(artifact.digest, 'PluginDescriptor.artifact.digest')
  relativeArtifactPath(artifact.entrypoint, 'PluginDescriptor.artifact.entrypoint')
  if (!SOURCE_REVISION_PATTERN.test(string(artifact.sourceRevision, 'PluginDescriptor.artifact.sourceRevision', 64))) {
    fail('schema-invalid', 'PluginDescriptor.artifact.sourceRevision must be immutable')
  }
  const attestation = string(artifact.attestationIdentity, 'PluginDescriptor.artifact.attestationIdentity', 1024)
  if (!/(?:@refs\/tags\/|@[0-9a-f]{40}(?:$|[/?#]))/u.test(attestation)) {
    fail('schema-invalid', 'PluginDescriptor artifact attestation identity must be immutable')
  }

  const compatibility = record(descriptor.compatibility, 'PluginDescriptor.compatibility')
  exactKeys(compatibility, ['dsh', 'runtimeKit', 'pluginApi', 'platforms'], 'PluginDescriptor.compatibility')
  normalizedVersionRange(compatibility.dsh, 'PluginDescriptor.compatibility.dsh')
  normalizedVersionRange(compatibility.runtimeKit, 'PluginDescriptor.compatibility.runtimeKit')
  normalizedVersionRange(compatibility.pluginApi, 'PluginDescriptor.compatibility.pluginApi')
  identityArray(compatibility.platforms, 'PluginDescriptor.compatibility.platforms')
  if (compatibility.platforms.length === 0) fail('schema-invalid', 'PluginDescriptor must name at least one platform')

  const capabilities = record(descriptor.capabilities, 'PluginDescriptor.capabilities')
  exactKeys(capabilities, ['provides', 'requires', 'tools', 'skills', 'services', 'dependencies'], 'PluginDescriptor.capabilities')
  for (const field of ['provides', 'requires', 'tools', 'skills', 'services']) {
    identityArray(capabilities[field], `PluginDescriptor.capabilities.${field}`)
  }
  const dependencies = array(capabilities.dependencies, 'PluginDescriptor.capabilities.dependencies', (item, path) => {
    const dependency = record(item, path)
    exactKeys(dependency, ['id', 'range', 'scope'], path)
    identity(dependency.id, `${path}.id`)
    normalizedVersionRange(dependency.range, `${path}.range`)
    enumeration(dependency.scope, `${path}.scope`, new Set(['required', 'optional']))
    if (dependency.id === metadata.id) fail('dependency-cycle', 'PluginDescriptor cannot depend on itself')
    return dependency
  })
  unique(dependencies.map(item => item.id), 'PluginDescriptor.capabilities.dependencies')

  const actions = array(descriptor.actions, 'PluginDescriptor.actions', (item, path) => {
    const action = record(item, path)
    exactKeys(action, [
      'id', 'class', 'inputSchemaDigest', 'outputSchemaDigest', 'sideEffect',
      'idempotency', 'capability',
    ], path)
    identity(action.id, `${path}.id`)
    const actionClass = enumeration(action.class, `${path}.class`, ACTION_CLASSES)
    digest(action.inputSchemaDigest, `${path}.inputSchemaDigest`)
    digest(action.outputSchemaDigest, `${path}.outputSchemaDigest`)
    const sideEffect = enumeration(action.sideEffect, `${path}.sideEffect`, new Set(['none', 'idempotent', 'non-idempotent']))
    const idempotency = enumeration(action.idempotency, `${path}.idempotency`, new Set(['none', 'supported', 'required']))
    identity(action.capability, `${path}.capability`)
    if ((actionClass === 'read' && sideEffect !== 'none')
      || (actionClass !== 'read' && sideEffect === 'none')
      || (sideEffect !== 'none' && idempotency === 'none')) {
      fail('schema-invalid', `${path} has an unclassified external action`)
    }
    return action
  })
  unique(actions.map(item => item.id), 'PluginDescriptor.actions')

  const configuration = record(descriptor.configuration, 'PluginDescriptor.configuration')
  exactKeys(configuration, ['schemaDigest', 'defaults'], 'PluginDescriptor.configuration')
  digest(configuration.schemaDigest, 'PluginDescriptor.configuration.schemaDigest')
  canonicalJson(configuration.defaults)
  assertNoSecretShape(configuration.defaults, 'PluginDescriptor.configuration.defaults')

  const mediation = record(descriptor.mediation, 'PluginDescriptor.mediation')
  exactKeys(mediation, ['filesystem', 'network', 'subprocess', 'resources', 'credentialHandleClasses'], 'PluginDescriptor.mediation')
  for (const field of ['filesystem', 'network', 'subprocess', 'credentialHandleClasses']) {
    identityArray(mediation[field], `PluginDescriptor.mediation.${field}`)
  }
  const resources = record(mediation.resources, 'PluginDescriptor.mediation.resources')
  exactKeys(resources, ['cpuClass', 'memoryMb', 'outputBytes'], 'PluginDescriptor.mediation.resources')
  identity(resources.cpuClass, 'PluginDescriptor.mediation.resources.cpuClass')
  integer(resources.memoryMb, 'PluginDescriptor.mediation.resources.memoryMb', { minimum: 1, maximum: 1_048_576 })
  integer(resources.outputBytes, 'PluginDescriptor.mediation.resources.outputBytes', { minimum: 1, maximum: 1_073_741_824 })

  const health = record(descriptor.health, 'PluginDescriptor.health')
  exactKeys(health, ['probes'], 'PluginDescriptor.health')
  const probes = array(health.probes, 'PluginDescriptor.health.probes', (item, path) => {
    const probe = record(item, path)
    exactKeys(probe, ['id', 'requirement'], path)
    identity(probe.id, `${path}.id`)
    enumeration(probe.requirement, `${path}.requirement`, new Set(['required', 'optional']))
    return probe
  })
  unique(probes.map(item => item.id), 'PluginDescriptor.health.probes')

  const composition = record(descriptor.composition, 'PluginDescriptor.composition')
  exactKeys(composition, ['conflicts', 'cardinality', 'namespaceClaims', 'ordering'], 'PluginDescriptor.composition')
  identityArray(composition.conflicts, 'PluginDescriptor.composition.conflicts')
  if (composition.conflicts.includes(metadata.id)) fail('schema-invalid', 'PluginDescriptor cannot conflict with itself')
  const cardinality = record(composition.cardinality, 'PluginDescriptor.composition.cardinality')
  exactKeys(cardinality, ['min', 'max'], 'PluginDescriptor.composition.cardinality')
  const minimum = integer(cardinality.min, 'PluginDescriptor.composition.cardinality.min', { minimum: 0, maximum: 1 })
  const maximum = integer(cardinality.max, 'PluginDescriptor.composition.cardinality.max', { minimum: 1, maximum: 1 })
  if (minimum > maximum) fail('schema-invalid', 'PluginDescriptor composition cardinality is inverted')
  identityArray(composition.namespaceClaims, 'PluginDescriptor.composition.namespaceClaims')
  const ordering = record(composition.ordering, 'PluginDescriptor.composition.ordering')
  exactKeys(ordering, ['before', 'after'], 'PluginDescriptor.composition.ordering')
  const before = identityArray(ordering.before, 'PluginDescriptor.composition.ordering.before')
  const after = identityArray(ordering.after, 'PluginDescriptor.composition.ordering.after')
  if (before.includes(metadata.id) || after.includes(metadata.id)
    || before.some(item => after.includes(item))) {
    fail('dependency-cycle', 'PluginDescriptor ordering constraints are self-contradictory')
  }

  const lifecycle = record(descriptor.lifecycle, 'PluginDescriptor.lifecycle')
  exactKeys(lifecycle, ['readiness', 'interrupt', 'drain', 'disposal', 'recovery'], 'PluginDescriptor.lifecycle')
  enumeration(lifecycle.readiness, 'PluginDescriptor.lifecycle.readiness', new Set(['required', 'optional']))
  enumeration(lifecycle.interrupt, 'PluginDescriptor.lifecycle.interrupt', new Set(['supported', 'unsupported']))
  enumeration(lifecycle.drain, 'PluginDescriptor.lifecycle.drain', new Set(['required', 'unsupported']))
  enumeration(lifecycle.disposal, 'PluginDescriptor.lifecycle.disposal', new Set(['required']))
  enumeration(lifecycle.recovery, 'PluginDescriptor.lifecycle.recovery', new Set(['reconcile', 'restart', 'unsupported']))

  assertNoSecretShape(descriptor, 'PluginDescriptor', 0, { count: 0 }, false)
  assertPublicState(descriptor, 'PluginDescriptor')
  if (computeDocumentDigest(descriptor) !== metadata.digest) {
    fail('digest-invalid', 'PluginDescriptor metadata digest does not match canonical bytes')
  }
  return value
}

export function validateBotProfile(value: unknown) {
  const profile = record(value, 'BotProfile')
  exactKeys(profile, [
    'apiVersion', 'kind', 'metadata', 'workload', 'plugins', 'grants',
    'requiredHealth', 'artifacts', 'modelRouteClass', 'state', 'approvals',
    'limits', 'triggers', 'execution',
  ], 'BotProfile')
  documentIdentity(profile, 'BotProfile')

  const metadata = record(profile.metadata, 'BotProfile.metadata')
  exactKeys(metadata, ['id', 'version', 'digest', 'purpose'], 'BotProfile.metadata')
  identity(metadata.id, 'BotProfile.metadata.id')
  parseSemver(metadata.version, 'BotProfile.metadata.version')
  digest(metadata.digest, 'BotProfile.metadata.digest')
  string(metadata.purpose, 'BotProfile.metadata.purpose', 1024)

  const workload = record(profile.workload, 'BotProfile.workload')
  exactKeys(workload, ['class', 'scopeClass'], 'BotProfile.workload')
  const workloadClass = enumeration(workload.class, 'BotProfile.workload.class', WORKLOAD_CLASSES)
  const scopeClass = enumeration(workload.scopeClass, 'BotProfile.workload.scopeClass', new Set(['project', 'non-project']))

  const plugins = array(profile.plugins, 'BotProfile.plugins', (item, path) => {
    const requirement = record(item, path)
    exactKeys(requirement, ['id', 'range'], path)
    identity(requirement.id, `${path}.id`)
    normalizedVersionRange(requirement.range, `${path}.range`)
    return requirement
  })
  if (plugins.length === 0) fail('schema-invalid', 'BotProfile must select at least one plugin')
  unique(plugins.map(item => item.id), 'BotProfile.plugins')
  const grants = identityArray(profile.grants, 'BotProfile.grants')
  identityArray(profile.requiredHealth, 'BotProfile.requiredHealth')

  const artifacts = record(profile.artifacts, 'BotProfile.artifacts')
  exactKeys(artifacts, ['instructions', 'skills', 'inputSchemaDigest', 'outputSchemaDigest'], 'BotProfile.artifacts')
  relativeArtifactPath(artifacts.instructions, 'BotProfile.artifacts.instructions')
  unique(array(artifacts.skills, 'BotProfile.artifacts.skills', relativeArtifactPath), 'BotProfile.artifacts.skills')
  digest(artifacts.inputSchemaDigest, 'BotProfile.artifacts.inputSchemaDigest')
  digest(artifacts.outputSchemaDigest, 'BotProfile.artifacts.outputSchemaDigest')
  identity(profile.modelRouteClass, 'BotProfile.modelRouteClass')

  const state = record(profile.state, 'BotProfile.state')
  exactKeys(state, ['session', 'memory', 'workspace', 'retentionSeconds', 'restart'], 'BotProfile.state')
  enumeration(state.session, 'BotProfile.state.session', new Set(['ephemeral', 'persistent']))
  enumeration(state.memory, 'BotProfile.state.memory', new Set(['none', 'session', 'persistent']))
  enumeration(state.workspace, 'BotProfile.state.workspace', new Set(['none', 'project', 'isolated']))
  integer(state.retentionSeconds, 'BotProfile.state.retentionSeconds', { minimum: 0, maximum: 31_536_000 })
  enumeration(state.restart, 'BotProfile.state.restart', new Set(['fresh', 'resume', 'reconcile']))

  const approvals = record(profile.approvals, 'BotProfile.approvals')
  exactKeys(approvals, ['requiredFor'], 'BotProfile.approvals')
  unique(array(approvals.requiredFor, 'BotProfile.approvals.requiredFor', (item, path) => enumeration(item, path, ACTION_CLASSES)), 'BotProfile.approvals.requiredFor')

  const limits = record(profile.limits, 'BotProfile.limits')
  exactKeys(limits, ['actions', 'networkClasses', 'workspaceClasses', 'budgetUnits', 'ratePerMinute'], 'BotProfile.limits')
  integer(limits.actions, 'BotProfile.limits.actions', { minimum: 1, maximum: 1_000_000 })
  identityArray(limits.networkClasses, 'BotProfile.limits.networkClasses')
  identityArray(limits.workspaceClasses, 'BotProfile.limits.workspaceClasses')
  integer(limits.budgetUnits, 'BotProfile.limits.budgetUnits', { minimum: 1, maximum: 1_000_000_000 })
  integer(limits.ratePerMinute, 'BotProfile.limits.ratePerMinute', { minimum: 1, maximum: 1_000_000 })

  const triggers = array(profile.triggers, 'BotProfile.triggers', (item, path) => {
    const trigger = record(item, path)
    exactKeys(trigger, ['class', 'inputSchemaDigest'], path)
    const triggerClass = enumeration(trigger.class, `${path}.class`, new Set(['event', 'manual', 'message', 'schedule', 'webhook']))
    if (!((TRIGGERS_BY_WORKLOAD) as Record<string, Set<string>>)[workloadClass].has(triggerClass)) {
      fail('trigger-widening', `${path}.class widens the workload trigger class`)
    }
    digest(trigger.inputSchemaDigest, `${path}.inputSchemaDigest`)
    return trigger
  })
  unique(triggers.map(item => item.class), 'BotProfile.triggers')

  const execution = record(profile.execution, 'BotProfile.execution')
  exactKeys(execution, ['concurrency', 'overlap', 'timeoutMs', 'retry', 'cancellation', 'interrupt', 'drain'], 'BotProfile.execution')
  integer(execution.concurrency, 'BotProfile.execution.concurrency', { minimum: 1, maximum: 1024 })
  enumeration(execution.overlap, 'BotProfile.execution.overlap', new Set(['allow', 'forbid', 'replace']))
  integer(execution.timeoutMs, 'BotProfile.execution.timeoutMs', { minimum: 1, maximum: 86_400_000 })
  const retry = record(execution.retry, 'BotProfile.execution.retry')
  exactKeys(retry, ['maxAttempts', 'backoffMs'], 'BotProfile.execution.retry')
  integer(retry.maxAttempts, 'BotProfile.execution.retry.maxAttempts', { minimum: 1, maximum: 32 })
  integer(retry.backoffMs, 'BotProfile.execution.retry.backoffMs', { minimum: 0, maximum: 3_600_000 })
  enumeration(execution.cancellation, 'BotProfile.execution.cancellation', new Set(['cooperative', 'immediate']))
  enumeration(execution.interrupt, 'BotProfile.execution.interrupt', new Set(['supported', 'unsupported']))
  enumeration(execution.drain, 'BotProfile.execution.drain', new Set(['required', 'unsupported']))

  if (scopeClass !== 'project' && (grants.some(item => item.startsWith('coding.'))
    || state.workspace === 'project' || limits.workspaceClasses.length > 0)) {
    fail('authority-over-grant', 'BotProfile non-project workload cannot request coding or project workspace authority')
  }
  if ((state.session === 'ephemeral' && state.memory === 'persistent')
    || (state.workspace === 'none' && limits.workspaceClasses.length > 0)) {
    fail('schema-invalid', 'BotProfile persistence or workspace policy is incompatible')
  }
  assertNoSecretShape(profile, 'BotProfile', 0, { count: 0 }, false)
  assertPublicState(profile, 'BotProfile')
  if (computeDocumentDigest(profile) !== metadata.digest) {
    fail('digest-invalid', 'BotProfile metadata digest does not match canonical bytes')
  }
  return value
}

export function validateResolvedComposition(value: unknown) {
  const composition = record(value, 'ResolvedComposition')
  assertNoSecretShape(composition, 'ResolvedComposition', 0, { count: 0 }, false)
  assertPublicState(composition, 'ResolvedComposition')
  if (Object.hasOwn(composition, 'lockReceiptDigest') || Object.hasOwn(composition, 'receipt')) {
    fail('schema-invalid', 'ResolvedComposition receipt topology must remain acyclic')
  }
  exactKeys(composition, [
    'apiVersion', 'kind', 'metadata', 'runtime', 'profile', 'plugins',
    'authorityCeiling', 'publicPolicyDigest', 'modelRouteClass', 'isolation',
    'resources', 'health', 'resolver',
  ], 'ResolvedComposition')
  documentIdentity(composition, 'ResolvedComposition')
  const metadata = record(composition.metadata, 'ResolvedComposition.metadata')
  exactKeys(metadata, ['digest'], 'ResolvedComposition.metadata')
  digest(metadata.digest, 'ResolvedComposition.metadata.digest')

  const runtimeValue = record(composition.runtime, 'ResolvedComposition.runtime')
  exactKeys(runtimeValue, ['dshVersion', 'runtimeKitVersion', 'pluginApiVersion', 'platform', 'compatibilityDecision'], 'ResolvedComposition.runtime')
  parseSemver(runtimeValue.dshVersion)
  parseSemver(runtimeValue.runtimeKitVersion)
  parseSemver(runtimeValue.pluginApiVersion)
  identity(runtimeValue.platform, 'ResolvedComposition.runtime.platform')
  if (runtimeValue.compatibilityDecision !== 'compatible') fail('compatibility-unsupported', 'ResolvedComposition compatibility decision is not compatible')

  const profile = record(composition.profile, 'ResolvedComposition.profile')
  exactKeys(profile, ['id', 'version', 'digest', 'workloadClass', 'scopeClass'], 'ResolvedComposition.profile')
  identity(profile.id, 'ResolvedComposition.profile.id')
  parseSemver(profile.version)
  digest(profile.digest, 'ResolvedComposition.profile.digest')
  enumeration(profile.workloadClass, 'ResolvedComposition.profile.workloadClass', WORKLOAD_CLASSES)
  enumeration(profile.scopeClass, 'ResolvedComposition.profile.scopeClass', new Set(['project', 'non-project']))

  const plugins = array(composition.plugins, 'ResolvedComposition.plugins', (item, path) => {
    const plugin = record(item, path)
    exactKeys(plugin, ['id', 'version', 'descriptorDigest', 'artifactDigest', 'dependencyOrder', 'configurationDigest'], path)
    identity(plugin.id, `${path}.id`)
    parseSemver(plugin.version)
    digest(plugin.descriptorDigest, `${path}.descriptorDigest`)
    digest(plugin.artifactDigest, `${path}.artifactDigest`)
    integer(plugin.dependencyOrder, `${path}.dependencyOrder`, { minimum: 0, maximum: MAX_COLLECTION })
    digest(plugin.configurationDigest, `${path}.configurationDigest`)
    return plugin
  })
  unique(plugins.map(item => item.id), 'ResolvedComposition.plugins')
  if (plugins.some((item, index) => item.dependencyOrder !== index)) {
    fail('schema-invalid', 'ResolvedComposition dependency order is not contiguous')
  }

  const authority = record(composition.authorityCeiling, 'ResolvedComposition.authorityCeiling')
  exactKeys(authority, ['capabilities', 'networkClasses', 'workspaceClasses'], 'ResolvedComposition.authorityCeiling')
  identityArray(authority.capabilities, 'ResolvedComposition.authorityCeiling.capabilities')
  identityArray(authority.networkClasses, 'ResolvedComposition.authorityCeiling.networkClasses')
  identityArray(authority.workspaceClasses, 'ResolvedComposition.authorityCeiling.workspaceClasses')
  digest(composition.publicPolicyDigest, 'ResolvedComposition.publicPolicyDigest')
  identity(composition.modelRouteClass, 'ResolvedComposition.modelRouteClass')

  const isolation = record(composition.isolation, 'ResolvedComposition.isolation')
  exactKeys(isolation, ['workspaceClass', 'sessionClass', 'memoryClass'], 'ResolvedComposition.isolation')
  enumeration(isolation.workspaceClass, 'ResolvedComposition.isolation.workspaceClass', new Set(['none', 'project', 'isolated']))
  enumeration(isolation.sessionClass, 'ResolvedComposition.isolation.sessionClass', new Set(['ephemeral', 'persistent']))
  enumeration(isolation.memoryClass, 'ResolvedComposition.isolation.memoryClass', new Set(['none', 'session', 'persistent']))

  const resources = record(composition.resources, 'ResolvedComposition.resources')
  exactKeys(resources, ['classes'], 'ResolvedComposition.resources')
  identityArray(resources.classes, 'ResolvedComposition.resources.classes')
  const health = record(composition.health, 'ResolvedComposition.health')
  exactKeys(health, ['required', 'optional'], 'ResolvedComposition.health')
  const requiredHealth = identityArray(health.required, 'ResolvedComposition.health.required')
  const optionalHealth = identityArray(health.optional, 'ResolvedComposition.health.optional')
  if (requiredHealth.some(item => optionalHealth.includes(item))) fail('schema-invalid', 'ResolvedComposition health classes overlap')

  const resolver = record(composition.resolver, 'ResolvedComposition.resolver')
  exactKeys(resolver, ['version', 'reason'], 'ResolvedComposition.resolver')
  parseSemver(resolver.version)
  enumeration(resolver.reason, 'ResolvedComposition.resolver.reason', new Set(['initial', 'update', 'rollback', 'reconcile']))
  if (computeDocumentDigest(composition) !== metadata.digest) {
    fail('digest-invalid', 'ResolvedComposition metadata digest does not match canonical bytes')
  }
  return value
}

export function validateCompositionLockReceipt(value: unknown, resolvedComposition?: unknown) {
  const receipt = record(value, 'CompositionLockReceipt')
  assertNoSecretShape(receipt, 'CompositionLockReceipt', 0, { count: 0 }, false)
  assertPublicState(receipt, 'CompositionLockReceipt')
  exactKeys(receipt, ['apiVersion', 'kind', 'digest', 'resolvedCompositionDigest', 'resolver', 'inputDigests', 'reason'], 'CompositionLockReceipt')
  documentIdentity(receipt, 'CompositionLockReceipt')
  digest(receipt.digest, 'CompositionLockReceipt.digest')
  digest(receipt.resolvedCompositionDigest, 'CompositionLockReceipt.resolvedCompositionDigest')
  const resolver = record(receipt.resolver, 'CompositionLockReceipt.resolver')
  exactKeys(resolver, ['version'], 'CompositionLockReceipt.resolver')
  parseSemver(resolver.version)
  const inputs = record(receipt.inputDigests, 'CompositionLockReceipt.inputDigests')
  exactKeys(inputs, ['profile', 'descriptors', 'catalogSnapshot', 'publicPolicy'], 'CompositionLockReceipt.inputDigests')
  digest(inputs.profile, 'CompositionLockReceipt.inputDigests.profile')
  digestArray(inputs.descriptors, 'CompositionLockReceipt.inputDigests.descriptors')
  digest(inputs.catalogSnapshot, 'CompositionLockReceipt.inputDigests.catalogSnapshot')
  digest(inputs.publicPolicy, 'CompositionLockReceipt.inputDigests.publicPolicy')
  enumeration(receipt.reason, 'CompositionLockReceipt.reason', new Set(['initial', 'update', 'rollback', 'reconcile']))
  if (computeDocumentDigest(receipt) !== receipt.digest) {
    fail('digest-invalid', 'CompositionLockReceipt digest does not match canonical bytes')
  }
  if (resolvedComposition !== undefined) {
    validateResolvedComposition(resolvedComposition)
    const composition = ((resolvedComposition) as Record<string, any>)
    if (receipt.resolvedCompositionDigest !== composition.metadata.digest
      || receipt.resolver.version !== composition.resolver.version
      || receipt.reason !== composition.resolver.reason
      || receipt.inputDigests.profile !== composition.profile.digest
      || receipt.inputDigests.publicPolicy !== composition.publicPolicyDigest
      || receipt.inputDigests.descriptors.join('\0')
        !== ((composition.plugins) as Record<string, any>[])
          .map(item => item.descriptorDigest).sort().join('\0')) {
      fail('schema-invalid', 'CompositionLockReceipt does not bind the resolved composition sibling')
    }
  }
  return value
}

/** Select the oldest mutually supported immutable schema for a new or retained lock. */
export function selectCompositionApiVersion(options: {kind: string, readerApiVersions: string[], writerApiVersions: string[], deprecatedApiVersions?: string[], priorLockApiVersion?: string}) {
  if (!COMPOSITION_KINDS.includes(options?.kind)) fail('unsupported-kind', 'composition kind is unsupported')
  const readers = unique(array(options.readerApiVersions, 'readerApiVersions', string), 'readerApiVersions')
  const writers = unique(array(options.writerApiVersions, 'writerApiVersions', string), 'writerApiVersions')
  const deprecated = new Set(array(options.deprecatedApiVersions ?? [], 'deprecatedApiVersions', string))
  if (options.priorLockApiVersion !== undefined) {
    const prior = string(options.priorLockApiVersion, 'priorLockApiVersion', 128)
    if (prior !== COMPOSITION_API_VERSION || !readers.includes(prior)) {
      fail('compatibility-unsupported', 'prior lock schema is not readable and cannot be downgraded')
    }
    return prior
  }
  const mutuallySupported = [COMPOSITION_API_VERSION].filter(version => readers.includes(version) && writers.includes(version))
  if (mutuallySupported.length === 0) fail('compatibility-unsupported', 'reader and writer share no supported composition schema')
  const selected = mutuallySupported[0]
  if (deprecated.has(selected)) {
    fail('deprecated-new-lock', 'deprecated composition schema cannot create a new lock')
  }
  return selected
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort()
}

/** Resolve a public, private-state-free composition and its sibling lock receipt. */
export function resolveComposition(input: {
    profile: unknown,
    plugins: unknown[],
    runtime: {dshVersion: string, runtimeKitVersion: string, pluginApiVersion: string, platform: string, resolverVersion: string},
    publicPolicy: {digest: string, grants: string[], networkClasses: string[], workspaceClasses: string[], resourceClasses: string[]},
    catalogSnapshotDigest: string,
    reason: 'initial' | 'update' | 'rollback' | 'reconcile',
    priorLock?: unknown,
    expectedPriorLockDigest?: string,
  }) {
  validateBotProfile(input.profile)
  const profile = ((input.profile) as Record<string, any>)
  if (!Array.isArray(input.plugins) || input.plugins.length > MAX_COLLECTION) {
    fail('schema-invalid', 'plugin catalog must be a bounded array')
  }
  const catalog: Record<string, any>[] = input.plugins.map(item => {
    validatePluginDescriptor(item)
    return ((item) as Record<string, any>)
  })
  const artifactIdentities = catalog.map(item => `${item.metadata.id}\0${item.metadata.version}`)
  if (new Set(artifactIdentities).size !== artifactIdentities.length) {
    fail('duplicate-id', 'plugin catalog contains a duplicate plugin artifact')
  }
  digest(input.catalogSnapshotDigest, 'catalogSnapshotDigest')
  if (computeCatalogSnapshotDigest(catalog) !== input.catalogSnapshotDigest) {
    fail('catalog-digest-mismatch', 'plugin catalog snapshot digest does not match the presented catalog')
  }

  const runtime = record(input.runtime, 'runtime')
  exactKeys(runtime, ['dshVersion', 'runtimeKitVersion', 'pluginApiVersion', 'platform', 'resolverVersion'], 'runtime')
  parseSemver(runtime.dshVersion)
  parseSemver(runtime.runtimeKitVersion)
  parseSemver(runtime.pluginApiVersion)
  identity(runtime.platform, 'runtime.platform')
  parseSemver(runtime.resolverVersion)
  validatePublicPolicy(input.publicPolicy)
  const policy = record(input.publicPolicy, 'PublicPolicyCeiling')
  const policyGrants = ((policy.grants) as string[])
  const policyNetworks = ((policy.networkClasses) as string[])
  const policyWorkspaces = ((policy.workspaceClasses) as string[])
  const policyResources = ((policy.resourceClasses) as string[])
  const profileGrantSet = new Set(((profile.grants) as string[]))
  const policyGrantSet = new Set(policyGrants)
  const profileNetworkSet = new Set(((profile.limits.networkClasses) as string[]))
  const policyNetworkSet = new Set(policyNetworks)
  const policyWorkspaceSet = new Set(policyWorkspaces)
  const policyResourceSet = new Set(policyResources)
  const requiredHealthSet = new Set(((profile.requiredHealth) as string[]))
  enumeration(input.reason, 'reason', new Set(['initial', 'update', 'rollback', 'reconcile']))

  if (input.priorLock !== undefined || input.expectedPriorLockDigest !== undefined) {
    if (input.priorLock === undefined || input.expectedPriorLockDigest === undefined) {
      fail('stale-prior-lock', 'prior lock and expected digest must be presented together')
    }
    validateCompositionLockReceipt(input.priorLock)
    digest(input.expectedPriorLockDigest, 'expectedPriorLockDigest')
    if (((input.priorLock) as Record<string, any>).digest !== input.expectedPriorLockDigest) {
      fail('stale-prior-lock', 'expected prior composition lock does not match current prior lock')
    }
  }

  const byId: Map<string, Record<string, any>[]> = new Map()
  const parsedCatalogVersions: Map<string, ParsedSemver> = new Map()
  for (const item of catalog) {
    if (!parsedCatalogVersions.has(item.metadata.version)) {
      parsedCatalogVersions.set(item.metadata.version, parseSemver(item.metadata.version))
    }
    const versions = byId.get(item.metadata.id) ?? []
    versions.push(item)
    byId.set(item.metadata.id, versions)
  }
  for (const versions of byId.values()) {
    versions.sort((left, right) => compareSemver(
      ((parsedCatalogVersions.get(right.metadata.version)) as ParsedSemver),
      ((parsedCatalogVersions.get(left.metadata.version)) as ParsedSemver),
    )
      || left.metadata.digest.localeCompare(right.metadata.digest))
  }

  let resolutionWorkUnits = 0
  const spendResolutionWork = (units: number = 1) => {
    resolutionWorkUnits += units
    if (resolutionWorkUnits > MAX_RESOLUTION_WORK_UNITS) {
      fail('compatibility-unsupported', 'composition resolution exceeded its deterministic work bound')
    }
  }
  const runtimeCompatibility: Map<string, boolean> = new Map()
  for (const item of catalog) {
    spendResolutionWork()
    runtimeCompatibility.set(item.metadata.digest, descriptorSupportsRuntime(runtime, item))
  }
  const satisfactionCache: Map<string, boolean> = new Map()
  const satisfies = (version: string, range: string) => {
    const key = `${version}\0${range}`
    const cached = satisfactionCache.get(key)
    if (cached !== undefined) return cached
    spendResolutionWork()
    const result = versionSatisfies(version, range)
    satisfactionCache.set(key, result)
    return result
  }

  const staticDependencyFailureCache: Map<string, string | null> = new Map()
  const staticDependencyFailure = (item: Record<string, any>) : string | null => {
    if (staticDependencyFailureCache.has(item.metadata.digest)) {
      return ((staticDependencyFailureCache.get(item.metadata.digest)) as string | null)
    }
    let failureCode: string | null = null
    for (const dependency of ((item.capabilities.dependencies) as Record<string, any>[])) {
      if (dependency.scope !== 'required') continue
      spendResolutionWork()
      const dependencyVersions = byId.get(dependency.id)
      if (dependencyVersions === undefined || dependencyVersions.length === 0) {
        failureCode = 'missing-requirement'
        break
      }
      const viable = dependencyVersions.some(candidate => {
        spendResolutionWork()
        return runtimeCompatibility.get(candidate.metadata.digest) === true
          && satisfies(candidate.metadata.version, dependency.range)
      })
      if (!viable) {
        failureCode = 'compatibility-unsupported'
        break
      }
    }
    staticDependencyFailureCache.set(item.metadata.digest, failureCode)
    return failureCode
  }

  const evaluateSelection = (candidateSelection: Map<string, Record<string, any>>) : {failureCode: string} | {
    ordered: Record<string, any>[],
    requiredCapabilities: string[],
    requestedNetworks: string[],
    effectiveWorkspaces: string[],
    requestedResources: string[],
    requiredHealth: string[],
    optionalHealth: string[],
  } => {
    for (const item of candidateSelection.values()) {
      const conflicts = ((item.composition.conflicts) as string[])
      spendResolutionWork(1 + conflicts.length)
      if (conflicts.some(conflict => candidateSelection.has(conflict))) {
        return { failureCode: 'composition-conflict' }
      }
    }

    const namespaceOwners: Map<string, string> = new Map()
    for (const item of candidateSelection.values()) {
      for (const claim of item.composition.namespaceClaims) {
        spendResolutionWork()
        const owner = namespaceOwners.get(claim)
        if (owner !== undefined && owner !== item.metadata.id) {
          return { failureCode: 'composition-conflict' }
        }
        namespaceOwners.set(claim, item.metadata.id)
      }
    }

    const edges: Map<string, Set<string>> = new Map()
    const indegree: Map<string, number> = new Map()
    for (const id of [...candidateSelection.keys()].sort()) {
      edges.set(id, new Set())
      indegree.set(id, 0)
    }
    const addEdge = (source: string, target: string) => {
      const targets = edges.get(source)
      if (targets === undefined || !indegree.has(target)) return
      if (!targets.has(target)) {
        targets.add(target)
        indegree.set(target, ((indegree.get(target)) as number) + 1)
      }
    }
    for (const item of candidateSelection.values()) {
      spendResolutionWork()
      const id = item.metadata.id
      for (const dependency of ((item.capabilities.dependencies) as Record<string, any>[])) {
        spendResolutionWork()
        if (dependency.scope === 'required' || candidateSelection.has(dependency.id)) {
          addEdge(dependency.id, id)
        }
      }
      spendResolutionWork(
        item.composition.ordering.before.length + item.composition.ordering.after.length,
      )
      for (const target of item.composition.ordering.before) addEdge(id, target)
      for (const source of item.composition.ordering.after) addEdge(source, id)
    }

    const ordered: Record<string, any>[] = []
    const ready = [...indegree.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort()
    let readyIndex = 0
    while (readyIndex < ready.length) {
      spendResolutionWork()
      const id = ((ready[readyIndex]) as string)
      readyIndex += 1
      ordered.push(((candidateSelection.get(id)) as Record<string, any>))
      const targets = [...((edges.get(id)) as Set<string>)]
      spendResolutionWork(Math.max(1, targets.length))
      for (const target of targets.sort()) {
        const remaining = ((indegree.get(target)) as number) - 1
        indegree.set(target, remaining)
        if (remaining === 0) {
          spendResolutionWork(Math.max(1, ready.length - readyIndex))
          let lower = readyIndex
          let upper = ready.length
          while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2)
            if (ready[middle].localeCompare(target) < 0) lower = middle + 1
            else upper = middle
          }
          ready.splice(lower, 0, target)
        }
      }
    }
    if (ordered.length !== candidateSelection.size) return { failureCode: 'dependency-cycle' }

    const capabilityRequests = ordered.flatMap(item => [
      ...item.capabilities.requires,
      ...((item.actions) as Record<string, any>[]).map(action => action.capability),
    ])
    spendResolutionWork(Math.max(1, capabilityRequests.length))
    const requiredCapabilities = sortedUnique(capabilityRequests)
    if (requiredCapabilities.some(capability => !profileGrantSet.has(capability)
      || !policyGrantSet.has(capability))) {
      return { failureCode: 'authority-over-grant' }
    }
    const networkRequests = ordered.flatMap(item => item.mediation.network)
    spendResolutionWork(Math.max(1, networkRequests.length))
    const requestedNetworks = sortedUnique(networkRequests)
    if (requestedNetworks.some(item => !profileNetworkSet.has(item)
      || !policyNetworkSet.has(item))) {
      return { failureCode: 'authority-over-grant' }
    }
    const profileWorkspaces = ((profile.limits.workspaceClasses) as string[])
    spendResolutionWork(Math.max(1, profileWorkspaces.length))
    const effectiveWorkspaces = profileWorkspaces.filter(item => policyWorkspaceSet.has(item)).sort()
    if (effectiveWorkspaces.length !== profile.limits.workspaceClasses.length) {
      return { failureCode: 'authority-over-grant' }
    }
    spendResolutionWork(Math.max(1, ordered.length))
    const requestedResources = sortedUnique(ordered.map(item => item.mediation.resources.cpuClass))
    if (requestedResources.some(item => !policyResourceSet.has(item))) {
      return { failureCode: 'authority-over-grant' }
    }
    const probes = ordered.flatMap(item => item.health.probes)
    spendResolutionWork(Math.max(1, probes.length + profile.requiredHealth.length))
    const probeIds = new Set(probes.map(item => item.id))
    if (((profile.requiredHealth) as string[])
      .some(requirement => !probeIds.has(requirement))) {
      return { failureCode: 'missing-requirement' }
    }
    const requiredHealth = sortedUnique(profile.requiredHealth)
    const optionalHealth = sortedUnique(probes
      .filter(item => item.requirement === 'optional' && !requiredHealthSet.has(item.id))
      .map(item => item.id))
    return {
      ordered,
      requiredCapabilities,
      requestedNetworks,
      effectiveWorkspaces,
      requestedResources,
      requiredHealth,
      optionalHealth,
    }
  }

  const initialConstraints: Map<string, string[]> = new Map()
  const addConstraint = (constraints: Map<string, string[]>, id: string, range: string) => {
    const ranges = constraints.get(id) ?? []
    spendResolutionWork(1 + ranges.length)
    if (ranges.includes(range)) return false
    constraints.set(id, [...ranges, range].sort())
    return true
  }
  spendResolutionWork(Math.max(1, profile.plugins.length))
  for (const requirement of [...profile.plugins].sort((left, right) => left.id.localeCompare(right.id))) {
    addConstraint(initialConstraints, requirement.id, requirement.range)
  }

  let resolutionStates = 0
  const solve = (sourceConstraints: Map<string, string[]>, sourceSelected: Map<string, Record<string, any>>) : {selected: Map<string, Record<string, any>>, evaluation: Record<string, any>} | {failureCode: string} => {
    resolutionStates += 1
    spendResolutionWork(1 + sourceConstraints.size + sourceSelected.size)
    if (resolutionStates > MAX_RESOLUTION_STATES) {
      fail('compatibility-unsupported', 'composition resolution exceeded its deterministic search bound')
    }
    const constraints = new Map(
      [...sourceConstraints].map(([id, ranges]) => [id, [...ranges]]),
    )
    const candidateSelection = new Map(sourceSelected)
    const unresolvedIds = new Set(
      [...constraints.keys()].filter(id => !candidateSelection.has(id)),
    )
    const pendingSelected = new Set(candidateSelection.keys())
    const optionalDependents: Map<string, Set<string>> = new Map()

    const queueConstraint = (id: string, range: string) => {
      const wasPresent = constraints.has(id)
      const changed = addConstraint(constraints, id, range)
      if (changed) {
        if (candidateSelection.has(id)) pendingSelected.add(id)
        else unresolvedIds.add(id)
      }
      if (!wasPresent) {
        for (const ownerId of optionalDependents.get(id) ?? []) pendingSelected.add(ownerId)
      }
    }

    while (true) {
      while (pendingSelected.size > 0) {
        const pendingBatch = [...pendingSelected].sort()
        pendingSelected.clear()
        spendResolutionWork(Math.max(1, pendingBatch.length))
        for (const id of pendingBatch) {
          const item = ((candidateSelection.get(id)) as Record<string, any>)
          const ranges = constraints.get(id) ?? []
          spendResolutionWork(Math.max(1, ranges.length))
          if (runtimeCompatibility.get(item.metadata.digest) !== true
            || ranges.some(range => !satisfies(item.metadata.version, range))) {
            return { failureCode: 'compatibility-unsupported' }
          }
          const staticFailure = staticDependencyFailure(item)
          if (staticFailure !== null) return { failureCode: staticFailure }
          const dependencies = ((item.capabilities.dependencies) as Record<string, any>[])
          spendResolutionWork(Math.max(1, dependencies.length))
          for (const dependency of [...dependencies].sort((left, right) => left.id.localeCompare(right.id))) {
            spendResolutionWork()
            if (dependency.scope === 'optional') {
              const owners = optionalDependents.get(dependency.id) ?? new Set()
              owners.add(id)
              optionalDependents.set(dependency.id, owners)
              if (!constraints.has(dependency.id)) continue
            }
            queueConstraint(dependency.id, dependency.range)
          }
        }
      }

      const unresolved = [...unresolvedIds].sort()
      spendResolutionWork(Math.max(1, unresolved.length))
      if (unresolved.length === 0) {
        const evaluation = evaluateSelection(candidateSelection)
        return 'failureCode' in evaluation
          ? evaluation
          : { selected: candidateSelection, evaluation }
      }
      const options: {id: string, candidates: Record<string, any>[]}[] = []
      for (const id of unresolved) {
        const versions = byId.get(id)
        if (versions === undefined || versions.length === 0) return { failureCode: 'missing-requirement' }
        const ranges = ((constraints.get(id)) as string[])
        const candidates: Record<string, any>[] = []
        const staticFailures: string[] = []
        for (const item of versions) {
          spendResolutionWork(1 + ranges.length)
          if (runtimeCompatibility.get(item.metadata.digest) !== true
            || !ranges.every(range => satisfies(item.metadata.version, range))) continue
          const staticFailure = staticDependencyFailure(item)
          if (staticFailure === null) candidates.push(item)
          else staticFailures.push(staticFailure)
        }
        if (candidates.length === 0) {
          return { failureCode: staticFailures[0] ?? 'compatibility-unsupported' }
        }
        options.push({ id, candidates })
      }
      const singletonOptions = options.filter(option => option.candidates.length === 1)
      if (singletonOptions.length > 0) {
        spendResolutionWork(singletonOptions.length)
        for (const option of singletonOptions) {
          candidateSelection.set(option.id, option.candidates[0])
          unresolvedIds.delete(option.id)
          pendingSelected.add(option.id)
        }
        continue
      }
      const choice = options.reduce((best, option) => option.candidates.length < best.candidates.length
        ? option
        : best)
      const failures: string[] = []
      for (const candidate of choice.candidates) {
        spendResolutionWork()
        const branch = new Map(candidateSelection)
        branch.set(choice.id, candidate)
        const result = solve(constraints, branch)
        if ('selected' in result) return result
        failures.push(result.failureCode)
      }
      return { failureCode: ((failures[0]) as string) }
    }
  }

  const solution = solve(initialConstraints, new Map())
  if (!('selected' in solution)) {
    fail(solution.failureCode, 'composition constraints have no valid solution')
  }
  const ordered = ((solution.evaluation.ordered) as Record<string, any>[])
  const requiredCapabilities = ((solution.evaluation.requiredCapabilities) as string[])
  const requestedNetworks = ((solution.evaluation.requestedNetworks) as string[])
  const effectiveWorkspaces = ((solution.evaluation.effectiveWorkspaces) as string[])
  const requestedResources = ((solution.evaluation.requestedResources) as string[])
  const requiredHealth = ((solution.evaluation.requiredHealth) as string[])
  const optionalHealth = ((solution.evaluation.optionalHealth) as string[])

  const composition: Record<string, any> = {
    apiVersion: COMPOSITION_API_VERSION,
    kind: 'ResolvedComposition',
    metadata: { digest: `sha256:${'0'.repeat(64)}` },
    runtime: {
      dshVersion: runtime.dshVersion,
      runtimeKitVersion: runtime.runtimeKitVersion,
      pluginApiVersion: runtime.pluginApiVersion,
      platform: runtime.platform,
      compatibilityDecision: 'compatible',
    },
    profile: {
      id: profile.metadata.id,
      version: profile.metadata.version,
      digest: profile.metadata.digest,
      workloadClass: profile.workload.class,
      scopeClass: profile.workload.scopeClass,
    },
    plugins: ordered.map((item, dependencyOrder) => ({
      id: item.metadata.id,
      version: item.metadata.version,
      descriptorDigest: item.metadata.digest,
      artifactDigest: item.artifact.digest,
      dependencyOrder,
      configurationDigest: item.configuration.schemaDigest,
    })),
    authorityCeiling: {
      capabilities: requiredCapabilities,
      networkClasses: requestedNetworks,
      workspaceClasses: effectiveWorkspaces,
    },
    publicPolicyDigest: policy.digest,
    modelRouteClass: profile.modelRouteClass,
    isolation: {
      workspaceClass: profile.state.workspace,
      sessionClass: profile.state.session,
      memoryClass: profile.state.memory,
    },
    resources: { classes: requestedResources },
    health: { required: requiredHealth, optional: optionalHealth },
    resolver: { version: runtime.resolverVersion, reason: input.reason },
  }
  composition.metadata.digest = computeDocumentDigest(composition)
  validateResolvedComposition(composition)

  const receipt: Record<string, any> = {
    apiVersion: COMPOSITION_API_VERSION,
    kind: 'CompositionLockReceipt',
    digest: `sha256:${'0'.repeat(64)}`,
    resolvedCompositionDigest: composition.metadata.digest,
    resolver: { version: runtime.resolverVersion },
    inputDigests: {
      profile: profile.metadata.digest,
      descriptors: ordered.map(item => item.metadata.digest).sort(),
      catalogSnapshot: input.catalogSnapshotDigest,
      publicPolicy: policy.digest,
    },
    reason: input.reason,
  }
  receipt.digest = computeDocumentDigest(receipt)
  validateCompositionLockReceipt(receipt, composition)
  return deepFreeze({ composition, receipt })
}

function deepFreeze<T>(value: T): Readonly<T>  {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const VALIDATE_FAILURE_CODES = new Set(COMPOSITION_PROTOCOL_FAILURE_CODES.validate)
const RESOLVE_FAILURE_CODES = new Set(COMPOSITION_PROTOCOL_FAILURE_CODES.resolve)
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

function requestId(value: unknown, path: string): string  {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)
    || isSecretShapedText(value)) {
    fail('invalid-request', `${path} is invalid`, { path })
  }
  return value
}

function runtimeIdentity(value: unknown, path: string) {
  const runtime = record(value, path)
  exactKeys(runtime, ['dshVersion', 'runtimeKitVersion', 'pluginApiVersion', 'platform'], path)
  parseSemver(runtime.dshVersion, `${path}.dshVersion`)
  parseSemver(runtime.runtimeKitVersion, `${path}.runtimeKitVersion`)
  parseSemver(runtime.pluginApiVersion, `${path}.pluginApiVersion`)
  identity(runtime.platform, `${path}.platform`)
  return runtime
}

function readerSchemas(value: unknown, path: string) {
  const schemas = array(value, path, (item, itemPath) => {
    const schema = record(item, itemPath)
    exactKeys(schema, ['apiVersion', 'kind'], itemPath)
    if (schema.apiVersion !== COMPOSITION_API_VERSION) {
      fail('unsupported-api-version', `${itemPath}.apiVersion is unsupported`)
    }
    if (!COMPOSITION_KINDS.includes(schema.kind)) {
      fail('unsupported-kind', `${itemPath}.kind is unsupported`)
    }
    return schema
  })
  const pairs = schemas.map(item => `${item.apiVersion}\0${item.kind}`)
  unique(pairs, path)
  for (const kind of COMPOSITION_KINDS) {
    if (!pairs.includes(`${COMPOSITION_API_VERSION}\0${kind}`)) {
      fail('unsupported-kind', `${path} does not advertise ${kind}`)
    }
  }
  return schemas
}

function detachedJson(value: unknown, path: string) {
  try {
    assertCanonicalByteLimit(value, MAX_PROTOCOL_BYTES, path)
    return parseCanonicalJsonText(canonicalJson(value))
  } catch (error) {
    if (error instanceof CompositionContractError) throw error
    fail('schema-invalid', `${path} is not detachable JSON`, { path })
  }
}

function descriptorSupportsRuntime(runtime: Record<string, any>, descriptor: Record<string, any>) {
  return versionSatisfies(runtime.dshVersion, descriptor.compatibility.dsh)
    && versionSatisfies(runtime.runtimeKitVersion, descriptor.compatibility.runtimeKit)
    && versionSatisfies(runtime.pluginApiVersion, descriptor.compatibility.pluginApi)
    && descriptor.compatibility.platforms.includes(runtime.platform)
}

function assertRuntimeCompatibility(runtime: Record<string, any>, descriptor: Record<string, any>) {
  if (!descriptorSupportsRuntime(runtime, descriptor)) {
    fail('compatibility-unsupported', `plugin ${descriptor.metadata.id} is incompatible with the runtime`)
  }
}

function freezeProtocolDocument(document: Record<string, any>): Readonly<Record<string, any>>  {
  validateCompositionProtocolResult(document)
  return deepFreeze(document)
}

/**
 * Validate and detach one strict public composition protocol request without
 * executing policy resolution or mutating a composition service.
 */
export function validateCompositionProtocolRequest(value: unknown) {
  const detached = ((detachedJson(value, 'composition protocol request')) as Record<string, any>)
  assertNoSecretShape(detached, 'composition protocol request', 0, { count: 0 }, false)
  if (detached.kind === 'ValidateCompositionRequest') {
    exactKeys(detached, [
      'apiVersion', 'kind', 'requestId', 'descriptors', 'profile', 'readerSchemas', 'runtime',
    ], 'ValidateCompositionRequest')
    if (detached.apiVersion !== COMPOSITION_API_VERSION) fail('unsupported-api-version', 'ValidateCompositionRequest apiVersion is unsupported')
    requestId(detached.requestId, 'ValidateCompositionRequest.requestId')
    readerSchemas(detached.readerSchemas, 'ValidateCompositionRequest.readerSchemas')
    const runtime = runtimeIdentity(detached.runtime, 'ValidateCompositionRequest.runtime')
    const descriptors = array(detached.descriptors, 'ValidateCompositionRequest.descriptors', item => {
      validatePluginDescriptor(item)
      return ((item) as Record<string, any>)
    })
    if (descriptors.length === 0) fail('schema-invalid', 'ValidateCompositionRequest requires a descriptor')
    unique(descriptors.map(item => `${item.metadata.id}\0${item.metadata.version}`), 'ValidateCompositionRequest.descriptors')
    validateBotProfile(detached.profile)
    for (const descriptor of descriptors) assertRuntimeCompatibility(runtime, descriptor)
    return detached
  }
  if (detached.kind === 'ResolveCompositionRequest') {
    exactKeys(detached, [
      'apiVersion', 'kind', 'requestId', 'validatedDocumentDigests',
      'catalogSnapshotDigest', 'runtime', 'publicPolicyCeilingDigest',
    ], 'ResolveCompositionRequest')
    if (detached.apiVersion !== COMPOSITION_API_VERSION) fail('invalid-request', 'ResolveCompositionRequest apiVersion is unsupported')
    requestId(detached.requestId, 'ResolveCompositionRequest.requestId')
    runtimeIdentity(detached.runtime, 'ResolveCompositionRequest.runtime')
    const validatedDigests = record(detached.validatedDocumentDigests, 'ResolveCompositionRequest.validatedDocumentDigests')
    exactKeys(validatedDigests, ['profile', 'descriptors'], 'ResolveCompositionRequest.validatedDocumentDigests')
    digest(validatedDigests.profile, 'ResolveCompositionRequest.validatedDocumentDigests.profile')
    digestArray(validatedDigests.descriptors, 'ResolveCompositionRequest.validatedDocumentDigests.descriptors')
    digest(detached.catalogSnapshotDigest, 'ResolveCompositionRequest.catalogSnapshotDigest')
    digest(detached.publicPolicyCeilingDigest, 'ResolveCompositionRequest.publicPolicyCeilingDigest')
    return detached
  }
  fail('unsupported-kind', 'composition protocol request kind is unsupported')
}

function failureCorrelationId(request: unknown) {
  try {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return null
    const prototype = Object.getPrototypeOf(request)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptor = Object.getOwnPropertyDescriptor(request, 'requestId')
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return null
    }
    const candidate = descriptor.value
    return typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)
      && !isSecretShapedText(candidate) ? candidate : null
  } catch {
    return null
  }
}

function protocolFailure(operation: string, request: unknown, error: unknown) {
  const sourceCode = error instanceof CompositionContractError ? error.code : 'invalid-request'
  let code = sourceCode
  if (operation === 'validate') {
    const mapped = ((COMPOSITION_VALIDATE_ERROR_MAP) as Record<string, string | undefined>)[code]
    if (mapped === undefined || !VALIDATE_FAILURE_CODES.has(mapped)) {
      throw new Error('unmapped composition validate failure code')
    }
    code = mapped
  } else {
    const mapped = ((COMPOSITION_RESOLVE_ERROR_MAP) as Record<string, string | undefined>)[code]
    if (mapped === undefined || !RESOLVE_FAILURE_CODES.has(mapped)) {
      throw new Error('unmapped composition resolve failure code')
    }
    code = mapped
  }
  const correlation = failureCorrelationId(request)
  return freezeProtocolDocument({
    apiVersion: COMPOSITION_API_VERSION,
    kind: operation === 'validate' ? 'ValidateCompositionFailed' : 'ResolveCompositionFailed',
    requestId: correlation,
    code,
    retryable: false,
    observedState: null,
    identity: null,
    receiptDigest: null,
    details: {},
  })
}

function validationKey(runtime: Record<string, any>, descriptorDigests: string[], profileDigest: string) {
  return canonicalJson({
    descriptorDigests: [...descriptorDigests].sort(),
    profileDigest,
    runtime: {
      dshVersion: runtime.dshVersion,
      runtimeKitVersion: runtime.runtimeKitVersion,
      pluginApiVersion: runtime.pluginApiVersion,
      platform: runtime.platform,
    },
  })
}

export function validateCompositionProtocolResult(value: unknown) {
  const result = record(value, 'composition protocol result')
  assertNoSecretShape(result, 'composition protocol result', 0, { count: 0 }, false)
  if (result.apiVersion !== COMPOSITION_API_VERSION) {
    fail('unsupported-api-version', 'composition protocol result apiVersion is unsupported')
  }
  const kind = string(result.kind, 'composition protocol result.kind', 128)
  if (kind === 'ValidateCompositionSucceeded') {
    exactKeys(result, [
      'apiVersion', 'kind', 'requestId', 'validator', 'descriptorDigests',
      'profileDigest', 'compatibilityResult', 'warningCodes',
    ], kind)
    requestId(result.requestId, `${kind}.requestId`)
    const validator = record(result.validator, `${kind}.validator`)
    exactKeys(validator, ['version'], `${kind}.validator`)
    parseSemver(validator.version, `${kind}.validator.version`)
    const descriptorDigests = digestArray(result.descriptorDigests, `${kind}.descriptorDigests`)
    if (descriptorDigests.join('\0') !== [...descriptorDigests].sort().join('\0')) {
      fail('schema-invalid', `${kind}.descriptorDigests must be sorted`)
    }
    digest(result.profileDigest, `${kind}.profileDigest`)
    if (result.compatibilityResult !== 'compatible') {
      fail('compatibility-unsupported', `${kind}.compatibilityResult is unsupported`)
    }
    const warningCodes = identityArray(result.warningCodes, `${kind}.warningCodes`)
    if (warningCodes.length !== 0) {
      fail('schema-invalid', `${kind}.warningCodes contains an unsupported v1 warning`)
    }
    return value
  }
  if (kind === 'ResolveCompositionSucceeded') {
    exactKeys(result, [
      'apiVersion', 'kind', 'requestId', 'resolvedComposition',
      'resolvedCompositionDigest', 'compositionLockReceipt',
      'compositionLockReceiptDigest', 'dependencyOrder',
      'publicEffectiveAuthorityDigest', 'resolver',
    ], kind)
    requestId(result.requestId, `${kind}.requestId`)
    validateResolvedComposition(result.resolvedComposition)
    validateCompositionLockReceipt(result.compositionLockReceipt, result.resolvedComposition)
    const composition = ((result.resolvedComposition) as Record<string, any>)
    const receipt = ((result.compositionLockReceipt) as Record<string, any>)
    if (digest(result.resolvedCompositionDigest, `${kind}.resolvedCompositionDigest`) !== composition.metadata.digest
      || digest(result.compositionLockReceiptDigest, `${kind}.compositionLockReceiptDigest`) !== receipt.digest) {
      fail('digest-invalid', `${kind} sibling digest field does not match its document`)
    }
    const dependencyOrder = identityArray(result.dependencyOrder, `${kind}.dependencyOrder`)
    const compositionOrder = ((composition.plugins) as Record<string, any>[]).map(item => item.id)
    if (dependencyOrder.join('\0') !== compositionOrder.join('\0')) {
      fail('schema-invalid', `${kind}.dependencyOrder does not match the resolved composition`)
    }
    const authorityDigest = digest(result.publicEffectiveAuthorityDigest, `${kind}.publicEffectiveAuthorityDigest`)
    if (authorityDigest !== domainSeparatedDigest(
      PUBLIC_EFFECTIVE_AUTHORITY_DOMAIN_TAG,
      composition.authorityCeiling,
    )) {
      fail('digest-invalid', `${kind}.publicEffectiveAuthorityDigest does not match the authority ceiling`)
    }
    const resolver = record(result.resolver, `${kind}.resolver`)
    exactKeys(resolver, ['version'], `${kind}.resolver`)
    const resolverVersion = parseSemver(resolver.version, `${kind}.resolver.version`).source
    if (resolverVersion !== composition.resolver.version || resolverVersion !== receipt.resolver.version) {
      fail('schema-invalid', `${kind}.resolver does not match its sibling documents`)
    }
    return value
  }
  if (kind === 'ValidateCompositionFailed' || kind === 'ResolveCompositionFailed') {
    exactKeys(result, [
      'apiVersion', 'kind', 'requestId', 'code', 'retryable', 'observedState',
      'identity', 'receiptDigest', 'details',
    ], kind)
    if (result.requestId !== null) requestId(result.requestId, `${kind}.requestId`)
    const code = string(result.code, `${kind}.code`, 128)
    const allowed = kind === 'ValidateCompositionFailed'
      ? VALIDATE_FAILURE_CODES
      : RESOLVE_FAILURE_CODES
    if (!allowed.has(code)) fail('schema-invalid', `${kind}.code is unsupported`)
    if (result.retryable !== false || result.observedState !== null
      || result.identity !== null || result.receiptDigest !== null) {
      fail('schema-invalid', `${kind} contains an impossible read-only failure claim`)
    }
    const details = record(result.details, `${kind}.details`)
    exactKeys(details, [], `${kind}.details`)
    return value
  }
  fail('unsupported-kind', 'composition protocol result kind is unsupported')
}

/**
 * Create the strict manager-facing composition.validate/composition.resolve port.
 * The policy resolver is an authenticated owner adapter; request bytes carry only
 * its immutable digest and can never supply replacement policy authority.
 */
export function createCompositionService(options: {validatorVersion: string, resolverVersion: string, resolvePublicPolicy: (digest: string) => unknown}) {
  const configuration = record(options, 'composition service options')
  exactKeys(configuration, ['validatorVersion', 'resolverVersion', 'resolvePublicPolicy'], 'composition service options')
  const validatorVersion = parseSemver(configuration.validatorVersion, 'validatorVersion').source
  const resolverVersion = parseSemver(configuration.resolverVersion, 'resolverVersion').source
  if (typeof configuration.resolvePublicPolicy !== 'function') {
    fail('schema-invalid', 'resolvePublicPolicy must be a function')
  }
  const resolvePublicPolicy = ((configuration.resolvePublicPolicy) as (digest: string) => unknown)
  const validations: Map<string, {profile: Record<string, any>, descriptors: Record<string, any>[], runtime: Record<string, any>}> = new Map()

  const validate = (request: unknown) => {
    try {
      const detached = validateCompositionProtocolRequest(request)
      if (detached.kind !== 'ValidateCompositionRequest') {
        fail('unsupported-kind', 'ValidateCompositionRequest kind is unsupported')
      }
      const correlation = detached.requestId
      const runtime = detached.runtime
      const descriptors = ((detached.descriptors) as Record<string, any>[])
      const profile = ((detached.profile) as Record<string, any>)
      const descriptorDigests = descriptors.map(item => item.metadata.digest).sort()
      const key = validationKey(runtime, descriptorDigests, profile.metadata.digest)
      validations.set(key, { profile, descriptors, runtime })
      if (validations.size > MAX_COLLECTION) validations.delete(((validations.keys().next().value) as string))
      return freezeProtocolDocument({
        apiVersion: COMPOSITION_API_VERSION,
        kind: 'ValidateCompositionSucceeded',
        requestId: correlation,
        validator: { version: validatorVersion },
        descriptorDigests,
        profileDigest: profile.metadata.digest,
        compatibilityResult: 'compatible',
        warningCodes: [],
      })
    } catch (error) {
      return protocolFailure('validate', request, error)
    }
  }

  const resolve = (request: unknown) => {
    try {
      const detached = validateCompositionProtocolRequest(request)
      if (detached.kind !== 'ResolveCompositionRequest') {
        fail('invalid-request', 'ResolveCompositionRequest kind is unsupported')
      }
      const correlation = detached.requestId
      const runtime = detached.runtime
      const validatedDigests = detached.validatedDocumentDigests
      const profileDigest = validatedDigests.profile
      const descriptorDigests = [...validatedDigests.descriptors].sort()
      const key = validationKey(runtime, descriptorDigests, profileDigest)
      const validation = validations.get(key)
      if (validation === undefined) fail('input-not-validated', 'resolve inputs have not passed composition.validate')
      const catalogSnapshotDigest = detached.catalogSnapshotDigest
      if (computeCatalogSnapshotDigest(validation.descriptors) !== catalogSnapshotDigest) {
        fail('catalog-digest-mismatch', 'catalog snapshot does not match the validated descriptors')
      }
      const policyDigest = detached.publicPolicyCeilingDigest
      let policy
      try { policy = resolvePublicPolicy(policyDigest) } catch { fail('policy-denied', 'public policy could not be resolved') }
      if (policy === undefined || policy === null || typeof ((policy) as any)?.then === 'function') {
        fail('policy-denied', 'public policy could not be resolved synchronously')
      }
      try {
        validatePublicPolicy(policy)
      } catch (error) {
        if (error instanceof CompositionContractError && error.code === 'digest-invalid') throw error
        fail('policy-denied', 'public policy owner returned an unusable policy')
      }
      if (((policy) as Record<string, any>).digest !== policyDigest) {
        fail('digest-invalid', 'resolved public policy does not match the requested digest')
      }
      const result = resolveComposition({
        profile: validation.profile,
        plugins: validation.descriptors,
        catalogSnapshotDigest,
        runtime: (({
          dshVersion: validation.runtime.dshVersion,
          runtimeKitVersion: validation.runtime.runtimeKitVersion,
          pluginApiVersion: validation.runtime.pluginApiVersion,
          platform: validation.runtime.platform,
          resolverVersion,
        }) as {dshVersion: string, runtimeKitVersion: string, pluginApiVersion: string, platform: string, resolverVersion: string}),
        publicPolicy: ((policy) as any),
        reason: 'initial',
      })
      const dependencyOrder = ((result.composition.plugins) as Record<string, any>[])
        .map(item => item.id)
      const publicEffectiveAuthorityDigest = domainSeparatedDigest(
        PUBLIC_EFFECTIVE_AUTHORITY_DOMAIN_TAG,
        result.composition.authorityCeiling,
      )
      return freezeProtocolDocument({
        apiVersion: COMPOSITION_API_VERSION,
        kind: 'ResolveCompositionSucceeded',
        requestId: correlation,
        resolvedComposition: result.composition,
        resolvedCompositionDigest: result.composition.metadata.digest,
        compositionLockReceipt: result.receipt,
        compositionLockReceiptDigest: result.receipt.digest,
        dependencyOrder,
        publicEffectiveAuthorityDigest,
        resolver: { version: resolverVersion },
      })
    } catch (error) {
      return protocolFailure('resolve', request, error)
    }
  }

  return Object.freeze({ validate, resolve })
}
