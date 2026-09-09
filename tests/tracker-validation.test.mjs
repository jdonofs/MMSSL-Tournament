import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeAtBatChecks, validateTrackerAtBat } from '../scripts/tracker_validation.mjs'
import { buildTrackerNarrative } from '../scripts/tracker_narrative.mjs'
import {
  fieldingEvent,
  firstTouch,
  join,
  landing,
  pitch,
  pitchSequence,
  plateAppearance,
  possessionEvent,
  runnerAssignment,
  throwRecord,
  trackingPlay,
} from './helpers/trackerFixtures.mjs'

const ids = (warnings) => warnings.map((warning) => warning.id)
const has = (warnings, prefix) => warnings.some((warning) => warning.id.startsWith(prefix))

test('a clean at-bat produces no warnings at all', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0,
      pitches: pitchSequence(['looking', 'in_play']),
      runner_assignments: [runnerAssignment({ destination: 'out' })],
    }),
    play: trackingPlay({
      caught_in_flight: true, batted_ball_class: 'fair_caught',
      first_touch: firstTouch(), fielding_events: [possessionEvent()],
    }),
    join: join('joined'),
  })
  assert.deepEqual(ids(warnings), [], `unexpected: ${JSON.stringify(warnings, null, 1)}`)
})

test('an impossible count transition is caught', () => {
  const jumped = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'K',
      pitches: [
        pitch({ pitch_number_pa: 1, result: 'looking', before: { balls: 0, strikes: 0 }, after: { balls: 0, strikes: 1 } }),
        // Two strikes on one pitch.
        pitch({ pitch_number_pa: 2, result: 'looking', before: { balls: 0, strikes: 1 }, after: { balls: 0, strikes: 3 } }),
      ],
    }),
  })
  assert.ok(has(jumped, 'count-step'))

  const gapped = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'K',
      pitches: [
        pitch({ pitch_number_pa: 1, result: 'looking', before: { balls: 0, strikes: 0 }, after: { balls: 0, strikes: 1 } }),
        // Starts from a count the previous pitch did not leave.
        pitch({ pitch_number_pa: 2, result: 'looking', before: { balls: 2, strikes: 1 }, after: { balls: 2, strikes: 2 } }),
      ],
    }),
  })
  assert.ok(has(gapped, 'count-gap'))
})

test('pitch telemetry attached to the wrong pitch is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'K',
      pitches: [pitch({ pitch_number_pa: 1, result: 'looking', after: { balls: 0, strikes: 1 }, pitch_telemetry: { pitchCounter: 4 } })],
    }),
  })
  assert.ok(has(warnings, 'telemetry-pitch'))
})

test('a foul strike applied after early flight telemetry is not a count disagreement', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'GO',
      pitches: [pitch({
        pitch_number_pa: 1,
        result: 'foul',
        before: { balls: 0, strikes: 0 },
        after: { balls: 0, strikes: 1 },
        pitch_telemetry: {
          pitchCounter: 1,
          terminal: 'forward_z_ended',
          countAfter: { balls: 0, strikes: 0 },
        },
      })],
    }),
  })
  assert.equal(has(warnings, 'telemetry-count'), false)
})

test('telemetry measured for a different pitcher is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'K', pitcher_name: 'Bowser',
      pitches: [pitch({ pitch_number_pa: 1, result: 'looking', after: { balls: 0, strikes: 1 }, pitch_telemetry: { pitchCounter: 1, pitcherName: 'Wario' } })],
    }),
  })
  assert.ok(has(warnings, 'telemetry-pitcher'))
})

test('contact recorded on a plate appearance with no ball in play is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'BB', trajectory: 'G', pitches: pitchSequence(['ball', 'ball', 'ball', 'ball']) }),
  })
  assert.ok(has(warnings, 'contact-without-in-play'))
})

test('possession without confirmed contact is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment({ destination: 'out' })] }),
    play: trackingPlay({
      fielding_events: [possessionEvent({ secured: true, ball_contact: 'unknown' })],
      first_touch: firstTouch(),
    }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'possession-without-contact'))
})

test('a catch recorded after a confirmed landing is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment({ destination: 'out' })] }),
    play: trackingPlay({ caught_in_flight: true, landing: landing(), first_touch: firstTouch(), fielding_events: [possessionEvent()] }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'catch-after-landing'))
})

