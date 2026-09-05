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
  test("derives a frozen scoring workflow from a direct composite portfolio", () => {
    const directContract = {
      budget: { maximumCandidates: 4, gpuHours: 1, wallTimeMinutes: 60 },
      evaluator: { submissionSize: 3 },
    }
    const plan = ResearchWorkflow.fromComposite({
      generation: {
        generators: ["boltzgen-binder", "rfdiffusion-mpnn-binder"],
        allocations: [
          { generator: "boltzgen-binder", maximumCandidates: 2, maximumGpuSeconds: 600 },
          { generator: "rfdiffusion-mpnn-binder", maximumCandidates: 2, maximumGpuSeconds: 1200 },
        ],
        maximumCandidates: 4,
        maximumGpuSeconds: 1800,
      },
      contract: directContract,
    })
    const pipeline = ResearchWorkflow.compile({
      plan,
      tools,
      generators: [
        { key: "boltzgen-binder", usesGpu: true, toolsCalled: ["boltzgen-design"] },
        ...generators,
      ],
      contract: directContract,
      protoToolsCommit: "a".repeat(40),
      protoLanguageCommit: "b".repeat(40),
      bindSource: false,
    })
    expect(pipeline.sourceHash).toBeUndefined()
    expect(pipeline.generation?.generators.map((item) => item.id)).toEqual([
      "boltzgen-binder",
      "rfdiffusion-mpnn-binder",
    ])
  })
  test("compiles agent-authored diagnostics beside the injected frozen scorer", () => {
    const frozenContract = {
      budget: { maximumCandidates: 2, gpuHours: 1, wallTimeMinutes: 60 },
      evaluator: {
        submissionSize: 1,
        evidenceAdapter: {
          id: "proto-structure-pipeline",
          version: "3",
          sourceHash: `sha256:${"1".repeat(64)}`,
          scoringPipelineHash: undefined,
          scoringPipeline: {
            format: "autofold.scoring-pipeline.v1" as const,
            protoToolsCommit: "a".repeat(40),
            stages: [{
              id: "boltz2-score",
              role: "scoring" as const,
              models: [{ id: "boltz2-prediction", version: "a".repeat(40), toolKey: "boltz2-prediction", config: { use_msa: false } }],
              dependsOn: [],
              budget: { maximumGpuSeconds: 600 },
              required: true,
              allowSkip: false,
              allowedSkips: [],
            }],
          },
        },
      },
    }
    const diagnostic = {
      id: "chai-ablation",
      role: "diagnostic" as const,
      capability: "structure_prediction",
      tools: ["chai1-prediction"],
      configs: { "chai1-prediction": { use_msa: false } },
      dependsOn: [],
      maximumGpuSeconds: 300,
      optional: true,
    }
    const plan = ResearchWorkflow.fromComposite({
      generation: {
        generators: ["rfdiffusion-mpnn-binder"],
        allocations: [{ generator: "rfdiffusion-mpnn-binder", maximumCandidates: 2, maximumGpuSeconds: 1200 }],
        maximumCandidates: 2,
        maximumGpuSeconds: 1200,
      },
      diagnostics: [diagnostic],
      contract: frozenContract,
    })
    const pipeline = ResearchWorkflow.compile({
      plan,
      tools,
      generators,
      contract: frozenContract,
      protoToolsCommit: "a".repeat(40),
      protoLanguageCommit: "b".repeat(40),
      bindSource: false,
    })
    expect(pipeline.authoredDiagnostics).toEqual([{
      ...diagnostic,
      selection: "all",
    }])
    expect(pipeline.stages.map((stage) => [stage.id, stage.role])).toEqual([
      ["chai-ablation", "diagnostic"],
      ["boltz2-score", "scoring"],
    ])
  })
  test("rejects routing on metrics that predictors do not emit", () => {
    const plan = {
      format: "autofold.proto-workflow.v1" as const,
      id: "invalid-routing-metric",
      maximumGpuSeconds: 20,
      stages: [
      {
        id: "source",
        capability: "structure_prediction",
        tools: ["boltz2-prediction"],
        configs: {},
        dependsOn: [],
        optional: true,
        maximumGpuSeconds: 10,
      },
      {
        id: "routed",
        capability: "structure_prediction",
        tools: ["chai1-prediction"],
        configs: {},
        dependsOn: ["source"],
        optional: true,
        maximumGpuSeconds: 10,
        candidateRouting: { source: "source", metric: "loss", direction: "minimize", maximumCandidates: 1 },
      },
      ],
    }
    expect(() => ResearchWorkflow.Plan.parse(plan)).toThrow()
  })

  test("accepts a CPU-only Proto Language program without external tool stages", () => {
    const pipeline = ResearchWorkflow.compile({
      contract: { budget: { ...contract.budget, gpuHours: 0 }, evaluator: contract.evaluator },
      protoToolsCommit: commit,
      protoLanguageCommit: languageCommit,
      tools,
      plan: {
        format: "autofold.proto-workflow.v1",
        id: "proto-language-only",
        maximumGpuSeconds: 0,
        stages: [],
      },
    })
    expect(pipeline.stages).toEqual([])
    expect(pipeline.id).toBe("proto-language-only")
  })

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
            configs: { "protenix-prediction": { use_msa: false } },
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
            configs: { "chai1-prediction": { use_msa: false } },
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
        allocation: { maximumCandidates: 100, maximumGpuSeconds: 100 },
      },
    ])
  })

  test("freezes the locked scoring lane while leaving diagnostic composition agent-editable", () => {
    const plan = ResearchWorkflow.Plan.parse({
      format: "autofold.proto-workflow.v1" as const,
      id: "scoring-plus-diagnostics",
      maximumGpuSeconds: 900,
      stages: [
        {
          id: "locked-boltz",
          role: "scoring" as const,
          capability: "structure_prediction",
          tools: ["boltz2-prediction"],
          configs: { "boltz2-prediction": { use_msa: false, sampling_steps: 200 } },
          maximumGpuSeconds: 300,
        },
        {
          id: "locked-chai",
          role: "scoring" as const,
          capability: "structure_prediction",
          tools: ["chai1-prediction"],
          configs: { "chai1-prediction": { use_msa: false, num_diffn_samples: 5 } },
          maximumGpuSeconds: 300,
        },
        {
          id: "exploratory-protenix",
          role: "diagnostic" as const,
          capability: "structure_prediction",
          tools: ["protenix-prediction"],
          configs: { "protenix-prediction": { use_msa: false, model_name: "protenix-v2" } },
          dependsOn: ["locked-chai"],
          candidateRouting: { source: "locked-chai", metric: "iptm" as const, direction: "maximize" as const, maximumCandidates: 1 },
          maximumGpuSeconds: 300,
          optional: true,
        },
      ],
    })
    const baseline = ResearchWorkflow.compile({
      contract, protoToolsCommit: commit, protoLanguageCommit: languageCommit, tools, plan,
    })
    const scoringPipelineHash = ResearchWorkflow.scoringPipelineHash(baseline)
    const frozenContract = {
      ...contract,
      evaluator: {
        submissionSize: 3,
        evidenceAdapter: {
          id: "proto-structure-pipeline",
          version: "2",
          sourceHash: `sha256:${"c".repeat(64)}`,
          scoringPipelineHash,
        },
      },
    }
    const diagnosticAblation = {
      ...plan,
      stages: plan.stages.map((stage) => stage.id === "exploratory-protenix"
        ? { ...stage, configs: { "protenix-prediction": { use_msa: false, model_name: "protenix-v2", num_recycles: 1 } } }
        : stage),
    }
    expect(() => ResearchWorkflow.compile({
      contract: frozenContract, protoToolsCommit: commit, protoLanguageCommit: languageCommit, tools, plan: diagnosticAblation,
    })).not.toThrow()

    const scoringMutation = {
      ...plan,
      stages: plan.stages.map((stage) => stage.id === "locked-boltz"
        ? { ...stage, configs: { "boltz2-prediction": { use_msa: false, sampling_steps: 20 } } }
        : stage),
    }
    expect(() => ResearchWorkflow.compile({
      contract: frozenContract, protoToolsCommit: commit, protoLanguageCommit: languageCommit, tools, plan: scoringMutation,
    })).toThrow("Authored scoring pipeline changed")

    const routedScoring = {
      ...plan,
      stages: plan.stages.map((stage) => stage.id === "locked-chai"
        ? {
            ...stage,
            dependsOn: ["locked-boltz"],
            candidateRouting: { source: "locked-boltz", metric: "iptm" as const, direction: "maximize" as const, maximumCandidates: 1 },
          }
        : stage),
    }
    expect(() => ResearchWorkflow.compile({
      contract: frozenContract, protoToolsCommit: commit, protoLanguageCommit: languageCommit, tools, plan: routedScoring,
    })).toThrow("must evaluate every submitted candidate")
  })

  test("requires and freezes explicit multi-generator portfolio allocations", () => {
    const portfolioGenerators = [
      ...generators,
      { key: "boltzgen-binder", usesGpu: true, toolsCalled: ["boltzgen-design"] },
    ]
    const base = {
      format: "autofold.proto-workflow.v1" as const,
      id: "portfolio",
      maximumGpuSeconds: 1_000,
      generation: {
        generators: ["rfdiffusion-mpnn-binder", "boltzgen-binder"],
        maximumCandidates: 5,
        maximumGpuSeconds: 1_000,
      },
      stages: [],
    }
    expect(() => ResearchWorkflow.Plan.parse(base)).toThrow("explicit per-generator allocations")
    const pipeline = ResearchWorkflow.compile({
      contract,
      protoToolsCommit: commit,
      protoLanguageCommit: languageCommit,
      tools,
      generators: portfolioGenerators,
      plan: {
        ...base,
        generation: {
          ...base.generation,
          allocations: [
            { generator: "rfdiffusion-mpnn-binder", maximumCandidates: 3, maximumGpuSeconds: 600 },
            { generator: "boltzgen-binder", maximumCandidates: 2, maximumGpuSeconds: 400 },
          ],
        },
      },
    })
    expect(pipeline.generation?.generators.map((generator) => generator.allocation?.maximumCandidates)).toEqual([3, 2])
  })

  test("fingerprints equivalent workflow DAGs independently of labels and declaration order", () => {
    const first = {
      format: "autofold.proto-workflow.v1" as const,
      id: "first-label",
      maximumGpuSeconds: 100,
      stages: [
        { id: "secondary", capability: "structure_prediction", tools: ["chai1-prediction"], dependsOn: ["primary"] },
        { id: "primary", capability: "structure_prediction", tools: ["boltz2-prediction"] },
      ],
    }
    const second = {
      ...first,
      id: "another-label",
      stages: first.stages.toReversed(),
    }
    expect(ResearchWorkflow.fingerprint(first)).toBe(ResearchWorkflow.fingerprint(second))
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

  test("rejects implicit mutable remote MSA searches from frozen predictor workflows", () => {
    expect(() => ResearchWorkflow.compile({
      contract,
      protoToolsCommit: commit,
      protoLanguageCommit: languageCommit,
      tools,
      plan: {
        format: "autofold.proto-workflow.v1",
        id: "implicit-network-msa",
        maximumGpuSeconds: 10,
        stages: [{
          id: "primary",
          capability: "structure_prediction",
          tools: ["boltz2-prediction"],
          maximumGpuSeconds: 10,
        }],
      },
    })).toThrow("use_msa=false")
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
    const discoveredGenerators = await ResearchWorkflow.discoverGenerators(protoPython, protoRoot)
    expect(discoveredGenerators.map((generator) => generator.key)).toContain("boltzgen-binder")
    expect(discoveredGenerators.map((generator) => generator.key)).toContain("pxdesign-binder")
    const pipeline = ResearchWorkflow.compile({
      plan: plan!,
      tools: await ResearchWorkflow.discover(protoPython, protoRoot),
      generators: discoveredGenerators,
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
