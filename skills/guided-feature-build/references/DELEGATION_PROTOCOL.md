# Delegation Protocol

This protocol is the internal execution strategy for a guided feature build.
The user asks for an implementation outcome; the parent workflow selects the
smallest safe execution shape and remains responsible for integration and
validation.

## Selection

- Use inline execution for one tightly coupled change, a sequential dependency,
  or work too small to justify delegation.
- Use orchestrated execution when two or more bounded lanes can be delegated
  while one parent retains scope, integration, validation, and final synthesis.
- Use parallel execution only for genuinely independent read-only passes or
  isolated implementation lanes with non-overlapping ownership.
- Escalate to the formal L3 dispatch outcome when independent lane PRs need a
  shared provider-visible coordination spine. Delegation alone does not make a
  task L3.

An explicit user preference may constrain the selection, but it never weakens
active project rules, write isolation, or lifecycle ownership.

## Parent Ownership

The parent owns the objective, done criteria, lane boundaries, dependency
ordering, dispatch prompts, integration, validation, and final answer. Delegated
workers own only their assigned read or implementation scope and report evidence
back to the parent.

## Write Isolation

- Read-only workers may inspect the shared worktree and must reconcile its status
  before and after their pass.
- Mutating workers use isolated worktrees or return patch artifacts. They never
  write concurrently to the same files in a shared worktree.
- The parent resolves overlaps and applies integration changes. A worker must
  stop when its assignment would cross another lane's ownership.
- Reviewer workers remain read-only and never post provider comments; the
  workflow owner performs any authorized provider write.

## Completion

The parent waits for required lanes, validates each result, reruns integrated
checks, and reports blocked or skipped lanes explicitly. A delegated worker's
successful command is evidence for its lane, not proof that the integrated
outcome is complete.
