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
- Status: complete
- Current task: complete
- Next task: none
- Integration checkout: `main` through PR #26
- Blockers: none
- Last updated: 2026-08-21

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
| 5.2 | Add upstream compatibility and performance gates | done | compatibility contract; package tests in a disposable consumer with the exact external runtime closure and staged 37-package DSH closure; typed runtime/source checks; deterministic heap benchmark plus packed real released-agent-hook subprocess p95/teardown gate; packed unmodified rc.7 smoke | Pinned + upstream-next resolve independently to reviewed `99f6f02`; no fork or DSH patch |
| 6.1 | Run complete real-session acceptance matrix | done | hosted run `32447387497`; final receipt 12 passed / 0 pending / 0 failed; runtime package SHA-256 `955438c2ec36723f3d04edbe0acafdfdceb4f958a504107be5492435c769469c`; exact released nils-cli v1.27.0; DSH rc.7 `99f6f02` | Credentialless, network-denied candidate and correlated no-merge delivery both passed; the final receipt is owner-only and hash-bound outside the repository |
| 6.2 | Activate the local DSH profile reversibly | done | digest-bound local `headless` activation; DSH doctor healthy; direct DeepSeek `runtime_kit_plus_one` proof returned `42` for `41` | Durable trusted DSH rc.7 toolchain and fallback workspace are owner-only; project invocations still resolve to the target Git root |
| 6.3 | Prove coexistence isolation and close dispatch | done | DSH active profile contains only dsh-runtime-kit and standard DSH bundles; Codex and Claude Code agent-runtime-kit wiring remains active; PR #26 merged to `main` as `7bbcee244d0693c32697de86446e3fa037682ac9` after four green compatibility jobs in run `32447803170` | Zero DSH cross-loading proved; provider issue closeout follows this retained terminal state |

Task 6.1 closeout gates are terminal: the final hosted run passed all 12
scenarios in disposable credentialless isolation and produced the correlated
delivery receipt. The repaired plan head passed the one requested full review
and one targeted repair follow-up; no repeated full review cycle was opened.
Local activation, DeepSeek tool execution, DSH doctor, and the additive
Codex/Claude coexistence audit are also green.

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
  state, execute a controlled two-batch pre-tool performance budget, and pack
  the candidate before measuring the exact released nils-cli `1.27.0`
  `agent-hook` subprocess boundary with zero-child teardown. The
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
- 2026-08-20: Persisted-root recovery follow-up now revalidates canonical
  pending, current, and previous activation roots against the current explicit
  and default provider-home topology before every doctor recovery path. The
  reviewed repair digest binds those roots and source-labeled topology, so
  preview/apply provider or symlink drift fails closed. Negative tests cover
  equality, nesting in both directions, aliases, default homes, retained
  previous roots, collateral restoration, and remove finalization without
  changing provider sentinels. A separate interrupted v2 update proves exact
  restoration of the prior v1 package, activation, profile, and operations
  state. Focused tests pass 5/5, affected tests pass 39/39, Node 22 and 24
  operations pass 35/35, the full suite passes 242/242 plus typecheck, and
  released source rehearsal `issue1-finalhead-20260820e` passes 10 with 2
  authorization-pending and 0 failed. Specialist follow-up and hosted
  acceptance remain required; no merge or cutover is authorized.
- 2026-08-20: Collateral restoration no longer rewrites profile controls or
  operations state in place. One shared owner-checked atomic replacement writes
  a private same-directory temporary, fsyncs it, renames it, restores the exact
  mode, and fsyncs both the final file and directory. Pending recovery state is
  retained until package, activation, and every profile control have reached
  the authenticated prior snapshot. Deterministic process-loss tests at the
  durable profile temporary and final state temporary prove that the retained
  receipt remains parseable, orphan temporaries remain owner-only with one
  link, and a subsequent doctor repair converges exactly. Focused tests pass
  3/3, operations pass 38/38 on Node 22 and 24, the full suite passes 245/245
  plus typecheck, and released source rehearsal `issue1-finalhead-20260820j`
  passes 10 with 2 authorization-pending and 0 failed. Specialist follow-up and
  hosted acceptance remain required; no merge or cutover is authorized.
