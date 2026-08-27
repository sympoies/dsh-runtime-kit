# Workspace identity and leases

The `@sympoies/dsh-runtime-kit/workspace-lease` module is the runtime-owned
Cordis bridge between DSH's public lifecycle and a deterministic workspace
authority provider. It does not inspect Git, persist leases, or implement
policy in JavaScript. Those decisions belong to the version-matched nils-cli
provider.

The default runtime bundle composes this service and registers the strict nils
provider before runtime policy listeners activate. A missing, incompatible,
malformed, timed-out, overloaded, cancelled, or process-tree-uncertain provider
fails closed before an agent tool body can mutate the workspace.

## Boundary and ownership

| Owner | Responsibility |
| --- | --- |
| DSH | Exact `Agent`, immutable session header, lifecycle events, tool pipeline, and cancellation |
| dsh-runtime-kit | Host-authenticated binding, opaque references, pre-body admission, exact operation completion, renewal, and lifecycle drain |
| nils-cli provider | Canonical repository/worktree identity, durable cross-process leases, fencing, reconciliation, and stable conflict classification |

The workspace-lease integration itself uses only released public Cordis and
DSH package entrypoints. The default runtime also requires the separately
authenticated execution-prerequisite patch documented in the compatibility
guide. That patch does not move lease classification or persistence into DSH;
it only supplies the exact body/completion transaction boundary shared by
runtime capabilities.

## Public surface

The default bundle composes the exported `WorkspaceLease` Cordis service and
registers exactly one same-process provider through
`ctx.workspaceLease.registerProvider(provider)`. Embedders using the standalone
export must perform the same composition explicitly. The provider must declare
`protocolVersion: 1` and implement:

- `bind(request, signal)` to bind an exact DSH session generation;
- `begin(request, signal)` to classify a tool call and acquire fenced mutation
  authority when required;
- `complete(request, signal)` to record the exact terminal outcome;
- `renew(request, signal)` to retain or revoke the current generation; and
- `release(request, signal)` to release that generation on rebind, agent
  disposal, or provider disposal.

`ctx.workspaceLease.ref(agent)` returns an opaque, frozen `WorkspaceRef` only
for the exact live `Agent` object. The reference contains no identity or lease
token, cannot be reconstructed from JSON or tool input, and is not transferable
to another agent incarnation. `ctx.workspaceLease.state(agent, ref)` validates
that exact pairing before returning `owned`, `unmanaged`, or a terminal failure
state.

The provider receives host-authenticated protocol and request IDs, session and
parent-session IDs, the immutable session cwd and source, and exact DSH tool
correlation. `begin` also receives DSH's already-frozen tool arguments so the
same-process provider can classify the call; it must project only the bounded
facts required by nils-cli and must not log or persist arbitrary payloads. A
model-supplied `workspaceRef`, cwd-like argument, or copied object never selects
authority.

One live runtime lineage at one exact cwd shares its ancestor's provider
binding. Each Agent still receives a distinct process-local reference and exact
tool correlation, while the provider continues to see the root binding
principal that owns the durable generation. This lets read-only reviewers and
managed children operate without impersonating a second external owner. A
different top-level session always reaches the provider independently and
contends on the canonical worktree. Parent rebind carries still-live children
onto the new generation only after the prior generation releases; the gap
remains fail-closed.

## Dirty-workspace quarantine

A top-level bind rejected as `WORKSPACE_DIRTY` receives no binding, generation,
operation receipt, or mutation authority. The default bundle instead admits
seven exact process-local definitions through the final native guard:

- DSH's existing `skill` loader, so the session can read its applicable
  recovery instructions;
- DSH's existing `get_goal`, `create_goal`, and `update_goal` controls, so
  same-session task continuity remains available under their own direct-human
  and completion-authority checks;
- `runtime_context`, so required project policy remains available; and
- `workspace_recovery`, a bounded read-only diagnostic surface; and
- `workspace_recovery_handoff`, an exact clean-candidate verification surface.

This exception is keyed to definition object identity and the exact live
Agent, Session, epoch, tool execution token, frozen arguments, call lineage,
parent, and signal. Same-name tool replacement, another lease denial state, a
later rebind, or a replay still fails before the tool body. Normal DSH tools,
including host CLI and Git mutation, remain subject to the unchanged lease and
policy pipeline.

