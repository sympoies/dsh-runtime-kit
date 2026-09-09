# Development reference

Detailed source ownership, build, packaging, compatibility, acceptance, and
delivery reference for `dsh-runtime-kit`. Routine contributor principles and
the declared validation gate live in the root
[`DEVELOPMENT.md`](../DEVELOPMENT.md); always-loaded safety policy lives in
[`AGENTS.md`](../AGENTS.md).

This reference documents the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness. Changes use public Cordis and DSH interfaces by default. The
sole source-level exception is the reviewed, version-scoped patch owned by
`compatibility/dsh-patches.json`. Agent Console additionally applies the exact
installed-package repair owned by `compatibility/dsh-tui-patches.json`. Neither
boundary is a fork or vendored upstream source.

## Prerequisites

- Linux for authoritative finish-line, process-containment, and acceptance
  validation.
- Node.js `24` or newer and npm. The repo pins `24` in `.node-version`, so an
  fnm-managed shell (`fnm use`, or `--use-on-cd`) selects it regardless of the
  host default; `.npmrc` sets `engine-strict` and the acceptance runner refuses
  older Node outright.
- A pristine DeepSeek Harness `0.1.1-rc.2`, `0.1.2-alpha.4`, or `0.1.2-rc.1`
  source checkout for compatibility, patch, and packed smoke validation.
- A released nils-cli version accepted by
  [`compatibility/nils-cli.json`](../compatibility/nils-cli.json) when
  exercising the real policy, agent-docs, Git, review, or delivery boundaries.

Install the package dependencies without running dependency lifecycle scripts:

```sh
npm ci --ignore-scripts
```

