# Architecture

`dsh-runtime-kit` is an out-of-tree DSH bundle. It does not fork or vendor the
harness. Runtime integration uses public Cordis and DSH service APIs; the
execution-ordering gaps are carried in one authenticated, version-scoped
downstream patch documented by the compatibility contract.

## Responsibility split

Responsibilities are intentionally split:

- DSH owns the agent loop, sessions, tools, sandbox, approvals, skills
  registry, and subagents.
- This bundle owns composition, compact workflow skills, DSH-to-nils policy
  adaptation, reviewer personas, and compatibility diagnostics.
- nils-cli owns deterministic policy evaluation, repository lifecycle
  commands, and machine-readable contracts.

The runtime-owned workspace service follows the same split: DSH supplies exact
agent/session/tool lifecycle, runtime-kit selects and binds per-repository
authority from that public lifecycle, and nils-cli owns operation
classification, canonical Git/worktree identity, and durable cross-process
leases and fencing. A session's startup cwd is a contextual anchor, not a
permission boundary: a live lineage owns an authority *set* of zero or more
lazily acquired repository bindings, and a lease denial is local to the exact
repository target it names. Workspace leases coordinate governed Git mutation;
they never grant or remove host filesystem authority, and future access
isolation is implemented by containing the whole DSH runtime rather than by
leases. The exported contract is documented in
[Workspace identity and leases](workspace-leases.md). The default bundle
activates that service and its strict nils provider before registering runtime
policy, so every agent mutation is classified at the native DSH tool boundary.

Runtime health follows that boundary as well. The bundle owns a typed Cordis
health service and DSH admission/invariant integration, DSH owns lifecycle and
subprocess execution, and nils-cli owns the deterministic doctor/audit
contracts. `runtime-core` blocks activation, `project-docs` gates every
session-associated model stream attempt, and optional child degradation blocks
only dependent tools. DSH evaluates model health before cooperative stream
middleware, so cache, routing, and short-circuit listeners cannot bypass it;
its public post-waterfall tool guard enforces optional-tool health
monotonically. Snapshot projection contains
stable codes and hashed project scopes; no health output or recovery prose is
added to model messages. See
[Native runtime health](runtime-health.md).

## Runtime composition and policy

Live composition has an explicit runtime-root boundary. The package requires
absolute DSH-only agent-hook config, policy, and state paths and passes them on
every dispatch, finish-line, workspace-lease, and doctor invocation. It
likewise requires an absolute DSH-only agent-docs catalog and state root. There
is no ambient XDG,
Codex, or Claude Code fallback. The packaged `agent-docs/` directory is the
source catalog for a copied owner-only activation root; the policy is copied to
an owner-only regular file with link count one before its digest is recorded in
the DSH-only hook config.

`policy/rule-parity.yaml` is the frozen public source inventory, not a
JavaScript rule engine. It authenticates the exact legacy source and exposes
the stable 101-row, 27-capability compatibility contract implemented by the
public parity verifier.

`policy/runtime-rule-parity.yaml` is the internal migration-status projection.
It maps the same source rules into 22 nils capabilities, three stronger
DSH-native seams, and one provider-obsolete retirement. A group becomes
dispatchable only through its implemented runtime owner, never merely by
appearing in this file. The nils `DshCapabilityGroup` schema independently
freezes the 23 deterministic IDs; the cross-repository migration verifier
requires the two ordered sets to match.

All DSH compatibility types and lifecycle names for the supported rolling
release window are isolated in `src/compat/dsh-rc7.js` (the file keeps the
name of the release that introduced the seam; its adapter identity is
`dsh-rolling-v1`). The adjacent `src/compat/contract.js` owns the typed
boot/source diagnostics, while `src/compat/performance.js` owns promotion
budget evaluation. The lifecycle adapter normalizes `agent/session-start`, `agent/pre-step`,
`tools/pre-execute`, `tools/post-execute`, `tools/result`, and
`agent/turn-stopping` into content-free session/cwd/turn/step/call correlation.
It never retains messages, arguments, candidate output, final result bodies, or
subprocess output.

Pre-step proposals are provisional. Concurrent proposals are serialized behind
one in-flight decision for the session position; a contender repeats evaluation
when the owner rejects or aborts. Nils receives the prompt and evaluates policy
only after the downstream DSH decision is `enter` and its signal remains live;
a rejected proposal never crosses the subprocess boundary. The adapter records
turn/step only after that acceptance. Tool
boundaries refresh the open position from the public Session events, so durable
`step/end` and `turn/end` override any cached proposal. Initial attachment
reverse-derives only through the recent matching lifecycle suffix. The adapter
then retains an event count and last-event identity: DSH's immutable snapshots
preserve that anchor across append, allowing only the new suffix to be folded.
An unchanged content-heavy suffix is therefore constant work per boundary. A
missing anchor or shorter history violates the public append-only contract and
makes that attachment sticky-invalid until explicit session restart or a new
Session object reattaches it.

The runtime policy protocol is versioned independently. Tool admission uses
`agent-hook.dsh-ingress.v2`; its exact post-tool correlation uses strict v4 and
projects only `result.is_error`. Accepted pre-step and turn-stop evaluation use
strict v3 shapes normalized to `UserPromptSubmit` and `Stop`. The wires include
the exact session/turn/step and configured absolute agent-docs roots required
by typed nils policy; only pre-step carries a UTF-8-bounded user prompt and an
optional first-step session source. Opaque token and root-call facts remain
process-local. The policy waterfall records an allow or deny marker bound to the exact opaque
execution object, original opaque token, exact Agent and Session references, deep-frozen argument reference,
parent execution token, and cancellation signal. DSH's monotonic denial-only
guard also rederives the live session identity and
rechecks session/cwd/turn/step/call correlation before consuming that
authorization once: missing, stale, substituted, aborted, denied, or
already-consumed markers deny. Correlation survives guard consumption until
the authoritative frozen `tools/result` observer clears it. A
non-authoritative `tools/post-execute` body is never stored; nils receives only
the v4 terminal error bit before downstream and may keep the public DSH post
decision closed until operation completion reconciles. A context decision is
retained only for the exact authorized execution and folded once into the
accepted post-tool decision. Pre-step context is appended only after downstream returns
`enter`; turn-stop context is steered only after finish-line returns allow.
Per-session step/turn dedupe stores one last position, so lifecycle state is
constant-space.

Data policy is a separate strict nils boundary,
`agent-hook.data-policy.evaluate.v1`, enabled only by the exact
`typed-data-policy-protected-roots` reviewed-source selector. A released or
selectorless runtime never invokes this candidate command. In candidate mode,
runtime-kit submits every native and reviewer tool's arguments before the body
and the exact fully materialized result before DSH persists or renders it. Each
request is bound to the session, a random
per-session workspace generation, a digest of the canonical workspace, the
turn/step/call/root-call chain, and the correlated parent call when present.
Replay, missing parent correlation, malformed output, timeout, cancellation,
and companion failure all fail closed. Native tools, MCP tools, web tools,
shells, Code Mode, and explicitly configured provider-opaque tools retain
distinct source classes. The opaque exception suppresses only machine-local
path quarantine; it never permits a detected secret.

