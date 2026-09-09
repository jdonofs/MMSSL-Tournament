// Fixtures for the tracker validation console.
//
// Two builders, because the console joins two independent observations of the
// same event and most of its interesting behaviour lives in the seam between
// them:
//
//   plateAppearance()  what the tracker's log parser produces
//   trackingPlay()     what the 60 Hz memory capture produces
//
// Both default to the smallest thing that is internally consistent, so a test
// only has to state the fact it is about. That matters here more than usual:
// these fixtures assert things like "contact without possession", and a
// fixture that silently filled in a possession would make the test pass while
// testing nothing.
//
// Field names deliberately mirror the real records exactly. A fixture with a
// convenient shape of its own would let the production code drift away from
// what it actually receives.

export function plateAppearance(overrides = {}) {
  return {
    preview_only: true,
    saved_to_database: false,
    pa_number: 1,
    inning: 1,
    half: 'top',
    outs_before_pa: 0,
    batter_name: 'Luigi',
    pitcher_name: 'Bowser',
    result: null,
    outs_on_play: 0,
    rbi: 0,
    run_scored: false,
    is_official_ab: null,
    is_earned_run: true,
    runner_on_first_before: false,
    runner_on_second_before: false,
    runner_on_third_before: false,
    runners_before: { first: null, second: null, third: null },
    runner_assignments: null,
    trajectory: null,
    is_bunt: false,
    hit_notation: null,
    fielder_choice_out: false,
    is_error: false,
    error_position: null,
    error_character: null,
    error_player: null,
    error_notation: null,
    is_nice_play: false,
    star_hit_used: false,
    star_hit_connected: false,
    star_pitch_used: false,
    star_pitch_successful: false,
    is_buddy_jump: false,
    buddy_jump_assist_position: null,
    buddy_jump_putout_position: null,
    is_robbed_hr: false,
    strikeout_type: null,
    hit_stadium_key: 'mario_stadium',
    exit_velocity_mph: null,
    launch_angle_deg: null,
    hit_distance_ft: null,
    hit_angle_deg: null,
    hang_time_sec: null,
    pitches: [],
    runs_scored: [],
    fielding_events: { assists: [], putouts: [], bobble: null },
    advanced_batted_ball_raw: null,
    advanced_fielding_raw: null,
    preview_projection: null,
    recent_messages: [],
    ...overrides,
  }
}

export function pitch(overrides = {}) {
  const before = overrides.before || { balls: 0, strikes: 0 }
  const after = overrides.after || before
  return {
    pitch_number_pa: 1,
    pitch_number_game: 1,
    result: 'in_play',
    pitch_type: 'fastball',
    pitch_speed_mph: 62.5,
    pitch_telemetry: null,
    is_star_pitch: false,
    is_star_swing: false,
    count_balls_before: before.balls,
    count_strikes_before: before.strikes,
    count_balls_after: after.balls,
    count_strikes_after: after.strikes,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['before', 'after'].includes(key))),
  }
}

/**
 * A sequence of pitches that walks a real count to `finalCount`, so a fixture
 * cannot accidentally contain a count transition the rules forbid.
 */
export function pitchSequence(results = []) {
  const pitches = []
  let balls = 0
  let strikes = 0
  results.forEach((result, index) => {
    const before = { balls, strikes }
    if (result === 'ball') balls += 1
    else if (result === 'foul') strikes = Math.min(2, strikes + 1)
    else if (['looking', 'swinging_miss', 'strike_unknown'].includes(result)) strikes += 1
    pitches.push(pitch({
      pitch_number_pa: index + 1,
      pitch_number_game: index + 1,
      result,
      before,
      after: { balls, strikes },
    }))
  })
  return pitches
}

export function fieldingEvent(overrides = {}) {
  return {
    event_type: 'fielding_action',
    fielding_attempt: true,
    ball_contact: 'unknown',
    secured: false,
    mechanic: 'ordinary',
    official_error: null,
    confidence: 'low',
    contact_source: 'no_contact_actor',
    t: 1.0,
    frame: 1100,
    action_start_frame: 1090,
    action_end_frame: 1110,
    by: 'SS',
    character_id: 21,
    character: 'Waluigi',
    at: [-12, 0, -30],
    ball_at: [-12.4, 0.6, -30.2],
    distance_units: 0.5,
    closest_distance_units: 0.5,
    action_code: 2,
    contact_fielder: -1,
    last_contact_fielder: -1,
    fielding_contact_counter: 0,
    airborne_near_contact: false,
    // Three-dimensional, so unlike the two above it knows how far ABOVE the
    // fielder the ball was. The gate that uses it is measured: no confirmed
    // contact anywhere in the archive is further than 6.29 units.
    closest_reach_units: 0.8,
    within_reach: true,
    // How the fielder reached the ball, from the actor's catch_type byte.
    catch_type: 1,
    approach: 'ordinary',
    dive: false,
    leap: false,
    ...overrides,
  }
}

