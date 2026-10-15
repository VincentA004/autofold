import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {prepareDecisionMemory,publishDecisionMemory,snapshotHistory,decisionMemoryExposure} from '../decision-memory'
import {ProtoModelRegistry} from '@autofold/science-core/research/model-registry'
import {CampaignEvidence} from '@autofold/science-core/campaign-evidence'
import {CampaignResources} from '@autofold/science-core/campaign-resources'
import {ResearchQuestions} from '@autofold/science-core/research-questions'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ResearchStore} from '@autofold/science-core/store'
import {CampaignKnowledgeReader,ProjectKnowledgeGraph} from '../knowledge'
import {checkedPath} from '../execution/paths'
import {atomicJSON} from './persistence'
import {scientistBudgets} from './budgets'
import {createHash} from 'node:crypto'
import {canonicalOperationJSON,operationHash} from '@autofold/science-core/operations'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {RuntimeToolDelivery} from '../runtime/types'
import type {ScientistLaneOptions,ScientistLaneStatus} from './index'
interface ContextHost {
  options:Pick<ScientistLaneOptions,'workspace'|'projectId'|'experimentId'|'sessionId'|'store'|'maximumEvaluations'|'evaluationBaseline'|'allowCompute'|'origin'> & {
    research:Pick<ScientistLaneOptions['research'],'history'|'experimentBranches'|'scientistReviews'>
    execution:Pick<ScientistLaneOptions['execution'],'artifacts'|'failureReceipt'|'capabilities'|'modelRegistry'|'frozenAssetReferences'>
    lifecycle?:Pick<NonNullable<ScientistLaneOptions['lifecycle']>,'checkCancelled'>
  };root:string
  initialize():Promise<void>;acknowledgeResearch():Promise<void>;verifyTargetReferences():Promise<void>
  scope():Promise<{state:Awaited<ReturnType<ResearchStore['read']>>;experiment:ResearchDomain.Experiment;campaign:ResearchDomain.Campaign}>
  listFiles():Promise<string[]>;status():Promise<ScientistLaneStatus>
  requests():number;completedEvaluations():number;latestResult():Record<string,any>|undefined;publicationGaps?():Record<string,string>
}
/** Advisory context and derived views; it cannot claim, execute, retry or settle jobs. */
export class ScientificContext {
  readonly graphEvidence=new Map<string,{recordHash:string;snapshotHash:string;retrievedAt:string}>()
  private previousManifest?:DecisionMemory.SourceManifest
  private delivered?:{packet:DecisionMemory.Packet;manifest:DecisionMemory.SourceManifest}
  private prepared?:{packet:DecisionMemory.Packet;manifest:DecisionMemory.SourceManifest}
  private memoryEpoch=0
  private allowRehydration=true
  private rehydrationBarrier?:NonNullable<RuntimeToolDelivery['inference']>
  private get options(){return this.host.options}
  private get root(){return this.host.root}
  constructor(private readonly host:ContextHost){}
  verifySourceRead(relative:string,bytes:Buffer) {
    if(!relative.startsWith(this.root+'/evidence/memory/'))return
    const expected=relative.slice((this.root+'/evidence/memory/').length)
    if(!/^[a-f0-9]{64}\.json$/.test(expected)||createHash('sha256').update(bytes).digest('hex')!==expected.slice(0,-5))throw new Error('Immutable decision-memory manifest bytes changed')
    const manifest=DecisionMemory.SourceManifest.parse(JSON.parse(bytes.toString('utf8')))
    if(manifest.scope.projectId!==this.options.projectId||manifest.scope.experimentId!==this.options.experimentId)throw new Error('Decision-memory manifest belongs to another scope')
  }
  exposure(input:{decisionPlan?:{evidenceRefs?:readonly string[]};evidenceRefs?:readonly string[]}) {
    return this.delivered?decisionMemoryExposure(this.delivered.packet,this.delivered.manifest,this.options.sessionId,input):undefined
  }
  /** Native publication may replace a full result with a bounded artifact card.
   * Hidden details and the original SDK message do not establish this exposure. */
  acknowledgeDelivery(delivery:RuntimeToolDelivery):void|Promise<void> {
    if(delivery.phase!=='inference')return
    if(delivery.isError){this.invalidateDelivery(delivery.inference);return}
    if(delivery.projection!=='full')return
    for(const part of delivery.content){
      if(part.type!=='text')continue
      try {
        const value=JSON.parse(part.text)
        const packet=value?.decisionMemory??value?.decisionMemoryRefresh?.decisionMemory
        if(!packet){
          if(value?.decisionMemoryRefresh?.status==='unavailable'||value?.status==='unavailable'&&value?.readTool==='read_decision_memory')this.invalidateDelivery(delivery.inference)
          continue
        }
        const prepared=this.prepared
        if(prepared){
          if(operationHash(packet)===operationHash(prepared.packet)){
            this.delivered=prepared
            this.prepared=undefined
          }
          return
        }
        if(this.canRehydrate(delivery.inference))return this.rehydrateDelivery(packet,this.memoryEpoch,delivery.inference?{...delivery.inference}:undefined)
      }catch{/* Non-JSON or altered tool output cannot acknowledge the packet. */}
    }
  }
  clearMemoryAcknowledgement() {this.delivered=undefined;this.prepared=undefined;this.allowRehydration=false;this.rehydrationBarrier=undefined;this.memoryEpoch++}
  private validInference(value:RuntimeToolDelivery['inference']):value is NonNullable<RuntimeToolDelivery['inference']> {
    return !!value&&typeof value.requestId==='string'&&!!value.requestId&&Number.isSafeInteger(value.position)&&value.position>=0&&typeof value.toolCallId==='string'&&!!value.toolCallId
  }
  private canRehydrate(inference:RuntimeToolDelivery['inference']) {
    const barrier=this.rehydrationBarrier
    return this.allowRehydration||!!barrier&&this.validInference(inference)&&inference.requestId===barrier.requestId&&inference.position>barrier.position&&inference.toolCallId!==barrier.toolCallId
  }
  private invalidateDelivery(inference:RuntimeToolDelivery['inference']) {
    const previous=this.rehydrationBarrier
    this.clearMemoryAcknowledgement()
    if(this.validInference(inference))this.rehydrationBarrier=previous?.requestId===inference.requestId&&previous.position>=inference.position?previous:{...inference}
  }
  private deliveryBinding(packet:DecisionMemory.Packet) {
    const packetHash='sha256:'+operationHash(packet)
    return {relative:`evidence/memory-delivery/${packetHash.slice(7)}.json`,value:{format:'autofold.decision-memory-delivery-binding.v1',packetHash,
      manifestHash:packet.sourceManifest.manifestHash,scope:packet.sourceManifest.scope}}
  }
  /** A new job may see original tool receipts without executing their tools.
   * Verify the host-published exact packet binding, not merely a manifest whose
   * source inventory alone cannot authenticate scores or other packet fields. */
  private async rehydrateDelivery(raw:unknown,epoch:number,inference:RuntimeToolDelivery['inference']) {
    let accepted=false
    this.delivered=undefined
    try {
      const packet=DecisionMemory.Packet.parse(raw),binding=packet.sourceManifest
      if(operationHash(packet)!==operationHash(raw))return
      const {experiment,campaign}=await this.host.scope()
      if(binding.scope.projectId!==this.options.projectId||binding.scope.experimentId!==experiment.id||binding.scope.campaignId!==campaign.id||binding.publicationStatus!=='available')return
      const manifestBytes=await fs.readFile(await checkedPath(this.options.workspace,this.root+'/'+binding.manifestPath))
      if('sha256:'+createHash('sha256').update(manifestBytes).digest('hex')!==binding.manifestHash)return
      const manifest=DecisionMemory.SourceManifest.parse(JSON.parse(manifestBytes.toString('utf8')))
      if('sha256:'+operationHash(manifest)!==binding.manifestHash||manifest.snapshotHash!==binding.snapshotHash||operationHash(manifest.scope)!==operationHash(binding.scope))return
      const receipt=this.deliveryBinding(packet),original=await fs.readFile(await checkedPath(this.options.workspace,this.root+'/'+receipt.relative),'utf8')
      if(original!==canonicalOperationJSON(receipt.value))return
      if(epoch!==this.memoryEpoch||!this.canRehydrate(inference)||this.prepared)return
      this.delivered={packet:structuredClone(packet),manifest};accepted=true
    }catch{/* Missing or changed immutable delivery evidence grants no exposure. */}
    finally{if(!accepted&&epoch===this.memoryEpoch)this.invalidateDelivery(inference)}
  }
  private async prepareMemory(state:Awaited<ReturnType<ResearchStore['read']>>,campaignId:string,experimentId:string,query?:DecisionMemory.Query) {
    const memory=await prepareDecisionMemory({...this.options,state,campaignId,experimentId,previousManifest:this.previousManifest,
      query:query??{maxFacts:4,maxInterpretations:4}})
    const publicationGaps=await publishDecisionMemory(this.options.workspace,this.root,memory)
    const receipt=this.deliveryBinding(memory.packet)
    try {
      const file=await checkedPath(this.options.workspace,this.root+'/'+receipt.relative),bytes=canonicalOperationJSON(receipt.value)
      await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
      try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o400})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
      if(await fs.readFile(file,'utf8')!==bytes)throw new Error('Immutable decision-memory delivery binding bytes changed')
    }catch(error){publicationGaps[receipt.relative]=error instanceof Error?error.message:String(error)}
    this.memoryEpoch++;this.allowRehydration=false;this.rehydrationBarrier=undefined
    this.prepared={packet:structuredClone(memory.packet),manifest:structuredClone(memory.sourceManifest)}
    this.previousManifest=memory.sourceManifest
    return {memory,publicationGaps}
  }
  /** Current bounded advisory packet for a post-closeout decision; shares the read_context kernel. */
  async refreshDecisionMemory(query:DecisionMemory.Query={maxFacts:4,maxInterpretations:4}) {
    this.clearMemoryAcknowledgement()
    await this.options.lifecycle?.checkCancelled()
    await this.host.initialize()
    await this.host.verifyTargetReferences()
    const {state,experiment,campaign}=await this.host.scope()
    const boundedQuery=DecisionMemory.Query.parse({maxFacts:4,maxInterpretations:4,...query})
    const {memory,publicationGaps}=await this.prepareMemory(state,campaign.id,experiment.id,boundedQuery)
    return {status:'available' as const,decisionMemory:memory.packet,memoryPreparation:memory.preparation,publicationGaps}
  }
  projectedQuestions(state: Awaited<ReturnType<ResearchStore['read']>>, campaignId: string) {
    return ResearchQuestions.project(Object.values(state.searchObservations).filter(observation => observation.campaignId === campaignId),
      Object.values(state.knowledgeCycles).filter(cycle => cycle.campaignId === campaignId),
      Object.values(state.researchRequests).filter(request => request.campaignId === campaignId))
      .filter(question => question.experimentId === this.options.experimentId)
  }
  private async knowledgeReader() {
    const {experiment, campaign} = await this.host.scope()
    return new CampaignKnowledgeReader({store: this.options.store, projectId: this.options.projectId, campaignId: campaign.id,
      experimentId: experiment.id, expectedContractHash: experiment.contractHash})
  }
  async queryKnowledge(input: Parameters<CampaignKnowledgeReader['query']>[0]) {
    await this.options.lifecycle?.checkCancelled()
    return (await this.knowledgeReader()).query(input)
  }
  async readKnowledge(input: Parameters<CampaignKnowledgeReader['read']>[0]) {
    await this.options.lifecycle?.checkCancelled()
    return (await this.knowledgeReader()).read(input)
  }
  async graphOperation(kind: 'search' | 'read' | 'traverse', input: any) {
    const {experiment, campaign} = await this.host.scope()
    const reader = new ProjectKnowledgeGraph({store:this.options.store, projectId:this.options.projectId, campaignId:campaign.id, experimentId:experiment.id, expectedContractHash:experiment.contractHash})
    try { const result=await reader[kind](input);this.rememberGraph(result);return result }
    catch (error) { return {available:false, advisory:true, error:error instanceof Error?error.message:'Graph retrieval unavailable', guidance:'Preserve this evidence gap and continue independent authorized discovery; do not invent missing evidence or dispatch enrichment.'} }
  }
  private rememberGraph(result:any) {
    const retrievedAt=new Date().toISOString()
    for(const node of [result.node,...(result.items??[]),...(result.nodes??[]),...(result.planningEvidence??[]),...(result.sourceRecords??[])].filter(Boolean))
      this.graphEvidence.set(node.id,{recordHash:node.recordHash,snapshotHash:result.snapshotHash,retrievedAt})
  }
  async context(deferDelivery=false) {
    if(deferDelivery)this.clearMemoryAcknowledgement()
    await this.host.initialize()
    await this.host.verifyTargetReferences()
    const {state, experiment, campaign} = await this.host.scope()
    const expansionPublicationGaps:Record<string,string>={}
    try{await this.publishViews({state,experiment,campaign})}catch(error){expansionPublicationGaps.workspaceViews=error instanceof Error?error.message:String(error)}
    const evidence = CampaignEvidence.resolve(state, {campaignId: campaign.id, experimentId: experiment.id})
    const {memory,publicationGaps:memoryPublicationGaps}=await this.prepareMemory(state,campaign.id,experiment.id)
    const allFiles = await this.host.listFiles(), referenceRoot = this.root + '/references/'
    const referenceFiles = allFiles.filter(file => file.startsWith(referenceRoot))
    // Entry guides and frozen evidence first; the complete pinned source inventory
    // remains available through list_files/search_files rather than an eager reading list.
    const files = allFiles.filter(file => !file.startsWith(referenceRoot) || file.endsWith('/manifest.json') || file.startsWith(referenceRoot + 'frozen-target/'))
    const frozenAssets=await this.options.execution.frozenAssetReferences(experiment.id)
    await this.options.lifecycle?.checkCancelled()
    // Host metadata is advisory. Its failure must not hide the frozen experiment
    // or verified memory, and an unavailable inventory never grants admission.
    const [registryResult,capabilitiesResult]=await Promise.allSettled([
      this.options.execution.modelRegistry(),this.options.execution.capabilities(),
    ] as const)
    await this.options.lifecycle?.checkCancelled()
    const hostConfigurationGaps:Array<{source:'model_registry'|'execution_capabilities';category:'host_configuration';status:'unavailable';error:string;errorTruncated:boolean}>=[]
    const recordGap=(source:'model_registry'|'execution_capabilities',error:unknown)=>{
      const characters=Array.from((error instanceof Error?error.message:String(error)).replace(/[\u0000-\u001f\u007f]/g,' '))
      hostConfigurationGaps.push({source,category:'host_configuration',status:'unavailable',error:characters.slice(0,800).join(''),errorTruncated:characters.length>800})
    }
    const modelRegistry=registryResult.status==='fulfilled'?registryResult.value:undefined
    const executionCapabilities=capabilitiesResult.status==='fulfilled'?capabilitiesResult.value:undefined
    if(registryResult.status==='rejected')recordGap('model_registry',registryResult.reason)
    if(capabilitiesResult.status==='rejected')recordGap('execution_capabilities',capabilitiesResult.reason)
    const installedComponentIds = [...new Set([
      ...(executionCapabilities?.registeredGenerators ?? []),
      ...(executionCapabilities?.generators ?? []).filter(item => item.available === true).map(item => item.id),
    ])]
    const modelRegistryView=modelRegistry?{...ProtoModelRegistry.planningView(modelRegistry,installedComponentIds),inventoryStatus:'available' as const}:{
      inventoryStatus:'unavailable' as const,entries:[] as ReturnType<typeof ProtoModelRegistry.planningView>['entries'],entryCount:null,
      guidance:'Current native model metadata could not be retrieved. No registered model or checkpoint readiness is established by this view; validation still requires real host preflight.',
    }
    const capabilitiesView=executionCapabilities?{...executionCapabilities,inventoryStatus:'available' as const}:{
      inventoryStatus:'unavailable' as const,runtime:[],generators:[],registeredGenerators:[],
      guidance:'Current host capabilities could not be retrieved. Empty arrays are unavailable inventory, not proof that models are absent or available; validation still requires real host preflight.',
    }
    const evidenceRefs=[...evidence.ids()]
    let registryPublicationGap:string|undefined
    if(modelRegistry)try{await atomicJSON(await checkedPath(this.options.workspace,this.root+'/MODEL_REGISTRY.json'),modelRegistry)}catch(error){registryPublicationGap=error instanceof Error?error.message:String(error)}
    const result={experiment, campaign,frozenAssets,decisionMemory:memory.packet,memoryPreparation:memory.preparation,hostConfigurationGaps,publicationGaps:{...this.host.publicationGaps?.(),...expansionPublicationGaps,...memoryPublicationGaps,...(registryPublicationGap?{'MODEL_REGISTRY.json':registryPublicationGap}:{})}, authoring: {nativeTemplate:'NATIVE_TEMPLATE.py',decisionPlanSchema: 'DECISION_PLAN.schema.json', validationCreatesTrial: false, evaluationRequiresDecisionPlan: true}, modelRegistry:modelRegistryView, executionCapabilities:capabilitiesView, budgets: scientistBudgets(this.options,this.host.requests(),this.host.completedEvaluations(),state,experiment), lane: await this.host.status(), workspace: this.root, files,
      referenceFileCount: referenceFiles.length, referenceDiscovery: 'Start with API.md, NATIVE_TEMPLATE.py, the frozen decision schema and model inventory. Write and validate the smallest justified draft before expanding source exploration. Use read_model_card for the chosen component summary/configSchema; path/glob-filtered search_files and targeted offset/limit reads locate exact pinned source signatures. list_files returns bounded filename pages with nextCursor; narrow the path before paging. Resolve one construction question at a time, then write and validate a draft; use validation errors to justify further lookup.', 
      evidenceRefs:evidenceRefs.slice(0,200), evidenceRefCount:evidenceRefs.length, evidenceRefsTruncated:evidenceRefs.length>200,
      researchPolicy: {blocking: false, processing: 'separate_research', automaticCampaignScheduling: false},
      resources: CampaignResources.summarize(state, campaign.id), evidenceAuthority: 'Only persisted records and verified worker receipts establish observations; interpretations cannot upgrade their own authority.'}
    if(!deferDelivery)this.delivered=this.prepared
    return result
  }
  async publishViews(snapshot?:Awaited<ReturnType<ContextHost['scope']>>) {
    const o = this.options, {state, experiment, campaign} = snapshot??await this.host.scope()
    const history = snapshotHistory(state,experiment)
    const resources = CampaignResources.summarize(state, campaign.id)
    const views: Record<string, unknown> = {'CONTRACT.json': experiment, 'HISTORY.json': history,
      'BRANCHES.json':Object.values(state.experimentBranches).filter(row=>row.experimentId===experiment.id), 'REVIEWS.json':Object.values(state.scientistReviews).filter(row=>row.experimentId===experiment.id),
      'QUESTIONS.json': this.projectedQuestions(state, campaign.id),
      'EVIDENCE.json': [...CampaignEvidence.collect(state).values()].filter(reference => reference.campaignId === campaign.id && (!reference.experimentId || reference.experimentId === experiment.id)), 'RESOURCES.json': resources}
    for (const [name, value] of Object.entries(views)) await atomicJSON(await checkedPath(o.workspace, this.root + '/' + name), value)
    if (this.host.latestResult()) await atomicJSON(await checkedPath(o.workspace, this.root + '/latest-result.json'), this.host.latestResult())
  }
}
