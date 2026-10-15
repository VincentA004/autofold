import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {Database} from 'bun:sqlite'
import {Application} from '../../backend/engine/src/application.ts'
import {loadExecutionConfig} from '../../backend/engine/src/config.ts'
import {workerTreeIdentity} from '../../backend/engine/src/execution/index.ts'
import {openSessionReader,assertSessionAccountingComplete} from '../../backend/engine/src/runtime/index.ts'
import {operationHash} from '../../backend/science-core/src/research/operations.ts'
import {ResearchDomain} from '../../backend/science-core/src/research/domain.ts'
import {auditAuthoredProgram} from '../../backend/engine/src/acceptance/index.ts'
import {ResearchArtifacts} from '../../backend/science-core/src/research/artifacts.ts'
import {DecisionMemory} from '../../backend/science-core/src/research/decision-memory.ts'
import {DEFAULT_MODEL} from '../../backend/engine/src/runtime/models.ts'
import {processPlanHash} from '../../backend/engine/src/execution/process-plan.ts'
import {checkedPath} from '../../backend/engine/src/execution/paths.ts'
const routing={mode:'openrouter_default',providerOverride:false}

const scope={maximumTrials:2,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:0,
 maximumGpuSeconds:600,maximumGpuSecondsPerTrial:600,maximumGpuSecondsAggregate:1200,maximumSearchWallSeconds:300,maximumWorkerWallMinutes:15,
 computeBudgetSemantics:'maximumGpuSeconds is the per-trial compute reservation; two trials reserve at most 1200 seconds aggregate. Reservations are not measured physical GPU seconds.',
 modelBudgetUsd:2,reportedInferenceCeilingUsd:2,maximumModelRequests:128,
 maximumCampaignSteps:1,perChildModelBudgetUsd:2,maximumDurationMs:3600000,
 maxTurns:64,maxToolCalls:128,autofoldOutputTokenCap:null,outputPolicy:'pi_and_provider_default',providerRetries:0}

