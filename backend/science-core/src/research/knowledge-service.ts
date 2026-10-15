import { ResearchQuestions } from './research-questions'
import {assertOperationHandle, type OperationDomain} from './operations'
import crypto from 'node:crypto'
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
import { ResearchService } from './service'
import { ResearchDomain } from './domain'
import { CampaignEvidence } from './campaign-evidence'
import { type ResearchState, type ResearchStore } from './store'
import z from 'zod'
import { isDeepStrictEqual } from 'node:util'

/** Campaign knowledge transactions; execution and trial lifecycles stay in ResearchService. */
export class ResearchKnowledgeService {
/** Pure semantic freshness projection over the same decision snapshot. */
static refreshFromSnapshot(state:ResearchState,campaignId:string,now:string) {
      const cycles = Object.values(state.knowledgeCycles)
        .filter((cycle) => cycle.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      const processed = new Set(cycles.flatMap((cycle) => cycle.inputs.knowledgeIds))
      const unprocessedKnowledgeIds = Object.values(state.knowledge)
        .filter((concept) => concept.campaignId === campaignId && !processed.has(concept.id))
        .map((concept) => concept.id)
        .toSorted()
      const pendingQuestions = ResearchQuestions.project(Object.values(state.searchObservations)
        .filter(o => o.campaignId === campaignId), cycles, Object.values(state.researchRequests)
        .filter(request => request.campaignId === campaignId)).filter(q => q.status === "open" && q.origin !== "trusted_closeout")
      // Closeout's generic next-decision questions are visible strategic feedback, not
      // a mandatory interpretation barrier after each run. Explicit scientist
      // requests still interrupt; the first semantic review is independently due.
      // Empirical closeout consumes an outcome, but cannot postpone semantic wiki review.
      // Legacy source-grounded reviews can also use run_completed, so inspect outputs.
      const latest = cycles.find(cycle => cycle.trigger !== "run_completed"
        || cycle.outputs.literatureIds.length > 0 || cycle.outputs.claimIds.length > 0
        || cycle.outputs.alignmentIds.length > 0 || (cycle.outputs.researchRequestUpdates?.length ?? 0) > 0)
      const reasons = [
        ...(!latest ? ["no_prior_knowledge_cycle"] : []),
        ...(pendingQuestions.length ? ["open_research_questions"] : []),
        ...(unprocessedKnowledgeIds.length ? ["new_experiment_results"] : []),
        ...(latest && now >= latest.nextReviewAt ? ["scheduled_refresh_due"] : []),
      ]
      return {
        due: reasons.length > 0,
        reasons,
        unprocessedKnowledgeIds,
        ...(latest ? { nextReviewAt: latest.nextReviewAt } : {}),
      }
}
constructor(private readonly host: {
 store: ResearchStore; now: () => string; id: NonNullable<ResearchService.Options['id']>;
 campaign: (state: ResearchState, id: string) => ResearchDomain.Campaign;
 assertEvidence: (state: ResearchState, scope: CampaignEvidence.Scope, refs: readonly string[], label: string) => void;
}) {}
async listKnowledge(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeConcept[]> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return Object.values(state.knowledge)
        .filter((concept) => concept.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

async getKnowledge(
      projectId: string,
      campaignId: string,
      conceptId: string,
    ): Promise<ResearchDomain.KnowledgeConcept> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      const concept = state.knowledge[conceptId]
      if (!concept || concept.campaignId !== campaignId) {
        throw new ResearchService.NotFoundError({ entity: "knowledge", id: conceptId })
      }
      return concept
    }

async listLiterature(projectId: string, campaignId: string): Promise<ResearchDomain.LiteratureRecord[]> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return Object.values(state.literature)
        .filter((record) => record.campaignId === campaignId)
        .toSorted((a, b) => b.retrievedAt.localeCompare(a.retrievedAt) || a.id.localeCompare(b.id))
    }

async ingestLiterature(
      projectId: string,
      campaignId: string,
      raw: ResearchService.IngestLiteratureInput,
    ): Promise<ResearchDomain.LiteratureRecord> {
      const input = ResearchService.IngestLiteratureInput.parse(raw)
      return this.host.store.mutate(projectId, (state) => {
        this.host.campaign(state, campaignId)
        const canonical = JSON.stringify({
          database: input.database,
          sourceId: input.sourceId,
          title: input.title,
          summary: input.summary,
          excerpts: input.excerpts,
          url: input.url,
        })
        const contentHash = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`
        const existing = Object.values(state.literature).find(
          (record) => record.campaignId === campaignId && record.contentHash === contentHash,
        )
        if (existing) return existing
        const record = ResearchDomain.LiteratureRecord.parse({
          id: this.host.id("lit"),
          campaignId,
          ...input,
          contentHash,
          retrievedAt: this.host.now(),
        })
        state.literature[record.id] = record
        return record
      })
    }

async listClaims(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeClaim[]> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return Object.values(state.claims)
        .filter((claim) => claim.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

async listAlignments(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeAlignment[]> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return Object.values(state.alignments)
        .filter((alignment) => alignment.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

async listKnowledgeCycles(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeCycle[]> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return Object.values(state.knowledgeCycles)
        .filter((cycle) => cycle.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

async knowledgeRefreshStatus(projectId: string, campaignId: string): Promise<{
      due: boolean
      reasons: string[]
      unprocessedKnowledgeIds: string[]
      nextReviewAt?: string
    }> {
      const state = await this.host.store.read(projectId)
      this.host.campaign(state, campaignId)
      return ResearchKnowledgeService.refreshFromSnapshot(state,campaignId,this.host.now())
    }

async reviewAlignment(
      projectId: string,
      campaignId: string,
      alignmentId: string,
      raw: ResearchService.ReviewAlignmentInput,
    ): Promise<ResearchDomain.KnowledgeAlignment> {
      const input = ResearchService.ReviewAlignmentInput.parse(raw)
      return this.host.store.mutate(projectId, (state) => {
        this.host.campaign(state, campaignId)
        const alignment = state.alignments[alignmentId]
        if (!alignment || alignment.campaignId !== campaignId) {
          throw new ResearchService.NotFoundError({ entity: "alignment", id: alignmentId })
        }
        if (input.expectedHash && ResearchService.knowledgeRecordHash(alignment) !== input.expectedHash) {
          throw new ResearchService.ConflictError({ code: "knowledge_review_stale", message: "Alignment changed since the reviewed snapshot" })
        }
        const updated = ResearchDomain.KnowledgeAlignment.parse({
          ...alignment,
          status: input.status,
          reviewed: { by: input.reviewedBy, at: this.host.now() },
        })
        state.alignments[alignment.id] = updated
        return updated
      })
    }

async createClaim(
      projectId: string,
      campaignId: string,
      raw: ResearchService.CreateClaimInput,
    ): Promise<ResearchDomain.KnowledgeClaim> {
      const input = ResearchService.CreateClaimInput.parse(raw)
      return this.host.store.mutate(projectId, (state) => {
        this.host.campaign(state, campaignId)
        for (const evidence of input.evidence) {
          const literature = state.literature[evidence.literatureId]
          if (!literature || literature.campaignId !== campaignId) {
            throw new ResearchService.NotFoundError({ entity: "literature", id: evidence.literatureId })
          }
          if (!evidence.excerpt || !literature.excerpts.includes(evidence.excerpt)) {
            throw new ResearchService.ConflictError({
              code: "claim_excerpt_not_frozen",
              message: `Claim excerpt is not present in literature record ${literature.id}`,
            })
          }
        }
        const claim = ResearchDomain.KnowledgeClaim.parse({
          id: this.host.id("clm"),
          campaignId,
          kind: input.kind,
          statement: input.statement,
          stance: input.stance,
          confidence: input.confidence,
          evidence: input.evidence,
          status: "proposed",
          generated: { by: input.generatedBy, at: this.host.now() },
          createdAt: this.host.now(),
        })
        state.claims[claim.id] = claim
        return claim
      })
    }

async reviewClaim(
      projectId: string,
      campaignId: string,
      claimId: string,
      raw: ResearchService.ReviewClaimInput,
    ): Promise<ResearchDomain.KnowledgeClaim> {
      const input = ResearchService.ReviewClaimInput.parse(raw)
      return this.host.store.mutate(projectId, (state) => {
        this.host.campaign(state, campaignId)
        const claim = state.claims[claimId]
        if (!claim || claim.campaignId !== campaignId) throw new ResearchService.NotFoundError({ entity: "claim", id: claimId })
        if (input.expectedHash && ResearchService.knowledgeRecordHash(claim) !== input.expectedHash) {
          throw new ResearchService.ConflictError({ code: "knowledge_review_stale", message: "Claim changed since the reviewed snapshot" })
        }
        const updated = ResearchDomain.KnowledgeClaim.parse({
          ...claim,
          status: input.status,
          reviewed: { by: input.reviewedBy, at: this.host.now() },
        })
        state.claims[claimId] = updated
        return updated
      })
    }

async reconcileKnowledge(projectId: string, campaignId: string, raw: {
      operationId: string; reviewedBy: string; question: string; campaignSummary: string;
      decisions: Array<{id: string; expectedHash: string; status: "reviewed" | "contested" | "deprecated"; rationale: string; evidenceRefs: string[]}>;
      frozenRecords: Array<{id: string; expectedHash: string}>; unresolvedQuestions: string[];
    }, origin: {jobId: string; leaseId: string}, operationHandle?:OperationDomain.Handle): Promise<ResearchDomain.KnowledgeCycle> {
      const decision = z.object({id: z.string().regex(/^(clm|aln)_[A-Za-z0-9_-]+$/), expectedHash: digest,
        status: z.enum(["reviewed", "contested", "deprecated"]), rationale: z.string().trim().min(1).max(4000),
        evidenceRefs: z.array(z.string().regex(/^(clm|lit|knw|aln|kcy|hyp|srv)_[A-Za-z0-9_-]+$/)).min(1).max(50)}).strict()
      const input = z.object({operationId: z.string().trim().min(1).max(500), reviewedBy: z.string().trim().min(1).max(600),
        question: z.string().trim().min(1).max(2000), campaignSummary: z.string().trim().min(1).max(4000),
        decisions: z.array(decision).min(1).max(100), frozenRecords: z.array(z.object({id: z.string(), expectedHash: digest}).strict()).min(1).max(1000),
        unresolvedQuestions: z.array(z.string().trim().min(1).max(2000)).max(100)}).strict().parse(raw)
      const inputHash = ResearchService.knowledgeRecordHash(input)
      return this.host.store.mutate(projectId, state => {
        if(operationHandle){const operation=assertOperationHandle(state,operationHandle,this.host.now());if(operationHandle.mode!=='run'||operation.kind!=='knowledge_review'||operation.identity.campaignId!==campaignId||operation.identity.jobId!==origin.jobId)throw new Error('Review commit requires the original run operation capability')}
        const campaign = this.host.campaign(state, campaignId), now = this.host.now()
        const job = state.jobs[origin.jobId]
        if (!job || job.projectId !== projectId || job.payload.runtime !== "autofold-pi.v1" || job.payload.kind !== "knowledge_review" || job.payload.campaignId !== campaignId ||
          job.status !== "running" || job.cancelRequestedAt || job.leaseId !== origin.leaseId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(now))
          throw new ResearchService.ConflictError({code: "research_job_commit_fence", message: "Review origin lost its live scientific lease"})
        const seen = new Set([job.id]); let owner = job
        while (owner.payload.parentJobId !== undefined) {
          const id = owner.payload.parentJobId, parent = typeof id === "string" ? state.jobs[id] : undefined
          if (!parent || seen.has(parent.id) || seen.size > 100 || parent.projectId !== projectId || parent.payload.runtime !== "autofold-pi.v1" ||
            parent.status !== "running" || parent.cancelRequestedAt || !parent.leaseId || !parent.leaseExpiresAt || Date.parse(parent.leaseExpiresAt) <= Date.parse(now) || parent.payload.campaignId !== campaignId)
            throw new ResearchService.ConflictError({code: "research_job_commit_fence", message: "Review ancestor lost its live scientific lease"})
          seen.add(parent.id); owner = parent
        }
        const prior = Object.values(state.knowledgeCycles).find(c => c.campaignId === campaignId && (c.reviewAudit as any)?.operationId === input.operationId)
        if (prior) {
          if ((prior.reviewAudit as any).inputHash !== inputHash || (prior.reviewAudit as any).jobId !== origin.jobId)
            throw new ResearchService.ConflictError({code: "knowledge_review_identity", message: "Review operation already committed a different request"})
          return prior
        }
        if (campaign.status !== "active") throw new Error("Review requires an active campaign")
        const contracts = job.payload.contracts as Array<{id:string;contractHash:string}> | undefined
        if (!contracts) throw new Error("Review job lacks frozen scientific contracts")
        for (const frozen of contracts) {
          const experiment = state.experiments[frozen.id]
          if (!experiment || experiment.campaignId !== campaignId || experiment.contractHash !== frozen.contractHash) throw new Error("Review frozen scientific contract changed")
          ResearchDomain.assertContractIntegrity(experiment)
        }

        const tables = [state.claims,state.alignments,state.literature,state.knowledge,state.knowledgeCycles,state.hypotheses,state.scientistReviews] as Array<Record<string, any>>
        const record = (id: string) => tables.map(table => table[id]).find(Boolean)
        const frozen = new Map(input.frozenRecords.map(item => [item.id,item.expectedHash]))
        if (frozen.size !== input.frozenRecords.length || new Set(input.decisions.map(d => d.id)).size !== input.decisions.length) throw new Error("Duplicate review identity")
        for (const item of input.frozenRecords) {
          const current = record(item.id)
          if (!current || current.campaignId !== campaignId || ResearchService.knowledgeRecordHash(current) !== item.expectedHash)
            throw new ResearchService.ConflictError({code: "knowledge_review_stale", message: "Reviewed campaign record or original source changed since its frozen snapshot"})
        }
        const actor = `autofold-pi-knowledge-review/v1:${crypto.createHash("sha256").update(projectId+":"+origin.jobId).digest("hex")}`
        if (input.reviewedBy !== actor) throw new Error("Reviewer actor is bound to its independent host-owned job")
        const allowedIds = new Set([...job.payload.claimIds, ...job.payload.alignmentIds])
        if (input.decisions.length !== allowedIds.size || input.decisions.some(d => !allowedIds.has(d.id))) throw new Error("Review must decide every host-bound target exactly once")
        for (const d of input.decisions) {
          const current = record(d.id)
          if (frozen.get(d.id) !== d.expectedHash || !current || current.generated.by === input.reviewedBy) throw new Error("Review requires the exact independent authored snapshot")
          for (const ref of d.evidenceRefs) if (!frozen.has(ref) || ref === d.id) throw new Error("Review citations require distinct frozen attributable evidence")
          // The authoritative resolver scopes claims, literature, outcomes and alignment citations.
          this.host.assertEvidence(state,{campaignId},d.evidenceRefs.filter(id => !id.startsWith("srv_")),"Review evidence")
          if (d.status === "reviewed") {
            const claim = d.id.startsWith("clm_") ? current : state.claims[current.claimId]
            if (!claim || !claim.evidence.every((e: any) => frozen.has(e.literatureId) && state.literature[e.literatureId]?.excerpts.includes(e.excerpt)))
              throw new Error("Reviewed interpretation requires its original frozen source excerpts")
          }
        }
        const queueTargets = z.array(z.object({id:z.string(),expectedHash:digest}).strict()).min(1).max(1000).parse(job.payload.reviewTargets)
        for (const target of queueTargets) if (frozen.get(target.id) !== target.expectedHash) throw new Error("Review decision changed its queue-bound original snapshot")
        const results = input.decisions.map(d => {
          const table = d.id.startsWith("clm_") ? state.claims : state.alignments, before = table[d.id]!
          const updated = {...before,status:d.status,reviewed:{by:input.reviewedBy,at:now}}
          table[d.id] = (d.id.startsWith("clm_") ? ResearchDomain.KnowledgeClaim : ResearchDomain.KnowledgeAlignment).parse(updated) as any
          return {...d,committedHash:ResearchService.knowledgeRecordHash(table[d.id])}
        })
        const ids = [...new Set(input.decisions.flatMap(d => d.evidenceRefs))]
        const cycle = ResearchDomain.KnowledgeCycle.parse({id:this.host.id("kcy"),campaignId,trigger:"manual",question:input.question,
          inputs:{knowledgeIds:ids.filter(id=>id.startsWith("knw_")),claimIds:[...new Set([...input.decisions.filter(d=>d.id.startsWith("clm_")).map(d=>d.id),...ids.filter(id=>id.startsWith("clm_"))])],literatureIds:ids.filter(id=>id.startsWith("lit_"))},
          outputs:{literatureIds:[],claimIds:input.decisions.filter(d=>d.id.startsWith("clm_")).map(d=>d.id),alignmentIds:input.decisions.filter(d=>d.id.startsWith("aln_")).map(d=>d.id),unresolvedQuestions:input.unresolvedQuestions},
          campaignSummary:input.campaignSummary,generated:{by:input.reviewedBy,at:now},createdAt:now,nextReviewAt:new Date(Date.parse(now)+7*86400000).toISOString(),
          reviewAudit:{operationId:input.operationId,inputHash,jobId:origin.jobId,decisions:results,frozenRecords:input.frozenRecords,authority:"independent_interpretation_not_measurement"}})
        state.knowledgeCycles[cycle.id] = cycle
        return cycle
      })
    }
}
