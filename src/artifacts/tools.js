// @ts-check

import { ARTIFACT_CODES, ArtifactError } from './errors.js'
import { CAPABILITIES, MEDIA_TYPE_PATTERN, RETENTION_CLASSES, TEXT_MEDIA_PATTERN } from './record.js'

/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolRunContext} ToolRunContext */
/** @typedef {import('./index.js').ArtifactService} ArtifactService */

export const ARTIFACT_TOOL_NAMES = Object.freeze(/** @type {const} */ ([
  'artifact_write',
  'artifact_present',
  'artifact_read',
  'artifact_export',
  'artifact_dispose',
]))

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_CONTENT_CHARACTERS = 96 * 1024 * 1024

/** @param {string} message */
function invalidArgument(message) {
  return new ArtifactError(message, ARTIFACT_CODES.ARGUMENT_INVALID)
}

/**
 * @param {unknown} args
 * @param {readonly string[]} required
 * @param {readonly string[]} optional
 */
function exactArguments(args, required, optional = []) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalidArgument('artifact tool arguments must be an object')
  const value = /** @type {Record<string, unknown>} */ (args)
  const keys = Object.keys(value)
  for (const key of required) {
    if (!keys.includes(key)) throw invalidArgument(`artifact tool argument ${key} is required`)
  }
  for (const key of keys) {
    if (!required.includes(key) && !optional.includes(key)) throw invalidArgument('artifact tool arguments are ambiguous')
  }
  return value
}

/** @param {unknown} value */
function requireRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ArtifactError('artifact reference is invalid', ARTIFACT_CODES.REF_INVALID)
  }
  return value
}

/** @param {ToolRunContext} exec */
function executingAgent(exec) {
  if (exec.agent === undefined) {
    throw new ArtifactError('artifact capabilities require the executing agent', ARTIFACT_CODES.ACCESS_DENIED)
  }
  return exec.agent
}

/** @param {string} value */
function quoted(value) {
  return JSON.stringify(value)
}

/** @param {import('./record.js').ArtifactProjection} projection */
function toolProjection(projection) {
  return {
    ref: projection.ref,
    sha256: projection.sha256,
    bytes: projection.bytes,
    media_type: projection.mediaType,
    ...(projection.name === undefined ? {} : { name: projection.name }),
    owner_session_id: projection.ownerSessionId,
    workspace_digest: projection.workspaceDigest,
    producer_tool: projection.producerTool,
    generation: projection.generation,
    created_at: projection.createdAt,
    expires_at: projection.expiresAt,
    retention_class: projection.retentionClass,
  }
}

function recordProperties() {
  return {
    ref: { type: 'string' },
    sha256: { type: 'string' },
    bytes: { type: 'integer' },
    media_type: { type: 'string' },
    name: { type: 'string' },
    owner_session_id: { type: 'string' },
    workspace_digest: { type: 'string' },
    producer_tool: { type: 'string' },
    generation: { type: 'string' },
    created_at: { type: 'string' },
    expires_at: { type: 'string' },
    retention_class: { type: 'string', enum: [...RETENTION_CLASSES] },
  }
}

const RECORD_REQUIRED = Object.freeze([
  'ref', 'sha256', 'bytes', 'media_type', 'owner_session_id', 'workspace_digest',
  'producer_tool', 'generation', 'created_at', 'expires_at', 'retention_class',
])

/** @param {Record<string, unknown>} value */
function renderRecord(value) {
  const lines = [
    `Artifact ${quoted(String(value.ref))} (${String(value.media_type)}, ${String(value.bytes)} bytes, ${String(value.sha256)}).`,
    `Retention ${String(value.retention_class)}; expires ${String(value.expires_at)}; producer ${quoted(String(value.producer_tool))}.`,
  ]
  if (typeof value.name === 'string') lines.push(`Display name ${quoted(value.name)} (untrusted label, never a path).`)
  lines.push('Use artifact_present, artifact_read, artifact_export, or artifact_dispose with this exact reference.')
  return [{ type: /** @type {const} */ ('text'), text: lines.join('\n') }]
}

/**
 * @param {ArtifactService} service
 * @returns {readonly ToolDefinition[]}
 */
