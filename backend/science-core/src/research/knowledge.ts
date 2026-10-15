import { ScientistReview } from "./scientist-review"
import { ExperimentBranches } from "./experiment-branches"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import { ResearchDomain } from "./domain"

function bundleRoot(workspace: string, campaignId: string): string {
  if (!/^cmp_[A-Za-z0-9_-]+$/.test(campaignId)) throw new Error(`Unsafe campaign ID: ${campaignId}`)
  const root = path.resolve(workspace)
  const target = path.resolve(root, ".autofold", "campaigns", campaignId, "knowledge")
  const relation = path.relative(root, target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Knowledge bundle escapes workspace: ${campaignId}`)
  }
  return target
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, file)
}

function conceptFrontmatter(concept: ResearchDomain.KnowledgeConcept) {
  return {
    type: concept.type,
    title: concept.title,
    description: concept.description,
    tags: concept.tags,
    status: concept.status,
    generated: concept.generated,
    ...(concept.verified ? { verified: concept.verified } : {}),
    sources: concept.sources,
    campaign_id: concept.campaignId,
    experiment_id: concept.experimentId,
    trial_id: concept.trialId,
    ...(concept.evaluationId ? { evaluation_id: concept.evaluationId } : {}),
    ...(concept.runId ? { run_id: concept.runId } : {}),
    score: concept.score,
    decision: concept.decision,
    ...(concept.error ? { error: concept.error } : {}),
    diagnostics: concept.diagnostics,
    provenance: {
      contract_hash: concept.provenance.contractHash,
      ...(concept.provenance.targetArtifactHash
        ? { target_artifact_hash: concept.provenance.targetArtifactHash }
        : {}),
      evaluator_hash: concept.provenance.evaluatorHash,
      program_hash: concept.provenance.programHash,
      ...(concept.provenance.manifestHash ? { manifest_hash: concept.provenance.manifestHash } : {}),
    },
  }
}

type RecoveryReference = { knowledgeId: string; evaluationId: string }
type RecoverySupersession = {
  byRun: Map<string, RecoveryReference>
  failureKnowledge: Map<string, RecoveryReference>
  searchObservations: Map<string, RecoveryReference>
  cycles: Map<string, RecoveryReference>
  reviews: Map<string, RecoveryReference>
  hypotheses: Map<string, RecoveryReference>
}

function recoverySupersession(input: {
  concepts: ResearchDomain.KnowledgeConcept[]
  cycles?: ResearchDomain.KnowledgeCycle[]
  searchObservations?: ResearchDomain.SearchObservation[]
  scientistReviews?: Array<typeof ScientistReview.Record._output>
  hypotheses?: ResearchDomain.ResearchHypothesis[]
}): RecoverySupersession {
  const byRun = new Map<string, RecoveryReference>()
  for (const concept of input.concepts.toSorted((a,b) => a.createdAt.localeCompare(b.createdAt))) {
    if (concept.runId && concept.evaluationId && concept.type === "Research Evaluation" && concept.status !== "deprecated") {
      byRun.set(concept.runId, {knowledgeId:concept.id,evaluationId:concept.evaluationId})
    }
  }
  const failureKnowledge = new Map<string, RecoveryReference>()
  for (const concept of input.concepts) {
    const recovered = concept.runId ? byRun.get(concept.runId) : undefined
    if (recovered && concept.type === "Research Failure" && concept.status === "deprecated") {
      failureKnowledge.set(concept.id, recovered)
    }
  }
  const searchObservations = new Map<string, RecoveryReference>()
  for (const observation of input.searchObservations ?? []) {
    const recovered = failureKnowledge.get(observation.knowledgeId)
    if (recovered && observation.decision === "failed") searchObservations.set(observation.id, recovered)
  }
  const cycles = new Map<string, RecoveryReference>()
  for (const cycle of input.cycles ?? []) {
    const recovered = cycle.inputs.knowledgeIds.map(id => failureKnowledge.get(id)).find(Boolean)
    if (recovered) cycles.set(cycle.id, recovered)
  }
  const reviews = new Map<string, RecoveryReference>()
  for (const review of input.scientistReviews ?? []) {
    const recovered = byRun.get(review.runId)
    if (!recovered) continue
    const failureSummary = typeof review.evidenceSummary === "object" && review.evidenceSummary !== null &&
      (review.evidenceSummary as {status?:unknown}).status === "run_failed"
    const evaluation = input.concepts.find(concept => concept.id === recovered.knowledgeId)
    if (failureSummary || Boolean(evaluation && evaluation.createdAt > review.createdAt)) reviews.set(review.id, recovered)
  }
  const hypotheses = new Map<string, RecoveryReference>()
  const concepts = new Map(input.concepts.map(concept => [concept.id, concept]))
  for (const hypothesis of input.hypotheses ?? []) {
    const knowledgeRefs = hypothesis.supportingEvidenceRefs
      .map(id => concepts.get(id))
      .filter((concept): concept is ResearchDomain.KnowledgeConcept => Boolean(concept))
    if (!knowledgeRefs.length || knowledgeRefs.some(concept => concept.type !== "Research Failure")) continue
    const recovered = knowledgeRefs.map(concept => failureKnowledge.get(concept.id))
    if (recovered.every(Boolean)) hypotheses.set(hypothesis.id, recovered[0]!)
  }
  return {byRun,failureKnowledge,searchObservations,cycles,reviews,hypotheses}
}

function supersessionLine(reference: RecoveryReference): string {
  return "Superseded by recovered evaluation " + reference.evaluationId + " (knowledge " +
    reference.knowledgeId + "). Retained as immutable historical evidence."
}

function conceptBody(concept: ResearchDomain.KnowledgeConcept, supersededBy?: RecoveryReference): string {
  const score = concept.score === null ? "No valid score" : String(concept.score)
  const sources = concept.sources.map((source) => `[^${source.id}]: ${source.title ?? source.resource}`).join("\n")
  const derivation =
    concept.type === "Research Failure"
      ? "The failure is derived from the persisted final run record listed in the concept sources."
      : "The outcome derives from the immutable run artifacts listed in the concept sources."
  return [
    `# ${concept.title}`,
    "",
    concept.description,
    "",
    "## Outcome",
    "",
    `- Decision: **${concept.decision}**`,
    `- Score: ${score}`,
      `- Lifecycle: ${concept.status}`,
      ...(concept.error ? [`- Failure: ${concept.error}`] : []),
      ...(supersededBy ? [`- Supersession: ${supersessionLine(supersededBy)}`] : []),
    "",
    derivation,
    "",
    sources,
    "",
  ].join("\n")
}

