// A read-only smoke check of the Scouting Report against a running app.
//
//   npm run dev                                   (in another terminal)
//   SLUGGERS_QA_USER=… SLUGGERS_QA_PASSWORD=… node tests/character-mechanics-browser.mjs
//
// WHAT THIS IS AND IS NOT. It is not the test of the character-mechanics
// states -- that is tests/character-mechanics-browser.test.mjs, which builds
// its own rows and asserts them exactly, needs no server and no credentials,
// and is what a change to the presentation has to pass. This is the separate
// question of whether the real page, against the real database, still renders
// something this release understands: every measured cell has to be one of the
// states the table defines, and the sample count beside it has to agree with
// which state it is.
//
// It therefore asserts INVARIANTS and never a count. Live numbers move every
// time a game is tracked, so a test that pinned one would fail for the wrong
// reason; a test that printed one and carried on would pass for no reason.
//
// STRICTLY READ ONLY. It signs in, navigates and reads. It intercepts nothing,
// writes nothing, and fabricates no rows -- the fixture that used to live here
// moved to the deterministic test, where an injected row is checked rather
// than announced.
//
// CREDENTIALS COME FROM THE ENVIRONMENT. Nothing is defaulted and nothing is
// printed; a missing variable is named and the run stops.

import assert from 'node:assert/strict'
import process from 'node:process'

import { chromium } from 'playwright'

const BASE = process.env.SLUGGERS_QA_URL || 'http://localhost:5173'
// A character to open. Configurable because no particular character is part of
// what is being checked -- the invariants below hold for any of them.
const CHARACTER_ID = process.env.SLUGGERS_QA_CHARACTER_ID || '10'
const NAV_TIMEOUT = Number(process.env.SLUGGERS_QA_TIMEOUT_MS || 60000)

// The rows this page is expected to carry. A missing one means the table was
// reshaped, which is a failure and not something to notice in the output.
const REQUIRED_METRICS = [
  'fieldTopSpeed', 'ordinaryReach', 'diveReach', 'leapReach',
  'catchHeight', 'facingAwayReach', 'jumpDistance', 'baserunTopSpeed',
]

function requireEnv(name) {
  const value = process.env[name]
  if (value) return value
  // The NAME only. The value is a credential and never reaches this output,
  // this repository, or a screenshot.
  console.error(`missing required environment variable ${name}`)
  console.error('This check signs in to a running app; it takes the account from the '
    + 'environment and has no default. Set SLUGGERS_QA_USER and SLUGGERS_QA_PASSWORD '
    + 'in your shell (or export them from your own .env) and re-run.')
  process.exit(2)
  return null
}

// ─── The states a measured cell is allowed to be in ──────────────────────────
//
// Anything else is an unrecognised rendering: a blank cell, a raw null, a
// state some later change introduced without saying so here. The check is that
// every cell matches exactly one of these, so a new state fails loudly the
// first time it reaches the page.
const MEASURED_STATES = [
  ['none', /^—$/],
  ['no samples', /^no samples$/],
  ['too few', /^too few( · \d+ of \d+)?$/],
  ['none held', /^0 of \d+ held$/],
  ['boosted only', /^boosted only · \d+$/],
  ['matches neither row', /^matches neither row · \d+$/],
  ['no ordinary observation', /^no ordinary observation · \d+$/],
  ['no rating', /^no rating · \d+$/],
  ['unaccounted', /^unaccounted · \d+$/],
  // A value: number, optional unit, optional percentile, optional excluded count.
  ['value', /^-?\d+(\.\d+)?( [^\s(]+)?( \(\d+\))?( · \d+ excluded)?$/],
]

function stateOf(text) {
  const matches = MEASURED_STATES.filter(([, pattern]) => pattern.test(text))
  return matches.length === 1 ? matches[0][0] : null
}

async function login(page, user, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.body.innerText.includes('Who are you?'),
    { timeout: NAV_TIMEOUT },
  )
  await page.locator('button', { hasText: new RegExp(`^${user}$`) }).first().click({ timeout: NAV_TIMEOUT })
  const field = page.locator('input[type="password"]')
  await field.waitFor({ timeout: NAV_TIMEOUT })
  await field.fill(password)
  await page.keyboard.press('Enter')
  // Signed in is a state to wait FOR, not a duration to sleep through: the
  // picker going away is the event.
  await page.waitForFunction(
    () => !document.body.innerText.includes('Who are you?'),
    { timeout: NAV_TIMEOUT },
  )
}

