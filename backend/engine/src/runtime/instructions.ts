import {createHash} from 'node:crypto'
import {operationHash} from '@autofold/science-core/operations'
import type {AgentMessage} from '@earendil-works/pi-agent-core'
import type {SessionManager,SessionMessageEntry} from '@earendil-works/pi-coding-agent'
import type {PiRunOptions,PiSession} from './types'

export const PROMPT_ORIGIN='autofold.prompt-origin.v1'
export const INSTRUCTION_BINDING='autofold.exact-instruction.v1'
/** SDK reconstruction may reorder object keys. Projection equivalence is
 * structural; raw archive/tool hashes remain byte-for-byte messageHash. */
export const instructionProjectionHash=(message:unknown)=>{
  if(message&&typeof message==='object'&&'role' in message&&message.role==='system'){
    const {timestamp,...visible}=message as Record<string,unknown>
    return 'sha256:'+operationHash({...visible,...(visible.sections&&typeof visible.sections==='object'?{sections:Object.entries(visible.sections)}:{})})
  }
  return 'sha256:'+operationHash(message)
}

export const messageHash=(message:unknown)=>'sha256:'+createHash('sha256').update(JSON.stringify(message)).digest('hex')

/** Tags are part of Pi's original tree. Untagged historical messages remain human. */
export function exactInstructionMessages(manager:SessionManager):AgentMessage[] {
  const branch=manager.getBranch(),byId=new Map(branch.map(entry=>[entry.id,entry])),host=new Set<string>()
  for(const entry of branch)if(entry.type==='custom'&&entry.customType===PROMPT_ORIGIN){
    const tag=entry.data as {targetEntryId?:string;contentHash?:string;origin?:string}
    const target=byId.get(tag?.targetEntryId??'')
    if(!target||target.type!=='message'||target.message.role!=='user'||tag.origin!=='host_context'||messageHash(target.message)!==tag.contentHash)
      throw new Error('Original Pi prompt origin tag does not match its exact source')
    host.add(target.id)
  }
  return branch.flatMap(entry=>entry.type==='message'&&(entry.message.role==='system'||entry.message.role==='user'&&!host.has(entry.id))?[entry.message]:[])
}

export function appendExactInstructions(manager:SessionManager,session:PiSession,instructions:PiRunOptions['exactInstructions']) {
  let changed=false
  for(const instruction of instructions??[]){
    if(!instruction.id?.trim()||typeof instruction.text!=='string'||!instruction.text.trim())throw new Error('Exact instruction requires stable identity and literal text')
    const existing=manager.getBranch().find(entry=>entry.type==='custom'&&entry.customType===INSTRUCTION_BINDING&&(entry.data as any)?.id===instruction.id)
    if(existing?.type==='custom'){
      const binding=existing.data as {targetEntryId:string;contentHash:string},target=manager.getEntry(binding.targetEntryId)
      if(!target||target.type!=='message'||target.message.role!=='user'||target.message.content!==instruction.text||messageHash(target.message)!==binding.contentHash)
        throw new Error('Original exact instruction identity changed')
      continue
    }
    const message={role:'user' as const,content:instruction.text,timestamp:Date.now()}
    const targetEntryId=manager.appendMessage(message)
    manager.appendCustomEntry(INSTRUCTION_BINDING,{id:instruction.id,targetEntryId,contentHash:messageHash(message)})
    session.messages.push(message);changed=true
  }
  return changed
}

export function tagHostPrompt(manager:SessionManager,entry:SessionMessageEntry,options:PiRunOptions) {
  if(options.promptOrigin!=='host_context')return
  manager.appendCustomEntry(PROMPT_ORIGIN,{targetEntryId:entry.id,contentHash:messageHash(entry.message),origin:'host_context',...(options.owningBinding?{owningBinding:options.owningBinding}:{})})
}

export function restoreExactInstructions(messages:AgentMessage[],anchors:AgentMessage[]) {
  const protectedHashes=new Set(anchors.map(instructionProjectionHash))
  // Restore one chronological protected prefix. Prepending only missing anchors
  // would move an omitted middle instruction before the first instruction.
  return [...anchors,...messages.filter(message=>!protectedHashes.has(instructionProjectionHash(message)))]
}
export function assertExactInstructionOrder(messages:AgentMessage[],anchors:AgentMessage[]) {
  let cursor=0
  for(const anchor of anchors){
    const index=messages.findIndex((message,index)=>index>=cursor&&messageHash(message)===messageHash(anchor))
    if(index<0)throw new Error('Pi context transform removed, changed or reordered protected exact human instructions')
    cursor=index+1
  }
}

/** Compare supported converted payloads before and after a trusted observer.
 * Exact human messages and system declarations cannot be changed at this last
 * boundary. Unsupported changed payload formats fail conservatively. */
export function assertPayloadInstructions(before:unknown,after:unknown,anchors:AgentMessage[]) {
  const initial=before as {messages?:unknown[];tools?:unknown;tool_choice?:unknown;system?:unknown;instructions?:unknown;systemInstruction?:unknown},final=after as typeof initial
  if(!initial||!final||!Array.isArray(initial.messages)||!Array.isArray(final.messages)){
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Changed provider payload cannot prove protected exact instructions')
    return
  }
  const strings=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[]
  const users=initial.messages.filter(message=>(message as {role?:string})?.role==='user')
  const markers=anchors.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?[message.content]:message.content.map(part=>part.type==='text'?part.text:part.data))
  // Native image conversion may wrap base64 bytes in a URL or a source object.
  // If an exact anchor cannot be mapped, preserve every converted user message.
  const protectAllUsers=markers.some(parts=>!parts.length||parts.some(marker=>!users.some(user=>strings(user).some(value=>value.includes(marker)))))
  const protectedMessages=initial.messages.filter(original=>{
    const role=(original as {role?:string})?.role
    return role==='system'||role==='developer'||role==='user'&&(protectAllUsers||markers.flat().some(marker=>strings(original).some(value=>value.includes(marker))))
  })
  let cursor=0
  for(const original of protectedMessages){
    const found=final.messages.findIndex((value,index)=>index>=cursor&&JSON.stringify(value)===JSON.stringify(original))
    if(found<0)throw new Error('Provider payload observer changed protected exact human instructions or host constraints')
    cursor=found+1
  }
  const systemMessages=(messages:unknown[])=>messages.filter(message=>['system','developer'].includes((message as {role:string})?.role))
  if(JSON.stringify(systemMessages(initial.messages))!==JSON.stringify(systemMessages(final.messages))||
    JSON.stringify(initial.system)!==JSON.stringify(final.system)||JSON.stringify(initial.instructions)!==JSON.stringify(final.instructions)||JSON.stringify(initial.systemInstruction)!==JSON.stringify(final.systemInstruction))
    throw new Error('Provider payload observer changed protected host constraints')
  if(JSON.stringify(initial.tools)!==JSON.stringify(final.tools)||JSON.stringify(initial.tool_choice)!==JSON.stringify(final.tool_choice))
    throw new Error('Provider payload observer changed protected tool declarations')
}
