import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Gauge } from 'lucide-react'
import { supabase } from '../supabaseClient'
import {
  buildCharacterIntrinsics,
  filterRunEventsForCharacter,
  hasPitchingStatLine,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizeBattedBallTypeProfile,
  summarizeBattingSplits,
  summarizePitching,
  summarizePitchingSplits,
  summarizePlateDiscipline,
  summarizeSprayContactProfile,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
  summarizeValueBatting,
  POSITION_CODES,
  POSITION_LABELS,
} from '../utils/statsCalculator'
import { analyzeCharacterTalent, getTalentTierMeta } from '../utils/characterAnalysis'
import {
  calculateHitPowerIndex,
  calculateParkAdjustedDistance,
  summarizeContactQuality,
  summarizeExitVelocity,
  summarizeHitDistance,
  wouldBeHrElsewhere,
} from '../utils/hitDistanceStats'
import { summarizeExpectedBatting, summarizeExpectedPitching } from '../utils/expectedStats'
import { MIN_RANGE_CHANCES } from '../utils/fieldingRange'
import { buildScopeOptions, getHistoryEntryLabel, sortHistoryEntries } from '../utils/characterScopes'
import { selectPitchesForPlateAppearances } from '../utils/statReconciliation'
import useCharacterProfileData from '../hooks/useCharacterProfileData'
import useCharacterMetaFallback from '../hooks/useCharacterMeta'
import useCharacterExtras from '../hooks/useCharacterExtras'
import useLoggedInRosterNames from '../hooks/useLoggedInRosterNames'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import PlayerTag from '../components/PlayerTag'
import TeamLogo from '../components/TeamLogo'
import EntityPageSidebar from '../components/EntityPageSidebar'
import StatTable from '../components/StatTable'
import StatLabel from '../components/StatLabel'
import StatFallbackLegend from '../components/StatFallbackLegend'
import AdvancedStatsPanel from '../components/AdvancedStatsPanel'
import { chemBreakdown, getChemistry, isChemistryNameOnRoster } from '../data/chemistry'
import { getTeamShortName, getTeamAbbreviation, buildSeasonTeamIdentity, buildPlayerTeamIdentity } from '../utils/teamIdentity'
import { buildScorebookPath } from '../utils/scorebookRouting'
import '../styles/stats-pages.css'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}
function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : '-'
}
function formatPercent(value, digits = 0, fallback = '-') {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : fallback
}

