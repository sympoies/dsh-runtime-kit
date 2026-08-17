# Execution State: Replace agent-runtime-kit with DSH Runtime Kit

## Execution State

- Source document: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md`
- Plan: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/1>
- Profile: dispatch
- Plan branch: `feat/dsh-runtime-migration-plan`
- Current sprint: Sprint 1
- Status: in-progress
- Current task: Tasks 1.2 and 1.3 in parallel
- Next task: 2.1 Add the bounded lifecycle compatibility layer
- Integration checkout: managed plan worktree
- Blockers: none
- Last updated: 2026-08-18

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Initialize dispatch record and plan branch | done | public `sympoies/dsh-runtime-kit`; local validated bundle pending; plan commit 5f8fb78; public issue #1; run 20260817T230951Z-issue-1 | Validated, published, and initialized |
| 1.2 | Deliver external bundle and skills baseline | pending | local prototype; real DSH smoke receipt | DSH repo lane PR to plan branch |
| 1.3 | Deliver strict nils-cli DSH ingress | pending | local test-first nils changes | Cross-repo dependency PR to nils-cli main |
| 2.1 | Add bounded lifecycle compatibility layer | pending | pending | DSH repo lane |
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

Run Tasks 1.2 and 1.3 in parallel managed worktrees with distinct writers.
Each writer stops after delivering its PR and recording validation evidence;
the orchestrator assigns independent review and owns all integration.
