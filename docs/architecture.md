# Architecture

`dsh-runtime-kit` is an out-of-tree DSH bundle. It composes only through public
Cordis and DSH service APIs and never patches or vendors the harness.

Responsibilities are intentionally split:

- DSH owns the agent loop, sessions, tools, sandbox, approvals, skills
  registry, and subagents.
- This bundle owns composition, compact workflow skills, DSH-to-nils policy
  adaptation, reviewer personas, and compatibility diagnostics.
- nils-cli owns deterministic policy evaluation, repository lifecycle
  commands, and machine-readable contracts.

Live composition has an explicit runtime-root boundary. The package requires
absolute DSH-only agent-hook config, policy, and state paths and passes them on
every dispatch, finish-line, and doctor invocation. It likewise requires an
absolute DSH-only agent-docs catalog and state root. There is no ambient XDG,
Codex, or Claude Code fallback. The packaged `agent-docs/` directory is the
source catalog for a copied owner-only activation root; the policy is copied to
an owner-only regular file with link count one before its digest is recorded in
the DSH-only hook config.

`policy/rule-parity.yaml` is the frozen public source inventory, not a
JavaScript rule engine. It authenticates the exact legacy source and exposes
the stable 101-row, 27-capability compatibility contract implemented by the
public parity verifier.

`policy/runtime-rule-parity.yaml` is the internal migration-status projection.
It maps the same source rules into 23 nils capabilities, two stronger
DSH-native seams, and one provider-obsolete retirement. A group becomes
dispatchable only through its implemented runtime owner, never merely by
appearing in this file. The nils `DshCapabilityGroup` schema independently
freezes the 23 deterministic IDs; the cross-repository migration verifier
requires the two ordered sets to match.

All DSH rc.7 compatibility types and lifecycle names are isolated in
`src/compat/dsh-rc7.js`. The adjacent `src/compat/contract.js` owns the typed
boot/source diagnostics, while `src/compat/performance.js` owns promotion
budget evaluation. The lifecycle adapter normalizes `agent/session-start`, `agent/pre-step`,
`tools/pre-execute`, `tools/post-execute`, `tools/result`, and
`agent/turn-stopping` into content-free session/cwd/turn/step/call correlation.
It never retains messages, arguments, candidate output, final result bodies, or
subprocess output.

Pre-step proposals are provisional. Concurrent proposals are serialized behind
one in-flight decision for the session position; a contender repeats evaluation
when the owner rejects or aborts. Nils receives the prompt and evaluates policy
only after the downstream rc.7 decision is `enter` and its signal remains live;
a rejected proposal never crosses the subprocess boundary. The adapter records
turn/step only after that acceptance. Tool
boundaries refresh the open position from the public Session events, so durable
`step/end` and `turn/end` override any cached proposal. Initial attachment
reverse-derives only through the recent matching lifecycle suffix. The adapter
then retains an event count and last-event identity: rc.7 immutable snapshots
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
the v4 terminal error bit before downstream and may keep the public rc.7 post
decision closed until operation completion reconciles. A context decision is
retained only for the exact authorized execution and folded once into the
accepted post-tool decision. Pre-step context is appended only after downstream returns
`enter`; turn-stop context is steered only after finish-line returns allow.
Per-session step/turn dedupe stores one last position, so lifecycle state is
constant-space.

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
`str_replace_editor` targets. It pins primary/default-branch consensus in
owner-private nils state before mutation, rejects subsequent repository
metadata drift, blocks native writes into Git metadata, and resolves literal
`git -C` and `semantic-commit --repo` targets. Raw commit-producing rewrites on
the default branch are denied, including protected fetch destinations and
stdin/server-driven ref-update plumbing. Sequential shell builtins that can
retarget cwd, exported variables, tracing hooks, command lookup, or aliases
make later command-dependent classification fail closed. Git options and
subcommands that consume nested shell commands are rejected rather than
partially parsed. Exact Git recovery and the owned delivery CLIs remain
available. Scope-lock policy probes run with a cleared environment and a
helper-disabled trusted Git boundary.

The static command gates are transcript guardrails, not a shell or native-code
sandbox. They reject malformed or unmodeled shell grammar, executable
indirection, command consumers, general-purpose interpreters, CLI aliases, and
dynamic security-relevant arguments that the bounded classifier cannot prove.
They do not claim to infer the internal behavior of every arbitrary native
binary or package script. Finish-line containment separately owns process-tree
quiescence, while the governed nils CLIs and provider branch/access controls
remain authoritative for delivery. The public package must not describe any of
these layers as a general hostile-code boundary.

