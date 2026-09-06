#!/usr/bin/env node

// Entry point for the repository-owned deploy dispatcher. `.agents/scripts/deploy.sh`
// execs this file; the contract is implemented in src/deploy/index.js.

import { main } from '../src/deploy/index.js'

process.exitCode = await main()
