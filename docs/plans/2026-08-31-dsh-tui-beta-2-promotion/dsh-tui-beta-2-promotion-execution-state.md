# Execution State: dsh-TUI 0.10.0-beta.2 Promotion

## Execution State

- Source document: `docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/147>
- Profile: tracking
- Plan branch: `feat/dsh-tui-beta-2-promotion`
- Current sprint: Sprint 1
- Status: in-progress
- Current task: Task 1.3
- Next task: Task 2.1 after the runtime-kit PR merges
- Integration checkout: managed non-default worktree
- Blockers: none
- Last updated: 2026-08-31

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Freeze the baseline and initialize tracking | done | Baseline runtime-kit `b7ea2ecd`; TUI `0.9.3`; DSH `0.1.1-rc.2` at `b150a551`; nils-cli `1.27.27`; Node `26.7.0` in the deployed infra contract; Issue #147 opened with source/plan/state lifecycle; bundle validation passed; managed worktree at baseline b7ea2ecd | Tracker initialized and visible; plan bundle validated |
| 1.2 | Capture the compatibility RED and promote the exact artifact | done | RED: nine focused failures rejected the 0.9.3 contract; beta.2 npm/source digests authenticated; downstream history patch rebased with 0700/0600 modes; focused tests 19/19; full suite 739/739; exact Node 24 rc.2 keyless smoke passed; reverse restored pristine source and clean unpatched rebuild/startup passed | Exact beta.2 compatibility contract complete |
| 1.3 | Validate, review, deliver, and merge runtime-kit | in-progress | PR #149 open; testing, maintainability, and performance passed; security and red-team confirmed the legacy history-mode gap; read-first repair passes 739/739 tests, type checking, exact Node 24 beta.2 smoke, and rollback rebuild/startup | Final follow-up review and merge remain |
| 2.1 | Update and deliver the infra Agent Console contract | pending | none | Starts only from the merged runtime-kit identity |
| 2.2 | Deploy sympoies, deploy m4, prove rollback, and close | pending | none | Depends on the merged infra contract |

## Validation Log

- 2026-08-31: Evaluation confirmed runtime-kit owns the exact TUI artifact,
  installed-package patch, and Agent Console composition smoke; infra owns the
  deployed runtime-kit and TUI selection.
- 2026-08-31: dsh-TUI 0.10.0-beta.2 supersedes beta.1 and fixes its startup
  crash. The npm artifact supports the deployed Node 26 and DSH rc.2 lines.
- 2026-08-31: The upstream nonblocking history-lock PR remains open and the
  beta.2 artifact still contains synchronous lock waits. The downstream patch
  must be rebased while preserving beta.2's new 0600/0700 data permissions.
- 2026-08-31: The beta.2 tag is a lightweight tag at
  `655c0f16088879890d9c6ce5d160651433223e09`; there is no annotated tag
  object to record.
- 2026-08-31: The implementation checkout was created as the managed
  `feat/dsh-tui-beta-2-promotion` worktree from current `origin/main`
  `b7ea2ecdeadd9629ce6c2394878db73beb0cc227`.
- 2026-08-31: The compatibility RED produced nine focused failures against
  the prior 0.9.3 contract. The beta.2 implementation then passed 19 focused
  tests and the complete 739-test suite.
- 2026-08-31: The first exact-profile smoke exposed a duplicate code-runtime
  owner because beta.2 adds the scoped `dsh-tui-code-runtime` row. The smoke
  overlay now disables that scoped row before inserting its own test runtime.
- 2026-08-31: The exact beta.2 profile passed the Node 24 keyless smoke against
  pristine DSH rc.2 and released nils-cli 1.27.27. Reverse, clean rebuild, CLI
  startup, and source-status verification restored the pristine identity.
- 2026-08-31: Security review found that beta.2 creation modes did not migrate
  retained 0.9.3 history paths. Red-team review confirmed the finding and no
  additional material risk. The bounded repair restricts owner-owned regular
  paths before both the synchronous read and asynchronous append paths, refuses
  symlinks and unexpected ownership or types, and preserves legacy entries. The
  final repair passes 19/19 focused tests, 739/739 full tests, the exact Node 24
  beta.2 smoke, and a clean unpatched rollback rebuild and CLI startup.

## Acceptance Evidence

- Baseline runtime-kit head: `b7ea2ecdeadd9629ce6c2394878db73beb0cc227`
- Baseline TUI: `@deepseek-harness-tui/dsh-tui@0.9.3`
- Baseline DSH: `0.1.1-rc.2` at
  `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Baseline nils-cli: `1.27.27`
- Candidate TUI source: lightweight tag `v0.10.0-beta.2` at
  `655c0f16088879890d9c6ce5d160651433223e09`
- Candidate npm integrity:
  `sha512-qWuTmsjNJp4rUxLePZdKXMp9mHs2wLEtMnED+ayd+fgmppYvf9AU2btNW7Nb4oHN6lvcsx+PqK795nFJ3Sgsyg==`
- Candidate npm shasum: `dd5d0cc8233bd9266c3d2ff97d30ad34bc37455e`
- Complete runtime-kit suite: 739/739 tests
- Exact Agent Console smoke: passed with artifact, patch, startup, history
  lock, code mode, runtime tool pipeline, and runtime isolation verified
- Clean unpatched DSH build closure SHA-256:
  `218ad630ff2803da623494d8ab4e05fd6469ac1bf835f325f5b7d972b7f824dd`
