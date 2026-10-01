# Review convergence

Read this before or while you disposition review findings and provider review
threads: during a pre-merge review, a review-repair round, or a cleanup sweep
over threads on already-merged pull requests. Asynchronous reviewers review
every fix you push, including fixes made to clear earlier threads, so a
mechanical "fix every new thread" loop may never converge. These rules decide
what to fix and when the work is done.

Admitted current-head findings, native change requests, unresolved
non-outdated threads, and unchecked delivery tasks are merge blockers.

## Discovery and closure generations

Each discovery generation has at most one broad review. A delivery attempt
starts one generation; an ordinary repair commit or changed head stays in it.
After that pass, review is a closed-set closure review: re-check the admitted
findings, the repair hunks, and their direct regression surface without
restarting full-diff discovery or adding unrelated lenses.

A new concern may join the closure set only when concrete evidence shows that
the repair introduced a material correctness, security, data, migration, or
public-contract regression in a reachable supported scenario. Pre-existing
defects, hypothetical hardening, architecture or style preferences, optional
cleanup, and unrelated test gaps do not extend the current repair loop. Report
a critical pre-existing risk when necessary, but do not absorb it into the
current delivery without authority.

A user-requested fresh review, or a repair that materially changes the
accepted design, public contract, trust boundary, or migration strategy, starts
a new discovery generation. Otherwise a changed provider head is closure
activity.

## Per-finding triage

Classify each finding by correctness (a real defect, or a remark on correct
code) and relevance (observable behavior, or internal mechanics), then route
it:

| Classification | Disposition |
| --- | --- |
| Admitted real defect | Fix it on the same delivery branch, rerun focused validation and the affected review lens, reply with evidence, then resolve the thread. Stop and ask the user first for a security, data-loss, contract, destructive-migration, or cross-repository architecture change. |
| Real concern not admitted to closure | Open or link a follow-up issue, or stop for an explicit critical-risk handoff. Do not extend the current repair loop. |
| No longer applies to the current code | Resolve as stale. `forge-cli pr merge` records outdated unresolved threads as stale on its own. |
| Real but out of scope for this pass | Follow-up: create the durable record first and link it in the disposition. |
| Preference or style on correct code | Accept with recorded rationale. Do not open a fix. |
| Inherently ambiguous edge case | Pick the conservative branch once, uniformly, and document the tradeoff. |
| Several findings on one mechanism | Replace per-case special-casing with one uniform rule. |

Low and informational observations never block delivery. Evidence alone does
not make a concern blocking; severity and admission do.

## Stopping rule

1. Fix admitted defects, escalating high-risk ones to the user.
2. When findings cluster on one mechanism, converge the design instead of
   patching each edge.
3. When only preference or inherently ambiguous findings on principled code
   remain, accept them with rationale and stop. Do not push another fix that
   would only draw another review.

Stop when the finite set of admitted findings is resolved or explicitly
accepted. Expect each fix to draw a fresh review; that is normal and is not a
reason to keep fixing.

## Thread hygiene

- Never resolve a thread merely to clear a gate.
- Disposition a rejected finding with its evidence before resolving it.
- A gate bypass needs explicit user authority, a recorded reason, and support
  from the active delivery workflow.
- Any head change invalidates head-bound validation and review evidence until
  it is rerun or explicitly re-established.
- When one pull request's findings accumulate until it is reviewed forever and
  never merged, split it into independently reviewable units instead.
