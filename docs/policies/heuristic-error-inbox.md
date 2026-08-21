# Heuristic error inbox

Use a repository-owned error inbox for a reproducible workflow or heuristic
failure that should be retained but is not yet ready for implementation.
Prefer an issue or the repository's declared retained-record location; do not
invent a hidden home-scoped path.

An entry records the observed behavior, expected behavior, bounded impact,
reproduction evidence, current workaround, and the condition that would make
it actionable. Exclude secrets, private content, and unrelated session state.

The inbox is not a substitute for an immediately actionable bug fix, a plan, or
a delivery blocker. Promote an entry to the repository's normal issue or plan
workflow once scope and acceptance are clear, and retain a link between the two
records.
