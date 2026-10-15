import {nativeFixtureRoot} from './native-fixture'
import {afterEach, expect, spyOn, test} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchPrograms } from "@autofold/science-core/programs"
import { ResearchService } from "@autofold/science-core/service"
import { StorageResearchStore } from "@autofold/science-core/store"
import { ScientificExecution, LocalWorkerTransport, ReceiptUnresolvedError, fileHash, type ExecutionTransport } from "./index"
import {verifiedComparisonProvenance} from '../decision-memory'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true}) })
async function fixture(options: {deadlineMs?: number; transport?: ExecutionTransport; workerRoot?: string; evaluatorHash?: string; gpuHours?: number; maxCandidates?: number; designAdapter?: "mock" | "proto"} = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "execution-bridge-")); roots.push(workspace)
  const projectId = "offline_test"
  const store = new StorageResearchStore({directory: path.join(workspace, "research")})
  const research = new ResearchService.Service(store)
  const execution = new ScientificExecution({workspace, projectId, research, workerRoot:options.workerRoot, transport: options.transport,
    authorization: {deadlineMs: options.deadlineMs, remote: true, maximumCandidates: options.maxCandidates}})
  const evaluator = (await execution.evaluators())[0]!
  const campaign = await research.createCampaign(projectId, {objective: "Verify worker plumbing only"})
  await research.activateCampaign(projectId, campaign.id)
  const experiment = await research.createExperiment(projectId, campaign.id, {contract: {
    version: 1, objective: "Plumbing-only fixture", targetArtifactHash: `sha256:${"a".repeat(64)}`, modality: "short_peptide",
    budget: {maximumCandidates: 8, gpuHours: options.gpuHours ?? 0, wallTimeMinutes: 1},
    evaluator: {...evaluator, sourceHash: options.evaluatorHash ?? evaluator.sourceHash, fixedSeeds: [7, 11], submissionSize: 3},
  }})
  await research.activateExperiment(projectId, experiment.id)
  await fs.writeFile(path.join(workspace, "trial.py"), options.designAdapter === "proto" ? ResearchPrograms.nativeProtoTemplate({intent:"optimize",portfolio:false,hypothesis:"Deterministic smoke"}) + '\nfrom autofold_worker.proto_trial import ProtoTrial\ndef build_trial(ctx):\n    return ProtoTrial(program=_build_program(ctx), search=_native_search(ctx), hypothesis="Deterministic smoke", intent="optimize")\n' : "raise RuntimeError('Mock must not execute arbitrary authored Python')\n")
  const trial = await research.createTrial(projectId, experiment.id, {hypothesis: "Deterministic smoke", designAdapter: options.designAdapter ?? "mock", executionProtocol: options.designAdapter === "proto" ? "native_search_v1" : undefined, programPath: "trial.py", programHash: await fileHash(path.join(workspace, "trial.py"))})
  return {workspace, projectId, store, research, execution, trial, experiment}
}

for (const status of ["failed", "cancelled"] as const) test(`original ${status} transport receipt verifies after restart without external calls`, async () => {
  let dispatches = 0
  const f = await fixture({transport: {kind: "remote", dispatch: async () => {dispatches++; return {status, error: "Original terminal effect"}}}})
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: `terminal-${status}`})).rejects.toThrow()
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  const forbid = async (): Promise<never> => {throw new Error("Receipt verification must not call transport")}
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research,
    transport: {kind: "remote", dispatch: forbid, reconcile: forbid}})
  const receipt = await restarted.failureReceipt(run.id)
  expect(receipt).toMatchObject({runId: run.id, trialId: f.trial.id, requestId: `terminal-${status}`, status, transportStatus: status})
  expect(dispatches).toBe(1)
  const file = path.join(f.workspace, ".autofold/runs", run.id, "transport-terminal.json")
  const evidence = await Bun.file(file).json()
  await fs.chmod(file, 0o600)
  await fs.writeFile(file, JSON.stringify({...evidence, trialId: "different-original"}))
  await expect(restarted.failureReceipt(run.id)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await fs.rm(file)
  await expect(restarted.failureReceipt(run.id)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(dispatches).toBe(1)
})

