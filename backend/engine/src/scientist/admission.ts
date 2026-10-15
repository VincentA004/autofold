import {validateScientificMethodology} from '../scientific-methodology'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {ScientistLaneOptions} from './index'
import type {ResearchStore,ResearchState} from '@autofold/science-core/store'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ScientificExecution} from '../execution'
import {ResearchSkills} from '@autofold/science-core/research-skills'
import {CampaignSkillService} from '../skills/service'
import {checkedPath} from '../execution/paths'
const fingerprint=(value:unknown)=>'sha256:'+crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface CapturedScientificProgram {program:string;programHash:string;draftPath:string}
export interface ScientificAdmissionHost {
  options:Pick<ScientistLaneOptions,'workspace'|'projectId'|'store'> & {execution:Pick<ScientistLaneOptions['execution'],'inspectProgram'>};root:string
  scope():Promise<{state:Awaited<ReturnType<ResearchStore['read']>>;experiment:import('@autofold/science-core/domain').ResearchDomain.Experiment;campaign:import('@autofold/science-core/domain').ResearchDomain.Campaign}>
  assertBranchIntegrity(captured:CapturedScientificProgram,parentBranchId?:string|null):Promise<void>
  graphEvidence:ReadonlyMap<string,{recordHash:string;snapshotHash:string;retrievedAt:string}>
}
export interface ScientificProgramScope {
  state:ResearchState;experiment:ResearchDomain.Experiment;campaign:ResearchDomain.Campaign
  generationSeed?:number
  /** References selected by the caller's current or frozen scientific protocol. */
  skills:ResearchSkills.Reference[]
  graphEvidence?:ScientificAdmissionHost['graphEvidence']
}
/** Shared captured-source construction and scientific admission. Scope is explicit:
 * this kernel never selects active guidance or reads current campaign evidence. */
export async function inspectScientificProgram(host:{workspace:string;root:string;execution:Pick<ScientificExecution,'inspectProgram'>},captured:CapturedScientificProgram,scope:ScientificProgramScope,evaluation:boolean) {
    const {state,experiment,campaign}=scope
    const temp = host.root + '/validation/' + crypto.randomUUID() + '.py'
    const file = await checkedPath(host.workspace, temp)
    await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, captured.program, {flag: 'wx', mode: 0o400})
    try {
      const inspected = await host.execution.inspectProgram({experiment, campaign, programPath: temp, programHash: captured.programHash, generationSeed: scope.generationSeed})
      const declaration = inspected.authored.declaration
      const native = inspected.authored.nativeSearch ?? inspected.authored.staticConstruction?.nativeProjection
      const generators = [...new Set(native?.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators.map(generator => generator.key))) ?? [])]
      const semanticProgramFingerprint = fingerprint(native?.projection ?? inspected.authored.program)
      const configurationFamilyFingerprint = fingerprint({program: native?.projection ?? inspected.authored.program})
      const workflowFingerprint = fingerprint({program: native?.projection ?? inspected.authored.program, evaluation: inspected.pipelineHash})
      const {decisionPlan,prediction,evidenceRefs,methodologyProfile}=validateScientificMethodology({state,experiment,profile:'managed_strict',evaluation,declaration,pipeline:inspected.pipeline,tools:inspected.tools,
        repetition:{configurationFamilyFingerprint,workflowFingerprint,generatorPortfolio:generators}})
      return {inspected, input: {executionProtocol: inspected.authored.executionProtocol, ...(scope.generationSeed === undefined ? {} : {generationSeed:scope.generationSeed}), skills:scope.skills, hypothesis: inspected.authored.hypothesis, intent: declaration.intent, designAdapter: 'proto' as const,
        decisionPlan, prediction, evidenceRefs, methodologyProfile, graphEvidenceUse:[...new Set([...(decisionPlan?.evidenceRefs??[]),...(evidenceRefs??[])])].filter(id=>scope.graphEvidence?.has(id)).slice(0,30).map(id=>({id,...scope.graphEvidence!.get(id)!})), calibrationClass: declaration.calibrationClass, replicateOfTrialId: declaration.replicateOfTrialId,
        semanticProgramFingerprint, configurationFamilyFingerprint, workflowFingerprint,
        generators, generatorAllocations: []}}
    } finally {await fs.rm(file, {force: true})}
}
/** Discovery adds branch integrity and current campaign guidance around the shared kernel. */
export async function inspectScientificDraft(host:ScientificAdmissionHost,captured:CapturedScientificProgram,evaluation:boolean,parentBranchId?:string|null,generationSeed?:number) {
  await host.assertBranchIntegrity(captured,parentBranchId)
  const scope=await host.scope()
  const domainSkills=await new CampaignSkillService(host.options).select(scope.campaign.id,ResearchSkills.Capability.options)
  return inspectScientificProgram({workspace:host.options.workspace,root:host.root,execution:host.options.execution},captured,
    {...scope,generationSeed,skills:domainSkills.map(skill=>ResearchSkills.reference(skill)),graphEvidence:host.graphEvidence},evaluation)
}