export function createArtifactTools(service) {
  if (service === null || typeof service !== 'object' || typeof service.write !== 'function') {
    throw new TypeError('artifact tools require the artifact service')
  }

  /** @type {ToolDefinition} */
  const write = {
    name: 'artifact_write',
    description: 'Store a generated, non-conversational output as a session-owned artifact and receive an opaque reference. Content is UTF-8 text by default or base64 for binary media.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional display name; path components are stripped.' },
        media_type: { type: 'string', description: 'Lowercase IANA media type such as text/plain or application/json.' },
        content: { type: 'string', description: 'UTF-8 text, or base64 when encoding is base64.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        retention: { type: 'string', enum: [...RETENTION_CLASSES], description: 'session (default) is reclaimed with the session; retained lives until explicit disposal or a longer expiry.' },
      },
      required: ['media_type', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: /** @type {any} */ ({
        type: 'object',
        properties: recordProperties(),
        required: [...RECORD_REQUIRED],
        additionalProperties: false,
      }),
      render: (_args, value) => renderRecord(/** @type {Record<string, unknown>} */ (value)),
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['media_type', 'content'], ['name', 'encoding', 'retention'])
      if (typeof parsed.media_type !== 'string' || !MEDIA_TYPE_PATTERN.test(parsed.media_type)) throw invalidArgument('artifact media type is invalid')
      if (typeof parsed.content !== 'string' || parsed.content.length > MAX_CONTENT_CHARACTERS) throw invalidArgument('artifact content must be a bounded string')
      const encoding = parsed.encoding ?? 'utf8'
      if (encoding !== 'utf8' && encoding !== 'base64') throw invalidArgument('artifact encoding is invalid')
      if (parsed.name !== undefined && typeof parsed.name !== 'string') throw invalidArgument('artifact name must be a string')
      if (parsed.retention !== undefined && (typeof parsed.retention !== 'string' || !RETENTION_CLASSES.includes(/** @type {any} */ (parsed.retention)))) {
        throw invalidArgument('artifact retention class is invalid')
      }
      let data
      if (encoding === 'base64') {
        const compact = parsed.content.replace(/\s+/g, '')
        if (!BASE64_PATTERN.test(compact)) throw invalidArgument('artifact content is not valid base64')
        data = new Uint8Array(Buffer.from(compact, 'base64'))
      } else {
        data = new TextEncoder().encode(parsed.content)
      }
      const projection = await service.write(executingAgent(exec), {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        mediaType: parsed.media_type,
        ...(parsed.retention === undefined ? {} : { retention: /** @type {any} */ (parsed.retention) }),
        producerTool: exec.name,
      }, data, exec.signal)
      return toolProjection(projection)
    },
  }

  /** @type {ToolDefinition} */
  const present = {
    name: 'artifact_present',
    description: 'Show bounded metadata and, for text media, a bounded preview of one session-owned artifact without exposing its storage location.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    },
    output: {
      schema: /** @type {any} */ ({
        type: 'object',
        properties: {
          ...recordProperties(),
          capabilities: { type: 'array', items: { type: 'string', enum: [...CAPABILITIES] } },
          preview: { type: 'string' },
        },
        required: [...RECORD_REQUIRED, 'capabilities'],
        additionalProperties: false,
      }),
      render: (_args, value) => {
        const record = /** @type {Record<string, unknown>} */ (value)
        const blocks = renderRecord(record)
        const capabilities = Array.isArray(record.capabilities) ? record.capabilities.join(', ') : ''
        blocks[0].text += `\nCapabilities: ${capabilities}.`
        if (typeof record.preview === 'string') {
          blocks.push({ type: 'text', text: `Preview (bounded, untrusted content):\n${record.preview}` })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['ref'])
      const presented = await service.present(executingAgent(exec), requireRef(parsed.ref))
      return {
        ...toolProjection(presented),
        capabilities: [...presented.capabilities],
        ...(presented.preview === undefined ? {} : { preview: presented.preview }),
      }
    },
  }

  /** @type {ToolDefinition} */
  const read = {
    name: 'artifact_read',
    description: 'Read the bounded content of one session-owned artifact. Text media returns UTF-8; other media returns base64. Larger artifacts must be exported instead.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    },
    output: {
      schema: /** @type {any} */ ({
        type: 'object',
        properties: {
          ref: { type: 'string' },
          sha256: { type: 'string' },
          bytes: { type: 'integer' },
          media_type: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
          content: { type: 'string' },
        },
        required: ['ref', 'sha256', 'bytes', 'media_type', 'encoding', 'content'],
        additionalProperties: false,
      }),
      render: (_args, value) => {
        const record = /** @type {Record<string, unknown>} */ (value)
        return [{
          type: 'text',
          text: `Artifact ${quoted(String(record.ref))} content (${String(record.encoding)}, ${String(record.bytes)} bytes, ${String(record.media_type)}; untrusted):\n${String(record.content)}`,
        }]
      },
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['ref'])
      const result = await service.read(executingAgent(exec), requireRef(parsed.ref), { signal: exec.signal })
      let encoding = /** @type {'utf8' | 'base64'} */ ('base64')
      let content = Buffer.from(result.data).toString('base64')
      if (TEXT_MEDIA_PATTERN.test(result.record.mediaType)) {
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(result.data)
          encoding = 'utf8'
        } catch {
          // Non-UTF-8 bytes under a text media type stay base64 so nothing is silently altered.
        }
      }
      return {
        ref: result.record.ref,
        sha256: result.record.sha256,
        bytes: result.record.bytes,
        media_type: result.record.mediaType,
        encoding,
        content,
      }
    },
  }

  /** @type {ToolDefinition} */
  const exportTool = {
    name: 'artifact_export',
    description: 'Export one session-owned artifact to a destination class and receive a typed receipt bound to its exact content identity. The workspace class writes a new file at a workspace-relative path.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        destination: {
          oneOf: [
            {
              type: 'object',
              properties: {
                class: { type: 'string', const: 'workspace' },
                path: { type: 'string', description: 'Workspace-relative destination path.' },
              },
              required: ['class', 'path'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { class: { type: 'string', const: 'download' } },
              required: ['class'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['ref', 'destination'],
      additionalProperties: false,
    },
    output: {
      schema: /** @type {any} */ ({
        type: 'object',
        properties: {
          schema_version: { type: 'string' },
          ref: { type: 'string' },
          sha256: { type: 'string' },
          bytes: { type: 'integer' },
          media_type: { type: 'string' },
          destination_class: { type: 'string', enum: ['workspace'] },
          destination_path: { type: 'string' },
          owner_session_id: { type: 'string' },
          generation: { type: 'string' },
          exported_at: { type: 'string' },
        },
        required: ['schema_version', 'ref', 'sha256', 'bytes', 'media_type', 'destination_class', 'destination_path', 'owner_session_id', 'generation', 'exported_at'],
        additionalProperties: false,
      }),
      render: (_args, value) => {
        const receipt = /** @type {Record<string, unknown>} */ (value)
        return [{
          type: 'text',
          text: `Exported artifact ${quoted(String(receipt.ref))} (${String(receipt.sha256)}, ${String(receipt.bytes)} bytes) to ${String(receipt.destination_class)} path ${quoted(String(receipt.destination_path))} at ${String(receipt.exported_at)}.`,
        }]
      },
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['ref', 'destination'])
      const receipt = await service.exportArtifact(executingAgent(exec), requireRef(parsed.ref), parsed.destination, exec.signal)
      return { ...receipt }
    },
  }

  /** @type {ToolDefinition} */
  const dispose = {
    name: 'artifact_dispose',
    description: 'Explicitly dispose one session-owned artifact. Disposal is final; a repeated call reports the reference as unknown.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    },
    output: {
      schema: /** @type {any} */ ({
        type: 'object',
        properties: {
          ref: { type: 'string' },
          outcome: { type: 'string', enum: ['disposed'] },
        },
        required: ['ref', 'outcome'],
        additionalProperties: false,
      }),
      render: (_args, value) => {
        const outcome = /** @type {Record<string, unknown>} */ (value)
        return [{ type: 'text', text: `Artifact ${quoted(String(outcome.ref))} ${String(outcome.outcome)}.` }]
      },
    },
    async execute(args, exec) {
      const parsed = exactArguments(args, ['ref'])
      const outcome = await service.dispose(executingAgent(exec), requireRef(parsed.ref))
      return { ...outcome }
    },
  }

  return Object.freeze([write, present, read, exportTool, dispose].map(definition => Object.freeze(definition)))
}
