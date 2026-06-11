import { useMemo, useState } from 'react'
import TeamLogo from './TeamLogo'
import { getTeamAbbreviation, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'

const COLUMN_CONFIG = [
  { key: 'overallRating', label: 'OVR', color: '#F8FAFC', title: 'Overall rating' },
  { key: 'battingRating', label: 'BAT', color: '#22C55E', title: 'Batting rating' },
  { key: 'pitchingRating', label: 'PIT', color: '#EF4444', title: 'Pitching rating' },
  { key: 'fieldingRating', label: 'FLD', color: '#EAB308', title: 'Fielding rating' },
  { key: 'speedRating', label: 'SPD', color: '#38BDF8', title: 'Speed rating' },
]

function TeamIdentityCell({ playerId, identitiesByPlayerId, playersById, height = 40 }) {
  const player = playersById[playerId] || null
  const identity = identitiesByPlayerId[playerId] || null
  const teamLabel = getTeamShortName(identity) || player?.name || 'TBD'
  const mobileLabel = getTeamAbbreviation(identity) || teamLabel
  const color = getTeamPrimaryColor(identity, player?.color)

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <TeamLogo
        height={height}
        logoKey={identity?.teamLogoKey}
        logoUrl={identity?.teamLogoUrl}
        teamName={identity?.teamName}
        placeholder
      />
      <span style={{ minWidth: 0 }}>
        <span className="season-team-label season-team-label-full" style={{ fontWeight: 800, fontSize: 13, color: color || 'inherit' }}>{teamLabel}</span>
        <span className="season-team-label season-team-label-mobile" style={{ fontWeight: 800, fontSize: 13, color: color || 'inherit' }}>{mobileLabel}</span>
      </span>
    </span>
  )
}

function SortableHeader({ label, color, active, direction, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        background: 'none',
        padding: 0,
        color,
        font: 'inherit',
        fontWeight: 800,
        cursor: 'pointer',
      }}
    >
      <span>{label}</span>
      <span style={{ color: active ? color : '#64748B', fontSize: 12 }}>{active ? (direction === 'asc' ? '↑' : '↓') : ''}</span>
    </button>
  )
}

