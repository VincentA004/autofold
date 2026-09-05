import { describe, expect, test } from "bun:test"
import type { Tool } from "@/tool/tool"
import { ScientistTrialTool } from "./scientist-trial-tool"

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "msg_validator",
    agent: "autofold-proto-author",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

describe("persistent scientist trial validator", () => {
  test("returns trusted validation results only to the bound session", async () => {
    const sessionID = "ses_scientist"
    const release = ScientistTrialTool.bind(sessionID, async () => ({
      programFingerprint: `sha256:${"a".repeat(64)}`,
      semanticProgramFingerprint: `sha256:${"b".repeat(64)}`,
      workflowFingerprint: `sha256:${"c".repeat(64)}`,
      trialIntent: "optimize",
      generatorPortfolio: ["boltzgen-binder"],
      generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 1, maximumGpuSeconds: 300 }],
    }))
    try {
      const tool = await ScientistTrialTool.ToolInfo.init()
      const result = await tool.execute({}, context(sessionID))
      expect(JSON.parse(result.output)).toMatchObject({
        status: "valid",
        trialIntent: "optimize",
        generatorPortfolio: ["boltzgen-binder"],
      })
      const missing = await tool.execute({}, context("ses_other")).catch((error) => error)
      expect(missing).toBeInstanceOf(Error)
    } finally {
      release()
    }
  })

  test("returns a repairable compiler error instead of breaking the agent loop", async () => {
    const sessionID = "ses_repair"
    const release = ScientistTrialTool.bind(sessionID, async () => {
      throw new Error("Workflow requests 7201 GPU seconds; experiment permits 7200")
    })
    try {
      const tool = await ScientistTrialTool.ToolInfo.init()
      const result = await tool.execute({}, context(sessionID))
      expect(JSON.parse(result.output)).toEqual({
        status: "invalid",
        error: "Workflow requests 7201 GPU seconds; experiment permits 7200",
      })
    } finally {
      release()
    }
  })

  test("returns a locked empirical result to the same scientist session", async () => {
    const sessionID = "ses_evaluate"
    const release = ScientistTrialTool.bind(sessionID, {
      validate: async () => ({
        programFingerprint: `sha256:${"a".repeat(64)}`,
        semanticProgramFingerprint: `sha256:${"b".repeat(64)}`,
        workflowFingerprint: `sha256:${"c".repeat(64)}`,
        generatorPortfolio: ["boltzgen-binder"],
        generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 1, maximumGpuSeconds: 300 }],
      }),
      evaluate: async () => ({
        status: "succeeded",
        trialId: "trl_evaluated",
        runId: "run_evaluated",
        programHash: `sha256:${"d".repeat(64)}`,
        score: 0.21,
        valid: true,
        decision: "promoted",
      }),
    })
    try {
      const tool = await ScientistTrialTool.EvaluateToolInfo.init()
      const result = await tool.execute({}, context(sessionID))
      expect(JSON.parse(result.output)).toEqual({
        status: "succeeded",
        trialId: "trl_evaluated",
        runId: "run_evaluated",
        programHash: `sha256:${"d".repeat(64)}`,
        score: 0.21,
        valid: true,
        decision: "promoted",
      })
    } finally {
      release()
    }
  })

  test("returns a not-launched diagnostic without fabricating a run", async () => {
    const sessionID = "ses_readiness"
    const release = ScientistTrialTool.bind(sessionID, {
      validate: async () => {
        throw new Error("unused")
      },
      evaluate: async () => {
        throw new Error("Remote execution readiness failed for boltzgen-binder")
      },
    })
    try {
      const tool = await ScientistTrialTool.EvaluateToolInfo.init()
      const result = await tool.execute({}, context(sessionID))
      expect(JSON.parse(result.output)).toEqual({
        status: "not_launched",
        error: "Remote execution readiness failed for boltzgen-binder",
      })
    } finally {
      release()
    }
  })

  test("records an evidence-linked scientist stop without launching a trial", async () => {
    const sessionID = "ses_stop"
    let observed: ScientistTrialTool.StopDecision | undefined
    const release = ScientistTrialTool.bind(sessionID, {
      validate: async () => { throw new Error("unused") },
      stop: async (decision) => { observed = decision },
    })
    try {
      const tool = await ScientistTrialTool.StopToolInfo.init()
      const result = await tool.execute({
        reason: "improvement_plateau",
        rationale: "Four comparable optimize trials failed to improve the locked incumbent after all generator families were exercised.",
        evidenceRefs: ["trl_a", "evl_a", "trl_b", "evl_b"],
      }, context(sessionID))
      expect(JSON.parse(result.output)).toMatchObject({
        status: "stopped",
        reason: "improvement_plateau",
      })
      expect(observed?.evidenceRefs).toEqual(["trl_a", "evl_a", "trl_b", "evl_b"])
    } finally {
      release()
    }
  })
})
