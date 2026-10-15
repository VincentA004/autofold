import {cpuTrial} from './cpu-trial'
import type {WireActor} from '../provider'

/** Actor has only the provider's serialized input; it has no filesystem/store port. */
export function createScientistActor(workerJournalPath: string): WireActor {
  let sequence = 0
  return (request: any) => {
    const messages = request.messages ?? []
    if (JSON.stringify(messages).includes('You are a context summarization assistant')) {
      return {text: 'Infrastructure continuity: use verified original receipts; retain evidence and do not repeat unresolved work.'}
    }
    const tools = new Set((request.tools ?? []).map((tool: any) => tool.function?.name))
    const call = (name: string, args: unknown) => {
      if (!tools.has(name)) throw new Error('Wire actor requires available public tool ' + name)
      return {calls: [{id: 'acceptance_' + (++sequence), name, arguments: args as Record<string,unknown>}]}
    }
    const last = messages.findLast((message: any) => message.role === 'tool')
    const previousCall = last && messages.flatMap((message: any) => message.tool_calls ?? []).find((item: any) => item.id === last.tool_call_id)
    const name = previousCall?.function?.name
    const value = (() => {try {return JSON.parse(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content))} catch {return undefined}})()
    if(name==='evaluate_trial'&&(value?.status==='run_failed'||value?.error))throw Error('CPU acceptance fixture execution failed before the required outcome: '+JSON.stringify(value).slice(0,1800))
    // Re-read context at every genuine new lane/host continuation. Successful
    // evaluate results contain a run ID; failed tool calls never count as science.
    if (!last || !['read_context', 'write', 'validate_trial'].includes(name)) return call('read_context', {})
    if (name === 'read_context') {
      if (!value?.experiment?.id) throw new Error('Wire read_context did not expose its experiment: ' + JSON.stringify(value).slice(0,800))
      if (value.hostConfigurationGaps?.length) throw new Error('Prerequisite unavailable: ' + JSON.stringify(value.hostConfigurationGaps))
      const completed = Number(value.lane?.completedEvaluations ?? value.budgets?.currentJob?.baselineCompletedEvaluations ?? 0)
      const refs = (value.evidenceRefs ?? []).filter((id: string) => /^run_|^trl_/.test(id)).slice(-4)
      return call('write', {path: 'trial.py', content: cpuTrial({experimentId: value.experiment.id, ordinal: completed + 1, evidenceRefs: refs, workerJournalPath})})
    }
    if (name === 'write') return call('validate_trial', {})
    if (value?.valid !== true) throw new Error('Native draft did not validate before fault injection: ' + JSON.stringify(value).slice(0,1500))
    return call('evaluate_trial', {requestId: 'acceptance_empirical_' + (++sequence)})
  }
}
