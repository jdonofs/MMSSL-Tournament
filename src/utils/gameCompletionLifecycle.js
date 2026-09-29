// What has to follow a game's status changing to or from complete, done from
// the database's own rows so it can be run again at any time.
//
// Completing a game is one row write followed by four independent pieces of
// work: the stadium log, bet settlement, the W/L/S decisions, and standings or
// bracket advancement. Reopening undoes the same four. Those follow-ups used
// to run once, from the scorebook's memory, right after the status write -- so
// a failure (or a response lost after the write committed) left a game that
// read `complete` with no path back: the button that started the work was gone
// the moment the status changed, and a reload forgot anything had failed.
//
// Two rules make recovery a plain retry:
//
//   * Every step reads the game, its plate appearances, stints and runs from
//     the database, and writes only what differs from what is already there.
//     Running a step twice changes nothing the second time.
//
//   * Nothing is remembered about a failure. `auditGameLifecycle` runs the same
//     steps against a client that refuses writes: a step that would write
//     something is owed. The answer comes from the rows themselves, so it is
//     the same after a reload, a bridge restart, or on another device.
//
// None of this coordinates two clients. The status writes are compare-and-set
// on the row (`writeGameCompletion`, `writeGameReopen`); the follow-ups check
// the persisted status before running and again after, and a pass that finds
// the status changed underneath it reports `superseded` so the audit of the
// new status picks up whatever is left. Convergence comes from re-running
// against the final status, not from any lock held here.

import { getBettingWinningSide, findUnreversedCompletionBets, reopenGameBets, resolveGameBets } from './betResolution.js'
import { advanceBracketOnGameComplete, reopenBracketAfterGameEdit } from './bracketProgression.js'
import { isCreditedHit } from './creditedHit.js'
import { buildBettingEntityLabel } from './oddsEngine.js'
import { decideGamePitchingFlags } from './pitchingDecisions.js'
import { completeSeasonGameLifecycle, reopenSeasonGameLifecycle } from './seasonPlayoffs.js'

export const SEASON_LIFECYCLE_TABLES = {
  games: 'season_schedule',
  plateAppearances: 'season_plate_appearances',
  pitchingStints: 'season_pitching_stints',
  runsScored: 'season_runs_scored',
  stadiumGameLog: 'season_stadium_game_log',
}

export const TOURNAMENT_LIFECYCLE_TABLES = {
  games: 'games',
  plateAppearances: 'plate_appearances',
  pitchingStints: 'pitching_stints',
  runsScored: 'runs_scored',
  stadiumGameLog: 'stadium_game_log',
}

const SEASON_BET_CONFIG = {
  betsTable: 'season_bets',
  gameOddsTable: 'season_game_odds',
  ledgerTable: 'season_betting_ledger',
  plateAppearancesTable: 'season_plate_appearances',
  runsScoredTable: 'season_runs_scored',
  enableCalibrationLogging: false,
  enableWeightAdjustment: false,
  wagerField: 'wager_dollars',
  payoutField: 'potential_payout_dollars',
  ledgerChangeField: 'dollars_change',
  sourceIdField: 'season_id',
}

export const LIFECYCLE_STEP_LABELS = {
  stadiumLog: 'Stadium log',
  bets: 'Bet settlement',
  pitching: 'Pitching decisions (W/L/S)',
  competition: 'Standings and bracket',
}

const COMPLETE_STATUSES = new Set(['complete', 'completed'])
// A reopened game is back in play. Pending/scheduled games were never
// completed (or were reset), so there is nothing a reopen could have left.
const IN_PLAY_STATUSES = new Set(['active', 'in_progress'])

export function isCompleteGameStatus(status) {
  return COMPLETE_STATUSES.has(String(status || ''))
}

function completeStatusFor(sourceType) {
  return sourceType === 'season' ? 'completed' : 'complete'
}

