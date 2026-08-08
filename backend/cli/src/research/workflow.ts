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

  export const Plan = z
    .object({
      format: z.literal("autofold.proto-workflow.v1"),
      id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      maximumGpuSeconds: z.number().finite().nonnegative(),
      stages: z
        .array(
          z.object({
            id: stageId,
            capability: z.string().trim().min(1),
            tools: z.array(toolKey).min(1).max(8),
            selection: z.enum(["all", "first_available"]).default("all"),
            dependsOn: z.array(stageId).default([]),
            condition: Condition.optional(),
            maximumCandidates: z.number().int().positive().optional(),
            maximumGpuSeconds: z.number().finite().positive().optional(),
            optional: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(64),
    })
    .superRefine((plan, context) => {
      const ids = new Set(plan.stages.map((stage) => stage.id))
      if (ids.size !== plan.stages.length) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Workflow stage IDs must be unique" })
      }
      for (const [index, stage] of plan.stages.entries()) {
        if (new Set(stage.tools).size !== stage.tools.length) {
          context.addIssue({ code: "custom", path: ["stages", index, "tools"], message: "Workflow tools must be unique within a stage" })
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
        if (stage.condition && !stage.optional) {
          context.addIssue({ code: "custom", path: ["stages", index, "optional"], message: "Conditional workflow stages must be optional" })
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

  export interface CompileInput {
    plan: z.input<typeof Plan>
    tools: Tool[]
    contract: {
      budget: ResearchDomain.ExperimentContract["budget"]
      evaluator: Pick<ResearchDomain.ExperimentContract["evaluator"], "submissionSize">
    }
    protoToolsCommit: string
    allowedCapabilities?: string[]
  }

  export function compile(raw: CompileInput): ExecutionProtocol.PipelinePolicy {
    const plan = Plan.parse(raw.plan)
    const tools = new Map(z.array(Tool).parse(raw.tools).map((tool) => [tool.key, tool]))
    const allowedCapabilities = new Set(raw.allowedCapabilities ?? ["structure_prediction"])
    const maximumGpuSeconds = raw.contract.budget.gpuHours * 3_600
    if (plan.maximumGpuSeconds > maximumGpuSeconds) {
      throw new Error(`Workflow requests ${plan.maximumGpuSeconds} GPU seconds; experiment permits ${maximumGpuSeconds}`)
    }
    const declaredGpuSeconds = plan.stages.reduce((total, stage) => total + (stage.maximumGpuSeconds ?? 0), 0)
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
      if (stage.maximumCandidates && stage.maximumCandidates < raw.contract.evaluator.submissionSize) {
        throw new Error(
          `Workflow stage ${stage.id} permits ${stage.maximumCandidates} candidates; trusted evaluation requires ${raw.contract.evaluator.submissionSize}`,
        )
      }
      if (selected.some((tool) => tool.usesGpu) && (stage.maximumGpuSeconds ?? 0) === 0) {
        throw new Error(`GPU workflow stage ${stage.id} must declare maximumGpuSeconds`)
      }
      return {
        id: stage.id,
        models: selected.map((tool) => ({ id: tool.key, toolKey: tool.key, version: raw.protoToolsCommit })),
        dependsOn: stage.dependsOn,
        condition: stage.condition,
        budget:
          stage.maximumCandidates || stage.maximumGpuSeconds
            ? { maximumCandidates: stage.maximumCandidates, maximumGpuSeconds: stage.maximumGpuSeconds }
            : undefined,
        required: !stage.optional,
        allowSkip: stage.optional,
      }
    })
    if (stages.some((stage) => stage.models.length === 0)) {
      throw new Error("Optional stages with no available tools must be removed before freezing")
    }
    return ExecutionProtocol.PipelinePolicy.parse({
      id: plan.id,
      sourceHash: hash(plan),
      protoToolsCommit: raw.protoToolsCommit,
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
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return value
  }
}
