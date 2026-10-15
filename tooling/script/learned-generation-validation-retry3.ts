import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {Type} from 'typebox'
import {Database} from 'bun:sqlite'
import {ScientistLane} from '../../backend/engine/src/scientist/index.ts'
import {validateScientificMethodology} from '../../backend/engine/src/scientific-methodology.ts'
import {ExperimentBranches} from '../../backend/science-core/src/research/experiment-branches.ts'
import {generationSeed as deriveGenerationSeed} from '../../backend/science-core/src/research/generation-seed.ts'
import {Application} from '../../backend/engine/src/application.ts'
import {loadExecutionConfig} from '../../backend/engine/src/config.ts'
import type {FrozenAssetInput} from '../../backend/engine/src/execution/frozen-assets.ts'
import {assertFrozenAssets} from '../../backend/engine/src/execution/frozen-assets.ts'
import {workerTreeIdentity} from '../../backend/engine/src/execution/index.ts'
import {openSessionReader,assertSessionAccountingComplete,PiLocalPayloadAdmissionRejected,PiRuntime,SqliteSessionStore,createSessionStore,MemorySessionStore} from '../../backend/engine/src/runtime/index.ts'
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
const scope={maximumTrials:4,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:0,
 maximumGpuSeconds:600,maximumGpuSecondsPerTrial:600,maximumGpuSecondsAggregate:2400,maximumSearchWallSeconds:300,maximumWorkerWallMinutes:15,
 computeBudgetSemantics:'maximumGpuSeconds is the per-trial compute reservation; four trials reserve at most 2400 seconds aggregate. Reservations are not measured physical GPU seconds.',
 modelBudgetUsd:2,reportedInferenceCeilingUsd:3,maximumModelRequests:128,
 maximumCampaignSteps:2,perChildModelBudgetUsd:2,maximumDurationMs:3600000,
 authoringGateMaximumTurns:32,maxTurns:64,maxToolCalls:128,autofoldOutputTokenCap:null,outputPolicy:'pi_and_provider_default',providerRetries:0}
const objective=[
 'Validate exactly four fresh LLM-authored ProteinMPNN-generated 12-residue peptide trials against the same full first chain from the immutable PD-L1 target artifact. Derive its length from that verified JSON rather than a remembered length. This is computational architecture validation, not binding or biological evidence.',
 'Each native Program has one RejectionSamplingOptimizer: num_samples=1, num_results=1, proposal_source="generated", proposal_batch_size=1, track_proposals=True, no threshold. Use one genuine ProteinMPNNGenerator assigned only to the binder; one generated proposal is scored and retained. This exercises learned generation plus objective evaluation/selection, not internal hill climbing.',
 'Use the frozen references/bootstrap/proteinmpnn-backbone.pdb: use ctx.read_asset("bootstrap-backbone").decode("utf-8") to obtain its exact host-frozen bytes. The host packages and verifies this experiment-scoped asset at admission and execution. Do not transcribe PDB content, trim spaces, embed rewritten strings or use a machine-local path in generator configuration. This is the unchanged chain-B 12-residue modeled backbone from a verified prior receipt, not an experimentally resolved structure. ProteinMPNNGeneratorConfig uses structure_inputs=[InverseFoldingStructureInput(structure=Structure(structure=PDB_TEXT),chains_to_redesign=["B"])], output_chain_id="B", model_choice="proteinmpnn", batch_size=1, device="cuda". Keep the backbone and all other generator settings fixed.',
 'The first two trials use ProteinMPNN temperature=0.1. Trials three and four must obtain current actually delivered DecisionMemory containing the first two verified results, cite at least one of those original runs, and prospectively choose temperature 0.05 or 0.2 as the scientific intervention. Declare ProtoTrial prediction with an actual first-two comparatorTrialId, metric=locked_score and relation=lower or higher, plus decision_plan.changedVariables naming temperature and outcomeBranches stating a result that would disprove the hypothesis. An initialization sequence alone does not condition unconstrained ProteinMPNN sampling; the actual temperature change must be declared. Varying generation seeds prevent a causal improvement claim.',
 'Use the supported ordinary Constraint with function fixed_predictor_iptm and flat function_config predictor_seed=99173. Read references/bootstrap/predictor-recipe.py and copy its helper verbatim into the authored trial. Follow this pinned procedural recipe exactly: the wrapper constructs StructureBasedConstraintConfig and Boltz2Config(seed=config["predictor_seed"],use_msa=False) inside evaluation and delegates to existing structure_iptm_constraint. Use inputs=[fixed_target,binder], weight=1, no threshold or backward. Do not put seed or seeds keys in wrapper config, because Proto derives those from Program and would overwrite explicit values. Native energy is 1-ipTM, a predicted interface-confidence proxy distinct from frozen evaluation score or affinity.',
 'Program seed must be ctx.generation_seed, and fixed evaluator seeds stay [20260809]. NativeSearch selects only binder via NativeOutput and admits only proteinmpnn-sample and boltz2-prediction, maximum_candidates=1, maximum_proposals=1, maximum_sampling_calls=1, maximum_tool_calls=2, maximum_wall_seconds=300. Construction must not run or sample tools. No external MSA, new models/recipients, replay, or skill activation. Preserve actual failures and unknown costs. Stop after four ordinary trials.'
].join(' ')

const main=path.resolve(import.meta.dir,'../..'),workspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-validation-20261013-retry3')
const projectId='prj_learned_generation_validation_20261013_retry3',operator=path.join(workspace,'operator')
const authoringGatePrompt='Current phase: live authoring-only gate. Your immediate deliverable is your own trial.py and a successful host validate_trial receipt. Frozen RSM settings: num_samples=1, num_results=1, proposal_source="generated", proposal_batch_size=1, track_proposals=True, energy_threshold=None. Frozen ProteinMPNN settings: batch_size=1, device="cuda", model_choice="proteinmpnn", temperature=0.1 for the first two slots, output_chain_id="B", excluded_amino_acids=None; redesign only chain B using the unchanged ctx asset. NativeSearch bounds: one candidate, one proposal, one sampling call, two registered tools, wall300 seconds; select the 12-residue binder only. Read only the necessary API.md, NATIVE_TEMPLATE.py, DECISION_PLAN.schema.json and references/bootstrap/predictor-recipe.py once, then write the first complete baseline draft by your next authoring turn and validate it. Use targeted validator errors to repair the draft; further exploratory filesystem inventories and generic code searches are unnecessary for this fixed protocol. read_context is optional authoring context: if optional runtime metadata is unavailable, use the exact current experiment ID from delivered decision-memory sourceManifest.scope.experimentId as the baseline setup reference, and use the provided contract/API/schema; do not retry optional metadata in a loop. Read the full frozen target JSON using ctx.target_artifact_path and the exact bootstrap with ctx.read_asset("bootstrap-backbone").decode("utf-8"). Author the one ProteinMPNN-generated RSM proposal at temperature0.1, fixed predictor_seed99173, Program(seed=ctx.generation_seed), and a complete decision_plan with at least two alternatives and outcome-dependent branches; prediction=None is appropriate for this unmeasured baseline. Cite the exact current experiment ID as a setup reference; do not invent empirical run or comparator IDs. During this gate only, evaluate_trial and scientific execution are disabled. Success requires an actual successful host validator receipt plus prospective methodology admission, after which the host ends this phase. The host may later enable discovery using this same validated draft unchanged for slot1. No operator scientific Program or peptide candidate is provided.'

const campaignObjective='Validate four ProteinMPNN-generated PD-L1 peptide trials through native Proto sample-and-score search and the frozen Boltz2/Chai1 panel. The first two use temperature 0.1; two later trials use verified delivered memory to choose a prospective temperature intervention on the same frozen computational backbone. Keep predictor seeds fixed and generation streams separately recorded. Stop after four trials without replay or skill activation; do not claim biological binding or causal improvement.'
const bootstrapSource=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/bootstrap')
const bootstrapAssetId='bootstrap-backbone',bootstrapNativeBinding='/projection/0/stages/0/generators/0/config/structure_inputs/0/structure/structure'
const fixedPredictorSeed=99173
const fixedPredictorConfigHash='sha256:8a20e621117fb24b9b5b2e5d871feda78d372101252e7408a38b155eeff8773c'
const predictorRecipeSource="def fixed_predictor_iptm(input_sequences, config):\n    typed=StructureBasedConstraintConfig(structure_tool='boltz2',boltz2_config=Boltz2Config(seed=config['predictor_seed'],use_msa=False))\n    return structure_iptm_constraint(input_sequences,typed)\n"
const predictorRecipeHash='sha256:a894f49c9c29b5cdfdcc654a75fd0694777d3727e239b4573c2d1196a1efec2f'