test("original frozen evaluator and worker closure reconcile after installed source upgrades", async () => {
  const worker=await fs.mkdtemp(path.join(os.tmpdir(),"frozen-worker-upgrade-"));roots.push(worker)
  await fs.cp(path.resolve(import.meta.dir,"../../../worker"),worker,{recursive:true,filter:file=>!file.includes("/tests")&&!file.includes("__pycache__")})
  const local=new LocalWorkerTransport()
  const f=await fixture({workerRoot:worker,transport:{kind:"local",dispatch:async input=>{await local.dispatch(input);throw new ReceiptUnresolvedError(input.runId,"Host died before import")},reconcile:input=>local.reconcile(input)}})
  const input={trialId:f.trial.id,requestId:"original-worker-upgrade"}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await fs.appendFile(path.join(worker,"autofold_worker/evaluate.py"),"\n# Installed upgrade after original execution\n")
  const restarted=new ScientificExecution({workspace:f.workspace,projectId:f.projectId,research:f.research,workerRoot:worker,transport:new LocalWorkerTransport()})
  const result=await restarted.reconcile(input)
  expect(result.run.status).toBe("succeeded")
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
  const frozen=path.join(f.workspace,".autofold/runs",result.run.id,"worker/autofold_worker/evaluate.py")
  await fs.chmod(frozen,0o600);await fs.appendFile(frozen,"\n# Tampered original closure\n")
  await expect(restarted.artifacts(result.run.id)).rejects.toThrow("implementation closure changed")
})

test("local launch bookkeeping failure preserves a live run for receipt-only recovery",async()=>{
  const local=new LocalWorkerTransport();let launches=0
  const f=await fixture({transport:{kind:'local',dispatch:async input=>{
    launches++
    return local.dispatch({...input,onStarted:async()=>{await input.onStarted?.();throw new Error('Host projection interrupted after launch')}})
  },reconcile:input=>local.reconcile(input)}})
  const input={trialId:f.trial.id,requestId:'local-post-launch-bookkeeping'}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const run=Object.values((await f.store.read(f.projectId)).runs)[0]!
  expect(run.status).toBe('running')
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(0)
  await expect(f.execution.failureReceipt(run.id)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  let receipt:Awaited<ReturnType<ScientificExecution['artifacts']>>|undefined
  for(let attempt=0;attempt<100;attempt++){
    try{receipt=await f.execution.reconcile(input);break}catch(error){if(!(error instanceof ReceiptUnresolvedError))throw error;await Bun.sleep(20)}
  }
  expect(receipt?.run.status).toBe('succeeded')
  expect(launches).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
})

test("remote terminal failure overrides a complete local manifest during recovery", async () => {
  const local = new LocalWorkerTransport()
  let observations = 0
  const f = await fixture({transport:{kind:"remote", dispatch:async input => {
    await local.dispatch(input)
    throw new ReceiptUnresolvedError(input.runId,"Disconnected after artifacts arrived")
  }, reconcile:async () => {observations++; return {status:"failed",error:"Frozen remote wall-time budget exceeded"}}}})
  const input = {trialId:f.trial.id,requestId:"manifest-before-timeout"}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await expect(f.execution.reconcile(input)).rejects.toThrow("wall-time budget exceeded")
  expect(observations).toBe(1)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.runs)[0]!.status).toBe("failed")
  expect(Object.values(state.evaluations)).toHaveLength(0)
})

test("local launch rechecks scope after replay-safe preflight", async () => {
  const local = new LocalWorkerTransport()
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture({transport:{kind:"local",preflight:async () => {
    await f.store.mutate(f.projectId,state => {state.experiments[f.experiment.id]!.status="paused"})
  },dispatch:input => local.dispatch(input)}})
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:"local-revoked-before-spawn"})).rejects.toThrow("scope no longer permits")
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  expect(await Bun.file(path.join(f.workspace,run.outputPath,"manifest.json")).exists()).toBe(false)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(0)
})

test("concurrent finalizers reuse only the same verified receipt", async () => {
  const local = new LocalWorkerTransport()
  const f = await fixture({transport:{kind:"remote", dispatch:async input => {
    await local.dispatch(input)
    throw new ReceiptUnresolvedError(input.runId,"Completion not yet committed")
  },reconcile:async () => ({status:"succeeded"})}})
  const input = {trialId:f.trial.id,requestId:"two-finalizers"}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const results = await Promise.all([f.execution.reconcile(input),f.execution.reconcile(input)])
  expect(results[0].run.id).toBe(results[1].run.id)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
  const receipt = results[0]
  await expect(f.research.completeRun(f.projectId,receipt.run.id,{...receipt.evaluation,score:999},receipt.run.manifestHash!)).rejects.toMatchObject({data:{code:"run_receipt_conflict"}})
})

