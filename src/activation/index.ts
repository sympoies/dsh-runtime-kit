import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DIGEST = /^[a-f0-9]{64}$/

export function activationSha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

const RULE_ID = /^dsh\.[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Validate a receipt-bound policy override map: rule id to the only downgrade
 * runtime-kit writes, `advise`. Returns a copy with sorted keys, or `undefined`
 * for an absent map. An empty map is rejected so "no overrides" has exactly
 * one spelling in every digest.
 */
export function validatePolicyOverrides(value: unknown): Record<string, 'advise'> | undefined  {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('policy overrides must be an object of rule id to "advise"')
  }
  const entries = Object.entries(value)
  if (entries.length === 0) throw new TypeError('policy overrides must name at least one rule')
  if (entries.length > 64) throw new TypeError('policy overrides name too many rules')
  const sorted: Record<string, 'advise'> = {}
  for (const [id, mode] of entries.sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (!RULE_ID.test(id)) throw new TypeError(`policy override names an invalid rule id: ${id}`)
    if (mode !== 'advise') throw new TypeError(`policy override for ${id} must be "advise"`)
    sorted[id] = 'advise'
  }
  return sorted
}

/**
 * Digest of an activation asset set. The override digest joins the set only
 * when overrides exist, so a target without overrides keeps the digest the
 * accepted baseline computed.
 */
export function assetSetSha256(assets: {catalog_sha256: string, document_sha256: string, policy_sha256: string, policy_overrides_sha256?: string}) {
  return activationSha256(JSON.stringify({
    catalog_sha256: assets.catalog_sha256,
    document_sha256: assets.document_sha256,
    policy_sha256: assets.policy_sha256,
    ...assets.policy_overrides_sha256 === undefined
      ? {}
      : { policy_overrides_sha256: assets.policy_overrides_sha256 },
  }))
}

export function policyOverridesSha256(overrides: Record<string, 'advise'>) {
  return activationSha256(JSON.stringify(validatePolicyOverrides(overrides)))
}

/**
 * Render the digest-bound agent-hook config. Overrides are the only mutable
 * input and they are part of the plan digest, the receipt, and the activation
 * manifest; nothing else may add an `[overrides]` table.
 */
export function renderAgentHookConfig(policyPath: string, policyDigest: string, overrides: Record<string, 'advise'> | undefined = undefined) {
  if (policyPath.includes('\0') || !isAbsolute(policyPath) || !DIGEST.test(policyDigest)) {
    throw new TypeError('agent-hook config requires an absolute policy path and exact digest')
  }
  const validated = validatePolicyOverrides(overrides)
  let text = `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(policyPath)}
digest = "sha256:${policyDigest}"
`
  for (const [id, mode] of Object.entries(validated ?? {})) {
    text += `\n[overrides.${JSON.stringify(id)}]\nmode = "${mode}"\n`
  }
  return text
}

function within(parent: string, child: string) {
  const fragment = relative(parent, child)
  return fragment === '' || (!fragment.startsWith(`..${sep}`) && fragment !== '..' && !isAbsolute(fragment))
}

function overlaps(left: string, right: string) {
  return within(left, right) || within(right, left)
}

