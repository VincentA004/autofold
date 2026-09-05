import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchScientistMemory } from "./scientist-memory"

const contractHash = `sha256:${"a".repeat(64)}`

describe("persistent scientist memory", () => {
  test("appends trusted events once and derives a compounding experiment projection", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-memory-"))
    const first = {
      recordedAt: "2026-08-30T12:00:00.000Z",
      campaignId: "cmp_memory",
      experimentId: "exp_memory",
      contractHash,
      iteration: 1,
      intent: "optimize" as const,
      status: "succeeded" as const,
      trialId: "trl_first",
      runId: "run_first",
      hypothesis: "BoltzGen establishes the initial comparable frontier.",
      generatorPortfolio: ["boltzgen-binder"],
      generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 3, maximumGpuSeconds: 600 }],
      candidateSequences: ["ACDEFG"],
      modelIds: ["boltz2-prediction"],
      seeds: [7, 11],
      score: 0.25,
      decision: "promoted" as const,
      diagnostics: { yield_fraction: 1 },
    }
    const second = {
      ...first,
      recordedAt: "2026-08-30T13:00:00.000Z",
      iteration: 2,
      trialId: "trl_second",
      runId: "run_second",
      hypothesis: "RFdiffusion explores a distinct generator family.",
      generatorPortfolio: ["rfdiffusion-mpnn-binder"],
      generatorAllocations: [{ generator: "rfdiffusion-mpnn-binder", maximumCandidates: 3, maximumGpuSeconds: 600 }],
      score: 0.3,
      decision: "rejected" as const,
    }
    expect((await ResearchScientistMemory.append(first, workspace)).appended).toBe(true)
    expect((await ResearchScientistMemory.append(first, workspace)).appended).toBe(false)
    const appended = await ResearchScientistMemory.append(second, workspace)
    expect(appended.projection).toMatchObject({
      eventCount: 2,
      latestRunId: "run_second",
      frontier: {
        bestScore: 0.25,
        bestTrialId: "trl_first",
        comparableOptimizeRuns: 2,
        consecutiveNonImprovingRuns: 1,
      },
      generators: [
        { generator: "boltzgen-binder", attempts: 1, succeeded: 1, failed: 0, bestScore: 0.25 },
        { generator: "rfdiffusion-mpnn-binder", attempts: 1, succeeded: 1, failed: 0, bestScore: 0.3 },
      ],
    })
    expect(await ResearchScientistMemory.read(workspace, "exp_memory")).toHaveLength(2)
    const jsonl = await fs.readFile(ResearchScientistMemory.eventLogPath(workspace, "exp_memory"), "utf8")
    expect(jsonl.trim().split("\n")).toHaveLength(2)
    const markdown = await fs.readFile(ResearchScientistMemory.readableViewPath(workspace, "exp_memory"), "utf8")
    expect(markdown.match(/trusted-run:run_first/g)).toHaveLength(1)
  })

  test("rejects conflicting evidence for an existing run and contract drift", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-memory-conflict-"))
    const event = {
      recordedAt: "2026-08-30T12:00:00.000Z",
      experimentId: "exp_memory",
      contractHash,
      iteration: 1,
      status: "run_failed" as const,
      trialId: "trl_first",
      runId: "run_first",
      error: "Generator failed",
    }
    await ResearchScientistMemory.append(event, workspace)
    await expect(ResearchScientistMemory.append({ ...event, error: "Different failure" }, workspace)).rejects.toThrow(
      "already exists with different trusted evidence",
    )
    await expect(ResearchScientistMemory.append({
      ...event,
      recordedAt: "2026-08-30T13:00:00.000Z",
      runId: "run_second",
      trialId: "trl_second",
      contractHash: `sha256:${"b".repeat(64)}`,
    }, workspace)).rejects.toThrow("contract changed")
  })
})
