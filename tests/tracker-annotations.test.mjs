import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ANNOTATION_CATEGORIES,
  annotationPathFor,
  appendTrackerAnnotation,
  buildTrackerAnnotation,
  readTrackerAnnotations,
} from '../scripts/tracker_annotations.mjs'
import { createTrackerPreviewServer } from '../scripts/tracker_preview_server.mjs'
import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPlay,
  createTrackerPreviewState,
  setTrackerPreviewCaptureHealth,
  setTrackerPreviewStadiumOverride,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'
import { firstTouch, possessionEvent, trackingPlay } from './helpers/trackerFixtures.mjs'

// An annotation exists to be read a week later by someone who no longer has the
// game, the emulator, or their memory of the play. So the tests are about
// whether the record stands on its own, and about the one hard guarantee: this
// path writes to a file and touches nothing else.

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-annotations-'))
  return path.join(dir, name)
}

// A session with one finished at-bat and its 60 Hz play, built through the real
// parser so the snapshot is the real shape.
function sessionWithAtBat() {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  setTrackerPreviewCaptureHealth(state, { stem: 'data/player_tracking/fixture', status: 'recording' })
  for (const line of [
    'Next: Top of inning 1',
    'Bowser vs. Luigi',
    '0 outs',
    'Count: 0-0',
    'Fair ball!',
    "Luigi's hit was caught!",
    'Birdo put Luigi out!',
  ]) applyTrackerPreviewMessage(state, line)
  applyTrackerPreviewPlay(state, trackingPlay({
    batter: 'Luigi', inning: 1, inning_half: 0, balls: 0, strikes: 0,
    batted_ball_class: 'fair_caught', caught_in_flight: true,
    first_touch: firstTouch({ by: 'RF', character: 'Birdo' }),
    fielding_events: [possessionEvent({ by: 'RF', character: 'Birdo' })],
    primary_fielder: 'RF', primary_fielder_reason: 'catch',
  }))
  return state
}

test('the category list is the one the console offers', () => {
  assert.deepEqual(ANNOTATION_CATEGORIES, [
    'wrong_result', 'wrong_player', 'wrong_location', 'wrong_trajectory',
    'wrong_attempt', 'wrong_contact', 'wrong_possession', 'wrong_ability',
    'wrong_throw', 'wrong_runner', 'missing_event', 'wrong_measurement',
    'stadium_event', 'other',
  ])
})

test('a flag records the session, the play, the narrative and the warnings', () => {
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)
  const { record, error } = buildTrackerAnnotation({
    snapshot, categories: ['wrong_possession'], note: 'Birdo never touched it',
  })
  assert.equal(error, undefined)

  // identity
  assert.equal(record.pa_number, snapshot.display_at_bat.pa_number)
  assert.equal(record.inning, 1)
  assert.equal(record.half, 'top')
  assert.equal(record.batter_name, 'Luigi')
  assert.equal(record.pitcher_name, 'Bowser')
  assert.equal(record.session.stadium_key, 'mario_stadium')
  assert.equal(record.session.capture_stem, 'data/player_tracking/fixture')
  assert.equal(record.play_contact_timer, 10000)
  assert.equal(record.count_at_contact, '0-0')

  // the complete interpretation travels with it
  assert.ok(record.narrative.summary)
  assert.ok(record.narrative.sentences.length >= 2)
  assert.ok(record.narrative.clauses.length >= 2)
  assert.ok(Array.isArray(record.warnings))
  assert.ok(record.checks)

  // and the structured payload behind it
  assert.equal(record.plate_appearance.pa_number, record.pa_number)
  assert.equal(record.player_tracking_play.contact_timer, 10000)
  assert.ok(record.play_geometry)
  assert.ok(record.capture)

  assert.equal(record.effect, 'local_annotation_only')
  assert.ok(record.recorded_at)
})

test('a flag on one clause records that clause and its evidence', () => {
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)
  const clause = snapshot.interpretation.clauses.find((entry) => entry.category === 'possession')
  const { record } = buildTrackerAnnotation({
    snapshot, categories: ['wrong_possession'], clauseId: clause.id,
  })
  assert.equal(record.clause.id, clause.id)
  assert.equal(record.clause.text, clause.text)
  assert.deepEqual(record.clause.evidence, clause.evidence)
  // The whole narrative is still there, so the clause has context.
  assert.equal(record.narrative.clauses.length, snapshot.interpretation.clauses.length)
})

