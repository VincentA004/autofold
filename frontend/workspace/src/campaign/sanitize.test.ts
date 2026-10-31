import { expect, test } from 'bun:test'
import { sanitize } from '@synsci/ui/sanitize'

test('campaign Markdown preserves scientific text and tables while removing executable markup', () => {
  const html = sanitize('<h2>Model iPTM</h2><table><tr><td>0.956</td></tr></table><script>steal()</script><iframe src="https://unrelated.example"></iframe><a href="javascript:steal()">source</a><img src="x" onerror="steal()"><form><input name="secret"></form>')
  expect(html).toContain('Model iPTM')
  expect(html).toContain('0.956')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<iframe')
  expect(html).not.toContain('javascript:')
  expect(html).not.toContain('onerror')
  expect(html).not.toContain('<form')
  expect(html).not.toContain('<input')
})
