import type {createAcceptanceHarness} from './harness'
import type {PublicObservation} from './oracle'
type Harness=Awaited<ReturnType<typeof createAcceptanceHarness>>
export async function observePublicWorkflow(h:Harness,experimentId:string,campaignId:string):Promise<PublicObservation> {
  const [history,jobs,campaign]=await Promise.all([h.api('/research/experiments/'+experimentId+'/history'),h.api('/research/jobs'),h.api('/research/campaigns/'+campaignId+'/status')])
  const sessionIds=[...new Set(jobs.map((job:any)=>job.payload?.sessionId).filter(Boolean))] as string[]
  const sessions=await Promise.all(sessionIds.map(id=>h.api('/research/sessions/'+id,undefined,true)))
  const modelRequests=sessions.flatMap(session=>Object.entries(session?.modelRequests??{}).map(([id,row]:[string,any])=>({id,upstreamRequestId:row.providerBilling?.upstreamRequestId,status:row.status,reportedCostUsd:row.providerBilling?.reportedCostUsd,estimatedCostUsd:row.estimatedCostUsd})))
  const running=jobs.some((job:any)=>['queued','running','interrupted','recovery_required'].includes(job.status))
  const trials=history.trials??[],runs=history.runs??[]
  const campaignJobs=jobs.filter((job:any)=>job.payload?.kind==='campaign_loop'&&job.payload?.campaignId===campaignId)
  const settledCampaign=campaignJobs.find((job:any)=>job.status==='succeeded'&&job.result?.status==='exhausted'&&job.result?.remainingTrajectories===0&&job.result?.remainingDiscoveryTrajectories===0)
  return {at:new Date().toISOString(),campaignStatus:campaign.observation?.campaign?.status??'unknown',completed:!!settledCampaign&&!running,trialIds:trials.map((trial:any)=>trial.id),runs:runs.map((run:any)=>({id:run.id,trialId:run.trialId,status:run.status,manifestHash:run.manifestHash})),modelRequests,reportedCostUsd:modelRequests.reduce((sum,row)=>sum+(row.reportedCostUsd??0),0),estimatedCostUsd:sessions.reduce((sum,session)=>sum+(session?.usage?.costUsd??0),0),holdReason:jobs.filter((job:any)=>['interrupted','recovery_required','failed'].includes(job.status)).map((job:any)=>job.error??job.status).join('; ')||undefined}
}
