# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public, out-of-tree DeepSeek Harness runtime
layer that will replace `agent-runtime-kit`. It is a DSH bundle, not a fork and
not a copied preset.

The current implementation establishes the compatibility seam. It contributes
one Cordis plugin, the 29 public workflow skills, optional private-skill
loading, and one native DSH probe tool, `runtime_kit_plus_one`. The plugin also
forwards DSH `tools/pre-execute` through `agent-hook --product dsh`, so
policy is evaluated by the shared Rust engine rather than repeated in prompts
or reimplemented in JavaScript. The probe tool remains deliberately small
while the remaining policy handlers and reviewer personas are migrated.

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
- Binds every successful policy evaluation to DSH's opaque execution token and
  consumes it in the host's monotonic tool guard. A prepended listener cannot
  short-circuit around policy evaluation and still execute the tool.
- Does not modify or vendor DeepSeek Harness.
- Contains no private skills. Project discovery remains DSH-native through
  `.dsh/skills` and `.agents/skills`.

Private discovery defaults to at most 32 directory levels, 10,000 entries,
4 MiB per regular file, and 32 MiB total. `privateSkillMaxDepth` and
`privateSkillMaxEntries` may lower those limits; hard ceilings are 64 and
20,000. Symlinks, non-regular entries, foreign ownership, and group- or
world-writable tree entries fail startup closed. The private loader is disabled
on Windows until equivalent ACL trust checks exist.

Policy checks default to a 5-second deadline and four active subprocesses.
`policyTimeoutMs` is capped at 30 seconds and `maxActivePolicyChecks` at 16.
There is deliberately no waiting queue: calls beyond the active ceiling fail
closed with `policy-overloaded`, and timed-out children retain their slot until
the subprocess actually settles.

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
project/private precedence, executes `runtime_kit_plus_one({ value: 41 })`,
observes `42`, then switches policy and proves DSH denies the tool before its
body runs.

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
