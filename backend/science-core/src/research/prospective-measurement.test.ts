import { describe, expect, test } from "bun:test"
import { ExecutionProtocol } from "./execution-protocol"
import { ProspectiveMeasurement } from "./prospective-measurement"
import { ResearchWorkflow } from "./workflow"

const pipeline = ExecutionProtocol.PipelinePolicy.parse({
  id: "paired-chai-diagnostic",
  stages: [
    {
      id: "chai1-score",
      role: "scoring",
      models: [{ id: "chai1-prediction", toolKey: "chai1-prediction", version: "a".repeat(40) }],
      required: true,
      allowSkip: false,
    },
    {
      id: "chai1-no-esm-diagnostic",
      role: "diagnostic",
      models: [{ id: "chai1-prediction", toolKey: "chai1-prediction", version: "a".repeat(40) }],
      required: true,
      allowSkip: false,
    },
  ],
})

const tools: ResearchWorkflow.Tool[] = [{
  key: "chai1-prediction",
  category: "structure_prediction",
  usesGpu: true,
  numericMetrics: ["avg_pae", "avg_plddt", "confidence_score", "iptm", "ptm"],
}]

const measurement = {
  modelId: "chai1-prediction",
  leftStage: "chai1-score",
  rightStage: "chai1-no-esm-diagnostic",
  metric: "confidence_score",
  relation: "less" as const,
  threshold: 0.05,
}

describe("prospective measurement preflight", () => {
  test("accepts an optional omission and a registered numeric metric across paired stages", () => {
    expect(ProspectiveMeasurement.validate(undefined, pipeline, tools)).toBeUndefined()
    expect(ProspectiveMeasurement.validate(measurement, pipeline, tools)).toBeUndefined()
  })

  test("rejects stage, model, metric, and self-comparison mistakes with compiled alternatives", () => {
    expect(() => ProspectiveMeasurement.validate({ ...measurement, leftStage: "chai1-prediction" }, pipeline, tools))
      .toThrow('leftStage "chai1-prediction" is not in the compiled workflow. Available stages: chai1-score, chai1-no-esm-diagnostic')
    expect(() => ProspectiveMeasurement.validate({ ...measurement, rightStage: "missing-rescue" }, pipeline, tools))
      .toThrow('rightStage "missing-rescue" is not in the compiled workflow. Available stages: chai1-score, chai1-no-esm-diagnostic')
    expect(() => ProspectiveMeasurement.validate({ ...measurement, modelId: "chai1-score" }, pipeline, tools))
      .toThrow('model "chai1-score" is not executed by leftStage "chai1-score"')
    expect(() => ProspectiveMeasurement.validate({ ...measurement, metric: "native-metric" }, pipeline, tools))
      .toThrow('metric "native-metric" is not a registered numeric metric')
    expect(() => ProspectiveMeasurement.validate({ ...measurement, rightStage: "chai1-score" }, pipeline, tools))
      .toThrow("must compare two distinct workflow stages")
  })
})
