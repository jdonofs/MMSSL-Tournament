// Narrow, shared boundary between persisted game data and official statistics.
//
// Live tracker summaries are intentionally not inputs here. They are a scorebook display
// projection; stats come from durable PA, pitch, run, stint and fielder rows.
// Consumers can opt into active games when showing live totals. Historical/profile callers
// retain completed-only totals, and abandoned/excluded games never enter either view.

const COMPLETE_STATUSES = new Set(['complete', 'completed'])
const ACTIVE_STATUSES = new Set(['active', 'in_progress'])

export function isCompletedStatGame(game = {}) {
  return COMPLETE_STATUSES.has(String(game.status || '').toLowerCase())
}

export function getStatCompetitionSource(row = {}) {
  if (row.__stat_source === 'season' || row.competition_type === 'season') return 'season'
  if (row.__stat_source === 'tournament' || row.competition_type === 'tournament') return 'tournament'
  if (row.season_id != null) return 'season'
  return String(row.game_id ?? '').startsWith('season-') ? 'season' : 'tournament'
}

export function getStatGameKey(row = {}) {
  return `${getStatCompetitionSource(row)}:${String(row.game_id ?? row.id ?? '')}`
}

export function getStatPaKey(row = {}) {
  return `${getStatCompetitionSource(row)}:${String(row.pa_id ?? row.id ?? '')}`
}

function rowQuality(row = {}) {
  const persisted = row.id != null && !row.is_live_summary && row.row_kind !== 'summary' ? 2 : 0
  const updated = new Date(row.updated_at || row.created_at || 0).getTime()
  return [persisted, Number.isFinite(updated) ? updated : 0, Number(row.id) || 0]
}

function preferRow(current, candidate) {
  if (!current) return candidate
  const currentPersisted = current.id != null && !current.is_live_summary && current.row_kind !== 'summary'
  const candidatePersisted = candidate.id != null && !candidate.is_live_summary && candidate.row_kind !== 'summary'
  if (currentPersisted !== candidatePersisted) return candidatePersisted ? candidate : current
  // A repeated insert with a new id must not strand pitches/runs that still reference the
  // original PA. Updates to a persisted fact retain its id, so the earliest durable identity is
  // the safe canonical parent when two ids claim the same tracker natural key.
  if (currentPersisted && candidatePersisted && current.id !== candidate.id) {
    const currentId = Number(current.id)
    const candidateId = Number(candidate.id)
    if (Number.isFinite(currentId) && Number.isFinite(candidateId)) return candidateId < currentId ? candidate : current
  }
  const currentQuality = rowQuality(current)
  const candidateQuality = rowQuality(candidate)
  for (let index = 0; index < currentQuality.length; index += 1) {
    if (candidateQuality[index] !== currentQuality[index]) {
      return candidateQuality[index] > currentQuality[index] ? candidate : current
    }
  }
  return current
}

function naturalKey(row, kind, index) {
  const source = getStatCompetitionSource(row)
  const gameKey = getStatGameKey(row)

  if (kind === 'plateAppearances') {
    if (row.tracker_contact_seq != null) return `${gameKey}:contact:${row.tracker_contact_seq}`
    if (row.id != null) return `${source}:id:${row.id}`
    if (row.pa_number != null) return `${gameKey}:pa:${row.pa_number}`
  }

  if (kind === 'pitches') {
    if (row.pa_id != null && row.pitch_number_pa != null) {
      return `${getStatPaKey(row)}:pitch:${row.pitch_number_pa}`
    }
    if (row.id != null) return `${source}:id:${row.id}`
  }

  if (kind === 'runs') {
    if (row.pa_id != null && (row.scoring_player_id != null || row.scoring_character_id != null)) {
      return `${getStatPaKey(row)}:run:${String(row.scoring_player_id ?? '')}:${String(row.scoring_character_id ?? '')}`
    }
    if (row.id != null) return `${source}:id:${row.id}`
  }

  // Multiple stints by the same pitcher, including a re-entry or a zero-out appearance, are
  // legitimate. Fielder spans can repeat after a substitution. Only their durable row identity
  // is safe to deduplicate.
  if (row.id != null) return `${source}:id:${row.id}`
  return `${source}:unkeyed:${index}`
}