// Qualification only: no preparation, campaign creation, paid call or dispatch.
const main=path.resolve(import.meta.dir,'../..'),workspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-search-validation-20261013-retry1')
const projectId='prj_learned_search_validation_20261013_retry1',operator=path.join(workspace,'operator'),qualification=path.join(operator,'qualification-01')
const originalDriverHash='sha256:53080eb9a4dd8ac99935ada27022b4729360ff44e5534a3a807d2f94e6c6eb1e'
const model={provider:'openrouter',modelId:'deepseek/deepseek-v4.1-flash'}
const hash=(v:string|Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex')
const terminal=(s:string)=>['succeeded','failed','cancelled'].includes(s)
const pricingURL='https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints'
const pricingAssumptions=['Original frozen published-price reservations are qualified under their recorded assumptions; this audit issues no new model requests.']
const save=async(name:string,value:unknown,exclusive=true)=>{if(!/^[A-Za-z0-9._-]+$/.test(name))throw Error('Invalid qualification output');await fs.writeFile(path.join(qualification,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})}
function endpointPricing(value:any){
 if(value?.data?.id!==model.modelId||!Array.isArray(value.data.endpoints)||value.data.endpoints.length===0)throw Error('Pricing metadata does not cover the authorized model and default endpoints')
 const rates=['prompt','completion','input_cache_read','input_cache_write','request'],other=['discount','overrides']
 const parseRate=(value:unknown,key:string)=>{if((typeof value!=='string'&&typeof value!=='number')||value==='')throw Error('Unknown published rate: '+key);const n=Number(value);if(!Number.isFinite(n)||n<0||(['prompt','completion'].includes(key)&&n===0))throw Error('Invalid published rate: '+key);return n}
 return value.data.endpoints.map((endpoint:any)=>{
  if(endpoint.model_id!==model.modelId||typeof endpoint.provider_name!=='string'||!endpoint.provider_name||typeof endpoint.tag!=='string')throw Error('Endpoint identity is unknown')
  for(const key of ['context_length','max_completion_tokens'])if(endpoint[key]!=null&&(!Number.isSafeInteger(endpoint[key])||endpoint[key]<1))throw Error('Invalid published endpoint token ceiling')
  const pricing=endpoint.pricing
  if(!pricing||typeof pricing!=='object'||Array.isArray(pricing)||Object.keys(pricing).some(key=>![...rates,...other].includes(key)))throw Error('Unsupported or unknown endpoint pricing fees')
  const variants=[pricing,...pricing.overrides??[]],resolved:Record<string,number>[]=[]
  for(const variant of variants){
   if(!variant||typeof variant!=='object'||Array.isArray(variant)||Object.keys(variant).some(key=>![...rates,...other,'utc_start','utc_end','utc_days'].includes(key)))throw Error('Unsupported endpoint pricing override')
   const merged={...pricing,...variant},discount=parseRate(merged.discount??0,'discount')
   if(discount>=1)throw Error('Published discount cannot yield a finite undiscounted bound')
   const row:Record<string,number>={}
   for(const key of rates){if(key==='prompt'||key==='completion'||merged[key]!==undefined)row[key]=parseRate(merged[key],key)/(1-discount)}
   resolved.push(row)
  }
  const maximum=(key:string)=>Math.max(...resolved.map(row=>row[key]??0))
  return {provider:endpoint.provider_name,tag:endpoint.tag,contextWindow:endpoint.context_length??null,maximumCompletionTokens:endpoint.max_completion_tokens??null,
   maximumInputUsdPerToken:Math.max(maximum('prompt'),maximum('input_cache_read'),maximum('input_cache_write')),
   maximumOutputUsdPerToken:maximum('completion'),maximumRequestFeeUsd:maximum('request'),requestFeeAdvertised:Object.hasOwn(pricing,'request')||variants.some(row=>Object.hasOwn(row,'request')),
   publishedPriceVariants:resolved}
 })
}
async function source(){
 const sourceRoot=path.join(main,'backend/engine/src'),files:Array<{path:string;contentHash:string}>=[]
 const visit=async(dir:string)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Unexpected source symlink');const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&((entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts'))||entry.name==='SKILL.md'))files.push({path:path.relative(sourceRoot,file).split(path.sep).join('/'),contentHash:hash(await fs.readFile(file))})}}
 await visit(sourceRoot);await visit(path.join(main,'backend/science-core/src'));files.sort((a,b)=>a.path.localeCompare(b.path))
 for(const relative of ['../package.json','../../science-core/package.json','../../../package.json','../../../package-lock.json'])files.push({path:relative,contentHash:hash(await fs.readFile(path.resolve(sourceRoot,relative)))})
 return {sourceHash:hash(JSON.stringify(files)),workerHash:(await workerTreeIdentity(path.join(main,'backend/worker'))).sourceHash,files}
}
async function pin(file:string){return {path:file,contentHash:hash(await fs.readFile(file))}}
async function originalDispatchBinding(run:ResearchDomain.Run){
 const directory=path.dirname(run.bundlePath),attemptFile=path.join(workspace,directory,'remote-launch-attempt.json')
 const attempt=await Bun.file(attemptFile).json(),requestPath=path.posix.join(directory,'request.json'),planPath=path.posix.join(directory,'remote-plan.identity.json')
 const request=await Bun.file(path.join(workspace,requestPath)).json(),plan=await Bun.file(path.join(workspace,planPath)).json()
 if(attempt.runId!==run.id||request.runId!==run.id||request.trialId!==run.trialId||request.projectId!==projectId||typeof request.requestId!=='string'||run.id!=='run_'+hash(projectId+':'+request.requestId).slice(7)||
  request.bundleHash!==attempt.bundleHash||request.workerHash!==attempt.workerHash||plan.runId!==run.id||plan.bundleHash!==attempt.bundleHash||plan.workerHash!==attempt.workerHash||plan.host!=='workstation_4090'||hash(await fs.readFile(path.join(workspace,run.bundlePath)))!==attempt.bundleHash)throw Error('Original request, launch attempt, bundle and remote plan identity differ')
 return {...attempt,trialId:run.trialId,requestId:request.requestId,requestPath,requestContentHash:hash(await fs.readFile(path.join(workspace,requestPath))),
  planPath,planContentHash:hash(await fs.readFile(path.join(workspace,planPath))),planHash:processPlanHash(plan),
  hostRunStatus:run.status,hostRunStartedAt:run.startedAt,hostRunCompletedAt:run.completedAt,
  requestBinding:'Original local requestId determines runId and is bound by immutable request/bundle/plan; remote supervisor does not publish requestId.'}
}
function auditObjectiveHistory(stage:any,output:any,constraintLabel:string,targetSequence:string,selectedSequence:string,admittedInitialSequence:string){
 const errors:string[]=[],close=(a:unknown,b:unknown)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8
 const read=(row:any,kind:string)=>{
  const constructs=Array.isArray(row?.constructs)?row.constructs:[],matches=constructs.filter((c:any)=>c.label===output?.construct)
  const segments=matches.length===1&&Array.isArray(matches[0].segments)?matches[0].segments:[],binders=segments.filter((s:any)=>s.label===output?.segment)
  const binder=binders.length===1?binders[0]:undefined,metadata=binder?.constraints?.[constraintLabel],iptm=metadata?.data?.iptm
  const validMetric=typeof iptm==='number'&&Number.isFinite(iptm)&&iptm>=0&&iptm<=1
  if(!binder||typeof binder.sequence!=='string'||!/^[ACDEFGHIKLMNPQRSTVWY]{12}$/.test(binder.sequence))errors.push(kind+': selected binder row is absent or invalid')
  if(!metadata||Object.keys(binder.constraints).length!==1||!validMetric||Object.hasOwn(metadata.data??{},'structure_iptm_error')||metadata.data?.structure_tool!=='boltz2')errors.push(kind+': independent valid Boltz2 ipTM metadata absent')
  if(metadata?.weight!==1||!validMetric||!close(metadata?.score,1-iptm)||!close(metadata?.weighted_score,1-iptm)||!close(row?.energy_score,1-iptm))errors.push(kind+': scalar/weighted/aggregate energy differs from 1-ipTM')
  for(const segment of constructs.flatMap((c:any)=>Array.isArray(c.segments)?c.segments:[])){
   if(segment!==binder&&Object.hasOwn(segment?.constraints??{},constraintLabel)){
    const shared=segment.constraints[constraintLabel]
    if(segment.sequence!==targetSequence||!close(shared?.data?.iptm,iptm)||Object.hasOwn(shared?.data??{},'structure_iptm_error')||!close(shared?.score,metadata?.score)||!close(shared?.weighted_score,metadata?.weighted_score))errors.push(kind+': target/shared constraint metadata inconsistent')
   }
  }
  return {sequence:binder?.sequence,iptm,energy:row?.energy_score}
 }
 const history=Array.isArray(stage?.history)?stage.history:[]
 if(history.length!==2||history[0]?.time_step!==0||history[1]?.time_step!==1)errors.push('Expected exactly initial and one-step snapshots')
 for(const [i,item] of history.entries())if(item?.results?.length!==1||item.results[0]?.result_idx!==0||item.best_result_idx!==0||item.optimizer?.type!=='mcmc')errors.push('Snapshot '+i+': ambiguous result or optimizer identity')
 const initialProposals=history[0]?.proposal_results
 if(!Array.isArray(initialProposals)||initialProposals.length!==1||initialProposals[0]?.proposal_idx!==0||initialProposals[0]?.accepted!==true||initialProposals[0]?.rejected_by!==null)errors.push('Unique independently scored initial proposal record absent or invalid')
 const initial=read(initialProposals?.[0],'scored-initial'),retained=read(history[1]?.results?.[0],'retained')
 const initialSnapshot=history[0]?.results?.[0]
 const sequenceGraph=(row:any)=>Array.isArray(row?.constructs)?row.constructs.map((c:any)=>({label:c.label,segments:Array.isArray(c.segments)?c.segments.map((s:any)=>({label:s.label,sequence:s.sequence})):null})):null
 if(initial.sequence!==admittedInitialSequence||!close(initialSnapshot?.energy_score,initial.energy)||operationHash(sequenceGraph(initialSnapshot))!==operationHash(sequenceGraph(initialProposals?.[0])))errors.push('Initial retained scalar/sequence graph and scored initial proposal do not match admitted initial binder')
 const proposals=history[1]?.proposal_results
 if(!Array.isArray(proposals)||proposals.length!==1||proposals[0]?.proposal_idx!==0||typeof proposals[0]?.accepted!=='boolean'||(proposals[0]?.accepted?proposals[0].rejected_by!==null:proposals[0]?.rejected_by!=='Metropolis-Hastings rejection'))errors.push('Independent one-proposal acceptance record absent or invalid')
 const proposal=read(proposals?.[0],'proposal')
 if(proposals?.[0]?.accepted===false&&typeof proposal.energy==='number'&&typeof initial.energy==='number'&&proposal.energy<=initial.energy)errors.push('MCMC rejected an equal or improving single valid proposal')
 const mutationCount=typeof initial.sequence==='string'&&typeof proposal.sequence==='string'&&initial.sequence.length===proposal.sequence.length?[...initial.sequence].filter((residue,index)=>residue!==proposal.sequence[index]).length:null
 if(mutationCount!==1)errors.push('Proposal does not contain exactly one independent residue mutation')
 const chosen=proposals?.[0]?.accepted?proposal:initial
 if(retained.sequence!==chosen.sequence||!close(retained.energy,chosen.energy)||!close(retained.iptm,chosen.iptm))errors.push('Retained result does not match the actual acceptance outcome')
 if(stage?.energyScores?.length!==1||!close(stage.energyScores[0],retained.energy)||selectedSequence!==retained.sequence)errors.push('Final native energy/selected sequence differs from retained history')
 return {passed:errors.length===0,errors,initial,proposal,retained,mutationCount,accepted:proposals?.[0]?.accepted,
  perRequestMetricAttribution:'Unavailable: original request receipts publish input/output hashes but no per-call metric/history-row join. Two scoped successful calls and single-constraint per-row history provide corroboration, not a fabricated request-ID join.'}
}
async function checkHistoryFixtures(){
 const prepared=await pins(),contract=ResearchDomain.ExperimentContract.parse(await Bun.file(prepared.contract.path).json())
 const deny=()=>{throw Error('History fixtures forbid model/worker/transport effects')},config=deniedExecution((await loadExecutionConfig(prepared.profile.path))!,deny)
 const reader=new Application({workspace,projectId,execution:config,jobs:{runtimeOptions:{streamFn:deny,getApiKey:deny,authorizeModelRequest:deny,streamOptions:{fetch:Object.assign(deny,{preconnect:deny})}}}})
 const state=await reader.store.read(projectId),target=await ResearchArtifacts.readTarget(workspace,contract.targetArtifactHash),targetJSON=await Bun.file(path.join(workspace,target.targetArtifactPath)).json(),targetSequence=targetJSON.chains[0].sequence
 const fixtures:any[]=[],sourceReceipts=[]
 for(const run of Object.values(state.runs)){
  if(run.status!=='succeeded')throw Error('Actual history fixtures require completed verified original runs')
  const receipt=await reader.execution.artifacts(run.id)
  if(!receipt.nativeSearch)throw Error('Verified frozen native evidence is absent')
  const file=path.join(workspace,run.outputPath,receipt.nativeSearch.artifactPath),raw=await fs.readFile(file)
  if(hash(raw)!==receipt.nativeSearch.artifactHash)throw Error('Original receipt bytes differ')
  const native=JSON.parse(raw.toString('utf8')),stage=native.lanes[0].stages[0],output=native.admission.budget.outputs[0],admitted=native.admission.projection[0].constructs.find((c:any)=>c.label===output.construct).segments.find((segment:any)=>segment.label===output.segment),label=native.admission.projection[0].stages[0].constraints[0].label,selected=native.selected[0].sequence.sequence
  const spec={runId:run.id,stage,output,label,targetSequence,selected,admittedInitial:admitted.initial.sequence}
  sourceReceipts.push({runId:run.id,file,artifactHash:receipt.nativeSearch.artifactHash,targetArtifactHash:contract.targetArtifactHash,targetSequenceLength:targetSequence.length})
  fixtures.push({name:'actual-initial-unscored-result-plus-scored-proposal-'+run.id,spec,expected:true})
  if(fixtures.length===1){
   const changed=(name:string,mutate:(value:any)=>void)=>{const value=structuredClone(spec);mutate(value);fixtures.push({name,spec:value,expected:false})}
   const binder=(value:any,step:number)=>value.stage.history[step].proposal_results[0].constructs.find((c:any)=>c.label===value.output.construct).segments.find((segment:any)=>segment.label===value.output.segment)
   changed('missing-independent-scored-initial',value=>delete value.stage.history[0].proposal_results)
   changed('ambiguous-scored-initial',value=>value.stage.history[0].proposal_results.push(structuredClone(value.stage.history[0].proposal_results[0])))
   changed('missing-initial-iptm-despite-valid-final',value=>delete binder(value,0).constraints[value.label].data.iptm)
   changed('initial-metric-error-despite-valid-final',value=>binder(value,0).constraints[value.label].data.structure_iptm_error='missing metric')
   changed('wrong-admitted-initial-binder',value=>value.admittedInitial='AAAAAAAAAAAA')
   changed('initial-scalar-differs-from-scored-initial',value=>value.stage.history[0].results[0].energy_score=1)
   changed('step1-repeats-initial-pool',value=>value.stage.history[1].proposal_results[0]=structuredClone(value.stage.history[0].proposal_results[0]))
   changed('step1-missing-iptm-with-valid-initial-retained',value=>delete binder(value,1).constraints[value.label].data.iptm)
   changed('step1-energy-does-not-match-iptm',value=>value.stage.history[1].proposal_results[0].energy_score=1)
  }
 }
 const results=fixtures.map(item=>({name:item.name,expected:item.expected,audit:auditObjectiveHistory(item.spec.stage,item.spec.output,item.spec.label,item.spec.targetSequence,item.spec.selected,item.spec.admittedInitial)})),passed=sourceReceipts.length===2&&results.every(item=>item.audit.passed===item.expected)
 console.log(JSON.stringify({mode:'actual_frozen_objective_history_fixtures',passed,sourceReceipts,results,qualificationExecuted:false,providerCalls:0,remoteCalls:0}))
 if(!passed)throw Error('Actual frozen objective history fixture regression')
}
async function persistedSessions(){
 const file=path.join(workspace,'.autofold/pi',projectId,'sessions.sqlite')
 if(!await Bun.file(file).exists())return {sessions:[],leases:[],journal:[]}
 const db=new Database(file,{readonly:true}),reader=openSessionReader(file)!
 try{const ids=(db.query('SELECT id FROM pi_sessions').all() as {id:string}[]).map(r=>r.id),sessions=[],journal=[]
  for(const id of ids){const session=await reader.get(id);if(!session)throw Error('Original session archive unavailable: '+id);sessions.push(session);journal.push(...await reader.events(id))}
  return {sessions,leases:db.query('SELECT session_id,expires_at FROM pi_leases WHERE expires_at>?').all(Date.now()),journal}
 }finally{reader.close();db.close()}
}

