import {expect,test} from 'bun:test'
import {acceptanceCostSummary} from './index'
test('acceptance labels actual provider cost independently from SDK static estimates',()=>{
 expect(acceptanceCostSummary({modelCostUsd:.2,providerAccounting:{status:'reported',reportedCostUsd:.11}})).toMatchObject({sdkEstimatedModelCostUsd:.2,providerReportedModelCostUsd:.11,actualModelCostUsd:.11})
})
test('unknown original billing remains null in acceptance, never an estimated or zero bill',()=>{
 for(const result of [undefined,{modelCostUsd:.2},{modelCostUsd:.2,providerAccounting:{status:'unknown',reportedCostUsd:null,knownReportedCostUsd:.1}},{modelCostUsd:.2,providerAccounting:{status:'reported',reportedCostUsd:-1}}])expect(acceptanceCostSummary(result).actualModelCostUsd).toBeNull()
})
test('a genuine reported zero bill stays known independently of SDK estimate',()=>{
 expect(acceptanceCostSummary({modelCostUsd:.2,providerAccounting:{status:'reported',reportedCostUsd:0}}).actualModelCostUsd).toBe(0)
})
