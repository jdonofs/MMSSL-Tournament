import assert from 'node:assert/strict'
import test from 'node:test'
import { clearAsyncResultCache, invalidateCachedResult, readCachedResult } from '../src/utils/asyncResultCache.js'

test('shares unchanged successful history and supports explicit invalidation', async () => {
  clearAsyncResultCache()
  let requests = 0
  const load = async () => ({ data: [{ id: 1 }], error: null, request: ++requests })
  const [first, concurrent] = await Promise.all([
    readCachedResult('history', load),
    readCachedResult('history', load),
  ])
  assert.equal(requests, 1)
  assert.equal(first, concurrent)
  await readCachedResult('history', load)
  assert.equal(requests, 1)
  invalidateCachedResult('history')
  await readCachedResult('history', load)
  assert.equal(requests, 2)
})

test('does not cache failed requests as empty history', async () => {
  clearAsyncResultCache()
  let requests = 0
  const failed = await readCachedResult('failure', async () => {
    requests += 1
    return { data: null, error: new Error('offline') }
  })
  assert.equal(failed.error.message, 'offline')
  const recovered = await readCachedResult('failure', async () => {
    requests += 1
    return { data: [1], error: null }
  })
  assert.deepEqual(recovered.data, [1])
  assert.equal(requests, 2)
})
