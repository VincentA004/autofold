import {canonicalValue as canonical} from '../util/canonical'
import crypto from "node:crypto"
import z from "zod"
import { ResearchDomain } from "./domain"
import { ExecutionProtocol } from "./execution-protocol"
import { ProtoModelRegistry } from "./model-registry"


const stageId = ExecutionProtocol.StageId
const toolKey = ExecutionProtocol.ToolKey
const routingMetric = z.enum([
  "confidence_score",
  "protein_iptm",
  "iptm",
  "ptm",
  "complex_plddt",
  "avg_plddt",
  "avg_pae",
])
const implicitRemoteMsaTools = new Set([
  "boltz2-prediction",
  "chai1-prediction",
  "protenix-prediction",
])

export namespace ResearchWorkflow {
  export const ProgramGeneration = z.object({
    generators: z.array(toolKey).min(1).max(8),
    allocations: z.array(z.object({
      generator: toolKey,
      maximumCandidates: z.number().int().positive(),
      maximumGpuSeconds: z.number().int().positive(),
    }).passthrough()).min(1).max(8),
    maximumCandidates: z.number().int().positive(),
    maximumGpuSeconds: z.number().int().positive(),
  }).passthrough().superRefine((generation, context) => {
    const declared = new Set(generation.generators)
    const allocated = generation.allocations.map((item) => item.generator)
    if (declared.size !== generation.generators.length || new Set(allocated).size !== allocated.length) {
      context.addIssue({ code: "custom", path: ["generators"], message: "Composite generator lanes must be unique" })
    }
    if (allocated.length !== declared.size || allocated.some((generator) => !declared.has(generator))) {
      context.addIssue({ code: "custom", path: ["allocations"], message: "Every composite lane requires one allocation" })
    }
    if (generation.allocations.reduce((total, item) => total + item.maximumCandidates, 0) !== generation.maximumCandidates) {
      context.addIssue({ code: "custom", path: ["maximumCandidates"], message: "Composite candidate allocations must equal the total" })
    }
    if (generation.allocations.reduce((total, item) => total + item.maximumGpuSeconds, 0) !== generation.maximumGpuSeconds) {
      context.addIssue({ code: "custom", path: ["maximumGpuSeconds"], message: "Composite GPU allocations must equal the total" })
    }
  })
  export type ProgramGeneration = z.infer<typeof ProgramGeneration>

  export const Condition = ExecutionProtocol.Condition
  export const CandidateRouting = ExecutionProtocol.CandidateRouting.extend({ metric: routingMetric })

