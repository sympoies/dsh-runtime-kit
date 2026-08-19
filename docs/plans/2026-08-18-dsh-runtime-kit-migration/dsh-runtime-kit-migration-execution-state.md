# Execution State: Add DSH Runtime Kit Alongside Existing Provider Runtimes

## Execution State

- Source document: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md`
- Plan: `docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/1>
- Profile: dispatch
- Plan branch: `feat/dsh-runtime-migration-plan`
- Coexistence boundary: agent-runtime-kit remains active for Codex and Claude
  Code; only the DSH profile uses dsh-runtime-kit
- Current sprint: Sprint 6
- Status: in-progress
- Current task: 6.1 Run complete real-session acceptance matrix
- Next task: 6.2 Activate the local DSH profile after Task 6.1 promotion
- Integration checkout: managed lane `feat/native-runtime-integrated`
- Blockers: final run-correlated hosted acceptance remains; nils-cli v1.27.0 is
  released and artifact-pinned
- Last updated: 2026-08-20

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Initialize dispatch record and plan branch | done | public `sympoies/dsh-runtime-kit`; local validated bundle pending; plan commit 5f8fb78; public issue #1; run 20260817T230951Z-issue-1 | Validated, published, and initialized |
| 1.2 | Deliver external bundle and skills baseline | done | dsh-runtime-kit PR #2; squash `aef980293d48eac03e293acfca0d5562041b29e5`; 26/26 tests; packed real DSH rc.7 smoke | External bundle, private loader, and skill precedence integrated |
| 1.3 | Deliver strict nils-cli DSH ingress | done | nils-cli PR #1465; squash `5937233a87b88f8afa4e00ba550124176be837c2`; exact-head Linux/macOS/coverage/cargo-deny/CodeQL | Strict ingress and native allow/block decision merged to nils-cli `main` |
| 2.1 | Add bounded lifecycle compatibility layer | done | dsh-runtime-kit PR #3; squash `ba15a9c1e4b14b97091a60bfb927b1b1c5855b65`; 53/53 tests; packed real rc.7 smoke; converged review ledger | Full lifecycle correlation and bounded fail-closed transport integrated |
| 2.2 | Implement selective runtime context | done | nils-cli PR #1466; dsh-runtime-kit draft PR #4; managed lane `feat/selective-runtime-context`; clean rc.7 smoke; public `Product` remains the compatible three-variant 1.x enum | DSH is an isolated internal catalog view and CLI-private selector; no nils 2.0 boundary is required |
| 2.3 | Replace validation wrappers with nils-executed finish-line | done | nils 31-test focused finish-line suite; DSH 99/99 plus typecheck; create-dispose-resume packed rc.7 smoke; security, maintainability, and API-contract reviews clean | Every foreground Bash call is nils-supervised; retry-safe sequence-bound incarnations, stable-identity release barriers, trusted crash-orphan recovery, quiesce-before-release teardown, sealed descriptor-bound runner, pidfd supervisor watch, and private failed-run quiesce fail closed before exact evidence may satisfy stop |
| 3.1 | Freeze parity inventory and capability groups | done | frozen public `policy/rule-parity.yaml`; internal `policy/runtime-rule-parity.yaml`; canonical Git-object verifier; DSH 102/102; nils 23-group schema tests; security, maintainability, and API reviews clean | 101 rules; 69/22 handler-capability surface; 67/21 legacy subset; 26 uniquely owned migration groups |
| 3.2 | Port Git, delivery, scope, and edit-admission policies | done | nils agent-hook suite; DSH 104/104 plus typecheck; parity verifier; packed unmodified rc.7 smoke | Eleven typed groups, strict ingress v2, no retired handler execution |
| 3.3 | Port privacy, memory, reminder, and portable-output policies | done | nils 31/31 focused policy suite; DSH 111/111 plus typecheck; parity verifier; packed unmodified rc.7 smoke with native lifecycle context | Nine typed groups, strict lifecycle ingress v3, accepted-prompt digest deduplication, no private payload echo |
| 3.4 | Port coordination and operation lifecycle | done | nils 37/37 policy, 8/8 ingress, 3/3 parity; DSH 116/116 plus typecheck; packed unmodified rc.7 smoke | Metadata-only activity; exact admit/complete with authenticated broker Stop; unmanaged no-op, any partial identity closed |
| 3.5 | Remove legacy handler execution from production | done | 101-row source verifier; zero planned active groups; package executable scan; nils DSH handler rejection; packed rc.7 smoke | 25 implemented groups plus one provider-obsolete retirement; no production handler rule or executable |
| 4.1 | Implement reviewer personas and selection tool | done | 17/17 reviewer tests; skill routing contract; packed unmodified rc.7 smoke; non-empty nils JSONL validation | One strict tool; eight server-owned personas; optional child-plugin activation, bounded runtime-global active/queued admission, validator-compatible structured findings/disposition, cancellation/drain, and automatic critical red-team routing |
| 4.2 | Enforce reviewer read-only authority | done | exact-Agent replay tests; direct/nested/code/delegation denial; packed native-spawn write attempt blocked before body; child disposed | Exact child classification, final read-only sandbox override, and scoped monotonic guard; ordinary/forged sessions cannot claim reviewer identity |
| 5.1 | Add setup, doctor, update, rollback, and remove | done | 22/22 operations tests; typecheck/diff check; unmodified rc.7 setup-update-rollback-remove smoke; upstream checkout clean | Default dry-run and digest-bound apply; registry/local artifact identity; pre-extraction bounds; process-group-quiescent deadlines; kernel locks; native DSH mutation; strict rollback/recovery; no-follow cleanup; unrelated profile/private state preserved |
| 5.2 | Add upstream compatibility and performance gates | done | 16/16 compatibility; 217/217 package tests in a disposable consumer with the exact external runtime closure and staged 37-package DSH closure; typed runtime/source checks; p95 0.0695 ms and 164,408-byte retained-heap benchmark; packed unmodified rc.7 smoke; security follow-up clean | Pinned + upstream-next resolve independently to reviewed `99f6f02`; no fork or DSH patch |
| 6.1 | Run complete real-session acceptance matrix | in-progress | final-head released-mode source rehearsal `issue1-finalhead-20260820d`: 10 passed, 2 pending, 0 failed; DSH 237/237; operations 30/30 on Node 22 and 24; exact nils-cli v1.27.0 artifacts; explicit DSH-only hook/docs/state roots; disposable credentialless UID/deny-all-egress design; stubbed no-merge provider integration | Final pass still requires one run-correlated hosted candidate workflow execution; receipt must prove DSH zero-dependency, provider-wiring preservation, no cross-loading, and no ambient provider/XDG fallback |
| 6.2 | Activate the local DSH profile reversibly | pending | source contract now ships a DSH-only agent-docs catalog and requires literal hook config/policy/state plus docs catalog/state roots | Activate only native `headless`; copy policy/catalog into owner-only roots, preserve a DSH-only rollback point, and never mutate or fall back to Codex/Claude wiring |
| 6.3 | Prove coexistence isolation and close dispatch | pending | pending | DSH zero `agent-runtime-kit` dependency plus active unchanged Codex/Claude wiring required |

