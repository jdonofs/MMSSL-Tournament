import assert from 'node:assert/strict'
import test from 'node:test'
import { runnerDestinationsFromPlay, runnerAdvancedOnPlay } from '../scripts/tracker_runner_telemetry.mjs'

test('runner telemetry matches canonical names across database and game ID spaces', () => {
  const entries = [
    { id: 'batter', origin: 'plate', isBatter: true, characterId: 80, characterName: 'Mario' },
    { id: 'first', origin: 'first', isBatter: false, characterId: 12, characterName: 'Koopa' },
  ]
  const play = { runners: { BAT: { character_id: 0, character: 'Mario', bases_ran: 1 }, R1: { character_id: 22, character: 'Koopa Troopa', bases_ran: 3 } } }
  assert.deepEqual(runnerDestinationsFromPlay({ entries, result: '1B', play }).map((row) => row.destination), ['first', 'third'])
  assert.equal(runnerDestinationsFromPlay({ entries: [{ ...entries[1], characterName: 'Luigi' }], result: '1B', play }), null)
  assert.equal(runnerDestinationsFromPlay({ entries, result: '1B', play: { ...play, truncated: true } }), null)
})

test('a retired runner carries the base the throw that got him was going to', () => {
  // Yoshi Park 2026-08-31, PA 45: Tiny Kong scores from second on a single --
  // or tries to -- and the left fielder's throw home records the out.
  const entries = [
    { id: 'batter', origin: 'plate', isBatter: true, characterName: 'Daisy' },
    { id: 'second', origin: 'second', isBatter: false, characterName: 'Tiny Kong' },
  ]
  const play = {
    runners: { BAT: { character: 'Daisy', bases_ran: 1 }, R2: { character: 'Tiny Kong', bases_ran: 3 } },
    throws: [
      { outs_recorded: 0, target_base: 'second', runner_at_arrival: { character: 'Daisy' } },
      { outs_recorded: 1, target_base: 'home', runner_at_arrival: { character: 'Tiny Kong', character_id: 30 } },
    ],
  }
  const rows = runnerDestinationsFromPlay({ entries, result: '1B', outRunners: [{ characterName: 'Tiny Kong' }], play })
  assert.deepEqual(rows.map((row) => [row.destination, row.attemptedBase]), [['first', undefined], ['out', 'home']])
  // No out-recording throw names him: the base stays unknown rather than guessed.
  const unthrown = runnerDestinationsFromPlay({ entries, result: '1B', outRunners: [{ characterName: 'Tiny Kong' }],
    play: { ...play, throws: [play.throws[0]] } })
  assert.equal(unthrown[1].attemptedBase, undefined)
})

test('runner resolution rejects stale slots, duplicate bases and absent measurements', () => {
  const entry = { id: 'first', origin: 'first', characterName: 'Mario' }
  assert.equal(runnerDestinationsFromPlay({ entries: [entry], play: { runners: { R1: { character: 'Mario', batting_index: -1, bases_ran: 3 } } } }), null)
  assert.equal(runnerAdvancedOnPlay({ runnersBefore: { first: 'Mario' }, play: { runners: { R1: { character: 'Mario', bases_ran: null } } } }), null)
  assert.equal(runnerDestinationsFromPlay({ entries: [entry, { id: 'second', origin: 'second', characterName: 'Luigi' }], play: { runners: { R1: { character: 'Mario', bases_ran: 3 }, R2: { character: 'Luigi', bases_ran: 3 } } } }), null)
})

import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPitch,
  applyTrackerPreviewPlay,
  classifyPitchMovement,
  clearTrackerPreviewAtBats,
  compactTrackerPitchDiagnostics,
  createTrackerPreviewState,
  finalizeTrackerPreviewSession,
  parseTrackerPitchProvisionalMessage,
  recordTrackerPreviewWrite,
  setTrackerPreviewGameContext,
  setTrackerPreviewDetectedStadium,
  setTrackerPreviewStadiumOverride,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'
import { linesForPlay } from '../scripts/tracker_replay_preview.mjs'
import { FEET_PER_UNIT } from '../src/utils/parkGeometry.js'
import { positionAt } from '../scripts/ball_flight_model.mjs'
import { fieldingEvent, throwRecord, trackingPlay } from './helpers/trackerFixtures.mjs'

// Exit velocity is stored on the canonical metre scale. This fixture is a pre-2026-08-14
// record carrying no feet_per_unit, so it was produced on the old locked 3.0
// scale and is converted on read — see normalizeTrackerExitVelocity.
const onCanonicalScale = (mph) => mph * (FEET_PER_UNIT / 3)

const grounder = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=King K. Rool|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=-0.8|spray_degrees=-14.6|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=4786|x=-5.77596045|y=0.2675789|z=-22.8378239|distance_feet=76.6'
const ordinaryPitch = '[TRACKER_PITCH_PROVISIONAL] version=1|status=measured|pitch_type=unresolved|terminal=count_change|pitch_counter=1|pitcher=Mario|batter=Luigi|is_star_pitch=false|game_state_start=BATTING|count_before=0-0|count_after=0-1|start_reason=pitch_counter_increment+forward_z|start_seq=10|end_seq=12|start_time_ns=1000000000|end_time_ns=1469000000|start_x=-0.3|start_y=2.0|start_z=-17.5|end_x=0.1|end_y=1.2|end_z=-1.0|sample_count=3|elapsed_seconds=0.469000|path_distance_units=16.55|path_distance_feet=49.650|direct_distance_units=16.524|speed_mph=72.1|horizontal_delta_units=0.4|vertical_delta_units=-0.8|forward_delta_units=16.5|horizontal_range_units=0.4|vertical_range_units=0.8|horizontal_chord_deviation_units=-0.06|vertical_chord_deviation_units=0.12|feet_per_unit=3|timing_source=perf_counter_ns|samples_format=seq,time_ns,x,y,z|samples=10,1000000000,-0.3,2,-17.5;11,1234500000,-0.16,1.65,-9.1;12,1469000000,0.1,1.2,-1'

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
  assert.equal(snapshot.display_at_bat.hit_distance_ft, 75)
  assert.equal(snapshot.display_at_bat.hit_stadium_key, 'mario_stadium')
  assert.equal(snapshot.display_at_bat.hit_notation, 'G6-3')
  assert.deepEqual(snapshot.display_at_bat.pitches.map((pitch) => pitch.result), ['strike_unknown', 'in_play'])
})

test('a relief pitcher entering mid-count does not open a second plate appearance', () => {
  // 2026-08-31 Daisy Cruiser, fifth inning: Boo faced Waluigi, Waluigi fouled
  // one off at 0-1, Red Toad came in, and the tracker reprinted the banner.
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    'Boo vs. Waluigi',
    'Count: 0-0',
    'Foul ball!',
    'Count: 0-1',
    'Red Toad vs. Waluigi',
    'Fair ball!',
    'Waluigi recorded a single!',
  ])

  assert.equal(snapshot.at_bat_count, 1)
  const atBat = snapshot.display_at_bat
  assert.equal(atBat.batter_name, 'Waluigi')
  // The pitcher who finished it, which is who the executable names on the
  // batted ball, with the one they replaced kept beside them.
  assert.equal(atBat.pitcher_name, 'Red Toad')
  assert.deepEqual(atBat.pitchers_faced, ['Boo', 'Red Toad'])
  assert.equal(atBat.result, '1B')
  assert.deepEqual(atBat.pitches.map((pitch) => pitch.result), ['foul', 'in_play'])
})

test('a new batter after a completed plate appearance still opens a new one', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    'Boo vs. Waluigi',
    'Count: 0-0',
    'Fair ball!',
    'Waluigi recorded a single!',
    'Boo vs. Wario',
    'Count: 0-0',
  ])
  // The finished one is retained and the new batter is current, rather than
  // both landing on a single plate appearance.
  assert.deepEqual(snapshot.at_bats.map((atBat) => atBat.batter_name), ['Waluigi'])
  assert.equal(snapshot.last_completed_at_bat.batter_name, 'Waluigi')
  assert.equal(snapshot.current_at_bat.batter_name, 'Wario')
})

