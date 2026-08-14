import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calibrationRows,
  dedupeBattedBallRecords,
  extractBattedBallRecords,
} from '../scripts/extract_batted_balls.mjs'

const A = 'contact_seq=41|batter=Bowser|pitcher=Mario|exit_speed_mph=85.0|launch_degrees=35.2'
  + '|spray_degrees=12.0|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=306'
  + '|x=29.0159225|y=0.264784217|z=-71.6531067|distance_feet=229.2'
const B = 'contact_seq=99|batter=Luigi|pitcher=Wario|exit_speed_mph=101.0|launch_degrees=40.0'
  + '|spray_degrees=-20.0|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=500'
  + '|x=-40.0|y=3.0|z=-90.0|distance_feet=333.3'
const marked = (body) => `[TRACKER_BATTED_BALL_PROVISIONAL] ${body}`

test('many records on ONE json line stay separate', () => {
  // The failure this whole module exists for. A JSON snapshot puts a whole
  // recent_messages array on one line; reading from the first marker to the
  // end of the line splices every later record into the first.
  const line = `{"recent_messages":["${marked(A)}","${marked(B)}"]}`
  const records = extractBattedBallRecords(line)
  assert.equal(records.length, 2)
  assert.equal(records[0].contact_seq, '41')
  assert.equal(records[0].batter, 'Bowser')
  assert.equal(records[0].x, '29.0159225')
  assert.equal(records[1].contact_seq, '99')
  assert.equal(records[1].batter, 'Luigi')
  assert.equal(records[1].x, '-40.0')
})

test('a record never absorbs fields from the record after it', () => {
  const line = `{"m":["${marked(A)}","${marked(B)}"]}`
  const [first] = extractBattedBallRecords(line)
  // Bowser's landing was at z=-71.65; Luigi's at -90. Bleed shows up here.
  assert.equal(first.z, '-71.6531067')
  assert.equal(first.distance_feet, '229.2')
  assert.equal(first.exit_speed_mph, '85.0')
})

test('plain one-per-line logs still parse', () => {
  const records = extractBattedBallRecords(`${marked(A)}\n${marked(B)}\n`)
  assert.equal(records.length, 2)
  assert.equal(records[0].batter, 'Bowser')
  assert.equal(records[1].batter, 'Luigi')
})

test('the same contact repeated across snapshots counts once', () => {
  // Every /state poll re-emits recent messages, so one contact appears many
  // times. Counting instances instead of contacts is how 4 became 61.
  const text = [marked(A), marked(A), marked(B), marked(A)].map((m) => `"${m}"`).join(',')
  assert.equal(extractBattedBallRecords(text).length, 4)
  assert.equal(dedupeBattedBallRecords(extractBattedBallRecords(text)).length, 2)
})

test('only records with a real tracked endpoint are offered for calibration', () => {
  const unresolved = marked('contact_seq=7|batter=Petey|pitcher=X|exit_speed_mph=103.8'
    + '|launch_degrees=47.4|spray_degrees=28.1|side=first_base|endpoint=unresolved'
    + '|endpoint_status=stalled|endpoint_seq=none|x=none|y=none|z=none|distance_feet=305.4')
  const foul = marked('contact_seq=8|batter=Wiggler|pitcher=X|exit_speed_mph=94.6'
    + '|launch_degrees=35.7|spray_degrees=35.1|side=first_base|endpoint=foul'
    + '|endpoint_status=foul|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none')
  const rows = calibrationRows(extractBattedBallRecords(
    [A, B, unresolved.slice(34), foul.slice(34)].map((b) => `"${marked(b)}"`).join(','),
  ))
  // An unresolved ball's distance is modelled, not observed — training on it
  // would be fitting a model to its own output.
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.batter).sort(), ['Bowser', 'Luigi'])
})

test('distance comes from coordinates, not from the executable feet', () => {
  const [row] = calibrationRows(extractBattedBallRecords(`"${marked(A)}"`))
  // distance_feet said 229.2, converted inside a build using 3.0 ft/unit.
  // Measured from the coordinates at the real scale it is about 257.
  assert.ok(Math.abs(row.distanceFeet - 257) < 2, `got ${row.distanceFeet.toFixed(1)}`)
})

test('exit velocity is rescaled out of the build that reported it', () => {
  const stated = marked(`${A}|feet_per_unit=3.3532`)
  const [rescaled] = calibrationRows(extractBattedBallRecords(`"${stated}"`))
  const [assumed] = calibrationRows(extractBattedBallRecords(`"${marked(A)}"`))
  // A build that declares the current scale needs no correction; one that says
  // nothing is assumed to be the old 3.0 and is scaled up.
  assert.ok(Math.abs(rescaled.exitVelocityMph - 85.0) < 0.01)
  assert.ok(assumed.exitVelocityMph > rescaled.exitVelocityMph)
})
