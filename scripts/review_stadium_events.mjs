// The stadium-event evidence, gathered and aligned, park by park.
//
//   node scripts/review_stadium_events.mjs
//   node scripts/review_stadium_events.mjs --park dk_jungle
//   node scripts/review_stadium_events.mjs --json
//   node scripts/review_stadium_events.mjs --unstructured      (show the prose candidates)
//
// WHY THIS EXISTS. docs/tracker-validation-console.md holds a stadium-event
// completeness gate: one individually named record for every gameplay-changing
// event type in every park, and it is deliberately not open. Two concrete
// things stood between the archive and answering that:
//
//   * "the eleven DK labels to date exist only as English prose and had to be
//     read by hand to be counted." parseStadiumEventNote() understands a
//     structured label; nothing collected them, so counting them meant opening
//     each annotation file.
//   * "Only sessions from 2026-09-02 on record the day/night bytes at all...
//     the two Luigi's Mansion sessions predate that and record neither, so the
//     variant they were played in is unknown." That is a per-session fact in
//     the capture header, and nothing put it beside the events.
//
// This reads both, aligns every labelled event with the frame and the actors
// the capture holds for it, and says per park what is present and what is not.
//
// WHAT IT WILL NOT DO. It does not invent a cause. A prose note that mentions a
// barrel is reported as an UNSTRUCTURED CANDIDATE -- an operator's words that
// nobody has converted into a label -- and never as a stadium event. It does not
// open the completeness gate, does not enable a detector, and writes nothing.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parseStadiumEventNote, readTrackerAnnotations } from './tracker_annotations.mjs'
import { listCaptures } from './audit_tracking_archive.mjs'

const TRACKING_DIR = path.resolve('data/player_tracking')

// The catalogue from docs/tracker-validation-console.md, verbatim in substance:
// the gameplay events each park would need an individual record for, and what
// the capture can see today. `detector` names a field the collector actually
// reads; null means the cause is not captured and the row is open.
//
// Kept here so the report cannot drift from the document silently, and so that
// adding a row is a deliberate edit rather than a side effect of a detector.
export const PARK_EVENTS = Object.freeze({
  mario_stadium: [
    { id: 'none', label: 'no gameplay events; day/night is cosmetic', detector: 'n/a', complete: true },
  ],
  wario_city: [
    { id: 'arrow_redirect', label: 'directional-arrow ball redirect (stronger at night)', detector: null },
    { id: 'manhole_knockdown', label: 'manhole water launch / knockdown', detector: 'fielder+0x23F' },
  ],
  peach_ice_garden: [
    { id: 'freezie_collision', label: 'Freezie collision', detector: null },
    { id: 'player_freeze', label: 'player freeze', detector: 'fielder+0x240' },
    { id: 'freezie_break', label: 'Freezie break', detector: null },
    { id: 'night_blackout', label: 'night snowflake blackout / spotlight', detector: null },
  ],
  daisy_cruiser: [
    { id: 'table_collision', label: 'day table collision / break / player stun', detector: 'fielder+0x243' },
    { id: 'cheep_cheep', label: 'night Cheep Cheep collision', detector: null },
    { id: 'gooper_tilt', label: 'night Gooper Blooper field tilt', detector: null },
  ],
  yoshi_park: [
    { id: 'pipe_teleport', label: 'day pipe entry / exit', detector: null },
    { id: 'piranha_plant', label: 'night Piranha Plant eat / spit / player hit', detector: null },
    { id: 'train_collision', label: 'train collision', detector: null },
  ],
  dk_jungle: [
    { id: 'root_slowdown', label: 'tree-root slowdown', detector: null },
    { id: 'barrel_collision', label: 'barrel collision (flaming at night)', detector: '0x92AF5490' },
    { id: 'flower_gas', label: 'poison-flower gas', detector: 'fielder+0x242' },
    { id: 'dk_statue_pow', label: 'night DK-statue POW stun', detector: null },
  ],
  bowser_jr_playroom: [
    { id: 'thwomp_impact', label: 'Thwomp impact / break', detector: null },
    { id: 'chain_chomp', label: 'Chain Chomp spawn / hit', detector: null },
    { id: 'bullet_bill', label: 'Bullet Bill spawn / hit', detector: null },
  ],
  luigis_mansion: [
    { id: 'gravestone_ghost', label: 'gravestone hit / ghost attack', detector: 'fielder+0x243' },
    { id: 'tall_grass', label: 'tall-grass ball concealment', detector: null },
  ],
  bowser_castle: [
    { id: 'podoboo', label: 'Podoboo burn / drop', detector: null },
    { id: 'statue_fire', label: 'Bowser-statue fire', detector: null },
    { id: 'thwomp_block', label: 'Thwomp block', detector: null },
    { id: 'fireball_puddle', label: 'fireball puddle / burn', detector: null },
    { id: 'king_bobomb', label: 'King Bob-omb bomb', detector: null },
  ],
})

