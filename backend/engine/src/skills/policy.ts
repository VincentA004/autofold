import { ResearchDomain } from '@autofold/science-core/domain'
export interface PairedEvidence {
  policy: 'paired_valid_v2'; validPairs: number; improvedPairs: number; regressedPairs: number; tiedPairs: number
  recoveredInvalidPairs: number; newInvalidPairs: number; repeatedCandidatePairs: number; meanValidUtilityDelta: number | null
}
export function pairedEvidence(pairs: Array<{parent: ResearchDomain.SkillReplayScore; candidate: ResearchDomain.SkillReplayScore; sameCandidates: boolean;parentIdentity?:string;candidateIdentity?:string}>): PairedEvidence {
  let validPairs=0,improvedPairs=0,regressedPairs=0,tiedPairs=0,recoveredInvalidPairs=0,newInvalidPairs=0,repeatedCandidatePairs=0,totalDelta=0
  const seen=new Set<string>()
  for(const pair of pairs){
    const b=pair.parent.lockedObjectiveUtility,c=pair.candidate.lockedObjectiveUtility
    if(b===null&&c!==null)recoveredInvalidPairs++
    if(b!==null&&c===null)newInvalidPairs++
    const repeated=pair.sameCandidates||pair.parentIdentity!==undefined&&seen.has(pair.parentIdentity)||pair.candidateIdentity!==undefined&&seen.has(pair.candidateIdentity)
    if(pair.parentIdentity!==undefined)seen.add(pair.parentIdentity)
    if(pair.candidateIdentity!==undefined)seen.add(pair.candidateIdentity)
    if(repeated){repeatedCandidatePairs++;continue}
    if(b===null||c===null)continue
    validPairs++;const delta=c-b;totalDelta+=delta
    if(delta>1e-9)improvedPairs++;else if(delta < -1e-9)regressedPairs++;else tiedPairs++
  }
  return {policy:'paired_valid_v2',validPairs,improvedPairs,regressedPairs,tiedPairs,recoveredInvalidPairs,newInvalidPairs,repeatedCandidatePairs,meanValidUtilityDelta:validPairs?totalDelta/validPairs:null}
}
export function replayPassed(input: {sameBudget: boolean; baseline: ResearchDomain.SkillReplayScore; candidate: ResearchDomain.SkillReplayScore; paired?: PairedEvidence}) {
  if (!input.sameBudget) return false
  const {baseline:b,candidate:c,paired:p}=input
  if(c.failureRate>b.failureRate||c.computeCost>b.computeCost)return false
  // New scientific replay requires repeated valid, distinct-candidate paired gains.
  // Invalid recovery is reported separately and cannot substitute for objective evidence.
  if(p){
    if(p.policy!=='paired_valid_v2'||p.validPairs<2||p.improvedPairs<2||p.improvedPairs<=p.regressedPairs||p.newInvalidPairs>0||p.meanValidUtilityDelta===null||p.meanValidUtilityDelta<=1e-9)return false
    for(const metric of ['validDiverseYield'] as const)if(b[metric]!==null&&c[metric]!==null&&c[metric]!<b[metric]!)return false
    return true
  }
  // Compatibility for legacy numeric evidence; historical stored decisions are never rewritten.
  const increases=['lockedObjectiveUtility','areaUnderImprovementCurve','validDiverseYield'] as const
  return increases.every(k=>b[k]!==null&&c[k]!==null&&c[k]!>=b[k]!)&&
    (increases.some(k=>c[k]!>b[k]!)||c.failureRate<b.failureRate||c.computeCost<b.computeCost)
}
/** Only valid locked outcomes contribute utility. Missing/non-applicable diagnostics stay null. */
export function scoreEvaluation(experiment: ResearchDomain.Experiment, evaluation: {valid:boolean;score:number|null;diagnostics:Record<string,number>}) {
  const valid=evaluation.valid&&evaluation.score!==null
  const utility=valid?(experiment.contract.evaluator.direction==='maximize'?evaluation.score!:-evaluation.score!):null
  const d=evaluation.diagnostics,disagreement=Object.entries(d).filter(([k,v])=>k.toLowerCase().includes('disagreement')&&Number.isFinite(v)).map(([,v])=>Math.max(0,v))
  const count=d.submission_count??d.candidate_count,diversity=d.panel_diversity
  const diverseYield=valid&&count!==undefined&&count>=2&&diversity!==undefined?Math.max(0,count)*Math.max(0,diversity):null
  return ResearchDomain.SkillReplayScore.parse({lockedObjectiveUtility:utility,areaUnderImprovementCurve:utility,validDiverseYield:diverseYield,
    predictorDisagreement:valid&&disagreement.length?disagreement.reduce((a,b)=>a+b,0)/disagreement.length:null,
    failureRate:valid?0:1,computeCost:experiment.contract.budget.gpuHours,validEvaluations:valid?1:0,totalEvaluations:1})
}
export function aggregate(scores: ResearchDomain.SkillReplayScore[]) {
  if(!scores.length)throw new Error('Paired replay needs at least one receipt')
  const values=(k:keyof ResearchDomain.SkillReplayScore)=>scores.map(s=>s[k]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v))
  const sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0),u=values('lockedObjectiveUtility'),diversity=values('validDiverseYield'),disagreement=values('predictorDisagreement')
  return ResearchDomain.SkillReplayScore.parse({lockedObjectiveUtility:u.length?sum(u)/u.length:null,areaUnderImprovementCurve:u.length?sum(u):null,
    validDiverseYield:diversity.length===scores.length?sum(diversity):null,predictorDisagreement:disagreement.length===scores.length?sum(disagreement)/disagreement.length:null,
    failureRate:sum(values('failureRate'))/scores.length,computeCost:sum(values('computeCost')),validEvaluations:u.length,totalEvaluations:scores.length,
    metricCoverage:{lockedObjectiveUtility:u.length,validDiverseYield:diversity.length,predictorDisagreement:disagreement.length}})
}
