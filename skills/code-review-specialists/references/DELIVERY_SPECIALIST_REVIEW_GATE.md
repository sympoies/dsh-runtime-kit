# Delivery Specialist Review Gate

Use this shared gate from end-to-end delivery workflows before final PR or MR
merge. The gate gives provider delivery skills one consistent review contract
without making low-level close skills mandatory review orchestrators.

## Ownership

- `deliver-pr` owns this mandatory gate for end-to-end delivery.
- `deliver-pr` also owns explicit provider close or merge requests when the
  selected lifecycle path requires them.
- `deliver-plan-tracking-issue` relies on this delivery gate for each PR, then adds
  issue-visible evidence, runtime-finding disposition, lifecycle completion, and
  closeout requirements.
- `deliver-dispatch-plan` uses `code-review-specialists` in pre-merge context
  with the full specialist profile before the parent decision for dispatch PRs.
- `code-review-specialists` remains read-only. It supplies scope detection,
  specialist findings, and reports; it does not fix code, post PR or MR
  comments, mark draft reviewables ready, merge, close issues, or clean
  branches.

## Mandatory Gate

Every end-to-end delivery PR or MR receives a pre-merge review. Pre-merge is the
delivery context; quick or full is the review profile inside that context.

1. Resolve reviewable metadata and diff base:
   - GitHub PR: use `forge-cli --provider github pr view <pr>` or the
     equivalent `gh pr view` JSON fields to resolve the PR number, URL, base
     branch, head branch, draft state, check state, and closing issue links.
   - GitLab MR: use `forge-cli --provider gitlab pr view <mr>` or the
     equivalent `glab mr view` output to resolve the MR number, URL, target
     branch, source branch, draft state, and pipeline state.
   - Use the PR base branch or MR target branch as the `code-review-specialists`
     diff base.
2. Run `review-specialists scope --base "$BASE_REF" --format json` without
   forced lenses first. Select quick only when every eligibility condition below
   holds; otherwise select full. A user preference for quick is not a bypass.
3. Bind the selected review to the current provider head. Findings block merge,
   provider-native review state remains authoritative, and the owning delivery
   workflow retains the convergence, thread, task, and head-drift gates.

## Quick Pre-Merge Profile

Quick review is eligible only when all of these are true:

- The outer work is L0 or L1, not L2 or L3 plan/dispatch delivery.
- The diff is bounded and ordinary, required validation and provider checks
  pass, and there is no unresolved current-head finding, change request, or
  review thread.
- Scope detection neither suggests nor forces security, API-contract,
  data-migration, performance, red-team, or another risk-specialist lens.
  Treat either `suggested_specialists` or `forced_specialists` as a quick-review
  disqualifier when it contains one of those lenses.
- The quick reviewer can inspect the complete diff, affected call sites, changed
  tests, and supplied validation evidence with sufficient confidence.

Dispatch `reviewer-quick` when the runtime exposes its managed reviewer profile;
otherwise use the declared inline fallback. Its verdict controls the route:

- `pass`: a clean result plus residual risks is terminal review evidence for the
  current head. The delivery owner posts one final outcome with `--lens quick`
  and may proceed to the unchanged merge gates.
- `findings`: post concrete actionable findings before repair, block merge,
  rerun affected validation, and use quick follow-up only while scope remains
  bounded. A clean follow-up can then become the final outcome.
- `escalate`: select the full pre-merge profile and its required lenses without
  changing the work tier or requesting another user decision.

A clean quick pass does not need a separate `comments-only` lens post before the
final outcome. Quick findings do: use `--decision comments-only --lens quick`
and `--thread-file` on GitHub when the finding is actionable, preserving the
posting order in `REVIEW_OUTCOME_POSTING_CONTRACT.md`.

## Full Pre-Merge Profile

Use the full profile for every L2/L3 PR and whenever quick eligibility fails.

1. Run deterministic scope detection with forced minimum lenses:

   ```bash
   review-specialists scope --base "$BASE_REF" --testing --maintainability --format json
   ```

2. Run the selected specialist lenses. The forced minimum means a small diff is
   still reviewed; do not skip only because `diff_lines < 50`.
3. Add risk lenses when the scope warrants them:
   - `--security` for auth, permission, credential-handling, dependency,
     supply-chain, or backend changes over 100 diff lines.
   - `--api-contract` for route, controller, API schema, OpenAPI, GraphQL,
     event, protocol, CLI, or other external contract changes.
   - `--data-migration` for schema, migration, data transform, fixture
     migration, or persistence changes.
   - `--performance` for runtime hot paths, build/runtime loops, query behavior,
     concurrency, rendering, or deployment-time execution.
   - `--red-team` when `diff_lines > 200`, a previous specialist pass found a
     critical issue, or the reviewable changes safety/security-sensitive
     behavior.