Nils owns deterministic classification and returns only a typed action, stable
code, matched stable rule IDs, digests, bounded replacement metadata, and a
content-free audit record.
Runtime-kit never emits the inspected candidate through the audit event or a
denial. Sensitive data is denied at both boundaries. Machine-local paths are
allowed in call arguments but quarantined from final results with only a
SHA-256 locator. The nils protected-root classifier remains available to typed
callers that explicitly supply a canonical target digest and protected-root
rule; ordinary runtime request and result payloads do not claim to derive that
filesystem classification.

DSH first completes its ordinary persistence/result waterfalls, definition
finalizer, downstream listeners, prerequisite contexts, and cancellation
projection. It then invokes the one registered `ToolTerminalPolicy`; no later
content-bearing transform runs before durable persistence or the public result
event. This terminal provider, rather than runtime listener order, is the final
candidate data-policy authority.

Configured `protectedRoots` are also registered with DSH's authenticated
`sandboxPolicy.protect()` service. DSH canonicalizes the target freshly at the
filesystem boundary, rejects direct, relative, lexical-alias, and symlink-alias
writes, and projects the same roots into supported OS sandbox profiles. A host
whose selected sandbox backend cannot express the restriction fails closed
instead of silently weakening it. Runtime disposal removes the dynamic
registration. These native controls are the ordinary runtime authority for
protected-root writes. The JavaScript bundle does not duplicate filesystem or
platform policy. The runtime-owned artifact store root is registered through
the same seam, so model-driven tools cannot write into it directly.

### Governed policy groups

The packaged policy selects eleven Task 3.2, nine Task 3.3, and two Task 3.4
`dsh.policy.v1` groups. Static
command gates are bounded and in-process; project-dev verification and scope
lock checks call only trusted same-release nils companions; checkout leases use
private session-bound state. Owner and semantic-conflict projections use the
explicit DSH subject rather than ambient provider identity. Task 3.3 adds
privacy scans plus bounded memory, health, skill, label, portable-output, and
pre-PR context on exact native boundaries. Task 3.4 records only normalized
activity metadata and defers mutation ownership to an exact `agent-session`
admit/complete lease. The bridge uses a trusted same-release companion with a
cleared environment, hashes provider correlation, persists no tool body or
result, compacts terminal retries by a durable sequence, and treats local state
only as a retry cache. Terminal posts reauthenticate idempotent completion;
Stop calls capability-authenticated broker status and accepts only zero active
and zero uncertain operations. Fully unmanaged sessions are no-op; any partial
managed selector set is invalid.

Default-delivery policy also covers native `write`, `edit`, and mutating
`str_replace_editor` targets. It pins the unambiguous remote-advertised default
branch in owner-private nils state before mutation; the primary checkout's
current branch remains an independent integration fact. It rejects subsequent
repository metadata drift, blocks native writes into Git metadata, and resolves literal
`git -C` and `semantic-commit --repo` targets. Raw commit-producing rewrites on
the default branch are denied, including protected fetch destinations and
stdin/server-driven ref-update plumbing. Sequential shell builtins that can
retarget cwd, exported variables, tracing hooks, command lookup, or aliases
make later command-dependent classification fail closed. Git options and
subcommands that consume nested shell commands are rejected rather than
partially parsed. Exact Git recovery and the owned delivery CLIs remain
available. Scope-lock policy probes run with a cleared environment and a
helper-disabled trusted Git boundary.

`src/governed-commit/index.js` registers the model-facing
`runtime_kit_governed_commit` tool through DSH's public tool and subprocess
interfaces. The tool schema contains only conventional message fields and one
full expected HEAD. Its target is always the canonical live Session cwd; there
is no `repo`, `workdir`, message-file, amend, fixup, or default-branch option.
The WorkspaceLease guard acquires mutation authority for that exact repository
target before the tool body, while native nils policy independently requires
the exact linked worktree and its pinned remote-default projection. JavaScript then resolves
the configured `semantic-commit` executable, spawns one literal argv vector,
joins cancellation and teardown, and exposes only a strict bounded commit
receipt. Branch, staging, expected-head, hooks, and signing behavior remain
owned by nils-cli and Git rather than being reimplemented in the plugin.

The static command gates are transcript guardrails, not a shell or native-code
sandbox. They reject malformed or unmodeled shell grammar, executable
indirection, command consumers, general-purpose interpreters, CLI aliases, and
dynamic security-relevant arguments that the bounded classifier cannot prove.
They do not claim to infer the internal behavior of every arbitrary native
binary or package script. Finish-line containment separately owns process-tree
quiescence, while the governed nils CLIs and provider branch/access controls
remain authoritative for delivery. The public package must not describe any of
these layers as a general hostile-code boundary.

## Specialist review

Specialist review is one DSH-native tool, not eight model-authored personas or
an external agent runtime. `src/review/index.js` loads exactly eight packaged
persona files at server startup and accepts only `{ task, roles }`. Quick review
is exclusive. Runtime-kit registers every persona as one immutable DSH
restricted-role definition with a fixed spawn route, structured output schema,
inspection-only tool filter, read-only sandbox and protected roots, approval
`never`, depth/timeout budget, and per-role capacity. Red-team is
invalid alone and starts only after the first wave settles, either because the
caller preselected it or because a first-wave structured finding is critical.
It receives a byte-bounded rendering of prior structured evidence marked as
untrusted. Runtime-kit starts a role with task content, the exact parent, and a
cancellation signal only; callers cannot supply persona, provider, tools,
sandbox, approval, model options, schema, depth, timeout, or capacity. Each
child must conclude through DSH structured output; runtime-kit validates
semantic and UTF-8 byte invariants again, injects the server-owned specialist
identity, and serializes deterministic nils-compatible JSONL.

DSH owns the bounded process-wide and per-role FIFO admission pools. Provider
capability checks happen before capacity or model work; queue overflow,
cancellation, timeout, role removal, and host teardown are typed and release no
permit until the run is settled and disposed. Results preserve requested order
and expose no child IDs or continuation handles. Runtime-kit keeps only the
review-wave controller needed for ordered orchestration and joins every run on
caller cancellation or plugin disposal.
The reviewer runtime is a child plugin gated on `agents`, `subagents`, and
`tools`. An absent or role-incapable subagent provider leaves that optional
surface unavailable while the parent policy, skills, context, and finish-line
runtime continue to load.
The runtime service exposes a bounded snapshot for both optional children so a
caller can distinguish pending activation from active service and a rejected
activation. Failed snapshots retain only the stable reason and exception name;
details remain in the ordinary runtime log.

