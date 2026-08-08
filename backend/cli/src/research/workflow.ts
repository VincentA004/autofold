import z from "zod"
import { ResearchDomain } from "./domain"
import { ExecutionProtocol } from "./execution-protocol"

const stageId = z.string().regex(/^[a-z][a-z0-9_-]*$/)
const toolKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export namespace ResearchWorkflow {
  export const Condition = z.object({
    source: stageId,
    metric: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    operator: z.enum(["lt", "lte", "gt", "gte"]),
    value: z.number().finite(),
  })
  export const CandidateRouting = ExecutionProtocol.CandidateRouting

  export const Plan = z
    .object({
      format: z.literal("autofold.proto-workflow.v1"),
      id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      maximumGpuSeconds: z.number().finite().nonnegative(),
      generation: z.object({
        generators: z.array(toolKey).min(1).max(8),
        maximumCandidates: z.number().int().positive(),
        maximumGpuSeconds: z.number().finite().positive().optional(),
      }).optional(),
      stages: z
        .array(
          z.object({
            id: stageId,
            capability: z.string().trim().min(1),
            tools: z.array(toolKey).min(1).max(8),
            configs: z.record(toolKey, z.record(z.string(), z.unknown())).default({}),
            selection: z.enum(["all", "first_available"]).default("all"),
            dependsOn: z.array(stageId).default([]),
            condition: Condition.optional(),
            candidateRouting: CandidateRouting.optional(),
            maximumCandidates: z.number().int().positive().optional(),
            maximumGpuSeconds: z.number().finite().positive().optional(),
            optional: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(64),
    })
    .superRefine((plan, context) => {
      if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 256 * 1024) {
        context.addIssue({ code: "custom", path: [], message: "Workflow manifest is too large" })
      }
      if (plan.generation && new Set(plan.generation.generators).size !== plan.generation.generators.length) {
        context.addIssue({ code: "custom", path: ["generation", "generators"], message: "Generation tools must be unique" })
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

  export const Tool = z.object({
    key: toolKey,
    category: z.string().trim().min(1),
    usesGpu: z.boolean(),
  })
  export type Tool = z.infer<typeof Tool>
  export const Generator = z.object({
    key: toolKey,
    usesGpu: z.boolean(),
    toolsCalled: z.array(toolKey),
  })
  export type Generator = z.infer<typeof Generator>

  export interface CompileInput {
    plan: z.input<typeof Plan>
    tools: Tool[]
    generators?: Generator[]
    contract: {
      budget: ResearchDomain.ExperimentContract["budget"]
      evaluator: Pick<ResearchDomain.ExperimentContract["evaluator"], "submissionSize">
    }
    protoToolsCommit: string
    protoLanguageCommit: string
    allowedCapabilities?: string[]
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
        generators: selected.map((generator) => ({
          id: generator.key,
          version: raw.protoLanguageCommit,
          toolsCalled: generator.toolsCalled,
        })),
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
      const selected = stage.selection === "first_available" ? available.slice(0, 1) : available
      if (selected.length === 0 && !stage.optional) {
        throw new Error(`Workflow stage ${stage.id} has no available Proto tool`)
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
    return ExecutionProtocol.PipelinePolicy.parse({
      id: plan.id,
      sourceHash: hash(plan),
      protoToolsCommit: raw.protoToolsCommit,
      generation,
      stages,
    })
  }

  export function hash(value: Plan): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(Plan.parse(value)))).digest("hex")}`
  }

  export async function extract(programPath: string, python: string): Promise<Plan | undefined> {
    const source = String.raw`
import ast, json, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])
matches = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign)) and any(
    isinstance(target, ast.Name) and target.id == "AUTOFOLD_WORKFLOW"
    for target in ((node.targets if isinstance(node, ast.Assign) else [node.target]))
)]
if not matches:
    raise SystemExit(3)
if len(matches) != 1:
    raise SystemExit("AUTOFOLD_WORKFLOW must be assigned exactly once")
print(json.dumps(ast.literal_eval(matches[0].value)))
`
    const process = Bun.spawn([python, "-c", source, programPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if (code === 3) return undefined
    if (code !== 0) throw new Error((stderr || stdout).trim() || "Cannot extract AUTOFOLD_WORKFLOW")
    return Plan.parse(JSON.parse(stdout))
  }

  export async function discover(python: string, cwd: string): Promise<Tool[]> {
    const source = String.raw`
import json
import proto_tools
from proto_tools import ToolRegistry
print(json.dumps([
    {"key": spec.key, "category": spec.category, "usesGpu": spec.uses_gpu}
    for spec in ToolRegistry.list_all()
]))
`
    const process = Bun.spawn([python, "-c", source], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if (code !== 0) throw new Error((stderr || stdout).trim() || "Cannot discover pinned Proto tools")
    return z.array(Tool).parse(JSON.parse(stdout))
  }

  export async function discoverGenerators(python: string, cwd: string): Promise<Generator[]> {
    const source = String.raw`
import json
from proto_language.generator import GeneratorRegistry
print(json.dumps([
    {"key": spec.key, "usesGpu": spec.uses_gpu, "toolsCalled": spec.tools_called}
    for spec in GeneratorRegistry.list_all()
]))
`
    const process = Bun.spawn([python, "-c", source], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if (code !== 0) throw new Error((stderr || stdout).trim() || "Cannot discover pinned Proto generators")
    return z.array(Generator).parse(JSON.parse(stdout))
  }

  export async function validateConfigs(raw: Plan, python: string, cwd: string): Promise<void> {
    const plan = Plan.parse(raw)
    const source = String.raw`
import json, sys
import proto_tools
from proto_tools import ToolRegistry
workflow = json.load(sys.stdin)
for stage in workflow["stages"]:
    for key, config in stage.get("configs", {}).items():
        ToolRegistry.get(key).config_model(**config)
`
    const process = Bun.spawn([python, "-c", source], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    process.stdin.write(JSON.stringify(plan))
    process.stdin.end()
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if (code !== 0) throw new Error((stderr || stdout).trim() || "Proto tool configuration is invalid")
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

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return value
  }
}
