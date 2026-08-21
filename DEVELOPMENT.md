# Development

This guide is the routine contributor entrypoint for `dsh-runtime-kit`. The
repository is the public, out-of-tree Sympoies runtime layer for DeepSeek
Harness; changes must use public Cordis and DSH interfaces and must not copy or
vendor DSH implementation code.

## Prerequisites

- Linux for authoritative finish-line, process-containment, and acceptance
  validation.
- Node.js `22.19` or `24` and npm.
- A clean, built DeepSeek Harness `0.1.0-rc.7` source checkout for compatibility
  and packed smoke validation.
- Released nils-cli `1.27.0` binaries when exercising the real policy,
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
  bundled files, and exact DSH/Cordis peer versions.
- `compatibility/dsh.json` and `compatibility/nils-cli.json` own the validated
  upstream revisions, released nils artifacts, public export surface, and
  promotion budgets.
- `policy/rule-parity.yaml` owns the frozen public source inventory.
- `policy/runtime-rule-parity.yaml` owns the current migration projection. It
  does not create a JavaScript policy engine or make a capability executable.
- `docs/architecture.md` owns runtime design and trust-boundary rationale.
- `docs/operations.md` owns activation and operator procedures.
- `docs/test-first-evidence.md` and `docs/devlog/` retain evidence and history;
  they do not override current code, manifests, or normative documentation.

Keep DSH-version-specific adaptation isolated under `src/compat/`. Rules that
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
profile, boots the real rc.7 composition, exercises selective context and
finish-line behavior, runs the governed Git path, validates specialist review,
and calls `runtime_kit_plus_one` through DSH's real tool pipeline.

Prepare a clean built DSH checkout without running its repository hook
installer, then run:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
npm run test:smoke
```

The smoke must not contact or mutate an external provider. It may create
temporary local profiles and managed worktrees under its disposable test root.

The independent operations smoke requires two complete staged package variants:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
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
promotion result. It requires explicit arguments for the selected DSH checkout,
six nils executables, package artifact, and isolated run identity, plus
`--acknowledge-trusted-code`. See [the acceptance boundary](docs/acceptance.md)
before running it.

Final promotion additionally requires the independently selected external
trust root, disposable OS isolation, released-artifact verification, and
provider read-back. Do not describe a local rehearsal as final acceptance.

Commits, worktrees, pull requests, reviews, and merges must use the governed
repository delivery surfaces described by `AGENTS.md`. Do not bypass signing,
hooks, checkout leases, review convergence, or protected-branch controls.
