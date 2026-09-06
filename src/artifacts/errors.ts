import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable typed outcomes for every artifact capability. */
export const ARTIFACT_CODES = Object.freeze({
  ARGUMENT_INVALID: 'ARTIFACT_ARGUMENT_INVALID',
  REF_INVALID: 'ARTIFACT_REF_INVALID',
  ACCESS_DENIED: 'ARTIFACT_ACCESS_DENIED',
  NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  EXPIRED: 'ARTIFACT_EXPIRED',
  TOO_LARGE: 'ARTIFACT_TOO_LARGE',
  QUOTA_EXCEEDED: 'ARTIFACT_QUOTA_EXCEEDED',
  WRITE_FAILED: 'ARTIFACT_WRITE_FAILED',
  ABORTED: 'ARTIFACT_ABORTED',
  CORRUPT: 'ARTIFACT_CORRUPT',
  METADATA_INVALID: 'ARTIFACT_METADATA_INVALID',
  PROVIDER_UNAVAILABLE: 'ARTIFACT_PROVIDER_UNAVAILABLE',
  CAPABILITY_UNSUPPORTED: 'ARTIFACT_CAPABILITY_UNSUPPORTED',
  READ_TOO_LARGE: 'ARTIFACT_READ_TOO_LARGE',
  EXPORT_DESTINATION_INVALID: 'ARTIFACT_EXPORT_DESTINATION_INVALID',
  EXPORT_DENIED: 'ARTIFACT_EXPORT_DENIED',
  EXPORT_EXISTS: 'ARTIFACT_EXPORT_EXISTS',
})

export type ArtifactCode = typeof ARTIFACT_CODES[keyof typeof ARTIFACT_CODES]

/**
 * Typed artifact failure. Messages never carry content, digests of private
 * data, or storage locations; consumers route on `code`. The message is
 * prefixed with the code so a host that cannot attribute this class (for
 * example when the bundle resolves its own copy of the DSH error base) still
 * surfaces the exact typed outcome in the tool failure text.
 */
export class ArtifactError extends HarnessError {
  name

  constructor(message: string, code: ArtifactCode, options?: ErrorOptions) {
    super(`${code}: ${message}`, code, options)
    this.name = 'ArtifactError'
  }
}

const CODE_PREFIX = /^(ARTIFACT_[A-Z_]+):/

/**
 * Recover the typed artifact code from a DSH tool failure, preferring the
 * structured info and falling back to the message prefix.
 */

export function artifactFailureCode(failure: {info?: {code?: string}, message?: string} | undefined): string | undefined  {
  const structured = failure?.info?.code
  if (typeof structured === 'string' && structured.startsWith('ARTIFACT_')) return structured
  const match = typeof failure?.message === 'string' ? CODE_PREFIX.exec(failure.message) : null
  return match?.[1]
}

export function isArtifactError(error: unknown): error is ArtifactError  {
  return error instanceof ArtifactError
}

export function isErrno(error: unknown): error is NodeJS.ErrnoException  {
  return error instanceof Error && typeof (((error) as {code?: unknown}).code) === 'string'
}