function assertKnownExit(exit:any,held:any,driverError:any){
 if(exit.stage!=='held_exception'||exit.exitCode!==1||exit.error!=='Error: Frozen full target chain differs'||held.error!==exit.error||driverError.message!=='Frozen full target chain differs'||held.passed!==false||!Number.isFinite(Date.parse(exit.observedAt)))throw Error('Qualification requires the exact original terminal target-length assumption failure')
}
function deniedExecution(config:NonNullable<Awaited<ReturnType<typeof loadExecutionConfig>>>,deny:()=>never){
 const transport=config.transport!
 return {...config,authorization:{...config.authorization,authorize:deny},inspectionBoundary:config.inspectionBoundary?{...config.inspectionBoundary,execute:deny}:undefined,
  transport:{kind:transport.kind,snapshotProfile:()=>transport.snapshotProfile?.(),dispatch:deny,reconcile:deny,preflight:deny,capabilities:deny,validateGeneratorSpecs:deny}}
}
async function pins(){
 const p=await Bun.file(path.join(operator,'launch-preparation.json')).json(),identity=await source()
 if(identity.sourceHash!==p.sourceHash||identity.workerHash!==p.workerHash||p.projectId!==projectId||p.workspace!==workspace||p.driver.contentHash!==originalDriverHash)throw Error('Original tested production/worker/driver identity differs')
 for(const item of [p.profile,p.contract,p.driver,p.grant,p.gateManifest,p.historicalBefore,p.inheritedAuthorization,...p.originalPins,...p.offlineGates,...p.offlineLogs,...p.targetFiles])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Original frozen pin changed: '+item.path)
 return p
}
const [mode,...args]=process.argv.slice(2)
if(args.length)throw Error('Qualification accepts no paths, overrides or run selectors')
if(mode==='--check-fixtures'){
 await checkHistoryFixtures()
 const exit={stage:'held_exception',exitCode:1,error:'Error: Frozen full target chain differs',observedAt:'2026-10-13T18:00:00Z'},held={error:exit.error,passed:false},driverError={message:'Frozen full target chain differs'}
 assertKnownExit(exit,held,driverError)
 for(const changed of [{...exit,stage:'running'},{...exit,error:'Error: another failure'},{...exit,observedAt:'unknown'}]){let rejected=false;try{assertKnownExit(changed,held,driverError)}catch{rejected=true};if(!rejected)throw Error('Synthetic terminal prerequisite admitted unsupported original state')}
 console.log(JSON.stringify({mode:'local_qualification_prerequisite_fixtures',passed:true,syntheticPrerequisiteChecks:true,qualificationExecuted:false,providerCalls:0,remoteCalls:0}));process.exit(0)
}
if(mode!=='--qualify-original')throw Error('Use --qualify-original after original driver exit, or --check-fixtures for synthetic local checks')
const prepared=await pins(),grant=await Bun.file(prepared.grant.path).json(),contract=ResearchDomain.ExperimentContract.parse(await Bun.file(prepared.contract.path).json())
if(Object.entries(scope).some(([key,value])=>grant[key]!==value)||operationHash(grant.model)!==operationHash(model)||operationHash(grant.routing)!==operationHash(routing)||grant.sourceHash!==prepared.sourceHash||ResearchDomain.hashContract(contract)!==prepared.contractHash)throw Error('Original bounded grant/contract differs')
const originalExit=await Bun.file(path.join(operator,'driver-exit.json')).json(),held=await Bun.file(path.join(operator,'held-state-audit.json')).json(),driverError=await Bun.file(path.join(operator,'driver-error.json')).json()
assertKnownExit(originalExit,held,driverError)
if((await fs.readFile(path.join(operator,'launch.exit'),'utf8')).trim()!=='1')throw Error('Original local driver completion is unavailable')
const fence=await Bun.file(path.join(operator,'launch-fence.json')).json(),deadlineMs=Date.parse(fence.deadline)
if(fence.projectId!==projectId||fence.workspace!==workspace||fence.sourceHash!==prepared.sourceHash||fence.workerHash!==prepared.workerHash||fence.grantHash!==prepared.grant.contentHash||fence.authorizedAt!==grant.authorizedAt||fence.deadline!==grant.deadline||!Number.isFinite(deadlineMs))throw Error('Original launch fence/grant identity differs')
let reopenForbiddenCalls=0,reopen=false,stage='original_receipt_qualification'
const deny=()=>{reopenForbiddenCalls++;throw Error('Qualification forbids keys, inference, inspection, transport, dispatch and replay')}
const loaded=(await loadExecutionConfig(prepared.profile.path))!
const config=deniedExecution(loaded,deny)
const app=new Application({workspace,projectId,execution:config,jobs:{runtimeOptions:{streamFn:deny,getApiKey:deny,authorizeModelRequest:deny,streamOptions:{fetch:Object.assign(deny,{preconnect:deny})}}}})
let state=await app.store.read(projectId)
if(!state.jobs[originalExit.jobId]||held.jobId!==originalExit.jobId||!Object.values(state.jobs).every(job=>terminal(job.status)&&!job.leaseId)||Object.keys(state.trials).length!==2||Object.keys(state.runs).length!==2||!Object.values(state.runs).every(run=>terminal(run.status))||operationHash(state)!==operationHash(held.state))throw Error('Original jobs/runs are not terminal or original held canonical snapshot differs')
const jobId:string=originalExit.jobId
const attempts=await Promise.all(Object.values(state.runs).map(originalDispatchBinding)),dispatches=attempts.length
const finalDispatch=await Bun.file(path.join(operator,'original-dispatch-final-observation.json')).json(),recordedAttempts=await Bun.file(path.join(operator,'original-dispatch-records.json')).json()
const ordered=(items:any[])=>[...items].sort((a,b)=>a.runId.localeCompare(b.runId))
// Final observation adds exactly this verified bookkeeping field. Preserve all
// other original identity/status/time fields in the equality comparison.
const finalBindings=Array.isArray(finalDispatch.records)?finalDispatch.records.map(({bindingStatus,...record}:any)=>record):[]
if(dispatches!==2||finalDispatch.status!=='complete'||finalDispatch.errors?.length!==0||finalDispatch.noGpuLaunchRecorded!==false||!Array.isArray(finalDispatch.records)||!finalDispatch.records.every((record:any)=>record.bindingStatus==='verified')||operationHash(ordered(finalBindings))!==operationHash(ordered(attempts))||operationHash(ordered(recordedAttempts))!==operationHash(ordered(attempts)))throw Error('Original exact two dispatch bindings are not complete')
const physicalShutdown=await Bun.file(path.join(operator,'shutdown-evidence.json')).json(),expectedIds=attempts.map(item=>item.runId).sort()
if(physicalShutdown.passed!==true||physicalShutdown.noGpuWork!==false||physicalShutdown.originalReceiptsTerminal!==true||physicalShutdown.originalRoot!=='/home/vincent/.autofold-learned-search-validation-20261013-retry1'||physicalShutdown.originalProcesses?.length!==0||physicalShutdown.gpuQueryReturnCode!==0||!Number.isFinite(Date.parse(physicalShutdown.observedAt))||Date.parse(physicalShutdown.observedAt)<Date.parse(originalExit.observedAt)||operationHash(physicalShutdown.expectedOriginalRuns?.toSorted())!==operationHash(expectedIds)||physicalShutdown.receiptChecks?.length!==2||!physicalShutdown.receiptChecks.every((item:any)=>item.passed===true&&expectedIds.includes(item.runId))||physicalShutdown.localBindings?.length!==2||!physicalShutdown.localBindings.every((item:any)=>item.passed===true))throw Error('Passed original root-owned physical shutdown proof is required before qualification')
const names=await fs.readdir(operator),readMatching=async(pattern:RegExp)=>Promise.all(names.filter(name=>pattern.test(name)).map(name=>Bun.file(path.join(operator,name)).json()))
const providerReceipts=await readMatching(/^provider-response-\d+\.json$/),costReservations=await readMatching(/^cost-reservation-\d+\.json$/),inferenceContexts=await readMatching(/^inference-context-.*\.json$/)
providerReceipts.sort((a,b)=>a.requestSequence-b.requestSequence);costReservations.sort((a,b)=>a.requestSequence-b.requestSequence)
const route=await Bun.file(path.join(operator,'route-latest.json')).json(),count=route.count,payloadOutputSizing=costReservations.map(item=>item.nativePayloadOutputSizing)
if(!Number.isSafeInteger(count)||count<1||held.providerRequests!==count||providerReceipts.length!==count||providerReceipts.some((item,index)=>item.requestSequence!==index+1)||costReservations.length!==count||costReservations.some((item,index)=>item.requestSequence!==index+1))throw Error('Original provider/reservation sequence set is incomplete')
const pricingPin=await Bun.file(path.join(operator,'pricing-launch-pin.json')).json()
for(const item of [pricingPin.proof,pricingPin.response])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Original launched pricing proof changed')
const pricing=await Bun.file(pricingPin.proof.path).json(),pricingRaw=await fs.readFile(pricingPin.response.path,'utf8')
if(pricing.passed!==true||pricing.url!==pricingURL||pricing.sdkMetadataHash!=='sha256:'+operationHash(DEFAULT_MODEL)||hash(pricingRaw)!==pricing.responseHash||operationHash(endpointPricing(JSON.parse(pricingRaw)))!==operationHash(pricing.endpoints))throw Error('Original published pricing identity differs')
const providerReportedCost=()=>providerReceipts.length===count&&new Set(providerReceipts.map(r=>r.id)).size===count&&providerReceipts.every(r=>typeof r.id==='string'&&typeof r.provider==='string'&&pricing.endpoints.some((endpoint:any)=>endpoint.provider===r.provider)&&r.model===model.modelId&&!r.error&&!r.identityInvalid&&!r.identityConflict&&!r.observationError&&typeof r.usage?.cost==='number'&&Number.isFinite(r.usage.cost)&&r.usage.cost>=0)?providerReceipts.reduce((n,r)=>n+r.usage.cost,0):null
if(providerReportedCost()===null||held.providerReportedCostUsd!==providerReportedCost())throw Error('Original provider observations are unknown or disagree with held audit')
const frozenSessions=await persistedSessions()
for(const context of inferenceContexts){
 const session=frozenSessions.sessions.find(item=>item.id===context.sessionId),request=session?.modelRequests?.[context.requestId],settled=frozenSessions.journal.find((event:any)=>event.sessionId===context.sessionId&&event.sequence===context.settledSequence&&event.type==='model_request_settled'&&event.data?.requestId===context.requestId)
 if(context.format!=='autofold.actual-inference-memory.v1'||!request||request.status!=='settled'||!settled||context.upstreamRequestId!==request.providerBilling?.upstreamRequestId||!/^sha256:[a-f0-9]{64}$/.test(context.transcriptHash))throw Error('Original effective inference observation is not bound to its settled model request')
 for(const packet of context.packets){
  const message=context.messages?.find((item:any)=>item.ordinal===packet.messageOrdinal)
  if(!message||message.role!=='toolResult'||message.isError||message.toolName!==packet.toolName||message.toolCallId!==packet.toolCallId||!/^sha256:[a-f0-9]{64}$/.test(message.messageHash)||!/^sha256:[a-f0-9]{64}$/.test(packet.contentHash))throw Error('Original delivered packet is not an actual recorded host tool result')
  const originalTool=frozenSessions.journal.find((event:any)=>event.sessionId===context.sessionId&&event.sequence<context.settledSequence&&event.type==='tool_execution_end'&&event.data?.toolCallId===packet.toolCallId&&event.data?.toolName===packet.toolName&&!event.data?.isError&&event.data?.result?.content?.some((part:any)=>part.type==='text'&&hash(part.text)===packet.contentHash))
  if(!originalTool)throw Error('Delivered packet content is not bound to its original successful host tool journal result')
  const value=DecisionMemory.Packet.parse(packet.packet),binding=value.sourceManifest,experiment=state.experiments[binding.scope.experimentId]
  if(!['read_context','read_decision_memory','evaluate_trial'].includes(packet.toolName)||binding.scope.projectId!==projectId||!experiment||experiment.piScientistSessionId!==context.sessionId||experiment.campaignId!==binding.scope.campaignId||!/^sha256:[a-f0-9]{64}$/.test(binding.manifestHash)||binding.manifestPath!=='evidence/memory/'+binding.manifestHash.slice(7)+'.json'||packet.packetHash!=='sha256:'+operationHash(value))throw Error('Original delivered packet scope/hash/provenance differs')
  const manifestFile=path.posix.join('.autofold/autoresearch',binding.scope.experimentId,binding.manifestPath),raw=await fs.readFile(await checkedPath(workspace,manifestFile)),manifest=DecisionMemory.SourceManifest.parse(JSON.parse(raw.toString('utf8')))
  if(packet.manifestVerification.status!=='verified'||packet.manifestVerification.manifestFile!==manifestFile||packet.manifestVerification.manifestContentHash!==hash(raw)||'sha256:'+operationHash(manifest)!==binding.manifestHash||manifest.snapshotHash!==binding.snapshotHash||operationHash(manifest.scope)!==operationHash(binding.scope))throw Error('Original delivered memory source manifest changed or is unverified')
 }
}
const inputPins=await Promise.all(names.filter(name=>name.endsWith('.json')&&name!=='gpu-witness.json').map(name=>pin(path.join(operator,name))))
const qualificationProvenance={format:'autofold.original-run-qualification.v1',qualificationScript:await pin(import.meta.path),originalWorkspace:workspace,originalDriverHash,originalDriverExit:originalExit,originalHeldError:held.error,launchFence:fence,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,contractHash:prepared.contractHash,inputPins,physicalShutdown,
 qualificationScope:'This separate verifier corrects three operator audit assumptions: derive the full target chain from its verified artifact; bind initial scalar/sequence to the unique scored time0 proposal metadata rather than empty time0 result metadata; require final dispatch bindingStatus verified and omit only that bookkeeping field for identity equality. These schema corrections preserve scientific acceptance conditions. Original failure, contract, authoring, target files, requests, dispatches, invoices and artifacts remain unchanged. All engineering acceptance checks rerun independently; no guaranteed pass. Physical shutdown is a separate root-owned observation.',perRequestMetricAttribution:'Scoped calls plus strict optimizer history; original receipts do not carry a per-request metric/history-row join.',nativeEnergyComparisonLimitation:'Different host generation seeds may also alter derived structural-objective model seeds. Cross-trial native-energy comparisons are therefore seed-confounded; they do not isolate the scientific intervention or establish improvement.'}
