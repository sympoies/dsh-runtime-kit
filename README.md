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

## What it provides

- 29 bundled public workflow skills, with native project-skill discovery and
  an optional private-skill directory.
- Automatic execution-bound `project-dev-context` prerequisites for mutating
  tools, with context injected once and policy freshness checked on every call.
- Explicit `runtime_context({ intent: "project-dev" })` delivery remains
  available without injecting a documentation corpus into every prompt.
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
  reviewer personas and deterministic structured findings.
- `runtime_kit_plus_one`, a small native tool used to prove that the composed
  DSH tool pipeline is live.
- `runtime_kit_governed_commit`, a structured, no-shell completion path bound
  to the current session-owned non-default managed worktree. It accepts no
  repository/workdir routing and returns a validated `semantic-commit`
  receipt.
- Optional DSH-native Main Agent Mode when the host exposes its subagent
  service.
- Digest-reviewed setup, update, rollback, repair, and removal for an isolated
  DSH runtime root.

## Supported runtime

| Dependency | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7`, `0.1.0-rc.8`, or `0.1.1-rc.2` |
| Cordis | `4.0.1` |
| Node.js | `24` or newer |
| nils-cli | `1.27.17` minimum; exactly validated through `1.27.27` |

The package deliberately does not claim compatibility with DSH release
candidates after rc.2 or the eventual stable `0.1.x` line. See the
[compatibility guide](docs/compatibility.md) for the pinned machine-readable
contract and promotion checks.

Every supported DSH checkout must carry the authenticated
`native-execution-boundaries-v2` patch before runtime-kit is activated. It adds
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
node scripts/manage-dsh-patch.mjs --action apply \
  --source-root /absolute/deepseek-harness
pnpm --dir /absolute/deepseek-harness run build:lib:host
```

Unknown revisions, partial application, content drift, and unrelated changes
fail closed. Rollback reverses the same patch and proves the checkout pristine:

```sh
node scripts/manage-dsh-patch.mjs --action reverse \
  --source-root /absolute/deepseek-harness
pnpm --dir /absolute/deepseek-harness run build:lib:host
```

Patch receipts attest source state and therefore report `runtime_rebuilt:
false`; the rebuild and an unpatched smoke check are required before rollback
is considered complete.

## Install and activate

Two exact DSH `0.1.1-rc.2` compositions are supported:

- the native DSH `headless` profile; and
- Agent Console's `dsh-tui` profile with
  `@deepseek-ai/dsh-base`,
  `@deepseek-harness-tui/dsh-tui@0.10.0-beta.3`, then
  `@sympoies/dsh-runtime-kit` in that order.

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

After installing the authenticated 0.10.0-beta.3 archive and before starting
the TUI, apply the exact beta.2/beta.3-on-DSH-rc.2 compatibility repair:

```sh
dsh-runtime-kit-manage-dsh-tui-patch --action apply \
  --package-root /absolute/dsh-home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
```

The command accepts only the exact package name, version, `package.json` bytes,
patch digest, and target before/after hashes in
[`compatibility/dsh-tui-patches.json`](compatibility/dsh-tui-patches.json).
Unknown or partially patched packages fail closed. The repair removes the
prerelease's alpha-only package-inventory override, which the selected DSH rc.2
base bundle does not provide, and moves lock retries off the prompt submission
stack so history persistence remains best-effort without delaying command
dispatch.
Before reading history, it also restricts owner-owned legacy data directories
and files to 0700/0600 and refuses unexpected or symlinked paths. Apply, check,
and reverse always authenticate and move both package targets together.

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
Console controller on `codex-proxy/gpt-5.6-sol` therefore launches Sol workers.
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
- [Operations](docs/operations.md)
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
- [Contributor setup and validation](DEVELOPMENT.md)

## License

[MIT](LICENSE)
