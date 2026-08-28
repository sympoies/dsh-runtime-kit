# Composition contracts

The `@sympoies/dsh-runtime-kit/composition` export is the public governance
boundary for resolving reusable plugin descriptors and bot profiles into an
exact, secret-free composition. It does not discover or install packages,
start DSH, process triggers, hold provider credentials, or manage a fleet.

## Public documents

Every document uses byte-exact `apiVersion: runtime.sympoies.dev/v1`, rejects
unknown fields, and carries one of these kinds:

| Kind | Purpose | Self-digest field |
| --- | --- | --- |
| `PluginDescriptor` | Immutable package identity, compatibility, requested capabilities/actions, mediation, health, composition, and lifecycle declarations | `metadata.digest` |
| `BotProfile` | Workload purpose, selected plugins, public grants, artifacts, state, trigger, execution, approval, and limit policy | `metadata.digest` |
| `ResolvedComposition` | Deterministic public result containing exact runtime/profile/plugin identities and the public authority ceiling | `metadata.digest` |
| `CompositionLockReceipt` | Non-bearer sibling receipt binding the resolved composition and every public resolution-input digest | `digest` |

The lock topology is deliberately acyclic. `ResolvedComposition` contains no
receipt or receipt digest. `CompositionLockReceipt` points to the completed
resolved-composition digest, and later private deployment records use the
receipt digest as the public composition-lock identity.

## Canonicalization and versions

Document digests use UTF-8 RFC 8785 JCS bytes with duplicate input keys,
unpaired Unicode surrogates, non-finite numbers, negative zero, accessors,
symbols, array holes, and non-JSON properties rejected. The digest preimage is:

```text
ASCII(domain-tag) || 0x00 || JCS(document-with-self-digest-removed)
```

The four document tags are `sympoies/plugin-descriptor/v1`,
`sympoies/bot-profile/v1`, `sympoies/resolved-composition/v1`, and
`sympoies/composition-lock-receipt/v1`. Catalog snapshots, public policy
ceilings, and effective public authority use the independent tags
`sympoies/plugin-catalog-snapshot/v1`,
`sympoies/public-policy-ceiling/v1`, and
`sympoies/public-effective-authority/v1`.

Exact versions use SemVer 2.0.0 without a leading `v`. Ranges accept only `*`
or explicit `<`, `<=`, `=`, `>=`, and `>` comparators separated by one space;
OR sets use exactly ` || `. Descriptor/profile writers must use the normalized
comparator order returned by `parseVersionRange`.

The v1 schemas are immutable. `selectCompositionApiVersion` chooses the oldest
mutually supported schema for a new lock, refuses deprecated writers, and
retains an explicitly supplied readable `priorLockApiVersion` without silently
downgrading it.

## Manager-facing protocol

```js
import {
  computeCatalogSnapshotDigest,
  createCompositionService,
} from '@sympoies/dsh-runtime-kit/composition'

const service = createCompositionService({
  validatorVersion: '1.0.0',
  resolverVersion: '1.0.0',
  resolvePublicPolicy: digest => authenticatedPolicyOwner.getByDigest(digest),
})

const validation = service.validate({
  apiVersion: 'runtime.sympoies.dev/v1',
  kind: 'ValidateCompositionRequest',
  requestId: 'validate-42',
  descriptors: pluginDescriptors,
  profile,
  readerSchemas,
  runtime: { dshVersion, runtimeKitVersion, pluginApiVersion, platform },
})

if (validation.kind === 'ValidateCompositionSucceeded') {
  const resolution = service.resolve({
    apiVersion: 'runtime.sympoies.dev/v1',
    kind: 'ResolveCompositionRequest',
    requestId: 'resolve-42',
    validatedDocumentDigests: {
      profile: validation.profileDigest,
      descriptors: validation.descriptorDigests,
    },
    catalogSnapshotDigest: computeCatalogSnapshotDigest(pluginDescriptors),
    runtime: { dshVersion, runtimeKitVersion, pluginApiVersion, platform },
    publicPolicyCeilingDigest: publicPolicyDigest,
  })
  if (resolution.kind === 'ResolveCompositionSucceeded') {
    useLock(resolution.resolvedComposition, resolution.compositionLockReceipt)
  }
}
```

