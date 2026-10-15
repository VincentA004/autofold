import {expect,test} from 'bun:test'
import {restoreExactInstructions,instructionProjectionHash,messageHash,assertExactInstructionOrder} from './instructions'
import type {AgentMessage} from '@earendil-works/pi-agent-core'

test('SDK reconstructed system framing deduplicates key order and timestamp without changing original archive identity',()=>{
 const original:AgentMessage={role:'system',content:'Exact trusted instruction.',sections:{preamble:'First',cwd:'Second'},toolsAdded:[{name:'inspect',description:'Inspect',parameters:{type:'object'}}],timestamp:1}
 const reconstructed:AgentMessage={timestamp:18,toolsAdded:original.toolsAdded,sections:original.sections,content:original.content,role:'system'}
 expect(messageHash(reconstructed)).not.toBe(messageHash(original));expect(instructionProjectionHash(reconstructed)).toBe(instructionProjectionHash(original))
 const projected=restoreExactInstructions([reconstructed],[original]);expect(projected).toEqual([original]);expect(projected[0]).toBe(original)
 expect(messageHash(original)).toBe(messageHash(structuredClone(original)))
})

test('original anchor multiplicity and separate repeated human instructions remain exact',()=>{
 const system:AgentMessage={role:'system',content:'Frozen system.',timestamp:1},first:AgentMessage={role:'user',content:'Repeat this exact constraint.',timestamp:2},second:AgentMessage={role:'user',content:'Repeat this exact constraint.',timestamp:3}
 const anchors=[system,system,first,second],projected=restoreExactInstructions([{...system,timestamp:9},first,second],anchors)
 expect(projected).toEqual(anchors);expect(instructionProjectionHash(first)).not.toBe(instructionProjectionHash(second));expect(()=>assertExactInstructionOrder(projected,anchors)).not.toThrow()
})

test('changed ordered system sections, declarations and literal text remain distinct',()=>{
 const original:AgentMessage={role:'system',content:'Frozen system.',sections:{preamble:'First',cwd:'Second'},toolsAdded:[{name:'inspect',description:'Inspect',parameters:{type:'object'}}],timestamp:1}
 for(const changed of [{...original,content:'Changed system.'},{...original,sections:{cwd:'Second',preamble:'First'}},{...original,toolsRemoved:[{name:'inspect'}]},{...original,toolsAdded:[{...original.toolsAdded![0]!,description:'Changed'}]}]){
  expect(instructionProjectionHash(changed)).not.toBe(instructionProjectionHash(original));expect(restoreExactInstructions([changed],[original])).toEqual([original,changed])
 }
})
