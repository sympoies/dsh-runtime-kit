# Plan: Add Runtime-Owned Native Workspace Identity And Cross-Session Leases

## Overview

Deliver dsh-runtime-kit issue #56 as one serial L2 tracking outcome. Add a
runtime-kit-owned Cordis/DSH plugin that derives host-owned workspace identity
and lease lifecycle from DSH's existing public events and tool pipeline, retain
deterministic Git and lease policy in nils-cli, and promote the result only
after candidate and post-merge deployments pass the real-session,
compatibility, upgrade, and rollback gates required by #66.

## Read First

- Primary source:
  `docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Owner tracker: https://github.com/sympoies/dsh-runtime-kit/issues/56
- Umbrella tracker: https://github.com/sympoies/dsh-runtime-kit/issues/66
- DSH target: existing released public DeepSeek Harness extension interfaces;
  no DSH source delivery
- Deterministic policy dependency: `sympoies/nils-cli`
- Runtime integration target: `sympoies/dsh-runtime-kit`
- Open questions carried into execution: none

## Scope

- In scope: a runtime-kit-owned versioned WorkspaceRef and WorkspaceLease
  plugin, exact host binding through existing public DSH lifecycle and tool
  events, cross-process persistence, canonical Git/worktree identity, fencing,
  compatibility adapters, real two-session tests, restart/recovery tests,
  packed deployments, upgrade, rollback, and evidence.
- Out of scope: an upstream DSH PR, a maintained DSH fork or vendored Harness,
  commit and delivery policy, a JavaScript Git/lease engine, model-authored
  authority, private paths or topology, and implementation from later #66
  child issues.
- A version-pinned DSH source patch is an exception path, not the design. It may
  be proposed only after a packed regression proves that a named public seam is
  insufficient and #56 plus #66 are amended at Gate 0 before any such edit.

## Delivery shape and convergence rule

This is one L2 tracking outcome with serial cross-repository delivery. Each
changed repository receives its own reviewable PR and immutable validation
evidence. The dsh-runtime-kit PR is the owner PR for plan closeout; the linked
nils-cli PR must merge first or be included as an immutable accepted
dependency. The official DSH release is a pinned compatibility dependency, not
a changed repository or linked PR. No #55 production change may start until
every task below is done and #56 has passed the #66 Gate 5 promotion.

## Sprint 1: Contract, implementation, and accepted deployment

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: replace reconstructed workspace ownership with one runtime-kit-owned
native DSH plugin and durable nils-cli lease authority, then deploy and accept
it as the new program baseline without modifying the official Harness.

**Demo/Validation**:

- Command: packed two-session real DSH workspace smoke across the supported
  compatibility matrix
- Verify: same-worktree contention denies before body, distinct worktrees run
  concurrently, crash recovery is durable, and rollback restores the prior
  baseline

### Task 1.1: Freeze the accepted baseline and initialize tracking

- **Location**: this plan bundle, issues #56 and #66, compatibility manifests
- **Description**: record exact runtime-kit, DSH, nils-cli, package, and profile
  identities; capture current gates; attach #56 once to the validated plan; and
  initialize reconciled run state from this managed worktree.
- **Dependencies**: none
- **Complexity**: 4
- **Acceptance criteria**:
  - Source, plan, and execution state validate and are provider-visible.
  - The initial baseline records immutable versions and digests without local
    paths or secrets.
  - #56 has exactly one tracking lifecycle and #66 still selects only #56.
- **Validation**:
  - `plan-tooling validate --file docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-plan.md --format text --explain`
  - `plan-issue tracking status --profile tracking --expect-visible`

### Task 1.2: Add the runtime-owned native workspace capability

- **Location**: dsh-runtime-kit plugin and compatibility surfaces consuming
  public DSH service, session, tool, and agent extension interfaces
- **Description**: implement the versioned WorkspaceRef and WorkspaceLease
  contracts, host-only authority, provider lifecycle, exact binding, typed
  states, and cancellation/resume/disposal integration as a runtime-kit-owned
  Cordis plugin without a DSH source patch, fork, or private import.
- **Dependencies**: Task 1.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Model and tool input cannot manufacture or retarget authority.
  - Session, tool, child, generation, cancellation, restart, and disposal
    semantics are typed and independently tested.
  - Unsupported provider state fails before mutation.
  - Production code imports only DSH's documented package entrypoints and the
    packed profile proves the same lifecycle behavior as focused tests.
- **Validation**:
  - focused runtime-kit workspace service and lifecycle tests
  - runtime-kit typecheck and packed DSH profile smoke across every supported
    compatibility row

### Task 1.3: Add nils-cli canonical identity and durable lease policy

- **Location**: `sympoies/nils-cli` agent-hook and shared repository lifecycle
  boundaries
- **Description**: add the strict workspace wire contract, canonical
  Git/worktree evaluator, durable cross-process lease backend, fencing,
  idempotency, conflict states, and safe stale-clean reconciliation.
- **Dependencies**: Task 1.2 wire contract
- **Complexity**: 10
- **Acceptance criteria**:
  - Equivalent path spellings resolve identically and distinct linked
    worktrees remain distinct.
  - Same-worktree cross-process contention, replay, dirty/active/unknown
    refusal, stale-clean recovery, and duplicate lifecycle messages pass.
  - Diagnostics are stable and carry no protected values.
- **Validation**:
  - focused Rust unit and integration suites
  - formatting, clippy, docs, API contract, and repository local-fast gates

### Task 1.4: Integrate the native capability through runtime-kit

- **Location**: dsh-runtime-kit compatibility, policy, lifecycle, and smoke
  surfaces
- **Description**: register the provider, consume exact host bindings, isolate
  release-specific adapters, compose the plugin in the runtime bundle,
  eliminate native-path identity choreography, and add packed
  two-session/restart acceptance without duplicating nils policy.
- **Dependencies**:
  - Task 1.2
  - Task 1.3
- **Complexity**: 10
- **Acceptance criteria**:
  - Every supported DSH release loads the runtime-owned plugin through public
    extension points or follows an explicit isolated compatibility adapter.
  - Same worktree denies the second mutation before body; distinct worktrees
    mutate concurrently; copied authority and stale generations fail closed.
  - No model-visible heartbeat, shell proof, or machine path is required.
- **Validation**:
  - focused test-first runtime-kit regressions
  - `npm test`
  - `npm run typecheck`
  - `npm run verify:policy-source`
  - package dry-run inspection

### Task 1.5: Review and deploy the immutable candidate

- **Location**: linked nils-cli and dsh-runtime-kit PR heads; pinned official
  DSH releases; clean and isolated-canary DSH profiles
- **Description**: complete independent specialist review, build immutable
  artifacts from reviewed heads, install them against pinned unmodified DSH
  releases through the public profile path, and run the full #56 candidate
  integration gate before merge.
- **Dependencies**: Task 1.4
- **Complexity**: 8
- **Acceptance criteria**:
  - Every affected PR has converged review and exact-head validation.
  - Clean-profile and canary installations use packed artifacts, not source
    links or direct profile copies.
  - Positive, negative, concurrency, cancellation, restart, recovery, upgrade,
    rollback, and every pinned DSH compatibility row pass.
- **Validation**:
  - keyless packed smoke with matching immutable nils binaries
  - real two-session canary scenario
  - upgrade from and rollback to the Task 1.1 baseline

### Task 1.6: Merge, redeploy, promote, and close #56

- **Location**: merged immutable artifacts, issues #56 and #66, architecture and
  compatibility documentation
- **Description**: merge through protected workflows, rebuild from merged
  identities, repeat the required clean/canary deployment and smoke, record the
  acceptance checkpoint, promote the baseline in #66, and close #56 only after
  strict readiness succeeds.
- **Dependencies**: Task 1.5
- **Complexity**: 7
- **Acceptance criteria**:
  - Post-merge deployment repeats the focused real-session case and full
    compatibility smoke successfully.
  - Upgrade and rollback leave coherent profiles and do not modify unrelated or
    primary profiles.
  - #56 contains immutable, secret-safe acceptance evidence; #66 checks only
    #56 and names #55 as next eligible.
  - Plan close-ready reports no blocker and provider read-back proves closeout.
- **Validation**:
  - merged-artifact clean-profile and canary deployment
  - final `plan-issue tracking close-ready --expect-visible`
  - provider read-back and plan record audit

## Completion criteria

- All six task-ledger rows are done with immutable evidence.
- nils-cli and runtime-kit changes are reviewed and merged through their normal
  protected workflows; official DSH artifacts remain unmodified pinned inputs.
- Candidate and post-merge deployments both satisfy #56 and #66.
- #56 is closed through the tracking controller, #66 records the promoted
  baseline, and no #55 implementation started early.
