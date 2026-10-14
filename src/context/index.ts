import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

import { requiredAbsolutePath } from '../nils/agent-hook-runtime.js'

export type ToolDefinition = import('@deepseek-ai/dsh-tools').ToolDefinition

import {
  normalizeRuntimeContextIntent,
  RUNTIME_CONTEXT_DOCUMENTS,
  RUNTIME_CONTEXT_INTENTS,
  RUNTIME_CONTEXT_PHASES,
  runtimeContextPhase,
} from './intents.js'

export type ContextDocument = { source: 'home', scope: 'home', content: string }

export type ContextResult = { schema_version: 'dsh-runtime-context.result.v1', intent: string, status: 'prepared', documents: ContextDocument[], document_count: number, total_bytes: number }

export type ContextClient = { maxBytes: number, prepare: (intent: string, phase?: string) => Promise<ContextResult> }

const DEFAULT_CONTEXT_BYTES = 20 * 1024
const MAX_CONTEXT_BYTES = 64 * 1024

function failure(reason: string) {
  return new Error(`dsh-runtime-kit:runtime-context-${reason}`)
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

/**
 * Read one packaged document without following a link out of the activated
 * docs home, and refuse anything that is not a bounded regular file.
 */
async function readDocument(home: string, name: string, budget: number) {
  let handle
  try {
    handle = await open(join(home, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw failure('document-unavailable')
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw failure('document-unavailable')
    if (metadata.size > budget) throw failure('budget-exceeded')
    const bytes = await handle.readFile()
    if (bytes.byteLength > budget) throw failure('budget-exceeded')
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Serve the packaged guidance documents from the activated, digest-verified
 * docs home. This is a plain reader: no session state, receipt, or external
 * companion participates, and nothing gates other tools on it.
 */
export function createPackagedContextClient(config: { agentDocsHome?: string, contextMaxBytes?: number } = {}): ContextClient {
  const home = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
  const maxBytes = boundedPositiveInteger(config.contextMaxBytes, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES)
  return Object.freeze({
    maxBytes,
    async prepare(intent: string, phase?: string): Promise<ContextResult> {
      const names = RUNTIME_CONTEXT_DOCUMENTS[phase === undefined ? intent : `${intent}:${phase}`]
      if (names === undefined) throw failure('intent-not-packaged')
      const documents: ContextDocument[] = []
      let total = 0
      for (const name of names) {
        const content = await readDocument(home, name, maxBytes - total)
        total += Buffer.byteLength(content, 'utf8')
        documents.push({ source: 'home', scope: 'home', content })
      }
      return {
        schema_version: 'dsh-runtime-context.result.v1',
        intent,
        status: 'prepared',
        documents,
        document_count: documents.length,
        total_bytes: total,
      }
    },
  })
}

function renderResult(value: ContextResult) {
  const noun = value.document_count === 1 ? 'document' : 'documents'
  const header = `Runtime context \`${value.intent}\` ${value.status}: ${value.document_count} required ${noun}, ${value.total_bytes} bytes.`
  if (value.documents.length === 0) return [{ type: (('text') as const), text: header }]
  const sections = value.documents.map((document, index) => [
    `<runtime-context-document index="${index + 1}" source="${document.source}" scope="${document.scope}">`,
    document.content,
    '</runtime-context-document>',
  ].join('\n'))
  return [{ type: (('text') as const), text: [header, ...sections].join('\n\n') }]
}

/** Create the one explicit model-facing selective context surface. */
export function createRuntimeContextTool(client: ContextClient): ToolDefinition  {
  if (client === null || typeof client !== 'object' || typeof client.prepare !== 'function') {
    throw new TypeError('runtime_context requires a context client')
  }
  const definition: ToolDefinition = {
    name: 'runtime_context',
    description: 'Return the packaged runtime guidance for one declared intent. For project-dev the edit phase is the default; request delivery before durable tracking, commits, pull requests, or merges, and review before reviewing or resolving review threads.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: [...RUNTIME_CONTEXT_INTENTS] },
        phase: { type: 'string', enum: [...RUNTIME_CONTEXT_PHASES], description: 'Policy phase of project-dev; defaults to edit. Other intents take no phase.' },
      },
      required: ['intent'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          schema_version: { type: 'string', const: 'dsh-runtime-context.result.v1' },
          intent: { type: 'string' },
          status: { type: 'string', enum: ['prepared'] },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', enum: ['home'] },
                scope: { type: 'string', enum: ['home'] },
                content: { type: 'string' },
              },
              required: ['source', 'scope', 'content'],
              additionalProperties: false,
            },
          },
          document_count: { type: 'integer' },
          total_bytes: { type: 'integer' },
        },
        required: [
          'schema_version',
          'intent',
          'status',
          'documents',
          'document_count',
          'total_bytes',
        ],
        additionalProperties: false,
      },
      render: (_args, value) => renderResult(((value) as ContextResult)),
    },
    async execute(args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('runtime_context expects an argument object')
      }
      const record = ((args) as Record<string, unknown>)
      if (!Object.hasOwn(record, 'intent')
        || Object.keys(record).some(key => !['intent', 'phase'].includes(key))) {
        throw new TypeError('runtime_context expects one intent and an optional phase')
      }
      const intent = normalizeRuntimeContextIntent(record.intent)
      const phase = runtimeContextPhase(intent, record.phase)
      return client.prepare(intent, phase)
    },
  }
  return Object.freeze(definition)
}
