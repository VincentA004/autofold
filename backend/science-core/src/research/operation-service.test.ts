import {test,expect,afterEach} from "bun:test"
import {Database} from 'bun:sqlite' 
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {OperationService} from "./operation-service"
import {OperationDomain,assertOperationHandle,cancelOperationsForJobs} from "./operations"
import {MemoryResearchStore,StorageResearchStore} from "./store"
import {ResearchDomain} from "./domain"
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
function fixture(){let milliseconds=Date.UTC(2026,9,10),sequence=0;const now=()=>new Date(milliseconds).toISOString(),store=new MemoryResearchStore(),service=new OperationService.Service(store,{now,leaseId:()=>`epoch-${++sequence}`});return {store,service,now,advance:(ms:number)=>milliseconds+=ms}}
const input={id:"op_original",kind:"knowledge_refresh",identity:{question:"Original frozen question",modelSelection:{modelId:"fixture",provider:"offline"}},grant:{modelBudgetUsd:1}}
test("canonical operation identity is key-order stable and never overwritten",async()=>{const f=fixture(),record=await f.service.open("project",input);expect((await f.service.open("project",{...input,identity:{modelSelection:{provider:"offline",modelId:"fixture"},question:"Original frozen question"}})).id).toBe(record.id);await expect(f.service.open("project",{...input,identity:{question:"Changed"}})).rejects.toMatchObject({code:"operation_identity_conflict"});expect(await f.service.read("project",input.id)).toEqual(record)})
test("operation epoch and revision CAS admits one writer and fences expired replacement",async()=>{const f=fixture();await f.service.open("project",input);let handle=await f.service.acquire("project",input.id,{mode:"run",leaseMs:1000});const results=await Promise.allSettled([f.service.update(handle,{phase:"accepted",state:{answer:"original"}}),f.service.update(handle,{phase:"accepted",state:{answer:"replacement"}})]);expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);const winner=results.find(result=>result.status==="fulfilled") as PromiseFulfilledResult<{handle:OperationDomain.Handle}>;handle=winner.value.handle;expect((await f.service.renew(handle,1000)).revision).toBe(handle.revision);f.advance(1001);const replacement=await f.service.acquire("project",input.id,{mode:"settle",leaseMs:1000});expect(replacement.epoch).toBe(handle.epoch+1);await expect(f.service.update(handle,{phase:"stale",state:{}})).rejects.toMatchObject({code:"operation_epoch_lost"});await f.service.release(handle);expect((await f.service.read("project",input.id))?.owner?.leaseId).toBe(replacement.leaseId)})
test("state event and outbox intent commit atomically and survive SQLite reopen",async()=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),"autofold-operation-sqlite-"));roots.push(directory);const store=new StorageResearchStore({directory}),service=new OperationService.Service(store);await service.open("project",input);const owner=await service.acquire("project",input.id,{mode:"run",leaseMs:30000}),saved=await service.update(owner,{phase:"committed",state:{receipt:"original"},outbox:[{id:"projection_original",kind:"publish",purpose:"projection",data:{path:"result.json",receipt:"original"}}]});const reopened=new OperationService.Service(new StorageResearchStore({directory}));expect((await reopened.read("project",input.id))?.state).toEqual({receipt:"original"});expect((await store.read("project")).operationOutbox.projection_original?.status).toBe("pending");expect((await reopened.events("project",input.id)).map(event=>event.revision)).toEqual([0,1,2]);await expect(service.update(saved.handle,{phase:"replace",state:{receipt:"bad"},outbox:[{id:"projection_original",kind:"publish",data:{receipt:"bad"}}]})).rejects.toMatchObject({code:"outbox_identity_conflict"});expect((await reopened.read("project",input.id))?.revision).toBe(2);expect((await reopened.events("project",input.id))).toHaveLength(3)})
test("cancelled job permits separately owned settlement but never restores effect admission",async()=>{const f=fixture();await f.store.mutate("project",state=>{state.jobs.job_original=ResearchDomain.Job.parse({id:"job_original",projectId:"project",idempotencyKey:"original",payload:{kind:"autoresearch",runtime:"autofold-pi.v1",experimentId:"exp_original",sessionId:"ses_original",iterations:1,agent:"biology"},status:"running",attempts:1,maxAttempts:1,leaseId:"native-epoch",leaseExpiresAt:new Date(Date.parse(f.now())+1000).toISOString(),createdAt:f.now(),updatedAt:f.now(),checkpoints:{}})});await f.service.open("project",{...input,jobId:"job_original"});const old=await f.service.acquire("project",input.id,{mode:"run",leaseMs:1000,jobLeaseId:"native-epoch"});await f.store.mutate("project",state=>{state.jobs.job_original!.status="cancelled";cancelOperationsForJobs(state,new Set(["job_original"]),f.now())});await expect(f.service.check(old)).rejects.toMatchObject({code:"operation_epoch_lost"});await expect(f.service.acquire("project",input.id,{mode:"run",leaseMs:1000,jobLeaseId:"native-epoch"})).rejects.toMatchObject({code:"operation_cancelled"});const settlement=await f.service.acquire("project",input.id,{mode:"settle",leaseMs:1000});await expect(f.service.update(settlement,{phase:"launch",state:{},effect:"prepared"})).rejects.toMatchObject({code:"settlement_cannot_launch"});await expect(f.service.update(settlement,{phase:"launch",state:{},outbox:[{id:"new-effect",kind:"dispatch",purpose:"effect",data:{}}]})).rejects.toMatchObject({code:"settlement_cannot_launch"});expect(()=>assertOperationHandle({operations:{[input.id]:(undefined as never)}},settlement,f.now())).toThrow();const done=await f.service.update(settlement,{phase:"settled",state:{originalReceipt:"verified"},effect:"settled",accounting:"settled",settlement:"settled"});expect(done.record.cancelledAt).toBeTruthy();expect((await f.store.read("project")).jobs.job_original?.status).toBe("cancelled");await expect(f.service.update(done.handle,{phase:"regress",state:{},accounting:"pending"})).rejects.toMatchObject({code:"operation_terminal_conflict"})})
test("canonical event history and intent identity cannot be rewritten by another store writer",async()=>{const f=fixture();await f.service.open("project",input);await expect(f.store.mutate("project",state=>{Object.values(state.operationEvents)[0]!.type="invented"})).rejects.toThrow("append-only");await expect(f.store.mutate("project",state=>{state.operations[input.id]!.identity.question="invented"})).rejects.toThrow("immutable");expect((await f.service.read("project",input.id))?.identity.question).toBe("Original frozen question")})
test("concurrent canonical acquisition yields one host epoch and expired grant only admits settlement",async()=>{const f=fixture();await f.service.open("project",{...input,grant:{deadlineMs:Date.parse(f.now())+1000}});const claims=await Promise.allSettled([f.service.acquire("project",input.id,{mode:"run",leaseMs:1000}),f.service.acquire("project",input.id,{mode:"run",leaseMs:1000})]);expect(claims.filter(result=>result.status==="fulfilled")).toHaveLength(1);f.advance(1001);await expect(f.service.acquire("project",input.id,{mode:"run",leaseMs:1000})).rejects.toMatchObject({code:"operation_deadline"});expect((await f.service.acquire("project",input.id,{mode:"settle",leaseMs:1000})).mode).toBe("settle")})


