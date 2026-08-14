// Bridges the community stat-tracker into Supabase for a game marked
// `stats_source = 'tracker'`, two ways:
//   1. Live feed — this script launches the tracker .exe itself, captures
//      its console log line-by-line, and mirrors a parsed play-by-play
//      state (count/outs/matchup + recent events) into `live_feed` in
//      near-real-time.
//   2. Final box score — the tracker only writes its xlsx workbook once
//      the game ends, so that file is watched separately and treated as
//      the authoritative batting/pitching totals once it appears.
// Run this on whatever PC is running the tracker, in place of launching
// the tracker .exe yourself — this script launches it for you.
//
// Usage:
//   node scripts/live_tracker_bridge.mjs
//
// Config (env vars, can go in a local .env.tracker-bridge — see below):
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   - reused from the main .env
//   TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD - a Supabase login for an
//     account with scorebook_access or is_commissioner (RLS requires it)
//   TRACKER_EXE_PATH  - path to the lineup-feed-enabled tracker executable
//     (defaults to ./sluggers-stat-tracker-windows/sluggers-stat-tracker-live.exe)
//   TRACKER_OUTPUT_DIR - directory where the tracker writes completed xlsx files
//     (defaults to the output directory beside the tracker executable)
//   TRACKER_XLSX_PATH  - optional fixed completed-workbook path; when omitted,
//     the bridge watches TRACKER_OUTPUT_DIR for the newly-created game workbook
//   TRACKER_GAME_ID    - optional; the games.id row to write into. If omitted,
//     the bridge looks for exactly one game with stats_source='tracker' and
//     status in ('pending','active') and uses that.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import ExcelJS from 'exceljs'
import chokidar from 'chokidar'
import { createClient } from '@supabase/supabase-js'
import {
  TRACKER_POSITION_NUMBERS,
  parseTrackerBattingMessage,
  parseTrackerLineupMessage,
  parseTrackerRunnerMessage,
  parseWorkbookStartingLineups,
  validateTrackerAlignment,
  validateTrackerBattingOrder,
} from './tracker_alignment.mjs'
import { computePendingState, computePendingOutState, extractNextRunners } from '../src/utils/runnerAssignment.js'
import { isCreditedHit } from '../src/utils/creditedHit.js'
import { getStadiumKeyByName } from '../src/utils/stadiums.js'
import { resolveOnPA } from '../src/utils/betResolution.js'
import { buildTrackerMarketInputSignature } from '../src/utils/trackerLiveFeed.js'
import { resolveTrackerMatchupForHalf } from '../src/utils/trackerMatchupPrediction.js'
import { assembleErrorNotation } from '../src/utils/notation.js'
import {
  buildTrackerBetResolutionConfig,
  settleCompletedTrackerGame,
  syncTrackerLiveOdds,
} from './tracker_betting_sync.mjs'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  applyPaDerivedTrackerInningState,
  applyTrackerInningStateMessage,
  buildExactTrackerRunnerAssignments,
  captureTrackerPutout,
  consumeTrackerPitch,
  isTrackerBuntedBall,
  isTrackerReplayMessage,
  isTrackerRobbedHomeRun,
  markPendingTrackerStarPitch,
  numberTrackerPitches,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  parseTrackerInningStateMessage,
  parseTrackerPitchProvisionalMessage,
  parseTrackerPutoutMessage,
  shouldChargeTrackerBobbleError,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  shouldCreditTrackerPutout,
  shouldReclassifyTrackerFlyOutAsSacFly,
  TRACKER_BATTED_BALL_MARKER,
  TRACKER_FIELDED_BALL_MARKER,
  TRACKER_PITCH_PROVISIONAL_MARKER,
  trackerBattedBallPaFields,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
  trackerOutsOnPlay,
  trackerPitchStatFields,
  trackerStarPitchPaFlags,
} from './tracker_play_events.mjs'

function loadEnvFile(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return
    env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
  })
  return env
}

const env = {
  ...loadEnvFile(path.resolve('.env')),
  ...loadEnvFile(path.resolve('.env.tracker-bridge')),
  ...process.env,
}

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY
const BRIDGE_EMAIL = env.TRACKER_BRIDGE_EMAIL
const BRIDGE_PASSWORD = env.TRACKER_BRIDGE_PASSWORD
const PATCHED_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker-live-v2.exe')
const LEGACY_PATCHED_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker-live.exe')
const STOCK_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker.exe')
const EXE_PATH = path.resolve(env.TRACKER_EXE_PATH || (
  fs.existsSync(PATCHED_TRACKER_PATH)
    ? PATCHED_TRACKER_PATH
    : fs.existsSync(LEGACY_PATCHED_TRACKER_PATH) ? LEGACY_PATCHED_TRACKER_PATH : STOCK_TRACKER_PATH
))
const XLSX_PATH = env.TRACKER_XLSX_PATH ? path.resolve(env.TRACKER_XLSX_PATH) : null
const TRACKER_OUTPUT_DIR = path.resolve(env.TRACKER_OUTPUT_DIR || path.join(path.dirname(EXE_PATH), 'output'))
const ODDS_REPRICE_DEBOUNCE_MS = Math.max(50, Number(env.TRACKER_ODDS_REPRICE_MS || 120))
let TARGET_GAME_ID = env.TRACKER_GAME_ID ? Number(env.TRACKER_GAME_ID) : null
let TARGET_STATS_TABLE = null // 'tracker_live_stats' (tournament) or 'season_tracker_live_stats' (season)
let TARGET_GAMES_TABLE = null // 'games' (tournament) or 'season_schedule' (season)
let TARGET_ROSTER_TABLE = null // 'draft_picks' (tournament) or 'season_roster' (season)
let TARGET_TEAM_A_PLAYER_ID = null
let TARGET_TEAM_B_PLAYER_ID = null
let TARGET_SEASON_ID = null // season games only: season_schedule.season_id, stamped onto every row a season table requires it on
let TARGET_SOURCE_ID = null // tournament_id or season_id used by shared team-lineup rows
let TARGET_GAME_ROW = null
let TARGET_STADIUM_KEY = null
let GAME_TABLES = null // set once TARGET_GAMES_TABLE is known — the row-per-play tables matching it
const TEAM_ID_BY_PLAYER_ID = {} // season only: player_id -> season_teams.id (tournament PA rows use player_id directly instead)

const SOURCES = [
  { gamesTable: 'games', statsTable: 'tracker_live_stats', rosterTable: 'draft_picks', openStatuses: ['pending', 'active'] },
  { gamesTable: 'season_schedule', statsTable: 'season_tracker_live_stats', rosterTable: 'season_roster', openStatuses: ['scheduled', 'in_progress'] },
]

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (check .env).')
}
if (!BRIDGE_EMAIL || !BRIDGE_PASSWORD) {
  throw new Error(
    'Missing TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD. Put them in a ' +
    '.env.tracker-bridge file (not committed) next to .env, e.g.\n' +
    '  TRACKER_BRIDGE_EMAIL=jason@sluggers.local\n  TRACKER_BRIDGE_PASSWORD=Mossss',
  )
}
if (!fs.existsSync(EXE_PATH)) {
  throw new Error(`Tracker executable not found at ${EXE_PATH}. Set TRACKER_EXE_PATH.`)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const GAME_INFO_LABELS = [
  'Away Team', 'Home Team', 'Stadium - Time of Day', 'Innings - X',
  'Stars - On/Off', 'Items - On/Off', 'Mercy - On/Off',
]

function log(...args) {
  console.log(`[tracker-bridge ${new Date().toISOString()}]`, ...args)
}

async function resolveTeamPlayerIds(source, gameRow) {
  if (source.gamesTable === 'games') {
    return { teamAPlayerId: gameRow.team_a_player_id, teamBPlayerId: gameRow.team_b_player_id }
  }
  // season_schedule stores away_team_id/home_team_id referencing season_teams,
  // not player ids directly — team_a = away, team_b = home, same convention
  // the site's own SeasonGameSessionProvider normalizes to.
  const { data: teams, error } = await supabase
    .from('season_teams').select('id, player_id').in('id', [gameRow.away_team_id, gameRow.home_team_id])
  if (error) throw error
  const playerIdByTeamId = Object.fromEntries((teams || []).map((t) => [t.id, t.player_id]))
  for (const t of teams || []) TEAM_ID_BY_PLAYER_ID[String(t.player_id)] = t.id
  return { teamAPlayerId: playerIdByTeamId[gameRow.away_team_id] || null, teamBPlayerId: playerIdByTeamId[gameRow.home_team_id] || null }
}

async function resolveTargetStadiumKey(gameRow) {
  let stadiumName = gameRow?.stadium || null
  if (!stadiumName && gameRow?.stadium_id) {
    const { data, error } = await supabase
      .from('stadiums').select('name').eq('id', gameRow.stadium_id).maybeSingle()
    if (error) throw error
    stadiumName = data?.name || null
  }
  return getStadiumKeyByName(stadiumName)
}

async function applyTargetSource(source, row) {
  TARGET_GAME_ROW = row
  TARGET_STATS_TABLE = source.statsTable
  TARGET_GAMES_TABLE = source.gamesTable
  TARGET_ROSTER_TABLE = source.rosterTable
  TARGET_SEASON_ID = source.gamesTable === 'season_schedule' ? row.season_id : null
  TARGET_SOURCE_ID = source.gamesTable === 'season_schedule' ? row.season_id : row.tournament_id
  TARGET_STADIUM_KEY = await resolveTargetStadiumKey(row)
  GAME_TABLES = source.gamesTable === 'season_schedule'
    ? {
        lineups: 'season_lineups', gameFielders: 'season_game_fielders',
        plateAppearances: 'season_plate_appearances', pitches: 'season_pitches',
        runsScored: 'season_runs_scored', pitchingStints: 'season_pitching_stints',
        teamLineups: 'season_team_lineups', teamLineupsSourceField: 'season_id',
      }
    : {
        lineups: 'lineups', gameFielders: 'game_fielders',
        plateAppearances: 'plate_appearances', pitches: 'pitches',
        runsScored: 'runs_scored', pitchingStints: 'pitching_stints',
        teamLineups: 'team_lineups', teamLineupsSourceField: 'tournament_id',
      }
  const { teamAPlayerId, teamBPlayerId } = await resolveTeamPlayerIds(source, row)
  TARGET_TEAM_A_PLAYER_ID = teamAPlayerId
  TARGET_TEAM_B_PLAYER_ID = teamBPlayerId
}

async function resolveTargetGame() {
  if (TARGET_GAME_ID) {
    for (const source of SOURCES) {
      const { data, error } = await supabase
        .from(source.gamesTable).select('*').eq('id', TARGET_GAME_ID).maybeSingle()
      if (error) throw error
      if (data) {
        if (data.stats_source !== 'tracker') {
          throw new Error(`Game ${TARGET_GAME_ID} (${source.gamesTable}) is not set to stats_source='tracker' on the site yet.`)
        }
        await applyTargetSource(source, data)
        return data.id
      }
    }
    throw new Error(`No game with id ${TARGET_GAME_ID} in games or season_schedule.`)
  }

  const candidates = []
  for (const source of SOURCES) {
    const { data, error } = await supabase
      .from(source.gamesTable).select('*')
      .eq('stats_source', 'tracker').in('status', source.openStatuses)
    if (error) throw error
    for (const row of data || []) candidates.push({ row, source })
  }
  if (candidates.length === 0) {
    throw new Error(
      "No game is set to stats_source='tracker' right now. Toggle a game into " +
      'Tracker mode on the site first, or set TRACKER_GAME_ID.',
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple games are in Tracker mode (${candidates.map((c) => c.row.id).join(', ')}). ` +
      'Set TRACKER_GAME_ID to disambiguate.',
    )
  }
  const [{ row, source }] = candidates
  await applyTargetSource(source, row)
  return row.id
}

// ── roster/character resolution ─────────────────────────────────────────────
// Lets the bridge turn a tracker-reported character name (e.g. "Yoshi") into
// this game's actual character_id/player_id, so the live batter/pitcher can
// be written into the site's own live_state — the same field the manual
// scorebook uses — instead of a side channel only this bridge understands.

let charactersByName = {}
let characterNamesById = {}
let rosterPlayerIdByCharacterName = {}
let playerNamesById = {}

async function loadRosterAndCharacters() {
  const [{ data: characters, error: charError }, { data: players, error: playersError }] = await Promise.all([
    supabase.from('characters').select('id, name'),
    supabase.from('players').select('id, name').in('id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID]),
  ])
  if (charError) throw charError
  if (playersError) throw playersError
  charactersByName = Object.fromEntries((characters || []).map((c) => [c.name, c.id]))
  characterNamesById = Object.fromEntries((characters || []).map((c) => [String(c.id), c.name]))
  playerNamesById = Object.fromEntries((players || []).map((player) => [String(player.id), player.name]))
  const idToName = Object.fromEntries((characters || []).map((c) => [c.id, c.name]))

  if (TARGET_ROSTER_TABLE === 'draft_picks') {
    const { data: picks, error } = await supabase
      .from('draft_picks').select('player_id, character_id')
      .in('player_id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID])
    if (error) throw error
    for (const pick of picks || []) {
      const name = idToName[pick.character_id]
      if (name) rosterPlayerIdByCharacterName[name] = pick.player_id
    }
    return
  }

  // season_roster is keyed by team_id + character_name, not player_id/character_id.
  const { data: teams, error: teamsError } = await supabase
    .from('season_teams').select('id, player_id').in('player_id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID])
  if (teamsError) throw teamsError
  const playerIdByTeamId = Object.fromEntries((teams || []).map((t) => [t.id, t.player_id]))
  const teamIds = (teams || []).map((t) => t.id)
  if (!teamIds.length) return
  const { data: roster, error } = await supabase
    .from('season_roster').select('team_id, character_name').in('team_id', teamIds)
  if (error) throw error
  for (const entry of roster || []) {
    const playerId = playerIdByTeamId[entry.team_id]
    if (playerId && entry.character_name) rosterPlayerIdByCharacterName[entry.character_name] = playerId
  }
}

// The tracker prints some names with a trailing period ("Hammer Bro.",
// "Fire Bro.") that the site's own characters table doesn't have ("Hammer
// Bro", "Fire Bro") — fall back to the period-stripped form so those
// characters still resolve instead of silently failing every lookup.
function withNameFallbacks(name, lookup) {
  if (!name) return null
  if (lookup[name] != null) return lookup[name]
  if (name.endsWith('.')) {
    const stripped = name.slice(0, -1).trim()
    if (lookup[stripped] != null) return lookup[stripped]
  }
  return null
}

function resolveCharacterId(name) {
  return withNameFallbacks(name, charactersByName)
}

function resolvePlayerIdForCharacter(name) {
  return withNameFallbacks(name, rosterPlayerIdByCharacterName)
}

const appliedAlignmentSignaturesByPlayerId = new Map()
const appliedBattingSignaturesByPlayerId = new Map()
const trackerTeamSideByName = new Map()
let trackerTeamMapping = {}

function rememberTrackerTeamSide(teamName, playerId) {
  const cleanName = String(teamName || '').trim()
  const side = String(playerId) === String(TARGET_TEAM_A_PLAYER_ID)
    ? 'A'
    : String(playerId) === String(TARGET_TEAM_B_PLAYER_ID) ? 'B' : null
  if (!cleanName || !side) return
  trackerTeamSideByName.set(cleanName, side)
  trackerTeamMapping[cleanName] = side
}

function inferTrackerScoreSide(scoreTeamName) {
  const cleanScoreName = String(scoreTeamName || '').trim()
  if (!cleanScoreName) return null
  if (trackerTeamMapping[cleanScoreName]) return trackerTeamMapping[cleanScoreName]
  if (awayTeamName && cleanScoreName === awayTeamName) return 'A'
  if (homeTeamName && cleanScoreName === homeTeamName) return 'B'

  const normalizedScoreName = cleanScoreName.toLocaleLowerCase()
  const matches = [...trackerTeamSideByName.entries()]
    .filter(([knownName]) => {
      const normalizedKnownName = String(knownName).trim().toLocaleLowerCase()
      return normalizedScoreName === normalizedKnownName || normalizedScoreName.endsWith(` ${normalizedKnownName}`)
    })
    .map(([, side]) => side)
  const uniqueMatches = [...new Set(matches)]
  const side = uniqueMatches.length === 1 ? uniqueMatches[0] : null
  if (side) {
    trackerTeamSideByName.set(cleanScoreName, side)
    trackerTeamMapping[cleanScoreName] = side
  }
  return side
}

function resolveTrackerBattingOrder(alignment) {
  const validation = validateTrackerBattingOrder(alignment)
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const batting = alignment.batting.map((trackerName) => {
    const characterId = resolveCharacterId(trackerName)
    const playerId = resolvePlayerIdForCharacter(trackerName)
    if (characterId == null || playerId == null) {
      throw new Error(`could not resolve ${trackerName} against this game's rosters`)
    }
    return {
      trackerName,
      characterId,
      characterName: characterNamesById[String(characterId)] || trackerName,
      playerId,
    }
  })

  const playerIds = new Set(batting.map((entry) => String(entry.playerId)))
  if (playerIds.size !== 1) throw new Error('tracker lineup contains characters from multiple site teams')
  const playerId = batting[0].playerId
  if (![String(TARGET_TEAM_A_PLAYER_ID), String(TARGET_TEAM_B_PLAYER_ID)].includes(String(playerId))) {
    throw new Error('tracker lineup does not belong to either team in the selected site game')
  }

  return {
    ...alignment,
    playerId,
    teamId: isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(playerId)] : playerId,
    batting,
  }
}

