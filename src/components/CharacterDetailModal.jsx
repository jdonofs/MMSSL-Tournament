import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  buildCharacterIntrinsics,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizePitchMix,
  summarizePitching,
  summarizePlateDiscipline,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
} from '../utils/statsCalculator'
import { analyzeCharacterTalent, getTalentTierMeta, toDisplayRating } from '../utils/characterAnalysis'
import CharacterPortrait from './CharacterPortrait'
import StatIcon from './StatIcon'
import PlayerTag from './PlayerTag'
import { chemBreakdown, getChemistry, isChemistryNameOnRoster } from '../data/chemistry'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : '-'
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

// ─── Gradient bar color helpers ───────────────────────────────────────────────

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function lerpColor(c1, c2, t) {
  const [r1, g1, b1] = hexToRgb(c1)
  const [r2, g2, b2] = hexToRgb(c2)
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`
}

function getBarColor(pct) {
  // 0 = red, 0.5 = yellow, 1.0 = green
  const stops = ['#EF4444', '#EAB308', '#22C55E']
  const scaled = Math.max(0, Math.min(1, pct)) * (stops.length - 1)
  const lo = Math.floor(scaled)
  const hi = Math.min(stops.length - 1, lo + 1)
  return lerpColor(stops[lo], stops[hi], scaled - lo)
}

function calcMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── Zero-state helpers ───────────────────────────────────────────────────────

function isPitchingAllZero(p) {
  return !p || (
    (p.innings || 0) === 0 &&
    (p.strikeouts || 0) === 0 &&
    (p.wins || 0) === 0 &&
    (p.losses || 0) === 0 &&
    (p.saves || 0) === 0
  )
}

function getHistoryEntryId(entry = {}) {
  return String(entry.sourceId ?? entry.tournamentId ?? '')
}

function getHistoryEntryLabel(entry = {}) {
  return entry.sourceLabel || (entry.tournamentNumber ? `Tournament ${entry.tournamentNumber}` : 'Unknown')
}

function sortHistoryEntries(a, b) {
  if ((a.sortGroup || 0) !== (b.sortGroup || 0)) return (a.sortGroup || 0) - (b.sortGroup || 0)
  return (b.sortValue || 0) - (a.sortValue || 0)
}

function allZeroPct(...rates) {
  return rates.every((r) => !r || r === 0)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.12em',
      color: '#64748B', paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)',
      marginBottom: 10,
    }}>
      {children}
    </div>
  )
}

function Badge({ children, color = '#F8FAFC', border = 'rgba(255,255,255,0.18)', background = 'rgba(255,255,255,0.06)' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', borderRadius: 999,
      border: `1px solid ${border}`, background, color,
      padding: '0.18rem 0.48rem', fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
      textTransform: 'uppercase',
    }}>
      {children}
    </span>
  )
}

// Gradient bar: color based on value vs max, with median marker
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
  const barColor = getBarColor(pct)
  const markers = [
    { key: 'min', value: min, left: markerPct(min), align: 'start' },
    { key: 'median', value: median, left: markerPct(median), align: 'center' },
    { key: 'max', value: max, left: markerPct(max), align: 'end' },
  ]
  const markerTransform = (align) => {
    if (align === 'start') return 'translateX(0)'
    if (align === 'end') return 'translateX(-100%)'
    return 'translateX(-50%)'
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: '#CBD5E1', fontWeight: 600 }}>{label}</span>
        <span style={{ color: '#F8FAFC', fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ position: 'relative', height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'visible' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: barColor, borderRadius: 999, position: 'absolute', top: 0, left: 0 }} />
        {markers.map((marker) => (
          <div
            key={marker.key}
            style={{
              position: 'absolute', left: marker.left, top: -3,
              width: 2, height: 12, background: 'rgba(255,255,255,0.55)',
              borderRadius: 2, transform: markerTransform(marker.align),
            }}
          />
        ))}
      </div>
      <div style={{ position: 'relative', height: 14, marginTop: 1 }}>
        {markers.map((marker) => (
          <span
            key={marker.key}
            style={{
              position: 'absolute', left: marker.left, top: 0,
              transform: markerTransform(marker.align),
              fontSize: 8, color: 'rgba(255,255,255,0.65)', fontWeight: 700,
              whiteSpace: 'nowrap',
            }}
          >
            {marker.value}
          </span>
        ))}
      </div>
    </div>
  )
}

function MetricList({ items = [] }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.map(({ key, label, value, min = 0, median, max = 100, digits = 0 }) => (
        <ScoreBar
          key={key}
          label={label}
          value={Number.isFinite(value) ? Number(value).toFixed(digits) : '-'}
          min={min}
          max={max}
          median={median}
        />
      ))}
    </div>
  )
}

function SkillSectionCard({ title, score, scoreMin = 0, scoreMedian, scoreMax = 100, items }) {
  return (
    <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', padding: '0.9rem 1rem', display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ color: '#CBD5E1', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</div>
        <ScoreBar label={`${title} Score`} value={Math.round(score)} min={scoreMin} median={scoreMedian ?? 50} max={scoreMax} />
      </div>
      <MetricList items={items} />
    </div>
  )
}

function SmallChip({ label, value, accent = '#F8FAFC' }) {
  return (
    <div style={{
      border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10,
      padding: '0.38rem 0.6rem', background: 'rgba(255,255,255,0.03)',
    }}>
      <div style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ color: accent, fontSize: 15, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

// All stat values rendered uniformly — no gold highlights
function StatRow({ stats }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 1.1rem', alignItems: 'flex-end' }}>
      {stats.map(({ label, value }) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ color: '#64748B', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</span>
          <span style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 500, marginTop: 1 }}>{value}</span>
        </div>
      ))}
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
        {segments.map(({ pct, color }, i) => (
          <div key={i} style={{ width: `${pct}%`, background: color }} />
        ))}
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

// ─── Empty defaults ───────────────────────────────────────────────────────────

const EMPTY_BATTING = {
  plateAppearances: 0, atBats: 0, hits: 0, runs: 0, rbi: 0, homeRuns: 0, avg: null, ops: null,
  games: 0, doubles: 0, triples: 0, walks: 0, hbp: 0, strikeouts: 0, totalBases: 0, obp: null, slg: null, rawPas: [],
}
const EMPTY_PITCHING = {
  innings: 0, wins: 0, losses: 0, saves: 0, strikeouts: 0, era: null, whip: null, kPer3: null,
  games: 0, completeGames: 0, shutouts: 0, hitsAllowed: 0, runsAllowed: 0, earnedRuns: 0, walks: 0, homeRunsAllowed: 0, hrPer3: null, rawPas: [],
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CharacterDetailModal({
  character,
  allCharactersById = {},
  playersById = {},
  identitiesByPlayerId = {},
  currentTournamentBatting = EMPTY_BATTING,
  currentTournamentPitching = EMPTY_PITCHING,
  allTimeBatting = EMPTY_BATTING,
  allTimePitching = EMPTY_PITCHING,
  allPitches = [],
  allFielding = null,
  battingHistory = [],
  pitchingHistory = [],
  currentOwner = null,
  totalDrafts = 0,
  tournamentsDrafted = 0,
  championshipsWon = 0,
  characterIntrinsics = null,
  rosterNames = [],
  onClose,
}) {
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedSourceId, setSelectedSourceId] = useState('current')
  const [gamelogStatType, setGamelogStatType] = useState('batting')
  const [statsStatType, setStatsStatType] = useState('batting')
  const [advancedSection, setAdvancedSection] = useState('starHit')
  const isNarrowViewport = typeof window !== 'undefined' && window.innerWidth <= 640

  if (!character) return null

  const chemistry = getChemistry(character.name)
  const batterPitches = allPitches.filter((p) => p.batter_id === character.name)
  const pitcherPitches = allPitches.filter((p) => p.pitcher_id === character.name)
  const countGames = (entries = []) => new Set(entries.map((entry) => String(entry.game_id ?? ''))).size

  // ─── Shared source options (used by Stats, Advanced, Gamelog tabs) ────────
  const sourceMap = {}
  battingHistory.filter((e) => e.rawPas?.length > 0).forEach((e) => {
    const id = getHistoryEntryId(e)
    const games = countGames(e.rawPas)
    sourceMap[id] = { label: getHistoryEntryLabel(e), games: Math.max(sourceMap[id]?.games || 0, games), sortGroup: e.sortGroup || 0, sortValue: e.sortValue || 0 }
  })
  pitchingHistory.filter((e) => (e.innings || 0) > 0).forEach((e) => {
    const id = getHistoryEntryId(e)
    const games = Number(e.games || 0)
    sourceMap[id] = { label: getHistoryEntryLabel(e), games: Math.max(sourceMap[id]?.games || 0, games), sortGroup: e.sortGroup || 0, sortValue: e.sortValue || 0 }
  })
  const sourceOptions = Object.entries(sourceMap)
    .map(([id, meta]) => ({ id, ...meta }))
    .sort(sortHistoryEntries)
    .map(({ id, label, games }) => ({ id, label: `${label} (${games} G)` }))

  // Resolve the active source's batting and pitching data
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
      showBatting = EMPTY_BATTING
    }
    const pitchingEntry = pitchingHistory.find((e) => getHistoryEntryId(e) === selectedSourceId)
    showPitching = pitchingEntry || EMPTY_PITCHING
  }

  // Advanced stats derived from the active source's raw PAs
  const starHitStats = summarizeStarHits(showBatting.rawPas || [])
  const battingBattedBall = summarizeBattedBallProfile(showBatting.rawPas || [])
  const battingSpray = summarizeSprayProfile(showBatting.rawPas || [])
  const battingDiscipline = summarizePlateDiscipline(showBatting.rawPas || [], batterPitches)
  const pitchingStar = summarizeStarPitching(showPitching.rawPas || [], pitcherPitches)
  const pitchingMix = summarizePitchMix(showPitching.rawPas || [], pitcherPitches)
  const pitchingBattedBall = summarizeBattedBallProfile(showPitching.rawPas || [])
  const pitchingSpray = summarizeSprayProfile(showPitching.rawPas || [])

  const renderSourceSelector = (extraStyle = {}) => {
    const dropStyle = { background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '4px 8px', fontSize: 12, cursor: 'pointer', ...extraStyle }
    return (
      <select value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)} style={dropStyle}>
        <option value="current">Current</option>
        {sourceOptions.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
        <option value="alltime">All-Time</option>
      </select>
    )
  }
  const characterErrors = allFielding?.errorsByCharacter?.[character.name] || 0
  const talentAnalysis = analyzeCharacterTalent(character, battingHistory)
  const effectiveIntrinsics = characterIntrinsics || talentAnalysis?.intrinsics || buildCharacterIntrinsics(character)
  const classAccent = getCharacterClassAccent(effectiveIntrinsics?.characterClass)
  const chemistrySummary = chemBreakdown(character.name, rosterNames)
  const tierMeta = getTalentTierMeta(talentAnalysis?.tier)
  const tierBadgeStyle = getTierBadgeStyle(talentAnalysis?.tier)

  // Compute real medians from all characters in the pool
  const statMedians = useMemo(() => {
    const chars = Object.values(allCharactersById).filter(Boolean)
    if (chars.length < 2) return null
    const all = chars.map((c) => {
      const intr = buildCharacterIntrinsics(c)
      const analysis = analyzeCharacterTalent(c, [])
      return { intr, analysis }
    })
    const pick = (fn) => calcMedian(all.map(fn))
    return {
      offense:       Math.round(pick((x) => x.analysis?.categoryScores?.offense)),
      defense:       Math.round(pick((x) => x.analysis?.categoryScores?.defense)),
      pitching:      Math.round(pick((x) => x.analysis?.categoryScores?.pitching)),
      speed:         Math.round(pick((x) => x.analysis?.categoryScores?.speed)),
      powerScore:    Math.round(pick((x) => x.intr?.powerScore)),
      contactScore:  Math.round(pick((x) => x.intr?.contactScore)),
      velocityIndex: Math.round(pick((x) => x.intr?.velocityIndex)),
      breakIndex:    Math.round(pick((x) => x.intr?.breakIndex)),
      stamina:       Math.round(pick((x) => x.intr?.stamina)),
      power: Math.round(pick((x) => x.analysis?.rawMetrics?.batting?.power) ?? 0),
      contact: Math.round(pick((x) => x.analysis?.rawMetrics?.batting?.contact) ?? 0),
      plateCoverage: Math.round(pick((x) => x.analysis?.rawMetrics?.batting?.plateCoverage)),
      contactPerfectWindow: Math.round(pick((x) => x.analysis?.rawMetrics?.batting?.contactPerfectWindow)),
      baserunning: Math.round(pick((x) => x.analysis?.rawMetrics?.batting?.baserunning) ?? 0),
      baserunningAbilityBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.batting?.bonuses?.baserunningAbilityBonus) ?? 0),
      powerCeilingBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.batting?.bonuses?.powerCeilingBonus) ?? 0),
      starSwingBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.batting?.bonuses?.starSwingBonus) ?? 0),
      velocity: Math.round(pick((x) => x.analysis?.rawMetrics?.pitching?.velocity) ?? 0),
      curve: Math.round(pick((x) => x.analysis?.rawMetrics?.pitching?.curve)),
      staminaMetric: Math.round(pick((x) => x.analysis?.rawMetrics?.pitching?.stamina)),
      starPitchBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.pitching?.bonuses?.starPitchBonus) ?? 0),
      catchCoverage: Math.round(pick((x) => x.analysis?.rawMetrics?.fielding?.catchCoverage)),
      fieldingMetric: Math.round(pick((x) => x.analysis?.rawMetrics?.fielding?.fielding)),
      armStrength: Math.round(pick((x) => x.analysis?.rawMetrics?.fielding?.armStrength)),
      mobility: Math.round(pick((x) => x.analysis?.rawMetrics?.fielding?.mobility)),
      baseDefense: Math.round(pick((x) => x.analysis?.rawMetrics?.fielding?.baseDefense)),
      speedRangeBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.fielding?.bonuses?.speedRangeBonus) ?? 0),
      fieldDefenseBonus: Math.round(pick((x) => x.analysis?.categoryBreakdown?.fielding?.bonuses?.fieldDefenseBonus) ?? 0),
    }
  }, [allCharactersById])

  const statMaxes = useMemo(() => {
    const chars = Object.values(allCharactersById).filter(Boolean)
    if (chars.length < 2) return null
    const all = chars.map((c) => analyzeCharacterTalent(c, [])).filter(Boolean)
    const pickMax = (fn, fallback = 100) => {
      const values = all.map(fn).filter(Number.isFinite)
      return values.length ? Math.max(...values) : fallback
    }
    return {
      offense: Math.round(pickMax((x) => x.categoryScores?.offense, 100)),
      defense: Math.round(pickMax((x) => x.categoryScores?.defense, 100)),
      pitching: Math.round(pickMax((x) => x.categoryScores?.pitching, 100)),
      speed: Math.round(pickMax((x) => x.categoryScores?.speed, 100)),
      power: Math.round(pickMax((x) => x.rawMetrics?.batting?.power, 100)),
      contact: Math.round(pickMax((x) => x.rawMetrics?.batting?.contact, 100)),
      plateCoverage: Math.round(pickMax((x) => x.rawMetrics?.batting?.plateCoverage, 100)),
      contactPerfectWindow: Math.round(pickMax((x) => x.rawMetrics?.batting?.contactPerfectWindow, 100)),
      baserunning: Math.round(pickMax((x) => x.rawMetrics?.batting?.baserunning, 100)),
      velocity: Math.round(pickMax((x) => x.rawMetrics?.pitching?.velocity, 100)),
      curve: Math.round(pickMax((x) => x.rawMetrics?.pitching?.curve, 100)),
      staminaMetric: Math.round(pickMax((x) => x.rawMetrics?.pitching?.stamina, 100)),
      velocityIndex: Math.round(pickMax((x) => x.intrinsics?.velocityIndex, 160)),
      breakIndex: Math.round(pickMax((x) => x.intrinsics?.breakIndex, 100)),
      stamina: Math.round(pickMax((x) => x.intrinsics?.stamina, 100)),
      catchCoverage: Math.round(pickMax((x) => x.rawMetrics?.fielding?.catchCoverage, 100)),
      fieldingMetric: Math.round(pickMax((x) => x.rawMetrics?.fielding?.fielding, 100)),
      armStrength: Math.round(pickMax((x) => x.rawMetrics?.fielding?.armStrength, 100)),
      mobility: Math.round(pickMax((x) => x.rawMetrics?.fielding?.mobility, 100)),
      baseDefense: Math.round(pickMax((x) => x.rawMetrics?.fielding?.baseDefense, 100)),
    }
  }, [allCharactersById])

  const statMins = useMemo(() => {
    const chars = Object.values(allCharactersById).filter(Boolean)
    if (chars.length < 2) return null
    const all = chars.map((c) => analyzeCharacterTalent(c, [])).filter(Boolean)
    const pickMin = (fn, fallback = 0) => {
      const values = all.map(fn).filter(Number.isFinite)
      return values.length ? Math.min(...values) : fallback
    }
    return {
      offense: Math.round(pickMin((x) => x.categoryScores?.offense, 0)),
      defense: Math.round(pickMin((x) => x.categoryScores?.defense, 0)),
      pitching: Math.round(pickMin((x) => x.categoryScores?.pitching, 0)),
      speed: Math.round(pickMin((x) => x.categoryScores?.speed, 0)),
      power: Math.round(pickMin((x) => x.rawMetrics?.batting?.power, 0)),
      contact: Math.round(pickMin((x) => x.rawMetrics?.batting?.contact, 0)),
      plateCoverage: Math.round(pickMin((x) => x.rawMetrics?.batting?.plateCoverage, 0)),
      contactPerfectWindow: Math.round(pickMin((x) => x.rawMetrics?.batting?.contactPerfectWindow, 0)),
      baserunning: Math.round(pickMin((x) => x.rawMetrics?.batting?.baserunning, 0)),
      velocity: Math.round(pickMin((x) => x.rawMetrics?.pitching?.velocity, 0)),
      curve: Math.round(pickMin((x) => x.rawMetrics?.pitching?.curve, 0)),
      staminaMetric: Math.round(pickMin((x) => x.rawMetrics?.pitching?.stamina, 0)),
      velocityIndex: Math.round(pickMin((x) => x.intrinsics?.velocityIndex, 0)),
      breakIndex: Math.round(pickMin((x) => x.intrinsics?.breakIndex, 0)),
      stamina: Math.round(pickMin((x) => x.intrinsics?.stamina, 0)),
      catchCoverage: Math.round(pickMin((x) => x.rawMetrics?.fielding?.catchCoverage, 0)),
      fieldingMetric: Math.round(pickMin((x) => x.rawMetrics?.fielding?.fielding, 0)),
      armStrength: Math.round(pickMin((x) => x.rawMetrics?.fielding?.armStrength, 0)),
      mobility: Math.round(pickMin((x) => x.rawMetrics?.fielding?.mobility, 0)),
      baseDefense: Math.round(pickMin((x) => x.rawMetrics?.fielding?.baseDefense, 0)),
    }
  }, [allCharactersById])

  const pitchingRating = character.pitchingRating ?? character.pitching ?? '-'
  const battingRating = character.battingRating ?? character.batting ?? '-'
  const fieldingRating = character.fieldingRating ?? character.fielding ?? '-'
  const speedRating = character.speedRating ?? character.speed ?? '-'

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'stats', label: 'Stats' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'chemistry', label: 'Chemistry' },
    { id: 'gamelog', label: 'Gamelog' },
  ]

  // ─── Overview tab ─────────────────────────────────────────────────────────

  function renderOverview() {
    const battingSkillItems = talentAnalysis ? [
      { key: 'power', label: 'Power', value: talentAnalysis.rawMetrics?.batting?.power, min: statMins?.power ?? 0, median: statMedians?.power ?? 50, digits: 1, max: statMaxes?.power ?? 100, description: 'Normalized power input. Built mostly from charge power, with slap power and contact support mixed in.' },
      { key: 'contact', label: 'Contact', value: talentAnalysis.rawMetrics?.batting?.contact, min: statMins?.contact ?? 0, median: statMedians?.contact ?? 50, digits: 1, max: statMaxes?.contact ?? 100, description: 'Composite contact score from charge/slap contact rates, perfect window, and forgiveness.' },
      { key: 'plateCoverage', label: 'Plate Coverage', value: talentAnalysis.rawMetrics?.batting?.plateCoverage, min: statMins?.plateCoverage ?? 0, median: statMedians?.plateCoverage ?? 50, max: statMaxes?.plateCoverage ?? 100, description: 'Coverage of the hitting zone, built from batter-location limits and hit-zone dimensions.' },
      { key: 'contactPerfectWindow', label: 'Contact Window', value: talentAnalysis.rawMetrics?.batting?.contactPerfectWindow, min: statMins?.contactPerfectWindow ?? 0, median: statMedians?.contactPerfectWindow ?? 50, max: statMaxes?.contactPerfectWindow ?? 100, description: 'Timing forgiveness from the contact windows.' },
      { key: 'baserunning', label: 'Baserunning', value: talentAnalysis.rawMetrics?.batting?.baserunning, min: statMins?.baserunning ?? 0, median: statMedians?.baserunning ?? 50, digits: 1, max: statMaxes?.baserunning ?? 100, description: 'Mobility converted into batting-side baserunning value.' },
      { key: 'baserunningAbilityBonus', label: 'Baserunning Ability Bonus', value: talentAnalysis.categoryBreakdown?.batting?.bonuses?.baserunningAbilityBonus, min: -20, median: 0, digits: 1, max: 20, description: 'Flat offensive bonus from the baserunning ability trait.' },
      { key: 'powerCeilingBonus', label: 'Power Ceiling Bonus', value: talentAnalysis.categoryBreakdown?.batting?.bonuses?.powerCeilingBonus, min: 0, median: 0, digits: 2, max: 6, description: 'Small bonus added for elite charge-power sluggers.' },
      { key: 'starSwingBonus', label: 'Star Swing Bonus', value: talentAnalysis.categoryBreakdown?.batting?.bonuses?.starSwingBonus, min: 0, median: 0, digits: 0, max: 10, description: 'Flat bonus applied for stronger star-swing ability classes.' },
    ] : []
    const pitchingSkillItems = talentAnalysis ? [
      { key: 'velocity', label: 'Velocity', value: talentAnalysis.rawMetrics?.pitching?.velocity, min: statMins?.velocity ?? 0, median: statMedians?.velocity ?? 50, digits: 1, max: statMaxes?.velocity ?? 100, description: 'Normalized pitch-speed input. Calculated from fastball speed (65%) and curveball speed (35%).' },
      { key: 'curve', label: 'Curve', value: talentAnalysis.rawMetrics?.pitching?.curve, min: statMins?.curve ?? 0, median: statMedians?.curve ?? 50, max: statMaxes?.curve ?? 100, description: 'Normalized break input from the raw curve stat.' },
      { key: 'staminaMetric', label: 'Stamina', value: talentAnalysis.rawMetrics?.pitching?.stamina, min: statMins?.staminaMetric ?? 0, median: statMedians?.staminaMetric ?? 50, max: statMaxes?.staminaMetric ?? 100, description: 'Normalized stamina contribution to the pitching score.' },
      { key: 'starPitchBonus', label: 'Star Pitch Bonus', value: talentAnalysis.categoryBreakdown?.pitching?.bonuses?.starPitchBonus, min: 0, median: 0, digits: 0, max: 10, description: 'Flat pitching bonus from the star-pitch ability class.' },
      { key: 'velocityIndex', label: 'Velocity Index', value: effectiveIntrinsics.velocityIndex, min: statMins?.velocityIndex ?? 0, median: statMedians?.velocityIndex ?? 80, max: statMaxes?.velocityIndex ?? 160, description: 'Raw blended speed index before normalization.' },
      { key: 'breakIndex', label: 'Break Index', value: effectiveIntrinsics.breakIndex, min: statMins?.breakIndex ?? 0, median: statMedians?.breakIndex ?? 50, max: statMaxes?.breakIndex ?? 100, description: 'Raw break index before normalization.' },
      { key: 'staminaRaw', label: 'Raw Stamina', value: effectiveIntrinsics.stamina, min: statMins?.stamina ?? 0, median: statMedians?.stamina ?? 50, max: statMaxes?.stamina ?? 100, description: 'Raw stamina before normalization.' },
    ] : []
    const fieldingSkillItems = talentAnalysis ? [
      { key: 'catchCoverage', label: 'Catch Coverage', value: talentAnalysis.rawMetrics?.fielding?.catchCoverage, min: statMins?.catchCoverage ?? 0, median: statMedians?.catchCoverage ?? 50, max: statMaxes?.catchCoverage ?? 100, description: 'Normalized catch radius from regular catch, dive catch, height, and jump width.' },
      { key: 'fieldingMetric', label: 'Fielding', value: talentAnalysis.rawMetrics?.fielding?.fielding, min: statMins?.fieldingMetric ?? 0, median: statMedians?.fieldingMetric ?? 50, max: statMaxes?.fieldingMetric ?? 100, description: 'Normalized raw fielding stat contribution.' },
      { key: 'armStrength', label: 'Arm Strength', value: talentAnalysis.rawMetrics?.fielding?.armStrength, min: statMins?.armStrength ?? 0, median: statMedians?.armStrength ?? 50, max: statMaxes?.armStrength ?? 100, description: 'Normalized throwing-speed contribution.' },
      { key: 'mobility', label: 'Mobility', value: talentAnalysis.rawMetrics?.fielding?.mobility, min: statMins?.mobility ?? 0, median: statMedians?.mobility ?? 50, max: statMaxes?.mobility ?? 100, description: 'Normalized movement speed used in both fielding and speed formulas.' },
      { key: 'baseDefense', label: 'Base Defense', value: talentAnalysis.rawMetrics?.fielding?.baseDefense, min: statMins?.baseDefense ?? 0, median: statMedians?.baseDefense ?? 50, max: statMaxes?.baseDefense ?? 100, description: 'Core fielding score before speed-range and trait bonuses.' },
      { key: 'speedRangeBonus', label: 'Speed Range Bonus', value: talentAnalysis.categoryBreakdown?.fielding?.bonuses?.speedRangeBonus, min: -5, median: 0, digits: 2, max: 5, description: 'Small defense bonus or penalty created by mobility relative to average.' },
      { key: 'fieldDefenseBonus', label: 'Fielding Ability Bonus', value: talentAnalysis.categoryBreakdown?.fielding?.bonuses?.fieldDefenseBonus, min: 0, median: 0, digits: 0, max: 10, description: 'Flat defensive bonus from the fielding ability trait.' },
    ] : []
    const speedSkillItems = []
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        {talentAnalysis ? (
          <div style={{ background: '#1E2E44', borderRadius: 12, padding: isNarrowViewport ? '0.75rem 0.85rem' : '0.85rem 1rem' }}>
            <SectionHeader>Role OVR</SectionHeader>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { label: 'Bat OVR',   displayValue: talentAnalysis.displayRatings.batting,  tier: talentAnalysis.battingTier,  sub: talentAnalysis.historyScore !== null ? `${toDisplayRating(talentAnalysis.historyScore)} (${talentAnalysis.historyTournaments}t)` : null, subLabel: 'History' },
                { label: 'Pitch OVR', displayValue: talentAnalysis.displayRatings.pitching, tier: talentAnalysis.pitchingTier, sub: talentAnalysis.historyScore !== null ? `${toDisplayRating(talentAnalysis.historyScore)} (${talentAnalysis.historyTournaments}t, ½ wt)` : null, subLabel: 'History' },
                { label: 'Field OVR', displayValue: talentAnalysis.displayRatings.fielding, tier: talentAnalysis.fieldingTier, sub: null, subLabel: null },
                { label: 'Speed OVR', displayValue: talentAnalysis.displayRatings.speed,    tier: talentAnalysis.speedTier,    sub: null, subLabel: null },
              ].map(({ label, displayValue, tier, sub, subLabel }) => {
                const ts = getTierBadgeStyle(tier)
                return (
                <div key={label} style={{ borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', padding: '0.6rem 0.75rem' }}>
                  <div style={{ color: '#94A3B8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#F8FAFC', lineHeight: 1 }}>{displayValue}</div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: ts.color }}>{getTalentTierMeta(tier).label}</span>
                  </div>
                  {sub !== null && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: '#64748B', fontSize: 11 }}>{subLabel}: <span style={{ color: '#94A3B8', fontWeight: 600 }}>{sub}</span></span>
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {talentAnalysis ? (
          <div>
            <SectionHeader>Skill Profile</SectionHeader>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <SkillSectionCard title="Batting" score={talentAnalysis.displayRatings.batting} scoreMin={statMins?.offense ?? 0} scoreMedian={statMedians?.offense ?? 50} scoreMax={statMaxes?.offense ?? 100} items={battingSkillItems} />
              <SkillSectionCard title="Pitching" score={talentAnalysis.displayRatings.pitching} scoreMin={statMins?.pitching ?? 0} scoreMedian={statMedians?.pitching ?? 50} scoreMax={statMaxes?.pitching ?? 100} items={pitchingSkillItems} />
              <SkillSectionCard title="Fielding" score={talentAnalysis.displayRatings.fielding} scoreMin={statMins?.defense ?? 0} scoreMedian={statMedians?.defense ?? 50} scoreMax={statMaxes?.defense ?? 100} items={fieldingSkillItems} />
              <SkillSectionCard title="Speed" score={talentAnalysis.displayRatings.speed} scoreMin={statMins?.mobility ?? 0} scoreMedian={statMedians?.mobility ?? 50} scoreMax={statMaxes?.mobility ?? 100} items={speedSkillItems} />
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  // ─── Stats tab ────────────────────────────────────────────────────────────

  function renderStats() {
    const dropStyle = {
      background: '#1E293B', border: '1px solid #334155', borderRadius: 8,
      color: '#E2E8F0', padding: '4px 8px', fontSize: 12, cursor: 'pointer',
    }

    const pitchingEmpty = isPitchingAllZero(showPitching)
    const battingGames = showBatting.games || 0

    function SubLabel({ children, games }) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
          <span style={{ color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em' }}>{children}</span>
          {games > 0 && (
            <span style={{ fontSize: 10, color: '#475569', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999, padding: '0.1rem 0.4rem', fontWeight: 700 }}>
              {games} games
            </span>
          )}
        </div>
      )
    }

    const renderBattingStats = () => (
      <div>
        <SubLabel games={battingGames}>Hitting</SubLabel>
        <StatRow stats={[
          { label: 'PA', value: formatInteger(showBatting.plateAppearances) },
          { label: 'AB', value: formatInteger(showBatting.atBats) },
          { label: 'H', value: formatInteger(showBatting.hits) },
          { label: 'R', value: formatInteger(showBatting.runs) },
          { label: 'RBI', value: formatInteger(showBatting.rbi) },
          { label: 'HR', value: formatInteger(showBatting.homeRuns) },
          { label: '2B', value: formatInteger(showBatting.doubles) },
          { label: '3B', value: formatInteger(showBatting.triples) },
          { label: 'BB', value: formatInteger(showBatting.walks) },
          { label: 'HBP', value: formatInteger(showBatting.hbp) },
          { label: 'SO', value: formatInteger(showBatting.strikeouts) },
          { label: 'TB', value: formatInteger(showBatting.totalBases) },
          { label: 'AVG', value: formatDecimal(showBatting.avg) },
          { label: 'OBP', value: formatDecimal(showBatting.obp) },
          { label: 'SLG', value: formatDecimal(showBatting.slg) },
          { label: 'OPS', value: formatDecimal(showBatting.ops) },
        ]} />
      </div>
    )

    const renderPitchingStats = () => (
      <div>
        {pitchingEmpty ? (
          <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No pitching appearances in this view.</p>
        ) : (
          <>
            <SubLabel games={showPitching.games || 0}>Pitching</SubLabel>
            <StatRow stats={[
              { label: 'IP', value: formatDecimal(showPitching.innings, 1) },
              { label: 'W', value: formatInteger(showPitching.wins) },
              { label: 'L', value: formatInteger(showPitching.losses) },
              { label: 'SV', value: formatInteger(showPitching.saves) },
              { label: 'CG', value: formatInteger(showPitching.completeGames) },
              { label: 'SHO', value: formatInteger(showPitching.shutouts) },
              { label: 'K', value: formatInteger(showPitching.strikeouts) },
              { label: 'H', value: formatInteger(showPitching.hitsAllowed) },
              { label: 'R', value: formatInteger(showPitching.runsAllowed) },
              { label: 'ER', value: formatInteger(showPitching.earnedRuns) },
              { label: 'BB', value: formatInteger(showPitching.walks) },
              { label: 'HR', value: formatInteger(showPitching.homeRunsAllowed) },
              { label: 'ERA/3', value: formatDecimal(showPitching.era, 2) },
              { label: 'WHIP', value: formatDecimal(showPitching.whip, 2) },
              { label: 'K/3', value: formatDecimal(showPitching.kPer3, 2) },
              { label: 'HR/3', value: formatDecimal(showPitching.hrPer3, 2) },
            ]} />
          </>
        )}
      </div>
    )

    const renderFieldingStats = () => (
      <div>
        <SubLabel>Fielding</SubLabel>
        <StatRow stats={[
          { label: 'Errors', value: formatInteger(characterErrors) },
        ]} />
      </div>
    )

    return (
      <div style={{ display: 'grid', gap: 20 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={statsStatType} onChange={(e) => setStatsStatType(e.target.value)} style={dropStyle}>
            <option value="batting">Hitting</option>
            <option value="pitching">Pitching</option>
            <option value="fielding">Fielding</option>
          </select>
          {renderSourceSelector()}
        </div>
        {statsStatType === 'batting' && renderBattingStats()}
        {statsStatType === 'pitching' && renderPitchingStats()}
        {statsStatType === 'fielding' && renderFieldingStats()}
      </div>
    )
  }

  // ─── Advanced tab ─────────────────────────────────────────────────────────

  function renderAdvanced() {
    const dropStyle = {
      background: '#1E293B', border: '1px solid #334155', borderRadius: 8,
      color: '#E2E8F0', padding: '4px 8px', fontSize: 12, cursor: 'pointer', alignSelf: 'start',
    }

    const starHitEmpty = (starHitStats.used || 0) === 0
    const battedBallEmpty = allZeroPct(battingBattedBall.ldRate, battingBattedBall.gbRate, battingBattedBall.fbRate, battingBattedBall.bloopRate)
    const sprayEmpty = allZeroPct(battingSpray.pullRate, battingSpray.centerRate, battingSpray.oppoRate) && (battingDiscipline.pitchesPerPa || 0) === 0
    const pitchFieldEmpty = allZeroPct(pitchingStar.successRate, pitchingMix.strikeRate, pitchingMix.firstPitchStrikeRate, pitchingMix.swingingMissRate) && characterErrors === 0

    const sections = [
      { key: 'starHit', label: 'Star Hit', empty: starHitEmpty },
      { key: 'battedBall', label: 'Batted Ball', empty: battedBallEmpty },
      { key: 'sprayDiscipline', label: 'Spray & Discipline', empty: sprayEmpty },
      { key: 'pitchingFielding', label: 'Pitching & Fielding', empty: pitchFieldEmpty },
    ]

    const noData = <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No data recorded yet</p>

    const renderSection = () => {
      if (advancedSection === 'starHit') {
        return starHitEmpty ? noData : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            <SmallChip label="Used" value={formatInteger(starHitStats.used)} accent="#EAB308" />
            <SmallChip label="Contact %" value={`${(starHitStats.contactRate * 100).toFixed(0)}%`} accent="#22C55E" />
            <SmallChip label="Success %" value={`${(starHitStats.successRate * 100).toFixed(0)}%`} accent="#3B82F6" />
            <SmallChip label="RBI/Use" value={formatDecimal(starHitStats.avgRbiPerUse, 2)} />
          </div>
        )
      }
      if (advancedSection === 'battedBall') {
        return battedBallEmpty ? noData : (
          <BattedBallBar
            ldRate={battingBattedBall.ldRate}
            gbRate={battingBattedBall.gbRate}
            fbRate={battingBattedBall.fbRate}
            bloopRate={battingBattedBall.bloopRate}
          />
        )
      }
      if (advancedSection === 'sprayDiscipline') {
        return sprayEmpty ? noData : (
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
        )
      }
      if (advancedSection === 'pitchingFielding') {
        return pitchFieldEmpty ? noData : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            <SmallChip label="Star Pitch %" value={`${(pitchingStar.successRate * 100).toFixed(0)}%`} accent="#EAB308" />
            <SmallChip label="Strike %" value={`${(pitchingMix.strikeRate * 100).toFixed(0)}%`} accent="#22C55E" />
            <SmallChip label="1st Str %" value={`${(pitchingMix.firstPitchStrikeRate * 100).toFixed(0)}%`} accent="#3B82F6" />
            <SmallChip label="Whiff %" value={`${(pitchingMix.swingingMissRate * 100).toFixed(0)}%`} accent="#EF4444" />
            <SmallChip label="Allowed LD%" value={`${(pitchingBattedBall.ldRate * 100).toFixed(0)}%`} />
            <SmallChip label="Allowed Pull%" value={`${(pitchingSpray.pullRate * 100).toFixed(0)}%`} />
            <SmallChip label="Errors" value={formatInteger(characterErrors)} accent="#EF4444" />
            <SmallChip label="Star Used" value={formatInteger(pitchingStar.used)} accent="#EAB308" />
          </div>
        )
      }
      return null
    }

    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={advancedSection} onChange={(e) => setAdvancedSection(e.target.value)} style={{ ...dropStyle, alignSelf: 'start' }}>
            {sections.map((s) => (
              <option key={s.key} value={s.key}>{s.label}{s.empty ? ' (no data)' : ''}</option>
            ))}
          </select>
          {renderSourceSelector({ alignSelf: 'start' })}
        </div>
        {renderSection()}
      </div>
    )
  }

  // ─── Chemistry tab ────────────────────────────────────────────────────────

  function renderChemistry() {
    function ChemChip({ name, tintColor }) {
      const onRoster = isChemistryNameOnRoster(name, rosterNames)
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '0.28rem 0.55rem',
          border: `1px solid ${onRoster ? `${tintColor}99` : `${tintColor}33`}`,
          borderRadius: 999,
          background: onRoster ? `${tintColor}20` : 'transparent',
        }}>
          <CharacterPortrait name={name} size={20} />
          <span style={{ fontSize: 12, fontWeight: 600, color: '#F8FAFC' }}>{allCharactersById[name]?.name || name}</span>
        </div>
      )
    }

    return (
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chemistry.good.map((name) => <ChemChip key={name} name={name} tintColor="#22C55E" />)}
            </div>
          ) : (
            <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No good chemistry</span>
          )}
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#EF4444', marginBottom: 7 }}>Bad</div>
          {chemistry.bad.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chemistry.bad.map((name) => <ChemChip key={name} name={name} tintColor="#EF4444" />)}
            </div>
          ) : (
            <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No bad chemistry</span>
          )}
        </div>
      </div>
    )
  }

  // ─── Gamelog tab ──────────────────────────────────────────────────────────

  function renderGamelog() {
    const dropStyle = {
      background: '#1E293B', border: '1px solid #334155', borderRadius: 8,
      color: '#E2E8F0', padding: '4px 8px', fontSize: 12, cursor: 'pointer',
    }

    const rawPasBatting = showBatting.rawPas || []
    const rawStintsPitching = showPitching.rawStints || []
    const hasBatting = rawPasBatting.length > 0
    const hasPitching = rawStintsPitching.length > 0

    if (!hasBatting && !hasPitching) {
      return (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <SectionHeader>Game Log</SectionHeader>
            {renderSourceSelector()}
          </div>
          <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>
            No game data available for this source.
          </p>
        </div>
      )
    }

    const effectiveStatType = (gamelogStatType === 'pitching' && !hasPitching) ? 'batting'
      : (gamelogStatType === 'batting' && !hasBatting) ? 'pitching'
      : gamelogStatType

    const renderBattingLog = () => {
      if (!hasBatting) return <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No hitting data for this source.</p>
      const rawPas = rawPasBatting
      const gameOrder = []
      const gameMap = {}
      for (const pa of rawPas) {
        const gid = String(pa.game_id ?? 'unknown')
        if (!gameMap[gid]) { gameMap[gid] = []; gameOrder.push(gid) }
        gameMap[gid].push(pa)
      }
      const gameRows = gameOrder.map((gid, i) => {
        const pas = gameMap[gid]
        const s = summarizeBatting(pas)
        s.ops = s.obp + s.slg
        return { gameNum: i + 1, gid, ...s }
      })
      const totals = summarizeBatting(rawPas)
      totals.ops = totals.obp + totals.slg

      return (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 440 }}>
            <thead>
              <tr>
                <th>Game</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>R</th><th>BB</th><th>K</th><th>AVG</th><th>OPS</th>
              </tr>
            </thead>
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

    const renderPitchingLog = () => {
      if (!hasPitching) return <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No pitching appearances recorded.</p>
      const byGame = {}
      const gameOrder = []
      rawStintsPitching.forEach((stint) => {
        const gid = String(stint.game_id ?? 'unknown')
        if (!byGame[gid]) {
          byGame[gid] = []
          gameOrder.push(gid)
        }
        byGame[gid].push(stint)
      })
      const gameRows = gameOrder.map((gid, index) => ({
        gid,
        gameNum: index + 1,
        ...summarizePitching(byGame[gid]),
      }))
      const totals = summarizePitching(rawStintsPitching)
      if (gameRows.length === 0) return <p style={{ color: '#475569', fontSize: 13, fontStyle: 'italic', margin: 0 }}>No pitching appearances recorded.</p>
      return (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>Game</th><th>IP</th><th>W</th><th>L</th><th>SV</th><th>K</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>HR</th><th>ERA/3</th><th>WHIP</th>
              </tr>
            </thead>
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
                <td>{formatInteger(totals.wins)}</td>
                <td>{formatInteger(totals.losses)}</td>
                <td>{formatInteger(totals.saves)}</td>
                <td>{formatInteger(totals.strikeouts)}</td>
                <td>{formatInteger(totals.hitsAllowed)}</td>
                <td>{formatInteger(totals.runsAllowed)}</td>
                <td>{formatInteger(totals.earnedRuns)}</td>
                <td>{formatInteger(totals.walks)}</td>
                <td>{formatInteger(totals.homeRunsAllowed)}</td>
                <td>{formatDecimal(totals.era, 2)}</td>
                <td>{formatDecimal(totals.whip, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )
    }

    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SectionHeader>Game Log</SectionHeader>
          <select
            value={effectiveStatType}
            onChange={(e) => setGamelogStatType(e.target.value)}
            style={dropStyle}
          >
            {hasBatting && <option value="batting">Hitting</option>}
            {hasPitching && <option value="pitching">Pitching</option>}
          </select>
          {renderSourceSelector()}
        </div>

        {effectiveStatType === 'batting' ? renderBattingLog() : renderPitchingLog()}
      </div>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 960, width: '100%', maxHeight: isNarrowViewport ? '92vh' : '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: isNarrowViewport ? '0.85rem 0.85rem 0' : '1.25rem 1.25rem 0', gap: 0, position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: isNarrowViewport ? 10 : 12, paddingBottom: isNarrowViewport ? '0.75rem' : '1rem', flexShrink: 0, paddingRight: isNarrowViewport ? 30 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isNarrowViewport ? 10 : 14, minWidth: 0, flex: 1 }}>
            <div style={{ width: isNarrowViewport ? 52 : 64, height: isNarrowViewport ? 52 : 64, borderRadius: '50%', overflow: 'hidden', border: '2px solid #EAB308', flexShrink: 0 }}>
              <CharacterPortrait name={character.name} size={isNarrowViewport ? 52 : 64} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: isNarrowViewport ? 18 : 22, fontWeight: 800, lineHeight: 1.1, paddingRight: isNarrowViewport ? 6 : 0 }}>{character.name}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: isNarrowViewport ? 6 : 8, marginTop: 5, flexWrap: 'wrap' }}>
                {currentOwner ? (
                  <PlayerTag height={22} identitiesByPlayerId={identitiesByPlayerId} playerId={currentOwner.player_id} playersById={playersById} />
                ) : (
                  <span style={{ color: '#64748B', fontSize: 12 }}>Undrafted</span>
                )}
                {talentAnalysis && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <span style={{
                      fontSize: isNarrowViewport ? 10 : 11, fontWeight: 800, padding: isNarrowViewport ? '0.13rem 0.42rem' : '0.15rem 0.5rem', borderRadius: 999,
                      background: tierBadgeStyle.bg, border: `1px solid ${tierBadgeStyle.border}`, color: tierBadgeStyle.color,
                      letterSpacing: '.03em', textTransform: 'uppercase',
                    }}>
                      {tierMeta.label}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Base 1-10 ratings card */}
          <div style={{
            display: 'flex', gap: isNarrowViewport ? 4 : 6, alignItems: 'center', flexShrink: 0,
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 10, padding: isNarrowViewport ? '0.35rem 0.45rem' : '0.45rem 0.7rem',
          }}>
            {[
              { stat: 'batting',  value: battingRating },
              { stat: 'pitching', value: pitchingRating },
              { stat: 'fielding', value: fieldingRating },
              { stat: 'speed',    value: speedRating },
            ].map(({ stat, value }, i) => (
              <div key={stat} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: isNarrowViewport ? 26 : 34, ...(i > 0 ? { borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: isNarrowViewport ? 4 : 6 } : {}) }}>
                <StatIcon stat={stat} size={isNarrowViewport ? 11 : 13} style={{ opacity: 0.6 }} />
                <span style={{ color: '#F8FAFC', fontSize: isNarrowViewport ? 15 : 18, fontWeight: 800, lineHeight: 1.2, marginTop: 2 }}>{value}</span>
              </div>
            ))}
          </div>

          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', flexShrink: 0, padding: '0.25rem', position: isNarrowViewport ? 'absolute' : 'static', top: isNarrowViewport ? 10 : undefined, right: isNarrowViewport ? 10 : undefined, zIndex: 2 }}>
            <X size={isNarrowViewport ? 18 : 20} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(255,255,255,0.08)', overflowX: 'auto', flexShrink: 0 }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: isNarrowViewport ? '0.55rem 0.7rem' : '0.6rem 1rem', fontSize: isNarrowViewport ? 12 : 13, fontWeight: isActive ? 700 : 500,
                  color: isActive ? '#EAB308' : '#64748B',
                  borderBottom: isActive ? '2px solid #EAB308' : '2px solid transparent',
                  marginBottom: -1, whiteSpace: 'nowrap',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Tab content */}
        <div style={{ overflowY: 'auto', minHeight: 0, padding: isNarrowViewport ? '0.85rem 0.1rem 1rem 0' : '1rem 0.4rem 1.25rem 0', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}>
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'stats' && renderStats()}
          {activeTab === 'advanced' && renderAdvanced()}
          {activeTab === 'chemistry' && renderChemistry()}
          {activeTab === 'gamelog' && renderGamelog()}
        </div>
      </div>
    </div>
  )
}
