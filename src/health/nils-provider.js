// @ts-check

import { constants, fstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'

import { symbols } from '@deepseek-ai/cordis'

import { requiredAbsolutePath, resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import { isolatedNilsEnvironment } from '../nils/session-environment.js'
import { resolveSubprocessArgv } from '../nils/subprocess-command.js'

const OWNER = '@sympoies/dsh-runtime-kit'
const COMPATIBILITY_SCHEMA = 'dsh-runtime-kit.nils-compatibility.v1'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const RELEASE_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const MAX_BINARY_BYTES = 64 * 1024 * 1024
const MAX_STDOUT_BYTES = 128 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const COMMAND_QUIESCENCE_MS = 2_000

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} SubprocessHandle */

class HealthProbeFailure extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code)
    this.name = 'HealthProbeFailure'
    this.code = code
  }
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/** @param {unknown} value @param {string} code */
function requiredRecord(value, code) {
  const candidate = record(value)
  if (candidate === undefined) throw new HealthProbeFailure(code)
  return candidate
}

/** @param {any} value Unwrap Cordis' per-access trace proxy without weakening provider identity. */
function originalCordisService(value) {
  try {
    return value?.[symbols.original] ?? value
  } catch {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
  }
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('runtime health command aborted', 'AbortError')
}