function experimentBody(experiment: ResearchDomain.Experiment): string {
  return matter.stringify(
    [
      `# ${experiment.contract.objective}`,
      "",
      "This is the frozen experiment contract used to make trial results comparable.",
      "",
      "## Contract",
      "",
      "```json",
      JSON.stringify(experiment.contract, null, 2),
      "```",
      "",
    ].join("\n"),
    {
      type: "Research Experiment",
      title: experiment.contract.objective,
      description: `Frozen ${experiment.contract.modality} experiment contract.`,
      resource: `autofold://experiments/${experiment.id}`,
      tags: ["experiment", experiment.contract.modality],
      status: experiment.status === "draft" ? "draft" : experiment.status === "archived" ? "deprecated" : "stable",
      generated: { by: "process:autofold-research-service", at: experiment.createdAt },
      campaign_id: experiment.campaignId,
      experiment_id: experiment.id,
      experiment_status: experiment.status,
      contract_hash: experiment.contractHash,
      ...(experiment.incumbentTrialId ? { incumbent_trial_id: experiment.incumbentTrialId } : {}),
    },
  )
}

function trialBody(trial: ResearchDomain.Trial): string {
  const stable = trial.status === "succeeded" || trial.status === "failed" || trial.status === "cancelled"
  return matter.stringify(
    [
      `# Trial ${trial.id}`,
      "",
      trial.hypothesis,
      "",
      "## Frozen implementation",
      "",
      `- Intent: \`${trial.intent}\``,
      `- Design adapter: \`${trial.designAdapter}\``,
      `- Program path: \`${trial.programPath}\``,
      `- Program hash: \`${trial.programHash}\``,
      "",
    ].join("\n"),
    {
      type: "Research Trial",
      title: `Trial ${trial.id}: ${trial.hypothesis}`,
      description: "A versioned trial configuration evaluated under its experiment contract.",
      resource: `autofold://trials/${trial.id}`,
      tags: ["trial", trial.intent, trial.designAdapter],
      status: stable ? "stable" : "draft",
      generated: { by: "process:autofold-research-service", at: trial.createdAt },
      sources: [
        { id: "experiment", resource: `/experiments/${trial.experimentId}.md` },
        ...(trial.parentTrialId ? [{ id: "parent_trial", resource: `/trials/${trial.parentTrialId}.md` }] : []),
      ],
      experiment_id: trial.experimentId,
      trial_id: trial.id,
      trial_status: trial.status,
      trial_intent: trial.intent,
      program_hash: trial.programHash,
    },
  )
}

