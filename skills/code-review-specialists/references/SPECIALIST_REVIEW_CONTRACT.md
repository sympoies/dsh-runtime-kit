# Specialist Review Contract

## Purpose

This contract defines the normalized input and output shape for
`code-review-specialists`. Specialist judgment stays in the workflow; the helper
only performs scope detection, schema validation, severity normalization,
deduplication, confidence gating, and formatting.

## Normalized Finding Schema

Each specialist finding is one JSON object per line:

```json
{
  "severity": "high",
  "confidence": 0.82,
  "path": "src/api/users.ts",
  "line": 42,
  "category": "api-contract",
  "summary": "Response shape changed without migration guidance.",
  "evidence": "Diff removes `email` from `UserResponse` while callers still read it.",
  "recommendation": "Add compatibility handling or update all callers and tests.",
  "actionable": true,
  "fingerprint": "optional-stable-id",
  "specialist": "api-contract",
  "test_suggestion": "Add a contract test for legacy response fields."
}
```

Required fields:

- `severity`
- `confidence`
- `path`
- `summary`
- `evidence`
- `recommendation`
- `actionable`
- `specialist`

Optional fields:

- `line`
- `category`
- `fingerprint`
- `test_suggestion`

`actionable: true` means the owner must change this PR and GitHub publication may
create a native line-level or file-level thread. `actionable: false` keeps the
finding in the canonical summary table without creating a native diff thread.

## Severity And Aliases

Canonical severity values:

- `critical`
- `high`
- `medium`
- `low`
- `info`

Accepted input aliases:

- `CRITICAL` -> `critical`
- `HIGH` -> `high`
- `MEDIUM` -> `medium`
- `LOW` -> `low`
- `INFORMATIONAL` -> `info`
- `INFO` -> `info`

When recording selected findings through `review-evidence`, map severities to
its current `high|medium|low` command surface:

- `critical` and `high` -> `high`
- `medium` -> `medium`
- `low` and `info` -> `low`

Preserve the original normalized severity in the specialist report even when an
evidence record needs this reduced mapping.

## Confidence

Use a number from `0.0` to `1.0`.

- `0.80` to `1.00`: high-confidence verified issue.
- `0.60` to `0.79`: plausible issue with concrete supporting evidence.
- Below `0.60`: omit by default; include as residual risk only when concrete and
  decision-relevant, never as a main finding.

The default display threshold is `0.60`. A reviewer may tune the threshold for
a specific review, but must not promote unsupported speculation to a finding.

## Finding Admission

Evidence alone does not make a concern blocking. A main finding must be
introduced or materially worsened by the reviewed change, reachable in a
supported scenario, and material to the requested outcome, an established
invariant, or a mandatory correctness, security, data, migration, or public
contract boundary.

Do not admit unrelated pre-existing defects, hypothetical hardening,
architecture or style preferences, optional cleanup, future flexibility, or
test expansion without a distinct material changed risk. Low and informational
observations are non-blocking and should appear only when decision-relevant.
Recommendations name the smallest sufficient local repair. A material
architecture or scope change is a user decision, not the default fix.

## Forced Specialists

The workflow supports these force flags in prose and helper scope detection:

- `--testing`
- `--security`
- `--performance`
- `--data-migration`
- `--api-contract`
- `--maintainability`
- `--red-team`
- `--all-specialists`

Forced flags bypass the small-diff skip rule only for the named specialists.

## Red-Team Rule

Run `red-team` after the other selected specialists when either condition is
true:

- any selected specialist produced a `critical` finding
- `diff_lines > 200` and the change crosses a material security, data,
  migration, public-contract, concurrency, or other safety boundary

Raw diff size alone does not activate red-team.
If a released scope helper reports `red_team.required` solely from
`diff_lines > 200`, the caller normalizes that legacy size-only result to not
selected unless a material boundary condition above is independently present.

The red-team pass receives the merged findings from selected specialists and
looks for missed cross-cutting failure modes, invalid assumptions, exploit
chains, and overconfident conclusions.

## Merge Semantics

The helper deduplicates findings by `fingerprint`. If no fingerprint is
provided, it computes one from `path`, `line`, `category`, and `summary`.

For duplicate fingerprints:

- keep the highest-confidence finding as the primary record;
- retain sorted `confirming_specialists`;
- do not infer a merge or follow-up decision.

## Report Sections

Use the shared report template sections:

- Scope
- Specialist Dispatch
- Findings
- Red Team
- Evidence Reviewed
- Residual Risk
- Recommended Next Step

Numeric PR quality scoring is not adopted in v1. Report concrete blockers,
coverage gaps, confidence, and evidence anchors instead.
