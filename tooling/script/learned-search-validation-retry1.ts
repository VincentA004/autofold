import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {Database} from 'bun:sqlite'
import {Application} from '../../backend/engine/src/application.ts'
import {loadExecutionConfig} from '../../backend/engine/src/config.ts'
import {workerTreeIdentity} from '../../backend/engine/src/execution/index.ts'
import {openSessionReader,assertSessionAccountingComplete,PiLocalPayloadAdmissionRejected} from '../../backend/engine/src/runtime/index.ts'
import {operationHash} from '../../backend/science-core/src/research/operations.ts'
import {ResearchDomain} from '../../backend/science-core/src/research/domain.ts'
import {auditAuthoredProgram} from '../../backend/engine/src/acceptance/index.ts'
import {ResearchArtifacts} from '../../backend/science-core/src/research/artifacts.ts'
import {DecisionMemory} from '../../backend/science-core/src/research/decision-memory.ts'
import {DEFAULT_MODEL} from '../../backend/engine/src/runtime/models.ts'
import {fitPiPayloadToContext} from '../../backend/engine/src/runtime/capacity.ts'
import {processPlanHash} from '../../backend/engine/src/execution/process-plan.ts'
import {checkedPath} from '../../backend/engine/src/execution/paths.ts'
const routing={mode:'openrouter_default',providerOverride:false}

// Operator harness only. --prepare binds completed root-owned gates; it never
// authors a trial or calls a model. --launch is one-shot and cannot resume a
// deferred or billing-unknown execution. Preserve every original report.
const scope={maximumTrials:2,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:0,
 maximumGpuSeconds:600,maximumGpuSecondsPerTrial:600,maximumGpuSecondsAggregate:1200,maximumSearchWallSeconds:300,maximumWorkerWallMinutes:15,
 computeBudgetSemantics:'maximumGpuSeconds is the per-trial compute reservation; two trials reserve at most 1200 seconds aggregate. Reservations are not measured physical GPU seconds.',
 modelBudgetUsd:2,reportedInferenceCeilingUsd:2,maximumModelRequests:128,
 maximumCampaignSteps:1,perChildModelBudgetUsd:2,maximumDurationMs:3600000,
 maxTurns:64,maxToolCalls:128,autofoldOutputTokenCap:null,outputPolicy:'pi_and_provider_default',providerRetries:0}
const objective=[
 'Validate two fresh LLM-authored native Proto discovery trials for PD-L1. Each trial must perform learned Boltz2 calls inside a native optimizer, then submit one binder to the independently frozen Boltz2/Chai1 evaluator.',
 'Author a populated 12-residue canonical short-peptide binder and keep the full first frozen target chain as an immutable fixed input. Use one MCMCOptimizer with num_results=1, num_steps=1, proposals_per_result=1, and track_proposals=True. Use structure_iptm_constraint with inputs=[target,binder], structure_tool="boltz2", weight=1.0, and boltz2_config.use_msa=False. Native energy is 1-ipTM, a predicted interface-confidence proxy; it is not affinity or the locked evaluator score.',
 'Use SemigreedyMutationGenerator assigned only to binder, clear_logits=True, position_weighting="uniform", exclude_current=True. This is CPU mutation with learned structural objective evaluation, not gradient optimization or learned sequence generation. Populate the initial binder so both its initial energy and one mutated proposal are scored.',
 'Use the host-provided immutable ctx.generation_seed for Program seed. Keep fixed evaluator seeds unchanged. NativeSearch must select the binder segment only via NativeOutput, admit only boltz2-prediction, maximum_candidates=1, maximum_proposals=1, maximum_sampling_calls=1, maximum_tool_calls=2, maximum_wall_seconds=300. Construction must not call run or a prediction tool. Consult the pinned registry and model cards for exact config fields; use_msa=False is mandatory and no external MSA recipient is authorized.',
 'After the first verified result, obtain the current actually delivered DecisionMemory before authoring the second trial, cite the first run in the prospective decision, and choose one falsifiable intervention based on verified evidence. Keep the same structural objective and search ceilings. Declare the expected metric movement and a result that would disprove it. Distinguish controlled scientific changes from host-bound generation randomness.',
 'Use exactly the full 120-residue first frozen target chain in native objective inputs, matching the frozen evaluator chain sequence. Its three annotated binding-site residues do not replace that chain. Separate native search energy, locked evaluation score, agreement between predictors, and experimental binding claims. Do not alter the frozen panel, submit a skill, run replay, or claim biological improvement. Record unknowns and failures honestly.'
].join(' ')