function tablesFor(sourceType, tables) {
  return { ...(sourceType === 'season' ? SEASON_LIFECYCLE_TABLES : TOURNAMENT_LIFECYCLE_TABLES), ...(tables || {}) }
}

// ── Dry run ──────────────────────────────────────────────────────────────────
// A client that answers reads from the real database and refuses any write
// that would change a row. The refusal is also recorded, so a caller that
// swallows the thrown error still cannot make owed work look finished.

export class LifecycleWorkOwed extends Error {
  constructor(table, action) {
    super(`${action} on ${table}`)
    this.name = 'LifecycleWorkOwed'
    this.table = table
    this.action = action
  }
}

const FILTER_METHODS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'match', 'not', 'or', 'filter'])

function sameValue(stored, wanted) {
  if (stored == null || wanted == null) return (stored ?? null) === (wanted ?? null)
  if (typeof wanted === 'object' || typeof stored === 'object') return JSON.stringify(stored) === JSON.stringify(wanted)
  const storedNumber = Number(stored)
  const wantedNumber = Number(wanted)
  if (typeof wanted !== 'boolean' && typeof stored !== 'boolean'
    && stored !== '' && wanted !== '' && Number.isFinite(storedNumber) && Number.isFinite(wantedNumber)) {
    return storedNumber === wantedNumber
  }
  return String(stored) === String(wanted)
}

