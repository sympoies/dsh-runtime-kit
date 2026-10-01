#!/usr/bin/env node

import { packageAsset } from '../src/package-root.js'
import { execFile } from 'node:child_process'
import { appendFile, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Report how agent-runtime-kit moved since the commit this package's
 * alignment record pins. The record (compatibility/agent-runtime-alignment.json)
 * gives every watched skill, policy, home, and hook surface a disposition; a
 * change to a watched path after the pin means a disposition may be stale.
 * The check is informational: it never mutates either repository.
 */

export interface AlignmentEntry {
  source: string
  kind: 'skill' | 'policy' | 'home' | 'hook-manifest' | 'hooks'
  disposition: string
  issue?: string
  dsh_paths: string[]
  note?: string
}

export interface AlignmentRecord {
  schema_version: string
  source: { repository: string, commit: string }
  watched_paths: string[]
  entries: AlignmentEntry[]
}

export interface DriftReport {
  schema_version: 'dsh-runtime-kit.agent-runtime-drift.v1'
  pin: string
  ref: string
  ref_commit: string
  drift: boolean
  commits: Array<{ commit: string, subject: string }>
  changed_paths: Array<{ status: string, path: string, entry: string | null }>
  unrecorded: string[]
  removed: string[]
  record_mismatch_at_pin: string[]
}

const RECORD_SCHEMA = 'dsh-runtime-kit.agent-runtime-alignment.v1'
const COMMIT = /^[0-9a-f]{40}$/u

function git(root: string, arguments_: string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete environment[variable]
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', ['--no-replace-objects', '-C', root, ...arguments_], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error(`git ${arguments_[0]} failed in the agent-runtime-kit source: ${error.message}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

function validateRecord(record: AlignmentRecord): AlignmentRecord {
  if (record?.schema_version !== RECORD_SCHEMA
    || typeof record.source?.commit !== 'string'
    || !COMMIT.test(record.source.commit)
    || !Array.isArray(record.watched_paths)
    || record.watched_paths.length === 0
    || !Array.isArray(record.entries)) {
    throw new TypeError('agent-runtime alignment record is invalid')
  }
  return record
}

/** The watched source surfaces that exist at one revision, as record sources. */
async function sourcesAt(root: string, revision: string, watched: string[]): Promise<Set<string>> {
  const files = (await git(root, ['ls-tree', '-r', '--name-only', revision, '--', ...watched]))
    .split('\n')
    .filter(line => line !== '')
  const sources = new Set<string>()
  for (const path of files) {
    if (/^core\/skills\/.+\/SKILL\.md(\.tera)?$/u.test(path)) {
      sources.add(path.slice(0, path.lastIndexOf('/')))
    } else if (/^core\/policies\/[^/]+\.md$/u.test(path)) {
      sources.add(path)
    } else if (path.startsWith('core/hooks/')) {
      sources.add('core/hooks/')
    } else if (path === 'AGENT_HOME.md' || path === 'manifests/hook-rules.yaml') {
      sources.add(path)
    }
  }
  return sources
}

function owningEntry(entries: AlignmentEntry[], path: string): string | null {
  let best: string | null = null
  for (const entry of entries) {
    const directory = entry.kind === 'skill' ? `${entry.source}/` : entry.source
    const matches = entry.source === path || (directory.endsWith('/') && path.startsWith(directory))
    if (matches && (best === null || entry.source.length > best.length)) best = entry.source
  }
  return best
}

const sorted = (values: Iterable<string>) => [...values].sort()

export async function checkAgentRuntimeDrift(options: {
  sourceRoot: string
  ref?: string
  record: AlignmentRecord
}): Promise<DriftReport> {
  const record = validateRecord(options.record)
  const root = await realpath(resolve(options.sourceRoot))
  const ref = options.ref ?? 'HEAD'
  const pin = record.source.commit
  const watched = record.watched_paths
  await git(root, ['cat-file', '-e', `${pin}^{commit}`])
  const refCommit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()

  const recorded = new Set(record.entries.map(entry => entry.source))
  const atPin = await sourcesAt(root, pin, watched)
  const atRef = await sourcesAt(root, refCommit, watched)
  const recordMismatch = [
    ...sorted([...atPin].filter(source => !recorded.has(source))).map(source => `unrecorded ${source}`),
    ...sorted([...recorded].filter(source => !atPin.has(source))).map(source => `missing ${source}`),
  ]

  const commits = (await git(root, ['log', '--format=%H%x09%s', `${pin}..${refCommit}`, '--', ...watched]))
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const tab = line.indexOf('\t')
      return { commit: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
  const changedPaths = (await git(root, ['diff', '--name-status', '--no-renames', pin, refCommit, '--', ...watched]))
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [status, path] = line.split('\t')
      return { status, path, entry: owningEntry(record.entries, path) }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const unrecorded = sorted([...atRef].filter(source => !atPin.has(source)))
  const removed = sorted([...atPin].filter(source => !atRef.has(source)))

  return {
    schema_version: 'dsh-runtime-kit.agent-runtime-drift.v1',
    pin,
    ref,
    ref_commit: refCommit,
    drift: commits.length > 0 || changedPaths.length > 0 || unrecorded.length > 0 || removed.length > 0,
    commits,
    changed_paths: changedPaths,
    unrecorded,
    removed,
    record_mismatch_at_pin: recordMismatch,
  }
}

function renderText(report: DriftReport): string {
  const lines = [
    report.drift
      ? `agent-runtime-kit moved since ${report.pin.slice(0, 8)}: ${report.commits.length} commit(s), ${report.changed_paths.length} watched path(s).`
      : `agent-runtime-kit matches the recorded pin ${report.pin.slice(0, 8)} on every watched path.`,
  ]
  for (const commit of report.commits) lines.push(`commit ${commit.commit.slice(0, 8)} ${commit.subject}`)
  for (const change of report.changed_paths) {
    lines.push(`${change.status} ${change.path}${change.entry === null ? ' (unrecorded)' : ` -> ${change.entry}`}`)
  }
  for (const source of report.unrecorded) lines.push(`new source without a disposition: ${source}`)
  for (const source of report.removed) lines.push(`recorded source removed upstream: ${source}`)
  for (const mismatch of report.record_mismatch_at_pin) lines.push(`record defect at the pin: ${mismatch}`)
  return `${lines.join('\n')}\n`
}

async function emitGithub(report: DriftReport): Promise<void> {
  const escape = (value: string) => value.replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')
  if (report.drift) {
    process.stdout.write(`::warning title=agent-runtime-kit drift::${escape(
      `${report.changed_paths.length} watched path(s) changed in ${report.commits.length} commit(s) since ${report.pin.slice(0, 8)}; re-check their dispositions and re-pin.`,
    )}\n`)
  }
  for (const mismatch of report.record_mismatch_at_pin) {
    process.stdout.write(`::warning title=agent-runtime alignment record::${escape(mismatch)}\n`)
  }
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary !== undefined && summary !== '') {
    await appendFile(summary, `## agent-runtime-kit drift\n\n\`\`\`text\n${renderText(report)}\`\`\`\n`)
  }
  process.stdout.write(renderText(report))
}

function usage(stream: NodeJS.WritableStream): void {
  stream.write('check-agent-runtime-drift --source <agent-runtime-kit checkout> [--ref <rev>] [--record <path>] [--format json|text|github] [--fail-on-drift]\n')
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : await realpath(resolve(process.argv[1])).catch(() => undefined)
if (invokedPath === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  const options: Record<string, string | boolean> = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--fail-on-drift') options['fail-on-drift'] = true
    else if (['--source', '--ref', '--record', '--format'].includes(argument)) {
      const value = arguments_[index + 1]
      if (value === undefined) {
        usage(process.stderr)
        process.exit(64)
      }
      options[argument.slice(2)] = value
      index += 1
    } else {
      usage(process.stderr)
      process.exit(64)
    }
  }
  if (options.help === true) {
    usage(process.stdout)
  } else if (typeof options.source !== 'string') {
    usage(process.stderr)
    process.exitCode = 64
  } else {
    const format = typeof options.format === 'string' ? options.format : 'json'
    if (!['json', 'text', 'github'].includes(format)) {
      usage(process.stderr)
      process.exit(64)
    }
    const recordPath = typeof options.record === 'string'
      ? resolve(options.record)
      : packageAsset('compatibility/agent-runtime-alignment.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    const report = await checkAgentRuntimeDrift({
      sourceRoot: options.source,
      ref: typeof options.ref === 'string' ? options.ref : undefined,
      record,
    })
    if (format === 'json') process.stdout.write(`${JSON.stringify(report)}\n`)
    else if (format === 'text') process.stdout.write(renderText(report))
    else await emitGithub(report)
    if (options['fail-on-drift'] === true && report.drift) process.exitCode = 1
  }
}
