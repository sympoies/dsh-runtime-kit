# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public Sympoies runtime layer for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It
adds governed development workflows, selective project context, specialist
review, and safe lifecycle operations through Cordis and DSH extension
interfaces plus reviewed, version-scoped downstream patches.

The package is a DSH bundle plus exact, reviewed DSH source patches, not a fork
or copied preset. DSH uses dsh-runtime-kit plus
[nils-cli](https://github.com/sympoies/nils-cli), while Codex and Claude Code
continue to use agent-runtime-kit plus nils-cli and are not modified by DSH
activation. DSH continues to own the agent loop, sessions, tools, sandbox,
approvals, skills, and subagents.

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

- 28 bundled public workflow skills, with native project-skill discovery and
  an optional private-skill directory.
- Automatic execution-bound `project-dev-context` prerequisites for mutating
  tools, with context injected once and policy freshness checked on every call.
- Explicit `runtime_context({ intent: "project-dev" })` delivery remains
  available without injecting a documentation corpus into every prompt.
  `runtime_context({ intent: "project-dev", phase: "delivery" })` returns the
  packaged delivery policy (the named work modes and Git delivery) and phase
  `review` the review-convergence and evidence policy, on demand. The
  `devlog`, `external-facts`, `web-testing`, `memory`,
  `upstream-contribution`, and `peer-coordination` intents return their
  packaged home policies.
  To work in another checkout, including from a session started outside a Git
  repository, use
  `runtime_context({ intent: "project-dev", project_path: "/absolute/worktree" })`
  for the target. Set Bash `workdir` to that checkout; native file edits use
  the checkout lease's authenticated target. A released dirty worktree may be
  picked up by the next session without moving its starting cwd. With nils-cli
  v1.28.46 and a DSH session approval policy of `ask`, an idle live foreign
  lease can transfer after approval of the exact tool call; active or uncertain
  operations remain fenced.
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
  to the session cwd, a non-default managed worktree. It accepts no
  repository/workdir routing, so another worktree commits with
  `semantic-commit commit --repo <absolute worktree path>`. It returns a validated `semantic-commit`
  receipt, or a typed `no-repository` result with guidance when the session
  runs in a folder that is not a Git repository.
- Optional DSH-native Main Agent Mode when the host exposes its subagent
  service.
- Digest-reviewed setup, update, rollback, repair, and removal for an isolated
  DSH runtime root.
- Packaged DSH home instructions (`agent-home/AGENTS.md`) that activation
  installs as the kit-managed `<dshHome>/AGENTS.md`, DSH's native user-global
  instruction file, so the shared home rules load with every session. An
  existing user-authored file is never overwritten.
- Tiered policy enforcement: integrity rules always block, governed delivery
  seams block by default and may be downgraded to a reminder for debugging
  through a receipt-bound `--policy-overrides` file, and reminders never
  block. The tier table is owned by nils-cli and declared in the packaged
  policy (see [compatibility](docs/compatibility.md#policy-enforcement-tiers)).

## Supported runtime

| Dependency | Supported version |
| --- | --- |
| DeepSeek Harness (generic/headless) | `0.1.7-rc.1` or `0.2.0-rc.2` |
| Cordis | `4.0.4` with both DSH releases |
| Node.js | `24` or newer |
| nils-cli | `1.29.0` minimum; exactly validated through `1.33.0` |

The package deliberately supports a rolling window of exactly two reviewed
DSH releases. Promoting a newer release retires the oldest in the same change;
unlisted releases are unsupported. Each retained release has an exact Cordis
pairing; cross-version DSH/Cordis combinations are not
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
copy or fork DSH. The
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
false`; the rebuild and pristine CLI check are required before source reversal
is considered complete. CI also exercises the retained 0.1.7 tools canary with
its authenticated patch.

## Install and activate

The package supports the native `headless` profile on either retained generic
DSH release, `0.1.7-rc.1` or `0.2.0-rc.2`. Unknown profile names contain
only the base bundle; they are not equivalent to `headless`.

Runtime-kit does not compose a TUI profile. Agent Console DSH sessions use the
separately released DSH Workbench (`sympoies/dsh-workbench`), which pins exact
DSH, dsh-TUI, and runtime-kit revisions in one reviewed contract and validates
and rolls them back as one generation.

### Agent Console history adapter

`dsh-runtime-kit-history` is the read-only boundary between DSH's native
session store and Agent Console. `capabilities` reports the supported schema and
session format without opening a store. `list` reads snapshot headers and file
metadata without loading transcript bodies. `summaries` and `messages` read
only the explicit session ids requested by `agent-session`, project visible
user and assistant text, and exclude injected user-role events. Every response
uses the versioned `dsh-runtime-kit.history.v1` JSON envelope.

The four DSH history packages must all come from one supported DSH release
(`0.1.7-rc.1` or `0.2.0-rc.2`); every adapter operation refuses any other
composition. They are supplied by the outer DSH installation rather than
declared as runtime-kit dependencies, so the adapter does not widen the
runtime-kit's public rolling-window peer surface or pre-populate the
authenticated compatibility staging targets. Pass `--profile-root
<dshHome>/profiles/<name>` to read the store through the packages that profile
boots — its hoisted dependencies, its DSH installation, then its
`dsh.profile.bundles`, which is where DSH carries the session persistence
backend. Without it, the packages resolve from the installation that carries
the runtime-kit copy, and an installation without them refuses every operation
with no output.

`agent-session` runs a profile's `dsh_history.command` with only
`<operation> --root <dir> --compression <zstd|none>` and passes no
`--profile-root`. A DSH composition therefore exposes its store to Agent Console
through a composition-owned wrapper command that execs this adapter with
`--profile-root` for its own profile; the DSH Workbench install provides it as
its history face. Point `dsh_history.command` at that wrapper, not at this
executable, unless the runtime-kit installation itself carries the DSH history
packages.

The adapter never creates, resumes, mutates, or deletes a DSH session; resuming
one belongs to the DSH TUI and the session daemon. Callers must use absolute
session and profile roots, invoke the executable directly without a shell, bound
its process, time, and output, and treat an unavailable or malformed adapter as
a partial history result rather than a DSH launch failure.

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

The installed bundle adds runtime-kit tools, skills, and
`mainAgentOrchestration`. With no reviewed worker override, Main Agent workers
inherit the live controller route. Runtime-kit adds only its own Cordis row: the host remains responsible for an
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
