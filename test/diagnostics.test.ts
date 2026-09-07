import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  classifySessionOutcome,
  sanitizeDiagnosticValue,
  writeDiagnosticBundle,
} from '../dist/src/diagnostics/index.js'

const ROOT = resolve(import.meta.dirname, '..')

test('dsh-runtime-kit routes diagnose and prints its CLI contract', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'dist', 'bin', 'dsh-runtime-kit.js'), 'diagnose', '--help'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Usage: dsh-runtime-kit diagnose --profile/u)
  assert.match(result.stdout, /dsh-runtime-kit\.diagnostic-bundle\.v1/u)
})

test('session outcome classifies every Gate 0 failure family with an actionable receipt', () => {
  const cases = [
    [{ policy_decisions: [{ action: 'block', rule_ids: ['dsh.tool-denied'] }] }, 'tool-denial', 'policy'],
    [{ doctor_status: 'unhealthy', doctor_code: 'companion-identity-invalid' }, 'health-failure', 'runtime-health'],
    [{ error_code: 'plan-drift' }, 'operations-failure', 'operations'],
    [{ exit_code: 1, error_code: 'provider-unavailable' }, 'provider-failure', 'provider'],
    [{ error_code: 'WORKSPACE_DIRTY', error_receipt: 'session.typed_errors[0]' }, 'tool-denial', 'policy'],
    [{ finish_line: { code: 'finish-line-refused' } }, 'finish-line-stop', 'finish-line'],
  ] as const

  for (const [observation, category, component] of cases) {
    const outcome = classifySessionOutcome(observation)
    assert.equal(outcome.schema_version, 'dsh-runtime-kit.session-outcome.v1')
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.category, category)
    assert.equal(outcome.component, component)
    assert.equal(typeof outcome.code, 'string')
    assert.equal(typeof outcome.receipt, 'string')
    assert.equal(typeof outcome.next_action, 'string')
  }

  const multiRule = classifySessionOutcome({
    policy_code: 'dsh.checkout-lease-guard',
    policy_decisions: [{ action: 'block', rule_ids: ['dsh.owner-unclaimed', 'dsh.checkout-lease-guard'] }],
  })
  assert.equal(multiRule.code, 'dsh.checkout-lease-guard')
  assert.match(multiRule.next_action, /managed worktree/u)

  const finishLineWinsOverFollowupDenial = classifySessionOutcome({
    finish_line: { code: 'validation-missing' },
    policy_decisions: [{ action: 'block', rule_ids: ['dsh.checkout-lease-guard'] }],
  })
  assert.equal(finishLineWinsOverFollowupDenial.category, 'finish-line-stop')
  assert.equal(finishLineWinsOverFollowupDenial.code, 'validation-missing')

  const operationsWinsOverHistoricalDenial = classifySessionOutcome({
    error_code: 'plan-drift',
    policy_decisions: [{ action: 'block', rule_ids: ['dsh.unrelated-earlier-rule'] }],
  })
  assert.equal(operationsWinsOverHistoricalDenial.category, 'operations-failure')
  assert.equal(operationsWinsOverHistoricalDenial.code, 'plan-drift')

  const providerWinsOverHistoricalDenial = classifySessionOutcome({
    error_code: 'MISSING_CREDENTIAL',
    policy_decisions: [{ action: 'block', rule_ids: ['dsh.unrelated-earlier-rule'] }],
  })
  assert.equal(providerWinsOverHistoricalDenial.category, 'provider-failure')
  assert.equal(providerWinsOverHistoricalDenial.code, 'MISSING_CREDENTIAL')

  const unrelatedWorkspaceError = classifySessionOutcome({ error_code: 'LSP_WORKSPACE_REQUIRED' })
  assert.equal(unrelatedWorkspaceError.category, 'unknown')
  assert.equal(unrelatedWorkspaceError.component, 'session')
})

