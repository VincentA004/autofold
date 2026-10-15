import {expect, test} from 'bun:test'
import '../../../tooling/script/offline-network'

test('software-test preload rejects provider traffic locally before a request', () => {
  // Check the marker first so this test cannot fall through to a real fetch.
  expect(Boolean((fetch as typeof fetch & {offlineSoftwareTests?: boolean}).offlineSoftwareTests)).toBe(true)
  expect(() => fetch('https://example.invalid/provider')).toThrow('External network is disabled')
  expect(() => fetch.preconnect('https://example.invalid/provider')).toThrow('Network preconnect is disabled')
  expect(Boolean(process.env.OPENROUTER_API_KEY)).toBe(false)
})
