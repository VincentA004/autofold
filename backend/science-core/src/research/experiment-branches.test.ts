import { expect, test } from "bun:test"
import { ExperimentBranches } from "./experiment-branches"
import { emptyResearchState } from "./store"

test("stale branch update reports authoritative revision and status without mutation", () => {
  const state = emptyResearchState()
  state.experiments.exp_one = { id:"exp_one",campaignId:"cmp_one",contractHash:"frozen" } as any
  const branch = ExperimentBranches.save(state,"exp_one",{
    program:"program",title:"alternative",rationale:"test",revisitWhen:"new evidence",evidenceRefs:[],
  },"2026-01-01")
  ExperimentBranches.update(state,"exp_one",{
    action:"status",branchId:branch.id,expectedRevision:0,status:"deferred",
    rationale:"Wait for evidence",revisitWhen:"Evidence arrives",
  },"2026-01-02")

  let conflict: unknown
  try {
    ExperimentBranches.update(state,"exp_one",{
      action:"status",branchId:branch.id,expectedRevision:0,status:"retired",
      rationale:"Stale decision",revisitWhen:"Never",
    },"2026-01-03")
  } catch (error) { conflict = error }

  expect(conflict).toBeInstanceOf(ExperimentBranches.RevisionConflictError)
  expect((conflict as ExperimentBranches.RevisionConflictError).conflict).toEqual({
    branchId:branch.id,expectedRevision:0,actualRevision:1,actualStatus:"deferred",
  })
  expect((conflict as Error).message).toContain("actualRevision=1, actualStatus=deferred")
  expect(branch).toMatchObject({revision:1,status:"deferred",rationale:"Wait for evidence"})
})