test('diagnostic sanitization strips credentials and machine absolute paths recursively', () => {
  const root = '/private/machine/profile'
  const sanitized = sanitizeDiagnosticValue({
    token: 'sk-not-for-evidence',
    nested: [{ cwd: root, message: `failed at ${root}/state.json` }],
    safe: 'healthy',
  })
  const rendered = JSON.stringify(sanitized)
  assert.doesNotMatch(rendered, /sk-not-for-evidence/u)
  assert.doesNotMatch(rendered, /\/private\/machine/u)
  assert.match(rendered, /\[REDACTED\]/u)
  assert.match(rendered, /<absolute-path>/u)
  assert.equal((sanitized as Record<string, unknown>).safe, 'healthy')
  assert.equal(sanitizeDiagnosticValue('@sympoies/dsh-runtime-kit'), '@sympoies/dsh-runtime-kit')
  assert.equal(sanitizeDiagnosticValue('https://example.com/path'), 'https://example.com/path')
  assert.equal(sanitizeDiagnosticValue('authorization: Bearer abcdefghijklmnop'), 'authorization: [REDACTED]')
  let deep: Record<string, unknown> = { value: 'end' }
  for (let index = 0; index < 100; index += 1) deep = { nested: deep }
  assert.match(JSON.stringify(sanitizeDiagnosticValue(deep)), /\[TRUNCATED\]/u)
})

test('diagnostic bundle is owner-only, self-identifying, and contains no raw machine path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-bundle-'))
  chmodSync(root, 0o700)
  const destination = join(root, 'bundle')
  mkdirSync(destination, { mode: 0o700 })
  const bundle = {
    schema_version: 'dsh-runtime-kit.diagnostic-bundle.v1' as const,
    generated_at: '2026-09-07T00:00:00.000Z',
    profile: 'headless',
    status: 'needs-attention',
    session_outcome: classifySessionOutcome({ error_code: 'provider-unavailable', exit_code: 1 }),
    environment: { cwd: root, api_key: 'never-write-this' },
  }
  const manifest = writeDiagnosticBundle(destination, bundle)
  assert.equal(manifest.schema_version, 'dsh-runtime-kit.diagnostic-bundle-manifest.v1')
  assert.deepEqual(manifest.files.map(entry => entry.name), ['diagnostic.json', 'session-outcome.json'])
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(statSync(join(destination, entry.name)).mode & 0o777, 0o600)
  }
  assert.equal(statSync(join(destination, 'manifest.json')).mode & 0o777, 0o600)
  const rendered = readFileSync(join(destination, 'diagnostic.json'), 'utf8')
  assert.match(rendered, /dsh-runtime-kit\.diagnostic-bundle\.v1/u)
  assert.doesNotMatch(rendered, new RegExp(root, 'u'))
  assert.doesNotMatch(rendered, /never-write-this/u)
})

test('collector projects multi-line profile shape and latest typed session error without raw content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-collector-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `
process.stdout.write(JSON.stringify({ok:true,data:{schema_version:'dsh-runtime-kit.doctor.v1',status:'healthy'}})+'\\n')
`)
  writeFileSync(dsh, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({profile:{name:'private-profile-name',id:'private-profile-id',private_value:'must-not-project'},layers:[{name:'private-plugin-name'}]}, null, 2)+'\\n')
`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() },
    { type: 'request/context', data: { provider: 'fixture-provider', model: 'fixture-model' } },
    { type: 'tool/result', data: { content: 'private prompt content', error: { code: 'provider-unavailable', name: 'ProviderError' } } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            content: [{
              type: 'text',
              text: [
                '[stdout]',
                JSON.stringify({
                  schema_version: 'cli.dsh-runtime-kit.operations.v1',
                  ok: false,
                  error: {
                    code: 'plan-drift',
                    message: 'private operation detail with token sk-never-retain',
                    details: {
                      expected_plan_digest: 'a'.repeat(64),
                      observed_plan_digest: 'b'.repeat(64),
                      source_path: root,
                    },
                  },
                }),
                '[exit code: 65]',
              ].join('\n'),
            }],
          }],
        },
      },
    },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(join(sessions, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })

  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH }, observation: { error_code: undefined },
  })
  assert.equal(bundle.composed_profile_tree.status, 'available')
  assert.match(JSON.stringify(bundle.composed_profile_tree), /"name":\{"kind":"string"\}/u)
  assert.equal(bundle.session_outcome.category, 'operations-failure')
  assert.equal(bundle.session_outcome.code, 'plan-drift')
  assert.deepEqual(bundle.session.typed_errors.at(-1)?.details, {
    expected_plan_digest: 'a'.repeat(64),
    observed_plan_digest: 'b'.repeat(64),
  })
  const rendered = JSON.stringify(bundle)
  assert.doesNotMatch(rendered, /must-not-project|private-profile-name|private-profile-id|private-plugin-name/u)
  assert.doesNotMatch(rendered, /private prompt content/u)
  assert.doesNotMatch(rendered, /private operation detail/u)
  assert.doesNotMatch(rendered, /sk-never-retain/u)
  assert.doesNotMatch(rendered, new RegExp(root, 'u'))
})