Specialist review is one DSH-native tool, not eight model-authored personas or
an external agent runtime. `src/review/index.js` loads exactly eight packaged
persona files at server startup and accepts only `{ task, roles }`. Quick review
is exclusive; selected focused or specialist roles run through a bounded
runtime-global semaphore shared across simultaneous tool calls. Red-team is
invalid alone and starts only after the first wave settles, either because the
caller preselected it or because a first-wave structured finding is critical.
It receives a byte-bounded rendering of prior structured evidence marked as
untrusted. Each child must conclude through rc.7 `outputSchema`; the runtime
validates semantic and UTF-8 byte invariants again, injects the server-owned
specialist identity, and serializes deterministic nils-compatible JSONL.
Results preserve requested order, expose no child IDs or continuation handles,
and every native run is disposed before its semaphore permit is released. One
caller abort signal cancels the whole wave and joins every published child;
runtime disposal closes queued admission, aborts active waves, and drains child
disposal before teardown settles. Queued acquisitions have a separate
runtime-global ceiling; overflow returns `reviewer-overloaded` without retaining
another task or publishing a child.
The reviewer runtime is a child plugin gated on `agents`, `subagents`, and
`tools`. Its exact-Agent authority is created by the parent before child
activation, so an absent subagent provider leaves that authority empty while
the parent policy, skills, context, and finish-line runtime continue to load.

Reviewer classification is a process-local authority boundary. The runtime
opens an `AsyncLocalStorage` admission only around rc.7's trusted in-process
`spawn` call. The synchronous `agent/created` event must publish exactly one
registry-owned child with the expected parent and `origin: subagent`; the exact
`Agent` object is then recorded in a `WeakMap`. A role event is appended for
audit only and cannot authenticate a resumed, forged, or ordinary session.
After the provider copies the parent's standing policy, the runtime appends a
final `sandbox/mode: read-only` override and installs a guard through that
child's scoped `tools` service.

The guard is monotonic and capability-based rather than prompt-based. It
allows only the fixed local inspection surface (`read`, `grep`, `glob`, image
read, runtime context, skills, structured completion, and agent listing) and denies every
other name, including Bash, write/edit/replace, code mode, nested tool calls,
subagent delegation, recursive specialist review, and outbound web fetch/search. DSH evaluates this guard
after the extensible pre-tool waterfall but before any tool body. The broader
nils edit/operation/finish-line lifecycle therefore recognizes only the exact
authenticated reviewer and steps aside; the scoped guard remains the final
pre-body authority. Ordinary and forged Agents cannot enter that exception and
continue through full nils policy. The read-only sandbox is a second boundary
for allowed inspection tools; tool filtering and persona compliance are not
required for the denial guarantee.

Finish-line state crosses a strict public open/begin/run/stop command family
plus private quiesce and release lifecycle transports.
For `write`, `edit`, and mutating `str_replace_editor` calls, pre-execute mints
an opaque operation id and awaits durable begin registration before delegation.
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
the released capability incarnation, not the stable DSH session ID: a new rc.7
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
of the transport set and waiting for rc.7 approval. The subprocess receives a
fixed argv vector, explicit bounded stdio, an absolute session cwd, no shell,
no forwarded environment, and no spill or unbounded output path.

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
wrappers run afterward with a `ToolDispatchExecution` whose contract makes only
`signal` mutable. Such in-process plugins are trusted computing base; deliberate
runtime violations of other readonly fields are not contained here. The bundle
therefore narrows its substitution guarantees to pre-execute listeners and
does not depend on brittle property descriptors or non-public APIs.

Private skill source remains outside this public repository. At process start,
the loader validates the configured owner-controlled tree with bounded
asynchronous traversal and no-follow reads, copies it into a sealed temporary
snapshot, and registers definitions parsed from those retained bytes. Project
skills rank above the snapshot, which ranks above bundled public skills.

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

Upstream compatibility is executable: pack the bundle, install it into a clean
profile, dump the composed config, boot DSH, discover skills, and drive a real
Agent/AgentLoop allow/block probe plus cancellation and plugin-disposal drains.
All `@deepseek-ai/dsh-*` peers used by this rc.7 adapter are pinned exactly to
`0.1.0-rc.7`; Cordis is pinned exactly to `4.0.1`.

`compatibility/dsh.json` is the closed promotion input. It records the pinned
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
helpers. Package CI downloads the exact nils-cli `1.27.0` archive, authenticates
its retained SHA-256, and runs the packed candidate through the real
`agent-hook` subprocess boundary; p95 or post-disposal child/admission leakage
blocks promotion.
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
