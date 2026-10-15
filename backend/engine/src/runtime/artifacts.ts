import {messageHash} from './instructions'
import type {AgentMessage} from '@earendil-works/pi-agent-core'
import type {SessionManager} from '@earendil-works/pi-coding-agent'
import type {PiSession} from './types'

export interface ToolArtifactRef {sessionId:string;entryId:string;toolCallId:string;ordinal:number;messageHash:string}
export function toolArtifact(manager:SessionManager,session:PiSession,message:AgentMessage):ToolArtifactRef {
  if(message.role!=='toolResult')throw new Error('Tool artifact requires an original tool result')
  const entry=manager.getBranch().findLast(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolCallId===message.toolCallId&&messageHash(entry.message)===messageHash(message))
  const ordinal=session.messages.findLastIndex(value=>value.role==='toolResult'&&value.toolCallId===message.toolCallId&&messageHash(value)===messageHash(message))
  if(!entry||ordinal<0)throw new Error('Original Pi tool artifact is absent')
  return {sessionId:session.id,entryId:entry.id,toolCallId:message.toolCallId,ordinal,messageHash:messageHash(message)}
}
export function artifactCard(ref:ToolArtifactRef,totalBytes:number) {
  return [{type:'text' as const,text:JSON.stringify({toolArtifact:ref,totalBytes,exposure:'artifact_reference_only',
    retrieval:'read_tool_artifact retrieves exact original message JSON in bounded UTF-8 pages; these original bytes have not been exposed in this card.',
    authority:'Original tool text is retained in Pi; only verified scientific receipts establish measurements.'})}]
}
/** The model sees content and call framing, not archived tool details. */
export function toolProjectionBytes(message:AgentMessage) {
  if(message.role!=='toolResult')throw new Error('Expected tool projection')
  return Buffer.byteLength(JSON.stringify({role:message.role,toolCallId:message.toolCallId,toolName:message.toolName,content:message.content,isError:message.isError}))
}
/** Imported originals receive the same derived projection before compaction.
 * Existing native context edits and omitted/compacted entries remain untouched. */
export function projectOversizedToolArtifacts(manager:SessionManager,session:PiSession,threshold:number,visibleOnly=false) {
  let count=0
  for(const projected of manager.buildSessionProjection().entries){
    const source=projected.sourceEntry
    if(source.type!=='message'||source.message.role!=='toolResult'||projected.messages.length!==1||messageHash(projected.messages[0])!==messageHash(source.message))continue
    const totalBytes=Buffer.byteLength(JSON.stringify(source.message))
    if((visibleOnly?toolProjectionBytes(source.message):totalBytes)<=threshold)continue
    manager.appendContextEdit(source.id,{content:artifactCard(toolArtifact(manager,session,source.message),totalBytes)});count++
  }
  return count
}
export function readToolArtifact(session:PiSession,input:ToolArtifactRef&{offsetBytes?:number;limitBytes?:number}) {
  if(input.sessionId!==session.id)throw new Error('Tool artifact belongs to another Pi session')
  const entry=session.sdk?.entries.find(entry=>entry.id===input.entryId),message=session.messages[input.ordinal]
  if(!entry||entry.type!=='message'||entry.message.role!=='toolResult'||entry.message.toolCallId!==input.toolCallId||
    !message||message.role!=='toolResult'||message.toolCallId!==input.toolCallId||messageHash(entry.message)!==input.messageHash||messageHash(message)!==input.messageHash)
    throw new Error('Original Pi tool artifact identity changed or is absent')
  const bytes=Buffer.from(JSON.stringify(entry.message)),offset=input.offsetBytes??0,limit=input.limitBytes??4000
  if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length||!Number.isSafeInteger(limit)||limit<1||limit>8000)throw new Error('Invalid tool artifact byte cursor')
  if(offset<bytes.length&&bytes[offset]!>=0x80&&bytes[offset]!<0xc0)throw new Error('Tool artifact cursor splits UTF-8 code point')
  let end=Math.min(bytes.length,offset+limit)
  while(end>offset&&end<bytes.length&&bytes[end]!>=0x80&&bytes[end]!<0xc0)end--
  if(end===offset&&offset<bytes.length)throw new Error('Tool artifact page cannot fit next UTF-8 code point')
  return {...input,encoding:'original_message_json_utf8',text:bytes.subarray(offset,end).toString('utf8'),offsetBytes:offset,totalBytes:bytes.length,nextOffsetBytes:end<bytes.length?end:null}
}

/** Budget the effective tool projection using Pi edits. Originals and call/result
 * groups remain in the SDK tree; exact pages are available through its artifact tool.
 * latestToolGroups declares interchangeable snapshots, not scientific authority. */