test('text is optional but a category is not', () => {
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)

  const noText = buildTrackerAnnotation({ snapshot, categories: ['wrong_result'] })
  assert.equal(noText.error, undefined)
  assert.equal(noText.record.note, '')

  const noCategory = buildTrackerAnnotation({ snapshot, categories: [], note: 'something' })
  assert.match(noCategory.error, /at least one category/)
})

test('an unknown category is refused rather than stored', () => {
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)
  const result = buildTrackerAnnotation({ snapshot, categories: ['wrong_vibes'] })
  assert.match(result.error, /Unknown annotation category: wrong_vibes/)
})

test('a flag on a clause that does not exist is refused', () => {
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)
  const result = buildTrackerAnnotation({ snapshot, categories: ['other'], clauseId: 'c99-nonsense' })
  assert.match(result.error, /No narrative clause with id c99-nonsense/)
})

test('annotations append as JSONL and read back in order', () => {
  const file = tempFile('session.annotations.jsonl')
  const state = sessionWithAtBat()
  const snapshot = trackerPreviewSnapshot(state)
  for (const category of ['wrong_result', 'wrong_ability', 'missing_event']) {
    const { record } = buildTrackerAnnotation({ snapshot, categories: [category] })
    appendTrackerAnnotation(file, record)
  }
  const read = readTrackerAnnotations(file)
  assert.equal(read.length, 3)
  assert.deepEqual(read.map((entry) => entry.categories[0]),
    ['wrong_result', 'wrong_ability', 'missing_event'])
  // One object per line, so a partially written file still parses.
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3)
})

test('reading a file that does not exist yet returns nothing rather than throwing', () => {
  assert.deepEqual(readTrackerAnnotations(tempFile('never-written.jsonl')), [])
})

test('the annotation file is named for the capture it belongs beside', () => {
  assert.equal(annotationPathFor('data/player_tracking/wario-1.bin'),
    'data/player_tracking/wario-1.annotations.jsonl')
  assert.equal(annotationPathFor('data/player_tracking/wario-1'),
    'data/player_tracking/wario-1.annotations.jsonl')
  assert.match(annotationPathFor(null, { label: 'preview' }), /preview\.annotations\.jsonl$/)
})

test('POST /annotations persists a flag and never touches the at-bat', async () => {
  const file = tempFile('http.annotations.jsonl')
  const state = sessionWithAtBat()
  const before = JSON.stringify(trackerPreviewSnapshot(state).display_at_bat)

  const server = createTrackerPreviewServer({ state, port: 0, annotationPath: () => file })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const paNumber = trackerPreviewSnapshot(state).display_at_bat.pa_number
    const response = await fetch(`http://127.0.0.1:${port}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pa_number: paNumber, categories: ['wrong_contact'], note: 'no contact happened' }),
    })
    assert.equal(response.status, 201)
    const saved = await response.json()
    assert.equal(saved.saved, true)
    assert.equal(saved.pa_number, paNumber)

    const listed = await (await fetch(`http://127.0.0.1:${port}/annotations`)).json()
    assert.equal(listed.count, 1)
    assert.equal(listed.annotations[0].categories[0], 'wrong_contact')
    assert.equal(listed.annotations[0].note, 'no contact happened')
    assert.ok(listed.annotations[0].summary)

    // The at-bat is byte-for-byte what it was before the flag.
    assert.equal(JSON.stringify(trackerPreviewSnapshot(state).display_at_bat), before)
    const [record] = readTrackerAnnotations(file)
    assert.equal(record.schema_version, 4)
    assert.equal(record.player_tracking_play.fielding_events[0].character, 'Birdo')
    assert.equal(record.player_tracking_play.fielders != null, true)
    assert.equal(record.player_tracking_postgame, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST /annotations refuses a bad category with the list of good ones', async () => {
  const file = tempFile('bad.annotations.jsonl')
  const state = sessionWithAtBat()
  const server = createTrackerPreviewServer({ state, port: 0, annotationPath: () => file })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: ['nope'] }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.match(body.error, /Unknown annotation category/)
    assert.ok(body.categories.includes('wrong_result'))
    assert.equal(fs.existsSync(file), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST /annotations refuses an at-bat that is no longer on screen', async () => {
  const file = tempFile('stale.annotations.jsonl')
  const state = sessionWithAtBat()
  const server = createTrackerPreviewServer({ state, port: 0, annotationPath: () => file })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pa_number: 999, categories: ['other'] }),
    })
    assert.equal(response.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