function resolveTrackerAlignment(alignment) {
  const validation = validateTrackerAlignment(alignment)
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const resolved = resolveTrackerBattingOrder(alignment)
  const battingByTrackerName = new Map(resolved.batting.map((entry) => [entry.trackerName, entry]))
  const fielding = Object.entries(alignment.fielding).map(([position, trackerName]) => {
    const entry = battingByTrackerName.get(trackerName)
    if (!entry) throw new Error(`${trackerName} appears in fielding but not in the batting order`)
    return { ...entry, position, positionNumber: TRACKER_POSITION_NUMBERS[position] }
  })

  return {
    ...resolved,
    fielding,
  }
}

async function replaceTrackerLineupRows(resolved) {
  const { data: existing, error: readError } = await supabase
    .from(GAME_TABLES.lineups)
    .select('id,character_id,batting_order')
    .eq('game_id', TARGET_GAME_ID)
    .eq('player_id', resolved.playerId)
  if (readError) throw readError

  const desiredIds = resolved.batting.map((entry) => String(entry.characterId)).sort()
  const existingIds = (existing || []).map((entry) => String(entry.character_id)).sort()
  const sameCharacters = existingIds.length === 9 && desiredIds.every((id, index) => id === existingIds[index])

  if (sameCharacters) {
    const existingByCharacterId = new Map(existing.map((row) => [String(row.character_id), row]))
    const needsReorder = resolved.batting.some((entry, index) => (
      Number(existingByCharacterId.get(String(entry.characterId))?.batting_order) !== index + 1
    ))
    if (!needsReorder) return

    // Move all rows outside the real 1-9 range first so this also works when
    // the database has a unique (game, player, batting_order) constraint.
    for (let index = 0; index < resolved.batting.length; index++) {
      const row = existingByCharacterId.get(String(resolved.batting[index].characterId))
      const { data, error } = await supabase.from(GAME_TABLES.lineups)
        .update({ batting_order: 101 + index }).eq('id', row.id).select('id')
      if (error) throw error
      if (!data?.length) throw new Error(`lineup row ${row.id} was not updated (check scorebook permissions)`)
    }
    for (let index = 0; index < resolved.batting.length; index++) {
      const row = existingByCharacterId.get(String(resolved.batting[index].characterId))
      const { data, error } = await supabase.from(GAME_TABLES.lineups)
        .update({ batting_order: index + 1 }).eq('id', row.id).select('id')
      if (error) throw error
      if (!data?.length) throw new Error(`lineup row ${row.id} was not updated (check scorebook permissions)`)
    }
    return
  }

  const { error: deleteError } = await supabase.from(GAME_TABLES.lineups)
    .delete().eq('game_id', TARGET_GAME_ID).eq('player_id', resolved.playerId)
  if (deleteError) throw deleteError

  const payload = resolved.batting.map((entry, index) => addSourceFields({
    game_id: TARGET_GAME_ID,
    player_id: resolved.playerId,
    character_id: entry.characterId,
    batting_order: index + 1,
  }))
  const { data, error } = await supabase.from(GAME_TABLES.lineups).insert(payload).select('id')
  if (error) throw error
  if (data?.length !== 9) throw new Error(`expected to insert 9 lineup rows, inserted ${data?.length || 0}`)
}

async function replaceTrackerStartingFielders(resolved) {
  if (resolved.teamId == null) throw new Error('could not resolve the site team id for tracker fielders')
  const { data: existing, error: readError } = await supabase
    .from(GAME_TABLES.gameFielders).select('id,inning_from,inning_to')
    .eq('game_id', TARGET_GAME_ID).eq('team_id', resolved.teamId)
  if (readError) throw readError

  const hasRecordedChanges = (existing || []).some((row) => (
    Number(row.inning_from || 1) > 1 || row.inning_to != null
  ))
  if (resolved.source === 'workbook' && hasRecordedChanges) {
    log(`workbook lineup resolved for ${resolved.teamName}, but existing fielder history was preserved; live tracker feed is required to rebuild substitutions safely`)
    return
  }

  const { error: deleteError } = await supabase.from(GAME_TABLES.gameFielders)
    .delete().eq('game_id', TARGET_GAME_ID).eq('team_id', resolved.teamId)
  if (deleteError) throw deleteError

  const payload = resolved.fielding.map((entry) => addSourceFields({
    game_id: TARGET_GAME_ID,
    team_id: resolved.teamId,
    player_name: playerNamesById[String(resolved.playerId)] || '',
    character: entry.characterName,
    position: entry.positionNumber,
    inning_from: 1,
    inning_to: null,
  }))
  const { data, error } = await supabase.from(GAME_TABLES.gameFielders).insert(payload).select('id')
  if (error) throw error
  if (data?.length !== 9) throw new Error(`expected to insert 9 fielder rows, inserted ${data?.length || 0}`)
}

const SHARED_FIELD_ID_BY_POSITION = Object.freeze({
  1: 'pitcher',
  2: 'catcher',
  3: 'firstBase',
  4: 'secondBase',
  5: 'thirdBase',
  6: 'shortStop',
  7: 'leftField',
  8: 'centerField',
  9: 'rightField',
})

// Per-game lineups/game_fielders are authoritative once a game exists. Project
// their complete state into the shared team_lineups row so roster editors,
// future-game seeding, and betting all observe the same tracker assignment.
// A batting-only tracker record deliberately preserves the last complete
// fielding map until the tracker has identified all nine defensive positions.
async function mirrorGameTeamProjectionToSharedLineup({ playerId, teamId, includeFielding }) {
  if (!TARGET_SOURCE_ID || !playerId || teamId == null) {
    throw new Error('cannot mirror tracker lineup without source, player, and team ids')
  }

  const sourceField = GAME_TABLES.teamLineupsSourceField
  const [{ data: lineupRows, error: lineupError }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from(GAME_TABLES.lineups)
      .select('character_id,batting_order')
      .eq('game_id', TARGET_GAME_ID)
      .eq('player_id', playerId)
      .order('batting_order'),
    supabase.from(GAME_TABLES.teamLineups)
      .select('fielding_positions')
      .eq(sourceField, TARGET_SOURCE_ID)
      .eq('player_id', playerId)
      .maybeSingle(),
  ])
  if (lineupError) throw lineupError
  if (existingError) throw existingError
  if ((lineupRows || []).length !== 9) {
    throw new Error(`cannot mirror an incomplete ${lineupRows?.length || 0}-player game lineup`)
  }

  const lineupOrder = lineupRows.map((row) => row.character_id)
  if (new Set(lineupOrder.map(String)).size !== 9) {
    throw new Error('cannot mirror a game lineup containing duplicate characters')
  }

  let fieldingPositions = existing?.fielding_positions && typeof existing.fielding_positions === 'object'
    ? existing.fielding_positions
    : {}

  if (includeFielding) {
    const { data: fielderRows, error: fieldersError } = await supabase.from(GAME_TABLES.gameFielders)
      .select('character,position,inning_from')
      .eq('game_id', TARGET_GAME_ID)
      .eq('team_id', teamId)
      .is('inning_to', null)
      .order('position')
    if (fieldersError) throw fieldersError

    const completeFielding = {}
    for (const row of fielderRows || []) {
      const fieldId = SHARED_FIELD_ID_BY_POSITION[Number(row.position)]
      const characterId = resolveCharacterId(row.character)
      if (fieldId && characterId != null) completeFielding[fieldId] = characterId
    }
    const assignedIds = Object.values(completeFielding)
    if (Object.keys(completeFielding).length === 9 && new Set(assignedIds.map(String)).size === 9) {
      fieldingPositions = completeFielding
    } else {
      log(`shared fielding projection deferred for ${playerNamesById[String(playerId)] || playerId}: ` +
        `game currently has ${Object.keys(completeFielding).length} complete open assignments`)
    }
  }

  const payload = {
    [sourceField]: TARGET_SOURCE_ID,
    player_id: playerId,
    lineup_order: lineupOrder,
    fielding_positions: fieldingPositions,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase.from(GAME_TABLES.teamLineups)
    .upsert(payload, { onConflict: `${sourceField},player_id` })
    .select('player_id')
  if (error) throw error
  if (!data?.length) throw new Error('shared team-lineup projection was not persisted')
}

async function syncTrackerAlignment(alignment) {
  const resolved = resolveTrackerAlignment(alignment)
  rememberTrackerTeamSide(resolved.teamName, resolved.playerId)
  const signature = JSON.stringify({
    batting: resolved.batting.map((entry) => entry.characterId),
    fielding: resolved.fielding.map((entry) => [entry.positionNumber, entry.characterId]),
  })
  if (appliedAlignmentSignaturesByPlayerId.get(String(resolved.playerId)) === signature) return

  await replaceTrackerLineupRows(resolved)
  await replaceTrackerStartingFielders(resolved)
  await mirrorGameTeamProjectionToSharedLineup({
    playerId: resolved.playerId,
    teamId: resolved.teamId,
    includeFielding: true,
  })
  appliedBattingSignaturesByPlayerId.set(
    String(resolved.playerId),
    JSON.stringify(resolved.batting.map((entry) => entry.characterId)),
  )
  appliedAlignmentSignaturesByPlayerId.set(String(resolved.playerId), signature)
  liveState.alignments = {
    ...(liveState.alignments || {}),
    [String(resolved.playerId)]: {
      teamName: resolved.teamName,
      batting: resolved.batting.map((entry) => entry.characterName),
      fielding: Object.fromEntries(resolved.fielding.map((entry) => [entry.position, entry.characterName])),
      source: resolved.source,
    },
  }
  log(`lineup synced for ${resolved.teamName || playerNamesById[String(resolved.playerId)]}: ` +
    resolved.batting.map((entry) => entry.characterName).join(', '))
}