export function projectRetainedToolArtifacts(manager:SessionManager,session:PiSession,maximumBytes:number,latestToolGroups:string[][]=[]) {
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1024)throw new Error('Invalid retained tool context budget')
  if(latestToolGroups.some(group=>!group.length||group.some(name=>typeof name!=='string'||!name.trim())))throw new Error('Invalid latest tool snapshot group')
  const entries=manager.buildSessionProjection().entries
  const visible=entries.flatMap(entry=>entry.messages.map(message=>({entry,message})))
  const tools=visible.filter(item=>item.message.role==='toolResult')
  const original=(item:typeof tools[number])=>{
    const source=item.entry.sourceEntry
    return source.type==='message'&&source.message.role==='toolResult'&&item.entry.messages.length===1&&messageHash(item.message)===messageHash(source.message)
  }
  const recentIds=new Set<string>()
  const currentSnapshotIds=new Set<string>()
  const superseded=new Map<string,string>()
  for(const names of latestToolGroups){
    const candidates=tools.filter(item=>item.message.role==='toolResult'&&!item.message.isError&&names.includes(item.message.toolName)&&original(item))
    const latest=candidates.at(-1)
    if(!latest)continue
    currentSnapshotIds.add(latest.entry.sourceEntry.id)
    for(const item of candidates.slice(0,-1))superseded.set(item.entry.sourceEntry.id,latest.entry.sourceEntry.id)
  }
  const completeGroups:{ids:string[];ordinaryIds:string[];visibleBytes:number;originalResults:boolean}[]=[]
  for(let index=0;index<visible.length;index++){
    const item=visible[index]!,message=item.message
    if(message.role!=='assistant')continue
    const calls=message.content.filter(part=>part.type==='toolCall')
    if(!calls.length)continue
    const pending=new Set(calls.map(call=>call.id)),ids:string[]=[],results:typeof tools=[]
    if(pending.size!==calls.length)continue
    for(let next=index+1;next<visible.length&&pending.size;next++){
      const following=visible[next]!
      if(following.message.role==='system')continue
      if(following.message.role!=='toolResult'||!pending.delete(following.message.toolCallId))break
      ids.push(following.entry.sourceEntry.id);results.push(following as typeof tools[number])
    }
    // Only call framing and ordinary visible results count toward this bounded
    // working set. Current scientific snapshots are protected independently,
    // while large assistant reasoning/text remains native-capacity policy.
    if(!pending.size){
      const ordinaryIds=results.filter(result=>!currentSnapshotIds.has(result.entry.sourceEntry.id)&&!superseded.has(result.entry.sourceEntry.id)).map(result=>result.entry.sourceEntry.id)
      const ordinaryResults=results.filter(result=>!currentSnapshotIds.has(result.entry.sourceEntry.id)&&!superseded.has(result.entry.sourceEntry.id))
      completeGroups.push({ids,ordinaryIds,visibleBytes:Buffer.byteLength(JSON.stringify({role:message.role,content:calls}))+ordinaryResults.reduce((sum,result)=>sum+toolProjectionBytes(result.message),0),originalResults:results.every(original)})
    }
  }
  for(const group of completeGroups.slice(-2))for(const id of group.ids)recentIds.add(id)
  // Keep a bounded working set of newest complete original tool groups.
  // Each group is capped at 32 KiB and the total at 64 KiB; this allows nearby
  // schema/source pages to remain jointly usable without protecting large
  // results. Native input capacity/compaction still owns the hard limit.
  const protectedNewestGroupIds=new Set<string>()
  let protectedWorkingSetBytes=0
  const protectedWorkingSetLimit=Math.min(65_536,maximumBytes)
  for(const group of completeGroups.slice().reverse()){
    if(!group.originalResults||!group.ordinaryIds.length||group.visibleBytes>32_768||protectedWorkingSetBytes+group.visibleBytes>protectedWorkingSetLimit)continue
    for(const id of group.ordinaryIds)protectedNewestGroupIds.add(id)
    protectedWorkingSetBytes+=group.visibleBytes
  }
  let retainedBytes=tools.reduce((sum,item)=>sum+toolProjectionBytes(item.message),0)
  const before=retainedBytes
  let count=0
  // Preserve the bounded newest complete groups, then other recent results
  // preferentially; pairing never requires keeping unbounded result content.
  // Current named snapshots remain protected by their existing scoped policy.
  const evictionOrder=[...tools.filter(item=>!recentIds.has(item.entry.sourceEntry.id)),...tools.filter(item=>recentIds.has(item.entry.sourceEntry.id))]
  for(const item of evictionOrder){
    if(item.message.role!=='toolResult')continue
    const id=item.entry.sourceEntry.id
    if(currentSnapshotIds.has(id)||protectedNewestGroupIds.has(id)||!original(item))continue
    const visibleBytes=toolProjectionBytes(item.message)
    const oversized=visibleBytes>Math.min(65_536,maximumBytes)
    if(retainedBytes<=maximumBytes&&!superseded.has(id)&&!oversized)continue
    const source=item.entry.sourceEntry
    if(source.type!=='message'||source.message.role!=='toolResult')continue
    const totalBytes=Buffer.byteLength(JSON.stringify(source.message))
    const card=artifactCard(toolArtifact(manager,session,source.message),totalBytes)
    const value=JSON.parse(card[0]!.text)
    value.projectionReason=superseded.has(id)?'superseded_tool_snapshot':oversized?'oversized_tool_result':'retained_tool_budget'
    if(superseded.has(id))value.currentSnapshotEntryId=superseded.get(id)
    const content=[{type:'text' as const,text:JSON.stringify(value)}]
    const reducedBytes=toolProjectionBytes({...item.message,content})
    if(reducedBytes>=visibleBytes)continue
    manager.appendContextEdit(id,{content})
    retainedBytes-=visibleBytes-reducedBytes;count++
  }
  return {count,retainedBytesBefore:before,retainedBytesAfter:retainedBytes,maximumBytes,protectedOverflow:retainedBytes>maximumBytes}
}