/** @param {SubprocessHandle} handle @param {number} timeoutMs */
async function observeQuiescence(handle, timeoutMs) {
  let timer
  try {
    const firstObservation = Promise.resolve().then(() => handle.waitForExit())
    const observed = await Promise.race([
      firstObservation.then(value => ({ kind: /** @type {const} */ ('observed'), value })),
      new Promise(resolve => {
        timer = setTimeout(() => {
          try { handle.terminate() } catch {}
          resolve({ kind: /** @type {const} */ ('deadline') })
        }, timeoutMs)
      }),
    ])
    if (observed.kind === 'observed' && observed.value === true) return true
    if (observed.kind === 'observed') {
      try { handle.terminate() } catch {}
    }
    // A false or late observation is not authoritative completion. Drain the
    // terminated tree before reporting failure; a nonsettling provider keeps
    // this promise live so RuntimeHealth retains it in its draining set. When
    // the deadline won, retain both the original observation and an explicit
    // post-termination observation so neither can reject unobserved.
    if (observed.kind === 'deadline') {
      await Promise.allSettled([
        firstObservation,
        Promise.resolve().then(() => handle.waitForExit()),
      ])
    } else {
      await handle.waitForExit()
    }
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run one bounded, output-capped companion command through DSH's public
 * subprocess service. Completion is not accepted until the whole process tree
 * is observed quiescent.
 *
 * @param {Context} ctx
 * @param {string[]} argv
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @param {number} quiescenceMs
 * @param {(() => Promise<void>) | undefined} beforeSpawn
 * @param {((spec: Record<string, unknown>) => SubprocessHandle) | undefined} spawn
 */
async function runHealthCommand(ctx, argv, cwd, signal, quiescenceMs, beforeSpawn, spawn) {
  const resolvedArgv = await resolveSubprocessArgv(ctx, argv, signal)
  await beforeSpawn?.()
  if (signal.aborted) throw abortReason(signal)
  /** @type {SubprocessHandle | undefined} */
  let handle
  const onAbort = () => {
    try { handle?.terminate() } catch {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const spec = {
      argv: resolvedArgv,
      cwd,
      stdio: {
        stdin: { data: '' },
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: 1_000,
      signal,
      env: isolatedNilsEnvironment(undefined),
    }
    handle = spawn === undefined
      ? ctx.subprocess.spawn(spec)
      : spawn(spec)
    /** @type {() => void} */
    let onCompletionAbort = () => {}
    const aborted = new Promise((_, reject) => {
      onCompletionAbort = () => reject(abortReason(signal))
      signal.addEventListener('abort', onCompletionAbort, { once: true })
    })
    if (signal.aborted) {
      onAbort()
      onCompletionAbort()
    }
    let outcome
    let completionFailure
    try {
      outcome = await Promise.race([Promise.resolve(handle.done), aborted])
    } catch (error) {
      completionFailure = signal.aborted ? abortReason(signal) : error
    } finally {
      signal.removeEventListener('abort', onCompletionAbort)
      if (completionFailure !== undefined) {
        try { handle.terminate() } catch {}
      }
    }
    if (!await observeQuiescence(handle, quiescenceMs)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_QUIESCENCE_UNKNOWN')
    }
    if (completionFailure !== undefined) throw completionFailure
    if (signal.aborted) throw abortReason(signal)
    if (outcome === undefined) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_OUTPUT_INVALID')
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stdout.lossy || stderr?.lossy === true) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_OUTPUT_INVALID')
    }
    return Object.freeze({
      outcome: /** @type {{exitCode: number | null, signal: string | null}} */ (outcome),
      stdout: stdout.text,
    })
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** @param {import('node:fs').Stats} value */
function fingerprint(value) {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  })
}

/** @param {ReturnType<typeof fingerprint>} left @param {ReturnType<typeof fingerprint>} right */
function sameFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** @param {string} path */
async function assertTrustedExecutableAncestors(path) {
  const filesystemRoot = parse(path).root
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    const ancestor = await stat(cursor)
    const stickyTrusted = (ancestor.mode & 0o1000) !== 0
      && (ancestor.uid === 0
        || (typeof process.getuid === 'function' && ancestor.uid === process.getuid()))
    if (!ancestor.isDirectory() || ((ancestor.mode & 0o022) !== 0 && !stickyTrusted)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    if (cursor === filesystemRoot) break
  }
}

/** @param {string} path @param {string} expected @param {boolean} retainBytes */
async function inspectAuthenticatedBinary(path, expected, retainBytes) {
  const canonical = await realpath(path)
  await assertTrustedExecutableAncestors(canonical)
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const ownerTrusted = typeof process.getuid !== 'function'
      || before.uid === process.getuid() || before.uid === 0
    if (!before.isFile() || before.size <= 0 || before.size > MAX_BINARY_BYTES
      || (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0 || !ownerTrusted) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const identity = fingerprint(before)
    if (!sameFingerprint(identity, fingerprint(after))
      || createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    return Object.freeze({
      path: canonical,
      identity,
      ...(retainBytes ? { bytes } : {}),
    })
  } finally {
    await handle.close()
  }
}

/** @param {string} path @param {string} expected */
async function readAuthenticatedBinary(path, expected) {
  return /** @type {Awaited<ReturnType<typeof inspectAuthenticatedBinary>> & {bytes: Buffer}} */ (
    await inspectAuthenticatedBinary(path, expected, true)
  )
}

/** @param {{handle: import('node:fs/promises').FileHandle, identity: ReturnType<typeof fingerprint>}} binary */
async function assertBinaryUnchanged(binary) {
  const current = await binary.handle.stat()
  if (!sameFingerprint(binary.identity, fingerprint(current))) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
  }
}

/** @param {string} directory */
async function assertTrustedSnapshotRoot(directory) {
  const metadata = await stat(directory)
  const ownerTrusted = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || !ownerTrusted || (metadata.mode & 0o077) !== 0) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
  }
  const filesystemRoot = parse(directory).root
  for (let cursor = dirname(directory);; cursor = dirname(cursor)) {
    const ancestor = await stat(cursor)
    const stickyTrusted = (ancestor.mode & 0o1000) !== 0
      && (ancestor.uid === 0
        || (typeof process.getuid === 'function' && ancestor.uid === process.getuid()))
    if ((ancestor.mode & 0o022) !== 0 && !stickyTrusted) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    if (cursor === filesystemRoot) break
  }
}

