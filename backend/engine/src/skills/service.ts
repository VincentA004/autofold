import {assertOperationHandle,type OperationDomain} from "@autofold/science-core/operations"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ResearchDomain } from "@autofold/science-core/domain"
import { ResearchService } from "@autofold/science-core/service"
import { ResearchSkills } from "@autofold/science-core/research-skills"
import type { ResearchStore } from "@autofold/science-core/store"
import { CampaignEvidence } from "@autofold/science-core/campaign-evidence"
import { checkedPath } from "../execution/paths"
import type { ScientificExecution } from "../execution"
import type { PiSessionStore } from "../runtime"
import { aggregate, replayPassed, scoreEvaluation, pairedEvidence } from "./policy"

/** Verify an immutable version against the already sampled record, without a live reread. */
export async function loadSnapshotSkill(workspace:string,version:ResearchDomain.SkillVersion):Promise<ResearchSkills.DomainKnowledge & {versionId:string}> {
  const markdown=await fs.readFile(await checkedPath(workspace,version.path),'utf8'),skill=ResearchSkills.parseMarkdown(markdown)
  if(skill.contentHash!==version.contentHash||skill.id!==version.skillId||skill.version!==version.version)
    throw new ResearchService.ConflictError({code:'skill_integrity_mismatch',message:`Skill version ${version.id} no longer matches its immutable record`})
  return {...skill,versionId:version.id}
}

