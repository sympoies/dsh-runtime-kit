import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

export interface DshHistoryModuleResolver {
  /** Absolute entry path of `specifier` inside the profile's installed closure. */
  resolve(specifier: string): string
  /** Installed version of `packageName`, or `undefined` when the closure lacks it. */
  packageVersion(packageName: string): string | undefined
}

type Require = ReturnType<typeof createRequire>

function tryResolve(require: Require, specifier: string): string | undefined {
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * Resolve DSH history packages the way an installed profile reaches them: from
 * the profile's own hoisted dependencies, then the DSH installation it boots,
 * then each bundle named in `dsh.profile.bundles`. DSH carries its session
 * persistence backend inside the base bundle, so the history adapter reads the
 * store through the exact backend that profile writes with rather than through
 * whatever copy happens to sit next to the runtime-kit package.
 */
export function createDshHistoryModuleResolver(profileRoot: string): DshHistoryModuleResolver {
  if (!isAbsolute(profileRoot)) throw new Error('DSH history profile root must be absolute')
  const manifestPath = join(profileRoot, 'package.json')
  if (!existsSync(manifestPath)) throw new Error('DSH history profile root has no package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const profile = createRequire(manifestPath)
  const scopes: Require[] = [profile]
  const installation = tryResolve(profile, '@deepseek-ai/dsh/package.json')
  if (installation !== undefined) scopes.push(createRequire(installation))
  // Bundles are named by the profile and installed beside it or its DSH
  // installation; one bundle's own dependencies never supply another bundle.
  const bundleRoots: readonly Require[] = [...scopes]
  const bundles = manifest.dsh?.profile?.bundles
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (typeof bundle !== 'string') continue
    const bundleManifest = bundleRoots
      .map(scope => tryResolve(scope, `${bundle}/package.json`))
      .find(path => path !== undefined)
    if (bundleManifest !== undefined) scopes.push(createRequire(bundleManifest))
  }
  const find = (specifier: string) => {
    for (const scope of scopes) {
      const resolved = tryResolve(scope, specifier)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  return {
    resolve(specifier) {
      const resolved = find(specifier)
      if (resolved === undefined) throw new Error(`cannot resolve ${specifier} from the DSH profile`)
      return resolved
    },
    packageVersion(packageName) {
      const path = find(`${packageName}/package.json`)
      if (path === undefined) return undefined
      const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
      return typeof version === 'string' ? version : undefined
    },
  }
}
