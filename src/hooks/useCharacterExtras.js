import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import {
  abbreviateSeasonName,
  aggregateFieldingHistoryByEvent,
  aggregateFieldingHistoryByEventAndPosition,
  aggregateGameHistoryByEvent,
  aggregatePitchingHistoryByEvent,
  buildCharacterFieldingGameHistory,
  buildFieldingGameEventMeta,
  buildCharacterGameHistory,
  buildCharacterIntrinsics,
  buildCharacterPitchingGameHistory,
  buildFieldingChances,
  calculateParkFactors,
  summarizeFieldingByPosition,
  summarizeStarHitFieldingByPosition,
} from '../utils/statsCalculator'
import { computeRangeLeagueConstants, summarizeFieldingRange } from '../utils/fieldingRange'
import { summarizeContactQuality } from '../utils/hitDistanceStats'
import { analyzeCharacterTalent } from '../utils/characterAnalysis'
import { buildCharacterAwardRows } from '../utils/awardsAndHonors'
import { buildCharacterTransactionFeed } from '../utils/transactionHistory'
import { buildPlayerTeamIdentity, buildSeasonTeamIdentity } from '../utils/teamIdentity'
import { buildExpectedOutcomeModel, summarizeExpectedBatting } from '../utils/expectedStats'
import { getStadiumNameByKey } from '../utils/stadiums'
import { normalizeSeasonRowsByGameId } from '../utils/seasonGameIds'

function createDefaultExtras() {
  return {
    loading: false,
    leaguePerformanceByCharacterId: {},
    fieldingHistory: [],
    allTimeFielding: null,
    characterGameFielders: [],
    fieldingByPosition: { totalGames: 0, positions: [] },
    fieldingHistoryByPosition: [],
    starHitFieldingByPosition: { positions: [], totalChances: 0, totalErrors: 0, fieldingPct: null },
    starHitFieldingHistoryByPosition: [],
    fieldingRangeByPosition: { positions: [], totalRangeable: 0, totalRangeRuns: null },
    parkFactorRows: [],
    teamHistory: [],
    transactions: [],
    awardRows: [],
    battingHistoryByCharacter: {},
    pitchingHistoryByCharacter: {},
    statMedians: null,
    statMaxes: null,
    statMins: null,
    analysesByCharacterId: {},
  }
}

function calcMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Builds the Overview bars' median/min/max reference points from every character's REAL,
// performance-adjusted score (their own actual game/pitching/fielding history) rather than a
// zero-history talent-only baseline — otherwise a character whose actual results outperform
// their raw talent can score above the computed "max," overflowing the bar despite not actually
// leading the league (and conversely, the league's true top performer might not visibly max out).
function buildStatPercentileBounds(characters, battingHistoryAllByCharacter, pitchingHistoryAllByCharacter, fieldingByCharacter) {
  if (characters.length < 2) return { medians: null, maxes: null, mins: null, analysesByCharacterId: {} }

  const all = characters.map((c) => ({
    intr: buildCharacterIntrinsics(c),
    analysis: analyzeCharacterTalent(
      c,
      battingHistoryAllByCharacter[c.id] || [],
      pitchingHistoryAllByCharacter[c.id] || [],
      fieldingByCharacter[c.id] || [],
    ),
  }))

  // offense/defense/pitching/speed here back the 4 headline "Score" bars, whose VALUE is
  // displayRatings.{batting,fielding,pitching,speed} (a percentile-mapped display rating) — NOT
  // categoryScores (a raw, unbounded internal blend value used only for OVR-formula weighting).
  // Comparing a displayRatings value against a categoryScores-derived max mixes two different
  // scales and silently under/over-fills the bar, so these 4 keys must read displayRatings too.
  const pickMedian = (fn) => calcMedian(all.map(fn))
  const medians = {
    offense: Math.round(pickMedian((x) => x.analysis?.displayRatings?.batting)),
    defense: Math.round(pickMedian((x) => x.analysis?.displayRatings?.fielding)),
    pitching: Math.round(pickMedian((x) => x.analysis?.displayRatings?.pitching)),
    speed: Math.round(pickMedian((x) => x.analysis?.displayRatings?.speed)),
    power: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.batting?.power) ?? 0),
    contact: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.batting?.contact) ?? 0),
    plateCoverage: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.batting?.plateCoverage)),
    contactPerfectWindow: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.batting?.contactPerfectWindow)),
    baserunning: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.batting?.baserunning) ?? 0),
    velocity: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.pitching?.velocity) ?? 0),
    curve: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.pitching?.curve)),
    staminaMetric: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.pitching?.stamina)),
    velocityIndex: Math.round(pickMedian((x) => x.intr?.velocityIndex)),
    breakIndex: Math.round(pickMedian((x) => x.intr?.breakIndex)),
    stamina: Math.round(pickMedian((x) => x.intr?.stamina)),
    catchCoverage: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.fielding?.catchCoverage)),
    fieldingMetric: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.fielding?.fielding)),
    armStrength: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.fielding?.armStrength)),
    mobility: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.fielding?.mobility)),
    baseDefense: Math.round(pickMedian((x) => x.analysis?.rawMetrics?.fielding?.baseDefense)),
  }

  const pickExtreme = (fn, mode, fallback) => {
    const values = all.map((x) => fn(x.analysis)).filter(Number.isFinite)
    if (!values.length) return fallback
    return mode === 'max' ? Math.max(...values) : Math.min(...values)
  }
  const build = (mode, fallbacks) => ({
    offense: Math.round(pickExtreme((x) => x.displayRatings?.batting, mode, fallbacks.pct)),
    defense: Math.round(pickExtreme((x) => x.displayRatings?.fielding, mode, fallbacks.pct)),
    pitching: Math.round(pickExtreme((x) => x.displayRatings?.pitching, mode, fallbacks.pct)),
    speed: Math.round(pickExtreme((x) => x.displayRatings?.speed, mode, fallbacks.pct)),
    power: Math.round(pickExtreme((x) => x.rawMetrics?.batting?.power, mode, fallbacks.pct)),
    contact: Math.round(pickExtreme((x) => x.rawMetrics?.batting?.contact, mode, fallbacks.pct)),
    plateCoverage: Math.round(pickExtreme((x) => x.rawMetrics?.batting?.plateCoverage, mode, fallbacks.pct)),
    contactPerfectWindow: Math.round(pickExtreme((x) => x.rawMetrics?.batting?.contactPerfectWindow, mode, fallbacks.pct)),
    baserunning: Math.round(pickExtreme((x) => x.rawMetrics?.batting?.baserunning, mode, fallbacks.pct)),
    velocity: Math.round(pickExtreme((x) => x.rawMetrics?.pitching?.velocity, mode, fallbacks.pct)),
    curve: Math.round(pickExtreme((x) => x.rawMetrics?.pitching?.curve, mode, fallbacks.pct)),
    staminaMetric: Math.round(pickExtreme((x) => x.rawMetrics?.pitching?.stamina, mode, fallbacks.pct)),
    velocityIndex: Math.round(pickExtreme((x) => x.intrinsics?.velocityIndex, mode, fallbacks.velocityIndex)),
    breakIndex: Math.round(pickExtreme((x) => x.intrinsics?.breakIndex, mode, fallbacks.pct)),
    stamina: Math.round(pickExtreme((x) => x.intrinsics?.stamina, mode, fallbacks.pct)),
    catchCoverage: Math.round(pickExtreme((x) => x.rawMetrics?.fielding?.catchCoverage, mode, fallbacks.pct)),
    fieldingMetric: Math.round(pickExtreme((x) => x.rawMetrics?.fielding?.fielding, mode, fallbacks.pct)),
    armStrength: Math.round(pickExtreme((x) => x.rawMetrics?.fielding?.armStrength, mode, fallbacks.pct)),
    mobility: Math.round(pickExtreme((x) => x.rawMetrics?.fielding?.mobility, mode, fallbacks.pct)),
    baseDefense: Math.round(pickExtreme((x) => x.rawMetrics?.fielding?.baseDefense, mode, fallbacks.pct)),
  })

  // Exposed so the percentile snapshot row (percentileSnapshot.js) can look up each character's
  // REAL analysis directly instead of recomputing its own zero-history version — otherwise the
  // top row's numbers silently disagree with the Overview bars below for the same stat.
  const analysesByCharacterId = {}
  characters.forEach((c, index) => { analysesByCharacterId[c.id] = all[index].analysis })

  return {
    medians,
    maxes: build('max', { pct: 100, velocityIndex: 160 }),
    mins: build('min', { pct: 0, velocityIndex: 0 }),
    analysesByCharacterId,
  }
}

