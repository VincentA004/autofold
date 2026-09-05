import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchScientistKernel } from "./scientist-kernel"

const common = {
  format: "autofold.scientist-state.v2" as const,
  experimentId: "exp_kernel",
  contractHash: `sha256:${"a".repeat(64)}`,
  sessionId: "ses_kernel",
  iteration: 2,
  mutableTrialPath: ".autofold/autoresearch/exp_kernel/trial.py",
  memoryRevision: `sha256:${"b".repeat(64)}`,
  updatedAt: "2026-08-30T12:00:00.000Z",
}

describe("minimal scientist kernel state", () => {
  test("atomically overwrites one total resumable state register", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-kernel-"))
    const file = path.join(root, "scientist-state.json")
    await ResearchScientistKernel.write(file, { ...common, phase: "authoring" })
    expect(await ResearchScientistKernel.read(file)).toMatchObject({ phase: "authoring", iteration: 2 })
    await ResearchScientistKernel.write(file, {
      ...common,
      phase: "result_available",
      status: "succeeded",
      trialId: "trl_kernel",
      runId: "run_kernel",
      score: 0.2,
    })
    expect(await ResearchScientistKernel.read(file)).toEqual(expect.objectContaining({
      phase: "result_available",
      trialId: "trl_kernel",
      runId: "run_kernel",
      score: 0.2,
    }))
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toHaveLength(0)
  })

  test("loads the previous session pointer for migration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-kernel-legacy-"))
    const file = path.join(root, "scientist-state.json")
    await fs.writeFile(file, JSON.stringify({
      format: "autofold.experiment-scientist.v1",
      experimentId: "exp_kernel",
      contractHash: common.contractHash,
      sessionId: "ses_kernel",
    }))
    expect(await ResearchScientistKernel.read(file)).toMatchObject({
      format: "autofold.experiment-scientist.v1",
      sessionId: "ses_kernel",
    })
  })
})
