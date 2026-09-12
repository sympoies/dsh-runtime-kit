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

type DshEvent = {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

export interface DshHistoryBackend {
  listSnapshots(signal?: AbortSignal): Promise<Array<{
    header: DshHeader
    revision: string
    updatedAt: number
  }>>
  readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<Array<{
    sessionId: string
    status: 'fulfilled' | 'rejected'
    value?: { title?: { title?: string } }
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
  const titles = new Map((await backend.readTitleSnapshots(uniqueIds, signal)).flatMap(result => {
    const title = result.status === 'fulfilled' && typeof result.value?.title?.title === 'string'
      ? cleanText(result.value.title.title, PREVIEW_CHARS)
      : ''
    return title.length > 0 ? [[result.sessionId, title] as const] : []
  }))
  const summaries = []
  for (let index = 0; index < uniqueIds.length; index += 4) {
    const batch = await Promise.all(uniqueIds.slice(index, index + 4).map(async providerSessionId => {
      try {
        const surface = await backend.readSurface(providerSessionId)
        const messages = surface.events.map(messageOf).filter(message => message !== undefined)
        const userMessages = messages.filter(message => message.role === 'user')
        const updatedAt = surface.events.findLast(event => Number.isSafeInteger(event.time))?.time
        return {
          provider_session_id: providerSessionId,
          ...(titles.has(providerSessionId) ? { title: titles.get(providerSessionId) } : {}),
          ...(userMessages[0] !== undefined
            ? { first_user_prompt_preview: cleanText(userMessages[0].text, PREVIEW_CHARS) }
            : {}),
          ...(userMessages.at(-1) !== undefined
            ? { last_user_prompt_preview: cleanText(userMessages.at(-1)!.text, PREVIEW_CHARS) }
            : {}),
          ...(updatedAt !== undefined ? { updated_at: isoDate(updatedAt) } : {}),
        }
      } catch {
        return undefined
      }
    }))
    summaries.push(...batch.filter(summary => summary !== undefined))
  }
  return summaries
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
