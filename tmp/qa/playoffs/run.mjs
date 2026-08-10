import { launch, ensureLoggedIn, shot } from './browser.mjs'
import { pathToFileURL } from 'url'

const stepsFile = process.argv[2]
if (!stepsFile) { console.error('usage: node run.mjs <steps.mjs>'); process.exit(1) }
const mod = await import(pathToFileURL(stepsFile).href)
const { context, page } = await launch()
try {
  await ensureLoggedIn(page)
  await mod.default(page)
} catch (err) {
  console.error('STEP FAILED:', err)
  try { await shot(page, 'failure') } catch {}
  process.exitCode = 1
} finally {
  await context.close()
}
