import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {PiWorkspaceTools} from '../runtime'
import {checkedPath} from '../execution/paths'
import type {ScientificExecution} from '../execution'
import type {ResearchStore} from '@autofold/science-core/store'
import type {ResearchDomain} from '@autofold/science-core/domain'
const digest=(value:string)=>'sha256:'+crypto.createHash('sha256').update(value).digest('hex')
const filePageDefault=40,filePageMaximum=100,filePageBytesDefault=12_000,filePageBytesMaximum=16_000
const searchPageDefault=20,searchPageMaximum=100,searchPageBytesDefault=12_000,searchPageBytesMaximum=16_000,searchScanBytesMaximum=4*1024*1024,searchFileBytesMaximum=4*1024*1024
type Cursor={kind:'list'|'search';base:string;query?:string;glob?:string;caseSensitive?:boolean;after:string;line?:number}
function encodeCursor(cursor:Cursor){return Buffer.from(JSON.stringify(cursor),'utf8').toString('base64url')}
function decodeCursor(value:string|undefined,expected:Pick<Cursor,'kind'|'base'|'query'|'glob'|'caseSensitive'>):Cursor|undefined {
  if(value===undefined)return undefined
  if(value.length>4096)throw new Error('Workspace cursor is too large')
  let parsed:unknown
  try{parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'))}catch{throw new Error('Invalid workspace cursor')}
  if(!parsed||typeof parsed!=='object')throw new Error('Invalid workspace cursor')
  const cursor=parsed as Cursor
  if(cursor.kind!==expected.kind||cursor.base!==expected.base||cursor.query!==expected.query||cursor.glob!==expected.glob||typeof cursor.after!=='string'||
    cursor.caseSensitive!==expected.caseSensitive||cursor.kind==='search'&&(!Number.isInteger(cursor.line)||cursor.line!<1))throw new Error('Workspace cursor does not match this search or path filter')
  return cursor
}
function globExpression(glob:string|undefined) {
  if(!glob)return true
  if(!glob.length||glob.length>256||glob.includes('\\')||glob.split('/').some(part=>part==='..'))throw new Error('Invalid workspace glob')
  return new Bun.Glob(glob)
}
function matchesGlob(relative:string,matcher:Bun.Glob|true){return matcher===true||matcher.match(relative)}
function boundedLine(line:string){return line.length<=500?line:line.slice(0,500)+'…'}
function matchExcerpt(line:string,query:string,caseSensitive:boolean) {
  const haystack=caseSensitive?line:line.toLowerCase(),needle=caseSensitive?query:query.toLowerCase(),at=haystack.indexOf(needle)
  const start=Math.max(0,Math.min(at-160,line.length-720)),end=Math.min(line.length,start+720)
  return {text:(start>0?'…':'')+line.slice(start,end)+(end<line.length?'…':''),column:at+1,truncatedBefore:start>0,truncatedAfter:end<line.length}
}
interface WorkspaceHost {
  workspace:string;root:string;execution:Pick<ScientificExecution,'artifacts'>;initialize():Promise<void>
  scope():Promise<{state:Awaited<ReturnType<ResearchStore['read']>>;experiment:ResearchDomain.Experiment}>
  verifyReference(relative:string,bytes:Buffer):Promise<void>
  /** Frozen hosts replace the default current-experiment artifact expansion. */
  authorizeExternalRead?(relative:string):Promise<boolean>
}
/** Scope and integrity policy only; native Pi implements generic file operations. */
export class ScientificWorkspace {
  private readonly native:PiWorkspaceTools
  constructor(private readonly host:WorkspaceHost) {
    this.native=new PiWorkspaceTools({cwd:path.resolve(host.workspace,host.root),resolve:(input,write)=>this.resolve(input,write),
      read:absolute=>this.readBytes(absolute),write:(absolute,content)=>this.writeBytes(absolute,content),
      mkdir:async absolute=>{
        const relative=path.relative(host.workspace,absolute).split(path.sep).join('/')
        if(relative!==host.root&&relative!==host.root+'/programs'&&!relative.startsWith(host.root+'/programs/'))throw new Error('Mutable scientist directories are restricted')
        await fs.mkdir(await checkedPath(host.workspace,relative),{recursive:true,mode:0o700})
      }})
  }
  relative(input:string) {
    const absolute=path.resolve(this.host.workspace,input.startsWith('.autofold/')||path.isAbsolute(input)?input:this.host.root+'/'+input)
    return path.relative(this.host.workspace,absolute).split(path.sep).join('/')
  }
  private mutable(relative:string) {return relative===this.host.root+'/trial.py'||relative===this.host.root+'/LAB.md'||relative.startsWith(this.host.root+'/programs/')&&relative.endsWith('.py')}
  async resolve(input:string,write=false) {
    await this.host.initialize();const relative=this.relative(input)
    if(write?!this.mutable(relative):!relative.startsWith(this.host.root+'/')) {
      if(write)throw new Error('Mutable scientist files are trial.py, programs/**/*.py and LAB.md')
      if(this.host.authorizeExternalRead){if(!await this.host.authorizeExternalRead(relative))throw new Error('File is outside the frozen scientific workspace')}
      else {const {state,experiment}=await this.host.scope(),trials=Object.values(state.trials).filter(t=>t.experimentId===experiment.id),ids=new Set(trials.map(t=>t.id))
      const runs=Object.values(state.runs).filter(run=>ids.has(run.trialId))
      if(!trials.some(t=>relative===t.programPath)&&!runs.some(run=>relative===run.bundlePath||relative.startsWith(run.outputPath+'/')))throw new Error('File is outside this scientist experiment')}
    }
    return {relative,absolute:await checkedPath(this.host.workspace,relative)}
  }
  private async browsePath(input:string) {
    await this.host.initialize();const relative=this.relative(input)
    if(relative===this.host.root)return {relative,absolute:await checkedPath(this.host.workspace,relative)}
    return this.resolve(input)
  }
  private async readBytes(input:string) {
    const file=await this.resolve(input)
    if(file.relative.startsWith('.autofold/runs/')) {
      const {state}=await this.host.scope(),run=Object.values(state.runs).find(run=>file.relative===run.bundlePath||file.relative.startsWith(run.outputPath+'/'))
      if(run?.status==='succeeded')await this.host.execution.artifacts(run.id)
    }
    const stat=await fs.stat(file.absolute)
    if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('Read requires a regular evidence file of at most 4 MiB')
    const bytes=await fs.readFile(file.absolute);await this.host.verifyReference(file.relative,bytes);return bytes
  }
  private async writeBytes(input:string,content:string) {
    const file=await this.resolve(input,true)
    if(!content.length||Buffer.byteLength(content)>262144||content.includes('\0'))throw new Error('Scientist files require 1–262144 UTF-8 bytes without NUL')
    await fs.writeFile(await checkedPath(this.host.workspace,file.relative),content,{mode:0o600})
  }
  read(input:{path:string;offset?:number;limit?:number}) {
    const offset=input.offset??1,limit=input.limit??200
    if(!Number.isInteger(offset)||offset<1||!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid read line range')
    return this.native.read({...input,offset,limit})
  }
  async write(input:{path:string;content:string}) {await this.native.write(input);return {path:this.relative(input.path),programHash:digest(input.content)}}
  async edit(input:{path:string;oldText:string;newText:string}) {
    await this.native.edit(input);const file=await this.resolve(input.path,true),content=(await this.readBytes(file.absolute)).toString('utf8')
    return {path:file.relative,programHash:digest(content)}
  }
  nativeTools() {
    // Preserve Pi's schemas, edit semantics and result content. The science host
    // adds only actual-byte provenance receipts for its scoped mutable files.
    return this.native.tools().map(tool=>tool.name==='read'?{...tool,description:tool.description+' Scientific source reads default to 200 lines; use offset/limit to request more when needed.',execute:async(...parameters:Parameters<typeof tool.execute>)=>{
      const [id,args,signal,update]=parameters
      if(!args||typeof args!=='object'||!('path' in args)||typeof args.path!=='string')throw new Error('Scientist file tool requires a path')
      const input=args as {path:string;offset?:number;limit?:number}
      return tool.execute(id,{...input,limit:input.limit??200},signal,update)
    }}:!['write','edit'].includes(tool.name)?tool:{...tool,execute:async(...parameters:Parameters<typeof tool.execute>)=>{
      const [id,args,signal,update]=parameters
      if(!args||typeof args!=='object'||!('path' in args)||typeof args.path!=='string')throw new Error('Scientist file tool requires a path')
      const file=await this.resolve(args.path,true)
      const hash=async()=> 'sha256:'+crypto.createHash('sha256').update(await this.readBytes(file.absolute)).digest('hex')
      let previousProgramHash:string|undefined
      try{previousProgramHash=await hash()}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      const result=await tool.execute(id,args,signal,update)
      return {...result,details:{...result.details,path:file.relative,previousProgramHash,programHash:await hash()}}
    }})
  }
  async list() {
    return this.collectFiles(this.host.root)
  }
  private async collectFiles(input:string) {
    const selected=await this.browsePath(input),stat=await fs.stat(selected.absolute),files:string[]=[]
    if(stat.isFile())return [selected.relative]
    if(!stat.isDirectory())throw new Error('Workspace listing requires a regular file or directory')
    const visit=async(absolute:string)=>{
      const directory=await checkedPath(this.host.workspace,path.relative(this.host.workspace,absolute))
      const entries=await fs.readdir(directory,{withFileTypes:true});entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
      for(const entry of entries){
        const target=path.join(directory,entry.name)
        if(entry.isSymbolicLink())throw new Error('Scientist workspace contains a symbolic link')
        if(entry.isDirectory())await visit(target)
        else if(entry.isFile())files.push(path.relative(this.host.workspace,target).split(path.sep).join('/'))
      }
    }
    await visit(selected.absolute);return files.sort()
  }
  private pageBounds(limit:number|undefined,maxBytes:number|undefined,defaults:{limit:number;maxBytes:number;maxLimit:number;maxBytesCeiling:number}) {
    const count=limit??defaults.limit,bytes=maxBytes??defaults.maxBytes
    if(!Number.isInteger(count)||count<1||count>defaults.maxLimit||!Number.isInteger(bytes)||bytes<2048||bytes>defaults.maxBytesCeiling)throw new Error('Invalid bounded workspace page size')
    return {count,bytes}
  }
  async listPage(input:{path?:string;cursor?:string;limit?:number;maxBytes?:number}={}) {
    const bounds=this.pageBounds(input.limit,input.maxBytes,{limit:filePageDefault,maxBytes:filePageBytesDefault,maxLimit:filePageMaximum,maxBytesCeiling:filePageBytesMaximum})
    const selected=await this.browsePath(input.path??this.host.root),files=await this.collectFiles(selected.absolute),base=selected.relative
    const cursor=decodeCursor(input.cursor,{kind:'list',base})
    let start=0
    if(cursor){const exact=files.indexOf(cursor.after);start=exact>=0?exact+1:files.findIndex(file=>file>cursor.after);if(start<0)start=files.length}
    const page:string[]=[]
    for(let index=start;index<files.length&&page.length<bounds.count;index++){
      const candidate=[...page,files[index]!],next=index+1<files.length?encodeCursor({kind:'list',base,after:files[index]!}):undefined
      const response={path:base,files:candidate,hasMore:next!==undefined,nextCursor:next,consistency:'live_workspace',omissions:next?{kind:'remaining_files',count:files.length-index-1,after:files[index]!}:null}
      if(Buffer.byteLength(JSON.stringify(response),'utf8')>bounds.bytes){if(!page.length)throw new Error('A workspace path cannot fit the requested result-byte ceiling');break}
      page.push(files[index]!)
    }
    const last=page.at(-1),nextStart=last?files.indexOf(last)+1:start,hasMore=nextStart<files.length
    const nextCursor=hasMore&&last?encodeCursor({kind:'list',base,after:last}):undefined
    return {path:base,files:page,hasMore,nextCursor,consistency:'live_workspace',omissions:hasMore?{kind:'remaining_files',count:files.length-nextStart,after:last??cursor?.after??null}:null}
  }
  async search(input:string|{query:string;path?:string;glob?:string;caseSensitive?:boolean;cursor?:string;limit?:number;maxBytes?:number;context?:number}) {
    const request=typeof input==='string'?{query:input}:input
    const query=request.query
    if(!query.length||query.length>500||query.includes('\0'))throw new Error('Workspace search query must contain 1–500 non-NUL characters')
    const bounds=this.pageBounds(request.limit,request.maxBytes,{limit:searchPageDefault,maxBytes:searchPageBytesDefault,maxLimit:searchPageMaximum,maxBytesCeiling:searchPageBytesMaximum})
    const context=request.context??0;if(!Number.isInteger(context)||context<0||context>2)throw new Error('Workspace search context must be between 0 and 2 lines')
    const selected=await this.browsePath(request.path??this.host.root),matcher=globExpression(request.glob),selectedIsFile=(await fs.stat(selected.absolute)).isFile(),relativeInScope=(file:string)=>{
      const relative=path.relative(selected.absolute,path.resolve(this.host.workspace,file)).split(path.sep).join('/')
      return selectedIsFile?path.basename(file):relative
    }
    const files=(await this.collectFiles(selected.absolute)).filter(file=>matchesGlob(relativeInScope(file),matcher))
    const base=selected.relative,caseSensitive=request.caseSensitive??true,cursor=decodeCursor(request.cursor,{kind:'search',base,query,glob:request.glob,caseSensitive}),matches:{path:string;line:number;text:string;column:number;truncatedBefore:boolean;truncatedAfter:boolean;context?:{line:number;text:string}[];contextOmitted?:boolean}[]=[]
    let scanBytes=0,scanAfter=cursor?.after??'',scanLine=cursor?.line??0,stopped:'more_matches'|'scan_budget'|'result_bytes'|undefined,largeFiles=0,binaryFiles=0
    outer:for(const file of files){
      if(cursor&&(file<cursor.after||file===cursor.after&&scanLine<1))continue
      const relativeInBase=relativeInScope(file)
      if(!matchesGlob(relativeInBase,matcher))continue
      const absolute=await checkedPath(this.host.workspace,file),stat=await fs.stat(absolute)
      if(stat.size>searchFileBytesMaximum){largeFiles++;scanAfter=file;scanLine=Number.MAX_SAFE_INTEGER;continue}
      if(scanBytes+stat.size>searchScanBytesMaximum){stopped='scan_budget';break}
      const bytes=await this.readBytes(absolute);scanBytes+=bytes.length
      if(bytes.includes(0)){binaryFiles++;scanAfter=file;scanLine=Number.MAX_SAFE_INTEGER;continue}
      const lines=bytes.toString('utf8').split('\n')
      for(let index=0;index<lines.length;index++){
        const lineNumber=index+1
        if(cursor&&(file<cursor.after||file===cursor.after&&lineNumber<=(cursor.line??0)))continue
        const searchLine=caseSensitive?lines[index]!:lines[index]!.toLowerCase(),searchQuery=caseSensitive?query:query.toLowerCase()
        if(searchLine.includes(searchQuery)){
          if(matches.length>=bounds.count){stopped='more_matches';break outer}
          const excerpt=matchExcerpt(lines[index]!,query,caseSensitive),match:{path:string;line:number;text:string;column:number;truncatedBefore:boolean;truncatedAfter:boolean;context?:{line:number;text:string}[];contextOmitted?:boolean}={path:file,line:lineNumber,...excerpt}
          if(context)match.context=lines.slice(Math.max(0,index-context),Math.min(lines.length,index+context+1)).map((text,offset)=>({line:Math.max(0,index-context)+offset+1,text:boundedLine(text)}))
          const trialCursor=encodeCursor({kind:'search',base,query,glob:request.glob,caseSensitive,after:file,line:lineNumber})
          const fits=(candidate:typeof match)=>Buffer.byteLength(JSON.stringify({query,matches:[...matches,candidate],hasMore:true,nextCursor:trialCursor,consistency:'live_workspace',scannedBytes:scanBytes,skipped:{largeFiles,binaryFiles},omissions:{kind:'remaining_matches',after:{path:file,line:lineNumber}}}),'utf8')<=bounds.bytes
          if(!fits(match)&&match.context){delete match.context;match.contextOmitted=true}
          if(!fits(match)){
            if(!matches.length)throw new Error('A workspace search match cannot fit the requested result-byte ceiling')
            stopped='result_bytes';break outer
          }
          matches.push(match)
        }
        scanAfter=file;scanLine=lineNumber
      }
      if(lines.length===0){scanAfter=file;scanLine=0}
    }
    const last=matches.at(-1),after=stopped==='more_matches'||stopped==='result_bytes'?{path:last!.path,line:last!.line}:scanAfter?{path:scanAfter,line:scanLine}:undefined
    const nextCursor=stopped&&after?encodeCursor({kind:'search',base,query,glob:request.glob,caseSensitive,after:after.path,line:after.line}):undefined
    const omissions=stopped?{kind:stopped,after,scanBudgetBytes:stopped==='scan_budget'?searchScanBytesMaximum:undefined}:(largeFiles||binaryFiles)?{kind:'skipped_files',largeFiles,binaryFiles}:null
    const response={query,matches,hasMore:!!nextCursor,nextCursor,consistency:'live_workspace',scannedBytes:scanBytes,skipped:{largeFiles,binaryFiles},omissions}
    if(Buffer.byteLength(JSON.stringify(response),'utf8')>bounds.bytes)throw new Error('Workspace search result exceeded its configured byte ceiling')
    return response
  }
  async capture(input='trial.py') {
    const file=await this.resolve(input,true)
    if(!file.relative.endsWith('.py'))throw new Error('Evaluation requires a Python program file')
    const program=(await this.readBytes(file.absolute)).toString('utf8')
    if(!program.length||Buffer.byteLength(program)>262144||program.includes('\0'))throw new Error('Native program requires 1–262144 UTF-8 bytes without NUL')
    return {program,draftPath:file.relative,programHash:digest(program)}
  }
}
