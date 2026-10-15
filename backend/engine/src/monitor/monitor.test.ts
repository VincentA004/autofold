import {afterEach,expect,test} from 'bun:test'
import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {longRunSnapshot} from './index'
const roots:string[]=[],dbs:Database[]=[]
afterEach(async()=>{for(const db of dbs.splice(0))db.close();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),secret='SECRET-PROMPT-PROGRAM-CREDENTIAL-ERROR'
const now=Date.parse('2026-10-03T12:00:00Z'),date='2026-10-03T11:00:00Z',a='sha256:'+'a'.repeat(64),b='sha256:'+'b'.repeat(64)
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-test-'));roots.push(root)
 await fs.mkdir(path.join(root,'.autofold/research'),{recursive:true});await fs.mkdir(path.join(root,'.autofold/pi/test'),{recursive:true})
 const r=new Database(path.join(root,'.autofold/research/test.sqlite'),{create:true}),p=new Database(path.join(root,'.autofold/pi/test/sessions.sqlite'),{create:true});dbs.push(r,p)
 r.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(collection TEXT,id TEXT,value TEXT,refs TEXT);CREATE TABLE blobs(hash TEXT,value TEXT);CREATE TABLE metadata(key TEXT,value TEXT)')
 p.exec('PRAGMA journal_mode=WAL;CREATE TABLE pi_sessions(id TEXT,state TEXT);CREATE TABLE pi_leases(session_id TEXT,owner TEXT,expires_at INTEGER);CREATE TABLE pi_journal(session_id TEXT,sequence INTEGER,event TEXT)')
 const put=(collection:string,id:string,value:unknown,refs:unknown={})=>r.query('INSERT INTO records VALUES (?,?,?,?)').run(collection,id,JSON.stringify(value),JSON.stringify(refs))
 const job=(id:string,experimentId:string,sessionId:string,more:object={})=>{const raw=JSON.stringify({kind:'autoresearch',experimentId,sessionId,prompt:secret,maximumTrajectories:4}),h=hash(raw);r.query('INSERT INTO blobs VALUES (?,?)').run(h,raw);put('jobs',id,{status:'running',leaseId:'lease_one',leaseExpiresAt:date,error:secret,...more},{payload:h,'checkpoint:private':'f'.repeat(64),result:'f'.repeat(64)})}
 put('campaigns','cmp_one',{status:'active',objective:secret})
 for(const [id,campaignId,contractHash,direction] of [['exp_one','cmp_one',a,'minimize'],['exp_two','cmp_one',b,'maximize'],['exp_other','cmp_other',a,'minimize']])put('experiments',id!,{campaignId,status:'active',contractHash,contract:{objective:secret,evaluator:{direction},budget:{gpuHours:2}}})
 for(const [id,experimentId,intent] of [['trl_one','exp_one','optimize'],['trl_two','exp_two','optimize'],['trl_shadow','exp_one','shadow_replay'],['trl_other','exp_other','optimize']])put('trials',id!,{experimentId,intent,status:'succeeded',program:secret})
 for(const [id,trialId,contractHash,score] of [['evl_one','trl_one',a,5],['evl_two','trl_two',b,10],['evl_shadow','trl_shadow',a,1],['evl_wrong','trl_one',b,-100]])put('evaluations',String(id),{trialId,contractHash,score,valid:true,evaluatedAt:date})
 put('evaluations','evl_invalid',{trialId:'trl_one',contractHash:a,score:-200,valid:false,evaluatedAt:date})
 put('runs','run_one',{trialId:'trl_one',status:'succeeded',startedAt:date,completedAt:'2026-10-03T11:01:00Z',error:secret})
 job('job_one','exp_one','ses_one');job('job_same_session','exp_one','ses_one',{status:'succeeded'});job('job_missing_lease','exp_one','ses_one',{leaseId:null,leaseExpiresAt:null});job('job_other','exp_other','ses_other')
 put('claims','clm_one',{campaignId:'cmp_one',status:'reviewed',statement:secret});put('knowledgeCycles','kcy_one',{campaignId:'cmp_one',trigger:'run_completed',question:secret});put('researchRequests','rq_one',{campaignId:'cmp_one',experimentId:'exp_one',request:secret})
 put('skillVersions','skv_one',{campaignId:'cmp_one',status:'candidate',version:2,replay:{passed:true},body:secret});put('skillLibrary','slb_one',{status:'active',sourceVersionId:'skv_one',promotedFromCampaignIds:['cmp_one','cmp_two','cmp_three']})
 const messages=[{content:secret}],state={status:'running',metadata:{projectId:'test',campaignId:'cmp_one'},updatedAt:now-3600_000,usage:{costUsd:1.25,turns:3,toolCalls:2},messages,contextCompactions:[{excerpt:secret}],error:secret}
 p.query('INSERT INTO pi_sessions VALUES (?,?)').run('ses_one',JSON.stringify(state));p.query('INSERT INTO pi_sessions VALUES (?,?)').run('ses_other',JSON.stringify({...state,metadata:{projectId:'test',campaignId:'cmp_other'}}));p.query('INSERT INTO pi_leases VALUES (?,?,?)').run('ses_one',secret,now-100);p.query('INSERT INTO pi_journal VALUES (?,?,?)').run('ses_one',1,secret)
 const dir=path.join(root,'.autofold/autoresearch/exp_one');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'scientist.json'),JSON.stringify({format:'autofold.scientist-state.v2',experimentId:'exp_one',contractHash:a,completedEvaluations:2,operation:{kind:'research',input:secret}}))
 return {root,r,put,messages}
}
async function inventory(root:string){const result:Record<string,string>={};async function walk(dir:string){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else result[path.relative(root,f)]=e.name.endsWith('-shm')?'SQLite reader coordination':hash(await fs.readFile(f,'utf8'))}}await walk(root);return result}
test('contract separated curves, redaction, once-per-session costs, leases and unchanged DB/WAL/files',async()=>{
 const f=await fixture(),before=await inventory(f.root),s=await longRunSnapshot({workspace:f.root,project:'test',campaign:'cmp_one',now})
 expect(JSON.stringify(s)).not.toContain(secret);expect(s.experiments?.map(e=>e.id)).toEqual(['exp_one','exp_two'])
 expect(s.experiments?.[0]?.reportedValidScoreCurves.optimize.map(e=>e.score)).toEqual([5]);expect(s.experiments?.[1]?.reportedValidScoreCurves.optimize.map(e=>e.score)).toEqual([10]);expect(s.experiments?.[0]?.reportedValidScoreCurves.shadow_replay.map(e=>e.score)).toEqual([1])
 expect(s.experiments?.[0]?.excludedEvaluations).toBe(2);expect(s.experiments?.[0]?.measuredCompletedRunWallSeconds).toBe(60);expect(s.experiments?.[0]?.reservedGpuContractCeilingHoursForRecordedRuns).toBe(2);expect(s.experiments?.[0]?.scientist?.pendingOperationKind).toBe('research')
 expect(s.sessions).toHaveLength(1);expect(s.recordedCompletedResponseCostUsd).toBe(1.25);expect(s.sessions?.[0]).toMatchObject({lease:'expired',idleFlag:true,turns:3,toolCalls:2,compactionCount:1,transcriptSerializedBytes:Buffer.byteLength(JSON.stringify(f.messages))})
 expect(s.jobs?.find(j=>j.id==='job_one')?.runningLeaseFlag).toBe('expired');expect(s.jobs?.find(j=>j.id==='job_missing_lease')?.runningLeaseFlag).toBe('missing');expect(s.skills?.versions[0]?.replayPassed).toBe(true);expect(s.jobs?.find(j=>j.id==='job_one')?.grants?.maximumTrajectories).toBe(4);expect(s.issues).toEqual([]);expect(await inventory(f.root)).toEqual(before)
})
test('missing/corrupt blobs produce safe diagnostics without checkpoint/result loads or source mutations',async()=>{
 const f=await fixture();f.put('jobs','job_missing',{status:'queued'},{payload:'c'.repeat(64)});f.r.query('INSERT INTO blobs VALUES (?,?)').run('d'.repeat(64),secret);f.put('jobs','job_corrupt',{status:'queued'},{payload:'d'.repeat(64)})
 const before=await inventory(f.root),s=await longRunSnapshot({workspace:f.root,project:'test',now})
 expect(s.issues).toContainEqual({code:'payload_blob_missing',recordId:'job_missing'});expect(s.issues).toContainEqual({code:'payload_blob_corrupt',recordId:'job_corrupt'});expect(JSON.stringify(s)).not.toContain(secret);expect(await inventory(f.root)).toEqual(before)
})
test('missing databases cannot create source databases/directories',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-missing-'));roots.push(root);const s=await longRunSnapshot({workspace:root,project:'missing',now});expect(s.databases.research.available).toBe(false);expect(s.databases.pi.available).toBe(false);expect(s.recordedCompletedResponseCostUsd).toBeNull();expect(await fs.readdir(root)).toEqual([])})
test('confinement rejects symlinks and invalid IDs',async()=>{const f=await fixture();await fs.symlink(path.join(f.root,'.autofold/research/test.sqlite'),path.join(f.root,'.autofold/research/alias.sqlite'));await expect(longRunSnapshot({workspace:f.root,project:'alias',now})).rejects.toThrow('symbolic link');await expect(longRunSnapshot({workspace:f.root,project:'../test',now})).rejects.toThrow('valid project')})

test('missing expected persistent session makes aggregate costs unknown',async()=>{
 const f=await fixture()
 const pi=dbs[dbs.length-1]!
 pi.query('DELETE FROM pi_sessions WHERE id=?').run('ses_one')
 const before=await inventory(f.root),s=await longRunSnapshot({workspace:f.root,project:'test',campaign:'cmp_one',now})
 expect(s.sessions).toEqual([])
 expect(s.recordedCompletedResponseCostUsd).toBeNull()
 expect(s.issues).toContainEqual({code:'missing_session',recordId:'ses_one'})
 expect(await inventory(f.root)).toEqual(before)
})


test('direct campaign needs no supervisor cost session until a durable inference intent exists',async()=>{
 const f=await fixture(),raw=JSON.stringify({kind:'campaign_loop',campaignId:'cmp_one',sessionId:'ses_lazy',prompt:secret}),h=hash(raw)
 f.r.query('INSERT INTO blobs VALUES (?,?)').run(h,raw)
 f.put('jobs','job_direct',{status:'running',leaseId:'01234567-89ab-4cde-8fab-0123456789ab',leaseExpiresAt:new Date(now+30000).toISOString()},{payload:h,'checkpoint:campaign:step:1:proposal':'f'.repeat(64)})
 const before=await inventory(f.root),direct=await longRunSnapshot({workspace:f.root,project:'test',campaign:'cmp_one',now})
 expect(direct.recordedCompletedResponseCostUsd).toBe(1.25)
 expect(direct.issues).not.toContainEqual({code:'missing_session',recordId:'ses_lazy'})
 expect(direct.jobs?.find(j=>j.id==='job_direct')?.runningLeaseFlag).toBeNull()
 expect(JSON.stringify(direct)).not.toContain(secret);expect(await inventory(f.root)).toEqual(before)
 f.r.query('UPDATE records SET refs=? WHERE collection=? AND id=?').run(JSON.stringify({payload:h,'checkpoint:campaign:step:2:supervisor-intent':'f'.repeat(64)}),'jobs','job_direct')
 const inferenceBefore=await inventory(f.root),inference=await longRunSnapshot({workspace:f.root,project:'test',campaign:'cmp_one',now})
 expect(inference.recordedCompletedResponseCostUsd).toBeNull()
 expect(inference.issues).toContainEqual({code:'missing_session',recordId:'ses_lazy'})
 expect(JSON.stringify(inference)).not.toContain(secret);expect(await inventory(f.root)).toEqual(inferenceBefore)
})
