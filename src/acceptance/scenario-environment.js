export const NILS_COMPATIBILITY_CANDIDATE_ENV =
  'DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE'

/** @param {NodeJS.ProcessEnv} environment */
export function sanitizeAcceptanceScenarioEnvironment(environment) {
  const sanitized = { ...environment }
  delete sanitized[NILS_COMPATIBILITY_CANDIDATE_ENV]
  return sanitized
}

/** @param {string | undefined} candidateFeature @param {boolean} enabled */
export function nilsCompatibilityCandidateEnvironment(candidateFeature, enabled) {
  return enabled && candidateFeature !== undefined
    ? { [NILS_COMPATIBILITY_CANDIDATE_ENV]: candidateFeature }
    : {}
}
