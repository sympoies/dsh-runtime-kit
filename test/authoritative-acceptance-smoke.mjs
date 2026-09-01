import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createScenarioFailureDiagnosticTracker,
  parseScenarioCanaryReceipt,
  recordScenarioCanaryFailure,
  recordScenarioOperationResult,
  scenarioOperationFailureMessage,
  scenarioOperationSucceeded,
  waitForScenarioOperationMarker,
} from '../src/acceptance/contract.js'
import {
  NILS_COMPATIBILITY_CANDIDATE_ENV,
  nilsCompatibilityCandidateEnvironment,
  sanitizeAcceptanceScenarioEnvironment,
} from '../src/acceptance/scenario-environment.js'
import {
  SCENARIO_CANARY_DEADLINE_ENV,
  SCENARIO_CANARY_EXECUTION_TIMEOUT_MS,
  SCENARIO_CANARY_PROCESS_TIMEOUT_MS,
} from './fixtures/authoritative-acceptance-canary/receipt-output.js'

const failureDiagnostic = createScenarioFailureDiagnosticTracker('packed-runtime')

function enterStep(step) {
  failureDiagnostic.enterStep(step)
}

function emitFailureDiagnostic() {
  const diagnostic = failureDiagnostic.take()
  if (diagnostic !== undefined) process.stderr.write(JSON.stringify(diagnostic) + '\n')
}

process.once('uncaughtExceptionMonitor', emitFailureDiagnostic)

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = requiredAbsolute('DSH_SOURCE_ROOT')
const candidatePackage = requiredAbsolute('DSH_ACCEPTANCE_CANDIDATE_PACKAGE_TARBALL')
const baselinePackage = requiredAbsolute('DSH_ACCEPTANCE_BASELINE_PACKAGE_TARBALL')
const candidateBinDir = dirname(requiredAbsolute('AGENT_HOOK_BIN'))
const baselineBinDir = requiredAbsolute('DSH_ACCEPTANCE_BASELINE_NILS_BIN_DIR')
const pnpmBin = requiredAbsolute('PNPM_BIN')
const npmBin = requiredAbsolute('NPM_BIN')
const candidatePackageSha = requiredSha('DSH_ACCEPTANCE_CANDIDATE_PACKAGE_SHA256')
const baselinePackageSha = requiredSha('DSH_ACCEPTANCE_BASELINE_PACKAGE_SHA256')
const candidateSourceCommit = requiredCommit('DSH_ACCEPTANCE_CANDIDATE_NILS_SOURCE_COMMIT')
const baselineSourceCommit = requiredCommit('DSH_ACCEPTANCE_BASELINE_NILS_SOURCE_COMMIT')
const dshVersion = requiredText('DSH_ACCEPTANCE_DSH_VERSION')
const dshRevision = requiredCommit('DSH_ACCEPTANCE_DSH_REVISION')
const candidateArtifacts = JSON.parse(requiredText('DSH_ACCEPTANCE_CANDIDATE_NILS_ARTIFACTS'))
const baselineArtifacts = JSON.parse(requiredText('DSH_ACCEPTANCE_BASELINE_NILS_ARTIFACTS'))
const unpatchedOnly = process.env.DSH_ACCEPTANCE_UNPATCHED_ONLY === '1'
const marker = 'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY='
let canaryPackage

function requiredText(name) {
  const value = process.env[name]
  assert.equal(typeof value, 'string', `${name} must be set`)
  assert.notEqual(value.length, 0, `${name} must not be empty`)
  return value
}

function requiredAbsolute(name) {
  const value = resolve(requiredText(name))
  assert.equal(isAbsolute(value), true, `${name} must be absolute`)
  return value
}

function requiredSha(name) {
  const value = requiredText(name)
  assert.match(value, /^[0-9a-f]{64}$/u, `${name} must be a SHA-256`)
  return value
}

