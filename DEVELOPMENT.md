# Development

This guide is the routine contributor entrypoint for `dsh-runtime-kit`. The
repository is the public, out-of-tree Sympoies runtime layer for DeepSeek
Harness. Changes use public Cordis and DSH interfaces by default. The sole
source-level exception is the reviewed, version-scoped patch owned by
`compatibility/dsh-patches.json`. Agent Console additionally applies the exact
installed-package repair owned by `compatibility/dsh-tui-patches.json`. Neither
boundary is a fork or vendored upstream source.

## Prerequisites

- Linux for authoritative finish-line, process-containment, and acceptance
  validation.
- Node.js `22.19` or `24` and npm.
- A pristine DeepSeek Harness `0.1.0-rc.7`, `0.1.0-rc.8`, or `0.1.1-rc.2`
  source checkout for compatibility, patch, and packed smoke validation.
- Released nils-cli `1.27.8` binaries when exercising the real policy,
  agent-docs, Git, review, or delivery boundaries.

Install the package dependencies without running dependency lifecycle scripts:

```sh
npm ci --ignore-scripts
```

Before editing, read `AGENTS.md` and run the repository's declared development
preflight:

```sh
agent-docs preflight --intent project-dev
```

The packaged `agent-docs/` catalog is a DSH runtime asset. It provides compact
model-facing `project-dev` guidance after activation; it is not the canonical
owner of this repository's contributor documentation.

## Source-of-truth boundaries

- `package.json` owns package entrypoints, supported Node versions, scripts,
  bundled files, and the closed DSH/Cordis peer ranges.
- `compatibility/dsh.json`, `compatibility/dsh-patches.json`,
  `compatibility/dsh-tui-patches.json`, and `compatibility/nils-cli.json` own
  the validated upstream revisions, released nils artifacts, public export
  surface, and promotion budgets.
- `policy/rule-parity.yaml` owns the frozen public source inventory.
- `policy/runtime-rule-parity.yaml` owns the current migration projection. It
  does not create a JavaScript policy engine or make a capability executable.
- `docs/architecture.md` owns runtime design and trust-boundary rationale.
- `docs/operations.md` owns activation and operator procedures.
- `docs/acceptance.md` owns the current local-rehearsal and final-promotion
  acceptance boundary.
- `docs/test-first-evidence.md` and `docs/devlog/` retain evidence and history;
  they do not override current code, manifests, or normative documentation.

Keep DSH/TUI-version-specific adaptation isolated under `src/compat/`,
`patches/deepseek-harness/`, and `patches/dsh-tui/`. Rules that
belong to the shared deterministic policy boundary must be implemented in
nils-cli rather than duplicated in this package.

## Routine validation

Run focused tests while iterating, then run the complete routine gate once for
the final candidate:

```sh
npm test
npm run typecheck
npm run benchmark:policy
```

The GitHub package matrix runs these commands on Node.js 22 and 24. It also
benchmarks the packed runtime through the released `agent-hook` and validates
the selected DSH public package closure.

For documentation-only changes, also check whitespace, local Markdown links,
and the publishable package contents:

```sh
git diff --check
npm pack --dry-run --json
```

Inspect the pack result whenever adding a root document or changing
`package.json#files`; a repository-visible file is not automatically part of
the published npm package.

## Packed DSH smoke test

The keyless smoke test installs the packed candidate into a clean temporary DSH
profile, boots the real selected DSH composition, exercises selective context
and finish-line behavior, validates specialist review, and calls
`runtime_kit_plus_one` through DSH's real tool pipeline. Its delivery rehearsal
also creates an ephemeral signing identity and managed feature worktree, then
executes `runtime_kit_governed_commit` as a second real DSH session while
proving the primary checkout and remote default ref did not move.

Prepare a pristine selected DSH checkout without running its repository hook
installer. Apply the authenticated patch, rebuild, run the smoke, then reverse
and prove the upstream checkout pristine:

```sh
node scripts/manage-dsh-patch.mjs --action apply \
  --source-root /path/to/deepseek-harness
pnpm --dir /path/to/deepseek-harness run build:lib:host
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_SMOKE_GIT_CLI_BIN=/path/to/nils-cli/bin/git-cli \
DSH_RUNTIME_KIT_SMOKE_SEMANTIC_COMMIT_BIN=/path/to/nils-cli/bin/semantic-commit \
npm run test:smoke
node scripts/manage-dsh-patch.mjs --action reverse \
  --source-root /path/to/deepseek-harness
pnpm --dir /path/to/deepseek-harness run clean
pnpm --dir /path/to/deepseek-harness run build:lib:host
pnpm --dir /path/to/deepseek-harness dsh --help >/dev/null
test -z "$(git -C /path/to/deepseek-harness status --porcelain=v1 --untracked-files=all)"
```

