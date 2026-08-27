---
name: worktree-triage
description: >
  Scan and classify git worktrees against a base ref, prune safe/superseded
  ones, and rescue unmerged work by PR or onto the local default branch. A
  rebase probe confirms supersession; in-progress work is never lost.
---

# Worktree Triage

## Contract

Prereqs:

- For one repo, run from inside the target git repository (or pass
  `--repo <path>`).
- For machine-wide cleanup, pass `--all-managed` to scan every repository
  represented under the managed worktree root
  (`${DSH_RUNTIME_KIT_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/dsh-runtime-kit}/worktrees`).
- `git` and `git-cli >=1.27.16` are on `PATH`; Python 3.11+ is available (the bundled
  `worktree_triage.py` scanner is stdlib-only). `semantic-commit` is required
  for any commit the rescue path makes; `forge-cli >=1.11.2` is required only
  for the PR-mode rescue path. The scan itself needs no provider access.
- The base ref the work should have landed on is fetched and current in every
  scanned repo. The scanner is **read-only and never fetches** — run
  `git fetch origin --prune` yourself first (in each represented repo for
  `--all-managed`) so `origin/main` ahead/behind is not stale. The **PROBE**
  (step 3) classifies against the *local* base with a rebase, so its
  supersession verdict stays correct even when a remote is unreachable
  (404, offline, renamed org).
- The PROBE and the rescue **mutate branches** (rebase, commit). They are
  governed: commits go through `semantic-commit`; landing on the default branch
  goes through `semantic-commit default-branch`. This skill never runs a raw
  `git commit`/`git merge` on the default branch (see *Hook & tooling
  constraints*).

Inputs:

- The scope to scan:
  - `--all-managed` for every repo represented under the managed worktree
    root. Use this when the user says "all worktrees", "no agents are running",
    or otherwise asks for global cleanup without naming one repo.
  - `--repo <path>` for one repo, or no scope flag to scan the current repo.
- The base ref each branch is classified against (`--base`, defaults to
  `origin/main`).
- Persistent branch names to retain (`--protect-branch <branch>`, repeatable).
  Use exact names such as `mainline`; protection never changes the scan base.

Outputs:

- A `worktree-triage.scan.v1` JSON envelope (or text) with a `scope`, optional
  `worktree_root`, a `repos` array, a `summary` (per-disposition counts) and a
  `worktrees` array. Each record carries `path`, `repo_root`, `branch`,
  `is_primary`, `disposition`, `suggested_action`, and — for branches with
  unique commits — `ahead`/`behind`, a `unique_commit_count`, and an `evidence`
  block with the two-dot `git diff <base>..<branch>` shortstat plus a
  `likely_superseded` flag. Each repo record also carries `base_freshness`
  (`{base, upstream, behind_upstream}`) when the base has an upstream, so the
  caller can spot a **stale local base** before landing onto it.
- The envelope carries the sorted `protected_branches` input. Every worktree
  record carries `protected`; clean matching branches use the `protected`
  disposition and never enter the safe-removal set.
- `likely_superseded` is **advisory** — a cheap patch-id hint. The **PROBE**
  (step 3), not this flag, is what confirms supersession.

