// Which seasons and tournaments a character actually appears in, and how each one is labelled.
//
// Shared by CharacterPage (sidebar scope links) and CharacterScoutingReport (scope picker) so
// the two can never disagree about which events a character played in.

export function getHistoryEntryLabel(entry = {}) {
  if (entry.sourceLabel) return entry.sourceLabel
  if (entry.eventType === 'tournament') return `MST ${entry.eventNumber}`
  if (entry.eventType === 'season') return String(entry.eventNumber)
  return entry.tournamentNumber ? `MST ${entry.tournamentNumber}` : 'Unknown'
}

export function sortHistoryEntries(a, b) {
  if ((a.sortGroup || 0) !== (b.sortGroup || 0)) return (a.sortGroup || 0) - (b.sortGroup || 0)
  return (b.sortValue || 0) - (a.sortValue || 0)
}

// A character who only fielded in an event -- no batting PAs, no pitching innings -- still
// played in it, which is why fieldingHistory is consulted and not just the other two.
export function buildScopeOptions(battingHistory = [], pitchingHistory = [], fieldingHistory = []) {
  const byKey = new Map()
  const add = (type, eid, entry) => {
    if (!type || eid == null) return
    const key = `${type}:${eid}`
    if (byKey.has(key)) return
    byKey.set(key, {
      type, id: eid, label: getHistoryEntryLabel(entry),
      sortGroup: entry.sortGroup, sortValue: entry.sortValue,
    })
  }

  battingHistory.forEach((entry) => add(entry.eventType, entry.eventId, entry))
  pitchingHistory
    .filter((entry) => (entry.innings || 0) > 0)
    .forEach((entry) => add(entry.sourceType, entry.tournamentId ?? entry.seasonId, entry))
  fieldingHistory.forEach((entry) => add(entry.eventType, entry.eventId, entry))

  return [...byKey.values()].sort(sortHistoryEntries)
}
