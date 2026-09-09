import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeDefensiveEfficiency } from '../src/utils/defensiveEfficiency.js'

test('DER counts fieldable balls and keeps reached-on-error as a failed conversion', () => {
  const result = summarizeDefensiveEfficiency([
    { result: 'GO', outs_on_play: 1, is_error: false },
    { result: 'FO', outs_on_play: 1, is_error: false },
    { result: '1B', outs_on_play: 0, is_error: false },
    { result: 'ROE', outs_on_play: 0, is_error: true },
    { result: 'K', outs_on_play: 1, is_error: false },
    { result: 'BB', outs_on_play: 0, is_error: false },
    { result: 'HR', outs_on_play: 0, is_error: false },
  ])

  assert.equal(result.opportunities, 4)
  assert.equal(result.outsConverted, 2)
  assert.equal(result.defensiveEfficiency, 0.5)
})