test("actual Python mock worker commits one verified SQLite evaluation and durable duplicate reuses it", async () => {
  let dispatches = 0
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", dispatch: async input => {dispatches++; return local.dispatch(input)}}})
  const receipt = await f.execution.evaluateTrial({trialId: f.trial.id, requestId: "request-1"})
  expect(receipt.run.status).toBe("succeeded")
  expect(receipt.evidenceKind).toBe("plumbing_only")
  expect(receipt.scientific).toBe(false)
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: new ResearchService.Service(new StorageResearchStore({directory: path.join(f.workspace, "research")})), transport: {kind: "local", dispatch: async () => { throw new Error("Must not redispatch") }}})
  const duplicate = await restarted.evaluateTrial({trialId: f.trial.id, requestId: "request-1"})
  expect(duplicate.run.id).toBe(receipt.run.id)
  expect(dispatches).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
  const requestHash = new Bun.CryptoHasher("sha256").update("request-1").digest("hex")
  await fs.mkdir(path.join(f.workspace, ".autofold", "execution", f.projectId, `${requestHash}.json.lock`))
  expect((await restarted.evaluateTrial({trialId: f.trial.id, requestId: "request-1"})).run.id).toBe(receipt.run.id)
})

test("concurrent same request dispatches once", async () => {
  let count = 0
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", dispatch: async input => {count++; return local.dispatch(input)}}})
  const receipts = await Promise.all([f.execution.evaluateTrial({trialId: f.trial.id, requestId: "concurrent"}), f.execution.evaluateTrial({trialId: f.trial.id, requestId: "concurrent"})])
  expect(receipts[0].run.id).toBe(receipts[1].run.id)
  expect(count).toBe(1)
})

test("tampered result is rejected on every duplicate read", async () => {
  const f = await fixture()
  const receipt = await f.execution.evaluateTrial({trialId: f.trial.id, requestId: "tamper"})
  const resultPath = path.join(f.workspace, receipt.run.outputPath, "result.json")
  const result = await Bun.file(resultPath).json(); result.score = 999
  await fs.writeFile(resultPath, JSON.stringify(result))
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "tamper"})).rejects.toThrow("manifest does not match result")
})

test("tampered manifest with recomputed result hash still fails persisted receipt hash", async () => {
  const f = await fixture()
  const receipt = await f.execution.evaluateTrial({trialId: f.trial.id, requestId: "manifest"})
  const output = path.join(f.workspace, receipt.run.outputPath)
  const result = await Bun.file(path.join(output, "result.json")).json(); result.score = 999
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result))
  const manifest = await Bun.file(path.join(output, "manifest.json")).json(); manifest.files.result = await fileHash(path.join(output, "result.json"))
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest))
  await expect(f.execution.artifacts(receipt.run.id)).rejects.toThrow("persisted hash")
})

test("result tampering before promotion creates no locked evaluation", async () => {
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", dispatch: async input => {
    const done = await local.dispatch(input)
    const file = path.join(input.outputPath, "result.json")
    const result = await Bun.file(file).json(); result.programHash = `sha256:${"f".repeat(64)}`
    await fs.writeFile(file, JSON.stringify(result)); return done
  }}})
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "pre-promotion"})).rejects.toThrow("frozen experiment")
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(0)
  expect((await f.research.getTrialContext(f.projectId, f.trial.id)).trial.status).toBe("failed")
})

test("frozen evaluator and program mismatches fail before run reservation", async () => {
  const f = await fixture({evaluatorHash: `sha256:${"f".repeat(64)}`})
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "mismatch"})).rejects.toThrow("frozen contract")
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
  const g = await fixture()
  await fs.writeFile(path.join(g.workspace, "trial.py"), "changed")
  await expect(g.execution.validateTrial({trialId: g.trial.id})).rejects.toThrow("program hash")
})

test("host candidate budget and mock GPU authority fail closed", async () => {
  const f = await fixture({maxCandidates: 2})
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "budget"})).rejects.toThrow("Candidate budget")
  const g = await fixture({gpuHours: 1})
  await expect(g.execution.evaluateTrial({trialId: g.trial.id, requestId: "gpu"})).rejects.toThrow("GPU authority")
  expect(Object.values((await g.store.read(g.projectId)).runs)).toHaveLength(0)
})

test("lexical and symlink program escapes are rejected", async () => {
  const f = await fixture()
  await fs.unlink(path.join(f.workspace, "trial.py"))
  await fs.symlink(path.join(os.tmpdir(), "outside.py"), path.join(f.workspace, "trial.py"))
  await expect(f.execution.validateTrial({trialId: f.trial.id})).rejects.toThrow("symbolic link")
})

