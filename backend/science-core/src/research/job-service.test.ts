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
    research,
    jobs,
    projectId,
    campaign,
    experiment,
    advance: (amount: number) => (milliseconds += amount),
  }
}

describe("durable research jobs", () => {
  test("failure receipts preserve structured checkpoint conflict diagnostics", async () => {
    const { jobs, projectId, experiment } = await fixture()
    const job = await jobs.enqueue(projectId, { idempotencyKey: "diagnostics", payload: { kind: "autoresearch", experimentId: experiment.id, sessionId: "ses_parent", iterations: 1, agent: "biology" } })
    const claimed = await jobs.claim(projectId, 5000)
    const failed = await jobs.fail(projectId, job.id, claimed!.leaseId!, new ResearchJobService.ConflictError({ code: "checkpoint_conflict", message: "cycle:1 already contains different data" }))
    expect(failed.error).toBe("checkpoint_conflict: cycle:1 already contains different data")
  })

  test("failure receipts preserve scientific admission conflicts from a different NamedError class", async () => {
    const { jobs, projectId, experiment } = await fixture()
    const job = await jobs.enqueue(projectId, { idempotencyKey: "scientific-diagnostics", payload: { kind: "autoresearch", experimentId: experiment.id, sessionId: "ses_parent", iterations: 1, agent: "biology" } })
    const claimed = await jobs.claim(projectId, 5000)
    const failed = await jobs.fail(projectId, job.id, claimed!.leaseId!, new ResearchService.ConflictError({ code: "campaign_gpu_budget_exhausted", message: "600 seconds required; 599 seconds remain" }))
    expect(failed.error).toBe("campaign_gpu_budget_exhausted: 600 seconds required; 599 seconds remain")
    expect(failed.status).toBe("failed")
  })

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


test("Pi child enqueue fences cancelled, expired and replaced parents; orphan descendants never claim", async () => {
  const f = await fixture(), runtime = "autofold-pi.v1"
  const parent = await f.jobs.enqueue(f.projectId, {idempotencyKey: "parent", payload: {kind: "campaign_loop", campaignId: f.campaign.id, sessionId: "ses_parent", maxSteps: 1, runtime}})
  const payload = {kind: "autoresearch" as const, experimentId: f.experiment.id, sessionId: "ses_child", iterations: 1, agent: "biology" as const, runtime, parentJobId: parent.id}
  await expect(f.jobs.enqueue(f.projectId, {idempotencyKey: "queued-parent-child", payload})).rejects.toMatchObject({data: {code: "parent_job_fence"}})
  const owner = await f.jobs.claim(f.projectId, 1000)
  await expect(f.jobs.enqueue(f.projectId, {idempotencyKey: "wrong-lease-child", payload, parentLeaseId: "stale-owner"})).rejects.toMatchObject({data: {code: "parent_job_fence"}})
  const child = await f.jobs.enqueue(f.projectId, {idempotencyKey: "live-child", payload, parentLeaseId: owner!.leaseId!})
  await f.jobs.cancel(f.projectId, parent.id)
  await expect(f.jobs.enqueue(f.projectId, {idempotencyKey: "late-child", payload, parentLeaseId: owner!.leaseId!})).rejects.toMatchObject({data: {code: "parent_job_fence"}})
  expect(await f.jobs.claim(f.projectId, 1000)).toBeUndefined()
  expect((await f.jobs.get(f.projectId, child.id)).attempts).toBe(0)
  await expect(f.jobs.retry(f.projectId,parent.id)).rejects.toMatchObject({data:{code:"new_operation_required"}})
  const freshParent=await f.jobs.enqueue(f.projectId,{idempotencyKey:"new-parent-identity",payload:parent.payload})
  const resumed=await f.jobs.claim(f.projectId,1000)
  expect(resumed?.id).toBe(freshParent.id)
  const freshPayload={...payload,parentJobId:freshParent.id}
  const freshChild=await f.jobs.enqueue(f.projectId,{idempotencyKey:"new-child-identity",payload:freshPayload,parentLeaseId:resumed!.leaseId!})
  expect((await f.jobs.claim(f.projectId,1000))?.id).toBe(freshChild.id)
  expect((await f.jobs.get(f.projectId,child.id)).status).toBe("queued")
  await f.jobs.succeed(f.projectId,freshChild.id,(await f.jobs.get(f.projectId,freshChild.id)).leaseId!,{})
  f.advance(1001)
  await expect(f.jobs.enqueue(f.projectId,{idempotencyKey:"expired-parent-child",payload:freshPayload,parentLeaseId:resumed!.leaseId!})).rejects.toMatchObject({data:{code:"parent_job_fence"}})
})


test("read-only scientific first-launch guard requires exact owner, trial scope and live job", async () => {
  const f=await fixture(),job=await f.jobs.enqueue(f.projectId,{idempotencyKey:"launch-guard",payload:{kind:"autoresearch",experimentId:f.experiment.id,sessionId:"ses_native",iterations:1,agent:"biology",runtime:"autofold-pi.v1"}})
  const owner=await f.jobs.claim(f.projectId,1000)
  const trial=await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:"Host scope",designAdapter:"mock",programPath:"trial.py",programHash:digest("c"),origin:{jobId:job.id,phase:"native"}},{jobId:job.id,leaseId:owner!.leaseId!})
  await expect(f.research.assertTrustedJobLease(f.projectId,{jobId:job.id},{trialId:trial.id})).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  expect((await f.research.assertTrustedJobLease(f.projectId,{jobId:job.id,leaseId:owner!.leaseId!},{trialId:trial.id})).id).toBe(job.id)
  await expect(f.research.assertTrustedJobLease(f.projectId,{jobId:job.id,leaseId:"stale"},{trialId:trial.id})).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  await expect(f.research.assertTrustedJobLease(f.projectId,{jobId:job.id},{trialId:"trl_unknown"})).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  await f.jobs.cancel(f.projectId,job.id)
  await expect(f.research.assertTrustedJobLease(f.projectId,{jobId:job.id},{trialId:trial.id})).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  expect((await f.jobs.get(f.projectId,job.id)).status).toBe("cancelled")
})

