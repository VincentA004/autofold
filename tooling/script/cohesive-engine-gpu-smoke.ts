/** One isolated native search + frozen measurement. Preparation never contacts a host. */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {Application} from '../../backend/engine/src/application.ts'
import {loadExecutionConfig} from '../../backend/engine/src/config.ts'
import {workerTreeIdentity} from '../../backend/engine/src/execution/index.ts'
import {localCapabilities,assertCapabilities} from '../../backend/engine/src/execution/capabilities.ts'
import {verifyNativeRequestObservation} from '../../backend/engine/src/execution/provenance.ts'
import {ResearchDomain} from '../../backend/science-core/src/research/domain.ts'
import {ResearchArtifacts} from '../../backend/science-core/src/research/artifacts.ts'
import {ExecutionProtocol} from '../../backend/science-core/src/research/execution-protocol.ts'

const repository=path.resolve(import.meta.dir,'../..')
const refactor=path.join(repository,'.autofold/cohesive-engine-refactor-20261012')
const workspace=path.join(refactor,'final-gpu-validation'), operator=path.join(workspace,'operator')
const projectId='prj_cohesive_engine_final_gpu_20261012'
const remoteRoot='/home/vincent/.autofold-cohesive-engine-final-validation-20261012'
const protoRoot=path.join(refactor,'upstream-proto/v2/source')
const languageCommit='c11ba929677bf6feedc598dfd1e3992c30673a80'
const toolsCommit='c0fa510bce39044a9c66a2f2524976a4a2c49b18'
const targetHash='sha256:050a1caffd2415d5b408c3670b3c41b372615d7622e36ab01a7b75b11eb0e388'
const structureHash='sha256:d7351a441c34cbb9c799798425295106f25beca45428f96d8d8a8f63c586e132'
const targetSource=path.join(repository,'.autofold/cohesive-engine-validation-20261012')
const targetDirectory='.autofold/targets/'+targetHash.slice(7)
const hash=(bytes:string|Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')
const exists=(file:string)=>fs.access(file).then(()=>true,()=>false)
const json=(file:string)=>Bun.file(file).json()
const pin=async(file:string)=>({path:file,contentHash:hash(await fs.readFile(file))})
async function preservedForkManifest(source:string){
  const bytes=await fs.readFile(source),digest=hash(bytes),revision=path.basename(path.dirname(source))
  const directory=path.join(operator,'fork-manifests'),destination=path.join(directory,revision+'-'+digest.slice(7)+'.json')
  await fs.mkdir(directory,{recursive:true,mode:0o700})
  if(await exists(destination)){if(hash(await fs.readFile(destination))!==digest)throw Error('Original preserved fork manifest differs')}
  else await fs.writeFile(destination,bytes,{flag:'wx',mode:0o400})
  return {path:destination,contentHash:digest,revision,originalSource:source}
}
async function save(name:string,value:unknown,exclusive=true){
  await fs.writeFile(path.join(operator,name),JSON.stringify(value,null,2)+'\n',{flag:exclusive?'wx':'w',mode:0o600})
}
async function sourceIdentity(){
  const files:Array<{path:string;contentHash:string}>=[]
  async function visit(directory:string){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name)
      if(entry.isSymbolicLink())throw Error('Source symlinks are not a frozen implementation closure')
      if(entry.isDirectory())await visit(file)
      else if(entry.isFile()&&((entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts'))||entry.name==='SKILL.md'))
        files.push({path:path.relative(repository,file),contentHash:hash(await fs.readFile(file))})
    }
  }
  await visit(path.join(repository,'backend/engine/src'));await visit(path.join(repository,'backend/science-core/src'))
  for(const relative of ['package.json','package-lock.json','backend/engine/package.json','backend/science-core/package.json'])
    files.push({path:relative,contentHash:hash(await fs.readFile(path.join(repository,relative)))})
  files.sort((a,b)=>a.path.localeCompare(b.path))
  return {sourceHash:hash(JSON.stringify(files)),workerHash:(await workerTreeIdentity(path.join(repository,'backend/worker'))).sourceHash,files}
}
const hypothesis='A bounded native CPU mutation search can produce two independently measured length-valid peptides without host truncation or modification of native optimizer settings. This is an engineering seam test, not evidence of improved binding.'
const searchProgram=`"""Bounded CPU search. The trusted host adds the frozen scoring panel."""
from contextlib import nullcontext
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.constraint import protein_length_constraint, protein_repetitiveness_constraint
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import MCMCOptimizer, MCMCOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput

def build_trial(ctx):
    region = Segment(length=12, sequence_type="protein", label="binder")
    design = Construct([region], label="design")
    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(region)
    optimizer = MCMCOptimizer(constructs=[design], generators=[generator], constraints=[
        Constraint(inputs=[region], function=protein_length_constraint,
            function_config={"min_length":12,"max_length":12}, threshold=0.0, label="length_gate"),
        Constraint(inputs=[region], function=protein_repetitiveness_constraint,
            function_config={}, weight=1.0, label="repeat_penalty"),
    ], config=MCMCOptimizerConfig(num_results=2, num_steps=2, proposals_per_result=1,
            seed=20261012, track_proposals=True))
    decision = {"question":"Does the refactored native engine preserve a bounded two-candidate CPU search through one frozen GPU measurement panel?",
        "alternatives":[
            {"id":"native-search-panel","experiment":"Run this operator-authored native CPU search then the fixed Boltz2/Chai1 panel once.","expectedInformation":"Original native optimizer, final pool, registered cache origins, CUDA witness, and canonical closeout can be checked together.","estimatedGpuHours":600/3600},
            {"id":"cpu-only-control","experiment":"Run only the fixed native CPU control and inspect its original receipts.","expectedInformation":"Checks candidate-pool versus TopN1 semantics but cannot establish the live GPU seam.","estimatedGpuHours":0}],
        "selectedAlternativeId":"native-search-panel",
        "rationale":"The CPU prerequisite is separate; one bounded new learned-model trial is needed to test the actual execution seam. No scientific or guide acceleration is inferred.",
        "evidenceRefs":[ctx.experiment_id],
        "controlledVariables":["Original target bytes, frozen model configuration, seed20260809, candidate ceiling2, submissionTopN1, GPUreservation600s, absolutewall900s"],
        "changedVariables":["Newly tested native engine and adopted lifecycle fork with an operator-authored bounded CPU mutation program"],
        "outcomeBranches":[
            {"observation":"Original native search and frozen evaluation succeed with attributable uncached CUDA work and exact verified receipts.","nextDecision":"Report the engineering seam proof after independent shutdown, receipt-only reopen, and historical-preservation checks; do not dispatch another trial."},
            {"observation":"Admission, native lifecycle, cache/CUDA attribution, evaluation, or settlement remains failed or unknown.","nextDecision":"Preserve the original evidence and hold the validation; diagnose without replacement inference or GPU dispatch."}]}
    return ProtoTrial(program=Program([optimizer], num_results=2, compute=nullcontext()),
        hypothesis=${JSON.stringify(hypothesis)},
        decision_plan=decision, evidence_refs=(ctx.experiment_id,),
        search=NativeSearch(maximum_candidates=2, maximum_proposals=32,
            maximum_sampling_calls=16, maximum_tool_calls=16, maximum_wall_seconds=30,
            outputs=(NativeOutput(construct="design"),), allowed_tools=("random-protein-sample",)))
`
const fixedProgram=`"""Two immutable native control sequences. TopN1 is evaluator selection, not a pool clamp."""
from contextlib import nullcontext
from proto_language.core import Constraint, Construct, Program, Segment, Sequence
from proto_language.constraint.protein_quality import protein_length_constraint
from proto_language.constraint.protein_quality.protein_length_constraint import ProteinLengthConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeFixedControl, NativeOutput

def build_trial(ctx):
    region = Segment(sequence="ACDEFGHIKLMNPQRSTVWYACDEF", sequence_type="protein", label="peptide")
    region.result_sequences = [Sequence("ACDEFGHIKLMNPQRSTVWYACDEF","protein"), Sequence("CDEFGHIKLMNPQRSTVWYACDEFGH","protein")]
    optimizer = RejectionSamplingOptimizer(constructs=[Construct([region],label="control")], generators=[], constraints=[
            Constraint(inputs=[region], function=protein_length_constraint,
                function_config=ProteinLengthConfig(min_length=24,max_length=24))
        ], config=RejectionSamplingOptimizerConfig(proposal_source="existing_results",
            num_samples=2, num_results=2, proposal_batch_size=2))
    return ProtoTrial(program=Program([optimizer], num_results=2, seed=ctx.seeds[0], compute=nullcontext()), intent="calibrate", calibration_class="neutral",
        hypothesis="Two unchanged native control sequences remain in the verified pool while the frozen CPU evaluator selects TopN1. This checks infrastructure only.",
        fixed_control=NativeFixedControl(maximum_wall_seconds=5,
            outputs=(NativeOutput(construct="control"),)))
`
async function prepare(){
  if(await exists(workspace))throw Error('Fresh validation root already exists; preserve its original preparation identity')
  await fs.mkdir(operator,{recursive:true,mode:0o700})
  await save('preparation-intent.json',{preparedAt:new Date().toISOString(),workspace,projectId,remoteRoot,scope:'local-only; no staging, transfer, provider, or GPU dispatch',originalRoots:'Preserve historical baseline keys; this new root is nested under the excluded refactor root'})
  const targetFiles=[]
  for(const [name,expected] of [['target.json',targetHash],['structure.pdb',structureHash]]){
    const source=path.join(targetSource,targetDirectory,name!),destination=path.join(workspace,targetDirectory,name!)
    const bytes=await fs.readFile(source);if(hash(bytes)!==expected)throw Error('Original target bytes changed: '+source)
    await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,bytes,{flag:'wx',mode:0o400})
    targetFiles.push({original:await pin(source),copied:await pin(destination)})
  }
  await ResearchArtifacts.readTarget(workspace,targetHash)
  const oldProfile=await json(path.join(targetSource,'operator/profile.json'))
  const profile={python:oldProfile.python,workerRoot:path.join(repository,'backend/worker'),
    proto:{root:protoRoot,python:oldProfile.python,languageCommit,toolsCommit},
    remote:{host:'workstation_4090',root:remoteRoot,python:oldProfile.remote.python,
      protoRoot:'/home/vincent/Developer/autofold-proto-c11ba929-lifecycle-v2',protoHome:oldProfile.remote.protoHome,
      inspectionBubblewrap:oldProfile.remote.inspectionBubblewrap,inspectionBubblewrapSha256:oldProfile.remote.inspectionBubblewrapSha256},
    authorization:{localProto:true,remote:true,maximumGpuSeconds:600,maximumCandidates:2,maximumWallTimeMinutes:15},
    evidenceExecution:'native_tool_sequence_v1'}
  await save('profile.json',profile)
  const oldContract=await json(path.join(targetSource,'operator/contract.json'))
  const scoringPipeline=ExecutionProtocol.ScoringPipeline.parse({...oldContract.evaluator.evidenceAdapter.scoringPipeline,protoToolsCommit:toolsCommit,
    stages:oldContract.evaluator.evidenceAdapter.scoringPipeline.stages.map((stage:any)=>({...stage,models:stage.models.map((model:any)=>({...model,version:toolsCommit}))}))})
  const contract=ResearchDomain.ExperimentContract.parse({...oldContract,objective:hypothesis,
    budget:{maximumCandidates:2,gpuHours:600/3600,wallTimeMinutes:15},
    evaluator:{id:'peptide-panel',version:'1',direction:'minimize',fixedSeeds:[20260809],submissionSize:1,
      sourceHash:hash(await fs.readFile(path.join(repository,'backend/worker/autofold_worker/peptide_panel_v1.py'))),
      evidenceAdapter:{id:'proto-structure-pipeline',version:'3',sourceHash:hash(await fs.readFile(path.join(repository,'backend/worker/autofold_worker/evidence_pipeline_v3.py'))),
        scoringPipeline,scoringPipelineHash:ExecutionProtocol.hashScoringPipeline(scoringPipeline)}}})
  await save('contract.json',contract)
  await fs.writeFile(path.join(operator,'native-search.py'),searchProgram,{flag:'wx',mode:0o400})
  await fs.writeFile(path.join(operator,'native-fixed-control.py'),fixedProgram,{flag:'wx',mode:0o400})
  await save('resource-request.json',{maximumTrials:1,maximumCandidates:2,submissionSize:1,fixedSeeds:[20260809],
    maximumProviderRequests:0,providerBudgetUsd:0,sdkInferenceBudgetUsd:0,
    maximumAggregateGpuReservationSeconds:600,maximumCpuSearchWallSeconds:30,maximumAbsoluteWallSeconds:900,
    evaluationReservations:[{stage:'boltz2-score',candidateCount:2,modelCount:1,seedCount:1,perRequestSeconds:120,reservedWallSeconds:240},
      {stage:'chai1-score',candidateCount:2,modelCount:1,seedCount:1,perRequestSeconds:180,reservedWallSeconds:360}],
    measurementCardinality:4,requestMeaning:'candidate × model × seed measurements; registered request receipts and cache origins must be observed, not invented; CPU sampling scopes are separate',
    searchAndEvaluationWallReservationSeconds:630,hostAuthorization:'User requested cohesive-engine implementation and bounded live GPU validation; launch remains held until final gates and fresh host readiness'})
  const historical=path.join(refactor,'operator/historical-before.json')
  await save('payload-manifest.draft.json',{format:'autofold.cohesive-gpu-smoke-payload.v1',status:'prepared_local_not_launchable',preparedAt:new Date().toISOString(),
    workspace,projectId,remoteRoot,sourceCandidate:await sourceIdentity(),targetFiles,
    payload:await Promise.all(['profile.json','contract.json','resource-request.json','native-search.py','native-fixed-control.py'].map(name=>pin(path.join(operator,name)))),
    originalHistoricalBaseline:await pin(historical),originalHistoricalRootKeys:Object.keys(await json(historical)).sort(),
    forkManifest:await preservedForkManifest(path.join(refactor,'upstream-proto/v2/reproduced-source-manifest.json')),
    limitations:['Stage 6/7 source and fork adoption must pass before final freezing.','Fresh remote scoped fork and predictor readiness must be reverified before launch.']})
  console.log(JSON.stringify({mode:'prepared_local_only',workspace,providerCalls:0,remoteCalls:0,gpuCalls:0}))
}
async function gates(){
  const result=[]
  for(const stage of ['stage6','stage7']){
    const file=path.join(refactor,'operator/gates',stage,'gate.json'),gate=await json(file)
    if(gate.status!=='passed')throw Error('Required final gate is not passed: '+stage)
    result.push(await pin(file))
  }
  return result
}
async function assertPayload(){
  const draft=await json(path.join(operator,'payload-manifest.draft.json'))
  for(const item of [...draft.payload,...draft.targetFiles.flatMap((item:any)=>[item.original,item.copied]),draft.originalHistoricalBaseline,draft.forkManifest,...(draft.forkFinalVerification?[draft.forkFinalVerification]:[])])
    if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Prepared payload changed: '+item.path)
  return draft
}
async function refresh(){
  if(await exists(path.join(operator,'launch-fence.json'))||await exists(path.join(operator,'launch-preparation.json'))||await exists(path.join(workspace,'cpu-fixed-control')))
    throw Error('A frozen or executed original preparation cannot be revised')
  const previous=await assertPayload(),latestDirectory=path.join(refactor,'upstream-proto/v4'),verificationFile=path.join(latestDirectory,'final-verification.json')
  const latestManifest=path.join(latestDirectory,'manifest.json')
  if(!await exists(verificationFile)||!await exists(latestManifest))throw Error('Final V4 fork metadata is required before draft refresh')
  const forkFile=latestManifest,fork=await json(forkFile)
  if(!/^[a-f0-9]{40}$/.test(fork.patchedCommits?.language)||!/^[a-f0-9]{40}$/.test(fork.patchedCommits?.tools))throw Error('New verified fork manifest lacks exact package pins')
  let verification:Awaited<ReturnType<typeof preservedForkManifest>>|undefined
  if(await exists(verificationFile)){
    const proof=await json(verificationFile)
    if(proof.patchedCommits?.language!==fork.patchedCommits.language||proof.patchedCommits?.tools!==fork.patchedCommits.tools||proof.reproducedExactCommits!==true||proof.nativeGoldenEqual!==true||proof.cleanForks!==true)throw Error('Published final fork verification does not bind exact candidate pins')
    verification=await preservedForkManifest(verificationFile)
  }
  const archive=path.join(operator,'draft-revisions',crypto.randomUUID());await fs.mkdir(archive,{recursive:true,mode:0o700})
  for(const name of ['profile.json','contract.json','resource-request.json','native-search.py','native-fixed-control.py','payload-manifest.draft.json'])
    await fs.copyFile(path.join(operator,name),path.join(archive,name),fs.constants.COPYFILE_EXCL)
  const profile=await json(path.join(operator,'profile.json'))
  profile.proto={...profile.proto,root:path.join(path.dirname(forkFile),'source'),languageCommit:fork.patchedCommits.language,toolsCommit:fork.patchedCommits.tools}
  profile.remote.protoRoot='/home/vincent/Developer/autofold-proto-'+fork.patchedCommits.language.slice(0,8)+'-lifecycle-'+path.basename(path.dirname(forkFile))
  const contract=await json(path.join(operator,'contract.json'))
  const pipeline=ExecutionProtocol.ScoringPipeline.parse({...contract.evaluator.evidenceAdapter.scoringPipeline,protoToolsCommit:fork.patchedCommits.tools,
    stages:contract.evaluator.evidenceAdapter.scoringPipeline.stages.map((stage:any)=>({...stage,models:stage.models.map((model:any)=>({...model,version:fork.patchedCommits.tools}))}))})
  contract.evaluator.sourceHash=hash(await fs.readFile(path.join(repository,'backend/worker/autofold_worker/peptide_panel_v1.py')))
  contract.evaluator.evidenceAdapter={...contract.evaluator.evidenceAdapter,sourceHash:hash(await fs.readFile(path.join(repository,'backend/worker/autofold_worker/evidence_pipeline_v3.py'))),
    scoringPipeline:pipeline,scoringPipelineHash:ExecutionProtocol.hashScoringPipeline(pipeline)}
  await save('profile.json',profile,false);await save('contract.json',ResearchDomain.ExperimentContract.parse(contract),false)
  // These are operator-authored drafts, never accepted proposals or original worker receipts.
  await fs.chmod(path.join(operator,'native-search.py'),0o600);await fs.chmod(path.join(operator,'native-fixed-control.py'),0o600)
  await fs.writeFile(path.join(operator,'native-search.py'),searchProgram);await fs.writeFile(path.join(operator,'native-fixed-control.py'),fixedProgram)
  await fs.chmod(path.join(operator,'native-search.py'),0o400);await fs.chmod(path.join(operator,'native-fixed-control.py'),0o400)
  await save('payload-manifest.draft.json',{...previous,preparedAt:new Date().toISOString(),previousDraft:await pin(path.join(archive,'payload-manifest.draft.json')),
    sourceCandidate:await sourceIdentity(),payload:await Promise.all(['profile.json','contract.json','resource-request.json','native-search.py','native-fixed-control.py'].map(name=>pin(path.join(operator,name)))),
    forkManifest:await preservedForkManifest(forkFile),forkFinalVerification:verification},false)
  console.log(JSON.stringify({mode:'revised_local_draft',workspace,fork:profile.proto,remoteCalls:0,providerCalls:0,gpuCalls:0}))
}
async function freeze(){
  const draft=await assertPayload(),gatePins=await gates(),cpuFile=path.join(operator,'cpu-fixed-control-evidence.json'),cpu=await json(cpuFile)
  const identity=await sourceIdentity()
  if(draft.forkManifest.revision!=='v4')throw Error('Final payload requires the verified V4 native graph, construction and hosted-process guards')
  if(!cpu.passed||cpu.sourceHash!==identity.sourceHash||cpu.workerHash!==identity.workerHash)throw Error('CPU pool2/TopN1 prerequisite must pass against this exact final implementation')
  await save('launch-preparation.json',{...draft,status:'frozen_ready_for_fresh_host_release',frozenAt:new Date().toISOString(),...identity,
    driver:await pin(import.meta.path),passiveGpuTelemetry:await pin(path.join(operator,'passive-gpu-telemetry.py')),gates:gatePins,cpuPrerequisite:await pin(cpuFile),contractHash:ResearchDomain.hashContract(await json(path.join(operator,'contract.json')))})
  console.log(JSON.stringify({mode:'frozen_local_only',workspace,sourceHash:identity.sourceHash,workerHash:identity.workerHash,remoteCalls:0,providerCalls:0}))
}
function noInference():never{throw Error('This validation grants zero provider/model calls')}
async function newExperiment(app:Application,contract:ResearchDomain.ExperimentContract){
  const campaign=await app.research.createCampaign(app.projectId,{objective:contract.objective});await app.research.activateCampaign(app.projectId,campaign.id)
  const experiment=await app.research.createExperiment(app.projectId,campaign.id,{contract});await app.research.activateExperiment(app.projectId,experiment.id)
  return experiment
}
function authoredResult(value:unknown){
  if(!value||typeof value!=='object'||!('trial' in value)||!('validation' in value))throw Error('Authoring front door returned no typed handoff')
  const validation=value.validation
  if(!validation||typeof validation!=='object'||!('valid' in validation)||typeof validation.valid!=='boolean')throw Error('Authoring front door returned no validation result')
  return {trial:ResearchDomain.Trial.parse(value.trial),validation}
}
async function originalReceipt(app:Application,trialId:string){
  const state=await app.store.read(app.projectId),runs=Object.values(state.runs).filter(run=>run.trialId===trialId)
  if(runs.length!==1)throw Error('Expected exactly one original trial run')
  return app.execution.artifacts(runs[0]!.id)
}
function scoringRequestEvidence(receipt:Awaited<ReturnType<Application['execution']['artifacts']>>){
  const slots=receipt.modelEvidence.filter(value=>value.status==='completed').map(value=>{
    if(!('runtime' in value)||!('stage' in value)||typeof value.stage!=='string')throw Error('Fresh scoring measurement lacks its actual runtime/stage')
    const runtime=ExecutionProtocol.ModelRunArtifactV2.shape.runtime.parse(value.runtime)
    const reservation=receipt.nativeExecution?.resources.invocationReservations.find(item=>item.stageId===value.stage)
    if(!reservation)throw Error('Scoring measurement has no frozen request reservation')
    verifyNativeRequestObservation(runtime,value.modelId,reservation.perRequestTimeoutSeconds,{seed:value.seed,parametersHash:value.parametersHash})
    const observation=runtime.requestObservation!,root=observation.entries.find(entry=>entry.requestId===observation.rootRequestId)!
    return {candidateId:value.candidateId,stage:value.stage,modelId:value.modelId,seed:value.seed,
      rootRequestId:observation.rootRequestId,rootCacheOrigin:root.cacheOrigin,entries:observation.entries,
      invocationWallSeconds:runtime.wallSeconds,rootInputHash:root.inputHash,rootConfigHash:root.configHash,parametersHash:value.parametersHash}
  })
  const entries=slots.flatMap(slot=>slot.entries),roots=slots.map(slot=>slot.rootRequestId)
  const expected=receipt.candidates.candidates.flatMap(candidate=>receipt.pipeline!.stages.filter(stage=>stage.role==='scoring').flatMap(stage=>stage.models.flatMap(model=>[20260809].map(seed=>[candidate.id,stage.id,model.id,seed].join(':')))))
  const actual=slots.map(slot=>[slot.candidateId,slot.stage,slot.modelId,slot.seed].join(':'))
  const exactMeasurements=expected.length===4&&actual.length===expected.length&&new Set(actual).size===actual.length&&expected.every(key=>actual.includes(key))
  return {slots,measurementCardinality:slots.length,observedRegisteredRequestCount:entries.length,
    observedUniqueRequestIds:new Set(entries.map(entry=>entry.requestId)).size,
    exactMeasurements,uniqueRootIds:new Set(roots).size===roots.length,
    allCompletedRequestsHaveCacheOrigin:entries.filter(entry=>entry.status==='completed').every(entry=>entry.cacheOrigin!=='unobserved'),
    uncachedRootRequestIds:slots.filter(slot=>['cache_miss','cache_disabled','cache_partial'].includes(slot.rootCacheOrigin)).map(slot=>slot.rootRequestId),
    provenanceMeaning:'Actual native registered API lifecycle/cache branches; not physical GPU inference counts'}
}
async function receiptOnlyReopen(app:Application,trialId:string,experimentId:string,requestId:string,profile:Awaited<ReturnType<typeof loadExecutionConfig>>){
  let forbiddenNewWork=0
  const forbid=():never=>{forbiddenNewWork++;throw Error('Original receipt-only reopen forbids model, inspection, staging, transport, and launch')}
  const before=await app.store.read(app.projectId),run=Object.values(before.runs).find(value=>value.trialId===trialId)!
  const originals=[]
  for(const name of ['request.json','dispatch.json','remote-launch-attempt.json','remote-plan.identity.json']){
    const file=path.join(app.workspace,'.autofold/runs',run.id,name)
    if(await exists(file))originals.push(await pin(file))
  }
  const reopened=new Application({workspace:app.workspace,projectId:app.projectId,
    execution:{...profile,transport:{kind:app.execution.transportKind,capabilities:forbid,preflight:forbid,dispatch:forbid,reconcile:forbid},
      inspectionBoundary:{execute:forbid},authorization:{localProto:false,remote:false,maximumGpuSeconds:0,maximumCandidates:2,maximumWallTimeMinutes:15,authorize:forbid}},
    jobs:{sessionStoreFactory:forbid,runtimeOptions:{streamFn:forbid,getApiKey:forbid,authorizeModelRequest:forbid}}})
  await reopened.science(experimentId).evaluateTrial({trialId,requestId})
  const after=await reopened.store.read(app.projectId),receipt=await reopened.execution.artifacts(run.id)
  const originalFilesUnchanged=(await Promise.all(originals.map(async item=>hash(await fs.readFile(item.path))===item.contentHash))).every(Boolean)
  return {passed:forbiddenNewWork===0&&originalFilesUnchanged&&hash(JSON.stringify(before))===hash(JSON.stringify(after))&&receipt.run.manifestHash===run.manifestHash,
    forbiddenNewWork,originalFilesUnchanged,originalFiles:originals,canonicalBeforeHash:hash(JSON.stringify(before)),canonicalAfterHash:hash(JSON.stringify(after)),runId:run.id,manifestHash:run.manifestHash}
}
async function cpuControl(){
  const draft=await assertPayload();await gates()
  if(draft.forkManifest.revision!=='v4')throw Error('CPU prerequisite requires the final V4 fork, not an earlier draft')
  const cpuWorkspace=path.join(workspace,'cpu-fixed-control')
  if(await exists(cpuWorkspace))throw Error('Original CPU prerequisite identity already exists; preserve evidence and inspect it')
  const profile=await json(path.join(operator,'profile.json')),identity=await sourceIdentity()
  assertCapabilities(await localCapabilities(profile.python,{proto:profile.proto,generators:[]}))
  const hostConfig=await loadExecutionConfig(path.join(operator,'profile.json'))
  if(!hostConfig?.inspectionBoundary?.execute)throw Error('CPU prerequisite requires the prepared remote contained inspection boundary')
  const deadlineMs=Date.now()+120000
  await fs.mkdir(cpuWorkspace,{recursive:true,mode:0o700})
  const app=new Application({workspace:cpuWorkspace,projectId:'prj_final_gpu_cpu_control_20261012',
    execution:{python:profile.python,workerRoot:profile.workerRoot,proto:profile.proto,
      inspectionBoundary:hostConfig.inspectionBoundary,
      authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:2,maximumWallTimeMinutes:1,deadlineMs}},
    jobs:{sessionStoreFactory:noInference,runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
  const evaluator=(await app.execution.evaluators()).find(value=>value.id==='mock-peptide-panel')!
  const target=await ResearchArtifacts.authorTarget(cpuWorkspace,{format:'autofold.target-artifact.v1',name:'CPU infrastructure control',chains:[{id:'A',sequence:'ACDEFGHIKLMN'}],bindingSite:{residues:[{chainId:'A',position:1}]}})
  const contract=ResearchDomain.ExperimentContract.parse({version:1,objective:'CPU native pool2/TopN1 prerequisite',targetArtifactHash:target.targetArtifactHash,modality:'short_peptide',
    budget:{maximumCandidates:2,gpuHours:0,wallTimeMinutes:1},evaluator:{id:evaluator.id,version:evaluator.version,sourceHash:evaluator.sourceHash,direction:evaluator.direction,fixedSeeds:[20260809],submissionSize:1}})
  const experiment=await newExperiment(app,contract),science=app.science(experiment.id)
  const authored=authoredResult(await science.authorTrial({program:await fs.readFile(path.join(operator,'native-fixed-control.py'),'utf8'),hypothesis:'Two unchanged native control sequences remain in the verified pool while the frozen CPU evaluator selects TopN1. This checks infrastructure only.',intent:'calibrate',designAdapter:'proto'}))
  if(!authored.validation.valid)throw Error('CPU control admission failed: '+JSON.stringify(authored.validation))
  await science.evaluateTrial({trialId:authored.trial.id,requestId:'final-gpu-cpu-fixed-control-original'})
  const receipt=await originalReceipt(app,authored.trial.id)
  const reopen=await receiptOnlyReopen(app,authored.trial.id,experiment.id,'final-gpu-cpu-fixed-control-original',undefined)
  const state=await app.store.read(app.projectId),sequences=receipt.candidates.candidates.map(candidate=>candidate.sequence)
  const checks={nativeProtocol:receipt.nativeExecution?.protocol==='native_fixed_control_v1',pool2:sequences.length===2,
    exactOriginalSequences:JSON.stringify(sequences)===JSON.stringify(['ACDEFGHIKLMNPQRSTVWYACDEF','CDEFGHIKLMNPQRSTVWYACDEFGH']),
    zeroNativeWork:receipt.nativeSearch?.counts.proposals===0&&receipt.nativeSearch.counts.samplingCalls===0&&receipt.nativeSearch.counts.toolCalls===0,
    topN1:receipt.evaluation.diagnostics.submission_count===1,valid:receipt.evaluation.valid,
    noPiArchive:!await exists(path.join(app.sessionDirectory,'sessions.sqlite')),receiptOnlyReopen:reopen.passed,
    noJobs:Object.keys(state.jobs).length===0,noLegacyCycle:Object.keys(state.knowledgeCycles).length===0,
    originalRun:Object.keys(state.runs).length===1&&receipt.run.status==='succeeded',plumbingOnly:receipt.scientific===false}
  await save('cpu-fixed-control-evidence.json',{passed:Object.values(checks).every(Boolean),observedAt:new Date().toISOString(),sourceHash:identity.sourceHash,workerHash:identity.workerHash,checks,
    receipt,receiptOnlyReopen:reopen,providerCalls:0,gpuCalls:0,scientificImprovementEstablished:false,scope:'native fixed control, pool2 unchanged, sequence-only CPU TopN1 evaluator'})
  console.log(JSON.stringify({mode:'cpu_fixed_control',checks,passed:Object.values(checks).every(Boolean)}))
  if(!Object.values(checks).every(Boolean))process.exitCode=1
}
async function launch(){
  await assertPayload();await gates()
  const prepared=await json(path.join(operator,'launch-preparation.json')),current=await sourceIdentity()
  if(current.sourceHash!==prepared.sourceHash||current.workerHash!==prepared.workerHash)throw Error('Final tested source/worker differs from frozen preparation')
  for(const item of [prepared.driver,prepared.passiveGpuTelemetry,...prepared.gates,prepared.cpuPrerequisite])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Frozen launch dependency changed')
  // The coordinator writes this release only after reviewing the final payload and
  // verifying the NEW remote checkout, model assets, and idle host. No old grant is read.
  const release=await json(path.join(operator,'fresh-host-release.json')),profile=await json(path.join(operator,'profile.json'))
  if(release.sourceHash!==prepared.sourceHash||release.workerHash!==prepared.workerHash||release.remoteRoot!==remoteRoot||release.languageCommit!==profile.proto.languageCommit||release.toolsCommit!==profile.proto.toolsCommit||release.maximumTrials!==1||release.maximumGpuSeconds!==600||release.providerBudgetUsd!==0||release.maximumWallSeconds!==900||release.ready!==true||!Number.isFinite(Date.parse(release.observedAt))||Date.now()-Date.parse(release.observedAt)>600000)throw Error('Fresh exact host release unavailable')
  const startedAt=Date.now(),deadlineMs=startedAt+900000,abort=new AbortController()
  await save('launch-fence.json',{startedAt:new Date(startedAt).toISOString(),deadlineMs,projectId,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,releaseHash:hash(JSON.stringify(release))})
  const timer=setTimeout(()=>abort.abort(Error('Original absolute 15-minute deadline expired')),900000)
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>abort.abort(Error('Original validation interrupted; preserve receipts')))
  let app:Application|undefined
  try{
    const config=(await loadExecutionConfig(path.join(operator,'profile.json')))!
    app=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,deadlineMs,authorize:()=>abort.signal.throwIfAborted()}},
      jobs:{sessionStoreFactory:noInference,runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
    const contract=ResearchDomain.ExperimentContract.parse(await json(path.join(operator,'contract.json')))
    if(ResearchDomain.hashContract(contract)!==prepared.contractHash)throw Error('Frozen contract differs')
    const experiment=await newExperiment(app,contract),science=app.science(experiment.id)
    await app.execution.preflightExperiment(experiment,abort.signal)
    const authored=authoredResult(await science.authorTrial({program:await fs.readFile(path.join(operator,'native-search.py'),'utf8'),hypothesis,intent:'optimize',designAdapter:'proto'}))
    await save('original-trial.json',{trial:authored.trial,experiment,validation:authored.validation})
    if(!authored.validation.valid)throw Error('Fresh native search admission failed: '+JSON.stringify(authored.validation))
    await science.evaluateTrial({trialId:authored.trial.id,requestId:'final-gpu-native-search-original-20261012',signal:abort.signal})
    const receipt=await originalReceipt(app,authored.trial.id)
    await save('verified-receipt.json',receipt)
    const reopen=await receiptOnlyReopen(app,authored.trial.id,experiment.id,'final-gpu-native-search-original-20261012',config)
    await save('receipt-only-reopen.json',reopen)
    const requests=scoringRequestEvidence(receipt)
    await save('scoring-request-cache-evidence.json',requests)
    const state=await app.store.read(projectId),checks={valid:receipt.evaluation.valid,scientific:receipt.scientific,
      pool2:receipt.candidates.candidates.length===2,uniquePool:new Set(receipt.candidates.candidates.map(candidate=>candidate.sequence)).size===2,
      nativeProtocol:receipt.nativeExecution?.protocol==='native_search_v1',workerIdentity:receipt.worker?.sourceHash===prepared.workerHash,
      measurements4:receipt.modelRuns?.entries.length===4&&receipt.modelRuns.entries.every(entry=>!('status' in entry)||entry.status==='completed'),
      exactScopedMeasurements:requests.exactMeasurements&&requests.uniqueRootIds&&requests.allCompletedRequestsHaveCacheOrigin,
      someUncachedRegisteredWork:requests.uncachedRootRequestIds.length>0,
      noJobs:Object.keys(state.jobs).length===0,noLegacyCycles:Object.keys(state.knowledgeCycles).length===0,
      noPiArchive:!await exists(path.join(app.sessionDirectory,'sessions.sqlite')),receiptOnlyReopen:reopen.passed,
      oneOriginalRun:Object.keys(state.runs).length===1&&Object.keys(state.trials).length===1,
      canonicalObservation:Object.values(state.searchObservations).some(observation=>observation.runId===receipt.run.id&&observation.closeoutVersion===2)}
    await save('validation-result.json',{receiptChecksPassed:Object.values(checks).every(Boolean),passed:false,checks,providerCalls:0,sdkInferenceUsd:0,providerReportedUsd:0,
      deadlineMs,observedAt:new Date().toISOString(),scientificImprovementEstablished:false,biologicalValidationEstablished:false,
      actualNativeSearchObservation:receipt.nativeSearch,modelEvidence:receipt.modelEvidence,scoringRequestEvidence:requests,physicalGpuExecutions:'Registered request/cache receipts do not establish physical execution count',
      physicalShutdownVerified:false,completionStatus:'requires supplemental attributable uncached CUDA witness, original receipt-only reopen, post-stop shutdown, and historical baseline preservation'})
    if(!Object.values(checks).every(Boolean))process.exitCode=1
  }catch(error){
    await save('held-state.json',{observedAt:new Date().toISOString(),error:String(error),replacementDispatches:0,state:app?await app.store.read(projectId).catch(()=>null):null})
    process.exitCode=1
  }finally{clearTimeout(timer);await save('driver-exit.json',{observedAt:new Date().toISOString(),exitCode:process.exitCode??0,physicalShutdownVerified:false})}
}
const mode=process.argv[2]
if(mode==='--prepare')await prepare()
else if(mode==='--refresh')await refresh()
else if(mode==='--cpu-control')await cpuControl()
else if(mode==='--freeze')await freeze()
else if(mode==='--launch')await launch()
else throw Error('Use --prepare (local files), --refresh (archive and revise draft for V4), --cpu-control (after final gates), --freeze, or --launch (requires fresh exact host release).')
