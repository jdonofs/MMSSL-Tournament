import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExperimentalWar, fangraphsPitchingWar, fangraphsPositionWar, positionRunsForInnings, warBattingLine, warPitchingOuts } from '../src/utils/experimentalWar.js'

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
export function warFixture(prefix = '', competition = 1) {
  const gameId = `${prefix}1`
  const games = [{ id: gameId, status: 'complete', tournament_id: competition }]
  const characters = [{ id: 1, name: 'Mario' }, { id: 2, name: 'Luigi' }]
  const plateAppearances = ['HR', 'K', 'GO', 'FO', '1B', 'K', 'GO', 'FO'].map((result, index) => ({
    id: index + 1, game_id: gameId, result, pa_number: index + 1, inning: 1,
    player_id: index < 4 ? 'A' : 'B', character_id: index < 4 ? 1 : 2,
    pitcher_player_id: index < 4 ? 'B' : 'A', pitcher_id: index < 4 ? 2 : 1,
  }))
  const pitchingStints = [
    { id: 1, game_id: gameId, player_id: 'A', character_id: 1, innings_pitched: 1, hr_allowed: 0, walks: 0, strikeouts: 1, runs_allowed: 0 },
    { id: 2, game_id: gameId, player_id: 'B', character_id: 2, innings_pitched: 1, hr_allowed: 1, walks: 0, strikeouts: 1, runs_allowed: 1 },
  ]
  return { games, characters, plateAppearances, pitchingStints }
}

test('MLB batting weights count IPHR, exclude errors, sacrifice bunts and intentional walks', () => {
  const line = warBattingLine([{ result: 'HR' }, { result: 'IPHR' }, { result: '1B', is_error: true }, { result: 'BB' }, { result: 'HBP' }, { result: 'IBB' }, { result: 'SH' }, { result: 'SF' }])
  assert.equal(line.pa, 8)
  assert.equal(line.denominator, 6)
  near(line.numerator, 5.487)
})

test('positions use MLB adjustments per 1,458 innings, not batting PA', () => {
  near(positionRunsForInnings(1458, 2), 12.5)
  near(positionRunsForInnings(729, 3) + positionRunsForInnings(729, 6), -2.5)
  near(positionRunsForInnings(3, 8), 2.5 / 486)
  assert.equal(positionRunsForInnings(9, 'unknown'), null)
})

test('average position players receive the published 570-win replacement pool', () => {
  const value = fangraphsPositionWar({ battingRuns: 0, pa: 600, leaguePa: 180000, games: 2430, runsPerWin: 10 })
  near(value.replacementRuns, 19)
  near(value.war, 1.9)
})

test('pitcher formula preserves MLB starter/reliever replacement and chaining', () => {
  const input = { ip: 9, games: 1, starts: 1, hr: 0, bb: 0, k: 0, fipConstant: 4, leagueRa9: 4 }
  const starter = fangraphsPitchingWar(input)
  near(starter.rawWar, 0.12)
  near(starter.runsPerWin, 9)
  near(fangraphsPitchingWar({ ...input, starts: 0 }).rawWar, 0.03)
  near(fangraphsPitchingWar({ ...input, starts: 0, gmLI: 3 }).rawWar, 0.06)
  assert.ok(fangraphsPitchingWar({ ...input, k: 5, iffb: 2 }).rawWar > starter.rawWar)
  assert.ok(fangraphsPitchingWar({ ...input, hbp: 2 }).rawWar < starter.rawWar)
})

test('zero-out damage is retained and baseball decimal innings are converted correctly', () => {
  assert.equal(warPitchingOuts(2.1), 7)
  assert.equal(warPitchingOuts(2.2), 8)
  near(fangraphsPitchingWar({ ip: 0, games: 1, starts: 0, hr: 1, bb: 0, k: 0, fipConstant: 4, leagueRa9: 4 }).rawWar, -13 / 81)
})

