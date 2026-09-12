#!/usr/bin/env node

import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

import {
  DSH_HISTORY_PACKAGES,
  dshHistoryCapabilities,
  listDshHistorySessions,
  readDshHistorySummarySnapshots,
  readDshHistoryMessages,
  summarizeDshHistorySessions,
  type DshHistoryBackend,
  type DshHistoryMessageDirection,
} from '../src/compat/dsh-history-adapter.js'

const require = createRequire(import.meta.url)

function fail(message: string, code = 64): never {
  process.stderr.write(`dsh-runtime-kit-history: ${message}\n`)
  process.exit(code)
}

function option(args: string[], name: string, required = false) {
  const index = args.indexOf(name)
  if (index === -1) {
    if (required) fail(`missing ${name}`)
    return undefined
  }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`missing value for ${name}`)
  args.splice(index, 2)
  return value
}

async function createBackend(root: string, compression: string): Promise<{ backend: DshHistoryBackend, dispose(): Promise<void> }> {
  const load = (specifier: string) => import(specifier)
  const [
    { Context },
    { SessionStore, foldSurface },
    { JsonlSessionPersistence },
    { SessionQueryEngine },
    { foldSessionTitle },
  ] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-session-persistence-jsonl'),
    load('@deepseek-ai/dsh-session-query'),
    load('@deepseek-ai/dsh-session-title'),
  ])
  class ReadOnlySessionQuery extends SessionQueryEngine {
    async searchSessions() { throw new Error('full-text search is not supported by the history adapter') }
    async searchEvents() { throw new Error('full-text search is not supported by the history adapter') }
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  await ctx.plugin(ReadOnlySessionQuery)
  const persistence = ctx.sessionPersistence
  const query = ctx.sessionQuery
  return {
    backend: {
      listSnapshots: async signal => {
        const snapshots = await persistence.listSnapshots(signal)
        const listed = []
        for (let index = 0; index < snapshots.length; index += 32) {
          signal?.throwIfAborted()
          const batch = await Promise.all(snapshots.slice(index, index + 32).map(async (snapshot: any) => {
            try {
              const metadata = await stat(persistence.locate(snapshot.header).path, { bigint: true })
              return {
                header: snapshot.header,
                revision: String(snapshot.revision),
                updatedAt: Number(metadata.mtimeNs / 1_000_000n),
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              return undefined
            }
          }))
          listed.push(...batch.filter(item => item !== undefined))
        }
        return listed
      },
      readSummarySnapshots: (ids, signal) => readDshHistorySummarySnapshots(ids, {
        inspect: (sessionId, inspectSignal) => persistence.inspect(sessionId, inspectSignal),
        foldSurface: events => foldSurface(events).nodes,
        foldTitle: events => foldSessionTitle(events)?.title,
      }, signal),
      readSurface: id => query.readSurface(id),
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!['capabilities', 'list', 'summaries', 'messages'].includes(command ?? '')) {
    fail('usage: dsh-runtime-kit-history <capabilities|list|summaries|messages> [--root <directory>] [options]')
  }
  const versions = Object.fromEntries(DSH_HISTORY_PACKAGES.map(packageName => {
    const manifest = require(`${packageName}/package.json`) as { version?: unknown }
    return [packageName, typeof manifest.version === 'string' ? manifest.version : undefined]
  }))
  const capabilities = dshHistoryCapabilities(versions)
  if (command === 'capabilities') {
    if (args.length > 0) fail('capabilities accepts no additional arguments')
    process.stdout.write(`${JSON.stringify({ schema_version: 'dsh-runtime-kit.history.v1', data: capabilities })}\n`)
    return
  }
  const root = option(args, '--root', true)!
  if (!isAbsolute(root)) fail('--root must be absolute')
  const compression = option(args, '--compression') ?? 'zstd'
  if (!['zstd', 'none'].includes(compression)) fail('--compression must be zstd or none')
  const sessionIds: string[] = []
  while (args.includes('--session-id')) sessionIds.push(option(args, '--session-id', true)!)
  const direction = (option(args, '--direction') ?? 'latest') as DshHistoryMessageDirection
  const cursor = option(args, '--cursor')
  const limit = Number(option(args, '--limit') ?? '50')
  if (args.length > 0) fail(`unexpected argument: ${args[0]}`)
  if (command !== 'list' && sessionIds.length === 0) fail('at least one --session-id is required')
  if (sessionIds.length > 100 || sessionIds.some(id => id.length > 256)) fail('session ids exceed safe bounds')
  if (command === 'messages' && sessionIds.length !== 1) fail('messages requires exactly one --session-id')
  if (!['forward', 'latest', 'older'].includes(direction)) fail('--direction must be forward, latest, or older')

  const mounted = await createBackend(root, compression)
  try {
    const data = command === 'list'
      ? await listDshHistorySessions(mounted.backend, AbortSignal.timeout(2_000))
      : command === 'summaries'
        ? await summarizeDshHistorySessions(mounted.backend, sessionIds, AbortSignal.timeout(5_000))
        : await readDshHistoryMessages(mounted.backend, sessionIds[0], { direction, cursor, limit })
    process.stdout.write(`${JSON.stringify({ schema_version: 'dsh-runtime-kit.history.v1', data })}\n`)
  } finally {
    await mounted.dispose()
  }
}

main().catch(() => fail('operation failed', 70))