describe('host recovery ownership', () => {
  test('expired Pi ownership cannot heartbeat or commit; recognized recovery preserves identity, budget and attempts', async () => {
    const f = await fixture()
    const job = await f.jobs.enqueue(f.projectId, {idempotencyKey:'recover-owned',payload:{kind:'autoresearch',runtime:'autofold-pi.v1',experimentId:f.experiment.id,sessionId:'ses_recovery',iterations:1,agent:'biology'}})
    const owner = (await f.jobs.claim(f.projectId,100))!
    const {createHash} = await import('node:crypto')
    const deadlineMs = Date.now()+1000
    await f.jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:createHash('sha256').update(JSON.stringify(owner.payload)).digest('hex'),deadlineMs})
    await f.jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:accounting:start',{jobId:job.id,sessions:{ses_recovery:{costUsd:0.17,existed:true}}})
    f.advance(101)
    await expect(f.jobs.heartbeat(f.projectId,job.id,owner.leaseId!,100)).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
    await expect(f.jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'late',{})).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
    await f.jobs.recover(f.projectId)
    expect(await f.jobs.get(f.projectId,job.id)).toMatchObject({status:'interrupted',recovery:{reason:'worker_crash',accounting:'unsettled'}})
    const next = (await f.jobs.claim(f.projectId,100))!
    expect(next.id).toBe(job.id);expect(next.leaseId).not.toBe(owner.leaseId);expect(next.attempts).toBe(1);expect(next.recoveryCount).toBe(1)
    expect(next.payload).toEqual(job.payload)
    expect(next.checkpoints['host:lifecycle:start'].data.deadlineMs).toBe(deadlineMs)
    expect(next.checkpoints['pi:accounting:start'].data.sessions).toEqual({ses_recovery:{costUsd:0.17,existed:true}})
    await f.jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'execution_unresolved',detail:'Stale owner must be inert'})
    expect((await f.jobs.get(f.projectId,job.id)).leaseId).toBe(next.leaseId)
  })
  test('an arbitrary checkpoint cannot authorize Pi resumption or an automatic scientific retry',async()=>{
    const f=await fixture()
    const job=await f.jobs.enqueue(f.projectId,{idempotencyKey:'unsafe-checkpoint',payload:{kind:'autoresearch',runtime:'autofold-pi.v1',experimentId:f.experiment.id,sessionId:'ses_unknown',iterations:1,agent:'biology'}})
    const owner=(await f.jobs.claim(f.projectId,100))!
    await f.jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'anything',{message:'A checkpoint is not a recovery protocol'})
    f.advance(101)
    expect(await f.jobs.claim(f.projectId,100)).toBeUndefined()
    expect(await f.jobs.get(f.projectId,job.id)).toMatchObject({status:'recovery_required',recovery:{reason:'unsupported_protocol'}})
    await expect(f.jobs.retry(f.projectId,job.id)).rejects.toBeInstanceOf(ResearchJobService.ConflictError)
  })
  test('missing receipt becomes explicit recovery_required and is never ordinarily claimed',async()=>{
    const f=await fixture()
    const job=await f.jobs.enqueue(f.projectId,{idempotencyKey:'unknown-effect',payload:{kind:'autoresearch',runtime:'autofold-pi.v1',experimentId:f.experiment.id,sessionId:'ses_unknown',iterations:1,agent:'biology'}})
    const owner=(await f.jobs.claim(f.projectId,100))!
    const held=await f.jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'execution_unresolved',runId:'run_original',detail:'Original receipt absent after launch attempt'})
    expect(held).toMatchObject({status:'recovery_required',attempts:1,recovery:{runId:'run_original',originalLeaseId:owner.leaseId,accounting:'unsettled'}})
    expect(held.result).toBeUndefined();expect(held.completedAt).toBeUndefined();expect(held.leaseId).toBeUndefined()
    expect(await f.jobs.claim(f.projectId,100)).toBeUndefined()
    expect((await f.jobs.claim(f.projectId,100,{reconcileJobId:job.id}))?.id).toBe(job.id)
  })
})


