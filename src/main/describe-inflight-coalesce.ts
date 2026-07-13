/** Coalesce concurrent async work keyed by string (e.g. connection + table describe). */
export async function coalesceInflight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key)
  if (existing) return existing

  const promise = fn()
  map.set(key, promise)
  try {
    return await promise
  } finally {
    map.delete(key)
  }
}
