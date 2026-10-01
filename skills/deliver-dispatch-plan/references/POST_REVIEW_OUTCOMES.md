# Post-Review Outcomes

## Core Rule

After every `merge`, `request-followup`, or `close` decision, provider-side
review action and child issue checkpoint are both required. Do not leave the
decision only in a PR comment.

## Request Follow-Up

- Keep the current lane active.
- Mirror the exact PR comment URL into the issue timeline.
- Comment on the child issue with `in-progress` when the executor can continue,
  or `blocked` when it waits on input or an external unblock.
- Do not create a replacement branch, worktree, or PR for ordinary follow-up.

## Close PR

- Treat the closed lane as retired.
- Record the closed PR, reason, next action, and replacement status in the
  child issue and tracker.
- Use `blocked` until a replacement lane is assigned or the task is otherwise
  resolved.
- Never resume a retired lane implicitly.

## Merge

- Keep the merged PR as the child issue's canonical delivery reference.
- Verify lane acceptance before closing the child and ticking its tracker row.