- 2026-08-20: Final maintainability review removed the collateral-removal
  marker because recovery never interpreted it; the retained pending receipt
  and authenticated prior snapshot are the only recovery authority. A new
  two-window regression was red 0/1 when the old path lacked a distinct
  before-unlink boundary. The removal path now keeps owner/type validation,
  durable directory fsync, and no protocol artifact. Deterministic `SIGKILL`
  before unlink leaves the collateral lockfile present and retries through
  restore; interruption after durable unlink leaves it absent and retries
  through clear. Both retain parseable pending state and converge to the exact
  prior package, activation, profile, and state. Operations pass 38/38 on Node
  22 and 24; the full suite and packed acceptance remain the final local gate
  before the repaired head is delivered for specialist follow-up.
- 2026-08-20: API/data/performance follow-up gives operations state and plan
  explicit version 2 schemas, retains a strict exact-base version 1 reader,
  migrates only authenticated terminal receipts through digest-bound doctor
  repair, and keeps legacy pending bytes unchanged behind actionable
  fail-closed recovery. Persisted current/previous receipts now reject a
  different supplied runtime root before native mutation. A second performance
  contract packs the candidate, authenticates the released nils-cli `1.27.0`
  agent-hook binary, measures real subprocess dispatch, and requires zero live
  children/admission after disposal. Migration/root focused tests pass 5/5,
  compatibility focused tests pass 2/2, operations pass 42/42 on Node 22 and
  Node 24, the full suite passes 249/249, both benchmarks/typecheck/pack/plan
  validation/diff check pass, and source rehearsal
  `issue1-finalhead-20260820k` passes 10 with 2 authorization-pending and 0
  failed while binding package SHA-256
  `795bdcec4d3f59dff83ce75dfbb924345d8bfa5537ad98bde9031839578ee19e`.
  Exact-head specialist convergence and hosted acceptance remain required; no
  merge or cutover is authorized.
- 2026-08-20: Final red-team review found activation assets had no bounded
  retention or pre-pending orphan collection. Three new regressions failed 0/3
  before production edits: repeated updates retained every historical set, the
  staging crash seam did not exist, and two DSH homes could share one runtime
  root. A separate digest-before-claim regression failed 0/1 because a drifted
  apply could claim an empty root. Root ownership after digest validation, a
  root-scoped lock, strict receipt/manifest inventory,
  exact orphan collection, and explicit 16-set/byte admission limits make those
  regressions, capacity exhaustion, and digest-before-claim pass 5/5.
  Operations pass 47/47 on Node 22 and Node 24, the full package suite passes
  254/254, and source rehearsal
  `issue1-finalhead-20260820l` remains released mode with 10 passed, 2
  authorization-pending, and 0 failed. The pre-repair finding is retained in
  the PR review ledger and must be observed fixed on the repaired exact head.
- 2026-08-20: Final ownership follow-up adds one locked compatibility path for
  an exact ownerless pre-ownership version 2 runtime root. Its digest-reviewed
  `doctor --repair` plan binds the canonical DSH home, selected runtime root,
  complete current/previous/pending/last-applied root topology, state and
  activation digests, installed/active current-or-pending provenance, and an
  exact retained-set inventory before atomically writing only the owner record.
  Cross-home, unmanaged, drifted, malformed-pending, foreign-owner, missing,
  extra, staging, oversized, and malformed asset candidates remain closed.
  The storage bound is derived from at most 16 independently validated sets,
  each limited to 4 MiB of package assets plus 64 KiB of generated overhead;
  the unreachable aggregate branch is removed. A final artifact-sentinel RED
  0/1 proved adoption had still reconciled unrelated archives; reconciliation
  now starts only after the adoption early return, and the isolated byte-
  preservation regression passes 1/1. Focused tests pass 4/4,
  launcher tests pass 4/4, operations pass 51/51 on Node 22 and Node 24, the
  full package suite passes 258/258, and source rehearsal
  `issue1-finalhead-20260820m` remains released mode with 10 passed, 2
  authorization-pending, and 0 failed. Exact-head specialist convergence and
  hosted acceptance remain required; no merge or cutover is authorized.
