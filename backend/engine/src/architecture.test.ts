import {expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'

test('scientific production modules depend on the host runtime rather than Pi libraries', async () => {
  const violations: string[] = []
  async function inspect(directory: string) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (entry.isDirectory() && entry.name === 'runtime') continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {await inspect(file); continue}
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const source = await fs.readFile(file, 'utf8')
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@earendil-works\/(?:pi-[^'"]*|chord[^'"]*))['"]/g)) {
        violations.push(path.relative(import.meta.dir, file) + ': ' + match[1])
      }
      if (/\bnew\s+PiRuntime\s*\(/.test(source)) violations.push(path.relative(import.meta.dir, file) + ': bypassed runtime factory')
    }
  }
  await inspect(import.meta.dir)
  await inspect(path.resolve(import.meta.dir, '../../science-core/src'))
  expect(violations).toEqual([])
})


test('scientific domain policy cannot own subprocess inspection or import execution/runtime',async()=>{
 const violations:string[]=[],root=path.resolve(import.meta.dir,'../../science-core/src')
 async function visit(directory:string){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name)
   if(entry.isDirectory()){await visit(file);continue}
   if(!file.endsWith('.ts')||file.endsWith('.test.ts'))continue
   const source=await fs.readFile(file,'utf8')
   if(/Bun\.spawn|node:child_process|['"](?:@autofold\/engine|[^'"]*engine\/src)/.test(source))violations.push(path.relative(root,file))
 }}
 await visit(root);expect(violations).toEqual([])
})

test('advisory scientist context cannot schedule or dispatch scientific work',async()=>{
 const context=await fs.readFile(path.join(import.meta.dir,'scientist/context.ts'),'utf8')
 expect(context).not.toMatch(/\.(?:claim|runOnce|createTrial|enqueue|evaluate|executeIntent)\s*\(/)
 const admission=await fs.readFile(path.join(import.meta.dir,'scientist/admission.ts'),'utf8')
 expect(admission).not.toMatch(/\.(?:claim|runOnce|createTrial|enqueue|evaluate|executeIntent)\s*\(/)
})
