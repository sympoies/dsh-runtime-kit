# Git delivery

Use the repository-declared delivery workflow and the released nils-cli owners
for commits, worktrees, provider records, and pull or merge requests. Do not
bypass signing, hooks, protected branches, review gates, or checkout leases.

Before mutating git state, resolve the repository, exact branch, base, and
delivery target. Preserve unrelated user work. Tracked commits belong in a
managed non-default worktree unless the user explicitly authorizes the
repository's supported default-branch path.

Delivery is complete only after required validation and review evidence is
bound to the delivered head, the provider reports the expected terminal state,
and requested activation or closeout work has finished. Cleanup must be
targeted and lease-safe: remove a managed worktree only after proving that it
has no live foreign owner, and delete a local branch only when its tip equals
the provider-confirmed delivered head. Otherwise retain it and report the exact
recovery action.
