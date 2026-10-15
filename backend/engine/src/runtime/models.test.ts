import {expect, test} from 'bun:test'
import {createModels} from '@earendil-works/pi-ai/models'
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter'
import {DEFAULT_MODEL, DEFAULT_MODEL_SELECTION, resolveModel} from './models'

test('default resolves verified DeepSeek metadata in both runtime and provider catalog', () => {
  const {model, models} = resolveModel()
  expect(DEFAULT_MODEL_SELECTION.modelId).toBe('deepseek/deepseek-v4.1-flash')
  expect(model).toEqual(DEFAULT_MODEL)
  expect(models.getModel('openrouter', DEFAULT_MODEL.id)).toEqual(model)
  expect(model.contextWindow).toBe(1048576)
  expect(model.maxTokens).toBe(943718)
})
test('explicit legacy model selection remains registered', () => {
  const {model} = resolveModel({provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash'})
  expect(model.id).toBe('z-ai/glm-5.3-flash')
  expect(model.cost.input).toBe(0.15)
})
test('custom metadata overrides the matching registered model and rejects mismatched identity', () => {
  const custom = {...DEFAULT_MODEL, maxTokens: 4096}
  const selection = {...DEFAULT_MODEL_SELECTION, model: custom}
  const {model, models} = resolveModel(selection)
  expect(model.maxTokens).toBe(4096)
  expect(models.getModel('openrouter', custom.id)?.maxTokens).toBe(4096)
  expect(() => resolveModel({...selection, modelId: 'different-model'})).toThrow(/metadata must match/)
})
test('caller-supplied catalog is preserved without injecting default registrations', () => {
  const models = createModels()
  models.setProvider({...openrouterProvider(), getModels: () => [{...DEFAULT_MODEL, maxTokens: 2048}]})
  expect(resolveModel(DEFAULT_MODEL_SELECTION, models).model.maxTokens).toBe(2048)
})
