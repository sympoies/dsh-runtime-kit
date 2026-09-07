# External DSH acceptance harness

This runbook is for Codex or Claude Code acting as the operator outside DeepSeek
Harness (DSH). The harness installs one reviewed runtime-kit candidate into a
clean profile, gives DSH a real task without human diagnostic hints, and reads
typed result rows from `dsh-runtime-kit acceptance-drive`.

Use the exact accepted identities recorded on the owning program issue. Do not
replace a pinned DSH checkout, nils-cli release, runtime-kit commit, or package
digest with a moving branch or tag. A local run is rehearsal evidence; only the
independently controlled hosted job can promote a candidate.

## Load this runbook

Inside this repository, prepare the dedicated intent before an acceptance edit
or delivery phase:

```sh
agent-docs preflight --intent acceptance-harness --phase edit \
  --product codex --strict --require-declared-intent
```

Use `--product claude` for Claude Code. The root `AGENT_DOCS.toml` owns this
intent. The installed DSH catalog remains separate and does not duplicate it.

## Fixed inputs

Resolve these before changing a profile:

- reviewed runtime-kit commit and expected package SHA-256;
- patched and fully rebuilt DSH checkout at the pinned revision;
- one owner-only directory containing all released nils-cli companions from the
  same generation;
- an owner-only Node 24 toolchain directory;
- a clean, owner-only `DSH_HOME`, runtime root, result directory, and scenario
  workdir;
- one absolute host wrapper that executes the pinned checkout's
  `apps/cli/lib/bin.js` with Node 24, and one task wrapper that runs that host
  wrapper through `dsh-runtime-kit-launch` with the accepted runtime root.

Do not use Homebrew or fnm executable paths for authenticated companions when
an ancestor is group- or other-writable. Runtime health rejects that topology
even when the binary digest is correct. Put the environment in an owner-only
shell wrapper and invoke that wrapper by absolute path; do not rely on an
opaque `export PATH=... && npm run ...` command.

## Build before packing or setup

The npm package ships TypeScript build output under `dist/`. `npm pack` does
not build, and the operations engine refuses every lifecycle script that could
build during install. From a clean reviewed checkout, run:

```sh
npm ci --ignore-scripts
npm run build --ignore-scripts
npm run build:provenance
git diff --exit-code -- compatibility/build-provenance.json
npm pack --ignore-scripts --json --pack-destination /absolute/owner-only/artifacts
```

The provenance check must be clean. If it changes, the reviewed source and its
committed build provenance are not the same candidate; stop instead of
installing the regenerated file silently. Preserve the pack receipt and hash
the produced tarball with the same canonical builder used by the accepted
control plane when an exact accepted package digest is required.

`npm run build` also makes every `package.json#bin` target executable. Skipping
that step can make the extracted artifact and the post-install tree have
different identities even though their file contents match.

## Prepare the clean profile

The runtime-kit lifecycle is preview/apply. Bind the following environment in
the owner-only wrapper used for every command:

```text
PATH=<node-24-toolchain>:/usr/bin:/bin
DSH_HOME=<clean-dsh-home>
DSH_RUNTIME_KIT_RUNTIME_ROOT=<owner-only-runtime-root>
DSH_RUNTIME_KIT_DSH_BIN=<absolute-host-dsh-wrapper>
DSH_RUNTIME_KIT_AGENT_HOOK_BIN=<companions>/agent-hook
DSH_RUNTIME_KIT_AGENT_DOCS_BIN=<companions>/agent-docs
```

`DSH_RUNTIME_KIT_DSH_BIN` is the executable identity bound by setup and doctor.
For `--dump-config`, direct tasks, and `acceptance-drive --dsh-bin`, invoke DSH
through the package's launcher so it derives the exact activated policy,
agent-docs, config, and state paths instead of relying on hand-copied values:

```sh
/absolute/dsh-runtime-kit-launch --runtime-root /absolute/runtime-root -- \
  /absolute/host-dsh-wrapper --profile headless --dump-config
```

Because the driver accepts an executable path rather than a command prefix,
put that launcher command in a second owner-only wrapper and pass its absolute
path as `--dsh-bin`.

Preview setup with an already-built local checkout or exact package artifact:

```sh
/absolute/dsh-runtime-kit setup --profile headless \
  --package /absolute/reviewed-runtime-kit --format json
```

Read `data.plan_digest` from that JSON, then apply the unchanged command with:

```sh
/absolute/dsh-runtime-kit setup --profile headless \
  --package /absolute/reviewed-runtime-kit --format json \
  --apply --expected-plan-digest <64-hex-plan-digest>
```

Verify the installed state and composed layer before running a task:

```sh
/absolute/dsh-runtime-kit doctor --profile headless --format json
/absolute/activated-dsh-wrapper --profile headless --dump-config
```

`doctor` must report `ok: true`, `data.status: "healthy"`, an activated package,
the pinned DSH release, and healthy authenticated companion/document probes.
The dumped composition must contain a non-empty runtime-kit bundle layer.

