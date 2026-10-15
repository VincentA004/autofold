import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from './runtime/fixtures'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { StorageResearchStore } from '@autofold/science-core/store'
import { Application } from './application'
import { Type } from 'typebox'

/** Uses the actual Pi loop, Python worker and SQLite; no model service or GPU. */
export async function offlineDemo(workspace?: string) {
  const directory = workspace ?? await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-pi-demo-'))
  let stopped = false
  let completedEvaluations = 0
  const application: Application = new Application({ workspace: directory, jobs: {scientistFactory: options => {
    const port = application.science(experiment.id,options.sessionId)
    const fixtureTool = (name: string, execute: (input: any) => Promise<unknown>) => ({
      name, label: name, description: 'Offline fixture tool', parameters: Type.Record(Type.String(), Type.Unknown()),
      executionMode: 'sequential' as const, replay: 'never' as const,
      execute: async (_id: string, input: any) => {const value = await execute(input); return {content: [{type: 'text' as const, text: JSON.stringify(value)}], details: value, ...(name === 'stop_discovery' ? {terminate: true} : {})}},
    })
    return {initialize: async () => {}, systemPrompt: 'Offline deterministic infrastructure fixture. No scientific claim.',
      context: port.context, status: async () => ({completedEvaluations, stopped, researchRequested: false}),
      tools: () => [fixtureTool('read_context', port.context), fixtureTool('author_trial', port.authorTrial),
        fixtureTool('evaluate_trial', async input => {const result = await port.evaluateTrial(input); completedEvaluations++; return result}),
        fixtureTool('stop_discovery', async input => {const result = await port.stop(input); stopped = true; return result})]}
  }} })
  const requestId = `offline-cycle-${crypto.randomUUID()}`
  const experiment = await application.createMockExperiment()
  // Use Pi's standard faux window for the full scientific tool declarations and receipts.
  const faux = fauxProvider({ provider: 'autofold-offline', models: [{ id: 'scripted-discovery', contextWindow: 128_000, maxTokens: 4096 }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const lastResult = (context: { messages: any[] }, name: string) => {
    const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === name)
    if (!message || message.isError) throw new Error(`Offline cycle did not receive a successful ${name} result`)
    return JSON.parse(message.content.find((part: any) => part.type === 'text').text)
  }
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read_context', {})),
    fauxAssistantMessage(fauxToolCall('author_trial', { program: ResearchPrograms.templates().mock, hypothesis: 'Verify deterministic execution and evidence persistence; no biological claim.', designAdapter: 'mock' })),
    context => fauxAssistantMessage(fauxToolCall('evaluate_trial', { trialId: lastResult(context, 'author_trial').trial.id, requestId })),
    fauxAssistantMessage(fauxToolCall('read_context', {})),
    context => {
      const evidence = lastResult(context, 'read_context')
      if (evidence.decisionMemory.facts.length !== 1 || evidence.decisionMemory.facts[0].outcome !== 'valid') throw new Error('Expected one persisted worker evaluation')
      return fauxAssistantMessage(fauxToolCall('stop_discovery', { reason: 'infrastructure_check_complete', rationale: 'The CPU fixture was evaluated and persisted. Its score establishes no biological evidence.', evidenceRefs: [evidence.decisionMemory.facts[0].runId] }))
    },
  ])
  const result = await application.discover(experiment.id, 'Run one infrastructure verification cycle, inspect its evidence, and pause.', {
    runtime: { models, modelSelection: { provider: faux.getModel().provider, modelId: faux.getModel().id }, streamFn: models.streamSimple.bind(models) },
  })
  if (result.status !== 'completed') throw new Error(`Offline discovery failed: ${result.status}: ${result.error}`)
  const reopened = await new StorageResearchStore({ directory: application.dataDirectory }).read(application.projectId)
  if (Object.keys(reopened.evaluations).length !== 1 || Object.values(reopened.runs)[0]?.status !== 'succeeded') throw new Error('Worker result did not survive SQLite reopen')
  if (reopened.experiments[experiment.id]?.status !== 'paused') throw new Error('Scientist pause was not persisted')
  return { status: 'passed', mode: 'offline_infrastructure_fixture', biologicalEvidence: false, workspace: directory,
    projectId: application.projectId, experimentId: experiment.id, sessionId: result.sessionId,
    runId: Object.values(reopened.runs)[0]!.id, evaluationId: Object.values(reopened.evaluations)[0]!.id,
    modelTurns: faux.state.callCount, scientificStateReopened: true }
}