async function syncTrackerBattingOrder(order) {
  const resolved = resolveTrackerBattingOrder(order)
  rememberTrackerTeamSide(resolved.teamName, resolved.playerId)
  const signature = JSON.stringify(resolved.batting.map((entry) => entry.characterId))
  if (appliedBattingSignaturesByPlayerId.get(String(resolved.playerId)) === signature) return

  await replaceTrackerLineupRows(resolved)
  await mirrorGameTeamProjectionToSharedLineup({
    playerId: resolved.playerId,
    teamId: resolved.teamId,
    includeFielding: false,
  })
  appliedBattingSignaturesByPlayerId.set(String(resolved.playerId), signature)
  const prior = liveState.alignments?.[String(resolved.playerId)] || {}
  liveState.alignments = {
    ...(liveState.alignments || {}),
    [String(resolved.playerId)]: {
      ...prior,
      teamName: resolved.teamName || prior.teamName,
      batting: resolved.batting.map((entry) => entry.characterName),
      source: resolved.source,
    },
  }
  log(`batting order synced for ${resolved.teamName || playerNamesById[String(resolved.playerId)]}: ` +
    resolved.batting.map((entry) => entry.characterName).join(', '))
}

const TRACKER_POSITION_CHANGE_RE = /^(.+?) was moved to (P|C|1B|2B|3B|SS|LF|CF|RF)\.$/i

async function syncTrackerPositionChange(characterName, position) {
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  const positionNumber = TRACKER_POSITION_NUMBERS[position.toUpperCase()]
  if (characterId == null || playerId == null || positionNumber == null) {
    throw new Error(`could not resolve position change: ${characterName} -> ${position}`)
  }
  const teamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(playerId)] : playerId
  if (teamId == null) throw new Error(`could not resolve site team for ${characterName}`)

  const { data: openRows, error: readError } = await supabase.from(GAME_TABLES.gameFielders)
    .select('id,character,position,inning_from,inning_to')
    .eq('game_id', TARGET_GAME_ID).eq('team_id', teamId).is('inning_to', null)
  if (readError) throw readError

  const canonicalName = characterNamesById[String(characterId)] || characterName
  // Keeps the in-memory alignment (used by currentFieldingPositionNumber to
  // credit live putouts/assists) current across mid-game position swaps —
  // otherwise a substitution would go on crediting whoever held the
  // position at the start of the game.
  const applyPositionToLiveAlignment = () => {
    const prior = liveState.alignments?.[String(playerId)] || {}
    const fielding = { ...(prior.fielding || {}) }
    for (const [pos, existingName] of Object.entries(fielding)) {
      if (existingName === canonicalName) delete fielding[pos]
    }
    fielding[position.toUpperCase()] = canonicalName
    liveState.alignments = { ...(liveState.alignments || {}), [String(playerId)]: { ...prior, fielding } }
  }

  const alreadyApplied = (openRows || []).some((row) => (
    Number(row.position) === positionNumber && resolveCharacterId(row.character) === characterId
  ))
  if (alreadyApplied) {
    applyPositionToLiveAlignment()
    await mirrorGameTeamProjectionToSharedLineup({ playerId, teamId, includeFielding: true })
    return
  }

  const affected = (openRows || []).filter((row) => (
    Number(row.position) === positionNumber || resolveCharacterId(row.character) === characterId
  ))
  const currentInning = Math.max(1, Number(parserInning || liveState.inning || 1))
  const toClose = affected.filter((row) => Number(row.inning_from || 1) < currentInning)
  const toDelete = affected.filter((row) => Number(row.inning_from || 1) >= currentInning)
  if (toClose.length) {
    const { error } = await supabase.from(GAME_TABLES.gameFielders)
      .update({ inning_to: currentInning - 1 }).in('id', toClose.map((row) => row.id))
    if (error) throw error
  }
  if (toDelete.length) {
    const { error } = await supabase.from(GAME_TABLES.gameFielders)
      .delete().in('id', toDelete.map((row) => row.id))
    if (error) throw error
  }

  const { error: insertError } = await supabase.from(GAME_TABLES.gameFielders).insert(addSourceFields({
    game_id: TARGET_GAME_ID,
    team_id: teamId,
    player_name: playerNamesById[String(playerId)] || '',
    character: canonicalName,
    position: positionNumber,
    inning_from: currentInning,
    inning_to: null,
  }))
  if (insertError) throw insertError
  applyPositionToLiveAlignment()
  await mirrorGameTeamProjectionToSharedLineup({ playerId, teamId, includeFielding: true })
  log(`fielding change synced: ${canonicalName} -> ${position.toUpperCase()} (inning ${currentInning})`)
}

// ── play-by-play recording: turns the tracker's own console text into real
// plate_appearances/pitches/runs_scored/pitching_stints rows — the same
// tables the manual scorebook's saveEnhancedPA writes, so tracker games
// actually credit player stats and keep the live score in sync instead of
// only showing a display-only blob. Mirrors the literal `result` enum and
// derivation helpers from src/utils/statsCalculator.js / Scorebook.jsx.
//
// The stock tracker's log has no way to tell us every detail the manual
// scorebook captures. The experimental advanced-stat build now supplies exit
// velocity, launch angle, spray angle, and landing/catch distance; unsupported
// details are still left null for later review in the site's At-Bat editor.
// Anything the parser can't confidently classify (an unrecognized result
// phrase, an out on a non-batter runner, etc.) is skipped with a console
// warning rather than guessed, so it doesn't write wrong stats — that PA is
// left for manual entry instead.

const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function isOfficialAtBat(result) {
  return !['BB', 'HBP', 'SF', 'SH'].includes(result)
}

function normalizeRbiForPaResult(result, rbi = 0, isError = false) {
  if (isError || result === 'ROE' || result === 'DP' || result === 'TP' || result === 'FC') return 0
  return Number(rbi || 0)
}

function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  if (OUT_RESULTS.has(result)) return 1
  return 0
}

function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  return Number(`${Math.floor(safeOuts / 3)}.${safeOuts % 3}`)
}

// ── runner-identity replay ──────────────────────────────────────────────────
// PA replay is the fallback for older tracker builds/logs. Current tracker
// output reports each occupied base at the beginning of a matchup; that
// snapshot is applied later as the authoritative state because default hit
// advancement cannot know, for example, that a runner took two bases on a
// single.
const CLEARS_BASES = new Set(['HR', 'IPHR', 'TP'])
const HOLDS_RUNNERS = new Set(['K'])
const HIT_LIKE = new Set(['1B', '2B', '3B', 'BB', 'HBP', 'ROE'])
const OUT_LIKE = new Set(['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])

function runnerKey(runner) {
  return runner ? `${runner.characterId}:${runner.playerId}` : null
}

// The generic default advance (e.g. a single sends a runner from 2nd only to
// 3rd, not home) is a guess — real plays routinely score a runner from 2nd
// on a single depending on how it's hit. runs_scored rows are ground truth
// for exactly WHO scored on a given PA (finalizeCurrentPaIfAny already
// records them by resolved character/player id), so once the default
// assignment is computed, clear any pre-play occupant who's a confirmed
// scorer off whatever base the default guess left them on, instead of
// trusting the guess over the fact.
function applyKnownScorers(nextRunners, scorerKeys) {
  if (!scorerKeys || !scorerKeys.size) return nextRunners
  const result = { ...nextRunners }
  for (const base of ['first', 'second', 'third']) {
    // A scoring runner ends up on whatever base the default guess landed
    // them on — not necessarily the same base key they started the play on
    // (that's the whole point of advancing) — so this only needs to check
    // where they ended up, not where they started.
    if (result[base] && scorerKeys.has(runnerKey(result[base]))) {
      result[base] = null
    }
  }
  return result
}

function replayOnePa(pa, runners, scorerKeys) {
  const batterRunner = { characterId: pa.character_id, playerId: pa.player_id }
  if (CLEARS_BASES.has(pa.result)) return { first: null, second: null, third: null }
  if (HOLDS_RUNNERS.has(pa.result)) return runners
  if (HIT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingState(pa.result, runners, batterRunner)), scorerKeys)
  if (OUT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingOutState(pa.result, runners, batterRunner)), scorerKeys)
  return runners
}

// Replays every PA in the current half-inning (bases reset at the start of
// each) to reconstruct who is actually on base right now.
function deriveCurrentRunners(sortedPAs, totalOuts, scorerKeysByPaId) {
  const halfInningStartOuts = Math.floor(totalOuts / 3) * 3
  let runners = { first: null, second: null, third: null }
  let runningOuts = 0
  for (const pa of sortedPAs) {
    if (runningOuts >= halfInningStartOuts) {
      runners = replayOnePa(pa, runners, scorerKeysByPaId?.get(String(pa.id)))
    }
    runningOuts += calculateOutsForPa(pa.result, pa.outs_on_play)
  }
  return runners
}

function isSeasonGame() {
  return TARGET_GAMES_TABLE === 'season_schedule'
}

function addSourceFields(payload) {
  if (!isSeasonGame()) return payload
  return { ...payload, season_id: TARGET_SEASON_ID }
}

async function nextPaNumber() {
  const { count, error } = await supabase
    .from(GAME_TABLES.plateAppearances)
    .select('id', { count: 'exact', head: true })
    .eq('game_id', TARGET_GAME_ID)
  if (error) throw error
  return (count || 0) + 1
}

async function latestGamePitchNumber() {
  const { data, error } = await supabase
    .from(GAME_TABLES.pitches)
    .select('pitch_number_game')
    .eq('game_id', TARGET_GAME_ID)
    .order('pitch_number_game', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return Number(data?.pitch_number_game || 0)
}

async function insertPlateAppearance(payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const withPaNumber = { ...payload, pa_number: await nextPaNumber() }
    const { data, error } = await supabase
      .from(GAME_TABLES.plateAppearances).insert(withPaNumber).select().single()
    if (!error) return data
    if (error.code === '23505') continue // pa_number raced the manual scorebook — refetch and retry
    throw error
  }
  throw new Error('gave up inserting plate appearance after repeated pa_number conflicts')
}

// One row per (game_id, player_id) pitching stint. Tracker games previously
// had zero stint rows (Scorebook.jsx synthesizes the *current* pitcher from
// live_state instead) — this creates real rows so pitching stats have
// somewhere to accumulate, same shape `changePitcher` inserts in Scorebook.jsx.
const stintCacheByPlayerId = {}

async function ensureActiveStint(playerId, characterId) {
  if (playerId == null || characterId == null) return null
  const key = String(playerId)
  const cached = stintCacheByPlayerId[key]
  if (cached && Number(cached.character_id) === Number(characterId)) return cached

  const { data: existing, error } = await supabase
    .from(GAME_TABLES.pitchingStints).select('*')
    .eq('game_id', TARGET_GAME_ID).eq('player_id', playerId)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw error
  const latest = (existing || [])[0]
  if (latest && Number(latest.character_id) === Number(characterId)) {
    stintCacheByPlayerId[key] = latest
    return latest
  }

  const { data: inserted, error: insertError } = await supabase
    .from(GAME_TABLES.pitchingStints)
    .insert(addSourceFields({
      game_id: TARGET_GAME_ID, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
      walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    }))
    .select().single()
  if (insertError) throw insertError
  stintCacheByPlayerId[key] = inserted
  return inserted
}

// Rebuilds every stint's cumulative line from scratch off the game's own
// plate_appearances/runs_scored/pitches rows — same approach as Scorebook.jsx's
// recomputePitchingStatsForGame, simplified (no bulk-import re-entry edge cases).
async function recomputePitchingStatsForGame() {
  const [{ data: stints, error: stintsError }, { data: pas, error: pasError },
    { data: runs, error: runsError }, { data: pitches, error: pitchesError }] = await Promise.all([
    supabase.from(GAME_TABLES.pitchingStints).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.plateAppearances).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.runsScored).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.pitches).select('*').eq('game_id', TARGET_GAME_ID),
  ])
  const firstError = stintsError || pasError || runsError || pitchesError
  if (firstError) throw firstError
  if (!stints || !stints.length) return

  const sortedStints = [...stints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const sortedPAs = [...(pas || [])].sort((a, b) => {
    const paA = Number(a.pa_number)
    const paB = Number(b.pa_number)
    if (Number.isFinite(paA) && Number.isFinite(paB) && paA !== paB) return paA - paB
    return new Date(a.created_at) - new Date(b.created_at)
  })
  const statsByStintId = Object.fromEntries(sortedStints.map((s) => [s.id, {
    innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
    walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0, _outs: 0,
  }]))

  const stintFor = (characterId, atOrBefore) => {
    const eligible = sortedStints.filter((s) => (
      String(s.character_id) === String(characterId) && new Date(s.created_at).getTime() <= new Date(atOrBefore).getTime()
    ))
    return eligible[eligible.length - 1] || null
  }

  for (const pa of sortedPAs) {
    const activeStint = pa.pitcher_id != null ? stintFor(pa.pitcher_id, pa.created_at) : null
    if (!activeStint) continue
    const stat = statsByStintId[activeStint.id]
    const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
    stat._outs += outs
    if (isCreditedHit(pa)) stat.hits_allowed += 1
    if (isCreditedHit(pa) && isHomeRunResult(pa.result)) stat.hr_allowed += 1
    if (pa.result === 'BB') stat.walks += 1
    if (pa.result === 'K') stat.strikeouts += 1

    const paPitches = (pitches || []).filter((p) => String(p.pa_id) === String(pa.id))
    stat.pitches_thrown += paPitches.length
    stat.strikes_thrown += paPitches.filter((p) => p.result !== 'ball' && p.result !== 'hbp').length

    const paRuns = (runs || []).filter((r) => String(r.pa_id) === String(pa.id))
    for (const run of paRuns) {
      let target = stat
      if (String(run.charged_to_pitcher_id) !== String(activeStint.character_id)) {
        const chargedStint = stintFor(run.charged_to_pitcher_id, pa.created_at)
        if (chargedStint) target = statsByStintId[chargedStint.id]
      }
      target.runs_allowed += 1
      if (run.is_earned_run !== false) target.earned_runs += 1
    }
  }

  await Promise.all(sortedStints.map((s) => {
    const { _outs, ...rest } = statsByStintId[s.id]
    rest.innings_pitched = inningsPitchedFromOuts(_outs)
    return supabase.from(GAME_TABLES.pitchingStints).update(rest).eq('id', s.id)
  }))
}

