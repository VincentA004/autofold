import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { confinedPath } from "../util/confinement"

/**
 * Experiment-local projection of the persistent scientist session and latest
 * lifecycle phase. Durable job checkpoints remain the recovery/effect owner;
 * this file is never sufficient to replay a proposal or remote execution.
 */
export namespace ResearchScientistKernel {
  const Common = z.object({
    format: z.literal("autofold.scientist-state.v2"),
    experimentId: z.string().startsWith("exp_"),
    contractHash: z.string().startsWith("sha256:"),
    sessionId: z.string().startsWith("ses_"),
    iteration: z.number().int().positive(),
    mutableTrialPath: z.string().trim().min(1),
    memoryRevision: z.string().startsWith("sha256:"),
    updatedAt: z.string().datetime(),
  })

  export const State = z.discriminatedUnion("phase", [
    Common.extend({ phase: z.literal("authoring") }),
    Common.extend({
      phase: z.literal("evaluation_pending"),
      programFingerprint: z.string().startsWith("sha256:"),
      semanticProgramFingerprint: z.string().startsWith("sha256:"),
      workflowFingerprint: z.string().startsWith("sha256:"),
    }),
    Common.extend({
      phase: z.literal("result_available"),
      status: z.enum(["succeeded", "run_failed"]),
      trialId: z.string().startsWith("trl_").optional(),
      runId: z.string().startsWith("run_").optional(),
      score: z.number().finite().nullable().optional(),
      error: z.string().optional(),
    }),
    Common.extend({
      phase: z.literal("stopped"),
      reason: z.string().trim().min(1),
      rationale: z.string().trim().min(1),
      evidenceRefs: z.array(z.string().trim().min(1)).max(100),
    }),
    Common.extend({
      phase: z.literal("finished"),
      reason: z.enum(["iteration_limit_reached", "knowledge_refresh", "skill_refinement"]),
      completedEvaluations: z.number().int().nonnegative(),
    }),
  ])
  export type State = z.infer<typeof State>
  export type StateUpdate =
    | { phase: "authoring" }
    | {
        phase: "evaluation_pending"
        programFingerprint: string
        semanticProgramFingerprint: string
        workflowFingerprint: string
      }
    | {
        phase: "result_available"
        status: "succeeded" | "run_failed"
        trialId?: string
        runId?: string
        score?: number | null
        error?: string
      }
    | { phase: "stopped"; reason: string; rationale: string; evidenceRefs: string[] }
    | { phase: "finished"; reason: "iteration_limit_reached" | "knowledge_refresh" | "skill_refinement"; completedEvaluations: number }

  export const LegacyState = z.object({
    format: z.literal("autofold.experiment-scientist.v1"),
    experimentId: z.string().startsWith("exp_"),
    contractHash: z.string().startsWith("sha256:"),
    sessionId: z.string().startsWith("ses_"),
  })

  export async function read(directory: string, relative: string): Promise<State | z.infer<typeof LegacyState> | undefined> {
    try {
      const file = await confinedPath(directory, relative)
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      return value?.format === "autofold.experiment-scientist.v1" ? LegacyState.parse(value) : State.parse(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  export async function write(directory: string, relative: string, raw: z.input<typeof State>): Promise<State> {
    const state = State.parse(raw)
    let file = await confinedPath(directory, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    file = await confinedPath(directory, relative)
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, file)
    return state
  }
}
