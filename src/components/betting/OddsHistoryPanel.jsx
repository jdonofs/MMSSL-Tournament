import { useMemo } from 'react'
import { formatOdds } from '../../utils/bettingMarkets'
import { buildMarketKey, summarizeMarketHistory } from '../../utils/oddsHistory'

function formatTimestamp(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function formatLine(value) {
  return value == null ? '--' : Number(value).toFixed(1)
}

function formatContext(context = {}) {
  const parts = []
  if (context.inning != null) {
    const half = context.isTopInning == null ? '' : context.isTopInning ? 'Top ' : 'Bot '
    parts.push(`${half}${context.inning}`)
  }
  if (context.awayScore != null && context.homeScore != null) {
    parts.push(`${context.awayScore}-${context.homeScore}`)
  }
  if (!parts.length && context.status) parts.push(context.status)
  return parts.length ? parts.join(' · ') : 'not recorded'
}

function DeltaTag({ delta }) {
  if (delta == null || delta === 0) return null
  const improved = delta > 0
  return (
    <span className={`odds-history-delta ${improved ? 'odds-history-delta-up' : 'odds-history-delta-down'}`}>
      {improved ? '+' : ''}{delta}
    </span>
  )
}

// One market's recorded observations.
//
// Deliberate refusals, all of them things a naive history view gets wrong:
//   * The earliest row is labelled the FIRST RECORDED observation, never the
//     open. Nothing was recorded before this table existed.
//   * Odds either side of a line change are not compared: they price different
//     propositions, so no delta is shown across a line move.
//   * The two sides stay in their own columns; they are never merged, and no
//     other market's rows appear here.
export default function OddsHistoryPanel({
  status = 'idle',
  observations = [],
  betType,
  labels = {},
  acceptedTerms = null,
  compact = false,
}) {
  const summary = useMemo(
    () => summarizeMarketHistory(observations, { betType, labels, acceptedTerms }),
    [observations, betType, labels, acceptedTerms],
  )

  if (status === 'unavailable') {
    return (
      <div className="odds-history-note odds-history-note-muted" role="status">
        <strong>Odds history is unavailable</strong>
        <span className="muted">
          This database does not have the odds-history tables yet, so no observations have been recorded.
          Betting is unaffected.
        </span>
      </div>
    )
  }

  if (status === 'loading') {
    return <div className="odds-history-note muted" role="status">Loading recorded odds…</div>
  }

  if (status === 'error') {
    return (
      <div className="odds-history-note odds-history-note-muted" role="status">
        <strong>Odds history could not be loaded</strong>
        <span className="muted">The market is unaffected. Try expanding this again.</span>
      </div>
    )
  }

  if (!summary.observationCount) {
    return (
      <div className="odds-history-note odds-history-note-muted" role="status">
        <strong>No recorded odds movement</strong>
        <span className="muted">
          Nothing has been recorded for this market. Observations are written by the automatic tracker
          sync, so a game priced before that ran — or priced only in a browser — has no history.
        </span>
      </div>
    )
  }

  const rows = [...summary.changes].reverse()

  return (
    <div className="odds-history-panel">
      <div className="odds-history-summary">
        <div>
          <span className="muted">First recorded</span>
          <strong>
            {summary.sides.map((side) => `${side.label} ${formatOdds(summary.first.sides.find((entry) => entry.field === side.field)?.odds)}`).join(' / ')}
          </strong>
          <span className="muted">
            {summary.first.line == null ? '' : `line ${formatLine(summary.first.line)} · `}
            {formatTimestamp(summary.first.observedAt)}
          </span>
        </div>
        <div>
          <span className="muted">Latest recorded</span>
          <strong>
            {summary.sides.map((side) => `${side.label} ${formatOdds(summary.latest.sides.find((entry) => entry.field === side.field)?.odds)}`).join(' / ')}
          </strong>
          <span className="muted">
            {summary.latest.line == null ? '' : `line ${formatLine(summary.latest.line)} · `}
            {formatTimestamp(summary.latest.observedAt)}
          </span>
        </div>
      </div>

      <p className="odds-history-caveat muted">
        {summary.observationCount} recorded observation{summary.observationCount === 1 ? '' : 's'}
        {summary.lineChangeCount ? `, ${summary.lineChangeCount} line change${summary.lineChangeCount === 1 ? '' : 's'}` : ''}.
        The first row is the first observation this recorder saw, not the market’s opening price.
      </p>

      {acceptedTerms ? (
        <div className="odds-history-accepted">
          <span className="muted">Your ticket</span>
          <strong>
            {acceptedTerms.sideLabel} at {acceptedTerms.oddsLabel}
            {acceptedTerms.lineLabel ? ` · line ${acceptedTerms.lineLabel}` : ''}
          </strong>
          <span className="muted">Accepted {formatTimestamp(acceptedTerms.placedAt)} — this ticket pays at those terms.</span>
        </div>
      ) : null}

      <div className="odds-history-table-scroll">
        <table className="data-table odds-history-table">
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">Line</th>
              {summary.sides.map((side) => <th key={side.field} scope="col">{side.label}</th>)}
              {compact ? null : <th scope="col">Game</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((change) => (
              <tr key={change.id ?? `${change.observedAt}-${change.line}`}>
                <th scope="row">
                  <span>{formatTimestamp(change.observedAt)}</span>
                  {change.isFirstRecorded ? <span className="odds-history-first-pill">first recorded</span> : null}
                  {change.isLocked ? <span className="odds-history-lock-pill">locked</span> : null}
                </th>
                <td>
                  {formatLine(change.line)}
                  {change.lineChanged ? (
                    <span className="odds-history-line-move" title={`Line moved from ${formatLine(change.previousLine)}`}>
                      moved from {formatLine(change.previousLine)}
                    </span>
                  ) : null}
                </td>
                {change.sides.map((side) => (
                  <td key={side.field}>
                    {formatOdds(side.odds)}
                    <DeltaTag delta={side.delta} />
                  </td>
                ))}
                {compact ? null : <td className="muted">{formatContext(change.context)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.lineChangeCount ? (
        <p className="odds-history-caveat muted">
          Prices either side of a line change are not compared: a different line is a different proposition.
        </p>
      ) : null}
    </div>
  )
}

export function selectMarketObservations(rows = [], { betType, targetEntity = null }) {
  const key = buildMarketKey({ bet_type: betType, target_entity: targetEntity })
  return rows.filter((row) => buildMarketKey(row) === key)
}
