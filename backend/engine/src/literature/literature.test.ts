import { ResearchJobService } from "@autofold/science-core/job-service"
import { afterEach, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { StorageResearchStore } from '@autofold/science-core/store'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchQuestions } from '@autofold/science-core/research-questions'
import { ConnectorRegistry, HttpClient, createLiteratureRegistry, type HttpTransport } from '../connectors'
import { DEFAULT_MODEL } from '../runtime'
import { LiteratureReviewController, LiteratureSubmissionSchema, literatureAssessmentSchema } from './index'
import {importHistoricalCloseoutFixture} from '../test-support/historical-closeout.fixture'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const digest = (c: string) => `sha256:${c.repeat(64)}`
const quoteA = 'Hotspot constraints improved selective recovery.'
const quoteB = 'Specificity depends on assay context and matched controls.'
const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({ role: 'assistant', content, stopReason,
 api: DEFAULT_MODEL.api, model: DEFAULT_MODEL.id, provider: DEFAULT_MODEL.provider, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
const call = (id: string, name: string, args: any): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
function scripted(...messages: AssistantMessage[]): StreamFn { let index = 0; return () => { const value = messages[index++]; if (!value) throw new Error('Unexpected model turn'); const stream = createAssistantMessageEventStream(); stream.push({ type: 'start', partial: value }); stream.push({ type: 'done', reason: value.stopReason as 'stop' | 'toolUse', message: value }); stream.end(value); return stream } }
const fetches = () => message([call('fetch-a', 'fetch_literature', { source: 'pubmed', id: '7' }), call('fetch-b', 'fetch_literature', { source: 'crossref', id: '10.1000/test' })], 'toolUse')
const review = (updates: any[] = []) => ({ generatedBy: 'model-cannot-pick-actor', sources: [
 { key: 'A', database: 'pubmed', sourceId: '7', title: 'Model title will be replaced', query: 'hotspot interface', excerpts: [quoteA] },
 { key: 'B', database: 'crossref', sourceId: '10.1000/test', title: 'Model title will be replaced', query: 'specificity control', excerpts: [quoteB] },
], claims: [
 { kind: 'design_rule', statement: 'Hotspot constraints may improve recovery.', stance: 'supports', confidence: 0.7, evidence: [{ sourceKey: 'A', excerpt: quoteA }] },
 { kind: 'limitation', statement: 'Specificity claims require assay context.', stance: 'supports', confidence: 0.7, evidence: [{ sourceKey: 'B', excerpt: quoteB }] },
], researchRequestUpdates: updates, unresolvedQuestions: ['Does this transfer to the frozen target?'] })
async function fixture() {
 const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-literature-')); roots.push(workspace)
 const projectId = 'literature_offline', store = new StorageResearchStore({ directory: path.join(workspace, 'research') }), research = new ResearchService.Service(store)
 const campaign = await research.createCampaign(projectId, { objective: 'Source-backed scientific interpretation' }); await research.activateCampaign(projectId, campaign.id)
 const experiment = await research.createExperiment(projectId, campaign.id, { contract: { version: 1, objective: 'Frozen target context', targetArtifactHash: digest('a'), modality: 'short_peptide', budget: { maximumCandidates: 3, gpuHours: 0, wallTimeMinutes: 1 }, evaluator: { id: 'locked', version: '1', sourceHash: digest('b'), direction: 'minimize', fixedSeeds: [1], submissionSize: 2 } } }); await research.activateExperiment(projectId, experiment.id)
 const connectors = new ConnectorRegistry(); let retrieved = 0
 for (const source of ['pubmed', 'crossref']) connectors.register({ id: source, name: source, domain: 'literature', description: 'Fixture source', search: async () => [{ id: source === 'pubmed' ? '7' : '10.1000/test', title: source }], fetch: async () => { retrieved++; return { title: source === 'pubmed' ? 'Primary hotspot study' : 'Primary specificity study', abstract: source === 'pubmed' ? quoteA : quoteB, url: source === 'pubmed' ? 'https://pubmed.ncbi.nlm.nih.gov/7/' : 'https://doi.org/10.1000/test' } } })
 const options = { workspace, projectId, research, store, sessionDirectory: path.join(workspace, 'pi'), connectors }
 const controller = (streamFn: StreamFn) => new LiteratureReviewController({ ...options, runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn } })
 return { ...options, campaign, experiment, controller, retrieved: () => retrieved }
}

test('two sourced proposed claims commit atomically with source ledger and reopen without more model or retrieval calls', async () => {
 const f = await fixture(), proposals = review()
 const controller = f.controller(scripted(fetches(), message([call('submit', 'submit_review', proposals)], 'toolUse')))
 const input = { campaignId: f.campaign.id, operationId: 'sourced-review', maxSources: 2, maxClaims: 2 }
 const result = await controller.run(input)
 expect(result.claims).toHaveLength(2); expect(result.claims.every(claim => claim.status === 'proposed')).toBe(true)
 expect(result.records.map(record => record.title)).toEqual(['Primary hotspot study', 'Primary specificity study'])
 const ledger = await Bun.file(path.join(f.workspace, result.proposalPath)).json()
 expect(ledger.hostSession).toMatchObject({costUsd:0,turns:0,toolCalls:0,originalRequestIds:[],binding:{operationId:expect.stringMatching(/^op_/),sessionId:result.childSessionId}})
 expect(ledger.baselineCostUsd).toBeUndefined();expect(ledger.deadlineMs).toBeUndefined()
 expect(Object.values(ledger.ledger)).toHaveLength(2)
 expect(ledger.ledger['pubmed:7']).toMatchObject({ format: 'autofold.fetched-literature.v1', text: expect.stringContaining(quoteA), contentHash: expect.stringMatching(/^sha256:/) })
 expect(result.cycle.generated.by).toMatch(/^autofold-pi-literature\/v1:/)
 expect(f.retrieved()).toBe(2)
 const reopened = f.controller(() => { throw new Error('Committed review must not call model') })
 expect((await reopened.run(input)).cycle.id).toBe(result.cycle.id)
 expect(f.retrieved()).toBe(2)
 expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
})

test('fabricated source and claim quotations never enter science; corrected same-operation retry uses frozen fetched text', async () => {
 const f = await fixture(), forged = review(); forged.sources[0].excerpts = ['Invented biological confirmation.']; forged.claims[0].evidence[0].excerpt = 'Invented biological confirmation.'
 const input = { campaignId: f.campaign.id, operationId: 'forged-quote', maxSources: 2, maxClaims: 2 }
 await expect(f.controller(scripted(fetches(), message([call('forged', 'submit_review', forged)], 'toolUse'), message([{ type: 'text', text: 'Could not submit.' }]), message([{type:'text',text:'The corrective turn still has no accepted proposal.'}]))).run(input)).rejects.toThrow('without an accepted verified proposal')
 expect(Object.values((await f.store.read(f.projectId)).claims)).toHaveLength(0)
 expect(Object.values((await f.store.read(f.projectId)).literature)).toHaveLength(0)
 const corrected = await f.controller(scripted(message([call('corrected', 'submit_review', review())], 'toolUse'))).run(input)
 expect(corrected.claims).toHaveLength(2); expect(f.retrieved()).toBe(2)
})

test('every presented request is answered or blocked at its exact revision; dropped and stale assessments are rejected', async () => {
 const f = await fixture()
 const request = async (question: string) => f.research.requestResearch(f.projectId, f.experiment.id, { generatedBy: question, evidenceRefs: [f.experiment.id], request: { action: 'create', question, competingExplanations: ['Target-specific mechanism', 'Generic assay artifact'], requiredEvidence: 'Matched primary source', applicabilityChecks: 'Same assay and target', decisionIfResolved: 'Choose next intervention' } })
 const answered = await request('Which hotspot rule applies?'), blocked = await request('Is specificity demonstrated?')
 const updates = [
 { requestId: answered.requestId, expectedRevision: null, status: 'answered', assessment: 'Primary study reports hotspot recovery.', remainingGap: 'Transfer to target remains unproven.', nextAction: 'Inspect target applicability.', sourceKeys: ['A'] },
 { requestId: blocked.requestId, expectedRevision: null, status: 'blocked', assessment: 'No target-matched specificity study was retrieved.', remainingGap: 'Need matched countertarget assays.', nextAction: 'Keep specificity unresolved.', sourceKeys: [] },
 ]
 const input = { campaignId: f.campaign.id, operationId: 'request-review', maxSources: 2, maxClaims: 2 }
 await expect(f.controller(scripted(fetches(), message([call('drop', 'submit_review', review(updates.slice(0, 1)))], 'toolUse'), message([{ type: 'text', text: 'Missing one request.' }]), message([{type:'text',text:'The corrective turn still has no accepted proposal.'}]))).run(input)).rejects.toThrow('without an accepted verified proposal')
 expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(0)
 const result = await f.controller(scripted(message([call('both', 'submit_review', review(updates))], 'toolUse'))).run(input)
 expect(result.researchRequestAssessments).toHaveLength(2)
 const state = await f.store.read(f.projectId), questions = ResearchQuestions.project([], Object.values(state.knowledgeCycles), Object.values(state.researchRequests))
 expect(questions.map(question => question.status)).toEqual(['answered', 'blocked'])
 const stale = { ...updates[1], status: 'open', reopenReason: 'New matching source appeared', expectedRevision: null }
 await expect(f.controller(scripted(fetches(), message([call('stale', 'submit_review', review([stale]))], 'toolUse'), message([{ type: 'text', text: 'Stale revision rejected.' }]))).run({ ...input, operationId: 'stale-reopen' })).rejects.toThrow('without an accepted verified proposal')
 const validReopen = { ...stale, expectedRevision: result.cycle.id }
 const reopened = await f.controller(scripted(fetches(), message([call('reopen', 'submit_review', review([validReopen]))], 'toolUse'))).run({ ...input, operationId: 'valid-reopen' })
 expect(reopened.researchRequestAssessments[0]).toMatchObject({ status: 'open', expectedRevision: result.cycle.id })
})

test('cross-campaign experiment references reject the entire proposed ingest', async () => {
 const f = await fixture(), other = await f.research.createCampaign(f.projectId, { objective: 'Unrelated campaign' }); await f.research.activateCampaign(f.projectId, other.id)
 const outside = await f.research.createExperiment(f.projectId, other.id, { contract: f.experiment.contract })
 const proposal = { ...review(), nextExperiment: { action: 'continue_experiment', experimentId: outside.id, hypothesis: 'Scope escape', rationale: 'Scope escape', successCriterion: 'Scope escape' } }
 await expect(f.controller(scripted(fetches(), message([call('cross-scope', 'submit_review', proposal)], 'toolUse'))).run({ campaignId: f.campaign.id, operationId: 'scope-guard' })).rejects.toThrow()
 const state = await f.store.read(f.projectId)
 expect(Object.values(state.claims)).toHaveLength(0); expect(Object.values(state.literature)).toHaveLength(0); expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
})

test('publication failure retries saved proposal and committed cycle without rerunning a model', async () => {
 const f = await fixture(), input = { campaignId: f.campaign.id, operationId: 'publication-retry' }
 const publication = spyOn(f.research, 'publishCampaignKnowledge').mockImplementationOnce(async () => { throw new Error('Derived output unavailable') })
 await expect(f.controller(scripted(fetches(), message([call('publish', 'submit_review', review())], 'toolUse'))).run(input)).rejects.toThrow('Derived output unavailable')
 const result = await f.controller(() => { throw new Error('Must not infer publication recovery with model') }).run(input)
 expect(result.claims).toHaveLength(2); expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
 publication.mockRestore()
})

test('cancellation propagates through connector retrieval and commits no source proposal or cycle', async () => {
 const f = await fixture(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
 const connectors = new ConnectorRegistry(); connectors.register({ id: 'pubmed', name: 'fixture', description: 'Cancellation fixture', domain: 'literature', search: async () => [], fetch: async (_id, options) => { started(); return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('Retrieval cancelled')), { once: true })) } })
 const controller = new LiteratureReviewController({ ...f, connectors, runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: scripted(message([call('cancel-fetch', 'fetch_literature', { source: 'pubmed', id: '7' })], 'toolUse')) } })
 const cancellation = new AbortController(), running = controller.run({ campaignId: f.campaign.id, operationId: 'cancel-fetch' }, undefined, { signal: cancellation.signal })
 await ready; cancellation.abort(new Error('Operator cancelled'))
 await expect(running).rejects.toThrow('Operator cancelled')
 expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(0)
})

