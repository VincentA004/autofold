import z from "zod"
import { EvidenceView } from "./evidence-view"
import { ExperimentBranches } from "./experiment-branches"
import type { ResearchState } from "./store"
import { CampaignEvidence } from "./campaign-evidence"

/** Scientist-authored interpretation, explicitly separate from trusted measurements. */
export namespace ScientistReview {
  export class ValidationError extends Error {
    constructor(message: string) { super(message); this.name = "ScientistReviewValidationError" }
  }
  export class RevisionConflictError extends ValidationError {
    readonly code = "SCIENTIST_REVIEW_REVISION_CONFLICT"
    constructor(readonly conflict: {
      runId: string
      expectedRevision: number
      actualRevision: number
      currentReviewId?: string
    }) {
      super(conflict.actualRevision === 0
        ? `Review revision conflict for ${conflict.runId}: expectedRevision=${conflict.expectedRevision}, actualRevision=0. ` +
          `No review exists for this run; its first review requires expectedRevision=0. Reviews for other runs do not advance this run.`
        : `Review revision conflict for ${conflict.runId}: expectedRevision=${conflict.expectedRevision}, ` +
          `actualRevision=${conflict.actualRevision}, currentReviewId=${conflict.currentReviewId}`)
      this.name = "ScientistReviewRevisionConflictError"
    }
  }
  export class BranchRevisionConflictError extends ValidationError {
    readonly code = "SCIENTIST_REVIEW_BRANCH_REVISION_CONFLICT"
    constructor(readonly conflict: {
      runId: string
      branchId: string
      expectedRevision: number
      actualRevision: number
      actualStatus: "open" | "deferred" | "retired"
    }) {
      super(
        `Branch revision conflict while reviewing ${conflict.runId} for ${conflict.branchId}: ` +
        `expectedRevision=${conflict.expectedRevision}, actualRevision=${conflict.actualRevision}, ` +
        `actualStatus=${conflict.actualStatus}`,
      )
      this.name = "ScientistReviewBranchRevisionConflictError"
    }
  }
  const Text = z.string().trim().min(1).max(2000)
  export const MeasuredClaim = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("candidate_metric"), candidateId: z.string().trim().min(1), stage: z.string().trim().min(1).optional(),
      modelId: z.string().trim().min(1), metric: z.string().trim().min(1), seedMean: z.number().finite(),
      rank: z.number().finite().positive().nullable(),
    }).passthrough(),
    z.object({
      kind: z.literal("candidate_contrast"), stage: z.string().trim().min(1).optional(), modelId: z.string().trim().min(1),
      metric: z.string().trim().min(1), leftCandidateId: z.string().trim().min(1), rightCandidateId: z.string().trim().min(1),
      seedMeanDifference: z.number().finite(), pairedCount: z.number().int().nonnegative(),
      pairedMeanDifference: z.number().finite().nullable(),
    }).passthrough(),
  ])
  export const Input = z.object({
    runId: z.string().startsWith("run_"), expectedRevision: z.number().int().nonnegative().describe("Revision of the existing scientist review for this runId in REVIEWS.json. Use 0 when this run has no review. This is not a notebook, branch, or campaign revision."),
    finding: Text, interpretation: Text,
    predictionAssessment: z.enum(["supported_for_tested_predicate", "not_supported_for_tested_predicate", "unresolved"]),
    remainingExplanations: z.array(Text).min(1).max(8), limitations: z.array(Text).min(1).max(8), nextDecision: Text,
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).max(30),
    measuredClaims: z.array(MeasuredClaim).max(20).default([]),
    measurementRefs: z.array(z.string().regex(/^mcl_[a-f0-9]{64}$/)).max(20).optional()
      .describe("Select IDs from this run’s evidenceSummary.measurementCatalog; the harness copies exact verified values into measuredClaims."),
    branchUpdates: z.array(ExperimentBranches.Action.options[3]).max(12).default([]),
  }).passthrough()
  export const Record = Input.extend({id:z.string(), experimentId:z.string(), campaignId:z.string(),
    revision:z.number().int().positive(), createdAt:z.string(), decisionPlan:z.unknown().optional(),
    evidenceSummary:z.unknown(), epistemicStatus:z.literal("scientist_interpretation")})
  export const Card = Record.pick({id:true,runId:true,experimentId:true,revision:true,createdAt:true,
    predictionAssessment:true,interpretation:true,nextDecision:true,limitations:true,evidenceRefs:true,epistemicStatus:true}).extend({proseTruncated:z.boolean()})
  export const Projection = z.object({items:z.array(Card).max(4),total:z.number().int().nonnegative(),truncated:z.boolean()})
  /** Latest scoped interpretations, bounded independently of their full numerical receipt tables. */
  export function project(records: unknown[], scope: {campaignId:string;experimentId?:string;runIds:ReadonlySet<string>}) {
    const latest=new Map<string,z.infer<typeof Record>>()
    for(const raw of records){
      const parsed=Record.safeParse(raw);if(!parsed.success)continue
      const review=parsed.data
      if(review.campaignId!==scope.campaignId || scope.experimentId && review.experimentId!==scope.experimentId || !scope.runIds.has(review.runId))continue
      const previous=latest.get(review.runId)
      if(!previous || review.revision>previous.revision)latest.set(review.runId,review)
    }
    const selected=[...latest.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,4)
    return Projection.parse({total:latest.size,truncated:latest.size>selected.length,items:selected.map(review=>({
      id:review.id,runId:review.runId,experimentId:review.experimentId,revision:review.revision,createdAt:review.createdAt,
      predictionAssessment:review.predictionAssessment,interpretation:review.interpretation.slice(0,600),nextDecision:review.nextDecision.slice(0,600),
      limitations:review.limitations.slice(0,2).map(text=>text.slice(0,300)),evidenceRefs:review.evidenceRefs.slice(0,8),epistemicStatus:review.epistemicStatus,
      proseTruncated:review.interpretation.length>600||review.nextDecision.length>600||review.limitations.length>2||review.limitations.some(text=>text.length>300)||review.evidenceRefs.length>8,
    }))})
  }
  export function commit(state: ResearchState, experimentId: string, raw: z.input<typeof Input>, evidenceSummary: unknown, at: string) {
    const input = Input.parse(raw)
    const experiment = state.experiments[experimentId]
    const observation = Object.values(state.searchObservations).find(o => o.experimentId === experimentId && o.runId === input.runId)
    if (!experiment || !observation) throw new ValidationError("Review requires a settled run in this experiment")
    if (!input.evidenceRefs.includes(input.runId)) throw new ValidationError(`Review must cite its run ${input.runId}`)
    try {
      CampaignEvidence.resolve(state, { campaignId: experiment.campaignId, experimentId }).assert(
        input.evidenceRefs,
        "Scientist review evidence",
      )
    } catch (error) {
      if (error instanceof CampaignEvidence.ResolutionError) throw new ValidationError(error.message)
      throw error
    }
    const {measurementRefs, ...resolved} = input
    if (measurementRefs?.length) {
      const table = evidenceSummary && typeof evidenceSummary === "object" && "candidateTable" in evidenceSummary
        ? (evidenceSummary as {candidateTable: Parameters<typeof EvidenceView.measurementCatalog>[0]}).candidateTable : undefined
      if (!table) throw new ValidationError("Measurement references require this run's trusted candidateTable")
      const catalog = new Map(EvidenceView.measurementCatalog(table).map(item => [item.id, item.claim]))
      const missing = measurementRefs.filter(id => !catalog.has(id))
      if (missing.length) throw new ValidationError(`Unknown measurement references for ${input.runId}: ${missing.join(", ")}. Select from this run's evidenceSummary.measurementCatalog.`)
      resolved.measuredClaims = [...resolved.measuredClaims, ...new Set(measurementRefs)].flatMap(item =>
        typeof item === "string" ? [MeasuredClaim.parse(catalog.get(item))] : [item])
      if (resolved.measuredClaims.length > 20) throw new ValidationError("At most 20 measured claims including references")
    }
    validateMeasuredClaims(resolved.measuredClaims, evidenceSummary)
    // Adding an empty optional receipt must not change historical retry IDs.
    const { measuredClaims, ...legacyIdentity } = resolved
    const identity = measuredClaims.length ? resolved : legacyIdentity
    const id = "srv_" + new Bun.CryptoHasher("sha256").update(JSON.stringify([experimentId,identity])).digest("hex")
    if (state.scientistReviews[id]) return state.scientistReviews[id] // exact retry, including branch effects
    const previous = Object.values(state.scientistReviews).filter(r => r.runId === input.runId).sort((a,b) => a.revision-b.revision).at(-1)
    const actualRevision = previous?.revision ?? 0
    if (input.expectedRevision !== actualRevision) throw new RevisionConflictError({
      runId:input.runId,expectedRevision:input.expectedRevision,actualRevision,currentReviewId:previous?.id,
    })
    if (new Set(input.branchUpdates.map(b => b.branchId)).size !== input.branchUpdates.length) throw new ValidationError("Duplicate branch update")
    // Validate every update before making any change, including in memory stores.
    for (const update of input.branchUpdates) {
      const branch = state.experimentBranches[update.branchId]
      if (!branch || branch.experimentId !== experimentId || branch.contractHash !== experiment.contractHash) throw new ValidationError("Review branch outside frozen experiment")
      if (branch.revision !== update.expectedRevision) throw new BranchRevisionConflictError({
        runId:input.runId,branchId:branch.id,expectedRevision:update.expectedRevision,
        actualRevision:branch.revision,actualStatus:branch.status,
      })
    }
    const record = Record.parse({...resolved,id,experimentId,campaignId:experiment.campaignId,revision:input.expectedRevision+1,
      createdAt:at,decisionPlan:observation.decisionPlan,evidenceSummary,epistemicStatus:"scientist_interpretation"})
    for (const update of input.branchUpdates) ExperimentBranches.update(state,experimentId,update,at)
    state.scientistReviews[id] = record
    return record
  }

  function validateMeasuredClaims(claims: z.infer<typeof MeasuredClaim>[], rawSummary: unknown): void {
    if (!claims.length) return
    const table = z.object({
      rows: z.array(z.object({ candidateId: z.string(), stage: z.string().optional(), modelId: z.string(),
        metrics: z.record(z.string(), z.object({ seedMean: z.number().finite().nullable(), rank: z.number().finite().positive().nullable() }).passthrough()) }).passthrough()),
      contrasts: z.array(z.object({ stage: z.string().optional(), modelId: z.string(), metric: z.string(),
        leftCandidateId: z.string(), rightCandidateId: z.string(), seedMeanDifference: z.number().finite(),
        pairedCount: z.number().int().nonnegative(), pairedMeanDifference: z.number().finite().nullable() }).passthrough()),
    }).passthrough().safeParse(rawSummary && typeof rawSummary === "object" && "candidateTable" in rawSummary
      ? (rawSummary as { candidateTable: unknown }).candidateTable : undefined)
    if (!table.success) throw new ValidationError("Measured claims require the trusted candidateTable evidence summary")
    const errors: string[] = []
    for (const claim of claims) {
      if (claim.kind === "candidate_metric") {
        const row = table.data.rows.find(item => item.candidateId === claim.candidateId && item.stage === claim.stage &&
          item.modelId === claim.modelId)
        const expected = row?.metrics[claim.metric]
        if (expected?.seedMean !== claim.seedMean || expected?.rank !== claim.rank) {
          const identity = `${claim.candidateId}/${claim.stage ?? "no-stage"}/${claim.modelId}/${claim.metric}`
          errors.push(expected
            ? `Measured candidate_metric ${identity} does not match trusted values: expected ${JSON.stringify(expected)}, received ${JSON.stringify({ seedMean: claim.seedMean, rank: claim.rank })}`
            : `Measured candidate_metric has unknown identity ${identity}; available metrics for that candidate/stage/model: ${Object.keys(row?.metrics ?? {}).sort().join(", ") || "none"}`)
        }
        continue
      }
      const expected = table.data.contrasts.find(contrast => contrast.stage === claim.stage && contrast.modelId === claim.modelId &&
        contrast.metric === claim.metric && contrast.leftCandidateId === claim.leftCandidateId &&
        contrast.rightCandidateId === claim.rightCandidateId)
      const received = { seedMeanDifference: claim.seedMeanDifference, pairedCount: claim.pairedCount,
        pairedMeanDifference: claim.pairedMeanDifference }
      if (!expected || expected.seedMeanDifference !== claim.seedMeanDifference || expected.pairedCount !== claim.pairedCount ||
        expected.pairedMeanDifference !== claim.pairedMeanDifference) {
        const identity = `${claim.leftCandidateId}-${claim.rightCandidateId}/${claim.stage ?? "no-stage"}/${claim.modelId}/${claim.metric}`
        errors.push(expected
          ? `Measured candidate_contrast ${identity} does not match trusted values: expected ${JSON.stringify({ seedMeanDifference: expected.seedMeanDifference, pairedCount: expected.pairedCount, pairedMeanDifference: expected.pairedMeanDifference })}, received ${JSON.stringify(received)}`
          : `Measured candidate_contrast has unknown directed identity ${identity}; copy the left/right IDs and paired fields from the trusted candidate table`)
      }
    }
    if (errors.length) throw new ValidationError(errors.join("\n"))
  }
}
