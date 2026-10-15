import {expect,test} from 'bun:test'
import {CampaignResources} from './campaign-resources'
import {ResearchDomain} from './domain'
import {ResearchService} from './service'
import {MemoryResearchStore} from './store'
const hash='sha256:'+'a'.repeat(64)
test('fourteen 600-second allocations admit the final slot and deny the next one, preserving failed-run charges',async()=>{
 const store=new MemoryResearchStore(),service=new ResearchService.Service(store),projectId='integer_seconds'
 const campaign=await service.createCampaign(projectId,{objective:'Exact bounded allocation'});await service.activateCampaign(projectId,campaign.id)
 const e=await service.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Allocation fixture',targetArtifactHash:hash,modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:1/6,wallTimeMinutes:15},evaluator:{id:'fixture',version:'1',sourceHash:hash,direction:'minimize',fixedSeeds:[7],submissionSize:1}}});await service.activateExperiment(projectId,e.id)
 await service.campaignResearchState(projectId,campaign.id)
 await store.mutate(projectId,s=>{s.campaignCharters[campaign.id]!.constraints.maximumCampaignGpuHours=14*(1/6)})
 for(let i=0;i<14;i++){
  const t=await service.createTrial(projectId,e.id,{hypothesis:'Independent allocation '+i,intent:i<8?'optimize':'shadow_replay',designAdapter:'mock',programPath:'trial.py',programHash:hash})
  const r=await service.beginRun(projectId,t.id,{bundlePath:'bundle.json',outputPath:'output'});await service.failRun(projectId,r.id,'Unknown execution remains charged')
 }
 const resources=CampaignResources.summarize(await store.read(projectId),campaign.id)
 expect(resources.allocatedGpuSeconds).toBe(8400);expect(resources.maximumGpuSeconds).toBe(8400);expect(resources.remainingGpuSeconds).toBe(0)
 const next=await service.createTrial(projectId,e.id,{hypothesis:'Overrun',designAdapter:'mock',programPath:'next.py',programHash:hash})
 await expect(service.beginRun(projectId,next.id,{bundlePath:'next.json',outputPath:'output'})).rejects.toMatchObject({data:{code:'campaign_gpu_budget_exhausted'}})
})
test('normalization removes conversion noise but never rounds a real grant shortage upward',()=>{
 expect(CampaignResources.gpuSeconds(14/6,'grant')).toBe(8400)
 expect(CampaignResources.gpuSeconds((600-0.01)/3600,'grant')).toBe(599)
 expect(CampaignResources.gpuSeconds((600+0.01)/3600,'reservation')).toBe(601)
 expect(CampaignResources.gpuSeconds(0,'reservation')).toBe(0)
})