test("standalone scientific commit rechecks original deadline inside the transaction",async()=>{const f=fixture();await f.service.open("project",{...input,grant:{deadlineMs:Date.parse(f.now())+1000}});const handle=await f.service.acquire("project",input.id,{mode:"run",leaseMs:5000});await f.service.check(handle);f.advance(1001);await expect(f.store.mutate("project",state=>{assertOperationHandle(state,handle,f.now());state.branchCursors.scientific="must-not-commit"})).rejects.toThrow("grant expired");expect((await f.store.read("project")).branchCursors.scientific).toBeUndefined()})

test("projection supersession cannot erase an uncertain external effect",async()=>{const f=fixture();await f.service.open("project",input);let handle=await f.service.acquire("project",input.id,{mode:"run",leaseMs:5000});handle=(await f.service.update(handle,{phase:"prepared",state:{},outbox:[{id:"old-projection",kind:"export",purpose:"projection",data:{revision:1}},{id:"external-original",kind:"dispatch",purpose:"effect",data:{originalId:"immutable"}}]})).handle;handle=await f.service.acknowledge(handle,"old-projection",{status:"superseded",receiptId:"current-projection-hash"});expect((await f.store.read("project")).operationOutbox['old-projection']?.status).toBe("superseded");await expect(f.service.acknowledge(handle,"external-original",{status:"superseded"})).rejects.toMatchObject({code:"effect_cannot_supersede"});expect((await f.store.read("project")).operationOutbox['external-original']?.status).toBe("pending")})


