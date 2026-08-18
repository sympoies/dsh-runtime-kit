# Execution State: Replace agent-runtime-kit with DSH Runtime Kit

## Execution State

- Source document: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md`
- Plan: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/1>
- Profile: dispatch
- Plan branch: `feat/dsh-runtime-migration-plan`
- Current sprint: Sprint 2
- Status: in-progress
- Current task: 2.1 Add the bounded lifecycle compatibility layer
- Next task: 2.2 Implement selective runtime context
- Integration checkout: managed lane `feat/lifecycle-compat`
- Blockers: none
- Last updated: 2026-08-18

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Initialize dispatch record and plan branch | done | public `sympoies/dsh-runtime-kit`; local validated bundle pending; plan commit 5f8fb78; public issue #1; run 20260817T230951Z-issue-1 | Validated, published, and initialized |
| 1.2 | Deliver external bundle and skills baseline | done | dsh-runtime-kit PR #2; squash `aef980293d48eac03e293acfca0d5562041b29e5`; 26/26 tests; packed real DSH rc.7 smoke | External bundle, private loader, and skill precedence integrated |
| 1.3 | Deliver strict nils-cli DSH ingress | done | nils-cli PR #1465; squash `5937233a87b88f8afa4e00ba550124176be837c2`; exact-head Linux/macOS/coverage/cargo-deny/CodeQL | Strict ingress and native allow/block decision merged to nils-cli `main` |
| 2.1 | Add bounded lifecycle compatibility layer | in-progress | managed lane `feat/lifecycle-compat`; 53/53 tests; packed real rc.7 smoke; API/performance/security review pass | Validated locally; PR delivery pending |
| 2.2 | Implement selective runtime context | pending | pending | DSH + nils contract lane |
| 2.3 | Replace validation wrappers with result-driven finish-line | pending | pending | nils capability plus DSH adapter |
| 3.1 | Freeze parity inventory and capability groups | pending | pending | Exhaustive 101-rule/22-handler disposition |
| 3.2 | Port Git, delivery, scope, and edit-admission policies | pending | pending | Deterministic nils capability lane |
| 3.3 | Port privacy, memory, reminder, and portable-output policies | pending | pending | Deterministic nils capability lane |
| 3.4 | Port coordination and operation lifecycle | pending | pending | Deterministic nils capability lane |
| 3.5 | Remove legacy handler execution from production | pending | pending | No active parity row pending |
| 4.1 | Implement reviewer personas and selection tool | pending | pending | One tool, eight personas |
| 4.2 | Enforce reviewer read-only authority | pending | pending | Policy-enforced, not prompt-only |
| 5.1 | Add setup, doctor, update, rollback, and remove | pending | pending | Exact owned-state operations |
| 5.2 | Add upstream compatibility and performance gates | pending | pending | Pinned + upstream-next |
| 6.1 | Run complete real-session acceptance matrix | pending | pending | No legacy runtime execution |
| 6.2 | Cut over local runtime | pending | pending | Fresh authorization gates still apply |
| 6.3 | Retire active old runtime and close dispatch | pending | pending | Zero active references required |

## Validation Log

- 2026-08-18: The maintainer selected a public repository, private loader-only
  boundary, no DSH fork, complete old-runtime replacement, phased PR delivery,
  and subagent delegation.
- 2026-08-18: `sympoies/dsh-runtime-kit` was created as a public GitHub
  repository with `main` as its default branch.
- 2026-08-18: A prototype package installed and booted on unmodified DSH
  `0.1.0-rc.7`. Its real smoke returned `41 -> 42`, policy allow/block behaved
  before the tool body, and 31 visible skills proved project/private/bundled
  precedence.
- 2026-08-18: Prototype unit tests passed 10/10. Focused security and testing
  follow-up reviews cleared the private-root, public-profile, resource-closure,
  standard-provider, private-precedence, and block-before-body findings.
- 2026-08-18: The current nils-cli prototype passed the full
  `cargo test -p nils-agent-hook` suite before dispatch conversion. Its final
  lane must rerun the declared repository gates from a managed worktree.
- 2026-08-18: The legacy rule source currently contains 101 total rules, 69
  `runtime-kit.handler.v1` registrations, and 22 distinct handler IDs. Its
  declared legacy subset remains 67 registrations and 21 handlers because two
  memory-start registrations are non-legacy additions; parity must inventory
  actual rule rows instead of treating the legacy counters as the total.
- 2026-08-18: DSH baseline PR #2 merged to the plan branch as `aef9802` after
  26/26 tests, package validation, and a real unmodified DSH `0.1.0-rc.7`
  allow/deny/private-skill smoke.
- 2026-08-18: nils-cli PR #1465 merged to `main` as `5937233a` after six
  exact-head specialist passes, zero unresolved threads, a zero-blocker review
  ledger, and successful Linux, macOS, coverage, cargo-deny, and CodeQL jobs.
- 2026-08-18: Task 2.1 defines lifecycle context as bounded
  session/cwd/turn/step/call correlation. Model-facing selective context and
  `decision.context.v1` remain owned by Task 2.2; the strict nils DSH ingress
  v1 wire contract is unchanged.
- 2026-08-18: Task 2.1 test-first execution ran the focused abort, disposal,
  and rc.7 lifecycle cases before production edits: 0 passed and 3 failed. The
  failures proved early abort settlement, missing active-child disposal, and
  only two of the six required lifecycle extensions in the baseline.
- 2026-08-18: The converged Task 2.1 lane passed 53/53 package tests, strict
  JavaScript type-checking, package dry-run inspection, and the packed real DSH
  rc.7 smoke against the clean `99f6f02` checkout. The smoke proved `41 -> 42`,
  native allow/block, six lifecycle boundaries, rejected/closed lifecycle
  denial, exact execution correlation, mutation/replay guards, and bounded
  cancellation plus plugin-disposal quiescence.
- 2026-08-18: Task 2.1 review reproduced and repaired mutable arguments,
  Agent, Session, parent, signal, and token substitution; token replay; stale
  pre-step state; unbounded teardown; stale approval authorization after
  transport degradation; and repeated open-step history scans. Exact
  `0.1.0-rc.7` DSH peer pins and the trusted in-process plugin boundary are now
  explicit. Affected API, performance, security, testing, maintainability, and
  red-team follow-ups converged with no remaining finding.

## Decision Log

- Use one shared dispatch issue and independently reviewed PR lanes.
- Keep DSH repository lane PRs based on the plan branch; deliver the nils-cli
  dependency as a linked PR to that repository's `main`.
- Do not fork DSH, copy its standard preset, or patch installed dependencies.
- Keep deterministic policy in nils-cli; TypeScript owns transport and native
  lifecycle composition only.
- Do not retain Python handler execution in production. Parity fixtures may
  compare old outcomes until the typed replacement is complete.
- Keep the old runtime active until complete acceptance and cutover evidence;
  archive it only after an active-reference audit returns zero.

## Handoff

Deliver the validated Task 2.1 `feat/lifecycle-compat` lane to the plan branch,
then begin Task 2.2 in a fresh managed lane. Keep model-facing selective context
and `decision.context.v1` outside the strict Task 2.1 ingress contract.
