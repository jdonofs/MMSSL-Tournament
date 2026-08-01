import { rankStatWithinEvent } from './statsCalculator'

// Fixed, modest v1 scope: 4 batting + 4 pitching counting/rate stats, gated by a minimum sample
// so a 2-PA hot streak can't "lead the league." Top-3/led-league only — no historical
// Gold-Glove-style awards, since nothing like that exists in this game.
const MIN_PA_FOR_RATE_STATS = 20
const MIN_INNINGS_FOR_RATE_STATS = 8

const BATTING_STATS = [
  { key: 'homeRuns', label: 'HR', higherIsBetter: true },
  { key: 'rbi', label: 'RBI', higherIsBetter: true },
  { key: 'avg', label: 'AVG', higherIsBetter: true, qualifier: (row) => row.pa >= MIN_PA_FOR_RATE_STATS },
  { key: 'ops', label: 'OPS', higherIsBetter: true, qualifier: (row) => row.pa >= MIN_PA_FOR_RATE_STATS },
]

const PITCHING_STATS = [
  { key: 'wins', label: 'W', higherIsBetter: true },
  { key: 'saves', label: 'SV', higherIsBetter: true },
  { key: 'strikeouts', label: 'K', higherIsBetter: true },
  { key: 'era', label: 'ERA', higherIsBetter: false, qualifier: (row) => row.innings >= MIN_INNINGS_FOR_RATE_STATS },
]

function eventLabel(entry) {
  return entry.eventType === 'season' ? String(entry.eventNumber) : `MST ${entry.eventNumber}`
}

// battingHistoryByCharacter / pitchingHistoryByCharacter: { [characterId]: eventEntry[] }, each
// entry shaped like aggregateGameHistoryByEvent's / aggregatePitchingHistoryByEvent's output
// (built league-wide, across every character, in useCharacterExtras).
export function buildCharacterAwardRows(characterId, battingHistoryByCharacter = {}, pitchingHistoryByCharacter = {}) {
  const rows = []

  function collectStat(historyByCharacter, statConfigs, statSource) {
    const eventKeys = new Set()
    Object.values(historyByCharacter).forEach((entries) => entries.forEach((e) => eventKeys.add(e.eventKey)))

    eventKeys.forEach((eventKey) => {
      statConfigs.forEach(({ key, label, higherIsBetter, qualifier }) => {
        const eventRows = []
        Object.entries(historyByCharacter).forEach(([charId, entries]) => {
          const entry = entries.find((e) => e.eventKey === eventKey)
          if (!entry) return
          eventRows.push({ characterId: charId, value: entry[key], pa: entry.pa, innings: entry.innings, entry })
        })
        if (!eventRows.length) return

        const ranked = rankStatWithinEvent(eventRows, {
          higherIsBetter,
          qualifier: qualifier || (() => true),
        })
        const own = ranked.find((r) => String(r.characterId) === String(characterId) && r.topN)
        if (!own) return

        rows.push({
          stat: label,
          statSource,
          eventKey,
          eventLabel: eventLabel(own.entry),
          sortValue: own.entry.eventSortKey,
          rank: own.rank,
          led: own.led,
          value: own.value,
        })
      })
    })
  }

  collectStat(battingHistoryByCharacter, BATTING_STATS, 'batting')
  collectStat(pitchingHistoryByCharacter, PITCHING_STATS, 'pitching')

  return rows.sort((a, b) => b.sortValue - a.sortValue)
}
