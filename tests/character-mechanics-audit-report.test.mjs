// The audit report's closing sections, against synthetic audit objects.
//
//   node --test tests/character-mechanics-audit-report.test.mjs
//
// WHY THIS EXISTS. The epilogue used to be a list of string literals: "70 of
// 72 ... 53 of 55 ... exactly two ... exactly one boosted session ... not
// recorded in the ledger". Every one was true when it was typed and none was
// connected to the numbers printed above it, so the report would have gone on
// asserting them after a re-ingest, after the correction was applied, or after
// a second Wario Stadium capture -- and it would have looked exactly as
// authoritative while doing it.
//
// These tests hand `buildReportEpilogue` an audit object and check that the
// prose followed. They are FIXTURE tests on purpose: no database, no archive,
// nothing that moves. What is under test is the dependency between the numbers
// and the sentences, not the numbers.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReportEpilogue, readPreparedMigration } from '../scripts/audit_character_mechanics.mjs'

const text = (audit) => buildReportEpilogue(audit).join('\n')

// A run that looks like 2026-09-21: two attribute exceptions, one boosted
// session, the correction prepared and not applied. Every test below starts
// here and changes ONE thing, so a difference in the output is attributable.
function baseAudit(overrides = {}) {
  return {
    speedAgreement: {
      charactersWithConstant: 55,
      charactersReproducingTheCurve: 53,
      ofWhichInterpolatedRatings: 19,
      medianAbsErrorFps: 0.00026,
      worstAbsErrorFps: 0.000484,
      roundingFloorFps: 0.0005,
      toleranceFps: 0.01,
      // The observed constants matter: "the profile differs from the column"
      // and "the profile is what the game actually holds" are two claims and
      // only the second is evidence for a correction.
      charactersWithNoCurveMatch: [
        {
          name: 'Green Paratroopa', runSpeed: 64, profileRunSpeed: 52,
          expectedOrdinaryFps: 26.4302, expectedFromProfileFps: 25.7223, observed: [25.722],
        },
        {
          name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
          expectedOrdinaryFps: 25.3683, expectedFromProfileFps: 25.565, observed: [25.565],
        },
      ],
    },
    archiveSpeedAgreement: {
      scanned: true,
      sessionsScanned: 41,
      charactersWithARating: 72,
      charactersReproducingTheCurve: 70,
      ofWhichInterpolatedRatings: 24,
      sessionsShowingTheBoost: [{
        stem: 'wario_stadium-20260826T005958Z', characters: 16,
        park: 'wario_stadium', parkSessionsScanned: 1, parkSessionsBoosted: 1,
      }],
      sessionsScannedByPark: { wario_stadium: 1, mario_stadium: 4 },
    },
    catchReach: {
      tableMissing: false,
      trackedGames: 7,
      perTrackedGame: {
        ordinary: { qualifyingAttemptsPerGame: 5.86, qualifyingSecuredPerGame: 5.43 },
        dive: { qualifyingAttemptsPerGame: 7.71, qualifyingSecuredPerGame: 2.29 },
      },
    },
    runnerSprint: {
      analyses: [{
        pearsonVsRunSpeed: 0.8723,
        characters: 71,
        ratioToBaserunCurve: { median: 1.1439, p10: 1.1211, p90: 1.1678 },
      }],
    },
    preparedMigration: {
      file: '20260921130000_character_run_speed_corrections.sql',
      version: '20260921130000',
      found: true,
      corrections: [
        { name: 'Dry Bones', from: 40, to: 50 },
        { name: 'Green Paratroopa', from: 64, to: 52 },
      ],
    },
    migrationLedger: {
      checked: true,
      preparedMigrationRecorded: false,
      correctionTargetValues: [
        { name: 'Dry Bones', run_speed: 40 },
        { name: 'Green Paratroopa', run_speed: 64 },
      ],
    },
    ...overrides,
  }
}

// ─── The counts ──────────────────────────────────────────────────────────────

