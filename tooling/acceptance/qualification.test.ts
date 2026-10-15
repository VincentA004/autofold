import {expect, test} from 'bun:test'
import {nativeCases, oracleCases, recoveryPolicyCases, qualifyRecovery, requiredScenarios, selectPhaseCases, type ScenarioReport} from './contract'

function proof() {
  return {
    exitCode: 0, sourceBefore: 'same', sourceAfter: 'same',
    cases: [...oracleCases, ...nativeCases, ...recoveryPolicyCases, ...requiredScenarios.map(id => id + ': original result recovered and continued')].map(name => ({name, status: 'passed'})),
    reports: requiredScenarios.map(id => {
      const unknown = id === 'recovery.unknown-billing-holds', cancelled = id === 'recovery.cancel-holds', held = unknown || cancelled
      const proofLevel = unknown ? 'public_workflow_hold' : 'native_cpu_public_workflow'
      const holdProof = {unusedAuthority: {trajectories: 1, remainingMilliseconds: 60000, reportedUsd: unknown ? null : .5, estimatedUsd: .5}, ...(unknown ? {reportedAllowanceBeforeUnknownUsd: .5} : {}),
        originalChildAuthority: {id: 'active', sessionId: 'session', effectiveCostCeilingUsd: .5, turnsRemaining: 9, toolCallsRemaining: 9, deadlineMs: Date.parse('2026-01-01T00:01:00Z'), estimatedDeltaUsd: .01, reportedDeltaUsd: unknown ? null : .01},
        quiescence: {from: '2026-01-01T00:00:03Z', through: '2026-01-01T00:00:06Z', durationMs: 3000, responsiveObservations: 4, requestsAfterHold: 0, startsAfterHold: 0}, explicitHoldReason: 'Public authority hold',
        ...(unknown ? {externalRequestId: 'provider', publicRequestId: 'request', upstreamRequestId: 'provider', reportedCostUsd: null, requestStatus: 'unknown', retainedSdkEstimateUsd: .001, zeroScientificEffects: true} : {
          originalRunId: 'run', activeRunId: 'active_run', originalJobId: 'original', activeJobId: 'active', originalManifestSha256: 'sha256:' + 'a'.repeat(64), publicRevocation: {operationId: 'operation', cancelledAt: '2026-01-01T00:00:03Z'}, terminalLineageJobIds: ['original', 'active'], terminalEffectRunIds: ['run', 'active_run'], activeInputPreserved: true,
        })}
      return {id, status: 'passed', proofLevel, evidence: {directory: '/retained-evidence/' + id}, observations: {
      initialJobId: 'original', interruptedRunId: 'run', faultAt: '2026-01-01T00:00:00Z', originalWorkerExitAt: '2026-01-01T00:00:01Z', restartAt: '2026-01-01T00:00:02Z',
      quiescentAfterCompletion: true, quietWindowMs: 3000,
      ...(unknown ? {heldJobCheckpointsStable: true, holdMetadataQuietWindowMs: 6000} : {}),
      ...(id === 'recovery.partial-batch-continues' ? {sameOriginalChildResumed: true, originalAuthorizationPreserved: true} : {}),
      verdict: {passed: true, failures: [], ...(held ? {profile: unknown ? 'unknown_billing_hold' : 'cancelled_lineage', proofLevel, holdProof} : {}), counts: {workerStarts: unknown ? 0 : id === 'recovery.partial-batch-continues' ? 3 : 2, successfulRuns: unknown ? 0 : cancelled ? 1 : id === 'recovery.partial-batch-continues' ? 3 : 2, providerRequests: unknown ? 1 : 8, providerInvoices: unknown ? 1 : 8}},
    }}}) as ScenarioReport[],
  }
}
test('qualification requires every named proof and never authorizes live trials', () => {
  expect(qualifyRecovery(proof())).toMatchObject({passed: true, liveTrialsAuthorized: false})
})
for (const [name, mutate] of [
  ['missing scenario report', (input: ReturnType<typeof proof>) => {input.reports.pop()}],
  ['blocked prerequisite', (input: ReturnType<typeof proof>) => {input.reports[0]!.status = 'blocked'}],
  ['skipped scenario', (input: ReturnType<typeof proof>) => {input.cases.at(-1)!.status = 'skipped'}],
  ['missing negative control', (input: ReturnType<typeof proof>) => {input.cases.splice(1, 1)}],
  ['missing factual recovery handoff regression', (input: ReturnType<typeof proof>) => {input.cases = input.cases.filter(test => test.name !== recoveryPolicyCases.at(-1))}],
  ['skipped factual recovery handoff regression', (input: ReturnType<typeof proof>) => {input.cases.find(test => test.name === recoveryPolicyCases.at(-1))!.status = 'skipped'}],
  ['source drift', (input: ReturnType<typeof proof>) => {input.sourceAfter = 'changed'}],
  ['failed test process', (input: ReturnType<typeof proof>) => {input.exitCode = 1}],
  ['passing label without independent evidence', (input: ReturnType<typeof proof>) => {input.reports[0]!.observations = {}}],
  ['worker already finished before fault', (input: ReturnType<typeof proof>) => {input.reports.find(report => report.id === 'recovery.restart-continues')!.observations.originalWorkerExitAt = '2025-01-01T00:00:00Z'}],
  ['completion without quiescence', (input: ReturnType<typeof proof>) => {input.reports[0]!.observations.quiescentAfterCompletion = false}],
  ['partial batch replaced by a fresh child', (input: ReturnType<typeof proof>) => {input.reports.find(report => report.id === 'recovery.partial-batch-continues')!.observations.sameOriginalChildResumed = false}],
  ['partial batch original authorization reset', (input: ReturnType<typeof proof>) => {input.reports.find(report => report.id === 'recovery.partial-batch-continues')!.observations.originalAuthorizationPreserved = false}],
  ['an unchanged hold that reacquires recovery authority', (input: ReturnType<typeof proof>) => {input.reports.find(report => report.id === 'recovery.unknown-billing-holds')!.observations.heldJobCheckpointsStable = false}],
] as const) test('qualification rejects ' + name, () => {
  const input = proof(); mutate(input); expect(qualifyRecovery(input).passed).toBe(false)
})

