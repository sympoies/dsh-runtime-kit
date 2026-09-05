# Workspace identity and leases

The `@sympoies/dsh-runtime-kit/workspace-lease` module is the runtime-owned
Cordis bridge between DSH's public lifecycle and a deterministic workspace
authority provider. It does not inspect Git, persist leases, or implement
policy in JavaScript. Those decisions belong to the version-matched nils-cli
provider.

The default runtime bundle composes this service and registers the strict nils
provider before runtime policy listeners activate. A missing, incompatible,
malformed, timed-out, overloaded, cancelled, or process-tree-uncertain provider
fails closed before an agent tool body can mutate a repository.

## What a lease is, and what it is not

A workspace lease coordinates ownership of a physical Git worktree and fences
governed mutation of it. It is **not** a filesystem permission boundary.

- Native DSH runs with the authority of the host user. A repository lease never
  grants or removes ordinary OS read/write authority.
- A lease *denial* is local to the exact repository target it names. It denies
  that one operation. It never disables Bash, file tools, provider tools, skill
  loading, IPC, localhost, daemons, executables, other repositories, or
  non-repository paths.
- A provider *integrity* failure — an unavailable, malformed, or
  process-tree-uncertain provider — still fails closed, because an
  untrustworthy protocol cannot make an honest coverage claim about anything.
- Future access isolation is implemented by containing the whole DSH runtime
  with explicit mounts, users, devices, IPC, and networking. It is **not**
  approximated by a partial per-command or per-worktree sandbox in native mode,
  and it is not the job of workspace leases.

Existing behavioral policy, protected-root handling, secret controls, signing,
and destructive-action rules remain independent of all of the above.

## Boundary and ownership

| Owner | Responsibility |
| --- | --- |
| DSH | Exact `Agent`, immutable session header, lifecycle events, tool pipeline, and cancellation |
| dsh-runtime-kit | Host-authenticated facts, per-repository authority selection, opaque references, pre-body admission, exact operation completion, renewal, and lifecycle drain |
| nils-cli provider | Operation classification, canonical repository/worktree identity, durable cross-process leases, fencing, reconciliation, and stable conflict classification |

The workspace-lease integration itself uses only released public Cordis and
DSH package entrypoints. The default runtime also requires the separately
authenticated execution-prerequisite patch documented in the compatibility
guide. That patch does not move lease classification or persistence into DSH;
it only supplies the exact body/completion transaction boundary shared by
runtime capabilities.

## Session anchor versus authority set

A session's startup `cwd` is its **anchor**. The anchor remains useful for
initial prompt/project context, project policy discovery, relative-path
resolution, UI labelling and history, and choosing the first likely repository
target. It is not a sandbox root and grants no authority over other
repositories.

A live DSH lineage owns an **authority set**:

```text
session
├── anchor cwd (context only)
├── repository A / worktree A -> binding A
├── repository B / worktree B -> binding B
└── non-repository path        -> no repository lease
```

Bindings are acquired lazily, when an operation has an exact,
host-authenticated repository target that requires coordination. Each binding
keeps independent identity, generation, renewal, fencing, active operations,
failure, and release state. The same physical worktree still contends across
sessions; distinct worktrees and distinct repositories never contend merely
because one DSH session uses both.

Changing a tool working directory never mutates the anchor. An authenticated
canonical target derived from that operation may acquire another binding.

## Public surface

The default bundle composes the exported `WorkspaceLease` Cordis service and
registers exactly one same-process provider through
`ctx.workspaceLease.registerProvider(provider)`. Embedders using the standalone
export must perform the same composition explicitly. The provider must declare
`protocolVersion: 2` and implement:

- `resolve(request, signal)` to classify one exact tool execution into zero or
  more canonical repository targets;
- `bind(request, signal)` to acquire one binding generation for an exact
  resolved target, or eagerly for the session anchor;
- `begin(request, signal)` to acquire fenced mutation authority for one exact
  target of one exact call;
- `complete(request, signal)` to record the exact terminal outcome;
- `renew(request, signal)` to retain or revoke one generation; and
- `release(request, signal)` to release one generation on rebind, agent
  disposal, or provider disposal.

`ctx.workspaceLease.ref(agent)` returns an opaque, frozen `WorkspaceRef` for
one exact live `Agent` object. It names that session's authority set, not a
repository: it contains no identity or lease token, cannot be reconstructed
from JSON or tool input, and is not transferable to another agent incarnation.
`ctx.workspaceLease.state(agent, ref)` validates that exact pairing and then
returns the **anchor** classification (`owned`, `unmanaged`, or a terminal
failure state). `ctx.workspaceLease.denialState(agent)` projects only the
stable anchor denial state and code for diagnostics. Neither method reports or
grants authority over any other repository in the set.