test('portable HTTP adapters reject unregistered destinations, oversized bodies and uncooperative timeouts with fixture-only transport', async () => {
 const calls: string[] = []
 const http = new HttpClient({ retries: 0, transport: (async (url, init) => {
  calls.push(String(url)); expect(init?.redirect).toBe('error')
  const text = String(url)
  if (text.includes('esearch')) return Response.json({ esearchresult: { idlist: ['7'] } })
  if (text.includes('esummary')) return Response.json({ result: { '7': { uid: '7', title: 'Primary hotspot study' } } })
  if (text.includes('efetch')) return new Response(quoteA)
  return Response.json({ message: { DOI: '10.1000/test', title: ['Specificity'], abstract: quoteB } })
 }) as HttpTransport })
 const registry = createLiteratureRegistry(http)
 expect(registry.catalog()).toHaveLength(7)
 expect((await registry.get('pubmed')!.search('hotspot', { limit: 1 }))[0]).toMatchObject({ id: '7' })
 expect(await registry.get('pubmed')!.fetch('7')).toMatchObject({ abstract: quoteA })
 expect(await registry.get('crossref')!.fetch('10.1000/test')).toMatchObject({ abstract: quoteB })
 await expect(http.getText('http://127.0.0.1/private')).rejects.toThrow('outside registered')
 await expect(http.getText('file:///etc/passwd')).rejects.toThrow('outside registered')
 await expect(http.getText('https://evil.invalid/api/query')).rejects.toThrow('outside registered')
 expect(calls.every(url => /^https:\/\//.test(url))).toBe(true)
 const large = new HttpClient({ maximumResponseBytes: 4, transport: (async () => new Response('12345')) as HttpTransport })
 await expect(large.getText('https://export.arxiv.org/api/query')).rejects.toThrow('byte limit')
 const timeout = new HttpClient({ timeoutMs: 10, transport: (() => new Promise(() => {})) as HttpTransport })
 await expect(timeout.getText('https://export.arxiv.org/api/query')).rejects.toThrow('deadline')
})


test('literature reports cumulative persisted model spend on reopen and atomically fences cancellation before ingest', async()=>{
 const f=await fixture(),charge=(value:AssistantMessage,total:number)=>({...value,usage:{...value.usage,cost:{input:total,output:0,cacheRead:0,cacheWrite:0,total}}})
 const input={campaignId:f.campaign.id,operationId:'charged-review'}
 const result=await f.controller(scripted(charge(fetches(),0.04),charge(message([call('submit','submit_review',review())],'toolUse'),0.06))).run(input)
 expect(result.modelCostUsd).toBeCloseTo(0.1)
 expect((await f.controller(()=>{throw new Error('No extra model')}).run(input)).modelCostUsd).toBeCloseTo(0.1)
 const jobs=new ResearchJobService.Service(f.store),job=await jobs.enqueue(f.projectId,{idempotencyKey:'cancel-before-literature-commit',payload:{kind:'knowledge_refresh',campaignId:f.campaign.id,sessionId:'ses_cancel_commit',maxSources:2,maxClaims:2,runtime:'autofold-pi.v1'}})
 const claimed=await jobs.claim(f.projectId,30000)
 const original=f.research.ingestLiteratureReview.bind(f.research)
 const ingest=spyOn(f.research,'ingestLiteratureReview').mockImplementation(async(project,campaign,proposal,origin)=>{await jobs.cancel(f.projectId,job.id);return original(project,campaign,proposal,origin)})
 await expect(f.controller(scripted(fetches(),message([call('fenced-submit','submit_review',review())],'toolUse'))).run({campaignId:f.campaign.id,jobId:job.id},undefined,{origin:{jobId:job.id,leaseId:claimed!.leaseId!}})).rejects.toMatchObject({data:{code:'research_job_commit_fence'}})
 ingest.mockRestore()
 const state=await f.store.read(f.projectId)
 expect(Object.values(state.knowledgeCycles)).toHaveLength(1);expect(Object.values(state.claims)).toHaveLength(2)
})


test('free literature model output cannot reset the cumulative turn bound on retry',async()=>{
 const f=await fixture(),input={campaignId:f.campaign.id,operationId:'zero-cost-turn-limit'}
 await expect(new LiteratureReviewController({...f,runtimeOptions: { accountingProvenance: 'offline_fixture',limits:{maxTurns:1},streamFn:scripted(message([{type:'text',text:'No sourced review'}]))}}).run(input)).rejects.toThrow('without an accepted')
 let calls=0
 await expect(new LiteratureReviewController({...f,runtimeOptions: { accountingProvenance: 'offline_fixture',limits:{maxTurns:1},streamFn:()=>{calls++;throw new Error('No inference after cumulative turn limit')}}}).run(input)).rejects.toThrow('cumulative authoring budget')
 expect(calls).toBe(0)
})

test('literature queries old wiki records through scoped tools without retrieval or scientific write effects', async () => {
 const f = await fixture(), at = '2026-01-01T00:00:00.000Z'
 await f.store.mutate(f.projectId, state => {
  for (let index = 0; index < 35; index++) {
   const id = 'lit_prior_' + index
   state.literature[id] = {id, campaignId: f.campaign.id, database: 'pubmed', sourceId: String(index), title: index === 0 ? 'Old applicable hotspot record' : 'Later unrelated record ' + index,
    query: 'fixture', excerpts: ['Attributed historical text.'], contentHash: digest('a'), retrievedAt: new Date(Date.parse(at) + index * 1000).toISOString()}
  }
  state.literature.lit_other = {...state.literature.lit_prior_0!, id: 'lit_other', campaignId: 'cmp_other', title: 'Private foreign record'}
 })
 const scientificSnapshot=({operations,operationEvents,operationOutbox,...science}:Awaited<ReturnType<typeof f.store.read>>)=>science
 const before = JSON.stringify(scientificSnapshot(await f.store.read(f.projectId)))
 let turn = 0, observed = false
 const scriptedReader: StreamFn = (_model, context) => {
  const value = turn++ === 0 ? message([call('query-old', 'query_knowledge', {query: 'Old applicable hotspot record'}), call('read-old', 'read_knowledge', {id: 'lit_prior_0'}), call('reject-foreign', 'read_knowledge', {id: 'lit_other'})], 'toolUse') : message([{type: 'text', text: 'Stop after read-only inspection.'}])
  if (turn === 2) {
   const results = context.messages.filter(item => item.role === 'toolResult') as any[]
   const query = JSON.parse(results.find(item => item.toolCallId === 'query-old').content[0].text), source = JSON.parse(results.find(item => item.toolCallId === 'read-old').content[0].text)
   expect(query.items[0].id).toBe('lit_prior_0'); expect(source.sources.items[0].contentHash).toBe(digest('a'))
   expect(results.find(item => item.toolCallId === 'reject-foreign').isError).toBe(true); observed = true
  }
  const stream = createAssistantMessageEventStream(); stream.push({type: 'done', reason: value.stopReason as 'stop' | 'toolUse', message: value}); stream.end(value); return stream
 }
 await expect(f.controller(scriptedReader).run({campaignId: f.campaign.id, focusExperimentId: f.experiment.id, operationId: 'query-only'})).rejects.toThrow('without an accepted verified proposal')
 expect(observed).toBe(true); expect(f.retrieved()).toBe(0)
 expect(JSON.stringify(scientificSnapshot(await f.store.read(f.projectId)))).toBe(before)
 const directory = (await fs.readdir(path.join(f.workspace, '.autofold/literature')))[0]!
 const state = await Bun.file(path.join(f.workspace, '.autofold/literature', directory, 'review.json')).json()
 expect(state.context.applicableKnowledge.totalRecords).toBe(35)
 expect(state.context.applicableKnowledge.scientistInterpretations).toEqual([])
})

async function internalFixture() {
 const f = await fixture()
 const trial = await f.research.createTrial(f.projectId, f.experiment.id, {hypothesis:'Test locked computational panel',designAdapter:'mock',programPath:'trial.py',programHash:digest('c')})
 const run = await f.research.beginRun(f.projectId,trial.id,{bundlePath:'bundle.json',outputPath:'output'})
 await f.research.attachRunJob(f.projectId,run.id,'offline-compute-fixture')
 const completed = await f.research.completeRun(f.projectId,run.id,{contractHash:f.experiment.contractHash,evaluatorHash:f.experiment.contract.evaluator.sourceHash,valid:true,score:0.25,diagnostics:{agreement:0.7}},digest('d'))
 // Import the original receipt into a separate explicit v1 fixture database.
 // Fresh closeout above correctly produced no semantic questions or knowledge cycle.
 const historical=await importHistoricalCloseoutFixture(f,[run.id])
 const host={...f,...historical}
 host.controller=(streamFn:StreamFn)=>new LiteratureReviewController({...host,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn}})
 const state = await host.store.read(f.projectId), questions = ResearchQuestions.project(Object.values(state.searchObservations),Object.values(state.knowledgeCycles),[])
 expect(questions).toHaveLength(2)
 const proposal = {sources:[],claims:[],campaignSummary:'The locked computational panel scored 0.25; replication remains the next evidence need.',unresolvedQuestions:[],researchRequestUpdates:questions.map(q=>({requestId:q.requestId,expectedRevision:q.revision,status:'answered',assessment:'The saved panel adds one locked computational observation, not biological confirmation.',remainingGap:'Independent replication and physical specificity remain unmeasured.',nextAction:'Propose one bounded replicate under the unchanged contract.',sourceKeys:[],evidenceRefs:[completed.knowledge.id]}))}
 return Object.assign(host,{completed,questions,proposal})
}

test('historical internal-only closeout has canonical revisioned handoff, typed submission and one cumulative corrective continuation after prose',async()=>{
 const f=await internalFixture(), before=await f.store.read(f.projectId)
 expect((LiteratureSubmissionSchema as any).properties.researchRequestUpdates.items.properties.evidenceRefs).toBeDefined()
 expect((LiteratureSubmissionSchema as any).properties.researchRequestUpdates.items.properties.evidenceSnapshots).toBeUndefined()
 const input={campaignId:f.campaign.id,focusExperimentId:f.experiment.id,operationId:'internal-only',modelBudgetUsd:1}
 const result=await f.controller(scripted(message([call('read-outcome','read_knowledge',{id:f.completed.knowledge.id})],'toolUse'),message([{type:'text',text:'The panel scored 0.25. Replication is needed.'}]),message([call('commit-internal','submit_review',{...f.proposal,researchRequestUpdates:f.proposal.researchRequestUpdates.map(update=>({...update,evidenceSnapshots:[]}))})],'toolUse'))).run(input)
 expect(result.claims).toHaveLength(0);expect(result.records).toHaveLength(0);expect(f.retrieved()).toBe(0)
 expect(result.researchRequestAssessments).toHaveLength(2)
 expect(result.researchRequestAssessments[0].evidenceSnapshots.map(s=>s.id)).toEqual(expect.arrayContaining([f.completed.knowledge.id,f.completed.run.id,f.completed.evaluation.id,f.completed.trial.id]))
 const after=await f.store.read(f.projectId)
 expect(after.evaluations).toEqual(before.evaluations);expect(after.knowledge).toEqual(before.knowledge);expect(after.runs).toEqual(before.runs);expect(after.trials).toEqual(before.trials)
 expect(ResearchQuestions.project(Object.values(after.searchObservations),Object.values(after.knowledgeCycles),[]).every(q=>q.status==='answered'&&q.revision===result.cycle.id)).toBe(true)
 expect((await f.research.knowledgeRefreshStatus(f.projectId,f.campaign.id)).due).toBe(false)
 expect((await f.controller(()=>{throw new Error('Committed internal review must not reinfer')}).run(input)).cycle.id).toBe(result.cycle.id)
 const saved=await Bun.file(path.join(f.workspace,result.proposalPath)).json();expect(saved.correctionAttempted).toBe(true)
})

test('internal handoff rejects unread, forged and cross-scope evidence without committing a synthesis',async()=>{
 for(const kind of ['unread','forged','foreign','malformed']) {
  const f=await internalFixture(),proposal=structuredClone(f.proposal) as any
  if(kind==='forged') proposal.researchRequestUpdates[0].evidenceSnapshots=[{id:f.completed.knowledge.id,expectedHash:digest('a')}]
  if(kind==='foreign') proposal.researchRequestUpdates[0].evidenceRefs=['knw_foreign']
  if(kind==='malformed') proposal.researchRequestUpdates[0].assessment=''
  const messages=kind==='unread'?[]:[message([call('read','read_knowledge',{id:f.completed.knowledge.id})],'toolUse')]
  await expect(f.controller(scripted(...messages,message([call('reject','submit_review',proposal)],'toolUse'),message([{type:'text',text:'Cannot submit invalid evidence.'}]))).run({campaignId:f.campaign.id,operationId:'reject-'+kind})).rejects.toThrow('without an accepted verified proposal')
  expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
 }
})

test('internal handoff commit CAS rejects changed original measurement, outcome and canonical request source',async()=>{
 for(const kind of ['measurement','outcome','request']) {
  const f=await internalFixture(),original=f.research.ingestLiteratureReview.bind(f.research)
  const ingest=spyOn(f.research,'ingestLiteratureReview').mockImplementation(async(project,campaign,proposal,origin)=>{
   await f.store.mutate(f.projectId,state=>{
    if(kind==='measurement') state.evaluations[f.completed.evaluation.id]!.diagnostics={agreement:0.9}
    if(kind==='outcome') state.knowledge[f.completed.knowledge.id]!.description+=' Changed interpretation.'
    if(kind==='request') Object.values(state.knowledgeCycles)[0]!.outputs.unresolvedQuestions[0]+=' Changed question.'
   })
   return original(project,campaign,proposal,origin)
  })
  await expect(f.controller(scripted(message([call('read','read_knowledge',{id:f.completed.knowledge.id})],'toolUse'),message([call('submit','submit_review',f.proposal)],'toolUse'))).run({campaignId:f.campaign.id,operationId:'stale-'+kind})).rejects.toMatchObject({data:{code:'knowledge_reconciliation_stale'}})
  ingest.mockRestore();expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
 }
})

test('internal evidence cannot answer an external request even when request prose spoofs internal policy',async()=>{
 const f=await internalFixture(),external=await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'external',evidenceRefs:[f.completed.knowledge.id],request:{action:'create',question:'Which primary source establishes assay specificity?',requiredEvidence:'Matched external assay source',competingExplanations:['Specific binding','Assay artifact'],applicabilityChecks:'Matched target and assay',decisionIfResolved:'Choose control',evidencePolicy:'internal_result_reconciliation'}})
 const proposal={...f.proposal,researchRequestUpdates:[...f.proposal.researchRequestUpdates,{...f.proposal.researchRequestUpdates[0]!,requestId:external.requestId}]}
 let turn=0, rejected=false
 const stream: StreamFn=(model,context)=>{
  if(turn++===0) return scripted(message([call('read','read_knowledge',{id:f.completed.knowledge.id}),call('submit','submit_review',proposal)],'toolUse'))(model,context,{})
  const error=context.messages.find(m=>m.role==='toolResult' && m.toolCallId==='submit') as any
  expect(error.isError).toBe(true);expect(error.content[0].text).toContain('External research requests require fetched source evidence');rejected=true
  return scripted(message([],'error'))(model,context,{})
 }
 await expect(f.controller(stream).run({campaignId:f.campaign.id,operationId:'external-spoof'})).rejects.toThrow('without an accepted verified proposal')
 expect(rejected).toBe(true)
 expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
})


