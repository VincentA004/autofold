import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {inspectBehavior,type BehavioralEvidence} from './oracle'

function valid():BehavioralEvidence{
 const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)),hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),at='2026-01-01T00:00:01Z'
 const manifests=[1,2].map(id=>{
  const linked=encode({candidate:'native-'+id}),files={result:encode({runId:'run_'+id,trialId:'trial_'+id,valid:true,score:.25}),candidates:encode({runId:'run_'+id,trialId:'trial_'+id,candidates:[{id:'candidate_'+id,sequence:'ACDE'}]}),generation_runs:encode({runId:'run_'+id,entries:[{artifactPath:'generation-runs/draw.json',artifactHash:hash(linked)}]})}
  const bytes=encode({runId:'run_'+id,trialId:'trial_'+id,files:Object.fromEntries(Object.entries(files).map(([key,value])=>[key,hash(value)]))})
  return {runId:'run_'+id,bytes,sha256:hash(bytes),files,linkedFiles:{'generation-runs/draw.json':linked}}
 })
 const runs=manifests.map((manifest,index)=>({id:manifest.runId,trialId:'trial_'+(index+1),status:'succeeded',manifestHash:manifest.sha256}))
 return {requestedResults:2,provider:[{event:'request',requestId:'gen_1',sequence:1,at},{event:'invoice',requestId:'gen_1',sequence:2,at,costUsd:.01}],workers:[{event:'worker_start',pid:10,runId:'run_1',at},{event:'worker_exit_observed',pid:10,runId:'run_1',at:'2026-01-01T00:00:02Z'},{event:'worker_start',pid:11,runId:'run_2',at:'2026-01-01T00:00:04Z'},{event:'worker_exit_observed',pid:11,runId:'run_2',at:'2026-01-01T00:00:05Z'}],observations:[{at:'2026-01-01T00:00:06Z',campaignStatus:'succeeded',completed:true,trialIds:['trial_1','trial_2'],runs,modelRequests:[{id:'request_1',upstreamRequestId:'gen_1',status:'settled',reportedCostUsd:.01,estimatedCostUsd:.02}],reportedCostUsd:.01,estimatedCostUsd:.02}],manifests,restartAt:'2026-01-01T00:00:03Z',interruptedRunId:'run_1'}
}
test('independent oracle accepts an externally complete recovery and continuation trace',()=>expect(inspectBehavior(valid())).toMatchObject({passed:true,reportedCostUsd:.01}))
function unknownHold():BehavioralEvidence{
 const trace=valid();trace.requireComplete=false;delete trace.restartAt;delete trace.interruptedRunId
 trace.workers=[];trace.manifests=[];trace.provider[1]!.costUsd=null
 Object.assign(trace.observations[0]!,{completed:false,campaignStatus:'recovery_required',trialIds:[],runs:[],reportedCostUsd:0,holdReason:'Original provider billing is unknown'})
 Object.assign(trace.observations[0]!.modelRequests[0]!,{status:'unknown',reportedCostUsd:null})
 return trace
}
test('independent oracle accepts an explicit unknown-billing hold without new execution',()=>expect(inspectBehavior(unknownHold())).toMatchObject({passed:true,counts:{workerStarts:0,successfulRuns:0}}))
function rewriteBoundFile(trace:BehavioralEvidence,key:string,change:(value:any)=>void){
 const observed=trace.manifests[0]!,encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)),hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex')
 const value=JSON.parse(new TextDecoder().decode(observed.files![key]));change(value);observed.files![key]=encode(value)
 const manifest=JSON.parse(new TextDecoder().decode(observed.bytes));manifest.files[key]=hash(observed.files![key]);observed.bytes=encode(manifest);observed.sha256=hash(observed.bytes)
 trace.observations[0]!.runs[0]!.manifestHash=observed.sha256
}
const corruptions:{name:string;alter:(trace:BehavioralEvidence)=>void;failure:string;semantic?:boolean}[]=[
 {name:'duplicate worker execution',alter:t=>{t.workers.push({...t.workers[0]!,pid:12})},failure:'Duplicate worker execution'},
 {name:'lost original result',alter:t=>{t.observations[0]!.runs.shift()},failure:'disappeared from public'},
 {name:'wrong manifest bytes',alter:t=>{t.manifests[0]!.bytes=new Uint8Array([0])},failure:'hash does not match bytes'},
 {name:'missing manifest',alter:t=>{t.manifests.shift()},failure:'one immutable manifest'},
 {name:'missing result file',alter:t=>{delete t.manifests[0]!.files!.result},failure:'Missing independently collected artifact result'},
 {name:'wrong linked artifact bytes',alter:t=>{t.manifests[0]!.linkedFiles!['generation-runs/draw.json']=new Uint8Array([0])},failure:'Linked artifact bytes differ'},
 {name:'forged success with invalid result',alter:t=>rewriteBoundFile(t,'result',result=>{result.valid=false}),failure:'does not contain a valid result',semantic:true},
 {name:'forged success with nonfinite score',alter:t=>rewriteBoundFile(t,'result',result=>{result.score=Number.NaN}),failure:'does not contain a finite numeric score',semantic:true},
 {name:'forged success with empty candidates',alter:t=>rewriteBoundFile(t,'candidates',result=>{result.candidates=[]}),failure:'empty, invalid or repeated candidates',semantic:true},
 {name:'receipt-only recovery without continuation',alter:t=>{t.workers[2]!.at='2026-01-01T00:00:02Z'},failure:'never automatically continued'},
 {name:'partial completion',alter:t=>{t.requestedResults=24},failure:'partial scientific results'},
 {name:'cost reset',alter:t=>{t.observations.unshift({...structuredClone(t.observations[0]!),reportedCostUsd:.03})},failure:'Reported cost reset'},
 {name:'unknown billing concealed as zero',alter:t=>{t.provider[1]!.costUsd=null;t.observations[0]!.reportedCostUsd=0},failure:'Unknown provider billing must prevent'},
 {name:'invoice credited twice',alter:t=>{t.observations[0]!.modelRequests.push({...t.observations[0]!.modelRequests[0]!,id:'request_2'})},failure:'credited to multiple'},
 {name:'invoice amount changed',alter:t=>{t.observations[0]!.modelRequests[0]!.reportedCostUsd=.009},failure:'lost its public settlement or amount'},
 {name:'orphan proposal',alter:t=>{t.observations[0]!.trialIds.push('trial_rejected')},failure:'scientific slots'},
 {name:'zero wire authoring',alter:t=>{t.provider=[];t.observations[0]!.modelRequests=[];t.observations[0]!.reportedCostUsd=0;t.observations[0]!.estimatedCostUsd=0},failure:'no externally observed provider requests'},
 {name:'unknown invoice loses public request',alter:t=>{Object.assign(t,unknownHold());t.observations[0]!.modelRequests=[];t.observations[0]!.estimatedCostUsd=0},failure:'lost its retained public unknown request'},
 {name:'SDK total drops retained estimates',alter:t=>{t.observations[0]!.estimatedCostUsd=0},failure:'retained request estimates'},
 {name:'unknown bill followed by effects despite final hold',alter:t=>{t.requireComplete=false;t.provider[1]!.costUsd=null;t.observations[0]!.completed=false;t.observations[0]!.holdReason='Unknown billing';t.observations[0]!.reportedCostUsd=0},failure:'New worker execution occurred'},
 {name:'provider fixture failed',alter:t=>{t.provider.push({event:'fixture_error',requestId:'gen_1',sequence:3,at:'2026-01-01',message:'actor failed'})},failure:'Provider fixture failed'},
]
for(const corruption of corruptions)test('oracle rejects corrupted trace: '+corruption.name,()=>{const trace=valid();corruption.alter(trace);const verdict=inspectBehavior(trace);expect(verdict.passed).toBe(false);expect(verdict.failures.join('\n')).toContain(corruption.failure);if(corruption.semantic)expect(verdict.failures.some(failure=>/bytes differ|hash does not match|Missing independently/.test(failure))).toBe(false)})