`ctx.workspaceLease.targets(exec)` projects the canonical repository roots the
provider authenticated for one exact live execution, resolving them once and
sharing that single decision with this service's own admission. It carries no
lease authority, and an empty array means the provider proved the operation
touches no repository. The finish-line ledger consumes it so that an edit
generation is attributed to the repository the operation targets instead of the
session anchor; nothing else may use it to select authority.

The provider receives host-authenticated protocol and request IDs, session and
parent-session IDs, the immutable session anchor, the session-start source, and
exact DSH tool correlation. `resolve` and `begin` also receive DSH's
already-frozen tool arguments so the same-process provider can classify the
call; it must project only the bounded facts required by nils-cli and must not
log or persist arbitrary payloads. A model-supplied `workspaceRef`, cwd-like
argument, target object, or copied object never selects authority: the runtime
only ever echoes back the exact frozen target the provider itself
authenticated.

One live runtime lineage shares one authority set. Each Agent still receives a
distinct process-local reference and exact tool correlation, while the provider
continues to see the root lineage principal that owns each durable generation.
This lets read-only reviewers and managed children operate without
impersonating a second external owner on a worktree their ancestor owns. A
different top-level session always reaches the provider independently and
contends on the canonical worktree.

## Honest coverage

The runtime never trusts a raw path supplied by the model, and never claims a
fence it cannot enforce.

The test is whether the operation's own declared arguments prove the repository
it mutates — not whether it happens to be a shell.

- Structured file mutations expose exact path arguments. The provider
  canonicalizes them in the host boundary — resolving symlinks, binding a
  non-existent leaf to its nearest existing ancestor, and deriving the physical
  Git worktree identity — and returns the exact targets.
- `artifact_export` proves its target through `destination.path` when
  `destination.class` is `workspace`, a path its own schema constrains to be
  workspace-relative. The `download` class writes nothing into a repository and
  proves no target.
- `runtime_kit_governed_commit` declares no path because it has no target to
  choose: it always commits the canonical live Session cwd. The anchor is
  therefore the whole proof, and with no anchor the commit is refused rather
  than admitted unscoped. This is the operation the lease exists to coordinate,
  and it is the only producer of the durable terminal-outcome record that
  authenticated recovery reads.
- An operation with no repository target, a read-only form, an unknown tool, or
  an arbitrary full-host shell program resolves to `not-required` and runs as an
  unscoped native host operation. Its repository effects cannot be proven by
  inspecting a startup directory, so the runtime neither fences it nor blocks
  it. Behavioral policy still applies to it in full.
- For a shell that is a deliberate trade-off, not an oversight: a `workdir`
  fence is defeated by `cd` inside the command string, so honouring one would
  claim coverage the boundary cannot enforce. It does mean shell mutations lose
  the v1 cross-session exclusivity, dirty and uncertain-outcome gates.
- The fence lands on the workspace the runtime **names** for an operation. The
  boundary authenticates that target against the durable binding, but does not
  prove it is the target this call's own arguments would resolve to; binding it
  to the exact call facts is tracked as `sympoies/nils-cli#1606`.
- The wire admits multiple canonical targets per operation, acquired in the
  provider's deterministic order before any fence is granted, with every
  already-granted sibling receiving a terminal outcome if a protected target is
  denied. Every operation classified today yields at most one target, so that
  path is the contract for a future multi-path tool rather than a rule
  exercised now.

Strong filesystem isolation, if later required, is a container responsibility.

## Eager anchor binding

The first release keeps an eager anchor bind as an optimization: at
`agent/session-start` the runtime binds the repository containing the anchor,
so two sessions in one physical worktree contend before any tool runs. Failure
of that eager bind is **local**. A dirty, foreign, or uncertain anchor produces
no binding and no session-wide denial; the session keeps full host authority and
only mutations of that one checkout are denied. A non-repository or absent
anchor returns `not-required` and mints no authority at all.

Every v2 `bound` result names the exact repository target it owns, including its
`workspace_key`. The runtime keys its authority set by that key and reuses the
existing binding for any later target that resolves to it, so the eager anchor
binding and a later lazy acquisition of that same repository converge on one
generation. That convergence is this runtime's obligation, not something the
boundary does for it: a second bind of a workspace this session already owns is
denied `foreign-active` exactly like a genuinely foreign holder, so a runtime
that skipped the keying would contend with itself and could not tell the
difference.

