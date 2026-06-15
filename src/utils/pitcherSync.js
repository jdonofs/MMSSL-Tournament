import { fetchTeamLineup } from './teamLineups'
import { buildOddsGenerationContext } from './oddsContext'
import { buildBettingEntityLabel, mergeOddsWithExistingRows, recalculateOdds } from './oddsEngine'
import { persistOddsRowsWithFallback } from './oddsPersistence'

// Mirrors Scorebook's changePitcher, but runs without a Scorebook session
// open. A lineup edit (e.g. from Roster/SeasonRoster) only writes to
// team_lineups — nothing else picks up the pitching change unless a
// scorekeeper has Scorebook open for that game. This keeps pitching_stints
// / k_prop odds in sync with each team's lineup-designated pitcher, even
// before that team has taken the mound (so the not-yet-pitching team's prop
// reflects their current starter rather than a roster default).
export async function syncTeamPitcherFromLineup({
  supabase,
  game,
  playerId,
  teamLineupsTable,
  sourceId,
  pitchingTable,
  oddsTable,
  betsTable,
  gamePAs,
  gamePitching,
  charactersById,
  playersById,
  draftPicks,
  allGames,
  allPAs,
  allPitching,
  stadiumsById,
  stadiumGameLog,
  currentInning,
  scores,
  bets,
  addSourceFields = (row) => row,
}) {
  if (!playerId) return null

  const saved = await fetchTeamLineup({ ...teamLineupsTable, sourceId, playerId })
  const desiredCharId = saved?.fieldingPositions?.pitcher ? Number(saved.fieldingPositions.pitcher) : null
  if (!desiredCharId) return null

  const stints = gamePitching.filter((entry) => String(entry.player_id) === String(playerId))
  const latest = stints[stints.length - 1]
  if (latest && Number(latest.character_id) === desiredCharId) return null

  const newStint = {
    game_id: game.id,
    player_id: playerId,
    character_id: desiredCharId,
    innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0,
  }
  const { data, error } = await supabase.from(pitchingTable).insert(addSourceFields(newStint)).select().single()
  if (error) throw error

  const nextPitching = data ? [...gamePitching, data] : gamePitching
  const generationContext = buildOddsGenerationContext({
    game, draftPicks, charactersById, gamePAs, gamePitching: nextPitching,
    allGames, allPAs, allPitching, stadiumsById, stadiumGameLog, playersById, currentInning, scores, bets,
  })

  const { data: currentOdds } = await supabase.from(oddsTable).select('*').eq('game_id', game.id)

  const changedRows = recalculateOdds(currentOdds || [], {
    pitcherSwap: true,
    generationContext: generationContext
      ? { ...generationContext, weights: { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 } }
      : null,
  })

  if (changedRows.length) {
    const payload = mergeOddsWithExistingRows(changedRows, currentOdds || []).map((row) => (
      Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined))
    ))
    const toUpdate = Object.values(
      payload.filter((row) => row.id != null).reduce((acc, row) => { acc[row.id] = row; return acc }, {}),
    )
    const toInsert = Object.values(
      payload.filter((row) => row.id == null).reduce((acc, row) => {
        acc[`${row.bet_type}::${row.target_entity || 'game'}`] = row
        return acc
      }, {}),
    )
    await persistOddsRowsWithFallback({ supabase, table: oddsTable, updates: toUpdate, inserts: toInsert })
  }

  // The old pitcher can no longer rack up strikeouts — if nobody has bet on
  // their k_prop yet, remove it entirely instead of leaving it locked.
  if (latest && Number(latest.character_id) !== desiredCharId) {
    const oldChar = charactersById[latest.character_id]
    const oldPlayer = playersById[latest.player_id]
    const oldLabel = oldChar ? buildBettingEntityLabel(oldChar, oldPlayer) : null
    const staleKProp = oldLabel
      ? (currentOdds || []).find((row) => row.bet_type === 'k_prop' && row.target_entity === oldLabel)
      : null
    if (staleKProp?.id) {
      const { data: relatedBets } = await supabase.from(betsTable).select('id').eq('game_odds_id', staleKProp.id).limit(1)
      if (!relatedBets || relatedBets.length === 0) {
        await supabase.from(oddsTable).delete().eq('id', staleKProp.id)
      }
    }
  }

  return data
}

// Runs syncTeamPitcherFromLineup for both teams in a game, sequentially so
// the second team's odds-generation context sees the first team's new stint.
export async function syncGamePitchersFromLineups(params) {
  const results = []
  let gamePitching = params.gamePitching
  for (const playerId of [params.game.team_a_player_id, params.game.team_b_player_id]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await syncTeamPitcherFromLineup({ ...params, playerId, gamePitching })
    if (result) {
      results.push(result)
      gamePitching = [...gamePitching, result]
    }
  }
  return results
}
