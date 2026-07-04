// Full-width rolling-stat line chart, modeled on SipPriceSparkline.jsx's hand-rolled SVG
// approach (min/max normalize, stepX/stepY mapping, polyline + gradient-fill polygon) since
// there's no charting library in this project. Unlike the sparkline, this is a primary section
// (not a decorative inline widget), so it includes axis labels.
export default function RollingStatChart({ points = [], width = 760, height = 220, label = '', color = '#EAB308' }) {
  if (points.length < 3) {
    return <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>Not enough data yet to chart a trend.</div>
  }

  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const paddingLeft = 36
  const paddingBottom = 18
  const chartWidth = width - paddingLeft
  const chartHeight = height - paddingBottom
  const stepX = chartWidth / (points.length - 1)

  const coords = points.map((p, index) => {
    const x = paddingLeft + index * stepX
    const y = chartHeight - ((p.value - min) / range) * chartHeight
    return { x, y }
  })
  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const areaPoints = `${paddingLeft},${chartHeight} ${polylinePoints} ${width},${chartHeight}`

  const gradientId = `rollingStatChartFill-${label.replace(/\s+/g, '') || 'default'}`
  const firstLabel = points[0]?.xLabel
  const lastLabel = points[points.length - 1]?.xLabel

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
        <text x={0} y={10} fontSize={10} fill="#64748B">{max.toFixed(3)}</text>
        <text x={0} y={chartHeight} fontSize={10} fill="#64748B">{min.toFixed(3)}</text>
        <polygon fill={`url(#${gradientId})`} points={areaPoints} />
        <polyline fill="none" points={polylinePoints} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      {(firstLabel || lastLabel) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748B', paddingLeft }}>
          <span>{firstLabel}</span>
          <span>{lastLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
