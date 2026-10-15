/** Named obligations for this recovery slice. This is not a live-discovery qualification. */
export const recoveryScenarios = ['recovery.restart-continues', 'recovery.suspension-continues', 'recovery.partial-batch-continues'] as const
export const positiveScenarios = ['recovery.baseline-completes', ...recoveryScenarios] as const
export const heldScenarios = ['recovery.cancel-holds', 'recovery.unknown-billing-holds'] as const
export const requiredScenarios = [...positiveScenarios, ...heldScenarios] as const
export type TestCase = {name: string; status: string}
/** Bun includes pattern-filtered tests as skipped in raw JUnit. Only another
 * registered phase's deliberately unselected tests may be excluded here. */
export function selectPhaseCases(cases: TestCase[], pattern?: string): TestCase[] {
  if (!pattern) return cases
  const expression = new RegExp(pattern)
  return cases.filter(test => {
    if (expression.test(test.name)) return true
    if (test.status !== 'skipped' || !requiredScenarios.some(id => test.name.startsWith(id + ':'))) {
      throw Error('Unexpected unselected test in phase: ' + test.name)
    }
    return false
  })
}
export const nativeCases = [
  'native containment starts the provisioned framework Python before inspecting authored code',
  'a running native Python can use scratch but cannot read secrets, write outside, connect, or execute a shell',
  'native inspection imports the selected packages while neighboring source secrets remain unreadable',
] as const
/** Required deterministic interleavings complement the public fault profiles. */
export const recoveryPolicyCases = [
  'unchanged original accounting holds stay responsive without reacquiring parent or child ownership',
  'a verified saved original provider receipt wakes an unchanged held job automatically',
  ...['deadline', 'cancel', 'inactive'].map(change => `${change} invalidates an unchanged accounting hold without a new request`),
  'an unchanged held root does not starve a later independent recovery queue',
  'an active physical worker receipt is still observed before an accounting hold can quiesce',
  'strict reported-billing failure with terminal delivery remains unchanged after one factual recovery',
  'strict unknown billing observes a passed original deadline once then remains a truthful stable hold',
  'scope changes during the factual recovery handoff remain observable without another model request',
  'an original deadline crossing during the factual recovery handoff remains observable without another model request',
  'a verified original receipt arriving during the factual recovery handoff resumes only the original remaining allowance',
] as const
export const heldOracleCases = [
  'held oracle accepts an externally revoked active lineage with preserved scientific evidence',
  'held oracle accepts one retained unknown invoice with zero scientific effects',
  ...['third worker after cancellation', 'inference after cancellation acknowledgement', 'missing public root revocation',
    'cancelled effect has no physical exit', 'rewritten frozen active program', 'lost observed partial bytes',
    'nonterminal cancelled lineage operation', 'active child exhausted its original cost ceiling'].map(name => 'held oracle rejects corrupted cancellation: ' + name),
  ...['unknown request loses positive SDK estimate', 'unknown hold creates an unexecuted trial', 'quiet controller is stopped',
    'no relevant accounting hold', 'hold only stops because its grant expired'].map(name => 'held oracle rejects corrupted unknown hold: ' + name),
  'cancellation collector preserves complete observed partial bytes independently of later output changes',
  'cancellation collector rejects escaped inputs or partial output symlinks',
  'cancellation collector rejects substituted frozen scientific identity',
] as const
export const oracleCases = [
  ...heldOracleCases,
  'independent oracle accepts an externally complete recovery and continuation trace',
  'independent oracle accepts an explicit unknown-billing hold without new execution',
  ...['duplicate worker execution', 'lost original result', 'wrong manifest bytes', 'missing manifest',
    'receipt-only recovery without continuation', 'partial completion', 'cost reset',
    'unknown billing concealed as zero', 'invoice credited twice', 'invoice amount changed',
    'orphan proposal', 'SDK total drops retained estimates',
    'unknown bill followed by effects despite final hold', 'provider fixture failed', 'zero wire authoring', 'unknown invoice loses public request',
    'missing result file', 'wrong linked artifact bytes', 'forged success with invalid result',
    'forged success with nonfinite score', 'forged success with empty candidates']
    .map(name => 'oracle rejects corrupted trace: ' + name),
  'real Pi SDK serializes tool context, parses fragmented HTTP SSE and records independent invoices before reply',
  'wire provider represents missing billing as unknown, never free usage',
  'artifact collector reads independently bound scientific files and generation links',
  'artifact collector rejects a missing scientific result file',
  'artifact collector rejects linked path traversal and escaping symlinks',
  'artifact collector rejects a substituted manifest scientific identity',
] as const

