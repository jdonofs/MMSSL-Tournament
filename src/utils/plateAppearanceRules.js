// Leaf helpers shared by the stat calculator and standalone expected-stat
// model. Keeping these rules dependency-free lets calibration tests exercise
// expectedStats without loading the full UI-oriented stats module.
export function isOfficialAtBat(pa = {}) {
  if (typeof pa.is_official_ab === 'boolean') return pa.is_official_ab
  if (!pa.result) return false
  return !['BB', 'HBP', 'SF', 'SH'].includes(pa.result)
}
