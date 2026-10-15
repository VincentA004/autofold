import {operationHash} from '../../backend/science-core/src/research/operations'

/** Pure validation policy shared by the operator and the offline host-loop gate.
 * No admission, persistence, provider calls or scientific effects occur here. */
export interface DiscoveryMemoryProofInput {
 projectId:string;followup:any;state:any;sessions:{journal:any[]};parents:any[];parentRuns:any[]
 inferenceContexts:any[];temperature:number;requestId?:string;toolCallId?:string
 toolName?:'validate_trial'|'evaluate_trial'
}
export function auditDiscoveryMemoryProof(input:DiscoveryMemoryProofInput){
 const {projectId,followup,state,sessions,parents,parentRuns,inferenceContexts,temperature,requestId,toolCallId}=input
 const toolName=input.toolName??'evaluate_trial'
  const exposure=followup.decisionMemoryExposure,sessionId=String(state.jobs[followup.origin?.jobId??'']?.payload.sessionId??''),trace=sessions.journal.filter((event:any)=>event.sessionId===sessionId)
  const run:any=Object.values(state.runs).find((item:any)=>item.trialId===followup.id)
  const start:any=trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName===toolName&&event.data?.args?.requestId===requestId&&(!toolCallId||event.data?.toolCallId===toolCallId))
  const assistant:any=start&&trace.findLast((event:any)=>event.sequence<start.sequence&&event.type==='message_end'&&event.data?.message?.role==='assistant'&&event.data.message.content.some((part:any)=>part.type==='toolCall'&&part.id===start.data.toolCallId&&part.name===toolName))
  const settled:any=assistant&&trace.findLast((event:any)=>event.sequence<assistant.sequence&&event.type==='model_request_settled')
  const inference=settled&&inferenceContexts.find(context=>context.sessionId===sessionId&&context.requestId===settled.data?.requestId&&context.settledSequence===settled.sequence)
  const delivered=exposure&&inference?.packets.find((item:any)=>item.packetHash===exposure.packetHash&&'sha256:'+operationHash(item.packet)===exposure.packetHash&&item.manifestVerification.status==='verified'&&item.manifestVerification.manifestHash===exposure.manifestHash&&item.manifestVerification.snapshotHash===exposure.snapshotHash&&item.packet.sourceManifest.manifestHash===exposure.manifestHash&&item.packet.sourceManifest.snapshotHash===exposure.snapshotHash&&operationHash(item.packet.sourceManifest.scope)===operationHash(exposure.scope)&&parentRuns.every(parent=>parent&&item.packet.facts.some((fact:any)=>fact.runId===parent.id&&fact.receiptStatus==='verified'&&fact.receiptHash===parent.manifestHash)))
  const latest:any=start&&trace.filter((event:any)=>event.type==='model_request_settled'&&event.sequence<start.sequence).at(-1)
  const currentExperiment=state.experiments[followup.experimentId],memoryDeliveryBound=!!delivered&&!!exposure&&exposure.sessionId===sessionId&&inference?.sessionId===exposure.sessionId&&latest?.data?.requestId===inference?.requestId&&exposure.scope.projectId===projectId&&exposure.scope.experimentId===followup.experimentId&&exposure.scope.campaignId===currentExperiment?.campaignId
  const citedParents=parentRuns.filter(parent=>parent&&[...followup.evidenceRefs??[],...followup.decisionPlan?.evidenceRefs??[]].includes(parent.id)&&exposure?.citedSources.some((source:any)=>source.id===parent.id))
  const declarationBound=!!exposure&&exposure.decisionHash==='sha256:'+operationHash({decisionPlan:followup.decisionPlan,evidenceRefs:followup.evidenceRefs})
  const parentsPrecedeFollowup=parentRuns.length===2&&parentRuns.every(parent=>parent&&Number.isFinite(Date.parse(parent.completedAt!))&&Date.parse(parent.completedAt!)<Date.parse(followup.createdAt))
  const temperatureDeclaration=!!followup.decisionPlan?.changedVariables?.some((variable:any)=>/temperature/i.test(variable))&&!!followup.prediction&&parents.some(parent=>parent.id===followup.prediction?.comparatorTrialId)&&followup.prediction.metric==='locked_score'&&['lower','higher'].includes(followup.prediction.relation)
  const temperatureProtocolBound=[0.05,0.2].includes(temperature)
  return {trialId:followup.id,runId:run?.id,sessionId,decisionToolName:toolName,evaluateToolCallId:start?.data?.toolCallId,assistantSequence:assistant?.sequence,settledSequence:settled?.sequence,inferenceRequestId:inference?.requestId,transcriptHash:inference?.transcriptHash,packetHash:delivered?.packetHash,manifestVerification:delivered?.manifestVerification,parentsPrecedeFollowup,parentRunIds:parentRuns.map(item=>item?.id),exposure,memoryDeliveryBound,citedParentRunIds:citedParents.map(item=>item!.id),declarationBound,temperatureDeclaration,temperatureProtocolBound,actualTemperature:temperature,
   passed:parentsPrecedeFollowup&&memoryDeliveryBound&&citedParents.length>0&&declarationBound&&temperatureDeclaration&&temperatureProtocolBound&&temperature!==0.1,
   interpretation:'Each followup is bound to the exact evaluate call and preceding settled model response, full delivered packet containing both verified parents, prospective citation and actual temperature intervention. This feedback trace is not causal improvement evidence.'}
}

/** Reject authored metadata before it can acquire immutable scientific identity. */
export function requireDiscoveryMemoryProof(input:DiscoveryMemoryProofInput) {
 const proof=auditDiscoveryMemoryProof(input)
 if(!proof.passed)throw new Error(JSON.stringify({category:'prospective_protocol',stage:'authoring',scientificEffects:'none',
  failedChecks:{parentsPrecedeFollowup:!proof.parentsPrecedeFollowup,memoryDeliveryBound:!proof.memoryDeliveryBound,
   baselineCitation:proof.citedParentRunIds.length===0,declarationBound:!proof.declarationBound,
   temperatureDeclaration:!proof.temperatureDeclaration,temperatureProtocolBound:!proof.temperatureProtocolBound},
  requiredBaselineRunIds:input.parentRuns.map(run=>run?.id),allowedComparatorTrialIds:input.parents.map(trial=>trial.id),
  allowedTemperatures:[0.05,0.2],repair:'Keep the native draft. If delivery attribution is missing, call read_decision_memory selecting both baseline run IDs before the next ordinary inference. Cite a baseline run, choose an allowed baseline comparatorTrialId, and declare temperature in changedVariables with a prospective prediction. Edit and validate this draft again; no trial or run was created.'}))
 return proof
}
