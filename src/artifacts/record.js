// @ts-check

import { ARTIFACT_CODES, ArtifactError } from './errors.js'

export const ARTIFACT_RECORD_SCHEMA = 'dsh-runtime-kit.artifact-record.v1'
export const ARTIFACT_ID_PATTERN = /^[0-9a-f]{32}$/
export const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
export const WORKSPACE_DIGEST_PATTERN = /^(?:sha256:[0-9a-f]{64}|unmanaged)$/
export const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
export const RETENTION_CLASSES = Object.freeze(/** @type {const} */ (['session', 'retained']))
export const CAPABILITIES = Object.freeze(/** @type {const} */ (['read', 'present', 'download', 'export', 'delete']))

/** ASCII control characters (C0 range plus DEL) as a character-class body, built without escape literals. */
export const CONTROL_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`
/** Matches any string that contains an ASCII control character. */
export const CONTAINS_CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'u')
/** Matches only strings free of ASCII control characters. */
export const PRINTABLE = new RegExp(`^[^${CONTROL_CLASS}]*$`, 'u')

/** @typedef {typeof RETENTION_CLASSES[number]} RetentionClass */
/** @typedef {typeof CAPABILITIES[number]} ArtifactCapability */

/**
 * Durable, bounded metadata for one immutable artifact. Never carries a
 * storage location.
 * @typedef ArtifactRecord
 * @property {typeof ARTIFACT_RECORD_SCHEMA} schema_version
 * @property {string} id
 * @property {string} sha256
 * @property {number} bytes
 * @property {string} media_type
 * @property {string} [name]
 * @property {string} owner_session_id
 * @property {string} workspace_digest
 * @property {string} producer_tool
 * @property {string} generation
 * @property {string} created_at
 * @property {RetentionClass} retention_class
 * @property {string} expires_at
 */

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const RECORD_KEYS = Object.freeze([
  'schema_version', 'id', 'sha256', 'bytes', 'media_type', 'name', 'owner_session_id',
  'workspace_digest', 'producer_tool', 'generation', 'created_at', 'retention_class', 'expires_at',
])

/** @param {string} message */
function invalid(message) {
  return new ArtifactError(message, ARTIFACT_CODES.METADATA_INVALID)
}

/** @param {unknown} value @param {number} maxBytes */
function boundedText(value, maxBytes) {
  return typeof value === 'string'
    && value.length > 0
    && PRINTABLE.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

/**
 * Validate one durable record. Accepts only the exact schema; a malformed or
 * partial record is a typed failure, never a partially trusted artifact.
 * @param {unknown} value
 * @param {string} [expectedId]
 * @returns {ArtifactRecord}
 */
export function validateArtifactRecord(value, expectedId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('artifact record is not an object')
  const record = /** @type {Record<string, unknown>} */ (value)
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.includes(key)) throw invalid('artifact record carries an unknown field')
  }
  if (record.schema_version !== ARTIFACT_RECORD_SCHEMA) throw invalid('artifact record schema is unsupported')
  if (typeof record.id !== 'string' || !ARTIFACT_ID_PATTERN.test(record.id)) throw invalid('artifact record id is invalid')
  if (expectedId !== undefined && record.id !== expectedId) throw invalid('artifact record id does not match its index entry')
  if (typeof record.sha256 !== 'string' || !ARTIFACT_DIGEST_PATTERN.test(record.sha256)) throw invalid('artifact record digest is invalid')
  if (!Number.isSafeInteger(record.bytes) || /** @type {number} */ (record.bytes) < 0) throw invalid('artifact record size is invalid')
  if (typeof record.media_type !== 'string' || !MEDIA_TYPE_PATTERN.test(record.media_type)) throw invalid('artifact record media type is invalid')
  if (record.name !== undefined && !boundedText(record.name, 255)) throw invalid('artifact record name is invalid')
  if (!boundedText(record.owner_session_id, 512)) throw invalid('artifact record owner is invalid')
  if (typeof record.workspace_digest !== 'string' || !WORKSPACE_DIGEST_PATTERN.test(record.workspace_digest)) throw invalid('artifact record workspace is invalid')
  if (!boundedText(record.producer_tool, 128)) throw invalid('artifact record producer is invalid')
  if (!boundedText(record.generation, 128)) throw invalid('artifact record generation is invalid')
  if (typeof record.created_at !== 'string' || !ISO_PATTERN.test(record.created_at)) throw invalid('artifact record creation time is invalid')
  if (typeof record.retention_class !== 'string' || !RETENTION_CLASSES.includes(/** @type {RetentionClass} */ (record.retention_class))) {
    throw invalid('artifact record retention class is invalid')
  }
  if (typeof record.expires_at !== 'string' || !ISO_PATTERN.test(record.expires_at)) throw invalid('artifact record expiry is invalid')
  return /** @type {ArtifactRecord} */ (Object.freeze({ ...record }))
}

/**
 * Public projection shared by the service API. Identical information to the
 * durable record minus the internal id; the opaque reference stands in for it.
 * @param {ArtifactRecord} record
 */
export function projectRecord(record) {
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

/** @typedef {ReturnType<typeof projectRecord>} ArtifactProjection */

/**
 * Tool-facing snake_case projection.
 * @param {ArtifactRecord} record
 */
export function projectRecordForTool(record) {
  return {
    ref: `artifact:${record.id}`,
    sha256: record.sha256,
    bytes: record.bytes,
    media_type: record.media_type,
    ...(record.name === undefined ? {} : { name: record.name }),
    owner_session_id: record.owner_session_id,
    workspace_digest: record.workspace_digest,
    producer_tool: record.producer_tool,
    generation: record.generation,
    created_at: record.created_at,
    expires_at: record.expires_at,
    retention_class: record.retention_class,
  }
}
