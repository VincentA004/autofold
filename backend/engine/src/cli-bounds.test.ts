import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Application} from './application'
import {runCLI} from './cli'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true})})
test('campaign CLI preserves explicit discovery/replay/model/time grants without executing work',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'campaign-cli-bounds-'));roots.push(workspace)
 const app=new Application({workspace,projectId:'prj_cli_bounds'})
 const campaign=await app.research.createCampaign(app.projectId,{objective:'Offline CLI admission only'});await app.research.activateCampaign(app.projectId,campaign.id)
 const output:string[]=[],errors:string[]=[]
 const args=['campaign','run',campaign.id,'--workspace',workspace,'--project',app.projectId,'--request-id','cli-bounds',
 '--max-steps','20','--max-trajectories','14','--max-discovery-trajectories','8','--reserve-replay-trajectories','6','--discovery-batch-size','2',
 '--max-knowledge-refreshes','4','--per-child-cost','1','--max-cost','5','--timeout-ms','60000']
 expect(await runCLI(args,x=>output.push(x),x=>errors.push(x))).toBe(0)
 const job=JSON.parse(output[0]!)
 expect(job.status).toBe('queued');expect(job.payload.maximumDiscoveryTrajectories).toBe(8);expect(job.payload.reservedReplayTrajectories).toBe(6)
 expect(job.payload.discoveryBatchSize).toBe(2);expect(job.payload.maximumKnowledgeRefreshes).toBe(4)
 expect(job.payload.modelBudgetUsd).toBe(5);expect(job.payload.perChildModelBudgetUsd).toBe(1);expect(job.payload.maximumDurationMs).toBe(60000)
 expect(errors).toEqual([]);expect(Object.keys((await app.store.read(app.projectId)).runs)).toHaveLength(0)
 const invalid=[...args];invalid[invalid.indexOf('--request-id')+1]='invalid-reserve';invalid[invalid.indexOf('--reserve-replay-trajectories')+1]='15'
 expect(await runCLI(invalid,()=>{},x=>errors.push(x))).toBe(1)
 expect((await app.jobs.list())).toHaveLength(1)
})
