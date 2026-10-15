import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {checkedPath} from './paths'

const maximumFileBytes=512*1024, maximumTotalBytes=16*1024*1024, maximumFiles=1600
const sha=(bytes:Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')
const selected=(name:string,packageName:string)=>!name.split('/').some(part=>part.startsWith('.')||/^(credentials?|secrets?|tokens?|passwords?|private[_-]?keys?)([._-]|$)/i.test(part))&&
 /\.(py|md)$/.test(name)&&(name==='README.md'||name.startsWith(packageName+'/')||/^(docs|examples|guides)\//.test(name))
async function git(root:string,args:string[]){
 const process=Bun.spawn(['git','-C',root,...args],{stdout:'pipe',stderr:'pipe'})
 const [code,stdout,stderr]=await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()])
 if(code)throw new Error('Pinned Proto reference git inspection failed: '+stderr.slice(0,500))
 return stdout
}
async function immutable(workspace:string,name:string,bytes:Uint8Array){
 const file=await checkedPath(workspace,name);await fs.mkdir(path.dirname(file),{recursive:true})
 try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o400})}
 catch(error:any){if(error.code!=='EEXIST'||!(await fs.readFile(file)).equals(Buffer.from(bytes)))throw new Error('Immutable Proto reference differs at '+name)}
 if((await fs.stat(file)).mode&0o222)throw new Error('Proto reference must remain read-only: '+name)
}
/** Copies only tracked, bounded API source from exact host-pinned public repositories. Never imported or executed. */
export async function snapshotPinnedProto(workspace:string,relativeRoot:string,proto:{root:string;languageCommit?:string;toolsCommit?:string}){
 if(!path.isAbsolute(proto.root)||!proto.languageCommit?.match(/^[a-f0-9]{40}$/)||!proto.toolsCommit?.match(/^[a-f0-9]{40}$/))throw new Error('Native API references require exact host Proto git pins')
 const root=relativeRoot+'/proto-source/'+proto.languageCommit+'-'+proto.toolsCommit
 const files:Array<{path:string;source:string;blob:string;bytes:number;contentHash:string}>=[],captured:Array<{name:string;bytes:Uint8Array}>=[]
 let total=0
 for(const [scope,directory,commit,packageName] of [['language',proto.root,proto.languageCommit,'proto_language'],['tools',path.join(proto.root,'proto-tools'),proto.toolsCommit,'proto_tools']] as const){
  if((await git(directory,['rev-parse','HEAD'])).trim()!==commit)throw new Error('Pinned Proto reference HEAD mismatch: '+scope)
  const entries=(await git(directory,['ls-tree','-r','-z',commit])).split('\0').filter(Boolean).sort()
  let count=0
  for(const entry of entries){
   const match=/^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry);if(!match)throw new Error('Invalid pinned Proto git tree')
   const [,mode,type,blob,name]=match
   if(!selected(name!,packageName))continue
   if(type!=='blob'||mode==='120000'||name!.split('/').includes('..')||path.isAbsolute(name!))throw new Error('Pinned Proto reference contains an unsafe tracked file')
   let current=directory
   for(const component of name!.split('/')){current=path.join(current,component);if((await fs.lstat(current)).isSymbolicLink())throw new Error('Pinned Proto reference contains a symbolic link')}
   const metadata=await fs.stat(current)
   if(!metadata.isFile()||metadata.size>maximumFileBytes)throw new Error('Pinned Proto reference exceeds per-file bound')
   const bytes=await fs.readFile(current),actualBlob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')
   if(actualBlob!==blob)throw new Error('Pinned Proto source differs from committed bytes: '+scope+'/'+name)
   total+=bytes.length;count++
   if(total>maximumTotalBytes||files.length>=maximumFiles)throw new Error('Pinned Proto reference exceeds snapshot bounds')
   const relative=scope+'/'+name
   files.push({path:relative,source:scope,blob:blob!,bytes:bytes.length,contentHash:sha(bytes)});captured.push({name:root+'/'+relative,bytes})
  }
  if(!count)throw new Error('Pinned Proto reference has no selected API source: '+scope)
 }
 const contentHash=sha(Buffer.from(JSON.stringify(files))),manifest={format:'autofold.pinned-proto-reference.v1',languageCommit:proto.languageCommit,toolsCommit:proto.toolsCommit,contentHash,totalBytes:total,limits:{maximumFileBytes,maximumTotalBytes,maximumFiles},files}
 for(const file of captured)await immutable(workspace,file.name,file.bytes)
 await immutable(workspace,root+'/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'))
 const entryPoints = [
  ['language/proto_language/core/program.py','Program constructor and optimizer composition'],
  ['language/proto_language/core/portfolio.py','PortfolioProgram and named independent native lanes'],
  ['language/proto_language/core/execution_observer.py','Scoped sampling, construction admission guard and hosted process lifetime'],
  ['tools/proto_tools/utils/execution_observer.py','Scoped registered requests, actual cache origin and cancellation'],
  ['language/proto_language/core/construct.py','Construct constructor'],
  ['language/proto_language/core/segment.py','Segment constructor'],
  ['language/proto_language/core/constraint.py','Typed custom objectives, hard gates and gradient outputs'],
  ['language/proto_language/optimizer/mcmc_optimizer.py','Mutation search and annealing'],
  ['language/proto_language/optimizer/cycling_optimizer.py','Conditioned structure/sequence feedback'],
  ['language/proto_language/optimizer/gradient_optimizer.py','Differentiable objectives'],
  ['language/proto_language/optimizer/genetic_algorithm_optimizer.py','Population search and Pareto selection'],
  ['language/proto_language/optimizer/rejection_sampling_optimizer.py','RejectionSamplingOptimizer configuration and constraints'],
 ].filter(([name])=>files.some(file=>file.path===name)).map(([name,label])=>`- ${root}/${name}: ${label}.`).join('\n')
 return {root,manifest,description:`Pinned native Proto API reference: ${root}/language/README.md, ${root}/language/proto_language/, ${root}/tools/README.md and ${root}/tools/proto_tools/.\nRelevant native authoring entry points (present in the frozen snapshot):\n${entryPoints}\nBounded read-only committed source snapshot (${files.length} files, ${total} bytes); manifest ${root}/manifest.json, content hash ${contentHash}. Read APIs and relevant examples here; these reference copies are never executed.`}
}
