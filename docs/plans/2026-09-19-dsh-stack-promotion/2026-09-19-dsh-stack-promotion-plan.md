# Plan: Promote DSH 0.1.6-alpha.2 in the headless deployment lane

## Overview

Promote DSH `0.1.6-alpha.2` as a complete, independently rollbackable headless
generation. Finish the version-scoped runtime-kit compatibility work, keep the
Agent Console/workbench generation entirely unchanged, and prove one immutable
headless artifact through canary, governed delivery, and hosted deployment.

## Read First

- Primary source: docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope: lane-scoped promotion contract and regression, DSH alpha.2 patch
  and compatibility identities, immutable headless canary artifact, governed
  PR/release delivery, headless generation deployment, rollback proof, and
  strict tracking closeout.
- Out of scope: changing or redeploying Agent Console/workbench, forced TUI
  peer overrides, permanent third-release exceptions, agent-submitted
  third-party changes, or a runtime-kit-owned general deployment orchestrator.

## Assumptions

1. DSH `dsh-v0.1.6-alpha.2` is immutable at revision
   `ddefc45fbc7f8e46dd73185e68295696d1297887` and uses Cordis `4.0.2`.
2. Headless and workbench have disjoint mutable DSH homes, profile homes,
   runtime roots, and activation targets. Hosted deployment must verify this
   before applying the headless candidate.
3. The currently deployed workbench generation remains unchanged, including
   its DSH, TUI, runtime-kit artifact, profile, and configuration.
4. Hosted headless activation and rollback are implemented by the
   infrastructure owner and consume the runtime-kit artifact accepted here.

## Sprint 1: Freeze the promotion contract and alpha.2 candidate

**Goal**: Define the deployment-lane boundary, fail closed on accidental
workbench mutation, and finish the exact headless candidate for the new DSH.

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Demo/Validation**:

- Command(s): focused compatibility, Agent Console boundary, operations, and DSH patch
  tests; authenticated patch apply/reverse on pristine alpha.2.
- Verify: a mismatched Agent Console DSH fails before mutation, while both
  retained generic DSH releases keep exact authenticated patch evidence.

### Task 1.1: Enforce lane-scoped promotion before profile mutation

- **Location**:
  - `compatibility/dsh.json`
  - `compatibility/agent-console.json`
  - `src/operations/index.ts`
  - `test/compatibility.test.ts`
  - `test/operations.test.ts`
- **Description**: Add the owner regression and runtime refusal that bind the
  exact Agent Console DSH identity before any `dsh-tui` setup, update,
  rollback, or repair mutation. Record the generalized rule that each selected
  lane advances atomically while every excluded lane remains wholly frozen.
- **Dependencies**:
  - none
- **Complexity**: 7
- **Acceptance criteria**:
  - A `dsh-tui` operation with a DSH version or revision outside the exact
    Agent Console contract returns a stable typed refusal before mutation.
  - Headless operations retain the generic two-release admission behavior.
  - Tests prove the headless candidate excludes the frozen Agent Console DSH
    identity and omits Agent Console mutation smoke from its workflow.
- **Validation**:
  - `node --test test/compatibility.test.ts test/agent-console-profile.test.ts test/operations.test.ts`

### Task 1.2: Complete DSH 0.1.6-alpha.2 authenticated compatibility

- **Location**:
  - `compatibility/dsh.json`
  - `compatibility/dsh-patches.json`
  - `package.json`
  - `package-lock.json`
  - `patches/deepseek-harness/native-execution-boundaries-v5-0-1-6-alpha-2.patch`
  - `src/compat/contract.ts`
  - `test/compatibility.test.ts`
  - `test/dsh-patch.test.ts`
- **Description**: Finish the alpha.2 patch port, exact target hashes, public
  entrypoint/type digests, complete transitive workspace artifact closure,
  peer package identities, retained-release rollover, and pristine
  apply/reverse validation.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 9
- **Acceptance criteria**:
  - Generic reviewed releases are exactly `0.1.5-alpha.2` and
    `0.1.6-alpha.2`, with pinned and upstream-next bound to the exact alpha.2
    revision.
  - Patch check/apply/reverse fails closed on unknown, dirty, or drifted source
    and succeeds on both retained pristine revisions.
  - The alpha.2 typed and bundled host builds and affected DSH test suites pass
    after patch apply and after reverse.
- **Validation**:
  - `node --test test/compatibility.test.ts test/dsh-patch.test.ts`
  - `npm run dsh-patch -- --action check --source-root "$PRISTINE_DSH_ROOT"`
  - DSH `pnpm run typecheck`, affected Vitest suites, and `pnpm run build:lib:host`

### Task 1.3: Record the deferred dsh-TUI alpha.2 handoff

- **Location**:
  - `docs/policies/upstream-contribution.md`
  - `compatibility/agent-console.json`
  - `docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-discussion-source.md`
- **Description**: Inspect dsh-TUI default-branch behavior and contribution
  rules, reproduce alpha.2 composition publicly, and retain a de-identified
  issue-first draft for a future workbench promotion without blocking the
  headless lane.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 7
