export function formatBaseballAverage(summary = {}) {
  const avg = Number(summary.atBats || 0) > 0 ? Number(summary.avg || 0) : 0
  const formatted = avg.toFixed(3)
  return avg < 1 ? formatted.replace(/^0/, '') : formatted
}

export function formatHitsAtBats(summary = {}) {
  return `${Number(summary.hits || 0)}-${Number(summary.atBats || 0)}`
}

export function formatRate(value) {
  const num = Number(value || 0)
  const formatted = num.toFixed(3)
  return num < 1 ? formatted.replace(/^0/, '') : formatted
}

export function isMeaningfulPitchingStint(stint = {}) {
  return [
    stint.innings_pitched,
    stint.hits_allowed,
    stint.runs_allowed,
    stint.earned_runs,
    stint.walks,
    stint.strikeouts,
    stint.hr_allowed,
    stint.pitches_thrown,
    stint.win,
    stint.loss,
    stint.save,
  ].some((value) => Number(value || 0) > 0 || value === true)
}

export function dedupePitchingStints(stints = []) {
  const grouped = stints.reduce((acc, stint) => {
    const key = `${stint.player_id}:${stint.character_id}`
    acc[key] = acc[key] || []
    acc[key].push(stint)
    return acc
  }, {})

  return Object.values(grouped).flatMap((group) => {
    if (group.length === 1) return group
    const meaningful = group.filter(isMeaningfulPitchingStint)
    if (meaningful.length) return meaningful
    return [group[group.length - 1]]
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
}

export function buildDisplayedPitchingStints(stints, playerId, expectedCharacterId) {
  const deduped = dedupePitchingStints(stints)
  const meaningful = deduped.filter(isMeaningfulPitchingStint)
  if (expectedCharacterId && !meaningful.some((stint) => Number(stint.character_id) === expectedCharacterId)) {
    const existingStint = deduped.find((stint) => Number(stint.character_id) === expectedCharacterId)
    meaningful.push(existingStint || {
      player_id: playerId,
      character_id: expectedCharacterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    })
  }
  return meaningful
}
