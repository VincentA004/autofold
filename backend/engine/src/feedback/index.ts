import z from 'zod'
import {ResearchDomain} from '@autofold/science-core/domain'
import {CampaignEvidence} from '@autofold/science-core/campaign-evidence'
import {ResearchTrajectoryCloseout} from '@autofold/science-core/trajectory-closeout'
import type {ResearchStore, ResearchState} from '@autofold/science-core/store'
import type {ScientificExecution} from '../execution'
import {CampaignPolicy} from '../campaign/policy'

const RUNTIME = 'autofold-pi.v1'
export const NativeFeedbackRecord = z.object({
  format: z.enum(['autofold.native-feedback.v1','autofold.native-feedback.v2']), campaignId: z.string().startsWith('cmp_'),
  experimentId: z.string().startsWith('exp_'), jobId: z.string().startsWith('job_'),
  runId: z.string().startsWith('run_'), trialId: z.string().startsWith('trl_'),
  cycleId: z.string().startsWith('kcy_').optional(), observationId:z.string().startsWith('sobs_').optional(), commitHash:z.string().startsWith('sha256:').optional(),
  manifestHash: ResearchDomain.Run.shape.manifestHash,
  authoring: CampaignPolicy.RecentAuthoringAttempt, feedback: z.array(CampaignPolicy.RecentSkillFeedback).max(3),
}).superRefine((record,context)=>{
  if(record.format==='autofold.native-feedback.v1'&&!record.cycleId)context.addIssue({code:'custom',message:'Historical feedback requires its original knowledge cycle'})
  if(record.format==='autofold.native-feedback.v2'&&(!record.observationId||!record.commitHash))context.addIssue({code:'custom',message:'Direct feedback requires its original observation commit'})
})
export type NativeFeedbackRecord = z.infer<typeof NativeFeedbackRecord>
export interface FeedbackOrigin {jobId: string; leaseId: string}
export interface NativeFeedbackOptions {projectId: string; store: ResearchStore; execution: Pick<ScientificExecution, 'artifacts'> & Partial<Pick<ScientificExecution,'failureReceipt'>>}

/** Fixed host interpretation of reverified predictor metrics; no model-supplied score is admitted. */
export function predictorDisagreement(evidence: Array<{candidateId: string; modelId: string; seed?:number;stage?:unknown;status: 'completed' | 'skipped'; metrics?: Record<string, unknown>}>, threshold = .15) {
  const groups=new Map<string,Map<string,Map<number,number>>>()
  const duplicates=new Set<string>()
  for(const item of evidence){
    if(item.status!=='completed'||!Number.isInteger(item.seed))continue
    // One metric observation per receipt. Boltz emits both iptm and protein_iptm
    // with the same value; aliases are not two independent predictor receipts.
    const aliases=['protein_iptm','iptm','ipTM'].filter(name=>Object.hasOwn(item.metrics??{},name)).map(name=>item.metrics![name])
    if(!aliases.length)continue
    const key=JSON.stringify([item.candidateId,'interface_iptm']),models=groups.get(key)??new Map<string,Map<number,number>>()
    const seeds=models.get(item.modelId)??new Map<number,number>(),identity=key+':'+item.modelId+':'+item.seed
    if(aliases.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1) ||
      aliases.some(value=>Math.abs(Number(value)-Number(aliases[0]))>1e-9)) {
      duplicates.add(identity);continue // Conflicting aliases cannot be silently selected.
    }
    // Stage labels identify predictor execution, not the compared scientific entity.
    // Repeated same-model/seed receipts across stages remain ambiguous.
    if(seeds.has(item.seed!))duplicates.add(identity)
    seeds.set(item.seed!,Number(aliases[0]));models.set(item.modelId,seeds);groups.set(key,models)
  }
  const comparisons:Array<{candidateId:string;metric:string;modelIds:string[];confidenceRange:number;threshold:number;pairedSeeds:number[];limitation:string}>=[]
  for(const [key,models] of groups){
    const [candidateId,metric]=JSON.parse(key),entries=[...models].sort(([a],[b])=>a.localeCompare(b))
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      const [a,left]=entries[i]!,[b,right]=entries[j]!
      const pairedSeeds=[...left.keys()].filter(seed=>right.has(seed)&&!duplicates.has(key+':'+a+':'+seed)&&!duplicates.has(key+':'+b+':'+seed)).sort((a,b)=>a-b)
      if(!pairedSeeds.length)continue
      const confidenceRange=Math.abs(pairedSeeds.reduce((sum,seed)=>sum+left.get(seed)!-right.get(seed)!,0)/pairedSeeds.length)
      if(confidenceRange>=threshold)comparisons.push({candidateId,metric,modelIds:[a,b],confidenceRange,threshold,pairedSeeds,limitation:'Matched raw interface-ipTM contrast is descriptive; different predictors are not calibrated biological measurements.'})
    }
  }
  return comparisons.sort((a,b)=>b.confidenceRange-a.confidenceRange||a.candidateId.localeCompare(b.candidateId))[0]
}

