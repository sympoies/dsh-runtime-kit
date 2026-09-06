export type ToolDefinition = import('@deepseek-ai/dsh-tools').ToolDefinition

import {
  normalizeRuntimeContextIntent,
  RUNTIME_CONTEXT_INTENTS,
} from './intents.js'

export type ContextDocument = { source: 'home' | 'project', scope: 'home' | 'project' | 'global', content: string }

export type ContextDecision = { schema_version: 'decision.context.v1', request_id: string, product: 'dsh', intent: string, reason: 'prepared' | 'already-current', verified: true, documents: ContextDocument[], document_count: number, total_bytes: number }

export type ContextClient = { prepare: (exec: import('@deepseek-ai/dsh-tools').ToolRunContext, intent: string) => Promise<ContextDecision> }

function validDocument(value: unknown): value is ContextDocument  {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = ((value) as Record<string, unknown>)
  return (candidate.source === 'home' || candidate.source === 'project')
    && ['home', 'project', 'global'].includes(String(candidate.scope))
    && typeof candidate.content === 'string'
}

function sanitizeDecision(decision: ContextDecision, intent: string) {
  if (decision === null || typeof decision !== 'object'
    || decision.schema_version !== 'decision.context.v1'
    || decision.product !== 'dsh'
    || decision.intent !== intent
    || !['prepared', 'already-current'].includes(decision.reason)
    || decision.verified !== true
    || !Array.isArray(decision.documents)
    || !decision.documents.every(validDocument)
    || !Number.isSafeInteger(decision.document_count)
    || decision.document_count !== decision.documents.length
    || !Number.isSafeInteger(decision.total_bytes)
    || decision.total_bytes < 0) {
    throw new Error('runtime_context received an invalid context decision')
  }
  const totalBytes = decision.documents.reduce(
    (total, document) => total + Buffer.byteLength(document.content, 'utf8'),
    0,
  )
  if (totalBytes !== decision.total_bytes) {
    throw new Error('runtime_context received an invalid context byte count')
  }
  return {
    schema_version: 'dsh-runtime-context.result.v1',
    intent,
    status: decision.reason,
    documents: decision.documents.map(document => ({
      source: document.source,
      scope: document.scope,
      content: document.content,
    })),
    document_count: decision.document_count,
    total_bytes: decision.total_bytes,
  }
}

function renderResult(value: ReturnType<typeof sanitizeDecision>) {
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
    description: 'Prepare one declared runtime-policy intent and return only its bounded required documents.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: [...RUNTIME_CONTEXT_INTENTS] },
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
          status: { type: 'string', enum: ['prepared', 'already-current'] },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', enum: ['home', 'project'] },
                scope: { type: 'string', enum: ['home', 'project', 'global'] },
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
      render: (_args, value) => renderResult(((value) as ReturnType<typeof sanitizeDecision>)),
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('runtime_context expects an argument object')
      }
      const record = ((args) as Record<string, unknown>)
      if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'intent')) {
        throw new TypeError('runtime_context expects exactly one intent')
      }
      const intent = normalizeRuntimeContextIntent(record.intent)
      return sanitizeDecision(await client.prepare(exec, intent), intent)
    },
  }
  return Object.freeze(definition)
}
