import { isCreditedHit } from './creditedHit.js'
import { calculateOutsForPa } from './defensiveEfficiency.js'
import { characterNameKey } from './characterNames.js'
import { modelRunnerOpportunities, modelDoublePlayOpportunities, modelFieldingOpportunities } from './advancedDefense.js'

// Published FanGraphs equations; see docs/experimental-war.md for sources and
// the explicit Sluggers input substitutions. No early rounding or /3 FIP reuse.
export const EXPERIMENTAL_WAR_VERSION = 'sluggers-fwar-experimental-v1'
export const MLB_2025_WEIGHTS = Object.freeze({ BB: 0.691, HBP: 0.722, '1B': 0.882, '2B': 1.252, '3B': 1.584, HR: 2.037, IPHR: 2.037 })
export const MLB_2025_WOBA_SCALE = 1.232
export const POSITION_RUNS = Object.freeze({ 1: 0, 2: 12.5, 3: -12.5, 4: 2.5, 5: 2.5, 6: 7.5, 7: -7.5, 8: 2.5, 9: -7.5, DH: -17.5 })
const number = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const sum = (rows, field) => rows.reduce((total, row) => total + (number(row[field]) ?? 0), 0)
export function warPitchingOuts(value) {
  const innings = number(value)
  if (innings == null || innings < 0) return 0
  const whole = Math.trunc(innings), fraction = innings - whole
  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2
  return whole * 3 + Math.round(fraction * 3)
}
const pairKey = (playerId, characterId) => JSON.stringify([String(playerId), String(characterId)])
const gameKey = (row) => row.competition_type === 'season' && !String(row.game_id).startsWith('season-') ? `season-${row.game_id}` : String(row.game_id)
const paKey = (row) => `${gameKey(row)}:${row.pa_id ?? row.id}`
const groupBy = (rows, key) => {
  const result = new Map()
  for (const row of rows) {
    const id = key(row)
    if (!result.has(id)) result.set(id, [])
    result.get(id).push(row)
  }
  return result
}

export function warBattingLine(pas, weights = MLB_2025_WEIGHTS) {
  let numerator = 0, denominator = 0
  for (const pa of pas) {
    const intentional = pa.result === 'IBB' || pa.is_intentional_walk === true
    if (!intentional && !['SH', 'CI'].includes(pa.result)) denominator += 1
    if (intentional) continue
    if (['BB', 'HBP'].includes(pa.result) || isCreditedHit(pa)) numerator += weights[pa.result] ?? 0
  }
  return { pa: pas.length, numerator, denominator, woba: denominator ? numerator / denominator : 0 }
}

export function positionRunsForInnings(innings, position) {
  return POSITION_RUNS[position] == null ? null : innings / 9 / 162 * POSITION_RUNS[position]
}

export function fangraphsPositionWar({ battingRuns, baserunningRuns = 0, fieldingRuns = 0, positionRuns = 0, leagueRuns = 0, pa, leaguePa, games, runsPerWin }) {
  if (!(runsPerWin > 0) || !(leaguePa > 0)) return null
  const replacementRuns = 570 * games / 2430 * runsPerWin / leaguePa * pa
  const raa = battingRuns + baserunningRuns + fieldingRuns + positionRuns + leagueRuns
  return { replacementRuns, raa, rar: raa + replacementRuns, war: (raa + replacementRuns) / runsPerWin }
}

export function fangraphsPitchingWar({ ip, games, starts, hr, bb, hbp = 0, k, iffb = 0, fipConstant, leagueRa9, parkFactor = 1, gmLI = 1 }) {
  if (!(games > 0) || ip < 0 || !(parkFactor > 0)) return null
  const numerator = 13 * hr + 3 * (bb + hbp) - 2 * (k + iffb)
  // fipConstant here includes the ERA-to-RA9 adjustment. The algebra below
  // also preserves damage from an appearance in which no out was recorded.
  const fipR9 = ip > 0 ? (numerator / ip + fipConstant) / parkFactor : null
  const ipPerGame = ip / games
  const runsPerWin = (((18 - ipPerGame) * leagueRa9 + ipPerGame * (fipR9 ?? leagueRa9)) / 18 + 2) * 1.5
  if (!(runsPerWin > 0)) return null
  const replacementLevel = 0.03 * (1 - starts / games) + 0.12 * starts / games
  const leverage = starts === games ? 1 : (1 + gmLI) / 2
  const runsAboveAverage = (leagueRa9 * ip - (numerator + fipConstant * ip) / parkFactor) / 9
  return { fipR9, runsPerWin, replacementLevel, leverage, runsAboveAverage, rawWar: (runsAboveAverage / runsPerWin + replacementLevel * ip / 9) * leverage }
}

