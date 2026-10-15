import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { ResearchService } from '@autofold/science-core/service';
import { ResearchJobService } from '@autofold/science-core/job-service';
import { Application } from '../application';
import { DEFAULT_MODEL } from '../runtime';
import { KnowledgeReviewController, freezeKnowledgeReviewGraph } from './index';
let fetchGuard: ReturnType<typeof spyOn>;
beforeEach(() => { fetchGuard = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('Offline reviewer tests prohibit network'); }) as unknown as typeof fetch); });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true }); fetchGuard.mockRestore(); });
const source = 'Matched assay controls limit mechanistic interpretations.';
const message = (calls: Array<{
    name: string;
    args: any;
}>): AssistantMessage => ({ role: 'assistant', content: calls.map((c, i) => ({ type: 'toolCall', id: 'call_' + i, name: c.name, arguments: c.args })), api: DEFAULT_MODEL.api, provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id, timestamp: Date.now(), stopReason: 'toolUse', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const scripted = (...values: AssistantMessage[]): StreamFn => { let i = 0; return () => { const value = values[i++]; if (!value)
    throw new Error('No further model turn allowed'); const out = createAssistantMessageEventStream(); out.push({ type: 'start', partial: value }); out.push({ type: 'done', reason: 'toolUse', message: value }); out.end(value); return out; }; };
async function fixture() {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-review-'));
    roots.push(workspace);
    const app = new Application({ workspace, projectId: 'review_offline', jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: () => { throw new Error('Unexpected offline model execution'); } } } }), campaign = await app.research.createCampaign(app.projectId, { objective: 'Independent source-grounded reconciliation' });
    await app.research.activateCampaign(app.projectId, campaign.id);
    const ingest = await app.research.ingestLiteratureReview(app.projectId, campaign.id, { generatedBy: 'independent-author', sources: [{ key: 's', database: 'pubmed', sourceId: '7', title: 'Matched controls', query: 'matched controls', excerpts: [source] }], claims: [{ kind: 'limitation', statement: 'Specificity remains assay-dependent.', stance: 'context', confidence: 0.6, evidence: [{ sourceKey: 's', excerpt: source }] }], unresolvedQuestions: [] });
    const claim = ingest.claims[0]!, literature = ingest.records[0]!, jobs = new ResearchJobService.Service(app.store);
    const queued = await app.jobs.enqueueKnowledgeReview(campaign.id, { claimIds: [claim.id], idempotencyKey: 'review' }), job = (await jobs.claim(app.projectId, 60000, { eligible: c => c.id === queued.id }))!;
    const lifecycle = { checkpoint: (phase: string, data: any) => jobs.checkpoint(app.projectId, job.id, job.leaseId!, phase, data), readCheckpoint: async (phase: string) => (await jobs.get(app.projectId, job.id)).checkpoints[phase]?.data, checkCancelled: async () => { await app.research.assertTrustedJobLease(app.projectId, { jobId: job.id, leaseId: job.leaseId! }); } };
    const input = { campaignId: campaign.id, jobId: job.id, sessionId: job.payload.sessionId, claimIds: [claim.id] }, origin = { jobId: job.id, leaseId: job.leaseId! };
    const proposal = { decisions: [{ id: claim.id, expectedHash: ResearchService.knowledgeRecordHash(claim), status: 'reviewed' as const, rationale: 'The frozen primary excerpt supports a bounded assay limitation.', evidenceRefs: [literature.id] }], campaignSummary: 'The claim is a supported source interpretation; physical specificity is unresolved.', unresolvedQuestions: ['Target-specific physical validation remains missing.'] };
    const controller = (streamFn: StreamFn) => new KnowledgeReviewController({ workspace, projectId: app.projectId, store: app.store, research: app.research, sessionDirectory: app.sessionDirectory, runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn } });
    const stream = () => scripted(message([{ name: 'read_knowledge', args: { id: literature.id } }]), message([{ name: 'submit_reconciliation', args: proposal }]));
    const raw = () => ({ ...proposal, operationId: job.id, reviewedBy: 'autofold-pi-knowledge-review/v1:' + createHash('sha256').update(app.projectId + ':' + job.id).digest('hex'), question: 'Review the original excerpt.', frozenRecords: [claim, literature].map(row => ({ id: row.id, expectedHash: ResearchService.knowledgeRecordHash(row) })) });
    return { app, campaign, claim, literature, job, jobs, lifecycle, input, origin, proposal, controller, stream, raw };
}
test('independent reviewer commits original frozen sources and preserves confidence; SQLite reopen does not call a model', async () => {
    const f = await fixture(), result = await f.controller(f.stream()).run(f.input, f.lifecycle, { origin: f.origin });
    const state = await f.app.store.read(f.app.projectId), updated = state.claims[f.claim.id]!;
    expect(updated.status).toBe('reviewed');
    expect(updated.confidence).toBe(f.claim.confidence);
    expect(updated.evidence).toEqual(f.claim.evidence);
    expect(updated.generated).toEqual(f.claim.generated);
    const audit = state.knowledgeCycles[result.cycleId]!.reviewAudit as any;
    expect(audit.decisions[0]).toMatchObject({ expectedHash: ResearchService.knowledgeRecordHash(f.claim), evidenceRefs: [f.literature.id], status: 'reviewed' });
    expect(audit.frozenRecords.find((r: any) => r.id === f.literature.id).expectedHash).toBe(ResearchService.knowledgeRecordHash(f.literature));
    expect(updated.reviewed?.by).not.toBe(f.claim.generated.by);
    const reopened = new Application({ workspace: f.app.workspace, projectId: f.app.projectId });
    expect((await reopened.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('reviewed');
    const retry = await f.controller(() => { throw new Error('Committed review cannot call model'); }).run(f.input, f.lifecycle, { origin: f.origin });
    expect(retry.cycleId).toBe(result.cycleId);
    expect(Object.values((await reopened.store.read(f.app.projectId)).knowledgeCycles)).toHaveLength(2);
});
test('changed original source rejects the complete atomic review even when claim snapshot is unchanged', async () => {
    const f = await fixture(), raw = f.raw();
    await f.app.store.mutate(f.app.projectId, state => { state.literature[f.literature.id]!.summary = 'Changed source interpretation'; });
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, raw, f.origin)).rejects.toMatchObject({ data: { code: 'knowledge_review_stale' } });
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
});
test('wrong reviewer actor, self-review and cancelled parent cannot mutate scientific knowledge', async () => {
    const f = await fixture();
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, { ...f.raw(), reviewedBy: f.claim.generated.by }, f.origin)).rejects.toThrow('actor');
    await f.app.store.mutate(f.app.projectId, state => { state.claims[f.claim.id]!.generated.by = f.raw().reviewedBy; });
    const own = await f.app.store.read(f.app.projectId), raw = f.raw();
    raw.frozenRecords[0]!.expectedHash = ResearchService.knowledgeRecordHash(own.claims[f.claim.id]);
    raw.decisions[0]!.expectedHash = raw.frozenRecords[0]!.expectedHash;
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, raw, f.origin)).rejects.toThrow('independent');
    await f.app.jobs.cancel(f.job.id);
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, raw, f.origin)).rejects.toMatchObject({ data: { code: 'research_job_commit_fence' } });
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
});
test('cross-campaign evidence and invented citation cannot enter a frozen review', async () => {
    const f = await fixture(), other = await f.app.research.createCampaign(f.app.projectId, { objective: 'Other scope' }), outside = await f.app.research.ingestLiterature(f.app.projectId, other.id, { database: 'pubmed', sourceId: '8', title: 'Other source', query: 'matched controls', excerpts: [source] });
    await expect(f.app.jobs.enqueueKnowledgeReview(other.id, { claimIds: [f.claim.id], idempotencyKey: 'outside' })).rejects.toThrow();
    const raw = f.raw();
    raw.decisions[0]!.evidenceRefs = [outside.id];
    raw.frozenRecords.push({ id: outside.id, expectedHash: ResearchService.knowledgeRecordHash(outside) });
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, raw, f.origin)).rejects.toMatchObject({ data: { code: 'knowledge_review_stale' } });
    f.proposal.decisions[0]!.evidenceRefs = ['lit_invented'];
    await expect(f.controller(f.stream()).run(f.input, f.lifecycle, { origin: f.origin })).rejects.toThrow('without accepted reconciliation');
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
});
test('post-commit publication failure recovers committed audit without another model call', async () => {
    const f = await fixture(), publish = spyOn(f.app.research, 'publishCampaignKnowledge').mockImplementationOnce(async () => { throw new Error('Publication temporarily unavailable'); });
    await expect(f.controller(f.stream()).run(f.input, f.lifecycle, { origin: f.origin })).rejects.toThrow('Publication temporarily unavailable');
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('reviewed');
    const result = await f.controller(() => { throw new Error('No model on commit recovery'); }).run(f.input, f.lifecycle, { origin: f.origin });
    expect(result.cycleId).toBeTruthy();
    expect(Object.values((await f.app.store.read(f.app.projectId)).knowledgeCycles)).toHaveLength(2);
    publish.mockRestore();
});
test('a cancelled ancestor fences an otherwise live review child', async () => {
    const f = await fixture(), parent = await f.jobs.enqueue(f.app.projectId, { idempotencyKey: 'parent', payload: { kind: 'campaign_loop', runtime: 'autofold-pi.v1', campaignId: f.campaign.id, sessionId: 'ses_parent', maxSteps: 2 } }), owned = (await f.jobs.claim(f.app.projectId, 60000, { eligible: c => c.id === parent.id }))!;
    await f.app.store.mutate(f.app.projectId, state => { state.jobs[f.job.id]!.payload.parentJobId = owned.id; state.jobs[owned.id]!.status = 'cancelled'; });
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, f.raw(), f.origin)).rejects.toMatchObject({ data: { code: 'research_job_commit_fence' } });
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
});
test('campaign defers review while an independently admitted reviewer still commits original evidence', async () => {
    const f = await fixture();
    await f.app.jobs.cancel(f.job.id);
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: f.stream() } }, campaign: { propose: async () => ({ kind: 'request_review', claimIds: [f.claim.id], rationale: 'Independently assess primary evidence.' }) } });
    const queued = await app.campaign.enqueueCampaign(f.campaign.id, { idempotencyKey: 'campaign-review', maxSteps: 1, maximumKnowledgeRefreshes: 1, maximumTrajectories: 1 }), completed = await app.jobs.runOnce({ jobId: queued.id });
    expect(completed?.status).toBe('succeeded');
    expect(completed?.result).toMatchObject({status:'exhausted',knowledgeRefreshes:0,modelCostUsd:0,remainingTrajectories:1});
    expect((completed?.result?.steps as any[])[0].result).toMatchObject({status:'research_deferred',boundary:'separate_research_process'});
    expect((await app.jobs.list()).filter(job=>job.payload.parentJobId===queued.id)).toHaveLength(0);
    expect((await app.store.read(app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
    const independent=await app.jobs.enqueueKnowledgeReview(f.campaign.id,{idempotencyKey:'separate-review',claimIds:[f.claim.id],modelBudgetUsd:.1});
    const reviewed=await app.jobs.runOnce({jobId:independent.id});
    expect(reviewed?.status).toBe('succeeded');
    expect(independent.payload.parentJobId).toBeUndefined();
    expect(independent.payload.modelBudgetUsd).toBe(.1);
    expect((await app.store.read(app.projectId)).claims[f.claim.id]!.status).toBe('reviewed');
    expect((await app.jobs.get(queued.id)).result?.knowledgeRefreshes).toBe(0);
});
test('contested review yields an honest boundary and is not eligible again without changed evidence', async () => {
    const f = await fixture();
    f.proposal.decisions[0]!.status = 'contested' as any;
    const result = await f.controller(f.stream()).run(f.input, f.lifecycle, { origin: f.origin });
    expect(result.boundary).toBe('knowledge_review_unresolved');
    const observation = await f.app.campaign.observe(f.campaign.id, f.job.id);
    expect(observation.knowledge.contestedClaimIds).toContain(f.claim.id);
    expect(observation.knowledge.reviewableContestedClaimIds).not.toContain(f.claim.id);
    await f.app.store.mutate(f.app.projectId, state => { state.literature[f.literature.id]!.summary = 'New source evidence changes applicability.'; });
    expect((await f.app.campaign.observe(f.campaign.id, f.job.id)).knowledge.reviewableContestedClaimIds).toContain(f.claim.id);
});
test('multiple review decisions validate before any lifecycle mutation', async () => {
    const f = await fixture(), second = await f.app.research.createClaim(f.app.projectId, f.campaign.id, { kind: 'limitation', statement: 'A second bounded interpretation.', stance: 'context', confidence: 0.4, evidence: [{ literatureId: f.literature.id, excerpt: source }], generatedBy: 'other-author' });
    await f.app.store.mutate(f.app.projectId, state => { const payload = state.jobs[f.job.id]!.payload; if (payload.kind === 'knowledge_review')
        payload.claimIds.push(second.id); });
    const raw = f.raw();
    raw.frozenRecords.push({ id: second.id, expectedHash: ResearchService.knowledgeRecordHash(second) });
    raw.decisions.push({ ...raw.decisions[0]!, id: second.id, expectedHash: ResearchService.knowledgeRecordHash(second), evidenceRefs: ['lit_missing'] });
    await expect(f.app.research.reconcileKnowledge(f.app.projectId, f.campaign.id, raw, f.origin)).rejects.toThrow('frozen attributable');
    const state = await f.app.store.read(f.app.projectId);
    expect(state.claims[f.claim.id]!.status).toBe('proposed');
    expect(state.claims[second.id]!.status).toBe('proposed');
    expect(Object.values(state.knowledgeCycles)).toHaveLength(1);
});
test('reviewer handles requested historical claims beyond the recent sample with exact snapshots', async () => {
    const f = await fixture();
    for (let i = 0; i < 35; i++)
        await f.app.research.createClaim(f.app.projectId, f.campaign.id, { kind: 'hypothesis', statement: 'Recent claim ' + i, stance: 'context', confidence: 0.2, evidence: [{ literatureId: f.literature.id, excerpt: source }], generatedBy: 'recent-author' });
    const result = await f.controller(f.stream()).run(f.input, f.lifecycle, { origin: f.origin });
    expect(result.decisions[0].id).toBe(f.claim.id);
    expect((await f.app.store.read(f.app.projectId)).claims[f.claim.id]!.status).toBe('reviewed');
});
test('alignment-only reviewer reads original sources and both endpoints without resolving its authored claim', async () => {
    const f = await fixture(), at = new Date().toISOString(), digest = 'sha256:' + 'a'.repeat(64);
    await f.app.store.mutate(f.app.projectId, state => { state.knowledge.knw_failure = { id: 'knw_failure', campaignId: f.campaign.id, experimentId: 'exp_fixture', trialId: 'trl_fixture', type: 'Research Failure', title: 'Failure fixture', description: 'No successful measured outcome', tags: ['fixture'], sources: [{ id: 'fixture', resource: 'offline-fixture' }], generated: { by: 'native-fixture', at }, status: 'draft', score: null, decision: 'failed', error: 'Fixture failure', diagnostics: {}, provenance: { contractHash: digest, evaluatorHash: digest, programHash: digest }, createdAt: at }; state.alignments.aln_fixture = { id: 'aln_fixture', campaignId: f.campaign.id, claimId: f.claim.id, knowledgeId: 'knw_failure', relation: 'unresolved', rationale: 'A failed run cannot measure specificity.', status: 'proposed', generated: { by: 'independent-author', at }, createdAt: at }; });
    const alignment = (await f.app.store.read(f.app.projectId)).alignments.aln_fixture!, proposal = { ...f.proposal, decisions: [{ id: alignment.id, expectedHash: ResearchService.knowledgeRecordHash(alignment), status: 'contested', rationale: 'The claim is source-grounded; this failed observation cannot corroborate it.', evidenceRefs: [f.claim.id, f.literature.id, 'knw_failure'] }] };
    await f.app.jobs.cancel(f.job.id);
    const stream = scripted(message([{ name: 'read_knowledge', args: { id: f.literature.id } }, { name: 'read_knowledge', args: { id: f.claim.id } }, { name: 'read_knowledge', args: { id: 'knw_failure' } }]), message([{ name: 'submit_reconciliation', args: proposal }]));
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: stream } } }), job = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [], alignmentIds: [alignment.id], idempotencyKey: 'alignment-only' });
    const completed = await app.jobs.runOnce({ jobId: job.id });
    expect(completed?.status).toBe('succeeded');
    expect(completed?.result?.boundary).toBe('knowledge_review_unresolved');
    const state = await app.store.read(app.projectId);
    expect(state.alignments[alignment.id]!.status).toBe('contested');
    expect(state.claims[f.claim.id]!.status).toBe('proposed');
});
test('native review publication failure requires original receipt reconciliation across Application reopen without another model turn', async () => {
    const f = await fixture();
    await f.app.jobs.cancel(f.job.id);
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: f.stream() } } }), queued = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [f.claim.id], idempotencyKey: 'native-retry' });
    const publish = spyOn(app.research, 'publishCampaignKnowledge').mockImplementationOnce(async () => { throw new Error('Derived publication unavailable'); });
    const failed = await app.jobs.runOnce({ jobId: queued.id });
    expect(failed?.status).toBe('recovery_required');
    publish.mockRestore();
    let modelCalls=0;
    const reopened = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: () => { modelCalls++;throw new Error('Receipt reconciliation must not invoke a model'); } } } });
    const original=(await reopened.jobs.get(queued.id)).checkpoints['host:lifecycle:start']!.data;
    const recovered = await reopened.jobs.reconcile(queued.id);
    expect(modelCalls).toBe(0);expect(recovered.checkpoints['host:lifecycle:start']!.data).toEqual(original);
    expect(recovered?.status).toBe('succeeded');
    expect(Object.values((await reopened.store.read(reopened.projectId)).knowledgeCycles)).toHaveLength(2);
});
test('more than 1000 unrelated campaign records do not crowd out original sources or an older contradictory alignment', async () => {
    const f = await fixture(), at = '2020-01-01T00:00:00.000Z', digest = 'sha256:' + 'a'.repeat(64);
    await f.app.store.mutate(f.app.projectId, state => {
        for (let i = 0; i < 1100; i++) {
            const id = 'clm_unrelated_' + i;
            state.claims[id] = { ...f.claim, id, statement: 'Unrelated historical interpretation ' + i };
        }
        state.knowledge.knw_old_failure = { id: 'knw_old_failure', campaignId: f.campaign.id, experimentId: 'exp_fixture', trialId: 'trl_fixture', type: 'Research Failure', title: 'Old failure fixture', description: 'No successful measurement', tags: ['fixture'], sources: [{ id: 'fixture', resource: 'offline-fixture' }], generated: { by: 'native-fixture', at }, status: 'draft', score: null, decision: 'failed', error: 'Fixture failure', diagnostics: {}, provenance: { contractHash: digest, evaluatorHash: digest, programHash: digest }, createdAt: at };
        state.alignments.aln_old_contradiction = { id: 'aln_old_contradiction', campaignId: f.campaign.id, claimId: f.claim.id, knowledgeId: 'knw_old_failure', relation: 'refutes', rationale: 'Older contradictory observation must remain visible.', status: 'proposed', generated: { by: 'old-author', at }, createdAt: at };
    });
    await f.app.jobs.cancel(f.job.id);
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: f.stream() } } });
    const queued = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [f.claim.id], idempotencyKey: 'old-contradiction' });
    const completed = await app.jobs.runOnce({ jobId: queued.id });
    expect(completed?.status).toBe('succeeded');
    const frozen = completed?.checkpoints['knowledge-review:frozen']?.data as any;
    expect(frozen?.scope).toMatchObject({ mode: 'bounded_frozen_target_source_contradiction_graph', selectedRecords: 5, totalCampaignRecords: 1105 });
    expect(frozen?.state.alignments.aln_old_contradiction.relation).toBe('refutes');
    expect(frozen?.state.literature[f.literature.id].excerpts).toEqual([source]);
    expect(frozen?.state.claims.clm_unrelated_0).toBeUndefined();
});
test('queue-time source and experiment edits reject before any reviewer inference', async () => {
    const f = await fixture();
    await f.app.store.mutate(f.app.projectId, state => { state.literature[f.literature.id]!.summary = 'Edited after enqueue'; });
    let calls = 0;
    await expect(f.controller(() => { calls++; throw new Error('No inference on a stale queue'); }).run(f.input, f.lifecycle, { origin: f.origin })).rejects.toThrow('changed before inference');
    expect(calls).toBe(0);
    const g = await fixture(), experiment = await g.app.research.createExperiment(g.app.projectId, g.campaign.id, { contract: { version: 1, objective: 'Original contract', targetArtifactHash: 'sha256:' + 'a'.repeat(64), modality: 'short_peptide', budget: { maximumCandidates: 1, gpuHours: 0, wallTimeMinutes: 1 }, evaluator: { id: 'fixture', version: '1', sourceHash: 'sha256:' + 'b'.repeat(64), direction: 'minimize', fixedSeeds: [1], submissionSize: 1 } } });
    await g.app.jobs.cancel(g.job.id);
    const app = new Application({ workspace: g.app.workspace, projectId: g.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: () => { calls++; throw new Error('No inference on changed contract'); } } } }), queued = await app.jobs.enqueueKnowledgeReview(g.campaign.id, { claimIds: [g.claim.id], idempotencyKey: 'contract-edit' });
    await app.store.mutate(app.projectId, state => { state.experiments[experiment.id]!.contract.objective = 'Tampered contract'; });
    const failed = await app.jobs.runOnce({ jobId: queued.id });
    expect(failed?.status).toBe('failed');
    expect(calls).toBe(0);
    expect((await app.store.read(app.projectId)).claims[g.claim.id]!.status).toBe('proposed');
});

