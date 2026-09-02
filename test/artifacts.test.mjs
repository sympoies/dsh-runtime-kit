import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fsPromises, {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const CallId = llmModule.ToolCallId ?? llmModule.CallId
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import {
  ARTIFACT_CODES,
  ARTIFACT_EXPORT_RECEIPT_SCHEMA,
  ARTIFACT_TOOL_NAMES,
  ArtifactError,
  ArtifactService,
  applyArtifacts,
  createArtifactTools,
} from '../src/artifacts/index.js'
import { LocalArtifactProvider } from '../src/artifacts/local-provider.js'
import { MemoryArtifactProvider } from '../src/artifacts/memory-provider.js'

const testSignal = new AbortController().signal
const DSH_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'title', 'description', 'default', 'examples',
])

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function assertDshSchemaSubset(schema, path = 'schema') {
  assert.equal(schema !== null && typeof schema === 'object' && !Array.isArray(schema), true)
  for (const key of Object.keys(schema)) {
    assert.equal(DSH_SCHEMA_KEYWORDS.has(key), true, `${path}.${key} is unsupported by DSH`)
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertDshSchemaSubset(child, `${path}.properties.${name}`)
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    assertDshSchemaSubset(child, `${path}.oneOf[${index}]`)
  }
  if (schema.items !== undefined) assertDshSchemaSubset(schema.items, `${path}.items`)
}

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  return realpath(path)
}

