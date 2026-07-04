import { useMemo } from 'react'
import { getSipPrice } from '../utils/economy'

export default function SipPriceSparkline({ sipTransactions = [], width = 240, height = 56 }) {
  const prices = useMemo(() => {
    const ordered = sipTransactions
      .filter((entry) => entry.created_at)
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    let held = 0
    const series = [getSipPrice(held)]
    for (const tx of ordered) {
      if (tx.type === 'buy') held += 1
      if (tx.type === 'sell') held -= 1
      series.push(getSipPrice(held))
    }
    return series
  }, [sipTransactions])

  if (prices.length < 3) {
    return <div className="sip-sparkline-empty muted">Not enough history yet</div>
  }

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1
  const stepX = width / (prices.length - 1)
  const points = prices.map((price, index) => {
    const x = index * stepX
    const y = height - ((price - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const areaPoints = `0,${height} ${points.join(' ')} ${width},${height}`

  return (
    <svg className="sip-sparkline" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
      <polygon fill="url(#sipSparklineFill)" points={areaPoints} />
      <polyline fill="none" points={points.join(' ')} stroke="var(--gold)" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
      <defs>
        <linearGradient id="sipSparklineFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
