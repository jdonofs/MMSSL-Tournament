import { useMemo, useState } from 'react'
import StatLabel from './StatLabel'
import '../styles/stats-pages.css'

// Generic year-by-year stat table (Baseball-Reference style): one row per season/tournament
// event, an optional bolded Career total row, and a small type pill (Season/Tournament) per row
// so the two event types are visually distinguishable without needing to be sorted apart.
const TYPE_PILL_STYLE = {
  tournament: { color: '#A855F7', background: 'rgba(168,85,247,0.14)', border: 'rgba(168,85,247,0.35)', label: 'Tourney' },
  season: { color: '#3B82F6', background: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.35)', label: 'Season' },
}

function TypePill({ eventType }) {
  const meta = TYPE_PILL_STYLE[eventType]
  if (!meta) return null
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em',
      color: meta.color, background: meta.background, border: `1px solid ${meta.border}`,
      borderRadius: 999, padding: '0.05rem 0.4rem', marginLeft: 6, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// col.bold(row) => true bolds the cell (Baseball-Reference convention: led the whole
// season/tournament in that stat that year). col.award(row) => a short string rendered in a
// dedicated Awards column (only added if at least one column defines `award`).
function Cell({ col, row }) {
  const value = col.render ? col.render(row) : row[col.key]
  return col.bold?.(row) ? <strong>{value}</strong> : value
}

// Sorting works off whatever's actually in the row, not the rendered cell (which is often JSX,
// e.g. the player-portrait label) — falling back to parsing the rendered string only for derived
// stats that live on a nested object (col.key doesn't exist directly on the row, e.g.
// row.slashLine.avg rendered under key "avg").
function extractSortValue(col, row) {
  const rawValue = row[col.key]
  if (typeof rawValue === 'number' || typeof rawValue === 'string') return rawValue
  const rendered = col.render ? col.render(row) : rawValue
  if (typeof rendered === 'number') return rendered
  if (typeof rendered === 'string') {
    const num = parseFloat(rendered.replace(/,/g, ''))
    return Number.isNaN(num) ? rendered.toLowerCase() : num
  }
  return null
}

function defaultDirectionFor(key) {
  return key === 'label' ? 1 : -1
}

export default function StatTable({ columns, rows, careerRow, onRowClick, showTypePill = true }) {
  const [sort, setSort] = useState(null)
  const awardColumn = columns.find((col) => col.award)

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return rows
    return [...rows].sort((a, b) => {
      const va = extractSortValue(col, a)
      const vb = extractSortValue(col, b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.direction
      return String(va).localeCompare(String(vb)) * sort.direction
    })
  }, [rows, sort, columns])

  function handleHeaderClick(col) {
    setSort((current) => {
      if (!current || current.key !== col.key) return { key: col.key, direction: defaultDirectionFor(col.key) }
      if (current.direction === defaultDirectionFor(col.key)) return { key: col.key, direction: -current.direction }
      return null
    })
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: 560 }}>
        <thead>
          <tr>
            {columns.map((col) => (
              // The sort control is a real <button> rather than a click handler on the <th> so it
              // can be tabbed to and fired with Enter/Space; aria-sort tells a screen reader which
              // column is ordering the table and which way.
              <th
                key={col.key}
                scope="col"
                aria-sort={sort?.key === col.key ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}
                style={{ userSelect: 'none', whiteSpace: 'nowrap' }}
              >
                <button className="stat-sort-button" onClick={() => handleHeaderClick(col)} type="button">
                  <StatLabel label={col.label} />
                  <span aria-hidden="true" className="stat-sort-caret">
                    {sort?.key === col.key ? (sort.direction === 1 ? '▲' : '▼') : ''}
                  </span>
                </button>
              </th>
            ))}
            {awardColumn && <th key="__award" scope="col">Awards</th>}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr
              // eventKey alone collides whenever one event contributes several rows — a character
              // who played three positions in one season yields three rows all keyed "season:37".
              // Callers with that shape pass an explicit rowKey.
              key={row.rowKey || row.eventKey || row.characterId || i}
              style={{
                background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent',
                cursor: onRowClick ? 'pointer' : 'default',
              }}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col, colIndex) => (
                <td key={col.key}>
                  <Cell col={col} row={row} />
                  {colIndex === 0 && showTypePill && <TypePill eventType={row.eventType} />}
                </td>
              ))}
              {awardColumn && <td key="__award" style={{ color: '#94A3B8', fontSize: 11 }}>{awardColumn.award(row) || ''}</td>}
            </tr>
          ))}
          {careerRow && (
            <tr style={{ borderTop: '2px solid rgba(234,179,8,0.4)', fontWeight: 700, background: 'rgba(234,179,8,0.09)' }}>
              {columns.map((col, i) => (
                <td key={col.key} style={i === 0 ? { color: '#FDE68A', fontWeight: 700 } : undefined}>
                  {i === 0 ? (careerRow.label || 'Career') : (col.render ? col.render(careerRow) : careerRow[col.key])}
                </td>
              ))}
              {awardColumn && <td key="__award" />}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
