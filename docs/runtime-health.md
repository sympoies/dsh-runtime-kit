# Native runtime health

Runtime health is a model-hidden Cordis service. It verifies host capabilities
at the DSH lifecycle boundary and admits only the operations that depend on
them. It replaces the legacy `session-start-healthcheck` prompt context; health
diagnostics, command output, filesystem paths, and recovery instructions are
not added to model messages.

The public `@sympoies/dsh-runtime-kit/runtime-health` entrypoint exports the
`RuntimeHealth` service, its typed error and snapshot contract, transition
validation, and admission/invariant installers. The default bundle registers
the service and composes DSH's official invariant registry before installing
providers. Providers use public Cordis service, effect, subprocess, and DSH
invariant interfaces. Model admission uses the version-scoped downstream
patch's narrow `llm.guard` seam because cooperative `agent/pre-step` and
`llm/stream` listeners cannot prove that a later listener did not bypass the
check. DSH evaluates the guard before entering the `llm/stream` waterfall, so
cache, routing, and short-circuit middleware cannot run before package-owned
admission.

## Capability states

Every snapshot uses `dsh-runtime-kit.health-snapshot.v1` and one of four
states: `recovering` while one deduplicated probe is active, followed by
`ready`, `degraded`, or `blocked`. Stable states alternate through
`recovering`, generations are consecutive, and provider output is projected
to a package-owned `DSH_RUNTIME_HEALTH_*` code. Runtime scope is public;
project scope is represented only by its SHA-256.

| Capability | Probe boundary | Admission behavior |
| --- | --- | --- |
| `runtime-core` | Bundle activation verifies the loaded DSH identity, authenticated `agent-hook doctor`, and the exact authenticated `agent-docs` version. | A failure blocks bundle activation. |
| `project-docs` | Every session-associated model stream attempt force-refreshes a strict project audit for the session cwd. Sessionless auxiliary calls bypass project admission. | A failure rejects before middleware or adapter dispatch and before any streaming provider request. No audit text enters the prompt. |
| `main-agent-mode` | Observes the optional child plugin lifecycle. | Pending or unavailable is degraded. Only Main Agent controller/lane tools are denied. |
| `review-specialists` | Observes the optional child plugin lifecycle. | Pending or unavailable is degraded. Only `review_specialists` is denied. |

Independent tools remain available when an optional capability is degraded.
Activation callbacks force a new native probe when an optional child becomes
active, so recovery does not require an agent-authored shell command.

## Scheduling and cleanup

Probes deduplicate by capability and raw scope. Caller cancellation aborts the
underlying probe only after its last waiter leaves. Deadlines abort owned work,
late settlements cannot overwrite the last stable generation, and provider
removal retires an active probe's authority before another provider can claim
the same capability. Cordis disposal aborts and drains all package-owned work.

Companion commands run only through DSH's subprocess service with an isolated
environment and bounded output. At activation the provider opens each exact
release binary without following a final symlink, authenticates the bytes and
filesystem ownership, and copies those authenticated bytes into a private
read-only executable snapshot. Every runtime-kit consumer receives those same
snapshot paths, so replacing the ambient source after activation cannot change
the executed artifact. The snapshot directory remains bound to its opened inode
through `/proc/<pid>/fd/<fd>` on Linux and `/dev/fd/<fd>` on macOS; unsupported
platforms fail closed. A platform-specific release archive and the individual
`agent-hook` and `agent-docs` digests must be recorded in the compatibility
manifest before that platform can activate. Health, policy, context,
finish-line, and workspace-lease transports each hold a package-owned execution
scope; a descriptor path without that owner is rejected. The scope covers
resolution, spawn, response authentication, process-tree quiescence, and any
finish-line cleanup command. During parallel HMR teardown, existing scopes may
finish their cleanup but cannot survive transport disposal, and the snapshot
descriptor cannot close until every scope has settled.

Completion is not accepted until the process tree is observed quiescent. A
false or late quiescence observation triggers termination and an authoritative
drain; Cordis disposal may return after its bound, but ownership of a
still-running drain and its descriptor is retained until the provider actually
settles. Raw stdout, stderr, binary paths, and audit contents never cross the
health snapshot boundary.

## Operator recovery

The accepted companion release is the exact artifact recorded in
`compatibility/nils-cli.json`. An ambient upgrade, including a newer unreviewed
release, is rejected rather than treated as compatible by version range. To
recover, restore the recorded executables through the runtime launcher, run
`dsh-runtime-kit doctor`, and restart the affected DSH process. Promote a newer
nils-cli release only through the compatibility matrix and normal
setup/update/rollback acceptance; do not widen the identity check in place.

For an invalid project catalog, repair the reported project configuration with
the operator-facing `agent-docs audit --target project --strict` workflow, then
start a new turn or restart DSH. Agents receive only a rejection or stable tool
denial code, so recovery authority remains outside the model prompt.
