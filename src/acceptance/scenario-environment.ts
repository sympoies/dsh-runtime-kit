export const NILS_COMPATIBILITY_CANDIDATE_ENV =
  'DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE'

export function sanitizeAcceptanceScenarioEnvironment(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment }
  delete sanitized[NILS_COMPATIBILITY_CANDIDATE_ENV]
  return sanitized
}

export function nilsCompatibilityCandidateEnvironment(candidateFeature: string | undefined, enabled: boolean) {
  return enabled && candidateFeature !== undefined
    ? { [NILS_COMPATIBILITY_CANDIDATE_ENV]: candidateFeature }
    : {}
}