export type ScenarioReport = {
  id: string; status: 'passed' | 'failed' | 'blocked'; proofLevel: string
  evidence: {directory?: string}; observations: Record<string, unknown>
}
export function qualifyRecovery(input: {
  exitCode: number; cases: {name: string; status: string}[]; reports: ScenarioReport[]
  sourceBefore: string; sourceAfter: string
}) {
  const failures: string[] = []
  if (input.exitCode !== 0) failures.push('Test process did not exit successfully')
  if (input.sourceBefore !== input.sourceAfter) failures.push('Source or test inventory changed during qualification')
  if (input.cases.some(test => test.status !== 'passed')) failures.push('A required suite contains skipped, failed or errored tests')
  for (const name of [...nativeCases, ...oracleCases, ...recoveryPolicyCases]) {
    if (!input.cases.some(test => test.name === name && test.status === 'passed')) failures.push('Missing required prerequisite proof: ' + name)
  }
  for (const id of requiredScenarios) {
    const held = (heldScenarios as readonly string[]).includes(id)
    const unknownBilling = id === 'recovery.unknown-billing-holds'
    const reports = input.reports.filter(report => report.id === id)
    const proofLevel = unknownBilling ? 'public_workflow_hold' : 'native_cpu_public_workflow'
    if (reports.length !== 1 || reports[0]?.status !== 'passed' || reports[0].proofLevel !== proofLevel || !reports[0].evidence.directory) {
      failures.push('Missing successful native public-workflow proof: ' + id)
    }
    const facts = reports[0]?.observations
    if (!held && (facts?.quiescentAfterCompletion !== true || typeof facts.quietWindowMs !== 'number' || facts.quietWindowMs < 3000)) {
      failures.push('Completed authorization did not demonstrate quiescence: ' + id)
    }
    const verdict = facts?.verdict as {passed?: boolean; failures?: unknown[]; profile?: string; proofLevel?: string; holdProof?: Record<string, any>; counts?: {workerStarts?: number; successfulRuns?: number; providerRequests?: number; providerInvoices?: number}} | undefined
    const requestedResults = id === 'recovery.partial-batch-continues' ? 3 : 2
    const nativeCounts = unknownBilling ? verdict?.counts?.workerStarts === 0 && verdict.counts.successfulRuns === 0 : held ? verdict?.counts?.workerStarts === 2 && [1, 2].includes(verdict.counts.successfulRuns ?? 0) : verdict?.counts?.workerStarts === requestedResults && verdict.counts.successfulRuns === requestedResults
    if (!verdict?.passed || verdict.failures?.length !== 0 || !nativeCounts ||
        !Number.isInteger(verdict?.counts?.providerRequests) || (verdict?.counts?.providerRequests ?? 0) <= 0 || verdict?.counts?.providerInvoices !== verdict?.counts?.providerRequests) {
      failures.push('Missing independent end-state verdict: ' + id)
    }
    if (held) {
      const proof = verdict?.holdProof, authority = proof?.unusedAuthority, quiet = proof?.quiescence, child = proof?.originalChildAuthority
      const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
      const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
      const time = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
      if (verdict?.profile !== (unknownBilling ? 'unknown_billing_hold' : 'cancelled_lineage') || verdict.proofLevel !== proofLevel || !text(proof?.explicitHoldReason) ||
          !positive(authority?.trajectories) || !(unknownBilling ? authority?.reportedUsd === null && positive(proof?.reportedAllowanceBeforeUnknownUsd) : positive(authority?.reportedUsd)) || !positive(authority?.estimatedUsd) || !positive(authority?.remainingMilliseconds) ||
          !quiet || !positive(quiet.durationMs) || quiet.durationMs < 3000 || !time(quiet.from) || !time(quiet.through) || Date.parse(quiet.through) - Date.parse(quiet.from) < 3000 ||
          authority.remainingMilliseconds <= quiet.durationMs || !Number.isInteger(quiet.responsiveObservations) || quiet.responsiveObservations < 2 || quiet.requestsAfterHold !== 0 || quiet.startsAfterHold !== 0) {
        failures.push('Missing responsive hold with unused original authority: ' + id)
      }
      if (!text(child?.id) || !text(child?.sessionId) || !positive(child?.effectiveCostCeilingUsd) || !positive(child?.turnsRemaining) || !positive(child?.toolCallsRemaining) ||
          !positive(child?.deadlineMs) || !time(quiet?.through) || child.deadlineMs <= Date.parse(quiet.through) ||
          typeof child?.estimatedDeltaUsd !== 'number' || !Number.isFinite(child.estimatedDeltaUsd) || child.estimatedDeltaUsd < 0 || child.estimatedDeltaUsd >= child.effectiveCostCeilingUsd ||
          (unknownBilling ? child?.reportedDeltaUsd !== null : typeof child?.reportedDeltaUsd !== 'number' || !Number.isFinite(child.reportedDeltaUsd) || child.reportedDeltaUsd < 0 || child.reportedDeltaUsd >= child.effectiveCostCeilingUsd) ||
          !unknownBilling && child?.id !== proof?.activeJobId) {
        failures.push('Hold did not preserve an unexhausted original child grant: ' + id)
      }
      if (unknownBilling) {
        if (facts?.heldJobCheckpointsStable !== true || typeof facts.holdMetadataQuietWindowMs !== 'number' || facts.holdMetadataQuietWindowMs < 6000) {
          failures.push('An unchanged accounting hold keeps reacquiring recovery authority: ' + id)
        }
        if (verdict?.counts?.providerRequests !== 1 || verdict.counts.providerInvoices !== 1 || !text(proof?.externalRequestId) || !text(proof?.publicRequestId) ||
            proof?.upstreamRequestId !== proof?.externalRequestId || proof?.requestStatus !== 'unknown' || proof?.reportedCostUsd !== null || !positive(proof?.retainedSdkEstimateUsd) || proof?.zeroScientificEffects !== true) {
          failures.push('Unknown billing did not retain its request and prevent scientific effects: ' + id)
        }
      } else {
        if (proof?.originalJobId !== facts?.initialJobId || !text(proof?.activeJobId) || !text(proof?.originalRunId) || !text(proof?.activeRunId) || proof.originalRunId === proof.activeRunId ||
            !text(proof?.originalManifestSha256) || !/^(?:sha256:)?[a-f0-9]{64}$/.test(proof.originalManifestSha256) || !text(proof?.publicRevocation?.operationId) || !time(proof?.publicRevocation?.cancelledAt) || proof?.activeInputPreserved !== true ||
            !Array.isArray(proof?.terminalLineageJobIds) || ![proof.originalJobId, proof.activeJobId].every(id => proof.terminalLineageJobIds.includes(id)) ||
            !Array.isArray(proof?.terminalEffectRunIds) || ![proof.originalRunId, proof.activeRunId].every(id => proof.terminalEffectRunIds.includes(id))) {
          failures.push('Cancellation did not preserve evidence and revoke the complete active lineage: ' + id)
        }
      }
    }
    if (typeof facts?.initialJobId !== 'string') failures.push('Missing original campaign identity: ' + id)
    if (id === 'recovery.partial-batch-continues' && (facts?.sameOriginalChildResumed !== true || facts.originalAuthorizationPreserved !== true)) {
      failures.push('Original partial child and authorization were not preserved: ' + id)
    }
    if (id !== 'recovery.baseline-completes' && !unknownBilling && (typeof facts?.interruptedRunId !== 'string' ||
        ![facts.faultAt, facts.restartAt, facts.originalWorkerExitAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ||
        !(Date.parse(facts.originalWorkerExitAt as string) > Date.parse(facts.faultAt as string) && Date.parse(facts.originalWorkerExitAt as string) < Date.parse(facts.restartAt as string)))) {
      failures.push('Missing proof that original worker finished during controller outage: ' + id)
    }
    if (!input.cases.some(test => test.name.startsWith(id + ':') && test.status === 'passed')) failures.push('Missing executed scenario: ' + id)
  }
  return {passed: failures.length === 0, scope: 'offline_recovery_slice', liveTrialsAuthorized: false, failures}
}
