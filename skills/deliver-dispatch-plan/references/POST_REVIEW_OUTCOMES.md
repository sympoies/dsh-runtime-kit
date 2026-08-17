# Post-Review Outcomes

## Core Rule

After every `merge`, `request-followup`, or `close` decision, provider-side
review action and issue runtime state sync are both required. Do not leave the
decision only in a PR comment.

## Request Follow-Up

- Keep the current lane active.
- Mirror the exact PR comment URL into the issue timeline.
- Sync the dispatch state to `in-progress` when the subagent can continue, or
  `blocked` when the lane is waiting on input or external unblock.
- Do not create a replacement branch, worktree, or PR for ordinary follow-up.

## Close PR

- Treat the closed lane as retired.
- Record the closed PR, reason, next action, and replacement status in the
  issue.
- Use `blocked` until a replacement lane is assigned or the task is otherwise
  resolved.
- Never resume a retired lane implicitly.

## Merge

- Keep the merged PR as the canonical dispatch ledger PR reference.
- Let lifecycle audit and closeout gates advance records to `done`; do not
  invent an early done state that conflicts with the active gate.
