import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import {
  abbreviateSeasonName,
  aggregateGameHistoryByEvent,
  buildCharacterGameHistory,
  buildCharacterPitchingGameHistory,
  computeLeagueConstants,
  enrichPasWithPitchingContext,
  summarizeBatting,
  summarizePitching,
  tagPasWithGameContext,
  tagPasWithHandedness,
  tagStintsWithPostseason,
} from '../utils/statsCalculator'
import { buildExpectedOutcomeModel } from '../utils/expectedStats'
import { buildStadiumKeyByGameId, STADIUM_GAME_LOG_SELECT, SEASON_STADIUM_GAME_LOG_SELECT } from '../utils/stadiums'
import { resolveSeasonPitchingDecisions, resolveTournamentPitchingDecisions, groupRunsByPaId } from '../utils/pitchingDecisions'
import { normalizeSeasonRowsByGameId, normalizeSeasonScheduleRows } from '../utils/seasonGameIds'

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

function buildBattingSummary(plateAppearances = [], runEvents = []) {
  if (!plateAppearances.length) return EMPTY_BATTING
  const batting = summarizeBatting(plateAppearances, runEvents)
  batting.ops = batting.obp + batting.slg
  batting.rawPas = plateAppearances
  return batting
}

function buildPitchingSummary(stints = [], plateAppearances = []) {
  if (!stints.length && !plateAppearances.length) return EMPTY_PITCHING
  return { ...summarizePitching(stints), rawStints: stints, rawPas: plateAppearances }
}

function getCacheKey(characterId, scope) {
  if (!characterId) return 'unknown'
  const scopeType = scope?.type || 'none'
  const scopeId = scope?.id || 'none'
  return `${characterId}:${scopeType}:${scopeId}`
}

function dedupeRows(rows = []) {
  const byId = new Map()
  rows.forEach((row) => {
    const sourceKey = row?.season_id != null ? 'season' : 'tournament'
    const key = row?.id != null ? `${sourceKey}:${String(row.id)}` : JSON.stringify(row)
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
      sourceLabel: `MST ${tournament?.tournament_number ?? tournamentId}`,
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
      sourceLabel: abbreviateSeasonName(season?.name) || `Season ${seasonId}`,
      sourceType: 'season',
      sortGroup: 1,
      sortValue: new Date(season?.created_at || 0).getTime(),
      seasonId,
      ...buildPitchingSummary(stints, rawPas),
    }
  })

  return [...tournamentHistory, ...seasonHistory]
}

function buildCurrentBattingSummary({ scope, tournamentPlateAppearances, seasonPlateAppearances, games, tournamentRunEvents = [], seasonRunEvents = [] }) {
  if (!scope?.id || !scope?.type) return EMPTY_BATTING
  if (scope.type === 'season') {
    const pas = seasonPlateAppearances.filter((pa) => String(pa.season_id) === String(scope.id))
    const gameIds = new Set(pas.map((pa) => String(pa.game_id)))
    return buildBattingSummary(pas, seasonRunEvents.filter((run) => gameIds.has(String(run.game_id))))
  }
  const currentGameIds = new Set(
    games.filter((game) => String(game.tournament_id) === String(scope.id)).map((game) => String(game.id)),
  )
  const pas = tournamentPlateAppearances.filter((pa) => currentGameIds.has(String(pa.game_id)))
  return buildBattingSummary(pas, tournamentRunEvents.filter((run) => currentGameIds.has(String(run.game_id))))
}