function RatingBreakdownModal({ row, column, onClose }) {
  if (!row || !column) return null

  const breakdownKey = column.key === 'overallRating'
    ? 'overall'
    : column.key === 'battingRating'
      ? 'batting'
      : column.key === 'pitchingRating'
        ? 'pitching'
        : column.key === 'fieldingRating'
          ? 'fielding'
          : 'speed'
  const breakdown = row.ratingBreakdowns?.[breakdownKey]

  if (!breakdown) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(680px, calc(100vw - 24px))', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="section-head" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>{row.teamName} {column.label} Breakdown</h2>
            <div className="muted" style={{ marginTop: 4 }}>{breakdown.formula}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'none', color: '#94A3B8', fontSize: 24, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Close rating breakdown"
          >
            ×
          </button>
        </div>

        <div className="page-stack">
          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Calculation</h3>
              <div style={{ color: breakdown.color, fontWeight: 800, fontSize: 22 }}>{breakdown.finalRating.toFixed(1)}</div>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {breakdown.components.map((component) => (
                <div
                  key={component.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: 'rgba(15,23,42,0.55)',
                    border: '1px solid rgba(148,163,184,0.18)',
                  }}
                >
                  <span className="muted" style={{ fontWeight: 700 }}>{component.label}</span>
                  <span style={{ color: '#F8FAFC', fontWeight: 800, textAlign: 'right' }}>{component.display}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Inputs</h3>
            </div>
            {breakdown.scaleReference ? (
              <div
                style={{
                  marginBottom: 10,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.18)',
                  color: '#DCFCE7',
                  fontSize: 13,
                }}
              >
                {breakdown.scaleReference}
              </div>
            ) : null}
            <div style={{ display: 'grid', gap: 8 }}>
              {breakdown.summaryLines.map((line) => (
                <div
                  key={line}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(148,163,184,0.14)',
                    color: '#CBD5E1',
                    fontSize: 13,
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default function CompetitionOverviewTables({
  standings = [],
  powerRankings = [],
  rankingsLoading = false,
  rankingsError = '',
  identitiesByPlayerId = {},
  playersById = {},
  viewerPlayerId = null,
}) {
  const [activeView, setActiveView] = useState('standings')
  const [sortState, setSortState] = useState({ key: 'overallRating', direction: 'desc' })
  const [selectedBreakdown, setSelectedBreakdown] = useState(null)

  const sortedPowerRankings = useMemo(() => (
    [...powerRankings].sort((a, b) => {
      const aValue = Number(a[sortState.key] || 0)
      const bValue = Number(b[sortState.key] || 0)
      if (aValue === bValue) return b.overallRating - a.overallRating || a.teamName.localeCompare(b.teamName)
      return sortState.direction === 'asc' ? aValue - bValue : bValue - aValue
    })
  ), [powerRankings, sortState])

  const handleSort = (key) => {
    setSortState((current) => (
      current.key === key
        ? { key, direction: current.direction === 'desc' ? 'asc' : 'desc' }
        : { key, direction: 'desc' }
    ))
  }

  const openBreakdown = (row, column) => {
    setSelectedBreakdown({ row, column })
  }

  return (
    <div className="page-stack">
      <div className="tab-row">
        <button className={`tab-button ${activeView === 'standings' ? 'tab-button-active' : ''}`} onClick={() => setActiveView('standings')} type="button">Standings</button>
        <button className={`tab-button ${activeView === 'power' ? 'tab-button-active' : ''}`} onClick={() => setActiveView('power')} type="button">Power Rankings</button>
      </div>

      {activeView === 'standings' ? (
        <section className="table-card season-compact-card">
          <div className="section-head">
            <h2>Standings</h2>
          </div>
          <div className="season-table-shell">
            <table className="data-table season-data-table season-standings-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>W</th>
                  <th>L</th>
                  <th>GB</th>
                  <th>RD</th>
                  <th>Home</th>
                  <th>Away</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row) => (
                  <tr key={row.id} style={row.player_id === viewerPlayerId ? { background: 'rgba(234,179,8,0.12)' } : undefined}>
                    <td><TeamIdentityCell playerId={row.player_id} identitiesByPlayerId={identitiesByPlayerId} playersById={playersById} /></td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td>{row.gamesBack}</td>
                    <td>{row.run_differential}</td>
                    <td>{row.home_wins}-{row.home_losses}</td>
                    <td>{row.away_wins}-{row.away_losses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {activeView === 'power' ? (
        <section className="table-card season-compact-card">
          <div className="section-head">
            <h2>Power Rankings</h2>
          </div>

          {rankingsError ? <p className="muted" style={{ color: '#FCA5A5' }}>{rankingsError}</p> : null}
          {rankingsLoading ? <p className="muted">Loading power rankings...</p> : null}

          <div className="season-table-shell">
            <table className="data-table season-data-table season-power-table">
              <thead>
                <tr>
                  <th>Team</th>
                  {COLUMN_CONFIG.map((column) => (
                    <th key={column.key}>
                      <SortableHeader
                        label={column.label}
                        color={column.color}
                        title={column.title}
                        active={sortState.key === column.key}
                        direction={sortState.direction}
                        onClick={() => handleSort(column.key)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedPowerRankings.map((row) => (
                  <tr key={row.id} style={row.playerId === viewerPlayerId ? { background: 'rgba(234,179,8,0.12)' } : undefined}>
                    <td>
                      <TeamIdentityCell playerId={row.playerId} identitiesByPlayerId={identitiesByPlayerId} playersById={playersById} />
                    </td>
                    {COLUMN_CONFIG.map((column) => (
                      <td
                        key={column.key}
                        style={{ padding: '6px 6px' }}
                      >
                        <button
                          type="button"
                          onClick={() => openBreakdown(row, column)}
                          title={`Show ${column.label} calculation`}
                          style={{
                            border: '1px solid rgba(148,163,184,0.2)',
                            background: 'rgba(15,23,42,0.35)',
                            color: column.color,
                            fontWeight: 800,
                            borderRadius: 8,
                            padding: '6px 6px',
                            minWidth: 36,
                            cursor: 'pointer',
                          }}
                        >
                          {Number(row[column.key] || 0).toFixed(1)}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
                {!rankingsLoading && !sortedPowerRankings.length ? (
                  <tr>
                    <td colSpan={6} className="muted">No teams available yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <RatingBreakdownModal
        row={selectedBreakdown?.row}
        column={selectedBreakdown?.column}
        onClose={() => setSelectedBreakdown(null)}
      />
    </div>
  )
}
