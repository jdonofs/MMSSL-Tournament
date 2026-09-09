// The 60 Hz player-tracking half of a preview session: completed plays, how
// they joined to at-bats, and how healthy the capture producing them is.
//
// WHY IT IS A SEPARATE FILE FROM tracker_preview_state.mjs. Those two feeds
// arrive from different processes at wildly different rates -- the tracker log
// is a line every few seconds, the collector is a play every thirty -- and the
// rules for what the browser is allowed to see are different too. A plate
// appearance is small and is sent whole on every poll. A player-tracking play
// is not: one carries every fielder's route, every runner's five-foot splits,
// and a throw chain, and five of them outweigh everything else on the page.
//
// SO NOTHING HERE IS SENT WHOLE BY DEFAULT. The snapshot carries a compact
// summary per play -- enough to label it, badge it, and say how it joined --
// and the full record is fetched from /play only when an operator opens the
// evidence for one. That is the difference between a page that polls twice a
// second comfortably and one that re-transmits a megabyte to do it.

import { joinPlayToAtBat, isFairPlay } from './tracker_play_join.mjs'

export const CAPTURE_STATUSES = Object.freeze([
  'disabled', 'waiting', 'recording', 'stopped', 'failed',
])

/**
 * Record one measured pitch. Returns false for anything that is not one, so a
 * malformed marker is dropped rather than corrupting the count.
 */
export function applyPlayerTrackingPitch(tracking, pitch) {
  if (!pitch || typeof pitch !== 'object') return false
  if (!Number.isFinite(Number(pitch.pitch_timer))) return false
  // The collector re-sends nothing, but a bridge reconnect can replay a tail of
  // its output, and a pitch counted twice is exactly the error this stream
  // exists to detect in the other feed.
  if (tracking.pitches.some((seen) => seen.pitch_timer === pitch.pitch_timer)) return false
  tracking.pitches.push(pitch)
  return true
}

export function createPlayerTrackingState() {
  return {
    capture: {
      status: 'waiting',
      collector_pid: null,
      stem: null,
      park: null,
      frames: 0,
      missed_frames: 0,
      frame_rate: null,
      last_frame_at: null,
      duration_seconds: null,
      calibration_status: 'pending',
      calibration_lock_frames: 0,
      position_offset: null,
      plays_emitted: 0,
      plays_withheld: 0,
      pitches_emitted: 0,
      mean_feed_ms: null,
      max_feed_ms: null,
      max_play_build_ms: null,
      fielder_pointers_left_region: false,
      live_path: null,
      note: null,
      updated_at: null,
      // Bounded human-readable output from the collector/memory reader for the
      // preview's diagnostics drawer.
      recent_messages: [],
    },
    // Completed plays, oldest first, keyed for lookup by the game frame the
    // contact happened on -- the only identifier a play has that is stable
    // across live emission and postgame re-derivation.
    plays: [],
    playsByContactTimer: new Map(),
    // Every pitch the capture measured, oldest first. This is the count of
    // record: it comes from the game's own per-plate-appearance pitch counter,
    // so a pitch here with no counterpart in the tracker log is a pitch the log
    // missed rather than a disagreement to be averaged away.
    pitches: [],
    // contact_timer -> the most recent join result for that play.
    joins: new Map(),
    // Postgame restatements, when a re-derived session has been loaded, so the
    // two derivations can be compared field by field.
    postgameByContactTimer: new Map(),
  }
}

/**
 * Ingest one completed 60 Hz play.
 *
 * A play that arrives twice -- the collector re-emitting, or a postgame file
 * being replayed over a live session -- replaces the earlier copy rather than
 * appending, because two rows for one contact would double every count on the
 * page.
 */
export function applyPlayerTrackingPlay(tracking, play) {
  if (!play || !Number.isFinite(Number(play.contact_timer))) return false
  const key = Number(play.contact_timer)
  const existing = tracking.playsByContactTimer.get(key)
  if (existing) {
    Object.assign(existing, play)
  } else {
    tracking.plays.push(play)
    tracking.playsByContactTimer.set(key, play)
    tracking.plays.sort((left, right) => left.contact_timer - right.contact_timer)
  }
  tracking.capture.plays_emitted = tracking.plays.length
  return true
}

