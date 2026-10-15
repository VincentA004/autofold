import z from "zod"
import { createHash } from "node:crypto"
import type { ResearchDomain } from "./domain"

export namespace ResearchQuestions {
  const Text = z.string().trim().min(1).max(2000)
  const RequestId = z.string().regex(/^(?:sobs|rq)_[A-Za-z0-9_-]+$/)
  export const EvidenceSnapshot = z.object({
    id: z.string().regex(/^(knw|kcy|evl|run|trl)_[A-Za-z0-9_-]+$/),
    expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()
  export const Update = z.object({
    requestId: RequestId,
    expectedRevision: z.string().startsWith("kcy_").nullable(),
    status: z.enum(["open", "answered", "blocked"]),
    assessment: Text, remainingGap: Text, nextAction: Text,
    reopenReason: Text.optional(),
    literatureIds: z.array(z.string().startsWith("lit_")).max(50),
    evidenceSnapshots: z.array(EvidenceSnapshot).max(100).default([]),
    expectedRequestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  }).passthrough()
  export const Proposal = Update.omit({ literatureIds: true }).extend({
    sourceKeys: z.array(Text).max(50),
    evidenceRefs: z.array(z.string().regex(/^(knw|kcy)_[A-Za-z0-9_-]+$/)).max(30).default([]),
  })
  export function validateUpdates(questions: Array<{ requestId: string; revision: string | null; status: string }>,
    updates: Array<{ requestId: string; expectedRevision: string | null; status: string; reopenReason?: string }>) {
    const seen = new Set<string>()
    for (const update of updates) {
      const question = questions.find(q => q.requestId === update.requestId)
      if (!question || seen.has(update.requestId)) throw new Error("Unknown or duplicate research request")
      seen.add(update.requestId)
      if (question.revision !== update.expectedRevision) throw new Error("Stale research request revision; reload evidence before assessing")
      if (update.status === "open" && question.status !== "open" && !update.reopenReason) throw new Error("Reopening a research request requires a concrete new evidence, capability, or approach reason")
    }
  }
  type Routing = {purpose?: "empirical_test" | "knowledge_lookup"; prerequisiteBranchId?: string}
  type Question = {status: string; origin?: string; request: Routing; authoritativeRequest?: Routing}
  /** Research is advisory, including historical requests and saved branch annotations.
   * Assessment status and provenance remain intact for the separate research process. */
  export function blocksExperiment(_question: Question): boolean { return false }
  export function blocksBranch(_question: Question, _branchId: string): boolean { return false }
  export function identity(request: { question: string; requiredEvidence: string } & Routing): string {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim()
    const identity: (string | null)[] = [normalize(request.question), normalize(request.requiredEvidence)]
    if (request.purpose) identity.push(request.purpose, request.prerequisiteBranchId ?? null)
    return JSON.stringify(identity)
  }
  export function validateReference(request: { action?: string; existingRequestId?: string; expectedRevision?: string | null; reopenReason?: string; question?: string; requiredEvidence?: string } & Routing | undefined,
    rawQuestions: unknown[], experimentId: string) {
    const questions = z.array(z.object({requestId:RequestId, occurrenceIds:z.array(RequestId).optional(),experimentId:z.string(),revision:z.string().nullable().optional(),
      request:z.object({question:z.string(),requiredEvidence:z.string(),purpose:z.enum(["empirical_test","knowledge_lookup"]).optional(),prerequisiteBranchId:z.string().optional()}).passthrough().optional()}).passthrough()).parse(rawQuestions)
    if (!request?.existingRequestId) return
    const question = questions.find(q => q.experimentId === experimentId && (q.requestId === request.existingRequestId || q.occurrenceIds?.includes(request.existingRequestId!)))
    if (!["reference","reopen"].includes(request.action ?? "") || !question)
      throw new Error("Unknown research request in this experiment; read QUESTIONS.json and reference its existingRequestId")
    if (question.request && request.question && request.requiredEvidence && identity(request as {question:string;requiredEvidence:string}) !== identity(question.request)) {
      throw new Error(`Research request ${question.requestId} has different question or requiredEvidence; use action=create for a new request`)
    }
    if (request.action === "reopen" && (request.expectedRevision !== question.revision || !request.reopenReason))
      throw new Error("Reopening requires the current expectedRevision and a concrete new evidence/capability/approach reopenReason")
  }
  export function project(observations: ResearchDomain.SearchObservation[], cycles: ResearchDomain.KnowledgeCycle[],
    durableRequests: ResearchDomain.ResearchRequestRecord[] = []) {
    type Source = {
      id: string; campaignId: string; experimentId: string; createdAt: string
      request: ResearchDomain.ResearchRequestRecord["request"]
      evidenceRefs: string[]; internalResult?: boolean; runId?: string; trialId?: string; knowledgeId?: string
    }
    const sources: Source[] = [
      ...observations.filter(o => o.decisionPlan?.researchRequest).map(o => ({
        id: o.id, campaignId: o.campaignId, experimentId: o.experimentId, createdAt: o.createdAt,
        request: o.decisionPlan!.researchRequest!, evidenceRefs: o.decisionPlan!.evidenceRefs,
        runId: o.runId, trialId: o.trialId, knowledgeId: o.knowledgeId,
      })),
      // Backfill historical trusted closeouts into the same revisioned question queue.
      // A narrator string alone is insufficient: require the persisted trajectory linkage.
      ...cycles.filter(cycle => cycle.trigger === "run_completed" &&
        /^autofold-trusted-(?:success|failure)-closeout\/v[12]:run_/.test(cycle.generated?.by ?? ""))
        .flatMap(cycle => {
          const linked = observations.filter(o => o.campaignId === cycle.campaignId &&
            o.knowledgeCycleId === cycle.id && cycle.generated.by.endsWith(":" + o.runId) && cycle.outputs.searchObservationIds?.includes(o.id) &&
            cycle.inputs.knowledgeIds.includes(o.knowledgeId) && o.experimentId === cycle.nextExperiment?.experimentId)
          if (!linked.length || new Set(linked.map(o => o.experimentId)).size !== 1) return []
          return cycle.outputs.unresolvedQuestions.map((question, index) => ({
            id: `rq_${createHash("sha256").update(cycle.id + ":" + index).digest("hex")}`,
            campaignId: cycle.campaignId, experimentId: linked[0].experimentId, createdAt: cycle.createdAt,
            request: { action: "create" as const, question, evidencePolicy: "internal_result_reconciliation",
              competingExplanations: ["Persisted computational evidence supports the interpretation", "Evidence is insufficient or incompatible"],
              requiredEvidence: "Read attributable persisted outcomes and their immutable execution provenance; record an interpretation or remaining gap.",
              applicabilityChecks: "Same experiment, frozen contract and computational evidence only; biological confirmation remains unresolved.",
              decisionIfResolved: "Choose the next bounded scientific decision from the recorded assessment." },
            evidenceRefs: [cycle.id, ...cycle.inputs.knowledgeIds], internalResult: true,
          }))
        }),
      ...durableRequests.map(record => ({
        id: record.id, campaignId: record.campaignId, experimentId: record.experimentId,
        createdAt: record.createdAt, request: record.request, evidenceRefs: record.evidenceRefs,
      })),
    ]
    const requests = [...new Map(sources.map(source => [source.id, source])).values()]
      .filter(source => !source.request.existingRequestId)
      .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(source => {
        const updates = cycles.filter(c => c.campaignId === source.campaignId).flatMap(c =>
          (c.outputs.researchRequestUpdates ?? []).filter(u => u.requestId === source.id).map(u => ({ ...u, revision:c.id })))
        let revision: string | null = null
        let latest: typeof updates[number] | undefined
        const seen = new Set<string>()
        while (true) {
          const next = updates.filter(u => u.expectedRevision === revision)
          if (!next.length) break
          if (next.length !== 1 || seen.has(next[0].revision)) throw new Error("Invalid research-question revision chain")
          latest = next[0]; revision = latest.revision; seen.add(revision)
        }
        if (seen.size !== updates.length) throw new Error("Disconnected research-question revision chain")
        return { requestId:source.id, campaignId:source.campaignId, experimentId:source.experimentId, runId:source.runId,
          trialId:source.trialId, knowledgeId:source.knowledgeId, request:source.request,
          evidenceRefs:source.evidenceRefs, origin:source.internalResult ? "trusted_closeout" : "explicit_request", status:latest?.status ?? "open", revision,
          assessment:latest?.assessment ?? null, remainingGap:latest?.remainingGap ?? null,
          nextAction:latest?.nextAction ?? null, literatureIds:latest?.literatureIds ?? [],
          evidenceSnapshots:latest?.evidenceSnapshots ?? [],
          interpretation:"Answered means an evidence-linked assessment was recorded, not a verified scientific claim." }
      })
    // Identity deliberately excludes the originating run and changing narrative.
    // Different required evidence remains a different question; no fuzzy semantic merge.
    const groups = new Map<string, typeof requests>()
    for (const request of requests) {
      const key = JSON.stringify([request.campaignId, request.experimentId, ...JSON.parse(identity(request.request))])
      const group = groups.get(key) ?? []
      group.push(request); groups.set(key, group)
    }
    const cycleTimes = new Map(cycles.map(c => [c.id, c.createdAt]))
    const projected = [...groups.entries()].map(([identity, group]) => {
      // Preserve every historical chain. The latest assessed alias is authoritative;
      // a new unassessed repeat must never reopen a blocked/answered question.
      const assessed = group.filter(q => q.revision).sort((a, b) =>
        (cycleTimes.get(a.revision!) ?? "").localeCompare(cycleTimes.get(b.revision!) ?? "") || a.revision!.localeCompare(b.revision!))
      const current = assessed.at(-1) ?? group[0]
      return { ...current, identity, occurrenceIds: group.map(q => q.requestId),
        evidenceRefs: [...new Set(group.flatMap(q => q.evidenceRefs ?? []))],
        authoritativeRequest: current.request,
        // Historical field retained for serialized readers. New references are
        // identity-preserving, so this can no longer silently change meaning.
        latestRequest: group.at(-1)!.request }
    })
    const references = sources.filter(source => source.request.existingRequestId)
      .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    for (const source of references) {
      const request = source.request
      const current = projected.find(q => q.campaignId === source.campaignId && q.experimentId === source.experimentId &&
        q.occurrenceIds.includes(request.existingRequestId!))
      if (!current) throw new Error("Unknown referenced research request in this experiment")
      if (!current.occurrenceIds.includes(source.id)) current.occurrenceIds.push(source.id)
      current.evidenceRefs = [...new Set([...current.evidenceRefs, ...source.evidenceRefs])]
      // Reopen is an explicit new request against the same assessment revision.
      // A later knowledge assessment supersedes it; a reference never does.
      if (request.action === "reopen" && (!current.revision || (cycleTimes.get(current.revision) ?? "") < source.createdAt)) {
        if (request.expectedRevision !== current.revision || !request.reopenReason) throw new Error("Stale or unjustified research-question reopen")
        current.status = "open"
        current.nextAction = request.reopenReason
      }
      // An annotation changes neither the assessed request nor its revision/status.
    }
    return projected
  }
}