Task 6.1 source closeout gates: DSH 237/237 plus typecheck; operations 30/30
on both Node 22 and Node 24; nils focused
agent-docs/agent-hook suites plus clippy and fmt; nils workspace nextest
8,566/8,566 across 168 binaries with 14 unrelated Bubblewrap-dependent
`agent_run_inspect` tests explicitly skipped; private trust-root `make validate`;
real packed DSH smoke; and final-head external-tarball rehearsal 10 passed, 2
authority-pending, 0 failed. Security, maintainability, API-contract, and
data-migration follow-ups for the current coexistence candidate remain open
until the repaired head is re-reviewed.

## Validation Log

- 2026-08-18: The maintainer selected a public repository, private loader-only
  boundary, no DSH fork, phased PR delivery, and subagent delegation. The
  2026-08-20 correction below supersedes the original total-replacement terminal
  requirement.
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
- 2026-08-18: Task 3.1 froze the clean legacy source at commit `79d6b93f` and
  file digest `sha256:5a7a5711...`. The public parity verifier matched all 101
  registration IDs and their 27 source capability identifiers: 21 legacy
  handlers, one relocated memory capability, four coordination capabilities,
  and one read-only shadow capability. The Claude-only coauthor-trailer guard
  is the sole provider-obsolete retirement and carries explicit evidence.
