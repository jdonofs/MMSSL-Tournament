const cache = new Map()

// Cache only successful reads. Concurrent callers share the same promise, but
// a rejected/errored Supabase result is removed so an outage never becomes a
// valid empty historical snapshot.
export async function readCachedResult(key, loader) {
  if (cache.has(key)) return cache.get(key)
  const promise = Promise.resolve()
    .then(loader)
    .then((result) => {
      if (result?.error) {
        cache.delete(key)
        return result
      }
      return result
    }, (error) => {
      cache.delete(key)
      throw error
    })
  cache.set(key, promise)
  return promise
}

export function invalidateCachedResult(key) {
  cache.delete(key)
}

export function clearAsyncResultCache() {
  cache.clear()
}
