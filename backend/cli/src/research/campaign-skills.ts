import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ResearchDomain } from "./domain"
import { ResearchService } from "./service"
import { ResearchSkills } from "./research-skills"
import { StorageResearchStore, type ResearchStore } from "./store"

export namespace CampaignSkills {
  export const ReplayInput = z.object({
    benchmarkId: z.string().trim().min(1).max(200),
    sameBudget: z.boolean(),
    baseline: ResearchDomain.SkillReplayScore,
    candidate: ResearchDomain.SkillReplayScore,
    campaignIds: z.array(z.string().startsWith("cmp_")).min(1),
  })
  export type ReplayInput = z.infer<typeof ReplayInput>

  export const ProposeInput = z.object({
    parentVersionId: z.string().startsWith("skv_"),
    markdown: z.string().min(1).max(100_000),
    trajectoryRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
    createdBy: z.string().trim().min(1).max(200),
    origin: ResearchDomain.SkillVersion.shape.origin.optional(),
  })
  export type ProposeInput = z.input<typeof ProposeInput>

  export class Service {
    constructor(
      private readonly store: ResearchStore = new StorageResearchStore(),
      private readonly now: () => string = () => new Date().toISOString(),
      private readonly makeId: (prefix: string) => string = (prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
    ) {}

    async initialize(projectId: string, campaignId: string, workspace: string): Promise<ResearchDomain.SkillVersion[]> {
      const bundled = await bundledSkills()
      const existing = await this.store.read(projectId)
      this.campaign(existing, campaignId)
      const additions: Array<{ skill: ResearchSkills.DomainKnowledge; markdown: string; record: ResearchDomain.SkillVersion }> = []
      for (const item of bundled) {
        if (Object.values(existing.skillVersions).some((version) => version.campaignId === campaignId && version.skillId === item.skill.id)) continue
        const id = this.makeId("skv")
        const relative = versionPath(campaignId, item.skill.id, item.skill.version, item.skill.contentHash)
        additions.push({
          ...item,
          record: ResearchDomain.SkillVersion.parse({
            id,
            campaignId,
            skillId: item.skill.id,
            version: item.skill.version,
            path: relative,
            contentHash: item.skill.contentHash,
            capabilities: item.skill.capabilities,
            appliesToToolKeys: item.skill.appliesToToolKeys,
            status: "active",
            source: "bundled",
            trajectoryRefs: [],
            createdBy: "autofold:bundled",
            createdAt: this.now(),
          }),
        })
      }
      for (const addition of additions) await writeImmutable(workspace, addition.record.path, addition.markdown, addition.record.contentHash)
      if (additions.length) {
        await this.store.mutate(projectId, (state) => {
          this.campaign(state, campaignId)
          for (const addition of additions) {
            const collision = Object.values(state.skillVersions).find(
              (version) => version.campaignId === campaignId && version.skillId === addition.record.skillId,
            )
            if (!collision) state.skillVersions[addition.record.id] = addition.record
          }
        })
      }
      return this.list(projectId, campaignId)
    }

    async list(projectId: string, campaignId: string): Promise<ResearchDomain.SkillVersion[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.skillVersions)
        .filter((version) => version.campaignId === campaignId)
        .toSorted((a, b) => a.skillId.localeCompare(b.skillId) || a.version - b.version)
    }

    async select(
      projectId: string,
      campaignId: string,
      workspace: string,
      capabilities: readonly ResearchSkills.Capability[],
    ): Promise<Array<ResearchSkills.DomainKnowledge & { versionId: string }>> {
      await this.initialize(projectId, campaignId, workspace)
      const requested = new Set(capabilities)
      const versions = (await this.list(projectId, campaignId)).filter(
        (version) => version.status === "active" && version.capabilities.some((capability) => requested.has(capability)),
      )
      return Promise.all(
        versions.map((version) => this.loadVersion(projectId, campaignId, workspace, version.id)),
      )
    }

    async loadVersion(
      projectId: string,
      campaignId: string,
      workspace: string,
      versionId: string,
    ): Promise<ResearchSkills.DomainKnowledge & { versionId: string }> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      const version = state.skillVersions[versionId]
      if (!version || version.campaignId !== campaignId) {
        throw new ResearchService.NotFoundError({ entity: "skill_version", id: versionId })
      }
      const markdown = await fs.readFile(inside(workspace, version.path), "utf8")
      const skill = ResearchSkills.parseMarkdown(markdown)
      if (skill.contentHash !== version.contentHash || skill.id !== version.skillId || skill.version !== version.version) {
        throw new ResearchService.ConflictError({
          code: "skill_integrity_mismatch",
          message: `Skill version ${version.id} no longer matches its immutable record`,
        })
      }
      return { ...skill, versionId: version.id }
    }

