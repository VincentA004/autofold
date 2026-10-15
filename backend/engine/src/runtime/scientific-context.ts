import type {AgentMessage} from '@earendil-works/pi-agent-core'
import type {SessionManager} from '@earendil-works/pi-coding-agent'
import type {PiSession} from './types'
import {messageHash} from './instructions'
import {artifactCard,toolArtifact} from './artifacts'

export interface ScientificContextSnapshot {
  entryId:string;assistantEntryId:string;toolCallId:string;toolName:string;messageHash:string
  originalOrdinal:number;restored:boolean;isError:boolean
}

function assertSnapshotScope(message:AgentMessage,session:PiSession){
  if(message.role!=='toolResult')return
  const expected=session.metadata
  const check=(scope:Record<string,unknown>)=>{
    for(const key of ['projectId','campaignId','experimentId','contractHash'] as const)
      if(typeof scope[key]==='string'&&typeof expected?.[key]==='string'&&scope[key]!==expected[key])throw new Error('Scientific snapshot scope differs from its immutable session '+key)
  }
  const packet=(value:any)=>{
    if(!value||typeof value!=='object')return
    if(value.sourceManifest?.scope)check(value.sourceManifest.scope)
    if(value.experiment?.id)check({experimentId:value.experiment.id,contractHash:value.experiment.contractHash})
    if(value.campaign?.id)check({campaignId:value.campaign.id})
    if(typeof value.contractHash==='string')check({contractHash:value.contractHash})
    for(const nested of [value.decisionMemory,value.packet,value.decisionMemoryRefresh?.decisionMemory,value.decisionMemoryRefresh?.packet])if(nested?.sourceManifest?.scope)check(nested.sourceManifest.scope)
  }
  for(const part of message.content){
    if(part.type!=='text')continue
    let value:unknown
    try{value=JSON.parse(part.text)}catch{continue}
    packet(value)
  }
}

/** Restore current named scientific snapshots in the effective context only.
 * Compaction is a continuity aid: its summary cannot replace a currently scoped
 * factual packet. Source entries, raw archives and provider/tool histories stay
 * immutable. Hidden result details remain archival; no serialization occurs here.
 */
