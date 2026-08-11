import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CampaignSkills } from "../src/research/campaign-skills"
import { ResearchService } from "../src/research/service"
import { MemoryResearchStore } from "../src/research/store"

const digest = (character: string) => `sha256:${character.repeat(64)}`
let sequence = 0
const store = new MemoryResearchStore()
const research = new ResearchService.Service(store, {
  id: (prefix) => `${prefix}_demo_${++sequence}`,
  now: () => new Date(Date.UTC(2026, 7, 10, 12, 0, sequence)).toISOString(),
})
const skills = new CampaignSkills.Service(
  store,
  () => new Date(Date.UTC(2026, 7, 10, 12, 0, sequence)).toISOString(),
  (prefix) => `${prefix}_demo_${++sequence}`,
)
const projectId = "project-skill-demo"
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-skill-demo-"))

const campaign = await research.createCampaign(projectId, { objective: "Demonstrate campaign skill RSI" })
await research.activateCampaign(projectId, campaign.id)
const initialized = await skills.initialize(projectId, campaign.id, workspace)
const parent = initialized.find((item) => item.skillId === "skill_bionemo.predictor-interpretation")!
const parentMarkdown = await fs.readFile(path.join(workspace, parent.path), "utf8")

const candidate = await skills.propose(projectId, campaign.id, workspace, parent.skillId, {
  parentVersionId: parent.id,
  markdown: parentMarkdown
    .replace("version: 1", "version: 2")
    .replace(
      "- Preserve disagreement between predictors",
      "- Compare predictor disagreement across frozen seeds before changing routing.\n- Preserve disagreement between predictors",
    ),
  trajectoryRefs: ["trl_demo_failed_route", "evl_demo_disagreement"],
  createdBy: "campaign-supervisor:demo",
})

const baseline = {
  lockedObjectiveUtility: 0.61,
  areaUnderImprovementCurve: 2.4,
  validDiverseYield: 7,
  predictorDisagreement: 0.24,
  failureRate: 0.18,
  computeCost: 12,
}
const activated = await skills.evaluate(projectId, campaign.id, candidate.id, {
  benchmarkId: "frozen-peptide-panel-demo-v1",
  sameBudget: true,
  baseline,
  candidate: { ...baseline, lockedObjectiveUtility: 0.66, validDiverseYield: 8, failureRate: 0.16 },
  campaignIds: [campaign.id],
})
const selectedAfterReplay = (await skills.select(projectId, campaign.id, workspace, ["model_diagnostics"]))
  .find((item) => item.id === parent.skillId)!

const experiment = await research.createExperiment(projectId, campaign.id, {
  contract: {
    version: 1,
    objective: "Improve valid diverse peptide yield",
    targetArtifactHash: digest("a"),
    modality: "short_peptide",
    budget: { maximumCandidates: 16, gpuHours: 1, wallTimeMinutes: 30 },
    evaluator: {
      id: "peptide-panel",
      version: "1",
      sourceHash: digest("b"),
      direction: "maximize",
      fixedSeeds: [7, 11, 23],
      submissionSize: 4,
    },
  },
})
await research.activateExperiment(projectId, experiment.id)
const trial = await research.createTrial(projectId, experiment.id, {
  hypothesis: "Frozen-seed disagreement reasoning improves validator routing",
  designAdapter: "mock",
  programPath: "trials/demo.py",
  programHash: digest("c"),
  skills: [{
    id: selectedAfterReplay.id,
    version: selectedAfterReplay.version,
    versionId: selectedAfterReplay.versionId,
    contentHash: selectedAfterReplay.contentHash,
  }],
})

const rolledBack = await skills.rollback(projectId, campaign.id, parent.id)
const selectedAfterRollback = (await skills.select(projectId, campaign.id, workspace, ["model_diagnostics"]))
  .find((item) => item.id === parent.skillId)!

const regressingCandidate = await skills.propose(projectId, campaign.id, workspace, parent.skillId, {
  parentVersionId: parent.id,
  markdown: parentMarkdown
    .replace("version: 1", "version: 3")
    .replace(
      "- Preserve disagreement between predictors",
      "- Prefer the most optimistic predictor without controls.\n- Preserve disagreement between predictors",
    ),
  trajectoryRefs: ["trl_demo_regression"],
  createdBy: "campaign-supervisor:demo",
})
const rejected = await skills.evaluate(projectId, campaign.id, regressingCandidate.id, {
  benchmarkId: "frozen-peptide-panel-demo-v1",
  sameBudget: true,
  baseline,
  candidate: { ...baseline, lockedObjectiveUtility: 0.55, failureRate: 0.25 },
  campaignIds: [campaign.id],
})

await fs.writeFile(path.join(workspace, parent.path), `${parentMarkdown}\n<!-- unauthorized mutation -->\n`)
let integrityCheck: string
try {
  await skills.select(projectId, campaign.id, workspace, ["model_diagnostics"])
  integrityCheck = "unexpectedly accepted"
} catch (error) {
  integrityCheck = error instanceof Error ? error.message : String(error)
}

console.log(JSON.stringify({
  workspace,
  campaign: { id: campaign.id, objective: campaign.objective },
  initialized: initialized.map((item) => ({ skillId: item.skillId, version: item.version, status: item.status })),
  refinement: {
    parent: { versionId: parent.id, version: parent.version, contentHash: parent.contentHash, path: parent.path },
    candidate: { versionId: candidate.id, version: candidate.version, contentHash: candidate.contentHash, path: candidate.path },
    replay: activated.replay,
    activatedStatus: activated.status,
  },
  selectionAfterReplay: {
    versionId: selectedAfterReplay.versionId,
    version: selectedAfterReplay.version,
    contentHash: selectedAfterReplay.contentHash,
  },
  trialPin: { trialId: trial.id, skills: trial.skills },
  rollback: {
    reactivatedVersionId: rolledBack.id,
    selectedVersionId: selectedAfterRollback.versionId,
    selectedVersion: selectedAfterRollback.version,
  },
  rejectedRegression: {
    versionId: rejected.id,
    status: rejected.status,
    replayPassed: rejected.replay?.passed,
  },
  tamperDetection: integrityCheck,
}, null, 2))
