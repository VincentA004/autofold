import { For, createEffect, onCleanup } from 'solid-js'
import { createStore } from 'solid-js/store'
import { archiveClient, type ArchiveTrial, type DisplayMetric } from './client'

import { summaryValue, type SummaryMetricSource } from './summary-values'

export function SummaryMetrics(props: { trial: ArchiveTrial; sources?: SummaryMetricSource[]; onOpen: (path: string) => void }) {
  const [state, set] = createStore({ metrics: [] as DisplayMetric[] })
  createEffect(() => {
    const sources = props.sources, trial = props.trial, abort = new AbortController()
    if (!sources?.length) { set('metrics', trial.display.metrics); return }
    set('metrics', [])
    const files = new Map<string, Promise<unknown>>()
    const read = (path: string) => {
      if (!path.startsWith(`${trial.path}/`) || !trial.files.some(f => f.path === path)) return Promise.reject(Error('Source is outside this captured trial'))
      if (!files.has(path)) files.set(path, archiveClient.text(path, abort.signal).then(f => JSON.parse(f.text)))
      return files.get(path)!
    }
    Promise.all(sources.slice(0, 3).map(async source => {
      try { return { ...source, value: summaryValue(await read(source.path), source) } }
      catch (error) { return { ...source, error: String(error) } }
    })).then(metrics => { if (!abort.signal.aborted) set('metrics', metrics) })
    onCleanup(() => abort.abort())
  })
  return <div class="structure-metrics"><For each={state.metrics.slice(0, 3)}>{metric => <button class="metric" onClick={() => props.onOpen(metric.path)} title={`${metric.path}#${metric.pointer}`}>
    {metric.label}<b style={{ 'font-size': '14px' }}>{metric.error ? 'Unavailable' : typeof metric.value === 'number' ? Number.isInteger(metric.value) ? metric.value : metric.value.toFixed(3) : String(metric.value ?? 'Not reported')} {metric.unit}</b>
  </button>}</For></div>
}
