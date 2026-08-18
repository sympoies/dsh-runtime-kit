# Test-first evidence note

The initial retained run was a module-absence setup failure: the package modules
and directories did not yet exist, so the
runner could not execute the intended assertions. This was not a meaningful behavioral red.
It must not be represented as one.

For that baseline, substitute validation is the packed DSH smoke against the
real supported Harness composition plus the final contract suite. The repair
work following provider review has its own behavioral red evidence: loadable
tests reproduced the monotonic policy-gate, bounded-resource, private snapshot,
symlink containment, public resource closure, and compatibility-manifest
failures before the corresponding production changes.

## Task 2.1 lifecycle and transport

The lifecycle implementation began with loadable behavioral regressions, not a
module-absence failure. The focused command was:

```sh
node --test \
  --test-name-pattern='caller abort joins|policy disposal|rc.7 compatibility seam' \
  test/plugin-contract.test.mjs
```

It reported 0 passing and 3 failing tests against the previous production
implementation:

- caller abort returned while its policy child was still active;
- policy disposal did not terminate or await an active child;
- only `tools/pre-execute` and `tools/result` were registered, rather than the
  six required rc.7 lifecycle extension points.

A later review-driven regression independently failed because stale post-tool
identity delegated to the remainder of the waterfall. It was made green by a
public rc.7 `PostToolDecision` block, without treating candidate output as the
authoritative result.

Testing review also found that the subprocess double made direct-child
settlement and process-tree exit the same promise. After strengthening the
assertions but before separating those signals, this affected command reported
0 passing and 3 failing tests because timeout, caller abort, and disposal all
completed before tree exit:

```sh
node --test \
  --test-name-pattern='stalled policy subprocess|caller abort joins|policy disposal stops ingress' \
  test/plugin-contract.test.mjs
```

The corrected double now settles `done` and `waitForExit()` independently. The
real rc.7 composition smoke uses the same two-phase release and proves that
both cancellation and policy-fiber disposal remain pending with one active
policy check after direct-child settlement, then complete only after tree exit.
Review also added durable-history cases for a closed step, closed turn, open
step, and reopened step; only the open positions attach successfully.

The final adversarial review found that rc.7 keeps the execution object mutable
through the pre-execute waterfall: a later listener could replace the
deep-frozen `exec.arguments` object after nils approved the original. The
focused regression reproduced an `allow` for the substituted payload before
the guard bound authorization to the exact evaluated argument reference and
the complete lifecycle correlation. A companion red reproduced the same bypass
with a different attached Agent object sharing the same session and durable
position; authorization now also binds the exact Agent reference. A second
companion red replaced the Session property on the same Agent, so authorization
also binds the exact Session and the compatibility check rederives its live
id/cwd. Focused reds also confirmed mutable parent-token and cancellation-signal
properties required exact reference binding. The packed real-DSH smoke installs
both adversarial listener variants and proves neither substituted context
reaches the tool body.

A further adversarial follow-up replaced `exec.token`. The pre-fix regression
denied the current execution but left one authorization and one correlation
under the original token; a second same-step execution then copied every bound
identity reference and replayed the leaked allow without nils. Exact
execution-object keys plus an independently captured original token now make
cleanup stable under property mutation and make authorization non-transferable.
The real rc.7 smoke also replaces the token and verifies denial, zero tool-body
executions, and zero pending markers/correlations.

Final independent review added loadable reds for six remaining contracts:

- rejected, throwing, and aborted pre-step proposals stayed executable because
  the adapter cached the proposal before the downstream decision;
- cached correlation survived live `step/end` and `turn/end` events;
- HMR attachment replayed all 100,000 old events instead of the recent suffix;
- a distinctive downstream pre-execute exception was rewritten as
  `policy-unavailable`;
- timeout and disposal remained pending forever when provider `done` and
  `waitForExit()` never settled;
- the package admitted future DSH release candidates through peer ranges.

The first focused repair run passed all six behavioral groups. A follow-up red
then showed one unknown-quiescence operation could close new admission while an
already-active sibling still authorized. Degradation now cancels all siblings
monotonically, preserves an earlier caller/timeout/disposal cause, bounds late
provider rejection safely, and never reopens capacity. Real rc.7 composition
also drives reject, throw, abort, and already-closed-step attempts: every final
result fails at the public correlation boundary with zero nils spawns, zero
tool-body executions, and zero pending state.

The last affected-only performance review added 100,000 assistant chunks after
an open step and exercised begin, match, post, and result boundaries. Before the
cursor repair those four checks revisited 400,008 events. The adapter now folds
only events after a retained count/identity anchor; repeated checks revisit at
most the anchor. Separate replacement and truncation reds require a violated
append-only attachment to remain invalid until session reattachment.

The last security review reproduced an allow marker preserved by downstream
`ask`, followed by a different call whose unknown process-tree quiescence
globally degraded transport admission. Before repair, approving the first call
still passed the guard. A monotonic transport admission epoch now invalidates
that waiting marker: approval is denied as `policy-unavailable`, no tool body is
reached, and the marker is consumed.

No hostile `tools/execute` property-mutation defense was added. rc.7 around
wrappers run after the guard and publicly permit only signal replacement; all
in-process wrappers are trusted computing base. The tested substitution
guarantee is deliberately limited to the extensible pre-execute waterfall.

## Task 2.2 selective context

The selective-context implementation was exercised against the real packed
DSH rc.7 composition. It proved that no policy corpus appeared at startup, one
explicit `runtime_context({ intent: "project-dev" })` call returned only the
bounded `edit` documents, and the independent probe tool returned 42 for 41.

A later security review found a confused-deputy path: syntactically valid
model-selected review, delivery, or future intents reached `agent-docs` without
an explicit phase. Before the production repair, the focused context test
reported five passing and one failing test because all three disallowed intents
called the client. A shared exact allowlist now admits only
`project-dev -> edit`; the model-facing schema and subprocess transport both
enforce it, and the negative regression proves zero process creation.

The converged gates are the focused lifecycle/policy suite, the complete Node
test suite, strict JSDoc type checking, package dry-run inspection, and the
packed real-DSH rc.7 smoke. The smoke uses a public scripted LLM adapter and a
real Agent/AgentLoop to prove session, step, tool, result, turn-stop,
cancellation, and plugin-disposal behavior without an API key.