test("ambiguous remote receipt remains pending across retries without redispatch or scientific failure", async () => {
  let dispatches = 0
  const f = await fixture({transport: {kind: "remote", dispatch: async input => {dispatches++; throw new ReceiptUnresolvedError(input.runId, "connection lost")}}})
  for (let n = 0; n < 2; n++) await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "uncertain"})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const state = await f.store.read(f.projectId)
  expect(dispatches).toBe(1)
  expect(Object.values(state.runs)[0]!.status).toBe("queued")
  expect(Object.values(state.knowledge).filter(x => x.type === "Research Failure")).toHaveLength(0)
})

test("cancellation stops local worker and records cancelled without failure evidence", async () => {
  const f = await fixture()
  const abort = new AbortController()
  const original = new LocalWorkerTransport()
  const execution = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, transport: {kind: "local", dispatch: async input => {
    const task = original.dispatch({...input, command: ["python3", "-c", "import time; time.sleep(30)"]})
    setTimeout(() => abort.abort(), 50)
    return task
  }}})
  await expect(execution.evaluateTrial({trialId: f.trial.id, requestId: "cancel", signal: abort.signal})).rejects.toThrow("cancelled")
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.runs)[0]!.status).toBe("cancelled")
  expect(Object.values(state.knowledge).filter(x => x.type === "Research Failure")).toHaveLength(0)
})


test("Proto requires explicit local authorization before authored-code inspection", async () => {
  const f = await fixture({designAdapter: "proto"})
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: "denied-proto"})).rejects.toThrow("explicit host authorization")
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})

const nativeRoot = nativeFixtureRoot
const nativePython = path.resolve(import.meta.dir, "../../../../.autofold/envs/proto/bin/python")
const nativeInstalled = await Promise.all([fs.access(nativePython), fs.access(path.join(nativeRoot, "proto-tools"))]).then(() => true, () => false)
;(nativeInstalled ? test : test.skip)("native CPU Proto smoke is a heuristic fixture with zero GPU authority", async () => {
  const f = await fixture({designAdapter: "proto"})
  async function commit(directory: string) {
    const process = Bun.spawn(["git", "-C", directory, "rev-parse", "HEAD"], {stdout: "pipe", stderr: "pipe"})
    const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()])
    if (code) throw new Error("Cannot pin fixture Proto checkout")
    return stdout.trim()
  }
  const execution = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research,
    inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},
    proto: {root: nativeRoot, python: nativePython, languageCommit: await commit(nativeRoot), toolsCommit: await commit(path.join(nativeRoot, "proto-tools"))},
    authorization: {localProto: true, maximumGpuSeconds: 0, maximumCandidates: 8, maximumWallTimeMinutes: 1}})
  const receipt = await execution.evaluateTrial({trialId: f.trial.id, requestId: "native-cpu-fixture"})
  expect(receipt.run.status).toBe("succeeded")
  expect(receipt.evidenceKind).toBe("plumbing_only")
  expect(receipt.scientific).toBe(false)
  expect(receipt.generationRuns?.entries.length).toBe(3)
  const artifactPath = path.join(f.workspace, receipt.run.outputPath, receipt.generationRuns!.entries[0]!.artifactPath)
  await fs.writeFile(artifactPath, "{}")
  await expect(execution.artifacts(receipt.run.id)).rejects.toThrow("generation artifact no longer matches")
}, 30000)