const model={provider:'openrouter',modelId:'deepseek/deepseek-v4.1-flash'}
const hash=(v:string|Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex')
const terminal=(s:string)=>['succeeded','failed','cancelled'].includes(s)
const modelMetadataURL='https://openrouter.ai/api/v1/models'
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
function canonicalAliasFromMetadata(value:any){
 if(!Array.isArray(value?.data))throw Error('Official model metadata has no model inventory')
 const matches=value.data.filter((entry:any)=>entry.id===model.modelId),canonicalId=matches[0]?.canonical_slug
 if(matches.length!==1||typeof canonicalId!=='string'||!canonicalId||canonicalId.length>256||!/^[A-Za-z0-9_./:-]+$/.test(canonicalId))throw Error('Authorized model requires one explicit official canonical_slug; no alias inference is permitted')
 return {requestedModelId:model.modelId,canonicalModelId:canonicalId,source:'official_openrouter_canonical_slug' as const,mapping:{[model.modelId]:canonicalId}}
}
function verifyCanonicalAliasProof(proof:any,raw:string){
 if(proof?.url!==modelMetadataURL||proof.responseHash!==hash(raw)||proof.httpStatus!==200||!/^model-metadata-response-[A-Za-z0-9-]+\.json$/.test(proof.responseFile??''))throw Error('Official canonical model proof changed')
 const alias=canonicalAliasFromMetadata(JSON.parse(raw))
 if(operationHash(alias)!==operationHash(proof.alias))throw Error('Frozen canonical model alias differs from its official metadata')
 return alias
}
function authorizedStreamModel(id:unknown,alias:{requestedModelId:string;canonicalModelId:string}){return typeof id==='string'&&(id===alias.requestedModelId||id===alias.canonicalModelId)}
function checkAliasFixtures(){
 const metadata={data:[{id:model.modelId,canonical_slug:model.modelId+'-20990101'}]},raw=JSON.stringify(metadata),alias=canonicalAliasFromMetadata(metadata),proof={url:modelMetadataURL,responseHash:hash(raw),httpStatus:200,responseFile:'model-metadata-response-fixture.json',alias},cases:any[]=[{name:'official-explicit-dated-canonical',proof,raw,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone({proof,raw});change(value);cases.push({name,...value,expected:false})}
 mutate('changed-public-proof-bytes',value=>value.raw+=' ')
 mutate('invented-date-prefix-mapping',value=>value.proof.alias.canonicalModelId=model.modelId+'-20990102')
 mutate('missing-explicit-canonical-slug',value=>{const altered={data:[{id:model.modelId}]};value.raw=JSON.stringify(altered);value.proof.responseHash=hash(value.raw)})
 mutate('changed-official-destination',value=>value.proof.url='https://example.test/models')
 const results=cases.map(item=>{let accepted=true;try{verifyCanonicalAliasProof(item.proof,item.raw)}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}}),streamChecks={requestedAccepted:authorizedStreamModel(model.modelId,alias),canonicalAccepted:authorizedStreamModel(alias.canonicalModelId,alias),otherRejected:!authorizedStreamModel(model.modelId+'-20990102',alias)},passed=results.every(item=>item.expected===item.accepted)&&Object.values(streamChecks).every(Boolean)
 console.log(JSON.stringify({mode:'official-canonical-model-alias-fixtures',passed,results,streamChecks,providerCalls:0,remoteCalls:0}));if(!passed)throw Error('Explicit model alias binding regression')
}
async function checkPricing(){
 await pins()
 if(await Bun.file(path.join(operator,'launch-fence.json')).exists())throw Error('Fresh pricing check cannot replace an already launched original grant')
 const response=await fetch(pricingURL,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)})
 if(!response.ok)throw Error('Public endpoint pricing request failed: '+response.status)
 const raw=await response.text(),observedAt=new Date().toISOString(),suffix=Date.now()+'-'+crypto.randomUUID(),responseFile='pricing-response-'+suffix+'.json'
 await fs.writeFile(path.join(operator,responseFile),raw,{flag:'wx',mode:0o600})
 let endpoints:any[]=[],error:string|undefined,modelAliasProof:any
 try{endpoints=endpointPricing(JSON.parse(raw))}catch(value){error=value instanceof Error?value.message:String(value)}
 try{const response=await fetch(modelMetadataURL,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)}),metadataRaw=await response.text(),responseFile='model-metadata-response-'+suffix+'.json';await fs.writeFile(path.join(operator,responseFile),metadataRaw,{flag:'wx',mode:0o600});modelAliasProof={url:modelMetadataURL,httpStatus:response.status,observedAt:new Date().toISOString(),responseHash:hash(metadataRaw),responseFile,alias:canonicalAliasFromMetadata(JSON.parse(metadataRaw))};verifyCanonicalAliasProof(modelAliasProof,metadataRaw)}catch(value){error=[error,value instanceof Error?value.message:String(value)].filter(Boolean).join('; ')}
 const proof={format:'autofold.endpoint-pricing-observation.v1',observedAt,url:pricingURL,responseHash:hash(raw),responseFile,
  sdkMetadataHash:'sha256:'+operationHash(DEFAULT_MODEL),sdkModelMetadata:DEFAULT_MODEL,endpoints,modelAliasProof,assumptions:pricingAssumptions,
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
 await verifyCarryoverPin(p)
 if(s.sourceHash!==p.sourceHash||s.workerHash!==p.workerHash)throw Error('Tested source or worker changed; do not launch stale preparation')
 for(const item of [p.profile,p.contract,p.driver,p.grant,p.gateManifest,p.historicalBefore,p.bootstrap,...p.bootstrapPins,...p.offlineGates,...p.offlineLogs,...p.targetFiles])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Frozen pin changed: '+item.path)
 return p
}
// This is a new attempt with a new deadline, not a new inference budget.
// The original failed authoring run is read-only and never reopened for work.
const carryoverRoot=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-validation-20261013-retry2')
const carryoverProjectId='prj_learned_generation_validation_20261013_retry2'
const carryoverSessionId='ses_scientist_5ea8a52752a7f9f7d1d4a15ccbd55450dfad3926c43c91cf043eb6e27692fcd4'
const carryoverJobId='job_a4d91bf0603948fc9184d22abbede22a'
const expectedCarryover={requests:32,sdkEstimatedUsd:0.100914672,providerReportedUsd:0.023282055}
function assertCarryoverEvidence(input:any){
 const {held,exit,failedGate,shutdown,observer,dispatch,originalRecords,session,journal,receipts,reservations,alias}=input
 if(alias?.requestedModelId!==model.modelId||typeof alias.canonicalModelId!=='string'||!alias.canonicalModelId)throw Error('Original official model identity is missing')
 const job=held?.state?.jobs?.[carryoverJobId],requestEntries=Object.entries(session?.modelRequests??{}) as [string,any][]
 const effects=failedGate?.effects
 if(exit?.exitCode!==1||!Number.isFinite(Date.parse(exit.observedAt))||exit.error!=='Error: Live authoring-only proof failed; no GPU launch is permitted'||held?.error!==exit.error||held.jobId!==carryoverJobId||held.gateJobId!==carryoverJobId||held.authoringGateActive!==true||held.providerRequests!==32)throw Error('Original retry2 exit and held identity must be preserved')
 if(failedGate?.passed!==false||failedGate.workspace!==carryoverRoot||failedGate.projectId!==carryoverProjectId||failedGate.jobId!==carryoverJobId||failedGate.sessionId!==carryoverSessionId||failedGate.checks?.accountingKnown!==true||failedGate.checks?.effectsAbsent!==true||failedGate.checks?.jobBound!==true||failedGate.providerRequests!==32)throw Error('Original retry2 failed authoring evidence is not accounting-complete')
 if(!effects||['trialIds','runIds','originalLaunchRunIds','scientificEvaluationToolStarts','leases','validatedBranchIds'].some(key=>!Array.isArray(effects[key])||effects[key].length)||Object.keys(held.state.trials??{}).length||Object.keys(held.state.runs??{}).length||Object.keys(held.state.jobs??{}).length!==1||Object.values(held.state.operations??{}).some((op:any)=>!terminal(op.phase)))throw Error('Original retry2 has unknown or scientific effects')
 if(shutdown?.passed!==true||shutdown.noGpuWork!==true||shutdown.originalRoot!=='/home/vincent/.autofold-learned-generation-validation-20261013-retry2'||shutdown.newEffects!==0||shutdown.inferenceCalls!==0||!Array.isArray(shutdown.originalProcesses)||shutdown.originalProcesses.length||!Array.isArray(shutdown.receipts)||shutdown.receipts.length||observer?.passed!==true||observer.observerGone!==true||observer.identityMatched!==true||observer.observer?.root!==shutdown.originalRoot)throw Error('Original retry2 physical shutdown and observer stop are required')
 if(dispatch?.status!=='complete'||dispatch.noGpuLaunchRecorded!==true||!Array.isArray(dispatch.records)||dispatch.records.length||!Array.isArray(dispatch.errors)||dispatch.errors.length||!Array.isArray(originalRecords)||originalRecords.length)throw Error('Original retry2 dispatch absence is not proven')
 if(session?.id!==carryoverSessionId||session.status!=='limit_reached'||session.owner||Object.keys(session.pendingTools??{}).length||requestEntries.length!==32||receipts.length!==32||reservations.length!==32||job?.status!=='succeeded'||job.payload?.conversation!==true||job.payload?.allowCompute!==false||job.payload?.sessionId!==session.id||job.result?.sessionId!==session.id||job.result?.completedEvaluations!==0)throw Error('Original retry2 session and job are not terminal authoring-only identities')
 const billing=job.result?.providerAccounting
 if(billing?.status!=='reported'||billing.unknownRequestIds?.length||!Array.isArray(billing.originalRequestIds)||billing.originalRequestIds.length!==32||!Array.isArray(billing.upstreamRequestIds)||billing.upstreamRequestIds.length!==32)throw Error('Original retry2 job billing is unknown')
 const upstream=new Set<string>(),requests:any[]=[],settled=journal.filter((event:any)=>event.type==='model_request_settled'),starts=journal.filter((event:any)=>event.type==='model_request_dispatched')
 if(settled.length!==32||starts.length!==32)throw Error('Original retry2 journal request counts differ')
 for(const [requestId,request] of requestEntries){
  const id=request.providerBilling?.upstreamRequestId,response=receipts.find((item:any)=>item.id===id),settlement=settled.filter((event:any)=>event.data?.requestId===requestId),start=starts.filter((event:any)=>event.data?.requestId===requestId)
  if(request.status!=='settled'||request.costKind!=='sdk_estimate'||request.delivery?.status!=='completed'||request.delivery?.partialToolCallCount!==0||request.model?.provider!==model.provider||request.model?.modelId!==model.modelId||request.modelBinding?.provider!==model.provider||request.modelBinding?.requestedModelId!==alias.requestedModelId||request.modelBinding?.canonicalModelId!==alias.canonicalModelId||request.modelBinding?.source!=='explicit_host_alias'||request.providerBilling?.status!=='reported'||request.providerBilling.source!=='openrouter_stream'||request.owningBinding?.jobId!==carryoverJobId||typeof id!=='string'||upstream.has(id)||settlement.length!==1||start.length!==1||settlement[0].sequence<=start[0].sequence||operationHash(settlement[0].data)!==operationHash({requestId,...request}))throw Error('Original retry2 request is not exactly settled in its canonical journal')
  if(!response||response.status!==200||response.error||response.identityInvalid||response.identityConflict||response.observationError||response.provider!==request.providerBilling.routedProvider||response.model!==request.providerBilling.observedModelId||!authorizedStreamModel(response.model,alias)||response.finishReason!==request.providerBilling.finishReason||typeof response.finishReason!=='string'||!response.finishReason||!Number.isFinite(response.usage?.cost)||response.usage.cost<0||Math.abs(response.usage.cost-request.providerBilling.reportedCostUsd)>1e-12)throw Error('Original retry2 provider receipt differs from canonical billing')
  const reservation=reservations.find((item:any)=>item.requestSequence===response.requestSequence)
  if(!reservation||!Number.isFinite(reservation.sdkMaximumUsd)||!Number.isFinite(reservation.providerMaximumUsd)||reservation.sdkMaximumUsd<=0||reservation.providerMaximumUsd<=0||request.estimatedCostUsd>reservation.sdkMaximumUsd||response.usage.cost>reservation.providerMaximumUsd||!Number.isFinite(request.estimatedCostUsd)||request.estimatedCostUsd<0||request.reportedCostUsd!==request.estimatedCostUsd||!billing.originalRequestIds.includes(session.id+':'+requestId)||!billing.upstreamRequestIds.includes(id))throw Error('Original retry2 cost reservation and job binding differ')
  upstream.add(id);requests.push({sessionId:session.id,requestId,requestHash:'sha256:'+operationHash(request),settledSequence:settlement[0].sequence,upstreamRequestId:id,sdkEstimatedUsd:request.estimatedCostUsd,providerReportedUsd:response.usage.cost,receiptHash:'sha256:'+operationHash(response),reservationHash:'sha256:'+operationHash(reservation)})
 }
 if(new Set(receipts.map((item:any)=>item.requestSequence)).size!==32||receipts.some((item:any)=>!Number.isInteger(item.requestSequence)||item.requestSequence<1||item.requestSequence>32))throw Error('Original retry2 provider request sequence is incomplete')
 if([session.usage?.costUsd,job.result?.modelCostUsd,failedGate.sdkEstimatedInferenceUsd,failedGate.providerReportedInferenceUsd,held.providerReportedCostUsd,billing.reportedCostUsd].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0))throw Error('Original retry2 canonical total is unknown')
 const sdkEstimatedUsd=requests.reduce((n,item)=>n+item.sdkEstimatedUsd,0),providerReportedUsd=requests.reduce((n,item)=>n+item.providerReportedUsd,0)
 if(Math.abs(sdkEstimatedUsd-expectedCarryover.sdkEstimatedUsd)>1e-12||Math.abs(providerReportedUsd-expectedCarryover.providerReportedUsd)>1e-12||Math.abs(session.usage?.costUsd-sdkEstimatedUsd)>1e-12||Math.abs(job.result.modelCostUsd-sdkEstimatedUsd)>1e-12||Math.abs(failedGate.sdkEstimatedInferenceUsd-sdkEstimatedUsd)>1e-12||Math.abs(failedGate.providerReportedInferenceUsd-providerReportedUsd)>1e-12||Math.abs(held.providerReportedCostUsd-providerReportedUsd)>1e-12||Math.abs(billing.reportedCostUsd-providerReportedUsd)>1e-12)throw Error('Original retry2 canonical totals differ')
 return {requests:requests.sort((a,b)=>a.requestId.localeCompare(b.requestId)),sdkEstimatedUsd,providerReportedUsd,requestCount:32,remainingSdkEstimatedUsd:scope.modelBudgetUsd-sdkEstimatedUsd,remainingProviderReportedUsd:scope.reportedInferenceCeilingUsd-providerReportedUsd,remainingRequests:scope.maximumModelRequests-32}
}
async function readCarryoverEvidence(){
 const oldOperator=path.join(carryoverRoot,'operator'),files=['held-state-audit.json','driver-exit.json','live-authoring-gate-failed.json','shutdown-evidence.json','observer-stop.json','original-dispatch-final-observation.json','original-dispatch-records.json','provider-recovery-audit.json','launch-preparation.json','launch-fence.json','authoring-gate-job.json','pricing-launch-pin.json',...Array.from({length:32},(_,index)=>['provider-response-'+(index+1)+'.json','cost-reservation-'+(index+1)+'.json']).flat()],pins=[]
 const values:Record<string,any>={}
 for(const name of files){const file=path.join(oldOperator,name),raw=await fs.readFile(file);values[name]=JSON.parse(raw.toString('utf8'));pins.push({path:file,contentHash:hash(raw)})}
 const originalDriver=path.join(main,'tooling/script/learned-generation-validation-retry2.ts')
 if(hash(await fs.readFile(originalDriver))!=='sha256:69a21e0160548f2a54589b371faefddeab80d7726df03f3fd9da6dac287c56c6')throw Error('Original retry2 driver changed')
 pins.push(await pin(originalDriver))
 const oldPricing=values['pricing-launch-pin.json']
 for(const bound of [oldPricing.proof,oldPricing.response,oldPricing.modelMetadata]){if(path.dirname(bound.path)!==oldOperator)throw Error('Original pricing proof path escaped its operator scope');const raw=await fs.readFile(bound.path);if(hash(raw)!==bound.contentHash)throw Error('Original pricing proof changed');pins.push(bound)}
 const alias=verifyCanonicalAliasProof(oldPricing.modelAliasProof,await fs.readFile(oldPricing.modelMetadata.path,'utf8'))
 const dbFile=path.join(carryoverRoot,'.autofold/pi',carryoverProjectId,'sessions.sqlite'),db=new Database(dbFile,{readonly:true}),reader=openSessionReader(dbFile)
 if(!reader){db.close();throw Error('Original retry2 session archive unavailable')}
 let session:any,journal:any[]
 try{const ids=(db.query('SELECT id FROM pi_sessions').all() as {id:string}[]).map(item=>item.id);if(ids.length!==1||ids[0]!==carryoverSessionId||db.query('SELECT session_id FROM pi_leases WHERE expires_at>?').all(Date.now()).length)throw Error('Original retry2 session scope or lease changed');session=await reader.get(carryoverSessionId);journal=await reader.events(carryoverSessionId)}finally{reader.close();db.close()}
 const evidence={held:values['held-state-audit.json'],exit:values['driver-exit.json'],failedGate:values['live-authoring-gate-failed.json'],shutdown:values['shutdown-evidence.json'],observer:values['observer-stop.json'],dispatch:values['original-dispatch-final-observation.json'],originalRecords:values['original-dispatch-records.json'],alias,session,journal,receipts:Array.from({length:32},(_,index)=>values['provider-response-'+(index+1)+'.json']),reservations:Array.from({length:32},(_,index)=>values['cost-reservation-'+(index+1)+'.json'])}
 const verified=assertCarryoverEvidence(evidence)
 return {format:'autofold.immutable-authoring-budget-carryover.v1',passed:true,originalWorkspace:carryoverRoot,originalProjectId:carryoverProjectId,originalSessionId:carryoverSessionId,originalJobId:carryoverJobId,officialModelAlias:alias,...verified,pins,sessionHash:'sha256:'+operationHash(session),journalHash:'sha256:'+operationHash(journal),authority:'Read-only original terminal authoring attempt; exact original ledger, settlement journal, provider receipts and separate SDK/provider totals are carried forward. No original session, model request, tool or execution is resumed or reconciled.'}
}
function assertAggregateInferenceAdmission(input:{carryover:{requestCount:number;sdkEstimatedUsd:number;providerReportedUsd:number};freshRequests:number;freshSdkEstimatedUsd:number;freshProviderReportedUsd:number|null;reservation:{sdkMaximumUsd:number;providerMaximumUsd:number}}){
 if(!Number.isInteger(input.freshRequests)||input.freshRequests<0||input.carryover.requestCount+input.freshRequests>=scope.maximumModelRequests)throw Error('Aggregate original and fresh model request ceiling reached')
 if((input.freshRequests>0&&input.freshProviderReportedUsd===null)||!Number.isFinite(input.freshSdkEstimatedUsd)||input.freshSdkEstimatedUsd<0||(input.freshProviderReportedUsd!==null&&(!Number.isFinite(input.freshProviderReportedUsd)||input.freshProviderReportedUsd<0))||!Number.isFinite(input.reservation.sdkMaximumUsd)||input.reservation.sdkMaximumUsd<=0||!Number.isFinite(input.reservation.providerMaximumUsd)||input.reservation.providerMaximumUsd<=0)throw Error('Aggregate inference accounting or reservation is unknown')
 if(input.carryover.sdkEstimatedUsd+input.freshSdkEstimatedUsd+input.reservation.sdkMaximumUsd>scope.modelBudgetUsd||input.carryover.providerReportedUsd+Number(input.freshProviderReportedUsd??0)+input.reservation.providerMaximumUsd>scope.reportedInferenceCeilingUsd)throw Error('Worst-case published-price request reservation exceeds aggregate original plus fresh inference ceiling; native output reservation is unchanged')
}
async function verifyCarryoverPin(prepared:any){
 const raw=await fs.readFile(prepared.carryover.path)
 if(prepared.carryover.path!==path.join(operator,'authoring-budget-carryover.json')||hash(raw)!==prepared.carryover.contentHash)throw Error('Frozen carryover proof changed')
 const proof=JSON.parse(raw.toString('utf8')),current=await readCarryoverEvidence()
 if(operationHash(proof)!==operationHash(current))throw Error('Original carryover evidence changed after freezing')
 return proof
}
async function checkCarryoverFixtures(){
 const verified=await readCarryoverEvidence(),oldOperator=path.join(carryoverRoot,'operator'),reader=openSessionReader(path.join(carryoverRoot,'.autofold/pi',carryoverProjectId,'sessions.sqlite'))!
 let session:any,journal:any[];try{session=await reader.get(carryoverSessionId);journal=await reader.events(carryoverSessionId)}finally{reader.close()}
 const read=(name:string)=>Bun.file(path.join(oldOperator,name)).json(),base={held:await read('held-state-audit.json'),exit:await read('driver-exit.json'),failedGate:await read('live-authoring-gate-failed.json'),shutdown:await read('shutdown-evidence.json'),observer:await read('observer-stop.json'),dispatch:await read('original-dispatch-final-observation.json'),originalRecords:await read('original-dispatch-records.json'),alias:verified.officialModelAlias,session,journal,receipts:await Promise.all(Array.from({length:32},(_,index)=>read('provider-response-'+(index+1)+'.json'))),reservations:await Promise.all(Array.from({length:32},(_,index)=>read('cost-reservation-'+(index+1)+'.json')))},cases:any[]=[{name:'exact-original-terminal-carryover',value:base,expected:true}]
 const reject=(name:string,mutate:(value:any)=>void)=>{const value=structuredClone(base);mutate(value);cases.push({name,value,expected:false})}
 reject('unknown-provider-bill',value=>(Object.values(value.session.modelRequests) as any[])[0]!.providerBilling.status='unknown')
 reject('changed-original-cost',value=>value.receipts[0].usage.cost+=0.01)
 reject('missing-original-receipt',value=>value.receipts.pop())
 reject('duplicate-original-receipt',value=>value.receipts[31]=value.receipts[0])
 reject('unsettled-original-request',value=>(Object.values(value.session.modelRequests) as any[])[0]!.status='dispatched')
 reject('missing-canonical-settlement',value=>value.journal=value.journal.filter((item:any)=>item.type!=='model_request_settled'))
 reject('wrong-owning-job',value=>(Object.values(value.session.modelRequests) as any[])[0]!.owningBinding.jobId='job_other')
 reject('original-gpu-effect',value=>value.failedGate.effects.runIds.push('run_other'))
 reject('original-dispatch-unknown',value=>value.dispatch.status='unresolved')
 reject('observer-not-stopped',value=>value.observer.observerGone=false)
 reject('shutdown-not-verified',value=>value.shutdown.passed=false)
 reject('original-job-cost-drift',value=>value.held.state.jobs[carryoverJobId].result.modelCostUsd+=0.01)
 reject('unknown-canonical-total',value=>delete value.held.state.jobs[carryoverJobId].result.modelCostUsd)
 reject('wrong-canonical-model',value=>(Object.values(value.session.modelRequests) as any[])[0]!.modelBinding.canonicalModelId='invented/model')
 reject('partial-delivery',value=>(Object.values(value.session.modelRequests) as any[])[0]!.delivery.partialToolCallCount=1)
 const spendCases:any[]=[{name:'first-fresh-request-within-remaining-grant',freshRequests:0,freshSdkEstimatedUsd:0,freshProviderReportedUsd:null,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:true},{name:'last-permitted-fresh-request',freshRequests:95,freshSdkEstimatedUsd:0.5,freshProviderReportedUsd:0.5,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:true},{name:'request-129-denied',freshRequests:96,freshSdkEstimatedUsd:0,freshProviderReportedUsd:0,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:false},{name:'sdk-carryover-cannot-reset',freshRequests:1,freshSdkEstimatedUsd:0.91,freshProviderReportedUsd:0,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:false},{name:'reported-carryover-cannot-reset',freshRequests:1,freshSdkEstimatedUsd:0,freshProviderReportedUsd:1.25,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:false},{name:'fresh-unreported-bill-denied',freshRequests:1,freshSdkEstimatedUsd:0,freshProviderReportedUsd:null,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:false},{name:'unknown-sdk-denied',freshRequests:1,freshSdkEstimatedUsd:NaN,freshProviderReportedUsd:0,reservation:{sdkMaximumUsd:1,providerMaximumUsd:1.75},expected:false}].map(item=>{let accepted=true;try{assertAggregateInferenceAdmission({...item,carryover:verified})}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}})
 const results=cases.map(item=>{let accepted=true;try{assertCarryoverEvidence(item.value)}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}}),passed=[...results,...spendCases].every(item=>item.expected===item.accepted)
 console.log(JSON.stringify({mode:'immutable-original-authoring-budget-carryover-fixtures',passed,results,spendCases,requestCount:verified.requestCount,sdkEstimatedUsd:verified.sdkEstimatedUsd,providerReportedUsd:verified.providerReportedUsd,remainingSdkEstimatedUsd:verified.remainingSdkEstimatedUsd,remainingProviderReportedUsd:verified.remainingProviderReportedUsd,remainingRequests:verified.remainingRequests,remoteCalls:0,providerCalls:0,originalWrites:0}));if(!passed)throw Error('Carryover fixture regression')
}

