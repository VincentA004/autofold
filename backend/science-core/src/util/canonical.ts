/** Stable JSON value projection. Preserve numeric rendering at the host wire boundary. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [other]) => left < other ? -1 : left > other ? 1 : 0)
    .map(([key, item]) => [key, canonicalValue(item)]))
  return value
}