test('exact operation CAS reads and updates skip unrelated historical blobs without weakening immutable events', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'autofold-operation-scoped-'));roots.push(directory)
  const store = new StorageResearchStore({directory}), service = new OperationService.Service(store)
  await service.open('project',input)
  let handle = await service.acquire('project',input.id,{mode:'run',leaseMs:30000})
  await store.mutate('project',state => {state.jobs.job_unrelated = ResearchDomain.Job.parse({id:'job_unrelated',projectId:'project',idempotencyKey:'unrelated',payload:{kind:'autoresearch',experimentId:'exp_fixture',sessionId:'ses_fixture',iterations:1,agent:'biology'},status:'queued',attempts:0,maxAttempts:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),checkpoints:{}})})
  const db = new Database(path.join(directory,'project.sqlite'))
  try {
    db.query("UPDATE records SET refs=? WHERE collection='jobs' AND id='job_unrelated'").run(JSON.stringify({'checkpoint:corrupt':'f'.repeat(64)}))
    expect((await service.read('project',input.id))?.id).toBe(input.id)
    expect((await service.check(handle)).owner?.leaseId).toBe(handle.leaseId)
    handle = (await service.update(handle,{phase:'exact',state:{proof:'original'},outbox:[{id:'scoped-export',kind:'export',purpose:'projection',data:{value:'original'}}]})).handle
    handle = await service.acknowledge(handle,'scoped-export',{status:'acknowledged',receiptId:'original-hash'})
    expect((await service.renew(handle,30000)).revision).toBe(handle.revision)
    await expect(service.update(handle,{phase:'replacement',state:{},outbox:[{id:'scoped-export',kind:'export',purpose:'projection',data:{value:'replacement'}}]})).rejects.toMatchObject({code:'outbox_identity_conflict'})
    expect((await service.events('project',input.id)).map(event=>event.revision)).toEqual([0,1,2,3])
    await expect(store.read('project')).rejects.toThrow('Corrupt research blob')
  } finally {db.close()}
})

const fixtureAccounting={kind:'known' as const,source:'fixture' as const,modelCostUsd:.02,sessionIds:['ses_fixture']}
async function terminalFixture(marker=true){const f=fixture();const record=await f.service.open('project',{...input,...(marker?{scientificDispatch:{version:1 as const,status:'not_started' as const,requestIds:[]}}:{})});const handle=await f.service.acquire('project',input.id,{mode:'run',leaseMs:1000});return {...f,handle,evidence:{version:1 as const,operationId:record.id,identityHash:record.identityHash,outcome:'failed' as const,reason:'authoring exhausted',effects:{kind:'none' as const,requestIds:[]},accounting:fixtureAccounting}}}
test('known authoring failure settles after expiry without inventing successful science',async()=>{
 const f=await terminalFixture();f.advance(1001);const handle=await f.service.acquire('project',input.id,{mode:'settle',leaseMs:1000})
 const result=await f.service.terminal(handle,{phase:'failed',state:{guideStatus:'unevaluated'},evidence:f.evidence})
 expect(result.record).toMatchObject({effect:'none',accounting:'settled',outcome:'failed',settlement:'settled'})
 expect(result.record.state.guideStatus).toBe('unevaluated');expect((await f.service.events('project',input.id)).at(-1)?.type).toBe('terminal_evidence_committed')
 await expect(f.service.prepareScientificDispatch(result.handle,'replacement')).rejects.toMatchObject({code:'settlement_cannot_launch'})
})
test('missing marker, unproven request IDs and prepared dispatch cannot claim no science',async()=>{
 const absent=await terminalFixture(false);await expect(absent.service.terminal(absent.handle,{phase:'failed',state:{},evidence:absent.evidence})).rejects.toMatchObject({code:'dispatch_absence_unproven'})
 const f=await terminalFixture();await expect(f.service.terminal(f.handle,{phase:'failed',state:{},evidence:{...f.evidence,effects:{kind:'none',requestIds:['unproven']}}})).rejects.toMatchObject({code:'dispatch_absence_unproven'})
 const prepared=await f.service.prepareScientificDispatch(f.handle,'original-request')
 await expect(f.service.terminal(prepared.handle,{phase:'failed',state:{},evidence:f.evidence})).rejects.toMatchObject({code:'dispatch_absence_unproven'})
 await expect(f.service.terminal(prepared.handle,{phase:'failed',state:{},evidence:{...f.evidence,effects:{kind:'receipts',receiptIds:['invented']}}})).rejects.toMatchObject({code:'original_effect_unresolved'})
})
test('unknown billing remains independent of failure and can refine from original receipts',async()=>{
 const f=await terminalFixture();const unknown={...f.evidence,accounting:{kind:'unknown' as const,modelCostUsd:.02,detail:'Original provider billed cost unavailable'}}
 const first=await f.service.terminal(f.handle,{phase:'failed',state:{},evidence:unknown})
 expect(first.record).toMatchObject({effect:'none',accounting:'unknown',outcome:'failed',settlement:'unresolved'})
 await expect(f.service.terminal(first.handle,{phase:'settled',state:{},evidence:{...f.evidence,outcome:'succeeded'}})).rejects.toMatchObject({code:'operation_terminal_conflict'})
 const refined=await f.service.terminal(first.handle,{phase:'failed',state:{},evidence:f.evidence})
 expect(refined.record.settlement).toBe('settled');expect((await f.service.events('project',input.id)).filter(e=>e.type==='terminal_evidence_committed')).toHaveLength(2)
})
test('custom provider SDK estimate cannot establish a reported bill',async()=>{
 const f=await terminalFixture();const result=await f.service.terminal(f.handle,{phase:'failed',state:{},evidence:{...f.evidence,accounting:{kind:'known',source:'provider',modelCostUsd:.02,sessionIds:['ses_real']}}})
 expect(result.record).toMatchObject({accounting:'unknown',outcome:'failed',settlement:'unresolved'})
})

