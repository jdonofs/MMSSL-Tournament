import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import useTeamProfileData from '../hooks/useTeamProfileData'
import EntityPageSidebar from '../components/EntityPageSidebar'
import StatTable from '../components/StatTable'
import SortableTable from '../components/SortableTable'
import SprayChart from '../components/SprayChart'
import PercentileBar from '../components/PercentileBar'
import TeamLogo from '../components/TeamLogo'
import CharacterPortrait from '../components/CharacterPortrait'
import MiddleClickLink from '../components/MiddleClickLink'
import { getTeamShortName } from '../utils/teamIdentity'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { MIN_RANGE_CHANCES } from '../utils/fieldingRange'

const GRADE_COLORS = { S: '#EAB308', A: '#22C55E', B: '#3B82F6', C: '#94A3B8', D: '#F97316', F: '#EF4444' }

function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '-'
  const rounded = Number(value.toFixed(digits))
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}
function formatInteger(value, fallback = '-') {
  return Number.isFinite(value) ? String(value) : fallback
}
function formatPercent(value, digits = 1, fallback = '-') {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : fallback
}
function formatIndex(value, fallback = '-') {
  return Number.isFinite(value) ? Math.round(value) : fallback
}
// era/whip/FIP-derived stats default to 0 when there are no innings pitched (rather than being
// undefined), which reads as a false "0.00 ERA" — treat them as unavailable in that case instead.
function formatPitchingRatio(value, hasInnings, digits = 2) {
  return hasInnings ? formatDecimal(value, digits) : '-'
}
function formatWinPct(wins, losses) {
  const total = (wins || 0) + (losses || 0)
  if (!total) return '-'
  return (wins / total).toFixed(3).replace(/^0/, '')
}

function getFranchiseResultStyle(row, { gold, silver, bronze }) {
  if (row.finishPlace === 1) return { color: gold, fontWeight: 700 }
  if (row.finishPlace === 2) return { color: silver, fontWeight: 700 }
  if (row.finishPlace === 3) return { color: bronze, fontWeight: 700 }
  if (row.isChampion) return { color: gold, fontWeight: 700 }
  return null
}

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.12em',
      color: '#64748B', paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)',
      marginBottom: 14,
    }}>
      {children}
    </div>
  )
}

function Section({ id, title, subtitle, children }) {
  return (
    <section id={id} className="panel" style={{ padding: '1.25rem 1.4rem', scrollMarginTop: 16 }}>
      <SectionHeader>{title}</SectionHeader>
      {subtitle && <p style={{ color: '#64748B', fontSize: 12, margin: '-6px 0 14px' }}>{subtitle}</p>}
      {children}
    </section>
  )
}

const DEFAULT_TOGGLE_OPTIONS = [{ key: 'batting', label: 'Batting' }, { key: 'pitching', label: 'Pitching' }]

function StatTypeToggle({ value, onChange, options = DEFAULT_TOGGLE_OPTIONS }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          style={{
            padding: '0.3rem 0.8rem', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.12)',
            background: value === key ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.03)',
            color: value === key ? '#93C5FD' : '#94A3B8',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// First-column cell for the per-character stat tables: character portrait + name. The Team
// Total row has no characterId, so it falls back to plain text.
function PlayerCell({ row }) {
  if (row.characterId == null) return row.label
  const content = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <CharacterPortrait name={row.label} size={22} />
      {row.label}
    </span>
  )
  if (!row.linkTo) return content
  return (
    <MiddleClickLink
      to={row.linkTo}
      state={{ backTo: window.location.pathname + window.location.search }}
      stopPropagation
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      {content}
    </MiddleClickLink>
  )
}

const noData = <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No data recorded yet</p>

const BATTING_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'games', label: 'G' },
  { key: 'plateAppearances', label: 'PA' },
  { key: 'atBats', label: 'AB' },
  { key: 'runs', label: 'R' },
  { key: 'hits', label: 'H' },
  { key: 'doubles', label: '2B' },
  { key: 'triples', label: '3B' },
  { key: 'homeRuns', label: 'HR' },
  { key: 'rbi', label: 'RBI' },
  { key: 'walks', label: 'BB' },
  { key: 'strikeouts', label: 'SO' },
  { key: 'avg', label: 'AVG', render: (row) => formatDecimal(row.avg) },
  { key: 'obp', label: 'OBP', render: (row) => formatDecimal(row.obp) },
  { key: 'slg', label: 'SLG', render: (row) => formatDecimal(row.slg) },
  { key: 'ops', label: 'OPS', render: (row) => formatDecimal(row.ops) },
]

const PITCHING_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'games', label: 'G' },
  { key: 'innings', label: 'IP', render: (row) => formatDecimal(row.innings, 1) },
  { key: 'wins', label: 'W' },
  { key: 'losses', label: 'L' },
  { key: 'saves', label: 'SV' },
  { key: 'strikeouts', label: 'K' },
  { key: 'hitsAllowed', label: 'H' },
  { key: 'runsAllowed', label: 'R' },
  { key: 'earnedRuns', label: 'ER' },
  { key: 'walks', label: 'BB' },
  { key: 'homeRunsAllowed', label: 'HR' },
  { key: 'era', label: 'ERA/3', render: (row) => (row.innings > 0 ? formatDecimal(row.era, 2) : '-') },
  { key: 'whip', label: 'WHIP', render: (row) => (row.innings > 0 ? formatDecimal(row.whip, 2) : '-') },
]

const FIELDING_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'games', label: 'G' },
  { key: 'chances', label: 'TC' },
  { key: 'putouts', label: 'PO' },
  { key: 'assists', label: 'A' },
  { key: 'errors', label: 'E' },
  { key: 'fieldingPct', label: 'FLD%', render: (row) => formatDecimal(row.fieldingPct) },
  { key: 'buddyJumps', label: 'BJ' },
  { key: 'nicePlays', label: 'NP' },
  { key: 'nicePlayRate', label: 'NP%', render: (row) => formatPercent(row.nicePlayRate, 1) },
  {
    key: 'rangeRuns',
    label: 'RngR',
    render: (row) => (row.rangeable >= MIN_RANGE_CHANCES && row.rangeRuns != null
      ? (row.rangeRuns > 0 ? `+${row.rangeRuns}` : row.rangeRuns)
      : '—'),
  },
  {
    key: 'rangeFactorPlus',
    label: 'Range+',
    render: (row) => (row.rangeable >= MIN_RANGE_CHANCES && row.rangeFactorPlus != null ? row.rangeFactorPlus : '—'),
  },
  {
    key: 'rangeConfidence',
    label: 'Rng Conf',
    render: (row) => (row.rangeable >= MIN_RANGE_CHANCES && row.rangeConfidence != null ? `${row.rangeConfidence}%` : '—'),
  },
]

