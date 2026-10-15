import {describe, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Application} from './application'
import {createHandler} from './server'
import {runCLI} from './cli'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchDomain} from '@autofold/science-core/domain'
import {CampaignKnowledgeReader} from './knowledge'

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-knowledge-review-'))
  const app = new Application({workspace})
  const campaign = await app.research.createCampaign(app.projectId, {objective: 'Scoped evidence reconciliation'})
  await app.research.activateCampaign(app.projectId, campaign.id)
  const other = await app.research.createCampaign(app.projectId, {objective: 'Different campaign'})
  const source = await app.research.ingestLiterature(app.projectId, campaign.id, {database: 'fixture', sourceId: 'source-one', title: 'Frozen source', query: 'review', excerpts: ['Predictor agreement does not establish binding.']})
  const claim = await app.research.createClaim(app.projectId, campaign.id, {kind: 'limitation', statement: 'Predicted agreement needs experimental validation.', stance: 'context', confidence: 0.8, evidence: [{literatureId: source.id, excerpt: source.excerpts[0]}], generatedBy: 'pi-literature-fixture'})
  const now = new Date().toISOString()
  const alignment = ResearchDomain.KnowledgeAlignment.parse({id: 'aln_review_fixture', campaignId: campaign.id, claimId: claim.id, knowledgeId: 'knw_fixture', relation: 'context', rationale: 'Predictions require external verification', status: 'proposed', generated: {by: 'pi-literature-fixture', at: now}, createdAt: now})
  await app.store.mutate(app.projectId, state => {
   state.alignments[alignment.id] = alignment
   const digest = 'sha256:' + 'a'.repeat(64)
   state.knowledge.knw_fixture = {id: 'knw_fixture', campaignId: campaign.id, experimentId: 'exp_fixture', trialId: 'trl_fixture', type: 'Research Failure', title: 'Offline failure observation', description: 'No successful measured outcome.', tags: ['fixture'], sources: [{id: 'fixture', resource: 'offline-fixture'}], generated: {by: 'native-fixture', at: now}, status: 'draft', score: null, decision: 'failed', error: 'Offline fixture failure', diagnostics: {}, provenance: {contractHash: digest, evaluatorHash: digest, programHash: digest}, createdAt: now}
  })
  const handler = createHandler(app)
  const request = (route: string, body?: unknown) => handler(new Request('http://127.0.0.1:4096'+route, {method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)}))
  return {workspace, app, campaign, other, source, claim, alignment, request}
}

