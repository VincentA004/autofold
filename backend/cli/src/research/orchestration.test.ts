import { describe, expect, test } from "bun:test"
import { ResearchOrchestration } from "./orchestration"

const observation = (overrides: Partial<ResearchOrchestration.Observation> = {}): ResearchOrchestration.Observation => ({
  version: 1,
  observedAt: "2026-08-09T00:00:00.000Z",
  campaign: {
    id: "cmp_one",
    projectId: "project-one",
    objective: "Discover a selective binder",
    status: "active",
    knowledgeCatalogId: "okf_one",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  experiments: [
    {
      id: "exp_one",
      status: "active",
      objective: "Improve locked score",
      contractHash: `sha256:${"a".repeat(64)}`,
      budget: { maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 60 },
      evaluator: { direction: "minimize", fixedSeeds: [20260809], submissionSize: 1 },
      incumbentScore: 0.4,
      trialCount: 2,
      succeededRuns: 2,
      failedRuns: 0,
      recentEvaluations: [],
    },
  ],
  knowledge: {
    due: true,
    reasons: ["new_experiment_results"],
    unprocessedKnowledgeIds: ["knw_one"],
    unresolvedQuestions: ["Does this generalize?"],
    proposedClaimIds: ["clm_one"],
    contestedClaimIds: [],
    recentOutcomes: [],
    recentClaims: [],
  },
  activeJobs: [],
  ...overrides,
})

describe("recursive orchestration policy", () => {
  test("authorizes one bounded experiment move and blocks duplicate active work", () => {
    const move = {
      kind: "iterate_experiment" as const,
      experimentId: "exp_one",
      iterations: 2,
      agent: "biology" as const,
      rationale: "Test the strongest current hypothesis.",
      expectedInformationGain: "Separate sequence weakness from predictor disagreement.",
    }
    expect(ResearchOrchestration.compile(observation(), move).status).toBe("authorized")
    expect(
      ResearchOrchestration.compile(
        observation({
          activeJobs: [{ id: "job_one", kind: "autoresearch", targetId: "exp_one", status: "running" }],
        }),
        move,
      ),
    ).toMatchObject({ status: "rejected", reasons: ["Experiment exp_one already has active autoresearch"] })
  })

  test("normalizes a numeric supervisor information-gain estimate", () => {
    const decision = ResearchOrchestration.compile(observation(), {
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "biology",
      rationale: "Run the most discriminating control.",
      expectedInformationGain: 0.62,
    })
    expect(decision.status).toBe("authorized")
    expect(decision.move.kind).toBe("iterate_experiment")
    if (decision.move.kind === "iterate_experiment") {
      expect(decision.move.expectedInformationGain).toBe("Estimated relative information gain: 0.62")
    }
  })

  test("requires evidence freshness and contract-change approval", () => {
    expect(
      ResearchOrchestration.compile(observation({ knowledge: { ...observation().knowledge, due: false } }), {
        kind: "refresh_knowledge",
        rationale: "Refresh the evidence graph.",
      }),
    ).toMatchObject({ status: "rejected", reasons: ["Knowledge refresh is not due"] })
    expect(
      ResearchOrchestration.compile(observation(), {
        kind: "request_experiment",
        hypothesis: "Change the modality to test a cyclic scaffold.",
        rationale: "The current modality appears saturated.",
        successCriterion: "A new locked contract improves valid diverse yield.",
      }).status,
    ).toBe("approval_required")
  })

  test("permits review only for exact pending claims", () => {
    expect(
      ResearchOrchestration.compile(observation(), {
        kind: "request_review",
        claimIds: ["clm_one"],
        rationale: "This claim controls the next model route.",
      }).status,
    ).toBe("authorized")
    expect(
      ResearchOrchestration.compile(observation(), {
        kind: "request_review",
        claimIds: ["clm_unknown"],
        rationale: "Review an unknown claim.",
      }).status,
    ).toBe("rejected")
  })

  test("authorizes skill refinement only from visible trajectories and without duplicate work", () => {
    const move = {
      kind: "refine_skill" as const,
      skillId: "skill_bionemo.predictor-interpretation",
      experimentId: "exp_one",
      agent: "ml" as const,
      trajectoryRefs: ["exp_one"],
      rationale: "Repeated predictor disagreement suggests one bounded clarification.",
      expectedInformationGain: "Test whether frozen-seed comparison improves routing decisions.",
    }
    expect(ResearchOrchestration.compile(observation(), move).status).toBe("authorized")
    expect(ResearchOrchestration.compile(observation(), { ...move, trajectoryRefs: ["trl_unknown"] }).status).toBe("rejected")
    expect(ResearchOrchestration.compile(observation({
      activeJobs: [{
        id: "job_refine", kind: "capability_refinement", targetId: move.skillId, status: "running",
      }],
    }), move).status).toBe("rejected")
  })
})
