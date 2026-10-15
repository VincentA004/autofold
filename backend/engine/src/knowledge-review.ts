import z from 'zod'
import {ResearchService} from '@autofold/science-core/service'
import type {Application} from './application'

/** Operator entry point. Pi knowledge tools cannot mutate review status. */
export const KnowledgeReviewBody = z.object({
  status: z.enum(['reviewed', 'contested', 'deprecated']),
  reviewedBy: z.string().trim().min(1).max(200),
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()
export async function reviewKnowledge(app: Application, campaignId: string, recordId: string, raw: unknown) {
  const input = KnowledgeReviewBody.parse(raw)
  const record = await (async () => {try {return /^clm_[A-Za-z0-9_-]+$/.test(recordId)
    ? await app.research.reviewClaim(app.projectId, campaignId, recordId, input)
    : /^aln_[A-Za-z0-9_-]+$/.test(recordId)
      ? await app.research.reviewAlignment(app.projectId, campaignId, recordId, input)
      : (() => {throw new Error('Only claims and alignments have operator review status')})()
  } catch (error) {if (ResearchService.ConflictError.isInstance(error)) throw new Error(error.data.message, {cause: error}); throw error}})()
  // The store is authoritative; projection can be repaired with knowledge publish.
  let publication:{status:'published'|'pending';error?:string}={status:'published'}
  try{await app.research.publishCampaignKnowledge(app.projectId,campaignId,app.workspace)}catch(error){publication={status:'pending',error:error instanceof Error?error.message:String(error)}}
  return {record,committed:true,publication, recordSnapshotHash: ResearchService.knowledgeRecordHash(record), authority: 'reviewed_interpretation_not_verified_measurement'}
}