;(nativeInstalled ? test : test.skip)("actual scoped native portfolio preserves independent settings and seeds, captures both pools and reopens without dispatch", async () => {
  const f = await fixture()
  const source = ResearchPrograms.nativeProtoTemplate({portfolio:true,intent:'optimize',hypothesis:'Independent native CPU lanes form one admitted pool'})
  const program = await ResearchPrograms.author(f.workspace,{hypothesis:'Independent native CPU lanes form one admitted pool',designAdapter:'proto',program:source})
  const commit = async (root:string) => (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim()
  const local = new LocalWorkerTransport();let dispatches=0
  const options={workspace:f.workspace,projectId:f.projectId,research:f.research,
    proto:{root:nativeRoot,python:nativePython,languageCommit:await commit(nativeRoot),toolsCommit:await commit(path.join(nativeRoot,'proto-tools'))},
    inspectionBoundary:{containment:async (command:string[])=>command,containmentName:'trusted_offline_cpu_fixture'},
    authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},
    transport:{kind:'local' as const,dispatch:async (input:Parameters<LocalWorkerTransport['dispatch']>[0])=>{dispatches++;return local.dispatch(input)}}}
  const execution=new ScientificExecution(options)
  const context=await f.research.getTrialContext(f.projectId,f.trial.id)
  const admitted=await execution.inspectProgram({...context,programPath:program.programPath,programHash:program.programHash})
  expect(admitted.nativeExecution?.observation).toBe('scoped_native_lifecycle_v1')
  const native=admitted.authored!.nativeSearch!
  expect(native.projection.map(lane=>lane.programSeed)).toEqual([7,8])
  expect(native.projection.map(lane=>lane.name)).toEqual(['baseline-draw','independent-draw'])
  expect(native.projection.map(lane=>lane.stages[0]!.config.num_samples)).toEqual([8,8])
  expect(native.projection.map(lane=>lane.stages[0]!.config.num_results)).toEqual([3,3])
  expect(native.budget.maximumCandidates).toBe(6)
  const trial=await f.research.createTrial(f.projectId,f.experiment.id,{...program,...admitted.authored.declaration,hypothesis:'Independent native CPU lanes form one admitted pool',designAdapter:'proto',executionProtocol:admitted.authored.executionProtocol})
  const receipt=await execution.evaluateTrial({trialId:trial.id,requestId:'native-scoped-portfolio'})
  expect(receipt.candidates.candidates).toHaveLength(6)
  expect(receipt.nativeExecution?.resources.reservedSearchComputeSeconds).toBe(0)
  expect(receipt.generationRuns?.entries).toHaveLength(6)
  const captured=await Bun.file(path.join(f.workspace,receipt.run.outputPath,'native-search/receipt.json')).json()
  expect(captured.lanes).toHaveLength(2)
  expect(captured.laneFailures).toEqual([])
  expect(captured.lanes.every((lane:any)=>lane.stages[0].history.length>0)).toBe(true)
  expect(captured.counts.samplingCalls).toBeGreaterThan(0)
  expect(captured.admission).toEqual(native)
  const forbid=async():Promise<never>=>{throw new Error('Receipt reopen must not dispatch')}
  const reopened=new ScientificExecution({...options,transport:{kind:'local',dispatch:forbid,reconcile:forbid}})
  expect((await reopened.evaluateTrial({trialId:trial.id,requestId:'native-scoped-portfolio'})).manifest).toEqual(receipt.manifest)
  const verifiedArtifacts=await reopened.artifacts(receipt.run.id)
  const comparison=verifiedComparisonProvenance(verifiedArtifacts,trial.workflowFingerprint)
  expect(comparison).toMatchObject({status:'verified',conditions:{contractHash:f.experiment.contractHash,evaluationSeeds:[7,11],evaluator:{direction:f.experiment.contract.evaluator.direction}},
    admittedDesign:{protocol:'native_search_v1',projection:[{programSeed:7},{programSeed:8}]},workflowFingerprint:trial.workflowFingerprint??null})
  expect(comparison.unknownFields).toEqual([])
  expect(dispatches).toBe(1)
}, 60000)

;(nativeInstalled ? test : test.skip)("actual scoped fixed control freezes a pool of two independently of evaluator Top N one with no sampling or requests", async () => {
  const f=await fixture(),context=await f.research.getTrialContext(f.projectId,f.trial.id)
  const experiment=await f.research.createExperiment(f.projectId,context.campaign.id,{contract:{...f.experiment.contract,evaluator:{...f.experiment.contract.evaluator,submissionSize:1}}})
  await f.research.activateExperiment(f.projectId,experiment.id)
  const source=`from contextlib import nullcontext
from proto_language.core import Program, Construct, Segment, Constraint, Sequence
from proto_language.constraint.protein_quality import protein_length_constraint
from proto_language.constraint.protein_quality.protein_length_constraint import ProteinLengthConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeFixedControl, NativeOutput
def build_trial(ctx):
    segment=Segment(sequence="ACDEFGHIKLMNPQRSTVWYACDEF",sequence_type="protein",label="peptide")
    segment.result_sequences=[Sequence("ACDEFGHIKLMNPQRSTVWYACDEF","protein"),Sequence("CDEFGHIKLMNPQRSTVWYACDEFGH","protein")]
    optimizer=RejectionSamplingOptimizer([Construct([segment],label="control")],[],[Constraint([segment],protein_length_constraint,ProteinLengthConfig(min_length=24,max_length=24))],config=RejectionSamplingOptimizerConfig(proposal_source="existing_results",num_samples=2,num_results=2,proposal_batch_size=2))
    return ProtoTrial(Program([optimizer],2,seed=ctx.seeds[0],compute=nullcontext()),"Original native fixed panel remains unchanged",intent="calibrate",calibration_class="neutral",fixed_control=NativeFixedControl(5,(NativeOutput("control"),)))
`
  const program=await ResearchPrograms.author(f.workspace,{hypothesis:'Original native fixed panel remains unchanged',designAdapter:'proto',program:source})
  const commit=async(root:string)=>(await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim()
  const execution=new ScientificExecution({workspace:f.workspace,projectId:f.projectId,research:f.research,
    proto:{root:nativeRoot,python:nativePython,languageCommit:await commit(nativeRoot),toolsCommit:await commit(path.join(nativeRoot,'proto-tools'))},
    inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1}})
  const admitted=await execution.inspectProgram({campaign:context.campaign,experiment, ...program})
  const trial=await f.research.createTrial(f.projectId,experiment.id,{...program,hypothesis:admitted.authored.hypothesis,intent:'calibrate',calibrationClass:'neutral',designAdapter:'proto',executionProtocol:admitted.authored.executionProtocol})
  const receipt=await execution.evaluateTrial({trialId:trial.id,requestId:'native-scoped-fixed-pool'})
  expect(receipt.candidates.candidates.map(item=>item.sequence)).toEqual(['ACDEFGHIKLMNPQRSTVWYACDEF','CDEFGHIKLMNPQRSTVWYACDEFGH'])
  expect(receipt.nativeExecution?.outputs).toHaveLength(1)
  expect(receipt.nativeExecution?.resources.reservedSearchComputeSeconds).toBe(0)
  expect(receipt.nativeSearch?.counts).toEqual({proposals:0,samplingCalls:0,toolCalls:0})
  expect(experiment.contract.evaluator.submissionSize).toBe(1)
},60000)


