# Git delivery

This delivery-phase policy owns agent-authored Git and provider state: who
performs each mutation, how to read a refusal, which delivery mode applies, and
how to clean up. Runtime policy and the governed CLIs own exact command
parsing and state checks; prefer their current `--help` over copying syntax.

## Mutation owners

Every Git mutation has one owner. Raw `git` is right for reads, for staging
with `git add -- <paths>`, and for anything with no owner below.

| Mutation | Owner |
| --- | --- |
| Commit in the session cwd | `runtime_kit_governed_commit` (backed by `semantic-commit`) |
| Commit in another worktree | `semantic-commit commit --repo <absolute worktree path>` |
| Managed worktree add or remove | `git-cli worktree` |
| Publish a branch | `git-cli push` |
| Adopt the remote default branch locally | `git-cli sync-default` |
| Fast-forward a published non-default branch | `git-cli sync-branch` |
| Pull request create, review, merge | `forge-cli pr` (through the `deliver-pr` skill) |
| Publish the default branch | `forge-cli repo push-default` |

Raw `git merge` and `git pull` on the default branch stay refused even with
`--ff-only`: a remote-tracking ref is locally writable, so local state cannot
prove the commit was published. `git-cli sync-default` verifies the fast-forward
against the configured remote. `git-cli sync-branch` fast-forwards a checked-out
integration branch to its same-named upstream and never authors, rebases,
resets, or pushes.

## Reading a refusal

- `[default-delivery: blocked]`: the command was classified and is forbidden.
  Change what you are doing, not how you spell it.
- `[default-delivery: unverified]`: the command could not be classified, so it
  failed closed. A `cd`, `source`, or Git environment assignment earlier in the
  same command usually causes it. Run the Git command on its own, with an
  explicit absolute repository path, or in a separate tool call.
- A commit command after any other command in the same call cannot prove which
  executable runs. Stage in one call and commit in the next.

Each refusal names the governed surface for the operation you attempted.

## Delivery modes

| Mode | Authorization | Authoring and delivery | Terminal evidence |
| --- | --- | --- | --- |
| Pull request (default) | An explicit current-task request for provider delivery, or an approved workflow that owns it | Signed commit on a non-default managed-worktree branch, then `deliver-pr` | Pull request URL, delivered head, reviews and checks, provider merge read-back |
| Direct to the default branch | The maintainer explicitly requests a direct commit and push in the current task | Exactly one signed commit on a non-default managed-worktree branch, then `forge-cli repo push-default --expected-base <full sha> --reason-file <path>` | Receipt whose observed remote SHA equals the delivered head |
| Local default-branch commit | The maintainer explicitly requests one local-only commit in the current task | `semantic-commit default-branch` with an explicit absolute `--repo` in the clean primary checkout; no provider call | Receipt with `provider_delivered=false` |

Implementation alone never authorizes provider mutation. Never infer either
default-branch mode from a change being small, urgent, or called a hotfix; the
authorization expires with the current task. If the change grows beyond one
commit, its expected base moves, signing cannot be verified, or the mode is
uncertain, keep the managed branch and ask for the delivery decision.

`forge-cli repo push-default` permits only a verified fast-forward of one
locally verified signed commit with a bounded reason file, pinned to one push
URL with a compare-and-swap on the exact old remote SHA. It has no force,
delete, or retry option. Raw pushes to the default branch, `--all` or
`--mirror` pushes, and commits on the checked-out default branch are refused.

Never enable `extensions.worktreeConfig`, set per-worktree author or signing
configuration, or disable signing. If signing fails, stop and report it.

## Naming the target

A commit is classified against the repository it commits in, not the tool
workdir. Bind another checkout with an explicit absolute `--repo`. A relative,
`~`, globbed, or expanded destination, a nested shell, and a command-local
`GIT_*` or `HOME` override do not resolve a governed target. A refusal names the
resolved repository and the first failing precondition; correct the invocation
instead of retrying it unchanged.

## Commits and branches

- Non-trivial commits carry one or two body bullets. Each bullet starts with a
  dash, a space, and an uppercase letter.
- Give either a full message or the structured `--type`, `--scope`,
  `--subject`, and `--body-bullet` fields, never both.
- Ground the subject and body in the actual diff, never in `git log -1`.
- Branch prefixes match the pull request kind: `feat/`, `fix/`, `chore/`,
  `docs/`, `ci/`, `refactor/`. `git-cli worktree add <slug> --kind <kind>`
  derives the matching branch.

## Worktrees and checkout leases

- `git-cli worktree` owns the managed worktree lifecycle; direct mutating
  `git worktree` is refused.
- A checkout lease admits one writer per checkout. A clean linked worktree can
  take it. A live foreign lease, a dirty checkout you do not own, or a
  pre-existing merge or rebase routes you to a new managed worktree. A sole
  `git rebase|merge|cherry-pick|revert|am --abort` stays admitted, so a stuck
  checkout can recover in place.
- Taking over a dirty checkout needs the user's explicit authorization for
  that exact state through the workspace recovery tools; never infer it.

## Pull requests

- Use `forge-cli` and the `deliver-pr` skill for provider records; raw
  `gh pr create` and `glab mr create` are refused.
- Bodies carry at least `## Summary` and `## Test plan`, grounded in the diff.
  Reference a program tracker with a non-closing `Refs #<n>`.
- When the test-first gate is enabled, `--kind feature` and `--kind bug`
  delivery requires `--test-first-evidence <dir>` pointing at a
  `verify`-clean record; `docs`, `chore`, `ci`, and `refactor` are exempt.

## Terminal cleanup

1. Capture the checkout root, branch, delivery mode, and delivered head SHA.
2. Clean up only after provider truth matches that head (the pull request merge
   or the direct-push receipt) and every parent-owned duty, such as issue
   closeout, deploy, or archive, is complete.
3. Recheck local status first. Retain and report anything dirty, locked,
   missing, or unverified; never force a removal.
4. Remove a managed worktree with `git-cli worktree remove <path-or-slug>` from
   the primary checkout, as the sole mutation of its command. It leaves the
   branch; delete the branch only when its tip equals the provider-confirmed
   delivered head.
5. Advance a primary checkout left behind with `git-cli sync-default`.

A child workflow hands its captured identity to a `program/dispatch` parent
that still owns terminal duties instead of cleaning up early. The outermost
successful workflow cleans up exactly once.
