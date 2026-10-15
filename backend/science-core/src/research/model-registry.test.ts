import {expect, test} from 'bun:test'
import {ProtoModelRegistry} from './model-registry'
import {ResearchWorkflow} from './workflow'
const commit = 'a'.repeat(40)
function card(key = 'boltz2-prediction', features: Partial<Record<ProtoModelRegistry.Feature, boolean | null>> = {}): ProtoModelRegistry.Card {
  const empty = Object.fromEntries(ProtoModelRegistry.Feature.options.map(name => [name, null]))
  return ProtoModelRegistry.Card.parse({format:'autofold.proto-model-card.v1',key,kind:'tool',label:key,category:'structure_prediction',description:'Fixture',roles:['complex_prediction'],registration:'registered',assetReadiness:'unknown',usesGpu:true,deviceCount:'1',inputSchema:{properties:{complexes:{}}},configSchema:null,outputSchema:null,inputFields:['complexes'],configFields:[],supportedEntityTypes:['protein'],nativeFeatures:{...empty,cyclic_bonds:true},bridgeFeatures:{...empty,complex_sequences:true,cyclic_bonds:false,...features},metrics:[],seedFields:[],licenseDeclaration:{code:{spdx:'MIT'}},weightLicenseStatus:'unverified',links:null,resourceProfile:null,limitations:['Fixture is not model validation']})
}
const provenance={languageCommit:commit,toolsCommit:commit,workerHash:'sha256:'+'b'.repeat(64)}
test('snapshot identity is deterministic, source-bound and duplicate-safe',()=>{
 const a=ProtoModelRegistry.snapshot([card('chai1-prediction'),card()],provenance)
 expect(a.contentHash).toBe(ProtoModelRegistry.snapshot([card(),card('chai1-prediction')],provenance).contentHash)
 expect(a.contentHash).not.toBe(ProtoModelRegistry.snapshot([card(),card('chai1-prediction')],{...provenance,workerHash:'sha256:'+'c'.repeat(64)}).contentHash)
 expect(()=>ProtoModelRegistry.snapshot([card(),card()],provenance)).toThrow('Duplicate')
 expect(ProtoModelRegistry.planningView(a,['boltz2-prediction']).entries[0]?.assetReadiness).toBe('unknown')
 expect(ProtoModelRegistry.planningView(a,['boltz2-prediction']).entries[0]).not.toHaveProperty('inputSchema')
})
test('native declarations cannot bypass unsupported or unknown adapter inputs',()=>{
 expect(()=>ProtoModelRegistry.assertCompatible(card(),{features:['complex_sequences']},'boltz')).not.toThrow()
 expect(()=>ProtoModelRegistry.assertCompatible(card(),{features:['cyclic_bonds']},'boltz')).toThrow('unsupported')
 expect(()=>ProtoModelRegistry.assertCompatible(card(),{features:['glycans']},'boltz')).toThrow('unknown')
 expect(()=>ProtoModelRegistry.assertCompatible(undefined,{features:['complex_sequences']},'boltz')).toThrow('unavailable')
})
function compile(selection:'all'|'first_available', features:ProtoModelRegistry.Feature[], cards:ProtoModelRegistry.Card[]) {
 return ResearchWorkflow.compile({plan:{format:'autofold.proto-workflow.v1',id:'fixture',maximumGpuSeconds:60,stages:[{id:'probe',role:'diagnostic',capability:'structure_prediction',tools:cards.map(item=>item.key),configs:Object.fromEntries(cards.map(item=>[item.key,{use_msa:false}])),inputRequirements:{features},selection,maximumGpuSeconds:30}]},tools:cards.map(modelCard=>({key:modelCard.key,category:modelCard.category,usesGpu:true,modelCard})),contract:{budget:{maximumCandidates:1,gpuHours:1,wallTimeMinutes:1},evaluator:{submissionSize:1}},protoToolsCommit:commit,protoLanguageCommit:commit})
}
test('compiler rejects chemical loss before dispatch and selects first compatible registered adapter',()=>{
 expect(()=>compile('all',['cyclic_bonds'],[card()])).toThrow('cannot preserve')
 const alternate=card('fixture-topology-adapter',{cyclic_bonds:true})
 const result=compile('first_available',['cyclic_bonds'],[card(),alternate])
 expect(result.stages[0]?.models[0]?.id).toBe('fixture-topology-adapter')
 expect(result.stages[0]?.inputRequirements).toEqual({features:['cyclic_bonds']})
 expect(result.authoredDiagnostics?.[0]?.inputRequirements).toEqual({features:['cyclic_bonds']})
 expect(()=>compile('first_available',['glycans'],[card()])).toThrow('no Proto adapter')
})
test('compiler accepts unchanged legacy plans while explicit unknown requirements fail closed',()=>{
 const legacy={format:'autofold.proto-workflow.v1' as const,id:'legacy',maximumGpuSeconds:60,stages:[{id:'score',capability:'structure_prediction',tools:['boltz2-prediction'],configs:{'boltz2-prediction':{use_msa:false}},maximumGpuSeconds:30}]}
 const input={plan:legacy,tools:[{key:'boltz2-prediction',category:'structure_prediction',usesGpu:true}],contract:{budget:{maximumCandidates:1,gpuHours:1,wallTimeMinutes:1},evaluator:{submissionSize:1}},protoToolsCommit:commit,protoLanguageCommit:commit}
 expect(ResearchWorkflow.compile(input).stages[0]).not.toHaveProperty('inputRequirements')
 expect(()=>ResearchWorkflow.compile({...input,plan:{...legacy,stages:[{...legacy.stages[0]!,inputRequirements:{features:['complex_sequences']}}]}})).toThrow('metadata is unavailable')
})