test("restart recovers crash after snapshot rename before external request record and dispatches once", async () => {
  let dispatches = 0
  const local = new LocalWorkerTransport()
  const transport: ExecutionTransport = {kind: "local", dispatch: async input => {dispatches++; return local.dispatch(input)}}
  const f = await fixture({transport})
  const input = {trialId: f.trial.id, requestId: "snapshot-publication-crash"}
  const requestHash = new Bun.CryptoHasher("sha256").update(input.requestId).digest("hex")
  const requestPath = path.join(f.workspace, ".autofold", "execution", f.projectId, `${requestHash}.json`)
  const actualRename = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    await actualRename(source, destination)
    if (/\/run_[a-f0-9]{64}$/.test(String(destination))) throw new Error("Simulated crash after snapshot publication")
  })
  try { await expect(f.execution.evaluateTrial(input)).rejects.toThrow("Simulated crash") }
  finally { rename.mockRestore() }
  expect(await Bun.file(requestPath).exists()).toBe(false)
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
  expect(dispatches).toBe(0)
  // A real process death leaves its advisory directory lock behind.
  await fs.mkdir(`${requestPath}.lock`)
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: new ResearchService.Service(new StorageResearchStore({directory: path.join(f.workspace, "research")})), transport})
  const attempts = await Promise.allSettled([restarted.evaluateTrial(input), restarted.reconcile(input)])
  const completed = attempts.find(attempt => attempt.status === "fulfilled")
  expect(completed?.status).toBe("fulfilled")
  if (completed?.status !== "fulfilled") throw new Error("Neither recovery contender completed")
  const receipt = completed.value
  expect(receipt.run.status).toBe("succeeded")
  expect((await restarted.evaluateTrial(input)).run.id).toBe(receipt.run.id)
  expect(dispatches).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(1)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
})

test("stale lock and missing external request index reconcile a dispatched receipt without relaunch", async () => {
  let dispatches = 0
  const local = new LocalWorkerTransport()
  const transport: ExecutionTransport = {kind: "remote", reconcile: async () => ({status:"succeeded"}), dispatch: async input => {
    dispatches++
    await local.dispatch(input)
    throw new ReceiptUnresolvedError(input.runId, "owner died after worker completion")
  }}
  const f = await fixture({transport})
  const input = {trialId: f.trial.id, requestId: "completed-before-owner-death"}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const requestHash = new Bun.CryptoHasher("sha256").update(input.requestId).digest("hex")
  const requestPath = path.join(f.workspace, ".autofold", "execution", f.projectId, `${requestHash}.json`)
  await fs.unlink(requestPath)
  await fs.mkdir(`${requestPath}.lock`)
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, transport, authorization: {remote: true}})
  const receipt = await restarted.reconcile(input)
  expect(receipt.run.status).toBe("succeeded")
  expect(dispatches).toBe(1)
  expect((await restarted.evaluateTrial(input)).run.id).toBe(receipt.run.id)
})

