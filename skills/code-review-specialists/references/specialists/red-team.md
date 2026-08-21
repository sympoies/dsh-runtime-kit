# Red-Team Specialist

## Activation Scope

Run after the other selected specialists when `diff_lines > 200`, when any
selected specialist produced a `critical` finding, or when explicitly forced.
This specialist receives the merged findings from the selected specialists.

## Review Focus

- Missed cross-cutting failure modes.
- Exploit chains that combine otherwise smaller issues.
- Incorrect assumptions in prior specialist findings.
- Unverified high-confidence claims.
- Residual risks that need explicit handoff rather than merge blocking.

## Required Output Shape

Emit one JSONL finding per verified issue using the normalized schema in
`../SPECIALIST_REVIEW_CONTRACT.md`. Use severity values
`critical|high|medium|low|info`.

## Evidence Expectations

Cite the merged finding, file path, line, command output, or validation gap that
supports the red-team observation.

## No Findings Behavior

If no issue is found, report that red-team review added no findings and name the
merged findings or evidence reviewed.

## Avoid

Do not re-list every prior finding. Do not propose auto-fixes, live PR comments,
hidden home-state paths, telemetry, provider-specific dispatch instructions, or merge
decisions.