Dispositions (the SCAN's cheap first pass):

- `primary` — the repo's main working tree. Never a removal target.
- `dirty` — uncommitted changes present. Never *discarded*; the rescue path
  commits the work onto the branch first (zero-loss), then treats it normally.
- `locked` — a git-locked worktree. Surfaced, never auto-removed.
- `protected` — an explicitly retained persistent branch. Leave it in place;
  when checked out and clean, refresh it with `git-cli sync-branch`.
- `safe-merged` — branch tip is an ancestor of the base (nothing ahead).
  Safe to prune.
- `safe-superseded` — branch is ahead by commit SHA, but **every** commit is
  patch-equivalent to one already in the base (`git cherry` reports them all as
  `-`). Safe to prune.
- `rescue-candidate` — branch has commits whose patch is not in the base. This
  is **resolved by the PROBE**, not by reading `evidence` prose: it may be
  genuine unmerged work, or work already on the base via a different commit
  (patch-id is unreliable). Never auto-pruned from the SCAN alone.

Failure modes:

- Not a git repo, or `--base` does not resolve (usually a missing `git fetch`,
  or a non-`main` default branch — pass `--base`). In `--all-managed`, per-repo
  base failures are reported in `errors`; do not prune worktrees from a repo
  whose base could not be verified — but note the PROBE can still classify
  against a *local* base even when the *remote* base is unreachable.
- A worktree is `dirty` or `locked`: a verdict to act on, not a tool error.
  Never discard a dirty worktree; commit its work to the branch first.
- `base_freshness.behind_upstream` large (local base far behind its upstream):
  a signal **not** to land rescued work onto that stale base — keep the branch
  and land after the base is refreshed.

## Entrypoint

Resolve the helper against this skill's DSH resource base:

```bash
worktree_triage_script="<skill-resource-base>/scripts/worktree-triage.sh"
```

For all managed agent worktrees, fetch each represented repo first, then scan:

```bash
"$worktree_triage_script" --all-managed --base origin/main --format json
```

For one repo, fetch first so the base ref is current, then scan:

```bash
git fetch origin
"$worktree_triage_script" --repo . --base origin/main --protect-branch mainline
```

Machine-readable envelope for selection logic:

```bash
"$worktree_triage_script" --repo . --base origin/main --format json
```

## Workflow — SCAN → PROBE → ACT

### 1. SCAN (read-only)

Choose scope, fetch each represented repo (`git fetch origin --prune`; the
scanner never fetches), then run the scanner and treat its output as evidence.
Present the triage grouped into: safe-to-prune (`safe-merged` +
`safe-superseded`), rescue-candidates, retained (`protected`), and blocked
(`dirty` / `locked` / `primary`). Surface each repo's `base_freshness`; flag
any repo whose local base is far behind its upstream.

### 2. Prune the mechanically safe set

When the user has asked to clean up, prune every `safe-merged` /
`safe-superseded` record without per-item confirmation, against the reported
`path`, deleting the branch from that record's `repo_root` (rows may come from
different repos under `--all-managed`). Run each mutation with the command
tool's top-level workdir set to the record's `repo_root`:

```bash
git-cli worktree remove <path> --format json
git branch -d <branch>   # use -D if it is merged only to the LOCAL default
```

Delete a remote branch only when it has no open PR, or its PR is
superseded/closed. Never prune a `primary`, `dirty`, `locked`, or `protected` worktree, and
never prune anything from a repo listed in `errors`.

### 3. PROBE each rescue-candidate (the definitive supersession / landing test)

First guarantee **zero-loss**: if the worktree has uncommitted work (a
`rescue-candidate` you are about to probe, or a `dirty` worktree you are
rescuing), commit it onto its own branch with `semantic-commit` — never
discard. This decouples "rescue" from "landing".

Then, with the command tool's top-level workdir set to the worktree, rebase the
branch onto the base:

```bash
GIT_EDITOR=true git rebase <base>
```

Rebasing operates on the **feature branch**, not the default branch, so it does
not trip the default-branch delivery guard. Three outcomes:

- **superseded-confirmed** — the rebase collapses the branch to `0` ahead of
  the base (git drops every commit as an already-applied cherry-pick). The
  branch's work is already in the base. Prune it like the safe set. This
  replaces the old, unreliable "match `git cherry -v` subjects against base
  commit bodies" step.
- **genuine, ff-ready** — the rebase completes cleanly and the branch is still
  `N` ahead. Real unmerged work, now fast-forwardable. Go to step 4.
- **conflicted** — resolve trivial/additive conflicts yourself (e.g. the branch
  adds a symbol the base does not have, or the base added tests the branch
  lacks). For genuine **semantic divergence** (the same logic changed two
  different ways), STOP and ask the user which side to take — never guess. If
  it cannot be resolved safely, `git rebase --abort` (work stays committed on
  the branch) and retain it with a report.

### 4. ACT — land genuine work by delivery mode

Pick the delivery mode from the environment, not by habit:

- **PR mode** (a forge is available — the default): hand the ff-ready branch to
  `deliver-pr`. Triage never merges.
