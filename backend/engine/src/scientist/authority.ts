import {createHash} from 'node:crypto'
import type {ResearchStore} from '@autofold/science-core/store'
import type {ResearchDomain} from '@autofold/science-core/domain'
const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** One canonical CAS register for original scientist intents. JSON is an export only.
 * Legacy pending effects are held; reading never guesses, dispatches or migrates them. */
export class ScientistAuthority {
  private revision=0
  constructor(private readonly options:{store:ResearchStore;projectId:string;experimentId:string;sessionId:string}){}
  private get key(){return this.options.experimentId+':'+this.options.sessionId}
  async read():Promise<Record<string,any>|undefined>{
    const state=await this.options.store.read(this.options.projectId),record=state.scientistLanes[this.key]
    if(!record)return
    const experiment=state.experiments[this.options.experimentId]
    if(record.format!=='autofold.scientist-authority.v1'||record.experimentId!==experiment?.id||record.contractHash!==experiment.contractHash||record.sessionId!==this.options.sessionId||!Number.isInteger(record.revision)||Number(record.revision)<1||!record.state||record.stateHash!==digest(record.state))throw new Error('Canonical scientist request register integrity changed')
    const value=record.state as Record<string,any>
    if(value.format!=='autofold.scientist-state.v2'||value.experimentId!==experiment.id||value.contractHash!==experiment.contractHash||value.sessionId!==this.options.sessionId||!value.requests||typeof value.requests!=='object')throw new Error('Canonical scientist register identity differs')
    for(const [key,intent] of Object.entries(value.requests) as Array<[string,any]>){
      if(!intent||typeof intent.requestId!=='string'||key!==createHash('sha256').update(intent.requestId).digest('hex'))throw new Error('Canonical scientist request identity differs')
      const trial=intent.trialId&&state.trials[intent.trialId]
      if(intent.trialId&&(!trial||trial.experimentId!==experiment.id||trial.programHash!==intent.programHash||trial.programPath!==intent.programPath))throw new Error('Canonical scientist trial binding differs')
      const run=intent.result?.runId&&state.runs[intent.result.runId]
      if(intent.result?.runId&&(!run||run.trialId!==intent.trialId))throw new Error('Canonical scientist result binding differs')
    }
    this.revision=Number(record.revision)
    return structuredClone(record.state as Record<string,any>)
  }
  get currentRevision(){return this.revision}
  checkProjection(projection:Record<string,any>,canonical:Record<string,any>){
    if(projection.experimentId!==canonical.experimentId||projection.contractHash!==canonical.contractHash||projection.sessionId!==canonical.sessionId)throw new Error('Scientist projection is bound to another original identity')
    if(Number(projection.authorityRevision??0)>this.revision)throw new Error('Scientist projection contains a newer unknown original authority revision')
    if(Object.keys(projection.requests??{}).some(key=>!Object.hasOwn(canonical.requests,key)))throw new Error('Scientist projection retains unknown original requests; explicit reconciliation is required')
    if(Number(projection.authorityRevision??0)===this.revision&&(['requests','operation','stopped','completedEvaluations'] as const).some(key=>JSON.stringify(projection[key])!==JSON.stringify(canonical[key])))throw new Error('Scientist projection conflicts with its canonical original request register')
  }
  async load(experiment:ResearchDomain.Experiment,legacy?:Record<string,any>,options:{readOnly?:boolean}={}){
    const canonical=await this.read();if(canonical)return canonical
    if(legacy){
      if(legacy.format!=='autofold.scientist-state.v2'||legacy.experimentId!==experiment.id||legacy.contractHash!==experiment.contractHash||legacy.sessionId!==this.options.sessionId||!legacy.requests||typeof legacy.requests!=='object')throw new Error('Legacy scientist state binding differs from frozen experiment')
      // Unknown old intents have no canonical CAS origin. Preserve their JSON and all effects.
      if(Object.keys(legacy.requests).length||legacy.operation)throw new Error('Legacy scientist authority unresolved: original request register requires explicit receipt-bound migration; no effects were resumed')
    }
    const value=legacy??{format:'autofold.scientist-state.v2',experimentId:experiment.id,contractHash:experiment.contractHash,sessionId:this.options.sessionId,completedEvaluations:0,stopped:false,researchRequested:false,requests:{}}
    if(!options.readOnly)await this.save(value)
    return structuredClone(value)
  }
  async save(value:Record<string,any>){
    const {phase,status,trialId,runId,score,error,reason,rationale,evidenceRefs,programFingerprint,semanticProgramFingerprint,workflowFingerprint,memoryRevision,updatedAt,iteration,mutableTrialPath,authorityRevision,...authority}=value
    value=authority
    const o=this.options,expected=this.revision,next=expected+1
    await o.store.mutate(o.projectId,state=>{
      const experiment=state.experiments[o.experimentId],prior=state.scientistLanes[this.key]
      if(!experiment||experiment.contractHash!==value.contractHash||experiment.piScientistSessionId!==o.sessionId)throw new Error('Scientist canonical scope changed')
      if(Number(prior?.revision??0)!==expected)throw new Error('Scientist canonical request register changed concurrently')
      state.scientistLanes[this.key]={format:'autofold.scientist-authority.v1',experimentId:o.experimentId,contractHash:experiment.contractHash,sessionId:o.sessionId,revision:next,state:structuredClone(value),stateHash:digest(value)}
    })
    this.revision=next;return next
  }
}
