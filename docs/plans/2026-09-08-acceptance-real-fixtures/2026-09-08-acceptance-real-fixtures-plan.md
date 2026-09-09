# Plan: Make real-provider acceptance fixtures executable

## Overview

Ship a bounded fixture manifest and provider executable for all twelve `#D`
capability families, integrate provider discovery with `acceptance-drive`, and
prove the unchanged 66-case matrix through a fresh real external harness.

## Read First

- Primary source: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope: fixture contract, packaged provider, runbook/driver integration,
  focused and full validation, real-provider acceptance, reviewed PR delivery,
  merge, strict issue closeout, and parent record updates.
- Out of scope: weakening acceptance gates or changing DSH/nils capability
  behavior to make a row pass.

## Assumptions

1. DSH 0.1.2-rc.1 and nils-cli 1.28.3 remain the accepted compatibility
   identities for the run.
2. Each capability family uses a distinct profile and private DSH home.
3. Any actual runtime defect exposed after correct fixture preparation is
   separately tracked and does not become an implicit fixture workaround.

## Sprint 1: Fixture contract and executable provider

**Goal**: Turn the prose-only family state into a packaged, bounded, reversible
provider contract.

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Demo/Validation**:

- Command(s): focused Node tests for manifest coverage, provider validation,
  path confinement, transition receipts, recovery, and cleanup.
- Verify: every `#D` row has one executable recipe and all mutations remain
  within authenticated scenario roots.

### Task 1.1: Freeze the fixture manifest contract

- **Location**:
  - `compatibility/acceptance-fixtures.json`
  - `src/acceptance/fixtures.ts`
  - `test/acceptance-fixtures.test.ts`
- **Description**: Capture the missing-provider regression, define the strict
  v1 manifest schema and complete 33-row ownership, and reject unsafe or
  incomplete recipe data before execution.
- **Dependencies**:
  - none
- **Complexity**: 7
- **Acceptance criteria**:
  - All 33 scenario IDs and twelve family owners are covered exactly once.
  - Unknown keys, family drift, unsafe relative paths, missing inverse steps,
    and unsupported operation kinds fail closed.
- **Validation**:
  - `node --test test/acceptance-fixtures.test.ts`

### Task 1.2: Implement the packaged provider transitions

- **Location**:
  - `bin/dsh-runtime-kit-acceptance-fixture.ts`
  - `src/acceptance/fixtures.ts`
  - `package.json`
  - `test/acceptance-fixtures.test.ts`
- **Description**: Execute prepare, induce, recover, and cleanup with exact
  scenario binding, bounded private state, digest-bound receipts, idempotent
  cleanup, and strict containment.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 9
- **Acceptance criteria**:
  - Every transition emits the existing provider result schema and portable
    evidence.
  - Recovery restores exact prior bytes and modes; cleanup cannot delete or
    overwrite caller-owned unrelated state.
  - The provider is shipped as an executable package bin.
- **Validation**:
  - `node --test test/acceptance-fixtures.test.ts test/package-bin-identity.test.ts`

### Task 1.3: Integrate discovery and harness guidance

- **Location**:
  - `src/acceptance/drive.ts`
  - `docs/acceptance-harness.md`
  - `test/acceptance-drive.test.ts`
- **Description**: Let the shipped CLI discover its sibling fixture provider
  by default while preserving explicit override authentication, and document
  the complete fresh-harness invocation and fixture evidence boundary.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 5
- **Acceptance criteria**:
  - Scenario-pack execution from an installed package needs no unpublished
    fixture script path.
  - Explicit provider overrides remain authenticated and backward compatible.
  - The runbook names build-before-pack, family isolation, independent
    observation, restart, and hosted-only promotion boundaries.
- **Validation**:
  - `node --test test/acceptance-drive.test.ts test/acceptance-fixtures.test.ts`

## Sprint 2: Real harness proof and delivery

**Goal**: Prove the packaged fixtures under the actual DSH/provider boundary
and deliver the reviewed result.

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Demo/Validation**:

- Command(s): scripted 66-case proof, routine repository gate, three local
  smokes, and serial real-provider 33 + 33 matrix.
- Verify: every result and independent attestation passes; hosted main remains
  green after merge.

### Task 2.1: Validate package, smoke, and scripted accounting

- **Location**:
  - `compatibility/build-provenance.json`
  - `docs/devlog/2026-09.md`
- **Description**: Rebuild shipped output, refresh provenance, inspect the
  package, run routine validation and required smokes, and retain a complete
  scripted 66/66 result/attestation proof.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 6
- **Acceptance criteria**:
  - Build provenance is clean and all declared/focused/local smoke commands
    pass.
  - Scripted summary proves 66 unique cases with independent attestations.
- **Validation**:
  - `npm test`
  - `npm run typecheck`
  - `npm run benchmark:policy`
  - `npm run test:smoke`
  - `npm run test:workspace-lease-smoke`
  - `npm run test:workspace-lease-native-smoke`
  - `npm pack --ignore-scripts --json`

### Task 2.2: Run the complete real-provider matrix

- **Location**:
  - `docs/acceptance-harness.md`
- **Description**: Install the built candidate into twelve clean family
  profiles and run all unchanged success and deliberate-failure scenarios
  serially through real DSH, followed by independent observable-state
  attestations and strict pack summary.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Real results contain 33 success passes and 33 deliberate-failure/recovery
    passes with 66 valid independent attestations.
  - No result is promoted from marker text or fixture receipt alone.
- **Validation**:
  - `dsh-runtime-kit acceptance-drive --summarize-pack --output "$RESULTS" --scenario-pack "$PACK"`

### Task 2.3: Review, merge, and close the tracker

- **Location**:
  - `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-execution-state.md`
- **Description**: Deliver the signed PR, converge testing, maintainability,
  and security review, merge through the governed provider path, verify main
  CI, close #218 strictly, and update #217/#197 with the new baseline.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 7
- **Acceptance criteria**:
  - Review ledger has no open finding and provider merge read-back matches the
    delivered head.
  - Main CI is green, #218 is closed with visible lifecycle evidence, and the
    parent issues point at the retained real matrix.
- **Validation**:
  - Provider PR checks and post-merge main compatibility workflow
  - `plan-issue tracking close-ready --expect-visible`
  - `plan-issue record audit --profile tracking --expect-visible`

## Testing Strategy

- Unit: strict fixture manifest parsing and operation validation.
- Integration: real filesystem/Git transition execution, receipts, recovery,
  cleanup, bin identity, and driver discovery.
- E2E: installed candidate plus real DSH/provider across all 66 cases.
- Delivery: specialist review, PR checks, post-merge main checks, and tracking
  closeout audit.

## Risks & gotchas

- Never execute free-form shell from fixture data; recipes select only typed
  provider operations.
- Never follow symlinks or accept group/other-writable roots.
- A scenario task may mutate its prepared workdir, so cleanup ownership must be
  distinguished from task output ownership.
- Full real-provider runs are serial and expensive; append evidence with unique
  run IDs so restarts do not erase prior truth.
- Source, bin, and script edits require committed build provenance refresh.

## Rollback plan

Remove the fixture bin, manifest, and discovery path together. Existing
explicit `--fixture-bin` callers remain the compatibility fallback; no runtime
capability or profile state is migrated by this change.
