# Execution State: dsh-TUI 0.10.0-beta.2 to beta.3 Promotion

## Execution State

- Source document: `docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/147>
- Profile: tracking
- Plan branch: `feat/dsh-tui-beta3-compat`
- Current sprint: complete
- Status: complete
- Current task: none
- Next task: none
- Integration checkout: managed non-default worktree
- Blockers: none
- Last updated: 2026-09-01

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Freeze the baseline and initialize tracking | done | Baseline runtime-kit `b7ea2ecd`; TUI `0.9.3`; DSH `0.1.1-rc.2` at `b150a551`; nils-cli `1.27.27`; Node `26.7.0` in the deployed infra contract; Issue #147 opened with source/plan/state lifecycle; bundle validation passed; managed worktree at baseline b7ea2ecd | Tracker initialized and visible; plan bundle validated |
| 1.2 | Capture the compatibility RED and promote the exact artifact | done | RED: nine focused failures rejected the 0.9.3 contract; beta.2 npm/source digests authenticated; downstream history patch rebased with 0700/0600 modes; focused tests 19/19; full suite 739/739; exact Node 24 rc.2 keyless smoke passed; reverse restored pristine source and clean unpatched rebuild/startup passed | Exact beta.2 compatibility contract complete |
| 1.3 | Validate, review, deliver, and merge runtime-kit | done | PRs #149 and #150 merged the beta.2 contract and complete Cordis repair; PR #152 merged beta.3 at `6e78fa69`; 19/19 focused tests, 739/739 full tests, type checking, patch apply/reverse, and keyless Agent Console smoke passed | Runtime compatibility owner merged before infra selected it |
| 2.1 | Update and deliver the infra Agent Console contract | done | Infra PRs #443, #445, #446, #448, #450, #451, and #452 merged the beta.3 graph, stale-lock cleanup, inspector readiness repairs, and eight-package atomic overlay; #454 corrected the runbook | Final infra main `a0c574c2` documents and selects the merged beta.3 runtime |
| 2.2 | Deploy sympoies, deploy m4, prove rollback, and close | done | Sympoies and m4 report beta.3 with healthy receipts and smoke; sympoies successfully rolled back to beta.2 and restored beta.3; all eight live session identities and incarnations survived | Provider tracker can close after this state lands |

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
- 2026-08-31: Beta.3 superseded beta.2 before production activation. Its
  dependencies and every Cordis/history patch-owned byte are identical to
  beta.2, so the final target moved directly to beta.3 while beta.2 remains an
  authenticated rollback release.
- 2026-08-31: Beta.3 passes 19/19 focused tests, the complete 739-test suite,
  strict typechecking, authenticated package apply/reverse, and the keyless
  DSH rc.2 Agent Console smoke with all TUI-specific receipt markers true.
- 2026-09-01: Runtime-kit PR #152 merged beta.3 at `6e78fa69`. Infra then
  merged the exact graph and the deployment repairs discovered by fail-closed
  live provisioning through PRs #443, #445, #446, #448, #450, #451, and #452.
- 2026-09-01: Sympoies passed the complete edge smoke on beta.3. A rollback
  artifact retained current provisioning while selecting the authenticated
  beta.2 contract; root/profile read-back, runtime-kit receipt, and edge smoke
  passed before beta.3 was restored and revalidated.
- 2026-09-01: All eight live sympoies sessions retained the same IDs and
  incarnation IDs across rollback and restoration. m4 had no live sessions and
  passed its canonical beta.3 apply/check flow.

## Acceptance Evidence

- Baseline runtime-kit head: `b7ea2ecdeadd9629ce6c2394878db73beb0cc227`
- Baseline TUI: `@deepseek-harness-tui/dsh-tui@0.9.3`
- Baseline DSH: `0.1.1-rc.2` at
  `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Baseline nils-cli: `1.27.27`
- Candidate TUI source: lightweight tag `v0.10.0-beta.3` at
  `470997e848a92f0c57aacbc4d05b8f9eda667d94`
- Candidate npm integrity:
  `sha512-V9aB+rAekEHMVGch8s/2epVc1kp8YSceQuxcbhvBmJp3ta/9gLFpFOFOalrmbI7ZpcUEi6qj1B12/l9GZyhVQQ==`
- Candidate npm shasum: `f79537b012ffc690f9cc540c29d339aea727eeb3`
- Complete runtime-kit suite: 739/739 tests
- Merged runtime-kit compatibility PR: #152 at `6e78fa699c0fb54da005f4e913fd4a86648cea34`
- Merged infra closeout: PR #454 at `a0c574c21cd72b1ad83ea510f7f7c3675854d406`
- Exact Agent Console smoke: passed with artifact, patch, startup, history
  lock, code mode, runtime tool pipeline, and runtime isolation verified
- Live fleet read-back: beta.3 on sympoies and m4; beta.2 rollback and beta.3
  restoration proven on sympoies with eight live sessions preserved
- Clean unpatched DSH build closure SHA-256:
  `218ad630ff2803da623494d8ab4e05fd6469ac1bf835f325f5b7d972b7f824dd`
