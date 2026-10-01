# Local Rehearsal

Before provider writes, inspect the program tracker and every child issue.
Draft their exact Markdown bodies with the session `artifact_*` tools, then use
`forge-cli issue create --dry-run` or `issue edit --dry-run` with the same body
files and labels.
Inspect lane PRs with `forge-cli pr view`, checks with `forge-cli pr checks`,
and the final integration target before assigning workers.

A rehearsal proves command shape and target selection; it does not prove
provider acceptance, lane implementation, independent review, checks, or
merge. Live delivery uses the same body files through governed `forge-cli`
commands and verifies every result by provider read-back.