function literatureBody(record: ResearchDomain.LiteratureRecord): string {
  return matter.stringify(
    [
      `# ${record.title}`,
      "",
      record.summary ?? "No summary was returned by the source.",
      ...(record.excerpts.length ? ["", "## Frozen evidence excerpts", "", ...record.excerpts.map((excerpt) => `> ${excerpt}`)] : []),
      "",
    ].join("\n"),
    {
      type: "Literature Source",
      title: record.title,
      description: record.summary ?? `Frozen ${record.database} literature record ${record.sourceId}.`,
      resource: record.url ?? `autofold://literature/${record.id}`,
      tags: ["literature", record.database],
      status: "stable",
      generated: { by: "process:autofold-literature-ingest", at: record.retrievedAt },
      campaign_id: record.campaignId,
      database: record.database,
      source_id: record.sourceId,
      query: record.query,
      ...(record.url ? { url: record.url } : {}),
      content_hash: record.contentHash,
      retrieved_at: record.retrievedAt,
    },
  )
}

function claimBody(claim: ResearchDomain.KnowledgeClaim, records: Map<string, ResearchDomain.LiteratureRecord>): string {
  const evidence = claim.evidence.map((item) => {
    const source = records.get(item.literatureId)
    const suffix = item.excerpt ? ` — “${item.excerpt}”` : ""
    return `- [${source?.title ?? item.literatureId}](../sources/${item.literatureId}.md)${suffix}`
  })
  const citations = claim.evidence.map((item) => {
    const source = records.get(item.literatureId)
    return `[^${item.literatureId}]: ${source?.title ?? item.literatureId}`
  })
  return matter.stringify(
    [
      `# ${claim.kind.replaceAll("_", " ")}`,
      "",
      `${claim.statement}${claim.evidence.map((item) => `[^${item.literatureId}]`).join("")}`,
      "",
      "## Literature evidence",
      "",
      ...evidence,
      "",
      ...citations,
      "",
    ].join("\n"),
    {
      type: "Literature Claim",
      title: claim.statement,
      description: `${claim.kind.replaceAll("_", " ")} claim with ${claim.evidence.length} frozen literature source(s).`,
      tags: ["literature-claim", claim.kind, claim.stance],
      status: claim.status === "deprecated" ? "deprecated" : claim.status === "proposed" ? "draft" : "stable",
      claim_status: claim.status,
      sources: claim.evidence.map((item) => ({
        id: item.literatureId,
        resource: `/sources/${item.literatureId}.md`,
        title: records.get(item.literatureId)?.title,
      })),
      campaign_id: claim.campaignId,
      kind: claim.kind,
      stance: claim.stance,
      confidence: claim.confidence,
      generated: claim.generated,
      ...(claim.reviewed ? { verified: [claim.reviewed] } : {}),
      evidence: claim.evidence,
      created_at: claim.createdAt,
    },
  )
}

function alignmentBody(alignment: ResearchDomain.KnowledgeAlignment): string {
  return matter.stringify(
    [
      `# ${alignment.relation} alignment`,
      "",
      alignment.rationale,
      "",
      "## Linked knowledge",
      "",
      `- Literature claim: [${alignment.claimId}](/claims/${alignment.claimId}.md)`,
      `- Experiment outcome: [${alignment.knowledgeId}](/concepts/${alignment.knowledgeId}.md)`,
      "",
    ].join("\n"),
    {
      type: "Evidence Alignment",
      title: `${alignment.relation}: ${alignment.claimId} ↔ ${alignment.knowledgeId}`,
      description: "A typed relationship between a literature claim and an experiment outcome.",
      tags: ["evidence-alignment", alignment.relation],
      status: alignment.status === "deprecated" ? "deprecated" : alignment.status === "proposed" ? "draft" : "stable",
      alignment_status: alignment.status,
      relation: alignment.relation,
      generated: alignment.generated,
      ...(alignment.reviewed ? { verified: [alignment.reviewed] } : {}),
      sources: [
        { id: "claim", resource: `/claims/${alignment.claimId}.md` },
        { id: "outcome", resource: `/concepts/${alignment.knowledgeId}.md` },
      ],
      campaign_id: alignment.campaignId,
      claim_id: alignment.claimId,
      knowledge_id: alignment.knowledgeId,
      created_at: alignment.createdAt,
    },
  )
}

