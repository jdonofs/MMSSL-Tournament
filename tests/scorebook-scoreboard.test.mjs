import assert from 'node:assert/strict'
import test from 'node:test'

import {
  errorsFromPAs,
  formatGameStatusLabel,
  getLineScoreCellValue,
  getPaScoringRuns,
  hitsFromPAs,
  inningRunsFromPAs,
  inningRunsFromRows,
  normalizeStageLabel,
  runsFromPAs,
  runsThisHalfFromPAs,
} from '../src/features/scorebook/domain/scoreboard.js'

test('plate-appearance fallback scoring does not double-count the batter on a home run', () => {
  assert.equal(getPaScoringRuns({ result: 'HR', rbi: 3, run_scored: true }), 3)
  assert.equal(getPaScoringRuns({ result: 'IPHR', rbi: 1, run_scored: true }), 1)
  assert.equal(getPaScoringRuns({ result: '2B', rbi: 2, run_scored: true }), 3)
})

test('tracked run rows override legacy RBI and run-scored fallbacks', () => {
  const pa = { id: 9, result: '1B', rbi: 4, run_scored: true }
  assert.equal(getPaScoringRuns(pa, { 9: [{ id: 1 }, { id: 2 }] }), 2)
})

test('run totals and inning maps prefer authoritative run rows when present', () => {
  const pas = [
    { id: 1, player_id: 'away', inning: 1, result: '1B', rbi: 1 },
    { id: 2, player_id: 'away', inning: 2, result: 'HR', rbi: 2, run_scored: true },
  ]
  const runs = [
    { scoring_player_id: 'away', inning: 1 },
    { scoring_player_id: 'away', inning: 2 },
    { scoring_player_id: 'away', inning: 2 },
    { scoring_player_id: 'home', inning: 2 },
  ]

  assert.equal(runsFromPAs(pas, 'away', runs), 3)
  assert.equal(runsThisHalfFromPAs(pas, 'away', 2, runs), 2)
  assert.deepEqual(inningRunsFromPAs(pas, 'away', runs), { 1: 1, 2: 2 })
})

test('legacy plate appearances still derive totals when no run rows exist', () => {
  const pas = [
    { player_id: 'away', inning: 1, result: '1B', rbi: 1 },
    { player_id: 'away', inning: 2, result: 'HR', rbi: 2, run_scored: true },
  ]

  assert.equal(runsFromPAs(pas, 'away'), 3)
  assert.equal(runsThisHalfFromPAs(pas, 'away', 2), 2)
  assert.deepEqual(inningRunsFromPAs(pas, 'away'), { 1: 1, 2: 2 })
})

test('hit and error totals preserve scorebook credit rules', () => {
  const pas = [
    { player_id: 'away', result: '1B', is_error: false, is_official_ab: true },
    { player_id: 'away', result: '1B', is_error: true, is_official_ab: true },
    { player_id: 'home', result: 'ROE', is_error: true, is_official_ab: true },
  ]

  assert.equal(hitsFromPAs(pas, 'away'), 1)
  assert.equal(errorsFromPAs(pas, 'away', 'home'), 1)
})

test('stored inning-score rows aggregate duplicate rows and normalize missing innings', () => {
  assert.deepEqual(inningRunsFromRows([
    { player_id: 1, inning: 2, runs: 1 },
    { player_id: '1', inning: 2, runs: 2 },
    { player_id: 1, inning: null, runs: 1 },
    { player_id: 2, inning: 2, runs: 9 },
  ], 1), { 1: 1, 2: 3 })
})

test('line-score blanks distinguish completed scoreless halves from future halves', () => {
  assert.equal(getLineScoreCellValue({ inning: 1, side: 'away', scoreMap: { 1: 0 }, completedHalfCount: 0 }), 0)
  assert.equal(getLineScoreCellValue({ inning: 1, side: 'away', completedHalfCount: 1 }), 0)
  assert.equal(getLineScoreCellValue({ inning: 1, side: 'home', completedHalfCount: 1 }), '-')
})

test('game status and championship labels preserve scorebook display wording', () => {
  assert.equal(formatGameStatusLabel({}, 'active', 'Bot 2'), 'Bot 2')
  assert.equal(formatGameStatusLabel({}, 'active'), 'Live')
  assert.equal(formatGameStatusLabel({}, 'pending'), 'Pregame')
  assert.equal(formatGameStatusLabel({ final_inning: 4, is_extra_innings: true }, 'complete', '', 3), 'Final/4')
  assert.equal(normalizeStageLabel('CG-1'), 'Championship')
  assert.equal(normalizeStageLabel('CG-2 if necessary'), 'Championship Reset')
})
