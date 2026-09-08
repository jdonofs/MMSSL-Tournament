import { useCallback, useMemo, useRef, useState } from 'react'
import { getMarketLabel } from '../../utils/bettingMarkets'

// One series: cumulative net profit over settled tickets, by settlement time.
// A single series needs no legend — the heading names it — and no number on
// every point; the latest value is direct-labelled and the rest are read from
// the crosshair or the table view below.
const SERIES_COLOR = '#3987e5'
const GRID_COLOR = 'rgba(148, 163, 184, 0.22)'
const AXIS_TEXT = '#94a3b8'

const WIDTH = 720
const HEIGHT = 220
const PAD = { top: 16, right: 76, bottom: 28, left: 56 }

function formatShortDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'time not recorded'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function niceBounds(values) {
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (min === max) return { min: min - 1, max: max + 1 }
  const pad = (max - min) * 0.12
  return { min: min - pad, max: max + pad }
}

export default function CumulativeProfitChart({ curve, payoutFormatter, title = 'Cumulative net profit' }) {
  const svgRef = useRef(null)
  const [activeIndex, setActiveIndex] = useState(null)
  const [showTable, setShowTable] = useState(false)

  const points = curve?.points || []

  const geometry = useMemo(() => {
    if (points.length === 0) return null
    const times = points.map((point) => new Date(point.at).getTime())
    const tMin = Math.min(...times)
    const tMax = Math.max(...times)
    const spread = tMax - tMin
    const { min, max } = niceBounds(points.map((point) => point.cumulative))
    const plotWidth = WIDTH - PAD.left - PAD.right
    const plotHeight = HEIGHT - PAD.top - PAD.bottom

    const x = (index) => {
      if (points.length === 1) return PAD.left + plotWidth / 2
      // Equal times (a whole game settling at once) collapse the time axis, so
      // fall back to even spacing rather than stacking every point on one x.
      if (spread <= 0) return PAD.left + (plotWidth * index) / (points.length - 1)
      return PAD.left + (plotWidth * (times[index] - tMin)) / spread
    }
    const y = (value) => PAD.top + plotHeight - ((value - min) / (max - min)) * plotHeight

    return {
      x,
      y,
      min,
      max,
      zeroY: y(0),
      coords: points.map((point, index) => ({ x: x(index), y: y(point.cumulative) })),
      firstLabel: formatShortDate(points[0].at),
      lastLabel: formatShortDate(points[points.length - 1].at),
    }
  }, [points])

  const handleMove = useCallback((event) => {
    if (!geometry || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    const svgX = ratio * WIDTH
    let nearest = 0
    let bestDistance = Infinity
    geometry.coords.forEach((coord, index) => {
      const distance = Math.abs(coord.x - svgX)
      if (distance < bestDistance) { bestDistance = distance; nearest = index }
    })
    setActiveIndex(nearest)
  }, [geometry])

  const handleKeyDown = useCallback((event) => {
    if (!points.length) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setActiveIndex((current) => {
        const base = current == null ? (event.key === 'ArrowRight' ? -1 : points.length) : current
        const next = event.key === 'ArrowRight' ? base + 1 : base - 1
        return Math.max(0, Math.min(points.length - 1, next))
      })
    }
    if (event.key === 'Escape') setActiveIndex(null)
  }, [points.length])

  if (!points.length) {
    return (
      <div className="betting-chart-empty empty-state">
        <strong>No settled tickets to plot</strong>
        <span className="muted">
          {curve?.excludedCount
            ? `${curve.excludedCount} settled ticket${curve.excludedCount === 1 ? '' : 's'} could not be plotted: no settlement time was recorded.`
            : 'The curve appears once a ticket settles.'}
        </span>
      </div>
    )
  }

  const active = activeIndex == null ? null : points[activeIndex]
  const activeCoord = activeIndex == null ? null : geometry.coords[activeIndex]
  const last = points[points.length - 1]
  const lastCoord = geometry.coords[geometry.coords.length - 1]
  const path = geometry.coords.map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`).join(' ')

  return (
    <div className="betting-chart">
      <div className="betting-chart-head">
        <div>
          <strong>{title}</strong>
          <span className="muted">{curve.basis}</span>
        </div>
        <button className="link-button" onClick={() => setShowTable((current) => !current)} type="button">
          {showTable ? 'Hide data table' : 'Show data table'}
        </button>
      </div>

      <svg
        aria-label={`${title}. ${points.length} settled tickets. Latest cumulative value ${payoutFormatter(last.cumulative)}.`}
        className="betting-chart-svg"
        onBlur={() => setActiveIndex(null)}
        onKeyDown={handleKeyDown}
        onMouseLeave={() => setActiveIndex(null)}
        onMouseMove={handleMove}
        preserveAspectRatio="xMidYMid meet"
        ref={svgRef}
        role="img"
        tabIndex={0}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <line
          stroke={GRID_COLOR}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={geometry.zeroY}
          y2={geometry.zeroY}
        />
        {/* The zero label is dropped when a bound sits on top of it. */}
        {Math.abs(geometry.zeroY - PAD.top) > 14 && Math.abs(geometry.zeroY - (HEIGHT - PAD.bottom)) > 14 ? (
          <text fill={AXIS_TEXT} fontSize="11" x={8} y={geometry.zeroY + 4}>0</text>
        ) : null}
        <text fill={AXIS_TEXT} fontSize="11" x={8} y={PAD.top + 4}>{payoutFormatter(geometry.max)}</text>
        <text fill={AXIS_TEXT} fontSize="11" x={8} y={HEIGHT - PAD.bottom + 4}>{payoutFormatter(geometry.min)}</text>
        <text fill={AXIS_TEXT} fontSize="11" x={PAD.left} y={HEIGHT - 8}>{geometry.firstLabel}</text>
        <text fill={AXIS_TEXT} fontSize="11" textAnchor="end" x={WIDTH - PAD.right} y={HEIGHT - 8}>{geometry.lastLabel}</text>

        <path
          d={path}
          fill="none"
          stroke={SERIES_COLOR}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />

        {activeCoord ? (
          <g>
            <line
              stroke={GRID_COLOR}
              vectorEffect="non-scaling-stroke"
              x1={activeCoord.x}
              x2={activeCoord.x}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
            />
            <circle cx={activeCoord.x} cy={activeCoord.y} fill={SERIES_COLOR} r="5" stroke="#111c31" strokeWidth="2" />
          </g>
        ) : null}

        <circle cx={lastCoord.x} cy={lastCoord.y} fill={SERIES_COLOR} r="4" stroke="#111c31" strokeWidth="2" />
        <text
          fill="#e2e8f0"
          fontSize="12"
          fontWeight="700"
          x={Math.min(lastCoord.x + 10, WIDTH - PAD.right + 8)}
          y={lastCoord.y + 4}
        >
          {payoutFormatter(last.cumulative)}
        </text>
      </svg>

      <div aria-live="polite" className="betting-chart-readout">
        {active ? (
          <span>
            <strong>{payoutFormatter(active.cumulative)}</strong>
            <span className="muted">
              {' '}after {getMarketLabel(active.betType)} ticket #{active.betId} ({active.status},{' '}
              {active.profit >= 0 ? '+' : ''}{payoutFormatter(active.profit)}) · {formatDateTime(active.at)}
            </span>
          </span>
        ) : (
          <span className="muted">Hover or use the arrow keys to read a point.</span>
        )}
      </div>

      {curve.excludedCount ? (
        <p className="muted betting-chart-note">
          {curve.excludedCount} settled ticket{curve.excludedCount === 1 ? '' : 's'} ({payoutFormatter(curve.excludedProfit)} of
          net profit) {curve.excludedCount === 1 ? 'is' : 'are'} not on this curve: no settlement time was recorded for
          {curve.excludedCount === 1 ? ' it' : ' them'}, so {curve.excludedCount === 1 ? 'it has' : 'they have'} no place on a
          time axis. The curve therefore ends at {payoutFormatter(curve.endingCumulative)} rather than the headline total.
        </p>
      ) : null}

      {showTable ? (
        <div className="betting-chart-table-scroll">
          <table className="data-table">
            <caption className="muted">Every plotted point, in settlement order.</caption>
            <thead>
              <tr>
                <th scope="col">Settled</th>
                <th scope="col">Market</th>
                <th scope="col">Result</th>
                <th scope="col">Ticket profit</th>
                <th scope="col">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={`${point.betId}-${point.at}`}>
                  <th scope="row">{formatDateTime(point.at)}</th>
                  <td>{getMarketLabel(point.betType)}</td>
                  <td>{point.status}</td>
                  <td>{point.profit >= 0 ? '+' : ''}{payoutFormatter(point.profit)}</td>
                  <td>{payoutFormatter(point.cumulative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
