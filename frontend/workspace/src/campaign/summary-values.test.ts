import { describe, expect, test } from 'bun:test'
import { summaryValue } from './summary-values'
import { presentationFrom } from './presentation'

describe('campaign display sources', () => {
  test('counts the captured proposal outcomes without inventing a score', () => {
    const history = [{ optimizer: { filter_status: 'passed' } }, { optimizer: { filter_status: 'failed' } }, { optimizer: { filter_status: 'passed' } }]
    expect(summaryValue(history, { label: 'Proposals', path: 'history.json', pointer: '', count: true })).toBe(3)
    expect(summaryValue(history, { label: 'Admitted', path: 'history.json', pointer: '', count: true, filter: { pointer: '/optimizer/filter_status', equals: 'passed' } })).toBe(2)
  })
  test('resolves escaped source fields and preserves zero, null, and counts', () => {
    expect(summaryValue({ 'a/b': { '~value': 0 } }, { label: 'value', path: 'metrics.json', pointer: '/a~1b/~0value' })).toBe(0)
    expect(summaryValue({ affinity: null }, { label: 'Affinity', path: 'metrics.json', pointer: '/affinity' })).toBeNull()
    expect(summaryValue({ returned: 7, requested: 7 }, { label: 'Saved', path: 'metrics.json', pointer: '/returned', denominator: '/requested' })).toBe('7 / 7')
  })
  test('missing and nonscalar fields remain unavailable', () => {
    for (const pointer of ['/missing', '/constructor', '/nested']) expect(() => summaryValue({ nested: {} }, { label: 'value', path: 'metrics.json', pointer })).toThrow()
    expect(() => summaryValue({ returned: 7, requested: 'unknown' }, { label: 'Saved', path: 'metrics.json', pointer: '/returned', denominator: '/requested' })).toThrow()
  })
  test('malformed optional presentation cannot become executable UI or invalid graph positions', () => {
    const result = presentationFrom({ title: 'Campaign', direction: { html: 'no' }, graph: [{ path: 'a.md', label: 'A', x: Infinity, y: 40 }], trials: { t1: { result: 'Saved result', metrics: [{ label: 'Bad', path: 'x', pointer: '', filter: null }] } } })
    expect(result.title).toBe('Campaign')
    expect(result.direction).toBeUndefined()
    expect(result.graph).toEqual([])
    expect(result.trials?.t1.result).toBe('Saved result')
    expect(result.trials?.t1.metrics).toEqual([])
  })
})