- 2026-08-20: Exact-head provenance follow-up rejects the formerly accepted
  impossible `prepared/current/pending` ownerless combination and binds one
  phase-consistent actual/activation source pair plus pending action and phase
  into the adoption receipt. The explicit table preserves the legitimate
  `native-applied/pending/current` crash window, permits setup only after both
  observed surfaces are pending, and rejects undefined phases and pending
  remove. A second regression changes an authenticated policy byte after a
  valid preview; old-digest apply now returns `plan-drift`, writes no owner,
  and preserves state, activation, and changed asset bytes. A final error-
  surface RED showed that an unavailable command supervisor during apply was
  incorrectly converted from status 70 `command-unavailable` to status 65
  `plan-drift`. Apply now converts only an explicit allowlist of reviewed
  state, topology, provenance, and inventory failures; infrastructure,
  isolation, and configuration errors retain their typed code, status, and
  details. Focused audit tests pass 4/4, adoption tests pass 6/6, operations
  pass 53/53 on Node 22 and Node 24, and the full package suite passes 260/260
  plus typechecking, both performance gates, a 133-entry package preview, plan
  validation, and diff check. The frozen package is assigned source rehearsal
  `issue1-finalhead-20260820o`; its terminal receipt is retained outside the
  repository after the package bytes are fixed. No merge or cutover is
  authorized.
- 2026-08-20: Terminal-remove ownership follow-up first failed both focused
  contracts: completed-remove version 2 state exposed no adoption repair, and
  a locked non-evidence revalidation fault returned success instead of its
  typed status 70 `command-supervisor-failed`. `doctor --repair` now admits
  only the exact removed-state protocol rows. Terminal remove requires null
  current/previous/pending state, authenticated selected-root last-applied
  remove, absent package and activation, and an empty owner-only assets
  directory. Pending remove retains current snapshot and assets: prepared
  permits `current/current` or `absent/current`; native-applied permits
  `absent/current` or `absent/absent`; `current/absent` remains closed. The
  receipt binds both observed sources, remove phase, and action, while apply
  revalidates under lock and writes only ownership infrastructure. Adoption
  now routes failures through the same reviewed durable-evidence classifier;
  command, supervisor, isolation, and configuration errors preserve typed
  status/code/details. Focused tests pass 2/2, complete adoption audit 8/8,
  operations 55/55 on Node 22 and Node 24, and full package 262/262 plus
  typecheck, both performance gates, and plan validation. The frozen package
  is assigned source rehearsal `issue1-finalhead-20260820p`; external terminal
  evidence remains required before promotion. No merge or cutover is
  authorized.
- 2026-08-20: Final terminal-remove inventory follow-up first failed 0/2:
  a true pre-owner completed-remove root with one restored safe digest
  directory was rejected, while another profile's authenticated reference to
  the same set was not. Terminal adoption now requires zero retained
  activation references across the global authenticated profile inventory and
  permits at most 16 present digest directories only as reviewed unreferenced
  orphans. Each orphan is owner-only, single-link, symlink-free,
  depth/count-bounded, and limited independently to 4 MiB of package assets
  plus 64 KiB of activation overhead. The receipt binds each orphan digest and
  byte count; apply revalidates under the root lock, writes only ownership
  infrastructure, and preserves the exact orphan tree. The next authenticated
  setup reconciles it. Unmanaged/staging names, malformed members, 17 present
  sets, and any globally retained set fail closed. Focused terminal contracts
  pass 3/3, complete ownerless adoption audit 10/10, operations 57/57 on Node
  22 and Node 24, and full package 264/264 plus typecheck, both performance
  gates, a 133-entry package preview, plan validation, and diff check. The
  frozen package is assigned source rehearsal `issue1-finalhead-20260820q`;
  external terminal evidence remains required before promotion. No merge or
  cutover is authorized.