test('the agreement counts come from the audit, not from the prose', () => {
  assert.match(text(baseAudit()), /70 of 72 over the local archive/)
  assert.match(text(baseAudit()), /53 of 55 over the database/)

  const moved = baseAudit()
  moved.archiveSpeedAgreement.charactersReproducingTheCurve = 71
  moved.archiveSpeedAgreement.charactersWithARating = 73
  moved.speedAgreement.charactersReproducingTheCurve = 60
  moved.speedAgreement.charactersWithConstant = 61
  const after = text(moved)
  assert.match(after, /71 of 73 over the local archive/)
  assert.match(after, /60 of 61 over the database/)
  assert.doesNotMatch(after, /70 of 72/, 'the previous run must not survive in the prose')
  assert.doesNotMatch(after, /53 of 55/)
})

test('the interpolation counts follow both scopes', () => {
  assert.match(text(baseAudit()), /- 24 of the 70 matched over the local archive/)
  assert.match(text(baseAudit()), /- 19 of the 53 matched over the database/)

  const moved = baseAudit()
  moved.archiveSpeedAgreement.ofWhichInterpolatedRatings = 25
  moved.speedAgreement.ofWhichInterpolatedRatings = 20
  assert.match(text(moved), /- 25 of the 70 matched over the local archive/)
  assert.match(text(moved), /- 20 of the 53 matched over the database/)
})

test('the per-game coverage rate is the run\'s, and keeps attempts apart from secured', () => {
  assert.match(text(baseAudit()), /- standing 5\.86 attempts a game, 5\.43 secured/)
  assert.match(text(baseAudit()), /- dive 7\.71 attempts a game, 2\.29 secured/)

  const moved = baseAudit()
  moved.catchReach.trackedGames = 9
  moved.catchReach.perTrackedGame.dive.qualifyingSecuredPerGame = 3.11
  const after = text(moved)
  assert.match(after, /9 tracked games/)
  assert.match(after, /- dive 7\.71 attempts a game, 3\.11 secured/)
})

test('an unreadable approach table is reported, not summarised around', () => {
  const audit = baseAudit({ catchReach: { tableMissing: true } })
  assert.match(text(audit), /No catch-approach coverage/)
  assert.doesNotMatch(text(audit), /attempts a game/)
})

// ─── The attribute exceptions ────────────────────────────────────────────────

test('the exceptions are named from the data', () => {
  const out = text(baseAudit())
  assert.match(out, /disagrees with the game for 2 characters/)
  assert.match(out, /- Green Paratroopa, column 64, talent profile says 52, and an observed 25\.722 ft\/s sits on it/)
  assert.match(out, /- Dry Bones, column 40, talent profile says 50, and an observed 25\.565 ft\/s sits on it/)
  assert.match(out, /CORROBORATED BY OBSERVATION: 2 of 2/)
  assert.match(out, /Every exception has a second source that the capture agrees with/)
})

// THE CASE THAT MOTIVATED THIS FILE. Applying the correction removes both
// exceptions. The old epilogue would have kept asserting "exactly two".
test('when the exceptions disappear the narrative says so instead', () => {
  const audit = baseAudit()
  audit.speedAgreement.charactersWithNoCurveMatch = []
  const out = text(audit)
  assert.match(out, /agrees with the game for every character/)
  assert.match(out, /exceptions this report was built to surface are/)
  assert.doesNotMatch(out, /disagrees with the game for/)
  // ...and it does not claim to know WHY they went away.
  assert.match(out, /re-ingest that dropped those characters/)
})

test('one exception reads as one, not as "two"', () => {
  const audit = baseAudit()
  audit.speedAgreement.charactersWithNoCurveMatch = [
    {
      name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
      expectedOrdinaryFps: 25.3683, expectedFromProfileFps: 25.565, observed: [25.565],
    },
  ]
  assert.match(text(audit), /disagrees with the game for 1 character:/)
  assert.doesNotMatch(text(audit), /2 characters/)
})

test('an exception with no corroborating profile is not offered as evidence', () => {
  const audit = baseAudit()
  audit.speedAgreement.charactersWithNoCurveMatch = [
    {
      name: 'Petey Piranha', runSpeed: 30, profileRunSpeed: 30,
      expectedOrdinaryFps: 25.1, expectedFromProfileFps: 25.1, observed: [27.4],
    },
  ]
  const out = text(audit)
  assert.match(out, /talent profile agrees with the column \(30\)/)
  assert.match(out, /CORROBORATED BY OBSERVATION: 0 of 1/)
})

// ─── The boost ───────────────────────────────────────────────────────────────

