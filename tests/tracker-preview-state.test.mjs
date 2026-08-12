import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTrackerPreviewMessage,
  createTrackerPreviewState,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'

const grounder = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=King K. Rool|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=-0.8|spray_degrees=-14.6|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=4786|x=-5.77596045|y=0.2675789|z=-22.8378239|distance_feet=67.8'

function feed(state, messages) {
  messages.forEach((message) => applyTrackerPreviewMessage(state, message))
  return trackerPreviewSnapshot(state)
}

test('local preview reconstructs a measured groundout entirely in memory', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    '[TRACKER_LINEUP] team=Mario Fireballs|batting=Green Paratroopa,Mario,Luigi,Yoshi,Peach,Daisy,Wario,Waluigi,Bowser|fielding=P=Green Paratroopa,C=Mario,1B=Luigi,2B=Yoshi,3B=Peach,SS=Daisy,LF=Wario,CF=Waluigi,RF=Bowser',
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Strike 1.',
    'Count: 0-1',
    'Fair ball!',
    grounder,
    'Daisy recorded an assist!',
    'Luigi put King K. Rool out!',
  ])

  assert.equal(snapshot.mode, 'local_preview')
  assert.equal(snapshot.writes_enabled, false)
  assert.equal(snapshot.display_at_bat.result, 'GO')
  assert.equal(snapshot.display_at_bat.trajectory, 'G')
  assert.equal(snapshot.display_at_bat.hit_distance_ft, 67.8)
  assert.equal(snapshot.display_at_bat.hit_stadium_key, 'mario_stadium')
  assert.equal(snapshot.display_at_bat.hit_notation, 'G6-3')
  assert.deepEqual(snapshot.display_at_bat.pitches.map((pitch) => pitch.result), ['strike_unknown', 'in_play'])
})

test('the completed at-bat stays visible while the next empty matchup begins', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    'Luigi was hit by a pitch!',
    'Peach vs. Yoshi',
  ])
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.display_at_bat.batter_name, 'Luigi')
  assert.equal(snapshot.display_at_bat.result, 'HBP')
  assert.equal(snapshot.display_at_bat.saved_to_database, false)
  assert.deepEqual(snapshot.display_at_bat.pitches.map((pitch) => pitch.result), ['hbp'])
})

test('the next matchup snapshot resolves actual runner destinations', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Mario vs. Yoshi',
    'Luigi is on first.',
    'Count: 0-0',
    'Fair ball!',
    'Yoshi recorded a single!',
    'Mario vs. Peach',
    'Yoshi is on first.',
    'Luigi is on third.',
    'Count: 0-0',
  ])
  assert.deepEqual(trackerPreviewSnapshot(state).last_completed_at_bat.runner_assignments, [
    { id: 'batter', runner: { characterName: 'Yoshi' }, origin: 'plate', isBatter: true, destination: 'first' },
    { id: 'first', runner: { characterName: 'Luigi' }, origin: 'first', isBatter: false, destination: 'third' },
  ])
})
