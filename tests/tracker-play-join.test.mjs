import test from 'node:test'
import assert from 'node:assert/strict'

import { joinPlayToAtBat, joinSession, halfFromPlay, isFairPlay } from '../scripts/tracker_play_join.mjs'
import { pitchSequence, trackingPlay } from './helpers/trackerFixtures.mjs'

// The join is the one inference in the whole pipeline, and the failure it can
// produce is the worst one available: a fielding sequence attached to the wrong
// at-bat looks exactly like a correct answer. So the tests here are mostly
// about the cases where it must REFUSE.

function atBat(overrides = {}) {
  return {
    pa_number: 1,
    inning: 1,
    half: 'top',
    batter_name: 'Luigi',
    result: '1B',
    pitches: pitchSequence(['in_play']),
    ...overrides,
  }
}

test('the collector half byte maps to the tracker half name', () => {
  assert.equal(halfFromPlay({ inning_half: 0 }), 'top')
  assert.equal(halfFromPlay({ inning_half: 1 }), 'bottom')
  assert.equal(halfFromPlay({ inning_half: 7 }), null)
})

test('foul balls are plays but never an at-bat outcome', () => {
  assert.equal(isFairPlay(trackingPlay({ batted_ball_class: 'fair_in_play' })), true)
  assert.equal(isFairPlay(trackingPlay({ batted_ball_class: 'fair_caught' })), true)
  assert.equal(isFairPlay(trackingPlay({ batted_ball_class: 'home_run' })), true)
  assert.equal(isFairPlay(trackingPlay({ batted_ball_class: 'foul' })), false)
  assert.equal(isFairPlay(trackingPlay({ batted_ball_class: 'foul_home_run' })), false)
})

