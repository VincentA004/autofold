import {CampaignKnowledgeReader} from './knowledge'
import {reviewKnowledge} from './knowledge-review'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Application } from './application'
import { inspectLegacy } from './legacy'
import { offlineDemo } from './demo'
import { loadExecutionConfig } from './config'
import { ResearchArtifacts } from '@autofold/science-core/artifacts'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { DEFAULT_MODEL_SELECTION, openSessionReader } from './runtime'
import { NativeAcceptanceRunner } from './acceptance'

async function withInterrupts<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try { return await work(controller.signal) }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}

const HELP = `Autofold — Pi discovery backend

Usage: npm run research:cli -- COMMAND [arguments] [flags]
Global: --workspace PATH --project PRJ_ID --data-dir PATH --execution-config FILE

  status
  evaluators
  campaigns
  campaign create --objective TEXT
  campaign activate CMP_ID
  campaign status CMP_ID
  campaign run CMP_ID --request-id KEY [--max-steps N] [--max-trajectories N]
    [--discovery-batch-size N] [--max-discovery-trajectories N] [--reserve-replay-trajectories N]
    [--max-knowledge-refreshes N] [--max-cost USD] [--per-child-cost USD] [--timeout-ms MS]
  campaign approve CMP_ID --proposal APR_ID --approval-id KEY --contract CONTRACT.json [--activate]
  knowledge query CMP_ID [--query TEXT] [--limit N] [--offset N]
  knowledge read CMP_ID --record RECORD_ID [--offset N] [--limit N]
  knowledge review CMP_ID --record CLM_OR_ALN_ID --status reviewed|contested|deprecated --reviewed-by ACTOR --expected-hash HASH
  knowledge reconcile CMP_ID --claim CLM_ID [--claim CLM_ID] [--alignment ALN_ID] --request-id KEY [--model MODEL] [--max-cost USD]
  knowledge publish CMP_ID
  literature CMP_ID --request-id KEY [--experiment EXP_ID] [--question TEXT]
  skills list|initialize CMP_ID
  skills refine CMP_ID --skill SKILL_ID --evidence REF_ID [--evidence REF_ID] --request-id KEY
  skills replay CMP_ID --experiment EXP_ID --version SKV_ID --request-id KEY [--repetitions 3]
  skills rollback|promote CMP_ID --version SKV_ID
  target add --file TARGET.json [--structure STRUCTURE.pdb]
  experiments CMP_ID
  experiment create CMP_ID --contract CONTRACT.json
  experiment activate EXP_ID
  trial create EXP_ID --program trial.py --hypothesis TEXT [--adapter proto|mock] [--intent optimize|calibrate|negative_control|shadow_replay]
  trial validate TRL_ID
  trial evaluate TRL_ID --request-id KEY
  run reconcile TRL_ID --request-id KEY
  history EXP_ID
  autoresearch EXP_ID --iterations N --request-id KEY [--session SES_ID] [--model OPENROUTER_MODEL]
  jobs
  job get|cancel|retry|reconcile|recovery-plan|settle JOB_ID
  operations
  operation rebuild-projection OP_ID
  worker [--once] [--poll-ms N]
  scientist message EXP_ID --prompt TEXT --request-id KEY [--allow-compute]
  acceptance native EXP_ID --execution-config PROFILE.json --request-id KEY [--iterations 2] [--max-cost 2]
  discovery run EXP_ID [--session SES_ID] [--prompt TEXT] [--model OPENROUTER_MODEL]
  session inspect SES_ID
  template proto|mock
  demo --offline
  legacy inspect --database FILE.sqlite

New project data defaults to WORKSPACE/.autofold/research; Pi transcripts use
WORKSPACE/.autofold/pi. Existing scientific SQLite data requires an explicit
--data-dir and --project. Donor sessions/jobs are never automatically resumed.
OPENROUTER_API_KEY supplies model credentials; default model ${DEFAULT_MODEL_SELECTION.modelId}.
Proto execution requires explicit host authorization and pinned runtime commits.
The offline demo uses the real Pi loop and CPU worker with synthetic fixtures.
`

