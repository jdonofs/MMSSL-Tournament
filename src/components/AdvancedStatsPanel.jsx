import { useState } from 'react'
import StatTable from './StatTable'

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}
function formatPct(value, fallback = '-') {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : fallback
}
function formatIndex(value, fallback = '-') {
  return Number.isFinite(value) ? Math.round(value) : fallback
}

const SEASON_COLUMN = { key: 'label', label: 'Season' }

const BATTING_COLUMNS = [
  SEASON_COLUMN,
  { key: 'babip', label: 'BABIP', render: (r) => formatDecimal(r.babip) },
  { key: 'iso', label: 'ISO', render: (r) => formatDecimal(r.iso) },
  { key: 'woba', label: 'wOBA', render: (r) => formatDecimal(r.woba) },
  { key: 'wrcPlus', label: 'wRC+', render: (r) => formatIndex(r.wrcPlus) },
  { key: 'opsPlus', label: 'OPS+', render: (r) => formatIndex(r.opsPlus) },
  { key: 'bbPct', label: 'BB%', render: (r) => formatPct(r.bbPct) },
  { key: 'kPct', label: 'K%', render: (r) => formatPct(r.kPct) },
  { key: 'bbkRatio', label: 'BB/K', render: (r) => formatDecimal(r.bbkRatio, 2) },
  { key: 'xbhPct', label: 'XBH%', render: (r) => formatPct(r.xbhPct) },
  { key: 'rc', label: 'RC', render: (r) => formatDecimal(r.rc, 1) },
]

const PITCHING_COLUMNS = [
  SEASON_COLUMN,
  { key: 'sampleSize', label: 'BIP', render: (r) => Number.isFinite(r.sampleSize) ? r.sampleSize : '-' },
  { key: 'fip', label: 'FIP', render: (r) => (r.hasInningsPitched ? formatDecimal(r.fip, 2) : '-') },
  { key: 'eraMinus', label: 'ERA-', render: (r) => (r.hasInningsPitched ? formatIndex(r.eraMinus) : '-') },
  { key: 'fipMinus', label: 'FIP-', render: (r) => (r.hasInningsPitched ? formatIndex(r.fipMinus) : '-') },
  { key: 'kBB', label: 'K/BB', render: (r) => formatDecimal(r.kBB, 2) },
  { key: 'kPct', label: 'K%', render: (r) => formatPct(r.kPct) },
  { key: 'bbPct', label: 'BB%', render: (r) => formatPct(r.bbPct) },
  { key: 'babipAllowed', label: 'BABIP', render: (r) => formatDecimal(r.babipAllowed) },
  { key: 'xBAAllowed', label: 'xBAA', render: (r) => formatDecimal(r.xBAAllowed) },
  { key: 'xSLGAllowed', label: 'xSLGA', render: (r) => formatDecimal(r.xSLGAllowed) },
  { key: 'xwOBAAllowed', label: 'xwOBAA', render: (r) => formatDecimal(r.xwOBAAllowed) },
]

const toggleButtonStyle = (active) => ({
  padding: '0.3rem 0.8rem', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.12)',
  background: active ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.03)',
  color: active ? '#93C5FD' : '#94A3B8',
})

const noData = <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No data recorded yet</p>

// Wires the existing summarizeAdvancedBatting/summarizeAdvancedPitching sabermetrics (wOBA,
// wRC+, OPS+, ISO, BABIP, FIP, ERA-, FIP-) into the same year-by-year + Career row convention as
// Standard Stats, with a Batting/Pitching toggle rather than stacking both. The toggle always
// renders (even with zero data) so a scope/character with no pitching, say, still lets the user
// switch to it and see "No data recorded yet" instead of the tab disappearing entirely.
export default function AdvancedStatsPanel({ battingRows, battingCareerRow, pitchingRows, pitchingCareerRow, hasBatting, hasPitching, onRowClick, isCareer = true }) {
  const [view, setView] = useState(hasBatting ? 'batting' : 'pitching')
  const battingColumns = isCareer ? BATTING_COLUMNS : BATTING_COLUMNS.filter((col) => col !== SEASON_COLUMN)
  const pitchingColumns = isCareer ? PITCHING_COLUMNS : PITCHING_COLUMNS.filter((col) => col !== SEASON_COLUMN)

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={toggleButtonStyle(view === 'batting')} onClick={() => setView('batting')}>Batting</button>
        <button type="button" style={toggleButtonStyle(view === 'pitching')} onClick={() => setView('pitching')}>Pitching</button>
      </div>
      {view === 'batting'
        ? (hasBatting ? <StatTable columns={battingColumns} rows={battingRows} careerRow={battingCareerRow} onRowClick={onRowClick} showTypePill={isCareer} /> : noData)
        : (hasPitching ? <StatTable columns={pitchingColumns} rows={pitchingRows} careerRow={pitchingCareerRow} onRowClick={onRowClick} showTypePill={isCareer} /> : noData)}
    </div>
  )
}
