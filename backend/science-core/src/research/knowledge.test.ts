import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchKnowledge } from "./knowledge"

test("OKF marks recovered failure projections as superseded while retaining their history", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-okf-recovery-"))
  const campaign = {id:"cmp_recovery",objective:"Recover evidence",knowledgeCatalogId:"okf_recovery"} as any
  const common = {
    campaignId:campaign.id,experimentId:"exp_recovery",trialId:"trl_recovery",runId:"run_recovery",
    tags:["autofold"],sources:[],diagnostics:{},
    provenance:{contractHash:"sha256:contract",evaluatorHash:"sha256:evaluator",programHash:"sha256:program"},
  }
  const failure = {
    ...common,id:"knw_failure",type:"Research Failure",title:"Failed trial",description:"Transport failed",
    status:"deprecated",score:null,decision:"failed",error:"scp: Connection closed",
    generated:{by:"failure-closeout",at:"2026-09-01T00:00:00Z"},createdAt:"2026-09-01T00:00:00Z",
  }
  const evaluation = {
    ...common,id:"knw_evaluation",type:"Research Evaluation",title:"Recovered trial",description:"Locked evaluation",
    status:"stable",score:0.19,decision:"rejected",evaluationId:"evl_recovery",
    generated:{by:"locked-evaluator",at:"2026-09-02T00:00:00Z"},createdAt:"2026-09-02T00:00:00Z",
  }
  const cycle = {
    id:"kcy_failure",campaignId:campaign.id,trigger:"run_completed",question:"Close the failed run",
    inputs:{knowledgeIds:[failure.id],claimIds:[],literatureIds:[]},
    outputs:{literatureIds:[],claimIds:[],alignmentIds:[],hypothesisIds:["hyp_failure"],
      searchObservationIds:["sobs_failure"],unresolvedQuestions:[],researchRequestUpdates:[]},
    unresolvedQuestions:[],generated:{by:"failure-closeout",at:"2026-09-01T00:00:01Z"},
    nextReviewAt:"2026-09-08T00:00:00Z",createdAt:"2026-09-01T00:00:01Z",
  }
  const observation = {
    id:"sobs_failure",campaignId:campaign.id,experimentId:"exp_recovery",trialId:"trl_recovery",
    runId:"run_recovery",knowledgeId:failure.id,knowledgeCycleId:cycle.id,intent:"optimize",
    programHash:"sha256:program",generatorPortfolio:[],generatorDiagnostics:[],candidateSequences:[],
    modelIds:[],seeds:[],score:null,decision:"failed",diagnostics:{},hypothesis:"Test before transport failed",
    epistemicLevel:"model_observation",createdAt:"2026-09-01T00:00:01Z",
  }
  const review = {
    id:"srv_failure",campaignId:campaign.id,experimentId:"exp_recovery",runId:"run_recovery",
    revision:1,createdAt:"2026-09-01T00:00:02Z",evidenceSummary:{status:"run_failed"},
    interpretation:"No score exists",nextDecision:"Retry transport",limitations:["No retrieved artifacts"],
  }
  const hypothesis = {
    id:"hyp_failure",campaignId:campaign.id,category:"workflow",
    statement:"The program failed before evaluation",status:"supported",confidence:0.95,
    evidenceLevel:"model_observation",supportingEvidenceRefs:[failure.id,"run_recovery","trl_recovery"],
    opposingEvidenceRefs:[],prediction:"No locked score",falsificationCriterion:"A recovered score",
    recommendedExperiment:"Retry transport",limitations:[],generated:{by:"failure-closeout",at:"2026-09-01T00:00:01Z"},
    createdAt:"2026-09-01T00:00:01Z",updatedAt:"2026-09-01T00:00:01Z",
  }
  try {
    const root = await ResearchKnowledge.writeBundle({
      workspace,campaign,concepts:[failure,evaluation],cycles:[cycle],
      searchObservations:[observation],scientistReviews:[review],hypotheses:[hypothesis],
    } as any)
    const files = await Promise.all([
      fs.readFile(path.join(root,"concepts",failure.id+".md"),"utf8"),
      fs.readFile(path.join(root,"search",observation.id+".md"),"utf8"),
      fs.readFile(path.join(root,"cycles",cycle.id+".md"),"utf8"),
      fs.readFile(path.join(root,"reviews",review.id+".md"),"utf8"),
      fs.readFile(path.join(root,"hypotheses",hypothesis.id+".md"),"utf8"),
      fs.readFile(path.join(root,"index.md"),"utf8"),
      fs.readFile(path.join(root,"reviews","index.md"),"utf8"),
    ])
    for (const content of files) expect(content).toContain("evl_recovery")
    for (const content of files.slice(0,5)) expect(content).toContain("status: deprecated")
    expect(files[0]).toContain("Retained as immutable historical evidence")
    expect(files[1]).toContain("Retained as immutable historical evidence")
    expect(files[2]).toContain("Retained as immutable historical evidence")
    expect(files[2]).toContain("## Causal inputs")
    expect(files[2]).toContain("Claims used: 0")
    expect(files[3]).toContain("Retained as immutable historical evidence")
    expect(files[4]).toContain("Retained as immutable historical evidence")
  } finally {
    await fs.rm(workspace,{recursive:true,force:true})
  }
})
