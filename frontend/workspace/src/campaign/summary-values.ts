import type { DisplayMetric } from './client'

export interface SummaryMetricSource { label: string; path: string; pointer: string; unit?: string; denominator?: string; count?: boolean; filter?: { pointer: string; equals: string | boolean | number } }
function atPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value
  if (!pointer.startsWith('/')) throw Error('Invalid source pointer')
  for (const key of pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Source field unavailable')
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
export function summaryValue(data: unknown, metric: SummaryMetricSource): DisplayMetric['value'] {
  let value = atPointer(data, metric.pointer)
  if (metric.count) {
    if (!Array.isArray(value)) throw Error('Count source is not an array')
    value = metric.filter ? value.filter(item => atPointer(item, metric.filter!.pointer) === metric.filter!.equals).length : value.length
  }
  if (metric.denominator) {
    const total = atPointer(data, metric.denominator)
    if (typeof value !== 'number' || typeof total !== 'number') throw Error('Count source is not numeric')
    return `${value} / ${total}`
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw Error('Source is not a scalar')
  return value as DisplayMetric['value']
}
