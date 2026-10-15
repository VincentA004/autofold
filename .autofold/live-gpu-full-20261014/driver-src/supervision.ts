/** Operator supervision delegates all admission/recovery to the production worker. */
export async function supervise<T>(input:{worker:(signal:AbortSignal)=>Promise<void>;observe:()=>Promise<T>;done:(value:T)=>boolean;signal:AbortSignal;pollMs?:number}){
 input.signal.throwIfAborted()
 const stop=new AbortController();const abort=()=>stop.abort(input.signal.reason);input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort()
 let workerFailure:unknown,workerExited=false
 const worker=input.worker(stop.signal).catch(error=>{workerFailure=error}).finally(()=>{workerExited=true})
 try{for(;;){input.signal.throwIfAborted();if(workerFailure)throw workerFailure;if(workerExited)throw Error('Production worker exited before the requested workflow completed');const observation=await input.observe();input.signal.throwIfAborted();if(workerFailure)throw workerFailure;if(workerExited)throw Error('Production worker exited during workflow observation');if(input.done(observation))return observation;await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',finish);resolve()},timer=setTimeout(finish,input.pollMs??500);stop.signal.addEventListener('abort',finish,{once:true})})}}
 finally{stop.abort();input.signal.removeEventListener('abort',abort);await worker}
}
export function campaignBoundary(input:{trials:any[];runs:any[];jobs:any[];operations:any[];maximumTrials:number}){
 const terminal=(value:string)=>['succeeded','failed','cancelled'].includes(value)
 const scientificDone=input.trials.length===input.maximumTrials&&input.runs.length===input.maximumTrials&&input.runs.every(run=>terminal(run.status))
 const jobsDone=input.jobs.length>0&&input.jobs.every(job=>terminal(job.status)),operationsDone=input.operations.length>0&&input.operations.every(record=>record.settlement==='settled')
 if(input.trials.length>input.maximumTrials||input.runs.length>input.maximumTrials)throw Error('Scientific grant exceeded')
 return scientificDone&&jobsDone&&operationsDone
}
