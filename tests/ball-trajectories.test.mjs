import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractRecords,
  scanRecords,
  stadiumForRun,
  classifyEndpoint,
  flightFor,
  buildFlights,
  BALL_RADIUS_UNITS,
} from '../scripts/ball_trajectories.mjs'
import {
  fitInitialState,
  positionAt,
  predictFirstTouch,
  observedFirstTouch,
  contiguousRun,
} from '../scripts/backtest_hr_projection.mjs'

const SAMPLE = 'TRACKER_BALL_SAMPLE] '
const CONTACT = 'TRACKER_BATTED_BALL_PROVISIONAL] '

test('a record stops at the end of its own log line, never spilling into the next', () => {
  // The failure this guards is the one that produced a fictional dataset once
  // already: the preview log is JSON, one line can carry many records, and
  // reading to end-of-line splices separate balls together.
  const text = `{"recent":["${SAMPLE}seq=1|x=1|y=2|z=3",`
    + `"${SAMPLE}seq=2|x=4|y=5|z=6"]}`
  const got = extractRecords(text, SAMPLE)
  assert.equal(got.length, 2)
  assert.deepEqual(got[0], { seq: '1', x: '1', y: '2', z: '3' })
  assert.deepEqual(got[1], { seq: '2', x: '4', y: '5', z: '6' })
})

test('a duplicated key keeps the first value, so bad bounds cannot import a neighbour', () => {
  const got = extractRecords(`${SAMPLE}seq=1|x=1|seq=99`, SAMPLE)
  assert.equal(got[0].seq, '1')
})

test('a ball at rest is a landing; a ball stopped in mid-air is a strike', () => {
  // The whole point of the classifier: the tracker calls both of these
  // `landing`, and one of them is not.
  assert.equal(classifyEndpoint({ endpoint: 'landing', y: String(BALL_RADIUS_UNITS) }), 'landed')
  assert.equal(classifyEndpoint({ endpoint: 'landing', y: '0.2711' }), 'landed')
  assert.equal(classifyEndpoint({ endpoint: 'landing', y: '8.4' }), 'struck')
  assert.equal(classifyEndpoint({ endpoint: 'landing', y: '0.9' }), 'struck')
})

test('catches, fouls and unresolved balls are never mistaken for measured carry', () => {
  assert.equal(classifyEndpoint({ endpoint: 'catch', y: '0.25' }), 'caught')
  assert.equal(classifyEndpoint({ endpoint: 'foul', y: 'none' }), 'foul')
  assert.equal(classifyEndpoint({ endpoint: 'unresolved', y: 'none' }), 'unresolved')
})

test('a flight is bounded by its endpoint, so it cannot absorb the next ball', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1, timeNs: i * 16_000_000, x: i, y: i, z: -i,
  }))
  const flight = flightFor({ contact_seq: '5', endpoint_seq: '12' }, samples)
  assert.equal(flight.length, 8)
  assert.equal(flight[0].seq, 5)
  assert.equal(flight[flight.length - 1].seq, 12)
})

test('an unresolved ball still gets a trajectory, bounded by the next contact', () => {
  // This is what makes a trajectory model possible for the balls that matter:
  // they have no endpoint, but they do have most of a flight.
  const samples = Array.from({ length: 60 }, (_, i) => ({
    seq: i + 1, timeNs: i * 16_000_000, x: i, y: i, z: -i,
  }))
  const flight = flightFor({ contact_seq: '10', endpoint_seq: 'none' }, samples, 30)
  assert.ok(flight.length > 15, 'should recover a usable stretch of flight')
  assert.equal(flight[0].seq, 10)
  assert.ok(flight[flight.length - 1].seq < 30, 'must stop before the next contact')
})

test('two sessions that reuse the same seq numbers do not trade trajectories', () => {
  // The bug this pins: `seq` restarts at 1 in every log, so keying samples
  // globally hands one game's contact another game's flight. It fitted gravity
  // at 67 u/s^2 against a true 7.2 and produced 200 ft landing errors, all
  // without erroring.
  const mk = (seq, x) => ({ seq, timeNs: seq * 16_000_000, x, y: 10, z: -x })
  const sessions = [
    {
      path: 'a.log',
      samples: [mk(1, 100), mk(2, 101), mk(3, 102)],
      contacts: [{ contact_seq: '1', batter: 'A', exit_speed_mph: '100', endpoint: 'landing', y: '0.25', endpoint_seq: '3' }],
    },
    {
      path: 'b.log',
      samples: [mk(1, 900), mk(2, 901), mk(3, 902)],
      contacts: [{ contact_seq: '1', batter: 'B', exit_speed_mph: '110', endpoint: 'landing', y: '0.25', endpoint_seq: '3' }],
    },
  ]
  const flights = buildFlights({ sessions })
  assert.equal(flights.length, 2)
  const a = flights.find((f) => f.batter === 'A')
  const b = flights.find((f) => f.batter === 'B')
  assert.equal(a.flight[0].x, 100, "A must keep its own session's samples")
  assert.equal(b.flight[0].x, 900, "B must keep its own session's samples")
})