/** A postgame play, for comparing the authoritative pass against the live one. */
export function applyPostgamePlay(tracking, play) {
  if (!play || !Number.isFinite(Number(play.contact_timer))) return false
  tracking.postgameByContactTimer.set(Number(play.contact_timer), play)
  return true
}

/**
 * Capture health, as reported by the collector.
 *
 * Merged rather than replaced: the collector reports frames and missed frames
 * every couple of seconds, and calibration once, and neither should erase the
 * other.
 */
export function setCaptureHealth(tracking, health = {}) {
  const capture = tracking.capture
  for (const [key, value] of Object.entries(health)) {
    if (value === undefined) continue
    capture[key] = value
  }
  capture.updated_at = new Date().toISOString()
  return capture
}

export function noteCaptureMessage(tracking, line, limit = 80) {
  const clean = String(line || '').trim()
  if (!clean) return tracking.capture.recent_messages
  const messages = tracking.capture.recent_messages
  messages.push(clean)
  if (messages.length > limit) messages.splice(0, messages.length - limit)
  return messages
}

/**
 * Re-run every play's join against the at-bats a session currently holds.
 *
 * Joins are recomputed rather than cached because at-bats keep changing: a
 * play that was `pending` when it arrived becomes `joined` the moment the
 * tracker log catches up, and one that looked unambiguous can become
 * `ambiguous` when a second matching at-bat appears. A cached join would be a
 * snapshot of what was known at the least informed moment.
 */
export function rejoinPlays(tracking, atBats = [], { latestInning = null, latestHalf = null } = {}) {
  tracking.joins.clear()
  const byPa = new Map()
  for (const play of tracking.plays) {
    const join = joinPlayToAtBat(play, atBats, { latestInning, latestHalf })
    tracking.joins.set(Number(play.contact_timer), join)
    if (join.status === 'joined') {
      const list = byPa.get(join.pa_number) || []
      list.push(play)
      byPa.set(join.pa_number, list)
    }
  }
  // Two fair balls on one plate appearance is impossible. Rather than choosing
  // one, both are demoted to ambiguous so the operator sees the contradiction.
  for (const [paNumber, plays] of byPa) {
    const fair = plays.filter(isFairPlay)
    if (fair.length <= 1) continue
    for (const play of fair) {
      const key = Number(play.contact_timer)
      tracking.joins.set(key, {
        ...tracking.joins.get(key),
        status: 'ambiguous',
        pa_number: null,
        candidate_pa_numbers: [paNumber],
        reason: `PA ${paNumber} has ${fair.length} fair batted balls joined to it`,
      })
    }
  }
  return tracking.joins
}

/** The play this at-bat's narrative should be built from, and its join. */
export function outcomePlayFor(tracking, paNumber) {
  if (paNumber == null) return { play: null, join: null }
  let fallback = null
  for (const play of tracking.plays) {
    const join = tracking.joins.get(Number(play.contact_timer))
    if (!join) continue
    // A play that could not be attached still has to reach the at-bat it
    // NAMES, or an ambiguous join disappears from the one page that exists to
    // show it -- looking exactly like an at-bat nobody fielded.
    const names = join.pa_number === paNumber
      || (join.candidate_pa_numbers || []).includes(paNumber)
    if (!names) continue
    if (join.status === 'joined' && isFairPlay(play)) return { play, join }
    // A foul ball is never an at-bat's outcome, so it may only stand in when
    // nothing fair names this at-bat at all. Taking the first play in arrival
    // order instead once cost a lineout its catch: the foul that preceded it
    // arrived first, and the console reported that nobody had fielded the ball.
    if (!fallback || (isFairPlay(play) && !isFairPlay(fallback.play))) fallback = { play, join }
  }
  // No fair ball joined. Report the join that names this at-bat -- which may be
  // a mismatch or an ambiguous candidate -- so the page can say why rather
  // than showing nothing.
  return fallback || { play: null, join: null }
}

