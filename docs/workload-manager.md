# Governed workload manager

`@sympoies/dsh-runtime-kit/manager` is the public runtime boundary for one
immutable bot generation and instance. It composes public composition with
admission, lifecycle, trust verification, mediated host effects, and typed
control frames. It does not install artifacts, retain private deployment
bindings, select traffic, own provider credentials, or coordinate rollout.

## Ownership boundary

The manager owns strict public schema readers, verifier-selected trust
bootstrap, exact admission-seal comparison, current assertion acceptance,
one immutable identity namespace, the per-instance mutation journal and state
machine, reconciliation/quarantine, and hash-linked lifecycle receipts.

The private deployment controller owns artifact staging, private bindings,
trust stores and acceptance CAS, service identities, rollout, traffic,
publisher epochs, update, rollback, and teardown. The GitHub broker alone owns
GitHub App credentials, target/head truth, provider idempotency, and publish
reconciliation. Plugins receive neither control-socket access nor private
binding state.

## Public operations

`createWorkloadManager` exposes exactly ten public operations:

| Operation | Purpose | Class |
| --- | --- | --- |
| `validate` | Validate public plugin/profile documents | read-only |
| `resolve` | Resolve one composition and sibling lock receipt | read-only |
| `lock` | Admit one immutable identity under a seal and assertion | mutating |
| `start` | Start the exact locked generation | mutating |
| `resume` | Restore retained same-generation state through `Starting` | mutating |
| `status` | Return bounded instance, health, resource, and receipt truth | read-only |
| `interrupt` | Cancel the current run while retaining state | mutating |
| `drain` | Fence new work and reconcile in-flight effects | mutating |
| `stop` | Stop only a durably drained instance | mutating |
| `doctor` | Check lock, seal, and complete receipt-chain consistency | read-only |

`reconcile` is an internal runtime-kit operation. It is available only to an
authenticated control peer with explicit reconcile authority. There is no
manager install, update, rollback, promote, route, publisher, teardown, or
cross-generation recovery operation.

The control service requires an explicit authenticated reconciliation-evidence
resolver. The resolver consumes the request's journal and DSH evidence digests;
its strict result is passed to the manager only after peer, operation,
namespace, and nonce checks. Omitting the resolver disables control-path
reconciliation rather than silently choosing quarantine.

## Lifecycle and recovery

The exported `LIFECYCLE_TRANSITIONS` and `RECONCILIATION_MATRIX` are the sole
runtime state oracle. Stop has no shortcut: a running or interrupted instance
must drain successfully first. Mutations serialize per exact namespace,
compare expected state and semantic request digest, and journal before effect.

Operation, immutable identity, idempotency key, and semantic request digest
form the replay identity. Exact replay returns the original result and never
repeats an effect. Lock, start, and resume replay first accepts a refreshed
current assertion without changing that identity; only the latest replay
acceptance digest is retained in the hot journal. Changed semantic bytes under
the same key fail with `idempotency-conflict`.

A successful start allocates one bounded, non-null DSH session identity. Resume
retains that same logical identity and refuses missing or substituted retained
state. Lock reports only its exact receipt; optional health degradation remains
observable through status rather than widening the lock success schema, and a
successful start refreshes that observation. A failed start retains the prior
observation.

An unknown effect retains the required transient state. Only `reconcile` may
resolve that journal. It uses the recorded source plus required transient and
terminal as the exhaustive candidates, then proves committed, proves not
committed, retains a temporary evidence outage, or writes one hash-linked
`InstanceQuarantineReceipt`. The same store can reopen after restart without
repeating the effect.

## Trust boundary

`createTrustVerifier` accepts only verifier-owned namespace bootstrap. It reads
one retained, paginated lineage observation and every digest-addressed bundle
needed by that snapshot. There is no global transition-count or cumulative-byte
cap; bounds apply to each transition, bundle, and datagram. Validation streams
one bounded page at a time, stages only new bundle and tombstone deltas, and
serializes refresh-plus-acceptance across verifiers sharing the same retained
namespace state.

Every edge checks prior/next digests, contiguous sequence, an active prior
`trust-transition` signer, immutable key material/use, irreversible states,
tombstones, the exact sorted bundle diff and retirement overlaps, controller
activation time, and the frozen Ed25519 signature message.

Before lock, start, resume, or mediated host effect, runtime-kit submits the
complete signed document to the infra-owned one-use acceptance CAS. A success
must correlate every request, document, key, bundle, operation, journal
revision, head, authority-time revision, and controller field. Lifecycle and
host adapters share one exhaustive trust-failure map and preserve authenticated
failure digests separately from success digests.

## Control and mediated effects

Manager request/response frames bind their complete strict payload under
independent digests and reject documents over 1 MiB before cloning or dispatch.
Result kinds are operation-specific, and each failure code admits only its
reviewed bounded details shape. The transport-neutral
`createManagerControlService` consumes an already authenticated peer identity,
then enforces exact operations, namespace prefixes, and a persistable uint64
connection-nonce high-water mark before dispatch.

Status correlates the authenticated current receipt head with instance state,
session, composition, and admission identity for its hot-path view; doctor adds
the complete genesis-to-head chain audit. Successful adapter effects are
normalized before terminal instance state is committed. Malformed post-effect
lifecycle evidence and invalid, mismatched, oversized, or unsafe effectful host
output/receipts remain indeterminate and require same-key reconciliation.

`createMediatedHostService` binds plugin, action, schemas, payload, target,
resource class, budget, state, publisher epoch, nonce, and idempotency key into
the asserted semantic digest. GitHub writes require `github-broker`; its receipt
must echo the manager-derived external idempotency token, so a receipt from
another effect fails closed.

Receipts and results are secret-free and non-bearer. Credential values, GitHub
App material, private paths, and binding locators stay in their private owners.

## Validation

```sh
npm run test:admission-isolation
npm run test:lifecycle-contracts
npm run test:control-boundary-contracts
```

Then run the repository aggregate, typecheck, package checks, and the pinned
DSH smoke required by repository policy.
