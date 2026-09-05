import { describe, expect, test } from "bun:test"
import { ResearchJobService } from "./job-service"
import { ResearchService } from "./service"
import { MemoryResearchStore } from "./store"

const digest = (character: string) => `sha256:${character.repeat(64)}`

async function fixture() {
  let milliseconds = Date.UTC(2026, 7, 9)
  let researchSequence = 0
  let jobSequence = 0
  let leaseSequence = 0
  const now = () => new Date(milliseconds).toISOString()
  const store = new MemoryResearchStore()
  const research = new ResearchService.Service(store, {
    now,
    id: (prefix) => `${prefix}_${++researchSequence}`,
  })
  const jobs = new ResearchJobService.Service(store, {
    now,
    id: () => `job_${++jobSequence}`,
    leaseId: () => `lease-${++leaseSequence}`,
  })
  const projectId = "project-jobs"
  const campaign = await research.createCampaign(projectId, { objective: "Find selective peptide binders" })
  await research.activateCampaign(projectId, campaign.id)
  const experiment = await research.createExperiment(projectId, campaign.id, {
    contract: {
      version: 1,
      objective: "Improve a locked peptide score",
      targetArtifactHash: digest("a"),
      modality: "linear_minibinder",
      budget: { maximumCandidates: 10, gpuHours: 1, wallTimeMinutes: 30 },
      evaluator: {
        id: "locked",
        version: "1",
        sourceHash: digest("b"),
        direction: "maximize",
        fixedSeeds: [41],
        submissionSize: 2,
      },
    },
  })
  await research.activateExperiment(projectId, experiment.id)
  return {
    store,
    jobs,
    projectId,
    campaign,
    experiment,
    advance: (amount: number) => (milliseconds += amount),
  }
}