const STAR_HIT_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'used', label: 'Used' },
  { key: 'contactRate', label: 'Contact %', render: (row) => formatPercent(row.contactRate, 0) },
  { key: 'avgRbiPerUse', label: 'RBI/Use', render: (row) => formatDecimal(row.avgRbiPerUse, 2) },
  { key: 'avg', label: 'AVG', render: (row) => formatDecimal(row.slashLine?.avg) },
  { key: 'obp', label: 'OBP', render: (row) => formatDecimal(row.slashLine?.obp) },
  { key: 'slg', label: 'SLG', render: (row) => formatDecimal(row.slashLine?.slg) },
  { key: 'ops', label: 'OPS', render: (row) => formatDecimal(row.slashLine?.ops) },
  { key: 'avgExitVelo', label: 'Avg EV', render: (row) => (row.avgExitVelo != null ? `${row.avgExitVelo} mph` : '-') },
  { key: 'maxExitVelo', label: 'Max EV', render: (row) => (row.maxExitVelo != null ? `${row.maxExitVelo} mph` : '-') },
  { key: 'avgLaunchAngle', label: 'Avg LA', render: (row) => (row.avgLaunchAngle != null ? `${row.avgLaunchAngle}°` : '-') },
  { key: 'dist', label: 'Avg/Max Dist', render: (row) => (row.avgDistance != null ? `${row.avgDistance}/${row.maxDistance} ft` : '-') },
  { key: 'result1B', label: '1B', render: (row) => row.resultBreakdown?.['1B'] || 0 },
  { key: 'result2B', label: '2B', render: (row) => row.resultBreakdown?.['2B'] || 0 },
  { key: 'result3B', label: '3B', render: (row) => row.resultBreakdown?.['3B'] || 0 },
  { key: 'resultHR', label: 'HR', render: (row) => row.resultBreakdown?.HR || 0 },
  { key: 'resultK', label: 'K', render: (row) => row.resultBreakdown?.K || 0 },
  { key: 'resultBB', label: 'BB', render: (row) => row.resultBreakdown?.BB || 0 },
  { key: 'resultOut', label: 'Out', render: (row) => row.resultBreakdown?.Out || 0 },
  { key: 'resultError', label: 'Error', render: (row) => row.resultBreakdown?.Error || 0 },
]

const STAR_PITCH_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'used', label: 'Used', render: (row) => formatInteger(row.star?.used) },
  { key: 'paUsed', label: 'PA', render: (row) => formatInteger(row.star?.paUsed) },
  { key: 'pitchBalls', label: 'Ball', render: (row) => formatInteger(row.star?.pitchBalls) },
  { key: 'pitchStrikes', label: 'Strike', render: (row) => formatInteger(row.star?.pitchStrikes) },
  { key: 'oppAvg', label: 'AVG', render: (row) => (row.star?.paUsed > 0 ? formatDecimal(row.star?.oppSlashLine?.avg) : '-') },
  { key: 'oppObp', label: 'OBP', render: (row) => (row.star?.paUsed > 0 ? formatDecimal(row.star?.oppSlashLine?.obp) : '-') },
  { key: 'oppSlg', label: 'SLG', render: (row) => (row.star?.paUsed > 0 ? formatDecimal(row.star?.oppSlashLine?.slg) : '-') },
  { key: 'oppOps', label: 'OPS', render: (row) => (row.star?.paUsed > 0 ? formatDecimal(row.star?.oppSlashLine?.ops) : '-') },
  { key: 'evAllowed', label: 'Avg EV', render: (row) => (row.star?.avgExitVeloAllowed != null ? `${row.star.avgExitVeloAllowed} mph` : '-') },
  { key: 'laAllowed', label: 'Avg LA', render: (row) => (row.star?.avgLaunchAngleAllowed != null ? `${row.star.avgLaunchAngleAllowed}°` : '-') },
  { key: 'distAllowed', label: 'Avg Dist', render: (row) => (row.star?.avgDistanceAllowed != null ? `${row.star.avgDistanceAllowed} ft` : '-') },
  { key: 'result1B', label: '1B', render: (row) => row.star?.resultBreakdown?.['1B'] || 0 },
  { key: 'result2B', label: '2B', render: (row) => row.star?.resultBreakdown?.['2B'] || 0 },
  { key: 'result3B', label: '3B', render: (row) => row.star?.resultBreakdown?.['3B'] || 0 },
  { key: 'resultHR', label: 'HR', render: (row) => row.star?.resultBreakdown?.HR || 0 },
  { key: 'resultK', label: 'K', render: (row) => row.star?.resultBreakdown?.K || 0 },
  { key: 'resultBB', label: 'BB', render: (row) => row.star?.resultBreakdown?.BB || 0 },
  { key: 'resultOut', label: 'Out', render: (row) => row.star?.resultBreakdown?.Out || 0 },
]