const main=path.resolve(import.meta.dir,'../..'),workspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-search-validation-20261013-retry1')
const projectId='prj_learned_search_validation_20261013_retry1',operator=path.join(workspace,'operator')
const originalWorkspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-search-validation-20261013'),originalOperator=path.join(originalWorkspace,'operator')
const originalProjectId='prj_learned_search_validation_20261013',originalDriverHash='sha256:c8a5ba8751adda6aafdb56ab258fa5809715271a7d9550234c63b09c2af47a0e'
const campaignObjective='Validate two fresh LLM-authored PD-L1 discovery trials using learned Boltz2 structural objectives inside native Proto MCMC search, then the independently frozen Boltz2/Chai1 evaluator. The second trial must cite delivered verified memory from the first and test one falsifiable intervention. Preserve the full immutable experiment contract, original shared two-trial/$2 SDK/$2 reported grant, and original deadline. This is computational architecture validation; no biological binding or method improvement claim.'
const model={provider:'openrouter',modelId:'deepseek/deepseek-v4.1-flash'}
const hash=(v:string|Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex')
const terminal=(s:string)=>['succeeded','failed','cancelled'].includes(s)
const pricingURL='https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints'
const pricingAssumptions=[
 'All default-routing endpoints are represented by this public metadata snapshot; published prices and endpoint completion limits remain valid during the bounded run.',
 'Prompt tokens are bounded by Pi prepared-capacity UTF-8 bytes plus framing for this text-only payload; native completion reservations include billable reasoning/output tokens.',
 'Unadvertised per-request fees are absent according to the endpoint pricing schema. Explicit request fees, cache rates, undiscounted rates and schedule overrides are reserved; unknown pricing fields are rejected.',
 'Published-price reservations are an operational ceiling under these assumptions, not an independent guarantee about future price changes or undisclosed charges.'
]
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
function requestReservation(payload:any,pricing:any){
 const caps=['max_tokens','max_completion_tokens'].filter(key=>payload[key]!==undefined).map(key=>payload[key])
 if(!caps.length||caps.some(cap=>!Number.isSafeInteger(cap)||cap<1))throw Error('Positive native output reservations are required for pre-request cost admission')
 if(caps.some(cap=>cap!==caps[0]))throw Error('Conflicting output reservation fields have ambiguous provider precedence')
 if(payload.model!==model.modelId||Object.hasOwn(payload,'provider'))throw Error('Cost reservation model/default routing differs')
 if(!Array.isArray(payload.messages)||payload.messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type!=='text')))throw Error('Published price bound supports text-only inference; non-text input requires a separately verified tariff')
 if(payload.plugins?.length||payload.web_search_options||payload.modalities?.some((modality:any)=>modality!=='text'))throw Error('Optional paid modalities/search plugins are outside the published price bound')
 if(payload.service_tier&&!['auto','default'].includes(payload.service_tier)||payload.transforms?.length)throw Error('Priority tariff or server input transformations are outside the published price/input bound')
 const capacity=fitPiPayloadToContext(payload,DEFAULT_MODEL)!
 if(JSON.stringify(capacity.payload)!==JSON.stringify(payload))throw Error('Cost admission cannot alter the native capacity reservation')
 const outputTokenBound=Math.min(...caps),serializedPayloadBytes=Buffer.byteLength(JSON.stringify(payload),'utf8'),framingTokenAllowance=4096+32*payload.messages.length
 const inputTokenBound=serializedPayloadBytes+framingTokenAllowance
 const sdkInputRate=Math.max(DEFAULT_MODEL.cost.input,DEFAULT_MODEL.cost.cacheRead,DEFAULT_MODEL.cost.cacheWrite)/1000000
 const sdkMaximumUsd=inputTokenBound*sdkInputRate+outputTokenBound*DEFAULT_MODEL.cost.output/1000000
 const endpointBounds=pricing.endpoints.map((endpoint:any)=>{
  const completionCeiling=Math.min(outputTokenBound,endpoint.maximumCompletionTokens??outputTokenBound,endpoint.contextWindow??Infinity)
  // Input is an upper bound, not an exact tokenizer count. Subtracting that
  // upper bound from context to cap output would underestimate possible output.
  // Maximize the linear tariff over 0<=I<=inputBound, 0<=O<=completionCeiling,
  // I+O<=context instead. Unknown endpoint limits use the unchanged native cap.
  const context=endpoint.contextWindow??Infinity
  const inputAtMaximum=endpoint.maximumInputUsdPerToken>endpoint.maximumOutputUsdPerToken?Math.min(inputTokenBound,context):Math.min(inputTokenBound,context-completionCeiling)
  const outputAtMaximum=Math.min(completionCeiling,context-inputAtMaximum)
  return {provider:endpoint.provider,tag:endpoint.tag,inputTokenBound,outputTokenBound:completionCeiling,
   inputAtMaximum,outputAtMaximum,publishedContextWindow:endpoint.contextWindow,publishedCompletionMaximum:endpoint.maximumCompletionTokens,
   maximumUsd:inputAtMaximum*endpoint.maximumInputUsdPerToken+outputAtMaximum*endpoint.maximumOutputUsdPerToken+endpoint.maximumRequestFeeUsd}
 })
 const providerMaximumUsd=Math.max(...endpointBounds.map((endpoint:any)=>endpoint.maximumUsd))
 if(!Number.isFinite(sdkMaximumUsd)||sdkMaximumUsd<=0||!Number.isFinite(providerMaximumUsd)||providerMaximumUsd<=0)throw Error('Positive finite per-request cost reservation unavailable')
 return {format:'autofold.inference-cost-reservation.v1',payloadHash:hash(JSON.stringify(payload)),serializedPayloadBytes,framingTokenAllowance,inputTokenBound,outputTokenBound,nativePayloadOutputSizing:caps,
  sdkMaximumUsd,providerMaximumUsd,endpointBounds,pricingResponseHash:pricing.responseHash,pricingObservedAt:pricing.observedAt,
  sdkMetadataHash:'sha256:'+operationHash(DEFAULT_MODEL),assumptions:pricingAssumptions,outputPolicy:'unchanged_native_capacity'}
}
async function checkPricing(){
 await pins()
 if(await Bun.file(path.join(operator,'launch-fence.json')).exists())throw Error('Fresh pricing check cannot replace an already launched original grant')
 const response=await fetch(pricingURL,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)})
 if(!response.ok)throw Error('Public endpoint pricing request failed: '+response.status)
 const raw=await response.text(),observedAt=new Date().toISOString(),suffix=Date.now()+'-'+crypto.randomUUID(),responseFile='pricing-response-'+suffix+'.json'
 await fs.writeFile(path.join(operator,responseFile),raw,{flag:'wx',mode:0o600})
 let endpoints:any[]=[],error:string|undefined
 try{endpoints=endpointPricing(JSON.parse(raw))}catch(value){error=value instanceof Error?value.message:String(value)}
 const proof={format:'autofold.endpoint-pricing-observation.v1',observedAt,url:pricingURL,responseHash:hash(raw),responseFile,
  sdkMetadataHash:'sha256:'+operationHash(DEFAULT_MODEL),sdkModelMetadata:DEFAULT_MODEL,endpoints,assumptions:pricingAssumptions,
  passed:!error,...(error?{error}:{}),readOnly:true,authenticated:false,providerInferenceCalls:0,newScientificEffects:0}
 await save('pricing-check-'+suffix+'.json',proof,true);await save('pricing-latest.json',proof)
 console.log(JSON.stringify({mode:'public_read_only_endpoint_pricing',passed:proof.passed,endpoints:endpoints.length,responseHash:proof.responseHash,error,providerInferenceCalls:0,newScientificEffects:0}))
 if(!proof.passed)process.exitCode=1
}
const save=async(name:string,v:unknown,exclusive=false)=>{
 const file=path.join(operator,name),bytes=JSON.stringify(v,null,2)+'\n'
 if(exclusive){await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return}
 const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});await fs.rename(temp,file)
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
async function captureOriginalDispatchBindings(){
 const observedAt=new Date().toISOString(),records:any[]=[],errors:string[]=[]
 let state:Awaited<ReturnType<Application['store']['read']>>|undefined
 try{if(app)state=await app.store.read(projectId)}catch(error){errors.push('Original canonical state unavailable: '+String(error))}
 const directory=path.join(workspace,'.autofold/runs')
 let entries:import('node:fs').Dirent[]=[]
 try{entries=await fs.readdir(directory,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push('Canonical launch directory cannot be observed: '+String(error))}
 for(const entry of entries){
  if(entry.isSymbolicLink()){errors.push('Canonical run directory contains a symbolic link');continue}
  if(!entry.isDirectory())continue
  const attemptFile=path.join(directory,entry.name,'remote-launch-attempt.json')
  if(!await Bun.file(attemptFile).exists())continue
  try{
   if(!/^run_[a-f0-9]{64}$/.test(entry.name))throw Error('Unexpected canonical launch directory identity')
   const run=state?.runs[entry.name]
   if(!run)throw Error('Canonical launched run record is unavailable')
   records.push({...await originalDispatchBinding(run),bindingStatus:'verified'})
  }catch(error){
   const attempt=await Bun.file(attemptFile).json().catch(()=>null)
   records.push({...(attempt&&typeof attempt==='object'?attempt:{}),runId:entry.name,bindingStatus:'unresolved',error:String(error),attemptFile,attemptContentHash:hash(await fs.readFile(attemptFile))})
   errors.push('Original dispatch binding unresolved: '+entry.name)
  }
 }
 records.sort((a,b)=>String(a.runId).localeCompare(String(b.runId)))
 return {format:'autofold.original-dispatch-observation.v1',observedAt,status:errors.length?'unresolved':'complete',records,errors,
  noGpuLaunchRecorded:errors.length===0&&records.length===0,authority:'Canonical original launch-attempt files are inspected on success and failure; missing/error evidence never becomes an empty launch set.'}
}
async function pins(){
 const p=await Bun.file(path.join(operator,'launch-preparation.json')).json(),s=await source()
 if(s.sourceHash!==p.sourceHash||s.workerHash!==p.workerHash)throw Error('Tested source or worker changed; do not launch stale preparation')
 for(const item of [p.profile,p.contract,p.driver,p.grant,p.gateManifest,p.historicalBefore,p.inheritedAuthorization,...p.originalPins,...p.offlineGates,...p.offlineLogs,...p.targetFiles])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Frozen pin changed: '+item.path)
 return p
}
function assertOriginalDeadline(fence:any){if(!Number.isFinite(Date.parse(fence.deadline))||Date.now()>=Date.parse(fence.deadline))throw Error('Original shared authorization expired; retry cannot extend it')}
async function inspectOriginalGrant(){
 const read=(name:string)=>Bun.file(path.join(originalOperator,name)).json()
 const [prepared,fence,exit,held,dispatch,shutdown,grant]=await Promise.all(['launch-preparation.json','launch-fence.json','driver-exit.json','held-state-audit.json','original-dispatch-final-observation.json','shutdown-evidence.json','human-grant.json'].map(read))
 if(prepared.driver.contentHash!==originalDriverHash||hash(await fs.readFile(prepared.driver.path))!==originalDriverHash)throw Error('Original frozen operator driver differs')
 const originalPins=[]
 for(const item of [prepared.profile,prepared.contract,prepared.driver,prepared.grant,prepared.gateManifest,prepared.historicalBefore,...prepared.offlineGates,...prepared.offlineLogs,...prepared.targetFiles]){
  if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Original frozen evidence pin changed: '+item.path)
  originalPins.push(item)
 }
 if(fence.authorizedAt!=='2026-10-13T17:46:13.403Z'||fence.deadline!=='2026-10-13T18:46:13.403Z'||fence.projectId!==originalProjectId||fence.workspace!==originalWorkspace||fence.sourceHash!==prepared.sourceHash||fence.workerHash!==prepared.workerHash||fence.grantHash!==prepared.grant.contentHash)throw Error('Original authorization identity or deadline differs')
 if(Object.entries(scope).some(([key,value])=>grant[key]!==value)||operationHash(grant.model)!==operationHash(model)||operationHash(grant.routing)!==operationHash(routing))throw Error('Original shared finite scope differs')
 const ended=Date.parse(exit.observedAt)
 if(exit.stage!=='held_exception'||exit.exitCode!==1||exit.jobId!==undefined||!Number.isFinite(ended)||ended<Date.parse(fence.authorizedAt)||exit.error!==held.error||(await fs.readFile(path.join(originalOperator,'launch.exit'),'utf8')).trim()!=='1')throw Error('Exact original failed driver exit is unavailable')
 if(held.format!=='autofold.cohesive-engine-held-state.v1'||held.passed!==false||held.providerRequests!==0||held.providerReportedCostUsd!==0||held.replacementDispatches!==0||held.jobId!==undefined||!held.error.includes('successCriteria')||!held.error.includes('2000'))throw Error('Original held audit is not the pre-job charter rejection')
 if(!held.state||held.state.version!==1||Object.entries(held.state).some(([key,value])=>key!=='version'&&(!value||typeof value!=='object'||Object.keys(value as object).length)))throw Error('Original held canonical state is not empty')
 const dbPath=path.join(originalWorkspace,'.autofold/research',originalProjectId+'.sqlite'),db=new Database(dbPath,{readonly:true})
 let canonicalRecordCount:number,canonicalBlobCount:number
 try{canonicalRecordCount=(db.query('SELECT count(*) AS count FROM records').get() as {count:number}).count;canonicalBlobCount=(db.query('SELECT count(*) AS count FROM blobs').get() as {count:number}).count}finally{db.close()}
 if(canonicalRecordCount!==0||canonicalBlobCount!==0)throw Error('Original canonical records or payloads now exist; retry budget cannot be assumed unused')
 for(const relative of ['.autofold/pi','.autofold/runs'])if(await fs.access(path.join(originalWorkspace,relative)).then(()=>true,()=>false))throw Error('Original session/request/dispatch authority exists; unused grant cannot be proved')
 const names=await fs.readdir(originalOperator)
 if(names.some(name=>/^(provider-response-|cost-reservation-|inference-context-)/.test(name)))throw Error('Original inference evidence unexpectedly exists')
 if(dispatch.format!=='autofold.original-dispatch-observation.v1'||dispatch.status!=='complete'||dispatch.records?.length!==0||dispatch.errors?.length!==0||dispatch.noGpuLaunchRecorded!==true)throw Error('Original final dispatch observation is not complete and empty')
 const records=await read('original-dispatch-records.json')
 if(!Array.isArray(records)||records.length!==0)throw Error('Original dispatch binding set is not empty')
 if(shutdown.passed!==true||shutdown.noGpuWork!==true||shutdown.scientificExecutionCovered!==false||shutdown.originalRoot!=='/home/vincent/.autofold-learned-search-validation-20261013'||shutdown.originalProcesses?.length!==0||shutdown.receipts?.length!==0||shutdown.expectedOriginalRuns?.length!==0||shutdown.localBindings?.length!==0||shutdown.gpuQueryReturnCode!==0||shutdown.gpuComputeProcesses!==''||shutdown.originalReceiptsTerminal!==true||!Number.isFinite(Date.parse(shutdown.observedAt))||Date.parse(shutdown.observedAt)<ended)throw Error('Original physical shutdown proof is incomplete')
 for(const name of ['launch-preparation.json','launch-fence.json','driver-exit.json','launch.exit','held-state-audit.json','original-dispatch-final-observation.json','original-dispatch-records.json','shutdown-evidence.json'])originalPins.push(await pin(path.join(originalOperator,name)))
 return {format:'autofold.unused-original-grant.v1',observedAt:new Date().toISOString(),originalWorkspace,originalProjectId,originalDriverHash,fence,pins:originalPins,
  canonicalRecordCount,canonicalBlobCount,providerRequests:0,reportedInferenceUsd:0,sdkEstimatedInferenceUsd:0,originalTrials:0,originalRuns:0,originalEffects:0,
  authority:'Read-only exact original exit, canonical SQLite zeros, absent session/request stores, complete empty dispatch observation, frozen original pins and passed physical no-work proof. Retry inherits the original grant and deadline; it does not reset either.'}
}
async function checkCampaignFixture(){
 const inherited=await inspectOriginalGrant(),contract=ResearchDomain.ExperimentContract.parse(await Bun.file(path.join(originalOperator,'contract.json')).json())
 if(contract.objective!==objective||campaignObjective.length>=2000)throw Error('Full experiment objective or short campaign objective differs')
 const fixtureWorkspace=await fs.mkdtemp('/private/tmp/autofold-learned-campaign-fixture-'),fixtureProject='prj_learned_search_campaign_fixture'
 const deny=()=>{throw Error('Local campaign fixture forbids model/worker effects')}
 const app=new Application({workspace:fixtureWorkspace,projectId:fixtureProject,jobs:{runtimeOptions:{streamFn:deny,getApiKey:deny,authorizeModelRequest:deny}}})
 const campaign=await app.research.createCampaign(fixtureProject,{objective:campaignObjective});await app.research.activateCampaign(fixtureProject,campaign.id)
 const experiment=await app.research.createExperiment(fixtureProject,campaign.id,{contract});await app.research.activateExperiment(fixtureProject,experiment.id)
 const state=await app.store.read(fixtureProject),charters=Object.values(state.campaignCharters)
 const passed=state.campaigns[campaign.id]?.status==='active'&&state.experiments[experiment.id]?.status==='active'&&experiment.contract.objective===objective&&experiment.contractHash===ResearchDomain.hashContract(contract)&&charters.length===1&&charters[0]!.successCriteria.every(item=>item.statement.length<=2000)&&['jobs','trials','runs','operations','operationOutbox','skillVersions'].every(key=>Object.keys((state as any)[key]).length===0)
 const report={mode:'local_campaign_construction_fixture',passed,fixtureWorkspace,campaignObjectiveLength:campaignObjective.length,fullExperimentObjectiveLength:contract.objective.length,contractHash:experiment.contractHash,campaignId:campaign.id,experimentId:experiment.id,charters,originalDeadline:inherited.fence.deadline,providerCalls:0,remoteCalls:0,jobs:0,trials:0,runs:0,skills:0}
 await fs.writeFile(path.join(fixtureWorkspace,'fixture-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report))
 if(!passed)throw Error('Actual campaign/experiment/charter construction fixture failed')
}
async function prepare(gateManifestPath:string){
 const inherited=await inspectOriginalGrant();assertOriginalDeadline(inherited.fence)
 if(await fs.access(workspace).then(()=>true,()=>false))throw Error('Fresh learned-search workspace already exists; never replace evidence')
 const gateManifest=path.resolve(main,gateManifestPath),gateProof=await Bun.file(gateManifest).json()
 if(gateProof.status!=='passed')throw Error('Root-owned all-change regression manifest must be passed')
 const required=['change1','change2','change3','change4','full'],offlineGates=[],offlineLogs=[]
 for(const name of required){
  const entry=gateProof.gates?.[name]
  if(!entry||typeof entry.path!=='string')throw Error('Missing required regression gate: '+name)
  const file=path.resolve(main,entry.path),value=await Bun.file(file).json()
  if(value.status!=='passed')throw Error('Regression gate is not passed: '+name)
  if(name==='full'&&(value.sourceHash!==gateProof.sourceHash||value.workerHash!==gateProof.workerHash))throw Error('Referenced full regression gate does not bind the manifest source and worker identities')
  offlineGates.push({name,...await pin(file)})
  if(!Array.isArray(entry.logs)||entry.logs.length===0)throw Error('Every regression gate must pin at least one original check log: '+name)
  for(const log of entry.logs){if(typeof log!=='string')throw Error('Invalid gate log path');offlineLogs.push({gate:name,...await pin(path.resolve(main,log))})}
 }
 const identity=await source()
 if(gateProof.sourceHash!==identity.sourceHash||gateProof.workerHash!==identity.workerHash)throw Error('Root full regression identity differs from current source; final gates must bind the same source/worker identity')
 await fs.mkdir(operator,{recursive:true,mode:0o700})
 const previous=path.join(main,'.autofold/cohesive-engine-refactor-20261012/final-gpu-validation/operator')
 const contract=ResearchDomain.ExperimentContract.parse({...await Bun.file(path.join(previous,'contract.json')).json(),
   objective,
   budget:{maximumCandidates:1,gpuHours:600/3600,wallTimeMinutes:15}})
 if(ResearchDomain.hashContract(contract)!==ResearchDomain.hashContract(ResearchDomain.ExperimentContract.parse(await Bun.file(path.join(originalOperator,'contract.json')).json())))throw Error('Retry must preserve the exact full original experiment contract')
 const profile=await Bun.file(path.join(previous,'profile.json')).json()
 profile.remote.root='/home/vincent/.autofold-learned-search-validation-20261013-retry1'
 profile.authorization.maximumCandidates=1
 await save('contract.json',contract,true);await save('profile.json',profile,true)
 const oldRoot=path.join(main,'.autofold/cohesive-engine-refactor-20261012/final-gpu-validation')
 const target=await ResearchArtifacts.readTarget(oldRoot,contract.targetArtifactHash),targetFiles=[]
 for(const relative of [target.targetArtifactPath,target.structureArtifactPath].filter((v):v is string=>!!v)){
  if(!/\/(target\.json|structure\.pdb)$/.test(relative))throw Error('Unexpected target payload')
  const file=path.join(workspace,relative),bytes=await fs.readFile(path.join(oldRoot,relative))
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o400});targetFiles.push(await pin(file))
 }
 await ResearchArtifacts.readTarget(workspace,contract.targetArtifactHash)
 await save('inherited-authorization.json',inherited,true)
 const grant={authorizedAt:inherited.fence.authorizedAt,deadline:inherited.fence.deadline,originalWorkspace,originalProjectId,originalDriverHash,humanAuthorization:'User explicitly requested another bounded GPU validation with learned-model calls inside Proto search after the four improvements and regression gates; existing approved recipients and smaller scope apply.',...scope,model,routing,sourceHash:identity.sourceHash}
 await save('human-grant.json',grant,true)
 await save('launch-preparation.json',{preparedAt:new Date().toISOString(),...identity,projectId,workspace,profile:await pin(path.join(operator,'profile.json')),contract:await pin(path.join(operator,'contract.json')),driver:await pin(import.meta.path),grant:await pin(path.join(operator,'human-grant.json')),gateManifest:await pin(gateManifest),offlineGates,offlineLogs,historicalBefore:await pin(path.join(main,'.autofold/cohesive-engine-refactor-20261012/operator/historical-before.json')),inheritedAuthorization:await pin(path.join(operator,'inherited-authorization.json')),originalPins:inherited.pins,targetFiles,contractHash:ResearchDomain.hashContract(contract),scope:'Fresh model prompts/tool context to OpenRouter and newly authored programs/frozen worker/PD-L1 files to existing workstation_4090. Only new project evidence is writable. Original unresolved jobs and validation roots are never resumed.'},true)
 console.log(JSON.stringify({mode:'prepared_local_only',workspace,projectId,sourceHash:identity.sourceHash,workerHash:identity.workerHash,remoteCalls:0,providerCalls:0}))
}
async function verifyShutdown(){
 await pins()
 if(!await Bun.file(path.join(operator,'driver-exit.json')).exists())throw Error('Original local driver has not exited')
 const remote=(await Bun.file(path.join(operator,'profile.json')).json()).remote
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-search-validation-20261013-retry1')throw Error('Original worker destination differs')
 const dispatchObservation=await Bun.file(path.join(operator,'original-dispatch-final-observation.json')).json()
 if(dispatchObservation.status!=='complete'||!Array.isArray(dispatchObservation.records))throw Error('Original dispatch observation is unresolved; never assume zero GPU work')
 const attempts=dispatchObservation.records,originalRecords=await Bun.file(path.join(operator,'original-dispatch-records.json')).json()
 if(!Array.isArray(originalRecords)||originalRecords.length!==attempts.length||attempts.some((attempt:any)=>!originalRecords.some((record:any)=>record.runId===attempt.runId&&record.requestId===attempt.requestId&&record.bundleHash===attempt.bundleHash&&record.workerHash===attempt.workerHash&&record.planHash===attempt.planHash&&record.requestContentHash===attempt.requestContentHash&&record.planContentHash===attempt.planContentHash)))throw Error('Final canonical launch set differs from the preserved original bindings')
 const localBindings=[]
 for(const attempt of attempts){
  const requestBytes=await fs.readFile(path.join(workspace,attempt.requestPath)),planBytes=await fs.readFile(path.join(workspace,attempt.planPath)),request=JSON.parse(requestBytes.toString('utf8')),plan=JSON.parse(planBytes.toString('utf8'))
  const passed=hash(requestBytes)===attempt.requestContentHash&&hash(planBytes)===attempt.planContentHash&&processPlanHash(plan)===attempt.planHash&&
   request.requestId===attempt.requestId&&request.runId===attempt.runId&&request.trialId===attempt.trialId&&request.projectId===projectId&&
   request.bundleHash===attempt.bundleHash&&request.workerHash===attempt.workerHash&&plan.runId===attempt.runId&&plan.bundleHash===attempt.bundleHash&&plan.workerHash===attempt.workerHash
  localBindings.push({runId:attempt.runId,requestId:attempt.requestId,planHash:attempt.planHash,passed})
 }
 const authorization=await Bun.file(path.join(operator,'launch-fence.json')).json()
 const code=`import json,pathlib,subprocess,datetime,os,hashlib
root=pathlib.Path(${JSON.stringify(remote.root)})
processes=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit() or int(d.name)==os.getpid():continue
 try:
  args=(d/'cmdline').read_bytes().decode(errors='replace').split('\\x00')
  cwd=str((d/'cwd').resolve())
  if any(str(root) in a for a in args) or cwd.startswith(str(root)+'/') or cwd==str(root):processes.append({'pid':int(d.name),'executable':pathlib.Path(args[0]).name})
 except (OSError,IndexError):pass
receipts=[]
for d in sorted((root/'runs').glob('*')):
 f=d/'remote-receipt.json'
 if f.is_file():
  v=json.loads(f.read_text());row={k:v.get(k) for k in ['runId','requestId','bundleHash','planHash','workerHash','state','exitCode','completedAt','neverStarted','terminationProof']}
  plan_file=d/'remote-plan.json';plan=json.loads(plan_file.read_text()) if plan_file.is_file() else None
  row['remotePlanHash']='sha256:'+hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest() if plan else None
  registry_file=d/'process-registry.json';registry=json.loads(registry_file.read_text()) if registry_file.is_file() else None
  row['registryStartedAt']=registry.get('startedAt') if registry else None;row['workerEverRegistered']=bool(registry and registry.get('worker'))
  exit_file=d/'worker-exit.json';row['workerExit']=json.loads(exit_file.read_text()) if exit_file.is_file() else None
  row['outputManifestPresent']=(d/'output/manifest.json').is_file();receipts.append(row)
gpu=subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_gpu_memory','--format=csv,noheader'],text=True,capture_output=True,timeout=10)
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originalRoot':str(root),'originalProcesses':processes,'receipts':receipts,'gpuQueryReturnCode':gpu.returncode,'gpuComputeProcesses':gpu.stdout.strip(),'readOnly':True}))
`
 const child=Bun.spawn(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','--',remote.host,remote.python+' -'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 child.stdin.write(code);child.stdin.end();const timer=setTimeout(()=>child.kill(),40000)
 let response:string,exitCode:number
 try{[response,exitCode]=await Promise.all([new Response(child.stdout).text(),child.exited]);const stderr=await new Response(child.stderr).text();if(exitCode)throw Error('Original shutdown observation failed: '+stderr.slice(0,1000))}finally{clearTimeout(timer)}
 const observation=JSON.parse(response),expected=new Set(attempts.map((item:any)=>item.runId))
 const receiptIds=new Set(observation.receipts.map((item:any)=>item.runId))
 const receiptChecks=observation.receipts.map((item:any)=>{
  const attempt=attempts.find((attempt:any)=>attempt.runId===item.runId),end=item.completedAt,start=item.registryStartedAt,observedSeconds=Date.parse(observation.observedAt)/1000
  const exactIdentity=!!attempt&&item.bundleHash===attempt.bundleHash&&item.workerHash===attempt.workerHash&&item.planHash===attempt.planHash&&item.remotePlanHash===attempt.planHash&&(item.requestId==null||item.requestId===attempt.requestId)
  const validTerminalTime=typeof end==='number'&&Number.isFinite(end)&&end>=Date.parse(authorization.authorizedAt)/1000-60&&end<=observedSeconds+60&&(start==null||typeof start==='number'&&Number.isFinite(start)&&end>=start)
  const exitStateConsistent=item.state==='succeeded'?item.exitCode===0&&item.outputManifestPresent:item.state==='failed'?Number.isSafeInteger(item.exitCode)&&(item.exitCode!==0||!item.outputManifestPresent):
   ['cancelled','timed_out'].includes(item.state)&&(Number.isSafeInteger(item.exitCode)||item.exitCode===null&&(item.neverStarted===true||item.workerEverRegistered===false||!!item.terminationProof))
  const hostTerminalConsistent=attempt?.hostRunStatus==='succeeded'?item.state==='succeeded':attempt?.hostRunStatus==='cancelled'?item.state==='cancelled':attempt?.hostRunStatus==='failed'&&['failed','timed_out'].includes(item.state)
  const exit=item.workerExit,workerExitConsistent=!exit?item.state!=='succeeded':exit.runId===item.runId&&exit.bundleHash===item.bundleHash&&exit.workerHash===item.workerHash&&exit.planHash===item.planHash&&exit.state===item.state&&exit.exitCode===item.exitCode&&exit.completedAt===item.completedAt
  return {runId:item.runId,requestId:attempt?.requestId,planHash:attempt?.planHash,exactIdentity,validTerminalTime,exitStateConsistent,hostTerminalConsistent,workerExitConsistent,
   passed:exactIdentity&&validTerminalTime&&exitStateConsistent&&hostTerminalConsistent&&workerExitConsistent}
 })
 const originalReceiptsTerminal=expected.size===attempts.length&&receiptIds.size===expected.size&&receiptChecks.every((item:any)=>item.passed)&&localBindings.every(item=>item.passed)
 const passed=observation.originalProcesses.length===0&&originalReceiptsTerminal&&observation.gpuQueryReturnCode===0
 const noGpuWork=attempts.length===0
 await save('shutdown-evidence.json',{...observation,expectedOriginalRuns:[...expected],localBindings,receiptChecks,originalReceiptsTerminal,passed,noGpuWork,
  scientificExecutionCovered:!noGpuWork&&receiptChecks.some((item:any)=>item.passed),newEffects:0,inferenceCalls:0,remoteMutationCalls:0})
 console.log(JSON.stringify({mode:'original_read_only_shutdown',passed,noGpuWork,originalProcesses:observation.originalProcesses,originalReceiptsTerminal}))
 if(!passed)process.exitCode=1
}
async function checkHost(){
 await pins()
 if(await Bun.file(path.join(operator,'launch-fence.json')).exists())throw Error('Fresh readiness cannot replace observation of an already launched original run')
 const profile=await Bun.file(path.join(operator,'profile.json')).json(),remote=profile.remote
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-search-validation-20261013-retry1'||remote.python!=='/home/vincent/autofold-env/bin/python')throw Error('Authorized read-only host destination differs')
 const code=`import json,pathlib,subprocess,datetime,os,hashlib
config=json.loads(${JSON.stringify(JSON.stringify({remote,proto:profile.proto}))})
remote=config['remote'];root=pathlib.Path(remote['root'])
paths=[remote['protoRoot'],str(pathlib.Path(remote['protoRoot'])/'proto-tools'),remote['python'],remote['protoHome'],remote['inspectionBubblewrap']]
required={p:pathlib.Path(p).exists() for p in paths}
env=dict(os.environ,GIT_OPTIONAL_LOCKS='0')
def git(where,args):
 p=subprocess.run(['git','-C',where,*args],text=True,capture_output=True,timeout=15,env=env)
 return {'returnCode':p.returncode,'output':p.stdout.strip(),'error':p.stderr[:500] if p.returncode else None}
directories={'language':remote['protoRoot'],'tools':str(pathlib.Path(remote['protoRoot'])/'proto-tools')}
commits={name:git(directory,['rev-parse','HEAD']) for name,directory in directories.items()}
dirty={name:git(directory,['-c','core.fsmonitor=false','-c','core.untrackedCache=false','status','--porcelain','--untracked-files=all']) for name,directory in directories.items()}
workers=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit() or int(d.name)==os.getpid():continue
 try:
  args=(d/'cmdline').read_bytes().decode(errors='replace').split('\\x00')
  if any('run_worker.py' in a or 'autofold_worker' in a for a in args):workers.append({'pid':int(d.name),'executable':pathlib.Path(args[0]).name})
 except (OSError,IndexError):pass
gpu=subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_gpu_memory','--format=csv,noheader'],text=True,capture_output=True,timeout=10)
bwrap=pathlib.Path(remote['inspectionBubblewrap'])
bwrap_hash=hashlib.sha256(bwrap.read_bytes()).hexdigest() if bwrap.is_file() else None
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'freshRootAbsent':not root.exists(),'requiredPaths':required,'workerProcesses':workers,'computeReturnCode':gpu.returncode,'gpuComputeProcesses':gpu.stdout.strip(),'gpuQueryError':gpu.stderr[:500] if gpu.returncode else None,'commits':commits,'dirty':dirty,'inspectionBubblewrapSha256':bwrap_hash,'readOnly':True,'newScientificEffects':0,'providerCalls':0}))
`
 const child=Bun.spawn(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','--',remote.host,remote.python+' -'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 child.stdin.write(code);child.stdin.end();const timer=setTimeout(()=>child.kill(),40000)
 let response:string
 try{const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exit)throw Error('Read-only host readiness failed: '+stderr.slice(0,1000));response=stdout}finally{clearTimeout(timer)}
 const observation=JSON.parse(response),expected={language:profile.proto.languageCommit,tools:profile.proto.toolsCommit}
 const commitsMatched=Object.entries(expected).every(([name,commit])=>observation.commits[name]?.returnCode===0&&observation.commits[name]?.output===commit)
 const nativeTreesClean=Object.values(observation.dirty).every((item:any)=>item.returnCode===0&&item.output==='')
 const bubblewrapMatched=observation.inspectionBubblewrapSha256===remote.inspectionBubblewrapSha256
 const passed=observation.freshRootAbsent&&Object.values(observation.requiredPaths).every(Boolean)&&observation.workerProcesses.length===0&&observation.computeReturnCode===0&&!observation.gpuComputeProcesses&&commitsMatched&&nativeTreesClean&&bubblewrapMatched
 await save('host-readiness.json',{...observation,commitsMatched,nativeTreesClean,bubblewrapMatched,passed})
 console.log(JSON.stringify({mode:'read_only_fresh_host_readiness',passed,commitsMatched,nativeTreesClean,bubblewrapMatched,freshRootAbsent:observation.freshRootAbsent,workerProcessCount:observation.workerProcesses.length,providerCalls:0,newScientificEffects:0}))
 if(!passed)process.exitCode=1
}
// Pinned Proto utils/io.py exposes result rows and pre-selection proposal rows
// separately. Never count recursively repeated metrics as distinct evaluations.
function auditObjectiveHistory(stage:any,output:any,constraintLabel:string,targetSequence:string,selectedSequence:string){
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
 const initial=read(history[0]?.results?.[0],'initial'),retained=read(history[1]?.results?.[0],'retained')
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
function checkHistoryFixtures(){
 const output={lane:0,construct:'complex',segment:'binder'},target='A'.repeat(120),initial='ACDEFGHIKLMN',mutated='CCDEFGHIKLMN',label='objective'
 const row=(sequence:string,iptm:number)=>({result_idx:0,energy_score:1-iptm,constructs:[{label:'complex',segments:[{label:'binder',sequence,constraints:{[label]:{score:1-iptm,weight:1,weighted_score:1-iptm,data:{iptm,structure_tool:'boltz2'}}}},{label:'target',sequence:target,constraints:{[label]:{score:1-iptm,weight:1,weighted_score:1-iptm,data:{iptm,structure_tool:'boltz2'}}}}]}]})
 const fixture=(accepted:boolean)=>({energyScores:[accepted?0.2:0.4],history:[{time_step:0,best_result_idx:0,optimizer:{type:'mcmc'},results:[row(initial,.6)]},{time_step:1,best_result_idx:0,optimizer:{type:'mcmc'},results:[row(accepted?mutated:initial,accepted?0.8:0.6)],proposal_results:[{...row(mutated,accepted?0.8:0.4),proposal_idx:0,accepted,rejected_by:accepted?null:'Metropolis-Hastings rejection'}]}]})
 const fixtures:any[]=[{name:'valid-accepted',value:fixture(true),selected:mutated,expected:true},{name:'valid-rejected-retains-initial',value:fixture(false),selected:initial,expected:true}]
 const duplicate=fixture(false);duplicate.history[1]!.proposal_results![0]!.constructs[0]!.segments[0]!.sequence=initial;fixtures.push({name:'duplicated-initial-is-not-proposal',value:duplicate,selected:initial,expected:false})
 const missing:any=fixture(false);delete missing.history[1].proposal_results[0].constructs[0].segments[0].constraints[label].data.iptm;fixtures.push({name:'rejected-proposal-missing-iptm',value:missing,selected:initial,expected:false})
 const malformed=fixture(true);malformed.history[1]!.proposal_results![0]!.energy_score=1;fixtures.push({name:'proposal-energy-mismatch',value:malformed,selected:mutated,expected:false})
 const failed:any=fixture(false);failed.history[1].proposal_results[0].constructs[0].segments[0].constraints[label].data.structure_iptm_error='missing metric';fixtures.push({name:'proposal-error-with-retained-valid-metrics',value:failed,selected:initial,expected:false})
 const results=fixtures.map(item=>({...item,value:undefined,audit:auditObjectiveHistory(item.value,output,label,target,item.selected)})),passed=results.every(item=>item.audit.passed===item.expected)
 console.log(JSON.stringify({mode:'local_objective_history_fixtures',passed,results,providerCalls:0,remoteCalls:0}))
 if(!passed)throw Error('Objective history fixture regression')
}
const [mode,...args]=process.argv.slice(2)
if(mode==='--check-campaign-fixture'){if(args.length)throw Error('Unexpected campaign-fixture arguments');await checkCampaignFixture();process.exit(0)}
if(mode==='--check-history-fixtures'){if(args.length)throw Error('Unexpected history-fixture arguments');checkHistoryFixtures();process.exit(0)}
if(mode==='--prepare'){if(args.length!==1)throw Error('Use --prepare <root-owned passed gate manifest>');await prepare(args[0]!);process.exit(0)}
if(mode==='--source-identity'){if(args.length)throw Error('Unexpected source-identity arguments');console.log(JSON.stringify(await source()));process.exit(0)}
if(mode==='--inspect-pricing'){
 if(args.length<1||args.length>2)throw Error('Use --inspect-pricing <public endpoint metadata JSON> [prepared text-only payload JSON] for local-only pricing qualification')
 const raw=await fs.readFile(path.resolve(main,args[0]!),'utf8'),pricing={endpoints:endpointPricing(JSON.parse(raw)),responseHash:hash(raw),observedAt:'local_file_inspection'}
 const payload=args[1]?JSON.parse(await fs.readFile(path.resolve(main,args[1]),'utf8')):{model:model.modelId,messages:[{role:'user',content:'Read verified receipts.'}],max_tokens:DEFAULT_MODEL.maxTokens}
 const reservation=requestReservation(payload,pricing)
 console.log(JSON.stringify({mode:'local_public_pricing_inspection',endpoints:pricing.endpoints.length,reservation,
  admissibleAtEmptyGrant:reservation.sdkMaximumUsd<=scope.modelBudgetUsd&&reservation.providerMaximumUsd<=scope.reportedInferenceCeilingUsd,providerCalls:0,remoteCalls:0}))
 process.exit(0)
}
if(args.length)throw Error('Unexpected driver arguments')
if(mode==='--verify-preparation'){await pins();console.log(JSON.stringify({mode:'verified_local_preparation',remoteCalls:0,providerCalls:0}));process.exit(0)}
if(mode==='--check-pricing'){await checkPricing();process.exit(process.exitCode??0)}
if(mode==='--check-host'){await checkHost();process.exit(process.exitCode??0)}
if(mode==='--verify-shutdown'){await verifyShutdown();process.exit(process.exitCode??0)}
if(mode!=='--launch')throw Error('Use --prepare for local-only final pinning, --verify-shutdown for original read-only physical verification, or --launch for the one original bounded campaign')
async function persistedSessions(){
 const file=path.join(workspace,'.autofold/pi',projectId,'sessions.sqlite')
 if(!await Bun.file(file).exists())return {sessions:[],leases:[],journal:[]}
 const db=new Database(file,{readonly:true}),reader=openSessionReader(file)!
 try{const ids=(db.query('SELECT id FROM pi_sessions').all() as {id:string}[]).map(r=>r.id),sessions=[],journal=[]
  for(const id of ids){const session=await reader.get(id);if(!session)throw Error('Original session archive unavailable: '+id);sessions.push(session);journal.push(...await reader.events(id))}
  return {sessions,leases:db.query('SELECT session_id,expires_at FROM pi_leases WHERE expires_at>?').all(Date.now()),journal}
 }finally{reader.close();db.close()}
}
const prepared=await pins(),grant=await Bun.file(path.join(operator,'human-grant.json')).json()
if(Object.entries(scope).some(([key,value])=>grant[key]!==value)||JSON.stringify(grant.model)!==JSON.stringify(model)||grant.sourceHash!==prepared.sourceHash||JSON.stringify(grant.routing)!==JSON.stringify(routing))throw Error('Fresh bounded grant mismatch')
const profile=await Bun.file(prepared.profile.path).json()
if(profile.remote?.host!=='workstation_4090'||profile.remote?.root!=='/home/vincent/.autofold-learned-search-validation-20261013-retry1')throw Error('Fresh authorized worker destination differs')
const readiness=await Bun.file(path.join(operator,'host-readiness.json')).json()
if(readiness.passed!==true||readiness.commitsMatched!==true||readiness.nativeTreesClean!==true||readiness.bubblewrapMatched!==true||!Number.isFinite(Date.parse(readiness.observedAt))||Date.now()-Date.parse(readiness.observedAt)>600000||readiness.computeReturnCode!==0||readiness.gpuComputeProcesses||readiness.workerProcesses.length||!readiness.freshRootAbsent||!Object.values(readiness.requiredPaths).every(Boolean))throw new Error('Idle bound host readiness required')
const pricing=await Bun.file(path.join(operator,'pricing-latest.json')).json()
if(pricing.passed!==true||pricing.url!==pricingURL||pricing.sdkMetadataHash!=='sha256:'+operationHash(DEFAULT_MODEL)||!Number.isFinite(Date.parse(pricing.observedAt))||Date.now()-Date.parse(pricing.observedAt)>600000||!/^pricing-response-[A-Za-z0-9-]+\.json$/.test(pricing.responseFile))throw Error('Fresh public default-route pricing proof required')
const pricingRaw=await fs.readFile(path.join(operator,pricing.responseFile),'utf8')
if(hash(pricingRaw)!==pricing.responseHash||operationHash(endpointPricing(JSON.parse(pricingRaw)))!==operationHash(pricing.endpoints))throw Error('Published pricing proof differs from its original raw response')
const credentials=await Bun.file('/Users/vincentallam/.local/share/openscience/auth.json').json()
if(typeof credentials.openrouter?.key!=='string'||!credentials.openrouter.key)throw new Error('Selected host credential unavailable')
delete process.env.OPENROUTER_API_KEY
const inherited=await inspectOriginalGrant();assertOriginalDeadline(inherited.fence)
if(grant.authorizedAt!==inherited.fence.authorizedAt||grant.deadline!==inherited.fence.deadline)throw Error('Retry cannot reset original authorization or deadline')
const launchMs=Date.now(),authorizedAt=inherited.fence.authorizedAt,deadlineMs=Date.parse(inherited.fence.deadline)
await save('launch-fence.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),retryLaunchedAt:new Date(launchMs).toISOString(),originalWorkspace,originalProjectId,projectId,workspace,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,grantHash:hash(await fs.readFile(path.join(operator,'human-grant.json')))},true)
await save('pricing-launch-pin.json',{proof:await pin(path.join(operator,'pricing-latest.json')),response:await pin(path.join(operator,pricing.responseFile)),responseHash:pricing.responseHash,assumptions:pricingAssumptions},true)
const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new Error('Original long-range deadline reached')),deadlineMs-Date.now())
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort(new Error('Controller interrupted; inspect only original effects')))
let app:Application|undefined,jobId:string|undefined,timer:ReturnType<typeof setInterval>|undefined,busy=false,count=0,stage='preflight',error:unknown
const observations:Promise<unknown>[]=[],providerReceipts:any[]=[],payloadOutputSizing:number[][]=[],inferenceContexts:any[]=[],costReservations:any[]=[];let dispatches=0,reopen=false,reopenForbiddenCalls=0
const authorize=()=>{if(reopen)throw Error('Receipt-only reopen forbids all inference and dispatch');controller.signal.throwIfAborted();if(Date.now()>=deadlineMs)throw new Error('Original deadline expired')}
const providerReportedCost=()=>providerReceipts.length===count&&new Set(providerReceipts.map(r=>r.id)).size===count&&providerReceipts.every(r=>typeof r.id==='string'&&typeof r.provider==='string'&&pricing.endpoints.some((endpoint:any)=>endpoint.provider===r.provider)&&r.model===model.modelId&&!r.error&&!r.identityInvalid&&!r.identityConflict&&!r.observationError&&typeof r.usage?.cost==='number'&&Number.isFinite(r.usage.cost)&&r.usage.cost>=0)?providerReceipts.reduce((n,r)=>n+r.usage.cost,0):null
const recordInferenceContext=async(request:{sessionId:string;requestId:string;messages:any[]})=>{
 const persisted=await persistedSessions(),session=persisted.sessions.find(item=>item.id===request.sessionId),modelRequest=session?.modelRequests?.[request.requestId]
 const settled=persisted.journal.findLast((event:any)=>event.sessionId===request.sessionId&&event.type==='model_request_settled'&&event.data?.requestId===request.requestId)
 if(modelRequest?.status!=='settled'||!settled)throw Error('Inference context observation requires the original committed model receipt')
 const freshState=await app!.store.read(projectId)
 const packets=[]
 for(const [messageOrdinal,message] of request.messages.entries()){
  if(message.role!=='toolResult'||message.isError||!['read_context','read_decision_memory','evaluate_trial'].includes(message.toolName)||!Array.isArray(message.content))continue
  for(const [contentOrdinal,part] of message.content.entries()){
   if(part.type!=='text')continue
   let value:any;try{value=JSON.parse(part.text)}catch{continue}
   const packet=value?.decisionMemory??value?.decisionMemoryRefresh?.decisionMemory
   if(value?.exposure==='artifact_reference_only'||!packet||!DecisionMemory.Packet.safeParse(packet).success)continue
   const binding=packet.sourceManifest,experiment=freshState.experiments[binding.scope.experimentId]
   if(binding.scope.projectId!==projectId||!experiment||experiment.campaignId!==binding.scope.campaignId||freshState.campaigns[experiment.campaignId]?.projectId!==projectId||
    experiment.piScientistSessionId!==request.sessionId||!/^exp_[A-Za-z0-9_-]+$/.test(binding.scope.experimentId)||
    !/^sha256:[a-f0-9]{64}$/.test(binding.manifestHash)||binding.manifestPath!=='evidence/memory/'+binding.manifestHash.slice(7)+'.json')continue
   const manifestFile=path.posix.join('.autofold/autoresearch',binding.scope.experimentId,binding.manifestPath)
   let manifestVerification:any
   try{
    const raw=await fs.readFile(await checkedPath(workspace,manifestFile)),manifest=DecisionMemory.SourceManifest.parse(JSON.parse(raw.toString('utf8')))
    const manifestHash='sha256:'+operationHash(manifest)
    manifestVerification={status:manifestHash===binding.manifestHash&&manifest.snapshotHash===binding.snapshotHash&&operationHash(manifest.scope)===operationHash(binding.scope)?'verified':'mismatch',
     manifestFile,manifestContentHash:hash(raw),manifestHash,snapshotHash:manifest.snapshotHash,scope:manifest.scope}
   }catch(error){manifestVerification={status:'unavailable',manifestFile,error:error instanceof Error?error.message:String(error)}}
   packets.push({messageOrdinal,contentOrdinal,toolName:message.toolName,toolCallId:message.toolCallId,contentHash:hash(part.text),
    packetHash:'sha256:'+operationHash(packet),packet,manifestVerification})
  }
 }
 const observation={format:'autofold.actual-inference-memory.v1',observedAt:new Date().toISOString(),sessionId:request.sessionId,requestId:request.requestId,
  settledSequence:settled.sequence,upstreamRequestId:modelRequest.providerBilling?.upstreamRequestId,transcriptHash:'sha256:'+operationHash(request.messages),messageCount:request.messages.length,
  messages:request.messages.map((message:any,ordinal:number)=>({ordinal,role:message.role,messageHash:'sha256:'+operationHash(message),...(message.role==='toolResult'?{toolName:message.toolName,toolCallId:message.toolCallId,isError:!!message.isError}: {})})),
  packets,authority:'Exact effective ordinary inference content after original model settlement; hidden tool details and context preparation alone are excluded.'}
 inferenceContexts.push(observation);await save('inference-context-'+request.sessionId+'-'+request.requestId+'.json',observation,true)
}
const admitSpend=async(payload:any,persist=false)=>{
 authorize();await Promise.all(observations)
 const sdkSpent=(await persistedSessions()).sessions.reduce((n,s)=>n+s.usage.costUsd,0),reportedSpent=providerReportedCost()
 if(count&&reportedSpent===null)throw Error('Original provider billing unresolved; no further inference')
 if(count>=grant.maximumModelRequests)throw Error('Fresh model request ceiling reached')
 const reservation=requestReservation(payload,pricing)
 if(sdkSpent+reservation.sdkMaximumUsd>grant.modelBudgetUsd||Number(reportedSpent??0)+reservation.providerMaximumUsd>grant.reportedInferenceCeilingUsd)throw Error('Worst-case published-price request reservation exceeds remaining inference grant; native output reservation is unchanged')
 if(persist){const item={...reservation,requestSequence:count+1,priorSdkSpentUsd:sdkSpent,priorReportedSpentUsd:reportedSpent??0,observedAt:new Date().toISOString()};costReservations.push(item);await save('cost-reservation-'+item.requestSequence+'.json',item,true)}
 return reservation
}
const auditedFetch=Object.assign(async(url:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
 if(new URL(String(url)).origin!=='https://openrouter.ai')throw new Error('Unapproved model recipient')
 const payload=JSON.parse(String(init?.body));const reservation=await admitSpend(payload,true),caps=reservation.nativePayloadOutputSizing
 const actual=providerReportedCost();payloadOutputSizing.push(caps);count++;const sequence=count
 await save('route-latest.json',{count,model,routing,providerOverridePresent:false,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,
  nativePayloadOutputSizing:caps,payloadMessageCharacters:JSON.stringify(payload.messages??[]).length,priorReportedProviderCostUsd:actual,
  costReservation:{sdkMaximumUsd:reservation.sdkMaximumUsd,providerMaximumUsd:reservation.providerMaximumUsd},recordedAt:new Date().toISOString()})
 const response=await fetch(url,init),clone=response.clone()
 const observation=(async()=>{if(!response.ok){void clone.body?.cancel();const r={requestSequence:sequence,status:response.status,error:{classification:'router_http_error',code:response.status,message:'OpenRouter rejected original request; billing remains unknown'},observedAt:new Date().toISOString()};providerReceipts.push(r);await save('provider-response-'+sequence+'.json',r,true);return}const reader=clone.body?.getReader();if(!reader)return;let pending='',metadata:any={requestSequence:sequence,status:response.status},decoder=new TextDecoder()
  const consume=(line:string)=>{if(!line.startsWith('data: '))return;try{const c=JSON.parse(line.slice(6));for(const k of ['id','provider','model'])if(c[k]!==undefined&&c[k]!==null){if(typeof c[k]!=='string'||c[k].length>256){metadata.identityInvalid=true;continue}if(metadata[k]&&metadata[k]!==c[k])metadata.identityConflict=true;metadata[k]=c[k]}if(c.error)metadata.error={classification:'router_stream_error',message:'Original stream returned an error; billing requires original evidence'};if(c.usage&&typeof c.usage==='object'){metadata.usage??={};for(const key of ['cost','prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens'])if(typeof c.usage[key]==='number'&&Number.isFinite(c.usage[key]))metadata.usage[key]=c.usage[key]}}catch{}}
  try{for(;;){const v=await reader.read();if(v.done)break;pending+=decoder.decode(v.value,{stream:true});let i;while((i=pending.indexOf('\n'))>=0){consume(pending.slice(0,i));pending=pending.slice(i+1)}}consume(pending)}catch(e){metadata.observationError='original_stream_read_failed'}finally{reader.releaseLock()}
  const receipt={...metadata,observedAt:new Date().toISOString()};providerReceipts.push(receipt);await save('provider-response-'+sequence+'.json',receipt,true)
 })();observations.push(observation);return response
},{preconnect:fetch.preconnect})
async function bindOriginalJob(state:Awaited<ReturnType<Application['store']['read']>>){if(jobId)return;const originals=Object.values(state.jobs).filter(j=>j.payload.kind==='autoresearch');if(originals.length===1)jobId=originals[0]!.id;else if(originals.length>1)throw Error('Ambiguous original acceptance job identity')}
const observe=async()=>{if(!app||busy)return;busy=true;try{const state=await app.store.read(projectId);await bindOriginalJob(state);dispatches=0;for(const run of Object.values(state.runs))if(await Bun.file(path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json')).exists())dispatches++;const snapshot={stage,observedAt:new Date().toISOString(),jobId:jobId??Object.values(state.jobs).find(j=>j.payload.kind==='autoresearch')?.id,jobs:Object.values(state.jobs).map(j=>({id:j.id,kind:j.payload.kind,status:j.status,cost:j.result?.modelCostUsd})),trials:Object.values(state.trials).map(t=>({id:t.id,status:t.status})),runs:Object.values(state.runs).map(r=>({id:r.id,status:r.status})),operations:await app.operationDiagnostics(),providerRequests:count,originalDispatches:dispatches,providerReportedCostUsd:providerReportedCost(),canonicalCostSemantics:'sdk_static_price_estimate',actualProviders:[...new Set(providerReceipts.map(r=>r.provider).filter(Boolean))]};await save('monitor-latest.json',snapshot);console.log(JSON.stringify(snapshot))}catch(e){console.error(JSON.stringify({type:'observation_error',message:String(e)}))}finally{busy=false}}
try{
 const config=(await loadExecutionConfig(prepared.profile.path))!
 app=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,deadlineMs,authorize}},jobs:{runtimeOptions:{
  getApiKey:p=>p==='openrouter'?credentials.openrouter.key:undefined,authorizeModelRequest:authorize,requireProviderReportedUsage:true,
  onInferenceContext:recordInferenceContext,limits:{maxTurns:64,maxToolCalls:128,maxDurationMs:3600000},
  streamOptions:{maxRetries:0,fetch:auditedFetch,onPayload:async(payload:any,m:any)=>{
   if(m.provider!==model.provider||m.id!==model.modelId)throw Error('Authorized model changed')
   if(m.api!==DEFAULT_MODEL.api||m.contextWindow!==DEFAULT_MODEL.contextWindow||m.maxTokens!==DEFAULT_MODEL.maxTokens||operationHash(m.cost)!==operationHash(DEFAULT_MODEL.cost))throw Error('Selected SDK capacity/pricing metadata differs from the frozen reservation model')
   const {provider:ignored,...routed}=payload
   try{await admitSpend(routed)}catch(error){
    // This supported payload observer runs before provider HTTP dispatch. The
    // later auditedFetch boundary remains generic/unknown on transport failure.
    throw new PiLocalPayloadAdmissionRejected(error instanceof Error?error.message:String(error))
   }
   return routed
  }}
 }}})

 const contract=ResearchDomain.ExperimentContract.parse(await Bun.file(prepared.contract.path).json());const frozenProfile=await Bun.file(prepared.profile.path).json();if(contract.budget.maximumCandidates!==1||contract.budget.gpuHours!==600/3600||contract.budget.wallTimeMinutes!==15||JSON.stringify(contract.evaluator.fixedSeeds)!=='[20260809]'||contract.evaluator.submissionSize!==1||frozenProfile.authorization.maximumGpuSeconds!==600||frozenProfile.authorization.maximumCandidates!==1||frozenProfile.authorization.maximumWallTimeMinutes!==15)throw Error('Frozen per-trial grant differs')
 if(ResearchDomain.hashContract(contract)!==prepared.contractHash)throw new Error('Frozen scientific contract changed')
 const campaign=await app.research.createCampaign(projectId,{objective:campaignObjective});await app.research.activateCampaign(projectId,campaign.id)
 const experiment=await app.research.createExperiment(projectId,campaign.id,{contract});await app.research.activateExperiment(projectId,experiment.id)
 await app.store.mutate(projectId,state=>{state.campaignCharters[campaign.id]!.constraints.maximumCampaignTrials=2;state.campaignCharters[campaign.id]!.constraints.maximumCampaignGpuHours=2*contract.budget.gpuHours})
 await app.skills.initialize(campaign.id)
 await app.execution.preflightExperiment(await app.experiment(experiment.id),controller.signal)
 await pins()
 const job=await app.campaign.enqueueCampaign(campaign.id,{idempotencyKey:'fresh-learned-search-validation-20261013-retry1',experimentId:experiment.id,maxSteps:1,maximumTrajectories:2,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:0,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:2,perChildModelBudgetUsd:2,maximumDurationMs:Math.max(1,deadlineMs-Date.now()),modelSelection:model})
 jobId=job.id
 await save('authorization.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),workspace,projectId,campaignId:campaign.id,experimentId:experiment.id,jobId,contractHash:experiment.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,limits:grant,controlledFault:false,operatorAuthoredScience:false},true)
 await save('original-job-identity.json',{jobId,sessionId:job.payload.sessionId,campaignId:campaign.id,experimentId:experiment.id},true)
 stage='native_cohesive_engine_campaign';await observe();timer=setInterval(()=>void observe(),30000)
 await app.jobs.runOnce({jobId,signal:controller.signal})
 await Promise.all(observations);await pins()
 let state=await app.store.read(projectId)
 await save('campaign-result.json',await app.jobs.get(jobId),true)
 if(Object.keys(state.trials).length>2||Object.keys(state.runs).length>2||Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length>2||Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length>0)throw new Error('Fresh trial grant exceeded')
 const attempts=[];for(const run of Object.values(state.runs)){const file=path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json');if(await Bun.file(file).exists())attempts.push(await originalDispatchBinding(run))}dispatches=attempts.length;if(dispatches>2)throw Error('Original launch attempt grant exceeded');await save('original-dispatch-records.json',attempts,true)
 const trialBudgetChecks=[];for(const run of Object.values(state.runs)){const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json(),planFile=path.join(workspace,path.dirname(run.bundlePath),'remote-plan.identity.json'),plan=await Bun.file(planFile).exists()?await Bun.file(planFile).json():undefined;trialBudgetChecks.push({runId:run.id,reservedComputeSeconds:bundle.nativeExecution?.resources?.maximumComputeReservationSeconds,passed:bundle.candidateBudget===1&&bundle.submissionSize===1&&JSON.stringify(bundle.seeds)==='[20260809]'&&bundle.nativeExecution?.observation==='scoped_native_lifecycle_v1'&&bundle.nativeExecution.resources.maximumSearchWallSeconds===300&&bundle.nativeExecution.resources.reservedSearchComputeSeconds===300&&bundle.nativeExecution.resources.reservedEvaluationComputeSeconds===300&&bundle.nativeExecution.resources.maximumComputeReservationSeconds===600&&bundle.contractHash===prepared.contractHash&&bundle.targetArtifactHash===contract.targetArtifactHash&&bundle.evaluator?.id===contract.evaluator.id&&bundle.evaluator?.version===contract.evaluator.version&&(!plan||Number.isFinite(plan.timeoutMs)&&plan.timeoutMs>0&&plan.timeoutMs<=15*60000&&Number.isFinite(plan.authorizationDeadlineMs)&&plan.authorizationDeadlineMs<=deadlineMs)})}
 let sessions=await persistedSessions();for(const session of sessions.sessions)assertSessionAccountingComplete(session)
 await save('sessions.json',sessions.sessions,true);await save('pi-events.json',sessions.journal,true)
 const receipts=[],failedReceipts=[],learnedSearchChecks=[],generationSeedChecks=[]
 const targetArtifact=await ResearchArtifacts.readTarget(workspace,contract.targetArtifactHash)
 const targetContents=await Bun.file(path.join(workspace,targetArtifact.targetArtifactPath)).json()
 const targetSequence=targetContents.chains[0]?.sequence
 if(typeof targetSequence!=='string'||targetSequence.length!==120)throw Error('Frozen full target chain differs')
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
  const objectiveHistory=observedStages.length===1?auditObjectiveHistory(observedStages[0],selectedOutput,structuralConstraints[0]?.label,targetSequence,native.selected[0]?.sequence?.sequence):{passed:false,errors:['Expected exactly one observed optimizer stage']}
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
  const verifier=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,authorize:noInference}},jobs:{runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
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
 const checks={costReservationsVerified,aggregateComputeReservationRespected:aggregateComputeReservationSeconds!==null&&aggregateComputeReservationSeconds<=grant.maximumGpuSecondsAggregate,learnedModelInsideNativeSearchVerified:learnedSearchChecks.length===2&&learnedSearchChecks.every(item=>item.passed),generationRandomnessVerified,memoryInformedFollowupVerified:Object.values(feedbackChecks).every(Boolean),nativeAuthoringVerified:authoringChecks.every(item=>item.passed)&&authoringChecks.length>0,legacyAuthoringToolsAbsent:legacyToolAbsence,failedOriginalReceiptsVerified:failedReceipts.length===Object.values(state.runs).filter(run=>['failed','cancelled'].includes(run.status)).length&&failedReceipts.every(receipt=>receipt.workerHash===prepared.workerHash),finiteGrantRespected:Object.keys(state.trials).length<=2&&Object.keys(state.runs).length<=2&&attempts.length<=2&&count<=128&&Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length<=2&&Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length===0&&payloadOutputSizing.length===count&&payloadOutputSizing.every(c=>c.length>0&&c.every(v=>Number.isSafeInteger(v)&&v>0))&&grant.autofoldOutputTokenCap===null&&grant.outputPolicy==='pi_and_provider_default'&&trialBudgetChecks.every(r=>r.passed),validLockedEvaluation:receipts.length>0&&receipts.every(r=>r.valid),uniqueOriginalLaunches:attempts.length===Object.values(state.runs).length&&new Set(attempts.map(r=>r.runId)).size===attempts.length,successfulScientificRuns:receipts.length>0&&receipts.every(r=>r.scientific),allSuccessfulReceiptsVerified:receipts.length===Object.values(state.runs).filter(r=>r.status==='succeeded').length,originalWorker:receipts.every(r=>r.workerHash===prepared.workerHash),settled,canonicalEstimatesReconciled:typeof jobCost==='number'&&Math.abs(jobCost-sessionCost)<1e-8,canonicalReportedUsageReconciled:(state.jobs[jobId]!.result?.providerAccounting as any)?.status==='reported'&&providerCost!==null&&Math.abs(Number((state.jobs[jobId]!.result?.providerAccounting as any)?.reportedCostUsd)-providerCost)<1e-8,providerUsageComplete:responses.length===count&&providerCost!==null,providerUsageBoundExactly:exactBillingIds&&ledgerReportedCost!==null&&providerCost!==null&&Math.abs(ledgerReportedCost-providerCost)<1e-8,requestedModelOnly:responses.length>0&&responses.every(r=>typeof r.provider==='string'&&r.provider.length>0&&r.model===model.modelId&&!r.observationError&&!r.identityConflict&&!r.identityInvalid),bothCostCeilingsRespected:sessionCost<=grant.modelBudgetUsd&&providerCost!==null&&providerCost<=grant.reportedInferenceCeilingUsd,receiptOnlyReopenNoNewEffects:!!recovery&&reopenForbiddenCalls===0&&JSON.stringify(sameOriginalEffects(before))===JSON.stringify(sameOriginalEffects(after))}
 const coverage={ordinaryVerifiedRuns:receipts.filter(r=>r.intent!=='shadow_replay').length,replayVerifiedRuns:receipts.filter(r=>r.intent==='shadow_replay').length,failedRuns:Object.values(state.runs).filter(r=>r.status==='failed').length,failedOperations:operations.filter(o=>o.outcome==='failed').length,replayRequested:false,guidanceComparisonLiveCovered:false,skillSelfImprovementLiveCovered:false,scientificImprovementEstablished:false,authority:'Engineering validation of native learned search and delivered feedback; no paired replay or skill activation requested'}
 const report={feedbackAudit,memoryDeliveryAudit,costReservations,reservationChecks,pricingAssumptions,pricingResponseHash:pricing.responseHash,aggregateComputeReservationSeconds,coverage,format:'autofold.cohesive-engine-validation.v1',observedAt:new Date().toISOString(),...checks,passed:Object.values(checks).every(Boolean),receipts,failedReceipts,authoringChecks,jobs:Object.values(state.jobs),operations,sdkEstimatedInferenceUsd:sessionCost,providerReportedCostUsd:providerCost,sessionReportedCostUsd:ledgerReportedCost,perRequestBilling,trialBudgetChecks,payloadOutputSizing,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,providerRequests:ledger.map(r=>({sessionId:r.sessionId,requestId:r.requestId,status:r.status,costKind:r.costKind,estimatedCostUsd:r.estimatedCostUsd,canonicalCostUsd:r.reportedCostUsd,providerBilling:r.providerBilling})),costSemantics:'Canonical SDK estimates and separate exact original OpenRouter reported usage; unequal amounts do not fabricate invoice equality',actualProviders:[...new Set(responses.map(r=>r.provider))],originalDispatches:dispatches,providerResponses:responses.length,receiptOnlyReopen:{before,after,recovery,forbiddenInferenceAttempts:reopenForbiddenCalls},controlledFault:false,biologicalValidationEstablished:false,methodImprovementEstablished:false,remoteShutdownVerified:false}
 await save(settled?'settlement-audit.json':'held-state-audit.json',report,true)
 console.log(JSON.stringify({type:'result',passed:report.passed,coverage,checks,receipts,sdkEstimatedInference:sessionCost,providerReportedInference:providerCost,providerResponses:responses.length}))
 stage=report.passed?'settled_pending_physical_shutdown':'held_acceptance_gap';if(!report.passed)process.exitCode=1
}catch(e){error=e;stage='held_exception';await save('original-dispatch-error-observation.json',await captureOriginalDispatchBindings(),true);process.exitCode=1;if(app)await app.store.read(projectId).then(bindOriginalJob).catch(()=>{});await save('driver-error.json',{observedAt:new Date().toISOString(),message:e instanceof Error?e.message:String(e),stack:e instanceof Error?e.stack:undefined,jobId},true);console.error(JSON.stringify({type:'driver_error',message:String(e),jobId}));if(!await Bun.file(path.join(operator,'held-state-audit.json')).exists()&&!await Bun.file(path.join(operator,'settlement-audit.json')).exists())await save('held-state-audit.json',{format:'autofold.cohesive-engine-held-state.v1',observedAt:new Date().toISOString(),passed:false,error:String(e),jobId,providerRequests:count,providerReportedCostUsd:providerReportedCost(),state:app?await app.store.read(projectId).catch(()=>null):null,canonicalSettlementProven:false,receiptVerificationNotCompleted:true,replacementDispatches:0},true)}
finally{clearTimeout(timeout);if(timer)clearInterval(timer);await Promise.allSettled(observations);const finalDispatchObservation=await captureOriginalDispatchBindings();await save('original-dispatch-final-observation.json',finalDispatchObservation,true);if(finalDispatchObservation.status!=='complete'){process.exitCode=1;stage='held_original_dispatch_bindings'};if(!await Bun.file(path.join(operator,'original-dispatch-records.json')).exists())await save('original-dispatch-records.json',finalDispatchObservation.records,true);await observe();await save('driver-exit.json',{observedAt:new Date().toISOString(),stage,jobId,exitCode:process.exitCode??0,error:error?String(error):undefined},true)}
