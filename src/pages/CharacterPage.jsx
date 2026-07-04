import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { supabase } from '../supabaseClient'
import {
  buildCharacterIntrinsics,
  hasPitchingStatLine,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizePitchMix,
  summarizePitching,
  summarizePlateDiscipline,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
} from '../utils/statsCalculator'
import { analyzeCharacterTalent, getTalentTierMeta } from '../utils/characterAnalysis'
import { calculateHitPowerIndex, summarizeHitDistance, wouldBeHrElsewhere } from '../utils/hitDistanceStats'
import { summarizeExpectedBatting } from '../utils/expectedStats'
import useCharacterProfileData from '../hooks/useCharacterProfileData'
import useCharacterExtras from '../hooks/useCharacterExtras'
import { SNAPSHOT_METRICS, buildTalentPercentiles, buildPerformancePercentiles } from '../utils/percentileSnapshot'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import PlayerTag from '../components/PlayerTag'
import SprayChart from '../components/SprayChart'
import RollingStatChart from '../components/RollingStatChart'
import { chemBreakdown, getChemistry, isChemistryNameOnRoster } from '../data/chemistry'
import { getTeamShortName } from '../utils/teamIdentity'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}
function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : '-'
}
function formatSignedInt(value) {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value}`
}

// ─── Style helpers ────────────────────────────────────────────────────────────

function getTierBadgeStyle(tier) {
  const map = {
    S: { bg: 'rgba(125,211,252,0.15)', border: 'rgba(125,211,252,0.4)', color: '#7DD3FC' },
    A: { bg: 'rgba(74,222,128,0.15)', border: 'rgba(74,222,128,0.4)', color: '#4ADE80' },
    B: { bg: 'rgba(234,179,8,0.15)', border: 'rgba(234,179,8,0.4)', color: '#EAB308' },
    C: { bg: 'rgba(249,115,22,0.15)', border: 'rgba(249,115,22,0.4)', color: '#F97316' },
    D: { bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.4)', color: '#EF4444' },
    F: { bg: 'rgba(239,68,68,0.2)', border: 'rgba(239,68,68,0.5)', color: '#EF4444' },
  }
  return map[tier] || map.C
}

function getCharacterClassAccent(characterClass) {
  switch (characterClass) {
    case 'Power': return { color: '#FCA5A5', border: 'rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.16)' }
    case 'Speed': return { color: '#86EFAC', border: 'rgba(34,197,94,0.45)', background: 'rgba(34,197,94,0.16)' }
    case 'Technique': return { color: '#D8B4FE', border: 'rgba(168,85,247,0.45)', background: 'rgba(168,85,247,0.16)' }
    default: return { color: '#FDE68A', border: 'rgba(234,179,8,0.45)', background: 'rgba(234,179,8,0.16)' }
  }
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
function lerpColor(c1, c2, t) {
  const [r1, g1, b1] = hexToRgb(c1)
  const [r2, g2, b2] = hexToRgb(c2)
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`
}
function getBarColor(pct) {
  const stops = ['#EF4444', '#EAB308', '#22C55E']
  const scaled = Math.max(0, Math.min(1, pct)) * (stops.length - 1)
  const lo = Math.floor(scaled)
  const hi = Math.min(stops.length - 1, lo + 1)
  return lerpColor(stops[lo], stops[hi], scaled - lo)
}
function isPitchingAllZero(p) {
  return !hasPitchingStatLine(p)
}
function getHistoryEntryId(entry = {}) {
  return String(entry.sourceId ?? entry.eventKey ?? entry.tournamentId ?? '')
}
function getHistoryEntryLabel(entry = {}) {
  if (entry.sourceLabel) return entry.sourceLabel
  if (entry.eventType === 'tournament') return `Tournament ${entry.eventNumber}`
  if (entry.eventType === 'season') return String(entry.eventNumber)
  return entry.tournamentNumber ? `Tournament ${entry.tournamentNumber}` : 'Unknown'
}
function sortHistoryEntries(a, b) {
  if ((a.sortGroup || 0) !== (b.sortGroup || 0)) return (a.sortGroup || 0) - (b.sortGroup || 0)
  return (b.sortValue || 0) - (a.sortValue || 0)
}
function allZeroPct(...rates) {
  return rates.every((r) => !r || r === 0)
}

// The population max/min (computed once, roster/game-wide) and a character's own displayed value
// can come from slightly different history scopes (see useCharacterExtras vs useCharacterProfileData),
// so a character who genuinely IS the league's best can still land a hair above the computed max.
// Floor the scale to the character's own value so their bar can always reach 100% when they're it.
function floorMax(populationMax, value, fallback = 100) {
  const base = Number.isFinite(populationMax) ? populationMax : fallback
  return Number.isFinite(value) ? Math.max(base, value) : base
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

// Fixed dark-green → dark-red gradient across the full 0-100 scale (not the current value) —
// the fill div is only as wide as the value's percentile, but the gradient inside it is scaled
// up to the full track width so a low value only reveals the green end, a high value reveals
// the whole green-to-red run.
const SCORE_BAR_GRADIENT = 'linear-gradient(to right, #14532d, #84cc16, #eab308, #f97316, #7f1d1d)'

function ScoreBar({ label, value, min = 0, max = 100, median = 50 }) {
  const numericValue = Number(value)
  const range = max - min
  const normalize = (rawValue) => {
    const parsed = Number(rawValue)
    if (!Number.isFinite(parsed) || !Number.isFinite(range) || range <= 0) return 0
    return Math.max(0, Math.min(1, (parsed - min) / range))
  }
  const pct = normalize(numericValue)
  const markerPct = (markerValue) => `${(normalize(markerValue) * 100).toFixed(1)}%`
  const markers = [
    { key: 'min', left: markerPct(min), align: 'start' },
    { key: 'median', left: markerPct(median), align: 'center' },
    { key: 'max', left: markerPct(max), align: 'end' },
  ]
  const markerTransform = (align) => {
    if (align === 'start') return 'translateX(0)'
    if (align === 'end') return 'translateX(-100%)'
    return 'translateX(-50%)'
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: '#CBD5E1', fontWeight: 600 }}>{label}</span>
        <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ position: 'relative', height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{
          width: `${pct * 100}%`, height: '100%', borderRadius: 999, position: 'absolute', top: 0, left: 0,
          backgroundImage: SCORE_BAR_GRADIENT,
          backgroundSize: pct > 0 ? `${100 / pct}% 100%` : '100% 100%',
        }} />
        {markers.map((marker) => (
          <div key={marker.key} style={{ position: 'absolute', left: marker.left, top: -1.5, width: 2, height: 8, background: 'rgba(255,255,255,0.5)', borderRadius: 2, transform: markerTransform(marker.align) }} />
        ))}
      </div>
    </div>
  )
}

