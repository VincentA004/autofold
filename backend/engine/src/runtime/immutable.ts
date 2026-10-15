// SDK entries and completed messages are append-only. Brand deep-frozen host
// copies so persistence can reuse their serialization without trusting caller
// supplied shallow Object.freeze or mutable provider buffers.
const immutable = new WeakSet<object>()
const encoded = new WeakMap<object, string>()
export function immutableSessionValue<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (immutable.has(value)) return value
  const copy = structuredClone(value)
  const freeze = (object: any) => {
    if (!object || typeof object !== 'object') return
    for (const item of Object.values(object)) freeze(item)
    Object.freeze(object); immutable.add(object)
  }
  freeze(copy)
  return copy
}
export function sessionRecordJson(value: unknown): string {
  if (!value || typeof value !== 'object' || !immutable.has(value)) return JSON.stringify(value)
  let result = encoded.get(value)
  if (result === undefined) { result = JSON.stringify(value); encoded.set(value, result) }
  return result
}
