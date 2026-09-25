import { DshCompatibilityError, validateDshCompatibilityManifest } from './contract.js'

export type DshPeerReceiptPackage = {
  name: string
  version: string
  path: string
  tarball_sha256: string
  artifact_sha256: string
}

/** Bind both current and legacy pristine receipts to one reviewed peer closure. */
export function inspectDshPeerReceiptIdentity(
  input: unknown,
  manifest: ReturnType<typeof validateDshCompatibilityManifest>,
  reviewedPatchId: string,
) {
  const receipt = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, any> : {}
  const data = receipt.data !== null && typeof receipt.data === 'object' && !Array.isArray(receipt.data)
    ? receipt.data as Record<string, any> : {}
  const channel = data.channel
  const patchState = data.patch_state ?? 'pristine'
  const patchId = data.patch_id ?? null
  if (receipt.schema_version !== 'dsh-runtime-kit.dsh-peer-pack.v1'
    || receipt.ok !== true
    || !['pinned', 'upstream-next'].includes(channel)
    || data.revision !== manifest.channels[channel]?.revision
    || !['pristine', 'patched'].includes(patchState)
    || data.upstream_checkout_clean !== (patchState === 'pristine')
    || patchId !== (patchState === 'patched' ? reviewedPatchId : null)
    || !Array.isArray(data.packages)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'DSH peer receipt identity is invalid',
    )
  }
  const expectedNames = Object.keys(manifest.workspace_artifacts).sort()
  const actualNames = data.packages.map((item: DshPeerReceiptPackage | null | undefined) => item?.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'DSH peer receipt does not contain the exact authenticated closure',
    )
  }
  return {
    channel: channel as 'pinned' | 'upstream-next',
    revision: data.revision as string,
    patchState: patchState as 'pristine' | 'patched',
    patchId: patchId as string | null,
    packages: data.packages as DshPeerReceiptPackage[],
  }
}