export function dedupeStatRows(rows = [], kind = 'rows') {
  const byKey = new Map()
  rows.forEach((row, index) => {
    const key = naturalKey(row, kind, index)
    byKey.set(key, preferRow(byKey.get(key), row))
  })
  return [...byKey.values()]
}

export function reconcileStatSource({
  games = [],
  plateAppearances = [],
  pitchingStints = [],
  pitches = [],
  runs = [],
  gameFielders = [],
  includeActiveGames = false,
} = {}) {
  const selectedGames = games.filter((game) => isCompletedStatGame(game)
    || (includeActiveGames && ACTIVE_STATUSES.has(String(game.status || '').toLowerCase())))
  const selectedGameKeys = new Set(selectedGames.map(getStatGameKey))

  const select = (rows, kind) => {
    const deduped = dedupeStatRows(rows, kind)
    const selected = deduped.filter((row) => selectedGameKeys.has(getStatGameKey(row)))
    return {
      rows: selected,
      coverage: {
        input: rows.length,
        deduplicated: rows.length - deduped.length,
        excludedNonFinalOrOrphaned: deduped.length - selected.length,
        included: selected.length,
      },
    }
  }

  const pa = select(plateAppearances, 'plateAppearances')
  const stint = select(pitchingStints, 'pitchingStints')
  const pitch = select(pitches, 'pitches')
  const run = select(runs, 'runs')
  const fielder = select(gameFielders, 'gameFielders')

  return {
    games: selectedGames,
    plateAppearances: pa.rows,
    pitchingStints: stint.rows,
    pitches: pitch.rows,
    runs: run.rows,
    gameFielders: fielder.rows,
    coverage: {
      games: {
        input: games.length,
        included: selectedGames.length,
        excludedNonFinal: games.length - selectedGames.length,
      },
      plateAppearances: pa.coverage,
      pitchingStints: stint.coverage,
      pitches: pitch.coverage,
      runs: run.coverage,
      gameFielders: fielder.coverage,
    },
  }
}

// PA ids are independently allocated in tournament and season tables. A bare Set of pa_id values
// therefore cross-selects pitches when the two tables happen to share a numeric id.
export function selectPitchesForPlateAppearances(pitches = [], plateAppearances = []) {
  const paKeys = new Set(plateAppearances.map((pa) => getStatPaKey(pa)))
  return dedupeStatRows(pitches, 'pitches').filter((pitch) => paKeys.has(getStatPaKey(pitch)))
}

export function filterRunEventsForPlateAppearances(runEvents = [], plateAppearances = []) {
  const gameKeys = new Set(plateAppearances.map(getStatGameKey))
  return dedupeStatRows(runEvents, 'runs').filter((run) => gameKeys.has(getStatGameKey(run)))
}

export function selectStatRowsForScope({
  tournamentRows = [],
  seasonRows = [],
  tournamentGames = [],
  seasonGames = [],
  sourceMode = 'all',
  tournamentId = null,
  seasonId = null,
} = {}) {
  if (sourceMode === 'all') return [...tournamentRows, ...seasonRows]
  const rows = sourceMode === 'seasons' ? seasonRows : tournamentRows
  const games = sourceMode === 'seasons' ? seasonGames : tournamentGames
  const selectedCompetitionId = sourceMode === 'seasons' ? seasonId : tournamentId
  const competitionByGameKey = new Map(games.map((game) => [
    getStatGameKey(game),
    game.season_id ?? game.tournament_id,
  ]))
  return rows.filter((row) => (
    String(competitionByGameKey.get(getStatGameKey(row))) === String(selectedCompetitionId)
  ))
}
