import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CampaignSkills } from "./campaign-skills"
import { ResearchService } from "./service"
import { MemoryResearchStore } from "./store"

function fixture() {
  let sequence = 0
  const store = new MemoryResearchStore()
  const research = new ResearchService.Service(store, {
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => "2026-08-10T00:00:00.000Z",
  })
  const skills = new CampaignSkills.Service(
    store,
    () => "2026-08-10T00:00:00.000Z",
    (prefix) => `${prefix}_${++sequence}`,
  )
  return { store, research, skills, projectId: "project-skills" }
}

const score = (overrides: Partial<CampaignSkills.ReplayInput["baseline"]> = {}) => ({
  lockedObjectiveUtility: 0.5,
  areaUnderImprovementCurve: 2,
  validDiverseYield: 4,
  predictorDisagreement: 0.2,
  failureRate: 0.1,
  computeCost: 10,
  ...overrides,
})

describe("campaign skill RSI", () => {
  test("copies defaults, versions Markdown immutably, activates by replay, and pins exact selection", async () => {
    const { research, skills, projectId } = fixture()
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-skills-"))
    const campaign = await research.createCampaign(projectId, { objective: "Discover a binder" })
    const initialized = await skills.initialize(projectId, campaign.id, workspace)
    expect(initialized.filter((item) => item.status === "active")).toHaveLength(5)

    const parent = initialized.find((item) => item.skillId === "skill_bionemo.predictor-interpretation")!
    const parentMarkdown = await fs.readFile(path.join(workspace, parent.path), "utf8")
    const proposalInput = {
      parentVersionId: parent.id,
      markdown: parentMarkdown
        .replace("version: 1", "version: 2")
        .replace("- Preserve disagreement", "- Compare frozen-seed disagreement before aggregation.\n- Preserve disagreement"),
      trajectoryRefs: ["trl_7", "evl_7"],
      createdBy: "campaign-supervisor:ses_7",
      origin: { jobId: "job_refine_7", phase: "candidate" },
    }
    const candidate = await skills.propose(projectId, campaign.id, workspace, parent.skillId, proposalInput)
    expect(await skills.propose(projectId, campaign.id, workspace, parent.skillId, proposalInput)).toEqual(candidate)
    expect(candidate.status).toBe("candidate")
    expect(await fs.readFile(path.join(workspace, parent.path), "utf8")).toBe(parentMarkdown)

    const activated = await skills.evaluate(projectId, campaign.id, candidate.id, {
      benchmarkId: "frozen-panel-v1",
      sameBudget: true,
      baseline: score(),
      candidate: score({ lockedObjectiveUtility: 0.6 }),
      campaignIds: [campaign.id],
    })
    expect(activated.status).toBe("active")
    const selected = await skills.select(projectId, campaign.id, workspace, ["model_diagnostics"])
    const chosen = selected.find((item) => item.id === parent.skillId)!
    expect(chosen.version).toBe(2)
    expect(chosen.versionId).toBe(candidate.id)
    expect(chosen.contentHash).toBe(candidate.contentHash)

    const rolledBack = await skills.rollback(projectId, campaign.id, parent.id)
    expect(rolledBack.status).toBe("active")
  })

  test("rejects regressions and requires three-campaign evidence for library promotion", async () => {
    const { research, skills, projectId } = fixture()
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-skills-"))
    const campaigns = []
    for (const objective of ["Campaign A", "Campaign B", "Campaign C"]) {
      campaigns.push(await research.createCampaign(projectId, { objective }))
    }
    const versions = await skills.initialize(projectId, campaigns[0].id, workspace)
    const parent = versions.find((item) => item.skillId === "skill_bionemo.sequence-design")!
    const markdown = await fs.readFile(path.join(workspace, parent.path), "utf8")
    const rejected = await skills.propose(projectId, campaigns[0].id, workspace, parent.skillId, {
      parentVersionId: parent.id,
      markdown: markdown.replace("version: 1", "version: 2").replace("- Preserve exact", "- Audit diversity.\n- Preserve exact"),
      createdBy: "campaign-supervisor",
    })
    expect((await skills.evaluate(projectId, campaigns[0].id, rejected.id, {
      benchmarkId: "frozen-panel-v1", sameBudget: true, baseline: score(),
      candidate: score({ lockedObjectiveUtility: 0.4 }), campaignIds: [campaigns[0].id],
    })).status).toBe("rejected")

    const candidate = await skills.propose(projectId, campaigns[0].id, workspace, parent.skillId, {
      parentVersionId: parent.id,
      markdown: markdown.replace("version: 1", "version: 3").replace("- Preserve exact", "- Measure family entropy.\n- Preserve exact"),
      createdBy: "campaign-supervisor",
    })
    const active = await skills.evaluate(projectId, campaigns[0].id, candidate.id, {
      benchmarkId: "held-out-panel-v1", sameBudget: true, baseline: score(),
      candidate: score({ validDiverseYield: 5 }), campaignIds: campaigns.map((item) => item.id),
    })
    const library = await skills.promoteToLibrary(projectId, campaigns[0].id, active.id)
    expect(library.promotedFromCampaignIds).toHaveLength(3)
    expect(library.sourceVersionId).toBe(active.id)
  })
})
