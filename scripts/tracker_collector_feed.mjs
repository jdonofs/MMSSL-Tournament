// Reading the 60 Hz collector's stdout as a data feed.
//
// The collector prints three things a console cares about, mixed into ordinary
// human-readable log output:
//
//   [live-play] {...}     one completed play, at each dead ball
//   [live-pitch] {...}    one pitch, when its outcome is observed
//   [live-status] {...}   calibration, plays withheld, derivation cost
//   [capture-attached] {...} attached, resolved and the stream file open
//   [capture-ready] {...} frames sampled and flushed -- the recording evidence
//   "  12.0s  719 frames ( 59.9/s, 0 missed) ..."   its own progress line
//
// Two processes consume that feed -- the Supabase bridge and the read-only
// preview -- and they must agree exactly on what it means, because the capture
// health bar is the one part of the console that says whether to trust
// anything below it. So the parsing lives here rather than in either of them.
//
// A malformed marker is logged and dropped. Nothing on this path may be able to
// stop a capture or a Supabase write: it is a diagnostic surface, and the
// game's record does not depend on it.

import {
  applyTrackerPreviewPitch,
  applyTrackerPreviewPlay,
  setTrackerPreviewDetectedStadium,
  setTrackerPreviewCaptureHealth,
} from './tracker_preview_state.mjs'
import { noteCaptureMessage } from './tracker_preview_plays.mjs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const LIVE_PLAY_MARKER = '[live-play] '
export const LIVE_PITCH_MARKER = '[live-pitch] '
export const LIVE_STATUS_MARKER = '[live-status] '
// Printed once, by collect_player_tracking.py, after it has sampled frames AND
// flushed them to the .bin. It is the only line on this feed that is evidence
// rather than description: a pid proves a process exists, "[live-status]
// recording" is printed before the first frame is read, and neither says the
// capture has written anything. See CAPTURE_READY_MARKER there.
export const CAPTURE_READY_MARKER = '[capture-ready] '
// Printed BEFORE the first frame, by the same collector. It is what can be true
// with the game clock stopped -- attached, resolved, file open -- and therefore
// the only one of the two that gameplay can be held for: holding the game stops
// the clock, and the frame counter with it. See CAPTURE_ATTACHED_MARKER in
// collect_player_tracking.py.
export const CAPTURE_ATTACHED_MARKER = '[capture-attached] '

// The collector pads its numbers, so both the rate and the missed count can be
// preceded by spaces. A regex that assumed they were flush silently never
// matched, and the health bar sat on zero frames for a whole game.
export const COLLECTOR_PROGRESS_RE =
  /^\s*([\d.]+)s\s+(\d+) frames \(\s*([\d.]+)\/s,\s*(\d+) missed\)/

/**
 * Apply one line of collector output to a preview state.
 *
 * Returns true when the line was a structured marker (and so has already been
 * accounted for), false when it is just log output the caller should print.
 */