// Words an operator has actually used in this archive for a hazard. Matching
// one makes a note a CANDIDATE for labelling and nothing more: the whole point
// of the structured label is that a person decided what happened.
const HAZARD_WORDS = [
  'flower', 'barrel', 'freezie', 'froze', 'frozen', 'ghost', 'grave', 'thwomp',
  'chomp', 'bullet bill', 'manhole', 'arrow', 'pipe', 'piranha', 'train',
  'cheep', 'gooper', 'table', 'podoboo', 'lava', 'fireball', 'bob-omb', 'bobomb',
  'root', 'statue', 'spray', 'sprayed', 'stun', 'blackout',
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--json') args.json = true
    else if (flag === '--park') args.park = argv[++index]
    else if (flag === '--unstructured') args.unstructured = true
    else if (flag === '--help' || flag === '-h') args.help = true
  }
  return args
}

/** Day, night, or genuinely unknown. Never guessed from the park. */
export function timeOfDayFor(header) {
  if (header?.is_night === true) return 'night'
  if (header?.is_night === false) return 'day'
  const bytes = header?.day_night_bytes
  if (Array.isArray(bytes) && bytes.length) return bytes.some((value) => value) ? 'night' : 'day'
  // Sessions recorded before 2026-09-02 do not carry the bytes at all, and
  // "unknown" is a real third answer: docs/tracker-validation-console.md puts
  // two Luigi's Mansion rows in doubt for exactly this reason.
  return 'unknown'
}

/**
 * The actors and frames a labelled event can be aligned to.
 *
 * The annotation carries the whole preview snapshot the operator was looking
 * at, so the play's own frames and fielders are already in it; this pulls out
 * the fields an investigator needs beside the label rather than re-deriving
 * anything from the capture.
 */
export function alignEvent(annotation) {
  const play = annotation.player_tracking_postgame || annotation.player_tracking_play || null
  const fielders = play?.fielders || {}
  return {
    contact_frame: annotation.play_contact_timer ?? play?.contact_timer ?? null,
    pitch_release_frame: annotation.pitch_release_timer ?? play?.pitch_release_timer ?? null,
    dead_ball_frame: play?.dead_ball_timer ?? null,
    primary_fielder: play?.primary_fielder ?? null,
    // Every fielder the capture placed on the play, with the state flags that
    // are the only measured consequence side there is today.
    actors: Object.entries(fielders).map(([position, row]) => ({
      position,
      character_id: row.character_id ?? null,
      frozen_frames: row.frozen_frames ?? null,
      stun_frames: row.stun_frames ?? null,
      knockdown_frames: row.knockdown_frames ?? null,
      glide_assisted: row.assisted ?? null,
      path_units: row.path_units ?? null,
    })),
    barrel_events: play?.barrel_events || [],
    freezes: play?.freezes || [],
    possession_carries: (play?.possession_carries || []).map((carry) => ({
      position: carry.position ?? null, motion: carry.motion ?? null,
    })),
  }
}

