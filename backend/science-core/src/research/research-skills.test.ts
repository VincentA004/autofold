import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ResearchSkills } from "./research-skills"

const skillPath = path.resolve(import.meta.dir, "../fixtures/predictor-interpretation.md")

describe("injectable domain knowledge", () => {
  test("parses attributed Markdown biology knowledge", async () => {
    const skill = ResearchSkills.parseMarkdown(await fs.readFile(skillPath, "utf8"))
    expect(skill.id).toBe("skill_bionemo.predictor-interpretation")
    expect(skill.source.commit).toBe("23d4835")
    expect(skill.appliesToToolKeys).toContain("boltz2-prediction")
    expect(skill.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("rejects runtime, endpoint, credential, and installation instructions", async () => {
    const markdown = await fs.readFile(skillPath, "utf8")
    expect(() => ResearchSkills.parseMarkdown(`${markdown}\nRun docker with NVIDIA_API_KEY.`)).toThrow(
      "Domain knowledge must not contain runtime",
    )
  })

  test("requires failure and falsification sections", async () => {
    const markdown = await fs.readFile(skillPath, "utf8")
    expect(() => ResearchSkills.parseMarkdown(markdown.replace("## Falsifying questions", "## Questions"))).toThrow(
      "missing required heading",
    )
    expect(markdown).not.toMatch(/NGC_API_KEY|curl\s|docker\s|pip install|https?:\/\//i)
  })

  test("gives actionable frontmatter errors without relaxing the canonical metadata schema", async () => {
    const markdown = await fs.readFile(skillPath, "utf8")
    expect(() => ResearchSkills.parseMarkdown(markdown.replace("capabilities: [model_diagnostics, evidence_reasoning, structural_biology]", "capabilities: [model-diagnostics]")))
      .toThrow(/capabilities: provide 1–6 values from .*model_diagnostics/)
    expect(() => ResearchSkills.parseMarkdown(markdown.replace("paths: [nim-skills/boltz2-nim/SKILL.md]", "paths: []")))
      .toThrow(/source\.paths: provide at least one attributed source path/)
    expect(() => ResearchSkills.parseMarkdown("# Missing metadata\n\n## Guidance\ntext\n## Failure modes\ntext\n## Falsifying questions\ntext"))
      .toThrow(/must begin with YAML frontmatter/)
    expect(() => ResearchSkills.parseMarkdown(markdown.replace("version: 1", "version: [unterminated")))
      .toThrow(/Invalid YAML frontmatter/)
  })
})
