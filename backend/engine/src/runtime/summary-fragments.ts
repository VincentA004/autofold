import crypto from 'node:crypto'
import type {AgentMessage} from '@earendil-works/pi-agent-core'
import {convertToLlm,serializeConversation} from '@earendil-works/pi-coding-agent'

const hash=(value:string)=>'sha256:'+crypto.createHash('sha256').update(value).digest('hex')
export interface HistoricalSummarySource {
  group:number; messageRange:{start:number;end:number}; messageHashes:string[]
  toolCalls:{id:string;name:string}[]; text:string; textHash:string
}
/** This is the effective, already authorized model-facing projection. Never
 * rehydrate hidden tool details or projected-away bulk from the raw archive.
 * Pi's ordinary conversation serializer truncates tool text; summary input must
 * instead preserve that visible text, with explicit role and call provenance.
 * Transport signatures and image pixels are not interpretable summary text. */
export function historicalSummarySource(messages:AgentMessage[],group:number,start:number):HistoricalSummarySource {
  const text=convertToLlm(messages).map(message=>{
    if(message.role!=='toolResult'){
      const calls=message.role==='assistant'?message.content.filter(part=>part.type==='toolCall').map(part=>({id:part.id,name:part.name})):[]
      const images=Array.isArray(message.content)?message.content.filter(part=>part.type==='image').map(part=>({opaqueImage:true,mimeType:part.mimeType,dataHash:hash(part.data),authority:'Original pixels remain archived and were not reviewed by this text summary.'})):[]
      return [calls.length?'[Original tool call identifiers]: '+JSON.stringify(calls):'',serializeConversation([message]),images.length?JSON.stringify(images):''].filter(Boolean).join('\n')
    }
    const content=message.content.map(part=>part.type==='text'?part.text:
      JSON.stringify({opaqueImage:true,mimeType:part.mimeType,dataHash:hash(part.data),
        authority:'Original image remains archived; its pixels were not reviewed by this text summary.'})).join('\n')
    return '[Tool result '+JSON.stringify({toolCallId:message.toolCallId,toolName:message.toolName,isError:message.isError})+']:\n'+content
  }).join('\n\n')
  return {group,messageRange:{start,end:start+messages.length},messageHashes:messages.map(message=>hash(JSON.stringify(message))),
    toolCalls:messages.flatMap(message=>message.role==='assistant'?message.content.filter(part=>part.type==='toolCall').map(part=>({id:part.id,name:part.name})):[]),text,textHash:hash(text)}
}
export interface SummaryFragment {
  format:'autofold.pi-historical-fragment.v1'; sourceKind:'projected_history'|'previous_summary'
  archive:{id:string;sha256:string;originalRange?:{start:number;end:number}}
  group:number;messageRangeBasis:'effective_summary_source';messageRange:{start:number;end:number}
  messageHashes:string[];messageCount:number;messageHashListHash:string
  toolCalls:{id:string;name:string}[];toolCallCount:number;toolCallListHash:string;textHash:string
  offsetBytes:number;endBytes:number;totalBytes:number;fragmentHash:string;sourceText:string
}
export function summaryFragment(source:HistoricalSummarySource,offsetBytes:number,endBytes:number,archive:SummaryFragment['archive'],sourceKind:SummaryFragment['sourceKind']='projected_history'):SummaryFragment {
  const bytes=Buffer.from(source.text),sourceText=bytes.subarray(offsetBytes,endBytes).toString('utf8')
  if(!Number.isSafeInteger(offsetBytes)||!Number.isSafeInteger(endBytes)||offsetBytes<0||endBytes<=offsetBytes||endBytes>bytes.length||
    (offsetBytes<bytes.length&&bytes[offsetBytes]!>=0x80&&bytes[offsetBytes]!<0xc0)||
    (endBytes<bytes.length&&bytes[endBytes]!>=0x80&&bytes[endBytes]!<0xc0))throw new Error('Invalid historical summary UTF-8 fragment boundary')
  return {format:'autofold.pi-historical-fragment.v1',sourceKind,archive,group:source.group,messageRangeBasis:'effective_summary_source',messageRange:source.messageRange,
    // The full ordered identifier lists also occur in the source text/archive.
    // Keep each repeated fragment envelope bounded even for huge mixed batches.
    messageHashes:source.messageHashes.slice(0,8),messageCount:source.messageHashes.length,messageHashListHash:hash(JSON.stringify(source.messageHashes)),
    toolCalls:source.toolCalls.slice(0,8),toolCallCount:source.toolCalls.length,toolCallListHash:hash(JSON.stringify(source.toolCalls)),textHash:source.textHash,
    offsetBytes,endBytes,totalBytes:bytes.length,fragmentHash:hash(sourceText),sourceText}
}
export function summaryFragmentMessage(fragment:SummaryFragment):AgentMessage {
  return {role:'user',content:[{type:'text',text:JSON.stringify(fragment)}],timestamp:0}
}
/** Largest complete UTF-8 prefix admitted by the caller's measured prompt
 * sizing. A fragment is historical data, never an executable tool protocol. */
export function fitSummaryFragment(source:HistoricalSummarySource,offsetBytes:number,archive:SummaryFragment['archive'],fits:(message:AgentMessage)=>boolean,sourceKind:SummaryFragment['sourceKind']='projected_history') {
  const bytes=Buffer.from(source.text)
  let low=offsetBytes+1,high=bytes.length,best:SummaryFragment|undefined
  while(low<=high){
    const midpoint=Math.floor((low+high)/2)
    let end=midpoint
    while(end>offsetBytes&&end<bytes.length&&bytes[end]!>=0x80&&bytes[end]!<0xc0)end--
    if(end===offsetBytes){low=midpoint+1;continue}
    const fragment=summaryFragment(source,offsetBytes,end,archive,sourceKind)
    if(fits(summaryFragmentMessage(fragment))){best=fragment;low=midpoint+1}else high=midpoint-1
  }
  return best
}
