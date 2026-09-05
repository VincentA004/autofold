import { describe, expect, test } from "bun:test"
import { CapabilityRefinement } from "./capability-refinement"
import { ResearchDomain } from "./domain"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const timestamp = "2026-08-10T12:00:00.000Z"

const campaign = ResearchDomain.Campaign.parse({
  id: "cmp_test", projectId: "project-test", objective: "Improve binder discovery", status: "active",
  knowledgeCatalogId: "catalog-test", createdAt: timestamp, updatedAt: timestamp,
})
const contract = ResearchDomain.ExperimentContract.parse({
  version: 1, objective: "Improve locked score", targetArtifactHash: digest("a"), modality: "short_peptide",
  budget: { maximumCandidates: 8, gpuHours: 1, wallTimeMinutes: 30 },
  evaluator: { id: "panel", version: "1", sourceHash: digest("b"), direction: "maximize", fixedSeeds: [7], submissionSize: 2 },
})
const experiment = ResearchDomain.Experiment.parse({
  id: "exp_test", campaignId: campaign.id, status: "active", contract,
  contractHash: ResearchDomain.hashContract(contract), createdAt: timestamp, updatedAt: timestamp,
})
const trial = ResearchDomain.Trial.parse({
  id: "trl_test", experimentId: experiment.id, hypothesis: "Test predictor ordering", designAdapter: "proto",
  programPath: "trials/test.py", programHash: digest("c"), status: "succeeded", createdAt: timestamp, updatedAt: timestamp,
})
const evaluation = ResearchDomain.Evaluation.parse({
  id: "evl_test", trialId: trial.id, contractHash: experiment.contractHash, evaluatorHash: digest("d"),
  valid: true, score: 0.6, diagnostics: { disagreement: 0.3 }, evaluatedAt: timestamp,
})
const parent = ResearchDomain.SkillVersion.parse({
  id: "skv_parent", campaignId: campaign.id, skillId: "skill_bionemo.predictor-interpretation", version: 1,
  path: ".autofold/parent/SKILL.md", contentHash: digest("e"), capabilities: ["model_diagnostics"],
  appliesToToolKeys: ["boltz2-prediction"], status: "active", source: "bundled", trajectoryRefs: [],
  createdBy: "autofold:bundled", createdAt: timestamp,
})
const trajectory = CapabilityRefinement.Trajectory.parse({
  capturedAt: timestamp,
  campaignId: campaign.id,
  skillId: parent.skillId,
  trajectoryRefs: [trial.id, evaluation.id],
  parentVersion: parent,
  nextVersion: 2,
  parentMarkdown: "---\nid: skill_bionemo.predictor-interpretation\nversion: 1\n---\n## Guidance\nX\n## Failure modes\nY\n## Falsifying questions\nZ",
  observation: {
    version: 1, observedAt: timestamp, campaign, experiments: [],
    recentTrajectories: [],
    recentAuthoringAttempts: [],
    recentSkillFeedback: [],
    skills: { active: [], recentRefinements: [] },
    researchState: {
      charter: {
        id: "chr_test", campaignId: campaign.id, version: 1, objective: campaign.objective,
        successCriteria: [{ id: "biological_objective", statement: "Find a robust candidate", requiredEvidenceLevel: "multi_seed_support", status: "open" }],
        requiredControls: [], stopConditions: [{ kind: "budget_exhausted", criterion: "Budget is exhausted" }],
        constraints: { requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true },
        status: "active", createdAt: timestamp, updatedAt: timestamp,
      },
      hypotheses: [], searchLandscape: [],
      progress: { openSuccessCriteria: 1, metSuccessCriteria: 0, highestTrustedEvidenceLevel: "model_observation", exploredPrograms: 0, exploredGenerators: [] },
    },
    knowledge: {
      due: false, reasons: [], unprocessedKnowledgeIds: [], unresolvedQuestions: [], proposedClaimIds: [],
      contestedClaimIds: [], recentOutcomes: [], recentClaims: [],
    },
    activeJobs: [],
  },
  histories: [{ experiment, trials: [trial], evaluations: [evaluation], runs: [] }],
  specialistAnalyses: [],
})
const proposal: CapabilityRefinement.ProposalCheckpoint = {
  childSessionId: "ses_child", draftPath: ".autofold/candidate/SKILL.md", parentVersionId: parent.id,
}
const candidate = ResearchDomain.SkillVersion.parse({
  ...parent, id: "skv_candidate", version: 2, parentVersionId: parent.id, path: proposal.draftPath,
  contentHash: digest("f"), status: "candidate", source: "campaign_refinement",
  trajectoryRefs: [trial.id, evaluation.id], createdBy: "capability-refinement:ses_child",
  origin: { jobId: "job_refine", phase: "candidate" },
})

describe("durable capability refinement", () => {
  test("freezes evidence, authors one candidate, and stops before replay", async () => {
    const phases: string[] = []
    const result = await CapabilityRefinement.run(
      { campaignId: campaign.id, sessionId: "ses_parent", skillId: parent.skillId, trajectoryRefs: [trial.id, evaluation.id] },
      {
        jobId: "job_refine",
        onTrajectory: async () => { phases.push("trajectory") },
        onProposal: async () => { phases.push("proposal") },
        onCandidate: async () => { phases.push("candidate") },
      },
      {
        capture: async () => trajectory,
        author: async () => proposal,
        propose: async () => candidate,
      },
    )
    expect(phases).toEqual(["trajectory", "proposal", "candidate"])
    expect(result).toMatchObject({ candidateVersionId: candidate.id, status: "awaiting_replay" })
  })

  test("resumes entirely from immutable checkpoints", async () => {
    const unavailable = async () => { throw new Error("should not rerun") }
    const result = await CapabilityRefinement.run(
      { campaignId: campaign.id, sessionId: "ses_parent", skillId: parent.skillId, trajectoryRefs: [trial.id, evaluation.id] },
      { jobId: "job_refine", trajectory, proposal, candidate },
      { capture: unavailable, author: unavailable, propose: unavailable },
    )
    expect(result.candidateVersionId).toBe(candidate.id)
  })

  test("rejects trajectory references that are absent from frozen evidence", () => {
    expect(() => CapabilityRefinement.Trajectory.parse({ ...trajectory, trajectoryRefs: ["trl_missing"] })).toThrow(
      "Trajectory reference is absent",
    )
  })
})
