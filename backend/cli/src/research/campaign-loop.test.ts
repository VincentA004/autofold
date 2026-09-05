import { describe, expect, test } from "bun:test"
import { ResearchCampaignLoop } from "./campaign-loop"
import type { ResearchDomain } from "./domain"
import type { ResearchOrchestration } from "./orchestration"
import { ResearchTeam } from "./research-team"

function observation(): ResearchOrchestration.Observation {
  return {
    version: 1,
    observedAt: "2026-08-09T00:00:00.000Z",
    campaign: {
      id: "cmp_loop",
      projectId: "project-loop",
      objective: "Discover a selective peptide",
      status: "active",
      knowledgeCatalogId: "okf_loop",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    experiments: [
      {
        id: "exp_loop",
        status: "active",
        objective: "Improve the locked score",
        contractHash: `sha256:${"a".repeat(64)}`,
        budget: { maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 60 },
        evaluator: { direction: "minimize", fixedSeeds: [20260809], submissionSize: 1 },
        incumbentSequences: [],
        incumbentScore: 0.4,
        trialCount: 1,
        succeededRuns: 1,
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
        id: "chr_loop", campaignId: "cmp_loop", version: 1, objective: "Discover a selective peptide",
        successCriteria: [{ id: "biological_objective", statement: "Find a robust candidate", requiredEvidenceLevel: "multi_seed_support", status: "open" }],
        requiredControls: [], stopConditions: [{ kind: "budget_exhausted", criterion: "Budget is exhausted" }],
        constraints: { requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true },
        status: "active", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
      },
      hypotheses: [], searchLandscape: [],
      progress: { openSuccessCriteria: 1, metSuccessCriteria: 0, highestTrustedEvidenceLevel: "model_observation", exploredPrograms: 0, exploredGenerators: [] },
    },
    knowledge: {
      due: false,
      reasons: [],
      unprocessedKnowledgeIds: [],
      unresolvedQuestions: [],
      proposedClaimIds: [],
      contestedClaimIds: [],
      recentOutcomes: [],
      recentClaims: [],
    },
    activeJobs: [],
  }
}

const basis = {
  researchBasis: {
    goalCriterionId: "biological_objective",
    hypothesis: "A bounded experiment will resolve the leading uncertainty.",
    expectedObservation: "The locked evaluator changes under the tested delta.",
    falsificationCriterion: "The locked evaluator does not change under the tested delta.",
    searchDelta: "Test one previously unexplored program delta.",
  },
}

function lifecycle(checkpoints: Record<string, ResearchDomain.JobCheckpoint> = {}) {
  return {
    jobId: "job_campaign",
    checkpoints,
    checkpoint: async (phase: string, data: Record<string, unknown>) => {
      checkpoints[phase] = { phase, data, completedAt: "2026-08-09T00:00:01.000Z" }
    },
  }
}

function analysis(): ResearchTeam.Analysis {
  return {
    plannerSessionId: "ses_planner",
    planPath: ".autofold/orchestration/team.json",
    plan: {
      rationale: "Diagnose the highest-value uncertainty.",
      tasks: [
        {
          id: "model_diagnosis",
          role: "ml",
          capabilities: ["model_diagnostics"],
          objective: "Diagnose predictor behavior.",
          questions: ["Which diagnostic should control the next move?"],
          contextFocus: ["experiments", "outcomes"],
        },
      ],
    },
    reports: [
      {
        task: {
          id: "model_diagnosis",
          role: "ml",
          capabilities: ["model_diagnostics"],
          objective: "Diagnose predictor behavior.",
          questions: ["Which diagnostic should control the next move?"],
          contextFocus: ["experiments", "outcomes"],
        },
        knowledgeSkills: [
          {
            id: "skill_bionemo.predictor-interpretation",
            version: 1,
            versionId: "skv_predictor_v1",
            contentHash: `sha256:${"a".repeat(64)}`,
          },
        ],
        childSessionId: "ses_specialist",
        reportPath: ".autofold/orchestration/report.json",
        report: {
          summary: "The next move should isolate predictor disagreement.",
          findings: [],
          failureModes: [],
          recommendations: ["Run one bounded iteration."],
          unresolvedQuestions: [],
        },
      },
    ],
  }
}

describe("bounded campaign supervisor", () => {
  test("runs five active-experiment steps without planner or supervisor calls", async () => {
    let observed = 0
    let executed = 0
    const checkpoints: Record<string, ResearchDomain.JobCheckpoint> = {}
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 5 },
      lifecycle(checkpoints),
      {
        directActiveExperiment: true,
        observe: async () => {
          observed++
          const current = observation()
          current.observedAt = `2026-08-09T00:00:0${observed}.000Z`
          current.experiments[0]!.trialCount = observed
          return current
        },
        analyze: async () => {
          throw new Error("active experiment must bypass research-team analysis")
        },
        propose: async () => {
          throw new Error("active experiment must bypass campaign-supervisor proposal")
        },
        execute: async ({ move, analysis: currentAnalysis }) => {
          executed++
          expect(currentAnalysis).toBeUndefined()
          expect(move).toMatchObject({
            kind: "iterate_experiment",
            experimentId: "exp_loop",
            recursionMode: "autonomous_discovery",
            iterations: 100,
          })
          return { completedIterations: 1 }
        },
      },
    )
    expect(result).toMatchObject({ status: "exhausted", completedSteps: 5 })
    expect(observed).toBe(5)
    expect(executed).toBe(5)
    expect(Object.keys(checkpoints).some((phase) => phase.endsWith(":analysis"))).toBe(false)
    expect(result.steps.every((step) => step.analysis === undefined && step.proposal.childSessionId === undefined)).toBe(true)
  })

  test("compacts specialist reports without duplicating injected skill payloads", () => {
    const compact = ResearchCampaignLoop.compactSupervisorAnalysis(analysis()) as {
      reports: Array<Record<string, unknown>>
    }
    expect(compact.reports[0]).toMatchObject({ taskId: "model_diagnosis", role: "ml" })
    expect(compact.reports[0]).not.toHaveProperty("knowledgeSkills")
    expect(compact.reports[0]).not.toHaveProperty("childSessionId")
  })

  test("authorizes the remaining campaign trial budget as one autonomous scientist loop", () => {
    const current = observation()
    current.researchState.charter.constraints.maximumCampaignTrials = 12
    current.experiments[0]!.trialCount = 7
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "iterate_experiment",
      recursionMode: "autonomous_discovery",
      iterations: 5,
    })
    current.experiments[0]!.trialCount = 12
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "stop",
      rationale: expect.stringContaining("maximum trial count is exhausted"),
    })
  })

  test("preserves a bounded trajectory authorization across campaign-plane steps", () => {
    const current = observation()
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current, 2)?.move).toMatchObject({
      kind: "iterate_experiment",
      iterations: 2,
    })
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current, 0)?.move).toMatchObject({
      kind: "stop",
      rationale: expect.stringContaining("originating autonomous job's trajectory authorization is exhausted"),
    })
    const completed = [{
      step: 1,
      observationAt: current.observedAt,
      proposal: { move: { kind: "stop", rationale: "fixture", unresolvedQuestions: [] } },
      decision: { status: "authorized", move: { kind: "stop", rationale: "fixture", unresolvedQuestions: [] }, executable: false },
      result: {
        iterations: [
          { status: "succeeded", runId: "run_one" },
          { status: "run_failed", runId: "run_two" },
          { status: "authoring_failed" },
        ],
      },
    }] as ResearchCampaignLoop.Step[]
    expect(ResearchCampaignLoop.completedTrajectoryCount(completed)).toBe(2)
    expect(ResearchCampaignLoop.remainingTrajectoryAuthorization({
      campaignId: "cmp_loop",
      sessionId: "ses_parent",
      maxSteps: 3,
      maximumTrajectories: 4,
    }, completed)).toBe(2)
  })

  test("keeps a resumed trajectory authorization on its originating frozen experiment", () => {
    const current = observation()
    current.experiments.push({
      ...current.experiments[0]!,
      id: "exp_competing",
      contractHash: `sha256:${"b".repeat(64)}`,
      incumbentScore: 0.2,
    })
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current, 1)).toBeUndefined()
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current, 1, "exp_loop")?.move).toMatchObject({
      kind: "iterate_experiment",
      experimentId: "exp_loop",
      iterations: 1,
    })
  })

  test("keeps replay-gated skill learning off the active discovery critical path", () => {
    const current = observation()
    current.skills.active = [{
      id: "skv_predictor_v1",
      skillId: "skill_bionemo.predictor-interpretation",
      version: 1,
      contentHash: `sha256:${"d".repeat(64)}`,
      capabilities: ["model_diagnostics"],
      appliesToToolKeys: ["boltz2-prediction", "chai1-prediction"],
      status: "active",
      source: "bundled",
      createdAt: current.observedAt,
    }]
    current.recentSkillFeedback = ["one", "two"].map((suffix, index) => ({
      jobId: `job_${suffix}`,
      experimentId: "exp_loop",
      iteration: index + 1,
      skillId: "skill_bionemo.predictor-interpretation",
      trigger: "predictor_disagreement" as const,
      rationale: "The same predictor interpretation gap recurred.",
      trajectoryRefs: ["exp_loop", `trl_${suffix}`, `run_${suffix}`],
      requiresShadowReplay: true as const,
      recordedAt: current.observedAt,
    }))
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "iterate_experiment",
      experimentId: "exp_loop",
    })
    current.recentSkillFeedback = []
    current.skills.recentRefinements = [{
      id: "skv_predictor_v2", skillId: "skill_bionemo.predictor-interpretation", version: 2,
      parentVersionId: "skv_predictor_v1", contentHash: `sha256:${"e".repeat(64)}`, status: "candidate",
      trajectoryRefs: ["run_one", "run_two"], createdAt: current.observedAt,
    }]
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "iterate_experiment",
      experimentId: "exp_loop",
    })
  })

  test("only scheduled or initial literature refresh interrupts active discovery", () => {
    const current = observation()
    current.knowledge.due = true
    current.knowledge.reasons = ["new_experiment_results"]
    current.knowledge.unresolvedQuestions = ["Does current PD-L1 literature support the observed scaffold trend?"]
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "iterate_experiment",
      experimentId: "exp_loop",
    })
    current.knowledge.reasons = ["scheduled_refresh_due"]
    expect(ResearchCampaignLoop.directActiveExperimentProposal(current)?.move).toMatchObject({
      kind: "refresh_knowledge",
      force: false,
      question: "Does current PD-L1 literature support the observed scaffold trend?",
    })
  })

  test("honors the persistent scientist's stop instead of authorizing another search loop", async () => {
    let observed = 0
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 5 },
      lifecycle(),
      {
        directActiveExperiment: true,
        observe: async () => {
          observed++
          return observation()
        },
        analyze: async () => { throw new Error("must bypass analysis") },
        propose: async () => { throw new Error("must bypass proposal") },
        execute: async () => ({
          completedIterations: 4,
          stopReason: "improvement_plateau",
        }),
      },
    )
    expect(result).toMatchObject({ status: "stopped", completedSteps: 1 })
    expect(observed).toBe(1)
    expect(ResearchCampaignLoop.autonomousBoundaryStatus({
      ...result.steps[0]!,
      result: { stopReason: "approval_required_contract_change" },
    })).toBe("approval_required")
  })

  test("compacts the campaign decision packet while retaining exact newest-run evidence", () => {
    const current = observation()
    const huge = "oversized recursive narrative ".repeat(500)
    current.knowledge.recentOutcomes = Array.from({ length: 30 }, (_, index) => ({
      id: `knw_${index}`, experimentId: "exp_loop", trialId: `trl_${index}`, evaluationId: `evl_${index}`,
      runId: `run_${index}`, title: huge, description: huge, decision: "rejected" as const, score: 0.3,
      diagnostics: { predictor_disagreement: 0.28 }, createdAt: current.observedAt,
    }))
    current.knowledge.recentClaims = Array.from({ length: 30 }, (_, index) => ({
      id: `clm_${index}`, kind: "hypothesis" as const, statement: huge, confidence: 0.6, status: "proposed" as const,
    }))
    current.recentTrajectories = [{
      experimentId: "exp_loop",
      trial: {
        id: "trl_exact", hypothesis: huge, intent: "optimize", designAdapter: "proto",
        programHash: `sha256:${"c".repeat(64)}`, status: "succeeded",
        createdAt: current.observedAt, updatedAt: current.observedAt,
      },
      run: { id: "run_exact", status: "succeeded", createdAt: current.observedAt, completedAt: current.observedAt },
      evaluation: { id: "evl_exact", valid: true, score: 0.19, diagnostics: { predictor_disagreement: 0.28 }, evaluatedAt: current.observedAt },
      candidates: [{ id: "candidate_exact", sequence: "SAEEELRKLREELE", generationModel: "boltzgen-binder" }],
      modelEvidence: [{
        candidateId: "candidate_exact", modelId: "boltz2", seed: 20260809, status: "completed",
        metrics: { confidence_score: 0.91, narrative: huge },
      }],
      latestAt: current.observedAt,
    }]
    const serialized = JSON.stringify(ResearchTeam.compactCampaignObservation(current))
    expect(serialized.length).toBeLessThan(80_000)
    expect(serialized).toContain("SAEEELRKLREELE")
    expect(serialized).toContain("run_exact")
    expect(serialized).toContain('"seed":20260809')
    expect(serialized).toContain('"confidence_score":0.91')
    expect(serialized).not.toContain(huge)
  })

  test("passes only same-contract empirical findings to a trial author", () => {
    const current = observation()
    current.experiments.push({
      ...current.experiments[0]!,
      id: "exp_other",
      contractHash: `sha256:${"b".repeat(64)}`,
    })
    current.recentTrajectories = [
      {
        experimentId: "exp_loop",
        trial: {
          id: "trl_current", hypothesis: "current", intent: "optimize", designAdapter: "proto",
          programHash: `sha256:${"c".repeat(64)}`, status: "succeeded",
          createdAt: current.observedAt, updatedAt: current.observedAt,
        },
        evaluation: { id: "evl_current", valid: true, score: 0.2, diagnostics: {}, evaluatedAt: current.observedAt },
        latestAt: current.observedAt,
      },
      {
        experimentId: "exp_other",
        trial: {
          id: "trl_other", hypothesis: "other", intent: "optimize", designAdapter: "proto",
          programHash: `sha256:${"d".repeat(64)}`, status: "succeeded",
          createdAt: current.observedAt, updatedAt: current.observedAt,
        },
        evaluation: { id: "evl_other", valid: true, score: 0.1, diagnostics: {}, evaluatedAt: current.observedAt },
        latestAt: current.observedAt,
      },
    ]
    const team = analysis()
    team.reports[0]!.report.findings = [
      { statement: "same contract", evidenceRefs: ["evl_current"], confidence: 0.8 },
      { statement: "other contract", evidenceRefs: ["evl_other"], confidence: 0.8 },
      { statement: "mixed contracts", evidenceRefs: ["evl_current", "evl_other"], confidence: 0.8 },
      { statement: "campaign literature", evidenceRefs: ["clm_background"], confidence: 0.8 },
    ]
    expect(ResearchCampaignLoop.specialistFindingsForExperiment(team, current, "exp_loop")).toEqual([
      "same contract",
      "campaign literature",
    ])
  })

  test("observes, executes one authorized move, then stops on a supervisor boundary", async () => {
    const events: string[] = []
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 3 },
      lifecycle(),
      {
        observe: async () => observation(),
        analyze: async () => analysis(),
        propose: async ({ step }) => {
          events.push(`propose:${step}`)
          return step === 1
            ? {
                childSessionId: "ses_step_one",
                proposalPath: ".autofold/orchestration/step-1/move.json",
                move: {
                  ...basis,
                  kind: "iterate_experiment",
                  experimentId: "exp_loop",
                  iterations: 1,
                  agent: "biology",
                  rationale: "Run one falsifiable improvement.",
                  expectedInformationGain: "Measure whether the revised route improves the locked score.",
                },
              }
            : {
                childSessionId: "ses_step_two",
                proposalPath: ".autofold/orchestration/step-2/move.json",
                move: { kind: "stop", rationale: "The bounded objective is complete.", unresolvedQuestions: [] },
              }
        },
        execute: async ({ step, move }) => {
          events.push(`execute:${step}:${move.kind}`)
          return { completedIterations: 1 }
        },
      },
    )
    expect(result).toMatchObject({ status: "stopped", completedSteps: 2 })
    expect(events).toEqual(["propose:1", "execute:1:iterate_experiment", "propose:2"])
  })

  test("re-observes fresh evidence after each completed move", async () => {
    let observed = 0
    const seen: string[][] = []
    await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 2 },
      lifecycle(),
      {
        observe: async () => {
          observed++
          return {
            ...observation(),
            observedAt: `2026-08-09T00:00:0${observed}.000Z`,
            recentTrajectories: observed === 1 ? [] : [{
              experimentId: "exp_loop",
              trial: {
                id: "trl_fresh", hypothesis: "Fresh empirical result", intent: "optimize", designAdapter: "proto",
                programHash: `sha256:${"b".repeat(64)}`, status: "succeeded",
                createdAt: "2026-08-09T00:00:01.000Z", updatedAt: "2026-08-09T00:00:02.000Z",
              },
              evaluation: {
                id: "evl_fresh", valid: true, score: 0.2, diagnostics: { loss: 0.2 }, evaluatedAt: "2026-08-09T00:00:02.000Z",
              },
              latestAt: "2026-08-09T00:00:02.000Z",
            }],
          }
        },
        analyze: async ({ observation: current }) => {
          seen.push(current.recentTrajectories.map((item) => item.trial.id))
          return analysis()
        },
        propose: async ({ step }) => ({
          childSessionId: `ses_step_${step}`,
          proposalPath: `.autofold/orchestration/step-${step}/move.json`,
          move: step === 1
            ? { ...basis, kind: "iterate_experiment", experimentId: "exp_loop", iterations: 1, agent: "ml", rationale: "Run.", expectedInformationGain: "Learn." }
            : { kind: "stop", rationale: "Fresh evidence was observed.", unresolvedQuestions: [] },
        }),
        execute: async () => ({ completedIterations: 1 }),
      },
    )
    expect(observed).toBe(2)
    expect(seen).toEqual([[], ["trl_fresh"]])
  })

  test("supersedes a stale authorized move and replans without execution", async () => {
    const stale = observation()
    const fresh = observation()
    fresh.observedAt = "2026-08-09T00:00:02.000Z"
    fresh.experiments[0]!.trialCount = 2
    fresh.experiments[0]!.succeededRuns = 2
    fresh.experiments[0]!.recentEvaluations = [{
      evaluationId: "evl_fresh",
      trialId: "trl_fresh",
      valid: true,
      score: 0.2,
      diagnostics: { loss: 0.2 },
      evaluatedAt: fresh.observedAt,
    }]
    let observations = 0
    let executed = false
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 2 },
      lifecycle(),
      {
        observe: async () => observations++ === 0 ? stale : fresh,
        verifyObservation: async () => fresh,
        analyze: async () => analysis(),
        propose: async ({ step }) => ({
          childSessionId: `ses_stale_${step}`,
          proposalPath: `.autofold/orchestration/stale-${step}/move.json`,
          move: step === 1
            ? { ...basis, kind: "iterate_experiment", experimentId: "exp_loop", iterations: 1, agent: "biology", rationale: "Use stale evidence.", expectedInformationGain: "Test the stale move." }
            : { kind: "stop", rationale: "Replanned from the recovered evidence.", unresolvedQuestions: [] },
        }),
        execute: async () => {
          executed = true
          return { completedIterations: 1 }
        },
      },
    )
    expect(executed).toBe(false)
    expect(result).toMatchObject({ status: "stopped", completedSteps: 2 })
    expect(result.steps[0]).toMatchObject({
      decision: { status: "authorized", executable: false },
      result: { status: "superseded_stale_observation" },
    })
    expect(result.steps[1]?.observationAt).toBe(fresh.observedAt)
  })

  test("defers remaining campaign steps until a requested skill shadow replay finishes", async () => {
    let observed = 0
    let proposed = 0
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 4 },
      lifecycle(),
      {
        observe: async () => {
          observed++
          return observation()
        },
        analyze: async () => analysis(),
        propose: async () => {
          proposed++
          return {
            childSessionId: "ses_refine",
            proposalPath: ".autofold/orchestration/refine/move.json",
            move: {
              kind: "refine_skill",
              skillId: "skill_bionemo.predictor-interpretation",
              experimentId: "exp_loop",
              agent: "ml",
              repetitions: 3,
              trajectoryRefs: ["exp_loop"],
              rationale: "Two verified trajectories expose the same interpretation failure mode.",
              expectedInformationGain: "Test a revised interpretation method under shadow replay.",
            },
          }
        },
        execute: async () => ({
          jobId: "job_refinement",
          continuation: { remainingSteps: 3 },
        }),
      },
    )
    expect(result).toMatchObject({ status: "deferred", completedSteps: 1 })
    expect(observed).toBe(1)
    expect(proposed).toBe(1)
  })

  test("also defers when replaying an already persisted skill candidate", async () => {
    const current = observation()
    current.skills.recentRefinements = [{
      id: "skv_candidate", skillId: "skill_bionemo.predictor-interpretation", version: 2,
      parentVersionId: "skv_parent", contentHash: `sha256:${"f".repeat(64)}`, status: "candidate",
      trajectoryRefs: ["exp_loop"], createdAt: current.observedAt,
    }]
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 3 },
      lifecycle(),
      {
        observe: async () => current,
        analyze: async () => analysis(),
        propose: async () => ({
          childSessionId: "ses_replay",
          proposalPath: ".autofold/orchestration/replay/move.json",
          move: {
            kind: "replay_skill", candidateVersionId: "skv_candidate", experimentId: "exp_loop",
            agent: "ml", repetitions: 3, rationale: "Resolve the orphan candidate.",
            expectedInformationGain: "Measure the candidate against its parent.",
          },
        }),
        execute: async () => ({ jobId: "job_replay", continuation: { remainingSteps: 2 } }),
      },
    )
    expect(result).toMatchObject({ status: "deferred", completedSteps: 1 })
  })

  test("reuses completed-step and proposal checkpoints after restart", async () => {
    const priorStep = ResearchCampaignLoop.Step.parse({
      step: 1,
      observationAt: observation().observedAt,
      analysis: analysis(),
      proposal: {
        childSessionId: "ses_prior",
        proposalPath: ".autofold/orchestration/step-1/move.json",
        move: {
          ...basis,
          kind: "iterate_experiment",
          experimentId: "exp_loop",
          iterations: 1,
          agent: "biology",
          rationale: "Prior move.",
          expectedInformationGain: "Prior information gain.",
        },
      },
      decision: {
        status: "authorized",
        executable: true,
        move: {
          ...basis,
          kind: "iterate_experiment",
          experimentId: "exp_loop",
          iterations: 1,
          agent: "biology",
          rationale: "Prior move.",
          expectedInformationGain: "Prior information gain.",
        },
      },
      result: { completedIterations: 1 },
    })
    const resumedProposal = ResearchCampaignLoop.Proposal.parse({
      childSessionId: "ses_resumed",
      proposalPath: ".autofold/orchestration/step-2/move.json",
      move: { kind: "stop", rationale: "Stop after recovery.", unresolvedQuestions: [] },
    })
    const checkpoints: Record<string, ResearchDomain.JobCheckpoint> = {
      "step:1:completed": {
        phase: "step:1:completed",
        data: priorStep,
        completedAt: "2026-08-09T00:00:01.000Z",
      },
      "step:2:proposal": {
        phase: "step:2:proposal",
        data: resumedProposal,
        completedAt: "2026-08-09T00:00:02.000Z",
      },
    }
    let proposals = 0
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 3 },
      lifecycle(checkpoints),
      {
        observe: async () => observation(),
        analyze: async () => analysis(),
        propose: async () => {
          proposals++
          throw new Error("checkpointed proposals must not be regenerated")
        },
        execute: async () => {
          throw new Error("stop is not executable")
        },
      },
    )
    expect(proposals).toBe(0)
    expect(result).toMatchObject({ status: "stopped", completedSteps: 2 })
  })

  test("halts at an approval-gated experiment request", async () => {
    const result = await ResearchCampaignLoop.run(
      { campaignId: "cmp_loop", sessionId: "ses_parent", maxSteps: 5 },
      lifecycle(),
      {
        observe: async () => observation(),
        analyze: async () => analysis(),
        propose: async () => ({
          childSessionId: "ses_approval",
          proposalPath: ".autofold/orchestration/approval/move.json",
          move: {
            kind: "request_experiment",
            hypothesis: "A cyclic scaffold may escape the current limitation.",
            rationale: "The active experiment has saturated.",
            successCriterion: "Improve valid diverse yield under a new locked contract.",
          },
        }),
        execute: async () => {
          throw new Error("approval-gated moves must not execute")
        },
      },
    )
    expect(result).toMatchObject({ status: "approval_required", completedSteps: 1 })
  })
})
