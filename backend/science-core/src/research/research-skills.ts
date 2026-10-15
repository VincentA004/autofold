import matter from "gray-matter"
import z from "zod"

const RUNTIME_INSTRUCTION = /(?:\bcurl\b|\bwget\b|\bdocker\b|\bpip\s+install\b|\bconda\b|\bNGC_API_KEY\b|\bNVIDIA_API_KEY\b|\blocalhost:\d+\b|\bpython3?\s+[^\s]+\.py\b)/i
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ResearchSkills {
  export const Capability = z.enum([
    "structural_biology",
    "model_diagnostics",
    "developability",
    "experimental_design",
    "workflow_design",
    "evidence_reasoning",
  ])
  export type Capability = z.infer<typeof Capability>

  export const Reference = z.object({
    id: z.string().regex(/^skill_[a-z0-9._-]+$/),
    version: z.number().int().positive(),
    versionId: z.string().startsWith("skv_"),
    contentHash: Digest,
  }).passthrough()
  export type Reference = z.infer<typeof Reference>

  export const Frontmatter = z.object({
    id: Reference.shape.id,
    version: Reference.shape.version,
    title: z.string().trim().min(1).max(200),
    capabilities: z.array(Capability).min(1).max(6),
    applies_to: z.array(z.string().trim().min(1)).max(30).default([]),
    source: z.object({
      repository: z.string().trim().min(1),
      commit: z.string().trim().min(1),
      paths: z.array(z.string().trim().min(1)).min(1).max(30),
      license: z.string().trim().min(1),
      attribution: z.string().trim().min(1),
    }).passthrough(),
  }).passthrough()
  export type Frontmatter = z.infer<typeof Frontmatter>

  export const DomainKnowledge = z.object({
    ...Frontmatter.shape,
    appliesToToolKeys: z.array(z.string().trim().min(1)).max(30),
    content: z.string().trim().min(1).max(30_000),
    contentHash: Digest,
    versionId: z.string().startsWith("skv_").optional(),
  }).passthrough()
  export type DomainKnowledge = z.infer<typeof DomainKnowledge>

  const frontmatterGuide = [
    "Use this YAML block as the starting frontmatter (keep the existing id, source attribution, capabilities and applies_to unchanged):",
    "---",
    "id: skill_example.domain-guide",
    "version: 2",
    "title: Short descriptive title",
    "capabilities: [evidence_reasoning]",
    "applies_to: [registered-generator-key]",
    "source:",
    "  repository: upstream/repository",
    "  commit: exact-upstream-commit",
    "  paths: [path/to/source.md]",
    "  license: upstream license",
    "  attribution: Adapted and modified from the attributed source.",
    "---",
    "Allowed capabilities: structural_biology, model_diagnostics, developability, experimental_design, workflow_design, evidence_reasoning.",
  ].join("\n")

  function actionableFrontmatterError(error: unknown): string {
    if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error)
    const allowed = Capability.options.join(", ")
    const issues = error.issues.map(issue => {
      const field = issue.path.length ? issue.path.join(".") : "frontmatter"
      if (issue.path[0] === "capabilities") return `capabilities: provide 1–6 values from ${allowed}`
      if (field === "source.paths") return `${field}: provide at least one attributed source path`
      if (field === "source") return `${field}: provide repository, commit, paths, license, and attribution`
      if (field === "applies_to") return `${field}: provide a list of applicable tool or generator keys (or [])`
      return `${field}: ${issue.message}`
    })
    return `Invalid skill YAML frontmatter. Fix: ${[...new Set(issues)].join("; ")}\n${frontmatterGuide}`
  }

  export function parseMarkdown(markdown: string): DomainKnowledge {
    if (RUNTIME_INSTRUCTION.test(markdown)) {
      throw new Error("Domain knowledge must not contain runtime, endpoint, credential, installation, or shell instructions")
    }
    if (!markdown.trimStart().startsWith("---\n") && !markdown.trimStart().startsWith("---\r\n")) {
      throw new Error(`Skill Markdown must begin with YAML frontmatter between --- lines.\n${frontmatterGuide}`)
    }
    let parsed: ReturnType<typeof matter>
    try { parsed = matter(markdown) }
    catch (error) { throw new Error(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}. Quote strings containing YAML punctuation and keep list values inside [ ].\n${frontmatterGuide}`) }
    let metadata: Frontmatter
    try { metadata = Frontmatter.parse(parsed.data) }
    catch (error) { throw new Error(actionableFrontmatterError(error)) }
    const content = parsed.content.trim()
    for (const heading of ["Guidance", "Failure modes", "Falsifying questions"]) {
      if (!new RegExp(`^##\\s+${heading}\\s*$`, "im").test(content)) {
        throw new Error(`Domain skill ${metadata.id} is missing required heading: ${heading}`)
      }
    }
    return DomainKnowledge.parse({
      ...metadata,
      appliesToToolKeys: metadata.applies_to,
      content,
      contentHash: hash(markdown),
    })
  }

  export function reference(skill: DomainKnowledge & { versionId: string }): Reference {
    return Reference.parse({
      id: skill.id,
      version: skill.version,
      versionId: skill.versionId,
      contentHash: skill.contentHash,
    })
  }

  export function references(skills: readonly (DomainKnowledge & { versionId: string })[]): Reference[] {
    return skills.map(reference)
  }

  export function hash(value: string): string {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(value)
    return `sha256:${hasher.digest("hex")}`
  }
}
