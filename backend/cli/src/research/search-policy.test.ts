import { describe, expect, test } from "bun:test"
import { ResearchSearchPolicy } from "./search-policy"

describe("typed autoresearch search policy", () => {
  test("allocates every candidate and generation second across selected generators", () => {
    expect(ResearchSearchPolicy.allocate(["boltzgen-binder", "pxdesign-binder"], 5, 1_000)).toEqual([
      { generator: "boltzgen-binder", maximumCandidates: 3, maximumGpuSeconds: 500 },
      { generator: "pxdesign-binder", maximumCandidates: 2, maximumGpuSeconds: 500 },
    ])
  })

  test("prioritizes predictor disagreement before generator exploration", () => {
    expect(ResearchSearchPolicy.derive({
      iteration: 1,
      availableGenerators: ["boltzgen-binder", "pxdesign-binder"],
      usedGenerators: ["boltzgen-binder"],
      candidateBudget: 4,
      generationGpuSeconds: 800,
      predictorDisagreement: true,
    })).toMatchObject({
      move: "investigate_predictor_disagreement",
      preferredGenerators: ["boltzgen-binder"],
      targetStage: "independent",
    })
  })

  test("explores an unused execution-ready generator", () => {
    expect(ResearchSearchPolicy.derive({
      iteration: 1,
      availableGenerators: ["boltzgen-binder", "pxdesign-binder"],
      usedGenerators: ["boltzgen-binder"],
      candidateBudget: 2,
      generationGpuSeconds: 600,
      predictorDisagreement: false,
    })).toMatchObject({ move: "explore_generator", preferredGenerators: ["pxdesign-binder"] })
  })

  test("exploits the empirically best generator after every arm has evidence", () => {
    expect(ResearchSearchPolicy.derive({
      iteration: 2,
      availableGenerators: ["boltzgen-binder", "pxdesign-binder", "rfdiffusion-mpnn-binder"],
      usedGenerators: ["boltzgen-binder", "pxdesign-binder", "rfdiffusion-mpnn-binder"],
      candidateBudget: 1,
      generationGpuSeconds: 600,
      predictorDisagreement: false,
      direction: "minimize",
      outcomes: [
        { generator: "boltzgen-binder", status: "succeeded", valid: true, score: 0.24 },
        { generator: "pxdesign-binder", status: "failed" },
        { generator: "rfdiffusion-mpnn-binder", status: "succeeded", valid: true, score: 0.19 },
      ],
    })).toMatchObject({
      move: "exploit_incumbent_family",
      preferredGenerators: ["rfdiffusion-mpnn-binder"],
      workflowVariant: "full_consensus",
    })
  })

  test("forms an empirically ranked generator portfolio when the frozen candidate budget permits", () => {
    expect(ResearchSearchPolicy.derive({
      iteration: 3,
      availableGenerators: ["boltzgen-binder", "pxdesign-binder", "rfdiffusion-mpnn-binder"],
      usedGenerators: ["boltzgen-binder", "pxdesign-binder", "rfdiffusion-mpnn-binder"],
      candidateBudget: 3,
      generationGpuSeconds: 900,
      predictorDisagreement: false,
      outcomes: [
        { generator: "boltzgen-binder", status: "succeeded", valid: true, score: 0.22 },
        { generator: "pxdesign-binder", status: "failed" },
        { generator: "rfdiffusion-mpnn-binder", status: "succeeded", valid: true, score: 0.18 },
      ],
    })).toMatchObject({
      move: "reallocate_compute",
      preferredGenerators: ["rfdiffusion-mpnn-binder", "boltzgen-binder", "pxdesign-binder"],
      workflowVariant: "compute_rebalanced_consensus",
    })
  })
})
