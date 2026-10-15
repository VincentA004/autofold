import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'

const ignored=new Set(['.git','node_modules','__pycache__','.pytest_cache','.ruff_cache','.mypy_cache','.venv','.DS_Store'])
const sha=(value:Uint8Array|string)=>'sha256:'+createHash('sha256').update(value).digest('hex')
/** Read-only inventory: all file bytes of native source and the installed Pi
 * production dependency graph. No VCS checkout, install, source edit or import
 * of dependency executable code occurs. Missing required packages are fatal. */
export async function acceptanceDependencyInventory(input:{repository:string;nativeRoot:string;python:string}){
 const files:Record<string,string>={},links:Record<string,string>={},packages:Record<string,{name:string;version:string;root:string}>={},optionalMissing:string[]=[],visited=new Set<string>()
 async function walk(directory:string,label:string,ancestors=new Set<string>()){
  const real=await fs.realpath(directory)
  if(ancestors.has(real))throw Error('Dependency directory symlink cycle: '+directory)
  const next=new Set(ancestors);next.add(real)
  for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(ignored.has(entry.name))continue
   const full=path.join(directory,entry.name),key=label+'/'+entry.name
   if(entry.isSymbolicLink()){
    const target=await fs.realpath(full);links[key]=target
    const stat=await fs.stat(full);if(stat.isDirectory())await walk(full,key,next);else if(stat.isFile())files[key]=sha(await fs.readFile(full));else throw Error('Unsupported dependency link target: '+full)
   }else if(entry.isDirectory())await walk(full,key,next)
   else if(entry.isFile())files[key]=sha(await fs.readFile(full))
  }
 }
 async function locate(name:string,from:string){
  // Resolve package metadata without invoking package entrypoints or requiring
  // package.json to be public in its exports map.
  for(let directory=from;;directory=path.dirname(directory)){
   const candidate=path.join(directory,'node_modules',name,'package.json')
   try{const metadata=JSON.parse(await fs.readFile(candidate,'utf8'));if(metadata.name===name)return path.dirname(await fs.realpath(candidate))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
   if(path.dirname(directory)===directory)break
  }
  // Bun/npm nested workspaces can resolve through their physical installed path.
  const req=createRequire(path.join(from,'package.json'));let resolved=req.resolve(name),directory=path.dirname(resolved)
  for(;;directory=path.dirname(directory)){try{const metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));if(metadata.name===name)return directory}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(path.dirname(directory)===directory)throw Error('Cannot locate installed package metadata: '+name)}
 }
 async function dependency(name:string,from:string,optional=false){
  let directory:string
  try{directory=await locate(name,from)}catch(error){if(optional){optionalMissing.push(name+' from '+from);return}throw error}
  directory=await fs.realpath(directory);if(visited.has(directory))return;visited.add(directory)
  const metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')),label='npm/'+metadata.name+'@'+metadata.version+'/'+sha(directory).slice(7,19)
  packages[label]={name:metadata.name,version:metadata.version,root:directory};await walk(directory,label)
  for(const child of Object.keys(metadata.dependencies??{}).sort())if(!(child in (metadata.optionalDependencies??{})))await dependency(child,directory,false)
  for(const child of Object.keys(metadata.optionalDependencies??{}).sort())await dependency(child,directory,true)
  for(const child of Object.keys(metadata.peerDependencies??{}).sort())await dependency(child,directory,metadata.peerDependenciesMeta?.[child]?.optional===true)
 }
 await walk(path.resolve(input.nativeRoot),'native')
 for(const name of ['@earendil-works/pi-ai','@earendil-works/pi-agent-core','@earendil-works/pi-coding-agent'])await dependency(name,path.resolve(input.repository))
 const python=await fs.realpath(input.python);files['python/executable']=sha(await fs.readFile(python));links['python/requested']=python
 const orderedFiles=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))),orderedLinks=Object.fromEntries(Object.entries(links).sort(([a],[b])=>a.localeCompare(b))),orderedPackages=Object.fromEntries(Object.entries(packages).sort(([a],[b])=>a.localeCompare(b)))
 const value={format:'autofold.acceptance-dependencies.v1',files:orderedFiles,links:orderedLinks,packages:orderedPackages,optionalMissing:optionalMissing.sort(),limitations:['Python standard library and site-packages outside the native source tree are not pinned by this inventory.','System libraries and hardware environment are not pinned; this is a local behavioral qualification, not a hermetic build.']}
 return {...value,hash:sha(JSON.stringify(value))}
}