// ── direct score sync ───────────────────────────────────────────────────────
// The tracker announces the running score by team name after every side
// change ("Mario Fireballs - 3" / "Wario Muscles - 0") and again in the
// final summary. Syncing straight from those lines keeps games.team_a_runs/
// team_b_runs (or season_schedule.away_score/home_score) correct even if
// the play-by-play reconstruction below misses or misclassifies a play.

let awayTeamName = null
let homeTeamName = null
const scoreState = { a: null, b: null }
let scoreSyncDebounce = null

function setLiveScoreForSide(side, value, { syncGame = true, scoreName = null } = {}) {
  const normalizedSide = String(side || '').toUpperCase()
  const normalizedValue = Number(value)
  if (!['A', 'B'].includes(normalizedSide) || !Number.isFinite(normalizedValue)) return false

  const stateKey = normalizedSide.toLowerCase()
  scoreState[stateKey] = normalizedValue
  liveState.scoreBySide = {
    ...(liveState.scoreBySide || {}),
    [stateKey]: normalizedValue,
  }

  // Keep the legacy named score map current for older clients, but publish a
  // side-keyed score too. The tracker only prints the named scoreboard at a
  // side change, while individual run messages arrive immediately; without
  // this, the snapshot can lag the game row for an entire half inning.
  const names = new Set()
  if (scoreName) names.add(String(scoreName).trim())
  if (normalizedSide === 'A' && awayTeamName) names.add(awayTeamName)
  if (normalizedSide === 'B' && homeTeamName) names.add(homeTeamName)
  Object.entries(trackerTeamMapping).forEach(([name, mappedSide]) => {
    if (mappedSide === normalizedSide) names.add(name)
  })
  names.forEach((name) => {
    if (name) liveState.score[name] = normalizedValue
  })

  if (syncGame) triggerScoreSync()
  return true
}

function triggerScoreSync() {
  clearTimeout(scoreSyncDebounce)
  scoreSyncDebounce = setTimeout(() => {
    syncScoreFromTracker().catch((err) => log('score sync failed:', err.message))
  }, 300)
}

async function syncScoreFromTracker() {
  if (scoreState.a == null || scoreState.b == null) return
  const payload = isSeasonGame()
    ? { away_score: scoreState.a, home_score: scoreState.b }
    : { team_a_runs: scoreState.a, team_b_runs: scoreState.b }
  const { error } = await supabase.from(TARGET_GAMES_TABLE).update(payload).eq('id', TARGET_GAME_ID)
  if (error) throw error
  if (liveState.gameEnded) await finalizeTrackerGame()
}

function trackerSourceType() {
  return isSeasonGame() ? 'season' : 'tournament'
}

function expectedTrackerPitchersByPlayer() {
  const result = {}
  Object.entries(liveState.alignments || {}).forEach(([playerId, alignment]) => {
    const pitcherName = alignment?.fielding?.P
    const characterId = resolveCharacterId(pitcherName)
    if (characterId != null) result[playerId] = characterId
  })
  if (liveState.matchup?.left) {
    const playerId = resolvePlayerIdForCharacter(liveState.matchup.left)
    const characterId = resolveCharacterId(liveState.matchup.left)
    if (playerId != null && characterId != null) result[playerId] = characterId
  }
  return result
}

let bettingSyncDebounce = null
let bettingSyncPromise = null
let bettingSyncVersion = 0
let requestedMarketSignature = null
let queuedMarketSignature = null
let lastPricedMarketSignature = null

function buildMarketStateSignature() {
  return buildTrackerMarketInputSignature({
    scoreState,
    liveState: buildLiveStatePayload(),
    expectedPitcherByPlayer: expectedTrackerPitchersByPlayer(),
    completedPaRevision,
  })
}

async function publishOddsCalculationState(isCalculating) {
  liveState.oddsCalculating = Boolean(isCalculating)
  liveState.oddsRevision = completedPaRevision
  liveState.oddsStatusUpdatedAt = new Date().toISOString()

  const { error } = await supabase.from(TARGET_STATS_TABLE)
    .update({
      live_feed: { ...liveState },
      updated_at: new Date().toISOString(),
    })
    .eq('game_id', TARGET_GAME_ID)
  if (error) log('could not publish live-odds calculation state:', error.message)
}

function runQueuedBettingSync(signature) {
  queuedMarketSignature = signature
  if (bettingSyncPromise) return bettingSyncPromise

  bettingSyncPromise = (async () => {
    let calculationPublished = false
    try {
      while (queuedMarketSignature && !liveState.gameEnded) {
        const targetSignature = queuedMarketSignature
        queuedMarketSignature = null
        if (targetSignature === lastPricedMarketSignature || targetSignature !== buildMarketStateSignature()) continue

        if (!calculationPublished) {
          calculationPublished = true
          await publishOddsCalculationState(true)
        }
        await syncTrackerLiveOdds({
          supabase,
          sourceType: trackerSourceType(),
          sourceId: TARGET_SOURCE_ID,
          gameId: TARGET_GAME_ID,
          liveState: buildLiveStatePayload(),
          teamARuns: scoreState.a,
          teamBRuns: scoreState.b,
          expectedPitcherByPlayer: expectedTrackerPitchersByPlayer(),
          regulationInnings: TARGET_GAME_ROW?.innings,
          // If another completed at-bat lands while the data queries are
          // running, do not publish obsolete prices. Keep the game disabled
          // and immediately calculate the newest completed state instead.
          shouldPersist: () => targetSignature === buildMarketStateSignature(),
        })
        if (targetSignature === buildMarketStateSignature()) {
          lastPricedMarketSignature = targetSignature
          requestedMarketSignature = null
        }
      }
    } finally {
      if (calculationPublished) {
        // Let any state pushes that began while pricing finish first. They all
        // carry the shared calculation flag, so publishing `false` last keeps
        // an older request from re-locking the board after prices are ready.
        await pushStateQueue.catch(() => {})
        await publishOddsCalculationState(false)
      }
    }
  })().finally(() => {
    bettingSyncPromise = null
    // A completed at-bat can arrive while the final unlocked state is being
    // published. It has already queued its signature, so start the next pass
    // instead of leaving it stranded until an unrelated tracker event.
    if (queuedMarketSignature && !liveState.gameEnded) {
      const nextSignature = queuedMarketSignature
      runQueuedBettingSync(nextSignature).catch((err) => {
        requestedMarketSignature = null
        log('queued live odds sync failed:', err.message)
      })
    }
  })

  return bettingSyncPromise
}

function triggerBettingSync() {
  if (liveState.gameEnded) return
  // Result/RBI/run messages arrive before the next matchup header closes and
  // persists the PA. Never price that half-written play; finalizeCurrentPaIfAny
  // triggers again after PA, run and pitching rows are all authoritative.
  if (currentPaBuffer?.result || paFinalizationInProgress) {
    requestedMarketSignature = null
    bettingSyncVersion += 1
    clearTimeout(bettingSyncDebounce)
    return
  }
  const signature = buildMarketStateSignature()
  if (signature === lastPricedMarketSignature) {
    if (requestedMarketSignature) {
      requestedMarketSignature = null
      bettingSyncVersion += 1
      clearTimeout(bettingSyncDebounce)
    }
    return
  }
  if (signature === requestedMarketSignature) return

  requestedMarketSignature = signature
  const requestedVersion = ++bettingSyncVersion
  clearTimeout(bettingSyncDebounce)
  bettingSyncDebounce = setTimeout(async () => {
    // A completed play writes its PA, runs and pitching totals through the
    // play queue. Await those writes, then capture the final signature once.
    await Promise.all([
      playEventChain.catch(() => {}),
      pushStateQueue.catch(() => {}),
    ])
    if (requestedVersion !== bettingSyncVersion || liveState.gameEnded || currentPaBuffer?.result) {
      requestedMarketSignature = null
      return
    }
    const finalSignature = buildMarketStateSignature()
    requestedMarketSignature = finalSignature
    runQueuedBettingSync(finalSignature).catch((err) => {
      requestedMarketSignature = null
      log('live odds sync failed:', err.message)
    })
  }, ODDS_REPRICE_DEBOUNCE_MS)
}

let finalizationPromise = null
async function finalizeTrackerGame() {
  if (scoreState.a == null || scoreState.b == null) return
  if (finalizationPromise) return finalizationPromise

  finalizationPromise = (async () => {
    const winnerPlayerId = scoreState.a === scoreState.b
      ? null
      : scoreState.a > scoreState.b ? TARGET_TEAM_A_PLAYER_ID : TARGET_TEAM_B_PLAYER_ID
    const finalInning = Math.max(1, Number(liveState.inning || 1))
    const regulationInnings = Math.max(1, Number(TARGET_GAME_ROW?.innings || 3))
    const completion = isSeasonGame()
      ? {
          status: 'completed',
          away_score: scoreState.a,
          home_score: scoreState.b,
          winner_team_id: winnerPlayerId == null ? null : TEAM_ID_BY_PLAYER_ID[String(winnerPlayerId)] || null,
          final_inning: finalInning,
          is_extra_innings: finalInning > regulationInnings,
          live_state: buildLiveStatePayload(),
        }
      : {
          status: 'complete',
          team_a_runs: scoreState.a,
          team_b_runs: scoreState.b,
          winner_player_id: winnerPlayerId,
          final_inning: finalInning,
          is_extra_innings: finalInning > regulationInnings,
          live_state: buildLiveStatePayload(),
        }
    const { error: completionError } = await supabase.from(TARGET_GAMES_TABLE)
      .update(completion).eq('id', TARGET_GAME_ID)
    if (completionError) throw completionError

    await settleCompletedTrackerGame({
      supabase,
      sourceType: trackerSourceType(),
      sourceId: TARGET_SOURCE_ID,
      gameId: TARGET_GAME_ID,
      teamARuns: scoreState.a,
      teamBRuns: scoreState.b,
      teamBPlayerId: TARGET_TEAM_B_PLAYER_ID,
      winnerPlayerId,
    })
    const oddsTable = isSeasonGame() ? 'season_game_odds' : 'game_odds'
    const { error: oddsLockError } = await supabase.from(oddsTable)
      .update({ is_locked: true, updated_at: new Date().toISOString() })
      .eq('game_id', TARGET_GAME_ID)
    if (oddsLockError) throw oddsLockError
    log(`game finalized automatically: ${scoreState.a}-${scoreState.b}; bets settled and markets locked`)
  })().catch((err) => {
    finalizationPromise = null
    throw err
  })
  return finalizationPromise
}

// ── play-by-play parser state machine ───────────────────────────────────────

let parserInning = 1
let parserIsTop = true
// Tracks outs within the current half inning purely off completed PAs run
// through this same serialized play-event chain — deliberately independent
// of liveState.outs (which is updated synchronously per log line and can run
// ahead of/behind whichever PA this chain is still slowly writing to
// Supabase) so a sac-fly reclassification always sees the out count as it
// stood when this specific plate appearance actually began.
let parserOutsInHalf = 0
let currentPaBuffer = null
let paFinalizationInProgress = false
let completedPaRevision = 0
let pendingRunnerAssignmentBackfill = null
// Separate from pendingRunnerAssignmentBackfill (which the next batter's
// first "Count:" line consumes and clears): a batted-ball record for a
// contact that never got a real landing/catch can arrive well after that —
// its flight-timeout flush routinely loses the race against the next
// matchup line, and even against the next batter's first full pitch. This
// stays populated across that whole window so the record still finds its
// way onto the plate appearance it actually belongs to.
let lastFinalizedPa = null

function freshPaBuffer(pitcherName, batterName, pitcherIds, batterIds, battingTeamId, defensiveTeamId) {
  return {
    pitcherName, batterName,
    pitcherCharacterId: pitcherIds.characterId, pitcherPlayerId: pitcherIds.playerId,
    batterCharacterId: batterIds.characterId, batterPlayerId: batterIds.playerId,
    battingTeamId, defensiveTeamId,
    inning: parserInning, isTop: parserIsTop,
    outsBeforePa: parserOutsInHalf,
    countSeenOnce: false,
    lastCount: { balls: 0, strikes: 0 },
    pendingPitchType: null,
    pendingStarPitch: false,
    pendingDoublePlay: false,
    pendingTriplePlay: false,
    contactRecorded: false,
    pitches: [],
    pendingPitchTelemetry: [],
    result: null,
    unresolvedReason: null,
    rbi: 0,
    runEvents: [],
    runnersBefore: { first: null, second: null, third: null },
    starHitUsed: false,
    battedBallTrajectory: null,
    putoutFielderName: null,
    observedPutouts: [],
    assistFielderNames: [],
    isBuddyJump: false,
    buddyJumpFielderName: null,
    bobbleFielderName: null,
    advancedBattedBall: null,
    advancedFielding: null,
  }
}

function recordRunnerBeforePa(buf, { characterName, base }) {
  if (!buf || !['first', 'second', 'third'].includes(base)) return false
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) return false
  buf.runnersBefore[base] = { characterId, playerId }
  return true
}

