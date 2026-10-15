import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'

export type InspectionContainmentAdapter=(command:string[],scratch:string,readPaths:string[])=>Promise<string[]>
export interface InspectionRequest {python:string;command:string;args:string[];input:string|undefined;workerRoot:string;protoRoot?:string;timeoutMs:number;maximumOutputBytes:number;signal:AbortSignal}
export interface InspectionResult {code:number;stdout:string;stderr:string}
export interface InspectionBoundary {
  /** Explicit host-selected contained executor; never inferred from authored code. */
  execute?: (request:InspectionRequest)=>Promise<InspectionResult>

  /** Explicit host capability; production never infers a permissive fallback. */
  containment?: InspectionContainmentAdapter
  containmentName?: string
  workerRoot?: string
  protoRoot?: string
  signal?: AbortSignal
  timeoutMs?: number
  maximumOutputBytes?: number
  cache?: boolean
}
export class InspectionContainmentUnavailableError extends Error {
  constructor(message: string) {super(message); this.name='InspectionContainmentUnavailableError'}
}
const environmentKeys=['LANG','LC_ALL','LC_CTYPE','SYSTEMROOT','WINDIR'] as const
const present = async (file:string) => fs.access(file).then(()=>true,()=>false)
/** Actual OS policy; environment flags are defense in depth, never a containment claim. */
export async function containmentCommand(command:string[],scratch:string,readPaths:string[],platform=process.platform,readDirectories:string[]=[]):Promise<string[]> {
  const paths=[...new Set(await Promise.all(readPaths.map(file=>fs.realpath(file))))]
  if(platform==='darwin') {
    if(!await present('/usr/bin/sandbox-exec'))throw new InspectionContainmentUnavailableError('Native inspection requires macOS sandbox-exec; no unsandboxed fallback is authorized')
    // Seatbelt compares resolved paths; TMPDIR commonly starts with the /var
    // alias even though the disposable directory lives beneath /private/var.
    const scratchRoot=await fs.realpath(scratch)
    const executable=await fs.realpath(command[0]!),executables=[executable]
    // Framework Python's launcher re-execs this one companion binary. Resolving
    // the selected interpreter must not grant execution to its entire directory.
    const framework=executable.match(/^(.*\/Python(?:3)?\.framework\/Versions\/[^/]+)\/bin\/python(?:\d+(?:\.\d+)*)?$/)
    if(framework) {
      const companion=path.join(framework[1]!,'Resources/Python.app/Contents/MacOS/Python')
      if(await present(companion))executables.push(await fs.realpath(companion))
    }
    const reads=[...paths,scratchRoot,'/usr','/System','/Library','/opt/homebrew','/private/etc/localtime','/dev/null','/dev/urandom','/dev/random'].map(file=>`(subpath ${JSON.stringify(file)})`).join(' ')
    // dyld opens '/', and Python's FileFinder lists its selected import roots.
    // These literals grant directory reads only, never sibling source contents.
    const directories=[...new Set(['/',...await Promise.all(readDirectories.map(file=>fs.realpath(file)))])]
    const policy=`(version 1)(deny default)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow file-read-data ${directories.map(file=>`(literal ${JSON.stringify(file)})`).join(' ')})(allow file-read* ${reads})(deny file-read* (subpath "/Library/Keychains"))(allow file-write* (subpath ${JSON.stringify(scratchRoot)}) (literal "/dev/null"))(allow process-fork)(allow process-exec ${executables.map(file=>`(literal ${JSON.stringify(file)})`).join(' ')})(allow signal (target self))`
    return ['/usr/bin/sandbox-exec','-p',policy,...command]
  }
  if(platform==='linux') {
    const bwrap=Bun.which('bwrap')
    if(!bwrap)throw new InspectionContainmentUnavailableError('Native inspection requires bubblewrap with supported user namespaces on Linux; no unsandboxed fallback is authorized')
    const roots=[...new Set([...paths,'/usr','/bin','/lib','/lib64','/etc/ld.so.cache','/etc/fonts'])]
    const mounts=[] as string[]
    for(const file of roots)if(await present(file))mounts.push('--ro-bind',file,file)
    return [bwrap,'--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev',...mounts,'--bind',scratch,scratch,'--remount-ro','/','--chdir',scratch,'--',...command]
  }
  throw new InspectionContainmentUnavailableError(`Native inspection containment is unsupported on ${platform}; no unsandboxed fallback is authorized`)
}
/** Kill request is evidence of attempted teardown, never proof of arbitrary descendant exit. */
export class InspectionLifecycleError extends Error {
  readonly teardown='process_group_kill_requested_descendant_exit_unverified'
  constructor(message:string){super(message);this.name='InspectionLifecycleError'}
}
/** Finite boundary includes adapter setup; pipe-owning descendants cannot delay rejection. */
export async function runInspection(python:string,command:string,args:string[],input:string|undefined,boundary:InspectionBoundary={}) {
  boundary.signal?.throwIfAborted()
  const timeoutMs=boundary.timeoutMs??30_000,maximum=boundary.maximumOutputBytes??4*1024*1024
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maximum)||maximum<1)throw new Error('Inspection bounds must be positive integers')
  const lifecycle=new AbortController()
  const abort=()=>lifecycle.abort(boundary.signal?.reason??new InspectionLifecycleError('Inspection was aborted'))
  boundary.signal?.addEventListener('abort',abort,{once:true})
  const timer=setTimeout(()=>lifecycle.abort(new InspectionLifecycleError('Inspection exceeded its finite lifecycle deadline')),timeoutMs)
  const bounded=<T>(pending:Promise<T>)=>new Promise<T>((resolve,reject)=>{
    const stop=()=>{lifecycle.signal.removeEventListener('abort',stop);reject(lifecycle.signal.reason)}
    if(lifecycle.signal.aborted){reject(lifecycle.signal.reason);return}
    lifecycle.signal.addEventListener('abort',stop,{once:true})
    pending.then(value=>{lifecycle.signal.removeEventListener('abort',stop);resolve(value)},error=>{lifecycle.signal.removeEventListener('abort',stop);reject(error)})
  })
  let scratch:string|undefined
  try {
    // A late filesystem allocation is cleaned without ever launching authored code.
    scratch=await bounded(fs.mkdtemp(path.join(os.tmpdir(),'autofold-inspection-')).then(value=>{
      if(lifecycle.signal.aborted){void fs.rm(value,{recursive:true,force:true});throw lifecycle.signal.reason}return value
    }))
    const scratchPath=scratch!
    if(boundary.execute)return await bounded(boundary.execute({python,command,args,input,workerRoot:path.resolve(boundary.workerRoot??path.resolve(import.meta.dir,'../../../worker')),protoRoot:boundary.protoRoot,timeoutMs,maximumOutputBytes:maximum,signal:lifecycle.signal}))
    const workerRoot=path.resolve(boundary.workerRoot??path.resolve(import.meta.dir,'../../../worker'))
    const executable=path.isAbsolute(python)?python:Bun.which(python)
    if(!executable)throw new Error('Inspection Python executable is absent')
    const pythonRoot=path.resolve(path.dirname(executable),'..'),realPythonRoot=path.resolve(path.dirname(await bounded(fs.realpath(executable))),'..')
    const program=args[0]&&['extract','describeTrial'].includes(command)?[path.resolve(args[0])]:[]
    const bundle=input&&command==='describeTrial'?JSON.parse(input):{}
    const targetPaths=['targetArtifactPath','targetStructurePath'].flatMap(key=>typeof bundle[key]==='string'?[bundle[key]]:[])
    const readPaths=[workerRoot,pythonRoot,realPythonRoot,...program,...targetPaths,...(boundary.protoRoot?[path.join(boundary.protoRoot,'proto_language'),path.join(boundary.protoRoot,'proto-tools/proto_tools')]:[])]
    const importDirectories=boundary.protoRoot?[boundary.protoRoot,path.join(boundary.protoRoot,'proto-tools')]:[]
    const contain=boundary.containment??((command:string[],scratch:string,reads:string[])=>containmentCommand(command,scratch,reads,process.platform,importDirectories))
    const argv=await bounded(contain([executable,'-m','autofold_worker.inspection',command,...args],scratchPath,readPaths))
    lifecycle.signal.throwIfAborted()
    const env:NodeJS.ProcessEnv=Object.fromEntries(environmentKeys.flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]))
    Object.assign(env,{PATH:path.dirname(executable)+':/usr/bin:/bin',PYTHONPATH:[workerRoot,...(boundary.protoRoot?[boundary.protoRoot,path.join(boundary.protoRoot,'proto-tools')]:[])].join(path.delimiter),
      AUTOFOLD_EXPECTED_PROTO_ROOT:boundary.protoRoot??'',PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',CUDA_VISIBLE_DEVICES:'',PROTO_HOME:path.join(scratchPath,'proto'),MPLCONFIGDIR:path.join(scratchPath,'mpl'),HF_HOME:path.join(scratchPath,'hf'),XDG_CACHE_HOME:path.join(scratchPath,'cache'),TMPDIR:scratchPath})
    return await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(argv[0]!,argv.slice(1),{env,cwd:scratchPath,detached:true,stdio:['pipe','pipe','pipe']})
      const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,settled=false
      const finish=(error?:Error,code?:number)=>{
        if(settled)return;settled=true;lifecycle.signal.removeEventListener('abort',stop)
        if(error){try{process.kill(-child.pid!,'SIGKILL')}catch{child.kill('SIGKILL')}
          child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();reject(error)
        }else resolve({code:code??1,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8').slice(-16384)})
      }
      const stop=()=>finish(lifecycle.signal.reason instanceof Error?lifecycle.signal.reason:new InspectionLifecycleError('Inspection was aborted'))
      const receive=(name:'stdout'|'stderr',data:Buffer)=>{if(settled)return;bytes+=data.length;if(bytes>maximum){finish(new InspectionLifecycleError('Inspection output exceeds its bounded byte limit'));return}if(name==='stdout')stdout.push(data);else stderr.push(data)}
      child.stdout.on('data',data=>receive('stdout',data));child.stderr.on('data',data=>receive('stderr',data))
      lifecycle.signal.addEventListener('abort',stop,{once:true});if(lifecycle.signal.aborted)stop()
      child.once('error',error=>finish(error));child.once('close',code=>finish(undefined,code??1))
      child.stdin.on('error',()=>{});if(!settled)child.stdin.end(input)
    })
  } finally {
    clearTimeout(timer);boundary.signal?.removeEventListener('abort',abort)
    // Cleanup completion is bounded; no assertion of descendant shutdown is made.
    if(scratch)await Promise.race([fs.rm(scratch,{recursive:true,force:true}),new Promise<void>(resolve=>{const cleanup=setTimeout(resolve,250);cleanup.unref()})])
  }
}
