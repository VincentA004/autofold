import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Application} from './application'
import {createHandler} from './server'
import {runCLI} from './cli'
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'research-ui-api-')); roots.push(workspace)
  const app = new Application({workspace}), experiment = await app.createMockExperiment(), handler = createHandler(app)
  const call = (route: string, body?: unknown) => handler(new Request('http://127.0.0.1:4096' + route, {method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)}))
  return {workspace, app, experiment, call}
}
test('UI can enqueue, inspect and cancel promptly; host grants cannot be injected; CLI uses same durable queue', async () => {
  const f = await fixture(), route = `/research/experiments/${f.experiment.id}/autoresearch`
  const response = await f.call(route, {idempotencyKey: 'ui-discovery', iterations: 2})
  expect(response.status).toBe(202)
  const job = await response.json()
  expect(job.status).toBe('queued')
  expect((await f.app.store.read(f.app.projectId)).runs).toEqual({})
  expect((await (await f.call('/research/jobs')).json())[0].id).toBe(job.id)
  expect((await f.call(route, {idempotencyKey: 'injected', iterations: 1, authorization: {remote: true}})).status).toBe(400)
  expect((await f.call(route, {idempotencyKey: 'ui-discovery', iterations: 2})).status).toBe(202)
  expect((await f.app.jobs.list())).toHaveLength(1)
  expect((await (await f.call(`/research/jobs/${job.id}/cancel`, {})).json()).status).toBe('cancelled')
  const out: string[] = [], errors: string[] = []
  expect(await runCLI(['autoresearch', f.experiment.id, '--workspace', f.workspace, '--request-id', 'cli-discovery', '--iterations', '1'], text => out.push(text), text => errors.push(text))).toBe(0)
  expect(errors).toEqual([])
  expect(JSON.parse(out[0]!).status).toBe('queued')
  expect((await f.app.jobs.list())).toHaveLength(2)
})
test('programs are experiment-scoped, revision checked and locked against queued scientist jobs', async () => {
  const f = await fixture(), route = `/research/experiments/${f.experiment.id}/workspace/file`
  const initial = {path: 'programs/alternative.py', content: '# first native draft\n', expectedHash: null}
  const saved = await f.call(route, initial)
  expect(saved.status).toBe(200)
  const hash = (await saved.json()).hash
  const read = await (await f.call(route + '?path=programs%2Falternative.py')).json()
  expect(read.content).toBe(initial.content)
  expect(read.hash).toBe(hash)
  expect((await f.call(route, {...initial, content: '# stale overwrite\n'})).status).toBe(400)
  expect((await f.call(route, {...initial, path: '../../elsewhere.py'})).status).toBe(400)
  expect((await f.call(route, {...initial, path: 'CONTRACT.json'})).status).toBe(400)
  const job = await f.app.jobs.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'blocks-edit', iterations: 1})
  expect((await f.call(route, {...initial, expectedHash: hash, content: '# new draft\n'})).status).toBe(400)
  await f.app.jobs.cancel(job.id)
  expect((await f.call(route, {...initial, expectedHash: hash, content: '# new draft\n'})).status).toBe(200)
  const view = await (await f.call(`/research/experiments/${f.experiment.id}/workspace`)).json()
  expect(view.files.find((file: any) => file.path === initial.path).mutable).toBe(true)
  expect((await f.app.store.read(f.app.projectId)).runs).toEqual({})
  await fs.symlink('/private/tmp', path.join(f.workspace, '.autofold/autoresearch', f.experiment.id, 'programs/escape'))
  expect((await f.call(route + '?path=programs%2Fescape%2Fsecret')).status).toBe(400)
})
test('campaign, literature and skill UI actions stay bounded, scoped and approval-gated', async () => {
  const f = await fixture(), campaign = `/research/campaigns/${f.experiment.campaignId}`
  expect((await f.call(campaign + '/loop', {idempotencyKey:'ui-loop',maximumTrajectories:1,maxSteps:2})).status).toBe(202)
  const loop = (await f.app.jobs.list())[0]!
  expect(loop.payload.kind).toBe('campaign_loop')
  expect((await f.call(campaign + '/loop', {idempotencyKey:'override',authorization:{remote:true}})).status).toBe(400)
  await f.app.jobs.cancel(loop.id)
  const batched = await f.call(campaign + '/loop', {idempotencyKey:'ui-batched-loop', maxSteps:20,
    maximumTrajectories:14, maximumDiscoveryTrajectories:8, reservedReplayTrajectories:6, discoveryBatchSize:2})
  expect(batched.status).toBe(202)
  const batchedJob = await batched.json()
  expect(batchedJob.payload.maximumDiscoveryTrajectories).toBe(8)
  expect(batchedJob.payload.reservedReplayTrajectories).toBe(6)
  expect(batchedJob.payload.discoveryBatchSize).toBe(2)
  expect((await f.call(campaign + '/loop', {idempotencyKey:'ui-invalid-reserve',maximumTrajectories:2,reservedReplayTrajectories:6})).status).toBe(400)
  await f.app.jobs.cancel(batchedJob.id)
  expect((await f.call(campaign + '/literature', {idempotencyKey:'ui-literature',focusExperimentId:f.experiment.id,maxSources:2,maxClaims:2})).status).toBe(202)
  expect((await f.app.jobs.list()).find(job => job.payload.kind === 'knowledge_refresh')?.status).toBe('queued')
  expect((await f.call(campaign + '/literature', {idempotencyKey:'override-literature',parentJobId:loop.id})).status).toBe(400)
  expect((await f.call(campaign + '/skills/initialize', {})).status).toBe(200)
  const versions = await (await f.call(campaign + '/skills')).json()
  expect(versions.length).toBeGreaterThan(0)
  expect((await f.call(campaign + '/skills/replay', {idempotencyKey:'inject-fixture',experimentId:f.experiment.id,candidateVersionId:'skv_unverified',repetitions:3,allowMockPrograms:true})).status).toBe(400)
  expect((await f.call(campaign + '/approvals', {approvalId:'invented',proposalId:'apr_missing',contract:f.experiment.contract,activate:true})).status).toBe(400)
  expect((await f.app.store.read(f.app.projectId)).experiments[f.experiment.id]!.contractHash).toBe(f.experiment.contractHash)
  expect(Object.values((await f.app.store.read(f.app.projectId)).runs)).toHaveLength(0)
})

