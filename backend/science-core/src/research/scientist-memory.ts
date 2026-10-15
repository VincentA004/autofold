import { TrialReasoning } from "./trial-reasoning"
import { Lock } from "../util/lock"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"

/**
 * Canonical experiment-local memory for the persistent scientist.
 *
 * The JSONL event stream is authoritative and append-only. Markdown, OKF,
 * search landscapes, and compact prompt packets are projections over this
 * stream plus the immutable research database; they never replace an event.
 */
export namespace ResearchScientistMemory {
  const Allocation = z.object({
    generator: z.string().trim().min(1),
    maximumCandidates: z.number().int().positive(),
    maximumGpuSeconds: z.number().int().positive(),
  }).passthrough()

  export const TrajectoryEvent = z.object({
    format: z.literal("autofold.scientist-event.v1").default("autofold.scientist-event.v1"),
    recordedAt: z.string().datetime().default(() => new Date().toISOString()),
    campaignId: z.string().startsWith("cmp_").optional(),
    experimentId: z.string().startsWith("exp_"),
    contractHash: z.string().startsWith("sha256:"),
    iteration: z.number().int().positive(),
    intent: z.enum(["optimize", "calibrate", "negative_control", "shadow_replay"]).default("optimize"),
    status: z.enum(["succeeded", "run_failed"]),
    trialId: z.string().startsWith("trl_"),
    runId: z.string().startsWith("run_"),
    parentTrialId: z.string().startsWith("trl_").optional(),
    programHash: z.string().startsWith("sha256:").optional(),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    configurationFamilyFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    decisionPlan: TrialReasoning.DecisionPlan.optional(),
    prediction: TrialReasoning.Prediction.optional(),
    evidenceRefs: TrialReasoning.EvidenceRefs.optional(),
    hypothesis: z.string().trim().min(1).max(20_000).optional(),
    generatorPortfolio: z.array(z.string().trim().min(1)).max(30).default([]),
    generatorAllocations: z.array(Allocation).max(30).default([]),
    candidateSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100).default([]),
    modelIds: z.array(z.string().trim().min(1)).max(100).default([]),
    seeds: z.array(z.number().int()).max(100).default([]),
    valid: z.boolean().optional(),
    score: z.number().finite().nullable().optional(),
    priorBestScore: z.number().finite().nullable().optional(),
    decision: z.enum(["promoted", "rejected", "observed", "failed"]).optional(),
    diagnostics: z.record(z.string(), z.number().finite()).default({}),
    knowledgeCycleId: z.string().startsWith("kcy_").optional(),
    searchObservationIds: z.array(z.string().startsWith("sobs_")).max(100).default([]),
    error: z.string().max(20_000).optional(),
    supersedesEventHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  }).passthrough()
  export type TrajectoryEvent = z.infer<typeof TrajectoryEvent>
  export type TrajectoryEventInput = z.input<typeof TrajectoryEvent>

  export const Projection = z.object({
    format: z.literal("autofold.scientist-memory.v1"),
    revision: z.string().startsWith("sha256:"),
    eventCount: z.number().int().nonnegative(),
    latestRunId: z.string().startsWith("run_").optional(),
    frontier: z.object({
      direction: z.enum(["minimize", "maximize"]),
      bestScore: z.number().finite().nullable(),
      bestTrialId: z.string().startsWith("trl_").optional(),
      bestRunId: z.string().startsWith("run_").optional(),
      comparableOptimizeRuns: z.number().int().nonnegative(),
      consecutiveNonImprovingRuns: z.number().int().nonnegative(),
    }).passthrough(),
    generators: z.array(z.object({
      generator: z.string(),
      attempts: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      bestScore: z.number().finite().nullable(),
      runIds: z.array(z.string().startsWith("run_")),
    }).passthrough()),
    failures: z.array(z.object({
      signature: z.string(),
      count: z.number().int().positive(),
      runIds: z.array(z.string().startsWith("run_")),
    }).passthrough()),
    declaredHypotheses: z.array(z.object({
      trialId: z.string().startsWith("trl_"),
      runId: z.string().startsWith("run_"),
      statement: z.string(),
      outcome: z.enum(["promoted", "rejected", "observed", "failed", "unknown"]),
    }).passthrough()),
  }).passthrough()
  export type Projection = z.infer<typeof Projection>

  export function root(directory: string, experimentId: string): string {
    return path.join(directory, ".autofold", "autoresearch", z.string().startsWith("exp_").parse(experimentId))
  }

  export function eventLogPath(directory: string, experimentId: string): string {
    return path.join(root(directory, experimentId), "events.jsonl")
  }

  export function readableViewPath(directory: string, experimentId: string): string {
    return path.join(root(directory, experimentId), "EVENTS.md")
  }

  export async function read(directory: string, experimentId: string): Promise<TrajectoryEvent[]> {
    const file = eventLogPath(directory, experimentId)
    const contents = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return TrajectoryEvent.parse(JSON.parse(line))
        } catch (error) {
          throw new Error(`Invalid scientist memory event at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
  }

  export interface AppendResult {appended:boolean;projection:Projection;publication:{status:'published'|'pending';error?:string}}
  /** Regenerable Markdown is independent of the mandatory original journal. */
  export async function publishReadable(directory:string,experimentId:string,events?:TrajectoryEvent[]){
    const original=events??await read(directory,experimentId)
    try{await fs.writeFile(readableViewPath(directory,experimentId),render(original),{encoding:'utf8',mode:0o600});return {status:'published' as const}}
    catch(error){return {status:'pending' as const,error:error instanceof Error?error.message:String(error)}}
  }
  export async function append(
    raw: z.input<typeof TrajectoryEvent>,
    directory: string,
    direction: "minimize" | "maximize" = "minimize",
  ): Promise<AppendResult> {
    const event = TrajectoryEvent.parse(raw)
    if (event.supersedesEventHash) throw new Error("Use appendAmendment for a scientist memory supersession")
    return appendLocked(event, directory, false, direction)
  }

  /** Append a verified success which replaces one same-run failure in projections. */
  export async function appendAmendment(
    raw: z.input<typeof TrajectoryEvent>,
    supersedesEventHash: string,
    directory: string,
    direction: "minimize" | "maximize" = "minimize",
  ): Promise<AppendResult> {
    const parsedHash = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(supersedesEventHash)
    if (raw.supersedesEventHash && raw.supersedesEventHash !== parsedHash) {
      throw new Error("Scientist memory amendment has conflicting supersession hashes")
    }
    const event = TrajectoryEvent.parse({ ...raw, supersedesEventHash: parsedHash })
    if (event.status !== "succeeded" || event.decision === "failed" || event.error) {
      throw new Error("Scientist memory amendment must be a successful recovered run")
    }
    return appendLocked(event, directory, true, direction)
  }

  async function appendLocked(
    event: TrajectoryEvent,
    directory: string,
    amendment: boolean,
    direction: "minimize" | "maximize",
  ): Promise<AppendResult> {
    using _ = await Lock.write(`scientist-memory:${eventLogPath(directory, event.experimentId)}`)
    const existing = await read(directory, event.experimentId)
    const sameRun = existing.filter((item) => item.runId === event.runId)
    const duplicate = sameRun.find((item) => canonicalEvidence(item) === canonicalEvidence(event))
    if (duplicate) {
      return {appended:false,projection:project(existing,direction),publication:await publishReadable(directory,event.experimentId,existing)}
    }
    if (amendment) {
      const failure = sameRun.find((item) => item.status === "run_failed" && eventHash(item) === event.supersedesEventHash)
      if (!failure) throw new Error(`Scientist memory amendment for ${event.runId} does not supersede its recorded failure`)
      if (sameRun.some((item) => item.status === "succeeded")) {
        throw new Error(`Scientist memory run ${event.runId} already has authoritative success evidence`)
      }
      if (canonicalLineage(failure) !== canonicalLineage(event)) {
        throw new Error(`Scientist memory amendment for ${event.runId} does not match its recorded lineage`)
      }
    } else if (sameRun.length) {
      throw new Error(`Scientist memory run ${event.runId} already exists with different trusted evidence`)
    }
    if (existing.some((item) => item.contractHash !== event.contractHash)) {
      throw new Error(`Scientist memory contract changed inside experiment ${event.experimentId}`)
    }
    const directoryPath = root(directory, event.experimentId)
    await fs.mkdir(directoryPath, { recursive: true })
    const handle = await fs.open(eventLogPath(directory, event.experimentId), "a", 0o600)
    try {
      await handle.write(`${canonical(event)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const events = [...existing, event]
    return {appended:true,projection:project(events,direction),publication:await publishReadable(directory,event.experimentId,events)}
  }

  export function project(events: TrajectoryEvent[], direction: "minimize" | "maximize"): Projection {
    const ordered = events.toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt))
    const authoritative = authoritativeEvents(ordered)
    const comparable = authoritative.filter((event) =>
      event.intent === "optimize" && event.status === "succeeded" && event.valid !== false && event.score !== null && event.score !== undefined
    )
    let best: TrajectoryEvent | undefined
    let consecutiveNonImprovingRuns = 0
    for (const event of comparable) {
      const improves = !best || (direction === "minimize" ? event.score! < best.score! : event.score! > best.score!)
      if (improves) {
        best = event
        consecutiveNonImprovingRuns = 0
      } else {
        consecutiveNonImprovingRuns++
      }
    }
    const byGenerator = new Map<string, TrajectoryEvent[]>()
    for (const event of authoritative) {
      for (const generator of new Set(event.generatorPortfolio)) {
        const current = byGenerator.get(generator) ?? []
        current.push(event)
        byGenerator.set(generator, current)
      }
    }
    const failures = new Map<string, TrajectoryEvent[]>()
    for (const event of authoritative.filter((item) => item.status === "run_failed")) {
      const signature = failureSignature(event.error)
      const current = failures.get(signature) ?? []
      current.push(event)
      failures.set(signature, current)
    }
    return Projection.parse({
      format: "autofold.scientist-memory.v1",
      revision: digest(ordered.map(canonical).join("\n")),
      eventCount: authoritative.length,
      latestRunId: authoritative.at(-1)?.runId,
      frontier: {
        direction,
        bestScore: best?.score ?? null,
        bestTrialId: best?.trialId,
        bestRunId: best?.runId,
        comparableOptimizeRuns: comparable.length,
        consecutiveNonImprovingRuns,
      },
      generators: [...byGenerator.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([generator, items]) => {
          const scores = items
            .filter((item) => item.status === "succeeded" && item.valid !== false && item.score !== null && item.score !== undefined)
            .map((item) => item.score!)
          return {
            generator,
            attempts: items.length,
            succeeded: items.filter((item) => item.status === "succeeded").length,
            failed: items.filter((item) => item.status === "run_failed").length,
            bestScore: scores.length ? (direction === "minimize" ? Math.min(...scores) : Math.max(...scores)) : null,
            runIds: items.map((item) => item.runId),
          }
        }),
      failures: [...failures.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([signature, items]) => ({ signature, count: items.length, runIds: items.map((item) => item.runId) })),
      declaredHypotheses: authoritative
        .filter((event) => event.hypothesis)
        .map((event) => ({
          trialId: event.trialId,
          runId: event.runId,
          statement: event.hypothesis!,
          outcome: event.decision ?? (event.status === "run_failed" ? "failed" : "unknown"),
        })),
    })
  }

  function authoritativeEvents(ordered: readonly TrajectoryEvent[]) {
    const byRun = new Map<string, TrajectoryEvent[]>()
    for (const event of ordered) {
      const current = byRun.get(event.runId) ?? []
      current.push(event)
      byRun.set(event.runId, current)
    }
    return [...byRun.values()].map((events) => {
      if (events.length === 1) return events[0]!
      const success = events.filter((event) => event.status === "succeeded")
      const failure = events.filter((event) => event.status === "run_failed")
      if (
        events.length !== 2 || success.length !== 1 || failure.length !== 1 ||
        success[0]!.supersedesEventHash !== eventHash(failure[0]!) ||
        canonicalLineage(success[0]!) !== canonicalLineage(failure[0]!)
      ) {
        throw new Error(`Scientist memory run ${events[0]!.runId} has conflicting trusted events`)
      }
      return success[0]!
    }).toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt))
  }

  function failureSignature(error?: string): string {
    if (!error) return "Unclassified run failure"
    return error.split("\n").find((line) => line.trim().length > 0)?.trim().slice(0, 240) ?? "Unclassified run failure"
  }

  function render(events: TrajectoryEvent[]): string {
    const authoritative = authoritativeEvents(events.toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt)))
    const first = authoritative[0]
    const lines = [
      "# Autofold trusted trajectory events",
      "",
      ...(first ? [`Experiment: ${first.experimentId}`, `Contract: ${first.contractHash}`, ""] : []),
    ]
    for (const event of authoritative) {
      lines.push(
        `<!-- trusted-run:${event.runId} -->`,
        `## Iteration ${event.iteration}: ${event.status}`,
        "",
        `- Trial: ${event.trialId}`,
        `- Run: ${event.runId}`,
        `- Intent: ${event.intent}`,
        `- Score: ${event.score ?? "none"}`,
        `- Decision: ${event.decision ?? "none"}`,
        ...(event.error ? [`- Error: ${event.error.slice(0, 2_000)}`] : []),
      )
      const diagnostics = Object.entries(event.diagnostics).toSorted(([left], [right]) => left.localeCompare(right))
      if (diagnostics.length) lines.push("", "Diagnostics:", ...diagnostics.map(([key, value]) => `- ${key}: ${value}`))
      lines.push("")
    }
    return `${lines.join("\n").trimEnd()}\n`
  }

  function canonical(value: unknown): string {
    return JSON.stringify(stable(value))
  }

  function canonicalEvidence(event: TrajectoryEvent): string {
    const { recordedAt: _recordedAt, ...evidence } = event
    return canonical(evidence)
  }

  function canonicalLineage(event: TrajectoryEvent): string {
    return canonical({
      campaignId: event.campaignId,
      experimentId: event.experimentId,
      contractHash: event.contractHash,
      iteration: event.iteration,
      intent: event.intent,
      trialId: event.trialId,
      runId: event.runId,
      parentTrialId: event.parentTrialId,
      programHash: event.programHash,
      semanticProgramFingerprint: event.semanticProgramFingerprint,
      configurationFamilyFingerprint: event.configurationFamilyFingerprint,
      workflowFingerprint: event.workflowFingerprint,
      decisionPlan: event.decisionPlan,
      prediction: event.prediction,
      evidenceRefs: event.evidenceRefs,
      hypothesis: event.hypothesis,
      generatorPortfolio: event.generatorPortfolio,
      generatorAllocations: event.generatorAllocations,
    })
  }

  export function eventHash(event: TrajectoryEvent): string {
    return digest(canonical(event))
  }

  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    )
  }

  function digest(value: string): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`
  }
}