- 2026-08-18: Task 3.1 API review repaired public package exports/bin,
  machine-derived handler and relocation counters, and retirement-specific
  executable evidence. Packed-install, verifier mutation, provider retirement,
  and inventory owner tests pass; affected API follow-up reports no finding.
- 2026-08-18: Task 3.1 testing review froze every target capability, status,
  owner, and retirement disposition independently of its rule rows. The exact
  retained source fixture drives the packed public verifier through both
  success and mutation failure. Provider retirement is now checked across the
  packed runtime/config surface and the live provider/tool graph composed by
  an unmodified DSH rc.7 profile; testing follow-up reports no finding.
- 2026-08-18: Task 3.1 maintainability review moved schema, all 27 frozen
  dispositions, retirement evidence ownership, and rule-target consistency
  into the exported verifier itself. External consumers can no longer receive
  `ok: true` for an incomplete or internally inconsistent inventory. The
  packed retirement test separately classifies runtime-loaded artifacts from
  migration tooling, while a synthetic runtime injection and real rc.7 graph
  keep the retirement boundary executable. Declared inventory count and unique
  rule-ID checks also prevent duplicate rows from being collapsed into a false
  public success result; maintainability follow-up reports no finding.
- 2026-08-18: Task 2.1 PR #3 merged by squash into the retained plan branch as
  `ba15a9c1`. Task 2.2 started in a fresh managed lane; it will keep the full
  policy corpus out of session-start and expose only intent-selected, bounded
  agent-docs content through one DSH-native tool.
- 2026-08-19: Issue #6 and PR #7 integrated native Main Agent Mode into the
  retained plan branch at `8c102f8`. Its `src/main-agent/*` controller tools,
  in-process continuable children, setup/deny-only guard, liveness sidecar,
  skill protocol, and tests are the authoritative implementation. Later Stage
  1 integration composes beside that boundary and does not replace it.
- 2026-08-18: Task 2.2 source converged at 60/60 package tests, strict
  type-checking, package dry-run inspection, and a packed smoke against the
  clean upstream `dsh-v0.1.0-rc.7` checkout. The real Agent loop observed no
  startup marker, loaded `project-dev` only through `runtime_context`, then
  returned `42` from the independent plus-one tool. The exact nils dependency
  is PR #1466 head `ec8b6021`, whose focused 67 unit and 206 integration tests
  and API/security/testing specialist reviews are green; provider CI remains
  the merge gate.
- 2026-08-19: The nils 1.x compatibility boundary was restored. Public
  `Product` remains exactly Codex, Claude, and Hermes; DSH catalog tags are
  parsed into an isolated internal projection used only by DSH context,
  integration fingerprinting, and finish-line validation lookup. Malformed
  excluded entries still fail catalog loading, mixed product arrays preserve
  their standard members, and the pre-projection private-catalog limit remains
  enforced. No nils 2.0 boundary is required.
- 2026-08-18: Security review of DSH PR #4 found that arbitrary model-selected
  intents could omit phase and cross the workflow-owned review/delivery
  boundary. The regression now rejects every intent except `project-dev`
  before process creation and maps every accepted call explicitly to `edit`.