function cycleBody(cycle: ResearchDomain.KnowledgeCycle, supersededBy?: RecoveryReference): string {
  const unresolved = cycle.outputs.unresolvedQuestions.map((question) => `- ${question}`)
  return matter.stringify(
    [
      `# Knowledge cycle ${cycle.id}`,
      "",
      cycle.question,
      ...(supersededBy ? ["", `> ${supersessionLine(supersededBy)}`] : []),
      ...(cycle.campaignSummary ? ["", "## Campaign summary", "", cycle.campaignSummary] : []),
      "",
      "## Causal inputs",
      "",
      `- Experiment outcomes used: ${cycle.inputs.knowledgeIds.length}`,
      `- Claims used: ${cycle.inputs.claimIds.length}`,
      `- Literature records used: ${cycle.inputs.literatureIds.length}`,
      "",
      "## Outputs",
      "",
      `- Literature records: ${cycle.outputs.literatureIds.length}`,
      `- Claims: ${cycle.outputs.claimIds.length}`,
      `- Evidence alignments: ${cycle.outputs.alignmentIds.length}`,
      `- Hypotheses updated: ${cycle.outputs.hypothesisIds.length}`,
      `- Search observations: ${cycle.outputs.searchObservationIds.length}`,
      ...((cycle.outputs.researchRequestUpdates ?? []).length ? ["", "## Research question updates", "",
        ...(cycle.outputs.researchRequestUpdates ?? []).flatMap(update => [
          `- Request: ${update.requestId}; status: ${update.status}; previous revision: ${update.expectedRevision ?? "initial"}`,
          `  Assessment: ${update.assessment}`,
          `  Evidence: ${update.literatureIds.join(", ") || "none; unresolved"}`,
          `  Remaining gap: ${update.remainingGap}`,
          `  Next action: ${update.nextAction}`,
        ])] : []),
      "",
      "## Unresolved questions",
      "",
      ...(unresolved.length ? unresolved : ["No unresolved questions were recorded."]),
      ...(cycle.nextExperiment
        ? [
            "",
            "## Recommended next experiment",
            "",
            `- Action: **${cycle.nextExperiment.action}**`,
            ...(cycle.nextExperiment.experimentId ? [`- Experiment: \`${cycle.nextExperiment.experimentId}\``] : []),
            `- Hypothesis: ${cycle.nextExperiment.hypothesis}`,
            `- Rationale: ${cycle.nextExperiment.rationale}`,
            `- Success criterion: ${cycle.nextExperiment.successCriterion}`,
          ]
        : []),
      "",
    ].join("\n"),
    {
      type: "Knowledge Cycle",
      title: `Campaign knowledge cycle ${cycle.id}`,
      description: "One bounded experiment-results and literature-alignment recursion step.",
      tags: ["knowledge-cycle", cycle.trigger],
      status: supersededBy ? "deprecated" : "stable",
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      generated: cycle.generated,
      stale_after: cycle.nextReviewAt.slice(0, 10),
      campaign_id: cycle.campaignId,
      trigger: cycle.trigger,
      inputs: cycle.inputs,
      outputs: cycle.outputs,
      ...(cycle.campaignSummary ? { campaign_summary: cycle.campaignSummary } : {}),
      ...(cycle.nextExperiment ? { next_experiment: cycle.nextExperiment } : {}),
      next_review_at: cycle.nextReviewAt,
    },
  )
}

function charterBody(charter: ResearchDomain.CampaignCharter): string {
  return matter.stringify(
    [
      `# Campaign research charter`,
      "",
      charter.objective,
      "",
      "## Success criteria",
      "",
      ...charter.successCriteria.map((criterion) =>
        `- **${criterion.status}** \`${criterion.id}\`: ${criterion.statement} (requires \`${criterion.requiredEvidenceLevel}\`)`
      ),
      "",
      "## Required controls",
      "",
      ...charter.requiredControls.map((control) => `- ${control}`),
      "",
      "## Stop conditions",
      "",
      ...charter.stopConditions.map((condition) => `- **${condition.kind}**: ${condition.criterion}`),
      "",
    ].join("\n"),
    {
      type: "Campaign Research Charter",
      title: `Research charter for ${charter.campaignId}`,
      description: "The machine-readable campaign objective, evidence bar, controls, and terminal conditions.",
      tags: ["campaign-charter", "research-goal"],
      status: charter.status === "superseded" ? "deprecated" : "stable",
      campaign_id: charter.campaignId,
      charter_id: charter.id,
      charter_version: charter.version,
      constraints: charter.constraints,
      created_at: charter.createdAt,
      updated_at: charter.updatedAt,
    },
  )
}

