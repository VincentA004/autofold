import {expect, test} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {ExecutionProtocol} from "@autofold/science-core/execution-protocol"
import {verifyGenerationRuns, fileHash} from "./provenance"

async function fixture() {
 const output=await fs.mkdtemp(path.join(os.tmpdir(),"native-receipt-"))
 const hash="sha256:"+"1".repeat(64), commit="a".repeat(40)
 const admission:ExecutionProtocol.NativeSearch={format:"autofold.native-search.v1",
  budget:{maximumCandidates:1,maximumProposals:10,maximumSamplingCalls:5,maximumToolCalls:2,maximumWallSeconds:30,allowedTools:["cpu-tool"],outputs:[{construct:"design",segment:null,lane:0}]},
  projection:[{lane:0,numResults:1,externalInputs:[],constructs:[{label:"design"}],stages:[{instanceId:"lane0.stage0",optimizer:"RejectionSamplingOptimizer",config:{},settings:{},targetSegment:null,customLogging:null,numResults:1,conditioning:null,generators:[],constraints:[]}]}]}
 const receipt={format:"autofold.native-search-receipt.v1",runId:"run_original",programHash:hash,admission,
  counts:{proposals:0,samplingCalls:0,toolCalls:1},samplings:[],calls:[{tool:"cpu-tool",status:"completed"}],wallSeconds:1,lanes:[],selected:[{sequence:{sequence:"ACDE"}}]}
 await fs.mkdir(path.join(output,"native-search"));await fs.mkdir(path.join(output,"generation-runs"))
 const sequenceHash="sha256:"+new Bun.CryptoHasher("sha256").update("ACDE").digest("hex")
 const artifact={format:"autofold.generation-run.v1",candidateId:"pep_original",targetArtifactHash:hash,sequenceHash,
 generator:{id:"proto-program",version:commit,protoLanguageCommit:commit,protoToolsCommit:commit,components:[]},
 programHash:hash,parametersHash:hash,seed:1,generationSeed:123,metadata:{},outputs:{sequenceHash}}
 await Bun.write(path.join(output,"generation-runs/candidate.json"),JSON.stringify(artifact))
 const artifactHash=await fileHash(path.join(output,"generation-runs/candidate.json"))
 const index={format:"autofold.generation-run-index.v1",runId:"run_original",programHash:hash,runtime:{wallSeconds:1},entries:[{candidateId:"pep_original",seed:1,modelId:"proto-program",artifactPath:"generation-runs/candidate.json",artifactHash}],nativeSearch:{path:"native-search/receipt.json",hash}}
 const write=async()=>{await Bun.write(path.join(output,"native-search/receipt.json"),JSON.stringify(receipt));index.nativeSearch.hash=await fileHash(path.join(output,"native-search/receipt.json"));await Bun.write(path.join(output,"generation-runs/index.json"),JSON.stringify(index))}
 await write()
 const bundle={format:"autofold.trial-bundle.v4",runId:"run_original",programHash:hash,designAdapter:"proto",proto:{languageCommit:commit,toolsCommit:commit},targetArtifactHash:hash,seeds:[1],generationSeed:123,pipeline:{nativeSearch:structuredClone(admission)}} as ExecutionProtocol.TrialBundle
 const candidates={format:"autofold.candidate-set.v1",runId:"run_original",trialId:"trl_original",candidates:[{id:"pep_original",sequence:"ACDE",seed:1,generation:{model:"proto-program",version:commit,artifactHash,parametersHash:hash}}]} as ExecutionProtocol.CandidateSet
 return {output,receipt,index,bundle,candidates,write}
}

test("native search original receipts reverify without executing code, and tampering is rejected",async()=>{
 const f=await fixture()
 try {
  await verifyGenerationRuns(f.output,f.bundle,f.candidates)
  await verifyGenerationRuns(f.output,f.bundle,f.candidates)
  await Bun.write(path.join(f.output,"native-search/receipt.json"),"{}")
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("hash mismatch")
  await f.write();f.receipt.counts.proposals=11;await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("resource limits")
  f.receipt.counts.proposals=0;f.receipt.admission.projection[0]!.stages[0]!.config={num_steps:99};await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("frozen admission")
 }finally{await fs.rm(f.output,{recursive:true,force:true})}
})

