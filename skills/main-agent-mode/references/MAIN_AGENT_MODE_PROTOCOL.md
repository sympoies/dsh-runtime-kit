# Main Agent Mode Protocol

This reference defines the DSH-native controller/worker handoff. The selected
skill remains authoritative when it is stricter.

## Controller packet

Each worker receives:

- objective and explicit non-goals;
- repository, base ref, and owned files or responsibility;
- relevant requirements and constraints;
- expected output and validation commands;
- instruction to preserve unrelated changes and integrate with concurrent work;
- prohibition on commits, provider mutations, or delivery unless separately
  authorized.

## Worker completion packet

Return:

- outcome: complete or genuinely blocked;
- changed files and observable behavior;
- validation commands with exit results;
- assumptions, residual risks, and any unverified boundary;
- no claim that integration or user acceptance is complete.

## Controller acceptance

The controller inspects every returned diff, resolves overlap, runs final
validation on the integrated tree, performs risk-based review, and checks that
all child sessions have settled. Only the controller reports user-facing
completion.

## Recovery

If a child disappears or returns ambiguous state, inspect the shared worktree
before reassigning. Never launch a second writer on the same owned files until
the first lane is known quiescent. Recover useful uncommitted work rather than
discarding it.
