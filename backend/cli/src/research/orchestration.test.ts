import { describe, expect, test } from "bun:test"
import { ResearchOrchestration } from "./orchestration"

const basis = {
  researchBasis: {
    goalCriterionId: "biological_objective",
    hypothesis: "A bounded experiment will resolve the leading uncertainty.",
    expectedObservation: "The locked evaluator changes under the tested delta.",
    falsificationCriterion: "The locked evaluator does not change under the tested delta.",
    searchDelta: "Test one previously unexplored program delta.",
  },
}

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
      incumbentTrialId: "trl_incumbent",
      incumbentSequences: ["CVTLEVDGEKFEIC"],
      incumbentScore: 0.4,
      trialCount: 2,
      succeededRuns: 2,
      failedRuns: 0,
      recentEvaluations: [],
    },
  ],
  recentTrajectories: [],
  recentAuthoringAttempts: [],
  recentSkillFeedback: [],
  skills: { active: [], recentRefinements: [] },
  researchState: {
    charter: {
      id: "chr_one", campaignId: "cmp_one", version: 1, objective: "Discover a selective binder",
      successCriteria: [{ id: "biological_objective", statement: "Find a robust candidate", requiredEvidenceLevel: "multi_seed_support", status: "open" }],
      requiredControls: [], stopConditions: [{ kind: "budget_exhausted", criterion: "Budget is exhausted" }],
      constraints: { requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true },
      status: "active", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
    },
    hypotheses: [], searchLandscape: [],
    progress: { openSuccessCriteria: 1, metSuccessCriteria: 0, highestTrustedEvidenceLevel: "model_observation", exploredPrograms: 0, exploredGenerators: [] },
  },
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
}) as ResearchOrchestration.Observation

