import { describe, expect, test } from "bun:test"
import { ResearchAutoresearch } from "./autoresearch"
import { ResearchDomain } from "./domain"
import { ResearchSkills } from "./research-skills"
import { SkillShadowReplay } from "./skill-shadow-replay"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const timestamp = "2026-08-10T12:00:00.000Z"
const campaignId = "cmp_shadow"
const contract = ResearchDomain.ExperimentContract.parse({
  version: 1, objective: "Improve locked peptide score", targetArtifactHash: digest("a"), modality: "short_peptide",
  budget: { maximumCandidates: 8, gpuHours: 2, wallTimeMinutes: 30 },
  evaluator: { id: "panel", version: "1", sourceHash: digest("b"), direction: "minimize", fixedSeeds: [7], submissionSize: 2 },
})
const experiment = ResearchDomain.Experiment.parse({
  id: "exp_shadow", campaignId, status: "active", contract, contractHash: ResearchDomain.hashContract(contract),
  createdAt: timestamp, updatedAt: timestamp,
})
const context = ResearchAutoresearch.Context.parse({
  experiment,
  target: {
    artifact: {
      format: "autofold.target-artifact.v1", name: "target", chains: [{ id: "A", sequence: "ACDE" }],
      bindingSite: { residues: [{ chainId: "A", position: 1 }] },
    },
    targetArtifactHash: digest("a"), targetArtifactPath: ".autofold/targets/a/target.json",
  },
  incumbentProgram: "def build_program(bundle):\n    return bundle\n",
  history: { trials: [], evaluations: [] }, knowledge: [], literatureClaims: [], literatureRecords: [],
  evidenceAlignments: [], incumbentCandidates: [], incumbentModelEvidence: [], protoToolCatalog: [],
})

function markdown(version: number, extra: string) {
  return `---
id: skill_bionemo.predictor-interpretation
version: ${version}
title: Predictor interpretation
capabilities: [model_diagnostics]
applies_to: [boltz2-prediction]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths: [nim-skills/boltz2-nim/SKILL.md]
  license: Apache-2.0
  attribution: Adapted from NVIDIA BioNeMo Agent Toolkit.
---
# Predictor interpretation
## Guidance
${extra}
## Failure modes
- Correlated confidence.
## Falsifying questions
- Does an independent predictor agree?
`
}
const parentSkill = { ...ResearchSkills.parseMarkdown(markdown(1, "- Preserve disagreement.")), versionId: "skv_parent" }
const candidateSkill = { ...ResearchSkills.parseMarkdown(markdown(2, "- Compare frozen-seed disagreement.")), versionId: "skv_candidate" }
const prepared = SkillShadowReplay.Prepared.parse({ capturedAt: timestamp, context, parent: parentSkill, candidate: candidateSkill })
const parentIteration = ResearchAutoresearch.Iteration.parse({
  iteration: 1, status: "succeeded", trialId: "trl_parent", runId: "run_parent", score: 0.4, valid: true,
})
const candidateIteration = ResearchAutoresearch.Iteration.parse({
  iteration: 1, status: "succeeded", trialId: "trl_candidate", runId: "run_candidate", score: 0.3, valid: true,
})

