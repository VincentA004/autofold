import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import z from 'zod'
import {workerTreeIdentity} from './index'
import {fileHash} from './provenance'
import {assertSafeTree} from './paths'
import {ReceiptUnresolvedError, type Dispatch, type ExecutionTransport, type TransportCompletion} from './transport'
import {processPlanHash} from './process-plan'

const workerRoot = path.resolve(import.meta.dir, '../../../worker')
const Receipt=z.object({runId:z.string(),bundleHash:z.string(),workerHash:z.string(),planHash:z.string(),
  state:z.enum(['absent','launching','running','succeeded','failed','cancelled','timed_out']),exitCode:z.number().int().nullable().optional(),completedAt:z.number().finite().positive().optional()}).passthrough().superRefine((receipt,context)=>{
    if(['succeeded','failed','cancelled','timed_out'].includes(receipt.state)&&receipt.completedAt===undefined)context.addIssue({code:'custom',message:'Terminal local receipt lacks completion time'})
    if(receipt.state==='succeeded'&&receipt.exitCode!==0)context.addIssue({code:'custom',message:'Successful local receipt lacks a zero exit code'})
    // A zero exit with a missing required manifest is a legitimate failed worker.
  })
const unresolved=(runId:string,error:unknown)=>error instanceof ReceiptUnresolvedError?error:new ReceiptUnresolvedError(runId,error instanceof Error?error.message:String(error))
/** Same durable, independent process supervisor used remotely. The host owns no timeout timer. */
export class DurableLocalTransport implements ExecutionTransport {
  readonly kind = 'local' as const
  private root(input: Dispatch) {return path.join(path.dirname(input.outputPath),`.local-control-${input.runId}`)}
  private async plan(input: Dispatch) {
    const root = await fs.realpath(this.root(input))
    const plan = await Bun.file(path.join(root,'remote-plan.json')).json()
    if (plan.runId !== input.runId || plan.timeoutMs !== input.timeoutMs || plan.workingDirectory !== await fs.realpath(input.workspace) || plan.outputPath !== path.resolve(input.outputPath) || plan.authorizationDeadlineMs !== input.authorizationDeadlineMs || JSON.stringify(plan.originalCommand)!==JSON.stringify(input.command) || input.runtimeEnvironment && processPlanHash(plan.environment) !== processPlanHash(input.runtimeEnvironment)) throw new ReceiptUnresolvedError(input.runId,'Original local plan binding differs')
    if (input.workerHash && plan.workerHash !== input.workerHash) throw new ReceiptUnresolvedError(input.runId,'Original local worker closure differs')
    if (await Bun.file(input.bundlePath).exists() && plan.bundleHash !== await fileHash(input.bundlePath)) throw new ReceiptUnresolvedError(input.runId,'Original local bundle differs')
    return {root,plan}
  }
  private async control(input: Dispatch, action: 'launch'|'status'|'cancel'|'adopt') {
    try {return await this.controlReceipt(input,action)}catch(error){throw unresolved(input.runId,error)}
  }
  private async controlReceipt(input: Dispatch, action: 'launch'|'status'|'cancel'|'adopt') {
    const {root,plan} = await this.plan(input)
    const script = path.join(root,'worker/autofold_worker/remote_supervisor.py')
    const command = [script,action,'--directory',root,'--bundle-hash',plan.bundleHash,'--worker-hash',plan.workerHash,'--plan-hash',processPlanHash(plan),
      // A missing receipt after launch is uncertain. Only the original worker
      // may acknowledge cancellation; never fabricate a no-launch tombstone.
      ...(action==='cancel'?['--require-cancel-ack']:[])]
    const child = spawn(plan.controlPython,command,{stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
    let stdout='',stderr=''
    child.stdout.on('data',data=>{stdout += data.toString();if(stdout.length>65536) child.kill()})
    child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-8000)})
    const timer=setTimeout(()=>child.kill('SIGKILL'),20_000)
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>clearTimeout(timer))
    if(code!==0) throw new ReceiptUnresolvedError(input.runId,stderr||'Local control receipt unavailable')
    let receipt:z.infer<typeof Receipt>
    try {receipt=Receipt.parse(JSON.parse(stdout))}
    catch {throw new ReceiptUnresolvedError(input.runId,'Local supervisor returned an invalid control receipt')}
    if(receipt.runId!==input.runId||receipt.bundleHash!==plan.bundleHash||receipt.workerHash!==plan.workerHash||receipt.planHash!==processPlanHash(plan))throw new ReceiptUnresolvedError(input.runId,'Local receipt identity differs')
    return receipt
  }
  async preflight(input: Dispatch) {
    if(!Number.isFinite(input.timeoutMs)||input.timeoutMs<=0||input.timeoutMs>Number.MAX_SAFE_INTEGER)throw new Error('Worker wall-time timeout must be positive, finite, and safely representable')
    input.signal?.throwIfAborted()
    const destination=this.root(input)
    if(await Bun.file(path.join(destination,'remote-plan.json')).exists()){await this.plan(input);return}
    await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700})
    const temporary=await fs.mkdtemp(destination+'.tmp.')
    try {
      const scientific=input.command[1]?.endsWith('/run_worker.py') === true
      const source=scientific ? path.dirname(input.command[1]!) : workerRoot
      await assertSafeTree(path.dirname(source),source)
      await fs.cp(source,path.join(temporary,'worker'),{recursive:true,filter:value=>!value.includes('__pycache__')&&!value.includes('/tests')})
      const identity=await workerTreeIdentity(path.join(temporary,'worker'))
      if(input.workerHash&&identity.sourceHash!==input.workerHash)throw new Error('Frozen local worker changed during staging')
      if(await Bun.file(input.bundlePath).exists()) {
        const bundle=await Bun.file(input.bundlePath).json()
        for(const name of ['bundle.json',bundle.programPath,bundle.targetArtifactPath,bundle.targetStructurePath].filter((item):item is string=>!!item)) {
          if(path.basename(name)!==name)throw new Error('Local frozen resources require portable leaf names')
          await fs.copyFile(path.join(path.dirname(input.bundlePath),name),path.join(temporary,name))
        }
      } else await fs.writeFile(path.join(temporary,'bundle.json'),JSON.stringify({runId:input.runId}))
      const original=[...input.command]
      if(scientific) {
        original[1]=path.join(destination,'worker/run_worker.py')
        for(const flag of ['--bundle','--evaluator-source','--evidence-adapter-source']) {
          const position=original.indexOf(flag)
          if(position<0)continue
          original[position+1]=flag==='--bundle'?path.join(destination,'bundle.json'):path.join(destination,'worker/autofold_worker',path.basename(original[position+1]!))
        }
      }
      const plan={format:'autofold.local-plan.v1',runId:input.runId,bundleHash:await fileHash(path.join(temporary,'bundle.json')),workerHash:identity.sourceHash,
        timeoutMs:input.timeoutMs,authorizationDeadlineMs:input.authorizationDeadlineMs,originalCommand:[...input.command],argv:original,environment:input.runtimeEnvironment ?? {},...(input.runtimeEnvironment ? {freezeRuntimeEnvironment:true} : {}),workingDirectory:await fs.realpath(input.workspace),outputPath:path.resolve(input.outputPath),requireManifest:scientific,controlPython:input.command[0]??'python3'}
      await fs.writeFile(path.join(temporary,'remote-plan.json'),JSON.stringify(plan),{mode:0o400})
      const sync=async(root:string):Promise<void>=>{for(const entry of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())await sync(file);const handle=await fs.open(file,'r');try{await handle.sync()}finally{await handle.close()}}}
      await sync(temporary)
      try{await fs.rename(temporary,destination)}catch(error){if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error}
      const directory=await fs.open(path.dirname(destination),'r');try{await directory.sync()}finally{await directory.close()}
      await this.plan(input)
    } finally {await fs.rm(temporary,{recursive:true,force:true})}
  }
  private completion(receipt: any):TransportCompletion {
    if(receipt.state==='absent')throw new ReceiptUnresolvedError(receipt.runId,'Original local launch receipt is absent; no relaunch is permitted')
    if(receipt.state==='succeeded')return {status:'succeeded'}
    if(receipt.state==='cancelled')return {status:'cancelled'}
    if(['failed','timed_out'].includes(receipt.state))return {status:'failed',error:receipt.state==='timed_out'?'Frozen wall-time budget exceeded':`Scientific worker exited ${receipt.exitCode ?? 'without an attributable exit receipt'}`}
    return {status:'pending'}
  }
  async reconcile(input: Dispatch):Promise<TransportCompletion> {
    try{return await this.observe(input,true)}catch(error){throw unresolved(input.runId,error)}
  }
  private async observe(input: Dispatch,adopt:boolean):Promise<TransportCompletion> {
    if(!await Bun.file(path.join(this.root(input),'remote-plan.json')).exists())throw new ReceiptUnresolvedError(input.runId,'No original independent local supervision plan')
    let receipt=await this.control(input,'status')
    if(adopt&&['launching','running'].includes(receipt.state)){await this.control(input,'adopt');receipt=await this.control(input,'status')}
    if(input.signal?.aborted){const reason=input.signal.reason as {reason?:string}|undefined;if(reason?.reason!=='shutdown'&&reason?.reason!=='lease_lost')receipt=await this.control(input,'cancel')}
    return this.completion(receipt)
  }
  async dispatch(input: Dispatch):Promise<TransportCompletion> {
    if(!Number.isFinite(input.timeoutMs)||input.timeoutMs<=0||input.timeoutMs>Number.MAX_SAFE_INTEGER)throw new Error('Worker wall-time timeout must be positive, finite, and safely representable')
    if(input.signal?.aborted)return {status:'cancelled'}
    await fs.mkdir(input.outputPath,{recursive:true,mode:0o700})
    if(input.signal?.aborted)return {status:'cancelled'}
    await this.preflight(input)
    await input.authorizeStart?.()
    if(input.signal?.aborted)return {status:'cancelled'}
    // Once launch is attempted, host bookkeeping/control failures cannot prove
    // the independently supervised worker stopped. Preserve recovery authority.
    try {
      const first=await this.control(input,'launch')
      if(first.state==='absent')throw new ReceiptUnresolvedError(input.runId,'Local launch returned no attributable receipt')
      await input.onStarted?.()
      let delay=100
      for(;;){
        if(input.signal?.aborted){const reason=input.signal.reason as {reason?:string}|undefined;if(reason?.reason==='shutdown'||reason?.reason==='lease_lost')throw new ReceiptUnresolvedError(input.runId,'Host detached; independent local worker retains its identity');await this.control(input,'cancel')}
        const result=await this.observe(input,false)
        if(result.status!=='pending')return result
        await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);input.signal?.removeEventListener("abort",finish);resolve()};const timer=setTimeout(finish,delay);input.signal?.addEventListener("abort",finish,{once:true});if(input.signal?.aborted)finish()})
        delay=Math.min(1000,Math.ceil(delay*1.5))
      }
    } catch(error) {
      throw unresolved(input.runId,error)
    }
  }
}