export async function runCLI(argv: string[], output = (text: string) => console.log(text), error = (text: string) => console.error(text)) {
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      claim: {type: 'string', multiple: true}, alignment: {type: 'string', multiple: true},
      query: {type: 'string'}, limit: {type: 'string'}, offset: {type: 'string'}, record: {type: 'string'}, status: {type: 'string'}, 'reviewed-by': {type: 'string'}, 'expected-hash': {type: 'string'},
      skill: {type: 'string'}, version: {type: 'string'}, evidence: {type: 'string', multiple: true}, repetitions: {type: 'string'},
      activate: {type: 'boolean'}, proposal: {type: 'string'}, 'approval-id': {type: 'string'}, experiment: {type: 'string'}, question: {type: 'string'}, 'max-steps': {type: 'string'}, 'max-trajectories': {type: 'string'}, 'discovery-batch-size': {type: 'string'}, 'max-discovery-trajectories': {type: 'string'}, 'reserve-replay-trajectories': {type: 'string'}, 'max-knowledge-refreshes': {type: 'string'}, 'per-child-cost': {type: 'string'},
      'allow-compute': {type: 'boolean'}, help: { type: 'boolean' }, once: { type: 'boolean' }, iterations: { type: 'string' }, 'poll-ms': { type: 'string' }, offline: { type: 'boolean' }, workspace: { type: 'string' }, project: { type: 'string' }, 'data-dir': { type: 'string' }, 'execution-config': { type: 'string' },
      objective: { type: 'string' }, file: { type: 'string' }, structure: { type: 'string' }, contract: { type: 'string' }, program: { type: 'string' }, hypothesis: { type: 'string' },
      adapter: { type: 'string' }, intent: { type: 'string' }, 'request-id': { type: 'string' }, session: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' },
      database: { type: 'string' }, 'max-turns': { type: 'string' }, 'max-tools': { type: 'string' }, 'max-cost': { type: 'string' }, 'timeout-ms': { type: 'string' },
    } })
    const [command, noun, id] = parsed.positionals
    const values = parsed.values
    const required = (value: string | undefined, label: string) => { if (!value) throw new Error(`Missing ${label}`); return value }
    const show = (value: unknown) => output(JSON.stringify(value, null, 2))
    if (!command || values.help) { output(HELP); return 0 }
    if (command === 'demo') {
      if (!values.offline) throw new Error('The demo requires --offline')
      show(await offlineDemo(values.workspace && path.resolve(values.workspace)))
      return 0
    }
    if (command === 'legacy' && noun === 'inspect') { show(inspectLegacy(required(values.database, '--database'))); return 0 }
    const app = new Application({ workspace: path.resolve(values.workspace ?? process.cwd()), projectId: values.project, dataDirectory: values['data-dir'], execution: await loadExecutionConfig(values['execution-config'] ?? process.env.AUTOFOLD_EXECUTION_CONFIG) })
    if (command === 'operations') show(await app.operationDiagnostics())
    else if (command === 'operation' && noun === 'rebuild-projection') show(await app.rebuildOperationProjection(required(id, 'operation ID')))
    else if (command === 'jobs') show(await app.jobs.list())
    else if (command === 'job' && noun === 'get') show(await app.jobs.get(required(id, 'job ID')))
    else if (command === 'job' && noun === 'recovery-plan') show(await app.jobs.planRecovery(required(id, 'job ID')))
    else if (command === 'job' && noun === 'settle') show(await withInterrupts(signal => app.jobs.reconcileDetailed(required(id, 'job ID'), signal)))
    else if (command === 'job' && noun === 'cancel') show(await app.jobs.cancel(required(id, 'job ID')))
    else if (command === 'job' && noun === 'retry') show(await app.jobs.retry(required(id, 'job ID')))
    else if (command === 'job' && noun === 'reconcile') show(await withInterrupts(signal => app.jobs.reconcile(required(id, 'job ID'), signal)))
    else if (command === 'autoresearch') show(await app.jobs.enqueueDiscovery(required(noun, 'experiment ID'), {
      idempotencyKey: required(values['request-id'], '--request-id'), iterations: Number(values.iterations ?? 2),
      sessionId: values.session, modelSelection: values.model ? { provider: 'openrouter', modelId: values.model } : undefined,
      modelBudgetUsd: values['max-cost'] !== undefined ? Number(values['max-cost']) : undefined,
    }))
    else if (command === 'scientist' && noun === 'message') show(await app.jobs.enqueueDiscovery(required(id, 'experiment ID'), {
      idempotencyKey: required(values['request-id'], '--request-id'), conversation: true,
      prompt: required(values.prompt, '--prompt'), allowCompute: values['allow-compute'] ?? false,
      iterations: 1, sessionId: values.session, modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined,
      modelBudgetUsd: values['max-cost'] !== undefined ? Number(values['max-cost']) : undefined,
    }))
    else if (command === 'acceptance' && noun === 'native') {
      const config = path.resolve(required(values['execution-config'] ?? process.env.AUTOFOLD_EXECUTION_CONFIG, '--execution-config'))
      const runner = new NativeAcceptanceRunner({workspace: app.workspace, projectId: app.projectId, store: app.store,
        research: app.research, execution: app.execution, jobs: app.jobs, sessionDirectory: app.sessionDirectory,
        profile: {id: path.basename(config), mode: app.execution.transportKind, sourcePath: config}})
      const report = await withInterrupts(signal => runner.run(required(id, 'experiment ID'), {
        idempotencyKey: required(values['request-id'], '--request-id'), iterations: Number(values.iterations ?? 2) as 1|2,
        modelBudgetUsd: values['max-cost'] === undefined ? 2 : Number(values['max-cost']),
        modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined,
      }, signal))
      show(report)
      return (report.authorizedIterations === 2 ? report.fullTwoIterationAcceptancePassed : report.nativeSoftwareAcceptancePassed) ? 0 : 1
    }
    else if (command === 'worker') {
      const pollMs = Number(values['poll-ms'] ?? 1000)
      if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) throw new Error('Worker poll interval must be 10–60000 milliseconds')
      if (values.once) show(await withInterrupts(signal => app.jobs.runOnce({ signal })) ?? { status: 'idle' })
      else await withInterrupts(signal => app.jobs.runWorker({ signal, pollMs }))
    }
    else if (command === 'status') show(await app.status())
    else if (command === 'evaluators') show(await app.execution.evaluators())
    else if (command === 'campaigns') show(await app.research.listCampaigns(app.projectId))
    else if (command === 'campaign' && noun === 'create') show(await app.research.createCampaign(app.projectId, { objective: required(values.objective, '--objective') }))
    else if (command === 'campaign' && noun === 'status') show(await app.campaign.status(required(id, 'campaign ID')))
    else if (command === 'campaign' && noun === 'run') show(await app.campaign.enqueueCampaign(required(id, 'campaign ID'), {idempotencyKey: required(values['request-id'], '--request-id'), maxSteps: Number(values['max-steps'] ?? 3), maximumTrajectories: Number(values['max-trajectories'] ?? 3), discoveryBatchSize: values['discovery-batch-size'] === undefined ? undefined : Number(values['discovery-batch-size']), maximumDiscoveryTrajectories: values['max-discovery-trajectories'] === undefined ? undefined : Number(values['max-discovery-trajectories']), reservedReplayTrajectories: values['reserve-replay-trajectories'] === undefined ? undefined : Number(values['reserve-replay-trajectories']), maximumKnowledgeRefreshes: values['max-knowledge-refreshes'] === undefined ? undefined : Number(values['max-knowledge-refreshes']), perChildModelBudgetUsd: values['per-child-cost'] === undefined ? undefined : Number(values['per-child-cost']), maximumDurationMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']), modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined, modelBudgetUsd: values['max-cost'] ? Number(values['max-cost']) : undefined}))
    else if (command === 'campaign' && noun === 'approve') show(await app.campaign.approveContract(required(id, 'campaign ID'), {approvalId: required(values['approval-id'], '--approval-id'), proposalId: required(values.proposal, '--proposal'), contract: JSON.parse(await fs.readFile(required(values.contract, '--contract'), 'utf8')), activate: values.activate}))
    else if (command === 'skills' && noun === 'list') show(await app.skills.list(required(id, 'campaign ID')))
    else if (command === 'skills' && noun === 'initialize') show(await app.skills.initialize(required(id, 'campaign ID')))
    else if (command === 'skills' && noun === 'rollback') show(await app.skills.rollback(required(id, 'campaign ID'), required(values.version, '--version')))
    else if (command === 'skills' && noun === 'promote') show(await app.skills.promoteToLibrary(required(id, 'campaign ID'), required(values.version, '--version')))
    else if (command === 'skills' && noun === 'refine') show(await app.jobs.enqueueRefinement({campaignId: required(id, 'campaign ID'), skillId: required(values.skill, '--skill'), trajectoryRefs: values.evidence ?? [], idempotencyKey: required(values['request-id'], '--request-id'), modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined, modelBudgetUsd: values['max-cost'] ? Number(values['max-cost']) : undefined}))
    else if (command === 'skills' && noun === 'replay') show(await app.jobs.enqueueShadowReplay({campaignId: required(id, 'campaign ID'), experimentId: required(values.experiment, '--experiment'), candidateVersionId: required(values.version, '--version'), repetitions: Number(values.repetitions ?? 3), idempotencyKey: required(values['request-id'], '--request-id'), modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined, modelBudgetUsd: values['max-cost'] ? Number(values['max-cost']) : undefined}))
    else if (command === 'knowledge' && noun === 'query') show(await new CampaignKnowledgeReader({store: app.store, projectId: app.projectId, campaignId: required(id, 'campaign ID')}).query({query: values.query, limit: values.limit === undefined ? undefined : Number(values.limit), offset: values.offset === undefined ? undefined : Number(values.offset)}))
    else if (command === 'knowledge' && noun === 'read') show(await new CampaignKnowledgeReader({store: app.store, projectId: app.projectId, campaignId: required(id, 'campaign ID')}).read({id: required(values.record, '--record'), limit: values.limit === undefined ? undefined : Number(values.limit), offset: values.offset === undefined ? undefined : Number(values.offset)}))
    else if (command === 'knowledge' && noun === 'review') show(await reviewKnowledge(app, required(id, 'campaign ID'), required(values.record, '--record'), {status: required(values.status, '--status'), reviewedBy: required(values['reviewed-by'], '--reviewed-by'), expectedHash: required(values['expected-hash'], '--expected-hash')}))
    else if (command === 'knowledge' && noun === 'reconcile') show(await app.jobs.enqueueKnowledgeReview(required(id, 'campaign ID'), {claimIds: values.claim ?? [], alignmentIds: values.alignment ?? [], question: values.question, idempotencyKey: required(values['request-id'], '--request-id'), modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined, modelBudgetUsd: values['max-cost'] === undefined ? undefined : Number(values['max-cost'])}))
    else if (command === 'knowledge' && noun === 'publish') {await app.research.publishCampaignKnowledge(app.projectId, required(id, 'campaign ID'), app.workspace); show({published: true})}
    else if (command === 'literature') show(await app.jobs.enqueueLiterature(required(noun, 'campaign ID'), {idempotencyKey: required(values['request-id'], '--request-id'), question: values.question, focusExperimentId: values.experiment, modelSelection: values.model ? {provider: 'openrouter', modelId: values.model} : undefined, modelBudgetUsd: values['max-cost'] ? Number(values['max-cost']) : undefined}))
    else if (command === 'campaign' && noun === 'activate') show(await app.research.activateCampaign(app.projectId, required(id, 'campaign ID')))
    else if (command === 'target' && noun === 'add') {
      const artifact = JSON.parse(await fs.readFile(required(values.file, '--file'), 'utf8'))
      const structure = values.structure ? await fs.readFile(values.structure) : undefined
      show(await ResearchArtifacts.authorTarget(app.workspace, artifact, structure))
    }
    else if (command === 'experiments') show(await app.research.listExperiments(app.projectId, required(noun, 'campaign ID')))
    else if (command === 'experiment' && noun === 'create') show(await app.research.createExperiment(app.projectId, required(id, 'campaign ID'), { contract: JSON.parse(await fs.readFile(required(values.contract, '--contract'), 'utf8')) }))
    else if (command === 'experiment' && noun === 'activate') show(await app.research.activateExperiment(app.projectId, required(id, 'experiment ID')))
    else if (command === 'trial' && noun === 'create') show(await app.science(required(id, 'experiment ID')).authorTrial({
      program: await fs.readFile(required(values.program, '--program'), 'utf8'), hypothesis: required(values.hypothesis, '--hypothesis'),
      designAdapter: values.adapter as 'mock' | 'proto' | undefined, intent: values.intent as 'optimize' | undefined,
    }))
    else if (command === 'trial' && noun === 'validate') show(await app.execution.validateTrial({ trialId: required(id, 'trial ID') }))
    else if (command === 'trial' && noun === 'evaluate') show(await withInterrupts(signal => app.execution.evaluateTrial({ trialId: required(id, 'trial ID'), requestId: required(values['request-id'], '--request-id'), signal })))
    else if (command === 'run' && noun === 'reconcile') show(await withInterrupts(signal => app.execution.reconcile({ trialId: required(id, 'trial ID'), requestId: required(values['request-id'], '--request-id'), signal })))
    else if (command === 'history') show(await app.research.history(app.projectId, required(noun, 'experiment ID')))
    else if (command === 'template') {
      if (noun !== 'proto' && noun !== 'mock') throw new Error('Template must be proto or mock')
      output(ResearchPrograms.templates()[noun])
    }
    else if (command === 'session' && noun === 'inspect') {
      const store = openSessionReader(path.join(app.sessionDirectory, 'sessions.sqlite'))
      if(!store)throw new Error('Pi session not found')
      try { const session = await store.get(required(id, 'session ID')); if (!session) throw new Error('Pi session not found'); show(session) } finally { store.close() }
    }
    else if (command === 'discovery' && noun === 'run') {
      const controller = new AbortController()
      const abort = () => controller.abort()
      process.once('SIGINT', abort); process.once('SIGTERM', abort)
      try {
        const limits = Object.fromEntries([['maxTurns', values['max-turns']], ['maxToolCalls', values['max-tools']], ['maxCostUsd', values['max-cost']], ['maxDurationMs', values['timeout-ms']]].filter(([, value]) => value !== undefined).map(([key, value]) => [key, Number(value)]))
        const result = await app.discover(required(id, 'experiment ID'), values.prompt ?? 'Inspect the frozen experiment and its evidence. Choose the next useful scientific action, perform only authorized work, and explain the result.', {
          sessionId: values.session, runtime: { modelSelection: { provider: 'openrouter', modelId: values.model ?? DEFAULT_MODEL_SELECTION.modelId }, limits }, run: { signal: controller.signal,
            onEvent: event => { if (['tool_execution_start', 'tool_execution_end', 'run_finished'].includes(event.type)) error(JSON.stringify(event)) },
          },
        })
        show(result)
        return result.status === 'completed' ? 0 : 1
      } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
    }
    else throw new Error(`Unknown command: ${parsed.positionals.join(' ')}`)
    return 0
  } catch (caught) { error(caught instanceof Error ? caught.message : String(caught)); return 1 }
}

if (import.meta.main) process.exitCode = await runCLI(Bun.argv.slice(2))
