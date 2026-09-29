// The Scouting Report's raw-value table, rendered in a real browser against
// rows this file builds.
//
//   node --test tests/character-mechanics-browser.test.mjs
//   npm run test:scouting-browser
//
// WHY THIS EXISTS AS A TEST. The states this table draws are mostly ABSENCES,
// and absences are what a screenshot review waves through: "no samples", "too
// few", "0 of n held" and "boosted only" are four different sentences about
// four different situations, and any of them rendering as a dash or as another
// one of the four looks entirely normal. tests/character-mechanics-traits.test.mjs
// proves the ROW is right; this proves the row reaches the screen intact.
//
// NO DATABASE, NO CREDENTIALS, NO LIVE COUNTS. The rows are built here by the
// real buildRawValueRows from fixed indexes, handed to the page as data, and
// asserted character for character. Nothing here logs in, and the Supabase
// client is redirected to a stub that throws, so a read that sneaked back in
// would fail rather than quietly return nothing.
//
// The live-data counterpart is tests/character-mechanics-browser.mjs, which is
// deliberately a separate, read-only smoke check.

import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { scoutingFixturePlugin } from './browser/scouting-fixtures/vitePlugin.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'scouting-fixtures')

let server
let loader
let browser
let baseUrl
let buildRawValueRows

before(async () => {
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const selectedPort = socket.address().port
      socket.close(() => resolve(selectedPort))
    })
  })
  // Two Vite servers, because they are rooted differently. `loader` is rooted
  // at the repo and only loads the row builder into THIS process --
  // measuredAttributes reaches characterAnalysis, which imports JSON through
  // Vite's loader, exactly as tests/character-mechanics-traits.test.mjs does.
  // `server` is rooted at the fixture and serves the page.
  loader = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  ;({ buildRawValueRows } = await loader.ssrLoadModule('/src/utils/measuredAttributes.js'))
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: 'error',
    plugins: [scoutingFixturePlugin(), react()],
    server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [repoRoot] } },
    optimizeDeps: { include: [] },
  })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch()
})

// Unconditional, and in an `after` rather than at the end of the last test, so
// a failure or a thrown assertion still closes the browser and the server
// instead of leaving a chromium process and a listening port behind.
after(async () => {
  await browser?.close()
  await server?.close()
  await loader?.close()
})

const METRES_TO_FEET = 3.280839895
const FEET_PER_SECOND_TO_MPH = 3600 / 5280
// Wario's run_speed 40 row of FIELD_SPEED_CURVE, and the floor(40 * 1.5) = 60
// row the boost reads instead. Written out rather than imported so a change to
// the curve shows up here as a failure rather than moving both sides together.
//
// THE INDEX STORES ft/s AND THE TABLE DISPLAYS mph. `measured.scale` on the row
// definition does that conversion, so the fixtures below are in feet and every
// expected string is in miles per hour -- which is also the check that the
// scale is still applied on the way to the screen.
const ORDINARY_FPS = Number((0.129 * 59.94 * METRES_TO_FEET).toFixed(3))
const BOOSTED_FPS = Number((0.134 * 59.94 * METRES_TO_FEET).toFixed(3))
const OFF_CURVE_FPS = 99.9
const mph = (fps) => (fps * FEET_PER_SECOND_TO_MPH).toFixed(2)
const FPS_TO_MPH = 3600 / 5280

/**
 * One character's rows, rendered.
 *
 * Every wait here is an assertion: a timeout means the page never produced the
 * thing the test is about, which is a failure and not a reason to carry on
 * with whatever happens to be on screen.
 */
async function renderRows(t, rows) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  t.after(() => page.close())

  await page.addInitScript((seed) => { globalThis.__SCOUTING_SEED__ = seed }, { rows })
  await page.goto(baseUrl, { waitUntil: 'load' })

  // FIXTURE INJECTION IS CHECKED, NOT ASSUMED. The old script reported
  // "injected 6 rows" from a branch that also ran when it had found no
  // template to clone.
  const mounted = await page.evaluate(() => globalThis.__SCOUTING_MOUNTED__ || null)
  assert.ok(mounted, 'the fixture entry never ran')
  assert.equal(mounted.seeded, true, 'the fixture seed did not reach the page')
  assert.equal(mounted.rows, rows.length, 'the page mounted a different number of rows')

  await page.waitForSelector('[data-testid="table-host"] table tbody tr[data-metric]', { timeout: 15000 })
  await page.waitForFunction(
    (expected) => document.querySelectorAll('tbody tr[data-metric]').length === expected,
    rows.length,
    { timeout: 15000 },
  )

  // Keyed by the metric's own name, read from the element that holds only the
  // name -- the first cell also carries the measured-side label and the note.
  const cells = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('tbody tr[data-metric]')]
    .map((tr) => {
      const td = [...tr.querySelectorAll('td')]
      const clean = (node) => node.innerText.replace(/\s+/g, ' ').trim()
      const label = tr.querySelector('[data-testid="metric-label"]')?.innerText.trim() || ''
      return [label, {
        key: tr.dataset.metric,
        label,
        mined: clean(td[1]),
        measured: clean(td[2]),
        n: clean(td[3]),
        delta: clean(td[4]),
        title: td[2].querySelector('[title]')?.getAttribute('title') || null,
      }]
    })))

  assert.deepEqual(pageErrors, [], 'the page raised errors')
  assert.deepEqual(consoleErrors, [], 'the page logged console errors')
  return cells
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Two characters, because every percentile on this table ranks against the
// whole cast and a cast of one has no ranks. 7 is the subject of each test and
// 8 exists to be the other end of the scale.

