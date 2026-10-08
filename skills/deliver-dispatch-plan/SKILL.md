---
name: deliver-dispatch-plan
description: >
  Coordinate a program whose lane PRs must integrate on a shared branch before
  the integration PR can land on main.
---

# Deliver Dispatch Plan

## Contract

Prerequisites:

- Select `program/dispatch` under the work-modes policy (`runtime_context`
  intent `project-dev`, phase `delivery`) only when intermediate lane states
  cannot land on main one by one.
- Use a program tracker issue and one child issue per independently reviewable
  lane. The tracker body carries the program key, decisions, dependency graph,
  phase checkboxes, and checkpoint log. Each child carries its lane scope and
  acceptance. `references/DISPATCH_ISSUE_RECORD_CONTRACT.md` owns the record
  shape; `references/outcome-routing.md` owns writer boundaries.
- `forge-cli >=1.27.27`, `git-cli >=1.25.13`, and
  `review-specialists >=1.27.29` are available. The forge floor supplies
  review-loop compare-and-swap, pending-review recovery, and guarded merge.
  Tracker lint, tick, graph, and their manual fallback follow
  `issue-follow-up`'s `references/program-mode.md` (Tracker Commands).
- The user has authorized provider artifacts and delivery. Release, deploy,
  activation, and other phase gates keep their own authority.

Inputs:

- `OWNER_REPO`, provider, tracker issue, child issues, integration branch and
  target base, assigned lane scopes, branch/worktree ownership, and acceptance.
- For each lane: child issue, task packet, PR number, expected provider head,
  validation, checks, independent review decision, review evidence, and
  disposition of findings.
- For the final integration PR: settled lane heads, conflict resolution,
  validation, review, checks, and provider merge evidence.

Outputs:

- One current tracker and child issue timeline, updated through `forge-cli
  issue`. The tracker remains the authoritative plan; comments record
  checkpoints and the body checkbox table reflects verified child state.
- Lane PRs targeting the integration branch, each independently reviewed and
  merged by the orchestrator only after approval and provider gates.
- One reviewed integration PR targeting the default branch, then provider
  read-back, issue closeout, and safe managed-worktree cleanup.

Stop when issue or PR state is stale, a lane lacks validation or independent
review, the reviewed head changed, the review-loop has open findings, provider
checks fail, a merge gate rejects, or a child remains open. Read current
provider state and repair the owning lane or record before retrying. Never
infer closeout from prose alone.

## Outcome Routing

A plain `program` delivers child PRs independently. This specialization adds
an integration branch because lane PRs cannot safely land on main separately.
Delegation changes execution ownership; tracker and provider authority remain
with their assigned owners.

- A lane executor owns implementation, local validation, its managed worktree,
  and creation or update of its PR against the integration branch. It posts a
  factual checkpoint on its child issue and stops before review or merge.
- An independent reviewer owns lane review evidence and provider review
  activity. Return fixable findings to the same lane executor.
- The orchestrator owns lane acceptance, guarded non-default-base merges,
  integration validation and PR, tracker checkpoints, and closeout. It does not
  fabricate a lane's implementation or validation evidence.
- `deliver-pr` owns the final integration PR's ordinary review and merge gates.
  The dispatch owner retains downstream issue and checkout closeout duties.

## Entrypoint

1. Read the current tracker and every child with `forge-cli issue view
   --with-comments`. Verify the program key, dependency graph, settled
   decisions, and which child work is still open. Deduplicate before creating
   a missing issue; create or edit through `forge-cli issue` with a Markdown
   body file. Use `workflow::tracking` on the tracker and
   `workflow::follow-up` on children. See the work-modes policy
   (`runtime_context` intent `project-dev`, phase `delivery`).
2. Read the integration branch and each lane PR through `forge-cli pr view`.
   Compare their provider heads with the last checkpoint. If a resumed run
   disagrees with the provider, update the tracker from verified state before
   assigning or merging more work.
3. Assign a lane only when its dependencies are satisfied. The packet names
   the child issue, exact task scope, acceptance, integration branch, worktree,
   validation, and stop condition. Record owner, branch, PR, and state in the
   child issue. Keep the same lane for CI repair and review follow-up unless
   the orchestrator records an explicit reassignment.