/** @param {string} path @param {import('node:fs/promises').FileHandle} rootHandle */
async function pathReferencesOpenDirectory(path, rootHandle) {
  try {
    const [opened, projected] = await Promise.all([rootHandle.stat(), lstat(path)])
    return opened.isDirectory() && projected.isDirectory()
      && opened.dev === projected.dev && opened.ino === projected.ino
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * @param {string} path
 * @param {import('node:fs/promises').FileHandle} handle
 */
async function pathReferencesOpenFile(path, handle) {
  try {
    const [opened, projected] = await Promise.all([handle.stat(), lstat(path)])
    return opened.isFile() && projected.isFile()
      && opened.dev === projected.dev && opened.ino === projected.ino
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * @param {string} root
 * @param {string} name
 * @param {Buffer} bytes
 * @param {string} expected
 * @param {typeof open} openFile
 */
export async function snapshotExecutable(root, name, bytes, expected, openFile = open) {
  const path = join(root, name)
  const writer = await openFile(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o500,
  )
  let writerOpen = true
  let reader
  let createdIdentity
  try {
    const created = await writer.stat()
    if (!created.isFile()) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    createdIdentity = { dev: created.dev, ino: created.ino }
    await writer.writeFile(bytes)
    await writer.sync()
    await writer.chmod(0o500)
    await writer.close()
    writerOpen = false

    reader = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await reader.stat()
    const snapshotBytes = await reader.readFile()
    const after = await reader.stat()
    const identity = fingerprint(before)
    const ownerTrusted = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || !ownerTrusted || before.nlink !== 1
      || before.size <= 0 || before.size > MAX_BINARY_BYTES
      || (before.mode & 0o111) === 0 || (before.mode & 0o077) !== 0
      || !sameFingerprint(identity, fingerprint(after))
      || createHash('sha256').update(snapshotBytes).digest('hex') !== expected) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    return Object.freeze({ path, handle: reader, identity })
  } catch (error) {
    if (writerOpen) await writer.close().catch(() => {})
    await reader?.close().catch(() => {})
    if (createdIdentity !== undefined) {
      try {
        const projected = await lstat(path)
        if (projected.isFile()
          && projected.dev === createdIdentity.dev && projected.ino === createdIdentity.ino) {
          await unlink(path)
        }
      } catch (cleanupError) {
        if (record(cleanupError)?.code !== 'ENOENT') {
          process.emitWarning('dsh-runtime-kit: partial authenticated snapshot cleanup failed')
        }
      }
    }
    throw error
  }
}

/**
 * Publish one descriptor-authoritative snapshot only while its private linked
 * names still identify the authenticated inodes. The links are not execution
 * authority, but self-inspecting children need `/proc/self/exe` or
 * `process.execPath` to remain resolvable for their lifetime.
 *
 * @param {string} root
 * @param {import('node:fs/promises').FileHandle} rootHandle
 * @param {Array<Awaited<ReturnType<typeof snapshotExecutable>>>} binaries
 */
async function retainSnapshotLinks(root, rootHandle, binaries) {
  if (!await pathReferencesOpenDirectory(root, rootHandle)) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
  }
  for (const binary of binaries) {
    if (!await pathReferencesOpenFile(binary.path, binary.handle)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
    }
    const linked = await binary.handle.stat()
    if (linked.nlink !== 1 || !sameFingerprint(binary.identity, fingerprint(linked))) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
    }
  }
  if (!await pathReferencesOpenDirectory(root, rootHandle)) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
  }
  return binaries
}

/**
 * Retire linked snapshot names only when they still name the authenticated
 * inodes. Linux can unlink through the retained directory descriptor even if
 * the random root was renamed; other platforms preserve uncertain names and
 * warn instead of deleting a replacement.
 *
 * @param {string} root
 * @param {import('node:fs/promises').FileHandle} rootHandle
 * @param {Array<Awaited<ReturnType<typeof snapshotExecutable>>>} binaries
 */
async function cleanupLinkedSnapshot(root, rootHandle, binaries) {
  /** @type {unknown[]} */
  const failures = []
  let preservedName = false
  for (const binary of binaries) {
    const name = binary.path.slice(root.length + 1)
    const cleanupPath = process.platform === 'linux'
      ? `/proc/${process.pid}/fd/${rootHandle.fd}/${name}`
      : binary.path
    try {
      if (await pathReferencesOpenFile(cleanupPath, binary.handle)) {
        await unlink(cleanupPath)
      } else {
        preservedName = true
      }
    } catch (error) {
      if (record(error)?.code !== 'ENOENT') failures.push(error)
    }
  }
  const closeOutcomes = await Promise.allSettled(binaries.map(binary => binary.handle.close()))
  failures.push(...closeOutcomes.flatMap(
    outcome => outcome.status === 'rejected' ? [outcome.reason] : [],
  ))
  try {
    if (await pathReferencesOpenDirectory(root, rootHandle)) {
      await rmdir(root)
    } else {
      preservedName = true
    }
  } catch (error) {
    if (record(error)?.code === 'ENOTEMPTY' || record(error)?.code === 'EEXIST') {
      preservedName = true
    } else if (record(error)?.code !== 'ENOENT') {
      failures.push(error)
    }
  }
  await rootHandle.close().catch(error => failures.push(error))
  if (preservedName) {
    process.emitWarning('dsh-runtime-kit: preserved a replaced or relocated private snapshot name during cleanup')
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'dsh-runtime-kit: authenticated nils snapshot cleanup failed')
  }
}