async function prepareBootstrap(targetArtifactHash:string){
 const provenancePath=path.join(bootstrapSource,'provenance.json'),provenance=await Bun.file(provenancePath).json()
 if(provenance.format!=='autofold.verified-generation-bootstrap.v1'||provenance.chain!=='B'||provenance.residueCount!==12||provenance.completeBackboneAtoms!==true||!/^sha256:[a-f0-9]{64}$/.test(provenance.backboneHash))throw Error('Verified ProteinMPNN backbone provenance is required')
 const nativeRaw=await fs.readFile(provenance.sourceNativeReceipt),native=JSON.parse(nativeRaw.toString('utf8'))
 if(hash(nativeRaw)!==provenance.sourceNativeReceiptHash||native.runId!==provenance.sourceRunId)throw Error('Original bootstrap native receipt changed')
 let sourcePdb:any=native
 for(const key of provenance.sourceJsonPointer.split('/').slice(1))sourcePdb=sourcePdb?.[key.replaceAll('~1','/').replaceAll('~0','~')]
 if(typeof sourcePdb!=='string'||hash(sourcePdb)!==provenance.sourcePdbContentHash)throw Error('Original modeled complex content differs')
 const exported=sourcePdb.split('\n').filter(line=>line.startsWith('SEQRES')?line[11]==='B':['ATOM  ','HETATM','TER   '].some(prefix=>line.startsWith(prefix))&&line[21]==='B').join('\n')+'\nEND\n'
 const pdbRaw=await fs.readFile(provenance.backboneFile)
 if(hash(exported)!==provenance.backboneHash||hash(pdbRaw)!==provenance.backboneHash||pdbRaw.toString('utf8')!==exported||pdbRaw.length!==provenance.backboneBytes)throw Error('Bootstrap must preserve exactly the exported original chain B bytes')
 const manifestPath=path.resolve(path.dirname(provenance.sourceNativeReceipt),'../manifest.json'),bundlePath=path.resolve(path.dirname(provenance.sourceNativeReceipt),'../../bundle.json')
 const manifest=await Bun.file(manifestPath).json(),bundle=await Bun.file(bundlePath).json()
 if(hash(await fs.readFile(manifestPath))!==provenance.sourceManifestHash||manifest.runId!==provenance.sourceRunId||bundle.contractHash!==provenance.sourceContractHash||bundle.targetArtifactHash!==targetArtifactHash)throw Error('Bootstrap original manifest/contract/target identity differs')
 const reference=path.join(workspace,'references/bootstrap/proteinmpnn-backbone.pdb')
 await fs.mkdir(path.dirname(reference),{recursive:true,mode:0o700});await fs.writeFile(reference,pdbRaw,{flag:'wx',mode:0o400})
 const assetsPath=path.join(path.dirname(bootstrapSource),'mpnn-weights-readonly.json'),assets=await Bun.file(assetsPath).json()
 if(assets.readOnly!==true||assets.modelExecutions!==0||assets.downloads!==0||assets.metadata?.packages?.colabdesign!=='1.1.3'||assets.metadata?.packages?.jax!=='0.5.3'||assets.metadata?.packages?.jaxlib!=='0.5.3'||!Array.isArray(assets.files)||!assets.files.some((file:any)=>file.path.endsWith('/mpnn/weights/v_48_020.pkl')&&file.contentHash==='sha256:993194d9cbe9334f6c2c81bddeb1404ea831711bca8e38b591b4116060484ac3'))throw Error('Existing frozen ProteinMPNN environment/weight evidence is required')
 const recipe=path.join(workspace,'references/bootstrap/predictor-recipe.py')
 if(hash(predictorRecipeSource)!==predictorRecipeHash)throw Error('Procedural recipe bytes changed')
 const recipeContent='from proto_language.constraint import structure_iptm_constraint\nfrom proto_language.constraint.protein_structure.structure_constraint_config import StructureBasedConstraintConfig\nfrom proto_tools import Boltz2Config\n\n'+predictorRecipeSource
 await fs.writeFile(recipe,recipeContent,{flag:'wx',mode:0o400})
 const pins=await Promise.all([recipe,provenancePath,provenance.sourceNativeReceipt,manifestPath,bundlePath,provenance.backboneFile,reference,assetsPath].map(pin))
 const result={provenance,reference:await pin(reference),recipe:await pin(recipe),recipeBodyHash:predictorRecipeHash,recipeDescriptorHash:hash(JSON.stringify(predictorRecipeSource)),assets:await pin(assetsPath),pins,authority:'Original hash-verified computational backbone, exact exported chain B; no coordinate edits or operator-authored peptide program.'}
 await save('bootstrap.json',result,true);return result
}
function validateGateManifestSchema(value:any){
 const required=['change1','change2','change3','change4','change5','full']
 if(value?.status!=='passed'||!/^sha256:[a-f0-9]{64}$/.test(value.sourceHash??'')||!/^sha256:[a-f0-9]{64}$/.test(value.workerHash??'')||!value.gates||operationHash(Object.keys(value.gates).sort())!==operationHash([...required].sort()))throw Error('Fresh regression manifest must bind exactly five implementation changes and the full gate')
 for(const name of required){const entry=value.gates[name];if(!entry||typeof entry.path!=='string'||!entry.path||!Array.isArray(entry.logs)||entry.logs.length===0||entry.logs.some((item:any)=>typeof item!=='string'||!item))throw Error('Fresh gate must identify its original nonempty logs: '+name)}
 return required
}
function checkGateFixtures(){
 const valid={status:'passed',sourceHash:'sha256:'+'1'.repeat(64),workerHash:'sha256:'+'2'.repeat(64),gates:Object.fromEntries(['change1','change2','change3','change4','change5','full'].map(name=>[name,{path:'synthetic/'+name+'.json',logs:['synthetic/'+name+'.log']}]))},cases:any[]=[{name:'five-changes-and-full',manifest:valid,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(valid);change(value);cases.push({name,manifest:value,expected:false})}
 mutate('missing-third-change',value=>delete value.gates.change3);mutate('missing-fourth-change',value=>delete value.gates.change4);mutate('missing-fifth-change',value=>delete value.gates.change5);mutate('unexpected-sixth-change',value=>value.gates.change6=value.gates.change3);mutate('missing-full-gate',value=>delete value.gates.full);mutate('empty-original-logs',value=>value.gates.change2.logs=[]);mutate('invalid-source-identity',value=>value.sourceHash='unknown');mutate('not-passed',value=>value.status='failed')
 const results=cases.map(item=>{let accepted=true;try{validateGateManifestSchema(item.manifest)}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}}),passed=results.every(item=>item.expected===item.accepted)
 console.log(JSON.stringify({mode:'fresh-five-change-gate-manifest-fixtures',passed,results,providerCalls:0,remoteCalls:0}));if(!passed)throw Error('Fresh gate schema regression')
}
async function prepare(gateManifestPath:string){
 if(await fs.access(workspace).then(()=>true,()=>false))throw Error('Fresh learned-search workspace already exists; never replace evidence')
 const carryover=await readCarryoverEvidence()
 const gateManifest=path.resolve(main,gateManifestPath),gateProof=await Bun.file(gateManifest).json()
 if(gateProof.status!=='passed')throw Error('Root-owned all-change regression manifest must be passed')
 const required=validateGateManifestSchema(gateProof),offlineGates=[],offlineLogs=[]
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
 await fs.mkdir(operator,{recursive:true,mode:0o700});await save('authoring-budget-carryover.json',carryover,true)
 const previous=path.join(main,'.autofold/cohesive-engine-refactor-20261012/final-gpu-validation/operator')
 const contract=ResearchDomain.ExperimentContract.parse({...await Bun.file(path.join(previous,'contract.json')).json(),
   objective,
   budget:{maximumCandidates:1,gpuHours:600/3600,wallTimeMinutes:15}})
 const profile=await Bun.file(path.join(previous,'profile.json')).json()
 profile.remote.root='/home/vincent/.autofold-learned-generation-validation-20261013-retry3'
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
 const bootstrap=await prepareBootstrap(contract.targetArtifactHash)
 const grant={humanAuthorization:'User requested repairing observed authoring/search issues, a fresh live authoring-only validation gate, and a bounded four-trial rerun with genuine learned generation and memory-guided followups. Operator rerun bounds are $3 reported inference and a separate $2 SDK-estimate ceiling, below the earlier user $10 inference ceiling; this does not claim an explicit prior approval of $3 or reuse a previous run grant. All authoring attempts, including the immutable failed retry2 attempt, and the four-trial campaign share these aggregate inference ceilings and 128-request maximum. Retry3 starts a fresh one-hour deadline without resetting inference budgets. Existing approved recipients remain the destinations.',...scope,carryoverRequestCount:carryover.requestCount,carryoverSdkEstimatedUsd:carryover.sdkEstimatedUsd,carryoverProviderReportedUsd:carryover.providerReportedUsd,remainingModelRequests:carryover.remainingRequests,remainingModelBudgetUsd:carryover.remainingSdkEstimatedUsd,remainingReportedInferenceCeilingUsd:carryover.remainingProviderReportedUsd,model,routing,sourceHash:identity.sourceHash}
 await save('human-grant.json',grant,true)
 await save('launch-preparation.json',{preparedAt:new Date().toISOString(),...identity,projectId,workspace,carryover:await pin(path.join(operator,'authoring-budget-carryover.json')),profile:await pin(path.join(operator,'profile.json')),contract:await pin(path.join(operator,'contract.json')),driver:await pin(import.meta.path),grant:await pin(path.join(operator,'human-grant.json')),gateManifest:await pin(gateManifest),offlineGates,offlineLogs,historicalBefore:await pin(path.join(main,'.autofold/cohesive-engine-refactor-20261012/operator/historical-before.json')),bootstrap:await pin(path.join(operator,'bootstrap.json')),bootstrapPins:bootstrap.pins,targetFiles,contractHash:ResearchDomain.hashContract(contract),scope:'Fresh model prompts/tool context to OpenRouter and newly authored programs/frozen worker/PD-L1 files to existing workstation_4090. Only new project evidence is writable. Prior failed model streams, jobs and validation roots are never resumed; all previous evidence remains immutable.'},true)
 console.log(JSON.stringify({mode:'prepared_local_only',workspace,projectId,sourceHash:identity.sourceHash,workerHash:identity.workerHash,remoteCalls:0,providerCalls:0}))
}
function sameOriginalBindings(final:any,original:any){
 if(!Array.isArray(final)||!Array.isArray(original)||final.length!==original.length||final.some(item=>item.bindingStatus!=='verified')||original.some(item=>item.bindingStatus!==undefined&&item.bindingStatus!=='verified'))return false
 const projection=(items:any[])=>items.map(item=>{const {bindingStatus,...identity}=item;return identity}).sort((a,b)=>String(a.runId).localeCompare(String(b.runId)))
 return new Set(final.map(item=>item.runId)).size===final.length&&operationHash(projection(final))===operationHash(projection(original))
}
function checkDispatchFixtures(){
 const original=[{runId:'run_original',requestId:'original_request',bundleHash:'sha256:bundle',workerHash:'sha256:worker',planHash:'sha256:plan',hostRunStatus:'succeeded',hostRunStartedAt:'2026-10-13T00:00:00Z',hostRunCompletedAt:'2026-10-13T00:01:00Z',extraOriginalField:'preserved'}],final=original.map(item=>({...item,bindingStatus:'verified'}))
 const cases=[{name:'verified-bookkeeping-only',final,original,expected:true},{name:'preserved-catch-binding-bookkeeping',final,original:structuredClone(final),expected:true},{name:'empty-verified-no-work',final:[],original:[],expected:true}]
 for(const [field,value] of [['hostRunStatus','failed'],['hostRunStartedAt','2026-10-13T00:00:01Z'],['hostRunCompletedAt','2026-10-13T00:01:01Z'],['extraOriginalField','changed'],['bindingStatus','unresolved']]){const changed:any[]=structuredClone(final);changed[0][field!]=value;cases.push({name:'reject-change-'+field,final:changed,original,expected:false})}
 const results=cases.map(item=>({name:item.name,expected:item.expected,observed:sameOriginalBindings(item.final,item.original)})),passed=results.every(item=>item.expected===item.observed)
 console.log(JSON.stringify({mode:'full-original-dispatch-identity-fixtures',passed,results,providerCalls:0,remoteCalls:0}));if(!passed)throw Error('Original dispatch identity projection regression')
}
async function verifyShutdown(){
 await pins()
 if(!await Bun.file(path.join(operator,'driver-exit.json')).exists())throw Error('Original local driver has not exited')
 const remote=(await Bun.file(path.join(operator,'profile.json')).json()).remote
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-generation-validation-20261013-retry3')throw Error('Original worker destination differs')
 const dispatchObservation=await Bun.file(path.join(operator,'original-dispatch-final-observation.json')).json()
 if(dispatchObservation.status!=='complete'||!Array.isArray(dispatchObservation.records))throw Error('Original dispatch observation is unresolved; never assume zero GPU work')
 const attempts=dispatchObservation.records,originalRecords=await Bun.file(path.join(operator,'original-dispatch-records.json')).json()
 if(!sameOriginalBindings(attempts,originalRecords))throw Error('Final canonical launch set differs from the preserved complete original bindings')
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
 const bootstrap=await Bun.file(path.join(operator,'bootstrap.json')).json(),assets=await Bun.file(bootstrap.assets.path).json()
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-generation-validation-20261013-retry3'||remote.python!=='/home/vincent/autofold-env/bin/python')throw Error('Authorized read-only host destination differs')
 const code=`import json,pathlib,subprocess,datetime,os,hashlib
config=json.loads(${JSON.stringify(JSON.stringify({remote,proto:profile.proto,assets}))})
remote=config['remote'];root=pathlib.Path(remote['root'])
paths=[remote['protoRoot'],str(pathlib.Path(remote['protoRoot'])/'proto-tools'),remote['python'],remote['protoHome'],remote['inspectionBubblewrap']]
required={p:pathlib.Path(p).exists() for p in paths}
assets=config['assets'];verified_assets=[]
for expected in assets['files']:
 p=pathlib.Path(expected['path']);exists=p.is_file();actual={'path':expected['path'],'bytes':p.stat().st_size if exists else None,'contentHash':'sha256:'+hashlib.sha256(p.read_bytes()).hexdigest() if exists else None}
 actual['matched']=actual['bytes']==expected['bytes'] and actual['contentHash']==expected['contentHash'];verified_assets.append(actual)
import importlib.metadata
distributions={d.metadata.get('Name','').lower():d.version for d in importlib.metadata.distributions(path=[assets['metadata']['purelib']])}
packages={name:distributions.get(name) for name in assets['metadata']['packages']}
asset_environment={'interpreter':assets['interpreter'],'interpreterExists':pathlib.Path(assets['interpreter']).is_file(),'packages':packages,'files':verified_assets}
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
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'freshRootAbsent':not root.exists(),'requiredPaths':required,'workerProcesses':workers,'computeReturnCode':gpu.returncode,'gpuComputeProcesses':gpu.stdout.strip(),'gpuQueryError':gpu.stderr[:500] if gpu.returncode else None,'commits':commits,'dirty':dirty,'inspectionBubblewrapSha256':bwrap_hash,'proteinmpnnAssets':asset_environment,'readOnly':True,'modelImports':0,'newScientificEffects':0,'providerCalls':0}))
`
 const child=Bun.spawn(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','--',remote.host,remote.python+' -'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 child.stdin.write(code);child.stdin.end();const timer=setTimeout(()=>child.kill(),40000)
 let response:string
 try{const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exit)throw Error('Read-only host readiness failed: '+stderr.slice(0,1000));response=stdout}finally{clearTimeout(timer)}
 const observation=JSON.parse(response),expected={language:profile.proto.languageCommit,tools:profile.proto.toolsCommit}
 const commitsMatched=Object.entries(expected).every(([name,commit])=>observation.commits[name]?.returnCode===0&&observation.commits[name]?.output===commit)
 const nativeTreesClean=Object.values(observation.dirty).every((item:any)=>item.returnCode===0&&item.output==='')
 const bubblewrapMatched=observation.inspectionBubblewrapSha256===remote.inspectionBubblewrapSha256
 const proteinmpnnAssetsMatched=observation.proteinmpnnAssets?.interpreterExists===true&&observation.proteinmpnnAssets.files.length===assets.files.length&&observation.proteinmpnnAssets.files.every((item:any)=>item.matched===true)&&operationHash(observation.proteinmpnnAssets.packages)===operationHash(assets.metadata.packages)
 const passed=proteinmpnnAssetsMatched&&observation.freshRootAbsent&&Object.values(observation.requiredPaths).every(Boolean)&&observation.workerProcesses.length===0&&observation.computeReturnCode===0&&!observation.gpuComputeProcesses&&commitsMatched&&nativeTreesClean&&bubblewrapMatched
 const result={...observation,commitsMatched,nativeTreesClean,bubblewrapMatched,proteinmpnnAssetsMatched,assetsProofHash:bootstrap.assets.contentHash,passed}
 await save('host-readiness-'+Date.now()+'-'+crypto.randomUUID()+'.json',result,true);await save('host-readiness.json',result)
 console.log(JSON.stringify({mode:'read_only_fresh_host_readiness',passed,commitsMatched,nativeTreesClean,bubblewrapMatched,freshRootAbsent:observation.freshRootAbsent,workerProcessCount:observation.workerProcesses.length,providerCalls:0,newScientificEffects:0}))
 if(!passed)process.exitCode=1
 return result
}
// Pinned Proto utils/io.py exposes result rows and pre-selection proposal rows
// separately. Never count recursively repeated metrics as distinct evaluations.
function auditGeneratedHistory(stage:any,output:any,label:string,targetSequence:string,selected:any){
 const errors:string[]=[],close=(a:any,b:any)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8
 const history=Array.isArray(stage?.history)?stage.history:[],frame=history[0],proposal=frame?.proposal_results?.[0],result=frame?.results?.[0]
 if(history.length!==1||frame?.time_step!==1||frame.best_result_idx!==0||frame.results?.length!==1||result?.result_idx!==0||frame.proposal_results?.length!==1||proposal?.proposal_idx!==0||proposal.accepted!==true||proposal.rejected_by!==null)errors.push('Exactly one generated accepted scored proposal and retained row are required')
 const optimizer=frame?.optimizer
 if(optimizer?.type!=='rejection-sampling'||optimizer.proposal_source!=='generated'||optimizer.iteration_kind!=='proposal'||optimizer.proposal_number!==1||optimizer.num_samples!==1||optimizer.proposal_batch_size!==1||optimizer.result_count!==1||optimizer.filter_status!=='passed'||optimizer.failed_filter!==null||optimizer.score_source!=='energy_score')errors.push('Progress does not identify one genuine generated proposal')
 const inspect=(row:any,kind:string)=>{
  const constructs=Array.isArray(row?.constructs)?row.constructs:[],matches=constructs.filter((c:any)=>c.label===output?.construct),segments=matches.length===1&&Array.isArray(matches[0].segments)?matches[0].segments:[],binders=segments.filter((segment:any)=>segment.label===output?.segment),binder=binders.length===1?binders[0]:undefined
  const constraint=binder?.constraints?.[label],iptm=constraint?.data?.iptm,metadata=binder?.generators?.proteinmpnn
  if(!binder||typeof binder.sequence!=='string'||!/^[ACDEFGHIKLMNPQRSTVWY]{12}$/.test(binder.sequence))errors.push(kind+': selected binder is absent or invalid')
  if(typeof iptm!=='number'||!Number.isFinite(iptm)||iptm<0||iptm>1||constraint?.data?.structure_tool!=='boltz2'||Object.hasOwn(constraint?.data??{},'structure_iptm_error')||Object.keys(binder?.constraints??{}).length!==1||constraint?.weight!==1||!close(constraint?.score,1-iptm)||!close(constraint?.weighted_score,1-iptm)||!close(row?.energy_score,1-iptm))errors.push(kind+': independent ipTM and scalar/weighted energy are inconsistent')
  if(!metadata||typeof metadata.perplexity!=='number'||!Number.isFinite(metadata.perplexity)||metadata.perplexity<=0||typeof metadata.sequence_recovery!=='number'||!Number.isFinite(metadata.sequence_recovery)||metadata.sequence_recovery<0||metadata.sequence_recovery>1||metadata.full_sequence!==binder?.sequence)errors.push(kind+': finite ProteinMPNN generation provenance is absent')
  const targets=constructs.flatMap((c:any)=>c.segments??[]).filter((segment:any)=>segment!==binder&&Object.hasOwn(segment.constraints??{},label))
  if(targets.length>1||targets.some((target:any)=>target.sequence!==targetSequence||!close(target.constraints[label].data?.iptm,iptm)))errors.push(kind+': retained fixed target sequence/metadata differs')
  return {sequence:binder?.sequence,iptm,energy:row?.energy_score,generators:binder?.generators,constraints:binder?.constraints,targetHistoryRecords:targets.length}
 }
 const scored=inspect(proposal,'proposal'),retained=inspect(result,'retained')
 if(operationHash(scored)!==operationHash(retained)||selected?.sequence!==retained.sequence||!close(stage?.energyScores?.[0],retained.energy)||stage?.energyScores?.length!==1||operationHash(selected?.metadata?.generators??null)!==operationHash(retained.generators??null)||operationHash(selected?.metadata?.constraints??null)!==operationHash(retained.constraints??null))errors.push('Hash-bound selected candidate metadata/energy differs from the scored learned proposal')
 return {passed:errors.length===0,errors,scored,retained,authority:'Pinned ProteinMPNN source, scoped request and selected metadata corroborate learned sequence generation; no physical inference count or internal hill-climb claim. External fixed targets are bound by admission, and observed target history rows are checked when present.'}
}
function auditLearnedReceipt(spec:{native:any;run:{id:string};trial:{id:string;programHash:string};targetSequence:string;ordinal:number;bootstrap:any;generationSeed:number;generationArtifacts:any[];generationIndex:any;nativeArtifactHash:string;maximumWallSeconds?:number}){
 const {native,run,trial,targetSequence,ordinal,bootstrap,generationSeed,generationArtifacts,generationIndex,nativeArtifactHash}=spec
 const budget=native.admission.budget
  const stages=native.admission.projection.flatMap((lane:any)=>lane.stages),observedStages=native.lanes.flatMap((lane:any)=>lane.stages)
  const segments=native.admission.projection.flatMap((lane:any)=>[...lane.externalInputs,...lane.constructs.flatMap((c:any)=>c.segments)])
  const fixedTarget=segments.find((segment:any)=>segment.initial?.sequence===targetSequence)
  const structuralConstraints=stages.flatMap((stage:any)=>stage.constraints).filter((c:any)=>c.function?.name==='fixed_predictor_iptm'&&c.function?.sourceHash===hash(JSON.stringify(predictorRecipeSource))&&operationHash(c.config)===operationHash({predictor_seed:fixedPredictorSeed}))
  const selectedOutput=budget.outputs?.[0],selectedConstruct=native.admission.projection[selectedOutput?.lane??0]?.constructs?.find((construct:any)=>construct.label===selectedOutput?.construct)
  const selectedBinder=selectedConstruct?.segments?.find((segment:any)=>segment.label===selectedOutput?.segment)
  const objectiveHistory=observedStages.length===1?auditGeneratedHistory(observedStages[0],selectedOutput,structuralConstraints[0]?.label,targetSequence,native.selected[0]?.sequence):{passed:false,errors:['Expected exactly one observed optimizer stage']}
  const generator=stages[0]?.generators?.[0],generatorConfig=generator?.config,structureInput=generatorConfig?.structure_inputs?.[0],inlineStructure=structureInput?.structure?.structure
  const temperature=generatorConfig?.temperature
  const temperatureProtocolBound=ordinal>=1&&ordinal<=4&&(ordinal<=2?temperature===0.1:[0.05,0.2].includes(temperature))
  const bootstrapBound=typeof inlineStructure==='string'&&hash(inlineStructure)===bootstrap.provenance.backboneHash&&structureInput.structure.structure_format==='pdb'&&operationHash(structureInput.chains_to_redesign)===operationHash({chains:['B']})&&structureInput.fixed_positions===null
  const learnedCalls=native.calls.filter((call:any)=>call.tool==='proteinmpnn-sample'),objectiveCalls=native.calls.filter((call:any)=>call.tool==='boltz2-prediction')
  const uncachedLearnedRequestObserved=learnedCalls.length===1&&['cache_miss','cache_partial','cache_disabled'].includes(learnedCalls[0].cacheOrigin)
  const roles=native.seedRoles
  const actualSeeds=native.calls.map((call:any)=>({requestId:call.requestId,tool:call.tool,role:call.tool==='proteinmpnn-sample'?'generator_tool':'predictor_tool',seed:call.configSeed,source:'verified_native_tool_call.config'}))
  const seedRolesBound=roles?.format==='autofold.generation-seed-roles.v1'&&roles.hostGenerationSeed?.value===generationSeed&&roles.hostGenerationSeed?.source==='trial_bundle.generationSeed'&&operationHash(roles)===operationHash(generationIndex.seedRoles)&&operationHash(roles.evaluatorSeeds)===operationHash({values:[20260809],source:'trial_bundle.seeds'})&&
   operationHash(roles.effectiveProgramSeeds)===operationHash([{lane:0,value:generationSeed,source:'verified_native_projection.programSeed'}])&&operationHash(roles.observedToolConfigSeeds)===operationHash(actualSeeds)&&roles.declaredPredictorSeeds.length===1&&roles.declaredPredictorSeeds[0].value===fixedPredictorSeed&&roles.declaredPredictorSeeds[0].constraint===structuralConstraints[0]?.instanceId&&roles.declaredPredictorSeeds[0].field==='predictor_seed'&&roles.declaredPredictorSeeds[0].source==='verified_native_projection.constraint.config'&&roles.declaredPredictorSeeds[0].stage===stages[0]?.instanceId&&roles.declaredPredictorSeeds[0].lane===0&&roles.declaredPredictorSeeds[0].function==='fixed_predictor_iptm'&&
   learnedCalls.length===1&&Number.isSafeInteger(learnedCalls[0].configSeed)&&learnedCalls[0].configSeed>=0&&objectiveCalls.length===1&&objectiveCalls[0].configSeed===fixedPredictorSeed&&objectiveCalls[0].configHash===fixedPredictorConfigHash
  const selectedGeneratorMetadata=native.selected[0]?.sequence?.metadata?.generators?.proteinmpnn
  const generationMetadataBound=generationArtifacts.length===1&&operationHash(generationArtifacts[0].metadata?.proteinmpnn??null)===operationHash(selectedGeneratorMetadata??null)
  const stageConfig=stages[0]?.config
  const passed=native.observation==='scoped_native_lifecycle_v1'&&native.runId===run.id&&native.programHash===trial.programHash&&
   budget.maximumCandidates===1&&budget.maximumProposals===1&&budget.maximumSamplingCalls===1&&budget.maximumToolCalls===2&&budget.maximumWallSeconds===(spec.maximumWallSeconds??300)&&operationHash([...budget.allowedTools].sort())===operationHash(['boltz2-prediction','proteinmpnn-sample'])&&
   native.admission.projection.length===1&&native.lanes.length===1&&stages.length===1&&stages[0].optimizer==='RejectionSamplingOptimizer'&&stageConfig.num_samples===1&&stageConfig.num_results===1&&stageConfig.proposal_source==='generated'&&stageConfig.proposal_batch_size===1&&stageConfig.track_proposals===true&&stageConfig.energy_threshold===null&&
   stages[0].constraints.length===1&&structuralConstraints.length===1&&structuralConstraints[0].weight===1&&structuralConstraints[0].threshold===null&&structuralConstraints[0].backward===null&&
   !!fixedTarget&&!!selectedBinder&&selectedBinder.length===12&&selectedBinder.id!==fixedTarget.id&&budget.outputs.length===1&&JSON.stringify(structuralConstraints[0].inputs)===JSON.stringify([fixedTarget.id,selectedBinder.id])&&
   stages[0].generators.length===1&&generator.key==='proteinmpnn'&&generatorConfig.model_choice==='proteinmpnn'&&generatorConfig.device==='cuda'&&generatorConfig.batch_size===1&&generatorConfig.output_chain_id==='B'&&generatorConfig.structure_inputs.length===1&&generatorConfig.excluded_amino_acids===null&&bootstrapBound&&temperatureProtocolBound&&
   JSON.stringify(generator.segments)===JSON.stringify([selectedBinder.id])&&native.counts.proposals===1&&native.counts.samplingCalls===1&&native.counts.toolCalls===2&&native.samplings.length===1&&native.samplings.every((sample:any)=>sample.status==='completed')&&
   learnedCalls.length===1&&objectiveCalls.length===1&&native.calls.length===2&&uncachedLearnedRequestObserved&&native.calls.every((call:any)=>call.status==='completed'&&call.outputSuccess===true&&call.cacheOrigin!=='unobserved'&&typeof call.outputHash==='string')&&objectiveHistory.passed&&seedRolesBound&&generationMetadataBound&&
   native.selected.length===1&&native.selected[0].origin.segment!==null&&operationHash(native.selected[0].origin)===operationHash(selectedOutput)&&native.selected[0].sequence.sequence.length===12&&native.selected[0].sequence.sequence!==targetSequence&&native.wallSeconds<=300
  return {runId:run.id,trialId:trial.id,ordinal,temperature,temperatureProtocolBound,bootstrapBound,seedRolesBound,generationMetadataBound,passed,nativeArtifactHash,counts:native.counts,
   fullTargetChainBound:!!fixedTarget,selectedBinderId:selectedBinder?.id,structuralConstraintCount:structuralConstraints.length,objectiveHistory,stageEnergyScores:observedStages.map((s:any)=>s.energyScores),
   calls:native.calls,uncachedLearnedRequestObserved,cacheOrigins:native.calls.map((call:any)=>call.cacheOrigin),selected:native.selected,seedRoles:roles,wallSeconds:native.wallSeconds,
   interpretation:'One actual ProteinMPNN sample and one matched-seed structural objective are scoped inside native search and bound to selected generation metadata. The frozen panel is separate. Request counts include cache lookups; uncached generation is required. Physical GPU corroboration is a separate root-owned witness. This one-proposal protocol does not test internal hill climbing or establish biological binding.'}
}
async function checkHistoryFixtures(){
 if(hash(predictorRecipeSource)!==predictorRecipeHash)throw Error('Frozen procedural predictor recipe fingerprint differs')
 const root=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/gates/change3'),fixtures:any[]=[],sources=[]
 for(const seed of [3051971263,1478874995]){
  const file=path.join(root,'fixture-target-first-seed-'+seed,'native-search/receipt.json'),raw=await fs.readFile(file),native=JSON.parse(raw.toString('utf8')),output=native.admission.budget.outputs[0],stage=native.lanes[0].stages[0],label=native.admission.projection[0].stages[0].constraints[0].label,target=native.admission.projection[0].externalInputs[0].initial.sequence,selected=native.selected[0].sequence
  sources.push({file,contentHash:hash(raw),scope:'Actual Proto APIs and capture schema with explicitly synthetic typed registered runners; no learned inference or scientific evidence'})
  const spec={stage,output,label,target,selected};fixtures.push({name:'actual-RSM-shape-'+seed,spec,expected:true})
  if(fixtures.length===1){
   const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(spec);change(value);fixtures.push({name,spec:value,expected:false})}
   const binder=(value:any)=>value.stage.history[0].proposal_results[0].constructs.find((c:any)=>c.label===value.output.construct).segments.find((segment:any)=>segment.label===value.output.segment)
   mutate('missing-learned-generator-metadata',value=>delete binder(value).generators.proteinmpnn)
   mutate('nonfinite-perplexity',value=>binder(value).generators.proteinmpnn.perplexity='nan')
   mutate('missing-proposal-iptm',value=>delete binder(value).constraints[value.label].data.iptm)
   mutate('proposal-energy-inconsistent',value=>value.stage.history[0].proposal_results[0].energy_score=1)
   mutate('selected-metadata-not-learned-proposal',value=>value.selected.metadata.generators.proteinmpnn.full_sequence='AAAAAAAAAAAA')
   mutate('ambiguous-proposal-pool',value=>value.stage.history[0].proposal_results.push(structuredClone(value.stage.history[0].proposal_results[0])))
  }
 }
 const results=fixtures.map(item=>({name:item.name,expected:item.expected,audit:auditGeneratedHistory(item.spec.stage,item.spec.output,item.spec.label,item.spec.target,item.spec.selected)})),passed=results.every(item=>item.expected===item.audit.passed)
 console.log(JSON.stringify({mode:'actual-API-synthetic-RSM-fixtures',passed,sources,results,providerCalls:0,remoteCalls:0}));if(!passed)throw Error('Genuine generation history regression')
}
async function checkAdmissionFixtures(){
 const root=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/gates/change3'),provenance=await Bun.file(path.join(bootstrapSource,'provenance.json')).json(),fixtures:any[]=[]
 for(const [i,seed] of [3051971263,1478874995].entries()){
  const directory=path.join(root,'fixture-target-first-seed-'+seed),file=path.join(directory,'native-search/receipt.json'),native=await Bun.file(file).json(),generationIndex=await Bun.file(path.join(directory,'generation-runs/index.json')).json(),generationArtifacts=await Promise.all(generationIndex.entries.map((entry:any)=>Bun.file(path.join(directory,entry.artifactPath)).json()))
  const spec={native,run:{id:native.runId},trial:{id:'synthetic_fixture_'+seed,programHash:native.programHash},targetSequence:native.admission.projection[0].externalInputs[0].initial.sequence,ordinal:i+1,bootstrap:{provenance},generationSeed:seed,generationArtifacts,generationIndex,nativeArtifactHash:hash(await fs.readFile(file)),maximumWallSeconds:60}
  fixtures.push({name:'actual-native-generation-admission-'+seed,spec,expected:true})
  if(i===0){
   const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(spec);change(value);fixtures.push({name,spec:value,expected:false})}
   mutate('recipe-byte-hash-is-not-descriptor-hash',value=>value.native.admission.projection[0].stages[0].constraints[0].function.sourceHash=predictorRecipeHash)
   mutate('predictor-default-settings-changed',value=>value.native.calls[1].configHash='sha256:'+'0'.repeat(64))
   mutate('predictor-seed-confounded',value=>value.native.calls[1].configSeed=seed)
   mutate('generation-entirely-cached',value=>value.native.calls[0].cacheOrigin='cache_hit')
   mutate('backbone-modified',value=>value.native.admission.projection[0].stages[0].generators[0].config.structure_inputs[0].structure.structure+='\n')
   mutate('host-authored-proposal-source',value=>value.native.admission.projection[0].stages[0].config.proposal_source='provided')
   mutate('artifact-generator-provenance-lost',value=>delete value.generationArtifacts[0].metadata.proteinmpnn)
   mutate('followup-without-temperature-intervention',value=>value.ordinal=3)
   mutate('additional-hidden-objective',value=>value.native.admission.projection[0].stages[0].constraints.push(structuredClone(value.native.admission.projection[0].stages[0].constraints[0])))
  }
 }
 const results=fixtures.map(item=>{const audit=auditLearnedReceipt(item.spec);return {name:item.name,expected:item.expected,passed:audit.passed,bootstrapBound:audit.bootstrapBound,seedRolesBound:audit.seedRolesBound,generationMetadataBound:audit.generationMetadataBound,temperatureProtocolBound:audit.temperatureProtocolBound,historyPassed:audit.objectiveHistory.passed}}),passed=results.every(item=>item.expected===item.passed)
 console.log(JSON.stringify({mode:'actual-native-API-admission-fixtures',passed,results,providerCalls:0,remoteCalls:0,authority:'Actual native fixture schema with typed synthetic model outputs; no learned inference or scientific evidence'}));if(!passed)throw Error('Normal generated receipt admission regression')
}
async function checkCampaignFixture(){
 const base=await Bun.file(path.join(main,'.autofold/cohesive-engine-refactor-20261012/final-gpu-validation/operator/contract.json')).json()
 base.objective=objective;base.budget.maximumCandidates=1;base.budget.gpuHours=600/3600;base.budget.wallTimeMinutes=15
 const contract=ResearchDomain.ExperimentContract.parse(base)
 if(campaignObjective.length>=2000)throw Error('Short campaign objective exceeds charter capacity')
 const fixtureWorkspace=await fs.mkdtemp('/private/tmp/autofold-learned-generation-campaign-fixture-'),fixtureProject='prj_learned_generation_campaign_fixture'
 const deny=()=>{throw Error('Local campaign fixture forbids model/worker effects')}
 const app=new Application({workspace:fixtureWorkspace,projectId:fixtureProject,jobs:{runtimeOptions:{streamFn:deny,getApiKey:deny,authorizeModelRequest:deny}}})
 const campaign=await app.research.createCampaign(fixtureProject,{objective:campaignObjective});await app.research.activateCampaign(fixtureProject,campaign.id)
 const experiment=await app.research.createExperiment(fixtureProject,campaign.id,{contract});await app.research.activateExperiment(fixtureProject,experiment.id)
 await app.store.mutate(fixtureProject,state=>{state.campaignCharters[campaign.id]!.constraints.maximumCampaignTrials=4;state.campaignCharters[campaign.id]!.constraints.maximumCampaignGpuHours=4*contract.budget.gpuHours})
 const state=await app.store.read(fixtureProject),charters=Object.values(state.campaignCharters)
 const passed=state.campaigns[campaign.id]?.status==='active'&&state.experiments[experiment.id]?.status==='active'&&experiment.contract.objective===objective&&experiment.contractHash===ResearchDomain.hashContract(contract)&&charters.length===1&&charters[0]!.constraints.maximumCampaignTrials===4&&charters[0]!.successCriteria.every(item=>item.statement.length<=2000)&&['jobs','trials','runs','operations','operationOutbox','skillVersions'].every(key=>Object.keys((state as any)[key]).length===0)
 const report={mode:'local_campaign_construction_fixture',passed,fixtureWorkspace,campaignObjectiveLength:campaignObjective.length,fullExperimentObjectiveLength:contract.objective.length,contractHash:experiment.contractHash,campaignId:campaign.id,experimentId:experiment.id,charters,providerCalls:0,remoteCalls:0,jobs:0,trials:0,runs:0,skills:0}
 await fs.writeFile(path.join(fixtureWorkspace,'fixture-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));if(!passed)throw Error('Actual campaign construction fixture failed')
}
function assertFirstExecutionBinding(gate:any,input:{programHash:string;contractHash:string;generationSeed:number;nativeProgramSeed:number;experimentId:string;sessionId:string}){
 if(!firstDraftBindingMatches(gate,input)||input.contractHash!==gate.contractHash||input.nativeProgramSeed!==gate.generationSeed)throw Error('First scientific execution must bind the exact validated source, contract, session and generation seed before GPU dispatch')
}
function assertNativeRoleScope(actual:{experimentId:string;sessionId:string;contractHash:string;generationSeed:number},expected:{experimentId:string;sessionId:string;contractHash:string;generationSeed:number}){
 if(actual.experimentId!==expected.experimentId||actual.sessionId!==expected.sessionId||actual.contractHash!==expected.contractHash||actual.generationSeed!==expected.generationSeed)throw Error('Native admission must bind the actual experiment, scientist, contract and host slot seed')
}
function firstDraftBindingMatches(gate:any,trial:any){return gate?.passed===true&&trial?.programHash===gate.programHash&&trial.generationSeed===gate.generationSeed&&trial.experimentId===gate.experimentId&&trial.sessionId===gate.sessionId}
function authoringEffectTool(name:string){return ['evaluate_trial','submit_trial','stop_discovery','request_research','review_run','record_observation'].includes(name)}
async function gateValidatorDelivery(result:any,accept:()=>Promise<void>){
 if(result.details?.valid!==true)return result
 try{await accept();return {...result,terminate:true}}
 catch(error){const failure={valid:false,category:'program',error:error instanceof Error?error.message:String(error),nativeValidationReceipt:result.details,repair:'Author a complete decision_plan using the exact experiment.id setup reference when no measurements exist; keep first-baseline prediction=None. Repair this draft and validate again.'};return {content:[{type:'text',text:JSON.stringify(failure)}],details:failure}}
}
async function checkAuthoringGateFixtures(){
 const native=await Bun.file(path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/gates/change3/fixture-target-first-seed-3051971263/native-search/receipt.json')).json(),cases:any[]=[{name:'actual-first-slot-native-construction',descriptor:native.admission,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(native.admission);change(value);cases.push({name,descriptor:value,expected:false})}
 mutate('operator-or-scaffold-proposal',value=>value.projection[0].stages[0].config.proposal_source='provided')
 mutate('followup-temperature-before-baseline',value=>value.projection[0].stages[0].generators[0].config.temperature=0.2)
 mutate('cropped-frozen-target',value=>value.projection[0].externalInputs[0].initial.sequence='AAA')
 mutate('first-host-seed-overridden',value=>value.projection[0].programSeed=123)
 mutate('undeclared-extra-native-tool',value=>value.budget.allowedTools.push('another-tool'))
 const results=cases.map(item=>{let accepted=true,diagnostic:string|undefined;try{assertGateSearchPolicy(item.descriptor,60,native.admission.projection[0].externalInputs[0].initial.sequence,native.admission.projection[0].programSeed)}catch(error){accepted=false;diagnostic=error instanceof Error?error.message:String(error)}return {name:item.name,expected:item.expected,accepted,...(diagnostic?{diagnostic}: {})}})
 const empty={trialIds:[],runIds:[],originalLaunchRunIds:[],scientificEvaluationToolStarts:[]},effectChecks=[{name:'zero-empirical-work',snapshot:empty,expected:true},...['trialIds','runIds','originalLaunchRunIds','scientificEvaluationToolStarts'].map(key=>({name:'reject-'+key,snapshot:{...empty,[key]:['observed']},expected:false}))].map(item=>({...item,accepted:noEmpiricalEffects(item.snapshot)}))
 const failed=await gateValidatorDelivery({details:{valid:false},content:[]},async()=>{throw Error('must not enter')})
 const rejected=await gateValidatorDelivery({details:{valid:true},content:[]},async()=>{throw Error('prospective methodology is missing')})
 let modelCalls=0,scientificEffects=0,validationCalls=0
 const message:AssistantMessage={role:'assistant',content:[{type:'toolCall',id:'call_offline_validation',name:'validate_trial',arguments:{}}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0.001,output:0,cacheRead:0,cacheWrite:0,total:0.001}}}
 const runtime=new PiRuntime({store:new MemorySessionStore(),accountingProvenance:'offline_fixture',limits:{maxTurns:2,maxToolCalls:3,maxDurationMs:3000},authorizeToolCall:request=>{if(authoringEffectTool(request.toolName))throw Error('No empirical authoring-gate effects')},tools:[{name:'validate_trial',label:'Synthetic validator protocol fixture',description:'Explicit offline non-scientific protocol fixture',parameters:Type.Object({}),execute:async()=>{validationCalls++;return gateValidatorDelivery({content:[{type:'text',text:'Synthetic offline host validator protocol; not live authoring proof'}],details:{valid:true,syntheticFixture:true}},async()=>{})}},{name:'evaluate_trial',label:'Forbidden empirical tool',description:'Must not execute',parameters:Type.Object({}),execute:async()=>{scientificEffects++;throw Error('Unexpected scientific effect')}}],streamFn:()=>{modelCalls++;if(modelCalls>1)throw Error('Validated gate should stop before another inference');const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message});stream.end(message);return stream}})
 const session=await runtime.create(),outcome=await runtime.run(session.id,'Explicit offline authoring-stop protocol fixture')
 let deniedInferenceCalls=0,deniedScientificEffects=0
 const deniedRuntime=new PiRuntime({store:new MemorySessionStore(),accountingProvenance:'offline_fixture',limits:{maxTurns:2,maxToolCalls:2,maxDurationMs:3000},authorizeToolCall:request=>{if(authoringEffectTool(request.toolName))throw Error('Authoring phase forbids empirical execution')},tools:[{name:'evaluate_trial',label:'Forbidden scientific effect',description:'Explicit offline fence test',parameters:Type.Object({}),execute:async()=>{deniedScientificEffects++;return {content:[],details:{unexpected:true}}}}],streamFn:()=>{deniedInferenceCalls++;const value:AssistantMessage=deniedInferenceCalls===1?{...message,content:[{type:'toolCall',id:'call_forbidden',name:'evaluate_trial',arguments:{}}]}:{...message,stopReason:'stop',content:[{type:'text',text:'Offline fixture acknowledges the denied tool.'}]};const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:value.stopReason as 'toolUse'|'stop',message:value});stream.end(value);return stream}})
 const deniedSession=await deniedRuntime.create();await deniedRuntime.run(deniedSession.id,'Explicit offline empirical authorization fence test')
 const followup=structuredClone(native.admission);followup.projection[0].stages[0].generators[0].config.temperature=0.05
 const followupCases:any[]=[{name:'third-slot-prospective-temperature',descriptor:followup,expected:true}]
 const wrongFollowup=(name:string,change:(value:any)=>void)=>{const value=structuredClone(followup);change(value);followupCases.push({name,descriptor:value,expected:false})}
 wrongFollowup('followup-uncontrolled-native-tool-budget',value=>value.budget.maximumToolCalls=3)
 wrongFollowup('followup-more-than-one-proposal',value=>value.budget.maximumProposals=2)
 wrongFollowup('followup-more-than-one-sampling',value=>value.budget.maximumSamplingCalls=2)
 wrongFollowup('followup-optimizer-replaced',value=>value.projection[0].stages[0].optimizer='MCMCOptimizer')
 wrongFollowup('followup-predictor-seed-overridden',value=>value.projection[0].stages[0].constraints[0].config.predictor_seed=123)
 wrongFollowup('followup-objective-wrapper-replaced',value=>value.projection[0].stages[0].constraints[0].function.sourceHash='sha256:'+'0'.repeat(64))
 wrongFollowup('followup-full-target-cropped',value=>value.projection[0].externalInputs[0].initial.sequence='AAA')
 wrongFollowup('followup-output-is-scaffold-or-target',value=>value.budget.outputs[0].segment='target')
 wrongFollowup('followup-temperature-uncontrolled',value=>value.projection[0].stages[0].generators[0].config.temperature=0.3)
 wrongFollowup('followup-host-seed-overridden',value=>value.projection[0].programSeed=321)
 let invalidFollowupDispatches=0
 const followupResults=followupCases.map(item=>{let accepted=true;try{assertGateSearchPolicy(item.descriptor,60,native.admission.projection[0].externalInputs[0].initial.sequence,native.admission.projection[0].programSeed,3);if(!item.expected)invalidFollowupDispatches++}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}})
 const expectedRole={experimentId:'exp_scope',sessionId:'ses_scope',contractHash:'sha256:'+'3'.repeat(64),generationSeed:123},scopeCases=['experimentId','sessionId','contractHash','generationSeed'].map(key=>{const actual:any={...expectedRole,[key]:key==='generationSeed'?456:'other'};let rejected=false;try{assertNativeRoleScope(actual,expectedRole);invalidFollowupDispatches++}catch{rejected=true}return {name:'pre-GPU-reject-wrong-'+key,rejected}})
 const frozenGate={passed:true,contractHash:'sha256:'+'2'.repeat(64),programHash:'sha256:'+'1'.repeat(64),generationSeed:123,experimentId:'exp_fixture',sessionId:'ses_fixture'},firstDraftCases=[{name:'same-validated-slot',trial:{...frozenGate},expected:true},...['programHash','generationSeed','experimentId','sessionId'].map(key=>({name:'reject-stale-first-'+key,trial:{...frozenGate,[key]:key==='generationSeed'?456:'different'},expected:false}))].map(item=>({...item,accepted:firstDraftBindingMatches(frozenGate,item.trial)}))
 let forbiddenFirstDispatches=0;const firstExecutionCases=['nativeProgramSeed','generationSeed','programHash','contractHash'].map(key=>{const input:any={...frozenGate,nativeProgramSeed:frozenGate.generationSeed,[key]:key.includes('Seed')?456:'different'};let rejected=false;try{assertFirstExecutionBinding(frozenGate,input);forbiddenFirstDispatches++}catch{rejected=true}return {name:'pre-GPU-reject-'+key,rejected}})
 const diagnosticChecks={invalidDraftReceivesActualExpectedFields:results.filter(item=>!item.expected).every(item=>item.diagnostic?.includes('\"field\"')&&item.diagnostic.includes('\"actual\"')&&item.diagnostic.includes('\"expected\"')),boundedNoStructureOrSourceBody:results.filter(item=>!item.expected).every(item=>!!item.diagnostic&&item.diagnostic.length<4000&&!item.diagnostic.includes('ATOM ')&&!item.diagnostic.includes('def fixed_predictor_iptm'))}
 const runtimeChecks={...diagnosticChecks,allFollowupProtocolRejectedBeforeDispatch:invalidFollowupDispatches===0&&followupResults.every(item=>item.expected===item.accepted)&&scopeCases.every(item=>item.rejected),wrongFirstSeedNeverDispatched:forbiddenFirstDispatches===0&&firstExecutionCases.every(item=>item.rejected),firstSlotBindingExact:firstDraftCases.every(item=>item.expected===item.accepted),forbiddenEmpiricalToolNeverInvoked:deniedScientificEffects===0,hostValidatedToolTerminates:modelCalls===1&&validationCalls===1&&['completed','stopped'].includes(outcome.status),zeroScientificEffects:scientificEffects===0,failedValidatorContinues:!failed.terminate,missingProspectivePlanContinues:rejected.details.valid===false&&!rejected.terminate}
 const passed=results.every(item=>item.expected===item.accepted)&&effectChecks.every(item=>item.expected===item.accepted)&&Object.values(runtimeChecks).every(Boolean)
 console.log(JSON.stringify({mode:'authoring-only-first-slot-no-empirical-effects-fixtures',passed,results,effectChecks,firstDraftCases,firstExecutionCases,followupResults,scopeCases,runtimeChecks,runtimeStatus:outcome.status,modelCalls,validationCalls,scientificEffects,providerCalls:0,remoteCalls:0,authority:'Actual Pi stop semantics and actual native schema with explicitly synthetic local responses; this is not the live authoring gate or scientific evidence.'}));if(!passed)throw Error('Live gate protocol regression')
}
function nativePolicyRepairError(descriptor:any,maximumWallSeconds:number,targetSequence?:string,generationSeed?:number,ordinal=1){
 const budget=descriptor?.budget,lanes=descriptor?.projection,stage=lanes?.[0]?.stages?.[0],generator=stage?.generators?.[0],constraint=stage?.constraints?.[0],output=budget?.outputs?.[0],construct=lanes?.[0]?.constructs?.find((item:any)=>item.label===output?.construct),binder=construct?.segments?.find((item:any)=>item.label===output?.segment)
 // Diagnostics contain scalar settings, identifiers and digests only. Never
 // include the generator structure string, callable source or draft program.
 const safe=(value:any):any=>{if(value===undefined)return {missing:true};if(Array.isArray(value)&&value.length<=8)return value.map(safe);if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;if(typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,96}$/.test(value))return value;return {type:Array.isArray(value)?'array':typeof value,...(Array.isArray(value)?{length:value.length}:{}),contentHash:hash(JSON.stringify(value)??String(value))}}
 const same=(actual:any,expected:any)=>JSON.stringify(actual)===JSON.stringify(expected),fields:{field:string;actual:any;expected:any}[]=[]
 const add=(field:string,actual:any,expected:any)=>{if(!same(actual,expected))fields.push({field,actual:safe(actual),expected:safe(expected)})}
 add('projection.laneCount',lanes?.length,1);add('lane.stageCount',lanes?.[0]?.stages?.length,1);add('stage.optimizer',stage?.optimizer,'RejectionSamplingOptimizer')
 for(const [key,value] of Object.entries({num_results:1,num_samples:1,proposal_source:'generated',proposal_batch_size:1,track_proposals:true,energy_threshold:null}))add('stage.config.'+key,stage?.config?.[key],value)
 add('stage.generatorCount',stage?.generators?.length,1);add('generator.key',generator?.key,'proteinmpnn')
 if(!(ordinal>=1&&ordinal<=4&&(ordinal<=2?generator?.config?.temperature===0.1:[0.05,0.2].includes(generator?.config?.temperature))))add('generator.config.temperature',generator?.config?.temperature,ordinal<=2?0.1:[0.05,0.2])
 for(const [key,value] of Object.entries({batch_size:1,device:'cuda',model_choice:'proteinmpnn',excluded_amino_acids:null}))add('generator.config.'+key,generator?.config?.[key],value)
 add('stage.constraintCount',stage?.constraints?.length,1);for(const [key,value] of Object.entries({weight:1,threshold:null,backward:null}))add('constraint.'+key,constraint?.[key],value)
 add('constraint.function.sourceHash',constraint?.function?.sourceHash,hash(JSON.stringify(predictorRecipeSource)));add('constraint.configHash',constraint?.config===undefined?undefined:'sha256:'+operationHash(constraint.config),'sha256:'+operationHash({predictor_seed:fixedPredictorSeed}))
 for(const [key,value] of Object.entries({maximumCandidates:1,maximumProposals:1,maximumSamplingCalls:1,maximumToolCalls:2,maximumWallSeconds}))add('budget.'+key,budget?.[key],value)
 add('budget.allowedTools',Array.isArray(budget?.allowedTools)?[...budget.allowedTools].sort():undefined,['boltz2-prediction','proteinmpnn-sample']);add('budget.outputCount',budget?.outputs?.length,1);add('output.lane',output?.lane,0);add('selectedBinder.length',binder?.length,12)
 add('generator.assignedSegmentHash',generator?.segments===undefined?undefined:'sha256:'+operationHash(generator.segments),binder?'sha256:'+operationHash([binder.id]):'exact_selected_binder')
 if(targetSequence!==undefined){const segments=Array.isArray(lanes)?lanes.flatMap((lane:any)=>[...lane.externalInputs??[],...(lane.constructs??[]).flatMap((construct:any)=>construct.segments??[])]):[],matches=segments.filter((segment:any)=>segment.initial?.sequence===targetSequence);add('target.exactFrozenSequenceMatchCount',matches.length,1);add('target.matchesBinder',matches.length===1?matches[0].id===binder?.id:undefined,false);add('constraint.inputHash',constraint?.inputs===undefined?undefined:'sha256:'+operationHash(constraint.inputs),matches.length===1&&binder?'sha256:'+operationHash([matches[0].id,binder.id]):'full_frozen_target_then_selected_binder')}
 if(generationSeed!==undefined)add('lane.programSeed',lanes?.[0]?.programSeed,generationSeed)
 return Error('Frozen learned-generation native policy differs: '+JSON.stringify({mismatchCount:fields.length,fields:fields.slice(0,16),remainingMismatchCount:Math.max(0,fields.length-16),repair:'Use the frozen declarative settings and exact ctx assets; repair your authored draft and validate again. No scientific execution was admitted.'}))
}

