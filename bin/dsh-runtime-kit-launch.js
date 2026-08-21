#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { readActivation, resolveActivationRoot } from '../src/activation/index.js'

function fail(message) {
  process.stderr.write(`dsh-runtime-kit-launch: ${message}\n`)
  process.exit(64)
}

const args = process.argv.slice(2)
if (args[0] !== '--runtime-root' || args[2] !== '--' || args.length < 4) {
  fail('usage: dsh-runtime-kit-launch --runtime-root <absolute-owner-only-directory> -- <command> [args...]')
}

const requestedRoot = args[1]
let runtimeRoot
try {
  runtimeRoot = resolveActivationRoot(requestedRoot)
} catch (error) {
  fail(error instanceof Error ? error.message : 'runtime root is invalid')
}

let activatedEnvironment
if (existsSync(join(runtimeRoot, 'activation.json'))) {
  try {
    activatedEnvironment = readActivation(runtimeRoot).environment
  } catch (error) {
    fail(error instanceof Error ? error.message : 'activation manifest is invalid')
  }
}
const environment = {
  ...process.env,
  DSH_RUNTIME_KIT_RUNTIME_ROOT: runtimeRoot,
  ...activatedEnvironment ?? {
    DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: join(runtimeRoot, 'agent-hook', 'config.toml'),
    DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: join(runtimeRoot, 'agent-hook', 'policy.toml'),
    DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: join(runtimeRoot, 'agent-hook', 'state'),
    DSH_RUNTIME_KIT_AGENT_DOCS_HOME: join(runtimeRoot, 'agent-docs'),
    DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: join(runtimeRoot, 'agent-docs-state'),
  },
}

function resolveCommand(command) {
  if (command.includes('/')) return command
  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`command is unavailable: ${command}`)
}

if (process.platform !== 'win32' && typeof process.execve === 'function') {
  try {
    const command = resolveCommand(args[3])
    process.execve(command, [args[3], ...args.slice(4)], environment)
  } catch (error) {
    process.stderr.write(`dsh-runtime-kit-launch: failed to start command: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(70)
  }
}

const result = spawnSync(args[3], args.slice(4), {
  env: environment,
  stdio: 'inherit',
  shell: false,
})
if (result.error !== undefined) {
  process.stderr.write(`dsh-runtime-kit-launch: failed to start command: ${result.error.message}\n`)
  process.exit(70)
}
if (result.signal !== null) {
  process.stderr.write(`dsh-runtime-kit-launch: command terminated by ${result.signal}\n`)
  process.exit(70)
}
process.exit(result.status ?? 70)
