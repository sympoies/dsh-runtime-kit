# Evidence

Evidence is conditional. It makes a material engineering or workflow claim
durable and machine-verifiable; it does not turn routine work into a recording
exercise. You decide whether a record is warranted, and the typed CLI owns its
schema, storage, and verification.

Create retained evidence when an explicit request, a repository or delivery
gate, a high-risk workflow, an audit, a cross-session handoff, a deferred
defect, or a reusable operational lesson needs it. Do not create evidence just
because a command exists, a skill ran, a session ended, or ordinary `direct`
work finished.

Keep records in the session's `artifact_*` storage unless the active workflow
declares another private artifact root. Never commit raw runtime evidence,
credentials, transcripts, provider payloads, or local receipts.

## Ownership

| Need | Judgment owner | Deterministic owner |
| --- | --- | --- |
| Test-first proof | Implementation owner | `test-first-evidence` |
| Retained review findings | Review owner | `review-specialists` bundle output |
| Static HTTP claim | External-fact or browser owner | The captured HTTP response |

You judge relevance, semantic correctness, acceptable risk, and residual gaps.
A CLI may reject incomplete or stale records, but it cannot decide whether a
test proves the intended behavior, a waiver is honest, or a finding is
material.

## Test-first discipline

This applies whether or not a durable record is required:

1. Declare the contract delta: retained, changed, removed, and added behavior,
   and the invariants.
2. Identify the materially affected tests, fixtures, snapshots, mocks, and
   contract consumers, and decide for each whether to keep, update, remove,
   add, or refactor it.
3. Capture meaningful red at the lowest stable boundary before production
   edits when practical. The failing command, expected failure, and observed
   failure must agree with the missing behavior. Setup, compile, environment,
   unrelated, or retry-only failures do not count.
4. Implement narrowly, then validate by risk: focused owners, affected suites,
   contract consumers, and integration boundaries as needed. Coverage is
   diagnostic, not a goal.
5. If meaningful red is not practical, say why and name the substitute
   validation. Deferred test debt also needs an owner and an expiry.

A `test-first-evidence` record is required only when an active gate or
workflow asks for one. Then initialize it and bind the baseline before
production edits. Record the affected-test decisions and the meaningful red or
a complete waiver. Append scoped final validation, declare residual gaps, run
`verify`, and bind the delivered head. Use `test-first-evidence --help` for
exact syntax.

## Other records

- Retain review findings only when another workflow, a reviewer handoff, or an
  audit consumes them; ordinary inline review reports findings directly.
- A captured HTTP response proves a bounded static claim only. It does not
  prove rendered JavaScript, visual state, browser interaction, or desktop
  behavior.
- Repeated attempts append history; the latest result per identity decides
  readiness. Verify a child record before linking it.

## Closeout and retention

- With no durable record, deferred defect, tracker, or archive duty, report the
  result and stop.
- Evidence useful only for the current task stays with its owner or is
  cleaned up; do not migrate it automatically.
- Before finishing, reduce your artifacts to receipts, trimmed logs, and
  identity records. Delete dependency trees, build output, source clones,
  superseded installed trees, and isolated homes that hold copied credentials.
- Route a reusable gap to the earliest owning test, diagnostic, policy, skill,
  or ordinary issue in its canonical repository. Creating provider state still
  needs the active work mode and the user's authority.
- Evidence never turns an external, destructive, sensitive, or unknown effect
  into an allowed one.