test('generic trusted closeout questions stay visible without serial interruptions after the first semantic reconciliation; explicit research requests remain mandatory',async()=>{
 const f=await internalFixture()
 const before=await f.research.knowledgeRefreshStatus(f.projectId,f.campaign.id)
 expect(before.due).toBe(true);expect(before.reasons).toContain('no_prior_knowledge_cycle')
 await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'semantic-scheduling',sources:[],claims:[],campaignSummary:'Bounded computational interpretation; future closeout questions are strategic feedback.',unresolvedQuestions:['Independent replication remains needed.']})
 const optional=await f.research.knowledgeRefreshStatus(f.projectId,f.campaign.id)
 expect(optional.due).toBe(false)
 const state=await f.store.read(f.projectId)
 expect(ResearchQuestions.project(Object.values(state.searchObservations),Object.values(state.knowledgeCycles),[]).filter(q=>q.status==='open')).toHaveLength(2)
 await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'scientist-explicit',evidenceRefs:[f.completed.knowledge.id],request:{action:'create',question:'Retrieve the primary target-matched specificity assay',requiredEvidence:'Primary assay source',competingExplanations:['Specific','Nonspecific'],applicabilityChecks:'Same target',decisionIfResolved:'Select matched control'}})
 const mandatory=await f.research.knowledgeRefreshStatus(f.projectId,f.campaign.id)
 expect(mandatory.due).toBe(true);expect(mandatory.reasons).toContain('open_research_questions')
})