const BATTED_BALL_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'ldRate', label: 'LD%', render: (row) => formatPercent(row.battedBall?.ldRate, 0) },
  { key: 'gbRate', label: 'GB%', render: (row) => formatPercent(row.battedBall?.gbRate, 0) },
  { key: 'fbRate', label: 'FB%', render: (row) => formatPercent(row.battedBall?.fbRate, 0) },
  { key: 'pullRate', label: 'Pull%', render: (row) => formatPercent(row.spray?.pullRate, 0) },
  { key: 'centerRate', label: 'Center%', render: (row) => formatPercent(row.spray?.centerRate, 0) },
  { key: 'oppoRate', label: 'Oppo%', render: (row) => formatPercent(row.spray?.oppoRate, 0) },
  { key: 'pitchesPerPa', label: 'P/PA', render: (row) => formatDecimal(row.discipline?.pitchesPerPa, 2) },
  { key: 'whiffRate', label: 'Whiff%', render: (row) => formatPercent(row.discipline?.whiffRate, 0) },
  { key: 'foulRate', label: 'Foul%', render: (row) => formatPercent(row.discipline?.foulRate, 0) },
  { key: 'ksRate', label: 'KS%', render: (row) => formatPercent(row.discipline?.ksRate, 0) },
  { key: 'klRate', label: 'KL%', render: (row) => formatPercent(row.discipline?.klRate, 0) },
  { key: 'gbBabip', label: 'GB BABIP', render: (row) => formatDecimal(row.battedByType?.groundBall?.babip) },
  { key: 'ldBabip', label: 'LD BABIP', render: (row) => formatDecimal(row.battedByType?.lineDrive?.babip) },
  { key: 'fbBabip', label: 'FB BABIP', render: (row) => formatDecimal(row.battedByType?.flyBall?.babip) },
  { key: 'ldWoba', label: 'LD wOBA', render: (row) => formatDecimal(row.battedByType?.lineDrive?.wobaOnContact) },
  { key: 'fbWoba', label: 'FB wOBA', render: (row) => formatDecimal(row.battedByType?.flyBall?.wobaOnContact) },
]

const BATTED_BALL_ALLOWED_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'ldRate', label: 'LD%', render: (row) => formatPercent(row.battedBall?.ldRate, 0) },
  { key: 'gbRate', label: 'GB%', render: (row) => formatPercent(row.battedBall?.gbRate, 0) },
  { key: 'fbRate', label: 'FB%', render: (row) => formatPercent(row.battedBall?.fbRate, 0) },
  { key: 'pullRate', label: 'Pull%', render: (row) => formatPercent(row.spray?.pullRate, 0) },
  { key: 'centerRate', label: 'Center%', render: (row) => formatPercent(row.spray?.centerRate, 0) },
  { key: 'oppoRate', label: 'Oppo%', render: (row) => formatPercent(row.spray?.oppoRate, 0) },
  { key: 'avgEvAllowed', label: 'Avg EV Allowed', render: (row) => (row.exitVelo?.avgExitVelocity != null ? `${row.exitVelo.avgExitVelocity} mph` : '-') },
  { key: 'barrelRateAllowed', label: 'Barrel% Allowed', render: (row) => formatPercent(row.contactQuality?.barrelRate, 0) },
  { key: 'hardHitRateAllowed', label: 'Hard-Hit% Allowed', render: (row) => formatPercent(row.contactQuality?.hardHitRate, 0) },
]

const CONTACT_AUTHORITY_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'bip', label: 'BIP', render: (row) => formatInteger(row.distanceProfile?.sampleSize || row.exitVeloProfile?.sampleSize || row.contactQuality?.sampleSize) },
  { key: 'avgExitVelo', label: 'Avg EV', render: (row) => (row.exitVeloProfile?.avgExitVelocity != null ? `${row.exitVeloProfile.avgExitVelocity} mph` : '-') },
  { key: 'maxExitVelo', label: 'Max EV', render: (row) => (row.exitVeloProfile?.maxExitVelocity != null ? `${row.exitVeloProfile.maxExitVelocity} mph` : '-') },
  { key: 'avgLaunchAngle', label: 'Avg LA', render: (row) => (row.exitVeloProfile?.avgLaunchAngle != null ? `${row.exitVeloProfile.avgLaunchAngle}°` : '-') },
  { key: 'avgDistance', label: 'Avg Dist', render: (row) => (row.distanceProfile?.avgDistance != null ? `${row.distanceProfile.avgDistance} ft` : '-') },
  { key: 'maxDistance', label: 'Longest', render: (row) => (row.distanceProfile?.maxDistance != null ? `${row.distanceProfile.maxDistance} ft` : '-') },
  { key: 'hardHitRateDist', label: 'Hard-Hit% (Dist)', render: (row) => formatPercent(row.distanceProfile?.hardHitRate, 0) },
  { key: 'parkAdjustedDistance', label: 'Park-Adj Dist', render: (row) => (row.parkAdjustedDistance != null ? `${row.parkAdjustedDistance} ft` : '-') },
  { key: 'hitPowerIndex', label: 'Power Index', render: (row) => formatInteger(row.hitPowerIndex) },
  { key: 'avgSprayAngle', label: 'Spray Angle', render: (row) => (row.spray?.avgSprayAngle != null ? `${row.spray.avgSprayAngle}°` : '-') },
  { key: 'barrelRate', label: 'Barrel%', render: (row) => formatPercent(row.contactQuality?.barrelRate, 0) },
  { key: 'hardHitRateEv', label: 'Hard-Hit% (EV)', render: (row) => formatPercent(row.contactQuality?.hardHitRate, 0) },
  { key: 'sweetSpotRate', label: 'Sweet-Spot%', render: (row) => formatPercent(row.contactQuality?.sweetSpotRate, 0) },
  { key: 'pullEv', label: 'Pull EV', render: (row) => (row.sprayContact?.pull?.avgExitVelocity != null ? `${row.sprayContact.pull.avgExitVelocity} mph` : '-') },
  { key: 'oppoEv', label: 'Oppo EV', render: (row) => (row.sprayContact?.oppo?.avgExitVelocity != null ? `${row.sprayContact.oppo.avgExitVelocity} mph` : '-') },
  { key: 'pullSlg', label: 'Pull SLG', render: (row) => formatDecimal(row.sprayContact?.pull?.slgOnContact) },
  { key: 'oppoSlg', label: 'Oppo SLG', render: (row) => formatDecimal(row.sprayContact?.oppo?.slgOnContact) },
]

const ADVANCED_BATTING_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'babip', label: 'BABIP', render: (row) => formatDecimal(row.babip) },
  { key: 'iso', label: 'ISO', render: (row) => formatDecimal(row.iso) },
  { key: 'woba', label: 'wOBA', render: (row) => formatDecimal(row.woba) },
  { key: 'wrcPlus', label: 'wRC+', render: (row) => formatIndex(row.wrcPlus) },
  { key: 'opsPlus', label: 'OPS+', render: (row) => formatIndex(row.opsPlus) },
  { key: 'bbPct', label: 'BB%', render: (row) => formatPercent(row.bbPct) },
  { key: 'kPct', label: 'K%', render: (row) => formatPercent(row.kPct) },
  { key: 'bbkRatio', label: 'BB/K', render: (row) => formatDecimal(row.bbkRatio, 2) },
  { key: 'xbhPct', label: 'XBH%', render: (row) => formatPercent(row.xbhPct) },
  { key: 'rc', label: 'RC', render: (row) => formatDecimal(row.rc, 1) },
]