function selectPitchesForPas(pitches = [], plateAppearances = []) {
  return selectPitchesForPlateAppearances(pitches, plateAppearances)
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

function isPitchingAllZero(p) {
  return !hasPitchingStatLine(p)
}
function allZeroPct(...rates) {
  return rates.every((r) => !r || r === 0)
}

// A season/tournament-scoped entry (battingHistory/pitchingHistory row) "belongs" to the current
// route scope when its type+id match — battingHistory rows carry eventType/eventId, pitchingHistory
// rows carry sourceType/tournamentId|seasonId, so both shapes are checked.
function matchesScope(entry, scope) {
  if (!scope || scope.type === 'career') return true
  const entryType = entry.eventType || entry.sourceType
  const entryId = entry.eventId ?? entry.tournamentId ?? entry.seasonId
  return entryType === scope.type && String(entryId) === String(scope.id)
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

function StarIcon({ size = 12 }) {
  return <img src="/Star.png" alt="Star" style={{ height: size, width: size, verticalAlign: 'middle', display: 'inline-block' }} />
}

function TeamHistoryChip({ row }) {
  const name = getTeamShortName(row.identity) || row.playerName || 'Unknown'
  return (
    <Link
      to={`/teams/${row.playerId}/${row.eventType}/${row.eventId}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
        color: '#93C5FD', textDecoration: 'none', padding: '0.15rem 0.55rem 0.15rem 0.3rem', borderRadius: 999,
        background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
      }}
    >
      <TeamLogo height={18} logoKey={row.identity?.teamLogoKey} logoUrl={row.identity?.teamLogoUrl} teamName={name} placeholder={false} />
      {name}
      <span style={{ color: '#64748B', fontWeight: 500 }}>({row.eventLabel})</span>
    </Link>
  )
}

// Shared switch for any section that would otherwise show multiple views stacked. Defaults to
// Batting/Pitching but accepts an arbitrary `options` list (e.g. Stars Against also has Fielding).
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

// Pos/G/GS/TC/PO/A/E/FLD%/BJ table — shared by the "Standard Stats > Fielding" view and the
// standalone "Fielding" section so both render the same fieldingByPosition data identically.
function FieldingPositionTable({ appearances, allTimeFielding }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: 480 }}>
        <thead><tr><th>Pos</th><th>G</th><th>GS</th><th>TC</th><th>PO</th><th>A</th><th>E</th><th><StatLabel label="FLD%" /></th><th><StatLabel label="BJ" /></th><th><StatLabel label="NP" /></th><th><StatLabel label="NP%" /></th></tr></thead>
        <tbody>
          {appearances.positions.map((row) => (
            <tr key={row.position}>
              <td>{row.position}</td>
              <td>{row.games}</td>
              <td>{row.gamesStarted}</td>
              <td>{row.chances}</td>
              <td>{row.putouts}</td>
              <td>{row.assists}</td>
              <td>{row.errors}</td>
              <td>{formatDecimal(row.fieldingPct)}</td>
              <td>{row.buddyJumps}</td>
              <td>{row.nicePlays}</td>
              <td>{formatPercent(row.chances ? row.nicePlays / row.chances : null, 1)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
            <td style={{ color: '#94A3B8', fontWeight: 700 }}>Total</td>
            <td>{appearances.totalGames}</td>
            <td>{appearances.positions.reduce((sum, r) => sum + r.gamesStarted, 0)}</td>
            <td>{appearances.positions.reduce((sum, r) => sum + r.chances, 0)}</td>
            <td>{appearances.positions.reduce((sum, r) => sum + r.putouts, 0)}</td>
            <td>{appearances.positions.reduce((sum, r) => sum + r.assists, 0)}</td>
            <td>{appearances.positions.reduce((sum, r) => sum + r.errors, 0)}</td>
            <td>{formatDecimal(allTimeFielding?.fieldingPct)}</td>
            <td>{allTimeFielding?.buddyJumps ?? appearances.positions.reduce((sum, r) => sum + r.buddyJumps, 0)}</td>
            <td>{allTimeFielding?.nicePlays ?? appearances.positions.reduce((sum, r) => sum + r.nicePlays, 0)}</td>
            <td>{(() => {
              const totalChances = appearances.positions.reduce((sum, r) => sum + r.chances, 0)
              const totalNicePlays = allTimeFielding?.nicePlays ?? appearances.positions.reduce((sum, r) => sum + r.nicePlays, 0)
              return formatPercent(totalChances ? totalNicePlays / totalChances : null, 1)
            })()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// Range Runs table — how many more/fewer outs a fielder converted than expected given how hard
// each chance was to reach, vs. the league's out rate for plays of similar difficulty at that
// position (see fieldingRange.js). Difficulty itself is graded per-chance into a confidence tier
// (timed > measured > distance-only, see computeDifficultySignal) depending on what data that
// particular play has — Confidence is the chances-weighted blend of those tiers, so a low
// Confidence% just means most of that position's sample is still distance-only estimates, not
// that the Range Runs number is wrong. Only positions with enough rangeable chances (this
// character as the FIRST fielder to touch the ball, with at least one difficulty signal
// available) show a number — everything else reads "—" for small sample size.
function FieldingRangeTable({ fieldingRangeByPosition }) {
  const qualifying = fieldingRangeByPosition.positions.filter((row) => row.qualifies)
  if (!qualifying.length) return null
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: 480 }}>
        <thead><tr><th>Pos</th><th><StatLabel label="Chances" /></th><th><StatLabel label="Actual Outs" /></th><th><StatLabel label="Expected Outs" /></th><th><StatLabel label="Range Runs" /></th><th><StatLabel label="Range+" /></th><th><StatLabel label="Confidence" /></th></tr></thead>
        <tbody>
          {fieldingRangeByPosition.positions.map((row) => (
            <tr key={row.position}>
              <td>{POSITION_LABELS[Number(row.position)] || row.position}</td>
              <td>{row.chances}</td>
              <td>{row.qualifies ? row.actualConversions : '--'}</td>
              <td>{row.qualifies ? row.expectedConversions : '--'}</td>
              <td>{row.qualifies && row.rangeRuns != null ? (row.rangeRuns > 0 ? `+${row.rangeRuns}` : row.rangeRuns) : '--'}</td>
              <td>{row.qualifies && row.rangeFactorPlus != null ? row.rangeFactorPlus : '--'}</td>
              <td>{row.qualifies && row.confidence != null ? `${row.confidence}%` : '--'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <StatFallbackLegend note={`Range stats need at least ${MIN_RANGE_CHANCES} rangeable chances at a position.`} />
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

const SECTION_LINKS = [
  { id: 'stats', label: 'Standard Stats' },
  { id: 'value', label: 'Value Batting' },
  { id: 'advanced-stats', label: 'Advanced Stats' },
  { id: 'stars-used', label: 'Stars Used' },
  { id: 'stars-against', label: 'Stars Against' },
  { id: 'batted-ball', label: 'Batted Ball' },
  { id: 'batted-ball-allowed', label: 'Batted Ball Allowed' },
  { id: 'power', label: 'Contact Authority' },
  { id: 'postseason', label: 'Postseason' },
  { id: 'fielding', label: 'Fielding' },
  { id: 'splits', label: 'Splits' },
  { id: 'park-factors', label: 'Park Factors' },
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

const BACK_TO_STORAGE_PREFIX = 'sluggers-character-back:'

export default function CharacterPage() {
  const { id, seasonId, tournamentId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const presetState = location.state || null
  const hasPreset = Boolean(presetState?.character)

  // The "true" originating page (Stats, Roster, Scorebook, etc.) is only present in router state
  // on the initial navigation into this character — clicking a sidebar Career/Season/Tournament
  // link re-navigates within this same character with no state, so it's persisted to
  // sessionStorage (keyed by character id) the first time it's seen, and Back always targets it
  // instead of `navigate(-1)`, which would otherwise just step back through those in-page clicks.
  useEffect(() => {
    if (presetState?.backTo && id) {
      sessionStorage.setItem(`${BACK_TO_STORAGE_PREFIX}${id}`, presetState.backTo)
    }
  }, [id, presetState?.backTo])

  const handleBack = () => {
    const storedBackTo = id ? sessionStorage.getItem(`${BACK_TO_STORAGE_PREFIX}${id}`) : null
    if (storedBackTo) navigate(storedBackTo)
    else navigate(-1)
  }

  const fallbackMeta = useCharacterMetaFallback(id, hasPreset)
  const meta = hasPreset ? presetState : fallbackMeta

  const character = meta?.character || null
  const allCharactersById = meta?.allCharactersById || {}
  const playersById = meta?.playersById || {}
  const identitiesByPlayerId = meta?.identitiesByPlayerId || {}
  const currentOwner = meta?.currentOwner || null
  const totalDrafts = meta?.totalDrafts || 0
  const tournamentsDrafted = meta?.tournamentsDrafted || 0
  const championshipsWon = meta?.championshipsWon || 0
  const characterIntrinsics = meta?.characterIntrinsics || null

  // The route itself is the scope selector — career (no id) shows all-time totals, a season or
  // tournament id shows just that one event. Replaces the old dropdown + ambiguous location.state
  // "currentContext" combo, so scope survives a page refresh / direct link.
  const scope = useMemo(() => {
    if (seasonId) return { type: 'season', id: seasonId }
    if (tournamentId) return { type: 'tournament', id: tournamentId }
    return { type: 'career' }
  }, [seasonId, tournamentId])
  const isCareer = scope.type === 'career'
  // Year-by-year tables' first column ("Season") is only useful on the Career page — a page
  // already scoped to one season/tournament would just repeat the same label on every row.
  const seasonColumn = isCareer ? [{ key: 'label', label: 'Season' }] : []

  // Chemistry highlighting is scoped to the *logged-in* player's own roster, not this
  // character's — see useLoggedInRosterNames for why. Empty when logged out.
  const rosterNames = useLoggedInRosterNames(scope)

  const profileData = useCharacterProfileData(character, isCareer ? null : scope, presetState?.profileData || {})
  const extras = useCharacterExtras(character, isCareer ? null : scope)
  const {
    fieldingHistory, allTimeFielding, fieldingByPosition, fieldingHistoryByPosition,
    starHitFieldingHistoryByPosition, fieldingRangeByPosition, parkFactorRows, teamHistory, transactions, awardRows, statMedians, statMaxes, statMins,
    advancedFielding, advancedBaserunning, advancedValueByEventKey,
  } = extras

  const [gamelogStatType, setGamelogStatType] = useState('batting')
  const [standardStatsView, setStandardStatsView] = useState('batting')
  const [postseasonView, setPostseasonView] = useState('batting')
  const [splitsView, setSplitsView] = useState('batting')
  const [starsUsedView, setStarsUsedView] = useState('batting')
  const [starsAgainstView, setStarsAgainstView] = useState('batting')
  const [parkFactorsView, setParkFactorsView] = useState('batting')

  const {
    currentTournamentBatting, currentTournamentPitching, allTimeBatting, allTimePitching,
    allPitches, battingHistory, pitchingHistory, gameHistory, pitchingGameHistory,
    fieldingGameHistory, expectedOutcomeModel, leagueConstants, leagueBattingPas = [], runEvents = [],
    errorMessage: profileErrorMessage = '',
    tournamentIdByGameId = {},
    playersById: gamelogPlayersById = {}, seasonTeamsById = {},
  } = profileData
  const leagueBattingPasByEventKey = useMemo(() => {
    const byEvent = new Map()
    leagueBattingPas.forEach((pa) => {
      const eventKey = pa.season_id != null
        ? `season:${pa.season_id}`
        : tournamentIdByGameId[String(pa.game_id)] != null
          ? `tournament:${tournamentIdByGameId[String(pa.game_id)]}`
          : null
      if (!eventKey) return
      if (!byEvent.has(eventKey)) byEvent.set(eventKey, [])
      byEvent.get(eventKey).push(pa)
    })
    return byEvent
  }, [leagueBattingPas, tournamentIdByGameId])

  if (!id) return null

  // meta === null means the identity fetch is still in flight; meta with a null character means it
  // came back and this id isn't a character. Collapsing the two left an unknown/deleted id sitting
  // on "Loading character…" forever with no way to tell it apart from a slow load.
  if (!character) {
    const isStillLoading = meta === null
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <button type="button" onClick={handleBack} style={BACK_BUTTON_STYLE}>
          <ArrowLeft size={16} /> Back
        </button>
        {isStillLoading ? (
          <section className="panel entity-status-panel">
            <h1 className="entity-status-title">Loading character…</h1>
            <div className="entity-status-progress" />
          </section>
        ) : (
          <section className="panel entity-status-panel entity-status-error">
            <h1 className="entity-status-title">Character not found</h1>
            <p className="entity-status-body">
              No character matches id <strong>{id}</strong>. It may have been removed, or the link may be out of date.
            </p>
            <div className="entity-status-actions">
              <button className="entity-status-button entity-status-button-primary" onClick={handleBack} type="button">Go back</button>
              <Link className="entity-status-button" to="/stats">Browse all characters</Link>
            </div>
          </section>
        )}
      </div>
    )
  }

  const chemistry = getChemistry(character.name)

  const showBatting = isCareer ? allTimeBatting : currentTournamentBatting
  const showPitching = isCareer ? allTimePitching : currentTournamentPitching
  const showBattingPitches = selectPitchesForPas(allPitches, showBatting.rawPas || [])
  const showPitchingPitches = selectPitchesForPas(allPitches, showPitching.rawPas || [])

  const starHitStats = summarizeStarHits(showBatting.rawPas || [])
  const battingBattedBall = summarizeBattedBallProfile(showBatting.rawPas || [])
  const battingSpray = summarizeSprayProfile(showBatting.rawPas || [])
  const battingDiscipline = summarizePlateDiscipline(showBatting.rawPas || [], showBattingPitches)
  const pitchingStar = summarizeStarPitching(showPitching.rawPas || [], showPitchingPitches)
  const battingDistance = summarizeHitDistance(showBatting.rawPas || [])
  const battingExitVelo = summarizeExitVelocity(showBatting.rawPas || [])
  const battingContactQuality = summarizeContactQuality(showBatting.rawPas || [])

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

  const teamLabel = (playerId) => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || 'Unknown'

  // ─── Sidebar: Career + one link per season/tournament this character has data in ──────────
  const scopeOptions = buildScopeOptions(battingHistory, pitchingHistory, fieldingHistory)
  const scopeLinks = [
    { to: `/character/${id}/career`, label: 'Career' },
    ...scopeOptions.map((opt) => ({ to: `/character/${id}/${opt.type}/${opt.id}`, label: opt.label })),
  ]

  // ─── Year-by-year Standard Batting/Pitching tables ─────────────────────────
  const allBattingTableRows = battingHistory
    .map((entry) => {
      const rawPas = entry.rawPas || []
      const computed = summarizeBatting(rawPas, filterRunEventsForCharacter(runEvents, character.id, rawPas))
      computed.ops = computed.obp + computed.slg
      return { eventKey: entry.eventKey, eventId: entry.eventId, eventType: entry.eventType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue, ...computed }
    })
    .sort(sortHistoryEntries)
  const battingTableRows = isCareer ? allBattingTableRows : allBattingTableRows.filter((row) => matchesScope(row, scope))
  const battingCareerRow = isCareer ? { label: 'Career', ...allTimeBatting } : null

  const allPitchingTableRows = pitchingHistory
    .filter((entry) => (entry.innings || 0) > 0)
    .map((entry) => ({ ...entry, eventType: entry.sourceType, label: getHistoryEntryLabel(entry) }))
    .sort(sortHistoryEntries)
  const pitchingTableRows = isCareer ? allPitchingTableRows : allPitchingTableRows.filter((row) => matchesScope(row, scope))
  const pitchingCareerRow = isCareer ? { label: 'Career', ...allTimePitching } : null

  // Baseball-Reference-style bold: this character led the whole season/tournament in that stat
  // that year. awardRows already carries per-event rank/led for the same 8 stats (HR/RBI/AVG/OPS,
  // W/SV/K/ERA) via rankStatWithinEvent (awardsAndHonors.js) — reused here rather than re-ranking.
  const awardsByEventAndStat = new Map(awardRows.map((row) => [`${row.eventKey}:${row.stat}`, row]))
  const ledStat = (statLabel) => (row) => Boolean(awardsByEventAndStat.get(`${row.eventKey}:${statLabel}`)?.led)
  const awardBadgeForRow = (row) => {
    const matches = awardRows.filter((r) => r.eventKey === row.eventKey)
    if (!matches.length) return null
    return matches.map((r) => (r.led ? r.stat : `${r.stat}-${r.rank}`)).join(',')
  }

  const battingColumns = [
    ...seasonColumn,
    { key: 'plateAppearances', label: 'PA' },
    { key: 'atBats', label: 'AB' },
    { key: 'runs', label: 'R' },
    { key: 'hits', label: 'H' },
    { key: 'doubles', label: '2B' },
    { key: 'triples', label: '3B' },
    { key: 'homeRuns', label: 'HR', bold: ledStat('HR'), award: awardBadgeForRow },
    { key: 'rbi', label: 'RBI', bold: ledStat('RBI') },
    { key: 'walks', label: 'BB' },
    { key: 'strikeouts', label: 'SO' },
    { key: 'avg', label: 'AVG', render: (r) => formatDecimal(r.avg), bold: ledStat('AVG') },
    { key: 'obp', label: 'OBP', render: (r) => formatDecimal(r.obp) },
    { key: 'slg', label: 'SLG', render: (r) => formatDecimal(r.slg) },
    { key: 'ops', label: 'OPS', render: (r) => formatDecimal(r.ops), bold: ledStat('OPS') },
  ]
  const pitchingColumns = [
    ...seasonColumn,
    { key: 'games', label: 'G' },
    { key: 'innings', label: 'IP', render: (r) => formatDecimal(r.innings, 1) },
    { key: 'wins', label: 'W', bold: ledStat('W'), award: awardBadgeForRow },
    { key: 'losses', label: 'L' },
    { key: 'saves', label: 'SV', bold: ledStat('SV') },
    { key: 'strikeouts', label: 'K', bold: ledStat('K') },
    { key: 'hitsAllowed', label: 'H' },
    { key: 'runsAllowed', label: 'R' },
    { key: 'earnedRuns', label: 'ER' },
    { key: 'walks', label: 'BB' },
    { key: 'homeRunsAllowed', label: 'HR' },
    { key: 'era', label: 'ERA/3', render: (r) => r.innings > 0 ? formatDecimal(r.era, 2) : '-', bold: ledStat('ERA') },
    { key: 'whip', label: 'WHIP', render: (r) => r.innings > 0 ? formatDecimal(r.whip, 2) : '-' },
  ]


  // ─── Value Batting (simplified WAR) ────────────────────────────────────────
  const fieldingByEventKey = new Map(fieldingHistory.map((entry) => [entry.eventKey, entry]))
  const appearances = fieldingByPosition
  const primaryPositionCode = appearances.positions[0] ? POSITION_CODES[appearances.positions[0].position] : null

  // ─── Year-by-year fielding, broken out by position (Baseball-Reference style) ──────────────
  // One row per position per event, so the row key has to include the position — eventKey alone
  // repeats for a character who played several spots in the same season.
  const fieldingHistoryRows = fieldingHistoryByPosition
    .map((entry) => ({ ...entry, label: getHistoryEntryLabel(entry), rowKey: `${entry.eventKey || `${entry.eventType}:${entry.eventId}`}:${entry.position}` }))
    .filter((row) => isCareer || matchesScope(row, scope))
    .sort(sortHistoryEntries)
  const fieldingHistoryColumns = [
    ...seasonColumn,
    { key: 'position', label: 'Pos' },
    { key: 'games', label: 'G' },
    { key: 'gamesStarted', label: 'GS' },
    { key: 'chances', label: 'TC' },
    { key: 'putouts', label: 'PO' },
    { key: 'assists', label: 'A' },
    { key: 'errors', label: 'E' },
    { key: 'fieldingPct', label: 'FLD%', render: (r) => formatDecimal(r.fieldingPct) },
    { key: 'buddyJumps', label: 'BJ' },
    { key: 'nicePlays', label: 'NP' },
  ]

  const starHitFieldingHistoryRows = starHitFieldingHistoryByPosition
    .map((entry) => ({ ...entry, label: getHistoryEntryLabel(entry), rowKey: `${entry.eventKey || `${entry.eventType}:${entry.eventId}`}:${entry.position}` }))
    .filter((row) => isCareer || matchesScope(row, scope))
    .sort(sortHistoryEntries)
  const starHitFieldingHistoryColumns = [
    ...seasonColumn,
    { key: 'position', label: 'Pos' },
    { key: 'chances', label: 'TC' },
    { key: 'errors', label: 'E' },
    { key: 'fieldingPct', label: 'FLD%', render: (r) => formatDecimal(r.fieldingPct) },
  ]
  const battingHistoryForScope = isCareer ? battingHistory : battingHistory.filter((row) => matchesScope(row, scope))
  // Value Batting (simplified WAR) combined with Expected Stats — both are per-event summaries
  // of the same battingHistoryForScope rawPas, so they share one Season-row table.
  const valueBattingRows = battingHistoryForScope
    .map((entry) => {
      const fieldingForEvent = fieldingByEventKey.get(entry.eventKey)
      const advancedForEvent = advancedValueByEventKey?.[entry.eventKey]
      const vb = summarizeValueBatting(entry.rawPas || [], leagueConstants, {
        chances: fieldingForEvent?.chances || 0,
        errors: fieldingForEvent?.errors || 0,
        position: primaryPositionCode,
        fieldingRuns: advancedForEvent?.fieldingRuns ?? null,
        baserunningRuns: advancedForEvent?.baserunningRuns ?? null,
      })
      const xb = expectedRowFor(entry.rawPas || [])
      return { eventKey: entry.eventKey, eventId: entry.eventId, eventType: entry.eventType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue, ...vb, ...xb }
    })
    .sort(sortHistoryEntries)
  // fieldingRangeByPosition is a career-scoped total (see useCharacterExtras.js), so its Range
  // Runs number can only stand in for Rfield on the career row below — the season/tournament rows
  // above have no per-event Range Runs breakdown yet and keep the error-rate-only fallback.
  const valueBattingCareerRow = isCareer ? {
    label: 'Career',
    ...summarizeValueBatting(allTimeBatting.rawPas || [], leagueConstants, {
      chances: allTimeFielding?.chances || 0,
      errors: allTimeFielding?.errors || 0,
      position: primaryPositionCode,
      rangeRuns: fieldingRangeByPosition?.qualifies ? fieldingRangeByPosition.totalRangeRuns : null,
      fieldingRuns: advancedFielding && (advancedFielding.fieldingOpportunities || advancedFielding.armOpportunities || advancedFielding.doublePlayOpportunities)
        ? advancedFielding.fieldingRunValue
        : null,
      baserunningRuns: advancedBaserunning?.opportunities ? advancedBaserunning.baserunningRunValue : null,
    }),
    ...expectedRowFor(allTimeBatting.rawPas || []),
  } : null
  const valueBattingColumns = [
    ...seasonColumn,
    { key: 'sampleSize', label: 'BIP', render: (r) => formatInteger(r.sampleSize) },
    { key: 'rbat', label: 'Rbat' },
    { key: 'rbaser', label: 'Rbaser' },
    { key: 'rfield', label: 'Rfield' },
    { key: 'rpos', label: 'Rpos' },
    { key: 'raa', label: 'RAA' },
    { key: 'waa', label: 'WAA' },
    { key: 'rar', label: 'RAR' },
    { key: 'war', label: 'Legacy WAR' },
    { key: 'xBA', label: 'xBA', render: (r) => formatDecimal(r.xBA) },
    { key: 'xSLG', label: 'xSLG', render: (r) => formatDecimal(r.xSLG) },
    { key: 'xwOBA', label: 'xwOBA', render: (r) => formatDecimal(r.xwOBA) },
  ]

  // ─── Per-event breakdowns shared by Advanced Stats / Star Hit / Batted Ball / Power / Star Pitch
  // Every one of these follows the same Season-row + Career-row convention as Standard Stats —
  // built from the same battingHistory/pitchingHistory entries (which already carry rawPas/
  // rawStints per event) rather than only reflecting whatever scope the page happens to be on.
  function battingRowMeta(entry) {
    return { eventKey: entry.eventKey, eventId: entry.eventId, eventType: entry.eventType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue }
  }
  function pitchingRowMeta(entry) {
    const eventId = entry.tournamentId ?? entry.seasonId
    return { eventKey: entry.eventKey ?? `${entry.sourceType}:${eventId}`, eventId, eventType: entry.sourceType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue }
  }

  // Advanced Stats
  const advancedBattingRows = battingHistoryForScope
    .map((entry) => ({ ...battingRowMeta(entry), ...summarizeAdvancedBatting(entry.rawPas || [], leagueConstants) }))
    .sort(sortHistoryEntries)
  const advancedBattingCareerRow = isCareer ? { label: 'Career', ...summarizeAdvancedBatting(allTimeBatting.rawPas || [], leagueConstants) } : null
  const advancedPitchingRows = pitchingTableRows
    .map((entry) => ({
      ...pitchingRowMeta(entry),
      hasInningsPitched: (entry.innings || 0) > 0,
      ...summarizeAdvancedPitching(entry.rawStints || [], leagueConstants, { plateAppearances: entry.rawPas || [] }),
      ...summarizeExpectedPitching(entry.rawPas || [], expectedOutcomeModel),
    }))
    .sort(sortHistoryEntries)
  const advancedPitchingCareerRow = isCareer ? {
    label: 'Career',
    hasInningsPitched: (allTimePitching.innings || 0) > 0,
    ...summarizeAdvancedPitching(allTimePitching.rawStints || [], leagueConstants, { plateAppearances: allTimePitching.rawPas || [] }),
    ...summarizeExpectedPitching(allTimePitching.rawPas || [], expectedOutcomeModel),
  } : null

  // Star Hit (batting) — resultBreakdown/slashLine come along nested on each row from summarizeStarHits
  const starHitRows = battingHistoryForScope
    .map((entry) => ({ ...battingRowMeta(entry), ...summarizeStarHits(entry.rawPas || []) }))
    .filter((row) => (row.used || 0) > 0)
    .sort(sortHistoryEntries)
  const starHitCareerRow = isCareer ? { label: 'Career', ...summarizeStarHits(allTimeBatting.rawPas || []) } : null

  // Batted Ball (trajectory + spray + plate discipline) — nested per-group to avoid key collisions
  // between summarizeBattedBallProfile/summarizeSprayProfile (both return a `total` field).
  function battedBallRowFor(pas, pitches) {
    return {
      battedBall: summarizeBattedBallProfile(pas),
      spray: summarizeSprayProfile(pas),
      discipline: summarizePlateDiscipline(pas, pitches),
      byType: summarizeBattedBallTypeProfile(pas),
    }
  }
  const battedBallRows = battingHistoryForScope
    .map((entry) => ({ ...battingRowMeta(entry), ...battedBallRowFor(entry.rawPas || [], selectPitchesForPas(allPitches, entry.rawPas || [])) }))
    .sort(sortHistoryEntries)
  const battedBallCareerRow = isCareer ? { label: 'Career', ...battedBallRowFor(allTimeBatting.rawPas || [], selectPitchesForPas(allPitches, allTimeBatting.rawPas || [])) } : null

  // Contact Authority
  // Plain computation, not useMemo — this runs after the `if (!character) return` above, so a
  // hook here would be called on some renders (once character data loads) but not others (the
  // initial loading render), violating the Rules of Hooks and crashing the whole page.
  const scopedBattingPas = battingHistoryForScope.flatMap((entry) => entry.rawPas || [])
  function powerRowFor(pas, comparisonPas = scopedBattingPas) {
    const distance = summarizeHitDistance(pas)
    const exitVelo = summarizeExitVelocity(pas)
    const contactQuality = summarizeContactQuality(pas)
    const spray = summarizeSprayProfile(pas)
    const sprayContact = summarizeSprayContactProfile(pas)
    const comparisonPool = comparisonPas.length ? comparisonPas : leagueBattingPas
    return {
      distance,
      exitVelo,
      contactQuality,
      spray,
      sprayContact,
      powerIndex: calculateHitPowerIndex(distance),
      parkAdjustedDistance: calculateParkAdjustedDistance(pas, comparisonPool),
    }
  }
  const powerRows = battingHistoryForScope
    .map((entry) => ({
      ...battingRowMeta(entry),
      ...powerRowFor(entry.rawPas || [], leagueBattingPasByEventKey.get(`${entry.eventType}:${entry.eventId}`) || []),
    }))
    .sort(sortHistoryEntries)
  const powerCareerRow = isCareer ? { label: 'Career', ...powerRowFor(allTimeBatting.rawPas || [], leagueBattingPas) } : null

  // Star Pitch (pitching) — pitchingHistory entries (pitchingTableRows) already carry rawPas (the
  // PAs this character faced pitching), which star-pitch/pitch-mix/batted-ball-allowed all key off.
  function starPitchRowFor(pas, pitches) {
    return { star: summarizeStarPitching(pas, pitches) }
  }
  const starPitchRows = pitchingTableRows
    .map((entry) => ({ ...pitchingRowMeta(entry), ...starPitchRowFor(entry.rawPas || [], selectPitchesForPas(allPitches, entry.rawPas || [])) }))
    .filter((row) => (row.star.used || 0) > 0)
    .sort(sortHistoryEntries)
  const starPitchCareerRow = isCareer ? { label: 'Career', ...starPitchRowFor(allTimePitching.rawPas || [], selectPitchesForPas(allPitches, allTimePitching.rawPas || [])) } : null

  // Batted Ball Allowed — same batted-ball/spray/exit-velocity/contact-quality primitives used for
  // this character's own batting authority (Batted Ball / Contact Authority sections above), run
  // over the pitcher's full allowed-PA line instead of just the star-pitch subset Star Pitch covers.
  function battedBallAllowedRowFor(pas) {
    return {
      battedBall: summarizeBattedBallProfile(pas),
      spray: summarizeSprayProfile(pas),
      exitVelo: summarizeExitVelocity(pas),
      contactQuality: summarizeContactQuality(pas),
    }
  }
  const battedBallAllowedRows = pitchingTableRows
    .map((entry) => ({ ...pitchingRowMeta(entry), ...battedBallAllowedRowFor(entry.rawPas || []) }))
    .sort(sortHistoryEntries)
  const battedBallAllowedCareerRow = isCareer ? { label: 'Career', ...battedBallAllowedRowFor(allTimePitching.rawPas || []) } : null
  const battedBallAllowedColumns = [
    ...seasonColumn,
    { key: 'ldRate', label: 'LD%', render: (r) => `${(r.battedBall.ldRate * 100).toFixed(0)}%` },
    { key: 'gbRate', label: 'GB%', render: (r) => `${(r.battedBall.gbRate * 100).toFixed(0)}%` },
    { key: 'fbRate', label: 'FB%', render: (r) => `${(r.battedBall.fbRate * 100).toFixed(0)}%` },
    { key: 'pullRate', label: 'Pull%', render: (r) => `${(r.spray.pullRate * 100).toFixed(0)}%` },
    { key: 'centerRate', label: 'Center%', render: (r) => `${(r.spray.centerRate * 100).toFixed(0)}%` },
    { key: 'oppoRate', label: 'Oppo%', render: (r) => `${(r.spray.oppoRate * 100).toFixed(0)}%` },
    { key: 'avgEvAllowed', label: 'Avg EV Allowed', render: (r) => (r.exitVelo.avgExitVelocity != null ? `${r.exitVelo.avgExitVelocity} mph` : '-') },
    { key: 'barrelRateAllowed', label: 'Barrel% Allowed', render: (r) => formatPercent(r.contactQuality.barrelRate) },
    { key: 'hardHitRateAllowed', label: 'Hard-Hit% Allowed', render: (r) => formatPercent(r.contactQuality.hardHitRate) },
  ]

  // "Stars Against" — the opponent's star ability used against this character. Reuses the exact
  // same primitives as "Stars Used", just fed the other side's PA/pitch set: an opposing batter's
  // Star Hit shows up as summarizeStarHits() over the PAs this character *pitched*, and an
  // opposing pitcher's Star Pitch shows up as summarizeStarPitching() over the PAs this character
  // *batted* (using the pitches from those exact PAs, not the character's whole career pitch log).
  const starHitAgainstRows = pitchingTableRows
    .map((entry) => ({ ...pitchingRowMeta(entry), ...summarizeStarHits(entry.rawPas || []) }))
    .filter((row) => (row.used || 0) > 0)
    .sort(sortHistoryEntries)
  const starHitAgainstCareerRow = isCareer ? { label: 'Career', ...summarizeStarHits(allTimePitching.rawPas || []) } : null
  const starPitchAgainstRows = battingHistoryForScope
    .map((entry) => ({ ...battingRowMeta(entry), ...starPitchRowFor(entry.rawPas || [], selectPitchesForPas(allPitches, entry.rawPas || [])) }))
    .filter((row) => (row.star.used || 0) > 0)
    .sort(sortHistoryEntries)
  const starPitchAgainstCareerRow = isCareer ? { label: 'Career', ...starPitchRowFor(allTimeBatting.rawPas || [], selectPitchesForPas(allPitches, allTimeBatting.rawPas || [])) } : null

  // Expected Stats (xBA/xSLG/xwOBA) — folded into the Value Batting table's columns above.
  function expectedRowFor(pas) {
    const b = summarizeBatting(pas)
    return { avg: b.avg, slg: b.slg, ...summarizeExpectedBatting(pas, expectedOutcomeModel) }
  }

  const starHitColumns = [
    ...seasonColumn,
    { key: 'used', label: 'Used' },
    { key: 'contactRate', label: 'Contact %', render: (r) => `${(r.contactRate * 100).toFixed(0)}%` },
    { key: 'avgRbiPerUse', label: 'RBI/Use', render: (r) => formatDecimal(r.avgRbiPerUse, 2) },
    { key: 'avg', label: 'AVG', render: (r) => formatDecimal(r.slashLine?.avg) },
    { key: 'obp', label: 'OBP', render: (r) => formatDecimal(r.slashLine?.obp) },
    { key: 'slg', label: 'SLG', render: (r) => formatDecimal(r.slashLine?.slg) },
    { key: 'ops', label: 'OPS', render: (r) => formatDecimal(r.slashLine?.ops) },
    { key: 'avgExitVelo', label: 'Avg EV', render: (r) => (r.avgExitVelo != null ? `${r.avgExitVelo} mph` : '-') },
    { key: 'maxExitVelo', label: 'Max EV', render: (r) => (r.maxExitVelo != null ? `${r.maxExitVelo} mph` : '-') },
    { key: 'avgLaunchAngle', label: 'Avg LA', render: (r) => (r.avgLaunchAngle != null ? `${r.avgLaunchAngle}°` : '-') },
    { key: 'dist', label: 'Avg/Max Dist', render: (r) => (r.avgDistance != null ? `${r.avgDistance}/${r.maxDistance} ft` : '-') },
    { key: 'resultSingles', label: '1B', render: (r) => r.resultBreakdown?.['1B'] || 0 },
    { key: 'resultDoubles', label: '2B', render: (r) => r.resultBreakdown?.['2B'] || 0 },
    { key: 'resultTriples', label: '3B', render: (r) => r.resultBreakdown?.['3B'] || 0 },
    { key: 'resultHR', label: 'HR', render: (r) => r.resultBreakdown?.HR || 0 },
    { key: 'resultK', label: 'K', render: (r) => r.resultBreakdown?.K || 0 },
    { key: 'resultBB', label: 'BB', render: (r) => r.resultBreakdown?.BB || 0 },
    { key: 'resultOut', label: 'Out', render: (r) => r.resultBreakdown?.Out || 0 },
    { key: 'resultError', label: 'Error', render: (r) => r.resultBreakdown?.Error || 0 },
  ]
  // Only stats scoped to actual star-pitch usage belong here — general pitch-mix/batted-ball-
  // allowed stats (strike%, whiff%, allowed LD%/pull%) aren't star-specific and live in Advanced
  // Stats / Batted Ball instead.
  const starPitchColumns = [
    ...seasonColumn,
    { key: 'used', label: <><StarIcon /> Used</>, render: (r) => formatInteger(r.star.used) },
    { key: 'paUsed', label: <><StarIcon /> PA</>, render: (r) => formatInteger(r.star.paUsed) },
    { key: 'pitchBalls', label: 'Ball', render: (r) => formatInteger(r.star.pitchBalls) },
    { key: 'pitchStrikes', label: 'Strike', render: (r) => formatInteger(r.star.pitchStrikes) },
    { key: 'oppAvg', label: 'AVG', render: (r) => (r.star.paUsed > 0 ? formatDecimal(r.star.oppSlashLine.avg) : '-') },
    { key: 'oppObp', label: 'OBP', render: (r) => (r.star.paUsed > 0 ? formatDecimal(r.star.oppSlashLine.obp) : '-') },
    { key: 'oppSlg', label: 'SLG', render: (r) => (r.star.paUsed > 0 ? formatDecimal(r.star.oppSlashLine.slg) : '-') },
    { key: 'oppOps', label: 'OPS', render: (r) => (r.star.paUsed > 0 ? formatDecimal(r.star.oppSlashLine.ops) : '-') },
    { key: 'evAllowed', label: 'Avg EV', render: (r) => (r.star.avgExitVeloAllowed != null ? `${r.star.avgExitVeloAllowed} mph` : '-') },
    { key: 'laAllowed', label: 'Avg LA', render: (r) => (r.star.avgLaunchAngleAllowed != null ? `${r.star.avgLaunchAngleAllowed}°` : '-') },
    { key: 'distAllowed', label: 'Avg Dist', render: (r) => (r.star.avgDistanceAllowed != null ? `${r.star.avgDistanceAllowed} ft` : '-') },
    { key: 'resultSingles', label: '1B', render: (r) => r.star.resultBreakdown?.['1B'] || 0 },
    { key: 'resultDoubles', label: '2B', render: (r) => r.star.resultBreakdown?.['2B'] || 0 },
    { key: 'resultTriples', label: '3B', render: (r) => r.star.resultBreakdown?.['3B'] || 0 },
    { key: 'resultHR', label: 'HR', render: (r) => r.star.resultBreakdown?.HR || 0 },
    { key: 'resultK', label: 'K', render: (r) => r.star.resultBreakdown?.K || 0 },
    { key: 'resultBB', label: 'BB', render: (r) => r.star.resultBreakdown?.BB || 0 },
    { key: 'resultOut', label: 'Out', render: (r) => r.star.resultBreakdown?.Out || 0 },
  ]
  const battedBallColumns = [
    ...seasonColumn,
    { key: 'ldRate', label: 'LD%', render: (r) => `${(r.battedBall.ldRate * 100).toFixed(0)}%` },
    { key: 'gbRate', label: 'GB%', render: (r) => `${(r.battedBall.gbRate * 100).toFixed(0)}%` },
    { key: 'fbRate', label: 'FB%', render: (r) => `${(r.battedBall.fbRate * 100).toFixed(0)}%` },
    { key: 'pullRate', label: 'Pull%', render: (r) => `${(r.spray.pullRate * 100).toFixed(0)}%` },
    { key: 'centerRate', label: 'Center%', render: (r) => `${(r.spray.centerRate * 100).toFixed(0)}%` },
    { key: 'oppoRate', label: 'Oppo%', render: (r) => `${(r.spray.oppoRate * 100).toFixed(0)}%` },
    { key: 'pitchesPerPa', label: 'P/PA', render: (r) => formatDecimal(r.discipline.pitchesPerPa, 2) },
    { key: 'whiffRate', label: 'Whiff%', render: (r) => `${(r.discipline.whiffRate * 100).toFixed(0)}%` },
    { key: 'foulRate', label: 'Foul%', render: (r) => `${(r.discipline.foulRate * 100).toFixed(0)}%` },
    { key: 'ksRate', label: 'KS%', render: (r) => `${(r.discipline.ksRate * 100).toFixed(0)}%` },
    { key: 'klRate', label: 'KL%', render: (r) => `${(r.discipline.klRate * 100).toFixed(0)}%` },
    { key: 'gbBabip', label: 'GB BABIP', render: (r) => formatDecimal(r.byType.groundBall.babip) },
    { key: 'ldBabip', label: 'LD BABIP', render: (r) => formatDecimal(r.byType.lineDrive.babip) },
    { key: 'fbBabip', label: 'FB BABIP', render: (r) => formatDecimal(r.byType.flyBall.babip) },
    { key: 'ldWoba', label: 'LD wOBA', render: (r) => formatDecimal(r.byType.lineDrive.wobaOnContact) },
    { key: 'fbWoba', label: 'FB wOBA', render: (r) => formatDecimal(r.byType.flyBall.wobaOnContact) },
  ]
  const powerColumns = [
    ...seasonColumn,
    { key: 'bip', label: 'BIP', render: (r) => formatInteger(r.distance.sampleSize || r.exitVelo.sampleSize || r.contactQuality.sampleSize) },
    { key: 'avgExitVelo', label: 'Avg EV', render: (r) => (r.exitVelo.avgExitVelocity != null ? `${r.exitVelo.avgExitVelocity} mph` : '-') },
    { key: 'maxExitVelo', label: 'Max EV', render: (r) => (r.exitVelo.maxExitVelocity != null ? `${r.exitVelo.maxExitVelocity} mph` : '-') },
    { key: 'avgLaunchAngle', label: 'Avg LA', render: (r) => (r.exitVelo.avgLaunchAngle != null ? `${r.exitVelo.avgLaunchAngle}°` : '-') },
    { key: 'avgDistance', label: 'Avg Dist', render: (r) => (r.distance.avgDistance != null ? `${r.distance.avgDistance} ft` : '-') },
    { key: 'maxDistance', label: 'Longest', render: (r) => (r.distance.maxDistance != null ? `${r.distance.maxDistance} ft` : '-') },
    { key: 'hardHitRateDist', label: 'Hard-Hit% (Dist)', render: (r) => formatPercent(r.distance.hardHitRate) },
    { key: 'parkAdjustedDistance', label: 'Park-Adj Dist', render: (r) => (r.parkAdjustedDistance != null ? `${r.parkAdjustedDistance} ft` : '-') },
    { key: 'powerIndex', label: 'Power Index', render: (r) => formatInteger(r.powerIndex) },
    { key: 'avgSprayAngle', label: 'Spray Angle', render: (r) => (r.spray.avgSprayAngle != null ? `${r.spray.avgSprayAngle}°` : '-') },
    { key: 'barrelRate', label: 'Barrel%', render: (r) => formatPercent(r.contactQuality.barrelRate) },
    { key: 'hardHitRateEv', label: 'Hard-Hit% (EV)', render: (r) => formatPercent(r.contactQuality.hardHitRate) },
    { key: 'sweetSpotRate', label: 'Sweet-Spot%', render: (r) => formatPercent(r.contactQuality.sweetSpotRate) },
    { key: 'pullEv', label: 'Pull EV', render: (r) => (r.sprayContact.pull.avgExitVelocity != null ? `${r.sprayContact.pull.avgExitVelocity} mph` : '-') },
    { key: 'oppoEv', label: 'Oppo EV', render: (r) => (r.sprayContact.oppo.avgExitVelocity != null ? `${r.sprayContact.oppo.avgExitVelocity} mph` : '-') },
    { key: 'pullSlg', label: 'Pull SLG', render: (r) => formatDecimal(r.sprayContact.pull.slgOnContact) },
    { key: 'oppoSlg', label: 'Oppo SLG', render: (r) => formatDecimal(r.sprayContact.oppo.slgOnContact) },
  ]
  // ─── Postseason Batting/Pitching ────────────────────────────────────────────
  function postseasonRowFromEntry(entry) {
    const psPas = (entry.rawPas || []).filter((pa) => pa.isPostseason)
    if (!psPas.length) return null
    const computed = summarizeBatting(psPas, filterRunEventsForCharacter(runEvents, character.id, psPas))
    computed.ops = computed.obp + computed.slg
    return { eventKey: entry.eventKey, eventId: entry.eventId, eventType: entry.eventType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue, ...computed }
  }
  const allPostseasonBattingRows = battingHistory.map(postseasonRowFromEntry).filter(Boolean).sort(sortHistoryEntries)
  const postseasonBattingRows = isCareer ? allPostseasonBattingRows : allPostseasonBattingRows.filter((row) => matchesScope(row, scope))
  const postseasonBattingAllPas = battingHistory.flatMap((entry) => (entry.rawPas || []).filter((pa) => pa.isPostseason))
  const postseasonBattingCareerRow = (isCareer && postseasonBattingAllPas.length) ? (() => {
    const b = summarizeBatting(postseasonBattingAllPas, filterRunEventsForCharacter(runEvents, character.id, postseasonBattingAllPas))
    b.ops = b.obp + b.slg
    return { label: 'Career', ...b }
  })() : null

  function postseasonPitchingRowFromEntry(entry) {
    const psStints = (entry.rawStints || []).filter((s) => s.isPostseason)
    if (!psStints.length) return null
    const computed = summarizePitching(psStints)
    const eventId = entry.tournamentId ?? entry.seasonId
    return { eventKey: entry.eventKey ?? `${entry.sourceType}:${eventId}`, eventId, eventType: entry.sourceType, label: getHistoryEntryLabel(entry), sortGroup: entry.sortGroup, sortValue: entry.sortValue, ...computed }
  }
  const allPostseasonPitchingRows = pitchingHistory.map(postseasonPitchingRowFromEntry).filter(Boolean).sort(sortHistoryEntries)
  const postseasonPitchingRows = isCareer ? allPostseasonPitchingRows : allPostseasonPitchingRows.filter((row) => matchesScope(row, scope))
  const postseasonPitchingAllStints = pitchingHistory.flatMap((entry) => (entry.rawStints || []).filter((s) => s.isPostseason))
  const postseasonPitchingCareerRow = (isCareer && postseasonPitchingAllStints.length)
    ? { label: 'Career', ...summarizePitching(postseasonPitchingAllStints) }
    : null
  const hasPostseasonData = postseasonBattingRows.length > 0 || postseasonPitchingRows.length > 0
  const hasPostseasonBatting = postseasonBattingRows.length > 0
  const hasPostseasonPitching = postseasonPitchingRows.length > 0

  // ─── Splits (home/away, regular season vs postseason, vs L/R) ──────────────────────────────
  const battingSplits = summarizeBattingSplits(showBatting.rawPas || [], leagueConstants)
  const pitchingSplits = summarizePitchingSplits(showPitching.rawPas || [], leagueConstants)
  const splitsColumns = [
    { key: 'label', label: 'Split' },
    { key: 'plateAppearances', label: 'PA' },
    { key: 'avg', label: 'AVG', render: (r) => formatDecimal(r.avg) },
    { key: 'obp', label: 'OBP', render: (r) => formatDecimal(r.obp) },
    { key: 'slg', label: 'SLG', render: (r) => formatDecimal(r.slg) },
    { key: 'ops', label: 'OPS', render: (r) => formatDecimal(r.ops) },
    { key: 'woba', label: 'wOBA', render: (r) => formatDecimal(r.woba) },
  ]
  const battingSplitRows = [
    { label: 'Home', eventType: null, ...battingSplits.home },
    { label: 'Away', eventType: null, ...battingSplits.away },
    { label: 'Regular Season', eventType: null, ...battingSplits.regularSeason },
    { label: 'Postseason', eventType: null, ...battingSplits.postseason },
    { label: 'RISP', eventType: null, ...battingSplits.risp },
    { label: 'vs RHP', eventType: null, ...battingSplits.vsRHP },
    { label: 'vs LHP', eventType: null, ...battingSplits.vsLHP },
  ]

  // xwOBA by handedness — same vs-RHP/vs-LHP buckets as battingSplits above, but run through the
  // expected-outcome model instead of actual results, so contact-quality luck (wOBA vs xwOBA) can
  // be compared platoon-split by platoon-split, not just league-wide.
  const battingPasForXwoba = showBatting.rawPas || []
  const xwobaSplitColumns = [
    { key: 'label', label: 'Split' },
    { key: 'sampleSize', label: 'BIP' },
    { key: 'woba', label: 'wOBA', render: (r) => formatDecimal(r.woba) },
    { key: 'xwOBA', label: 'xwOBA', render: (r) => formatDecimal(r.xwOBA) },
  ]
  const xwobaSplitRows = [
    { label: 'vs RHP', woba: battingSplits.vsRHP.woba, ...summarizeExpectedBatting(battingPasForXwoba.filter((pa) => pa.pitcherHandedness === 'R'), expectedOutcomeModel) },
    { label: 'vs LHP', woba: battingSplits.vsLHP.woba, ...summarizeExpectedBatting(battingPasForXwoba.filter((pa) => pa.pitcherHandedness === 'L'), expectedOutcomeModel) },
  ]

  // Park factors describe a STADIUM's own league-wide effect on an outcome (1.00 = neutral), not
  // anything about this character specifically — this table is just filtered to the parks this
  // character has actually played at, same numbers anyone would see for that stadium.
  const battingParkFactorColumns = [
    { key: 'stadiumName', label: 'Stadium' },
    { key: 'hr', label: 'HR', render: (r) => formatDecimal(r.hr, 2) },
    { key: 'r', label: 'Runs', render: (r) => formatDecimal(r.r, 2) },
    { key: 'h', label: 'Hits', render: (r) => formatDecimal(r.h, 2) },
    { key: 'single', label: '1B', render: (r) => formatDecimal(r.single, 2) },
    { key: 'double', label: '2B', render: (r) => formatDecimal(r.double, 2) },
    { key: 'triple', label: '3B', render: (r) => formatDecimal(r.triple, 2) },
    { key: 'walk', label: 'BB', render: (r) => formatDecimal(r.walk, 2) },
    { key: 'hbp', label: 'HBP', render: (r) => formatDecimal(r.hbp, 2) },
    { key: 'sacFly', label: 'SF', render: (r) => formatDecimal(r.sacFly, 2) },
    { key: 'sacHit', label: 'SH', render: (r) => formatDecimal(r.sacHit, 2) },
    { key: 'hardHit', label: 'Hard-Hit', render: (r) => formatDecimal(r.hardHit, 2) },
    { key: 'barrel', label: 'Barrel', render: (r) => formatDecimal(r.barrel, 2) },
  ]
  const pitchingParkFactorColumns = [
    { key: 'stadiumName', label: 'Stadium' },
    { key: 'hr', label: 'HR Allowed', render: (r) => formatDecimal(r.hr, 2) },
    { key: 'r', label: 'R Allowed', render: (r) => formatDecimal(r.r, 2) },
    { key: 'h', label: 'H Allowed', render: (r) => formatDecimal(r.h, 2) },
    { key: 'walk', label: 'BB Allowed', render: (r) => formatDecimal(r.walk, 2) },
    { key: 'strikeout', label: 'K', render: (r) => formatDecimal(r.strikeout, 2) },
    { key: 'hbp', label: 'HBP Allowed', render: (r) => formatDecimal(r.hbp, 2) },
    { key: 'error', label: 'E', render: (r) => formatDecimal(r.error, 2) },
    { key: 'doublePlay', label: 'DP', render: (r) => formatDecimal(r.doublePlay, 2) },
    { key: 'reachedOnError', label: 'ROE', render: (r) => formatDecimal(r.reachedOnError, 2) },
    { key: 'hardHit', label: 'Hard-Hit Allowed', render: (r) => formatDecimal(r.hardHit, 2) },
    { key: 'barrel', label: 'Barrel Allowed', render: (r) => formatDecimal(r.barrel, 2) },
  ]
  const pitchingSplitRows = [
    { label: 'Home', eventType: null, ...pitchingSplits.home },
    { label: 'Away', eventType: null, ...pitchingSplits.away },
    { label: 'Regular Season', eventType: null, ...pitchingSplits.regularSeason },
    { label: 'Postseason', eventType: null, ...pitchingSplits.postseason },
    { label: 'RISP', eventType: null, ...pitchingSplits.risp },
    { label: 'vs RHB', eventType: null, ...pitchingSplits.vsRHB },
    { label: 'vs LHB', eventType: null, ...pitchingSplits.vsLHB },
  ]

  const pitchingEmpty = isPitchingAllZero(showPitching)
  const hasStandardBattingRows = battingTableRows.length > 0
  const hasStandardPitchingRows = !(pitchingEmpty && pitchingTableRows.length === 0)

  const starHitEmpty = (starHitStats.used || 0) === 0
  const battedBallEmpty = allZeroPct(battingBattedBall.ldRate, battingBattedBall.gbRate, battingBattedBall.fbRate, battingBattedBall.bloopRate)
    && allZeroPct(battingSpray.pullRate, battingSpray.centerRate, battingSpray.oppoRate)
    && (battingDiscipline.pitchesPerPa || 0) === 0
  const starPitchEmpty = (pitchingStar.used || 0) === 0 && (pitchingStar.paUsed || 0) === 0
  const powerEmpty = !(
    battingDistance.sampleSize ||
    battingExitVelo.sampleSize ||
    battingContactQuality.sampleSize
  )

  // "Stars Against": the opponent's star ability used against this character — an opposing
  // pitcher's star pitch while this character batted, or an opposing batter's star hit while
  // this character pitched. Same summarizeStarHits/summarizeStarPitching primitives, just fed
  // the other side's PA/pitch set (see starHitAgainstRows/starPitchAgainstRows below).
  const starHitAgainstCurrent = summarizeStarHits(showPitching.rawPas || [])
  const starHitAgainstEmpty = (starHitAgainstCurrent.used || 0) === 0
  const starPitchAgainstCurrent = summarizeStarPitching(showBatting.rawPas || [], showBattingPitches)
  const starPitchAgainstEmpty = (starPitchAgainstCurrent.used || 0) === 0 && (starPitchAgainstCurrent.paUsed || 0) === 0
  const noData = <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No data recorded yet</p>

  const rawPasBatting = showBatting.rawPas || []
  const rawPasPitching = showPitching.rawPas || []
  const rawStintsPitching = showPitching.rawStints || []
  const pitchingPaByGameId = {}
  for (const pa of rawPasPitching) {
    const gid = String(pa.game_id ?? 'unknown')
    if (!pitchingPaByGameId[gid]) pitchingPaByGameId[gid] = pa
  }
  const hasBatting = rawPasBatting.length > 0
  const hasPitching = rawStintsPitching.length > 0

  // Resolves who a game-log row's game was against. `pa.batting_team_id`/`defensive_team_id`
  // and `pa.isHome` (tagged onto every PA in useCharacterProfileData via tagPasWithGameContext)
  // are always from the batting side's perspective, regardless of whether this character batted
  // or pitched in that PA — so when the character pitched, their own side is the defensive one
  // and isHome has to be flipped.
  function opponentInfo(pa, isPitcherPerspective) {
    if (!pa) return null
    const ownTeamId = isPitcherPerspective ? pa.defensive_team_id : pa.batting_team_id
    const oppTeamId = isPitcherPerspective ? pa.batting_team_id : pa.defensive_team_id
    if (oppTeamId == null || pa.isHome == null) return null
    const ownIsHome = isPitcherPerspective ? !pa.isHome : pa.isHome
    const isSeason = pa.season_id != null
    const identity = isSeason
      ? (seasonTeamsById[oppTeamId] ? buildSeasonTeamIdentity(seasonTeamsById[oppTeamId]) : null)
      : (gamelogPlayersById[oppTeamId] ? buildPlayerTeamIdentity(gamelogPlayersById[oppTeamId]) : null)
    const fullName = identity?.teamName
    if (!fullName) return null
    const abbr = getTeamAbbreviation(identity) || fullName
    const prefix = ownIsHome ? 'vs' : 'at'
    return { prefix, fullName, abbr }
  }

  function OpponentCell({ pa, isPitcherPerspective, gameId, source }) {
    const info = opponentInfo(pa, isPitcherPerspective)
    if (!info) return <td style={{ color: '#475569' }}>-</td>
    const label = (
      <>
        <span className="opp-full">{info.prefix} {info.fullName}</span>
        <span className="opp-abbr">{info.prefix} {info.abbr}</span>
      </>
    )
    if (!gameId || gameId === 'unknown') return <td style={{ color: '#CBD5E1' }}>{label}</td>
    const href = buildScorebookPath({ gameId, source, view: 'game' })
    return (
      <td>
        <a
          href={href}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            e.preventDefault()
            navigate(href, { state: { backTo: window.location.pathname + window.location.search } })
          }}
          style={{ color: '#CBD5E1', fontWeight: 600, textDecoration: 'underline' }}
        >
          {label}
        </a>
      </td>
    )
  }

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
      const pas = gameMap[gid]
      const s = summarizeBatting(pas, filterRunEventsForCharacter(runEvents, character.id, pas))
      s.ops = s.obp + s.slg
      const source = pas[0]?.season_id != null ? 'season' : 'tournament'
      return { gameNum: i + 1, gid, source, ...s }
    })
    const totals = summarizeBatting(rawPasBatting, filterRunEventsForCharacter(runEvents, character.id, rawPasBatting))
    totals.ops = totals.obp + totals.slg
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 600 }}>
          <thead><tr><th>Opp</th><th>PA</th><th>AB</th><th>H</th><th>1B</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>R</th><th>BB</th><th>K</th><th><StatLabel label="AVG" /></th><th><StatLabel label="OPS" /></th></tr></thead>
          <tbody>
            {gameRows.map((g, i) => (
              <tr key={g.gid} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                <OpponentCell pa={gameMap[g.gid]?.[0]} isPitcherPerspective={false} gameId={g.gid} source={g.source} />
                <td>{g.plateAppearances}</td><td>{g.atBats}</td><td>{g.hits}</td>
                <td>{g.singles}</td><td>{g.doubles}</td><td>{g.triples}</td><td>{g.homeRuns}</td>
                <td>{g.rbi}</td><td>{g.runs}</td>
                <td>{g.walks}</td><td>{g.strikeouts}</td>
                <td>{formatDecimal(g.avg)}</td><td>{formatDecimal(g.ops)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
              <td style={{ color: '#94A3B8', fontWeight: 700 }}>TOT</td>
              <td>{totals.plateAppearances}</td><td>{totals.atBats}</td><td>{totals.hits}</td>
              <td>{totals.singles}</td><td>{totals.doubles}</td><td>{totals.triples}</td><td>{totals.homeRuns}</td>
              <td>{totals.rbi}</td><td>{totals.runs}</td>
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
    const gameRows = gameOrder.map((gid, index) => {
      const source = byGame[gid][0]?.season_id != null ? 'season' : 'tournament'
      return { gid, gameNum: index + 1, source, ...summarizePitching(byGame[gid]) }
    })
    const totals = summarizePitching(rawStintsPitching)
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 600 }}>
          <thead><tr><th>Opp</th><th>IP</th><th>W</th><th>L</th><th>SV</th><th>K</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>HR</th><th><StatLabel label="ERA/3" /></th><th><StatLabel label="WHIP" /></th></tr></thead>
          <tbody>
            {gameRows.map((game, i) => (
              <tr key={game.gid} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                <OpponentCell pa={pitchingPaByGameId[game.gid]} isPitcherPerspective gameId={game.gid} source={game.source} />
                <td>{formatDecimal(game.innings, 1)}</td>
                <td>{formatInteger(game.wins)}</td><td>{formatInteger(game.losses)}</td>
                <td>{formatInteger(game.saves)}</td><td>{formatInteger(game.strikeouts)}</td>
                <td>{formatInteger(game.hitsAllowed)}</td><td>{formatInteger(game.runsAllowed)}</td>
                <td>{formatInteger(game.earnedRuns)}</td><td>{formatInteger(game.walks)}</td>
                <td>{formatInteger(game.homeRunsAllowed)}</td><td>{game.innings > 0 ? formatDecimal(game.era, 2) : '-'}</td><td>{game.innings > 0 ? formatDecimal(game.whip, 2) : '-'}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700 }}>
              <td style={{ color: '#94A3B8', fontWeight: 700 }}>TOT</td>
              <td>{formatDecimal(totals.innings, 1)}</td>
              <td>{formatInteger(totals.wins)}</td><td>{formatInteger(totals.losses)}</td>
              <td>{formatInteger(totals.saves)}</td><td>{formatInteger(totals.strikeouts)}</td>
              <td>{formatInteger(totals.hitsAllowed)}</td><td>{formatInteger(totals.runsAllowed)}</td>
              <td>{formatInteger(totals.earnedRuns)}</td><td>{formatInteger(totals.walks)}</td>
              <td>{formatInteger(totals.homeRunsAllowed)}</td><td>{totals.innings > 0 ? formatDecimal(totals.era, 2) : '-'}</td><td>{totals.innings > 0 ? formatDecimal(totals.whip, 2) : '-'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  function ChemChip({ name, kind }) {
    const onRoster = isChemistryNameOnRoster(name, rosterNames)
    const accent = kind === 'good' ? '#22C55E' : '#EF4444'
    const border = onRoster ? accent : 'rgba(148,163,184,0.2)'
    const background = onRoster ? `${accent}22` : 'transparent'
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0.28rem 0.55rem', border: `1px solid ${border}`, borderRadius: 999, background }}>
        <CharacterPortrait name={name} size={20} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#F8FAFC' }}>{allCharactersById[name]?.name || name}</span>
      </div>
    )
  }

  const nonHrPas = rawPasBatting.filter((pa) => pa.result !== 'HR' && pa.result !== 'IPHR' && pa.hit_distance_ft != null && pa.hit_angle_deg != null)
  const wouldBeHrCount = nonHrPas.filter((pa) => (wouldBeHrElsewhere(pa)?.clearedCount || 0) > 0).length

  // ─── Scope filtering for awards/transactions (season/tournament pages only) ────────────────
  const scopeMatchedEntry = isCareer ? null : (scopeOptions.find((opt) => opt.type === scope.type && String(opt.id) === String(scope.id)) || null)
  const currentScopeTeamRow = isCareer ? null : (teamHistory.find((row) => row.eventType === scope.type && String(row.eventId) === String(scope.id)) || null)
  const displayedAwardRows = isCareer ? awardRows : awardRows.filter((row) => row.eventKey === `${scope.type}:${scope.id}`)
  const displayedTransactions = isCareer ? transactions : transactions.filter((tx) => scopeMatchedEntry && tx.eventLabel === scopeMatchedEntry.label)

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: 40 }}>
      <button type="button" onClick={handleBack} style={BACK_BUTTON_STYLE}>
        <ArrowLeft size={16} /> Back
      </button>

      {/* The stat fetch can fail independently of the character identity fetch, in which case the
          header still renders but every table below it is empty — say so instead of showing a
          career of zeroes. */}
      {profileErrorMessage ? (
        <div className="entity-stale-banner" role="status">
          <span>Stats couldn&apos;t be loaded: {profileErrorMessage} The tables below are incomplete.</span>
        </div>
      ) : null}

      {/* Header */}
      <section className="panel" style={{ padding: '1.25rem 1.4rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
          <div style={{ width: 76, height: 76, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${classAccent.border}`, flexShrink: 0 }}>
            <CharacterPortrait name={character.name} size={76} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{character.name}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {isCareer ? (
                teamHistory.length > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {teamHistory.map((row) => (
                      <TeamHistoryChip key={`${row.eventType}:${row.eventId}`} row={row} />
                    ))}
                  </div>
                ) : (
                  <span style={{ color: '#64748B', fontSize: 12 }}>Undrafted</span>
                )
              ) : currentScopeTeamRow ? (
                <TeamHistoryChip row={currentScopeTeamRow} />
              ) : currentOwner ? (
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
              {!isCareer && scopeMatchedEntry && (
                <span style={{ color: '#64748B', fontSize: 12, fontWeight: 700 }}>Viewing: {scopeMatchedEntry.label}</span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          <Link
            to={`/character/${id}/${isCareer ? '' : `${scope.type}/${scope.id}/`}scouting`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none',
              background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.4)',
              borderRadius: 10, color: '#93C5FD', padding: '0.5rem 0.8rem', fontSize: 13, fontWeight: 700,
            }}
          >
            <Gauge size={15} /> Scouting Report
          </Link>
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
        </div>
      </section>

      <div className="entity-page-shell">
        <EntityPageSidebar title={character.name} scopeLinks={scopeLinks} sectionLinks={SECTION_LINKS} />

        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {/* Standard Stats */}
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
              {standardStatsView === 'batting' ? (
                hasStandardBattingRows ? <StatTable columns={battingColumns} rows={battingTableRows} careerRow={battingCareerRow} showTypePill={isCareer} /> : noData
              ) : standardStatsView === 'pitching' ? (
                hasStandardPitchingRows ? <StatTable columns={pitchingColumns} rows={pitchingTableRows} careerRow={pitchingCareerRow} showTypePill={isCareer} /> : noData
              ) : (
                fieldingHistoryRows.length === 0 ? noData : <StatTable columns={fieldingHistoryColumns} rows={fieldingHistoryRows} showTypePill={isCareer} />
              )}
            </div>
          </Section>

          {/* Value Batting (simplified WAR) */}
          <Section id="value" title="Value Batting">
            {valueBattingRows.length === 0 ? noData : (
              <StatTable columns={valueBattingColumns} rows={valueBattingRows} careerRow={valueBattingCareerRow} showTypePill={isCareer} />
            )}
          </Section>

          {/* Advanced sabermetrics */}
          <Section id="advanced-stats" title="Advanced Stats">
            <AdvancedStatsPanel
              battingRows={advancedBattingRows}
              battingCareerRow={advancedBattingCareerRow}
              pitchingRows={advancedPitchingRows}
              pitchingCareerRow={advancedPitchingCareerRow}
              hasBatting={hasBatting}
              hasPitching={!pitchingEmpty}
              isCareer={isCareer}
            />
          </Section>

          {/* Stars (star hit batting + star pitch pitching, toggled) */}
          <Section id="stars-used" title="Stars Used">
            <div style={{ display: 'grid', gap: 14 }}>
              <StatTypeToggle
                value={starsUsedView}
                onChange={setStarsUsedView}
                options={[
                  { key: 'batting', label: 'Star Hit (Batting)' },
                  { key: 'pitching', label: 'Star Pitch (Pitching)' },
                ]}
              />
              {starsUsedView === 'batting' ? (
                starHitEmpty ? noData : <StatTable columns={starHitColumns} rows={starHitRows} careerRow={starHitCareerRow} showTypePill={isCareer} />
              ) : (
                starPitchEmpty ? noData : <StatTable columns={starPitchColumns} rows={starPitchRows} careerRow={starPitchCareerRow} showTypePill={isCareer} />
              )}
            </div>
          </Section>

          {/* Opponent's star ability used against this character */}
          <Section id="stars-against" title="Stars Against">
            <div style={{ display: 'grid', gap: 14 }}>
              <StatTypeToggle
                value={starsAgainstView}
                onChange={setStarsAgainstView}
                options={[
                  { key: 'batting', label: 'vs Star Pitch (Batting)' },
                  { key: 'pitching', label: 'vs Star Hit (Pitching)' },
                  { key: 'fielding', label: 'vs Star Hit (Fielding)' },
                ]}
              />
              {starsAgainstView === 'batting' ? (
                starPitchAgainstEmpty ? noData : <StatTable columns={starPitchColumns} rows={starPitchAgainstRows} careerRow={starPitchAgainstCareerRow} showTypePill={isCareer} />
              ) : starsAgainstView === 'pitching' ? (
                starHitAgainstEmpty ? noData : <StatTable columns={starHitColumns} rows={starHitAgainstRows} careerRow={starHitAgainstCareerRow} showTypePill={isCareer} />
              ) : (
                starHitFieldingHistoryRows.length === 0 ? noData : (
                  <StatTable columns={starHitFieldingHistoryColumns} rows={starHitFieldingHistoryRows} showTypePill={isCareer} />
                )
              )}
            </div>
          </Section>

          {/* Batted Ball (trajectory, spray, plate discipline) */}
          <Section id="batted-ball" title="Batted Ball">
            {battedBallEmpty ? noData : (
              <StatTable columns={battedBallColumns} rows={battedBallRows} careerRow={battedBallCareerRow} showTypePill={isCareer} />
            )}
          </Section>

          {/* Batted Ball Allowed */}
          <Section id="batted-ball-allowed" title="Batted Ball Allowed">
            {pitchingEmpty ? noData : (
              <StatTable columns={battedBallAllowedColumns} rows={battedBallAllowedRows} careerRow={battedBallAllowedCareerRow} showTypePill={isCareer} />
            )}
          </Section>

          {/* Contact Authority */}
          <Section id="power" title="Contact Authority">
            {powerEmpty ? noData : (
              <div style={{ display: 'grid', gap: 12 }}>
                <StatTable columns={powerColumns} rows={powerRows} careerRow={powerCareerRow} showTypePill={isCareer} />
                {wouldBeHrCount > 0 ? (
                  <p style={{ color: '#94A3B8', fontSize: 12, margin: 0 }}>
                    {wouldBeHrCount} of {character.name}'s non-homers would have left the yard in at least one other stadium.
                  </p>
                ) : null}
              </div>
            )}
          </Section>

          {/* Postseason */}
          {hasPostseasonData && (
            <Section id="postseason" title="Postseason">
              <div style={{ display: 'grid', gap: 12 }}>
                <StatTypeToggle value={postseasonView} onChange={setPostseasonView} />
                {postseasonView === 'batting' ? (
                  hasPostseasonBatting ? <StatTable columns={battingColumns} rows={postseasonBattingRows} careerRow={postseasonBattingCareerRow} showTypePill={isCareer} /> : noData
                ) : (
                  hasPostseasonPitching ? <StatTable columns={pitchingColumns} rows={postseasonPitchingRows} careerRow={postseasonPitchingCareerRow} showTypePill={isCareer} /> : noData
                )}
              </div>
            </Section>
          )}

          {/* Fielding — games/games-started and fielding performance broken out by position */}
          <Section id="fielding" title="Fielding">
            {appearances.positions.length === 0 ? noData : (
              <div style={{ display: 'grid', gap: 16 }}>
                {fieldingHistoryRows.length > 0 && (
                  <StatTable columns={fieldingHistoryColumns} rows={fieldingHistoryRows} showTypePill={isCareer} />
                )}
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ color: '#94A3B8', fontSize: 12, fontWeight: 700 }}>Career Totals by Position</div>
                  <FieldingPositionTable appearances={appearances} allTimeFielding={allTimeFielding} />
                </div>
                {fieldingRangeByPosition && fieldingRangeByPosition.positions.length > 0 && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ color: '#94A3B8', fontSize: 12, fontWeight: 700 }}>Range Runs</div>
                    <FieldingRangeTable fieldingRangeByPosition={fieldingRangeByPosition} />
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Splits */}
          <Section id="splits" title="Splits">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle value={splitsView} onChange={setSplitsView} />
              {splitsView === 'batting' ? (
                !hasBatting ? noData : (
                  <>
                    <StatTable columns={splitsColumns} rows={battingSplitRows} />
                    {xwobaSplitRows.some((r) => r.sampleSize > 0) && (
                      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                        <div style={{ color: '#94A3B8', fontSize: 12, fontWeight: 700 }}>Expected wOBA by Handedness</div>
                        <StatTable columns={xwobaSplitColumns} rows={xwobaSplitRows} />
                      </div>
                    )}
                  </>
                )
              ) : (
                pitchingEmpty ? noData : <StatTable columns={splitsColumns} rows={pitchingSplitRows} />
              )}
            </div>
          </Section>

          {/* Park Factors */}
          <Section id="park-factors" title="Park Factors">
            <div style={{ display: 'grid', gap: 12 }}>
              <StatTypeToggle value={parkFactorsView} onChange={setParkFactorsView} />
              {parkFactorRows.length === 0
                ? noData
                : (
                  <StatTable
                    columns={parkFactorsView === 'batting' ? battingParkFactorColumns : pitchingParkFactorColumns}
                    rows={parkFactorRows}
                  />
                )}
            </div>
          </Section>

          {/* Awards */}
          <Section id="awards" title="Awards">
            {displayedAwardRows.length === 0 ? noData : (
              <div style={{ display: 'grid', gap: 8 }}>
                {displayedAwardRows.map((row, i) => (
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
            {displayedTransactions.length === 0 ? noData : (
              <div style={{ display: 'grid', gap: 8 }}>
                {displayedTransactions.map((tx, i) => {
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
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{chemistry.good.map((name) => <ChemChip key={name} name={name} kind="good" />)}</div>
                ) : <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No good chemistry</span>}
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#EF4444', marginBottom: 7 }}>Bad</div>
                {chemistry.bad.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{chemistry.bad.map((name) => <ChemChip key={name} name={name} kind="bad" />)}</div>
                ) : <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic' }}>No bad chemistry</span>}
              </div>
            </div>
          </Section>

          {/* Gamelog */}
          <Section id="gamelog" title="Gamelog">
            <div style={{ display: 'grid', gap: 14 }}>
              <select value={gamelogStatType} onChange={(e) => setGamelogStatType(e.target.value)} style={dropStyle}>
                <option value="batting">Hitting</option>
                <option value="pitching">Pitching</option>
              </select>
              {gamelogStatType === 'batting' ? renderBattingLog() : renderPitchingLog()}
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