Reviewer classification is a DSH host authority boundary. The service clones
and recursively freezes each trusted definition, issues a generation-bound
same-process authority only to providers that advertise restricted-role
support, and requires the provider to classify exactly one unpublished child.
The immutable receipt binds role-registration and execution generations, exact
parent and child session ids, and a digest of the canonical workspace. `roleOf`
recognizes only that exact live Agent object; labels, session events, copied
objects, ordinary starts, and caller-supplied fields grant no role authority.

Inside the unpublished child scope, the in-process driver first joins the
parent agent preset and preserves the parent `meta.cwd`, then atomically mounts
the fixed persona and tool filter, protected-root policy, `sandbox/mode:
read-only`, `approval/policy: never`, and a final monotonic guard. The guard
allows only `read`, `grep`, `glob`, and structured completion and always denies
delegation, even if a malformed definition attempted to list it. The broader
nils lifecycle recognizes a reviewer only through DSH `roleOf`; ordinary and
forged Agents continue through full policy. Data-policy projection remains the
owner of sensitive tool arguments and results, while the read-only sandbox and
protected-root policy independently prevent mutation through aliases and
symlinks.

## Session-owned artifacts

Generated, non-conversational outputs flow through one runtime-owned native
artifact service (`dshRuntimeArtifacts`) instead of ad hoc host paths. Tools
exchange opaque `artifact:<hex>` references that never encode a path, digest,
or session; content identity is a separate verified SHA-256. The service is
loaded through the public bundle and uses only released public seams: Cordis
service registration, `ctx.tools.register` with per-call `exec.agent`
identity, the `agent/disposed` lifecycle event,
live-agent attestation through `ctx.agents`, the sandbox policy service, and
the accepted `protect()` protected-root seam for its own store root. It adds no
DSH source patch and leaves the released image attachment and text spill seams
unchanged.

Five distinct tools (`artifact_write`, `artifact_present`, `artifact_read`,
`artifact_export`, `artifact_dispose`) are authorized only from the exact live
executing agent: the record's owner session and workspace digest must match,
so a copied reference from another session or workspace is denied before any
byte is read. Streaming writes stage under the 0700 store root and publish
atomically; incomplete, cancelled, over-limit, quota-exhausted, and failed
writes leave nothing readable. Two retention classes (`session`, `retained`)
are reclaimed only for the targeted owner lifecycle, `session`-class records
never survive a host restart, references are
revalidated against the durable record and object after restart, and export
produces a typed receipt bound to the exact digest without revealing the
backing location. The contract is documented in
[Session-owned artifacts](artifacts.md).

## Finish-line lifecycle

Finish-line state crosses a strict public open/begin/run/stop command family
plus private quiesce and release lifecycle transports.
For `write`, `edit`, and mutating `str_replace_editor` calls, pre-execute
resolves the target ledger, opens its runner capability, and mints an opaque
operation id; the durable begin registration is awaited at `tools/execute`,
after every pre-execute gate has admitted the exact execution and before the
tool body runs. The workspace-lease service admits after the policy boundary
returns, so registering earlier would leave a validation obligation on a
repository whose target the lease then denied and never dispatched. A durable
registration failure is therefore a dispatch-time tool error rather than a
`finish-line-unavailable` pre-execute denial: the body still never runs, the
ledger is poisoned for the session when the outcome is ambiguous, and a
cancellation that arrives before anything was sent poisons nothing.

Each ledger is keyed by the repository the operation targets, not by the session
anchor. A `bash` validation already binds to its own working directory; an
editor tool exposes an exact path but no repository root, so the ledger reuses
the canonical target the workspace-lease service already resolved and
authenticated for that exact execution rather than deriving Git identity a
second time. One session that edits repositories A and B therefore owns two
ledgers, and the stop boundary requires and releases each one independently. An
operation the provider proved touches no repository registers no edit generation
anywhere, so a non-repository write creates no Git validation obligation. When
the target projection itself fails, the ledger propagates the workspace-lease
service's own typed cause rather than replacing it with a finish-line reason:
that service denies the same execution with that cause immediately afterwards,
and the root cause has to survive the pipeline.
The retry token is minted inside the wire client and never becomes a service or
model value. File payload, filesystem observations, and final tool results are
not converted into a second finish-line report.

Every foreground `bash` call uses a two-call run protocol. The coordinator
first opens a nils-owned runner capability for the session with a private
caller-held attempt token, then sends the
intent, exact command bytes, and a fresh operation id without execution
metadata or child environment. The non-executing probe returns `ready` for an
exact current validation target and `ordinary-ready` for every other foreground
command. `run_in_background` is rejected before nils invocation, and a legacy
`not-applicable` response poisons the session instead of delegating execution.

Either ready status causes DSH to flush the session and prepare, but not
execute, the runtime. Public shell and sandbox services resolve the exact
command, canonical repository cwd, timeout, output bound, environment
overrides, and one unsandboxed, full-access, or confined runner descriptor.
Requested sandbox escalation remains governed by DSH's own approval service.
The adapter rejects runtime preparation if command text changes, cwd escapes
the repository root, or bounds and provider argv are malformed.

The `danger-full-access` descriptor is the explicit native full-host authority
profile. Nils may place that command in a transient user cgroup for lifecycle,
timeout, output, cancellation, and descendant cleanup, but it must preserve the
host user's namespaces, IPC and network families, localhost, supplementary
groups, user bus, and daemon sockets. Permission restrictions belong only to a
confined runner. Future isolation for the full agent belongs at a reviewed
whole-runtime container boundary, not in a second per-command host sandbox.
Work that a full-host command deliberately delegates to the user manager lives
outside the command cgroup and is therefore outside finish-line's descendant
cleanup claim.
This authority profile describes technical host reachability, not action
authorization or secret projection: DSH policy and approval still decide which
actions may run, and the runtime's credential-scrubbed child environment remains
unchanged.

The second run carries that prepared runtime and its bounded child environment
to nils. Nils is the sole executor and durable recorder: it invokes the exact
runner once, classifies the observed exit, signal, timeout, abort, bounded
streams, and sandbox facts, and returns the recorded execution. For `ready`,
nils reserves the exact target before launch and may record validation evidence.
For `ordinary-ready`, nils first advances the shared repository generation,
executes once, and returns `ordinary-applied` without creating target evidence;
the generation advance makes any earlier validation stale. The adapter
materializes either response as the normal DSH foreground Bash value and never
calls the underlying Bash tool or infers another outcome afterward.

Observed execution outcomes cross a closed runtime boundary. Exactly one of
`exitCode` and `signal` must be non-null, any signal must be a canonical
`NodeJS.Signals` name from the client's explicit allowlist, and `timedOut` and
`aborted` are mutually exclusive. An arbitrary signal string, both or neither
termination discriminators, or simultaneous timeout and abort is not projected
as a typed result. Each invalid combination invalidates the execution-bearing
response and enters the same authenticated private quiesce path before the
caller receives the validation error.

