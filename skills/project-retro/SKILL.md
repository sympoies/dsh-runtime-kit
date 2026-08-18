---
name: project-retro
description: >
  Generate a repo-local project implementation retrospective by consuming the
  nils-cli `repo-retro` command — local git history only, no remote API
  enrichment.
---

# Project Retro

## Contract

Prereqs:

- `repo-retro` is installed from the released nils-cli/Homebrew package and is available on `PATH`.
- Verify the installed command before synthesis with `command -v repo-retro`, `repo-retro --version`, and `repo-retro --help` when the runtime
  has not already established that boundary.
- The target project is available as a local git work tree.
- Home/project preflight has been satisfied before editing repo files, committing, or writing durable records.
- Optional evidence inputs are explicit user-provided paths; do not discover them from memory, hidden state, or broad home-directory scans.
- Durable report history is written only when the user requests it and supplies an explicit history directory.

Inputs:

- Natural-language request for a project retrospective, repo-local implementation review, weekly review, or trend snapshot.
- Optional window selector supported by `repo-retro report`: default current week, `--since YYYY-MM-DD`, `--days N`, or
  `--from YYYY-MM-DD --to YYYY-MM-DD`.
- Optional repo path when the retro should inspect a work tree other than the current checkout.
- Optional review mode: `personal`, `team`, or `maintainer`.
- Optional explicit typed JSONL inputs for timeline, learnings, validation, review, incidents, and decisions.
- Optional `--history-dir <dir> --write` for local history persistence.
- Optional output format: `json` for machine-readable handoff or `markdown` for direct review.

Outputs:

- Concise retrospective in the user's language, synthesized from the `cli.repo-retro.report.v2` envelope and
  `repo-retro.report.v2` result payload.
- Top-level primary themes or through-lines that answer what the selected window was mainly about, synthesized from deterministic signals
  and clearly marked as inference when they go beyond direct CLI fields.
- Traceable summary of repo identity, window metadata, commit type mix, authors, hotspots, validation signals, HEURISTIC_SYSTEM movement,
  optional input summaries, warnings, and source commands.
- Optional local history records only when `repo-retro report --history-dir <dir> --write` is explicitly requested.
- Clear note when no history was written, optional inputs were absent, the selected window had no commits, or the installed command is missing.

Exit codes:

- N/A for this instruction-first workflow.
- `repo-retro` owns command exit status. Treat exit `0` as successful report generation and any non-zero status as a failed deterministic
  source collection step that must be reported before synthesis.

Failure modes:

- `repo-retro` is missing, resolves to an unreleased checkout wrapper, or reports an unexpected version for the requested adoption boundary.
- The target path is not a git work tree or local git commands fail.
- The requested window is incomplete, invalid, or reversed.
- Optional JSONL paths are missing, unreadable, or malformed beyond the CLI's accepted warning behavior.
- History persistence is requested without both `--history-dir` and `--write`.
- The JSON envelope is not `cli.repo-retro.report.v2` or the result schema is not `repo-retro.report.v2`.

## Outcome Routing

This is the canonical repository-retrospective outcome. Callers invoke the
released `repo-retro` CLI for deterministic collection and this workflow owns
interpretation. For a
one-off report, artifact allocation and CLI collection are internal bookkeeping
and default to stdout or the workflow state-out path. Durable history remains an
explicit user outcome because it writes retained files.

## Entrypoint

`project-retro` is a skill surface, not a local parser. Use the installed nils-cli command directly:

```bash
repo-retro report --repo "$PWD" --days 7 --mode team --format json
```

Useful variants:

```bash
repo-retro report --repo /path/to/project --from 2026-05-11 --to 2026-05-17 --mode team --format json
repo-retro report --repo /path/to/project --days 7 --mode maintainer --format markdown
repo-retro report --repo . --timeline-jsonl ./timeline.jsonl --validation-jsonl ./validation.jsonl --format json
```

For one-off saved artifacts when the user has not selected a durable history folder, route through the product-specific state-out scratch
path:

agent-out path-for --domain projects --topic project-retro

Then pass that explicit path with `--history-dir <dir> --write` only if the user wants files written.

## Workflow

1. Resolve the retro intent.
   - Use `project-retro` for local project implementation retrospectives and engineering trend snapshots.
   - Weekly is only a window choice, not the workflow identity.
   - Use `daily-brief` instead for external news, market, or source synthesis.
   - Ask only when the target repo, window, mode, or persistence destination is materially unclear.

