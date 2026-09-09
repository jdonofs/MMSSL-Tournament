import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POS_SCALE,
  RETENTION_SEC,
  decodeFlight,
  encodeFlight,
  flightKey,
  mergeFlights,
} from '../scripts/flight_archive.mjs'

const flight = (n, { start = 0, hz = 60.5 } = {}) => Array.from({ length: n }, (_, i) => ({
  timeNs: start + Math.round((i / hz) * 1e9),
  x: i * 0.37,
  y: 1 + (i * 0.9) - (0.083 * i * i),
  z: -i * 1.13,
}))

const make = (over = {}) => ({
  contactSeq: 42,
  batter: 'Peach',
  kind: 'landed',
  endpoint: 'landing',
  exitSpeedMph: 97.4,
  launchDeg: 28.5,
  sprayDeg: -12.1,
  endpointX: 30.2,
  endpointY: 0.25,
  endpointZ: -95.7,
  projectedX: null,
  projectedZ: null,
  stadiumKey: 'peach_ice_garden',
  flight: flight(40),
  durationSec: 0,
  apexUnits: null,
  source: 'x.log',
  ...over,
})

test('a flight survives the round trip to within the quantisation step', () => {
  const before = make()
  const after = decodeFlight(encodeFlight(before))
  assert.equal(after.batter, before.batter)
  assert.equal(after.kind, before.kind)
  assert.equal(after.stadiumKey, before.stadiumKey)
  assert.equal(after.flight.length, before.flight.length)
  for (let i = 0; i < before.flight.length; i += 1) {
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(
        Math.abs(after.flight[i][axis] - before.flight[i][axis]) <= 1 / POS_SCALE,
        `${axis}[${i}] moved by more than one quantisation step`,
      )
    }
  }
})

test('frame SPACING survives, which is what the velocity fit actually reads', () => {
  // Storing time in milliseconds perturbed a ~16.5 ms frame gap by up to 1 ms
  // -- six percent -- and moved the fitted gravity. Microsecond deltas are what
  // fixed it, so this guards the property rather than the encoding.
  const before = make()
  const after = decodeFlight(encodeFlight(before))
  for (let i = 1; i < before.flight.length; i += 1) {
    const wanted = (before.flight[i].timeNs - before.flight[i - 1].timeNs) / 1e9
    const got = (after.flight[i].timeNs - after.flight[i - 1].timeNs) / 1e9
    assert.ok(Math.abs(got - wanted) < 2e-6, `frame ${i} gap moved by ${got - wanted}s`)
  }
})

test('retention keeps every frame of the kinds the analysis depends on', () => {
  // landed are the backtest's labels, struck are how wall heights get measured,
  // unresolved are the balls the projection exists for.
  for (const kind of ['landed', 'struck', 'unresolved']) {
    assert.equal(RETENTION_SEC[kind], Infinity, `${kind} must keep all frames`)
    const row = encodeFlight(make({ kind, flight: flight(600) }))
    assert.equal(row.s.length, 600)
    assert.equal(row.trimmed, false)
  }
})

test('a foul keeps its metadata and none of its samples', () => {
  const row = encodeFlight(make({ kind: 'foul', flight: flight(300) }))
  assert.equal(row.s.length, 0)
  assert.equal(row.frames_total, 300, 'the true length is still recorded')
  assert.equal(row.trimmed, true)
  assert.equal(row.spray, -12.1, 'and the spray angle survives for charting')
})

test('a caught ball is trimmed to the retention window, not to nothing', () => {
  const row = encodeFlight(make({ kind: 'caught', flight: flight(600) }))
  assert.ok(row.s.length > 100, 'should keep the first seconds')
  assert.ok(row.s.length < 600, 'but not all of a 10-second record')
  const decoded = decodeFlight(row)
  const span = (decoded.flight[decoded.flight.length - 1].timeNs
    - decoded.flight[0].timeNs) / 1e9
  assert.ok(span <= RETENTION_SEC.caught + 0.05, `kept ${span}s`)
})

test('re-distilling the same flight twice does not duplicate it', () => {
  const f = make()
  const first = mergeFlights([], [f])
  assert.equal(first.added, 1)
  const second = mergeFlights(first.rows, [f])
  assert.equal(second.added, 0)
  assert.equal(second.improved, 0)
  assert.equal(second.rows.length, 1)
})

test('a longer copy of a flight replaces a shorter one', () => {
  // The same ball appears in both the live preview log and the finished game
  // log, and one may have seen frames the other missed.
  const short = make({ flight: flight(25) })
  const long = make({ flight: flight(90) })
  const { rows, improved } = mergeFlights(mergeFlights([], [short]).rows, [long])
  assert.equal(improved, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].s.length, 90)
  // ...and not the other way round.
  const back = mergeFlights(rows, [short])
  assert.equal(back.improved, 0)
  assert.equal(back.rows[0].s.length, 90)
})

test('flights are identified by the ball, not by which log they came from', () => {
  // A preview session log is truncated and rewritten on every launch, so a
  // filename cannot identify anything.
  assert.equal(flightKey(make({ source: 'a.log' })), flightKey(make({ source: 'b.log' })))
  assert.notEqual(flightKey(make()), flightKey(make({ contactSeq: 43 })))
  assert.notEqual(flightKey(make()), flightKey(make({ batter: 'Daisy' })))
})

test('a flight with no samples at all encodes and decodes without throwing', () => {
  const row = encodeFlight(make({ flight: [] }))
  const back = decodeFlight(row)
  assert.equal(back.flight.length, 0)
  assert.equal(back.apexUnits, null)
  assert.equal(back.durationSec, 0)
})
