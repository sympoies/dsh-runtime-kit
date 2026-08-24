# Runtime-Owned Native Workspace Identity And Cross-Session Leases Implementation Handoff

## Status

- Date: 2026-08-24
- Source: dsh-runtime-kit issues #56 and #66
- Status: ready for tracked implementation
- Intended next step: execute the linked L2 plan and accept #56 before #55 starts

## Purpose

Move workspace identity and mutation ownership from prompt instructions,
environment reconstruction, and ad hoc runtime-kit coordination into one
runtime-kit-owned plugin executing inside DSH through existing public
extension interfaces. The result must let the host bind a live session to an
opaque canonical workspace and let nils-cli make durable repository and lease
decisions without creating a second JavaScript policy engine or modifying the
official Harness.

## Confirmed facts

- DSH owns Agent, Session, cwd, tool execution, sandbox, subagent, cancellation,
  resume, and disposal lifecycles.
- The current runtime-kit obtains related facts through session environment,
  policy ingress, checkout leases, owner and semantic-conflict projections,
  operation admission, and a liveness bridge.
- nils-cli already owns deterministic Git/worktree inspection and the durable
  policy state used by supported agent runtimes.
- Runtime-kit supports DSH 0.1.0-rc.7, 0.1.0-rc.8, and 0.1.1-rc.2. Compatibility
  adapters must stay isolated while the first-party seam is unavailable in a
  supported release.
- The umbrella tracker #66 requires one issue at a time. #55 cannot begin until
  this issue has passed post-merge deployment and rollback acceptance.

## Decisions

- dsh-runtime-kit will expose a versioned WorkspaceRef and WorkspaceLease
  service as a Cordis plugin using DSH's existing public lifecycle, session,
  tool, and service interfaces. It will not open an upstream DSH PR, fork the
  Harness, patch released DSH packages on the accepted path, or use private
  imports.
- WorkspaceRef is opaque and non-bearer. The model and ordinary tool arguments
  cannot manufacture, select, or retarget authority.
- DSH supplies authoritative host lifecycle and tool-pipeline facts. The
  runtime-kit plugin owns their exact workspace binding and consumer
  integration. nils-cli owns canonical repository inspection, cross-process
  lease persistence, conflict classification, stale recovery, fencing, and
  stable reason codes.
- Mutation claims bind the exact Agent, Session, tool execution, workspace
  generation, and canonical path scope.
- Partial, foreign-active, dirty, uncertain, unavailable, replayed, or stale
  authority fails closed. Fully unmanaged operation follows one explicit
  compatibility outcome rather than silently acquiring a managed lease.
- Lifecycle transitions renew and release leases. Model-authored heartbeats and
  shell commands are not part of the success path.
- The accepted implementation becomes the sole baseline for #55;
  release-specific runtime-kit adapters may adapt public DSH differences but
  cannot define a competing identity.
- A DSH source patch is only a documented escape hatch. It requires a
  reproducible packed-profile proof that a named public seam is insufficient,
  exact version and source-digest binding, deterministic apply and reverse
  checks, and an explicit Gate 0 amendment to #56 and #66 before production
  edits. A growing or cross-package patch must be reconsidered as a separately
  authorized downstream distribution rather than hidden in this plan.

## Scope

- A runtime-kit-owned DSH/Cordis service and provider definition for workspace
  identity and lease lifecycle.
- Session, resume, tool, subagent, cancellation, and disposal integration.
- A nils-cli wire contract and durable cross-process lease backend.
- A dsh-runtime-kit compatibility adapter and migration boundary.
- Unit, integration, restart, concurrency, packed-profile, real-session,
  upgrade, and rollback validation.
- Candidate and post-merge deployment through the public profile/package path.

## Non-scope

- Commit, signing, branch, PR, merge, or default-delivery policy; #55 owns the
  governed commit consumer.
- An upstream DSH change, maintained DSH fork, released-package patch on the
  accepted path, or a JavaScript copy of Git and lease policy.
- Treating cwd, environment variables, prompt text, paths supplied by the model,
  or a copied opaque identifier as authority.
- Replacing OS sandboxing, Git provider protection, or repository-specific
  workflow policy.

## Implementation boundaries

### DeepSeek Harness public substrate

- Supply the released public Agent, Session, tool-pipeline, lifecycle, Cordis
  service, and plugin interfaces without source modification.

### dsh-runtime-kit

- Define WorkspaceRef, WorkspaceLease, provider, state, and typed error
  contracts as a runtime-owned Cordis plugin.
- Bind the exact workspace at public session-start/resume lifecycle boundaries.
- Publish scoped lifecycle operations to tools and agents without exposing
  provider tokens to model context.