await fs.mkdir(qualification,{recursive:false,mode:0o700})
await save('original-input-pins.json',qualificationProvenance,true)
try{
 const trialBudgetChecks=[];for(const run of Object.values(state.runs)){const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json(),planFile=path.join(workspace,path.dirname(run.bundlePath),'remote-plan.identity.json'),plan=await Bun.file(planFile).exists()?await Bun.file(planFile).json():undefined;trialBudgetChecks.push({runId:run.id,reservedComputeSeconds:bundle.nativeExecution?.resources?.maximumComputeReservationSeconds,passed:bundle.candidateBudget===1&&bundle.submissionSize===1&&JSON.stringify(bundle.seeds)==='[20260809]'&&bundle.nativeExecution?.observation==='scoped_native_lifecycle_v1'&&bundle.nativeExecution.resources.maximumSearchWallSeconds===300&&bundle.nativeExecution.resources.reservedSearchComputeSeconds===300&&bundle.nativeExecution.resources.reservedEvaluationComputeSeconds===300&&bundle.nativeExecution.resources.maximumComputeReservationSeconds===600&&bundle.contractHash===prepared.contractHash&&bundle.targetArtifactHash===contract.targetArtifactHash&&bundle.evaluator?.id===contract.evaluator.id&&bundle.evaluator?.version===contract.evaluator.version&&(!plan||Number.isFinite(plan.timeoutMs)&&plan.timeoutMs>0&&plan.timeoutMs<=15*60000&&Number.isFinite(plan.authorizationDeadlineMs)&&plan.authorizationDeadlineMs<=deadlineMs)})}
 let sessions=await persistedSessions();for(const session of sessions.sessions)assertSessionAccountingComplete(session)
 await save('sessions.json',sessions.sessions,true);await save('pi-events.json',sessions.journal,true)
 const receipts=[],failedReceipts=[],learnedSearchChecks=[],generationSeedChecks=[]
 const targetArtifact=await ResearchArtifacts.readTarget(workspace,contract.targetArtifactHash)
 const targetContents=await Bun.file(path.join(workspace,targetArtifact.targetArtifactPath)).json()
 const targetSequence=targetContents.chains[0]?.sequence
 if(typeof targetSequence!=='string'||!targetSequence.length)throw Error('Verified frozen target first chain is absent')
 await save('actual-target-qualification.json',{targetArtifactHash:contract.targetArtifactHash,targetArtifactPath:targetArtifact.targetArtifactPath,targetSequenceLength:targetSequence.length,targetSequenceContentHash:hash(targetSequence),qualification:'Full chain derived from the original hash-verified target artifact. The original driver assumed 120 residues; neither artifact nor contract was replaced.'},true)
 for(const run of Object.values(state.runs)){
  if(run.status==='failed'||run.status==='cancelled'){const receipt=await app.execution.failureReceipt(run.id);await save('verified-failure-'+run.id+'.json',receipt,true);failedReceipts.push(receipt);continue}
  if(run.status!=='succeeded')continue
  const receipt=await app.execution.artifacts(run.id);await save('verified-receipt-'+run.id+'.json',receipt,true)
  const trial=state.trials[run.trialId]!
  const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json()
  const generationArtifacts=await Promise.all(receipt.generationRuns!.entries.map(entry=>Bun.file(path.join(workspace,run.outputPath,entry.artifactPath)).json()))
  const generationSeed=(trial as any).generationSeed
  const nativeProgramSeeds=bundle.nativeExecution?.descriptor?.projection?.map((lane:any)=>lane.programSeed)??[]
  generationSeedChecks.push({trialId:trial.id,runId:run.id,generationSeed,bundleGenerationSeed:bundle.generationSeed,
   artifactGenerationSeeds:generationArtifacts.map(artifact=>artifact.generationSeed),nativeProgramSeeds,evaluatorSeeds:bundle.seeds,
   passed:Number.isSafeInteger(generationSeed)&&generationSeed>=0&&bundle.generationSeed===generationSeed&&generationArtifacts.length===1&&generationArtifacts.every(artifact=>artifact.generationSeed===generationSeed)&&nativeProgramSeeds.length===1&&nativeProgramSeeds[0]===generationSeed&&JSON.stringify(bundle.seeds)==='[20260809]'})
  if(!receipt.nativeSearch)throw Error('Verified native-search evidence absent')
  const nativeFile=path.join(workspace,run.outputPath,receipt.nativeSearch.artifactPath)
  if(hash(await fs.readFile(nativeFile))!==receipt.nativeSearch.artifactHash)throw Error('Verified native-search evidence changed during audit')
  const native=await Bun.file(nativeFile).json(),budget=native.admission.budget
  const stages=native.admission.projection.flatMap((lane:any)=>lane.stages),observedStages=native.lanes.flatMap((lane:any)=>lane.stages)
  const segments=native.admission.projection.flatMap((lane:any)=>[...lane.externalInputs,...lane.constructs.flatMap((c:any)=>c.segments)])
  const fixedTarget=segments.find((segment:any)=>segment.initial?.sequence===targetSequence)
  const structuralConstraints=stages.flatMap((stage:any)=>stage.constraints).filter((c:any)=>c.function?.name==='structure_iptm_constraint'&&c.config?.structure_tool==='boltz2')
  const selectedOutput=budget.outputs?.[0],selectedConstruct=native.admission.projection[selectedOutput?.lane??0]?.constructs?.find((construct:any)=>construct.label===selectedOutput?.construct)
  const selectedBinder=selectedConstruct?.segments?.find((segment:any)=>segment.label===selectedOutput?.segment)
  const objectiveHistory=observedStages.length===1?auditObjectiveHistory(observedStages[0],selectedOutput,structuralConstraints[0]?.label,targetSequence,native.selected[0]?.sequence?.sequence,selectedBinder?.initial?.sequence):{passed:false,errors:['Expected exactly one observed optimizer stage']}
  const learnedCalls=native.calls.filter((call:any)=>call.tool==='boltz2-prediction')
  const uncachedLearnedRequestObserved=learnedCalls.some((call:any)=>['cache_miss','cache_partial','cache_disabled'].includes(call.cacheOrigin))
  const passed=native.observation==='scoped_native_lifecycle_v1'&&native.runId===run.id&&native.programHash===trial.programHash&&
   budget.maximumCandidates===1&&budget.maximumProposals===1&&budget.maximumSamplingCalls===1&&budget.maximumToolCalls===2&&budget.maximumWallSeconds===300&&JSON.stringify(budget.allowedTools)==='["boltz2-prediction"]'&&
   native.admission.projection.length===1&&native.lanes.length===1&&stages.length===1&&stages[0].optimizer==='MCMCOptimizer'&&stages[0].config.num_steps===1&&stages[0].config.num_results===1&&stages[0].config.proposals_per_result===1&&stages[0].config.track_proposals===true&&
   stages[0].constraints.length===1&&structuralConstraints.length===1&&structuralConstraints[0].weight===1&&structuralConstraints[0].threshold===null&&structuralConstraints[0].backward===null&&
   !!fixedTarget&&!!selectedBinder&&selectedBinder.id!==fixedTarget.id&&budget.outputs.length===1&&structuralConstraints.length===1&&JSON.stringify(structuralConstraints[0].inputs)===JSON.stringify([fixedTarget.id,selectedBinder.id])&&structuralConstraints[0].config.boltz2_config?.use_msa===false&&
   stages[0].generators.length===1&&stages[0].generators[0].key==='semigreedy-mutation'&&stages[0].generators[0].config.clear_logits===true&&stages[0].generators[0].config.exclude_current===true&&stages[0].generators[0].config.position_weighting==='uniform'&&
   JSON.stringify(stages[0].generators[0].segments)===JSON.stringify([selectedBinder.id])&&
   native.counts.proposals===1&&native.counts.samplingCalls===1&&native.counts.toolCalls===2&&native.samplings.every((sample:any)=>sample.status==='completed')&&
   learnedCalls.length===2&&native.calls.length===2&&uncachedLearnedRequestObserved&&learnedCalls.every((call:any)=>call.status==='completed'&&call.outputSuccess===true&&call.cacheOrigin!=='unobserved'&&typeof call.outputHash==='string')&&
   objectiveHistory.passed&&
   native.selected.length===1&&native.selected[0].origin.segment!==null&&operationHash(native.selected[0].origin)===operationHash(selectedOutput)&&native.selected[0].sequence.sequence.length===12&&native.selected[0].sequence.sequence!==targetSequence&&native.wallSeconds<=300
  learnedSearchChecks.push({runId:run.id,trialId:trial.id,passed,nativeArtifactHash:receipt.nativeSearch.artifactHash,counts:native.counts,
   fullTargetChainBound:!!fixedTarget,selectedBinderId:selectedBinder?.id,structuralConstraintCount:structuralConstraints.length,objectiveHistory,stageEnergyScores:observedStages.map((s:any)=>s.energyScores),
   calls:learnedCalls,uncachedLearnedRequestObserved,cacheOrigins:learnedCalls.map((call:any)=>call.cacheOrigin),selected:native.selected,wallSeconds:native.wallSeconds,
   interpretation:'These scoped requests and optimizer history are inside native search, distinct from the later frozen scoring panel. Acceptance requires a completed request on an uncached/partial/disabled cache branch per trial. Request count includes cache lookups; no physical inference-count or GPU-seconds claim. Root-owned passive GPU ancestry/utilization witness supplies separate physical corroboration.'})
  receipts.push({runId:run.id,trialId:trial.id,intent:trial.intent,manifestHash:run.manifestHash,valid:receipt.evaluation.valid,score:receipt.evaluation.score,scientific:receipt.scientific,workerHash:receipt.worker?.sourceHash,wallSeconds:(Date.parse(run.completedAt!)-Date.parse(run.startedAt!))/1000})
 }
 await save('learned-search-audit.json',{passed:learnedSearchChecks.length===2&&learnedSearchChecks.every(item=>item.passed),checks:learnedSearchChecks,
  authority:'Hash-verified native-search receipt and frozen admission, not the final model-runs index',biologicalValidationEstablished:false},true)
 const generationRandomnessVerified=generationSeedChecks.length===2&&generationSeedChecks.every(item=>item.passed)&&new Set(generationSeedChecks.map(item=>item.generationSeed)).size===2
 await save('generation-seed-audit.json',{passed:generationRandomnessVerified,checks:generationSeedChecks,
  interpretation:'For this validation, each authored Program uses its immutable host slot seed. Two different slot seeds do not establish statistically independent benchmarks or biological improvement. Both evaluator seeds remain fixed; deterministic repetition remains possible by explicit declaration in other programs.'},true)
 const responses=await Promise.all((await fs.readdir(operator)).filter(n=>/^provider-response-\d+\.json$/.test(n)).map(n=>Bun.file(path.join(operator,n)).json()))
 const providerCost=providerReportedCost(),sessionCost=sessions.sessions.reduce((n,s)=>n+s.usage.costUsd,0),jobCost=state.jobs[jobId]!.result?.modelCostUsd
 const ledger=sessions.sessions.flatMap(session=>Object.entries(session.modelRequests??{}).map(([requestId,request])=>({sessionId:session.id,requestId,...request}))),dispatched=ledger.filter(r=>r.status!=='not_dispatched')
 const ledgerReportedCost=dispatched.every(r=>r.providerBilling?.status==='reported'&&Number.isFinite(r.providerBilling.reportedCostUsd))?dispatched.reduce((n,r)=>n+r.providerBilling!.reportedCostUsd!,0):null
 const boundIds=new Set(dispatched.map(r=>r.providerBilling?.upstreamRequestId)),responseIds=new Set(responses.map(r=>r.id))
 const perRequestBilling=dispatched.map(request=>{
  const billing=request.providerBilling,response=responses.find(r=>r.id===billing?.upstreamRequestId)
  const evidenceHash=response?hash(JSON.stringify({upstreamRequestId:response.id,routedProvider:response.provider,reportedCostUsd:response.usage?.cost})):undefined
  return {sessionId:request.sessionId,requestId:request.requestId,upstreamRequestId:billing?.upstreamRequestId,passed:request.status==='settled'&&request.model.provider===model.provider&&request.model.modelId===model.modelId&&!!response&&typeof response.id==='string'&&response.id.length>0&&typeof response.provider==='string'&&response.provider.length>0&&response.model===model.modelId&&typeof response.usage?.cost==='number'&&Number.isFinite(response.usage.cost)&&response.usage.cost>=0&&billing?.status==='reported'&&billing.routedProvider===response.provider&&billing.reportedCostUsd===response.usage.cost&&billing.evidenceHash===evidenceHash&&!response.error&&!response.identityConflict&&!response.identityInvalid&&!response.observationError}
 })
 const exactBillingIds=dispatched.length===count&&responses.length===count&&boundIds.size===count&&responseIds.size===count&&[...boundIds].every(id=>typeof id==='string'&&responseIds.has(id))&&perRequestBilling.every(r=>r.passed)
 const reservationChecks=responses.map(response=>{
  const reservation=costReservations.find(item=>item.requestSequence===response.requestSequence),request=dispatched.find(item=>item.providerBilling?.upstreamRequestId===response.id)
  return {requestSequence:response.requestSequence,upstreamRequestId:response.id,
   passed:!!reservation&&!!request&&request.status==='settled'&&typeof request.estimatedCostUsd==='number'&&request.estimatedCostUsd<=reservation.sdkMaximumUsd&&
    typeof response.usage?.cost==='number'&&response.usage.cost<=reservation.providerMaximumUsd&&reservation.priorSdkSpentUsd+reservation.sdkMaximumUsd<=grant.modelBudgetUsd&&
    reservation.priorReportedSpentUsd+reservation.providerMaximumUsd<=grant.reportedInferenceCeilingUsd&&reservation.nativePayloadOutputSizing.length>0}
 })
 const costReservationsVerified=count>0&&costReservations.length===count&&new Set(costReservations.map(item=>item.requestSequence)).size===count&&reservationChecks.length===count&&reservationChecks.every(item=>item.passed)
 await save('cost-reservation-audit.json',{passed:costReservationsVerified,reservations:costReservations,checks:reservationChecks,pricing,
  interpretation:'Every dispatched request has an original pre-request reservation under the explicit published-price and token-bound assumptions. Native output caps and default routing are unchanged.'},true)
 const effectSnapshot=async()=>{
  const originals=[];const root=path.join(workspace,'.autofold/runs');if(await Bun.file(root).exists().catch(()=>false)||await fs.stat(root).then(v=>v.isDirectory(),()=>false))for(const entry of await fs.readdir(root,{withFileTypes:true})){if(!entry.isDirectory())continue;const file=path.join(root,entry.name,'remote-launch-attempt.json');if(await Bun.file(file).exists())originals.push({runId:entry.name,contentHash:hash(await fs.readFile(file))})}
  originals.sort((a,b)=>a.runId.localeCompare(b.runId))
  return {requests:count,providerIds:providerReceipts.map(r=>r.id).sort(),jobs:Object.keys(state.jobs).sort(),trials:Object.keys(state.trials).sort(),runs:Object.keys(state.runs).sort(),sessionIds:sessions.sessions.map(s=>s.id).sort(),sessionRequestIds:sessions.sessions.flatMap(s=>Object.keys(s.modelRequests??{}).map(id=>s.id+':'+id)).sort(),operations:Object.keys(state.operations).sort(),operationEvents:Object.keys(state.operationEvents).sort(),operationOutbox:Object.values(state.operationOutbox).filter(item=>item.purpose==='effect').map(item=>item.id).sort(),scientistLanes:Object.keys(state.scientistLanes).sort(),sessionEvents:sessions.journal.map(e=>e.sessionId+':'+e.sequence).sort(),originalLaunchAttempts:originals,originalLaunchAttemptCount:originals.length}
 }
 const before=await effectSnapshot();let recovery:any
 if(Object.values(state.jobs).every(j=>terminal(j.status))){
  stage='receipt_only_terminal_reopen';reopen=true
  const noInference=()=>{reopenForbiddenCalls++;throw Error('Terminal receipt-only verifier forbids inference')}
  const verifier=new Application({workspace,projectId,execution:deniedExecution(config,noInference),jobs:{runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference,streamOptions:{fetch:Object.assign(noInference,{preconnect:noInference})}}}})
  recovery=await verifier.jobs.reconcileDetailed(jobId)
  state=await verifier.store.read(projectId);sessions=await persistedSessions()
 }
 const after=await effectSnapshot()
 const sameOriginalEffects=(snapshot:Awaited<ReturnType<typeof effectSnapshot>>)=>{const {operationEvents,...effects}=snapshot;return effects}
 const operations=await app.operationDiagnostics()
 const settled=Object.values(state.jobs).every(j=>terminal(j.status)&&!j.leaseId)&&Object.values(state.runs).every(r=>terminal(r.status))&&sessions.leases.length===0&&sessions.sessions.every(s=>s.status!=='running'&&Object.keys(s.pendingTools??{}).length===0)&&Object.values(state.scientistLanes).every(l=>{const lane=l.state as any;return lane&&typeof lane==='object'&&!lane.pending&&!lane.operation&&Object.values(lane.requests??{}).every((r:any)=>r.phase==='result'&&r.result)})&&operations.every(o=>o.settlement==='settled'&&!o.owner)
 const authoringChecks=[]
 const details=(event:any)=>event.data?.result?.details??event.data?.result
 const successfulTool=(event:any,name:string)=>event.type==='tool_execution_end'&&event.data?.toolName===name&&!event.data?.isError
 const legacyToolAbsence=sessions.journal.every((event:any)=>!['submit_shadow_program','read_reference'].includes(event.data?.toolName))
 for(const trial of Object.values(state.trials)){
  let sessionId:string|undefined,submission:any
  if(trial.intent==='shadow_replay'){
   const slot=Object.values(state.operations).filter(operation=>operation.kind==='skill_shadow_replay').flatMap(operation=>Object.values((operation.state as any).arms??{}) as any[]).find(arm=>arm.proposal?.programHash===trial.programHash&&arm.trialId===trial.id)
   sessionId=slot?.sessionId
  }else sessionId=String(state.jobs[trial.origin?.jobId??'']?.payload.sessionId??'')||undefined
  const trace=sessions.journal.filter((event:any)=>event.sessionId===sessionId)
  const originalRun=Object.values(state.runs).find(run=>run.trialId===trial.id),originalRequest=originalRun?await Bun.file(path.join(workspace,'.autofold/runs',originalRun.id,'request.json')).json():undefined
  if(trial.intent==='shadow_replay')submission=trace.find((event:any)=>successfulTool(event,'submit_trial')&&details(event)?.accepted===true&&details(event)?.programHash===trial.programHash)
  const start=submission?trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolCallId===submission.data?.toolCallId):trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName==='evaluate_trial'&&event.data?.args?.requestId===originalRequest?.requestId)
  const author=trace.filter((event:any)=>['write','edit','write_file','edit_file'].some(name=>successfulTool(event,name))&&details(event)?.programHash===trial.programHash&&event.sequence<(start?.sequence??0)).at(-1)
  const fileHash=hash(await fs.readFile(path.join(workspace,trial.programPath)))
  const passed=fileHash===trial.programHash&&await auditAuthoredProgram(trace,author,trial.programHash,start?.sequence,details(author)?.path)&&!!start&&(trial.intent!=='shadow_replay'||!!submission)
  authoringChecks.push({trialId:trial.id,intent:trial.intent,sessionId,programHash:trial.programHash,fileHash,nativeAuthorTool:(author?.data as any)?.toolName,submissionTool:trial.intent==='shadow_replay'?'submit_trial':'evaluate_trial',passed})
 }
 await save('native-authoring-audit.json',{passed:legacyToolAbsence&&authoringChecks.every(item=>item.passed),legacyToolAbsence,authoringChecks,replayTrialsCovered:authoringChecks.filter(item=>item.intent==='shadow_replay').length,providerCalls:0,newDispatches:0},true)
 const feedbackAudit=Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').map(t=>({trialId:t.id,programHash:t.programHash,decisionPlan:t.decisionPlan,evidenceRefs:t.evidenceRefs,decisionMemoryExposure:(t as any).decisionMemoryExposure}));await save('discovery-feedback-audit.json',{trials:feedbackAudit,interpretation:'Exposure and prospective citations must be independently checked; two successful runs alone do not prove learning.'},true)
 const ordinary=Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)),first=ordinary[0],second=ordinary[1]
 const firstRun=first&&Object.values(state.runs).find(r=>r.trialId===first.id&&r.status==='succeeded'),exposure=second?.decisionMemoryExposure
 const citedFirstRun=!!firstRun&&!!second&&[...second.evidenceRefs??[],...second.decisionPlan?.evidenceRefs??[]].includes(firstRun.id)
 const secondSessionId=second?String(state.jobs[second.origin?.jobId??'']?.payload.sessionId??''):undefined
 const secondTrace=sessions.journal.filter((event:any)=>event.sessionId===secondSessionId)
 const secondRun=second&&Object.values(state.runs).find(run=>run.trialId===second.id)
 const secondExecutionRequest=secondRun?await Bun.file(path.join(workspace,path.dirname(secondRun.bundlePath),'request.json')).json():undefined
 const secondStart:any=secondTrace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName==='evaluate_trial'&&event.data?.args?.requestId===secondExecutionRequest?.requestId)
 const secondAssistant:any=secondStart&&secondTrace.findLast((event:any)=>event.sequence<secondStart.sequence&&event.type==='message_end'&&event.data?.message?.role==='assistant'&&event.data.message.content.some((part:any)=>part.type==='toolCall'&&part.id===secondStart.data.toolCallId&&part.name==='evaluate_trial'))
 const secondSettled:any=secondAssistant&&secondTrace.findLast((event:any)=>event.sequence<secondAssistant.sequence&&event.type==='model_request_settled')
 const secondInference=secondSettled&&inferenceContexts.find(context=>context.sessionId===secondSessionId&&context.requestId===secondSettled.data?.requestId&&context.settledSequence===secondSettled.sequence)
 const deliveredSecondPacket=exposure&&secondInference?.packets.find((item:any)=>item.packetHash===exposure.packetHash&&'sha256:'+operationHash(item.packet)===exposure.packetHash&&
  item.manifestVerification.status==='verified'&&item.manifestVerification.manifestHash===exposure.manifestHash&&item.manifestVerification.snapshotHash===exposure.snapshotHash&&
  item.packet.sourceManifest.manifestHash===exposure.manifestHash&&item.packet.sourceManifest.snapshotHash===exposure.snapshotHash&&operationHash(item.packet.sourceManifest.scope)===operationHash(exposure.scope)&&
  firstRun&&item.packet.facts.some((fact:any)=>fact.runId===firstRun.id&&fact.receiptStatus==='verified'&&fact.receiptHash===firstRun.manifestHash))
 const lastSettledBeforeSecondTool:any=secondInference&&secondTrace.filter((event:any)=>event.type==='model_request_settled'&&event.sequence<secondStart!.sequence).at(-1)
 const lastInferenceBeforeSecondTool=!!secondInference&&lastSettledBeforeSecondTool?.data?.requestId===secondInference.requestId
 const memoryDeliveryBound=!!deliveredSecondPacket&&!!exposure&&exposure.sessionId===secondSessionId&&secondInference?.sessionId===exposure.sessionId&&lastInferenceBeforeSecondTool&&
  exposure.scope.projectId===projectId&&exposure.scope.experimentId===second!.experimentId&&exposure.scope.campaignId===state.experiments[second!.experimentId]?.campaignId
 const memoryDeliveryAudit={passed:memoryDeliveryBound,trialId:second?.id,runId:secondRun?.id,sessionId:secondSessionId,
  evaluateToolCallId:secondStart?.data?.toolCallId,assistantSequence:secondAssistant?.sequence,settledSequence:secondSettled?.sequence,inferenceRequestId:secondInference?.requestId,
  transcriptHash:secondInference?.transcriptHash,packetHash:deliveredSecondPacket?.packetHash,manifestVerification:deliveredSecondPacket?.manifestVerification,
  firstRunId:firstRun?.id,lastInferenceBeforeSecondTool,exposure,
  interpretation:'Acceptance correlates the exact evaluate tool call to its immediately preceding settled model response and recorded effective input. A packet hash or an exposure field by itself is insufficient.'}
 await save('actual-memory-delivery-audit.json',memoryDeliveryAudit,true)
 await save('inference-context-index.json',{requests:inferenceContexts.map(context=>({sessionId:context.sessionId,requestId:context.requestId,settledSequence:context.settledSequence,transcriptHash:context.transcriptHash,
  file:'inference-context-'+context.sessionId+'-'+context.requestId+'.json',packetHashes:context.packets.map((packet:any)=>packet.packetHash)}))},true)
 const feedbackChecks={twoVerifiedOrdinaryRuns:receipts.filter(r=>r.intent!=='shadow_replay'&&r.valid).length===2,
   exactDeliveredMemoryBoundToSecondInference:memoryDeliveryBound,
   secondDecisionCitesFirstRun:citedFirstRun,
   firstResultExposed:!!firstRun&&!!exposure&&exposure.citedSources.some(s=>s.id===firstRun.id)&&exposure.scope.projectId===projectId&&exposure.scope.experimentId===second!.experimentId,
   declarationBound:!!second&&!!exposure&&exposure.decisionHash==='sha256:'+operationHash({decisionPlan:second.decisionPlan,evidenceRefs:second.evidenceRefs}),
   prospectiveChangeDeclared:!!second?.decisionPlan?.changedVariables?.length&&second.programHash!==first?.programHash}
 await save('feedback-checks.json',{checks:feedbackChecks,mechanismObserved:Object.values(feedbackChecks).every(Boolean),interpretation:'Prospective citations, actual delivered packet and changed program establish an attributable feedback trace; they do not establish scientific improvement.'},true)
 const validationTrace=sessions.journal.filter((e:any)=>e.type==='tool_execution_end'&&e.data?.toolName==='validate_trial')
 await save('admission-repair-coverage.json',{validationCalls:validationTrace.length,validationEvents:validationTrace,repairCoverage:'Inspect exact failure/write/validation chronology before claiming repaired admission; immediate success does not exercise repair.'},true)
 const aggregateComputeReservationSeconds=trialBudgetChecks.every(item=>Number.isFinite(item.reservedComputeSeconds))?trialBudgetChecks.reduce((total,item)=>total+item.reservedComputeSeconds,0):null
 const checks={originalPhysicalShutdownVerified:physicalShutdown.passed===true,costReservationsVerified,aggregateComputeReservationRespected:aggregateComputeReservationSeconds!==null&&aggregateComputeReservationSeconds<=grant.maximumGpuSecondsAggregate,learnedModelInsideNativeSearchVerified:learnedSearchChecks.length===2&&learnedSearchChecks.every(item=>item.passed),generationRandomnessVerified,memoryInformedFollowupVerified:Object.values(feedbackChecks).every(Boolean),nativeAuthoringVerified:authoringChecks.every(item=>item.passed)&&authoringChecks.length>0,legacyAuthoringToolsAbsent:legacyToolAbsence,failedOriginalReceiptsVerified:failedReceipts.length===Object.values(state.runs).filter(run=>['failed','cancelled'].includes(run.status)).length&&failedReceipts.every(receipt=>receipt.workerHash===prepared.workerHash),finiteGrantRespected:Object.keys(state.trials).length<=2&&Object.keys(state.runs).length<=2&&attempts.length<=2&&count<=128&&Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length<=2&&Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length===0&&payloadOutputSizing.length===count&&payloadOutputSizing.every(c=>c.length>0&&c.every((v:any)=>Number.isSafeInteger(v)&&v>0))&&grant.autofoldOutputTokenCap===null&&grant.outputPolicy==='pi_and_provider_default'&&trialBudgetChecks.every(r=>r.passed),validLockedEvaluation:receipts.length>0&&receipts.every(r=>r.valid),uniqueOriginalLaunches:attempts.length===Object.values(state.runs).length&&new Set(attempts.map(r=>r.runId)).size===attempts.length,successfulScientificRuns:receipts.length>0&&receipts.every(r=>r.scientific),allSuccessfulReceiptsVerified:receipts.length===Object.values(state.runs).filter(r=>r.status==='succeeded').length,originalWorker:receipts.every(r=>r.workerHash===prepared.workerHash),settled,canonicalEstimatesReconciled:typeof jobCost==='number'&&Math.abs(jobCost-sessionCost)<1e-8,canonicalReportedUsageReconciled:(state.jobs[jobId]!.result?.providerAccounting as any)?.status==='reported'&&providerCost!==null&&Math.abs(Number((state.jobs[jobId]!.result?.providerAccounting as any)?.reportedCostUsd)-providerCost)<1e-8,providerUsageComplete:responses.length===count&&providerCost!==null,providerUsageBoundExactly:exactBillingIds&&ledgerReportedCost!==null&&providerCost!==null&&Math.abs(ledgerReportedCost-providerCost)<1e-8,requestedModelOnly:responses.length>0&&responses.every(r=>typeof r.provider==='string'&&r.provider.length>0&&r.model===model.modelId&&!r.observationError&&!r.identityConflict&&!r.identityInvalid),bothCostCeilingsRespected:sessionCost<=grant.modelBudgetUsd&&providerCost!==null&&providerCost<=grant.reportedInferenceCeilingUsd,receiptOnlyReopenNoNewEffects:!!recovery&&reopenForbiddenCalls===0&&JSON.stringify(sameOriginalEffects(before))===JSON.stringify(sameOriginalEffects(after))}
 const coverage={ordinaryVerifiedRuns:receipts.filter(r=>r.intent!=='shadow_replay').length,replayVerifiedRuns:receipts.filter(r=>r.intent==='shadow_replay').length,failedRuns:Object.values(state.runs).filter(r=>r.status==='failed').length,failedOperations:operations.filter(o=>o.outcome==='failed').length,replayRequested:false,guidanceComparisonLiveCovered:false,skillSelfImprovementLiveCovered:false,scientificImprovementEstablished:false,authority:'Engineering validation of native learned search and delivered feedback; no paired replay or skill activation requested'}
 const report={qualificationProvenance,originalOperatorReportPassed:false,qualificationDoesNotReplaceOriginalFailure:true,feedbackAudit,memoryDeliveryAudit,costReservations,reservationChecks,pricingAssumptions,pricingResponseHash:pricing.responseHash,aggregateComputeReservationSeconds,coverage,format:'autofold.cohesive-engine-validation.v1',observedAt:new Date().toISOString(),...checks,passed:Object.values(checks).every(Boolean),receipts,failedReceipts,authoringChecks,jobs:Object.values(state.jobs),operations,sdkEstimatedInferenceUsd:sessionCost,providerReportedCostUsd:providerCost,sessionReportedCostUsd:ledgerReportedCost,perRequestBilling,trialBudgetChecks,payloadOutputSizing,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,providerRequests:ledger.map(r=>({sessionId:r.sessionId,requestId:r.requestId,status:r.status,costKind:r.costKind,estimatedCostUsd:r.estimatedCostUsd,canonicalCostUsd:r.reportedCostUsd,providerBilling:r.providerBilling})),costSemantics:'Canonical SDK estimates and separate exact original OpenRouter reported usage; unequal amounts do not fabricate invoice equality',actualProviders:[...new Set(responses.map(r=>r.provider))],originalDispatches:dispatches,providerResponses:responses.length,receiptOnlyReopen:{before,after,recovery,forbiddenInferenceAttempts:reopenForbiddenCalls},controlledFault:false,biologicalValidationEstablished:false,methodImprovementEstablished:false,remoteShutdownVerified:physicalShutdown.passed,physicalShutdownAuthority:'Original root-owned read-only proof; this qualification performs no remote audit'}
 await save('qualified-report.json',report,true)
 console.log(JSON.stringify({type:'result',passed:report.passed,coverage,checks,receipts,sdkEstimatedInference:sessionCost,providerReportedInference:providerCost,providerResponses:responses.length}))
 if(!report.passed)process.exitCode=1

}catch(error){await save('qualification-error.json',{observedAt:new Date().toISOString(),passed:false,error:String(error),newInferenceCalls:0,newDispatches:0},true);throw error}
