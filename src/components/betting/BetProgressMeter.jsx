// Live progress toward a ticket's line. Moved out of BettingTab so the ticket
// list and the receipt render exactly the same meter.
export default function BetProgressMeter({ progress, status }) {
  const { current, line, unit, wantsOver } = progress
  const max = Math.max(line * 2, current, 1)
  const fillPct = Math.min(100, (current / max) * 100)
  const markerPct = Math.min(100, (line / max) * 100)
  const hit = wantsOver ? current > line : current < line
  let fillColor = '#94A3B8'
  if (status === 'won') fillColor = '#22C55E'
  else if (status === 'lost') fillColor = '#EF4444'
  else if (status === 'open' || status === 'pending') fillColor = hit ? '#22C55E' : '#EAB308'

  return (
    <div className="bet-progress-meter">
      <div className="bet-progress-meter-track">
        <div className="bet-progress-meter-fill" style={{ width: `${fillPct}%`, background: fillColor }} />
        <div className="bet-progress-meter-marker" style={{ left: `${markerPct}%` }} />
      </div>
      <div className="bet-progress-meter-labels">
        <span>{current} {unit}</span>
        <span className="muted">Line: {line}</span>
      </div>
    </div>
  )
}
