# Dispatch Outcome Routing

`program/dispatch` is a specialization of the plain program tracker in the
work-modes policy (`runtime_context` intent `project-dev`, phase `delivery`).
Select it only when lane PRs must integrate on a
shared branch before the integration PR can land on main. Otherwise each child
issue delivers independently through plain program mode.

## Writers

| Record or action | Writer |
| --- | --- |
| Tracker body, dependency graph, and integration checkpoints | Dispatch orchestrator |
| Lane implementation, validation, and PR targeting the integration branch | Assigned lane executor |
| Lane review evidence and provider review | Independent reviewer |
| Guarded non-default-base lane merge | Dispatch orchestrator after approval |
| Final integration PR review and merge | `deliver-pr` with dispatch owner acceptance |
| Child and tracker closeout | Dispatch orchestrator after provider read-back |

Assigning workers to lanes does not transfer tracker,
review, or merge authority to an implementation worker. Return a review
finding to its original lane unless an explicit reassignment is recorded.

## Stop Conditions

Stop on stale provider heads, missing or contradictory issue state, incomplete
validation, failing required checks, unresolved findings or threads, missing
independent approval, open child work, or a rejected provider gate. Read the
current issue and PR state before a retry. `forge-cli` owns provider lifecycle
writes; `git-cli` and `semantic-commit` own worktree and commit mutations.