function buildCurrentPitchingSummary({ scope, tournamentPlateAppearances, seasonPlateAppearances, tournamentStints, seasonStints, games }) {
  if (!scope?.id || !scope?.type) return EMPTY_PITCHING
  if (scope.type === 'season') {
    const currentPas = seasonPlateAppearances.filter((pa) => String(pa.season_id) === String(scope.id))
    const currentStints = seasonStints.filter((stint) => String(stint.season_id) === String(scope.id))
    return buildPitchingSummary(currentStints, currentPas)
  }
  const currentGameIds = new Set(
    games.filter((game) => String(game.tournament_id) === String(scope.id)).map((game) => String(game.id)),
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
    leagueConstants: {},
    leagueBattingPas: [],
    runEvents: [],
    tournamentIdByGameId: {},
    playersById: {},
    seasonTeamsById: {},
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
export default function useCharacterProfileData(character, scope, options = {}) {
  const { fullPreset = null, gameHistory: gameHistoryOverride = null, pitchingGameHistory: pitchingGameHistoryOverride = null, fieldingGameHistory: fieldingGameHistoryOverride = null } = options
  const cacheKey = getCacheKey(character?.id, scope)
  const [profileData, setProfileData] = useState(() => createInitialProfileData(cacheKey, fullPreset))

  useEffect(() => {
    setProfileData(createInitialProfileData(cacheKey, fullPreset))
  }, [cacheKey])

  useEffect(() => {
    if (!character?.id) {
      if (!fullPreset) {
        setProfileData((current) => ({ ...current, loading: false, errorMessage: 'Character data is unavailable.' }))
      }
      return undefined
    }

    let cancelled = false

    const load = async () => {
      setProfileData((current) => ({ ...current, loading: true, errorMessage: '' }))

      const [
        tournamentBattingResult, tournamentPitchingPasResult, seasonBattingResult, seasonPitchingPasResult,
        gamesResult, tournamentsResult, seasonsResult,
        batterPitchesResult, pitcherPitchesResult, seasonBatterPitchesResult, seasonPitcherPitchesResult,
        leagueTournamentPasResult, leagueSeasonPasResult,
        leagueTournamentStintsResult, leagueSeasonStintsResult,
        seasonScheduleResult, stadiumsResult, stadiumGameLogResult, seasonStadiumGameLogResult,
        allCharactersResult, playersResult,
        tournamentRunEventsResult, seasonRunEventsResult, seasonTeamsResult,
        // Unfiltered/full-column — win/loss/save reconstruction needs every pitcher and every run
        // in a game, not just this character's own rows. See pitchingDecisions.js. This character's
        // own stints/pas are filtered back out of these below, so the per-character-scoped
        // pitching_stints fetch isn't needed separately.
        allTournamentStintsResult, allSeasonStintsResult,
        allTournamentPasResult, allSeasonPasResult,
        allTournamentRunsResult, allSeasonRunsResult,
      ] = await Promise.all([
        supabase.from('plate_appearances').select('*').eq('character_id', character.id),
        supabase.from('plate_appearances').select('*').eq('pitcher_id', character.id),
        supabase.from('season_plate_appearances').select('*').eq('character_id', character.id),
        supabase.from('season_plate_appearances').select('*').eq('pitcher_id', character.id),
        supabase.from('games').select('*'),
        supabase.from('tournaments').select('id,tournament_number').order('tournament_number'),
        supabase.from('seasons').select('id,name,created_at').order('created_at'),
        supabase.from('pitches').select('*').eq('batter_id', character.name),
        supabase.from('pitches').select('*').eq('pitcher_id', character.name),
        supabase.from('season_pitches').select('*').eq('batter_id', character.name),
        supabase.from('season_pitches').select('*').eq('pitcher_id', character.name),
        supabase.from('plate_appearances').select('result,exit_velocity_mph,launch_angle_deg,star_hit_used,hit_distance_ft,hit_stadium_key,game_id'),
        supabase.from('season_plate_appearances').select('result,exit_velocity_mph,launch_angle_deg,star_hit_used,hit_distance_ft,hit_stadium_key,game_id,season_id'),
        supabase.from('pitching_stints').select('innings_pitched,earned_runs,hits_allowed,walks,strikeouts,hr_allowed'),
        supabase.from('season_pitching_stints').select('innings_pitched,earned_runs,hits_allowed,walks,strikeouts,hr_allowed'),
        supabase.from('season_schedule').select('*'),
        supabase.from('stadiums').select('id,name'),
        supabase.from('stadium_game_log').select(STADIUM_GAME_LOG_SELECT),
        supabase.from('season_stadium_game_log').select(SEASON_STADIUM_GAME_LOG_SELECT),
        supabase.from('characters').select('id,name'),
        supabase.from('players').select('id,name,team_name,team_mascot,team_abbreviation'),
        supabase.from('runs_scored').select('*').eq('scoring_character_id', character.id),
        supabase.from('season_runs_scored').select('*').eq('scoring_character_id', character.id),
        supabase.from('season_teams').select('id,player_id,team_name,team_mascot,team_abbreviation'),
        supabase.from('pitching_stints').select('*'),
        supabase.from('season_pitching_stints').select('*'),
        supabase.from('plate_appearances').select('*'),
        supabase.from('season_plate_appearances').select('*'),
        supabase.from('runs_scored').select('*'),
        supabase.from('season_runs_scored').select('*'),
      ])

      const results = [
        tournamentBattingResult, tournamentPitchingPasResult, seasonBattingResult, seasonPitchingPasResult,
        gamesResult, tournamentsResult, seasonsResult,
        batterPitchesResult, pitcherPitchesResult, seasonBatterPitchesResult, seasonPitcherPitchesResult,
        leagueTournamentPasResult, leagueSeasonPasResult, leagueTournamentStintsResult, leagueSeasonStintsResult,
        seasonScheduleResult, stadiumsResult, stadiumGameLogResult, seasonStadiumGameLogResult,
        allCharactersResult, playersResult, tournamentRunEventsResult, seasonRunEventsResult, seasonTeamsResult,
        allTournamentStintsResult, allSeasonStintsResult, allTournamentPasResult, allSeasonPasResult,
        allTournamentRunsResult, allSeasonRunsResult,
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

      const games = gamesResult.data || []
      const tournaments = tournamentsResult.data || []
      const seasons = seasonsResult.data || []
      const seasonSchedule = seasonScheduleResult.data || []
      const stadiums = stadiumsResult.data || []
      const tournamentStadiumLog = stadiumGameLogResult.data || []
      const seasonStadiumLog = seasonStadiumGameLogResult.data || []
      const allCharacters = allCharactersResult.data || []
      const players = playersResult.data || []
      const seasonTeams = seasonTeamsResult.data || []
      const nameById = Object.fromEntries(allCharacters.map((c) => [c.id, c.name]))
      const charactersByName = Object.fromEntries(allCharacters.map((c) => [c.name, c]))
      const playerNameById = Object.fromEntries(players.map((player) => [player.id, player.name]))
      const playersById = Object.fromEntries(players.map((player) => [player.id, player]))
      const seasonTeamsById = Object.fromEntries(seasonTeams.map((team) => [team.id, team]))
      const seasonTeamPlayerIdByTeamId = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.player_id]))
      const gamesById = Object.fromEntries(games.map((g) => [g.id, g]))
      const tournamentIdByGameId = Object.fromEntries(games.map((g) => [String(g.id), g.tournament_id]))
      const seasonScheduleByGameId = Object.fromEntries(
        normalizeSeasonScheduleRows(seasonSchedule).map((scheduleRow) => [scheduleRow.id, scheduleRow]),
      )
      const gameContext = { gamesById, seasonScheduleByGameId }
      const tournamentStadiumKeyByGameId = buildStadiumKeyByGameId(games, stadiums, tournamentStadiumLog)
      const seasonStadiumKeyByGameId = buildStadiumKeyByGameId(seasonSchedule, stadiums, seasonStadiumLog)
      const normalizedSeasonBatterPitches = normalizeSeasonRowsByGameId(seasonBatterPitchesResult.data || [])
      const normalizedSeasonPitcherPitches = normalizeSeasonRowsByGameId(seasonPitcherPitchesResult.data || [])
      const normalizedTournamentBattingPas = enrichPasWithPitchingContext(tournamentBattingResult.data || [], {
        pitches: batterPitchesResult.data || [],
        charactersByName,
        stadiumKeyByGameId: tournamentStadiumKeyByGameId,
      })
      const seasonBattingPasWithContext = enrichPasWithPitchingContext(seasonBattingResult.data || [], {
        pitches: normalizedSeasonBatterPitches,
        charactersByName,
        stadiumKeyByGameId: seasonStadiumKeyByGameId,
      })
      const normalizedSeasonBattingPas = normalizeSeasonRowsByGameId(seasonBattingPasWithContext)

      // Tagged with isHome/isPostseason/pitcherHandedness/batterHandedness so downstream summaries
      // (rawPas on every batting/pitching line) can feed straight into summarizeBattingSplits/
      // summarizePitchingSplits without a separate fetch — see statsCalculator.js.
      const tournamentBattingPas = tagPasWithHandedness(tagPasWithGameContext(normalizedTournamentBattingPas, [], gameContext), nameById)
      const seasonBattingPas = tagPasWithHandedness(tagPasWithGameContext([], normalizedSeasonBattingPas, gameContext), nameById)
      const tournamentPitchingPas = tagPasWithHandedness(tagPasWithGameContext(
        enrichPasWithPitchingContext(tournamentPitchingPasResult.data || [], {
          pitches: pitcherPitchesResult.data || [],
          charactersByName,
          stadiumKeyByGameId: tournamentStadiumKeyByGameId,
        }),
        [],
        gameContext,
      ), nameById)
      const seasonPitchingPasWithContext = enrichPasWithPitchingContext(seasonPitchingPasResult.data || [], {
        pitches: normalizedSeasonPitcherPitches,
        charactersByName,
        seasonTeamPlayerById: {},
        stadiumKeyByGameId: seasonStadiumKeyByGameId,
      })
      const seasonPitchingPas = tagPasWithHandedness(tagPasWithGameContext(
        [],
        normalizeSeasonRowsByGameId(seasonPitchingPasWithContext),
        gameContext,
      ), nameById)
      // A pitching_stints row is created the moment a pitcher takes the mound (Scorebook's
      // mound-assignment bookkeeping), before they've necessarily thrown a pitch — if pulled again
      // without facing a batter, that stint sits at 0 IP forever but would still count as a "game"
      // pitched. Drop stints with no matching row in this character's own pitches fetch (already
      // scoped to `pitcher_id === character.name` by the query above) for that game. Historical/
      // imported stints have no pitch-log rows at all, so also keep any stint with a recorded
      // innings_pitched > 0 — that's real evidence of an outing.
      const tournamentGameIdsWithPitches = new Set((pitcherPitchesResult.data || []).map((p) => String(p.game_id)))
      const seasonGameIdsWithPitches = new Set(normalizedSeasonPitcherPitches.map((pitch) => String(pitch.game_id)))

      // Resolve win/loss/save league-wide (see pitchingDecisions.js) before narrowing down to
      // this character's own stints — the decision for a game depends on every pitcher and every
      // run in that game, not just this character's rows, and most games never had these flags
      // stamped onto the DB row at all (only games completed live through Scorebook did).
      const tournamentRunsByPaId = groupRunsByPaId(allTournamentRunsResult.data || [])
      const seasonRunsByPaId = groupRunsByPaId(allSeasonRunsResult.data || [])
      const resolvedTournamentStints = resolveTournamentPitchingDecisions(
        allTournamentStintsResult.data || [], games, allTournamentPasResult.data || [], tournamentRunsByPaId,
      )
      const resolvedSeasonStints = normalizeSeasonRowsByGameId(resolveSeasonPitchingDecisions(
        allSeasonStintsResult.data || [], seasonSchedule, allSeasonPasResult.data || [], seasonRunsByPaId, seasonTeamPlayerIdByTeamId,
      ))

      const tournamentStints = tagStintsWithPostseason(
        resolvedTournamentStints.filter((s) => String(s.character_id) === String(character.id)
          && (tournamentGameIdsWithPitches.has(String(s.game_id)) || Number(s.innings_pitched) > 0)), [], gameContext,
      )
      const seasonStints = tagStintsWithPostseason(
        [], resolvedSeasonStints.filter((s) => String(s.character_id) === String(character.id)
          && (seasonGameIdsWithPitches.has(String(s.game_id)) || Number(s.innings_pitched) > 0)), gameContext,
      )

      let gameHistory = gameHistoryOverride
      if (gameHistory === null) {
        const gameHistoryByCharacter = buildCharacterGameHistory(tournamentBattingPas, games, tournaments, seasonBattingPas, seasons)
        gameHistory = gameHistoryByCharacter[character.id] || []
      }
      const battingHistory = aggregateGameHistoryByEvent(gameHistory)

      let pitchingGameHistory = pitchingGameHistoryOverride
      if (pitchingGameHistory === null) {
        const pitchingGameHistoryByCharacter = buildCharacterPitchingGameHistory(tournamentStints, games, tournaments, seasonStints, seasons, null, playerNameById)
        pitchingGameHistory = pitchingGameHistoryByCharacter[character.id] || []
      }
      const fieldingGameHistory = fieldingGameHistoryOverride ?? []

      const pitchingHistory = buildPitchingHistory({
        tournamentPlateAppearances: tournamentPitchingPas, seasonPlateAppearances: seasonPitchingPas,
        tournamentStints, seasonStints, games, tournaments, seasons,
      })

      const tournamentRunEvents = tournamentRunEventsResult.data || []
      const seasonRunEvents = normalizeSeasonRowsByGameId(seasonRunEventsResult.data || [])

      const currentTournamentBatting = buildCurrentBattingSummary({
        scope, tournamentPlateAppearances: tournamentBattingPas, seasonPlateAppearances: seasonBattingPas, games,
        tournamentRunEvents, seasonRunEvents,
      })
      const currentTournamentPitching = buildCurrentPitchingSummary({ scope, tournamentPlateAppearances: tournamentPitchingPas, seasonPlateAppearances: seasonPitchingPas, tournamentStints, seasonStints, games })

      const allTimeBatting = buildBattingSummary([...tournamentBattingPas, ...seasonBattingPas], [...tournamentRunEvents, ...seasonRunEvents])
      const allTimePitching = buildPitchingSummary([...tournamentStints, ...seasonStints], [...tournamentPitchingPas, ...seasonPitchingPas])
      const allPitches = dedupeRows([
        ...(batterPitchesResult.data || []), ...(pitcherPitchesResult.data || []),
        ...normalizedSeasonBatterPitches, ...normalizedSeasonPitcherPitches,
      ])

      const leagueBattedBalls = [...(leagueTournamentPasResult.data || []), ...normalizeSeasonRowsByGameId(leagueSeasonPasResult.data || [])]
      const expectedOutcomeModel = buildExpectedOutcomeModel(leagueBattedBalls)
      const leagueStints = [...(leagueTournamentStintsResult.data || []), ...(leagueSeasonStintsResult.data || [])]
      const leagueConstants = computeLeagueConstants(leagueBattedBalls, leagueStints)

      const nextData = {
        currentTournamentBatting, currentTournamentPitching, allTimeBatting, allTimePitching,
        battingHistory, pitchingHistory, gameHistory, pitchingGameHistory, fieldingGameHistory,
        allPitches, expectedOutcomeModel, leagueConstants, leagueBattingPas: leagueBattedBalls,
        runEvents: [...tournamentRunEvents, ...seasonRunEvents],
        tournamentIdByGameId,
        playersById, seasonTeamsById,
      }
      profileDataCache.set(cacheKey, nextData)

      if (!cancelled) setProfileData({ loading: false, errorMessage: '', ...nextData })
    }

    // Even when seeded from a preset (Stats.jsx's fast nav-state path skips
    // the initial fetch below), stay live — an at-bat edit made elsewhere
    // should still refresh this profile instead of leaving it frozen on
    // the snapshot for the rest of the visit.
    if (!fullPreset) load()

    // Re-fetch when at-bat data changes elsewhere (e.g. an edit on AtBatPage
    // or Scorebook), so this profile doesn't show stale stats if it's left
    // open in a background tab while another view edits the same rows.
    const channel = supabase
      .channel(`character-profile-${cacheKey}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runs_scored' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_runs_scored' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitches' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints' }, load)
      .subscribe()

    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [character?.id, character?.name, scope?.id, scope?.type, fullPreset, gameHistoryOverride, pitchingGameHistoryOverride, fieldingGameHistoryOverride])

  return profileData
}