export function applyCollectorLine(state, line, {
  log = () => {}, onCaptureReady = null, onCaptureAttached = null,
} = {}) {
  const clean = String(line || '')
  noteCaptureMessage(state.playerTracking, clean)

  if (clean.startsWith(LIVE_PLAY_MARKER)) {
    try {
      const play = JSON.parse(clean.slice(LIVE_PLAY_MARKER.length))
      applyTrackerPreviewPlay(state, play)
      log(`play at frame ${play.contact_timer}: ${play.batted_ball_class}`
        + `${play.primary_fielder ? `, charged to ${play.primary_fielder}` : ''}`)
    } catch (error) {
      log(`could not read a live play: ${error.message}`)
    }
    return true
  }

  if (clean.startsWith(LIVE_PITCH_MARKER)) {
    try {
      const pitch = JSON.parse(clean.slice(LIVE_PITCH_MARKER.length))
      applyTrackerPreviewPitch(state, pitch)
      log(`pitch at frame ${pitch.pitch_timer}: ${pitch.offer}, ${pitch.outcome}`)
    } catch (error) {
      log(`could not read a live pitch: ${error.message}`)
    }
    return true
  }

  if (clean.startsWith(CAPTURE_ATTACHED_MARKER)) {
    try {
      const evidence = JSON.parse(clean.slice(CAPTURE_ATTACHED_MARKER.length))
      setTrackerPreviewCaptureHealth(state, {
        status: 'attached',
        attached_at: new Date().toISOString(),
        stem: evidence.stem,
        park: evidence.park,
        stadium_byte: evidence.stadium_byte,
        ball_offset: evidence.ball_offset,
      })
      log(`collector attached: ${evidence.park}, ball offset `
        + `+0x${Number(evidence.ball_offset || 0).toString(16).toUpperCase()}, `
        + `${evidence.fielders} fielders located`)
      onCaptureAttached?.(evidence)
    } catch (error) {
      log(`could not read the capture-attached line: ${error.message}`)
      onCaptureAttached?.({ attached: false, reason: `unreadable attach line: ${error.message}` })
    }
    return true
  }

  if (clean.startsWith(CAPTURE_READY_MARKER)) {
    try {
      const evidence = JSON.parse(clean.slice(CAPTURE_READY_MARKER.length))
      setTrackerPreviewCaptureHealth(state, {
        status: 'recording',
        recording_confirmed: Boolean(evidence.ready),
        recording_confirmed_at: new Date().toISOString(),
        frames: Number(evidence.frames) || 0,
        missed_frames: Number(evidence.missed_frames) || 0,
        bytes_on_disk: Number(evidence.bytes_on_disk) || 0,
        first_frames_seconds: Number(evidence.elapsed_s) || 0,
        stem: evidence.stem,
        park: evidence.park,
        calibration_status: evidence.calibration_status,
        recording_evidence_reason: evidence.reason || null,
      })
      log(evidence.ready
        ? `capture confirmed: ${evidence.frames} frames, ${evidence.bytes_on_disk} bytes `
          + `on disk after ${evidence.elapsed_s}s`
        : `capture NOT confirmed: ${evidence.reason || 'no evidence'}`)
      onCaptureReady?.(evidence)
    } catch (error) {
      log(`could not read the capture-ready evidence: ${error.message}`)
      // A marker this process cannot parse is not evidence, and silence would
      // leave a waiting launcher to time out on it. Say so in the shape the
      // waiter understands.
      onCaptureReady?.({ ready: false, reason: `unreadable evidence line: ${error.message}` })
    }
    return true
  }

  if (clean.startsWith(LIVE_STATUS_MARKER)) {
    try {
      const status = JSON.parse(clean.slice(LIVE_STATUS_MARKER.length))
      if (status.park) setTrackerPreviewDetectedStadium(state, status.park)
      setTrackerPreviewCaptureHealth(state, {
        status: status.status,
        park: status.park,
        stadium_byte: status.stadium_byte,
        stem: status.stem,
        calibration_status: status.calibration_status,
        calibration_lock_frames: status.lock_frames,
        position_offset: status.position_offset,
        plays_withheld: status.plays_withheld,
        pitches_emitted: status.pitches_emitted,
        mean_feed_ms: status.mean_feed_ms,
        max_feed_ms: status.max_feed_ms,
        max_play_build_ms: status.max_play_build_ms,
        live_path: status.live_path,
      })
    } catch (error) {
      log(`could not read a live status: ${error.message}`)
    }
    return true
  }

  const progress = clean.match(COLLECTOR_PROGRESS_RE)
  if (progress) {
    setTrackerPreviewCaptureHealth(state, {
      status: 'recording',
      frames: Number(progress[2]),
      frame_rate: Number(progress[3]),
      missed_frames: Number(progress[4]),
      duration_seconds: Number(progress[1]),
      last_frame_at: new Date().toISOString(),
    })
  }
  return false
}


// THE EVIDENCE PROFILE, CHECKED BEFORE ANY GAME. The collector refuses the
// comprehensive profile without a valid session metadata file (who held which
// remote), but it only gets to say so once a match is live -- and a launcher
// that retries it every few seconds would let the whole one-shot calibration
// game be played with nothing recorded. Both launchers call this first.
//
// Returns null for the standard profile, else the validator's summary. Throws
// with the validator's own reasons otherwise.
export function assertEvidenceProfileReady(environment = process.env, run = spawnSync) {
  if (environment.TRACKER_PLAYER_TRACKING === '0') return null
  const profile = String(environment.TRACKER_EVIDENCE_PROFILE || 'standard').trim()
  if (profile === 'standard') return null
  if (profile !== 'comprehensive') {
    throw new Error(`TRACKER_EVIDENCE_PROFILE must be standard or comprehensive, not ${profile}`)
  }
  const metadata = String(environment.TRACKER_SESSION_METADATA || '').trim()
  if (!metadata) {
    throw new Error('TRACKER_EVIDENCE_PROFILE=comprehensive needs TRACKER_SESSION_METADATA: '
      + 'the file stating which player held which remote in which port. Create it with '
      + '`python scripts/evidence_preflight.py map-remotes`.')
  }
  const python = String(environment.TRACKER_PLAYER_PYTHON || 'python')
  const check = run(python, [
    path.resolve('scripts/capture_evidence_schema.py'),
    '--validate-metadata', path.resolve(metadata),
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: environment })
  if (check.error || check.status !== 0) {
    const detail = check.error?.message || String(check.stderr || '').trim()
      || `exit code ${check.status}`
    throw new Error(`Session metadata ${metadata} is not usable: ${detail}`)
  }
  return JSON.parse(String(check.stdout || '{}'))
}

// The same two settings as collector arguments, resolved from whichever
// environment the launcher validated -- the bridge merges .env.tracker-bridge
// into its own copy, which a spawned child would not otherwise inherit.
export function collectorEvidenceArgs(environment = process.env) {
  const profile = String(environment.TRACKER_EVIDENCE_PROFILE || '').trim()
  const metadata = String(environment.TRACKER_SESSION_METADATA || '').trim()
  return [
    ...(profile ? ['--evidence-profile', profile] : []),
    ...(metadata ? ['--session-metadata', path.resolve(metadata)] : []),
  ]
}
