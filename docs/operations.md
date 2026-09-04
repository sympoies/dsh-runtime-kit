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
created the ordered base +
`@deepseek-harness-tui/dsh-tui@0.10.0-beta.4` profile before runtime-kit is
added as its final bundle. Save the complete pre-activation profile and the
owner-only runtime root as the rollback point.

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
start. Beta.4 already includes dsh-TUI #593's asynchronous history persistence.
The narrowed repair adapts beta.4's legacy `session.events` reader to alpha.4's
cached `snapshotEvents()` interface and restricts legacy history paths as one
authenticated transaction. Reverse the same patch before replacing the
package; never edit either installed target by hand. On first history append,
the patch preserves legacy entries while restricting owner-owned data paths to
0700/0600; an unexpected type, owner, or symlink is refused without following
it.

Runtime-kit also requires one authenticated source patch in the selected DSH
checkout. This is an operator/deployment action, never an agent-authored shell
workaround. Before activating or updating the bundle, stop the affected DSH
processes, apply the patch, and rebuild the host libraries:

```sh
dsh-runtime-kit-manage-dsh-patch --action apply \
  --source-root /absolute/deepseek-harness
cd /absolute/deepseek-harness
./node_modules/.bin/tsx scripts/clean.ts
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json
./node_modules/.bin/tsdown --env.DSH_BUILD_FACE host
```

Clean before rebuilding, and invoke the binaries directly rather than through
`pnpm run build:lib:host`. Stale build output makes `tsdown` treat the
repository root as a build target and abort before bundling anything, and a
`pnpm run` in that checkout can fail in its dependency-status check before the
script starts. `AGENTS.md` records both conditions.

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

## Declared profile lifecycle

The package declares the surfaces the transaction may touch in
[`compatibility/profile-lifecycle.json`](../compatibility/profile-lifecycle.json),
referenced from `package.json#dsh.lifecycle`. The declaration lists the owned
profile surfaces (dependency row, bundle row, installed package tree, lockfile
projection), the owned home surfaces (operations state, operations lock,
artifact store), the generated runtime-root surfaces (activation manifest,
owner record, versioned asset set, hook and docs state roots), the activation
assets, the compatibility sources, the native nils companions, the declared
migrations, the health probes that must pass before activation, that no
package-manager lifecycle script may run, and that removal deletes owned
surfaces only.

Every preview reads the declaration from the exact reviewed package artifact,
validates it, and binds its digest into the plan as `lifecycle`. The engine
enforces a fixed vocabulary: a malformed declaration fails as
`invalid-lifecycle-manifest`, and a well-formed declaration naming a surface,
asset, migration, probe, or behaviour this engine does not implement fails as
`unsupported-lifecycle-manifest`, so a newer package cannot be installed by an
engine that would ignore part of its contract. A package that declares
`preinstall`, `install`, `postinstall`, `prepare`, or another install-time
script fails as `lifecycle-scripts-declared` before any profile mutation. A
package without a declaration is admitted under this engine's own compatibility
manifest and reported by doctor as undeclared.

Compatibility is checked before any mutation. `setup`, `update`, and `rollback`
compare the bound DSH release against the releases the reviewed package itself
declares in its `compatibility/dsh.json`; a mismatch fails as
`package-incompatible-dsh` at preview, with the profile, lockfile, and receipts
untouched, instead of installing a bundle the host would reject at boot.

Runtime health is part of the transaction. After the new asset set has been
staged and before the pending marker and the native DSH mutation, the declared
probes run against the staged assets: `dsh-version` (the bound host is an exact
reviewed release), `agent-hook-doctor` (the staged hook config and policy
authenticate and delegate DSH registration to runtime-kit), and
`agent-docs-version` (the staged catalog and the released `agent-docs`
executable are in the validated range). Apply therefore requires the same
companion pins as `doctor` (`DSH_RUNTIME_KIT_AGENT_HOOK_BIN`,
`DSH_RUNTIME_KIT_AGENT_DOCS_BIN`); a missing, unauthenticated, or out-of-range
companion fails the apply as `activation-health-failed` with the profile,
lockfile, receipts, and previous activation untouched and the staged set
collected, and never places diagnostic text in a prompt. A transaction that was
already applied natively (an interruption after the mutation) is finalized
through the ordinary previewed `doctor --repair`; finalization repeats the
probes, requires the live DSH and pnpm toolchain to equal the one the pending
plan bound (`plan-drift` otherwise), and re-reads the package's own
declaration from its authenticated artifact before it activates.

