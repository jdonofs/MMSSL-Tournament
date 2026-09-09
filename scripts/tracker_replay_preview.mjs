// Serve the validation console from an ARCHIVED session, with no emulator.
//
//   node scripts/tracker_replay_preview.mjs --session data/player_tracking/<stem>
//   node scripts/tracker_replay_preview.mjs --session <stem> --live --speed 8
//
// WHY THIS EXISTS. The console is a tool for judging whether the tracker
// understood a play, and the only way to judge the tool is to look at it with
// real plays in it. Waiting for a human to play nine innings every time a
// sentence changes is not a development loop, and it is a terrible test: the
// interesting plays -- the boot that got recovered, the unresolved special
// action, the ambiguous join -- happen a few times a game and cannot be
// summoned on demand. The archive already contains hundreds of them.
//
// WHAT IS REAL AND WHAT IS RECONSTRUCTED. This matters enough that the page
// says so in its own banner rather than only in this comment:
//
//   REAL      Every 60 Hz play. Fielding events, contact classification,
//             possession, routes, throws, runners, landings -- all of it comes
//             straight out of the recorded .plays.jsonl, unmodified. So does
//             every pitch and how the batter offered at it, from
//             .pitches.jsonl, when the session has one.
//
//   REBUILT   The tracker log. The 60 Hz sessions were captured with the
//             collector running alone, so there is no matching tracker log for
//             any of them. The at-bat side is therefore reconstructed from
//             each play's own recorded situation (inning, half, outs, count,
//             batter, and the game's fair/foul and home-run calls), emitted as
//             the tracker's real log grammar and parsed by the real parser.
//
// So joins, narratives, warnings and the whole page are exercised end to end
// against real fielding data. What is NOT exercised is the tracker's own
// parsing of things the 60 Hz capture never saw -- pitch telemetry, walks,
// RBI lines -- because a reconstruction of those would be testing this file's
// imagination rather than the tracker.
//
// The reconstructed log holds a pitch only where the bat met the ball, so it is
// always short of the measured stream. The page is told not to read that as the
// tracker having missed pitches; in a replay there is no tracker log to miss
// them. See pitches_missing_from_log in tracker_preview_state.mjs.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPitch,
  applyTrackerPreviewPlay,
  applyTrackerPreviewPostgamePlay,
  createTrackerPreviewState,
  finalizeTrackerPreviewSession,
  setTrackerPreviewGameContext,
  setTrackerPreviewCaptureHealth,
  setTrackerPreviewStadiumOverride,
} from './tracker_preview_state.mjs'
import { createTrackerPreviewServer } from './tracker_preview_server.mjs'
import { annotationPathFor } from './tracker_annotations.mjs'

const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

function readArgs(argv) {
  const args = {
    session: null, port: 4317, live: false, speed: 6, limit: 0,
    annotations: null, gameId: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--session') args.session = argv[index += 1]
    else if (token === '--port') args.port = Number(argv[index += 1])
    else if (token === '--speed') args.speed = Number(argv[index += 1])
    else if (token === '--limit') args.limit = Number(argv[index += 1])
    else if (token === '--annotations') args.annotations = argv[index += 1]
    // Only for exercising the embedded scorebook tab, whose game-mismatch
    // banner needs a game context to disagree with. A replay is never a game.
    else if (token === '--game-id') args.gameId = argv[index += 1]
    else if (token === '--live') args.live = true
  }
  return args
}