test("dispatch fence survives interrupted owner without artifacts and forbids replay", async () => {
  let dispatches = 0
  const transport: ExecutionTransport = {kind: "remote", dispatch: async input => {dispatches++; throw new ReceiptUnresolvedError(input.runId, "unreachable")}}
  const f = await fixture({transport})
  const input = {trialId: f.trial.id, requestId: "fence-must-survive"}
  await expect(f.execution.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const requestHash = new Bun.CryptoHasher("sha256").update(input.requestId).digest("hex")
  const requestPath = path.join(f.workspace, ".autofold", "execution", f.projectId, `${requestHash}.json`)
  await fs.unlink(requestPath)
  await fs.mkdir(`${requestPath}.lock`)
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, transport, authorization: {remote: true}})
  await expect(restarted.evaluateTrial(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await expect(restarted.reconcile(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(dispatches).toBe(1)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.runs)).toHaveLength(1)
  expect(Object.values(state.evaluations)).toHaveLength(0)
  expect(Object.values(state.knowledge).filter(x => x.type === "Research Failure")).toHaveLength(0)
})

test("empty leftover advisory lock before any intent does not prevent safe first dispatch", async () => {
  let dispatches = 0
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", dispatch: async input => {dispatches++; return local.dispatch(input)}}})
  const input = {trialId: f.trial.id, requestId: "crashed-immediately-after-lock"}
  const hash = new Bun.CryptoHasher("sha256").update(input.requestId).digest("hex")
  const lock = path.join(f.workspace, ".autofold/execution", f.projectId, `${hash}.json.lock`)
  await fs.mkdir(lock, {recursive: true})
  const receipt = await f.execution.evaluateTrial(input)
  expect(receipt.run.status).toBe("succeeded")
  expect(dispatches).toBe(1)
  expect((await fs.stat(lock)).isDirectory()).toBe(true)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
})

test("different trials competing for one unpublished request cannot change the winning binding or duplicate dispatch", async () => {
  let workspace = ""
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", dispatch: async input => {
    await fs.appendFile(path.join(workspace, "dispatches.log"), "parent\n")
    return local.dispatch(input)
  }}})
  workspace = f.workspace
  const other = await f.research.createTrial(f.projectId, f.experiment.id, {hypothesis: "Competing bound trial", designAdapter: "mock", programPath: "trial.py", programHash: f.trial.programHash})
  const input = {trialId: f.trial.id, requestId: "competing-trial-binding"}
  let release!: () => void, reached!: () => void
  const pause = new Promise<void>(resolve => {release = resolve})
  const atPublication = new Promise<void>(resolve => {reached = resolve})
  const actualRename = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (/\/run_[a-f0-9]{64}$/.test(String(destination))) {reached(); await pause}
    await actualRename(source, destination)
  })
  const owner = f.execution.evaluateTrial(input).then(value => ({value, error: undefined}), error => ({value: undefined, error}))
  try {
    await atPublication
    const script = path.join(workspace, "competing-process.ts")
    await fs.writeFile(script, [
      `import fs from "node:fs/promises"`,
      `import {ScientificExecution, LocalWorkerTransport} from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))}`,
      `import {ResearchService} from ${JSON.stringify(path.resolve(import.meta.dir, "../../../science-core/src/research/service.ts"))}`,
      `import {StorageResearchStore} from ${JSON.stringify(path.resolve(import.meta.dir, "../../../science-core/src/research/store.ts"))}`,
      `const workspace = ${JSON.stringify(workspace)}, projectId = ${JSON.stringify(f.projectId)}`,
      `const local = new LocalWorkerTransport()`,
      `const execution = new ScientificExecution({workspace, projectId, research: new ResearchService.Service(new StorageResearchStore({directory:workspace + "/research"})), transport: {kind:"local", dispatch: async input => {await fs.appendFile(workspace + "/dispatches.log", "child\\n"); return local.dispatch(input)}}})`,
      `const result = await execution.evaluateTrial(${JSON.stringify({...input, trialId: other.id})})`,
      `process.stdout.write(JSON.stringify({runId: result.run.id, trialId: result.run.trialId}))`,
    ].join("\n"))
    const child = Bun.spawn([process.execPath, script], {cwd: workspace, stdout: "pipe", stderr: "pipe"})
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout).trialId).toBe(other.id)
    release()
    const result = await owner
    expect(result.error?.message).toContain("another trial or project")
    expect(await fs.readFile(path.join(workspace, "dispatches.log"), "utf8")).toBe("child\n")
    const state = await f.store.read(f.projectId)
    expect(Object.values(state.runs)).toHaveLength(1)
    expect(Object.values(state.evaluations)).toHaveLength(1)
    expect(state.trials[f.trial.id]!.status).toBe("proposed")
  } finally {release(); rename.mockRestore(); await owner}
}, 15000)