test('historical core-first four-question failure is repaired with durable per-request host binding across restart', async () => {
 const f = await internalFixture()
 const trial = await f.research.createTrial(f.projectId, f.experiment.id, {hypothesis:'Second arm hotspot comparison',designAdapter:'mock',programPath:'second.py',programHash:digest('e')})
 const run = await f.research.beginRun(f.projectId,trial.id,{bundlePath:'second.json',outputPath:'second-output'})
 await f.research.attachRunJob(f.projectId,run.id,'offline-second-receipt')
 const completed = await f.research.completeRun(f.projectId,run.id,{contractHash:f.experiment.contractHash,evaluatorHash:f.experiment.contract.evaluator.sourceHash,valid:true,score:0.2639,diagnostics:{agreement:0.7}},digest('f'))
 const historical=await importHistoricalCloseoutFixture(f,[run.id]);f.store=historical.store;f.research=historical.research
 await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'core-first-explicit',evidenceRefs:[f.completed.knowledge.id,completed.knowledge.id],request:{action:'create',question:'Does hotspot conditioning systematically change locked-score outcomes or is the difference draw noise?',requiredEvidence:'Repeated worker-receipt measurements of both arms and verified hotspot mapping',competingExplanations:['Systematic conditioning effect','Single-draw noise'],applicabilityChecks:'Same frozen target, evaluator and seed',decisionIfResolved:'Select the next authorized intervention'}})
 const before = await f.store.read(f.projectId)
 const questions = ResearchQuestions.project(Object.values(before.searchObservations),Object.values(before.knowledgeCycles),Object.values(before.researchRequests))
 expect(questions).toHaveLength(4)
 const updates = questions.map(q => ({requestId:q.requestId,expectedRevision:q.revision,status:q.origin === 'trusted_closeout' ? 'answered' : 'blocked',assessment:'Saved computational observations support a bounded interpretation; they do not establish a systematic or biological effect.',remainingGap:'Replication and hotspot mapping remain unresolved.',nextAction:'Keep the explicit systematic-effect question blocked pending a future authorized receipt-backed comparison.',sourceKeys:[],evidenceRefs:q.origin === 'trusted_closeout' ? [q.evidenceRefs.includes(f.completed.knowledge.id) ? f.completed.knowledge.id : completed.knowledge.id] : []}))
 // Mirror the recorded first six calls: absent requestId, including a wrong revision and fabricated source key.
 const malformed = Array.from({length:6},(_,index)=>({sources:[],claims:[],campaignSummary:'Core-first failed proposal',researchRequestUpdates:(index<4?updates:updates.slice(0,1)).map(({requestId,...update})=>({...update,...(index===4?{expectedRevision:'kcy_wrong'}:{}),...(index===5?{sourceKeys:['run-bundle']}:{} )}))}))
 const schema = literatureAssessmentSchema(questions) as any
 expect(schema.properties.requestId.enum).toEqual(questions.map(q=>q.requestId))
 expect(schema.properties.expectedRevision).toBeUndefined(); expect(schema.properties.evidenceSnapshots).toBeUndefined()
 const checkpoints: string[] = []
 let observedErrors = false, turn = 0
 const failed: StreamFn = (_model,context) => {
  const sequence = [message([call('read-first','read_knowledge',{id:f.completed.knowledge.id}),call('read-second','read_knowledge',{id:completed.knowledge.id}),...malformed.map((proposal,index)=>call('bad-'+index,'submit_review',proposal)),call('seventh','submit_review',{sources:[],claims:[],campaignSummary:'Only one assessment',researchRequestUpdates:updates.slice(0,1)})],'toolUse'),message(updates.slice(0,2).map(({expectedRevision,...update},index)=>call('assess-'+index,'assess_request',update)),'toolUse'),message([],'error')]
  if(turn===1) {
   const results=context.messages.filter(m=>m.role==='toolResult') as any[]
   for(let index=0;index<6;index++) {const error=results.find(r=>r.toolCallId==='bad-'+index);expect(error.isError).toBe(true);expect(error.content[0].text).toContain('/researchRequestUpdates/0/requestId')}
   const error=results.find(r=>r.toolCallId==='seventh');expect(error.isError).toBe(true)
   for(const q of questions.slice(1)) expect(error.content[0].text).toContain(q.requestId)
   observedErrors=true
  }
  return scripted(sequence[turn++]!)(_model,context,{})
 }
 const input={campaignId:f.campaign.id,operationId:'core-first-four-restart'}
 await expect(f.controller(failed).run(input,{checkCancelled:()=>{},readCheckpoint:async()=>undefined,checkpoint:async phase=>{checkpoints.push(phase)}})).rejects.toThrow('without an accepted verified proposal')
 expect(observedErrors).toBe(true);expect(checkpoints.filter(p=>p.includes(':assessment:'))).toHaveLength(2)
 const directory=path.join(f.workspace,'.autofold/literature'), saved=await Bun.file(path.join(directory,(await fs.readdir(directory))[0]!,'review.json')).json()
 expect(Object.keys(saved.assessments)).toHaveLength(2)
 for(const q of questions.slice(0,2)) {expect(saved.assessments[q.requestId].expectedRevision).toBe(q.revision);expect(saved.assessments[q.requestId].expectedRequestHash).toMatch(/^sha256:/)}
 let resumeTurn=0
 const resumed: StreamFn = (model,context) => {
  if(resumeTurn++===0) {
   const content=(context.messages.findLast(m=>m.role==='user') as any).content
   const prompt=JSON.parse(typeof content==='string'?content:content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''))
   expect(prompt.remainingRequestIds).toEqual(questions.slice(2).map(q=>q.requestId))
   expect(Object.keys(prompt.savedAssessments)).toHaveLength(2)
   return scripted(message(updates.slice(2).map(({expectedRevision,...update},index)=>call('remaining-'+index,'assess_request',update)),'toolUse'))(model,context,{})
  }
  return scripted(message([call('final','submit_review',{sources:[],claims:[],campaignSummary:'All four requests assessed with host-bound evidence and explicit remaining gaps.'})],'toolUse'))(model,context,{})
 }
 const result=await f.controller(resumed).run(input)
 expect(result.researchRequestAssessments).toHaveLength(4);expect(f.retrieved()).toBe(0)
 expect(result.researchRequestAssessments.filter(u=>u.status==='blocked')).toHaveLength(1)
 for(const update of result.researchRequestAssessments.filter(u=>u.status==='answered')) expect(update.evidenceSnapshots.some(s=>s.id.startsWith('evl_'))).toBe(true)
 const after=await f.store.read(f.projectId)
 expect(after.evaluations).toEqual(before.evaluations);expect(after.runs).toEqual(before.runs);expect(after.trials).toEqual(before.trials);expect(after.knowledge).toEqual(before.knowledge)
 expect((await f.controller(()=>{throw new Error('No provider on completed retry')}).run(input)).cycle.id).toBe(result.cycle.id)
})