4. Require test-first evidence for feature or bug lanes when project policy
   enables it. Thread `--test-first-evidence` into the lane PR create/deliver
   call when required. Use the session `artifact_*` tools for local evidence and `git-cli` and
   `semantic-commit` for governed worktree and commit operations. Lane PR
   creation uses `forge-cli`; its base must be the integration branch.
5. Use `deliver-pr` through its reviewed readiness stop (`--no-merge`) for
   each lane PR, then read checks and the exact PR head. Select the risk-based
   `code-review-specialists` profile. On GitHub, publish the canonical
   `--profile provider-review` bundle with `--mode delivery`, `--reviewable`,
   `--lens-verdict`, `--scope`, and a portable `--evidence-reviewed` value.
   In governed mode, publish through the App and keep the personal identity
   `--metadata-only` without `--comment-file`. Observe the review-loop ledger
   at that head;
   repair or disposition all findings before approval. The ledger bundle holds
   admitted blocking findings only; keep raw reviewer JSONL separate, and never
   let rejected or low/info rows become open entries. Use `forge-cli pr
   reviews` for current-head native feedback and disposition it under the
   closed-set admission rule of the
   [review thread convergence policy](../../docs/policies/review-thread-convergence.md):
   a non-admitted new concern becomes follow-up or an explicit critical-risk
   handoff. On GitLab, use the supported outcome-note route and pass
   `--review-convergence=false` at merge.
6. A reviewer posts its decision through `forge-cli pr review`, bound to the
   inspected head. The orchestrator merges a lane only after independent
   approval, green required checks, zero open blocking findings, and complete
   thread/task gates:

   ```bash
   forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" pr merge \
     "$LANE_PR_NUMBER" --allow-non-default-base \
     --expected-head "$REVIEWED_HEAD" --expected-base "$INTEGRATION_BRANCH"
   ```

   The CLI owns observed review convergence and provider-head binding. A
   typed failure routes to the matching read/disposition path; it is never
   bypassed by a hand-written timing loop.
   On `review_convergence_activity_changed`, re-read the summaries,
   disposition them under the closed-set admission rule, and refresh lane
   approval before retrying without extending the repair loop for a
   non-admitted concern. An ordinary lane head change reruns validation and
   the affected closure lenses; a head that materially
   changes the accepted design, public contract, trust boundary, or
   migration strategy reruns initial scope selection as a new generation.
7. After each lane merge, verify the provider merge commit and integration
   branch head. Post a child checkpoint with the PR, checks, review, and
   merged head; close the child with `forge-cli issue close` only after its
   acceptance holds. Then tick its tracker row with
   `forge-cli issue tracker tick`, recording the lane PR and a one-line
   checkpoint, as Tracker Commands says.
8. After all lanes merge, resolve integration conflicts in a managed worktree,
   run the integration validation, and deliver the integration PR through
   `deliver-pr`. The integration PR references the tracker without an
   auto-close keyword. A new integration head requires validation and review
   rebinding.
9. Read back the integration PR merge and all children. Canonise durable
   decisions in repository docs or the devlog, post the final tracker
   checkpoint, and close the tracker through `forge-cli issue close` only when
   every child is closed or explicitly transferred and the Tracker Commands
   closeout state check reports no finding. Then perform requested
   post-merge duties and the
   [git delivery policy](../../docs/policies/git-delivery.md) terminal cleanup.
   Verify each provider-confirmed delivered head before removing a checkout.
   Use `git-cli worktree remove <path-or-slug> --format json` only for a clean,
   unowned managed worktree. Retain dirty, locked, or unverifiable worktrees
   and report the exact reason.

## Boundary

Use `references/LOCAL_REHEARSAL.md` for provider dry runs,
`references/TASK_LANE_CONTINUITY.md` for follow-up and reassignment, and
`references/POST_REVIEW_OUTCOMES.md` for the reviewer-to-issue checkpoint.
The tracker and child issues replace repository plan bundles and local plan
ledgers. Historical archived plans remain read-only evidence; new dispatch
work does not create `docs/plans` bundles or require plan-specific CLIs.
