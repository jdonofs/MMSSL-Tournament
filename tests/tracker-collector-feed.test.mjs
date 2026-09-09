import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyCollectorLine, CAPTURE_ATTACHED_MARKER, CAPTURE_READY_MARKER, COLLECTOR_PROGRESS_RE,
} from '../scripts/tracker_collector_feed.mjs'
import {
  createTrackerPreviewState,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'
import { firstTouch, possessionEvent, trackingPlay } from './helpers/trackerFixtures.mjs'

// The collector's stdout is read by two processes -- the Supabase bridge and
// the read-only preview -- and the capture health bar is the one part of the
// console that says whether to trust anything below it. So these tests pin the
// parsing itself, including the padding the collector actually emits.

test("the collector's real progress line is parsed, padding and all", () => {
  const lines = [
    '   123.4s     7398 frames ( 59.9/s, 2 missed)   12.34 MB  inning 1.0 0 out  holder=-1',
    '    12.0s      719 frames ( 59.9/s, 0 missed)    1.02 MB  inning 1.0 0 out  holder=-1'
      + '  live 2 plays (confirmed, 0.031 ms/frame)',
    '  1234.5s   123456 frames (100.0/s, 17 missed)  999.99 MB  inning 9.1 2 out  holder=3',
  ]
  const parsed = lines.map((line) => line.match(COLLECTOR_PROGRESS_RE)?.slice(1, 5))
  assert.deepEqual(parsed, [
    ['123.4', '7398', '59.9', '2'],
    ['12.0', '719', '59.9', '0'],
    ['1234.5', '123456', '100.0', '17'],
  ])
})

test('a progress line updates frames, rate, missed frames and liveness', () => {
  const state = createTrackerPreviewState()
  const handled = applyCollectorLine(state,
    '   123.4s     7398 frames ( 59.9/s, 2 missed)   12.34 MB  inning 1.0 0 out  holder=-1')
  // Progress is not a structured marker: the caller still logs the line.
  assert.equal(handled, false)
  const capture = trackerPreviewSnapshot(state).capture
  assert.equal(capture.status, 'recording')
  assert.equal(capture.frames, 7398)
  assert.equal(capture.frame_rate, 59.9)
  assert.equal(capture.missed_frames, 2)
  assert.equal(capture.duration_seconds, 123.4)
  assert.ok(capture.last_frame_age_ms >= 0)
})

test('a [live-play] marker becomes a play the console can join', () => {
  const state = createTrackerPreviewState()
  const play = trackingPlay({
    contact_timer: 4242, batted_ball_class: 'fair_caught', caught_in_flight: true,
    first_touch: firstTouch({ by: 'CF', character: 'Birdo' }),
    fielding_events: [possessionEvent({ by: 'CF', character: 'Birdo' })],
    primary_fielder: 'CF', primary_fielder_reason: 'catch',
  })
  const logged = []
  const handled = applyCollectorLine(state, `[live-play] ${JSON.stringify(play)}`,
    { log: (message) => logged.push(message) })
  assert.equal(handled, true)
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.capture.play_count, 1)
  assert.equal(snapshot.player_tracking_plays[0].contact_timer, 4242)
  assert.match(logged[0], /play at frame 4242: fair_caught, charged to CF/)
})

test('a [live-status] marker fills in calibration and derivation cost', () => {
  const state = createTrackerPreviewState()
  const handled = applyCollectorLine(state, `[live-status] ${JSON.stringify({
    status: 'recording', park: 'luigis_mansion', stadium_byte: 6,
    stem: 'data/player_tracking/luigis_mansion-fixture',
    calibration_status: 'confirmed', lock_frames: 60, position_offset: 4,
    plays_withheld: 2, mean_feed_ms: 0.031, max_feed_ms: 14.9,
    max_play_build_ms: 87, live_path: 'data/player_tracking/x.live.jsonl',
  })}`)
  assert.equal(handled, true)
  const capture = trackerPreviewSnapshot(state).capture
  assert.equal(capture.status, 'recording')
  assert.equal(capture.park, 'luigis_mansion')
  assert.equal(capture.stadium_byte, 6)
  assert.equal(capture.stem, 'data/player_tracking/luigis_mansion-fixture')
  assert.equal(trackerPreviewSnapshot(state).stadium_key, 'luigis_mansion')
  assert.equal(capture.calibration_status, 'confirmed')
  assert.equal(capture.calibration_lock_frames, 60)
  assert.equal(capture.position_offset, 4)
  assert.equal(capture.plays_withheld, 2)
  assert.equal(capture.mean_feed_ms, 0.031)
  assert.equal(capture.max_play_build_ms, 87)
})

test('a malformed marker is reported and dropped, never thrown', () => {
  const state = createTrackerPreviewState()
  const logged = []
  const log = (message) => logged.push(message)
  assert.equal(applyCollectorLine(state, '[live-play] {not json', { log }), true)
  assert.equal(applyCollectorLine(state, '[live-status] }{', { log }), true)
  assert.equal(trackerPreviewSnapshot(state).capture.play_count, 0)
  assert.equal(logged.length, 2)
  assert.match(logged[0], /could not read a live play/)
  assert.match(logged[1], /could not read a live status/)
})

