// Scorebook UI driver helpers for QA game scoring
import { BASE } from './browser.mjs'

const DEST_LABELS = ['1B', '2B', '3B', 'Home', 'Out']

export async function openGame(page, gameId = 2144) {
  await page.goto(`${BASE}/season/scorebook?game=${gameId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
}

export async function currentBatterName(page) {
  const text = await page.locator('body').innerText()
  const m = text.match(/BATTER\n([^\n]+)\n/)
  return m ? m[1].trim() : null
}

export async function pitchCount(page) {
  const text = await page.locator('body').innerText()
  const m = text.match(/\bP (\d+)\b/)
  return m ? +m[1] : null
}

// Click a pitch button and wait until the app actually records it (P count +1
// for the current pitcher, or the PA completes and the batter changes).
export async function clickPitch(page, kind) {
  const before = await pitchCount(page)
  const batterBefore = await currentBatterName(page)
  const btn = page.getByRole('button', { name: kind, exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    await btn.click()
    const start = Date.now()
    while (Date.now() - start < 6000) {
      await page.waitForTimeout(250)
      const p = await pitchCount(page)
      const batter = await currentBatterName(page)
      if ((p != null && before != null && p !== before) || batter !== batterBefore) return
    }
    console.log(`  retry pitch ${kind} (no state change)`)
  }
  throw new Error(`pitch ${kind} not registered`)
}

export async function clickResult(page, label) {
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  // stage 'result': the E button is unique to this stage
  await page.getByRole('button', { name: 'E', exact: true }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: label, exact: true }).click()
  if (label === 'HR') {
    // HR finalizes immediately from the result stage — wait for panel to close
    await page.getByRole('button', { name: 'E', exact: true }).waitFor({ state: 'hidden', timeout: 12000 })
    await page.waitForTimeout(600)
  } else {
    // stage 'details': field diagram appears
    await page.locator('img[alt="Baseball field"]').waitFor({ timeout: 8000 })
  }
  await page.waitForTimeout(400)
}

export async function clickChain(page, labels) {
  let expectedBadge = 0
  for (const label of labels) {
    expectedBadge += 1
    let selected = false
    for (let attempt = 0; attempt < 4 && !selected; attempt++) {
      const clicked = await page.evaluate((lbl) => {
        const field = [...document.querySelectorAll('img')].find((i) => i.alt === 'Baseball field')
        if (!field) return false
        const container = field.parentElement
        const btn = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === lbl)
        if (!btn) return false
        btn.click()
        return true
      }, label)
      if (!clicked) {
        await page.waitForTimeout(500)
        continue
      }
      // Verify: selected chain button's text becomes "<n><label>" (badge added)
      const start = Date.now()
      while (Date.now() - start < 2500 && !selected) {
        await page.waitForTimeout(300)
        selected = await page.evaluate(([lbl, badge]) => {
          const field = [...document.querySelectorAll('img')].find((i) => i.alt === 'Baseball field')
          if (!field) return false
          return [...field.parentElement.querySelectorAll('button')]
            .some((b) => b.textContent.trim() === `${badge}${lbl}`)
        }, [label, expectedBadge])
      }
      if (!selected) console.log(`  retry chain ${label} (badge not shown)`)
    }
    if (!selected) throw new Error(`chain click failed: ${label}`)
  }
}

// If a reload restored an open in-play details panel, back all the way out.
export async function cancelOpenInPlay(page) {
  for (let i = 0; i < 3; i++) {
    const backVisible = await page.getByRole('button', { name: 'BACK', exact: true }).isVisible().catch(() => false)
    if (!backVisible) return
    console.log('  cancelling open in-play panel (BACK)')
    await page.getByRole('button', { name: 'BACK', exact: true }).click()
    await page.waitForTimeout(800)
  }
}

export async function setDest(page, runnerName, dest) {
  let ok = `no row for ${runnerName}`
  for (let attempt = 0; attempt < 12; attempt++) {
    ok = await page.evaluate(([name, destLabel, labels]) => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.alt === name)
      for (const img of imgs) {
        let node = img.parentElement
        for (let depth = 0; depth < 8 && node; depth++) {
          const btns = [...node.querySelectorAll('button')].filter((b) => labels.includes(b.textContent.trim()))
          if (btns.length === labels.length) {
            const target = btns.find((b) => b.textContent.trim() === destLabel)
            if (!target || target.disabled) return `disabled or missing ${destLabel}`
            target.click()
            return true
          }
          node = node.parentElement
        }
      }
      return `no row for ${name}`
    }, [runnerName, dest, DEST_LABELS])
    if (ok === true) break
    await page.waitForTimeout(300)
  }
  if (ok !== true) throw new Error(`setDest(${runnerName}, ${dest}): ${ok}`)
  await page.waitForTimeout(400)
}

export async function confirmInPlay(page, batterBefore) {
  await page.getByRole('button', { name: 'CONFIRM', exact: true }).click()
  // Saved when the in-play panel is gone (CONFIRM disappears)
  const start = Date.now()
  while (Date.now() - start < 12000) {
    await page.waitForTimeout(400)
    const confirmVisible = await page.getByRole('button', { name: 'CONFIRM', exact: true }).isVisible().catch(() => false)
    if (!confirmVisible) return
  }
  throw new Error('in-play confirm did not complete')
}

export async function waitForBatter(page, name, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = await currentBatterName(page)
    if (current === name) return true
    await page.waitForTimeout(500)
  }
  throw new Error(`waitForBatter timeout: wanted ${name}, saw ${await currentBatterName(page)}`)
}

export async function changePitcherTo(page, name) {
  const avatar = page.locator(`img[alt="${name}"]`).first()
  await avatar.click()
  await page.waitForTimeout(500)
  await avatar.click()
  await page.waitForTimeout(2000)
}

export async function runPa(page, spec, log = console.log) {
  let batter = await currentBatterName(page)
  for (let i = 0; i < 6 && batter !== spec.batter; i++) {
    await page.waitForTimeout(500)
    batter = await currentBatterName(page)
  }
  if (batter !== spec.batter) throw new Error(`Batter mismatch: expected ${spec.batter}, got ${batter}`)
  for (const p of spec.pitches || []) await clickPitch(page, p)
  if (spec.inplay) {
    await clickResult(page, spec.inplay.result)
    if (spec.inplay.result === 'HR') {
      log(`PA done: ${spec.batter} -> HR (auto-finalized)`)
      return
    }
    const isHrLike = spec.inplay.result === 'IPHR'
    await clickChain(page, spec.inplay.chain || [])
    if (!isHrLike) {
      for (const [name, dest] of spec.inplay.dests || []) {
        try {
          await setDest(page, name, dest)
        } catch (err) {
          if (!spec.inplay.destsOptional) throw err
          log(`  (optional dest skipped: ${name}->${dest}: ${err.message})`)
        }
      }
      if (spec.inplay.batterDest) await setDest(page, spec.batter, spec.inplay.batterDest)
    }
    await confirmInPlay(page, spec.batter)
  }
  log(`PA done: ${spec.batter} -> ${spec.final}`)
}
