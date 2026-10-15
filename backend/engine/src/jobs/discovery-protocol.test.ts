import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {Database} from 'bun:sqlite'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {operationHash} from '@autofold/science-core/operations'
import {ScientificExecution,LocalWorkerTransport} from '../execution'
import {nativeFixtureRoot} from '../execution/native-fixture'
import {ScientistLane,type ScientistProspectiveCandidate} from '../scientist'
import {generationSeed as deriveGenerationSeed} from '@autofold/science-core/research/generation-seed'
import {CampaignController} from '../campaign'
import {PiJobController,type PiJobControllerOptions} from './index'
import {DEFAULT_MODEL,assertSessionAccountingComplete} from '../runtime'
import {readSessionSnapshot} from '../runtime/store'
import {contextBudget} from '../runtime/context'
import {scientistContextPolicy} from './scientist-context'
import {requireDiscoveryMemoryProof} from '../../../../tooling/lib/discovery-validation-policy'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)){
 const evidenceDirectory=process.env.AUTOFOLD_CPU_PROTOCOL_EVIDENCE_DIRECTORY
 if(evidenceDirectory){await fs.mkdir(evidenceDirectory,{recursive:true});await fs.cp(root,path.join(evidenceDirectory,path.basename(root)),{recursive:true,errorOnExist:true,force:false})}
 await fs.rm(root,{recursive:true,force:true})
}})
const nativePython=path.resolve(import.meta.dir,'../../../../.autofold/envs/proto/bin/python')
const nativeInstalled=await Promise.all([fs.access(nativePython),fs.access(path.join(nativeFixtureRoot,'proto-tools'))]).then(()=>true,()=>false)
const sha=(raw:Uint8Array|string)=>'sha256:'+crypto.createHash('sha256').update(raw).digest('hex')
const stream=(content:AssistantMessage['content'],tool=false)=>{
 const message:AssistantMessage={role:'assistant',content,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,stopReason:tool?'toolUse':'stop',timestamp:Date.now(),usage:{input:2,output:2,cacheRead:0,cacheWrite:0,totalTokens:4,cost:{input:.0001,output:0,cacheRead:0,cacheWrite:0,total:.0001}}}
 const events=createAssistantMessageEventStream();events.push({type:'done',reason:tool?'toolUse':'stop',message});events.end(message);return events
}
const call=(id:string,name:string,args:Record<string,any>)=>stream([{type:'toolCall',id,name,arguments:args}],true)
async function commit(directory:string){const child=Bun.spawn(['git','-C',directory,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});const [status,text]=await Promise.all([child.exited,new Response(child.stdout).text()]);if(status)throw Error('Native CPU fixture revision unavailable');return text.trim()}
function program(input:{slot:number;experimentId:string;parents:any[];parentRuns:any[];bad:boolean}){
 const temperature=input.slot<=2?.1:input.slot%2?.2:.05
 const refs=input.slot<=2?[input.experimentId]:input.parentRuns.map(run=>run.id)
 const comparator=input.bad?input.parents[2]?.id:input.parents[0]?.id
 const plan={question:'PLUMBING_ONLY: does this independent native CPU draw exercise exact host memory and admission?',changedVariables:['CPU diversity threshold mapped to test-protocol temperature '+temperature],controlledVariables:['Mock frozen evaluator','Native host generation seed role'],alternatives:[{id:'draw',experiment:'Execute existing random CPU generator with diversity '+temperature,expectedInformation:'One exact native plumbing receipt',estimatedGpuHours:0},{id:'inspect',experiment:'Inspect original receipts only',expectedInformation:'No new scientific receipt',estimatedGpuHours:0}],selectedAlternativeId:'draw',rationale:'Exercise actual infrastructure; this CPU generator is not ProteinMPNN or a learned-model result.',evidenceRefs:refs,outcomeBranches:[{observation:'Valid locked score is lower',nextDecision:'Keep exact predictor evidence and declare the next comparison'},{observation:'Score is not lower',nextDecision:'Reject the stated direction without claiming binding'}]}
 const declaration={intent:'optimize',decisionPlan:plan,evidenceRefs:refs,...input.slot>2?{prediction:{comparatorTrialId:comparator,metric:'locked_score',relation:'lower',minimumDifference:0}}:{}}
 return ResearchPrograms.templates().proto.replace('min_diversity=0.4','min_diversity='+temperature)+`\nimport json\nfrom autofold_worker.proto_trial import ProtoTrial\nDECLARATION=json.loads(${JSON.stringify(JSON.stringify(declaration))})\ndef build_trial(ctx):\n    return ProtoTrial(program=_build_program(ctx), search=_native_search(ctx), hypothesis="PLUMBING_ONLY slot ${input.slot}: an independent CPU draw tests host delivery and admission", intent=DECLARATION["intent"], decision_plan=DECLARATION["decisionPlan"], evidence_refs=tuple(DECLARATION["evidenceRefs"]), prediction=DECLARATION.get("prediction"))\n`
}

