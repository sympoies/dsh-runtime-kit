# Plan: Replace agent-runtime-kit with DSH Runtime Kit

## Overview

Deliver the complete replacement through one shared dispatch issue and a
sequence of independently reviewable PR lanes. Land the proven external bundle
and strict nils-cli ingress first, then add DSH lifecycle and deterministic
policy parity, reviewer agents, operations/compatibility, and finally local
cutover. No lane may claim completion by preserving a legacy Python handler or
an active `agent-runtime-kit` runtime dependency.

## Read First

- Primary source:
  `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Owner tracker: the shared dispatch issue opened from this bundle
- DSH target: public `sympoies/dsh-runtime-kit`
- Deterministic policy dependency: `sympoies/nils-cli`
- Upstream compatibility target: `deepseek-ai/deepseek-harness`
- Open questions carried into execution: none

## Scope

- In scope: public bundle and package, 29 skills, private/project loading,
  strict nils DSH transport, all active runtime policies and finish-line
  behavior, runtime context, eight reviewers, setup/update/rollback,
  compatibility CI, real-session acceptance, local cutover, and old-runtime
  active-reference retirement.
- Out of scope: a DSH fork, a copied standard preset, private skill contents,
  Codex/Claude/Hermes support, raw reimplementation of nils workflow commands,
  deletion of historical audit records, and live nils-cli release or local
  cutover before its owning gate is satisfied.

## Delivery shape and convergence rule

This is one L3 dispatch outcome. DSH repository lanes target
`feat/dsh-runtime-migration-plan`; the linked nils-cli lane targets its own
`main` because it is a cross-repository dependency. Each implementation writer
stops after validation and PR delivery. A different reviewer owns the lane
review. Only the orchestrator integrates an approved lane.

Split a lane again if it exceeds a coherent owner boundary or cannot be
reviewed confidently. Blocking fixes return to the same implementation writer
and receive an affected-only follow-up review. No unchanged finding is reposted.

## Sprint 1: Bootstrap and proven external-bundle seam

**PR grouping intent**: `group`
**Execution Profile**: `parallel-x2`

**Goal**: preserve the completed prototype as the first reviewable DSH lane and
deliver the strict nils-cli seam as a linked dependency.

**Demo/Validation**:

- Command: packed-bundle real DSH smoke plus focused `nils-agent-hook` tests
- Verify: `41 -> 42`, block-before-body, 29 bundled skills, and
  project > private > bundled precedence without modifying upstream DSH

### Task 1.1: Initialize the dispatch record and plan branch

- **Location**: this plan bundle and the public DSH repository
- **Description**: validate and commit the source/plan/state bundle, open the
  single shared dispatch issue, initialize run state with this execution-state
  file, and publish the plan branch.
- **Dependencies**: none
- **Complexity**: 3
- **Acceptance criteria**:
  - Exactly one public DSH repository and one shared dispatch issue exist.
  - Run state reconciles with all task rows and no stale record.
  - The clean primary checkout remains on `main`; work occurs in managed
    worktrees.
- **Validation**:
  - `plan-tooling validate --file docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md --format text --explain`
  - `plan-issue tracking status --profile dispatch --expect-visible`

### Task 1.2: Deliver the external bundle and skills baseline

- **Location**: `sympoies/dsh-runtime-kit`
- **Description**: move the already-tested prototype into a managed lane,
  retain the public/private boundary fixes, and deliver it to the plan branch.
- **Dependencies**: Task 1.1
- **Complexity**: 7
- **Acceptance criteria**:
  - Package install uses only public DSH bundle/provider APIs.
  - Packed artifact owns all 29 skills and every resource, with no named
    private profile or private content.
  - Private root trust and project/private/bundled precedence are enforced.
  - Allow runs the probe body once; block runs it zero times.
- **Validation**:
  - `npm test`
  - real `npm run test:smoke` against DSH `0.1.0-rc.7`
  - `npm pack --dry-run --json`

### Task 1.3: Deliver strict nils-cli DSH ingress

- **Location**: `sympoies/nils-cli` `nils-agent-hook`
- **Description**: move the existing test-first DSH ingress, native decision,
  doctor, completion, and documentation work into a managed nils-cli lane and
  deliver a linked PR to nils-cli `main`.
- **Dependencies**: Task 1.1
- **Complexity**: 7
- **Acceptance criteria**:
  - Strict ingress rejects unknown fields, versions, events, field overflow,
    non-object arguments, relative cwd, replay, timeout, and malformed output.
  - `setup` truthfully names `dsh-runtime-kit` as registration owner and writes
    no DSH configuration.
  - Existing products and API contracts remain compatible.
- **Validation**:
  - focused `cargo test -p nils-agent-hook`
  - formatting, clippy, docs, completion, and nils local-fast gates

## Sprint 2: Native lifecycle, runtime context, and finish-line state

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: replace provider hooks with typed DSH lifecycle events and eliminate
the shell EXIT-wrapper validation mechanism.

**Demo/Validation**:

- Command: DSH session lifecycle integration fixture
- Verify: session start/pre-step/pre-tool/post-tool/turn-stop events correlate
  to one session and authoritative tool results drive finish-line state

### Task 2.1: Add the bounded lifecycle compatibility layer

- **Location**: `dsh-runtime-kit/src/compat` and `src/policy`
- **Description**: isolate supported DSH imports, normalize all required public
  lifecycle events, add request correlation and monotonic denial, and implement
  bounded cancellation-aware nils transport.
- **Dependencies**:
  - Task 1.2
  - Task 1.3
- **Complexity**: 10
- **Acceptance criteria**:
  - Session start, pre-step, pre-tool, post-tool, result, and turn-stop are
    covered by typed tests.
  - Later waterfalls cannot reverse an authoritative policy denial.
  - No shell interpolation or unbounded subprocess/output path exists.
- **Validation**:
  - policy unit/contract tests
  - real DSH allow, deny, context, cancellation, and disposal integration

### Task 2.2: Implement selective runtime context

- **Location**: `dsh-runtime-kit/src/context` and nils agent-docs contracts
- **Description**: add one `runtime_context({intent})` tool that prepares and
  verifies the requested intent and returns only bounded required documents.
- **Dependencies**: Task 2.1
- **Complexity**: 7
- **Acceptance criteria**:
  - No complete policy corpus is injected at session start.
  - Mutation without prepared `project-dev` returns one stable remediation.
  - Context for another repo/session/intent cannot be replayed.
- **Validation**:
  - context contract and cross-repository replay tests
  - token-size comparison against the old injected baseline

### Task 2.3: Replace validation wrappers with result-driven finish-line state

- **Location**: nils-cli finish-line capability and DSH post-tool/turn-stop adapter
- **Description**: record edit generations and declared validation results from
  authoritative DSH outcomes, then enforce the stop boundary without rewriting
  shell commands.
- **Dependencies**: Task 2.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Edit, pending, failure, retry, success, waiver, session, and concurrent
    generation semantics are deterministic and crash-safe.
  - The old EXIT trap is absent from DSH production behavior.
  - Stop blocks until the exact required validation state is satisfied.
- **Validation**:
  - edit -> dirty -> failed validation -> blocked stop -> success -> allowed stop
  - crash, stale completion, multi-contract, and cross-session tests

## Sprint 3: Deterministic policy parity

**PR grouping intent**: `group`
**Execution Profile**: `parallel-x3`

**Goal**: move every active legacy policy behavior into typed nils-cli
capabilities and prove an explicit disposition for all 101 registrations and 22
handler IDs.

**Demo/Validation**:

- Command: parity-matrix verifier plus adversarial DSH policy E2E
- Verify: no active row remains pending and no production decision invokes a
  legacy handler file

### Task 3.1: Freeze the parity inventory and capability groups

- **Location**: `policy/rule-parity.yaml`, nils capability schemas, and fixtures
- **Description**: map every legacy registration and handler ID to one DSH
  lifecycle capability, stronger replacement, or provider-obsolete retirement.
- **Dependencies**: Task 2.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Inventory is exhaustive and machine-validated.
  - Retirement requires evidence and cannot hide an active invariant.
  - Active rows name their owning implementation and tests.
- **Validation**:
  - exact legacy source inventory comparison
  - schema and duplicate/missing-row tests

### Task 3.2: Port Git, delivery, scope, and edit-admission policies

- **Location**: nils-cli agent-hook capabilities and DSH policy bundle
- **Description**: implement project-dev, checkout lease, semantic conflict,
  owner liveness, direct commit/worktree/PR/default delivery, semantic-commit
  body, direct Python, and agent-scope policies.
- **Dependencies**:
  - Task 2.2
  - Task 3.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Known mutation and unknown effects fail closed without exact preparation.
  - Managed worktree and delivery recovery paths remain usable.
  - Cross-repository and nested command forms cannot spoof cwd or intent.
- **Validation**:
  - adversarial argv/path/worktree/session fixtures
  - real DSH managed-worktree delivery rehearsal

### Task 3.3: Port privacy, memory, reminder, and portable-output policies

- **Location**: nils-cli agent-hook capabilities and DSH context/result adapter
- **Description**: implement MCP secret scan, project-memory denial, memory
  principle guidance, portable paths, labels, skill usage, session health, and
  pre-PR reminders without private content in the public bundle.
- **Dependencies**:
  - Task 2.1
  - Task 3.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Secret-bearing or machine-local provider payloads are denied/redacted.
  - Advisory context is bounded, deduplicated, and delivered once at the right
    lifecycle boundary.
  - Provider-specific obsolete coauthor behavior has an explicit generic
    replacement or retirement record.
- **Validation**:
  - privacy corpus and package scans
  - context deduplication and malformed-input tests

### Task 3.4: Port coordination and operation lifecycle

- **Location**: nils-cli agent-session capabilities and DSH lifecycle adapter
- **Description**: implement activity, semantic conflict, owner liveness,
  admission/complete/failure reconciliation, and managed/unmanaged session
  behavior on DSH identities.
- **Dependencies**:
  - Task 2.1
  - Task 3.1
- **Complexity**: 10
- **Acceptance criteria**:
  - One exact operation admits and completes/reconciles once.
  - Foreign active writers block; stale clean state is reclaimable; dirty or
    unknown state stays conservative.
  - Unmanaged and partial identities follow their declared safe contracts.
- **Validation**:
  - concurrent agent/session/checkout integration matrix
  - crash and terminal reconciliation tests

### Task 3.5: Remove legacy handler execution from production

- **Location**: DSH policy bundle, nils agent-hook, package and CI scans
- **Description**: switch every active parity row to typed capabilities and
  prohibit runtime handler file execution for product `dsh`.
- **Dependencies**:
  - Task 2.3
  - Task 3.2
  - Task 3.3
  - Task 3.4
- **Complexity**: 6
- **Acceptance criteria**:
  - Parity verifier reports no pending active row.
  - Production package contains no legacy handler executables.
  - DSH contract rejects any `runtime-kit.handler.v1` rule.
- **Validation**:
  - package/reference scans
  - full policy and real-session regression suite

## Sprint 4: Native specialist reviewers

**PR grouping intent**: `group`
**Execution Profile**: `parallel-x2`

**Goal**: preserve the eight reviewer roles through one DSH-native tool while
enforcing read-only behavior outside prompt compliance.

**Demo/Validation**:

- Command: start every reviewer persona and attempt a mutation
- Verify: 8/8 correct persona contracts; mutation denied before body execution

### Task 4.1: Implement reviewer personas and selection tool

- **Location**: `agents/reviewers`, `src/review`, and review skills
- **Description**: add one schema-stable `review_specialists` tool, server-side
  persona loading, result collection, cancellation, parallelism, and red-team
  routing.
- **Dependencies**: Task 2.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Only eight known roles are selectable and persona content is not caller
    controlled.
  - Parallel reviews correlate results and cancellation without leaking
    sessions.
  - Skill routing preserves quick/focused/specialist/red-team behavior.
- **Validation**:
  - 8/8 persona and schema tests
  - parallel, timeout, cancellation, and malformed-request tests

### Task 4.2: Enforce reviewer read-only authority

- **Location**: DSH policy/session classification and reviewer integration tests
- **Description**: classify reviewer sessions and monotonically deny mutation
  tools regardless of tool filtering or persona text.
- **Dependencies**:
  - Task 3.2
  - Task 4.1
- **Complexity**: 7
- **Acceptance criteria**:
  - Direct, nested, code-mode, and delegated mutation attempts are blocked.
  - Read-only repository inspection remains available.
  - A forged ordinary session cannot claim reviewer restrictions or identity.
- **Validation**:
  - adversarial reviewer mutation E2E
  - session identity and policy replay tests

## Sprint 5: Operations and compatibility

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: make installation, diagnosis, upgrading, rollback, and upstream
breakage observable and repeatable without maintaining a DSH fork.

**Demo/Validation**:

- Command: clean-profile install -> doctor -> update -> rollback -> remove
- Verify: exact owned state converges and upstream checkout stays clean

### Task 5.1: Add setup, doctor, update, rollback, and remove

- **Location**: package CLI/diagnostics, docs, and nils compatibility commands
- **Description**: own only bundle configuration and exact runtime-kit state;
  preserve unrelated DSH plugins and user settings.
- **Dependencies**:
  - Task 2.1
  - Task 3.5
- **Complexity**: 10
- **Acceptance criteria**:
  - Every operation has dry-run/plan evidence and idempotent apply.
  - Rollback restores the exact previous owned version/configuration.
  - Remove deletes only exact owned state and never private skill content.
- **Validation**:
  - install/update/rollback/remove matrix in isolated DSH homes
  - drift, interruption, and unrelated-config preservation tests

### Task 5.2: Add upstream compatibility and performance gates

- **Location**: CI, compatibility adapter, package ranges, and benchmarks
- **Description**: test the pinned release and selected upstream-next revision,
  validate public API assumptions, and enforce policy latency/resource budgets.
- **Dependencies**:
  - Task 3.5
  - Task 4.2
  - Task 5.1
- **Complexity**: 8
- **Acceptance criteria**:
  - Unsupported upstream changes produce a typed diagnostic, not partial boot.
  - No source patch or copied preset is required.
  - Pre-tool p95 and retained resource use meet documented budgets or block
    promotion with measurements.
- **Validation**:
  - compatibility CI matrix and clean-upstream assertion
  - controlled latency and resource benchmark

## Sprint 6: Real-session acceptance and retirement

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: prove the replacement in real work, switch this machine, and retire
all active old-runtime responsibility only after evidence is complete.

**Demo/Validation**:

- Command: full acceptance matrix followed by active-reference audit
- Verify: DSH alone completes the user's workflows and old runtime references
  are zero

### Task 6.1: Run the complete real-session acceptance matrix

- **Location**: isolated profiles plus representative public/private projects
- **Description**: execute bootstrap, inspect, edit, validate, review,
  private/project skill, semantic commit, PR delivery, resume, subagent, and
  finish-line scenarios with released nils-cli and packaged DSH runtime kit.
- **Dependencies**:
  - Task 4.2
  - Task 5.2
- **Complexity**: 10
- **Acceptance criteria**:
  - Every scenario has exact command/runtime evidence and expected state.
  - No scenario invokes Codex, Claude Code, Hermes, or old runtime handlers.
  - Security and failure-path scenarios fail closed as specified.
- **Validation**:
  - full acceptance runner and retained summary
  - specialist review across all required lenses

### Task 6.2: Cut over the local runtime

- **Location**: user-owned DSH configuration and machine-local runtime surfaces
- **Description**: install the approved package/released nils-cli, enable the
  private loader path, disable old sync/install/runtime wiring, and verify from
  a fresh DSH process.
- **Dependencies**: Task 6.1
- **Complexity**: 8
- **Acceptance criteria**:
  - Fresh DSH sessions load the intended public, project, and private surfaces.
  - No active process/configuration resolves old runtime hooks or products.
  - Rollback evidence exists before cutover and remains usable until final
    retirement.
- **Validation**:
  - post-cutover doctor and fresh-process smoke
  - exact active configuration and symlink inventory

### Task 6.3: Retire active agent-runtime-kit usage and close dispatch

- **Location**: old repository metadata, active-reference audit, dispatch issue
- **Description**: remove remaining active CI/docs/config/env/symlink references,
  mark the old repository historical/read-only, then run strict close-ready,
  provider read-back, and archive handoff.
- **Dependencies**: Task 6.2
- **Complexity**: 7
- **Acceptance criteria**:
  - Active-reference audit returns zero dependencies on the old runtime.
  - Historical evidence remains available and is clearly non-operational.
  - Every task, PR, review, validation, acceptance, and integration gate is
    visible and close-ready reports no blocker.
- **Validation**:
  - active-reference and old-runtime no-execution audits
  - `plan-issue tracking close-ready --profile dispatch --expect-visible`
  - closeout provider read-back and record audit