function hypothesisBody(hypothesis: ResearchDomain.ResearchHypothesis, supersededBy?: RecoveryReference): string {
  return matter.stringify(
    [
      `# ${hypothesis.statement}`,
      "",
      ...(supersededBy ? [`> ${supersessionLine(supersededBy)}`, ""] : []),
      `- Status: **${hypothesis.status}**`,
      `- Trusted evidence level: \`${hypothesis.evidenceLevel}\``,
      `- Confidence: ${hypothesis.confidence}`,
      "",
      "## Prediction",
      "",
      hypothesis.prediction,
      "",
      "## Falsification criterion",
      "",
      hypothesis.falsificationCriterion,
      "",
      "## Recommended experiment",
      "",
      hypothesis.recommendedExperiment,
      "",
      "## Evidence",
      "",
      ...hypothesis.supportingEvidenceRefs.map((reference) => `- Supports: \`${reference}\``),
      ...hypothesis.opposingEvidenceRefs.map((reference) => `- Opposes: \`${reference}\``),
      ...(hypothesis.limitations.length ? ["", "## Limitations", "", ...hypothesis.limitations.map((item) => `- ${item}`)] : []),
      "",
    ].join("\n"),
    {
      type: "Research Hypothesis",
      title: hypothesis.statement,
      description: `${hypothesis.category} hypothesis with ${hypothesis.evidenceLevel} evidence.`,
      tags: ["hypothesis", hypothesis.category, hypothesis.status, hypothesis.evidenceLevel, ...(supersededBy ? ["superseded"] : [])],
      status: supersededBy || hypothesis.status === "refuted" ? "deprecated" : hypothesis.status === "proposed" ? "draft" : "stable",
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      generated: hypothesis.generated,
      campaign_id: hypothesis.campaignId,
      hypothesis_id: hypothesis.id,
      hypothesis_status: hypothesis.status,
      evidence_level: hypothesis.evidenceLevel,
      supporting_evidence_refs: hypothesis.supportingEvidenceRefs,
      opposing_evidence_refs: hypothesis.opposingEvidenceRefs,
      created_at: hypothesis.createdAt,
      updated_at: hypothesis.updatedAt,
    },
  )
}

function searchObservationBody(observation: ResearchDomain.SearchObservation, supersededBy?: RecoveryReference): string {
  return matter.stringify(
    [
      `# Search observation ${observation.id}`,
      "",
      observation.hypothesis,
      ...(supersededBy ? ["", `> ${supersessionLine(supersededBy)}`] : []),
      "",
      `- Decision: **${observation.decision}**`,
      `- Score: ${observation.score ?? "invalid"}`,
      `- Prior best: ${observation.priorBestScore ?? "none"}`,
      `- Improvement from prior best: ${observation.scoreDeltaFromPriorBest ?? "not comparable"}`,
      `- Evidence level: \`${observation.epistemicLevel}\``,
      `- Generators: ${observation.generatorPortfolio.join(", ") || "static/control"}`,
      ...observation.generatorDiagnostics.flatMap((diagnostic) => [
        `- ${diagnostic.generator} accepted/rejected: ${diagnostic.acceptedCandidates}/${diagnostic.rejectedCandidates}`,
        `- ${diagnostic.generator} rejection filters: ${Object.entries(diagnostic.rejectionFilters).map(([name, count]) => `${name}=${count}`).join(", ") || "none observed"}`,
        `- ${diagnostic.generator} trajectory filters: ${Object.entries(diagnostic.trajectoryFailureFilters).map(([name, count]) => `${name}=${count}`).join(", ") || "none observed"}`,
      ]),
      `- Calibration class: ${observation.calibrationClass ?? "not declared"}`,
      `- Generation replicate: ${observation.generationReplicateId ?? "legacy/unavailable"}`,
      `- Realized candidate set: ${observation.realizedCandidateSetHash ?? "legacy/unavailable"}`,
      `- Generation stochasticity: ${observation.generationStochasticity ?? "legacy/unavailable"}`,
      `- Models: ${observation.modelIds.join(", ") || "none recorded"}`,
      `- Seeds: ${observation.seeds.join(", ") || "none recorded"}`,
      `- Candidates: ${observation.candidateSequences.join(", ") || "none recorded"}`,
      "",
    ].join("\n"),
    {
      type: "Search Landscape Observation",
      title: `Trial ${observation.trialId} search delta`,
      description: "A trusted compact observation of one explored program, generator portfolio, and evaluation outcome.",
      tags: ["search-landscape", observation.intent, observation.decision, ...(supersededBy ? ["superseded"] : [])],
      status: supersededBy ? "deprecated" : "stable",
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      campaign_id: observation.campaignId,
      experiment_id: observation.experimentId,
      trial_id: observation.trialId,
      run_id: observation.runId,
      knowledge_id: observation.knowledgeId,
      ...(observation.knowledgeCycleId?{knowledge_cycle_id:observation.knowledgeCycleId}:{}),
      ...(observation.closeoutVersion?{closeout_version:observation.closeoutVersion,receipt_hash:observation.receiptHash,commit_hash:observation.commitHash}:{}),
      program_hash: observation.programHash,
      ...(observation.pipelineHash ? { pipeline_hash: observation.pipelineHash } : {}),
      ...(observation.semanticProgramFingerprint ? { semantic_program_fingerprint: observation.semanticProgramFingerprint } : {}),
      ...(observation.workflowFingerprint ? { workflow_fingerprint: observation.workflowFingerprint } : {}),
      ...(observation.calibrationClass ? { calibration_class: observation.calibrationClass } : {}),
      ...(observation.calibrationReplicateOfTrialId ? { calibration_replicate_of_trial_id: observation.calibrationReplicateOfTrialId } : {}),
      ...(observation.generationReplicateId ? { generation_replicate_id: observation.generationReplicateId } : {}),
      ...(observation.realizedCandidateSetHash ? { realized_candidate_set_hash: observation.realizedCandidateSetHash } : {}),
      ...(observation.generationStochasticity ? { generation_stochasticity: observation.generationStochasticity } : {}),
      ...(observation.parentTrialId ? { parent_trial_id: observation.parentTrialId } : {}),
      generator_diagnostics: observation.generatorDiagnostics,
      created_at: observation.createdAt,
    },
  )
}