test('the boosted session is named, and one session reads as one', () => {
  const out = text(baseAudit())
  assert.match(out, /appears in 1 archived session, named rather/)
  assert.match(out, /- `wario_stadium-20260826T005958Z`, 16 characters/)
  assert.match(out, /wario_stadium: 1 of 1 scanned captures boosted/)
  // The caveat uses the session's OWN identity, and claims park coverage only
  // because the audit measured it.
  assert.match(out, /it is\s+`wario_stadium-20260826T005958Z`/)
  assert.match(out, /only scanned capture of wario_stadium/)
  // Collector format is not measured anywhere in this report.
  assert.doesNotMatch(out, /oldest collector format/)
  assert.match(out, /Nothing in this report measures collector format/)
})

// THE OTHER CASE THAT MOTIVATED THIS FILE. A second boosted session at a
// different park is exactly the evidence that would break the confounding
// argument, and the old epilogue asserted "exactly one" regardless.
test('a second boosted session changes both the finding and the caveat', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.sessionsShowingTheBoost = [
    {
      stem: 'wario_stadium-20260826T005958Z', characters: 16,
      park: 'wario_stadium', parkSessionsScanned: 1, parkSessionsBoosted: 1,
    },
    {
      stem: 'yoshi_park-20261002T101500Z', characters: 14,
      park: 'yoshi_park', parkSessionsScanned: 3, parkSessionsBoosted: 1,
    },
  ]
  const out = text(audit)
  assert.match(out, /appears in 2 archived sessions/)
  assert.match(out, /- `yoshi_park-20261002T101500Z`, 14 characters/)
  // The caveat must stop claiming a single confounded session.
  assert.doesNotMatch(out, /oldest collector format/)
  assert.match(out, /2 sessions show it/)
  assert.match(out, /2 parks \(wario_stadium and yoshi_park\)/)
  assert.match(out, /worth redoing/)
})

test('no boosted session at all is reported rather than assumed', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.sessionsShowingTheBoost = []
  const out = text(audit)
  assert.match(out, /NO archived session shows the x1\.5 boost/)
  assert.match(out, /No session in this run shows it at all/)
})

test('an unscanned archive says so rather than reporting zero', () => {
  const audit = baseAudit({
    archiveSpeedAgreement: { scanned: false, reason: 'data/player_tracking is not present' },
  })
  const out = text(audit)
  assert.match(out, /Nothing about the boost: the local archive was not scanned/)
  assert.match(out, /data\/player_tracking is not present/)
  assert.doesNotMatch(out, /NO archived session shows/)
  // The database scope still reports, because it does not need the archive.
  assert.match(out, /53 of 55 over the database/)
  assert.doesNotMatch(out, /over the local archive/)
})

// ─── The ledger, which has four answers and not two ──────────────────────────

test('an omitted ledger check says "not checked"', () => {
  const out = text(baseAudit({ migrationLedger: null }))
  assert.match(out, /NOT CHECKED on this run/)
  assert.match(out, /--ledger/)
  assert.doesNotMatch(out, /RECORDED STATUS/)
  assert.doesNotMatch(out, /OBSERVED TARGET VALUES/)
})

test('a failed ledger read says "unverified" and why', () => {
  const out = text(baseAudit({
    migrationLedger: { checked: false, reason: 'the Supabase CLI read failed: not linked' },
  }))
  assert.match(out, /UNVERIFIED/)
  assert.match(out, /not linked/)
  assert.match(out, /unknown rather than empty/)
  assert.doesNotMatch(out, /NOT recorded as applied/)
})

test('recorded status and observed values are two separate statements', () => {
  const out = text(baseAudit())
  assert.match(out, /RECORDED STATUS: 20260921130000 is NOT recorded as applied/)
  assert.match(out, /OBSERVED TARGET VALUES, which are a separate reading/)
  assert.match(out, /Dry Bones 40 \(the prior value\)/)
  assert.match(out, /Green Paratroopa 64 \(the prior value\)/)
  assert.match(out, /consistent with it not having taken effect/)
  // AND IT MUST NOT CONCLUDE MORE THAN THAT.
  assert.match(out, /does not establish that the file/)
  assert.doesNotMatch(out, /never applied/)
  assert.doesNotMatch(out, /proves/)
})

