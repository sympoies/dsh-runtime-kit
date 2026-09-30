#!/usr/bin/env node

import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DSH_HISTORY_PACKAGES,
  dshHistoryCapabilities,
  dshHistoryRevisionModifiedAt,
  listDshHistorySessions,
  readDshHistorySummarySnapshots,
  readDshHistoryMessages,
  summarizeDshHistorySessions,
  type DshHistoryBackend,
  type DshHistoryMessageDirection,
} from '../src/compat/dsh-history-adapter.js'
import { createDshHistoryModuleResolver } from '../src/compat/dsh-history-profile.js'

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

type Modules = {
  load(specifier: string): Promise<any>
  packageVersion(packageName: string): string | undefined
}

/**
 * Without `--profile-root` the DSH packages come from the installation that
 * carries this runtime-kit copy; with it they come from that DSH profile.
 */
function historyModules(profileRoot: string | undefined): Modules {
  if (profileRoot === undefined) {
    const require = createRequire(import.meta.url)
    return {
      load: specifier => import(specifier),
      packageVersion: packageName => {
        const manifest = require(`${packageName}/package.json`) as { version?: unknown }
        return typeof manifest.version === 'string' ? manifest.version : undefined
      },
    }
  }
  const resolver = createDshHistoryModuleResolver(profileRoot)
  return {
    load: specifier => import(pathToFileURL(resolver.resolve(specifier)).href),
    packageVersion: packageName => resolver.packageVersion(packageName),
  }
}

async function createBackend(modules: Modules, root: string, compression: string): Promise<{ backend: DshHistoryBackend, dispose(): Promise<void> }> {
  const [
    { Context },
    { SessionStore, foldSurface },
    persistenceModule,
    { SessionQueryEngine },
    { foldSessionTitle },
  ] = await Promise.all([
    modules.load('@deepseek-ai/cordis'),
    modules.load('@deepseek-ai/dsh-session'),
    modules.load('@deepseek-ai/dsh-session-persistence-jsonl'),
    modules.load('@deepseek-ai/dsh-session-query'),
    modules.load('@deepseek-ai/dsh-session-title'),
  ])
  const JsonlSessionPersistence = persistenceModule.JsonlSessionPersistence ?? persistenceModule.default
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
        const snapshots = await persistence.list({ signal })
        return snapshots.map((snapshot: any) => ({
          header: snapshot.header,
          revision: String(snapshot.revision),
          updatedAt: dshHistoryRevisionModifiedAt(snapshot.revision),
        }))
      },
      readSummarySnapshots: (ids, signal) => readDshHistorySummarySnapshots(ids, {
        inspect: async (sessionId, inspectSignal) => {
          inspectSignal?.throwIfAborted()
          return query.readSession(sessionId)
        },
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
    fail('usage: dsh-runtime-kit-history <capabilities|list|summaries|messages> [--profile-root <directory>] [--root <directory>] [options]')
  }
  const profileRoot = option(args, '--profile-root')
  if (profileRoot !== undefined && !isAbsolute(profileRoot)) fail('--profile-root must be absolute')
  const modules = historyModules(profileRoot)
  const versions = Object.fromEntries(DSH_HISTORY_PACKAGES.map(packageName => [
    packageName,
    modules.packageVersion(packageName),
  ]))
  const capabilities = dshHistoryCapabilities(versions)
  if (command === 'capabilities') {
    if (args.length > 0) fail('capabilities accepts no arguments other than --profile-root')
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

  const mounted = await createBackend(modules, root, compression)
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
