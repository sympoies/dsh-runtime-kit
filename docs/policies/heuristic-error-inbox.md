# Heuristic error inbox

Use a repository-owned error inbox for a reproducible workflow or heuristic
failure that should be retained but is not yet ready for implementation.
Prefer an issue or the repository's declared retained-record location; do not
invent a hidden home-scoped path.

An entry records the observed behavior, expected behavior, bounded impact,
reproduction evidence, current workaround, and the condition that would make
it actionable. Exclude secrets, private content, and unrelated session state.

`dsh-runtime-kit acceptance-drive --report-issue <absolute-path>` may prepare a
local `dsh-runtime-kit.heuristic-issue-draft.v1` Markdown body from failed
scenario rows. The draft names `workflow::heuristic-records` as its suggested
label, but the command never contacts, creates, or updates provider state. A
human or an explicitly authorized delivery flow reviews the bounded scope and
chooses whether to submit it.

The inbox is not a substitute for an immediately actionable bug fix, a plan, or
a delivery blocker. Promote an entry to the repository's normal issue or plan
workflow once scope and acceptance are clear, and retain a link between the two
records.
