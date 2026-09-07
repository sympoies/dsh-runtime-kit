#!/usr/bin/env node

import { main } from '../src/operations/index.js'
import { main as acceptanceDriveMain } from '../src/acceptance/drive.js'

const [command, ...args] = process.argv.slice(2)
process.exitCode = command === 'acceptance-drive'
  ? acceptanceDriveMain(args)
  : main()
