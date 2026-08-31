# Operations

`dsh-runtime-kit` activates into an isolated DeepSeek Harness runtime. DSH owns
its profile manifest, dependency installation, lockfile, and bundle
reconciliation; this package owns deterministic plans, receipts, runtime assets,
and health checks around those native operations.

## Activation boundary

Use DSH's native `headless` profile, or the exact Agent Console `dsh-tui`
profile. DSH initializes an unknown profile name with only
`@deepseek-ai/dsh-base`; that is not either supported composition. `headless`
composes the base and headless agent bundles. Agent Console must already have
created the ordered base + `@deepseek-harness-tui/dsh-tui@0.9.3` profile before
runtime-kit is added as its final bundle. Save the complete pre-activation
profile and the owner-only runtime root as the rollback point.

Before the first TUI install under pnpm 11, provision the profile from
[`compatibility/agent-console-pnpm-workspace.yaml`](../compatibility/agent-console-pnpm-workspace.yaml).
It preserves DSH's native profile settings and carries the release-owned
explicit lifecycle decision:

```yaml
allowBuilds:
  '@google/genai': false
  esbuild: false
  koffi: false
  protobufjs: false
```

These transitive install scripts are not required at runtime. This deployment
setting prevents pnpm from rejecting the install and does not create a host
CLI, `PATH`, or agent-execution allowlist.

After the authenticated TUI archive is installed, apply the exact
package-level repair before the first launch:

```sh
dsh-runtime-kit-manage-dsh-tui-patch --action apply \
  --package-root /absolute/dsh-home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
```

The required receipt state is `after: "patched"`. Check it before service
start. Reverse the same patch before replacing the package; never edit the
installed history module by hand.

Runtime-kit also requires one authenticated source patch in the selected DSH
checkout. This is an operator/deployment action, never an agent-authored shell
workaround. Before activating or updating the bundle, stop the affected DSH
processes, apply the patch, and rebuild the host libraries:

```sh
dsh-runtime-kit-manage-dsh-patch --action apply \
  --source-root /absolute/deepseek-harness
pnpm --dir /absolute/deepseek-harness run build:lib:host
```

The command is idempotent and returns a
`dsh-runtime-kit.dsh-patch-receipt.v1` JSON receipt. It accepts only the exact
revisions in `compatibility/dsh-patches.json`, verifies the patch artifact and
all target hashes, and refuses partial state or unrelated checkout changes.
Run `--action check` in health probes and before each service start; the
required terminal state is `after: "patched"`.

Rollback is the reverse transaction: stop DSH, run `--action reverse`, rebuild,
and require `upstream_checkout_clean: true` before starting an unpatched host.
The patch receipt also reports `runtime_rebuilt: false` because it authenticates
source only; require an unpatched smoke after rebuilding ignored `lib/` output.
Do not use `git reset`, hand-edit the target, or copy a patched DSH tree. A
failed reverse is a deployment blocker, not permission to bypass provenance.

Create one absolute owner-only directory that does not overlap DSH home, Codex
home, Claude Code home, or another runtime's state:

```sh
install -d -m 0700 /absolute/dsh-runtime
```

Always invoke management commands and live DSH through the owner launcher:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  <command> [args...]
```

The launcher verifies the root, authenticates the current activation manifest,
exports the exact versioned hook and agent-docs paths, and replaces itself with
the requested long-lived command. Do not store activation variables in
`$DSH_HOME/.env`; DSH rc.7 intentionally rejects that bootstrap path.

## Preview and apply

`setup`, `update`, `rollback`, `remove`, and `doctor --repair` are dry-run by
default. A mutation requires the exact digest returned by the unchanged
preview.

Preview setup:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@<approved-version> --format json
```

Apply the reviewed plan:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@<approved-version> \
  --apply --expected-plan-digest <plan-digest> --format json
```

For the Agent Console composition, substitute `--profile dsh-tui` only after
its provisioner has authenticated the exact TUI package and profile bundle
order. Setup does not reinterpret an arbitrary custom profile as `headless` or
silently add the TUI surface.

Registry targets must use an exact version. A local target must be a directory
whose manifest is exactly `@sympoies/dsh-runtime-kit` with an exact version.
Both forms are resolved through script-free `npm pack`; the plan binds the
tarball and extracted package-tree identities, and apply installs that reviewed
artifact rather than resolving a mutable target again.

A successful digest-only replay may omit `--package`. If it is supplied, it
must still resolve to the exact reviewed target.

## Inspect and run

Run health checks before starting a live profile:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh --profile headless --dump-config

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh --profile headless "run the requested task"
```

The management-plane doctor and the in-process native health service are
separate gates. Doctor validates the installed runtime before launch. During
bundle activation, native `runtime-core` health authenticates the exact
`agent-hook` and `agent-docs` artifacts into private executable snapshots that
all runtime-kit consumers share. Before every session-associated model stream
enters DSH's `llm/stream` waterfall, `project-docs` audits that session's
canonical cwd through the same authenticated snapshot. A failure blocks before
middleware, cache, routing, the provider request, or a dependent tool body
and never adds diagnostic text to the prompt. Optional Main Agent and
specialist-review health may be degraded while independent runtime-kit tools
continue to operate. The complete state and recovery contract is in
[Native runtime health](runtime-health.md).

For Agent Console, run doctor with `--profile dsh-tui`, inspect the composed
tree with `dsh --profile dsh-tui --dump-config`, then invoke `dsh-tui` through
the same launcher. The composed evidence must satisfy
`inspectAgentConsoleRc7Profile`: the official `userQuestions` and TUI rows,
runtime-kit tools/skills/Main Agent service, separated controller/lane tool
surfaces, and the inherited controller/worker route must all be present. Route
evidence contains only `provider` and `model`; credential-shaped or other
extensions are rejected rather than copied into a serializable inspection.

