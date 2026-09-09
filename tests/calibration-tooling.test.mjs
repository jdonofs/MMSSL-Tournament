// The tooling that decides whether the next recorded game is worth playing.
//
// None of this fits a model, activates one, or moves a threshold. What it does
// is answer three questions that previously had no cheap answer: how far the
// Catch Probability gates are from passing, which recorded sessions are unusable
// and why, and what stadium-event evidence exists. So these tests are mostly
// about refusals and about honest "unknown" answers.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ACTIVATION_CRITERIA, buildGroupedSplit } from '../scripts/catch_probability_model.mjs'
import { gateProgress } from '../scripts/catch_probability_gate_status.mjs'
import { auditArchive, listCaptures } from '../scripts/audit_tracking_archive.mjs'
import { releaseSession, reserveSession } from '../scripts/reserve_calibration_session.mjs'
import { PARK_EVENTS, reviewStadiumEvents, timeOfDayFor } from '../scripts/review_stadium_events.mjs'

function tempDir(t, prefix = 'calibration-tooling-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── reserving a session for the untouched test ──────────────────────────────

// A fresh document per call: reserveSession mutates the one it is given, and a
// shared literal would let one test's reservation leak into the next.
function reservable() {
  return {
    captureExists: () => true,
    document: { schema_version: 1, reservations: [], released: [] },
  }
}

test('a session already fitted on cannot be reserved for the test set', () => {
  // Reserving a session for test AFTER a model has been fitted on it is
  // leakage with extra steps, and a tool that allowed it would be a tool for
  // choosing the hold-out once the answer is known.
  assert.throws(
    () => reserveSession({
      ...reservable(),
      session: 'mario_stadium-20260904T213725Z',
      split: { by_session: { 'mario_stadium-20260904T213725Z': 'train' } },
    }),
    /already in the train partition|leakage/,
  )
})

test('a deliberate override is allowed and is recorded as forced', () => {
  const result = reserveSession({
    ...reservable(),
    session: 'mario_stadium-20260904T213725Z',
    split: { by_session: { 'mario_stadium-20260904T213725Z': 'train' } },
    force: true,
    reason: 'this split is being discarded',
  })
  assert.equal(result.changed, true)
  assert.equal(result.document.reservations[0].forced, true)
  assert.equal(result.document.reservations[0].previous_partition, 'train')
})

test('a session that has never been split is reserved without argument', () => {
  const result = reserveSession({
    ...reservable(),
    session: 'wario_stadium-20260910T000000Z',
    reason: 'recorded to be held out',
    by: 'Jason',
    split: { by_session: {} },
  })
  assert.equal(result.changed, true)
  assert.equal(result.document.reservations[0].partition, 'test')
  assert.equal(result.document.reservations[0].previous_partition, null)
})

test('a reservation that points at no capture is refused', () => {
  assert.throws(
    () => reserveSession({
      session: 'never-recorded-20260910T000000Z',
      captureExists: () => false,
      document: { reservations: [], released: [] },
      split: null,
    }),
    /no capture named/,
  )
})

test('releasing a reservation keeps it as history rather than deleting it', () => {
  const reserved = reserveSession({
    ...reservable(), session: 'wario_stadium-20260910T000000Z', split: { by_session: {} },
  })
  const released = releaseSession('wario_stadium-20260910T000000Z', { document: reserved.document })
  assert.equal(released.changed, true)
  assert.equal(released.document.reservations.length, 0)
  assert.equal(released.document.released.length, 1)
  assert.ok(released.document.released[0].released_at)
})

test('a reserved session takes its whole capture group into the test partition', () => {
  // Six groups of ten. Without a reservation the hash ordering decides; with
  // one, the named group is in test whatever the hash says -- and its sibling
  // session goes with it, because a partition boundary that cuts through a
  // session is how a model ends up evaluated on plays it was fitted on.
  const opportunities = []
  for (const group of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']) {
    for (let index = 0; index < 10; index++) {
      opportunities.push({
        eligible: true,
        related_capture_group: group,
        session: `${group}-${index % 2 === 0 ? 'a' : 'b'}`,
        actual_catch: index < 7 ? 1 : 0,
      })
    }
  }
  const plain = buildGroupedSplit(opportunities, 'seed')
  const reservedGroup = Object.entries(plain.by_session)
    .find(([, partition]) => partition === 'train')[0]
  const groupId = reservedGroup.replace(/-[ab]$/, '')

  const withReservation = buildGroupedSplit(opportunities, 'seed', {
    reservations: [{ session: reservedGroup, partition: 'test' }],
  })
  assert.equal(withReservation.by_session[reservedGroup], 'test')
  assert.equal(withReservation.by_session[`${groupId}-a`], 'test')
  assert.equal(withReservation.by_session[`${groupId}-b`], 'test')
  // Recorded in the artifact, so the split stays reproducible from the files:
  // the hash ordering alone no longer determines it.
  assert.deepEqual(withReservation.reservations, [
    { group: groupId, partition: 'test', opportunities: 10 },
  ])
  assert.equal(withReservation.schema_version, 2)
})

// ── gate progress ───────────────────────────────────────────────────────────

const REJECTED_EVALUATION = {
  activation: {
    checks: {
      eligible_sample: false, failures: false, final_test_sample: false,
      final_test_failures: false, calibration: false, probability_bin_coverage: false,
      sensitivity: false, brier_improvement: true, session_dominance: true,
      park_dominance: true, grouped_uncertainty: true, no_post_outcome_predictors: true,
      predictor_family_coverage: true,
    },
    diagnostics: {
      session: { counts: { a: 150, b: 136 }, maximum_share: 0.14 },
      park: { maximum_share: 0.21 },
      relative_brier_improvement: 0.32,
      sensitivity_changes: [{ name: 'exclude_assisted_movement', absolute_brier_change: 0.121 }],
    },
  },
  sensitivity: {
    strict: {
      metrics: {
        n: 51, failures: 12, ece: 0.1062,
        calibration: [{ n: 20 }, { n: 9 }, { n: 7 }],
      },
    },
  },
  final_test: { grouped_bootstrap: { lower_95: 0.0575 } },
}

test('every failing gate is reported with the distance to its threshold', () => {
  const gates = gateProgress(REJECTED_EVALUATION, {
    partitions: { train: { failures: 39 }, validation: { failures: 24 }, test: { failures: 12 } },
  })
  const byName = Object.fromEntries(gates.map((gate) => [gate.gate, gate]))
  assert.equal(byName.eligible_sample.measured, 286)
  assert.equal(byName.eligible_sample.target, ACTIVATION_CRITERIA.minimum_eligible_opportunities)
  assert.equal(byName.eligible_sample.passed, false)
  assert.equal(byName.failures.measured, 75)
  assert.equal(byName.final_test_sample.measured, 51)
  assert.equal(byName.final_test_failures.measured, 12)
  assert.equal(byName.calibration.measured, 0.1062)
  assert.equal(byName.probability_bin_coverage.measured, 1,
    'only one bin has the required rows')
  assert.equal(byName.sensitivity.measured, 0.121)
  assert.equal(gates.filter((gate) => !gate.passed).length, 7)
})

test('the report reads its thresholds from the frozen criteria and cannot lower one', () => {
  const gates = gateProgress(REJECTED_EVALUATION)
  for (const gate of gates) {
    if (typeof gate.target !== 'number') continue
    const declared = Object.values(ACTIVATION_CRITERIA).filter((value) => typeof value === 'number')
    if (gate.gate === 'grouped_uncertainty') continue // its threshold is literally zero
    assert.ok(declared.includes(gate.target),
      `${gate.gate} compares against ${gate.target}, which is not one of the declared criteria`)
  }
  assert.ok(Object.isFrozen(ACTIVATION_CRITERIA))
})

test('a gate the evaluation says failed is never reported as passing', () => {
  const gates = gateProgress({
    ...REJECTED_EVALUATION,
    // A measured value that looks fine on its own; the check still says false.
    sensitivity: { strict: { metrics: { n: 900, failures: 900, ece: 0.001, calibration: [] } } },
  })
  assert.equal(gates.find((gate) => gate.gate === 'final_test_sample').passed, false)
  assert.equal(gates.find((gate) => gate.gate === 'calibration').passed, false)
})

// ── the archive audit ───────────────────────────────────────────────────────

function writeCapture(dir, stem, header = {}, { plays = 1, bin = true, annotations = null } = {}) {
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({
    park: 'mario_stadium', recorded_utc: stem.split('-').pop(),
    frames: 600, missed_frames: 0, duration_seconds: 10, ...header,
  }))
  if (bin) fs.writeFileSync(path.join(dir, `${stem}.bin`), 'MSSTRK')
  if (plays != null) {
    fs.writeFileSync(path.join(dir, `${stem}.plays.jsonl`),
      Array.from({ length: plays }, (_, index) => JSON.stringify({ contact_timer: index })).join('\n'))
  }
  if (annotations) {
    fs.writeFileSync(path.join(dir, `${stem}.annotations.jsonl`),
      annotations.map((row) => JSON.stringify(row)).join('\n'))
  }
}

