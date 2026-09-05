// @ts-check

import { ARTIFACT_CODES, ArtifactError } from '../../src/artifacts/errors.js'
import { ARTIFACT_ID_PATTERN, digestBytes, validateArtifactRecord } from '../../src/artifacts/record.js'

/** @typedef {import('../../src/artifacts/record.js').ArtifactRecord} ArtifactRecord */
/** @typedef {import('../../src/artifacts/local-provider.js').ArtifactProvider} ArtifactProvider */

/**
 * Deterministic in-memory provider. It implements the exact provider contract
 * so the conformance suite proves the service lifecycle independently of the
 * filesystem, and it supports fault injection for provider-failure paths.
 * @implements {ArtifactProvider}
 */
export class MemoryArtifactProvider {
  capabilities = Object.freeze(/** @type {const} */ (['read', 'present', 'export', 'delete']))
  /** When true every operation reports the provider as unavailable. */
  unavailable = false
  /** @type {Map<string, ArtifactRecord>} */
  #records = new Map()
  /** @type {Map<string, Uint8Array>} */
  #objects = new Map()
  /** @type {Map<string, Uint8Array[]>} */
  #staging = new Map()
  /** @type {Map<string, Error>} */
  #failures = new Map()
  #initialized = false

  async init() {
    this.#initialized = true
  }

  /**
   * Fail the next call of one operation with the supplied error.
   * @param {'publish' | 'commit' | 'read' | 'remove' | 'begin'} operation
   * @param {Error} error
   */
  failNext(operation, error) {
    this.#failures.set(operation, error)
  }

  /** @param {string} operation */
  #check(operation) {
    if (!this.#initialized) throw new ArtifactError('artifact provider is not initialized', ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    if (this.unavailable) throw new ArtifactError('artifact provider is unavailable', ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
    const failure = this.#failures.get(operation)
    if (failure !== undefined) {
      this.#failures.delete(operation)
      throw failure
    }
  }

  stagingCount() {
    return this.#staging.size
  }

  async list() {
    this.#check('list')
    return Object.freeze([...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

  /** @param {string} id */
  async load(id) {
    this.#check('load')
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new ArtifactError('artifact id is invalid', ARTIFACT_CODES.REF_INVALID)
    return this.#records.get(id)
  }

  /** @param {{id: string, maxBytes: number}} draft */
  async begin(draft) {
    this.#check('begin')
    /** @type {Uint8Array[]} */
    const parts = []
    this.#staging.set(draft.id, parts)
    let bytes = 0
    let open = true
    return {
      write: async (/** @type {Uint8Array} */ chunk) => {
        if (!open) throw new ArtifactError('artifact writer is not open', ARTIFACT_CODES.WRITE_FAILED)
        if (bytes + chunk.byteLength > draft.maxBytes) {
          open = false
          this.#staging.delete(draft.id)
          throw new ArtifactError('artifact exceeds the configured byte limit', ARTIFACT_CODES.TOO_LARGE)
        }
        parts.push(new Uint8Array(chunk))
        bytes += chunk.byteLength
      },
      commit: async () => {
        if (!open) throw new ArtifactError('artifact writer is not open', ARTIFACT_CODES.WRITE_FAILED)
        open = false
        try {
          this.#check('commit')
        } catch (error) {
          this.#staging.delete(draft.id)
          throw error
        }
        const merged = new Uint8Array(bytes)
        let cursor = 0
        for (const part of parts) {
          merged.set(part, cursor)
          cursor += part.byteLength
        }
        const sha256 = digestBytes(merged)
        this.#objects.set(sha256, merged)
        this.#staging.delete(draft.id)
        return { sha256, bytes }
      },
      abort: async () => {
        open = false
        this.#staging.delete(draft.id)
      },
    }
  }

  /** @param {ArtifactRecord} record */
  async publish(record) {
    this.#check('publish')
    const validated = validateArtifactRecord(record)
    if (this.#records.has(validated.id)) throw new ArtifactError('artifact record already exists', ARTIFACT_CODES.WRITE_FAILED)
    this.#records.set(validated.id, validated)
  }

  /** @param {ArtifactRecord} record @param {AbortSignal} [signal] */
  async read(record, signal) {
    this.#check('read')
    signal?.throwIfAborted()
    const data = this.#objects.get(record.sha256)
    if (data === undefined || data.byteLength !== record.bytes) {
      throw new ArtifactError('artifact object is missing', ARTIFACT_CODES.CORRUPT)
    }
    return new Uint8Array(data)
  }

  /** @param {ArtifactRecord} record */
  async remove(record) {
    await this.removeMany([record])
  }

  /** @type {Set<string>} */
  #generations = new Set()

  /** @param {string} generation */
  async claimGeneration(generation) {
    this.#check('claim')
    this.#generations.add(generation)
  }

  /** @param {string} generation */
  async releaseGeneration(generation) {
    this.#generations.delete(generation)
  }

  /** @param {string} generation */
  async generationAlive(generation) {
    return this.#generations.has(generation)
  }

  async listGenerations() {
    return Object.freeze([...this.#generations].sort())
  }

  /** @param {readonly ArtifactRecord[]} records */
  async removeMany(records) {
    this.#check('remove')
    for (const record of records) this.#records.delete(record.id)
    const surviving = new Set([...this.#records.values()].map(candidate => candidate.sha256))
    for (const record of records) {
      if (!surviving.has(record.sha256)) this.#objects.delete(record.sha256)
    }
  }
}

export default MemoryArtifactProvider