test('a recorded migration with corrected values reads as applied', () => {
  const audit = baseAudit()
  audit.migrationLedger = {
    checked: true,
    preparedMigrationRecorded: true,
    correctionTargetValues: [
      { name: 'Dry Bones', run_speed: 50 },
      { name: 'Green Paratroopa', run_speed: 52 },
    ],
  }
  const out = text(audit)
  assert.match(out, /20260921130000 is recorded as applied/)
  assert.match(out, /Dry Bones 50 \(the corrected value\)/)
  assert.match(out, /applying the file would be a no-op on these rows/)
  assert.doesNotMatch(out, /do not agree/)
})

// The disagreement this repository has actually seen: live on production while
// absent from the ledger.
test('values corrected while the ledger does not record it is flagged, not smoothed', () => {
  const audit = baseAudit()
  audit.migrationLedger = {
    checked: true,
    preparedMigrationRecorded: false,
    correctionTargetValues: [
      { name: 'Dry Bones', run_speed: 50 },
      { name: 'Green Paratroopa', run_speed: 52 },
    ],
  }
  const out = text(audit)
  assert.match(out, /NOT recorded as applied/)
  assert.match(out, /already holds the corrected value, however the ledger reads/)
  assert.match(out, /the recorded status and the observed values do not agree/)
})

test('targets in different states refuse a single verdict', () => {
  const audit = baseAudit()
  audit.migrationLedger.correctionTargetValues = [
    { name: 'Dry Bones', run_speed: 50 },
    { name: 'Green Paratroopa', run_speed: 64 },
  ]
  const out = text(audit)
  assert.match(out, /targets DISAGREE with each other/)
  assert.match(out, /neither "applied" nor "not/)
})

test('a target the database does not hold, and a value that is neither', () => {
  const audit = baseAudit()
  audit.migrationLedger.correctionTargetValues = [{ name: 'Green Paratroopa', run_speed: 77 }]
  const out = text(audit)
  assert.match(out, /Dry Bones not found/)
  assert.match(out, /Green Paratroopa 77 \(neither 64 nor 52\)/)
})

test('an unreadable migration file leaves the comparison unmade', () => {
  const audit = baseAudit({
    preparedMigration: { file: 'x.sql', version: 'x', found: false, corrections: [] },
  })
  const out = text(audit)
  assert.match(out, /could not be read from disk/)
  assert.doesNotMatch(out, /the prior value/)
})

// ─── Fixtures that contradict the narrative the old code always told ─────────
//
// Each of these was a sentence the epilogue produced unconditionally. The data
// below is what that sentence is FALSE for, so if a helper ever goes back to
// asserting it, one of these fails.

test('a profile that differs from the column but matches no observation is not evidence', () => {
  const audit = baseAudit()
  // The profile disagrees with the column -- which the old code took as proof
  // that the profile was what the game held -- and the captured constant sits
  // on NEITHER. Nothing here supports correcting the column to the profile.
  audit.speedAgreement.charactersWithNoCurveMatch = [{
    name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
    expectedOrdinaryFps: 25.3683, expectedFromProfileFps: 25.565, observed: [27.9],
  }]
  const out = text(audit)
  assert.match(out, /talent profile says 50 \(implying 25\.565 ft\/s\), which NO observation matches/)
  assert.match(out, /CORROBORATED BY OBSERVATION: 0 of 1/)
  assert.match(out, /the profile is not evidence for them/)
  // THE CLAIM THAT MUST NOT APPEAR.
  assert.doesNotMatch(out, /talent profile agrees with the game/)
  assert.doesNotMatch(out, /second source that the capture agrees with/)
})

test('a profile outside the tolerance is contradicted, inside it is corroborated', () => {
  const near = baseAudit()
  near.speedAgreement.charactersWithNoCurveMatch = [{
    name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
    expectedFromProfileFps: 25.565, observed: [25.570],
  }]
  assert.match(text(near), /CORROBORATED BY OBSERVATION: 1 of 1/)

  const far = baseAudit()
  far.speedAgreement.charactersWithNoCurveMatch = [{
    name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
    expectedFromProfileFps: 25.565, observed: [25.600],
  }]
  assert.match(text(far), /CORROBORATED BY OBSERVATION: 0 of 1/)
})

test('an exception with no observation at all is unverified, not corroborated', () => {
  const audit = baseAudit()
  audit.speedAgreement.charactersWithNoCurveMatch = [{
    name: 'Dry Bones', runSpeed: 40, profileRunSpeed: 50,
    expectedFromProfileFps: 25.565, observed: [],
  }]
  const out = text(audit)
  assert.match(out, /not checkable against an observation here/)
  assert.match(out, /1 exception UNVERIFIED/)
  assert.match(out, /nothing is claimed either way/)
})

test('zero curve matches is not reported as agreement', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.charactersReproducingTheCurve = 0
  audit.speedAgreement.charactersReproducingTheCurve = 0
  audit.speedAgreement.medianAbsErrorFps = null
  audit.speedAgreement.worstAbsErrorFps = null
  const out = text(audit)
  assert.match(out, /NOT ONE of the characters checked reproduced its curve row/)
  assert.match(out, /does not support the curve at all/)
  assert.match(out, /No error figures/)
  assert.doesNotMatch(out, /indistinguishable at the stored resolution/)
})