function canonicalMaybe(path: string) {
  const absolute = resolve(path)
  let cursor = absolute
  const suffix = []
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse())
    } catch (error) {
      if (((error) as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) return absolute
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Resolve the current explicit and default provider-home topology. Preserve the
 * source labels as well as canonical paths so a reviewed recovery plan changes
 * when either the configured homes or their symlink topology changes.
 */
export function resolveProviderHomeTopology(environment: NodeJS.ProcessEnv = process.env) {
  const defaultHome = environment.HOME ?? homedir()
  return [
    ['codex-explicit', environment.CODEX_HOME],
    ['claude-explicit', environment.CLAUDE_CONFIG_DIR],
    ['codex-default', join(defaultHome, '.codex')],
    ['claude-default', join(defaultHome, '.claude')],
  ].flatMap(([source, path]) => (
    typeof path === 'string' && path.length > 0
      ? [{ source, path: canonicalMaybe(path) }]
      : []
  ))
}

/**
 * Canonicalize one DSH-owned root and reject every direct, nested, or aliased
 * overlap with explicit and default Codex or Claude homes.
 */
export function resolveProviderDisjointPath(value: unknown, label: string, environment: NodeJS.ProcessEnv = process.env) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${label} is required and must be an absolute path`)
  }
  const root = canonicalMaybe(value)
  const providerHomes = new Set(resolveProviderHomeTopology(environment).map(entry => entry.path))
  for (const providerHome of providerHomes) {
    if (overlaps(root, providerHome)) {
      throw new TypeError(`${label} must be disjoint from Codex and Claude runtime homes`)
    }
  }
  return root
}

function owned(path: string, kind: 'directory' | 'file', privateOnly: boolean = true) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new TypeError(`${path} must be a real ${kind}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new TypeError(`${path} must be owned by the current user`)
  }
  if ((stat.mode & (privateOnly ? 0o077 : 0o022)) !== 0) {
    throw new TypeError(`${path} must be an owner-only ${kind}`)
  }
  if (kind === 'file' && stat.nlink !== 1) {
    throw new TypeError(`${path} must have exactly one link`)
  }
  return stat
}

export function resolveActivationRoot(value: unknown, environment: NodeJS.ProcessEnv = process.env) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError('runtime root is required and must be an absolute path')
  }
  try {
    owned(value, 'directory')
  } catch (error) {
    if (((error) as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TypeError('runtime root must be a real directory')
    }
    throw error
  }
  return resolveProviderDisjointPath(realpathSync(value), 'runtime root', environment)
}

function record(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? ((value) as Record<string, any>)
    : undefined
}

function activationPath(root: string, relativePath: string, kind: 'directory'|'file') {
  if (relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new TypeError('activation paths must be relative')
  }
  const path = resolve(root, relativePath)
  if (path === root || !within(root, path)) {
    throw new TypeError('activation path escapes the runtime root')
  }
  const components = relative(root, path).split(sep)
  let cursor = root
  for (const [index, component] of components.entries()) {
    if (component === '' || component === '.' || component === '..') {
      throw new TypeError('activation paths must use canonical relative components')
    }
    cursor = join(cursor, component)
    owned(cursor, index === components.length - 1 ? kind : 'directory')
  }
  const exact = realpathSync(cursor)
  if (!within(root, exact)) throw new TypeError('activation path escapes the runtime root')
  return exact
}

function verifyDigest(path: string, expected: string, label: string) {
  if (!DIGEST.test(expected) || activationSha256(readFileSync(path)) !== expected) {
    throw new TypeError(`${label} digest does not match activation provenance`)
  }
}

