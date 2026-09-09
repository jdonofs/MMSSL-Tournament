// What the tracker validation console has to decide before it can draw a pixel.
//
// The console serves two readers whose first question is different, and both
// questions were previously answered by the same undifferentiated grid of
// nineteen numbers:
//
//   THE OPERATOR asks "is this capture worth anything right now?" That is not a
//   number, it is a triage: a blocker (nothing below is trustworthy), a warning
//   (something to watch), a field that is legitimately absent (a replay has no
//   frame age), or healthy. A missed-frame COUNT cannot answer it -- 3 missed
//   of 200 and 3 missed of 200,000 are the same cell and different captures.
//
//   THE VIEWER asks "what happened?" and needs the batter, the result, who made
//   the play, the handful of measurements behind that claim, and -- the part
//   that must never be dropped -- what is still unknown.
//
// Everything here is a pure function of one snapshot plus the poll's own
// history, so it can be tested without a browser and cannot drift from what the
// page renders. NOTHING here invents a measurement: a field that is absent
// comes back as absent with the reason, never as a zero and never as a guess.

// How long a failing poll is a reconnection before it is stale data on screen.
// Two successful polls are 1 s apart, so 6 s is three missed polls: long enough
// not to flash on one dropped request, short enough that an operator cannot
// read a frozen page for an inning believing it is live.
export const FEED_STALE_AFTER_MS = 6000

// A capture that has not produced a frame in this long has stopped, whatever
// its status field says. The collector prints progress about once a second.
export const FRAME_STALL_MS = 10000
export const FRAME_AGING_MS = 2000

// Above this share of missed frames the capture is degraded rather than clean.
// The archive's good captures sit at 0 or 1 missed frame in tens of thousands.
export const MISSED_FRAME_WARN_RATE = 0.0001
export const MISSED_FRAME_BAD_RATE = 0.01

const JOIN_PROBLEM_STATUSES = ['ambiguous', 'orphaned', 'mismatch']

