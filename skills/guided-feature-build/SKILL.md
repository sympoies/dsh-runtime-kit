---
name: guided-feature-build
description: >
  Run a guided, in-session feature build on an existing codebase — explore,
  design, implement, review — without opening issue-backed plan tracking.
---

# Guided Feature Build

## Contract

Prereqs:

- User explicitly invokes `guided-feature-build`, asks for a guided feature
  build, or asks to be walked through building a feature before any code is
  written.
- The delegated role prompts exist at `references/prompts/explorer.md` and
  `references/prompts/architect.md`.
- The internal execution strategy is available at
  `references/DELEGATION_PROTOCOL.md`.
- Active project preflight and validation rules are followed before any
  repository edits.

Inputs:

- Feature request, the problem it solves, constraints, target area, done
  criteria, and any preferred approach when available.
- Whether subagent delegation is available and allowed by active runtime
  instructions before any subagents are spawned.
- Any explicit delegation preference or constraint already stated by the user.

Outputs:

- A `TodoWrite` plan covering the seven phases.
- A codebase-exploration summary with the key files that were read.
- A clarifying-question list answered by the user before design.
- Two or three compared architecture approaches with one recommendation and the
  user's chosen approach.
- An implementation that follows the chosen approach and codebase conventions,
  validated per project rules.
- A quality-review pass (delegated to the existing code-review skills) and a
  closing summary of what was built, decisions, files changed, and next steps.

Exit codes:

- N/A (conversation workflow; no repo scripts)

Failure modes:

- A delegated role prompt is missing or empty.
- The request is a trivial change, a hotfix, or already fully specified — use
  direct implementation instead of this conductor.
- The work needs durable issue tracking, multiple delivery lanes, or PR
  grouping — hand off to the plan-tracking or dispatch workflow instead.
- Active project rules conflict with the requested implementation path.

## Outcome Routing

Advice and explanation stay normal conversation behavior: ask only material
clarifying questions, state assumptions, compare meaningful options, and give
one recommendation without asking the user to select a prompt-style skill.

For an implementation outcome, this workflow selects inline, orchestrated, or
parallel execution internally using `references/DELEGATION_PROTOCOL.md`.
Delegation is an implementation detail, not a separate user outcome. The
workflow escalates to plan tracking or dispatch only when durable coordination
state is actually required.

## Workflow

This skill conducts the build through fixed phases with explicit user gates. It
delegates exploration and architecture to subagents when delegation is
available, and degrades to inline sequential passes when it is not. It does not
re-implement review: phase 6 calls the existing code-review skills.

### Phase 1 — Discovery

1. Restate the feature request and create a `TodoWrite` list with all seven
   phases.
2. If the request is unclear, ask what problem it solves, what the feature
   should do, and any constraints. Confirm the understanding before proceeding.

### Phase 2 — Codebase Exploration

1. If subagent delegation is available, dispatch 2–3 subagents using
   `references/prompts/explorer.md`, each targeting a different aspect (similar
   features, architecture/abstractions, the current implementation of a related
   area). If delegation is unavailable, run the same role prompt inline as
   sequential read passes.
2. Each pass returns entry points with `file:line` references and a curated list
   of 5–10 key files to read.
3. Read every file the passes flag before continuing, then present a concise
   summary of the patterns and constraints discovered.

### Phase 3 — Clarifying Questions

Do not skip this gate.

1. From the exploration findings and the original request, list every
   underspecified aspect: edge cases, error handling, integration points, scope
   boundaries, backward compatibility, and performance needs.
2. Present the questions as one organized list and **wait for answers** before
   designing. If the user defers ("whatever you think is best"), state your
   recommended answers and get explicit confirmation.

### Phase 4 — Architecture Design

1. If delegation is available, dispatch 2–3 subagents using
   `references/prompts/architect.md` with distinct focuses — minimal change,
   clean architecture, and pragmatic balance. Degrade to inline sequential
   passes when delegation is unavailable.
2. Compare the approaches, form one recommendation with reasoning, and present
   the trade-offs.
3. **Ask the user which approach to use** and wait for the choice.

### Phase 5 — Implementation

Do not start without explicit user approval.

1. Wait for approval of the chosen approach.
2. Select the execution strategy through
   `references/DELEGATION_PROTOCOL.md`. Honor an explicit user preference when
   safe, but keep scope, write isolation, integration, and validation under the
   parent workflow.
3. For a testable production behavior change, follow the policy-owned
   durable test-first lifecycle: contract delta, affected-test scan, meaningful
   red or complete waiver before production edits, scoped validation, suite
   convergence, and explicit residual gaps. Record v2 evidence through the
   `test-first-evidence` CLI; it is required when the repo or user opts into the
   `forge-cli` `[test_first].require` gate.
4. Read the relevant files again, implement the chosen approach, follow codebase
   conventions strictly, and keep `TodoWrite` current.
5. Run the project's required preflight and validation as edits land.

### Phase 6 — Quality Review

1. Route the diff to the generic `code-review-specialists` outcome. It selects
   ad-hoc, follow-up, or pre-merge context and chooses quick, focused, or
   specialist depth from the request and risk. Do not define a separate review
   rubric here.
2. Present the consolidated findings and ask the user how to proceed — fix now,
   fix later, or proceed as-is — then act on the decision. When this build is
   being delivered through a PR/MR, surface the findings on it before fixing,
   never after, per the posting-order invariant in
   [the review outcome posting contract](../code-review-specialists/references/REVIEW_OUTCOME_POSTING_CONTRACT.md).

### Phase 7 — Summary

1. Mark the todos complete.
2. Summarize what was built, the key decisions, the files changed, and suggested
   next steps.
3. If the work now needs durable tracking, multiple lanes, or PR grouping, it
   has outgrown this conductor — stop here and let the user choose the tracking
   workflow rather than continuing.

## Boundary

- This is an in-session conductor. It creates no provider issues, plans, or
  tracking artifacts; on escalation it stops and hands the work to the user's
  chosen tracking workflow (Phase 7).
- It ships as a cross-product skill only. It defines no `agents/<n>.md` and no
  `commands/<n>.md`; the explorer and architect roles live as delegated role
  prompts under `references/prompts/`, fulfilled by each harness's own
  delegation capability.
- It reuses the generic code-review outcome for Phase 6, the internal delegation
  protocol, and the policy-owned durable test-first lifecycle for Phase 5
  instead of exposing those mechanics as user-selected substeps.