const mined = () => ({
  7: { fieldTopSpeedFps: ORDINARY_FPS, catchRadiusRegular: 1.888, catchRadiusHeight: 3.009 },
  8: { fieldTopSpeedFps: BOOSTED_FPS, catchRadiusRegular: 2.4, catchRadiusHeight: 3.2 },
})

const speedMeasured = (overrides) => ({
  7: {
    maxSpeedFps: null,
    maxSpeedSamples: 0,
    maxSpeedUnverifiedFps: null,
    maxSpeedBoostedFps: null,
    maxSpeedBoostedSamples: 0,
    maxSpeedUnclassifiedSamples: 0,
    maxSpeedObservedSamples: 0,
    maxSpeedClassified: true,
    maxSpeedDistinctValues: 0,
    ...overrides,
  },
  8: {
    maxSpeedFps: BOOSTED_FPS, maxSpeedSamples: 30, maxSpeedObservedSamples: 30,
    maxSpeedClassified: true, maxSpeedBoostedSamples: 0, maxSpeedUnclassifiedSamples: 0,
    maxSpeedDistinctValues: 1, maxSpeedBoostedFps: null, maxSpeedUnverifiedFps: null,
  },
})

const only = (rows, keys) => rows.filter((row) => keys.includes(row.key))

// ─── The catch-reach states ──────────────────────────────────────────────────

test('a reach with enough secured catches renders its value and its denominator', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), {
    7: { ordinaryReachUnits: 3.62, ordinaryReachSamples: 7, ordinaryReachAttempts: 11 },
    8: { ordinaryReachUnits: 2.95, ordinaryReachSamples: 9, ordinaryReachAttempts: 12 },
  }), ['ordinaryReach'])
  const cells = await renderRows(t, rows)
  const reach = cells['Standing Catch Reach']

  assert.match(reach.measured, /^3\.62 u/, 'the quantile is the measured value')
  assert.equal(reach.n, '7', 'n is the secured catches the quantile was taken over')
  assert.match(reach.mined, /^1\.888 u/)
  // The published radius is glove-relative and the observation runs from the
  // actor origin. Both columns have a number and neither difference is real.
  assert.equal(reach.delta, 'not comparable')
})

test('secured catches below the threshold say how many, not "no samples"', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), {
    7: { ordinaryReachUnits: null, ordinaryReachSamples: 1, ordinaryReachAttempts: 6 },
  }), ['ordinaryReach'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Standing Catch Reach'].measured, 'too few · 1 of 6')
  assert.equal(cells['Standing Catch Reach'].n, '1')
  assert.equal(cells['Standing Catch Reach'].delta, '—')
})

test('attempts with nothing held is its own sentence', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), {
    7: { diveReachUnits: null, diveReachSamples: 0, diveReachAttempts: 6 },
  }), ['diveReach'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Dive Reach'].measured, '0 of 6 held')
  assert.equal(cells['Dive Reach'].n, '0')
})

test('a character never tried at an approach reports no samples', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), { 7: {} }), ['diveReach'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Dive Reach'].measured, 'no samples')
  assert.equal(cells['Dive Reach'].n, '0')
})

test('a static-only trait shows its published value and no measured side', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), { 7: {} }), ['catchHeight'])
  const cells = await renderRows(t, rows)

  assert.match(cells['Catch Height'].mined, /^3\.009 u/)
  assert.equal(cells['Catch Height'].measured, '—', 'no measured counterpart exists at all')
  assert.equal(cells['Catch Height'].n, '—', 'and not even a zero, which would imply one could')
  assert.equal(cells['Catch Height'].delta, '—')
})

test('a measured-only trait shows nothing on the published side', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), {
    7: { leapReachUnits: 4.1, leapReachSamples: 6, leapReachAttempts: 7 },
    8: { leapReachUnits: 3.2, leapReachSamples: 6, leapReachAttempts: 8 },
  }), ['leapReach'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Leap Reach'].mined, '—', 'no workbook column has been identified as the leap reach')
  assert.match(cells['Leap Reach'].measured, /^4\.10 u/)
  assert.equal(cells['Leap Reach'].n, '6')
})

// ─── The speed-classification states ─────────────────────────────────────────
//
// Each of these was rendering as "no samples" with n = 0, which is the one
// sentence that is definitely wrong: the observations exist, and what they
// are is exactly the point.