test('a missed star swing does not turn a later ordinary home run into a star hit', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Wario vs. Fire Bro.',
    'Count: 0-0',
    'Strike 1.',
    'Fire Bro. used a star swing!',
    'Count: 0-1',
    'Fair ball!',
    'Fire Bro. hits a home run off of Wario!',
  ])
  const pa = snapshot.display_at_bat
  assert.equal(pa.result, 'HR')
  assert.equal(pa.star_hit_used, true)
  assert.equal(pa.star_hit_connected, false)
  assert.deepEqual(pa.pitches.map((pitch) => pitch.is_star_swing), [true, false])
  assert.match(snapshot.interpretation.sentences.join(' '), /deciding pitch was not a star swing/)
})

test('a star-swing announcement after the strikeout line attaches to strike three', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Wario vs. Bowser Jr.',
    'Count: 0-0',
    'Strike 1.',
    'Count: 0-1',
    'Strike 2.',
    'Count: 0-2',
    'Strike 3.',
    'Wario struck out Bowser Jr.!',
    'Bowser Jr. used a star swing!',
  ])
  const pa = snapshot.display_at_bat
  assert.equal(pa.result, 'K')
  assert.equal(pa.pitches.at(-1).is_star_swing, true)
  assert.match(snapshot.interpretation.sentences.join(' '), /on strike three and missed/)
})

test('the latest completed card is reserialized after a joined play vetoes an error', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Wario vs. Mario',
    'Count: 0-0',
    'Fair ball!',
    'Birdo bobbled the ball!',
    'Mario recorded a triple!',
    'Wario vs. Luigi',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Mario',
    batted_ball_class: 'fair_in_play',
    fielders: { CF: { character: 'Birdo' } },
    fielding_events: [fieldingEvent({
      by: 'CF', character: 'Birdo', ball_contact: 'confirmed', secured: false,
      mechanic: 'star_ball', action_code: 4,
    })],
    primary_fielder: 'CF',
    primary_fielder_reason: 'forced_misplay',
  }))
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.display_at_bat.batter_name, 'Mario')
  assert.equal(snapshot.display_at_bat.result, '3B')
  assert.equal(snapshot.display_at_bat.is_error, false)
  assert.equal(snapshot.display_at_bat.error_vetoed_reason, 'star_ball')
})

test('an announced bobble with measured no contact is discarded as a false signal', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Wario vs. Mario',
    'Count: 0-0',
    'Fair ball!',
    'Dry Bones bobbled the ball!',
    'Mario recorded a single!',
    'Wario vs. Luigi',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Mario',
    batted_ball_class: 'fair_in_play',
    fielders: { SS: { character: 'Dry Bones' } },
    fielding_events: [fieldingEvent({
      by: 'SS', character: 'Dry Bones', ball_contact: 'missed', secured: false,
      contact_source: 'action_without_contact_actor',
    })],
    primary_fielder: 'SS',
    primary_fielder_reason: 'closest_attempt',
  }))
  const snapshot = trackerPreviewSnapshot(state)
  const atBat = snapshot.display_at_bat
  assert.equal(atBat.result, '1B')
  assert.equal(atBat.is_error, false)
  assert.equal(atBat.error_vetoed_reason, null)
  assert.equal(atBat.fielding_events.bobble, null)
  assert.equal(atBat.fielding_events.bobble_signal_discarded, 'Dry Bones')
  assert.equal(atBat.fielding_events.bobble_signal_discarded_reason, 'no_contact')
  assert.equal(snapshot.warnings.some((warning) => warning.id === 'bobble-without-contact'), false)
  assert.doesNotMatch(snapshot.interpretation.sentences.join(' '), /reported a bobble/)
})

test('the captured touch-and-throw chain supplies complete relay notation', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Wario vs. Red Pianta',
    'Count: 0-0',
    'Fair ball!',
    'Purple Toad put Red Pianta out!',
    'Wario vs. Luigi',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Red Pianta',
    batted_ball_class: 'fair_in_play',
    fielding_events: [
      fieldingEvent({ by: 'RF', character: 'Luigi', ball_contact: 'confirmed', secured: true }),
      fieldingEvent({ by: '2B', character: 'Yellow Yoshi', ball_contact: 'confirmed', secured: true, frame: 1120 }),
    ],
    throws: [
      throwRecord({ thrower_position: 'RF', receiver_position: '2B', outs_recorded: 0 }),
      throwRecord({ sequence: 2, thrower_position: '2B', receiver_position: 'P', outs_recorded: 1, arrival_frame: 1400 }),
    ],
  }))
  assert.equal(trackerPreviewSnapshot(state).display_at_bat.hit_notation, 'G9-4-1')
})

test('a measured throwing error is charged to the thrower and leaves the hit alone', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Wario vs. Luigi',
    'Count: 0-0',
    'Fair ball!',
    'Luigi recorded a single!',
    'Wario vs. Mario',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Luigi',
    batted_ball_class: 'fair_in_play',
    fielders: { SS: { character: 'Blue Yoshi' }, '3B': { character: 'Gray Shy Guy' } },
    fielding_events: [fieldingEvent({ by: 'SS', character: 'Blue Yoshi', ball_contact: 'confirmed', secured: true })],
    throws: [throwRecord({
      sequence: 1, thrower_position: 'SS', thrower_character: 'Blue Yoshi',
      receiver_position: '3B', receiver_character: 'Gray Shy Guy',
      target_base: 'third', intended_target_position: '3B', outs_recorded: 0,
      receiver_pulled_off_base: true, receiver_distance_from_target_units: 3.0,
      throwing_error_candidate: true,
      runner_at_arrival: { character: 'Purple Toad', distance_from_target_units: 1.9, closing_units: 4.6 },
    })],
  }))
  const atBat = trackerPreviewSnapshot(state).display_at_bat
  // The batter's hit is untouched: a throwing error that advanced a RUNNER is
  // not a reached-on-error.
  assert.equal(atBat.result, '1B')
  assert.equal(atBat.hit_notation, null)
  assert.equal(atBat.is_error, true)
  assert.equal(atBat.error_kind, 'throwing')
  assert.equal(atBat.error_character, 'Blue Yoshi')
  assert.equal(atBat.error_position, 6)
  assert.equal(atBat.error_notation, 'G6-E6')
})

test('a lost close play on a lead runner re-scores a logged single as a safe fielder choice', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Bowser vs. Luigi',
    'Count: 0-0',
    'Fair ball!',
    'Luigi recorded a single!',
    'Bowser vs. Mario',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Luigi',
    batted_ball_class: 'fair_in_play',
    runners: {
      BAT: { character: 'Luigi', batting_index: 0, bases_ran: 1 },
      R2: { character: 'Yoshi', batting_index: 4, bases_ran: 1 },
    },
    fielders: { SS: { character: 'Bowser' }, '3B': { character: 'Blooper' } },
    fielding_events: [fieldingEvent({
      event_type: 'possession', by: 'SS', character: 'Bowser',
      ball_contact: 'confirmed', secured: true,
    })],
    throws: [throwRecord({
      thrower_position: 'SS', thrower_character: 'Bowser',
      receiver_position: '3B', receiver_character: 'Blooper',
      target_base: 'third', outs_recorded: 0,
      runner_at_arrival: { runner: 'R2', character: 'Yoshi', margin_s: 0.2 },
    })],
    close_plays: [{ by: '3B', character: 'Blooper', won_by: 'runner', flag_value: 2 }],
  }))
  const atBat = trackerPreviewSnapshot(state).display_at_bat
  assert.equal(atBat.result, 'FC')
  assert.equal(atBat.outs_on_play, 0)
  assert.equal(atBat.fielder_choice_out, true)
})