test('per-request assessments reject unread evidence, forged revisions and fabricated source schema with field paths', async () => {
 const f=await internalFixture(), update=f.proposal.researchRequestUpdates[0]!, {expectedRevision,...assessment}=update
 let seen=false, turn=0
 const stream: StreamFn=(model,context)=>{
  if(turn++===0) return scripted(message([call('unread','assess_request',assessment),call('spoof','assess_request',{...assessment,expectedRevision:'kcy_forged'}),call('snapshot','assess_request',{...assessment,evidenceSnapshots:[]}),call('source-schema','submit_review',{...f.proposal,sources:[{key:'run-bundle',database:'internal',sourceId:'run_fake',excerpts:['invented']} ]})],'toolUse'))(model,context,{})
  const results=context.messages.filter(m=>m.role==='toolResult') as any[]
  expect(results.find(r=>r.toolCallId==='unread').content[0].text).toContain('/assess_request/evidenceRefs')
  expect(results.find(r=>r.toolCallId==='spoof').content[0].text).toContain('/expectedRevision')
  expect(results.find(r=>r.toolCallId==='snapshot').content[0].text).toContain('/evidenceSnapshots')
  expect(results.find(r=>r.toolCallId==='source-schema').content[0].text).toContain('/sources/0')
  seen=true;return scripted(message([],'error'))(model,context,{})
 }
 await expect(f.controller(stream).run({campaignId:f.campaign.id,operationId:'per-request-rejects'})).rejects.toThrow('without an accepted verified proposal')
 expect(seen).toBe(true);expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(1)
})