For Agent Console, prepare its named profile through the same setup and doctor
sequence, then give that profile to the driver. The result contract is the same;
only the DSH front door changes.

## Drive one or more tasks

Select only scenarios whose declared `folder_kind` matches the explicit
workdir. Repeated `--scenario` flags run serially. One invocation uses one
workdir; use another invocation for a different folder kind and append to the
same output file.

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --profile headless \
  --scenario automatic-prerequisite.git-repo \
  --workdir /absolute/scenario-repository \
  --output /absolute/results/baseline.jsonl \
  --artifact-dir /absolute/results/artifacts \
  --dsh-home /absolute/clean-dsh-home \
  --dsh-bin /absolute/activated-dsh-wrapper \
  --run-id baseline-real-1
```

To make installation part of the captured run, add
`--package /absolute/already-built-runtime-kit`. The driver performs setup
preview/apply before doctor. This is the local route that can reproduce
install-only failures such as stale build provenance or an executable-role
mismatch. Without `--package`, the driver does not mutate profile lifecycle
state.

The driver does not send explanatory hints to DSH. The catalog's task text is
the complete prompt. If DSH fails, record what DSH and runtime-kit exposed; do
not add a human explanation and retry. A failure that an external harness
cannot diagnose from those surfaces is a reporting defect for the diagnostics
child of the program, not an invitation to fix it during baseline capture.

## Result contract

The output is append-only JSONL. Every selected scenario produces one
`dsh-runtime-kit.acceptance-drive-result.v1` row, followed by one
`dsh-runtime-kit.acceptance-drive-summary.v1` row for the invocation. A rerun
appends a new run id and never replaces prior evidence.

A result row reports:

- scenario/catalog owner, profile, workdir and declared folder kind;
- `stage`: `profile-setup`, `profile-doctor`, `scenario-precondition`, or
  `dsh-task`;
- `status`: `pass`, `fail`, or `precondition-unmet`;
- DSH argv, exit code, signal and duration;
- SHA-256/byte-count pointers to bounded stdout and stderr artifacts;
- new or changed DSH session transcript pointers and runtime-kit state receipts;
- observed policy action/rule markers when the session transcript exposes them;
- expected marker/reminders, missing reminders, and forbidden outcomes seen.

The result row is the index. Read the referenced stdout, stderr, transcript, or
receipt only when the row says it is relevant. Do not paste raw local absolute
paths or unredacted transcripts into a provider comment; use `$HOME/...` for a
useful retained path and summarize private output.

`precondition-unmet` is a typed result, not a driver crash. Examples are an
unhealthy/uninstalled profile, a setup identity refusal, or a workdir whose
actual kind differs from the selected scenario. A missing success marker, a
non-zero DSH exit, an expected reminder that never appeared, or a forbidden
outcome produces `fail`.

Policy decisions are projected only from redacted, model-visible transcript
markers. When the installed generation exposes no such structured marker, the
row says `policy_decisions.source: "unavailable"`; it never invents an allow.
Universal structured failure diagnosis remains a later program deliverable.

## Direct task and failure reading

For a one-off task outside the driver, the equivalent DSH call is:

```sh
/absolute/activated-dsh-wrapper --profile headless "<complete task text>"
```

DSH prints the final assistant message to stdout and reasoning/progress to
stderr. Persistent rc.1 session logs are normally compressed as
`$DSH_HOME/sessions/<workspace>/session-*/session.jsonl.zstd`; the driver also
recognizes older workdir `.dsh/sessions/` and `.sessions/` layouts. Runtime-kit lifecycle state is under
`$DSH_HOME/runtime-kit/state/`; `doctor --format json` is the supported summary
surface.

Read failures in this order:

1. acceptance result `stage`, `status`, and typed `error.code`;
2. captured exit/signal and stdout/stderr artifact hashes;
3. referenced operation state/receipt and session transcript;
4. a fresh `doctor --profile <name> --format json` and `--dump-config`.

An install-only identity failure occurs before DSH can run a task. The driver
captures it only when `--package` is supplied; otherwise the failing setup
command is separate evidence. Hosted acceptance remains the promotion proof
because it installs the package under the independent operations engine and
trust root after merge.

## Restart and rollback

Use a new `--run-id` and the same output path for a restart. Never truncate the
JSONL or reuse an artifact filename. A run that stopped after a setup failure
may require `doctor --repair`; follow its preview/apply plan and do not infer a
repair from filesystem state.

The driver never rolls back or removes a profile automatically. Running it
without `--package`, deleting its result directory, or removing the driver from
a later package leaves the installed profile untouched. Profile rollback and
removal remain explicit preview/apply operations through `dsh-runtime-kit`,
followed by `doctor` and a direct DSH boot of the resulting profile.

## Promotion boundary

For the owning child issue, retain the scripted-provider row that proves the
driver and the real-provider row produced by Codex or Claude Code acting alone.
Record failures without repairing them outside the child's scope. After the PR
merges, create the signed same-tree review anchor, reproduce the package digest,
purely repin the hosted control manifest, and run the hosted workflow. A pure
repin does not require reinstalling the acceptance runner; only a controller
script change does.
