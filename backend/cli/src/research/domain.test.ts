import { describe, expect, test } from "bun:test"
import { ResearchDomain } from "./domain"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const contract: ResearchDomain.ExperimentContract = {
  version: 1,
  objective: "Discover binders for target X",
  targetArtifactHash: digest("a"),
  modality: "linear_minibinder",
  budget: {
    maximumCandidates: 1_000,
    gpuHours: 20,
    wallTimeMinutes: 180,
  },
  evaluator: {
    id: "peptide-panel",
    version: "1",
    sourceHash: digest("b"),
    direction: "minimize",
    fixedSeeds: [41, 42, 43],
    submissionSize: 20,
  },
}

describe("research domain", () => {
  test("experiment contracts have stable content hashes", () => {
    expect(ResearchDomain.hashContract(contract)).toBe(ResearchDomain.hashContract(structuredClone(contract)))
  })

  test("trial lifecycle permits only explicit transitions", () => {
    expect(ResearchDomain.canTransitionTrial("proposed", "queued")).toBe(true)
    expect(ResearchDomain.canTransitionTrial("running", "succeeded")).toBe(false)
    expect(ResearchDomain.canTransitionTrial("succeeded", "running")).toBe(false)
  })

  test("promotion requires comparable evaluations and a better score", () => {
    const base = {
      contractHash: ResearchDomain.hashContract(contract),
      evaluatorHash: contract.evaluator.sourceHash,
      valid: true,
      diagnostics: {},
      evaluatedAt: new Date().toISOString(),
    }
    const incumbent: ResearchDomain.Evaluation = {
      ...base,
      id: "evl_incumbent",
      trialId: "trl_incumbent",
      score: 0.42,
    }
    const candidate: ResearchDomain.Evaluation = {
      ...base,
      id: "evl_candidate",
      trialId: "trl_candidate",
      score: 0.37,
    }

    expect(ResearchDomain.shouldPromote({ candidate, incumbent, direction: "minimize" })).toBe(true)
    expect(
      ResearchDomain.shouldPromote({
        candidate: { ...candidate, evaluatorHash: digest("c") },
        incumbent,
        direction: "minimize",
      }),
    ).toBe(false)
  })

  test("invalid evaluations cannot become incumbents", () => {
    const candidate: ResearchDomain.Evaluation = {
      id: "evl_candidate",
      trialId: "trl_candidate",
      contractHash: ResearchDomain.hashContract(contract),
      evaluatorHash: contract.evaluator.sourceHash,
      valid: false,
      score: null,
      diagnostics: {},
      evaluatedAt: new Date().toISOString(),
    }
    expect(ResearchDomain.shouldPromote({ candidate, direction: "minimize" })).toBe(false)
  })
})