test('typed empirical tests remain visible without becoming mandatory literature assessments', async () => {
 const f=await fixture()
 const common={action:'create' as const,competingExplanations:['Systematic effect','Noise'],requiredEvidence:'New receipt measurements',applicabilityChecks:'Frozen target',decisionIfResolved:'Select experiment'}
 const empirical=await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'empirical',evidenceRefs:[f.experiment.id],request:{...common,question:'Measure replicated empirical outcomes',purpose:'empirical_test'}})
 const lookup=await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'lookup',evidenceRefs:[f.experiment.id],request:{...common,question:'Retrieve the matched primary source',purpose:'knowledge_lookup'}})
 let seen=false
 const stream: StreamFn=(model,context)=>{
  const content=(context.messages.findLast(m=>m.role==='user') as any).content
  const prompt=JSON.parse(typeof content==='string'?content:content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''))
  expect(prompt.context.presentedRequests.map((q:any)=>q.requestId)).toEqual([lookup.requestId])
  expect(prompt.context.empiricalRequests.map((q:any)=>q.requestId)).toEqual([empirical.requestId])
  const schema=literatureAssessmentSchema(prompt.context.presentedRequests) as any
  expect(schema.properties.requestId.enum).toEqual([lookup.requestId]);seen=true
  return scripted(message([call('lookup','assess_request',{requestId:lookup.requestId,status:'blocked',assessment:'No matched primary source has been retrieved.',remainingGap:'Need an applicable primary source.',nextAction:'Keep the lookup open for later research.',sourceKeys:[],evidenceRefs:[]}),call('submit','submit_review',{sources:[],claims:[],campaignSummary:'The knowledge lookup is blocked; the empirical question remains in the experiment queue.'})],'toolUse'))(model,context,{})
 }
 const result=await f.controller(stream).run({campaignId:f.campaign.id,operationId:'typed-queues'})
 expect(seen).toBe(true);expect(result.researchRequestAssessments).toHaveLength(1)
 const state=await f.store.read(f.projectId), questions=ResearchQuestions.project([],Object.values(state.knowledgeCycles),Object.values(state.researchRequests))
 expect(questions.find(q=>q.requestId===empirical.requestId)?.status).toBe('open')
})


