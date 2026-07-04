import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import {
  aggregateFieldingHistoryByEvent,
  aggregateGameHistoryByEvent,
  aggregatePitchingHistoryByEvent,
  buildCharacterFieldingGameHistory,
  buildCharacterGameHistory,
  buildCharacterIntrinsics,
  buildCharacterPitchingGameHistory,
} from '../utils/statsCalculator'
import { analyzeCharacterTalent } from '../utils/characterAnalysis'
import { buildCharacterAwardRows } from '../utils/awardsAndHonors'
import { buildCharacterTransactionFeed } from '../utils/transactionHistory'

function createDefaultExtras() {
  return {
    loading: false,
    leaguePerformanceByCharacterId: {},
    fieldingHistory: [],
    allTimeFielding: null,
    transactions: [],
    awardRows: [],
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

function battedBallRate(pas, predicate) {
  if (!pas.length) return null
  return (pas.filter(predicate).length / pas.length) * 100
}

// Builds the league-wide exit-velo/barrel/hard-hit/whiff/K/BB rate index used by the percentile
// snapshot row, grouping league-wide batted-ball rows by character_id.
function buildLeaguePerformanceIndex(battingRows = []) {
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
    result[charId] = {
      exitVelo: withEv.length ? withEv.reduce((sum, pa) => sum + Number(pa.exit_velocity_mph), 0) / withEv.length : null,
      barrelRate: battedBallRate(withEv, (pa) => Number(pa.exit_velocity_mph) >= 98 && Number(pa.launch_angle_deg) >= 8 && Number(pa.launch_angle_deg) <= 32),
      hardHitRate: battedBallRate(withEv, (pa) => Number(pa.exit_velocity_mph) >= 95),
      whiffRate: battedBallRate(swings, (pa) => pa.result === 'K'),
      kRate: battedBallRate(swings, (pa) => pa.result === 'K'),
      bbRate: battedBallRate(swings, (pa) => pa.result === 'BB'),
    }
  })
  return result
}

// Always self-fetches, regardless of how CharacterPage was reached — this is deliberate so the
// four new sections (percentile row, fielding, awards, transactions) look identical no matter
// which page the user clicked in from (Roster/SeasonRoster/Draft/Scorebook/Stats) or a direct
// URL load, rather than being fuller/thinner depending on entry point.
export default function useCharacterExtras(character) {
  const cacheKey = character?.id != null ? String(character.id) : null
  const [extras, setExtras] = useState(() => (cacheKey && extrasCache.has(cacheKey) ? extrasCache.get(cacheKey) : createDefaultExtras()))

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
        gamesResult, tournamentsResult, seasonsResult,
        charactersResult, seasonTeamsResult,
        draftPicksResult,
        tournamentTradeProposalsResult, tournamentTradeMovesResult,
        seasonTradeProposalsResult, seasonTradeMovesResult,
        seasonWaiversResult, seasonRosterResult,
      ] = await Promise.all([
        supabase.from('plate_appearances').select('character_id,pitcher_id,result,exit_velocity_mph,launch_angle_deg,star_hit_used,game_id'),
        supabase.from('season_plate_appearances').select('character_id,pitcher_id,result,exit_velocity_mph,launch_angle_deg,star_hit_used,season_id'),
        supabase.from('pitching_stints').select('*'),
        supabase.from('season_pitching_stints').select('*'),
        supabase.from('plate_appearances').select('game_id,character_id,hit_location,hit_notation,error_position,error_character,is_error,inning,defensive_team_id'),
        supabase.from('season_plate_appearances').select('game_id,season_id,character_id,hit_location,hit_notation,error_position,error_character,is_error,inning,defensive_team_id'),
        supabase.from('game_fielders').select('*'),
        supabase.from('season_game_fielders').select('*'),
        supabase.from('games').select('id,tournament_id'),
        supabase.from('tournaments').select('id,tournament_number').order('tournament_number'),
        supabase.from('seasons').select('id,name,created_at').order('created_at'),
        supabase.from('characters').select('*'),
        supabase.from('season_teams').select('id,player_id,season_id'),
        supabase.from('draft_picks').select('*'),
        supabase.from('tournament_trade_proposals').select('*'),
        supabase.from('tournament_trade_proposal_moves').select('*'),
        supabase.from('season_trade_proposals').select('*'),
        supabase.from('season_trade_proposal_moves').select('*'),
        supabase.from('season_waivers').select('*'),
        supabase.from('season_roster').select('character_name,team_id,acquired_via,created_at,season_id'),
      ])

      if (cancelled) return

      const tournamentBattingPas = tournamentBattingResult.data || []
      const seasonBattingPas = seasonBattingResult.data || []
      const tournamentStints = tournamentPitchingStintsResult.data || []
      const seasonStints = seasonPitchingStintsResult.data || []
      const tournamentFieldingPas = tournamentFieldingPasResult.data || []
      const seasonFieldingPas = seasonFieldingPasResult.data || []
      const gameFielders = gameFieldersResult.data || []
      const seasonGameFielders = seasonGameFieldersResult.data || []
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

      const charactersByName = Object.fromEntries(characters.map((c) => [c.name, c]))
      const seasonTeamPlayerById = Object.fromEntries(seasonTeams.map((t) => [t.id, t.player_id]))
      const tournamentById = Object.fromEntries(tournaments.map((t) => [String(t.id), t]))
      const seasonById = Object.fromEntries(seasons.map((s) => [String(s.id), s]))

      // Percentile snapshot: league-wide batted-ball performance per character.
      const leaguePerformanceByCharacterId = buildLeaguePerformanceIndex([...tournamentBattingPas, ...seasonBattingPas])

      // Fielding: this character's per-season chances/putouts/assists/errors.
      const fieldingByCharacter = buildCharacterFieldingGameHistory(
        tournamentFieldingPas, gameFielders, games, tournaments,
        seasonFieldingPas, seasonGameFielders, seasons, charactersByName, seasonTeamPlayerById,
      )
      const fieldingGameHistory = fieldingByCharacter[character.id] || []
      const fieldingHistory = aggregateFieldingHistoryByEvent(fieldingGameHistory)
      const allTimeFielding = fieldingGameHistory.length ? (() => {
        const chances = fieldingGameHistory.reduce((sum, g) => sum + (g.chances || 0), 0)
        const putouts = fieldingGameHistory.reduce((sum, g) => sum + (g.putouts || 0), 0)
        const assists = fieldingGameHistory.reduce((sum, g) => sum + (g.assists || 0), 0)
        const errors = fieldingGameHistory.reduce((sum, g) => sum + (g.errors || 0), 0)
        return { chances, putouts, assists, errors, fieldingPct: chances ? (chances - errors) / chances : null }
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
        season_name: seasonById[String(entry.season_id)]?.name ?? null,
        round: draftOrderByRow.get(entry)?.round ?? null,
        pick_number: draftOrderByRow.get(entry)?.pickNumber ?? null,
      }))

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
      const pitchingHistoryAllByCharacter = buildCharacterPitchingGameHistory(tournamentStints, games, tournaments, seasonStints, seasons)
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
        transactions,
        awardRows,
        statMedians,
        statMaxes,
        statMins,
        analysesByCharacterId,
      }
      extrasCache.set(cacheKey, nextExtras)
      if (!cancelled) setExtras(nextExtras)
    }

    load()
    return () => { cancelled = true }
  }, [character?.id, character?.name, cacheKey])

  return extras
}