function requiredCommit(name) {
  const value = requiredText(name)
  assert.match(value, /^[0-9a-f]{40,64}$/u, `${name} must be a commit identity`)
  return value
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function processIdentity(label) {
  return 'sha256:' + createHash('sha256')
    .update(label + '\0' + randomUUID())
    .digest('hex')
}

function run(command, args, options = {}) {
  const { scenarioCanaryExpectation, ...spawnOptions } = options
  const result = spawnSync(command, args, {
    cwd: dshRoot,
    env: baseEnvironment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    ...spawnOptions,
  })
  recordScenarioOperationResult(failureDiagnostic, result)
  if (!scenarioOperationSucceeded(result) && scenarioCanaryExpectation !== undefined) {
    recordScenarioCanaryFailure(failureDiagnostic, result, scenarioCanaryExpectation)
  }
  assert.equal(
    scenarioOperationSucceeded(result),
    true,
    scenarioOperationFailureMessage(basename(command)),
  )
  failureDiagnostic.recordOperationExitStatus(0)
  return result
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-authoritative-acceptance-'))
const home = join(temporaryRoot, 'home')
const dshHome = join(temporaryRoot, 'dsh-home')
const configHome = join(temporaryRoot, 'config')
const stateHome = join(temporaryRoot, 'state')
const hookRoot = join(temporaryRoot, 'agent-hook')
const hookPolicy = join(hookRoot, 'policy.toml')
const hookConfig = join(hookRoot, 'config.toml')
const hookState = join(hookRoot, 'state')
const docsState = join(temporaryRoot, 'agent-docs-state')
const workspace = join(temporaryRoot, 'workspace')
const cancellationMarker = join(workspace, '.git', 'dsh-contained-body-started')
const validationMarker = join(workspace, '.git', 'dsh-validation-body-executed')
const validationToken = randomUUID()
const cancellationPid = join(workspace, '.git', 'dsh-contained-body.pid')
const cancellationHeartbeat = join(workspace, '.git', 'dsh-contained-body.heartbeat')
const crashMarker = join(workspace, '.git', 'dsh-crash-body-started')
const providerProbePath = join(hookRoot, 'provider-mismatch-probe.json')
const mismatchCompanion = join(temporaryRoot, 'unauthenticated-agent-docs')
const validationCommand = `node -e ${JSON.stringify(
  `require('node:fs').appendFileSync(${JSON.stringify(validationMarker)},${JSON.stringify(`${validationToken}\n`)},{mode:0o600})`,
)}`
const cancellationCommand = `node -e ${JSON.stringify(
  `const fs=require('node:fs');let beat=0;fs.writeFileSync(${JSON.stringify(cancellationPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(cancellationHeartbeat)},String(beat));fs.writeFileSync(${JSON.stringify(cancellationMarker)},'started\\n');setInterval(()=>fs.writeFileSync(${JSON.stringify(cancellationHeartbeat)},String(++beat)),25)`,
)}`
const candidateFeature = process.env[NILS_COMPATIBILITY_CANDIDATE_ENV]
const baseEnvironment = sanitizeAcceptanceScenarioEnvironment(process.env)
for (const name of Object.keys(baseEnvironment)) {
  if (name.startsWith('AGENT_SESSION_')
    || /(?:^|_)(?:API_KEY|CREDENTIAL|CREDENTIALS|PASSWORD|SECRET|TOKEN)$/iu.test(name)) {
    delete baseEnvironment[name]
  }
}
delete baseEnvironment.DSH_RUNTIME_KIT_MAIN_AGENT_BIN
delete baseEnvironment.DSH_RUNTIME_KIT_AGENT_SESSION_BIN
Object.assign(baseEnvironment, {
  HOME: home,
  DSH_HOME: dshHome,
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'workspace-write',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: hookConfig,
  DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: hookPolicy,
  DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: hookState,
  DSH_RUNTIME_KIT_AGENT_DOCS_HOME: join(projectRoot, 'agent-docs'),
  DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: docsState,
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: join(temporaryRoot, 'empty-private-skills'),
  DSH_ACCEPTANCE_WORKSPACE: workspace,
  DSH_ACCEPTANCE_WORKSPACE_SHA256: 'sha256:' + createHash('sha256').update(workspace).digest('hex'),
  DSH_ACCEPTANCE_VALIDATION_COMMAND: validationCommand,
  DSH_ACCEPTANCE_VALIDATION_MARKER: validationMarker,
  DSH_ACCEPTANCE_VALIDATION_TOKEN: validationToken,
  DSH_ACCEPTANCE_CANCELLATION_COMMAND: cancellationCommand,
  DSH_ACCEPTANCE_CANCELLATION_MARKER: cancellationMarker,
  DSH_ACCEPTANCE_CANCELLATION_PID: cancellationPid,
  DSH_ACCEPTANCE_CANCELLATION_HEARTBEAT: cancellationHeartbeat,
  DSH_ACCEPTANCE_CRASH_MARKER: crashMarker,
  DSH_ACCEPTANCE_PROVIDER_PROBE_PATH: providerProbePath,
  PNPM_BIN: pnpmBin,
})

function nilsEnvironment(kind) {
  const binDir = kind === 'candidate' ? candidateBinDir : baselineBinDir
  return {
    DSH_RUNTIME_KIT_AGENT_HOOK_BIN: join(binDir, 'agent-hook'),
    DSH_RUNTIME_KIT_AGENT_DOCS_BIN: join(binDir, 'agent-docs'),
    ...kind === 'candidate' ? {
      DSH_RUNTIME_KIT_MAIN_AGENT_BIN: join(binDir, 'main-agent'),
      DSH_RUNTIME_KIT_AGENT_SESSION_BIN: join(binDir, 'agent-session'),
    } : {},
    DSH_RUNTIME_KIT_SEMANTIC_COMMIT_BIN: join(binDir, 'semantic-commit'),
    PATH: binDir + ':' + dirname(pnpmBin) + ':' + dirname(process.execPath) + ':/usr/bin:/bin',
    ...nilsCompatibilityCandidateEnvironment(candidateFeature, kind === 'candidate'),
  }
}

function installProfile(profile, runtimePackage, includeCanary = true) {
  run(pnpmBin, [
    'dsh', 'plugin', '--profile', profile, 'add', '--offline', '--save-exact', runtimePackage,
  ])
  if (includeCanary) {
    run(pnpmBin, [
      'dsh', 'plugin', '--profile', profile, 'add', '--offline', '--save-exact', canaryPackage,
    ])
  }
}

function installUnpatchedProfile(profile) {
  run(pnpmBin, [
    'dsh', 'plugin', '--profile', profile, 'add', '--offline', '--save-exact', canaryPackage,
  ])
}

function installMismatchProfile(profile, runtimePackage) {
  run(pnpmBin, [
    'dsh', 'plugin', '--profile', profile, 'add', '--offline', '--save-exact', canaryPackage,
  ])
  run(pnpmBin, [
    'dsh', 'plugin', '--profile', profile, 'add', '--offline', '--save-exact', runtimePackage,
  ])
}

function runPhase(profile, selectedPhase, selectedSession, kind = 'candidate') {
  const processInstance = processIdentity(selectedPhase)
  const executionDeadline = Date.now() + SCENARIO_CANARY_EXECUTION_TIMEOUT_MS
  const result = run(pnpmBin, ['dsh', '--profile', profile], {
    // The canary deadline shares this process launch origin. Preserve a later
    // supervisor boundary for failure/receipt flush, disposal, and host exit.
    timeout: SCENARIO_CANARY_PROCESS_TIMEOUT_MS,
    env: {
      ...baseEnvironment,
      ...nilsEnvironment(kind),
      DSH_ACCEPTANCE_PHASE: selectedPhase,
      DSH_ACCEPTANCE_SESSION_ID: selectedSession,
      DSH_ACCEPTANCE_PROCESS_INSTANCE_SHA256: processInstance,
      [SCENARIO_CANARY_DEADLINE_ENV]: String(executionDeadline),
    },
    scenarioCanaryExpectation: { phase: selectedPhase, processInstance },
  })
  const receipt = parseScenarioCanaryReceipt({
    output: result.stdout,
    phase: selectedPhase,
    processInstance,
    enterStep,
  })
  return receipt
}

async function crashPhase(profile, selectedSession) {
  rmSync(crashMarker, { force: true })
  const processInstance = processIdentity('crash-start')
  const executionDeadline = Date.now() + SCENARIO_CANARY_EXECUTION_TIMEOUT_MS
  const child = spawn(pnpmBin, ['dsh', '--profile', profile], {
    cwd: dshRoot,
    env: {
      ...baseEnvironment,
      ...nilsEnvironment('candidate'),
      DSH_ACCEPTANCE_PHASE: 'crash-start',
      DSH_ACCEPTANCE_SESSION_ID: selectedSession,
      DSH_ACCEPTANCE_PROCESS_INSTANCE_SHA256: processInstance,
      [SCENARIO_CANARY_DEADLINE_ENV]: String(executionDeadline),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const markerWait = waitForScenarioOperationMarker({
    tracker: failureDiagnostic,
    child,
    markerExists: () => existsSync(crashMarker),
    timeoutMs: 20_000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const markerReached = await markerWait
  assert.equal(
    markerReached,
    true,
    `crash mutation did not reach a terminal fail-closed state:\n${stdout}\n${stderr}`,
  )
  process.kill(-child.pid, 'SIGKILL')
  await new Promise(resolve => child.once('close', resolve))
  assert.equal(stdout.includes(marker), false, 'crashed process must not emit a success receipt')
  const workspaceLeaseRecoveryDelayMs = 31_000
  await new Promise(resolve => setTimeout(resolve, workspaceLeaseRecoveryDelayMs))
  return {
    process_instance_sha256: processInstance,
    workspace_lease_recovery_delay_ms: workspaceLeaseRecoveryDelayMs,
  }
}

function exactResults(receipt, names) {
  return names.map(name => {
    const selected = receipt.results.find(row => row.name === name)
    assert.ok(selected, `${receipt.phase} omitted ${name}: ${JSON.stringify(receipt)}`)
    return selected.is_error ? 'denied' : 'succeeded'
  })
}

function exactCallResults(receipt, callIds) {
  return callIds.map(callId => {
    const matches = receipt.results.filter(row => row.call_id === callId)
    assert.equal(matches.length, 1, `${receipt.phase} must emit one result for ${callId}`)
    return { call_id: callId, outcome: matches[0].is_error ? 'denied' : 'succeeded' }
  })
}

function zeroResources(receipt) {
  assert.deepEqual(receipt.resources_after, {
    acceptance_operations: 0,
    finish_line_requests: 0,
    finish_line_reservations: 0,
    pending_correlations: 0,
  })
  return receipt.resources_after
}

function common(receipt, id) {
  return {
    id,
    process_instance_sha256: receipt.process_instance_sha256,
    workspace_sha256: receipt.workspace_sha256,
    resources_after: zeroResources(receipt),
  }
}

enterStep('artifact-authentication')
assert.equal(digestFile(candidatePackage), candidatePackageSha)
assert.equal(digestFile(baselinePackage), baselinePackageSha)
for (const [name, sha256] of Object.entries(candidateArtifacts)) {
  assert.equal(digestFile(join(candidateBinDir, name)), sha256, `candidate ${name} changed`)
}
for (const [name, sha256] of Object.entries(baselineArtifacts)) {
  assert.equal(digestFile(join(baselineBinDir, name)), sha256, `baseline ${name} changed`)
}

try {
  enterStep('profile-setup')
  for (const directory of [
    home, dshHome, configHome, stateHome, hookRoot, hookState, docsState, workspace,
    join(temporaryRoot, 'empty-private-skills'),
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 })

  run('/usr/bin/git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace })
  writeFileSync(join(workspace, 'tracked.txt'), 'baseline\n', { mode: 0o600 })
  writeFileSync(join(workspace, 'AGENT_DOCS.toml'), `[[validation]]
context = "project-dev"
product = "dsh"
commands = [${JSON.stringify(validationCommand)}, ${JSON.stringify(cancellationCommand)}]
description = "authoritative acceptance canary"
`, { mode: 0o600 })
  run('/usr/bin/git', ['add', 'tracked.txt', 'AGENT_DOCS.toml'], { cwd: workspace })
  run('/usr/bin/git', [
    '-c', 'user.name=DSH Acceptance',
    '-c', 'user.email=dsh-acceptance@example.invalid',
    'commit', '--quiet', '-m', 'test: initialize authoritative acceptance fixture',
  ], { cwd: workspace })
  const policy = readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')
  const policyDigest = 'sha256:' + createHash('sha256').update(policy).digest('hex')
  writeFileSync(hookPolicy, policy, { mode: 0o600 })
  writeFileSync(hookConfig, `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(hookPolicy)}
digest = ${JSON.stringify(policyDigest)}
`, { mode: 0o600 })

  enterStep('canary-package')
  const packed = run(npmBin, [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot,
  ], {
    cwd: join(projectRoot, 'test', 'fixtures', 'authoritative-acceptance-canary'),
    env: { ...baseEnvironment, NPM_CONFIG_OFFLINE: 'true' },
  })
  canaryPackage = join(temporaryRoot, JSON.parse(packed.stdout)[0].filename)
  chmodSync(canaryPackage, 0o400)

  if (unpatchedOnly) {
    enterStep('unpatched-install')
    const profile = 'authoritative-unpatched'
    installUnpatchedProfile(profile)
    enterStep('unpatched-smoke')
    const receipt = runPhase(profile, 'unpatched-smoke', 'unpatched-tools-smoke')
    assert.equal(receipt.acceptance_mode, 'absent')
    assert.deepEqual(exactResults(receipt, ['canary_host_validator']), ['succeeded'])
    process.stdout.write(JSON.stringify({
      schema_version: 'dsh-runtime-kit.authoritative-unpatched-smoke.v1',
      ok: true,
      process_instance_sha256: receipt.process_instance_sha256,
      tool_outcome: 'succeeded',
      acceptance_mode: 'absent',
    }) + '\n')
  } else {
    const candidateProfile = 'authoritative-candidate'
    enterStep('candidate-install')
    installProfile(candidateProfile, candidatePackage)
    enterStep('candidate-positive')
    const positive = runPhase(candidateProfile, 'positive', 'acceptance-positive')
    enterStep('candidate-positive-results')
    const positiveToolOutcomes = exactResults(positive, ['bash', 'canary_host_validator'])
    enterStep('downstream-denial')
    const downstream = runPhase(candidateProfile, 'downstream-denial', 'acceptance-downstream')
    enterStep('concurrent-mutation')
    const concurrent = runPhase(candidateProfile, 'concurrent-mutation', 'acceptance-concurrent')
    const cancellationSession = 'acceptance-cancellation'
    enterStep('active-cancellation')
    const cancellationReceipt = runPhase(
      candidateProfile,
      'active-cancellation',
      cancellationSession,
    )
    enterStep('cancellation-recovery')
    const cancellationRecovery = runPhase(
      candidateProfile,
      'cancellation-recover',
      'acceptance-cancellation-recovery',
    )
    enterStep('agent-disposal')
    const disposal = runPhase(candidateProfile, 'agent-disposal', 'acceptance-disposal')

    const restartSession = 'acceptance-restart'
    enterStep('restart-seed')
    const restartSeed = runPhase(candidateProfile, 'restart-seed', restartSession)
    enterStep('restart-check')
    const restart = runPhase(candidateProfile, 'restart-check', restartSession)

    const crashSession = 'acceptance-crash'
    enterStep('crash-start')
    const preCrash = await crashPhase(candidateProfile, crashSession)
    enterStep('crash-recovery')
    const crashRecovery = runPhase(candidateProfile, 'crash-recover', crashSession)

    const mismatchProfile = 'authoritative-mismatch'
    enterStep('companion-identity-mismatch-install')
    installMismatchProfile(mismatchProfile, candidatePackage)
    rmSync(providerProbePath, { force: true })
    writeFileSync(mismatchCompanion, '#!/bin/sh\nexit 99\n', { mode: 0o500 })
    const mismatchProcess = processIdentity('candidate-old-provider-mismatch')
    enterStep('companion-identity-mismatch')
    const mismatch = spawnSync(pnpmBin, ['dsh', '--profile', mismatchProfile], {
      cwd: dshRoot,
      env: {
        ...baseEnvironment,
        ...nilsEnvironment('candidate'),
        DSH_RUNTIME_KIT_AGENT_DOCS_BIN: mismatchCompanion,
        DSH_ACCEPTANCE_PHASE: 'provider-mismatch-probe',
        DSH_ACCEPTANCE_SESSION_ID: 'acceptance-mismatch',
        DSH_ACCEPTANCE_PROCESS_INSTANCE_SHA256: mismatchProcess,
      },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    recordScenarioOperationResult(failureDiagnostic, mismatch)
    const mismatchOutput = `${mismatch.stdout}\n${mismatch.stderr}`
    assert.notEqual(mismatch.status, 0)
    failureDiagnostic.recordOperationExitStatus(0)
    assert.match(mismatchOutput, /DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID/u)
    assert.equal(mismatchOutput.includes(marker), false)
    assert.equal(existsSync(providerProbePath), true, 'provider mismatch probe did not load')
    const mismatchProbe = JSON.parse(readFileSync(providerProbePath, 'utf8'))
    assert.deepEqual(mismatchProbe, {
      schema_version: 'dsh-runtime-kit.provider-mismatch-probe.v1',
      loaded: true,
      model_calls: 0,
      session_starts: 0,
    })
    const upgradeProfile = 'authoritative-upgrade'
    enterStep('baseline-install')
    installProfile(upgradeProfile, baselinePackage)
    enterStep('baseline-seed')
    const baselineSeed = runPhase(upgradeProfile, 'baseline-seed', 'acceptance-upgrade', 'baseline')
    assert.equal(baselineSeed.acceptance_mode, 'absent')
    assert.equal(baselineSeed.mutation_executions, 1)
    assert.equal(baselineSeed.validation_executions, 0)
    assert.ok(baselineSeed.turn_stops >= 1)
    rmSync(join(workspace, '.authoritative-acceptance-mutation'), { force: true })
    enterStep('baseline-seed-validation')
    const baselineSeedValidation = runPhase(
      upgradeProfile,
      'baseline-seed-validation',
      'acceptance-upgrade-validation',
      'baseline',
    )
    assert.equal(baselineSeedValidation.acceptance_mode, 'absent')
    assert.equal(baselineSeedValidation.mutation_executions, 0)
    assert.equal(baselineSeedValidation.validation_executions, 1)
    assert.ok(baselineSeedValidation.turn_stops >= 1)
    const cleanAfterSeed = run('git', ['status', '--porcelain'], { cwd: workspace })
    assert.equal(cleanAfterSeed.stdout, '')
    enterStep('candidate-upgrade-install')
    installProfile(upgradeProfile, candidatePackage, false)
    enterStep('candidate-upgrade')
    const candidateUpgrade = runPhase(
      upgradeProfile,
      'candidate-upgrade',
      'acceptance-upgrade',
      'candidate',
    )
    enterStep('baseline-rollback-install')
    installProfile(upgradeProfile, baselinePackage, false)
    enterStep('baseline-rollback')
    const baselineRollback = runPhase(
      upgradeProfile,
      'baseline-rollback',
      'acceptance-upgrade',
      'baseline',
    )
    assert.equal(baselineRollback.acceptance_mode, 'absent')
    assert.equal(baselineRollback.mutation_executions, 1)
    assert.equal(baselineRollback.validation_executions, 0)
    assert.ok(baselineRollback.turn_stops >= 1)
    rmSync(join(workspace, '.authoritative-acceptance-mutation'), { force: true })
    enterStep('baseline-rollback-validation')
    const baselineRollbackValidation = runPhase(
      upgradeProfile,
      'baseline-rollback-validation',
      'acceptance-upgrade-rollback-validation',
      'baseline',
    )
    assert.equal(baselineRollbackValidation.acceptance_mode, 'absent')
    assert.equal(baselineRollbackValidation.mutation_executions, 0)
    assert.equal(baselineRollbackValidation.validation_executions, 1)
    assert.ok(baselineRollbackValidation.turn_stops >= 1)
    const cleanAfterRollback = run('git', ['status', '--porcelain'], { cwd: workspace })
    assert.equal(cleanAfterRollback.stdout, '')

    enterStep('matrix-assertions')
    assert.equal(positive.body_executions, 2)
    assert.equal(downstream.body_executions, 0)

    const matrix = {
      schema_version: 'dsh-runtime-kit.authoritative-acceptance-matrix.v1',
      dsh: { version: dshVersion, revision: dshRevision },
      candidate: {
        runtime_package_sha256: candidatePackageSha,
        nils_source_commit: candidateSourceCommit,
        nils_artifacts: candidateArtifacts,
      },
      baseline: {
        runtime_package_sha256: baselinePackageSha,
        nils_source_commit: baselineSourceCommit,
        nils_artifacts: baselineArtifacts,
      },
      legs: [
        {
          ...common(positive, 'happy-completion'),
          goal: positive.goal,
          denial: positive.denial,
          tool_outcomes: positiveToolOutcomes,
          body_executions: positive.body_executions,
          turn_stops: positive.turn_stops,
          goal_round_followups: positive.goal_round_followups,
          verdict: positive.final_verdict,
          completion_settlement: positive.completion_settlement,
        },
        {
          ...common(downstream, 'post-admission-denial'),
          listener_entries: downstream.listener_entries,
          body_executions: downstream.body_executions,
          tool_outcome: exactResults(downstream, ['canary_host_validator'])[0],
          execution_order: downstream.sequence.slice(0, 2),
          verdict: downstream.turn_verdicts[0],
          resumed_verdict: downstream.turn_verdicts[0],
          recovery_verdict: downstream.final_verdict,
        },
        {
          ...common(concurrent, 'concurrent-mutation-denial'),
          tool_results: exactCallResults(concurrent, [
            'authoritative-acceptance-first-mutation',
            'authoritative-acceptance-second-mutation',
          ]),
          body_executions: concurrent.mutation_executions,
          max_concurrent_bodies: concurrent.max_concurrent_bodies,
          execution_order: concurrent.sequence,
          verdict: concurrent.final_verdict,
        },
        {
          ...common(cancellationReceipt, 'active-contained-cancellation'),
          recovery_process_instance_sha256: cancellationRecovery.process_instance_sha256,
          body_entries: cancellationReceipt.cancellation_body_entries,
          abort_observations: cancellationReceipt.abort_observations,
          call_id: cancellationReceipt.cancellation_call_id,
          tool_result: cancellationReceipt.cancellation_result,
          child_pid_observed: cancellationReceipt.cancellation_child_pid_observed,
          child_process_dead: cancellationReceipt.cancellation_child_process_dead,
          heartbeat_stopped: cancellationReceipt.cancellation_heartbeat_stopped,
          execution_order: cancellationReceipt.sequence,
          late_successes: cancellationReceipt.late_successes,
          turn_stops: cancellationReceipt.turn_stops,
          verdict: cancellationReceipt.first_verdict,
          recovery_verdict: cancellationRecovery.final_verdict,
        },
        {
          ...common(disposal, 'agent-disposal'),
          listener_entries: disposal.listener_entries,
          body_executions: disposal.body_executions,
          disposal: 'fulfilled',
          resumed_verdict: disposal.resumed_verdict,
        },
        {
          ...common(restart, 'graceful-restart'),
          previous_process_instance_sha256: restartSeed.process_instance_sha256,
          pre_restart_verdict: restartSeed.final_verdict,
          post_restart_verdict: restart.first_verdict,
          post_restart_validation_executions: restart.validation_executions,
        },
        {
          ...common(crashRecovery, 'crash-recovery'),
          previous_process_instance_sha256: preCrash.process_instance_sha256,
          crashed_session_sha256: crashRecovery.session_sha256,
          recovery_session_sha256: crashRecovery.recovery_session_sha256,
          crash_signal: 'SIGKILL',
          workspace_lease_recovery_delay_ms: preCrash.workspace_lease_recovery_delay_ms,
          mutation_terminal_before_crash: true,
          pre_crash_verdict: { action: 'block', aggregate: 'missing' },
          post_crash_verdict: crashRecovery.turn_verdicts[0],
          recovery_verdict: crashRecovery.final_verdict,
        },
        {
          id: 'candidate-old-provider-mismatch',
          process_instance_sha256: mismatchProcess,
          workspace_sha256: positive.workspace_sha256,
          resources_after: zeroResources(positive),
          boot_outcome: 'blocked-before-model',
          denial_code: 'DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID',
          probe_loaded: mismatchProbe.loaded,
          model_calls: mismatchProbe.model_calls,
          session_starts: mismatchProbe.session_starts,
        },
        {
          ...common(candidateUpgrade, 'candidate-upgrade'),
          installed_runtime_package_sha256: candidatePackageSha,
          nils_source_commit: candidateSourceCommit,
          baseline_seed_runtime_package_sha256: baselinePackageSha,
          baseline_seed_acceptance_mode: baselineSeed.acceptance_mode,
          baseline_seed_mutation_executions: baselineSeed.mutation_executions,
          baseline_seed_process_instance_sha256: baselineSeed.process_instance_sha256,
          baseline_seed_validation_process_instance_sha256:
            baselineSeedValidation.process_instance_sha256,
          baseline_seed_session_sha256: baselineSeed.session_sha256,
          baseline_seed_validation_session_sha256:
            baselineSeedValidation.session_sha256,
          baseline_seed_legacy_stop: baselineSeed.turn_stops >= 1 ? 'blocked' : 'not-observed',
          baseline_seed_steering_observed: baselineSeed.legacy_steering_observed,
          baseline_seed_exact_validation_executions:
            baselineSeedValidation.validation_executions,
          baseline_seed_checkout_clean: cleanAfterSeed.stdout === '',
          first_verdict: candidateUpgrade.first_verdict,
          goal_unchanged: JSON.stringify(candidateUpgrade.goal.before)
            === JSON.stringify(candidateUpgrade.goal.after_denial),
          goal_round_followups: candidateUpgrade.goal_round_followups,
          validation_executions: candidateUpgrade.validation_executions,
          tool_outcome: 'succeeded',
          verdict: candidateUpgrade.final_verdict,
        },
        {
          ...common(baselineRollback, 'baseline-rollback'),
          rollback_session_sha256: baselineRollback.session_sha256,
          validation_process_instance_sha256:
            baselineRollbackValidation.process_instance_sha256,
          validation_session_sha256: baselineRollbackValidation.session_sha256,
          installed_runtime_package_sha256: baselinePackageSha,
          nils_source_commit: baselineSourceCommit,
          tool_outcome: 'succeeded',
          acceptance_mode: baselineRollback.acceptance_mode,
          legacy_stop: baselineRollback.turn_stops >= 1 ? 'blocked' : 'not-observed',
          legacy_steering_observed: baselineRollback.legacy_steering_observed,
          mutation_body_executions: baselineRollback.mutation_executions,
          exact_validation_executions: baselineRollbackValidation.validation_executions,
          rollback_checkout_clean: cleanAfterRollback.stdout === '',
        },
      ],
    }
    enterStep('matrix-serialization')
    assert.equal(baselineSeed.acceptance_mode, 'absent')
    process.stdout.write(JSON.stringify({
      schema_version: 'dsh-runtime-kit.authoritative-acceptance-smoke.v1',
      ok: true,
      matrix,
    }) + '\n')
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
