import {expect,test} from 'bun:test'
import type {AssistantMessage} from '@earendil-works/pi-ai'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import {restoreManager} from './sdk'
import {restoreScientificContext} from './scientific-context'
import {messageHash} from './instructions'
import {validateContextProtocol} from './context'

const call=(id:string,name:string)=>({type:'toolCall' as const,id,name,arguments:{scope:'frozen'}})
const assistant=(content:AssistantMessage['content']):AssistantMessage=>({role:'assistant',content,stopReason:'toolUse',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
const result=(id:string,name:string,text:string,isError=false)=>({role:'toolResult' as const,toolCallId:id,toolName:name,content:[{type:'text' as const,text}],details:{hidden:'Never delivered native closure '+ 'x'.repeat(100000)},isError,timestamp:2})
async function fixture(){
 const session=await new PiRuntime({store:new MemorySessionStore()}).create()
 delete session.sdk
 const packet=JSON.stringify({format:'autofold.decision-memory.v1',facts:[{runId:'run_baseline_1',score:.3},{runId:'run_baseline_2',score:.2}],provenance:'完整🧬'.repeat(1000)})
 session.messages=[{role:'user',content:'Exact human instruction remains verbatim.',timestamp:0},assistant([{type:'thinking',thinking:'Large original reasoning '.repeat(5000)},call('science','read_decision_memory'),call('bulk','read')]),result('science','read_decision_memory',packet),result('bulk','read','Unrelated bulk source'),assistant([call('later','edit')]),result('later','edit','Saved')]
 const manager=restoreManager(session),entries=manager.getBranch(),later=entries.find(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id==='later'))!
 return {session,manager,packet,later}
}
test('compacted current scientific packet returns in full with a thin original call frame and immutable provenance',async()=>{
 const f=await fixture(),originals=structuredClone(f.session.messages)
 f.manager.appendCompaction('Summary is not receipt authority.',f.later.id,100000)
 const before=JSON.stringify(f.manager.getEntries()),active=f.manager.buildSessionProjection().messages
 const projected=restoreScientificContext({manager:f.manager,messages:active,session:f.session,groups:[['read_context','read_decision_memory']]})
 validateContextProtocol(projected.messages)
 expect(projected.snapshots).toHaveLength(1);expect(projected.snapshots[0]).toMatchObject({toolCallId:'science',originalOrdinal:2,restored:true,isError:false,messageHash:messageHash(originals[2])})
 expect(projected.retainedAnchors).toEqual([2])
 const restored=projected.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='science')!
 expect(restored).toEqual(originals[2])
 const frame=projected.messages.find(message=>message.role==='assistant'&&message.content.some(part=>part.type==='toolCall'&&part.id==='science'))!
 if(frame.role!=='assistant')throw new Error('Missing assistant frame')
 expect(frame.content).toEqual([call('science','read_decision_memory')]);expect(JSON.stringify(frame)).not.toContain('Large original reasoning')
 expect(JSON.stringify(projected.messages)).not.toContain('Unrelated bulk source')
 expect(f.session.messages).toEqual(originals);expect(JSON.stringify(f.manager.getEntries())).toBe(before)
})
test('an exact currently active scientific pair remains unchanged rather than replayed or duplicated',async()=>{
 const f=await fixture(),active=f.manager.buildSessionProjection().messages
 const projected=restoreScientificContext({manager:f.manager,messages:active,session:f.session,groups:[['read_decision_memory']]})
 expect(projected.messages).toBe(active);expect(projected.snapshots[0]!.restored).toBe(false)
 validateContextProtocol(projected.messages)
})
test('restoring a derived snapshot card preserves every unrelated sibling call and result',async()=>{
 const f=await fixture(),active=structuredClone(f.manager.buildSessionProjection().messages)
 const old=active.find(message=>message.role==='toolResult'&&message.toolCallId==='science')!
 if(old.role!=='toolResult')throw new Error('Missing fixture result')
 old.content=[{type:'text',text:'{"exposure":"artifact_reference_only"}'}]
 const projected=restoreScientificContext({manager:f.manager,messages:active,session:f.session,groups:[['read_decision_memory']]})
 validateContextProtocol(projected.messages)
 expect(projected.messages.filter(message=>message.role==='toolResult'&&message.toolCallId==='science')).toHaveLength(1)
 expect(projected.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='bulk')).toEqual(f.session.messages[3])
 const calls=projected.messages.flatMap(message=>message.role==='assistant'?message.content.filter(part=>part.type==='toolCall').map(part=>part.id):[])
 expect(calls.toSorted()).toEqual(['bulk','later','science'])
})
test('multiple missing named snapshots restore in original order and do not mutate repeated projection',async()=>{
 const f=await fixture()
 f.session.messages.splice(4,0,assistant([call('eval','evaluate_trial')]),result('eval','evaluate_trial','Exact current evaluation'))
 const manager=restoreManager({...f.session,sdk:undefined}),later=manager.getBranch().find(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id==='later'))!
 manager.appendCompaction('Old history.',later.id,100000)
 const input={manager,messages:manager.buildSessionProjection().messages,session:f.session,groups:[['read_context','read_decision_memory'],['evaluate_trial']]}
 const first=restoreScientificContext(input),second=restoreScientificContext({...input,messages:first.messages})
 validateContextProtocol(first.messages)
 expect(first.messages.filter(message=>message.role==='toolResult').map(message=>message.toolCallId)).toEqual(['science','eval','later'])
 expect(second.messages).toBe(first.messages);expect(second.snapshots.every(snapshot=>!snapshot.restored)).toBe(true)
})
test('the latest explicit retrieval error supersedes an older valid archived scientific packet',async()=>{
 const f=await fixture()
 f.session.messages.splice(4,0,assistant([call('gap','read_context')]),result('gap','read_context','{"status":"unavailable","gap":"No current verified snapshot"}',true))
 const manager=restoreManager({...f.session,sdk:undefined}),later=manager.getBranch().find(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id==='later'))!
 manager.appendCompaction('Old history.',later.id,100000)
 const projected=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session:f.session,groups:[['read_context','read_decision_memory']]})
 validateContextProtocol(projected.messages)
 expect(projected.snapshots).toHaveLength(1);expect(projected.snapshots[0]).toMatchObject({toolCallId:'gap',isError:true,restored:true})
 expect(projected.messages.some(message=>message.role==='toolResult'&&message.toolCallId==='science')).toBe(false)
})
test('a latest retrieval error archives an older still-active full packet through its exact original artifact identity',async()=>{
 const f=await fixture()
 f.session.messages.splice(4,0,assistant([call('gap','read_context')]),result('gap','read_context','{"status":"unavailable","gap":"No current verified snapshot"}',true))
 const manager=restoreManager({...f.session,sdk:undefined}),originals=structuredClone(f.session.messages)
 const projected=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session:f.session,groups:[['read_context','read_decision_memory']]})
 validateContextProtocol(projected.messages)
 const old=projected.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='science')!
 expect(JSON.stringify(old)).toContain('superseded_scientific_snapshot')
 if(old.role!=='toolResult'||old.content[0]?.type!=='text')throw new Error('Missing artifact card')
 const card=JSON.parse(old.content[0].text)
 expect(card.toolArtifact.messageHash).toBe(messageHash(originals[2]))
 expect(card.toolArtifact.ordinal).toBe(2)
 expect(projected.snapshots[0]).toMatchObject({toolCallId:'gap',isError:true,restored:false})
 expect(projected.superseded).toHaveLength(1)
 expect(f.session.messages).toEqual(originals)
})
test('scientific re-exposure rejects changed archives, changed active call arguments and duplicate active identities',async()=>{
 const f=await fixture(),input={manager:f.manager,messages:f.manager.buildSessionProjection().messages,session:f.session,groups:[['read_decision_memory']]}
 const changed=structuredClone(input.messages),caller=changed.find(message=>message.role==='assistant')!
 if(caller.role!=='assistant')throw new Error('Missing assistant')
 const tool=caller.content.find(part=>part.type==='toolCall')!
 if(tool.type!=='toolCall')throw new Error('Missing call')
 tool.arguments={scope:'another'}
 expect(()=>restoreScientificContext({...input,messages:changed})).toThrow('binding')
 expect(()=>restoreScientificContext({...input,messages:[...input.messages,input.messages[2]!]})).toThrow('duplicate')
 const archive=structuredClone(f.session);archive.messages[2]={...archive.messages[2]!,timestamp:999} as typeof archive.messages[number]
 expect(()=>restoreScientificContext({...input,session:archive})).toThrow('immutable archive')
})
test('one edited scientific result extracts both selected siblings in original order without breaking unrelated siblings',async()=>{
 const f=await fixture()
 f.session.messages=[f.session.messages[0]!,assistant([call('science','read_decision_memory'),call('eval','evaluate_trial'),call('bulk','read')]),result('science','read_decision_memory',f.packet),result('eval','evaluate_trial','Newer evaluation snapshot'),result('bulk','read','Unrelated original sibling'),f.session.messages[4]!,f.session.messages[5]!]
 const manager=restoreManager({...f.session,sdk:undefined}),active=structuredClone(manager.buildSessionProjection().messages)
 const edited=active.find(message=>message.role==='toolResult'&&message.toolCallId==='science')!
 if(edited.role!=='toolResult')throw new Error('Missing scientific result')
 edited.content=[{type:'text',text:'{"exposure":"artifact_reference_only"}'}]
 const projected=restoreScientificContext({manager,messages:active,session:f.session,groups:[['evaluate_trial'],['read_decision_memory']]})
 validateContextProtocol(projected.messages)
 expect(projected.messages.flatMap(message=>message.role==='toolResult'&&['science','eval'].includes(message.toolCallId)?[message.toolCallId]:[])).toEqual(['science','eval'])
 expect(projected.snapshots.every(snapshot=>snapshot.restored)).toBe(true)
 expect(projected.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='bulk')).toEqual(f.session.messages[4])
})
test('foreign experiment snapshots fail closed instead of reviving an older matching packet',async()=>{
 const f=await fixture();f.session.metadata={...f.session.metadata,experimentId:'exp_current',projectId:'project_current'}
 f.session.messages.push(assistant([call('foreign','read_context')]),result('foreign','read_context',JSON.stringify({experiment:{id:'exp_foreign'},decisionMemory:{sourceManifest:{scope:{experimentId:'exp_foreign',projectId:'project_current'}}}})))
 const manager=restoreManager({...f.session,sdk:undefined})
 expect(()=>restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session:f.session,groups:[['read_context','read_decision_memory']]})).toThrow('scope')
})
test('the actual evaluate_trial decisionMemoryRefresh.decisionMemory wire shape enforces frozen session scope',async()=>{
 const f=await fixture();f.session.metadata={...f.session.metadata,experimentId:'exp_current',projectId:'project_current'}
 f.session.messages.push(assistant([call('foreign_eval','evaluate_trial')]),result('foreign_eval','evaluate_trial',JSON.stringify({status:'succeeded',decisionMemoryRefresh:{status:'available',decisionMemory:{sourceManifest:{scope:{experimentId:'exp_foreign',projectId:'project_current'}}}}})))
 const manager=restoreManager({...f.session,sdk:undefined})
 expect(()=>restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session:f.session,groups:[['evaluate_trial']]})).toThrow('scope')
})
test('synthetic summary frames and exact user prefixes do not reorder the selected original snapshot groups',async()=>{
 const f=await fixture()
 f.session.messages.splice(4,0,assistant([call('eval','evaluate_trial')]),result('eval','evaluate_trial','Current evaluation'))
 const manager=restoreManager({...f.session,sdk:undefined})
 const prefix=f.session.messages[0]!,synthetic=assistant([{type:'text',text:'Synthetic summary frame with no original ordinal'}])
 const projected=restoreScientificContext({manager,messages:[prefix,synthetic],session:f.session,groups:[['evaluate_trial'],['read_context','read_decision_memory']]})
 validateContextProtocol(projected.messages)
 expect(projected.messages[0]).toEqual(prefix)
 expect(projected.messages.at(-1)).toEqual(synthetic)
 expect(projected.messages.filter(message=>message.role==='toolResult').map(message=>message.toolCallId)).toEqual(['science','eval'])
})
