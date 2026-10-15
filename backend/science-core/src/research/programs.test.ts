import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchPrograms } from "./programs"

describe("research program authoring", () => {
  test("stores programs immutably by content hash", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-program-"))
    try {
      const input = { hypothesis: "baseline", designAdapter: "mock" as const, program: "# trial\n" }
      const first = await ResearchPrograms.author(workspace, input)
      const second = await ResearchPrograms.author(workspace, input)
      expect(second).toEqual(first)
      expect(first.programHash).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(first.programPath).toBe(`.autofold/programs/${first.programHash.slice(7)}/trial.py`)
      expect(await Bun.file(path.join(workspace, first.programPath)).text()).toBe(input.program)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("publishes runnable mock and Proto templates", () => {
    const templates = ResearchPrograms.templates()
    expect(templates.mock).toContain("immutable file's content hash")
    expect(templates.proto).toContain("def build_trial(ctx):")
    expect(templates.proto).not.toContain("def build_program(")
    expect(templates.proto).not.toMatch(/^AUTOFOLD_WORKFLOW\s*=/m)
    expect(templates.proto).toContain("seed=ctx.generation_seed if seed is None else seed")
    expect(templates.proto).toContain("ctx.generation_seed")
    expect(templates.proto).not.toContain("seed=ctx.seeds[0]")
  })
})
