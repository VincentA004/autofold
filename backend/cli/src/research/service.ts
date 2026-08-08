import crypto from "node:crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { ResearchDomain } from "./domain"
import { ResearchKnowledge } from "./knowledge"
import { StorageResearchStore, type ResearchState, type ResearchStore } from "./store"

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ResearchService {
  const log = Log.create({ service: "research.knowledge" })

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
    hypothesis: z.string().trim().min(1),
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1).max(4_000),
    programHash: digest,
    parentTrialId: z.string().startsWith("trl_").optional(),
  })
  export type CreateTrialInput = z.infer<typeof CreateTrialInput>

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
    reviewedBy: z.string().trim().min(1),
  })
  export type ReviewClaimInput = z.infer<typeof ReviewClaimInput>

  export const ReviewAlignmentInput = z.object({
    status: z.enum(["reviewed", "contested", "deprecated"]),
    reviewedBy: z.string().trim().min(1),
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
      unresolvedQuestions: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
      campaignSummary: z.string().trim().min(1).max(4_000).optional(),
      nextExperiment: ResearchDomain.NextExperimentProposal.optional(),
      question: z.string().trim().min(1).max(2_000).optional(),
      trigger: ResearchDomain.KnowledgeCycle.shape.trigger.default("literature_review"),
      inputKnowledgeIds: z.array(z.string().startsWith("knw_")).max(1_000).default([]),
    })
    .superRefine((review, context) => {
      const keys = new Set(review.sources.map((source) => source.key))
      if (keys.size !== review.sources.length) {
        context.addIssue({ code: "custom", path: ["sources"], message: "Literature source keys must be unique" })
      }
      for (const [claimIndex, claim] of review.claims.entries()) {
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
      if (review.claims.length === 0 && review.unresolvedQuestions.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["unresolvedQuestions"],
          message: "A review with no supported claims must record an unresolved question",
        })
      }
    })
  export type LiteratureReviewInput = z.input<typeof LiteratureReviewInput>

  export interface Options {
    now?: () => string
    id?: (prefix: "cmp" | "exp" | "trl" | "evl" | "run" | "knw" | "lit" | "clm" | "aln" | "kcy") => string
  }

  export interface EvaluationResult {
    evaluation: ResearchDomain.Evaluation
    trial: ResearchDomain.Trial
    experiment: ResearchDomain.Experiment
    decision: "promoted" | "rejected"
    knowledge: ResearchDomain.KnowledgeConcept
  }

  export class Service {
    private readonly now: () => string
    private readonly id: (
      prefix: "cmp" | "exp" | "trl" | "evl" | "run" | "knw" | "lit" | "clm" | "aln" | "kcy",
    ) => string

    constructor(
      private readonly store: ResearchStore,
      options: Options = {},
    ) {
      this.now = options.now ?? (() => new Date().toISOString())
      this.id = options.id ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`)
    }

    async listCampaigns(projectId: string): Promise<ResearchDomain.Campaign[]> {
      const state = await this.store.read(projectId)
      return Object.values(state.campaigns).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async listKnowledge(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeConcept[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.knowledge)
        .filter((concept) => concept.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

    async getKnowledge(
      projectId: string,
      campaignId: string,
      conceptId: string,
    ): Promise<ResearchDomain.KnowledgeConcept> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      const concept = state.knowledge[conceptId]
      if (!concept || concept.campaignId !== campaignId) {
        throw new NotFoundError({ entity: "knowledge", id: conceptId })
      }
      return concept
    }

    async listLiterature(projectId: string, campaignId: string): Promise<ResearchDomain.LiteratureRecord[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.literature)
        .filter((record) => record.campaignId === campaignId)
        .toSorted((a, b) => b.retrievedAt.localeCompare(a.retrievedAt) || a.id.localeCompare(b.id))
    }

    async ingestLiterature(
      projectId: string,
      campaignId: string,
      raw: IngestLiteratureInput,
    ): Promise<ResearchDomain.LiteratureRecord> {
      const input = IngestLiteratureInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
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
          id: this.id("lit"),
          campaignId,
          ...input,
          contentHash,
          retrievedAt: this.now(),
        })
        state.literature[record.id] = record
        return record
      })
    }

    async listClaims(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeClaim[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.claims)
        .filter((claim) => claim.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

    async listAlignments(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeAlignment[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      return Object.values(state.alignments)
        .filter((alignment) => alignment.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    }

    async listKnowledgeCycles(projectId: string, campaignId: string): Promise<ResearchDomain.KnowledgeCycle[]> {
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
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
      const state = await this.store.read(projectId)
      this.campaign(state, campaignId)
      const cycles = Object.values(state.knowledgeCycles)
        .filter((cycle) => cycle.campaignId === campaignId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      const processed = new Set(cycles.flatMap((cycle) => cycle.inputs.knowledgeIds))
      const unprocessedKnowledgeIds = Object.values(state.knowledge)
        .filter((concept) => concept.campaignId === campaignId && !processed.has(concept.id))
        .map((concept) => concept.id)
        .toSorted()
      const latest = cycles[0]
      const reasons = [
        ...(!latest ? ["no_prior_knowledge_cycle"] : []),
        ...(unprocessedKnowledgeIds.length ? ["new_experiment_results"] : []),
        ...(latest && this.now() >= latest.nextReviewAt ? ["scheduled_refresh_due"] : []),
      ]
      return {
        due: reasons.length > 0,
        reasons,
        unprocessedKnowledgeIds,
        ...(latest ? { nextReviewAt: latest.nextReviewAt } : {}),
      }
    }

    async reviewAlignment(
      projectId: string,
      campaignId: string,
      alignmentId: string,
      raw: ReviewAlignmentInput,
    ): Promise<ResearchDomain.KnowledgeAlignment> {
      const input = ReviewAlignmentInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const alignment = state.alignments[alignmentId]
        if (!alignment || alignment.campaignId !== campaignId) {
          throw new NotFoundError({ entity: "alignment", id: alignmentId })
        }
        const updated = ResearchDomain.KnowledgeAlignment.parse({
          ...alignment,
          status: input.status,
          reviewed: { by: input.reviewedBy, at: this.now() },
        })
        state.alignments[alignment.id] = updated
        return updated
      })
    }

    async createClaim(
      projectId: string,
      campaignId: string,
      raw: CreateClaimInput,
    ): Promise<ResearchDomain.KnowledgeClaim> {
      const input = CreateClaimInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        for (const evidence of input.evidence) {
          const literature = state.literature[evidence.literatureId]
          if (!literature || literature.campaignId !== campaignId) {
            throw new NotFoundError({ entity: "literature", id: evidence.literatureId })
          }
          if (
            evidence.excerpt &&
            !literature.excerpts.includes(evidence.excerpt) &&
            !literature.summary?.includes(evidence.excerpt)
          ) {
            throw new ConflictError({
              code: "claim_excerpt_not_frozen",
              message: `Claim excerpt is not present in literature record ${literature.id}`,
            })
          }
        }
        const claim = ResearchDomain.KnowledgeClaim.parse({
          id: this.id("clm"),
          campaignId,
          kind: input.kind,
          statement: input.statement,
          stance: input.stance,
          confidence: input.confidence,
          evidence: input.evidence,
          status: "proposed",
          generated: { by: input.generatedBy, at: this.now() },
          createdAt: this.now(),
        })
        state.claims[claim.id] = claim
        return claim
      })
    }

    async reviewClaim(
      projectId: string,
      campaignId: string,
      claimId: string,
      raw: ReviewClaimInput,
    ): Promise<ResearchDomain.KnowledgeClaim> {
      const input = ReviewClaimInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        this.campaign(state, campaignId)
        const claim = state.claims[claimId]
        if (!claim || claim.campaignId !== campaignId) throw new NotFoundError({ entity: "claim", id: claimId })
        const updated = ResearchDomain.KnowledgeClaim.parse({
          ...claim,
          status: input.status,
          reviewed: { by: input.reviewedBy, at: this.now() },
        })
        state.claims[claimId] = updated
        return updated
      })
    }

    async ingestLiteratureReview(
      projectId: string,
      campaignId: string,
      raw: LiteratureReviewInput,
    ): Promise<{
      records: ResearchDomain.LiteratureRecord[]
      claims: ResearchDomain.KnowledgeClaim[]
      alignments: ResearchDomain.KnowledgeAlignment[]
      cycle: ResearchDomain.KnowledgeCycle
      unresolvedQuestions: string[]
    }> {
      const input = LiteratureReviewInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const campaign = this.campaign(state, campaignId)
        for (const knowledgeId of input.inputKnowledgeIds) {
          const concept = state.knowledge[knowledgeId]
          if (!concept || concept.campaignId !== campaignId) {
            throw new NotFoundError({ entity: "knowledge", id: knowledgeId })
          }
        }
        if (input.nextExperiment?.experimentId) {
          const proposedExperiment = state.experiments[input.nextExperiment.experimentId]
          if (!proposedExperiment || proposedExperiment.campaignId !== campaignId) {
            throw new NotFoundError({ entity: "experiment", id: input.nextExperiment.experimentId })
          }
        }
        const inputClaimIds = Object.values(state.claims)
          .filter((claim) => claim.campaignId === campaignId)
          .map((claim) => claim.id)
          .toSorted()
        const inputLiteratureIds = Object.values(state.literature)
          .filter((record) => record.campaignId === campaignId)
          .map((record) => record.id)
          .toSorted()
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
            if (
              item.excerpt &&
              !record.excerpts.includes(item.excerpt) &&
              !record.summary?.includes(item.excerpt)
            ) {
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
        const nextReview = new Date(createdAt)
        nextReview.setUTCDate(nextReview.getUTCDate() + 7)
        const cycle = ResearchDomain.KnowledgeCycle.parse({
          id: this.id("kcy"),
          campaignId,
          trigger: input.trigger,
          question: input.question ?? campaign.objective,
          inputs: {
            knowledgeIds: [...new Set(input.inputKnowledgeIds)].toSorted(),
            claimIds: inputClaimIds,
            literatureIds: inputLiteratureIds,
          },
          outputs: {
            literatureIds: [...new Set(records.map((record) => record.id))].toSorted(),
            claimIds: claims.map((claim) => claim.id).toSorted(),
            alignmentIds: alignments.map((alignment) => alignment.id).toSorted(),
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

    async createTrial(projectId: string, experimentId: string, raw: CreateTrialInput): Promise<ResearchDomain.Trial> {
      const input = CreateTrialInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const experiment = this.experiment(state, experimentId)
        if (experiment.status !== "active") {
          throw new ConflictError({
            code: "experiment_not_active",
            message: `Experiment ${experimentId} must be active before creating a trial`,
          })
        }
        ResearchDomain.assertContractIntegrity(experiment)
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
          hypothesis: input.hypothesis,
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
      paths: { runId?: string; bundlePath: string; outputPath: string },
    ): Promise<ResearchDomain.Run> {
      return this.store.mutate(projectId, (state) => {
        const trial = this.trial(state, trialId)
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
        const timestamp = this.now()
        const run = ResearchDomain.Run.parse({
          id: paths.runId ?? this.id("run"),
          trialId,
          status: "queued",
          bundlePath: paths.bundlePath,
          outputPath: paths.outputPath,
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

    async getRun(projectId: string, runId: string): Promise<ResearchDomain.Run> {
      return this.run(await this.store.read(projectId), runId)
    }

    async failRun(projectId: string, runId: string, message: string, workspace?: string): Promise<ResearchDomain.Run> {
      const error = message.trim().slice(0, 4_000) || "Unknown worker failure"
      const result = await this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
        if (["succeeded", "failed", "cancelled"].includes(run.status)) {
          const existing = Object.values(state.knowledge).find(
            (concept) => concept.runId === run.id && concept.type === "Research Failure",
          )
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
        return { run: updated, campaignId: campaign.id }
      })
      if (workspace && result.campaignId) {
        await this.publishKnowledge(projectId, result.campaignId, workspace).catch((cause) =>
          log.warn("failed to write derived OKF bundle", {
            projectId,
            campaignId: result.campaignId,
            error: cause,
          }),
        )
      }
      return result.run
    }

    async completeRun(
      projectId: string,
      runId: string,
      raw: RecordEvaluationInput,
      manifestHash: string,
      workspace?: string,
    ): Promise<EvaluationResult & { run: ResearchDomain.Run }> {
      const input = RecordEvaluationInput.parse(raw)
      const result = await this.store.mutate(projectId, (state) => {
        const run = this.run(state, runId)
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
        return { ...result, run: completedRun }
      })
      if (workspace) {
        await this.publishKnowledge(projectId, result.knowledge.campaignId, workspace).catch((error) =>
          log.warn("failed to write derived OKF bundle", {
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
      return { experiment, trials, evaluations, runs }
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
      const promote = ResearchDomain.shouldPromote({
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
      const decision = promote ? "promoted" : "rejected"
      const knowledge = ResearchDomain.KnowledgeConcept.parse({
        id: this.id("knw"),
        campaignId: campaign.id,
        experimentId: experiment.id,
        trialId: trial.id,
        evaluationId: evaluation.id,
        runId: run?.id,
        type: "Research Evaluation",
        title: `${decision === "promoted" ? "Promoted" : "Rejected"} trial ${trial.id}`,
        description: input.valid
          ? `Locked evaluation ${decision} trial ${trial.id} with score ${input.score}.`
          : `Locked evaluation rejected trial ${trial.id} because its result was invalid.`,
        tags: ["autofold", "research-evaluation", decision, input.valid ? "valid" : "invalid"],
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
      })
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

export const Research = new ResearchService.Service(new StorageResearchStore())