export namespace ResearchKnowledge {
  export function relativeRunResource(campaignId: string, resource: string): string {
    const concepts = path.posix.join(".autofold", "campaigns", campaignId, "knowledge", "concepts")
    return path.posix.relative(concepts, resource)
  }

  export function renderConcept(concept: ResearchDomain.KnowledgeConcept): string {
    return matter.stringify(conceptBody(concept), conceptFrontmatter(concept))
  }

  export function renderIndex(
    campaign: ResearchDomain.Campaign,
    concepts: ResearchDomain.KnowledgeConcept[],
    literature: ResearchDomain.LiteratureRecord[] = [],
    claims: ResearchDomain.KnowledgeClaim[] = [],
    alignments: ResearchDomain.KnowledgeAlignment[] = [],
    cycles: ResearchDomain.KnowledgeCycle[] = [],
    experiments: ResearchDomain.Experiment[] = [],
    trials: ResearchDomain.Trial[] = [],
    charter?: ResearchDomain.CampaignCharter,
    hypotheses: ResearchDomain.ResearchHypothesis[] = [],
    searchObservations: ResearchDomain.SearchObservation[] = [],
  ): string {
    const supersession = recoverySupersession({concepts,cycles,searchObservations,hypotheses})
    const entries = concepts
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((concept) => {
        const recovered = supersession.failureKnowledge.get(concept.id)
        return `* [${concept.title}](concepts/${concept.id}.md) - ${concept.description}${recovered ? ` [superseded by ${recovered.evaluationId}]` : ""}`
      })
    const claimEntries = claims.map((claim) => `* [${claim.statement}](claims/${claim.id}.md) - ${claim.status}`)
    const sourceEntries = literature.map((record) => `* [${record.title}](sources/${record.id}.md) - ${record.database}`)
    const alignmentEntries = alignments.map(
      (alignment) => `* [${alignment.relation}: ${alignment.claimId} ↔ ${alignment.knowledgeId}](alignments/${alignment.id}.md) - ${alignment.status}`,
    )
    const cycleEntries = cycles.map(
      (cycle) => {
        const recovered = supersession.cycles.get(cycle.id)
        return `* [${cycle.question}](cycles/${cycle.id}.md) - ${cycle.trigger}; next review ${cycle.nextReviewAt}${recovered ? `; superseded by ${recovered.evaluationId}` : ""}`
      },
    )
    const experimentEntries = experiments.map(
      (experiment) => `* [${experiment.contract.objective}](experiments/${experiment.id}.md) - ${experiment.status}`,
    )
    const trialEntries = trials.map(
      (trial) => `* [${trial.hypothesis}](trials/${trial.id}.md) - ${trial.status}`,
    )
    const hypothesisEntries = hypotheses.map(
      (hypothesis) => {
        const recovered = supersession.hypotheses.get(hypothesis.id)
        return `* [${hypothesis.statement}](hypotheses/${hypothesis.id}.md) - ${hypothesis.status}; ${hypothesis.evidenceLevel}${recovered ? `; superseded by ${recovered.evaluationId}` : ""}`
      },
    )
    const searchEntries = searchObservations.map(
      (observation) => {
        const recovered = supersession.searchObservations.get(observation.id)
        return `* [${observation.trialId}](search/${observation.id}.md) - ${observation.decision}; score ${observation.score ?? "invalid"}${recovered ? `; superseded by ${recovered.evaluationId}` : ""}`
      },
    )
    const body = [
      `# ${campaign.objective}`,
      "",
      `Campaign knowledge catalog: \`${campaign.knowledgeCatalogId}\``,
      ...(charter ? ["", `Research charter: [${charter.id}](charter.md)`] : []),
      "",
      "## Research knowledge",
      "",
      ...(entries.length ? entries : ["No research outcomes yet."]),
      "",
      "## Experiment contracts",
      "",
      ...(experimentEntries.length ? experimentEntries : ["No experiment contracts yet."]),
      "",
      "## Trial configurations",
      "",
      ...(trialEntries.length ? trialEntries : ["No trials yet."]),
      "",
      "## Competing hypotheses",
      "",
      ...(hypothesisEntries.length ? hypothesisEntries : ["No typed hypotheses yet."]),
      "",
      "## Search landscape",
      "",
      ...(searchEntries.length ? searchEntries : ["No trusted search observations yet."]),
      "",
      "## Literature claims",
      "",
      ...(claimEntries.length ? claimEntries : ["No literature claims yet."]),
      "",
      "## Literature sources",
      "",
      ...(sourceEntries.length ? sourceEntries : ["No literature sources yet."]),
      "",
      "## Evidence alignments",
      "",
      ...(alignmentEntries.length ? alignmentEntries : ["No literature-to-experiment alignments yet."]),
      "",
      "## Executable experiment frontier", "", "[Branch programs, outcomes and revisit conditions](branches/index.md)", "",
      "## Knowledge cycles",
      "",
      ...(cycleEntries.length ? cycleEntries : ["No recursive knowledge cycles yet."]),
      "",
    ].join("\n")
    return matter.stringify(body, { okf_version: "0.2" })
  }

