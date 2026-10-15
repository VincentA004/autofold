import {createHash} from 'node:crypto'
import {CampaignKnowledgeReader,ProjectKnowledgeGraph} from './knowledge'
import {KnowledgeReviewBody, reviewKnowledge} from './knowledge-review'
import {ResearchService} from '@autofold/science-core/service'
import { ResearchDomain } from '@autofold/science-core/domain'
import { parseArgs } from 'node:util'
import { Application } from './application'
import { loadExecutionConfig } from './config'
import { DEFAULT_MODEL_SELECTION, openSessionReader } from './runtime'
import { ResearchArtifacts } from '@autofold/science-core/artifacts'
import path from 'node:path'
import z from 'zod'

export function transcriptPage(saved:{id:string;messages:unknown[]},offset=0,limit=100,anchor?:string){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid transcript cursor')
  const hash=(message:unknown)=>'sha256:'+createHash('sha256').update(JSON.stringify(message)).digest('hex')
  const reset=offset>saved.messages.length||offset>0&&anchor!==hash(saved.messages[offset-1])
  const start=reset?0:offset,end=Math.min(saved.messages.length,start+limit)
  const {sdk,messages,pendingTools,modelRequests,contextCompactions,...metadata}=saved as {messages:unknown[];[key:string]:unknown}
  return {session:metadata,messages:messages.slice(start,end),offset:start,nextOffset:end,anchor:end?hash(messages[end-1]):undefined,totalMessages:messages.length,hasMore:end<messages.length,reset}
}
export function historyPage(history:Record<string,any>,offset=0,limit=50){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid history page')
  const counts:Record<string,number>={},pages:{trials:unknown[];runs:unknown[];evaluations:unknown[];knowledge:unknown[]}={trials:[],runs:[],evaluations:[],knowledge:[]}
  for(const key of ['trials','runs','evaluations','knowledge'] as const){const rows=history[key] as unknown[];counts[key]=rows.length;pages[key]=rows.slice(Math.max(0,rows.length-offset-limit),Math.max(0,rows.length-offset))}
  return {...pages,experiment:history.experiment,counts,offset,limit,nextOffset:Object.values(counts).some(total=>offset+limit<total)?offset+limit:null,coverage:'This page is a bounded slice of original records; omitted records remain retrievable and are not evidence of absence.'}
}

const RefinementBody = z.object({idempotencyKey: z.string().trim().min(1).max(500), trajectoryRefs: z.array(z.string().regex(/^(exp|trl|evl|run|knw|clm|job)_[A-Za-z0-9_-]+$/)).min(1).max(30), model: z.string().trim().min(1).optional(), modelBudgetUsd: z.number().positive().max(100).optional()}).strict()
const ReplayBody = z.object({idempotencyKey: z.string().trim().min(1).max(500), experimentId: z.string().regex(/^exp_[A-Za-z0-9_-]+$/), candidateVersionId: z.string().regex(/^skv_[A-Za-z0-9_-]+$/), repetitions: z.number().int().min(3).max(5).default(3), model: z.string().trim().min(1).optional(), modelBudgetUsd: z.number().positive().max(100).optional()}).strict()
const SkillVersionBody = z.object({versionId: z.string().regex(/^skv_[A-Za-z0-9_-]+$/)}).strict()
const CampaignJobBody = z.object({idempotencyKey: z.string().trim().min(1).max(500), maxSteps: z.number().int().min(1).max(20).default(3), maximumTrajectories: z.number().int().min(1).max(100).default(3), discoveryBatchSize: z.number().int().min(1).max(100).optional(), maximumDiscoveryTrajectories: z.number().int().min(0).max(100).optional(), reservedReplayTrajectories: z.number().int().min(0).max(100).optional(), maximumKnowledgeRefreshes: z.number().int().min(0).max(10).optional(), experimentId: z.string().regex(/^exp_[A-Za-z0-9_-]+$/).optional(), modelBudgetUsd: z.number().positive().max(1000).optional(), perChildModelBudgetUsd: z.number().positive().max(100).optional(), maximumDurationMs: z.number().int().positive().max(2147483647).optional(), model: z.string().trim().min(1).optional()}).strict()
const LiteratureJobBody = z.object({idempotencyKey: z.string().trim().min(1).max(500), focusExperimentId: z.string().regex(/^exp_[A-Za-z0-9_-]+$/).optional(), question: z.string().trim().min(1).max(2000).optional(), maxSources: z.number().int().min(1).max(50).default(6), maxClaims: z.number().int().min(1).max(50).default(6), modelBudgetUsd: z.number().positive().max(100).optional(), model: z.string().trim().min(1).optional()}).strict()
const KnowledgeReconcileBody = z.object({idempotencyKey: z.string().trim().min(1).max(500), claimIds: z.array(z.string().regex(/^clm_[A-Za-z0-9_-]+$/)).max(20).default([]), alignmentIds: z.array(z.string().regex(/^aln_[A-Za-z0-9_-]+$/)).max(20).default([]), question: z.string().trim().min(1).max(2000).optional(), model: z.string().trim().min(1).optional(), modelBudgetUsd: z.number().positive().max(100).optional()}).strict().refine(input => input.claimIds.length + input.alignmentIds.length > 0, 'At least one existing claim or alignment is required')
const ContractApprovalBody = z.object({approvalId: z.string().trim().min(1).max(200), proposalId: z.string().regex(/^apr_[A-Za-z0-9_-]+$/), contract: ResearchDomain.ExperimentContract, activate: z.boolean().optional()}).strict()
const WorkspaceWrite = z.object({path: z.string().min(1).max(500), content: z.string().min(1).max(262144), expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()}).strict()
const DiscoveryJobBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(500), iterations: z.number().int().min(1).max(100).default(2),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]+$/).optional(), model: z.string().trim().min(1).optional(),
  modelBudgetUsd: z.number().finite().positive().max(1000).optional(),
  conversation: z.boolean().optional(), prompt: z.string().trim().min(1).max(16000).optional(), allowCompute: z.boolean().optional(),
}).strict()
const json = (value: unknown, status = 200) => Response.json(value, { status })

