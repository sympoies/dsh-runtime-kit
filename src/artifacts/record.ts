import { createHash } from 'node:crypto'

import { ARTIFACT_CODES, ArtifactError } from './errors.js'

export const ARTIFACT_RECORD_SCHEMA = 'dsh-runtime-kit.artifact-record.v1'
export const ARTIFACT_ID_PATTERN = /^[0-9a-f]{32}$/
export const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
export const WORKSPACE_DIGEST_PATTERN = /^(?:sha256:[0-9a-f]{64}|unmanaged)$/
export const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
/** Media types whose bytes are presented and read as UTF-8 text when they decode cleanly. */
export const TEXT_MEDIA_PATTERN = /^(?:text\/|application\/(?:json|[a-z0-9.+-]+\+json)$)/

/** The durable content identity format shared by records, providers, and receipts. */
export function digestBytes(data: Uint8Array) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}
export const RETENTION_CLASSES = Object.freeze(((['session', 'retained']) as const))
export const CAPABILITIES = Object.freeze(((['read', 'present', 'download', 'export', 'delete']) as const))

/** ASCII control characters (C0 range plus DEL) as a character-class body, built without escape literals. */
export const CONTROL_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`
/** Matches any string that contains an ASCII control character. */
export const CONTAINS_CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'u')
/** Matches only strings free of ASCII control characters. */
export const PRINTABLE = new RegExp(`^[^${CONTROL_CLASS}]*$`, 'u')

export type RetentionClass = typeof RETENTION_CLASSES[number]
export type ArtifactCapability = typeof CAPABILITIES[number]

export type ArtifactRecord = { schema_version: typeof ARTIFACT_RECORD_SCHEMA, id: string, sha256: string, bytes: number, media_type: string, name?: string, owner_session_id: string, workspace_digest: string, producer_tool: string, generation: string, created_at: string, retention_class: RetentionClass, expires_at: string }
/**
 * Durable, bounded metadata for one immutable artifact. Never carries a
 * storage location.
 */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const RECORD_KEYS = Object.freeze([
  'schema_version', 'id', 'sha256', 'bytes', 'media_type', 'name', 'owner_session_id',
  'workspace_digest', 'producer_tool', 'generation', 'created_at', 'retention_class', 'expires_at',
])

function invalid(message: string) {
  return new ArtifactError(message, ARTIFACT_CODES.METADATA_INVALID)
}

function boundedText(value: unknown, maxBytes: number) {
  return typeof value === 'string'
    && value.length > 0
    && PRINTABLE.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

/**
 * Validate one durable record. Accepts only the exact schema; a malformed or
 * partial record is a typed failure, never a partially trusted artifact.
 */
export function validateArtifactRecord(value: unknown, expectedId?: string): ArtifactRecord  {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('artifact record is not an object')
  const record = ((value) as Record<string, unknown>)
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.includes(key)) throw invalid('artifact record carries an unknown field')
  }
  if (record.schema_version !== ARTIFACT_RECORD_SCHEMA) throw invalid('artifact record schema is unsupported')
  if (typeof record.id !== 'string' || !ARTIFACT_ID_PATTERN.test(record.id)) throw invalid('artifact record id is invalid')
  if (expectedId !== undefined && record.id !== expectedId) throw invalid('artifact record id does not match its index entry')
  if (typeof record.sha256 !== 'string' || !ARTIFACT_DIGEST_PATTERN.test(record.sha256)) throw invalid('artifact record digest is invalid')
  if (!Number.isSafeInteger(record.bytes) || ((record.bytes) as number) < 0) throw invalid('artifact record size is invalid')
  if (typeof record.media_type !== 'string' || !MEDIA_TYPE_PATTERN.test(record.media_type)) throw invalid('artifact record media type is invalid')
  if (record.name !== undefined && !boundedText(record.name, 255)) throw invalid('artifact record name is invalid')
  if (!boundedText(record.owner_session_id, 512)) throw invalid('artifact record owner is invalid')
  if (typeof record.workspace_digest !== 'string' || !WORKSPACE_DIGEST_PATTERN.test(record.workspace_digest)) throw invalid('artifact record workspace is invalid')
  if (!boundedText(record.producer_tool, 128)) throw invalid('artifact record producer is invalid')
  if (!boundedText(record.generation, 128)) throw invalid('artifact record generation is invalid')
  if (typeof record.created_at !== 'string' || !ISO_PATTERN.test(record.created_at)) throw invalid('artifact record creation time is invalid')
  if (typeof record.retention_class !== 'string' || !RETENTION_CLASSES.includes(((record.retention_class) as RetentionClass))) {
    throw invalid('artifact record retention class is invalid')
  }
  if (typeof record.expires_at !== 'string' || !ISO_PATTERN.test(record.expires_at)) throw invalid('artifact record expiry is invalid')
  return ((Object.freeze({ ...record })) as ArtifactRecord)
}

/**
 * Public projection shared by the service API. Identical information to the
 * durable record minus the internal id; the opaque reference stands in for it.
 */
export function projectRecord(record: ArtifactRecord) {
  return Object.freeze({
    ref: `artifact:${record.id}`,
    sha256: record.sha256,
    bytes: record.bytes,
    mediaType: record.media_type,
    ...(record.name === undefined ? {} : { name: record.name }),
    ownerSessionId: record.owner_session_id,
    workspaceDigest: record.workspace_digest,
    producerTool: record.producer_tool,
    generation: record.generation,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    retentionClass: record.retention_class,
  })
}

export type ArtifactProjection = ReturnType<typeof projectRecord>