2. Verify the installed CLI boundary.
   - Run `command -v repo-retro` and prefer the released Homebrew path on this machine.
   - Run `repo-retro --version` when version evidence matters.
   - Do not call an unreleased nils-cli checkout wrapper.

3. Run `repo-retro report`.
   - Prefer JSON first for synthesis:

     ```bash
     repo-retro report --repo <path> --days 7 --mode team --format json
     ```

   - Use explicit `--from` and `--to` dates when the user asks for "this week" or "last week" and the exact boundary matters.
   - Do not call `git fetch`, GitHub, GitLab, personal context stores, or telemetry services for the first-pass report.

4. Inspect the JSON envelope.
   - Confirm `schema_version` is `cli.repo-retro.report.v2`.
   - Confirm `result.schema` is `repo-retro.report.v2`.
   - Use `result.window`, `result.git.summary`, `result.git.commitTypes`, `result.git.authors`, `result.git.churnByClass`,
     `result.git.archival`, `result.git.fileHotspots`, `result.git.testSignals`, `result.analysis`, `result.heuristicSystem`,
     `result.optionalInputs`, `result.warnings`, and `result.sources.commands`.
   - Lead the churn read with `result.git.churnByClass` (source / tests / productDocs / processArtifacts) rather than raw line totals, so
     process-doc authoring and archival do not dominate; `result.git.fileHotspots.topFiles` is commit-frequency ranked and each entry carries
     `class` / `netDeleted`. Treat `result.git.archival.netDeletedFiles` as removed/archived, not as review targets.
   - Treat `result.analysis.themes` as deterministic source signals, not as a substitute for the final user-facing primary theme synthesis.
   - Carry through warnings and source commands so the user can verify what was read.

5. Synthesize the retrospective.
   - Lead with 1-3 primary themes or through-lines before detailed metrics.
   - Synthesize those themes from the CLI signals, such as commit type mix, file hotspots, recent commit subjects, validation signals,
     HEURISTIC_SYSTEM movement, and optional typed inputs when provided.
   - Mark theme statements as inference when they connect multiple deterministic signals into a narrative about the work.
   - Keep commit-type mix, hotspots, author summaries, validation signals, and HEURISTIC_SYSTEM movement compact.
   - Treat Heuristic System records as read-only operational evidence. Do not create, mutate, promote, or archive inbox entries from this
     workflow; session closeout policy owns that lifecycle through the direct CLI.
   - Mark inference explicitly when connecting several deterministic signals into a habit, risk, or follow-up recommendation.

6. Handle typed JSONL inputs.
   - Read only the paths supplied by the user or calling workflow.
   - Do not search `$HOME`, memory, or hidden project state for timeline, learnings, validation, review, incident, or decision files.
   - Report malformed-line warnings returned by `repo-retro`; do not treat optional JSONL as telemetry.

7. Handle history writes.
   - Default to stdout and no writes.
   - Require `--history-dir <dir> --write` before writing Markdown, raw JSON, or `index.jsonl`.
   - `--history-dir <dir>` without `--write` may report intended paths but must not create directories or files.
   - Do not commit generated retros unless the user explicitly chooses a tracked directory and asks for those generated records.

## Boundaries

- `project-retro` is distinct from `daily-brief`: it reviews local repo engineering activity, while `daily-brief` synthesizes external source
  signals through `topic-radar`.
- `project-retro` consumes the released `repo-retro` CLI. It does not own a duplicate git parser, HEURISTIC_SYSTEM parser, history writer, or
  report schema implementation.
- `project-retro` may summarize `skill-usage` or other workflow evidence only when it is provided as an explicit JSONL/path input or appears
  in local git history.
- `project-retro` reads Heuristic System records but never replaces the
  policy-owned heuristic lifecycle.
- The CLI owns deterministic data collection and path-safe writes; the skill owns user-facing judgment, primary-theme synthesis, and
  follow-up framing.

## Excluded Behaviors

- No default writes to memory, hidden home-state folders, or tracked reports.
- No proactive checkpointing, telemetry, global cross-repo discovery, or personal context loading.
- No remote provider API enrichment in the first-pass report.
- No generated report committed by default.
- No local Python helper fallback for report generation.
