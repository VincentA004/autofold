import z from "zod"
import type { ResearchState } from "./store"

/** Durable executable alternatives; no acquisition ranking or scoring authority. */
export namespace ExperimentBranches {
  export class RevisionConflictError extends Error {
    readonly code = "EXPERIMENT_BRANCH_REVISION_CONFLICT"
    constructor(readonly conflict: {
      branchId: string
      expectedRevision: number
      actualRevision: number
      actualStatus: "open" | "deferred" | "retired"
    }) {
      super(
        `Stale branch revision conflict for ${conflict.branchId}: expectedRevision=${conflict.expectedRevision}, ` +
        `actualRevision=${conflict.actualRevision}, actualStatus=${conflict.actualStatus}`,
      )
      this.name = "ExperimentBranchRevisionConflictError"
    }
  }

  const Text = z.string().trim().min(1).max(2000)
  export const Action = z.discriminatedUnion("action", [
    z.object({ action:z.literal("list"), offset:z.number().int().nonnegative().default(0), limit:z.number().int().min(1).max(100).default(25) }).passthrough(),
    z.object({ action:z.literal("save"), title:Text, rationale:Text, revisitWhen:Text }).passthrough(),
    z.object({ action:z.literal("restore"), branchId:z.string().startsWith("brn_") }).passthrough(),
    z.object({ action:z.literal("status"), branchId:z.string().startsWith("brn_"), expectedRevision:z.number().int().nonnegative(),
      status:z.enum(["open","deferred","retired"]), rationale:Text, revisitWhen:Text }).passthrough(),
  ])
  export type Action = z.infer<typeof Action>
  export const Record = z.object({
    id:z.string().startsWith("brn_"), experimentId:z.string().startsWith("exp_"), campaignId:z.string().startsWith("cmp_"),
    contractHash:z.string(), programHash:z.string(), program:z.string().min(1).max(256*1024),
    parentBranchId:z.string().startsWith("brn_").optional(), title:Text, rationale:Text, revisitWhen:Text,
    evidenceRefs:z.array(z.string()).max(100), status:z.enum(["open","deferred","retired"]), revision:z.number().int().nonnegative(),
    createdAt:z.string(), history:z.array(z.object({revision:z.number().int(),status:z.enum(["open","deferred","retired"]),rationale:Text,revisitWhen:Text,at:z.string()}).passthrough()),
  }).passthrough()
  export const hash = (program:string) => `sha256:${new Bun.CryptoHasher("sha256").update(program).digest("hex")}`
  export function list(state:ResearchState, experimentId:string) {
    return Object.values(state.experimentBranches).filter(b=>b.experimentId===experimentId).map(({program,...branch})=>({
      ...branch, selected:state.branchCursors[experimentId]===branch.id,
      outcomes:Object.values(state.searchObservations).filter(o=>o.experimentId===experimentId && o.programHash===branch.programHash)
        .map(o=>({runId:o.runId,trialId:o.trialId,score:o.score,decision:o.decision,knowledgeCycleId:o.knowledgeCycleId,
          searchObservationId:o.id,configurationFamilyFingerprint:o.configurationFamilyFingerprint,decisionPlan:o.decisionPlan})),
    }))
  }
  export function save(state:ResearchState, experimentId:string, input:{program:string;title:string;rationale:string;revisitWhen:string;evidenceRefs:string[];draftPath?:string;parentBranchId?:string|null},at:string) {
    const exp=state.experiments[experimentId]; if(!exp) throw new Error("Unknown branch experiment")
    const programHash=hash(input.program)
    const id=`brn_${new Bun.CryptoHasher("sha256").update(experimentId+":"+programHash).digest("hex")}`
    const draftKey=input.draftPath ? `${experimentId}:${input.draftPath}` : undefined
    const parentBranchId=input.parentBranchId !== undefined ? input.parentBranchId ?? undefined
      : draftKey ? state.branchDrafts[draftKey] : state.branchCursors[experimentId]
    if(parentBranchId) {
      const parent=state.experimentBranches[parentBranchId]
      if(!parent || parent.experimentId!==experimentId || parent.contractHash!==exp.contractHash) throw new Error("Invalid branch parent")
      if(hash(parent.program)!==parent.programHash) throw new Error("Branch parent integrity failure")
    }
    const existing=state.experimentBranches[id]
    if(existing) {
      if(existing.contractHash!==exp.contractHash || hash(existing.program)!==existing.programHash) throw new Error("Branch contract or integrity mismatch")
      if(draftKey) state.branchDrafts[draftKey]=id
      return existing
    }
    const record=Record.parse({id,experimentId,campaignId:exp.campaignId,contractHash:exp.contractHash,
      programHash,...input,parentBranchId,status:"open",revision:0,createdAt:at,history:[{revision:0,status:"open",rationale:input.rationale,revisitWhen:input.revisitWhen,at}]})
    state.experimentBranches[id]=record
    if(draftKey) state.branchDrafts[draftKey]=id
    return record
  }
  export function bindDraft(state: ResearchState, experimentId: string, draftPath: string, program: string) {
    const key = `${experimentId}:${draftPath}`
    if (state.branchDrafts[key]) return // Never reset a resumed draft's established ancestry.
    const exp = state.experiments[experimentId]
    const branch = Object.values(state.experimentBranches).find(b => b.experimentId === experimentId && b.programHash === hash(program))
    if (!branch) return
    if (branch.contractHash !== exp?.contractHash || hash(branch.program) !== branch.programHash) throw new Error("Branch draft integrity failure")
    state.branchDrafts[key] = branch.id
  }
  export function select(state:ResearchState, experimentId:string,id:string) {
    const branch=state.experimentBranches[id],exp=state.experiments[experimentId]
    if(!branch || branch.experimentId!==experimentId || branch.contractHash!==exp?.contractHash) throw new Error("Branch outside frozen experiment")
    if(branch.status!=="open") throw new Error("Reopen this branch before restoring or evaluating it")
    if(hash(branch.program)!==branch.programHash) throw new Error("Branch program integrity failure")
    state.branchCursors[experimentId]=id
    return branch
  }
  export function update(state:ResearchState,experimentId:string,input:Extract<Action,{action:"status"}>,at:string) {
    const b=state.experimentBranches[input.branchId]
    if(!b || b.experimentId!==experimentId) throw new Error("Unknown branch in this experiment")
    if(b.revision!==input.expectedRevision) throw new RevisionConflictError({
      branchId:b.id,expectedRevision:input.expectedRevision,actualRevision:b.revision,actualStatus:b.status,
    })
    b.status=input.status;b.rationale=input.rationale;b.revisitWhen=input.revisitWhen;b.revision++
    b.history.push({revision:b.revision,status:b.status,rationale:b.rationale,revisitWhen:b.revisitWhen,at})
    return b
  }
}
