import type { ResearchDomain } from "./domain"

export namespace SearchDistributions {
  export function summarize(observations: ResearchDomain.SearchObservation[]) {
    const groups = new Map<string, ResearchDomain.SearchObservation[]>()
    for (const item of observations) {
      if (!item.configurationFamilyFingerprint || item.intent !== "optimize") continue
      const key = `${item.experimentId}:${item.configurationFamilyFingerprint}`
      const group = groups.get(key) ?? []
      if (!group.some((prior) => prior.runId === item.runId)) group.push(item)
      groups.set(key, group)
    }
    return [...groups.values()].map((group) => {
      const scores = group.filter((item) => item.decision !== "failed" && item.valid !== false && item.score !== null).map((item) => item.score!)
      const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
      return {
        configurationFamilyFingerprint: group[0]!.configurationFamilyFingerprint,
        experimentId: group[0]!.experimentId,
        runIds: group.map((item) => item.runId),
        generationReplicateIds: group.flatMap((item) => item.generationReplicateId ?? []),
        attempts: group.length, scored: scores.length,
        failures: group.filter((item) => item.decision === "failed").length,
        mean, minimum: scores.length ? Math.min(...scores) : null, maximum: scores.length ? Math.max(...scores) : null,
        sampleStandardDeviation: mean !== null && scores.length > 1
          ? Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (scores.length - 1)) : null,
        generationWallSeconds: group.every((item) => item.generationWallSeconds !== undefined)
          ? group.reduce((sum, item) => sum + item.generationWallSeconds!, 0) : null,
        timedRuns: group.filter((item) => item.generationWallSeconds !== undefined).length,
        stochasticity: [...new Set(group.flatMap((item) => item.generationStochasticity ?? []))],
        limitation: "Observed draws, not proof of independent RNG or biological validity; unknown legacy families remain unclassified.",
      }
    })
  }
}
