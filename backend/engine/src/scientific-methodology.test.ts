import {expect,test} from 'bun:test'
import {MemoryResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import {validateScientificMethodology,type MethodologyProfile} from './scientific-methodology'
const digest=(s:string)=>'sha256:'+s.repeat(64)
async function fixture(){const store=new MemoryResearchStore(),research=new ResearchService.Service(store),project='offline_methodology';const campaign=await research.createCampaign(project,{objective:'Shared scientific methodology'});await research.activateCampaign(project,campaign.id)
  const experiment=await research.createExperiment(project,campaign.id,{contract:{version:1,objective:'Pinned objective',targetArtifactHash:digest('a'),modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:1,wallTimeMinutes:1},evaluator:{id:'fixture',version:'1',sourceHash:digest('b'),direction:'maximize',fixedSeeds:[1],submissionSize:1}}});await research.activateExperiment(project,experiment.id)
  const plan={question:'Does the declared intervention inform the next decision?',alternatives:[{id:'test',experiment:'One frozen comparison',expectedInformation:'Comparable locked evidence',estimatedGpuHours:1},{id:'stop',experiment:'Use prior evidence',expectedInformation:'No additional budget',estimatedGpuHours:0}],selectedAlternativeId:'test',rationale:'Inspect exactly the declared result',evidenceRefs:[experiment.id],outcomeBranches:[{observation:'Comparable',nextDecision:'Inspect verified evidence'},{observation:'Invalid',nextDecision:'Inspect the failed original receipt'}]}
  return {store,research,project,experiment,plan,state:await store.read(project)}}

test('shared admission requires a managed prospective plan, labels human omission explicitly and rejects historical bypass',async()=>{const f=await fixture();const common={state:f.state,experiment:f.experiment,evaluation:true,declaration:{}}
  expect(()=>validateScientificMethodology({...common,profile:'managed_strict'})).toThrow('Declare decision_plan')
  expect(validateScientificMethodology({...common,profile:'human_explicit'})).toMatchObject({methodologyProfile:'human_explicit',decisionPlan:undefined})
  expect(()=>validateScientificMethodology({...common,profile:'historical'})).toThrow('frozen-record profile')
  expect(validateScientificMethodology({...common,profile:'managed_strict',declaration:{decisionPlan:f.plan}}).methodologyProfile).toBe('managed_strict')
  await expect(f.research.createTrial(f.project,f.experiment.id,{hypothesis:'Cannot label fresh as historical',designAdapter:'mock',programPath:'fixture.py',programHash:digest('c'),methodologyProfile:'historical'})).rejects.toMatchObject({data:{code:'historical_methodology_frozen'}})
  const trial=await f.research.createTrial(f.project,f.experiment.id,{hypothesis:'Explicit human fixture',designAdapter:'mock',programPath:'fixture.py',programHash:digest('c'),methodologyProfile:'human_explicit'})
  expect(trial.methodologyProfile).toBe('human_explicit')
})

test('both profiles enforce supplied scoped citations and valid comparators without creating records',async()=>{const f=await fixture(),before=await f.store.read(f.project)
  for(const profile of ['managed_strict','human_explicit'] as MethodologyProfile[]){const common={state:f.state,experiment:f.experiment,profile,evaluation:true}
    expect(()=>validateScientificMethodology({...common,declaration:{decisionPlan:f.plan,evidenceRefs:['trl_foreign']}})).toThrow('do not resolve in the required scope')
    expect(()=>validateScientificMethodology({...common,declaration:{decisionPlan:f.plan,prediction:{metric:'locked_score',comparatorTrialId:'trl_missing',relation:'higher',minimumDifference:0}}})).toThrow('valid locked evaluation')
    expect(()=>validateScientificMethodology({...common,declaration:{decisionPlan:f.plan,replicateOfTrialId:'trl_foreign'}})).toThrow('outside this frozen experiment')}
  expect(await f.store.read(f.project)).toEqual(before)
})

test('both profiles validate measurement against actual stage/model/metric identity',async()=>{const f=await fixture(),pipeline=ExecutionProtocol.PipelinePolicy.parse({id:'fixture',stages:[{id:'left',role:'scoring',models:[{id:'predict',toolKey:'predict',version:'a'.repeat(40)}],required:true,allowSkip:false},{id:'right',role:'diagnostic',models:[{id:'predict',toolKey:'predict',version:'a'.repeat(40)}],required:true,allowSkip:false}]})
  const tools=[{key:'predict',category:'structure_prediction',usesGpu:true,numericMetrics:['confidence']}]
  const measurement={modelId:'predict',leftStage:'left',rightStage:'right',metric:'confidence',relation:'less',threshold:.1}
  for(const profile of ['managed_strict','human_explicit'] as MethodologyProfile[]){const common={state:f.state,experiment:f.experiment,profile,evaluation:true,pipeline,tools}
    expect(validateScientificMethodology({...common,declaration:{decisionPlan:{...f.plan,measurement}}}).decisionPlan?.measurement?.metric).toBe('confidence')
    expect(()=>validateScientificMethodology({...common,declaration:{decisionPlan:{...f.plan,measurement:{...measurement,rightStage:'absent'}}}})).toThrow('not in the compiled workflow')
    expect(()=>validateScientificMethodology({...common,declaration:{decisionPlan:{...f.plan,measurement:{...measurement,metric:'invented'}}}})).toThrow('not a registered numeric metric')}
})
