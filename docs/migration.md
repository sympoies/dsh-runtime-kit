# Migration status

The replacement is staged behind executable gates:

1. Complete: external bundle installation and real DSH boot without a fork.
2. Source complete, release pending: strict nils-cli DSH ingress and fail-closed
   allow/block bridge. The package release floor remains unset until the
   matching nils-cli capability is published and artifact-validated.
3. Complete: 29 public skills plus project/private discovery and precedence.
4. Complete: rc.7 lifecycle compatibility, content-free request correlation,
   monotonic pre-tool denial, bounded cancellation-aware nils transport, and
   authoritative result cleanup. All used DSH peers are pinned exactly to
   `0.1.0-rc.7`; unknown subprocess quiescence permanently degrades policy
   admission closed, revokes approval-waiting allow markers, and lifecycle
   refresh is append-incremental with sticky invalidation on history rewrite.
5. Source complete, release pending: model-facing selective context through an
   atomic nils `decision.context.v1` contract and a native DSH tool. No corpus
   is injected at startup; project-dev/edit is bounded and replay-bound.
6. Source complete, release pending: durable edit begin, exact-command
   validation probe, DSH-prepared shell runtime, nils-authoritative execution
   and recording, and turn-stop steering. Every foreground Bash command is
   supervised: exact targets may create evidence, while ordinary commands
   advance repository generation and execute without evidence, forcing exact
   revalidation before stop. Background Bash and unsupported containment fail
   closed. Observed execution requires exactly one non-null `exitCode`/`signal`,
   a canonical `NodeJS.Signals` value for any signal, and mutually exclusive
   `timedOut`/`aborted` flags. An impossible combination invalidates the response
   and requires private quiesce before failure returns. Runner delivery is
   pinned through a sealed memfd, systemd `OpenFile` descriptors, a verified
   root-owned ELF interpreter, and supervisor pidfd.
   Open uses private caller-held idempotency material, create-only live-session
   capability binding, hourly renewal of a 24-hour nils lease, and conservative
   reclamation only after expired crash-orphan units have trusted stable
   quiescence proof. Rc.7 disposal synchronously registers release work;
   coordinator teardown first drains/quiesces active nils runs, then drains
   authenticated release before closing the nils client. Release tombstones
   bind capability incarnations, so the same stable rc.7 session ID can resume
   with a fresh token without letting an old release remove new state.
   Every failed execution-bearing run, including transport, unexpected
   agent-hook exit or signal, response validation, cancellation, deadline, and
   disposal failures, must pass private nils quiescence before returning its
   error. Failure to prove the exact unit inactive and unpopulated permanently
   degrades closed. The packed rc.7 smoke proves edit -> failed exact validation
   -> blocked stop -> successful exact validation -> ordinary mutation -> blocked
   stop -> exact revalidation -> allowed stop, without a shell wrapper, `EXIT`
   trap, or deferred result queue.
7. Source complete, release pending: the eleven Task 3.2 Git, delivery, scope,
   ownership, checkout-lease, direct-Python, semantic-commit, and project-dev
   edit-admission groups are typed `dsh.policy.v1` evaluators. The packed policy
   uses strict ingress v2. The unmodified rc.7 smoke exercises it without a
   retired handler file, creates a real managed feature worktree, denies raw
   default-branch delivery, and completes the governed dry-run recovery path.
8. Source complete, release pending: nine Task 3.3 privacy, memory, portable
   output, session-health, skill, label, and pre-PR groups use strict lifecycle
   v3 plus native pre-step/post-tool/steering context. Inputs and context are
   bounded, duplicate lifecycle delivery is constant-space, and secret or
   machine-local payload fragments are never echoed in decisions.
9. Source complete, release pending: Task 3.4 metadata-only activity and exact
   operation lifecycle use strict post ingress v4 plus native
   `agent-session` admit/complete reconciliation and authenticated broker
   status. Fully unmanaged sessions are no-op, any partial managed selector set
   fails closed, uncertain operations block Stop, and content-free terminal
   retry state is sequence-ordered and capacity-bounded.
10. Source complete, release pending: the runtime migration projection has no
    planned active group, the DSH policy and package tree contain no retired
    handler rule or executable, and nils rejects `runtime-kit.handler.v1` for
    DSH while retaining that compatibility capability for supported
    Codex/Claude policy. The frozen public source inventory remains unchanged.
11. Source complete: one DSH-native reviewer tool exposes exactly eight
    server-owned personas, a runtime-global concurrency bound, structured
    nils-compatible JSONL, cancellation/drain handling, and automatic critical
    red-team routing. Reviewer authority binds the exact native child Agent to
    a read-only sandbox plus scoped monotonic guard; a packed rc.7 smoke proves
    an attempted write never reaches its body, structured output validates with
    nils, and the child is disposed before the parent result settles.
    Review and Main Agent Mode are independent optional child plugins; missing
    `subagents` never prevents the parent policy or skills from activating.
12. Source complete: the package operations CLI supplies digest-bound dry-run
    and apply for setup/update/rollback/remove, exact previous-version receipts,
    content-addressed local artifacts, kernel-owned per-profile locking, native
    DSH delegation, installed-tree verification, bounded artifact reclamation,
    process-group-quiescent external-command deadlines, digest-bound
    exact-registry recovery across the native-success state-write window,
    nils-aware doctor, strict interruption repair, and no-follow cleanup. Unit
    and unmodified rc.7 matrix tests preserve unrelated
    profile/private state and leave upstream clean.
13. Source complete: a checked-in DSH compatibility manifest and blocking CI
    matrix pin rc.7 plus one selected upstream-next revision, hash every
    consumed public entrypoint without executing checkout bytes, authenticate
    and stage the complete selected 37-package DeepSeek workspace closure
    without registry resolution, and require the upstream checkout to remain
    clean. Runtime boot resolves every installed public peer version before the
    first module import and fails with a typed incompatibility before DSH
    registration. Artifact parsing enforces compressed, expanded, entry-count,
    and per-entry limits while staging retains one artifact buffer at a time. The controlled
    pre-tool promotion budget is p95 <= 5 ms, per-batch retained heap <= 8 MiB,
    retained growth <= 2 MiB, and zero active operations/handles before and
    after disposal across 2,000 measured checks.
14. Source rehearsal complete, promotion pending: acceptance summary v2 runs
    ten producer-owned functional scenarios from a packed runtime kit against a
    freshly cloned, lockfile-installed, host-built pinned DSH revision. The
    operations leg uses two complete package variants, and the runtime leg binds
    six content-hashed nils executables under a fixed PATH. Each scenario uses a
    fresh extraction of the authenticated tarball inside a bounded user-systemd
    control group, and the runner rechecks its control program, tested tarball
    digest, executable closure, and DSH closure between legs. The retained local
    result is honestly `incomplete`: released nils artifacts, disposable
    OS-isolated execution, and authorized run/repository/head-correlated
    semantic commit plus no-merge PR delivery remain required. Local cutover
    remains pending.

The previous runtime remains untouched until the new path passes every gate
and no active configuration points to it. At that point it can be marked
read-only and retained only as migration history.
