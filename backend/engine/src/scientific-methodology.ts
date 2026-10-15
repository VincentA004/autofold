import {ResearchDomain} from '@autofold/science-core/domain'
import type {ResearchState} from '@autofold/science-core/store'
import type {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import type {ResearchWorkflow} from '@autofold/science-core/workflow'
import {TrialReasoning} from '@autofold/science-core/trial-reasoning'
import {CampaignEvidence} from '@autofold/science-core/campaign-evidence'
import {ResearchQuestions} from '@autofold/science-core/research-questions'
import {ExperimentBranches} from '@autofold/science-core/experiment-branches'
import {ProspectiveMeasurement} from '@autofold/science-core/prospective-measurement'

export type MethodologyProfile = 'managed_strict' | 'human_explicit' | 'historical'
export interface MethodologyDeclaration {decisionPlan?:unknown;prediction?:unknown;evidenceRefs?:unknown;replicateOfTrialId?:string;calibrationClass?:unknown}
export interface MethodologyInput {
  state:ResearchState;experiment:ResearchDomain.Experiment;profile:MethodologyProfile;evaluation:boolean
  declaration:MethodologyDeclaration;pipeline?:ExecutionProtocol.PipelinePolicy;tools?:ResearchWorkflow.Tool[]
  repetition?:{configurationFamilyFingerprint?:string;workflowFingerprint?:string;generatorPortfolio?:string[]}
}
/** Pure scientific-methodology admission shared by native scientist and human authoring.
 * Profiles describe requirements, never grant execution or relax supplied evidence claims. */
export function validateScientificMethodology(input:MethodologyInput) {
  if(input.profile==='historical')throw new Error('Historical methodology is a frozen-record profile; fresh authoring cannot use it as an admission bypass')
  const {state,experiment,declaration}=input,campaignId=experiment.campaignId
  const decisionPlan=declaration.decisionPlan===undefined?undefined:TrialReasoning.parseDecisionPlan(declaration.decisionPlan)
  const prediction=declaration.prediction===undefined?undefined:TrialReasoning.Prediction.parse(declaration.prediction)
  const evidenceRefs=declaration.evidenceRefs===undefined?undefined:TrialReasoning.EvidenceRefs.parse(declaration.evidenceRefs)
  const calibrationClass=declaration.calibrationClass===undefined?undefined:ResearchDomain.Trial.shape.calibrationClass.parse(declaration.calibrationClass)
  const catalog=CampaignEvidence.resolve(state,{campaignId,experimentId:experiment.id})
  catalog.assert(evidenceRefs??[],'Native trial evidence')
  const priorEvidenceCount=[...catalog.ids()].filter(id=>!['campaign','charter','experiment','skill_version','job'].includes(catalog.get(id)!.kind)).length
  TrialReasoning.validateDecisionPlan(decisionPlan,{...catalog,size:priorEvidenceCount},experiment.contract.budget.gpuHours,input.evaluation&&input.profile==='managed_strict')
  const prospective=decisionPlan?.researchRequest
  if(prospective&&!['reference','reopen'].includes(prospective.action??'')){
    if(!prospective.purpose)throw new Error('decision_plan.researchRequest.purpose: newly authored requests require empirical_test or knowledge_lookup; historical stored requests are preserved')
    if(prospective.prerequisiteBranchId){const branch=state.experimentBranches[prospective.prerequisiteBranchId]
      if(!branch||branch.experimentId!==experiment.id||branch.campaignId!==campaignId||branch.contractHash!==experiment.contractHash||branch.status==='retired'||ExperimentBranches.hash(branch.program)!==branch.programHash)
        throw new Error('decision_plan.researchRequest.prerequisiteBranchId: must bind an intact, non-retired branch in this frozen experiment')}
  }
  ResearchQuestions.validateReference(prospective,ResearchQuestions.project(Object.values(state.searchObservations).filter(value=>value.campaignId===campaignId),Object.values(state.knowledgeCycles),Object.values(state.researchRequests).filter(value=>value.campaignId===campaignId)),experiment.id)
  if(decisionPlan?.measurement){if(!input.pipeline)throw new Error('Prospective measurement requires a compiled scientific workflow');ProspectiveMeasurement.validate(decisionPlan.measurement,input.pipeline,input.tools??[])}
  if(prediction){const comparator=state.trials[prediction.comparatorTrialId]
    if(comparator?.experimentId!==experiment.id||!Object.values(state.evaluations).some(value=>value.trialId===comparator.id&&value.valid&&value.score!==null))
      throw new Error('Prediction comparator must have a valid locked evaluation in this experiment. For an unmeasured first baseline, omit optional ProtoTrial.prediction or set it to Python None; retain the falsifiable hypothesis and decision_plan.')}
  if(declaration.replicateOfTrialId&&state.trials[declaration.replicateOfTrialId]?.experimentId!==experiment.id)throw new Error('Replicate trial is outside this frozen experiment')
  if(input.evaluation&&input.repetition&&(input.profile==='managed_strict'||decisionPlan))TrialReasoning.requireReplicationPurpose(decisionPlan,TrialReasoning.repeatedCandidates(Object.values(state.searchObservations).filter(value=>value.experimentId===experiment.id),input.repetition,experiment.id))
  return {decisionPlan,prediction,evidenceRefs,calibrationClass,replicateOfTrialId:declaration.replicateOfTrialId,methodologyProfile:input.profile}
}
