# Repository policy

This repository owns the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness (DSH).

## Invariants

- Do not fork or vendor DeepSeek Harness. Use public Cordis and DSH interfaces
  by default. A missing execution boundary may use only the version-scoped,
  hash-authenticated downstream patch declared in
  `compatibility/dsh-patches.json`; patch apply and reverse must fail closed on
  unknown revisions, content drift, or unrelated checkout changes.
- Before proposing a change outside this repository, follow
  `docs/policies/upstream-contribution.md` and exhaust its downstream-first
  order. Agents may only draft third-party issues or PRs; a human submits them
  and signs any DCO or CLA. Never publish a security defect or internal data.
- Keep DSH compatibility code isolated when version-specific adapters become
  necessary. Pin every tested DSH release candidate in compatibility evidence.
- Keep private skill contents, credentials, machine paths, and personal policy
  out of this repository. Public code may discover and load explicitly
  configured private skill directories.
- Do not duplicate a policy engine in JavaScript when the rule belongs in the
  shared `nils-cli` policy boundary.

## Delivery discipline

- Inspect affected targets, callers, tests, and rules; distinguish facts,
  assumptions, and inference. Deliver the smallest correct solution for the
  accepted observable outcome.
- Exclude hypothetical hardening, unsupported edge cases, architecture
  preference, and future flexibility from the current task.
  Possible improvement is not incompleteness.

## Validation

Apply the reviewed patch to a pristine selected checkout, rebuild the host
libraries, and run the keyless end-to-end smoke test:

```sh
node scripts/manage-dsh-patch.mjs --action apply \
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
node scripts/manage-dsh-patch.mjs --action reverse \
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
of `scripts/run-acceptance.mjs`, which supplies the packed operation packages it
requires.

The test must install this package into a clean temporary DSH profile, verify
the composed bundle layer, and execute `runtime_kit_plus_one` through DSH's real
tools pipeline.

## Development log

- `docs/devlog/` is the append-only narrative for notable work: what changed,
  why, the evidence, and links worth keeping. It complements commit messages
  and the normative docs; it does not replace keeping those docs current.
- After non-trivial development work with future debugging or decision value,
  append an entry through the `project-devlog` skill before declaring the task
  complete. Skip transient or same-turn fixes with no durable outcome.
- Keep entries English, newest-first by month, and safe for a public repo. Do
  not record credentials, private skill contents, personal identifiers,
  internal hostnames, private topology, or machine-local paths.

## Project skills

- Project-local skills live under `.agents/skills/<name>/`; the canonical
  source for this workflow is `project-devlog`.
- Search existing entries with
  `scripts/devlog-search.sh <term> [YYYY-MM]` before adding a new one.