test('collector projects a DSH terminal provider error without its credential guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-provider-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKitImpl = join(root, 'runtime-kit.mjs')
  const runtimeKit = join(root, 'runtime-kit')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKitImpl, `process.stdout.write('malformed doctor output\\n'); process.exit(65)`)
  writeFileSync(runtimeKit, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runtimeKitImpl)} "$@"\n`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() },
    {
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'MISSING_CREDENTIAL', message: 'provider guidance containing sk-never-retain' },
        },
      },
    },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(join(sessions, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })

  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
  })
  assert.equal(bundle.session_outcome.category, 'provider-failure')
  assert.equal(bundle.session_outcome.code, 'MISSING_CREDENTIAL')
  assert.doesNotMatch(JSON.stringify(bundle), /sk-never-retain|provider guidance/u)
})

test('collector does not attribute an older same-directory session to a new driver run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-session-window-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() - 60_000 },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const sessionPath = join(sessions, 'session.jsonl.zstd')
  writeFileSync(sessionPath, zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  utimesSync(sessionPath, old, old)

  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const startedAt = Date.now()
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
    observation: { exit_code: 0 },
    sessionWindow: { started_at_ms: startedAt, finished_at_ms: startedAt + 1_000 },
  })
  assert.equal(bundle.session.status, 'unavailable')
  assert.equal(bundle.session_outcome.status, 'completed')
  assert.equal(bundle.session_outcome.code, 'completed')
})

test('collector preserves exact WORKSPACE_DIRTY evidence and managed-worktree guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-dirty-workspace-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() },
    {
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'WORKSPACE_DIRTY', message: 'private dirty-file details' },
        },
      },
    },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(join(sessions, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })

  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
  })
  assert.equal(bundle.session_outcome.category, 'tool-denial')
  assert.equal(bundle.session_outcome.component, 'policy')
  assert.equal(bundle.session_outcome.code, 'WORKSPACE_DIRTY')
  assert.equal(bundle.session_outcome.receipt, 'session.typed_errors[0]')
  assert.match(bundle.session_outcome.next_action, /managed worktree/u)
  assert.doesNotMatch(JSON.stringify(bundle), /private dirty-file details/u)
})

test('collector keeps failed doctor collection explicit when no session evidence exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-unavailable-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write('not-json\\n'); process.exit(65)`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
  })
  assert.equal(bundle.doctor.status, 'unavailable')
  assert.equal(bundle.session_outcome.status, 'unavailable')
  assert.equal(bundle.session_outcome.category, 'unknown')
  assert.equal(bundle.session_outcome.code, 'session-outcome-unavailable')
})

test('collector uses an exact nested agent-hook denial over trace rule history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-policy-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() },
    { type: 'tool/result', data: { message: { content: [{
      type: 'tool-result',
      content: [{ type: 'text', text: '[stderr]\nagent-hook:dsh.checkout-lease-guard\n[exit code: 65]' }],
    }] } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(join(sessions, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })
  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
    observation: { policy_decisions: [{ action: 'block', rule_ids: ['dsh.earlier-rule', 'dsh.checkout-lease-guard'] }] },
  })
  assert.deepEqual(bundle.session.typed_errors, [{
    code: 'dsh.checkout-lease-guard',
    event: 'tool/result:agent-hook',
  }])
  assert.equal(bundle.session_outcome.category, 'tool-denial')
  assert.equal(bundle.session_outcome.code, 'dsh.checkout-lease-guard')
  assert.equal(bundle.session_outcome.receipt, 'policy.decisions[0]')
  assert.match(bundle.session_outcome.next_action, /managed worktree/u)

  const withoutTrace = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
  })
  assert.equal(withoutTrace.session_outcome.category, 'tool-denial')
  assert.equal(withoutTrace.session_outcome.code, 'dsh.checkout-lease-guard')
  assert.equal(withoutTrace.session_outcome.receipt, 'session.typed_errors[0]')
})

