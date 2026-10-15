import type {ScientistLaneOptions} from './index'
import type {ResearchStore} from '@autofold/science-core/store'
import type {ResearchDomain} from '@autofold/science-core/domain'
import {CampaignResources} from '@autofold/science-core/campaign-resources'

type BudgetOptions=Pick<ScientistLaneOptions,'origin'|'projectId'|'evaluationBaseline'|'maximumEvaluations'|'allowCompute'|'allowScientificStop'>

/** Read-only grant projection. Jobs and execution remain the admission authorities. */
export function parentAuthorization(options:BudgetOptions,state: Awaited<ReturnType<ResearchStore['read']>>) {
    const current = options.origin?.jobId && state.jobs[options.origin.jobId]
    if (!current) return null
    let parent = current, visited = new Set<string>()
    while (typeof parent.payload.parentJobId === 'string') {
      if (visited.has(parent.id)) throw new Error('Cyclic scientist parent job ownership')
      visited.add(parent.id)
      const next = state.jobs[parent.payload.parentJobId]
      if (!next || next.projectId !== options.projectId) throw new Error('Scientist parent job ownership changed')
      parent = next
      if (parent.payload.kind === 'campaign_loop') break
    }
    if (parent.payload.kind !== 'campaign_loop') return null
    const start = parent.checkpoints['campaign:job:start']?.data ?? parent.payload
    const aggregateGrant = Number(start.maximumTrajectories ?? parent.payload.maximumTrajectories)
    const discoveryGrant = Number(start.maximumDiscoveryTrajectories ?? parent.payload.maximumDiscoveryTrajectories ?? aggregateGrant)
    const replayGrant = Number(start.reservedReplayTrajectories ?? parent.payload.reservedReplayTrajectories ?? 0)
    if (![aggregateGrant,discoveryGrant,replayGrant].every(value => Number.isInteger(value) && value >= 0)) return null
    let consumed = 0, discoveryConsumed = 0, replayConsumed = 0
    const settledChildren = new Set<string>()
    for (const [phase,checkpoint] of Object.entries(parent.checkpoints)) {
      if (!/^campaign:step:\d+:completed$/.test(phase)) continue
      const step = checkpoint.data as any, count = Number(step.consumedTrajectories ?? 0)
      if (!Number.isInteger(count) || count < 0) throw new Error('Invalid immutable campaign consumption')
      consumed += count
      discoveryConsumed += Number(step.consumedDiscoveryTrajectories ?? (step.proposal?.kind === 'iterate_experiment' ? count : 0))
      replayConsumed += Number(step.consumedReplayTrajectories ?? (['refine_skill','replay_skill'].includes(step.proposal?.kind) ? count : 0))
      if (step.result?.jobId) settledChildren.add(step.result.jobId)
      if (step.result?.replayJobId) settledChildren.add(step.result.replayJobId)
    }
    let activeDiscovery = 0, activeReplay = 0
    for (const child of Object.values(state.jobs).filter(job => job.payload.parentJobId === parent.id && !settledChildren.has(job.id))) {
      const terminal = ['succeeded','failed','cancelled'].includes(child.status)
      const actual = Object.values(state.trials).filter(trial => trial.origin?.jobId === child.id).length
      const reported = Number(child.result?.consumedTrajectories ?? 0)
      const admitted = child.payload.kind === 'autoresearch' && (!child.payload.conversation || child.payload.allowCompute === true) ? Number(child.payload.iterations)
        : child.payload.kind === 'skill_shadow_replay' ? 2 * Number(child.payload.repetitions) : 0
      const charged = terminal ? Math.max(actual,reported) : Math.max(actual,Number.isFinite(admitted) ? admitted : 0)
      if (child.payload.kind === 'autoresearch') activeDiscovery += charged
      if (child.payload.kind === 'skill_shadow_replay') activeReplay += charged
    }
    const aggregateResidual = Math.max(0,aggregateGrant-consumed-activeDiscovery-activeReplay)
    const replayResidual = Math.min(aggregateResidual,Math.max(0,replayGrant-replayConsumed-activeReplay))
    const ordinaryResidual = Math.max(0,Math.min(discoveryGrant-discoveryConsumed-activeDiscovery,aggregateResidual-replayResidual))
    return {jobId:parent.id, aggregateGrant, ordinaryGrant:discoveryGrant, reservedReplayGrant:replayGrant,
      consumedTrajectories:consumed, consumedOrdinaryTrajectories:discoveryConsumed, consumedReplayTrajectories:replayConsumed,
      activeOrdinaryAdmissions:activeDiscovery, activeReplayAdmissions:activeReplay,
      remainingTrajectories:aggregateResidual, remainingOrdinaryTrajectories:ordinaryResidual, remainingReservedReplayTrajectories:replayResidual,
      discoveryBatchSize:Number(start.discoveryBatchSize ?? parent.payload.discoveryBatchSize ?? 2),
      accounting:'original_parent_grants_minus_immutable_completed_steps_and_unsettled_owned_admissions',
      guidance:'The host renews batches from residual parent authorization. Exhausting the current batch returns control to the host; never call stop_discovery for an allowance boundary. Residual authorization does not enlarge the current batch.'}
  }
export function scientistBudgets(options:BudgetOptions,requests:number,completedEvaluations:number,state: Awaited<ReturnType<ResearchStore['read']>>, experiment: ResearchDomain.Experiment) {
    const baseline = options.evaluationBaseline ?? 0
    const reserved = requests
    const computeAuthorized = options.allowCompute !== false
    const trialCount = Object.values(state.trials).filter(trial => state.experiments[trial.experimentId]?.campaignId === experiment.campaignId).length
    const maximumTrials = state.campaignCharters[experiment.campaignId]?.constraints.maximumCampaignTrials ?? null
    return {
      completion:{scientificStopAuthorized:options.allowScientificStop!==false,
        authority:options.allowScientificStop===false?'host_fixed_protocol':'evidence_supported_scientist_condition',
        batchExhaustion:'host_settles_and_renews_residual_authorization',
        guidance:options.allowScientificStop===false?'The host owns completion of this fixed protocol; continue within the granted bounds. No scientist tool can permanently stop it. Hard resource bounds, cancellation and unresolved effects remain binding.':'Only canonical settled scientific evidence can support an experiment stop; scheduling bounds never establish scientific completion.'},
      perTrial: {...experiment.contract.budget, accounting: 'frozen_ceiling_per_evaluation'},
      currentJob: {jobId: options.origin?.jobId, computeAuthorized, baselineCompletedEvaluations: baseline,
        maximumEvaluations: options.maximumEvaluations - baseline,
        completedEvaluations: Math.max(0, completedEvaluations - baseline),
        reservedEvaluations: Math.max(0, reserved - baseline),
        remainingEvaluations: computeAuthorized ? Math.max(0, options.maximumEvaluations - reserved) : 0,
        accounting: 'durable_requests_include_pending_and_failed_evaluations'},
      parentCampaign: parentAuthorization(options,state),
      campaign: {maximumTrials, trialCount, remainingTrials: maximumTrials === null ? null : Math.max(0, maximumTrials - trialCount),
        ...CampaignResources.summarize(state, experiment.campaignId)},
      guidance: 'Current job authorization, per-trial ceilings and campaign admission limits must all admit a new evaluation. Prior job iteration limits do not exhaust renewed authorization. Pending requests reconcile under their existing identity. Only evidence-supported scientific stops pause the experiment. Exhausting a batch returns control to the host, which can renew residual parent authorization. Advisory questions and historical research yields do not block independent discovery, consume empirical slots or authorize compute.',
    }
  }