test('inning, half, batter and count join a play to exactly one at-bat', () => {
  const result = joinPlayToAtBat(trackingPlay(), [atBat()], { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'joined')
  assert.equal(result.pa_number, 1)
  assert.match(result.reason, /0-0 count/)
})

test('two at-bats by the same batter in one half-inning are AMBIGUOUS, never guessed', () => {
  const play = trackingPlay({ balls: 0, strikes: 0 })
  const result = joinPlayToAtBat(play, [
    atBat({ pa_number: 3, pitches: pitchSequence(['in_play']) }),
    atBat({ pa_number: 9, pitches: pitchSequence(['in_play']) }),
  ], { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.pa_number, null)
  assert.deepEqual(result.candidate_pa_numbers, [3, 9])
})

test('a whole-session join uses contact order when the lineup bats around', () => {
  const plays = [
    trackingPlay({ contact_timer: 100, batter: 'Luigi', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 200, batter: 'Mario', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 300, batter: 'Luigi', balls: 0, strikes: 0 }),
  ]
  const session = joinSession(plays, [
    atBat({ pa_number: 1, batter_name: 'Luigi' }),
    atBat({ pa_number: 2, batter_name: 'Mario' }),
    atBat({ pa_number: 3, batter_name: 'Luigi' }),
  ], { latestInning: 1, latestHalf: 'top' })

  assert.deepEqual(session.joins.map((entry) => entry.join.pa_number), [1, 2, 3])
  assert.equal(session.tally.joined, 3)
})

test('fouls share the batter occurrence with the fair ball that follows', () => {
  const plays = [
    trackingPlay({ contact_timer: 100, batted_ball_class: 'foul', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 200, batted_ball_class: 'fair_in_play', balls: 0, strikes: 1 }),
    trackingPlay({ contact_timer: 300, batted_ball_class: 'foul', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 400, batted_ball_class: 'fair_in_play', balls: 0, strikes: 1 }),
  ]
  const repeated = [
    atBat({ pa_number: 3, pitches: pitchSequence(['foul', 'in_play']) }),
    atBat({ pa_number: 12, pitches: pitchSequence(['foul', 'in_play']) }),
  ]
  const session = joinSession(plays, repeated, { latestInning: 1, latestHalf: 'top' })

  assert.deepEqual(session.joins.map((entry) => entry.join.pa_number), [3, 3, 12, 12])
  assert.equal(session.tally.joined, 4)
})

test('the count discriminates between two at-bats the coarse key cannot', () => {
  const play = trackingPlay({ balls: 2, strikes: 1 })
  const result = joinPlayToAtBat(play, [
    atBat({ pa_number: 3, pitches: pitchSequence(['in_play']) }),
    atBat({ pa_number: 9, pitches: pitchSequence(['ball', 'ball', 'looking', 'in_play']) }),
  ], { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'joined')
  assert.equal(result.pa_number, 9)
})

test('outs discriminate repeat trips by the same batter at the same count', () => {
  const play = trackingPlay({ balls: 0, strikes: 0, outs: 2 })
  const result = joinPlayToAtBat(play, [
    atBat({ pa_number: 53, outs_before_pa: 0 }),
    atBat({ pa_number: 63, outs_before_pa: 2, result: 'FO' }),
  ], { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'joined')
  assert.equal(result.pa_number, 63)
  assert.match(result.reason, /0-0 count and 2 outs/)
})

test('a play the tracker log has not reached yet is PENDING, not orphaned', () => {
  const play = trackingPlay({ inning: 4, inning_half: 1 })
  const result = joinPlayToAtBat(play, [atBat()], { latestInning: 2, latestHalf: 'top' })
  assert.equal(result.status, 'pending')
  assert.match(result.reason, /has not produced this at-bat yet/)
})

test('a play the log has already gone past is ORPHANED', () => {
  const play = trackingPlay({ inning: 1, inning_half: 0, batter: 'Nobody At All' })
  const result = joinPlayToAtBat(play, [atBat()], { latestInning: 5, latestHalf: 'bottom' })
  assert.equal(result.status, 'orphaned')
  assert.equal(result.pa_number, null)
})

test('a fair ball on a plate appearance scored as a strikeout is a MISMATCH', () => {
  const play = trackingPlay({ batted_ball_class: 'fair_in_play' })
  const result = joinPlayToAtBat(play, [
    atBat({ result: 'K', pitches: pitchSequence(['looking', 'looking', 'swinging_miss']) }),
  ], { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'mismatch')
  assert.equal(result.pa_number, 1)
  assert.match(result.reason, /cannot belong to a plate appearance scored K/)
})

test('a play struck at a count the plate appearance never saw is a MISMATCH', () => {
  const play = trackingPlay({ balls: 3, strikes: 2 })
  const result = joinPlayToAtBat(play, [atBat({ pitches: pitchSequence(['in_play']) })],
    { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'mismatch')
  assert.match(result.reason, /a count PA 1 never saw/)
})

test('the game spelling and the roster spelling of one character still join', () => {
  const play = trackingPlay({ batter: 'Koopa Troopa' })
  const result = joinPlayToAtBat(play, [atBat({ batter_name: 'Koopa' })],
    { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'joined')
})

test('the capture\'s plain "Mii" joins the tracker\'s shirt-coloured Mii', () => {
  const play = trackingPlay({ batter: 'Mii' })
  const result = joinPlayToAtBat(play, [atBat({ batter_name: 'Orange Mii (M)' })],
    { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.status, 'joined')
})

test('several plays in one at-bat join to it, and only the fair one is its outcome', () => {
  const plays = [
    trackingPlay({ contact_timer: 100, batted_ball_class: 'foul', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 200, batted_ball_class: 'foul', balls: 0, strikes: 1 }),
    trackingPlay({ contact_timer: 300, batted_ball_class: 'fair_caught', balls: 0, strikes: 2 }),
  ]
  const session = joinSession(plays, [
    atBat({ result: 'FO', pitches: pitchSequence(['foul', 'foul', 'in_play']) }),
  ], { latestInning: 1, latestHalf: 'top' })
  assert.equal(session.tally.joined, 3)
  const outcome = session.outcomeByPaNumber.get(1)
  assert.equal(outcome.play.contact_timer, 300)
})

test('two fair balls joined to one plate appearance are demoted to ambiguous', () => {
  const plays = [
    trackingPlay({ contact_timer: 100, batted_ball_class: 'fair_in_play', balls: 0, strikes: 0 }),
    trackingPlay({ contact_timer: 300, batted_ball_class: 'fair_caught', balls: 0, strikes: 0 }),
  ]
  const session = joinSession(plays, [atBat()], { latestInning: 1, latestHalf: 'top' })
  assert.equal(session.outcomeByPaNumber.has(1), false)
  for (const entry of session.joins) {
    assert.equal(entry.join.status, 'ambiguous')
    assert.match(entry.join.reason, /2 fair batted balls/)
  }
})

test('a session with no at-bats leaves every play unattached rather than inventing one', () => {
  const session = joinSession([trackingPlay()], [], { latestInning: null, latestHalf: null })
  assert.equal(session.tally.joined, undefined)
  assert.equal(session.joins[0].join.pa_number, null)
})

test('every join result carries the evidence it decided on', () => {
  const result = joinPlayToAtBat(trackingPlay({ outs: 2, balls: 1, strikes: 2 }), [atBat()],
    { latestInning: 1, latestHalf: 'top' })
  assert.equal(result.evidence.inning, 1)
  assert.equal(result.evidence.half, 'top')
  assert.equal(result.evidence.batter, 'Luigi')
  assert.equal(result.evidence.count, '1-2')
  assert.equal(result.evidence.outs, 2)
  assert.equal(result.evidence.contact_timer, 10000)
})
