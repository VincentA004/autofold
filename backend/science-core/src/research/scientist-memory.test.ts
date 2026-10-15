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

  test("keeps recovered failure history while projecting and rendering only its authoritative success", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-memory-recovery-"))
    const failure = ResearchScientistMemory.TrajectoryEvent.parse({
      recordedAt: "2026-08-30T12:00:00.000Z",
      campaignId: "cmp_memory",
      experimentId: "exp_memory",
      contractHash,
      iteration: 3,
      intent: "optimize",
      status: "run_failed",
      trialId: "trl_recovered",
      runId: "run_recovered",
      programHash: `sha256:${"b".repeat(64)}`,
      semanticProgramFingerprint: `sha256:${"c".repeat(64)}`,
      workflowFingerprint: `sha256:${"d".repeat(64)}`,
      hypothesis: "The immutable run can be recovered after transport failure.",
      generatorPortfolio: ["boltzgen-binder"],
      generatorAllocations: [{ generator:"boltzgen-binder", maximumCandidates:3, maximumGpuSeconds:600 }],
      decision: "failed",
      error: "scp: Connection closed",
    })
    await ResearchScientistMemory.append(failure, workspace)
    const success = {
      ...failure,
      recordedAt: "2026-08-30T13:00:00.000Z",
      status: "succeeded" as const,
      score: 0.2,
      decision: "promoted" as const,
      error: undefined,
      candidateSequences: ["ACDEFG"],
      modelIds: ["chai1-prediction"],
      seeds: [7, 11],
      diagnostics: { yield_fraction:1 },
      knowledgeCycleId: "kcy_recovered",
      searchObservationIds: ["sobs_recovered"],
    }
    const hash = ResearchScientistMemory.eventHash(failure)
    const amended = await ResearchScientistMemory.appendAmendment(success, hash, workspace)
    expect(amended).toMatchObject({
      appended:true,
      projection:{
        eventCount:1,
        latestRunId:"run_recovered",
        frontier:{bestScore:0.2,bestTrialId:"trl_recovered",bestRunId:"run_recovered",comparableOptimizeRuns:1},
        generators:[{generator:"boltzgen-binder",attempts:1,succeeded:1,failed:0,bestScore:0.2,runIds:["run_recovered"]}],
        failures:[],
        declaredHypotheses:[{runId:"run_recovered",outcome:"promoted"}],
      },
    })
    expect(await ResearchScientistMemory.read(workspace, "exp_memory")).toHaveLength(2)
    expect((await ResearchScientistMemory.appendAmendment({...success,recordedAt:"2026-08-30T14:00:00.000Z"},hash,workspace)).appended).toBe(false)
    const markdown = await fs.readFile(ResearchScientistMemory.readableViewPath(workspace, "exp_memory"), "utf8")
    expect(markdown.match(/trusted-run:run_recovered/g)).toHaveLength(1)
    expect(markdown).toContain("Iteration 3: succeeded")
    expect(markdown).not.toContain("scp: Connection closed")
  })

  test("rejects an amendment with the wrong failure hash, changed lineage, or an authoritative success overwrite", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-memory-amendment-conflict-"))
    const failure = ResearchScientistMemory.TrajectoryEvent.parse({
      recordedAt:"2026-08-30T12:00:00.000Z", experimentId:"exp_memory", contractHash, iteration:1,
      status:"run_failed", trialId:"trl_first", runId:"run_first", programHash:`sha256:${"b".repeat(64)}`,
      decision:"failed", error:"broken pipe",
    })
    await ResearchScientistMemory.append(failure,workspace)
    const success = {...failure,recordedAt:"2026-08-30T13:00:00.000Z",status:"succeeded" as const,
      decision:"rejected" as const,error:undefined,score:0.3}
    await expect(ResearchScientistMemory.appendAmendment(success,`sha256:${"f".repeat(64)}`,workspace))
      .rejects.toThrow("does not supersede its recorded failure")
    await expect(ResearchScientistMemory.appendAmendment({...success,trialId:"trl_other"},ResearchScientistMemory.eventHash(failure),workspace))
      .rejects.toThrow("does not match its recorded lineage")
    await ResearchScientistMemory.appendAmendment(success,ResearchScientistMemory.eventHash(failure),workspace)
    await expect(ResearchScientistMemory.appendAmendment({...success,score:0.4},ResearchScientistMemory.eventHash(failure),workspace))
      .rejects.toThrow("already has authoritative success evidence")
  })

  test("serializes concurrent identical appends", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientist-memory-concurrent-"))
    const event = {
      experimentId:"exp_memory", contractHash, iteration:1, status:"succeeded" as const,
      trialId:"trl_first", runId:"run_first", score:0.1, decision:"promoted" as const,
    }
    const results = await Promise.all([
      ResearchScientistMemory.append({...event,recordedAt:"2026-08-30T12:00:00.000Z"},workspace),
      ResearchScientistMemory.append({...event,recordedAt:"2026-08-30T13:00:00.000Z"},workspace),
    ])
    expect(results.map(result => result.appended).sort()).toEqual([false,true])
    expect(await ResearchScientistMemory.read(workspace,"exp_memory")).toHaveLength(1)
  })
})


