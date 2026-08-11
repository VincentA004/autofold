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

function conceptBody(concept: ResearchDomain.KnowledgeConcept): string {
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

function cycleBody(cycle: ResearchDomain.KnowledgeCycle): string {
  const unresolved = cycle.outputs.unresolvedQuestions.map((question) => `- ${question}`)
  return matter.stringify(
    [
      `# Knowledge cycle ${cycle.id}`,
      "",
      cycle.question,
      ...(cycle.campaignSummary ? ["", "## Campaign summary", "", cycle.campaignSummary] : []),
      "",
      "## Inputs",
      "",
      `- Experiment outcomes: ${cycle.inputs.knowledgeIds.length}`,
      `- Existing claims: ${cycle.inputs.claimIds.length}`,
      `- Existing literature records: ${cycle.inputs.literatureIds.length}`,
      "",
      "## Outputs",
      "",
      `- Literature records: ${cycle.outputs.literatureIds.length}`,
      `- Claims: ${cycle.outputs.claimIds.length}`,
      `- Evidence alignments: ${cycle.outputs.alignmentIds.length}`,
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
      status: "stable",
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
  ): string {
    const entries = concepts
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((concept) => `* [${concept.title}](concepts/${concept.id}.md) - ${concept.description}`)
    const claimEntries = claims.map((claim) => `* [${claim.statement}](claims/${claim.id}.md) - ${claim.status}`)
    const sourceEntries = literature.map((record) => `* [${record.title}](sources/${record.id}.md) - ${record.database}`)
    const alignmentEntries = alignments.map(
      (alignment) => `* [${alignment.relation}: ${alignment.claimId} ↔ ${alignment.knowledgeId}](alignments/${alignment.id}.md) - ${alignment.status}`,
    )
    const cycleEntries = cycles.map(
      (cycle) => `* [${cycle.question}](cycles/${cycle.id}.md) - ${cycle.trigger}; next review ${cycle.nextReviewAt}`,
    )
    const experimentEntries = experiments.map(
      (experiment) => `* [${experiment.contract.objective}](experiments/${experiment.id}.md) - ${experiment.status}`,
    )
    const trialEntries = trials.map(
      (trial) => `* [${trial.hypothesis}](trials/${trial.id}.md) - ${trial.status}`,
    )
    const body = [
      `# ${campaign.objective}`,
      "",
      `Campaign knowledge catalog: \`${campaign.knowledgeCatalogId}\``,
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
  }): Promise<string> {
    const root = bundleRoot(input.workspace, input.campaign.id)
    for (const concept of input.concepts) {
      if (concept.campaignId !== input.campaign.id) {
        throw new Error(`Knowledge concept ${concept.id} belongs to another campaign`)
      }
      await writeAtomic(path.join(root, "concepts", `${concept.id}.md`), renderConcept(concept))
    }
    const literature = input.literature ?? []
    const claims = input.claims ?? []
    const alignments = input.alignments ?? []
    const cycles = input.cycles ?? []
    const experiments = input.experiments ?? []
    const experimentIds = new Set(experiments.map((experiment) => experiment.id))
    const trials = input.trials ?? []
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
      await writeAtomic(path.join(root, "cycles", `${cycle.id}.md`), cycleBody(cycle))
    }
    for (const experiment of experiments) {
      if (experiment.campaignId !== input.campaign.id) throw new Error(`Experiment ${experiment.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "experiments", `${experiment.id}.md`), experimentBody(experiment))
    }
    for (const trial of trials) {
      if (!experimentIds.has(trial.experimentId)) throw new Error(`Trial ${trial.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "trials", `${trial.id}.md`), trialBody(trial))
    }
    await writeAtomic(
      path.join(root, "index.md"),
      renderIndex(input.campaign, input.concepts, literature, claims, alignments, cycles, experiments, trials),
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