function stubAgent(rawId, cwd, parentSession) {
  const id = SessionId(rawId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle',
    ctx: new Context(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function sandboxPolicyStub(overrides = {}) {
  const protectedCalls = []
  return {
    calls: protectedCalls,
    policy: {
      resolve({ session } = {}) {
        return {
          mode: overrides.mode ?? 'workspace-write',
          workspaceRoot: session?.header.cwd ?? overrides.fallbackRoot ?? '/nonexistent-fallback',
          ...(overrides.protectedRoots === undefined ? {} : { protectedRoots: overrides.protectedRoots }),
        }
      },
      protect(roots) {
        protectedCalls.push([...roots])
        return () => {}
      },
    },
  }
}

async function harness(options = {}) {
  const root = options.root ?? await temporaryDirectory('artifacts-store-')
  const provider = options.provider ?? new LocalArtifactProvider({ root })
  const sandbox = sandboxPolicyStub(options.sandbox)
  const ctx = new Context()
  ctx.provide('sandboxPolicy', sandbox.policy)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const config = {
    provider,
    limits: {
      maxArtifactBytes: 1024 * 1024,
      sessionQuotaBytes: 4 * 1024 * 1024,
      sessionMaxCount: 8,
      readMaxBytes: 64 * 1024,
      previewMaxBytes: 64,
      sessionTtlMs: 60_000,
      retainedTtlMs: 600_000,
      ...options.limits,
    },
    protectedRoots: options.protectedRoots ?? [],
    now: options.now,
  }
  await applyArtifacts(ctx, config)
  const service = ctx.get('dshRuntimeArtifacts')
  assert.ok(service instanceof ArtifactService)
  return { ctx, service, provider, root, sandbox }
}

function publish(ctx, agent, source = 'startup') {
  const dispose = ctx.agents.register(agent)
  agentEvents(ctx, agent).emit('agent/session-start', { source })
  return dispose
}

async function writeArtifact(service, agent, content, overrides = {}) {
  return service.write(agent, {
    name: 'report.txt',
    mediaType: 'text/plain',
    producerTool: 'test',
    ...overrides,
  }, typeof content === 'string' ? new TextEncoder().encode(content) : content, testSignal)
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ArtifactError, `expected ArtifactError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

async function* chunks(size, count, seed = 7) {
  for (let index = 0; index < count; index += 1) {
    const chunk = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += 1) chunk[offset] = (index * 31 + offset * seed) & 0xff
    yield chunk
  }
}

async function collect(iterable) {
  const parts = []
  for await (const part of iterable) parts.push(part)
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    merged.set(part, cursor)
    cursor += part.byteLength
  }
  return merged
}

async function objectCount(root) {
  let count = 0
  for (const bucket of await readdir(join(root, 'objects'))) {
    count += (await readdir(join(root, 'objects', bucket))).length
  }
  return count
}

async function stagingEntries(root) {
  try {
    return await readdir(join(root, 'tmp'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

test('text, structured data, image bytes, and a streamed binary round-trip with stable identity', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const { ctx, service, root } = await harness()
  const agent = stubAgent('session-a', workspace)
  publish(ctx, agent)

  const text = await writeArtifact(service, agent, 'hello artifacts')
  assert.match(text.ref, /^artifact:[0-9a-f]{32}$/)
  assert.equal(text.sha256, sha256(new TextEncoder().encode('hello artifacts')))
  assert.equal(text.bytes, 15)
  assert.equal(text.mediaType, 'text/plain')
  assert.equal(text.retentionClass, 'session')
  assert.equal(text.ownerSessionId, 'session-a')
  assert.equal(text.producerTool, 'test')
  assert.match(text.generation, /^generation:/)
  assert.ok(Date.parse(text.createdAt) <= Date.parse(text.expiresAt))
  assert.equal(Object.values(text).some(value => typeof value === 'string' && value.includes(root)), false)

  const structured = await writeArtifact(service, agent, JSON.stringify({ ok: true, items: [1, 2, 3] }), {
    name: 'evidence.json',
    mediaType: 'application/json',
  })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const image = await writeArtifact(service, agent, png, { name: 'shot.png', mediaType: 'image/png' })
  const streamed = await service.write(agent, {
    name: 'blob.bin',
    mediaType: 'application/octet-stream',
    producerTool: 'test',
    retention: 'retained',
  }, chunks(64 * 1024, 12), testSignal)
  const expectedStream = await collect(chunks(64 * 1024, 12))
  assert.equal(streamed.bytes, 12 * 64 * 1024)
  assert.equal(streamed.sha256, sha256(expectedStream))
  assert.equal(streamed.retentionClass, 'retained')

  for (const [record, expected] of [
    [text, new TextEncoder().encode('hello artifacts')],
    [structured, new TextEncoder().encode(JSON.stringify({ ok: true, items: [1, 2, 3] }))],
    [image, png],
  ]) {
    const read = await service.read(agent, record.ref, { signal: testSignal })
    assert.deepEqual(read.data, expected)
    assert.equal(read.record.sha256, record.sha256)
  }
  const streamedRead = await service.read(agent, streamed.ref, { signal: testSignal, maxBytes: 16 * 1024 * 1024 })
  assert.deepEqual(streamedRead.data, expectedStream)
  await rejectsWithCode(service.read(agent, streamed.ref, { signal: testSignal }), ARTIFACT_CODES.READ_TOO_LARGE)

  const presented = await service.present(agent, structured.ref)
  assert.equal(presented.sha256, structured.sha256)
  assert.deepEqual(presented.capabilities, ['read', 'present', 'export', 'delete'])
  assert.equal(presented.preview, JSON.stringify({ ok: true, items: [1, 2, 3] }))
  const long = await writeArtifact(service, agent, 'x'.repeat(200), { name: 'long.txt' })
  assert.equal((await service.present(agent, long.ref)).preview, 'x'.repeat(64))
  const multibyte = await writeArtifact(service, agent, 'a'.repeat(63) + 'é', { name: 'multibyte.txt' })
  assert.equal((await service.present(agent, multibyte.ref)).preview, 'a'.repeat(63), 'a split code point is trimmed, not replaced')
  for (const record of [long, multibyte]) await service.dispose(agent, record.ref)
  const binaryPresented = await service.present(agent, image.ref)
  assert.equal(binaryPresented.preview, undefined)
  assert.equal(JSON.stringify(presented).includes(root), false)

  const listed = await service.list(agent)
  assert.deepEqual(listed.map(entry => entry.ref).sort(), [text.ref, structured.ref, image.ref, streamed.ref].sort())
})

test('interrupted, cancelled, over-limit, quota-exhausted, and failed writes publish nothing', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const { ctx, service, root } = await harness({ limits: { maxArtifactBytes: 4096, sessionQuotaBytes: 6000, sessionMaxCount: 3 } })
  const agent = stubAgent('session-neg', workspace)
  publish(ctx, agent)

  const controller = new AbortController()
  async function* interrupted() {
    yield new Uint8Array(1024)
    controller.abort(new Error('caller cancelled'))
    yield new Uint8Array(1024)
  }
  await rejectsWithCode(service.write(agent, { name: 'x.bin', mediaType: 'application/octet-stream', producerTool: 'test' }, interrupted(), controller.signal), ARTIFACT_CODES.ABORTED)

  async function* failing() {
    yield new Uint8Array(512)
    throw new Error('producer exploded')
  }
  await rejectsWithCode(service.write(agent, { name: 'y.bin', mediaType: 'application/octet-stream', producerTool: 'test' }, failing(), testSignal), ARTIFACT_CODES.WRITE_FAILED)

  await rejectsWithCode(service.write(agent, { name: 'big.bin', mediaType: 'application/octet-stream', producerTool: 'test' }, chunks(1024, 5), testSignal), ARTIFACT_CODES.TOO_LARGE)

  const writer = await service.openWriter(agent, { name: 'partial.bin', mediaType: 'application/octet-stream', producerTool: 'test' }, testSignal)
  await writer.write(new Uint8Array(100))
  await writer.abort()
  await rejectsWithCode(writer.commit(), ARTIFACT_CODES.WRITE_FAILED)

  assert.deepEqual(await service.list(agent), [])
  assert.deepEqual(await stagingEntries(root), [])
  assert.deepEqual(await readdir(join(root, 'index')), [])
  assert.equal(await objectCount(root), 0)

  // A local publish failure after the object was linked must roll the object back.
  await chmod(join(root, 'index'), 0o500)
  try {
    await rejectsWithCode(writeArtifact(service, agent, 'orphaned object'), ARTIFACT_CODES.WRITE_FAILED)
  } finally {
    await chmod(join(root, 'index'), 0o700)
  }
  assert.equal(await objectCount(root), 0)
  assert.deepEqual(await stagingEntries(root), [])
  assert.deepEqual(await service.list(agent), [])

  const first = await writeArtifact(service, agent, 'a'.repeat(3000))
  assert.equal(first.bytes, 3000)
  await rejectsWithCode(writeArtifact(service, agent, 'b'.repeat(3500)), ARTIFACT_CODES.QUOTA_EXCEEDED)
  await writeArtifact(service, agent, 'c'.repeat(1000))
  await writeArtifact(service, agent, 'd'.repeat(1000))
  await rejectsWithCode(writeArtifact(service, agent, 'e'), ARTIFACT_CODES.QUOTA_EXCEEDED)
  assert.equal((await service.list(agent)).length, 3)
  assert.deepEqual(await stagingEntries(root), [])
})

test('provider publish and commit failures leave no readable artifact and surface typed outcomes', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const provider = new MemoryArtifactProvider()
  const { ctx, service } = await harness({ provider })
  const agent = stubAgent('session-mem', workspace)
  publish(ctx, agent)

  provider.failNext('publish', new Error('disk on fire'))
  await rejectsWithCode(writeArtifact(service, agent, 'unpublished'), ARTIFACT_CODES.WRITE_FAILED)
  assert.deepEqual(await service.list(agent), [])
  assert.equal(provider.stagingCount(), 0)

  provider.failNext('commit', new Error('commit lost'))
  await rejectsWithCode(writeArtifact(service, agent, 'uncommitted'), ARTIFACT_CODES.WRITE_FAILED)
  assert.equal(provider.stagingCount(), 0)

  const record = await writeArtifact(service, agent, 'present')
  provider.unavailable = true
  await rejectsWithCode(service.read(agent, record.ref, { signal: testSignal }), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
  await rejectsWithCode(writeArtifact(service, agent, 'while down'), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
  provider.unavailable = false
  const read = await service.read(agent, record.ref, { signal: testSignal })
  assert.equal(new TextDecoder().decode(read.data), 'present')
})

test('cross-session, cross-workspace, unregistered, and malformed references are denied before any byte is read', async () => {
  const workspaceA = await temporaryDirectory('artifacts-workspace-a-')
  const workspaceB = await temporaryDirectory('artifacts-workspace-b-')
  const { ctx, service } = await harness()
  const owner = stubAgent('owner', workspaceA)
  const stranger = stubAgent('stranger', workspaceA)
  const elsewhere = stubAgent('elsewhere', workspaceB)
  const disposeOwner = publish(ctx, owner)
  publish(ctx, stranger)
  publish(ctx, elsewhere)

  const record = await writeArtifact(service, owner, 'secret report')
  const copied = String(record.ref)
  for (const actor of [stranger, elsewhere]) {
    await rejectsWithCode(service.present(actor, copied), ARTIFACT_CODES.ACCESS_DENIED)
    await rejectsWithCode(service.read(actor, copied, { signal: testSignal }), ARTIFACT_CODES.ACCESS_DENIED)
    await rejectsWithCode(service.exportArtifact(actor, copied, { class: 'workspace', path: 'out.txt' }, testSignal), ARTIFACT_CODES.ACCESS_DENIED)
    await rejectsWithCode(service.dispose(actor, copied), ARTIFACT_CODES.ACCESS_DENIED)
  }
  assert.deepEqual(await service.list(stranger), [])
  assert.deepEqual(await service.list(elsewhere), [])

  await rejectsWithCode(service.present(owner, 'artifact:not-hex'), ARTIFACT_CODES.REF_INVALID)
  await rejectsWithCode(service.present(owner, 'artifact:' + 'f'.repeat(32)), ARTIFACT_CODES.NOT_FOUND)
  await rejectsWithCode(service.present(owner, `/etc/passwd`), ARTIFACT_CODES.REF_INVALID)

  const ghost = stubAgent('ghost', workspaceA)
  await rejectsWithCode(service.present(ghost, copied), ARTIFACT_CODES.ACCESS_DENIED)
  await rejectsWithCode(writeArtifact(service, ghost, 'never'), ARTIFACT_CODES.ACCESS_DENIED)

  const same = await service.present(owner, copied)
  assert.equal(same.sha256, record.sha256)
  const retainedCopy = await writeArtifact(service, owner, 'retained for the moved session', { retention: 'retained' })
  disposeOwner()
  await service.settled()
  await rejectsWithCode(service.present(owner, copied), ARTIFACT_CODES.ACCESS_DENIED)

  // The same session id resumed from a different workspace must not see the
  // records it created elsewhere: the workspace digest is checked on its own.
  const moved = stubAgent('owner', workspaceB)
  publish(ctx, moved, 'resume')
  await rejectsWithCode(service.present(moved, retainedCopy.ref), ARTIFACT_CODES.ACCESS_DENIED)
  await rejectsWithCode(service.read(moved, retainedCopy.ref, { signal: testSignal }), ARTIFACT_CODES.ACCESS_DENIED)
  await rejectsWithCode(service.dispose(moved, retainedCopy.ref), ARTIFACT_CODES.ACCESS_DENIED)
  assert.deepEqual(await service.list(moved), [])
  assert.equal((await service.records()).some(entry => entry.ref === retainedCopy.ref), true)
})

test('references are revalidated by the provider after restart and tampering fails closed', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const root = await temporaryDirectory('artifacts-store-')
  const first = await harness({ root })
  const owner = stubAgent('durable', workspace)
  publish(first.ctx, owner)
  const kept = await writeArtifact(first.service, owner, 'survives restart', { retention: 'retained' })
  const sessionScoped = await writeArtifact(first.service, owner, 'dies with the owner agent')
  const corrupted = await writeArtifact(first.service, owner, 'will be rewritten', { name: 'c.txt', retention: 'retained' })
  const linked = await writeArtifact(first.service, owner, 'will be hard linked', { name: 'l.txt', retention: 'retained' })
  const symlinked = await writeArtifact(first.service, owner, 'will be symlinked', { name: 's.txt', retention: 'retained' })
  const malformed = await writeArtifact(first.service, owner, 'index will break', { name: 'm.txt', retention: 'retained' })
  const firstGeneration = kept.generation
  await first.ctx.fiber.dispose()
  await first.service.settled()

  const objectPath = record => join(root, 'objects', record.sha256.slice(7, 9), record.sha256.slice(7))
  await chmod(objectPath(corrupted), 0o600)
  await writeFile(objectPath(corrupted), 'tampered bytes!!!')
  const foreign = join(root, 'foreign.txt')
  await writeFile(foreign, 'will be hard linked')
  await rm(objectPath(linked))
  await link(foreign, objectPath(linked))
  await rm(objectPath(symlinked))
  await symlink(foreign, objectPath(symlinked))
  const indexEntries = await readdir(join(root, 'index'))
  const malformedIndex = indexEntries.find(entry => entry.includes(malformed.ref.slice('artifact:'.length)))
  assert.ok(malformedIndex, 'index record is keyed by an opaque id')
  await writeFile(join(root, 'index', malformedIndex), '{"schema_version":"dsh-runtime-kit.artifact-record.v1","id":"nope"')

  const second = await harness({ root })
  const resumed = stubAgent('durable', workspace)
  publish(second.ctx, resumed, 'resume')
  const presented = await second.service.present(resumed, kept.ref)
  assert.equal(presented.sha256, kept.sha256)
  assert.equal(presented.generation, firstGeneration, 'records keep the generation that created them')
  assert.notEqual(second.service.generation, firstGeneration)
  const read = await second.service.read(resumed, kept.ref, { signal: testSignal })
  assert.equal(new TextDecoder().decode(read.data), 'survives restart')
  await rejectsWithCode(second.service.present(resumed, sessionScoped.ref), ARTIFACT_CODES.NOT_FOUND)

  await rejectsWithCode(second.service.read(resumed, corrupted.ref, { signal: testSignal }), ARTIFACT_CODES.CORRUPT)
  await rejectsWithCode(second.service.read(resumed, linked.ref, { signal: testSignal }), ARTIFACT_CODES.CORRUPT)
  await rejectsWithCode(second.service.read(resumed, symlinked.ref, { signal: testSignal }), ARTIFACT_CODES.CORRUPT)
  await rejectsWithCode(second.service.present(resumed, malformed.ref), ARTIFACT_CODES.METADATA_INVALID)
  await rejectsWithCode(second.service.exportArtifact(resumed, corrupted.ref, { class: 'workspace', path: 'never.txt' }, testSignal), ARTIFACT_CODES.CORRUPT)
  await assert.rejects(stat(join(workspace, 'never.txt')), { code: 'ENOENT' })

  const other = stubAgent('other-session', workspace)
  publish(second.ctx, other)
  await rejectsWithCode(second.service.present(other, kept.ref), ARTIFACT_CODES.ACCESS_DENIED)
  await second.ctx.fiber.dispose()
  await second.service.settled()

  // A session-class record left behind by a host that never disposed its
  // agents (a crash or a hard exit) must not outlive the next service start.
  const crashed = new LocalArtifactProvider({ root })
  await crashed.init()
  const orphanStaging = await crashed.begin({ id: 'ab'.repeat(16), maxBytes: 1024 })
  await orphanStaging.write(new TextEncoder().encode('left behind by a crash'))
  const orphanCommitted = await orphanStaging.commit()
  await crashed.publish({
    schema_version: 'dsh-runtime-kit.artifact-record.v1',
    id: 'ab'.repeat(16),
    ...orphanCommitted,
    media_type: 'text/plain',
    owner_session_id: 'durable',
    workspace_digest: 'unmanaged',
    producer_tool: 'crash-fixture',
    generation: 'generation:crashed',
    created_at: new Date().toISOString(),
    retention_class: 'session',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal((await crashed.list()).some(record => record.id === 'ab'.repeat(16)), true)

  // The startup sweep reclaims every session-class record plus retained
  // records whose expiry passed while the host was down. The malformed record
  // is never trusted enough to be swept, so exactly its object survives instead
  // of being silently deleted.
  const clock = Date.now() + 700_000
  const third = await harness({ root, now: () => clock })
  const survivingObjects = []
  for (const bucket of await readdir(join(root, 'objects'))) {
    for (const entry of await readdir(join(root, 'objects', bucket))) survivingObjects.push(`${bucket}/${entry}`)
  }
  assert.equal(await objectCount(root), 1, JSON.stringify({ survivingObjects, malformed: malformed.sha256, kept: kept.sha256, corrupted: corrupted.sha256, linked: linked.sha256, symlinked: symlinked.sha256, orphan: orphanCommitted.sha256 }))
  assert.deepEqual(await readdir(join(root, 'index')), [malformedIndex])
  await third.ctx.fiber.dispose()

  // Without the clock advance, the startup sweep still removes only the
  // session-class orphan and keeps unexpired retained records.
  const fourthRoot = await temporaryDirectory('artifacts-store-')
  const seed = await harness({ root: fourthRoot })
  const seeder = stubAgent('seeder', workspace)
  publish(seed.ctx, seeder)
  const keptRetained = await writeArtifact(seed.service, seeder, 'retained survives', { retention: 'retained' })
  const seedProvider = new LocalArtifactProvider({ root: fourthRoot })
  await seedProvider.init()
  const seedStaging = await seedProvider.begin({ id: 'cd'.repeat(16), maxBytes: 1024 })
  await seedStaging.write(new TextEncoder().encode('session orphan'))
  const seedCommitted = await seedStaging.commit()
  await seedProvider.publish({
    schema_version: 'dsh-runtime-kit.artifact-record.v1',
    id: 'cd'.repeat(16),
    ...seedCommitted,
    media_type: 'text/plain',
    owner_session_id: 'seeder',
    workspace_digest: 'unmanaged',
    producer_tool: 'crash-fixture',
    generation: 'generation:crashed',
    created_at: new Date().toISOString(),
    retention_class: 'session',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })
  await seed.ctx.fiber.dispose()
  await seed.service.settled()
  const restarted = await harness({ root: fourthRoot })
  const survivors = await restarted.service.records()
  assert.deepEqual(survivors.map(entry => entry.ref), [keptRetained.ref])
  const fourthObjects = []
  for (const bucket of await readdir(join(fourthRoot, 'objects'))) {
    for (const entry of await readdir(join(fourthRoot, 'objects', bucket))) fourthObjects.push(`${bucket}/${entry}`)
  }
  assert.equal(await objectCount(fourthRoot), 1, JSON.stringify({ fourthObjects, kept: keptRetained.sha256, orphan: seedCommitted.sha256 }))
})

test('a second live host sharing the store never reclaims a sibling\'s session-class artifacts', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const root = await temporaryDirectory('artifacts-store-')
  const hostA = await harness({ root })
  const agentA = stubAgent('host-a-session', workspace)
  publish(hostA.ctx, agentA)
  const live = await writeArtifact(hostA.service, agentA, 'still in use by host A')
  assert.deepEqual(await readdir(join(root, 'generations')), [`${hostA.service.generation.slice('generation:'.length)}.json`])

  // Host B starts on the same store while host A is alive: A's record survives.
  const hostB = await harness({ root })
  assert.notEqual(hostB.service.generation, hostA.service.generation)
  const presented = await hostA.service.present(agentA, live.ref)
  assert.equal(presented.sha256, live.sha256)
  assert.equal((await hostB.service.records()).some(entry => entry.ref === live.ref), true)

  // A dead claim (a pid that no longer exists) is reclaimed by the next start.
  const deadGeneration = 'generation:00000000-0000-4000-8000-000000000dead'
  await writeFile(join(root, 'generations', '00000000-0000-4000-8000-000000000dead.json'), JSON.stringify({ pid: 2 ** 22 - 3, started_at: new Date().toISOString() }), { mode: 0o600 })
  const deadProvider = new LocalArtifactProvider({ root })
  await deadProvider.init()
  const deadStaging = await deadProvider.begin({ id: 'ef'.repeat(16), maxBytes: 1024 })
  await deadStaging.write(new TextEncoder().encode('owned by a dead host'))
  const deadCommitted = await deadStaging.commit()
  await deadProvider.publish({
    schema_version: 'dsh-runtime-kit.artifact-record.v1',
    id: 'ef'.repeat(16),
    ...deadCommitted,
    media_type: 'text/plain',
    owner_session_id: 'dead-host-session',
    workspace_digest: 'unmanaged',
    producer_tool: 'crash-fixture',
    generation: deadGeneration,
    created_at: new Date().toISOString(),
    retention_class: 'session',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })
  await hostB.ctx.fiber.dispose()
  await hostB.service.settled()
  const hostC = await harness({ root })
  const afterC = (await hostC.service.records()).map(entry => entry.ref)
  assert.equal(afterC.includes(live.ref), true, 'host A is still alive, so its record survives host C start')
  assert.equal(afterC.includes(`artifact:${'ef'.repeat(16)}`), false, 'the dead host\'s session record is reclaimed')

  // Once host A releases its generation, the next start reclaims its session-class record.
  await hostA.ctx.fiber.dispose()
  await hostA.service.settled()
  await hostC.ctx.fiber.dispose()
  const hostD = await harness({ root })
  assert.equal((await hostD.service.records()).some(entry => entry.ref === live.ref), false)
  assert.deepEqual(await readdir(join(root, 'generations')), [`${hostD.service.generation.slice('generation:'.length)}.json`, '00000000-0000-4000-8000-000000000dead.json'].sort())
})

test('expiry, explicit disposal, and owner disposal reclaim only the targeted lifecycle', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  let clock = 1_000_000
  const { ctx, service, root } = await harness({ now: () => clock, limits: { sessionTtlMs: 1000, retainedTtlMs: 5000 } })
  const alpha = stubAgent('alpha', workspace)
  const beta = stubAgent('beta', workspace)
  const disposeAlpha = publish(ctx, alpha)
  publish(ctx, beta)

  const alphaSession = await writeArtifact(service, alpha, 'alpha session')
  const alphaRetained = await writeArtifact(service, alpha, 'alpha retained', { retention: 'retained' })
  const betaSession = await writeArtifact(service, beta, 'beta session')
  const betaRetained = await writeArtifact(service, beta, 'beta retained', { retention: 'retained' })

  clock += 1500
  await rejectsWithCode(service.present(alpha, alphaSession.ref), ARTIFACT_CODES.EXPIRED)
  const swept = await service.sweep()
  assert.equal(swept.reclaimed, 1, 'beta session-class record expired by clock; alpha already reclaimed lazily')
  assert.deepEqual((await service.list(alpha)).map(entry => entry.ref), [alphaRetained.ref])
  assert.deepEqual((await service.list(beta)).map(entry => entry.ref), [betaRetained.ref])

  const betaAgain = await writeArtifact(service, beta, 'beta again')
  const alphaAgain = await writeArtifact(service, alpha, 'alpha again')
  disposeAlpha()
  await service.settled()
  const remaining = await service.records()
  assert.deepEqual(remaining.map(entry => entry.ref).sort(), [alphaRetained.ref, betaRetained.ref, betaAgain.ref].sort())
  assert.ok(!remaining.some(entry => entry.ref === alphaAgain.ref), 'owner disposal reclaims only its session-class records')

  const disposed = await service.dispose(beta, betaAgain.ref)
  assert.deepEqual(disposed, { ref: betaAgain.ref, outcome: 'disposed' })
  await rejectsWithCode(service.dispose(beta, betaAgain.ref), ARTIFACT_CODES.NOT_FOUND)
  await rejectsWithCode(service.dispose(beta, betaAgain.ref), ARTIFACT_CODES.NOT_FOUND)
  assert.deepEqual((await service.list(beta)).map(entry => entry.ref), [betaRetained.ref])

  const objectEntries = []
  for (const bucket of await readdir(join(root, 'objects'))) {
    for (const entry of await readdir(join(root, 'objects', bucket))) objectEntries.push(entry)
  }
  assert.equal(objectEntries.length, 2, 'only live retained objects remain on disk')
})

test('concurrent writers, shared content, and concurrent read/dispose keep counts, quota, and staging exact', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const { ctx, service, root } = await harness({ limits: { sessionMaxCount: 6, sessionQuotaBytes: 100_000 } })
  const agent = stubAgent('busy', workspace)
  publish(ctx, agent)

  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    writeArtifact(service, agent, index % 2 === 0 ? 'shared body' : `unique body ${index}`, { name: `w${index}.txt` })))
  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled')
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
  assert.equal(fulfilled.length, 6)
  assert.equal(rejected.length, 2)
  for (const outcome of rejected) assert.equal(outcome.reason.code, ARTIFACT_CODES.QUOTA_EXCEEDED)
  const refs = new Set(fulfilled.map(outcome => outcome.value.ref))
  assert.equal(refs.size, 6, 'every writer receives a distinct opaque reference')
  assert.deepEqual(await stagingEntries(root), [])

  const shared = fulfilled.map(outcome => outcome.value).filter(record => record.bytes === 'shared body'.length)
  assert.ok(shared.length >= 2)
  await service.dispose(agent, shared[0].ref)
  const stillReadable = await service.read(agent, shared[1].ref, { signal: testSignal })
  assert.equal(new TextDecoder().decode(stillReadable.data), 'shared body', 'disposing one owner keeps shared content for the other')

  const target = fulfilled.map(outcome => outcome.value).find(record => record.bytes !== 'shared body'.length)
  const raced = await Promise.allSettled([
    service.read(agent, target.ref, { signal: testSignal }),
    service.dispose(agent, target.ref),
    service.read(agent, target.ref, { signal: testSignal }),
  ])
  assert.equal(raced[1].status, 'fulfilled')
  for (const outcome of [raced[0], raced[2]]) {
    if (outcome.status === 'rejected') assert.equal(outcome.reason.code, ARTIFACT_CODES.NOT_FOUND)
    else assert.equal(new TextDecoder().decode(outcome.value.data).startsWith('unique body'), true)
  }
  assert.equal((await service.list(agent)).length, 4)
})

test('export verifies the exact digest, emits a bounded receipt, and denies unsafe destinations', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const outside = await temporaryDirectory('artifacts-outside-')
  const protectedRoot = join(workspace, '.protected')
  await mkdir(protectedRoot)
  const { ctx, service, root } = await harness({ protectedRoots: [protectedRoot] })
  const agent = stubAgent('exporter', workspace)
  publish(ctx, agent)
  const record = await writeArtifact(service, agent, 'exported body', { name: 'report.txt' })

  const receipt = await service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'reports/out.txt' }, testSignal)
  assert.equal(receipt.schema_version, ARTIFACT_EXPORT_RECEIPT_SCHEMA)
  assert.equal(receipt.ref, record.ref)
  assert.equal(receipt.sha256, record.sha256)
  assert.equal(receipt.bytes, record.bytes)
  assert.equal(receipt.media_type, 'text/plain')
  assert.equal(receipt.destination_class, 'workspace')
  assert.equal(receipt.destination_path, 'reports/out.txt')
  assert.equal(receipt.owner_session_id, 'exporter')
  assert.equal(receipt.generation, record.generation)
  assert.ok(Date.parse(receipt.exported_at) > 0)
  assert.equal(JSON.stringify(receipt).includes(root), false)
  assert.equal(JSON.stringify(receipt).includes(workspace), false)
  assert.equal(await readFile(join(workspace, 'reports', 'out.txt'), 'utf8'), 'exported body')
  const exportedMode = (await stat(join(workspace, 'reports', 'out.txt'))).mode & 0o777
  assert.equal(exportedMode & 0o022, 0)

  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'reports/out.txt' }, testSignal), ARTIFACT_CODES.EXPORT_EXISTS)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: '../escape.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: join(outside, 'abs.txt') }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'reports/../../escape.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'bad\0name.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: '.protected/leak.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DENIED)
  await symlink(outside, join(workspace, 'alias'))
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'alias/leak.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await symlink(join(outside, 'target.txt'), join(workspace, 'reports', 'dangling.txt'))
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'reports/dangling.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
  await assert.rejects(stat(join(outside, 'leak.txt')), { code: 'ENOENT' })
  await assert.rejects(stat(join(outside, 'target.txt')), { code: 'ENOENT' })
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'download' }, testSignal), ARTIFACT_CODES.CAPABILITY_UNSUPPORTED)
  await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'bucket', path: 'x' }, testSignal), ARTIFACT_CODES.ARGUMENT_INVALID)
  // Filesystem failures on the destination path stay typed and path-free.
  for (const path of ['a'.repeat(300), `reports/${'b'.repeat(300)}`]) {
    await assert.rejects(service.exportArtifact(agent, record.ref, { class: 'workspace', path }, testSignal), error => {
      assert.ok(error instanceof ArtifactError)
      assert.equal(error.code, ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
      assert.equal(error.message.includes(workspace), false, 'no workspace path in the message')
      return true
    })
  }
  await mkdir(join(workspace, 'sealed'))
  await chmod(join(workspace, 'sealed'), 0o555)
  try {
    await assert.rejects(service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'sealed/sub/x.txt' }, testSignal), error => {
      assert.ok(error instanceof ArtifactError)
      assert.equal(error.code, ARTIFACT_CODES.EXPORT_DESTINATION_INVALID)
      assert.equal(error.message.includes(workspace), false)
      return true
    })
  } finally {
    await chmod(join(workspace, 'sealed'), 0o755)
  }

  const readOnly = await harness({ sandbox: { mode: 'read-only' } })
  const reader = stubAgent('reader', workspace)
  publish(readOnly.ctx, reader)
  const readOnlyRecord = await writeArtifact(readOnly.service, reader, 'read only session')
  await rejectsWithCode(readOnly.service.exportArtifact(reader, readOnlyRecord.ref, { class: 'workspace', path: 'ro.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DENIED)
  await assert.rejects(stat(join(workspace, 'ro.txt')), { code: 'ENOENT' })

  const unmanaged = stubAgent('unmanaged')
  publish(ctx, unmanaged)
  const unmanagedRecord = await writeArtifact(service, unmanaged, 'no cwd')
  assert.equal(unmanagedRecord.workspaceDigest, 'unmanaged')
  await rejectsWithCode(service.exportArtifact(unmanaged, unmanagedRecord.ref, { class: 'workspace', path: 'x.txt' }, testSignal), ARTIFACT_CODES.EXPORT_DENIED)
})

test('export honors host sandbox protected roots, the store root, and the post-open destination identity', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const outside = await temporaryDirectory('artifacts-outside-')
  await mkdir(join(workspace, '.project', 'private'), { recursive: true })
  await mkdir(join(workspace, '.runtime', 'state'), { recursive: true })
  // The store root lives inside the workspace here so a forged record path is a
  // workspace-relative export target; it must still be denied.
  const root = join(workspace, '.artifact-store')
  const { ctx, service } = await harness({
    root,
    sandbox: { protectedRoots: [join(workspace, '.project', 'private'), '.runtime/state'] },
  })
  const agent = stubAgent('policy-exporter', workspace)
  publish(ctx, agent)
  const record = await writeArtifact(service, agent, 'policy body')
  for (const path of ['.project/private/state.md', '.runtime/state/leak.txt', '.artifact-store/index/' + 'f'.repeat(32) + '.json']) {
    await rejectsWithCode(service.exportArtifact(agent, record.ref, { class: 'workspace', path }, testSignal), ARTIFACT_CODES.EXPORT_DENIED)
    await assert.rejects(stat(join(workspace, path)), { code: 'ENOENT' })
  }
  const allowed = await service.exportArtifact(agent, record.ref, { class: 'workspace', path: 'reports/ok.txt' }, testSignal)
  assert.equal(allowed.destination_path, 'reports/ok.txt')

  // Race: an ancestor directory is swapped for a symbolic link after the
  // ancestor walk and before the destination is opened. The provider read sits
  // exactly between those two steps, so a racing provider reproduces the window.
  class RacingProvider extends MemoryArtifactProvider {
    async read(record, signal) {
      await rm(join(workspace, 'reports'), { recursive: true, force: true })
      await symlink(outside, join(workspace, 'reports'))
      return super.read(record, signal)
    }
  }
  const racing = await harness({ provider: new RacingProvider() })
  const racer = stubAgent('racer', workspace)
  publish(racing.ctx, racer)
  const raced = await writeArtifact(racing.service, racer, 'raced body')
  await rejectsWithCode(
    racing.service.exportArtifact(racer, raced.ref, { class: 'workspace', path: 'reports/raced.txt' }, testSignal),
    ARTIFACT_CODES.EXPORT_DESTINATION_INVALID,
  )
  await assert.rejects(stat(join(outside, 'raced.txt')), { code: 'ENOENT' }, 'no file may land behind the swapped symlink')
  assert.deepEqual(await readdir(outside), [])

  // Race after the identity check: the parent directory is renamed out of the
  // workspace while the bytes are being written. The written inode must not
  // be left behind at its new location.
  await rm(join(workspace, 'reports'), { recursive: true, force: true })
  const moved = await temporaryDirectory('artifacts-moved-')
  const originalOpen = fsPromises.open
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === join(workspace, 'reports', 'moved.txt') && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = async (...writeArgs) => {
        const result = await writeFile(...writeArgs)
        await rm(join(moved, 'reports'), { recursive: true, force: true })
        await rename(join(workspace, 'reports'), join(moved, 'reports'))
        return result
      }
    }
    return handle
  }
  syncBuiltinESMExports()
  try {
    const plain = await harness({ provider: new MemoryArtifactProvider() })
    const mover = stubAgent('mover', workspace)
    publish(plain.ctx, mover)
    const movedRecord = await writeArtifact(plain.service, mover, 'moved during write')
    await rejectsWithCode(
      plain.service.exportArtifact(mover, movedRecord.ref, { class: 'workspace', path: 'reports/moved.txt' }, testSignal),
      ARTIFACT_CODES.EXPORT_DESTINATION_INVALID,
    )
    assert.deepEqual(await readdir(join(moved, 'reports')), [], 'the written inode is removed from its new location')
  } finally {
    fsPromises.open = originalOpen
    syncBuiltinESMExports()
  }
})

test('the local provider protects its root and refuses unsafe store roots', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const { root, sandbox } = await harness()
  assert.deepEqual(sandbox.calls, [[root]])
  const rootMode = (await stat(root)).mode & 0o777
  assert.equal(rootMode, 0o700)

  const loose = await temporaryDirectory('artifacts-loose-')
  await chmod(loose, 0o755)
  await rejectsWithCode(new LocalArtifactProvider({ root: loose }).init(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)

  const linkParent = await temporaryDirectory('artifacts-link-parent-')
  const real = await temporaryDirectory('artifacts-real-')
  await symlink(real, join(linkParent, 'store'))
  await rejectsWithCode(new LocalArtifactProvider({ root: join(linkParent, 'store') }).init(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)

  const relative = new LocalArtifactProvider({ root: 'relative/store' })
  await rejectsWithCode(relative.init(), ARTIFACT_CODES.PROVIDER_UNAVAILABLE)
})

test('memory and local providers satisfy the same lifecycle contract', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  for (const kind of ['memory', 'local']) {
    const provider = kind === 'memory' ? new MemoryArtifactProvider() : undefined
    const { ctx, service } = await harness({ provider })
    assert.deepEqual([...service.capabilities], ['read', 'present', 'export', 'delete'])
    const agent = stubAgent(`conformance-${kind}`, workspace)
    publish(ctx, agent)
    const record = await service.write(agent, { name: 'c.bin', mediaType: 'application/octet-stream', producerTool: 'test' }, chunks(1000, 3), testSignal)
    assert.equal(record.bytes, 3000)
    const read = await service.read(agent, record.ref, { signal: testSignal })
    assert.equal(sha256(read.data), record.sha256)
    const listed = await service.list(agent)
    assert.equal(listed.length, 1)
    await service.dispose(agent, record.ref)
    await rejectsWithCode(service.read(agent, record.ref, { signal: testSignal }), ARTIFACT_CODES.NOT_FOUND)
    assert.deepEqual(await service.list(agent), [])
    await ctx.fiber.dispose()
  }
})

test('artifact tools run through the DSH tool pipeline with exact arguments and content-free rendering', async () => {
  const workspace = await temporaryDirectory('artifacts-workspace-')
  const { ctx, root } = await harness()
  const agent = stubAgent('tooling', workspace)
  const other = stubAgent('tooling-other', workspace)
  publish(ctx, agent)
  publish(ctx, other)
  assert.deepEqual(ARTIFACT_TOOL_NAMES, ['artifact_write', 'artifact_present', 'artifact_read', 'artifact_export', 'artifact_dispose'])
  for (const name of ARTIFACT_TOOL_NAMES) {
    const definition = ctx.tools.get(name)
    assert.ok(definition, `${name} is registered`)
    assertDshSchemaSubset(definition.parameters, `${name}.parameters`)
    assertDshSchemaSubset(definition.output.schema, `${name}.output`)
    assert.equal(definition.parameters.additionalProperties, false)
  }
  const exportDestination = ctx.tools.get('artifact_export').parameters.properties.destination
  assert.equal(exportDestination.oneOf.length, 2, 'the declared destination contract is exactly the two runtime shapes')
  assert.deepEqual(exportDestination.oneOf[0].required, ['class', 'path'])
  assert.deepEqual(exportDestination.oneOf[1].required, ['class'])

  const execute = (name, args, actor = agent, suffix = '') => ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call:${name}${suffix}`),
    name,
    arguments: args,
    agent: actor,
  })

  const written = await execute('artifact_write', {
    name: 'summary.md',
    media_type: 'text/markdown',
    content: '# Summary\n\nall good',
  })
  assert.equal(written.isError, false, JSON.stringify(written))
  assert.match(written.value.ref, /^artifact:[0-9a-f]{32}$/)
  assert.equal(written.value.producer_tool, 'artifact_write')
  assert.equal(written.value.retention_class, 'session')
  const rendered = ctx.tools.get('artifact_write').output.render({}, written.value).map(block => block.text).join('\n')
  assert.equal(rendered.includes(root), false)
  assert.equal(rendered.includes('all good'), false)
  assert.ok(rendered.includes(written.value.ref))

  const binary = await execute('artifact_write', {
    name: 'blob.bin',
    media_type: 'application/octet-stream',
    content: Buffer.from([1, 2, 3, 250]).toString('base64'),
    encoding: 'base64',
    retention: 'retained',
  }, agent, ':binary')
  assert.equal(binary.isError, false, JSON.stringify(binary))
  assert.equal(binary.value.bytes, 4)
  assert.equal(binary.value.sha256, sha256(new Uint8Array([1, 2, 3, 250])))

  const presented = await execute('artifact_present', { ref: written.value.ref })
  assert.equal(presented.isError, false, JSON.stringify(presented))
  assert.equal(presented.value.preview, '# Summary\n\nall good')
  assert.deepEqual(presented.value.capabilities, ['read', 'present', 'export', 'delete'])

  const read = await execute('artifact_read', { ref: written.value.ref })
  assert.equal(read.isError, false, JSON.stringify(read))
  assert.equal(read.value.encoding, 'utf8')
  assert.equal(read.value.content, '# Summary\n\nall good')
  const binaryRead = await execute('artifact_read', { ref: binary.value.ref }, agent, ':binary')
  assert.equal(binaryRead.value.encoding, 'base64')
  assert.equal(binaryRead.value.content, Buffer.from([1, 2, 3, 250]).toString('base64'))
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x41])
  const badText = await execute('artifact_write', {
    media_type: 'text/plain',
    content: invalidUtf8.toString('base64'),
    encoding: 'base64',
  }, agent, ':badutf8')
  assert.equal(badText.isError, false, JSON.stringify(badText))
  const badTextRead = await execute('artifact_read', { ref: badText.value.ref }, agent, ':badutf8')
  assert.equal(badTextRead.value.encoding, 'base64', 'non-UTF-8 text bytes are never decoded lossily')
  assert.equal(badTextRead.value.content, invalidUtf8.toString('base64'))

  const exported = await execute('artifact_export', {
    ref: written.value.ref,
    destination: { class: 'workspace', path: 'docs/summary.md' },
  })
  assert.equal(exported.isError, false, JSON.stringify(exported))
  assert.equal(exported.value.schema_version, ARTIFACT_EXPORT_RECEIPT_SCHEMA)
  assert.equal(await readFile(join(workspace, 'docs', 'summary.md'), 'utf8'), '# Summary\n\nall good')

  const download = await execute('artifact_export', {
    ref: written.value.ref,
    destination: { class: 'download' },
  }, agent, ':download')
  assert.equal(download.isError, true)
  assert.equal(download.error.info.code, ARTIFACT_CODES.CAPABILITY_UNSUPPORTED)

  const foreign = await execute('artifact_present', { ref: written.value.ref }, other, ':foreign')
  assert.equal(foreign.isError, true)
  assert.equal(foreign.error.info.code, ARTIFACT_CODES.ACCESS_DENIED)

  const ambiguous = await execute('artifact_present', { ref: written.value.ref, extra: true }, agent, ':ambiguous')
  assert.equal(ambiguous.isError, true)
  assert.equal(ambiguous.error.info.code, ARTIFACT_CODES.ARGUMENT_INVALID)
  const badEncoding = await execute('artifact_write', { name: 'x', media_type: 'text/plain', content: '!!!', encoding: 'base64' }, agent, ':badbase64')
  assert.equal(badEncoding.isError, true)
  assert.equal(badEncoding.error.info.code, ARTIFACT_CODES.ARGUMENT_INVALID)
  const badMedia = await execute('artifact_write', { name: 'x', media_type: 'not a media type', content: 'x' }, agent, ':badmedia')
  assert.equal(badMedia.isError, true)
  assert.equal(badMedia.error.info.code, ARTIFACT_CODES.ARGUMENT_INVALID)
  const agentless = await ctx.tools.execute({ signal: testSignal, callId: CallId('call:agentless'), name: 'artifact_present', arguments: { ref: written.value.ref } })
  assert.equal(agentless.isError, true)
  assert.equal(agentless.error.info.code, ARTIFACT_CODES.ACCESS_DENIED)

  const disposed = await execute('artifact_dispose', { ref: written.value.ref })
  assert.equal(disposed.isError, false, JSON.stringify(disposed))
  assert.deepEqual(disposed.value, { ref: written.value.ref, outcome: 'disposed' })
  const again = await execute('artifact_dispose', { ref: written.value.ref }, agent, ':again')
  assert.equal(again.isError, true)
  assert.equal(again.error.info.code, ARTIFACT_CODES.NOT_FOUND)

  const definitions = createArtifactTools(ctx.get('dshRuntimeArtifacts'))
  assert.equal(definitions.length, 5)
  assert.ok(Object.isFrozen(definitions))
})
