import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {snapshotPinnedProto} from './native-references'
const repository=path.resolve(import.meta.dir,'../../../../../repo_store/github.com-evo-design-proto-language')
const available=await fs.access(path.join(repository,'proto-tools/.git')).then(()=>true,()=>false)
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
async function git(args:string[]){const child=Bun.spawn(['git',...args],{stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code)throw new Error(err);return out.trim()}
async function fixture(clone=false){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'native-api-ref-'));roots.push(workspace)
 const root=clone?path.join(workspace,'checkout'):repository
 if(clone){await git(['clone','--shared','--no-hardlinks',repository,root]);await git(['clone','--shared','--no-hardlinks',path.join(repository,'proto-tools'),path.join(root,'proto-tools')])}
 return {workspace,root,proto:{root,languageCommit:await git(['-C',root,'rev-parse','HEAD']),toolsCommit:await git(['-C',path.join(root,'proto-tools'),'rev-parse','HEAD'])}}
}
;(available?test:test.skip)('native API snapshot is exact committed bounded source, immutable and readable by ordinary scientist file paths',async()=>{
 const f=await fixture(),snapshot=await snapshotPinnedProto(f.workspace,'references',f.proto)
 const manifest=await Bun.file(path.join(f.workspace,snapshot.root,'manifest.json')).json()
 expect(manifest.languageCommit).toBe(f.proto.languageCommit);expect(manifest.toolsCommit).toBe(f.proto.toolsCommit)
 expect(manifest.files.length).toBeGreaterThan(100);expect(manifest.totalBytes).toBeLessThan(16*1024*1024)
 expect(manifest.files.some((file:any)=>file.path==='language/README.md')).toBe(true)
 expect(manifest.files.some((file:any)=>file.path.startsWith('tools/proto_tools/'))).toBe(true)
 for(const name of ['core/program.py','core/construct.py','core/segment.py','optimizer/rejection_sampling_optimizer.py']){
  const relative='language/proto_language/'+name
  expect(manifest.files.some((file:any)=>file.path===relative)).toBe(true)
  expect(snapshot.description).toContain(snapshot.root+'/'+relative)
 }
 const readme=path.join(f.workspace,snapshot.root,'language/README.md')
 expect((await fs.stat(readme)).mode&0o222).toBe(0)
 expect(await fs.readFile(readme,'utf8')).toBe(await fs.readFile(path.join(f.root,'README.md'),'utf8'))
 expect((await snapshotPinnedProto(f.workspace,'references',f.proto)).manifest.contentHash).toBe(manifest.contentHash)
 await fs.chmod(readme,0o600);await fs.writeFile(readme,'tampered')
 await expect(snapshotPinnedProto(f.workspace,'references',f.proto)).rejects.toThrow('Immutable Proto reference differs')
})
;(available?test:test.skip)('native API snapshot excludes untracked credentials and rejects pin drift, dirty tracked bytes, symlinks and huge tracked files',async()=>{
 const f=await fixture(true),privateFile=path.join(f.root,'proto_language','credentials.py')
 await fs.writeFile(privateFile,'PRIVATE_TEST_SECRET = "never-copy"')
 const result=await snapshotPinnedProto(f.workspace,'refs',f.proto)
 expect(result.manifest.files.some(file=>file.path.includes('credentials.py'))).toBe(false)
 await expect(fs.access(path.join(f.workspace,result.root,'language/proto_language/credentials.py'))).rejects.toThrow()
 await expect(snapshotPinnedProto(f.workspace,'wrong',{...f.proto,languageCommit:'a'.repeat(40)})).rejects.toThrow('HEAD mismatch')
 const readme=path.join(f.root,'README.md'),original=await fs.readFile(readme)
 await fs.writeFile(readme,'dirty');await expect(snapshotPinnedProto(f.workspace,'dirty',f.proto)).rejects.toThrow('committed bytes')
 await fs.rm(readme);await fs.symlink(privateFile,readme)
 await expect(snapshotPinnedProto(f.workspace,'link',f.proto)).rejects.toThrow('symbolic link')
 await fs.rm(readme);await fs.writeFile(readme,Buffer.alloc(512*1024+1))
 await expect(snapshotPinnedProto(f.workspace,'huge',f.proto)).rejects.toThrow('per-file bound')
 await fs.writeFile(readme,original)
})
