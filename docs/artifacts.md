# Session-owned artifacts

`dsh-runtime-kit` owns one native DSH artifact service, `dshRuntimeArtifacts`,
for generated, non-conversational outputs: reports, structured evidence,
recordings, archives, and other files a tool produces for a session. Tools and
bundles exchange opaque references instead of host paths, and the host enforces
ownership, limits, retention, and export semantics.

The service is runtime-kit-owned native code loaded through the public DSH
bundle. It uses only released public seams: Cordis service registration, the
DSH tool registry with per-call agent identity, the `agent/session-start` and
`agent/disposed` lifecycle events, live-agent attestation through
`ctx.agents`, the sandbox policy service, and the accepted protected-root
seam. It replaces no DSH file and adds no DSH source patch. Released DSH image
attachments (`ctx.attachments`) and text spill (`ctx.spillStore`) are
unchanged; images stored through this service are opaque artifacts and are not
presented as image blocks.

## References, identity, and metadata

- A reference is an opaque, non-bearer string `artifact:<32 lowercase hex>`.
  It never encodes a path, digest, or session and grants nothing on its own.
- Content identity is a separate immutable `sha256:<hex>` verified on every
  read and export.
- Every record carries bounded metadata: owner session id, workspace digest
  (SHA-256 of the canonical session cwd, or `unmanaged`), producer tool, media
  type, exact byte length, service generation, ISO-8601 creation time,
  retention class, expiry, and an optional path-stripped display name.
- Metadata never contains a storage location. Tool renderings, receipts, and
  audit output carry codes and identities only.

## Authorization

Every capability is authorized from the exact live `exec.agent` of the tool
call. The agent must still be registered with `ctx.agents`, and the record's
owner session id and workspace digest must match the caller's session. A
reference copied into another session or another workspace, an unregistered
or disposed agent, or a call without an executing agent yields
`ARTIFACT_ACCESS_DENIED` before any byte is read.

After a host restart, references are non-authoritative: the provider reloads
the durable record, validates its schema, and verifies the object (presence,
regular file, single hard link, size, and digest) before any use. Malformed
records yield `ARTIFACT_METADATA_INVALID`; tampered, replaced, symlinked, or
hard-link-substituted objects yield `ARTIFACT_CORRUPT`.

## Tools

The five tools are distinct capabilities and accept exact argument sets.

| Tool | Arguments | Result |
| --- | --- | --- |
| `artifact_write` | `media_type`, `content`, optional `name`, `encoding` (`utf8` default or `base64`), `retention` (`session` default or `retained`) | the record projection with `ref`, `sha256`, `bytes`, and metadata |
| `artifact_present` | `ref` | the record projection, provider capabilities, and a bounded UTF-8 preview for text and JSON media |
| `artifact_read` | `ref` | bounded content; UTF-8 for text media, base64 otherwise; larger artifacts return `ARTIFACT_READ_TOO_LARGE` |
| `artifact_export` | `ref`, `destination: { class: 'workspace', path }` or `{ class: 'download' }` | a `dsh-runtime-kit.artifact-export-receipt.v1` receipt |
| `artifact_dispose` | `ref` | `{ ref, outcome: 'disposed' }`; a repeated call reports `ARTIFACT_NOT_FOUND` |

`download` is an enumerated capability the v1 local provider does not support;
it returns `ARTIFACT_CAPABILITY_UNSUPPORTED` and never falls back to another
capability.

## Streaming writes

The service API (`openWriter`) stages bytes into an `O_CREAT|O_EXCL` 0600 file
under the 0700 store root and enforces the per-artifact byte limit and the
per-session quota while streaming. `commit` syncs the staging file, computes
the digest, publishes content-addressed bytes by hard link (verifying an
existing identical object before trusting it), syncs the directories, then
atomically publishes the index record. Interrupted, cancelled, over-limit, and
failed writes remove the staging file and publish nothing; no partial artifact
is ever readable. Commits, disposals, and quota accounting are serialized so
counts stay exact under concurrent writers.

## Retention and lifecycle

- `session` artifacts are reclaimed when the owner agent is disposed, on
  explicit disposal, or at expiry (default 24 hours).
