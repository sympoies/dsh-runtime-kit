# Task Lane Continuity

## Canonical Lane Model

The tracker and lane child issue are the execution source of truth. Once a task
is assigned, its lane is defined by `Owner`,
`Branch`, `Worktree`, `Execution Mode`, and `PR`. For shared lanes, multiple
task rows may share the same lane.

## Continuity Rule

Implementation, clarification, CI repair, and review follow-up stay on the same
assigned lane until the PR is merged or explicitly closed. Main-agent remains
orchestration/review owner; subagent remains implementation owner.

Do not invent replacement branch, worktree, owner, or PR facts because a session
paused or because a review requested follow-up.

## Blockers

When required context is missing or conflicting, preserve the current lane facts
and return a blocker packet:

- confirmed owner, branch, worktree, execution mode, and PR
- exact missing or conflicting input
- current status: `blocked` or `in-progress`
- exact unblock action needed from the main agent

## Reassignment

Reassignment is explicit. Use it only when the current executor cannot continue
or the tracker intentionally changes the lane. Preserve existing PR linkage
until the replacement owner and branch are recorded in the child issue and
tracker checkpoint.