test('ordinary collector chatter is left for the caller to log', () => {
  const state = createTrackerPreviewState()
  for (const line of [
    'fielders  P@0x900D5000  C@0x900D52EC',
    '  waiting for a pitch reset to calibrate the ball offset...',
    'recording -- play normally. Ctrl-C to stop.',
  ]) {
    assert.equal(applyCollectorLine(state, line), false, line)
  }
  const capture = trackerPreviewSnapshot(state).capture
  assert.equal(capture.frames, 0)
  assert.deepEqual(capture.recent_messages, [
    'fielders  P@0x900D5000  C@0x900D52EC',
    'waiting for a pitch reset to calibrate the ball offset...',
    'recording -- play normally. Ctrl-C to stop.',
  ])
})

// ── the recording handshake ─────────────────────────────────────────────────
//
// The one line on this feed that is evidence rather than description. A pid
// exists before python has imported anything and "[live-status] recording" is
// printed before the first frame is read; only this carries a frame count and
// a byte count off the disk.

test('capture-ready evidence marks the capture confirmed and says what proved it', () => {
  const state = createTrackerPreviewState()
  const seen = []
  const handled = applyCollectorLine(state, `${CAPTURE_READY_MARKER}${JSON.stringify({
    status: 'recording', ready: true, frames: 31, missed_frames: 0, bytes_on_disk: 8412,
    elapsed_s: 0.523, stem: 'data/player_tracking/wario_stadium-20260908T000000Z',
    park: 'wario_stadium', game_timer: 91234, calibration_status: 'pending',
  })}`, { onCaptureReady: (evidence) => seen.push(evidence) })
  assert.equal(handled, true, 'a structured marker is not also log output')
  const capture = trackerPreviewSnapshot(state).capture
  assert.equal(capture.recording_confirmed, true)
  assert.equal(capture.frames, 31)
  assert.equal(capture.bytes_on_disk, 8412)
  assert.equal(capture.first_frames_seconds, 0.523)
  assert.equal(capture.park, 'wario_stadium')
  assert.equal(capture.status, 'recording')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].ready, true)
})

test('evidence that proves nothing is reported as unconfirmed, with its reason', () => {
  const state = createTrackerPreviewState()
  const seen = []
  applyCollectorLine(state, `${CAPTURE_READY_MARKER}${JSON.stringify({
    ready: false, reason: 'no bytes written to the capture file',
    frames: 30, bytes_on_disk: 0, elapsed_s: 0.5,
  })}`, { onCaptureReady: (evidence) => seen.push(evidence) })
  const capture = trackerPreviewSnapshot(state).capture
  assert.equal(capture.recording_confirmed, false)
  assert.equal(capture.recording_evidence_reason, 'no bytes written to the capture file')
  assert.equal(seen[0].ready, false)
})

test('an unreadable evidence line answers the waiter rather than leaving it hanging', () => {
  const state = createTrackerPreviewState()
  const seen = []
  const logged = []
  const handled = applyCollectorLine(state, `${CAPTURE_READY_MARKER}{not json`, {
    log: (message) => logged.push(message),
    onCaptureReady: (evidence) => seen.push(evidence),
  })
  assert.equal(handled, true)
  assert.equal(seen.length, 1, 'silence here is a launcher that waits out its whole deadline')
  assert.equal(seen[0].ready, false)
  assert.match(seen[0].reason, /unreadable evidence line/)
  assert.match(logged.join('\n'), /could not read the capture-ready evidence/)
})

// ── attached, which is a different claim from recording ─────────────────────
//
// Recording evidence needs a running game clock: the frame counter only
// advances when the game's does. So it cannot be produced while gameplay is
// HELD, and holding gameplay is the only thing that actually protects the
// opening play. Attachment is what the collector can prove with the clock
// stopped, and it is what the hold waits for.

test('capture-attached is reported before a single frame, and is not "recording"', () => {
  const state = createTrackerPreviewState()
  const seen = []
  const handled = applyCollectorLine(state, `${CAPTURE_ATTACHED_MARKER}${JSON.stringify({
    status: 'attached',
    attached: true,
    stem: 'data/player_tracking/wario_stadium-20260908T000000Z',
    park: 'wario-stadium',
    stadium_byte: 5,
    ball_offset: 0x54,
    stream_path: 'data/player_tracking/wario_stadium-20260908T000000Z.bin',
    fielders: 9,
    offense: 4,
    game_timer: 0,
  })}`, { onCaptureAttached: (evidence) => seen.push(evidence) })

  assert.equal(handled, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].attached, true)
  assert.equal(state.playerTracking.capture.status, 'attached')
  assert.equal(state.playerTracking.capture.park, 'wario-stadium')
  // Deliberately NOT confirmed: nothing here says a frame was sampled, and the
  // game timer is zero because the game is held at the pitch reset.
  assert.notEqual(state.playerTracking.capture.recording_confirmed, true)
})

test('an unreadable attach line still answers whatever is holding the game', () => {
  const state = createTrackerPreviewState()
  const seen = []
  const messages = []
  applyCollectorLine(state, `${CAPTURE_ATTACHED_MARKER}{not json`, {
    log: (message) => messages.push(String(message)),
    onCaptureAttached: (evidence) => seen.push(evidence),
  })
  assert.equal(seen.length, 1, 'silence here would strand a paused match for the whole hold')
  assert.equal(seen[0].attached, false)
  assert.match(seen[0].reason, /unreadable attach line/)
  assert.ok(messages.some((message) => /could not read the capture-attached line/.test(message)))
})