- 2026-08-20: Inactive retained-set authentication follow-up first failed 0/2:
  a same-length previous-policy mutation before preview was accepted, and the
  same mutation after a valid preview applied and wrote ownership. Adoption
  now catalogs authenticated asset targets from every strict version 2
  current, previous, and pending receipt across the DSH home. Every retained
  or active digest must resolve without conflict and its policy, catalog,
  document, and root-specific hook configuration must match. Bounded traversal
  binds bytes plus a canonical digest of sorted path/type/mode/link/size/file-
  hash rows for each referenced set and reviewed terminal orphan; locked
  recomputation makes later drift `plan-drift`. Orphans remain untrusted and
  unexecuted. Both negative regressions and positive adoption-to-rollback pass
  3/3, complete ownerless audit 11/11, operations 60/60 on Node 22 and Node 24,
  and full package 267/267 plus typecheck, both performance gates, a 133-entry
  package preview, plan validation, and diff check. The frozen package is
  assigned source rehearsal `issue1-finalhead-20260820r`; external terminal
  evidence remains required before promotion. No merge or cutover is
  authorized.
- 2026-08-20: Canonical agent-hook configuration follow-up first failed 0/2:
  active and inactive retained sets accepted valid TOML that selected an
  alternate owner-private policy while hiding the expected canonical path and
  digest in comments. Activation now owns one internal canonical renderer used
  by staging, active reads, and retained-set validation; all three require
  exact byte equality and therefore reject comments, extra sections, alternate
  providers, and overrides. Focused regressions pass 2/2, complete ownerless
  audit 13/13, operations 62/62 on Node 22 and Node 24, and full package
  269/269 plus typecheck, both performance gates, a 133-entry package preview,
  plan validation, and diff check. The frozen package is assigned source
  rehearsal `issue1-finalhead-20260820s`; external terminal evidence remains
  required before promotion. No merge or cutover is authorized.
- 2026-08-20: Active-activation topology follow-up began with one of two
  focused cases failing: a versioned agent-hook directory symlinked into
  mutable hook state still launched the child, while the direct agent-docs
  directory redirect was already rejected. Active reads now canonicalize and
  validate the root; lstat-check every component below it; require real
  owner-private asset-set, hook-assets, and docs-home directories; prove all
  asset-leaf containment; and keep every asset surface disjoint from both
  mutually disjoint state roots before rendering config. A positive case
  preserves absolute roots below symlinked parents by canonicalizing them to
  the same real root without permitting symlinks inside it. Focused topology
  passes 2/2, launcher 7/7, ownerless audit 13/13, operations 62/62 on Node 22
  and Node 24, and full package 272/272 plus typecheck, both performance gates,
  a 133-entry package preview, plan validation, and diff check. The frozen
  package is assigned source rehearsal `issue1-finalhead-20260820t`; external
  terminal evidence remains required before promotion. No merge or cutover is
  authorized.
- 2026-08-20: Hosted Task 6.1 run `32360067297` reached the credentialless
  candidate but the source acceptance runner returned a generic failure. New
  bounded phase and scenario diagnostics identified a pre-build source-only
  checkout inspection, a `pnpm dsh` launcher that escaped the authenticated
  tool selection, and a temporary-PATH symlink that broke pnpm/action-setup's
  package-relative runtime. Checkout identity is now authenticated before the
  build and fully rechecked afterward; operations invoke the built selected
  DSH CLI directly; and owner-only exec forwarders preserve authenticated tool
  package layout. Focused tests pass 33/33, the full package suite passes
  276/276, and exact packed source rehearsal
  `acceptance-local-tool-forwarder-fix` passes 10 functional scenarios with 2
  hosted-delivery-pending and 0 failed against DSH rc.7 and released nils-cli
  1.27.0. Task 6.1 remains in progress until a new exact-head hosted run and
  correlated delivery receipt complete; no merge or cutover is authorized.