test('a fielding attempt with no contact classification at all is caught', () => {
  const event = fieldingEvent()
  delete event.ball_contact
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment()] }),
    play: trackingPlay({ fielding_events: [event] }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'attempt-without-classification'))
})

test('an official error asserted by a fielding event without a scoring ruling is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 0, is_error: false, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment()] }),
    play: trackingPlay({ fielding_events: [fieldingEvent({ official_error: true, ball_contact: 'confirmed' })] }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'error-inferred'))
})

test('a putout by someone outside the possession and throw chain is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 0,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'out' })],
      fielding_events: { assists: [], putouts: [{ fielderName: 'Toadette', runnerName: 'Luigi' }], bobble: null },
    }),
    play: trackingPlay({
      first_touch: firstTouch({ character: 'Birdo' }),
      fielding_events: [possessionEvent({ character: 'Birdo' })],
      throws: [throwRecord({ thrower_character: 'Birdo', receiver_character: 'Peach' })],
    }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'putout-outside-chain'))
})

// A Mii is not in the game's character table, so the capture only ever has an
// id for one. Firing this warning on every putout a Mii records names a
// contradiction that is really a missing table entry.
test('a putout by a fielder only the tracker log could name is not a chain break', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 0,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'out' })],
      fielding_alignment: { '1B': 'Orange Mii (M)' },
      fielding_events: { assists: [], putouts: [{ fielderName: 'Orange Mii (M)', runnerName: 'Luigi' }], bobble: null },
    }),
    play: trackingPlay({
      first_touch: firstTouch({ by: '2B', character: 'Hammer Bro.' }),
      fielding_events: [possessionEvent({ by: '2B', character: 'Hammer Bro.' })],
      throws: [throwRecord({
        thrower_position: '2B', thrower_character: 'Hammer Bro.',
        receiver_position: '1B', receiver_character: 'char 78',
      })],
    }),
    join: join('joined'),
  })
  assert.equal(has(warnings, 'putout-outside-chain'), false, JSON.stringify(warnings, null, 1))
})

test('a measured throwing error is surfaced as a charge, not as a question', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({ throws: [throwRecord({
      throwing_error_candidate: true,
      target_base: 'third',
      receiver_distance_from_target_units: 2.99,
      runner_at_arrival: { character: 'Purple Toad', distance_from_target_units: 1.9, closing_units: 4.6 },
    })] }),
  })
  const warning = warnings.find((entry) => entry.id === 'throwing-error-charged-1')
  assert.equal(warning.severity, 'info')
  assert.match(warning.detail, /an error is charged to the thrower/)
  assert.match(warning.detail, /Flag the play if the scorer disagrees/)
})

// Serialization drops this known shared-animation false signal. If raw input
// bypasses that normalization, validation still refuses to pass it silently.
test('an unnormalized bobble signal with no measured contact is flagged', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '1B', trajectory: 'L', hit_angle_deg: -20,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'first' })],
      fielding_events: { assists: [], putouts: [], bobble: 'Dixie Kong' },
    }),
    play: trackingPlay({
      landing: landing(),
      fielding_events: [
        fieldingEvent({
          by: 'LF', character: 'Dixie Kong', action_code: 3, ball_contact: 'missed',
          dive: true, catch_type: 3, closest_reach_units: 2.51,
          contact_source: 'action_without_contact_actor',
        }),
        possessionEvent({ by: 'LF', character: 'Dixie Kong' }),
      ],
    }),
    join: join('joined'),
  })
  assert.ok(has(warnings, 'bobble-without-contact'), JSON.stringify(ids(warnings)))

  // A bobble the capture DID measure contact for is the two feeds agreeing.
  const agreed = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: -20,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'first' })],
      fielding_events: { assists: [], putouts: [], bobble: 'Waluigi' },
    }),
    play: trackingPlay({
      landing: landing(),
      fielding_events: [fieldingEvent({ ball_contact: 'confirmed', character: 'Waluigi' })],
    }),
    join: join('joined'),
  })
  assert.equal(has(agreed, 'bobble-without-contact'), false)
})

test('a runner with no destination is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: null })],
    }),
  })
  assert.ok(has(warnings, 'runner-no-destination'))
})

