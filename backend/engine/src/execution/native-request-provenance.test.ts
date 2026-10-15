import {expect, test} from 'bun:test'
import {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import {verifyNativeRequestObservation} from './provenance'

const hash = 'sha256:' + 'a'.repeat(64)
function artifact() {
  return ExecutionProtocol.ModelRunArtifactV2.parse({format:'autofold.model-run.v2',candidateId:'candidate',targetArtifactHash:hash,peptideSequenceHash:hash,stage:'score',
    model:{id:'boltz2-prediction',version:'original',adapterSourceHash:hash,protoToolsCommit:'a'.repeat(40)},parametersHash:hash,seed:7,parentArtifactHashes:[],
    runtime:{wallSeconds:5,requestObservation:{format:'autofold.native-request-observation.v1',rootRequestId:'root',entries:[
      {requestId:'root',parentRequestId:null,tool:'boltz2-prediction',inputHash:hash,configHash:hash,status:'completed',cacheOrigin:'cache_partial',wallSeconds:4,outputSuccess:true},
      {requestId:'nested',parentRequestId:'root',tool:'homology-search',inputHash:hash,configHash:hash,status:'completed',cacheOrigin:'cache_hit',wallSeconds:1,outputSuccess:true},
    ]}},outputs:{structureHash:hash,metricsHash:hash},metrics:{iptm:0.7}})
}
test('frozen evaluator request evidence verifies native nesting and actual cache branches within the whole call deadline',()=>{
  const value=artifact();verifyNativeRequestObservation(value.runtime,'boltz2-prediction',5)
  const parametersHash='sha256:'+new Bun.CryptoHasher('sha256').update(JSON.stringify({configHash:hash,seed:7,tool:'boltz2-prediction'})).digest('hex')
  verifyNativeRequestObservation(value.runtime,'boltz2-prediction',5,{seed:7,parametersHash})
  expect(()=>verifyNativeRequestObservation(value.runtime,'boltz2-prediction',5,{seed:11,parametersHash})).toThrow('actual registered-request configuration')
  expect(value.runtime.gpuSeconds).toBeUndefined()
  for(const cacheOrigin of ['cache_hit','cache_miss','cache_disabled','external_dispatch_backend'] as const){
    const cached=artifact();cached.runtime.requestObservation!.entries[0]!.cacheOrigin=cacheOrigin
    verifyNativeRequestObservation(cached.runtime,'boltz2-prediction',5)
  }
  const historical=artifact();delete historical.runtime.requestObservation
  expect(ExecutionProtocol.ModelRunArtifactV2.parse(historical).runtime.requestObservation).toBeUndefined()
  expect(()=>verifyNativeRequestObservation(historical.runtime,'boltz2-prediction',5)).toThrow('scoped registered-request evidence')
})
test('a completed score cannot launder another tool, failed root, missing cache branch, malformed parent graph or overrun',()=>{
  const check=(mutate:(runtime:ReturnType<typeof artifact>['runtime'])=>void,message:string)=>{
    const value=artifact();mutate(value.runtime)
    expect(()=>verifyNativeRequestObservation(value.runtime,'boltz2-prediction',5)).toThrow(message)
  }
  check(runtime=>runtime.wallSeconds=5.1,'whole invocation wall deadline')
  check(runtime=>runtime.requestObservation!.entries[0]!.tool='chai1-prediction','root differs')
  check(runtime=>runtime.requestObservation!.entries[0]!.status='failed','root differs')
  check(runtime=>runtime.requestObservation!.entries[0]!.cacheOrigin='unobserved','root differs')
  check(runtime=>runtime.requestObservation!.entries[0]!.outputSuccess=false,'root differs')
  check(runtime=>runtime.requestObservation!.entries[1]!.wallSeconds=6,'wall exceeds')
  check(runtime=>runtime.requestObservation!.entries[1]!.parentRequestId='absent','parent is missing')
  check(runtime=>runtime.requestObservation!.entries[1]!.parentRequestId='nested','contain a cycle')
  check(runtime=>runtime.requestObservation!.entries.push({...runtime.requestObservation!.entries[1]!}),'repeats')
})