test('nothing checked at all is said outright', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement = { scanned: false, reason: 'archive absent' }
  audit.speedAgreement.charactersWithConstant = 0
  const out = text(audit)
  assert.match(out, /NOTHING was checked against the workbook FIELD-speed curve/)
  assert.match(out, /neither supported nor contradicted/)
  assert.doesNotMatch(out, /indistinguishable at the stored resolution/)
})

test('an error above the stored resolution is not called indistinguishable', () => {
  const audit = baseAudit()
  audit.speedAgreement.medianAbsErrorFps = 0.004
  audit.speedAgreement.worstAbsErrorFps = 0.0092
  audit.speedAgreement.roundingFloorFps = 0.0005
  const out = text(audit)
  assert.match(out, /EXCEEDS the/)
  assert.match(out, /distinguishable at the stored resolution/)
  assert.match(out, /closeness figure/)
  assert.doesNotMatch(out, /"indistinguishable at the stored resolution"/)
})

test('zero interpolated ratings does not confirm interpolation', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.ofWhichInterpolatedRatings = 0
  audit.speedAgreement.ofWhichInterpolatedRatings = 0
  const out = text(audit)
  assert.match(out, /Linear interpolation between published rows is NOT exercised/)
  assert.match(out, /nothing\s+here distinguishes interpolation from a lookup/)
  assert.doesNotMatch(out, /which matched anyway:/)
})

// THE BOOST CAVEAT'S TWO ASSUMPTIONS, each given data that breaks it.

test('a single boosted session at another park is described as that park', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.sessionsShowingTheBoost = [{
    stem: 'yoshi_park-20261002T101500Z', characters: 12,
    park: 'yoshi_park', parkSessionsScanned: 1, parkSessionsBoosted: 1,
  }]
  const out = text(audit)
  assert.match(out, /`yoshi_park-20261002T101500Z`/)
  assert.match(out, /only scanned capture of yoshi_park/)
  // It must not have become the Wario Stadium story.
  assert.doesNotMatch(out, /Wario Stadium/)
  assert.doesNotMatch(out, /wario_stadium/)
  assert.doesNotMatch(out, /oldest collector format/)
})

// A SECOND, UNBOOSTED CAPTURE OF THE SAME PARK REVERSES THE CONCLUSION. The
// old text said the single boosted session was "the only Wario Stadium
// capture", so a second one made the report state a falsehood; worse, a second
// capture that does NOT boost rules the park out rather than confirming it.
test('a second unboosted capture of the same park rules the park out', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.sessionsShowingTheBoost = [{
    stem: 'wario_stadium-20260826T005958Z', characters: 16,
    park: 'wario_stadium', parkSessionsScanned: 2, parkSessionsBoosted: 1,
  }]
  audit.archiveSpeedAgreement.sessionsScannedByPark = { wario_stadium: 2 }
  const out = text(audit)
  assert.match(out, /wario_stadium has 2 scanned captures and only/)
  assert.match(out, /the PARK ALONE does not explain it/)
  assert.doesNotMatch(out, /only scanned capture of wario_stadium/)
  assert.doesNotMatch(out, /oldest collector format/)
})