test('a runner knocking the ball loose is never charged as a throwing error', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Wario vs. Bowser Jr.',
    'Count: 0-0',
    'Fair ball!',
    'Bowser Jr. recorded a triple!',
    'Wario vs. Mario',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Bowser Jr.',
    batted_ball_class: 'fair_in_play',
    fielders: { '3B': { character: 'Gray Shy Guy' }, P: { character: 'Green Magikoopa' } },
    throws: [throwRecord({
      sequence: 2, is_throw: false, event_type: 'loose_ball_recovery',
      thrower_position: '3B', thrower_character: 'Gray Shy Guy',
      receiver_position: 'P', receiver_character: 'Green Magikoopa',
      caused_by_runner_contact: true, runner_contact: { character: 'Bowser Jr.' },
    })],
  }))
  const atBat = trackerPreviewSnapshot(state).display_at_bat
  assert.equal(atBat.is_error, false)
  assert.equal(atBat.error_kind, null)
  assert.equal(atBat.error_notation, null)
})

// A putout says the batter was RETIRED, not where. A batter who reaches first
// and is thrown out stretching for second is credited with the hit and an out
// on the bases, and the game announces both -- putout first, "recorded a
// single!" after. Latching the groundout and refusing the announcement turned
// every one of those into a groundout on a fly ball the outfield let land.
test('an announced hit outranks the groundout inferred from a putout on the batter', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    '[TRACKER_LINEUP] team=Mario Fireballs|batting=Green Paratroopa,Mario,Luigi,Yoshi,Peach,Daisy,Wario,Waluigi,Bowser|fielding=P=Green Paratroopa,C=Mario,1B=Luigi,2B=Yoshi,3B=Peach,SS=Daisy,LF=Wario,CF=Waluigi,RF=Bowser',
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    'Fair ball fielded!',
    'Yoshi put King K. Rool out!',
    'Waluigi recorded an assist!',
    'King K. Rool recorded a single!',
  ])
  const pa = snapshot.display_at_bat
  assert.equal(pa.result, '1B')
  // The out is still on the play, and it is still the batter's.
  assert.equal(pa.outs_on_play, 1)
  assert.equal(pa.is_official_ab, true)
  assert.equal(pa.runner_assignments.find((entry) => entry.isBatter).destination, 'out')
})

test('a groundout with no hit announcement is still a groundout', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    'Yoshi put King K. Rool out!',
  ])
  assert.equal(snapshot.display_at_bat.result, 'GO')
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

test('the explicit walked line records ball four and resolves the plate appearance', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Green Noki vs. Luigi',
    'Count: 0-0',
    'Count: 1-0',
    'Count: 2-0',
    'Count: 3-0',
    'Green Noki walked Luigi!',
  ])
  const pa = snapshot.display_at_bat
  assert.equal(pa.result, 'BB')
  assert.equal(pa.is_official_ab, false)
  assert.deepEqual(pa.pitches.at(-1), {
    ...pa.pitches.at(-1),
    result: 'ball',
    count_balls_before: 3,
    count_strikes_before: 0,
    count_balls_after: 4,
    count_strikes_after: 0,
  })
})

test('a complete joined fair play recovers an omitted hit announcement', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Mario vs. Green Shy Guy',
    'Count: 0-0',
    'Fair ball!',
    'Fair ball fielded!',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Green Shy Guy',
    batted_ball_class: 'fair_in_play',
    runners: {
      BAT: { character: 'Green Shy Guy', character_id: 46, batting_index: 0, bases_ran: 1 },
    },
  }))
  assert.equal(trackerPreviewSnapshot(state).display_at_bat.result, '1B')
})

test('a recovered hit still becomes reached on error when an ordinary bobble caused it', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Green Noki vs. Blue Yoshi',
    'Count: 0-0',
    'Fair ball!',
    'Magikoopa bobbled the ball!',
    'Fair ball fielded!',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Blue Yoshi',
    batted_ball_class: 'fair_in_play',
    runners: {
      BAT: { character: 'Blue Yoshi', character_id: 17, batting_index: 0, bases_ran: 2 },
    },
    fielding_events: [fieldingEvent({
      by: '2B', character: 'Magikoopa', ball_contact: 'confirmed', secured: false,
      mechanic: 'ordinary', ball_landed_before_contact: true,
    })],
  }))
  const pa = trackerPreviewSnapshot(state).display_at_bat
  assert.equal(pa.result, 'ROE')
  assert.equal(pa.is_error, true)
  assert.equal(pa.error_character, 'Magikoopa')
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

test('a joined play resolves runner destinations before the next matchup exists', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Mario vs. Luigi',
    'Peach is on first.',
    'Count: 0-0',
    'Fair ball!',
    'Luigi recorded a single!',
  ])
  applyTrackerPreviewPlay(state, {
    contact_timer: 10000,
    inning: 1,
    inning_half: 0,
    outs: 0,
    balls: 0,
    strikes: 0,
    batter: 'Luigi',
    batted_ball_class: 'fair_in_play',
    runners: {
      BAT: { character: 'Luigi', character_id: 2, batting_index: 0, bases_ran: 1 },
      R1: { character: 'Peach', character_id: 3, batting_index: 1, bases_ran: 3 },
    },
  })
  assert.deepEqual(trackerPreviewSnapshot(state).display_at_bat.runner_assignments, [
    { id: 'batter', origin: 'plate', isBatter: true, characterName: 'Luigi', runner: { characterName: 'Luigi' }, destination: 'first' },
    { id: 'first', origin: 'first', isBatter: false, characterName: 'Peach', runner: { characterName: 'Peach' }, destination: 'third' },
  ])
})

test('structured telemetry recovers a missing matchup after HBP without corrupting either PA', () => {
  const state = createTrackerPreviewState()
  const toadettePitch = ordinaryPitch
    .replace('pitcher=Mario', 'pitcher=Baby Peach')
    .replace('batter=Luigi', 'batter=Toadette')
    .replace('terminal=count_change', 'terminal=contact')
    .replace('count_after=0-1', 'count_after=0-0')
  const snapshot = feed(state, [
    'Baby Peach vs. Gray Shy Guy',
    'Count: 0-0',
    'Count: 1-0',
    'Gray Shy Guy was hit by a pitch!',
    // This is the exact malformed transition from the Playroom game: no
    // "Baby Peach vs. Toadette" line, only a reset count and runner snapshot.
    'Count: 0-0',
    'Gray Shy Guy is on first.',
    toadettePitch,
    'Fair ball!',
    'Toadette recorded a single!',
  ])

  assert.deepEqual(snapshot.at_bats.map((pa) => [pa.batter_name, pa.result]), [
    ['Gray Shy Guy', 'HBP'],
    ['Toadette', '1B'],
  ])
  const gray = trackerPreviewSnapshot(state, { selectedPaNumber: 1 }).display_at_bat
  const toadette = trackerPreviewSnapshot(state, { selectedPaNumber: 2 }).display_at_bat
  assert.deepEqual(gray.pitches.map((pitch) => pitch.result), ['ball', 'hbp'])
  assert.deepEqual(toadette.runners_before, { first: 'Gray Shy Guy', second: null, third: null })
  assert.deepEqual(toadette.pitches.map((pitch) => pitch.result), ['in_play'])
})

test('an unchanged count with no pending call is a repeat, not an invented pitch', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Baby Peach vs. Tiny Kong',
    'Count: 0-0',
    'Count: 0-0',
    'Strike 1.',
    'Count: 0-1',
  ])
  assert.deepEqual(snapshot.display_at_bat.pitches.map((pitch) => ({
    result: pitch.result,
    before: `${pitch.count_balls_before}-${pitch.count_strikes_before}`,
    after: `${pitch.count_balls_after}-${pitch.count_strikes_after}`,
  })), [{ result: 'strike_unknown', before: '0-0', after: '0-1' }])
})