## Behavior matrix

| Operation | Repository-lease behavior |
| --- | --- |
| Read or write a non-Git path the host user may touch | Proceeds; no repository lease |
| Read another repository | Proceeds; no mutation fence |
| Structured mutation in clean worktree A | Lazily acquire/reuse binding A and fence it |
| Later structured mutation in clean worktree B | Lazily acquire/reuse independent binding B |
| `artifact_export` to a workspace-relative path | Lazily acquire/reuse that repository's binding and fence it |
| `artifact_export` to the `download` class | Proceeds; writes no repository path, so no lease |
| Governed commit with a repository anchor | Lazily acquire/reuse the anchor repository's binding and fence it |
| Governed commit with no anchor | Refused rather than admitted unscoped; surfaces as `WORKSPACE_LEASE_UNAVAILABLE`, since `resolve` has no typed denial |
| Mutation in a dirty checkout this session does not own | Deny only that mutation, typed `WORKSPACE_DIRTY`; session stays usable |
| Mutation in a worktree another live session owns | Deny only that mutation, typed `WORKSPACE_FOREIGN_ACTIVE` |
| Same-session resume of owned dirty work | Authenticated recovery for that binding, unchanged |
| Arbitrary shell with unprovable path effects | Runs unscoped; no fence claimed, behavioral policy still applies |
| A confined/container profile in future | Enforces its own filesystem boundary, independent of leases |

## Dirty-workspace recovery surface

Protocol v1 denied every tool in a session whose anchor was dirty, so issue
\#102 added a bootstrap quarantine that admitted a small set of exact
definitions. That exception existed only for the session-wide dirty denial, and
v2 removed the denial: an anchor denial is now local to the repository it
names, so no tool needs excepting from it.

The v1 bootstrap quarantine registry that admitted those exact definitions was
removed with the convergence closeout (see
[`compatibility/retired-surfaces.json`](../compatibility/retired-surfaces.json)):
under v2 the admission and guard paths never consulted it, so no bundle needs
an admission exception and the service exposes none.

A provider that is entirely unavailable -- no `agent-hook`, an unparsable
response, a stopping provider -- is a different and broader failure: it denies
before classification, so it denies every tool. The quarantine never covered
that in v1 either, and v2 does not change it.

`workspace_recovery({})` returns only the canonical checkout path,
branch/head identity, bounded dirty path names and typed status states, the
current stable anchor denial state/code, plus a bounded linked-worktree
inventory. It never returns file contents, command output, environment values,
tool payloads, owner identities, or lease authority. The client calls only the
versioned, authenticated `agent-hook workspace-recovery inspect` primitive
with bounded input/output, deadlines, concurrency, cancellation, and
process-tree quiescence. The primitive performs a fresh in-process libgit2
inspection without registered repository command filters, keeps dirty
submodules visible through a bounded recursive `SubmoduleIgnore::None` walk,
disables index refresh, and never launches Git or `git-cli`. Nils result data
is capped at 192 KiB inside the 256 KiB transport; shortened dirty/worktree
arrays carry typed omitted counts and never turn a dirty decision clean. The
client accepts additive service metadata but projects only the versioned
allowlisted fields into DSH tool output.

`workspace_recovery_handoff({ path })` calls the matching authenticated
`verify-handoff` primitive and proves that the exact listed target is a
different clean, non-bare, non-detached, non-prunable managed worktree. It does
not create, clean, stash, switch, adopt, commit, or transfer authority. Under
v2 the operator no longer needs a new session to keep working elsewhere; a
fresh session at the returned exact cwd remains the recommended transition when
the intended governed work targets the dirty checkout itself.

## Lifecycle contract

The authority set starts from public `agent/session-start`. A session lifecycle
change retires every acquired generation before the replacement set may
acquire anything: acquisition never overlaps the release it replaces, because
the same durable workspace would otherwise report a live foreign owner. A
failed release blocks the replacement rather than allowing two generations.
Agent disposal and provider disposal abort and drain binding, renewal, tool, and
completion work for every binding before release. Provider replacement remains
closed until the prior disposer finishes.

Tool admission runs after downstream pre-tool policy has returned `allow` or
`ask`, but before DSH resolves approval and dispatches the tool body. An
approved one-shot call therefore cannot bypass workspace authority.
`not-required` proceeds without an operation receipt; `granted` must include an
operation ID and fence; `denied` becomes a typed DSH tool failure that
preserves its exact root cause — `WORKSPACE_DIRTY` is never translated into an
unrelated global failure such as `finish-line-unavailable`. Unsupported,
malformed, unavailable, stale, or lost provider state fails before mutation.
Provider reason text is bounded to one printable line before it may reach a
model-facing error.

