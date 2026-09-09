import { shortenCharacterName } from './mii.js'

// View-level helpers for the Stats page tables. These live outside the component so they can be
// tested directly — both encode behaviour that is easy to regress by hand:
//
//  - the overview name filter has to match what the identity cell actually renders, which is the
//    abbreviated name ("R Yoshi"), not just the stored one ("Red Yoshi");
//  - sort state outlives a column-set change, and sortRows() quietly falls back to the name column
//    when the sorted key is gone. The header has to point at the same column sortRows used, or the
//    table re-sorts with nothing highlighted to say why.

// True when `name` should survive the overview filter. An empty/whitespace filter matches
// everything. Matching is case-insensitive and substring-based on both the full and the
// abbreviated name — this is a display filter, never an identity lookup.
export function matchesNameFilter(name, filter) {
  const needle = String(filter ?? '').trim().toLowerCase()
  if (!needle) return true
  const full = String(name ?? '').toLowerCase()
  if (full.includes(needle)) return true
  return shortenCharacterName(String(name ?? '')).toLowerCase().includes(needle)
}

// The column the table is actually ordered by, given the columns currently on screen. Mirrors
// sortRows()'s own fallback: the requested key, else the `name` column, else the first column.
export function resolveEffectiveSort(columns = [], sortState = {}, fallbackKey = 'name') {
  const requestedKey = sortState?.key
  if (columns.some((column) => column?.key === requestedKey)) {
    return { key: requestedKey, direction: sortState?.direction === 'asc' ? 'asc' : 'desc' }
  }
  const fallback = columns.find((column) => column?.key === fallbackKey) || columns[0]
  return { key: fallback?.key, direction: 'asc' }
}
