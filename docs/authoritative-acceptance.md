# Authoritative completion acceptance

Runtime-kit provides `ctx.dshAcceptance` as the DSH host adapter for nils-cli's
durable finish-line acceptance provider. It is inert until a trusted consumer
registers one complete contract. A deployment with no registration keeps the
released turn-stop and GoalService behavior unchanged.

## Register a contract

Registration uses exact visible DSH `ToolDefinition` objects, not names copied
from configuration. A trusted plugin should inject `dshAcceptance` and `tools`,
resolve its definitions from the live registry, and register once:

```js
const check = ctx.tools.get('project_check')
const edit = ctx.tools.get('edit')

const dispose = ctx.dshAcceptance.register({
  requirements: [{
    name: 'project',
    validators: [{
      id: 'project-check',
      definition: check,
      execution: { kind: 'host-observed' },
    }],
  }],
  invalidators: [edit],
})
```

The registration is immutable. Requirement names and validator IDs must be
unique in their scopes. Runtime-kit hashes the public execution-relevant tool
schema and rechecks exact in-process definition identity and schema at
admission, result, verdict, and synchronous completion. A changed definition,
ambiguous binding, conflicting invalidator, or different second registration
fails closed. Registration is process-lifetime immutable. The returned disposer
releases only the registering provider's ownership; it cannot unregister the
contract or erase live authority. A different contract remains rejected until
the coordinator itself is disposed.

A validator can instead cite an exact contained Bash target:

```js
{
  id: 'package-check',
  definition: ctx.tools.get('bash'),
  execution: {
    kind: 'contained-bash',
    intent: 'project-dev',
    command: 'npm test',
  },
}
```

Several contained targets may share the one visible Bash definition when each
intent-and-command pair is unique. Runtime-kit selects a validator only from
the private, single-use source reservation produced by the existing nils
finish-line probe. Ordinary Bash is not misclassified as a validator: it stays
under the contained executor, advances the same durable repository generation,
and creates no validation evidence.

## Lifecycle and verdict ownership

Runtime-kit binds registration, admission, terminal observation, verdict
refresh, turn stop, agent disposal, provider disposal, cancellation, and
restart to the exact Agent, Session, workspace, tool object, call, and runner
capability. Mutation admission advances the nils-owned generation before the
tool body. A non-shell validator is terminalized only from DSH's final
`tools/result`; a contained Bash validator cites nils' observed execution facts
instead of a caller-supplied status.

The provider verdict has deterministic `satisfied`, `missing`, `failed`,
`active`, `uncertain`, or `infrastructure-blocked` requirement states. Only an
all-`satisfied` verdict allows completion. Runtime-kit retries one ambiguous
provider transport failure with the exact semantic request; continued failure,
malformed correlation, cancellation, crash, or unproven quiescence poisons the
session closed. Registration, admission, terminal observation, and verdict are
control-plane RPCs: one bounded finish-line teardown deadline spans the initial
attempt and its idempotent retry, and coordinator disposal aborts that shared
deadline instead of starting another validation-length wait. In-flight
registration is joined before agent capability release, and registration plus
completion-consumption tasks remain visible in the exported active-resource
count until they quiesce.

`agent/turn-stopping` refreshes this verdict and atomically reserves completion
under nils' repository lock before the older lifecycle policy. The
reservation blocks structured mutations and ordinary Bash in every session
and process until the synchronous goal assertion consumes it. Runtime-kit
claims that consumption synchronously before starting its provider observation;
a same-repository mutation can therefore contend at nils but cannot cancel the
already-claimed completion operation. Runtime-kit
partitions local mutation state by the exact canonical Git-root `cwd` already
authenticated by nils, invalidates every cache for that repository before
mutation admission, rejects out-of-order provider responses, and joins
in-flight admissions during disposal. Unrelated canonical repositories in one
DSH process do not revoke each other's cached authority. A detached
all-satisfied read without the exact live reservation is never sufficient for
goal completion.

When acceptance allows, runtime-kit does not ask the superseded legacy stop
evaluator for a contradictory second verdict. It keeps the exact shared
finish-line capability alive through the synchronous GoalService assertion,
records successful reservation consumption with that capability, and releases
only after the provider accepts that terminal observation. A later lifecycle
policy denial first cancels the reservation and keeps the session capability
available for retry. When acceptance blocks, the agent receives bounded
remediation and remains active.

After the synchronous assertion, `completionSettlement(agent)` exposes only a
bounded lifecycle status. `succeeded` means both the provider observation and
capability release completed; a failed observation or release reports `failed`
and poisons the verdict `infrastructure-blocked`. Operation IDs, capabilities,
generations, and diagnostics remain private. Resource counters reaching zero
is not proof of success: the packed canary accepts completion only when this
status is `succeeded` and the finish-line transport is not degraded.
Reservation cancellation uses the same joined task owner: it remains
resource-visible as `cancelling`, terminalizes as `cancelled`, and preserves a
provider rejection to the awaiting lifecycle caller. Agent and coordinator
disposal cannot pass that task or allow a validator admission to resume after
the runtime closes.

The authenticated DSH patch adds one optional synchronous call immediately
before `GoalService.complete()` mutates goal state. Runtime-kit consumes the
exact cached provider reservation in that synchronous call, marks it
non-cancellable locally, then terminalizes
the reservation asynchronously with the same still-live capability after the
DSH mutation stack returns. Missing, active, stale, unreserved, or poisoned
state throws `DshAcceptanceBlockedError` with code `DSH_ACCEPTANCE_BLOCKED`;
the goal revision and session events remain unchanged.

## Persistence and rollback

Nils owns the authoritative sidecar under its existing finish-line lock.
Runtime-kit never reconstructs generations or success from model text, tool
output, Git state, or session events. Its DSH session projection is diagnostic
only: it folds standard `tool/call` and `tool/result` events and exposes a
bounded active count plus the last sanitized operation. It stores no arguments,
output, capability, operation ID, generation, or verdict.

Using only standard events is intentional. An older unpatched DSH build can
read the same session during rollback; nils-cli 1.27.9 ignores the newer
sidecar but sees the advanced finish-line generation and therefore remains
fail closed. A source reverse receipt is not sufficient rollback evidence:
rebuild the pristine DSH host libraries and smoke the unpatched process.

## Candidate dependency

The implementation currently integrates the exact reviewed nils-cli PR #1507
head recorded in `compatibility/nils-cli.json`. The released compatibility row
remains nils-cli 1.27.14; it does not include the candidate acceptance provider
until that change is merged, released, and independently authenticated.
Registering an acceptance contract against a
nils build without these RPCs fails closed; leaving the service unregistered
preserves the released deployment.
