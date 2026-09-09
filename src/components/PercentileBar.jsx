// Baseball-Savant-style percentile ranking bar: a blue (low) -> red (high) gradient with a
// marker at the character's percentile, plus the raw value shown as a number (never color-only).
const GRADIENT = 'linear-gradient(to right, #3B82F6, #94A3B8, #EF4444)'

export default function PercentileBar({ label, value, percentile, formatValue }) {
  const pct = Number.isFinite(percentile) ? Math.max(0, Math.min(100, percentile)) : null
  const displayValue = formatValue ? formatValue(value) : value

  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ color: '#CBD5E1', fontWeight: 600 }}>{label}</span>
        <span style={{ color: '#F8FAFC', fontWeight: 700 }}>
          {displayValue ?? '-'}{pct != null ? ` (${pct}th)` : ''}
        </span>
      </div>
      <div style={{ position: 'relative', height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        {/* No percentile means no measurement. Painting the gradient anyway leaves an unranked
            metric looking like a full red bar, i.e. elite, which is the opposite of unknown. */}
        {pct != null && <div style={{ position: 'absolute', inset: 0, backgroundImage: GRADIENT, opacity: 0.35 }} />}
        {pct != null && (
          <div style={{
            position: 'absolute', top: -2, left: `${pct}%`, width: 3, height: 12,
            background: '#F8FAFC', borderRadius: 2, transform: 'translateX(-50%)',
          }} />
        )}
      </div>
    </div>
  )
}
