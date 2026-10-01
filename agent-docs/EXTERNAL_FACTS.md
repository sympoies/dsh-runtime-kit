# External facts and task tools

Read this before you rely on an external, unstable, or time-sensitive claim:
versions, releases, prices, news, API shapes, or third-party behavior. Local,
stable, repository-internal facts need no lookup; cite the file, command, or
definition instead.

## Verify before you assert

- Prefer an authoritative, current source over memory or assumption: the
  project's own release, changelog, documentation, or API response.
- Memory and earlier conversation are leads, not evidence. Verify a remembered
  version, path, account, service, or capability against live state first.
- When a source is unavailable, say what you could not verify instead of
  presenting an assumption as fact.

## Citations

Cite the evidence when source material materially affects a requirement,
feasibility, work, or external-fact claim:

- `[U#]` user input
- `[F#]` local file, code, or document
- `[W#]` web source
- `[A#]` app, API, CLI, or tool result
- `[I#]` inference from cited facts

When a conclusion depends on uncertainty, separate known facts, assumptions,
inferences, and open questions.

## Escalation ladder

Reach external data through the cheapest surface that proves the claim:

1. A local CLI or a repository file that already holds the answer.
2. A provider CLI or API with structured output: `gh` or `forge-cli` for
   repository, release, issue, and pull request facts; `curl` with `jq` for a
   JSON API.
3. A web fetch or search tool, when the active DSH composition provides one.
4. A browser, only when the claim depends on rendered state; route it through
   the `web-testing` policy.

A static HTTP response proves only that response. It does not prove that a
page rendered, a script ran, or an interaction succeeded.

## Command-line defaults

Prefer purpose-built tools that are fast, repository-aware, and emit
structured output over fragile ad-hoc pipelines:

| Need | Prefer | Instead of |
| --- | --- | --- |
| Repository text search | `rg` | `grep -R`, `find -exec grep` |
| Find files | `fd` | verbose `find` |
| JSON | `jq` | `grep`, `sed`, or `awk` on JSON |
| YAML, TOML, or XML | `yq` | hand-editing or regex parsing |
| HTTP | `curl` or `xh` | a throwaway client program |
| Structural search or rewrite | `ast-grep` | regex-only mass replace |

Check that a tool is installed before you depend on it, and fall back to the
portable equivalent when it is not.