    async propose(
      projectId: string,
      campaignId: string,
      workspace: string,
      skillId: string,
      raw: ProposeInput,
    ): Promise<ResearchDomain.SkillVersion> {
      const input = ProposeInput.parse(raw)
      const skill = ResearchSkills.parseMarkdown(input.markdown)
      if (skill.id !== skillId) throw this.conflict("skill_id_mismatch", `Markdown declares ${skill.id}, expected ${skillId}`)
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      const parent = state.skillVersions[input.parentVersionId]
      if (!parent || parent.campaignId !== campaignId || parent.skillId !== skillId) {
        throw new ResearchService.NotFoundError({ entity: "skill_version", id: input.parentVersionId })
      }
      if (input.origin) {
        const existing = Object.values(state.skillVersions).find((version) =>
          version.origin?.jobId === input.origin!.jobId && version.origin.phase === input.origin!.phase,
        )
        if (existing) {
          if (
            existing.campaignId !== campaignId || existing.skillId !== skillId ||
            existing.parentVersionId !== parent.id || existing.contentHash !== skill.contentHash
          ) throw this.conflict("skill_origin_conflict", `Job phase ${input.origin.jobId}:${input.origin.phase} already proposed another skill`)
          return existing
        }
      }
      if (parent.status !== "active") throw this.conflict("skill_parent_not_active", `${parent.id} is not active`)
      const nextVersion = Math.max(0, ...Object.values(state.skillVersions)
        .filter((version) => version.campaignId === campaignId && version.skillId === skillId)
        .map((version) => version.version)) + 1
      if (skill.version !== nextVersion) {
        throw this.conflict("skill_version_not_next", `Markdown version must be ${nextVersion}`)
      }
      if (skill.contentHash === parent.contentHash) throw this.conflict("skill_unchanged", "Candidate is identical to its parent")
      const record = ResearchDomain.SkillVersion.parse({
        id: this.makeId("skv"),
        campaignId,
        skillId,
        version: skill.version,
        parentVersionId: parent.id,
        path: versionPath(campaignId, skillId, skill.version, skill.contentHash),
        contentHash: skill.contentHash,
        capabilities: skill.capabilities,
        appliesToToolKeys: skill.appliesToToolKeys,
        status: "candidate",
        source: "campaign_refinement",
        trajectoryRefs: input.trajectoryRefs,
        createdBy: input.createdBy,
        origin: input.origin,
        createdAt: this.now(),
      })
      await writeImmutable(workspace, record.path, input.markdown, record.contentHash)
      return this.store.mutate(projectId, (draft) => {
        this.campaign(draft, campaignId)
        const current = draft.skillVersions[parent.id]
        if (current?.status !== "active") throw this.conflict("skill_parent_changed", "Active parent changed during proposal")
        draft.skillVersions[record.id] = record
        return record
      })
    }