test('prepared original request settles failure only with its terminal run identity',async()=>{
 const f=await terminalFixture(),requestId='original-request',runId='run_'+(await import('node:crypto')).createHash('sha256').update('project:'+requestId).digest('hex')
 const prepared=await f.service.prepareScientificDispatch(f.handle,requestId)
 await f.store.mutate('project',state=>{state.runs[runId]=ResearchDomain.Run.parse({id:runId,trialId:'trl_original',status:'running',bundlePath:'original/bundle.json',outputPath:'original/output',createdAt:f.now()})})
 const evidence={...f.evidence,effects:{kind:'receipts' as const,receiptIds:[runId]}}
 await expect(f.service.terminal(prepared.handle,{phase:'failed',state:{},evidence})).rejects.toMatchObject({code:'original_effect_unresolved'})
 await f.store.mutate('project',state=>{state.runs[runId]!.status='failed';state.runs[runId]!.error='original worker failure'})
 const terminal=await f.service.terminal(prepared.handle,{phase:'failed',state:{guideStatus:'unevaluated'},evidence})
 expect(terminal.record).toMatchObject({effect:'settled',accounting:'settled',outcome:'failed',settlement:'settled'})
})

test('no-dispatch census includes standalone original trial identity even when the current slot lost its run',async()=>{
 const f=fixture(),originalJobId='job_skill_original'
 const record=await f.service.open('project',{...input,scientificDispatch:{version:1,status:'not_started',originalJobId,requestIds:[]}})
 const handle=await f.service.acquire('project',input.id,{mode:'run',leaseMs:1000})
 await f.store.mutate('project',state=>{
  state.trials.trl_original=ResearchDomain.Trial.parse({id:'trl_original',experimentId:'exp_original',origin:{jobId:originalJobId,phase:'shadow:1:parent:trial'},hypothesis:'Original unobserved dispatch',designAdapter:'mock',programPath:'original.py',programHash:'sha256:'+'a'.repeat(64),status:'failed',createdAt:f.now(),updatedAt:f.now()})
  state.runs.run_stray=ResearchDomain.Run.parse({id:'run_stray',trialId:'trl_original',status:'failed',bundlePath:'original/bundle.json',outputPath:'original/output',createdAt:f.now()})
 })
 await expect(f.service.terminal(handle,{phase:'failed',state:{},evidence:{version:1,operationId:record.id,identityHash:record.identityHash,outcome:'failed',effects:{kind:'none',originalJobId,requestIds:[]},accounting:fixtureAccounting}})).rejects.toMatchObject({code:'dispatch_absence_unproven'})
 await expect(f.store.mutate('project',state=>{state.operations[input.id]!.scientificDispatch!.originalJobId='job_invented'})).rejects.toThrow('boundary cannot regress')
})
