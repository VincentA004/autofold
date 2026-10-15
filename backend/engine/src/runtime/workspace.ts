import {createReadTool,createWriteTool,createEditTool} from '@earendil-works/pi-coding-agent'
import type {RuntimeTool} from './types'

export interface WorkspaceFile {relative:string;absolute:string}
export interface WorkspacePolicy {
  cwd:string
  resolve(input:string,write?:boolean):Promise<WorkspaceFile>
  read(absolute:string):Promise<Buffer>
  write(absolute:string,content:string):Promise<void>
  mkdir(absolute:string):Promise<void>
}

/** Native Pi behavior over host-authorized filesystem operations. No ambient filesystem access. */
export class PiWorkspaceTools {
  constructor(readonly policy:WorkspacePolicy) {}
  private readTool(capture?:(bytes:Buffer)=>void) {
    return createReadTool(this.policy.cwd,{autoResizeImages:false,operations:{
      access:async absolute=>{await this.policy.resolve(absolute)},
      readFile:async absolute=>{const bytes=await this.policy.read(absolute);capture?.(bytes);return bytes},
      detectImageMimeType:async()=>null,
    }})
  }
  async read(input:{path:string;offset?:number;limit?:number},signal?:AbortSignal) {
    const file=await this.policy.resolve(input.path);let bytes:Buffer|undefined
    const result=await this.readTool(value=>{bytes=value}).execute(crypto.randomUUID(),{...input,path:file.absolute},signal)
    return {path:file.relative,offset:input.offset??1,totalLines:bytes?.toString('utf8').split('\n').length??0,
      content:result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')}
  }
  private writeTool() {return createWriteTool(this.policy.cwd,{operations:{writeFile:this.policy.write,mkdir:this.policy.mkdir}})}
  private editTool() {return createEditTool(this.policy.cwd,{operations:{access:async absolute=>{await this.policy.resolve(absolute,true)},readFile:this.policy.read,writeFile:this.policy.write}})}
  async write(input:{path:string;content:string},signal?:AbortSignal) {
    const file=await this.policy.resolve(input.path,true)
    return this.writeTool()
      .execute(crypto.randomUUID(),{...input,path:file.absolute},signal)
  }
  async edit(input:{path:string;oldText?:string;newText?:string;edits?:{oldText:string;newText:string}[]},signal?:AbortSignal) {
    const file=await this.policy.resolve(input.path,true)
    return this.editTool()
      .execute(crypto.randomUUID(),{path:file.absolute,edits:input.edits??[{oldText:input.oldText!,newText:input.newText!}]},signal)
  }
  tools():RuntimeTool<any>[] {
    const read=this.readTool(),write=this.writeTool(),edit=this.editTool()
    return [
      {...read,execute:async(id:string,args:any,signal?:AbortSignal)=>{const file=await this.policy.resolve(args.path);return this.readTool().execute(id,{...args,path:file.absolute},signal)}},
      {...write,execute:async(_id:string,args:any,signal?:AbortSignal)=>this.write(args,signal)},
      {...edit,execute:async(_id:string,args:any,signal?:AbortSignal)=>this.edit(args,signal)},
    ].map(tool=>({...tool,executionMode:'sequential',replay:'never'})) as RuntimeTool<any>[]
  }
}

/** Replay native edit semantics over supplied bytes for provenance verification.
 * The operations adapter is entirely in memory; no filesystem access occurs. */
export async function replayWorkspaceEdits(content:string,edits:unknown):Promise<string|undefined> {
  let result:string|undefined
  const tool=createEditTool('/autofold-provenance-audit',{operations:{access:async()=>{},readFile:async()=>Buffer.from(content,'utf8'),writeFile:async(_path,edited)=>{result=edited}}})
  try {await tool.execute('provenance-replay',{path:'trial.py',edits} as Parameters<typeof tool.execute>[1]);return result}
  catch {return undefined}
}