  export async function writeBundle(input: {
    workspace: string
    campaign: ResearchDomain.Campaign
    concepts: ResearchDomain.KnowledgeConcept[]
    literature?: ResearchDomain.LiteratureRecord[]
    claims?: ResearchDomain.KnowledgeClaim[]
    alignments?: ResearchDomain.KnowledgeAlignment[]
    cycles?: ResearchDomain.KnowledgeCycle[]
    experiments?: ResearchDomain.Experiment[]
    trials?: ResearchDomain.Trial[]
    charter?: ResearchDomain.CampaignCharter
    hypotheses?: ResearchDomain.ResearchHypothesis[]
    scientistReviews?: Array<typeof ScientistReview.Record._output>
    experimentBranches?: Array<typeof ExperimentBranches.Record._output>
    searchObservations?: ResearchDomain.SearchObservation[]
  }): Promise<string> {
    const root = bundleRoot(input.workspace, input.campaign.id)
    const literature = input.literature ?? []
    const claims = input.claims ?? []
    const alignments = input.alignments ?? []
    const cycles = input.cycles ?? []
    const experiments = input.experiments ?? []
    const experimentIds = new Set(experiments.map((experiment) => experiment.id))
    const trials = input.trials ?? []
    const hypotheses = input.hypotheses ?? []
    const searchObservations = input.searchObservations ?? []
    const reviews = input.scientistReviews ?? []
    const supersession = recoverySupersession({
      concepts:input.concepts,cycles,searchObservations,scientistReviews:reviews,hypotheses,
    })
    for (const concept of input.concepts) {
      if (concept.campaignId !== input.campaign.id) {
        throw new Error(`Knowledge concept ${concept.id} belongs to another campaign`)
      }
      const recovered = supersession.failureKnowledge.get(concept.id)
      await writeAtomic(path.join(root, "concepts", `${concept.id}.md`), matter.stringify(
        conceptBody(concept, recovered),
        {...conceptFrontmatter(concept), ...(recovered ? {superseded_by:recovered} : {})},
      ))
    }
    const records = new Map(literature.map((record) => [record.id, record]))
    for (const record of literature) {
      if (record.campaignId !== input.campaign.id) throw new Error(`Literature ${record.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "sources", `${record.id}.md`), literatureBody(record))
    }
    for (const claim of claims) {
      if (claim.campaignId !== input.campaign.id) throw new Error(`Claim ${claim.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "claims", `${claim.id}.md`), claimBody(claim, records))
    }
    for (const alignment of alignments) {
      if (alignment.campaignId !== input.campaign.id) throw new Error(`Alignment ${alignment.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "alignments", `${alignment.id}.md`), alignmentBody(alignment))
    }
    for (const cycle of cycles) {
      if (cycle.campaignId !== input.campaign.id) throw new Error(`Knowledge cycle ${cycle.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "cycles", `${cycle.id}.md`), cycleBody(cycle, supersession.cycles.get(cycle.id)))
    }
    for (const review of reviews) {
      if (review.campaignId !== input.campaign.id) throw new Error("Scientist review campaign mismatch")
      const recovered = supersession.reviews.get(review.id)
      await writeAtomic(path.join(root,"reviews",review.id+".md"), matter.stringify([
        "# Scientist interpretation", "This is a provisional model interpretation, not a verified scientific claim.",
        ...(recovered ? [supersessionLine(recovered)] : []),
        "```json", JSON.stringify(review,null,2), "```",
      ].join("\n\n"), {type:"Scientist Interpretation", run:review.runId, experiment:review.experimentId, revision:review.revision,
        status:recovered ? "deprecated" : "draft", ...(recovered ? {superseded_by:recovered} : {})}))
    }
    await writeAtomic(path.join(root,"reviews","index.md"), ["# Scientist interpretations", "",
      ...reviews.map(r => {
        const recovered = supersession.reviews.get(r.id)
        return `- [${r.runId}, revision ${r.revision}](${r.id}.md)${recovered ? `: superseded by ${recovered.evaluationId}` : ""}`
      })].join("\n"))
    const branches=input.experimentBranches ?? []
    await writeAtomic(path.join(root,"branches","index.md"),[
      "# Executable experiment frontier", "", ...branches.map(b=>`- [${b.title}](${b.id}.md): ${b.status}`),
    ].join("\n"))
    for(const b of branches) {
      if(b.campaignId!==input.campaign.id) throw new Error("Branch campaign mismatch")
      const outcomes=(input.searchObservations ?? []).filter(o=>o.experimentId===b.experimentId && o.programHash===b.programHash)
      await writeAtomic(path.join(root,"branches",b.id+".py"),b.program)
      await writeAtomic(path.join(root,"branches",b.id+".md"),matter.stringify([
        `# ${b.title}`, `Experiment: ${b.experimentId}`, `Parent: ${b.parentBranchId ?? "root"}`,
        `Status: ${b.status}; revision: ${b.revision}`, `Program: [immutable snapshot](${b.id}.py)`,
        `Contract: ${b.contractHash}`,`Program hash: ${b.programHash}`,`Rationale: ${b.rationale}`,`Revisit: ${b.revisitWhen}`,
        `Evidence: ${b.evidenceRefs.join(", ")}`,"", "## Outcomes",...outcomes.map(o=>
          `- ${o.runId}: ${o.decision}, score ${o.score ?? "unavailable"}; ${o.knowledgeCycleId?"knowledge cycle "+o.knowledgeCycleId+"; ":""}observation ${o.id}`),
      ].join("\n\n"),{type:"Experiment Branch",status:b.status,generated:{by:"process:autofold-branch-frontier",at:b.createdAt}}))
    }
    for (const experiment of experiments) {
      if (experiment.campaignId !== input.campaign.id) throw new Error(`Experiment ${experiment.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "experiments", `${experiment.id}.md`), experimentBody(experiment))
    }
    for (const trial of trials) {
      if (!experimentIds.has(trial.experimentId)) throw new Error(`Trial ${trial.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "trials", `${trial.id}.md`), trialBody(trial))
    }
    if (input.charter) {
      if (input.charter.campaignId !== input.campaign.id) throw new Error(`Charter ${input.charter.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "charter.md"), charterBody(input.charter))
    }
    for (const hypothesis of hypotheses) {
      if (hypothesis.campaignId !== input.campaign.id) throw new Error(`Hypothesis ${hypothesis.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "hypotheses", `${hypothesis.id}.md`), hypothesisBody(hypothesis, supersession.hypotheses.get(hypothesis.id)))
    }
    for (const observation of searchObservations) {
      if (observation.campaignId !== input.campaign.id) throw new Error(`Search observation ${observation.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "search", `${observation.id}.md`), searchObservationBody(observation, supersession.searchObservations.get(observation.id)))
    }
    await writeAtomic(
      path.join(root, "index.md"),
      renderIndex(input.campaign, input.concepts, literature, claims, alignments, cycles, experiments, trials, input.charter, hypotheses, searchObservations) + "\n\n[Scientist interpretations](reviews/index.md)\n",
    )
    await writeAtomic(
      path.join(root, "log.md"),
      [
        "# Campaign Knowledge Log",
        "",
        ...(cycles.length
          ? cycles
              .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((cycle) => `## ${cycle.createdAt.slice(0, 10)}\n\n* **Knowledge cycle**: [${cycle.id}](cycles/${cycle.id}.md) produced ${cycle.outputs.claimIds.length} claim(s) and ${cycle.outputs.alignmentIds.length} alignment(s).`)
          : ["No knowledge cycles yet."]),
        "",
      ].join("\n"),
    )
    return root
  }
}
