# Browser testing

A request to test in a browser is one outcome: prove a claim about a web
page. Choose the smallest path that can prove the requested claim, run it, and
keep durable evidence only when the claim, a repository gate, an audit, or a
handoff needs it.

## What DSH provides

DSH has no built-in browser. Browser tools exist only when the active
composition mounts the browser-use service with one provider (Playwright MCP,
Chrome DevTools MCP, or Stagehand). Their tools appear in your tool list under
the provider's names, for example `mcp__<server>__<tool>`. Check your tool list
before you plan a rendered-page check. A launched browser belongs to this live
session and is not restored after a reload or fork; an attached browser keeps
its external state.

## Route by claim

| Claim | Path | What it proves |
| --- | --- | --- |
| HTTP status, headers, or a static response body | `curl`, `xh`, or a web fetch tool | Only the captured HTTP response |
| Rendered page state, navigation, or a visual check | A browser-use provider tool, when one is mounted | The observed page state |
| Repeatable DOM interaction, selectors, network waits, or regression coverage | The project's own browser test harness (for example its Playwright suite) through Bash | The test output |
| Native desktop UI, browser chrome, permission dialogs, or cross-application behavior | The desktop automation skill, when available | The desktop observation, not the DOM |

A static HTTP success never proves that JavaScript rendered, a visual
assertion passed, or a desktop interaction happened. Reading source code is not
browser execution, and a desktop screenshot of a browser window is not proof of
DOM state.

## Workflow

1. State the target, the claim to prove, the available execution surface, and
   the chosen path.
2. Use ordinary test output for a routine claim. Before running a tool that
   writes screenshots, traces, or reports, give it an absolute output path in
   the session's `artifact_*` storage. Never let a relative or default output
   path land inside the checkout; a repository-owned test fixture is the only
   exception.
3. Record only the meaningful actions and assertions, and link the screenshots,
   traces, or logs that support them.
4. Report the exact claim proved. If the needed browser or desktop capability
   is unavailable, report the blocker or a narrower verified claim; never
   upgrade static evidence into success.

Keep public records generic: no machine names, users, local paths, connection
details, or credentials.