export namespace CampaignSkills {
  export const Receipt = z.object({ runId: z.string().startsWith("run_"), sessionId: z.string().startsWith("ses_") }).strict()
  export const ReplayInput = z.object({ benchmarkId: z.string().min(1).max(200), campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"), pairs: z.array(z.object({ parent: Receipt, candidate: Receipt }).strict()).min(3).max(5) }).strict()
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
      private readonly store: ResearchStore,
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
      return loadSnapshotSkill(workspace,version)
    }

    async propose(
      projectId: string,
      campaignId: string,
      workspace: string,
      skillId: string,
      raw: ProposeInput,
      trustedOrigin?: {jobId: string; leaseId: string},
      operationHandle?:OperationDomain.Handle,
    ): Promise<ResearchDomain.SkillVersion> {
      const input = ProposeInput.parse(raw)
      const skill = ResearchSkills.parseMarkdown(input.markdown)
      if (skill.id !== skillId) throw this.conflict("skill_id_mismatch", `Markdown declares ${skill.id}, expected ${skillId}`)
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      CampaignEvidence.resolve(state, {campaignId}).assert(input.trajectoryRefs, "Skill refinement evidence")
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
            existing.parentVersionId !== parent.id || existing.contentHash !== skill.contentHash || JSON.stringify(existing.trajectoryRefs) !== JSON.stringify(input.trajectoryRefs) || existing.createdBy !== input.createdBy
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
        if(operationHandle){const operation=assertOperationHandle(draft,operationHandle,this.now());if(operationHandle.mode!=='run'||operation.kind!=='capability_refinement'||operation.identity.campaignId!==campaignId||operation.identity.skillId!==skillId||operation.jobId&&operation.jobId!==trustedOrigin?.jobId)throw new Error('Refinement commit requires the original run operation capability')}
        this.campaign(draft, campaignId)
        if (input.origin) {
          const existing = Object.values(draft.skillVersions).find(version => version.origin?.jobId === input.origin!.jobId && version.origin.phase === input.origin!.phase)
          if (existing) {
            if (existing.campaignId !== campaignId || existing.parentVersionId !== parent.id || existing.contentHash !== record.contentHash || JSON.stringify(existing.trajectoryRefs) !== JSON.stringify(record.trajectoryRefs)) throw this.conflict("skill_origin_conflict", "Proposal origin is bound to another immutable refinement")
            return existing
          }
        }
        CampaignEvidence.resolve(draft, {campaignId}).assert(input.trajectoryRefs, "Skill refinement evidence")
        if (Object.values(draft.skillVersions).some(version => version.campaignId === campaignId && version.skillId === skillId && version.version === record.version)) throw this.conflict("skill_version_conflict", "Skill version was concurrently proposed")
        if (input.origin && draft.jobs[input.origin.jobId]?.status === "cancelled") throw this.conflict("skill_job_cancelled", "Cancelled job cannot commit a skill proposal")
        if (trustedOrigin) assertCommitOrigin(draft, trustedOrigin)
        const current = draft.skillVersions[parent.id]
        if (current?.status !== "active") throw this.conflict("skill_parent_changed", "Active parent changed during proposal")
        draft.skillVersions[record.id] = record
        return record
      })
    }

    /** Host-only API: derive scores from verified immutable receipts and independently bound Pi transcripts. */
    async evaluate(projectId: string, campaignId: string, versionId: string, raw: ReplayInput,
      execution: ScientificExecution, sessions: PiSessionStore, policy: {allowPlumbingOnly?: boolean; origin?: {jobId: string; leaseId: string};operationHandle?:OperationDomain.Handle} = {}): Promise<ResearchDomain.SkillVersion> {
      const input = ReplayInput.parse(raw), state = await this.store.read(projectId)
      this.campaign(state, campaignId); this.campaign(state, input.campaignId)
      const candidate = state.skillVersions[versionId], parent = candidate?.parentVersionId ? state.skillVersions[candidate.parentVersionId] : undefined
      if (!candidate || candidate.campaignId !== campaignId || !parent) throw this.conflict("skill_not_candidate", "Candidate and its exact parent are required")
      const experiment = state.experiments[input.experimentId]
      if (!experiment || experiment.campaignId !== input.campaignId) throw this.conflict("replay_scope_mismatch", "Replay experiment is outside the validation campaign")
      ResearchDomain.assertContractIntegrity(experiment)
      let scientific = true
      const originJobs = new Set<string>()
      const programHashes = new Set<string>(), sessionIds = new Set<string>(), runIds = new Set<string>()
      const scores: Record<"parent" | "candidate", ResearchDomain.SkillReplayScore[]> = {parent: [], candidate: []}
      const identities: Record<"parent" | "candidate", string[]> = {parent:[],candidate:[]}
      for (const pair of input.pairs) for (const arm of ["parent", "candidate"] as const) {
        const receipt = pair[arm], skill = arm === "parent" ? parent : candidate
        const artifacts = await execution.artifacts(receipt.runId), transcript = await sessions.get(receipt.sessionId)
        scientific &&= artifacts.scientific
        if (!artifacts.scientific && !policy.allowPlumbingOnly) throw this.conflict("replay_scientific_evidence_required", "Plumbing-only worker outcomes cannot activate scientific domain skills")
        const trial = artifacts.trial
        if (trial.experimentId !== experiment.id || trial.intent !== "shadow_replay" || artifacts.incumbent ||
          artifacts.evaluation.contractHash !== experiment.contractHash ||
          !trial.skills.some(ref => ref.versionId === skill.id && ref.contentHash === skill.contentHash) ||
          transcript?.metadata.projectId !== projectId || transcript.metadata.experimentId !== experiment.id ||
          transcript.metadata.contractHash !== experiment.contractHash || transcript.metadata.skillVersionId !== skill.id ||
          transcript.metadata.shadowArm !== arm || transcript.metadata.benchmarkId !== input.benchmarkId ||
          trial.origin?.jobId !== transcript.metadata.originJobId || trial.origin?.phase !== transcript.metadata.originPhase)
          throw this.conflict("replay_receipt_mismatch", "Shadow receipt and independent host transcript do not match the frozen arm")
        if (programHashes.has(trial.programHash) || sessionIds.has(receipt.sessionId) || runIds.has(receipt.runId))
          throw this.conflict("replay_not_independent", "Each paired arm requires an independent session, program and run")
        originJobs.add(trial.origin!.jobId)
        programHashes.add(trial.programHash); sessionIds.add(receipt.sessionId); runIds.add(receipt.runId)
        scores[arm].push(scoreEvaluation(experiment, artifacts.evaluation))
        identities[arm].push(JSON.stringify(artifacts.candidates.candidates.map(c=>c.sequence).sort()))
      }
      const baseline = aggregate(scores.parent), revised = aggregate(scores.candidate)
      const paired=pairedEvidence(scores.parent.map((parent,i)=>({parent,candidate:scores.candidate[i]!,sameCandidates:identities.parent[i]===identities.candidate[i],parentIdentity:identities.parent[i],candidateIdentity:identities.candidate[i]})))
      const replay = ResearchDomain.SkillReplay.parse({benchmarkId: input.benchmarkId, baselineVersionId: parent.id, candidateVersionId: candidate.id,
        scoreSemantics: {computeCost: "reserved_gpu_hours", areaUnderImprovementCurve: "sum_of_valid_trial_utilities", validationScope: "paired_single_context", activationPolicy:"paired_valid_v2",
          limitations:["Single-context computational comparison; not statistical or biological validation", "Equal reserved budgets and scoring seeds do not establish matched upstream generation randomness or actual runtime savings", "Guidance application is prospective scientist interpretation, not causal proof", "One-candidate diversity and absent disagreement diagnostics are unavailable"]},
        sameBudget: true, baseline, candidate: revised, pairedEvidence:paired,
        decisionReason:baseline.failureRate===1&&revised.failureRate===1?"no_valid_evaluations":paired.validPairs<2?"insufficient_independent_valid_pairs":replayPassed({sameBudget:true,baseline,candidate:revised,paired})?"repeated_valid_paired_gains":"paired_gain_or_nonregression_requirement_not_met", campaignIds: [input.campaignId], passed: replayPassed({sameBudget: true, baseline, candidate: revised,paired}),
        evaluatedAt: this.now(), evidenceKind: scientific ? "scientific" : "plumbing_only", receiptPairs: input.pairs, experimentId: experiment.id, contractHash: experiment.contractHash})
      return this.store.mutate(projectId, draft => {
        if(policy.operationHandle){const operation=assertOperationHandle(draft,policy.operationHandle,this.now());if(policy.operationHandle.mode!=='run'||operation.kind!=='skill_shadow_replay'||operation.identity.campaignId!==campaignId||operation.identity.candidateVersionId!==versionId||operation.jobId&&operation.jobId!==policy.origin?.jobId)throw new Error('Replay commit requires the original run operation capability')}
        const current = draft.skillVersions[versionId], currentParent = draft.skillVersions[parent.id]
        if (!current || current.contentHash !== candidate.contentHash || currentParent?.contentHash !== parent.contentHash || draft.experiments[experiment.id]?.contractHash !== experiment.contractHash)
          throw this.conflict("replay_context_changed", "Frozen replay context changed")
        const validations = Array.isArray(current.validations) ? current.validations as ResearchDomain.SkillReplay[] : []
        const existing = validations.find(value => value.benchmarkId === input.benchmarkId)
        if (existing) {
          if (JSON.stringify(existing.receiptPairs) !== JSON.stringify(input.pairs)) throw this.conflict("replay_identity_conflict", "Benchmark already contains another receipt set")
          return current
        }
        if ([...originJobs].some(id => draft.jobs[id]?.status === "cancelled")) throw this.conflict("skill_job_cancelled", "Cancelled job cannot commit replay activation")
        if (policy.origin) assertCommitOrigin(draft, policy.origin)
        const local = input.campaignId === campaignId
        if (local && current.status !== "candidate") throw this.conflict("skill_not_candidate", "Only an unevaluated candidate can change campaign activation")
        if (local && currentParent.status !== "active") throw this.conflict("skill_parent_changed", "Active parent changed before replay activation")
        const updated = ResearchDomain.SkillVersion.parse({...current, validations: [...validations, replay],
          ...(local ? {status: replay.passed ? "active" : "rejected", replay} : {})})
        draft.skillVersions[updated.id] = updated
        if (local && replay.passed) draft.skillVersions[parent.id] = ResearchDomain.SkillVersion.parse({...currentParent, status: "superseded"})
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

    async promoteToLibrary(projectId: string, campaignId: string, versionId: string, policy: {allowPlumbingOnly?: boolean} = {}): Promise<ResearchDomain.SkillLibraryEntry> {
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const version = state.skillVersions[versionId]
        if (!version || version.campaignId !== campaignId) {
          throw new ResearchService.NotFoundError({ entity: "skill_version", id: versionId })
        }
        const validations = Array.isArray(version.validations) ? version.validations as ResearchDomain.SkillReplay[] : []
        const campaigns = [...new Set(validations.filter(value => value.passed && (value.evidenceKind === "scientific" || policy.allowPlumbingOnly) && value.candidateVersionId === version.id && Array.isArray(value.receiptPairs) && value.receiptPairs.length >= 3).flatMap(value => value.campaignIds))]
        if (version.status !== "active" || !version.replay?.passed || campaigns.length < 3) {
          throw this.conflict("skill_cross_campaign_validation_required", "Project promotion requires a passing replay across at least three campaigns")
        }
        const existing = Object.values(state.skillLibrary).find(entry => entry.sourceVersionId === version.id && entry.status === "active")
        if (existing) return existing
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

}

async function bundledSkills(): Promise<Array<{ skill: ResearchSkills.DomainKnowledge; markdown: string }>> {
  const root = path.resolve(import.meta.dir, "bundled")
  const directories = await fs.readdir(root, { withFileTypes: true })
  return Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const markdown = await fs.readFile(path.join(root, entry.name, "SKILL.md"), "utf8")
    return { markdown, skill: ResearchSkills.parseMarkdown(markdown) }
  }))
}

