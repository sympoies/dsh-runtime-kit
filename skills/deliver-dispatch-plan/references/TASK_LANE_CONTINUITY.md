# Task Lane Continuity

## Canonical Lane Model

The dispatch ledger and latest dispatch state comment are the runtime execution
source of truth. Once a task is assigned, its lane is defined by `Owner`,
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

Reassignment is explicit. Use it only when the current subagent cannot continue
or the authoritative dispatch state intentionally changes. Preserve existing
ledger and PR linkage until the replacement lane is written back through a
dispatch state/session comment.
