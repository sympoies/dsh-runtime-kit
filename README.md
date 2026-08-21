# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public Sympoies runtime layer for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It
adds governed development workflows, selective project context, specialist
review, and safe lifecycle operations through public Cordis and DSH extension
interfaces.

The package is a DSH bundle, not a fork or copied preset. DSH uses
dsh-runtime-kit plus [nils-cli](https://github.com/sympoies/nils-cli), while
Codex and Claude Code continue to use agent-runtime-kit plus nils-cli and are
not modified by DSH activation. DSH continues to own the agent loop, sessions,
tools, sandbox, approvals, skills, and subagents.

## What it provides

- 29 bundled public workflow skills, with native project-skill discovery and
  an optional private-skill directory.
- Selective `runtime_context({ intent: "project-dev" })` delivery instead of
  injecting a documentation corpus into every prompt.
- DSH lifecycle policy and result-driven validation through released nils-cli
  contracts.
- `review_specialists({ task, roles })`, backed by eight fixed, read-only
  reviewer personas and deterministic structured findings.
- `runtime_kit_plus_one`, a small native tool used to prove that the composed
  DSH tool pipeline is live.
- Optional DSH-native Main Agent Mode when the host exposes its subagent
  service.
- Digest-reviewed setup, update, rollback, repair, and removal for an isolated
  DSH runtime root.

## Supported runtime

| Dependency | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| Cordis | `4.0.1` |
| Node.js | `22.19` or `24` |
| nils-cli | `1.27.1` |

The package deliberately does not claim compatibility with later DSH release
candidates or the eventual `0.1.x` line. See the
[compatibility guide](docs/compatibility.md) for the pinned machine-readable
contract and promotion checks.

## Install and activate

Use the native DSH `headless` profile. Unknown profile names contain only the
base bundle and are not equivalent to `headless`.

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
- [Compatibility](docs/compatibility.md)
- [Private and project skills](docs/private-skills.md)
- [Acceptance boundary](docs/acceptance.md)
- [Historical migration snapshot](docs/migration.md)
- [Development log](docs/devlog/README.md)
- [Contributor setup and validation](DEVELOPMENT.md)

## License

[MIT](LICENSE)