## Agent Console authority boundary

Runtime-kit's patch owns only the `dsh-runtime-kit` row. It does not rewrite
`sandbox-policy`, `approval`, provider rows, or credential stores. The Agent
Console launch surface must set `DSH_PERMISSION_MODE` explicitly; supported
pairs are `workspace-write` + `ask`, or the currently required
`danger-full-access` + `never`. Provider credentials remain environment-name
references such as `DSH_CODEX_PROXY_TOKEN`; raw credential values are not part
of profile evidence.

The supported UI boundary is exact: DSH `0.1.1-rc.2`, dsh-tui `0.9.3`, and the
ordered three-bundle composition. Other DSH/TUI releases, arbitrary custom
profiles, and live lane re-adoption after a harness restart remain outside this
contract. Managed continuation metadata can reconstruct an exact host-issued
workspace only when its registered provider reauthenticates the same persisted
cwd and renews the nils workspace lease; stale liveness sidecars never grant
that authority.

Doctor verifies DSH, the exact installed package tree, the active asset set,
the DSH-only policy and agent-docs roots, receipt state, and the released nils
executables. Missing, drifted, cross-home, unsafe, or ambiguous state fails
closed.

Management plans bind the reported DSH version to the matching exact source
revision in `compatibility/dsh.json`. Only releases present in that reviewed
set are accepted; changing the executable, version, or version-to-revision
pair after preview is plan drift.

## Update, rollback, and remove

Preview each command first, then repeat it with `--apply` and the returned
digest:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit update --profile headless \
  --package @sympoies/dsh-runtime-kit@<new-version> --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit rollback --profile headless --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit remove --profile headless --format json
```

Rollback restores the exact previous runtime-kit target and matching activation
assets. Remove delegates the package mutation to DSH, removes only
runtime-kit-owned receipts and unreferenced assets, and preserves unrelated
bundles, user patches, private skills, and provider configuration.

## Interrupted operations and repair

Every mutation records a bounded pending phase. A later command reconciles the
actual DSH profile, installed package identity, activation target, and receipts
before deciding whether an exact terminal result can be finalized or a repair
is required.

Use a previewed `doctor --repair` only for the supported owner-record adoption
or interruption-repair path:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --repair --format json
```

Apply only that unchanged repair plan:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --repair \
  --apply --expected-plan-digest <plan-digest> --format json
```

Repair is digest-reviewed and writes only evidence it can authenticate. It does
not adopt arbitrary ownerless trees, guess between ambiguous phases, or rewrite
unrelated DSH configuration.

## Runtime assets and state

The package copies its DSH policy and compact `agent-docs/` catalog into a
content-addressed immutable asset set beneath the runtime root. Separate mutable
directories hold hook and agent-docs state. The activation manifest binds the
selected DSH home, package target, asset digests, generated configuration, and
bounded tree identity. Copied asset leaves are owner-only regular files with
link count one; hard links and package-store links are not accepted activation
assets.

The launcher derives and replaces these values; operators should not populate
them individually:

- `DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG`
- `DSH_RUNTIME_KIT_AGENT_HOOK_POLICY`
- `DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR`
- `DSH_RUNTIME_KIT_AGENT_DOCS_HOME`
- `DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME`

`DSH_RUNTIME_KIT_AGENT_HOOK_BIN` and `DSH_RUNTIME_KIT_AGENT_DOCS_BIN` must pin
the released and validated v1.27.27 executables for every supported DSH row.
An older or any other unreviewed replacement is intentionally rejected.
Restore the exact recorded release and restart DSH, or promote the new release
through the full compatibility matrix; do not work around the health gate from
an agent shell.
Missing or non-absolute isolation paths fail
plugin activation; ambient XDG, Codex, and Claude Code paths are not fallbacks.

Activation retains only asset sets referenced by current, previous, pending, or
active receipts. Collection and mutation are serialized by kernel-backed locks,
and all external health, packaging, and DSH commands have bounded deadlines and
process-group quiescence checks.

## Storage and command bounds

The private package artifact store admits at most 64 archives, 1 GiB total,
and 128 MiB per archive. Artifact inspection rejects more than 256 MiB expanded,
16,384 regular-file entries, 64 MiB in one entry, or unsafe package paths before
system extraction.

Activation storage separately admits at most 16 live asset sets. Each set is
bounded to 4 MiB of package assets plus 64 KiB of generated activation overhead;
collection removes only unreferenced digest sets and interrupted staging names.

External health checks have a 30-second deadline, packaging commands have a
two-minute deadline, and DSH mutations have a ten-minute deadline. An operator
may lower, but never raise, those bounds with
`DSH_RUNTIME_KIT_COMMAND_TIMEOUT_MS`; the minimum accepted value is 100 ms.
Timeout, supervisor loss, or a command that leaves descendants causes the
owner to terminate the dedicated process group and prove quiescence before
releasing operation locks.

## Optional private skills

Private loading is opt-in through `DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR`. Leave it
unset, point it at an empty owner-only DSH directory, or select an explicit
DSH-only catalog that satisfies the no-symlink and permission checks. Existing
Codex or Claude Code private bundles are never enrolled automatically.
Activation, rollback, and removal leave their configuration, hooks, skills, and
sessions unchanged.

See [private and project skills](private-skills.md) for the complete discovery
and precedence contract.
