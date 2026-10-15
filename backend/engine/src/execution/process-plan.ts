import fs from "node:fs/promises"
import path from "node:path"
import crypto from 'node:crypto'
export function processPlanHash(value: unknown):string {
  const stable=(item:any):any=>Array.isArray(item)?item.map(stable):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,stable(item[key])])):item
  return 'sha256:'+crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

/** Immutable atomic publish: competing prepares may reuse identical bytes only. */
export async function publishFrozenPlan(file:string,plan:unknown):Promise<void> {
  const temporary=file+'.'+crypto.randomUUID()+'.tmp'
  const handle=await fs.open(temporary,'wx',0o400)
  try {await handle.writeFile(JSON.stringify(plan));await handle.sync()} finally {await handle.close()}
  try {
    try{await fs.link(temporary,file)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const prior=await Bun.file(file).json();if(processPlanHash(prior)!==processPlanHash(plan))throw new Error('Original frozen process plan differs')}
    const directory=await fs.open(path.dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
  } finally {await fs.rm(temporary,{force:true})}
}
