import {OperationService} from '@autofold/science-core/operation-service'
import {ResearchService} from '@autofold/science-core/service'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ResearchStore} from '@autofold/science-core/store'
import {readAccountingSession,readJobAccounting,sessionProviderAccounting,aggregateProviderAccounting,type AccountingHost} from '../jobs/accounting'
import {assertSessionAccountingComplete} from '../runtime/types'
import type {RecoveryOutcome} from '../jobs/operation'
import type {OperationDomain} from '@autofold/science-core/operations'
import {readLegacyProjection} from './auxiliary-state'

export type AuxiliaryRecoveryHost=AccountingHost&{store:ResearchStore}
export async function readAuxiliaryState<T>(host:AuxiliaryRecoveryHost,id:string,legacy?:string):Promise<{state:T|undefined;legacy:boolean}> {
  const record=await new OperationService.Service(host.store).read(host.projectId,id)
  if(record)return{state:Object.keys(record.state).length?structuredClone(record.state) as T:undefined,legacy:false}
  return{state:legacy?await readLegacyProjection<T>(legacy):undefined,legacy:true}
}
export function assertRecoveryJob(host:AuxiliaryRecoveryHost,job:ResearchDomain.Job,kind:string) {
  if(job.projectId!==host.projectId||job.payload.runtime!=='autofold-pi.v1'||job.payload.kind!==kind)throw new Error('Auxiliary recovery job identity differs')
}
export async function exactRecoverySession(host:AuxiliaryRecoveryHost,job:ResearchDomain.Job,id:string,metadata:Record<string,unknown>) {
  const session=await readAccountingSession(host,id)
  if(!session)throw new Error('Model accounting unavailable: original auxiliary session missing')
  const model=job.payload.modelSelection as {provider:string;modelId:string}
  if(session.metadata.projectId!==host.projectId||session.modelSelection.provider!==model.provider||session.modelSelection.modelId!==model.modelId||Object.entries(metadata).some(([key,value])=>session.metadata[key]!==value))throw new Error('Auxiliary recovery transcript identity differs')
  assertSessionAccountingComplete(session)
  return session
}
export async function recoveryCost(host:AuxiliaryRecoveryHost,job:ResearchDomain.Job){return(await readJobAccounting(host,job,{ignoreSettlement:true})).modelCostUsd}
export function unresolvedRecovery(error:unknown):RecoveryOutcome {
  const detail=error instanceof Error?error.message:String(error)
  return{kind:'unresolved',effects:[],accounting:detail.startsWith('Model accounting unavailable:')?[detail]:[],blockers:[detail]}
}
export function sameIdentity(left:unknown,right:unknown){return ResearchService.knowledgeRecordHash(left)===ResearchService.knowledgeRecordHash(right)}

/** SDK estimates remain visible; only original reported bills or explicit offline fixtures settle accounting. */
export async function terminalAccounting(host:AuxiliaryRecoveryHost,input:{jobId?:string;modelCostUsd:number;sessionIds:string[];fixture:boolean;originalRequestIds?:Record<string,string[]>;baselineCostUsd?:Record<string,number>}):Promise<OperationDomain.TerminalInput['accounting']> {
  try {
    if(!Number.isFinite(input.modelCostUsd)||input.modelCostUsd<0)throw new Error('Model accounting unavailable: invalid terminal estimate')
    const job=input.jobId?(await host.store.read(host.projectId)).jobs[input.jobId]:undefined
    if(!job){
      const providers:Array<{identity:string;accounting:ReturnType<typeof sessionProviderAccounting>}>=[]
      let attributedEstimate=0
      for(const id of input.sessionIds){
        const session=await readAccountingSession(host,id);if(!session)throw new Error('Model accounting unavailable: terminal session missing')
        if(session.metadata.projectId!==host.projectId||session.status==='running')throw new Error('Model accounting unavailable: original session binding is unavailable')
        assertSessionAccountingComplete(session)
        providers.push({identity:id,accounting:sessionProviderAccounting(id,session,input.originalRequestIds?.[id])})
        const baseline=input.baselineCostUsd?.[id]
        if(!input.fixture&&(baseline===undefined||!Number.isFinite(baseline)||baseline<0||session.usage.costUsd<baseline))throw new Error('Model accounting unavailable: original estimate baseline unavailable')
        attributedEstimate+=session.usage.costUsd-(baseline??0)
      }
      if(!input.fixture&&Math.abs(attributedEstimate-input.modelCostUsd)>1e-9)throw new Error('Model accounting unavailable: original estimate attribution differs')
      const providerAccounting=aggregateProviderAccounting(providers)
      return input.fixture?{kind:'known',source:'fixture',modelCostUsd:input.modelCostUsd,sessionIds:input.sessionIds,providerAccounting}:providerAccounting.status==='reported'&&providerAccounting.reportedCostUsd!==null?{kind:'known',source:'provider',modelCostUsd:input.modelCostUsd,sessionIds:input.sessionIds,providerAccounting}:{kind:'unknown',detail:'Original provider billed cost is unavailable',modelCostUsd:input.modelCostUsd}
    }
    const usage=await readJobAccounting(host,job,{ignoreSettlement:true})
    if(Math.abs(usage.modelCostUsd-input.modelCostUsd)>1e-9)throw new Error('Model accounting unavailable: terminal estimate differs from original attribution')
    if(input.fixture)return{kind:'known',source:'fixture',modelCostUsd:usage.modelCostUsd,sessionIds:input.sessionIds,...(usage.providerAccounting?{providerAccounting:usage.providerAccounting}:{})}
    if(usage.providerAccounting?.status!=='reported'||usage.providerAccounting.reportedCostUsd===null)return{kind:'unknown',detail:'Original provider billed cost is unavailable',modelCostUsd:usage.modelCostUsd}
    return{kind:'known',source:'provider',modelCostUsd:usage.modelCostUsd,sessionIds:input.sessionIds,providerAccounting:usage.providerAccounting}
  }catch(error){return{kind:'unknown',detail:error instanceof Error?error.message:String(error),...(Number.isFinite(input.modelCostUsd)&&input.modelCostUsd>=0?{modelCostUsd:input.modelCostUsd}:{})}}
}