function assertGateSearchPolicy(descriptor:any,maximumWallSeconds=300,targetSequence?:string,generationSeed?:number,ordinal=1){
 const budget=descriptor?.budget,lanes=descriptor?.projection,stage=lanes?.[0]?.stages?.[0],generator=stage?.generators?.[0],constraint=stage?.constraints?.[0],output=budget?.outputs?.[0],construct=lanes?.[0]?.constructs?.find((item:any)=>item.label===output?.construct),binder=construct?.segments?.find((item:any)=>item.label===output?.segment)
 if(lanes?.length!==1||lanes[0].stages?.length!==1||stage.optimizer!=='RejectionSamplingOptimizer'||stage.config.num_results!==1||stage.config.num_samples!==1||stage.config.proposal_source!=='generated'||stage.config.proposal_batch_size!==1||stage.config.track_proposals!==true||stage.config.energy_threshold!==null||stage.generators.length!==1||generator.key!=='proteinmpnn'||!(ordinal>=1&&ordinal<=4&&(ordinal<=2?generator.config.temperature===0.1:[0.05,0.2].includes(generator.config.temperature)))||generator.config.batch_size!==1||generator.config.device!=='cuda'||generator.config.model_choice!=='proteinmpnn'||generator.config.excluded_amino_acids!==null||stage.constraints.length!==1||constraint.weight!==1||constraint.threshold!==null||constraint.backward!==null||constraint.function?.sourceHash!==hash(JSON.stringify(predictorRecipeSource))||operationHash(constraint.config)!==operationHash({predictor_seed:fixedPredictorSeed})||budget.maximumCandidates!==1||budget.maximumProposals!==1||budget.maximumSamplingCalls!==1||budget.maximumToolCalls!==2||budget.maximumWallSeconds!==maximumWallSeconds||operationHash([...budget.allowedTools].sort())!==operationHash(['boltz2-prediction','proteinmpnn-sample'])||budget.outputs.length!==1||output.lane!==0||!binder||binder.length!==12||operationHash(generator.segments)!==operationHash([binder.id]))throw nativePolicyRepairError(descriptor,maximumWallSeconds,targetSequence,generationSeed,ordinal)
 if(targetSequence!==undefined){const matches=lanes.flatMap((lane:any)=>[...lane.externalInputs,...lane.constructs.flatMap((construct:any)=>construct.segments)]).filter((segment:any)=>segment.initial?.sequence===targetSequence);if(matches.length!==1||matches[0].id===binder.id||operationHash(constraint.inputs)!==operationHash([matches[0].id,binder.id]))throw nativePolicyRepairError(descriptor,maximumWallSeconds,targetSequence,generationSeed,ordinal)}
 if(generationSeed!==undefined&&lanes[0].programSeed!==generationSeed)throw nativePolicyRepairError(descriptor,maximumWallSeconds,targetSequence,generationSeed,ordinal)
}
function assertBootstrapPolicy(descriptor:any,expectedHash:string){
 const lanes=descriptor?.projection,stages=Array.isArray(lanes)?lanes.flatMap((lane:any)=>lane.stages??[]):[],generators=stages.flatMap((stage:any)=>stage.generators??[]),generator=generators[0],input=generator?.config?.structure_inputs?.[0]
 if(lanes?.length!==1||stages.length!==1||generators.length!==1||generator.key!=='proteinmpnn'||generator.config.model_choice!=='proteinmpnn'||generator.config.structure_inputs.length!==1||typeof input?.structure?.structure!=='string'||hash(input.structure.structure)!==expectedHash||input.structure.structure_format!=='pdb'||operationHash(input.chains_to_redesign)!==operationHash({chains:['B']})||input.fixed_positions!==null||generator.config.output_chain_id!=='B')throw Error('Pre-GPU admitted ProteinMPNN input must use exactly the frozen chain-B backbone bytes')
}
function verifyBundledBootstrap(bundle:any,expectedHash:string){
 try{
  if(!Array.isArray(bundle.frozenAssets)||bundle.frozenAssets.length!==1)return false
  const asset=bundle.frozenAssets[0]
  if(asset.id!==bootstrapAssetId||asset.contentHash!==expectedHash||operationHash(asset.nativeBindings)!==operationHash([bootstrapNativeBinding]))return false
  assertFrozenAssets(bundle.frozenAssets,bundle.nativeExecution?.descriptor);assertBootstrapPolicy(bundle.nativeExecution?.descriptor,expectedHash);return true
 }catch{return false}
}
async function checkAssetFixtures(){
 const directory=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/gates/change3/fixture-target-first-seed-3051971263'),native=await Bun.file(path.join(directory,'native-search/receipt.json')).json(),provenance=await Bun.file(path.join(bootstrapSource,'provenance.json')).json(),backbone=await fs.readFile(provenance.backboneFile)
 const bundle={frozenAssets:[{id:bootstrapAssetId,contentHash:provenance.backboneHash,contentBase64:backbone.toString('base64'),nativeBindings:[bootstrapNativeBinding]}],nativeExecution:{descriptor:native.admission}},cases:any[]=[{name:'actual-native-exact-portable-asset',bundle,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(bundle);change(value);cases.push({name,bundle:value,expected:false})}
 mutate('observed-old-run-trailing-spaces-lost',value=>value.nativeExecution.descriptor.projection[0].stages[0].generators[0].config.structure_inputs[0].structure.structure=backbone.toString('utf8').split('\n').map(line=>line.trimEnd()).join('\n'))
 mutate('base64-content-tampered',value=>value.frozenAssets[0].contentBase64=Buffer.from(backbone.toString('utf8')+'\n').toString('base64'))
 mutate('missing-host-authority',value=>delete value.frozenAssets)
 mutate('wrong-asset-id',value=>value.frozenAssets[0].id='another-backbone')
 mutate('missing-native-binding',value=>value.frozenAssets[0].nativeBindings=[])
 mutate('extra-hidden-generator',value=>value.nativeExecution.descriptor.projection[0].stages[0].generators.push(structuredClone(value.nativeExecution.descriptor.projection[0].stages[0].generators[0])))
 const results=cases.map(item=>({name:item.name,expected:item.expected,passed:verifyBundledBootstrap(item.bundle,provenance.backboneHash)})),passed=results.every(item=>item.expected===item.passed)
 console.log(JSON.stringify({mode:'pre-GPU-exact-portable-bootstrap-fixtures',passed,results,providerCalls:0,remoteCalls:0,scientificProgramsAuthored:0}));if(!passed)throw Error('Exact frozen bootstrap policy regression')
}
function verifyRecoveryObservation(input:{sessionId:string;requestId:string;original:any;updated:any;raw:any;captured:any}){
 const {sessionId,requestId,original,updated,raw,captured}=input,data=captured?.body?.data,binding=original.modelBinding
 if(raw.identityConflict||raw.identityInvalid||(raw.model!==undefined&&!authorizedStreamModel(raw.model,{requestedModelId:binding?.requestedModelId,canonicalModelId:binding?.canonicalModelId}))||!data||captured.httpStatus!==200||typeof captured.contentHash!=='string'||data.id!==original.providerBilling?.upstreamRequestId||data.id!==raw.id||data.provider_name!==original.providerBilling?.routedProvider||data.provider_name!==raw.provider||data.model!==binding?.canonicalModelId||original.model.provider!==model.provider||binding.requestedModelId!==model.modelId||typeof data.total_cost!=='number'||!Number.isFinite(data.total_cost)||data.total_cost<0||typeof data.finish_reason!=='string'||!data.finish_reason||data.cancelled===true)throw Error('Recovery evidence does not bind the exact original final request and bill')
 const receiptHash=hash(JSON.stringify({id:data.id,model:data.model,provider_name:data.provider_name,total_cost:data.total_cost,finish_reason:data.finish_reason,native_finish_reason:data.native_finish_reason??null,created_at:data.created_at??null}))
 if(operationHash(updated.model)!==operationHash(original.model)||operationHash(updated.modelBinding)!==operationHash(original.modelBinding)||updated.startedAt!==original.startedAt||operationHash(updated.delivery??null)!==operationHash(original.delivery??null)||updated.status!=='settled'||updated.providerBilling?.status!=='reported'||updated.providerBilling.upstreamRequestId!==data.id||updated.providerBilling.routedProvider!==data.provider_name||updated.providerBilling.observedModelId!==data.model||updated.providerBilling.finishReason!==data.finish_reason||updated.providerBilling.reportedCostUsd!==data.total_cost||updated.providerBilling.evidenceHash!==receiptHash||updated.usageEvidence?.source!=='openrouter_generation_api_v1'||updated.usageEvidence.sha256!==receiptHash||updated.usageEvidence.upstreamRequestId!==data.id||updated.usageEvidence.receiptId!=='openrouter-generation:'+data.id)throw Error('Verified final provider receipt differs from canonical settlement')
 return {requestSequence:raw.requestSequence,id:data.id,provider:data.provider_name,model:data.model,finishReason:data.finish_reason,usage:{cost:data.total_cost},recoveryEvidenceHash:receiptHash,recoverySource:'openrouter_generation_api_v1',originalSessionId:sessionId,originalRequestId:requestId,delivery:updated.delivery,originalStreamErrorPreserved:!!raw.error||!!raw.observationError,lookupContentHash:captured.contentHash,observedAt:new Date().toISOString()}
}
function checkProviderRecoveryFixtures(){
 const data={id:'gen_original',model:model.modelId+'-20990101',provider_name:'AuthorizedProvider',total_cost:0.02,finish_reason:'stop',native_finish_reason:'stop',created_at:1},receiptHash=hash(JSON.stringify(data)),delivery={status:'failed',stopReason:'error',partialToolCallCount:1,recordedAt:1}
 const original={model:{...model},modelBinding:{provider:'openrouter',requestedModelId:model.modelId,canonicalModelId:data.model,source:'explicit_host_alias'},startedAt:1,delivery,providerBilling:{upstreamRequestId:data.id,routedProvider:data.provider_name}},updated={...structuredClone(original),status:'settled',providerBilling:{status:'reported',upstreamRequestId:data.id,routedProvider:data.provider_name,observedModelId:data.model,finishReason:data.finish_reason,reportedCostUsd:data.total_cost,evidenceHash:receiptHash},usageEvidence:{source:'openrouter_generation_api_v1',sha256:receiptHash,upstreamRequestId:data.id,receiptId:'openrouter-generation:'+data.id}},raw={id:data.id,model:model.modelId,provider:data.provider_name,requestSequence:1,error:'preserved original stream failure'},captured={body:{data},contentHash:hash(JSON.stringify({data})),httpStatus:200}
 const valid={sessionId:'ses_original',requestId:'req_original',original,updated,raw,captured},cases:any[]=[{name:'exact-final-bill-preserves-failed-delivery',input:valid,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(valid);change(value);cases.push({name,input:value,expected:false})}
 mutate('zero-placeholder-nonterminal',value=>{value.captured.body.data.total_cost=0;value.captured.body.data.finish_reason=null})
 mutate('wrong-original-upstream-id',value=>value.captured.body.data.id='gen_other')
 mutate('wrong-canonical-model',value=>value.captured.body.data.model='other/model')
 mutate('wrong-routed-provider',value=>value.captured.body.data.provider_name='OtherProvider')
 mutate('canonical-evidence-not-settled',value=>value.updated.status='unknown')
 mutate('invented-successful-delivery',value=>value.updated.delivery.status='completed')
 mutate('canonical-receipt-evidence-changed',value=>value.updated.usageEvidence.sha256='sha256:'+'0'.repeat(64))
 mutate('original-stream-identity-conflict',value=>value.raw.identityConflict=true)
 const results=cases.map(item=>{let accepted=true,failedDeliveryPreserved=false;try{const response=verifyRecoveryObservation(item.input);failedDeliveryPreserved=response.delivery.status==='failed'&&response.originalStreamErrorPreserved}catch{accepted=false}return {name:item.name,expected:item.expected,accepted,failedDeliveryPreserved}}),passed=results.every(item=>item.expected===item.accepted)&&results[0]!.failedDeliveryPreserved
 console.log(JSON.stringify({mode:'final-only-original-provider-recovery-fixtures',passed,results,providerCalls:0,remoteCalls:0,partialToolCallsExecuted:0,modelRequestsReissued:0}));if(!passed)throw Error('Original final provider receipt binding regression')
}
function checkMemoryAdmissionFixtures(){
 const parentRuns=[{id:'run_parent_one',trialId:'trl_parent_one',status:'succeeded',manifestHash:'sha256:'+'1'.repeat(64),completedAt:'2026-10-13T00:00:00Z'},{id:'run_parent_two',trialId:'trl_parent_two',status:'succeeded',manifestHash:'sha256:'+'2'.repeat(64),completedAt:'2026-10-13T00:01:00Z'}],parents=parentRuns.map(run=>({id:run.trialId})),scope={projectId,experimentId:'exp_memory_fixture',campaignId:'cmp_memory_fixture'},manifestHash='sha256:'+'3'.repeat(64),snapshotHash='sha256:'+'4'.repeat(64),packet={sourceManifest:{scope,manifestHash,snapshotHash},facts:parentRuns.map(run=>({runId:run.id,receiptStatus:'verified',receiptHash:run.manifestHash}))},packetHash='sha256:'+operationHash(packet),decisionPlan={evidenceRefs:[parentRuns[0].id],changedVariables:['ProteinMPNN temperature']},evidenceRefs=[parentRuns[0].id],sessionId='ses_memory_fixture',requestId='evaluate_memory_fixture',toolCallId='call_memory_fixture'
 const followup={id:'trl_followup',experimentId:scope.experimentId,origin:{jobId:'job_memory_fixture'},createdAt:'2026-10-13T00:02:00Z',decisionPlan,evidenceRefs,prediction:{comparatorTrialId:parents[0].id,metric:'locked_score',relation:'lower'},decisionMemoryExposure:{sessionId,scope,packetHash,manifestHash,snapshotHash,citedSources:[{id:parentRuns[0].id}],decisionHash:'sha256:'+operationHash({decisionPlan,evidenceRefs})}},state={jobs:{job_memory_fixture:{payload:{sessionId}}},experiments:{[scope.experimentId]:{campaignId:scope.campaignId}},runs:{}},sessions={journal:[{sessionId,sequence:2,type:'model_request_settled',data:{requestId:'req_context_original'}},{sessionId,sequence:3,type:'message_end',data:{message:{role:'assistant',content:[{type:'toolCall',id:toolCallId,name:'evaluate_trial'}]}}},{sessionId,sequence:4,type:'tool_execution_start',data:{toolName:'evaluate_trial',toolCallId,args:{requestId}}}]},inferenceContexts=[{sessionId,requestId:'req_context_original',settledSequence:2,transcriptHash:'sha256:'+'5'.repeat(64),packets:[{packetHash,packet,manifestVerification:{status:'verified',manifestHash,snapshotHash}}]}]
 const valid={followup,state,sessions,parents,parentRuns,inferenceContexts,temperature:0.05,requestId,toolCallId},cases:any[]=[{name:'exact-current-memory-before-GPU',input:valid,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(valid);change(value);cases.push({name,input:value,expected:false})}
 mutate('unexposed-first-two-facts',value=>value.inferenceContexts[0].packets[0].packet.facts=[])
 mutate('stale-request-not-current-inference',value=>value.inferenceContexts[0].requestId='other_request')
 mutate('changed-exposure-packet-hash',value=>value.followup.decisionMemoryExposure.packetHash='sha256:'+'0'.repeat(64))
 mutate('parent-not-cited',value=>{value.followup.evidenceRefs=[];value.followup.decisionPlan.evidenceRefs=[]})
 mutate('no-actual-temperature-intervention',value=>value.temperature=0.1)
 mutate('wrong-active-evaluate-tool',value=>value.toolCallId='other_call')
 let invalidScientificDispatches=0
 const results=cases.map(item=>{const proof=auditFollowupMemoryProof(item.input);if(proof.passed&&!item.expected)invalidScientificDispatches++;return {name:item.name,expected:item.expected,passed:proof.passed}}),passed=results.every(item=>item.expected===item.passed)&&invalidScientificDispatches===0
 console.log(JSON.stringify({mode:'shared-pre-GPU-and-final-memory-proof-fixtures',passed,results,invalidScientificDispatches,providerCalls:0,remoteCalls:0,authority:'Synthetic exact inference/event bindings test the shared admission auditor; no live memory delivery or scientific evidence is claimed.'}));if(!passed)throw Error('Pre-GPU memory admission regression')
}
const [mode,...args]=process.argv.slice(2)
if(mode==='--check-memory-fixtures'){if(args.length)throw Error('Unexpected memory fixture arguments');checkMemoryAdmissionFixtures();process.exit(0)}
if(mode==='--check-carryover-fixtures'){if(args.length)throw Error('Unexpected carryover fixture arguments');await checkCarryoverFixtures();process.exit(0)}
if(mode==='--check-authoring-fixtures'){if(args.length)throw Error('Unexpected authoring fixture arguments');await checkAuthoringGateFixtures();process.exit(0)}
if(mode==='--check-alias-fixtures'){if(args.length)throw Error('Unexpected alias fixture arguments');checkAliasFixtures();process.exit(0)}
if(mode==='--check-recovery-fixtures'){if(args.length)throw Error('Unexpected recovery fixture arguments');checkProviderRecoveryFixtures();process.exit(0)}
if(mode==='--check-asset-fixtures'){if(args.length)throw Error('Unexpected asset fixture arguments');await checkAssetFixtures();process.exit(0)}
if(mode==='--check-gate-fixtures'){if(args.length)throw Error('Unexpected gate fixture arguments');checkGateFixtures();process.exit(0)}
if(mode==='--check-dispatch-fixtures'){if(args.length)throw Error('Unexpected dispatch fixture arguments');checkDispatchFixtures();process.exit(0)}
if(mode==='--check-campaign-fixture'){if(args.length)throw Error('Unexpected campaign fixture arguments');await checkCampaignFixture();process.exit(0)}
if(mode==='--check-admission-fixtures'){if(args.length)throw Error('Unexpected admission fixture arguments');await checkAdmissionFixtures();process.exit(0)}
if(mode==='--check-history-fixtures'){if(args.length)throw Error('Unexpected history-fixture arguments');await checkHistoryFixtures();process.exit(0)}
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
const prepared=await pins(),grant=await Bun.file(path.join(operator,'human-grant.json')).json(),carryover=await verifyCarryoverPin(prepared)
if(grant.carryoverRequestCount!==carryover.requestCount||grant.carryoverSdkEstimatedUsd!==carryover.sdkEstimatedUsd||grant.carryoverProviderReportedUsd!==carryover.providerReportedUsd||grant.remainingModelRequests!==carryover.remainingRequests||grant.remainingModelBudgetUsd!==carryover.remainingSdkEstimatedUsd||grant.remainingReportedInferenceCeilingUsd!==carryover.remainingProviderReportedUsd)throw Error('Frozen original authoring carryover grant differs')
if(Object.entries(scope).some(([key,value])=>grant[key]!==value)||JSON.stringify(grant.model)!==JSON.stringify(model)||grant.sourceHash!==prepared.sourceHash||JSON.stringify(grant.routing)!==JSON.stringify(routing))throw Error('Fresh bounded grant mismatch')
const profile=await Bun.file(prepared.profile.path).json()
if(profile.remote?.host!=='workstation_4090'||profile.remote?.root!=='/home/vincent/.autofold-learned-generation-validation-20261013-retry3')throw Error('Fresh authorized worker destination differs')
const readiness=await checkHost()
if(readiness.passed!==true||readiness.proteinmpnnAssetsMatched!==true||readiness.commitsMatched!==true||readiness.nativeTreesClean!==true||readiness.bubblewrapMatched!==true||!Number.isFinite(Date.parse(readiness.observedAt))||Date.now()-Date.parse(readiness.observedAt)>600000||readiness.computeReturnCode!==0||readiness.gpuComputeProcesses||readiness.workerProcesses.length||!readiness.freshRootAbsent||!Object.values(readiness.requiredPaths).every(Boolean))throw new Error('Idle bound host readiness required')
const pricing=await Bun.file(path.join(operator,'pricing-latest.json')).json()
if(pricing.passed!==true||pricing.url!==pricingURL||pricing.sdkMetadataHash!=='sha256:'+operationHash(DEFAULT_MODEL)||!Number.isFinite(Date.parse(pricing.observedAt))||Date.now()-Date.parse(pricing.observedAt)>600000||!/^pricing-response-[A-Za-z0-9-]+\.json$/.test(pricing.responseFile))throw Error('Fresh public default-route pricing proof required')
const pricingRaw=await fs.readFile(path.join(operator,pricing.responseFile),'utf8')
if(hash(pricingRaw)!==pricing.responseHash||operationHash(endpointPricing(JSON.parse(pricingRaw)))!==operationHash(pricing.endpoints))throw Error('Published pricing proof differs from its original raw response')
const modelAliasProof=pricing.modelAliasProof
if(!modelAliasProof||!/^model-metadata-response-[A-Za-z0-9-]+\.json$/.test(modelAliasProof.responseFile??'')||!Number.isFinite(Date.parse(modelAliasProof.observedAt))||Date.now()-Date.parse(modelAliasProof.observedAt)>600000)throw Error('Fresh official canonical model binding is required')
const modelAliasRaw=await fs.readFile(path.join(operator,modelAliasProof.responseFile),'utf8'),modelAlias=verifyCanonicalAliasProof(modelAliasProof,modelAliasRaw)
const credentials=await Bun.file('/Users/vincentallam/.local/share/openscience/auth.json').json()
if(typeof credentials.openrouter?.key!=='string'||!credentials.openrouter.key)throw new Error('Selected host credential unavailable')
delete process.env.OPENROUTER_API_KEY
const launchMs=Date.now(),authorizedAt=new Date(launchMs).toISOString(),deadlineMs=launchMs+grant.maximumDurationMs
await save('launch-fence.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),projectId,workspace,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,grantHash:hash(await fs.readFile(path.join(operator,'human-grant.json')))},true)
await save('host-readiness-launch-pin.json',{proof:await pin(path.join(operator,'host-readiness.json')),assetsProofHash:readiness.assetsProofHash,passed:readiness.passed},true)
await save('pricing-launch-pin.json',{proof:await pin(path.join(operator,'pricing-latest.json')),response:await pin(path.join(operator,pricing.responseFile)),responseHash:pricing.responseHash,modelMetadata:await pin(path.join(operator,modelAliasProof.responseFile)),modelAliasProof,assumptions:pricingAssumptions},true)
const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new Error('Original long-range deadline reached')),deadlineMs-Date.now())
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort(new Error('Controller interrupted; inspect only original effects')))
let app:Application|undefined,jobId:string|undefined,gateJobId:string|undefined,gateProof:any,gateValidation:any,gateNativeDescriptor:any,gateValidationAttemptId:string|undefined,gateValidationAttemptSessionId:string|undefined,activeNativeScope:{experimentId:string;sessionId:string;jobId?:string;toolCallId?:string;requestId?:string}|undefined,authoringGateActive=true,timer:ReturnType<typeof setInterval>|undefined,busy=false,count=0,stage='authoring_gate_preflight',error:unknown
const observations:Promise<unknown>[]=[],providerReceipts:any[]=[],payloadOutputSizing:number[][]=[],inferenceContexts:any[]=[],costReservations:any[]=[],providerRecoveries:any[]=[];let providerRecoveryAttempted=false;let dispatches=0,reopen=false,reopenForbiddenCalls=0
const frozenAssets:FrozenAssetInput[]=[]
const runtimeLimits={maxTurns:scope.authoringGateMaximumTurns,maxToolCalls:128,maxDurationMs:3600000}
const authorize=()=>{if(reopen)throw Error('Receipt-only reopen forbids all inference and dispatch');controller.signal.throwIfAborted();if(Date.now()>=deadlineMs)throw new Error('Original deadline expired')}
const effectiveProviderResponses=()=>providerReceipts.map(raw=>providerRecoveries.find(item=>item.requestSequence===raw.requestSequence)?.response??raw)
const providerReportedCost=()=>effectiveProviderResponses().length===count&&new Set(effectiveProviderResponses().map(r=>r.id)).size===count&&effectiveProviderResponses().every(r=>typeof r.id==='string'&&typeof r.provider==='string'&&pricing.endpoints.some((endpoint:any)=>endpoint.provider===r.provider)&&authorizedStreamModel(r.model,modelAlias)&&!r.error&&!r.identityInvalid&&!r.identityConflict&&!r.observationError&&typeof r.finishReason==='string'&&r.finishReason.length>0&&typeof r.usage?.cost==='number'&&Number.isFinite(r.usage.cost)&&r.usage.cost>=0)?effectiveProviderResponses().reduce((n,r)=>n+r.usage.cost,0):null
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
 const reservation=requestReservation(payload,pricing)
 assertAggregateInferenceAdmission({carryover,freshRequests:count,freshSdkEstimatedUsd:sdkSpent,freshProviderReportedUsd:reportedSpent,reservation})
 if(persist){const item={...reservation,requestSequence:count+1,priorSdkSpentUsd:carryover.sdkEstimatedUsd+sdkSpent,priorReportedSpentUsd:carryover.providerReportedUsd+Number(reportedSpent??0),carryoverRequestCount:carryover.requestCount,aggregateRequestSequence:carryover.requestCount+count+1,observedAt:new Date().toISOString()};costReservations.push(item);await save('cost-reservation-'+item.requestSequence+'.json',item,true)}
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
  const consume=(line:string)=>{if(!line.startsWith('data: '))return;try{const c=JSON.parse(line.slice(6));for(const k of ['id','provider','model'])if(c[k]!==undefined&&c[k]!==null){if(typeof c[k]!=='string'||c[k].length>256){metadata.identityInvalid=true;continue}if(k==='model'&&!authorizedStreamModel(c[k],modelAlias))metadata.identityInvalid=true;if(metadata[k]&&metadata[k]!==c[k]&&!(k==='model'&&authorizedStreamModel(metadata[k],modelAlias)&&authorizedStreamModel(c[k],modelAlias)))metadata.identityConflict=true;metadata[k]=c[k]}for(const finish of [c.finish_reason,c.finishReason,...(Array.isArray(c.choices)?c.choices.map((choice:any)=>choice.finish_reason):[])]){if(finish==null)continue;if(typeof finish!=='string'||!finish||finish.length>128){metadata.identityInvalid=true;continue}if(metadata.finishReason&&metadata.finishReason!==finish)metadata.identityConflict=true;metadata.finishReason=finish}if(c.error)metadata.error={classification:'router_stream_error',message:'Original stream returned an error; billing requires original evidence'};if(c.usage&&typeof c.usage==='object'){metadata.usage??={};for(const key of ['cost','prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens'])if(typeof c.usage[key]==='number'&&Number.isFinite(c.usage[key]))metadata.usage[key]=c.usage[key]}}catch{}}
  try{for(;;){const v=await reader.read();if(v.done)break;pending+=decoder.decode(v.value,{stream:true});let i;while((i=pending.indexOf('\n'))>=0){consume(pending.slice(0,i));pending=pending.slice(i+1)}}consume(pending)}catch(e){metadata.observationError='original_stream_read_failed'}finally{reader.releaseLock()}
  const receipt={...metadata,observedAt:new Date().toISOString()};providerReceipts.push(receipt);await save('provider-response-'+sequence+'.json',receipt,true)
 })();observations.push(observation);return response
},{preconnect:fetch.preconnect})
async function recoverFinalOriginalProviderUsage(){
 if(providerRecoveryAttempted)return
 providerRecoveryAttempted=true
 const snapshot=await persistedSessions()
 const identities=async(sessions:Awaited<ReturnType<typeof persistedSessions>>)=>{const state=app?await app.store.read(projectId):undefined;return {providerModelRequestCount:count,sessionIds:sessions.sessions.map(session=>session.id).sort(),modelRequestIds:sessions.sessions.flatMap(session=>Object.keys(session.modelRequests??{}).map(id=>session.id+':'+id)).sort(),toolStartEvents:sessions.journal.filter(event=>event.type==='tool_execution_start').map(event=>event.sessionId+':'+event.sequence).sort(),jobs:state?Object.keys(state.jobs).sort():[],trials:state?Object.keys(state.trials).sort():[],runs:state?Object.keys(state.runs).sort():[],operations:state?Object.keys(state.operations).sort():[],effectOutbox:state?Object.values(state.operationOutbox).filter(item=>item.purpose==='effect').map(item=>item.id).sort():[]}}
 const before=await identities(snapshot)
 if(snapshot.leases.length||snapshot.sessions.some(session=>session.status==='running'))throw Error('Final-only provider receipt settlement requires idle original sessions and no owners')
 const storeFile=path.join(workspace,'.autofold/pi',projectId,'sessions.sqlite')
 if(!await Bun.file(storeFile).exists()){await save('provider-recovery-audit.json',{outcomes:[],recoveries:[],modelRequestsReissued:0,partialToolCallsExecuted:0,sessionResumes:0,noOriginalSessionArchive:true},true);return}
 const store=createSessionStore(storeFile)
 const deny=()=>{throw Error('Final original billing lookup forbids inference, session resume and tool execution')}
 const outcomes=[]
 try{
  for(const session of snapshot.sessions)for(const [requestId,request] of Object.entries(session.modelRequests??{})){
   if(request.status==='not_dispatched'||request.providerBilling?.status==='reported')continue
   const upstreamId=request.providerBilling?.upstreamRequestId,raw=providerReceipts.find(item=>item.id===upstreamId)
   if(request.modelBinding?.canonicalModelId!==modelAlias.canonicalModelId||request.modelBinding?.requestedModelId!==modelAlias.requestedModelId||!raw||!upstreamId||request.model.provider!=='openrouter'||!request.providerBilling?.routedProvider||!request.modelBinding){outcomes.push({sessionId:session.id,requestId,status:'held_original_identity_unavailable'});continue}
   let captured:any
   const receiptFetch=Object.assign(async(url:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
    const parsed=new URL(String(url))
    if(parsed.origin!=='https://openrouter.ai'||parsed.pathname!=='/api/v1/generation'||parsed.searchParams.get('id')!==upstreamId||init?.method!=='GET')throw Error('Only the exact original generation lookup is authorized')
    const response=await fetch(url,init),body=await response.clone().text(),file='provider-generation-'+session.id+'-'+requestId+'.json'
    await fs.writeFile(path.join(operator,file),body,{flag:'wx',mode:0o600})
    captured={file,contentHash:hash(body),httpStatus:response.status,body:JSON.parse(body)};return response
   },{preconnect:fetch.preconnect})
   const runtime=new PiRuntime({store,openRouterModelAliases:modelAlias.mapping,streamFn:deny,getApiKey:provider=>provider==='openrouter'?credentials.openrouter.key:undefined,authorizeModelRequest:deny,openRouterGenerationFetch:receiptFetch})
   try{
    const settled=await runtime.reconcileOpenRouterModelUsage(session.id,requestId),updated=settled.modelRequests![requestId]!
    const response=verifyRecoveryObservation({sessionId:session.id,requestId,original:request,updated,raw,captured})
    const proof={sessionId:session.id,requestId,requestSequence:raw.requestSequence,originalStreamFile:'provider-response-'+raw.requestSequence+'.json',originalStreamContentHash:hash(await fs.readFile(path.join(operator,'provider-response-'+raw.requestSequence+'.json'))),lookupFile:captured.file,lookupContentHash:captured.contentHash,usageEvidence:updated.usageEvidence,delivery:updated.delivery,response,verified:true}
    providerRecoveries.push(proof);outcomes.push({sessionId:session.id,requestId,status:'verified_final_billing_only',requestSequence:raw.requestSequence})
    await save('provider-recovery-'+session.id+'-'+requestId+'.json',proof,true)
   }catch(error){outcomes.push({sessionId:session.id,requestId,status:'held_unverified_original_receipt',error:error instanceof Error?error.message:String(error)});await save('provider-recovery-error-'+session.id+'-'+requestId+'.json',outcomes.at(-1),true)}
  }
 }finally{store.close()}
 const after=await identities(await persistedSessions()),noNewEffects=operationHash(before)===operationHash(after)
 await save('provider-recovery-audit.json',{outcomes,recoveries:providerRecoveries,before,after,noNewEffects,modelRequestsReissued:after.providerModelRequestCount-before.providerModelRequestCount,partialToolCallsExecuted:0,sessionResumes:0,authority:'Explicit terminal-only settlement of exact original provider billing; failed delivery and original stream observations remain preserved.'},true)
 if(!noNewEffects)throw Error('Final receipt recovery changed scientific/model/tool effect identities')
}
function auditFollowupMemoryProof(input:{followup:any;state:any;sessions:{journal:any[]};parents:any[];parentRuns:any[];inferenceContexts:any[];temperature:number;requestId:string;toolCallId?:string}){
 const {followup,state,sessions,parents,parentRuns,inferenceContexts,temperature,requestId,toolCallId}=input
  const exposure=followup.decisionMemoryExposure,sessionId=String(state.jobs[followup.origin?.jobId??'']?.payload.sessionId??''),trace=sessions.journal.filter((event:any)=>event.sessionId===sessionId)
  const run:any=Object.values(state.runs).find((item:any)=>item.trialId===followup.id)
  const start:any=trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName==='evaluate_trial'&&event.data?.args?.requestId===requestId&&(!toolCallId||event.data?.toolCallId===toolCallId))
  const assistant:any=start&&trace.findLast((event:any)=>event.sequence<start.sequence&&event.type==='message_end'&&event.data?.message?.role==='assistant'&&event.data.message.content.some((part:any)=>part.type==='toolCall'&&part.id===start.data.toolCallId&&part.name==='evaluate_trial'))
  const settled:any=assistant&&trace.findLast((event:any)=>event.sequence<assistant.sequence&&event.type==='model_request_settled')
  const inference=settled&&inferenceContexts.find(context=>context.sessionId===sessionId&&context.requestId===settled.data?.requestId&&context.settledSequence===settled.sequence)
  const delivered=exposure&&inference?.packets.find((item:any)=>item.packetHash===exposure.packetHash&&'sha256:'+operationHash(item.packet)===exposure.packetHash&&item.manifestVerification.status==='verified'&&item.manifestVerification.manifestHash===exposure.manifestHash&&item.manifestVerification.snapshotHash===exposure.snapshotHash&&item.packet.sourceManifest.manifestHash===exposure.manifestHash&&item.packet.sourceManifest.snapshotHash===exposure.snapshotHash&&operationHash(item.packet.sourceManifest.scope)===operationHash(exposure.scope)&&parentRuns.every(parent=>parent&&item.packet.facts.some((fact:any)=>fact.runId===parent.id&&fact.receiptStatus==='verified'&&fact.receiptHash===parent.manifestHash)))
  const latest:any=start&&trace.filter((event:any)=>event.type==='model_request_settled'&&event.sequence<start.sequence).at(-1)
  const currentExperiment=state.experiments[followup.experimentId],memoryDeliveryBound=!!delivered&&!!exposure&&exposure.sessionId===sessionId&&inference?.sessionId===exposure.sessionId&&latest?.data?.requestId===inference?.requestId&&exposure.scope.projectId===projectId&&exposure.scope.experimentId===followup.experimentId&&exposure.scope.campaignId===currentExperiment?.campaignId
  const citedParents=parentRuns.filter(parent=>parent&&[...followup.evidenceRefs??[],...followup.decisionPlan?.evidenceRefs??[]].includes(parent.id)&&exposure?.citedSources.some((source:any)=>source.id===parent.id))
  const declarationBound=!!exposure&&exposure.decisionHash==='sha256:'+operationHash({decisionPlan:followup.decisionPlan,evidenceRefs:followup.evidenceRefs})
  const parentsPrecedeFollowup=parentRuns.length===2&&parentRuns.every(parent=>parent&&Number.isFinite(Date.parse(parent.completedAt!))&&Date.parse(parent.completedAt!)<Date.parse(followup.createdAt))
  const temperatureDeclaration=!!followup.decisionPlan?.changedVariables?.some((variable:any)=>/temperature/i.test(variable))&&!!followup.prediction&&parents.some(parent=>parent.id===followup.prediction?.comparatorTrialId)&&followup.prediction.metric==='locked_score'&&['lower','higher'].includes(followup.prediction.relation)
  const temperatureProtocolBound=[0.05,0.2].includes(temperature)
  return {trialId:followup.id,runId:run?.id,sessionId,evaluateToolCallId:start?.data?.toolCallId,assistantSequence:assistant?.sequence,settledSequence:settled?.sequence,inferenceRequestId:inference?.requestId,transcriptHash:inference?.transcriptHash,packetHash:delivered?.packetHash,manifestVerification:delivered?.manifestVerification,parentsPrecedeFollowup,parentRunIds:parentRuns.map(item=>item?.id),exposure,memoryDeliveryBound,citedParentRunIds:citedParents.map(item=>item!.id),declarationBound,temperatureDeclaration,actualTemperature:temperature,
   passed:parentsPrecedeFollowup&&memoryDeliveryBound&&citedParents.length>0&&declarationBound&&temperatureDeclaration&&temperatureProtocolBound&&temperature!==0.1,
   interpretation:'Each followup is bound to the exact evaluate call and preceding settled model response, full delivered packet containing both verified parents, prospective citation and actual temperature intervention. This feedback trace is not causal improvement evidence.'}
}
async function assertScopedNativeAdmission(input:{trialId:string;contractHash:string;descriptor:any;programHash?:string;bundleGenerationSeed?:number}){
 const state=await app!.store.read(projectId),trial=input.trialId==='trl_preflight'?undefined:state.trials[input.trialId]
 const scope=input.trialId==='trl_preflight'?activeNativeScope:trial?{experimentId:trial.experimentId,sessionId:String(state.jobs[trial.origin?.jobId??'']?.payload.sessionId??'')}:undefined
 if(!scope||!scope.sessionId)throw Error('Native validation requires its actual bound scientist/trial scope')
 const experiment=state.experiments[scope.experimentId],expectedExperimentId=gateProof?.experimentId??frozenAssets[0]?.experimentId
 if(!experiment||experiment.id!==expectedExperimentId||experiment.piScientistSessionId!==scope.sessionId||input.contractHash!==prepared.contractHash||experiment.contractHash!==prepared.contractHash)throw Error('Native admission scope differs from the frozen experiment/scientist contract')
 const ordinary=Object.values(state.trials).filter(trial=>trial.experimentId===experiment.id&&trial.intent!=='shadow_replay').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)),ordinal=trial?ordinary.findIndex(item=>item.id===trial.id)+1:ordinary.length+1,seed=deriveGenerationSeed(projectId,experiment.id,scope.sessionId,ordinal)
 if(trial&&(trial.generationSeed!==seed||input.programHash!==undefined&&input.programHash!==trial.programHash)||input.bundleGenerationSeed!==undefined&&input.bundleGenerationSeed!==seed)throw Error('Actual frozen trial/bundle generation seed or authored source differs from its bound slot')
 assertNativeRoleScope({experimentId:scope.experimentId,sessionId:scope.sessionId,contractHash:input.contractHash,generationSeed:input.bundleGenerationSeed??trial?.generationSeed??seed},{experimentId:expectedExperimentId!,sessionId:experiment.piScientistSessionId!,contractHash:prepared.contractHash,generationSeed:seed})
 const bootstrap=await Bun.file(path.join(operator,'bootstrap.json')).json(),target=await ResearchArtifacts.readTarget(workspace,experiment.contract.targetArtifactHash),contents=await Bun.file(path.join(workspace,target.targetArtifactPath)).json()
 assertBootstrapPolicy(input.descriptor,bootstrap.provenance.backboneHash);assertGateSearchPolicy(input.descriptor,300,contents.chains[0].sequence,seed,ordinal)
 if(!authoringGateActive&&trial&&ordinal>=3){
  if(activeNativeScope?.experimentId!==trial.experimentId||activeNativeScope.sessionId!==scope.sessionId||activeNativeScope.jobId!==trial.origin?.jobId||!activeNativeScope.requestId||!activeNativeScope.toolCallId)throw Error('Followup native admission lacks its exact active evaluate tool binding')
  const parents=ordinary.slice(0,2),parentRuns=parents.map(parent=>Object.values(state.runs).find(run=>run.trialId===parent.id&&run.status==='succeeded')),proof=auditFollowupMemoryProof({followup:trial,state,sessions:await persistedSessions(),parents,parentRuns,inferenceContexts,temperature:input.descriptor.projection[0].stages[0].generators[0].config.temperature,requestId:activeNativeScope.requestId,toolCallId:activeNativeScope.toolCallId})
  if(!proof.passed)throw Error('Followup must bind actual delivered first-two evidence and a prospective temperature intervention before GPU')
  await save('pre-dispatch-memory-'+trial.id+'-'+crypto.randomUUID()+'.json',proof,true)
 }
 if(!authoringGateActive&&ordinal===1){if(!gateProof)throw Error('First native slot lacks its successful live authoring gate');if(trial)assertFirstExecutionBinding(gateProof,{programHash:trial.programHash,contractHash:input.contractHash,generationSeed:trial.generationSeed!,nativeProgramSeed:input.descriptor.projection[0].programSeed,experimentId:experiment.id,sessionId:scope.sessionId});else if(seed!==gateProof.generationSeed)throw Error('Prospective first-slot seed differs from live authoring gate')}
}
async function authoringNoEmpiricalSnapshot(){
 const state=await app!.store.read(projectId),sessions=await persistedSessions(),runDirectory=path.join(workspace,'.autofold/runs'),launches=[]
 if(await fs.stat(runDirectory).then(value=>value.isDirectory(),()=>false))for(const entry of await fs.readdir(runDirectory,{withFileTypes:true})){if(entry.isDirectory()&&await Bun.file(path.join(runDirectory,entry.name,'remote-launch-attempt.json')).exists())launches.push(entry.name)}
 return {trialIds:Object.keys(state.trials),runIds:Object.keys(state.runs),originalLaunchRunIds:launches,scientificEvaluationToolStarts:sessions.journal.filter(event=>event.type==='tool_execution_start'&&['evaluate_trial','submit_trial'].includes((event.data as any)?.toolName)).map(event=>({sessionId:event.sessionId,sequence:event.sequence})),leases:sessions.leases,sessions:sessions.sessions.map(session=>({id:session.id,status:session.status,pendingToolCount:Object.keys(session.pendingTools??{}).length})),validatedBranchIds:Object.keys(state.experimentBranches),authority:'Branch/file/validator artifacts are legitimate authoring evidence; zero empirical trials/runs/launches and forbidden evaluation invocations are required.'}
}
function noEmpiricalEffects(snapshot:any){return Array.isArray(snapshot.trialIds)&&snapshot.trialIds.length===0&&snapshot.runIds.length===0&&snapshot.originalLaunchRunIds.length===0&&snapshot.scientificEvaluationToolStarts.length===0}
async function proveLiveAuthoringGate(originalJobId:string,experimentId:string){
 const state=await app!.store.read(projectId),sessions=await persistedSessions(),job=state.jobs[originalJobId]!,sessionId=String(job.payload.sessionId),trace=sessions.journal.filter(event=>event.sessionId===sessionId),receipt=gateValidation?.receipt
 const details=(event:any)=>event.data?.result?.details??event.data?.result
 const successful=(event:any,name:string)=>event.type==='tool_execution_end'&&event.data?.toolName===name&&!event.data?.isError
 const end:any=trace.find(event=>successful(event,'validate_trial')&&(event.data as any)?.toolCallId===gateValidation?.toolCallId&&details(event)?.valid===true&&details(event)?.programHash===receipt?.programHash)
 const start:any=end&&trace.find(event=>event.type==='tool_execution_start'&&(event.data as any)?.toolCallId===end.data.toolCallId&&event.sequence<end.sequence)
 const author:any=start&&trace.filter(event=>['write','edit','write_file','edit_file'].some(name=>successful(event,name))&&details(event)?.programHash===receipt.programHash&&event.sequence<start.sequence).at(-1)
 const branch=receipt&&state.experimentBranches[receipt.branchId],experiment=state.experiments[experimentId]!,programPath=branch?.draftPath,programFile=typeof programPath==='string'&&programPath.startsWith('.autofold/autoresearch/'+experimentId+'/')?await checkedPath(workspace,programPath):undefined,fileHash=programFile?hash(await fs.readFile(programFile)):undefined
 const generationSeed=deriveGenerationSeed(projectId,experimentId,sessionId,1),effects=await authoringNoEmpiricalSnapshot(),requests=sessions.sessions.flatMap(session=>Object.values(session.modelRequests??{})).filter(request=>request.status!=='not_dispatched')
 const programBound=!!programFile&&receipt.programPath===programPath&&fileHash===receipt?.programHash&&branch?.programHash===receipt?.programHash&&ExperimentBranches.hash(branch.program)===receipt.programHash&&branch.experimentId===experimentId&&branch.contractHash===prepared.contractHash
 const authorBound=!!author&&!!start&&await auditAuthoredProgram(trace,author,receipt.programHash,start.sequence,details(author)?.path)
 const validatorBound=!!end&&!!start&&!!gateValidation&&gateValidation.jobId===originalJobId&&gateValidation.sessionId===sessionId&&receipt.contractHash===prepared.contractHash&&receipt.declaration?.generationSeed===generationSeed&&operationHash(details(end))===operationHash(receipt)
 let prospectiveAdmissionBound=false,prospectiveAdmissionError:string|undefined
 try{if(!receipt)throw Error('No successful host validation receipt');validateScientificMethodology({state,experiment,profile:'managed_strict',evaluation:true,declaration:receipt.declaration});prospectiveAdmissionBound=true}catch(error){prospectiveAdmissionError=error instanceof Error?error.message:String(error)}
 const nativeBound=!!gateValidation?.nativeDescriptor&&gateValidation.nativeDescriptor.projection[0]?.programSeed===generationSeed
 if(nativeBound)assertGateSearchPolicy(gateValidation.nativeDescriptor)
 const accountingKnown=carryover.sdkEstimatedUsd+sessions.sessions.reduce((total,session)=>total+session.usage.costUsd,0)<=grant.modelBudgetUsd&&providerReportedCost()!==null&&carryover.providerReportedUsd+Number(providerReportedCost())<=grant.reportedInferenceCeilingUsd&&requests.length>0&&requests.every(request=>request.status==='settled'&&request.costKind==='sdk_estimate'&&request.delivery?.status==='completed'&&request.providerBilling?.status==='reported')&&providerReportedCost()!==null
 const effectsAbsent=noEmpiricalEffects(effects)&&effects.leases.length===0&&effects.sessions.every((session:any)=>session.status!=='running'&&session.pendingToolCount===0)
 const jobBound=job.status==='succeeded'&&!job.leaseId&&job.payload.conversation===true&&job.payload.allowCompute===false&&job.payload.experimentId===experimentId&&job.payload.contractHash===prepared.contractHash&&experiment.piScientistSessionId===sessionId
 const checks={programBound,authorBound,validatorBound,nativeBound,prospectiveAdmissionBound,accountingKnown,effectsAbsent,jobBound},proof={format:'autofold.live-authoring-only-gate.v1',passed:Object.values(checks).every(Boolean),checks,observedAt:new Date().toISOString(),workspace,projectId,experimentId,contractHash:prepared.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,driverHash:prepared.driver.contentHash,jobId:originalJobId,sessionId,generationSeed,programHash:receipt?.programHash,validatedProgramPath:programPath,branchId:branch?.id,validatorToolCallId:end?.data?.toolCallId,validatorStartSequence:start?.sequence,validatorEndSequence:end?.sequence,authorToolCallId:author?.data?.toolCallId,authorSequence:author?.sequence,validatorReceipt:receipt,prospectiveAdmissionError,validatorReceiptHash:receipt?'sha256:'+operationHash(receipt):undefined,nativeDescriptorHash:gateValidation?.nativeDescriptor?'sha256:'+operationHash(gateValidation.nativeDescriptor):undefined,effects,sdkEstimatedInferenceUsd:sessions.sessions.reduce((total,session)=>total+session.usage.costUsd,0),providerReportedInferenceUsd:providerReportedCost(),providerRequests:count,authority:'Actual Pi-authored source and actual contained host validator receipt plus shared prospective admission. No scientific evaluation receipt is created or reused.'}
 if(!proof.passed){await save('live-authoring-gate-failed.json',proof,true);throw Error('Live authoring-only proof failed; no GPU launch is permitted')}
 return proof
}
async function verifyAuthoringGatePins(){
 if(!gateProof?.passed)throw Error('Original successful authoring gate is required')
 const proofPin=await Bun.file(path.join(operator,'live-authoring-gate-pin.json')).json(),raw=await fs.readFile(proofPin.path)
 if(proofPin.path!==path.join(operator,'live-authoring-gate.json')||hash(raw)!==proofPin.contentHash||operationHash(JSON.parse(raw.toString('utf8')))!==operationHash(gateProof)||gateProof.workspace!==workspace||gateProof.projectId!==projectId||gateProof.contractHash!==prepared.contractHash||gateProof.sourceHash!==prepared.sourceHash||gateProof.workerHash!==prepared.workerHash||gateProof.driverHash!==hash(await fs.readFile(import.meta.path)))throw Error('Original live authoring gate source/workspace/proof pins changed')
 await pins();return true
}
async function bindOriginalJob(state:Awaited<ReturnType<Application['store']['read']>>){if(jobId)return;const originals=Object.values(state.jobs).filter(j=>j.payload.kind==='campaign_loop');if(originals.length===1)jobId=originals[0]!.id;else if(originals.length>1)throw Error('Ambiguous original acceptance job identity')}
const observe=async()=>{if(!app||busy)return;busy=true;try{const state=await app.store.read(projectId);await bindOriginalJob(state);dispatches=0;for(const run of Object.values(state.runs))if(await Bun.file(path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json')).exists())dispatches++;const snapshot={stage,observedAt:new Date().toISOString(),jobId:jobId??Object.values(state.jobs).find(j=>j.payload.kind==='autoresearch')?.id,jobs:Object.values(state.jobs).map(j=>({id:j.id,kind:j.payload.kind,status:j.status,cost:j.result?.modelCostUsd})),trials:Object.values(state.trials).map(t=>({id:t.id,status:t.status})),runs:Object.values(state.runs).map(r=>({id:r.id,status:r.status})),operations:await app.operationDiagnostics(),providerRequests:count,aggregateProviderRequests:carryover.requestCount+count,carryoverSdkEstimatedUsd:carryover.sdkEstimatedUsd,carryoverProviderReportedUsd:carryover.providerReportedUsd,originalDispatches:dispatches,providerReportedCostUsd:providerReportedCost(),canonicalCostSemantics:'sdk_static_price_estimate',actualProviders:[...new Set(providerReceipts.map(r=>r.provider).filter(Boolean))]};await save('monitor-latest.json',snapshot);console.log(JSON.stringify(snapshot))}catch(e){console.error(JSON.stringify({type:'observation_error',message:String(e)}))}finally{busy=false}}
try{
 const config=(await loadExecutionConfig(prepared.profile.path))!
 const originalTransport=config.transport!
 const gatedTransport={kind:originalTransport.kind,snapshotProfile:()=>originalTransport.snapshotProfile?.(),preflight:originalTransport.preflight?.bind(originalTransport),capabilities:originalTransport.capabilities?.bind(originalTransport),validateGeneratorSpecs:originalTransport.validateGeneratorSpecs?.bind(originalTransport),dispatch:async(input:Parameters<typeof originalTransport.dispatch>[0])=>{if(authoringGateActive||!gateProof)throw Error('Scientific dispatch requires the passed live authoring gate');await verifyAuthoringGatePins();const state=await app!.store.read(projectId),run=state.runs[input.runId];if(!run)throw Error('Original scientific run is missing at dispatch');const bundle=await Bun.file(input.bundlePath).json();await assertScopedNativeAdmission({trialId:run.trialId,contractHash:bundle.contractHash,descriptor:bundle.nativeExecution?.descriptor,programHash:bundle.programHash,bundleGenerationSeed:bundle.generationSeed});return originalTransport.dispatch(input)},reconcile:async(input:Parameters<NonNullable<typeof originalTransport.reconcile>>[0])=>{if(authoringGateActive||!gateProof)throw Error('Authoring-only gate cannot reconcile or launch scientific execution');if(!originalTransport.reconcile)throw Error('Original transport has no receipt reconciliation');return originalTransport.reconcile(input)}}
 app=new Application({workspace,projectId,execution:{...config,transport:gatedTransport,frozenAssets,authorization:{...config.authorization,deadlineMs,authorize:input=>{authorize();if(authoringGateActive&&input.trialId!=='trl_preflight')throw Error('Authoring gate permits contained construction only')},authorizeNative:async input=>{authorize();await assertScopedNativeAdmission(input);if(authoringGateActive)gateNativeDescriptor={toolCallId:gateValidationAttemptId,descriptor:input.descriptor}}}},jobs:{scientistFactory:options=>{
  const lane=new ScientistLane(options)
  return {systemPrompt:lane.systemPrompt,initialize:()=>lane.initialize(),status:()=>lane.status(),context:()=>lane.context(),resources:()=>lane.resources(),tools:()=>{
   const tools=lane.tools().map(tool=>['validate_trial','evaluate_trial'].includes(tool.name)?{...tool,execute:async(id:any,args:any,signal:any,onUpdate:any)=>{activeNativeScope={experimentId:options.experimentId,sessionId:options.sessionId,jobId:options.origin?.jobId,toolCallId:id,requestId:args?.requestId};return tool.execute(id,args,signal,onUpdate)}}:tool);if(!authoringGateActive)return tools
   return tools.filter(tool=>!authoringEffectTool(tool.name)).map(tool=>tool.name!=='validate_trial'?tool:{...tool,execute:async(id,args,signal,onUpdate)=>{
    gateValidationAttemptId=id;gateValidationAttemptSessionId=options.sessionId;gateNativeDescriptor=undefined
    const result=await tool.execute(id,args,signal,onUpdate),receipt=result.details
    return gateValidatorDelivery(result,async()=>{
     const state=await app!.store.read(projectId),experiment=state.experiments[options.experimentId]!
     validateScientificMethodology({state,experiment,profile:'managed_strict',evaluation:true,declaration:receipt.declaration})
     if(gateNativeDescriptor?.toolCallId!==id)throw Error('Successful validation lacks its exact compiled native descriptor')
     gateValidation={nativeDescriptor:gateNativeDescriptor.descriptor,toolCallId:id,sessionId:options.sessionId,jobId:options.origin?.jobId,receipt}
    })
   }})
  }}
 },runtimeOptions:{
  authorizeToolCall:async request=>{if(authoringGateActive&&authoringEffectTool(request.toolName))throw Error('Live authoring gate forbids empirical/scientific effect tools');if(!authoringGateActive&&request.toolName==='evaluate_trial'){await verifyAuthoringGatePins();const state=await app!.store.read(projectId);if(Object.values(state.trials).filter(trial=>trial.intent!=='shadow_replay').length===0){const supplied=(request.args as any)?.programPath??'trial.py',resolved=path.relative(workspace,path.resolve(workspace,typeof supplied==='string'&&(supplied.startsWith('.autofold/')||path.isAbsolute(supplied))?supplied:path.join('.autofold/autoresearch',gateProof.experimentId,String(supplied)))).split(path.sep).join('/');if(resolved!==gateProof.validatedProgramPath||hash(await fs.readFile(await checkedPath(workspace,resolved)))!==gateProof.programHash)throw Error('First discovery slot must use the exact live-validated authored draft')}}},
  openRouterModelAliases:modelAlias.mapping,getApiKey:p=>p==='openrouter'?credentials.openrouter.key:undefined,authorizeModelRequest:authorize,requireProviderReportedUsage:true,
  onInferenceContext:recordInferenceContext,limits:runtimeLimits,
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
 await app.store.mutate(projectId,state=>{state.campaignCharters[campaign.id]!.constraints.maximumCampaignTrials=4;state.campaignCharters[campaign.id]!.constraints.maximumCampaignGpuHours=4*contract.budget.gpuHours})
 const bootstrap=await Bun.file(path.join(operator,'bootstrap.json')).json()
 frozenAssets.push({experimentId:experiment.id,id:bootstrapAssetId,path:path.relative(workspace,bootstrap.reference.path),contentHash:bootstrap.provenance.backboneHash,nativeBindings:[bootstrapNativeBinding]})
 await save('frozen-asset-policy.json',{assets:frozenAssets,preGpuPolicy:'Exact host-frozen asset native binding plus operator constructor policy at admission and authorizeStart; no transcription or byte normalization'},true)
 for(const entry of [bootstrap.reference,bootstrap.recipe]){const destination=path.join(workspace,'.autofold/autoresearch',experiment.id,'references/bootstrap',path.basename(entry.path));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});const raw=await fs.readFile(entry.path);if(hash(raw)!==entry.contentHash)throw Error('Frozen procedural bootstrap differs');await fs.writeFile(destination,raw,{flag:'wx',mode:0o400})}
 await app.skills.initialize(campaign.id)
 await pins()
 const gateJob=await app.jobs.enqueueDiscovery(experiment.id,{idempotencyKey:'fresh-live-authoring-gate-20261013-retry3',iterations:1,conversation:true,allowCompute:false,modelBudgetUsd:grant.remainingModelBudgetUsd,maximumDurationMs:Math.max(1,deadlineMs-Date.now()),modelSelection:model,prompt:authoringGatePrompt+' Frozen current experiment setup reference: '+experiment.id+'. Your working authoring path is trial.py in this experiment workspace.'})
 gateJobId=gateJob.id;jobId=gateJobId
 await save('authoring-gate-job.json',{jobId:gateJobId,experimentId:experiment.id,sessionId:gateJob.payload.sessionId,contractHash:experiment.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,driverHash:prepared.driver.contentHash,phase:'authoring_only',allowCompute:false},true)
 stage='live_authoring_only_gate';await observe();timer=setInterval(()=>void observe(),30000)
 await app.jobs.runOnce({jobId:gateJobId,signal:controller.signal})
 await Promise.all(observations);await pins();gateProof=await proveLiveAuthoringGate(gateJobId,experiment.id)
 await save('live-authoring-gate.json',gateProof,true);await save('live-authoring-gate-pin.json',await pin(path.join(operator,'live-authoring-gate.json')),true)
 console.log(JSON.stringify({type:'live_authoring_gate_passed',gate:gateProof,scientificTrials:0,scientificRuns:0,originalGpuDispatches:0}))
 if(!gateProof.passed)throw Error('Live authoring-only gate failed; GPU dispatch remains disabled')
 authoringGateActive=false;runtimeLimits.maxTurns=64;stage='passed_authoring_gate_gpu_campaign'
 await verifyAuthoringGatePins();await app.execution.preflightExperiment(await app.experiment(experiment.id),controller.signal)
 const remainingModelBudgetUsd=grant.modelBudgetUsd-carryover.sdkEstimatedUsd-gateProof.sdkEstimatedInferenceUsd
 if(!(remainingModelBudgetUsd>0))throw Error('Authoring gate exhausted the shared model budget')
 const job=await app.campaign.enqueueCampaign(campaign.id,{idempotencyKey:'fresh-learned-generation-validation-20261013-retry3',experimentId:experiment.id,maxSteps:2,maximumTrajectories:4,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:0,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:remainingModelBudgetUsd,perChildModelBudgetUsd:remainingModelBudgetUsd,maximumDurationMs:Math.max(1,deadlineMs-Date.now()),modelSelection:model})
 jobId=job.id
 await save('authorization.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),workspace,projectId,campaignId:campaign.id,experimentId:experiment.id,jobId,contractHash:experiment.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,limits:grant,controlledFault:false,operatorAuthoredScience:false},true)
 await save('original-job-identity.json',{jobId,sessionId:job.payload.sessionId,campaignId:campaign.id,experimentId:experiment.id},true)
 stage='native_cohesive_engine_campaign';await observe()
 await app.jobs.runOnce({jobId,signal:controller.signal})
 await Promise.all(observations);await pins();await recoverFinalOriginalProviderUsage()
 let state=await app.store.read(projectId)
 await save('campaign-result.json',await app.jobs.get(jobId),true)
 if(Object.keys(state.trials).length>4||Object.keys(state.runs).length>4||Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length>4||Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length>0)throw new Error('Fresh trial grant exceeded')
 const attempts=[];for(const run of Object.values(state.runs)){const file=path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json');if(await Bun.file(file).exists())attempts.push(await originalDispatchBinding(run))}dispatches=attempts.length;if(dispatches>4)throw Error('Original launch attempt grant exceeded');await save('original-dispatch-records.json',attempts,true)
 const trialBudgetChecks=[];for(const run of Object.values(state.runs)){const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json(),planFile=path.join(workspace,path.dirname(run.bundlePath),'remote-plan.identity.json'),plan=await Bun.file(planFile).exists()?await Bun.file(planFile).json():undefined;trialBudgetChecks.push({runId:run.id,reservedComputeSeconds:bundle.nativeExecution?.resources?.maximumComputeReservationSeconds,passed:verifyBundledBootstrap(bundle,(await Bun.file(path.join(operator,'bootstrap.json')).json()).provenance.backboneHash)&&bundle.candidateBudget===1&&bundle.submissionSize===1&&JSON.stringify(bundle.seeds)==='[20260809]'&&bundle.nativeExecution?.observation==='scoped_native_lifecycle_v1'&&bundle.nativeExecution.resources.maximumSearchWallSeconds===300&&bundle.nativeExecution.resources.reservedSearchComputeSeconds===300&&bundle.nativeExecution.resources.reservedEvaluationComputeSeconds===300&&bundle.nativeExecution.resources.maximumComputeReservationSeconds===600&&bundle.contractHash===prepared.contractHash&&bundle.targetArtifactHash===contract.targetArtifactHash&&bundle.evaluator?.id===contract.evaluator.id&&bundle.evaluator?.version===contract.evaluator.version&&(!plan||Number.isFinite(plan.timeoutMs)&&plan.timeoutMs>0&&plan.timeoutMs<=15*60000&&Number.isFinite(plan.authorizationDeadlineMs)&&plan.authorizationDeadlineMs<=deadlineMs)})}
 let sessions=await persistedSessions();for(const session of sessions.sessions)assertSessionAccountingComplete(session)
 await save('sessions.json',sessions.sessions,true);await save('pi-events.json',sessions.journal,true)
 const receipts=[],failedReceipts=[],learnedSearchChecks=[],generationSeedChecks=[]
 const ordinaryOrder=Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt))
 const targetArtifact=await ResearchArtifacts.readTarget(workspace,contract.targetArtifactHash)
 const targetContents=await Bun.file(path.join(workspace,targetArtifact.targetArtifactPath)).json()
 const targetSequence=targetContents.chains[0]?.sequence
 if(typeof targetSequence!=='string'||!targetSequence.length)throw Error('Frozen full target chain differs')
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
  const native=await Bun.file(nativeFile).json(),generationIndex=await Bun.file(path.join(workspace,run.outputPath,'generation-runs/index.json')).json(),ordinal=ordinaryOrder.findIndex(item=>item.id===trial.id)+1
  learnedSearchChecks.push(auditLearnedReceipt({native,run,trial,targetSequence,ordinal,bootstrap,generationSeed,generationArtifacts,generationIndex,nativeArtifactHash:receipt.nativeSearch.artifactHash}))
  receipts.push({runId:run.id,trialId:trial.id,intent:trial.intent,manifestHash:run.manifestHash,valid:receipt.evaluation.valid,score:receipt.evaluation.score,scientific:receipt.scientific,workerHash:receipt.worker?.sourceHash,wallSeconds:(Date.parse(run.completedAt!)-Date.parse(run.startedAt!))/1000})
 }
 await save('learned-search-audit.json',{passed:learnedSearchChecks.length===4&&learnedSearchChecks.every(item=>item.passed),checks:learnedSearchChecks,
  authority:'Hash-verified native-search receipt and frozen admission, not the final model-runs index',biologicalValidationEstablished:false},true)
 const generationRandomnessVerified=generationSeedChecks.length===4&&generationSeedChecks.every(item=>item.passed)&&new Set(generationSeedChecks.map(item=>item.generationSeed)).size===4&&learnedSearchChecks.every(item=>item.seedRolesBound)&&new Set(learnedSearchChecks.map(item=>item.calls.find((call:any)=>call.tool==='proteinmpnn-sample')?.configSeed)).size===4&&new Set(learnedSearchChecks.map(item=>item.calls.find((call:any)=>call.tool==='boltz2-prediction')?.configHash)).size===1
 await save('generation-seed-audit.json',{passed:generationRandomnessVerified,checks:generationSeedChecks,
  interpretation:'For this validation, each authored Program uses its immutable host slot seed. Four different slot seeds do not establish statistically independent benchmarks or biological improvement. Both evaluator seeds remain fixed; deterministic repetition remains possible by explicit declaration in other programs.'},true)
 const responses=effectiveProviderResponses()
 const providerCost=providerReportedCost(),sessionCost=sessions.sessions.reduce((n,s)=>n+s.usage.costUsd,0),campaignJobCost=state.jobs[jobId]!.result?.modelCostUsd,gateJobCost=state.jobs[gateJobId!]!.result?.modelCostUsd,jobCost=typeof campaignJobCost==='number'&&typeof gateJobCost==='number'?campaignJobCost+gateJobCost:undefined
 const ledger=sessions.sessions.flatMap(session=>Object.entries(session.modelRequests??{}).map(([requestId,request])=>({sessionId:session.id,requestId,...request}))),dispatched=ledger.filter(r=>r.status!=='not_dispatched')
 const sdkEstimatesComplete=dispatched.every(request=>request.costKind==='sdk_estimate'&&typeof request.estimatedCostUsd==='number'&&Number.isFinite(request.estimatedCostUsd))
 const completedDeliveryOnly=dispatched.every(request=>request.delivery?.status==='completed'&&['stop','toolUse'].includes(request.delivery.stopReason??''))
 const ledgerReportedCost=dispatched.every(r=>r.providerBilling?.status==='reported'&&Number.isFinite(r.providerBilling.reportedCostUsd))?dispatched.reduce((n,r)=>n+r.providerBilling!.reportedCostUsd!,0):null
 const boundIds=new Set(dispatched.map(r=>r.providerBilling?.upstreamRequestId)),responseIds=new Set(responses.map(r=>r.id))
 const perRequestBilling=dispatched.map(request=>{
  const billing=request.providerBilling,response=responses.find(r=>r.id===billing?.upstreamRequestId)
  const evidenceHash=response?response.recoveryEvidenceHash??hash(JSON.stringify({upstreamRequestId:response.id,routedProvider:response.provider,observedModelId:response.model,reportedCostUsd:response.usage?.cost,finishReason:response.finishReason})):undefined
  return {sessionId:request.sessionId,requestId:request.requestId,upstreamRequestId:billing?.upstreamRequestId,passed:request.status==='settled'&&request.model.provider===model.provider&&request.model.modelId===model.modelId&&request.modelBinding?.canonicalModelId===modelAlias.canonicalModelId&&request.modelBinding?.requestedModelId===model.modelId&&request.modelBinding?.source==='explicit_host_alias'&&!!response&&typeof response.id==='string'&&response.id.length>0&&typeof response.provider==='string'&&response.provider.length>0&&authorizedStreamModel(response.model,modelAlias)&&typeof response.usage?.cost==='number'&&Number.isFinite(response.usage.cost)&&response.usage.cost>=0&&billing?.status==='reported'&&billing.routedProvider===response.provider&&billing.finishReason===response.finishReason&&billing.observedModelId===response.model&&billing.reportedCostUsd===response.usage.cost&&billing.evidenceHash===evidenceHash&&!response.error&&!response.identityConflict&&!response.identityInvalid&&!response.observationError}
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
  const transport=config.transport!
  const verifier=new Application({workspace,projectId,execution:{...config,frozenAssets,authorization:{...config.authorization,authorize:noInference,authorizeNative:noInference},inspectionBoundary:config.inspectionBoundary?{...config.inspectionBoundary,execute:noInference}:undefined,transport:{kind:transport.kind,snapshotProfile:()=>transport.snapshotProfile?.(),dispatch:noInference,reconcile:noInference,preflight:noInference,capabilities:noInference,validateGeneratorSpecs:noInference}},jobs:{runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
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
 const ordinary=ordinaryOrder,parents=ordinary.slice(0,2),followups=ordinary.slice(2,4)
 const parentRuns=parents.map(trial=>Object.values(state.runs).find(run=>run.trialId===trial.id&&run.status==='succeeded'))
 const memoryDeliveryAudit:any[]=[]
 for(const followup of followups){
  const run=Object.values(state.runs).find(item=>item.trialId===followup.id),request=run?await Bun.file(path.join(workspace,path.dirname(run.bundlePath),'request.json')).json():undefined,actual=learnedSearchChecks.find(item=>item.trialId===followup.id)
  memoryDeliveryAudit.push(auditFollowupMemoryProof({followup,state,sessions,parents,parentRuns,inferenceContexts,temperature:actual?.temperature??NaN,requestId:request?.requestId??''}))
 }
 await save('actual-memory-delivery-audit.json',{passed:memoryDeliveryAudit.length===2&&memoryDeliveryAudit.every(item=>item.passed),followups:memoryDeliveryAudit},true)
 await save('inference-context-index.json',{requests:inferenceContexts.map(context=>({sessionId:context.sessionId,requestId:context.requestId,settledSequence:context.settledSequence,transcriptHash:context.transcriptHash,file:'inference-context-'+context.sessionId+'-'+context.requestId+'.json',packetHashes:context.packets.map((packet:any)=>packet.packetHash)}))},true)
 const feedbackChecks={fourVerifiedOrdinaryRuns:receipts.filter(r=>r.intent!=='shadow_replay'&&r.valid).length===4,twoProspectivelyDeclaredMemoryGuidedFollowups:memoryDeliveryAudit.length===2&&memoryDeliveryAudit.every(item=>item.passed),twoBaselineTemperatureTrials:learnedSearchChecks.filter(item=>item.ordinal<=2).length===2&&learnedSearchChecks.filter(item=>item.ordinal<=2).every(item=>item.temperature===0.1)}
 await save('feedback-checks.json',{checks:feedbackChecks,mechanismObserved:Object.values(feedbackChecks).every(Boolean),interpretation:'Prospective citations, actual delivered packet and changed program establish an attributable feedback trace; they do not establish scientific improvement.'},true)
 const validationTrace=sessions.journal.filter((e:any)=>e.type==='tool_execution_end'&&e.data?.toolName==='validate_trial')
 await save('admission-repair-coverage.json',{validationCalls:validationTrace.length,validationEvents:validationTrace,repairCoverage:'Inspect exact failure/write/validation chronology before claiming repaired admission; immediate success does not exercise repair.'},true)
 const aggregateComputeReservationSeconds=trialBudgetChecks.every(item=>Number.isFinite(item.reservedComputeSeconds))?trialBudgetChecks.reduce((total,item)=>total+item.reservedComputeSeconds,0):null
 const launchPricingPin=await Bun.file(path.join(operator,'pricing-launch-pin.json')).json()
 for(const item of [launchPricingPin.proof,launchPricingPin.response,launchPricingPin.modelMetadata])if(!item||hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Original pricing/canonical model launch proof changed')
 const officialAliasProofBound=operationHash(verifyCanonicalAliasProof(modelAliasProof,await fs.readFile(path.join(operator,modelAliasProof.responseFile),'utf8')))===operationHash(modelAlias)&&operationHash(launchPricingPin.modelAliasProof)===operationHash(modelAliasProof)
 const gateStillBound=await verifyAuthoringGatePins(),firstOrdinary=ordinaryOrder[0],firstRun=firstOrdinary&&Object.values(state.runs).find(run=>run.trialId===firstOrdinary.id),firstGateSeed=(firstOrdinary as any)?.generationSeed
 const gateDraftReused=firstDraftBindingMatches(gateProof,{programHash:firstOrdinary?.programHash,generationSeed:firstGateSeed,experimentId:firstOrdinary?.experimentId,sessionId:String(state.jobs[firstOrdinary?.origin?.jobId??'']?.payload.sessionId??'')})
 const aggregateJobReportedCost=[state.jobs[jobId]!,state.jobs[gateJobId!]!].every(job=>(job.result?.providerAccounting as any)?.status==='reported')?[state.jobs[jobId]!,state.jobs[gateJobId!]!].reduce((total,job)=>total+Number((job.result!.providerAccounting as any).reportedCostUsd),0):null
 const originalAuthoringCarryoverVerified=operationHash(await verifyCarryoverPin(prepared))===operationHash(carryover)
 const checks={originalAuthoringCarryoverVerified,liveAuthoringGateVerified:gateStillBound&&gateProof.passed===true,firstValidatedDraftReused:gateDraftReused,sdkEstimatesComplete,completedDeliveryOnly,costReservationsVerified,aggregateComputeReservationRespected:aggregateComputeReservationSeconds!==null&&aggregateComputeReservationSeconds<=grant.maximumGpuSecondsAggregate,learnedModelInsideNativeSearchVerified:learnedSearchChecks.length===4&&learnedSearchChecks.every(item=>item.passed),generationRandomnessVerified,memoryInformedFollowupVerified:Object.values(feedbackChecks).every(Boolean),nativeAuthoringVerified:authoringChecks.every(item=>item.passed)&&authoringChecks.length>0,legacyAuthoringToolsAbsent:legacyToolAbsence,failedOriginalReceiptsVerified:failedReceipts.length===Object.values(state.runs).filter(run=>['failed','cancelled'].includes(run.status)).length&&failedReceipts.every(receipt=>receipt.workerHash===prepared.workerHash),finiteGrantRespected:Object.keys(state.trials).length<=4&&Object.keys(state.runs).length<=4&&attempts.length<=4&&count+carryover.requestCount<=grant.maximumModelRequests&&Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length<=4&&Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length===0&&payloadOutputSizing.length===count&&payloadOutputSizing.every(c=>c.length>0&&c.every(v=>Number.isSafeInteger(v)&&v>0))&&grant.autofoldOutputTokenCap===null&&grant.outputPolicy==='pi_and_provider_default'&&trialBudgetChecks.every(r=>r.passed),validLockedEvaluation:receipts.length>0&&receipts.every(r=>r.valid),uniqueOriginalLaunches:attempts.length===Object.values(state.runs).length&&new Set(attempts.map(r=>r.runId)).size===attempts.length,successfulScientificRuns:receipts.length>0&&receipts.every(r=>r.scientific),allSuccessfulReceiptsVerified:receipts.length===Object.values(state.runs).filter(r=>r.status==='succeeded').length,originalWorker:receipts.every(r=>r.workerHash===prepared.workerHash),settled,canonicalEstimatesReconciled:typeof jobCost==='number'&&Math.abs(jobCost-sessionCost)<1e-8,canonicalReportedUsageReconciled:aggregateJobReportedCost!==null&&providerCost!==null&&Math.abs(aggregateJobReportedCost-providerCost)<1e-8,providerUsageComplete:responses.length===count&&providerCost!==null,providerUsageBoundExactly:exactBillingIds&&ledgerReportedCost!==null&&providerCost!==null&&Math.abs(ledgerReportedCost-providerCost)<1e-8,officialAliasProofBound,requestedModelOnly:responses.length>0&&responses.every(r=>typeof r.provider==='string'&&r.provider.length>0&&authorizedStreamModel(r.model,modelAlias)&&!r.observationError&&!r.identityConflict&&!r.identityInvalid),bothCostCeilingsRespected:sdkEstimatesComplete&&carryover.sdkEstimatedUsd+sessionCost<=grant.modelBudgetUsd&&providerCost!==null&&carryover.providerReportedUsd+providerCost<=grant.reportedInferenceCeilingUsd,receiptOnlyReopenNoNewEffects:!!recovery&&reopenForbiddenCalls===0&&JSON.stringify(sameOriginalEffects(before))===JSON.stringify(sameOriginalEffects(after))}
 const coverage={ordinaryVerifiedRuns:receipts.filter(r=>r.intent!=='shadow_replay').length,replayVerifiedRuns:receipts.filter(r=>r.intent==='shadow_replay').length,failedRuns:Object.values(state.runs).filter(r=>r.status==='failed').length,failedOperations:operations.filter(o=>o.outcome==='failed').length,replayRequested:false,guidanceComparisonLiveCovered:false,skillSelfImprovementLiveCovered:false,scientificImprovementEstablished:false,authority:'Engineering validation of native learned search and delivered feedback; no paired replay or skill activation requested'}
 const report={authoringBudgetCarryover:carryover,aggregateIncludingPriorAuthoring:{providerRequests:carryover.requestCount+count,sdkEstimatedInferenceUsd:sdkEstimatesComplete?carryover.sdkEstimatedUsd+sessionCost:null,providerReportedCostUsd:providerCost===null?null:carryover.providerReportedUsd+providerCost},liveAuthoringGate:gateProof,gateDraftReused,authoringGateJobId:gateJobId,campaignJobCost,gateJobCost,aggregateJobReportedCost,modelAliasProof,feedbackAudit,memoryDeliveryAudit,costReservations,reservationChecks,pricingAssumptions,pricingResponseHash:pricing.responseHash,aggregateComputeReservationSeconds,coverage,format:'autofold.cohesive-engine-validation.v1',observedAt:new Date().toISOString(),...checks,passed:Object.values(checks).every(Boolean),receipts,failedReceipts,authoringChecks,jobs:Object.values(state.jobs),operations,sdkEstimatedInferenceUsd:sdkEstimatesComplete?sessionCost:null,canonicalSessionInferenceUsd:sessionCost,providerRecoveries,providerReportedCostUsd:providerCost,sessionReportedCostUsd:ledgerReportedCost,perRequestBilling,trialBudgetChecks,payloadOutputSizing,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,providerRequests:ledger.map(r=>({sessionId:r.sessionId,requestId:r.requestId,status:r.status,costKind:r.costKind,estimatedCostUsd:r.estimatedCostUsd,canonicalCostUsd:r.reportedCostUsd,providerBilling:r.providerBilling})),costSemantics:'Canonical SDK estimates and separate exact original OpenRouter reported usage; unequal amounts do not fabricate invoice equality',actualProviders:[...new Set(responses.map(r=>r.provider))],originalDispatches:dispatches,providerResponses:responses.length,receiptOnlyReopen:{before,after,recovery,forbiddenInferenceAttempts:reopenForbiddenCalls},controlledFault:false,biologicalValidationEstablished:false,methodImprovementEstablished:false,remoteShutdownVerified:false}
 await save(settled?'settlement-audit.json':'held-state-audit.json',report,true)
 console.log(JSON.stringify({type:'result',passed:report.passed,coverage,checks,receipts,sdkEstimatedInference:sessionCost,providerReportedInference:providerCost,providerResponses:responses.length}))
 stage=report.passed?'settled_pending_physical_shutdown':'held_acceptance_gap';if(!report.passed)process.exitCode=1
}catch(e){error=e;stage='held_exception';await save('original-dispatch-error-observation.json',await captureOriginalDispatchBindings(),true);process.exitCode=1;if(app)await app.store.read(projectId).then(bindOriginalJob).catch(()=>{});await save('driver-error.json',{observedAt:new Date().toISOString(),message:e instanceof Error?e.message:String(e),stack:e instanceof Error?e.stack:undefined,jobId,gateJobId,authoringGateActive},true);console.error(JSON.stringify({type:'driver_error',message:String(e),jobId}));if(!await Bun.file(path.join(operator,'held-state-audit.json')).exists()&&!await Bun.file(path.join(operator,'settlement-audit.json')).exists())await save('held-state-audit.json',{format:'autofold.cohesive-engine-held-state.v1',observedAt:new Date().toISOString(),passed:false,error:String(e),jobId,gateJobId,authoringGateActive,providerRequests:count,authoringBudgetCarryover:carryover,aggregateProviderRequests:carryover.requestCount+count,aggregateProviderReportedCostUsd:providerReportedCost()===null?null:carryover.providerReportedUsd+Number(providerReportedCost()),providerReportedCostUsd:providerReportedCost(),state:app?await app.store.read(projectId).catch(()=>null):null,canonicalSettlementProven:false,receiptVerificationNotCompleted:true,replacementDispatches:0},true)}
finally{clearTimeout(timeout);if(timer)clearInterval(timer);await Promise.allSettled(observations);if(!providerRecoveryAttempted)try{await recoverFinalOriginalProviderUsage()}catch(error){await save('provider-recovery-blocked.json',{error:error instanceof Error?error.message:String(error),inferenceCalls:0,newDispatches:0},true)};const finalDispatchObservation=await captureOriginalDispatchBindings();await save('original-dispatch-final-observation.json',finalDispatchObservation,true);if(finalDispatchObservation.status!=='complete'){process.exitCode=1;stage='held_original_dispatch_bindings'};if(!await Bun.file(path.join(operator,'original-dispatch-records.json')).exists())await save('original-dispatch-records.json',finalDispatchObservation.records,true);await observe();await save('driver-exit.json',{observedAt:new Date().toISOString(),stage,jobId,gateJobId,authoringGateActive,exitCode:process.exitCode??0,error:error?String(error):undefined},true)}