test('CLI scientist message uses durable no-compute conversation and native acceptance rejects fixture without effects', async () => {
  const f = await fixture(), out: string[] = [], errors: string[] = []
  const code = await runCLI(['scientist','message',f.experiment.id,'--workspace',f.workspace,'--request-id','cli-chat','--prompt','Explain the saved evidence'],text=>out.push(text),text=>errors.push(text))
  expect(code).toBe(0);expect(errors).toEqual([])
  const job = JSON.parse(out[0]!)
  expect(job.payload.conversation).toBe(true);expect(job.payload.allowCompute).toBe(false)
  const profile = path.join(f.workspace,'execution.json')
  await fs.writeFile(profile,JSON.stringify({authorization:{maximumGpuSeconds:0,maximumCandidates:3,maximumWallTimeMinutes:1}}))
  expect(await runCLI(['acceptance','native',f.experiment.id,'--workspace',f.workspace,'--execution-config',profile,'--request-id','reject-mock'],()=>{},text=>errors.push(text))).toBe(1)
  expect(errors.at(-1)).toContain('rejects mock')
  expect((await f.app.jobs.list())).toHaveLength(1)
  expect(Object.values((await f.app.store.read(f.app.projectId)).runs)).toHaveLength(0)
})


test('interrupted and recovery-required ownership keeps original captured programs immutable', async () => {
  const f=await fixture(), route=`/research/experiments/${f.experiment.id}/workspace/file`
  const initial={path:'programs/original.py',content:'# original frozen intent\n',expectedHash:null}
  const first=await f.call(route,initial), revision=(await first.json()).hash
  const job=await f.app.jobs.enqueueDiscovery(f.experiment.id,{idempotencyKey:'unfinished-edit-fence',iterations:1})
  for (const status of ['interrupted','recovery_required'] as const) {
    await f.app.store.mutate(f.app.projectId,state=>{state.jobs[job.id]!.status=status})
    expect((await f.call(route,{...initial,content:'# changed captured bytes\n',expectedHash:revision})).status).toBe(400)
    expect((await (await f.call(route+'?path=programs%2Foriginal.py')).json()).content).toBe(initial.content)
  }
  await f.app.jobs.cancel(job.id)
  expect((await f.call(route,{...initial,content:'# authorized new draft\n',expectedHash:revision})).status).toBe(200)
})
