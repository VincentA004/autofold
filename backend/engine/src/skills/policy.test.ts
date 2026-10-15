import {expect,test} from 'bun:test'
import {ResearchDomain} from '@autofold/science-core/domain'
import {aggregate,pairedEvidence,replayPassed,scoreEvaluation} from './policy'
const experiment={contract:{budget:{gpuHours:1/6},evaluator:{direction:'minimize'}}} as ResearchDomain.Experiment
const score=(value:number|null)=>scoreEvaluation(experiment,{valid:value!==null,score:value,diagnostics:{submission_count:1,panel_diversity:0,unique_fraction:1}})
test('invalid observations remain separate from valid utility and unavailable diagnostics remain unknown',()=>{
 const a=score(null),b=score(.2),result=aggregate([a,b,score(.3)])
 expect(a.lockedObjectiveUtility).toBeNull();expect(result.lockedObjectiveUtility).toBeCloseTo(-.25)
 expect(result.failureRate).toBeCloseTo(1/3);expect(result.validEvaluations).toBe(2)
 expect(result.validDiverseYield).toBeNull();expect(result.predictorDisagreement).toBeNull()
 expect(result.metricCoverage).toEqual({lockedObjectiveUtility:2,validDiverseYield:0,predictorDisagreement:0})
 expect(aggregate([a,a]).lockedObjectiveUtility).toBeNull()
 expect(replayPassed(replay([null,null,null],[null,null,null]))).toBe(false)
})
function replay(b:Array<number|null>,c:Array<number|null>,same=false){
 const bs=b.map(score),cs=c.map(score),paired=pairedEvidence(bs.map((parent,i)=>({parent,candidate:cs[i]!,sameCandidates:same})))
 return {sameBudget:true,baseline:aggregate(bs),candidate:aggregate(cs),paired}
}
test('invalid recovery alone cannot activate a guide when valid paired results are mixed',()=>{
 const input=replay([null,.3378241414,.2369891824],[.2442500656,.1796109551,.2502028509])
 expect(input.paired).toMatchObject({validPairs:2,improvedPairs:1,regressedPairs:1,recoveredInvalidPairs:1})
 expect(replayPassed(input)).toBe(false)
})
test('activation requires repeated valid gains without validity or compute regression',()=>{
 const good=replay([.3,.4,.2],[.2,.3,.21]);expect(replayPassed(good)).toBe(true)
 expect(replayPassed({...good,sameBudget:false})).toBe(false)
 expect(replayPassed({...good,candidate:{...good.candidate,computeCost:1}})).toBe(false)
 expect(replayPassed(replay([.3,.4,.2],[.2,.3,null]))).toBe(false)
 expect(replayPassed(replay([.3,.4,.2],[.2,.3,.21],true))).toBe(false)
 expect(replayPassed(replay([.3,null,null],[.2,.1,.1]))).toBe(false)
})
test('duplicate candidate identities and missing diagnostic coverage do not manufacture confirmation',()=>{
 const comparison=pairedEvidence([{parent:score(.3),candidate:score(.2),sameCandidates:true}]);expect(comparison.validPairs).toBe(0);expect(comparison.repeatedCandidatePairs).toBe(1)
 const measured=scoreEvaluation(experiment,{valid:true,score:.2,diagnostics:{submission_count:2,panel_diversity:.5,predictor_disagreement:.2}})
 expect(measured.validDiverseYield).toBe(1);expect(measured.predictorDisagreement).toBe(.2)
 const mixed=aggregate([measured,score(.3)]);expect(mixed.validDiverseYield).toBeNull();expect(mixed.predictorDisagreement).toBeNull()
})

test('repeated outputs across different program/session pairs do not count as independent improvement',()=>{
 const p=pairedEvidence([1,2,3].map(i=>({parent:score(.4),candidate:score(.2),sameCandidates:false,parentIdentity:'same-baseline',candidateIdentity:'candidate-'+i})))
 expect(p.validPairs).toBe(1);expect(p.repeatedCandidatePairs).toBe(2)
 expect(replayPassed({sameBudget:true,baseline:aggregate([score(.4),score(.4),score(.4)]),candidate:aggregate([score(.2),score(.2),score(.2)]),paired:p})).toBe(false)
})