- 2026-08-18: Task 2.3 reached source-complete. The nils engine passes 31
  focused Linux tests, six contract tests, 45 library tests, clippy, docs, and
  formatting. DSH passes 99/99 tests, typecheck, and the packed unmodified rc.7
  create-dispose-resume smoke. The canonical nils local-fast gate reached the
  known host-only Bubblewrap loopback limitation in 12 unrelated
  `agent_run_inspect` cases; the substitute workspace run excluded that group
  and passed 8,512/8,512 tests with no TMPDIR leak. Security,
  maintainability, and API-contract follow-ups are clean. Merge, release, and
  cutover remain unauthorized.
- 2026-08-18: Task 3.1 froze the exact `agent-runtime-kit` Git object
  `79d6b93f9df812e9cfd151ee03fc3d0ce44a0081`. The packaged verifier
  authenticates the repository origin, reads the manifest and 67-row provider
  snapshot from that commit, derives all five 101/69/22/67/21 counters, and
  compares every ordered source digest plus explicit legacy membership. The 27
  source keys map once into 26 migration groups: 23 nils capabilities, two
  stronger DSH-native seams, and one evidence-backed Claude-only retirement.
  Nils publishes a strict 23-ID planning schema with unique Task 2.3/3.2/3.3/
  3.4 ownership; it does not make planned groups dispatchable. DSH passes
  102/102 tests, typecheck, package inspection, source verification, and diff
  check; nils passes its complete agent-hook crate tests, all-target clippy,
  formatting, docs-only gates, and diff check. Security, maintainability, and
  API-contract follow-ups are clean.
- 2026-08-18: Task 3.2 implemented the eleven uniquely owned Git, delivery,
  scope, owner/semantic-conflict, checkout-lease, direct-Python,
  semantic-commit-body, and project-dev edit-admission groups as strict
  `dsh.policy.v1` evaluators. DSH now emits strict ingress v2 with exact
  session/turn/step and agent-docs roots. Nils passes the full agent-hook crate
  suite; DSH passes 104/104 package tests, typecheck, the canonical parity
  verifier, and a packed real smoke against unmodified rc.7 using the packaged
  policy. The smoke preserves project/private/bundled skill precedence and
  exercises context, edit, finish-line, mutation, denial, replay guards,
  cancellation, disposal, resume, a real managed worktree, raw default-branch
  denial, and governed semantic-commit dry-run recovery without a retired
  handler file or external provider mutation. Merge, release, and cutover
  remain unauthorized.
- 2026-08-19: Task 3.3 implemented nine typed privacy, project-memory,
  machine-path, label, memory-principle, session-health, skill, startup-memory,
  and pre-PR groups. The first regression failed with
  `policy-capability-event-unsupported`; green nils binds each group only to
  `PreToolUse`, `UserPromptSubmit`, or `Stop`. DSH uses v2 for tool ingress and
  strict v3 for lifecycle ingress, projects at most 64 KiB of accepted
  downstream user prompt, validates 16 KiB of normalized context, and retains
  only a digest for concurrent same-position deduplication. Changed, rewritten,
  or removed accepted prompts are independently evaluated. Nils focused tests
  pass 31/31; DSH passes 111/111 plus typecheck and parity; the packed bundle on
  unmodified rc.7 exposes a real nils skill reminder in the first model request
  while retaining the full context/edit/finish-line/delivery smoke. The nils
  local-fast docs, artifact, format, and clippy gates pass; workspace nextest
  stops after 2,520 passes at the known host-only Bubblewrap loopback failure in
  the same 12 unrelated `agent_run_inspect` tests. The complete agent-hook crate
  is green, and security, maintainability, and API-contract reviews are clean.
  Merge, release, and cutover remain unauthorized.
