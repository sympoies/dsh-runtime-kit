# Changes outside this repository

## Purpose

Use this policy when work in this repository appears to require a change in
another repository. The escalation order applies to every repository outside
this one, including another project published by the same organization. The
third-party submission, identity, and disclosure gates apply when the other
repository is owned by someone else.

An upstream contribution is the last option. The objective is to solve the
accepted problem at its proper ownership boundary without exporting a DSH-only
integration concern, private context, or avoidable maintenance burden.

## Authorization boundary

For a third-party project, agents may investigate, reconstruct a public
reproduction, write tests, prepare a patch, and draft issue or pull-request
text. They must not submit the issue, open the PR, or sign a DCO or CLA. A
human maintainer performs those publicly attributed or legally significant
actions and chooses the account and email used for the contribution.

Work in another repository owned by the same organization continues through
that repository's normal governed issue and delivery workflows when the user
has authorized it. Do not vendor, fork, or silently patch a sibling repository
instead of raising the change in its actual owner.

## Escalation order

Before proposing work outside this repository, use the first viable rung and
record where the investigation stopped and why:

1. Configuration or a supported extension point.
2. A local adapter or wrapper owned by this repository.
3. Pinning or moving the external project's version.
4. A version-scoped, hash-authenticated downstream patch declared in
   `compatibility/dsh-patches.json`.
5. A contribution to the other repository.

Apply one hard filter first: If only this runtime kit needs the boundary,
it stays downstream.
A boundary that exists solely for DSH integration belongs in a local adapter
or authenticated downstream patch. Upstream work requires a problem another
user of that project could also encounter.

Search existing issues, pull requests, and discussions before drafting. Also
inspect changes already merged to the default branch but not yet released. If
the needed behavior already exists, upgrade or pin instead of submitting a
duplicate.

## Issue or pull request

Classify the proposed change against the other project's own documented or
intended behavior:

- For a bug, an issue and pull request may be prepared together.
- For anything that is not a bug, prepare an issue first. Do not prepare a
  pull request until a maintainer responds positively. This includes a small
  feature.
- Use issue-first regardless of size when the change touches a public API or
  schema, adds a dependency, requires a migration, changes a documented
  default, or requires new documentation.

These rules control what may be drafted. The third-party human-submission gate
still controls whether any issue or pull request is opened.

## Contribution rules are a blocking gate

Before drafting for a third-party project, verify and record the applicable
rules from the exact project and target branch. At minimum, inspect:

- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md`;
- DCO or CLA requirements;
- issue and pull-request templates;
- commit and pull-request title conventions;
- required test and lint commands;
- branch and target-branch rules; and
- the required submission language.

Unverified requirements are a blocker, not a reason to assume conventional
defaults.

A suspected security defect is never reported publicly and must not become a
public issue, pull request, reproduction, or discussion. Follow the project's
`SECURITY.md` private disclosure route. If no private route is published,
escalate to the human maintainer for a decision and make no public report in
the meantime.

## Public evidence and disclosure

Upstream evidence must stand on its own in the other repository:

- a minimal, de-identified reproduction that runs inside that repository;
- tests using that project's own framework and conventions;
- observed and expected behavior; and
- the exact external version or commit.

State the real impact. Internal validation, DSH smoke runs, patch apply or
reverse receipts, private logs, and local workflow evidence stay with this
repository; they are not substitutes for an upstream reproduction.

Reconstruct evidence for a public audience. Never publish credentials,
private content, machine paths, internal hosts, private topology, private skill
contents, employer or client names that are not already public, or internal
identifiers. This prohibition applies to the diff, reproduction, logs, and
issue or pull-request prose.

A link to this repository's workaround is optional. Include it only when the
target is public and contains no internal information. Label it explicitly as
a downstream expedient, not the proposed upstream implementation.

## Identity, licensing, and attribution

- A human chooses the account and email that determine personal or employer
  attribution.
- An agent must not sign a DCO or CLA or accept another legal contribution
  agreement.
- Do not add a `Co-Authored-By: Claude` trailer.
- Disclose AI assistance when the other project's rules require it.

## Aftercare

Treat an accepted submission as an ongoing obligation to answer review,
update the change, rebase when required, and carry it to a terminal outcome.
If it is rejected or becomes stale, retain the downstream workaround and
record the result with its owner.

When an upstream issue or pull request corresponds to a downstream patch,
record the public link beside that patch when its manifest supports the field.
The link is the removal signal: once the fix is released and the supported
version has moved, remove the patch through its normal authenticated lifecycle.
