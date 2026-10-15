import type { ResearchState } from "./store"

export namespace CampaignEvidence {
  export type Kind =
    | "campaign" | "charter" | "experiment" | "trial" | "evaluation" | "run"
    | "knowledge" | "literature" | "claim" | "alignment" | "knowledge_cycle"
    | "skill_version" | "hypothesis" | "search_observation" | "research_request" | "job"

  export type Reference = {
    id: string
    kind: Kind
    campaignId: string
    experimentId?: string
  }

  export type Scope = { campaignId: string; experimentId?: string }
  export type Issue = {
    id: string
    reason: "unknown" | "outside_campaign" | "outside_experiment"
    actual?: Pick<Reference, "kind" | "campaignId" | "experimentId">
    expected: Scope
  }

  export class ResolutionError extends Error {
    override readonly name = "CampaignEvidenceResolutionError"
    constructor(readonly issues: Issue[], label = "Evidence references") {
      super(`${label} do not resolve in the required scope: ${issues.map(issue => {
        const actual = issue.actual
          ? `${issue.actual.kind} in ${issue.actual.campaignId}${issue.actual.experimentId ? `/${issue.actual.experimentId}` : ""}`
          : "not persisted"
        const expected = `${issue.expected.campaignId}${issue.expected.experimentId ? `/${issue.expected.experimentId}` : ""}`
        return `${issue.id} (${issue.reason}; ${actual}; expected ${expected})`
      }).join(", ")}`)
    }
  }

  export interface Catalog {
    readonly scope: Scope
    readonly size: number
    get(id: string): Reference | undefined
    has(id: string): boolean
    issues(ids: readonly string[]): Issue[]
    assert(ids: readonly string[], label?: string): void
    ids(): Set<string>
  }

  export function resolve(state: ResearchState, scope: Scope): Catalog {
    return fromReferences(collect(state).values(), scope)
  }

  export function fromReferences(input: Iterable<Reference>, scope: Scope): Catalog {
    const references = new Map([...input].map(reference => [reference.id, reference]))
    const allowed = (reference: Reference) =>
      reference.campaignId === scope.campaignId &&
      (!scope.experimentId || !reference.experimentId || reference.experimentId === scope.experimentId)
    const issues = (ids: readonly string[]): Issue[] => {
      const result: Issue[] = []
      for (const id of new Set(ids)) {
      const reference = references.get(id)
      if (!reference) {
        result.push({ id, reason: "unknown", expected: scope })
        continue
      }
      if (reference.campaignId !== scope.campaignId) {
        result.push({ id, reason: "outside_campaign",
          actual: { kind: reference.kind, campaignId: reference.campaignId, experimentId: reference.experimentId }, expected: scope })
        continue
      }
      if (scope.experimentId && reference.experimentId && reference.experimentId !== scope.experimentId) {
        result.push({ id, reason: "outside_experiment",
          actual: { kind: reference.kind, campaignId: reference.campaignId, experimentId: reference.experimentId }, expected: scope })
      }
      }
      return result
    }
    return {
      scope,
      // Scope identities are valid references, but their mere presence does
      // not mean a first scientific decision has prior evidence to cite.
      size: [...references.values()].filter(reference => allowed(reference) &&
        !["campaign", "charter", "experiment"].includes(reference.kind)).length,
      get: id => references.get(id),
      has: id => Boolean(references.get(id) && allowed(references.get(id)!)),
      issues,
      assert(ids, label) {
        const unresolved = issues(ids)
        if (unresolved.length) throw new ResolutionError(unresolved, label)
      },
      ids: () => new Set([...references.values()].filter(allowed).map(reference => reference.id)),
    }
  }