// --- flight model ---------------------------------------------------------
//
// The closed form is the thing everything else rests on, so it is checked
// against a brute-force integration of the same ODE rather than against itself.

const G = 10.2556
const C = 0.15213

function integrate(state, g, c, total, steps = 400000) {
  const dt = total / steps
  let { x, y, z, vx, vy, vz } = state
  for (let i = 0; i < steps; i += 1) {
    const ax = -c * vx
    const ay = -g - (c * vy)
    const az = -c * vz
    x += vx * dt; y += vy * dt; z += vz * dt
    vx += ax * dt; vy += ay * dt; vz += az * dt
  }
  return { x, y, z }
}

test('the closed-form flight path matches a numerical integration of the same physics', () => {
  const state = { x: 1, y: 3, z: -2, vx: 5, vy: 40, vz: -50 }
  for (const t of [0.25, 1.0, 2.5, 4.0]) {
    const exact = positionAt(state, G, C, t)
    const stepped = integrate(state, G, C, t)
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(
        Math.abs(exact[axis] - stepped[axis]) < 0.01,
        `${axis} at t=${t}: closed form ${exact[axis].toFixed(4)} `
        + `vs integrated ${stepped[axis].toFixed(4)}`,
      )
    }
  }
})

test('the initial state is recovered from noiseless samples of a known flight', () => {
  const truth = { x: 0.5, y: 2.5, z: -1.0, vx: -8, vy: 42, vz: -55 }
  const window = Array.from({ length: 40 }, (_, i) => {
    const t = i * 0.0165
    const p = positionAt(truth, G, C, t)
    return { timeNs: t * 1e9, ...p }
  })
  const got = fitInitialState(window, G, C)
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz']) {
    assert.ok(
      Math.abs(got[key] - truth[key]) < 0.01,
      `${key}: got ${got[key].toFixed(4)}, expected ${truth[key]}`,
    )
  }
})

test('position noise is averaged down rather than amplified', () => {
  // The reason the fit is least squares over a window instead of a finite
  // difference: differencing 60Hz samples multiplies position noise by ~3700,
  // which is what swamped an earlier acceleration-based fit.
  const truth = { x: 0, y: 2.5, z: 0, vx: 0, vy: 45, vz: -50 }
  let seed = 42
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) - 0.5
  }
  const window = Array.from({ length: 60 }, (_, i) => {
    const t = i * 0.0165
    const p = positionAt(truth, G, C, t)
    return {
      timeNs: t * 1e9,
      x: p.x + (random() * 0.02),
      y: p.y + (random() * 0.02),
      z: p.z + (random() * 0.02),
    }
  })
  const got = fitInitialState(window, G, C)
  assert.ok(Math.abs(got.vy - truth.vy) < 0.5, `vy recovered as ${got.vy.toFixed(3)}`)
  assert.ok(Math.abs(got.vz - truth.vz) < 0.5, `vz recovered as ${got.vz.toFixed(3)}`)
})

test('the predicted first touch lands at ball-radius height, not at zero', () => {
  const state = { x: 0, y: 2.5, z: 0, vx: 0, vy: 45, vz: -50 }
  const hit = predictFirstTouch(state, G, C)
  assert.ok(hit, 'should find a descent through the radius')
  assert.ok(Math.abs(hit.y - BALL_RADIUS_UNITS) < 1e-3, `y at touch was ${hit.y}`)
  assert.ok(hit.tSec > 1, 'a ball hit at 45 u/s upward stays airborne a while')
  assert.ok(hit.z < -50, 'and travels out toward centre field')
})

test('a ball still climbing has no first touch to report', () => {
  const rising = Array.from({ length: 20 }, (_, i) => ({
    timeNs: i * 16_500_000, x: i, y: 2 + (i * 0.5), z: -i,
  }))
  assert.equal(observedFirstTouch(rising), null)
})

test('the isolated frame at contact does not truncate the flight to nothing', () => {
  // The sample at contact_seq can sit hundreds of ms before dense tracking
  // starts, because the raw stream is sparse until the exe notices a contact.
  // Taking frames from the start and stopping at the first gap yielded ONE
  // sample and silently dropped every flight.
  const flight = [
    { timeNs: 0, x: 0, y: 1, z: 0 },
    ...Array.from({ length: 30 }, (_, i) => ({
      timeNs: 420_000_000 + (i * 16_500_000), x: i, y: 5 + i, z: -i,
    })),
  ]
  const run = contiguousRun(flight)
  assert.equal(run.length, 30, 'should keep the dense run, not the lone contact frame')
  assert.equal(run[0].timeNs, 420_000_000)
})