- **Acceptance criteria**:
  - The handoff cites exact dsh-TUI and DSH identities and contains a minimal
    public reproduction with no private evidence.
  - No local peer override, forced install, agent-authored upstream issue, PR,
    DCO, or CLA is used as compatibility evidence.
  - The absence of a compatible TUI is recorded as deferred work, not a
    dependency of headless release or deployment.
- **Validation**:
  - dsh-TUI owner tests and exact clean-profile composition smoke documented by
    its contribution rules

## Sprint 2: Release, canary, and headless generation promotion

**Goal**: Freeze the runtime-kit artifact, prove the headless profile, and
deploy it as a reversible generation without touching workbench.

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Demo/Validation**:

- Command(s): routine gate, build/provenance/package identity, complete
  compatibility workflow, installed headless canary, hosted headless
  generation health and rollback.
- Verify: the same runtime-kit archive digest passes every environment and the
  old generation remains selectable until post-deploy read-back succeeds.

### Task 2.1: Freeze the excluded workbench lane

- **Location**:
  - `compatibility/agent-console.json`
  - `test/agent-console-profile.test.ts`
  - `.github/workflows/compatibility.yml`
- **Description**: Retain the exact existing Agent Console contract as an
  external frozen generation, keep the candidate peer window headless-only,
  and ensure candidate CI does not install or mutate the TUI lane.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 8
- **Acceptance criteria**:
  - Candidate peers exclude the frozen Agent Console DSH identity.
  - CI contains no Agent Console install/mutation smoke for this candidate.
  - Operations retain the typed pre-mutation refusal for accidental `dsh-tui`
    targeting under the new DSH.
- **Validation**:
  - `node --test test/agent-console-profile.test.ts test/dsh-tui-patch.test.ts test/compatibility.test.ts`
  - headless-only workflow contract in `.github/workflows/compatibility.yml`

### Task 2.2: Freeze and prove one immutable runtime-kit artifact

- **Location**:
  - `compatibility/build-provenance.json`
  - `docs/compatibility.md`
  - `docs/operations.md`
  - `docs/acceptance-harness.md`
  - `README.md`
- **Description**: Finish normative documentation, rebuild once through the
  canonical builder, bind archive and installed-tree identities, run the
  routine gate once, and exercise setup, doctor, composition inspection,
  update, smoke, and rollback on clean headless and Agent Console canaries.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 9
- **Acceptance criteria**:
  - Build provenance, package inventory, executable roles, archive SHA-256, and
    extracted package tree digest are current and reviewable.
  - The headless profile passes using the exact DSH revision, patch, Cordis,
    nils-cli, Node, and runtime-kit artifact tuple.
  - A failed setup or health probe leaves the prior profile state untouched and
    reports a stable owner-specific stage/code.
- **Validation**:
  - `npm test`
  - `npm run typecheck`
  - `npm run benchmark:policy`
  - `npm pack --ignore-scripts --json`
  - required DSH headless packed smoke legs

### Task 2.3: Deliver, deploy the new generation, and close strictly

- **Location**:
  - `.github/workflows/compatibility.yml`
  - `docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-execution-state.md`
  - `docs/devlog/2026-09.md`
- **Description**: Deliver the governed PR, converge independent review,
  reproduce the accepted artifact, hand the exact headless tuple to the
  infrastructure owner, verify lane isolation, require new-generation health
  read-back and rollback proof, merge and close only after every tracking and
  hosted gate is visible.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 9
- **Acceptance criteria**:
  - Review ledger has no open finding and provider merge/read-back matches the
    delivered head.
  - Hosted promotion consumes the accepted artifact digest and produces an
    observable healthy headless generation receipt plus a tested prior-
    generation rollback receipt without changing workbench identity.
  - The tracking issue passes `close-ready`, closes with visible evidence, and
    its provider record passes post-close audit.
- **Validation**:
  - provider PR checks and post-merge main compatibility workflow
  - infrastructure-owned generation deploy and rollback receipts
  - `plan-issue tracking close-ready --expect-visible`
  - `plan-issue record audit --profile tracking --expect-visible`

## Testing Strategy

- Unit: manifest schemas, lane exclusion, typed pre-mutation refusals, patch
  target hashes, and exact package identities.
- Integration: pristine patch apply/reverse, DSH typed/bundled builds,
  operations preview/apply, TUI repair, package and installed-tree identity.
- E2E/manual: isolated headless canary using the frozen artifact, followed by
  infrastructure-owned headless activation and rollback read-back plus
  workbench identity read-back.
- Delivery: testing, maintainability, API-contract, and security specialist
  review; PR checks; post-merge hosted promotion; strict tracker audit.

## Risks & gotchas

- A future workbench promotion still requires a released compatible dsh-TUI and
  real composition behavior; its absence does not block this headless lane.
- Changing the candidate after packaging invalidates canary and hosted
  evidence even when the Git tree looks equivalent.
- A shared mutable DSH home, profile home, runtime root, or activation target
  would invalidate lane independence and block hosted deployment.
- Production deployment is a separate authorized hosted mutation; local smoke
  must never be reported as deployment success.

## Rollback plan

- Before the headless service switch, discard the failed new generation and
  keep its old tuple active. After the switch, restore the exact prior headless
  generation and verify both headless health and unchanged workbench identity.
  Do not re-add a retired release to the new runtime-kit artifact as a rollback
  mechanism.
