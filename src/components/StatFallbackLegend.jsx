import '../styles/stats-pages.css'

// Stat tables have three different blanks and they mean different things: "--" is a real
// measurement suppressed because the sample is too small, "-" was never measured or doesn't
// apply, and 0 is a recorded zero. Without this legend all three read as "no number".
//
// `note` names the actual minimum behind the "--" cells in the table it sits under.
export default function StatFallbackLegend({ note = null }) {
  return (
    <div className="stat-legend">
      <span className="stat-legend-item"><span className="stat-legend-key">--</span> below the minimum sample for this stat</span>
      <span className="stat-legend-item"><span className="stat-legend-key">-</span> not measured / not applicable</span>
      <span className="stat-legend-item"><span className="stat-legend-key">0</span> a real, recorded zero</span>
      {note ? <span className="stat-legend-item">{note}</span> : null}
    </div>
  )
}
