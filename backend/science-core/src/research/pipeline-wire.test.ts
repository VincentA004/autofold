import fs from 'node:fs'
import path from 'node:path'
import {expect, test} from 'bun:test'
import {ExecutionProtocol} from './execution-protocol'

const worker = path.resolve(import.meta.dir, '../../../worker')
const original = JSON.parse(fs.readFileSync(path.join(worker, 'tests/fixtures/native-search-portable-bundle.json'), 'utf8'))
function wire(input: any) {
  const value = structuredClone(input)
  value.pipelineCanonicalJson = ExecutionProtocol.canonicalPipelineJson(value.pipeline)
  value.pipelineHash = ExecutionProtocol.hashPipeline(value.pipeline)
  return ExecutionProtocol.TrialBundleV4.parse(value)
}
function validatePython(value: unknown) {
  const result = Bun.spawnSync(['python3', '-c', 'import json,sys; from autofold_worker.protocol import validate_bundle; validate_bundle(json.load(sys.stdin))'], {
    stdin: Buffer.from(JSON.stringify(value)), env: {...process.env, PYTHONPATH: worker, PYTHONDONTWRITEBYTECODE: '1'}, stdout: 'pipe', stderr: 'pipe',
  })
  return {code: result.exitCode, error: new TextDecoder().decode(result.stderr)}
}

test('original small-temperature native bundle reproduces rejection; portable bytes validate before models load', () => {
  expect(validatePython(original)).toMatchObject({code: 1})
  expect(validatePython(original).error).toContain('Pipeline policy hash')
  const value = wire(original)
  expect(value.pipelineHash).toBe(original.pipelineHash)
  expect(value.pipelineCanonicalJson).toContain('"min_temperature":0.00001')
  expect(validatePython(value)).toEqual({code: 0, error: ''})
})

test('native wire identity preserves Unicode, numeric object keys and exponent boundary settings across languages', () => {
  const value = structuredClone(original)
  value.pipeline.nativeSearch.projection[0].stages[0].config.extra = {
    '2': 'β protein 🧬', '10': [0.000001, 1e-7, 1e20, 1e21, -0, 0.3333333333333333],
  }
  expect(validatePython(wire(value))).toEqual({code: 0, error: ''})
})

test('canonical bytes cannot authorize a changed policy or a differently serialized host identity', () => {
  const value: any = wire(original)
  value.pipeline.nativeSearch.projection[0].stages[0].config.min_temperature = 0.2
  expect(ExecutionProtocol.TrialBundleV4.safeParse(value).success).toBe(false)
  expect(validatePython(value).error).toContain('Canonical pipeline bytes do not match')
  const bytes: any = wire(original)
  bytes.pipelineCanonicalJson = JSON.stringify(bytes.pipeline)
  expect(ExecutionProtocol.TrialBundleV4.safeParse(bytes).success).toBe(false)
  expect(validatePython(bytes).error).toContain('Pipeline policy hash')
})
