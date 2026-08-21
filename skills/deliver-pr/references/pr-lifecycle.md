# PR And MR Lifecycle Reference

This reference owns PR/MR rules that repeat across `pr` skills. Keep provider
specifics and one-off stop conditions in the owning skill when they change that
skill's next action.

## Shared Rules

- Use released nils-cli surfaces: `agent-runtime pr-body render` for body
  scaffolding and `forge-cli pr ...` for provider create, checks, ready, merge,
  close, and comments.
- Provider auth must be live before mutation: `gh auth status` for GitHub,
  `glab auth status` for GitLab.
- The branch must be published, have the intended base, and match the PR kind
  prefix enforced by `forge-cli` (`feature -> feat/`, `bug -> fix/`,
  `chore -> chore/`, `docs -> docs/`, `ci -> ci/`, `refactor -> refactor/`).
- Publish the branch with `git-cli push --format json`, not a raw `git push`. It
  pins the destination to `refs/heads/<branch>:refs/heads/<branch>`, so
  `push.default`, `remote.pushDefault`, and configured refspecs cannot move it;
  it refuses the remote's default branch; and it sets the upstream to the
  branch's own ref on first publish, which is what `pr deliver` compares against
  when it reports `head_not_pushed`. A fresh managed worktree starts with no
  upstream at all, so the first publish must go through this surface — and
  `block-unsafe-default-delivery` refuses a raw push it cannot classify.
- Rendered bodies must include `## Summary` and `## Test plan`. Do not
  hand-write section scaffolding or derive title/body from `git log -1`.
- Provider-visible bodies and comments must not contain raw machine-local home
  paths. Rewrite useful evidence paths to `$HOME/...`; omit local-only artifact
  paths when a remote reader cannot use them. The released `forge-cli` provider
  payload gate is the final enforcement point; do not set
  `FORGE_CLI_ALLOW_LOCAL_PATH=1` unless you confirmed a false positive and
  recorded that decision.
- Issue-backed plan references use non-closing refs such as `Refs #<issue>`.
  Provider auto-close keywords are banned until the matching plan closeout skill
  has verified lifecycle evidence. Carry the refs through
  `agent-runtime pr-body render --issues-file` (rendered as `## Issues` for
  every kind; `bug` renders its required `## Issues Found`); kind-specific
  section files are rejected under a non-owning kind instead of silently
  dropped.
- Select labels from `manifests/forge-labels.yaml` when present: one `type::`,
  one primary `area::`, and `size::`; add `risk::`,
  `provider::<github|gitlab>`, or `state::do-not-merge` only when they convey a
  real routing or safety decision.

## Review And Merge Gates

- End-to-end delivery runs the mandatory pre-merge review gate before merge.
  Eligible L0/L1 routine changes may use a terminal quick pass; L2/L3 work,
  specialist triggers, unresolved review state, or quick escalation use the full
  profile. Both profiles retain the same provider merge gates.
- Close-only workflows run review only when the user asked for it or when the
  PR/MR would finalize issue-backed plan work.
- Before merging a PR/MR that finalizes a tracking or dispatch issue, verify
  source/plan evidence, complete state, latest session, validation, review, and
  dashboard links. Route incomplete records to the matching plan delivery or
  closeout skill instead of merging and backfilling.
