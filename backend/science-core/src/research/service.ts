import {ResearchTrajectoryObservation} from './trajectory-observation'
import type {ResearchTrajectoryCloseout} from './trajectory-closeout'
import { ResearchKnowledgeService } from './knowledge-service'
import {assertOperationHandle,operationHash,type OperationDomain} from "./operations"
import { ScientistReview } from "./scientist-review"
import { ExperimentBranches } from "./experiment-branches"
import { ResearchQuestions } from "./research-questions"
import { TrialReasoning } from "./trial-reasoning"
import { CampaignResources } from "./campaign-resources"
import crypto from "node:crypto"
import z from "zod"
import { NamedError } from "../util/error"
import { Lock } from "../util/lock"
import { ResearchDomain } from "./domain"
import { ResearchKnowledge } from "./knowledge"
import { ResearchSkills } from "./research-skills"
import { type ResearchState, type ResearchStore } from "./store"
import { CampaignEvidence } from "./campaign-evidence"
import { ResearchJobService } from "./job-service"
import { isDeepStrictEqual } from "node:util"

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ResearchService {

  /** Canonical snapshot identity for review CAS; hashes do not certify truth. */
  export function knowledgeRecordHash(value: unknown): string {
    const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
      : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable((item as Record<string, unknown>)[key])])) : item
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`
  }


  /** Read-only strategic policy view. Legacy bootstrap remains an explicit owner action. */
  export function campaignSnapshot(state:ResearchState,campaignId:string) {
    if(!state.campaigns[campaignId])throw new Error('Campaign is missing from the decision snapshot')
    if(!state.campaignCharters[campaignId])throw new Error('Campaign charter is missing; authorized initialization is required before policy decisions')
        return {
          charter:state.campaignCharters[campaignId]!,
          resources: CampaignResources.summarize(state, campaignId),
          researchQuestions: ResearchQuestions.project(Object.values(state.searchObservations).filter(o => o.campaignId === campaignId), Object.values(state.knowledgeCycles), Object.values(state.researchRequests).filter(request => request.campaignId === campaignId)),
          evidenceCatalog: [...CampaignEvidence.collect(state).values()].filter(reference => reference.campaignId === campaignId),
          hypotheses: Object.values(state.hypotheses)
            .filter((hypothesis) => hypothesis.campaignId === campaignId)
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)),
          searchObservations: Object.values(state.searchObservations)
            .filter((observation) => observation.campaignId === campaignId && !(
              observation.decision === "failed" && state.runs[observation.runId]?.status === "succeeded" &&
              Object.values(state.evaluations).some(evaluation => evaluation.trialId === observation.trialId)
            )) // Historical failures remain in storage/OKF, not the current search landscape.
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)),
          trialCount: Object.values(state.trials).filter((trial) =>
            state.experiments[trial.experimentId]?.campaignId === campaignId
          ).length,
        }
  }

  export const knowledgeRefreshFromSnapshot=ResearchKnowledgeService.refreshFromSnapshot

  export const NotFoundError = NamedError.create(
    "ResearchNotFoundError",
    z.object({
      entity: z.enum([
        "campaign",
        "experiment",
        "trial",
        "evaluation",
        "run",
        "knowledge",
        "literature",
        "claim",
        "alignment",
        "knowledge_cycle",
        "campaign_charter",
        "hypothesis",
        "search_observation",
        "skill_version",
      ]),
      id: z.string(),
    }),
  )

  export const ConflictError = NamedError.create(
    "ResearchConflictError",
    z.object({ code: z.string(), message: z.string() }),
  )

  export const CreateCampaignInput = z.object({
    objective: z.string().trim().min(1),
    knowledgeCatalogId: z.string().trim().min(1).optional(),
  })
  export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>

  export const CreateExperimentInput = z.object({ contract: ResearchDomain.ExperimentContract })
  export type CreateExperimentInput = z.infer<typeof CreateExperimentInput>

  export const CreateTrialInput = z.object({
    executionProtocol: ResearchDomain.Trial.shape.executionProtocol,
    methodologyProfile: ResearchDomain.Trial.shape.methodologyProfile,
    hypothesis: z.string().trim().min(1),
    intent: ResearchDomain.Trial.shape.intent.default("optimize"),
    decisionPlan: ResearchDomain.Trial.shape.decisionPlan,
    prediction: ResearchDomain.Trial.shape.prediction,
    graphEvidenceUse: ResearchDomain.Trial.shape.graphEvidenceUse,
    decisionMemoryExposure:ResearchDomain.Trial.shape.decisionMemoryExposure,
    evidenceRefs: ResearchDomain.Trial.shape.evidenceRefs,
    calibrationClass: ResearchDomain.Trial.shape.calibrationClass,
    replicateOfTrialId: ResearchDomain.Trial.shape.replicateOfTrialId,
    generationSeed: ResearchDomain.Trial.shape.generationSeed,
    configurationFamilyFingerprint: ResearchDomain.Trial.shape.configurationFamilyFingerprint,
    semanticProgramFingerprint: ResearchDomain.Trial.shape.semanticProgramFingerprint,
    workflowFingerprint: ResearchDomain.Trial.shape.workflowFingerprint,
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1).max(4_000),
    programHash: digest,
    generators: ResearchDomain.Trial.shape.generators.default([]),
    generatorAllocations: ResearchDomain.Trial.shape.generatorAllocations.default([]),
    parentTrialId: z.string().startsWith("trl_").optional(),
    origin: ResearchDomain.Trial.shape.origin.optional(),
    skills: z.array(ResearchSkills.Reference).max(30).default([]),
  })
  export type CreateTrialInput = z.input<typeof CreateTrialInput>

  export const RecordEvaluationInput = z
    .object({
      contractHash: digest,
      evaluatorHash: digest,
      valid: z.boolean(),
      score: z.number().finite().nullable(),
      diagnostics: z.record(z.string(), z.number().finite()).default({}),
    })
    .superRefine((value, context) => {
      if (value.valid && value.score === null) {
        context.addIssue({ code: "custom", message: "A valid evaluation must include a score", path: ["score"] })
      }
    })
  export type RecordEvaluationInput = z.infer<typeof RecordEvaluationInput>

  export const IngestLiteratureInput = z.object({
    database: z.string().trim().min(1),
    sourceId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    excerpts: z.array(z.string().trim().min(1).max(4_000)).max(50).default([]),
    url: z.string().url().optional(),
    query: z.string().trim().min(1),
  })
  export type IngestLiteratureInput = z.infer<typeof IngestLiteratureInput>

  export const CreateClaimInput = z.object({
    kind: ResearchDomain.KnowledgeClaim.shape.kind,
    statement: ResearchDomain.KnowledgeClaim.shape.statement,
    stance: ResearchDomain.KnowledgeClaim.shape.stance,
    confidence: ResearchDomain.KnowledgeClaim.shape.confidence,
    evidence: ResearchDomain.KnowledgeClaim.shape.evidence,
    generatedBy: z.string().trim().min(1).default("autofold-agent/v1"),
  })
  export type CreateClaimInput = z.infer<typeof CreateClaimInput>

  export const ReviewClaimInput = z.object({
    status: z.enum(["reviewed", "contested", "deprecated"]),
    reviewedBy: z.string().trim().min(1).max(200),
    expectedHash: digest.optional(),
  })
  export type ReviewClaimInput = z.infer<typeof ReviewClaimInput>

  export const ReviewAlignmentInput = z.object({
    status: z.enum(["reviewed", "contested", "deprecated"]),
    reviewedBy: z.string().trim().min(1).max(200),
    expectedHash: digest.optional(),
  })
  export type ReviewAlignmentInput = z.infer<typeof ReviewAlignmentInput>

  export const LiteratureReviewInput = z
    .object({
      generatedBy: z.string().trim().min(1),
      sources: z
        .array(
          IngestLiteratureInput.extend({
            key: z.string().trim().min(1).max(500),
            excerpts: z.array(z.string().trim().min(1).max(4_000)).min(1).max(50),
          }),
        )
        .max(50),
      claims: z
        .array(
          z.object({
            kind: CreateClaimInput.shape.kind,
            statement: CreateClaimInput.shape.statement,
            stance: CreateClaimInput.shape.stance,
            confidence: CreateClaimInput.shape.confidence,
            evidence: z
              .array(
                z.object({
                  sourceKey: z.string().trim().min(1).max(500),
                  excerpt: z.string().trim().min(1).max(4_000),
                }),
              )
              .min(1)
              .max(100),
            alignments: z
              .array(
                z.object({
                  knowledgeId: z.string().startsWith("knw_"),
                  relation: ResearchDomain.KnowledgeAlignment.shape.relation,
                  rationale: ResearchDomain.KnowledgeAlignment.shape.rationale,
                }),
              )
              .max(100)
              .optional(),
          }),
        )
        .max(50),
      researchRequestUpdates: z.array(ResearchQuestions.Proposal).max(10).default([]),
      unresolvedQuestions: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
      campaignSummary: z.string().trim().min(1).max(4_000).optional(),
      nextExperiment: ResearchDomain.NextExperimentProposal.optional(),
      question: z.string().trim().min(1).max(2_000).optional(),
      trigger: ResearchDomain.KnowledgeCycle.shape.trigger.default("literature_review"),
      inputKnowledgeIds: z.array(z.string().startsWith("knw_")).max(1_000).default([]),
      inputClaimIds: z.array(z.string().startsWith("clm_")).max(1_000).default([]),
      inputLiteratureIds: z.array(z.string().startsWith("lit_")).max(1_000).default([]),
      hypothesisUpdates: z.array(z.object({
        hypothesisId: z.string().startsWith("hyp_").optional(),
        category: ResearchDomain.ResearchHypothesis.shape.category,
        statement: ResearchDomain.ResearchHypothesis.shape.statement,
        status: ResearchDomain.ResearchHypothesis.shape.status,
        confidence: ResearchDomain.ResearchHypothesis.shape.confidence,
        evidenceLevel: ResearchDomain.EpistemicLevel,
        supportingEvidenceRefs: z.array(ResearchDomain.EvidenceRef).max(100).default([]),
        opposingEvidenceRefs: z.array(ResearchDomain.EvidenceRef).max(100).default([]),
        prediction: ResearchDomain.ResearchHypothesis.shape.prediction,
        falsificationCriterion: ResearchDomain.ResearchHypothesis.shape.falsificationCriterion,
        recommendedExperiment: ResearchDomain.ResearchHypothesis.shape.recommendedExperiment,
        limitations: ResearchDomain.ResearchHypothesis.shape.limitations.default([]),
      })).max(20).default([]),
      searchObservations: z.array(ResearchDomain.SearchObservation.omit({
        id: true,
        campaignId: true,
        knowledgeCycleId: true,
        epistemicLevel: true,
        createdAt: true,
      })).max(100).default([]),
    })
    .superRefine((review, context) => {
      const keys = new Set(review.sources.map((source) => source.key))
      if (keys.size !== review.sources.length) {
        context.addIssue({ code: "custom", path: ["sources"], message: "Literature source keys must be unique" })
      }
      for (const [claimIndex, claim] of review.claims.entries()) {
        const evidenceKeys = new Set(claim.evidence.map((evidence) => evidence.sourceKey))
        if (evidenceKeys.size !== claim.evidence.length) {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "evidence"],
            message: "Claim evidence source keys must be unique",
          })
        }
        for (const [evidenceIndex, evidence] of claim.evidence.entries()) {
          if (!keys.has(evidence.sourceKey)) {
            context.addIssue({
              code: "custom",
              path: ["claims", claimIndex, "evidence", evidenceIndex, "sourceKey"],
              message: `Unknown literature source key: ${evidence.sourceKey}`,
            })
          }
        }
      }
      if (review.claims.length === 0 && review.unresolvedQuestions.length === 0 && !(review.campaignSummary && review.researchRequestUpdates.length)) {
        context.addIssue({
          code: "custom",
          path: ["unresolvedQuestions"],
          message: "A review with no supported claims must record an unresolved question",
        })
      }
    })
  export type LiteratureReviewInput = z.input<typeof LiteratureReviewInput>

  export const RequestResearchInput = z.object({
    request: TrialReasoning.ResearchRequest,
    evidenceRefs: TrialReasoning.EvidenceRefs.default([]),
    generatedBy: z.string().trim().min(1),
  }).superRefine((input, context) => {
    if (input.request.action !== "create" && input.request.action !== "reopen") {
      context.addIssue({ code: "custom", path: ["request", "action"],
        message: "Durable research work requires action=create or reopen; reference is an annotation and schedules no work" })
    }
  })
  export type RequestResearchInput = z.input<typeof RequestResearchInput>

  export interface Options {
    now?: () => string
    logger?: { warn(message: string, data?: Record<string, unknown>): void }
    id?: (prefix: "cmp" | "exp" | "trl" | "evl" | "run" | "knw" | "lit" | "clm" | "aln" | "kcy" | "chr" | "hyp" | "sobs" | "rq") => string
  }

  export interface EvaluationResult {
    evaluation: ResearchDomain.Evaluation
    trial: ResearchDomain.Trial
    experiment: ResearchDomain.Experiment
    decision: "promoted" | "rejected" | "observed"
    knowledge: ResearchDomain.KnowledgeConcept
  }

  export class Service {
    readonly knowledge: ResearchKnowledgeService
    private readonly log: { warn(message: string, data?: Record<string, unknown>): void }
    private readonly now: () => string
    private readonly id: (
      prefix: "cmp" | "exp" | "trl" | "evl" | "run" | "knw" | "lit" | "clm" | "aln" | "kcy" | "chr" | "hyp" | "sobs" | "rq",
    ) => string

    constructor(
      private readonly store: ResearchStore,
      options: Options = {},
    ) {
      this.log = options.logger ?? { warn() {} }
      this.now = options.now ?? (() => new Date().toISOString())
      this.id = options.id ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`)
      this.knowledge = new ResearchKnowledgeService({store, now: this.now, id: this.id, campaign: this.campaign.bind(this), assertEvidence: this.assertEvidence.bind(this)})
    }

    async listCampaigns(projectId: string): Promise<ResearchDomain.Campaign[]> {
      const state = await this.store.read(projectId)
      return Object.values(state.campaigns).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async scientistReviews(projectId: string, experimentId: string) {
      const state = await this.store.read(projectId)
      this.experiment(state, experimentId)
      return Object.values(state.scientistReviews).filter(r => r.experimentId === experimentId)
    }
    async recordScientistReview(projectId: string, experimentId: string, input: z.input<typeof ScientistReview.Input>, evidenceSummary: unknown) {
      return this.store.mutate(projectId, state => ScientistReview.commit(state, experimentId, input, evidenceSummary, this.now()))
    }
    async experimentBranches(projectId:string,experimentId:string) {
      const state=await this.store.read(projectId)
      this.experiment(state,experimentId)
      return ExperimentBranches.list(state,experimentId)
    }
    async bindExperimentDraft(projectId: string, experimentId: string, draftPath: string, program: string) {
      return this.store.mutate(projectId, state => ExperimentBranches.bindDraft(state, experimentId, draftPath, program))
    }
    async saveExperimentBranch(projectId:string,experimentId:string,input:Parameters<typeof ExperimentBranches.save>[2]) {
      return this.store.mutate(projectId,state => {
        const experiment = this.experiment(state, experimentId)
        this.assertEvidence(state, { campaignId: experiment.campaignId, experimentId }, input.evidenceRefs, "Experiment branch evidence")
        return ExperimentBranches.save(state,experimentId,input,this.now())
      })
    }
    async readExperimentBranch(projectId:string,experimentId:string,branchId:string) {
      const snapshot=await this.store.read(projectId)
      return ExperimentBranches.select(snapshot,experimentId,branchId)
    }
    async restoreExperimentBranch(projectId:string,experimentId:string,branchId:string) {
      return this.store.mutate(projectId,state=>ExperimentBranches.select(state,experimentId,branchId))
    }
    async updateExperimentBranch(projectId:string,experimentId:string,input:Extract<ExperimentBranches.Action,{action:"status"}>) {
      return this.store.mutate(projectId,state=>ExperimentBranches.update(state,experimentId,input,this.now()))
    }

    async campaignResearchState(projectId: string, campaignId: string): Promise<{
      charter: ResearchDomain.CampaignCharter
      hypotheses: ResearchDomain.ResearchHypothesis[]
      searchObservations: ResearchDomain.SearchObservation[]
      trialCount: number
      researchQuestions: ReturnType<typeof ResearchQuestions.project>
      evidenceCatalog: CampaignEvidence.Reference[]
      resources: ReturnType<typeof CampaignResources.summarize>
    }> {
      return this.store.mutate(projectId, (state) => {
        const campaign = this.campaign(state, campaignId)
        const charter = this.ensureCampaignCharter(state, campaign)
        return campaignSnapshot(state,campaignId)
      })
    }

    async requestResearch(projectId: string, experimentId: string, raw: RequestResearchInput): Promise<{
      requestId: string
      status: "open"
      scheduledAction: "iterate_experiment"
    }> {
      const input = RequestResearchInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const experiment = this.experiment(state, experimentId)
        const campaignId = experiment.campaignId
        const campaign = this.campaign(state, campaignId)
        if (campaign.status !== "active") throw new ConflictError({ code: "campaign_not_active",
          message: `Campaign ${campaignId} must be active before requesting research` })
        if (experiment.status !== "active") throw new ConflictError({ code: "experiment_not_active",
          message: `Experiment ${experimentId} must be active before requesting research` })
        if (input.request.prerequisiteBranchId) {
          const branch = state.experimentBranches[input.request.prerequisiteBranchId]
          if (!branch || branch.experimentId !== experimentId || branch.campaignId !== campaignId ||
            branch.contractHash !== experiment.contractHash || branch.status === "retired" ||
            ExperimentBranches.hash(branch.program) !== branch.programHash) {
            throw new ConflictError({ code: "invalid_research_prerequisite_branch",
              message: "A knowledge prerequisite must bind an intact, non-retired branch in this frozen experiment" })
          }
        }
        const scheduledAction = "iterate_experiment" as const // Research processing is separate; recording a question never schedules a discovery interrupt.
        this.assertEvidence(state, { campaignId, experimentId }, input.evidenceRefs, "Research request evidence")
        const questions = ResearchQuestions.project(
          Object.values(state.searchObservations).filter(observation => observation.campaignId === campaignId),
          Object.values(state.knowledgeCycles),
          Object.values(state.researchRequests).filter(request => request.campaignId === campaignId),
        )
        const action = input.request.action
        if (action === "create") {
          const existing = questions.find(question => question.experimentId === experimentId &&
            ResearchQuestions.identity(question.authoritativeRequest) === ResearchQuestions.identity(input.request))
          if (existing) {
            if (existing.status !== "open") {
              throw new ConflictError({ code: "research_request_already_resolved",
                message: `Research request ${existing.requestId} is ${existing.status}; reopen it with its current revision and a concrete reason` })
            }
            return { requestId: existing.requestId, status: "open" as const, scheduledAction }
          }
        } else {
          const retry = Object.values(state.researchRequests).find(record => record.experimentId === experimentId &&
            record.generatedBy === input.generatedBy && record.request.action === "reopen" &&
            record.request.existingRequestId === input.request.existingRequestId &&
            record.request.expectedRevision === input.request.expectedRevision &&
            record.request.reopenReason === input.request.reopenReason &&
            JSON.stringify(record.evidenceRefs) === JSON.stringify(input.evidenceRefs) &&
            ResearchQuestions.identity(record.request) === ResearchQuestions.identity(input.request))
          if (retry) {
            const current = questions.find(question => question.occurrenceIds.includes(retry.request.existingRequestId!))
            if (!current || current.status !== "open" || current.revision !== retry.request.expectedRevision) {
              throw new ConflictError({ code: "research_request_retry_stale",
                message: `Research request ${retry.request.existingRequestId} was assessed after this reopen; reload its current status and revision` })
            }
            return { requestId: current.requestId, status: "open" as const, scheduledAction }
          }
          try {
            ResearchQuestions.validateReference(input.request, questions, experimentId)
          } catch (error) {
            throw new ConflictError({ code: "invalid_research_request_reopen",
              message: error instanceof Error ? error.message : String(error) })
          }
          const current = questions.find(question => question.experimentId === experimentId &&
            question.occurrenceIds.includes(input.request.existingRequestId!))!
          if (current.status === "open") throw new ConflictError({ code: "research_request_already_open",
            message: `Research request ${current.requestId} is already open` })
        }
        const record = ResearchDomain.ResearchRequestRecord.parse({
          id: this.id("rq"),
          campaignId,
          experimentId,
          request: input.request,
          evidenceRefs: input.evidenceRefs,
          generatedBy: input.generatedBy,
          createdAt: this.now(),
        })
        state.researchRequests[record.id] = record
        return {
          requestId: action === "reopen"
            ? questions.find(question => question.occurrenceIds.includes(input.request.existingRequestId!))!.requestId
            : record.id,
          status: "open" as const,
          scheduledAction,
        }
      })
    }

    async listHypotheses(projectId: string, campaignId: string): Promise<ResearchDomain.ResearchHypothesis[]> {
      return (await this.campaignResearchState(projectId, campaignId)).hypotheses
    }

    async listSearchObservations(projectId: string, campaignId: string): Promise<ResearchDomain.SearchObservation[]> {
      return (await this.campaignResearchState(projectId, campaignId)).searchObservations
    }

    listKnowledge(...args: Parameters<ResearchKnowledgeService['listKnowledge']>): ReturnType<ResearchKnowledgeService['listKnowledge']> { return this.knowledge.listKnowledge(...args) }

    getKnowledge(...args: Parameters<ResearchKnowledgeService['getKnowledge']>): ReturnType<ResearchKnowledgeService['getKnowledge']> { return this.knowledge.getKnowledge(...args) }

    listLiterature(...args: Parameters<ResearchKnowledgeService['listLiterature']>): ReturnType<ResearchKnowledgeService['listLiterature']> { return this.knowledge.listLiterature(...args) }

    ingestLiterature(...args: Parameters<ResearchKnowledgeService['ingestLiterature']>): ReturnType<ResearchKnowledgeService['ingestLiterature']> { return this.knowledge.ingestLiterature(...args) }

    listClaims(...args: Parameters<ResearchKnowledgeService['listClaims']>): ReturnType<ResearchKnowledgeService['listClaims']> { return this.knowledge.listClaims(...args) }

    listAlignments(...args: Parameters<ResearchKnowledgeService['listAlignments']>): ReturnType<ResearchKnowledgeService['listAlignments']> { return this.knowledge.listAlignments(...args) }

    listKnowledgeCycles(...args: Parameters<ResearchKnowledgeService['listKnowledgeCycles']>): ReturnType<ResearchKnowledgeService['listKnowledgeCycles']> { return this.knowledge.listKnowledgeCycles(...args) }

    knowledgeRefreshStatus(...args: Parameters<ResearchKnowledgeService['knowledgeRefreshStatus']>): ReturnType<ResearchKnowledgeService['knowledgeRefreshStatus']> { return this.knowledge.knowledgeRefreshStatus(...args) }

    reviewAlignment(...args: Parameters<ResearchKnowledgeService['reviewAlignment']>): ReturnType<ResearchKnowledgeService['reviewAlignment']> { return this.knowledge.reviewAlignment(...args) }

    createClaim(...args: Parameters<ResearchKnowledgeService['createClaim']>): ReturnType<ResearchKnowledgeService['createClaim']> { return this.knowledge.createClaim(...args) }

    reviewClaim(...args: Parameters<ResearchKnowledgeService['reviewClaim']>): ReturnType<ResearchKnowledgeService['reviewClaim']> { return this.knowledge.reviewClaim(...args) }

    /** One atomic independent review: interpretations retain their original evidence and confidence. */
    reconcileKnowledge(...args: Parameters<ResearchKnowledgeService['reconcileKnowledge']>): ReturnType<ResearchKnowledgeService['reconcileKnowledge']> { return this.knowledge.reconcileKnowledge(...args) }

    async ingestLiteratureReview(
      projectId: string,
      campaignId: string,
      raw: LiteratureReviewInput,
      origin?: {jobId: string; leaseId: string},
      operationHandle?:OperationDomain.Handle,
    ): Promise<{
      records: ResearchDomain.LiteratureRecord[]
      claims: ResearchDomain.KnowledgeClaim[]
      alignments: ResearchDomain.KnowledgeAlignment[]
      cycle: ResearchDomain.KnowledgeCycle
      unresolvedQuestions: string[]
    }> {
      const input = LiteratureReviewInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        if(operationHandle){const operation=assertOperationHandle(state,operationHandle,this.now());if(operationHandle.mode!=='run'||operation.kind!=='knowledge_refresh'||operation.identity.campaignId!==campaignId||operation.jobId&&operation.jobId!==origin?.jobId)throw new Error('Literature commit requires the original run operation capability')}
        const campaign = this.campaign(state, campaignId)
        this.ensureCampaignCharter(state, campaign)
        if (origin) {
          const job = state.jobs[origin.jobId]
          const ownerCampaignId = job?.payload.kind === "autoresearch" ? state.experiments[job.payload.experimentId]?.campaignId : job?.payload.campaignId
          if (!job || job.projectId !== projectId || job.cancelRequestedAt || ownerCampaignId !== campaignId || job.status !== "running" || job.leaseId !== origin.leaseId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(this.now()))
            throw new ConflictError({code: "research_job_commit_fence", message: "Literature origin job lost its active scientific commit lease"})
          const seen = new Set([job.id]); let current = job
          while (current.payload.parentJobId !== undefined) {
            const parentId = current.payload.parentJobId, parent = typeof parentId === "string" ? state.jobs[parentId] : undefined
            if (!parent || seen.has(parent.id) || seen.size > 100 || parent.projectId !== projectId || parent.payload.runtime !== "autofold-pi.v1" || parent.payload.campaignId !== campaignId ||
              parent.status !== "running" || parent.cancelRequestedAt || !parent.leaseId || !parent.leaseExpiresAt || Date.parse(parent.leaseExpiresAt) <= Date.parse(this.now()))
              throw new ConflictError({code: "research_job_commit_fence", message: "Literature ancestor lost its active scientific commit lease"})
            seen.add(parent.id); current = parent
          }
        }
        const prior = Object.values(state.knowledgeCycles).find(
          (cycle) => cycle.campaignId === campaignId && cycle.generated.by === input.generatedBy,
        )
        if (prior) {
          if (prior.submissionHash && prior.submissionHash !== knowledgeRecordHash(input))
            throw new ConflictError({code: "knowledge_review_identity", message: "Review actor already committed a different submission"})
          return {
            records: prior.outputs.literatureIds.map((id) => state.literature[id]!).filter(Boolean),
            claims: prior.outputs.claimIds.map((id) => state.claims[id]!).filter(Boolean),
            alignments: prior.outputs.alignmentIds.map((id) => state.alignments[id]!).filter(Boolean),
            cycle: prior,
            unresolvedQuestions: prior.outputs.unresolvedQuestions,
          }
        }
        this.assertEvidence(state, { campaignId }, input.inputKnowledgeIds, "Knowledge-cycle outcome inputs")
        for (const knowledgeId of input.inputKnowledgeIds) {
          if (!state.knowledge[knowledgeId]) throw new NotFoundError({ entity: "knowledge", id: knowledgeId })
        }
        this.assertEvidence(state, { campaignId }, input.inputClaimIds, "Knowledge-cycle claim inputs")
        this.assertEvidence(state, { campaignId }, input.inputLiteratureIds, "Knowledge-cycle literature inputs")
        for (const claimId of input.inputClaimIds) {
          if (!state.claims[claimId]) throw new NotFoundError({ entity: "claim", id: claimId })
        }
        for (const literatureId of input.inputLiteratureIds) {
          if (!state.literature[literatureId]) throw new NotFoundError({ entity: "literature", id: literatureId })
        }
        if (input.nextExperiment?.experimentId) {
          const proposedExperiment = state.experiments[input.nextExperiment.experimentId]
          if (!proposedExperiment || proposedExperiment.campaignId !== campaignId) {
            throw new NotFoundError({ entity: "experiment", id: input.nextExperiment.experimentId })
          }
        }
        const questionQueue = ResearchQuestions.project(Object.values(state.searchObservations)
          .filter(o => o.campaignId === campaignId), Object.values(state.knowledgeCycles),
          Object.values(state.researchRequests).filter(request => request.campaignId === campaignId))
        ResearchQuestions.validateUpdates(questionQueue, input.researchRequestUpdates)
        for (const update of input.researchRequestUpdates) {
          const question = questionQueue.find(q => q.requestId === update.requestId)!
          if (update.expectedRequestHash && knowledgeRecordHash(question) !== update.expectedRequestHash)
            throw new ConflictError({code: "knowledge_reconciliation_stale", message: "Research request sources changed since the frozen context"})
          if ((update.evidenceRefs.length || update.evidenceSnapshots.length) && question.origin !== "trusted_closeout")
            throw new Error("External research requests require fetched source evidence; internal snapshots cannot substitute")
          if (new Set(update.evidenceRefs).size !== update.evidenceRefs.length || new Set(update.evidenceSnapshots.map(s => s.id)).size !== update.evidenceSnapshots.length)
            throw new Error("Duplicate internal reconciliation evidence")
          const snapshots = new Map(update.evidenceSnapshots.map(s => [s.id, s.expectedHash]))
          if (update.evidenceRefs.some(id => !snapshots.has(id))) throw new Error("Internal evidence requires frozen record hashes")
          this.assertEvidence(state, { campaignId, experimentId: question.experimentId }, [...snapshots.keys()], "Internal reconciliation evidence")
          for (const snapshot of update.evidenceSnapshots) {
            const record = state.knowledge[snapshot.id] ?? state.knowledgeCycles[snapshot.id] ?? state.evaluations[snapshot.id] ?? state.runs[snapshot.id] ?? state.trials[snapshot.id]
            if (!record || knowledgeRecordHash(record) !== snapshot.expectedHash)
              throw new ConflictError({code: "knowledge_reconciliation_stale", message: "Internal result or original execution evidence changed since it was read"})
          }
          for (const id of update.evidenceRefs.filter(id => id.startsWith("knw_"))) {
            const record = state.knowledge[id]!
            if (![record.trialId, record.runId, record.evaluationId].filter(Boolean).every(id => snapshots.has(id!)))
              throw new Error("Internal outcome requires its original execution lineage snapshots")
            const experiment = state.experiments[record.experimentId]
            if (!experiment) throw new Error("Internal outcome experiment missing")
            ResearchDomain.assertContractIntegrity(experiment)
            if (record.provenance.contractHash !== experiment.contractHash) throw new Error("Internal outcome scientific contract differs")
          }
          const internalAnswer = question.origin === "trusted_closeout" &&
            update.evidenceRefs.some(id => id.startsWith("knw_") && question.evidenceRefs.includes(id))
          if (update.status === "answered" && !update.sourceKeys.length && !internalAnswer) throw new Error("Answered research requests require frozen source evidence or attributable internal outcomes")
          if (update.sourceKeys.some(key => !input.sources.some(source => source.key === key))) throw new Error("Unknown research request source key")
        }
        const records: ResearchDomain.LiteratureRecord[] = []
        const recordByKey = new Map<string, ResearchDomain.LiteratureRecord>()
        for (const source of input.sources) {
          const canonical = JSON.stringify({
            database: source.database,
            sourceId: source.sourceId,
            title: source.title,
            summary: source.summary,
            excerpts: source.excerpts,
            url: source.url,
          })
          const contentHash = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`
          const existing = Object.values(state.literature).find(
            (record) => record.campaignId === campaignId && record.contentHash === contentHash,
          )
          const record =
            existing ??
            ResearchDomain.LiteratureRecord.parse({
              id: this.id("lit"),
              campaignId,
              database: source.database,
              sourceId: source.sourceId,
              title: source.title,
              summary: source.summary,
              excerpts: source.excerpts,
              url: source.url,
              query: source.query,
              contentHash,
              retrievedAt: this.now(),
            })
          if (!existing) state.literature[record.id] = record
          records.push(record)
          recordByKey.set(source.key, record)
        }
        const alignments: ResearchDomain.KnowledgeAlignment[] = []
        const claims = input.claims.map((proposal) => {
          const evidence = proposal.evidence.map((item) => {
            const record = recordByKey.get(item.sourceKey)!
            if (item.excerpt && !record.excerpts.includes(item.excerpt)) {
              throw new ConflictError({
                code: "claim_excerpt_not_frozen",
                message: `Claim excerpt is not frozen in source ${item.sourceKey}`,
              })
            }
            return { literatureId: record.id, excerpt: item.excerpt }
          })
          const createdAt = this.now()
          const claim = ResearchDomain.KnowledgeClaim.parse({
            id: this.id("clm"),
            campaignId,
            kind: proposal.kind,
            statement: proposal.statement,
            stance: proposal.stance,
            confidence: proposal.confidence,
            evidence,
            status: "proposed",
            generated: { by: input.generatedBy, at: createdAt },
            createdAt,
          })
          state.claims[claim.id] = claim
          for (const proposedAlignment of proposal.alignments ?? []) {
            const concept = state.knowledge[proposedAlignment.knowledgeId]
            if (!concept || concept.campaignId !== campaignId) {
              throw new NotFoundError({ entity: "knowledge", id: proposedAlignment.knowledgeId })
            }
            const alignment = ResearchDomain.KnowledgeAlignment.parse({
              id: this.id("aln"),
              campaignId,
              claimId: claim.id,
              knowledgeId: concept.id,
              relation: proposedAlignment.relation,
              rationale: proposedAlignment.rationale,
              status: "proposed",
              generated: claim.generated,
              createdAt,
            })
            state.alignments[alignment.id] = alignment
            alignments.push(alignment)
          }
          return claim
        })
        const createdAt = this.now()
        const cycleId = this.id("kcy")
        const searchObservations = this.recordSearchObservations(
          state,
          campaignId,
          cycleId,
          input.searchObservations,
          createdAt,
        )
        const hypotheses = this.applyHypothesisUpdates(
          state,
          campaignId,
          input.generatedBy,
          input.hypothesisUpdates,
          searchObservations,
          createdAt,
        )
        const nextReview = new Date(createdAt)
        nextReview.setUTCDate(nextReview.getUTCDate() + 7)
        const cycle = ResearchDomain.KnowledgeCycle.parse({
          id: cycleId,
          campaignId,
          trigger: input.trigger,
          submissionHash: knowledgeRecordHash(input),
          question: input.question ?? campaign.objective,
          inputs: {
            knowledgeIds: [...new Set(input.inputKnowledgeIds)].toSorted(),
            claimIds: [...new Set(input.inputClaimIds)].toSorted(),
            literatureIds: [...new Set(input.inputLiteratureIds)].toSorted(),
          },
          outputs: {
            literatureIds: [...new Set(records.map((record) => record.id))].toSorted(),
            claimIds: claims.map((claim) => claim.id).toSorted(),
            alignmentIds: alignments.map((alignment) => alignment.id).toSorted(),
            hypothesisIds: hypotheses.map((hypothesis) => hypothesis.id).toSorted(),
            searchObservationIds: searchObservations.map((observation) => observation.id).toSorted(),
            researchRequestUpdates: input.researchRequestUpdates.map(({ sourceKeys, evidenceRefs, ...update }) => ({
              authority: "evidence_linked_interpretation_not_measurement",
              evidenceRefs,
              ...update, literatureIds: [...new Set(sourceKeys.map(key => recordByKey.get(key)!.id))],
            })),
            unresolvedQuestions: input.unresolvedQuestions,
          },
          generated: { by: input.generatedBy, at: createdAt },
          campaignSummary: input.campaignSummary,
          nextExperiment: input.nextExperiment,
          createdAt,
          nextReviewAt: nextReview.toISOString(),
        })
        state.knowledgeCycles[cycle.id] = cycle
        return { records, claims, alignments, cycle, unresolvedQuestions: input.unresolvedQuestions }
      })
    }

    async publishCampaignKnowledge(projectId: string, campaignId: string, workspace: string): Promise<void> {
      await this.publishKnowledge(projectId, campaignId, workspace)
    }

    async createCampaign(projectId: string, raw: CreateCampaignInput): Promise<ResearchDomain.Campaign> {
      const input = CreateCampaignInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const timestamp = this.now()
        const campaign = ResearchDomain.Campaign.parse({
          id: this.id("cmp"),
          projectId,
          objective: input.objective,
          status: "draft",
          knowledgeCatalogId: input.knowledgeCatalogId ?? `okf_${crypto.randomUUID().replaceAll("-", "")}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        state.campaigns[campaign.id] = campaign
        this.ensureCampaignCharter(state, campaign)
        return campaign
      })
    }

    async activateCampaign(projectId: string, campaignId: string): Promise<ResearchDomain.Campaign> {
      return this.store.mutate(projectId, (state) => {
        const campaign = this.campaign(state, campaignId)
        if (campaign.status !== "draft" && campaign.status !== "paused") {
          throw new ConflictError({
            code: "campaign_not_activatable",
            message: `Campaign ${campaignId} cannot be activated from ${campaign.status}`,
          })
        }
        const updated = ResearchDomain.Campaign.parse({ ...campaign, status: "active", updatedAt: this.now() })
        state.campaigns[campaignId] = updated
        return updated
      })
    }

    async listExperiments(projectId: string, campaignId: string): Promise<ResearchDomain.Experiment[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.experiments)
        .filter((experiment) => experiment.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async createExperiment(
      projectId: string,
      campaignId: string,
      raw: CreateExperimentInput,
    ): Promise<ResearchDomain.Experiment> {
      const input = CreateExperimentInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const campaign = this.campaign(state, campaignId)
        if (campaign.status !== "active") {
          throw new ConflictError({
            code: "campaign_not_active",
            message: `Campaign ${campaignId} must be active before creating an experiment`,
          })
        }
        const timestamp = this.now()
        const experiment = ResearchDomain.Experiment.parse({
          id: this.id("exp"),
          campaignId,
          status: "draft",
          contract: input.contract,
          contractHash: ResearchDomain.hashContract(input.contract),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        state.experiments[experiment.id] = experiment
        return experiment
      })
    }

    async activateExperiment(projectId: string, experimentId: string): Promise<ResearchDomain.Experiment> {
      return this.store.mutate(projectId, (state) => {
        const experiment = this.experiment(state, experimentId)
        const campaign = this.campaign(state, experiment.campaignId)
        if (campaign.status !== "active") {
          throw new ConflictError({
            code: "campaign_not_active",
            message: `Campaign ${campaign.id} must be active before activating an experiment`,
          })
        }
        if (experiment.status !== "draft" && experiment.status !== "paused") {
          throw new ConflictError({
            code: "experiment_not_activatable",
            message: `Experiment ${experimentId} cannot be activated from ${experiment.status}`,
          })
        }
        ResearchDomain.assertContractIntegrity(experiment)
        const updated = ResearchDomain.Experiment.parse({ ...experiment, status: "active", updatedAt: this.now() })
        state.experiments[experimentId] = updated
        return updated
      })
    }

    /** Read-only host guard for a first external launch; receipt reconciliation does not require a live job. */
    async hasTrustedJob(projectId: string, jobId: string): Promise<boolean> {
      return Boolean((await this.store.read(projectId)).jobs[jobId])
    }
    async assertTrustedOperationLaunch(projectId:string,handle:OperationDomain.Handle,scope:{trialId?:string;origin?:{jobId:string;leaseId:string}}={}):Promise<{operation:OperationDomain.Record;deadlineMs?:number}> {
      const state=await this.store.read(projectId),now=this.now()
      if(handle.projectId!==projectId)throw new ConflictError({code:"operation_launch_fence",message:"Operation capability belongs to another project"})
      const operation=assertOperationHandle(state,handle,now)
      if(scope.origin&&(operation.jobId!==scope.origin.jobId||operation.owner?.jobLeaseId!==scope.origin.leaseId))throw new ConflictError({code:"operation_launch_fence",message:"Operation and native launch capabilities do not share the captured owner epoch"})
      const deadlines:number[]=[]
      if(typeof operation.grant.deadlineMs==="number")deadlines.push(operation.grant.deadlineMs)
      if(operation.jobId){const leaseId=operation.owner?.jobLeaseId;if(!leaseId)throw new ConflictError({code:"operation_launch_fence",message:"Managed operation has no captured native epoch"});let current:ResearchDomain.Job|undefined=this.assertTrustedJobState(state,projectId,{jobId:operation.jobId,leaseId},{...scope,newWork:true});while(current){for(const value of [current.checkpoints["host:lifecycle:start"]?.data.deadlineMs,current.checkpoints["pi:job:start"]?.data.deadlineMs,current.checkpoints["campaign:job:start"]?.data.deadlineMs,current.payload.originDeadlineMs])if(typeof value==="number")deadlines.push(value);current=typeof current.payload.parentJobId==="string"?state.jobs[current.payload.parentJobId]:undefined}}
      if(scope.trialId){const trial=this.trial(state,scope.trialId),experiment=this.experiment(state,trial.experimentId),campaign=this.campaign(state,experiment.campaignId)
        if(campaign.projectId!==projectId||experiment.status!=="active"||campaign.status!=="active"||operation.kind!=="skill_shadow_replay"||operation.identity.experimentId!==experiment.id||(operation.identity.validationCampaignId??operation.identity.campaignId)!==campaign.id)
          throw new ConflictError({code:"operation_launch_fence",message:"Canonical operation does not own this original execution scope"})
      }
      return {operation,...(deadlines.length?{deadlineMs:Math.min(...deadlines)}:{})}
    }
    async assertTrustedJobLaunch(projectId:string,origin:{jobId:string;leaseId:string},scope:{trialId?:string}={}):Promise<{job:ResearchDomain.Job;deadlineMs?:number}> {
      const state=await this.store.read(projectId),job=this.assertTrustedJobState(state,projectId,origin,{...scope,newWork:true})
      const deadlines:number[]=[];let current:ResearchDomain.Job|undefined=job
      while(current){for(const value of [current.checkpoints["host:lifecycle:start"]?.data.deadlineMs,current.checkpoints["pi:job:start"]?.data.deadlineMs,current.checkpoints["campaign:job:start"]?.data.deadlineMs,current.payload.originDeadlineMs])if(typeof value==="number")deadlines.push(value);current=typeof current.payload.parentJobId==="string"?state.jobs[current.payload.parentJobId]:undefined}
      return {job,...(deadlines.length?{deadlineMs:Math.min(...deadlines)}:{})}
    }
    async assertTrustedJobLease(projectId: string, origin: {jobId: string; leaseId?: string}, scope: {trialId?: string; newWork?: boolean} = {}): Promise<ResearchDomain.Job> {
      return this.assertTrustedJobState(await this.store.read(projectId), projectId, origin, scope)
    }
    private assertTrustedJobState(state: Readonly<ResearchState>, projectId: string, origin: {jobId: string; leaseId?: string}, scope: {trialId?: string; newWork?: boolean} = {}): ResearchDomain.Job {
      const job = state.jobs[origin.jobId]
      if (!job || job.projectId !== projectId || job.payload.runtime !== "autofold-pi.v1" || !origin.leaseId ||
        !ResearchJobService.inspectOwnership(state, job, this.now(), origin.leaseId).valid)
        throw new ConflictError({code: "research_job_commit_fence", message: "Trusted job lost its active scientific lease"})
      if (scope.newWork) {
        let bound: ResearchDomain.Job | undefined = job
        const now = Date.parse(this.now())
        while (bound) {
          for (const value of [bound.checkpoints['host:lifecycle:start']?.data.deadlineMs,bound.checkpoints['pi:job:start']?.data.deadlineMs,bound.checkpoints['campaign:job:start']?.data.deadlineMs,bound.payload.originDeadlineMs]) {
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= now))
              throw new ConflictError({code:'research_job_deadline',message:'Original job or ancestor deadline forbids new execution; receipt reconciliation remains allowed'})
          }
          bound = typeof bound.payload.parentJobId === 'string' ? state.jobs[bound.payload.parentJobId] : undefined
        }
      }
      if (scope.trialId) {
        const trial = state.trials[scope.trialId], experiment = trial && state.experiments[trial.experimentId]
        const campaignId = job.payload.kind === "autoresearch" ? state.experiments[job.payload.experimentId]?.campaignId :
          job.payload.kind === "skill_shadow_replay" && typeof job.payload.validationCampaignId === "string" ? job.payload.validationCampaignId : job.payload.campaignId
        const experimentId = typeof job.payload.experimentId === "string" ? job.payload.experimentId : undefined
        if (!trial || trial.origin?.jobId !== job.id || !experiment || state.campaigns[experiment.campaignId]?.projectId !== projectId ||
          experiment.campaignId !== campaignId || experimentId && experiment.id !== experimentId)
          throw new ConflictError({code: "research_job_commit_fence", message: "Trusted job does not own the requested scientific trial"})
        if (scope.newWork && (experiment.status !== "active" || state.campaigns[experiment.campaignId]?.status !== "active"))
          throw new ConflictError({code:"research_job_commit_fence",message:"Scientific scope no longer permits a first launch"})
      }
      return job
    }

    async createTrial(projectId: string, experimentId: string, raw: CreateTrialInput, authority?: {jobId: string; leaseId: string}, operationHandle?:OperationDomain.Handle): Promise<ResearchDomain.Trial> {
      const input = CreateTrialInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const experiment = this.experiment(state, experimentId)
        ResearchDomain.assertContractIntegrity(experiment)
        if(input.decisionMemoryExposure){
          const exposure=input.decisionMemoryExposure
          if(exposure.scope.projectId!==projectId||exposure.scope.campaignId!==experiment.campaignId||exposure.scope.experimentId!==experiment.id||
            exposure.decisionHash!=='sha256:'+operationHash({decisionPlan:input.decisionPlan,evidenceRefs:input.evidenceRefs})||
            exposure.citedSources.some(source=>![...(input.decisionPlan?.evidenceRefs??[]),...(input.evidenceRefs??[])].includes(source.id)))
            throw new ConflictError({code:'decision_memory_exposure_conflict',message:'Delivered decision-memory exposure differs from this admission'})
        }
        if (input.origin) {
          const origin = input.origin
          const existing = Object.values(state.trials).find(
            (trial) =>
              trial.experimentId === experimentId &&
              trial.origin?.jobId === origin.jobId &&
              trial.origin?.phase === origin.phase,
          )
          if (existing) {
            if (
              existing.methodologyProfile !== input.methodologyProfile ||
              existing.hypothesis !== input.hypothesis ||
              existing.programHash !== input.programHash ||
              existing.designAdapter !== input.designAdapter ||
              existing.executionProtocol !== input.executionProtocol ||
              existing.intent !== input.intent ||
              JSON.stringify(existing.generators) !== JSON.stringify(input.generators) ||
              JSON.stringify(existing.generatorAllocations) !== JSON.stringify(input.generatorAllocations) ||
              JSON.stringify(existing.skills) !== JSON.stringify(input.skills) ||
              JSON.stringify(existing.decisionPlan) !== JSON.stringify(input.decisionPlan) ||
              JSON.stringify(existing.prediction) !== JSON.stringify(input.prediction) ||
              JSON.stringify(existing.evidenceRefs) !== JSON.stringify(input.evidenceRefs) ||
              JSON.stringify(existing.graphEvidenceUse) !== JSON.stringify(input.graphEvidenceUse) ||
              !isDeepStrictEqual(existing.decisionMemoryExposure,input.decisionMemoryExposure) ||
              JSON.stringify(existing.calibrationClass) !== JSON.stringify(input.calibrationClass) ||
              JSON.stringify(existing.replicateOfTrialId) !== JSON.stringify(input.replicateOfTrialId) ||
              JSON.stringify(existing.generationSeed) !== JSON.stringify(input.generationSeed) ||
              JSON.stringify(existing.configurationFamilyFingerprint) !== JSON.stringify(input.configurationFamilyFingerprint) ||
              JSON.stringify(existing.semanticProgramFingerprint) !== JSON.stringify(input.semanticProgramFingerprint) ||
              JSON.stringify(existing.workflowFingerprint) !== JSON.stringify(input.workflowFingerprint)
            ) {
              throw new ConflictError({
                code: "trial_origin_conflict",
                message: `Job phase ${origin.jobId}:${origin.phase} already created a different trial`,
              })
            }
            return existing
          }
          const owner = state.jobs[origin.jobId]
          if (owner) {
            if (!authority || authority.jobId !== origin.jobId) throw new ConflictError({code:"research_job_commit_fence",message:"Managed trial admission requires the owning job's exact lease epoch"})
            this.assertTrustedJobState(state, projectId, authority, {newWork:true})
            const campaignId = owner.payload.kind === "autoresearch" ? state.experiments[owner.payload.experimentId]?.campaignId :
              owner.payload.kind === "skill_shadow_replay" && typeof owner.payload.validationCampaignId === "string" ? owner.payload.validationCampaignId : owner.payload.campaignId
            if (campaignId !== experiment.campaignId || typeof owner.payload.experimentId === "string" && owner.payload.experimentId !== experimentId)
              throw new ConflictError({code:"research_job_commit_fence",message:"Managed trial origin belongs to another scientific scope"})
          } else if (authority) throw new ConflictError({code:"research_job_commit_fence",message:"Managed trial origin no longer exists"})
        }
        if(input.methodologyProfile === "historical") throw new ConflictError({code:"historical_methodology_frozen",message:"Historical methodology labels describe frozen records; fresh trials require explicit current admission"})
        if (input.designAdapter === "proto" && !input.executionProtocol)
          throw new ConflictError({code: "native_protocol_required", message: "Fresh Proto trials require a host-inspected native execution protocol"})
        if (input.executionProtocol && (input.designAdapter !== "proto" || input.executionProtocol === "native_fixed_control_v1" && !["calibrate", "negative_control"].includes(input.intent)))
          throw new ConflictError({code: "native_protocol_mismatch", message: "Native execution protocol does not match trial adapter or intent"})
        if(operationHandle)assertOperationHandle(state,operationHandle,this.now())
        if (experiment.status !== "active")
          throw new ConflictError({code:"experiment_not_active",message:`Experiment ${experimentId} must be active before creating a trial`})
        if (this.campaign(state, experiment.campaignId).status !== "active")
          throw new ConflictError({code:"campaign_not_active",message:`Campaign ${experiment.campaignId} must be active before creating a trial`})
        const maximumTrials = state.campaignCharters[experiment.campaignId]?.constraints.maximumCampaignTrials
        if (maximumTrials !== undefined && Object.values(state.trials).filter(trial =>
          state.experiments[trial.experimentId]?.campaignId === experiment.campaignId).length >= maximumTrials) {
          throw new ConflictError({code: "campaign_trial_budget_exhausted", message: "The approved campaign trial count is exhausted"})
        }
        const parentTrialId = input.parentTrialId ?? experiment.incumbentTrialId
        if (parentTrialId) {
          const parent = this.trial(state, parentTrialId)
          if (parent.experimentId !== experimentId) {
            throw new ConflictError({
              code: "parent_trial_mismatch",
              message: `Parent trial ${parentTrialId} belongs to another experiment`,
            })
          }
        }
        const timestamp = this.now()
        const trial = ResearchDomain.Trial.parse({
          id: this.id("trl"),
          experimentId,
          parentTrialId,
          origin: input.origin,
          skills: input.skills,
          generators: input.generators,
          generatorAllocations: input.generatorAllocations,
          hypothesis: input.hypothesis,
          executionProtocol: input.executionProtocol,
          methodologyProfile: input.methodologyProfile,
          intent: input.intent,
          decisionPlan: input.decisionPlan,
          prediction: input.prediction,
          evidenceRefs: input.evidenceRefs,
          graphEvidenceUse: input.graphEvidenceUse,
          decisionMemoryExposure:input.decisionMemoryExposure,
          calibrationClass: input.calibrationClass,
          replicateOfTrialId: input.replicateOfTrialId,
          ...(input.generationSeed === undefined ? {} : {generationSeed: input.generationSeed}),
          configurationFamilyFingerprint: input.configurationFamilyFingerprint,
          semanticProgramFingerprint: input.semanticProgramFingerprint,
          workflowFingerprint: input.workflowFingerprint,
          designAdapter: input.designAdapter,
          programPath: input.programPath,
          programHash: input.programHash,
          status: "proposed",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        state.trials[trial.id] = trial
        return trial
      })
    }

    async transitionTrial(
      projectId: string,
      trialId: string,
      status: ResearchDomain.TrialStatus,
    ): Promise<ResearchDomain.Trial> {
      return this.store.mutate(projectId, (state) => {
        const trial = this.trial(state, trialId)
        if (status === "succeeded") {
          throw new ConflictError({
            code: "evaluation_required",
            message: `Trial ${trialId} can only succeed through a recorded evaluation`,
          })
        }
        const updated = (() => {
          try {
            return ResearchDomain.transitionTrial(trial, status, this.now())
          } catch (error) {
            throw new ConflictError({
              code: "illegal_trial_transition",
              message: error instanceof Error ? error.message : String(error),
            })
          }
        })()
        state.trials[trialId] = updated
        return updated
      })
    }

    async getTrialContext(projectId: string, trialId: string) {
      const state = await this.store.read(projectId)
      const trial = this.trial(state, trialId)
      const experiment = this.experiment(state, trial.experimentId)
      const campaign = this.campaign(state, experiment.campaignId)
      return { campaign, experiment, trial }
    }

    async beginRun(
      projectId: string,
      trialId: string,
      paths: { runId?: string; bundlePath: string; outputPath: string; jobId?: string },
    ): Promise<ResearchDomain.Run> {
      return this.store.mutate(projectId, (state) => {
        const trial = this.trial(state, trialId)
        const original = paths.runId ? state.runs[paths.runId] : undefined
        if (original) {
          if (original.trialId !== trialId || original.bundlePath !== paths.bundlePath || original.outputPath !== paths.outputPath || original.jobId !== paths.jobId)
            throw new ConflictError({code: "run_identity_conflict", message: "Original run ID is already bound to a different trial, paths or compute identity"})
          return original
        }
        if (trial.status !== "proposed") {
          throw new ConflictError({
            code: "trial_not_proposed",
            message: `Trial ${trialId} must be proposed before it can run`,
          })
        }
        if (Object.values(state.runs).some((run) => run.trialId === trialId && !["failed", "cancelled"].includes(run.status))) {
          throw new ConflictError({
            code: "trial_already_running",
            message: `Trial ${trialId} already has an active or completed run`,
          })
        }
        const experiment = this.experiment(state, trial.experimentId)
        const resources = CampaignResources.summarize(state, experiment.campaignId)
        if (resources.remainingGpuSeconds !== null && CampaignResources.gpuSeconds(experiment.contract.budget.gpuHours, "reservation") > resources.remainingGpuSeconds) {
          throw new ConflictError({ code: "campaign_gpu_budget_exhausted",
            message: `Campaign GPU authorization has ${resources.remainingGpuHours} hours remaining; this frozen run reserves ${experiment.contract.budget.gpuHours} hours` })
        }
        const timestamp = this.now()
        const run = ResearchDomain.Run.parse({
          id: paths.runId ?? this.id("run"),
          trialId,
          status: "queued",
          bundlePath: paths.bundlePath,
          outputPath: paths.outputPath,
          jobId: paths.jobId,
          createdAt: timestamp,
        })
        state.runs[run.id] = run
        state.trials[trialId] = ResearchDomain.transitionTrial(trial, "queued", timestamp)
        return run
      })
    }

    async attachRunJob(projectId: string, runId: string, jobId: string): Promise<ResearchDomain.Run> {
      return this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        if (run.jobId && run.jobId !== jobId) {
          throw new ConflictError({ code: "run_compute_job_mismatch",
            message: `Run ${runId} is bound to compute job ${run.jobId}, not ${jobId}` })
        }
        if (run.status !== "queued") return run
        const trial = this.trial(state, run.trialId)
        const timestamp = this.now()
        const updated = ResearchDomain.Run.parse({
          ...run,
          status: "running",
          jobId,
          startedAt: timestamp,
        })
        state.runs[runId] = updated
        state.trials[trial.id] = ResearchDomain.transitionTrial(trial, "running", timestamp)
        return updated
      })
    }

    async getActiveRunForTrial(projectId: string, trialId: string): Promise<ResearchDomain.Run | undefined> {
      const state = await this.store.read(projectId)
      this.trial(state, trialId)
      return Object.values(state.runs)
        .filter((run) => run.trialId === trialId && (run.status === "queued" || run.status === "running"))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
    }

    async getRun(projectId: string, runId: string): Promise<ResearchDomain.Run> {
      return this.run(await this.store.read(projectId), runId)
    }

    async reopenRunFinalization(projectId: string, runId: string): Promise<ResearchDomain.Run> {
      return this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        const trial = this.trial(state, run.trialId)
        if (run.status !== "failed" || trial.status !== "failed" || !run.jobId) {
          throw new ConflictError({
            code: "run_not_recoverable",
            message: `Run ${runId} is not a failed compute-backed run`,
          })
        }
        if (Object.values(state.evaluations).some((evaluation) => evaluation.trialId === trial.id)) {
          throw new ConflictError({
            code: "run_already_evaluated",
            message: `Run ${runId} already has a locked evaluation`,
          })
        }
        const timestamp = this.now()
        const reopened = ResearchDomain.Run.parse({
          ...run,
          status: "running",
          error: undefined,
          completedAt: undefined,
        })
        state.runs[runId] = reopened
        state.trials[trial.id] = ResearchDomain.Trial.parse({
          ...trial,
          status: "running",
          updatedAt: timestamp,
        })
        return reopened
      })
    }

    async supersedeRecoveredFailures(projectId: string, runId: string, workspace?: string): Promise<number> {
      const result = await this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        const trial = this.trial(state, run.trialId)
        const experiment = this.experiment(state, trial.experimentId)
        if (run.status !== "succeeded") return { updated: 0, campaignId: experiment.campaignId }
        const evaluation = Object.values(state.evaluations).find((item) => item.trialId === run.trialId)
        if (!evaluation) return { updated: 0, campaignId: experiment.campaignId }
        let updated = 0
        for (const concept of Object.values(state.knowledge)) {
          if (concept.runId !== run.id || concept.type !== "Research Failure" || concept.status === "deprecated") continue
          state.knowledge[concept.id] = ResearchDomain.KnowledgeConcept.parse({
            ...concept,
            description: `${concept.description} Superseded after the original compute artifacts were retrieved and verified as evaluation ${evaluation.id}.`,
            tags: [...new Set([...concept.tags, "recovered", "superseded-by-evaluation"])],
            status: "deprecated",
          })
          updated += 1
        }
        return { updated, campaignId: experiment.campaignId }
      })
      if (workspace && result.updated > 0) await this.publishKnowledge(projectId, result.campaignId, workspace)
      return result.updated
    }

    async cancelRun(projectId: string, runId: string, message = "Run cancelled", workspace?: string): Promise<ResearchDomain.Run> {
      const result = await this.store.mutate(projectId, state => {
        const run = this.run(state, runId)
        if (["succeeded", "failed", "cancelled"].includes(run.status)) return { run }
        const trial = this.trial(state, run.trialId)
        if (trial.status !== "cancelled" && !ResearchDomain.canTransitionTrial(trial.status, "cancelled")) {
          throw new ConflictError({ code: "trial_not_cancellable", message: `Trial ${trial.id} cannot be cancelled from ${trial.status}` })
        }
        const timestamp = this.now()
        const updated = ResearchDomain.Run.parse({ ...run, status: "cancelled",
          error: message.trim().slice(0, 4_000) || "Run cancelled", completedAt: timestamp })
        state.runs[run.id] = updated
        if (trial.status !== "cancelled") state.trials[trial.id] = ResearchDomain.transitionTrial(trial, "cancelled", timestamp)
        return { run: updated, campaignId: this.experiment(state, trial.experimentId).campaignId }
      })
      if (workspace && result.campaignId) {
        await this.publishKnowledge(projectId, result.campaignId, workspace).catch(error =>
          this.log.warn("failed to write derived OKF bundle", { projectId, campaignId: result.campaignId, error }))
      }
      return result.run
    }

    async failRun(projectId: string, runId: string, message: string, workspace?: string, facts?:ResearchTrajectoryObservation.ReceiptFacts): Promise<ResearchDomain.Run> {
      const error = message.trim().slice(0, 4_000) || "Unknown worker failure"
      const result = await this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        if (["succeeded", "failed", "cancelled"].includes(run.status)) {
          const existing = Object.values(state.knowledge).find(
            (concept) => concept.runId === run.id && concept.type === "Research Failure",
          )
          if(run.status==='failed'&&facts?.failureReceiptHash)ResearchTrajectoryObservation.commitInState(state,projectId,run.id,facts,this.now())
          return { run, campaignId: existing?.campaignId }
        }
        const trial = this.trial(state, run.trialId)
        const experiment = this.experiment(state, trial.experimentId)
        const campaign = this.campaign(state, experiment.campaignId)
        const timestamp = this.now()
        const updated = ResearchDomain.Run.parse({
          ...run,
          status: "failed",
          error: message,
          completedAt: timestamp,
        })
        state.runs[runId] = updated
        if (["queued", "running", "evaluating"].includes(trial.status)) {
          state.trials[trial.id] = ResearchDomain.transitionTrial(trial, "failed", timestamp)
        }
        const knowledge = ResearchDomain.KnowledgeConcept.parse({
          id: this.id("knw"),
          campaignId: campaign.id,
          experimentId: experiment.id,
          trialId: trial.id,
          runId: run.id,
          type: "Research Failure",
          title: `Failed trial ${trial.id}`,
          description: `Execution failed before a locked evaluation was completed: ${error}`,
          tags: ["autofold", "research-failure", "failed", "unverified"],
          sources: [
            {
              id: "run-record",
              resource: `autofold://runs/${run.id}`,
              title: `Final failed run record for ${run.id}`,
              author: "process:autofold-research-service",
              last_modified: timestamp.slice(0, 10),
            },
          ],
          generated: { by: "autofold/research-v1", at: timestamp },
          status: "draft",
          score: null,
          decision: "failed",
          error,
          diagnostics: {},
          provenance: {
            contractHash: experiment.contractHash,
            targetArtifactHash: experiment.contract.targetArtifactHash,
            evaluatorHash: experiment.contract.evaluator.sourceHash,
            programHash: trial.programHash,
          },
          createdAt: timestamp,
        })
        state.knowledge[knowledge.id] = knowledge
        if(facts?.failureReceiptHash)ResearchTrajectoryObservation.commitInState(state,projectId,run.id,facts,timestamp)
        return { run: updated, campaignId: campaign.id }
      })
      if (workspace && result.campaignId) {
        await this.publishKnowledge(projectId, result.campaignId, workspace).catch((cause) =>
          this.log.warn("failed to write derived OKF bundle", {
            projectId,
            campaignId: result.campaignId,
            error: cause,
          }),
        )
      }
      return result.run
    }

    recordTrajectoryObservation(projectId:string,input:ResearchTrajectoryCloseout.Input){return ResearchTrajectoryObservation.recover(this.store,projectId,input)}
    acknowledgeTrajectoryProjection(projectId:string,id:string,commitHash:string){return ResearchTrajectoryObservation.acknowledge(this.store,projectId,id,commitHash)}

    async completeRun(
      projectId: string,
      runId: string,
      raw: RecordEvaluationInput,
      manifestHash: string,
      workspace?: string,
      facts?:ResearchTrajectoryObservation.ReceiptFacts,
    ): Promise<EvaluationResult & { run: ResearchDomain.Run; observationCommit:ResearchTrajectoryObservation.Result }> {
      const input = RecordEvaluationInput.parse(raw)
      const result = await this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        if (run.status === "succeeded") {
          const knowledge = Object.values(state.knowledge).find(item => item.runId === run.id && item.decision !== "failed" && item.status !== "deprecated")
          const evaluation = knowledge?.evaluationId ? state.evaluations[knowledge.evaluationId] : undefined
          if (!evaluation || !knowledge || run.manifestHash !== manifestHash || !isDeepStrictEqual(
            {contractHash:evaluation.contractHash,evaluatorHash:evaluation.evaluatorHash,valid:evaluation.valid,score:evaluation.score,diagnostics:evaluation.diagnostics}, input))
            throw new ConflictError({code:"run_receipt_conflict",message:`Run ${runId} already committed a different receipt`})
          return {evaluation, knowledge, run, trial:this.trial(state,run.trialId),experiment:this.experiment(state,this.trial(state,run.trialId).experimentId),decision:knowledge.decision as "promoted" | "rejected" | "observed",observationCommit:ResearchTrajectoryObservation.commitInState(state,projectId,run.id,facts,this.now())}
        }
        if (run.status !== "running") {
          throw new ConflictError({ code: "run_not_running", message: `Run ${runId} is not running` })
        }
        let trial = this.trial(state, run.trialId)
        if (trial.status !== "running") {
          throw new ConflictError({ code: "trial_not_running", message: `Trial ${trial.id} is not running` })
        }
        trial = ResearchDomain.transitionTrial(trial, "evaluating", this.now())
        state.trials[trial.id] = trial
        const completedRun = ResearchDomain.Run.parse({
          ...run,
          status: "succeeded",
          manifestHash,
          completedAt: this.now(),
        })
        const result = this.evaluate(state, trial, input, completedRun)
        state.runs[runId] = completedRun
        const observationCommit=ResearchTrajectoryObservation.commitInState(state,projectId,runId,facts,this.now())
        return { ...result, run: completedRun,observationCommit }
      })
      if (workspace) {
        await this.publishKnowledge(projectId, result.knowledge.campaignId, workspace).catch((error) =>
          this.log.warn("failed to write derived OKF bundle", {
            projectId,
            campaignId: result.knowledge.campaignId,
            error,
          }),
        )
      }
      return result
    }

    async recordEvaluation(
      projectId: string,
      trialId: string,
      raw: RecordEvaluationInput,
    ): Promise<EvaluationResult> {
      const input = RecordEvaluationInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const trial = this.trial(state, trialId)
        if (trial.status !== "evaluating") {
          throw new ConflictError({
            code: "trial_not_evaluating",
            message: `Trial ${trialId} must be evaluating before an evaluation can be recorded`,
          })
        }
        return this.evaluate(state, trial, input)
      })
    }

    async history(projectId: string, experimentId: string) {
      const state = await this.store.read(projectId)
      const experiment = this.experiment(state, experimentId)
      const trials = Object.values(state.trials)
        .filter((trial) => trial.experimentId === experimentId)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      const trialIds = new Set(trials.map((trial) => trial.id))
      const evaluations = Object.values(state.evaluations)
        .filter((evaluation) => trialIds.has(evaluation.trialId))
        .toSorted((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt))
      const runs = Object.values(state.runs)
        .filter((run) => trialIds.has(run.trialId))
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      const knowledge = Object.values(state.knowledge)
        .filter((concept) => concept.experimentId === experimentId)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      return { experiment, trials, evaluations, runs, knowledge }
    }

    private evaluate(
      state: ResearchState,
      trial: ResearchDomain.Trial,
      input: RecordEvaluationInput,
      run?: ResearchDomain.Run,
    ): EvaluationResult {
      const experiment = this.experiment(state, trial.experimentId)
      if (Object.values(state.evaluations).some((evaluation) => evaluation.trialId === trial.id)) {
        throw new ConflictError({
          code: "trial_already_evaluated",
          message: `Trial ${trial.id} already has an evaluation`,
        })
      }
      ResearchDomain.assertContractIntegrity(experiment)
      if (input.contractHash !== experiment.contractHash) {
        throw new ConflictError({
          code: "contract_hash_mismatch",
          message: `Evaluation contract does not match experiment ${experiment.id}`,
        })
      }
      if (input.evaluatorHash !== experiment.contract.evaluator.sourceHash) {
        throw new ConflictError({
          code: "evaluator_hash_mismatch",
          message: `Evaluation evaluator does not match experiment ${experiment.id}`,
        })
      }
      const evaluatedAt = this.now()
      const evaluation = ResearchDomain.Evaluation.parse({
        id: this.id("evl"),
        trialId: trial.id,
        ...input,
        evaluatedAt,
      })
      const incumbent = experiment.incumbentTrialId
        ? Object.values(state.evaluations).find((candidate) => candidate.trialId === experiment.incumbentTrialId)
        : undefined
      const promotionEligible = trial.intent === "optimize"
      const promote =
        promotionEligible &&
        ResearchDomain.shouldPromote({
          candidate: evaluation,
          incumbent,
          direction: experiment.contract.evaluator.direction,
        })
      const completedTrial = ResearchDomain.transitionTrial(trial, "succeeded", this.now())
      const updatedExperiment = ResearchDomain.Experiment.parse({
        ...experiment,
        incumbentTrialId: promote ? trial.id : experiment.incumbentTrialId,
        updatedAt: promote ? this.now() : experiment.updatedAt,
      })
      const campaign = this.campaign(state, experiment.campaignId)
      const decision = input.valid && !promotionEligible ? "observed" : promote ? "promoted" : "rejected"
      const decisionTitle = decision === "promoted" ? "Promoted" : decision === "observed" ? "Observed" : "Rejected"
      const knowledge = ResearchDomain.KnowledgeConcept.parse({
        id: this.id("knw"),
        campaignId: campaign.id,
        experimentId: experiment.id,
        trialId: trial.id,
        evaluationId: evaluation.id,
        runId: run?.id,
        type: "Research Evaluation",
        title: `${decisionTitle} trial ${trial.id}`,
        description: input.valid
          ? decision === "observed"
            ? `Locked evaluation observed ${trial.intent} trial ${trial.id} with score ${input.score}; it was not promotion-eligible.`
            : `Locked evaluation ${decision} trial ${trial.id} with score ${input.score}.`
          : `Locked evaluation rejected trial ${trial.id} because its result was invalid.`,
        tags: ["autofold", "research-evaluation", trial.intent, decision, input.valid ? "valid" : "invalid"],
        sources: run
          ? [
              {
                id: "run-bundle",
                resource: ResearchKnowledge.relativeRunResource(campaign.id, run.bundlePath),
                title: `Immutable trial bundle for ${run.id}`,
                author: "process:autofold-worker",
                last_modified: evaluatedAt.slice(0, 10),
              },
              {
                id: "run-output",
                resource: ResearchKnowledge.relativeRunResource(campaign.id, run.outputPath),
                title: `Evaluator output for ${run.id}`,
                author: "process:autofold-worker",
                last_modified: evaluatedAt.slice(0, 10),
              },
            ]
          : [
              {
                id: "evaluation-record",
                resource: `autofold://evaluations/${evaluation.id}`,
                title: `Recorded evaluation ${evaluation.id}`,
                author: "process:autofold-research-service",
                last_modified: evaluatedAt.slice(0, 10),
              },
            ],
        generated: { by: "autofold/research-v1", at: evaluatedAt },
        verified: input.valid ? [{ by: "process:autofold-locked-evaluator", at: evaluatedAt }] : undefined,
        status: input.valid ? "stable" : "draft",
        score: input.score,
        decision,
        diagnostics: input.diagnostics,
        provenance: {
          contractHash: evaluation.contractHash,
          targetArtifactHash: experiment.contract.targetArtifactHash,
          evaluatorHash: evaluation.evaluatorHash,
          programHash: trial.programHash,
          manifestHash: run?.manifestHash,
        },
        createdAt: evaluatedAt,
      })
      if (run) {
        for (const concept of Object.values(state.knowledge)) {
          if (concept.runId !== run.id || concept.type !== "Research Failure" || concept.status === "deprecated") continue
          state.knowledge[concept.id] = ResearchDomain.KnowledgeConcept.parse({
            ...concept,
            description: `${concept.description} Superseded after the original compute artifacts were retrieved and verified as evaluation ${evaluation.id}.`,
            tags: [...new Set([...concept.tags, "recovered", "superseded-by-evaluation"])],
            status: "deprecated",
          })
        }
      }
      state.evaluations[evaluation.id] = evaluation
      state.trials[trial.id] = completedTrial
      state.experiments[experiment.id] = updatedExperiment
      state.knowledge[knowledge.id] = knowledge
      return {
        evaluation,
        trial: completedTrial,
        experiment: updatedExperiment,
        decision,
        knowledge,
      }
    }

    private async publishKnowledge(projectId: string, campaignId: string, workspace: string): Promise<void> {
      await this.campaignResearchState(projectId, campaignId)
      using _ = await Lock.write(`research-okf:${projectId}:${campaignId}`)
      const state = await this.store.read(projectId)
      const campaign = this.campaign(state, campaignId)
      const concepts = Object.values(state.knowledge).filter((concept) => concept.campaignId === campaignId)
      const literature = Object.values(state.literature).filter((record) => record.campaignId === campaignId)
      const claims = Object.values(state.claims).filter((claim) => claim.campaignId === campaignId)
      const alignments = Object.values(state.alignments).filter((alignment) => alignment.campaignId === campaignId)
      const cycles = Object.values(state.knowledgeCycles).filter((cycle) => cycle.campaignId === campaignId)
      const experiments = Object.values(state.experiments).filter((experiment) => experiment.campaignId === campaignId)
      const experimentIds = new Set(experiments.map((experiment) => experiment.id))
      const trials = Object.values(state.trials).filter((trial) => experimentIds.has(trial.experimentId))
      const charter = state.campaignCharters[campaignId]!
      const hypotheses = Object.values(state.hypotheses).filter((hypothesis) => hypothesis.campaignId === campaignId)
      const searchObservations = Object.values(state.searchObservations).filter((observation) => observation.campaignId === campaignId)
      await ResearchKnowledge.writeBundle({
        workspace,
        campaign,
        concepts,
        literature,
        claims,
        alignments,
        cycles,
        experiments,
        trials,
        charter,
        hypotheses,
        searchObservations,
        scientistReviews: Object.values(state.scientistReviews).filter(r => r.campaignId === campaignId),
        experimentBranches: Object.values(state.experimentBranches).filter(b => b.campaignId === campaignId),
      })
    }

    private recordSearchObservations(
      state: ResearchState,
      campaignId: string,
      cycleId: string,
      proposals: z.infer<typeof LiteratureReviewInput>["searchObservations"],
      createdAt: string,
    ): ResearchDomain.SearchObservation[] {
      return proposals.map((proposal) => {
        const existing = Object.values(state.searchObservations).find(
          (observation) => observation.campaignId === campaignId && observation.knowledgeId === proposal.knowledgeId,
        )
        if (existing) return existing
        const experiment = state.experiments[proposal.experimentId]
        const trial = state.trials[proposal.trialId]
        const run = state.runs[proposal.runId]
        const evaluation = proposal.evaluationId ? state.evaluations[proposal.evaluationId] : undefined
        const knowledge = state.knowledge[proposal.knowledgeId]
        if (!experiment || experiment.campaignId !== campaignId) {
          throw new NotFoundError({ entity: "experiment", id: proposal.experimentId })
        }
        if (!trial || trial.experimentId !== experiment.id) {
          throw new NotFoundError({ entity: "trial", id: proposal.trialId })
        }
        if (!run || run.trialId !== trial.id) throw new NotFoundError({ entity: "run", id: proposal.runId })
        if (proposal.evaluationId && (!evaluation || evaluation.trialId !== trial.id)) {
          throw new NotFoundError({ entity: "evaluation", id: proposal.evaluationId })
        }
        if (!knowledge || knowledge.campaignId !== campaignId || knowledge.trialId !== trial.id) {
          throw new NotFoundError({ entity: "knowledge", id: proposal.knowledgeId })
        }
        const evidenceCatalog = CampaignEvidence.resolve(state, { campaignId, experimentId: experiment.id })
        this.assertEvidence(state, { campaignId, experimentId: experiment.id }, proposal.evidenceRefs ?? [], "Search observation evidence")
        this.assertEvidence(state, { campaignId, experimentId: experiment.id }, proposal.decisionPlan?.evidenceRefs ?? [], "Decision plan evidence")
        // The prospective decision was frozen before this trajectory existed.
        // Admission owns grounding in prior evidence; closeout validates the
        // declared references and budget without imposing hindsight citations.
        TrialReasoning.validateDecisionPlan(proposal.decisionPlan, { ...evidenceCatalog, size: 0 }, experiment.contract.budget.gpuHours)
        ResearchQuestions.validateReference(proposal.decisionPlan?.researchRequest,
          ResearchQuestions.project(Object.values(state.searchObservations).filter(o => o.campaignId === campaignId), Object.values(state.knowledgeCycles),
            Object.values(state.researchRequests).filter(request => request.campaignId === campaignId)), experiment.id)
        const distinctModels = new Set(proposal.modelIds)
        const distinctSeeds = new Set(proposal.seeds)
        const epistemicLevel: ResearchDomain.EpistemicLevel = proposal.decision === "failed"
          ? "model_observation"
          : distinctSeeds.size > 1
            ? "multi_seed_support"
            : distinctModels.size > 1
              ? "cross_model_support"
              : proposal.evaluationId
                ? "computational_support"
                : "model_observation"
        const observation = ResearchDomain.SearchObservation.parse({
          id: this.id("sobs"),
          campaignId,
          knowledgeCycleId: cycleId,
          ...proposal,
          generatorPortfolio: [...new Set(proposal.generatorPortfolio)].toSorted(),
          candidateSequences: [...new Set(proposal.candidateSequences)],
          modelIds: [...distinctModels].toSorted(),
          seeds: [...distinctSeeds].toSorted((left, right) => left - right),
          epistemicLevel,
          createdAt,
        })
        state.searchObservations[observation.id] = observation
        return observation
      })
    }

    private applyHypothesisUpdates(
      state: ResearchState,
      campaignId: string,
      generatedBy: string,
      updates: z.infer<typeof LiteratureReviewInput>["hypothesisUpdates"],
      newObservations: ResearchDomain.SearchObservation[],
      updatedAt: string,
    ): ResearchDomain.ResearchHypothesis[] {
      const levels = ResearchDomain.EpistemicLevel.options
      const observations = [
        ...Object.values(state.searchObservations).filter((observation) => observation.campaignId === campaignId),
        ...newObservations,
      ]
      return updates.map((update) => {
        const references = [...new Set([...update.supportingEvidenceRefs, ...update.opposingEvidenceRefs])]
        this.assertEvidence(state, { campaignId }, references, "Hypothesis evidence")
        if (["supported", "weakened", "refuted"].includes(update.status) && references.length === 0) {
          throw new ConflictError({
            code: "hypothesis_evidence_required",
            message: `Hypothesis status ${update.status} requires exact persisted evidence references`,
          })
        }
        const relevant = observations.filter((observation) => {
          const linked = new Set([
            observation.id,
            observation.experimentId,
            observation.trialId,
            observation.runId,
            observation.evaluationId,
            observation.knowledgeId,
            observation.knowledgeCycleId,
          ].filter((value): value is string => Boolean(value)))
          return references.some((reference) => linked.has(reference))
        })
        // A citation, proposed claim, prior hypothesis or failure is not a measurement.
        const validEvaluation = (id: string | undefined) => {
          const evaluation = id ? state.evaluations[id] : undefined
          return Boolean(evaluation?.valid && evaluation.score !== null)
        }
        const measuredReference = references.some(id => {
          const knowledge = state.knowledge[id]
          if (knowledge) return knowledge.type === "Research Evaluation" && knowledge.status !== "deprecated" && validEvaluation(knowledge.evaluationId)
          if (state.evaluations[id]) return validEvaluation(id)
          const trialId = state.runs[id]?.trialId ?? state.trials[id]?.id
          return Boolean(trialId && Object.values(state.evaluations).some(evaluation => evaluation.trialId === trialId && validEvaluation(evaluation.id)))
        })
        const measured = relevant.filter(observation => observation.decision !== "failed" && validEvaluation(observation.evaluationId))
        let trusted: ResearchDomain.EpistemicLevel = measuredReference || measured.length
          ? "computational_support" : "model_observation"
        if (new Set(measured.flatMap(observation => observation.modelIds)).size > 1) trusted = "cross_model_support"
        if (new Set(measured.flatMap(observation => observation.seeds)).size > 1) trusted = "multi_seed_support"
        const requestedRank = levels.indexOf(update.evidenceLevel)
        const trustedRank = levels.indexOf(trusted)
        const evidenceLevel = levels[Math.min(requestedRank, trustedRank)]!
        const overclaimsPhysicalValidation = trustedRank < levels.indexOf("experimental_support")
          && /\b(?:physically\s+)?(?:confirmed|validated|proven)\b/i.test(update.statement)
          && /\b(?:bind(?:er|ing|s)?|specific(?:ity)?|engage(?:ment|s|d)?|affinity)\b/i.test(update.statement)
        const boundedWording = trusted === "model_observation" ? "hypothesized" : "computationally supported"
        const statement = overclaimsPhysicalValidation
          ? update.statement
            .replace(/\bphysically\s+confirmed\b/gi, boundedWording)
            .replace(/\b(?:confirmed|validated|proven)\b/gi, boundedWording)
          : update.statement
        const epistemicLimitation = requestedRank > trustedRank
          ? [`Requested ${update.evidenceLevel}, but trusted campaign evidence supports at most ${trusted}; computational evidence cannot establish physical binding.`]
          : []
        if (overclaimsPhysicalValidation) {
          epistemicLimitation.push(`The submitted hypothesis wording claimed physical validation; the trusted service bounded it to ${trusted === "model_observation" ? "an unverified hypothesis" : "computational support"}.`)
        }
        const existing = update.hypothesisId
          ? state.hypotheses[update.hypothesisId]
          : Object.values(state.hypotheses).find(
              (hypothesis) => hypothesis.campaignId === campaignId && hypothesis.statement.trim().toLowerCase() === update.statement.trim().toLowerCase(),
            )
        if (update.hypothesisId && (!existing || existing.campaignId !== campaignId)) {
          throw new NotFoundError({ entity: "hypothesis", id: update.hypothesisId })
        }
        const hypothesis = ResearchDomain.ResearchHypothesis.parse({
          id: existing?.id ?? this.id("hyp"),
          campaignId,
          category: update.category,
          statement,
          status: update.status,
          confidence: update.confidence,
          evidenceLevel,
          supportingEvidenceRefs: [...new Set([
            ...(existing?.supportingEvidenceRefs ?? []),
            ...update.supportingEvidenceRefs,
          ])],
          opposingEvidenceRefs: [...new Set([
            ...(existing?.opposingEvidenceRefs ?? []),
            ...update.opposingEvidenceRefs,
          ])],
          prediction: update.prediction,
          falsificationCriterion: update.falsificationCriterion,
          recommendedExperiment: update.recommendedExperiment,
          limitations: [...new Set([
            ...(existing?.limitations ?? []),
            ...update.limitations,
            ...epistemicLimitation,
          ])],
          generated: { by: generatedBy, at: updatedAt },
          createdAt: existing?.createdAt ?? updatedAt,
          updatedAt,
        })
        state.hypotheses[hypothesis.id] = hypothesis
        return hypothesis
      })
    }

    private assertEvidence(state: ResearchState, scope: CampaignEvidence.Scope, references: readonly string[], label: string): void {
      try {
        CampaignEvidence.resolve(state, scope).assert(references, label)
      } catch (error) {
        if (!(error instanceof CampaignEvidence.ResolutionError)) throw error
        throw new ConflictError({ code: "evidence_outside_scope", message: error.message })
      }
    }

    private ensureCampaignCharter(
      state: ResearchState,
      campaign: ResearchDomain.Campaign,
    ): ResearchDomain.CampaignCharter {
      const existing = state.campaignCharters[campaign.id]
      if (existing) return existing
      const timestamp = this.now()
      const charter = ResearchDomain.CampaignCharter.parse({
        id: this.id("chr"),
        campaignId: campaign.id,
        version: 1,
        objective: campaign.objective,
        successCriteria: [{
          id: "biological_objective",
          statement: "Produce a candidate that satisfies the full campaign objective recorded in this charter, with robust, independently supported evidence.",
          requiredEvidenceLevel: "multi_seed_support",
          status: "open",
        }],
        requiredControls: [
          "Specificity interpretations require controls with matched candidate-panel cardinality under a frozen evaluator contract.",
          "Breakthrough claims require confirmation across more than one frozen seed or an explicitly approved experimental evidence source.",
        ],
        stopConditions: [
          { kind: "budget_exhausted", criterion: "The approved campaign or experiment compute budget is exhausted." },
          { kind: "improvement_plateau", criterion: "Comparable locked scores plateau without a justified information-gain experiment." },
          { kind: "repeated_equivalent_proposals", criterion: "The author repeatedly proposes equivalent programs without replication justification." },
          { kind: "insufficient_evidence", criterion: "No authorized experiment can resolve the leading uncertainty." },
          { kind: "breakthrough", criterion: "Every open success criterion reaches its required trusted evidence level." },
          { kind: "approval_required", criterion: "Progress requires changing a frozen contract or crossing an external approval boundary." },
        ],
        constraints: {
          requireMatchedControlCardinality: true,
          requireMultiSeedConfirmation: true,
        },
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      state.campaignCharters[campaign.id] = charter
      return charter
    }

    private campaign(state: ResearchState, id: string): ResearchDomain.Campaign {
      const campaign = state.campaigns[id]
      if (!campaign) throw new NotFoundError({ entity: "campaign", id })
      return campaign
    }

    private experiment(state: ResearchState, id: string): ResearchDomain.Experiment {
      const experiment = state.experiments[id]
      if (!experiment) throw new NotFoundError({ entity: "experiment", id })
      return experiment
    }

    private trial(state: ResearchState, id: string): ResearchDomain.Trial {
      const trial = state.trials[id]
      if (!trial) throw new NotFoundError({ entity: "trial", id })
      return trial
    }

    private run(state: ResearchState, id: string): ResearchDomain.Run {
      const run = state.runs[id]
      if (!run) throw new NotFoundError({ entity: "run", id })
      return run
    }
  }
}