test('ordinary observations publish the constant and name what was left out', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({
    maxSpeedFps: ORDINARY_FPS,
    maxSpeedSamples: 4,
    maxSpeedBoostedFps: BOOSTED_FPS,
    maxSpeedBoostedSamples: 14,
    maxSpeedObservedSamples: 18,
    maxSpeedDistinctValues: 2,
  })), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)
  const speed = cells['Top Speed (fielding)']

  assert.match(speed.measured, new RegExp(`^${(ORDINARY_FPS * FPS_TO_MPH).toFixed(2)} mph`))
  assert.match(speed.measured, /· 14 excluded$/, 'the excluded observations must be discoverable')
  assert.equal(speed.n, '4', 'the denominator is the ordinary observations, not all 18')
  assert.match(speed.title, /4 ordinary observations of 18/)
  assert.match(speed.title, /boosted curve row/)
  // Same quantity in the same unit, so this row does show a real difference.
  assert.match(speed.delta, /mph$/)
})

test('a character seen only while boosted says so', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({
    maxSpeedBoostedFps: BOOSTED_FPS,
    maxSpeedBoostedSamples: 14,
    maxSpeedObservedSamples: 14,
    maxSpeedDistinctValues: 1,
  })), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)
  const speed = cells['Top Speed (fielding)']

  assert.equal(speed.measured, 'boosted only · 14')
  assert.equal(speed.n, '0', 'no ordinary observation, so no denominator for a value')
  assert.match(speed.title, /above what their rating allows/)
  assert.equal(speed.delta, '—', 'nothing may be differenced against a value we do not have')
})

test('constants matching neither curve row are named, not rounded to one', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({
    maxSpeedUnclassifiedSamples: 14,
    maxSpeedObservedSamples: 14,
    maxSpeedDistinctValues: 1,
  })), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Top Speed (fielding)'].measured, 'matches neither row · 14')
  assert.equal(cells['Top Speed (fielding)'].n, '0')
  assert.match(cells['Top Speed (fielding)'].title, /rounded to the nearer one/)
})

test('boosted and unmatched together get their own state', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({
    maxSpeedBoostedFps: BOOSTED_FPS,
    maxSpeedBoostedSamples: 3,
    maxSpeedUnclassifiedSamples: 2,
    maxSpeedObservedSamples: 5,
    maxSpeedDistinctValues: 2,
  })), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Top Speed (fielding)'].measured, 'no ordinary observation · 5')
  assert.equal(cells['Top Speed (fielding)'].n, '0')
})

test('a character with no rating is not given an ordinary constant', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({
    maxSpeedUnverifiedFps: OFF_CURVE_FPS,
    maxSpeedObservedSamples: 9,
    maxSpeedClassified: false,
    maxSpeedDistinctValues: 1,
  })), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)
  const speed = cells['Top Speed (fielding)']

  assert.equal(speed.measured, 'no rating · 9')
  assert.equal(speed.n, '0')
  assert.match(speed.title, /No run_speed for this character/)
  assert.match(speed.title, new RegExp(`${(OFF_CURVE_FPS * FPS_TO_MPH).toFixed(2)} mph`), 'the value is offered, labelled as unchecked')
  assert.equal(speed.delta, '—')
})

test('a character with no fielder observations at all still reports no samples', async (t) => {
  const rows = only(buildRawValueRows(7, mined(), speedMeasured({})), ['fieldTopSpeed'])
  const cells = await renderRows(t, rows)

  assert.equal(cells['Top Speed (fielding)'].measured, 'no samples')
  assert.equal(cells['Top Speed (fielding)'].n, '0')
  assert.equal(cells['Top Speed (fielding)'].title, null, 'nothing observed, so nothing to explain')
})

// ─── The table as a whole ────────────────────────────────────────────────────

test('every state can be told apart on one page', async (t) => {
  const rows = buildRawValueRows(7, mined(), {
    7: {
      maxSpeedFps: null, maxSpeedSamples: 0, maxSpeedBoostedFps: BOOSTED_FPS,
      maxSpeedBoostedSamples: 14, maxSpeedUnclassifiedSamples: 0,
      maxSpeedObservedSamples: 14, maxSpeedClassified: true, maxSpeedDistinctValues: 1,
      ordinaryReachUnits: null, ordinaryReachSamples: 1, ordinaryReachAttempts: 6,
      diveReachUnits: null, diveReachSamples: 0, diveReachAttempts: 6,
      leapReachUnits: 4.1, leapReachSamples: 6, leapReachAttempts: 7,
    },
    8: { maxSpeedFps: ORDINARY_FPS, maxSpeedSamples: 12, maxSpeedObservedSamples: 12, maxSpeedClassified: true },
  })
  const cells = await renderRows(t, rows)

  const shown = {
    'Top Speed (fielding)': 'boosted only · 14',
    'Standing Catch Reach': 'too few · 1 of 6',
    'Dive Reach': '0 of 6 held',
    'Catch Height': '—',
    'Facing-Away Reach': '—',
  }
  for (const [label, expected] of Object.entries(shown)) {
    assert.equal(cells[label].measured, expected, label)
  }
  assert.match(cells['Leap Reach'].measured, /^4\.10 u/)
  // Four absences and a value, and no two of them read the same way.
  assert.equal(new Set(Object.values(shown)).size, 4)
})