test("abort during output mkdir is noticed before spawning the local worker", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "transport-mkdir-abort-")); roots.push(workspace)
  const output = path.join(workspace, "output"), abort = new AbortController()
  const actualMkdir = fs.mkdir.bind(fs)
  const mkdir = spyOn(fs, "mkdir").mockImplementation((async (directory, options: any) => {
    const result = await actualMkdir(directory, options)
    if (String(directory) === output) abort.abort()
    return result
  }) as typeof fs.mkdir)
  try {
    const result = await new LocalWorkerTransport().dispatch({runId: "run_cancel_mkdir", requestId: "mkdir-cancel", workspace, bundlePath: "unused", outputPath: output,
      command: ["python3", "-c", `from pathlib import Path; Path(${JSON.stringify(path.join(workspace, "spawned"))}).touch()`], timeoutMs: 10000, signal: abort.signal})
    expect(result.status).toBe("cancelled")
    expect(await Bun.file(path.join(workspace, "spawned")).exists()).toBe(false)
  } finally {mkdir.mockRestore()}
})

test("abort during final start authorization never launches the independent local worker", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "transport-registration-abort-")); roots.push(workspace)
  const abort = new AbortController(), survivor = path.join(workspace, "survived")
  const result = await new LocalWorkerTransport().dispatch({runId:"run_cancel_registration",requestId:"registration-cancel",workspace,bundlePath:"unused",outputPath:path.join(workspace,"output"),
    command:["python3","-c",`import time; from pathlib import Path; time.sleep(0.2); Path(${JSON.stringify(survivor)}).touch(); time.sleep(30)`],timeoutMs:10000,signal:abort.signal,
    authorizeStart:async()=>{abort.abort()}})
  expect(result.status).toBe("cancelled")
  expect(await Bun.file(survivor).exists()).toBe(false)
})

test("30-day scientific timeout remains valid without timer overflow", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "transport-long-deadline-")); roots.push(workspace)
  const result = await new LocalWorkerTransport().dispatch({runId: "run_long_deadline", requestId: "long-deadline", workspace, bundlePath: "unused", outputPath: path.join(workspace, "output"),
    command: ["python3", "-c", "import time; time.sleep(0.05)"], timeoutMs: 30 * 24 * 60 * 60 * 1000})
  expect(result.status).toBe("succeeded")
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    await expect(new LocalWorkerTransport().dispatch({runId: "run_bad_timeout", requestId: "bad-timeout", workspace, bundlePath: "unused", outputPath: path.join(workspace, "unused"), command: ["python3", "-c", "pass"], timeoutMs})).rejects.toThrow("positive, finite")
  }
  expect(await Bun.file(path.join(workspace, "unused")).exists()).toBe(false)
})


test("transport staging failure creates no launch fence and the same prepared request retries once", async () => {
  let preparations = 0, dispatches = 0
  const local = new LocalWorkerTransport()
  const f = await fixture({transport: {kind: "local", preflight: async () => {
    preparations++; if (preparations === 1) throw new Error("Host staging unavailable before launch")
  }, dispatch: async input => {dispatches++; return local.dispatch(input)}}})
  const input = {trialId: f.trial.id, requestId: "retryable-preflight"}
  await expect(f.execution.evaluateTrial(input)).rejects.toThrow("staging unavailable")
  const pending = Object.values((await f.store.read(f.projectId)).runs)[0]!
  expect(pending.status).toBe("queued")
  expect(await Bun.file(path.join(f.workspace, ".autofold/runs", pending.id, "dispatch.json")).exists()).toBe(false)
  const result = await f.execution.evaluateTrial(input)
  expect(result.run.status).toBe("succeeded")
  expect(preparations).toBe(2)
  expect(dispatches).toBe(1)
  await f.execution.evaluateTrial(input)
  expect(dispatches).toBe(1)
})


test("execution freezes the host deadline and reopens its original receipt after expiry without dispatch", async () => {
  const deadline = Date.now() + 60000, f = await fixture({deadlineMs: deadline})
  const input = {trialId: f.trial.id, requestId: "host-deadline-receipt"}
  const result = await f.execution.evaluateTrial(input)
  const request = await Bun.file(path.join(f.workspace, ".autofold/runs", result.run.id, "request.json")).json()
  expect(request.authorizationDeadlineMs).toBe(deadline)
  let launches = 0
  const restarted = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research,
    authorization: {deadlineMs: 1}, transport: {kind: "local", dispatch: async () => {launches++; throw new Error("No launch after expiry")}}})
  const reopened = await restarted.evaluateTrial(input)
  expect(reopened.run.id).toBe(result.run.id)
  expect(launches).toBe(0)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
  expect((await Bun.file(path.join(f.workspace, ".autofold/runs", result.run.id, "request.json")).json()).authorizationDeadlineMs).toBe(deadline)
})