- 2026-08-20: The hosted portability repair at PR #14 exact head
  `eeac5b0fac378a5058d4ce0ea479b86682732f49` passed all four DSH
  compatibility checks in run `32364546124` and was squash-integrated into the
  Task 6.1 candidate branch as
  `aaf90c18738800c2f5f979f47e41d6d00b42cd35`. This retained integration
  record is the next semantic candidate boundary: its exact receipt and the
  private trust root must bind the eight acceptance control files, including
  `src/acceptance/tool-path.js`, before hosted execution resumes. Task 6.1
  remains in progress until the disposable hosted candidate completes all 12
  scenarios and the correlated delivery receipt verifies; no cutover is
  claimed by this integration record.
- 2026-08-20: Hosted run `32367478998` completed authenticated acquisition but
  the credentialless source runner stopped before the scenario matrix with
  `pnpm store discovery failed`. The acquired archive contained the expected
  pnpm v11 store; an action-style pnpm 11.7 launcher could resolve it when
  acquisition's explicit root and XDG/PNPM homes were retained. Source
  acceptance had instead dropped those bindings and relied on ambient store
  inference after isolation changed HOME/XDG scope. A RED 0/1 action-layout
  regression now passes and requires exact `--store-dir`, `XDG_DATA_HOME`, and
  `PNPM_HOME`; focused acceptance/tool-path coverage passes 17/17 and the first
  and frozen full runs pass 277/277. Typecheck, both performance gates, a
  134-entry package preview, plan validation, and diff check pass. Frozen source
  rehearsal `issue1-pnpm-store-20260820u` remains external. Task 6.1 still
  requires a new exact-head hosted run; no merge or cutover is authorized.
- 2026-08-20: The pnpm-store portability repair at PR #15 exact head
  `6caa310d9f82796cbd1e512ec06ad0e53060a1ef` passed all four DSH
  compatibility checks in run `32371298214` and was squash-integrated into the
  Task 6.1 candidate branch as
  `e6d0cee1d9359cdf8e5db355019bba868ca6fd6d`. This retained integration
  record is the next semantic candidate boundary: its exact receipt and the
  private trust root must bind the same eight acceptance control files before
  hosted execution resumes. Task 6.1 remains in progress until the disposable
  hosted candidate completes all 12 scenarios and the correlated delivery
  receipt verifies; no cutover is claimed by this integration record.
- 2026-08-20: Hosted run `32374056631` authenticated every acquired input and
  entered the credentialless candidate, then hit the five-minute deadline in
  the pinned DSH dependency installation. Its downloaded 536 MiB artifact
  passed all SHA-256 checks. Exact-cache replay showed the install completed in
  4.9 seconds with registry access, while network denial caused pnpm 11.7's
  lockfile supply-chain verifier to attempt registry metadata requests despite
  `--offline` and enter retry backoff. The regression began RED 0/1. Because
  the selected DSH revision and lockfile are authenticated before preparation,
  source acceptance now adds `--trust-lockfile` to the existing offline,
  frozen, ignored-script, and exact-store contract. The same denied-network
  replay completes 923 packages with zero downloads in 2.4 seconds. Focused
  acceptance/store tests pass 16/16 on Node 22 and Node 24, full package
  277/277, typecheck, both performance gates, a 134-entry package preview, plan
  validation, and diff check. Frozen source rehearsal
  `issue1-pnpm-offline-20260820v` remains external. Task 6.1 still requires a
  new exact-head hosted run; no merge or cutover is authorized.