Authoritative execution is Linux-only. Nils verifies its systemd executables,
runs each exact or ordinary command in a transient user cgroup, and records only
after the unit is quiescent; unavailable containment and non-Linux hosts fail
closed. The precise boundary is owned by the
[nils finish-line contract](https://github.com/sympoies/nils-cli/blob/main/crates/agent-hook/docs/specs/agent-hook-v1.md#native-dsh-finish-line).
It covers the tested descendant-lifetime and cgroup escape paths, but is not a
general network namespace and does not promise to block every network or IPC
delegation mechanism.

The contained runner has no mutable path-based configuration handoff. Nils
serializes the canonical cwd, exact argv, bounded environment, and supervisor
PID into a read-only memfd and applies write/grow/shrink/seal seals. The
systemd `OpenFile` properties transfer that sealed config and `/proc/<nils
pid>/exe` as named read-only descriptors, pinning the exact runner inode across
launch. Nils reads the runner's dynamic ELF interpreter and accepts it only as
a root-owned executable regular file without group/world write bits. That
interpreter starts the runner from the inherited descriptor; the runner opens a
pidfd for the recorded supervisor and terminates its command process group if
the supervisor identity disappears.

Every failed execution-bearing run has a second cleanup boundary beyond the
DSH-owned subprocess handle. Transport failure, an unexpected agent-hook exit
or signal, invalid JSON, envelope, schema, or result fields, caller
cancellation, deadline, and plugin disposal all cause the client to await an
adapter-private nils quiesce request carrying the same
repository/session/turn, operation ID, and runner capability. Nils stops the
exact durably recorded transient unit and reports success only after its unit
state is terminal and its cgroup is unpopulated, then removes the still-matching
pending operation. The client does not return the original failed-run error
before quiesce finishes. A successful quiesce preserves and then returns that
original error; failure, timeout,
malformed output, or uncertain unit state from quiesce itself permanently
degrades finish-line admission closed. Quiesce is an internal recovery
transport, not a public model-facing operation.

The wire client treats each authenticated failed-run cleanup promise as active
lifecycle work, independently of the primary invoke it follows. Disposal first
closes admission and cancels active invokes, then awaits their settlement and
drains every quiesce promise registered by the outer run failure handler. A
delayed quiesce therefore keeps both disposal and the reported active count
open until cleanup settles; disposal cannot return merely because the original
invoke has left the active-request set. Quiesce succeeds only when its response
has the expected schema, status, and operation ID and the quiesce subprocess
tree is known to have exited. A semantic mismatch or unknown process-tree
quiescence permanently degrades admission, leaves no active lifecycle work
after bounded settlement, and rejects every later request.

Successful open, begin, run, stop, and release responses carry an opaque nils-issued
repository/session correlation ID. The session ledger requires the same value
throughout its lifetime; missing, malformed, or changed correlation poisons the
ledger and blocks stopping. The ID is a response-side assertion only: strict
nils requests continue to carry independently validated product, session,
turn, and repository root fields, with no consumer-selected correlation value.

Open is create-only for a live session. The wire client retains one private
attempt token, retries an ambiguous response with the same binding, accepts
`opened` or `duplicate`, and requires the nils-derived capability to remain
unchanged. Successful replay renews a 24-hour lease. Nils may reclaim only an
expired quiescent crash orphan and its terminal evidence; this makes stop block
until revalidation. Lease expiry alone never clears pending state. Capacity
recovery for an expired busy orphan requires every operation to retain an exact
systemd unit and trusted stable stop/status, job, and cgroup quiescence proof;
active, indeterminate, or unbound sessions remain protected.

Rc.7 dispatches `agent/disposed` without awaiting listener promises. The event
listener therefore synchronously registers a coordinator-owned release task.
Coordinator disposal closes normal admission, cancels active nils invokes, and
awaits their authenticated quiescence. Only then does it register release for
every remaining ledger, drain those tasks, and close the nils client. The
client's intermediate drained state admits only authenticated `release`; final
dispose closes that last private transport.
Release waits for any capability-open attempt, refuses a still-prepared tool
reservation, and authenticates with the exact capability. Nils refuses pending
or active-unit operations, removes terminal records only after quiescence, and
keeps a bounded digest-only tombstone for exact retry. That tombstone retires
the released capability incarnation, not the stable DSH session ID: a new DSH
runtime normally resumes the session with a fresh private open token, while the
old release remains duplicate and cannot delete the new incarnation. The
tombstone authenticates only a recent duplicate release. If attempt material is
reused after release, every new nils incarnation still includes a persisted
monotonic sequence and returns a byte-distinct capability, so bounded tombstone
compaction cannot restore the retired bearer.
The coordinator keys its release barrier by stable repository/session identity,
not the JavaScript Session object: an immediate same-ID resume awaits the prior
release and open-token rotation before it can begin finish-line work. The
coordinator retries once and deletes the strong Session ledger only after a
matching response; an
unrecoverable release closes later admission. Edit begin tokens are retained
only across an ambiguous immediate retry and explicitly abandoned on poison.

At awaited `agent/turn-stopping`, the coordinator calls the typed nils stop
boundary directly. Typed blocks use public
`agent.steer(createUserMessage(...))`; bounded repetition ends closed instead
of producing an infinite same-turn loop. There is no deferred result queue,
shell `EXIT` trap, or command rewriting. The adapter exposes no model-facing
review authority or manual evidence mutation. Its wire client projects only
typed lifecycle fields; unknown fields, including a capability-shaped field,
are discarded rather than logged, persisted, steered, or returned.

Both authorization and lifecycle correlation use the exact execution object as
their stable cleanup key. The original token has a separate owner index for
lookup and duplicate rejection. If a listener replaces the mutable token
property, the guard denies while `tools/result` still removes the original
marker, correlation, and token-owner entry; another execution object cannot
replay them.

`src/policy/nils-transport.js` owns one bounded operation per child process.
The first observed caller abort, deadline, or plugin disposal classifies the
failure. Admission closes before disposal cancellation. Child `done` is
observed with a rejection handler, while `waitForExit(signal)` and a consumer
race bound teardown even if a provider ignores the signal. Confirmed
quiescence releases capacity. Unknown quiescence permanently degrades admission
closed, cancels every sibling while preserving any earlier first cause, and
returns a bounded fail-closed result. Degradation advances a monotonic admission
epoch; the guard rejects an earlier allow marker even when it was already out
of the transport set and waiting for DSH approval. The subprocess receives a
fixed argv vector, explicit bounded stdio, an absolute session cwd, no shell,
no forwarded environment, and no spill or unbounded output path.

## Authoritative completion acceptance

`src/authoritative-acceptance/index.js` composes a nils-owned durable verdict
over this finish-line authority. Trusted consumers register exact visible tool
definitions as mutation invalidators or requirement validators. Runtime-kit
binds admission and final observation to the same DSH execution object and
shares the existing private runner capability without exposing it through the
public `dshAcceptance` service.

Contained Bash validators are selected from the exact probe reservation;
ordinary Bash keeps the finish-line path above and advances the shared nils
generation without producing evidence. Non-shell mutations advance generation
before their body, while non-shell validators terminalize only from the final
DSH result. Turn stop asks nils to reserve an all-satisfied verdict under the
repository lock. The authenticated `native-execution-boundaries-v5` patch
consumes that exact cached reservation synchronously before GoalService
completion state changes; a detached verdict without a live reservation is
diagnostic only. Runtime-kit retains the exact runner capability until the
provider accepts the successful completion observation, cancels the reservation
when later lifecycle policy rejects stop, and partitions local mutation
invalidation by nils-authenticated canonical repository `cwd`. Acceptance
control RPCs share one bounded teardown deadline across their idempotent retry,
so disposal cannot inherit a validation-length wait. Goal consumption claims
the reservation locally before its asynchronous provider observation, which
prevents a same-repository mutation from cancelling the same operation while
nils retains cross-process contention authority. Registration and completion
terminalization remain resource-visible and are joined before capability
release or canary success. The public service exposes only the bounded
completion settlement status, and packed evidence requires `succeeded` plus a
non-degraded finish-line transport after resources drain; it never exposes the
capability, operation identity, generation, or provider diagnostics.
Completion cancellation shares the same joined lifecycle task accounting, so
policy, validator, mutation, agent disposal, and coordinator disposal cannot
race past a still-active provider observation. Repository preparation enters
that accounting before its first await, is shared by canonical repository
across distinct executions, and removes each affected provisional mutation
state when preparation or its caller-specific lifecycle fence fails.

The session projection is explicitly non-authoritative and uses only standard
tool events, preserving old-runtime rollback reads. Detailed registration,
failure, persistence, and rollback semantics are in
[authoritative completion acceptance](authoritative-acceptance.md).

## Selective runtime context

`src/context/nils-context.js` owns a separate bounded subprocess lifecycle for
`agent-docs session context`. A tool call derives the exact DSH Session id and
absolute cwd from the live Agent, mints a fresh request id, and asks nils to
resolve, budget-check, fingerprint, and persist one intent atomically. The
transport validates an exact `cli.agent-docs.session.context.v1` envelope and
`decision.context.v1` payload, including request, product, intent, optional
phase, document count, and UTF-8 byte count. It never trusts a previous tool
result as authorization. Nils remains the owner of session/project/product and
catalog-content replay binding; the plugin removes correlation and filesystem
metadata before DSH materializes the canonical tool result.

The tool result itself is the only model-facing context delivery path. Nothing
is attached to the system prompt or session-start event, and the plugin does
not duplicate the same document through `deferContext()`. The public tool
schema allows only `project-dev`, which deterministically selects phase `edit`;
the transport repeats the same allowlist check before spawning `agent-docs`.
Workflow code will prepare review and delivery phases at their own boundaries.
Context cancellation, timeout, and disposal join the complete child process
tree. Unknown quiescence permanently closes this context surface but does not
change the independent monotonic policy-transport state.

The security boundary ends at DSH's monotonic guard. Public `tools/execute`
wrappers run afterward, but they cannot bind an exact agent-scoped definition
through HMR, cancellation, and the full post waterfall. Runtime-kit therefore
does not use a wrapper as a transaction boundary. The authenticated native
seam below binds one registry-owned execution to one exact definition.

## Automatic tool prerequisites

`src/prerequisite/index.js` assigns process-local identities to the exact
Agent, runtime workspace generation, and visible `ToolDefinition` object. It
uses the version-scoped `tools.bindPrerequisite` seam supplied by
the `native-execution-boundaries-v5` release artifact selected through
`compatibility/dsh-patches.json`.
The default mutation surface (`bash`, `write`, `edit`,
`str_replace_editor`, and `runtime_kit_governed_commit`) requires the named
`project-dev-context` capability. Another trusted bundle may attach the same
capability to an exact visible definition through
`dshRuntimeKit.prerequisites.require(definition, capability)`; its disposer is
registration-bound and cannot erase a later declaration.

At `tools/pre-execute`, after DSH correlation exists but before nils policy,
the coordinator asks `agent-docs session prerequisite` for a side-effect-free
decision. The receipt binds hashes of the DSH session, repository, Agent,
workspace generation, call, turn/step, tool name, visible definition, and the
resolved `project-dev`/`edit` policy fingerprint. The strict v5 policy ingress
carries that exact proof. Older ingress versions remain available for tools
without an automatic prerequisite and cannot partially parse v5 fields.

Immediately before the selected body, patched DSH proves that the registered
definition is still the exact bound object and invokes a second side-effect-free
`session prerequisite` and policy check. HMR replacement, declaration disposal,
stale or cross-scope receipts, policy drift after an approval, and cancellation
fail before the body. DSH then runs the body and the complete
`tools/post-execute` waterfall, finalizes result content and context, and
linearizes the accepted result. Post-policy rejection, downstream exception,
body failure, cancellation, and finalizer failure therefore produce no cache
completion.

Only after accepted completion has linearized does DSH invoke
`commit-prerequisite`. That call is an idempotent cache-completion optimization,
not activation, authorization, or the mutation's transaction boundary. The
runtime retries the exact receipt once when completion is uncertain; continued
ambiguity logs one stable warning while preserving the already-finalized result
and its verified context. Later calls freshly revalidate and reconcile the cache.
The completion transport detaches only caller cancellation while retaining its
own timeouts, disposal, process-tree quiescence, and fail-closed admission.
Concurrent pending calls may verify together, but every execution binds only
its own latest verified context. Cache completion converges idempotently without
duplicating context inside one execution.

Public DSH registry APIs cannot provide this exact transaction: an agent-scoped
definition cannot be wrapped at the same layer, `tools/change` carries no
definition identity, and HMR can replace the selected body after admission.
The same patch supplies an effect-owned asynchronous `llm.guard` before DSH
enters the `llm/stream` waterfall. Public `agent/pre-step` and `llm/stream`
middleware are cooperative: a later prepended listener can skip downstream,
so neither can prove that a health check precedes every cache, routing,
short-circuit, or adapter path. The native guard is monotonic and returns a
stable denial code without adding health text to model messages.

The patch also supplies `SubprocessRuntime.spawnDescriptor`, its explicit
`descriptorSpawnMode`, and a local implementation. Runtime-kit authenticates
private executable copies, opens them read-only, and retains the mode-`0500`
links under one mode-`0700` random directory only for child self-resolution.
Those names are not execution authority: the provider maps the selected file
description to child fd 3 and executes the child-owned `/proc/self/fd/3` in
`atomic-descriptor` mode on Linux. The links and descriptors remain owned until
all child scopes settle because `current_exe()` and `process.execPath` resolve
the executable name after spawn. Disposal removes only names that still bind
the authenticated inodes; replacements are preserved, and a renamed private
root can leave a bounded residue with a host warning rather than authorize
pathname cleanup.

Darwin exposes no supported descriptor-only exec primitive, so its declared
`verified-transient` local provider copies the exact descriptor bytes into a
mode-`0500` file under a fresh mode-`0700` random directory for each spawn. It
caps the executable at 256 MiB, verifies the source identity, size, timestamps,
target metadata, and SHA-256 digest, invokes the native spawn call with the
requested `argv[0]` as display identity, requires every temp-parent ancestor to
be owned by root or the current UID, rejects an untrusted writable chain, and
revalidates the private directory and executable identity immediately before
spawn. It retains that transient until the whole
child process tree settles so descendant self-inspection remains valid.
Synchronous spawn failure and process-tree settlement both trigger inode-bound
removal. Foreign replacements and unexpected unlink failures are preserved
with host warnings; the provider never reports those residues as successful
cleanup or reuses them. A provider with a missing or platform-mismatched mode
fails closed instead of silently falling back to the replaceable runtime
snapshot pathname.

The same version-scoped patch keeps DSH's native Bash and filesystem mutation
tools usable when a tool-call protocol concretizes their optional escalation
fields. If the requested mode is already effective, or is the schema's
`workspace-write` floor while the effective mode is `danger-full-access`, a
blank `justification` cannot widen authority and is normalized to an ordinary
call before native dispatch. A missing paired field, any nonblank request, or
any other mode shape continues through DSH's original pairing, strict-wider,
approval, and denial checks. This compatibility normalization adds no policy
engine and cannot grant a wider mode.

The patched DSH sandbox exports the non-widening echo classifier as the single
owner of that mode matrix. Native tool wrappers require an explicitly blank
paired justification so their public pairing contract stays fail closed. The
runtime-kit finish-line adapter delegates to the same classifier but also
accepts a missing justification for a same-mode echo because it is revalidating
an already captured validation operation, not admitting a new native tool
request. Tests pin this intentional wrapper difference so the classifier cannot
drift across the two execution paths.

The compatibility contract declares that classifier alongside the sandbox
symbols DSH publishes itself, so a DSH without the downstream patch is refused
at load with `DSH_RUNTIME_KIT_INCOMPATIBLE_DSH` naming the missing identity
rather than failing later from the policy path. Registry-installed peers never
carry the patch, so that refusal is the expected outcome of a plain install.

The Darwin transition is necessarily path-based between verified
materialization and the kernel's spawn operation. The private random pathname,
trusted-parent validation, and pre-spawn identity check remove ordinary
worktree and concurrent-agent collisions and bound the package-owned process
tree lifetime, but macOS cannot make that transition atomic against a
malicious same-UID process. That platform limitation is a documented residual
risk; Linux remains descriptor-native end to end. Retaining private
self-resolution links also permits malicious same-UID unlink or rename to deny
self-inspection, but cannot substitute execution bytes on Linux. This boundary
protects ordinary worktree, concurrent-agent, stale-path, and ambient binary
replacement. It is not a sandbox against arbitrary malicious code already
running as the same UID, which can also alter the surrounding user runtime.

Compatibility acceptance follows that platform boundary. Linux runs the
complete packed runtime, including authoritative nils finish-line validation
inside its required systemd/cgroup containment. The blocking macOS lane instead
runs a packed runtime-health smoke through DSH's real tools pipeline: it proves
companion authentication, fail-closed project health before model or adapter
work, same-session recovery, context non-disclosure, and the plus-one tool
result. It does not reinterpret `finish-line-containment-unavailable` as an
advisory success. Patch reversal, pristine rebuild, CLI startup, exact build
closure, and clean-checkout proofs remain mandatory on both platforms.

The narrow downstream patch is therefore maintained in this repository rather
than a fork or upstream PR. `compatibility/dsh-patches.json` authenticates the
patch and every before/after file hash for each supported revision; targets
whose release contents differ carry release-specific hash pairs. Apply and
reverse reject unknown revisions, partial state, content drift, or unrelated
checkout changes. Nils remains the sole owner of catalogs, policy resolution,
receipt semantics, and durable activation; the patch owns only exact DSH
execution ordering, result/context attachment, pre-waterfall model admission,
descriptor-bound local subprocess launch, and the bounded non-widening schema
echo normalization above.

## Private skill discovery

Private skill source remains outside this public repository. At process start,
the loader validates the configured owner-controlled tree with bounded
asynchronous traversal and no-follow reads, copies it into a sealed temporary
snapshot, and registers definitions parsed from those retained bytes. Project
skills rank above the snapshot, which ranks above bundled public skills.

## Operations and activation

Released DSH supplies the host mutation primitive and nothing more: `dsh plugin`
forwards to pnpm and reconciles `dsh.profile.bundles` from the installed state,
`@deepseek-ai/dsh-app-boot` owns the profile manifest and bundle resolution,
and there is no profile transaction, plan, digest, ownership ledger, rollback,
repair, or admission gate on the host side. The transaction therefore lives in
this package as a native extension around those public seams rather than as a
DSH source patch. The package declares its contract in
`compatibility/profile-lifecycle.json` (`package.json#dsh.lifecycle`): owned
profile and home surfaces, generated runtime-root surfaces, activation assets,
compatibility sources, native companions, migrations, pre-activation health
probes, the absence of package-manager lifecycle scripts, and owned-only
removal. The engine reads that declaration from the exact reviewed artifact,
validates it against the fixed vocabulary it implements (malformed is
`invalid-lifecycle-manifest`; well-formed but beyond the engine is
`unsupported-lifecycle-manifest`; any install-time script is
`lifecycle-scripts-declared`), binds its digest into the reviewed plan, refuses
a package whose declared DSH releases exclude the bound host before any
mutation (`package-incompatible-dsh`), and runs the declared health probes
against the staged asset set before the pending marker and the native
mutation (`activation-health-failed` refuses the transaction with nothing
mutated). Recovery finalization of a transaction the host already applied
repeats the probes, requires the live toolchain to equal the bound one, and
re-reads the declaration from the authenticated artifact. A package without a
declaration is admitted under the engine's own compatibility manifest and
reported as undeclared, and its receipts omit the lifecycle key so the accepted
baseline engine can still read them.

The repository-owned generic deploy dispatcher (`.agents/scripts/deploy.sh`,
implemented in `src/deploy/index.js`) is the shared `meta:deploy` target and
sits strictly above that plane. It binds an explicit scope — an immutable
packed artifact plus its digest, one DSH home and profile, one owner-only
runtime root, the DSH executable, and the requested phase — authenticates the
artifact into a deterministic digest-keyed stage, and invokes the same
preview/apply protocol through the owner launcher. It duplicates no activation,
rollback, package, lifecycle, or health decision: every profile refusal is the
engine's, surfaced unchanged with its code and exit status, and the dispatcher
adds only typed scope refusals, a canary/primary scope guard that keeps
candidate acceptance away from a live profile, and a bounded resumable receipt.
[Operations](operations.md) documents the contract.

`src/operations/index.js` is an out-of-process management plane and never edits
DSH profile JSON or its bundle list. It resolves one strict profile name and one
exact package target, hashes the complete observed profile manifest plus its
private receipt, and emits a deterministic dry-run plan. A local target is
packed with lifecycle scripts disabled; the plan binds the tarball SHA-256 and
the canonical extracted package-tree digest; apply regenerates that exact
artifact into a private content-addressed store and verifies the package tree
DSH actually installed. The published artifact bundles the complete exact
runtime dependency closure, and its tarball SHA-256 binds those dependency
bytes. The installed-tree projection excludes only the package root's
top-level `node_modules` materialization because pnpm may normalize that
package-manager-owned subtree; every other package-owned path, type,
executable role, size, and byte remains bound. Apply requires the reviewed digest and evaluates
duplicate or current-plan state only while holding a global artifact plus
per-profile SQLite transaction, so process exit releases both kernel locks
without pathname-based stale-lock reclamation. A completed digest-only replay
may omit the now-unneeded source; a supplied source must still resolve to the
same reviewed target. All
actual package mutations run through `dsh plugin --profile ... add/remove`.
Runtime-kit state is atomically written under
`DSH_HOME/runtime-kit/state/<profile>.json` with mode-restricted temporary
files, file and containing-directory fsync, and no-follow owner-private path
checks. It stores only exact target/artifact/package/version/installed-tree/bundle-index
receipts, previous rollback identity, plan metadata, and a pending transaction
marker—never skill content, prompts, credentials, or unrelated configuration.
Under the global lock, reconciliation scans every strict profile receipt,
retains current/previous/pending/terminal artifact references, deletes only
exact unreferenced digest archives and interrupted temp names, and fsyncs the
store. Admission is capped at 64 archives, 1 GiB total, and 128 MiB per archive.
The shared bounded archive parser rejects more than 256 MiB expanded, 16,384
regular-file entries, 64 MiB in one entry, or unsafe package paths before the
operations plane invokes system `tar`, so those post-extraction tree limits are
also pre-extraction admission limits.

Activation assets have a separate root-scoped inventory. The first mutation
atomically binds the canonical runtime root to one canonical `DSH_HOME`; a
SQLite root lock serializes activation and collection, and a different home is
rejected. One compatibility seam admits an ownerless pre-ownership v2 tree only
through digest-bound `doctor --repair`. It ties the selected root to every
current, previous, pending, and last-applied reference from the same canonical
DSH home, authenticates the installed and active current-or-pending targets,
and requires an exact retained-set inventory before atomically writing the
owner record. Each retained digest must resolve to one authenticated target
from a strict version 2 current, previous, or pending receipt; its policy,
catalog, document, and root-specific hook configuration must match on disk.
The activation writer, active reader, and retained-set validator share one
canonical configuration renderer and require byte-for-byte equality. A valid
TOML file that selects an alternate path or digest cannot authenticate itself
by repeating the expected assignments in comments or extra sections.
The receipt binds the bounded tree's sorted path/type/mode/link/size/file-hash
digest plus its byte count. Cross-home, unmanaged, drifted, missing, extra,
staging, oversized, malformed, targetless, or conflicting candidates cannot
be adopted.

Active reads canonicalize and validate the runtime root before opening the
manifest, then lstat every component below that root without following
symlinks. The versioned asset-set, hook-assets, and docs-home directories are
real owner-private directories; config, policy, catalog, and document leaves
remain inside the canonical asset set. Each asset surface is disjoint from
both mutable state roots, and the hook and docs state roots are mutually
disjoint. An absolute root reached through a symlinked parent is compatible
only after it canonicalizes to the same real owner-private root; no symlink
inside that canonical root is admitted.

The adoption receipt also binds one protocol-consistent provenance row:
installed terminal state is `current/current`; removed terminal state is
`absent/absent` only when current, previous, and pending are null, the
last-applied remove is authenticated to the selected root, and the global
authenticated profile inventory retains zero references to activation sets.
The owner-only asset directory may contain up to 16 reviewed unreferenced
digest directories left by the pre-ownership remove; each is subject to the
normal owner, link, topology, count, and per-set byte bounds, and its digest
byte count, and canonical tree digest are adoption evidence. Adoption leaves
those bytes untouched,
while the next authenticated setup or update removes them through ordinary
reconciliation. Update and rollback `prepared` state may be
`current/current` or `pending/current`; update and rollback `native-applied`
state may be `pending/current` or `pending/pending`; setup is adoptable only as
`native-applied/pending/pending`. Pending remove retains the authenticated
current snapshot and exact asset set: prepared permits `current/current` or
`absent/current`, while native-applied permits `absent/current` or
`absent/absent`. Undefined pending phases, remove `current/absent`,
`current/pending`, and ambiguous multi-row matches fail closed. The selected
actual source, activation source, pending phase, and pending action are
digest-bound, and apply-time revalidation failures are plan drift before
ownership mutation. The conversion uses an explicit durable-evidence
allowlist; command-supervisor, isolation, and configuration errors retain their
typed diagnostics instead of being misreported as plan drift.

Reconciliation scans strict v2 receipts from that home and the active manifest,
retains only current, previous, pending, active, and currently projected sets,
and deletes unreferenced digest directories plus hidden pre-pending staging
orphans. At most 16 live sets may be retained; each set has its independent
4 MiB package-asset plus 64 KiB generated-overhead bound, which derives the
complete count-times-per-set ceiling. Every member is owner-only, single-link,
depth/count/size bounded, and free of symlinks or special entries; inventory
ambiguity fails closed rather than collecting an unknown path.

The pending marker precedes the DSH subprocess. A failed or interrupted native
command therefore leaves a diagnosable transaction. Doctor compares the exact
observed terminal state with the reviewed target and previous receipt: it may
plan `finalize` or `clear`, while any third state remains ambiguous and closed.
Pending and terminal records are strict closed schemas whose plan digest,
operation, target, and proposed recovered receipt must agree; an existing
unmanaged installation is not adopted by matching version alone.
Local and exact-registry targets are both script-free packed before mutation;
their reviewed archive and installed-tree digests are retained in the pending
receipt and content-addressed store. Interrupted finalization therefore
requires the observed dependency path, bundle row, package identity, version,
and installed tree to match that pre-mutation evidence. The advisory
`prepared`/`native-applied` phase helps diagnosis but is not the authority, so a
crash between native success and the second state write remains recoverable. A
nonzero or otherwise ambiguous DSH result cannot be adopted by version alone.
Remove verifies DSH already removed the dependency and bundle row before it may
delete the one fixed final package entry sometimes retained for a local
file/link install. Every intermediate profile/package path must be a real,
owner-controlled directory, so cleanup cannot traverse a scope symlink. Native
DSH, npm, and nils diagnostics use resolved executable identities and a minimal
explicit environment; returned failures expose only bounded stderr size and
SHA-256, never raw child stderr. This narrow cleanup cannot address another
dependency, profile user patch, or private-skill source.
Health, package inspection, and native mutation subprocesses have fixed
30-second, two-minute, and ten-minute ceilings. The synchronous outer owner
launches a private supervisor through `setsid`, retains the resulting PGID,
kills any group that remains after timeout, supervisor loss, or direct-command
return, and waits for its absence before unwinding both SQLite transactions.
Failure to prove settlement remains closed.

## Compatibility and performance

Upstream compatibility is executable: pack the bundle, install it into a clean
profile, dump the composed config, boot DSH, discover skills, and drive a real
Agent/AgentLoop allow/block probe plus cancellation and plugin-disposal drains.
All `@deepseek-ai/dsh-*` peers used by the compatibility adapter must form one
homogeneous exact `0.1.1-rc.2`, `0.1.2-alpha.4`, or `0.1.2-rc.1` set; Cordis may be
`4.0.1` or `4.0.2` according to that DSH release. The adapter uses the same reviewed public surface for both
retained and current releases and rejects mixed or later prerelease identities before import.

`compatibility/dsh.json` is the closed promotion input. It records the exact
`0.1.1-rc.2`, `0.1.2-alpha.4`, and `0.1.2-rc.1` release identities, the rolling
three-release support policy, the pinned
tag, one exact upstream-next revision, every consumed public package/export,
the runtime service-method surface, the deterministic in-memory pre-tool
budget, and the packed released-agent-hook subprocess budget. The
checkout inspector requires an exact clean Git root, hashes the declared built
public entrypoints without executing checkout bytes, and rechecks cleanliness
after inspection. The selected artifact path additionally derives the complete
DeepSeek workspace dependency closure from package metadata, rejects missing or
unreachable members, and compares each regular-file-only tarball to a reviewed
canonical digest that normalizes package-manifest key order. One receipt binds
channel, revision, package identity, canonical digest, and actual tarball
SHA-256. Linux CI stages exactly that closure without DSH registry resolution,
after an `--omit=peer` install supplies the five exact, lockfile-bound external
runtime dependencies without lifecycle scripts. Every DSH target must be
absent. Direct extraction remains beneath retained `O_NOFOLLOW` directory
descriptors and performs no rename or pathname cleanup; if extraction fails or
a visible target is swapped, the job fails closed and the disposable consumer
is rebuilt. Runtime apply independently resolves every public peer version before
the first import, then validates consumed export kinds and the Context/service
method shape before any DSH registration. These checks intentionally do not
infer compatibility from a semver range or inspect private implementation
helpers. Package CI downloads the exact nils-cli `1.27.37` archive, authenticates
its retained SHA-256, and runs the packed candidate through the real
`agent-hook` subprocess boundary; p95 or post-disposal child/admission leakage
blocks promotion.
The reviewed-source candidate additionally runs a packed end-to-end tool
lifecycle benchmark against the exact candidate `agent-hook`. Each measured
iteration performs the persistence data decision, generic pre-tool decision,
pre-call data decision, generic post-tool decision, and terminal final-result
data decision in production order. Promotion requires all five subprocesses,
p95 at or below 1,000 ms, and zero transport admission or live-child leakage.
Each receipt artifact is bounded to 128 MiB compressed, 256 MiB expanded,
16,384 regular-file entries, and 64 MiB per entry. Staging authenticates the
whole closure first but retains only paths and digests; extraction rereads and
rehashes one artifact at a time, so closure size does not multiply retained
artifact buffers.

The controlled benchmark executes the real nils transport encoder, request
correlation, output validation, settlement, and operation accounting against
an in-memory deterministic provider. After 250 warmups it measures two
1,000-check batches, computes p95, forces GC around each retained-heap interval,
and checks active operations and live provider handles before disposal. Its
5 ms p95, 8 MiB per-batch retained-heap, and 2 MiB cross-batch growth ceilings
are promotion budgets for runtime-kit overhead. Disposal is a separate zero-
active/zero-live assertion. These are not claims about external process startup
or host scheduling; the packed real DSH smoke remains the integration proof for
those external boundaries.

## Acceptance

[`docs/acceptance.md`](acceptance.md) is the canonical owner for current
acceptance and promotion requirements. This section records the architectural
rationale and implementation boundary behind that contract.

Acceptance is a separate promotion boundary. `scripts/run-acceptance.mjs`
copies six content-addressed nils executables into a private run root, fixes the
tool PATH, creates disposable HOME/XDG state, and snapshots the package before
candidate code runs. It clones the manifest-selected DSH commit without
hardlinks, installs the frozen dependency graph offline, rebuilds the host
libraries, and checks the fresh checkout through the same compatibility
contract. Operations receives two complete package variants derived from the
snapshot, while the runtime leg executes a later fresh extraction of the same
authenticated tarball. No extracted candidate tree is reused across legs.
Scenario program digests, the package tarball digest, selected DSH public
closure, and every executable digest are rechecked after execution. Each
scenario is a separate transient user-systemd service with
`KillMode=control-group`, a hard runtime deadline, and an explicit 0022 umask;
it cannot report completion while same-group descendants remain.

The summary contract owns explicit producer/scenario IDs rather than deriving
several scenarios from shared booleans. Its scope is `functional-session`, not
a host-wide no-legacy assertion. Local source rehearsal is deliberately not an
adversarial sandbox because finish-line containment needs the user systemd bus;
it therefore cannot promote. A final pass additionally requires a disposable
OS-isolated runner, exact released nils provenance and six artifact hashes, and
authorized semantic-commit/forge-cli evidence bound to the same random run ID,
canonical repository, exact head, ordered no-merge delivery steps, and provider
read-back. The scenario receipts additionally bind a DSH-profile zero-dependency
check for `agent-runtime-kit`, unchanged Codex/Claude wiring sentinels, and no
cross-loaded provider hooks, skills, or session state. Invalid matrices are
typed failures with a nonzero exit.

The candidate repository is not allowed to attest its own isolation or nils
release provenance. Consequently the checked-in runner exposes only the
trusted-code source rehearsal and always leaves promotion incomplete. The
selected external driver lives in the private `serenvia/sympoies-infra` trust
domain. It authenticates official nils release assets before candidate
execution, runs the exact head and packed digest under a separate
credentialless network-denied UID on a disposable GitHub-hosted VM, stops its
user manager, and proves the UID process-free before accepting candidate
evidence. An independently maintained control manifest pins the seven
candidate files that define the runner, scenario contract, staging, DSH
compatibility closure, and two smoke programs. The trusted controller does not
import those modules; candidate code executes only in descendant DSH
processes, so it cannot replace controller assertions or synthesize its own
receipt. Only a separately authorized credentialed control phase may perform
no-merge delivery and direct `forge-cli pr view`/`pr checks` read-back; that
phase never executes candidate repository code. Final read-back binds the run,
trust-root revision, and tested package digest through three exact standalone
provider markers.
