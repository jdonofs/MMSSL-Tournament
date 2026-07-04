import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import {
  aggregateGameHistoryByEvent,
  buildCharacterGameHistory,
  buildCharacterPitchingGameHistory,
  summarizeBatting,
  summarizePitching,
} from '../utils/statsCalculator'
import { buildExpectedOutcomeModel } from '../utils/expectedStats'

const EMPTY_BATTING = {
  games: 0, plateAppearances: 0, atBats: 0, hits: 0, singles: 0, doubles: 0, triples: 0,
  homeRuns: 0, walks: 0, hbp: 0, strikeouts: 0, sacFlies: 0, sacBunts: 0, totalBases: 0,
  runs: 0, rbi: 0, avg: 0, obp: 0, slg: 0, ops: 0, rawPas: [],
}

const EMPTY_PITCHING = {
  innings: 0, wins: 0, losses: 0, saves: 0, strikeouts: 0, era: 0, whip: 0, kPer3: 0,
  games: 0, completeGames: 0, shutouts: 0, hitsAllowed: 0, runsAllowed: 0, earnedRuns: 0,
  walks: 0, homeRunsAllowed: 0, hrPer3: 0, rawPas: [], rawStints: [],
}

const profileDataCache = new Map()

function buildBattingSummary(plateAppearances = []) {
  if (!plateAppearances.length) return EMPTY_BATTING
  const batting = summarizeBatting(plateAppearances)
  batting.ops = batting.obp + batting.slg
  batting.rawPas = plateAppearances
  return batting
}

function buildPitchingSummary(stints = [], plateAppearances = []) {
  if (!stints.length && !plateAppearances.length) return EMPTY_PITCHING
  return { ...summarizePitching(stints), rawStints: stints, rawPas: plateAppearances }
}

function getCacheKey(characterId, currentContext) {
  if (!characterId) return 'unknown'
  const contextType = currentContext?.type || 'none'
  const contextId = currentContext?.id || 'none'
  return `${characterId}:${contextType}:${contextId}`
}

function dedupeRows(rows = []) {
  const byId = new Map()
  rows.forEach((row) => {
    const key = row?.id != null ? String(row.id) : JSON.stringify(row)
    if (!byId.has(key)) byId.set(key, row)
  })
  return [...byId.values()]
}

function buildPitchingHistory({
  tournamentPlateAppearances = [], seasonPlateAppearances = [], tournamentStints = [],
  seasonStints = [], games = [], tournaments = [], seasons = [],
}) {
  const gameById = Object.fromEntries(games.map((game) => [String(game.id), game]))
  const tournamentById = Object.fromEntries(tournaments.map((t) => [String(t.id), t]))
  const seasonById = Object.fromEntries(seasons.map((s) => [String(s.id), s]))

  const tournamentStintsById = {}
  tournamentStints.forEach((stint) => {
    const game = gameById[String(stint.game_id)]
    const tournamentId = game?.tournament_id
    if (!tournamentId) return
    const key = String(tournamentId)
    if (!tournamentStintsById[key]) tournamentStintsById[key] = []
    tournamentStintsById[key].push(stint)
  })

  const seasonStintsById = {}
  seasonStints.forEach((stint) => {
    const seasonId = stint.season_id
    if (!seasonId) return
    const key = String(seasonId)
    if (!seasonStintsById[key]) seasonStintsById[key] = []
    seasonStintsById[key].push(stint)
  })

  const tournamentPasById = {}
  tournamentPlateAppearances.forEach((pa) => {
    const game = gameById[String(pa.game_id)]
    const tournamentId = game?.tournament_id
    if (!tournamentId) return
    const key = String(tournamentId)
    if (!tournamentPasById[key]) tournamentPasById[key] = []
    tournamentPasById[key].push(pa)
  })

  const seasonPasById = {}
  seasonPlateAppearances.forEach((pa) => {
    const seasonId = pa.season_id
    if (!seasonId) return
    const key = String(seasonId)
    if (!seasonPasById[key]) seasonPasById[key] = []
    seasonPasById[key].push(pa)
  })

  const tournamentHistory = Object.entries(tournamentStintsById).map(([tournamentId, stints]) => {
    const tournament = tournamentById[tournamentId]
    const rawPas = tournamentPasById[tournamentId] || []
    return {
      sourceId: `tournament-${tournamentId}`,
      sourceLabel: `Tournament ${tournament?.tournament_number ?? tournamentId}`,
      sourceType: 'tournament',
      sortGroup: 0,
      sortValue: Number(tournament?.tournament_number || 0),
      tournamentId,
      tournamentNumber: tournament?.tournament_number ?? '?',
      ...buildPitchingSummary(stints, rawPas),
    }
  })

  const seasonHistory = Object.entries(seasonStintsById).map(([seasonId, stints]) => {
    const season = seasonById[seasonId]
    const rawPas = seasonPasById[seasonId] || []
    return {
      sourceId: `season-${seasonId}`,
      sourceLabel: season?.name || `Season ${seasonId}`,
      sourceType: 'season',
      sortGroup: 1,
      sortValue: new Date(season?.created_at || 0).getTime(),
      seasonId,
      ...buildPitchingSummary(stints, rawPas),
    }
  })

  return [...tournamentHistory, ...seasonHistory]
}

