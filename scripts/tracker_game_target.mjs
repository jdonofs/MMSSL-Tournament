export const TRACKER_GAME_SOURCES = Object.freeze([
  { gamesTable: 'games', statsTable: 'tracker_live_stats', rosterTable: 'draft_picks', openStatuses: ['pending', 'active'] },
  { gamesTable: 'season_schedule', statsTable: 'season_tracker_live_stats', rosterTable: 'season_roster', openStatuses: ['scheduled', 'in_progress'] },
])

// `games` and `season_schedule` number their rows independently, so one
// integer can name a tournament game and a season game at the same time.
// Searching the two in a fixed order and returning the first hit is not a
// choice, it is a coin already flipped -- and it is flipped separately by this
// bridge, by scripts/export_mss_lineup.mjs and by scripts/mss_autogame.mjs, so
// three processes can disagree about which game is being played. `gamesTable`
// carries the picker's answer through; without one, a shared id is refused
// rather than guessed.
export async function resolveTrackerGameTarget(supabase, { gameId = null, gamesTable = null, sources = TRACKER_GAME_SOURCES } = {}) {
  if (gamesTable && !sources.some((source) => source.gamesTable === gamesTable)) {
    throw new Error(`Unknown games table "${gamesTable}"; expected one of ${sources.map((s) => s.gamesTable).join(', ')}.`)
  }
  if (gameId != null) {
    const found = []
    for (const source of sources) {
      if (gamesTable && source.gamesTable !== gamesTable) continue
      const { data, error } = await supabase.from(source.gamesTable).select('*').eq('id', gameId).maybeSingle()
      if (error) throw error
      if (data) found.push({ row: data, source })
    }
    if (found.length > 1) {
      throw new Error(`Game id ${gameId} exists in both ${found.map(({ source }) => source.gamesTable).join(' and ')}. Set TRACKER_GAME_TABLE to say which.`)
    }
    if (found.length === 1) {
      const [{ row: data, source }] = found
      if (data.stats_source !== 'tracker') {
        throw new Error(`Game ${gameId} (${source.gamesTable}) is not set to stats_source='tracker' on the site yet.`)
      }
      if (!source.openStatuses.includes(data.status)) {
        throw new Error(`Game ${gameId} (${source.gamesTable}) is not open for tracker writes (status=${data.status}).`)
      }
      return { row: data, source }
    }
    throw new Error(`No game with id ${gameId} in ${gamesTable || 'games or season_schedule'}.`)
  }

  const candidates = []
  for (const source of sources) {
    if (gamesTable && source.gamesTable !== gamesTable) continue
    const { data, error } = await supabase.from(source.gamesTable).select('*')
      .eq('stats_source', 'tracker').in('status', source.openStatuses)
    if (error) throw error
    for (const row of data || []) candidates.push({ row, source })
  }
  if (!candidates.length) {
    throw new Error("No game is set to stats_source='tracker' right now. Toggle a game into Tracker mode on the site first, or set TRACKER_GAME_ID.")
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple games are in Tracker mode (${candidates.map(({ row }) => row.id).join(', ')}). Set TRACKER_GAME_ID to disambiguate.`)
  }
  return candidates[0]
}