/** Reconcile exact-run recovery and exact-trajectory refinement chains, never an experiment-only overlap. */
export function reconcileSkillFeedback(feedback: CampaignPolicy.RecentSkillFeedback[], trajectories: CampaignPolicy.RecentTrajectory[], versions: ResearchDomain.SkillVersion[], campaignId: string) {
  return feedback.filter(item => item.trigger !== 'optional_evidence_gap' || !trajectories.some(trajectory =>
    trajectory.experimentId === item.experimentId && trajectory.evidenceCompleteness?.status === 'complete' &&
    !!trajectory.run && item.trajectoryRefs.includes(trajectory.run.id)))
    .map(item => {
      const specific = item.trajectoryRefs.filter(ref => /^(run|trl)_/.test(ref) || item.trigger === 'authoring_failure' && ref === item.jobId)
      const refinement = versions.filter(version => version.campaignId === campaignId && version.skillId === item.skillId &&
        version.source === 'campaign_refinement' && specific.some(ref => version.trajectoryRefs.includes(ref)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version || b.id.localeCompare(a.id))[0]
      return refinement ? CampaignPolicy.RecentSkillFeedback.parse({...item, refinement: {versionId: refinement.id,
        status: refinement.status, replayPassed: refinement.replay?.passed, evaluatedAt: refinement.replay?.evaluatedAt}}) : item
    })
}

function assertOrigin(state: ResearchState, projectId: string, campaignId: string, origin: FeedbackOrigin) {
  let job = state.jobs[origin.jobId]
  const seen = new Set<string>()
  while (job) {
    if (seen.has(job.id) || seen.size >= 100 || job.projectId !== projectId || job.payload.runtime !== RUNTIME || job.status !== 'running' ||
      !job.leaseId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now() || job.cancelRequestedAt ||
      job.id === origin.jobId && job.leaseId !== origin.leaseId) throw new Error('Native feedback job lease or ancestor fence is no longer active')
    const scope = job.payload.kind === 'autoresearch' ? state.experiments[job.payload.experimentId]?.campaignId : job.payload.campaignId
    if (scope !== campaignId) throw new Error('Native feedback owner is outside this campaign')
    seen.add(job.id)
    const parent = job.payload.parentJobId
    if (typeof parent !== 'string') return
    job = state.jobs[parent]
    if (!job) throw new Error('Native feedback job ancestor is missing')
  }
  throw new Error('Native feedback owner is missing')
}

export class NativeFeedbackController {
  constructor(readonly options: NativeFeedbackOptions) {}
  async collect(campaignId: string, suppliedState?: ResearchState, runIds?: ReadonlySet<string>) {
    const {projectId, store, execution} = this.options, state = suppliedState ?? await store.read(projectId)
    if (state.campaigns[campaignId]?.projectId !== projectId) throw new Error('Native feedback campaign is outside this host project')
    const records: NativeFeedbackRecord[] = [], trajectories: CampaignPolicy.RecentTrajectory[] = []
    const attempts: CampaignPolicy.RecentAuthoringAttempt[] = []
    const jobs = Object.values(state.jobs).filter(job => job.projectId === projectId && job.payload.runtime === RUNTIME &&
      job.payload.kind === 'autoresearch' && state.experiments[job.payload.experimentId]?.campaignId === campaignId)
    for (const job of jobs) for (const [phase, checkpoint] of Object.entries(job.checkpoints)) {
      if (!/^scientist:authoring:\d+:\d+$/.test(phase)) continue
      const attempt = CampaignPolicy.RecentAuthoringAttempt.safeParse({...checkpoint.data, jobId: job.id,
        experimentId: job.payload.kind === 'autoresearch' ? job.payload.experimentId : undefined, recordedAt: checkpoint.completedAt})
      if (attempt.success) attempts.push(attempt.data)
    }
    const runs = Object.values(state.runs).filter(run => (!runIds || runIds.has(run.id)) && ['succeeded', 'failed'].includes(run.status) &&
      state.experiments[state.trials[run.trialId]?.experimentId ?? '']?.campaignId === campaignId).sort((a,b) =>
      (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100)
    for (const run of runs) {
      const trial = state.trials[run.trialId], experiment = state.experiments[trial?.experimentId ?? '']
      const job = jobs.find(job => job.id === trial?.origin?.jobId && job.payload.kind === 'autoresearch' && job.payload.experimentId === trial?.experimentId)
      if (!trial || !experiment || !job || trial.designAdapter !== 'proto' || trial.intent === 'shadow_replay' || experiment?.contract.evaluator.id === 'mock-peptide-panel') continue
      const actor = run.status === 'succeeded' ? ResearchTrajectoryCloseout.successCloseoutActor(run.id) : ResearchTrajectoryCloseout.failureCloseoutActor(run.id)
      const cycle = Object.values(state.knowledgeCycles).find(cycle => cycle.campaignId === campaignId && cycle.generated.by === actor)
      const observation=Object.values(state.searchObservations).find(item=>item.closeoutVersion===2&&item.runId===run.id&&item.trialId===trial.id&&item.campaignId===campaignId&&item.commitHash&&
        (run.status==='succeeded'?item.decision!=='failed'&&item.receiptHash===run.manifestHash:item.decision==='failed'))
      if (!cycle&&!observation) continue
      const closeout = Object.entries(job.checkpoints).find(([phase, checkpoint]) => /^scientist:evaluation:[a-f0-9]{64}:closeout$/.test(phase) &&
        checkpoint.data.status === 'completed' && (observation
          ? checkpoint.data.closeoutVersion===2&&checkpoint.data.observationId===observation.id&&checkpoint.data.commitHash===observation.commitHash
          : checkpoint.data.cycleId === cycle!.id))
      if (!closeout) continue
      const intent = job.checkpoints[closeout[0].replace(/:closeout$/, ':trial')]?.data
      if (intent?.trialId !== trial.id || !Number.isInteger(intent.iteration) || Number(intent.iteration) < 1) continue
      const evaluation = Object.values(state.evaluations).find(item => item.trialId === trial.id)
      let verified: Awaited<ReturnType<ScientificExecution['artifacts']>> | undefined
      if (run.status === 'succeeded') {
        try {verified = await execution.artifacts(run.id)} catch {continue}
        if (!verified.scientific || verified.run.id !== run.id || verified.trial.id !== trial.id || verified.run.manifestHash !== run.manifestHash) continue
      }else if(observation){
        try{const failed=await execution.failureReceipt?.(run.id);if(!failed||failed.receiptHash!==observation.receiptHash)continue}catch{continue}
      }
      const authoring = CampaignPolicy.RecentAuthoringAttempt.parse({jobId: job.id, experimentId: experiment.id, iteration: intent.iteration,
        attempt: 1, status: 'ready', programFingerprint: trial.programHash, semanticProgramFingerprint: trial.semanticProgramFingerprint,
        workflowFingerprint: trial.workflowFingerprint, recordedAt: trial.createdAt})
      const refs = [experiment.id, trial.id, run.id, ...(observation?[observation.id]:[cycle!.id]), ...(evaluation ? [evaluation.id] : [])]
      const common = {jobId: job.id, experimentId: experiment.id, iteration: intent.iteration, trajectoryRefs: refs, requiresShadowReplay: true,
        recordedAt: run.completedAt ?? closeout[1].completedAt}
      const feedback: CampaignPolicy.RecentSkillFeedback[] = []
      if (run.status === 'failed') feedback.push(CampaignPolicy.RecentSkillFeedback.parse({...common, skillId: 'skill_bionemo.binder-workflow-strategy',
        trigger: 'run_failure', rationale: `Trusted native workflow execution failed: ${(run.error ?? 'unknown failure').slice(0, 1500)}`}))
      if (verified?.evidenceCompleteness?.status === 'partial_optional') feedback.push(CampaignPolicy.RecentSkillFeedback.parse({...common,
        skillId: 'skill_bionemo.predictor-interpretation', trigger: 'optional_evidence_gap',
        rationale: `Verified locked result has skipped optional evidence stages: ${verified.evidenceCompleteness.skippedStages.slice().sort().join(', ')}.`.slice(0,2000)}))
      const disagreement = verified && predictorDisagreement(verified.modelEvidence.filter((item): item is Extract<typeof item, {status: 'completed'}> => item.status === 'completed'))
      if (disagreement) feedback.push(CampaignPolicy.RecentSkillFeedback.parse({...common, skillId: 'skill_bionemo.predictor-interpretation', trigger: 'predictor_disagreement',
        rationale: `Reverified candidate ${disagreement.candidateId} has matched-seed raw interface-ipTM contrast ${disagreement.confidenceRange.toFixed(4)} across ${disagreement.modelIds.join(', ')}. This is an interpretation-method opportunity; the frozen evaluator is unchanged.`.slice(0,2000)}))
      records.push(NativeFeedbackRecord.parse({format: observation?'autofold.native-feedback.v2':'autofold.native-feedback.v1', campaignId, experimentId: experiment.id,
        jobId: job.id, runId: run.id, trialId: trial.id,
        ...(observation?{observationId:observation.id,commitHash:observation.commitHash}:{cycleId:cycle!.id}),manifestHash: run.manifestHash, authoring, feedback}))
      trajectories.push(CampaignPolicy.RecentTrajectory.parse({experimentId: experiment.id, trial, run, evaluation,
        latestAt: run.completedAt ?? run.createdAt, evidenceCompleteness: verified?.evidenceCompleteness,
        modelEvidence: verified?.modelEvidence.slice(0, 24).map(item => ({...item, modelId: String(item.modelId), stage: typeof item.stage === 'string' ? item.stage : undefined, reason: 'reason' in item && typeof item.reason === 'string' ? item.reason : undefined}))}))
    }
    const authoring = [...attempts, ...records.map(record => record.authoring)].sort((a,b) => b.recordedAt.localeCompare(a.recordedAt) || a.jobId.localeCompare(b.jobId))
    const unique = authoring.filter((item,index) => authoring.findIndex(other => other.jobId === item.jobId && other.iteration === item.iteration &&
      other.programFingerprint === item.programFingerprint && other.status === item.status) === index)
    const failures = attempts.filter(item => item.status === 'failed' && !unique.some(ready => ready.status === 'ready' && ready.experimentId === item.experimentId && ready.iteration === item.iteration && ready.recordedAt >= item.recordedAt)).map(item => CampaignPolicy.RecentSkillFeedback.parse({...item,
      skillId: 'skill_bionemo.binder-workflow-strategy', trigger: 'authoring_failure', rationale: `Trusted native authoring validation failed: ${(item.error ?? 'unknown failure').slice(0,1500)}`,
      trajectoryRefs: [item.experimentId, item.jobId], programFingerprint: item.programFingerprint, attempt: item.attempt, requiresShadowReplay: true}))
    const feedback = reconcileSkillFeedback([...records.flatMap(record => record.feedback), ...failures], trajectories,
      Object.values(state.skillVersions), campaignId).sort((a,b) => b.recordedAt.localeCompare(a.recordedAt) || a.jobId.localeCompare(b.jobId))
    return {records, trajectories, recentAuthoringAttempts: unique.slice(0,20), recentSkillFeedback: feedback.slice(0,20)}
  }
  /** Scientist closeout hook: derive only the exact trusted run, never a model-authored result body. */
  async recordRun(origin: FeedbackOrigin, runId: string) {
    const state = await this.options.store.read(this.options.projectId), run = state.runs[runId]
    const trial = run && state.trials[run.trialId], campaignId = trial && state.experiments[trial.experimentId]?.campaignId
    if (!run || !trial || !campaignId || trial.origin?.jobId !== origin.jobId) throw new Error('Native feedback run is outside this owning job')
    const projection = await this.collect(campaignId, state, new Set([runId]))
    if (projection.records.length) await this.persist(origin, campaignId, projection.records)
    return projection.records[0]
  }
  /** Atomic host-only append. Caller supplies the exact current lease; model tool arguments never do. */
  async persist(origin: FeedbackOrigin, campaignId: string, records: NativeFeedbackRecord[]) {
    const parsed = records.map(record => NativeFeedbackRecord.parse(record))
    await this.options.store.mutate(this.options.projectId, state => {
      assertOrigin(state, this.options.projectId, campaignId, origin)
      const owner = state.jobs[origin.jobId]!
      for (const record of parsed) {
        if (record.campaignId !== campaignId || state.experiments[record.experimentId]?.campaignId !== campaignId ||
          state.runs[record.runId]?.trialId !== record.trialId || state.trials[record.trialId]?.origin?.jobId !== record.jobId ||
          (record.format==='autofold.native-feedback.v1'
            ? state.knowledgeCycles[record.cycleId!]?.campaignId !== campaignId
            : state.searchObservations[record.observationId!]?.campaignId!==campaignId||state.searchObservations[record.observationId!]?.runId!==record.runId||state.searchObservations[record.observationId!]?.commitHash!==record.commitHash) ||
          state.jobs[record.jobId]?.payload.runtime !== RUNTIME || record.authoring.programFingerprint !== state.trials[record.trialId]?.programHash ||
          record.feedback.some(item => item.jobId !== record.jobId || item.experimentId !== record.experimentId ||
            item.iteration !== record.authoring.iteration || !item.trajectoryRefs.includes(record.runId)) || state.runs[record.runId]?.manifestHash !== record.manifestHash ||
          owner.payload.kind === 'autoresearch' && record.jobId !== owner.id) throw new Error('Native feedback references are outside the trusted campaign trajectory')
        CampaignEvidence.resolve(state, {campaignId, experimentId: record.experimentId}).assert(record.feedback.flatMap(item => item.trajectoryRefs), 'Native procedural feedback')
        const phase = `native:feedback:${record.runId}:${record.observationId??record.cycleId}`, existing = owner.checkpoints[phase]
        if (existing && JSON.stringify(existing.data) !== JSON.stringify(record)) throw new Error('Native feedback checkpoint already contains different evidence')
        if (!existing) owner.checkpoints[phase] = ResearchDomain.JobCheckpoint.parse({phase, data: record, completedAt: new Date().toISOString()})
      }
    })
  }
  async recordAuthoring(origin: FeedbackOrigin, raw: Omit<CampaignPolicy.RecentAuthoringAttempt, 'jobId' | 'recordedAt'>) {
    const attempt = CampaignPolicy.RecentAuthoringAttempt.parse({...raw, jobId: origin.jobId, recordedAt: new Date().toISOString()})
    return this.options.store.mutate(this.options.projectId, state => {
      const campaignId = state.experiments[attempt.experimentId]?.campaignId
      if (!campaignId) throw new Error('Native authoring experiment is outside this project')
      assertOrigin(state, this.options.projectId, campaignId, origin)
      const owner = state.jobs[origin.jobId]!
      if (owner.payload.kind !== 'autoresearch' || owner.payload.experimentId !== attempt.experimentId) throw new Error('Native authoring job belongs to another experiment')
      const phase = `scientist:authoring:${attempt.iteration}:${attempt.attempt}`, prior = owner.checkpoints[phase]
      if (prior) {
        const {recordedAt: _prior, ...before} = CampaignPolicy.RecentAuthoringAttempt.parse(prior.data), {recordedAt: _now, ...after} = attempt
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native authoring checkpoint identity changed')
        return prior
      }
      const checkpoint = ResearchDomain.JobCheckpoint.parse({phase, data: attempt, completedAt: attempt.recordedAt})
      owner.checkpoints[phase] = checkpoint; return checkpoint
    })
  }
}
