// Extracted from Stats.jsx's TeamStatCardModal so both the league Stats page and the
// per-team Team page can render the same grouped "scouting report" tile layout.
export function StatTile({ label, value, color = '#F8FAFC' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: 'inherit', fontSize: 16, fontWeight: 800, color }}>{value}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#94A3B8' }}>{label}</span>
    </div>
  )
}

export function TeamStatCardGroup({ title, accent, tiles }) {
  return (
    <div style={{ background: '#1E293B', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: '#CBD5E1' }}>{title}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px 8px' }}>
        {tiles.map((tile) => <StatTile key={tile.label} {...tile} />)}
      </div>
    </div>
  )
}