/**
 * Own every resolve/spawn/quiescence interval that depends on the snapshot
 * descriptor. Closing rejects new direct probes and transport scopes, aborts
 * direct health commands, and retains the descriptor until every existing
 * transport scope has drained its own commands and cleanup.
 *
 * @param {() => Promise<void>} cleanup
 * @param {number} disposeTimeoutMs
 * @param {((spec: Record<string, unknown>) => SubprocessHandle) | undefined} spawn
 * @param {(message: string) => void} warn
 */
export function createSnapshotExecutionOwner(
  cleanup,
  disposeTimeoutMs = 2_000,
  spawn,
  warn = message => { process.emitWarning(message) },
) {
  let closing = false
  /** @type {Map<symbol, {controller: AbortController, settled: Promise<void>}>} */
  const active = new Map()
  /** @type {Map<symbol, Promise<void>>} */
  const scopes = new Map()
  /** @type {Promise<void> | undefined} */
  let disposal

  /** @param {AbortSignal} signal @param {Map<symbol, {controller: AbortController, settled: Promise<void>}>} leases */
  function acquire(signal, leases) {
    const token = Symbol('authenticated command lease')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(abortReason(signal))
    signal.addEventListener('abort', forwardAbort, { once: true })
    if (signal.aborted) forwardAbort()
    /** @type {() => void} */
    let settle = () => {}
    const settled = new Promise(resolve => { settle = /** @type {() => void} */ (resolve) })
    leases.set(token, { controller, settled })
    let released = false
    const release = () => {
      if (released) return
      released = true
      signal.removeEventListener('abort', forwardAbort)
      leases.delete(token)
      settle()
    }
    return Object.freeze({
      signal: controller.signal,
      release,
      ...(spawn === undefined ? {} : { spawn }),
    })
  }

  /** @param {AbortSignal} signal */
  function acquireDirect(signal) {
    if (closing) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING')
    }
    // No await occurs between the closing check and publication, so another
    // task cannot begin disposal in the middle of this critical section.
    return acquire(signal, active)
  }

  return Object.freeze({
    acquire: acquireDirect,
    createScope() {
      if (closing) {
        throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING')
      }
      const scopeToken = Symbol('authenticated transport scope')
      /** @type {Map<symbol, {controller: AbortController, settled: Promise<void>}>} */
      const scopeLeases = new Map()
      /** @type {() => void} */
      let settleScope = () => {}
      const scopeSettled = new Promise(resolve => {
        settleScope = /** @type {() => void} */ (resolve)
      })
      scopes.set(scopeToken, scopeSettled)
      /** @type {Promise<void> | undefined} */
      let scopeDisposal
      return Object.freeze({
        /** @param {AbortSignal} signal */
        acquire(signal) {
          if (scopeDisposal !== undefined) {
            throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING')
          }
          return acquire(signal, scopeLeases)
        },
        async dispose() {
          if (scopeDisposal === undefined) {
            const leases = [...scopeLeases.values()]
            for (const lease of leases) {
              lease.controller.abort(
                new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING'),
              )
            }
            scopeDisposal = Promise.allSettled(leases.map(lease => lease.settled)).then(() => {
              scopes.delete(scopeToken)
              settleScope()
            })
          }
          await scopeDisposal
        },
      })
    },
    /** @template T @param {AbortSignal} signal @param {(lease: ReturnType<typeof acquireDirect>) => Promise<T>} execute */
    async run(signal, execute) {
      const lease = acquireDirect(signal)
      try {
        return await execute(lease)
      } finally {
        lease.release()
      }
    },
    async dispose() {
      if (disposal === undefined) {
        closing = true
        const leases = [...active.values()]
        const scopeSettlements = [...scopes.values()]
        for (const lease of leases) {
          lease.controller.abort(
            new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_SNAPSHOT_CLOSING'),
          )
        }
        disposal = Promise.allSettled([
          ...leases.map(lease => lease.settled),
          ...scopeSettlements,
        ])
          .then(() => cleanup())
        // Retain the cleanup task after the bounded Cordis disposer returns
        // without turning a late cleanup error into an unhandled rejection.
        void disposal.catch(() => {
          warn('dsh-runtime-kit: authenticated nils snapshot cleanup failed')
        })
      }
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      try {
        await Promise.race([
          disposal,
          new Promise(resolve => { timer = setTimeout(resolve, disposeTimeoutMs) }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  })
}

/**
 * Run and authenticate one command while holding a snapshot execution lease.
 * @param {ReturnType<typeof createSnapshotExecutionOwner>} owner
 * @param {Context} ctx
 * @param {Awaited<ReturnType<typeof snapshotExecutable>>} binary
 * @param {string[]} argv
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @param {number} quiescenceMs
 * @param {(() => Promise<void>) | undefined} beforeSpawn
 */
async function runAuthenticatedHealthCommand(
  owner,
  ctx,
  binary,
  argv,
  cwd,
  signal,
  quiescenceMs,
  beforeSpawn,
) {
  return owner.run(signal, async lease => {
    const result = await runHealthCommand(
      ctx,
      argv,
      cwd,
      lease.signal,
      quiescenceMs,
      async () => {
        await beforeSpawn?.()
        await assertBinaryUnchanged(binary)
      },
      lease.spawn,
    )
    await assertBinaryUnchanged(binary)
    return result
  })
}

/**
 * Bind one already-authenticated open executable to DSH's native descriptor
 * spawn primitive. The private display pathname remains linked only so the
 * child can resolve its own executable; the retained descriptor remains the
 * sole execution authority.
 *
 * @param {Context} ctx
 * @param {Map<string, {handle: import('node:fs/promises').FileHandle, identity: ReturnType<typeof fingerprint>}>} binaries
 * @param {{service: any, mode: string, spawnDescriptor: Function}} binding
 */
function authenticatedDescriptorSpawner(ctx, binaries, binding) {
  return (/** @type {Record<string, any>} */ spec) => {
    const command = Array.isArray(spec.argv) ? spec.argv[0] : undefined
    const binary = typeof command === 'string' ? binaries.get(command) : undefined
    if (binary === undefined) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_INVALID')
    }
    let current
    try {
      current = fingerprint(fstatSync(binary.handle.fd))
    } catch {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
    }
    if (!sameFingerprint(binary.identity, current)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_CHANGED')
    }
    const tracedSubprocess = /** @type {any} */ (ctx.subprocess)
    const subprocess = originalCordisService(tracedSubprocess)
    if (subprocess !== binding.service
      || subprocess.descriptorSpawnMode !== binding.mode
      || subprocess.spawnDescriptor !== binding.spawnDescriptor) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
    }
    return binding.spawnDescriptor.call(tracedSubprocess, spec, binary.handle.fd)
  }
}

function runtimePlatformKey() {
  const key = `${process.platform}:${process.arch}`
  if (key === 'linux:x64') return 'x86_64-unknown-linux-gnu'
  if (key === 'darwin:arm64') return 'aarch64-apple-darwin'
  throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
}

/** @param {unknown} value @param {string} [platform] @param {string} [candidateFeature] */
export function resolveNilsHealthCompatibility(
  value,
  platform = runtimePlatformKey(),
  candidateFeature = undefined,
) {
  const root = requiredRecord(value, 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  if (root.schema_version !== COMPATIBILITY_SCHEMA) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  }
  let selected
  let version
  if (candidateFeature !== undefined) {
    const candidate = requiredRecord(
      root.candidate_validation,
      'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID',
    )
    if (typeof candidateFeature !== 'string'
      || candidate.feature !== candidateFeature
      || candidate.status !== 'reviewed-source-candidate'
      || typeof candidate.version !== 'string'
      || !/^\d+\.\d+\.\d+$/u.test(candidate.version)
      || typeof candidate.source_commit !== 'string'
      || !/^[0-9a-f]{40}$/u.test(candidate.source_commit)
      || candidate.platform !== platform) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
    }
    selected = candidate
    version = candidate.version
  } else {
    const release = requiredRecord(root.release, 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
    selected = release
    if (typeof release.platform === 'string' && release.platform !== platform) {
      const platforms = record(release.platforms)
      const candidate = record(platforms?.[platform])
      if (candidate === undefined) {
        throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
      }
      selected = candidate
    }
    const versionMatch = typeof release.source_revision === 'string'
      ? RELEASE_PATTERN.exec(release.source_revision)
      : null
    if (versionMatch === null) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
    }
    version = versionMatch.slice(1).join('.')
  }
  const artifacts = requiredRecord(selected.artifacts, 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  const hook = requiredRecord(artifacts['agent-hook'], 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  const docs = requiredRecord(artifacts['agent-docs'], 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  const session = requiredRecord(artifacts['agent-session'], 'DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  if (typeof hook.sha256 !== 'string' || !SHA256_PATTERN.test(hook.sha256)
    || typeof docs.sha256 !== 'string' || !SHA256_PATTERN.test(docs.sha256)
    || typeof session.sha256 !== 'string' || !SHA256_PATTERN.test(session.sha256)) {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  }
  return Object.freeze({
    version,
    platform,
    hookSha256: hook.sha256,
    docsSha256: docs.sha256,
    sessionSha256: session.sha256,
  })
}

async function loadCompatibility() {
  const source = await readFile(new URL('../../compatibility/nils-cli.json', import.meta.url), 'utf8')
  try {
    return JSON.parse(source)
  } catch {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPATIBILITY_INVALID')
  }
}

/** @param {unknown} error @param {AbortSignal} signal @param {string} fallback */
function blocked(error, signal, fallback) {
  if (signal.aborted) throw abortReason(signal)
  return {
    state: /** @type {const} */ ('blocked'),
    code: error instanceof HealthProbeFailure ? error.code : fallback,
  }
}

/** @param {unknown} value */
function validDshRuntime(value) {
  const versions = record(record(value)?.versions)
  return versions !== undefined
    && Object.keys(versions).length > 0
    && Object.values(versions).every(version => typeof version === 'string' && version.length > 0)
}

/** @param {unknown} value */
function validDoctor(value) {
  const envelope = record(value)
  if (envelope?.schema_version !== 'cli.agent-hook.doctor.v1'
    || envelope.ok !== true || !Array.isArray(envelope.data) || envelope.data.length !== 1) {
    return false
  }
  const row = record(envelope.data[0])
  return row?.product === 'dsh'
    && row.registration_owner === 'dsh-runtime-kit'
    && row.dispatch_supported === true
}

/** @param {unknown} value @param {string} docsHome @param {string} projectPath */
function validAudit(value, docsHome, projectPath) {
  const report = record(value)
  return report?.schema_version === 'agent-docs.audit.v2'
    && report.target === 'project'
    && report.product === null
    && report.strict === true
    && report.docs_home === docsHome
    && report.project_path === projectPath
    && Array.isArray(report.wiring)
    && Array.isArray(report.skills)
    && Array.isArray(report.documents)
    && Number.isSafeInteger(report.problems)
    && report.problems >= 0
    && Array.isArray(report.suggested_actions)
}

/** @param {Context} ctx @param {() => void} dispose @param {string} label */
function ownRegistration(ctx, dispose, label) {
  ctx.effect(() => dispose, label)
}

/**
 * Install authenticated nils and optional-child health providers.
 *
 * @param {Context} ctx
 * @param {import('./index.js').RuntimeHealth} health
 * @param {{agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, nilsCompatibilityCandidate?: string}} config
 * @param {{compatibility?: unknown, dshRuntime: unknown, childPlugins: {main_agent_mode: {state:string}, review_specialists: {state:string}}, commandQuiescenceMs?: number, beforeCommandSpawn?: () => Promise<void>}} options
 */
export async function installNilsHealthProviders(ctx, health, config, options) {
  if (health === undefined || typeof health.register !== 'function') {
    throw new TypeError('dsh-runtime-kit: runtime health service is required')
  }
  const compatibility = resolveNilsHealthCompatibility(
    options.compatibility ?? await loadCompatibility(),
    runtimePlatformKey(),
    config.nilsCompatibilityCandidate,
  )
  const expectedDescriptorSpawnMode = compatibility.platform === 'x86_64-unknown-linux-gnu'
    ? 'atomic-descriptor'
    : compatibility.platform === 'aarch64-apple-darwin'
      ? 'verified-transient'
      : undefined
  const commandQuiescenceMs = options.commandQuiescenceMs ?? COMMAND_QUIESCENCE_MS
  if (!Number.isSafeInteger(commandQuiescenceMs) || commandQuiescenceMs <= 0
    || commandQuiescenceMs > COMMAND_QUIESCENCE_MS) {
    throw new TypeError('dsh-runtime-kit: command quiescence deadline is invalid')
  }
  const subprocess = originalCordisService(/** @type {any} */ (ctx.subprocess))
  if (expectedDescriptorSpawnMode === undefined
    || subprocess.descriptorSpawnMode !== expectedDescriptorSpawnMode
    || typeof subprocess.spawnDescriptor !== 'function') {
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_EXECUTION_BINDING_UNSUPPORTED')
  }
  const descriptorBinding = Object.freeze({
    service: subprocess,
    mode: expectedDescriptorSpawnMode,
    spawnDescriptor: subprocess.spawnDescriptor,
  })
  const agentHook = resolveAgentHookRuntime(config)
  const agentDocs = config.agentDocs ?? 'agent-docs'
  if (typeof agentDocs !== 'string' || agentDocs.length === 0 || agentDocs.includes('\0')) {
    throw new TypeError('dsh-runtime-kit: agentDocs must be a non-empty executable name')
  }
  const docsHome = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
  requiredAbsolutePath(config.agentDocsStateHome, 'agentDocsStateHome')
  let runtimeCwd
  let canonicalDocsHome
  let sourceHook
  let sourceDocs
  let sourceSession
  try {
    runtimeCwd = await realpath(agentHook.stateDir)
    canonicalDocsHome = await realpath(docsHome)
    const prepareSignal = new AbortController().signal
    const hookArgv = await resolveSubprocessArgv(ctx, agentHook.argv([]), prepareSignal)
    const docsArgv = await resolveSubprocessArgv(ctx, [agentDocs], prepareSignal)
    sourceHook = await readAuthenticatedBinary(hookArgv[0], compatibility.hookSha256)
    sourceDocs = await readAuthenticatedBinary(docsArgv[0], compatibility.docsSha256)
    sourceSession = await readAuthenticatedBinary(
      join(dirname(sourceHook.path), 'agent-session'),
      compatibility.sessionSha256,
    )
  } catch (error) {
    if (error instanceof HealthProbeFailure) throw error
    throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE')
  }
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-health-executables-'))
  let snapshotRootHandle
  let hook
  let docs
  let session
  try {
    snapshotRootHandle = await open(
      snapshotRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    await snapshotRootHandle.chmod(0o700)
    if (!await pathReferencesOpenDirectory(snapshotRoot, snapshotRootHandle)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    await assertTrustedSnapshotRoot(await realpath(snapshotRoot))
    if (!await pathReferencesOpenDirectory(snapshotRoot, snapshotRootHandle)) {
      throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID')
    }
    hook = await snapshotExecutable(
      snapshotRoot,
      'agent-hook',
      sourceHook.bytes,
      compatibility.hookSha256,
    )
    docs = await snapshotExecutable(
      snapshotRoot,
      'agent-docs',
      sourceDocs.bytes,
      compatibility.docsSha256,
    )
    session = await snapshotExecutable(
      snapshotRoot,
      'agent-session',
      sourceSession.bytes,
      compatibility.sessionSha256,
    )
    const retained = await retainSnapshotLinks(snapshotRoot, snapshotRootHandle, [hook, docs, session])
    hook = retained[0]
    docs = retained[1]
    session = retained[2]
  } catch (error) {
    if (snapshotRootHandle !== undefined) {
      await snapshotRootHandle.chmod(0o700).catch(() => {})
      for (const binary of [hook, docs, session]) {
        if (binary !== undefined
          && await pathReferencesOpenFile(binary.path, binary.handle).catch(() => false)) {
          await unlink(binary.path).catch(() => {})
        }
      }
      if (await pathReferencesOpenDirectory(snapshotRoot, snapshotRootHandle).catch(() => false)) {
        await rmdir(snapshotRoot).catch(() => {})
      }
      await snapshotRootHandle.close().catch(() => {})
    }
    const binaries = [hook, docs, session].filter(binary => binary !== undefined)
    await Promise.allSettled(binaries.map(binary => binary.handle.close()))
    throw error
  }
  let snapshotDisposed = false
  const disposeSnapshot = async () => {
    if (snapshotDisposed) return
    snapshotDisposed = true
    await cleanupLinkedSnapshot(snapshotRoot, snapshotRootHandle, [hook, docs, session])
  }
  const spawnDescriptor = authenticatedDescriptorSpawner(ctx, new Map([
    [hook.path, hook],
    [docs.path, docs],
  ]), descriptorBinding)
  const executionOwner = createSnapshotExecutionOwner(
    disposeSnapshot,
    health.disposeTimeoutMs,
    spawnDescriptor,
  )
  try {
    ctx.effect(
      () => () => executionOwner.dispose(),
      'dsh-runtime-kit authenticated nils executable snapshot',
    )
  } catch (error) {
    await executionOwner.dispose()
    throw error
  }

  const disposeRuntime = health.register({
    capability: 'runtime-core',
    owner: OWNER,
    async probe({ signal }) {
      try {
        if (!validDshRuntime(options.dshRuntime)) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_DSH_IDENTITY_INVALID')
        }
        const doctor = await runAuthenticatedHealthCommand(executionOwner, ctx, hook, [
          hook.path,
          ...agentHook.argv(['doctor', '--product', 'dsh', '--format', 'json']).slice(1),
        ], runtimeCwd, signal, commandQuiescenceMs, options.beforeCommandSpawn)
        if (doctor.outcome.exitCode !== 0 || doctor.outcome.signal !== null) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_AGENT_HOOK_UNAVAILABLE')
        }
        let doctorValue
        try { doctorValue = JSON.parse(doctor.stdout) } catch {}
        if (!validDoctor(doctorValue)) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_AGENT_HOOK_INVALID')
        }

        const version = await runAuthenticatedHealthCommand(
          executionOwner,
          ctx,
          docs,
          [docs.path, '--version'],
          runtimeCwd,
          signal,
          commandQuiescenceMs,
          options.beforeCommandSpawn,
        )
        const escapedVersion = compatibility.version.replaceAll('.', '\\.')
        if (version.outcome.exitCode !== 0 || version.outcome.signal !== null
          || !new RegExp(`^agent-docs ${escapedVersion} \\([^\\r\\n]+\\)$`, 'u')
            .test(version.stdout.trim())) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_AGENT_DOCS_INVALID')
        }
        return { state: /** @type {const} */ ('ready'), code: 'DSH_RUNTIME_HEALTH_RUNTIME_READY' }
      } catch (error) {
        return blocked(error, signal, 'DSH_RUNTIME_HEALTH_COMPANION_UNAVAILABLE')
      }
    },
  })
  ownRegistration(ctx, disposeRuntime, 'dsh-runtime-kit runtime health provider')

  const disposeProject = health.register({
    capability: 'project-docs',
    owner: OWNER,
    async probe({ scope, signal }) {
      try {
        const projectPath = await realpath(requiredAbsolutePath(scope, 'project health scope'))
        const result = await runAuthenticatedHealthCommand(executionOwner, ctx, docs, [
          docs.path,
          '--docs-home', canonicalDocsHome,
          '--project-path', projectPath,
          'audit', '--target', 'project', '--strict', '--format', 'json',
        ], projectPath, signal, commandQuiescenceMs, options.beforeCommandSpawn)
        let audit
        try { audit = JSON.parse(result.stdout) } catch {}
        if (!validAudit(audit, canonicalDocsHome, projectPath)) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID')
        }
        if (audit.problems > 0 && result.outcome.exitCode === 1 && result.outcome.signal === null) {
          return { state: /** @type {const} */ ('blocked'), code: 'DSH_RUNTIME_HEALTH_PROJECT_INVALID' }
        }
        if (audit.problems !== 0 || result.outcome.exitCode !== 0 || result.outcome.signal !== null) {
          throw new HealthProbeFailure('DSH_RUNTIME_HEALTH_PROJECT_AUDIT_INVALID')
        }
        return { state: /** @type {const} */ ('ready'), code: 'DSH_RUNTIME_HEALTH_PROJECT_READY' }
      } catch (error) {
        return blocked(error, signal, 'DSH_RUNTIME_HEALTH_PROJECT_UNAVAILABLE')
      }
    },
  })
  ownRegistration(ctx, disposeProject, 'dsh-runtime-kit project docs health provider')

  const childCapabilities = /** @type {const} */ ([
    ['main-agent-mode', 'main_agent_mode'],
    ['review-specialists', 'review_specialists'],
  ])
  for (const [capability, name] of childCapabilities) {
    const dispose = health.register({
      capability,
      owner: OWNER,
      probe() {
        const state = options.childPlugins[name].state
        if (state === 'active') {
          return { state: /** @type {const} */ ('ready'), code: 'DSH_RUNTIME_HEALTH_OPTIONAL_READY' }
        }
        if (state === 'pending') {
          return { state: /** @type {const} */ ('degraded'), code: 'DSH_RUNTIME_HEALTH_OPTIONAL_PENDING' }
        }
        return { state: /** @type {const} */ ('degraded'), code: 'DSH_RUNTIME_HEALTH_OPTIONAL_UNAVAILABLE' }
      },
    })
    ownRegistration(ctx, dispose, `dsh-runtime-kit ${capability} health provider`)
  }
  return Object.freeze({
    agentHook: hook.path,
    agentDocs: docs.path,
    authenticatedNilsExecution: Object.freeze({
      createScope() { return executionOwner.createScope() },
    }),
  })
}