describe("trusted skill shadow replay", () => {
  test("runs parent and candidate arms from one snapshot and activates only from derived replay", async () => {
    const arms: string[] = []
    const result = await SkillShadowReplay.run(
      {
        campaignId, experimentId: experiment.id, candidateVersionId: candidateSkill.versionId,
        sessionId: "ses_parent", agent: "biology", repetitions: 3,
      },
      { jobId: "job_shadow", onPrepared: async () => undefined },
      {
        prepare: async () => prepared,
        runArm: async ({ arm, prepared: armPrepared, onIteration }) => {
          expect(armPrepared).toEqual(prepared)
          arms.push(arm)
          const iteration = arm === "parent" ? parentIteration : candidateIteration
          await onIteration(iteration)
          return iteration
        },
        score: async (_context, iteration) => ({
          lockedObjectiveUtility: iteration.trialId === "trl_parent" ? -0.4 : -0.3,
          areaUnderImprovementCurve: iteration.trialId === "trl_parent" ? -0.4 : -0.3,
          validDiverseYield: iteration.trialId === "trl_parent" ? 1 : 1.2,
          predictorDisagreement: 0.2, failureRate: 0, computeCost: 2,
        }),
        evaluate: async (_input, _prepared, replay) => ResearchDomain.SkillVersion.parse({
          id: candidateSkill.versionId, campaignId, skillId: candidateSkill.id, version: 2,
          parentVersionId: parentSkill.versionId, path: ".autofold/candidate/SKILL.md",
          contentHash: candidateSkill.contentHash, capabilities: candidateSkill.capabilities,
          appliesToToolKeys: candidateSkill.appliesToToolKeys, status: "active", source: "campaign_refinement",
          trajectoryRefs: ["trl_prior"], createdBy: "capability-refinement", createdAt: timestamp,
          replay: {
            ...replay, baselineVersionId: parentSkill.versionId, candidateVersionId: candidateSkill.versionId,
            passed: true, evaluatedAt: timestamp,
          },
        }),
      },
    )
    expect(arms).toEqual(["parent", "candidate", "parent", "candidate", "parent", "candidate"])
    expect(result.pairs).toHaveLength(3)
    expect(result.finalStatus).toBe("active")
    expect(result.replay.sameBudget).toBe(true)
    expect(result.replay.baseline.lockedObjectiveUtility).toBeCloseTo(-0.4)
    expect(result.replay.candidate.lockedObjectiveUtility).toBeCloseTo(-0.3)
    expect(result.replay.candidate.validDiverseYield).toBeCloseTo(3.6)
  })

  test("normalizes minimizing scores and derives yield only from locked diagnostics", () => {
    const evaluation = ResearchDomain.Evaluation.parse({
      id: "evl_shadow", trialId: "trl_shadow", contractHash: experiment.contractHash,
      evaluatorHash: contract.evaluator.sourceHash, valid: true, score: 0.25,
      diagnostics: { submission_count: 4, panel_diversity: 0.75, predictor_disagreement: 0.2 }, evaluatedAt: timestamp,
    })
    expect(SkillShadowReplay.scoreEvaluation(context, evaluation)).toEqual({
      lockedObjectiveUtility: -0.25,
      areaUnderImprovementCurve: -0.25,
      validDiverseYield: 3,
      predictorDisagreement: 0.2,
      failureRate: 0,
      computeCost: 2,
    })
    expect(SkillShadowReplay.scoreEvaluation(context).failureRate).toBe(1)
    expect(SkillShadowReplay.aggregate([
      SkillShadowReplay.scoreEvaluation(context, evaluation),
      SkillShadowReplay.scoreEvaluation(context, evaluation),
      SkillShadowReplay.scoreEvaluation(context),
    ])).toMatchObject({
      lockedObjectiveUtility: (-0.25 - 0.25 - 1_000_000_000) / 3,
      validDiverseYield: 6,
      failureRate: 1 / 3,
      computeCost: 6,
    })
  })

  test("does not make a skill decision when both arms have no valid evaluation", async () => {
    const failed = {
      iteration: 1,
      status: "authoring_failed" as const,
      error: "invalid manifest",
    }
    await expect(SkillShadowReplay.run({
      campaignId,
      experimentId: experiment.id,
      candidateVersionId: candidateSkill.versionId,
      sessionId: "ses_parent",
      agent: "biology",
      repetitions: 3,
    }, { jobId: "job_shadow" }, {
      prepare: async () => prepared,
      runArm: async () => failed,
      score: async () => SkillShadowReplay.scoreEvaluation(context),
      evaluate: async () => { throw new Error("must not evaluate") },
    })).rejects.toThrow("neither arm produced a valid locked evaluation")
  })
})
