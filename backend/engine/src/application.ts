import {canonicalOperationJSON} from '@autofold/science-core/operations'
import {prepareDecisionMemory,publishDecisionMemory,decisionMemoryExposure} from './decision-memory'
import {validateScientificMethodology,type MethodologyDeclaration} from './scientific-methodology'
import {AuxiliaryOperation} from './operations/auxiliary-state'
import { KnowledgeReviewController } from './knowledge-review-controller'
import { CampaignKnowledgeReader } from './knowledge'
import { CampaignSkillService, CapabilityRefinementController, SkillShadowReplayController, type SkillControllerOptions } from './skills'
import { CampaignController, type CampaignControllerOptions } from './campaign'
import { ExperimentWorkspace } from './workspace'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto, { createHash } from 'node:crypto'
import { ResearchService } from '@autofold/science-core/service'
import { StorageResearchStore, type ResearchStore } from '@autofold/science-core/store'
import { ResearchDomain } from '@autofold/science-core/domain'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { ResearchArtifacts } from '@autofold/science-core/artifacts'
import { ResearchTrajectoryCloseout } from '@autofold/science-core/trajectory-closeout'
import { CampaignEvidence } from '@autofold/science-core/campaign-evidence'
import { ScientificExecution } from './execution'
import { checkedPath } from './execution/paths'
import { PI_JOB_RUNTIME, PiJobController, type PiJobControllerOptions } from './jobs'
import type { DiscoverySciencePort } from './discovery'
import { createSessionStore, SqliteSessionStore, type AgentRuntimeOptions, type PiRunOptions } from './runtime'

export interface ApplicationOptions {
  workspace: string
  projectId?: string
  dataDirectory?: string
  sessionDirectory?: string
  execution?: Omit<ConstructorParameters<typeof ScientificExecution>[0], 'workspace' | 'projectId' | 'research'>
  skills?: Pick<SkillControllerOptions, 'runtimeOptions'>
  campaign?: Omit<CampaignControllerOptions, 'workspace' | 'projectId' | 'research' | 'store' | 'execution' | 'jobs' | 'sessionDirectory'>
  jobs?: Omit<PiJobControllerOptions, 'workspace' | 'projectId' | 'research' | 'store' | 'execution' | 'sessionDirectory'>
}

/** Explicit paths keep new projects separate from legacy data until an operator selects it. */
export class Application {
  readonly workspace: string
  readonly projectId: string
  readonly store: ResearchStore
  readonly research: ResearchService.Service
  readonly execution: ScientificExecution
  readonly dataDirectory: string
  readonly skills: CampaignSkillService
  readonly campaign: CampaignController
  readonly workspaceFiles: ExperimentWorkspace
  private readonly jobOptions: PiJobControllerOptions
  readonly jobs: PiJobController
  constructor(options: ApplicationOptions) {
    this.workspace = path.resolve(options.workspace)
    this.projectId = options.projectId ?? `prj_${createHash('sha256').update(this.workspace).digest('hex').slice(0, 24)}`
    this.dataDirectory = path.resolve(options.dataDirectory ?? path.join(this.workspace, '.autofold/research'))
    this.store = new StorageResearchStore({ directory: this.dataDirectory })
    this.research = new ResearchService.Service(this.store)
    this.execution = new ScientificExecution({ ...options.execution, workspace: this.workspace, projectId: this.projectId, research: this.research })
    this.sessionDirectory = path.resolve(options.sessionDirectory ?? path.join(this.workspace, '.autofold/pi', this.projectId))
    this.workspaceFiles = new ExperimentWorkspace({workspace: this.workspace, projectId: this.projectId, store: this.store})
    this.jobOptions = { ...options.jobs, sessionStoreFactory:options.jobs?.sessionStoreFactory??createSessionStore, workspace: this.workspace, projectId: this.projectId, research: this.research, store: this.store, execution: this.execution, sessionDirectory: this.sessionDirectory }
    this.jobs = new PiJobController(this.jobOptions)
    this.jobs.registerKnowledgeReview(new KnowledgeReviewController({runtimeOptions:options.jobs?.runtimeOptions,workspace:this.workspace,projectId:this.projectId,research:this.research,store:this.store,sessionDirectory:this.sessionDirectory}))
    this.campaign = new CampaignController({runtimeOptions: options.jobs?.runtimeOptions, ...options.campaign, workspace: this.workspace, projectId: this.projectId, research: this.research, store: this.store, execution: this.execution, jobs: this.jobs, sessionDirectory: this.sessionDirectory})
    this.jobs.registerOperation('campaign_loop', this.campaign.operation)
    this.skills = new CampaignSkillService({workspace: this.workspace, projectId: this.projectId, store: this.store})
    const skillOptions = {runtimeOptions: options.jobs?.runtimeOptions, ...options.skills, workspace: this.workspace, projectId: this.projectId, research: this.research, store: this.store, execution: this.execution, sessionDirectory: this.sessionDirectory}
    this.jobs.registerSkills({refinement: new CapabilityRefinementController(skillOptions), replay: new SkillShadowReplayController(skillOptions)})
  }
  readonly sessionDirectory: string