test('model cards disclose full schemas through bounded exact-identity pages', () => {
 const registry=ProtoModelRegistry.snapshot([card()],provenance)
 const content=JSON.stringify(registry.entries[0],null,2)
 let offset=0, rebuilt=''
 while(offset<content.length){const page=ProtoModelRegistry.readCard(registry,{key:'boltz2-prediction',kind:'tool',section:'card',offset,limit:137});expect(page.content.length).toBeLessThanOrEqual(137);expect(page.contentHash).toBe(registry.contentHash);rebuilt+=page.content;offset=page.nextOffset??content.length}
 expect(rebuilt).toBe(content)
 expect(ProtoModelRegistry.readCard(registry,{key:'boltz2-prediction',kind:'tool',section:'inputSchema'}).content).toBe(JSON.stringify(registry.entries[0]!.inputSchema,null,2))
 expect(()=>ProtoModelRegistry.readCard(registry,{key:'boltz2-prediction',kind:'generator'})).toThrow('not found')
 expect(()=>ProtoModelRegistry.readCard(registry,{key:'boltz2-prediction',kind:'tool',limit:24001})).toThrow()
 expect(()=>ResearchWorkflow.Tool.parse({key:'different-tool',category:'structure_prediction',usesGpu:true,modelCard:card()})).toThrow('identity')
 expect(()=>ProtoModelRegistry.Requirements.parse({features:['cyclic_bonds','cyclic_bonds']})).toThrow('unique')
})


test('bounded planning inventory summarizes installed components while full identities and schemas stay searchable',()=>{
 const large={...card(),resourceProfile:{unrelatedSetting:'x'.repeat(100000)},semantics:{nestedSettings:'y'.repeat(100000)},configSchema:{type:'object',properties:{chosen:{type:'string',description:'z'.repeat(10000)}}}}
 const registry=ProtoModelRegistry.snapshot([large],null),before=JSON.stringify(registry),view=ProtoModelRegistry.planningView(registry,[large.key])
 expect(view.entryCount).toBe(1);expect(view.countsByKind.tool).toBe(1);expect(view.entries.map(e=>[e.kind,e.key])).toEqual([[large.kind,large.key]])
 expect(JSON.stringify(view).length).toBeLessThan(2500)
 expect(view.entries[0]).not.toHaveProperty('resourceProfile');expect(view.entries[0]).not.toHaveProperty('semantics')
 expect(view.searchableInventory).toContain('every registered identity')
 const summary=ProtoModelRegistry.readCard(registry,{key:large.key,kind:large.kind})
 expect(summary.section).toBe('summary');expect(JSON.parse(summary.content).bridgeFeatures).toEqual(large.bridgeFeatures)
 expect(JSON.parse(summary.content)).not.toHaveProperty('configSchema');expect(summary.content).not.toContain('unrelatedSetting')
 const config=ProtoModelRegistry.readCard(registry,{key:large.key,kind:large.kind,section:'configSchema'})
 expect(config.content).toHaveLength(4000);expect(config.nextOffset).toBe(4000);expect(config.contentHash).toBe(registry.contentHash)
 expect(JSON.stringify(registry)).toBe(before)
})

test('empty or partial installed inventories stay safe and long exact identities never enter as truncated lookup keys',()=>{
 const prefix='x'.repeat(140),first=card(prefix+'-first'),second=card(prefix+'-second')
 const registry=ProtoModelRegistry.snapshot([first,second,card('short-installed')],null)
 const empty=ProtoModelRegistry.planningView(registry,[])
 expect(empty.entries).toEqual([])
 expect(empty.entryCount).toBe(3)
 const partial=ProtoModelRegistry.planningView(registry,['short-installed',first.key,second.key])
 expect(partial.entries.map(item=>item.key)).toEqual(['short-installed'])
 expect(partial.omittedRelevantSummaryCount).toBe(2)
 expect(ProtoModelRegistry.readCard(registry,{key:first.key,kind:'tool'}).key).toBe(first.key)
 expect(ProtoModelRegistry.readCard(registry,{key:second.key,kind:'tool'}).key).toBe(second.key)
})

test('worst-case planning view is byte-bounded and never replaces the lossless card source',()=>{
 const cards=Array.from({length:512},(_,index)=>({...card(`installed-${index}`),category:'\u0001'.repeat(300),description:'\u0002'.repeat(300)}))
 const registry=ProtoModelRegistry.snapshot(cards,null),before=JSON.stringify(registry)
 const installed=cards.map(item=>item.key),view=ProtoModelRegistry.planningView(registry,installed)
 expect(view.entries).toHaveLength(12)
 expect(view.omittedRelevantSummaryCount).toBe(500)
 expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(16_000)
 expect(view.entryCount).toBe(512)
 const selected=ProtoModelRegistry.readCard(registry,{key:'installed-511',kind:'tool',section:'configSchema'})
 expect(selected.contentHash).toBe(registry.contentHash)
 expect(selected.content).toBe(JSON.stringify(cards[511]!.configSchema,null,2))
 expect(JSON.stringify(registry)).toBe(before)
})
