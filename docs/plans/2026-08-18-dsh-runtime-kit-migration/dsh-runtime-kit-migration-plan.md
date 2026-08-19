# Plan: Add DSH Runtime Kit Alongside Existing Provider Runtimes

## Overview

Deliver the complete DSH runtime through one shared dispatch issue and a
sequence of independently reviewable PR lanes. Land the proven external bundle
and strict nils-cli ingress first, then add DSH lifecycle and deterministic
policy parity, reviewer agents, operations/compatibility, and finally reversible
local DSH-profile activation. DSH uses `dsh-runtime-kit` plus nils-cli; Codex and
Claude Code continue to use `agent-runtime-kit` plus nils-cli. No DSH lane may
claim completion while it executes a legacy Python handler or depends on
`agent-runtime-kit`.

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
  compatibility CI, real-session acceptance, reversible local DSH activation,
  and coexistence isolation.
- Out of scope: a DSH fork, a copied standard preset, private skill contents,
  changes to Codex/Claude/Hermes support, raw reimplementation of nils workflow commands,
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

### Task 2.3: Replace validation wrappers with nils-executed finish-line state

- **Location**: nils-cli finish-line capability and DSH execute/turn-stop adapter
- **Description**: record edit generations, classify every foreground Bash
  command with a non-executing probe, and let nils execute and durably record
  the observed result through DSH's prepared shell and sandbox runtime. Exact
  targets may create validation evidence; ordinary commands advance generation
  without evidence. Enforce stop without model-reported outcomes or
  shell-command rewriting.