`composition.validate` and `composition.resolve` are strict, read-only ports.
They detach request bytes, reject unknown fields, and return one exact success
or failure kind instead of throwing contract failures across the manager
boundary. The canonical request representation is capped at 8 MiB, 64 levels,
and 100,000 JSON nodes; byte accounting happens before the detached canonical
copy is materialized. Resolve accepts only document digests previously
validated by the same service and runtime identity. Its policy input is only a
digest; the service obtains the policy body from its authenticated policy-owner
adapter and verifies that body against the requested digest. Request bytes
therefore cannot replace or widen policy authority.

Resolution verifies the exact catalog snapshot and searches for a globally
valid selection with deterministic bounded backtracking. Candidate versions
remain highest-first, while the next unresolved plugin is the one with the
fewest viable candidates (plugin ID breaks ties). Version-dependent conflicts,
namespace claims, dependency and ordering cycles, authority ceilings, resource
ceilings, and required health are evaluated as part of each complete candidate
selection, so an invalid newer version can fall back to an older valid version.
Unique candidates and their required/optional dependency closure are propagated
incrementally; branching starts only after those forced choices converge. The
search fails closed after 4,096 states or 25,000 charged work units instead of
permitting combinatorial runtime growth.

A low-level catalog is capped at 1,024 descriptors before any element is read.
A required dependency is selected transitively. An optional dependency may be
absent; if another selection makes it present, its declared range must match and
its dependency-order edge applies. The immutable v1 model is singleton per
plugin ID: `cardinality.max` is exactly `1`; multi-instance plugins require a
later API version.
Every requested plugin or action capability must be present in both profile
grants and the authenticated public policy. Network, workspace, resource, and
required-health declarations also fail closed when their ceiling or provider is
missing. Installation declarations such as provided capabilities, tools,
skills, and services never grant authority.

The exported schema, canonicalization, digest, and document validators are
in-process utilities. `resolveComposition` is a low-level deterministic builder
for trusted callers and contract tests; it is not the manager wire protocol and
does not authenticate a policy owner. It additionally supports typed
compare-and-set re-resolution by requiring `priorLock` and
`expectedPriorLockDigest` together. Manager integrations must use
`createCompositionService`.

## Stable result kinds and failure codes

The public protocol returns exactly these kinds:

| Operation | Success | Failure |
| --- | --- | --- |
| validate | `ValidateCompositionSucceeded` | `ValidateCompositionFailed` |
| resolve | `ResolveCompositionSucceeded` | `ResolveCompositionFailed` |

The v1 validate-success `warningCodes` vocabulary is empty. A non-empty list is
an unsupported enum extension and fails closed.

Validate failures use exactly `invalid-request`, `unsupported-api-version`,
`unsupported-kind`, `schema-invalid`, `unknown-field`, `version-invalid`,
`digest-invalid`, `secret-shaped-value`, or `compatibility-unsupported`.
Resolve failures use exactly `invalid-request`, `input-not-validated`,
`catalog-digest-mismatch`, `version-range-unsatisfied`,
`dependency-unsatisfied`, `dependency-cycle`, `conflict`,
`capability-overgrant`, `policy-denied`, or `digest-invalid`.

`validateCompositionProtocolResult` checks both unions, including exact fields,
the exhaustive code vocabulary, immutable sibling digests, dependency order,
effective-authority digest, and resolver identity. Internal document utilities
throw `CompositionContractError`; their larger stable code inventory is exported
as `COMPOSITION_CONTRACT_ERROR_CODES`. Manager code must branch only on the
public union code. `COMPOSITION_RESOLVE_ERROR_MAP` freezes the intentional
internal-to-public translations for resolve, and
`COMPOSITION_VALIDATE_ERROR_MAP` does the same for validate. Both maps are total
over `COMPOSITION_CONTRACT_ERROR_CODES`, so a new internal failure cannot
silently collapse into a public code.

## Trust boundary

Descriptors declare requests; discovery and installation grant no authority.
The public authority ceiling is only the intersection of plugin requirements,
profile grants, and public runtime policy. A private deployment may narrow that
ceiling later but may not widen it.

Public documents and receipts contain no deployment, host, service, repository,
channel, installation, credential, generation, instance, traffic, publisher,
secret locator, or private binding state. Private artifact verification,
deployment binding, admission seals, rollout, traffic, and provider identity
belong to the infrastructure controller. Workload admission, namespace
isolation, scoped health, and per-instance lifecycle receipts are separate
runtime services and are not implied by successful composition resolution.

All in-process contract failures are `CompositionContractError` values with a
stable `code`, bounded message, and secret-free `details`. Callers must branch
on `code`, not message text.
