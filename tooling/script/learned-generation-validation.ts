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
const scope={maximumTrials:4,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:0,
 maximumGpuSeconds:600,maximumGpuSecondsPerTrial:600,maximumGpuSecondsAggregate:2400,maximumSearchWallSeconds:300,maximumWorkerWallMinutes:15,
 computeBudgetSemantics:'maximumGpuSeconds is the per-trial compute reservation; four trials reserve at most 2400 seconds aggregate. Reservations are not measured physical GPU seconds.',
 modelBudgetUsd:2,reportedInferenceCeilingUsd:3,maximumModelRequests:128,
 maximumCampaignSteps:2,perChildModelBudgetUsd:2,maximumDurationMs:3600000,
 maxTurns:64,maxToolCalls:128,autofoldOutputTokenCap:null,outputPolicy:'pi_and_provider_default',providerRetries:0}
const objective=[
 'Validate exactly four fresh LLM-authored ProteinMPNN-generated 12-residue peptide trials against the same full first chain from the immutable PD-L1 target artifact. Derive its length from that verified JSON rather than a remembered length. This is computational architecture validation, not binding or biological evidence.',
 'Each native Program has one RejectionSamplingOptimizer: num_samples=1, num_results=1, proposal_source="generated", proposal_batch_size=1, track_proposals=True, no threshold. Use one genuine ProteinMPNNGenerator assigned only to the binder; one generated proposal is scored and retained. This exercises learned generation plus objective evaluation/selection, not internal hill climbing.',
 'Use the frozen references/bootstrap/proteinmpnn-backbone.pdb: read and embed its exact bytes as an inline PDB string in trial.py, directly or by base64 decoding. Never use a machine-local path in generator configuration. This is the unchanged chain-B 12-residue modeled backbone from a verified prior receipt, not an experimentally resolved structure. ProteinMPNNGeneratorConfig uses structure_inputs=[InverseFoldingStructureInput(structure=Structure(structure=PDB_TEXT),chains_to_redesign=["B"])], output_chain_id="B", model_choice="proteinmpnn", batch_size=1, device="cuda". Keep the backbone and all other generator settings fixed.',
 'The first two trials use ProteinMPNN temperature=0.1. Trials three and four must obtain current actually delivered DecisionMemory containing the first two verified results, cite at least one of those original runs, and prospectively choose temperature 0.05 or 0.2 as the scientific intervention. Declare ProtoTrial prediction with an actual first-two comparatorTrialId, metric=locked_score and relation=lower or higher, plus decision_plan.changedVariables naming temperature and outcomeBranches stating a result that would disprove the hypothesis. An initialization sequence alone does not condition unconstrained ProteinMPNN sampling; the actual temperature change must be declared. Varying generation seeds prevent a causal improvement claim.',
 'Use the supported ordinary Constraint with function fixed_predictor_iptm and flat function_config predictor_seed=99173. Read references/bootstrap/predictor-recipe.py and copy its helper verbatim into the authored trial. Follow this pinned procedural recipe exactly: the wrapper constructs StructureBasedConstraintConfig and Boltz2Config(seed=config["predictor_seed"],use_msa=False) inside evaluation and delegates to existing structure_iptm_constraint. Use inputs=[fixed_target,binder], weight=1, no threshold or backward. Do not put seed or seeds keys in wrapper config, because Proto derives those from Program and would overwrite explicit values. Native energy is 1-ipTM, a predicted interface-confidence proxy distinct from frozen evaluation score or affinity.',
 'Program seed must be ctx.generation_seed, and fixed evaluator seeds stay [20260809]. NativeSearch selects only binder via NativeOutput and admits only proteinmpnn-sample and boltz2-prediction, maximum_candidates=1, maximum_proposals=1, maximum_sampling_calls=1, maximum_tool_calls=2, maximum_wall_seconds=300. Construction must not run or sample tools. No external MSA, new models/recipients, replay, or skill activation. Preserve actual failures and unknown costs. Stop after four ordinary trials.'
].join(' ')