test('scanRecords reports where each record sat, and extractRecords is unchanged', () => {
  // The offset is what makes stadium attribution possible at all: the stadium
  // marker carries no seq, so position in the stream is the only thing tying it
  // to the samples it describes.
  const text = `${SAMPLE}seq=1|x=1|y=2|z=3\n${SAMPLE}seq=2|x=4|y=5|z=6`
  const scanned = scanRecords(text, SAMPLE)
  assert.equal(scanned.length, 2)
  assert.equal(scanned[0].at, 0)
  assert.ok(scanned[1].at > scanned[0].at)
  assert.deepEqual(extractRecords(text, SAMPLE), scanned.map((r) => r.fields))
})

test('samples take the stadium last written before them', () => {
  const stadiums = [
    { key: 'mario_stadium', at: 0 },
    { key: 'peach_ice_garden', at: 500 },
  ]
  const distinct = new Set(['mario_stadium', 'peach_ice_garden'])
  assert.equal(stadiumForRun([{ at: 100 }], stadiums, distinct), 'mario_stadium')
  assert.equal(stadiumForRun([{ at: 600 }], stadiums, distinct), 'peach_ice_garden')
  // Exactly at the marker counts as after it.
  assert.equal(stadiumForRun([{ at: 500 }], stadiums, distinct), 'peach_ice_garden')
})

test('at-bats played before the stadium was picked are still attributed, when unambiguous', () => {
  // The realistic case: the preview is launched, a few balls are hit, and only
  // then does the stadium get selected. Those samples precede every marker.
  // A game cannot change stadium partway through, so a file naming exactly one
  // stadium attributes them rather than discarding them.
  const stadiums = [{ key: 'peach_ice_garden', at: 900 }]
  const single = new Set(['peach_ice_garden'])
  assert.equal(stadiumForRun([{ at: 10 }], stadiums, single), 'peach_ice_garden')
})

test('leading samples stay unlabelled when a file names more than one stadium', () => {
  // Here the backfill reasoning fails -- the second marker may be a correction
  // of the first, or a genuinely different game -- so it must refuse to guess
  // rather than assign the earlier samples to whichever came first.
  const stadiums = [
    { key: 'peach_ice_garden', at: 900 },
    { key: 'daisy_cruiser', at: 1800 },
  ]
  const distinct = new Set(['peach_ice_garden', 'daisy_cruiser'])
  assert.equal(stadiumForRun([{ at: 10 }], stadiums, distinct), null)
})

test('a log with no stadium marker at all attributes nothing', () => {
  assert.equal(stadiumForRun([{ at: 10 }], [], new Set()), null)
})

test('each flight takes the stadium in force when IT was hit, not the session s first', () => {
  // A tracker restart resets seq and starts a new session, but leaving the
  // preview running across two games does not -- so one session can span a
  // stadium change, and resolving once per session would give every flight in
  // it the same answer.
  const stadiums = [
    { key: 'peach_ice_garden', at: 1000 },
    { key: 'daisy_cruiser', at: 3000 },
  ]
  const sample = (seq, at) => ({
    seq, at, timeNs: seq * 16_500_000, x: seq, y: 5, z: -seq,
  })
  const session = {
    path: 'fake.log',
    stadiums,
    distinctStadiums: new Set(['peach_ice_garden', 'daisy_cruiser']),
    stadiumKey: null,
    samples: [
      sample(1, 200), sample(2, 260),      // before any marker
      sample(10, 1500), sample(11, 1560),  // after peach
      sample(20, 3500), sample(21, 3560),  // after daisy
    ],
    contacts: [
      { contact_seq: '1', endpoint_seq: '2', batter: 'Early', endpoint: 'landing', x: '1', y: '0.25', z: '-1' },
      { contact_seq: '10', endpoint_seq: '11', batter: 'Mid', endpoint: 'landing', x: '1', y: '0.25', z: '-1' },
      { contact_seq: '20', endpoint_seq: '21', batter: 'Late', endpoint: 'landing', x: '1', y: '0.25', z: '-1' },
    ],
  }
  const byBatter = Object.fromEntries(
    buildFlights({ sessions: [session] }).map((f) => [f.batter, f.stadiumKey]),
  )
  assert.equal(byBatter.Early, null, 'before any marker, in a two-stadium file')
  assert.equal(byBatter.Mid, 'peach_ice_garden')
  assert.equal(byBatter.Late, 'daisy_cruiser')
})

test('the longest contiguous run wins when tracking drops out mid-flight', () => {
  const flight = [
    ...Array.from({ length: 5 }, (_, i) => ({ timeNs: i * 16_500_000, x: i, y: i, z: -i })),
    ...Array.from({ length: 25 }, (_, i) => ({
      timeNs: 900_000_000 + (i * 16_500_000), x: 100 + i, y: i, z: -i,
    })),
  ]
  const run = contiguousRun(flight)
  assert.equal(run.length, 25)
  assert.equal(run[0].x, 100)
})
