# Work modes

This delivery-phase policy decides how much durable tracking a piece of work
needs. It does not limit how you plan. Pick the lightest mode that holds the
state the work actually needs. Keep routine `direct` classification to
yourself; surface a mode only when a provider record, delivery, or an ambiguous
escalation is actually involved.

## Three independent axes

| Axis | Question | Values |
| --- | --- | --- |
| Tracking mode | Which durable record does the work need? | `direct` / `issue` / `program` |
| Execution | Who does the work? | inline / native subagents |
| Review depth | How risky is the diff? | Risk-selected quick or full review |

Choose each axis separately. A `program` can run inline. A `direct` change can
still require a full specialist review.

## Tracking modes

| Mode | Tracking record | Choose when |
| --- | --- | --- |
| `direct` | None; the pull request or answer is the record | It finishes now and needs no record beyond this session |
| `issue` | One provider issue with a comment timeline | Any of: deliberately deferred; needs investigation before the fix is known; a blocker to record while routing around it; a handoff; cross-session continuity or visibility to others; a recurring loop that needs a timeline |
| `program` | One tracker issue plus two or more child issues, each in `issue` mode | Two or more independently deliverable and reviewable units, **and** at least one of: ordering dependencies; spans repositories; authorization gates between phases (release, deploy, decision); expected to outlive one session's context |

- Start at `direct`. Move up only when a trigger in the table fires.
- Size alone never moves work up. When a pull request is too large for review
  to converge, split it into several reviewable pull requests within the same
  mode.
- When torn between `issue` and `program`, choose `issue`. An issue can later
  become a program child when a second unit appears.
- Downgrade when the need shrinks. A program left with one open child closes
  its tracker and continues that child in `issue` mode.

### Program specializations

| Specialization | Required when | Outcome skill |
| --- | --- | --- |
| `program/dispatch` | Lanes must integrate on a shared branch before landing on the default branch, because intermediate lane states cannot land one by one | `deliver-dispatch-plan` |

A plain `program` covers the rest: its children merge independently, and its
tracker is the plan.

## Authority

- Choosing a mode is autonomous. Classify ordinary work as `direct` and proceed
  without announcing a mode, proposing a tracker, or pausing.
- Creating any provider record (an issue, a tracker, or a child issue) needs
  the user's decision first, unless the current request already authorizes it.
  When a trigger fires, name the durable state the work needs and the lightest
  matching mode, then ask with `ask_user_question`.
- If the choice is materially ambiguous, recommend the cheaper safe option and
  ask only the question that changes the record or the authority.
- Re-triage when evidence changes. Escalating keeps the work already done and
  its review depth; it does not add ceremony retroactively.

## Execution mapping

Tracking and execution remain separate. Direct work normally runs inline;
issue work can use an ordinary delegated subagent. Program children may run in
parallel when authorized, with gates between dependent phases. Each child owns
its isolated implementation and reports validation to the parent. The tracker
remains the authoritative dependency graph and acceptance record.

For `program/dispatch`, follow `deliver-dispatch-plan`: lane PRs target the
integration branch and the orchestrator owns the shared integration result.
Delegation does not transfer provider record, review, release or deployment
authority.

## Program records

The tracker issue contains: purpose and a program key; how to resume; settled
decisions with dates; a phase table with one checkbox row per child issue or
gate (release, deploy, decision), carrying its item id, issue link, and the ids
it depends on; the dependency graph derived from those rows; open decisions;
and a checkpoint log.

Each child issue contains: a program line (key, item id, and the tracker link
where allowed); the goal; verified current facts with file references; a scope
checklist; out of scope; acceptance; and what it depends on and unblocks.

- Open the tracker first as a placeholder labeled `workflow::tracking`, open
  the children labeled `workflow::follow-up` and linking to it, then fill the
  tracker with the real child numbers.
- The phase row is the authoritative declaration of a dependency; a child's
  depends-on line repeats it. Derive the graph from the rows with
  `forge-cli issue tracker graph`, check the body with
  `forge-cli issue tracker lint`, and never edit the graph independently of the
  rows. The `issue-follow-up` skill owns the row grammar and a manual fallback.
- A child issue must be enough on its own to resume work after compaction or a
  handoff.
- Children in public repositories carry no hostnames, personal names, or
  private links; reference the program key instead.
- Deduplicate against open issues first, and link an existing related issue
  rather than duplicating it.
- Each child's delivery follows `issue` mode. When a child closes, tick it with
  `forge-cli issue tracker tick` and post a one-line checkpoint with its pull
  request.

## Program closeout

1. Every child is closed, or explicitly moved to another record that the
   tracker names.
2. Key decisions are recorded in repository docs or the development log.
   Provider records alone are destructible.
3. Post a final tracker checkpoint, then close the tracker.

## Cross-cutting rules

- **A pull request is the default provider path, not default authority.** Once
  provider delivery is explicitly requested or owned by an approved workflow, a
  pull request squash-merged into the default branch is the default. Never
  infer direct-to-default-branch authority from change size, urgency, or words
  such as "small" or "hotfix"; that route needs exact current-task authority
  and uses `forge-cli repo push-default` from a managed worktree. Pull request
  bodies stay grounded in the diff with at least `## Summary` and
  `## Test plan`.
- **A default-branch commit is local completion, not delivery.** One local-only
  commit on the primary default checkout needs the maintainer's explicit
  request, opens no issue or pull request, and performs no provider mutation.
- **Split what review cannot converge.** When findings or threads accumulate
  until a pull request is reviewed forever and never merged, split it into
  independently reviewable units. That is a delivery decision; it does not
  change the mode.
- **Review profile is not a mode.** `deliver-pr` selects the smallest safe
  profile from scope, validation, existing review state, and reviewer
  confidence. Eligible `direct` or `issue` diffs, including program children,
  may use a quick review whose clean pass is terminal for the reviewed head.
  `program/dispatch` pull requests and any risk-triggering diff keep the full
  specialist gate. Escalating review depth never changes the mode.
- **An implementation-readiness document is an optional spec, not a mode.** A
  `discussion-to-implementation-doc` capture records converged intent. Its
  default home is `docs/discussions/<YYYY-MM-DD>-<slug>.md`; it can attach to
  any mode, and the mode is chosen when the work is picked up.

## Capture lifecycle

`docs/discussions/` is staging, not storage. Every capture leaves by one exit,
recorded in its `Exit:` header and executed by the pull request that ships the
work:

| `Exit:` | Action | When |
| --- | --- | --- |
| `open-issue` | Open a record for the outstanding work, then `git rm` the capture | The work is real but not finished now; an ordinary issue is enough |
| `canonise` | `git mv` into the owning domain document | The content is durable canon |
| `retire` | `git rm` | Shipped or abandoned (the default) |

- There is no "keep" state; a capture worth keeping is worth `canonise`.
- No file outside `docs/discussions/` may link to a capture inside it; quote
  the conclusion instead. The directory's own `README.md` is exempt.
- Before `retire`, the reasoning must already exist in the repository's
  development log or promoted canon, never only in a provider record.

## Examples

| Situation | Mode |
| --- | --- |
| A typo, a clear bug, or a flag, finished in one pass | `direct` |
| A security-sensitive change finished in one pass | `direct`, with a full specialist review |
| A bug found while other work comes first, or its root cause unknown | `issue` |
| A capability split into a spec, CLI, service, and rollout across repositories, with phase gates | `program` |
| Several existing issues run with subagents, with no shared tracker needed | Keep their modes |
| A migration whose lanes must integrate before the default branch | `program/dispatch` |
