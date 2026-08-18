# Topic Radar Source Strategy

## Purpose

`topic-radar` is a read-only AI/technology trend aggregator and lower-level
data engine. It is meant to answer "what source signals exist for this topic?"
rather than provide the final user-facing daily brief, a complete archive, or a
definitive news feed.

## Source Roles

- `official`: source-of-record release and policy changes from AI labs and
  platform vendors.
- `hn`: developer discussion and early community reaction.
- `github`: open-source momentum, tool launches, and implementation evidence.
- `arxiv`: research flow for AI, ML, and language-model work.
- `hf`: model, dataset, and demo ecosystem activity.
- `polymarket`: market attention and uncertainty around public events.
- `news`: broader mainstream coverage via public news search.

## Profiles

- `ai-tech` is the generic default for broad AI and technology scans.

## Presets

- `radar` is the broad source scan. It uses the generic default profile and
  all source roles.
- `ai-news` is the fast daily news entrypoint. It narrows sources to
  `official,news,hn`, uses a five-day window, enables clustered brief output,
  keeps a short public-response cache for follow-up questions, and uses Google
  News RSS by default to avoid routine GDELT rate-limit stalls.
- Fixed monthly or explicit date windows use `--month YYYY-MM` or
  `--from YYYY-MM-DD --to YYYY-MM-DD`. These windows are intended for archive
  and trend-backfill work where a rolling "last N days" window would distort
  historical ranking.
- Agents may use explicit runtime inputs to choose topics, source filters, or
  whether to refresh cached source responses. Output claims must remain
  grounded in returned source items.

## Relationship to Daily Brief

- `daily-brief` should be the default user-facing workflow for daily information
  intake. It resolves the user's intent, applies stable preference steering,
  calls `topic-radar --format json`, and writes the final concise brief.
- `topic-radar` should stay responsible for source acquisition, source fallback,
  cache, ranking, and machine-readable report structure.
- Do not duplicate fetchers, source scoring, cache policy, RSS/API parsing, or
  Polymarket fallback logic in `daily-brief`.

## Ranking Model

The first implementation uses a transparent heuristic:

- source weight
- engagement proxy from the source, when available
- recency within the requested window
- topic keyword match
- cross-source duplication bonus

Do not present the score as objective importance. It is a triage score for
morning review and agent handoff.

## Signal Quality

Heuristic score and report importance are separate concepts. Score is candidate
triage. `signalTier` is the presentation hint that tells report writers whether
an item belongs in Topline, normal brief clusters, or an `Early Watchlist`.

Use these tiers:

- `high-signal`: official source-of-record releases, strong mainstream coverage,
  high community engagement, or repeated cross-source evidence.
- `medium-signal`: relevant items with moderate HN/GitHub/HF/community
  engagement, a credible source, or cross-source support that is not yet strong
  enough for high signal.
- `early-watchlist`: relevant but weakly supported items, especially
  single-source HN or GitHub links with low points/comments, low stars/forks, no
  duplicate source, or very thin source backing.

`recency + topic match` alone is not enough for Topline. Consider source
strength from official or mainstream sources, cross-source duplication, HN points/comments, GitHub stars/forks, and source age.
Low-signal items should remain available when they are useful topic samples,
but brief output should label them as watchlist context rather than adoption or
popularity evidence.

## Expansion Rules

- Prefer public, read-only APIs or RSS/Atom feeds before browser scraping.
- Prefer read-only Polymarket MCP output over direct REST when the current
  agent runtime exposes the `polymarket` MCP tools. Pass exported MCP results
  through `--polymarket-mcp-json`, then let the script fall back to the
  read-only helper when MCP output is unavailable.
- Keep source-specific failures isolated in `errors`.
- Run independent public source fetches in parallel when possible; keep source
  failures isolated so one slow upstream does not block the whole digest.
- Use the public-response cache only for short-lived acceleration. Bypass it
  with `--refresh` when the user asks for exact latest/current evidence.
- Include the fixed-window dates in cache context so historical month scans do
  not reuse a different rolling or monthly response.
- For `news`, the broad `radar` preset tries GDELT first and falls back to
  Google News RSS when GDELT is unavailable, malformed, or empty. The fast
  `ai-news` preset uses Google News RSS directly.
- For historical month scans, prefer date-bounded public APIs where available:
  HN uses Algolia `created_at_i` bounds, GitHub uses `pushed:start..end`,
  arXiv uses `submittedDate`, and GDELT/Google News use date filters. Current
  snapshot sources such as Hugging Face trending and Polymarket helper output
  must report source gaps or timestamp-filtered limitations rather than
  presenting current rankings as historical monthly evidence.
- Add source metadata to every item so reports remain auditable.
- Use JSON output for automation and Markdown output for human daily review.
- Do not add posting, trading, paid-account, or credentialed actions to this skill.
