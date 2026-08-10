import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { computeRangeLeagueConstants, summarizeFieldingRange } from '../utils/fieldingRange'
import {
  abbreviateSeasonName,
  buildFieldingChances,
  buildStandings,
  computeLeagueConstants,
  calculateParkFactors,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  filterRunEventsForCharacter,
  summarizeBattedBallProfile,
  summarizeBattedBallTypeProfile,
  summarizeBatting,
  summarizeBattingSplits,
  enrichPasWithPitchingContext,
  summarizePitching,
  summarizePitchingSplits,
  summarizePlateDiscipline,
  summarizeSprayContactProfile,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
  tagPasWithGameContext,
  tagPasWithHandedness,
} from '../utils/statsCalculator'
import {
  calculateHitPowerIndex,
  calculateParkAdjustedDistance,
  summarizeContactQuality,
  summarizeExitVelocity,
  summarizeHitDistance,
} from '../utils/hitDistanceStats'
import { buildSeasonStandings } from '../utils/competitionStandings'
import { buildTeamStatRow } from '../utils/teamStatAggregation'
import { buildDraftValueReport, summarizeTeamDraftValue } from '../utils/draftValue'
import { buildExpectedOutcomeModel, summarizeExpectedBatting } from '../utils/expectedStats'
import { buildStadiumKeyByGameId, getStadiumNameByKey, STADIUM_GAME_LOG_SELECT, SEASON_STADIUM_GAME_LOG_SELECT } from '../utils/stadiums'
import { resolveSeasonPitchingDecisions, resolveTournamentPitchingDecisions, groupRunsByPaId } from '../utils/pitchingDecisions'
import { buildTeamTransactionFeed } from '../utils/transactionHistory'
import { buildPlayerTeamIdentity, buildSeasonTeamIdentity, buildTournamentTeamIdentityMap, getTeamAbbreviation, getTeamShortName } from '../utils/teamIdentity'
import { getDoubleElimTemplate, getSingleElimTemplate, normalizeStage } from '../utils/bracketTemplates'
import { normalizeSeasonRowsByGameId, normalizeSeasonScheduleRows } from '../utils/seasonGameIds'

function dedupeCharactersById(characters) {
  const byId = new Map()
  characters.forEach((c) => { if (c && !byId.has(c.id)) byId.set(c.id, c) })
  return [...byId.values()]
}

function buildPlayerFallbackIdentity(player) {
  if (!player) return null
  return {
    teamName: player.team_name || player.name,
    teamMascot: player.team_mascot || null,
    teamAbbreviation: player.team_abbreviation || null,
    teamPrimaryColor: player.team_primary_color || null,
    teamSecondaryColor: player.team_secondary_color || null,
    teamLogoKey: null,
    teamLogoUrl: player.team_logo_url || null,
  }
}

function createEmptyTables() {
  return {
    standardBattingRows: [],
    standardPitchingRows: [],
    standardFieldingRows: [],
    standardBattingCareerRow: null,
    standardPitchingCareerRow: null,
    standardFieldingCareerRow: null,
    advancedBattingRows: [],
    advancedPitchingRows: [],
    advancedBattingCareerRow: null,
    advancedPitchingCareerRow: null,
    starHitRows: [],
    starPitchRows: [],
    starHitCareerRow: null,
    starPitchCareerRow: null,
    starHitAgainstRows: [],
    starPitchAgainstRows: [],
    starHitAgainstCareerRow: null,
    starPitchAgainstCareerRow: null,
    battedBallRows: [],
    battedBallCareerRow: null,
    powerRows: [],
    powerCareerRow: null,
    expectedRows: [],
    expectedCareerRow: null,
    battingSplitRows: [],
    pitchingSplitRows: [],
    hasBatting: false,
    hasPitching: false,
    hasFielding: false,
  }
}

function createDefault() {
  return {
    loading: true,
    player: null,
    identity: null,
    record: null,
    rosterCharacters: [],
    statRow: null,
    scopeOptions: [],
    transactions: [],
    gameLog: [],
    franchiseHistory: [],
    franchiseSummary: null,
    topPlayers: null,
    draftValue: [],
    draftValueSummary: null,
    tables: createEmptyTables(),
    battingRawPas: [],
  }
}

function formatOrdinal(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const abs = Math.abs(Math.trunc(number))
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 13) return `${abs}th`
  const mod10 = abs % 10
  if (mod10 === 1) return `${abs}st`
  if (mod10 === 2) return `${abs}nd`
  if (mod10 === 3) return `${abs}rd`
  return `${abs}th`
}

function getTournamentTemplate(bracketFormat, playerCount) {
  if (bracketFormat === 'double') return getDoubleElimTemplate(playerCount) || []
  if (bracketFormat === 'single') return getSingleElimTemplate(playerCount) || []
  return []
}

function buildBracketPlacementMap(template = []) {
  const stages = [...new Set(template.map((spec) => normalizeStage(spec.stage)).filter(Boolean))]
  if (!stages.length) {
    return { depthByStage: new Map(), placeByStage: new Map(), finalStage: null }
  }

  const dependenciesByStage = new Map(stages.map((stage) => [stage, []]))
  const winnerFeeds = new Set()
  const loserFeeds = new Set()

  template.forEach((spec) => {
    const stage = normalizeStage(spec.stage)
    ;[spec.teamARef, spec.teamBRef].forEach((ref) => {
      if (typeof ref !== 'string' || ref.length < 3) return
      const refStage = normalizeStage(ref.slice(2))
      if (!refStage) return
      dependenciesByStage.get(stage)?.push(refStage)
      if (ref.startsWith('W:')) winnerFeeds.add(refStage)
      if (ref.startsWith('L:')) loserFeeds.add(refStage)
    })
  })

  const depthByStage = new Map()
  function getStageDepth(stage) {
    if (depthByStage.has(stage)) return depthByStage.get(stage)
    const deps = dependenciesByStage.get(stage) || []
    const depth = deps.length ? (Math.max(...deps.map((dep) => getStageDepth(dep))) + 1) : 0
    depthByStage.set(stage, depth)
    return depth
  }
  stages.forEach((stage) => getStageDepth(stage))

  const finalStage = stages
    .filter((stage) => !winnerFeeds.has(stage))
    .sort((a, b) => getStageDepth(b) - getStageDepth(a))[0] || null

  const eliminationStages = stages.filter((stage) => !loserFeeds.has(stage) && stage !== finalStage)
  const stagesByDepth = new Map()
  eliminationStages.forEach((stage) => {
    const depth = getStageDepth(stage)
    const current = stagesByDepth.get(depth) || []
    current.push(stage)
    stagesByDepth.set(depth, current)
  })

  const placeByStage = new Map()
  let nextPlace = 3
  ;[...stagesByDepth.entries()]
    .sort((a, b) => b[0] - a[0])
    .forEach(([, groupedStages]) => {
      groupedStages.forEach((stage) => placeByStage.set(stage, nextPlace))
      nextPlace += groupedStages.length
    })

  return { depthByStage, placeByStage, finalStage }
}

function getStandingsPlace(standings = [], playerId) {
  let currentPlace = 1
  let previousKey = null

  for (let index = 0; index < standings.length; index += 1) {
    const row = standings[index]
    const key = `${row.wins || 0}:${row.losses || 0}:${row.runDiff || 0}`
    if (previousKey !== null && key !== previousKey) currentPlace = index + 1
    if (String(row.playerId) === String(playerId)) return currentPlace
    previousKey = key
  }

  return null
}

