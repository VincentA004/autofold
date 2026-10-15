import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {runInspection,containmentCommand,InspectionContainmentUnavailableError,type InspectionBoundary} from './inspection-boundary'
import {ProtoRuntimeInspection} from './proto-inspection'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
// Explicit trusted stdlib CPU fixtures, not a production containment fallback.
const fixtureBoundary:InspectionBoundary={containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}
async function fixture(source:string){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'inspection-boundary-test-')));roots.push(root);const workerRoot=path.join(root,'worker');await fs.mkdir(path.join(workerRoot,'autofold_worker'),{recursive:true});await fs.writeFile(path.join(workerRoot,'autofold_worker/__init__.py'),'');await fs.writeFile(path.join(workerRoot,'autofold_worker/inspection.py'),source);return {root,workerRoot,boundary:{...fixtureBoundary,workerRoot}}}
test('unsupported inspection platforms fail closed instead of silently using environment flags',async()=>{
 await expect(containmentCommand(['python3'],os.tmpdir(),[], 'freebsd')).rejects.toBeInstanceOf(InspectionContainmentUnavailableError)
})
test('inspection never passes ambient credentials and uses disposable scratch',async()=>{
 const f=await fixture("import json,os,pathlib\np=pathlib.Path(os.environ['TMPDIR'])/'scratch';p.write_text('cpu')\nprint(json.dumps({'key':os.environ.get('AUTOFOLD_TEST_SECRET'),'scratch':str(p),'value':p.read_text()}))")
 process.env.AUTOFOLD_TEST_SECRET='never-pass'
 try {const result=await runInspection('python3','discover',[],undefined,f.boundary);expect(result.code).toBe(0);const observed=JSON.parse(result.stdout);expect(observed.key).toBeNull();expect(observed.value).toBe('cpu');expect(await Bun.file(observed.scratch).exists()).toBe(false)}finally{delete process.env.AUTOFOLD_TEST_SECRET}
})
test('finite inspection deadlines, output limits and abort terminate before further effects',async()=>{
 const f=await fixture("import time\ntime.sleep(60)")
 await expect(runInspection('python3','discover',[],undefined,{...f.boundary,timeoutMs:100})).rejects.toThrow('finite lifecycle')
 await fs.writeFile(path.join(f.workerRoot,'autofold_worker/inspection.py'),"print('x'*100000)")
 await expect(runInspection('python3','discover',[],undefined,{...f.boundary,maximumOutputBytes:256})).rejects.toThrow('bounded byte limit')
 await fs.writeFile(path.join(f.workerRoot,'autofold_worker/inspection.py'),"import time\ntime.sleep(60)")
 const controller=new AbortController();const pending=runInspection('python3','discover',[],undefined,{...f.boundary,signal:controller.signal});setTimeout(()=>controller.abort(new Error('explicit fixture abort')),100)
 await expect(pending).rejects.toThrow('explicit fixture abort')
})
test('OS inspection either denies an outside write or fails closed when the host primitive is denied',async()=>{
 const f=await fixture("import pathlib,sys\npathlib.Path(sys.argv[-1]).write_text('unauthorized')")
 const marker=path.join(f.root,'outside.txt');await fs.writeFile(marker,'original immutable input')
 try {const result=await runInspection('python3','extract',[marker],undefined,{workerRoot:f.workerRoot});expect(result.code).not.toBe(0)}catch(error){expect(String(error)).toMatch(/containment|sandbox|absent|unsupported|inspection/i)}
 expect(await fs.readFile(marker,'utf8')).toBe('original immutable input')
})
test('construction cache keys exact source and capability identity, clone results and final launch may force fresh inspection',async()=>{
 const markerRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'inspection-cache-test-')));roots.push(markerRoot);const marker=path.join(markerRoot,'count')
 const value={generation:null,nativeSearch:null,generatorPreflight:{generators:[]},program:{kind:'native',optimizerCount:0,constructCount:0,generatorCount:0,proposalSources:[],fixedSequences:[],programResultCount:null,optimizerSamples:[]},diagnostics:[],legacyWorkflow:null,staticConstruction:null,declaration:{intent:'optimize'},hypothesis:'Offline CPU fixture'}
 const f=await fixture(`import json,pathlib\np=pathlib.Path(${JSON.stringify(marker)});p.write_text((p.read_text() if p.exists() else '')+'x')\nprint(${JSON.stringify(JSON.stringify(value))})`)
 const program=path.join(f.root,'trial.py');await fs.writeFile(program,'# exact immutable fixture bytes')
 const first=await ProtoRuntimeInspection.describeTrial(program,'python3',{},f.boundary);first.hypothesis='caller mutation'
 expect((await ProtoRuntimeInspection.describeTrial(program,'python3',{},f.boundary)).hypothesis).toBe(value.hypothesis);expect(await fs.readFile(marker,'utf8')).toBe('x')
 await ProtoRuntimeInspection.describeTrial(program,'python3',{}, {...f.boundary,cache:false});expect(await fs.readFile(marker,'utf8')).toBe('xx')
 await fs.appendFile(program,'\n# new source');await ProtoRuntimeInspection.describeTrial(program,'python3',{},f.boundary);expect(await fs.readFile(marker,'utf8')).toBe('xxx')
 await expect(ProtoRuntimeInspection.describeTrial(program,'python3',{}, {workerRoot:f.workerRoot})).rejects.toThrow()
 expect(await fs.readFile(marker,'utf8')).toBe('xxx')
})

test('adapter setup itself has a finite deadline and cannot start a child after timeout',async()=>{
 const f=await fixture("raise AssertionError('late adapter must not launch')")
 let scratch:string|undefined
 const start=performance.now()
 await expect(runInspection('python3','discover',[],undefined,{...f.boundary,timeoutMs:50,containment:async(_command,directory)=>{scratch=directory;return new Promise(()=>{})}})).rejects.toThrow('finite lifecycle')
 expect(performance.now()-start).toBeLessThan(1000)
 expect(await Bun.file(scratch!).exists()).toBe(false)
})
test('an escaped short-lived fixture holding inherited pipes cannot postpone caller timeout',async()=>{
 const markerRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'inspection-escape-test-')));roots.push(markerRoot);const pidFile=path.join(markerRoot,'pid')
 const f=await fixture(`import os,subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(0.8)'],start_new_session=True)\nopen(${JSON.stringify(pidFile)},'w').write(str(p.pid))\ntime.sleep(60)`)
 const start=performance.now()
 try {
   await expect(runInspection('python3','discover',[],undefined,{...f.boundary,timeoutMs:200})).rejects.toThrow('finite lifecycle')
   expect(performance.now()-start).toBeLessThan(650)
 }finally{if(await Bun.file(pidFile).exists()){const pid=Number(await fs.readFile(pidFile,'utf8'));try{process.kill(pid,'SIGKILL')}catch{}}}
})