export function reviewStadiumEvents({ trackingDir = TRACKING_DIR, park = null } = {}) {
  const sessions = []
  for (const stem of listCaptures(trackingDir)) {
    const annotationPath = `${stem}.annotations.jsonl`
    let header = {}
    try { header = JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8')) } catch { header = {} }
    if (park && header.park !== park) continue
    const annotations = readTrackerAnnotations(annotationPath)
    const labelled = []
    const candidates = []
    for (const annotation of annotations) {
      const note = annotation.note || ''
      const structured = annotation.stadium_event || parseStadiumEventNote(note)
      const entry = {
        pa_number: annotation.pa_number ?? null,
        inning: annotation.inning ?? null,
        half: annotation.half ?? null,
        recorded_at: annotation.recorded_at ?? null,
        categories: annotation.categories || [],
        note,
        alignment: alignEvent(annotation),
      }
      if (structured?.objective_id) {
        labelled.push({ ...entry, event: structured })
      } else if (HAZARD_WORDS.some((word) => note.toLowerCase().includes(word))) {
        // Prose. Reported so it can be converted into a label by the person who
        // wrote it -- not counted as an event, and no cause is inferred from it.
        candidates.push(entry)
      }
    }
    sessions.push({
      stem: path.basename(stem),
      park: header.park || null,
      stadium_byte: header.stadium_byte ?? null,
      time_of_day: timeOfDayFor(header),
      day_night_bytes: header.day_night_bytes ?? null,
      recorded_utc: header.recorded_utc || null,
      annotations: annotations.length,
      labelled,
      candidates,
    })
  }

  const parks = {}
  for (const [parkKey, events] of Object.entries(PARK_EVENTS)) {
    if (park && parkKey !== park) continue
    const parkSessions = sessions.filter((session) => session.park === parkKey)
    const seen = new Map()
    for (const session of parkSessions) {
      for (const row of session.labelled) {
        const id = row.event.objective_id
        const entry = seen.get(id) || { events: 0, controls: 0, day: 0, night: 0, unknown: 0 }
        entry.events += 1
        if (row.event.is_control === true) entry.controls += 1
        entry[session.time_of_day] += 1
        seen.set(id, entry)
      }
    }
    parks[parkKey] = {
      sessions: parkSessions.length,
      time_of_day: {
        day: parkSessions.filter((session) => session.time_of_day === 'day').length,
        night: parkSessions.filter((session) => session.time_of_day === 'night').length,
        unknown: parkSessions.filter((session) => session.time_of_day === 'unknown').length,
      },
      unstructured_candidates: parkSessions.reduce((sum, session) => sum + session.candidates.length, 0),
      events: events.map((event) => ({
        ...event,
        labelled: seen.get(event.id)?.events || 0,
        controls: seen.get(event.id)?.controls || 0,
        by_time_of_day: {
          day: seen.get(event.id)?.day || 0,
          night: seen.get(event.id)?.night || 0,
          unknown: seen.get(event.id)?.unknown || 0,
        },
        // What is still needed, stated rather than inferred. A row with no
        // detector needs the object located first; a row with one needs
        // labelled events (and at least one control) to calibrate it.
        needs: event.complete
          ? null
          : event.detector
            ? (seen.get(event.id)?.events
              ? (seen.get(event.id).controls ? null
                : 'a labelled CONTROL play (the same situation with the hazard absent)')
              : 'labelled events with `stadium_event=<id>; outcome=...; control=<yes|no>`')
            : 'the object itself is not in the captured region; see the probe runs in '
              + 'docs/tracker-validation-console.md before any labelling can help',
      })),
    }
  }

  return { generatedAt: new Date().toISOString(), parks, sessions }
}

function report(review, { unstructured = false } = {}) {
  console.log('Stadium-event evidence, per park')
  console.log('The completeness gate stays closed; nothing here opens it.')
  console.log()
  for (const [park, summary] of Object.entries(review.parks)) {
    const clock = summary.time_of_day
    console.log(`${park}  (${summary.sessions} session(s): `
      + `${clock.day} day, ${clock.night} night, ${clock.unknown} unknown time of day)`)
    for (const event of summary.events) {
      const detector = event.detector ? `detector ${event.detector}` : 'NO DETECTOR'
      const counts = event.labelled
        ? `${event.labelled} labelled (${event.controls} control), `
          + `day ${event.by_time_of_day.day} / night ${event.by_time_of_day.night} / `
          + `unknown ${event.by_time_of_day.unknown}`
        : 'no labelled events'
      console.log(`  ${event.complete ? 'ok' : (event.labelled ? '~ ' : 'X ')} `
        + `${event.id.padEnd(20)} ${detector.padEnd(22)} ${counts}`)
      if (event.needs) console.log(`       needs: ${event.needs}`)
    }
    if (summary.unstructured_candidates) {
      console.log(`  ${summary.unstructured_candidates} annotation(s) mention a hazard in prose and `
        + 'carry no structured label')
    }
    console.log()
  }
  if (!unstructured) {
    console.log('Run with --unstructured to list the prose notes that could be labelled.')
    return
  }
  console.log('Unstructured candidates (an operator\'s words; no cause is claimed here):')
  for (const session of review.sessions) {
    if (!session.candidates.length) continue
    console.log(`\n${session.stem}  [${session.time_of_day}]`)
    for (const candidate of session.candidates) {
      const align = candidate.alignment
      console.log(`  PA ${String(candidate.pa_number).padStart(3)}  `
        + `frame ${align.contact_frame ?? '?'}  `
        + `${align.primary_fielder ? `primary ${align.primary_fielder}` : 'no primary fielder'}  `
        + `${align.actors.length} actors`)
      console.log(`      "${candidate.note}"`)
      const flags = align.actors.filter(
        (actor) => actor.frozen_frames || actor.stun_frames || actor.knockdown_frames)
      for (const actor of flags) {
        console.log(`      measured: ${actor.position} frozen=${actor.frozen_frames ?? 0} `
          + `stun=${actor.stun_frames ?? 0} knockdown=${actor.knockdown_frames ?? 0}`)
      }
      if (align.barrel_events.length) console.log(`      barrel intervals: ${align.barrel_events.length}`)
      console.log(`      label it: stadium_event=<id>; outcome=...; control=<yes|no>`)
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/review_stadium_events.mjs [--park <key>] [--unstructured] [--json]')
    return 0
  }
  const review = reviewStadiumEvents({ park: args.park })
  if (args.json) console.log(JSON.stringify(review, null, 2))
  else report(review, { unstructured: args.unstructured })
  return 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