test('per-request host binding uses reopened non-null revisions and preserves outcome/request CAS', async () => {
 for(const kind of ['valid','measurement','request']) {
  const f=await internalFixture()
  const prior=await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{...f.proposal,generatedBy:'previous-assessment',researchRequestUpdates:f.proposal.researchRequestUpdates.map(update=>({...update,status:'blocked' as const,evidenceRefs:[]}))})
  const question=f.questions[0]!
  await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'reopen',evidenceRefs:[f.completed.knowledge.id],request:{...question.request,action:'reopen',existingRequestId:question.requestId,expectedRevision:prior.cycle.id,reopenReason:'A new bounded computational interpretation is available.'}})
  const {expectedRevision,...assessment}=f.proposal.researchRequestUpdates[0]!
  const original=f.research.ingestLiteratureReview.bind(f.research)
  const ingest=spyOn(f.research,'ingestLiteratureReview').mockImplementation(async(project,campaign,proposal,origin)=>{
   expect(proposal.researchRequestUpdates?.[0]?.expectedRevision).toBe(prior.cycle.id)
   expect(proposal.researchRequestUpdates?.[0]?.expectedRequestHash).toMatch(/^sha256:/)
   if(kind!=='valid') await f.store.mutate(f.projectId,state=>{
    if(kind==='measurement') state.evaluations[f.completed.evaluation.id]!.diagnostics={agreement:0.99}
    else Object.values(state.researchRequests)[0]!.request.reopenReason='Different reopened request source.'
   })
   return original(project,campaign,proposal,origin)
  })
  const running=f.controller(scripted(message([call('read','read_knowledge',{id:f.completed.knowledge.id}),call('assess','assess_request',assessment),call('submit','submit_review',{sources:[],claims:[],campaignSummary:'Reopened interpretation uses the frozen prior revision and original receipt lineage.'})],'toolUse'))).run({campaignId:f.campaign.id,operationId:'reopened-'+kind})
  if(kind==='valid') expect((await running).researchRequestAssessments[0]?.expectedRevision).toBe(prior.cycle.id)
  else await expect(running).rejects.toMatchObject({data:{code:'knowledge_reconciliation_stale'}})
  ingest.mockRestore()
 }
})

