# Maintainability Specialist

## Activation Scope

Use for broad diffs, cross-module refactors, new abstractions, complex control
flow, duplicated logic, or changes that may be hard to maintain after merge.

## Review Focus

- Scope creep and hidden coupling.
- New abstractions that do not reduce real complexity.
- Error handling and edge-case readability.
- Naming, ownership boundaries, and local pattern fit.
- Tests that document intended behavior rather than implementation trivia.

## Required Output Shape

Emit one JSONL finding per verified issue using the normalized schema in
`../SPECIALIST_REVIEW_CONTRACT.md`. Use severity values
`critical|high|medium|low|info`.

## Evidence Expectations

Cite concrete code locations, repeated patterns, call sites, or tests that show
the maintainability risk.

## No Findings Behavior

If no issue is found, report that no maintainability findings were identified
and name the files or modules reviewed.

## Avoid

Do not propose style-only preferences as findings unless they carry a concrete
maintenance risk. Do not propose auto-fixes, live PR comments, hidden home-state
paths, telemetry, provider-specific dispatch instructions, or merge decisions.