- **local-main mode** (no PR: forge down / offline / the user asked to "commit
  to local main"): after the rebase has made the branch ff-ready, land it on
  the local default branch through the governed path — **not** a raw
  `git merge`/`git branch -f`:

  Materialize and stage only the proven feature-branch patch in the clean
  primary checkout through the ordinary project-dev mutation boundary. Then
  bind the explicit repository and current full `HEAD`, validate the exact
  preflight without a receipt, and run the authorized mutation with a new
  outside-repository receipt:

  ```bash
  semantic-commit default-branch --repo <absolute-repo-root> \
    --expect-head <full-current-head> --dry-run --automation --format json \
    --message <message>
  semantic-commit default-branch --repo <absolute-repo-root> \
    --expect-head <full-current-head> --receipt-out <outside-repo-receipt> \
    --automation --format json --message <message>
  ```

  If `base_freshness` shows the local base is far behind its upstream, prefer
  keeping the branch and landing after the base is refreshed. If the landing
  cannot run from the agent shell (hook-blocked), emit a copy-paste script for
  the user's own terminal instead.

After landing or pruning, remove the worktree by running `git-cli worktree
remove <path>` with the tool workdir set to `<repo_root>`. Keep the branch for
genuine work that has not yet landed;
delete it once its work is in the base.

### 5. Stop at the human gate

Never remove a `primary` or `protected` worktree, never *discard* a `dirty` worktree (commit-to-branch
first), never remove rows from repos with scan `errors`. Land on the default
branch only with the applicable authorization (PR confirmation for PR mode;
current-request maintainer approval for default-branch completion). Ask the user
on any semantic conflict, and never treat a related commit as proof of
supersession — the PROBE is the proof.

## Delivery Modes

- **PR mode (default).** A forge is reachable and PRs are accepted. Genuine
  `rescue-candidate` work goes to `deliver-pr`; triage opens/merges nothing
  itself.
- **local-main mode.** PRs are unavailable (forge outage, offline, or the user
  explicitly wants local-only commits). Rescue lands on the local default
  branch through `semantic-commit default-branch`, which requires
  current-request maintainer approval for default-branch delivery. This mode
  relies on the PROBE having made the branch ff-ready first, and honors the
  `base_freshness` stale-base guard.

## Hook & Tooling Constraints (agent execution notes)

- **`block-unsafe-default-delivery`** blocks a raw-shell `git merge` targeting
  the default branch — and even a read-only inspection that references it in a
  delivery-shaped command. A `git rebase <base>` on a *feature* branch is not
  blocked. So the rescue path rebases (feature branch) and lands via
  `semantic-commit default-branch`; it never raw-merges the default branch.
- **`git-cli worktree remove` handles dirty worktrees** (it snapshots them). Do
  **not** `git reset --hard` / `git clean` a worktree before removing it — those
  trip the delivery guard and are unnecessary.
- **`git-cli` resolves the repo from the tool workdir.** Set the command tool's
  top-level workdir to the repo (or one of its worktrees) before
  `git-cli worktree remove`; do not retarget with shell `cd`.
- **`git branch -d` checks the upstream**, so a branch merged only to the
  *local* default refuses to delete. Use `-D` after confirming it is merged to
  `HEAD`.
- **`semantic-commit default-branch`** requires explicit opt-in, an absolute
  `--repo`, full `--expect-head`, the clean primary default checkout with
  staged-only changes, and authoritative remote-free or aligned cached-default
  identity. `--dry-run` forbids a receipt; mutation requires a new absolute
  outside-repository `--receipt-out`. Compound/nested shell forms fail closed.

## Boundary

`worktree_triage.py` owns read-only enumeration, the ahead/behind and ancestor
checks, the patch-equivalence (`git cherry`) call, the two-dot net-diff
evidence, `base_freshness`, explicit branch protection, and the SCAN
disposition verdict — it never
mutates. The skill body owns SCAN orchestration, the **PROBE** (the rebase-based
supersession / landing test), the zero-loss commit-to-branch, and mode-aware
landing through governed tools (`semantic-commit` / `deliver-pr`). It never
re-implements the scanner's classification in prose, never auto-removes a
`dirty`/`locked`/`protected`/`primary` worktree, never removes a branch from a repo with
scan errors, never lands on the default branch outside the governed path, and
never guesses a semantic conflict.

## Related Skills

- `deliver-pr` — owns the provider lifecycle for a genuine `rescue-candidate`
  in PR mode. Triage never merges.
- `semantic-commit` — governed commits for the rescue path, including
  `default-branch` for local-main mode.
- `sync-runtime-surfaces` — its apply path refuses linked-worktree source
  roots; this skill is the companion that cleans those worktrees up.