function feedThreeAtBats(state) {
  feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    'Luigi was hit by a pitch!',
    'Mario vs. Yoshi',
    'Count: 0-0',
    'Fair ball!',
    'Yoshi recorded a single!',
    'Mario vs. Peach',
    'Count: 0-0',
    'Mario struck out Peach!',
  ])
  return trackerPreviewSnapshot(state)
}

test('every at-bat in the session stays available to page back through', () => {
  const state = createTrackerPreviewState()
  const snapshot = feedThreeAtBats(state)

  assert.equal(snapshot.at_bat_count, 3)
  assert.deepEqual(snapshot.at_bats.map((entry) => [entry.pa_number, entry.batter_name, entry.result]), [
    [1, 'Luigi', 'HBP'],
    [2, 'Yoshi', '1B'],
    [3, 'Peach', 'K'],
  ])
  // Only the live at-bat is flagged current; the earlier two are history.
  assert.deepEqual(snapshot.at_bats.map((entry) => entry.is_current), [false, false, true])
  assert.equal(snapshot.selected_pa_number, 3)
  assert.equal(snapshot.display_at_bat.batter_name, 'Peach')
})

test('selecting an earlier at-bat serializes that at-bat in full, live one keeps running', () => {
  const state = createTrackerPreviewState()
  feedThreeAtBats(state)

  const earlier = trackerPreviewSnapshot(state, { selectedPaNumber: 2 })
  assert.equal(earlier.selected_pa_number, 2)
  assert.equal(earlier.display_at_bat.batter_name, 'Yoshi')
  assert.equal(earlier.display_at_bat.result, '1B')
  assert.equal(earlier.display_at_bat.pitches.length, 1)
  // The live at-bat is unaffected by which one is being displayed.
  assert.equal(earlier.current_at_bat.batter_name, 'Peach')

  // A string comes off the query string; a PA that does not exist falls back to
  // the live at-bat rather than blanking the page.
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: '1' }).display_at_bat.batter_name, 'Luigi')
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: 99 }).display_at_bat.batter_name, 'Peach')
})

test('a stadium change re-projects every retained at-bat, not just the newest', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Luigi put King K. Rool out!',
    'Green Paratroopa vs. Mario',
    'Count: 0-0',
  ])
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: 1 }).display_at_bat.hit_stadium_key, null)

  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  const replayed = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  assert.equal(replayed.display_at_bat.hit_stadium_key, 'mario_stadium')
  assert.equal(Number.isFinite(replayed.display_at_bat.hit_x), true)
  assert.equal(replayed.session_pitch_diagnostics.at_bats[0].batted_ball.hit_x != null, true)
})

test('the session is dropped when the tracker it came from stops', () => {
  const state = createTrackerPreviewState()
  feedThreeAtBats(state)

  feed(state, [
    'Next: Bottom of inning 8',
    '2 outs',
    '[TRACKER_LINEUP] team=Old Session|batting=Mario|fielding=P=Luigi',
  ])
  setTrackerPreviewDetectedStadium(state, 'bowser_castle')

  clearTrackerPreviewAtBats(state)
  const snapshot = trackerPreviewSnapshot(state)
  assert.deepEqual(snapshot.at_bats, [])
  assert.equal(snapshot.at_bat_count, 0)
  assert.equal(snapshot.display_at_bat, null)
  assert.equal(snapshot.last_completed_at_bat, null)
  assert.equal(snapshot.session_pitch_diagnostics.at_bat_count, 0)
  assert.deepEqual(snapshot.situation, {
    inning: 1,
    half: 'top',
    outs: 0,
    batter_name: null,
    pitcher_name: null,
    count: '0-0',
  })
  assert.equal(snapshot.stadium_detected_key, null)
  assert.deepEqual(snapshot.recent_tracker_messages, [])

  // A restarted tracker numbers its at-bats from the top again and does not
  // inherit the old inning, outs, alignment or detected park.
  feed(state, ['Mario vs. Luigi', 'Count: 0-0', 'Luigi was hit by a pitch!'])
  const restarted = trackerPreviewSnapshot(state)
  assert.equal(restarted.display_at_bat.pa_number, 1)
  assert.equal(restarted.display_at_bat.inning, 1)
  assert.equal(restarted.display_at_bat.half, 'top')
  assert.equal(restarted.display_at_bat.outs_before_pa, 0)
  assert.equal(restarted.display_at_bat.fielding_alignment, null)
})

test('ending an input stream closes its last plate appearance exactly once', () => {
  const state = createTrackerPreviewState({ mode: 'archive_replay' })
  feed(state, ['Mario vs. Luigi', 'Count: 0-0', 'Fair ball!', 'Luigi recorded a single!'])

  assert.equal(trackerPreviewSnapshot(state).current_at_bat.result, '1B')
  assert.equal(finalizeTrackerPreviewSession(state), true)
  assert.equal(finalizeTrackerPreviewSession(state), false)

  const ended = trackerPreviewSnapshot(state)
  assert.equal(ended.current_at_bat, null)
  assert.equal(ended.at_bat_count, 1)
  assert.equal(ended.at_bats[0].is_current, false)
  assert.equal(ended.last_completed_at_bat.result, '1B')
})

test('measured counts prevent a reconstructed replay from inventing a join mismatch', () => {
  const state = createTrackerPreviewState({ mode: 'archive_replay' })
  feed(state, ['Mario vs. Luigi', 'Count: 0-0', 'Fair ball!', 'Luigi recorded a single!'])
  applyTrackerPreviewPlay(state, trackingPlay({
    contact_timer: 200,
    inning: 1,
    inning_half: 0,
    outs: 0,
    batter: 'Luigi',
    balls: 0,
    strikes: 1,
  }))
  assert.equal(trackerPreviewSnapshot(state).capture.join_tally.mismatch, 1)

  applyTrackerPreviewPitch(state, {
    pitch_timer: 150,
    inning: 1,
    inning_half: 0,
    outs: 0,
    batter: 'Luigi',
    pitcher: 'Mario',
    pitch_in_pa: 1,
    balls_before: 0,
    strikes_before: 0,
    balls_after: 0,
    strikes_after: 1,
    outcome: 'strike',
  })
  const joined = trackerPreviewSnapshot(state)
  assert.equal(joined.capture.join_tally.mismatch, 0)
  assert.equal(joined.capture.join_tally.joined, 1)
})

test('replay log reconstruction preserves missing flight measurements as missing', () => {
  const play = trackingPlay({
    live_s: null,
    hang_time_s: null,
    caught_in_flight: false,
    landing: { frame: 150, at: [1, 0, -10] },
  })
  const batted = linesForPlay(play, null, [play])
    .find((line) => line.startsWith('[TRACKER_BATTED_BALL_PROVISIONAL]'))

  assert.match(batted, /\|flight_updates=none(?:\||$)/)
  assert.match(batted, /\|sampled_updates_seconds=none(?:\||$)/)
  assert.match(batted, /\|hang_time_seconds=none(?:\||$)/)
})

const buntRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=980|batter=Toad|pitcher=Mario|exit_speed_mph=18.4|launch_degrees=3.1|spray_degrees=-8.2|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=996|x=-2.1|y=0.2|z=-9.4|distance_feet=29.1'

