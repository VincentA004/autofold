import { expect, test } from "bun:test"
import { ResearchDomain } from "./domain"
import { SearchDistributions } from "./search-distributions"
const hash = `sha256:${"a".repeat(64)}`
function observation(id: string, score: number | null, extra = {}) {
  return ResearchDomain.SearchObservation.parse({
    id: `sobs_${id}`, campaignId: "cmp_test", experimentId: "exp_test", trialId: `trl_${id}`, runId: `run_${id}`,
    knowledgeId: `knw_${id}`, knowledgeCycleId: `kcy_${id}`, intent: "optimize", programHash: hash,
    configurationFamilyFingerprint: hash, generatorPortfolio: ["boltzgen-binder"], candidateSequences: [], modelIds: [],
    seeds: [1], score, decision: score === null ? "failed" : "rejected", diagnostics: {}, hypothesis: "Replicate",
    epistemicLevel: "computational_support", createdAt: "2026-09-05T00:00:00.000Z", ...extra,
  })
}
test("family distributions count unique runs, exclude controls, and leave legacy identity unknown", () => {
  const first = observation("a", 0.1)
  const groups = SearchDistributions.summarize([first, first, observation("b", 0.3), observation("c", null),
    observation("control", 0, { intent: "negative_control" }), observation("legacy", 0, { configurationFamilyFingerprint: undefined })])
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({ attempts: 3, scored: 2, failures: 1, mean: 0.2, generationWallSeconds: null, timedRuns: 0 })
  expect(groups[0]!.sampleStandardDeviation).toBeCloseTo(Math.sqrt(0.02))
})
