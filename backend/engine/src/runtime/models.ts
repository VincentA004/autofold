import type { Api, Model } from '@earendil-works/pi-ai'
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import type { PiModelSelection } from './types'

export const DEFAULT_MODEL_SELECTION = { provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' } as const
/** OpenRouter /api/v1/models metadata verified 2026-10-10. Costs are estimates; upstream receipts govern accounting. */
export const DEFAULT_MODEL: Model<'openai-completions'> = {
  id: DEFAULT_MODEL_SELECTION.modelId, name: 'DeepSeek: DeepSeek V4.1 Flash', provider: 'openrouter',
  api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', reasoning: true,
  input: ['text', 'image'], contextWindow: 1048576, maxTokens: 943718,
  cost: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
  compat: { thinkingFormat: 'openrouter' },
}
/** Preserve explicit selections made by existing GLM sessions and jobs. */
const LEGACY_GLM_MODEL: Model<'openai-completions'> = {
  ...DEFAULT_MODEL, id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash',
  contextWindow: 1048575, maxTokens: 943717,
  cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
}
export function resolveModel(selection: PiModelSelection = DEFAULT_MODEL_SELECTION, supplied?: MutableModels) {
  const models = supplied ?? createModels()
  if (!supplied) {
    const provider = openrouterProvider()
    const baseline = provider.getModels()
    const registered = new Map<string, Model<Api>>([LEGACY_GLM_MODEL, DEFAULT_MODEL].map(model => [model.id, model]))
    if (selection.model?.provider === 'openrouter') registered.set(selection.model.id, selection.model)
    models.setProvider({ ...provider, getModels: () => [
      ...baseline.filter(model => !registered.has(model.id)), ...registered.values(),
    ] })
  }
  if (selection.model && (selection.model.id !== selection.modelId || selection.model.provider !== selection.provider)) {
    throw new Error('Custom model metadata must match the selected provider and modelId')
  }
  const model: Model<Api> | undefined = selection.model ?? models.getModel(selection.provider, selection.modelId)
  if (!model) throw new Error(`Pi model is not registered: ${selection.provider}/${selection.modelId}`)
  return { model, models }
}