/** Every join whose status names this at-bat, including the non-joined ones. */
export function playsForAtBat(tracking, paNumber) {
  const entries = []
  for (const play of tracking.plays) {
    const join = tracking.joins.get(Number(play.contact_timer))
    if (!join) continue
    if (join.pa_number === paNumber
      || (join.candidate_pa_numbers || []).includes(paNumber)) {
      entries.push({ play, join })
    }
  }
  return entries
}

const BADGE_RULES = [
  ['EGG', (play) => (play.forced_misplays || []).length > 0],
  // Only when the game's own Buddy state backs it. Action code 7 fires for
  // redirections between players who are not chemistry partners at all, and a
  // badge is a claim like any other sentence.
  ['BUDDY HANDOFF', (play) => (play.buddy_handoffs || []).length > 0
    && (play.throws || []).some((entry) => entry.buddy_throw)],
  ['BUDDY THROW', (play) => (play.throws || []).some((entry) => entry.buddy_throw)],
  // The capture sees the attempt; the tracker log only announces the ones that
  // produced an out, so a badge driven by the log alone missed every buddy
  // jump at a ball that left the park.
  ['BUDDY JUMP', (play) => (play.buddy_jumps || []).length > 0],
  ['RELAY', (play) => (play.throws || []).some((entry) => entry.is_relay)],
  ['BOBBLE', (play) => (play.deflections || []).length > 0],
  ['CONTACT', (play) => (play.fielding_events || []).some(
    (event) => event.event_type === 'fielding_action' && event.ball_contact === 'confirmed')],
  ['MISS', (play) => (play.fielding_events || []).some(
    (event) => event.ball_contact === 'missed')],
  ['UNKNOWN', (play) => (play.fielding_events || []).some(
    (event) => event.ball_contact === 'unknown')],
  ['SECURED', (play) => Boolean(play.first_touch)],
  ['WALL', (play) => Number(play.first_touch?.ball_height_units) > 2.5],
  ['TRUNCATED', (play) => Boolean(play.truncated)],
]

/** Badges the play visualization and the history strip both use. */
export function playBadges(play, atBat = null) {
  if (!play) return []
  const badges = BADGE_RULES
    .filter(([, test]) => {
      try { return test(play) } catch { return false }
    })
    .map(([label]) => label)
  if (atBat?.is_buddy_jump) badges.push('BUDDY JUMP')
  if (atBat?.is_robbed_hr) badges.push('WALL')
  if (atBat?.preview_projection?.is_projected) badges.push('PROJECTED')
  // DIVE is deliberately absent: no signal in the current capture
  // distinguishes a dive from an ordinary reach, so a DIVE badge would be a
  // guess wearing the same styling as a measurement.
  return [...new Set(badges)]
}

/**
 * One line per play for the snapshot. Small on purpose -- everything heavy
 * (routes, splits, per-frame evidence) stays server-side until /play asks.
 */
export function compactPlaySummary(play, join = null, atBat = null) {
  if (!play) return null
  const fieldingEvents = play.fielding_events || []
  return {
    contact_timer: play.contact_timer,
    derivation: play.derivation || 'postgame',
    inning: play.inning,
    inning_half: play.inning_half,
    outs: play.outs,
    count: `${play.balls}-${play.strikes}`,
    batter: play.batter,
    batted_ball_class: play.batted_ball_class,
    is_fair: isFairPlay(play),
    truncated: Boolean(play.truncated),
    caught_in_flight: Boolean(play.caught_in_flight),
    hang_time_s: play.hang_time_s ?? null,
    live_s: play.live_s ?? null,
    primary_fielder: play.primary_fielder ?? null,
    primary_fielder_reason: play.primary_fielder_reason ?? null,
    first_touch_by: play.first_touch?.by ?? null,
    first_touch_character: play.first_touch?.character ?? null,
    catch_height_units: play.first_touch?.ball_height_units ?? null,
    landed: Boolean(play.landing),
    home_to_first_s: play.home_to_first_s ?? null,
    ninety_foot_split_s: play.ninety_foot_split_s ?? null,
    fielding_event_count: fieldingEvents.length,
    attempt_count: fieldingEvents.filter((event) => event.event_type === 'fielding_action').length,
    confirmed_contacts: fieldingEvents.filter((event) => event.ball_contact === 'confirmed').length,
    unknown_contacts: fieldingEvents.filter((event) => event.ball_contact === 'unknown').length,
    missed_contacts: fieldingEvents.filter((event) => event.ball_contact === 'missed').length,
    throw_count: (play.throws || []).length,
    buddy_throws: (play.throws || []).filter((entry) => entry.buddy_throw).length,
    badges: playBadges(play, atBat),
    join_status: join?.status ?? null,
    join_pa_number: join?.pa_number ?? null,
    // Only when it says something. A clean join's reason is the same sentence
    // every time, and repeating it once per play is most of what a long
    // session's poll would otherwise weigh.
    join_reason: join && join.status !== 'joined' ? join.reason ?? null : null,
    join_candidates: join?.candidate_pa_numbers ?? [],
  }
}

