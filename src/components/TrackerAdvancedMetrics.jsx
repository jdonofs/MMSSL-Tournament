import { presentMeasurement } from '../utils/trackerConsoleView'

// The per-play measurement review panel.
//
// The rule this panel exists to hold is the one that is easiest to break by
// accident: MISSING IS NOT ZERO, and EXCLUDED IS NOT MISSING. A reaction time
// of 0.00 s is a real measurement of a fielder who was already moving; a blank
// reaction time is a fielder the game glided, who has no honest one. A Buddy
// Throw's speed is measured perfectly and still must not count as arm strength.
// Rendering all three as an empty cell -- or all three as a number -- is how a
// measurement review turns into a measurement invention.

const VALUE_TONE_COLORS = {
  measured: '#f8fafc',
  zero: '#f8fafc',
  missing: '#fbbf24',
  excluded: '#fbbf24',
  projected: '#7dd3fc',
  model: '#94a3b8',
}

const STATUS_NOTES = {
  measured: 'Observed by the capture',
  derived: 'Computed from measurements',
  excluded: 'Measured, but excluded from ratings',
  missing: 'Not measured — this is not a zero',
}

function MetricValue({ row }) {
  const presented = presentMeasurement(row.value, {
    unit: row.unit || '',
    digits: 2,
    status: row.status,
    note: row.note,
  })
  return (
    <span
      style={{ color: VALUE_TONE_COLORS[presented.tone] || '#f8fafc', whiteSpace: 'nowrap', fontWeight: presented.missing ? 600 : 700 }}
      title={presented.title || undefined}
    >
      {presented.text}
      {presented.tone === 'zero' && (
        <span className="tc-visually-hidden"> (a measured zero, not a missing value)</span>
      )}
    </span>
  )
}

export default function TrackerAdvancedMetrics({ metrics, onFlag, open = false }) {
  if (!metrics) return null
  const rows = metrics.rows || []
  const models = metrics.models || []
  const measured = rows.filter((row) => row.value != null).length
  const excluded = rows.filter((row) => row.status === 'excluded').length
  const missing = rows.length - measured

  const summary = metrics.status === 'ready'
    ? `${measured} of ${rows.length} measurements available`
    : metrics.status === 'unjoined'
      ? 'Waiting for an unambiguous play join'
      : 'Waiting for tracking'

  return (
    <section className="panel tc-detail-panel tc-advanced-metrics" style={{ minWidth: 0 }} aria-label="Advanced metrics for the selected play">
      <details open={open}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
          Advanced metrics · {summary}
          {metrics.status === 'ready' && (missing || excluded) ? (
            <span className="muted" style={{ fontWeight: 500, fontSize: 12 }}>
              {' '}({missing} not measured{excluded ? `, ${excluded} excluded` : ''})
            </span>
          ) : null}
        </summary>

        <p className="muted" style={{ fontSize: 12 }}>
          Review the selected play against what you saw. Flag a measurement to record the value and
          your observation beside the capture. Units marked “u” are game world units.
          <strong> A blank value is unmeasured, never zero.</strong>
        </p>

        {metrics.status === 'unjoined' && (
          <p style={{ color: '#fbbf24', fontSize: 12 }}>
            This at-bat has no unambiguously joined 60 Hz play, so no measurement may be attributed
            to it. The play is still listed in the session table with its join reason.
          </p>
        )}

        {(metrics.exclusions || []).map((note) => (
          <p key={note} style={{ color: '#fbbf24', fontSize: 12 }}>{note}</p>
        ))}

        {metrics.status === 'ready' && (
          <p className="muted" style={{ fontSize: 12 }}>
            Structural double-play opportunity:{' '}
            <strong style={{ color: metrics.double_play == null ? '#fbbf24' : '#f8fafc' }}>
              {metrics.double_play == null ? 'Unknown' : metrics.double_play ? 'Yes' : 'No'}
            </strong>
            {'. '}Eligibility uses the scored trajectory, first-base occupancy and outs before the play.
          </p>
        )}

        {['Fielding', 'Throws', 'Running'].map((group) => {
          const entries = rows.filter((row) => row.group === group)
          if (!entries.length) return null
          return (
            <div key={group} style={{ marginTop: 14 }}>
              <div
                className="tc-scroll"
                tabIndex={0}
                role="group"
                aria-label={`${group} measurements, scrollable`}
              >
                <table className="tc-table" style={{ minWidth: 620 }}>
                  <caption>{group} — {entries.length} measurement{entries.length === 1 ? '' : 's'}</caption>
                  <thead>
                    <tr>
                      {['Player', 'Metric', 'Value', 'Status / definition', 'Review'].map((label) => (
                        <th key={label} scope="col">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((row) => (
                      <tr key={row.id}>
                        <th scope="row" style={{ position: 'static', background: 'none', color: '#e2e8f0', fontWeight: 600 }}>
                          {row.actor}
                        </th>
                        <td title={row.source}>{row.label}</td>
                        <td><MetricValue row={row} /></td>
                        <td style={{ maxWidth: 380, color: row.status === 'excluded' ? '#fbbf24' : '#94a3b8' }}>
                          {row.status}
                          {STATUS_NOTES[row.status] ? ` — ${STATUS_NOTES[row.status]}` : ''}
                          {row.note ? ` · ${row.note}` : ''}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="tc-btn tc-btn--danger"
                            style={{ fontSize: 11, padding: '4px 9px', minHeight: 30 }}
                            onClick={() => onFlag({ text: `${row.actor}: ${row.label}`, metric: row })}
                          >
                            Flag
                            <span className="tc-visually-hidden">
                              {` ${row.actor} ${row.label} as wrong`}
                            </span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}

        {models.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Modeled values</h3>
            {models.map((model) => (
              <p key={model.label} style={{ fontSize: 12, margin: '0 0 4px' }}>
                <strong>{model.label}:</strong>{' '}
                <span style={{ color: model.status === 'Baseline required' ? '#94a3b8' : '#f8fafc' }}>
                  {model.status}
                </span>{' '}
                <span className="muted">{model.note}</span>
              </p>
            ))}
          </div>
        )}

        <p className="muted" style={{ fontSize: 10 }}>
          Metric definitions: {metrics.model_version}. Probabilities are not fitted to this test play.
        </p>
      </details>
    </section>
  )
}