test('several boosted sessions with mixed park coverage say the park is not enough', () => {
  const audit = baseAudit()
  audit.archiveSpeedAgreement.sessionsShowingTheBoost = [
    {
      stem: 'wario_stadium-20260826T005958Z', characters: 16,
      park: 'wario_stadium', parkSessionsScanned: 3, parkSessionsBoosted: 1,
    },
    {
      stem: 'yoshi_park-20261002T101500Z', characters: 14,
      park: 'yoshi_park', parkSessionsScanned: 1, parkSessionsBoosted: 1,
    },
  ]
  const out = text(audit)
  assert.match(out, /wario_stadium: 1 of 3/)
  assert.match(out, /the park alone does not explain the boost/)
})

// THE BASERUNNING CAVEAT, which always said "above" and always concluded the
// measurement was of something else.

test('a ratio of exactly 1 is agreement, not a different quantity', () => {
  const audit = baseAudit()
  audit.runnerSprint.analyses[0].ratioToBaserunCurve = { median: 1, p10: 0.99, p90: 1.01 }
  const out = text(audit)
  assert.match(out, /sits at 1x the curve's own values/)
  assert.match(out, /agree in magnitude as well as in rank/)
  assert.doesNotMatch(out, /so it measures a different quantity/)
  assert.doesNotMatch(out, /above the curve/)
  // ...and it still does not overclaim: the curve remains unvalidated.
  assert.match(out, /still flagged unvalidated/)
})

test('a ratio below 1 says below, not above', () => {
  const audit = baseAudit()
  audit.runnerSprint.analyses[0].ratioToBaserunCurve = { median: 0.87, p10: 0.85, p90: 0.9 }
  const out = text(audit)
  assert.match(out, /0\.87x\s+below the curve's own values/)
  assert.doesNotMatch(out, /above the curve's own values/)
})

test('a missing runner analysis is reported rather than narrated', () => {
  const out = text(baseAudit({ runnerSprint: { analyses: [] } }))
  assert.match(out, /no runner\s+analysis ran on this report/)
  assert.doesNotMatch(out, /sits a consistent/)
})

test('a runner analysis with no ratio falls back to the correlation alone', () => {
  const audit = baseAudit()
  audit.runnerSprint.analyses[0].ratioToBaserunCurve = { median: null, p10: null, p90: null }
  const out = text(audit)
  assert.match(out, /produced no ratio to the curve/)
  assert.match(out, /says nothing about its OUTPUT/)
  assert.doesNotMatch(out, /measures a different quantity/)
})

// ─── The parts that must NOT move ────────────────────────────────────────────

test('the method notes are the same whatever the run found', () => {
  const a = buildReportEpilogue(baseAudit())
  const b = buildReportEpilogue(baseAudit({
    migrationLedger: null,
    archiveSpeedAgreement: { scanned: false, reason: 'absent' },
  }))
  const method = (lines) => lines.slice(lines.indexOf('## How to read these numbers'))
  assert.deepEqual(method(a), method(b), 'method notes must not depend on the findings')
  assert.ok(method(a).length > 10)
  // And they still carry the standing qualifications the findings never cover.
  const joined = method(a).join('\n')
  assert.match(joined, /r = 0\.73 once cited for\s+standing reach/)
  assert.match(joined, /no timestamp, no author/)
})

test('the baserunning ratio is this run\'s, not a remembered one', () => {
  assert.match(text(baseAudit()), /1\.1439x\s+above the curve's own values/)
  const moved = baseAudit()
  moved.runnerSprint.analyses[0].ratioToBaserunCurve.median = 1.09
  moved.runnerSprint.analyses[0].pearsonVsRunSpeed = 0.91
  const after = text(moved)
  assert.match(after, /1\.09x\s+above the curve's own values/)
  assert.match(after, /r = 0\.91 over 71 characters/)
  assert.doesNotMatch(after, /1\.1439/)
})

// ─── The migration parse the ledger findings depend on ───────────────────────

test('the prepared corrections are read from the migration, not restated', () => {
  const prepared = readPreparedMigration()
  assert.equal(prepared.found, true, 'the prepared migration should be in this checkout')
  assert.equal(prepared.version, '20260921130000')
  assert.deepEqual(prepared.corrections, [
    { name: 'Dry Bones', from: 40, to: 50 },
    { name: 'Green Paratroopa', from: 64, to: 52 },
  ])
})

test('a migration file that is not present is reported as absent', () => {
  const missing = readPreparedMigration('99999999999999_not_a_real_migration.sql')
  assert.equal(missing.found, false)
  assert.deepEqual(missing.corrections, [])
})