- 2026-08-19: Task 3.4 implemented metadata-only DSH activity plus exact native
  operation lifecycle. Strict ingress v4 binds the v2 call identity and carries
  only the terminal error bit. Managed Bash/write/edit/str_replace operations
  use one trusted same-release `agent-session` show/admit/complete sequence,
  preserve idempotency across duplicate or ambiguous calls, and keep Stop
  closed while active or uncertain. Private state contains no raw call, tool
  body, or result; terminal retry state compacts to 64 records behind a session
  lock and hard-fails at conservative capacity. Fully unmanaged sessions are
  no-op and any partial managed selector set blocks. Local operation state is
  retry cache only: terminal post retries reauthenticate completion and Stop
  uses exact-incarnation authenticated broker status. Certain denial removes
  its whole provisional directory; terminal compaction uses a durable monotonic
  sequence and checks existing retry identity before reserving capacity. The
  independent packed smoke strips an
  invoking agent's ambient session identity and passes on unmodified rc.7;
  merge, release, and cutover remain unauthorized.
- 2026-08-19: Task 3.5 closed the legacy execution boundary without removing
  the compatibility capability still used by supported Codex/Claude policy.
  All 101 authenticated rows resolve to 25 implemented groups or the single
  provider-obsolete retirement; the verifier no longer accepts `planned` as a
  terminal active state. The packaged DSH policy has no handler rule, a scan of
  every npm package root finds none of the 22 historical `.py`/`.sh` handler
  basenames, nils rejects `runtime-kit.handler.v1` for product `dsh`, and the
  packed unmodified rc.7 smoke executes no retired handler. Merge, release, and
  cutover remain unauthorized.
- 2026-08-19: Tasks 4.1 and 4.2 implemented one strict
  `review_specialists({ task, roles })` surface with exactly eight fixed
  personas. Native rc.7 `spawn` owns fresh children; one runtime-global
  semaphore preserves input order and disposal across simultaneous calls,
  while red-team runs only after a preselected or critical first wave. Each
  child concludes through structured output that becomes deterministic,
  nils-validated JSONL. Exact child identity is captured during synchronous publication and
  bound to a final read-only sandbox event plus agent-scoped monotonic guard;
  event text and role claims carry no authority. The first packed integration
  run exposed ordinary finish-line steering in the reviewer lifecycle; the
  corrected exact reviewer path bypasses that broader mutation workflow while
  retaining the stricter guard. A later packed red exposed rc.7's restricted
  `outputSchema` keyword subset; the supported schema plus defensive runtime
  bounds now pass. Review follow-up also bounded queued admission and aligned
  quick/empty-artifact disposition and trimmed-string semantics. The final package passes 133/133 tests,
  typecheck, diff check, and a packed smoke on unmodified DSH rc.7 where a
  scripted quick reviewer attempts `write`, receives a pre-body denial, creates no
  file, completes through `structured_output`, validates its JSONL with nils,
  and leaves no live child. Merge, release, and cutover remain unauthorized.
- 2026-08-19: Task 5.1 added authenticated, digest-bound setup, doctor, update,
  rollback, and remove operations with dry-run review receipts, kernel profile
  locking, exact previous-version recovery, bounded artifact reclamation, and
  no-follow deletion. Seventeen focused operation tests, the 150-test package
  suite, typechecking, and a setup-update-rollback-remove smoke on unmodified
  rc.7 pass while unrelated profile/private state and upstream bytes remain
  unchanged. Merge, release, and cutover remain unauthorized.
