import { describe, expect, test } from "bun:test"
import type { Evaluation, Experiment, ExperimentHistory, Trial } from "./api"
import { candidateSummary, evaluationFor, formatScore, promotionLabel, runFor, shortDigest, statusTone } from "./model"

const digest = `sha256:${"a".repeat(64)}` as const
const trial: Trial = {
  id: "trl_candidate",
  experimentId: "exp_one",
  hypothesis: "candidate",
  designAdapter: "mock",
  programPath: "trial.py",
  programHash: digest,
  status: "succeeded",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
}
const evaluation: Evaluation = {
  id: "evl_one",
  trialId: trial.id,
  contractHash: digest,
  evaluatorHash: digest,
  valid: true,
  score: 0.125,
  diagnostics: { candidate_count: 64, unique_fraction: 0.875, best_candidate_score: 0.02 },
  evaluatedAt: "2026-08-02T00:00:01.000Z",
}
const experiment = { id: "exp_one", incumbentTrialId: trial.id } as Experiment

describe("research ledger model", () => {
  test("derives promotion from the authoritative incumbent pointer", () => {
    expect(promotionLabel(experiment, trial, evaluation)).toBe("promoted incumbent")
    expect(promotionLabel({ ...experiment, incumbentTrialId: "trl_other" }, trial, evaluation)).toBe("incumbent retained")
    expect(promotionLabel(experiment, trial, { ...evaluation, valid: false })).toBe("invalid result")
  })

  test("extracts candidate evidence from locked evaluator diagnostics", () => {
    expect(candidateSummary(evaluation)).toEqual({ count: 64, uniqueFraction: 0.875, bestScore: 0.02 })
  })

  test("selects the latest trial run and matching evaluation", () => {
    const history = {
      experiment,
      trials: [trial],
      evaluations: [evaluation],
      runs: [
        { id: "run_old", trialId: trial.id, status: "failed", bundlePath: "a", outputPath: "b", createdAt: "1" },
        { id: "run_new", trialId: trial.id, status: "succeeded", bundlePath: "c", outputPath: "d", createdAt: "2" },
      ],
    } as ExperimentHistory
    expect(evaluationFor(history, trial.id)?.id).toBe("evl_one")
    expect(runFor(history, trial.id)?.id).toBe("run_new")
  })

  test("keeps ledger status and scientific values compact", () => {
    expect(statusTone("running")).toBe("active")
    expect(statusTone("failed")).toBe("error")
    expect(formatScore(0.00123456)).toBe("0.00123456")
    expect(shortDigest(digest)).toMatch(/^sha256:/)
  })
})