;(nativeInstalled?test:test.skip)('24 actual native CPU receipts survive pairwise host-job renewals, compaction and rejected same-slot prospective drafts',async()=>{
 const configuration=()=>{const contextPolicy=scientistContextPolicy({}),budget=contextBudget(DEFAULT_MODEL,contextPolicy),model=structuredClone(DEFAULT_MODEL);return {contextPolicy,budget,model,contextPolicyHash:'sha256:'+operationHash(contextPolicy),budgetHash:'sha256:'+operationHash(budget),modelHash:'sha256:'+operationHash(model),configurationHash:'sha256:'+operationHash({contextPolicy,budget,model})}}
 const exactConfiguration=configuration(),configurationHashBefore=exactConfiguration.configurationHash
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-discovery-protocol-'));roots.push(workspace)
 const projectId='discovery_protocol_cpu',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store),local=new LocalWorkerTransport()
 let dispatches=0,ordinaryRequests=0,summaryRequests=0,activeCall:any,attempt=0
 const execution=new ScientificExecution({workspace,projectId,research,inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},proto:{root:nativeFixtureRoot,python:nativePython,languageCommit:await commit(nativeFixtureRoot),toolsCommit:await commit(path.join(nativeFixtureRoot,'proto-tools'))},authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},transport:{kind:'local',dispatch:async input=>{dispatches++;if(dispatches>24)throw Error('No25th native effect');return local.dispatch(input)}}})
 const campaign=await research.createCampaign(projectId,{objective:'PLUMBING_ONLY exactly24 native CPU results with fixed pair renewal'});await research.activateCampaign(projectId,campaign.id)
 const evaluator=(await execution.evaluators())[0]!,experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'No learned-model, GPU, causal or biological claim',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7,11],submissionSize:3}}});await research.activateExperiment(projectId,experiment.id)
 const sessionDirectory=path.join(workspace,'pi'),journal=()=>{const db=new Database(path.join(sessionDirectory,'sessions.sqlite'),{readonly:true});try{return(db.query('SELECT event FROM pi_journal ORDER BY sequence').all() as {event:string}[]).map(row=>JSON.parse(row.event))}finally{db.close()}}
 const inferenceContexts:any[]=[],admissions:any[]=[],proofs:any[]=[],jobGrants:any[]=[],rejections:any[]=[],phases=new Map<number,string>(),lanes=new Map<string,ScientistLane>()
 const ordinary=(state:any)=>Object.values(state.trials).filter((trial:any)=>trial.experimentId===experiment.id&&trial.intent!=='shadow_replay').sort((a:any,b:any)=>a.createdAt.localeCompare(b.createdAt)) as any[]
 const inspectCandidate=async(candidate:ScientistProspectiveCandidate)=>{
  const descriptor=candidate.nativeDescriptor as any
  const state=await store.read(projectId),trials=ordinary(state),slot=trials.length+1,expectedSeed=deriveGenerationSeed(projectId,experiment.id,candidate.sessionId,slot)
  expect(candidate.iteration).toBe(slot);expect(candidate.generationSeed).toBe(expectedSeed);expect(descriptor?.projection[0]?.programSeed).toBe(expectedSeed);expect(slot).toBeLessThanOrEqual(24)
  expect(activeCall).toMatchObject({name:candidate.phase==='validate'?'validate_trial':'evaluate_trial',jobId:candidate.jobId,sessionId:candidate.sessionId})
  const row:any={phase:candidate.phase,slot,generationSeed:expectedSeed,programHash:candidate.programHash,trialCountBefore:trials.length,toolCallId:activeCall.id}
  admissions.push(row)
  if(slot<=2){row.accepted=true;return}
  const parents=trials.slice(0,2),parentRuns=parents.map(parent=>Object.values(state.runs).find(run=>run.trialId===parent.id&&run.status==='succeeded'))
  const diversity=descriptor.projection[0].stages[0].constraints.find((constraint:any)=>typeof constraint.config?.min_diversity==='number')?.config.min_diversity
  // Explicit CPU stand-in: exact native diversity setting exercises the SAME
  // delivery/comparator policy; no learned generator or GPU work is claimed.
  try{
   const proof=requireDiscoveryMemoryProof({projectId,followup:{...candidate.declaration,programHash:candidate.programHash,generationSeed:expectedSeed,experimentId:experiment.id,origin:{jobId:candidate.jobId},createdAt:new Date().toISOString()},state,sessions:{journal:journal()},parents,parentRuns,inferenceContexts,temperature:diversity,requestId:candidate.phase==='evaluate'?candidate.requestId:undefined,toolCallId:activeCall.id,toolName:candidate.phase==='validate'?'validate_trial':'evaluate_trial'})
   expect(proof.passed).toBe(true);row.accepted=true;proofs.push({...proof,phase:candidate.phase,slot,generationSeed:expectedSeed})
  }catch(error){row.accepted=false;row.error=error instanceof Error?error.message:String(error);throw error}
 }
 const options:PiJobControllerOptions={workspace,projectId,store,research,execution,sessionDirectory,
  scientistFactory:input=>{
   const lane=new ScientistLane({...input,allowScientificStop:false,prospectiveAdmission:inspectCandidate});lanes.set(input.origin!.jobId,lane)
   if(input.maximumEvaluations!==Number.MAX_SAFE_INTEGER)jobGrants.push({jobId:input.origin!.jobId,baseline:input.evaluationBaseline,maximum:input.maximumEvaluations,sessionId:input.sessionId})
   const tools=lane.tools.bind(lane);lane.tools=()=>tools().map(tool=>['validate_trial','evaluate_trial'].includes(tool.name)?{...tool,execute:async(id,args,signal,update)=>{activeCall={id,name:tool.name,jobId:input.origin!.jobId,sessionId:input.sessionId};const result=await tool.execute(id,args,signal,update);if(tool.name==='evaluate_trial'&&(result.details as any)?.status==='succeeded')console.log(JSON.stringify({format:'autofold.cpu-protocol-progress.v1',trialId:(result.details as any).trialId,runId:(result.details as any).runId,completedCpuRuns:dispatches}));return result}}:tool)
   return lane
  },runtimeOptions:{accountingProvenance:'offline_fixture',limits:{maxTurns:40,maxToolCalls:40},contextPolicy:exactConfiguration.contextPolicy,
   onInferenceContext:async request=>{
    const trace=journal(),settled=trace.findLast(event=>event.type==='model_request_settled'&&event.sessionId===request.sessionId&&event.data.requestId===request.requestId)
    expect(settled?.data.status).toBe('settled');const packets=[]
    for(const message of request.messages){if(message.role!=='toolResult'||message.isError||!['read_context','read_decision_memory','evaluate_trial'].includes(message.toolName))continue
     for(const part of message.content){if(part.type!=='text')continue;let raw:any;try{raw=JSON.parse(part.text)}catch{continue}const packet=raw.decisionMemory??raw.decisionMemoryRefresh?.decisionMemory;if(!DecisionMemory.Packet.safeParse(packet).success)continue
      const binding=packet.sourceManifest,bytes=await fs.readFile(path.join(workspace,'.autofold/autoresearch',experiment.id,binding.manifestPath)),manifest=DecisionMemory.SourceManifest.parse(JSON.parse(bytes.toString()))
      const manifestHash='sha256:'+operationHash(manifest);expect(manifestHash).toBe(binding.manifestHash)
      packets.push({packet,packetHash:'sha256:'+operationHash(packet),manifestVerification:{status:'verified',manifestHash,snapshotHash:manifest.snapshotHash}})
     }
    }
    inferenceContexts.push({sessionId:request.sessionId,requestId:request.requestId,settledSequence:settled.sequence,transcriptHash:'sha256:'+operationHash(request.messages),packets})
   },streamFn:async(_model,context)=>{
    if(JSON.stringify(context.messages.filter(message=>message.role==='system')).includes('You are a context summarization assistant')){summaryRequests++;return stream([{type:'text',text:'PLUMBING_ONLY continuity: follow the frozen host protocol, verify original receipts, keep current scoped full memory, and never replay unknown effects. Exact source is archived.'}])}
    ordinaryRequests++;if(ordinaryRequests>250)throw Error('Bounded offline model-script allowance')
    const state=await store.read(projectId),trials=ordinary(state),slot=trials.length+1;if(slot>24)throw Error('No model work after24 valid results')
    const phase=phases.get(slot)??(slot>=6?'memory':'write'),last=context.messages.findLast(message=>message.role==='toolResult'),detail:any=last?.role==='toolResult'?last.details:undefined
    const lastValue=last?.role==='toolResult'&&last.content[0]?.type==='text'?(()=>{try{return JSON.parse(last.content[0].text)}catch{return undefined}})():undefined
    const parents=trials.slice(0,3),parentRuns=trials.slice(0,2).map(parent=>Object.values(state.runs).find(run=>run.trialId===parent.id&&run.status==='succeeded'))
    if(phase==='memory'){phases.set(slot,'write');return call('memory_'+slot,'read_decision_memory',{evidenceRefs:parentRuns.map(run=>run!.id),maxFacts:4,maxInterpretations:1})}
    if(phase==='write'){
     const bad=slot===5||slot===13;phases.set(slot,bad?'bad_validate':'validate')
     const tool={type:'toolCall' as const,id:'write_'+slot,name:'write',arguments:{path:'trial.py',content:program({slot,experimentId:experiment.id,parents,parentRuns,bad})}}
     return stream([...(slot===4?[{type:'thinking' as const,thinking:'Old completed source exploration π🧬 '.repeat(4000)}]:[]),tool],true)
    }
    if(phase==='bad_validate') {phases.set(slot,'bad_evaluate');return call('bad_validate_'+slot,'validate_trial',{})}
    if(phase==='bad_evaluate'){
     expect(lastValue?.valid??detail?.valid).toBe(false);expect(trials).toHaveLength(slot-1);phases.set(slot,'repair');return call('bad_evaluate_'+slot,'evaluate_trial',{requestId:'accepted_slot_'+slot})
    }
    if(phase==='repair'){
     expect(last?.role==='toolResult'&&last.isError).toBe(true);expect(trials).toHaveLength(slot-1);expect(Object.values(state.runs)).toHaveLength(slot-1)
     const prior=admissions.filter(row=>row.slot===slot);expect(prior).toHaveLength(2);expect(new Set(prior.map(row=>row.generationSeed)).size).toBe(1)
     const rejectedChecks=prior.map(row=>{expect(row.accepted).toBe(false);const error=JSON.parse(row.error);expect(error).toMatchObject({category:'prospective_protocol',scientificEffects:'none',failedChecks:{temperatureDeclaration:true,memoryDeliveryBound:false}});return {phase:row.phase,checks:error.failedChecks}})
     rejections.push({slot,trialCount:trials.length,runCount:Object.keys(state.runs).length,seed:prior[0].generationSeed,validationRejected:true,evaluationRejected:true,rejectedChecks})
     phases.set(slot,'repair_write');return call('repair_memory_'+slot,'read_decision_memory',{evidenceRefs:parentRuns.map(run=>run!.id),maxFacts:4,maxInterpretations:1})
    }
    if(phase==='repair_write'){phases.set(slot,'validate');return call('repair_'+slot,'write',{path:'trial.py',content:program({slot,experimentId:experiment.id,parents,parentRuns,bad:false})})}
    if(phase==='validate'){phases.set(slot,'evaluate');return call('validate_'+slot,'validate_trial',{})}
    if(phase==='evaluate'){expect(lastValue?.valid??detail?.valid).toBe(true);phases.set(slot,'done');return call('evaluate_'+slot,'evaluate_trial',{requestId:'accepted_slot_'+slot})}
    throw Error('Unconsumed script phase '+phase+' for slot '+slot+' attempt '+(++attempt))
   }}}
 const jobs=new PiJobController(options),controller=new CampaignController({...options,jobs});jobs.registerHandler('campaign_loop',controller.handleJob)
 const parent=await controller.enqueueCampaign(campaign.id,{idempotencyKey:'mandatory24cpu',maxSteps:13,maximumTrajectories:24,maximumDiscoveryTrajectories:24,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:1,perChildModelBudgetUsd:.25})
 const completed=await jobs.runOnce({jobId:parent.id});expect(completed?.status).toBe('succeeded');expect(completed?.result?.status).toBe('exhausted');expect(completed?.result).toMatchObject({remainingTrajectories:0,remainingDiscoveryTrajectories:0})
 const state=await store.read(projectId),trials=ordinary(state),runs=Object.values(state.runs).sort((a,b)=>a.startedAt!.localeCompare(b.startedAt!))
 expect(trials).toHaveLength(24);expect(runs).toHaveLength(24);expect(runs.every(run=>run.status==='succeeded')).toBe(true);expect(dispatches).toBe(24)
 expect(jobGrants.map(grant=>grant.baseline)).toEqual(Array.from({length:12},(_,index)=>index*2));expect(jobGrants.map(grant=>grant.maximum)).toEqual(Array.from({length:12},(_,index)=>(index+1)*2))
 expect(new Set(jobGrants.map(grant=>grant.sessionId)).size).toBe(1);expect(rejections.map(row=>row.slot)).toEqual([5,13]);expect(summaryRequests).toBeGreaterThan(0)
 const trace=journal(),firstCompaction=trace.find(event=>event.type==='context_compacted');expect(firstCompaction).toBeDefined()
 const fifth=proofs.find(proof=>proof.slot===5&&proof.phase==='evaluate');expect(fifth).toBeDefined();expect(fifth.settledSequence).toBeGreaterThan(firstCompaction!.sequence)
 const accepted=proofs.filter(proof=>proof.phase==='evaluate');expect(accepted).toHaveLength(22);expect(accepted.every(proof=>proof.passed)).toBe(true)
 const ordered=[]
 for(const [index,trial] of trials.entries()){
  expect(trial.generationSeed).toBe(deriveGenerationSeed(projectId,experiment.id,jobGrants[0].sessionId,index+1))
  const run=runs.find(run=>run.trialId===trial.id)!,artifacts=await execution.artifacts(run.id),manifest=await fs.readFile(path.join(workspace,run.outputPath,'manifest.json'))
  expect(sha(manifest)).toBe(run.manifestHash!);expect(artifacts.nativeSearch?.counts.proposals).toBeGreaterThan(0)
  ordered.push({slot:index+1,trialId:trial.id,runId:run.id,generationSeed:trial.generationSeed,manifestHash:run.manifestHash})
 }
 const db=new Database(path.join(sessionDirectory,'sessions.sqlite'),{readonly:true});try{const session=readSessionSnapshot(db,jobGrants[0].sessionId)!;assertSessionAccountingComplete(session);expect(Number.isFinite(session.usage.costUsd)).toBe(true);expect(session.usage.costUsd).toBeGreaterThan(0)}finally{db.close()}
 const requests=ordinaryRequests,sends=dispatches;expect(await jobs.runOnce()).toBeUndefined();expect(ordinaryRequests).toBe(requests);expect(dispatches).toBe(sends)
 const configurationHashAfter=configuration().configurationHash;expect(configurationHashAfter).toBe(configurationHashBefore)
 console.log(JSON.stringify({format:'autofold.mandatory24cpu-protocol.v1',exactConfiguration,configurationHashBefore,configurationHashAfter,exactConfigurationUnchanged:true,actualAcceptedFollowups:accepted.length,acceptedFollowupProofs:accepted,noOrphanTrials:true,no25th:true,qualification:'PLUMBING_ONLY actual native random CPU generator, diversity mapped explicitly to test temperature; no ProteinMPNN/learned-model/GPU/biological claim',actualNativeCpuRuns:24,actualPairJobs:12,rejectedSlots:rejections,compactions:trace.filter(event=>event.type==='context_compacted').length,ordinaryRequests,summaryRequests,gpuDispatches:0,paidProviderCalls:0,orderedReceipts:ordered}))
},900_000)