const extrasCache = new Map()

function getCacheKey(characterId, scope) {
  if (characterId == null) return null
  const scopeType = scope?.type || 'career'
  const scopeId = scope?.id || 'career'
  return `${characterId}:${scopeType}:${scopeId}`
}

function battedBallRate(pas, predicate) {
  if (!pas.length) return null
  return (pas.filter(predicate).length / pas.length) * 100
}

// Builds the league-wide exit-velo/barrel/hard-hit/whiff/K/BB/xwOBA rate index used by the
// percentile snapshot row, grouping league-wide batted-ball rows by character_id. The expected-
// outcome model is built once, league-wide, so every character's xwOBA is on the same scale.
function buildLeaguePerformanceIndex(battingRows = [], expectedModel = null) {
  const byCharacter = {}
  battingRows.forEach((pa) => {
    const charId = pa.character_id
    if (charId == null) return
    if (!byCharacter[charId]) byCharacter[charId] = []
    byCharacter[charId].push(pa)
  })

  const result = {}
  Object.entries(byCharacter).forEach(([charId, pas]) => {
    // Number(null) is 0 (finite!), so PAs with no tracked exit velocity (walks, strikeouts, etc.)
    // must be excluded by a null check before the finite check, or they'd average in as 0 mph.
    const withEv = pas.filter((pa) => pa.exit_velocity_mph != null && Number.isFinite(Number(pa.exit_velocity_mph)) && !pa.star_hit_used)
    const swings = pas.filter((pa) => pa.result != null)
    const expected = expectedModel ? summarizeExpectedBatting(pas, expectedModel) : null
    result[charId] = {
      exitVelo: withEv.length ? withEv.reduce((sum, pa) => sum + Number(pa.exit_velocity_mph), 0) / withEv.length : null,
      barrelRate: battedBallRate(withEv, (pa) => Number(pa.exit_velocity_mph) >= 98 && Number(pa.launch_angle_deg) >= 8 && Number(pa.launch_angle_deg) <= 32),
      hardHitRate: battedBallRate(withEv, (pa) => Number(pa.exit_velocity_mph) >= 95),
      whiffRate: battedBallRate(swings, (pa) => pa.result === 'K'),
      kRate: battedBallRate(swings, (pa) => pa.result === 'K'),
      bbRate: battedBallRate(swings, (pa) => pa.result === 'BB'),
      xwoba: expected?.sampleSize ? expected.xwOBA : null,
    }
  })
  return result
}