`upstream_checkout_clean` and `source_checkout_clean` attest the source tree;
the same receipt deliberately reports `runtime_rebuilt: false`. Rebuilding and
smoke-testing the pristine host process is a required part of rollback, because
ignored `lib/` output may still contain the patched dispatcher after source
reversal.

The disposable profile is intentionally unmanaged and therefore does not
claim the owner/coordination authority required for governed default-branch
delivery. Set `DSH_RUNTIME_KIT_SMOKE_DELIVERY_REHEARSAL=1` only from a prepared
managed-session acceptance environment; an unmanaged session must remain
blocked rather than manufacture owner evidence.

The narrower workspace contract smoke installs the same packed candidate into
a clean profile but composes only the exported WorkspaceLease plugin and a
deterministic test provider. Use it across every supported DSH row to isolate
the public DSH lifecycle contract from the default bundle's native nils
transport:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
npm run test:workspace-lease-smoke
```

The native workspace acceptance uses the packed runtime adapter and the exact
candidate `agent-hook` binary. It proves same-worktree denial before the body
and overlapping mutation in two linked worktrees:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
npm run test:workspace-lease-native-smoke
```

Exercise the exact Agent Console layer on the same smoke by selecting the only
authenticated TUI package release. The smoke composes base + TUI + runtime-kit,
applies and verifies the authenticated package-level history-lock patch,
disables only the interactive front door in its test overlay, and boots the
real selected runtime to prove `userQuestions`,
runtime-kit tools/skills, and Main Agent service together:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_PACKAGE='@deepseek-harness-tui/dsh-tui@0.9.3' \
npm run test:smoke
```

The smoke must not contact or mutate an external provider. It may create
temporary local profiles and managed worktrees under its disposable test root.

The independent operations smoke requires two complete staged package variants:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1=/path/to/package-v1 \
DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2=/path/to/package-v2 \
npm run test:operations-smoke
```

## Compatibility validation

Check a prepared upstream checkout against the pinned or reviewed
`upstream-next` channel:

```sh
npm run --silent check:compatibility -- \
  --source-root /path/to/deepseek-harness \
  --channel pinned \
  --format json
```

The complete CI path also packs the authenticated DSH workspace dependency
closure into a private artifact root, writes its receipt elsewhere, and stages
that closure into a disposable consumer:

```sh
npm run --silent pack:compatibility-peers -- \
  --source-root /path/to/deepseek-harness \
  --artifact-root /empty/private/artifacts \
  --channel pinned \
  --pnpm-bin /absolute/path/to/pnpm \
  --receipt /separate/private/receipt.json

npm run --silent stage:compatibility-peers -- \
  --receipt /separate/private/receipt.json \
  --artifact-root /empty/private/artifacts \
  --consumer-root /path/to/disposable/dsh-runtime-kit
```

The upstream checkout must remain clean before and after inspection. Never use
these commands to patch or normalize upstream DSH sources.

## Acceptance and delivery

`npm run acceptance` is a trusted-code source rehearsal, not a self-issued
promotion result. Run it with the required DSH checkout, released nils
executables and provenance, and package-manager paths:

```sh
npm run acceptance -- \
  --dsh-source-root /absolute/path/to/deepseek-harness \
  --agent-hook-bin /absolute/path/to/nils-cli/bin/agent-hook \
  --agent-docs-bin /absolute/path/to/nils-cli/bin/agent-docs \
  --git-cli-bin /absolute/path/to/nils-cli/bin/git-cli \
  --review-specialists-bin /absolute/path/to/nils-cli/bin/review-specialists \
  --semantic-commit-bin /absolute/path/to/nils-cli/bin/semantic-commit \
  --forge-cli-bin /absolute/path/to/nils-cli/bin/forge-cli \
  --nils-source-commit cf997a39ef64127c6b925a3cba0294760b8d31b6 \
  --nils-archive-name nils-cli-v1.27.0-x86_64-unknown-linux-gnu.tar.gz \
  --nils-archive-sha256 192f2e9b0225d730ff870f16654d9cec99a70ccec8dafe3199ea35a8672d421c \
  --pnpm-bin /absolute/path/to/pnpm \
  --npm-bin /absolute/path/to/npm \
  --output /absolute/path/to/acceptance-summary.json \
  --acknowledge-trusted-code
```

The runner generates a run ID and packs the current checkout when no caller
bindings are supplied. `--run-id` is optional. `--package-tarball` and
`--package-sha256` are also optional but must be supplied together when an
external controller binds a prepacked candidate. See
[the acceptance boundary](docs/acceptance.md) before running it.

Final promotion additionally requires the independently selected external
trust root, disposable OS isolation, released-artifact verification, and
provider read-back. Do not describe a local rehearsal as final acceptance.

Commits, worktrees, pull requests, reviews, and merges must use the governed
repository delivery surfaces described by `AGENTS.md`. Do not bypass signing,
hooks, checkout leases, review convergence, or protected-branch controls.
