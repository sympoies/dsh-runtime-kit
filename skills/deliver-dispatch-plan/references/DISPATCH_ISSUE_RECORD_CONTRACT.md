# Dispatch Issue Record Contract

## Tracker

The tracker issue is the authoritative plan for one dispatch program. Its body
contains a program key, purpose, resumption instructions, dated settled
decisions, a phase table with one checkbox row per lane child issue, the
dependency graph derived from those rows, open decisions, and checkpoint log.
The work-modes policy (`runtime_context` intent `project-dev`, phase
`delivery`) owns the base program record, and
`issue-follow-up`'s `references/tracker-row-grammar.md` owns the phase row
grammar.
Use `workflow::tracking` and the applicable type and area labels.

Create or edit the body with `forge-cli issue` and a Markdown body file, and
read it back after mutation. Fill the graph, lint, and tick as
`issue-follow-up`'s `references/program-mode.md` (Tracker Commands) says,
including its manual fallback. Comments add chronology; they do not silently
override a settled decision or dependency in the body. A checkpoint names the
changed lane, provider PR and head, validation, review disposition, current
blocker, and next action. Keep local worktree paths and secrets out of
provider text.

## Child Lanes

Each independently reviewable lane has one child issue with the program key,
item id, scope, acceptance, dependencies, branch/base, and owner. Keep PR,
validation, review, and merge evidence in its comment timeline. Use
`workflow::follow-up`. A lane may share an executor or branch only when the
tracker explicitly records that grouping and the PR remains reviewable.

The child issue closes only after its PR has merged into the integration
branch and acceptance has been verified. Its tracker row is then ticked, with
the lane PR and a one-line checkpoint. An abandoned lane records why its PR
closed and which issue now owns unfinished work; no lane is silently replaced.

## Integration And Closeout

The final integration PR references the tracker with `Refs` so provider
asynchronous auto-close cannot close it early. Verify every child is closed
or explicitly transferred, the integration PR merged at the expected head,
checks and review are complete, and durable decisions are canonised. Post one
final checkpoint, then call `forge-cli issue close` and read back the closed
provider record. Retain unsafe local checkout state with its exact reason.
