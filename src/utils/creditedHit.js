export const CREDITED_HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])

// A tracker play may keep the game's hit-shaped result while a bobble is
// reviewed as an error. The explicit error flag wins for official scoring.
export function isCreditedHit(pa = {}) {
  return !Boolean(pa.is_error) && CREDITED_HIT_RESULTS.has(pa.result)
}

export function isCreditedHitType(pa = {}, result) {
  return isCreditedHit(pa) && pa.result === result
}

export function isCreditedHomeRun(pa = {}) {
  return isCreditedHit(pa) && (pa.result === 'HR' || pa.result === 'IPHR')
}
