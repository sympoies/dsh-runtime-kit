# Execution State: First-Party Workspace Identity And Cross-Session Leases

## Execution State

- Source document: `docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-discussion-source.md`
- Plan: `docs/plans/2026-08-24-first-party-workspace-leases/first-party-workspace-leases-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/56>
- Umbrella tracker: <https://github.com/sympoies/dsh-runtime-kit/issues/66>
- Profile: tracking
- Plan branch: `feat/issue-66-native-dsh-convergence`
- Current sprint: Sprint 1
- Status: in-progress
- Current task: Task 1.3
- Next task: Task 1.4
- Integration checkout: managed non-default worktree
- Blockers: none
- Last updated: 2026-08-24

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Freeze the accepted baseline and initialize tracking | done | runtime-kit origin/main `801ea88`; package SHA-256 `0c6c8f1369b1088d08d641a11f9b7b5113354ecf2ae482de34045d9a2b0e4570`; DSH `0.1.1-rc.2` at `b150a551`; nils-cli `1.27.4` at `389580b8`; plan commit `3ee1265` | Provider-visible lifecycle attached and reconciled; the real packed smoke captures the initial failing regression before production edits |
| 1.2 | Add the runtime-owned native workspace capability | done | Signed runtime commit `54fe5b51`; smoke fix `d770694a`; devlog `22c5316a`; focused 32/32 and full 383/383; packed rc.7/rc.8/rc.2 lifecycle matrix; artifact SHA-256 `69cfc91ddcefd677bd9ee22af27677de3069ab7ce02eb267ed2240bf1c5977f8` | Public Cordis/DSH interfaces only; exact final-guard marker; capability remains dormant until Task 1.4 |
| 1.3 | Add nils-cli canonical identity and durable lease policy | in-progress | Task 1.2 protocol v1 frozen at `54fe5b51` | Implement only in the clean managed nils-cli worktree; do not duplicate Git or lease policy in JavaScript |
| 1.4 | Integrate the native capability through runtime-kit | pending |  | No duplicate Git or lease policy in JavaScript |
| 1.5 | Review and deploy the immutable candidate | pending |  | Requires all linked PR heads and pre-merge deployment |
| 1.6 | Merge, redeploy, promote, and close #56 | pending |  | Updates #66 only after post-merge deployment and rollback pass |

## Validation Log

- 2026-08-24: #66 was reconciled as an umbrella issue with no lifecycle
  comments. It remains the serial program tracker; #56 is the first and only
  eligible child.
- 2026-08-24: The runtime-kit managed worktree started from current origin/main
  `801ea88`. The primary checkout remained unchanged and two commits behind.
- 2026-08-24: Current compatibility manifests select DSH 0.1.1-rc.2 revision
  `b150a551` and validated nils-cli release 1.27.4 source commit `389580b8`.
- 2026-08-24: A package built from the immutable runtime-kit tree contained
  1,158 entries, had unpacked size 7,620,979 bytes, and SHA-256
  `0c6c8f1369b1088d08d641a11f9b7b5113354ecf2ae482de34045d9a2b0e4570`.
- 2026-08-24: Runtime-kit unit tests passed 351/351; typecheck and policy-source
  parity passed against nils-cli source commit `79d6b93f`. DSH rc2 dependency
  installation and the complete host/client/web build passed in the
  repository-defined `CI=true` non-interactive mode.
- 2026-08-24: The clean-profile packed smoke installs and composes the bundle,
  then fails its first real agent turn before any model or tool call. The rc2
  session records `turn/start` and `turn/end` only because the main-agent
  pre-step bridge classifies partial ambient `AGENT_SESSION_*` sentinel values
  as a managed controller and rejects failed readiness. This is the initial
  behavior regression for Task 1.2/1.4; no production file has been edited.
- 2026-08-24: Production audit found unused bundled `js-yaml@4.1.0` with one
  high-severity finding. It has no repository import and is isolated as #68,
  outside this capability candidate, with packed deployment and rollback
  acceptance of its own.
- 2026-08-24: The local nils-cli primary checkout contains unrelated user
  changes and will not be used for implementation; a separate managed worktree
  is required.
- 2026-08-24: The owner rejected an upstream DSH PR and did not authorize a
  maintained fork. Architecture was reset at Gate 0: #56 will ship a
  runtime-kit-owned Cordis/DSH plugin using only existing public Agent, Session,
  tool lifecycle, event, and service entrypoints. The isolated DSH prototype
  passed 9 focused tests but remains uncommitted and will not be pushed or
  delivered.
- 2026-08-24: A DSH source patch remains only a gated escape hatch. It requires
  a packed-profile reproduction proving a named public seam is insufficient,
  exact version/source digests, deterministic apply/reverse and rollback
  acceptance, plus an explicit #56/#66 Gate 0 amendment before any patch edit.
- 2026-08-24: Task 1.2 shipped the dormant runtime-owned WorkspaceLease
  protocol through signed commit `54fe5b51`. Provider classification covers
  both downstream `allow` and approval-pending `ask`; DSH's public monotonic
  guard consumes one exact execution marker immediately before dispatch.
- 2026-08-24: Focused workspace tests passed 32/32 and the full repository
  suite passed 383/383 with typechecking and 101-rule parity. Clean packed DSH
  profiles at rc.7 `99f6f02f`, rc.8 `141eb6fe`, and rc.2 `b150a551` each
  observed `bind -> begin -> body -> complete:succeeded -> release`, `owned`
  state, and an opaque reference. All source checkouts remained clean.
- 2026-08-24: The Task 1.2 artifact at `22c5316a` contained 1,164 entries and
  had SHA-256 `69cfc91ddcefd677bd9ee22af27677de3069ab7ce02eb267ed2240bf1c5977f8`.
  The temporary rc.8 validation worktree was removed after acceptance.

## Acceptance Evidence

- Baseline package digest: SHA-256
  `0c6c8f1369b1088d08d641a11f9b7b5113354ecf2ae482de34045d9a2b0e4570`
- DSH profile schema and clean-profile result: native DSH profile manifest with
  ordered `dsh.profile.bundles`; installation and composition pass, real turn
  fails at the initial managed-controller pre-step regression
- Task 1.2 runtime contract: signed `54fe5b51`; focused 32/32; full 383/383;
  packed rc.7/rc.8/rc.2 tool lifecycle pass; artifact SHA-256
  `69cfc91ddcefd677bd9ee22af27677de3069ab7ce02eb267ed2240bf1c5977f8`
- Candidate deployment: pending
- Post-merge deployment: pending
- Real-session two-worktree matrix: pending
- Upgrade and rollback: pending
- Linked PRs and reviews: pending
- Residual risk: unused vulnerable bundled dependency tracked separately in
  <https://github.com/sympoies/dsh-runtime-kit/issues/68>
