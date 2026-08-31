# Plan: Promote dsh-TUI 0.10.0-beta.3 Through Agent Console

## Overview

Promote the exact dsh-TUI 0.10.0-beta.3 npm artifact through the runtime-kit
compatibility owner, then update and deploy the Agent Console infra contract in
strict serial order. Preserve the authenticated nonblocking history-lock
repair first established for beta.2 and the upstream private data-file modes,
keep DSH 0.1.1-rc.2 and all
other runtime inputs unchanged, and close only after sympoies, m4, and rollback
evidence are complete.

## Read First

- Primary source:
  `docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Runtime compatibility owner: `sympoies/dsh-runtime-kit`
- Deployment owner: `serenvia/sympoies-infra`
- Upstream package: `@deepseek-harness-tui/dsh-tui@0.10.0-beta.3`
- Open questions carried into execution: none

## Scope

- In scope: exact source and npm artifact identity, retained installed-package
  patch, test-first compatibility evidence, exact DSH rc.2 composition smoke,
  runtime-kit review and merge, infra pin and graph update, serial sympoies/m4
  deployment, live smoke, rollback, and strict issue closeout.
- Out of scope: DSH, Node, pnpm, or nils-cli upgrades; upstream TUI changes;
  generic compatibility broadening; authority or model-route changes; removal
  of the downstream repair before an exact fixed upstream release exists.

## Delivery shape and convergence rule

This is one serial L2 tracking outcome with a runtime-kit owner PR followed by
an infra deployment PR. Runtime-kit must merge before infra may select its
identity. Both PRs receive independent review and governed delivery. The owner
tracker remains open through live sympoies and m4 acceptance and rollback
proof. No deployment step may consume an unmerged runtime-kit source head.

## Sprint 1: Authenticate beta.2 and promote its beta.3 successor in runtime-kit

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: replace the exact 0.9.3 compatibility boundary with an authenticated,
patched, and fully smoke-tested beta.3 boundary while retaining beta.2 for
rollback.

**Demo/Validation**:

- Command: focused profile/patch tests plus the exact Agent Console TUI
  composition smoke against DSH 0.1.1-rc.2
- Verify: beta.3 installs from authenticated npm bytes, the patch is reversible,
  held history locks do not block input dispatch, the TUI stays live, and all
  runtime-kit surfaces remain present

### Task 1.1: Freeze the baseline and initialize tracking

- **Location**: this plan bundle, compatibility manifests, provider tracker
- **Description**: record the current 0.9.3, DSH, nils-cli, Node, and runtime-kit
  identities; validate the plan bundle; open the tracking issue; and initialize
  reconciled run state from the managed worktree.
- **Dependencies**: none
- **Complexity**: 3
- **Acceptance criteria**:
  - Source, plan, and execution state validate and are provider-visible.
  - Baseline evidence contains immutable identities and no machine-local paths
    or secrets.
  - Exactly one tracking lifecycle is attached to the new issue.
- **Validation**:
  - `plan-tooling validate --file docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-plan.md --format text --explain`
  - `plan-issue tracking status --profile tracking --expect-visible`

### Task 1.2: Capture the compatibility RED and promote the exact artifact

- **Location**: `compatibility/agent-console.json`,
  `compatibility/dsh-tui-patches.json`, `patches/dsh-tui/`, focused tests, and
  exact smoke inputs
- **Description**: first prove the old 0.9.3 owner rejects beta.2, record
  beta.2's real lightweight-tag commit and npm identities, rebase the
  nonblocking history repair onto the upstream 0600/0700 changes, then promote
  the byte-compatible beta.3 successor across every exact test and workflow input.
- **Dependencies**: Task 1.1
- **Complexity**: 7
- **Acceptance criteria**:
  - A meaningful pre-change test fails on the 0.9.3 contract.
  - Package, source commit, tag shape, tarball, SRI, shasum, manifest digest,
    patch digest, and target before/after hashes are exact.
  - Patch apply/check/reverse and drift failures remain typed and fail closed.
  - Patched beta.3 preserves the private data directory/file modes and returns
    promptly when the history lock is held.
- **Validation**:
  - focused Agent Console profile, artifact, and TUI patch tests
  - patch lifecycle against the downloaded beta.2 npm artifact

### Task 1.3: Validate, review, deliver, and merge runtime-kit

- **Location**: full runtime-kit package, compatibility workflow, docs, devlog,
  and the runtime-kit PR
- **Description**: update normative compatibility and operations docs, run the
  complete package and exact Agent Console gates, complete independent
  specialist review and review-loop closure, deliver the PR, and merge only at
  the reviewed head.
- **Dependencies**: Task 1.2
- **Complexity**: 8
- **Acceptance criteria**:
  - Full tests, typecheck, policy-source verification, package inspection, and
    exact DSH rc.2 Agent Console TUI smoke pass.
  - Compatibility docs describe the actual lightweight-tag provenance and
    beta status without weakening artifact authentication.
  - All admitted review findings are repaired and closed at the current head.
  - The governed runtime-kit PR merges and provider read-back matches the
    reviewed head.
- **Validation**:
  - `npm test`
  - `npm run typecheck`
  - `npm run verify:policy-source`
  - package dry-run inspection
  - repository exact Agent Console TUI composition smoke
  - full pre-merge specialist review

## Sprint 2: Adopt, deploy, and prove rollback in infra

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: consume only the merged runtime-kit promotion, update the exact Agent
Console deployment graph, and roll it out safely across both live hosts.

**Demo/Validation**:

- Command: infra contract validation, clean/idempotent provision, live
  sympoies smoke, live m4 smoke, and rollback/read-back
- Verify: both surfaces report beta.3 and the merged runtime-kit identity while
  existing sessions and unrelated profile state survive rollout and rollback

### Task 2.1: Update and deliver the infra Agent Console contract

- **Location**: `serenvia/sympoies-infra` Agent Console runtime contract,
  package graph, provision tests, and runbook
- **Description**: select the merged runtime-kit commit and beta.3, regenerate
  the exact pnpm graph through the repo-owned provision path, update contract
  tests and documentation, validate, review, deliver, and merge the infra PR.
- **Dependencies**: Task 1.3
- **Complexity**: 7
- **Acceptance criteria**:
  - Infra pins the merged runtime-kit identity and exact beta.3 version.
  - The lock digest and contract tests bind the resulting exact package graph.
  - Clean install and second-run idempotency pass without deleting unrelated
    profile, session, provider, or credential state.
  - Independent review converges and the governed infra PR merges.
- **Validation**:
  - focused Agent Console DSH contract/provision tests
  - `make validate`
  - full pre-merge specialist review

### Task 2.2: Deploy sympoies, deploy m4, prove rollback, and close

- **Location**: live sympoies and m4 Agent Console DSH profiles; owner tracker
- **Description**: provision and smoke sympoies first, then m4; verify exact
  runtime and TUI read-back, session preservation, and bounded live startup;
  prove rollback to the authenticated beta.2 contract; record immutable evidence and
  close through strict tracking readiness and provider audit.
- **Dependencies**: Task 2.1
- **Complexity**: 8
- **Acceptance criteria**:
  - Sympoies passes exact version, profile, startup, runtime-kit receipt, and
    live smoke before m4 begins.
  - m4 passes the same exact read-back and live smoke.
  - Existing sessions survive the bounded serve/profile refresh.
  - Rollback/read-back proves beta.2 remains recoverable without deleting any
    profile home or unrelated state, after which the promoted beta.3 contract
    is restored and healthy.
  - Every ledger row is done, close-ready reports no blocker, and the closed
    issue passes provider read-back audit.
- **Validation**:
  - repo-owned sympoies Agent Console provision and smoke commands
  - repo-owned m4 provision and smoke commands
  - explicit prior-contract rollback and promoted-contract restoration
  - `plan-issue tracking close-ready --expect-visible`
  - provider closeout read-back and record audit

## Completion criteria

- All five task-ledger rows are done with immutable evidence.
- Runtime-kit and infra changes are independently reviewed and merged through
  their protected workflows.
- The exact beta.3 artifact is healthy on sympoies and m4, and the authenticated
  beta.2 contract has a proven rollback path.
- The tracking issue is closed through the tracking controller and audited
  provider-visible; terminal worktree cleanup is either safely complete or
  explicitly retained with recovery evidence.
