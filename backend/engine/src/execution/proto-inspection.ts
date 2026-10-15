import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import z from 'zod'
import {ResearchWorkflow} from '@autofold/science-core/workflow'
import {ProtoModelRegistry} from '@autofold/science-core/research/model-registry'
import {runInspection,type InspectionBoundary} from './inspection-boundary'
export {InspectionContainmentUnavailableError} from './inspection-boundary'

async function inspect(command:string,python:string,args:string[],value:unknown,boundary:InspectionBoundary={}) {
 const result=await runInspection(python,command,args,value===undefined?undefined:JSON.stringify(value),boundary)
 if(result.code===3&&command==='extract')return undefined
 if(result.code!==0)throw new Error((result.stderr||result.stdout).trim()||`Native ${command} inspection failed (exit ${result.code}; boundary ${boundary.containmentName??process.platform})`)
 return result.stdout?JSON.parse(result.stdout):undefined
}
async function inspectionIdentity(boundary:InspectionBoundary) {
 const digest=crypto.createHash('sha256')
 for(const root of [path.join(boundary.workerRoot??path.resolve(import.meta.dir,'../../../worker'),'autofold_worker'),...(boundary.protoRoot?[path.join(boundary.protoRoot,'proto_language'),path.join(boundary.protoRoot,'proto-tools/proto_tools')]:[])]) {
  const visit=async(folder:string):Promise<void>=>{
   for(const item of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(item.name==='__pycache__')continue
    const file=path.join(folder,item.name)
    if(item.isSymbolicLink())throw new Error('Native inspection source must not contain symbolic links')
    if(item.isDirectory())await visit(file)
    else if(item.isFile()&&item.name.endsWith('.py'))digest.update(file).update(await fs.readFile(file))
   }
  };await visit(root)
 }
 return digest.digest('hex')
}
const adapterIdentities=new WeakMap<Function,number>();let nextAdapterIdentity=0
function adapterIdentity(boundary:InspectionBoundary){const executor=boundary.execute??boundary.containment;if(!executor)return 'platform_os';let value=adapterIdentities.get(executor);if(!value){value=++nextAdapterIdentity;adapterIdentities.set(executor,value)}return value}
const descriptions=new Map<string,Promise<ResearchWorkflow.AuthoredTrial>>()
const descriptionSizes=new Map<string,number>()
function removeDescription(key:string){descriptions.delete(key);descriptionSizes.delete(key)}
function boundDescriptions(){
 while(descriptions.size>32||[...descriptionSizes.values()].reduce((a,b)=>a+b,0)>16*1024*1024)
  removeDescription(descriptions.keys().next().value!)
}
/** The only construction subprocess adapter. Exact immutable bytes key semantic reuse;
 * host authority and selected-lane readiness are independently rechecked at launch. */
export namespace ProtoRuntimeInspection {
 export async function preflight(python:string,boundary:InspectionBoundary={}) {
  const report=await inspect('probe',python,[],undefined,{...boundary,protoRoot:undefined})
  if(report?.format!=='autofold.inspection-boundary-probe.v1'||report.inference!==false)throw new Error('Native inspection boundary probe returned an invalid report')
 }

 export async function extract(programPath:string,python:string,boundary:InspectionBoundary={}):Promise<ResearchWorkflow.Plan|undefined> {
  const value=await inspect('extract',python,[programPath],undefined,boundary)
  return value===undefined?undefined:ResearchWorkflow.Plan.parse(value)
 }
 export async function describeTrial(programPath:string,python:string,bundle:Record<string,unknown>,boundary:InspectionBoundary={}):Promise<ResearchWorkflow.AuthoredTrial> {
  // Caller cancellation is never served from another caller's pending work.
  const bytes=await fs.readFile(programPath)
  const identity=crypto.createHash('sha256').update(bytes).update(JSON.stringify({programPath:path.resolve(programPath),python,bundle,sourceIdentity:await inspectionIdentity(boundary),containment:adapterIdentity(boundary),workerRoot:boundary.workerRoot,protoRoot:boundary.protoRoot})).digest('hex')
  if(boundary.signal||boundary.cache===false)return ResearchWorkflow.AuthoredTrial.parse(await inspect('describeTrial',python,[programPath],bundle,boundary))
  let cached=descriptions.get(identity)
  if(!cached){cached=inspect('describeTrial',python,[programPath],bundle,boundary).then(value=>{const parsed=ResearchWorkflow.AuthoredTrial.parse(value);if(descriptions.has(identity)){descriptionSizes.set(identity,Buffer.byteLength(JSON.stringify(parsed)));boundDescriptions()}return parsed}).catch(error=>{removeDescription(identity);throw error});descriptions.set(identity,cached);boundDescriptions()}
  return structuredClone(await cached)
 }
 export async function discover(python:string,cwd:string,workerRoot=path.resolve(import.meta.dir,'../../../worker'),boundary:InspectionBoundary={}):Promise<ResearchWorkflow.Tool[]> {
  return z.array(ResearchWorkflow.Tool).parse(await inspect('discover',python,[],undefined,{...boundary,workerRoot,protoRoot:cwd}))
 }
 export async function discoverGenerators(python:string,cwd:string,workerRoot=path.resolve(import.meta.dir,'../../../worker'),onComponents?:(cards:ProtoModelRegistry.Card[])=>void,boundary:InspectionBoundary={}):Promise<ResearchWorkflow.Generator[]> {
  const inventory=await inspect('discoverGenerators',python,[],undefined,{...boundary,workerRoot,protoRoot:cwd})
  onComponents?.(z.array(ProtoModelRegistry.Card).parse(Array.isArray(inventory)?[]:inventory.components))
  return z.array(ResearchWorkflow.Generator).parse(Array.isArray(inventory)?inventory:inventory.generators)
 }
 export async function validateConfigs(raw:ResearchWorkflow.Plan,python:string,cwd:string,boundary:InspectionBoundary={}):Promise<void> {
  await inspect('validateConfigs',python,[],ResearchWorkflow.Plan.parse(raw),{...boundary,protoRoot:cwd})
 }
}