- 2026-08-19: Task 5.2 added an exact DSH manifest for the rc.7 tag and one
  separately selected upstream-next revision, both currently `99f6f02`. Source
  inspection hashes declared built entrypoints without executing checkout
  bytes; runtime loading resolves all ten exact installed peer versions before
  any import and then checks consumed export kinds. Both CI rows build and pack
  the complete 37-package selected workspace closure, authenticate canonical
  artifact digests, stage only receipt-bound regular files without network
  resolution, run typecheck and the package suite, enforce clean upstream
  state, and execute a controlled two-batch pre-tool performance budget. The
  local selected-artifact rehearsal passes 164/164 package tests plus
  typechecking with no upstream mutation. Exact peer and external-dependency
  declarations, silent JSON CLI output, absence-only descriptor-anchored
  extraction, and rebuild-on-failure disposable consumers close the final API,
  maintainability, and path-race review findings. Security follow-up is clean,
  and the packed bundle passes the unmodified rc.7 smoke with finish-line resume,
  native reviewer denial, skill precedence, cancellation, and disposal. Merge,
  release, and cutover remain unauthorized.
- 2026-08-19: Stage 2A integrated dsh-runtime-kit PR #10 into the retained plan
  branch and nils-cli PR #1468 into nils-cli `main`. Stage 2B released and
  deployed nils-cli v1.27.0 from source tag `v1.27.0`.
- 2026-08-19: agent-runtime-kit PR #40 validated nils-cli v1.27.0 for the
  existing Codex/Claude runtime while preserving its v1.26.4 supported minimum.
  This is coexistence evidence, not authority to remove that runtime.
- 2026-08-20: The maintainer corrected the terminal architecture in
  [Issue #1](https://github.com/sympoies/dsh-runtime-kit/issues/1#issuecomment-5346938699):
  DSH uses dsh-runtime-kit plus nils-cli; Codex and Claude Code continue to use
  agent-runtime-kit plus nils-cli. Tasks 6.2 and 6.3 now activate only an
  isolated DSH profile and prove zero cross-loading; agent-runtime-kit remains
  active and is neither archived nor made read-only.
- 2026-08-20: The final-head follow-up made supervisor-loss recovery compare
  retained unrelated manifest and lockfile state before finalize, restore the
  prior package-plus-activation transaction, and reject contaminated recovery
  fail closed. Operations now canonicalize `DSH_HOME` and reject equality,
  nesting, and symlink aliases against explicit or default Codex and Claude
  homes before preview, doctor, repair, or mutation. Independent DSH and pnpm
  replacement plus launcher nesting regressions close the remaining testing
  coverage. Focused tests pass 4/4, affected tests pass 34/34, Node 22 and 24
  operations pass 30/30, the full suite passes 237/237 plus typecheck, and
  released source rehearsal `issue1-finalhead-20260820d` passes 10 with 2
  authorization-pending and 0 failed. Specialist follow-up and hosted
  acceptance remain required; no merge or cutover is authorized.

## Decision Log

- Use one shared dispatch issue and independently reviewed PR lanes.
- Keep DSH repository lane PRs based on the plan branch; deliver the nils-cli
  dependency as a linked PR to that repository's `main`.
- Do not fork DSH, copy its standard preset, or patch installed dependencies.
- Keep deterministic policy in nils-cli; TypeScript owns transport and native
  lifecycle composition only.
- Do not retain Python handler execution in production. Parity fixtures may
  compare old outcomes until the typed replacement is complete.
- Keep agent-runtime-kit active for Codex and Claude Code. DSH activation is
  additive and reversible, and its zero-dependency audit is scoped to the DSH
  profile rather than the machine's supported provider runtimes.

## Handoff

Continue Task 6.1 from the successful external-tarball source rehearsal,
completed external trust-root source, and published nils-cli v1.27.0 artifacts.
Preserve the tested reviewer, operations, compatibility, DSH
catalog-projection, and acceptance-v2 contracts. Final promotion still needs
one run-correlated hosted execution plus explicitly authorized semantic commit
and no-merge PR delivery. After promotion, Task 6.2 may activate only the
native `headless` profile behind an exact rollback point. It must bind the five
DSH-only hook/docs paths through the owner launcher and authenticated activation
manifest, keep private loading absent/empty unless a DSH projection is
explicitly selected, and must not change Codex or Claude Code agent-runtime-kit
wiring.