// Always self-fetches, regardless of how CharacterPage was reached — this is deliberate so the
// four new sections (percentile row, fielding, awards, transactions) look identical no matter
// which page the user clicked in from (Roster/SeasonRoster/Draft/Scorebook/Stats) or a direct
// URL load, rather than being fuller/thinner depending on entry point.
export default function useCharacterExtras(character, scope = null) {
  const cacheKey = getCacheKey(character?.id, scope)
  const [extras, setExtras] = useState(() => (cacheKey && extrasCache.has(cacheKey) ? extrasCache.get(cacheKey) : createDefaultExtras()))

  useEffect(() => {
    if (!cacheKey) {
      setExtras(createDefaultExtras())
      return
    }
    setExtras(extrasCache.get(cacheKey) || createDefaultExtras())
  }, [cacheKey])

  useEffect(() => {
    if (!character?.id) {
      setExtras(createDefaultExtras())
      return undefined
    }

    let cancelled = false

    async function load() {
      setExtras((current) => ({ ...current, loading: true }))

      const [
        tournamentBattingResult, seasonBattingResult,
        tournamentPitchingStintsResult, seasonPitchingStintsResult,
        tournamentFieldingPasResult, seasonFieldingPasResult,
        gameFieldersResult, seasonGameFieldersResult,
        tournamentRunEventsResult, seasonRunEventsResult,
        gamesResult, tournamentsResult, seasonsResult,
        charactersResult, seasonTeamsResult,
        draftPicksResult,
        tournamentTradeProposalsResult, tournamentTradeMovesResult,
        seasonTradeProposalsResult, seasonTradeMovesResult,
        seasonWaiversResult, seasonRosterResult,
        playersResult,
      ] = await Promise.all([
        fetchAllRows(() => supabase.from('plate_appearances').select('character_id,pitcher_id,result,exit_velocity_mph,launch_angle_deg,star_hit_used,game_id,hit_stadium_key,is_error,run_scored')),
        fetchAllRows(() => supabase.from('season_plate_appearances').select('character_id,pitcher_id,result,exit_velocity_mph,launch_angle_deg,star_hit_used,season_id,game_id,hit_stadium_key,is_error,run_scored')),
        fetchAllRows(() => supabase.from('pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('season_pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('plate_appearances').select('game_id,character_id,hit_location,hit_notation,error_notation,error_position,error_character,is_error,is_nice_play,inning,defensive_team_id,result,outs_on_play,star_hit_used,is_buddy_jump,buddy_jump_assist_position,buddy_jump_putout_position,hit_distance_ft,hit_angle_deg,hit_stadium_key,fielded_x,fielded_y,hang_time_sec,contact_video_sec,fielded_video_sec')),
        fetchAllRows(() => supabase.from('season_plate_appearances').select('game_id,season_id,character_id,hit_location,hit_notation,error_notation,error_position,error_character,is_error,is_nice_play,inning,defensive_team_id,result,outs_on_play,star_hit_used,is_buddy_jump,buddy_jump_assist_position,buddy_jump_putout_position,hit_distance_ft,hit_angle_deg,hit_stadium_key,fielded_x,fielded_y,hang_time_sec,contact_video_sec,fielded_video_sec')),
        fetchAllRows(() => supabase.from('game_fielders').select('*')),
        fetchAllRows(() => supabase.from('season_game_fielders').select('*')),
        fetchAllRows(() => supabase.from('runs_scored').select('*')),
        fetchAllRows(() => supabase.from('season_runs_scored').select('*')),
        fetchAllRows(() => supabase.from('games').select('id,tournament_id')),
        fetchAllRows(() => supabase.from('tournaments').select('id,tournament_number').order('tournament_number')),
        fetchAllRows(() => supabase.from('seasons').select('id,name,created_at').order('created_at')),
        fetchAllRows(() => supabase.from('characters').select('*')),
        fetchAllRows(() => supabase.from('season_teams').select('*')),
        fetchAllRows(() => supabase.from('draft_picks').select('*')),
        fetchAllRows(() => supabase.from('tournament_trade_proposals').select('*')),
        fetchAllRows(() => supabase.from('tournament_trade_proposal_moves').select('*')),
        fetchAllRows(() => supabase.from('season_trade_proposals').select('*')),
        fetchAllRows(() => supabase.from('season_trade_proposal_moves').select('*')),
        fetchAllRows(() => supabase.from('season_waivers').select('*')),
        fetchAllRows(() => supabase.from('season_roster').select('character_name,team_id,acquired_via,created_at,season_id')),
        fetchAllRows(() => supabase.from('players').select('*')),
      ])

      if (cancelled) return

      const tournamentBattingPas = tournamentBattingResult.data || []
      const seasonBattingPas = normalizeSeasonRowsByGameId(seasonBattingResult.data || [])
      const tournamentStints = tournamentPitchingStintsResult.data || []
      const seasonStints = normalizeSeasonRowsByGameId(seasonPitchingStintsResult.data || [])
      const tournamentFieldingPas = tournamentFieldingPasResult.data || []
      const seasonFieldingPas = normalizeSeasonRowsByGameId(seasonFieldingPasResult.data || [])
      const gameFielders = gameFieldersResult.data || []
      const seasonGameFielders = normalizeSeasonRowsByGameId(seasonGameFieldersResult.data || [])
      const tournamentRunEvents = tournamentRunEventsResult.data || []
      const seasonRunEvents = normalizeSeasonRowsByGameId(seasonRunEventsResult.data || [])
      const games = gamesResult.data || []
      const tournaments = tournamentsResult.data || []
      const seasons = seasonsResult.data || []
      const characters = charactersResult.data || []
      const seasonTeams = seasonTeamsResult.data || []
      const draftPicks = draftPicksResult.data || []
      const tournamentTradeProposals = tournamentTradeProposalsResult.data || []
      const tournamentTradeMoves = tournamentTradeMovesResult.data || []
      const seasonTradeProposals = seasonTradeProposalsResult.data || []
      const seasonTradeMoves = seasonTradeMovesResult.data || []
      const seasonWaivers = seasonWaiversResult.data || []
      const seasonRosterRaw = seasonRosterResult.data || []
      const players = playersResult.data || []

      const charactersByName = Object.fromEntries(characters.map((c) => [c.name, c]))
      const seasonTeamPlayerById = Object.fromEntries(seasonTeams.map((t) => [t.id, t.player_id]))
      const seasonTeamsById = Object.fromEntries(seasonTeams.map((t) => [t.id, t]))
      const playersById = Object.fromEntries(players.map((p) => [p.id, p]))
      const playerNameById = Object.fromEntries(players.map((p) => [p.id, p.name]))
      const tournamentById = Object.fromEntries(tournaments.map((t) => [String(t.id), t]))
      const seasonById = Object.fromEntries(seasons.map((s) => [String(s.id), s]))

      // Percentile snapshot: league-wide batted-ball performance per character.
      const allLeagueBattingRows = [...tournamentBattingPas, ...seasonBattingPas]
      const leagueExpectedModel = buildExpectedOutcomeModel(allLeagueBattingRows)
      const leaguePerformanceByCharacterId = buildLeaguePerformanceIndex(allLeagueBattingRows, leagueExpectedModel)
      const scopedSeasonGameIds = new Set(
        scope?.type === 'season'
          ? seasonBattingPas
            .filter((pa) => String(pa.season_id) === String(scope.id))
            .map((pa) => String(pa.game_id))
          : [],
      )
      const scopedTournamentGameIds = new Set(
        scope?.type === 'tournament'
          ? games.filter((game) => String(game.tournament_id) === String(scope.id)).map((game) => String(game.id))
          : [],
      )
      const parkFactorLeagueBattingRows = scope?.type === 'season'
        ? seasonBattingPas.filter((pa) => String(pa.season_id) === String(scope.id))
        : scope?.type === 'tournament'
          ? tournamentBattingPas.filter((pa) => scopedTournamentGameIds.has(String(pa.game_id)))
          : allLeagueBattingRows
      const parkFactorLeagueRunEvents = scope?.type === 'season'
        ? seasonRunEvents.filter((run) => scopedSeasonGameIds.has(String(run.game_id)))
        : scope?.type === 'tournament'
          ? tournamentRunEvents.filter((run) => scopedTournamentGameIds.has(String(run.game_id)))
          : [...tournamentRunEvents, ...seasonRunEvents]

      // Park Factors (for the stadiums this character has actually played at) — a park factor
      // describes the STADIUM's own league-wide effect on an outcome, not anything about this
      // character specifically; this just filters the full park-factor list down to the parks this
      // character's own PAs carry a hit_stadium_key for.
      const characterOwnBattingRows = parkFactorLeagueBattingRows.filter((pa) => String(pa.character_id) === String(character.id))
      const leagueContactQualityAll = summarizeContactQuality(parkFactorLeagueBattingRows)
      const characterStadiumKeys = [...new Set(characterOwnBattingRows.map((pa) => pa.hit_stadium_key).filter(Boolean))]
      const parkFactorRows = characterStadiumKeys.map((key) => {
        const stadiumPas = parkFactorLeagueBattingRows.filter((pa) => pa.hit_stadium_key === key)
        const stadiumGameIds = new Set(stadiumPas.map((pa) => String(pa.game_id)))
        const stadiumRunEvents = parkFactorLeagueRunEvents.filter((run) => stadiumGameIds.has(String(run.game_id)))
        const factors = calculateParkFactors(stadiumPas, parkFactorLeagueBattingRows, stadiumRunEvents, parkFactorLeagueRunEvents)
        const stadiumContactQuality = summarizeContactQuality(stadiumPas)
        const rateFactor = (stadiumRate, leagueRate) => (leagueRate ? stadiumRate / leagueRate : 1)
        return {
          stadiumKey: key,
          stadiumName: getStadiumNameByKey(key) || key,
          ...factors,
          hardHit: (stadiumContactQuality.hardHitRate != null && leagueContactQualityAll.hardHitRate)
            ? rateFactor(stadiumContactQuality.hardHitRate, leagueContactQualityAll.hardHitRate) : 1,
          barrel: (stadiumContactQuality.barrelRate != null && leagueContactQualityAll.barrelRate)
            ? rateFactor(stadiumContactQuality.barrelRate, leagueContactQualityAll.barrelRate) : 1,
        }
      }).sort((a, b) => a.stadiumName.localeCompare(b.stadiumName))

      // Fielding: this character's per-season chances/putouts/assists/errors.
      const fieldingByCharacter = buildCharacterFieldingGameHistory(
        tournamentFieldingPas, gameFielders, games, tournaments,
        seasonFieldingPas, seasonGameFielders, seasons, charactersByName, seasonTeamPlayerById,
      )
      const fieldingGameHistory = fieldingByCharacter[character.id] || []
      const fieldingHistory = aggregateFieldingHistoryByEvent(fieldingGameHistory)
      const characterGameFielders = [...gameFielders, ...seasonGameFielders].filter((row) => row.character === character.name)
      // League-wide (every character) — feeds the Range Runs baseline below, same "compute
      // from everyone before filtering to one character" ordering as computeFieldingLeagueConstants.
      const allFieldingChances = [
        ...buildFieldingChances(tournamentFieldingPas, gameFielders, charactersByName),
        ...buildFieldingChances(seasonFieldingPas, seasonGameFielders, charactersByName, (teamId) => seasonTeamPlayerById[teamId] ?? teamId),
      ]
      const characterFieldingChances = allFieldingChances.filter((chance) => String(chance.characterId) === String(character.id))
      const fieldingByPosition = summarizeFieldingByPosition(characterGameFielders, characterFieldingChances)
      const starHitFieldingByPosition = summarizeStarHitFieldingByPosition(characterFieldingChances)
      const fieldingGameEventMeta = buildFieldingGameEventMeta(games, tournaments, seasonFieldingPas, seasons)
      const fieldingHistoryByPosition = aggregateFieldingHistoryByEventAndPosition(characterFieldingChances, characterGameFielders, fieldingGameEventMeta)
      const starHitFieldingHistoryByPosition = aggregateFieldingHistoryByEventAndPosition(characterFieldingChances, [], fieldingGameEventMeta, { starHitOnly: true })
      const rangeLeagueConstants = computeRangeLeagueConstants(allFieldingChances)
      const fieldingRangeByPosition = summarizeFieldingRange(characterFieldingChances, rangeLeagueConstants)
      const allTimeFielding = fieldingGameHistory.length ? (() => {
        const chances = fieldingGameHistory.reduce((sum, g) => sum + (g.chances || 0), 0)
        const putouts = fieldingGameHistory.reduce((sum, g) => sum + (g.putouts || 0), 0)
        const assists = fieldingGameHistory.reduce((sum, g) => sum + (g.assists || 0), 0)
        const errors = fieldingGameHistory.reduce((sum, g) => sum + (g.errors || 0), 0)
        const buddyJumps = fieldingGameHistory.reduce((sum, g) => sum + (g.buddyJumps || 0), 0)
        const nicePlays = fieldingGameHistory.reduce((sum, g) => sum + (g.nicePlays || 0), 0)
        return { chances, putouts, assists, errors, buddyJumps, nicePlays, fieldingPct: chances ? (chances - errors) / chances : null }
      })() : null

      // Transactions: draft picks (id-keyed) + trades (name-keyed, normalized to player ids).
      const draftPicksWithLabels = draftPicks.map((pick) => ({
        ...pick,
        tournament_number: pick.tournament_id ? tournamentById[String(pick.tournament_id)]?.tournament_number : null,
      }))
      const tournamentTradeSummaries = tournamentTradeProposals.map((proposal) => ({
        id: proposal.id,
        status: proposal.status,
        created_at: proposal.created_at,
        moves: tournamentTradeMoves.filter((m) => m.proposal_id === proposal.id),
      }))
      const seasonTradeSummaries = seasonTradeProposals.map((proposal) => ({
        id: proposal.id,
        status: proposal.status,
        created_at: proposal.created_at,
        moves: seasonTradeMoves
          .filter((m) => m.proposal_id === proposal.id)
          .map((m) => ({
            ...m,
            from_player_id: seasonTeamPlayerById[m.from_team_id] ?? null,
            to_player_id: seasonTeamPlayerById[m.to_team_id] ?? null,
          })),
      }))
      const resolvedWaivers = seasonWaivers.map((w) => ({
        ...w,
        awarded_to_team_id: w.awarded_to_team_id ? (seasonTeamPlayerById[w.awarded_to_team_id] ?? w.awarded_to_team_id) : null,
      }))
      // season_roster has no round/pick_number columns like tournament draft_picks does — the
      // live snake draft just inserts one roster row per pick as it happens. Reconstruct the
      // same "Round R, Pick N" shape by ordering each season's 'draft'-acquired rows by
      // created_at (their actual pick order) and deriving the round from the season's team count.
      const seasonTeamCountBySeasonId = {}
      seasonTeams.forEach((t) => {
        seasonTeamCountBySeasonId[t.season_id] = (seasonTeamCountBySeasonId[t.season_id] || 0) + 1
      })
      const draftRowsBySeasonId = {}
      seasonRosterRaw.forEach((row) => {
        if ((row.acquired_via || 'draft') !== 'draft') return
        if (!draftRowsBySeasonId[row.season_id]) draftRowsBySeasonId[row.season_id] = []
        draftRowsBySeasonId[row.season_id].push(row)
      })
      const draftOrderByRow = new Map()
      Object.entries(draftRowsBySeasonId).forEach(([seasonId, rows]) => {
        const numTeams = seasonTeamCountBySeasonId[seasonId] || 0
        const sorted = [...rows].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
        sorted.forEach((row, index) => {
          const pickNumber = index + 1
          draftOrderByRow.set(row, { pickNumber, round: numTeams ? Math.ceil(pickNumber / numTeams) : null })
        })
      })

      const seasonRosterEntries = seasonRosterRaw.map((entry) => ({
        ...entry,
        team_id: seasonTeamPlayerById[entry.team_id] ?? entry.team_id,
        season_name: abbreviateSeasonName(seasonById[String(entry.season_id)]?.name) ?? null,
        round: draftOrderByRow.get(entry)?.round ?? null,
        pick_number: draftOrderByRow.get(entry)?.pickNumber ?? null,
      }))

      // Team ownership history: one row per season/tournament this character has been rostered
      // in — not a trade-by-trade reconstruction within the event, just whichever team the roster
      // record shows for that event (the most recently created season_roster row when a season
      // has more than one, e.g. after a trade) — so the career-page header can list every team
      // they've ever played for, not just the current owner.
      const tournamentOwnershipRows = draftPicksWithLabels
        .filter((p) => String(p.character_id) === String(character.id) && p.tournament_id)
        .map((p) => ({
          eventType: 'tournament',
          eventId: p.tournament_id,
          playerId: p.player_id,
          playerName: playersById[p.player_id]?.name ?? null,
          identity: buildPlayerTeamIdentity(playersById[p.player_id]),
          eventLabel: `MST ${tournamentById[String(p.tournament_id)]?.tournament_number ?? p.tournament_id}`,
          sortValue: new Date(tournamentById[String(p.tournament_id)]?.created_at || p.created_at || 0).getTime(),
        }))
      const seasonOwnershipBySeasonId = new Map()
      seasonRosterRaw
        .filter((entry) => entry.character_name === character.name)
        .forEach((entry) => {
          const existing = seasonOwnershipBySeasonId.get(entry.season_id)
          if (!existing || new Date(entry.created_at || 0) > new Date(existing.created_at || 0)) {
            seasonOwnershipBySeasonId.set(entry.season_id, entry)
          }
        })
      const seasonOwnershipRows = [...seasonOwnershipBySeasonId.values()].map((entry) => {
        const seasonTeamRow = seasonTeamsById[entry.team_id]
        const resolvedPlayerId = seasonTeamPlayerById[entry.team_id] ?? entry.team_id
        return {
          eventType: 'season',
          eventId: entry.season_id,
          playerId: resolvedPlayerId,
          playerName: playersById[resolvedPlayerId]?.name ?? null,
          identity: seasonTeamRow ? buildSeasonTeamIdentity(seasonTeamRow) : null,
          eventLabel: abbreviateSeasonName(seasonById[String(entry.season_id)]?.name) ?? `Season ${entry.season_id}`,
          sortValue: new Date(seasonById[String(entry.season_id)]?.created_at || entry.created_at || 0).getTime(),
        }
      })
      const teamHistory = [...tournamentOwnershipRows, ...seasonOwnershipRows]
        .filter((row) => row.playerId != null)
        .sort((a, b) => b.sortValue - a.sortValue)

      const transactions = buildCharacterTransactionFeed({
        draftPicks: draftPicksWithLabels,
        trades: [...tournamentTradeSummaries, ...seasonTradeSummaries],
        waivers: resolvedWaivers,
        seasonRosterEntries,
        characterName: character.name,
        characterId: character.id,
      })

      // Awards: full per-event batting/pitching lines for every character, league-wide.
      const battingHistoryAllByCharacter = buildCharacterGameHistory(tournamentBattingPas, games, tournaments, seasonBattingPas, seasons)
      const battingHistoryByCharacter = {}
      Object.entries(battingHistoryAllByCharacter).forEach(([charId, entries]) => {
        battingHistoryByCharacter[charId] = aggregateGameHistoryByEvent(entries)
      })
      const pitchingHistoryAllByCharacter = buildCharacterPitchingGameHistory(tournamentStints, games, tournaments, seasonStints, seasons, null, playerNameById)
      const pitchingHistoryByCharacter = {}
      Object.entries(pitchingHistoryAllByCharacter).forEach(([charId, entries]) => {
        pitchingHistoryByCharacter[charId] = aggregatePitchingHistoryByEvent(entries)
      })
      const awardRows = buildCharacterAwardRows(character.id, battingHistoryByCharacter, pitchingHistoryByCharacter)

      // Overview bars: true percentile bounds from every character's real, performance-adjusted
      // score (reuses the same raw per-game histories built above for Awards).
      const { medians: statMedians, maxes: statMaxes, mins: statMins, analysesByCharacterId } = buildStatPercentileBounds(
        characters, battingHistoryAllByCharacter, pitchingHistoryAllByCharacter, fieldingByCharacter,
      )

      const nextExtras = {
        loading: false,
        leaguePerformanceByCharacterId,
        fieldingHistory,
        allTimeFielding,
        characterGameFielders,
        fieldingByPosition,
        fieldingHistoryByPosition,
        starHitFieldingByPosition,
        starHitFieldingHistoryByPosition,
        fieldingRangeByPosition,
        parkFactorRows,
        teamHistory,
        transactions,
        awardRows,
        battingHistoryByCharacter,
        pitchingHistoryByCharacter,
        statMedians,
        statMaxes,
        statMins,
        analysesByCharacterId,
      }
      extrasCache.set(cacheKey, nextExtras)
      if (!cancelled) setExtras(nextExtras)
    }

    load()

    // Re-fetch when at-bat data changes elsewhere, so awards/percentile bars
    // stay in sync with edits made on AtBatPage or Scorebook.
    const channel = supabase
      .channel(`character-extras-${cacheKey}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_fielders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_game_fielders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runs_scored' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_runs_scored' }, load)
      .subscribe()

    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [character?.id, character?.name, cacheKey])

  return extras
}