export function createDryRunClient(real) {
  const owed = []
  const refuse = (table, action) => {
    const error = new LifecycleWorkOwed(table, action)
    owed.push(error)
    throw error
  }

  const query = (table) => {
    const calls = []
    let action = 'select'
    let payload = null

    const execute = async () => {
      if (action === 'select') {
        let request = real.from(table)
        for (const [method, args] of calls) request = request[method](...args)
        return request
      }
      if (action === 'insert' || action === 'upsert') refuse(table, action)

      let request = real.from(table).select('*')
      for (const [method, args] of calls) {
        if (FILTER_METHODS.has(method)) request = request[method](...args)
      }
      const { data, error } = await request
      if (error) return { data: null, error }
      const rows = data || []
      if (action === 'delete' && rows.length) refuse(table, action)
      if (action === 'update') {
        const differs = rows.some((row) => Object.entries(payload || {}).some(([field, value]) => !sameValue(row[field], value)))
        if (differs) refuse(table, action)
      }
      const single = calls.some(([method]) => method === 'single' || method === 'maybeSingle')
      const wantsRows = calls.some(([method]) => method === 'select')
      return { data: wantsRows ? (single ? rows[0] || null : rows) : null, error: null }
    }

    const builder = new Proxy({}, {
      get(_target, property) {
        if (property === 'then') return (resolve, reject) => execute().then(resolve, reject)
        if (typeof property !== 'string') return undefined
        return (...args) => {
          if (['update', 'insert', 'upsert', 'delete'].includes(property)) {
            action = property
            payload = args[0]
          } else {
            calls.push([property, args])
          }
          return builder
        }
      },
    })
    return builder
  }

  return {
    owed,
    from: query,
    rpc: async (name) => refuse(name, 'rpc'),
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function loadGameRow(supabase, tables, gameId) {
  const { data, error } = await supabase.from(tables.games).select('*').eq('id', gameId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`game ${gameId} was not found in ${tables.games}`)
  return data
}

async function selectRows(supabase, table, column, value) {
  const { data, error } = await supabase.from(table).select('*').eq(column, value)
  if (error) throw error
  return data || []
}

async function loadGameFacts(supabase, tables, gameId) {
  const [stints, pas, runs] = await Promise.all([
    selectRows(supabase, tables.pitchingStints, 'game_id', gameId),
    selectRows(supabase, tables.plateAppearances, 'game_id', gameId),
    selectRows(supabase, tables.runsScored, 'game_id', gameId),
  ])
  return { stints, pas, runs }
}

// The two sides and the result, in player ids, whichever table the row is from.
async function describeGame(supabase, sourceType, game) {
  if (sourceType !== 'season') {
    return {
      teamAPlayerId: game.team_a_player_id ?? null,
      teamBPlayerId: game.team_b_player_id ?? null,
      winnerPlayerId: game.winner_player_id ?? null,
      teamARuns: Number(game.team_a_runs || 0),
      teamBRuns: Number(game.team_b_runs || 0),
    }
  }
  const teams = await selectRows(supabase, 'season_teams', 'season_id', game.season_id)
  const playerByTeam = new Map(teams.map((team) => [String(team.id), team.player_id ?? null]))
  return {
    teamAPlayerId: playerByTeam.get(String(game.away_team_id)) ?? null,
    teamBPlayerId: playerByTeam.get(String(game.home_team_id)) ?? null,
    winnerPlayerId: game.winner_team_id == null ? null : playerByTeam.get(String(game.winner_team_id)) ?? null,
    teamARuns: Number(game.away_score || 0),
    teamBRuns: Number(game.home_score || 0),
  }
}

async function loadLabelMaps(supabase, facts, charactersById, playersById) {
  const characters = { ...(charactersById || {}) }
  const players = { ...(playersById || {}) }
  const rows = [...facts.stints, ...facts.pas]
  const missingCharacters = [...new Set(rows.map((row) => row.character_id).filter((id) => id != null && !characters[id]))]
  const missingPlayers = [...new Set(rows.map((row) => row.player_id).filter((id) => id != null && !players[id]))]
  if (missingCharacters.length) {
    const { data, error } = await supabase.from('characters').select('*').in('id', missingCharacters)
    if (error) throw error
    ;(data || []).forEach((row) => { characters[row.id] = row })
  }
  if (missingPlayers.length) {
    const { data, error } = await supabase.from('players').select('*').in('id', missingPlayers)
    if (error) throw error
    ;(data || []).forEach((row) => { players[row.id] = row })
  }
  return { characters, players }
}

function betConfigFor(sourceType, game, betConfig, client) {
  const base = sourceType === 'season'
    ? { ...SEASON_BET_CONFIG, ...(betConfig || {}), sourceIdValue: game.season_id ?? betConfig?.sourceIdValue ?? null }
    : { ...(betConfig || {}) }
  return { ...base, supabaseClient: client }
}

// ── Completion steps ─────────────────────────────────────────────────────────

async function ensureStadiumLog({ client, sourceType, tables, game, sides }) {
  const hasStadium = sourceType === 'season' ? Boolean(game.stadium) : Boolean(game.stadium_id)
  if (!hasStadium) return 'no stadium'
  const rows = await selectRows(client, tables.stadiumGameLog, 'game_id', game.id)
  if (rows.length === 1) return 'present'
  if (rows.length > 1) {
    // One game, one park-factor sample. Keep the oldest row.
    const extras = rows.filter((row) => row.id != null).slice(1).map((row) => row.id)
    if (extras.length) {
      const { error } = await client.from(tables.stadiumGameLog).delete().in('id', extras).eq('game_id', game.id)
      if (error) throw error
    }
    return 'deduplicated'
  }
  const totalRuns = sides.teamARuns + sides.teamBRuns
  const row = sourceType === 'season'
    ? { game_id: game.id, season_id: game.season_id, stadium: game.stadium, is_night: Boolean(game.is_night), total_runs: totalRuns, confidence: 1.0 }
    : { game_id: game.id, stadium_id: game.stadium_id, is_night: Boolean(game.is_night), total_runs: totalRuns, confidence: 1.0 }
  const { error } = await client.from(tables.stadiumGameLog).insert(row)
  // Another writer got there first (the tracker bridge, or a retry whose
  // earlier response was lost); the row this step exists to ensure is there.
  if (error && error.code !== '23505') throw error
  return 'inserted'
}

async function settleBets({ supabase, client, sourceType, game, sides, facts, betConfig, charactersById, playersById }) {
  const { characters, players } = await loadLabelMaps(supabase, facts, charactersById, playersById)
  const pitcherKTotals = {}
  facts.stints.forEach((stint) => {
    const key = buildBettingEntityLabel(characters[stint.character_id], players[stint.player_id])
    pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
  })
  const hrTotals = {}
  const hitTotals = {}
  facts.pas.forEach((pa) => {
    const key = buildBettingEntityLabel(characters[pa.character_id], players[pa.player_id])
    if (isCreditedHit(pa) && (pa.result === 'HR' || pa.result === 'IPHR')) hrTotals[key] = Number(hrTotals[key] || 0) + 1
    if (isCreditedHit(pa)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
  })
  const updates = await resolveGameBets(
    game.id,
    getBettingWinningSide(sides.winnerPlayerId, sides.teamBPlayerId),
    sides.teamARuns + sides.teamBRuns,
    pitcherKTotals,
    Math.abs(sides.teamARuns - sides.teamBRuns),
    betConfigFor(sourceType, game, betConfig, client),
    hrTotals,
    hitTotals,
  )
  return `${updates.length} graded`
}

// Every stint is written on its own and every result is read. A failed write
// leaves the stint as it was in the database, which is exactly what the next
// pass decides from.
async function assignPitchingDecisions({ client, tables, game, sides, facts }) {
  const { updates } = decideGamePitchingFlags({
    stints: facts.stints,
    pas: facts.pas,
    runs: facts.runs,
    teamAPlayerId: sides.teamAPlayerId,
    teamBPlayerId: sides.teamBPlayerId,
    winnerPlayerId: sides.winnerPlayerId,
  })
  const failures = []
  for (const { id, patch } of updates) {
    try {
      const { error } = await client.from(tables.pitchingStints).update(patch).eq('id', id).eq('game_id', game.id)
      if (error) failures.push(`stint ${id}: ${error.message}`)
    } catch (error) {
      if (error instanceof LifecycleWorkOwed) throw error
      failures.push(`stint ${id}: ${error.message}`)
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
  return `${updates.length} stint(s) changed`
}

async function advanceCompetition({ supabase, client, sourceType, game, sides }) {
  if (sourceType === 'season') {
    const { data: season, error } = await supabase.from('seasons').select('*').eq('id', game.season_id).maybeSingle()
    if (error) throw error
    if (!season) throw new Error(`season ${game.season_id} was not found`)
    await completeSeasonGameLifecycle({
      supabase: client,
      season,
      selectedGame: game,
      requirePersistedCompletion: true,
    })
    return []
  }
  const [tournamentResult, gamesResult] = await Promise.all([
    supabase.from('tournaments').select('*').eq('id', game.tournament_id).maybeSingle(),
    supabase.from('games').select('*').eq('tournament_id', game.tournament_id),
  ])
  if (tournamentResult.error) throw tournamentResult.error
  if (gamesResult.error) throw gamesResult.error
  if (!tournamentResult.data) return []
  return advanceBracketOnGameComplete({
    supabase: client,
    tournament: tournamentResult.data,
    games: gamesResult.data || [],
    completedGame: { ...game, winner_player_id: sides.winnerPlayerId },
  })
}

// ── Reopen steps ─────────────────────────────────────────────────────────────

async function reverseBets({ client, sourceType, game, betConfig, audit }) {
  const config = betConfigFor(sourceType, game, betConfig, client)
  if (audit) {
    // A live first-inning settlement on a game in play is not a leftover, and
    // reversing it would be wrong; only completion-graded markets count.
    const { settled, orphanedRows } = await findUnreversedCompletionBets(game.id, config)
    if (settled.length || orphanedRows.length) throw new LifecycleWorkOwed(config.betsTable || 'bets', 'update')
    return 'nothing settled'
  }
  const updates = await reopenGameBets(game.id, config)
  return `${updates.length} reopened`
}

async function removeStadiumLog({ client, tables, game }) {
  const { error } = await client.from(tables.stadiumGameLog).delete().eq('game_id', game.id)
  if (error) throw error
  return 'removed'
}

async function clearPitchingDecisions({ client, tables, game }) {
  const stints = await selectRows(client, tables.pitchingStints, 'game_id', game.id)
  const ids = stints.filter((stint) => stint.win || stint.loss || stint.save).map((stint) => stint.id)
  if (!ids.length) return 'none set'
  const { error } = await client.from(tables.pitchingStints)
    .update({ win: false, loss: false, save: false })
    .in('id', ids)
    .eq('game_id', game.id)
  if (error) throw error
  return `${ids.length} cleared`
}

async function reopenCompetition({ supabase, client, sourceType, game }) {
  if (sourceType === 'season') {
    const { data: season, error } = await supabase.from('seasons').select('*').eq('id', game.season_id).maybeSingle()
    if (error) throw error
    if (!season) throw new Error(`season ${game.season_id} was not found`)
    await reopenSeasonGameLifecycle({ supabase: client, season, selectedGame: game, requirePersistedReopen: true })
    return []
  }
  const { data: tournament, error } = await supabase.from('tournaments').select('*').eq('id', game.tournament_id).maybeSingle()
  if (error) throw error
  if (!tournament) return []
  if (tournament.status === 'complete' || tournament.champion_player_id != null) {
    const { error: clearError } = await client.from('tournaments')
      .update({ champion_player_id: null, status: 'active' })
      .eq('id', tournament.id)
    if (clearError) throw clearError
  }
  const { data: games, error: gamesError } = await supabase.from('games').select('*').eq('tournament_id', game.tournament_id)
  if (gamesError) throw gamesError
  return reopenBracketAfterGameEdit({
    supabase: client,
    tournament: { ...tournament, champion_player_id: null, status: 'active' },
    games: games || [],
    reopenedGame: game,
  })
}

// ── Runner ───────────────────────────────────────────────────────────────────

// A failed read is not evidence the status changed; the step runs and reports
// its own failure if the database is unavailable.
async function statusStill(supabase, tables, gameId, predicate) {
  const { data, error } = await supabase.from(tables.games).select('status').eq('id', gameId).maybeSingle()
  if (error || !data) return true
  return predicate(data.status)
}

async function runSteps(steps, { dryRun, client, stillApplies }) {
  const results = []
  const changedGames = []
  let superseded = false
  for (const step of steps) {
    // Another client can change the status while this runs. Checking before
    // each step keeps a stale pass from doing more than the step in flight;
    // whatever that step wrote is found by the audit of the new status.
    if (!dryRun && !superseded && stillApplies && !(await stillApplies())) superseded = true
    if (superseded) {
      results.push({ key: step.key, label: LIFECYCLE_STEP_LABELS[step.key], ok: false, skipped: true,
        message: 'stopped: the game status changed' })
      continue
    }
    const dependency = step.dependsOn && results.find((result) => result.key === step.dependsOn)
    if (!dryRun && dependency && !dependency.ok) {
      results.push({ key: step.key, label: LIFECYCLE_STEP_LABELS[step.key], ok: false, skipped: true,
        message: `waits for ${LIFECYCLE_STEP_LABELS[step.dependsOn].toLowerCase()}` })
      continue
    }
    const owedBefore = client.owed?.length || 0
    try {
      const value = await step.run()
      if (Array.isArray(value)) changedGames.push(...value)
      const owed = (client.owed?.length || 0) > owedBefore
      results.push({ key: step.key, label: LIFECYCLE_STEP_LABELS[step.key], ok: !owed, owed,
        message: owed ? `${client.owed[owedBefore].message} still to do` : (typeof value === 'string' ? value : 'done') })
    } catch (error) {
      const owed = error instanceof LifecycleWorkOwed || (client.owed?.length || 0) > owedBefore
      results.push({ key: step.key, label: LIFECYCLE_STEP_LABELS[step.key], ok: false, owed,
        message: owed ? `${(client.owed?.[owedBefore] || error).message} still to do` : error.message })
    }
  }
  return { results, changedGames, superseded }
}

function summarize(outcome, game, { results, changedGames, superseded }) {
  const failed = results.filter((result) => !result.ok)
  return {
    outcome: outcome || (superseded ? 'superseded' : (failed.length ? 'incomplete' : 'done')),
    game,
    steps: results,
    failed,
    changedGames,
  }
}

// After the row reads `complete`: make stadium log, bets, W/L/S and the
// competition agree with it. `dryRun` reports what would be written instead.
export async function finishGameCompletion({
  supabase,
  sourceType,
  tables,
  gameId,
  betConfig,
  charactersById,
  playersById,
  dryRun = false,
} = {}) {
  const resolvedTables = tablesFor(sourceType, tables)
  const game = await loadGameRow(supabase, resolvedTables, gameId)
  if (!isCompleteGameStatus(game.status)) {
    return { outcome: 'not_complete', game, steps: [], failed: [], changedGames: [] }
  }
  const client = dryRun ? createDryRunClient(supabase) : supabase
  const sides = await describeGame(supabase, sourceType, game)
  let factsPromise = null
  const facts = () => (factsPromise ||= loadGameFacts(supabase, resolvedTables, gameId))
  const context = { supabase, client, sourceType, tables: resolvedTables, game, sides, betConfig, charactersById, playersById }

  const run = await runSteps([
    { key: 'stadiumLog', run: () => ensureStadiumLog(context) },
    { key: 'bets', run: async () => settleBets({ ...context, facts: await facts() }) },
    { key: 'pitching', run: async () => assignPitchingDecisions({ ...context, facts: await facts() }) },
    // Standings break ties on betting winnings, so they wait for settlement.
    { key: 'competition', dependsOn: 'bets', run: () => advanceCompetition(context) },
  ], { dryRun, client, stillApplies: () => statusStill(supabase, resolvedTables, gameId, isCompleteGameStatus) })

  if (!dryRun) {
    const after = await loadGameRow(supabase, resolvedTables, gameId).catch(() => null)
    if (after && !isCompleteGameStatus(after.status)) return summarize('superseded', after, run)
  }
  return summarize(null, game, run)
}

// After the row is back in play: reverse bets, remove the stadium log, clear
// W/L/S and roll back standings/bracket. `dryRun` reports what is left.
export async function finishGameReopen({
  supabase,
  sourceType,
  tables,
  gameId,
  betConfig,
  dryRun = false,
} = {}) {
  const resolvedTables = tablesFor(sourceType, tables)
  const game = await loadGameRow(supabase, resolvedTables, gameId)
  if (isCompleteGameStatus(game.status)) {
    return { outcome: 'superseded', game, steps: [], failed: [], changedGames: [] }
  }
  const client = dryRun ? createDryRunClient(supabase) : supabase
  const context = { supabase, client, sourceType, tables: resolvedTables, game, betConfig, audit: dryRun }

  const run = await runSteps([
    // Bets first: season standings are rebuilt from the ledger.
    { key: 'bets', run: () => reverseBets(context) },
    { key: 'stadiumLog', run: () => removeStadiumLog(context) },
    { key: 'pitching', run: () => clearPitchingDecisions(context) },
    { key: 'competition', dependsOn: 'bets', run: () => reopenCompetition(context) },
  ], { dryRun, client, stillApplies: () => statusStill(supabase, resolvedTables, gameId, (status) => !isCompleteGameStatus(status)) })

  if (!dryRun) {
    const after = await loadGameRow(supabase, resolvedTables, gameId).catch(() => null)
    if (after && isCompleteGameStatus(after.status)) return summarize('superseded', after, run)
  }
  return summarize(null, game, run)
}

// A finished competition's games are history. Many were imported or finished
// before these steps existed and were never given W/L/S or a stadium log;
// offering to "finish" them would be an invitation to rewrite old records, so
// they are not audited. A playoff game of a completed season still is: the
// championship's own follow-ups run after the season flips to completed.
async function competitionInPlay(supabase, sourceType, game) {
  if (sourceType === 'season') {
    const { data, error } = await supabase.from('seasons').select('status').eq('id', game.season_id).maybeSingle()
    if (error) throw error
    if (!data) return false
    return data.status === 'active' || data.status === 'playoffs' || (data.status === 'completed' && Boolean(game.stage))
  }
  if (game.tournament_id == null) return false
  const { data, error } = await supabase.from('tournaments').select('status, archived').eq('id', game.tournament_id).maybeSingle()
  if (error) throw error
  return Boolean(data) && !data.archived
}

// What is still owed for the game's CURRENT persisted status. `kind` says
// which recovery applies; `owed` lists the steps that would still write.
export async function auditGameLifecycle(options = {}) {
  const resolvedTables = tablesFor(options.sourceType, options.tables)
  const game = await loadGameRow(options.supabase, resolvedTables, options.gameId)
  if (isCompleteGameStatus(game.status)) {
    if (!(await competitionInPlay(options.supabase, options.sourceType, game))) return { kind: null, game, owed: [] }
    const result = await finishGameCompletion({ ...options, dryRun: true })
    return { kind: 'completion', game: result.game, owed: result.failed }
  }
  if (IN_PLAY_STATUSES.has(String(game.status || ''))) {
    const result = await finishGameReopen({ ...options, dryRun: true })
    // Standings that disagree with the schedule are a season-wide condition,
    // not evidence that THIS game was reopened; on a game in play, acting on
    // that alone would reverse its live first-inning settlements. The next
    // completion in the season rebuilds standings from the schedule anyway.
    const owed = result.failed.some((step) => step.key !== 'competition') ? result.failed : []
    return { kind: 'reopen', game: result.game, owed }
  }
  return { kind: null, game, owed: [] }
}

// ── Status writes ────────────────────────────────────────────────────────────
// Compare-and-set on the row's own status, which the database applies
// atomically: of two clients completing the same game, one changes the row
// and the other is told it was already complete. A response lost after the
// write committed is resolved by reading the row back.

async function readBack(supabase, tables, gameId) {
  const { data, error } = await supabase.from(tables.games).select('*').eq('id', gameId).maybeSingle()
  return error ? null : data
}

export async function writeGameCompletion({ supabase, sourceType, tables, gameId, patch }) {
  const resolvedTables = tablesFor(sourceType, tables)
  const completeStatus = completeStatusFor(sourceType)
  const { data, error } = await supabase.from(resolvedTables.games)
    .update(patch)
    .eq('id', gameId)
    .neq('status', completeStatus)
    .select('id')
  if (!error && data?.length) return { applied: true, error: null }
  const persisted = await readBack(supabase, resolvedTables, gameId)
  if (persisted && isCompleteGameStatus(persisted.status)) {
    return { applied: false, alreadyComplete: !error, uncertain: Boolean(error), game: persisted, error: null }
  }
  return { applied: false, error: error || new Error(`game ${gameId} could not be completed; it is ${persisted?.status || 'missing'}`) }
}

export async function writeGameReopen({ supabase, sourceType, tables, gameId, patch }) {
  const resolvedTables = tablesFor(sourceType, tables)
  const completeStatus = completeStatusFor(sourceType)
  const { data, error } = await supabase.from(resolvedTables.games)
    .update(patch)
    .eq('id', gameId)
    .eq('status', completeStatus)
    .select('id')
  if (!error && data?.length) return { applied: true, error: null }
  const persisted = await readBack(supabase, resolvedTables, gameId)
  if (persisted && IN_PLAY_STATUSES.has(String(persisted.status || ''))) {
    return { applied: false, alreadyReopened: !error, uncertain: Boolean(error), game: persisted, error: null }
  }
  return { applied: false, error: error || new Error(`game ${gameId} could not be reopened; it is ${persisted?.status || 'missing'}`) }
}
