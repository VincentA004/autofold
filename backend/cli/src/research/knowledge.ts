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

function literatureBody(record: ResearchDomain.LiteratureRecord): string {
  return matter.stringify(
    [`# ${record.title}`, "", record.summary ?? "No summary was returned by the source.", ""].join("\n"),
    {
      type: "Literature Source",
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
  return matter.stringify(
    [`# ${claim.kind.replaceAll("_", " ")}`, "", claim.statement, "", "## Literature evidence", "", ...evidence, ""].join("\n"),
    {
      type: "Literature Claim",
      campaign_id: claim.campaignId,
      kind: claim.kind,
      stance: claim.stance,
      confidence: claim.confidence,
      status: claim.status,
      generated: claim.generated,
      ...(claim.reviewed ? { reviewed: claim.reviewed } : {}),
      evidence: claim.evidence,
      created_at: claim.createdAt,
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
  ): string {
    const entries = concepts
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((concept) => `* [${concept.title}](concepts/${concept.id}.md) - ${concept.description}`)
    const claimEntries = claims.map((claim) => `* [${claim.statement}](claims/${claim.id}.md) - ${claim.status}`)
    const sourceEntries = literature.map((record) => `* [${record.title}](sources/${record.id}.md) - ${record.database}`)
    const body = [
      `# ${campaign.objective}`,
      "",
      `Campaign knowledge catalog: \`${campaign.knowledgeCatalogId}\``,
      "",
      "## Research knowledge",
      "",
      ...(entries.length ? entries : ["No research outcomes yet."]),
      "",
      "## Literature claims",
      "",
      ...(claimEntries.length ? claimEntries : ["No literature claims yet."]),
      "",
      "## Literature sources",
      "",
      ...(sourceEntries.length ? sourceEntries : ["No literature sources yet."]),
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
    const records = new Map(literature.map((record) => [record.id, record]))
    for (const record of literature) {
      if (record.campaignId !== input.campaign.id) throw new Error(`Literature ${record.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "sources", `${record.id}.md`), literatureBody(record))
    }
    for (const claim of claims) {
      if (claim.campaignId !== input.campaign.id) throw new Error(`Claim ${claim.id} belongs to another campaign`)
      await writeAtomic(path.join(root, "claims", `${claim.id}.md`), claimBody(claim, records))
    }
    await writeAtomic(path.join(root, "index.md"), renderIndex(input.campaign, input.concepts, literature, claims))
    return root
  }
}