function buildCurrentBattingSummary({ currentContext, tournamentPlateAppearances, seasonPlateAppearances, games }) {
  if (!currentContext?.id || !currentContext?.type) return EMPTY_BATTING
  if (currentContext.type === 'season') {
    return buildBattingSummary(
      seasonPlateAppearances.filter((pa) => String(pa.season_id) === String(currentContext.id)),
    )
  }
  const currentGameIds = new Set(
    games.filter((game) => String(game.tournament_id) === String(currentContext.id)).map((game) => String(game.id)),
  )
  return buildBattingSummary(tournamentPlateAppearances.filter((pa) => currentGameIds.has(String(pa.game_id))))
}

function buildCurrentPitchingSummary({ currentContext, tournamentPlateAppearances, seasonPlateAppearances, tournamentStints, seasonStints, games }) {
  if (!currentContext?.id || !currentContext?.type) return EMPTY_PITCHING
  if (currentContext.type === 'season') {
    const currentPas = seasonPlateAppearances.filter((pa) => String(pa.season_id) === String(currentContext.id))
    const currentStints = seasonStints.filter((stint) => String(stint.season_id) === String(currentContext.id))
    return buildPitchingSummary(currentStints, currentPas)
  }
  const currentGameIds = new Set(
    games.filter((game) => String(game.tournament_id) === String(currentContext.id)).map((game) => String(game.id)),
  )
  return buildPitchingSummary(
    tournamentStints.filter((stint) => currentGameIds.has(String(stint.game_id))),
    tournamentPlateAppearances.filter((pa) => currentGameIds.has(String(pa.game_id))),
  )
}

function createDefaultProfileData() {
  return {
    loading: false,
    errorMessage: '',
    currentTournamentBatting: EMPTY_BATTING,
    currentTournamentPitching: EMPTY_PITCHING,
    allTimeBatting: EMPTY_BATTING,
    allTimePitching: EMPTY_PITCHING,
    battingHistory: [],
    pitchingHistory: [],
    gameHistory: null,
    pitchingGameHistory: [],
    fieldingGameHistory: [],
    allPitches: [],
    expectedOutcomeModel: null,
  }
}

function createInitialProfileData(cacheKey, fullPreset) {
  if (fullPreset) {
    // expectedOutcomeModel carries a closure (its `estimate` function), which router nav state
    // can't hold (history.pushState requires structured-cloneable values) — callers pass the raw
    // league batted-ball sample instead, and the model is rebuilt here from plain, serializable data.
    const { leagueBattedBallsForModel, ...rest } = fullPreset
    const expectedOutcomeModel = leagueBattedBallsForModel
      ? buildExpectedOutcomeModel(leagueBattedBallsForModel)
      : (fullPreset.expectedOutcomeModel ?? null)
    return { ...createDefaultProfileData(), ...rest, expectedOutcomeModel, loading: false, errorMessage: '' }
  }
  const cached = profileDataCache.get(cacheKey)
  return cached ? { ...cached, loading: false, errorMessage: '' } : createDefaultProfileData()
}