async function measurementDependencies() {
    const f = await fixture(), at = '2020-01-01T00:00:00.000Z', digest = 'sha256:' + 'a'.repeat(64);
    const other = await f.app.research.createCampaign(f.app.projectId, { objective: 'Excluded measurement scope' });
    await f.app.jobs.cancel(f.job.id);
    await f.app.store.mutate(f.app.projectId, state => {
        const concept = { id: 'knw_conditioned', evaluationId: 'evl_fixture', campaignId: f.campaign.id, experimentId: 'exp_fixture', trialId: 'trl_fixture', type: 'Research Evaluation' as const, title: 'Locked score', description: 'Persisted computational observation only.', tags: ['fixture'], sources: [{ id: 'knw_baseline', resource: 'existing-comparison-record' }], generated: { by: 'native-fixture', at }, status: 'stable' as const, score: 0.23, decision: 'promoted' as const, diagnostics: {}, provenance: { contractHash: digest, evaluatorHash: digest, programHash: digest }, createdAt: at };
        state.knowledge.knw_conditioned = concept;
        state.knowledge.knw_baseline = { ...concept, id: 'knw_baseline', score: 0.27, sources: [{ id: 'run-bundle', resource: 'immutable-baseline-bundle' }] };
        state.knowledge.knw_context = { ...concept, id: 'knw_context', sources: [{ id: 'run-bundle', resource: 'immutable-context-bundle' }] };
        state.knowledge.knw_outside = { ...concept, id: 'knw_outside', campaignId: other.id };
        for (let i = 0; i < 1100; i++) state.knowledge['knw_unrelated_' + i] = { ...concept, id: 'knw_unrelated_' + i, sources: [{ id: 'run-bundle', resource: 'unrelated-bundle' }] };
        state.claims[f.claim.id]!.statement = 'A bounded interpretation refers to knw_conditioned, knw_outside and knw_invented. Source text cannot create or verify observations.';
        const producer = Object.values(state.knowledgeCycles).find(cycle => cycle.outputs.claimIds.includes(f.claim.id))!;
        producer.inputs.knowledgeIds = ['knw_context'];
    });
    const state = await f.app.store.read(f.app.projectId), claim = state.claims[f.claim.id]!;
    const proposal = { ...f.proposal, decisions: [{ ...f.proposal.decisions[0]!, expectedHash: ResearchService.knowledgeRecordHash(claim), evidenceRefs: [f.literature.id, 'knw_conditioned', 'knw_baseline', 'knw_context'] }] };
    const stream = () => scripted(message(['knw_conditioned', 'knw_baseline', 'knw_context', f.literature.id].map(id => ({ name: 'read_knowledge', args: { id } }))), message([{ name: 'submit_reconciliation', args: proposal }]));
    return { ...f, state, claim, proposal, stream };
}
test('reviewer pins and reads original measurement dependencies behind claim text, knowledge sources and producing synthesis', async () => {
    const f = await measurementDependencies();
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: f.stream() } } });
    const queued = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [f.claim.id], idempotencyKey: 'measurement-dependencies' });
    const completed = await app.jobs.runOnce({ jobId: queued.id });
    expect(completed?.status).toBe('succeeded');
    const frozen = completed?.checkpoints['knowledge-review:frozen']?.data as any;
    expect(frozen.records).toEqual(queued.payload.reviewTargets);
    expect(frozen.scope).toMatchObject({ selectedRecords: 6, omittedCampaignRecords: 1100 });
    expect(Object.keys(frozen.state.knowledge).sort()).toEqual(['knw_baseline', 'knw_conditioned', 'knw_context']);
    const state = await app.store.read(app.projectId), audit = state.knowledgeCycles[completed!.result!.cycleId as string]!.reviewAudit as any;
    for (const id of ['knw_conditioned', 'knw_baseline', 'knw_context']) {
        expect(audit.frozenRecords.find((row: any) => row.id === id).expectedHash).toBe(ResearchService.knowledgeRecordHash(f.state.knowledge[id]));
        expect(state.knowledge[id]).toEqual(f.state.knowledge[id]);
    }
    expect(state.claims[f.claim.id]!.confidence).toBe(f.claim.confidence);
    expect(state.claims[f.claim.id]!.evidence).toEqual(f.claim.evidence);
    expect(state.claims[f.claim.id]!.reviewed!.by).not.toBe(f.claim.generated.by);
});
test('queued measurement dependency changes and new connected records reject before inference', async () => {
    for (const change of ['measurement', 'connection'] as const) {
        const f = await measurementDependencies(); let calls = 0;
        const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: () => { calls++; throw new Error('Changed dependency cannot invoke inference'); } } } });
        const queued = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [f.claim.id], idempotencyKey: 'stale-' + change });
        await app.store.mutate(app.projectId, state => {
            if (change === 'measurement') state.knowledge.knw_baseline!.score = 0.99;
            else state.alignments.aln_new_connection = { id: 'aln_new_connection', campaignId: f.campaign.id, claimId: f.claim.id, knowledgeId: 'knw_unrelated_0', relation: 'refutes', rationale: 'New relation after queue', status: 'proposed', generated: f.claim.generated, createdAt: f.claim.createdAt };
        });
        const failed = await app.jobs.runOnce({ jobId: queued.id });
        expect(failed?.status).toBe('failed');
        expect(calls).toBe(0);
        expect((await app.store.read(app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
        expect(failed?.checkpoints['knowledge-review:frozen']).toBeUndefined();
    }
});
test('measurement dependency changes after frozen inference fail the atomic review CAS', async () => {
    const f = await measurementDependencies();
    const app = new Application({ workspace: f.app.workspace, projectId: f.app.projectId, jobs: { runtimeOptions: { accountingProvenance: 'offline_fixture', streamFn: f.stream() } } });
    const original = app.research.reconcileKnowledge.bind(app.research);
    const reconcile = spyOn(app.research, 'reconcileKnowledge').mockImplementationOnce(async (...args) => {
        await app.store.mutate(app.projectId, state => { state.knowledge.knw_baseline!.score = 0.99; });
        return original(...args);
    });
    const queued = await app.jobs.enqueueKnowledgeReview(f.campaign.id, { claimIds: [f.claim.id], idempotencyKey: 'measurement-cas' });
    const failed = await app.jobs.runOnce({ jobId: queued.id }); reconcile.mockRestore();
    expect(failed?.status).toBe('failed');
    expect(failed?.checkpoints['knowledge-review:proposal']).toBeDefined();
    expect(failed?.checkpoints['knowledge-review:committed']).toBeUndefined();
    expect((await app.store.read(app.projectId)).claims[f.claim.id]!.status).toBe('proposed');
});
test('dependency closure rejects required graphs beyond count and byte bounds', async () => {
    const f = await measurementDependencies(), state = structuredClone(f.state);
    state.claims[f.claim.id]!.statement = Array.from({ length: 1001 }, (_, i) => 'knw_unrelated_' + i).join(' ');
    expect(() => freezeKnowledgeReviewGraph(state, { campaignId: f.campaign.id, claimIds: [f.claim.id], alignmentIds: [] })).toThrow('bounded reviewer scope');
    state.claims[f.claim.id]!.statement = 'knw_conditioned';
    state.knowledge.knw_conditioned!.description = 'x'.repeat(4 * 1024 * 1024);
    expect(() => freezeKnowledgeReviewGraph(state, { campaignId: f.campaign.id, claimIds: [f.claim.id], alignmentIds: [] })).toThrow('bounded reviewer scope');
});


