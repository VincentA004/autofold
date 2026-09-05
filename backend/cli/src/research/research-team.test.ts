import { describe, expect, test } from "bun:test"
import { ResearchTeam } from "./research-team"
import type { ResearchOrchestration } from "./orchestration"

describe("dynamic research-team contracts", () => {
  test("always includes the newest trajectory despite a narrow task focus", () => {
    const timestamp = "2026-08-09T00:00:00.000Z"
    const context = ResearchTeam.focusedContext({
      version: 1,
      observedAt: timestamp,
      campaign: {
        id: "cmp_one", projectId: "project", objective: "Discover", status: "active",
        knowledgeCatalogId: "catalog", createdAt: timestamp, updatedAt: timestamp,
      },
      experiments: [{
        id: "exp_one", status: "active", objective: "Improve", contractHash: `sha256:${"b".repeat(64)}`,
        budget: { maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 60 },
        evaluator: { direction: "minimize", fixedSeeds: [7], submissionSize: 1 },
        incumbentTrialId: "trl_incumbent", incumbentSequences: ["CVTLEVDGEKFEIC"], incumbentScore: 0.2,
        trialCount: 1, succeededRuns: 1, failedRuns: 0, recentEvaluations: [],
      }],
      recentTrajectories: [{
        experimentId: "exp_one",
        trial: {
          id: "trl_latest", hypothesis: "Latest result", intent: "optimize", designAdapter: "proto",
          programHash: `sha256:${"a".repeat(64)}`, status: "succeeded", createdAt: timestamp, updatedAt: timestamp,
        },
        latestAt: timestamp,
      }],
      recentAuthoringAttempts: [],
      recentSkillFeedback: [],
      skills: { active: [], recentRefinements: [] },
      researchState: {
        charter: {
          id: "chr_one", campaignId: "cmp_one", version: 1, objective: "Discover",
          successCriteria: [{ id: "biological_objective", statement: "Find a robust candidate", requiredEvidenceLevel: "multi_seed_support", status: "open" }],
          requiredControls: [], stopConditions: [{ kind: "budget_exhausted", criterion: "Budget is exhausted" }],
          constraints: { requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true },
          status: "active", createdAt: timestamp, updatedAt: timestamp,
        },
        hypotheses: [], searchLandscape: [],
        progress: { openSuccessCriteria: 1, metSuccessCriteria: 0, highestTrustedEvidenceLevel: "model_observation", exploredPrograms: 0, exploredGenerators: [] },
      },
      knowledge: {
        due: false, reasons: [], unprocessedKnowledgeIds: [], unresolvedQuestions: [],
        proposedClaimIds: [], contestedClaimIds: [], recentOutcomes: [], recentClaims: [],
      },
      activeJobs: [],
    } satisfies ResearchOrchestration.Observation, ["jobs", "uncertainties"]) as {
      latestEvidence: Array<{ trial: { id: string } }>
      experimentBaselines: Array<{ id: string; incumbentSequences: string[] }>
    }

    expect(context.latestEvidence[0]?.trial.id).toBe("trl_latest")
    expect(context.experimentBaselines[0]).toMatchObject({
      id: "exp_one", incumbentSequences: ["CVTLEVDGEKFEIC"],
    })
  })

  test("requires unique bounded specialist tasks", () => {
    expect(() =>
      ResearchTeam.Plan.parse({
        rationale: "Parallelize the two highest-value uncertainties.",
        tasks: [
          {
            id: "diagnose",
            role: "biology",
            capabilities: ["structural_biology"],
            objective: "Inspect interface failure modes.",
            questions: ["Which interface assumption is weakest?"],
            contextFocus: ["outcomes"],
          },
          {
            id: "diagnose",
            role: "ml",
            capabilities: ["model_diagnostics"],
            objective: "Inspect predictor disagreement.",
            questions: ["Which model is the persistent outlier?"],
            contextFocus: ["experiments"],
          },
        ],
      }),
    ).toThrow("Research-team task IDs must be unique")
  })

  test("allows only campaign provenance IDs in specialist findings", () => {
    const valid = ResearchTeam.Report.parse({
      summary: "The observed disagreement needs a controlled workflow change.",
      findings: [
        {
          statement: "The latest locked outcome reports predictor disagreement.",
          evidenceRefs: ["cmp_campaign", "knw_one", "exp_one", "evl_one", "run_one", "pep_candidate", "kcy_notebook", "skv_skill_v2"],
          confidence: 0.8,
        },
      ],
      failureModes: ["A model-specific configuration may be the outlier."],
      recommendations: ["Change one routing decision and preserve the evaluator."],
      unresolvedQuestions: ["Does the disagreement reproduce?"],
    })
    expect(valid.findings[0]?.evidenceRefs).toEqual([
      "cmp_campaign", "knw_one", "exp_one", "evl_one", "run_one", "pep_candidate", "kcy_notebook", "skv_skill_v2",
    ])
    expect(() =>
      ResearchTeam.Report.parse({
        ...valid,
        findings: [{ statement: "Unsupported citation", evidenceRefs: ["paper:invented"], confidence: 1 }],
      }),
    ).toThrow()
  })

  test("maps an injected stable skill name to its immutable version without accepting unknown citations", () => {
    const normalized = ResearchTeam.normalizeReportSkillRefs({
      summary: "Skill-guided diagnosis.",
      findings: [{
        statement: "The injected interpretation method requires replay.",
        evidenceRefs: ["job_known", "skill_bionemo.predictor-interpretation"],
        confidence: "high",
      }],
      failureModes: [],
      recommendations: [],
      unresolvedQuestions: [],
    }, [{
      id: "skill_bionemo.predictor-interpretation",
      version: 2,
      versionId: "skv_predictor_v2",
      contentHash: `sha256:${"a".repeat(64)}`,
    }])
    expect(ResearchTeam.Report.parse(normalized).findings[0]?.evidenceRefs).toEqual([
      "job_known", "skv_predictor_v2",
    ])

    const unknown = ResearchTeam.normalizeReportSkillRefs({
      summary: "Unsupported skill.",
      findings: [{ statement: "Unknown method.", evidenceRefs: ["skill_invented"], confidence: 1 }],
      failureModes: [],
      recommendations: [],
      unresolvedQuestions: [],
    }, [])
    expect(() => ResearchTeam.Report.parse(unknown)).toThrow()
  })

  test("normalizes a single planner context focus at the agent boundary", () => {
    const plan = ResearchTeam.Plan.parse({
      rationale: "Resolve the highest-value uncertainty.",
      tasks: [{
        id: "contact_map",
        role: "biology",
        capabilities: ["structural_biology"],
        objective: "Inspect the incumbent contact map.",
        questions: ["Which residue is the strongest contact?"],
        contextFocus: "claims",
      }],
    })
    expect(plan.tasks[0]?.contextFocus).toEqual(["claims"])
  })

  test("normalizes enriched specialist narratives and categorical confidence at the agent boundary", () => {
    const report = ResearchTeam.Report.parse({
      summary: "A bounded diagnostic.",
      findings: [
        { statement: "Observed disagreement.", evidenceRefs: ["clm_known"], confidence: "high (multi_seed_support)" },
        { statement: "Portfolio diagnosis.", evidenceRefs: ["exp_known"], confidence: "75% (cross-model)" },
        { statement: "Confidence was omitted.", evidenceRefs: [] },
      ],
      failureModes: [{ description: "Single-seed uncertainty.", requiredFix: "Use three seeds." }],
      recommendations: [{ action: "Repeat the control.", detail: "Hold the evaluator fixed." }],
      unresolvedQuestions: [{ question: "Is the score stable?", proposedAction: "Measure variance." }],
    })

    expect(report.findings[0]?.confidence).toBe(0.85)
    expect(report.findings[1]?.confidence).toBe(0.75)
    expect(report.findings[2]?.confidence).toBe(0.5)
    expect(report.failureModes).toEqual(["Single-seed uncertainty. — Use three seeds."])
    expect(report.recommendations).toEqual(["Repeat the control. — Hold the evaluator fixed."])
    expect(report.unresolvedQuestions).toEqual(["Is the score stable? — Measure variance."])
  })
})
