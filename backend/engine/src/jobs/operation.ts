import type {ResearchDomain} from '@autofold/science-core/domain'
import type {OperationDomain} from "@autofold/science-core/operations"
import type {OperationService} from '@autofold/science-core/operation-service'
import type {ResearchState} from '@autofold/science-core/store'
import type {PiJobHandlerContext} from './index'
export type RecoveryOutcome = {kind:'complete';result:Record<string,unknown>;receiptIds:string[];terminalStatus?:'failed'|'cancelled';error?:string}|{kind:'incomplete';boundary:string}|{kind:'unresolved';effects:string[];accounting:string[];blockers:string[]}
export interface OperationSettlementPort {
  read:OperationService.Service['read'];events:OperationService.Service['events'];
  acquire(projectId:string,id:string,input:{leaseMs:number}):Promise<OperationDomain.Handle>;
  update:OperationService.Service['update'];release:OperationService.Service['release'];renew:OperationService.Service['renew'];acknowledge:OperationService.Service['acknowledge'];
}
export interface RecoveryContext {job:ResearchDomain.Job;signal:AbortSignal;operations:OperationSettlementPort;readCheckpoint(phase:string):Promise<Record<string,unknown>|undefined>;checkpoint?(phase:string,data:Record<string,unknown>):Promise<unknown>}
export interface OperationInspection {effects:string[];accounting:string[];blockers:string[];phase?:string}
export interface OperationSpec {inspect(context:RecoveryContext):Promise<OperationInspection>;recover(context:RecoveryContext):Promise<RecoveryOutcome>;run(context:PiJobHandlerContext):Promise<Record<string,unknown>>;
  /** Ordinary worker supervision after receipt settlement; never called by recovery endpoints. */
  continue?(job:ResearchDomain.Job,signal:AbortSignal):Promise<void>}
export interface RecoveryPlan {selectedJobId:string;rootJobId:string;orderedJobIds:string[];blockers:Array<{jobId:string;code:string;detail:string}>;mode:'receipt_only'}
export function planOriginalRecovery(state:Readonly<ResearchState>,selectedJobId:string):RecoveryPlan {
  const plan:RecoveryPlan={selectedJobId,rootJobId:selectedJobId,orderedJobIds:[],blockers:[],mode:'receipt_only'},selected=state.jobs[selectedJobId]
  if(!selected){plan.blockers.push({jobId:selectedJobId,code:'missing_job',detail:'Selected original job is absent'});return plan}
  const seen=new Set<string>();let current=selected
  while(typeof current.payload.parentJobId==='string'){
    if(seen.has(current.id)){plan.blockers.push({jobId:current.id,code:'cyclic_ancestry',detail:'Original recovery ancestry is cyclic'});return plan}seen.add(current.id)
    const parent=state.jobs[current.payload.parentJobId]
    if(!parent||parent.payload.runtime!=='autofold-pi.v1'||parent.projectId!==selected.projectId){plan.blockers.push({jobId:current.id,code:'missing_ancestor',detail:'Original ancestor is missing or belongs to another runtime/project'});return plan}
    if(['interrupted','recovery_required','cancelled'].includes(parent.status)||parent.status==='running'&&!!parent.leaseExpiresAt&&Date.parse(parent.leaseExpiresAt)<=Date.now())plan.rootJobId=parent.id
    current=parent
  }
  const visit=(id:string,path:Set<string>)=>{if(path.has(id)){plan.blockers.push({jobId:id,code:'cyclic_descendants',detail:'Original ownership descendants are cyclic'});return}plan.orderedJobIds.push(id);const next=new Set(path).add(id);for(const child of Object.values(state.jobs).filter(job=>job.payload.parentJobId===id)){if(child.payload.runtime!=='autofold-pi.v1'||child.projectId!==selected.projectId){plan.blockers.push({jobId:child.id,code:'foreign_descendant',detail:'Original descendant belongs to another runtime/project'});continue}visit(child.id,next)}}
  visit(plan.rootJobId,new Set());return plan
}