- 2026-08-20: The authenticated-lockfile portability repair at PR #16 exact
  head `830b0501ab7e99026c4e2c02009d6fc5932907c2` passed all four DSH
  compatibility checks in run `32378263155` and was squash-integrated into the
  Task 6.1 candidate branch as
  `c7b7bd622e13f16916ca98a2aa05cc98d96b028f`. This retained integration
  record becomes the next semantic candidate boundary: its exact signed
  receipt and the private trust root must bind the same eight acceptance
  control files before hosted execution resumes. Task 6.1 remains in progress
  until the disposable hosted candidate completes all 12 scenarios and the
  correlated delivery receipt verifies; no cutover is claimed by this record.
- 2026-08-20: Hosted run `32380603036` passed acquisition, pinned DSH offline
  preparation, and the credentialless/network-denied boundary before
  operations `profile-setup` returned a generic assertion. Exact-artifact
  replay exposed exit 65 `native-dsh-verification-failed`: owner-only 0700
  executable package entries were installed by pnpm as 0755, while tree
  identity incorrectly bound the full execute-bit distribution. The RED 0/1
  regression now passes because identity binds executable role plus exact
  path/type/size/content, and operations smoke preserves a bounded typed
  `DSH_OPERATIONS_*` cause. Focused contracts pass 2/2, the affected suite
  80/80, operations 63/63 on Node 22 and Node 24, full package 278/278,
  typecheck, both performance gates, a 134-entry package preview, plan
  validation, and diff check. Frozen source rehearsal
  `issue1-operations-profile-20260820w` remains external. Task 6.1 still
  requires a new exact-head hosted run; no merge or cutover is authorized.
- 2026-08-20: The executable-mode portability repair at PR #17 exact head
  `cf6685db7dbc2f1b600c078858014717c9a6e49b` passed all four DSH
  compatibility checks in run `32385920089` and was squash-integrated into the
  Task 6.1 candidate branch as
  `9ec7ef6d2cb5a784969f8abc78e23d5a4716d9c4`. This retained integration
  record becomes the next semantic candidate boundary: its exact signed
  receipt and the private trust root must bind the same eight acceptance
  control files before hosted execution resumes. Task 6.1 remains in progress
  until the disposable hosted candidate completes all 12 scenarios and the
  correlated delivery receipt verifies; no cutover is claimed by this record.
- 2026-08-21: Hosted run `32388147367` entered the credentialless,
  network-denied candidate and failed native profile setup because the
  runtime-kit tarball did not include its production dependency closure. Exact
  secondary-UID/nft replay showed pnpm registry metadata attempts, then showed
  that explicit `add --offline` succeeds once all exact dependencies are
  bundled. The reviewed artifact SHA continues to bind that complete closure;
  installed identity projects out only the package root's package-manager-owned
  top-level `node_modules`, while binding all other plugin-owned paths. A
  second replay exposed pnpm 11.7 rejecting `remove --offline`; DSH remove is
  therefore invoked without that unsupported flag while the isolated offline
  environment remains. Focused contracts pass, operations pass 65/65 on Node
  22 and Node 24, full package passes 281/281, typecheck, both performance
  gates, the 1,144-entry package preview, plan validation, and diff check pass.
  The exact network-denied setup-update-rollback-remove replay is green and
  cleans its UID/nft boundary. Frozen source rehearsal
  `issue1-native-dsh-profile-20260821x` remains external; a new exact-head
  hosted run is still required.
