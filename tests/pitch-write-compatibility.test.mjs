import assert from 'node:assert/strict'
import test from 'node:test'

import { writePitchesWithSchemaFallback } from '../src/utils/pitchWriteCompatibility.js'

test('retries a pitch insert without star swing when the schema cache lacks that column', async () => {
  const payloads = []
  const rows = [{ pa_id: 4, is_star_swing: true }]
  const result = await writePitchesWithSchemaFallback(async (payload) => {
    payloads.push(payload)
    return payloads.length === 1
      ? { error: { code: 'PGRST204', message: "Could not find the 'is_star_swing' column of 'season_pitches' in the schema cache" } }
      : { data: null, error: null }
  }, rows)

  assert.equal(result.error, null)
  assert.deepEqual(payloads, [rows, [{ pa_id: 4 }]])
  assert.deepEqual(rows, [{ pa_id: 4, is_star_swing: true }])
})

test('preserves the original result for other errors', async () => {
  let calls = 0
  const failure = { error: { code: '42501', message: 'permission denied' } }
  const result = await writePitchesWithSchemaFallback(async () => { calls++; return failure }, { is_star_swing: true })
  assert.equal(result, failure)
  assert.equal(calls, 1)
})
