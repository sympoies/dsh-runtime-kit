// @ts-check

/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */

import {
  normalizeRuntimeContextIntent,
  RUNTIME_CONTEXT_INTENTS,
} from './intents.js'

/**
 * @typedef ContextDocument
 * @property {'home' | 'project'} source
 * @property {'home' | 'project' | 'global'} scope
 * @property {string} content
 */

/**
 * @typedef ContextDecision
 * @property {'decision.context.v1'} schema_version
 * @property {string} request_id
 * @property {'dsh'} product
 * @property {string} intent
 * @property {'prepared' | 'already-current'} reason
 * @property {true} verified
 * @property {ContextDocument[]} documents
 * @property {number} document_count
 * @property {number} total_bytes
 */

/**
 * @typedef ContextClient
 * @property {(exec: import('@deepseek-ai/dsh-tools').ToolRunContext, intent: string) => Promise<ContextDecision>} prepare
 */

/** @param {unknown} value @returns {value is ContextDocument} */
function validDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = /** @type {Record<string, unknown>} */ (value)
  return (candidate.source === 'home' || candidate.source === 'project')
    && ['home', 'project', 'global'].includes(String(candidate.scope))
    && typeof candidate.content === 'string'
}

/** @param {ContextDecision} decision @param {string} intent */
function sanitizeDecision(decision, intent) {
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

/** @param {ReturnType<typeof sanitizeDecision>} value */
function renderResult(value) {
  const noun = value.document_count === 1 ? 'document' : 'documents'
  const header = `Runtime context \`${value.intent}\` ${value.status}: ${value.document_count} required ${noun}, ${value.total_bytes} bytes.`
  if (value.documents.length === 0) return [{ type: /** @type {const} */ ('text'), text: header }]
  const sections = value.documents.map((document, index) => [
    `<runtime-context-document index="${index + 1}" source="${document.source}" scope="${document.scope}">`,
    document.content,
    '</runtime-context-document>',
  ].join('\n'))
  return [{ type: /** @type {const} */ ('text'), text: [header, ...sections].join('\n\n') }]
}

/**
 * Create the one explicit model-facing selective context surface.
 *
 * @param {ContextClient} client
 * @returns {ToolDefinition}
 */
export function createRuntimeContextTool(client) {
  if (client === null || typeof client !== 'object' || typeof client.prepare !== 'function') {
    throw new TypeError('runtime_context requires a context client')
  }
  /** @type {ToolDefinition} */
  const definition = {
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
      render: (_args, value) => renderResult(/** @type {ReturnType<typeof sanitizeDecision>} */ (value)),
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('runtime_context expects an argument object')
      }
      const record = /** @type {Record<string, unknown>} */ (args)
      if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'intent')) {
        throw new TypeError('runtime_context expects exactly one intent')
      }
      const intent = normalizeRuntimeContextIntent(record.intent)
      return sanitizeDecision(await client.prepare(exec, intent), intent)
    },
  }
  return Object.freeze(definition)
}