test('a bunt that moves a runner over is scored a sacrifice, not a ground out', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    '[TRACKER_LINEUP] team=Mario Fireballs|batting=Mario,Luigi,Peach,Daisy,Yoshi,Wario,Waluigi,Bowser,Toad|fielding=P=Mario,C=Luigi,1B=Peach,2B=Daisy,3B=Yoshi,SS=Wario,LF=Waluigi,CF=Bowser,RF=Toad',
    'Mario vs. Toad',
    'Luigi is on first.',
    'Count: 0-0',
    'Fair ball!',
    buntRecord,
    'Peach put Toad out!',
  ])
  const pa = snapshot.display_at_bat
  assert.equal(pa.result, 'SH')
  assert.equal(pa.is_bunt, true)
  assert.equal(pa.trajectory, 'B')
  // A sacrifice is not an official at-bat, which is the stat consequence that
  // makes the classification matter.
  assert.equal(pa.is_official_ab, false)
  assert.equal(pa.hit_notation, 'B3')
})

test('a bunt with the bases empty stays an ordinary ground out, still flagged as a bunt', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Toad',
    'Count: 0-0',
    'Fair ball!',
    buntRecord,
    'Peach put Toad out!',
  ])
  assert.equal(snapshot.display_at_bat.result, 'GO')
  assert.equal(snapshot.display_at_bat.is_bunt, true)
  assert.equal(snapshot.display_at_bat.trajectory, 'B')
  assert.equal(snapshot.display_at_bat.is_official_ab, true)
})

test('a bunt the batter beats out is a hit, not a sacrifice', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Toad',
    'Luigi is on first.',
    'Count: 0-0',
    'Fair ball!',
    buntRecord,
    'Toad recorded a single!',
  ])
  assert.equal(snapshot.display_at_bat.result, '1B')
  assert.equal(snapshot.display_at_bat.is_bunt, true)
})

test('a batted-ball record that arrives after the next matchup line still lands on the batter it belongs to', () => {
  const state = createTrackerPreviewState()
  const unresolvedHomer = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=2401|batter=Wiggler|pitcher=Mario|exit_speed_mph=97.7|launch_degrees=36.4|spray_degrees=-26.9|side=third_base|endpoint=unresolved|endpoint_status=landing_timeout|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=none'
  feed(state, [
    'Mario vs. Wiggler',
    'Count: 0-0',
    'Fair ball!',
    'Wiggler hits a homer off of Mario!',
    // The next batter's matchup line — and even a full pitch to them — beats
    // the flight-timeout flush across the wire in practice.
    'Mario vs. Shy Guy',
    'Count: 0-0',
  ])
  const snapshot = feed(state, [unresolvedHomer])
  assert.equal(snapshot.last_completed_at_bat.batter_name, 'Wiggler')
  assert.equal(snapshot.last_completed_at_bat.exit_velocity_mph, onCanonicalScale(97.7))
  assert.equal(snapshot.last_completed_at_bat.launch_angle_deg, 36.4)
  assert.equal(snapshot.last_completed_at_bat.hit_distance_ft > 0, true)
  // The now-current batter (Shy Guy) must not have absorbed Wiggler's data.
  assert.equal(snapshot.current_at_bat.batter_name, 'Shy Guy')
  assert.equal(snapshot.current_at_bat.exit_velocity_mph, undefined)
})

test('pitch diagnostics attach raw XYZ evidence without guessing an ordinary pitch type', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    ordinaryPitch,
    'Strike 1.',
    'Count: 0-1',
  ])
  const pitch = snapshot.display_at_bat.pitches[0]
  assert.equal(pitch.pitch_type, null)
  assert.equal(pitch.pitch_speed_mph, 72.1)
  assert.equal(pitch.is_star_pitch, false)
  assert.equal(pitch.pitch_telemetry.horizontalChordDeviationUnits, -0.06)
  assert.equal(pitch.pitch_telemetry.verticalChordDeviationUnits, 0.12)
  assert.deepEqual(pitch.pitch_telemetry.samples[1], {
    seq: 11, time_ns: 1234500000, x: -0.16, y: 1.65, z: -9.1,
  })
})

test('the provisional pitch parser keeps star status separate from pitch type', () => {
  const record = parseTrackerPitchProvisionalMessage(ordinaryPitch.replace('is_star_pitch=false', 'is_star_pitch=true'))
  assert.equal(record.isStarPitch, true)
  assert.equal(record.pitchType, null)
  assert.equal(record.speedMph, 72.1)
})

test('movement classifier separates both curve directions and excludes star pitches', () => {
  const base = { sampleCount: 49, directDistanceUnits: 20, isStarPitch: false }
  assert.equal(classifyPitchMovement({
    ...base, horizontalChordDeviationUnits: -0.01, verticalChordDeviationUnits: 0.03,
  }), 'fastball')
  assert.equal(classifyPitchMovement({
    ...base, horizontalChordDeviationUnits: -0.254, verticalChordDeviationUnits: 0.013,
  }), 'curveball')
  assert.equal(classifyPitchMovement({
    ...base, horizontalChordDeviationUnits: 0.809, verticalChordDeviationUnits: 0.102,
  }), 'curveball')
  assert.equal(classifyPitchMovement({
    ...base, horizontalChordDeviationUnits: -0.081, verticalChordDeviationUnits: 3.389,
  }), 'changeup')
  assert.equal(classifyPitchMovement({
    ...base, isStarPitch: true, horizontalChordDeviationUnits: 2, verticalChordDeviationUnits: 3,
  }), null)
  assert.equal(classifyPitchMovement({
    ...base, sampleCount: 10, horizontalChordDeviationUnits: 2, verticalChordDeviationUnits: 3,
  }), null)
})

test('a break to both sides of the chord is a knuckleball, not a curveball', () => {
  // Measured in bowser_castle-20260904T011909Z: Toadsworth and Goomba are slow
  // enough to steer a pitch out and back, and the reversal shows as chord
  // deviation on both sides. A one-way curve reaches the same peak on one side
  // and stays there.
  const base = { sampleCount: 143, directDistanceUnits: 20.5, isStarPitch: false }
  assert.equal(classifyPitchMovement({
    ...base,
    horizontalChordDeviationUnits: 0.344,
    horizontalChordDeviationMaxUnits: 0.344,
    horizontalChordDeviationMinUnits: -0.187,
    verticalChordDeviationUnits: 0.01,
  }), 'knuckleball')
  assert.equal(classifyPitchMovement({
    ...base,
    horizontalChordDeviationUnits: 0.308,
    horizontalChordDeviationMaxUnits: 0.308,
    horizontalChordDeviationMinUnits: -0.072,
    verticalChordDeviationUnits: 0.049,
  }), 'curveball')
  // Sessions recorded before the collector reported the two extremes carry
  // neither field; those pitches classify exactly as they did before.
  assert.equal(classifyPitchMovement({
    ...base, horizontalChordDeviationUnits: 0.344, verticalChordDeviationUnits: 0.01,
  }), 'curveball')
})

test('a steep changeup with low forward travel still clears the flight-completeness gate on 3D distance', () => {
  // horizontal 3.39, vertical -5.38, forward 10.56 -> forward alone is under 12,
  // but the true 3D straight-line distance is about 12.3, matching a real high-arcing changeup.
  assert.equal(classifyPitchMovement({
    sampleCount: 120,
    directDistanceUnits: 12.32,
    isStarPitch: false,
    horizontalChordDeviationUnits: -1.486,
    verticalChordDeviationUnits: -2.042,
  }), 'changeup')
  assert.equal(classifyPitchMovement({
    sampleCount: 120,
    directDistanceUnits: 11.9,
    isStarPitch: false,
    horizontalChordDeviationUnits: -1.486,
    verticalChordDeviationUnits: -2.042,
  }), null)
})

