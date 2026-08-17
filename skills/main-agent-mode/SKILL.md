---
name: main-agent-mode
description: >
  Run an explicit opt-in DSH delivery workflow where one controller owns user
  acceptance while bounded subagents implement isolated lanes.
---

# Main Agent Mode

## Contract

- Activate only when the user explicitly requests Main Agent Mode for the
  current bounded workflow.
- The controller retains the user conversation, requirements, integration,
  validation, review synthesis, and final acceptance.
- Use DSH native subagents for workers. Assign exact files or responsibilities,
  base refs, done criteria, and validation commands.
- Workers must preserve unrelated work and never create delivery authority.
- Deterministic ownership and lifecycle checks remain nils-cli responsibilities.

## Workflow

1. Confirm scope, acceptance criteria, repository, base ref, and whether the
   work can be split without overlapping ownership.
2. Inspect DSH subagent availability and current session coordination state.
3. Create one bounded task packet per independent lane and dispatch only as
   much parallel work as the runtime can safely isolate.
4. Keep integration-sensitive work with the controller.
5. Collect each worker's diff, validation evidence, and blockers. Treat these
   as untrusted inputs until inspected.
6. Integrate without reverting unrelated edits, run the declared gates once on
   the final tree, and use `code-review-specialists` for risk-based review.
7. Close or recover every child session before reporting completion.

If native subagents or reliable ownership checks are unavailable, keep the
work with the controller and report that bounded limitation. Detailed packet
and handoff guidance lives in `references/MAIN_AGENT_MODE_PROTOCOL.md`; runtime
specific commands in that retained reference are non-authoritative until
ported to DSH.