    async evaluate(projectId: string, campaignId: string, versionId: string, raw: ReplayInput): Promise<ResearchDomain.SkillVersion> {
      const input = ReplayInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const candidate = state.skillVersions[versionId]
        if (!candidate || candidate.campaignId !== campaignId) {
          throw new ResearchService.NotFoundError({ entity: "skill_version", id: versionId })
        }
        if (candidate.status !== "candidate" || !candidate.parentVersionId) {
          throw this.conflict("skill_not_candidate", `${versionId} is not an unevaluated candidate`)
        }
        if (!input.campaignIds.includes(campaignId)) {
          throw this.conflict("replay_campaign_missing", `Replay must include owning campaign ${campaignId}`)
        }
        for (const replayCampaignId of new Set(input.campaignIds)) this.campaign(state, replayCampaignId)
        const parent = state.skillVersions[candidate.parentVersionId]
        if (!parent) throw new ResearchService.NotFoundError({ entity: "skill_version", id: candidate.parentVersionId })
        const passed = replayPassed(input)
        const replay = ResearchDomain.SkillReplay.parse({
          ...input,
          baselineVersionId: parent.id,
          candidateVersionId: candidate.id,
          passed,
          evaluatedAt: this.now(),
        })
        const updated = ResearchDomain.SkillVersion.parse({ ...candidate, status: passed ? "active" : "rejected", replay })
        state.skillVersions[updated.id] = updated
        if (passed) {
          state.skillVersions[parent.id] = ResearchDomain.SkillVersion.parse({ ...parent, status: "superseded" })
        }
        return updated
      })
    }

    async rollback(projectId: string, campaignId: string, targetVersionId: string): Promise<ResearchDomain.SkillVersion> {
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const target = state.skillVersions[targetVersionId]
        if (!target || target.campaignId !== campaignId) {
          throw new ResearchService.NotFoundError({ entity: "skill_version", id: targetVersionId })
        }
        if (target.status !== "active" && target.status !== "superseded") {
          throw this.conflict("skill_not_rollback_target", `${targetVersionId} was never activated`)
        }
        for (const version of Object.values(state.skillVersions)) {
          if (version.campaignId === campaignId && version.skillId === target.skillId && version.status === "active") {
            state.skillVersions[version.id] = ResearchDomain.SkillVersion.parse({ ...version, status: "superseded" })
          }
        }
        const active = ResearchDomain.SkillVersion.parse({ ...target, status: "active" })
        state.skillVersions[target.id] = active
        return active
      })
    }

    async promoteToLibrary(projectId: string, campaignId: string, versionId: string): Promise<ResearchDomain.SkillLibraryEntry> {
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const version = state.skillVersions[versionId]
        if (!version || version.campaignId !== campaignId) {
          throw new ResearchService.NotFoundError({ entity: "skill_version", id: versionId })
        }
        const campaigns = [...new Set(version.replay?.campaignIds ?? [])]
        if (!version.replay?.passed || campaigns.length < 3) {
          throw this.conflict("skill_cross_campaign_validation_required", "Project promotion requires a passing replay across at least three campaigns")
        }
        for (const entry of Object.values(state.skillLibrary)) {
          if (entry.skillId === version.skillId && entry.status === "active") {
            state.skillLibrary[entry.id] = ResearchDomain.SkillLibraryEntry.parse({ ...entry, status: "superseded" })
          }
        }
        const entry = ResearchDomain.SkillLibraryEntry.parse({
          id: this.makeId("slb"), projectId, skillId: version.skillId, sourceVersionId: version.id,
          contentHash: version.contentHash, promotedFromCampaignIds: campaigns, status: "active", createdAt: this.now(),
        })
        state.skillLibrary[entry.id] = entry
        return entry
      })
    }

    private campaign(state: Awaited<ReturnType<ResearchStore["read"]>>, campaignId: string) {
      const campaign = state.campaigns[campaignId]
      if (!campaign) throw new ResearchService.NotFoundError({ entity: "campaign", id: campaignId })
      return campaign
    }

    private conflict(code: string, message: string) {
      return new ResearchService.ConflictError({ code, message })
    }
  }

  export const service = new Service()
}

async function bundledSkills(): Promise<Array<{ skill: ResearchSkills.DomainKnowledge; markdown: string }>> {
  const root = path.resolve(import.meta.dir, "../../skills/autofold-domain")
  const directories = await fs.readdir(root, { withFileTypes: true })
  return Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const markdown = await fs.readFile(path.join(root, entry.name, "SKILL.md"), "utf8")
    return { markdown, skill: ResearchSkills.parseMarkdown(markdown) }
  }))
}

function versionPath(campaignId: string, skillId: string, version: number, hash: string): string {
  return path.posix.join(".autofold", "campaigns", campaignId, "skills", skillId, "versions", `v${version}-${hash.slice(7, 19)}`, "SKILL.md")
}

function inside(workspace: string, relative: string): string {
  const root = path.resolve(workspace)
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error(`Skill path escapes workspace: ${relative}`)
  return target
}

async function writeImmutable(workspace: string, relative: string, markdown: string, expectedHash: string): Promise<void> {
  const target = inside(workspace, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(target, markdown, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    const existing = await fs.readFile(target, "utf8")
    if (ResearchSkills.hash(existing) !== expectedHash) throw new Error(`Immutable skill path collision at ${relative}`)
  }
}

function replayPassed(input: CampaignSkills.ReplayInput): boolean {
  if (!input.sameBudget) return false
  const { baseline, candidate } = input
  const noRegression =
    candidate.lockedObjectiveUtility >= baseline.lockedObjectiveUtility &&
    candidate.areaUnderImprovementCurve >= baseline.areaUnderImprovementCurve &&
    candidate.validDiverseYield >= baseline.validDiverseYield &&
    candidate.failureRate <= baseline.failureRate &&
    candidate.computeCost <= baseline.computeCost
  const improved =
    candidate.lockedObjectiveUtility > baseline.lockedObjectiveUtility ||
    candidate.areaUnderImprovementCurve > baseline.areaUnderImprovementCurve ||
    candidate.validDiverseYield > baseline.validDiverseYield ||
    candidate.failureRate < baseline.failureRate ||
    candidate.computeCost < baseline.computeCost
  return noRegression && improved
}