test('strike three retains the terminal pitch when the tracker omits a final count line', () => {
  const state = createTrackerPreviewState()
  const changeupPitch = ordinaryPitch
    .replace('pitch_type=unresolved', 'pitch_type=changeup|classifier=movement_v1|classifier_status=classified')
    .replace('count_before=0-0|count_after=0-1', 'count_before=1-2|count_after=1-3')
    .replace('sample_count=3', 'sample_count=120')
    .replace('forward_delta_units=16.5', 'forward_delta_units=19.4')
    .replace('vertical_chord_deviation_units=0.12', 'vertical_chord_deviation_units=3.389')
  const snapshot = feed(state, [
    'Mario vs. Luigi',
    'Count: 1-2',
    changeupPitch,
    'Strike 3.',
    'Mario struck out Luigi!',
  ])

  assert.equal(snapshot.display_at_bat.result, 'K')
  assert.equal(snapshot.display_at_bat.pitches.length, 1)
  assert.equal(snapshot.display_at_bat.pitches[0].pitch_type, 'changeup')
  assert.equal(snapshot.display_at_bat.pitches[0].count_strikes_after, 3)

  const diagnostics = compactTrackerPitchDiagnostics(snapshot.display_at_bat)
  assert.equal(diagnostics.pitches[0].pitch_type, 'changeup')
  assert.equal(diagnostics.pitches[0].vertical_chord_deviation_units, 3.389)
  assert.equal(JSON.stringify(diagnostics).includes('"samples":'), false)
  assert.equal(Object.hasOwn(diagnostics.pitches[0], 'samples'), false)
})

test('session diagnostics retain compact pitches across multiple at-bats', () => {
  const state = createTrackerPreviewState()
  const secondPitch = ordinaryPitch
    .replace('batter=Luigi', 'batter=Peach')
    .replace('pitch_type=unresolved', 'pitch_type=curveball|classifier=movement_v1|classifier_status=classified')
  const snapshot = feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    ordinaryPitch,
    'Strike 1.',
    'Count: 0-1',
    'Mario vs. Peach',
    'Count: 0-0',
    secondPitch,
    'Strike 1.',
    'Count: 0-1',
    'Mario vs. Daisy',
  ])

  assert.equal(snapshot.session_pitch_diagnostics.at_bat_count, 2)
  assert.equal(snapshot.session_pitch_diagnostics.pitch_count, 2)
  assert.deepEqual(
    snapshot.session_pitch_diagnostics.at_bats.map((pa) => pa.batter_name),
    ['Luigi', 'Peach'],
  )
  assert.equal(snapshot.session_pitch_diagnostics.at_bats[1].pitches[0].pitch_type, 'curveball')
  assert.equal(JSON.stringify(snapshot.session_pitch_diagnostics).includes('"samples":'), false)
})

const noTouchHomeRun = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=903|batter=Brown Kritter|pitcher=Bowser|exit_speed_mph=98.4|launch_degrees=38.9|spray_degrees=-14.6|side=third_base|endpoint=unresolved|endpoint_status=tracking_stalled+extrapolated_from_last_frame|endpoint_seq=none|x=none|y=none|z=none|distance_feet=309.5|hang_time_seconds=5.100'

test('preview consumes ball samples and uses the trajectory for an unresolved hit', () => {
  const state = createTrackerPreviewState()
  const launch = { x: 0, y: 2.5, z: -1, vx: 5, vy: 42, vz: -55 }
  const samples = []
  for (let index = 0; index < 62; index += 1) {
    const t = index / 60.5
    const point = positionAt(launch, t)
    samples.push(`[TRACKER_BALL_SAMPLE] phase=post_contact|seq=${903 + index}`
      + `|time_ns=${Math.round(t * 1e9)}|x=${point.x}|y=${point.y}|z=${point.z}`)
  }
  feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    'Bowser vs. Brown Kritter',
    ...samples,
    noTouchHomeRun,
  ])
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.display_at_bat.preview_projection.plot_source, 'trajectory_projection')
  assert.equal(snapshot.display_at_bat.preview_projection.distance_source, 'trajectory_projection')
  assert.equal(snapshot.display_at_bat.hit_position_estimated, true)
  assert.equal(snapshot.at_bats[0].hit_reveal_occluded_landing, true)
  assert.ok(snapshot.recent_tracker_messages.every((line) => !line.includes('TRACKER_BALL_SAMPLE')))
})

test('a measured wall contact keeps the same chart placement when HR scoring arrives', () => {
  const state = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(state, 'bowser_castle')
  const samples = [
    [856, 10675202056900, -51.345295, 10.5176916, -81.2647476],
    [857, 10675220008000, -51.4258766, 10.2152405, -81.2882538],
    [858, 10675236317900, -51.5063477, 9.9120121, -81.3113403],
    [859, 10675252639600, -51.5867119, 9.60801125, -81.3340149],
    [860, 10675268924500, -51.6669693, 9.30324078, -81.3562775],
    [861, 10675285409000, -51.7471199, 8.99770355, -81.3781357],
    [862, 10675302324400, -51.7857208, 9.10499859, -81.3884811],
  ].map(([seq, time, x, y, z]) => (
    `[TRACKER_BALL_SAMPLE] phase=raw|seq=${seq}|time_ns=${time}|x=${x}|y=${y}|z=${z}`
  ))
  const contact = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=450|batter=Wiggler|pitcher=Bowser|exit_speed_mph=108.0|launch_degrees=47.6|spray_degrees=-22.2|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=861|x=-51.7471199|y=8.99770355|z=-81.3781357|distance_feet=313.7|projected_x=none|projected_z=none|flight_updates=411|sampled_updates_seconds=6.857|hang_time_seconds=7.272|feet_per_unit=3.2808'

  feed(state, ['Bowser vs. Wiggler', ...samples, contact])
  const before = trackerPreviewSnapshot(state).at_bats[0]
  assert.equal(before.result, null)
  assert.equal(before.hit_reveal_occluded_landing, false)

  applyTrackerPreviewMessage(state, 'Wiggler hits a homer off of Bowser!')
  const after = trackerPreviewSnapshot(state).at_bats[0]
  assert.equal(after.result, 'HR')
  assert.equal(after.hit_reveal_occluded_landing, false)
  assert.equal(after.hit_world_x, before.hit_world_x)
  assert.equal(after.hit_world_y, before.hit_world_y)
  assert.equal(after.hit_world_z, before.hit_world_z)
})

test('a measured Playroom raised impact is kept at contact near the Thwomps', () => {
  const state = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(state, 'bowser_jr_playroom')
  const samples = [
    [1036, 11054340911100, -54.9415703, 6.92397785, -76.5660782],
    [1037, 11054358000700, -55.0218773, 6.61999893, -76.5877304],
    [1038, 11054375527300, -55.1018105, 6.31525373, -76.60923],
    [1039, 11054391780300, -55.1188202, 6.50501537, -76.6138],
  ].map(([seq, time, x, y, z]) => (
    `[TRACKER_BALL_SAMPLE] phase=raw|seq=${seq}|time_ns=${time}|x=${x}|y=${y}|z=${z}`
  ))
  const contact = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=630|batter=Red Kritter|pitcher=Bowser|exit_speed_mph=107.5|launch_degrees=46.9|spray_degrees=-24.1|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=1038|x=-55.1018105|y=6.31525373|z=-76.60923|distance_feet=307.3|projected_x=none|projected_z=none|flight_updates=408|sampled_updates_seconds=6.807|hang_time_seconds=8.376|feet_per_unit=3.2808'

  feed(state, ['Bowser vs. Red Kritter', ...samples, contact])
  const snapshot = trackerPreviewSnapshot(state)
  const hit = snapshot.at_bats[0]
  assert.equal(hit.hit_reveal_occluded_landing, false)
  assert.equal(hit.hit_world_x, -55.1018105)
  assert.equal(hit.hit_world_y, 6.31525373)
  assert.equal(hit.hit_world_z, -76.60923)
  assert.equal(snapshot.display_at_bat.hit_x, 18.6)
  assert.equal(snapshot.display_at_bat.hit_y, 33.8)
})