Every admitted execution mints a process-local marker bound to the exact DSH
execution token, call lineage, tool name, frozen arguments, Agent, Session,
parent, signal, slot epoch, and the exact operations acquired for it. DSH's
public monotonic guard consumes that marker after every extensible pre-execute
listener and approval decision. A missing, replayed, replaced, rebound, or
lifecycle-stale marker — or a superseded, failed, or released binding behind any
of its operations — denies immediately before dispatch. Thus a later middleware
cannot turn a classified unscoped operation into a fenced mutation, and the
service does not depend on another runtime policy plugin to preserve this
boundary.

Every granted operation is completed once with `succeeded`, `failed`, or
`cancelled`, against the exact binding and generation selected at admission,
including approval denial, final-guard denial, a partially denied multi-target
acquisition, and an Agent/Session replacement discovered after `begin` granted
authority. Completion uses the identity captured at admission rather than any
later execution fields.

Losing one repository generation aborts only that repository's operations,
cancels only the agents that held them, and retires only its slot in the
authority set. Unrelated repositories keep independent authority, and the next
operation targeting the lost repository re-acquires it honestly and reports the
true typed reason if it cannot. Renewal loss uses DSH's public agent
cancellation path as a backstop against another tool wrapper replacing the
operation signal. Disposal separately aborts in-flight completion and renewal
before durable release.

## Native nils transport

`src/workspace-lease/nils-provider.js` is a transport and schema adapter, not a
second policy engine. It maps the six host-authenticated lifecycle calls to
`agent-hook workspace-lease resolve|bind|begin|complete|renew|release`, always
with the configured absolute DSH-only config, policy, and state roots. The
subprocess working directory is the fixed agent-hook state directory; canonical
workspace selection comes only from the trusted anchor, the provider's own
authenticated targets, and later opaque binding identifiers — never shell state
or a branch name.

Requests and responses are byte-bounded and versioned. The adapter accepts
only exact success envelopes and stable bounded denial fields, uses an isolated
nils environment, bounds concurrency and deadlines, proves process-tree
quiescence after every call, and permanently closes admission when quiescence
cannot be established. It never interprets Git state, reimplements lease
recovery, or forwards paths, tool arguments, subprocess output, or provider
diagnostics to the model. A canonical target root travels only between the
runtime and the provider; it is never projected into tool output.

After a clean release or expiry, nils may recover a dirty worktree only for the
same host-authenticated session and parent lineage on an explicit `resume` or
`compact` lifecycle, and only when no operation lacks a terminal outcome. A
different session still receives `dirty`; recovery always mints a new binding
ID and generation, so old receipts cannot revive authority.

## Compatibility and validation

The protocol version is independent of the package version. Protocol v2 is
selected by the request schema; a declared version that disagrees with its
schema is rejected as a mixed-version request rather than silently
reinterpreted. Unknown protocol versions and unknown result discriminators fail
closed. A v1 provider cannot register with a v2 runtime and a v2 provider
cannot register with a v1 runtime, so no lease token or binding crosses
protocol generations. Existing v1 sessions keep their current semantics until
they restart against the matched pair.

Version-specific DSH adaptation, if required, must stay isolated in
compatibility code and must not change the provider wire contract implicitly.

Focused contract coverage lives in
[`test/workspace-lease.test.mjs`](../test/workspace-lease.test.mjs), with native
transport coverage in
[`test/workspace-lease-provider.test.mjs`](../test/workspace-lease-provider.test.mjs).
Packed native contention and linked-worktree concurrency coverage lives in
[`test/workspace-lease-native-smoke.mjs`](../test/workspace-lease-native-smoke.mjs).
That smoke drives DSH's real `write` tool against the real nils provider and
proves, in one process, that a dirty-anchor session keeps full host authority
over a non-repository directory and an unrelated clean repository, that two
distinct worktrees mutate concurrently, that one physical worktree still
contends across sessions, and that the dirty checkout itself is never mutated.
It also runs the real DSH `skill` tool, the production `runtime_context`
definition, anchor-local dirty denial diagnostics, and clean managed handoff.
Promotion also requires the packed compatibility matrix and real two-session,
restart/recovery, upgrade, and rollback acceptance described by issues #56 and
\#172; a focused green test alone does not promote this capability.
