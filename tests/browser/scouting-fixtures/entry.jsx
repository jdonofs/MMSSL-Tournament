import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { RawValueTable } from '../../../src/pages/CharacterScoutingReport.jsx'

// The rows are built in the test process by the real buildRawValueRows and
// handed in as data, so the browser side asserts RENDERING and nothing else.
// If the seed never arrived there is nothing to assert against, which is why
// the mount records whether it got one instead of rendering an empty table.
const seed = globalThis.__SCOUTING_SEED__
const root = createRoot(document.getElementById('root'))

if (!seed || !Array.isArray(seed.rows)) {
  globalThis.__SCOUTING_MOUNTED__ = { seeded: false, rows: 0 }
  root.render(createElement('div', { 'data-testid': 'no-seed' }, 'no fixture seed'))
} else {
  globalThis.__SCOUTING_MOUNTED__ = { seeded: true, rows: seed.rows.length }
  root.render(createElement(
    MemoryRouter,
    null,
    createElement('div', { 'data-testid': 'table-host' },
      createElement(RawValueTable, { rows: seed.rows })),
  ))
}