- 2026-08-21: The offline native-profile portability repair at PR #18 exact
  head `0b6aea416046d44e8d530ef06160985ab447e1d6` passed all four DSH
  compatibility checks in run `32397354308` and was squash-integrated into the
  Task 6.1 candidate branch as
  `74f5d0a64f3de22754763146d0eb538fc90666fa`. The checks cover package
  validation on Node 22 and Node 24 plus the pinned and upstream-next DSH
  compatibility jobs. This retained integration record is the next semantic
  candidate boundary: its exact signed receipt and the private trust root must
  bind the same eight acceptance control files before hosted execution
  resumes. Task 6.1 remains in progress until the disposable hosted candidate
  completes all 12 scenarios and the correlated no-merge delivery receipt
  verifies; no cutover is claimed by this record.
- 2026-08-21: Hosted run `32417978607` completed content-addressed acquisition
  in 2m7s and the credentialless, network-denied candidate in 4m30s. All 12
  scenarios and the isolated candidate receipt passed. The provider leg then
  correctly validated a scoped opaque GitHub App credential with bounded
  natural expiry, but rejected existing PR #12 because that lane PR targets
  the non-default plan branch rather than `main`. The closed exact-head review
  ledger and four green compatibility checks allowed the dispatch orchestrator
  to squash PR #12 head `84189777d54946491200f1aaae02e3d38568289c`
  into `feat/dsh-runtime-migration-plan` as
  `ddf64acb9f35effa154bf4abd9c1380ecafaba05`. The next hosted attempt must bind
  this plan integration head and create the run-correlated draft/no-merge final
  integration PR to `main`; Task 6.1 remains in progress until that receipt is
  green.
- 2026-08-21: PR #19 retained the hosted candidate and remaining-delivery
  evidence after PR #12 integration. All four compatibility jobs in run
  `32419417097` passed, and the evidence-only PR was squash-integrated into the
  non-default plan branch as `cae2ee784ad284565abda69d2013a04be18383de`.
  The following signed semantic commit is the exact Task 6.1 trust-root
  boundary: its owner-only receipt must be supplied to the hosted workflow.
  Task 6.1 remains in progress until the correlated plan-to-main draft PR and
  terminal hosted receipt verify; no cutover is claimed by this record.
- 2026-08-21: Hosted run `32431065461` completed the exact released Task 6.1
  path with 12/12 scenarios, credentialless network denial, and correlated
  draft/no-merge PR #20 targeting `main`. The first local Task 6.2 apply then
  exposed a clean-profile boundary: native DSH initialized the absent
  `headless` profile, while collateral detection classified the expected new
  manifest/workspace as drift and classified the exact absent-state recovery
  the same way. The initial focused regressions began RED 0/2. A quick-review
  RED 0/1 additionally proved the initialization allowance must not apply
  during interrupted recovery while a newly created manifest remains. The repair admits only
  files newly created by the exact plan-bound DSH binary when the manifest was
  initially absent during the immediate post-mutation comparison;
  doctor/recovery require exact absent/present topology. An already-present
  lockfile remains protected and restores byte-for-byte on rejection. Focused
  tests pass, operations pass 68/68 on Node 22 and Node 24, full package tests pass 284/284, and typecheck,
  plan/diff/main-agent scope, and both performance gates pass. Frozen packed
  source rehearsal `issue1-clean-profile-20260821y` passes 10/2/0 against DSH
  rc.7 and released nils-cli 1.27.0. The interrupted local state was cleared
  through a digest-bound doctor repair. The repaired exact head still requires
  hosted promotion and successful reversible local activation before Task 6.2
  or dispatch closeout is complete.
- 2026-08-21: PR #21 exact signed head
  `446a16fc988629200c1d4dd8d6a777bdd7a856f5` passed package validation on
  Node 22 and Node 24 plus pinned and upstream-next DSH compatibility in run
  `32435873837`. The quick-review recovery finding is closed, with no open
  review-ledger finding, and the repair was squash-integrated into the
  non-default plan branch as
  `074d94478971511b2d83216a15d72729e90db475`. This retained integration
  record establishes the next signed semantic candidate boundary. The private
  trust root and hosted workflow must bind that signed descendant before local
  activation resumes; Task 6.2 and dispatch closeout remain incomplete.
