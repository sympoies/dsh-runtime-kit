# Changes outside this repository

Follow the full
[agent-runtime-kit policy](https://github.com/sympoies/agent-runtime-kit/blob/main/core/policies/upstream-contribution.md)
whenever a DSH limitation may require a change in another repository.

Use the first viable rung and record why it is sufficient: supported
configuration or extension point; local adapter or wrapper; version change;
version-scoped, hash-authenticated downstream patch; upstream contribution.
If only this runtime kit needs the boundary, it stays downstream.

Search existing issues, pull requests, discussions, and merged-but-unreleased
changes first. A bug issue and PR may be drafted together. Every non-bug is
issue-first, and a maintainer must respond positively before any PR is drafted.
Public API or schema changes, new dependencies, migrations, documented-default
changes, and new documentation are always issue-first.

For a third-party project, agents may investigate, build a de-identified
reproduction, write tests, and prepare issue or PR text. They must not submit
the issue, open the PR, or sign a DCO or CLA. A human maintainer chooses the
identity and performs those actions.

Before drafting, verify the project's contribution, security, identity, test,
lint, template, branch, title, language, DCO, and CLA rules. Unverified means
blocked. A suspected security defect is never reported publicly; use the
project's private disclosure route or escalate privately when none exists.

Upstream evidence must run in the upstream repository and use its conventions.
Never publish credentials, private content, machine paths, internal hosts,
private topology, employer or client names not already public, or internal
identifiers. Link a public downstream workaround only when it is safe, useful,
and clearly labelled as a downstream expedient.