// Persist only runner movements that follow directly from the result. Hits
// with pre-existing runners and batted-ball outs can include discretionary
// advances that are not fully described by the stock play-by-play; those stay
// null until the exact post-play base snapshot is added to the tracker feed.
function deterministicRunnerAssignments(buf, isError) {
  const runners = buf.runnersBefore || { first: null, second: null, third: null }
  const batter = {
    characterId: Number(buf.batterCharacterId),
    playerId: buf.batterPlayerId,
    ...(isError ? { reachedOnError: true } : {}),
    chargedToPitcherId: buf.pitcherCharacterId,
    chargedToPitcherPlayerId: buf.pitcherPlayerId,
  }
  const hasRunners = Boolean(runners.first || runners.second || runners.third)

  if (buf.result === 'HR' || buf.result === 'IPHR') {
    return [
      { id: 'batter', runner: batter, origin: 'plate', destination: 'home', isBatter: true },
      ...['first', 'second', 'third'].filter((base) => runners[base]).map((base) => ({
        id: base, runner: runners[base], origin: base, destination: 'home', isBatter: false,
      })),
    ]
  }
  if (buf.result === 'BB' || buf.result === 'HBP') {
    return computePendingState(buf.result, runners, batter).assignments
  }
  if (!hasRunners && ['1B', '2B', '3B', 'ROE'].includes(buf.result)) {
    return computePendingState(buf.result, runners, batter).assignments
  }
  if (!hasRunners && ['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'TP', 'K'].includes(buf.result)) {
    return [{ id: 'batter', runner: batter, origin: 'plate', destination: 'out', isBatter: true }]
  }
  if (!hasRunners && buf.result === 'FC') {
    return [{ id: 'batter', runner: batter, origin: 'plate', destination: 'first', isBatter: true }]
  }
  return null
}

async function backfillPriorRunnerAssignments(nextPaBuffer) {
  const pending = pendingRunnerAssignmentBackfill
  pendingRunnerAssignmentBackfill = null
  if (!pending || !nextPaBuffer) return
  const { buf, savedPaId, isError } = pending
  // A side change clears the bases; it is not a post-play runner snapshot for
  // the previous offense, so retain the conservative assignments already
  // written for that inning-ending PA.
  if (String(buf.battingTeamId) !== String(nextPaBuffer.battingTeamId)) return

  const runnerForName = (name) => {
    const characterId = resolveCharacterId(name)
    const playerId = resolvePlayerIdForCharacter(name)
    return characterId == null || playerId == null ? null : { characterId, playerId }
  }
  const runnerKey = (runner) => runner ? `${runner.characterId}:${runner.playerId}` : null
  const scoringRunnerKeys = new Set(buf.runEvents.map((run) => runnerKey(runnerForName(run.scorerName))).filter(Boolean))
  const outRunnerKeys = new Set(buf.observedPutouts.map((putout) => runnerKey(runnerForName(putout.runnerName))).filter(Boolean))
  const batter = {
    characterId: Number(buf.batterCharacterId),
    playerId: buf.batterPlayerId,
    ...(isError ? { reachedOnError: true } : {}),
    chargedToPitcherId: buf.pitcherCharacterId,
    chargedToPitcherPlayerId: buf.pitcherPlayerId,
  }
  const assignments = buildExactTrackerRunnerAssignments({
    runnersBefore: buf.runnersBefore,
    batter,
    nextRunners: nextPaBuffer.runnersBefore,
    scoringRunnerKeys,
    outRunnerKeys,
    batterOut: ['K', 'GO', 'FO', 'LO', 'SF', 'SH'].includes(buf.result),
  })
  if (!assignments) {
    log(`runner destinations for ${buf.batterName}'s ${buf.result} were not fully described by the next-base snapshot; retaining conservative values.`)
    return
  }
  const { error } = await supabase.from(GAME_TABLES.plateAppearances)
    .update({ runner_assignments: assignments })
    .eq('id', savedPaId)
  if (error) log(`exact runner-assignment update failed for ${buf.batterName}:`, error.message)
}

// Resolves a tracker fielder name to their current defensive position number
// (1-9) using the fielding alignment last synced for that side (see
// syncTrackerAlignment/syncTrackerPositionChange) — used to turn the play-by-
// play's fielder names into the position-chain notation the rest of the site
// already expects (see src/utils/notation.js's assembleNotation).
function currentFieldingPositionNumber(playerId, name) {
  if (playerId == null || !name) return null
  const fielding = liveState.alignments?.[String(playerId)]?.fielding
  if (!fielding) return null
  const trimmed = name.trim()
  const position = Object.entries(fielding).find(([, charName]) => charName === trimmed)?.[0]
  return position ? TRACKER_POSITION_NUMBERS[position.toUpperCase()] ?? null : null
}

function pushPitch(buf, type, before, after) {
  const telemetry = buf.pendingPitchTelemetry.shift() || null
  buf.pitches.push(consumeTrackerPitch(buf, {
    type,
    before: before || { ...buf.lastCount },
    after: after || { ...buf.lastCount },
    pitchType: telemetry?.pitchType ?? null,
    isStarPitch: Boolean(telemetry?.isStarPitch),
  }))
}

// The tracker's pitch-flight diagnostic can arrive before or after the
// count-change line that actually closes out the pitch, so it either merges
// straight onto the just-pushed pitch (matched by its 1-based position in
// this PA) or waits in a queue for the next pushPitch to consume — mirrors
// tracker_preview_state.mjs's applyPitchTelemetry.
function applyPitchTelemetry(buf, telemetry) {
  if (!buf || !telemetry) return false
  if (telemetry.pitcherName && telemetry.pitcherName !== 'unknown' && telemetry.pitcherName !== buf.pitcherName) return false
  if (telemetry.batterName && telemetry.batterName !== 'unknown' && telemetry.batterName !== buf.batterName) return false
  const lastPitch = buf.pitches.at(-1)
  if (lastPitch && lastPitch.pitchType == null && telemetry.pitchCounter === buf.pitches.length) {
    lastPitch.pitchType = telemetry.pitchType
    lastPitch.isStarPitch = Boolean(lastPitch.isStarPitch || telemetry.isStarPitch)
  } else {
    buf.pendingPitchTelemetry.push(telemetry)
  }
  return true
}

// "Double play!"/"Triple play!" arrive as their own lines, separate from the
// "<batter>'s hit was caught!"/putout lines that set the base FO/GO result —
// and the tracker doesn't guarantee which comes first. Apply whichever
// pending multi-out flag is set the moment a batted-ball out result lands,
// and also re-check here in case the multi-out line itself arrives after.
function applyPendingMultiOut(buf) {
  if (!['FO', 'LO', 'GO'].includes(buf.result)) return
  if (buf.pendingTriplePlay) { buf.result = 'TP'; buf.pendingTriplePlay = false; buf.pendingDoublePlay = false }
  else if (buf.pendingDoublePlay) { buf.result = 'DP'; buf.pendingDoublePlay = false }
}

// Caught fly balls never get their own "Fair ball!" line (unlike grounders/
// liners, which always do) — without this, the pitch that ended the PA would
// be silently missing from the pitch log and pitcher pitch/strike counts.
function ensureContactPitch(buf) {
  if (buf.contactRecorded) return
  pushPitch(buf, 'in_play')
  buf.contactRecorded = true
  bumpLivePitchCount(buf, true)
}

function ensureHitByPitch(buf) {
  if (buf.result === 'HBP') return
  pushPitch(buf, 'hbp')
  buf.pendingPitchType = null
  buf.result = 'HBP'
  bumpLivePitchCount(buf, false)
}

async function startNewPa(pitcherName, batterName) {
  const pitcherIds = { characterId: resolveCharacterId(pitcherName), playerId: resolvePlayerIdForCharacter(pitcherName) }
  const batterIds = { characterId: resolveCharacterId(batterName), playerId: resolvePlayerIdForCharacter(batterName) }
  const battingTeamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(batterIds.playerId)] ?? null : batterIds.playerId
  const defensiveTeamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(pitcherIds.playerId)] ?? null : pitcherIds.playerId

  let pitcherStint = null
  if (pitcherIds.playerId != null && pitcherIds.characterId != null) {
    try {
      pitcherStint = await ensureActiveStint(pitcherIds.playerId, pitcherIds.characterId)
    } catch (err) {
      log('failed to create/find pitching stint for', pitcherName, ':', err.message)
    }
  }

  currentPaBuffer = freshPaBuffer(pitcherName, batterName, pitcherIds, batterIds, battingTeamId, defensiveTeamId)
  currentPaBuffer.pitcherStint = pitcherStint
}

// Live per-pitch tick so the pitcher's pitch/strike count moves during the
// at-bat instead of jumping all at once when the PA finally gets written —
// recomputePitchingStatsForGame (run after every PA save) is the source of
// truth and will correct any drift, so this is best-effort/non-blocking.
function bumpLivePitchCount(buf, isStrike) {
  const stint = buf.pitcherStint
  if (!stint) return
  stint.pitches_thrown = (stint.pitches_thrown || 0) + 1
  if (isStrike) stint.strikes_thrown = (stint.strikes_thrown || 0) + 1
  supabase.from(GAME_TABLES.pitchingStints)
    .update({ pitches_thrown: stint.pitches_thrown, strikes_thrown: stint.strikes_thrown })
    .eq('id', stint.id)
    .then(({ error }) => { if (error) log('live pitch count update failed:', error.message) })
}