async function readScoutingRows(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // A TIMEOUT HERE IS A FAILURE. The previous version swallowed it and
  // carried on reading whatever had rendered, which could be an empty table.
  await page.waitForSelector('tr[data-metric]', { timeout: NAV_TIMEOUT })
  await page.waitForFunction(
    (metrics) => metrics.every((key) => document.querySelector(`tr[data-metric="${key}"]`)),
    REQUIRED_METRICS,
    { timeout: NAV_TIMEOUT },
  )
  // SETTLED MEANS THE INDEXES ARRIVED, not that some text appeared. Every
  // measured cell has text from the first render -- "no samples" is text --
  // so waiting for non-empty cells passes before any tracking read resolves
  // and every state reads as empty. useCharacterExtras sets
  // minedByCharacterId and measuredByCharacterId in ONE setExtras call, so a
  // numeric value in the published column of a row that always has one is
  // proof that the measured index beside it is also final. It depends on no
  // live count.
  await page.waitForFunction(() => {
    const row = document.querySelector('tr[data-metric="fieldTopSpeed"]')
    const published = row?.querySelectorAll('td')[1]
    return Boolean(published && /\d/.test(published.innerText))
  }, { timeout: NAV_TIMEOUT })

  return page.evaluate(() => [...document.querySelectorAll('tr[data-metric]')].map((tr) => {
    const td = [...tr.querySelectorAll('td')]
    const clean = (node) => node.innerText.replace(/\s+/g, ' ').trim()
    return {
      key: tr.dataset.metric,
      label: tr.querySelector('[data-testid="metric-label"]')?.innerText.trim() || '',
      mined: clean(td[1]),
      measured: clean(td[2]),
      n: clean(td[3]),
      delta: clean(td[4]),
    }
  }))
}

function checkRows(rows, label) {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  for (const key of REQUIRED_METRICS) {
    assert.ok(byKey.has(key), `${label}: the table has no "${key}" row`)
  }

  for (const row of rows) {
    const state = stateOf(row.measured)
    assert.ok(state, `${label}: ${row.key} rendered an unrecognised measured cell: ${JSON.stringify(row.measured)}`)
    assert.ok(row.label.length > 0, `${label}: ${row.key} rendered with no name`)

    // The sample count has to agree with the state beside it. These are the
    // pairings that would have hidden the bug this release fixes: a cell that
    // says nothing was observed while the count says otherwise, or a value
    // published with no denominator under it.
    if (state === 'no samples') {
      assert.match(row.n, /^(0|—)$/, `${label}: ${row.key} says "no samples" with n = ${row.n}`)
    }
    if (state === 'value' && row.key !== 'jumpDistance') {
      assert.match(row.n, /^\d+$/, `${label}: ${row.key} publishes a value with n = ${row.n}`)
      assert.notEqual(row.n, '0', `${label}: ${row.key} publishes a value over zero observations`)
    }
    if (state === 'none held') {
      assert.equal(row.n, '0', `${label}: ${row.key} says nothing was held with n = ${row.n}`)
    }
    if (['boosted only', 'matches neither row', 'no ordinary observation', 'no rating'].includes(state)) {
      assert.equal(row.n, '0',
        `${label}: ${row.key} has no ordinary observation but shows n = ${row.n}`)
    }
  }

  // The rows that have no measured counterpart at all must not claim one.
  for (const key of ['catchHeight', 'facingAwayReach']) {
    assert.equal(byKey.get(key).measured, '—', `${label}: ${key} is published-only and must show a dash`)
    assert.equal(byKey.get(key).n, '—', `${label}: ${key} must not show a sample count`)
  }
  // ...and the rows that are deliberately not compared must never show a delta.
  for (const key of ['ordinaryReach', 'diveReach', 'leapReach', 'baserunTopSpeed']) {
    const row = byKey.get(key)
    assert.match(row.delta, /^(—|not comparable)$/,
      `${label}: ${key} published a difference between quantities that are not the same`)
  }
  return byKey
}

const user = requireEnv('SLUGGERS_QA_USER')
const password = requireEnv('SLUGGERS_QA_PASSWORD')

let browser
let failed = false
try {
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await login(page, user, password)
  const career = await readScoutingRows(page, `${BASE}/character/${CHARACTER_ID}/scouting`)
  const byKey = checkRows(career, `character ${CHARACTER_ID} career`)

  // A SCOPE CHANGE IS WHERE THE CLASSIFICATION MATTERS MOST: boosted rows can
  // outnumber ordinary ones inside one season even when they do not over a
  // career. Any scope chip will do; if the page offers none, that is reported
  // rather than silently skipped.
  const scopeChip = page.locator('a[href*="/scouting"]').filter({ hasNotText: /^Career$/ }).first()
  if (await scopeChip.count()) {
    await scopeChip.click()
    await page.waitForFunction(
      (career) => window.location.pathname !== career,
      `/character/${CHARACTER_ID}/scouting`,
      { timeout: NAV_TIMEOUT },
    )
    const scoped = await readScoutingRows(page, page.url())
    checkRows(scoped, `character ${CHARACTER_ID} scoped`)
    console.log(`scoped view at ${page.url()}: ${scoped.length} rows, all states recognised`)
  } else {
    console.log('no scope chips offered for this character; career scope only')
  }

  assert.deepEqual(pageErrors, [], 'the page raised errors')

  console.log(`career view: ${career.length} rows, all states recognised`)
  console.log(`  top speed  measured=${byKey.get('fieldTopSpeed').measured} n=${byKey.get('fieldTopSpeed').n}`)
  console.log(`  standing   measured=${byKey.get('ordinaryReach').measured} n=${byKey.get('ordinaryReach').n}`)
  console.log(`  dive       measured=${byKey.get('diveReach').measured} n=${byKey.get('diveReach').n}`)
  console.log('OK')
} catch (error) {
  failed = true
  console.error(`FAILED: ${error.message}`)
} finally {
  // Unconditional: a thrown assertion used to leave a chromium process behind.
  await browser?.close()
}
process.exit(failed ? 1 : 0)
