/** Isolated browser acceptance harness. Never attaches to or restarts application servers.
 * Uses real HTTP handlers/SQLite/worker receipts; inference is an explicit offline fixture.
 * Queued browser actions are not run automatically. Only temporary harness data is written.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {build} from 'vite'
import solid from 'vite-plugin-solid'
import {Application} from '../../backend/engine/src/application'
import {createHandler} from '../../backend/engine/src/server'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {createModels} from '@earendil-works/pi-ai'
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux'
const repository = path.resolve(import.meta.dir,'../..')
const root = await fs.mkdtemp(path.join(os.tmpdir(),'autofold-ui-acceptance-'))
const provider = fauxProvider({provider:'openrouter',models:[{id:'deepseek/deepseek-v4.1-flash',contextWindow:32000,maxTokens:4096}]})
const models=createModels();models.setProvider(provider.provider)
provider.setResponses([fauxAssistantMessage(fauxToolCall('read_context',{})),fauxAssistantMessage('This is offline browser acceptance. The synthetic worker receipt verifies software behavior; it establishes no biological evidence. Define a prospective intervention before authorizing further evaluation.')])
const app=new Application({workspace:path.join(root,'data'),jobs:{runtimeOptions:{models,streamFn:models.streamSimple.bind(models),apiKeyResolver:()=>undefined}}})
const experiment=await app.createMockExperiment('Verify the persistent Pi research workspace')
const authored=await app.science(experiment.id).authorTrial({program:ResearchPrograms.templates().mock,hypothesis:'Synthetic receipt for browser software acceptance',designAdapter:'mock'})
const trial=(authored as {trial:{id:string}}).trial
await app.execution.evaluateTrial({trialId:trial.id,requestId:'ui-fixture-receipt'})
await app.workspaceFiles.write(experiment.id,{path:'trial.py',content:'# Browser fixture draft\n',expectedHash:null})
await app.jobs.enqueueDiscovery(experiment.id,{idempotencyKey:'ui-fixture-chat',iterations:1,conversation:true,prompt:'Explain the current evidence'})
const settled=await app.jobs.runOnce();if(settled?.status!=='succeeded')throw new Error('Offline conversation failed')
const entry=path.join(root,'entry.tsx')
await fs.writeFile(entry,`import {render} from '${repository}/node_modules/solid-js/web/dist/web.js';import ResearchWorkspace from '${repository}/frontend/workspace/src/research/workspace.tsx';render(()=> <ResearchWorkspace defaultUrl={location.origin}/>,document.getElementById('root')!);`)
await build({configFile:false,root:path.join(repository,'frontend/workspace'),plugins:[solid()],resolve:{alias:[{find:/^solid-js\/web$/,replacement:repository+'/node_modules/solid-js/web/dist/web.js'},{find:/^solid-js\/store$/,replacement:repository+'/node_modules/solid-js/store/dist/store.js'},{find:/^solid-js$/,replacement:repository+'/node_modules/solid-js/dist/solid.js'}]},build:{outDir:path.join(root,'assets'),emptyOutDir:true,rollupOptions:{input:entry,output:{format:'iife',inlineDynamicImports:true,entryFileNames:'research.js',assetFileNames:'[name][extname]'}}}})
const css=await fs.readFile(path.join(repository,'frontend/workspace/src/research/workspace.css'),'utf8')
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autofold isolated browser acceptance</title><style>html,body,#root{height:100%;margin:0}${css}</style><div id="root"></div><script src="/assets/research.js"></script></html>`
const handler=createHandler(app)
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const route=new URL(request.url).pathname;if(route==='/')return new Response(html,{headers:{'content-type':'text/html'}});if(route==='/assets/research.js')return new Response(Bun.file(path.join(root,'assets/research.js')));return handler(request)}})
console.log(JSON.stringify({url:server.url.href,workspace:app.workspace,experimentId:experiment.id,evidence:'real HTTP API, SQLite and synthetic Python worker; offline inference; no GPU; browser jobs enqueue only'}))
const stop=()=>{server.stop(true);process.exit(0)}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
