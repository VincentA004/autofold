import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {auditAuthoredProgram} from './index'
import type {PiRuntimeEvent} from '../runtime'
const hash=(source:string)=>'sha256:'+createHash('sha256').update(source).digest('hex')
const draft='.autofold/autoresearch/exp_fixture/trial.py'
const event=(sequence:number,type:string,data:unknown):PiRuntimeEvent=>({sessionId:'ses_offline_provenance',sequence,timestamp:sequence,type,data})
function trace(source:string,edited:string){return [
 event(1,'tool_execution_start',{toolCallId:'write',toolName:'write',args:{path:'trial.py',content:source}}),
 event(2,'tool_execution_end',{toolCallId:'write',toolName:'write',isError:false,result:{details:{path:draft,programHash:hash(source)}}}),
 event(3,'tool_execution_start',{toolCallId:'edit',toolName:'edit',args:{path:'trial.py',edits:[{oldText:'alpha=1\n',newText:'alpha=3\n'},{oldText:'beta=2',newText:'beta=4'}]}}),
 event(4,'tool_execution_end',{toolCallId:'edit',toolName:'edit',isError:false,result:{details:{path:draft,previousProgramHash:hash(source),programHash:hash(edited)}}}),
]}
test('native provenance replay uses pinned Pi multi-edit BOM and CRLF semantics over memory only',async()=>{
 const source='\uFEFFalpha=1\r\nbeta=2\r\n',edited='\uFEFFalpha=3\r\nbeta=4\r\n',events=trace(source,edited)
 expect(await auditAuthoredProgram(events,events[3],hash(edited),5,draft)).toBe(true)
 expect(await auditAuthoredProgram(events,events[3],hash(edited),5,draft+'.other')).toBe(false)
})
test('native provenance refuses external edits, ambiguous call IDs, wrong names and nonpreceding starts',async()=>{
 const source='alpha=1\nbeta=2\n',edited='alpha=3\nbeta=4\n'
 for(const mode of ['external','duplicate','name','sequence','failed','missing-start','unknown-result'] as const){const events=trace(source,edited)
  if(mode==='external')(events[3]!.data as {result:{details:{previousProgramHash:string}}}).result.details.previousProgramHash=hash(source+'# outside model trace\n')
  if(mode==='duplicate')events.unshift(event(0,'tool_execution_start',{toolCallId:'edit',toolName:'edit',args:{}}))
  if(mode==='name')(events[2]!.data as {toolName:string}).toolName='write'
  if(mode==='sequence')events[2]!.sequence=4
  if(mode==='failed')(events[3]!.data as {isError:boolean}).isError=true
  if(mode==='missing-start')events.splice(2,1)
  if(mode==='unknown-result')delete (events[3]!.data as {isError?:boolean}).isError
  expect(await auditAuthoredProgram(events,events.find(e=>e.sequence===4&&e.type==='tool_execution_end'),hash(edited),5,draft)).toBe(false)
 }
})
test('all same-draft mutations before evaluation count even after an earlier matching-hash author',async()=>{
 const source='alpha=1\nbeta=2\n',edited='alpha=3\nbeta=4\n',events=trace(source,edited),changed=edited+'# later changed program\n'
 events.push(event(5,'tool_execution_start',{toolCallId:'late-write',toolName:'write',args:{path:'trial.py',content:changed}}),event(6,'tool_execution_end',{toolCallId:'late-write',toolName:'write',isError:false,result:{details:{path:draft,previousProgramHash:hash(edited),programHash:hash(changed)}}}))
 expect(await auditAuthoredProgram(events,events[3],hash(edited),7,draft)).toBe(false)
})

test('failed edit receives no authorship credit while an unchanged proven draft remains authored',async()=>{
 const source='alpha=1\nbeta=2\n',events=trace(source,source)
 ;(events[3]!.data as {isError:boolean}).isError=true
 expect(await auditAuthoredProgram(events,events[3],hash(source),5,draft)).toBe(false)
 expect(await auditAuthoredProgram(events,events[1],hash(source),5,draft)).toBe(true)
 ;(events[3]!.data as {result:{details:{path:string}}}).result.details.path=draft.replace('trial.py','LAB.md')
 expect(await auditAuthoredProgram(events,events[1],hash(source),5,draft)).toBe(true)
})