  export const Plan = z
    .object({
      format: z.literal("autofold.proto-workflow.v1"),
      id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      maximumGpuSeconds: z.number().finite().nonnegative(),
      nativeSearch: ExecutionProtocol.NativeSearch.optional(),
      generation: z.object({
        generators: z.array(toolKey).min(1).max(8),
        allocations: z.array(z.object({
          generator: toolKey,
          maximumCandidates: z.number().int().positive(),
          maximumGpuSeconds: z.number().finite().positive(),
        }).passthrough()).min(1).max(8).optional(),
        maximumCandidates: z.number().int().positive(),
        maximumGpuSeconds: z.number().finite().positive().optional(),
      }).passthrough().optional(),
      staticConstruction: ExecutionProtocol.StaticConstruction.optional(),
      stages: z
        .array(
          z.object({
            id: stageId,
            role: z.enum(["scoring", "diagnostic"]).optional(),
            capability: z.string().trim().min(1),
            inputRequirements: ProtoModelRegistry.Requirements.optional(),
            tools: z.array(toolKey).min(1).max(8),
            configs: z.record(toolKey, z.record(z.string(), z.unknown())).default({}),
            selection: z.enum(["all", "first_available"]).default("all"),
            dependsOn: z.array(stageId).default([]),
            condition: Condition.optional(),
            candidateRouting: CandidateRouting.optional(),
            maximumCandidates: ExecutionProtocol.StageBudget.shape.maximumCandidates,
            maximumGpuSeconds: ExecutionProtocol.StageBudget.shape.maximumGpuSeconds,
            optional: z.boolean().default(false),
          }).passthrough(),
        )
        .max(64),
    }).passthrough()
    .superRefine((plan, context) => {
      if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 256 * 1024) {
        context.addIssue({ code: "custom", path: [], message: "Workflow manifest is too large" })
      }
      if (plan.generation && new Set(plan.generation.generators).size !== plan.generation.generators.length) {
        context.addIssue({ code: "custom", path: ["generation", "generators"], message: "Generation tools must be unique" })
      }
      if (plan.generation && plan.staticConstruction) {
        context.addIssue({ code: "custom", path: ["staticConstruction"], message: "Generated and fixed construction plans are mutually exclusive" })
      }
      if (plan.generation?.generators.length && plan.generation.generators.length > 1 && !plan.generation.allocations && !plan.nativeSearch) {
        context.addIssue({
          code: "custom",
          path: ["generation", "allocations"],
          message: "Multi-generator portfolios require explicit per-generator allocations",
        })
      }
      if (plan.generation?.allocations) {
        const declared = new Set(plan.generation.generators)
        const allocated = plan.generation.allocations.map((allocation) => allocation.generator)
        if (new Set(allocated).size !== allocated.length) {
          context.addIssue({ code: "custom", path: ["generation", "allocations"], message: "Generator allocations must be unique" })
        }
        if (allocated.length !== declared.size || allocated.some((generator) => !declared.has(generator))) {
          context.addIssue({ code: "custom", path: ["generation", "allocations"], message: "Every declared generator requires exactly one allocation" })
        }
        const candidates = plan.generation.allocations.reduce((total, allocation) => total + allocation.maximumCandidates, 0)
        if (candidates !== plan.generation.maximumCandidates) {
          context.addIssue({ code: "custom", path: ["generation", "allocations"], message: "Generator candidate allocations must equal maximumCandidates" })
        }
        const gpuSeconds = plan.generation.allocations.reduce((total, allocation) => total + allocation.maximumGpuSeconds, 0)
        if (plan.generation.maximumGpuSeconds !== undefined && gpuSeconds > plan.generation.maximumGpuSeconds) {
          context.addIssue({ code: "custom", path: ["generation", "allocations"], message: "Generator GPU allocations exceed the generation budget" })
        }
      }
      const ids = new Set(plan.stages.map((stage) => stage.id))
      if (ids.size !== plan.stages.length) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Workflow stage IDs must be unique" })
      }
      for (const [index, stage] of plan.stages.entries()) {
        if (new Set(stage.tools).size !== stage.tools.length) {
          context.addIssue({ code: "custom", path: ["stages", index, "tools"], message: "Workflow tools must be unique within a stage" })
        }
        for (const [key, config] of Object.entries(stage.configs)) {
          if (!stage.tools.includes(key)) {
            context.addIssue({ code: "custom", path: ["stages", index, "configs", key], message: "Workflow config references an undeclared tool" })
          }
          for (const reserved of ["seed", "seeds", "timeout", "device"]) {
            if (reserved in config) {
              context.addIssue({ code: "custom", path: ["stages", index, "configs", key, reserved], message: `Autofold owns the ${reserved} runtime setting` })
            }
          }
        }
        for (const dependency of stage.dependsOn) {
          if (!ids.has(dependency) || dependency === stage.id) {
            context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: `Invalid workflow dependency: ${dependency}` })
          }
        }
        if (new Set(stage.dependsOn).size !== stage.dependsOn.length) {
          context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: "Workflow dependencies must be unique" })
        }
        if (stage.condition && !stage.dependsOn.includes(stage.condition.source)) {
          context.addIssue({ code: "custom", path: ["stages", index, "condition", "source"], message: "Condition source must be a direct dependency" })
        }
        if (stage.candidateRouting && !stage.dependsOn.includes(stage.candidateRouting.source)) {
          context.addIssue({ code: "custom", path: ["stages", index, "candidateRouting", "source"], message: "Candidate-routing source must be a direct dependency" })
        }
        if (stage.candidateRouting && stage.maximumCandidates && stage.candidateRouting.maximumCandidates > stage.maximumCandidates) {
          context.addIssue({ code: "custom", path: ["stages", index, "candidateRouting", "maximumCandidates"], message: "Candidate route exceeds the stage candidate budget" })
        }
        const byId = new Map(plan.stages.map((item) => [item.id, item]))
        if (!stage.optional && stage.dependsOn.some((dependency) => byId.get(dependency)?.optional)) {
          context.addIssue({ code: "custom", path: ["stages", index, "optional"], message: "A required stage cannot depend on an optional stage" })
        }
      }
      if (!topological(plan.stages)) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Workflow dependencies must be acyclic" })
      }
    })
  export type Plan = z.infer<typeof Plan>

  export function fingerprint(raw: z.input<typeof Plan>): string {
    const plan = Plan.parse(raw)
    const normalized = {
      ...plan,
      id: "workflow",
      generation: plan.generation
        ? {
            ...plan.generation,
            generators: plan.generation.generators.toSorted(),
            allocations: plan.generation.allocations?.toSorted((left, right) =>
              left.generator.localeCompare(right.generator),
            ),
          }
        : undefined,
      stages: plan.stages
        .map((stage) => ({
          ...stage,
          tools: stage.tools.toSorted(),
          dependsOn: stage.dependsOn.toSorted(),
          configs: Object.fromEntries(Object.entries(stage.configs).toSorted(([left], [right]) => left.localeCompare(right))),
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    }
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`
  }

  export const Tool = z.object({
    key: toolKey,
    category: z.string().trim().min(1),
    usesGpu: z.boolean(),
    numericMetrics: z.array(toolKey).optional(),
    modelCard: ProtoModelRegistry.Card.optional(),
  }).passthrough().refine(item => !item.modelCard || item.modelCard.key === item.key && item.modelCard.kind === 'tool' && item.modelCard.category === item.category,
    'Model card must match its native tool identity and category')
  export type Tool = z.infer<typeof Tool>
  export const Generator = z.object({
    key: toolKey,
    label: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    className: z.string().trim().min(1).optional(),
    classModule: z.string().trim().min(1).optional(),
    configName: z.string().trim().min(1).optional(),
    configModule: z.string().trim().min(1).optional(),
    configFields: z.array(z.string().trim().min(1)).optional(),
    configSchema: z.unknown().optional(),
    allowsEmptyStartingSequence: z.boolean().optional(),
    usesGpu: z.boolean(),
    toolsCalled: z.array(toolKey),
    modelCard: ProtoModelRegistry.Card.optional(),
  }).passthrough().refine(item => !item.modelCard || item.modelCard.key === item.key && item.modelCard.kind === 'generator',
    'Model card must match its native generator identity')
  export type Generator = z.infer<typeof Generator>

  /** Host-internal native generator specs; never send target/config bytes back as model context. */
  export const GeneratorPreflight = z.object({
    generators: z.array(z.object({
      id: toolKey,
      config: z.record(z.string(), z.unknown()),
      sequenceLength: z.number().int().positive().max(10_000),
      targetPdb: z.string().min(1).max(10_000_000),
    }).passthrough()).max(64),
  })
  export type GeneratorPreflight = z.infer<typeof GeneratorPreflight>

  export const AuthoredTrial = z.object({
    executionProtocol: ExecutionProtocol.NativeProtocol.optional(),
    nativeObservation: z.literal("scoped_native_lifecycle_v1").optional(),
    nativeFixedControl: ExecutionProtocol.NativeFixedControl.nullable().optional(),
    generation: ProgramGeneration.nullable().optional(),
    nativeSearch: ExecutionProtocol.NativeSearch.nullable().optional(),
    generatorPreflight: GeneratorPreflight.optional(),
    program: z.object({
      constraintSettings: z.array(z.object({
        optimizerIndex: z.number().int().nonnegative(), function: z.string(), definition: z.string(),
        parameters: z.record(z.string(), z.unknown()), parameterDescriptions: z.record(z.string(), z.string()),
        role: z.enum(["filter", "scoring"]), effect: z.string(), cpuProbe: z.unknown().optional(), filterThreshold: z.number().nullable(),
        inputLengths: z.array(z.number().int().nonnegative().nullable()),
      }).passthrough()).optional(),
      kind: z.enum(["native", "portfolio"]),
      optimizerCount: z.number().int().nonnegative(),
      constructCount: z.number().int().nonnegative(),
      generatorCount: z.number().int().nonnegative(),
      proposalSources: z.array(z.string().nullable()).max(64),
      fixedSequences: z.array(z.string().max(10_000)).max(1_000),
      programResultCount: z.number().int().nonnegative().nullable(),
      optimizerSamples: z.array(z.object({
        numSamples: z.number().int().nonnegative().nullable(),
        numResults: z.number().int().nonnegative().nullable(),
        proposalBatchSize: z.number().int().nonnegative().nullable(),
      }).passthrough()).max(64),
    }).passthrough(),
    diagnostics: z.array(z.unknown()).max(64).default([]),
    legacyWorkflow: Plan.nullable().optional(),
    staticConstruction: ExecutionProtocol.StaticConstruction.nullable().optional(),
    declaration: z.object({
      intent: z.enum(["optimize", "calibrate", "negative_control", "shadow_replay"]),
      calibrationClass: z.enum(["known_positive", "known_negative", "neutral"]).optional(),
      replicateOfTrialId: z.string().startsWith("trl_").optional(),
    }).passthrough(),
    hypothesis: z.string().trim().min(1).max(20_000),
  }).passthrough()
  export type AuthoredTrial = z.infer<typeof AuthoredTrial>

  /** Fresh programs have one actual native declaration. Only the frozen scorer
   * is compiled by Autofold; optimizer behavior is never translated into a DAG. */
  export function compileNative(input: {trial: AuthoredTrial; contract: CompileInput["contract"]; tools: Tool[]; generators: Generator[]; protoToolsCommit: string; protoLanguageCommit: string}) {
    const {trial, contract} = input
    if (!trial.executionProtocol) throw new Error("Fresh Proto construction must declare a native execution protocol")
    if (trial.nativeObservation !== "scoped_native_lifecycle_v1") throw new Error("Fresh Proto construction requires its pinned scoped native lifecycle capability")
    if (trial.legacyWorkflow || trial.generation || trial.diagnostics.length) throw new Error("Fresh native execution cannot admit legacy workflows, allocations or authored diagnostic DAGs")
    const fixed = trial.executionProtocol === "native_fixed_control_v1"
    if (fixed) {
      if (!["calibrate", "negative_control"].includes(trial.declaration.intent)) throw new Error("Fixed native execution requires calibration/control intent")
      if (!trial.staticConstruction?.nativeProjection || !trial.nativeFixedControl || trial.nativeSearch) throw new Error("Fixed native control requires its complete construction and bounded explicit outputs")
      const pool = trial.staticConstruction.fixedSequences.length
      if (pool < contract.evaluator.submissionSize || pool > contract.budget.maximumCandidates) throw new Error("Fixed native candidate pool must cover final evaluator selection within its candidate ceiling")
      // Historical fixed validation retains its old exact-panel rule. Fresh
      // selectors bind the evaluated pool; the scorer chooses final Top N later.
      validateFixedProgram({...trial, program: {...trial.program, fixedSequences: trial.staticConstruction.fixedSequences}}, trial.declaration.intent,
        {...contract, evaluator: {...contract.evaluator, submissionSize: pool}})
    } else if (!trial.nativeSearch || trial.nativeFixedControl) {
      throw new Error("Native search requires explicit search limits and outputs")
    }
    const descriptor = fixed ? trial.staticConstruction! : trial.nativeSearch!
    const native = fixed ? trial.staticConstruction!.nativeProjection! : trial.nativeSearch!
    const outputs = fixed ? trial.nativeFixedControl!.outputs : native.budget.outputs
    const maximumSearchWallSeconds = fixed ? trial.nativeFixedControl!.maximumWallSeconds : native.budget.maximumWallSeconds
    const installedTools = new Map(input.tools.map(tool => [tool.key, tool]))
    const installedGenerators = new Map(input.generators.map(generator => [generator.key, generator]))
    const generatorKeys = [...new Set(native.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators.map(generator => generator.key))))]
    for (const key of native.budget.allowedTools) if (!installedTools.has(key)) throw new Error(`Native admitted tool is not installed: ${key}`)
    for (const lane of native.projection) for (const stage of lane.stages) for (const generator of stage.generators) {
      const registered = installedGenerators.get(generator.key)
      if (!registered || JSON.stringify([...registered.toolsCalled].sort()) !== JSON.stringify([...generator.toolsCalled].sort())) throw new Error(`Native generator registry declaration mismatch: ${generator.key}`)
      if (generator.toolsCalled.some(key => !native.budget.allowedTools.includes(key))) throw new Error(`Native generator ${generator.key} uses an undeclared tool`)
    }
    if (native.budget.maximumCandidates > contract.budget.maximumCandidates) throw new Error("Native output pool exceeds the experiment candidate budget")
    if (!fixed && native.budget.maximumCandidates < contract.evaluator.submissionSize) throw new Error("Native output pool cannot cover the frozen evaluator final selection")
    const scoring = contract.evaluator.evidenceAdapter?.scoringPipeline
    const plan = Plan.parse({format: "autofold.proto-workflow.v1", id: "frozen-native-evaluation", maximumGpuSeconds: contract.budget.gpuHours * 3600,
      stages: scoring?.stages.map(stage => ({id: stage.id, role: "scoring", capability: "structure_prediction", tools: stage.models.map(model => model.toolKey ?? model.id),
        configs: Object.fromEntries(stage.models.map(model => [model.toolKey ?? model.id, model.config ?? {}])), dependsOn: stage.dependsOn,
        maximumCandidates: stage.budget?.maximumCandidates, maximumGpuSeconds: stage.budget?.maximumGpuSeconds, optional: false})) ?? []})
    const compiled = compile({...input, plan, bindSource: false})
    const maximumCandidates = fixed ? trial.staticConstruction!.fixedSequences.length : native.budget.maximumCandidates
    const invocationReservations = compiled.stages.map(stage => {
      if (stage.budget?.maximumCandidates !== undefined && maximumCandidates > stage.budget.maximumCandidates) throw new Error("Native pool exceeds the frozen evaluation stage candidate ceiling")
      const perRequestTimeoutSeconds = stage.budget?.maximumGpuSeconds
      if (typeof perRequestTimeoutSeconds !== "number" || !Number.isFinite(perRequestTimeoutSeconds) || perRequestTimeoutSeconds <= 0) throw new Error("Fresh native evaluation requires an explicit finite per-request deadline")
      const seedCount = contract.evaluator.fixedSeeds?.length ?? 1, modelCount = stage.models.length
      const maximumRequests = maximumCandidates * seedCount * modelCount
      return {stageId: stage.id, maximumCandidates, seedCount, modelCount, maximumRequests, perRequestTimeoutSeconds, reservedWallSeconds: maximumRequests * perRequestTimeoutSeconds}
    })
    const reservedEvaluationWallSeconds = invocationReservations.reduce((sum, item) => sum + item.reservedWallSeconds, 0)
    const searchUsesGpu = generatorKeys.some(key => installedGenerators.get(key)?.usesGpu) || native.budget.allowedTools.some(key => installedTools.get(key)?.usesGpu)
    const reservedSearchComputeSeconds = fixed ? 0 : searchUsesGpu ? maximumSearchWallSeconds : 0
    const reservedEvaluationComputeSeconds = invocationReservations.reduce((total, reservation, index) => total + reservation.maximumCandidates * reservation.seedCount * reservation.perRequestTimeoutSeconds * compiled.stages[index]!.models.filter(model => installedTools.get(model.toolKey ?? model.id)?.usesGpu).length, 0)
    const maximumComputeReservationSeconds = contract.budget.gpuHours * 3600
    const maximumWorkerWallSeconds = contract.budget.wallTimeMinutes * 60
    const nativeExecution = ExecutionProtocol.NativeExecution.parse({protocol: trial.executionProtocol, descriptor, outputs,
      resources: {maximumSearchWallSeconds, maximumWorkerWallSeconds, reservedEvaluationWallSeconds, maximumComputeReservationSeconds, reservedSearchComputeSeconds, reservedEvaluationComputeSeconds, invocationReservations}, observation: trial.nativeObservation})
    const {executionBudget: _historicalBudget, ...evaluation} = compiled
    const pipeline = ExecutionProtocol.PipelinePolicy.parse({...evaluation, executionBackend: "native_tool_sequence_v1"})
    return {pipeline, nativeExecution, generatorKeys}
  }


  /** Compare executable settings, excluding descriptive text and synthetic probe results. */
  export function inspectedParameterChanges(before: AuthoredTrial["program"], after: AuthoredTrial["program"]) {
    const settings = (program: AuthoredTrial["program"]) => ({
      kind: program.kind, optimizerSamples: program.optimizerSamples,
      constraints: program.constraintSettings?.map(({optimizerIndex, function: fn, parameters, role, filterThreshold, inputLengths}) =>
        ({optimizerIndex, function: fn, parameters, role, filterThreshold, inputLengths})) ?? [],
    })
    const changes: Array<{path:string; before:unknown; after:unknown}> = []
    const walk = (left: unknown, right: unknown, at: string) => {
      if (JSON.stringify(left) === JSON.stringify(right)) return
      if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
          walk((left as Record<string,unknown>)[key], (right as Record<string,unknown>)[key], at ? `${at}.${key}` : key)
        }
      } else changes.push({path:at,before:left ?? null,after:right ?? null})
    }
    walk(settings(before), settings(after), "")
    return changes
  }

  /** Admit a deterministic fixed panel without weakening generated-program policy. */
  export function validateFixedProgram(
    trial: Pick<AuthoredTrial, "generation" | "program" | "staticConstruction" | "nativeSearch">,
    intent: "optimize" | "calibrate" | "negative_control" | "shadow_replay",
    contract: Pick<CompileInput["contract"], "budget" | "evaluator">,
  ): void {
    if (trial.generation || !["calibrate", "negative_control"].includes(intent)) return
    const program = trial.program
    if (program.kind !== "native") {
      throw new Error("Fixed calibration/control must use one native Proto Program, not ProtoPortfolioProgram")
    }
    if (program.optimizerCount !== 1 || program.optimizerSamples.length !== 1) {
      throw new Error("Fixed calibration/control must use exactly one optimizer over the complete static panel")
    }
    if (program.constructCount < 1) {
      throw new Error("Fixed calibration/control must contain at least one Proto Construct")
    }
    if (program.generatorCount !== 0) {
      throw new Error("Fixed calibration/control cannot contain a Proto generator")
    }
    if (program.proposalSources.length !== 1 || program.proposalSources[0] !== "existing_results") {
      throw new Error("Fixed calibration/control optimizer must use proposal_source='existing_results'")
    }
    const expected = contract.evaluator.submissionSize
    if (expected > contract.budget.maximumCandidates) {
      throw new Error("Frozen submission size exceeds the experiment candidate budget")
    }
    if (program.fixedSequences.length !== expected || new Set(program.fixedSequences).size !== expected) {
      throw new Error(`Fixed calibration/control must construct exactly ${expected} unique sequences to match the frozen submission size`)
    }
    if (program.fixedSequences.some((sequence) => !/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(sequence))) {
      throw new Error("Fixed calibration/control sequences must use the protein amino-acid alphabet")
    }
    const sampling = program.optimizerSamples[0]!
    for (const [name, value] of [
      ["Program num_results", program.programResultCount],
      ["optimizer num_samples", sampling.numSamples],
      ["optimizer num_results", sampling.numResults],
      ["optimizer proposal_batch_size", sampling.proposalBatchSize],
    ] as const) {
      if (value === null || value < 1 || value > contract.budget.maximumCandidates) {
        throw new Error(`Fixed calibration/control ${name} must be positive and within candidate budget ${contract.budget.maximumCandidates}`)
      }
    }
  }

  export interface CompileInput {
    plan: z.input<typeof Plan>
    tools: Tool[]
    generators?: Generator[]
    contract: {
      budget: ResearchDomain.ExperimentContract["budget"]
      evaluator: Pick<ResearchDomain.ExperimentContract["evaluator"], "submissionSize" | "evidenceAdapter"> & Partial<Pick<ResearchDomain.ExperimentContract["evaluator"],"fixedSeeds">>
    }
    protoToolsCommit: string
    protoLanguageCommit: string
    allowedCapabilities?: string[]
    bindSource?: boolean
  }

  export function compile(raw: CompileInput): ExecutionProtocol.PipelinePolicy {
    const plan = Plan.parse(raw.plan)
    const tools = new Map(z.array(Tool).parse(raw.tools).map((tool) => [tool.key, tool]))
    const generators = new Map(z.array(Generator).parse(raw.generators ?? []).map((generator) => [generator.key, generator]))
    const allowedCapabilities = new Set(raw.allowedCapabilities ?? ["structure_prediction"])
    const maximumGpuSeconds = raw.contract.budget.gpuHours * 3_600
    if (plan.maximumGpuSeconds > maximumGpuSeconds) {
      throw new Error(`Workflow requests ${plan.maximumGpuSeconds} GPU seconds; experiment permits ${maximumGpuSeconds}`)
    }
    if (plan.nativeSearch) {
      const budget = plan.nativeSearch.budget
      if (budget.maximumCandidates > raw.contract.budget.maximumCandidates) throw new Error("Native outputs exceed the experiment candidate budget")
      const finalSeconds = plan.stages.reduce((sum, stage) => sum + (stage.maximumGpuSeconds ?? 0), 0)
      if (budget.maximumWallSeconds + finalSeconds > plan.maximumGpuSeconds) throw new Error("Native search and frozen evaluation exceed the aggregate execution budget")
      for (const key of budget.allowedTools) if (!tools.has(key)) throw new Error(`Native admitted tool is not installed: ${key}`)
      for (const lane of plan.nativeSearch.projection) for (const stage of lane.stages) for (const generator of stage.generators) {
        const spec = generators.get(generator.key)
        if (!spec || JSON.stringify([...spec.toolsCalled].sort()) !== JSON.stringify([...generator.toolsCalled].sort()))
          throw new Error(`Native generator registry declaration mismatch: ${generator.key}`)
        if (generator.toolsCalled.some(key => !budget.allowedTools.includes(key))) throw new Error(`Native generator ${generator.key} uses an undeclared tool`)
      }
    }
    let generation: ExecutionProtocol.PipelinePolicy["generation"]
    if (plan.generation) {
      if (plan.generation.maximumCandidates > raw.contract.budget.maximumCandidates) {
        throw new Error(`Generation requests ${plan.generation.maximumCandidates} candidates; experiment permits ${raw.contract.budget.maximumCandidates}`)
      }
      const selected = plan.generation.generators.map((key) => {
        const generator = generators.get(key)
        if (!generator) throw new Error(`Proto generator is not installed: ${key}`)
        return generator
      })
      if (selected.some((generator) => generator.usesGpu) && !plan.generation.maximumGpuSeconds) {
        throw new Error("GPU generation must declare maximumGpuSeconds")
      }
      if ((plan.generation.maximumGpuSeconds ?? 0) > plan.maximumGpuSeconds) {
        throw new Error("Generation GPU budget exceeds the workflow budget")
      }
      generation = {
        mode: "proto_program",
        generators: selected.map((generator) => {
          const allocation = plan.generation!.allocations?.find((item) => item.generator === generator.key)
          return {
            id: generator.key,
            version: raw.protoLanguageCommit,
            toolsCalled: generator.toolsCalled,
            ...(plan.nativeSearch ? {} : {allocation: allocation
              ? {
                  maximumCandidates: allocation.maximumCandidates,
                  maximumGpuSeconds: allocation.maximumGpuSeconds,
                }
              : {
                  maximumCandidates: plan.generation!.maximumCandidates,
                  maximumGpuSeconds: plan.generation!.maximumGpuSeconds!,
                }}),
          }
        }),
        budget: {
          maximumCandidates: plan.generation.maximumCandidates,
          maximumGpuSeconds: plan.generation.maximumGpuSeconds,
        },
      }
    }
    const declaredGpuSeconds = (plan.generation?.maximumGpuSeconds ?? 0) + plan.stages.reduce((total, stage) => total + (stage.maximumGpuSeconds ?? 0), 0)
    if (declaredGpuSeconds > plan.maximumGpuSeconds) {
      throw new Error(`Workflow stages request ${declaredGpuSeconds} GPU seconds; workflow permits ${plan.maximumGpuSeconds}`)
    }
    const ordered = topological(plan.stages)
    if (!ordered) throw new Error("Workflow dependencies must be acyclic")
    const stages = ordered.map((stage) => {
      if (!allowedCapabilities.has(stage.capability)) {
        throw new Error(`Trusted workflow capability is not installed: ${stage.capability}`)
      }
      const available = stage.tools.flatMap((key) => {
        const tool = tools.get(key)
        if (!tool) return []
        if (tool.category !== stage.capability) {
          throw new Error(`Proto tool ${key} provides ${tool.category}, not ${stage.capability}`)
        }
        return [tool]
      })
      const compatible = stage.inputRequirements && stage.selection === "first_available"
        ? available.filter(tool => ProtoModelRegistry.issues(tool.modelCard, stage.inputRequirements!).length === 0)
        : available
      const selected = stage.selection === "first_available" ? compatible.slice(0, 1) : compatible
      if (stage.inputRequirements) {
        if (available.length && !selected.length) throw new Error(`Workflow stage ${stage.id} has no Proto adapter preserving required inputs: ${stage.inputRequirements.features.join(", ")}`)
        for (const tool of selected) ProtoModelRegistry.assertCompatible(tool.modelCard, stage.inputRequirements, tool.key)
      }
      if (selected.length === 0 && !stage.optional) {
        throw new Error(`Workflow stage ${stage.id} has no available Proto tool`)
      }
      for (const tool of selected) {
        if (implicitRemoteMsaTools.has(tool.key) && stage.configs[tool.key]?.use_msa !== false) {
          throw new Error(
            `Proto tool ${tool.key} must set use_msa=false until the workflow supplies a frozen MSA artifact; ` +
            "implicit remote MMseqs2 searches are mutable, unbounded external evidence",
          )
        }
      }
      if (stage.maximumCandidates && stage.maximumCandidates > raw.contract.budget.maximumCandidates) {
        throw new Error(
          `Workflow stage ${stage.id} requests ${stage.maximumCandidates} candidates; experiment permits ${raw.contract.budget.maximumCandidates}`,
        )
      }
      if (stage.maximumCandidates && !stage.candidateRouting && stage.maximumCandidates < raw.contract.evaluator.submissionSize) {
        throw new Error(
          `Workflow stage ${stage.id} permits ${stage.maximumCandidates} candidates; trusted evaluation requires ${raw.contract.evaluator.submissionSize}`,
        )
      }
      if (selected.some((tool) => tool.usesGpu) && (stage.maximumGpuSeconds ?? 0) === 0) {
        throw new Error(`GPU workflow stage ${stage.id} must declare maximumGpuSeconds`)
      }
      if (stage.candidateRouting && stage.candidateRouting.maximumCandidates > raw.contract.budget.maximumCandidates) {
        throw new Error(`Workflow route ${stage.id} exceeds the experiment candidate budget`)
      }
      const allowedSkips = [
        ...(stage.condition ? ["condition_false" as const] : []),
        ...(stage.candidateRouting ? ["candidate_filtered" as const] : []),
        ...(stage.optional ? ["optional_tool_failure" as const] : []),
      ]
      return {
        id: stage.id,
        role: stage.role ?? "scoring",
        ...(stage.inputRequirements ? {inputRequirements: stage.inputRequirements} : {}),
        models: selected.map((tool) => ({
          id: tool.key,
          toolKey: tool.key,
          version: raw.protoToolsCommit,
          config: stage.configs[tool.key],
        })),
        dependsOn: stage.dependsOn,
        condition: stage.condition,
        candidateRouting: stage.candidateRouting,
        budget:
          stage.maximumCandidates || stage.maximumGpuSeconds
            ? { maximumCandidates: stage.maximumCandidates, maximumGpuSeconds: stage.maximumGpuSeconds }
            : undefined,
        required: allowedSkips.length === 0,
        allowSkip: allowedSkips.length > 0,
        allowedSkips,
      }
    })
    if (stages.some((stage) => stage.models.length === 0)) {
      throw new Error("Optional stages with no available tools must be removed before freezing")
    }
    // New native policies reserve actual model × output candidate × fixed seed
    // requests. Historical plans retain their original frozen scalar semantics.
    const invocationReservations=plan.nativeSearch?stages.map(stage=>{
      const maximumCandidates=plan.nativeSearch!.budget.maximumCandidates
      const seedCount=raw.contract.evaluator.fixedSeeds?.length??1,modelCount=stage.models.length
      const maximumRequests=maximumCandidates*seedCount*modelCount
      const perRequestTimeoutSeconds=stage.budget?.maximumGpuSeconds
      if(typeof perRequestTimeoutSeconds!=="number" || !Number.isFinite(perRequestTimeoutSeconds) || perRequestTimeoutSeconds<=0)
        throw new Error(`Fresh native model stage ${stage.id} requires an explicit positive wall-time deadline for truthful invocation reservations`)
      return {stageId:stage.id,maximumCandidates,seedCount,modelCount,maximumRequests,
        perRequestTimeoutSeconds,reservedWallSeconds:maximumRequests*perRequestTimeoutSeconds}
    }):undefined
    const reservedEvidenceWallSeconds=invocationReservations?.reduce((sum,item)=>sum+item.reservedWallSeconds,0)
    if(plan.nativeSearch&&plan.nativeSearch.budget.maximumWallSeconds+(reservedEvidenceWallSeconds??0)>plan.maximumGpuSeconds)
      throw new Error("Native model/candidate/seed invocation reservations exceed the aggregate worker wall-time budget")
    const pipeline = ExecutionProtocol.PipelinePolicy.parse({
      id: plan.id,
      ...(raw.bindSource === false ? {} : { sourceHash: hash(plan) }),
      protoToolsCommit: raw.protoToolsCommit,
      generation,
      nativeSearch: plan.nativeSearch,
      executionBudget: plan.maximumGpuSeconds > 0
        ? {
            semantics: "aggregate_worker_gpu_wall_v1",
            maximumGpuSeconds: plan.maximumGpuSeconds,
            ...(invocationReservations?{unit:"wall_seconds",reservationSemantics:"per_model_candidate_seed_timeout_upper_bound_v1",
              reservedEvidenceWallSeconds,invocationReservations}:{}),
          }
        : undefined,
      staticConstruction: plan.staticConstruction,
      authoredDiagnostics: plan.stages
        .filter((stage) => stage.role === "diagnostic")
        .map((stage) => ({
          id: stage.id,
          role: "diagnostic",
          capability: stage.capability,
          ...(stage.inputRequirements ? {inputRequirements: stage.inputRequirements} : {}),
          tools: stage.tools,
          configs: stage.configs,
          selection: stage.selection,
          dependsOn: stage.dependsOn,
          ...(stage.condition ? { condition: stage.condition } : {}),
          ...(stage.candidateRouting ? { candidateRouting: stage.candidateRouting } : {}),
          ...(stage.maximumCandidates ? { maximumCandidates: stage.maximumCandidates } : {}),
          ...(stage.maximumGpuSeconds ? { maximumGpuSeconds: stage.maximumGpuSeconds } : {}),
          optional: stage.optional,
        })),
      stages,
    })
    const frozenScoringHash = raw.contract.evaluator.evidenceAdapter?.scoringPipelineHash
    if (frozenScoringHash) {
      const scoringIds = new Set(pipeline.stages.filter((stage) => stage.role === "scoring").map((stage) => stage.id))
      if (scoringIds.size === 0) throw new Error("Frozen experiments require at least one scoring stage")
      for (const stage of pipeline.stages.filter((item) => item.role === "scoring")) {
        if (!stage.required || stage.allowSkip || stage.condition || stage.candidateRouting) {
          throw new Error(
            `Scoring stage ${stage.id} must evaluate every submitted candidate without routing, conditions, or optional skips`,
          )
        }
        if (stage.dependsOn.some((dependency) => !scoringIds.has(dependency))) {
          throw new Error(`Scoring stage ${stage.id} cannot depend on an agent-mutable diagnostic stage`)
        }
      }
      const observed = scoringPipelineHash(pipeline)
      if (observed !== frozenScoringHash) {
        throw new Error(`Authored scoring pipeline changed: expected ${frozenScoringHash}, received ${observed}`)
      }
    }
    return pipeline
  }

  export function scoringPipelineHash(raw: ExecutionProtocol.PipelinePolicy): string {
    return ExecutionProtocol.hashScoringPipeline(scoringPipeline(raw))
  }

  export function scoringPipeline(raw: ExecutionProtocol.PipelinePolicy): ExecutionProtocol.ScoringPipeline {
    const pipeline = ExecutionProtocol.PipelinePolicy.parse(raw)
    return ExecutionProtocol.ScoringPipeline.parse({
      format: "autofold.scoring-pipeline.v1",
      protoToolsCommit: pipeline.protoToolsCommit,
      stages: pipeline.stages.filter((stage) => stage.role === "scoring"),
    })
  }

  export function hash(value: Plan): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(Plan.parse(value)))).digest("hex")}`
  }

  function topological<T extends { id: string; dependsOn: string[] }>(stages: T[]): T[] | undefined {
    const remaining = new Map(stages.map((stage, index) => [stage.id, { stage, index }]))
    const emitted = new Set<string>()
    const ordered: T[] = []
    while (remaining.size) {
      const ready = [...remaining.values()]
        .filter(({ stage }) => stage.dependsOn.every((dependency) => emitted.has(dependency)))
        .toSorted((left, right) => left.index - right.index)
      if (!ready.length) return undefined
      for (const { stage } of ready) {
        ordered.push(stage)
        emitted.add(stage.id)
        remaining.delete(stage.id)
      }
    }
    return ordered
  }


}
