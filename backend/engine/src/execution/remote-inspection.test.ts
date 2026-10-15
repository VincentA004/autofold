import {test,expect,afterEach} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {remoteInspectionPayload,parseRemoteInspectionResult,remoteInspectionBootstrap} from './remote-inspection'
import {runInspection} from './inspection-boundary'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const profile={python:'/selected/venv/bin/python',protoRoot:'/selected/proto',inspectionBubblewrap:'/selected/bwrap',inspectionBubblewrapSha256:'a'.repeat(64)}
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'remote-inspection-port-'));roots.push(root);await fs.mkdir(path.join(root,'autofold_worker'));await fs.writeFile(path.join(root,'autofold_worker/__init__.py'),'');await fs.writeFile(path.join(root,'autofold_worker/inspection.py'),'# trusted');return root}
test('remote inspection payload sends only selected byte-bound sources and targets',async()=>{
 const root=await fixture(),program=path.join(root,'trial.py'),target=path.join(root,'target.json');await fs.writeFile(program,'# authored');await fs.writeFile(target,'{"target":"frozen"}');await fs.writeFile(path.join(root,'secret.json'),'do not transport')
 const payload=await remoteInspectionPayload({python:'ignored local',command:'describeTrial',args:[program],input:JSON.stringify({targetArtifactPath:target}),workerRoot:root,protoRoot:'/local/proto',timeoutMs:1000,maximumOutputBytes:4096,signal:new AbortController().signal},profile)
 expect(Object.keys(payload.sources).sort()).toEqual(['autofold_worker/__init__.py','autofold_worker/inspection.py']);expect(Buffer.from(payload.program!,'base64').toString()).toBe('# authored');expect(Buffer.from(payload.targets.targetArtifactPath!,'base64').toString()).toBe('{"target":"frozen"}');expect(payload.protoRoot).toBe(profile.protoRoot);expect(JSON.stringify(payload)).not.toContain('do not transport')
})
test('remote inspection refuses symlink shadows and unpinned host primitive',async()=>{
 const root=await fixture();const request={python:'python3',command:'probe',args:[],input:undefined,workerRoot:root,timeoutMs:1000,maximumOutputBytes:4096,signal:new AbortController().signal}
 await expect(remoteInspectionPayload(request,{python:'python3'})).rejects.toThrow('pinned bubblewrap')
 await fs.symlink('/etc/passwd',path.join(root,'autofold_worker/shadow.py'));await expect(remoteInspectionPayload(request,profile)).rejects.toThrow('symbolic link')
})
test('remote inspection executor is within finite lifecycle and observes cancellation',async()=>{
 const root=await fixture();let aborted=false
 const start=performance.now();await expect(runInspection('python3','probe',[],undefined,{workerRoot:root,timeoutMs:50,execute:request=>new Promise((_resolve,reject)=>{request.signal.addEventListener('abort',()=>{aborted=true;reject(request.signal.reason)},{once:true})})})).rejects.toThrow('finite lifecycle');expect(aborted).toBe(true);expect(performance.now()-start).toBeLessThan(1000)
})
test('remote inspection parser rejects corrupt response and bootstrap has explicit OS denials',()=>{
 expect(()=>parseRemoteInspectionResult('{"code":0,"stdout":1,"stderr":""}')).toThrow('invalid');expect(parseRemoteInspectionResult('{"code":0,"stdout":"{}","stderr":""}').code).toBe(0)
 for(const policy of ['--unshare-all','--remount-ro','RLIMIT_CPU','RLIMIT_AS','bubblewrapSha256','PYTHONNOUSERSITE','--cap-drop'])expect(remoteInspectionBootstrap).toContain(policy)
 expect(remoteInspectionBootstrap).not.toContain("str(venv),request.get('protoRoot')")
})

test('contained inspection serializes bounded BLAS thread settings without relaxing process limits',()=>{
 for(const variable of ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'])expect(remoteInspectionBootstrap).toContain(`'${variable}':'1'`)
 expect(remoteInspectionBootstrap).toContain('resource.setrlimit(resource.RLIMIT_NPROC,(256,256))')
 expect(remoteInspectionBootstrap).toContain("'CUDA_VISIBLE_DEVICES':''")
 expect(remoteInspectionBootstrap).toContain("'HF_HUB_OFFLINE':'1'")
 expect(remoteInspectionBootstrap).not.toContain('os.environ.copy()')
})

test('inspection binds generator construction defaults to worker profile without mounting model assets',async()=>{
 const root=await fixture(),request={python:'ignored',command:'discover',args:[],input:undefined,workerRoot:root,timeoutMs:1000,maximumOutputBytes:4096,signal:new AbortController().signal}
 const bound={...profile,boltzgenExecutable:'/selected/model/bin/boltzgen',boltzgenCache:'/selected/model-cache',pxdesignExecutable:'/selected/px/bin/pxdesign'}
 const payload=await remoteInspectionPayload(request,bound)
 expect(payload.runtimePaths).toEqual({AUTOFOLD_BOLTZGEN_EXECUTABLE:bound.boltzgenExecutable,AUTOFOLD_BOLTZGEN_CACHE:bound.boltzgenCache,AUTOFOLD_PXDESIGN_EXECUTABLE:bound.pxdesignExecutable})
 expect(remoteInspectionBootstrap).toContain('env.update(runtime_paths)')
 expect(remoteInspectionBootstrap).not.toContain("mounts+=['--ro-bind',request['runtimePaths']")
 await expect(remoteInspectionPayload(request,{...profile,boltzgenExecutable:'ambient-cli'})).rejects.toThrow('absolute profile path')
})
