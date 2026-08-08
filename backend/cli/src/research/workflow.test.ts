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
const languageCommit = "b".repeat(40)
const tools: ResearchWorkflow.Tool[] = [
  { key: "boltz2-prediction", category: "structure_prediction", usesGpu: true },
  { key: "chai1-prediction", category: "structure_prediction", usesGpu: true },
  { key: "protenix-prediction", category: "structure_prediction", usesGpu: true },
]
const generators: ResearchWorkflow.Generator[] = [
  { key: "rfdiffusion-mpnn-binder", usesGpu: true, toolsCalled: ["rfdiffusion3-design", "proteinmpnn-sample"] },
]
const protoRoot = path.join(os.homedir(), "Developer", "repo_store", "github.com-evo-design-proto-language")
const protoPython = path.resolve(import.meta.dir, "../../../../.autofold/envs/proto/bin/python")
const generationExample = path.resolve(import.meta.dir, "../../../worker/examples/rfdiffusion_mpnn_trial.py")

describe("dynamic Proto workflow compiler", () => {
  test("resolves registry tools and topologically freezes an agent-authored graph", () => {
    const pipeline = ResearchWorkflow.compile({
      contract,
      protoToolsCommit: commit,
      protoLanguageCommit: languageCommit,
      tools,
      generators,
      plan: {
        format: "autofold.proto-workflow.v1",
        id: "adaptive-validation",
        maximumGpuSeconds: 1_300,
        generation: {
          generators: ["rfdiffusion-mpnn-binder"],
          maximumCandidates: 100,
          maximumGpuSeconds: 100,
        },
        stages: [
          {
            id: "resolve_disagreement",
            capability: "structure_prediction",
            tools: ["protenix-prediction"],
            dependsOn: ["primary", "independent"],
            condition: { source: "independent", metric: "predictor_disagreement", operator: "gt", value: 0.15 },
            candidateRouting: { source: "independent", metric: "confidence_score", direction: "maximize", maximumCandidates: 2 },
            maximumCandidates: 10,
            maximumGpuSeconds: 300,
            optional: true,
          },
          {
            id: "primary",
            capability: "structure_prediction",
            tools: ["boltz2-prediction"],
            configs: { "boltz2-prediction": { use_msa: false, sampling_steps: 20 } },
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
    expect(pipeline.stages[0]?.models[0]?.config).toEqual({ use_msa: false, sampling_steps: 20 })
    expect(pipeline.stages[2]?.allowSkip).toBe(true)
    expect(pipeline.stages[2]?.allowedSkips).toEqual(["condition_false", "candidate_filtered", "optional_tool_failure"])
    expect(pipeline.sourceHash).toStartWith("sha256:")
    expect(pipeline.protoToolsCommit).toBe(commit)
    expect(pipeline.generation?.generators).toEqual([
      {
        id: "rfdiffusion-mpnn-binder",
        version: languageCommit,
        toolsCalled: ["rfdiffusion3-design", "proteinmpnn-sample"],
      },
    ])
  })

  test("enforces the frozen experiment compute budget", () => {
    expect(() =>
      ResearchWorkflow.compile({
        contract,
        protoToolsCommit: commit,
        protoLanguageCommit: languageCommit,
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

  test("reserves seed, timeout, and device for the trusted runtime", () => {
    expect(() =>
      ResearchWorkflow.Plan.parse({
        format: "autofold.proto-workflow.v1",
        id: "unsafe-runtime-config",
        maximumGpuSeconds: 10,
        stages: [
          {
            id: "primary",
            capability: "structure_prediction",
            tools: ["boltz2-prediction"],
            configs: { "boltz2-prediction": { device: "cpu" } },
            maximumGpuSeconds: 10,
          },
        ],
      }),
    ).toThrow("Autofold owns the device runtime setting")
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
      const hashProcess = Bun.spawn(
        [
          "python3",
          "-c",
          `import ast,hashlib,json,pathlib,sys\nt=ast.parse(pathlib.Path(sys.argv[1]).read_text())\nw=ast.literal_eval(next(n for n in t.body if isinstance(n, ast.Assign) and any(isinstance(x, ast.Name) and x.id == "AUTOFOLD_WORKFLOW" for x in n.targets)).value)\nfor s in w["stages"]: s.update({"selection":s.get("selection","all"),"configs":s.get("configs",{}),"dependsOn":s.get("dependsOn",[]),"optional":s.get("optional",False)})\nprint("sha256:"+hashlib.sha256(json.dumps(w,sort_keys=True,separators=(",",":")).encode()).hexdigest())`,
          program,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const [hashCode, pythonHash] = await Promise.all([hashProcess.exited, new Response(hashProcess.stdout).text()])
      expect(hashCode).toBe(0)
      expect(pythonHash.trim()).toBe(ResearchWorkflow.hash(plan!))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("compiles the production RFdiffusion3 and ProteinMPNN trial against the pinned registries", async () => {
    const installed = await Promise.all([fs.access(protoPython), fs.access(path.join(protoRoot, "proto_language"))]).then(
      () => true,
      () => false,
    )
    if (!installed) return
    const plan = await ResearchWorkflow.extract(generationExample, protoPython)
    expect(plan?.generation?.generators).toEqual(["rfdiffusion-mpnn-binder"])
    await ResearchWorkflow.validateConfigs(plan!, protoPython, protoRoot)
    const languageCommit = (await Bun.$`git -C ${protoRoot} rev-parse HEAD`.text()).trim()
    const toolsCommit = (await Bun.$`git -C ${path.join(protoRoot, "proto-tools")} rev-parse HEAD`.text()).trim()
    const pipeline = ResearchWorkflow.compile({
      plan: plan!,
      tools: await ResearchWorkflow.discover(protoPython, protoRoot),
      generators: await ResearchWorkflow.discoverGenerators(protoPython, protoRoot),
      contract: {
        budget: { maximumCandidates: 16, gpuHours: 2, wallTimeMinutes: 180 },
        evaluator: { submissionSize: 2 },
      },
      protoLanguageCommit: languageCommit,
      protoToolsCommit: toolsCommit,
    })
    expect(pipeline.generation?.generators[0]?.id).toBe("rfdiffusion-mpnn-binder")
    expect(pipeline.stages.map((stage) => stage.id)).toEqual(["primary", "independent", "resolution"])
  }, 30_000)
})
