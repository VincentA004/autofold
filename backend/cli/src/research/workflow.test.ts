import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { ResearchWorkflow } from "./workflow"

const contract = {
  budget: { maximumCandidates: 100, gpuHours: 1, wallTimeMinutes: 60 },
  evaluator: { submissionSize: 3 },
}
const commit = "a".repeat(40)
const tools: ResearchWorkflow.Tool[] = [
  { key: "boltz2-prediction", category: "structure_prediction", usesGpu: true },
  { key: "chai1-prediction", category: "structure_prediction", usesGpu: true },
  { key: "protenix-prediction", category: "structure_prediction", usesGpu: true },
]

describe("dynamic Proto workflow compiler", () => {
  test("resolves registry tools and topologically freezes an agent-authored graph", () => {
    const pipeline = ResearchWorkflow.compile({
      contract,
      protoToolsCommit: commit,
      tools,
      plan: {
        format: "autofold.proto-workflow.v1",
        id: "adaptive-validation",
        maximumGpuSeconds: 1_200,
        stages: [
          {
            id: "resolve_disagreement",
            capability: "structure_prediction",
            tools: ["protenix-prediction"],
            dependsOn: ["primary", "independent"],
            condition: { source: "independent", metric: "predictor_disagreement", operator: "gt", value: 0.15 },
            maximumCandidates: 10,
            maximumGpuSeconds: 300,
            optional: true,
          },
          {
            id: "primary",
            capability: "structure_prediction",
            tools: ["boltz2-prediction"],
            maximumCandidates: 100,
            maximumGpuSeconds: 500,
          },
          {
            id: "independent",
            capability: "structure_prediction",
            tools: ["missing-predictor", "chai1-prediction"],
            selection: "first_available",
            dependsOn: ["primary"],
            maximumCandidates: 20,
            maximumGpuSeconds: 400,
          },
        ],
      },
    })
    expect(pipeline.stages.map((stage) => stage.id)).toEqual(["primary", "independent", "resolve_disagreement"])
    expect(pipeline.stages[1]?.models.map((model) => model.toolKey)).toEqual(["chai1-prediction"])
    expect(pipeline.stages[2]?.allowSkip).toBe(true)
    expect(pipeline.sourceHash).toStartWith("sha256:")
    expect(pipeline.protoToolsCommit).toBe(commit)
  })

  test("enforces the frozen experiment compute budget", () => {
    expect(() =>
      ResearchWorkflow.compile({
        contract,
        protoToolsCommit: commit,
        tools,
        plan: {
          format: "autofold.proto-workflow.v1",
          id: "over-budget",
          maximumGpuSeconds: 4_000,
          stages: [
            {
              id: "primary",
              capability: "structure_prediction",
              tools: ["boltz2-prediction"],
              maximumGpuSeconds: 4_000,
            },
          ],
        },
      }),
    ).toThrow("experiment permits 3600")
  })

  test("extracts only a literal manifest without executing trial source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-workflow-"))
    try {
      const marker = path.join(root, "must-not-exist")
      const program = path.join(root, "trial.py")
      await fs.writeFile(
        program,
        `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("bad")\nAUTOFOLD_WORKFLOW = {"format":"autofold.proto-workflow.v1","id":"literal","maximumGpuSeconds":10,"stages":[{"id":"primary","capability":"structure_prediction","tools":["boltz2-prediction"],"maximumGpuSeconds":10}]}\n`,
      )
      const plan = await ResearchWorkflow.extract(program, "python3")
      expect(plan?.id).toBe("literal")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