export function possessionEvent(overrides = {}) {
  return fieldingEvent({
    event_type: 'possession',
    ball_contact: 'confirmed',
    secured: true,
    mechanic: 'ordinary',
    confidence: 'high',
    contact_source: 'possession_lock',
    action_code: 1,
    by: 'CF',
    character: 'Birdo',
    character_id: 11,
    ball_height_units: 1.2,
    ...overrides,
  })
}

export function throwRecord(overrides = {}) {
  return {
    is_throw: true,
    event_type: 'throw',
    sequence: 1,
    thrower_position: 'CF',
    thrower_character_id: 11,
    thrower_character: 'Birdo',
    receiver_position: '1B',
    receiver_character_id: 3,
    receiver_character: 'Peach',
    possession_frame: 1200,
    release_frame: 1230,
    launch_frame: 1245,
    arrival_frame: 1290,
    release_t: 2.0,
    // Possession to release. Ordinary throws go inside 1.5 s; past 2 s is the
    // top two per cent of every throw in the archive.
    hold_s: 0.5,
    launch_t: 2.25,
    arrival_t: 3.0,
    flight_frames: 45,
    start: [10, 2, -60],
    end: [19, 1, -19],
    target_base: 'first',
    peak_speed_mps: 40,
    peak_speed_mph: 89.5,
    median_speed_mps: 36,
    sample_count: 40,
    buddy_throw: false,
    buddy_freeze_s: 0,
    buddy_thrower_position: null,
    buddy_partner_position: null,
    intended_target_position: '1B',
    outs_recorded: 0,
    is_relay: false,
    // The nearest real runner to the target base on the frame the ball got
    // there, and how much of that gap they closed in the half second before.
    // Null by default: most throws have no runner near the bag at all.
    runner_at_arrival: null,
    quality: { raw_speed_samples: 40, discarded_speed_samples: 2 },
    ...overrides,
  }
}

export function trackingPlay(overrides = {}) {
  return {
    contact_timer: 10000,
    pitch_release_timer: 9940,
    inning: 1,
    inning_half: 0,
    outs: 0,
    balls: 0,
    strikes: 0,
    batter_id: 2,
    batter: 'Luigi',
    batter_index: 0,
    duration_s: 6.5,
    live_s: 5.0,
    dead_ball_timer: 10300,
    swing_to_launch_s: 0.35,
    truncated: false,
    fair_or_foul: 1,
    home_run: false,
    batted_ball_class: 'fair_in_play',
    contact_at: [0, 1.1, -0.9],
    landing: null,
    deflections: [],
    forced_misplays: [],
    buddy_handoffs: [],
    buddy_jumps: [],
    catch_approaches: [],
    possession_carries: [],
    fielding_events: [],
    primary_fielder: null,
    primary_fielder_reason: null,
    after_deflection: false,
    rebound_catch: null,
    hang_time_s: null,
    caught_in_flight: false,
    first_touch: null,
    throws: [],
    home_to_first_s: null,
    ninety_foot_split_s: null,
    fielders: {},
    runners: {},
    ...overrides,
  }
}

export function landing(overrides = {}) {
  return { t: 2.4, frame: 10144, at: [18, 0.4, -70], ...overrides }
}

export function firstTouch(overrides = {}) {
  return {
    t: 2.4, frame: 10144, by: 'CF', character_id: 11, character: 'Birdo',
    at: [18, 0, -70], ball_height_units: 1.1, ...overrides,
  }
}

export function runnerAssignment(overrides = {}) {
  return {
    id: 'batter',
    runner: { characterName: 'Luigi' },
    origin: 'plate',
    isBatter: true,
    destination: 'first',
    ...overrides,
  }
}

/** A join result in the shape tracker_play_join produces. */
export function join(status = 'joined', overrides = {}) {
  return {
    status,
    pa_number: status === 'joined' || status === 'mismatch' ? 1 : null,
    candidate_pa_numbers: status === 'joined' ? [1] : [],
    reason: 'test fixture',
    evidence: {},
    ...overrides,
  }
}