- `retained` artifacts are reclaimed on explicit disposal or at expiry
  (default 7 days).
- Reclamation touches only records owned by the target lifecycle. Expiry is
  enforced lazily on access and by a bounded sweep at service start.
- Content shared by several live records stays on disk until the last owner is
  disposed.

## Export

`workspace` export writes a new file at a workspace-relative path inside the
session's canonical cwd. The path must not be absolute, must not contain empty,
`.`, `..`, control, or backslash segments, may not cross a symbolic link, and
may not overwrite an existing entry. The deny set is the union of the
configured `protectedRoots`, the artifact store root, and every protected root
the host sandbox policy resolves for the session, so export can never write
where the DSH file sandbox denies other tools; relative roots resolve against
the workspace. Export is denied under a `read-only` sandbox mode and for
sessions without a cwd. After the destination is created with `O_EXCL`, the
service proves the created entry is the exact lexical destination (same inode,
no symbolic link, canonical path unchanged) before writing, so an ancestor
swapped for a symbolic link between the check and the open leaves only an
empty file that is removed. Bytes are digest-verified before the write and
read back after it. The receipt binds reference, exact digest, byte length,
media type, destination class, workspace-relative destination, owner session,
generation, and timestamp; it never reveals the backing location. Failure
messages retain at most an errno code; raw filesystem errors carrying store
paths are never attached as causes.

## Store, limits, and configuration

The local provider keeps `tmp/`, `objects/<aa>/<sha256>`, and
`index/<id>.json` below one owner-private 0700 root that is registered as a
DSH protected root. The root defaults to `dsh-runtime-kit/artifacts/v1` below
the DSH home (`DSH_HOME`, else `~/.dsh`); `artifactsRoot` or
`DSH_RUNTIME_KIT_ARTIFACTS_ROOT` accepts an absolute override. A root that is
a symbolic link, not private, or not owned by the current user fails closed
with `ARTIFACT_PROVIDER_UNAVAILABLE`.

| Config | Default | Hard maximum |
| --- | --- | --- |
| `artifactMaxBytes` | 64 MiB | 1 GiB |
| `artifactSessionQuotaBytes` | 256 MiB | 8 GiB |
| `artifactSessionMaxCount` | 256 | 4096 |
| `artifactReadMaxBytes` | 256 KiB | 16 MiB |
| `artifactPreviewMaxBytes` | 4 KiB | 64 KiB |
| `artifactSessionTtlMs` | 24 hours | 30 days |
| `artifactRetainedTtlMs` | 7 days | 365 days |

## Typed outcomes

`ARTIFACT_ARGUMENT_INVALID`, `ARTIFACT_REF_INVALID`, `ARTIFACT_ACCESS_DENIED`,
`ARTIFACT_NOT_FOUND`, `ARTIFACT_EXPIRED`, `ARTIFACT_TOO_LARGE`,
`ARTIFACT_QUOTA_EXCEEDED`, `ARTIFACT_WRITE_FAILED`, `ARTIFACT_ABORTED`,
`ARTIFACT_CORRUPT`, `ARTIFACT_METADATA_INVALID`,
`ARTIFACT_PROVIDER_UNAVAILABLE`, `ARTIFACT_CAPABILITY_UNSUPPORTED`,
`ARTIFACT_READ_TOO_LARGE`, `ARTIFACT_EXPORT_DESTINATION_INVALID`,
`ARTIFACT_EXPORT_DENIED`, and `ARTIFACT_EXPORT_EXISTS` are raised as DSH
`HarnessError` codes. Every failure message is also prefixed with its code, so
the exact typed outcome reaches the model and receipts even when the host
cannot attribute the bundle's error class instance.

## Providers

`LocalArtifactProvider` is the shipped filesystem provider. A deterministic
in-memory provider implements the same contract for conformance and fault
injection. Any future remote provider must satisfy the same lifecycle suite; a
general object-storage product or provider upload workflow is out of scope.

## Boundaries

- The service never asks the model to reconstruct host facts, manufacture
  receipts, or hold a lease; identity comes from the DSH tool execution.
- Repository-tracked files and session transcript persistence are not
  artifacts.
- nils-cli receives no artifact lifecycle; digest, path-safety, and receipt
  validation stay in-process.