test('a hand-picked stadium projects a field location the tracker never named one for', () => {
  const state = createTrackerPreviewState()
  // No "@ Stadium" in the matchup line, which is the common case.
  feed(state, ['Bowser vs. Brown Kritter', 'Count: 0-0', noTouchHomeRun])
  assert.equal(trackerPreviewSnapshot(state).display_at_bat.hit_stadium_key, null)

  assert.equal(setTrackerPreviewStadiumOverride(state, 'mario_stadium'), true)
  const pa = trackerPreviewSnapshot(state).display_at_bat
  assert.equal(pa.hit_stadium_key, 'mario_stadium')
  assert.ok(Number.isFinite(pa.hit_x) && Number.isFinite(pa.hit_y))
  // Pulled to third base, so left of the home-plate x for this park.
  assert.ok(pa.hit_x < 50)
})

test('an unknown stadium key is refused instead of blanking the geometry', () => {
  const state = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  assert.equal(setTrackerPreviewStadiumOverride(state, 'not_a_real_park'), false)
  assert.equal(trackerPreviewSnapshot(state).stadium_key, 'mario_stadium')
})

test('a hand-picked stadium outranks one the tracker detects later, until reset', () => {
  const state = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(state, 'peach_ice_garden')
  applyTrackerPreviewMessage(state, 'Mario vs. Luigi @ Bowser Castle')
  const overridden = trackerPreviewSnapshot(state)
  assert.equal(overridden.stadium_detected_key, 'bowser_castle')
  assert.equal(overridden.stadium_key, 'peach_ice_garden')

  setTrackerPreviewStadiumOverride(state, null)
  assert.equal(trackerPreviewSnapshot(state).stadium_key, 'bowser_castle')
})

test('an already-completed at-bat re-projects when the stadium changes', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'King K. Rool recorded a single!',
    'Green Paratroopa vs. Luigi',
  ])

  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  const first = trackerPreviewSnapshot(state).display_at_bat
  setTrackerPreviewStadiumOverride(state, 'daisy_cruiser')
  const second = trackerPreviewSnapshot(state).display_at_bat

  assert.equal(first.result, '1B')
  assert.ok(first.hit_x !== second.hit_x || first.hit_y !== second.hit_y)
})

test('the plotted location reports which model produced its distance', () => {
  const projected = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(projected, 'mario_stadium')
  feed(projected, ['Bowser vs. Brown Kritter', 'Count: 0-0', noTouchHomeRun])
  const projectedPa = trackerPreviewSnapshot(projected).display_at_bat
  assert.equal(projectedPa.preview_projection.distance_source, 'physics_from_exit_velocity')
  assert.equal(projectedPa.preview_projection.is_projected, true)
  assert.ok(projectedPa.preview_projection.plotted_distance_ft > 0)

  const measured = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(measured, 'mario_stadium')
  feed(measured, ['Green Paratroopa vs. King K. Rool', 'Count: 0-0', 'Fair ball!', grounder])
  const measuredPa = trackerPreviewSnapshot(measured).display_at_bat
  assert.equal(measuredPa.preview_projection.distance_source, 'tracked_endpoint')
  assert.equal(measuredPa.preview_projection.is_projected, false)
  // The real-gravity model is kept alongside the measurement so the gap
  // between them stays visible; it must never replace the tracked distance.
  assert.equal(measuredPa.hit_distance_ft, 75)
  assert.ok(Number.isFinite(measuredPa.preview_projection.physics_distance_ft))
  assert.equal(
    measuredPa.preview_projection.physics_vs_plotted_distance_ft,
    Math.round((measuredPa.preview_projection.physics_distance_ft - 75) * 10) / 10,
  )
})

test('a batted ball with no stadium still reports its projection, just unplotted', () => {
  const state = createTrackerPreviewState()
  feed(state, ['Bowser vs. Brown Kritter', 'Count: 0-0', noTouchHomeRun])
  const projection = trackerPreviewSnapshot(state).display_at_bat.preview_projection
  assert.equal(projection.stadium_key, null)
  assert.equal(projection.plotted_x, null)
  assert.equal(projection.distance_source, 'physics_from_exit_velocity')
  assert.ok(projection.plotted_distance_ft > 0)
})

// ── the same preview run by the live Supabase bridge ────────────────────────
// The bridge serves this identical state machine so a game being recorded can
// be inspected in the detail the read-only preview offers. What the page
// cannot get anywhere else is whether each at-bat actually reached the
// database, so that is carried on the snapshot rather than left in a console.

test('the bridge announces itself as a writing session, the standalone preview does not', () => {
  const preview = trackerPreviewSnapshot(createTrackerPreviewState())
  assert.equal(preview.mode, 'local_preview')
  assert.equal(preview.writes_enabled, false)
  assert.equal(preview.game, null)

  const bridge = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  setTrackerPreviewGameContext(bridge, { game_id: 2706, games_table: 'games', stadium_key: 'mario_stadium' })
  const snapshot = trackerPreviewSnapshot(bridge)
  assert.equal(snapshot.mode, 'live_bridge')
  assert.equal(snapshot.writes_enabled, true)
  assert.equal(snapshot.game.game_id, 2706)
  assert.equal(snapshot.game.games_table, 'games')
})

test('a written at-bat carries its database row onto the at-bat it belongs to', () => {
  const state = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Luigi put King K. Rool out!',
    'Green Paratroopa vs. Mario',
    'Count: 0-0',
    'Ball 1.',
    'Count: 1-0',
  ])
  recordTrackerPreviewWrite(state, 1, {
    status: 'written', result: 'GO', paId: 91234, paNumberDb: 7, pitchRows: 1, runRows: 0,
  })

  const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  assert.equal(snapshot.display_at_bat.pa_number, 1)
  assert.equal(snapshot.display_at_bat.supabase_write.status, 'written')
  assert.equal(snapshot.display_at_bat.supabase_write.pa_id, 91234)
  assert.equal(snapshot.display_at_bat.supabase_write.pa_number_db, 7)
  assert.equal(snapshot.display_at_bat.supabase_write.pitch_rows, 1)
  assert.equal(snapshot.at_bats.find((entry) => entry.pa_number === 1).supabase_write.status, 'written')
  // The at-bat that has not ended yet has nothing to report, which is not the
  // same thing as having been refused.
  assert.equal(snapshot.at_bats.find((entry) => entry.pa_number === 2).supabase_write, null)
})

test('a plate appearance the bridge declined to write says so, with the reason', () => {
  const state = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  feed(state, ['Green Paratroopa vs. King K. Rool', 'Count: 0-0', 'Ball 1.', 'Count: 1-0'])
  recordTrackerPreviewWrite(state, 1, {
    status: 'skipped',
    reason: 'No result could be determined from the tracker log',
  })

  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.display_at_bat.supabase_write.status, 'skipped')
  assert.match(snapshot.display_at_bat.supabase_write.reason, /No result could be determined/)
  assert.equal(snapshot.display_at_bat.supabase_write.pa_id, null)
})

test('an unrecognised write outcome is refused rather than shown as a status the page cannot read', () => {
  const state = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  feed(state, ['Green Paratroopa vs. King K. Rool', 'Count: 0-0', 'Ball 1.', 'Count: 1-0'])
  recordTrackerPreviewWrite(state, 1, { status: 'probably-fine' })
  recordTrackerPreviewWrite(state, null, { status: 'written' })
  assert.equal(trackerPreviewSnapshot(state).display_at_bat.supabase_write, null)
})

test('resetting the session drops write outcomes with the at-bats they described', () => {
  const state = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  feed(state, [
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Luigi put King K. Rool out!',
    'Green Paratroopa vs. Mario',
  ])
  recordTrackerPreviewWrite(state, 1, { status: 'written', paId: 5, paNumberDb: 1 })
  clearTrackerPreviewAtBats(state)

  // PA numbering restarts, so a stale outcome would otherwise be re-attached to
  // the first at-bat of the next attempt — an at-bat with no row behind it.
  feed(state, ['Green Paratroopa vs. King K. Rool', 'Count: 0-0', 'Ball 1.', 'Count: 1-0'])
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.display_at_bat.pa_number, 1)
  assert.equal(snapshot.display_at_bat.supabase_write, null)
})