`workspace_recovery({})` returns only the canonical checkout path,
branch/head identity, bounded dirty path names and typed status states, the
current stable lease denial state/code, plus a bounded linked-worktree
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
not create, clean, stash, switch, adopt, commit, or transfer authority. The
operator must start a fresh Agent Console session at the returned exact cwd;
that new session performs the normal lease and dirty-worktree checks again.
Unmanaged, stale, or still-dirty work is never silently adopted.

## Lifecycle contract

Binding starts from public `agent/session-start`. Rebinding first releases the
prior generation; a failed release blocks the replacement rather than allowing
two generations. Agent disposal and provider disposal abort and drain binding,
renewal, tool, and completion work before release. Provider replacement remains
closed until the prior disposer finishes.

Tool admission runs after downstream pre-tool policy has returned `allow` or
`ask`, but before DSH resolves approval and dispatches the tool body. This means
an approved one-shot call cannot bypass workspace authority. `not-required`
proceeds without an operation receipt; `granted` must include an operation ID
and fence; `denied` becomes a typed DSH tool failure. Unsupported, malformed,
unavailable, stale, or lost provider state fails before mutation. Provider
reason text is bounded to one printable line before it may reach a model-facing
error.

Both `not-required` and `granted` decisions mint a process-local marker bound to
the exact DSH execution token, call lineage, tool name, frozen arguments, Agent,
Session, parent, and signal. DSH's public monotonic guard consumes that marker
after every extensible pre-execute listener and approval decision. A missing,
replayed, replaced, rebound, or lifecycle-stale marker denies immediately before
dispatch. Thus a later middleware cannot turn a classified read into a mutation;
the service does not depend on another runtime policy plugin to preserve this
boundary.

Every granted operation is completed once with `succeeded`, `failed`, or
`cancelled`, including approval denial, final-guard denial, and an Agent/Session
replacement discovered after `begin` granted authority. Completion uses the
identity captured at admission rather than any later execution fields. Loss of
renewal authority aborts the exact operation signal and uses DSH's public agent
cancellation path as a backstop against another tool wrapper replacing that
signal. Disposal separately aborts an in-flight completion and renewal before
durable release.

## Native nils transport

`src/workspace-lease/nils-provider.js` is a transport and schema adapter, not a
second policy engine. It maps the five host-authenticated lifecycle calls to
`agent-hook workspace-lease bind|begin|complete|renew|release`, always with the
configured absolute DSH-only config, policy, and state roots. The subprocess
working directory is the fixed agent-hook state directory; canonical workspace
selection comes only from the trusted bind request and later opaque binding
identifiers, never shell state or a branch name.

Requests and responses are byte-bounded and versioned. The adapter accepts
only exact success envelopes and stable bounded denial fields, uses an isolated
nils environment, bounds concurrency and deadlines, proves process-tree
quiescence after every call, and permanently closes admission when quiescence
cannot be established. It never interprets Git state, reimplements lease
recovery, or forwards paths, tool arguments, subprocess output, or provider
diagnostics to the model.

After a clean release or expiry, nils may recover a dirty worktree only for the
same host-authenticated session and parent lineage on an explicit `resume` or
`compact` lifecycle, and only when no operation lacks a terminal outcome. A
different session still receives `dirty`; recovery always mints a new binding
ID and generation, so old receipts cannot revive authority.

## Compatibility and validation

The protocol version is independent of the package version. Unknown protocol
versions and unknown result discriminators fail closed. Version-specific DSH
adaptation, if required, must stay isolated in compatibility code and must not
change the provider wire contract implicitly.

Focused contract coverage lives in
[`test/workspace-lease.test.mjs`](../test/workspace-lease.test.mjs), with native
transport coverage in
[`test/workspace-lease-provider.test.mjs`](../test/workspace-lease-provider.test.mjs).
Packed native contention and linked-worktree concurrency coverage lives in
[`test/workspace-lease-native-smoke.mjs`](../test/workspace-lease-native-smoke.mjs).
That smoke also runs the real DSH `skill` tool, the production
`runtime_context` definition, dirty quarantine diagnostics, and clean managed
handoff while proving an ordinary mutation never reaches its body.
Promotion also requires the packed compatibility matrix and real two-session,
restart/recovery, upgrade, and rollback acceptance described by issue #56; a
focused green test alone does not promote this capability.