async function finalizeCurrentPaIfAny() {
  const buf = currentPaBuffer
  currentPaBuffer = null
  if (!buf) return

  if (shouldClassifyTrackerFielderChoice(buf)) {
    buf.result = 'FC'
    buf.unresolvedReason = null
  }

  if (!buf.result) {
    log(`could not determine a result for ${buf.batterName}'s plate appearance (vs. ${buf.pitcherName}) — skipping stat write.` +
      (buf.unresolvedReason ? ` Reason: ${buf.unresolvedReason}.` : '') +
      ' Record this play manually via the At-Bat editor.')
    return
  }
  if (buf.batterCharacterId == null || buf.batterPlayerId == null || buf.pitcherCharacterId == null || buf.pitcherPlayerId == null
    || buf.battingTeamId == null || buf.defensiveTeamId == null) {
    log(`could not resolve roster ids for ${buf.batterName} vs. ${buf.pitcherName} — skipping stat write. ` +
      'Make sure both characters are drafted/rostered for this game, then record the play manually via the At-Bat editor.')
    return
  }

  let completed = false
  paFinalizationInProgress = true
  try {
    // The measured launch angle separates low airborne contact from a fly.
    // Normalize the result before sacrifice-fly and official-AB rules run.
    if (buf.result === 'FO' && buf.battedBallTrajectory === 'L') buf.result = 'LO'

    // The stock tracker announces bobbles but does not publish a separate
    // official-error counter. When it credits the batter with a safe base on
    // that same bobbled play, store the scorer-facing result as ROE so the hit
    // is not accidentally counted in batting/pitching totals.
    const isBobbleError = shouldChargeTrackerBobbleError({
      bobbleFielderName: buf.bobbleFielderName,
      result: buf.result,
    })
    if (isBobbleError && ['1B', '2B', '3B'].includes(buf.result)) buf.result = 'ROE'

    // Turns the fielder names captured off the play-by-play into the same
    // trajectory+position-chain notation the manual scorebook/editor write
    // (see src/utils/notation.js), so buildFieldingChances in
    // src/utils/statsCalculator.js credits putouts/assists/buddy jumps for
    // tracker games exactly like it does for manually-scored ones. A hit can
    // also carry a chain when a baserunner was put out on the play. BB and K
    // do not (the catcher's strikeout putout is inferred downstream).
    // A sac fly is a scoring rule, not a judgment call — the tracker never
    // says "sacrifice", but a caught fly ball that scores a runner with fewer
    // than 2 outs is one by definition, so reclassify it before it gets
    // written as a plain flyout (which would wrongly count as an official AB).
    const isBunt = isTrackerBuntedBall(buf.advancedBattedBall)
    if (shouldReclassifyTrackerFlyOutAsSacFly({
      result: buf.result,
      outsBeforePa: buf.outsBeforePa,
      scoredNonBatterRunner: buf.runEvents.some((run) => run.scorerName !== buf.batterName),
      isBunt,
    })) {
      buf.result = 'SF'
    }
    // A sacrifice bunt is scored by the same kind of rule as the sac fly above,
    // and is now detectable because the measured exit velocity says a bunt was
    // laid down. The bunt itself reaches the database through `trajectory`
    // ('B'), written from buf.battedBallTrajectory below.
    if (shouldClassifyTrackerSacrificeBunt({
      isBunt,
      result: buf.result,
      outsBeforePa: buf.outsBeforePa,
      hasRunnerOn: Boolean(buf.runnersBefore.first || buf.runnersBefore.second || buf.runnersBefore.third),
    })) {
      buf.result = 'SH'
    }
    const outsOnPlay = trackerOutsOnPlay(buf, calculateOutsForPa(buf.result, null))
    parserOutsInHalf += outsOnPlay
    let hitNotation = null
    let errorNotation = null
    let buddyJumpAssistPosition = null
    let buddyJumpPutoutPosition = null
    if (buf.isBuddyJump && buf.buddyJumpFielderName) {
      buddyJumpPutoutPosition = currentFieldingPositionNumber(buf.pitcherPlayerId, buf.buddyJumpFielderName)
      if (buf.assistFielderNames.length) {
        buddyJumpAssistPosition = currentFieldingPositionNumber(buf.pitcherPlayerId, buf.assistFielderNames[0])
      }
    } else if (outsOnPlay > 0 && buf.putoutFielderName) {
      const chainNames = [...buf.assistFielderNames, buf.putoutFielderName]
      const positions = chainNames.map((name) => currentFieldingPositionNumber(buf.pitcherPlayerId, name))
      if (positions.every((position) => position != null)) {
        hitNotation = `${buf.battedBallTrajectory || (buf.result === 'FO' ? 'F' : 'G')}${positions.join('-')}`
      } else {
        log(`could not resolve a fielding position for ${buf.batterName}'s ${buf.result} (fielder(s): ${chainNames.join(', ')}) — ` +
          'putout/assist credit left for manual entry via the At-Bat editor.')
      }
    }

    const starPitchFlags = trackerStarPitchPaFlags(buf.pitches, outsOnPlay)
    const errorPosition = isBobbleError
      ? currentFieldingPositionNumber(buf.pitcherPlayerId, buf.bobbleFielderName)
      : null
    if (isBobbleError && errorPosition != null) {
      const leadingPositions = buf.assistFielderNames
        .map((name) => currentFieldingPositionNumber(buf.pitcherPlayerId, name))
        .filter((position) => position != null)
      const fieldingChain = [...leadingPositions, errorPosition]
      errorNotation = assembleErrorNotation(buf.battedBallTrajectory || 'G', fieldingChain, errorPosition)
      hitNotation = errorNotation
    }
    const batterRun = buf.runEvents.find((run) => run.scorerName === buf.batterName)
    const runnerAssignments = deterministicRunnerAssignments(buf, isBobbleError)
    const paPayload = addSourceFields({
      game_id: TARGET_GAME_ID,
      player_id: buf.batterPlayerId,
      character_id: buf.batterCharacterId,
      batting_team_id: buf.battingTeamId,
      defensive_team_id: buf.defensiveTeamId,
      pitcher_id: buf.pitcherCharacterId,
      pitcher_player_id: buf.pitcherPlayerId,
      inning: buf.inning,
      result: buf.result,
      outs_on_play: outsOnPlay,
      rbi: normalizeRbiForPaResult(buf.result, buf.rbi, isBobbleError),
      run_scored: isHomeRunResult(buf.result) || buf.runEvents.some((r) => r.scorerName === buf.batterName),
      is_official_ab: isOfficialAtBat(buf.result),
      is_earned_run: batterRun ? batterRun.earnedRun === true : !isBobbleError,
      runner_on_first_before: Boolean(buf.runnersBefore.first),
      runner_on_second_before: Boolean(buf.runnersBefore.second),
      runner_on_third_before: Boolean(buf.runnersBefore.third),
      runner_assignments: runnerAssignments,
      star_hit_used: Boolean(buf.starHitUsed),
      star_pitch_used: starPitchFlags.starPitchUsed,
      star_pitch_successful: starPitchFlags.starPitchSuccessful,
      ...trackerBattedBallPaFields(buf.advancedBattedBall, { stadiumKey: TARGET_STADIUM_KEY }),
      ...trackerFieldedBallPaFields(buf.advancedFielding, { stadiumKey: TARGET_STADIUM_KEY }),
      // applyTrackerBattedBallToBuffer (tracker_play_events.mjs) derives this
      // from launch angle for any landing/catch endpoint, safe hits included
      // — it is not out-only. It stays null only when no batted-ball record
      // ever arrived for this contact (e.g. the exe in use doesn't emit
      // TRACKER_BATTED_BALL_PROVISIONAL), leaving room for the separately
      // editable At-Bat Editor trajectory.
      trajectory: buf.battedBallTrajectory,
      hit_notation: hitNotation,
      is_error: isBobbleError,
      error_position: errorPosition,
      error_character: isBobbleError
        ? characterNamesById[String(resolveCharacterId(buf.bobbleFielderName))] || buf.bobbleFielderName
        : null,
      error_player: isBobbleError ? playerNamesById[String(buf.pitcherPlayerId)] || null : null,
      error_notation: errorNotation,
      fielder_choice_out: buf.result === 'FC',
      // The tracker uses the same replay flow for offensive highlights,
      // defensive highlights, Buddy Jumps, and some strikeouts. It exposes
      // no reliable general-dive signal, so Nice Plays remain a postgame edit.
      is_nice_play: false,
      is_buddy_jump: Boolean(buf.isBuddyJump),
      buddy_jump_assist_position: buddyJumpAssistPosition,
      buddy_jump_putout_position: buddyJumpPutoutPosition,
      is_robbed_hr: isTrackerRobbedHomeRun({
        record: buf.advancedBattedBall,
        isBuddyJump: buf.isBuddyJump,
        stadiumKey: TARGET_STADIUM_KEY,
      }),
      strikeout_type: buf.result === 'K'
        ? (buf.pitches.at(-1)?.type === 'looking' ? 'KL'
          : buf.pitches.at(-1)?.type === 'swinging_miss' ? 'KS' : null)
        : null,
    })
    const savedPa = await insertPlateAppearance(paPayload)

    if (buf.pitches.length) {
      const numberedPitches = numberTrackerPitches(buf.pitches, await latestGamePitchNumber())
      const pitchPayload = numberedPitches.map((p) => addSourceFields({
        game_id: TARGET_GAME_ID, pa_id: savedPa.id,
        pitcher_id: buf.pitcherName, pitcher_player: '', batter_id: buf.batterName,
        inning: buf.inning, half: buf.isTop ? 'top' : 'bottom',
        pitch_number_pa: p.pitch_number_pa, pitch_number_game: p.pitch_number_game,
        ...trackerPitchStatFields(p),
      }))
      const { error: pitchError } = await supabase.from(GAME_TABLES.pitches).insert(pitchPayload)
      if (pitchError) log('pitch insert failed for', buf.batterName, ':', pitchError.message)
    }

    if (buf.runEvents.length) {
      const runPayload = []
      for (const run of buf.runEvents) {
        const scorerPlayerId = resolvePlayerIdForCharacter(run.scorerName)
        const scorerCharacterId = resolveCharacterId(run.scorerName)
        const chargedName = run.chargedToPitcherName || buf.pitcherName
        const chargedPlayerId = resolvePlayerIdForCharacter(chargedName)
        const chargedCharacterId = resolveCharacterId(chargedName)
        if (scorerPlayerId == null || chargedPlayerId == null) {
          log(`could not resolve run scorer/pitcher for a run by ${run.scorerName} — skipping that run row (total score still syncs separately).`)
          continue
        }
        runPayload.push(addSourceFields({
          game_id: TARGET_GAME_ID, pa_id: savedPa.id, inning: buf.inning, half: buf.isTop ? 'top' : 'bottom',
          scoring_player_id: scorerPlayerId, scoring_character_id: scorerCharacterId,
          charged_to_pitcher_id: chargedCharacterId, charged_to_pitcher_player_id: chargedPlayerId,
          is_earned_run: run.earnedRun === true,
        }))
      }
      if (runPayload.length) {
        const { error: runError } = await supabase.from(GAME_TABLES.runsScored).insert(runPayload)
        if (runError) log('run insert failed for', buf.batterName, ':', runError.message)
      }
    }

    await recomputePitchingStatsForGame()
    try {
      await resolveOnPA(
        TARGET_GAME_ID,
        savedPa,
        buildTrackerBetResolutionConfig({
          supabase,
          sourceType: trackerSourceType(),
          sourceId: TARGET_SOURCE_ID,
        }),
      )
    } catch (bettingError) {
      log('live bet resolution failed for PA', savedPa.pa_number, ':', bettingError.message)
    }
    pendingRunnerAssignmentBackfill = { buf, savedPaId: savedPa.id, isError: isBobbleError }
    lastFinalizedPa = { buf, savedPaId: savedPa.id }
    completedPaRevision += 1
    completed = true
    log(`recorded PA #${savedPa.pa_number}: ${buf.batterName} -> ${buf.result}${buf.rbi ? ` (${buf.rbi} RBI)` : ''}`)
  } catch (err) {
    log('failed to record plate appearance for', buf.batterName, ':', err.message)
  } finally {
    paFinalizationInProgress = false
    if (completed) triggerBettingSync()
  }
}