/** One explicitly configured project; request bodies cannot change workspace or storage. */
export function createHandler(app: Application, options: { allowedOrigins?: string[]; token?: string } = {}) {
  return async (request: Request) => {
    const url = new URL(request.url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return json({ error: 'Host is not allowed' }, 403)
    const origin = request.headers.get('origin')
    const allowed = !origin || origin === url.origin || options.allowedOrigins?.includes(origin)
    if (!allowed) return json({ error: 'Origin is not allowed' }, 403)
    const respond = (response: Response) => {
      if (origin) { response.headers.set('Access-Control-Allow-Origin', origin); response.headers.set('Vary', 'Origin') }
      return response
    }
    if (request.method === 'OPTIONS') return respond(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization' } }))
    if (options.token && request.headers.get('authorization') !== `Bearer ${options.token}`) return respond(json({ error: 'Unauthorized' }, 401))
    if (request.method === 'POST' && !request.headers.get('content-type')?.startsWith('application/json')) return respond(json({ error: 'Expected application/json' }, 415))
    try {
      const route = url.pathname
      const body = () => request.json() as Promise<any>
      if (request.method === 'GET' && route === '/health') return respond(json({ ok: app.jobs.workerState.status !== 'degraded', runtime: 'pi', version: '1.0.1', worker: app.jobs.workerState }, app.jobs.workerState.status === 'degraded' ? 503 : 200))
      if (request.method === 'GET' && route === '/research/status') return respond(json(await app.status()))
      if (request.method === 'GET' && route === '/research/evaluators') return respond(json(await app.execution.evaluators()))
      if (request.method === 'GET' && route === '/research/model-registry') return respond(json(await app.execution.modelRegistry()))
      if (route === '/research/operations' && request.method === 'GET') return respond(json(await app.operationDiagnostics()))
      const operation = route.match(/^\/research\/operations\/(op_[A-Za-z0-9_-]+)\/rebuild-projection$/)
      if (operation && request.method === 'POST') return respond(json(await app.rebuildOperationProjection(operation[1]!)))
      if (route === '/research/jobs' && request.method === 'GET') return respond(json(await app.jobs.list()))
      const job = route.match(/^\/research\/jobs\/(job_[A-Za-z0-9_-]+)(?:\/(cancel|retry|reconcile|recovery-plan|settle))?$/)
      if (job) {
        if (request.method === 'GET' && !job[2]) return respond(json(await app.jobs.get(job[1]!)))
        if (request.method === 'GET' && job[2] === 'recovery-plan') return respond(json(await app.jobs.planRecovery(job[1]!)))
        if (request.method === 'POST' && job[2] === 'settle') return respond(json(await app.jobs.reconcileDetailed(job[1]!, request.signal)))
        if (request.method === 'POST' && job[2] === 'cancel') return respond(json(await app.jobs.cancel(job[1]!)))
        if (request.method === 'POST' && job[2] === 'retry') return respond(json(await app.jobs.retry(job[1]!)))
        if (request.method === 'POST' && job[2] === 'reconcile') return respond(json(await app.jobs.reconcile(job[1]!, request.signal)))
      }
      const run = route.match(/^\/research\/runs\/(run_[A-Za-z0-9_-]+)(?:\/(artifacts))?$/)
      if (run && request.method === 'GET') {
        const record = await app.research.getRun(app.projectId, run[1]!)
        return respond(json(run[2] ? await app.execution.artifacts(record.id) : record))
      }
      if (route === '/research/campaigns') {
        if (request.method === 'GET') return respond(json(await app.research.listCampaigns(app.projectId)))
        if (request.method === 'POST') return respond(json(await app.research.createCampaign(app.projectId, await body()), 201))
      }
      const skills = route.match(/^\/research\/campaigns\/(cmp_[A-Za-z0-9_-]+)\/skills(?:\/(initialize|replay|rollback|promote|skill_[a-z0-9._-]+))?$/)
      if (skills) {
        const campaignId = skills[1]!, action = skills[2]
        if (request.method === 'GET' && !action) return respond(json(await app.skills.list(campaignId)))
        if (request.method === 'POST' && action === 'initialize') return respond(json(await app.skills.initialize(campaignId)))
        if (request.method === 'POST' && action === 'replay') {
          const {model, ...input} = ReplayBody.parse(await body())
          return respond(json(await app.jobs.enqueueShadowReplay({...input, campaignId, modelSelection: model ? {provider: 'openrouter', modelId: model} : undefined}), 202))
        }
        if (request.method === 'POST' && (action === 'rollback' || action === 'promote')) {
          const input = SkillVersionBody.parse(await body())
          return respond(json(action === 'rollback' ? await app.skills.rollback(campaignId, input.versionId) : await app.skills.promoteToLibrary(campaignId, input.versionId)))
        }
        if (request.method === 'POST' && action?.startsWith('skill_')) {
          const {model, ...input} = RefinementBody.parse(await body())
          return respond(json(await app.jobs.enqueueRefinement({...input, campaignId, skillId: action, modelSelection: model ? {provider: 'openrouter', modelId: model} : undefined}), 202))
        }
      }
      const campaign = route.match(/^\/research\/campaigns\/(cmp_[A-Za-z0-9_-]+)\/(activate|experiments|loop|status|approvals|literature)$/)
      if (campaign) {
        if (campaign[2] === 'status' && request.method === 'GET') return respond(json(await app.campaign.status(campaign[1]!)))
        if (campaign[2] === 'approvals' && request.method === 'POST') return respond(json(await app.campaign.approveContract(campaign[1]!, ContractApprovalBody.parse(await body())), 201))
        if (campaign[2] === 'loop' && request.method === 'POST') {
          const {model, ...input} = CampaignJobBody.parse(await body())
          return respond(json(await app.campaign.enqueueCampaign(campaign[1]!, {...input, modelSelection: model ? {provider: 'openrouter', modelId: model} : undefined}), 202))
        }
        if (campaign[2] === 'literature' && request.method === 'POST') {
          const {model, ...input} = LiteratureJobBody.parse(await body())
          return respond(json(await app.jobs.enqueueLiterature(campaign[1]!, {...input, modelSelection: model ? {provider: 'openrouter', modelId: model} : undefined}), 202))
        }
        if (campaign[2] === 'activate' && request.method === 'POST') return respond(json(await app.research.activateCampaign(app.projectId, campaign[1]!)))
        if (campaign[2] === 'experiments') {
          if (request.method === 'GET') return respond(json(await app.research.listExperiments(app.projectId, campaign[1]!)))
          if (request.method === 'POST') return respond(json(await app.research.createExperiment(app.projectId, campaign[1]!, await body()), 201))
        }
      }
      if (route === '/research/targets' && request.method === 'POST') return respond(json(await ResearchArtifacts.authorTargetInput(app.workspace, await body()), 201))
      const workspace = route.match(/^\/research\/experiments\/(exp_[A-Za-z0-9_-]+)\/workspace(?:\/(file))?$/)
      if (workspace) {
        if (request.method === 'GET' && !workspace[2]) return respond(json(await app.workspaceFiles.view(workspace[1]!)))
        if (request.method === 'GET' && workspace[2]) return respond(json(await app.workspaceFiles.read(workspace[1]!, url.searchParams.get('path') ?? '')))
        if (request.method === 'POST' && workspace[2]) return respond(json(await app.workspaceFiles.write(workspace[1]!, WorkspaceWrite.parse(await body()))))
      }
      const knowledgeAction = route.match(/^\/research\/campaigns\/(cmp_[A-Za-z0-9_-]+)\/knowledge\/(query|reconcile|records\/(?:knw|lit|clm|aln|kcy|hyp|srv)_[A-Za-z0-9_-]+|(?:clm|aln)_[A-Za-z0-9_-]+\/review|publish)$/)
      if (knowledgeAction) {
        const campaignId = knowledgeAction[1]!, action = knowledgeAction[2]!
        const reader = new CampaignKnowledgeReader({store: app.store, projectId: app.projectId, campaignId})
        if (request.method === 'POST' && action === 'reconcile') {const {model, ...input} = KnowledgeReconcileBody.parse(await body()); return respond(json(await app.jobs.enqueueKnowledgeReview(campaignId, {...input, modelSelection: model ? {provider: 'openrouter', modelId: model} : undefined}), 202))}
        if (request.method === 'POST' && action === 'query') return respond(json(await reader.query(await body())))
        if (request.method === 'GET' && action.startsWith('records/')) return respond(json(await reader.read({id: action.slice(8), offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined})))
        if (request.method === 'POST' && action.endsWith('/review')) return respond(json(await reviewKnowledge(app, campaignId, action.split('/')[0]!, KnowledgeReviewBody.parse(await body()))))
        if (request.method === 'POST' && action === 'publish') { z.object({}).strict().parse(await body()); await app.research.publishCampaignKnowledge(app.projectId, campaignId, app.workspace); return respond(json({published: true})) }
      }
      const knowledge = route.match(/^\/research\/campaigns\/(cmp_[A-Za-z0-9_-]+)\/knowledge$/)
      if (knowledge && request.method === 'GET') {
        const state = await app.store.read(app.projectId)
        if (!state.campaigns[knowledge[1]!]) throw new Error('Campaign was not found')
        const scoped = (items: Record<string, any>) => Object.values(items).filter(item => item.campaignId === knowledge[1])
        return respond(json({concepts: scoped(state.knowledge), claims: scoped(state.claims), alignments: scoped(state.alignments), hypotheses: scoped(state.hypotheses), recordSnapshotHashes: Object.fromEntries([...scoped(state.claims), ...scoped(state.alignments)].map(record => [record.id, ResearchService.knowledgeRecordHash(record)])), literature: scoped(state.literature), cycles: scoped(state.knowledgeCycles), questions: scoped(state.researchRequests), observations: scoped(state.searchObservations)}))
      }
      const graph = route.match(/^\/research\/experiments\/(exp_[A-Za-z0-9_-]+)\/graph(?:\/(search|read|traverse))?$/)
      if(graph){
        const experiment=await app.experiment(graph[1]!),reader=new ProjectKnowledgeGraph({store:app.store,projectId:app.projectId,campaignId:experiment.campaignId,experimentId:experiment.id,expectedContractHash:experiment.contractHash})
        if(request.method==='GET'&&!graph[2])return respond(json(await reader.planningView()))
        if(request.method==='POST'&&graph[2])return respond(json(await reader[graph[2] as 'search'|'read'|'traverse'](await body())))
      }
      const experiment = route.match(/^\/research\/experiments\/(exp_[A-Za-z0-9_-]+)(?:\/(activate|history|context|authored-trials|discovery|autoresearch))?$/)
      if (experiment) {
        const id = experiment[1]!
        const action = experiment[2]
        if (request.method === 'GET' && !action) return respond(json(await app.experiment(id)))
        if (request.method === 'GET' && action === 'history') {const history=await app.research.history(app.projectId,id);return respond(json(url.searchParams.has('limit')?historyPage(history,Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit'))):history))}
        if (request.method === 'GET' && action === 'context') return respond(json(await app.science(id).context()))
        if (request.method === 'POST' && action === 'activate') return respond(json(await app.research.activateExperiment(app.projectId, id)))
        if (request.method === 'POST' && action === 'authored-trials') return respond(json(await app.science(id).authorTrial(await body()), 201))
        if (request.method === 'POST' && action === 'autoresearch') {
          const input = DiscoveryJobBody.parse(await body())
          return respond(json(await app.jobs.enqueueDiscovery(id, { idempotencyKey: input.idempotencyKey, iterations: input.iterations,
            sessionId: input.sessionId, modelBudgetUsd: input.modelBudgetUsd,
            conversation: input.conversation, prompt: input.prompt, allowCompute: input.allowCompute,
            modelSelection: input.model ? { provider: 'openrouter', modelId: input.model } : undefined,
          }), 202))
        }
        if (request.method === 'POST' && action === 'discovery') {
          const input = await body()
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64_000) return respond(json({ error: 'A bounded prompt is required' }, 400))
          const result = await app.discover(id, input.prompt, { sessionId: input.sessionId,
            runtime: { modelSelection: { provider: 'openrouter', modelId: input.model ?? DEFAULT_MODEL_SELECTION.modelId } }, run: { signal: request.signal },
          })
          return respond(json(result, result.status === 'completed' ? 200 : 409))
        }
      }
      const trial = route.match(/^\/research\/trials\/(trl_[A-Za-z0-9_-]+)\/(validate|evaluate|reconcile)$/)
      if (trial && request.method === 'POST') {
        const input = await body()
        if (trial[2] === 'validate') return respond(json(await app.execution.validateTrial({ trialId: trial[1]! })))
        if (typeof input.requestId !== 'string' || !input.requestId.trim()) return respond(json({ error: 'requestId is required' }, 400))
        if (trial[2] === 'reconcile') return respond(json(await app.execution.reconcile({ trialId: trial[1]!, requestId: input.requestId, signal: request.signal })))
        return respond(json(await app.execution.evaluateTrial({ trialId: trial[1]!, requestId: input.requestId, signal: request.signal })))
      }
      const content = route.match(/^\/research\/sessions\/(ses_[A-Za-z0-9_-]+)\/messages\/(\d+)\/content$/)
      if(content && request.method==='GET'){
        const store=openSessionReader(path.join(app.sessionDirectory,'sessions.sqlite'))
        if(!store)return respond(json({error:'Pi session not found'},404))
        try{const page=await store.messageContent(content[1]!,Number(content[2]),Number(url.searchParams.get('offsetBytes')??0),Number(url.searchParams.get('limitBytes')??65_536),url.searchParams.get('expectedHash')??undefined)
          return respond(page?json(page):json({error:'Original Pi message not found'},404))
        }finally{store.close()}
      }
      const session = route.match(/^\/research\/sessions\/(ses_[A-Za-z0-9_-]+)(?:\/(events|messages))?$/)
      if (session && request.method === 'GET') {
        const sessionFile=path.join(app.sessionDirectory,'sessions.sqlite')
        const store=openSessionReader(sessionFile)
        if(!store)return respond(json({error:'Pi session not found'},404))
        try {
          if(session[2]==='messages'){
            const page=await store.messages(session[1]!,Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit')??100),url.searchParams.get('anchor')??undefined)
            return respond(page?json(page):json({error:'Pi session not found'},404))
          }
          if(session[2]==='events' && url.searchParams.has('afterSequence')){
            const page=await store.eventPage(session[1]!,Number(url.searchParams.get('afterSequence')),Number(url.searchParams.get('limit')??100))
            return respond(page?json(page):json({error:'Pi session not found'},404))
          }
          const saved = await store.get(session[1]!)
          if (!saved) return respond(json({ error: 'Pi session not found' }, 404))
          return respond(json(session[2]==='events'?await store.events(session[1]!):saved))
        } finally { store.close() }
      }
      return respond(json({ error: 'Route not found. Generic OpenScience session APIs are not part of this backend.' }, 404))
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught)
      return respond(json({ error }, 400))
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
    'no-worker': { type: 'boolean' }, port: { type: 'string', default: '4096' }, workspace: { type: 'string' }, project: { type: 'string' }, 'data-dir': { type: 'string' }, 'execution-config': { type: 'string' }, cors: { type: 'string', multiple: true },
  } })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 through 65535')
  const app = new Application({ workspace: values.workspace ?? process.cwd(), projectId: values.project, dataDirectory: values['data-dir'], execution: await loadExecutionConfig(values['execution-config'] ?? process.env.AUTOFOLD_EXECUTION_CONFIG) })
  const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 1_048_576,
    fetch: createHandler(app, { allowedOrigins: values.cors ?? [], token: process.env.AUTOFOLD_API_TOKEN }),
  })
  const workerShutdown = new AbortController()
  const worker = values['no-worker'] ? Promise.resolve() : app.jobs.runWorker({ signal: workerShutdown.signal }).catch(error => console.error('Research worker stopped:', error instanceof Error ? error.message : String(error)))
  const shutdown = () => { workerShutdown.abort(); void worker.then(() => server.stop(true)) }
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
  console.log(`Autofold Pi backend listening at ${server.url} for ${app.projectId}`)
}