/** Session-level join counts, for the capture-health bar. */
export function joinTally(tracking) {
  const tally = { joined: 0, pending: 0, ambiguous: 0, orphaned: 0, mismatch: 0 }
  for (const join of tracking.joins.values()) {
    tally[join.status] = (tally[join.status] || 0) + 1
  }
  return tally
}

/**
 * Field positions of all nine fielders at pitch release, plus the ball's
 * flight, in the ball's own coordinate frame. The play visualization needs
 * exactly this and nothing else from the heavy record, so it is extracted
 * rather than shipping the record.
 */
export function playGeometry(play) {
  if (!play) return null
  const fielders = []
  for (const [position, entry] of Object.entries(play.fielders || {})) {
    fielders.push({
      position,
      character: entry.character ?? null,
      start: entry.pitch_release_start || entry.start || null,
      end: entry.end || null,
      path_units: entry.path_units ?? null,
      displacement_units: entry.displacement_units ?? null,
      route_efficiency: entry.route_efficiency ?? null,
      sprint_speed_ups: entry.sprint_speed_ups ?? null,
      assist_units: entry.assist_units ?? null,
      // A frozen fielder has no route and no reaction above, and the diagram
      // has to say why rather than showing two blanks.
      frozen_seconds: entry.frozen_seconds || null,
      distance_to_landing_units: entry.distance_to_landing_units ?? null,
      fielded: Boolean(entry.fielded),
      deflected: Boolean(entry.deflected),
    })
  }
  const runners = []
  for (const [slot, entry] of Object.entries(play.runners || {})) {
    runners.push({
      slot,
      character: entry.character ?? null,
      start: entry.start || null,
      end: entry.end || null,
      bases_ran: entry.bases_ran ?? null,
      sprint_speed_ups: entry.sprint_speed_ups ?? null,
      lead_at_contact_units: entry.lead_at_contact_units ?? null,
      stealing: entry.stealing ?? null,
    })
  }
  return {
    contact_at: play.contact_at || null,
    landing: play.landing ? { at: play.landing.at, t: play.landing.t, frame: play.landing.frame } : null,
    first_touch: play.first_touch
      ? {
        at: play.first_touch.at, t: play.first_touch.t, by: play.first_touch.by,
        character: play.first_touch.character,
        ball_height_units: play.first_touch.ball_height_units,
      }
      : null,
    fielders,
    runners,
    throws: (play.throws || []).map((entry) => ({
      sequence: entry.sequence,
      thrower_position: entry.thrower_position,
      receiver_position: entry.receiver_position,
      intended_target_position: entry.intended_target_position,
      target_base: entry.target_base,
      start: entry.start,
      end: entry.end,
      peak_speed_mph: entry.peak_speed_mph,
      buddy_throw: entry.buddy_throw,
      is_relay: entry.is_relay,
      outs_recorded: entry.outs_recorded,
    })),
    fielding_events: (play.fielding_events || []).map((event) => ({
      t: event.t, frame: event.frame, by: event.by, character: event.character,
      at: event.at, ball_at: event.ball_at, event_type: event.event_type,
      ball_contact: event.ball_contact, secured: event.secured,
      mechanic: event.mechanic, action_code: event.action_code,
    })),
  }
}
