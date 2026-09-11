---
name: project-runtime-development
description: >
  Develop, diagnose, test, and deliver dsh-runtime-kit changes through the
  earliest independently observable validation layer, then strengthen the
  owning regression or diagnostic when acceptance exposes a reusable gap.
allowed-tools: Bash, Read, Edit, Write
---

# Project Runtime Development

Use the repository's canonical
[layered development and testing policy](../../../docs/development-testing.md)
for material runtime-kit behavior, compatibility, packaging, operations,
acceptance, and development-policy work. The skill applies that policy; it does
not duplicate or override it.

## Contract

Before editing, produce a small validation map containing:

- observable delta and retained invariants;
- earliest proving layer and canonical owner;
- focused command or bounded manual step;
- expected secret-safe receipt and permitted side effects;
- exact identities required by later layers;
- receipts invalidated by the change and outer layers actually required by the
  observable delta or owning issue.

Capture the earliest meaningful failing owner test when practical. Iterate at
that layer. Freeze the candidate before the routine gate or external harness,
and run each declared full validation once. The output is a reviewable change,
layer-specific evidence, explicit residual gaps, and a statement of which
outer layers ran or remained current.

Stop before a mutation when target, identity, authority, clean-room state, or
prior-layer evidence cannot be proved.

## Workflow

1. Read `docs/development-testing.md`; do not work from this summary alone.
2. Inspect the affected owner, consumers, tests, manifests, package inventory,
   and runtime boundary. Write the validation map before changing production
   files.
3. Add or select the focused owner regression and capture RED evidence, or
   record the substitute validation. Repair only the owning contract.
4. Advance in order only through the declared required layers, starting at the
   earliest one. Invalidation prevents reuse of a stale receipt; it does not by
   itself require an otherwise out-of-scope outer layer. Record omitted
   invalidated layers and why they are not required. Do not compensate for a
   lower-layer gap with a retry, wait, prompt, or assertion in a higher E2E
   layer.
5. Treat authenticated tool identity, role, permission mode, expected
   induction, build provenance, executable role, installed-tree identity, and
   external observable-state attestation as distinct contracts. Bind a
   deliberate failure to its family's declared code and the correlated exact
   probe call; reject matching JSON from process/model output, unrelated tools,
   or another family. When a launcher has both an unactivated fallback and an
   activation manifest, require one owner assertion that their
   `DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR` values agree while config and policy
   move only through their declared authenticated-asset transition.
6. When a clean DSH profile needs multiple profile bundles, install them in one
   transaction and assert the manifest tuple before any package repair or
   configuration dump. Split transactions only when the intermediate tree is
   itself the tested contract and has its own receipt.
7. Before real-provider work, bind the exact package and catalog SHA-256, DSH
   and patch revision, provider/model/effort, harness contract, profile, and
   approved side effects. Give the external harness no human diagnosis hint.
8. On `usage_limit_reached` or another typed entitlement failure, keep the
   candidate frozen and stop. Wait for reset or separately authorized access;
   do not switch provider or model.
9. Reuse a matrix prefix only under the canonical same-digest rule. Cite the
   prior run and independent attestations; otherwise restart the invalidated
   portion.
10. If a generic failure occurs, the same layer fails again without new
   evidence, or a missing primitive has another owner, stop and replan. Route
   `nils-cli` workflow contracts to `sympoies/nils-cli`, runtime-kit contracts
   here, public application semantics to `dsh-applications`, DSH-native agent
   behavior to DSH, and hosted promotion to `sympoies-infra`.
11. Run the routine repository gate once on the stable candidate. Perform
    hosted promotion only when the owning issue requires it, and never call a
    local rehearsal final promotion.

## Self-improvement loop

When work exposes repeatable friction, record the symptom, first bounded
receipt, earliest layer that should have caught it, missing diagnostic or
primitive, canonical owner, and focused regression. Fix the owner when the
active task authorizes it. Update the canonical policy or this skill only when
the lesson applies to future runtime-kit work; keep one incident's chronology
and identities in its issue and devlog.

A generic acceptance failure is itself a diagnostic defect when materially
different stages share it. Improve the owner receipt first, prove it with an
owner regression, and only then resume the outer matrix. Do not run duplicate
full suites concurrently while investigating.

Before delivery, ask:

- Did the new failure gain an earlier deterministic owner assertion?
- Does its receipt name a stable stage/code and preserve secrets?
- Does the policy now tell a future agent when to stop, resume, or invalidate
  evidence?
- Is the lesson general enough for normative policy/skill text, or does it
  belong only in the issue/devlog?

## Boundary

This skill coordinates development decisions inside
`sympoies/dsh-runtime-kit`. It does not grant deployment, provider, credential,
issue-write, cross-repository, release, merge, or hosted-run authority, and it
does not create a policy engine, agent loop, provider adapter, or acceptance
implementation. Preserve the user's active scope and all governed delivery,
signing, lease, trust, and cleanup controls.
