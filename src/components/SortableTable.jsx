import { useMemo, useState } from 'react'
import StatLabel from './StatLabel'

// Generic click-header-to-sort table for bespoke (non stat-progression) tables — Franchise
// History, Draft Value, Game Log — that render arbitrary per-column JSX (buttons, colored spans)
// rather than the Season/Career-row convention StatTable.jsx is built around.
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

export default function SortableTable({ columns, rows, rowKey, onRowClick, rowStyle, minWidth = 560 }) {
  const [sort, setSort] = useState(null)

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
    if (col.sortable === false) return
    setSort((current) => {
      const defaultDirection = col.defaultDirection ?? -1
      if (!current || current.key !== col.key) return { key: col.key, direction: defaultDirection }
      if (current.direction === defaultDirection) return { key: col.key, direction: -current.direction }
      return null
    })
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={col.sortable === false ? undefined : () => handleHeaderClick(col)}
                style={{ cursor: col.sortable === false ? 'default' : 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
              >
                <StatLabel label={col.label} />
                {sort?.key === col.key ? (sort.direction === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              style={{
                background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent',
                cursor: onRowClick ? 'pointer' : 'default',
                ...(rowStyle?.(row, i) || {}),
              }}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} style={col.cellStyle?.(row)}>{col.render ? col.render(row) : row[col.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