Before editing, load the repository policy through the product-native entrypoint
(`AGENTS.md`, or Claude's `CLAUDE.md` import) and run the declared edit-phase
preflight. `--require-declared-intent` prevents a missing or undiscovered root
catalog from passing as an empty success:

```sh
agent-docs preflight --intent project-dev --phase edit \
  --strict --require-declared-intent
```

Two catalogs intentionally coexist. The repository-root `AGENT_DOCS.toml`
routes contributor work in this checkout. The packaged
`agent-docs/AGENT_DOCS.toml` is a DSH runtime asset whose home-scoped paths
resolve inside the installed `agent-docs/` directory; it is not the owner of
repository contributor routing and must not be copied over the root catalog.

| Owner | Document | Products | Intent / phase | Required | Load timing |
| --- | --- | --- | --- | --- | --- |
| Harness | `AGENTS.md` | Codex, Hermes, DSH | session policy | yes | Loaded by each harness at session start; it is deliberately not duplicated in either catalog. |
| Harness | `CLAUDE.md` → `@AGENTS.md` | Claude | session policy | yes | Claude loads its native project entrypoint at session start, which imports the complete repository policy from `AGENTS.md`; neither file is duplicated in a catalog. |
| Root catalog | `PROJECT_DEV_EDIT.md` | Codex, Claude, Hermes | `project-dev` / `edit` | yes | Loaded on every repository edit preflight as the runtime-neutral compact contributor contract. |
| Root catalog | `DEVELOPMENT.md` | Codex, Claude, Hermes | `project-dev` / `edit`, `delivery` | no | Available on demand for setup, ownership, validation, or delivery detail; it is not mandatory prompt context. |
| Root catalog | `docs/policies/upstream-contribution.md` | Codex, Claude, Hermes | `project-dev` / `delivery` | no in the catalog | Available only in delivery preflight. The repository policy (`AGENTS.md`, imported by Claude through `CLAUDE.md`) makes reading it mandatory before proposing work outside this repository. |
| Packaged DSH catalog | installed `PROJECT_DEV_EDIT.md` (source: `agent-docs/PROJECT_DEV_EDIT.md`) | DSH | `project-dev` / `edit` | yes | Loaded from the activated DSH home catalog. DSH is excluded from the root document entries so it never receives a duplicate copy. |

The root catalog's `project-dev` validation contract applies to Codex, Claude,
Hermes, and DSH when they work in this repository. Run its three commands after
the final mutation and before declaring the task complete: `npm test`,
`npm run typecheck`, and `npm run benchmark:policy`. Architecture, operations,
acceptance, and retained evidence remain on-demand references reached through
the source-of-truth list below; they are not automatic model context.

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
- `docs/operations.md` owns activation and operator procedures, including the
  repository-owned generic deploy dispatcher `.agents/scripts/deploy.sh`
  (implemented in `src/deploy/index.ts`) that the shared `meta:deploy` skill
  invokes through `agent-run exec --cwd <repo> -- ./.agents/scripts/deploy.sh`.
- `docs/acceptance.md` owns the current local-rehearsal and final-promotion
  acceptance boundary.
- `docs/test-first-evidence.md` and `docs/devlog/` retain evidence and history;
  they do not override current code, manifests, or normative documentation.

Keep DSH/TUI-version-specific adaptation isolated under `src/compat/`,
`patches/deepseek-harness/`, and `patches/dsh-tui/`. Rules that
belong to the shared deterministic policy boundary must be implemented in
nils-cli rather than duplicated in this package.

The shipped sources are TypeScript. `npm run build` compiles them to `dist/`
with `tsc -p tsconfig.json`, and `npm run typecheck` is the same compile with
`--noEmit`. Import specifiers keep their `.js` extension: `NodeNext` resolves
`./x.js` to `x.ts`, so nothing in the source rewrites when the build layout
changes.

`npm run build:emit` is the same compile with `--noCheck`: it emits `dist/` without
resolving the DSH peer types. It exists for the CI legs that install the
consumer with `--omit=peer` and need the compiled `dist/scripts/**` entry points
before the selected DSH closure is staged; it is not a substitute for `npm run build`,
which those legs still run through `pretest` once the closure is in place.

The repository scripts are TypeScript as well. `scripts/*.ts` compile into
`dist/scripts/`, and everything that runs one names the compiled file: the three
shipped `bin` entries and the `./check-rule-parity-source` export (which run from
an installed tree under `node_modules`, where Node refuses to strip types), the
npm scripts, the workflow, and the commands in this document. A script resolves
the package root through `src/package-root.ts`, never through
`dirname(import.meta.url)`, because the compiled file sits one level deeper.
`npm run build:provenance` is itself a compiled script, so a fresh clone runs
`npm run build` (or `build:emit`) before it. The only JavaScript left in the
repository is `test/fixtures/authoritative-acceptance-canary/`; see the test
paragraph below for why.

The tests under `test/` are TypeScript too, and Node runs them directly:
`npm test` is `node --test test/*.test.ts`, which relies on Node 24 type stripping
from the checkout. Two rules follow. A specifier between test files must name
the real extension (`./helpers/x.ts`), because Node has no `NodeNext`-style
`.js`-to-`.ts` mapping at runtime. And `test/fixtures/**` stays JavaScript,
because the canary fixture is installed into a DSH profile under
`node_modules`, where Node refuses to strip types. `npm run typecheck:test`
(`tsconfig.test.json`, `noEmit`, `allowImportingTsExtensions`) typechecks the
test program; it is advisory rather than a declared gate while the suite still
builds partial doubles that the production types reject.

**No npm lifecycle hook may run the build.** `INSTALL_LIFECYCLE_SCRIPTS` in
`src/operations/index.ts` refuses an installed package declaring any of
`preinstall`, `install`, `postinstall`, `prepare`, `preprepare`,
`postprepare`, `prepublish`, `prepublishOnly`, `prepack`, `postpack`, or
`dependencies`. A plain `build` script is permitted because it is not a
lifecycle name, and `pretest` runs it before the suite, but nothing builds
automatically at pack or install time. `npm pack --ignore-scripts` would not run
a hook even if one were allowed.

That is why the artifact carries its own freshness proof.
`package.json#dsh.build` declares
[`compatibility/build-provenance.json`](../compatibility/build-provenance.json),
which records the digest of the sources the build consumed;
`npm run build:provenance` writes it. The operations engine recomputes that
digest from the sources **as packed** and refuses a mismatch as
`build-output-stale`. Without it a stale `dist/` would install while the source
tree, the typecheck, the plan digest and the receipt all still looked correct —
the same failure shape as skipping the `tsdown` stage of the DSH rebuild.

Two rules follow, and both are easy to get wrong:

- The provenance writer takes its file list from `npm pack --dry-run --json`,
  never from a walk of the working tree. `npm` drops the names it always
  ignores and a tarball carries no directory entries, so a working-tree walk
  disagrees with the extracted package over entirely ordinary contents and fails
  every install as stale with no rebuild able to fix it.
- The tarball ships `src/**` beside `dist/**`. The engine needs the packed
  sources to recompute the digest at all, and a review still reads the source in
  the artifact itself.

Resolve a packaged asset with `packageAsset()` from `src/package-root.ts`, not
with `new URL(..., import.meta.url)`. A built module sits under `dist/` at a
depth that differs per file, so a module-relative asset path resolves inside the
build output where no asset exists.

Node still refuses to strip types from any `.ts` under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, re-verified on Node 26), which
is why the package ships compiled JavaScript rather than executing its
TypeScript directly. The Gate 0 record on issue #202 holds those probes.

