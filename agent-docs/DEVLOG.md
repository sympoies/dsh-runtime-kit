# Development log

A repository's development log holds the reasoning a diff cannot carry. Commit
messages say what changed; the log says why it was shaped that way, what was
ruled out, and what evidence made it credible. That value exists only if the
log is written without being asked and read without being told.

## Detection

A repository has a development log when one of these index files exists:

| Index | Log directory |
| --- | --- |
| `docs/devlog/README.md` | `docs/devlog/` |
| `docs/source/devlog/README.md` | `docs/source/devlog/` |

The index, not the directory, is the marker; it also holds the repository's own
conventions. A log directory without an index is a half-built log: say so and
offer the repair (write the `README.md`, then run `devlog index`). Until the
index exists, do not search it or append to it.

A repository with neither directory has no log, and that is a finished state.
Do not create one, and do not raise it as a finding or follow-up. Add a log only
when the user asks for that repository.

## Read

Consult the log before:

- changing a contract, schema, guardrail, or default, or removing something an
  entry may explain;
- acting on behavior that looks arbitrary when the reason is not in the code;
- investigating a regression whose cause may be a recorded decision.

Use `devlog search '<term>'`, optionally with `--month YYYY-MM`. Matching is
literal and case-insensitive, so search an identifier (a module, a flag, an
error code, a path) rather than a paraphrase.

An entry is history, not authority. When the log and the current contract
disagree, the contract wins, and the disagreement is worth reporting.

## Write

Append at the finish line, where you know what you actually delivered; not on
request, and not per commit. Write an entry for:

- a shipped capability, adapter, or ownership change;
- a contract, schema, compatibility, or security decision;
- a validation milestone or an incident-relevant finding;
- an external reference worth keeping.

Skip trivial changes, transient work, same-turn cleanups, and anything with no
future lookup value. Silence is the correct outcome for most sessions. Update
the canonical current document first; the log records history, it does not own
the current contract.

## Mechanism

Use the `devlog` CLI:

```sh
devlog new --title '<title>' \
  --result '<what now exists>' \
  --why '<why it was shaped this way>' \
  --evidence '<command or observation that actually ran>' \
  --link '<commit, pull request, or issue>'
devlog check
```

`--result`, `--why`, and `--evidence` are required; omit `--link` and
`--follow-up` rather than filling a placeholder. `devlog check` exits 65 on a
structural problem. A log that predates these rules may fail `check` in bulk;
run `devlog fix` once, then resolve what it reports instead of hand-editing
history. Without the CLI, follow the index file's conventions by hand.

## Never

- Never record a credential, a machine-local path, a personal identifier, an
  internal hostname, private topology, a provider payload, private skill
  contents, or another agent's session state. Reference identifiers, never
  values; the log is readable by everyone who can read the repository.
- Never restate a diff or a normative document without adding context,
  evidence, or a link worth finding later.
- Never rewrite an older entry, except to correct a factual error in the same
  change.
