import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { createPackagedContextClient, createRuntimeContextTool } from '../dist/src/context/index.js'
import { RUNTIME_CONTEXT_DOCUMENTS, RUNTIME_CONTEXT_INTENT_PHASES } from '../dist/src/context/intents.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGED_HOME = join(ROOT, 'agent-docs')

async function withHome(files, run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-runtime-context-'))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(home, name), content)
    return await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** The packaged catalog's home documents keyed like RUNTIME_CONTEXT_DOCUMENTS. */
async function packagedCatalogRoutes() {
  const text = await readFile(join(PACKAGED_HOME, 'AGENT_DOCS.toml'), 'utf8')
  const routes = {}
  for (const block of text.split('[[document]]').slice(1)) {
    const field = name => new RegExp(`^${name} = "([^"]+)"`, 'mu').exec(block)?.[1]
    const phase = field('phase')
    const key = phase === undefined ? field('context') : `${field('context')}:${phase}`
    assert.equal(field('scope'), 'home')
    assert.equal(field('product'), 'dsh')
    ;(routes[key] ??= []).push(field('path'))
  }
  return routes
}

test('the packaged document map routes exactly the packaged catalog entries', async () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(RUNTIME_CONTEXT_DOCUMENTS)),
    await packagedCatalogRoutes(),
  )
  for (const [intent, phases] of Object.entries(RUNTIME_CONTEXT_INTENT_PHASES)) {
    const keys = phases.length === 0 ? [intent] : phases.map(phase => `${intent}:${phase}`)
    for (const key of keys) assert.ok(RUNTIME_CONTEXT_DOCUMENTS[key]?.length > 0, key)
  }
})

test('runtime_context returns the packaged project-dev edit contract by default', async () => {
  const tool = createRuntimeContextTool(createPackagedContextClient({ contextHome: PACKAGED_HOME }))
  const result = await tool.execute({ intent: 'project-dev' })
  const content = await readFile(join(PACKAGED_HOME, 'PROJECT_DEV_EDIT.md'), 'utf8')
  assert.deepEqual(result, {
    schema_version: 'dsh-runtime-context.result.v1',
    intent: 'project-dev',
    status: 'prepared',
    documents: [{ source: 'home', scope: 'home', content }],
    document_count: 1,
    total_bytes: Buffer.byteLength(content, 'utf8'),
  })
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /^Runtime context `project-dev` prepared: 1 required document,/u)
  assert.match(rendered, /<runtime-context-document index="1" source="home" scope="home">/u)
})

test('runtime_context resolves delivery, review, and phaseless intents in catalog order', async () => {
  await withHome({
    'WORK_MODES.md': 'modes\n',
    'GIT_DELIVERY.md': 'git\n',
    'REVIEW_CONVERGENCE.md': 'review\n',
    'EVIDENCE.md': 'evidence\n',
    'DEVLOG.md': 'devlog\n',
  }, async home => {
    const tool = createRuntimeContextTool(createPackagedContextClient({ contextHome: home }))
    const contents = async args => (await tool.execute(args)).documents.map(document => document.content)
    assert.deepEqual(await contents({ intent: 'project-dev', phase: 'delivery' }), ['modes\n', 'git\n'])
    assert.deepEqual(await contents({ intent: 'project-dev', phase: 'review' }), ['review\n', 'evidence\n'])
    assert.deepEqual(await contents({ intent: 'devlog' }), ['devlog\n'])
  })
})

test('runtime_context rejects retired and ambiguous arguments before reading', async () => {
  let reads = 0
  const tool = createRuntimeContextTool({
    maxBytes: 1024,
    async prepare() {
      reads += 1
      throw new Error('unreachable')
    },
  })
  for (const args of [
    { intent: 'project-dev', project_path: '/workspace/project' },
    { intent: 'project-dev', extra: true },
    {},
    null,
    [],
  ]) {
    await assert.rejects(tool.execute(args), TypeError)
  }
  await assert.rejects(tool.execute({ intent: 'unknown-intent' }), /runtime-context-intent-not-allowed/u)
  await assert.rejects(tool.execute({ intent: 'devlog', phase: 'edit' }), /runtime-context-phase-not-allowed/u)
  assert.equal(reads, 0)
  assert.equal(tool.parameters.properties.project_path, undefined)
})

test('without a context home the client serves this package\'s documents and ignores retired agent-docs config', async () => {
  const retiredConfig = { agentDocsHome: '/retired/agent-docs', contextMaxBytes: 64 * 1024 }
  const client = createPackagedContextClient(retiredConfig)
  for (const [key, names] of Object.entries(RUNTIME_CONTEXT_DOCUMENTS)) {
    const [intent, phase] = key.split(':')
    const result = await client.prepare(intent, phase)
    assert.equal(result.document_count, names.length)
    for (const [index, name] of names.entries()) {
      assert.equal(result.documents[index].content, await readFile(join(PACKAGED_HOME, name), 'utf8'))
    }
  }
})

test('the packaged context client reads only bounded regular files in its docs home', async () => {
  assert.throws(() => createPackagedContextClient({ contextHome: 'relative' }), /contextHome is required/u)
  await withHome({ 'outside.md': 'outside\n', 'DEVLOG.md': 'x'.repeat(64) }, async home => {
    await symlink(join(home, 'outside.md'), join(home, 'MEMORY.md'))
    const client = createPackagedContextClient({ contextHome: home, contextMaxBytes: 32 })
    assert.equal(client.maxBytes, 32)
    await assert.rejects(client.prepare('memory'), /runtime-context-document-unavailable/u)
    await assert.rejects(client.prepare('devlog'), /runtime-context-budget-exceeded/u)
    await assert.rejects(client.prepare('web-testing'), /runtime-context-document-unavailable/u)
  })
})