test('first launch checks the original ancestor deadline while receipt inspection remains permitted', async () => {
  const f = await fixture()
  const parent = await f.jobs.enqueue(f.projectId,{idempotencyKey:'deadline-parent',payload:{kind:'campaign_loop',runtime:'autofold-pi.v1',campaignId:f.campaign.id,sessionId:'ses_deadline_parent',maxSteps:1}})
  const owner = (await f.jobs.claim(f.projectId,60000))!
  await f.jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'host:lifecycle:start',{version:1,deadlineMs:Date.parse(owner.startedAt!)-1})
  const child = await f.jobs.enqueue(f.projectId,{idempotencyKey:'deadline-child',payload:{kind:'autoresearch',runtime:'autofold-pi.v1',experimentId:f.experiment.id,sessionId:'ses_deadline_child',iterations:1,agent:'biology',parentJobId:parent.id},parentLeaseId:owner.leaseId})
  const claimed = (await f.jobs.claim(f.projectId,60000,{eligible:job=>job.id===child.id}))!
  const origin = {jobId:child.id,leaseId:claimed.leaseId!}
  await expect(f.research.assertTrustedJobLease(f.projectId,origin,{newWork:true})).rejects.toMatchObject({data:{code:'research_job_deadline'}})
  expect((await f.research.assertTrustedJobLease(f.projectId,origin)).id).toBe(child.id)
})


test("child lifecycle commits require the live ownership tree and exact enqueue epoch", async () => {
  const f = await fixture(), runtime = "autofold-pi.v1"
  const parent = await f.jobs.enqueue(f.projectId,{idempotencyKey:"tree-parent",payload:{runtime,kind:"campaign_loop",campaignId:f.campaign.id,sessionId:"ses_tree",maxSteps:1}})
  const owner = (await f.jobs.claim(f.projectId,1000,{eligible:job=>job.id===parent.id}))!
  const payload = {runtime,kind:"autoresearch" as const,experimentId:f.experiment.id,sessionId:"ses_tree_child",iterations:1,agent:"biology" as const,parentJobId:parent.id}
  await expect(f.jobs.enqueue(f.projectId,{idempotencyKey:"missing-epoch",payload})).rejects.toMatchObject({data:{code:"parent_job_fence"}})
  const child = await f.jobs.enqueue(f.projectId,{idempotencyKey:"tree-child",payload,parentLeaseId:owner.leaseId})
  const childOwner = (await f.jobs.claim(f.projectId,5000,{eligible:job=>job.id===child.id}))!
  expect((await f.jobs.checkOwnership(f.projectId,child.id,childOwner.leaseId!)).ownership).toEqual({valid:true})
  f.advance(1001)
  expect((await f.jobs.checkOwnership(f.projectId,child.id,childOwner.leaseId!)).ownership).toEqual({valid:false,reason:"ancestor_lost",jobId:parent.id})
  for (const operation of [
    () => f.jobs.heartbeat(f.projectId,child.id,childOwner.leaseId!,5000),
    () => f.jobs.checkpoint(f.projectId,child.id,childOwner.leaseId!,"late",{}),
    () => f.jobs.succeed(f.projectId,child.id,childOwner.leaseId!,{}),
    () => f.jobs.fail(f.projectId,child.id,childOwner.leaseId!,new Error("late")),
  ]) await expect(operation()).rejects.toMatchObject({data:{code:"job_lease_lost"}})
  expect((await f.jobs.get(f.projectId,child.id)).status).toBe("running")
  await f.jobs.interrupt(f.projectId,parent.id,owner.leaseId!,{reason:"shutdown",detail:"Reclaim original expired ownership"})
  const successor = (await f.jobs.claim(f.projectId,5000,{eligible:job=>job.id===parent.id}))!
  await expect(f.jobs.enqueue(f.projectId,{idempotencyKey:"stale-epoch",payload,parentLeaseId:owner.leaseId})).rejects.toMatchObject({data:{code:"parent_job_fence"}})
  // An existing child can settle under the explicitly reclaimed live ancestry.
  expect((await f.jobs.checkOwnership(f.projectId,child.id,childOwner.leaseId!)).ownership).toEqual({valid:true})
  expect(successor.leaseId).not.toBe(owner.leaseId)
})

