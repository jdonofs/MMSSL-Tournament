import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTrackerSessionLog } from '../scripts/tracker_session_log.mjs'
import { buildFlights, findLogs, loadSessions } from '../scripts/ball_trajectories.mjs'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-session-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Real lines, copied out of a preview session. The exact text matters: the
// flight pipeline substring-matches its markers against whatever is on disk,
// so a fixture that tidied away the tracker's "HH:MM:SS [LEVEL] " prefix would
// pass while the real thing failed.
const sample = (seq, x, y, z) =>
  `12:32:51 [DEBUG] [TRACKER_BALL_SAMPLE] phase=raw|seq=${seq}|time_ns=${14512745936000 + seq * 16000000}`
  + `|pointer=0x8131E064|x=${x}|y=${y}|z=${z}`
const CONTACT = '12:33:00 [DEBUG] [TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=2|batter=Birdo|pitcher=Bowser'
  + '|exit_speed_mph=106.8|launch_degrees=14.4|spray_degrees=14.6|side=first_base|endpoint=landing'
  + '|endpoint_status=fair_fielded|endpoint_seq=6|x=26.9596767|y=0.581725895|z=-90.4775543'
  + '|distance_feet=306.8|projected_x=none|projected_z=none|flight_updates=189'
  + '|sampled_updates_seconds=3.153|hang_time_seconds=3.604|feet_per_unit=3.2808'

const FLIGHT = [
  sample(1, 0, 1, -18.6),
  sample(2, 2.1, 3.4, -30.2),
  sample(3, 8.9, 8.1, -52.7),
  sample(4, 16.2, 9.6, -70.4),
  sample(5, 22.7, 6.2, -84.1),
  sample(6, 26.9596767, 0.581725895, -90.4775543),
  CONTACT,
]

test('raw tracker lines are kept verbatim, and the interesting ones are counted', async (t) => {
  const dir = scratch(t)
  const log = createTrackerSessionLog({ dir, prefix: 'bridge', header: '[tracker-bridge] session started' })
  FLIGHT.forEach((line) => log.write(line))
  log.write('   ')
  await log.close()

  const text = readFileSync(log.path, 'utf8')
  assert.match(text, /^\[tracker-bridge\] session started\n/)
  FLIGHT.forEach((line) => assert.ok(text.includes(line), `missing: ${line.slice(0, 60)}`))
  assert.deepEqual(log.counts, { ballSamples: 6, contacts: 1 })
})

test('the stadium marker is written once per change, never for an unknown park', async (t) => {
  const dir = scratch(t)
  const log = createTrackerSessionLog({ dir, prefix: 'bridge' })

  assert.equal(log.noteStadium({ stadiumKey: null }), null)
  const first = log.noteStadium({ stadiumKey: 'mario_stadium', stadiumName: 'Mario Stadium', stadiumOverrideKey: 'mario_stadium' })
  assert.equal(first, 'TRACKER_STADIUM] key=mario_stadium|name=Mario Stadium|source=override')
  // Called on every log line in both processes, so re-announcing an unchanged
  // park would bury the file in markers.
  assert.equal(log.noteStadium({ stadiumKey: 'mario_stadium', stadiumName: 'Mario Stadium' }), null)
  const second = log.noteStadium({ stadiumKey: 'wario_city', stadiumName: 'Wario City' })
  assert.equal(second, 'TRACKER_STADIUM] key=wario_city|name=Wario City|source=detected')
  await log.close()

  const markers = readFileSync(log.path, 'utf8').split('\n').filter((l) => l.startsWith('TRACKER_STADIUM]'))
  assert.equal(markers.length, 2)
  assert.equal(log.stadiumKey, 'wario_city')
})

test('two sessions started in the same second get their own file', async (t) => {
  const dir = scratch(t)
  const startedAt = new Date('2026-08-24T18:41:23')
  const a = createTrackerSessionLog({ dir, prefix: 'bridge', startedAt })
  const b = createTrackerSessionLog({ dir, prefix: 'bridge', startedAt })
  a.write(sample(1, 0, 1, -18.6))
  b.write(sample(1, 0, 1, -18.6))
  await a.close(); await b.close()

  assert.notEqual(a.path, b.path)
  assert.equal(findLogs(dir).length, 2)
})

test('a session with flights but no park says so, because that cannot be repaired later', async (t) => {
  const dir = scratch(t)
  const log = createTrackerSessionLog({ dir, prefix: 'bridge' })
  FLIGHT.forEach((line) => log.write(line))
  const unlabelled = log.summary().join(' ')
  assert.match(unlabelled, /WARNING: no stadium was ever set/)

  log.noteStadium({ stadiumKey: 'mario_stadium', stadiumName: 'Mario Stadium' })
  const labelled = log.summary().join(' ')
  assert.doesNotMatch(labelled, /WARNING/)
  assert.match(labelled, /stadium recorded: mario_stadium/)
  await log.close()
})

test('an empty session is reported as nothing to distil rather than as a missing park', async (t) => {
  const dir = scratch(t)
  const log = createTrackerSessionLog({ dir, prefix: 'bridge' })
  log.write('18:41:24 [INFO] Dolphin hooked.')
  const summary = log.summary().join(' ')
  assert.match(summary, /no ball data in this session/)
  assert.doesNotMatch(summary, /WARNING/)
  await log.close()
})

// The whole reason the bridge writes one of these. A game recorded through the
// bridge has to leave behind flights the archive can read and attribute, or the
// statistics are saved and every trajectory in the game is lost.
test('a bridge-written log yields park-labelled flights through the untouched pipeline', async (t) => {
  const dir = scratch(t)
  const log = createTrackerSessionLog({ dir, prefix: 'bridge' })
  // The bridge knows the park from the games row before the tracker launches,
  // so its marker precedes every sample — which is what positional attribution
  // in ball_trajectories.mjs requires.
  log.noteStadium({ stadiumKey: 'mario_stadium', stadiumName: 'Mario Stadium', stadiumOverrideKey: 'mario_stadium' })
  FLIGHT.forEach((line) => log.write(line))
  await log.close()

  const { sessions } = loadSessions([dir])
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].stadiumKey, 'mario_stadium')

  const flights = buildFlights(loadSessions([dir]))
  assert.equal(flights.length, 1)
  assert.equal(flights[0].stadiumKey, 'mario_stadium')
  assert.equal(flights[0].batter, 'Birdo')
})