// Loads everything CharacterPage needs for one character: boxscore summaries,
// gamelogs, and a league-wide expected-outcome model for xBA/xSLG/xwOBA.
//
// `options.fullPreset` lets a page that already has the *complete* profile in memory
// (Stats.jsx, which bulk-computes every character's full stat line up front) hand it
// off via router state and skip the fetch entirely.
//
// `options.gameHistory`/`pitchingGameHistory`/`fieldingGameHistory` are narrower
// overrides for pages (Roster, SeasonRoster, Draft, Scorebook) that only have
// roster-wide *gamelogs* precomputed, not full boxscore summaries — those pages still
// need this hook to fetch stats/xStats, but should splice in their own gamelogs rather
// than the ones recomputed below, since talent/OVR percentiles are relative to the rest
// of the roster and a lone single-character fetch can't see teammates to compare against.
export default function useCharacterProfileData(character, currentContext, options = {}) {
  const { fullPreset = null, gameHistory: gameHistoryOverride = null, pitchingGameHistory: pitchingGameHistoryOverride = null, fieldingGameHistory: fieldingGameHistoryOverride = null } = options
  const cacheKey = getCacheKey(character?.id, currentContext)
  const [profileData, setProfileData] = useState(() => createInitialProfileData(cacheKey, fullPreset))

  useEffect(() => {
    setProfileData(createInitialProfileData(cacheKey, fullPreset))
  }, [cacheKey])

  useEffect(() => {
    if (fullPreset) return undefined
    if (!character?.id) {
      setProfileData((current) => ({ ...current, loading: false, errorMessage: 'Character data is unavailable.' }))
      return undefined
    }

    let cancelled = false

    const load = async () => {
      setProfileData((current) => ({ ...current, loading: true, errorMessage: '' }))

      const [
        tournamentBattingResult, tournamentPitchingPasResult, seasonBattingResult, seasonPitchingPasResult,
        tournamentStintsResult, seasonStintsResult, gamesResult, tournamentsResult, seasonsResult,
        batterPitchesResult, pitcherPitchesResult, seasonBatterPitchesResult, seasonPitcherPitchesResult,
        leagueTournamentPasResult, leagueSeasonPasResult,
      ] = await Promise.all([
        supabase.from('plate_appearances').select('*').eq('character_id', character.id),
        supabase.from('plate_appearances').select('*').eq('pitcher_id', character.id),
        supabase.from('season_plate_appearances').select('*').eq('character_id', character.id),
        supabase.from('season_plate_appearances').select('*').eq('pitcher_id', character.id),
        supabase.from('pitching_stints').select('*').eq('character_id', character.id),
        supabase.from('season_pitching_stints').select('*').eq('character_id', character.id),
        supabase.from('games').select('id,tournament_id'),
        supabase.from('tournaments').select('id,tournament_number').order('tournament_number'),
        supabase.from('seasons').select('id,name,created_at').order('created_at'),
        supabase.from('pitches').select('*').eq('batter_id', character.name),
        supabase.from('pitches').select('*').eq('pitcher_id', character.name),
        supabase.from('season_pitches').select('*').eq('batter_id', character.name),
        supabase.from('season_pitches').select('*').eq('pitcher_id', character.name),
        supabase.from('plate_appearances').select('result,exit_velocity_mph,launch_angle_deg,star_hit_used'),
        supabase.from('season_plate_appearances').select('result,exit_velocity_mph,launch_angle_deg,star_hit_used'),
      ])

      const results = [
        tournamentBattingResult, tournamentPitchingPasResult, seasonBattingResult, seasonPitchingPasResult,
        tournamentStintsResult, seasonStintsResult, gamesResult, tournamentsResult, seasonsResult,
        batterPitchesResult, pitcherPitchesResult, seasonBatterPitchesResult, seasonPitcherPitchesResult,
        leagueTournamentPasResult, leagueSeasonPasResult,
      ]
      const failedResult = results.find((result) => result.error)

      if (failedResult?.error) {
        if (!cancelled) {
          setProfileData((current) => ({
            ...current, loading: false, errorMessage: failedResult.error.message || 'Failed to load character stats.',
          }))
        }
        return
      }

      const tournamentBattingPas = tournamentBattingResult.data || []
      const tournamentPitchingPas = tournamentPitchingPasResult.data || []
      const seasonBattingPas = seasonBattingResult.data || []
      const seasonPitchingPas = seasonPitchingPasResult.data || []
      const tournamentStints = tournamentStintsResult.data || []
      const seasonStints = seasonStintsResult.data || []
      const games = gamesResult.data || []
      const tournaments = tournamentsResult.data || []
      const seasons = seasonsResult.data || []

      let gameHistory = gameHistoryOverride
      if (gameHistory === null) {
        const gameHistoryByCharacter = buildCharacterGameHistory(tournamentBattingPas, games, tournaments, seasonBattingPas, seasons)
        gameHistory = gameHistoryByCharacter[character.id] || []
      }
      const battingHistory = aggregateGameHistoryByEvent(gameHistory)

      let pitchingGameHistory = pitchingGameHistoryOverride
      if (pitchingGameHistory === null) {
        const pitchingGameHistoryByCharacter = buildCharacterPitchingGameHistory(tournamentStints, games, tournaments, seasonStints, seasons)
        pitchingGameHistory = pitchingGameHistoryByCharacter[character.id] || []
      }
      const fieldingGameHistory = fieldingGameHistoryOverride ?? []

      const pitchingHistory = buildPitchingHistory({
        tournamentPlateAppearances: tournamentPitchingPas, seasonPlateAppearances: seasonPitchingPas,
        tournamentStints, seasonStints, games, tournaments, seasons,
      })

      const currentTournamentBatting = buildCurrentBattingSummary({ currentContext, tournamentPlateAppearances: tournamentBattingPas, seasonPlateAppearances: seasonBattingPas, games })
      const currentTournamentPitching = buildCurrentPitchingSummary({ currentContext, tournamentPlateAppearances: tournamentPitchingPas, seasonPlateAppearances: seasonPitchingPas, tournamentStints, seasonStints, games })

      const allTimeBatting = buildBattingSummary([...tournamentBattingPas, ...seasonBattingPas])
      const allTimePitching = buildPitchingSummary([...tournamentStints, ...seasonStints], [...tournamentPitchingPas, ...seasonPitchingPas])
      const allPitches = dedupeRows([
        ...(batterPitchesResult.data || []), ...(pitcherPitchesResult.data || []),
        ...(seasonBatterPitchesResult.data || []), ...(seasonPitcherPitchesResult.data || []),
      ])

      const leagueBattedBalls = [...(leagueTournamentPasResult.data || []), ...(leagueSeasonPasResult.data || [])]
      const expectedOutcomeModel = buildExpectedOutcomeModel(leagueBattedBalls)

      const nextData = {
        currentTournamentBatting, currentTournamentPitching, allTimeBatting, allTimePitching,
        battingHistory, pitchingHistory, gameHistory, pitchingGameHistory, fieldingGameHistory,
        allPitches, expectedOutcomeModel,
      }
      profileDataCache.set(cacheKey, nextData)

      if (!cancelled) setProfileData({ loading: false, errorMessage: '', ...nextData })
    }

    load()
    return () => { cancelled = true }
  }, [character?.id, character?.name, currentContext?.id, currentContext?.type, fullPreset, gameHistoryOverride, pitchingGameHistoryOverride, fieldingGameHistoryOverride])

  return profileData
}
