import z from "zod"
import { Tool } from "@/tool/tool"

/**
 * Session-scoped bridge from the generic agent loop to Autofold's trusted
 * trial validator. The model can request validation, but cannot replace the
 * handler, select another experiment, or author the returned fingerprints.
 */
export namespace ScientistTrialTool {
  export const StopReason = z.enum([
    "improvement_plateau",
    "repeated_equivalent_proposal",
    "insufficient_evidence",
    "breakthrough",
    "approval_required_contract_change",
    "campaign_stop_recommended",
  ])

  export const StopDecision = z.object({
    reason: StopReason,
    rationale: z.string().trim().min(1).max(2_000),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  })
  export type StopDecision = z.infer<typeof StopDecision>

  export interface Result {
    programFingerprint: string
    semanticProgramFingerprint: string
    workflowFingerprint: string
    trialIntent?: string
    calibrationClass?: string
    calibrationReplicateOfTrialId?: string
    generatorPortfolio: string[]
    generatorAllocations: Array<{
      generator: string
      maximumCandidates: number
      maximumGpuSeconds: number
    }>
  }

  export interface EvaluationResult {
    status: "succeeded" | "run_failed"
    trialId?: string
    runId?: string
    programHash?: string
    score?: number | null
    valid?: boolean
    decision?: "promoted" | "rejected"
    evidenceCompleteness?: unknown
    predictorDisagreement?: unknown
    candidateSummaries?: unknown[]
    generationReplicate?: unknown
    generatorDiagnostics?: unknown[]
    modelEvidence?: unknown[]
    generatorEvidence?: unknown[]
    priorBestScore?: number | null
    scoreDeltaFromPriorBest?: number | null
    resultPath?: string
    error?: string
  }

  interface Handlers {
    validate(): Promise<Result>
    evaluate?: () => Promise<EvaluationResult>
    stop?: (decision: StopDecision) => Promise<void> | void
  }

  const handlers = new Map<string, Handlers>()

  export function bind(sessionId: string, handler: (() => Promise<Result>) | Handlers): () => void {
    if (handlers.has(sessionId)) throw new Error(`Scientist validator is already bound for ${sessionId}`)
    const bound = typeof handler === "function" ? { validate: handler } : handler
    handlers.set(sessionId, bound)
    return () => {
      if (handlers.get(sessionId) === bound) handlers.delete(sessionId)
    }
  }

  export const ToolInfo = Tool.define("autofold_validate_trial", {
    description:
      "Validate the current mutable Autofold trial.py against its frozen experiment contract and the installed Proto registry. Returns trusted fingerprints, authored trial intent, portfolio, and allocations, or the exact repairable compiler error. Call after editing and before finishing the scientist turn.",
    parameters: z.object({}),
    async execute(_params, context) {
      await context.ask({
        permission: "autofold_validate_trial",
        patterns: [context.sessionID],
        always: [context.sessionID],
        metadata: {},
      })
      const handler = handlers.get(context.sessionID)
      if (!handler) throw new Error("No active Autofold trial validator is bound to this session")
      try {
        const result = await handler.validate()
        return {
          title: "Trial is valid",
          output: JSON.stringify({ status: "valid", ...result }),
          metadata: { valid: true },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          title: "Trial needs repair",
          output: JSON.stringify({ status: "invalid", error: message }),
          metadata: { valid: false },
        }
      }
    },
  })

  export const EvaluateToolInfo = Tool.define("autofold_evaluate_trial", {
    description:
      "Evaluate the current mutable Autofold trial.py through the trusted frozen experiment boundary. This validates and snapshots the exact source, launches or resumes the authorized compute run, applies the locked evaluator and promotion rule, publishes trusted evidence, and returns the empirical result or exact execution failure to this same scientist session.",
    parameters: z.object({}),
    async execute(_params, context) {
      await context.ask({
        permission: "autofold_evaluate_trial",
        patterns: [context.sessionID],
        always: [context.sessionID],
        metadata: {},
      })
      const handler = handlers.get(context.sessionID)
      if (!handler?.evaluate) throw new Error("No active Autofold trial evaluator is bound to this session")
      try {
        const result = await handler.evaluate()
        return {
          title: result.status === "succeeded" ? "Trial evaluated" : "Trial execution failed",
          output: JSON.stringify(result),
          metadata: { status: result.status as string, runId: result.runId as string | undefined },
        }
      } catch (error) {
        // Checkpoint and durable-state failures are not scientific feedback and
        // must escape to the job runner for exact-once recovery.
        if (error instanceof Error && error.name === "LifecycleHookError") throw error
        const message = error instanceof Error ? error.message : String(error)
        return {
          title: "Trial was not launched",
          output: JSON.stringify({ status: "not_launched", error: message }),
          metadata: { status: "not_launched" as string, runId: undefined as string | undefined },
        }
      }
    },
  })

  export const StopToolInfo = Tool.define("autofold_stop_discovery", {
    description:
      "Stop the current frozen-contract discovery loop without launching a trial. Use only when the persisted evidence supports a named scientific stopping condition, or when the next useful test requires a campaign-level contract change. Supply an auditable rationale and persisted evidence IDs.",
    parameters: StopDecision,
    async execute(params, context) {
      await context.ask({
        permission: "autofold_stop_discovery",
        patterns: [context.sessionID],
        always: [context.sessionID],
        metadata: {},
      })
      const handler = handlers.get(context.sessionID)
      if (!handler?.stop) throw new Error("No active Autofold discovery stop handler is bound to this session")
      const decision = StopDecision.parse(params)
      await handler.stop(decision)
      return {
        title: "Discovery loop stopped",
        output: JSON.stringify({ status: "stopped", ...decision }),
        metadata: { status: "stopped", reason: decision.reason },
      }
    },
  })
}