test("native receipts cannot omit evidence or invent a submitted design or admitted tool",async()=>{
 const f=await fixture()
 try {
  f.receipt.calls[0]!.tool="undeclared";await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("resource limits")
  f.receipt.calls[0]!.tool="cpu-tool";f.receipt.selected[0]!.sequence.sequence="CCCC";await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("resource limits")
  f.receipt.selected[0]!.sequence.sequence="ACDE";await f.write()
  const {nativeSearch,...without}=f.index
  await Bun.write(path.join(f.output,"generation-runs/index.json"),JSON.stringify(without))
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("omits native search")
 }finally{await fs.rm(f.output,{recursive:true,force:true})}
})

test("generation provenance binds the authoring seed separately from the actual program seed",async()=>{
 const f=await fixture()
 try{
  await verifyGenerationRuns(f.output,f.bundle,f.candidates)
  const artifactPath=path.join(f.output,"generation-runs/candidate.json"),artifact=JSON.parse(await Bun.file(artifactPath).text())
  expect(artifact.seed).toBe(1)
  artifact.generationSeed=124
  await Bun.write(artifactPath,JSON.stringify(artifact))
  const artifactHash=await fileHash(artifactPath)
  f.index.entries[0]!.artifactHash=artifactHash
  ;(f.candidates.candidates[0]!.generation as any).artifactHash=artifactHash
  await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("omits or changes its frozen generation seed")
 }finally{await fs.rm(f.output,{recursive:true,force:true})}
})

test("seed-role projections are bound to frozen admission and actual native call identities",async()=>{
 const f=await fixture()
 try {
  const lane=f.receipt.admission.projection[0]!
  const stage=lane.stages[0]!
  lane.programSeed=3051971263
  stage.generators=[{instanceId:"lane0.stage0.generator0",key:"ProteinMPNNGenerator",segments:["binder"],config:{},toolsCalled:["proteinmpnn-sample"]}]
  stage.constraints=[{instanceId:"lane0.stage0.constraint0",function:{name:"fixed_predictor_iptm"},config:{predictor_seed:99173}}]
  f.receipt.admission.budget.allowedTools=["proteinmpnn-sample","boltz2-prediction"]
  f.receipt.counts.toolCalls=2
  f.receipt.calls=[
   {requestId:"mpnn-request-1",tool:"proteinmpnn-sample",status:"completed",configSeed:1987},
   {requestId:"boltz-request-1",tool:"boltz2-prediction",status:"completed",configSeed:99173},
  ] as any
  ;(f.bundle as any).pipeline.nativeSearch=structuredClone(f.receipt.admission)
  const roles={format:"autofold.generation-seed-roles.v1",
   hostGenerationSeed:{value:123,source:"trial_bundle.generationSeed"},
   effectiveProgramSeeds:[{lane:0,value:3051971263,source:"verified_native_projection.programSeed"}],
   declaredPredictorSeeds:[{lane:0,stage:"lane0.stage0",constraint:"lane0.stage0.constraint0",function:"fixed_predictor_iptm",field:"predictor_seed",value:99173,source:"verified_native_projection.constraint.config"}],
   observedToolConfigSeeds:[
    {requestId:"mpnn-request-1",tool:"proteinmpnn-sample",role:"generator_tool",source:"verified_native_tool_call.config",seed:1987},
    {requestId:"boltz-request-1",tool:"boltz2-prediction",role:"predictor_tool",source:"verified_native_tool_call.config",seed:99173},
   ],
   evaluatorSeeds:{values:[1],source:"trial_bundle.seeds"},
  }
  ;(f.receipt as any).seedRoles=structuredClone(roles)
  ;(f.index as any).seedRoles=structuredClone(roles)
  await f.write()
  await verifyGenerationRuns(f.output,f.bundle,f.candidates)

  ;(f.receipt.calls[1] as any).configSeed=99174
  await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("differs from frozen admission or observed tool calls")

  ;(f.receipt.calls[1] as any).configSeed=99173
  ;(f.receipt as any).seedRoles.observedToolConfigSeeds[1].requestId="unknown-request"
  ;(f.index as any).seedRoles.observedToolConfigSeeds[1].requestId="unknown-request"
  await f.write()
  await expect(verifyGenerationRuns(f.output,f.bundle,f.candidates)).rejects.toThrow("differs from frozen admission or observed tool calls")
 }finally{await fs.rm(f.output,{recursive:true,force:true})}
})
