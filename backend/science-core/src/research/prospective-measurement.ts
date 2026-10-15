import { ExecutionProtocol } from "./execution-protocol"
import { ResearchWorkflow } from "./workflow"
import { TrialReasoning } from "./trial-reasoning"

export namespace ProspectiveMeasurement {
  export function validate(
    measurement: TrialReasoning.DecisionPlan["measurement"],
    pipeline: ExecutionProtocol.PipelinePolicy,
    tools: ResearchWorkflow.Tool[],
  ): void {
    if (!measurement) return
    if (measurement.leftStage === measurement.rightStage) {
      throw new Error(
        `Prospective measurement must compare two distinct workflow stages; leftStage and rightStage are both "${measurement.leftStage}"`,
      )
    }

    const stages = new Map(pipeline.stages.map((stage) => [stage.id, stage]))
    const availableStages = [...stages.keys()].join(", ") || "none"
    const left = stages.get(measurement.leftStage)
    if (!left) {
      throw new Error(
        `Prospective measurement leftStage "${measurement.leftStage}" is not in the compiled workflow. Available stages: ${availableStages}`,
      )
    }
    const right = stages.get(measurement.rightStage)
    if (!right) {
      throw new Error(
        `Prospective measurement rightStage "${measurement.rightStage}" is not in the compiled workflow. Available stages: ${availableStages}`,
      )
    }

    const selectedModel = (side: "leftStage" | "rightStage", stage: typeof left) => {
      const model = stage.models.find((candidate) => candidate.id === measurement.modelId)
      if (model) return model
      const availableModels = stage.models.map((candidate) => candidate.id).join(", ") || "none"
      throw new Error(
        `Prospective measurement model "${measurement.modelId}" is not executed by ${side} "${stage.id}". ` +
        `Available models for that stage: ${availableModels}`,
      )
    }
    const leftModel = selectedModel("leftStage", left)
    const rightModel = selectedModel("rightStage", right)
    const capabilities = new Map(tools.map((tool) => [tool.key, tool]))
    const numericMetrics = (model: typeof leftModel) =>
      new Set(capabilities.get(model.toolKey ?? model.id)?.numericMetrics ?? [])
    const leftMetrics = numericMetrics(leftModel)
    const rightMetrics = numericMetrics(rightModel)
    const pairedMetrics = [...leftMetrics].filter((metric) => rightMetrics.has(metric)).sort()
    if (!pairedMetrics.includes(measurement.metric)) {
      throw new Error(
        `Prospective measurement metric "${measurement.metric}" is not a registered numeric metric for model ` +
        `"${measurement.modelId}" in both selected stages. Available paired numeric metrics: ${pairedMetrics.join(", ") || "none"}`,
      )
    }
  }
}
