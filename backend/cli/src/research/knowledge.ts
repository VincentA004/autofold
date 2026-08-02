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

export namespace ResearchKnowledge {
  export function relativeRunResource(campaignId: string, resource: string): string {
    const concepts = path.posix.join(".autofold", "campaigns", campaignId, "knowledge", "concepts")
    return path.posix.relative(concepts, resource)
  }

  export function renderConcept(concept: ResearchDomain.KnowledgeConcept): string {
    return matter.stringify(conceptBody(concept), conceptFrontmatter(concept))
  }

  export function renderIndex(campaign: ResearchDomain.Campaign, concepts: ResearchDomain.KnowledgeConcept[]): string {
    const entries = concepts
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((concept) => `* [${concept.title}](concepts/${concept.id}.md) - ${concept.description}`)
    const body = [
      `# ${campaign.objective}`,
      "",
      `Campaign knowledge catalog: \`${campaign.knowledgeCatalogId}\``,
      "",
      "## Research knowledge",
      "",
      ...(entries.length ? entries : ["No research outcomes yet."]),
      "",
    ].join("\n")
    return matter.stringify(body, { okf_version: "0.2" })
  }

  export async function writeBundle(input: {
    workspace: string
    campaign: ResearchDomain.Campaign
    concepts: ResearchDomain.KnowledgeConcept[]
  }): Promise<string> {
    const root = bundleRoot(input.workspace, input.campaign.id)
    for (const concept of input.concepts) {
      if (concept.campaignId !== input.campaign.id) {
        throw new Error(`Knowledge concept ${concept.id} belongs to another campaign`)
      }
      await writeAtomic(path.join(root, "concepts", `${concept.id}.md`), renderConcept(concept))
    }
    await writeAtomic(path.join(root, "index.md"), renderIndex(input.campaign, input.concepts))
    return root
  }
}