function versionPath(campaignId: string, skillId: string, version: number, hash: string): string {
  return path.posix.join(".autofold", "campaigns", campaignId, "skills", skillId, "versions", `v${version}-${hash.slice(7, 19)}`, "SKILL.md")
}

async function writeImmutable(workspace: string, relative: string, markdown: string, expectedHash: string): Promise<void> {
  let target = await checkedPath(workspace, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  target = await checkedPath(workspace, relative)
  try {
    await fs.writeFile(target, markdown, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    const existing = await fs.readFile(target, "utf8")
    if (ResearchSkills.hash(existing) !== expectedHash) throw new Error(`Immutable skill path collision at ${relative}`)
  }
}

export class CampaignSkillService {
  readonly service: CampaignSkills.Service
  constructor(readonly options: {store: ResearchStore; workspace: string; projectId: string; allowPlumbingOnly?: boolean}) {
    if (!path.isAbsolute(options.workspace) || !options.projectId) throw new Error("Skills require explicit absolute host workspace and project")
    this.service = new CampaignSkills.Service(options.store)
  }
  initialize(campaignId: string) {return this.service.initialize(this.options.projectId, campaignId, this.options.workspace)}
  list(campaignId: string) {return this.service.list(this.options.projectId, campaignId)}
  select(campaignId: string, capabilities: readonly ResearchSkills.Capability[]) {return this.service.select(this.options.projectId, campaignId, this.options.workspace, capabilities)}
  loadVersion(campaignId: string, versionId: string) {return this.service.loadVersion(this.options.projectId, campaignId, this.options.workspace, versionId)}
  propose(campaignId: string, skillId: string, input: CampaignSkills.ProposeInput, origin?: {jobId: string; leaseId: string},operationHandle?:OperationDomain.Handle) {return this.service.propose(this.options.projectId, campaignId, this.options.workspace, skillId, input, origin,operationHandle)}
  evaluate(campaignId: string, versionId: string, input: CampaignSkills.ReplayInput, execution: ScientificExecution, sessions: PiSessionStore, policy: {allowPlumbingOnly?: boolean; origin?: {jobId: string; leaseId: string};operationHandle?:OperationDomain.Handle} = {}) {return this.service.evaluate(this.options.projectId, campaignId, versionId, input, execution, sessions, policy)}
  rollback(campaignId: string, versionId: string) {return this.service.rollback(this.options.projectId, campaignId, versionId)}
  promoteToLibrary(campaignId: string, versionId: string) {return this.service.promoteToLibrary(this.options.projectId, campaignId, versionId, {allowPlumbingOnly: this.options.allowPlumbingOnly})}
}

function assertCommitOrigin(state: Awaited<ReturnType<ResearchStore["read"]>>, origin: {jobId: string; leaseId: string}) {
  const job = state.jobs[origin.jobId]
  if (!job || job.status !== "running" || job.leaseId !== origin.leaseId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now())
    throw new ResearchService.ConflictError({code: "skill_job_commit_fence", message: "Skill origin job lost its active commit lease"})
}
