import z from "zod"
import type { ResearchDomain } from "./domain"

export namespace TrialReasoning {
  export interface EvidenceCatalog {
    readonly size: number
    has(reference: string): boolean
    assert(references: readonly string[], label?: string): void
  }
  export const Prediction = z.object({
    comparatorTrialId: z.string().startsWith("trl_"),
    metric: z.literal("locked_score"),
    relation: z.enum(["lower", "higher"]),
    minimumDifference: z.number().finite().nonnegative().default(0),
  }).passthrough()
  export type Prediction = z.infer<typeof Prediction>
  export const EvidenceRefs = z.array(z.string().trim().min(1).max(200)).max(30)

  const Text = z.string().trim().min(1).max(2000)
  export const ResearchRequest = z.object({
    action: z.enum(["create", "reference", "reopen"]).optional(),
    // Absent only on historical requests; new scientist requests supply empirical_test.
    purpose: z.enum(["empirical_test", "knowledge_lookup"]).optional(),
    prerequisiteBranchId: z.string().regex(/^brn_[A-Za-z0-9_-]+$/).optional(),
    expectedRevision: z.string().startsWith("kcy_").nullable().optional(),
    reopenReason: Text.optional(),
    existingRequestId: z.string().regex(/^(?:sobs|rq)_[A-Za-z0-9_-]+$/).optional(),
    question: Text,
    competingExplanations: z.array(Text).min(2).max(6),
    requiredEvidence: Text,
    applicabilityChecks: Text,
    decisionIfResolved: Text,
  }).passthrough().superRefine((request, ctx) => {
    if (request.prerequisiteBranchId && request.purpose !== "knowledge_lookup") ctx.addIssue({code:"custom",message:"prerequisiteBranchId is allowed only for knowledge_lookup"})
    if ((request.action === "reference" || request.action === "reopen") !== !!request.existingRequestId) ctx.addIssue({ code: "custom", message: "reference/reopen requires existingRequestId; create must omit it" })
    if (request.action === "reopen" && (!request.reopenReason || request.expectedRevision === undefined)) ctx.addIssue({code:"custom",message:"reopen requires expectedRevision and a concrete reopenReason"})
  })
  export type ResearchRequest = z.infer<typeof ResearchRequest>
  // Optional statistic preserves historical mean-difference plans byte-for-byte.
  export const Measurement = z.object({
    modelId: Text, leftStage: Text, rightStage: Text, metric: Text,
    statistic: z.enum(["mean_difference", "spearman"]).optional(),
    relation: z.enum(["greater", "less"]), threshold: z.number().finite(),
  }).passthrough().superRefine((measurement, ctx) => {
    if (measurement.statistic === "spearman" && Math.abs(measurement.threshold) > 1)
      ctx.addIssue({ code: "custom", message: "Spearman threshold must lie between -1 and 1" })
  })
  export type Measurement = z.infer<typeof Measurement>
  export const DecisionPlan = z.object({
    researchRequest: ResearchRequest.optional(),
    replicationPurpose: Text.optional(),
    changedVariables: z.array(Text).min(1).max(10).optional(),
    controlledVariables: z.array(Text).min(1).max(10).optional(),
    measurement: Measurement.optional(),
    question: Text,
    alternatives: z.array(z.object({
      id: z.string().trim().min(1).max(80), experiment: Text,
      expectedInformation: Text, estimatedGpuHours: z.number().finite().nonnegative(),
    }).passthrough()).min(2).max(6),
    selectedAlternativeId: z.string().trim().min(1).max(80),
    rationale: Text,
    evidenceRefs: EvidenceRefs,
    outcomeBranches: z.array(z.object({ observation: Text, nextDecision: Text }).passthrough()).min(2).max(6),
  }).passthrough().superRefine((plan, ctx) => {
    const ids = plan.alternatives.map((item) => item.id)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Alternative IDs must be unique" })
    if (!ids.includes(plan.selectedAlternativeId)) ctx.addIssue({ code: "custom", message: "Selected alternative must exist" })
  })
  export type DecisionPlan = z.infer<typeof DecisionPlan>