function freshRow(playerId, characterId) {
  return { playerId: String(playerId), characterId: String(characterId), pa: 0, ip: 0, battingRuns: 0, baserunningRuns: null, fieldingRuns: null, positionRuns: null, leagueRuns: 0, replacementRuns: 0, positionWar: 0, pitchingWar: 0, pitchingCorrection: 0, war: 0, runnerOpportunities: 0, fieldingOpportunities: 0, positionOuts: 0, issues: new Set() }
}

function buildCohort({ games, pas, stints, fielders, runners, doublePlays, fielding, characters }) {
  const rows = new Map()
  const ensure = (playerId, characterId) => {
    if (playerId == null || characterId == null) return null
    const key = pairKey(playerId, characterId)
    if (!rows.has(key)) rows.set(key, freshRow(playerId, characterId))
    return rows.get(key)
  }
  const gameIds = new Set(games.map((game) => String(game.id)))
  const scoped = (entries) => entries.filter((row) => gameIds.has(gameKey(row)))
  pas = scoped(pas)
  stints = scoped(stints)
  const leaguePa = pas.length
  const leagueIp = stints.reduce((total, row) => total + warPitchingOuts(row.innings_pitched) / 3, 0)
  const leagueRuns = sum(stints, 'runs_allowed')
  if (!leaguePa || !leagueIp) return { rows: [], games: 0, excludedGames: games.length, reason: 'Plate appearances and pitching outs are required.' }
  const leagueRa9 = 9 * leagueRuns / leagueIp
  const runsPerWin = leagueRa9 * 1.5 + 3
  const leagueBatting = warBattingLine(pas)
  for (const battingPas of groupBy(pas, (pa) => pairKey(pa.player_id, pa.character_id)).values()) {
    const first = battingPas[0]
    const row = ensure(first.player_id, first.character_id)
    if (!row) continue
    const line = warBattingLine(battingPas)
    row.pa = line.pa
    row.battingRuns = (line.woba - leagueBatting.woba) / MLB_2025_WOBA_SCALE * line.pa
  }

  const pasByKey = new Map(pas.map((pa) => [paKey(pa), pa]))
  const usable = (entries) => scoped(entries).filter((row) => pasByKey.has(paKey(row)) && row.quality?.quarantined_session !== true)
  // Use the same opportunity models as the advanced stats view. These are
  // Sluggers proxies for MLB UBR/fielding inputs, not MLB proprietary tracking.
  for (const opportunity of modelRunnerOpportunities(usable(runners))) {
    if (opportunity.is_discretionary === false || !['hold', 'advance_safe', 'advance_out'].includes(opportunity.outcome)) continue
    const row = ensure(opportunity.runner_player_id, opportunity.runner_character_id)
    if (row && number(opportunity.runner_run_value) != null) {
      row.baserunningRuns = (row.baserunningRuns ?? 0) + Number(opportunity.runner_run_value)
      row.runnerOpportunities += 1
    }
    const defender = ensure(opportunity.responsible_fielder_player_id, opportunity.responsible_fielder_character_id)
    if (defender && number(opportunity.arm_run_value) != null) {
      defender.fieldingRuns = (defender.fieldingRuns ?? 0) + Number(opportunity.arm_run_value)
      defender.fieldingOpportunities += 1
    }
  }
  for (const opportunity of modelDoublePlayOpportunities(usable(doublePlays))) {
    if (opportunity.structural_eligible === false) continue
    const pa = pasByKey.get(paKey(opportunity))
    const batter = ensure(pa.player_id, pa.character_id)
    if (batter && number(opportunity.run_value) != null) batter.baserunningRuns = (batter.baserunningRuns ?? 0) - Number(opportunity.run_value)
    // Team-only DP credit cannot be invented for an individual character.
    if (opportunity.credit_status !== 'player') continue
    const defender = ensure(opportunity.first_fielder_player_id, opportunity.first_fielder_character_id)
    if (defender && number(opportunity.run_value) != null) {
      defender.fieldingRuns = (defender.fieldingRuns ?? 0) + Number(opportunity.run_value)
      defender.fieldingOpportunities += 1
    }
  }
  for (const opportunity of modelFieldingOpportunities(usable(fielding))) {
    if (!opportunity.is_primary || opportunity.quality?.exclude_from_oaa || number(opportunity.outs_above_average) == null) continue
    const row = ensure(opportunity.fielder_player_id, opportunity.fielder_character_id)
    if (!row) continue
    row.fieldingRuns = (row.fieldingRuns ?? 0) + Number(opportunity.outs_above_average) * 0.8
    row.fieldingOpportunities += 1
  }

  const characterByName = new Map(characters.map((row) => [characterNameKey(row.name), row.id]))
  const fieldersByGame = groupBy(scoped(fielders), gameKey)
  for (const pa of pas) {
    const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
    if (!outs || pa.pitcher_player_id == null) continue
    const candidates = (fieldersByGame.get(gameKey(pa)) || []).filter((fielder) => (
      String(fielder.player_id ?? fielder.team_id) === String(pa.pitcher_player_id)
      && Number(fielder.inning_from ?? 1) <= Number(pa.inning)
      && (fielder.inning_to == null || Number(fielder.inning_to) >= Number(pa.inning))
    ))
    for (let position = 1; position <= 9; position += 1) {
      const occupants = candidates.filter((fielder) => Number(fielder.position) === position)
      if (occupants.length !== 1) continue
      const fielder = occupants[0]
      const id = fielder.character_id ?? characterByName.get(characterNameKey(fielder.character))
      const row = ensure(pa.pitcher_player_id, id)
      if (!row) continue
      row.positionRuns = (row.positionRuns ?? 0) + positionRunsForInnings(outs / 3, position)
      row.positionOuts += outs
    }
  }

  // Resolve starter/reliever role per appearance from the first opposing PA.
  // Multiple stints by the same pitcher in one game remain one appearance.
  const defendingPas = groupBy(pas, (pa) => `${gameKey(pa)}:${pa.pitcher_player_id}`)
  const appearances = []
  for (const gameStints of groupBy(stints, (stint) => `${gameKey(stint)}:${pairKey(stint.player_id, stint.character_id)}`).values()) {
    const first = gameStints[0]
    const row = ensure(first.player_id, first.character_id)
    if (!row) continue
    const teamPas = [...(defendingPas.get(`${gameKey(first)}:${first.player_id}`) || [])].sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
    const pitchingPas = teamPas.filter((pa) => String(pa.pitcher_id) === String(first.character_id))
    const ip = gameStints.reduce((total, stint) => total + warPitchingOuts(stint.innings_pitched) / 3, 0)
    const started = teamPas.length ? String(teamPas[0].pitcher_id) === String(first.character_id) : null
    if (started == null) row.issues.add('Pitcher role unknown; relief baseline assumed')
    const iffb = pitchingPas.filter((pa) => pa.is_infield_fly === true || (pa.result === 'FO' && ['F', 'P'].includes(pa.trajectory) && Number(pa.hit_location) >= 1 && Number(pa.hit_location) <= 6)).length
    appearances.push({ row, ip, started: Boolean(started), hr: sum(gameStints, 'hr_allowed'), bb: sum(gameStints, 'walks'), k: sum(gameStints, 'strikeouts'), hbp: pitchingPas.filter((pa) => pa.result === 'HBP').length, iffb })
    row.ip += ip
  }
  const leagueNumerator = appearances.reduce((total, a) => total + 13 * a.hr + 3 * (a.bb + a.hbp) - 2 * (a.k + a.iffb), 0)
  const fipConstant = leagueRa9 - leagueNumerator / leagueIp
  let rawPitchingWar = 0
  for (const outings of groupBy(appearances, (a) => `${pairKey(a.row.playerId, a.row.characterId)}:${a.started}`).values()) {
    const row = outings[0].row
    const value = fangraphsPitchingWar({ ip: sum(outings, 'ip'), games: outings.length, starts: outings[0].started ? outings.length : 0, hr: sum(outings, 'hr'), bb: sum(outings, 'bb'), k: sum(outings, 'k'), hbp: sum(outings, 'hbp'), iffb: sum(outings, 'iffb'), fipConstant, leagueRa9 })
    if (!value) { row.issues.add('Pitching run environment could not be modeled'); continue }
    row.pitchingWar += value.rawWar
    rawPitchingWar += value.rawWar
  }
  const correctionPerIp = (430 * games.length / 2430 - rawPitchingWar) / leagueIp
  const aboveAverageRuns = [...rows.values()].reduce((total, row) => total + row.battingRuns + (row.baserunningRuns ?? 0) + (row.fieldingRuns ?? 0) + (row.positionRuns ?? 0), 0)
  for (const row of rows.values()) {
    row.leagueRuns = -aboveAverageRuns / leaguePa * row.pa
    const value = fangraphsPositionWar({ ...row, baserunningRuns: row.baserunningRuns ?? 0, fieldingRuns: row.fieldingRuns ?? 0, positionRuns: row.positionRuns ?? 0, leaguePa, games: games.length, runsPerWin })
    row.replacementRuns = value.replacementRuns
    row.positionWar = value.war
    row.pitchingCorrection = correctionPerIp * row.ip
    row.pitchingWar += row.pitchingCorrection
    row.war = row.positionWar + row.pitchingWar
    if (row.baserunningRuns == null) row.issues.add('Baserunning unmeasured; neutral contribution')
    if (row.fieldingRuns == null) row.issues.add('Fielding unmeasured; neutral contribution')
    if (row.positionRuns == null) row.issues.add('Position exposure missing; neutral contribution')
  }
  return { rows: [...rows.values()], games: games.length, leaguePa, leagueIp, runsPerWin, leagueRa9, fipConstant, correctionPerIp, expectedWar: 1000 * games.length / 2430 }
}

