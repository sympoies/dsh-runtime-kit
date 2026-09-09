#!/usr/bin/env node

import { main } from '../src/acceptance/fixtures.js'

process.exitCode = main()
