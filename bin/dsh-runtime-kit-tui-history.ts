#!/usr/bin/env node

import { homedir } from 'node:os'

import { prepareDshTuiHistory } from '../src/compat/dsh-tui-history.js'

try {
  const result = prepareDshTuiHistory(homedir())
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`dsh-runtime-kit-tui-history: ${(error as Error).message}\n`)
  process.exitCode = 1
}
