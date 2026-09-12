const PREVIEW_CHARS = 240
const MESSAGE_CHARS = 16 * 1024
const DSH_HISTORY_SCHEMA = 'dsh-runtime-kit.history.v1'
const DSH_HISTORY_VERSION = '0.1.2-rc.1'

export const DSH_HISTORY_PACKAGES = [
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-title',
] as const

type DshHeader = {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  delegationDepth?: number
}

export type DshEvent = {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

export type DshHistorySummary = {
  provider_session_id: string
  title?: string
  first_user_prompt_preview?: string
  last_user_prompt_preview?: string
  updated_at?: string
}

export type DshHistorySummaryProjection = {
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ events: DshEvent[] }>
  foldSurface(events: readonly DshEvent[]): readonly number[]
  foldTitle(events: readonly DshEvent[]): string | undefined
}

export interface DshHistoryBackend {
  listSnapshots(signal?: AbortSignal): Promise<Array<{
    header: DshHeader
    revision: string
    updatedAt: number
  }>>
  readSummarySnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<Array<{
    sessionId: string
    status: 'fulfilled' | 'rejected'
    value?: DshHistorySummary
  }>>
  readSurface(sessionId: string): Promise<{
    capturedThroughSeq: number | null
    events: DshEvent[]
  }>
}

export type DshHistoryMessageDirection = 'forward' | 'latest' | 'older'

export type DshHistoryMessagePage = {
  messages: Array<{ id: string, role: 'user' | 'assistant', text: string, timestamp?: string }>
  next_cursor?: string
  older_cursor?: string
}

export function dshHistoryCapabilities(versions: Readonly<Record<string, string | undefined>>) {
  for (const packageName of DSH_HISTORY_PACKAGES) {
    if (versions[packageName] !== DSH_HISTORY_VERSION) {
      throw new Error(`unsupported DSH history package version: ${packageName}`)
    }
  }
  return {
    adapter_schema: DSH_HISTORY_SCHEMA,
    session_format: `dsh-session@${DSH_HISTORY_VERSION}`,
    operations: ['list', 'summaries', 'messages'],
  }
}

function isoDate(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('DSH history timestamp is invalid')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('DSH history timestamp is invalid')
  return date.toISOString()
}

function cleanText(value: string, maxChars: number, collapseWhitespace = true): string {
  const safe = value.replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
  const normalized = (collapseWhitespace ? safe.replace(/\s+/gu, ' ') : safe).trim()
  return [...normalized].slice(0, maxChars).join('')
}

function textBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap(block => {
    if (block === null || typeof block !== 'object') return []
    const item = block as Record<string, unknown>
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
  const cleaned = cleanText(text, MESSAGE_CHARS, false)
  return cleaned.length > 0 ? cleaned : undefined
}

function messageOf(event: DshEvent) {
  if (!Number.isSafeInteger(event.seq) || (event.seq ?? -1) < 0) return undefined
  if (event.data === null || typeof event.data !== 'object') return undefined
  const data = event.data as Record<string, unknown>
  let role: 'user' | 'assistant'
  let text: string | undefined
  if (event.type === 'user/message') {
    if (data.source === null || typeof data.source !== 'object'
      || (data.source as Record<string, unknown>).kind !== 'user') return undefined
    role = 'user'
    text = textBlocks(data.content)
  } else if (event.type === 'assistant/message') {
    if (data.message === null || typeof data.message !== 'object') return undefined
    role = 'assistant'
    text = textBlocks((data.message as Record<string, unknown>).content)
  } else return undefined
  if (text === undefined) return undefined
  return {
    id: `dsh:${event.seq}`,
    role,
    text,
    ...(Number.isSafeInteger(event.time) && (event.time ?? -1) >= 0
      ? { timestamp: isoDate(event.time as number) }
      : {}),
    seq: event.seq as number,
    time: Number.isSafeInteger(event.time) ? event.time as number : undefined,
  }
}

export async function listDshHistorySessions(backend: DshHistoryBackend, signal?: AbortSignal) {
  const snapshots = await backend.listSnapshots(signal)
  return snapshots
    .filter(snapshot => snapshot.header.parentSession === undefined
      && (snapshot.header.delegationDepth === undefined || snapshot.header.delegationDepth === 0))
    .flatMap(snapshot => {
      try {
        return [{
          provider_session_id: snapshot.header.id,
          cwd: snapshot.header.cwd ?? '(unknown)',
          created_at: isoDate(snapshot.header.createdAt),
          updated_at: isoDate(snapshot.updatedAt),
          revision: snapshot.revision,
        }]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
      || left.provider_session_id.localeCompare(right.provider_session_id))
}

export async function summarizeDshHistorySessions(
  backend: DshHistoryBackend,
  sessionIds: readonly string[],
  signal?: AbortSignal,
) {
  const uniqueIds = [...new Set(sessionIds)]
  const projected = await backend.readSummarySnapshots(uniqueIds, signal)
  return projected.flatMap(result => {
    if (result.status !== 'fulfilled' || result.value === undefined) return []
    return [result.value]
  })
}

export function projectDshHistorySummary(
  providerSessionId: string,
  title: string | undefined,
  events: readonly DshEvent[],
): DshHistorySummary {
  const messages = events.map(messageOf).filter(message => message !== undefined)
  const userMessages = messages.filter(message => message.role === 'user')
  const updatedAt = events.findLast(event => Number.isSafeInteger(event.time))?.time
  const cleanedTitle = typeof title === 'string' ? cleanText(title, PREVIEW_CHARS) : ''
  return {
    provider_session_id: providerSessionId,
    ...(cleanedTitle.length > 0 ? { title: cleanedTitle } : {}),
    ...(userMessages[0] !== undefined
      ? { first_user_prompt_preview: cleanText(userMessages[0].text, PREVIEW_CHARS) }
      : {}),
    ...(userMessages.at(-1) !== undefined
      ? { last_user_prompt_preview: cleanText(userMessages.at(-1)!.text, PREVIEW_CHARS) }
      : {}),
    ...(updatedAt !== undefined ? { updated_at: isoDate(updatedAt) } : {}),
  }
}

export async function readDshHistorySummarySnapshots(
  sessionIds: readonly string[],
  projection: DshHistorySummaryProjection,
  signal?: AbortSignal,
) {
  const uniqueIds = [...new Set(sessionIds)]
  type Observation = Awaited<ReturnType<DshHistoryBackend['readSummarySnapshots']>>[number]
  const results = new Map<string, Observation>()
  let cursor = 0
  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted()
      const index = cursor
      if (index >= uniqueIds.length) return
      cursor += 1
      const sessionId = uniqueIds[index]
      try {
        const inspection = await projection.inspect(sessionId, signal)
        signal?.throwIfAborted()
        const eventsBySeq = new Map(inspection.events.map(event => [event.seq, event]))
        const currentEvents = projection.foldSurface(inspection.events).map(seq => {
          const event = eventsBySeq.get(seq)
          if (event === undefined) throw new Error('DSH surface projection referenced a missing event')
          return event
        })
        results.set(sessionId, {
          sessionId,
          status: 'fulfilled',
          value: projectDshHistorySummary(
            sessionId,
            projection.foldTitle(inspection.events),
            currentEvents,
          ),
        })
      } catch {
        if (signal?.aborted) signal.throwIfAborted()
        results.set(sessionId, { sessionId, status: 'rejected' })
      }
    }
  }
  const workerCount = Math.min(4, uniqueIds.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  signal?.throwIfAborted()
  return uniqueIds.map(sessionId => results.get(sessionId)!)
}

export async function readDshHistoryMessages(
  backend: DshHistoryBackend,
  sessionId: string,
  options: { direction: DshHistoryMessageDirection, cursor?: string, limit: number },
): Promise<DshHistoryMessagePage> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('DSH history message limit must be between 1 and 100')
  }
  const parsedCursor = options.cursor === undefined ? undefined : Number(options.cursor)
  if (parsedCursor !== undefined && (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0)) {
    throw new Error('DSH history message cursor is invalid')
  }
  if (options.direction === 'latest' && parsedCursor !== undefined) {
    throw new Error('latest DSH history paging does not accept a cursor')
  }
  if (options.direction === 'older' && parsedCursor === undefined) {
    throw new Error('older DSH history paging requires a cursor')
  }

  const surface = await backend.readSurface(sessionId)
  let messages = surface.events.map(messageOf).filter(message => message !== undefined)
  let selected
  let hasMore = false
  if (options.direction === 'latest') {
    hasMore = messages.length > options.limit
    selected = messages.slice(-options.limit)
  } else if (options.direction === 'older') {
    messages = messages.filter(message => message.seq < parsedCursor!)
    hasMore = messages.length > options.limit
    selected = messages.slice(-options.limit)
  } else {
    messages = messages.filter(message => message.seq > (parsedCursor ?? -1))
    hasMore = messages.length > options.limit
    selected = messages.slice(0, options.limit)
  }
  return {
    messages: selected.map(({ seq: _seq, time: _time, ...message }) => message),
    ...(options.direction === 'forward' && hasMore && selected.at(-1) !== undefined
      ? { next_cursor: String(selected.at(-1)!.seq) }
      : {}),
    ...(options.direction !== 'forward' && hasMore && selected[0] !== undefined
      ? { older_cursor: String(selected[0].seq) }
      : {}),
  }
}
