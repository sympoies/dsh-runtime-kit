#!/usr/bin/env node

import { digestDshBuildClosure } from '../src/acceptance/dsh-build.js'

if (process.argv.length !== 3) {
  process.stderr.write('usage: digest-dsh-build-closure <absolute-dsh-source-root>\n')
  process.exitCode = 64
} else {
  try {
    const receipt = await digestDshBuildClosure(process.argv[2])
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 65
  }
}