// The game calls one contact both ways when the ball lands near the line: the
// tracker announces "Fair ball!" off fair_or_foul at the instant of contact,
// stamps its landing and batted-ball records fair, and then announces "Foul
// ball!" a beat later for the same swing. Baby DK's fourth-inning strikeout on
// 2026-08-31 is the case — a phantom fourth pitch, every later pitch's
// telemetry shifted one, and a 67-foot batted ball hung on a K.
test('a "Foul ball!" retracts the in-play pitch a premature "Fair ball!" created', () => {
  const foulOffTheLine = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=12061|batter=Luigi|pitcher=Mario|exit_speed_mph=80.4|launch_degrees=-5.2|spray_degrees=-49.7|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=12074|x=-15.73|y=0.262|z=-14.056|distance_feet=65.8'
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    'Fair ball!',
    foulOffTheLine,
    'Foul ball!',
    'Count: 0-1',
    'Strike 2.',
    'Count: 0-2',
    'Strike 3.',
    'Mario struck out Luigi!',
  ])

  const atBat = snapshot.display_at_bat
  assert.equal(atBat.result, 'K')
  assert.deepEqual(atBat.pitches.map((pitch) => pitch.result), ['foul', 'strike_unknown', 'strike_unknown'])
  assert.deepEqual(
    atBat.pitches.map((pitch) => `${pitch.count_balls_before}-${pitch.count_strikes_before}`),
    ['0-0', '0-1', '0-2'],
  )
  // The measurement described a ball that went out of play, so nothing about it
  // may reach a plate appearance with no ball in play.
  assert.equal(atBat.advanced_batted_ball_raw, null)
  assert.equal(atBat.trajectory, null)
  assert.ok(atBat.exit_velocity_mph == null)
})

// Same correction, opposite arrival order: the batted-ball record can be
// flushed after the foul call rather than before it, and it is still stamped
// fair because the tracker resolved fair_or_foul before the game changed it.
test('a batted-ball record arriving after the foul call is refused too', () => {
  const foulOffTheLine = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=12061|batter=Luigi|pitcher=Mario|exit_speed_mph=80.4|launch_degrees=-5.2|spray_degrees=-49.7|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=12074|x=-15.73|y=0.262|z=-14.056|distance_feet=65.8'
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Luigi',
    'Count: 0-0',
    'Fair ball!',
    'Foul ball!',
    foulOffTheLine,
    'Count: 0-1',
  ])
  assert.equal(snapshot.display_at_bat.advanced_batted_ball_raw, null)
  assert.deepEqual(snapshot.display_at_bat.pitches.map((pitch) => pitch.result), ['foul'])
})

// A genuine fair ball still has to survive the messages that follow it.
test('an ordinary fair ball keeps its in-play pitch and its measurement', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Luigi put King K. Rool out!',
  ])
  const atBat = snapshot.display_at_bat
  assert.deepEqual(atBat.pitches.map((pitch) => pitch.result), ['in_play'])
  assert.ok(atBat.advanced_batted_ball_raw)
})

// OBR 9.04(a)(1): a run that scores because of an error is not a run batted in.
// The GAME announces one anyway and the tracker reads its line; the bridge has
// always re-scored it and the console did not, so the console credited Baby
// Mario an RBI on a two-out boot at second with the run coming from second.
test('an RBI announced on a reached-on-error is not credited', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario Fireballs vs. Bowser Monsters @ Mario Stadium',
    '[TRACKER_LINEUP] team=Mario Fireballs|batting=Green Paratroopa,Mario,Luigi,Yoshi,Peach,Daisy,Wario,Waluigi,Bowser|fielding=P=Green Paratroopa,C=Mario,1B=Luigi,2B=Yoshi,3B=Peach,SS=Daisy,LF=Wario,CF=Waluigi,RF=Bowser',
    'Green Paratroopa vs. King K. Rool',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Yoshi bobbled the ball!',
    'Wario recorded a run!',
    'King K. Rool recorded 1 RBI!',
    'King K. Rool recorded a single!',
  ])
  const atBat = snapshot.display_at_bat
  assert.equal(atBat.result, 'ROE')
  assert.equal(atBat.is_error, true)
  assert.equal(atBat.rbi, 0)
})

// Season game 2811 (Peach Ice Garden, 2026-09-18): the executable announced
// the homer and both runs, then never printed "Bowser recorded 2 RBI!".
test('a home run whose RBI line never came still credits every run on it', () => {
  const state = createTrackerPreviewState()
  const snapshot = feed(state, [
    'Mario vs. Bowser',
    '1 outs',
    'Count: 0-0',
    'Wario is on second.',
    'Fair ball!',
    'Wario recorded a run!',
    'Mario was charged with an earned run',
    'Bowser recorded a run!',
    'Mario was charged with an earned run',
    'Bowser hits a two-run homer off of Mario!',
  ])
  const atBat = snapshot.display_at_bat
  assert.equal(atBat.result, 'HR')
  assert.equal(atBat.rbi, 2)
})

// The tracker announces the matchup BEFORE the out count, so a plate appearance
// opened by the matchup line captured the total from before the out that ended
// the previous one. Baby DK batted with two out on 2026-08-31 and was recorded
// with one, which is what let a third-out lineout credit a runner an advance.
test('a plate appearance takes the out count the tracker announces for it', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Green Paratroopa vs. King K. Rool',
    '0 outs',
    'Count: 0-0',
    'Fair ball!',
    grounder,
    'Luigi put King K. Rool out!',
    'Green Paratroopa vs. Mario',
    '1 outs',
    'Count: 0-0',
    'Strike 1.',
    'Count: 0-1',
  ])
  const snapshot = trackerPreviewSnapshot(state)
  assert.deepEqual(
    snapshot.at_bats.map((atBat) => atBat.pa_number),
    [1, 2],
  )
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: 1 }).display_at_bat.outs_before_pa, 0)
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: 2 }).display_at_bat.outs_before_pa, 1)
})

// The game's own bases_ran follows a runner's animation, which keeps going
// after the catch that ended the inning. Peach's 2026-08-31 lineout for the
// third out had the runner from second "advance" onto the base the runner from
// third was standing on.
test('a play that records the third out credits no runner an advance', () => {
  const state = createTrackerPreviewState()
  feed(state, [
    'Green Paratroopa vs. Mario',
    '2 outs',
    'Count: 0-0',
    'Light Blue Yoshi is on second.',
    'Goomba is on third.',
    'Count: 0-0',
    'Fair ball!',
    '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=Mario|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=12.0|spray_degrees=-14.6|side=third_base|endpoint=catch|endpoint_status=caught|endpoint_seq=4786|x=-5.776|y=0.268|z=-22.838|distance_feet=176.6',
  ])
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Mario',
    inning: 1,
    inning_half: 0,
    outs: 2,
    caught_in_flight: true,
    batted_ball_class: 'fair_caught',
    runners: {
      R2: { name: 'R2', character: 'Light Blue Yoshi', batting_index: 8, bases_ran: 3 },
      R3: { name: 'R3', character: 'Goomba', batting_index: 7, bases_ran: 3 },
    },
  }))
  feed(state, ["Mario's hit was caught!", 'Toadette put Mario out!'])

  const pa = trackerPreviewSnapshot(state, { selectedPaNumber: 1 }).display_at_bat
  assert.equal(pa.outs_before_pa, 2)
  const destinations = Object.fromEntries(
    pa.runner_assignments.map((entry) => [entry.origin, entry.destination]),
  )
  assert.equal(destinations.second, 'second')
  assert.equal(destinations.third, 'third')
})