function writeLog(dir, name, startedAt) {
  fs.writeFileSync(path.join(dir, name),
    `[tracker-preview] session started ${startedAt}\n13:00:00 [INFO] Dolphin hooked.\n`)
}

test('a capture with no paired tracker log is named as unusable for anything batter-shaped', (t) => {
  const captures = tempDir(t)
  const logs = tempDir(t, 'calibration-logs-')
  writeCapture(captures, 'wario_stadium-20260826T005958Z')
  const audit = auditArchive({ trackingDir: captures, logDir: logs })
  assert.equal(audit.totals.sessions, 1)
  assert.equal(audit.totals.paired, 0)
  assert.match(audit.sessions[0].problems.join(' '), /no paired tracker log/)
})

test('a log started just before a capture is its pair; one started after is not', (t) => {
  const captures = tempDir(t)
  const logs = tempDir(t, 'calibration-logs-')
  writeCapture(captures, 'mario_stadium-20260904T213725Z')
  writeLog(logs, 'preview-earlier.log', '2026-09-04T21:36:50.000Z')
  writeLog(logs, 'preview-later.log', '2026-09-04T21:38:00.000Z')
  const audit = auditArchive({ trackingDir: captures, logDir: logs })
  assert.equal(audit.sessions[0].paired_log, 'preview-earlier.log')
  assert.equal(audit.sessions[0].paired_gap_seconds, 35)
  assert.deepEqual(audit.unpairedLogs.map((log) => log.name), ['preview-later.log'])
})