  /** Build the same typed resolver from the bounded context projected into a
   * scientist turn. The context is already campaign scoped; IDs retain their
   * exact experiment ownership so cross-experiment citations still fail. */
  export function fromContext(context: {
    experiment: { id: string; campaignId: string }
    history: { trials: Array<{ id: string }>; evaluations: Array<{ id: string; trialId: string }> }
    knowledge: Array<{ id: string; campaignId: string; experimentId: string; runId?: string; trialId: string; evaluationId?: string }>
    literatureClaims: Array<{ id: string; campaignId: string }>
    literatureRecords: Array<{ id: string; campaignId: string }>
    evidenceAlignments?: Array<{ id: string; campaignId: string }>
    knowledgeCycles: Array<{ id: string; campaignId: string }>
    campaignCharter: { id: string; campaignId: string }
    hypothesisLedger: Array<{ id: string; campaignId: string }>
    searchLandscape: Array<{ id: string; campaignId: string; experimentId: string; trialId: string; runId: string; evaluationId?: string; knowledgeId: string; knowledgeCycleId?: string }>
    researchQuestions?: unknown[]
    evidenceCatalog?: Reference[]
  }): Catalog {
    const references: Reference[] = [
      ...(context.evidenceCatalog ?? []),
      { id: context.experiment.campaignId, kind: "campaign", campaignId: context.experiment.campaignId },
      { id: context.experiment.id, kind: "experiment", campaignId: context.experiment.campaignId, experimentId: context.experiment.id },
      { id: context.campaignCharter.id, kind: "charter", campaignId: context.campaignCharter.campaignId },
      ...context.history.trials.map(item => ({ id: item.id, kind: "trial" as const, campaignId: context.experiment.campaignId, experimentId: context.experiment.id })),
      ...context.history.evaluations.map(item => ({ id: item.id, kind: "evaluation" as const, campaignId: context.experiment.campaignId, experimentId: context.experiment.id })),
      ...context.knowledge.map(item => ({ id: item.id, kind: "knowledge" as const, campaignId: item.campaignId, experimentId: item.experimentId })),
      ...context.literatureClaims.map(item => ({ id: item.id, kind: "claim" as const, campaignId: item.campaignId })),
      ...context.literatureRecords.map(item => ({ id: item.id, kind: "literature" as const, campaignId: item.campaignId })),
      ...(context.evidenceAlignments ?? []).map(item => ({ id: item.id, kind: "alignment" as const, campaignId: item.campaignId })),
      ...context.knowledgeCycles.map(item => ({ id: item.id, kind: "knowledge_cycle" as const, campaignId: item.campaignId })),
      ...context.hypothesisLedger.map(item => ({ id: item.id, kind: "hypothesis" as const, campaignId: item.campaignId })),
      ...context.searchLandscape.map(item => ({ id: item.id, kind: "search_observation" as const, campaignId: item.campaignId, experimentId: item.experimentId })),
    ]
    for (const item of context.knowledge) {
      references.push({ id: item.trialId, kind: "trial", campaignId: item.campaignId, experimentId: item.experimentId })
      if (item.runId) references.push({ id: item.runId, kind: "run", campaignId: item.campaignId, experimentId: item.experimentId })
      if (item.evaluationId) references.push({ id: item.evaluationId, kind: "evaluation", campaignId: item.campaignId, experimentId: item.experimentId })
    }
    for (const item of context.searchLandscape) {
      references.push({ id: item.trialId, kind: "trial", campaignId: item.campaignId, experimentId: item.experimentId })
      references.push({ id: item.runId, kind: "run", campaignId: item.campaignId, experimentId: item.experimentId })
      references.push({ id: item.knowledgeId, kind: "knowledge", campaignId: item.campaignId, experimentId: item.experimentId })
      if(item.knowledgeCycleId) references.push({ id: item.knowledgeCycleId, kind: "knowledge_cycle", campaignId: item.campaignId })
      if (item.evaluationId) references.push({ id: item.evaluationId, kind: "evaluation", campaignId: item.campaignId, experimentId: item.experimentId })
    }
    for (const raw of context.researchQuestions ?? []) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as { requestId?: unknown; campaignId?: unknown; experimentId?: unknown; occurrenceIds?: unknown }
      if (typeof item.requestId !== "string" || typeof item.campaignId !== "string" || typeof item.experimentId !== "string") continue
      for (const id of [item.requestId, ...(Array.isArray(item.occurrenceIds) ? item.occurrenceIds : [])]) {
        if (typeof id === "string" && id.startsWith("rq_")) references.push({ id, kind: "research_request", campaignId: item.campaignId, experimentId: item.experimentId })
      }
    }
    return fromReferences(references, { campaignId: context.experiment.campaignId, experimentId: context.experiment.id })
  }

  export function collect(state: ResearchState): Map<string, Reference> {
    const references = new Map<string, Reference>()
    const add = (reference: Reference) => references.set(reference.id, reference)
    const addIfAbsent = (reference: Reference) => {
      if (!references.has(reference.id)) references.set(reference.id, reference)
    }
    const experiments = new Map<string, { campaignId: string }>()
    const trials = new Map<string, { campaignId: string; experimentId: string }>()
    for (const campaign of Object.values(state.campaigns)) add({ id: campaign.id, kind: "campaign", campaignId: campaign.id })
    for (const experiment of Object.values(state.experiments)) {
      experiments.set(experiment.id, { campaignId: experiment.campaignId })
      add({ id: experiment.id, kind: "experiment", campaignId: experiment.campaignId, experimentId: experiment.id })
    }
    for (const trial of Object.values(state.trials)) {
      const experiment = experiments.get(trial.experimentId)
      if (!experiment) continue
      trials.set(trial.id, { campaignId: experiment.campaignId, experimentId: trial.experimentId })
      add({ id: trial.id, kind: "trial", campaignId: experiment.campaignId, experimentId: trial.experimentId })
    }
    for (const evaluation of Object.values(state.evaluations)) {
      const trial = trials.get(evaluation.trialId)
      if (trial) add({ id: evaluation.id, kind: "evaluation", ...trial })
    }
    for (const run of Object.values(state.runs)) {
      const trial = trials.get(run.trialId)
      if (trial) add({ id: run.id, kind: "run", ...trial })
    }
    for (const item of Object.values(state.knowledge)) add({ id: item.id, kind: "knowledge", campaignId: item.campaignId, experimentId: item.experimentId })
    for (const item of Object.values(state.literature)) add({ id: item.id, kind: "literature", campaignId: item.campaignId })
    for (const item of Object.values(state.claims)) add({ id: item.id, kind: "claim", campaignId: item.campaignId })
    for (const item of Object.values(state.alignments)) add({ id: item.id, kind: "alignment", campaignId: item.campaignId })
    for (const item of Object.values(state.knowledgeCycles)) add({ id: item.id, kind: "knowledge_cycle", campaignId: item.campaignId })
    for (const item of Object.values(state.skillVersions)) add({ id: item.id, kind: "skill_version", campaignId: item.campaignId })
    for (const item of Object.values(state.hypotheses)) add({ id: item.id, kind: "hypothesis", campaignId: item.campaignId })
    for (const item of Object.values(state.searchObservations)) {
      add({ id: item.id, kind: "search_observation", campaignId: item.campaignId, experimentId: item.experimentId })
      // Search observations are durable lineage records. Preserve resolution for
      // historical stores whose source run/trial objects were compacted away.
      addIfAbsent({ id: item.trialId, kind: "trial", campaignId: item.campaignId, experimentId: item.experimentId })
      addIfAbsent({ id: item.runId, kind: "run", campaignId: item.campaignId, experimentId: item.experimentId })
      if (item.evaluationId) addIfAbsent({ id: item.evaluationId, kind: "evaluation", campaignId: item.campaignId, experimentId: item.experimentId })
      addIfAbsent({ id: item.knowledgeId, kind: "knowledge", campaignId: item.campaignId, experimentId: item.experimentId })
      if(item.knowledgeCycleId) addIfAbsent({ id: item.knowledgeCycleId, kind: "knowledge_cycle", campaignId: item.campaignId })
    }
    for (const item of Object.values(state.researchRequests)) {
      add({ id: item.id, kind: "research_request", campaignId: item.campaignId, experimentId: item.experimentId })
    }
    for (const item of Object.values(state.campaignCharters)) add({ id: item.id, kind: "charter", campaignId: item.campaignId })
    for (const item of Object.values(state.jobs)) {
      const campaignId = item.payload.kind === "autoresearch"
        ? experiments.get(item.payload.experimentId)?.campaignId
        : item.payload.campaignId
      const experimentId = item.payload.kind === "autoresearch" ? item.payload.experimentId
        : typeof item.payload.experimentId === "string" ? item.payload.experimentId : undefined
      if (campaignId) add({ id: item.id, kind: "job", campaignId, experimentId })
    }
    return references
  }
}