async function processPlayEvent(message) {
  const trackerBatting = parseTrackerBattingMessage(message)
  if (trackerBatting) {
    try {
      await syncTrackerBattingOrder(trackerBatting)
    } catch (err) {
      log(`batting-order sync rejected for ${trackerBatting.teamName || 'unknown tracker team'}:`, err.message)
    }
    return
  }

  const trackerAlignment = parseTrackerLineupMessage(message)
  if (trackerAlignment) {
    try {
      await syncTrackerAlignment(trackerAlignment)
    } catch (err) {
      log(`lineup sync rejected for ${trackerAlignment.teamName || 'unknown tracker team'}:`, err.message)
    }
    return
  }

  const positionChange = message.match(TRACKER_POSITION_CHANGE_RE)
  if (positionChange) {
    try {
      await syncTrackerPositionChange(positionChange[1].trim(), positionChange[2].toUpperCase())
    } catch (err) {
      log('fielding position sync failed:', err.message)
    }
    return
  }

  const buf = currentPaBuffer
  let m

  if (String(message || '').trim().startsWith(TRACKER_FIELDED_BALL_MARKER)) {
    const advancedFielding = parseTrackerFieldedBallMessage(message)
    if (!advancedFielding) {
      log('ignored malformed advanced fielding record:', message)
      return
    }
    if (!buf) {
      log(`ignored advanced fielding record with no active plate appearance (contact ${advancedFielding.contactSeq}).`)
      return
    }
    if (!applyTrackerFieldedBallToBuffer(buf, advancedFielding)) {
      log(`ignored advanced fielding record for ${advancedFielding.batterName} vs. ${advancedFielding.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
    }
    return
  }

  if (String(message || '').trim().startsWith(TRACKER_BATTED_BALL_MARKER)) {
    const advancedBattedBall = parseTrackerBattedBallMessage(message)
    if (!advancedBattedBall) {
      log('ignored malformed advanced batted-ball record:', message)
      return
    }
    if (!buf) {
      log(`ignored advanced batted-ball record with no active plate appearance (contact ${advancedBattedBall.contactSeq}).`)
      return
    }
    if (!applyTrackerBattedBallToBuffer(buf, advancedBattedBall)) {
      if (lastFinalizedPa && applyTrackerBattedBallToBuffer(lastFinalizedPa.buf, advancedBattedBall)) {
        const { error } = await supabase.from(GAME_TABLES.plateAppearances)
          .update({
            ...trackerBattedBallPaFields(lastFinalizedPa.buf.advancedBattedBall, { stadiumKey: TARGET_STADIUM_KEY }),
            trajectory: lastFinalizedPa.buf.battedBallTrajectory,
          })
          .eq('id', lastFinalizedPa.savedPaId)
        if (error) log('late batted-ball backfill failed for', advancedBattedBall.batterName, ':', error.message)
        return
      }
      log(`ignored advanced batted-ball record for ${advancedBattedBall.batterName} vs. ${advancedBattedBall.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
      return
    }
    return
  }

  if (String(message || '').trim().startsWith(TRACKER_PITCH_PROVISIONAL_MARKER)) {
    const telemetry = parseTrackerPitchProvisionalMessage(message)
    if (!telemetry) {
      log('ignored malformed pitch diagnostic record:', message)
      return
    }
    if (!buf) {
      log(`ignored pitch diagnostic record with no active plate appearance (pitch ${telemetry.pitchCounter}).`)
      return
    }
    if (!applyPitchTelemetry(buf, telemetry)) {
      log(`ignored pitch diagnostic record for ${telemetry.batterName} vs. ${telemetry.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
    }
    return
  }

  if (buf) {
    const runnerBefore = parseTrackerRunnerMessage(message)
    if (runnerBefore) {
      if (!recordRunnerBeforePa(buf, runnerBefore)) {
        log(`could not resolve ${runnerBefore.characterName} on ${runnerBefore.base} for runner-state persistence.`)
      }
      return
    }
    if (markPendingTrackerStarPitch(buf, message)) return
    if (isTrackerReplayMessage(message)) return
    if (/^Strike\s+\d+\.$/i.test(message)) { buf.pendingPitchType = 'strike'; return }
    if (/^Foul ball!$/i.test(message)) { buf.pendingPitchType = 'foul'; return }
    if (/^Fair ball!$/i.test(message)) {
      pushPitch(buf, 'in_play')
      buf.contactRecorded = true
      bumpLivePitchCount(buf, true)
      return
    }

    if ((m = message.match(/^Count:\s*(\d)-(\d)$/i))) {
      const newBalls = Number(m[1])
      const newStrikes = Number(m[2])
      if (!buf.countSeenOnce) {
        // the first "Count: 0-0" after a matchup is the starting count, not a pitch
        await backfillPriorRunnerAssignments(buf)
        buf.countSeenOnce = true
        buf.lastCount = { balls: newBalls, strikes: newStrikes }
        return
      }
      // The stock log only says "Strike"; it does not say whether the batter
      // offered. Preserve that uncertainty instead of corrupting swing/miss
      // metrics by labeling every generic strike a swinging miss.
      const type = buf.pendingPitchType === 'strike' ? 'strike_unknown' : buf.pendingPitchType === 'foul' ? 'foul' : 'ball'
      pushPitch(buf, type, buf.lastCount, { balls: newBalls, strikes: newStrikes })
      buf.pendingPitchType = null
      buf.lastCount = { balls: newBalls, strikes: newStrikes }
      bumpLivePitchCount(buf, type !== 'ball')
      if (newBalls >= 4 && !buf.result) buf.result = 'BB'
      return
    }

    const hitBatter = parseTrackerHitByPitchMessage(message)
    if (hitBatter && hitBatter === buf.batterName) {
      ensureHitByPitch(buf)
      return
    }

    if (/^Double play!$/i.test(message)) {
      if (['FO', 'LO', 'GO'].includes(buf.result)) buf.result = 'DP'
      else buf.pendingDoublePlay = true
      return
    }
    if (/^Triple play!$/i.test(message)) {
      if (['FO', 'LO', 'GO'].includes(buf.result)) buf.result = 'TP'
      else buf.pendingTriplePlay = true
      return
    }
    // The catching/put-out fielder's identity is only ever named on its own
    // line ("<fielder> put <name> out!"), separate from the "<batter>'s hit
    // was caught!" line that actually decides the PA result — so this has to
    // capture the fielder name unconditionally (not gated on `!buf.result`,
    // unlike the result-deciding checks below it) or the fielder gets lost by
    // the time this line arrives.
    if ((m = message.match(/^(.+?)'s hit was caught!$/i)) && m[1].trim() === buf.batterName) {
      if (!buf.result) {
        ensureContactPitch(buf)
        buf.result = trackerCaughtBallResult(buf.advancedBattedBall)
        applyPendingMultiOut(buf)
      }
      buf.battedBallTrajectory = buf.battedBallTrajectory
        || (buf.result === 'LO' ? 'L' : 'F')
      return
    }
    const putout = parseTrackerPutoutMessage(message)
    if (putout) {
      const { runnerName: whoOut } = putout
      captureTrackerPutout(buf, putout)
      // On some star-swing catches the tracker increments the out before its
      // OUT RUNNER memory value updates, then emits "No Player" for the runner.
      // The preceding caught-hit line already proves the batter was retired,
      // so retain the named fielder instead of discarding valid putout credit.
      if (shouldCreditTrackerPutout({ runnerName: whoOut, batterName: buf.batterName, result: buf.result })) {
        if (!buf.result) {
          ensureContactPitch(buf)
          buf.result = 'GO'
          applyPendingMultiOut(buf)
          buf.battedBallTrajectory = buf.battedBallTrajectory || 'G'
        }
      } else if (!buf.result) {
        buf.unresolvedReason = `a putout was recorded on ${whoOut}, not the batter — retaining it as a baserunner out while awaiting the batter result`
      }
      return
    }
    // Precedes the putout line for a relay throw (e.g. "SS to 1B" grounder) —
    // the putout fielder is already captured above, so this only adds the
    // earlier link(s) in the chain.
    if ((m = message.match(/^(.+?)\s+recorded an assist!$/i))) {
      buf.assistFielderNames.push(m[1].trim())
      return
    }
    // Keep the bobbler as a candidate; final scoring depends on whether the
    // batter reaches safely or the defense still completes the out.
    if ((m = message.match(/^(.+?)\s+bobbled the ball!$/i))) {
      buf.bobbleFielderName = m[1].trim()
      return
    }
    if ((m = message.match(/^(.+?)\s+is going up for a buddy jump!$/i))) {
      buf.buddyJumpFielderName = m[1].trim()
      return
    }
    // Confirms the buddy jump actually made the catch — a jump attempt with
    // no confirming line (ball got past it, e.g. cleared the fence) should
    // not be flagged, so is_buddy_jump only flips true here, not on the
    // "going up for" announcement above.
    if ((m = message.match(/^(.+?)\s+went high up with the buddy jump to get the out!$/i))) {
      buf.isBuddyJump = true
      buf.buddyJumpFielderName = m[1].trim()
      return
    }

    if (!buf.result) {
      // A star-powered hit gets an extra "star" qualifier inserted
      // ("recorded a star single!" instead of "recorded a single!") — the
      // (?:star )? here is the only difference from the plain wording.
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?single!$/i)) && m[1].trim() === buf.batterName) { ensureContactPitch(buf); buf.result = '1B'; return }
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?double!$/i)) && m[1].trim() === buf.batterName) { ensureContactPitch(buf); buf.result = '2B'; return }
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?triple!$/i)) && m[1].trim() === buf.batterName) { ensureContactPitch(buf); buf.result = '3B'; return }
      // "recorded an inside the park home run!" is worded entirely differently
      // from the over-the-fence "hits a ... home run ... off of ...!" phrasing
      // matched below, so it needs its own pattern or it's silently dropped as
      // an unrecognized result (no HR credit, no run, no stats).
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?inside the park home run!$/i)) && m[1].trim() === buf.batterName) { ensureContactPitch(buf); buf.result = 'IPHR'; return }
      if ((m = message.match(/^(.+?)\s+hits an?\s+.*(?:homer|home run).*off of\s+.+!$/i)) && m[1].trim() === buf.batterName) { ensureContactPitch(buf); buf.result = 'HR'; return }
      if ((m = message.match(/^.+?\s+struck out\s+(.+?)!$/i)) && m[1].trim() === buf.batterName) { buf.result = 'K'; return }
    }

    if ((m = message.match(/^(.+?)\s+used a star swing!$/i)) && m[1].trim() === buf.batterName) {
      buf.starHitUsed = true
      return
    }

    if ((m = message.match(/^(.+?)\s+recorded (\d+) RBI!$/i)) && m[1].trim() === buf.batterName) {
      buf.rbi = Number(m[2])
      return
    }
    if ((m = message.match(/^(.+?)\s+recorded a run!$/i))) {
      // The tracker explicitly follows earned runs with a separate charge
      // line. Start false so the absence of that line correctly means the run
      // was unearned instead of treating every run as earned by default.
      buf.runEvents.push({ scorerName: m[1].trim(), chargedToPitcherName: null, earnedRun: false })
      const scorerPlayerId = resolvePlayerIdForCharacter(m[1].trim()) ?? buf.batterPlayerId
      if (String(scorerPlayerId) === String(TARGET_TEAM_A_PLAYER_ID)) {
        setLiveScoreForSide('A', Number(scoreState.a || 0) + 1)
      } else if (String(scorerPlayerId) === String(TARGET_TEAM_B_PLAYER_ID)) {
        setLiveScoreForSide('B', Number(scoreState.b || 0) + 1)
      }
      return
    }
    if ((m = message.match(/^(.+?)\s+was charged with an? earned run$/i))) {
      const openRun = buf.runEvents.at(-1)
      if (openRun) { openRun.chargedToPitcherName = m[1].trim(); openRun.earnedRun = true }
      return
    }
    if ((m = message.match(/^(.+?)\s+inherited this runner from (.+?)\.\s+(.+?)\s+will be charged any earned runs\.$/i))) {
      const openRun = buf.runEvents.at(-1)
      if (openRun && m[2].trim() === m[3].trim()) openRun.chargedToPitcherName = m[2].trim()
      return
    }
  }

  if ((m = message.match(/^Rematch detected\./i))) {
    log('rematch/reset detected mid-session — clearing in-memory play tracking. ' +
      'If plays were already recorded for the previous attempt, review/remove them manually.')
    currentPaBuffer = null
    parserInning = 1
    parserIsTop = true
    parserOutsInHalf = 0
    awayTeamName = null
    homeTeamName = null
    setLiveScoreForSide('A', 0)
    setLiveScoreForSide('B', 0)
    return
  }
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+?)\s+@\s+.+$/))) {
    awayTeamName = m[1].trim()
    homeTeamName = m[2].trim()
    trackerTeamSideByName.set(awayTeamName, 'A')
    trackerTeamSideByName.set(homeTeamName, 'B')
    trackerTeamMapping[awayTeamName] = 'A'
    trackerTeamMapping[homeTeamName] = 'B'
    return
  }
  if ((m = message.match(/^Next:\s*(Top|Bottom) of inning (\d+)$/i))) {
    parserInning = Number(m[2])
    parserIsTop = /top/i.test(m[1])
    parserOutsInHalf = 0
    return
  }
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+)$/))) {
    const pitcherName = m[1].trim()
    const batterName = m[2].trim()
    try {
      await finalizeCurrentPaIfAny()
      await startNewPa(pitcherName, batterName)
    } catch (err) {
      log('play tracking error:', err.message)
    }
    return
  }
  if (/^Changing sides!$/i.test(message) || /^Final Score:$/i.test(message)) {
    try {
      await finalizeCurrentPaIfAny()
    } catch (err) {
      log('play tracking error:', err.message)
    }
    return
  }
  if ((m = message.match(/^(.+?)\s*-\s*(\d+)$/))) {
    const name = m[1].trim()
    const scoreValue = Number(m[2])
    const side = inferTrackerScoreSide(name)
    if (side) setLiveScoreForSide(side, scoreValue, { scoreName: name })
  }
}

// Log lines arrive one at a time via readline, but recording a play can take
// several awaited Supabase round trips — queue play-event handling so a slow
// PA write can't run concurrently with (and get interleaved by) the next one.
let playEventChain = Promise.resolve()
function enqueuePlayEvent(message) {
  playEventChain = playEventChain.then(() => processPlayEvent(message))
    .catch((err) => log('play event processing error:', err.message))
}

// ── xlsx (final box score, written once at game end) ───────────────────────

function sheetToRecords(worksheet) {
  const headerRow = worksheet.getRow(1)
  const headers = []
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim()
  })

  const records = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const record = {}
    let hasValue = false
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = headers[colNumber]
      if (!header) return
      const value = cell.value && typeof cell.value === 'object' && 'result' in cell.value
        ? cell.value.result
        : cell.value
      if (value !== null && value !== undefined && value !== '') hasValue = true
      record[header] = value ?? null
    })
    if (hasValue) records.push(record)
  })
  return records
}

function parseGameInfo(worksheet) {
  const cells = []
  worksheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const value = cell.value && typeof cell.value === 'object' && 'result' in cell.value
        ? cell.value.result
        : cell.value
      if (value === null || value === undefined || value === '') return
      cells.push({ row: rowNumber, col: colNumber, address: cell.address, value })
    })
  })

  const byPosition = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]))
  const fields = {}
  for (const label of GAME_INFO_LABELS) {
    const labelCell = cells.find((c) => String(c.value).trim() === label)
    if (!labelCell) continue
    const right = byPosition.get(`${labelCell.row}:${labelCell.col + 1}`)
    const below = byPosition.get(`${labelCell.row + 1}:${labelCell.col}`)
    const valueCell = right || below
    if (valueCell) fields[label] = valueCell.value
  }

  return { fields, raw: cells }
}

// ── shared state pushed to Supabase ─────────────────────────────────────────
// Log-driven pushes and xlsx-driven pushes happen on independent schedules;
// each only updates its own slice so neither clobbers the other's data.

const xlsxState = { game_info: {}, batting: [], pitching: [] }
const liveState = {
  matchup: null, outs: null, balls: null, strikes: null, currentBatter: null,
  inning: 1, isTop: true,
  score: {}, scoreBySide: { a: null, b: null }, winner: null, gameEnded: false,
  oddsCalculating: false, oddsRevision: 0, oddsStatusUpdatedAt: null,
  lastEvent: null, lastEventAt: null, events: [],
}
let trackerRunnerSnapshot = null
let pendingTrackerRunnerSnapshot = null
let trackerRunnerFeedDetected = false
let trackerRunnerSnapshotRejected = false
let trackerInningFeedDetected = false

function emptyRunnerState() {
  return { first: null, second: null, third: null }
}

function beginTrackerRunnerSnapshot() {
  trackerRunnerSnapshotRejected = false
  pendingTrackerRunnerSnapshot = emptyRunnerState()
  // Until this process has seen at least one runner-location message, keep
  // replay as the fallback so older tracker builds do not make every matchup
  // look like the bases are empty.
  trackerRunnerSnapshot = trackerRunnerFeedDetected
    ? { ...pendingTrackerRunnerSnapshot }
    : null
  if (trackerRunnerSnapshot) liveState.runners = { ...trackerRunnerSnapshot }
}

function clearTrackerRunnerSnapshot() {
  trackerRunnerSnapshot = null
  pendingTrackerRunnerSnapshot = null
  trackerRunnerSnapshotRejected = false
  liveState.runners = emptyRunnerState()
}

function clearLiveCount() {
  liveState.balls = 0
  liveState.strikes = 0
}

function refreshCurrentMatchup(plateAppearances = []) {
  if (liveState.gameEnded) return
  const resolved = resolveTrackerMatchupForHalf({
    existingMatchup: liveState.matchup,
    inning: liveState.inning,
    isTop: liveState.isTop,
    homeAwaySwapped: Boolean(TARGET_GAME_ROW?.home_away_swapped),
    teamAPlayerId: TARGET_TEAM_A_PLAYER_ID,
    teamBPlayerId: TARGET_TEAM_B_PLAYER_ID,
    alignments: liveState.alignments || {},
    plateAppearances,
    lastConfirmedBatterByPlayer: liveState.lastConfirmedBatterByPlayer || {},
  })
  // If the bridge does not have enough lineup information to make a safe
  // prediction, clear the prior half's matchup instead of publishing known-
  // stale participants. Patched tracker sessions normally have both names.
  liveState.matchup = resolved.matchup
  liveState.predictedOnDeck = resolved.onDeckName || null
}

function applyTrackerRunnerSnapshotEntry({ characterName, base }) {
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) {
    log(`could not resolve tracker baserunner ${characterName}; keeping replay-derived runner state for this matchup`)
    trackerRunnerSnapshot = null
    pendingTrackerRunnerSnapshot = null
    trackerRunnerSnapshotRejected = true
    return
  }
  if (trackerRunnerSnapshotRejected) return
  if (!pendingTrackerRunnerSnapshot) pendingTrackerRunnerSnapshot = emptyRunnerState()
  pendingTrackerRunnerSnapshot[base] = { characterId, playerId }
  trackerRunnerFeedDetected = true
  trackerRunnerSnapshot = { ...pendingTrackerRunnerSnapshot }
  liveState.runners = { ...trackerRunnerSnapshot }
}

function buildLiveStatePayload() {
  const batterName = liveState.matchup?.right || liveState.currentBatter || null
  const pitcherName = liveState.matchup?.left || null
  const onDeckName = liveState.predictedOnDeck || null
  return {
    inning: liveState.inning || 1,
    isTop: liveState.isTop !== false,
    outsInHalf: Number(liveState.outs || 0),
    balls: Number(liveState.balls || 0),
    strikes: Number(liveState.strikes || 0),
    // Mirrors the live count already being ticked onto pitching_stints
    // (bumpLivePitchCount) so the game view's pitch counter moves pitch by
    // pitch instead of only jumping once a plate appearance is fully saved.
    pitchNumber: Number(currentPaBuffer?.pitcherStint?.pitches_thrown || 0),
    pitcherStintId: currentPaBuffer?.pitcherStint?.id || null,
    paNumber: Number(liveState.paNumber || 0),
    batterCharacterId: resolveCharacterId(batterName),
    batterPlayerId: resolvePlayerIdForCharacter(batterName),
    pitcherCharacterId: resolveCharacterId(pitcherName),
    pitcherPlayerId: resolvePlayerIdForCharacter(pitcherName),
    onDeckCharacterId: resolveCharacterId(onDeckName),
    onDeckPlayerId: resolvePlayerIdForCharacter(onDeckName),
    runners: liveState.runners || { first: null, second: null, third: null },
    oddsCalculating: Boolean(liveState.oddsCalculating),
    oddsRevision: Number(liveState.oddsRevision || 0),
    updatedAt: new Date().toISOString(),
  }
}

// PA replay repairs state on startup before the tracker has emitted an inning
// line. Once the tracker explicitly reports "N outs" / "Next: ...", those
// values are authoritative: a PA can be incomplete or miss a baserunner out,
// and must never regress a correctly advanced half inning. Runner identity is
// likewise replayed only as a fallback, then replaced by explicit snapshots.
async function resyncGameStateFromPAs() {
  const [{ data: pas, error }, { data: runs, error: runsError }] = await Promise.all([
    supabase.from(GAME_TABLES.plateAppearances)
      .select('id,result,outs_on_play,character_id,player_id,pa_number').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.runsScored)
      .select('pa_id,scoring_character_id,scoring_player_id').eq('game_id', TARGET_GAME_ID),
  ])
  if (error) {
    log('game-state resync failed, keeping log-parsed values:', error.message)
    return
  }
  if (!pas || !pas.length) return
  if (runsError) log('runs_scored fetch failed during resync (runner scoring won\'t be cross-checked):', runsError.message)
  const scorerKeysByPaId = new Map()
  for (const run of runs || []) {
    const key = String(run.pa_id)
    if (!scorerKeysByPaId.has(key)) scorerKeysByPaId.set(key, new Set())
    scorerKeysByPaId.get(key).add(`${run.scoring_character_id}:${run.scoring_player_id}`)
  }
  const sortedPAs = [...pas].sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
  const totalOuts = sortedPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
  const inningSync = applyPaDerivedTrackerInningState(liveState, totalOuts, {
    hasExplicitTrackerState: trackerInningFeedDetected,
  })
  if (inningSync.halfChanged) {
    // A PA resync can discover the third out before the later "Changing
    // sides!" log line arrives. Never publish the newly-derived half-inning
    // with the completed PA's count still attached to it.
    clearLiveCount()
    clearTrackerRunnerSnapshot()
    liveState.currentBatter = null
  }
  const replayedRunners = deriveCurrentRunners(sortedPAs, totalOuts, scorerKeysByPaId)
  liveState.runners = trackerRunnerSnapshot
    ? { ...trackerRunnerSnapshot }
    : replayedRunners
  refreshCurrentMatchup(sortedPAs)
}

async function pushStateOnce() {
  await resyncGameStateFromPAs()

  const payload = {
    game_id: TARGET_GAME_ID,
    game_info: xlsxState.game_info,
    batting: xlsxState.batting,
    pitching: xlsxState.pitching,
    live_feed: liveState,
    team_mapping: trackerTeamMapping,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from(TARGET_STATS_TABLE).upsert(payload, { onConflict: 'game_id' })
  if (error) throw error

  // Write into the site's own live_state column (the same field the manual
  // scorebook uses for in-progress batter/pitcher/count) so Game View and
  // anywhere else that reads it stays consistent with one source of truth,
  // instead of only this bridge's own side table knowing the real state.
  const { error: liveStateError } = await supabase
    .from(TARGET_GAMES_TABLE).update({ live_state: buildLiveStatePayload() }).eq('id', TARGET_GAME_ID)
  if (liveStateError) throw liveStateError
  triggerBettingSync()
}

// Supabase writes from consecutive log events can otherwise finish out of
// order (for example, a slow 0-2 update landing after the side-change reset).
// Keep all bridge state pushes ordered while allowing each caller to observe
// its own failure.
let pushStateQueue = Promise.resolve()
function pushState() {
  const queuedPush = pushStateQueue.then(() => pushStateOnce())
  pushStateQueue = queuedPush.catch(() => {})
  return queuedPush
}

async function readWithRetry(fn, attempts = 5, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

async function syncXlsx(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const gameInfoSheet = workbook.getWorksheet('Game Info')
  const statsSheet = workbook.getWorksheet('Stats')
  const pitchingSheet = workbook.getWorksheet('Pitching')
  if (!statsSheet || !pitchingSheet) {
    throw new Error('Workbook is missing the expected Stats/Pitching sheets.')
  }

  xlsxState.game_info = gameInfoSheet ? parseGameInfo(gameInfoSheet) : {}
  xlsxState.batting = sheetToRecords(statsSheet)
  xlsxState.pitching = sheetToRecords(pitchingSheet)

  for (const alignment of parseWorkbookStartingLineups(gameInfoSheet)) {
    try {
      await syncTrackerAlignment(alignment)
    } catch (err) {
      log(`workbook lineup ignored for ${alignment.teamName || 'unknown tracker team'}:`, err.message)
    }
  }

  await pushState()
  log(`box score synced from ${path.basename(filePath)}: ${xlsxState.batting.length} batting rows, ${xlsxState.pitching.length} pitching rows`)
}

function watchXlsx() {
  // Excel-writing tools (this tracker included) typically save by writing a
  // temp file and swapping it in rather than editing in place. Native OS
  // file-change events (what chokidar uses by default) often lose track of
  // the file across that swap, especially on Windows — polling is slower
  // but doesn't have that failure mode.
  let debounce = null
  let pendingPath = null
  const trigger = (filePath) => {
    pendingPath = filePath
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      const completedPath = pendingPath
      readWithRetry(() => syncXlsx(completedPath)).catch((err) => log('box score sync failed:', err.message))
    }, 300)
  }
  const watchTarget = XLSX_PATH || path.join(TRACKER_OUTPUT_DIR, '*.xlsx')
  const watcher = chokidar.watch(watchTarget, {
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })
  watcher.on('change', trigger)
  watcher.on('add', trigger)
  watcher.on('error', (err) => log('xlsx watcher error:', err.message))
  log(`watching completed tracker workbooks at ${watchTarget}`)
}

// ── live log feed (parsed from the tracker's own console output) ──────────

const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/

function applyLogMessage(message) {
  let m
  const inningStateMessage = applyTrackerInningStateMessage(liveState, message)
  if (inningStateMessage) trackerInningFeedDetected = true
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+)$/))) {
    const pitcherName = m[1].trim()
    const batterName = m[2].trim()
    liveState.matchup = {
      left: pitcherName,
      right: batterName,
      inning: Math.max(1, Number(liveState.inning || 1)),
      isTop: liveState.isTop !== false,
      predicted: false,
    }
    const batterPlayerId = resolvePlayerIdForCharacter(batterName)
    if (batterPlayerId != null) {
      liveState.lastConfirmedBatterByPlayer = {
        ...(liveState.lastConfirmedBatterByPlayer || {}),
        [String(batterPlayerId)]: batterName,
      }
    }
    refreshCurrentMatchup()
    clearLiveCount()
    // The tracker follows every matchup header with one line per occupied
    // base. Starting from empty makes omitted bases authoritative too.
    beginTrackerRunnerSnapshot()
  } else if (inningStateMessage?.type === 'next_half') {
    liveState.currentBatter = null
    clearLiveCount()
    clearTrackerRunnerSnapshot()
    refreshCurrentMatchup()
  } else if (inningStateMessage?.type === 'outs') {
    // The helper applied this authoritative value before the event-specific
    // side effects in this chain.
  } else if ((m = message.match(/^Count:\s*(\d)-(\d)$/i))) {
    liveState.balls = Number(m[1])
    liveState.strikes = Number(m[2])
  } else if ((m = message.match(/^Plate appearance #(\d+) for (.+)\.$/i))) {
    liveState.paNumber = Number(m[1])
    liveState.currentBatter = m[2]
  } else if ((m = message.match(/^At-bat #(\d+) for (.+)\.$/i))) {
    liveState.abNumber = Number(m[1])
  } else if ((m = parseTrackerRunnerMessage(message))) {
    applyTrackerRunnerSnapshotEntry(m)
  } else if (inningStateMessage?.type === 'side_change') {
    liveState.currentBatter = null
    clearLiveCount()
    clearTrackerRunnerSnapshot()
  } else if ((m = message.match(/^(.+?) win!$/i))) {
    liveState.winner = m[1].trim()
  } else if (/^Final Score:$/i.test(message)) {
    liveState.gameEnded = true
    liveState.oddsCalculating = false
    clearLiveCount()
    clearTrackerRunnerSnapshot()
  } else if ((m = message.match(/^(.+?)\s*-\s*(\d+)$/))) {
    // Running score line, e.g. "Wario Muscles - 9" — printed on every side
    // change and again in the final-score summary.
    const scoreName = m[1].trim()
    const scoreValue = Number(m[2])
    liveState.score[scoreName] = scoreValue
    const side = inferTrackerScoreSide(scoreName)
    if (side) setLiveScoreForSide(side, scoreValue, { scoreName })
  }
  liveState.lastEvent = message
  liveState.lastEventAt = new Date().toISOString()
}

function handleTrackerLogLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  const match = trimmed.match(LOG_LINE_RE)
  const message = match ? match[3] : trimmed
  const level = match ? match[2] : 'RAW'

  applyLogMessage(message)
  // Kept for the whole game (no cap) so the Admin console dump has the full
  // history to copy/paste from when reporting a parsing issue, not just
  // whatever happened to still be in a trailing window.
  liveState.events.push({ time: match ? match[1] : new Date().toLocaleTimeString(), level, message })

  triggerLivePush()
  enqueuePlayEvent(message)
}

let livePushDebounce = null
function triggerLivePush() {
  clearTimeout(livePushDebounce)
  livePushDebounce = setTimeout(() => {
    pushState().catch((err) => log('live feed sync failed:', err.message))
  }, 500)
}

function launchTracker() {
  log(`launching tracker: ${EXE_PATH}`)
  const child = spawn(EXE_PATH, [], { cwd: path.dirname(EXE_PATH) })

  readline.createInterface({ input: child.stdout }).on('line', handleTrackerLogLine)
  readline.createInterface({ input: child.stderr }).on('line', handleTrackerLogLine)

  child.on('exit', (code) => {
    log(`tracker process exited (code ${code}). The final box score should land shortly via the xlsx watcher.`)
    liveState.gameEnded = true
    liveState.oddsCalculating = false
    enqueuePlayEvent('Changing sides!') // flush any still-buffered plate appearance
    pushState().catch((err) => log('final live feed sync failed:', err.message))
  })
  child.on('error', (err) => log('failed to launch tracker:', err.message))

  const cleanup = () => { try { child.kill() } catch { /* already gone */ } }
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })

  return child
}

async function main() {
  log(`signing in as ${BRIDGE_EMAIL}`)
  const { error: authError } = await supabase.auth.signInWithPassword({
    email: BRIDGE_EMAIL, password: BRIDGE_PASSWORD,
  })
  if (authError) throw new Error(`Sign-in failed: ${authError.message}`)

  TARGET_GAME_ID = await resolveTargetGame()
  log(`syncing into game_id=${TARGET_GAME_ID}`)
  scoreState.a = Number(isSeasonGame() ? TARGET_GAME_ROW?.away_score : TARGET_GAME_ROW?.team_a_runs) || 0
  scoreState.b = Number(isSeasonGame() ? TARGET_GAME_ROW?.home_score : TARGET_GAME_ROW?.team_b_runs) || 0

  const { data: existingTrackerStats, error: existingTrackerError } = await supabase
    .from(TARGET_STATS_TABLE).select('team_mapping,live_feed').eq('game_id', TARGET_GAME_ID).maybeSingle()
  if (existingTrackerError) throw existingTrackerError
  trackerTeamMapping = { ...(existingTrackerStats?.team_mapping || {}) }
  Object.entries(trackerTeamMapping).forEach(([name, side]) => {
    if (side === 'A' || side === 'B') trackerTeamSideByName.set(name, side)
  })
  const previousLiveFeed = existingTrackerStats?.live_feed && typeof existingTrackerStats.live_feed === 'object'
    ? existingTrackerStats.live_feed
    : {}
  Object.assign(liveState, previousLiveFeed, {
    score: { ...(previousLiveFeed.score || {}) },
    scoreBySide: { ...(previousLiveFeed.scoreBySide || {}) },
    events: [...(previousLiveFeed.events || [])],
    gameEnded: false,
    // A previous bridge process may have exited during a calculation. Never
    // carry that stale UI lock into a newly started tracker session.
    oddsCalculating: false,
  })
  trackerInningFeedDetected = previousLiveFeed.inningStateSource === 'tracker'
    || (previousLiveFeed.events || []).some((event) => parseTrackerInningStateMessage(event?.message))
  setLiveScoreForSide('A', scoreState.a, { syncGame: false })
  setLiveScoreForSide('B', scoreState.b, { syncGame: false })

  await loadRosterAndCharacters()
  log(`loaded roster: ${Object.keys(rosterPlayerIdByCharacterName).length} characters resolved to a team`)

  if (XLSX_PATH && fs.existsSync(XLSX_PATH)) {
    await readWithRetry(() => syncXlsx(XLSX_PATH))
      .catch((err) => log('initial completed-workbook sync failed:', err.message))
  }
  await pushState().catch((err) => log('initial live-state repair failed:', err.message))
  if (path.resolve(EXE_PATH) === path.resolve(STOCK_TRACKER_PATH)) {
    log('WARNING: using the stock tracker executable; full lineups/fielding will only sync from the completed workbook. ' +
      'Run scripts/patch_tracker_lineup_feed.py or set TRACKER_EXE_PATH to the lineup-feed-enabled build for live alignment sync.')
  }
  watchXlsx()
  launchTracker()

  log('live feed + box score watcher running. Ctrl+C to stop.')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