- **Dependencies**: Task 2.1
- **Complexity**: 10
- **Acceptance criteria**:
  - Edit, pending, failure, retry, success, session, compaction, and concurrent
    generation semantics are deterministic and crash-safe.
  - No public caller-reported outcome or manual evidence-mutation path can
    manufacture validation evidence.
  - Every foreground Bash command executes exactly once through nils. Exact
    probes return `ready`; ordinary probes return `ordinary-ready`, advance the
    repository generation before execution, and finish as `ordinary-applied`
    without evidence, making stop require exact revalidation.
  - Background Bash fails closed before execution.
  - DSH sandbox runner failure is infrastructure failure, while a classified
    sandbox denial is a failed observed validation.
  - An observed execution has exactly one non-null `exitCode`/`signal`, a
    canonical `NodeJS.Signals` value for any signal, and mutually exclusive
    `timedOut`/`aborted` flags. An impossible combination invalidates the
    execution-bearing response and awaits authenticated private quiesce before
    the error returns.
  - Authoritative execution follows the Linux/systemd containment and non-Linux
    fail-closed boundary in the
    [nils finish-line contract](https://github.com/sympoies/nils-cli/blob/main/crates/agent-hook/docs/specs/agent-hook-v1.md#native-dsh-finish-line),
    without claiming a general network or IPC sandbox.
  - The contained runner receives a sealed memfd config and exact runner inode
    through systemd `OpenFile`; a verified root-owned ELF interpreter launches
    it, and a pidfd binds runner lifetime to the nils supervisor.
  - Every transport, unexpected agent-hook exit/signal, response-validation,
    cancellation, deadline, or disposal failure after a run becomes
    execution-bearing invokes private nils quiesce for the same operation
    before returning the original error. Missing
    proof that the transient unit is inactive and unpopulated permanently
    degrades the client.
  - The old EXIT trap is absent from DSH production behavior.
  - Stop blocks until the exact required validation state is satisfied.
- **Validation**:
  - edit -> failed validation -> blocked stop -> exact success -> allowed stop
    -> ordinary mutation -> blocked stop -> exact revalidation -> allowed stop
  - crash, stale/superseded execution, sandbox classification, compaction,
    multi-contract, and cross-session tests
  - failed execution transport, agent-hook exit/signal, or response validation
    awaits private quiesce
  - 31-test focused nils finish-line suite, including killed-supervisor
    quiesce, trusted expired crash-orphan recovery, and late-mutation containment

## Sprint 3: Deterministic policy parity

**PR grouping intent**: `group`
**Execution Profile**: `parallel-x3`

**Goal**: move every active legacy policy behavior into typed nils-cli
capabilities and prove an explicit disposition for all 101 rules, including 69
handler-capability registrations across 22 handler IDs and the declared
67-registration/21-handler legacy subset.

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
  - Known mutation forms and shell shapes the bounded classifier cannot model
    fail closed without exact preparation; arbitrary native executable
    internals remain outside this transcript guardrail's threat boundary.
  - Managed worktree and delivery recovery paths remain usable.
  - Cross-repository and nested command forms cannot spoof cwd or intent.
- **Validation**:
  - adversarial argv/path/worktree/session fixtures
  - real DSH managed-worktree delivery rehearsal
- **Source evidence (2026-08-18)**:
  - strict ingress v2 binds session/turn/step and agent-docs roots
  - eleven typed groups validate in the packaged policy with no file handler
  - nils agent-hook suite, DSH package tests/typecheck, parity verifier, and the
    packed unmodified rc.7 smoke pass

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
- **Source evidence (2026-08-19)**:
  - nine groups validate only on their exact tool, pre-step, or stop event
  - strict lifecycle ingress v3 carries bounded user text and first-step source
  - nils 31/31 focused tests, DSH 111/111 plus typecheck/parity, and the packed
    unmodified rc.7 smoke with native skill-reminder context pass

### Task 3.4: Port coordination and operation lifecycle

- **Location**: nils-cli agent-session capabilities and DSH lifecycle adapter
- **Description**: implement activity and operation lifecycle, consume Task
  3.2's semantic-conflict and owner-liveness admission results, and provide
  admit/complete/failure reconciliation plus managed/unmanaged session behavior
  on DSH identities.
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
- **Source evidence (2026-08-19)**:
  - strict post ingress v4 carries only the correlated terminal error bit
  - metadata-only activity and one exact native operation admit/complete once
    across duplicate requests; active or uncertain state blocks Stop
  - unmanaged identity is a no-op, partial identity fails closed, and private
    terminal retry state is content-free and bounded to 64 records
  - nils passes 37/37 policy, 8/8 ingress, and 3/3 parity tests; DSH passes
    116/116 plus typecheck and the packed unmodified rc.7 smoke

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
- **Source evidence (2026-08-19)**:
  - all 101 frozen source rows resolve to 25 implemented groups or the one
    evidence-backed provider-obsolete retirement; no `planned` state remains
  - the packaged policy contains only `dsh.policy.v1` rules and the package tree
    contains none of the 22 retired handler executable basenames
  - nils rejects `runtime-kit.handler.v1` for product `dsh`; the packed
    unmodified rc.7 smoke executes no legacy handler

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

## Sprint 6: Real-session acceptance and coexistence activation

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: prove the DSH runtime in real work, activate it reversibly on this
machine, and close only after DSH isolation and existing-provider preservation
are both proven.

**Demo/Validation**:

- Command: full acceptance matrix followed by DSH-profile and provider-wiring
  coexistence audits
- Verify: DSH completes the user's workflows without `agent-runtime-kit`, while
  Codex and Claude Code still use `agent-runtime-kit` plus nils-cli unchanged

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
  - The functional-session receipt proves the DSH profile has zero dependency
    on `agent-runtime-kit`, does not load Codex/Claude hooks, skills, or session
    state, and leaves existing provider wiring unchanged.
  - Final pass binds a disposable isolated environment, exact released nils
    artifacts, and authorized semantic commit plus no-merge PR delivery to one
    run, repository, and head with provider read-back.
  - Security and failure-path scenarios fail closed as specified.
- **Validation**:
  - full acceptance runner and retained summary
  - specialist review across all required lenses

### Task 6.2: Activate the local DSH profile reversibly

- **Location**: user-owned DSH configuration and machine-local runtime surfaces
- **Description**: save an exact rollback point for the native `headless` profile,
  install the approved package and released nils-cli, copy the DSH-only
  hook policy and agent-docs catalog into owner-only roots, bind every
  hook/docs config-policy-state path explicitly, optionally enable a separately
  selected DSH private loader path, and verify from a fresh DSH process without
  changing Codex or Claude Code wiring.
- **Dependencies**: Task 6.1
- **Complexity**: 8
- **Acceptance criteria**:
  - Fresh DSH sessions load the intended public and project surfaces, plus a
    private surface only when an explicit DSH-only projection is configured.
  - The DSH process/configuration resolves no `agent-runtime-kit` hook, skill,
    session state, package, or product.
  - Every agent-hook dispatch, finish-line, and doctor call resolves the copied
    DSH config/policy/state, and agent-docs resolves the copied DSH catalog/state;
    ambient provider/XDG fallback is rejected.
  - No Codex/Claude private bundle is implicitly migrated; the DSH private root
    may remain absent or empty until an explicit DSH projection is selected.
  - Codex and Claude Code configuration and runtime sentinels are unchanged.
  - Rollback evidence exists before activation and can restore only the DSH
    profile without affecting another runtime.
- **Validation**:
  - post-cutover doctor and fresh-process smoke
  - exact DSH configuration plus Codex/Claude preservation inventory

### Task 6.3: Prove coexistence isolation and close dispatch

- **Location**: DSH profile, provider-wiring audit, and dispatch issue
- **Description**: prove DSH has zero dependency on `agent-runtime-kit`, prove
  Codex/Claude wiring and state remain active and unchanged, then run strict
  close-ready, provider read-back, and archive handoff for this dispatch only.
- **Dependencies**: Task 6.2
- **Complexity**: 7
- **Acceptance criteria**:
  - DSH-profile active-reference audit returns zero `agent-runtime-kit`
    dependencies.
  - Codex and Claude Code continue to resolve `agent-runtime-kit` plus nils-cli.
  - Hooks, skills, sessions, and runtime homes do not cross-load across DSH,
    Codex, and Claude Code.
  - Every task, PR, review, validation, acceptance, and integration gate is
    visible and close-ready reports no blocker.
- **Validation**:
  - DSH zero-dependency and three-runtime cross-loading audits
  - `plan-issue tracking close-ready --profile dispatch --expect-visible`
  - closeout provider read-back and record audit