function computeTournamentFinishPlace({ tournament, games, picksForTournament, players, playerId }) {
  if (!tournament || tournament.status !== 'complete') return null

  const completedGames = games.filter((game) => game.status === 'complete' && game.winner_player_id)
  const participantIds = [...new Set([
    ...(Array.isArray(tournament.player_ids) ? tournament.player_ids : []),
    ...(Array.isArray(tournament.seeding) ? tournament.seeding : []),
    ...picksForTournament.map((pick) => pick.player_id),
    ...completedGames.flatMap((game) => [game.team_a_player_id, game.team_b_player_id]),
  ].filter((id) => id != null).map((id) => String(id)))]

  const tournamentPlayers = players.filter((entry) => participantIds.includes(String(entry.id)))
  const standingsPlace = tournamentPlayers.length
    ? getStandingsPlace(buildStandings(completedGames, tournamentPlayers), playerId)
    : null

  if (tournament.bracket_format === 'round_robin') return standingsPlace

  const playerCount = Math.max(
    Number(tournament.player_count || 0),
    participantIds.length,
  )
  const template = getTournamentTemplate(tournament.bracket_format || 'double', playerCount)
  const { depthByStage, placeByStage, finalStage } = buildBracketPlacementMap(template)
  const finalGame = completedGames.find((game) => normalizeStage(game.stage || '') === 'Championship Reset')
    || (finalStage ? completedGames.find((game) => normalizeStage(game.stage || '') === finalStage) : null)
    || completedGames.find((game) => normalizeStage(game.stage || '') === 'Championship')
    || completedGames.find((game) => normalizeStage(game.stage || '') === 'Winners Final')
    || [...completedGames].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0]

  if (finalGame?.winner_player_id && String(finalGame.winner_player_id) === String(playerId)) return 1
  if (finalGame && [finalGame.team_a_player_id, finalGame.team_b_player_id].some((id) => String(id) === String(playerId))) return 2

  const losses = completedGames
    .filter((game) => (
      [game.team_a_player_id, game.team_b_player_id].some((id) => String(id) === String(playerId))
      && String(game.winner_player_id) !== String(playerId)
    ))
    .map((game) => normalizeStage(game.stage || ''))
    .filter(Boolean)
    .sort((a, b) => (depthByStage.get(b) ?? -1) - (depthByStage.get(a) ?? -1) || a.localeCompare(b))

  const lastLostStage = losses[0] || null
  if (lastLostStage && placeByStage.has(lastLostStage)) return placeByStage.get(lastLostStage)

  return standingsPlace
}

// Baseball-Reference-style per-game log: one row per completed game with the running
// W-L record and win/loss streak after that game — only meaningful for a single season or
// tournament (BR itself has no cross-year "career" game log either).
function appendGameLogRow(rows, { runsFor, runsAgainst, won }) {
  const previous = rows[rows.length - 1]
  const wins = (previous?.wins || 0) + (won ? 1 : 0)
  const losses = (previous?.losses || 0) + (won ? 0 : 1)
  const streakType = won ? 'W' : 'L'
  const streakCount = previous?.streakType === streakType ? (previous.streakCount + 1) : 1
  rows.push({
    gameNumber: rows.length + 1,
    runsFor, runsAgainst, won,
    wins, losses, streakType, streakCount,
    record: `${wins}-${losses}`,
    streak: `${streakType}${streakCount}`,
  })
}