  /** Agent-facing errors identify the Python declaration, not an unqualified nested JSON key. */
  export function parseDecisionPlan(value: unknown): DecisionPlan {
    const result = DecisionPlan.safeParse(value)
    if (result.success) return result.data
    throw new z.ZodError(result.error.issues.map(issue => ({...issue,
      path: ["decision_plan", ...issue.path],
      message: issue.message + (issue.path[0] === "evidenceRefs"
        ? "; set ProtoTrial.decision_plan.evidenceRefs explicitly. ProtoTrial.evidence_refs is a separate field."
        : "; repair this field in ProtoTrial.decision_plan."),
    })))
  }

  export function validateDecisionPlan(plan: DecisionPlan | undefined, known: Set<string> | EvidenceCatalog, gpuCeiling: number, required = false): void {
    if (!plan) {
      if (required) throw new Error("Declare decision_plan on ProtoTrial before evaluation: compare alternatives, select one, and specify outcome-dependent next decisions")
      return
    }
    if (required && plan.researchRequest && !plan.researchRequest.action) throw new Error("Choose researchRequest.action=create, reference or reopen explicitly; use QUESTIONS.json IDs for existing questions")
    if (known.size > 0 && !plan.evidenceRefs.length) throw new Error("Decision plan must cite prior evidence when evidence is available")
    if ("assert" in known) known.assert(plan.evidenceRefs, "Decision plan evidence references")
    else {
      const unresolved = plan.evidenceRefs.filter((ref) => !known.has(ref))
      if (unresolved.length) throw new Error(`Decision plan evidence references do not resolve to persisted evidence: ${unresolved.join(", ")}`)
    }
    const selected = plan.alternatives.find((item) => item.id === plan.selectedAlternativeId)!
    if (selected.estimatedGpuHours > gpuCeiling) throw new Error("Selected experiment estimate exceeds the frozen per-trial GPU ceiling; revise the experiment, not the contract")
  }

  /** Admission evidence, not a claim that upstream generation is deterministic. */
  export function repeatedCandidates(observations: ResearchDomain.SearchObservation[], proposal: {
    configurationFamilyFingerprint?: string; workflowFingerprint?: string; generatorPortfolio?: string[]
  }, experimentId: string) {
    if (!proposal.configurationFamilyFingerprint || !proposal.workflowFingerprint) return []
    const workflow = [...new Map(observations.filter(o => o.experimentId === experimentId &&
      o.workflowFingerprint === proposal.workflowFingerprint && o.realizedCandidateSetHash).map(o => [o.runId, o])).values()]
    const exact = workflow.filter(o => o.configurationFamilyFingerprint === proposal.configurationFamilyFingerprint)
    if (exact.length >= 2) return new Set(exact.map(o => o.realizedCandidateSetHash)).size === 1
      ? exact.map(o => ({ runId: o.runId, candidateSetHash: o.realizedCandidateSetHash, match: "configuration" as const })) : []
    // Source-based family hashes can differ for equivalent programs. Broader
    // observed repetition is useful admission context, never proof of equivalence.
    const portfolio = (values: string[]) => JSON.stringify([...values].sort())
    const similar = proposal.generatorPortfolio?.length ? workflow.filter(o =>
      portfolio(o.generatorPortfolio) === portfolio(proposal.generatorPortfolio!)) : []
    if (similar.length < 2 || new Set(similar.map(o => o.realizedCandidateSetHash)).size !== 1) return []
    return similar.map(o => ({ runId: o.runId, candidateSetHash: o.realizedCandidateSetHash, match: "portfolio_workflow" as const }))
  }
  export function requireReplicationPurpose(plan: DecisionPlan | undefined, repeated: ReturnType<typeof repeatedCandidates>) {
    if (repeated.length && !plan?.replicationPurpose) throw new Error(
      `This configuration or generator portfolio with the same validation workflow returned the same candidate set in ${repeated.length} runs (${repeated.map(r => r.runId).join(", ")}). Inspect existing evidence or declare decision_plan.replicationPurpose explaining the new independent evidence sought before spending another trial.`)
  }

  export function assess(prediction: Prediction | undefined, score: number | null,
    comparator: { valid: boolean; score: number | null } | undefined, valid: boolean) {
    if (!prediction || !valid || score === null || !comparator?.valid || comparator.score === null) {
      return { status: "unresolved" as const, difference: null }
    }
    const difference = prediction.relation === "lower" ? comparator.score - score : score - comparator.score
    return { status: difference > prediction.minimumDifference ? "supported" as const : "refuted" as const, difference }
  }
}
