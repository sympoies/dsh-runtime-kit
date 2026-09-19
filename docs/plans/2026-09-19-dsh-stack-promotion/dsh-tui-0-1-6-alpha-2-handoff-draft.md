# Draft: dsh-TUI support for DeepSeek Harness 0.1.6-alpha.2

## Routing

This is a draft for a human to submit to the dsh-TUI **Discussions / Ideas**
category. It is a compatibility request for a DSH release that the current TUI
does not claim to support, rather than a regression inside the documented
support range. Do not open an implementation PR unless a dsh-TUI maintainer
creates and assigns the tracking issue or otherwise follows that repository's
contributor gate.

## Suggested title

Support DeepSeek Harness 0.1.6-alpha.2 in a released dsh-TUI artifact

## Suggested body

### Request

Please add and release explicit compatibility with DeepSeek Harness
`0.1.6-alpha.2` (`dsh-v0.1.6-alpha.2`, commit
`ddefc45fbc7f8e46dd73185e68295696d1297887`).

The latest released dsh-TUI artifact I tested is
`@deepseek-harness-tui/dsh-tui@0.10.2`, source tag `v0.10.2` at commit
`9abb9101fbaead9dd37da28193618da5f07322c0`. Its `@deepseek-ai/*` peer ranges
stop at `0.1.5-rc.1`, so no override was used as compatibility evidence.

### Clean reproduction

Environment: Linux x86_64, Node `26.8.2`, pnpm `11.24.0`.

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout ddefc45fbc7f8e46dd73185e68295696d1297887
pnpm install --frozen-lockfile --ignore-scripts
pnpm run clean
pnpm run build:lib:host

export DSH_HOME="$(mktemp -d)"
pnpm dsh plugin --profile dsh-tui add --save-exact \
  @deepseek-harness-tui/dsh-tui@0.10.2
pnpm dsh dsh-tui --dump-config
```

The install completes with peer-dependency warnings. Composition then reports:

```text
dsh: [@deepseek-harness-tui/dsh-tui] patch: entry "workflow-worker-thread" not found
```

Verified against dsh-TUI `main` at
`a97f7bddfeeb1f2738a2bde94a8f65364c860659`: the top-level
`workflow-worker-thread` override is still present, and the package peer ranges
still exclude `0.1.6-alpha.2`.

There is also an earlier closed compatibility attempt, PR
<https://github.com/ccch1mneyyy/dsh-TUI/pull/906>, which documents a second
0.1.6 change: `@deepseek-ai/dsh-code-runtime-worker-thread` was replaced by the
PTC runtime packages. That PR was closed by the contributor-allowlist gate and
is cited only as prior investigation, not as a proposed submission route.

### Expected acceptance

- A released dsh-TUI artifact explicitly admits DSH `0.1.6-alpha.2` without a
  forced peer override.
- A clean profile composes successfully with the exact released DSH packages.
- The repository's required build/package checks pass.
- A real TTY smoke covers startup, one normal interaction, cancellation, and
  clean terminal restoration in inline and fullscreen modes.

If the maintainers prefer a different target DSH release or tracking route,
please indicate the exact tuple to validate before implementation begins.

## Local evidence retained downstream

- dsh-TUI default branch inspected: `main` at
  `a97f7bddfeeb1f2738a2bde94a8f65364c860659`.
- Latest inspected release: `0.10.2`, tag commit
  `9abb9101fbaead9dd37da28193618da5f07322c0`.
- Contribution rules inspected: `docs/contributing.md`, both bug templates,
  the PR template, `CODE_OF_CONDUCT.md`, and `.github/APPROVED_CONTRIBUTORS`.
  No `SECURITY.md`, DCO, CLA, or AI-disclosure rule was found in those owners.
- This draft contains no private runtime evidence, credentials, machine paths,
  or internal topology. A human chooses whether and where to submit it.