test("append, duplicate and amendment projections honor a maximize evaluator", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-maximize-memory-"))
  try {
    const first = {experimentId:"exp_max",contractHash,iteration:1,intent:"optimize" as const,status:"succeeded" as const,trialId:"trl_low",runId:"run_low",score:0.2,decision:"promoted" as const}
    const second = {...first,iteration:2,trialId:"trl_high",runId:"run_high",score:0.7}
    await ResearchScientistMemory.append(first,root,"maximize")
    expect((await ResearchScientistMemory.append(second,root,"maximize")).projection.frontier.bestTrialId).toBe("trl_high")
    expect((await ResearchScientistMemory.append(second,root,"maximize")).projection.frontier.bestScore).toBe(0.7)
    const failure = {...first,iteration:3,trialId:"trl_recovered",runId:"run_recovered",status:"run_failed" as const,decision:"failed" as const,score:undefined,error:"Retrieval failed"}
    await ResearchScientistMemory.append(failure,root,"maximize")
    const saved = (await ResearchScientistMemory.read(root,"exp_max")).find(event=>event.runId==="run_recovered")!
    const recovered = {...failure,status:"succeeded" as const,decision:"promoted" as const,error:undefined,score:0.9}
    const result = await ResearchScientistMemory.appendAmendment(recovered,ResearchScientistMemory.eventHash(saved),root,"maximize")
    expect(result.projection.frontier.bestScore).toBe(0.9)
    expect(result.projection.frontier.bestTrialId).toBe("trl_recovered")
  } finally {await fs.rm(root,{recursive:true,force:true})}
})


test('durable original event append survives Markdown failure; duplicate repairs projection without a new event',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scientist-journal-sidecar-')),experimentId='exp_sidecar'
 try{
  await fs.mkdir(ResearchScientistMemory.readableViewPath(directory,experimentId),{recursive:true})
  const event={experimentId,contractHash,iteration:1,status:'succeeded' as const,trialId:'trl_original',runId:'run_original',score:.4}
  const first=await ResearchScientistMemory.append(event,directory)
  expect(first.appended).toBe(true);expect(first.publication.status).toBe('pending');expect(await ResearchScientistMemory.read(directory,experimentId)).toHaveLength(1)
  await fs.rm(ResearchScientistMemory.readableViewPath(directory,experimentId),{recursive:true})
  const retry=await ResearchScientistMemory.append(event,directory);expect(retry.appended).toBe(false);expect(retry.publication.status).toBe('published')
  expect(await ResearchScientistMemory.read(directory,experimentId)).toHaveLength(1)
  await fs.writeFile(ResearchScientistMemory.eventLogPath(directory,experimentId),'corrupted journal\n')
  await expect(ResearchScientistMemory.append({...event,runId:'run_second'},directory)).rejects.toThrow('Invalid scientist memory event')
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})