test("snapshot ownership rejects missing, cyclic, terminal and cancellation-marked ancestors", async () => {
  const f = await fixture(),runtime="autofold-pi.v1"
  const parent=await f.jobs.enqueue(f.projectId,{idempotencyKey:"inspect-parent",payload:{runtime,kind:"campaign_loop",campaignId:f.campaign.id,sessionId:"ses_inspect",maxSteps:1}})
  const owner=(await f.jobs.claim(f.projectId,5000))!
  const child=await f.jobs.enqueue(f.projectId,{idempotencyKey:"inspect-child",parentLeaseId:owner.leaseId,payload:{runtime,kind:"autoresearch",experimentId:f.experiment.id,sessionId:"ses_inspect_child",iterations:1,agent:"biology",parentJobId:parent.id}})
  const childOwner=(await f.jobs.claim(f.projectId,5000,{eligible:job=>job.id===child.id}))!
  const original=await f.store.read(f.projectId),now=childOwner.heartbeatAt!
  expect(ResearchJobService.inspectOwnership(original,childOwner,now,childOwner.leaseId)).toEqual({valid:true})
  expect(ResearchJobService.inspectOwnership(original,childOwner,now,"old-epoch")).toMatchObject({valid:false,reason:"lease_lost"})
  for (const alter of [
    (state:typeof original)=>{delete state.jobs[parent.id]},
    (state:typeof original)=>{state.jobs[parent.id]!.payload.parentJobId=child.id},
    (state:typeof original)=>{state.jobs[parent.id]!.status="succeeded"},
    (state:typeof original)=>{state.jobs[parent.id]!.cancelRequestedAt=now},
    (state:typeof original)=>{state.jobs[parent.id]!.projectId="foreign-project"},
  ]) {const state=structuredClone(original);alter(state);expect(ResearchJobService.inspectOwnership(state,childOwner,now,childOwner.leaseId)).toMatchObject({valid:false,reason:"ancestor_lost"})}
})


test("managed trial admission fences cancellation, stale epoch and deadline atomically while existing identity remains recoverable", async () => {
  const f=await fixture(),job=await f.jobs.enqueue(f.projectId,{idempotencyKey:"trial-admission",payload:{runtime:"autofold-pi.v1",kind:"autoresearch",experimentId:f.experiment.id,sessionId:"ses_admission",iterations:1,agent:"biology"}})
  const owner=(await f.jobs.claim(f.projectId,5000))!, authority={jobId:job.id,leaseId:owner.leaseId!}
  const raw={hypothesis:"Original admission",designAdapter:"mock" as const,programPath:"trial.py",programHash:digest("c"),origin:{jobId:job.id,phase:"original"}}
  await expect(f.research.createTrial(f.projectId,f.experiment.id,raw)).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  await expect(f.research.createTrial(f.projectId,f.experiment.id,raw,{...authority,leaseId:"old-epoch"})).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  const trial=await f.research.createTrial(f.projectId,f.experiment.id,raw,authority)
  await f.jobs.checkpoint(f.projectId,job.id,authority.leaseId,"host:lifecycle:start",{version:1,deadlineMs:Date.parse(owner.heartbeatAt!)-1})
  await expect(f.research.createTrial(f.projectId,f.experiment.id,{...raw,origin:{jobId:job.id,phase:"past-deadline"}},authority)).rejects.toMatchObject({data:{code:"research_job_deadline"}})
  await f.jobs.cancel(f.projectId,job.id)
  await expect(f.research.createTrial(f.projectId,f.experiment.id,{...raw,origin:{jobId:job.id,phase:"after-cancellation"}},authority)).rejects.toMatchObject({data:{code:"research_job_commit_fence"}})
  expect((await f.research.createTrial(f.projectId,f.experiment.id,raw)).id).toBe(trial.id)
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toEqual([trial.id])
})


test("cancelled canonical jobs cannot be retried under the same revoked operation identity",async()=>{const f=await fixture(),job=await f.jobs.enqueue(f.projectId,{idempotencyKey:"revoked-identity",payload:{runtime:"autofold-pi.v1",kind:"autoresearch",experimentId:f.experiment.id,sessionId:"ses_revoked",iterations:1,agent:"biology"}});await f.jobs.cancel(f.projectId,job.id);const before=await f.store.read(f.projectId);await expect(f.jobs.retry(f.projectId,job.id)).rejects.toMatchObject({data:{code:"new_operation_required"}});expect(await f.store.read(f.projectId)).toEqual(before)})
