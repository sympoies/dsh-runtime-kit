# Workspace identity and leases

The `@sympoies/dsh-runtime-kit/workspace-lease` module is the runtime-owned
Cordis bridge between DSH's public lifecycle and a deterministic workspace
authority provider. It does not inspect Git, persist leases, or implement
policy in JavaScript. Those decisions belong to the version-matched nils-cli
provider.

This first contract increment exports the plugin and protocol but does not yet
compose it into the default runtime bundle. Default activation is intentionally
deferred until the nils-cli provider exists and the packed integration gate can
prove fail-closed behavior end to end.

## Boundary and ownership

| Owner | Responsibility |
| --- | --- |
| DSH | Exact `Agent`, immutable session header, lifecycle events, tool pipeline, and cancellation |
| dsh-runtime-kit | Host-authenticated binding, opaque references, pre-body admission, exact operation completion, renewal, and lifecycle drain |
| nils-cli provider | Canonical repository/worktree identity, durable cross-process leases, fencing, reconciliation, and stable conflict classification |

The integration uses only released public Cordis and DSH package entrypoints.
The official DSH source remains pinned and unmodified. An out-of-tree DSH
source patch is not a fallback implementation technique: it may be considered
only after a packed reproduction names a missing public seam and the governing
issues approve a version-pinned patch lifecycle before any source edit.

## Public surface

Compose the exported `WorkspaceLease` Cordis service, then register exactly one
same-process provider through `ctx.workspaceLease.registerProvider(provider)`.
The provider must declare `protocolVersion: 1` and implement:

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

## Compatibility and validation

The protocol version is independent of the package version. Unknown protocol
versions and unknown result discriminators fail closed. Version-specific DSH
adaptation, if required, must stay isolated in compatibility code and must not
change the provider wire contract implicitly.

Focused contract coverage lives in
[`test/workspace-lease.test.mjs`](../test/workspace-lease.test.mjs). Promotion
also requires the packed compatibility matrix and real two-session,
restart/recovery, upgrade, and rollback acceptance described by issue #56; a
focused green test alone does not activate or promote this capability.
