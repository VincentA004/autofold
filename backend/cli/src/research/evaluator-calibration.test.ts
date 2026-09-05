import { describe, expect, test } from "bun:test"
import { EvaluatorCalibration } from "./evaluator-calibration"
import { ResearchDomain } from "./domain"

const digest = (_value: string) => `sha256:${"a".repeat(64)}`
const observation = (
  id: string,
  calibrationClass: "known_positive" | "known_negative",
  score: number,
): ResearchDomain.SearchObservation => ResearchDomain.SearchObservation.parse({
  id: `sobs_${id}`,
  campaignId: "cmp_calibration",
  experimentId: "exp_calibration",
  trialId: `trl_${id}`,
  runId: `run_${id}`,
  evaluationId: `evl_${id}`,
  knowledgeId: `knw_${id}`,
  knowledgeCycleId: `kcy_${id}`,
  intent: calibrationClass === "known_negative" ? "negative_control" : "calibrate",
  calibrationClass,
  programHash: digest(id),
  generatorPortfolio: [],
  generatorAllocations: [],
  candidateSequences: ["ACDEFG"],
  modelIds: ["boltz2", "chai1"],
  seeds: [1, 2],
  score,
  decision: "observed",
  diagnostics: {},
  hypothesis: "Matched calibration",
  epistemicLevel: "multi_seed_support",
  createdAt: "2026-08-30T12:00:00.000Z",
})

describe("evaluator calibration audit", () => {
  test("requires replication before declaring supported calibration", () => {
    const result = EvaluatorCalibration.audit({
      direction: "minimize",
      observations: [observation("p1", "known_positive", 0.1), observation("n1", "known_negative", 0.3)],
    })
    expect(result).toMatchObject({ status: "preliminary", pairwiseAccuracy: 1 })
    expect(result.separationMargin).toBeCloseTo(0.2)
  })

  test("supports a consistently separated replicated panel", () => {
    const result = EvaluatorCalibration.audit({
      direction: "minimize",
      observations: [
        observation("p1", "known_positive", 0.1),
        observation("p2", "known_positive", 0.12),
        observation("n1", "known_negative", 0.3),
        observation("n2", "known_negative", 0.25),
      ],
    })
    expect(result).toMatchObject({ status: "supported", pairwiseAccuracy: 1, separationMargin: 0.13 })
  })

  test("fails when a negative control outranks the positive reference", () => {
    const result = EvaluatorCalibration.audit({
      direction: "minimize",
      observations: [observation("p1", "known_positive", 0.2), observation("n1", "known_negative", 0.1)],
    })
    expect(result.status).toBe("failed")
  })
})
