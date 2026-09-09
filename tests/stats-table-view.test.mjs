import test from 'node:test'
import assert from 'node:assert/strict'

import { matchesNameFilter, resolveEffectiveSort } from '../src/utils/statsTableView.js'

// The Stats overview tables identify a row by the abbreviated name ("R Yoshi") while the row
// itself stores the full one ("Red Yoshi"). The filter has to match either, or typing what's
// visible on screen returns nothing.
test('name filter matches the abbreviated form shown in the identity cell', () => {
  assert.equal(matchesNameFilter('Red Yoshi', 'R Yoshi'), true)
  assert.equal(matchesNameFilter('Red Yoshi', 'Red Yoshi'), true)
  assert.equal(matchesNameFilter('Red Yoshi', 'yoshi'), true)
  assert.equal(matchesNameFilter('Blue Dry Bones', 'b dry'), true)
})

test('name filter is case-insensitive and substring-based', () => {
  assert.equal(matchesNameFilter('Baby Daisy', 'DAISY'), true)
  assert.equal(matchesNameFilter('Baby Daisy', 'aby dai'), true)
  assert.equal(matchesNameFilter('Baby Daisy', 'daisyy'), false)
  assert.equal(matchesNameFilter('Baby Daisy', 'mario'), false)
})

test('an empty or whitespace filter keeps every row', () => {
  assert.equal(matchesNameFilter('Mario', ''), true)
  assert.equal(matchesNameFilter('Mario', '   '), true)
  assert.equal(matchesNameFilter('Mario', undefined), true)
  // A missing name must not throw or silently match a real query.
  assert.equal(matchesNameFilter(null, ''), true)
  assert.equal(matchesNameFilter(null, 'mario'), false)
})

const BATTING_COLUMNS = [{ key: 'name' }, { key: 'homeRuns' }, { key: 'avg' }]
const PITCHING_COLUMNS = [{ key: 'name' }, { key: 'era' }, { key: 'whip' }]

test('the sorted column is reported as-is when it exists in the current table', () => {
  assert.deepEqual(
    resolveEffectiveSort(BATTING_COLUMNS, { key: 'homeRuns', direction: 'desc' }),
    { key: 'homeRuns', direction: 'desc' },
  )
  assert.deepEqual(
    resolveEffectiveSort(BATTING_COLUMNS, { key: 'name', direction: 'asc' }),
    { key: 'name', direction: 'asc' },
  )
})

// Sorting Characters by HR and then switching to Pitching drops the HR column. sortRows() falls
// back to the name column; the header used to point at nothing, so the table re-sorted itself
// with no indicator anywhere.
test('a sort key missing from the current columns falls back to the name column', () => {
  assert.deepEqual(
    resolveEffectiveSort(PITCHING_COLUMNS, { key: 'homeRuns', direction: 'desc' }),
    { key: 'name', direction: 'asc' },
  )
})

test('the fallback uses the first column when there is no name column', () => {
  assert.deepEqual(
    resolveEffectiveSort([{ key: 'stadium' }, { key: 'ops' }], { key: 'homeRuns', direction: 'desc' }),
    { key: 'stadium', direction: 'asc' },
  )
})

test('resolving a sort against no columns yields no key rather than throwing', () => {
  assert.deepEqual(resolveEffectiveSort([], { key: 'homeRuns', direction: 'desc' }), { key: undefined, direction: 'asc' })
})
