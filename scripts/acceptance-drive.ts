#!/usr/bin/env node

import { realpathSync } from 'node:fs'

import { main } from '../src/acceptance/drive.js'

export { main }

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = main()
}