- Renew, cancel, reconcile, and release leases through public host events.
- Isolate supported-release adapters and prove the installed packed artifact
  uses no DSH source patch or private module.

### nils-cli

- Canonicalize Git repositories and linked worktrees across relative paths,
  aliases, and symlinks.
- Persist cross-process ownership with revision/generation fencing and
  idempotent begin, complete, reconcile, renew, and release operations.
- Distinguish owned, foreign-active, stale-clean, dirty, uncertain, and
  unavailable states with stable diagnostics.
- Prove safe stale-clean reclamation and deny dirty or unknown recovery.

## Requirements

1. Canonical identity is stable for equivalent path spellings and different for
   distinct linked worktrees of the same repository.
2. A mutation lease is admitted before the tool body and cannot be widened or
   replayed by another session, child, call, generation, or process.
3. Distinct worktrees may mutate concurrently; the same worktree may not.
4. Session disposal releases only operations and leases owned by that exact
   session incarnation.
5. Crash recovery is durable across host restarts and reclaims only a stale,
   clean owner through one deterministic path.
6. Duplicate and reordered lifecycle messages are idempotent and fenced.
7. Unsupported providers and partial identity fail before mutation.
8. Existing supported DSH releases retain an explicit compatibility behavior,
   and the manifest pins every version actually tested.

## Acceptance criteria

- Two real DSH sessions targeting one disposable managed worktree demonstrate
  first-writer admission and pre-body denial of the second mutation.
- Two sessions targeting separate managed worktrees of one repository mutate
  concurrently without false conflict.
- Relative cwd, symlink alias, Git -C, and canonical path spellings resolve to
  the same WorkspaceRef without trusting model input.
- Copied WorkspaceRef, lease token, operation receipt, and stale generation
  cannot authorize another session.
- Cancellation and disposal drain exact operations and do not release another
  owner's lease.
- Cross-process restart tests prove the durable provider, stale-clean recovery,
  dirty/active/unknown refusal, and duplicate-message idempotence.
- A packed runtime-kit artifact installs into a clean DSH profile and an
  isolated canary, then executes the issue-specific real-session matrix.
- The same immutable merged artifacts pass the supported DSH compatibility
  matrix, upgrade from the recorded baseline, and rollback to it.
- Provider-visible evidence contains immutable identities and results but no
  credentials, private topology, or raw machine-local paths.

## Validation plan

- dsh-runtime-kit focused unit and integration suites for service definition,
  session and agent binding, opacity, replay, cancellation, restart, and
  disposal against public DSH packages.
- nils-cli focused tests for canonical worktree identity, cross-process
  contention, fencing, reconciliation, stale-clean recovery, and fail-closed
  dirty/unknown states.
- dsh-runtime-kit regression tests for provider registration, compatibility,
  lifecycle mapping, no prompt-side identity choreography, and typed failures.
- Runtime-kit typecheck, policy source verification, package inspection, and
  full package tests.
- Keyless packed smoke against every release in compatibility/dsh.json with
  matching nils-cli binaries from one immutable identity.
- Clean-profile install, isolated-canary real session, upgrade, rollback, and
  post-merge repeat as required by #66 Gates 2 through 5.

## Risks and guardrails

- Canonicalization bugs can merge distinct worktrees or split aliases of one
  worktree. Tests must include symlinks, relative paths, linked worktrees, and
  repository metadata drift.
- Process-local caches can appear correct in unit tests while failing after a
  restart. Acceptance requires independent processes and a durable backend.
- An opaque identifier can accidentally become a bearer token. Every consumer
  must rebind it to authenticated host context.
- Compatibility adapters can become permanent policy owners. Each adapter must
  name the native replacement and retirement condition.
- Treating a source patch as easier than an explicit fork can hide downstream
  distribution ownership. The accepted path remains public plugin integration;
  the patch escape hatch cannot activate without a recorded Gate 0 redesign.

## Execution

Recommended plan: docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-plan.md

Recommended execution state: docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-execution-state.md

- Profile: tracking
- Owner issue: https://github.com/sympoies/dsh-runtime-kit/issues/56
- Umbrella tracker: https://github.com/sympoies/dsh-runtime-kit/issues/66
- Retention: archive with the closed issue after acceptance; promote shipped
  contracts into normative architecture and compatibility documentation.

## Read first

- Issue #56 for the provider-visible capability and acceptance contract.
- Issue #66 for mandatory serial ordering and deployment gates.
- docs/architecture.md for the current DSH/runtime-kit/nils-cli ownership split.
- compatibility/dsh.json and compatibility/nils-cli.json for the accepted
  baseline identities.