export function readActivation(root: string) {
  const canonicalRoot = resolveActivationRoot(root)
  const activationPathname = activationPath(canonicalRoot, 'activation.json', 'file')
  let value
  try { value = JSON.parse(readFileSync(activationPathname, 'utf8')) } catch {
    throw new TypeError('activation manifest must be valid JSON')
  }
  const activation = record(value)
  const hook = record(activation?.agent_hook)
  const docs = record(activation?.agent_docs)
  const assets = record(activation?.assets)
  if (activation?.schema_version !== 'dsh-runtime-kit.activation.v1'
    || typeof activation.profile !== 'string'
    || typeof activation.package_version !== 'string'
    || !DIGEST.test(activation.package_artifact_sha256)
    || !DIGEST.test(activation.package_installed_sha256)
    || !DIGEST.test(activation.asset_set_sha256)
    || hook === undefined || docs === undefined || assets === undefined
    || typeof hook.config !== 'string' || typeof hook.policy !== 'string'
    || hook.state !== 'state/agent-hook'
    || typeof docs.home !== 'string' || docs.state !== 'state/agent-docs'
    || !DIGEST.test(assets.policy_sha256)
    || !DIGEST.test(assets.catalog_sha256)
    || !DIGEST.test(assets.document_sha256)
    || (assets.policy_overrides_sha256 !== undefined && !DIGEST.test(assets.policy_overrides_sha256))
    || (activation.policy_overrides === undefined) !== (assets.policy_overrides_sha256 === undefined)) {
    throw new TypeError('activation manifest has an incompatible contract')
  }
  let overrides: Record<string, 'advise'> | undefined
  try {
    overrides = validatePolicyOverrides(activation.policy_overrides)
  } catch {
    throw new TypeError('activation manifest carries invalid policy overrides')
  }
  if (overrides !== undefined && policyOverridesSha256(overrides) !== assets.policy_overrides_sha256) {
    throw new TypeError('activation policy overrides do not match their digest')
  }
  const assetRoot = `assets/${activation.asset_set_sha256}`
  if (hook.config !== `${assetRoot}/agent-hook/config.toml`
    || hook.policy !== `${assetRoot}/agent-hook/policy.toml`
    || docs.home !== `${assetRoot}/agent-docs`) {
    throw new TypeError('activation manifest paths do not match its versioned asset set')
  }
  const assetSetRoot = activationPath(canonicalRoot, assetRoot, 'directory')
  const hookAssets = activationPath(canonicalRoot, `${assetRoot}/agent-hook`, 'directory')
  const config = activationPath(canonicalRoot, hook.config, 'file')
  const policy = activationPath(canonicalRoot, hook.policy, 'file')
  const hookState = activationPath(canonicalRoot, hook.state, 'directory')
  const docsHome = activationPath(canonicalRoot, docs.home, 'directory')
  const docsState = activationPath(canonicalRoot, docs.state, 'directory')
  const catalog = activationPath(canonicalRoot, `${docs.home}/AGENT_DOCS.toml`, 'file')
  const document = activationPath(canonicalRoot, `${docs.home}/PROJECT_DEV_EDIT.md`, 'file')
  for (const path of [hookAssets, config, policy, docsHome, catalog, document]) {
    if (!within(assetSetRoot, path)) {
      throw new TypeError('activation asset path must remain contained in its versioned asset set')
    }
  }
  if (!within(hookAssets, config) || !within(hookAssets, policy)
    || !within(docsHome, catalog) || !within(docsHome, document)) {
    throw new TypeError('activation asset leaf does not match its trusted directory')
  }
  const assetSurfaces = [assetSetRoot, hookAssets, docsHome]
  const stateSurfaces = [hookState, docsState]
  if (assetSurfaces.some(asset => stateSurfaces.some(state => overlaps(asset, state)))
    || overlaps(hookState, docsState)) {
    throw new TypeError('activation assets and mutable state roots must be disjoint')
  }
  verifyDigest(policy, assets.policy_sha256, 'policy')
  verifyDigest(catalog, assets.catalog_sha256, 'agent-docs catalog')
  verifyDigest(document, assets.document_sha256, 'agent-docs document')
  const expectedSet = assetSetSha256({
    catalog_sha256: assets.catalog_sha256,
    document_sha256: assets.document_sha256,
    policy_sha256: assets.policy_sha256,
    ...assets.policy_overrides_sha256 === undefined
      ? {}
      : { policy_overrides_sha256: ((assets.policy_overrides_sha256) as string) },
  })
  if (expectedSet !== activation.asset_set_sha256) {
    throw new TypeError('activation asset-set digest does not match its members')
  }
  const configText = readFileSync(config, 'utf8')
  if (configText !== renderAgentHookConfig(policy, assets.policy_sha256, overrides)) {
    throw new TypeError('agent-hook config does not bind the activated policy')
  }
  return {
    manifest: activation,
    environment: {
      DSH_RUNTIME_KIT_RUNTIME_ROOT: canonicalRoot,
      DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: config,
      DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: policy,
      DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: hookState,
      DSH_RUNTIME_KIT_AGENT_DOCS_HOME: docsHome,
      DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: docsState,
    },
  }
}
