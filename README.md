# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public, out-of-tree DeepSeek Harness runtime
layer that will replace `agent-runtime-kit`. It is a DSH bundle, not a fork and
not a copied preset.

The current implementation contributes one Cordis plugin, the 29 public
workflow skills, optional private-skill loading, and one native DSH probe tool,
`runtime_kit_plus_one`. Its rc.7 adapter correlates the public session-start,
pre-step, pre-tool, post-tool, result, and turn-stop lifecycle boundaries while
forwarding only `tools/pre-execute` through `agent-hook --product dsh`. Policy
is evaluated by the shared Rust engine rather than repeated in prompts or
reimplemented in JavaScript. The probe tool remains deliberately small while
the remaining policy handlers and reviewer personas are migrated.

The frozen policy parity inventory is `policy/rule-parity.yaml`. It binds the
101 source registration IDs, 21 legacy handlers, and one relocated memory
capability to their DSH/nils replacement or evidence-backed retirement. During
migration, verify it against the retained legacy source with:

```sh
node scripts/check-rule-parity-source.mjs \
  /path/to/agent-runtime-kit/manifests/hook-rules.yaml
```

## Current contract

- Installs with `dsh plugin --profile <name> add <package>`.
- Contributes configuration through `cordis.patch.yml`.
- Registers tools through the host-provided DSH `tools` service.
- Registers the packaged `skills/` catalog through DSH's public filesystem
  skill-provider API.
- Loads an optional absolute, owner-controlled private skill directory from
  `DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR`; no private names or contents are
  packaged.
- Preserves DSH precedence: project skills override configured private skills,
  which override bundled public skills.
- Validates private skills as an owner-controlled POSIX tree, then detaches all
  instructions and resources into a sealed process-local snapshot before
  registration. Changes take effect on the next DSH process; there is no live
  watching or lazy reopening of the private source tree.
- Invokes `agent-hook` through the host-provided DSH `subprocess` service and
  fails closed on missing, malformed, truncated, signaled, or mismatched policy
  output.
- Retains only content-free session/cwd/turn/step/call correlation. Prompt
  messages, raw arguments, subprocess output, and tool result bodies are never
  stored in lifecycle state, and session/turn/step facts do not expand the
  strict `agent-hook.dsh-ingress.v1` wire format.
- Binds both allow and deny policy evaluations to DSH's opaque execution token,
  exact Agent, Session, and deep-frozen argument object, and live lifecycle
  correlation. Parent execution token and cancellation signal references are
  bound too. Authorization and correlation are keyed by the exact execution
  object, while the original opaque token is checked independently, so token
  replacement cannot leak or replay a marker. The host's denial-only guard
  consumes the exact authorization once, so a prepended pre-execute listener
  cannot skip policy, a later pre-execute listener cannot substitute an
  unevaluated payload, and an outer pre-execute waterfall cannot reverse an
  authoritative nils denial.
- Treats `tools/post-execute` as a non-authoritative candidate boundary and
  `tools/result` as the authoritative final outcome. A stale or mismatched
  post-tool identity blocks through the public rc.7 `PostToolDecision` contract.
- Commits a proposed step only after the rc.7 pre-step waterfall returns
  `enter`, then derives the live open step from public durable events. Initial
  attachment reverse-scans only the recent lifecycle suffix; later boundaries
  incrementally fold events after a retained append-only anchor instead of
  rescanning content-heavy suffixes. Replacement or truncation makes that
  attachment sticky-invalid until session reattachment. Reject, throw, abort,
  `step/end`, and `turn/end` therefore fail closed without invoking nils.
- On caller cancellation, deadline, or plugin disposal, terminates the nils
  child and observes both direct-child settlement and whole-process-tree exit.
  If a provider cannot establish quiescence by the teardown deadline, the
  current call fails closed and policy admission permanently degrades closed
  for the process; every in-flight sibling is cancelled too. A monotonic
  admission epoch also revokes allow markers waiting at rc.7 approval.
- Does not modify or vendor DeepSeek Harness.
- Contains no private skills. Project discovery remains DSH-native through
  `.dsh/skills` and `.agents/skills`.

Private discovery defaults to at most 32 directory levels, 10,000 entries,
4 MiB per regular file, and 32 MiB total. `privateSkillMaxDepth` and
`privateSkillMaxEntries` may lower those limits; hard ceilings are 64 and
20,000. Symlinks, non-regular entries, foreign ownership, and group- or
world-writable tree entries fail startup closed. The private loader is disabled
on Windows until equivalent ACL trust checks exist.

Policy checks default to a 5-second decision deadline, a 2-second teardown
deadline, and four active subprocesses. `policyTimeoutMs` is capped at 30
seconds, `policyTeardownTimeoutMs` at 10 seconds, and
`maxActivePolicyChecks` at 16. There is deliberately no waiting queue: calls
beyond the active ceiling fail closed with `policy-overloaded`. Confirmed
quiescence releases capacity normally; unknown quiescence closes all admission
instead of silently reopening capacity.

The exact supported DSH peer line is `0.1.0-rc.7`; the compatibility adapter is
not declared compatible with later release candidates or `0.1.x` releases.
The mutation containment claims above apply to the public pre-execute policy
waterfall and monotonic guard. In-process plugins that register
`tools/execute` around-dispatch wrappers are trusted computing base: the rc.7
public contract permits those wrappers to replace only `signal`, but a plugin
that deliberately violates other readonly fields is already executing trusted
code after the guard. This bundle does not use property-descriptor hardening or
non-public Harness APIs to contain a hostile in-process wrapper.

## Keyless smoke test

Prepare a DeepSeek Harness source checkout without running its repository hook
installer, then run:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
npm run test:smoke
```

The acceptance test packs the publishable tarball, installs it into a clean
temporary `DSH_HOME`, invokes the actual `dsh plugin` and `dsh --dump-config`
paths, and boots the real DSH composition. It proves the 29-skill catalog plus
project/private precedence, then drives a scripted public LLM adapter through a
real Agent and two-step tool loop. It checks all six lifecycle boundaries,
observes `runtime_kit_plus_one({ value: 41 })` return `42`, switches policy to
prove pre-body denial, and exercises cancellation and plugin-disposal drains.

## Compatibility

The first verified compatibility target is DeepSeek Harness `0.1.0-rc.7` on a
supported Node.js release. DSH is still prerelease software, so compatibility
will be guarded by executable acceptance tests rather than by copying upstream
implementation details.

The machine-readable [nils-cli compatibility manifest](compatibility/nils-cli.json)
is authoritative for consumed commands and protocols. The DSH ingress is
currently source-validated but still `pending-release`, so this package does
not yet declare a minimum or validated nils-cli release. A local checkout or
ambient prototype binary must not be treated as release compatibility.