const ADVANCED_PITCHING_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'fip', label: 'FIP', render: (row) => (row.hasInningsPitched ? formatDecimal(row.fip, 2) : '-') },
  { key: 'eraMinus', label: 'ERA-', render: (row) => (row.hasInningsPitched ? formatIndex(row.eraMinus) : '-') },
  { key: 'fipMinus', label: 'FIP-', render: (row) => (row.hasInningsPitched ? formatIndex(row.fipMinus) : '-') },
  { key: 'kBB', label: 'K/BB', render: (row) => formatDecimal(row.kBB, 2) },
  { key: 'kPct', label: 'K%', render: (row) => formatPercent(row.kPct) },
  { key: 'bbPct', label: 'BB%', render: (row) => formatPercent(row.bbPct) },
  { key: 'babipAllowed', label: 'BABIP', render: (row) => formatDecimal(row.babipAllowed) },
]

const EXPECTED_COLUMNS = [
  { key: 'label', label: 'Player', render: (row) => <PlayerCell row={row} /> },
  { key: 'avg', label: 'AVG', render: (row) => formatDecimal(row.avg) },
  { key: 'xBA', label: 'xBA', render: (row) => formatDecimal(row.xBA) },
  { key: 'slg', label: 'SLG', render: (row) => formatDecimal(row.slg) },
  { key: 'xSLG', label: 'xSLG', render: (row) => formatDecimal(row.xSLG) },
  { key: 'xwOBA', label: 'xwOBA', render: (row) => formatDecimal(row.xwOBA) },
]

const SPLITS_COLUMNS = [
  { key: 'label', label: 'Split' },
  { key: 'plateAppearances', label: 'PA' },
  { key: 'avg', label: 'AVG', render: (row) => formatDecimal(row.avg) },
  { key: 'obp', label: 'OBP', render: (row) => formatDecimal(row.obp) },
  { key: 'slg', label: 'SLG', render: (row) => formatDecimal(row.slg) },
  { key: 'ops', label: 'OPS', render: (row) => formatDecimal(row.ops) },
  { key: 'woba', label: 'wOBA', render: (row) => formatDecimal(row.woba) },
]

// Park factors describe a STADIUM's own league-wide effect on an outcome (1.00 = neutral), not
// anything about this team specifically — this table is just filtered to the parks this team has
// actually played at, same numbers anyone would see for that stadium.
const PARK_FACTOR_COLUMNS = [
  { key: 'stadiumName', label: 'Stadium' },
  { key: 'hr', label: 'HR', render: (row) => formatDecimal(row.hr, 2) },
  { key: 'r', label: 'Runs', render: (row) => formatDecimal(row.r, 2) },
  { key: 'h', label: 'Hits', render: (row) => formatDecimal(row.h, 2) },
  { key: 'walk', label: 'BB', render: (row) => formatDecimal(row.walk, 2) },
  { key: 'strikeout', label: 'K', render: (row) => formatDecimal(row.strikeout, 2) },
  { key: 'hardHit', label: 'Hard-Hit', render: (row) => formatDecimal(row.hardHit, 2) },
  { key: 'barrel', label: 'Barrel', render: (row) => formatDecimal(row.barrel, 2) },
]

const BASE_SECTION_LINKS = [
  { id: 'roster', label: 'Roster' },
  { id: 'stats', label: 'Standard Stats' },
  { id: 'advanced-stats', label: 'Advanced Stats' },
  { id: 'stars-used', label: 'Stars Used' },
  { id: 'stars-against', label: 'Stars Against' },
  { id: 'batted-ball', label: 'Batted Ball' },
  { id: 'batted-ball-allowed', label: 'Batted Ball Allowed' },
  { id: 'power', label: 'Contact Authority' },
  { id: 'spray-chart', label: 'Spray Chart' },
  { id: 'xstats', label: 'Expected Stats' },
  { id: 'splits', label: 'Splits' },
  { id: 'park-factors', label: 'Park Factors' },
  { id: 'draft-value', label: 'Draft Value' },
  { id: 'gamelog', label: 'Game Log' },
  { id: 'transactions', label: 'Transactions' },
]
const CAREER_SECTION_LINKS = [
  { id: 'franchise', label: 'Franchise History' },
  { id: 'top-players', label: 'All-Time Top Players' },
]

const BACK_BUTTON_STYLE = {
  justifySelf: 'start', display: 'flex', alignItems: 'center', gap: 6,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8,
  color: '#CBD5E1', padding: '0.4rem 0.75rem', fontSize: 13, fontWeight: 600, cursor: 'pointer',
}

const BACK_TO_STORAGE_PREFIX = 'sluggers-team-back:'