test('observed reviewer citation mistakes receive precise repair feedback and a bare source ID commits without weakening validation',async()=>{
 const f=await fixture()
 const variants=[{refs:[f.literature.id],error:'source has not been read'},{refs:[f.literature.id,f.claim.id],error:'cannot serve as its own evidence'},
  {refs:[f.campaign.id+'/'+f.literature.id],error:'use the bare id'},{refs:[f.literature.id+'@'+ResearchService.knowledgeRecordHash(f.literature)],error:'use the bare id'},
  {refs:['literature:'+f.literature.id],error:'use the bare id'}]
 let calls=0,lastError:string|undefined
 const stream:StreamFn=(_model,context)=>{
  if(lastError){
   const error=context.messages.filter((m:any)=>m.role==='toolResult'&&m.isError).at(-1) as any
   const text=error.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(' ')
   expect(text).toContain(lastError);expect(text).toContain(f.claim.id)
   lastError=undefined
  }
  calls++
  let value:AssistantMessage
  if(calls===2||calls===3)value=message([{name:'read_knowledge',args:{id:calls===2?f.literature.id:f.claim.id}}])
  else{
   const index=calls===1?0:calls-3
   const variant=variants[index]
   lastError=variant?.error
   value=message([{name:'submit_reconciliation',args:{...f.proposal,decisions:[{...f.proposal.decisions[0],evidenceRefs:variant?.refs??[f.literature.id]}]}}])
  }
  const out=createAssistantMessageEventStream();out.push({type:'start',partial:value});out.push({type:'done',reason:'toolUse',message:value});out.end(value);return out
 }
 const result=await f.controller(stream).run(f.input,f.lifecycle,{origin:f.origin})
 expect(calls).toBe(8)
 const state=await f.app.store.read(f.app.projectId)
 expect(state.claims[f.claim.id]?.status).toBe('reviewed')
 expect((state.knowledgeCycles[result.cycleId]?.reviewAudit as any).decisions[0].evidenceRefs).toEqual([f.literature.id])
 expect(fetchGuard).not.toHaveBeenCalled()
})