test('two runners finishing on one base is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runners_before: { first: 'Peach', second: null, third: null },
      runner_on_first_before: true,
      runner_assignments: [
        runnerAssignment({ id: 'batter', destination: 'second' }),
        runnerAssignment({ id: 'first', runner: { characterName: 'Peach' }, origin: 'first', isBatter: false, destination: 'second' }),
      ],
    }),
  })
  assert.ok(has(warnings, 'base-shared'))
})

test('runner outcomes that disagree with the recorded outs and runs are caught', () => {
  const outs = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'first' })],
    }),
  })
  assert.ok(has(outs, 'outs-disagree'))

  const runs = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runners_before: { first: null, second: null, third: 'Daisy' },
      runner_on_third_before: true,
      runs_scored: [],
      runner_assignments: [
        runnerAssignment({ destination: 'first' }),
        runnerAssignment({ id: 'third', runner: { characterName: 'Daisy' }, origin: 'third', isBatter: false, destination: 'home' }),
      ],
    }),
  })
  assert.ok(has(runs, 'runs-disagree'))
})

test('an out result recording zero outs is caught', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 0, hit_angle_deg: 0, pitches: pitchSequence(['in_play']) }),
  })
  assert.ok(has(warnings, 'out-result-no-outs'))
})

test('ambiguous, orphaned and mismatched joins each raise their own warning', () => {
  for (const [status, id] of [['ambiguous', 'join-ambiguous'], ['orphaned', 'join-orphaned'], ['mismatch', 'join-mismatch']]) {
    const warnings = validateTrackerAtBat({
      atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment()] }),
      join: join(status),
    })
    assert.ok(has(warnings, id), `${status} should raise ${id}`)
  }
})

test('measured data presented as projected, and the reverse, are both caught', () => {
  const asProjected = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '2B', trajectory: 'L', hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'second' })],
      preview_projection: { distance_source: 'tracked_endpoint', is_projected: true },
    }),
  })
  assert.ok(has(asProjected, 'projection-flag-disagrees'))

  const asMeasured = validateTrackerAtBat({
    atBat: plateAppearance({
      result: '2B', trajectory: 'L', hit_angle_deg: 0, pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'second' })],
      preview_projection: { distance_source: 'physics_from_exit_velocity', is_projected: false },
    }),
  })
  assert.ok(has(asMeasured, 'projection-flag-disagrees-2'))
})

test('an endpoint recorded on the dead-ball coordinate reset is flagged', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: -2.8,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'out' })],
      advanced_batted_ball_raw: {
        endpoint: 'catch', endpointStatus: 'caught', endpointSeq: 13349,
        x: 0, y: 0, z: 0, distanceFeet: 2.6,
      },
    }),
  })
  assert.ok(has(warnings, 'endpoint-coordinate-reset'))

  const measured = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: -2.8,
      pitches: pitchSequence(['in_play']),
      runner_assignments: [runnerAssignment({ destination: 'out' })],
      advanced_batted_ball_raw: {
        endpoint: 'catch', endpointStatus: 'caught', endpointSeq: 13349,
        x: -2.16, y: 0, z: -88.376, distanceFeet: 290,
      },
    }),
  })
  assert.equal(has(measured, 'endpoint-coordinate-reset'), false)
})

test('a live play that disagrees with its postgame restatement is caught', () => {
  const live = trackingPlay({ caught_in_flight: true, primary_fielder: 'CF', batted_ball_class: 'fair_caught', first_touch: firstTouch(), fielding_events: [possessionEvent()] })
  const postgame = { ...live, primary_fielder: 'RF' }
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment({ destination: 'out' })] }),
    play: live,
    postgamePlay: postgame,
    join: join('joined'),
  })
  assert.ok(has(warnings, 'derivation-disagrees-primary_fielder'))
})

test('an ability named as used without confirmed activation is caught in the narrative', () => {
  // A hand-built narrative that breaks the rule the generator enforces. The
  // check has to catch it even so, because the generator is not the only thing
  // that could ever produce a clause.
  const narrative = {
    clauses: [{
      id: 'c09-ability',
      category: 'ability',
      text: 'Birdo used Suction Catch.',
      status: 'observed',
      source: 'invented',
      evidence: { status: 'unconfirmed', mappedAbility: 'Suction Catch' },
    }],
  }
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0, pitches: pitchSequence(['in_play']), runner_assignments: [runnerAssignment({ destination: 'out' })] }),
    narrative,
  })
  assert.ok(has(warnings, 'ability-claimed'))
})