## Routine validation

Run focused tests while iterating, then run the complete routine gate once for
the final candidate:

```sh
npm test
npm run typecheck
npm run benchmark:policy
```

The GitHub package matrix runs these commands on Node.js 24. It also uses the
pinned released `agent-docs` and `agent-hook` binaries to audit the root
catalog, resolve every Codex/Claude/Hermes phase, prove packaged DSH document
isolation, and classify all three DSH validation commands through the
authoritative finish-line resolver. The remaining jobs benchmark the packed
runtime and validate the selected DSH public package closure.

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
npm run build
node dist/scripts/manage-dsh-patch.js --action apply \
  --source-root /path/to/deepseek-harness
pnpm --dir /path/to/deepseek-harness run build:lib:host
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_SMOKE_GIT_CLI_BIN=/path/to/nils-cli/bin/git-cli \
DSH_RUNTIME_KIT_SMOKE_SEMANTIC_COMMIT_BIN=/path/to/nils-cli/bin/semantic-commit \
npm run test:smoke
node dist/scripts/manage-dsh-patch.js --action reverse \
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
applies and verifies the narrowed package-level rc.2 compatibility patch,
disables only the interactive front door in its test overlay, and boots the
real selected runtime to prove `userQuestions`,
runtime-kit tools/skills, and Main Agent service together:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_PACKAGE='@deepseek-harness-tui/dsh-tui@0.10.0-beta.4' \
npm run test:smoke
```

The smoke must not contact or mutate an external provider. It may create
temporary local profiles and managed worktrees under its disposable test root.

The independent operations smoke requires two complete staged package variants
and the repository-owned deploy dispatcher it drives through real DSH:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/bin/agent-docs \
DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1=/path/to/package-v1 \
DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2=/path/to/package-v2 \
DSH_RUNTIME_KIT_DEPLOY_DISPATCHER=/path/to/checkout/.agents/scripts/deploy.sh \
npm run test:operations-smoke
```

`npm run acceptance` supplies all of them from the packed candidate and the
source checkout.

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
  --agent-session-bin /absolute/path/to/nils-cli/bin/agent-session \
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
[the acceptance boundary](acceptance.md) before running it.

Final promotion additionally requires the independently selected external
trust root, disposable OS isolation, released-artifact verification, and
provider read-back. Do not describe a local rehearsal as final acceptance.

Commits, worktrees, pull requests, reviews, and merges must use the governed
repository delivery surfaces described by `AGENTS.md`. Do not bypass signing,
hooks, checkout leases, review convergence, or protected-branch controls.

## DeepSeek Harness patch and rollback notes


Apply the reviewed patch to a pristine selected checkout, rebuild the host
libraries, and run the keyless end-to-end smoke test:

```sh
npm run build
node dist/scripts/manage-dsh-patch.js --action apply \
  --source-root /path/to/deepseek-harness
cd /path/to/deepseek-harness
./node_modules/.bin/tsx scripts/clean.ts
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json
./node_modules/.bin/tsdown --env.DSH_BUILD_FACE host
cd -
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-bin/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-bin/agent-docs \
npm run test:smoke
```