const ADDITIVE = ['pa', 'ip', 'battingRuns', 'leagueRuns', 'replacementRuns', 'positionWar', 'pitchingWar', 'pitchingCorrection', 'war', 'runnerOpportunities', 'fieldingOpportunities', 'positionOuts']
function aggregateRows(rows, identity) {
  return [...groupBy(rows, (row) => row[identity === 'player' ? 'playerId' : 'characterId'])].map(([id, entries]) => {
    const result = { id, version: EXPERIMENTAL_WAR_VERSION, issues: [...new Set(entries.flatMap((row) => [...row.issues]))] }
    for (const field of ADDITIVE) result[field] = sum(entries, field)
    for (const field of ['baserunningRuns', 'fieldingRuns', 'positionRuns']) result[field] = entries.some((row) => row[field] != null) ? sum(entries, field) : null
    result.coverage = result.issues.length ? 'Partial' : 'Tracked inputs'
    return result
  })
}

// Callers namespace season game IDs as season-N, just as Stats.jsx does. The
// same credited player/character rows feed both views: their totals must match.
// Fit each competition separately, then sum, so career filters don't reprice it.
export function buildExperimentalWar({ games = [], plateAppearances = [], pitchingStints = [], gameFielders = [], runnerOpportunities = [], doublePlayOpportunities = [], fieldingOpportunities = [], characters = [] } = {}) {
  const pasByGame = groupBy(plateAppearances, gameKey)
  const stintsByGame = groupBy(pitchingStints, gameKey)
  const eligibleGames = games.filter((game) => {
    const pas = pasByGame.get(String(game.id)) || []
    const stints = stintsByGame.get(String(game.id)) || []
    return ['complete', 'completed'].includes(game.status)
      && pas.length > 0 && pas.every((pa) => pa.result && pa.player_id != null && pa.character_id != null && pa.pitcher_id != null && pa.pitcher_player_id != null)
      && stints.some((row) => warPitchingOuts(row.innings_pitched) > 0)
      && stints.every((row) => row.player_id != null && row.character_id != null && ['innings_pitched', 'runs_allowed', 'hr_allowed', 'walks', 'strikeouts'].every((key) => number(row[key]) != null && Number(row[key]) >= 0))
  })
  const cohorts = [...groupBy(eligibleGames, (game) => `${String(game.id).startsWith('season-') ? 'season' : 'tournament'}:${game.tournament_id ?? game.season_id ?? 'unknown'}`)].map(([id, cohortGames]) => ({
    id, ...buildCohort({ games: cohortGames, pas: plateAppearances, stints: pitchingStints, fielders: gameFielders, runners: runnerOpportunities, doublePlays: doublePlayOpportunities, fielding: fieldingOpportunities, characters }),
  }))
  const rows = cohorts.flatMap((cohort) => cohort.rows)
  return { version: EXPERIMENTAL_WAR_VERSION, players: aggregateRows(rows, 'player'), characters: aggregateRows(rows, 'character'), cohorts: cohorts.map(({ rows, ...cohort }) => cohort), includedGames: eligibleGames.length, excludedGames: games.length - eligibleGames.length }
}