describe("recursive orchestration policy", () => {
  test("reports verified search observations in campaign evidence progress", () => {
    expect(ResearchOrchestration.strongestEvidenceLevel([
      "model_observation",
      "multi_seed_support",
      "cross_model_support",
    ])).toBe("multi_seed_support")
    expect(ResearchOrchestration.strongestEvidenceLevel([])).toBe("model_observation")
  })

  test("suppresses superseded optional-gap skill feedback after artifact verification", () => {
    const feedback: ResearchOrchestration.RecentSkillFeedback = {
      jobId: "job_one",
      experimentId: "exp_one",
      iteration: 1,
      skillId: "skill_bionemo.predictor-interpretation",
      trigger: "optional_evidence_gap",
      rationale: "Optional Protenix evidence was skipped",
      trajectoryRefs: ["exp_one", "trl_one", "run_one"],
      requiresShadowReplay: true,
      recordedAt: "2026-08-09T00:00:03.000Z",
    }
    const complete: ResearchOrchestration.RecentTrajectory = {
      experimentId: "exp_one",
      trial: {
        id: "trl_one",
        hypothesis: "Test one routed candidate",
        intent: "optimize",
        designAdapter: "proto",
        programHash: `sha256:${"a".repeat(64)}`,
        status: "succeeded",
        createdAt: "2026-08-09T00:00:01.000Z",
        updatedAt: "2026-08-09T00:00:02.000Z",
      },
      run: {
        id: "run_one",
        status: "succeeded",
        manifestHash: `sha256:${"b".repeat(64)}`,
        createdAt: "2026-08-09T00:00:01.000Z",
        completedAt: "2026-08-09T00:00:02.000Z",
      },
      evidenceCompleteness: {
        status: "complete",
        totalDecisions: 6,
        completedDecisions: 6,
        skippedOptionalDecisions: 0,
        requiredDecisions: 4,
        completedRequiredDecisions: 4,
        skippedStages: [],
      },
      latestAt: "2026-08-09T00:00:02.000Z",
    }
    expect(ResearchOrchestration.reconcileRecentSkillFeedback([feedback], [complete])).toEqual([])
    expect(ResearchOrchestration.reconcileRecentSkillFeedback([
      { ...feedback, trigger: "authoring_failure" },
    ], [complete])).toHaveLength(1)
    expect(ResearchOrchestration.reconcileRecentSkillFeedback([feedback], [{
      ...complete,
      evidenceCompleteness: { ...complete.evidenceCompleteness!, status: "partial_optional", skippedOptionalDecisions: 1 },
    }])).toHaveLength(1)
  })

  test("links successful trajectory feedback to its replay-gated skill refinement", () => {
    const feedback = {
      jobId: "job_feedback",
      experimentId: "exp_one",
      iteration: 1,
      skillId: "skill_bionemo.predictor-interpretation",
      trigger: "predictor_disagreement" as const,
      rationale: "Predictors disagree materially.",
      trajectoryRefs: ["exp_one", "trl_one", "run_one"],
      requiresShadowReplay: true as const,
      recordedAt: "2026-08-09T00:00:00.000Z",
    }
    const version = {
      id: "skv_refined",
      campaignId: "cmp_one",
      skillId: feedback.skillId,
      version: 2,
      parentVersionId: "skv_parent",
      path: ".autofold/skills/refined/SKILL.md",
      contentHash: `sha256:${"f".repeat(64)}`,
      capabilities: ["model_diagnostics" as const],
      appliesToToolKeys: ["boltz2-prediction", "chai1-prediction"],
      status: "active" as const,
      source: "campaign_refinement" as const,
      trajectoryRefs: ["trl_one", "run_one"],
      createdBy: "capability-refinement:ses_child",
      replay: {
        benchmarkId: "shadow:exp_one",
        baselineVersionId: "skv_parent",
        candidateVersionId: "skv_refined",
        sameBudget: true,
        baseline: {
          lockedObjectiveUtility: 0.5, areaUnderImprovementCurve: 0.4, validDiverseYield: 0.5,
          predictorDisagreement: 0.3, failureRate: 0.5, computeCost: 1,
        },
        candidate: {
          lockedObjectiveUtility: 0.7, areaUnderImprovementCurve: 0.6, validDiverseYield: 1,
          predictorDisagreement: 0.1, failureRate: 0, computeCost: 1,
        },
        campaignIds: ["cmp_one"],
        passed: true,
        evaluatedAt: "2026-08-09T01:00:00.000Z",
      },
      createdAt: "2026-08-09T00:30:00.000Z",
    }
    expect(ResearchOrchestration.reconcileRecentSkillFeedback([feedback], [], [version]))
      .toEqual([{ ...feedback, refinement: {
        versionId: "skv_refined",
        status: "active",
        replayPassed: true,
        evaluatedAt: "2026-08-09T01:00:00.000Z",
      } }])
  })

  test("joins and orders recent closed-loop trajectories newest first", () => {
    const older = "2026-08-09T00:00:01.000Z"
    const newer = "2026-08-09T00:00:02.000Z"
    const digest = (character: string) => `sha256:${character.repeat(64)}`
    const experiment = {
      id: "exp_one",
      campaignId: "cmp_one",
      status: "active" as const,
      contract: {
        version: 1 as const,
        objective: "Improve score",
        targetArtifactHash: digest("a"),
        modality: "short_peptide" as const,
        budget: { maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 60 },
        evaluator: { id: "panel", version: "1", sourceHash: digest("b"), direction: "minimize" as const, fixedSeeds: [7], submissionSize: 1 },
      },
      contractHash: digest("c"),
      createdAt: older,
      updatedAt: newer,
    }
    const trial = (id: string, at: string) => ({
      id,
      experimentId: experiment.id,
      skills: [],
      hypothesis: `${id} empirical delta`,
      intent: "optimize" as const,
      designAdapter: "proto" as const,
      programPath: `${id}.py`,
      programHash: digest(id === "trl_old" ? "d" : "e"),
      generators: [],
      generatorAllocations: [],
      status: "succeeded" as const,
      createdAt: at,
      updatedAt: at,
    })
    const oldTrial = trial("trl_old", older)
    const newTrial = trial("trl_new", newer)
    const trajectories = ResearchOrchestration.collectRecentTrajectories([{
      experiment,
      trials: [oldTrial, newTrial],
      evaluations: [{
        id: "evl_new", trialId: newTrial.id, contractHash: experiment.contractHash,
        evaluatorHash: digest("f"), valid: true, score: 0.31, diagnostics: { loss: 0.31 }, evaluatedAt: newer,
      }],
      runs: [{
        id: "run_new", trialId: newTrial.id, status: "succeeded", bundlePath: "bundle.json",
        outputPath: "output", manifestHash: digest("1"), createdAt: newer, startedAt: newer, completedAt: newer,
      }],
    }], [{
      id: "knw_new", campaignId: "cmp_one", experimentId: experiment.id, trialId: newTrial.id,
      evaluationId: "evl_new", runId: "run_new", type: "Research Evaluation", title: "Rejected trial",
      description: "The new generated program was rejected.", tags: ["trial"], sources: [{ id: "evl_new", resource: "autofold://evaluations/evl_new" }],
      generated: { by: "autofold", at: newer }, verified: [{ by: "autofold", at: newer }], status: "stable",
      score: 0.31, decision: "rejected", diagnostics: { loss: 0.31 },
      provenance: { contractHash: experiment.contractHash, evaluatorHash: digest("f"), programHash: newTrial.programHash, manifestHash: digest("1") },
      createdAt: newer,
    }])

    expect(trajectories.map((item) => item.trial.id)).toEqual(["trl_new", "trl_old"])
    expect(trajectories[0]).toMatchObject({
      experimentId: "exp_one",
      run: { id: "run_new", status: "succeeded" },
      evaluation: { id: "evl_new", score: 0.31 },
      knowledge: { id: "knw_new", decision: "rejected" },
    })
  })

  test("authorizes one bounded experiment move and blocks duplicate active work", () => {
    const move = {
      ...basis,
      kind: "iterate_experiment" as const,
      experimentId: "exp_one",
      iterations: 2,
      agent: "biology" as const,
      rationale: "Test the strongest current hypothesis.",
      expectedInformationGain: "Separate sequence weakness from predictor disagreement.",
      evidenceRefs: ["kcy_notebook", "skv_predictor_v1"],
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
      ...basis,
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

  test("preserves an explicit non-promotable control intent", () => {
    const decision = ResearchOrchestration.compile(observation(), {
      ...basis,
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "biology",
      trialIntent: "negative_control",
      baselineTrialId: "trl_incumbent",
      rationale: "Score an exact composition-matched control under the frozen contract.",
      expectedInformationGain: "Separate sequence-specific contacts from scaffold geometry.",
      searchPolicy: {
        move: "workflow_ablation",
        rationale: "Evaluate an exact generator-free control.",
      },
    })
    expect(decision).toMatchObject({
      status: "authorized",
      move: { kind: "iterate_experiment", trialIntent: "negative_control" },
    })
  })

  test("rejects a static control anchored to another experiment's trial", () => {
    expect(ResearchOrchestration.compile(observation(), {
      ...basis,
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "biology",
      trialIntent: "negative_control",
      baselineTrialId: "trl_other",
      rationale: "Mutate a peptide from another experiment.",
      expectedInformationGain: "Test one residue.",
    })).toMatchObject({
      status: "rejected",
      reasons: ["Static baseline trl_other is not experiment exp_one's incumbent trl_incumbent"],
    })
  })

  test("rejects an empty generator allocation for an optimize search policy", () => {
    expect(ResearchOrchestration.compile(observation(), {
      ...basis,
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "ml",
      rationale: "Search for a new binder.",
      expectedInformationGain: "Explore the model space.",
      searchPolicy: { move: "explore_generator", rationale: "Explore." },
    })).toMatchObject({
      status: "rejected",
      reasons: ["Optimize search policy requires at least one preferred generator and allocation"],
    })
  })

  test("requires justification for an intentional equivalent replay", () => {
    expect(ResearchOrchestration.compile(observation(), {
      ...basis,
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "ml",
      rationale: "Repeat the exact workflow.",
      expectedInformationGain: "Measure replay variance.",
      allowEquivalent: true,
    })).toMatchObject({
      status: "rejected",
      reasons: ["Intentional equivalent proposals require an equivalenceJustification"],
    })
  })

  test("confines broad same-length controls to non-promotable trial intents", () => {
    expect(ResearchOrchestration.compile(observation(), {
      ...basis,
      kind: "iterate_experiment",
      experimentId: "exp_one",
      iterations: 1,
      agent: "biology",
      rationale: "Try an unconstrained same-length scaffold control.",
      expectedInformationGain: "Test a broader scaffold hypothesis.",
      staticControlScope: "same_length_scaffold",
    })).toMatchObject({
      status: "rejected",
      reasons: ["Broad same-length scaffold controls are restricted to non-promotable negative_control or calibrate trials"],
    })
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

  test("resolves an existing skill candidate before authorizing another refinement", () => {
    const candidate = {
      id: "skv_candidate",
      skillId: "skill_bionemo.predictor-interpretation",
      version: 2,
      parentVersionId: "skv_parent",
      contentHash: `sha256:${"f".repeat(64)}`,
      status: "candidate" as const,
      trajectoryRefs: ["trl_one", "run_one"],
      createdAt: "2026-08-09T00:00:00.000Z",
    }
    const current = observation({
      skills: { active: [], recentRefinements: [candidate] },
    })
    const refinement = ResearchOrchestration.compile(current, {
      kind: "refine_skill",
      skillId: candidate.skillId,
      experimentId: "exp_one",
      agent: "ml",
      repetitions: 3,
      trajectoryRefs: ["trl_one", "run_one"],
      rationale: "Refine the interpretation method.",
      expectedInformationGain: "Reduce predictor disagreement.",
    })
    expect(refinement).toMatchObject({ status: "rejected" })
    expect(refinement.status === "rejected" ? refinement.reasons.join(" ") : "")
      .toContain("replay that candidate")

    expect(ResearchOrchestration.compile(current, {
      kind: "replay_skill",
      candidateVersionId: candidate.id,
      experimentId: "exp_one",
      agent: "ml",
      repetitions: 3,
      rationale: "Resolve the persisted candidate under a matched replay.",
      expectedInformationGain: "Determine whether the candidate skill improves trusted replay outcomes.",
    })).toMatchObject({ status: "authorized", executable: true })
  })
})
