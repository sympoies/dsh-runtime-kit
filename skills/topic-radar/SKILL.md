---
name: topic-radar
description: >
  Aggregate read-only AI and technology trend signals (Polymarket, Hacker
  News, GitHub, arXiv, Hugging Face, news search) into source-grounded
  Markdown or JSON; the lower-level data engine behind `daily-brief`.
---

# Topic Radar

## Contract

Prereqs:

- Python 3.11 or newer is available on `PATH` (used by the bundled `topic_radar.py` script, which is stdlib-only).
- Network access for live lookups.
- Optional upstreams may rate-limit anonymous requests; the skill must degrade per-source instead of failing the whole digest.
- Polymarket source support prefers read-only MCP tool output when available; otherwise the bundled `polymarket-readonly` fallback (when the
  domain is installed alongside `reporting`) is invoked transparently by the script.

Inputs:

- Natural-language AI or technology topics.
- Optional profile name: `ai-tech` by default, or its `default` alias.
- Optional preset: `radar` by default, or `ai-news` for a faster daily AI news scan focused on official/news/HN sources.
- Optional source list: `polymarket`, `hn`, `github`, `arxiv`, `hf`, `official`, `news`, or `all`.
- Daily, weekly, or monthly report request, custom rolling day window, fixed `--from/--to` or `--month` window, result limit, parallel fetch
  count, cache TTL, news provider strategy, brief mode, and output format.
- Optional Polymarket MCP JSON export path passed with `--polymarket-mcp-json`.

Outputs:

- Source-grounded AI/technology trend digest in Markdown or JSON.
- Optional clustered brief for fast reading across product, agent/tooling, enterprise, security/governance, and research/open-ecosystem signals.
- Ranked cross-source signal list with source metadata, URLs, timestamps, fixed or rolling window metadata, score rationale, `signalTier`,
  `signalMetrics`, and per-source sections.
- Optional `Early Watchlist` entries for relevant but low-signal items. These entries stay in raw `items` output but should not be treated as
  Topline or adoption evidence.
- Per-source errors when an upstream is unavailable, rate-limited, or malformed, including short response snippets when available.
- Public-response cache metadata so repeated follow-up scans are auditable.
- Sample-mode output for offline smoke checks and report-format review.

Exit codes:

- `0`: success
- `1`: failure
- `2`: usage error
- `3`: unsafe delegated source environment detected

Failure modes:

- Unknown source, report type, format, profile, invalid fixed-window shape, or invalid numeric option.
- Live source returns invalid data, times out, or rate-limits; the affected source is reported in `errors`, while other sources continue.
- The broad `radar` preset uses `news-provider=auto`: GDELT first, then Google News RSS fallback when GDELT is unavailable or empty.
- The faster `ai-news` preset uses `news-provider=google` by default to avoid GDELT rate-limit stalls during daily scans.
- Polymarket MCP output is missing, malformed, or has no usable records; continue to helper fallback unless `--polymarket-fallback none` is
  set.
- Delegated Polymarket helper detects unsafe trading credentials; stop with exit `3`.

## Scripts (only entrypoints)

Resolve the script against this skill's DSH resource base before use:

```bash
topic_radar_script="<skill-resource-base>/scripts/topic-radar.sh"
```

Write temporary raw collection output under:

agent-out path-for --domain tools

## References

- Read [references/source-strategy.md](references/source-strategy.md) before changing source selection, ranking, or report sections.

## Role Boundary

- Use `topic-radar` directly when the user asks for source-level scanning, custom sources, raw Markdown/JSON digest output, or automation
  input.
- Use daily-brief when the user wants the normal daily information entrypoint: concise user-language synthesis,
  preference steering, freshness notes, and source-health explanation.
- `topic-radar` owns source fetching, ranking, fallback behavior, public-response caching, brief clusters, and per-source errors.
- `daily-brief` must not reimplement fetchers, ranking, cache, RSS/API parsing, or Polymarket fallback logic; it should consume
  `topic-radar --format json`.

## Workflow

1. Treat this skill as read-only content and trend research. Do not request or configure trading credentials, social posting credentials, or
   paid news API keys by default.

2. For "AI news today / this week / these days" requests, start with the faster AI news preset. It uses a 5-day window, clustered brief
   output, public-response caching, Google News RSS for mainstream coverage, and the source order `official,news,hn`:

   ```bash
   "$topic_radar_script" --preset ai-news
   ```

   Use `--refresh` when the user asks for exact latest/current results and cached responses should be bypassed:

   ```bash
   "$topic_radar_script" --preset ai-news --refresh
   ```

3. Use the broad radar preset when the user asks for general AI/Tech trend scanning across market, developer, research, model, official, and
   news surfaces. The generic default profile tracks AI agents, model releases,
   developer tools, OpenAI, Anthropic, NVIDIA, and Hugging Face:

   ```bash
   "$topic_radar_script" --report daily
   ```

4. Apply user-supplied topics and source preferences only as runtime inputs.
   Keep the report grounded in the script output and linked source items.

5. When Polymarket is requested and the current agent has the `polymarket` MCP tools, query read-only MCP first:

   - `gamma_list_events` with `active=true`, `closed=false`, and a small `limit`
   - `gamma_list_markets` with `active=true`, `closed=false`, and a small `limit`
   - `gamma_search_public` for the user's focused topic when broad lists are too noisy

   Save those raw MCP results as JSON shaped like this:

   ```json
   {
     "events": [],
     "markets": [],
     "search": []
   }
   ```

   Then pass the file to the radar:

   ```bash
   "$topic_radar_script" \
     --sources polymarket,hn,github \
     --polymarket-mcp-json /path/to/polymarket-mcp.json \
     --report daily
   ```

6. If no MCP output is available, omit `--polymarket-mcp-json`; the script falls back to its bundled `polymarket-readonly` helper logic and
   reports per-source errors if the local network blocks Polymarket REST.

7. For focused research, pass topics and source filters:

   ```bash
   "$topic_radar_script" \
     --topic "AI agents" \
     --topic "developer tools" \
     --sources hn,github,arxiv,hf,polymarket \
     --report weekly
   ```

8. For monthly trend archive work, use a fixed calendar window rather than a rolling `--days` window:

   ```bash
   "$topic_radar_script" \
     --preset radar \
     --report monthly \
     --month 2026-01 \
     --format json
   ```

   For a partial current month, use explicit inclusive dates:

   ```bash
   "$topic_radar_script" \
     --preset radar \
     --from 2026-05-01 \
     --to 2026-05-15 \
     --format json
   ```

   Treat fixed windows as source-bounded evidence. Some sources are current snapshots rather than reliable historical archives; the JSON
   `errors` field reports those gaps instead of silently inventing monthly history.

9. Use JSON when another tool, scheduled job, or agent synthesis step will consume the output:

   ```bash
   "$topic_radar_script" --preset ai-news --format json
   ```

10. Use sample mode for smoke checks, demos, or local validation without network access:

    ```bash
    "$topic_radar_script" --sample --format markdown
    ```

11. Keep the report source-grounded. Separate observed source signals from inference, and do not present heuristic ranking as objective
    importance. Treat `signalTier` as a presentation hint: high/medium signal can feed Topline and brief clusters, while
    `early-watchlist` items are relevant topic samples that need visible metrics such as HN points/comments or GitHub stars/forks.