test('the generator never trips its own ability check', () => {
  const play = trackingPlay({
    caught_in_flight: true, batted_ball_class: 'fair_caught',
    first_touch: firstTouch({ by: 'RF', character: 'Birdo' }),
    fielding_events: [possessionEvent({ by: 'RF', character: 'Birdo' })],
  })
  const atBat = plateAppearance({
    result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 30,
    star_hit_used: true, batter_name: 'Mario',
    pitches: pitchSequence(['in_play']),
    runner_assignments: [runnerAssignment({ runner: { characterName: 'Mario' }, destination: 'out' })],
  })
  const narrative = buildTrackerNarrative({ atBat, play, join: join('joined') })
  const warnings = validateTrackerAtBat({ atBat, play, join: join('joined'), narrative })
  assert.equal(warnings.filter((warning) => warning.id.startsWith('ability-')).length, 0,
    JSON.stringify(warnings, null, 1))
})

test('warnings come back most severe first', () => {
  const warnings = validateTrackerAtBat({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 0, hit_angle_deg: 0,
      pitches: pitchSequence(['in_play']),
      runners_before: { first: 'Peach', second: null, third: null },
      runner_on_first_before: true,
    }),
    join: join('pending', { pa_number: null }),
  })
  const rank = { error: 0, warning: 1, info: 2 }
  const order = warnings.map((warning) => rank[warning.severity])
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
})

test('the four-category verdict reports what is missing rather than passing it', () => {
  const complete = summarizeAtBatChecks({
    atBat: plateAppearance({
      result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0,
      exit_velocity_mph: 88, launch_angle_deg: 31, hit_distance_ft: 290,
      pitches: [pitch({ result: 'in_play', pitch_telemetry: { pitchCounter: 1 } })],
      runner_assignments: [runnerAssignment({ destination: 'out' })],
    }),
    play: trackingPlay({ caught_in_flight: true, first_touch: firstTouch(), fielding_events: [possessionEvent()] }),
    join: join('joined'),
    warnings: [],
  })
  assert.deepEqual(complete, { pitching: 'ok', batting: 'ok', fielding: 'ok', running: 'ok' })

  const missing = summarizeAtBatChecks({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0, pitches: [pitch({ result: 'in_play' })] }),
    play: null,
    join: join('pending', { pa_number: null }),
    warnings: [],
  })
  assert.equal(missing.pitching, 'warn')   // no flight telemetry
  assert.equal(missing.batting, 'warn')    // no exit velocity / distance
  assert.equal(missing.fielding, 'warn')   // no joined play
  assert.equal(missing.running, 'warn')    // runners unresolved

  const walk = summarizeAtBatChecks({
    atBat: plateAppearance({
      result: 'BB',
      pitches: pitchSequence(['ball', 'ball', 'ball', 'ball']).map((entry) => ({ ...entry, pitch_telemetry: { pitchCounter: entry.pitch_number_pa } })),
      runner_assignments: [runnerAssignment()],
    }),
    warnings: [],
  })
  // There is no fielding on a walk; that is not a gap.
  assert.equal(walk.fielding, 'n/a')
  assert.equal(walk.batting, 'ok')

  const inProgress = summarizeAtBatChecks({
    atBat: plateAppearance({ result: null, pitches: [] }),
    warnings: [],
  })
  assert.deepEqual(inProgress, { pitching: 'pending', batting: 'pending', fielding: 'pending', running: 'pending' })
})

test('an unknown contact classification downgrades the fielding verdict', () => {
  const checks = summarizeAtBatChecks({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: 0,
      exit_velocity_mph: 70, launch_angle_deg: 5, hit_distance_ft: 120,
      pitches: [pitch({ result: 'in_play', pitch_telemetry: { pitchCounter: 1 } })],
      runner_assignments: [runnerAssignment()],
    }),
    play: trackingPlay({ fielding_events: [fieldingEvent({ ball_contact: 'unknown' })] }),
    join: join('joined'),
    warnings: [],
  })
  assert.equal(checks.fielding, 'warn')
})
