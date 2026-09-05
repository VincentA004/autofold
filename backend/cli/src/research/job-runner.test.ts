import { describe, expect, test } from "bun:test"
import { ResearchJobRunner } from "./job-runner"
import type { ResearchAutoresearch } from "./autoresearch"

describe("research job continuation", () => {
  test("resumes the unused campaign budget only after shadow replay", () => {
    const input = ResearchJobRunner.campaignContinuationInput({
      kind: "skill_shadow_replay",
      campaignId: "cmp_campaign",
      experimentId: "exp_replay",
      candidateVersionId: "skv_candidate",
      sessionId: "ses_parent",
      agent: "ml",
      repetitions: 3,
      continuation: {
        sourceCampaignJobId: "job_campaign",
        remainingSteps: 3,
      },
    }, "job_replay")

    expect(input).toEqual({
      idempotencyKey: "skill-shadow-replay:job_replay:campaign-continuation",
      payload: {
        kind: "campaign_loop",
        campaignId: "cmp_campaign",
        experimentId: "exp_replay",
        sessionId: "ses_parent",
        maxSteps: 3,
        continuedFromJobId: "job_campaign",
      },
    })
  })

  test("carries the unused empirical authorization through shadow replay", () => {
    const input = ResearchJobRunner.campaignContinuationInput({
      kind: "skill_shadow_replay",
      campaignId: "cmp_campaign",
      experimentId: "exp_replay",
      candidateVersionId: "skv_candidate",
      sessionId: "ses_parent",
      agent: "ml",
      repetitions: 3,
      continuation: {
        sourceCampaignJobId: "job_campaign",
        remainingSteps: 4,
        remainingTrajectories: 7,
      },
    }, "job_replay")

    expect(input.payload).toMatchObject({
      kind: "campaign_loop",
      maxSteps: 4,
      maximumTrajectories: 7,
      continuedFromJobId: "job_campaign",
    })
  })
})

describe("automatic skill refinement scheduling", () => {
  test("requires repeated independent run evidence before scheduling replay-gated refinement", () => {
    const feedback = (iteration: number, runId: string): ResearchAutoresearch.Iteration => ({
      iteration,
      status: "succeeded",
      trialId: `trl_${iteration}`,
      runId,
      skillFeedback: [{
        skillId: "skill_bionemo.predictor-interpretation",
        trigger: "predictor_disagreement",
        rationale: "Cross-predictor disagreement recurred.",
        trajectoryRefs: ["exp_test", `trl_${iteration}`, runId],
        requiresShadowReplay: true,
      }],
    })
    const one = ResearchJobRunner.skillRefinementCandidates({
      experimentId: "exp_test", requestedIterations: 1, completedIterations: 1,
      stopReason: "iteration_limit_reached", iterations: [feedback(1, "run_one")],
    })
    expect(one).toEqual([])
    const repeated = ResearchJobRunner.skillRefinementCandidates({
      experimentId: "exp_test", requestedIterations: 2, completedIterations: 2,
      stopReason: "iteration_limit_reached", iterations: [feedback(1, "run_one"), feedback(2, "run_two")],
    })
    expect(repeated).toEqual([{
      skillId: "skill_bionemo.predictor-interpretation",
      trajectoryRefs: ["exp_test", "run_one", "run_two", "trl_1", "trl_2"],
    }])
  })
})
