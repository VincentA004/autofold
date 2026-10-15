/** Historical authoring-plan adapters. Fresh execution uses compileNative and
 * never reconstructs these plans during original-effect receipt recovery. */
import {ResearchWorkflow} from '../workflow'
import {ExecutionProtocol} from '../execution-protocol'
import type {ResearchDomain} from '../domain'
export namespace HistoricalWorkflow {
  export function fromComposite(input: {
    id?: string
    generation?: ResearchWorkflow.ProgramGeneration
    staticConstruction?: ExecutionProtocol.StaticConstruction
    diagnostics?: unknown[]
    contract: ResearchWorkflow.CompileInput["contract"] & { budget: ResearchDomain.ExperimentContract["budget"] }
  }): ResearchWorkflow.Plan {
    const generation = input.generation ? ResearchWorkflow.ProgramGeneration.parse(input.generation) : undefined
    const scoring = input.contract.evaluator.evidenceAdapter?.scoringPipeline
    return ResearchWorkflow.Plan.parse({
      format: "autofold.proto-workflow.v1",
      id: input.id ?? (generation ? "direct-proto-composite" : "direct-proto-fixed-panel"),
      maximumGpuSeconds: input.contract.budget.gpuHours * 3_600,
      generation,
      staticConstruction: input.staticConstruction,
      stages: [
        ...(input.diagnostics ?? []).map((stage) => ({
          ...(stage as Record<string, unknown>),
          role: "diagnostic" as const,
        })),
        ...(scoring?.stages.map((stage) => ({
        id: stage.id,
        role: "scoring" as const,
        capability: "structure_prediction",
        tools: stage.models.map((model) => model.toolKey ?? model.id),
        configs: Object.fromEntries(stage.models.map((model) => [model.toolKey ?? model.id, model.config ?? {}])),
        dependsOn: stage.dependsOn,
        maximumCandidates: stage.budget?.maximumCandidates,
        maximumGpuSeconds: stage.budget?.maximumGpuSeconds,
        optional: false,
        })) ?? []),
      ],
    })
  }

  /** Derive the compiler-owned workflow for a directly authored ProtoTrial. */
  export function fromAuthoredTrial(input: {
    trial: Pick<ResearchWorkflow.AuthoredTrial, "generation" | "program" | "staticConstruction" | "nativeSearch">
    intent: "optimize" | "calibrate" | "negative_control" | "shadow_replay"
    diagnostics?: unknown[]
    contract: ResearchWorkflow.CompileInput["contract"] & { budget: ResearchDomain.ExperimentContract["budget"] }
  }): ResearchWorkflow.Plan | undefined {
    if (input.trial.nativeSearch) {
      if (["calibrate", "negative_control"].includes(input.intent)) throw new Error("Fixed controls cannot declare mutable native search")
      const nativeSearch = ExecutionProtocol.NativeSearch.parse(input.trial.nativeSearch)
      const generators = [...new Set(nativeSearch.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators.map(g => g.key))))]
      return ResearchWorkflow.Plan.parse({...fromComposite({diagnostics: input.diagnostics, contract: input.contract}),
        id: "native-proto-search", nativeSearch,
        ...(generators.length ? {generation: {generators, maximumCandidates: nativeSearch.budget.maximumCandidates,
          maximumGpuSeconds: nativeSearch.budget.maximumWallSeconds}} : {})})
    }
    if (input.trial.generation) {
      return fromComposite({ generation: input.trial.generation, diagnostics: input.diagnostics, contract: input.contract })
    }
    if (!["calibrate", "negative_control"].includes(input.intent)) return undefined
    ResearchWorkflow.validateFixedProgram(input.trial, input.intent, input.contract)
    return fromComposite({
      diagnostics: input.diagnostics,
      contract: input.contract,
      staticConstruction: input.trial.staticConstruction ?? ExecutionProtocol.StaticConstruction.parse({
        format: "autofold.static-construction.v1",
        ...input.trial.program,
      }),
    })
  }

}
