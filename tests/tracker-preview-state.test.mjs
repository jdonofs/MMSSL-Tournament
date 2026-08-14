import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTrackerPreviewMessage,
  classifyPitchMovement,
  clearTrackerPreviewAtBats,
  compactTrackerPitchDiagnostics,
  createTrackerPreviewState,
  parseTrackerPitchProvisionalMessage,
  setTrackerPreviewStadiumOverride,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'

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
  assert.equal(snapshot.display_at_bat.hit_distance_ft, 76.6)
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

  clearTrackerPreviewAtBats(state)
  const snapshot = trackerPreviewSnapshot(state)
  assert.deepEqual(snapshot.at_bats, [])
  assert.equal(snapshot.at_bat_count, 0)
  assert.equal(snapshot.display_at_bat, null)
  assert.equal(snapshot.last_completed_at_bat, null)
  assert.equal(snapshot.session_pitch_diagnostics.at_bat_count, 0)

  // A restarted tracker numbers its at-bats from the top again.
  feed(state, ['Mario vs. Luigi', 'Count: 0-0', 'Luigi was hit by a pitch!'])
  assert.equal(trackerPreviewSnapshot(state).display_at_bat.pa_number, 1)
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
  assert.equal(snapshot.last_completed_at_bat.exit_velocity_mph, 97.7)
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
  assert.equal(projectedPa.preview_projection.distance_source, 'tracker_last_frame_extrapolation')
  assert.equal(projectedPa.preview_projection.is_projected, true)
  assert.equal(projectedPa.preview_projection.plotted_distance_ft, 309.5)

  const measured = createTrackerPreviewState()
  setTrackerPreviewStadiumOverride(measured, 'mario_stadium')
  feed(measured, ['Green Paratroopa vs. King K. Rool', 'Count: 0-0', 'Fair ball!', grounder])
  const measuredPa = trackerPreviewSnapshot(measured).display_at_bat
  assert.equal(measuredPa.preview_projection.distance_source, 'tracked_endpoint')
  assert.equal(measuredPa.preview_projection.is_projected, false)
  // The real-gravity model is kept alongside the measurement so the gap
  // between them stays visible; it must never replace the tracked distance.
  assert.equal(measuredPa.hit_distance_ft, 76.6)
  assert.ok(Number.isFinite(measuredPa.preview_projection.physics_distance_ft))
  assert.equal(
    measuredPa.preview_projection.physics_vs_plotted_distance_ft,
    Math.round((measuredPa.preview_projection.physics_distance_ft - 76.6) * 10) / 10,
  )
})

test('a batted ball with no stadium still reports its projection, just unplotted', () => {
  const state = createTrackerPreviewState()
  feed(state, ['Bowser vs. Brown Kritter', 'Count: 0-0', noTouchHomeRun])
  const projection = trackerPreviewSnapshot(state).display_at_bat.preview_projection
  assert.equal(projection.stadium_key, null)
  assert.equal(projection.plotted_x, null)
  assert.equal(projection.distance_source, 'tracker_last_frame_extrapolation')
  assert.equal(projection.plotted_distance_ft, 309.5)
})