describe('operator OKF reconciliation', () => {
 test('query/read expose canonical snapshot, provenance and scope; review survives SQLite reopen and republishes wiki', async () => {
  const f = await fixture()
  try {
   const root = `/research/campaigns/${f.campaign.id}/knowledge`
   const query = await (await f.request(root+'/query', {query: 'experimental validation', kinds: ['claim']})).json()
   expect(query.items.map((row: any) => row.id)).toContain(f.claim.id)
   const read = await (await f.request(root+'/records/'+f.claim.id)).json()
   expect(read.recordSnapshotHash).toBe(ResearchService.knowledgeRecordHash(f.claim))
   expect(read.sources.items[0].contentHash).toBe(f.source.contentHash)
   const response = await f.request(root+'/'+f.claim.id+'/review', {status: 'contested', reviewedBy: 'human:operator', expectedHash: read.recordSnapshotHash})
   expect(response.status).toBe(200)
   const result = await response.json()
   expect(result.record).toMatchObject({status: 'contested', reviewed: {by: 'human:operator'}, generated: f.claim.generated, confidence: f.claim.confidence, evidence: f.claim.evidence})
   expect(result.authority).toBe('reviewed_interpretation_not_verified_measurement')
   const reopened = new Application({workspace: f.workspace})
   expect((await reopened.store.read(reopened.projectId)).claims[f.claim.id]?.status).toBe('contested')
   const markdown = await fs.readFile(path.join(f.workspace, '.autofold/campaigns', f.campaign.id, 'knowledge/claims', f.claim.id+'.md'), 'utf8')
   expect(markdown).toContain('contested')
   expect(markdown).toContain('human:operator')
   const knowledge = await (await f.request(root)).json()
   expect(knowledge.alignments.map((row: any) => row.id)).toContain(f.alignment.id)
   expect(knowledge.recordSnapshotHashes[f.claim.id]).toBe(result.recordSnapshotHash)
   const foreign = await f.request(`/research/campaigns/${f.other.id}/knowledge/records/${f.claim.id}`)
   expect(foreign.status).toBe(400)
   const wrongScope = await f.request(`/research/campaigns/${f.other.id}/knowledge/${f.claim.id}/review`, {status: 'reviewed', reviewedBy: 'human', expectedHash: result.recordSnapshotHash})
   expect(wrongScope.status).toBe(400)
   expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]?.status).toBe('contested')
  } finally {await fs.rm(f.workspace, {recursive: true, force: true})}
 })
 test('atomic review CAS admits one competing change and rejects missing/stale snapshots and model-shaped extras', async () => {
  const f = await fixture()
  try {
   const route = `/research/campaigns/${f.campaign.id}/knowledge/${f.alignment.id}/review`
   const expectedHash = ResearchService.knowledgeRecordHash(f.alignment)
   const responses = await Promise.all(['reviewed', 'deprecated'].map(status => f.request(route, {status, reviewedBy: 'human:operator', expectedHash})))
   expect(responses.map(row => row.status).sort()).toEqual([200, 400])
   expect((await f.request(route, {status: 'reviewed', reviewedBy: 'human:operator'})).status).toBe(400)
   expect((await f.request(route, {status: 'reviewed', reviewedBy: 'human:operator', expectedHash, model: 'arbitrary'})).status).toBe(400)
   expect((await f.request(route, {status: 'proposed', reviewedBy: 'human:operator', expectedHash})).status).toBe(400)
   expect((await f.app.store.read(f.app.projectId)).alignments[f.alignment.id]?.reviewed?.by).toBe('human:operator')
  } finally {await fs.rm(f.workspace, {recursive: true, force: true})}
 })
 test('HTTP and CLI enqueue only explicit campaign review targets and leave science unchanged until claimed', async () => {
  const f = await fixture()
  try {
   const root = `/research/campaigns/${f.campaign.id}/knowledge/reconcile`
   expect((await f.request(root, {idempotencyKey: 'empty-targets'})).status).toBe(400)
   expect((await f.request(`/research/campaigns/${f.other.id}/knowledge/reconcile`, {idempotencyKey: 'foreign-target', claimIds: [f.claim.id]})).status).toBe(400)
   expect((await f.request(root, {idempotencyKey: 'scope-injection', claimIds: [f.claim.id], reviewedBy: 'model-authored-reviewer'})).status).toBe(400)
   const payload = {idempotencyKey: 'http-reconcile', claimIds: [f.claim.id], modelBudgetUsd: 0.25}
   const response = await f.request(root, payload)
   expect(response.status).toBe(202)
   const job = await response.json()
   expect(job).toMatchObject({status: 'queued', payload: {kind: 'knowledge_review', campaignId: f.campaign.id, claimIds: [f.claim.id], modelBudgetUsd: 0.25}})
   const repeated = await (await f.request(root, payload)).json()
   expect(repeated.id).toBe(job.id)
   await f.app.jobs.cancel(job.id)
   const output: string[] = []
   expect(await runCLI(['knowledge', 'reconcile', f.campaign.id, '--claim', f.claim.id, '--request-id', 'cli-reconcile', '--max-cost', '0.25', '--workspace', f.workspace], text => output.push(text), () => {})).toBe(0)
   const cliJob = JSON.parse(output.at(-1)!)
   expect(cliJob.payload.kind).toBe('knowledge_review')
   expect(cliJob.payload.claimIds).toEqual([f.claim.id])
   await f.app.jobs.cancel(cliJob.id)
   const state = await f.app.store.read(f.app.projectId)
   expect(state.claims[f.claim.id]).toEqual(f.claim)
   expect(Object.keys(state.runs)).toHaveLength(0)
   expect(Object.keys(state.knowledgeCycles)).toHaveLength(0)
  } finally {await fs.rm(f.workspace, {recursive: true, force: true})}
 })
 test('CLI reads and reviews exact scoped snapshot without model or compute work', async () => {
  const f = await fixture()
  try {
   const outputs: string[] = [], errors: string[] = [], flags = ['--workspace', f.workspace]
   const run = (args: string[]) => runCLI([...args, ...flags], text => outputs.push(text), text => errors.push(text))
   expect(await run(['knowledge', 'read', f.campaign.id, '--record', f.claim.id])).toBe(0)
   const read = JSON.parse(outputs.at(-1)!)
   expect(await run(['knowledge', 'review', f.campaign.id, '--record', f.claim.id, '--status', 'reviewed', '--reviewed-by', 'human:cli', '--expected-hash', read.recordSnapshotHash])).toBe(0)
   expect(await run(['knowledge', 'review', f.campaign.id, '--record', f.claim.id, '--status', 'deprecated', '--reviewed-by', 'human:cli', '--expected-hash', read.recordSnapshotHash])).toBe(1)
   expect(errors.at(-1)).toContain('changed since')
   const state = await f.app.store.read(f.app.projectId)
   expect(Object.keys(state.jobs)).toHaveLength(0)
   expect(Object.keys(state.runs)).toHaveLength(0)
   expect(Object.keys(state.evaluations)).toHaveLength(0)
   const projection = await new CampaignKnowledgeReader({store: f.app.store, projectId: f.app.projectId, campaignId: f.campaign.id}).read({id: f.claim.id})
   expect(projection.recordSnapshotHash).toBe(ResearchService.knowledgeRecordHash(state.claims[f.claim.id]))
   expect(projection.status).toBe('reviewed')
  } finally {await fs.rm(f.workspace, {recursive: true, force: true})}
 })
})