test('per-request source assessments require the fetched ledger at final submission', async () => {
 const f=await fixture()
 const request=await f.research.requestResearch(f.projectId,f.experiment.id,{generatedBy:'lookup',evidenceRefs:[f.experiment.id],request:{action:'create',purpose:'knowledge_lookup',question:'Which hotspot rule applies?',competingExplanations:['Specific mechanism','Assay artifact'],requiredEvidence:'Matched primary source',applicabilityChecks:'Same assay and target',decisionIfResolved:'Choose intervention'}})
 const assessment={requestId:request.requestId,status:'answered',assessment:'Primary source reports hotspot recovery.',remainingGap:'Transfer to the target remains unproven.',nextAction:'Inspect applicability.',sourceKeys:['A'],evidenceRefs:[]}
 let turn=0,rejected=false
 const stream: StreamFn=(model,context)=>{
  if(turn++===0) return scripted(message([call('assess','assess_request',assessment),call('unfetched','submit_review',review())],'toolUse'))(model,context,{})
  const saved=context.messages.find(m=>m.role==='toolResult'&&m.toolCallId==='assess') as any
  expect(JSON.parse(saved.content[0].text)).toMatchObject({saved:true,finalReviewAccepted:false,sourceValidation:'pending_final_fetched_quote_validation'})
  const error=context.messages.find(m=>m.role==='toolResult'&&m.toolCallId==='unfetched') as any
  expect(error.isError).toBe(true);expect(error.content[0].text).toContain('trusted frozen ledger');rejected=true
  return scripted(message([],'error'))(model,context,{})
 }
 const input={campaignId:f.campaign.id,operationId:'sourced-assessment'}
 await expect(f.controller(stream).run(input)).rejects.toThrow('without an accepted verified proposal')
 expect(rejected).toBe(true);expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(0)
 const result=await f.controller(scripted(fetches(),message([call('submit','submit_review',review())],'toolUse'))).run(input)
 expect(result.researchRequestAssessments[0]).toMatchObject({requestId:request.requestId,status:'answered',expectedRevision:null})
 expect(result.researchRequestAssessments[0]?.literatureIds).toHaveLength(1)
})