  async status() {
    const state = await this.store.read(this.projectId)
    return { projectId: this.projectId, workspace: this.workspace, runtime: 'pi', piVersion: '1.0.1', dataDirectory: this.dataDirectory,
      campaigns: Object.keys(state.campaigns).length, experiments: Object.keys(state.experiments).length,
      trials: Object.keys(state.trials).length, evaluations: Object.keys(state.evaluations).length,
      researchJobs: Object.values(state.jobs).filter(job => job.payload.runtime === PI_JOB_RUNTIME).map(job => ({ id: job.id, kind: job.payload.kind, status: job.status })),
      worker: this.jobs.workerState,
      legacyJobs: Object.values(state.jobs).filter(job => job.payload.runtime !== PI_JOB_RUNTIME && !['succeeded', 'failed', 'cancelled'].includes(job.status)).length }
  }

  /** Durable operation axes and pending derivative work, without returning authoring prose. */
  async operationDiagnostics() {
    const state = await this.store.read(this.projectId)
    return Object.values(state.operations).map(operation => ({id:operation.id,jobId:operation.jobId,kind:operation.kind,phase:operation.phase,
      revision:operation.revision,epoch:operation.epoch,owner:operation.owner,cancelledAt:operation.cancelledAt,
      effect:operation.effect,accounting:operation.accounting,outcome:operation.outcome,settlement:operation.settlement,
      outbox:Object.values(state.operationOutbox).filter(item=>item.operationId===operation.id).map(item=>({id:item.id,kind:item.kind,purpose:item.purpose,status:item.status}))}))
  }
  async rebuildOperationProjection(id:string) {
    if (!/^op_[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid original operation ID')
    const state=await this.store.read(this.projectId),operation=state.operations[id]
    if(operation?.kind==='verified_trajectory_evidence'){
      const observationId=String(operation.state.observationId??'')
      const evidence=ResearchTrajectoryCloseout.readCommitted(state,this.projectId,observationId)
      if(operation.state.commitHash!==evidence.commitHash||operation.identity.runId!==evidence.event.runId||operation.identity.receiptHash!==evidence.receiptHash)throw new Error('Original evidence projection identity differs')
      await checkedPath(this.workspace,`.autofold/autoresearch/${evidence.event.experimentId}/events.v2.jsonl`)
      await ResearchTrajectoryCloseout.rebuildJournalV2(state,this.workspace,evidence.event.experimentId)
      for(const item of Object.values(state.operationOutbox).filter(item=>item.operationId===id&&item.purpose==='projection'&&item.status==='pending')){
        if(item.kind==='campaign_knowledge')await this.research.publishCampaignKnowledge(this.projectId,evidence.event.campaignId!,this.workspace)
        else if(item.kind!=='trajectory_journal_v2')throw new Error('Unsupported original evidence projection')
        await this.research.acknowledgeTrajectoryProjection(this.projectId,item.id,evidence.commitHash)
      }
    }else await AuxiliaryOperation.rebuildProjection(this,id)
    return {operationId:id,rebuilt:true}
  }
  async experiment(id: string) {
    const state = await this.store.read(this.projectId)
    const experiment = state.experiments[id]
    if (!experiment) throw new Error(`Experiment ${id} was not found in ${this.projectId}`)
    ResearchDomain.assertContractIntegrity(experiment)
    return experiment
  }

  /** The bound experiment never comes from model-selected arguments. */
  science(experimentId: string,sessionId?:string): DiscoverySciencePort {
    let delivered:Awaited<ReturnType<typeof prepareDecisionMemory>>|undefined
    const knowledgeReader = async () => {
      const experiment = await this.experiment(experimentId)
      return new CampaignKnowledgeReader({store: this.store, projectId: this.projectId, campaignId: experiment.campaignId,
        experimentId, expectedContractHash: experiment.contractHash})
    }
    return {
      queryKnowledge: async input => (await knowledgeReader()).query(input),
      readKnowledge: async input => (await knowledgeReader()).read(input),
      context: async () => {
        const state = await this.store.read(this.projectId)
        const experiment=state.experiments[experimentId]
        if(!experiment)throw new Error(`Experiment ${experimentId} was not found in ${this.projectId}`)
        const memory=await prepareDecisionMemory({...this,state,campaignId:experiment.campaignId,experimentId})
        const memoryRoot='.autofold/autoresearch/'+experimentId,publicationGaps=await publishDecisionMemory(this.workspace,memoryRoot,memory)
        const executionCapabilities=await this.execution.capabilities()
        delivered=structuredClone(memory)
        return { experiment, executionCapabilities,decisionMemory:memory.packet,memoryRoot,publicationGaps,memoryPreparation:memory.preparation,
          evidenceAuthority: 'Only verified worker receipts and persisted scientific records establish outcomes. Mock scores are infrastructure checks.' }
      },
      authorTrial: async input => {
        if('decisionMemoryExposure' in input)throw new Error('Decision-memory exposure is host-derived from actual delivery')
        if ('methodologyProfile' in input && input.methodologyProfile !== 'human_explicit') throw new Error('Direct fresh authoring requires human_explicit methodology; historical labels cannot bypass admission')
        const experiment = await this.experiment(experimentId)
        const authored = await ResearchPrograms.author(this.workspace, { ...input, designAdapter: input.designAdapter ?? 'proto' })
        const campaign = (await this.store.read(this.projectId)).campaigns[experiment.campaignId]!
        const now = new Date().toISOString()
        const inspected = await this.execution.validateProposal({experiment, campaign, trial: ResearchDomain.Trial.parse({id: 'trl_preflight', experimentId: experiment.id,
          ...input, designAdapter: input.designAdapter ?? 'proto', ...authored, status: 'proposed', createdAt: now, updatedAt: now})})
        const state = await this.store.read(this.projectId)
        // Validate both human-supplied claims and the actual native declaration. Neither
        // input path can conceal an invalid comparator, citation or measurement.
        const supplied = validateScientificMethodology({state,experiment,profile:'human_explicit',evaluation:true,declaration:input,pipeline:inspected.pipeline,tools:inspected.tools})
        const declared:MethodologyDeclaration = inspected.declaration ?? {}
        const native = validateScientificMethodology({state,experiment,profile:'human_explicit',evaluation:true,declaration:declared,pipeline:inspected.pipeline,tools:inspected.tools})
        for (const key of ['decisionPlan','prediction','evidenceRefs','calibrationClass','replicateOfTrialId'] as const)
          if(supplied[key]!==undefined&&native[key]!==undefined&&canonicalOperationJSON(supplied[key])!==canonicalOperationJSON(native[key]))throw new Error(`Human authoring ${key} conflicts with the native program declaration`)
        const methodology = {...native,...Object.fromEntries(Object.entries(supplied).filter(([,value])=>value!==undefined))}
        const exposure=delivered&&sessionId?decisionMemoryExposure(delivered.packet,delivered.sourceManifest,sessionId,{decisionPlan:methodology.decisionPlan,evidenceRefs:methodology.evidenceRefs}):undefined
        const trial = await this.research.createTrial(this.projectId, experiment.id, { ...input, ...methodology,decisionMemoryExposure:exposure, designAdapter: input.designAdapter ?? 'proto', ...authored, executionProtocol: inspected.executionProtocol })
        try { return { trial, validation: { valid: true, ...await this.execution.validateTrial({ trialId: trial.id }) } } }
        catch (error) { return { trial, validation: { valid: false, error: error instanceof Error ? error.message : String(error) } } }
      },
      evaluateTrial: async input => {
        const context = await this.research.getTrialContext(this.projectId, input.trialId)
        if (context.experiment.id !== experimentId) throw new Error('Trial belongs to another experiment')
        return this.execution.evaluateTrial(input)
      },
      requestResearch: async input => this.research.requestResearch(this.projectId, experimentId, {
        request: { ...input, action: 'create' }, evidenceRefs: input.evidenceRefs ?? [], generatedBy: 'autofold-pi/v1',
      }),
      stop: async input => this.store.mutate(this.projectId, state => {
        const experiment = state.experiments[experimentId]
        if (!experiment) throw new Error('Experiment was not found')
        ResearchDomain.assertContractIntegrity(experiment)
        CampaignEvidence.resolve(state, { campaignId: experiment.campaignId, experimentId }).assert(input.evidenceRefs, 'Stop evidence')
        const previous = experiment.piStopDecision
        const decision = { ...input, authority: 'agent_proposal' }
        if (experiment.status === 'paused' && JSON.stringify(previous) === JSON.stringify(decision)) return { status: 'paused', decision }
        if (experiment.status !== 'active') throw new Error(`Cannot pause experiment from ${experiment.status}`)
        experiment.status = 'paused'
        experiment.updatedAt = new Date().toISOString()
        experiment.piStopDecision = decision
        return { status: 'paused', decision }
      }),
    }
  }

  async discover(experimentId: string, prompt: string, options: {
    sessionId?: string
    idempotencyKey?: string
    iterations?: number
    modelBudgetUsd?: number
    maximumDurationMs?: number
    /** @deprecated Additional legacy job time; prefer maximumDurationMs. */
    authoringTimeMs?: number
    runtime?: Omit<AgentRuntimeOptions, 'store' | 'tools'>
    run?: PiRunOptions
  } = {}) {
    const jobs = options.runtime ? new PiJobController({...this.jobOptions,
      runtimeOptions: {...this.jobOptions.runtimeOptions, ...options.runtime}}) : this.jobs
    const job = await jobs.enqueueDiscovery(experimentId, {
      idempotencyKey: options.idempotencyKey ?? `discovery_${crypto.randomUUID()}`,
      sessionId: options.sessionId, prompt, iterations: options.iterations ?? 1,
      modelSelection: options.runtime?.modelSelection,
      modelBudgetUsd: options.runtime?.limits?.maxCostUsd ?? options.modelBudgetUsd ?? 2,
      maximumDurationMs: options.maximumDurationMs ?? options.runtime?.limits?.maxDurationMs,
      authoringTimeMs: options.authoringTimeMs,
    })
    await jobs.runOnce({jobId: job.id, signal: options.run?.signal})
    let current = await jobs.get(job.id)
    // Observe a concurrent server worker's ownership; never reclaim it here.
    while (current.status === 'running' || current.status === 'queued') {
      options.run?.signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 100))
      current = await jobs.get(job.id)
    }
    return {status: current.status === 'succeeded' ? 'completed' : current.status === 'cancelled' ? 'cancelled' : 'failed',
      sessionId: String(current.payload.sessionId), jobId: current.id, job: current, error: current.error, result: current.result}
  }

  async createMockExperiment(objective = 'Verify the discovery infrastructure') {
    const campaign = await this.research.createCampaign(this.projectId, { objective })
    await this.research.activateCampaign(this.projectId, campaign.id)
    const target = await ResearchArtifacts.authorTarget(this.workspace, { format: 'autofold.target-artifact.v1', name: 'Infrastructure fixture',
      chains: [{ id: 'A', sequence: 'ACDEFGHIKLMNPQRSTVWY' }], bindingSite: { residues: [{ chainId: 'A', position: 1 }] } })
    const evaluator = (await this.execution.evaluators()).find(value => value.id === 'mock-peptide-panel')!
    const experiment = await this.research.createExperiment(this.projectId, campaign.id, { contract: {
      version: 1, objective, targetArtifactHash: target.targetArtifactHash, modality: 'short_peptide',
      budget: { maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1 },
      evaluator: { ...evaluator, fixedSeeds: [7, 11], submissionSize: 3 },
    } })
    return this.research.activateExperiment(this.projectId, experiment.id)
  }
}
