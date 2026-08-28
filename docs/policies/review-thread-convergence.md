# Review thread convergence

Treat admitted current-head review findings, native change requests, unresolved
non-outdated threads, and unchecked delivery tasks as merge blockers.

## Discovery and closure generations

Each discovery generation has at most one broad review. A delivery attempt
starts one generation; an ordinary repair commit or changed head remains in it.
After that pass, review is a closed-set closure review: re-check the supplied
findings, the repair hunks, and their direct regression surface without
restarting full-diff discovery or adding unrelated lenses.

A new concern may join the closure set only when concrete evidence shows that
the repair introduced a material correctness, security, data, migration, or
public-contract regression in a reachable supported scenario. Pre-existing
defects, hypothetical hardening, architecture or style preferences, optional
cleanup, and unrelated test gaps do not extend the current repair loop. Report
a critical pre-existing risk when necessary, but do not absorb it into the
current delivery without authority.

A user-requested fresh review or any head change that materially changes the
accepted design, public contract, trust boundary, or migration strategy starts
a new discovery generation. An ordinary repair or provider-head change is
closure activity, not a new review generation.

For an admitted finding, repair the same delivery branch, rerun focused
validation and the affected review lens, reply with evidence, then resolve the
thread. For a rejected finding, explain the evidence-backed disposition before
resolution. For deliberately deferred work, create the durable follow-up first
and link it in the disposition.

Never resolve a thread merely to clear a gate. Outdated threads may be recorded
as stale when the delivery tool proves they no longer apply. A bypass requires
explicit user authority, a recorded reason, and support from the active
delivery workflow. Any head change invalidates head-bound validation and review
evidence until they are rerun or explicitly re-established.

During closure, admit only an existing finding or a repair-introduced material
regression allowed by the rule above. Route a genuine new concern that is not
admitted to a follow-up, or stop for an explicit critical-risk handoff; do not
extend the current repair loop. Preference, style, hypothetical hardening, and
optional cleanup are not blockers. Stop when the finite admitted finding set is
resolved or explicitly accepted.