Clean first. On a tree carrying stale build output, `tsdown` treats the
repository root as a build target and aborts during config resolution with
`[@deepseek-ai/dsh-root] Cannot find entry:
["lib/types/{index,invariant,startup}.js"]`, before bundling any package. On a
cleaned tree it does not: an unfiltered run builds all 233 packages while the
root `lib/types/` never exists at all, which is why the root was never a
required target. CI never meets the failure because it runs `pnpm run clean`
before every build.

Invoke the binaries directly rather than through `pnpm run <script>`. A
`pnpm run` in the DSH checkout first performs a dependency-status check that can
auto-run `install`, and that install fails on an ordinary developer machine —
for example when a user-owned global `core.hooksPath` makes DSH's
`install-lefthook` postinstall refuse. The failure happens before the script
runs and is unrelated to the build.

Both rebuild stages are required, and the second one is the easy one to skip.
`tsc -b` emits `lib/types/*.js`; each package's `exports` `.` resolves to
`lib/index.js`, which only `tsdown` produces by bundling that output. Applying
the patch changes `src/` alone, so without the `tsdown` stage the runtime keeps
importing an older bundle while the source tree, the patch receipt and
`lib/types/` all look correct.

`tsdown` also accepts `-F <package>` to narrow the build to named workspace
packages. That is a speed optimization on a cleaned tree, not a requirement, and
it is easy to get wrong: the filter must cover every package the active patch
touches for the release under test, and
`native-execution-boundaries-v5` does not touch the same set in every release —
the two rc releases include `dsh-tool-cordis` and alpha.4 does not. Prefer the
unfiltered build unless rebuild time actually matters.

Rolling back reverses the same two stages:

```sh
node dist/scripts/manage-dsh-patch.js --action reverse \
  --source-root /path/to/deepseek-harness
# then repeat both rebuild stages above
```

The reverse receipt authenticates source state only (`runtime_rebuilt: false`).
Rollback is incomplete until the pristine host libraries have been rebuilt and
an unpatched `dsh` process has been booted against them. `npm run test:smoke`
cannot serve as that proof: it asserts the checkout is `patched` before anything
runs, so on a pristine checkout it fails closed by design. Boot the rolled-back
harness directly instead: install any plugin into a scratch profile and dump the
composed configuration, invoking the CLI entry point rather than `pnpm dsh` for
the reason given above.

```sh
cd /path/to/deepseek-harness
DSH_HOME=/tmp/dsh-probe node apps/cli/lib/bin.js plugin --profile probe \
  add --offline --save-exact /path/to/any-plugin.tgz
DSH_HOME=/tmp/dsh-probe node apps/cli/lib/bin.js --profile probe --dump-config
```

A non-empty composed bundle layer proves the rebuilt libraries load.
`dsh --version` is not sufficient; it does not exercise the host bundles.

The smoke resolves further companions as siblings of `AGENT_HOOK_BIN`:
`review-specialists`, `forge-cli`, `main-agent` and `agent-session`
(`GIT_CLI_BIN` additionally for `npm run test:workspace-lease-native-smoke`).
Provide all of them from one nils-cli generation. Companion authentication
rejects a binary whose ancestor directories are group- or other-writable, so a
Homebrew `Cellar` install fails as
`DSH_RUNTIME_HEALTH_COMPANION_IDENTITY_INVALID` even when its digest is correct;
stage the binaries into a private directory instead. Binaries older than the
contracts under test fail as typed bridge errors (`policy-output-invalid`,
`finish-line response invalid`), not as version warnings.

`npm run test:workspace-lease-smoke` and
`npm run test:workspace-lease-native-smoke` cover the lease protocol and the
two-repository attribution legs; a single-repository smoke cannot distinguish
per-repository authority from anchor authority, because the resolved root equals
the anchor there. `npm run test:operations-smoke` is not standalone — it is a leg
of `scripts/run-acceptance.ts`, which supplies the packed operation packages it
requires.

The test must install this package into a clean temporary DSH profile, verify
the composed bundle layer, and execute `runtime_kit_plus_one` through DSH's real
tools pipeline.