export function restoreScientificContext(input:{manager:SessionManager;messages:AgentMessage[];session:PiSession;groups?:string[][]}) {
  const {manager,session}=input,groups=input.groups??[]
  if(groups.some(names=>!names.length||names.some(name=>typeof name!=='string'||!name.trim())))throw new Error('Invalid scientific snapshot groups')
  if(!groups.length)return {messages:input.messages,retainedAnchors:[] as number[],snapshots:[] as ScientificContextSnapshot[],superseded:[] as Array<{entryId:string;toolCallId:string;messageHash:string}>}
  const branch=manager.getBranch(),sources=branch.filter(entry=>entry.type==='message')
  const selected=new Map<string,typeof sources[number]>()
  const boundaries:Array<{names:string[];index:number}>=[]
  for(const names of groups){
    // An explicit latest error/gap supersedes an earlier valid packet. Never
    // resurrect stale facts merely because the newest retrieval was unavailable.
    const latest=sources.findLast(entry=>entry.message.role==='toolResult'&&names.includes(entry.message.toolName))
    if(latest){selected.set(latest.id,latest);boundaries.push({names,index:sources.indexOf(latest)})}
  }
  let messages=input.messages
  const thinCallers=new Set<string>()
  for(const source of selected.values()){
    const result=source.message
    if(result.role!=='toolResult')continue
    const existing=messages.filter(message=>message.role==='toolResult'&&message.toolCallId===result.toolCallId)
    if(existing.length===1&&messageHash(existing[0])===messageHash(result))continue
    const caller=sources.slice(0,sources.indexOf(source)).findLast(entry=>entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id===result.toolCallId))
    if(caller)thinCallers.add(caller.id)
  }
  const superseded:Array<{entryId:string;toolCallId:string;messageHash:string}>=[]
  for(const [index,source] of sources.entries()){
    const original=source.message
    if(original.role!=='toolResult'||selected.has(source.id)||!boundaries.some(boundary=>boundary.index>index&&boundary.names.includes(original.toolName)))continue
    const matching=messages.filter(message=>message.role==='toolResult'&&message.toolCallId===original.toolCallId)
    if(matching.length>1)throw new Error('Superseded scientific snapshot has duplicate active tool identities')
    const active=matching[0]
    if(!active||active.role!=='toolResult')continue
    if(active.toolName!==original.toolName||active.isError!==original.isError)throw new Error('Superseded scientific snapshot differs from its original binding')
    // Respect existing derived cards/edits. Only a still-full original visible
    // body is replaced; hidden details never enter the new model-facing card.
    if(JSON.stringify(active.content)!==JSON.stringify(original.content))continue
    const content=artifactCard(toolArtifact(manager,session,original),Buffer.byteLength(JSON.stringify(original)))
    const card=JSON.parse(content[0]!.text);card.projectionReason='superseded_scientific_snapshot'
    messages=messages.map(message=>message===active?{...active,content:[{type:'text',text:JSON.stringify(card)}]}:message)
    superseded.push({entryId:source.id,toolCallId:original.toolCallId,messageHash:messageHash(original)})
  }
  const snapshots:ScientificContextSnapshot[]=[],retainedAnchors:number[]=[]
  for(const source of [...selected.values()].sort((a,b)=>sources.indexOf(a)-sources.indexOf(b))){
    const result=source.message
    if(result.role!=='toolResult')throw new Error('Scientific snapshot is not a result')
    assertSnapshotScope(result,session)
    const ordinal=session.messages.findLastIndex(message=>message.role==='toolResult'&&message.toolCallId===result.toolCallId&&messageHash(message)===messageHash(result))
    if(ordinal<0)throw new Error('Original scientific snapshot differs from its immutable archive')
    const sourceIndex=sources.indexOf(source)
    const caller=sources.slice(0,sourceIndex).findLast(entry=>entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id===result.toolCallId))
    if(!caller||caller.message.role!=='assistant')throw new Error('Scientific snapshot lacks its original tool call')
    const calls=caller.message.content.filter(part=>part.type==='toolCall'&&part.id===result.toolCallId)
    if(calls.length!==1||calls[0]!.type!=='toolCall'||calls[0]!.name!==result.toolName)throw new Error('Original scientific snapshot call binding differs')
    const call=calls[0]!
    const activeResults=messages.filter(message=>message.role==='toolResult'&&message.toolCallId===result.toolCallId)
    const activeCalls=messages.flatMap(message=>message.role==='assistant'?message.content.filter(part=>part.type==='toolCall'&&part.id===result.toolCallId):[])
    if(activeResults.length>1||activeCalls.length>1)throw new Error('Scientific snapshot has duplicate active tool identities')
    if(activeCalls.some(part=>JSON.stringify(part)!==JSON.stringify(call)))throw new Error('Active scientific snapshot call differs from its original binding')
    const restored=thinCallers.has(caller.id)||activeResults.length!==1||messageHash(activeResults[0])!==messageHash(result)
    if(!restored&&activeCalls.length!==1)throw new Error('Active scientific snapshot result has no paired call')
    if(restored){
      const clean:AgentMessage[]=[]
      for(const message of messages){
        if(message.role==='toolResult'&&message.toolCallId===result.toolCallId)continue
        if(message.role==='assistant'&&message.content.some(part=>part.type==='toolCall'&&part.id===result.toolCallId)){
          const content=message.content.filter(part=>part.type!=='toolCall'||part.id!==result.toolCallId)
          if(content.length)clean.push({...message,content})
        }else clean.push(message)
      }
      // Retained history is chronological after its compaction summary. Exact
      // instruction prefixes remain untouched; insert before the first retained
      // complete protocol group, never between a call and one of its results.
      const sourceOrdinal=(message:AgentMessage)=>{
        const exact=session.messages.findLastIndex(original=>messageHash(original)===messageHash(message))
        if(exact>=0)return exact
        if(message.role==='assistant'){
          const ids=new Set(message.content.flatMap(part=>part.type==='toolCall'?[part.id]:[]))
          const callOrdinal=session.messages.findLastIndex(original=>original.role==='assistant'&&original.content.some(part=>part.type==='toolCall'&&ids.has(part.id)))
          if(callOrdinal>=0)return callOrdinal
        }
        return Number.POSITIVE_INFINITY
      }
      let at=clean.findIndex(message=>message.role==='assistant'&&sourceOrdinal(message)>ordinal)
      if(at<0)at=clean.length
      const thin:AgentMessage={...caller.message,content:[structuredClone(call)]}
      clean.splice(at,0,thin,structuredClone(result));messages=clean
    }
    retainedAnchors.push(ordinal)
    snapshots.push({entryId:source.id,assistantEntryId:caller.id,toolCallId:result.toolCallId,toolName:result.toolName,
      messageHash:messageHash(result),originalOrdinal:ordinal,restored,isError:result.isError})
  }
  return {messages,retainedAnchors,snapshots,superseded}
}