4. For doc-only, generated-only, formatting-only, or mechanical metadata
   reviewables that are ineligible for quick only because of their outer
   lifecycle, the full review may be a short testing/maintainability pass that
   records "no concrete findings" plus why broader lenses were not selected.
5. The owning parent posts a compact specialist review comment through
   `forge-cli pr review` after each selected lens returns — on GitHub a native
   `COMMENT` review event via `--submit-review`, plus `--thread-file` when the
   lens surfaces actionable findings that require owner changes. Use
   `--decision comments-only`, the same semantic `--lens`, and the
   provider-guarded command from `REVIEW_OUTCOME_POSTING_CONTRACT.md`. The
   reviewer subagent remains read-only and does not post directly. Specialist
   comments report findings only; the parent records final dispositions later.

## CLI Command-Block Contract Check

When a diff touches `skills/deliver-*/SKILL.md` and changes a command block
containing a `forge-cli`, `gh`, or `glab` invocation:

1. Force the `api-contract` lens even when the reviewable is otherwise small or
   documentation-only.
2. Resolve the supported nils-cli floor from this package's compatibility
   documentation and record the exact installed version. Validate against that
   floor; an ahead-of-floor host is not substitute compatibility evidence.
3. Check every invocation in the edited command block, not only the changed
   line:
   - For `forge-cli`, repeat the exact invocation with
     `--dry-run --format json`, require `ok=true`, and inspect every
     plan-bearing field in the command envelope for the intended subcommand,
     flags, and provider argv. This includes `data.plan`,
     `data.plan_steps[].plan`, and applicable auxiliary fields such as
     `guard_plan`, `issue_plan`, `thread_plan`, `submit_plan`, or `target_plan`.
     For the review-loop convergence fields, also inspect
     `data.threads_skipped_idempotent` (on `pr review`) and
     `data.stale_thread_dispositions` / `data.unresolved_threads_override_reason`
     (on `pr merge`).
   - Raw `gh` / `glab` read commands may run only against a safe target; verify
     their exact flags and output shape. Never execute raw provider mutations
     for review evidence. Prefer the matching `forge-cli` dry-run, or a
     provider-native documented dry-run when no forge surface exists.
4. Compare the backend plan or read output with the downstream JSON fields,
   `jq` expressions, and consumer assumptions in the skill body. For example, a
   comments consumer requires a comments-aware fetch such as
   `forge-cli issue view --with-comments`; a plain issue view must not be
   treated as comments evidence.
5. Capture the pinned version, exact commands, `ok` result, backend plans or
   read-output shape, and downstream field comparison in the `api-contract`
   specialist report or provider review comment. Missing command-contract
   evidence blocks a passing review outcome.

## Findings And Repair Loop

- Treat evidence-backed quick or specialist findings as blocking before merge.
- Repair concrete findings on the same delivery branch when they are inside the
  accepted delivery scope.
- After repairs, rerun focused validation, provider checks or pipelines, and the
  affected quick or specialist review. Post the focused follow-up review comment
  with the same semantic lens before continuing to the next gate step.
  Resolve the original GitHub review threads after the fix is verified; follow-up
  pass comments normally omit `--thread-file`.
- At the merge gate, `forge-cli pr merge` counts only unresolved threads that are
  also not outdated: outdated unresolved threads are auto-dispositioned `stale`
  (recorded in `data.stale_thread_dispositions`) and no longer block. Disposition
  the remaining non-outdated threads per
  `core/policies/review-thread-convergence.md`; bypass the block only with
  `--allow-unresolved-threads`, which now requires a paired
  `--allow-unresolved-threads-reason` (recorded as
  `data.unresolved_threads_override_reason`). Re-posting the same follow-up
  threads on an unchanged head is idempotent (`data.threads_skipped_idempotent`)
  and never sweeps prior reviews.
- Repeat review and repair until no concrete unresolved findings remain, or
  stop with an exact blocker and unblock action.
- Do not treat user-authorized review fixes as a successful stopping point; they
  are part of the delivery repair loop.
- Weakly evidenced concerns, accepted tradeoffs, cleanup notes, and residual
  risks must be reported by the owning delivery workflow. Issue-backed delivery
  must also record their issue-visible disposition before closeout.
- The owning delivery workflow must post the final or blocked outcome through
  `forge-cli pr review`, following
  `references/DELIVERY_REVIEW_OUTCOME_COMMENT.md`, before final merge/close.