// Number(null) is 0 and Number('') is 0, so a bare Number.isFinite check turns
// every absent field into a measured zero -- which is the one conversion this
// console must never make. An absent frame age would have read as "<1s ago" and
// an absent score as 0-0.
function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parkLabel(key) {
  if (!key) return null
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

// --- 1. the feed itself -----------------------------------------------------

/**
 * What the poll loop is doing, from its own outcomes rather than from the
 * snapshot -- a snapshot cannot report that nobody is listening to it.
 *
 * `stale` is the state that mattered and did not exist: the page kept rendering
 * the last good snapshot with no label, so a dead API looked exactly like a
 * quiet inning.
 */
export function describeFeedStatus({
  snapshot = null,
  connectionError = null,
  lastGoodAt = null,
  now = Date.now(),
  shutdownRequested = false,
} = {}) {
  if (shutdownRequested) {
    return {
      state: 'ended', tone: 'neutral', label: 'Session ended',
      detail: 'The capture is being saved. This page has stopped polling.',
      showsLastGood: Boolean(snapshot), staleForMs: null,
    }
  }
  if (!connectionError) {
    if (!snapshot) {
      return {
        state: 'waiting', tone: 'neutral', label: 'Waiting for the tracker service',
        detail: 'No snapshot has arrived yet.', showsLastGood: false, staleForMs: null,
      }
    }
    return {
      state: 'live', tone: 'good', label: 'Feed live',
      detail: 'The console is polling the tracker service.',
      showsLastGood: false, staleForMs: null,
    }
  }
  if (!snapshot) {
    return {
      state: 'offline', tone: 'bad', label: 'Tracker service offline',
      detail: connectionError, showsLastGood: false, staleForMs: null,
    }
  }
  const staleForMs = lastGoodAt == null ? null : Math.max(0, now - lastGoodAt)
  if (staleForMs != null && staleForMs < FEED_STALE_AFTER_MS) {
    return {
      state: 'reconnecting', tone: 'warn', label: 'Reconnecting',
      detail: `The last poll failed (${connectionError}). Retrying.`,
      showsLastGood: true, staleForMs,
    }
  }
  return {
    state: 'stale', tone: 'bad', label: 'Stale — showing the last good snapshot',
    detail: `Polling has been failing for ${formatDuration(staleForMs)}: ${connectionError}. `
      + 'Nothing below has changed since then.',
    showsLastGood: true, staleForMs,
  }
}

/** True on the transition back into a working feed, so the page can say so. */
export function feedRecovered(previousState, nextState) {
  return nextState === 'live' && ['stale', 'reconnecting', 'offline'].includes(previousState)
}

export function formatDuration(ms) {
  const value = finite(ms)
  if (value == null) return 'unknown'
  if (value < 1000) return '<1s'
  if (value < 60000) return `${Math.round(value / 1000)}s`
  const minutes = Math.floor(value / 60000)
  const seconds = Math.round((value % 60000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

// --- 2. capture health, as a triage rather than a wall of numbers -----------

function finding(id, label, detail, field = null) {
  return { id, label, detail, field }
}

function metric(id, label, value, {
  tone = 'neutral', detail = null, field = null, missing = false,
} = {}) {
  return { id, label, value, tone, detail, field, missing }
}

/**
 * Everything the operator needs, sorted by whether it stops them.
 *
 * The four buckets are not decoration. A field that is absent BECAUSE OF THE
 * MODE -- a replay has no live frame age, a stopped capture has no derivation
 * cost -- is not a fault and must not be rendered in the same amber as a
 * calibration that failed, or the amber stops meaning anything.
 */
export function summarizeCaptureHealth(snapshot, {
  feed = null,
  gameMismatch = false,
  expectedGameId = null,
  atBats = [],
} = {}) {
  const capture = snapshot?.capture || {}
  const tally = capture.join_tally || {}
  const isReplay = snapshot?.mode === 'archive_replay'
  const isLive = snapshot?.writes_enabled === true
  const recording = capture.status === 'recording'

  const blockers = []
  const warnings = []
  const optional = []
  const healthy = []

  // -- blockers: nothing below this line is worth reading -------------------
  if (feed?.state === 'offline') {
    blockers.push(finding('feed-offline', 'The tracker service is not answering',
      feed.detail, 'GET /state'))
  } else if (feed?.state === 'stale') {
    blockers.push(finding('feed-stale', 'The console is showing a frozen snapshot',
      feed.detail, 'GET /state'))
  }
  if (gameMismatch) {
    blockers.push(finding('game-mismatch', 'This bridge is feeding a different game',
      `The service reports game #${snapshot?.game?.game_id}, this view expects #${expectedGameId}.`,
      'game.game_id'))
  }
  if (capture.status === 'failed') {
    blockers.push(finding('collector-failed', 'The 60 Hz collector failed',
      capture.note || 'No fielding, route, throw or runner measurement exists for this session.',
      'capture.status'))
  }
  if (capture.calibration_status === 'failed') {
    blockers.push(finding('calibration-failed', 'Position calibration failed',
      'Live derivation gave up for this session; the recording continues and the postgame '
      + 'pass will derive the plays properly.', 'capture.calibration_status'))
  }
  const frameAge = finite(capture.last_frame_age_ms)
  if (recording && frameAge != null && frameAge > FRAME_STALL_MS) {
    blockers.push(finding('frames-stalled', 'The capture has stopped producing frames',
      `Last frame ${formatDuration(frameAge)} ago while the collector still reports recording.`,
      'capture.last_frame_age_ms'))
  }
  const withheld = finite(capture.plays_withheld) || 0
  if (withheld > 0) {
    blockers.push(finding('plays-withheld', `${withheld} derived play${withheld === 1 ? '' : 's'} withheld`,
      'Derived before the position offset was proven and discarded rather than published.',
      'capture.plays_withheld'))
  }
  const failedWrites = isLive
    ? atBats.filter((entry) => entry.supabase_write?.status === 'failed').length : 0
  if (failedWrites) {
    blockers.push(finding('writes-failed', `${failedWrites} plate appearance write${failedWrites === 1 ? '' : 's'} failed`,
      'The scoring facts for those at-bats are not durable.', 'at_bats[].supabase_write'))
  }

  // -- warnings: look, but the capture is still worth something -------------
  const frames = finite(capture.frames)
  const missed = finite(capture.missed_frames)
  const missedRate = frames && missed != null ? missed / frames : null
  if (missedRate != null && missedRate > MISSED_FRAME_BAD_RATE) {
    warnings.push(finding('missed-frames-high', `${(missedRate * 100).toFixed(2)}% of frames missed`,
      `${missed?.toLocaleString()} of ${frames.toLocaleString()}. Routes and speeds are sampled from `
      + 'what survived.', 'capture.missed_frames'))
  } else if (missed) {
    warnings.push(finding('missed-frames', `${missed} missed frame${missed === 1 ? '' : 's'}`,
      `${(missedRate * 100).toFixed(4)}% of ${frames.toLocaleString()}.`, 'capture.missed_frames'))
  }
  if (recording && capture.calibration_status === 'pending') {
    warnings.push(finding('calibration-pending', 'Position calibration is not confirmed yet',
      'Plays derived before the offset is proven are held, not published.',
      'capture.calibration_status'))
  }
  if (recording && frameAge != null && frameAge > FRAME_AGING_MS && frameAge <= FRAME_STALL_MS) {
    warnings.push(finding('frames-aging', `Last frame ${formatDuration(frameAge)} ago`,
      'The collector prints progress about once a second.', 'capture.last_frame_age_ms'))
  }
  const badJoins = JOIN_PROBLEM_STATUSES
    .reduce((total, status) => total + (finite(tally[status]) || 0), 0)
  if (badJoins) {
    warnings.push(finding('joins-unclean',
      `${badJoins} play${badJoins === 1 ? '' : 's'} did not join cleanly`,
      `${tally.ambiguous || 0} ambiguous, ${tally.orphaned || 0} orphaned, ${tally.mismatch || 0} mismatched. `
      + 'Their fielding detail is withheld rather than attached to a guess.', 'capture.join_tally'))
  }
  // Three sessions in the archive end without their final `frames`,
  // `duration_seconds` and `missed_frames`. Every play in them replays and
  // joins, so this is not a broken capture -- but the counts that would prove
  // no frames were lost at the end are the exact counts that are absent, and
  // reporting that as "healthy, 0 missed" would state the opposite.
  if (frames == null && (finite(capture.play_count) || 0) > 0) {
    warnings.push(finding('header-incomplete', 'The capture header has no frame total',
      'This session ended without writing its final frame, duration and missed-frame counts. '
      + 'The recorded plays are intact; whether anything was lost after the last one cannot be '
      + 'read from the file.', 'capture.frames'))
  }
  if (capture.fielder_pointers_left_region) {
    warnings.push(finding('pointers-left-region', 'Fielder pointers left the captured region',
      'Some frames have no fielder actors in them.', 'capture.fielder_pointers_left_region'))
  }
  const skippedWrites = isLive
    ? atBats.filter((entry) => entry.supabase_write?.status === 'skipped').length : 0
  if (skippedWrites) {
    warnings.push(finding('writes-skipped', `${skippedWrites} plate appearance${skippedWrites === 1 ? '' : 's'} not saved`,
      'A deliberate refusal: the bridge never guesses a result it could not read.',
      'at_bats[].supabase_write'))
  }
  if (feed?.state === 'reconnecting') {
    warnings.push(finding('feed-reconnecting', 'The last poll failed', feed.detail, 'GET /state'))
  }

  // -- absent by design, which is not a fault -------------------------------
  if (isReplay) {
    optional.push(finding('replay-no-live-frames', 'No live frame age',
      'An archived session is replayed from disk; there is no collector producing frames.',
      'capture.last_frame_age_ms'))
    optional.push(finding('replay-no-lock-margin', 'No calibration lock margin',
      'The recorded capture was already calibrated; the offset is read from the session header.',
      'capture.calibration_lock_frames'))
  }
  if (capture.status === 'disabled') {
    optional.push(finding('collector-disabled', '60 Hz collection is switched off',
      capture.note || 'TRACKER_PLAYER_TRACKING=0. No fielding or baserunning measurement will exist.',
      'capture.status'))
  }
  if (!isReplay && capture.mean_feed_ms == null) {
    optional.push(finding('no-derivation-cost', 'No live derivation cost reported',
      'The collector reports it once live derivation has run.', 'capture.mean_feed_ms'))
  }
  if (!snapshot?.stadium_key) {
    optional.push(finding('no-stadium', 'No stadium resolved',
      'Field placement, the play diagram and the spray chart need one.', 'stadium_key'))
  }

  // -- healthy ---------------------------------------------------------------
  if (!isLive) {
    healthy.push(finding('writes-disabled', 'Database writes disabled',
      'This session cannot reach Supabase.', 'writes_enabled'))
  }
  if (capture.calibration_status === 'confirmed') {
    healthy.push(finding('calibration-confirmed', 'Position calibration confirmed',
      capture.position_offset != null
        ? `Offset +0x${Number(capture.position_offset).toString(16).toUpperCase().padStart(3, '0')}.`
        : null,
      'capture.calibration_status'))
  }
  if (frames && !missed) {
    healthy.push(finding('no-missed-frames', `No missed frames in ${frames.toLocaleString()}`,
      null, 'capture.missed_frames'))
  }
  if (tally.joined && !badJoins && !tally.pending) {
    healthy.push(finding('joins-clean', `All ${tally.joined} plays joined`,
      'Every 60 Hz play attached to exactly one plate appearance.', 'capture.join_tally'))
  }

  // A snapshot that reports no capture status at all is not a healthy capture,
  // it is a service that has not said. Reading the absence as health is how a
  // half-built snapshot came back "Capture healthy" with nothing behind it.
  const unreported = !capture.status
  if (unreported) {
    optional.push(finding('capture-status-unreported', 'The service reports no capture status',
      'This tracker service may predate the capture-health fields.', 'capture.status'))
  }
  const waiting = capture.status === 'waiting' && !finite(capture.play_count)
  const level = blockers.length ? 'blocked'
    : warnings.length ? 'degraded'
      : (waiting || unreported) ? 'waiting' : 'healthy'

  const headline = blockers.length
    ? blockers[0].label
    : warnings.length
      ? `${warnings.length} thing${warnings.length === 1 ? '' : 's'} to watch`
      : unreported
        ? 'Capture status not reported'
        : waiting
          ? 'Waiting for the first matchup'
          : 'Capture healthy'

  return {
    level,
    headline,
    blockers,
    warnings,
    optional,
    healthy,
    metrics: captureMetrics(snapshot, { missedRate, frameAge, isLive, isReplay, atBats }),
  }
}

/**
 * The numbers, each one explicit about being absent rather than zero.
 *
 * `missing: true` is what separates "the tracker measured nothing here" from
 * "the tracker measured nothing", which is the distinction the whole console
 * exists to preserve.
 */
export function captureMetrics(snapshot, {
  missedRate = null, frameAge = null, isLive = false, isReplay = false, atBats = [],
} = {}) {
  const capture = snapshot?.capture || {}
  const tally = capture.join_tally || {}
  const frames = finite(capture.frames)
  const missed = finite(capture.missed_frames)
  const rows = []

  rows.push(metric('frame-age', 'Frame age',
    frameAge == null ? null : formatDuration(frameAge), {
      missing: frameAge == null,
      detail: frameAge == null
        ? (isReplay ? 'Not applicable to a replayed capture' : 'No frame timestamp reported yet')
        : 'Since the collector last reported progress',
      tone: frameAge == null ? 'neutral'
        : frameAge > FRAME_STALL_MS ? 'bad' : frameAge > FRAME_AGING_MS ? 'warn' : 'good',
      field: 'capture.last_frame_age_ms',
    }))

  rows.push(metric('missed-rate', 'Missed frames',
    missed == null ? null
      : missedRate == null ? `${missed}`
        : `${missed} · ${(missedRate * 100).toFixed(missedRate >= 0.001 ? 2 : 4)}%`, {
      missing: missed == null,
      detail: frames ? `of ${frames.toLocaleString()} captured` : 'no frame total reported',
      tone: missed == null ? 'neutral'
        : missedRate != null && missedRate > MISSED_FRAME_BAD_RATE ? 'bad'
          : missed ? 'warn' : 'good',
      field: 'capture.missed_frames',
    }))

  rows.push(metric('frame-rate', 'Frame rate',
    capture.frame_rate == null ? null : `${capture.frame_rate} /s`, {
      missing: capture.frame_rate == null,
      detail: 'The capture budget is 60 Hz',
      tone: capture.frame_rate == null ? 'neutral' : capture.frame_rate >= 55 ? 'good' : 'warn',
      field: 'capture.frame_rate',
    }))

  rows.push(metric('calibration', 'Calibration',
    capture.calibration_status || null, {
      missing: !capture.calibration_status,
      detail: capture.position_offset != null
        ? `position offset +0x${Number(capture.position_offset).toString(16).toUpperCase().padStart(3, '0')}`
        : 'no position offset reported',
      tone: capture.calibration_status === 'confirmed' ? 'good'
        : capture.calibration_status === 'failed' ? 'bad'
          : capture.calibration_status === 'disabled' ? 'neutral' : 'warn',
      field: 'capture.calibration_status',
    }))

  rows.push(metric('lock-margin', 'Lock margin',
    capture.calibration_lock_frames ? `${capture.calibration_lock_frames} locks` : null, {
      missing: !capture.calibration_lock_frames,
      detail: capture.calibration_lock_frames
        ? 'Frames of a fielder standing exactly on the ball'
        : isReplay ? 'Not applicable to a replayed capture' : 'No lock recorded yet',
      tone: capture.calibration_lock_frames ? 'good' : 'neutral',
      field: 'capture.calibration_lock_frames',
    }))

  const joinProblems = (tally.ambiguous || 0) + (tally.orphaned || 0) + (tally.mismatch || 0)
  rows.push(metric('joins', 'Join status',
    capture.play_count == null ? null
      : `${tally.joined || 0}/${capture.play_count} joined`, {
      missing: capture.play_count == null,
      detail: `${tally.pending || 0} pending · ${tally.ambiguous || 0} ambiguous · `
        + `${tally.orphaned || 0} orphaned · ${tally.mismatch || 0} mismatched`,
      tone: joinProblems ? 'bad' : tally.pending ? 'warn' : tally.joined ? 'good' : 'neutral',
      field: 'capture.join_tally',
    }))

  rows.push(metric('plays', 'Plays derived',
    capture.plays_emitted == null ? null : `${capture.plays_emitted}`, {
      missing: capture.plays_emitted == null,
      detail: capture.plays_withheld
        ? `${capture.plays_withheld} withheld before calibration`
        : 'emitted at each dead ball',
      tone: capture.plays_withheld ? 'bad' : 'neutral',
      field: 'capture.plays_emitted',
    }))

  if (isLive) {
    const pending = atBats.filter((entry) => {
      const status = entry.supabase_write?.status || 'pending'
      return status === 'pending' && !entry.is_current
    }).length
    rows.push(metric('pending-writes', 'Pending writes', `${pending}`, {
      detail: 'Completed plate appearances not yet written to Supabase',
      tone: pending ? 'warn' : 'good',
      field: 'at_bats[].supabase_write',
    }))
  }

  const last = snapshot?.last_completed_at_bat
  rows.push(metric('last-event', 'Last completed play',
    last ? `PA ${last.pa_number} · ${last.result || 'no result'}` : null, {
      missing: !last,
      detail: last
        ? `${last.batter_name || 'unknown batter'} · ${last.half || ''} ${last.inning ?? ''}`.trim()
        : 'No plate appearance has completed yet',
      tone: last ? 'neutral' : 'neutral',
      field: 'last_completed_at_bat',
    }))

  rows.push(metric('derivation-cost', 'Derivation cost',
    capture.mean_feed_ms == null ? null : `${capture.mean_feed_ms} ms/frame`, {
      missing: capture.mean_feed_ms == null,
      detail: capture.max_play_build_ms != null
        ? `worst play ${capture.max_play_build_ms} ms` : 'not reported by this session',
      tone: 'neutral',
      field: 'capture.mean_feed_ms',
    }))

  return rows
}

// --- 3. the game header -----------------------------------------------------

const MODE_LABELS = {
  archive_replay: { label: 'Archive replay', tone: 'replay', detail: 'Reconstructed at-bats over recorded 60 Hz plays' },
  local_preview: { label: 'Local preview', tone: 'safe', detail: 'Database writes disabled' },
  live_bridge: { label: 'Live bridge', tone: 'danger', detail: 'Recording to Supabase' },
}

/**
 * The score is READ, never computed.
 *
 * No field in the preview snapshot carries a running score, so the header says
 * so instead of adding up the results it can see -- an at-bat index that has
 * `result` but not `runs_scored` cannot produce a score, and a scoreboard that
 * is wrong by one run is worse than no scoreboard at all.
 */
export function readScore(snapshot) {
  const candidates = [
    snapshot?.situation?.score,
    snapshot?.game?.score,
    snapshot?.score,
  ]
  for (const candidate of candidates) {
    const away = finite(candidate?.away)
    const home = finite(candidate?.home)
    if (away != null && home != null) return { available: true, away, home, source: 'tracker feed' }
  }
  const away = finite(snapshot?.situation?.away_score ?? snapshot?.game?.away_score)
  const home = finite(snapshot?.situation?.home_score ?? snapshot?.game?.home_score)
  if (away != null && home != null) return { available: true, away, home, source: 'tracker feed' }
  return {
    available: false,
    reason: 'The tracker feed does not report a running score.',
  }
}

export function buildGameHeader(snapshot) {
  const situation = snapshot?.situation || {}
  const mode = snapshot?.mode || null
  const modeInfo = MODE_LABELS[mode]
    || { label: mode || 'unknown', tone: 'neutral', detail: null }
  const isLive = snapshot?.writes_enabled === true
  const [balls, strikes] = String(situation.count || '').split('-')

  return {
    mode,
    modeLabel: isLive ? MODE_LABELS.live_bridge.label : modeInfo.label,
    modeTone: isLive ? 'danger' : modeInfo.tone,
    modeDetail: isLive ? MODE_LABELS.live_bridge.detail : modeInfo.detail,
    // The tracker feed names the two players, not the two clubs. Saying
    // "matchup" of anything else here would be inventing a team.
    matchup: {
      batter: situation.batter_name || null,
      pitcher: situation.pitcher_name || null,
      label: situation.batter_name && situation.pitcher_name
        ? `${situation.batter_name} vs ${situation.pitcher_name}`
        : null,
    },
    park: {
      key: snapshot?.stadium_key || null,
      label: parkLabel(snapshot?.stadium_key) || null,
      reported: snapshot?.stadium_name || null,
      overridden: Boolean(snapshot?.stadium_override_key),
    },
    inning: {
      number: finite(situation.inning),
      half: situation.half || null,
      label: situation.inning != null && situation.half
        ? `${situation.half === 'top' ? 'Top' : 'Bottom'} ${situation.inning}`
        : null,
    },
    count: situation.count || null,
    balls: finite(balls),
    strikes: finite(strikes),
    outs: finite(situation.outs),
    score: readScore(snapshot),
    gameId: snapshot?.game?.game_id ?? null,
    trackerState: snapshot?.tracker_status || null,
    connected: snapshot?.connected === true,
  }
}

// --- 4. navigating a whole recorded game -----------------------------------

export const AT_BAT_FILTERS = [
  { id: 'all', label: 'All', title: 'Every plate appearance in this session' },
  { id: 'warnings', label: 'Warnings', title: 'At-bats where two facts disagree' },
  { id: 'uncertain', label: 'Ambiguous / missing', title: 'Unjoined plays, missing checks, or no result' },
  { id: 'in_play', label: 'Balls in play', title: 'At-bats with a fair batted ball measured at 60 Hz' },
  { id: 'complete', label: 'Completed', title: 'At-bats the tracker log scored' },
]

/** Plays grouped by the plate appearance they joined to. */
export function indexPlaysByAtBat(plays = []) {
  const index = new Map()
  for (const play of plays) {
    const key = play?.join_pa_number
    if (key == null) continue
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(play)
  }
  return index
}

/**
 * The four filter facts, each read off a field rather than guessed.
 *
 * `uncertain` deliberately excludes a `warn` check. Almost every replayed
 * at-bat carries `pitching: warn` because the reconstructed log has no pitch
 * telemetry, so including it would match the whole session and the filter would
 * select nothing in particular.
 */
export function annotateAtBats(atBats = [], plays = []) {
  const byAtBat = indexPlaysByAtBat(plays)
  const unjoined = plays.filter((play) => play.join_status && play.join_status !== 'joined')
  return atBats.map((entry) => {
    const own = byAtBat.get(entry.pa_number) || []
    // A play that NAMES this at-bat but did not join to it is exactly the case
    // that must stay visible: the fielding half is withheld, not absent.
    const named = unjoined.filter((play) => (play.join_candidates || []).includes(entry.pa_number))
    const checks = entry.checks || {}
    const missingChecks = Object.entries(checks)
      .filter(([, value]) => value === 'missing')
      .map(([key]) => key)
    const reasons = []
    if (named.length) reasons.push(`${named.length} play did not join cleanly`)
    if (missingChecks.length) reasons.push(`${missingChecks.join(', ')} missing`)
    if (!entry.result) reasons.push('no scored result')
    return {
      ...entry,
      play_count: own.length,
      has_warnings: Boolean(entry.warning_count || entry.error_count),
      has_errors: Boolean(entry.error_count),
      in_play: own.some((play) => play.is_fair === true)
        || own.some((play) => String(play.batted_ball_class || '').startsWith('fair'))
        || own.some((play) => String(play.batted_ball_class || '').startsWith('home_run')),
      complete: Boolean(entry.result),
      uncertain: Boolean(named.length || missingChecks.length || !entry.result),
      uncertain_reasons: reasons,
    }
  })
}

export function filterAtBats(annotated = [], filterId = 'all') {
  switch (filterId) {
    case 'warnings': return annotated.filter((entry) => entry.has_warnings)
    case 'uncertain': return annotated.filter((entry) => entry.uncertain)
    case 'in_play': return annotated.filter((entry) => entry.in_play)
    case 'complete': return annotated.filter((entry) => entry.complete)
    default: return annotated
  }
}

export function countAtBatFilters(annotated = []) {
  return {
    all: annotated.length,
    warnings: annotated.filter((entry) => entry.has_warnings).length,
    uncertain: annotated.filter((entry) => entry.uncertain).length,
    in_play: annotated.filter((entry) => entry.in_play).length,
    complete: annotated.filter((entry) => entry.complete).length,
  }
}

/**
 * Move one step through a list, from wherever the selection currently is.
 *
 * Returns null at the ends rather than wrapping: an operator paging back
 * through a game needs to notice the beginning, not silently reappear at the
 * other end of it.
 */
export function stepSelection(list = [], selectedPaNumber = null, delta = 1) {
  if (!list.length) return null
  const index = list.findIndex((entry) => entry.pa_number === selectedPaNumber)
  const position = index >= 0 ? index : list.length - 1
  const next = position + delta
  if (next < 0 || next >= list.length) return null
  return list[next].pa_number
}

/** The next at-bat matching a predicate, in either direction. */
export function findNextMatch(list = [], selectedPaNumber = null, predicate = () => true, direction = 1) {
  if (!list.length) return null
  const index = list.findIndex((entry) => entry.pa_number === selectedPaNumber)
  const start = index >= 0 ? index : (direction > 0 ? -1 : list.length)
  for (let step = 1; step <= list.length; step += 1) {
    const position = start + step * direction
    if (position < 0 || position >= list.length) break
    if (predicate(list[position])) return list[position].pa_number
  }
  return null
}

// --- 5. the play, in one paragraph -----------------------------------------

const RESULT_WORDS = {
  K: 'strikeout', BB: 'walk', HBP: 'hit by pitch', '1B': 'single', '2B': 'double',
  '3B': 'triple', HR: 'home run', IPHR: 'inside-the-park home run', GO: 'groundout',
  FO: 'flyout', LO: 'lineout', DP: 'double play', TP: 'triple play',
  SF: 'sacrifice fly', SH: 'sacrifice bunt', FC: "fielder's choice", ROE: 'reached on error',
}

const UNCERTAIN_CLAUSE_STATUSES = new Set(['unknown', 'pending', 'mismatch'])

/**
 * The compact explanation, for a reader who did not watch the capture.
 *
 * It is built from the SAME clauses the sentence list renders, never from a
 * second lookup: a summary that consulted the character mapping or the raw play
 * directly could name an ability, a fielder or a distance the sentences above it
 * deliberately refused to claim.
 */
export function buildPlayExplanation({
  interpretation = null, play = null, atBat = null, warnings = [],
} = {}) {
  if (!interpretation && !atBat) return null
  const clauses = interpretation?.clauses || []
  const result = atBat?.result || null
  const resultWord = result ? (RESULT_WORDS[result] || result) : null
  const batter = atBat?.batter_name || interpretation?.summary?.split(' ')[0] || null

  const evidence = []
  const push = (label, value, source) => {
    if (value == null || value === '') return
    evidence.push({ label, value, source })
  }
  if (play) {
    push('First touch',
      play.first_touch_character
        ? `${play.first_touch_character} (${play.first_touch_by})`
        : play.first_touch_by,
      'player_tracking_play.first_touch')
    push('Hang time', play.hang_time_s == null ? null : `${Number(play.hang_time_s).toFixed(2)} s`,
      'player_tracking_play.hang_time_s')
    push('Catch height', play.caught_in_flight && play.catch_height_units != null
      ? `${Number(play.catch_height_units).toFixed(2)} u` : null,
      'player_tracking_play.catch_height_units')
    push('Confirmed contacts', play.confirmed_contacts == null ? null : String(play.confirmed_contacts),
      'player_tracking_play.confirmed_contacts')
    push('Throws', play.throw_count == null ? null : String(play.throw_count),
      'player_tracking_play.throw_count')
    push('Home to first', play.home_to_first_s == null ? null : `${Number(play.home_to_first_s).toFixed(3)} s`,
      'player_tracking_play.home_to_first_s')
  }

  const uncertainty = []
  const note = (label, detail) => uncertainty.push({ label, detail })
  if (play && play.join_status && play.join_status !== 'joined') {
    note(`Join ${play.join_status}`,
      play.join_reason || 'The fielding half of this interpretation is withheld rather than guessed.')
  }
  if (!play) {
    note('No 60 Hz play joined', 'No route, contact, throw or runner measurement exists for this at-bat.')
  }
  if (play?.unknown_contacts) {
    note(`${play.unknown_contacts} contact${play.unknown_contacts === 1 ? '' : 's'} unclassified`,
      'The capture could not decide whether the fielder touched the ball.')
  }
  if (play?.truncated) {
    note('Play record truncated', 'The capture ended before the play did.')
  }
  if (!result) {
    note('No scored result', 'The tracker log has not reported an outcome for this plate appearance.')
  }
  for (const clause of clauses) {
    if (!UNCERTAIN_CLAUSE_STATUSES.has(clause.status)) continue
    note(clause.status === 'mismatch' ? 'Sources disagree' : `Not established (${clause.status})`, clause.text)
  }
  for (const warning of warnings) {
    if (warning.severity !== 'error') continue
    note(warning.title, warning.detail)
  }

  return {
    status: interpretation?.status || (atBat ? 'pending' : 'unavailable'),
    batter,
    result,
    resultLabel: resultWord,
    headline: interpretation?.summary
      || (batter && resultWord ? `${batter} — ${resultWord}` : batter || 'Waiting for a play'),
    primary: play
      ? {
        position: play.primary_fielder || null,
        character: play.first_touch_character || null,
        reason: play.primary_fielder_reason || null,
      }
      : null,
    evidence,
    uncertainty,
  }
}

// --- 6. one measurement, presented honestly --------------------------------

/**
 * Zero is a measurement. Missing is not zero. Excluded is measured but must not
 * be used. Projected is computed, not observed. Baseline-required is a model
 * that has no independent baseline yet, so it has no value at all.
 */
export function presentMeasurement(value, {
  unit = '', digits = 2, status = null, note = null,
} = {}) {
  if (status === 'baseline_required' || status === 'Baseline required') {
    return { text: 'Baseline required', tone: 'model', title: note || 'No independent baseline exists yet', missing: true }
  }
  const number = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return {
      text: 'Not measured',
      tone: 'missing',
      title: note || 'This measurement is absent, which is not the same as zero',
      missing: true,
    }
  }
  const text = `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`
  if (status === 'excluded') {
    return { text, tone: 'excluded', title: note || 'Measured, but excluded from ratings', missing: false, excluded: true }
  }
  if (status === 'projected') {
    return { text, tone: 'projected', title: note || 'Projected, not observed', missing: false, projected: true }
  }
  return {
    text,
    tone: number === 0 ? 'zero' : 'measured',
    title: number === 0 ? (note || 'A measured zero, not a missing value') : note,
    missing: false,
  }
}