function MetricList({ items = [] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '7px 16px' }}>
      {items.map(({ key, label, value, min = 0, median, max = 100, digits = 0 }) => (
        <ScoreBar key={key} label={label} value={Number.isFinite(value) ? Number(value).toFixed(digits) : '-'} min={min} max={max} median={median} />
      ))}
    </div>
  )
}

function SkillSectionCard({ title, score, scoreMin = 0, scoreMedian, scoreMax = 100, items }) {
  return (
    <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', padding: '0.7rem 0.8rem', display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gap: 5 }}>
        <div style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</div>
        <ScoreBar label={`${title} Score`} value={Math.round(score)} min={scoreMin} median={scoreMedian ?? 50} max={scoreMax} />
      </div>
      <MetricList items={items} />
    </div>
  )
}

function SmallChip({ label, value, accent = '#F8FAFC' }) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '0.38rem 0.6rem', background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ color: accent, fontSize: 15, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function BattedBallBar({ ldRate, gbRate, fbRate }) {
  const ld = (ldRate || 0) * 100
  const gb = (gbRate || 0) * 100
  const fb = (fbRate || 0) * 100
  const sum = ld + gb + fb || 100
  const segments = [
    { pct: (ld / sum) * 100, color: '#22C55E', label: `LD ${ld.toFixed(0)}%` },
    { pct: (gb / sum) * 100, color: '#3B82F6', label: `GB ${gb.toFixed(0)}%` },
    { pct: (fb / sum) * 100, color: '#EAB308', label: `FB ${fb.toFixed(0)}%` },
  ]
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden' }}>
        {segments.map(({ pct, color }, i) => <div key={i} style={{ width: `${pct}%`, background: color }} />)}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {segments.map(({ color, label }) => (
          <span key={label} style={{ fontSize: 11, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function PercentileChip({ label, value, percentile, digits = 0, suffix = '' }) {
  const pct = Number.isFinite(percentile) ? percentile : null
  const color = pct == null ? '#475569' : getBarColor(pct / 100)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 74 }}>
      <div style={{
        width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `3px solid ${color}`, color: '#F8FAFC', fontWeight: 800, fontSize: 14,
      }}>
        {pct == null ? '-' : pct}
      </div>
      <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', textAlign: 'center' }}>{label}</span>
      <span style={{ fontSize: 11, color: '#64748B' }}>{Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : '-'}</span>
    </div>
  )
}

function YearByYearTable({ columns, rows, careerRow }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: 560 }}>
        <thead>
          <tr>{columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.eventKey || i} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
              {columns.map((col) => <td key={col.key}>{col.render ? col.render(row) : row[col.key]}</td>)}
            </tr>
          ))}
          {careerRow && (
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
              {columns.map((col, i) => (
                <td key={col.key} style={i === 0 ? { color: '#94A3B8', fontWeight: 700 } : undefined}>
                  {i === 0 ? 'Career' : (col.render ? col.render(careerRow) : careerRow[col.key])}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function Section({ id, title, children }) {
  return (
    <section id={id} className="panel" style={{ padding: '1.25rem 1.4rem', scrollMarginTop: 72 }}>
      <SectionHeader>{title}</SectionHeader>
      {children}
    </section>
  )
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'stats', label: 'Stats' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'xstats', label: 'Expected Stats' },
  { id: 'fielding', label: 'Fielding' },
  { id: 'chart', label: 'Trends' },
  { id: 'awards', label: 'Awards' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'chemistry', label: 'Chemistry' },
  { id: 'gamelog', label: 'Gamelog' },
]

const dropStyle = { background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '4px 8px', fontSize: 12, cursor: 'pointer' }

const BACK_BUTTON_STYLE = {
  justifySelf: 'start', display: 'flex', alignItems: 'center', gap: 6,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8,
  color: '#CBD5E1', padding: '0.4rem 0.75rem', fontSize: 13, fontWeight: 600, cursor: 'pointer',
}

// ─── Fallback meta fetch (direct URL load / refresh — no router state) ───────

function useCharacterMetaFallback(characterId, hasPreset) {
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    if (hasPreset || !characterId) return undefined
    let cancelled = false

    async function load() {
      const [{ data: charactersData }, { data: playersData }, { data: draftPicksData }] = await Promise.all([
        supabase.from('characters').select('*').order('name'),
        supabase.from('players').select('*'),
        supabase.from('draft_picks').select('*'),
      ])
      if (cancelled) return

      const characters = charactersData || []
      const allCharactersById = Object.fromEntries(characters.map((c) => [c.name, c]))
      const character = characters.find((c) => String(c.id) === String(characterId)) || null
      const playersById = Object.fromEntries((playersData || []).map((p) => [p.id, p]))
      const picksForCharacter = (draftPicksData || []).filter((p) => String(p.character_id) === String(characterId) && p.player_id)
      const pick = picksForCharacter[picksForCharacter.length - 1] || null
      const currentOwner = pick ? { player_id: pick.player_id } : null
      const charactersById = Object.fromEntries(characters.map((c) => [c.id, c]))
      const rosterNames = pick
        ? (draftPicksData || [])
          .filter((p) => p.player_id === pick.player_id
            && (pick.tournament_id ? p.tournament_id === pick.tournament_id : p.season_id === pick.season_id))
          .map((p) => charactersById[p.character_id]?.name)
          .filter(Boolean)
        : []

      if (!cancelled) {
        setMeta({ character, allCharactersById, playersById, identitiesByPlayerId: {}, currentOwner, rosterNames, currentContext: null })
      }
    }

    load()
    return () => { cancelled = true }
  }, [characterId, hasPreset])

  return meta
}

export default function CharacterPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const presetState = location.state || null
  const hasPreset = Boolean(presetState?.character)

  const fallbackMeta = useCharacterMetaFallback(id, hasPreset)
  const meta = hasPreset ? presetState : fallbackMeta

  const character = meta?.character || null
  const allCharactersById = meta?.allCharactersById || {}
  const playersById = meta?.playersById || {}
  const identitiesByPlayerId = meta?.identitiesByPlayerId || {}
  const currentOwner = meta?.currentOwner || null
  const currentContext = meta?.currentContext || null
  const totalDrafts = meta?.totalDrafts || 0
  const tournamentsDrafted = meta?.tournamentsDrafted || 0
  const championshipsWon = meta?.championshipsWon || 0
  const characterIntrinsics = meta?.characterIntrinsics || null
  const rosterNames = meta?.rosterNames || []

  const profileData = useCharacterProfileData(character, currentContext, presetState?.profileData || {})
  const extras = useCharacterExtras(character)
  const {
    leaguePerformanceByCharacterId, fieldingHistory, allTimeFielding, transactions, awardRows,
    statMedians, statMaxes, statMins,
  } = extras

  const [selectedSourceId, setSelectedSourceId] = useState('current')
  const [gamelogStatType, setGamelogStatType] = useState('batting')
  const [statsStatType, setStatsStatType] = useState('batting')
  const [advancedSection, setAdvancedSection] = useState('starHit')

  const {
    currentTournamentBatting, currentTournamentPitching, allTimeBatting, allTimePitching,
    allPitches, battingHistory, pitchingHistory, gameHistory, pitchingGameHistory,
    fieldingGameHistory, expectedOutcomeModel,
  } = profileData

  const talentPercentiles = useMemo(
    () => (character ? buildTalentPercentiles(character, extras.analysesByCharacterId) : {}),
    [character, extras.analysesByCharacterId],
  )
  const performancePercentiles = useMemo(
    () => (character ? buildPerformancePercentiles(character, leaguePerformanceByCharacterId) : {}),
    [character, leaguePerformanceByCharacterId],
  )
  const snapshotPercentiles = { ...talentPercentiles, ...performancePercentiles }

  if (!id) return null

  if (!character) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <button type="button" onClick={() => navigate(-1)} style={BACK_BUTTON_STYLE}>
          <ArrowLeft size={16} /> Back
        </button>
        <section className="panel" style={{ padding: 18 }}>
          <p className="muted" style={{ margin: 0 }}>Loading character…</p>
        </section>
      </div>
    )
  }

  const chemistry = getChemistry(character.name)
  const batterPitches = allPitches.filter((p) => p.batter_id === character.name)
  const pitcherPitches = allPitches.filter((p) => p.pitcher_id === character.name)
  const countGames = (entries = []) => new Set(entries.map((entry) => String(entry.game_id ?? ''))).size

  const sourceMap = {}
  battingHistory.filter((e) => e.rawPas?.length > 0).forEach((e) => {
    const entryId = getHistoryEntryId(e)
    const games = countGames(e.rawPas)
    sourceMap[entryId] = { label: getHistoryEntryLabel(e), games: Math.max(sourceMap[entryId]?.games || 0, games), sortGroup: e.sortGroup || 0, sortValue: e.sortValue || 0 }
  })
  pitchingHistory.filter((e) => (e.innings || 0) > 0).forEach((e) => {
    const entryId = getHistoryEntryId(e)
    const games = Number(e.games || 0)
    sourceMap[entryId] = { label: getHistoryEntryLabel(e), games: Math.max(sourceMap[entryId]?.games || 0, games), sortGroup: e.sortGroup || 0, sortValue: e.sortValue || 0 }
  })
  const sourceOptions = Object.entries(sourceMap)
    .map(([entryId, meta2]) => ({ id: entryId, ...meta2 }))
    .sort(sortHistoryEntries)
    .map(({ id: entryId, label, games }) => ({ id: entryId, label: `${label} (${games} G)` }))

  let showBatting = currentTournamentBatting
  let showPitching = currentTournamentPitching
  if (selectedSourceId === 'alltime') {
    showBatting = allTimeBatting
    showPitching = allTimePitching
  } else if (selectedSourceId !== 'current' && selectedSourceId) {
    const battingEntry = battingHistory.find((e) => getHistoryEntryId(e) === selectedSourceId)
    if (battingEntry?.rawPas) {
      const computed = summarizeBatting(battingEntry.rawPas)
      computed.ops = computed.obp + computed.slg
      showBatting = { ...computed, rawPas: battingEntry.rawPas }
    } else {
      showBatting = { rawPas: [] }
    }
    const pitchingEntry = pitchingHistory.find((e) => getHistoryEntryId(e) === selectedSourceId)
    showPitching = pitchingEntry || { rawPas: [], rawStints: [] }
  }

  const starHitStats = summarizeStarHits(showBatting.rawPas || [])
  const battingBattedBall = summarizeBattedBallProfile(showBatting.rawPas || [])
  const battingSpray = summarizeSprayProfile(showBatting.rawPas || [])
  const battingDiscipline = summarizePlateDiscipline(showBatting.rawPas || [], batterPitches)
  const pitchingStar = summarizeStarPitching(showPitching.rawPas || [], pitcherPitches)
  const pitchingMix = summarizePitchMix(showPitching.rawPas || [], pitcherPitches)
  const pitchingBattedBall = summarizeBattedBallProfile(showPitching.rawPas || [])
  const pitchingSpray = summarizeSprayProfile(showPitching.rawPas || [])
  const battingDistance = summarizeHitDistance(showBatting.rawPas || [])
  const hitPowerIndex = calculateHitPowerIndex(battingDistance)
  const expectedBatting = summarizeExpectedBatting(showBatting.rawPas || [], expectedOutcomeModel)

  const characterErrors = 0
  // Prefer the all-time analysis useCharacterExtras already computed for every character (same
  // source the population max/median/percentiles below are drawn from) — using a different,
  // sometimes context-scoped analysis here would let a character be "100th percentile" per the
  // population stats while still not visually filling their own bar. Falls back to the
  // context-scoped computation only until extras finishes loading.
  const talentAnalysis = extras.analysesByCharacterId[character.id]
    || analyzeCharacterTalent(character, gameHistory ?? battingHistory, pitchingGameHistory, fieldingGameHistory)
  const effectiveIntrinsics = characterIntrinsics || talentAnalysis?.intrinsics || buildCharacterIntrinsics(character)
  const classAccent = getCharacterClassAccent(effectiveIntrinsics?.characterClass)
  const chemistrySummary = chemBreakdown(character.name, rosterNames)
  const tierMeta = getTalentTierMeta(talentAnalysis?.tier)
  const tierBadgeStyle = getTierBadgeStyle(talentAnalysis?.tier)

  const pitchingRating = character.pitchingRating ?? character.pitching ?? '-'
  const battingRating = character.battingRating ?? character.batting ?? '-'
  const fieldingRating = character.fieldingRating ?? character.fielding ?? '-'
  const speedRating = character.speedRating ?? character.speed ?? '-'

  const renderSourceSelector = () => (
    <select value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)} style={dropStyle}>
      <option value="current">Current</option>
      {sourceOptions.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
      <option value="alltime">All-Time</option>
    </select>
  )

  const teamLabel = (playerId) => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || 'Unknown'

  // ─── Year-by-year Standard Batting/Pitching tables ─────────────────────────
  const battingTableRows = battingHistory
    .map((entry) => {
      const computed = summarizeBatting(entry.rawPas || [])
      computed.ops = computed.obp + computed.slg
      return { eventKey: entry.eventKey, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue, ...computed }
    })
    .sort(sortHistoryEntries)
  const battingCareerRow = { label: 'Career', ...allTimeBatting }

  const pitchingTableRows = pitchingHistory
    .filter((entry) => (entry.innings || 0) > 0)
    .map((entry) => ({ ...entry, label: getHistoryEntryLabel(entry) }))
    .sort(sortHistoryEntries)
  const pitchingCareerRow = { label: 'Career', ...allTimePitching }

  const battingColumns = [
    { key: 'label', label: 'Season' },
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
    { key: 'avg', label: 'AVG', render: (r) => formatDecimal(r.avg) },
    { key: 'obp', label: 'OBP', render: (r) => formatDecimal(r.obp) },
    { key: 'slg', label: 'SLG', render: (r) => formatDecimal(r.slg) },
    { key: 'ops', label: 'OPS', render: (r) => formatDecimal(r.ops) },
  ]
  const pitchingColumns = [
    { key: 'label', label: 'Season' },
    { key: 'games', label: 'G' },
    { key: 'innings', label: 'IP', render: (r) => formatDecimal(r.innings, 1) },
    { key: 'wins', label: 'W' },
    { key: 'losses', label: 'L' },
    { key: 'saves', label: 'SV' },
    { key: 'strikeouts', label: 'K' },
    { key: 'hitsAllowed', label: 'H' },
    { key: 'runsAllowed', label: 'R' },
    { key: 'earnedRuns', label: 'ER' },
    { key: 'walks', label: 'BB' },
    { key: 'homeRunsAllowed', label: 'HR' },
    { key: 'era', label: 'ERA/3', render: (r) => formatDecimal(r.era, 2) },
    { key: 'whip', label: 'WHIP', render: (r) => formatDecimal(r.whip, 2) },
  ]

  // ─── Fielding table ─────────────────────────────────────────────────────────
  const fieldingTableRows = fieldingHistory.map((entry) => ({ ...entry, label: getHistoryEntryLabel(entry) })).sort(sortHistoryEntries)
  const fieldingCareerRow = allTimeFielding ? { label: 'Career', games: fieldingTableRows.reduce((sum, r) => sum + (r.games || 0), 0), ...allTimeFielding } : null
  const fieldingColumns = [
    { key: 'label', label: 'Season' },
    { key: 'games', label: 'G' },
    { key: 'chances', label: 'TC' },
    { key: 'putouts', label: 'PO' },
    { key: 'assists', label: 'A' },
    { key: 'errors', label: 'E' },
    { key: 'fieldingPct', label: 'FLD%', render: (r) => formatDecimal(r.fieldingPct) },
  ]

  const battingSkillItems = talentAnalysis ? [
    { key: 'power', label: 'Power', value: talentAnalysis.rawMetrics?.batting?.power, min: statMins?.power ?? 0, median: statMedians?.power ?? 50, digits: 1, max: floorMax(statMaxes?.power, talentAnalysis.rawMetrics?.batting?.power) },
    { key: 'contact', label: 'Contact', value: talentAnalysis.rawMetrics?.batting?.contact, min: statMins?.contact ?? 0, median: statMedians?.contact ?? 50, digits: 1, max: floorMax(statMaxes?.contact, talentAnalysis.rawMetrics?.batting?.contact) },
    { key: 'plateCoverage', label: 'Plate Coverage', value: talentAnalysis.rawMetrics?.batting?.plateCoverage, min: statMins?.plateCoverage ?? 0, median: statMedians?.plateCoverage ?? 50, max: floorMax(statMaxes?.plateCoverage, talentAnalysis.rawMetrics?.batting?.plateCoverage) },
    { key: 'contactPerfectWindow', label: 'Contact Window', value: talentAnalysis.rawMetrics?.batting?.contactPerfectWindow, min: statMins?.contactPerfectWindow ?? 0, median: statMedians?.contactPerfectWindow ?? 50, max: floorMax(statMaxes?.contactPerfectWindow, talentAnalysis.rawMetrics?.batting?.contactPerfectWindow) },
    { key: 'baserunning', label: 'Baserunning', value: talentAnalysis.rawMetrics?.batting?.baserunning, min: statMins?.baserunning ?? 0, median: statMedians?.baserunning ?? 50, digits: 1, max: floorMax(statMaxes?.baserunning, talentAnalysis.rawMetrics?.batting?.baserunning) },
  ] : []
  const pitchingSkillItems = talentAnalysis ? [
    { key: 'velocity', label: 'Velocity', value: talentAnalysis.rawMetrics?.pitching?.velocity, min: statMins?.velocity ?? 0, median: statMedians?.velocity ?? 50, digits: 1, max: floorMax(statMaxes?.velocity, talentAnalysis.rawMetrics?.pitching?.velocity) },
    { key: 'curve', label: 'Curve', value: talentAnalysis.rawMetrics?.pitching?.curve, min: statMins?.curve ?? 0, median: statMedians?.curve ?? 50, max: floorMax(statMaxes?.curve, talentAnalysis.rawMetrics?.pitching?.curve) },
    { key: 'staminaMetric', label: 'Stamina', value: talentAnalysis.rawMetrics?.pitching?.stamina, min: statMins?.staminaMetric ?? 0, median: statMedians?.staminaMetric ?? 50, max: floorMax(statMaxes?.staminaMetric, talentAnalysis.rawMetrics?.pitching?.stamina) },
    { key: 'velocityIndex', label: 'Velocity Index', value: effectiveIntrinsics.velocityIndex, min: statMins?.velocityIndex ?? 0, median: statMedians?.velocityIndex ?? 80, max: floorMax(statMaxes?.velocityIndex, effectiveIntrinsics.velocityIndex, 160) },
    { key: 'breakIndex', label: 'Break Index', value: effectiveIntrinsics.breakIndex, min: statMins?.breakIndex ?? 0, median: statMedians?.breakIndex ?? 50, max: floorMax(statMaxes?.breakIndex, effectiveIntrinsics.breakIndex) },
    { key: 'staminaRaw', label: 'Raw Stamina', value: effectiveIntrinsics.stamina, min: statMins?.stamina ?? 0, median: statMedians?.stamina ?? 50, max: floorMax(statMaxes?.stamina, effectiveIntrinsics.stamina) },
  ] : []
  const fieldingSkillItems = talentAnalysis ? [
    { key: 'catchCoverage', label: 'Catch Coverage', value: talentAnalysis.rawMetrics?.fielding?.catchCoverage, min: statMins?.catchCoverage ?? 0, median: statMedians?.catchCoverage ?? 50, max: floorMax(statMaxes?.catchCoverage, talentAnalysis.rawMetrics?.fielding?.catchCoverage) },
    { key: 'fieldingMetric', label: 'Fielding', value: talentAnalysis.rawMetrics?.fielding?.fielding, min: statMins?.fieldingMetric ?? 0, median: statMedians?.fieldingMetric ?? 50, max: floorMax(statMaxes?.fieldingMetric, talentAnalysis.rawMetrics?.fielding?.fielding) },
    { key: 'armStrength', label: 'Arm Strength', value: talentAnalysis.rawMetrics?.fielding?.armStrength, min: statMins?.armStrength ?? 0, median: statMedians?.armStrength ?? 50, max: floorMax(statMaxes?.armStrength, talentAnalysis.rawMetrics?.fielding?.armStrength) },
    { key: 'mobility', label: 'Mobility', value: talentAnalysis.rawMetrics?.fielding?.mobility, min: statMins?.mobility ?? 0, median: statMedians?.mobility ?? 50, max: floorMax(statMaxes?.mobility, talentAnalysis.rawMetrics?.fielding?.mobility) },
    { key: 'baseDefense', label: 'Base Defense', value: talentAnalysis.rawMetrics?.fielding?.baseDefense, min: statMins?.baseDefense ?? 0, median: statMedians?.baseDefense ?? 50, max: floorMax(statMaxes?.baseDefense, talentAnalysis.rawMetrics?.fielding?.baseDefense) },
  ] : []

  const pitchingEmpty = isPitchingAllZero(showPitching)

  const starHitEmpty = (starHitStats.used || 0) === 0
  const battedBallEmpty = allZeroPct(battingBattedBall.ldRate, battingBattedBall.gbRate, battingBattedBall.fbRate, battingBattedBall.bloopRate)
  const sprayEmpty = allZeroPct(battingSpray.pullRate, battingSpray.centerRate, battingSpray.oppoRate) && (battingDiscipline.pitchesPerPa || 0) === 0
  const pitchFieldEmpty = allZeroPct(pitchingStar.successRate, pitchingMix.strikeRate, pitchingMix.firstPitchStrikeRate, pitchingMix.swingingMissRate)
  const powerEmpty = (battingDistance.sampleSize || 0) === 0
  const advancedSections = [
    { key: 'starHit', label: 'Star Hit', empty: starHitEmpty },
    { key: 'battedBall', label: 'Batted Ball', empty: battedBallEmpty },
    { key: 'sprayDiscipline', label: 'Spray & Discipline', empty: sprayEmpty },
    { key: 'pitchingFielding', label: 'Pitching & Fielding', empty: pitchFieldEmpty },
    { key: 'power', label: 'Power / Distance', empty: powerEmpty },
  ]
  const noData = <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No data recorded yet</p>

  const rawPasBatting = showBatting.rawPas || []
  const rawStintsPitching = showPitching.rawStints || []
  const hasBatting = rawPasBatting.length > 0
  const hasPitching = rawStintsPitching.length > 0
  const effectiveGamelogStatType = (gamelogStatType === 'pitching' && !hasPitching) ? 'batting'
    : (gamelogStatType === 'batting' && !hasBatting) ? 'pitching'
    : gamelogStatType

  // ─── Rolling stat chart (Trends) ────────────────────────────────────────────
  const ROLLING_WINDOW = 15
  const rollingChartPoints = (() => {
    if (rawPasBatting.length < ROLLING_WINDOW) return []
    const points = []
    for (let i = ROLLING_WINDOW - 1; i < rawPasBatting.length; i++) {
      const windowPas = rawPasBatting.slice(i - ROLLING_WINDOW + 1, i + 1)
      const s = summarizeBatting(windowPas)
      s.ops = s.obp + s.slg
      points.push({ value: s.ops, xLabel: `PA ${i + 1}` })
    }
    return points
  })()

  function renderBattingLog() {
    if (!hasBatting) return <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No hitting data for this source.</p>
    const gameOrder = []
    const gameMap = {}
    for (const pa of rawPasBatting) {
      const gid = String(pa.game_id ?? 'unknown')
      if (!gameMap[gid]) { gameMap[gid] = []; gameOrder.push(gid) }
      gameMap[gid].push(pa)
    }
    const gameRows = gameOrder.map((gid, i) => {
      const s = summarizeBatting(gameMap[gid])
      s.ops = s.obp + s.slg
      return { gameNum: i + 1, gid, ...s }
    })
    const totals = summarizeBatting(rawPasBatting)
    totals.ops = totals.obp + totals.slg
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 440 }}>
          <thead><tr><th>Game</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>R</th><th>BB</th><th>K</th><th>AVG</th><th>OPS</th></tr></thead>
          <tbody>
            {gameRows.map((g, i) => (
              <tr key={g.gid} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                <td style={{ color: '#94A3B8' }}>G{g.gameNum}</td>
                <td>{g.plateAppearances}</td><td>{g.atBats}</td><td>{g.hits}</td>
                <td>{g.homeRuns}</td><td>{g.rbi}</td><td>{g.runs}</td>
                <td>{g.walks}</td><td>{g.strikeouts}</td>
                <td>{formatDecimal(g.avg)}</td><td>{formatDecimal(g.ops)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
              <td style={{ color: '#94A3B8', fontWeight: 700 }}>TOT</td>
              <td>{totals.plateAppearances}</td><td>{totals.atBats}</td><td>{totals.hits}</td>
              <td>{totals.homeRuns}</td><td>{totals.rbi}</td><td>{totals.runs}</td>
              <td>{totals.walks}</td><td>{totals.strikeouts}</td>
              <td>{formatDecimal(totals.avg)}</td><td>{formatDecimal(totals.ops)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  function renderPitchingLog() {
    if (!hasPitching) return <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No pitching appearances recorded.</p>
    const byGame = {}
    const gameOrder = []
    rawStintsPitching.forEach((stint) => {
      const gid = String(stint.game_id ?? 'unknown')
      if (!byGame[gid]) { byGame[gid] = []; gameOrder.push(gid) }
      byGame[gid].push(stint)
    })
    const gameRows = gameOrder.map((gid, index) => ({ gid, gameNum: index + 1, ...summarizePitching(byGame[gid]) }))
    const totals = summarizePitching(rawStintsPitching)
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 560 }}>
          <thead><tr><th>Game</th><th>IP</th><th>W</th><th>L</th><th>SV</th><th>K</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>HR</th><th>ERA/3</th><th>WHIP</th></tr></thead>
          <tbody>
            {gameRows.map((game, i) => (
              <tr key={game.gid} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                <td style={{ color: '#94A3B8' }}>G{game.gameNum}</td>
                <td>{formatDecimal(game.innings, 1)}</td>
                <td>{formatInteger(game.wins)}</td><td>{formatInteger(game.losses)}</td>
                <td>{formatInteger(game.saves)}</td><td>{formatInteger(game.strikeouts)}</td>
                <td>{formatInteger(game.hitsAllowed)}</td><td>{formatInteger(game.runsAllowed)}</td>
                <td>{formatInteger(game.earnedRuns)}</td><td>{formatInteger(game.walks)}</td>
                <td>{formatInteger(game.homeRunsAllowed)}</td><td>{formatDecimal(game.era, 2)}</td><td>{formatDecimal(game.whip, 2)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
              <td style={{ color: '#94A3B8', fontWeight: 700 }}>TOT</td>
              <td>{formatDecimal(totals.innings, 1)}</td>
              <td>{formatInteger(totals.wins)}</td><td>{formatInteger(totals.losses)}</td>
              <td>{formatInteger(totals.saves)}</td><td>{formatInteger(totals.strikeouts)}</td>
              <td>{formatInteger(totals.hitsAllowed)}</td><td>{formatInteger(totals.runsAllowed)}</td>
              <td>{formatInteger(totals.earnedRuns)}</td><td>{formatInteger(totals.walks)}</td>
              <td>{formatInteger(totals.homeRunsAllowed)}</td><td>{formatDecimal(totals.era, 2)}</td><td>{formatDecimal(totals.whip, 2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  function ChemChip({ name }) {
    const onRoster = isChemistryNameOnRoster(name, rosterNames)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0.28rem 0.55rem', border: `1px solid ${onRoster ? 'rgba(148,163,184,0.6)' : 'rgba(148,163,184,0.2)'}`, borderRadius: 999, background: onRoster ? 'rgba(148,163,184,0.12)' : 'transparent' }}>
        <CharacterPortrait name={name} size={20} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#F8FAFC' }}>{allCharactersById[name]?.name || name}</span>
      </div>
    )
  }

  const nonHrPas = rawPasBatting.filter((pa) => pa.result !== 'HR' && pa.result !== 'IPHR' && pa.hit_distance_ft != null && pa.hit_angle_deg != null)
  const wouldBeHrCount = nonHrPas.filter((pa) => (wouldBeHrElsewhere(pa)?.clearedCount || 0) > 0).length

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: 40 }}>
      <button type="button" onClick={() => navigate(-1)} style={BACK_BUTTON_STYLE}>
        <ArrowLeft size={16} /> Back
      </button>

      {/* Header */}
      <section className="panel" style={{ padding: '1.25rem 1.4rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
          <div style={{ width: 76, height: 76, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${classAccent.border}`, flexShrink: 0 }}>
            <CharacterPortrait name={character.name} size={76} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{character.name}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {currentOwner ? (
                <PlayerTag height={22} identitiesByPlayerId={identitiesByPlayerId} playerId={currentOwner.player_id} playersById={playersById} />
              ) : (
                <span style={{ color: '#64748B', fontSize: 12 }}>Undrafted</span>
              )}
              {talentAnalysis && (
                <span style={{ fontSize: 11, fontWeight: 800, padding: '0.15rem 0.5rem', borderRadius: 999, background: tierBadgeStyle.bg, border: `1px solid ${tierBadgeStyle.border}`, color: tierBadgeStyle.color, letterSpacing: '.03em', textTransform: 'uppercase' }}>
                  {tierMeta.label}
                </span>
              )}
              {(totalDrafts > 0 || tournamentsDrafted > 0 || championshipsWon > 0) && (
                <span style={{ color: '#64748B', fontSize: 12 }}>
                  {totalDrafts} drafts · {tournamentsDrafted} events · {championshipsWon} titles
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 10, padding: '0.45rem 0.7rem' }}>
          {[
            { stat: 'batting', value: battingRating },
            { stat: 'pitching', value: pitchingRating },
            { stat: 'fielding', value: fieldingRating },
            { stat: 'speed', value: speedRating },
          ].map(({ stat, value }, i) => (
            <div key={stat} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 34, ...(i > 0 ? { borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 6 } : {}) }}>
              <StatIcon stat={stat} size={13} style={{ opacity: 0.6 }} />
              <span style={{ color: '#F8FAFC', fontSize: 18, fontWeight: 800, lineHeight: 1.2, marginTop: 2 }}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Percentile snapshot */}
      <section className="panel" style={{ padding: '0.9rem 1.1rem', display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'space-evenly' }}>
        {SNAPSHOT_METRICS.map((metric) => {
          const entry = snapshotPercentiles[metric.key]
          return (
            <PercentileChip
              key={metric.key}
              label={metric.label}
              value={entry?.value}
              percentile={entry?.percentile}
              digits={metric.digits}
              suffix={metric.suffix}
            />
          )
        })}
      </section>

      {/* Sticky section nav */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', gap: 4, overflowX: 'auto', background: 'rgba(10,14,23,0.85)', backdropFilter: 'blur(6px)', borderRadius: 10, padding: '0.4rem 0.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            style={{ background: 'none', border: 'none', color: '#94A3B8', fontSize: 12, fontWeight: 600, padding: '0.35rem 0.6rem', borderRadius: 8, whiteSpace: 'nowrap', cursor: 'pointer' }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Overview */}
      {talentAnalysis && (
        <Section id="overview" title="Overview">
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ background: '#1E2E44', borderRadius: 10, padding: '0.55rem 0.65rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 6 }}>
                {[
                  { label: 'Bat OVR', displayValue: talentAnalysis.displayRatings.batting, tier: talentAnalysis.battingTier, impact: talentAnalysis.skillImpact?.batting },
                  { label: 'Pitch OVR', displayValue: talentAnalysis.displayRatings.pitching, tier: talentAnalysis.pitchingTier, impact: talentAnalysis.skillImpact?.pitching },
                  { label: 'Field OVR', displayValue: talentAnalysis.displayRatings.fielding, tier: talentAnalysis.fieldingTier, impact: talentAnalysis.skillImpact?.fielding },
                  { label: 'Speed OVR', displayValue: talentAnalysis.displayRatings.speed, tier: talentAnalysis.speedTier, impact: talentAnalysis.skillImpact?.speed },
                ].map(({ label, displayValue, tier, impact }) => {
                  const ts = getTierBadgeStyle(tier)
                  const hasPerformance = impact && impact.performance !== 0
                  const performanceColor = hasPerformance ? (impact.performance > 0 ? '#22C55E' : '#F87171') : '#64748B'
                  return (
                    <div key={label} style={{ borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', padding: '0.4rem 0.55rem' }}>
                      <div style={{ color: '#94A3B8', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#F8FAFC', lineHeight: 1 }}>{displayValue}</div>
                      <div style={{ marginTop: 2 }}><span style={{ fontSize: 10, fontWeight: 800, color: ts.color }}>{getTalentTierMeta(tier).label}</span></div>
                      {hasPerformance ? (
                        <div style={{ marginTop: 2 }}>
                          <span style={{ color: '#64748B', fontSize: 9 }}>
                            {impact.base}
                            <span style={{ color: performanceColor, fontWeight: 700 }}> {formatSignedInt(impact.performance)}</span>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <SkillSectionCard title="Batting" score={talentAnalysis.displayRatings.batting} scoreMin={statMins?.offense ?? 0} scoreMedian={statMedians?.offense ?? 50} scoreMax={Math.max(statMaxes?.offense ?? 100, talentAnalysis.displayRatings.batting)} items={battingSkillItems} />
              <SkillSectionCard title="Pitching" score={talentAnalysis.displayRatings.pitching} scoreMin={statMins?.pitching ?? 0} scoreMedian={statMedians?.pitching ?? 50} scoreMax={Math.max(statMaxes?.pitching ?? 100, talentAnalysis.displayRatings.pitching)} items={pitchingSkillItems} />
              <SkillSectionCard title="Fielding" score={talentAnalysis.displayRatings.fielding} scoreMin={statMins?.defense ?? 0} scoreMedian={statMedians?.defense ?? 50} scoreMax={Math.max(statMaxes?.defense ?? 100, talentAnalysis.displayRatings.fielding)} items={fieldingSkillItems} />
              <SkillSectionCard title="Speed" score={talentAnalysis.displayRatings.speed} scoreMin={statMins?.speed ?? 0} scoreMedian={statMedians?.speed ?? 50} scoreMax={Math.max(statMaxes?.speed ?? 100, talentAnalysis.displayRatings.speed)} items={[]} />
            </div>
          </div>
        </Section>
      )}

      {/* Stats */}
      <Section id="stats" title="Stats">
        <div style={{ display: 'grid', gap: 20 }}>
          <select value={statsStatType} onChange={(e) => setStatsStatType(e.target.value)} style={{ ...dropStyle, alignSelf: 'start' }}>
            <option value="batting">Hitting</option>
            <option value="pitching">Pitching</option>
          </select>
          {statsStatType === 'batting' && (
            battingTableRows.length === 0 ? noData : (
              <YearByYearTable columns={battingColumns} rows={battingTableRows} careerRow={battingCareerRow} />
            )
          )}
          {statsStatType === 'pitching' && (
            pitchingEmpty && pitchingTableRows.length === 0 ? noData : (
              <YearByYearTable columns={pitchingColumns} rows={pitchingTableRows} careerRow={pitchingCareerRow} />
            )
          )}
        </div>
      </Section>

      {/* Advanced */}
      <Section id="advanced" title="Advanced">
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={advancedSection} onChange={(e) => setAdvancedSection(e.target.value)} style={dropStyle}>
              {advancedSections.map((s) => <option key={s.key} value={s.key}>{s.label}{s.empty ? ' (no data)' : ''}</option>)}
            </select>
            {renderSourceSelector()}
          </div>
          {advancedSection === 'starHit' && (starHitEmpty ? noData : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <SmallChip label="Used" value={formatInteger(starHitStats.used)} accent="#EAB308" />
              <SmallChip label="Contact %" value={`${(starHitStats.contactRate * 100).toFixed(0)}%`} accent="#22C55E" />
              <SmallChip label="Success %" value={`${(starHitStats.successRate * 100).toFixed(0)}%`} accent="#3B82F6" />
              <SmallChip label="RBI/Use" value={formatDecimal(starHitStats.avgRbiPerUse, 2)} />
            </div>
          ))}
          {advancedSection === 'battedBall' && (battedBallEmpty ? noData : (
            <BattedBallBar ldRate={battingBattedBall.ldRate} gbRate={battingBattedBall.gbRate} fbRate={battingBattedBall.fbRate} />
          ))}
          {advancedSection === 'sprayDiscipline' && (sprayEmpty ? noData : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <SmallChip label="Pull%" value={`${(battingSpray.pullRate * 100).toFixed(0)}%`} accent="#22C55E" />
              <SmallChip label="Center%" value={`${(battingSpray.centerRate * 100).toFixed(0)}%`} accent="#3B82F6" />
              <SmallChip label="Oppo%" value={`${(battingSpray.oppoRate * 100).toFixed(0)}%`} accent="#EAB308" />
              <SmallChip label="P/PA" value={formatDecimal(battingDiscipline.pitchesPerPa, 2)} />
              <SmallChip label="Whiff%" value={`${(battingDiscipline.whiffRate * 100).toFixed(0)}%`} accent="#EF4444" />
              <SmallChip label="Foul%" value={`${(battingDiscipline.foulRate * 100).toFixed(0)}%`} />
              <SmallChip label="KS%" value={`${(battingDiscipline.ksRate * 100).toFixed(0)}%`} accent="#EF4444" />
              <SmallChip label="KL%" value={`${(battingDiscipline.klRate * 100).toFixed(0)}%`} />
            </div>
          ))}
          {advancedSection === 'pitchingFielding' && (pitchFieldEmpty ? noData : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <SmallChip label="Star Pitch %" value={`${(pitchingStar.successRate * 100).toFixed(0)}%`} accent="#EAB308" />
              <SmallChip label="Strike %" value={`${(pitchingMix.strikeRate * 100).toFixed(0)}%`} accent="#22C55E" />
              <SmallChip label="1st Str %" value={`${(pitchingMix.firstPitchStrikeRate * 100).toFixed(0)}%`} accent="#3B82F6" />
              <SmallChip label="Whiff %" value={`${(pitchingMix.swingingMissRate * 100).toFixed(0)}%`} accent="#EF4444" />
              <SmallChip label="Allowed LD%" value={`${(pitchingBattedBall.ldRate * 100).toFixed(0)}%`} />
              <SmallChip label="Allowed Pull%" value={`${(pitchingSpray.pullRate * 100).toFixed(0)}%`} />
              <SmallChip label="Star Used" value={formatInteger(pitchingStar.used)} accent="#EAB308" />
            </div>
          ))}
          {advancedSection === 'power' && (powerEmpty ? noData : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                <SmallChip label="Avg Dist" value={`${battingDistance.avgDistance} ft`} accent="#3B82F6" />
                <SmallChip label="Longest" value={`${battingDistance.maxDistance} ft`} accent="#EAB308" />
                <SmallChip label="Hard-Hit %" value={`${(battingDistance.hardHitRate * 100).toFixed(0)}%`} accent="#22C55E" />
                <SmallChip label="Power Index" value={formatInteger(hitPowerIndex)} accent="#F97316" />
              </div>
              {wouldBeHrCount > 0 ? (
                <p style={{ color: '#94A3B8', fontSize: 12, margin: 0 }}>
                  {wouldBeHrCount} of {character.name}'s non-homers would have left the yard in at least one other stadium.
                </p>
              ) : null}
              <SprayChart plateAppearances={rawPasBatting} height={320} />
            </div>
          ))}
        </div>
      </Section>

      {/* Expected stats */}
      <Section id="xstats" title="Expected Stats">
        {expectedBatting.sampleSize === 0 ? noData : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <SmallChip label="AVG vs xBA" value={`${formatDecimal(showBatting.avg)} / ${formatDecimal(expectedBatting.xBA)}`} accent="#3B82F6" />
              <SmallChip label="SLG vs xSLG" value={`${formatDecimal(showBatting.slg)} / ${formatDecimal(expectedBatting.xSLG)}`} accent="#EAB308" />
              <SmallChip label="wOBA-scale vs xwOBA" value={formatDecimal(expectedBatting.xwOBA)} accent="#22C55E" />
            </div>
            <p style={{ color: '#64748B', fontSize: 12, margin: 0 }}>
              Based on {expectedBatting.sampleSize} batted balls with tracked exit velocity/launch angle, compared against similar contact league-wide.
            </p>
          </div>
        )}
      </Section>

      {/* Fielding */}
      <Section id="fielding" title="Fielding">
        {fieldingTableRows.length === 0 ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {noData}
            <p style={{ color: '#475569', fontSize: 11, margin: 0 }}>
              Only total chances, errors, and fielding % are tracked — putouts/assists come from the fielder chain recorded during scoring.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <YearByYearTable columns={fieldingColumns} rows={fieldingTableRows} careerRow={fieldingCareerRow} />
            <p style={{ color: '#475569', fontSize: 11, margin: 0 }}>
              PO/A are derived from the recorded fielder chain on each play (last fielder touched = putout, earlier fielders = assists).
            </p>
          </div>
        )}
      </Section>

      {/* Trends */}
      <Section id="chart" title="Trends">
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Rolling OPS (trailing {ROLLING_WINDOW} PA)
          </div>
          <RollingStatChart points={rollingChartPoints} color="#EAB308" />
        </div>
      </Section>

      {/* Awards */}
      <Section id="awards" title="Awards">
        {awardRows.length === 0 ? noData : (
          <div style={{ display: 'grid', gap: 8 }}>
            {awardRows.map((row, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.7rem', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <span style={{
                  fontSize: 10, fontWeight: 800, padding: '0.15rem 0.5rem', borderRadius: 999, textTransform: 'uppercase',
                  background: row.led ? 'rgba(234,179,8,0.15)' : 'rgba(59,130,246,0.15)',
                  border: `1px solid ${row.led ? 'rgba(234,179,8,0.4)' : 'rgba(59,130,246,0.4)'}`,
                  color: row.led ? '#EAB308' : '#60A5FA',
                }}>
                  {row.led ? 'Led League' : `Top ${row.rank}`}
                </span>
                <span style={{ fontSize: 13, color: '#F8FAFC' }}>{row.stat} — {row.eventLabel}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Transactions */}
      <Section id="transactions" title="Transactions">
        {transactions.length === 0 ? noData : (
          <div style={{ display: 'grid', gap: 8 }}>
            {transactions.map((tx, i) => {
              const dateLabel = tx.date ? new Date(tx.date).toLocaleDateString() : ''
              let description = ''
              if (tx.type === 'draft') description = `Drafted${tx.round ? ` (Round ${tx.round}, Pick ${tx.pickNumber})` : ''} by ${teamLabel(tx.playerId)}${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
              else if (tx.type === 'season_draft') description = `Drafted${tx.round ? ` (Round ${tx.round}, Pick ${tx.pickNumber})` : ''} by ${teamLabel(tx.teamId)}${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
              else if (tx.type === 'trade') description = `Traded: ${teamLabel(tx.fromPlayerId)} → ${teamLabel(tx.toPlayerId)}`
              else if (tx.type === 'waiver') description = `Won off waivers by ${teamLabel(tx.teamId)}`
              else if (tx.type === 'free_agent_add') description = `Signed as a free agent by ${teamLabel(tx.teamId)}${tx.eventLabel ? ` — ${tx.eventLabel}` : ''}`
              else if (tx.type === 'free_agent_drop') description = `Dropped by ${teamLabel(tx.teamId)}`
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

      {/* Chemistry */}
      <Section id="chemistry" title="Chemistry">
        <div style={{ display: 'grid', gap: 16 }}>
          {chemistrySummary && (
            <div style={{ display: 'flex', gap: '0.5rem 1.5rem', flexWrap: 'wrap' }}>
              {[
                { label: 'Positive', value: chemistrySummary.positive, color: '#22C55E' },
                { label: 'Negative', value: chemistrySummary.negative, color: '#EF4444' },
                { label: 'Net', value: chemistrySummary.net, color: chemistrySummary.net >= 0 ? '#4ADE80' : '#FCA5A5' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</span>
                  <span style={{ color, fontSize: 14, fontWeight: 700, marginTop: 1 }}>{value}</span>
                </div>
              ))}
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#22C55E', marginBottom: 7 }}>Good</div>
            {chemistry.good.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{chemistry.good.map((name) => <ChemChip key={name} name={name} />)}</div>
            ) : <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No good chemistry</span>}
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#EF4444', marginBottom: 7 }}>Bad</div>
            {chemistry.bad.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{chemistry.bad.map((name) => <ChemChip key={name} name={name} />)}</div>
            ) : <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No bad chemistry</span>}
          </div>
        </div>
      </Section>

      {/* Gamelog */}
      <Section id="gamelog" title="Gamelog">
        {(!hasBatting && !hasPitching) ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{renderSourceSelector()}</div>
            <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No game data available for this source.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select value={effectiveGamelogStatType} onChange={(e) => setGamelogStatType(e.target.value)} style={dropStyle}>
                {hasBatting && <option value="batting">Hitting</option>}
                {hasPitching && <option value="pitching">Pitching</option>}
              </select>
              {renderSourceSelector()}
            </div>
            {effectiveGamelogStatType === 'batting' ? renderBattingLog() : renderPitchingLog()}
          </div>
        )}
      </Section>
    </div>
  )
}
