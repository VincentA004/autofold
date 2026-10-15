import type {EvidenceView} from '@autofold/science-core/evidence-view'
import type {ScientificExecution} from '../execution'
export function decisions(items: Awaited<ReturnType<ScientificExecution['artifacts']>>['modelEvidence']): EvidenceView.Decision[] {
  return items.map(item => {
    if (typeof item.modelId !== 'string' || item.stage !== undefined && typeof item.stage !== 'string') throw new Error('Verified model evidence has invalid identity')
    return {...item, modelId: item.modelId, stage: item.stage as string | undefined}
  })
}