test('phase selection excludes only registered tests deliberately filtered into another phase', () => {
  const baseline = {name: 'recovery.baseline-completes: normal workflow', status: 'passed'}
  const fault = {name: 'recovery.restart-continues: actual outage', status: 'skipped'}
  expect(selectPhaseCases([baseline, fault], '^recovery\\.baseline-completes:')).toEqual([baseline])
  expect(selectPhaseCases([{...baseline, status: 'skipped'}, fault], '^recovery\\.baseline-completes:')[0]?.status).toBe('skipped')
  expect(() => selectPhaseCases([baseline, {...fault, status: 'passed'}], '^recovery\\.baseline-completes:')).toThrow('Unexpected unselected')
  expect(() => selectPhaseCases([baseline, {name: 'unknown skipped obligation', status: 'skipped'}], '^recovery\\.baseline-completes:')).toThrow('Unexpected unselected')
})

for (const [name, id, mutate] of [
  ['hold caused by exhausted authority', 'recovery.cancel-holds', (proof: any) => {proof.unusedAuthority.trajectories = 0}],
  ['hold without responsive observation', 'recovery.unknown-billing-holds', (proof: any) => {proof.quiescence.responsiveObservations = 0}],
  ['new work during a hold', 'recovery.cancel-holds', (proof: any) => {proof.quiescence.requestsAfterHold = 1}],
  ['unknown bill concealed as a free request', 'recovery.unknown-billing-holds', (proof: any) => {proof.retainedSdkEstimateUsd = 0}],
  ['unknown bill assigned a known remaining balance', 'recovery.unknown-billing-holds', (proof: any) => {proof.unusedAuthority.reportedUsd = .5}],
  ['unknown request without its public identity', 'recovery.unknown-billing-holds', (proof: any) => {delete proof.publicRequestId}],
  ['cancelled lineage with a live effect', 'recovery.cancel-holds', (proof: any) => {proof.terminalEffectRunIds.pop()}],
  ['cancellation without public revocation', 'recovery.cancel-holds', (proof: any) => {delete proof.publicRevocation}],
  ['hold caused by an exhausted child turn ceiling', 'recovery.unknown-billing-holds', (proof: any) => {proof.originalChildAuthority.turnsRemaining = 0}],
  ['hold without its original child authority', 'recovery.cancel-holds', (proof: any) => {delete proof.originalChildAuthority}],
] as const) test('qualification rejects ' + name, () => {
  const input = proof(), report = input.reports.find(report => report.id === id)!
  mutate((report.observations.verdict as {holdProof: unknown}).holdProof)
  expect(qualifyRecovery(input).passed).toBe(false)
})