const main=path.resolve(import.meta.dir,'../..'),workspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-validation-20261013')
const projectId='prj_learned_generation_validation_20261013',operator=path.join(workspace,'operator')
const campaignObjective='Validate four ProteinMPNN-generated PD-L1 peptide trials through native Proto sample-and-score search and the frozen Boltz2/Chai1 panel. The first two use temperature 0.1; two later trials use verified delivered memory to choose a prospective temperature intervention on the same frozen computational backbone. Keep predictor seeds fixed and generation streams separately recorded. Stop after four trials without replay or skill activation; do not claim biological binding or causal improvement.'
const bootstrapSource=path.join(main,'.autofold/cohesive-engine-refactor-20261012/learned-generation-improvements-20261013/operator/bootstrap')
const fixedPredictorSeed=99173
const fixedPredictorConfigHash='sha256:8a20e621117fb24b9b5b2e5d871feda78d372101252e7408a38b155eeff8773c'
const predictorRecipeSource="def fixed_predictor_iptm(input_sequences, config):\n    typed=StructureBasedConstraintConfig(structure_tool='boltz2',boltz2_config=Boltz2Config(seed=config['predictor_seed'],use_msa=False))\n    return structure_iptm_constraint(input_sequences,typed)\n"
const predictorRecipeHash='sha256:a894f49c9c29b5cdfdcc654a75fd0694777d3727e239b4573c2d1196a1efec2f'


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
 for(const item of [p.profile,p.contract,p.driver,p.grant,p.gateManifest,p.historicalBefore,p.bootstrap,...p.bootstrapPins,...p.offlineGates,...p.offlineLogs,...p.targetFiles])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Frozen pin changed: '+item.path)
 return p
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
 const required=['change1','change2','change3','full']
 if(value?.status!=='passed'||!/^sha256:[a-f0-9]{64}$/.test(value.sourceHash??'')||!/^sha256:[a-f0-9]{64}$/.test(value.workerHash??'')||!value.gates||operationHash(Object.keys(value.gates).sort())!==operationHash([...required].sort()))throw Error('Fresh regression manifest must bind exactly three implementation changes and the full gate')
 for(const name of required){const entry=value.gates[name];if(!entry||typeof entry.path!=='string'||!entry.path||!Array.isArray(entry.logs)||entry.logs.length===0||entry.logs.some((item:any)=>typeof item!=='string'||!item))throw Error('Fresh gate must identify its original nonempty logs: '+name)}
 return required
}
function checkGateFixtures(){
 const valid={status:'passed',sourceHash:'sha256:'+'1'.repeat(64),workerHash:'sha256:'+'2'.repeat(64),gates:Object.fromEntries(['change1','change2','change3','full'].map(name=>[name,{path:'synthetic/'+name+'.json',logs:['synthetic/'+name+'.log']}]))},cases:any[]=[{name:'three-fresh-changes-and-full',manifest:valid,expected:true}]
 const mutate=(name:string,change:(value:any)=>void)=>{const value=structuredClone(valid);change(value);cases.push({name,manifest:value,expected:false})}
 mutate('missing-third-change',value=>delete value.gates.change3);mutate('fake-fourth-change',value=>value.gates.change4=value.gates.change3);mutate('missing-full-gate',value=>delete value.gates.full);mutate('empty-original-logs',value=>value.gates.change2.logs=[]);mutate('invalid-source-identity',value=>value.sourceHash='unknown');mutate('not-passed',value=>value.status='failed')
 const results=cases.map(item=>{let accepted=true;try{validateGateManifestSchema(item.manifest)}catch{accepted=false}return {name:item.name,expected:item.expected,accepted}}),passed=results.every(item=>item.expected===item.accepted)
 console.log(JSON.stringify({mode:'fresh-three-change-gate-manifest-fixtures',passed,results,providerCalls:0,remoteCalls:0}));if(!passed)throw Error('Fresh gate schema regression')
}
async function prepare(gateManifestPath:string){
 if(await fs.access(workspace).then(()=>true,()=>false))throw Error('Fresh learned-search workspace already exists; never replace evidence')
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
 await fs.mkdir(operator,{recursive:true,mode:0o700})
 const previous=path.join(main,'.autofold/cohesive-engine-refactor-20261012/final-gpu-validation/operator')
 const contract=ResearchDomain.ExperimentContract.parse({...await Bun.file(path.join(previous,'contract.json')).json(),
   objective,
   budget:{maximumCandidates:1,gpuHours:600/3600,wallTimeMinutes:15}})
 const profile=await Bun.file(path.join(previous,'profile.json')).json()
 profile.remote.root='/home/vincent/.autofold-learned-generation-validation-20261013'
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
 const grant={humanAuthorization:'User requested a fresh bounded four-trial validation with genuine learned generation and memory-guided followups. Operator bounds are $3 reported inference and a separate $2 SDK-estimate ceiling, below the earlier user $10 inference ceiling; this does not claim an explicit prior approval of $3 or reuse a previous run grant. Existing approved recipients remain the destinations.',...scope,model,routing,sourceHash:identity.sourceHash}
 await save('human-grant.json',grant,true)
 await save('launch-preparation.json',{preparedAt:new Date().toISOString(),...identity,projectId,workspace,profile:await pin(path.join(operator,'profile.json')),contract:await pin(path.join(operator,'contract.json')),driver:await pin(import.meta.path),grant:await pin(path.join(operator,'human-grant.json')),gateManifest:await pin(gateManifest),offlineGates,offlineLogs,historicalBefore:await pin(path.join(main,'.autofold/cohesive-engine-refactor-20261012/operator/historical-before.json')),bootstrap:await pin(path.join(operator,'bootstrap.json')),bootstrapPins:bootstrap.pins,targetFiles,contractHash:ResearchDomain.hashContract(contract),scope:'Fresh model prompts/tool context to OpenRouter and newly authored programs/frozen worker/PD-L1 files to existing workstation_4090. Only new project evidence is writable. Original unresolved jobs and validation roots are never resumed.'},true)
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
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-generation-validation-20261013')throw Error('Original worker destination differs')
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
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-learned-generation-validation-20261013'||remote.python!=='/home/vincent/autofold-env/bin/python')throw Error('Authorized read-only host destination differs')
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
const [mode,...args]=process.argv.slice(2)
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
const prepared=await pins(),grant=await Bun.file(path.join(operator,'human-grant.json')).json()
if(Object.entries(scope).some(([key,value])=>grant[key]!==value)||JSON.stringify(grant.model)!==JSON.stringify(model)||grant.sourceHash!==prepared.sourceHash||JSON.stringify(grant.routing)!==JSON.stringify(routing))throw Error('Fresh bounded grant mismatch')
const profile=await Bun.file(prepared.profile.path).json()
if(profile.remote?.host!=='workstation_4090'||profile.remote?.root!=='/home/vincent/.autofold-learned-generation-validation-20261013')throw Error('Fresh authorized worker destination differs')
const readiness=await checkHost()
if(readiness.passed!==true||readiness.proteinmpnnAssetsMatched!==true||readiness.commitsMatched!==true||readiness.nativeTreesClean!==true||readiness.bubblewrapMatched!==true||!Number.isFinite(Date.parse(readiness.observedAt))||Date.now()-Date.parse(readiness.observedAt)>600000||readiness.computeReturnCode!==0||readiness.gpuComputeProcesses||readiness.workerProcesses.length||!readiness.freshRootAbsent||!Object.values(readiness.requiredPaths).every(Boolean))throw new Error('Idle bound host readiness required')
const pricing=await Bun.file(path.join(operator,'pricing-latest.json')).json()
if(pricing.passed!==true||pricing.url!==pricingURL||pricing.sdkMetadataHash!=='sha256:'+operationHash(DEFAULT_MODEL)||!Number.isFinite(Date.parse(pricing.observedAt))||Date.now()-Date.parse(pricing.observedAt)>600000||!/^pricing-response-[A-Za-z0-9-]+\.json$/.test(pricing.responseFile))throw Error('Fresh public default-route pricing proof required')
const pricingRaw=await fs.readFile(path.join(operator,pricing.responseFile),'utf8')
if(hash(pricingRaw)!==pricing.responseHash||operationHash(endpointPricing(JSON.parse(pricingRaw)))!==operationHash(pricing.endpoints))throw Error('Published pricing proof differs from its original raw response')
const credentials=await Bun.file('/Users/vincentallam/.local/share/openscience/auth.json').json()
if(typeof credentials.openrouter?.key!=='string'||!credentials.openrouter.key)throw new Error('Selected host credential unavailable')
delete process.env.OPENROUTER_API_KEY
const launchMs=Date.now(),authorizedAt=new Date(launchMs).toISOString(),deadlineMs=launchMs+grant.maximumDurationMs
await save('launch-fence.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),projectId,workspace,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,grantHash:hash(await fs.readFile(path.join(operator,'human-grant.json')))},true)
await save('host-readiness-launch-pin.json',{proof:await pin(path.join(operator,'host-readiness.json')),assetsProofHash:readiness.assetsProofHash,passed:readiness.passed},true)
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
 await app.store.mutate(projectId,state=>{state.campaignCharters[campaign.id]!.constraints.maximumCampaignTrials=4;state.campaignCharters[campaign.id]!.constraints.maximumCampaignGpuHours=4*contract.budget.gpuHours})
 const bootstrap=await Bun.file(path.join(operator,'bootstrap.json')).json()
 for(const entry of [bootstrap.reference,bootstrap.recipe]){const destination=path.join(workspace,'.autofold/autoresearch',experiment.id,'references/bootstrap',path.basename(entry.path));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});const raw=await fs.readFile(entry.path);if(hash(raw)!==entry.contentHash)throw Error('Frozen procedural bootstrap differs');await fs.writeFile(destination,raw,{flag:'wx',mode:0o400})}
 await app.skills.initialize(campaign.id)
 await app.execution.preflightExperiment(await app.experiment(experiment.id),controller.signal)
 await pins()
 const job=await app.campaign.enqueueCampaign(campaign.id,{idempotencyKey:'fresh-learned-generation-validation-20261013',experimentId:experiment.id,maxSteps:2,maximumTrajectories:4,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:0,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:2,perChildModelBudgetUsd:2,maximumDurationMs:Math.max(1,deadlineMs-Date.now()),modelSelection:model})
 jobId=job.id
 await save('authorization.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),workspace,projectId,campaignId:campaign.id,experimentId:experiment.id,jobId,contractHash:experiment.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,limits:grant,controlledFault:false,operatorAuthoredScience:false},true)
 await save('original-job-identity.json',{jobId,sessionId:job.payload.sessionId,campaignId:campaign.id,experimentId:experiment.id},true)
 stage='native_cohesive_engine_campaign';await observe();timer=setInterval(()=>void observe(),30000)
 await app.jobs.runOnce({jobId,signal:controller.signal})
 await Promise.all(observations);await pins()
 let state=await app.store.read(projectId)
 await save('campaign-result.json',await app.jobs.get(jobId),true)
 if(Object.keys(state.trials).length>4||Object.keys(state.runs).length>4||Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length>4||Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length>0)throw new Error('Fresh trial grant exceeded')
 const attempts=[];for(const run of Object.values(state.runs)){const file=path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json');if(await Bun.file(file).exists())attempts.push(await originalDispatchBinding(run))}dispatches=attempts.length;if(dispatches>4)throw Error('Original launch attempt grant exceeded');await save('original-dispatch-records.json',attempts,true)
 const trialBudgetChecks=[];for(const run of Object.values(state.runs)){const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json(),planFile=path.join(workspace,path.dirname(run.bundlePath),'remote-plan.identity.json'),plan=await Bun.file(planFile).exists()?await Bun.file(planFile).json():undefined;trialBudgetChecks.push({runId:run.id,reservedComputeSeconds:bundle.nativeExecution?.resources?.maximumComputeReservationSeconds,passed:bundle.candidateBudget===1&&bundle.submissionSize===1&&JSON.stringify(bundle.seeds)==='[20260809]'&&bundle.nativeExecution?.observation==='scoped_native_lifecycle_v1'&&bundle.nativeExecution.resources.maximumSearchWallSeconds===300&&bundle.nativeExecution.resources.reservedSearchComputeSeconds===300&&bundle.nativeExecution.resources.reservedEvaluationComputeSeconds===300&&bundle.nativeExecution.resources.maximumComputeReservationSeconds===600&&bundle.contractHash===prepared.contractHash&&bundle.targetArtifactHash===contract.targetArtifactHash&&bundle.evaluator?.id===contract.evaluator.id&&bundle.evaluator?.version===contract.evaluator.version&&(!plan||Number.isFinite(plan.timeoutMs)&&plan.timeoutMs>0&&plan.timeoutMs<=15*60000&&Number.isFinite(plan.authorizationDeadlineMs)&&plan.authorizationDeadlineMs<=deadlineMs)})}
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
  const transport=config.transport!
  const verifier=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,authorize:noInference},inspectionBoundary:config.inspectionBoundary?{...config.inspectionBoundary,execute:noInference}:undefined,transport:{kind:transport.kind,snapshotProfile:()=>transport.snapshotProfile?.(),dispatch:noInference,reconcile:noInference,preflight:noInference,capabilities:noInference,validateGeneratorSpecs:noInference}},jobs:{runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
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
  const exposure=followup.decisionMemoryExposure,sessionId=String(state.jobs[followup.origin?.jobId??'']?.payload.sessionId??''),trace=sessions.journal.filter((event:any)=>event.sessionId===sessionId)
  const run=Object.values(state.runs).find(item=>item.trialId===followup.id),executionRequest=run?await Bun.file(path.join(workspace,path.dirname(run.bundlePath),'request.json')).json():undefined
  const start:any=trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName==='evaluate_trial'&&event.data?.args?.requestId===executionRequest?.requestId)
  const assistant:any=start&&trace.findLast((event:any)=>event.sequence<start.sequence&&event.type==='message_end'&&event.data?.message?.role==='assistant'&&event.data.message.content.some((part:any)=>part.type==='toolCall'&&part.id===start.data.toolCallId&&part.name==='evaluate_trial'))
  const settled:any=assistant&&trace.findLast((event:any)=>event.sequence<assistant.sequence&&event.type==='model_request_settled')
  const inference=settled&&inferenceContexts.find(context=>context.sessionId===sessionId&&context.requestId===settled.data?.requestId&&context.settledSequence===settled.sequence)
  const delivered=exposure&&inference?.packets.find((item:any)=>item.packetHash===exposure.packetHash&&'sha256:'+operationHash(item.packet)===exposure.packetHash&&item.manifestVerification.status==='verified'&&item.manifestVerification.manifestHash===exposure.manifestHash&&item.manifestVerification.snapshotHash===exposure.snapshotHash&&item.packet.sourceManifest.manifestHash===exposure.manifestHash&&item.packet.sourceManifest.snapshotHash===exposure.snapshotHash&&operationHash(item.packet.sourceManifest.scope)===operationHash(exposure.scope)&&parentRuns.every(parent=>parent&&item.packet.facts.some((fact:any)=>fact.runId===parent.id&&fact.receiptStatus==='verified'&&fact.receiptHash===parent.manifestHash)))
  const latest:any=start&&trace.filter((event:any)=>event.type==='model_request_settled'&&event.sequence<start.sequence).at(-1)
  const currentExperiment=state.experiments[followup.experimentId],memoryDeliveryBound=!!delivered&&!!exposure&&exposure.sessionId===sessionId&&inference?.sessionId===exposure.sessionId&&latest?.data?.requestId===inference?.requestId&&exposure.scope.projectId===projectId&&exposure.scope.experimentId===followup.experimentId&&exposure.scope.campaignId===currentExperiment?.campaignId
  const citedParents=parentRuns.filter(parent=>parent&&[...followup.evidenceRefs??[],...followup.decisionPlan?.evidenceRefs??[]].includes(parent.id)&&exposure?.citedSources.some(source=>source.id===parent.id))
  const declarationBound=!!exposure&&exposure.decisionHash==='sha256:'+operationHash({decisionPlan:followup.decisionPlan,evidenceRefs:followup.evidenceRefs})
  const parentsPrecedeFollowup=parentRuns.length===2&&parentRuns.every(parent=>parent&&Number.isFinite(Date.parse(parent.completedAt!))&&Date.parse(parent.completedAt!)<Date.parse(followup.createdAt))
  const temperatureDeclaration=!!followup.decisionPlan?.changedVariables?.some(variable=>/temperature/i.test(variable))&&!!followup.prediction&&parents.some(parent=>parent.id===followup.prediction?.comparatorTrialId)&&followup.prediction.metric==='locked_score'&&['lower','higher'].includes(followup.prediction.relation)
  const actual=learnedSearchChecks.find(item=>item.trialId===followup.id)
  memoryDeliveryAudit.push({trialId:followup.id,runId:run?.id,sessionId,evaluateToolCallId:start?.data?.toolCallId,assistantSequence:assistant?.sequence,settledSequence:settled?.sequence,inferenceRequestId:inference?.requestId,transcriptHash:inference?.transcriptHash,packetHash:delivered?.packetHash,manifestVerification:delivered?.manifestVerification,parentsPrecedeFollowup,parentRunIds:parentRuns.map(item=>item?.id),exposure,memoryDeliveryBound,citedParentRunIds:citedParents.map(item=>item!.id),declarationBound,temperatureDeclaration,actualTemperature:actual?.temperature,
   passed:parentsPrecedeFollowup&&memoryDeliveryBound&&citedParents.length>0&&declarationBound&&temperatureDeclaration&&actual?.temperatureProtocolBound===true&&actual.temperature!==0.1,
   interpretation:'Each followup is bound to the exact evaluate call and preceding settled model response, full delivered packet containing both verified parents, prospective citation and actual temperature intervention. This feedback trace is not causal improvement evidence.'})
 }
 await save('actual-memory-delivery-audit.json',{passed:memoryDeliveryAudit.length===2&&memoryDeliveryAudit.every(item=>item.passed),followups:memoryDeliveryAudit},true)
 await save('inference-context-index.json',{requests:inferenceContexts.map(context=>({sessionId:context.sessionId,requestId:context.requestId,settledSequence:context.settledSequence,transcriptHash:context.transcriptHash,file:'inference-context-'+context.sessionId+'-'+context.requestId+'.json',packetHashes:context.packets.map((packet:any)=>packet.packetHash)}))},true)
 const feedbackChecks={fourVerifiedOrdinaryRuns:receipts.filter(r=>r.intent!=='shadow_replay'&&r.valid).length===4,twoProspectivelyDeclaredMemoryGuidedFollowups:memoryDeliveryAudit.length===2&&memoryDeliveryAudit.every(item=>item.passed),twoBaselineTemperatureTrials:learnedSearchChecks.filter(item=>item.ordinal<=2).length===2&&learnedSearchChecks.filter(item=>item.ordinal<=2).every(item=>item.temperature===0.1)}
 await save('feedback-checks.json',{checks:feedbackChecks,mechanismObserved:Object.values(feedbackChecks).every(Boolean),interpretation:'Prospective citations, actual delivered packet and changed program establish an attributable feedback trace; they do not establish scientific improvement.'},true)
 const validationTrace=sessions.journal.filter((e:any)=>e.type==='tool_execution_end'&&e.data?.toolName==='validate_trial')
 await save('admission-repair-coverage.json',{validationCalls:validationTrace.length,validationEvents:validationTrace,repairCoverage:'Inspect exact failure/write/validation chronology before claiming repaired admission; immediate success does not exercise repair.'},true)
 const aggregateComputeReservationSeconds=trialBudgetChecks.every(item=>Number.isFinite(item.reservedComputeSeconds))?trialBudgetChecks.reduce((total,item)=>total+item.reservedComputeSeconds,0):null
 const checks={costReservationsVerified,aggregateComputeReservationRespected:aggregateComputeReservationSeconds!==null&&aggregateComputeReservationSeconds<=grant.maximumGpuSecondsAggregate,learnedModelInsideNativeSearchVerified:learnedSearchChecks.length===4&&learnedSearchChecks.every(item=>item.passed),generationRandomnessVerified,memoryInformedFollowupVerified:Object.values(feedbackChecks).every(Boolean),nativeAuthoringVerified:authoringChecks.every(item=>item.passed)&&authoringChecks.length>0,legacyAuthoringToolsAbsent:legacyToolAbsence,failedOriginalReceiptsVerified:failedReceipts.length===Object.values(state.runs).filter(run=>['failed','cancelled'].includes(run.status)).length&&failedReceipts.every(receipt=>receipt.workerHash===prepared.workerHash),finiteGrantRespected:Object.keys(state.trials).length<=4&&Object.keys(state.runs).length<=4&&attempts.length<=4&&count<=128&&Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length<=4&&Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length===0&&payloadOutputSizing.length===count&&payloadOutputSizing.every(c=>c.length>0&&c.every(v=>Number.isSafeInteger(v)&&v>0))&&grant.autofoldOutputTokenCap===null&&grant.outputPolicy==='pi_and_provider_default'&&trialBudgetChecks.every(r=>r.passed),validLockedEvaluation:receipts.length>0&&receipts.every(r=>r.valid),uniqueOriginalLaunches:attempts.length===Object.values(state.runs).length&&new Set(attempts.map(r=>r.runId)).size===attempts.length,successfulScientificRuns:receipts.length>0&&receipts.every(r=>r.scientific),allSuccessfulReceiptsVerified:receipts.length===Object.values(state.runs).filter(r=>r.status==='succeeded').length,originalWorker:receipts.every(r=>r.workerHash===prepared.workerHash),settled,canonicalEstimatesReconciled:typeof jobCost==='number'&&Math.abs(jobCost-sessionCost)<1e-8,canonicalReportedUsageReconciled:(state.jobs[jobId]!.result?.providerAccounting as any)?.status==='reported'&&providerCost!==null&&Math.abs(Number((state.jobs[jobId]!.result?.providerAccounting as any)?.reportedCostUsd)-providerCost)<1e-8,providerUsageComplete:responses.length===count&&providerCost!==null,providerUsageBoundExactly:exactBillingIds&&ledgerReportedCost!==null&&providerCost!==null&&Math.abs(ledgerReportedCost-providerCost)<1e-8,requestedModelOnly:responses.length>0&&responses.every(r=>typeof r.provider==='string'&&r.provider.length>0&&r.model===model.modelId&&!r.observationError&&!r.identityConflict&&!r.identityInvalid),bothCostCeilingsRespected:sessionCost<=grant.modelBudgetUsd&&providerCost!==null&&providerCost<=grant.reportedInferenceCeilingUsd,receiptOnlyReopenNoNewEffects:!!recovery&&reopenForbiddenCalls===0&&JSON.stringify(sameOriginalEffects(before))===JSON.stringify(sameOriginalEffects(after))}
 const coverage={ordinaryVerifiedRuns:receipts.filter(r=>r.intent!=='shadow_replay').length,replayVerifiedRuns:receipts.filter(r=>r.intent==='shadow_replay').length,failedRuns:Object.values(state.runs).filter(r=>r.status==='failed').length,failedOperations:operations.filter(o=>o.outcome==='failed').length,replayRequested:false,guidanceComparisonLiveCovered:false,skillSelfImprovementLiveCovered:false,scientificImprovementEstablished:false,authority:'Engineering validation of native learned search and delivered feedback; no paired replay or skill activation requested'}
 const report={feedbackAudit,memoryDeliveryAudit,costReservations,reservationChecks,pricingAssumptions,pricingResponseHash:pricing.responseHash,aggregateComputeReservationSeconds,coverage,format:'autofold.cohesive-engine-validation.v1',observedAt:new Date().toISOString(),...checks,passed:Object.values(checks).every(Boolean),receipts,failedReceipts,authoringChecks,jobs:Object.values(state.jobs),operations,sdkEstimatedInferenceUsd:sessionCost,providerReportedCostUsd:providerCost,sessionReportedCostUsd:ledgerReportedCost,perRequestBilling,trialBudgetChecks,payloadOutputSizing,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,providerRequests:ledger.map(r=>({sessionId:r.sessionId,requestId:r.requestId,status:r.status,costKind:r.costKind,estimatedCostUsd:r.estimatedCostUsd,canonicalCostUsd:r.reportedCostUsd,providerBilling:r.providerBilling})),costSemantics:'Canonical SDK estimates and separate exact original OpenRouter reported usage; unequal amounts do not fabricate invoice equality',actualProviders:[...new Set(responses.map(r=>r.provider))],originalDispatches:dispatches,providerResponses:responses.length,receiptOnlyReopen:{before,after,recovery,forbiddenInferenceAttempts:reopenForbiddenCalls},controlledFault:false,biologicalValidationEstablished:false,methodImprovementEstablished:false,remoteShutdownVerified:false}
 await save(settled?'settlement-audit.json':'held-state-audit.json',report,true)
 console.log(JSON.stringify({type:'result',passed:report.passed,coverage,checks,receipts,sdkEstimatedInference:sessionCost,providerReportedInference:providerCost,providerResponses:responses.length}))
 stage=report.passed?'settled_pending_physical_shutdown':'held_acceptance_gap';if(!report.passed)process.exitCode=1
}catch(e){error=e;stage='held_exception';await save('original-dispatch-error-observation.json',await captureOriginalDispatchBindings(),true);process.exitCode=1;if(app)await app.store.read(projectId).then(bindOriginalJob).catch(()=>{});await save('driver-error.json',{observedAt:new Date().toISOString(),message:e instanceof Error?e.message:String(e),stack:e instanceof Error?e.stack:undefined,jobId},true);console.error(JSON.stringify({type:'driver_error',message:String(e),jobId}));if(!await Bun.file(path.join(operator,'held-state-audit.json')).exists()&&!await Bun.file(path.join(operator,'settlement-audit.json')).exists())await save('held-state-audit.json',{format:'autofold.cohesive-engine-held-state.v1',observedAt:new Date().toISOString(),passed:false,error:String(e),jobId,providerRequests:count,providerReportedCostUsd:providerReportedCost(),state:app?await app.store.read(projectId).catch(()=>null):null,canonicalSettlementProven:false,receiptVerificationNotCompleted:true,replacementDispatches:0},true)}
finally{clearTimeout(timeout);if(timer)clearInterval(timer);await Promise.allSettled(observations);const finalDispatchObservation=await captureOriginalDispatchBindings();await save('original-dispatch-final-observation.json',finalDispatchObservation,true);if(finalDispatchObservation.status!=='complete'){process.exitCode=1;stage='held_original_dispatch_bindings'};if(!await Bun.file(path.join(operator,'original-dispatch-records.json')).exists())await save('original-dispatch-records.json',finalDispatchObservation.records,true);await observe();await save('driver-exit.json',{observedAt:new Date().toISOString(),stage,jobId,exitCode:process.exitCode??0,error:error?String(error):undefined},true)}
