// @ts-check

import { createHash, timingSafeEqual } from 'node:crypto'

const MAX_AGENT_CONSOLE_ARTIFACT_BYTES = 8 * 1024 * 1024
const AGENT_CONSOLE_ARTIFACT_TIMEOUT_MS = 60_000

export class AgentConsoleArtifactError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'AgentConsoleArtifactError'
    this.code = code
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new AgentConsoleArtifactError(code, message)
}

/** @param {unknown} value */
function artifactContract(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact contract is invalid',
    )
  }
  const artifact = /** @type {Record<string, unknown>} */ (value)
  if (typeof artifact.tarball !== 'string'
    || typeof artifact.integrity !== 'string'
    || typeof artifact.shasum !== 'string') {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact contract is incomplete',
    )
  }

  let tarball
  try {
    tarball = new URL(artifact.tarball)
  } catch {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact URL is invalid',
    )
  }
  if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org') {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact must use the npm registry HTTPS origin',
    )
  }

  const integrityPrefix = 'sha512-'
  if (!artifact.integrity.startsWith(integrityPrefix)
    || !/^[0-9a-f]{40}$/u.test(artifact.shasum)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact digests are invalid',
    )
  }
  const expectedSha512 = Buffer.from(artifact.integrity.slice(integrityPrefix.length), 'base64')
  const expectedSha1 = Buffer.from(artifact.shasum, 'hex')
  if (expectedSha512.byteLength !== 64
    || expectedSha512.toString('base64') !== artifact.integrity.slice(integrityPrefix.length)
    || expectedSha1.byteLength !== 20) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_CONTRACT_INVALID',
      'dsh-runtime-kit: Agent Console artifact digests are invalid',
    )
  }

  return Object.freeze({
    tarball: artifact.tarball,
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    expectedSha512,
    expectedSha1,
  })
}

/**
 * Fetch the exact Agent Console TUI tarball into bounded memory and return its
 * bytes only after both repository-declared npm digests authenticate it.
 *
 * @param {unknown} value
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 */
export async function fetchAuthenticatedAgentConsoleArtifact(value, options = {}) {
  const artifact = artifactContract(value)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_DOWNLOAD_FAILED',
      'dsh-runtime-kit: Agent Console artifact fetch is unavailable',
    )
  }

  let response
  try {
    response = await fetchImpl(artifact.tarball, {
      method: 'GET',
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(AGENT_CONSOLE_ARTIFACT_TIMEOUT_MS),
      headers: { accept: 'application/octet-stream' },
    })
  } catch {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_DOWNLOAD_FAILED',
      'dsh-runtime-kit: Agent Console artifact download failed',
    )
  }
  if (!response.ok || response.status !== 200 || response.body === null) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_DOWNLOAD_FAILED',
      'dsh-runtime-kit: Agent Console artifact response is unavailable',
    )
  }

  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      fail(
        'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_DOWNLOAD_FAILED',
        'dsh-runtime-kit: Agent Console artifact length is invalid',
      )
    }
    if (Number(declaredLength) > MAX_AGENT_CONSOLE_ARTIFACT_BYTES) {
      await response.body.cancel().catch(() => {})
      fail(
        'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_TOO_LARGE',
        'dsh-runtime-kit: Agent Console artifact exceeds the download bound',
      )
    }
  }

  const chunks = []
  let received = 0
  const sha512 = createHash('sha512')
  const sha1 = createHash('sha1')
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      received += chunk.byteLength
      if (received > MAX_AGENT_CONSOLE_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => {})
        fail(
          'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_TOO_LARGE',
          'dsh-runtime-kit: Agent Console artifact exceeds the download bound',
        )
      }
      const bytes = Buffer.from(chunk)
      sha512.update(bytes)
      sha1.update(bytes)
      chunks.push(bytes)
    }
  } catch (error) {
    if (error instanceof AgentConsoleArtifactError) throw error
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_DOWNLOAD_FAILED',
      'dsh-runtime-kit: Agent Console artifact download failed',
    )
  } finally {
    reader.releaseLock()
  }

  const observedSha512 = sha512.digest()
  const observedSha1 = sha1.digest()
  if (!timingSafeEqual(observedSha512, artifact.expectedSha512)
    || !timingSafeEqual(observedSha1, artifact.expectedSha1)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_INTEGRITY_MISMATCH',
      'dsh-runtime-kit: Agent Console artifact digest does not match the contract',
    )
  }

  return Object.freeze({
    bytes: Buffer.concat(chunks, received),
    integrity: `sha512-${observedSha512.toString('base64')}`,
    shasum: observedSha1.toString('hex'),
  })
}
