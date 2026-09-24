# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public Sympoies runtime layer for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It
adds governed development workflows, selective project context, specialist
review, and safe lifecycle operations through Cordis and DSH extension
interfaces plus reviewed, version-scoped downstream patches.

The package is a DSH bundle plus exact DSH source and installed-TUI package
patches, not a fork or copied preset. The DSH patch is maintained here; the TUI
patch remains only until its separately tracked upstream repair is released.
DSH uses
dsh-runtime-kit plus [nils-cli](https://github.com/sympoies/nils-cli), while
Codex and Claude Code continue to use agent-runtime-kit plus nils-cli and are
not modified by DSH activation. DSH continues to own the agent loop, sessions,
tools, sandbox, approvals, skills, and subagents.

For repository maintenance, start with
[`DEVELOPMENT.md`](DEVELOPMENT.md). Detailed build, package, patch, smoke,
compatibility, acceptance, and delivery procedures are in the
[`development reference`](docs/development-reference.md).

## Repository boundary

- This repository owns reusable DSH runtime governance and lifecycle contracts.
- [`sympoies/dsh-applications`](https://github.com/sympoies/dsh-applications)
  owns the coordinated public application and profile catalog.
- [`sympoies/dsh-plugins`](https://github.com/sympoies/dsh-plugins) owns
  independently released DSH plugins.

## What it provides

- 29 bundled public workflow skills, with native project-skill discovery and
  an optional private-skill directory.
- Automatic execution-bound `project-dev-context` prerequisites for mutating
  tools, with context injected once and policy freshness checked on every call.
- Explicit `runtime_context({ intent: "project-dev" })` delivery remains
  available without injecting a documentation corpus into every prompt.
  When a managed worktree differs from the session cwd, verify it with
  `workspace_recovery_handoff`, then use
  `runtime_context({ intent: "project-dev", project_path: "/absolute/worktree" })`
  for that exact verified path. Set Bash `workdir` within that worktree; native
  file edits use the checkout lease's authenticated target. The project-dev
  prerequisite, policy, and checkout lease are checked for the target worktree.
- DSH lifecycle policy and result-driven validation through released nils-cli
  contracts.
- Model-hidden native runtime health for exact DSH/nils identity, project
  catalog readiness, and optional child capabilities. Failed dependencies are
  rejected at DSH admission boundaries instead of becoming prompt context.
- Strict public plugin and bot composition contracts with canonical
  dependency resolution and secret-free sibling lock receipts.
- A governed per-instance workload manager with verifier-owned trust reads,
  signed admission, lifecycle/reconcile state, authenticated control frames,
  and broker-only mediated GitHub effects.
- `review_specialists({ task, roles })`, backed by eight fixed, read-only
  reviewer personas and deterministic structured findings. Reviews inherit the
  parent model route unless `reviewerAgentOptions` pins one, which takes a
  provider and model together plus an optional reasoning effort and output
  token ceiling.
- `runtime_kit_plus_one`, a small native tool used to prove that the composed
  DSH tool pipeline is live.
- Session-owned artifacts (`artifact_write`, `artifact_present`,
  `artifact_read`, `artifact_export`, `artifact_dispose`): opaque, non-bearer
  references for generated outputs with exact-agent authorization, atomic
  streaming commits, retention classes, and digest-bound export receipts.
- `runtime_kit_governed_commit`, a structured, no-shell completion path bound
  to the current session-owned non-default managed worktree. It accepts no
  repository/workdir routing and returns a validated `semantic-commit`
  receipt, or a typed `no-repository` result with guidance when the session
  runs in a folder that is not a Git repository.
- Optional DSH-native Main Agent Mode when the host exposes its subagent
  service.
- Digest-reviewed setup, update, rollback, repair, and removal for an isolated
  DSH runtime root.
- Tiered policy enforcement: integrity rules always block, governed delivery
  seams block by default and may be downgraded to a reminder for debugging
  through a receipt-bound `--policy-overrides` file, and reminders never
  block. The tier table is owned by nils-cli and declared in the packaged
  policy (see [compatibility](docs/compatibility.md#policy-enforcement-tiers)).

## Supported runtime

| Dependency | Supported version |
| --- | --- |
| DeepSeek Harness (generic/headless) | `0.1.5-alpha.2` or `0.1.6-alpha.2` |
| Agent Console candidate | DSH `0.1.6-alpha.2` + pristine dsh-TUI `0.10.2`; deployed host remains on DSH `0.1.2-rc.1` + TUI `0.10.1` until promotion |
| Cordis | `4.0.2` |
| Node.js | `24` or newer |
| nils-cli | `1.28.3` minimum; exactly validated through `1.28.43` |

The package deliberately supports a rolling window of exactly two reviewed
DSH releases. Promoting a newer release retires the oldest in the same change;
unlisted releases are unsupported. Both retained releases pair with Cordis
4.0.2; cross-version DSH/Cordis combinations are not
admitted. See the
[compatibility guide](docs/compatibility.md) for the pinned machine-readable
contract and promotion checks.

Every supported DSH checkout must carry the authenticated
`native-execution-boundaries-v5` patch before runtime-kit is activated. It adds
the exact tool-prerequisite transaction boundary, the native pre-waterfall
model guard, fail-closed descriptor-bound subprocess execution for
authenticated companion snapshots, one optional synchronous GoalService
acceptance call, and normalization only for a concretized blank, non-widening
sandbox schema echo before native Bash or filesystem dispatch. Real escalation
requests retain DSH's strict validation and approval path. The patch does not
copy or fork DSH. On 0.1.6-alpha.2 it also makes an enabled `dsh-runtime-kit`
row a required startup entry, so a failed health or policy activation cannot
degrade into an optional-plugin warning, and gives the new tool scheduler a
process-wide identity so separately installed profile packages share the same
execution boundary. The
packaged lifecycle command verifies the exact Git revision, patch digest,
before/after file hashes, and the complete checkout status:

```sh
npm run build
node dist/scripts/manage-dsh-patch.js --action apply \
  --source-root /absolute/deepseek-harness
pnpm --dir /absolute/deepseek-harness run build:lib:host
```

Unknown revisions, partial application, content drift, and unrelated changes
fail closed. Rollback reverses the same patch and proves the checkout pristine:

```sh
node dist/scripts/manage-dsh-patch.js --action reverse \
  --source-root /absolute/deepseek-harness
pnpm --dir /absolute/deepseek-harness run build:lib:host
```

Patch receipts attest source state and therefore report `runtime_rebuilt:
false`; the rebuild and an unpatched smoke check are required before rollback
is considered complete.

## Install and activate

The candidate package supports the native `headless` profile on either retained
generic DSH release, `0.1.5-alpha.2` or `0.1.6-alpha.2`. Its Agent Console
contract targets DSH `0.1.6-alpha.2` and pristine dsh-TUI `0.10.2`. The
currently deployed Agent Console remains on its earlier generation:

- DSH `0.1.2-rc.1` and Agent Console's `dsh-tui` profile with
  `@deepseek-ai/dsh-base`,
  `@deepseek-harness-tui/dsh-tui@0.10.1`, then
  `@sympoies/dsh-runtime-kit` revision
  `481f521f561b065ca8ec05da59be6415b837f75b` in that order.

Do not install this candidate artifact into the deployed Agent Console generation: its
generic peer window no longer includes DSH `0.1.2-rc.1`. Generic DSH admission
does not promote Agent Console. Before `setup`, `update`, `rollback`, or
`doctor --repair` may mutate `dsh-tui`, runtime-kit also requires the running
DSH version and source revision to match the exact Agent Console contract. A
Agent Console deployment must validate and replace its DSH, TUI, runtime-kit
artifact, profile, and configuration as one independently rollbackable
generation.

Unknown profile names contain only the base bundle. They are neither equivalent
to `headless` nor accepted as Agent Console profiles. The machine-readable
Agent Console boundary is
[`compatibility/agent-console.json`](compatibility/agent-console.json).
With pnpm 11, the Agent Console provisioner must use the adjacent
[`compatibility/agent-console-pnpm-workspace.yaml`](compatibility/agent-console-pnpm-workspace.yaml)
installation contract before installing the TUI. It preserves DSH's native
profile linker and peer settings while recording the TUI release's explicit
`false` lifecycle decisions. Those package-install decisions do not restrict
the agent's host CLI or `PATH`.

The candidate profile composes base, the consumer-owned compatibility bundle,
the authenticated 0.10.2 archive, and runtime-kit in that order. The
compatibility bundle supplies a disabled legacy row needed by TUI's unchanged
Cordis patch; the profile's own patch disables TUI's obsolete code-runtime row.
Check the installed TUI against `compatibility/dsh-tui-pristine.json` after the
profile is complete. Before every TUI launch, restrict retained history data:

```sh
dsh-runtime-kit-tui-history
```

The preflight keeps the TUI package byte-for-byte pristine. It restricts
owner-owned legacy history directories and files to 0700/0600 before the TUI
reads them, preserves content, and refuses symlinked or foreign-owned paths.
The published TUI still displays its unverified-DSH-version warning because its
peer declaration ends before 0.1.6; deployment requires functional evidence
for this exact pair.

### Agent Console history adapter

`dsh-runtime-kit-history` is the read-only boundary between DSH's native
session store and Agent Console. `capabilities` reports the supported schema and
session format without opening a store. `list` reads snapshot headers and file
metadata without loading transcript bodies. `summaries` and `messages` read
only the explicit session ids requested by `agent-session`, project visible
user and assistant text, and exclude injected user-role events. Every response
uses the versioned `dsh-runtime-kit.history.v1` JSON envelope.

The four DSH history packages are pinned by the Agent Console DSH composition.
Every adapter operation refuses an installed version other than the exact
supported composition. They are supplied by the outer DSH installation rather
than declared as runtime-kit dependencies, so the adapter does not widen the
runtime-kit's public rolling-window peer surface or pre-populate the
authenticated compatibility staging targets.

The adapter never creates, resumes, mutates, or deletes a DSH session. DSH
history remains non-resumable in Agent Console. Callers must use an absolute
session root, invoke the executable directly without a shell, bound its process,
time, and output, and treat an unavailable or malformed adapter as a partial
history result rather than a DSH launch failure.

The package is not yet published to the npm registry. Until a release is
available, pack a reviewed source checkout and install that exact local tarball
so `dsh-runtime-kit` and `dsh-runtime-kit-launch` are available. Replace the
placeholder below with the full commit SHA you reviewed:

```sh
git clone https://github.com/sympoies/dsh-runtime-kit.git
cd dsh-runtime-kit
reviewed_commit=REPLACE_WITH_A_REVIEWED_FULL_COMMIT_SHA
git checkout --detach "$reviewed_commit"
test "$(git rev-parse HEAD)" = "$reviewed_commit"
test -z "$(git status --porcelain)"
npm ci --ignore-scripts
runtime_kit_tarball="$(npm pack --ignore-scripts --silent)"
npm install --global --ignore-scripts --legacy-peer-deps \
  "$PWD/$runtime_kit_tarball"
install -d -m 0700 /absolute/dsh-runtime
```

Preview setup and retain the returned `plan_digest`:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package "$PWD" --format json
```

Apply only that unchanged reviewed plan, verify the installation, and start
DSH through the same launcher:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package "$PWD" \
  --apply --expected-plan-digest <plan-digest> --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh --profile headless "run the requested task"
```

For Agent Console, first let its provisioner create the exact `dsh-tui`
base/TUI profile, then run the same preview/apply/doctor sequence with
`--profile dsh-tui`. Launch the TUI through the owner launcher:

```sh
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-tui
```

That composition retains the TUI's `userQuestions` interaction service and
adds runtime-kit tools, skills, and `mainAgentOrchestration`. With no reviewed
worker override, Main Agent workers inherit the live controller route; an Agent
Console controller on `codex-proxy/gpt-6-sol` therefore launches Sol workers.
Runtime-kit adds only its own Cordis row: the host remains responsible for an
explicit `DSH_PERMISSION_MODE`, the matching approval policy, and environment-
name credential references.

All mutating operations are preview-first and digest-bound. The launcher owns
the DSH-only hook, policy, agent-docs, and state paths; do not copy those values
into `$DSH_HOME/.env` or populate them individually. Full update, rollback,
repair, remove, storage, and isolation guidance lives in the
[operations guide](docs/operations.md).

## Skills and review

Bundled public skills are always available. Project skills take precedence over
an explicitly configured private catalog, and the private catalog takes
precedence over bundled skills. Private loading is opt-in and never imports an
existing Codex or Claude Code skill directory. See
[private and project skills](docs/private-skills.md).

Specialist review and Main Agent Mode are independent optional child plugins.
If DSH has no subagent service, the parent policy, context, operations, and
skills surfaces still activate. See [Main Agent Mode](docs/main-agent-mode.md)
for its ownership model and current limitations.

## Documentation

- [Documentation index](docs/README.md)
- [Operations](docs/operations.md), including the repository-owned generic
  deploy dispatcher `.agents/scripts/deploy.sh`
- [Architecture and runtime contract](docs/architecture.md)
- [Native runtime health](docs/runtime-health.md)
- [Composition contracts](docs/composition-contracts.md)
- [Governed workload manager](docs/workload-manager.md)
- [Workspace identity and leases](docs/workspace-leases.md)
- [Authoritative completion acceptance](docs/authoritative-acceptance.md)
- [Compatibility](docs/compatibility.md)
- [Private and project skills](docs/private-skills.md)
- [Acceptance boundary](docs/acceptance.md)
- [Historical migration snapshot](docs/migration.md)
- [Development log](docs/devlog/README.md)
- [Contributor workflow](DEVELOPMENT.md)
- [Detailed development reference](docs/development-reference.md)

## License

[MIT](LICENSE)