export default function TeamPage() {
  const { playerId, seasonId, tournamentId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const backToState = location.state?.backTo || null
  const [standardStatsView, setStandardStatsView] = useState('batting')
  const [advancedStatsView, setAdvancedStatsView] = useState('batting')
  const [starsUsedView, setStarsUsedView] = useState('batting')
  const [starsAgainstView, setStarsAgainstView] = useState('batting')
  const [splitsView, setSplitsView] = useState('batting')

  // The "true" originating page is only present in router state on the initial navigation into
  // this team — clicking a sidebar Career/Season/Tournament link re-navigates within this same
  // team with no state, so it's persisted to sessionStorage (keyed by player id) the first time
  // it's seen, and Back always targets it instead of `navigate(-1)` (mirrors CharacterPage).
  useEffect(() => {
    if (backToState && playerId) {
      sessionStorage.setItem(`${BACK_TO_STORAGE_PREFIX}${playerId}`, backToState)
    }
  }, [playerId, backToState])

  const handleBack = () => {
    const storedBackTo = playerId ? sessionStorage.getItem(`${BACK_TO_STORAGE_PREFIX}${playerId}`) : null
    if (storedBackTo) navigate(storedBackTo)
    else navigate(-1)
  }

  const scope = useMemo(() => {
    if (seasonId) return { type: 'season', id: seasonId }
    if (tournamentId) return { type: 'tournament', id: tournamentId }
    return { type: 'career' }
  }, [seasonId, tournamentId])
  const isCareer = scope.type === 'career'

  const {
    loading, player, identity, record, rosterCharacters, scopeOptions, transactions, gameLog,
    franchiseHistory, franchiseSummary, topPlayers, draftValue, draftValueSummary, tables, battingRawPas,
  } = useTeamProfileData(playerId, scope)

  if (!playerId) return null

  if (loading && !player) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <button type="button" onClick={handleBack} style={BACK_BUTTON_STYLE}>
          <ArrowLeft size={16} /> Back
        </button>
        <section className="panel" style={{ padding: 18 }}>
          <p className="muted" style={{ margin: 0 }}>Loading team…</p>
        </section>
      </div>
    )
  }

  const teamName = getTeamShortName(identity) || player?.name || 'Team'
  const gold = '#EAB308'
  const silver = '#C0C0C0'
  const bronze = '#CD7F32'

  // Career + one link per season/tournament this team has data in, same convention as
  // CharacterPage's sidebar — the Franchise History table on the career view also lists these,
  // but the sidebar needs its own copy so a season/tournament page can jump directly to another.
  const scopeLinks = [
    { to: `/teams/${playerId}/career`, label: 'Franchise Home' },
    ...scopeOptions.map((opt) => ({ to: `/teams/${playerId}/${opt.type}/${opt.id}`, label: opt.label })),
  ]
  const sectionLinks = [...BASE_SECTION_LINKS, ...(isCareer ? CAREER_SECTION_LINKS : [])]

  const activeScopeLabel = isCareer ? null : scopeOptions.find((opt) => opt.type === scope.type && String(opt.id) === String(scope.id))?.label
  const hasContactAuthorityData = Boolean(
    tables.powerCareerRow?.distanceProfile?.sampleSize ||
    tables.powerCareerRow?.exitVeloProfile?.sampleSize ||
    tables.powerCareerRow?.contactQuality?.sampleSize,
  ) || tables.powerRows.some((row) => (
    row.distanceProfile?.sampleSize ||
    row.exitVeloProfile?.sampleSize ||
    row.contactQuality?.sampleSize
  ))
  // Franchise History rows link to season/tournament team pages (via their own onClick below);
  // every other stat table now shows one row per character, so a row click there jumps to that
  // character's page instead.
  const characterRowClick = (row) => {
    if (!row?.linkTo) return
    navigate(row.linkTo, { state: { backTo: window.location.pathname + window.location.search } })
  }

  const franchiseColumns = [
    { key: 'label', label: 'Year', cellStyle: () => ({ color: '#94A3B8' }) },
    {
      key: 'teamName',
      label: 'Team',
      render: (row) => (
        <MiddleClickLink
          to={row.linkTo}
          state={{ backTo: window.location.pathname + window.location.search }}
          stopPropagation
          style={{ color: '#F8FAFC', fontWeight: 600, textDecoration: 'underline' }}
        >
          {row.teamName || '—'}
        </MiddleClickLink>
      ),
    },
    { key: 'wins', label: 'W', render: (row) => formatInteger(row.record?.wins) },
    { key: 'losses', label: 'L', render: (row) => formatInteger(row.record?.losses) },
    { key: 'runsFor', label: 'RS', render: (row) => formatInteger(row.record?.runsFor) },
    { key: 'runsAgainst', label: 'RA', render: (row) => formatInteger(row.record?.runsAgainst) },
    { key: 'runDiff', label: 'Diff', render: (row) => (Number.isFinite(row.record?.runDiff) ? (row.record.runDiff > 0 ? `+${row.record.runDiff}` : row.record.runDiff) : '-') },
    { key: 'result', label: 'Result', cellStyle: (row) => getFranchiseResultStyle(row, { gold, silver, bronze }) || undefined },
  ]

  const draftValueColumns = [
    { key: 'round', label: 'Rd', cellStyle: () => ({ color: '#94A3B8' }) },
    { key: 'pickNumber', label: 'Pick', defaultDirection: 1, cellStyle: () => ({ color: '#94A3B8' }) },
    {
      key: 'characterName',
      label: 'Player',
      render: (pick) => (pick.characterId != null ? (
        <MiddleClickLink
          to={`/character/${pick.characterId}/career`}
          state={{ backTo: window.location.pathname + window.location.search }}
          stopPropagation
          style={{ color: '#F8FAFC', fontWeight: 600, textDecoration: 'underline' }}
        >
          {pick.characterName || 'Unknown'}
        </MiddleClickLink>
      ) : (pick.characterName || 'Unknown')),
    },
    { key: 'actualValue', label: 'Actual Value', render: (pick) => formatDecimal(pick.actualValue, 1) },
    { key: 'expectedValue', label: 'Expected Value', render: (pick) => formatDecimal(pick.expectedValue, 1) },
    {
      key: 'surplus',
      label: 'Surplus',
      render: (pick) => formatSigned(pick.surplus),
      cellStyle: (pick) => ({ color: pick.surplus > 0 ? '#22C55E' : pick.surplus < 0 ? '#EF4444' : '#CBD5E1', fontWeight: 700 }),
    },
    { key: 'grade', label: 'Grade', cellStyle: (pick) => ({ color: GRADE_COLORS[pick.grade] || '#CBD5E1', fontWeight: 800 }) },
  ]

  const pitcherLink = (pitcher) => {
    if (!pitcher?.characterId) return pitcher?.name || '-'
    return (
      <MiddleClickLink
        to={`/character/${pitcher.characterId}/career`}
        state={{ backTo: window.location.pathname + window.location.search }}
        style={{ color: '#CBD5E1', fontWeight: 600, textDecoration: 'underline' }}
      >
        {pitcher.name}
      </MiddleClickLink>
    )
  }

  const gameLogColumns = [
    {
      key: 'opponentLabel',
      label: 'Opp',
      defaultDirection: 1,
      render: (g) => {
        const prefix = g.isHome ? 'vs' : 'at'
        const label = (
          <>
            <span className="opp-full">{prefix} {g.opponentLabel}</span>
            <span className="opp-abbr">{prefix} {g.opponentAbbr || g.opponentLabel}</span>
          </>
        )
        if (g.opponentPlayerId == null) return label
        const to = `/teams/${g.opponentPlayerId}/${scope.type}/${scope.id}`
        return (
          <MiddleClickLink
            to={to}
            state={{ backTo: window.location.pathname + window.location.search }}
            style={{ color: '#94A3B8', fontWeight: 600, textDecoration: 'underline' }}
          >
            {label}
          </MiddleClickLink>
        )
      },
    },
    {
      key: 'boxscore',
      label: 'Box',
      sortable: false,
      render: (g) => {
        if (g.gameId == null) return '-'
        const href = buildScorebookPath({ gameId: g.gameId, source: g.scorebookSource, view: 'game' })
        return (
          <a
            href={href}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              navigate(href)
            }}
            style={{ color: '#94A3B8', fontWeight: 600, textDecoration: 'underline' }}
          >
            Box
          </a>
        )
      },
    },
    { key: 'won', label: 'W/L', render: (g) => (g.won ? 'W' : 'L'), cellStyle: (g) => ({ color: g.won ? '#22C55E' : '#EF4444', fontWeight: 700 }) },
    { key: 'runsFor', label: 'R' },
    { key: 'runsAgainst', label: 'RA' },
    { key: 'winningPitcherName', label: 'Win', sortable: false, render: (g) => pitcherLink(g.winningPitcher) },
    { key: 'losingPitcherName', label: 'Loss', sortable: false, render: (g) => pitcherLink(g.losingPitcher) },
    { key: 'savePitcherName', label: 'Save', sortable: false, render: (g) => (g.savePitcher ? pitcherLink(g.savePitcher) : '-') },
    { key: 'stadium', label: 'Stadium', sortable: false, render: (g) => g.stadium || '-' },
    { key: 'record', label: 'Record', sortable: false },
    { key: 'streak', label: 'Streak', sortable: false },
  ]

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: 40 }}>
      <button type="button" onClick={handleBack} style={BACK_BUTTON_STYLE}>
        <ArrowLeft size={16} /> Back
      </button>

      {/* Header */}
      <section className="panel" style={{ padding: '1.25rem 1.4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
          <TeamLogo logoKey={identity?.teamLogoKey} logoUrl={identity?.teamLogoUrl} teamName={teamName} height={56} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{teamName}</h1>
            {isCareer && franchiseSummary ? (
              <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#64748B' }}>Owner: </span>
                  <span style={{ color: '#CBD5E1' }}>{player?.name || 'Unknown'}</span>
                </div>
                {franchiseSummary.teamNames.length > 0 && (
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Team Names: </span>
                    <span style={{ color: '#CBD5E1' }}>{franchiseSummary.teamNames.join(', ')}</span>
                  </div>
                )}
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#64748B' }}>Seasons: </span>
                  <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{formatInteger(franchiseSummary.seasonsPlayed)}</span>
                  <span style={{ color: '#64748B' }}> · Tournaments: </span>
                  <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{formatInteger(franchiseSummary.tournamentsPlayed)}</span>
                </div>
                {record && (
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Record: </span>
                    <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{formatInteger(record.wins)}-{formatInteger(record.losses)}</span>
                    <span style={{ color: '#64748B' }}> ({formatWinPct(record.wins, record.losses)}) · RS {formatInteger(record.runsFor)} · RA {formatInteger(record.runsAgainst)} · Diff </span>
                    <span style={{ color: record.runDiff > 0 ? '#22C55E' : record.runDiff < 0 ? '#EF4444' : '#CBD5E1', fontWeight: 700 }}>
                      {Number.isFinite(record.runDiff) ? (record.runDiff > 0 ? `+${record.runDiff}` : record.runDiff) : '-'}
                    </span>
                  </div>
                )}
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#64748B' }}>Championships: </span>
                  <span style={{ color: gold, fontWeight: 700 }}>{formatInteger(franchiseSummary.championships)}</span>
                  <span style={{ color: '#64748B' }}> · Tournaments Won: </span>
                  <span style={{ color: gold, fontWeight: 700 }}>{formatInteger(franchiseSummary.tournamentsWon)}</span>
                </div>
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#64748B' }}>Winningest Player: </span>
                  {franchiseSummary.winningestPlayer ? (
                    franchiseSummary.winningestPlayer.characterId != null ? (
                      <MiddleClickLink
                        to={`/character/${franchiseSummary.winningestPlayer.characterId}/career`}
                        state={{ backTo: window.location.pathname + window.location.search }}
                        style={{ color: '#F8FAFC', fontWeight: 700, textDecoration: 'underline' }}
                      >
                        {franchiseSummary.winningestPlayer.name}
                      </MiddleClickLink>
                    ) : (
                      <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{franchiseSummary.winningestPlayer.name}</span>
                    )
                  ) : (
                    <span style={{ color: '#F8FAFC', fontWeight: 700 }}>-</span>
                  )}
                  {franchiseSummary.winningestPlayer && (
                    <span style={{ color: '#F8FAFC', fontWeight: 700 }}>
                      {' '}{franchiseSummary.winningestPlayer.wins}-{franchiseSummary.winningestPlayer.losses}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{ color: '#94A3B8', fontSize: 13 }}>Owner: {player?.name || 'Unknown'}</span>
                {activeScopeLabel && <span style={{ color: '#64748B', fontSize: 12, fontWeight: 700 }}>Viewing: {activeScopeLabel}</span>}
                {record && (
                  <span style={{ color: '#CBD5E1', fontSize: 13, fontWeight: 700 }}>
                    {formatInteger(record.wins)}-{formatInteger(record.losses)}
                    <span style={{ color: '#64748B', fontWeight: 500 }}>
                      {' '}· RS {formatInteger(record.runsFor)} · RA {formatInteger(record.runsAgainst)} · Diff{' '}
                    </span>
                    <span style={{ color: record.runDiff > 0 ? '#22C55E' : record.runDiff < 0 ? '#EF4444' : '#CBD5E1' }}>
                      {Number.isFinite(record.runDiff) ? (record.runDiff > 0 ? `+${record.runDiff}` : record.runDiff) : '-'}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate(scope.type === 'season' ? '/season/roster' : '/roster')}
          style={{ ...BACK_BUTTON_STYLE, justifySelf: 'end' }}
        >
          Manage Roster
        </button>
      </section>

      <div className="entity-page-shell">
        <EntityPageSidebar title={teamName} scopeLinks={scopeLinks} sectionLinks={sectionLinks} />

        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {/* Roster */}
          <Section id="roster" title="Roster">
            {rosterCharacters.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No roster data available</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {rosterCharacters.map((character) => (
                  <MiddleClickLink
                    key={character.id}
                    to={`/character/${character.id}/career`}
                    state={{ backTo: window.location.pathname + window.location.search }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '0.3rem 0.6rem 0.3rem 0.3rem',
                      border: '1px solid rgba(255,255,255,0.08)', borderRadius: 999, background: 'rgba(255,255,255,0.03)',
                      color: '#F8FAFC', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                    }}
                  >
                    <CharacterPortrait name={character.name} size={22} />
                    {character.name}
                  </MiddleClickLink>
                ))}
              </div>
            )}
          </Section>

          {/* Franchise History (career only) */}
          {isCareer && (
            <Section id="franchise" title="Franchise History">
              {franchiseHistory.length === 0 ? (
                <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No season or tournament history yet</p>
              ) : (
                <SortableTable columns={franchiseColumns} rows={franchiseHistory} rowKey={(row) => `${row.type}-${row.id}`} />
              )}
            </Section>
          )}

          {/* All-Time Top Players (career only) */}
          {isCareer && (
            <Section id="top-players" title="All-Time Top Players">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                <div>
                  <div style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Top Batters</div>
                  {!topPlayers?.topBatters?.length ? (
                    <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No batting data available</p>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {topPlayers.topBatters.map((p) => (
                        <MiddleClickLink
                          key={p.characterId}
                          to={`/character/${p.characterId}/career`}
                          state={{ backTo: window.location.pathname + window.location.search }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0.4rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, background: 'rgba(255,255,255,0.03)', width: '100%', textDecoration: 'none' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CharacterPortrait name={p.name} size={22} />
                            <span style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                          </span>
                          <span style={{ color: gold, fontSize: 13, fontWeight: 700 }}>{formatDecimal(p.ops)} OPS</span>
                        </MiddleClickLink>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Top Pitchers</div>
                  {!topPlayers?.topPitchers?.length ? (
                    <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No pitching data available</p>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {topPlayers.topPitchers.map((p) => (
                        <MiddleClickLink
                          key={p.characterId}
                          to={`/character/${p.characterId}/career`}
                          state={{ backTo: window.location.pathname + window.location.search }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0.4rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, background: 'rgba(255,255,255,0.03)', width: '100%', textDecoration: 'none' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CharacterPortrait name={p.name} size={22} />
                            <span style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                          </span>
                          <span style={{ color: gold, fontSize: 13, fontWeight: 700 }}>{formatDecimal(p.era, 2)} ERA</span>
                        </MiddleClickLink>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* Standard Stats — one row per character who played this scope, + a Team Total row */}
          <Section id="stats" title="Standard Stats">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle
                value={standardStatsView}
                onChange={setStandardStatsView}
                options={[
                  { key: 'batting', label: 'Batting' },
                  { key: 'pitching', label: 'Pitching' },
                  { key: 'fielding', label: 'Fielding' },
                ]}
              />
              {standardStatsView === 'batting'
                ? (tables.hasBatting
                  ? <StatTable columns={BATTING_COLUMNS} rows={tables.standardBattingRows} careerRow={tables.standardBattingCareerRow} onRowClick={characterRowClick} />
                  : noData)
                : standardStatsView === 'pitching'
                  ? (tables.hasPitching
                    ? <StatTable columns={PITCHING_COLUMNS} rows={tables.standardPitchingRows} careerRow={tables.standardPitchingCareerRow} onRowClick={characterRowClick} />
                    : noData)
                  : (tables.hasFielding
                    ? <StatTable columns={FIELDING_COLUMNS} rows={tables.standardFieldingRows} careerRow={tables.standardFieldingCareerRow} onRowClick={characterRowClick} />
                    : noData)}
            </div>
          </Section>

          {/* Advanced Stats */}
          <Section id="advanced-stats" title="Advanced Stats">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle value={advancedStatsView} onChange={setAdvancedStatsView} />
              {advancedStatsView === 'batting'
                ? (tables.hasBatting
                  ? <StatTable columns={ADVANCED_BATTING_COLUMNS} rows={tables.advancedBattingRows} careerRow={tables.advancedBattingCareerRow} onRowClick={characterRowClick} />
                  : noData)
                : (tables.hasPitching
                  ? <StatTable columns={ADVANCED_PITCHING_COLUMNS} rows={tables.advancedPitchingRows} careerRow={tables.advancedPitchingCareerRow} onRowClick={characterRowClick} />
                  : noData)}
            </div>
          </Section>

          {/* Stars Used */}
          <Section id="stars-used" title="Stars Used" subtitle="This team's own Star Hit and Star Pitch usage — Batting shows batters using Star Hit, Pitching shows pitchers using Star Pitch.">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle
                value={starsUsedView}
                onChange={setStarsUsedView}
                options={[
                  { key: 'batting', label: 'Star Hit (Batting)' },
                  { key: 'pitching', label: 'Star Pitch (Pitching)' },
                ]}
              />
              {starsUsedView === 'batting'
                ? (tables.hasBatting
                  ? <StatTable columns={STAR_HIT_COLUMNS} rows={tables.starHitRows} careerRow={tables.starHitCareerRow} onRowClick={characterRowClick} />
                  : noData)
                : (tables.hasPitching
                  ? <StatTable columns={STAR_PITCH_COLUMNS} rows={tables.starPitchRows} careerRow={tables.starPitchCareerRow} onRowClick={characterRowClick} />
                  : noData)}
            </div>
          </Section>

          {/* Stars Against — opposing star ability used against this team */}
          <Section id="stars-against" title="Stars Against" subtitle="Opponents' Star Hit and Star Pitch usage against this team — 'vs Star Pitch' shows how this team's batters fared when an opposing pitcher used Star Pitch, 'vs Star Hit' shows how this team's pitchers fared when an opposing batter used Star Hit.">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle
                value={starsAgainstView}
                onChange={setStarsAgainstView}
                options={[
                  { key: 'batting', label: 'vs Star Pitch (Batting)' },
                  { key: 'pitching', label: 'vs Star Hit (Pitching)' },
                ]}
              />
              {starsAgainstView === 'batting'
                ? (tables.hasBatting
                  ? <StatTable columns={STAR_PITCH_COLUMNS} rows={tables.starPitchAgainstRows} careerRow={tables.starPitchAgainstCareerRow} onRowClick={characterRowClick} />
                  : noData)
                : (tables.hasPitching
                  ? <StatTable columns={STAR_HIT_COLUMNS} rows={tables.starHitAgainstRows} careerRow={tables.starHitAgainstCareerRow} onRowClick={characterRowClick} />
                  : noData)}
            </div>
          </Section>

          {/* Batted Ball */}
          <Section id="batted-ball" title="Batted Ball">
            {tables.hasBatting
              ? <StatTable columns={BATTED_BALL_COLUMNS} rows={tables.battedBallRows} careerRow={tables.battedBallCareerRow} onRowClick={characterRowClick} />
              : noData}
          </Section>

          {/* Batted Ball Allowed */}
          <Section id="batted-ball-allowed" title="Batted Ball Allowed">
            {tables.hasPitching
              ? <StatTable columns={BATTED_BALL_ALLOWED_COLUMNS} rows={tables.battedBallAllowedRows} careerRow={tables.battedBallAllowedCareerRow} onRowClick={characterRowClick} />
              : noData}
          </Section>

          <Section id="power" title="Contact Authority">
            {hasContactAuthorityData
              ? <StatTable columns={CONTACT_AUTHORITY_COLUMNS} rows={tables.powerRows} careerRow={tables.powerCareerRow} onRowClick={characterRowClick} />
              : noData}
          </Section>

          {/* Spray Chart */}
          <Section id="spray-chart" title="Spray Chart">
            {tables.hasBatting
              ? <SprayChart plateAppearances={battingRawPas} height={320} showCharacterName />
              : noData}
          </Section>

          {/* Expected Stats */}
          <Section id="xstats" title="Expected Stats">
            {tables.expectedRows.every((r) => !r.sampleSize) ? noData : (
              <div style={{ display: 'grid', gap: 12 }}>
                <StatTable columns={EXPECTED_COLUMNS} rows={tables.expectedRows} careerRow={tables.expectedCareerRow} onRowClick={characterRowClick} />
                <p style={{ color: '#64748B', fontSize: 12, margin: 0 }}>
                  xBA/xSLG/xwOBA are modeled from tracked exit velocity/launch angle, compared against similar contact league-wide.
                </p>
              </div>
            )}
          </Section>

          {/* Splits */}
          <Section id="splits" title="Splits">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle value={splitsView} onChange={setSplitsView} />
              {splitsView === 'batting'
                ? (tables.hasBatting ? <StatTable columns={SPLITS_COLUMNS} rows={tables.battingSplitRows} /> : noData)
                : (tables.hasPitching ? <StatTable columns={SPLITS_COLUMNS} rows={tables.pitchingSplitRows} /> : noData)}
            </div>
          </Section>

          {/* Park Factors */}
          <Section id="park-factors" title="Park Factors" subtitle="How each stadium this team has played at affects outcomes relative to the league average (1.00 = neutral, >1.00 favors that outcome). These numbers describe the stadium, not this team specifically.">
            {tables.parkFactorRows.length === 0
              ? noData
              : <StatTable columns={PARK_FACTOR_COLUMNS} rows={tables.parkFactorRows} />}
          </Section>

          {/* Draft Value */}
          <Section id="draft-value" title="Draft Value">
            {draftValue.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>
                No draft picks with round/pick data for this scope yet
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {draftValueSummary && (
                  <div style={{ maxWidth: 360 }}>
                    <PercentileBar
                      label={`Overall Draft Grade (${draftValueSummary.grade})`}
                      value={formatSigned(draftValueSummary.averageSurplus)}
                      percentile={Math.round(draftValueSummary.percentile * 100)}
                    />
                  </div>
                )}
                <SortableTable
                  columns={draftValueColumns}
                  rows={[...draftValue].sort((a, b) => a.pickNumber - b.pickNumber)}
                  rowKey={(pick) => `${pick.source}-${pick.contextId}-${pick.pickNumber}`}
                />
              </div>
            )}
          </Section>

          {/* Game Log */}
          <Section id="gamelog" title="Game Log">
            {isCareer ? (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>
                Select a season or tournament from the sidebar to see its game-by-game log.
              </p>
            ) : gameLog.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No completed games recorded</p>
            ) : (
              <SortableTable columns={gameLogColumns} rows={gameLog} rowKey={(g) => g.gameNumber} />
            )}
          </Section>

          {/* Transactions */}
          <Section id="transactions" title="Transactions">
            {transactions.length === 0 ? (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No transactions recorded</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {transactions.map((tx, i) => {
                  const dateLabel = tx.date ? new Date(tx.date).toLocaleDateString() : ''
                  let description = ''
                  const charLabel = tx.characterName || (tx.characterId ? `#${tx.characterId}` : 'A character')
                  if (tx.type === 'draft') description = `Drafted ${charLabel}${tx.round ? ` (Round ${tx.round}, Pick ${tx.pickNumber})` : ''}${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
                  else if (tx.type === 'season_draft') description = `Drafted ${charLabel}${tx.round ? ` (Round ${tx.round}, Pick ${tx.pickNumber})` : ''}${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
                  else if (tx.type === 'trade') description = String(tx.fromPlayerId) === String(playerId) ? `Traded away ${charLabel}` : `Acquired ${charLabel} via trade`
                  else if (tx.type === 'waiver') description = `Won ${charLabel} off waivers`
                  else if (tx.type === 'free_agent_add') description = `Signed ${charLabel} as a free agent${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '0.5rem 0.7rem', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <span style={{ fontSize: 13, color: '#F8FAFC' }}>{description}</span>
                      <span style={{ fontSize: 11, color: '#64748B', flexShrink: 0 }}>{dateLabel}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