// Loads everything the Team page needs for one owner (`playerId`) at a given scope
// (`{ type: 'career' }` | `{ type: 'season', id }` | `{ type: 'tournament', id }`): roster
// resolution (season_roster / draft_picks, joined through season_teams.player_id), pooled
// batting/pitching stats via buildTeamStatRow, W-L record via buildSeasonStandings/buildStandings,
// team identity, and a team-wide transaction feed. Mirrors useCharacterExtras/useCharacterProfileData's
// "broad fetch, filter client-side by scope" pattern used elsewhere in this app.
export default function useTeamProfileData(playerId, scope) {
  const [data, setData] = useState(createDefault)

  useEffect(() => {
    if (!playerId) {
      setData(createDefault())
      return undefined
    }
    let cancelled = false

    const isCareer = scope.type === 'career'

    async function load() {
      setData((current) => ({ ...current, loading: true }))

      const [
        playersResult, seasonTeamsResult, seasonRosterResult, scheduleResult, bettingResult,
        seasonPasResult, seasonStintsResult, seasonPitchesResult, draftPicksResult, gamesResult,
        tournamentPasResult, tournamentStintsResult, tournamentPitchesResult, tournamentsResult, seasonsResult,
        tournamentTradeProposalsResult, tournamentTradeMovesResult,
        seasonTradeProposalsResult, seasonTradeMovesResult, seasonWaiversResult, charactersResult,
        seasonRunsScoredResult, tournamentRunsScoredResult,
        stadiumsResult, stadiumGameLogResult, seasonStadiumGameLogResult,
        gameFieldersResult, seasonGameFieldersResult,
      ] = await Promise.all([
        fetchAllRows(() => supabase.from('players').select('*')),
        fetchAllRows(() => supabase.from('season_teams').select('*')),
        fetchAllRows(() => supabase.from('season_roster').select('*')),
        fetchAllRows(() => supabase.from('season_schedule').select('*')),
        fetchAllRows(() => supabase.from('season_betting_ledger').select('*')),
        fetchAllRows(() => supabase.from('season_plate_appearances').select('*')),
        fetchAllRows(() => supabase.from('season_pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('season_pitches').select('*')),
        fetchAllRows(() => supabase.from('draft_picks').select('*')),
        fetchAllRows(() => supabase.from('games').select('*')),
        fetchAllRows(() => supabase.from('plate_appearances').select('*')),
        fetchAllRows(() => supabase.from('pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('pitches').select('*')),
        fetchAllRows(() => supabase.from('tournaments').select('*').order('tournament_number')),
        fetchAllRows(() => supabase.from('seasons').select('*').order('created_at')),
        fetchAllRows(() => supabase.from('tournament_trade_proposals').select('*')),
        fetchAllRows(() => supabase.from('tournament_trade_proposal_moves').select('*')),
        fetchAllRows(() => supabase.from('season_trade_proposals').select('*')),
        fetchAllRows(() => supabase.from('season_trade_proposal_moves').select('*')),
        fetchAllRows(() => supabase.from('season_waivers').select('*')),
        fetchAllRows(() => supabase.from('characters').select('*')),
        // Unfiltered (not scoped to this player) — the game log's win/loss/save reconstruction
        // needs every run in a game, not just the ones this team's characters scored. Both
        // tables are small league-wide, so fetching in full is cheap.
        fetchAllRows(() => supabase.from('season_runs_scored').select('*')),
        fetchAllRows(() => supabase.from('runs_scored').select('*')),
        fetchAllRows(() => supabase.from('stadiums').select('id,name')),
        fetchAllRows(() => supabase.from('stadium_game_log').select(STADIUM_GAME_LOG_SELECT)),
        fetchAllRows(() => supabase.from('season_stadium_game_log').select(SEASON_STADIUM_GAME_LOG_SELECT)),
        fetchAllRows(() => supabase.from('game_fielders').select('*')),
        fetchAllRows(() => supabase.from('season_game_fielders').select('*')),
      ])
      if (cancelled) return

      const players = playersResult.data || []
      const player = players.find((p) => String(p.id) === String(playerId)) || null
      const seasonTeams = seasonTeamsResult.data || []
      const myTeamsAcrossSeasons = seasonTeams.filter((t) => String(t.player_id) === String(playerId))
      const seasonRoster = seasonRosterResult.data || []
      const schedule = scheduleResult.data || []
      const bettingLedger = bettingResult.data || []
      const seasonPas = seasonPasResult.data || []
      const rawSeasonStints = seasonStintsResult.data || []
      const seasonPitches = normalizeSeasonRowsByGameId(seasonPitchesResult.data || [])
      const draftPicks = draftPicksResult.data || []
      const games = gamesResult.data || []
      const tournamentPas = tournamentPasResult.data || []
      const rawTournamentStints = tournamentStintsResult.data || []
      const tournamentPitches = tournamentPitchesResult.data || []
      const tournaments = tournamentsResult.data || []
      const seasons = seasonsResult.data || []
      const characters = charactersResult.data || []
      const stadiums = stadiumsResult.data || []
      const tournamentStadiumLog = stadiumGameLogResult.data || []
      const seasonStadiumLog = seasonStadiumGameLogResult.data || []
      const gameFielders = gameFieldersResult.data || []
      const seasonGameFielders = normalizeSeasonRowsByGameId(seasonGameFieldersResult.data || [])
      const charactersById = Object.fromEntries(characters.map((c) => [c.id, c]))
      const charactersByName = Object.fromEntries(characters.map((c) => [c.name, c]))
      const seasonTeamPlayerIdByTeamId = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.player_id]))
      const tournamentStadiumKeyByGameId = buildStadiumKeyByGameId(games, stadiums, tournamentStadiumLog)
      const seasonStadiumKeyByGameId = buildStadiumKeyByGameId(schedule, stadiums, seasonStadiumLog)
      const seasonPasWithContext = enrichPasWithPitchingContext(seasonPas, {
        pitchingStints: rawSeasonStints,
        pitches: seasonPitches,
        charactersByName,
        seasonTeamPlayerById: seasonTeamPlayerIdByTeamId,
        stadiumKeyByGameId: seasonStadiumKeyByGameId,
      })
      const normalizedSeasonPas = normalizeSeasonRowsByGameId(seasonPasWithContext)
      const normalizedTournamentPas = enrichPasWithPitchingContext(tournamentPas, {
        pitchingStints: rawTournamentStints,
        pitches: tournamentPitches,
        charactersByName,
        stadiumKeyByGameId: tournamentStadiumKeyByGameId,
      })
      const rawSeasonRunEvents = seasonRunsScoredResult.data || []
      const seasonRunEvents = normalizeSeasonRowsByGameId(rawSeasonRunEvents)
      const tournamentRunEvents = tournamentRunsScoredResult.data || []
      const runEvents = [...seasonRunEvents, ...tournamentRunEvents]
      const seasonRunsByPaId = groupRunsByPaId(rawSeasonRunEvents)
      const tournamentRunsByPaId = groupRunsByPaId(tournamentRunEvents)

      // Resolve win/loss/save for every stint up front (see pitchingDecisions.js) so every
      // consumer below — standard stats, career totals, the game log — reads the real decision
      // instead of the often-unstamped raw flags.
      const seasonStints = normalizeSeasonRowsByGameId(
        resolveSeasonPitchingDecisions(rawSeasonStints, schedule, seasonPasWithContext, seasonRunsByPaId, seasonTeamPlayerIdByTeamId),
      )
      const tournamentStints = resolveTournamentPitchingDecisions(rawTournamentStints, games, normalizedTournamentPas, tournamentRunsByPaId)

      const myTournamentPicks = draftPicks.filter((p) => String(p.player_id) === String(playerId))
      const tournamentIdsForPlayer = [...new Set(myTournamentPicks.map((p) => p.tournament_id).filter((id) => id != null))]

      // ─── Sidebar scope options ────────────────────────────────────────────────
      const seasonScopeOptions = myTeamsAcrossSeasons.map((t) => ({
        type: 'season', id: t.season_id, teamId: t.id,
        label: abbreviateSeasonName(seasons.find((s) => String(s.id) === String(t.season_id))?.name) || `Season ${t.season_id}`,
      }))
      const tournamentScopeOptions = tournamentIdsForPlayer.map((tid) => ({
        type: 'tournament', id: tid,
        label: `MST ${tournaments.find((t) => String(t.id) === String(tid))?.tournament_number ?? tid}`,
      }))
      const scopeOptions = [...seasonScopeOptions, ...tournamentScopeOptions]

      const effectiveSeasonTeamId = scope.type === 'season'
        ? myTeamsAcrossSeasons.find((t) => String(t.season_id) === String(scope.id))?.id ?? null
        : null

      // ─── Roster resolution ─────────────────────────────────────────────────────
      let rosterCharacters = []
      if (scope.type === 'career') {
        const myTeamIds = new Set(myTeamsAcrossSeasons.map((t) => String(t.id)))
        const names = seasonRoster.filter((r) => myTeamIds.has(String(r.team_id)) && r.is_active !== false).map((r) => r.character_name)
        const ids = myTournamentPicks.filter((p) => p.character_id).map((p) => p.character_id)
        rosterCharacters = dedupeCharactersById([...names.map((n) => charactersByName[n]), ...ids.map((id) => charactersById[id])].filter(Boolean))
      } else if (scope.type === 'season') {
        const names = seasonRoster
          .filter((r) => String(r.team_id) === String(effectiveSeasonTeamId) && String(r.season_id) === String(scope.id) && r.is_active !== false)
          .map((r) => r.character_name)
        rosterCharacters = dedupeCharactersById(names.map((n) => charactersByName[n]).filter(Boolean))
      } else if (scope.type === 'tournament') {
        const ids = myTournamentPicks.filter((p) => String(p.tournament_id) === String(scope.id) && p.character_id).map((p) => p.character_id)
        rosterCharacters = dedupeCharactersById(ids.map((id) => charactersById[id]).filter(Boolean))
      }

      // ─── Scoped batting/pitching pools ─────────────────────────────────────────
      const gamesById = Object.fromEntries(games.map((g) => [String(g.id), g]))
      const seasonScheduleByGameId = Object.fromEntries(
        normalizeSeasonScheduleRows(schedule).map((game) => [String(game.id), game]),
      )
      const characterNamesById = Object.fromEntries(characters.map((c) => [String(c.id), c.name]))
      const scopedTournamentGameIds = new Set(
        scope.type === 'tournament'
          ? games.filter((g) => String(g.tournament_id) === String(scope.id)).map((g) => String(g.id))
          : [],
      )
      let battingPas = []
      let pitchingStints = []
      let pitchingPas = []
      if (scope.type === 'career') {
        battingPas = [
          ...normalizedSeasonPas.filter((pa) => String(pa.player_id) === String(playerId)),
          ...normalizedTournamentPas.filter((pa) => String(pa.player_id) === String(playerId)),
        ]
        pitchingStints = [
          ...seasonStints.filter((s) => String(s.player_id) === String(playerId)),
          ...tournamentStints.filter((s) => String(s.player_id) === String(playerId)),
        ]
        pitchingPas = [
          ...normalizedSeasonPas.filter((pa) => String(pa.pitcher_player_id) === String(playerId)),
          ...normalizedTournamentPas.filter((pa) => String(pa.pitcher_player_id) === String(playerId)),
        ]
      } else if (scope.type === 'season') {
        battingPas = normalizedSeasonPas.filter((pa) => String(pa.player_id) === String(playerId) && String(pa.season_id) === String(scope.id))
        pitchingStints = seasonStints.filter((s) => String(s.player_id) === String(playerId) && String(s.season_id) === String(scope.id))
        pitchingPas = normalizedSeasonPas.filter((pa) => String(pa.pitcher_player_id) === String(playerId) && String(pa.season_id) === String(scope.id))
      } else if (scope.type === 'tournament') {
        battingPas = normalizedTournamentPas.filter((pa) => String(pa.player_id) === String(playerId) && scopedTournamentGameIds.has(String(pa.game_id)))
        pitchingStints = tournamentStints.filter((s) => String(s.player_id) === String(playerId) && scopedTournamentGameIds.has(String(s.game_id)))
        pitchingPas = normalizedTournamentPas.filter((pa) => String(pa.pitcher_player_id) === String(playerId) && scopedTournamentGameIds.has(String(pa.game_id)))
      }

      // ─── Scoped fielding pool ────────────────────────────────────────────────
      // Fielding credit isn't tied to the batter on a PA — it's resolved per-position via
      // game_fielders — so chances are built over the *entire* league's PAs (like CharacterPage
      // does), tagged with season/tournament id via each game, then filtered down to this
      // player's characters for the active scope.
      const seasonIdByGameId = Object.fromEntries(normalizedSeasonPas.map((pa) => [String(pa.game_id), pa.season_id]))
      const tournamentIdByGameId = Object.fromEntries(games.map((g) => [String(g.id), g.tournament_id]))
      const allSeasonFieldingChances = buildFieldingChances(
        normalizedSeasonPas, seasonGameFielders, charactersByName,
        (teamId) => seasonTeamPlayerIdByTeamId[teamId] ?? teamId,
      ).map((c) => ({ ...c, seasonId: seasonIdByGameId[String(c.gameId)] }))
      const allTournamentFieldingChances = buildFieldingChances(normalizedTournamentPas, gameFielders, charactersByName)
        .map((c) => ({ ...c, tournamentId: tournamentIdByGameId[String(c.gameId)] }))
      const rangeLeagueConstants = computeRangeLeagueConstants([...allSeasonFieldingChances, ...allTournamentFieldingChances])

      let fieldingChances = []
      if (scope.type === 'career') {
        fieldingChances = [
          ...allSeasonFieldingChances.filter((c) => String(c.playerId) === String(playerId)),
          ...allTournamentFieldingChances.filter((c) => String(c.playerId) === String(playerId)),
        ]
      } else if (scope.type === 'season') {
        fieldingChances = allSeasonFieldingChances.filter((c) => String(c.playerId) === String(playerId) && String(c.seasonId) === String(scope.id))
      } else if (scope.type === 'tournament') {
        fieldingChances = allTournamentFieldingChances.filter((c) => String(c.playerId) === String(playerId) && String(c.tournamentId) === String(scope.id))
      }
      let fieldingGameFielderRows = []
      if (scope.type === 'career') {
        fieldingGameFielderRows = [
          ...seasonGameFielders.filter((row) => String(seasonTeamPlayerIdByTeamId[row.team_id] ?? row.team_id) === String(playerId)),
          ...gameFielders.filter((row) => String(row.team_id) === String(playerId)),
        ]
      } else if (scope.type === 'season') {
        fieldingGameFielderRows = seasonGameFielders.filter((row) => (
          String(seasonTeamPlayerIdByTeamId[row.team_id] ?? row.team_id) === String(playerId) &&
          String(seasonIdByGameId[String(row.game_id)]) === String(scope.id)
        ))
      } else if (scope.type === 'tournament') {
        fieldingGameFielderRows = gameFielders.filter((row) => (
          String(row.team_id) === String(playerId) &&
          String(tournamentIdByGameId[String(row.game_id)]) === String(scope.id)
        ))
      }

      // A pitching_stints row is created the moment a pitcher takes the mound (Scorebook's
      // mound-assignment bookkeeping), before they've necessarily thrown a pitch — if pulled again
      // without facing a batter, that stint sits at 0 IP forever but would still count as a "game"
      // pitched. Drop stints with no matching row in `pitches`/`season_pitches` (by game_id +
      // pitcher name, since pitches.pitcher_id is a name string, not character_id) before they feed
      // any pitching stat line. Historical/imported stints have no pitch-log rows at all, so also
      // keep any stint with a recorded innings_pitched > 0 — that's real evidence of an outing.
      pitchingStints = pitchingStints.filter((stint) => {
        if (Number(stint.innings_pitched) > 0) return true
        const name = characterNamesById[String(stint.character_id)]
        const pool = stint.season_id != null ? seasonPitches : tournamentPitches
        return pool.some((p) => String(p.game_id) === String(stint.game_id) && p.pitcher_id === name)
      })

      battingPas = battingPas.map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name ?? null }))
      pitchingPas = pitchingPas.map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name ?? null }))
      const battingRawPas = battingPas

      function selectPitchesForPas(pitches, pas) {
        const paIds = new Set(pas.map((pa) => String(pa.id)))
        if (!paIds.size) return []
        return pitches.filter((pitch) => paIds.has(String(pitch.pa_id)))
      }
      // Same season/tournament-split + select dance as currentBatterPitches/currentPitcherPitches
      // below, generalized for an arbitrary PA subset (used to pull one character's pitches out of
      // the team-wide pool for the per-character stat rows).
      function pitchesForPas(pas) {
        return [
          ...selectPitchesForPas(seasonPitches, pas.filter((pa) => pa.season_id != null)),
          ...selectPitchesForPas(tournamentPitches, pas.filter((pa) => pa.season_id == null)),
        ]
      }

      const currentSeasonPitchingPas = pitchingPas.filter((pa) => pa.season_id != null)
      const currentTournamentPitchingPas = pitchingPas.filter((pa) => pa.season_id == null)
      const currentPitcherPitches = [
        ...selectPitchesForPas(seasonPitches, currentSeasonPitchingPas),
        ...selectPitchesForPas(tournamentPitches, currentTournamentPitchingPas),
      ]

      const leagueConstants = computeLeagueConstants([...normalizedSeasonPas, ...normalizedTournamentPas], [...seasonStints, ...tournamentStints])
      const expectedOutcomeModel = buildExpectedOutcomeModel([...normalizedSeasonPas, ...normalizedTournamentPas])
      const scopedSeasonGameIds = new Set(
        scope.type === 'season'
          ? normalizedSeasonPas
            .filter((pa) => String(pa.season_id) === String(scope.id))
            .map((pa) => String(pa.game_id))
          : [],
      )
      const leagueBattingPasForScope = scope.type === 'season'
        ? normalizedSeasonPas.filter((pa) => String(pa.season_id) === String(scope.id))
        : scope.type === 'tournament'
          ? normalizedTournamentPas.filter((pa) => scopedTournamentGameIds.has(String(pa.game_id)))
          : [...normalizedSeasonPas, ...normalizedTournamentPas]
      const leagueRunEventsForScope = scope.type === 'season'
        ? seasonRunEvents.filter((run) => scopedSeasonGameIds.has(String(run.game_id)))
        : scope.type === 'tournament'
          ? tournamentRunEvents.filter((run) => scopedTournamentGameIds.has(String(run.game_id)))
          : [...seasonRunEvents, ...tournamentRunEvents]
      const statRowGameIds = new Set(battingPas.map((pa) => String(pa.game_id)))
      const statRow = buildTeamStatRow({
        battingPas, pitchingStints, pitchingPas, pitcherPitches: currentPitcherPitches, leagueConstants,
        runEvents: runEvents.filter((run) => statRowGameIds.has(String(run.game_id))),
      })

      // ─── Draft value (actual value vs. expected value for that exact pick slot) ──
      const draftValueReport = buildDraftValueReport({
        draftPicks, seasonRoster, seasonTeams, characters, games, tournaments, seasons, players,
        seasonPas: normalizedSeasonPas, seasonStints, tournamentPas: normalizedTournamentPas, tournamentStints, leagueConstants,
      })
      const allTeamDraftPicks = draftValueReport.picksByOwnerId.get(String(playerId)) || []
      const draftValue = scope.type === 'season'
        ? allTeamDraftPicks.filter((p) => p.source === 'season' && String(p.contextId) === String(scope.id))
        : scope.type === 'tournament'
          ? allTeamDraftPicks.filter((p) => p.source === 'tournament' && String(p.contextId) === String(scope.id))
          : allTeamDraftPicks
      const draftValueSummary = summarizeTeamDraftValue(draftValue, draftValueReport.allPicks)

      // ─── Per-character stat rows for the current scope (season/tournament/career) ──
      // Every stat table below is broken out one row per roster character (rather than one row
      // per season/tournament) plus a "Team Total" row, so the pages show who actually produced
      // the team's numbers. battingPas.character_id is the batter; pitchingPas is enriched with
      // pitcher_id (the pitcher's character, via enrichPasWithPitchingContext above) since a PA's
      // own character_id always refers to the batter regardless of which side "pitchingPas" is
      // filtered to.
      function groupBy(items, keyFn) {
        const map = new Map()
        items.forEach((item) => {
          const key = keyFn(item)
          if (key == null) return
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(item)
        })
        return map
      }
      function characterNameFor(characterId) {
        return charactersById[characterId]?.name || 'Unknown'
      }
      function characterLinkFor(characterId) {
        if (scope.type === 'season') return `/character/${characterId}/season/${scope.id}`
        if (scope.type === 'tournament') return `/character/${characterId}/tournament/${scope.id}`
        return `/character/${characterId}/career`
      }

      const battingPasByCharacter = groupBy(battingPas, (pa) => pa.character_id)
      const pitchingStintsByCharacter = groupBy(pitchingStints, (s) => s.character_id)
      const pitchingPasByCharacter = groupBy(pitchingPas, (pa) => pa.pitcher_id)
      const pitchingCharacterIds = new Set([...pitchingStintsByCharacter.keys(), ...pitchingPasByCharacter.keys()])

      function characterBattingBundle(characterId, pas) {
        const batting = summarizeBatting(pas, filterRunEventsForCharacter(runEvents, characterId, pas))
        batting.ops = batting.obp + batting.slg
        const pitches = pitchesForPas(pas)
        const distanceProfile = summarizeHitDistance(pas)
        const exitVeloProfile = summarizeExitVelocity(pas)
        const contactQuality = summarizeContactQuality(pas)
        return {
          characterId,
          label: characterNameFor(characterId),
          linkTo: characterLinkFor(characterId),
          batting,
          advancedBatting: summarizeAdvancedBatting(pas, leagueConstants),
          starHit: summarizeStarHits(pas),
          starPitchAgainst: summarizeStarPitching(pas, pitches),
          battedBall: summarizeBattedBallProfile(pas),
          spray: summarizeSprayProfile(pas),
          sprayContact: summarizeSprayContactProfile(pas),
          battedByType: summarizeBattedBallTypeProfile(pas),
          distanceProfile,
          exitVeloProfile,
          contactQuality,
          hitPowerIndex: calculateHitPowerIndex(distanceProfile),
          parkAdjustedDistance: calculateParkAdjustedDistance(pas, leagueBattingPasForScope),
          discipline: summarizePlateDiscipline(pas, pitches),
          expected: { avg: batting.avg, slg: batting.slg, ...summarizeExpectedBatting(pas, expectedOutcomeModel) },
        }
      }
      function characterPitchingBundle(characterId, stints, pas) {
        const pitching = summarizePitching(stints)
        const pitches = pitchesForPas(pas)
        return {
          characterId,
          label: characterNameFor(characterId),
          linkTo: characterLinkFor(characterId),
          pitching,
          advancedPitching: { hasInningsPitched: pitching.innings > 0, ...summarizeAdvancedPitching(stints, leagueConstants, { plateAppearances: pas }) },
          starPitch: summarizeStarPitching(pas, pitches),
          starHitAgainst: summarizeStarHits(pas),
          battedBallAllowed: summarizeBattedBallProfile(pas),
          sprayAllowed: summarizeSprayProfile(pas),
          exitVeloAllowed: summarizeExitVelocity(pas),
          contactQualityAllowed: summarizeContactQuality(pas),
        }
      }

      const battingBundles = [...battingPasByCharacter.entries()]
        .map(([characterId, pas]) => characterBattingBundle(characterId, pas))
        .sort((a, b) => (b.batting.plateAppearances || 0) - (a.batting.plateAppearances || 0) || a.label.localeCompare(b.label))
      const pitchingBundles = [...pitchingCharacterIds]
        .map((characterId) => characterPitchingBundle(characterId, pitchingStintsByCharacter.get(characterId) || [], pitchingPasByCharacter.get(characterId) || []))
        .sort((a, b) => (b.pitching.innings || 0) - (a.pitching.innings || 0) || a.label.localeCompare(b.label))

      // Fielding rows, one per roster character — mirrors summarizeFieldingByPosition's chance
      // math (isBuddyJump chances are tracked separately from TC/PO/A/E) but grouped by character
      // instead of by position, since the team page shows "who fielded", not "which position".
      function summarizeFieldingForChances(chances, games) {
        const realChances = chances.filter((c) => !c.isBuddyJump)
        const putouts = realChances.filter((c) => c.isPutout).length
        const assists = realChances.filter((c) => c.isAssist).length
        const errors = realChances.filter((c) => c.isError).length
        const buddyJumps = chances.filter((c) => c.isBuddyJump).length
        const nicePlays = realChances.filter((c) => c.isNicePlay).length
        const range = summarizeFieldingRange(chances, rangeLeagueConstants)
        return {
          games,
          chances: realChances.length,
          putouts,
          assists,
          errors,
          buddyJumps,
          nicePlays,
          fieldingPct: realChances.length ? (realChances.length - errors) / realChances.length : null,
          nicePlayRate: realChances.length ? nicePlays / realChances.length : null,
          rangeRuns: range.totalRangeRuns,
          rangeable: range.totalRangeable,
          rangeFactorPlus: range.rangeFactorPlus,
          rangeConfidence: range.confidence,
        }
      }
      const fieldingChancesByCharacter = groupBy(fieldingChances, (c) => c.characterId)
      const fieldingGamesByCharacter = groupBy(fieldingGameFielderRows, (row) => charactersByName[row.character]?.id)
      const fieldingCharacterIds = new Set([...fieldingChancesByCharacter.keys(), ...fieldingGamesByCharacter.keys()])
      const fieldingBundles = [...fieldingCharacterIds]
        .map((characterId) => {
          const games = new Set((fieldingGamesByCharacter.get(characterId) || []).map((row) => String(row.game_id))).size
          return {
            characterId,
            label: characterNameFor(characterId),
            linkTo: characterLinkFor(characterId),
            fielding: summarizeFieldingForChances(fieldingChancesByCharacter.get(characterId) || [], games),
          }
        })
        .sort((a, b) => (b.fielding.chances || 0) - (a.fielding.chances || 0) || a.label.localeCompare(b.label))
      const standardFieldingCareerRow = {
        label: 'Team Total',
        ...summarizeFieldingForChances(fieldingChances, new Set(fieldingGameFielderRows.map((row) => String(row.game_id))).size),
      }

      const currentSeasonBattingPas = battingPas.filter((pa) => pa.season_id != null)
      const currentTournamentBattingPas = battingPas.filter((pa) => pa.season_id == null)
      const currentBatterPitches = [
        ...selectPitchesForPas(seasonPitches, currentSeasonBattingPas),
        ...selectPitchesForPas(tournamentPitches, currentTournamentBattingPas),
      ]
      const taggedBattingPas = tagPasWithHandedness(
        tagPasWithGameContext(currentTournamentBattingPas, currentSeasonBattingPas, { gamesById, seasonScheduleByGameId }),
        characterNamesById,
      )
      const taggedPitchingPas = tagPasWithHandedness(
        tagPasWithGameContext(currentTournamentPitchingPas, currentSeasonPitchingPas, { gamesById, seasonScheduleByGameId }),
        characterNamesById,
      )
      const battingSplits = summarizeBattingSplits(taggedBattingPas, leagueConstants)
      const pitchingSplits = summarizePitchingSplits(taggedPitchingPas, leagueConstants)

      // "Team Total" rows are always computed (not just on the career page) since every stat
      // table now shows one row per character for the current scope plus this aggregate row.
      const standardBattingCareerRow = (() => {
        const battingGameIds = new Set(battingPas.map((pa) => String(pa.game_id)))
        const summary = summarizeBatting(battingPas, runEvents.filter((run) => battingGameIds.has(String(run.game_id))))
        summary.ops = summary.obp + summary.slg
        return { label: 'Team Total', ...summary }
      })()
      const standardPitchingCareerRow = { label: 'Team Total', ...summarizePitching(pitchingStints) }
      const advancedBattingCareerRow = { label: 'Team Total', ...summarizeAdvancedBatting(battingPas, leagueConstants) }
      const advancedPitchingCareerRow = {
        label: 'Team Total',
        hasInningsPitched: (pitchingStints.length > 0) && summarizePitching(pitchingStints).innings > 0,
        ...summarizeAdvancedPitching(pitchingStints, leagueConstants, { plateAppearances: pitchingPas }),
      }
      const starHitCareerRow = { label: 'Team Total', ...summarizeStarHits(battingPas) }
      const starPitchCareerRow = { label: 'Team Total', star: summarizeStarPitching(pitchingPas, currentPitcherPitches) }
      const starHitAgainstCareerRow = { label: 'Team Total', ...summarizeStarHits(pitchingPas) }
      const starPitchAgainstCareerRow = { label: 'Team Total', star: summarizeStarPitching(battingPas, currentBatterPitches) }
      const battedBallCareerRow = {
        label: 'Team Total',
        battedBall: summarizeBattedBallProfile(battingPas),
        spray: summarizeSprayProfile(battingPas),
        sprayContact: summarizeSprayContactProfile(battingPas),
        battedByType: summarizeBattedBallTypeProfile(battingPas),
        discipline: summarizePlateDiscipline(battingPas, currentBatterPitches),
      }
      const teamDistanceProfile = summarizeHitDistance(battingPas)
      const powerCareerRow = {
        label: 'Team Total',
        distanceProfile: teamDistanceProfile,
        exitVeloProfile: summarizeExitVelocity(battingPas),
        contactQuality: summarizeContactQuality(battingPas),
        spray: summarizeSprayProfile(battingPas),
        hitPowerIndex: calculateHitPowerIndex(teamDistanceProfile),
        parkAdjustedDistance: calculateParkAdjustedDistance(battingPas, leagueBattingPasForScope),
      }
      const battedBallAllowedCareerRow = {
        label: 'Team Total',
        battedBall: summarizeBattedBallProfile(pitchingPas),
        spray: summarizeSprayProfile(pitchingPas),
        exitVelo: summarizeExitVelocity(pitchingPas),
        contactQuality: summarizeContactQuality(pitchingPas),
      }
      const expectedCareerRow = (() => {
        const summary = summarizeBatting(battingPas)
        return { label: 'Team Total', avg: summary.avg, slg: summary.slg, ...summarizeExpectedBatting(battingPas, expectedOutcomeModel) }
      })()

      // ─── Park Factors (for the stadiums this team has actually played at) ─────────────────────
      // A park factor describes the STADIUM's league-wide effect on an outcome, not anything about
      // this team specifically — every team playing at the same park sees the same factor. This
      // just filters the full park-factor list down to the parks this team's own battingPas carry a
      // hit_stadium_key for (already resolved by enrichPasWithPitchingContext above), so the page
      // only shows parks relevant to this team instead of the entire league's stadium list.
      const leaguePasByStadiumKey = groupBy(leagueBattingPasForScope, (pa) => pa.hit_stadium_key)
      const leagueContactQualityAll = summarizeContactQuality(leagueBattingPasForScope)
      const teamStadiumKeys = [...new Set(battingPas.map((pa) => pa.hit_stadium_key).filter(Boolean))]
      const parkFactorRows = teamStadiumKeys.map((key) => {
        const stadiumPas = leaguePasByStadiumKey.get(key) || []
        const stadiumGameIds = new Set(stadiumPas.map((pa) => String(pa.game_id)))
        const stadiumRunEvents = leagueRunEventsForScope.filter((run) => stadiumGameIds.has(String(run.game_id)))
        const factors = calculateParkFactors(stadiumPas, leagueBattingPasForScope, stadiumRunEvents, leagueRunEventsForScope)
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

      // Rows are dropped from a table (but never the aggregate "Team Total" row) when the
      // character logged zero relevant events for that specific section — e.g. a batter who
      // never pitched shouldn't get a 0-IP pitching row, and a batter who never used Star Hit
      // shouldn't clutter the Stars Used table with an all-zero line.
      const pitchedRows = (b) => (b.pitching.games || 0) > 0 || (b.pitching.innings || 0) > 0
      const usedStarHit = (b) => (b.starHit.used || 0) > 0
      const usedStarPitch = (b) => (b.starPitch.used || 0) > 0
      const facedStarPitch = (b) => (b.starPitchAgainst.used || 0) > 0
      const facedStarHit = (b) => (b.starHitAgainst.used || 0) > 0

      const tables = {
        standardBattingRows: battingBundles.map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.batting })),
        standardPitchingRows: pitchingBundles.filter(pitchedRows).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.pitching })),
        standardFieldingRows: fieldingBundles.map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.fielding })),
        standardBattingCareerRow,
        standardPitchingCareerRow,
        standardFieldingCareerRow,
        advancedBattingRows: battingBundles.map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.advancedBatting })),
        advancedPitchingRows: pitchingBundles.filter(pitchedRows).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.advancedPitching })),
        advancedBattingCareerRow,
        advancedPitchingCareerRow,
        starHitRows: battingBundles.filter(usedStarHit).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.starHit })),
        starPitchRows: pitchingBundles.filter(usedStarPitch).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, star: b.starPitch })),
        starHitCareerRow,
        starPitchCareerRow,
        starHitAgainstRows: pitchingBundles.filter(facedStarHit).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.starHitAgainst })),
        starPitchAgainstRows: battingBundles.filter(facedStarPitch).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, star: b.starPitchAgainst })),
        starHitAgainstCareerRow,
        starPitchAgainstCareerRow,
        battedBallRows: battingBundles.map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, battedBall: b.battedBall, spray: b.spray, sprayContact: b.sprayContact, battedByType: b.battedByType, discipline: b.discipline })),
        battedBallCareerRow,
        battedBallAllowedRows: pitchingBundles.filter(pitchedRows).map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, battedBall: b.battedBallAllowed, spray: b.sprayAllowed, exitVelo: b.exitVeloAllowed, contactQuality: b.contactQualityAllowed })),
        battedBallAllowedCareerRow,
        powerRows: battingBundles.map((b) => ({
          characterId: b.characterId,
          label: b.label,
          linkTo: b.linkTo,
          distanceProfile: b.distanceProfile,
          exitVeloProfile: b.exitVeloProfile,
          contactQuality: b.contactQuality,
          spray: b.spray,
          sprayContact: b.sprayContact,
          hitPowerIndex: b.hitPowerIndex,
          parkAdjustedDistance: b.parkAdjustedDistance,
        })),
        powerCareerRow,
        parkFactorRows,
        expectedRows: battingBundles.map((b) => ({ characterId: b.characterId, label: b.label, linkTo: b.linkTo, ...b.expected })),
        expectedCareerRow,
        battingSplitRows: [
          { label: 'Home', eventType: null, ...battingSplits.home },
          { label: 'Away', eventType: null, ...battingSplits.away },
          { label: 'Regular Season', eventType: null, ...battingSplits.regularSeason },
          { label: 'Postseason', eventType: null, ...battingSplits.postseason },
          { label: 'RISP', eventType: null, ...battingSplits.risp },
          { label: 'vs RHP', eventType: null, ...battingSplits.vsRHP },
          { label: 'vs LHP', eventType: null, ...battingSplits.vsLHP },
        ],
        pitchingSplitRows: [
          { label: 'Home', eventType: null, ...pitchingSplits.home },
          { label: 'Away', eventType: null, ...pitchingSplits.away },
          { label: 'Regular Season', eventType: null, ...pitchingSplits.regularSeason },
          { label: 'Postseason', eventType: null, ...pitchingSplits.postseason },
          { label: 'RISP', eventType: null, ...pitchingSplits.risp },
          { label: 'vs RHB', eventType: null, ...pitchingSplits.vsRHB },
          { label: 'vs LHB', eventType: null, ...pitchingSplits.vsLHB },
        ],
        hasBatting: battingPas.length > 0,
        hasPitching: pitchingPas.length > 0 || pitchingStints.length > 0,
        hasFielding: fieldingChances.length > 0 || fieldingGameFielderRows.length > 0,
      }

      // ─── Record (W-L/RS/RA) ─────────────────────────────────────────────────────
      function seasonRecordFor(seasonId) {
        const teamsForSeason = seasonTeams.filter((t) => String(t.season_id) === String(seasonId))
        const scheduleForSeason = schedule.filter((g) => String(g.season_id) === String(seasonId))
        const bettingForSeason = bettingLedger.filter((b) => String(b.season_id) === String(seasonId))
        const standings = buildSeasonStandings(teamsForSeason, scheduleForSeason, bettingForSeason)
        const row = standings.find((r) => String(r.player_id) === String(playerId))
        return row ? { wins: row.wins || 0, losses: row.losses || 0, runsFor: row.runs_scored || 0, runsAgainst: row.runs_allowed || 0 } : null
      }
      function tournamentRecordFor(tournamentId) {
        const gamesForTournament = games.filter((g) => String(g.tournament_id) === String(tournamentId))
        const standings = buildStandings(gamesForTournament, players)
        const row = standings.find((r) => String(r.playerId) === String(playerId))
        return row ? { wins: row.wins || 0, losses: row.losses || 0, runsFor: row.runsFor || 0, runsAgainst: row.runsAgainst || 0 } : null
      }

      let record = null
      if (scope.type === 'season') {
        record = seasonRecordFor(scope.id)
      } else if (scope.type === 'tournament') {
        record = tournamentRecordFor(scope.id)
      } else {
        const totals = { wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 }
        const seasonIdsForPlayer = [...new Set(myTeamsAcrossSeasons.map((t) => t.season_id))]
        seasonIdsForPlayer.forEach((sid) => {
          const r = seasonRecordFor(sid)
          if (r) { totals.wins += r.wins; totals.losses += r.losses; totals.runsFor += r.runsFor; totals.runsAgainst += r.runsAgainst }
        })
        tournamentIdsForPlayer.forEach((tid) => {
          const r = tournamentRecordFor(tid)
          if (r) { totals.wins += r.wins; totals.losses += r.losses; totals.runsFor += r.runsFor; totals.runsAgainst += r.runsAgainst }
        })
        record = totals
      }
      if (record) record.runDiff = record.runsFor - record.runsAgainst

      // ─── Game Log (BR-style: date/opponent/result/running record — single event only) ──
      // seasonStints/tournamentStints already have win/loss/save resolved (see above), so this
      // just reads the flags for the one game.
      function pitcherDecisionsForGame(gameId, stints) {
        const gameStints = stints.filter((s) => String(s.game_id) === String(gameId))
        const toPitcher = (stint) => (stint ? { characterId: stint.character_id, name: charactersById[stint.character_id]?.name || 'Unknown' } : null)
        return {
          winningPitcher: toPitcher(gameStints.find((s) => s.win)),
          losingPitcher: toPitcher(gameStints.find((s) => s.loss)),
          savePitcher: toPitcher(gameStints.find((s) => s.save)),
        }
      }

      function seasonGameLog(seasonId, teamId) {
        if (!teamId) return []
        const gamesForSeason = schedule
          .filter((g) => String(g.season_id) === String(seasonId) && g.status === 'completed'
            && (String(g.home_team_id) === String(teamId) || String(g.away_team_id) === String(teamId)))
          .sort((a, b) => (Number(a.round_number || 0) - Number(b.round_number || 0)) || String(a.id).localeCompare(String(b.id)))

        const rows = []
        gamesForSeason.forEach((g) => {
          const isHome = String(g.home_team_id) === String(teamId)
          const opponentTeamId = isHome ? g.away_team_id : g.home_team_id
          const opponentTeam = seasonTeams.find((t) => String(t.id) === String(opponentTeamId))
          const runsFor = Number((isHome ? g.home_score : g.away_score) || 0)
          const runsAgainst = Number((isHome ? g.away_score : g.home_score) || 0)
          const won = String(g.winner_team_id) === String(teamId)
          appendGameLogRow(rows, { runsFor, runsAgainst, won })
          const row = rows[rows.length - 1]
          const opponentIdentity = opponentTeam ? buildSeasonTeamIdentity(opponentTeam) : null
          row.roundLabel = g.round_number ? `Rd ${g.round_number}` : `G${row.gameNumber}`
          row.opponentLabel = opponentIdentity?.teamName || opponentTeam?.team_name || 'Unknown'
          row.opponentAbbr = (opponentIdentity ? getTeamAbbreviation(opponentIdentity) : null) || row.opponentLabel
          row.opponentPlayerId = opponentTeam?.player_id ?? null
          row.isHome = isHome
          row.gameId = g.id
          row.scorebookSource = 'season'
          row.stadium = getStadiumNameByKey(seasonStadiumKeyByGameId[String(g.id)])
          Object.assign(row, pitcherDecisionsForGame(g.id, seasonStints))
        })
        return rows
      }

      function tournamentGameLog(tournamentId, ownerId) {
        const gamesForTournament = games
          .filter((g) => String(g.tournament_id) === String(tournamentId) && g.status === 'complete'
            && (String(g.team_a_player_id) === String(ownerId) || String(g.team_b_player_id) === String(ownerId)))
          .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0) || String(a.id).localeCompare(String(b.id)))

        const rows = []
        gamesForTournament.forEach((g) => {
          const isTeamA = String(g.team_a_player_id) === String(ownerId)
          const opponentPlayerId = isTeamA ? g.team_b_player_id : g.team_a_player_id
          const opponentPlayer = players.find((pl) => String(pl.id) === String(opponentPlayerId))
          const runsFor = Number((isTeamA ? g.team_a_runs : g.team_b_runs) || 0)
          const runsAgainst = Number((isTeamA ? g.team_b_runs : g.team_a_runs) || 0)
          const won = String(g.winner_player_id) === String(ownerId)
          appendGameLogRow(rows, { runsFor, runsAgainst, won })
          const row = rows[rows.length - 1]
          const opponentIdentity = opponentPlayer ? buildPlayerTeamIdentity(opponentPlayer) : null
          row.roundLabel = `G${row.gameNumber}`
          row.opponentLabel = opponentIdentity?.teamName || opponentPlayer?.name || 'Unknown'
          row.opponentAbbr = (opponentIdentity ? getTeamAbbreviation(opponentIdentity) : null) || row.opponentLabel
          row.opponentPlayerId = opponentPlayer?.id ?? null
          row.isHome = isTeamA
          row.gameId = g.id
          row.scorebookSource = 'tournament'
          row.stadium = getStadiumNameByKey(tournamentStadiumKeyByGameId[String(g.id)])
          Object.assign(row, pitcherDecisionsForGame(g.id, tournamentStints))
        })
        return rows
      }

      let gameLog = []
      if (scope.type === 'season') gameLog = seasonGameLog(scope.id, effectiveSeasonTeamId)
      else if (scope.type === 'tournament') gameLog = tournamentGameLog(scope.id, playerId)

      // ─── Identity ───────────────────────────────────────────────────────────────
      const playerProfilesByPlayerId = Object.fromEntries(players.map((p) => [p.id, p]))
      let identity = null
      if (scope.type === 'season') {
        const t = myTeamsAcrossSeasons.find((team) => String(team.season_id) === String(scope.id))
        identity = t ? buildSeasonTeamIdentity(t) : null
      } else if (scope.type === 'tournament') {
        const picksForTournament = draftPicks.filter((p) => String(p.tournament_id) === String(scope.id))
        const map = buildTournamentTeamIdentityMap(picksForTournament, charactersById, {}, playerProfilesByPlayerId)
        identity = map[playerId] || null
      } else {
        const mostRecentSeasonTeam = myTeamsAcrossSeasons[myTeamsAcrossSeasons.length - 1]
        if (mostRecentSeasonTeam) {
          identity = buildSeasonTeamIdentity(mostRecentSeasonTeam)
        } else if (tournamentIdsForPlayer.length) {
          const lastTid = tournamentIdsForPlayer[tournamentIdsForPlayer.length - 1]
          const picksForTournament = draftPicks.filter((p) => String(p.tournament_id) === String(lastTid))
          const map = buildTournamentTeamIdentityMap(picksForTournament, charactersById, {}, playerProfilesByPlayerId)
          identity = map[playerId] || null
        }
      }
      if (!identity) identity = buildPlayerFallbackIdentity(player)

      // ─── Franchise History (career only) — one row per season/tournament with the team name
      // worn that year, record, and playoff/championship result, mirroring a BR-style franchise
      // encyclopedia table. Reuses seasonRecordFor/tournamentRecordFor and the champion_player_id
      // columns already written by the playoff-advance flows (seasonPlayoffs.js) / Bracket.jsx.
      function computeSeasonHistoryRow(opt) {
        const season = seasons.find((s) => String(s.id) === String(opt.id))
        const teamRow = myTeamsAcrossSeasons.find((t) => String(t.id) === String(opt.teamId))
        const rowIdentity = teamRow ? buildSeasonTeamIdentity(teamRow) : null
        const record = seasonRecordFor(opt.id)
        if (record) record.runDiff = record.runsFor - record.runsAgainst
        const isChampion = Boolean(season?.champion_player_id) && String(season.champion_player_id) === String(playerId)
        const madePlayoffs = schedule.some((g) => String(g.season_id) === String(opt.id) && g.stage
          && (String(g.home_team_id) === String(opt.teamId) || String(g.away_team_id) === String(opt.teamId)))
        const result = isChampion ? 'Won Championship' : madePlayoffs ? 'Made Playoffs' : (season?.status === 'completed' ? '—' : 'In Progress')
        return {
          type: 'season', id: opt.id, teamId: opt.teamId, label: opt.label,
          teamName: getTeamShortName(rowIdentity) || null,
          record, isChampion, madePlayoffs, result,
          sortValue: season?.created_at ? new Date(season.created_at).getTime() : 0,
          linkTo: `/teams/${playerId}/season/${opt.id}`,
        }
      }

      function computeTournamentHistoryRow(opt) {
        const tournament = tournaments.find((t) => String(t.id) === String(opt.id))
        const picksForTournament = draftPicks.filter((p) => String(p.tournament_id) === String(opt.id))
        const gamesForTournament = games.filter((g) => String(g.tournament_id) === String(opt.id))
        const identityMap = buildTournamentTeamIdentityMap(picksForTournament, charactersById, {}, playerProfilesByPlayerId)
        const rowIdentity = identityMap[playerId] || null
        const record = tournamentRecordFor(opt.id)
        if (record) record.runDiff = record.runsFor - record.runsAgainst
        const finishPlace = computeTournamentFinishPlace({
          tournament,
          games: gamesForTournament,
          picksForTournament,
          players,
          playerId,
        })
        const isChampion = finishPlace === 1 || (Boolean(tournament?.champion_player_id) && String(tournament.champion_player_id) === String(playerId))
        const isRunnerUp = finishPlace === 2
        const result = tournament?.status === 'complete'
          ? (isChampion ? 'Won Tournament' : isRunnerUp ? 'Runner-Up' : finishPlace ? `${formatOrdinal(finishPlace)} Place` : '—')
          : 'In Progress'
        return {
          type: 'tournament', id: opt.id, label: opt.label,
          teamName: getTeamShortName(rowIdentity) || null,
          record, isChampion, madePlayoffs: true, result, finishPlace,
          sortValue: tournament?.created_at ? new Date(tournament.created_at).getTime() : (tournament?.tournament_number || 0),
          linkTo: `/teams/${playerId}/tournament/${opt.id}`,
        }
      }

      const franchiseHistory = isCareer
        ? [...seasonScopeOptions.map(computeSeasonHistoryRow), ...tournamentScopeOptions.map(computeTournamentHistoryRow)]
          .sort((a, b) => b.sortValue - a.sortValue)
        : []

      const franchiseSummary = isCareer ? (() => {
        const teamNames = [...new Set(franchiseHistory
          .filter((row) => (row.record?.wins || 0) + (row.record?.losses || 0) > 0 && row.teamName)
          .map((row) => row.teamName))]
        const seasonsPlayed = franchiseHistory.filter((row) => row.type === 'season').length
        const tournamentsPlayed = franchiseHistory.filter((row) => row.type === 'tournament').length
        const championships = franchiseHistory.filter((row) => row.isChampion).length
        const tournamentsWon = franchiseHistory.filter((row) => row.type === 'tournament' && row.isChampion).length

        // "Winningest player" = the roster character who accumulated the most team wins (and their
        // full W-L record) while actually rostered for that specific season/tournament (not just
        // ever on the career roster).
        const recordByCharacter = {}
        franchiseHistory.forEach((row) => {
          const wins = row.record?.wins || 0
          const losses = row.record?.losses || 0
          if (!wins && !losses) return
          const names = row.type === 'season'
            ? seasonRoster.filter((r) => String(r.team_id) === String(row.teamId) && String(r.season_id) === String(row.id) && r.is_active !== false)
              .map((r) => r.character_name)
            : draftPicks.filter((p) => String(p.tournament_id) === String(row.id) && String(p.player_id) === String(playerId) && p.character_id)
              .map((p) => charactersById[p.character_id]?.name)
          names.filter(Boolean).forEach((name) => {
            const entry = recordByCharacter[name] || { wins: 0, losses: 0 }
            entry.wins += wins
            entry.losses += losses
            recordByCharacter[name] = entry
          })
        })
        const winningestPlayerEntry = Object.entries(recordByCharacter).sort((a, b) => b[1].wins - a[1].wins)[0] || null
        const winningestCharacter = winningestPlayerEntry ? characters.find((c) => c.name === winningestPlayerEntry[0]) : null

        return {
          teamNames, seasonsPlayed, tournamentsPlayed, championships, tournamentsWon,
          winningestPlayer: winningestPlayerEntry
            ? { characterId: winningestCharacter?.id ?? null, name: winningestPlayerEntry[0], wins: winningestPlayerEntry[1].wins, losses: winningestPlayerEntry[1].losses }
            : null,
        }
      })() : null

      // ─── All-Time Top Players (career only) — battingPas/pitchingStints above are already
      // pooled across every season/tournament this owner played, tagged with character_id, so
      // grouping by character_id gives each character's stat line specifically while on this team.
      const topPlayers = isCareer ? (() => {
        const battingByChar = {}
        battingPas.forEach((pa) => {
          if (pa.character_id == null) return
          ;(battingByChar[pa.character_id] ||= []).push(pa)
        })
        const pitchingByChar = {}
        pitchingStints.forEach((s) => {
          if (s.character_id == null) return
          ;(pitchingByChar[s.character_id] ||= []).push(s)
        })

        const topBatters = Object.entries(battingByChar)
          .map(([cid, pas]) => {
            const s = summarizeBatting(pas, filterRunEventsForCharacter(runEvents, cid, pas))
            s.ops = s.obp + s.slg
            return { characterId: Number(cid), name: charactersById[cid]?.name || 'Unknown', ...s }
          })
          .filter((row) => row.plateAppearances >= 20)
          .sort((a, b) => b.ops - a.ops)
          .slice(0, 5)

        const topPitchers = Object.entries(pitchingByChar)
          .map(([cid, stints]) => {
            const s = summarizePitching(stints)
            return { characterId: Number(cid), name: charactersById[cid]?.name || 'Unknown', ...s }
          })
          .filter((row) => row.innings >= 10)
          .sort((a, b) => a.era - b.era)
          .slice(0, 5)

        return { topBatters, topPitchers }
      })() : null

      // ─── Transactions (scoped to the currently-viewed season/tournament; career shows all) ──
      const seasonTeamPlayerById = Object.fromEntries(seasonTeams.map((t) => [t.id, t.player_id]))
      const tournamentTradeProposals = (tournamentTradeProposalsResult.data || []).map((proposal) => ({
        id: proposal.id, status: proposal.status, created_at: proposal.created_at, tournament_id: proposal.tournament_id,
        moves: (tournamentTradeMovesResult.data || []).filter((m) => m.proposal_id === proposal.id),
      }))
      const seasonTradeProposals = (seasonTradeProposalsResult.data || []).map((proposal) => ({
        id: proposal.id, status: proposal.status, created_at: proposal.created_at, season_id: proposal.season_id,
        moves: (seasonTradeMovesResult.data || [])
          .filter((m) => m.proposal_id === proposal.id)
          .map((m) => ({ ...m, from_player_id: seasonTeamPlayerById[m.from_team_id] ?? null, to_player_id: seasonTeamPlayerById[m.to_team_id] ?? null })),
      }))
      const draftPicksWithNames = draftPicks.map((pick) => ({ ...pick, character_name: charactersById[pick.character_id]?.name ?? null }))
      const transactions = buildTeamTransactionFeed({
        draftPicks: draftPicksWithNames,
        trades: [...tournamentTradeProposals, ...seasonTradeProposals],
        waivers: seasonWaiversResult.data || [],
        seasonRosterEntries: seasonRoster,
        playerId,
        teamId: effectiveSeasonTeamId ?? myTeamsAcrossSeasons[myTeamsAcrossSeasons.length - 1]?.id ?? null,
        scope,
      })

      const nextData = { loading: false, player, identity, record, rosterCharacters, statRow, scopeOptions, transactions, gameLog, franchiseHistory, franchiseSummary, topPlayers, draftValue, draftValueSummary, tables, battingRawPas }
      if (!cancelled) setData(nextData)
    }

    load()

    // Re-fetch when at-bat data changes elsewhere, so this profile doesn't
    // show stale stats after an edit on AtBatPage or Scorebook.
    const channel = supabase
      .channel(`team-profile-${playerId}-${scope.type}-${scope.id}-${Math.random().toString(36).slice(2)}`)
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
  }, [playerId, scope.type, scope.id])

  return data
}