test('an incomplete capture footer is reported without calling the session unusable', (t) => {
  const captures = tempDir(t)
  const logs = tempDir(t, 'calibration-logs-')
  writeCapture(captures, 'yoshi_park-20260831T134815Z', {
    frames: null, missed_frames: null, duration_seconds: null,
  })
  writeLog(logs, 'preview-paired.log', '2026-08-31T13:47:30.000Z')
  const audit = auditArchive({ trackingDir: captures, logDir: logs })
  const [row] = audit.sessions
  assert.deepEqual(row.incomplete_footer, ['frames', 'duration_seconds', 'missed_frames'])
  assert.match(row.problems.join(' '), /surviving plays are usable/)
  assert.equal(row.derived_plays, 1, 'its plays still count')
})

test('a capture nobody has derived is reported as absent from every calibration count', (t) => {
  const captures = tempDir(t)
  const logs = tempDir(t, 'calibration-logs-')
  writeCapture(captures, 'dk_jungle-20260910T120000Z', {}, { plays: null })
  const audit = auditArchive({ trackingDir: captures, logDir: logs })
  assert.match(audit.sessions[0].problems.join(' '), /never derived/)
  assert.equal(audit.totals.derived, 0)
})

test('the audit lists only real captures, not calibration or manifest sidecars', (t) => {
  const captures = tempDir(t)
  writeCapture(captures, 'mario_stadium-20260910T120000Z')
  fs.writeFileSync(path.join(captures, 'mario_stadium-20260910T120000Z.calibration.json'), '{}')
  fs.writeFileSync(path.join(captures, 'season-4242.manifest.json'), '{}')
  assert.deepEqual(
    listCaptures(captures).map((stem) => path.basename(stem)),
    ['mario_stadium-20260910T120000Z'],
  )
})

