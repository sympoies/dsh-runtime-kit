# Changes outside the current repository

Use this policy when work in the current repository appears to need a change in
another repository. The escalation order applies to every other repository,
including one published by the same organization. The submission, identity,
and disclosure gates apply when the other repository belongs to someone else.
An upstream contribution is the last option: solve the problem at its proper
ownership boundary without exporting a local integration concern, private
context, or avoidable maintenance burden.

## Authorization boundary

For a third-party project you may investigate, build a public reproduction,
write tests, prepare a patch, and draft issue or pull request text. You must not
submit the issue, open the pull request, or sign a DCO or CLA. A human
maintainer performs those publicly attributed or legally significant actions
and chooses the account and email used.

Work in another repository owned by the same organization continues through
that repository's normal governed issue and delivery workflows when the user
has authorized it. Do not vendor, fork, or silently patch a sibling repository
instead of raising the change with its owner.

## Escalation order

Use the first viable rung, and record where the investigation stopped and why:

1. Configuration or a supported extension point.
2. A local adapter or wrapper owned by the current repository.
3. Pinning or moving the external project's version.
4. A version-scoped, authenticated downstream patch, where the repository has
   such a mechanism.
5. A contribution to the other repository.

Hard filter first: if only the current repository needs the boundary, it stays
downstream. Upstream work needs a problem other users of that project could
also hit. Search existing issues, pull requests, discussions, and changes merged
but not yet released before drafting; if the behavior already exists, upgrade
or pin instead.

## Issue or pull request

- For a bug, an issue and a pull request may be prepared together.
- For anything else, prepare an issue first, and prepare no pull request until
  a maintainer responds positively, even for a small feature.
- Use issue-first regardless of size when the change touches a public API or
  schema, adds a dependency, needs a migration, changes a documented default,
  or needs new documentation.

These rules control what may be drafted; the human-submission gate still
controls whether anything is opened.

## Contribution rules are a blocking gate

Before drafting for a third-party project, verify and record the rules of the
exact project and target branch: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`SECURITY.md`, DCO or CLA requirements, issue and pull request templates,
commit and title conventions, required test and lint commands, target-branch
rules, and the required submission language. Unverified requirements are a
blocker, not a reason to assume conventional defaults.

A suspected security defect is never reported publicly: no public issue, pull
request, reproduction, or discussion. Follow the project's `SECURITY.md`
private disclosure route. If none is published, escalate to the human
maintainer and make no public report meanwhile.

## Public evidence

Upstream evidence must stand on its own in the other repository: a minimal,
de-identified reproduction that runs there, tests in that project's own
framework, observed and expected behavior, and the exact external version or
commit. Local validation, smoke runs, patch receipts, private logs, and
workflow evidence stay local; they do not substitute for an upstream
reproduction.

Never publish credentials, private content, machine paths, internal hosts,
private topology, private skill contents, non-public employer or client names,
or internal identifiers, in the diff, the reproduction, the logs, or the prose.
A link to the local workaround is optional, only for a public target with no
internal information, and labeled as a downstream expedient.

## Identity and attribution

- A human chooses the account and email that determine attribution.
- Never sign a DCO or CLA or accept another legal contribution agreement.
- Do not add an AI co-author trailer.
- Disclose AI assistance when the other project's rules require it.

## Aftercare

An accepted submission is an ongoing obligation: answer review, update and
rebase when required, and carry it to a terminal outcome. If it is rejected or
goes stale, keep the downstream workaround and record the result with its
owner. Record the public link beside a matching downstream patch; once the fix
ships and the supported version moves, remove the patch through its normal
lifecycle.
