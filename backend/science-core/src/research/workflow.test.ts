import {HistoricalWorkflow} from './compatibility/workflow'
import {ProtoRuntimeInspection} from '../../../engine/src/execution/proto-inspection'
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { ExecutionProtocol } from "./execution-protocol"
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
  test("compiles a bounded fixed panel with frozen scoring and no generation policy", () => {
    const frozenContract = {
      budget: { maximumCandidates: 3, gpuHours: 1, wallTimeMinutes: 60 },
      evaluator: {
        submissionSize: 3,
        evidenceAdapter: {
          id: "proto-structure-pipeline", version: "3", sourceHash: `sha256:${"1".repeat(64)}`,
          scoringPipelineHash: undefined,
          scoringPipeline: {
            format: "autofold.scoring-pipeline.v1" as const,
            protoToolsCommit: commit,
            stages: [{
              id: "boltz2-score", role: "scoring" as const,
              models: [{ id: "boltz2-prediction", version: commit, toolKey: "boltz2-prediction", config: { use_msa: false } }],
              dependsOn: [], budget: { maximumGpuSeconds: 600 },
              required: true, allowSkip: false, allowedSkips: [],
            }],
          },
        },
      },
    }
    const fixed = {
      generation: null,
      program: {
        kind: "native" as const, optimizerCount: 1, constructCount: 3, generatorCount: 0,
        proposalSources: ["existing_results"], fixedSequences: ["ACDEFG", "CDEFGH", "DEFGHI"],
        programResultCount: 1,
        optimizerSamples: [{ numSamples: 1, numResults: 1, proposalBatchSize: 1 }],
      },
    }
    const plan = HistoricalWorkflow.fromAuthoredTrial({ trial: fixed, intent: "calibrate", contract: frozenContract })!
    const pipeline = ResearchWorkflow.compile({
      plan, tools, generators: [], contract: frozenContract,
      protoToolsCommit: commit, protoLanguageCommit: languageCommit, bindSource: false,
    })
    expect(pipeline.generation).toBeUndefined()
    expect(pipeline.executionBudget).toEqual({
      semantics: "aggregate_worker_gpu_wall_v1",
      maximumGpuSeconds: 3_600,
    })
    expect(pipeline.staticConstruction?.fixedSequences).toEqual(fixed.program.fixedSequences)
    expect(pipeline.staticConstruction).toMatchObject({
      format: "autofold.static-construction.v1",
      kind: "native",
      optimizerCount: 1,
      generatorCount: 0,
      proposalSources: ["existing_results"],
    })
    expect(pipeline.stages.map((stage) => [stage.id, stage.role])).toEqual([["boltz2-score", "scoring"]])
    const differentOuterAllocation = ExecutionProtocol.PipelinePolicy.parse({
      ...pipeline,
      executionBudget: { semantics: "aggregate_worker_gpu_wall_v1", maximumGpuSeconds: 3_599 },
    })
    expect(ResearchWorkflow.scoringPipelineHash(differentOuterAllocation)).toBe(
      ResearchWorkflow.scoringPipelineHash(pipeline),
    )
    expect(ExecutionProtocol.hashPipeline(differentOuterAllocation)).not.toBe(ExecutionProtocol.hashPipeline(pipeline))
    expect(() => ResearchWorkflow.validateFixedProgram({
      ...fixed, program: { ...fixed.program, generatorCount: 1 },
    }, "negative_control", frozenContract)).toThrow("cannot contain a Proto generator")
    expect(() => ResearchWorkflow.validateFixedProgram({
      ...fixed, program: { ...fixed.program, fixedSequences: fixed.program.fixedSequences.slice(0, 2) },
    }, "calibrate", frozenContract)).toThrow("exactly 3 unique sequences")
    expect(HistoricalWorkflow.fromAuthoredTrial({ trial: fixed, intent: "optimize", contract: frozenContract }))
      .toBeUndefined()
    expect(() => ResearchWorkflow.validateFixedProgram({
      ...fixed, program: { ...fixed.program, proposalSources: ["generated"] },
    }, "calibrate", frozenContract)).toThrow("proposal_source='existing_results'")
    expect(() => ResearchWorkflow.validateFixedProgram({
      ...fixed, program: { ...fixed.program, kind: "portfolio" },
    }, "calibrate", frozenContract)).toThrow("not ProtoPortfolioProgram")
  })

  test("reconstructs the same fixed program inventory used by launch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-fixed-describe-"))
    try {
      const trialPath = path.join(root, "trial.py")
      await fs.writeFile(trialPath, [
        "from autofold_worker.proto_trial import ProtoTrial",
        "class Sequence:",
        "    def __init__(self, value): self.sequence = value",
        "class Segment:",
        "    def __init__(self, value): self.result_sequences = [Sequence(value)]",
        "class Construct:",
        "    def __init__(self, value): self.segments = [Segment(value)]",
        "class Config: proposal_source = 'existing_results'",
        "class Optimizer:",
        "    generators = []; config = Config()",
        "    num_samples = num_results = proposal_batch_size = 1",
        "class FixedProgram:",
        "    optimizers = [Optimizer()]",
        "    constructs = [Construct('ACDEFG'), Construct('CDEFGH'), Construct('DEFGHI')]",
        "    num_results = 1",
        "    def run(self): raise AssertionError('description must not execute')",
        "def build_trial(ctx):",
        "    return ProtoTrial(program=FixedProgram(), hypothesis='Compare fixed positives.', intent='calibrate', calibration_class='known_positive')",
        "",
      ].join("\n"))
      const described = await ProtoRuntimeInspection.describeTrial(trialPath, "python3", {
        candidateBudget: 3, submissionSize: 3, modality: "short_peptide", seeds: [7], intent: "calibrate",
      },{containment:async command=>command,containmentName:"trusted_offline_cpu_fixture"})
      expect(described.program).toEqual({
        kind: "native", optimizerCount: 1, constructCount: 3, generatorCount: 0,
        proposalSources: ["existing_results"], fixedSequences: ["ACDEFG", "CDEFGH", "DEFGHI"],
        programResultCount: 1,
        optimizerSamples: [{ numSamples: 1, numResults: 1, proposalBatchSize: 1 }],
      })
      expect(described.declaration).toMatchObject({ intent: "calibrate", calibrationClass: "known_positive" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("derives a frozen scoring workflow from a direct composite portfolio", () => {
    const directContract = {
      budget: { maximumCandidates: 4, gpuHours: 1, wallTimeMinutes: 60 },
      evaluator: { submissionSize: 3 },
    }
    const plan = HistoricalWorkflow.fromComposite({
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
    const plan = HistoricalWorkflow.fromComposite({
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
    expect(pipeline.executionBudget).toBeUndefined()
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
      const plan = await ProtoRuntimeInspection.extract(program, "python3",{containment:async command=>command,containmentName:"trusted_offline_cpu_fixture"})
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
    if (Bun.env.AUTOFOLD_PROTO_INTEGRATION_TESTS !== "1") return
    const installed = await Promise.all([fs.access(protoPython), fs.access(path.join(protoRoot, "proto_language"))]).then(
      () => true,
      () => false,
    )
    if (!installed) return
    const plan = await ProtoRuntimeInspection.extract(generationExample, protoPython)
    expect(plan?.generation?.generators).toEqual(["rfdiffusion-mpnn-binder"])
    await ProtoRuntimeInspection.validateConfigs(plan!, protoPython, protoRoot)
    const languageCommit = (await Bun.$`git -C ${protoRoot} rev-parse HEAD`.text()).trim()
    const toolsCommit = (await Bun.$`git -C ${path.join(protoRoot, "proto-tools")} rev-parse HEAD`.text()).trim()
    const discoveredGenerators = await ProtoRuntimeInspection.discoverGenerators(protoPython, protoRoot)
    expect(discoveredGenerators.map((generator) => generator.key)).toContain("boltzgen-binder")
    expect(discoveredGenerators.map((generator) => generator.key)).toContain("pxdesign-binder")
    const pipeline = ResearchWorkflow.compile({
      plan: plan!,
      tools: await ProtoRuntimeInspection.discover(protoPython, protoRoot),
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

test("native inspection captures compatibility metadata once without executing the program",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"single-native-inspection-"))
 try{
  const file=path.join(root,"trial.py")
  await fs.writeFile(file,`from autofold_worker.proto_trial import ProtoTrial\nAUTOFOLD_WORKFLOW={"format":"autofold.proto-workflow.v1","id":"compatibility","maximumGpuSeconds":0,"stages":[]}\nclass Program:\n    optimizers=[];constructs=[];num_results=0\n    def run(self):raise AssertionError("Cannot execute during inspection")\ndef build_trial(ctx):return ProtoTrial(program=Program(),hypothesis="Inspect once")\n`)
  const inspection=await ProtoRuntimeInspection.describeTrial(file,"python3",{seeds:[7],candidateBudget:1,submissionSize:1,modality:"short_peptide"},{containment:async command=>command,containmentName:"trusted_offline_cpu_fixture"})
  expect(inspection.legacyWorkflow?.id).toBe("compatibility")
 }finally{await fs.rm(root,{recursive:true,force:true})}
})


test("future host executor binding preserves frozen scoring and historical policy identity while routing stays on DAG",()=>{
 const scoring=ExecutionProtocol.ScoringPipeline.parse({format:"autofold.scoring-pipeline.v1",protoToolsCommit:commit,
  stages:[{id:"score",role:"scoring",models:[{id:"boltz2-prediction",version:commit,toolKey:"boltz2-prediction",config:{use_msa:false}}],dependsOn:[],budget:{maximumGpuSeconds:600},required:true,allowSkip:false,allowedSkips:[]}]})
 const plan=HistoricalWorkflow.fromComposite({contract:{...contract,evaluator:{...contract.evaluator,evidenceAdapter:{id:"proto-structure-pipeline",version:"3",sourceHash:`sha256:${"c".repeat(64)}`,scoringPipeline:scoring}}}})
 const captured=ResearchWorkflow.compile({plan,tools,contract,protoToolsCommit:commit,protoLanguageCommit:languageCommit}),hash=ExecutionProtocol.hashPipeline(captured)
 const selected=ExecutionProtocol.bindEvidenceExecution(captured)
 expect(selected.executionBackend).toBe("native_tool_sequence_v1")
 expect(ResearchWorkflow.scoringPipelineHash(selected)).toBe(ResearchWorkflow.scoringPipelineHash(captured))
 expect(ExecutionProtocol.PipelinePolicy.parse(captured).executionBackend).toBeUndefined()
 expect(ExecutionProtocol.hashPipeline(captured)).toBe(hash)
 expect(ExecutionProtocol.hashPipeline(selected)).not.toBe(hash)
 expect(ExecutionProtocol.bindEvidenceExecution(captured,"legacy_dag_v1").executionBackend).toBe("legacy_dag_v1")
 const conditional=ExecutionProtocol.PipelinePolicy.parse({...captured,stages:[...captured.stages,{id:"diagnostic",role:"diagnostic",models:[{id:"chai1-prediction",version:commit}],dependsOn:["score"],condition:{source:"score",metric:"iptm",operator:"gt",value:0.5},required:false,allowSkip:true,allowedSkips:["condition_false"]}]})
 expect(ExecutionProtocol.bindEvidenceExecution(conditional).executionBackend).toBe("legacy_dag_v1")
 expect(()=>ExecutionProtocol.bindEvidenceExecution(conditional,"native_tool_sequence_v1")).toThrow("conditional or routed")
 expect(()=>ExecutionProtocol.PipelinePolicy.parse({...captured,stages:[{...captured.stages[0],id:"later",dependsOn:["score"]},...captured.stages]})).toThrow("topologically ordered")
})


describe("native scientific search admission", () => {
  const native = (wall = 30): ExecutionProtocol.NativeSearch => ({format: "autofold.native-search.v1",
    budget: {maximumCandidates: 1, maximumProposals: 100, maximumSamplingCalls: 20, maximumToolCalls: 20,
      maximumWallSeconds: wall, allowedTools: ["cpu-mutation"], outputs: [{construct: "design", segment: null, lane: 0}]},
    projection: [{lane: 0, numResults: 1, externalInputs: [], constructs: [{label: "design"}],
      stages: [0,1].map(i => ({instanceId: `lane0.stage${i}`, optimizer: "MCMCOptimizer", config: {num_steps: 3},
        settings: {}, targetSegment: null, customLogging: null, numResults: 1, conditioning: null, constraints: [],
        generators: [{instanceId: `lane0.stage${i}.generator0`, key: "same-native-type", segments: ["binder"], config: {}, toolsCalled: ["cpu-mutation"]}]}))}]})
  const c = {budget: {maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 60}, evaluator: {submissionSize: 1}}
  const component = [{key: "same-native-type", usesGpu: false, toolsCalled: ["cpu-mutation"]}]
  const tool = [{key: "cpu-mutation", category: "mutagenesis", usesGpu: false}, {key: "score-tool", category: "structure_prediction", usesGpu: false}]
  const build = (descriptor = native()) => HistoricalWorkflow.fromAuthoredTrial({trial: {nativeSearch: descriptor} as ResearchWorkflow.AuthoredTrial, intent: "optimize", contract: c})!
  test("same-type stages preserve proposal breadth independently of final submissions", () => {
    const plan = build()
    plan.stages.push({id: "score", capability: "structure_prediction", role: "scoring", tools: ["score-tool"], configs: {}, selection: "all", dependsOn: [], optional: false, maximumGpuSeconds:1})
    const pipeline = ResearchWorkflow.compile({plan, tools: tool, generators: component, contract: c, protoToolsCommit: commit, protoLanguageCommit: languageCommit})
    expect(pipeline.nativeSearch?.projection[0]?.stages.length).toBe(2)
    expect(pipeline.nativeSearch?.budget.maximumProposals).toBe(100)
    expect(pipeline.generation?.budget.maximumCandidates).toBe(1)
    expect(pipeline.generation?.generators[0]?.allocation).toBeUndefined()
    expect(pipeline.generation?.generators.map(g => g.id)).toEqual(["same-native-type"])
    expect(ResearchWorkflow.scoringPipelineHash(pipeline)).toBe(ResearchWorkflow.scoringPipelineHash({...pipeline, nativeSearch: native(31)}))
    expect(ExecutionProtocol.hashPipeline(pipeline)).not.toBe(ExecutionProtocol.hashPipeline({...pipeline, nativeSearch: native(31)}))
  })
  test("fresh native reservations bind model, output-candidate and fixed-seed request cardinality",()=>{
    const plan=build();plan.maximumGpuSeconds=300
    plan.stages.push({id:"score",capability:"structure_prediction",role:"scoring",tools:["score-tool","second-score"],configs:{},selection:"all",dependsOn:[],optional:false,maximumGpuSeconds:100})
    const contract={...c,evaluator:{...c.evaluator,fixedSeeds:[7,11]}}
    const compile=()=>ResearchWorkflow.compile({plan,tools:[...tool,{key:"second-score",category:"structure_prediction",usesGpu:false}],generators:component,contract,protoToolsCommit:commit,protoLanguageCommit:languageCommit})
    expect(compile).toThrow("model/candidate/seed")
    plan.maximumGpuSeconds=500
    const pipeline=compile()
    expect(pipeline.executionBudget).toMatchObject({unit:"wall_seconds",reservationSemantics:"per_model_candidate_seed_timeout_upper_bound_v1",reservedEvidenceWallSeconds:400,
      invocationReservations:[{stageId:"score",maximumCandidates:1,seedCount:2,modelCount:2,maximumRequests:4,perRequestTimeoutSeconds:100,reservedWallSeconds:400}]})
  })
  test("fresh native CPU model stages cannot claim a zero timeout reservation by omitting a deadline",()=>{
    const plan=build();plan.stages.push({id:"cpu-score",capability:"structure_prediction",role:"scoring",tools:["score-tool"],configs:{},selection:"all",dependsOn:[],optional:false})
    const compile=()=>ResearchWorkflow.compile({plan,tools:tool,generators:component,contract:c,protoToolsCommit:commit,protoLanguageCommit:languageCommit})
    expect(compile).toThrow("explicit positive wall-time deadline")
    plan.stages[0]!.maximumGpuSeconds=5
    expect(compile().executionBudget?.invocationReservations).toEqual([{stageId:"cpu-score",maximumCandidates:1,seedCount:1,modelCount:1,maximumRequests:1,perRequestTimeoutSeconds:5,reservedWallSeconds:5}])
  })
  test("native call declarations and total search wall time are admitted before execution", () => {
    const compile = (plan = build(), tools = tool) => ResearchWorkflow.compile({plan, tools, generators: component, contract: c, protoToolsCommit: commit, protoLanguageCommit: languageCommit})
    expect(() => compile(build(), [])).toThrow("not installed")
    expect(() => compile(build(native(3601)))).toThrow("aggregate execution budget")
    const undeclared = native(); undeclared.budget.allowedTools=[]
    expect(() => compile(build(undeclared))).toThrow("undeclared tool")
    expect(() => HistoricalWorkflow.fromAuthoredTrial({trial: {nativeSearch: native()} as ResearchWorkflow.AuthoredTrial, intent: "calibrate", contract: c})).toThrow("Fixed controls")
  })
})


test("native inspection captures rich programs without execution and rejects an attempted model call", async()=>{
 if(!await Bun.file(protoPython).exists()) return
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"native-inspection-"))
 try {
  const file=path.join(directory,"trial.py"), example=await fs.readFile(path.resolve(import.meta.dir,"../../../worker/examples/native_search_trial.py"),"utf8")
  const bundle={candidateBudget:1,submissionSize:1,seeds:[7],modality:"short_peptide",intent:"optimize"}
  await fs.writeFile(file,example)
  const described=await ProtoRuntimeInspection.describeTrial(file,protoPython,bundle,{protoRoot:path.resolve(import.meta.dir,"../../../../../repo_store/github.com-evo-design-proto-language"),containment:async command=>command,containmentName:"trusted_offline_cpu_fixture"})
  expect(described.nativeSearch?.projection[0]?.stages).toHaveLength(2)
  expect(described.nativeSearch?.projection[0]?.stages.map(stage=>stage.generators[0]?.key)).toEqual(["random-protein","random-protein"])
  expect(described.nativeSearch?.budget.maximumProposals).toBeGreaterThan(described.nativeSearch?.budget.maximumCandidates ?? 0)
  const injected=example.replace("def build_trial(ctx):",`def build_trial(ctx):
    from proto_tools import ToolRegistry
    tool = ToolRegistry.get("random-protein-sample")
    try:
        tool.function(tool.input_model(sequences=["ACDE"]), tool.config_model())
    except Exception:
        pass`)
  await fs.writeFile(file,injected)
  await expect(ProtoRuntimeInspection.describeTrial(file,protoPython,bundle,{protoRoot:path.resolve(import.meta.dir,"../../../../../repo_store/github.com-evo-design-proto-language"),containment:async command=>command,containmentName:"trusted_offline_cpu_fixture"})).rejects.toThrow("attempted native tool execution")
 }finally{await fs.rm(directory,{recursive:true,force:true})}
},30000)