Receipts written for a declared package carry the `lifecycle` binding and are
readable only by engines at or after this change; receipts for an undeclared
package and for `remove` omit the key and remain readable by the accepted
baseline engine.

Migrations are declared by state schema. The only declared migration,
`operations-state-v1-to-v2`, runs exactly once through the reviewed
`doctor --repair` path: its plan names the migration id and whether the installed
package declares it, the migrated state can never be selected for the migration
again, and a replay of the consumed plan digest is rejected. `update`,
`rollback`, and `remove` refuse a profile whose state still needs the migration
until that reviewed migration has been applied.

`doctor` reports the installed declaration and the state of every declared
surface, plus the declared and pending migrations. Profile surfaces
(`dependency`, `bundle`, `installed-package`) and generated surfaces are
`present`, `altered`, `missing` (a version 2 receipt expects them), or `absent`
(nothing expects them); the lockfile projection and the home surfaces
(`operations-state`, `operations-lock`, `artifact-store`) are reported only as
`present` or `absent`; generated surfaces are `unknown` when no runtime root
can be resolved; and a profile still on legacy version 1 state is reported
without receipt expectation because its receipt must migrate first. Detection
never writes; the digest-reviewed repair path remains the only mutation.

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

The supported UI boundary is exact: DSH `0.1.2-rc.1`, dsh-tui
`0.10.0-beta.4`, and the
ordered three-bundle composition. Other DSH/TUI releases, arbitrary custom
profiles, and live lane re-adoption after a harness restart remain outside this
contract. Managed continuation metadata can reconstruct an exact host-issued
workspace only when its registered provider reauthenticates the same persisted
cwd and renews the nils workspace lease; stale liveness sidecars never grant
that authority. Under WorkspaceLease v2 that anchor is context only: a denied
anchor lease no longer quarantines the session, and a session may coordinate
several repositories without restarting.

The TUI is an explicit prerelease promotion. Do not replace the exact specifier
with npm's moving `latest` tag. Keep the previous beta.3 profile receipt and
package identity until beta.4 startup, profile inspection, and live smoke have
passed on every deployed surface; rollback restores that exact prior contract
without deleting profile homes or unrelated session state.

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

## Generic deployment dispatcher

`.agents/scripts/deploy.sh` is the repository-owned target of the shared
`meta:deploy` skill, which invokes it as
`agent-run exec --cwd <repo> -- ./.agents/scripts/deploy.sh <args>`. It is a
thin dispatcher over the preview/apply protocol above: it binds an explicit
deployment scope, hands the request to the operations engine through the owner
launcher, and records a bounded receipt. It owns no activation, rollback,
package, lifecycle, or health decision; every refusal about the profile, the
artifact identity, the declared lifecycle, or the host comes from the engine
and is surfaced unchanged as `engine-refused` with the engine's own code and
exit status.

```sh
./.agents/scripts/deploy.sh --help
./.agents/scripts/deploy.sh --phase setup --profile headless \
  --dsh-home /absolute/dsh-home --runtime-root /absolute/dsh-runtime \
  --dsh-bin /absolute/bin/dsh \
  --agent-hook-bin /absolute/nils/bin/agent-hook \
  --agent-docs-bin /absolute/nils/bin/agent-docs \
  --artifact /absolute/sympoies-dsh-runtime-kit-<version>.tgz \
  --artifact-sha256 <64 hex> \
  --receipt /absolute/receipts/setup-preview.json
```