- 2026-08-21: The one full review of hosted-created PR #24 found seven
  actionable boundaries in reviewer read containment, executable ancestor
  trust, legacy digest migration, lifecycle prompt materialization, optional
  child-plugin observability, launcher process ownership, and duplicated
  operations terminal-state construction. Meaningful regressions reproduced
  each behavior defect; the structural state-construction consolidation uses
  the complete operations matrix as its preservation proof. Directly affected
  reviewer/launcher tests pass 26/26, operations/policy-plugin tests pass
  115/115, and typecheck/diff checks pass. The single targeted repair review
  found one remaining `.envrc` read boundary; its exact RED 0/1 and GREEN 1/1
  now prove the complete `.env*` family is rejected while ordinary source names
  remain readable. Per maintainer instruction, the full specialist matrix is
  not repeated and no further review cycle is opened. PR #24 remains unmerged
  until the repaired plan head is delivered, hosted acceptance is rebound, and
  the local DeepSeek proof is repeated.
- 2026-08-21: PR #25 exact Good-signed head
  `2d3542e22182eca96ca0ac7bd63e80e4669f6f7d` passed all four DSH
  compatibility jobs in run `32445935939` and was squash-integrated into the
  non-default plan branch as
  `a73ecdbe032199491703cd9133561a7f6d2d0ba5`. This evidence-only checkpoint
  adds no new behavior or review cycle. The next signed semantic descendant
  must bind the private infra trust root before the hosted 12-scenario rerun;
  local DeepSeek activation/proof and PR #24 closeout remain downstream gates.
- 2026-08-21: Final hosted acceptance run `32447387497` completed the released
  path with 12 passed, 0 pending, and 0 failed scenarios. Acquisition,
  credentialless network-denied execution, strict receipt verification, and
  correlated no-merge provider delivery all passed. The final receipt binds
  runtime package SHA-256
  `955438c2ec36723f3d04edbe0acafdfdceb4f958a504107be5492435c769469c`,
  nils-cli v1.27.0, and DSH rc.7 `99f6f02`. Hosted-created PR #26 then passed
  package validation on Node 22 and Node 24 plus pinned and upstream-next DSH
  compatibility in run `32447803170`; exact head
  `5cb8b2922c9c4349de3f03fd3b545090c310cc89` was squash-merged to `main` as
  `7bbcee244d0693c32697de86446e3fa037682ac9`.
- 2026-08-21: Local Task 6.2 activation completed through the digest-bound DSH
  operations contract. Doctor reports the native `headless` profile healthy,
  and a direct DeepSeek session invoked `runtime_kit_plus_one` once and returned
  `42` for `41`. General DSH invocations outside a repository use an owner-only
  fallback Git workspace, while invocations inside a repository use that
  repository root. Temporary diagnostics and receipts remain outside source
  checkouts. The active DSH profile has no `agent-runtime-kit` dependency;
  Codex and Claude Code retain their existing agent-runtime-kit wiring. This
  completes Tasks 6.2 and 6.3 without retiring or cross-loading either runtime.
- 2026-08-21: The first terminal-state PR run `32450587634` exposed the
  one-time squash-history boundary after PR #26: a fresh clone of `main` cannot
  contain the earlier plan-branch parity evidence merge as an ancestor. The
  focused owner-verification regression reproduced 0/2 locally. The trusted
  squash bridge now names final integration commit
  `7bbcee244d0693c32697de86446e3fa037682ac9`, which contains the unchanged
  evidence blobs and remains an ancestor of subsequent `main` commits. This is
  the only executable closeout repair; no additional review cycle was opened.

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

Implementation and activation are complete. Preserve the hosted 12-scenario
acceptance contract, the DSH-only `headless` profile, and the existing
Codex/Claude agent-runtime-kit wiring. Future work is ordinary maintenance and
must start from a new issue or explicitly authorized follow-up; no migration
task remains in this dispatch.
