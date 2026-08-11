import { describe, expect, test } from "bun:test"
import { ResearchCampaignLoop } from "./campaign-loop"
import type { ResearchDomain } from "./domain"
import type { ResearchOrchestration } from "./orchestration"
import type { ResearchTeam } from "./research-team"

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
        incumbentScore: 0.4,
        trialCount: 1,
        succeededRuns: 1,
        failedRuns: 0,
        recentEvaluations: [],
      },
    ],
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

  test("reuses completed-step and proposal checkpoints after restart", async () => {
    const priorStep = ResearchCampaignLoop.Step.parse({
      step: 1,
      observationAt: observation().observedAt,
      analysis: analysis(),
      proposal: {
        childSessionId: "ses_prior",
        proposalPath: ".autofold/orchestration/step-1/move.json",
        move: {
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