The scope is explicit and complete or the dispatcher refuses before anything
runs: `--phase` (`setup`, `doctor`, `update`, `rollback`, `remove`, or
`repair`), `--profile`, `--dsh-home`, `--runtime-root`, and `--dsh-bin` are
required; the ambient `DSH_HOME` and every `DSH_RUNTIME_KIT_*` variable are
ignored rather than inherited, and the DSH executable is never resolved from
`PATH`. Each missing or malformed input is a typed usage error (exit 64), for
example `missing-dsh-home`, `invalid-phase`, `unexpected-artifact`, or
`expected-plan-digest-required`. `--help` prints the contract and touches
nothing.

`setup` and `update` deploy one immutable artifact: the packed `.tgz` named by
`--artifact` together with its `--artifact-sha256`. The dispatcher reads the
file, refuses a digest mismatch (`artifact-digest-mismatch`, exit 65) or an
archive that is not a bounded `@sympoies/dsh-runtime-kit` package
(`artifact-invalid`) without staging or invoking anything, and otherwise makes
the digest-keyed stage `<stage-root>/<sha256>/package` equal to the archive
bytes. The stage root defaults to `$XDG_CACHE_HOME/dsh-runtime-kit/deploy-stage`
(`--stage-root` overrides it) and must be an owner-only directory. The path is
deterministic so that the preview and the later apply bind the same local
target; a stage whose files no longer equal the artifact is rebuilt from the
authenticated bytes before the engine sees it, so the reviewed plan digest
always binds exactly the artifact that was previewed. The other phases refuse
`--artifact`.

`setup` may target a profile DSH has never initialized: the native mutation
creates it with DSH's own base composition, and a later `remove` leaves that
base composition behind. pnpm drops the emptied `dependencies` object from such
a profile when runtime-kit, its only dependency, is removed; the engine's
collateral classifier treats the absent and the empty object as the same
unowned manifest, so the removal completes instead of being refused as
collateral.

Every phase is a non-mutating preview by default; `doctor` is an inspection.
Applying requires the exact plan digest the unchanged preview reported:
`--apply --expected-plan-digest <digest>`. A successful preview receipt carries
`resume.apply_argv`, the complete argument vector (minus `--receipt`) that
applies that plan, so an operator or a later session can resume without
reconstructing the scope. Cancellation, interruption, retry, and rollback are
the engine's: the dispatcher adds no locks, pending markers, or receipts of its
own, and `--phase repair` maps to the engine's digest-reviewed
`doctor --repair`.

The dispatcher prints one `cli.dsh-runtime-kit.deploy.v1` JSON envelope whose
`data` is a `dsh-runtime-kit.deploy-receipt.v1` record: the phase and mode
(`preview`, `apply`, or `inspect`), the scope, the profile, DSH home, runtime
root and executables, the artifact identity and stage, the bound `plan_digest`,
a bounded `engine` summary (engine root and version, envelope schema, exit
code, mode, action, target identities, or the doctor status), and timestamps.
`--receipt <absolute path>` also persists it atomically with mode `0600`
(parent directories `0700`); a failed phase persists an `ok: false` receipt
carrying the typed error. Raw command output, environment, and full plan bodies
never enter a receipt.

Three deployments are deliberately distinct:

- **Generic deployment** is the dispatcher above against any explicitly named
  DSH home and profile.
- **Candidate canary acceptance** is generic deployment in the default
  `--scope canary`, which refuses the default DSH home (`~/.dsh`) and the
  caller's ambient `DSH_HOME` with `primary-home-requires-primary-scope`, so
  candidate acceptance into a disposable clean profile can never touch a live
  profile by accident. The packed acceptance's operations leg runs the
  dispatcher this way through real DSH for `update`, `doctor`, `rollback`, and
  a refused mismatched artifact.
- **Primary-profile activation** requires `--scope primary --authorized-by
  <identity>`; the identity is recorded in the receipt as `authorized_by`. The
  dispatcher grants no authority of its own: it only refuses to perform a
  live-profile change that nobody named.

The engine is the checkout's own operations plane. `--engine-root` selects
another installed `@sympoies/dsh-runtime-kit` tree that carries
`bin/dsh-runtime-kit.js` and `bin/dsh-runtime-kit-launch.js` — the packed
candidate inside the acceptance sandbox, whose source checkout has no installed
dependencies — and the receipt records which engine root and version ran.

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
the released and validated v1.27.37 executables for every supported DSH row.
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