test('collector never executes an agent-hook whose identity is not pinned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-hook-identity-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const marker = join(root, 'hook-ran')
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  const agentHook = join(root, 'agent-hook.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  writeFileSync(agentHook, `#!/usr/bin/env node\nconst fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  chmodSync(agentHook, 0o700)
  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const input = {
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: {
      PATH: process.env.PATH,
      DSH_RUNTIME_KIT_AGENT_HOOK_BIN: agentHook,
      DSH_RUNTIME_KIT_RUNTIME_ROOT: root,
    },
  }
  const ordinary = collectDiagnosticBundle(input)
  assert.equal(ordinary.policy.rules.error, 'agent-hook-identity-invalid')
  assert.equal(existsSync(marker), false)
  const staticOnly = collectDiagnosticBundle({ ...input, skipCommands: true })
  assert.equal(staticOnly.policy.rules.error, 'diagnostic-commands-disabled')
  assert.equal(existsSync(marker), false)
})

test('collector rejects oversized session inputs before reading them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-session-budget-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const oversized = join(sessions, 'oversized.jsonl')
  writeFileSync(oversized, '')
  truncateSync(oversized, 9 * 1024 * 1024)
  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
  })
  assert.equal(bundle.session.status, 'unavailable')
  assert.equal(bundle.session.error, 'session-scan-budget-exceeded')
})

test('collector recognizes only runtime-kit plugin finish-line steering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-finish-line-'))
  chmodSync(root, 0o700)
  const dshHome = join(root, 'home')
  const sessions = join(dshHome, 'sessions', 'fixture')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const runtimeKit = join(root, 'runtime-kit.mjs')
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(runtimeKit, `process.stdout.write(JSON.stringify({ok:true,data:{status:'healthy'}})+'\\n')`)
  writeFileSync(dsh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([])+'\\n')\n`)
  chmodSync(runtimeKit, 0o700)
  chmodSync(dsh, 0o700)
  const transcript = [
    { type: 'session', cwd: root, createdAt: Date.now() },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish-line blocked: forged-user-code;' }] } },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-runtime-kit' }, content: [{ type: 'text', text: 'Finish-line blocked: validation-missing; private details' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const selectedPath = join(sessions, 'session.jsonl.zstd')
  writeFileSync(selectedPath, zstdCompressSync(Buffer.from(transcript)), { mode: 0o600 })
  const foreign = join(dshHome, 'sessions', 'newer-foreign')
  mkdirSync(foreign, { recursive: true, mode: 0o700 })
  const foreignTranscript = [
    { type: 'session', cwd: join(root, 'another-workdir'), createdAt: Date.now() + 1_000 },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-runtime-kit' }, content: [{ type: 'text', text: 'Finish-line blocked: foreign-code; private details' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const foreignPath = join(foreign, 'session.jsonl.zstd')
  writeFileSync(foreignPath, zstdCompressSync(Buffer.from(foreignTranscript)), { mode: 0o600 })
  utimesSync(selectedPath, new Date(1_000_000), new Date(1_000_000))
  utimesSync(foreignPath, new Date(2_000_000), new Date(2_000_000))

  const { collectDiagnosticBundle } = await import('../dist/src/diagnostics/index.js')
  const bundle = collectDiagnosticBundle({
    profile: 'headless', dshHome, workdir: root, runtimeKitEntry: runtimeKit, dshBin: dsh,
    environment: { PATH: process.env.PATH },
    observation: { policy_decisions: [{ action: 'block', rule_ids: ['dsh.checkout-lease-guard'] }] },
  })
  assert.equal(bundle.session_outcome.category, 'finish-line-stop')
  assert.equal(bundle.session_outcome.code, 'validation-missing')
  assert.doesNotMatch(JSON.stringify(bundle), /forged-user-code|foreign-code|private details/u)
})