// ── stadium events ──────────────────────────────────────────────────────────

test('a session with no day/night bytes is unknown, never assumed to be day', () => {
  assert.equal(timeOfDayFor({ day_night_bytes: [0, 0] }), 'day')
  assert.equal(timeOfDayFor({ day_night_bytes: [1, 1] }), 'night')
  assert.equal(timeOfDayFor({ is_night: true }), 'night')
  // Sessions before 2026-09-02 carry neither, and docs/tracker-validation-console.md
  // puts two Luigi's Mansion rows in doubt for exactly this reason.
  assert.equal(timeOfDayFor({}), 'unknown')
  assert.equal(timeOfDayFor({ day_night_bytes: null }), 'unknown')
})

test('prose about a hazard is a candidate to label, never a stadium event', (t) => {
  const captures = tempDir(t)
  writeCapture(captures, 'dk_jungle-20260910T120000Z', { park: 'dk_jungle' }, {
    annotations: [
      { pa_number: 7, note: 'blue noki gets sprayed by the flower after catching the ball',
        categories: ['other'], play_contact_timer: 5406 },
      { pa_number: 9, note: 'nothing unusual here', categories: ['other'], play_contact_timer: 6000 },
    ],
  })
  const review = reviewStadiumEvents({ trackingDir: captures, park: 'dk_jungle' })
  const [session] = review.sessions
  assert.equal(session.labelled.length, 0, 'prose is not an event')
  assert.equal(session.candidates.length, 1)
  assert.equal(session.candidates[0].pa_number, 7)
  assert.equal(review.parks.dk_jungle.events.find((event) => event.id === 'flower_gas').labelled, 0)
})

test('a structured label counts, and a labelled event with no control says so', (t) => {
  const captures = tempDir(t)
  writeCapture(captures, 'dk_jungle-20260910T120000Z',
    { park: 'dk_jungle', day_night_bytes: [0, 0] }, {
      annotations: [{
        pa_number: 11,
        note: 'stadium_event=flower_gas; outcome=fielder dazed before the throw; control=no',
        categories: ['stadium_event'],
        play_contact_timer: 10904,
        player_tracking_postgame: {
          contact_timer: 10904, primary_fielder: 'CF',
          fielders: { CF: { character_id: 12, stun_frames: 91 } },
        },
      }],
    })
  const review = reviewStadiumEvents({ trackingDir: captures, park: 'dk_jungle' })
  const flower = review.parks.dk_jungle.events.find((event) => event.id === 'flower_gas')
  assert.equal(flower.labelled, 1)
  assert.equal(flower.controls, 0)
  assert.equal(flower.by_time_of_day.day, 1)
  assert.match(flower.needs, /control/i)
  // The alignment is what makes the label investigable a month later.
  const [event] = review.sessions[0].labelled
  assert.equal(event.alignment.contact_frame, 10904)
  assert.equal(event.alignment.primary_fielder, 'CF')
  assert.deepEqual(event.alignment.actors, [
    { position: 'CF', character_id: 12, frozen_frames: null, stun_frames: 91,
      knockdown_frames: null, glide_assisted: null, path_units: null },
  ])
})

test('an event with no detector says the object has to be found first', () => {
  const review = reviewStadiumEvents({ trackingDir: tempDirLess(), park: 'bowser_castle' })
  for (const event of review.parks.bowser_castle.events) {
    assert.equal(event.detector, null)
    assert.match(event.needs, /not in the captured region/)
  }
  // The catalogue is the document's, not the detectors': a park with nothing
  // captured still lists every event it would need.
  assert.equal(PARK_EVENTS.bowser_castle.length, 5)
})

// A directory that exists and holds nothing, for the catalogue-only checks.
function tempDirLess() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-empty-'))
  return dir
}
