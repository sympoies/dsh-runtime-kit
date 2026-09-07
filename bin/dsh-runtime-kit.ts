#!/usr/bin/env node

import { main } from '../src/operations/index.js'
import { main as acceptanceDriveMain } from '../src/acceptance/drive.js'
import { main as diagnoseMain } from '../src/diagnostics/index.js'

const [command, ...args] = process.argv.slice(2)
process.exitCode = command === 'acceptance-drive'
  ? acceptanceDriveMain(args)
  : command === 'diagnose'
    ? diagnoseMain(args)
  : main()