test('combined value includes pitching and both identity views reconcile to MLB budgets', () => {
  const model = buildExperimentalWar(warFixture())
  assert.equal(model.players.length, 2)
  const total = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0)
  near(total(model.players, 'war'), 1000 / 2430)
  near(total(model.characters, 'war'), total(model.players, 'war'))
  near(total(model.players, 'positionWar'), 570 / 2430)
  near(total(model.players, 'pitchingWar'), 430 / 2430)
  assert.ok(model.players.find((r) => r.id === 'A').pitchingWar > model.players.find((r) => r.id === 'B').pitchingWar)
  assert.equal(model.players[0].baserunningRuns, null)
  assert.equal(model.players[0].coverage, 'Partial')
})

test('season/tournament numeric IDs cannot collide and career values sum independent cohorts', () => {
  const a = warFixture(), b = warFixture('season-')
  const combined = buildExperimentalWar({ games: [...a.games, ...b.games], characters: a.characters, plateAppearances: [...a.plateAppearances, ...b.plateAppearances], pitchingStints: [...a.pitchingStints, ...b.pitchingStints] })
  assert.equal(combined.cohorts.length, 2)
  const single = buildExperimentalWar(a)
  combined.players.forEach((row) => near(row.war, single.players.find((r) => r.id === row.id).war * 2))
})

test('unfinished and data-free games cannot inflate replacement credit', () => {
  const input = warFixture()
  input.games.push({ id: 2, status: 'complete' }, { id: 3, status: 'in_progress' })
  const result = buildExperimentalWar(input)
  assert.equal(result.includedGames, 1)
  assert.equal(result.excludedGames, 2)
  assert.equal(buildExperimentalWar().players.length, 0)
})

test('missing pitching counts or identities do not masquerade as zero runs or dilute replacement credit', () => {
  const missingRuns = warFixture()
  missingRuns.pitchingStints[0].runs_allowed = null
  assert.equal(buildExperimentalWar(missingRuns).includedGames, 0)
  const missingIdentity = warFixture()
  missingIdentity.plateAppearances[0].character_id = null
  assert.equal(buildExperimentalWar(missingIdentity).includedGames, 0)
})

test('ineligible opportunities cannot bring stale modeled values into WAR', () => {
  const input = warFixture()
  input.runnerOpportunities = [{ competition_type: 'tournament', game_id: 1, pa_id: 1, is_discretionary: false, outcome: 'hold', runner_player_id: 'A', runner_character_id: 1, runner_run_value: 100 }]
  input.doublePlayOpportunities = [{ competition_type: 'tournament', game_id: 1, pa_id: 1, structural_eligible: false, run_value: 100 }]
  assert.equal(buildExperimentalWar(input).players.find((row) => row.id === 'A').baserunningRuns, null)
})

test('namespaced opportunities credit the runner and defender once and ignore orphan rows', () => {
  const input = warFixture('season-')
  input.runnerOpportunities = [
    { competition_type: 'season', game_id: 1, pa_id: 1, runner_player_id: 'B', runner_character_id: 2, responsible_fielder_player_id: 'A', responsible_fielder_character_id: 1, outcome: 'advance_safe', attempted: true, safe: true, opportunity_type: 'first_to_third_on_single', origin_base: 'first', target_base: 'third', outs_before: 0, base_state_before: 1 },
    { competition_type: 'tournament', game_id: 1, pa_id: 1, runner_player_id: 'X', runner_character_id: 99, runner_run_value: 500 },
  ]
  const result = buildExperimentalWar(input)
  const runner = result.players.find((row) => row.id === 'B'), defender = result.players.find((row) => row.id === 'A')
  assert.ok(Number.isFinite(runner.baserunningRuns))
  assert.equal(runner.runnerOpportunities, 1)
  near(runner.baserunningRuns, -defender.fieldingRuns)
  assert.equal(result.players.length, 2)
})

test('position changes count only unique occupants and retain actual defensive out exposure', () => {
  const input = warFixture()
  input.gameFielders = [{ game_id: 1, player_id: 'A', character: 'Mario', position: 6, inning_from: 1 }]
  const result = buildExperimentalWar(input)
  near(result.players.find((row) => row.id === 'A').positionRuns, 7.5 / 1458)
  input.gameFielders.push({ ...input.gameFielders[0], character: 'Luigi' })
  assert.equal(buildExperimentalWar(input).players.find((row) => row.id === 'A').positionRuns, null)
})