// The measured pitch stream, when the session has one. Older sessions do not,
// and a replay of one has to look exactly as it did before rather than claiming
// every pitch was taken -- so this returns nothing and the offer column stays
// blank, which is the honest reading of "not measured".
function loadPitches(stem) {
  const file = `${String(stem).replace(/\.(json|bin|plays\.jsonl)$/, '')}.pitches.jsonl`
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

function loadPlays(stem, limit) {
  const file = `${String(stem).replace(/\.(json|bin|plays\.jsonl)$/, '')}.plays.jsonl`
  if (!fs.existsSync(file)) throw new Error(`No derived plays at ${file}`)
  const plays = fs.readFileSync(file, 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  return limit > 0 ? plays.slice(0, limit) : plays
}

// The defensive alignment at the moment of this play, read out of the capture
// itself: every fielder actor carries the character occupying that position.
function fieldingFor(play) {
  const fielding = {}
  for (const position of POSITIONS) {
    const entry = play.fielders?.[position]
    if (entry?.character) fielding[position] = entry.character
  }
  return fielding
}

function battingOrderFor(plays, half) {
  const order = new Map()
  for (const play of plays) {
    if (play.inning_half !== half) continue
    if (play.batter_index == null || play.batter_index < 0) continue
    if (!order.has(play.batter_index)) order.set(play.batter_index, play.batter)
  }
  return [...order.entries()].sort((a, b) => a[0] - b[0]).map(([, name]) => name)
}

/**
 * The tracker log lines this play would have produced.
 *
 * Only lines the 60 Hz capture actually justifies. A play whose outcome the
 * capture does not record (a base hit's exact value, an RBI) yields no line
 * claiming one, which is why some replayed at-bats finish with no result --
 * and that is honest: the reconstruction does not know, and the console's job
 * is to show what is and is not known.
 */
export function linesForPlay(play, previous, plays) {
  const lines = []
  const half = play.inning_half === 0 ? 'Top' : 'Bottom'
  const fielding = fieldingFor(play)
  const pitcher = fielding.P || 'Unknown Pitcher'

  if (!previous || previous.inning !== play.inning || previous.inning_half !== play.inning_half) {
    lines.push(`Next: ${half} of inning ${play.inning}`)
    const teamName = play.inning_half === 0 ? 'Away' : 'Home'
    const batting = battingOrderFor(plays, play.inning_half)
    if (batting.length) {
      lines.push(`[TRACKER_LINEUP] team=${teamName === 'Away' ? 'Home' : 'Away'}|batting=`
        + `${batting.join(',')}|fielding=`
        + `${POSITIONS.filter((position) => fielding[position])
          .map((position) => `${position}=${fielding[position]}`).join(',')}`)
    }
  }

  // A foul ball is another swing inside the SAME plate appearance, so it must
  // not open a new matchup -- doing so would fabricate an at-bat per foul and
  // then report every one of them as an unresolved result.
  const sameAtBat = previous
    && previous.inning === play.inning
    && previous.inning_half === play.inning_half
    && previous.batter === play.batter
    && previous.batter_index === play.batter_index
    && ['foul', 'foul_home_run'].includes(previous.batted_ball_class)

  if (!sameAtBat) {
    lines.push(`${pitcher} vs. ${play.batter}`)
    lines.push(`${play.outs} outs`)
    lines.push(`Count: ${play.balls}-${play.strikes}`)
  }

  if (['foul', 'foul_home_run'].includes(play.batted_ball_class)) {
    lines.push('Foul ball!')
    // The count only advances on a foul below two strikes.
    const strikes = Math.min(2, play.strikes + 1)
    lines.push(`Count: ${play.balls}-${strikes}`)
    return lines
  }

  lines.push('Fair ball!')

  // The batted-ball measurement, from the capture's own coordinates. Distance
  // and direction are computed from the recorded endpoint rather than invented.
  const endpoint = play.caught_in_flight ? play.first_touch?.at : play.landing?.at
  if (endpoint) {
    const [x, y, z] = endpoint
    const feetPerUnit = 3.2808
    const distance = Math.hypot(x, z) * feetPerUnit
    const spray = (Math.atan2(x, -z) * 180) / Math.PI
    const optionalFixed = (value, digits) => value != null && Number.isFinite(Number(value))
      ? Number(value).toFixed(digits)
      : 'none'
    const flightUpdates = play.live_s != null && Number.isFinite(Number(play.live_s))
      ? Math.round(Number(play.live_s) * 59.94)
      : 'none'
    lines.push('[TRACKER_BATTED_BALL_PROVISIONAL] '
      + `contact_seq=${play.contact_timer}|batter=${play.batter}|pitcher=${pitcher}`
      + '|exit_speed_mph=none|launch_degrees=none'
      + `|spray_degrees=${spray.toFixed(1)}`
      + `|side=${spray < -5 ? 'third_base' : spray > 5 ? 'first_base' : 'center'}`
      + `|endpoint=${play.caught_in_flight ? 'catch' : 'land'}`
      + `|endpoint_status=${play.caught_in_flight ? 'caught' : 'landed'}`
      + `|endpoint_seq=${play.first_touch?.frame ?? play.landing?.frame ?? play.contact_timer}`
      + `|x=${x}|y=${y}|z=${z}|distance_feet=${distance.toFixed(1)}`
      + '|projected_x=none|projected_z=none'
      + `|flight_updates=${flightUpdates}`
      + `|sampled_updates_seconds=${optionalFixed(play.live_s, 3)}`
      + `|hang_time_seconds=${optionalFixed(play.hang_time_s, 3)}`
      + `|feet_per_unit=${feetPerUnit}`)
  }

  if (play.batted_ball_class === 'home_run') {
    lines.push(`${play.batter} hits a homer off of ${pitcher}!`)
    return lines
  }
  if (play.batted_ball_class === 'fair_caught') {
    lines.push(`${play.batter}'s hit was caught!`)
    const catcher = play.first_touch?.character || fielding[play.primary_fielder]
    if (catcher) lines.push(`${catcher} put ${play.batter} out!`)
    return lines
  }
  if (play.batted_ball_class === 'home_run_robbed') {
    const catcher = play.first_touch?.character || fielding[play.primary_fielder]
    lines.push(`${play.batter}'s hit was caught!`)
    if (catcher) lines.push(`${catcher} went high up with the buddy jump to get the out!`)
    return lines
  }

  // fair_in_play. The capture records whether the batter-runner reached first
  // and whether an out was posted on a throw; that is enough for a single or a
  // groundout and not enough for anything else, so nothing else is claimed.
  const outsOnThrows = (play.throws || []).reduce(
    (total, entry) => total + Number(entry.outs_recorded || 0), 0)
  const batterReached = play.home_to_first_s != null
  if (outsOnThrows > 0 && !batterReached) {
    const receiver = (play.throws || []).find((entry) => entry.outs_recorded > 0)?.receiver_character
    if (receiver) lines.push(`${receiver} put ${play.batter} out!`)
  } else if (batterReached) {
    lines.push(`${play.batter} recorded a single!`)
  }
  return lines
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (!args.session) {
    console.error('Usage: node scripts/tracker_replay_preview.mjs --session <stem> [--port N] [--live] [--speed X] [--limit N]')
    process.exit(2)
  }
  const stem = String(args.session).replace(/\.(json|bin)$/, '')
  const plays = loadPlays(stem, args.limit)
  const pitches = loadPitches(stem)
  const header = JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8'))

  // archive_replay is a third mode alongside local_preview and live_bridge, and
  // the page shows it as loudly as it shows "RECORDING TO SUPABASE" -- an
  // operator must never mistake a replay for the game in front of them.
  const state = createTrackerPreviewState({ mode: 'archive_replay', writesEnabled: false })
  state.trackerStatus = `replaying ${path.basename(stem)} (${plays.length} recorded plays)`
  setTrackerPreviewStadiumOverride(state, header.park)

  setTrackerPreviewCaptureHealth(state, {
    status: 'stopped',
    stem,
    park: header.park,
    frames: header.frames ?? null,
    missed_frames: header.missed_frames ?? null,
    duration_seconds: header.duration_seconds ?? null,
    frame_rate: header.frames && header.duration_seconds
      ? Math.round((header.frames / header.duration_seconds) * 10) / 10
      : null,
    calibration_status: 'confirmed',
    position_offset: header.live_position_offset ?? 4,
    fielder_pointers_left_region: Boolean(header.fielder_pointers_left_region),
    note: 'archived capture replayed from disk; the tracker log is reconstructed',
    live_path: null,
  })

  if (args.gameId) {
    setTrackerPreviewGameContext(state, {
      game_id: args.gameId,
      games_table: 'replay (not a real game)',
    })
  }

  const annotationFile = args.annotations || annotationPathFor(stem)
  let server
  const shutdown = () => server.close(() => process.exit(0))
  server = createTrackerPreviewServer({
    state,
    port: args.port,
    annotationPath: () => annotationFile,
    onAnnotation: (record, filePath) => {
      console.log(`[replay] annotation saved for PA ${record.pa_number} -> ${filePath}`)
    },
    onShutdown: shutdown,
  })
  server.listen(args.port, '127.0.0.1', () => {
    console.log(`[replay] ${path.basename(stem)} — ${plays.length} plays`)
    console.log(`[replay] console feed: http://127.0.0.1:${args.port}/state`)
    console.log(`[replay] annotations:  ${annotationFile}`)
    console.log('[replay] DATABASE WRITES: DISABLED (this process has no Supabase client)')
  })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('message', (message) => {
    if (message?.type === 'tracker-preview-shutdown') shutdown()
  })

  const fedPitches = new Set()
  const feed = (play, previous) => {
    for (const line of linesForPlay(play, previous, plays)) {
      applyTrackerPreviewMessage(state, line)
    }
    applyTrackerPreviewPlay(state, { ...play, derivation: 'live' })
    // Every measured pitch up to this play's contact. The pitch that produced
    // it is included -- they share the swing frame -- so the at-bat has its
    // offers by the time the page renders the play.
    for (const pitch of pitches) {
      if (pitch.pitch_timer <= play.contact_timer && !fedPitches.has(pitch)) {
        fedPitches.add(pitch)
        applyTrackerPreviewPitch(state, pitch)
      }
    }
    // The same record as the authoritative restatement, so the live-versus-
    // postgame check has both sides to compare on a replay.
    applyTrackerPreviewPostgamePlay(state, play)
  }

  if (!args.live) {
    let previous = null
    for (const play of plays) {
      feed(play, previous)
      previous = play
    }
    finalizeTrackerPreviewSession(state)
    console.log(`[replay] fed ${plays.length} plays; ${state.completedBuffers.length} at-bats`)
    return
  }

  let index = 0
  let previous = null
  const interval = Math.max(200, Math.round(4000 / Math.max(args.speed, 0.1)))
  const timer = setInterval(() => {
    if (index >= plays.length) {
      clearInterval(timer)
      finalizeTrackerPreviewSession(state)
      console.log('[replay] session replayed to the end')
      return
    }
    const play = plays[index += 1 - 1]
    feed(play, previous)
    previous = play
    index += 1
    console.log(`[replay] play ${index}/${plays.length} — ${play.batter}, ${play.batted_ball_class}`)
  }, interval)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('[replay]', error.message)
    process.exit(1)
  })
}
