import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {captureReferenceFiles, verifyFrozenReference} from './references'
import {ScientificWorkspace} from '../scientist/workspace'
import {emptyResearchState} from '@autofold/science-core/store'
const roots: string[] = []
afterEach(async()=>{for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true})})
async function fixture(){const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shadow-reference-'));roots.push(workspace)
 const root='.autofold/skills/operations/fixture/reference';await fs.mkdir(path.join(workspace,root),{recursive:true})
 await fs.writeFile(path.join(workspace,root,'api.py'),'first\nsecond\nthird\n')
 const files=await captureReferenceFiles(workspace,root),arm=root.replace('/reference','/arms/parent');await fs.mkdir(path.join(workspace,arm),{recursive:true})
 const scoped=new ScientificWorkspace({workspace,root:arm,initialize:async()=>{},execution:{artifacts:async()=>{throw new Error('No run artifact expansion permitted')}},scope:async()=>({state:emptyResearchState(),experiment:{id:'exp_frozen'} as any}),authorizeExternalRead:async relative=>files.some(file=>file.path===relative),verifyReference:async(relative,bytes)=>{if(relative.startsWith(root+'/'))verifyFrozenReference(files,relative,bytes)}})
 return {workspace,root,files,scoped}}
test('frozen shadow API reader pages exact bytes and excludes other arms',async()=>{
 const f=await fixture();const result=await f.scoped.read({path:f.root+'/api.py',offset:2,limit:1})
 expect(result.content).toContain('second');expect(result.totalLines).toBe(4)
 expect((await f.scoped.read({path:f.root+'/api.py'})).content).toContain('first')
 await fs.writeFile(path.join(f.workspace,'.autofold/skills/operations/fixture/parent.py'),'other arm')
 await expect(f.scoped.read({path:f.root+'/../parent.py'})).rejects.toThrow('frozen scientific workspace')
 await expect(f.scoped.read({path:'/etc/passwd'})).rejects.toThrow('frozen scientific workspace')
 await expect(f.scoped.read({path:f.root+'/missing.py'})).rejects.toThrow('frozen scientific workspace')
})
test('frozen shadow API reader rejects changed bytes and symbolic aliases',async()=>{
 const f=await fixture();await fs.writeFile(path.join(f.workspace,f.root,'api.py'),'FIRST\nsecond\nthird\n')
 await expect(f.scoped.read({path:f.root+'/api.py'})).rejects.toThrow('changed')
 await fs.rm(path.join(f.workspace,f.root,'api.py'));await fs.symlink('/etc/passwd',path.join(f.workspace,f.root,'api.py'))
 await expect(f.scoped.read({path:f.root+'/api.py'})).rejects.toThrow('symbolic')
 await expect(captureReferenceFiles(f.workspace,f.root)).rejects.toThrow('symbolic')
})
test('frozen API inventory and reader enforce size and paging bounds',async()=>{
 const f=await fixture()
 expect(()=>f.scoped.read({path:f.root+'/api.py',limit:1001})).toThrow('line range')
 expect(()=>f.scoped.read({path:f.root+'/api.py',offset:0})).toThrow('line range')
 await fs.writeFile(path.join(f.workspace,f.root,'large.py'),'x'.repeat(524289))
 await expect(captureReferenceFiles(f.workspace,f.root)).rejects.toThrow('bound')
})
