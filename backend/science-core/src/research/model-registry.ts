import crypto from 'node:crypto'
import z from 'zod'

/** Scientific metadata projection of the existing native Proto registries.
 * This module does not dispatch models or certify checkpoint assets/licenses. */
export namespace ProtoModelRegistry {
  const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  export const Feature = z.enum(['protein_sequences', 'complex_sequences', 'cyclic_bonds', 'disulfide_bonds', 'modified_residues', 'glycans', 'msa_artifacts', 'structure_templates'])
  export type Feature = z.infer<typeof Feature>
  const Features = z.object(Object.fromEntries(Feature.options.map(name => [name, z.boolean().nullable()])) as Record<Feature, z.ZodNullable<z.ZodBoolean>>).strict()
  const Metadata = z.record(z.string(), z.unknown()).nullable()
  export const Card = z.object({
    format: z.literal('autofold.proto-model-card.v1'), key: Key, kind: z.enum(['tool', 'generator', 'constraint', 'optimizer']),
    label: z.string(), category: z.string(), description: z.string(), roles: z.array(z.string()).min(1),
    registration: z.literal('registered'), assetReadiness: z.literal('unknown'), usesGpu: z.boolean(), deviceCount: z.string(),
    inputSchema: Metadata, configSchema: Metadata, outputSchema: Metadata,
    inputFields: z.array(z.string()), configFields: z.array(z.string()), supportedEntityTypes: z.array(z.string()),
    nativeFeatures: Features, bridgeFeatures: Features,
    metrics: z.array(z.object({name: z.string(), type: z.string(), description: z.string(), unit: z.string().nullable(), direction: z.string().nullable()})),
    seedFields: z.array(z.enum(['seed', 'seeds'])), licenseDeclaration: Metadata,
    weightLicenseStatus: z.literal('unverified'), links: Metadata, resourceProfile: Metadata,
    limitations: z.array(z.string()), toolsCalled: z.array(z.string()).optional(), semantics: z.record(z.string(), z.unknown()).optional(),
  }).strict()
  export type Card = z.infer<typeof Card>
  export const Requirements = z.object({features: z.array(Feature).min(1).max(8).refine(values => new Set(values).size === values.length, 'Input requirements must be unique')}).strict()
  export type Requirements = z.infer<typeof Requirements>
  const Provenance = z.object({languageCommit: z.string().regex(/^[a-f0-9]{40}$/), toolsCommit: z.string().regex(/^[a-f0-9]{40}$/), workerHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)})
  export const Snapshot = z.object({format: z.literal('autofold.proto-model-registry.v1'), provenance: Provenance.nullable(), contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), entries: z.array(Card).max(512)})
  export type Snapshot = z.infer<typeof Snapshot>
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    return value
  }
  export function snapshot(cards: unknown[], provenance: z.infer<typeof Provenance> | null): Snapshot {
    const entries = z.array(Card).parse(cards).sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
    if (new Set(entries.map(card => card.kind + ':' + card.key)).size !== entries.length) throw new Error('Duplicate native Proto model identity')
    const data = {format: 'autofold.proto-model-registry.v1' as const, provenance: provenance ? Provenance.parse(provenance) : null, entries}
    if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) throw new Error('Native Proto model metadata exceeds bounded snapshot size')
    return Snapshot.parse({...data, contentHash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex')})
  }
  export function issues(card: Card | undefined, requirements: Requirements): string[] {
    if (!card) return ['native Proto model metadata is unavailable']
    return requirements.features.filter(feature => card.bridgeFeatures[feature] !== true).map(feature =>
      `${feature}: adapter support is ${card.bridgeFeatures[feature] === false ? 'unsupported' : 'unknown'} (native schema declaration: ${card.nativeFeatures[feature] ?? 'unknown'})`)
  }
  export function assertCompatible(card: Card | undefined, requirements: Requirements, key: string): void {
    const reasons = issues(card, requirements)
    if (reasons.length) throw new Error(`Proto model ${key} cannot preserve required inputs: ${reasons.join('; ')}`)
  }
  export const CardRead = z.object({
    key: Key, kind: z.enum(['tool', 'generator', 'constraint', 'optimizer']),
    section: z.enum(['summary', 'card', 'inputSchema', 'configSchema', 'outputSchema']).default('summary'),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(24000).default(4000),
  }).strict()
  /** Bounded progressive disclosure; offset/limit are UTF-16 characters, not bytes. */
  export function readCard(registry: Snapshot, raw: unknown) {
    const input = CardRead.parse(raw)
    const card = registry.entries.find(item => item.key === input.key && item.kind === input.kind)
    if (!card) throw new Error(`Native Proto model card was not found: ${input.kind}:${input.key}`)
    const content = JSON.stringify(input.section === 'summary' ? {key:card.key,kind:card.kind,label:card.label,category:card.category,description:card.description,roles:card.roles,registration:card.registration,assetReadiness:card.assetReadiness,weightLicenseStatus:card.weightLicenseStatus,usesGpu:card.usesGpu,nativeFeatures:card.nativeFeatures,bridgeFeatures:card.bridgeFeatures,metricNames:card.metrics.map(metric=>metric.name),seedFields:card.seedFields,toolsCalled:card.toolsCalled,inputFields:card.inputFields,configFields:card.configFields,limitations:card.limitations,sections:['card','inputSchema','configSchema','outputSchema']} : input.section === 'card' ? card : card[input.section], null, 2)
    const nextOffset = Math.min(content.length, input.offset + input.limit)
    return {key: card.key, kind: card.kind, section: input.section, provenance: registry.provenance,
      contentHash: registry.contentHash, offset: input.offset, totalCharacters: content.length,
      content: content.slice(input.offset, nextOffset), nextOffset: nextOffset < content.length ? nextOffset : null}
  }
  const planningEntryLimit = 12
  function planningText(value: string, limit: number) {
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, limit)
  }
  /** Small startup inventory for components the host reports as installed.
   * The complete immutable registry remains available through MODEL_REGISTRY.json
   * and readCard; this view is deliberately not a searchable replacement. */
  export function planningView(registry: Snapshot, installedComponentIds: readonly string[] = []) {
    const installed = new Set(installedComponentIds)
    const installedCards = registry.entries.filter(card => installed.has(card.key))
    const relatedIds = new Set(installedComponentIds)
    for (const card of installedCards) for (const key of card.toolsCalled ?? []) relatedIds.add(key)
    const relevant = registry.entries.filter(card => relatedIds.has(card.key))
    // Identities are lookup keys: omitting long keys is safer than presenting a
    // shortened key that cannot be passed back to readCard or could collide.
    const previewable = relevant.filter(card => card.key.length <= 128)
    const entries = previewable.slice(0, planningEntryLimit).map(card => ({key:card.key,kind:card.kind,
      category:planningText(card.category,64),description:planningText(card.description,96),usesGpu:card.usesGpu,assetReadiness:card.assetReadiness}))
    const countsByKind = Object.fromEntries((['tool','generator','constraint','optimizer'] as const).map(kind =>
      [kind,registry.entries.filter(card => card.kind === kind).length]))
    return {format: registry.format, provenance: registry.provenance, contentHash: registry.contentHash,
      guidance: 'Compose native Proto Programs from registered generators, constraints and optimizers. NativeSearch declares separate internal-search and final-output limits, explicit final regions and admitted tool keys. Hard threshold gates differ from weighted objectives; preserve each component and raw metrics. Low native energy is not the locked evaluator score. Native features are schema declarations, not scientific validation. Registration is not checkpoint readiness or measured hardware fit. Explicit input requirements must be preserved by the current scoring adapter. Use read_model_card for paginated full metadata and schemas; MODEL_REGISTRY.json preserves the complete snapshot.',
      entryCount: registry.entries.length, countsByKind,
      installedComponentCount: installedCards.length, relevantSummaryCount: entries.length,
      omittedRelevantSummaryCount: Math.max(0,relevant.length-entries.length),
      searchableInventory: 'MODEL_REGISTRY.json contains every registered identity and remains available through search_files; use read_model_card for exact-key metadata.',
      metadataPolicy: {assetReadiness:'unknown',weightLicenseStatus:'unverified',details:'Read a selected summary/configSchema with read_model_card; full card and schemas remain paginated and unchanged.'},
      entries}
  }
}
