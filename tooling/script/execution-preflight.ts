import {parseArgs} from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import {loadExecutionConfig} from '../../backend/engine/src/config'
import {ScientificExecution} from '../../backend/engine/src/execution'
import {assertCapabilities} from '../../backend/engine/src/execution/capabilities'
import {ResearchService} from '../../backend/science-core/src/research/service'
import type {ResearchStore} from '../../backend/science-core/src/research/store'

const {values}=parseArgs({options:{'execution-config':{type:'string'},'require-generator':{type:'string',multiple:true},output:{type:'string'},help:{type:'boolean'}},strict:true,allowPositionals:false})
if(values.help){
  console.log('bun tooling/script/execution-preflight.ts --execution-config PROFILE.json [--require-generator boltzgen-binder] [--output NEW_FILE]\nChecks the selected host runtime and installed generator paths without model inference, scientific dispatch or research/session storage. Exact program specifications are checked later before trial admission.')
}else{
  if(!values['execution-config'])throw new Error('--execution-config is required')
  const profile=await loadExecutionConfig(values['execution-config'])
  if(!profile)throw new Error('Execution profile could not be loaded')
  // A readiness command has no research-store authority, even if a later refactor accidentally asks for it.
  const disabledStore:ResearchStore={read:async()=>{throw new Error('Readiness must not access research storage')},mutate:async()=>{throw new Error('Readiness must not mutate research storage')}}
  const execution=new ScientificExecution({...profile,workspace:process.cwd(),projectId:'prj_execution_preflight',research:new ResearchService.Service(disabledStore)})
  const capabilities=await execution.capabilities()
  assertCapabilities(capabilities)
  const required=values['require-generator']??[]
  for(const id of required){
    const lane=capabilities.generators.find(item=>item.id===id)
    if(!lane||lane.available!==true)throw new Error(`Required generator ${id} is ${!lane?'not registered':lane.available===null?'not verified by this readiness check':'unavailable'}${lane?': '+lane.requirement:''}`)
  }
  const report={format:'autofold.execution-readiness.v1',checkedAt:new Date().toISOString(),executionProfile:path.resolve(values['execution-config']),capabilities,requiredGenerators:required,availableGenerators:capabilities.generators.filter(g=>g.available===true).map(g=>g.id),unavailableGenerators:capabilities.generators.filter(g=>g.available===false).map(g=>g.id),unverifiedGenerators:capabilities.generators.filter(g=>g.available===null).map(g=>g.id),scope:'Path/permission/git inventory. Exact generator specs are validated separately before trial admission; path presence does not prove model assets or scientific outcomes.',modelInferenceCalls:0,scientificDispatches:0,researchStorageAccesses:0}
  const content=JSON.stringify(report,null,2)+'\n'
  if(values.output)await fs.writeFile(path.resolve(values.output),content,{flag:'wx',mode:0o600})
  else process.stdout.write(content)
}