describe("durable research jobs", () => {
  test("requires an active campaign skill before queuing capability refinement", async () => {
    const { jobs, store, projectId, campaign, experiment } = await fixture()
    const payload = {
      kind: "capability_refinement" as const,
      campaignId: campaign.id,
      sessionId: "ses_parent",
      skillId: "skill_bionemo.predictor-interpretation",
      trajectoryRefs: ["trl_one"],
      replayAgent: "biology" as const,
      replayRepetitions: 3,
    }
    await expect(jobs.enqueue(projectId, { idempotencyKey: "refine:one", payload })).rejects.toBeInstanceOf(
      ResearchJobService.ConflictError,
    )
    await store.mutate(projectId, (state) => {
      state.skillVersions.skv_one = {
        id: "skv_one", campaignId: campaign.id, skillId: payload.skillId, version: 1,
        path: ".autofold/skills/SKILL.md", contentHash: digest("c"), capabilities: ["model_diagnostics"],
        appliesToToolKeys: [], status: "active", source: "bundled", trajectoryRefs: [],
        createdBy: "autofold:bundled", createdAt: "2026-08-09T00:00:00.000Z",
      }
    })
    const refinement = await jobs.enqueue(projectId, { idempotencyKey: "refine:one", payload })
    expect(refinement.payload).toEqual(payload)
    await store.mutate(projectId, (state) => {
      state.skillVersions.skv_candidate = {
        ...state.skillVersions.skv_one!, id: "skv_candidate", version: 2, parentVersionId: "skv_one",
        path: ".autofold/skills/v2/SKILL.md", contentHash: digest("d"), status: "candidate",
        source: "campaign_refinement", trajectoryRefs: ["trl_one"], createdBy: "capability-refinement",
      }
    })
    await expect(jobs.enqueue(projectId, {
      idempotencyKey: "refine:two", payload: { ...payload, trajectoryRefs: ["trl_two"] },
    })).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
    expect(await jobs.enqueue(projectId, { idempotencyKey: "refine:one", payload })).toEqual(refinement)
    const replay = await jobs.enqueue(projectId, {
      idempotencyKey: "replay:one",
      payload: {
        kind: "skill_shadow_replay", campaignId: campaign.id, experimentId: experiment.id,
        candidateVersionId: "skv_candidate", sessionId: "ses_parent", agent: "ml",
      },
    })
    expect(replay.payload.kind).toBe("skill_shadow_replay")
  })

  test("deduplicates identical requests and rejects idempotency collisions", async () => {
    const { jobs, projectId, experiment } = await fixture()
    const request = {
      idempotencyKey: "autoresearch:round-1",
      payload: {
        kind: "autoresearch" as const,
        experimentId: experiment.id,
        sessionId: "ses_parent",
        iterations: 2,
        agent: "biology" as const,
      },
    }
    const first = await jobs.enqueue(projectId, request)
    expect(first.maxAttempts).toBe(1)
    expect(await jobs.enqueue(projectId, request)).toEqual(first)
    expect(await jobs.list(projectId)).toHaveLength(1)

    await expect(
      jobs.enqueue(projectId, {
        ...request,
        payload: { ...request.payload, iterations: 3 },
      }),
    ).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
  })

  test("leases, heartbeats, and completes a job with durable result references", async () => {
    const { jobs, projectId, campaign, advance } = await fixture()
    const queued = await jobs.enqueue(projectId, {
      idempotencyKey: "knowledge:cycle-1",
      payload: {
        kind: "knowledge_refresh",
        campaignId: campaign.id,
        sessionId: "ses_parent",
        maxSources: 10,
        maxClaims: 10,
      },
    })
    const claimed = await jobs.claim(projectId, 5_000)
    expect(claimed).toMatchObject({ id: queued.id, status: "running", attempts: 1, leaseId: "lease-1" })
    advance(1_000)
    const heartbeat = await jobs.heartbeat(projectId, queued.id, "lease-1", 5_000)
    expect(heartbeat.heartbeatAt).toBe("2026-08-09T00:00:01.000Z")
    const complete = await jobs.succeed(projectId, queued.id, "lease-1", { cycleId: "kcy_result" })
    expect(complete).toMatchObject({ status: "succeeded", result: { cycleId: "kcy_result" } })
    expect(complete.leaseId).toBeUndefined()
  })

  test("recovers an expired lease and exhausts bounded retries", async () => {
    const { jobs, projectId, experiment, advance } = await fixture()
    const queued = await jobs.enqueue(projectId, {
      idempotencyKey: "autoresearch:recover",
      maxAttempts: 2,
      payload: {
        kind: "autoresearch",
        experimentId: experiment.id,
        sessionId: "ses_parent",
        iterations: 1,
        agent: "ml",
      },
    })
    expect((await jobs.claim(projectId, 1_000))?.attempts).toBe(1)
    advance(1_001)
    const reclaimed = await jobs.claim(projectId, 1_000)
    expect(reclaimed).toMatchObject({ id: queued.id, status: "running", attempts: 2, leaseId: "lease-2" })
    await jobs.fail(projectId, queued.id, "lease-2", new Error("deterministic failure"))
    expect(await jobs.get(projectId, queued.id)).toMatchObject({ status: "failed", error: "deterministic failure" })
    expect(await jobs.claim(projectId, 1_000)).toBeUndefined()
  })

  test("cancellation is terminal and prevents a late worker completion", async () => {
    const { jobs, projectId, campaign } = await fixture()
    const queued = await jobs.enqueue(projectId, {
      idempotencyKey: "knowledge:cancel",
      payload: {
        kind: "knowledge_refresh",
        campaignId: campaign.id,
        sessionId: "ses_parent",
        maxSources: 5,
        maxClaims: 5,
      },
    })
    const claimed = await jobs.claim(projectId, 5_000)
    await jobs.cancel(projectId, queued.id)
    const late = await jobs.succeed(projectId, queued.id, claimed!.leaseId!, { cycleId: "kcy_too_late" })
    expect(late.status).toBe("cancelled")
    expect(late.result).toBeUndefined()

    const resumed = await jobs.retry(projectId, queued.id)
    expect(resumed).toMatchObject({ status: "queued", attempts: 0 })
    expect(resumed.cancelRequestedAt).toBeUndefined()
  })

  test("preserves immutable phase checkpoints across lease recovery", async () => {
    const { jobs, projectId, experiment, advance } = await fixture()
    const queued = await jobs.enqueue(projectId, {
      idempotencyKey: "autoresearch:checkpoint",
      payload: {
        kind: "autoresearch",
        experimentId: experiment.id,
        sessionId: "ses_parent",
        iterations: 1,
        agent: "biology",
      },
    })
    const claimed = await jobs.claim(projectId, 1_000)
    const checkpoint = await jobs.checkpoint(projectId, queued.id, claimed!.leaseId!, "iteration:1:run", {
      trialId: "trl_one",
      runId: "run_one",
      programHash: digest("c"),
    })
    expect(await jobs.checkpoint(projectId, queued.id, claimed!.leaseId!, checkpoint.phase, checkpoint.data)).toEqual(
      checkpoint,
    )
    await expect(
      jobs.checkpoint(projectId, queued.id, claimed!.leaseId!, checkpoint.phase, { runId: "run_other" }),
    ).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
    advance(1_001)
    const resumed = await jobs.claim(projectId, 1_000)
    expect(resumed).toMatchObject({ id: queued.id, status: "running", attempts: 1, leaseId: "lease-2" })
    expect((await jobs.get(projectId, queued.id)).checkpoints[checkpoint.phase]).toEqual(checkpoint)
  })
})
