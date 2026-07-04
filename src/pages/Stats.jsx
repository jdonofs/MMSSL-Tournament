import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import {
  buildCharacterIntrinsics,
  buildCharacterHistory,
  buildStandings,
  calculateParkFactors,
  computeLeagueConstants,
  groupBy,
  hasPitchingStatLine,
  inningsAsDecimal,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizeFielding,
  summarizeHitLocations,
  summarizePitchMix,
  summarizePitching,
  summarizePlateDiscipline,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
  MIN_PA_THRESHOLD,
} from '../utils/statsCalculator'
import {
  calculateHitPowerIndex,
  calculateParkAdjustedDistance,
  summarizeContactQuality,
  summarizeExitVelocity,
  summarizeHitDistance,
} from '../utils/hitDistanceStats'
import { buildExpectedOutcomeModel, summarizeExpectedBatting } from '../utils/expectedStats'
import { buildTournamentTeamIdentityMap, getTeamShortName } from '../utils/teamIdentity'
import { getOrderedStadiums, getStadiumSpriteStyle } from '../utils/stadiums'
import SprayChart from '../components/SprayChart'
import CharacterPortrait from '../components/CharacterPortrait'
import PlayerTag from '../components/PlayerTag'
import { getChemistry } from '../data/chemistry'
import { formatSeasonLabel } from '../utils/season'

function ordinal(n) {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

const STADIUM_NAME_TO_KEY = {
  'Mario Stadium': 'mario_stadium',
  'Yoshi Park': 'yoshi_park',
  'Wario City': 'wario_city',
  'Daisy Cruiser': 'daisy_cruiser',
  'Peach Ice Garden': 'peach_ice_garden',
  'DK Jungle': 'dk_jungle',
  'Bowser Jr. Playroom': 'bowser_jr_playroom',
  'Bowser Castle': 'bowser_castle',
  'Luigi\'s Mansion': 'luigis_mansion',
}

const PLAYER_VIEWS = {
  batting: 'batting',
  pitching: 'pitching',
  fielding: 'fielding',
}

const CHARACTER_VIEWS = {
  batting: 'batting',
  pitching: 'pitching',
  fielding: 'fielding',
}

const POSITION_LABELS = {
  1: 'P',
  2: 'C',
  3: '1B',
  4: '2B',
  5: '3B',
  6: 'SS',
  7: 'LF',
  8: 'CF',
  9: 'RF',
}

const STATS_PLAYER_TAG_HEIGHT = 22
const GROUP_HEADER_HEIGHT = 28
const ADVANCED_BATTING_MIN_PA = 5
const ADVANCED_PITCHING_MIN_IP = 9

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : '-'
}

function formatPercent(value, digits = 1, fallback = '-') {
  return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : fallback
}

function formatAverageStyle(value, digits = 3, fallback = '-') {
  if (!Number.isFinite(value)) return fallback
  const fixed = Number(value).toFixed(digits)
  return fixed.startsWith('0') ? fixed.slice(1) : fixed
}

// Signed version of formatAverageStyle for actual-vs-expected gaps: positive
// (outperforming the model, i.e. lucky) gets a leading "+", negative gets the
// usual "-", so the sign alone tells you which way the luck ran.
function formatSignedAverageStyle(value, digits = 3, fallback = '-') {
  if (!Number.isFinite(value)) return fallback
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  const fixed = Math.abs(value).toFixed(digits)
  return `${sign}${fixed.startsWith('0') ? fixed.slice(1) : fixed}`
}

// Luck coloring: green when actual outperformed expected (fortunate), red when
// it underperformed (unlucky) -- opposite of magnitude-based color scales like
// getPositiveMetricColor, since here the sign itself is what matters.
function getLuckColor(value) {
  if (!Number.isFinite(value)) return '#94A3B8'
  if (value > 0) return '#22C55E'
  if (value < 0) return '#EF4444'
  return '#94A3B8'
}

function formatTooltipNumber(value, digits = 1, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}

function getPositiveMetricColor(value) {
  if (!Number.isFinite(value)) return '#94A3B8'
  if (value >= 130) return '#EAB308'
  if (value >= 110) return '#22C55E'
  if (value >= 90) return '#F8FAFC'
  if (value >= 70) return '#F97316'
  return '#EF4444'
}

function getInverseMetricColor(value) {
  if (!Number.isFinite(value)) return '#94A3B8'
  if (value <= 70) return '#EAB308'
  if (value <= 90) return '#22C55E'
  if (value <= 110) return '#F8FAFC'
  if (value <= 130) return '#F97316'
  return '#EF4444'
}

function getCharacterClassAccent(characterClass) {
  switch (characterClass) {
    case 'Power':
      return { color: '#FCA5A5', border: 'rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.16)' }
    case 'Speed':
      return { color: '#86EFAC', border: 'rgba(34,197,94,0.45)', background: 'rgba(34,197,94,0.16)' }
    case 'Technique':
      return { color: '#D8B4FE', border: 'rgba(168,85,247,0.45)', background: 'rgba(168,85,247,0.16)' }
    default:
      return { color: '#FDE68A', border: 'rgba(234,179,8,0.45)', background: 'rgba(234,179,8,0.16)' }
  }
}

function createEmptyFieldingRow(overrides = {}) {
  return {
    games: 0,
    chances: 0,
    putouts: 0,
    assists: 0,
    errors: 0,
    starHitErrors: 0,
    cleanPlays: 0,
    fieldingPct: 0,
    adjustedFieldingPct: 0,
    rangeFactor: 0,
    positionsPlayed: 0,
    primaryPosition: '-',
    buddyJumps: 0,
    hrRobberies: 0,
    ...overrides,
  }
}

function sanitizeMetricValue(value) {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value
}

function sanitizeMetrics(metrics = {}) {
  return Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, sanitizeMetricValue(value)]),
  )
}

function parseFieldingSequence(pa = {}) {
  const notation = String(pa.error_notation || pa.hit_notation || '')
  const baseNotation = notation.split('-E')[0]
  const positions = (baseNotation.match(/\d+/g) || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  const errorMatch = notation.match(/E(\d+)/)
  const parsedErrorPosition = errorMatch ? Number(errorMatch[1]) : Number(pa.error_position || 0)

  return {
    positions,
    errorPosition: Number.isFinite(parsedErrorPosition) && parsedErrorPosition > 0 ? parsedErrorPosition : null,
  }
}

function CharacterCell({ name, compact = false }) {
  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 28, minHeight: 28 }}>
        <CharacterPortrait name={name} size={28} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 160, minHeight: 40 }}>
      <CharacterPortrait name={name} size={28} />
      <span>{name}</span>
    </div>
  )
}

function StarIcon({ size = 12 }) {
  return <img src="/Star.png" alt="Star" style={{ height: size, width: size, verticalAlign: 'middle', display: 'inline-block' }} />
}

function SortHeaderButton({ label, active, direction, onClick }) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        border: 'none',
        background: 'none',
        color: 'inherit',
        font: 'inherit',
        padding: 0,
        cursor: 'pointer',
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: '#94A3B8', fontSize: 11, width: 10, textAlign: 'center', opacity: active ? 0.95 : 0 }}>
        {active ? (direction === 'asc' ? '↑' : '↓') : ''}
      </span>
    </button>
  )
}

function ValueBadge({ value, color }) {
  return <span style={{ color, fontWeight: 700 }}>{value}</span>
}

function hasBattingData(row) {
  return Number(row?.batting?.plateAppearances || 0) > 0
}

function hasPitchingData(row) {
  return hasPitchingStatLine(row?.pitching)
}

function hasFieldingData(row) {
  return Number(row?.fielding?.chances || 0) > 0 || Number(row?.fielding?.errors || 0) > 0
}

function qualifiesAdvancedBatting(row) {
  return Number(row?.batting?.plateAppearances || 0) >= ADVANCED_BATTING_MIN_PA
}

function qualifiesAdvancedPitching(row) {
  const innings = Number(row?.pitchingThresholdIp || 0)
  return innings >= 1 && innings >= ADVANCED_PITCHING_MIN_IP
}

function qualifiesForPower(row) {
  return Number(row?.distanceProfile?.sampleSize || 0) >= MIN_PA_THRESHOLD
}

function StatBar({ label, value, max = 100, accent = '#EAB308' }) {
  const pct = Math.max(0, Math.min(100, (Number(value || 0) / max) * 100))
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
        <span style={{ color: '#CBD5E1', fontWeight: 700 }}>{label}</span>
        <span style={{ color: '#F8FAFC', fontWeight: 800 }}>{value}</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: accent, borderRadius: 999 }} />
      </div>
    </div>
  )
}

function Badge({ children, color = '#F8FAFC', border = 'rgba(255,255,255,0.18)', background = 'rgba(255,255,255,0.06)' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: `1px solid ${border}`, background, color, padding: '0.25rem 0.55rem', fontSize: 11, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase' }}>
      {children}
    </span>
  )
}

function StatTile({ label, value, color = '#F8FAFC' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: 'inherit', fontSize: 16, fontWeight: 800, color }}>{value}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#94A3B8' }}>{label}</span>
    </div>
  )
}

function TeamStatCardGroup({ title, accent, tiles }) {
  return (
    <div style={{ background: '#1E293B', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: '#CBD5E1' }}>{title}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px 8px' }}>
        {tiles.map((tile) => <StatTile key={tile.label} {...tile} />)}
      </div>
    </div>
  )
}

// A per-team "scouting report" alternative to scrolling the Overview table
// sideways: every stat the team owns, grouped the same way the table groups
// its columns, so nothing is hidden -- it's just chunked by theme.
function TeamStatCardModal({ row, identitiesByPlayerId, playersById, onClose }) {
  if (!row) return null
  const b = row.batting || {}
  const ab = row.advancedBatting || {}
  const sh = row.starHit || {}
  const sp = row.starPitch || {}
  const gold = '#EAB308'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 'min(760px, 100%)' }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <PlayerTag height={32} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} />
            <div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{row.gamesPlayed} games played</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, textAlign: 'right' }}>
          <StatTile label="Run Diff" value={Number.isFinite(row.runDiff) ? row.runDiff : '-'} color={row.runDiff > 0 ? '#22C55E' : row.runDiff < 0 ? '#EF4444' : '#F8FAFC'} />
          <StatTile label="Runs Scored" value={Number.isFinite(row.runsFor) ? row.runsFor : '-'} />
          <StatTile label="Runs Allowed" value={Number.isFinite(row.runsAgainst) ? row.runsAgainst : '-'} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
          <TeamStatCardGroup
            title="Contact"
            accent="#38BDF8"
            tiles={[
              { label: 'AVG', value: formatAverageStyle(b.avg), color: gold },
              { label: 'OBP', value: formatAverageStyle(b.obp), color: gold },
              { label: 'BABIP', value: qualifiesAdvancedBatting(row) ? formatAverageStyle(ab.babip) : '--' },
              { label: 'Hits', value: formatInteger(b.hits) },
              { label: 'Singles', value: formatInteger(b.singles) },
              { label: 'Doubles', value: formatInteger(b.doubles) },
            ]}
          />
          <TeamStatCardGroup
            title="Power"
            accent="#F97316"
            tiles={[
              { label: 'SLG', value: formatAverageStyle(b.slg), color: gold },
              { label: 'OPS', value: formatDecimal(b.ops), color: gold },
              { label: 'ISO', value: qualifiesAdvancedBatting(row) ? formatAverageStyle(ab.iso) : '--', color: gold },
              { label: 'Home Runs', value: formatInteger(b.homeRuns) },
              { label: 'Total Bases', value: formatInteger(b.totalBases) },
              { label: 'RBI', value: formatInteger(b.rbi) },
            ]}
          />
          <TeamStatCardGroup
            title="Discipline"
            accent="#A78BFA"
            tiles={[
              { label: 'Walks', value: formatInteger(b.walks) },
              { label: 'HBP', value: formatInteger(b.hbp) },
              { label: 'Strikeouts', value: formatInteger(b.strikeouts), color: '#22C55E' },
            ]}
          />
          <TeamStatCardGroup
            title="Situational"
            accent="#4ADE80"
            tiles={[
              { label: 'Sac Flies', value: formatInteger(b.sacrificeFlies) },
              { label: 'Sac Hits', value: formatInteger(b.sacrificeHits) },
            ]}
          />
          <TeamStatCardGroup
            title="Hitting Stars"
            accent="#EAB308"
            tiles={[
              { label: '★ Attempts', value: formatInteger(sh.used) },
              { label: '★ Connects', value: formatInteger(sh.connected) },
              { label: '★ Hit Rate', value: formatPercent(sh.successRate, 1), color: gold },
              { label: '★ RBI', value: formatInteger(sh.totalRbi) },
            ]}
          />
          {hasPitchingData(row) ? (
            <TeamStatCardGroup
              title="Pitching Stars"
              accent="#EAB308"
              tiles={[
                { label: '★ Pitches', value: formatInteger(sp.used) },
                { label: '★ PA Faced', value: formatInteger(sp.paUsed) },
                { label: '★ Outs', value: formatInteger(sp.outsOnStarPitch) },
                { label: '★ Success Rate', value: formatPercent(sp.successRate, 1), color: gold },
              ]}
            />
          ) : null}
          <TeamStatCardGroup
            title="Advanced"
            accent="#EAB308"
            tiles={[
              { label: 'wOBA', value: qualifiesAdvancedBatting(row) ? formatAverageStyle(ab.woba) : '--', color: gold },
              { label: 'wRC+', value: qualifiesAdvancedBatting(row) && Number.isFinite(ab.wrcPlus) ? Math.round(ab.wrcPlus) : '--', color: getPositiveMetricColor(ab.wrcPlus) },
              { label: 'OPS+', value: qualifiesAdvancedBatting(row) && Number.isFinite(ab.opsPlus) ? Math.round(ab.opsPlus) : '--', color: getPositiveMetricColor(ab.opsPlus) },
              { label: 'Plate Apps', value: formatInteger(b.plateAppearances) },
              { label: 'At-Bats', value: formatInteger(b.atBats) },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

function sortRows(rows, columns, sortState, fallbackKey = 'name') {
  const column = columns.find((entry) => entry.key === sortState.key) || columns.find((entry) => entry.key === fallbackKey) || columns[0]
  const getValue = column?.sortValue || ((row) => row[column?.key])

  return [...rows].sort((a, b) => {
    const aValue = getValue(a)
    const bValue = getValue(b)

    if (aValue == null && bValue == null) {
      const aFallback = String(a[fallbackKey] ?? '')
      const bFallback = String(b[fallbackKey] ?? '')
      return aFallback.localeCompare(bFallback)
    }
    if (aValue == null) return 1
    if (bValue == null) return -1

    let comparison = 0
    if (typeof aValue === 'string' || typeof bValue === 'string') {
      comparison = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' })
    } else {
      comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0
    }

    if (comparison === 0) {
      const aFallback = String(a[fallbackKey] ?? '')
      const bFallback = String(b[fallbackKey] ?? '')
      comparison = aFallback.localeCompare(bFallback, undefined, { numeric: true, sensitivity: 'base' })
    }

    return sortState.direction === 'asc' ? comparison : -comparison
  })
}

function buildColumnGroups(columns = [], shouldStickColumn = () => true) {
  const groups = []

  columns.forEach((column, index) => {
    const group = column.group || ''
    const previous = groups[groups.length - 1]
    const isSticky = shouldStickColumn(column, index) && Boolean(column.sticky)
    const width = isSticky ? Number(column.stickyWidth || 0) : 0

    if (previous && previous.label === group && previous.sticky === isSticky) {
      previous.colSpan += 1
      previous.keys.push(column.key)
      previous.width += width
      previous.lastIndex = index
      previous.sticky = previous.sticky && isSticky
      return
    }

    groups.push({
      label: group,
      colSpan: 1,
      keys: [column.key],
      firstIndex: index,
      lastIndex: index,
      sticky: isSticky,
      left: isSticky ? Number(column.stickyLeft || 0) : null,
      width,
    })
  })

  return groups
}

function buildFieldingRows({ plateAppearances = [], gameFielders = [], players = [], charactersByName = {} } = {}) {
  const playerNameById = Object.fromEntries(players.map((player) => [String(player.id), player.name]))
  const playerIdByName = Object.fromEntries(players.map((player) => [player.name, player.id]))

  const playerMap = {}
  const characterMap = {}

  const ensureEntry = (collection, key, base) => {
    if (!collection[key]) {
      collection[key] = {
        ...base,
        gamesSet: new Set(),
        positionsSet: new Set(),
        positionCounts: {},
        chances: 0,
        putouts: 0,
        assists: 0,
        errors: 0,
        starHitErrors: 0,
        buddyJumps: 0,
        hrRobberies: 0,
      }
    }
    return collection[key]
  }

  const findFielder = (pa = {}, positionNumber = null) => gameFielders.find((fielder) => (
    String(fielder.game_id) === String(pa.game_id) &&
    Number(fielder.position) === Number(positionNumber) &&
    Number(fielder.inning_from || 1) <= Number(pa.inning || 1) &&
    (fielder.inning_to == null || Number(fielder.inning_to) >= Number(pa.inning || 1)) &&
    String(fielder.team_id) === String(pa.defensive_team_id)
  ))

  const applyCredit = ({
    playerId,
    playerName,
    characterName,
    gameId,
    positionNumber,
    chances = 0,
    putouts = 0,
    assists = 0,
    errors = 0,
    starHitErrors = 0,
    buddyJumps = 0,
    hrRobberies = 0,
  }) => {
    const position = POSITION_LABELS[Number(positionNumber)] || String(positionNumber || '-')
    const resolvedPlayerId = String(playerId || playerIdByName[playerName] || playerName || 'unknown')
    const resolvedPlayerName = playerName || playerNameById[resolvedPlayerId] || 'Unknown'
    const resolvedCharacterName = characterName || 'Unknown'

    const playerEntry = ensureEntry(playerMap, resolvedPlayerId, { playerId: resolvedPlayerId, name: resolvedPlayerName })
    playerEntry.gamesSet.add(gameId)
    playerEntry.positionsSet.add(position)
    playerEntry.positionCounts[position] = (playerEntry.positionCounts[position] || 0) + 1
    playerEntry.chances += chances
    playerEntry.putouts += putouts
    playerEntry.assists += assists
    playerEntry.errors += errors
    playerEntry.starHitErrors += starHitErrors
    playerEntry.buddyJumps += buddyJumps
    playerEntry.hrRobberies += hrRobberies

    const characterId = charactersByName[resolvedCharacterName]?.id || null
    const characterEntry = ensureEntry(characterMap, resolvedCharacterName, { id: characterId, name: resolvedCharacterName })
    characterEntry.gamesSet.add(gameId)
    characterEntry.positionsSet.add(position)
    characterEntry.positionCounts[position] = (characterEntry.positionCounts[position] || 0) + 1
    characterEntry.chances += chances
    characterEntry.putouts += putouts
    characterEntry.assists += assists
    characterEntry.errors += errors
    characterEntry.starHitErrors += starHitErrors
    characterEntry.buddyJumps += buddyJumps
    characterEntry.hrRobberies += hrRobberies
  }

  const applyCreditFromFielder = (pa, positionNumber, counts) => {
    const fielder = findFielder(pa, positionNumber)
    if (!fielder) return false
    applyCredit({
      playerId: fielder.player_id || fielder.team_id,
      playerName: fielder.player_name || playerNameById[String(fielder.player_id || fielder.team_id)] || 'Unknown',
      characterName: fielder.character || 'Unknown',
      gameId: String(pa.game_id),
      positionNumber,
      ...counts,
    })
    return true
  }

  plateAppearances.forEach((pa) => {
    const gameId = String(pa.game_id)
    const { positions, errorPosition } = parseFieldingSequence(pa)

    // Buddy Jump credit comes straight off its own columns rather than the
    // parsed notation chain, so it's tracked even before the play's shape
    // (and so its hit_notation) is resolved in the Exit Velocity tab.
    if (pa.is_buddy_jump) {
      if (pa.buddy_jump_assist_position) {
        applyCreditFromFielder(pa, pa.buddy_jump_assist_position, { buddyJumps: 1 })
      }
      if (pa.buddy_jump_putout_position) {
        applyCreditFromFielder(pa, pa.buddy_jump_putout_position, { buddyJumps: 1, hrRobberies: pa.is_robbed_hr ? 1 : 0 })
      }
    }

    if (pa.is_error) {
      const errorIndex = errorPosition ? positions.lastIndexOf(errorPosition) : -1
      const assistPositions = errorIndex >= 0 ? positions.slice(0, errorIndex) : positions
      // A fielder is credited with at most one assist per out, even if he
      // touches the ball more than once (e.g. a rundown).
      new Set(assistPositions).forEach((positionNumber) => {
        applyCreditFromFielder(pa, positionNumber, { chances: 1, assists: 1 })
      })

      // Errors on a batter's star hit are tracked separately so fielding %
      // can be shown both as-is and adjusted for the harder-to-field star swing.
      const isStarHitError = Boolean(pa.star_hit_used)

      const matchedError = errorPosition
        ? applyCreditFromFielder(pa, errorPosition, { chances: 1, errors: 1, starHitErrors: isStarHitError ? 1 : 0 })
        : false
      if (!matchedError) {
        applyCredit({
          playerId: pa.defensive_team_id || playerIdByName[pa.error_player] || pa.error_player,
          playerName: pa.error_player || playerNameById[String(pa.defensive_team_id)] || 'Unknown',
          characterName: pa.error_character || 'Unknown',
          gameId,
          positionNumber: errorPosition,
          chances: 1,
          errors: 1,
          starHitErrors: isStarHitError ? 1 : 0,
        })
      }
      return
    }

    if (!positions.length) {
      // Strikeouts (and caught-looking strikeouts) aren't recorded with a
      // fielding chain, but the catcher still receives the putout for
      // catching the third strike. Pitchers never get an assist on a K.
      if (pa.result === 'K') {
        applyCreditFromFielder(pa, 2, { chances: 1, putouts: 1 })
      }
      return
    }

    // Everyone in the chain before the last fielder gets credit for an
    // assist (capped at one per player, even if he touched the ball more
    // than once on the play, e.g. a rundown). The last fielder in the chain
    // is the one who recorded the putout.
    new Set(positions.slice(0, -1)).forEach((positionNumber) => {
      applyCreditFromFielder(pa, positionNumber, { chances: 1, assists: 1 })
    })
    applyCreditFromFielder(pa, positions[positions.length - 1], { chances: 1, putouts: 1 })
  })

  const finalize = (entry) => {
    const primaryPosition = Object.entries(entry.positionCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '-'

    const games = entry.gamesSet.size
    const nonStarHitErrors = Math.max(0, entry.errors - entry.starHitErrors)
    return {
      ...entry,
      games,
      cleanPlays: Math.max(0, entry.chances - entry.errors),
      fieldingPct: entry.chances ? Math.max(0, entry.chances - entry.errors) / entry.chances : 0,
      // Fielding % with errors committed on the batter's star hit excluded,
      // since those swings are harder to field than a routine play.
      adjustedFieldingPct: entry.chances ? Math.max(0, entry.chances - nonStarHitErrors) / entry.chances : 0,
      // Classic (pre-Statcast) range factor: (PO+A) per game. True range (Statcast's
      // Outs Above Average) needs batted-ball hang time/fielder-to-ball distance that
      // isn't captured here, so this counting-stat proxy is the best available.
      rangeFactor: games ? (entry.putouts + entry.assists) / games : 0,
      positionsPlayed: entry.positionsSet.size,
      primaryPosition,
    }
  }

  return {
    playerRows: Object.values(playerMap).map(finalize),
    characterRows: Object.values(characterMap).map(finalize),
  }
}

function SortableStatsTable({
  columns,
  rows,
  sortState,
  onSort,
  rowKey,
  emptyMessage,
  onRowClick,
  footerRows = [],
  rowStyle,
  footerRowStyle,
}) {
  const [isCompactViewport, setIsCompactViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 900 : false
  ))

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const onResize = () => setIsCompactViewport(window.innerWidth <= 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const shouldStickColumn = (column, index) => {
    if (!column.sticky) return false
    if (!isCompactViewport) return true
    return index === 0
  }
  const stickyOutline = 'inset 0 0 0 1px rgba(234,179,8,0.22), inset -1px 0 0 rgba(234,179,8,0.32), inset 0 -1px 0 rgba(234,179,8,0.2)'
  const columnGroups = buildColumnGroups(columns, shouldStickColumn)
  const groupStartKeys = new Set(columnGroups.slice(1).map((group) => group.keys[0]))
  const withStickyCover = (shadow, background) => `${shadow}, 2px 0 0 ${background}`

  const buildDividerStyle = (key) => groupStartKeys.has(key)
    ? { borderLeft: '1px solid rgba(255,255,255,0.08)' }
    : null

  const buildGroupHeaderStyle = (group, index) => {
    const isFirstStickyGroup = group.sticky && (group.left || 0) === 0
    const groupBackground = index % 2 === 0 ? '#172233' : '#141e2e'
    const style = {
      position: 'sticky',
      top: 0,
      zIndex: group.sticky ? 6 : 4,
      background: groupBackground,
      overflowX: isFirstStickyGroup ? 'visible' : 'hidden',
      overflowY: 'hidden',
      boxSizing: 'border-box',
      color: '#94A3B8',
      fontSize: 11,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      boxShadow: group.sticky ? withStickyCover(stickyOutline, groupBackground) : stickyOutline,
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      ...buildDividerStyle(group.keys[0]),
    }

    if (group.sticky) {
      style.left = group.left || 0
      style.minWidth = group.width
      style.width = group.width
    }

    return style
  }

  const buildHeaderStyle = (column) => {
    const isSticky = shouldStickColumn(column, columns.indexOf(column))
    const isFirstStickyColumn = isSticky && (column.stickyLeft || 0) === 0
    const style = {
      position: 'sticky',
      top: GROUP_HEADER_HEIGHT,
      zIndex: isSticky ? 5 : 3,
      background: '#1E293B',
      overflowX: isFirstStickyColumn ? 'visible' : 'hidden',
      overflowY: 'hidden',
      boxSizing: 'border-box',
      boxShadow: isSticky ? withStickyCover(stickyOutline, '#1E293B') : stickyOutline,
      ...buildDividerStyle(column.key),
    }

    if (isSticky) {
      style.left = column.stickyLeft || 0
      style.minWidth = column.stickyWidth
      style.width = column.stickyWidth
    }

    return style
  }

  const buildCellStyle = (column, background = '#24324a') => {
    const style = { ...buildDividerStyle(column.key) }
    const isSticky = shouldStickColumn(column, columns.indexOf(column))
    const isFirstStickyColumn = isSticky && (column.stickyLeft || 0) === 0

    if (!isSticky) {
      if (background !== '#24324a') style.background = background
      return style
    }

    return {
      ...style,
      position: 'sticky',
      left: column.stickyLeft || 0,
      zIndex: 2,
      background,
      overflowX: isFirstStickyColumn ? 'visible' : 'hidden',
      overflowY: 'hidden',
      boxSizing: 'border-box',
      minWidth: column.stickyWidth,
      width: column.stickyWidth,
      maxWidth: column.stickyWidth,
      boxShadow: withStickyCover(stickyOutline, background),
    }
  }

  return (
    <div className="stats-table-shell">
      <table className="data-table stats-data-table" style={{ minWidth: 'max-content' }}>
        <thead>
          <tr className="stats-group-row">
            {columnGroups.map((group, index) => (
              <th
                key={`${group.keys[0]}-group`}
                colSpan={group.colSpan}
                className={group.label === 'Player' && group.sticky ? 'stats-player-col' : undefined}
                style={buildGroupHeaderStyle(group, index)}
              >
                {group.label}
              </th>
            ))}
          </tr>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.key === 'name' && column.group === 'Player' ? 'stats-player-col' : undefined}
                style={buildHeaderStyle(column)}
              >
                <SortHeaderButton
                  active={sortState.key === column.key}
                  direction={sortState.direction}
                  label={column.label}
                  onClick={() => onSort(column)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{ ...(onRowClick ? { cursor: 'pointer' } : {}), ...(typeof rowStyle === 'function' ? rowStyle(row) : null) }}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.key === 'name' && column.group === 'Player' ? 'stats-player-col' : undefined}
                  style={buildCellStyle(column)}
                >
                  {column.render ? column.render(row) : column.value(row)}
                </td>
              ))}
            </tr>
          )) : (
            <tr>
              <td className="muted" colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          )}
        </tbody>
        {footerRows.length ? (
          <tfoot>
            {footerRows.map((row) => (
              <tr key={rowKey(row)} style={typeof footerRowStyle === 'function' ? footerRowStyle(row) : undefined}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.key === 'name' && column.group === 'Player' ? 'stats-player-col' : undefined}
                    style={buildCellStyle(column, 'rgba(234,179,8,0.08)')}
                  >
                    {column.render ? column.render(row) : column.value(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

function GlossaryPanel({ title, items = [] }) {
  return (
    <details style={{ marginTop: 12, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(255,255,255,0.03)' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '0.85rem 1rem', fontWeight: 700, color: '#F8FAFC' }}>{title}</summary>
      <div style={{ padding: '0 1rem 1rem', display: 'grid', gap: 8 }}>
        {items.map((item) => (
          <div key={item.term} style={{ color: '#CBD5E1', fontSize: 13, lineHeight: 1.45 }}>
            <strong style={{ color: '#F8FAFC' }}>{item.term}</strong>: {item.definition}
          </div>
        ))}
      </div>
    </details>
  )
}

function StatPill({ label, value, accent = '#EAB308' }) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '0.75rem 0.9rem', background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ color: accent, fontSize: 20, fontWeight: 800, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function DetailStatGrid({ stats }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
      {stats.map((stat) => (
        <StatPill key={stat.label} label={stat.label} value={stat.value} accent={stat.accent} />
      ))}
    </div>
  )
}

function CharacterDetailModal({
  character,
  allCharactersById,
  playersById,
  identitiesByPlayerId,
  currentTournamentBatting,
  currentTournamentPitching,
  allTimeBatting,
  allTimePitching,
  allPitches = [],
  allFielding = null,
  battingHistory = [],
  pitchingHistory = [],
  currentOwner,
  totalDrafts,
  tournamentsDrafted,
  championshipsWon,
  characterIntrinsics = null,
  onClose,
}) {
  if (!character) return null

  const chemistry = getChemistry(character.name)
  const batterPitches = allPitches.filter((pitch) => pitch.batter_id === character.name)
  const pitcherPitches = allPitches.filter((pitch) => pitch.pitcher_id === character.name)
  const starHitStats = summarizeStarHits(currentTournamentBatting.rawPas || [])
  const battingBattedBall = summarizeBattedBallProfile(currentTournamentBatting.rawPas || [])
  const battingSpray = summarizeSprayProfile(currentTournamentBatting.rawPas || [])
  const battingDiscipline = summarizePlateDiscipline(currentTournamentBatting.rawPas || [], batterPitches)
  const pitchingStar = summarizeStarPitching(currentTournamentPitching.rawPas || [], pitcherPitches)
  const pitchingMix = summarizePitchMix(currentTournamentPitching.rawPas || [], pitcherPitches)
  const pitchingBattedBall = summarizeBattedBallProfile(currentTournamentPitching.rawPas || [])
  const pitchingSpray = summarizeSprayProfile(currentTournamentPitching.rawPas || [])
  const characterErrors = allFielding?.errorsByCharacter?.[character.name] || 0
  const classAccent = getCharacterClassAccent(characterIntrinsics?.characterClass)
  const portraitButtonStyle = {
    background: 'none',
    border: 'none',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#F8FAFC',
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 960, maxHeight: '90vh', overflowY: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', border: '2px solid #EAB308', flexShrink: 0 }}>
              <CharacterPortrait name={character.name} size={72} />
            </div>
            <div>
              <h2 style={{ margin: 0 }}>{character.name}</h2>
              <div className="muted" style={{ marginTop: 4 }}>
                {currentOwner
                  ? <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={currentOwner.player_id} playersById={playersById} />
                  : 'Undrafted in selected view'}
              </div>
            </div>
          </div>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div className="page-stack">
          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Character Info</h3>
              <div className="muted">All available data for this character</div>
            </div>
            <DetailStatGrid
              stats={[
                { label: 'Pitching', value: formatInteger(character.pitchingRating), accent: '#EF4444' },
                { label: 'Batting', value: formatInteger(character.battingRating), accent: '#22C55E' },
                { label: 'Fielding', value: formatInteger(character.fieldingRating), accent: '#3B82F6' },
                { label: 'Speed', value: formatInteger(character.speedRating), accent: '#EAB308' },
                { label: 'Drafted', value: formatInteger(totalDrafts), accent: '#F8FAFC' },
                { label: 'Tournaments', value: formatInteger(tournamentsDrafted), accent: '#F8FAFC' },
                { label: 'Titles', value: formatInteger(championshipsWon), accent: '#F8FAFC' },
              ]}
            />
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Current Tournament</h3>
              <div className="muted">Selected tournament view</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <DetailStatGrid
                  stats={[
                    { label: 'PA', value: formatInteger(currentTournamentBatting.plateAppearances) },
                    { label: 'AB', value: formatInteger(currentTournamentBatting.atBats) },
                    { label: 'H', value: formatInteger(currentTournamentBatting.hits) },
                    { label: 'R', value: formatInteger(currentTournamentBatting.runs) },
                    { label: 'RBI', value: formatInteger(currentTournamentBatting.rbi) },
                    { label: 'HR', value: formatInteger(currentTournamentBatting.homeRuns) },
                    { label: 'AVG', value: formatDecimal(currentTournamentBatting.avg) },
                    { label: 'OPS', value: formatDecimal(currentTournamentBatting.ops) },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <DetailStatGrid
                  stats={[
                    { label: 'IP', value: formatDecimal(currentTournamentPitching.innings, 1) },
                    { label: 'W', value: formatInteger(currentTournamentPitching.wins) },
                    { label: 'L', value: formatInteger(currentTournamentPitching.losses) },
                    { label: 'SV', value: formatInteger(currentTournamentPitching.saves) },
                    { label: 'K', value: formatInteger(currentTournamentPitching.strikeouts) },
                    { label: 'ERA/3', value: formatDecimal(currentTournamentPitching.era, 2) },
                    { label: 'WHIP', value: formatDecimal(currentTournamentPitching.whip, 2) },
                    { label: 'K/3', value: formatDecimal(currentTournamentPitching.kPer3, 2) },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>All-Time Performance</h3>
              <div className="muted">Across all tournaments</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Games', value: formatInteger(allTimeBatting.games) },
                    { label: 'PA', value: formatInteger(allTimeBatting.plateAppearances) },
                    { label: 'AB', value: formatInteger(allTimeBatting.atBats) },
                    { label: 'H', value: formatInteger(allTimeBatting.hits) },
                    { label: '2B', value: formatInteger(allTimeBatting.doubles) },
                    { label: '3B', value: formatInteger(allTimeBatting.triples) },
                    { label: 'HR', value: formatInteger(allTimeBatting.homeRuns) },
                    { label: 'BB', value: formatInteger(allTimeBatting.walks) },
                    { label: 'HBP', value: formatInteger(allTimeBatting.hbp) },
                    { label: 'SO', value: formatInteger(allTimeBatting.strikeouts) },
                    { label: 'R', value: formatInteger(allTimeBatting.runs) },
                    { label: 'RBI', value: formatInteger(allTimeBatting.rbi) },
                    { label: 'TB', value: formatInteger(allTimeBatting.totalBases) },
                    { label: 'AVG', value: formatDecimal(allTimeBatting.avg) },
                    { label: 'OBP', value: formatDecimal(allTimeBatting.obp) },
                    { label: 'SLG', value: formatDecimal(allTimeBatting.slg) },
                    { label: 'OPS', value: formatDecimal(allTimeBatting.ops) },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Games', value: formatInteger(allTimePitching.games) },
                    { label: 'IP', value: formatDecimal(allTimePitching.innings, 1) },
                    { label: 'W', value: formatInteger(allTimePitching.wins) },
                    { label: 'L', value: formatInteger(allTimePitching.losses) },
                    { label: 'SV', value: formatInteger(allTimePitching.saves) },
                    { label: 'CG', value: formatInteger(allTimePitching.completeGames) },
                    { label: 'SHO', value: formatInteger(allTimePitching.shutouts) },
                    { label: 'K', value: formatInteger(allTimePitching.strikeouts) },
                    { label: 'H', value: formatInteger(allTimePitching.hitsAllowed) },
                    { label: 'R', value: formatInteger(allTimePitching.runsAllowed) },
                    { label: 'ER', value: formatInteger(allTimePitching.earnedRuns) },
                    { label: 'BB', value: formatInteger(allTimePitching.walks) },
                    { label: 'HR', value: formatInteger(allTimePitching.homeRunsAllowed) },
                    { label: 'ERA/3', value: formatDecimal(allTimePitching.era, 2) },
                    { label: 'WHIP', value: formatDecimal(allTimePitching.whip, 2) },
                    { label: 'K/3', value: formatDecimal(allTimePitching.kPer3, 2) },
                    { label: 'HR/3', value: formatDecimal(allTimePitching.hrPer3, 2) },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Advanced Profile</h3>
              <div className="muted">Star usage, contact profile, discipline, and fielding</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Star Hit</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Used', value: formatInteger(starHitStats.used), accent: '#EAB308' },
                    { label: 'Contact %', value: `${(starHitStats.contactRate * 100).toFixed(0)}%`, accent: '#22C55E' },
                    { label: 'Success %', value: `${(starHitStats.successRate * 100).toFixed(0)}%`, accent: '#3B82F6' },
                    { label: 'RBI/Use', value: formatDecimal(starHitStats.avgRbiPerUse, 2), accent: '#F8FAFC' },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batted Ball</div>
                <DetailStatGrid
                  stats={[
                    { label: 'LD%', value: `${(battingBattedBall.ldRate * 100).toFixed(0)}%`, accent: '#22C55E' },
                    { label: 'GB%', value: `${(battingBattedBall.gbRate * 100).toFixed(0)}%`, accent: '#3B82F6' },
                    { label: 'FB%', value: `${(battingBattedBall.fbRate * 100).toFixed(0)}%`, accent: '#EAB308' },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Spray & Discipline</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Pull%', value: `${(battingSpray.pullRate * 100).toFixed(0)}%`, accent: '#22C55E' },
                    { label: 'Center%', value: `${(battingSpray.centerRate * 100).toFixed(0)}%`, accent: '#3B82F6' },
                    { label: 'Oppo%', value: `${(battingSpray.oppoRate * 100).toFixed(0)}%`, accent: '#EAB308' },
                    { label: 'P/PA', value: formatDecimal(battingDiscipline.pitchesPerPa, 2), accent: '#F8FAFC' },
                    { label: 'Whiff%', value: `${(battingDiscipline.whiffRate * 100).toFixed(0)}%`, accent: '#EF4444' },
                    { label: 'Foul%', value: `${(battingDiscipline.foulRate * 100).toFixed(0)}%`, accent: '#F8FAFC' },
                    { label: 'KS%', value: `${(battingDiscipline.ksRate * 100).toFixed(0)}%`, accent: '#EF4444' },
                    { label: 'KL%', value: `${(battingDiscipline.klRate * 100).toFixed(0)}%`, accent: '#F8FAFC' },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching & Fielding</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Star Pitch %', value: `${(pitchingStar.successRate * 100).toFixed(0)}%`, accent: '#EAB308' },
                    { label: 'Strike %', value: `${(pitchingMix.strikeRate * 100).toFixed(0)}%`, accent: '#22C55E' },
                    { label: '1st Str %', value: `${(pitchingMix.firstPitchStrikeRate * 100).toFixed(0)}%`, accent: '#3B82F6' },
                    { label: 'Whiff %', value: `${(pitchingMix.swingingMissRate * 100).toFixed(0)}%`, accent: '#EF4444' },
                    { label: 'Allowed LD%', value: `${(pitchingBattedBall.ldRate * 100).toFixed(0)}%`, accent: '#F8FAFC' },
                    { label: 'Allowed Pull%', value: `${(pitchingSpray.pullRate * 100).toFixed(0)}%`, accent: '#F8FAFC' },
                    { label: 'Errors', value: formatInteger(characterErrors), accent: '#EF4444' },
                    { label: 'Star Used', value: formatInteger(pitchingStar.used), accent: '#EAB308' },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Chemistry</h3>
              <div className="muted">Roster chemistry relationships</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Good</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {chemistry.good.length ? chemistry.good.map((name) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.45rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
                      <CharacterPortrait name={name} size={32} />
                      <span>{allCharactersById[name]?.name || name}</span>
                    </div>
                  )) : <span className="muted">None</span>}
                </div>
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Bad</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {chemistry.bad.length ? chemistry.bad.map((name) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.45rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
                      <CharacterPortrait name={name} size={32} />
                      <span>{allCharactersById[name]?.name || name}</span>
                    </div>
                  )) : <span className="muted">None</span>}
                </div>
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Tournament History</h3>
              <div className="muted">Per-tournament batting and pitching</div>
            </div>
            <div className="page-stack">
              <div style={{ overflowX: 'auto' }}>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tournament</th>
                      <th>PA</th>
                      <th>AVG</th>
                      <th>OPS</th>
                      <th>HR</th>
                      <th>RBI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {battingHistory.length ? battingHistory.map((entry) => (
                      <tr key={`bat-${entry.tournamentId}`}>
                        <td>Tournament {entry.tournamentNumber}</td>
                        <td>{entry.pa}</td>
                        <td>{formatDecimal(entry.avg)}</td>
                        <td>{formatDecimal(entry.ops)}</td>
                        <td>{entry.hr}</td>
                        <td>{entry.rbi}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="muted">No batting history.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tournament</th>
                      <th>IP</th>
                      <th>ERA/3</th>
                      <th>WHIP</th>
                      <th>K</th>
                      <th>W-L-SV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pitchingHistory.length ? pitchingHistory.map((entry) => (
                      <tr key={`pit-${entry.tournamentId}`}>
                        <td>Tournament {entry.tournamentNumber}</td>
                        <td>{formatDecimal(entry.innings, 1)}</td>
                        <td>{formatDecimal(entry.era, 2)}</td>
                        <td>{formatDecimal(entry.whip, 2)}</td>
                        <td>{entry.strikeouts}</td>
                        <td>{entry.wins}-{entry.losses}-{entry.saves}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="muted">No pitching history.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default function Stats() {
  const navigate = useNavigate()
  const location = useLocation()
  const isSeasonRoute = location.pathname.startsWith('/season')
  const { viewedTournament, currentTournament } = useTournament()
  const { viewedSeason, currentSeason, seasonTeams } = useSeason()
  const [tab, setTab] = useState('players')
  const [playerView, setPlayerView] = useState(PLAYER_VIEWS.batting)
  const [characterView, setCharacterView] = useState(CHARACTER_VIEWS.batting)
  const [playerSort, setPlayerSort] = useState({ key: 'name', direction: 'asc' })
  const [characterSort, setCharacterSort] = useState({ key: 'name', direction: 'asc' })
  const [advancedBattingSort, setAdvancedBattingSort] = useState({ key: 'wrcPlus', direction: 'desc' })
  const [advancedPitchingSort, setAdvancedPitchingSort] = useState({ key: 'fip', direction: 'asc' })
  const [statView, setStatView] = useState('overview')
  const [statDiscipline, setStatDiscipline] = useState('batting')
  const [selectedPlayerCardId, setSelectedPlayerCardId] = useState(null)
  const [bbSubView, setBbSubView] = useState('batting')
  const [discSubView, setDiscSubView] = useState('batting')
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])
  const [selectedStadiumKey, setSelectedStadiumKey] = useState(null)
  const [ballparkSubView, setBallparkSubView] = useState('batting')
  const [ballparkTimeFilter, setBallparkTimeFilter] = useState('all')
  const [locationDisplayMode, setLocationDisplayMode] = useState('pct')
  const [bbPlayerSort, setBbPlayerSort] = useState({ key: 'bip', direction: 'desc' })
  const [bbCharacterSort, setBbCharacterSort] = useState({ key: 'bip', direction: 'desc' })
  const [powerPlayerSort, setPowerPlayerSort] = useState({ key: 'hitPowerIndex', direction: 'desc' })
  const [powerCharacterSort, setPowerCharacterSort] = useState({ key: 'hitPowerIndex', direction: 'desc' })
  const [exitVeloPlayerSort, setExitVeloPlayerSort] = useState({ key: 'avgExitVelo', direction: 'desc' })
  const [exitVeloCharacterSort, setExitVeloCharacterSort] = useState({ key: 'avgExitVelo', direction: 'desc' })
  const [contactQualityPlayerSort, setContactQualityPlayerSort] = useState({ key: 'barrelRate', direction: 'desc' })
  const [contactQualityCharacterSort, setContactQualityCharacterSort] = useState({ key: 'barrelRate', direction: 'desc' })
  const [expectedPlayerSort, setExpectedPlayerSort] = useState({ key: 'xwOBA', direction: 'desc' })
  const [expectedCharacterSort, setExpectedCharacterSort] = useState({ key: 'xwOBA', direction: 'desc' })
  const [locPlayerSort, setLocPlayerSort] = useState({ key: 'bipTotal', direction: 'desc' })
  const [locCharacterSort, setLocCharacterSort] = useState({ key: 'bipTotal', direction: 'desc' })
  const [discPlayerSort, setDiscPlayerSort] = useState({ key: 'pitchesPerPa', direction: 'desc' })
  const [discCharacterSort, setDiscCharacterSort] = useState({ key: 'pitchesPerPa', direction: 'desc' })
  const [mixPlayerSort, setMixPlayerSort] = useState({ key: 'pitchesPerBatter', direction: 'desc' })
  const [mixCharacterSort, setMixCharacterSort] = useState({ key: 'pitchesPerBatter', direction: 'desc' })
  const [starsBattingPlayerSort, setStarsBattingPlayerSort] = useState({ key: 'starHitUsed', direction: 'desc' })
  const [starsBattingCharacterSort, setStarsBattingCharacterSort] = useState({ key: 'starHitUsed', direction: 'desc' })
  const [starsPitchingPlayerSort, setStarsPitchingPlayerSort] = useState({ key: 'starPitchUsed', direction: 'desc' })
  const [starsPitchingCharacterSort, setStarsPitchingCharacterSort] = useState({ key: 'starPitchUsed', direction: 'desc' })
  const [starsFieldingPlayerSort, setStarsFieldingPlayerSort] = useState({ key: 'starHitErrors', direction: 'desc' })
  const [starsFieldingCharacterSort, setStarsFieldingCharacterSort] = useState({ key: 'starHitErrors', direction: 'desc' })
  const [bpBattingPlayerSort, setBpBattingPlayerSort] = useState({ key: 'plateAppearances', direction: 'desc' })
  const [bpBattingCharacterSort, setBpBattingCharacterSort] = useState({ key: 'plateAppearances', direction: 'desc' })
  const [bpPitchingPlayerSort, setBpPitchingPlayerSort] = useState({ key: 'innings', direction: 'desc' })
  const [bpPitchingCharacterSort, setBpPitchingCharacterSort] = useState({ key: 'innings', direction: 'desc' })
  const [parkFactorsSubView, setParkFactorsSubView] = useState('league')
  const [parkFactorsBatPit, setParkFactorsBatPit] = useState('batting')
  const [bpFactorsTeamSort, setBpFactorsTeamSort] = useState({ key: 'opsDiff', direction: 'desc' })
  const [bpFactorsCharSort, setBpFactorsCharSort] = useState({ key: 'opsDiff', direction: 'desc' })
  const [bpFactorsPitTeamSort, setBpFactorsPitTeamSort] = useState({ key: 'eraDiff', direction: 'asc' })
  const [bpFactorsPitCharSort, setBpFactorsPitCharSort] = useState({ key: 'eraDiff', direction: 'asc' })
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [games, setGames] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [pitches, setPitches] = useState([])
  const [gameFielders, setGameFielders] = useState([])
  const [seasonGames, setSeasonGames] = useState([])
  const [seasonRoster, setSeasonRoster] = useState([])
  const [seasonPlateAppearances, setSeasonPlateAppearances] = useState([])
  const [seasonPitchingStints, setSeasonPitchingStints] = useState([])
  const [seasonPitches, setSeasonPitches] = useState([])
  const [seasonFielders, setSeasonFielders] = useState([])
  const [selectedTournamentId, setSelectedTournamentId] = useState(() => String(viewedTournament?.id || currentTournament?.id || ''))
  const [tournaments, setTournaments] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => String(viewedSeason?.id || currentSeason?.id || ''))
  const [seasons, setSeasons] = useState([])
  const [sourceMode, setSourceMode] = useState(() => (isSeasonRoute ? 'seasons' : 'tournaments'))
  const [leagueConstants, setLeagueConstants] = useState(() => computeLeagueConstants([], []))

  const defaultTournamentId = useMemo(
    () => String(viewedTournament?.id || currentTournament?.id || tournaments[0]?.id || ''),
    [viewedTournament?.id, currentTournament?.id, tournaments],
  )

  const defaultSeasonId = useMemo(
    () => String(viewedSeason?.id || currentSeason?.id || seasons[0]?.id || ''),
    [viewedSeason?.id, currentSeason?.id, seasons],
  )

  const selectedTournamentValue = selectedTournamentId || defaultTournamentId || ''
  const selectedSeasonValue = selectedSeasonId || defaultSeasonId || ''
  const isCombinedView = sourceMode === 'all'
  const ownerTournamentId = selectedTournamentValue || defaultTournamentId
  const ownerSeasonId = selectedSeasonValue || defaultSeasonId

  useEffect(() => {
    const loadStats = async () => {
      const [
        { data: playersData },
        { data: charactersRaw },
        { data: gamesData },
        { data: picksData },
        { data: paData },
        { data: pitchingData },
        { data: pitchData },
        { data: fieldersData },
        { data: tournamentsData },
        { data: seasonsData },
        { data: seasonGamesData },
        { data: seasonTeamsData },
        { data: seasonRosterData },
        { data: seasonPaData },
        { data: seasonPitchingData },
        { data: seasonPitchData },
        { data: seasonFieldersData },
        { data: stadiumsData },
        { data: stadiumLogData },
      ] = await Promise.all([
        supabase.from('players').select('*'),
        supabase
          .from('characters')
          .select('id, name, pitching, batting, fielding, speed, slap_contact, charge_contact, slap_power, charge_power, bunting, run_speed, throwing_speed, fielding_stat, curveball_speed, fastball_speed, curve, stamina, star_boost_pct, hitting_trajectory, character_class, is_captain'),
        supabase.from('games').select('*'),
        supabase.from('draft_picks').select('*'),
        supabase.from('plate_appearances').select('*'),
        supabase.from('pitching_stints').select('*'),
        supabase.from('pitches').select('*'),
        supabase.from('game_fielders').select('*'),
        supabase.from('tournaments').select('*').order('tournament_number', { ascending: false }),
        supabase.from('seasons').select('*').order('created_at', { ascending: false }),
        supabase.from('season_schedule').select('*'),
        supabase.from('season_teams').select('*'),
        supabase.from('season_roster').select('*'),
        supabase.from('season_plate_appearances').select('*'),
        supabase.from('season_pitching_stints').select('*'),
        supabase.from('season_pitches').select('*'),
        supabase.from('season_game_fielders').select('*'),
        supabase.from('stadiums').select('*'),
        supabase.from('stadium_game_log').select('game_id, stadium_id, is_night'),
      ])

      const allPAs = paData || []
      const allPitchingStints = pitchingData || []
      const seasonTeamPlayerById = Object.fromEntries(
        (seasonTeamsData || []).map((team) => [String(team.id), team.player_id]),
      )
      const normalizedSeasonGames = (seasonGamesData || []).map((game) => ({
        ...game,
        id: `season-${game.id}`,
        source_game_id: game.id,
        tournament_id: game.season_id,
        team_a_player_id: seasonTeamPlayerById[String(game.away_team_id)] || null,
        team_b_player_id: seasonTeamPlayerById[String(game.home_team_id)] || null,
        winner_player_id: seasonTeamPlayerById[String(game.winner_team_id)] || null,
        team_a_runs: Number(game.away_score || 0),
        team_b_runs: Number(game.home_score || 0),
        status: game.status === 'completed' ? 'complete' : game.status,
      }))
      const normalizedSeasonPas = (seasonPaData || []).map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonPitching = (seasonPitchingData || []).map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonPitches = (seasonPitchData || []).map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonFielders = (seasonFieldersData || []).map((entry) => ({
        ...entry,
        game_id: `season-${entry.game_id}`,
        player_id: seasonTeamPlayerById[String(entry.team_id)] || entry.player_id || null,
      }))

      setPlayers(playersData || [])
      setCharacters(charactersRaw || [])
      setGames(gamesData || [])
      setDraftPicks(picksData || [])
      setPlateAppearances(allPAs)
      setPitchingStints(allPitchingStints)
      setPitches(pitchData || [])
      setGameFielders(fieldersData || [])
      setTournaments(tournamentsData || [])
      setSeasons(seasonsData || [])
      setSeasonGames(normalizedSeasonGames)
      setSeasonRoster(seasonRosterData || [])
      setSeasonPlateAppearances(normalizedSeasonPas)
      setSeasonPitchingStints(normalizedSeasonPitching)
      setSeasonPitches(normalizedSeasonPitches)
      setSeasonFielders(normalizedSeasonFielders)
      setStadiums(stadiumsData || [])
      setStadiumGameLog(stadiumLogData || [])
      setLeagueConstants(computeLeagueConstants(
        [...allPAs, ...normalizedSeasonPas],
        [...allPitchingStints, ...normalizedSeasonPitching],
      ))
    }

    loadStats()
    const channel = supabase
      .channel(`stats-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_fielders' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitches' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_game_fielders' }, loadStats)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (!selectedTournamentId && defaultTournamentId) {
      setSelectedTournamentId(defaultTournamentId)
    }
  }, [selectedTournamentId, defaultTournamentId])

  useEffect(() => {
    if (!selectedSeasonId && defaultSeasonId) {
      setSelectedSeasonId(defaultSeasonId)
    }
  }, [selectedSeasonId, defaultSeasonId])

  useEffect(() => {
    setSourceMode(isSeasonRoute ? 'seasons' : 'tournaments')
  }, [isSeasonRoute])

  const playersById = useMemo(() => Object.fromEntries(players.map((player) => [player.id, player])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((character) => [character.id, character])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])
  const gameById = useMemo(() => Object.fromEntries([...games, ...seasonGames].map((game) => [game.id, game])), [games, seasonGames])
  const tournamentById = useMemo(() => Object.fromEntries(tournaments.map((tournament) => [tournament.id, tournament])), [tournaments])

  const filteredGames = useMemo(() => {
    if (isCombinedView) {
      return [...games, ...seasonGames]
    }
    if (sourceMode === 'tournaments') {
      return games.filter((game) => String(game.tournament_id) === String(selectedTournamentValue))
    }
    return seasonGames.filter((game) => String(game.tournament_id) === String(selectedSeasonValue))
  }, [isCombinedView, sourceMode, games, seasonGames, selectedTournamentValue, selectedSeasonValue])
  const filteredPas = useMemo(() => {
    if (isCombinedView) {
      return [...plateAppearances, ...seasonPlateAppearances]
    }
    if (sourceMode === 'tournaments') {
      return plateAppearances.filter((pa) => String(gameById[pa.game_id]?.tournament_id) === String(selectedTournamentValue))
    }
    return seasonPlateAppearances.filter((pa) => String(gameById[pa.game_id]?.tournament_id) === String(selectedSeasonValue))
  }, [isCombinedView, sourceMode, plateAppearances, seasonPlateAppearances, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredPasWithCharacterNames = useMemo(
    () => filteredPas.map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name || null })),
    [filteredPas, charactersById],
  )
  // Built once from the current view's full batted-ball population so every row's
  // xBA/xSLG/xwOBA compares each batted ball against the same league sample.
  const expectedOutcomeModel = useMemo(() => buildExpectedOutcomeModel(filteredPas), [filteredPas])
  const filteredPitching = useMemo(() => {
    let raw
    if (isCombinedView) {
      raw = [...pitchingStints, ...seasonPitchingStints]
    } else if (sourceMode === 'tournaments') {
      raw = pitchingStints.filter((stint) => String(gameById[stint.game_id]?.tournament_id) === String(selectedTournamentValue))
    } else {
      raw = seasonPitchingStints.filter((stint) => String(gameById[stint.game_id]?.tournament_id) === String(selectedSeasonValue))
    }

    // Derive W/L from game outcomes since the DB fields are not reliably populated.
    const byGame = {}
    for (const stint of raw) {
      const key = String(stint.game_id)
      if (!byGame[key]) byGame[key] = []
      byGame[key].push(stint)
    }
    const overrides = {}
    for (const [gameId, stints] of Object.entries(byGame)) {
      const game = gameById[gameId]
      if (!game || game.status !== 'complete' || !game.winner_player_id) continue
      const winnerPlayerId = String(game.winner_player_id)
      const loserPlayerId = [game.team_a_player_id, game.team_b_player_id]
        .map(String)
        .find((id) => id !== winnerPlayerId) || null
      const sorted = [...stints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      const winnerStints = sorted.filter((s) => String(s.player_id) === winnerPlayerId)
      const loserStints = loserPlayerId ? sorted.filter((s) => String(s.player_id) === loserPlayerId) : []
      const winningStint = winnerStints[winnerStints.length - 1]
      const losingStint = loserStints[loserStints.length - 1]
      if (winningStint) overrides[winningStint.id] = { win: true, loss: false }
      if (losingStint) overrides[losingStint.id] = { win: false, loss: true }
    }
    if (!Object.keys(overrides).length) return raw
    return raw.map((stint) => overrides[stint.id] ? { ...stint, ...overrides[stint.id] } : { ...stint, win: false, loss: false })
  }, [isCombinedView, sourceMode, pitchingStints, seasonPitchingStints, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredPitches = useMemo(() => {
    if (isCombinedView) {
      return [...pitches, ...seasonPitches]
    }
    if (sourceMode === 'tournaments') {
      return pitches.filter((pitch) => String(gameById[pitch.game_id]?.tournament_id) === String(selectedTournamentValue))
    }
    return seasonPitches.filter((pitch) => String(gameById[pitch.game_id]?.tournament_id) === String(selectedSeasonValue))
  }, [isCombinedView, sourceMode, pitches, seasonPitches, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredFielders = useMemo(() => {
    if (isCombinedView) {
      return [...gameFielders, ...seasonFielders]
    }
    if (sourceMode === 'tournaments') {
      return gameFielders.filter((fielder) => String(gameById[fielder.game_id]?.tournament_id) === String(selectedTournamentValue))
    }
    return seasonFielders.filter((fielder) => String(gameById[fielder.game_id]?.tournament_id) === String(selectedSeasonValue))
  }, [isCombinedView, sourceMode, gameFielders, seasonFielders, selectedTournamentValue, selectedSeasonValue, gameById])

  const ownerDraftPicks = useMemo(() => {
    const mappedSeasonRoster = seasonRoster
      .filter((pick) => (
        isCombinedView
          ? true
          : !ownerSeasonId || String(pick.season_id) === String(ownerSeasonId)
      ))
      .map((pick, index) => ({
        ...pick,
        id: `season-roster-${pick.id}`,
        tournament_id: pick.season_id,
        player_id: seasonTeams.find((team) => team.id === pick.team_id)?.player_id || null,
        character_id: characters.find((character) => character.name === pick.character_name)?.id || null,
        pick_number: index + 1,
      }))

    if (isCombinedView) {
      return [...draftPicks, ...mappedSeasonRoster]
    }
    if (sourceMode === 'seasons') {
      return mappedSeasonRoster
    }
    return draftPicks.filter((pick) => String(pick.tournament_id) === String(ownerTournamentId))
  }, [sourceMode, isCombinedView, seasonRoster, ownerSeasonId, seasonTeams, characters, draftPicks, ownerTournamentId])

  const identitiesByPlayerId = useMemo(
    () => buildTournamentTeamIdentityMap(ownerDraftPicks, charactersById, {}, playersById),
    [charactersById, ownerDraftPicks, playersById],
  )

  const standings = useMemo(() => buildStandings(filteredGames, players), [filteredGames, players])
  const paByPlayer = useMemo(() => groupBy(filteredPas, 'player_id'), [filteredPas])
  const pitchingByPlayer = useMemo(() => groupBy(filteredPitching, 'player_id'), [filteredPitching])
  const allCharacterHistory = useMemo(
    () => buildCharacterHistory([...plateAppearances, ...seasonPlateAppearances], [...pitchingStints, ...seasonPitchingStints]),
    [plateAppearances, seasonPlateAppearances, pitchingStints, seasonPitchingStints],
  )
  const filteredCharacterHistory = useMemo(() => buildCharacterHistory(filteredPas, filteredPitching), [filteredPas, filteredPitching])
  const fieldingSummary = useMemo(
    () => summarizeFielding({ plateAppearances: filteredPas, gameFielders: filteredFielders, players }),
    [filteredPas, filteredFielders, players],
  )
  const fieldingRows = useMemo(
    () => buildFieldingRows({ plateAppearances: filteredPas, gameFielders: filteredFielders, players, charactersByName }),
    [charactersByName, filteredPas, filteredFielders, players],
  )

  const historySourceMetaById = useMemo(() => {
    const meta = {}

    if (isCombinedView || sourceMode === 'tournaments') {
      tournaments.forEach((tournament) => {
        meta[`tournament-${tournament.id}`] = {
          sourceId: `tournament-${tournament.id}`,
          sourceLabel: `Tournament ${tournament.tournament_number}`,
          sourceType: 'tournament',
          sortGroup: 0,
          sortValue: Number(tournament.tournament_number) || 0,
        }
      })
    }

    if (isCombinedView || sourceMode === 'seasons') {
      seasons.forEach((season, index) => {
        meta[`season-${season.id}`] = {
          sourceId: `season-${season.id}`,
          sourceLabel: season.name || `Season ${index + 1}`,
          sourceType: 'season',
          sortGroup: isCombinedView ? 1 : 0,
          sortValue: new Date(season.created_at || 0).getTime() || Number(season.id) || 0,
          seasonLabel: formatSeasonLabel(season.status || ''),
        }
      })
    }

    return meta
  }, [isCombinedView, seasons, sourceMode, tournaments])

  const sortHistoryEntries = (a, b) => {
    if ((a.sortGroup || 0) !== (b.sortGroup || 0)) return (a.sortGroup || 0) - (b.sortGroup || 0)
    return (b.sortValue || 0) - (a.sortValue || 0)
  }

  const battingHistoryByCharacter = useMemo(() => {
    const byCharacterSource = {}

    const collect = (appearances, type) => {
      appearances.forEach((pa) => {
        const game = gameById[pa.game_id]
        if (!game || !pa.character_id) return
        const sourceId = `${type}-${game.tournament_id}`
        const meta = historySourceMetaById[sourceId]
        if (!meta) return
        if (!byCharacterSource[pa.character_id]) byCharacterSource[pa.character_id] = {}
        if (!byCharacterSource[pa.character_id][sourceId]) byCharacterSource[pa.character_id][sourceId] = []
        byCharacterSource[pa.character_id][sourceId].push(pa)
      })
    }

    if (isCombinedView || sourceMode === 'tournaments') collect(plateAppearances, 'tournament')
    if (isCombinedView || sourceMode === 'seasons') collect(seasonPlateAppearances, 'season')

    return Object.fromEntries(
      Object.entries(byCharacterSource).map(([characterId, bySource]) => [
        characterId,
        Object.entries(bySource)
          .map(([sourceId, rawPas]) => {
            const batting = summarizeBatting(rawPas)
            batting.ops = batting.obp + batting.slg
            return {
              ...historySourceMetaById[sourceId],
              games: batting.games,
              pa: rawPas.length,
              avg: batting.avg,
              ops: batting.ops,
              hr: batting.homeRuns,
              rbi: batting.rbi,
              rawPas,
            }
          })
          .sort(sortHistoryEntries),
      ]),
    )
  }, [gameById, historySourceMetaById, isCombinedView, plateAppearances, seasonPlateAppearances, sourceMode])

  const pitchingHistoryByCharacter = useMemo(() => {
    const byCharacterSource = {}

    const collect = (stints, type) => {
      stints.forEach((stint) => {
        const game = gameById[stint.game_id]
        if (!game || !stint.character_id) return
        const sourceId = `${type}-${game.tournament_id}`
        const meta = historySourceMetaById[sourceId]
        if (!meta) return
        if (!byCharacterSource[stint.character_id]) byCharacterSource[stint.character_id] = {}
        if (!byCharacterSource[stint.character_id][sourceId]) byCharacterSource[stint.character_id][sourceId] = []
        byCharacterSource[stint.character_id][sourceId].push(stint)
      })
    }

    if (isCombinedView || sourceMode === 'tournaments') collect(pitchingStints, 'tournament')
    if (isCombinedView || sourceMode === 'seasons') collect(seasonPitchingStints, 'season')

    return Object.fromEntries(
      Object.entries(byCharacterSource).map(([characterId, bySource]) => [
        characterId,
        Object.entries(bySource)
          .map(([sourceId, rawStints]) => ({
            ...historySourceMetaById[sourceId],
            rawStints,
            ...summarizePitching(rawStints),
          }))
          .sort(sortHistoryEntries),
      ]),
    )
  }, [gameById, historySourceMetaById, isCombinedView, pitchingStints, seasonPitchingStints, sourceMode])

  const playerFieldingById = useMemo(
    () => Object.fromEntries(fieldingRows.playerRows.map((row) => [String(row.playerId), row])),
    [fieldingRows.playerRows],
  )
  const characterFieldingByName = useMemo(
    () => Object.fromEntries(fieldingRows.characterRows.map((row) => [row.name, row])),
    [fieldingRows.characterRows],
  )
  const playerRows = useMemo(() => standings.map((standing) => {
    const battingPas = paByPlayer[standing.playerId] || []
    const playerStints = pitchingByPlayer[standing.playerId] || []
    const pitchingPas = filteredPas.filter((pa) => String(pa.pitcher_player_id) === String(standing.playerId))
    const batting = summarizeBatting(battingPas)
    batting.ops = batting.obp + batting.slg
    const pitching = summarizePitching(playerStints)
    const advancedBatting = sanitizeMetrics(summarizeAdvancedBatting(battingPas, leagueConstants))
    const advancedPitching = sanitizeMetrics(summarizeAdvancedPitching(playerStints, leagueConstants))
    const starHit = summarizeStarHits(battingPas)
    const pitchingPaIds = new Set(pitchingPas.map((pa) => String(pa.id)))
    const pitcherPitches = filteredPitches.filter((pitch) => pitchingPaIds.has(String(pitch.pa_id)))
    const starPitch = summarizeStarPitching(pitchingPas, pitcherPitches)

    const batterPaIds = new Set(battingPas.map((pa) => String(pa.id)))
    const batterPitches = filteredPitches.filter((pitch) => batterPaIds.has(String(pitch.pa_id)))
    const distanceProfile = summarizeHitDistance(battingPas)
    const exitVeloProfile = summarizeExitVelocity(battingPas)
    const contactQuality = summarizeContactQuality(battingPas)
    const expectedBatting = summarizeExpectedBatting(battingPas, expectedOutcomeModel)

    return {
      ...standing,
      gamesPlayed: standing.wins + standing.losses,
      batting,
      advancedBatting,
      pitching,
      advancedPitching,
      pitchingThresholdIp: inningsAsDecimal(pitching.innings || 0),
      starHit,
      starPitch,
      fielding: playerFieldingById[String(standing.playerId)] || createEmptyFieldingRow({ playerId: standing.playerId, name: standing.name }),
      battedBall: summarizeBattedBallProfile(battingPas),
      sprayProfile: summarizeSprayProfile(battingPas),
      hitLocations: summarizeHitLocations(battingPas),
      distanceProfile,
      exitVeloProfile,
      contactQuality,
      expectedBatting,
      hitPowerIndex: calculateHitPowerIndex(distanceProfile),
      parkAdjustedDistance: calculateParkAdjustedDistance(battingPas, filteredPas),
      plateDiscipline: summarizePlateDiscipline(battingPas, batterPitches),
      pitchingBattedBall: summarizeBattedBallProfile(pitchingPas),
      pitchingSpray: summarizeSprayProfile(pitchingPas),
      pitchingHitLocations: summarizeHitLocations(pitchingPas),
      pitchMix: summarizePitchMix(pitchingPas, pitcherPitches),
      pitchingBf: pitchingPas.length,
    }
  }), [expectedOutcomeModel, filteredPas, filteredPitches, leagueConstants, paByPlayer, pitchingByPlayer, playerFieldingById, standings])

  const characterRows = useMemo(() => characters.map((character) => {
    const battingPas = filteredPas.filter((pa) => pa.character_id === character.id)
    const characterStints = filteredPitching.filter((stint) => stint.character_id === character.id)
    const pitchingPas = filteredPas.filter((pa) => pa.pitcher_id === character.id)
    const batting = filteredCharacterHistory[character.id]?.batting || summarizeBatting([])
    batting.rawPas = battingPas
    batting.ops = batting.obp + batting.slg
    const pitching = filteredCharacterHistory[character.id]?.pitching || summarizePitching([])
    pitching.rawPas = pitchingPas
    pitching.rawStints = characterStints
    const allTimeBatting = allCharacterHistory[character.id]?.batting || summarizeBatting([])
    allTimeBatting.rawPas = [...plateAppearances, ...seasonPlateAppearances].filter((pa) => pa.character_id === character.id)
    allTimeBatting.ops = allTimeBatting.obp + allTimeBatting.slg
    const allTimePitching = allCharacterHistory[character.id]?.pitching || summarizePitching([])
    allTimePitching.rawPas = [...plateAppearances, ...seasonPlateAppearances].filter((pa) => pa.pitcher_id === character.id)
    allTimePitching.rawStints = [...pitchingStints, ...seasonPitchingStints].filter((stint) => stint.character_id === character.id)
    const allPicks = draftPicks.filter((pick) => pick.character_id === character.id)
    const currentOwner = ownerDraftPicks.find((pick) => pick.character_id === character.id) || allPicks.at(-1) || null
    const tournamentIdsDrafted = [...new Set(allPicks.map((pick) => String(pick.tournament_id)))]
    const championshipsWon = tournamentIdsDrafted.filter((tournamentId) =>
      tournaments.some(
        (tournament) =>
          String(tournament.id) === tournamentId &&
          allPicks.some((pick) => String(pick.tournament_id) === tournamentId && pick.player_id === tournament.champion_player_id),
      ),
    ).length

    const charPitcherPitches = filteredPitches.filter((pitch) => pitch.pitcher_id === character.name)
    const charBatterPaIds = new Set(battingPas.map((pa) => String(pa.id)))
    const charBatterPitches = filteredPitches.filter((pitch) => charBatterPaIds.has(String(pitch.pa_id)))
    const distanceProfile = summarizeHitDistance(battingPas)
    const exitVeloProfile = summarizeExitVelocity(battingPas)
    const contactQuality = summarizeContactQuality(battingPas)
    const expectedBatting = summarizeExpectedBatting(battingPas, expectedOutcomeModel)

    return {
      ...character,
      miiColor: currentOwner?.mii_color || null,
      mii_color: currentOwner?.mii_color || null,
      battingRating: character.batting,
      pitchingRating: character.pitching,
      fieldingRating: character.fielding,
      speedRating: character.speed,
      batting,
      pitching,
      allTimeBatting,
      allTimePitching,
      advancedBatting: sanitizeMetrics(summarizeAdvancedBatting(battingPas, leagueConstants)),
      advancedPitching: sanitizeMetrics(summarizeAdvancedPitching(characterStints, leagueConstants)),
      pitchingThresholdIp: inningsAsDecimal(pitching.innings || 0),
      starHit: summarizeStarHits(battingPas),
      starPitch: summarizeStarPitching(pitchingPas, charPitcherPitches),
      fielding: characterFieldingByName[character.name] || createEmptyFieldingRow({ id: character.id, name: character.name }),
      currentOwner,
      ownerName: getTeamShortName(identitiesByPlayerId[currentOwner?.player_id]) || playersById[currentOwner?.player_id]?.name || 'Undrafted',
      totalDrafts: allPicks.length,
      tournamentsDrafted: tournamentIdsDrafted.length,
      championshipsWon,
      intrinsics: buildCharacterIntrinsics(character),
      battedBall: summarizeBattedBallProfile(battingPas),
      sprayProfile: summarizeSprayProfile(battingPas),
      hitLocations: summarizeHitLocations(battingPas),
      distanceProfile,
      exitVeloProfile,
      contactQuality,
      expectedBatting,
      hitPowerIndex: calculateHitPowerIndex(distanceProfile),
      parkAdjustedDistance: calculateParkAdjustedDistance(battingPas, filteredPas),
      plateDiscipline: summarizePlateDiscipline(battingPas, charBatterPitches),
      pitchingBattedBall: summarizeBattedBallProfile(pitchingPas),
      pitchingSpray: summarizeSprayProfile(pitchingPas),
      pitchingHitLocations: summarizeHitLocations(pitchingPas),
      pitchMix: summarizePitchMix(pitchingPas, charPitcherPitches),
      pitchingBf: pitchingPas.length,
    }
  }), [allCharacterHistory, characters, characterFieldingByName, draftPicks, expectedOutcomeModel, filteredCharacterHistory, filteredPas, filteredPitching, filteredPitches, identitiesByPlayerId, leagueConstants, ownerDraftPicks, pitchingStints, plateAppearances, playersById, seasonPitchingStints, seasonPlateAppearances, tournaments])

  const openCharacterPage = useCallback((characterId) => {
    const row = characterRows.find((entry) => entry.id === characterId)
    if (!row) return
    navigate(`/character/${characterId}`, {
      state: {
        character: row,
        allCharactersById: charactersByName,
        playersById,
        identitiesByPlayerId,
        currentOwner: row.currentOwner,
        totalDrafts: row.totalDrafts,
        tournamentsDrafted: row.tournamentsDrafted,
        championshipsWon: row.championshipsWon,
        characterIntrinsics: row.intrinsics,
        rosterNames: [],
        profileData: {
          fullPreset: {
            currentTournamentBatting: row.batting,
            currentTournamentPitching: row.pitching,
            allTimeBatting: row.allTimeBatting,
            allTimePitching: row.allTimePitching,
            allPitches: filteredPitches,
            battingHistory: battingHistoryByCharacter[characterId] || [],
            pitchingHistory: pitchingHistoryByCharacter[characterId] || [],
            // expectedOutcomeModel itself holds a closure (its `estimate` function), which
            // history.pushState can't carry through router nav state — pass the raw league
            // sample instead; useCharacterProfileData rebuilds the model from it.
            leagueBattedBallsForModel: filteredPas,
          },
        },
      },
    })
  }, [characterRows, navigate, charactersByName, playersById, identitiesByPlayerId, filteredPitches, filteredPas, battingHistoryByCharacter, pitchingHistoryByCharacter])

  const selectedPlayerCard = useMemo(
    () => playerRows.find((row) => String(row.playerId) === String(selectedPlayerCardId)) || null,
    [playerRows, selectedPlayerCardId],
  )

  const advancedBattingQualifiers = useMemo(() => playerRows.filter(qualifiesAdvancedBatting), [playerRows])
  const advancedPitchingQualifiers = useMemo(() => playerRows.filter(qualifiesAdvancedPitching), [playerRows])
  const leaguePitchingSummary = useMemo(
    () => sanitizeMetrics(summarizeAdvancedPitching(filteredPitching, leagueConstants)),
    [filteredPitching, leagueConstants],
  )

  const leagueBattingRow = useMemo(() => ({
    playerId: 'league-batting',
    name: 'League Avg',
    isLeagueRow: true,
    batting: { plateAppearances: filteredPas.length },
    advancedBatting: { babip: null, iso: null, woba: leagueConstants.lgwOBA, wrcPlus: 100, opsPlus: 100, kPct: null, bbPct: null, bbkRatio: null, xbh: null, xbhPct: null, hrPerPa: null, rc3: null },
  }), [filteredPas.length, leagueConstants])

  const leaguePitchingRow = useMemo(() => ({
    playerId: 'league-pitching',
    name: 'League Avg',
    isLeagueRow: true,
    pitching: { innings: filteredPitching.reduce((sum, stint) => sum + Number(stint.innings_pitched || 0), 0) },
    advancedPitching: leaguePitchingSummary,
  }), [filteredPitching, leaguePitchingSummary])

  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])

  const gameToStadiumNameMap = useMemo(() => {
    const stadiumById = Object.fromEntries(stadiums.map((s) => [String(s.id), s]))
    const result = {}
    for (const game of [...games, ...seasonGames]) {
      if (game.stadium_id && stadiumById[String(game.stadium_id)]) {
        result[String(game.id)] = stadiumById[String(game.stadium_id)].name
      } else if (game.stadium) {
        result[String(game.id)] = game.stadium
      }
    }
    for (const entry of stadiumGameLog) {
      const gameId = String(entry.game_id)
      if (!result[gameId] && entry.stadium_id && stadiumById[String(entry.stadium_id)]) {
        result[gameId] = stadiumById[String(entry.stadium_id)].name
      }
    }
    return result
  }, [games, seasonGames, stadiums, stadiumGameLog])

  const stadiumStats = useMemo(() => {
    const byStadium = {}
    for (const pa of filteredPas) {
      const stadiumName = gameToStadiumNameMap[String(pa.game_id)]
      if (!stadiumName) continue
      if (!byStadium[stadiumName]) byStadium[stadiumName] = []
      byStadium[stadiumName].push(pa)
    }
    const result = {}
    for (const [stadiumName, pas] of Object.entries(byStadium)) {
      const batting = summarizeBatting(pas)
      batting.ops = batting.obp + batting.slg
      result[stadiumName] = { stadiumName, pas, batting, gamesPlayed: new Set(pas.map((pa) => pa.game_id)).size }
    }
    return result
  }, [filteredPas, gameToStadiumNameMap])

  const gameIsNightMap = useMemo(() => {
    const result = {}
    for (const game of [...games, ...seasonGames]) {
      result[String(game.id)] = Boolean(game.is_night)
    }
    return result
  }, [games, seasonGames])

  const selectedStadiumPas = useMemo(() => {
    let pas = selectedStadiumKey
      ? filteredPas.filter((pa) => gameToStadiumNameMap[String(pa.game_id)] === selectedStadiumKey)
      : filteredPas
    if (ballparkTimeFilter === 'day') pas = pas.filter((pa) => !gameIsNightMap[String(pa.game_id)])
    if (ballparkTimeFilter === 'night') pas = pas.filter((pa) => gameIsNightMap[String(pa.game_id)])
    return pas
  }, [filteredPas, selectedStadiumKey, gameToStadiumNameMap, ballparkTimeFilter, gameIsNightMap])

  const selectedStadiumStints = useMemo(() => {
    const stadiumGameIds = selectedStadiumKey
      ? new Set(Object.entries(gameToStadiumNameMap).filter(([, name]) => name === selectedStadiumKey).map(([id]) => id))
      : null
    let stints = stadiumGameIds
      ? filteredPitching.filter((stint) => stadiumGameIds.has(String(stint.game_id)))
      : filteredPitching
    if (ballparkTimeFilter === 'day') stints = stints.filter((stint) => !gameIsNightMap[String(stint.game_id)])
    if (ballparkTimeFilter === 'night') stints = stints.filter((stint) => gameIsNightMap[String(stint.game_id)])
    return stints
  }, [filteredPitching, selectedStadiumKey, gameToStadiumNameMap, ballparkTimeFilter, gameIsNightMap])

  const ballparkPlayerBattingRows = useMemo(() => {
    const byPlayer = groupBy(selectedStadiumPas, 'player_id')
    return Object.entries(byPlayer).map(([playerId, pas]) => {
      const player = playersById[playerId]
      const batting = summarizeBatting(pas)
      batting.ops = batting.obp + batting.slg
      return { playerId, name: player?.name || 'Unknown', batting, gamesAtPark: new Set(pas.map((pa) => pa.game_id)).size }
    }).filter((row) => row.batting.plateAppearances > 0)
  }, [selectedStadiumPas, playersById])

  const ballparkPlayerPitchingRows = useMemo(() => {
    const byPlayer = groupBy(selectedStadiumStints, 'player_id')
    return Object.entries(byPlayer).map(([playerId, stints]) => {
      const player = playersById[playerId]
      const pitching = summarizePitching(stints)
      return { playerId, name: player?.name || 'Unknown', pitching }
    }).filter(hasPitchingData)
  }, [selectedStadiumStints, playersById])

  const ballparkCharacterBattingRows = useMemo(() => {
    const byChar = groupBy(selectedStadiumPas, 'character_id')
    return Object.entries(byChar).map(([charId, pas]) => {
      const char = characters.find((c) => String(c.id) === String(charId))
      const batting = summarizeBatting(pas)
      batting.ops = batting.obp + batting.slg
      return { id: char?.id || charId, name: char?.name || 'Unknown', batting }
    }).filter((row) => row.batting.plateAppearances > 0)
  }, [selectedStadiumPas, characters])

  const ballparkCharacterPitchingRows = useMemo(() => {
    const byChar = groupBy(selectedStadiumStints, 'character_id')
    return Object.entries(byChar).map(([charId, stints]) => {
      const char = characters.find((c) => String(c.id) === String(charId))
      const pitching = summarizePitching(stints)
      return { id: char?.id || charId, name: char?.name || 'Unknown', pitching }
    }).filter(hasPitchingData)
  }, [selectedStadiumStints, characters])

  const parkFactors = useMemo(() => {
    if (!selectedStadiumKey || !selectedStadiumPas.length) return null
    const timeFilteredLeaguePas = ballparkTimeFilter === 'day'
      ? filteredPas.filter((pa) => !gameIsNightMap[String(pa.game_id)])
      : ballparkTimeFilter === 'night'
        ? filteredPas.filter((pa) => gameIsNightMap[String(pa.game_id)])
        : filteredPas
    return calculateParkFactors(selectedStadiumPas, timeFilteredLeaguePas)
  }, [selectedStadiumKey, selectedStadiumPas, filteredPas, ballparkTimeFilter, gameIsNightMap])

  const timeFilteredAllPas = useMemo(() => {
    if (ballparkTimeFilter === 'day') return filteredPas.filter((pa) => !gameIsNightMap[String(pa.game_id)])
    if (ballparkTimeFilter === 'night') return filteredPas.filter((pa) => gameIsNightMap[String(pa.game_id)])
    return filteredPas
  }, [filteredPas, ballparkTimeFilter, gameIsNightMap])

  const allStadiumPasByName = useMemo(() => {
    const byStadium = {}
    for (const pa of timeFilteredAllPas) {
      const stadiumName = gameToStadiumNameMap[String(pa.game_id)]
      if (!stadiumName) continue
      if (!byStadium[stadiumName]) byStadium[stadiumName] = []
      byStadium[stadiumName].push(pa)
    }
    return byStadium
  }, [timeFilteredAllPas, gameToStadiumNameMap])

  const parkFactorRankings = useMemo(() => {
    if (!selectedStadiumKey || !parkFactors) return null
    const allStadiumNames = Object.keys(allStadiumPasByName)
    const factorsByStadium = allStadiumNames.map((name) => ({
      name,
      factors: calculateParkFactors(allStadiumPasByName[name], timeFilteredAllPas),
    }))
    const ranks = {}
    for (const stat of Object.keys(parkFactors)) {
      const sorted = [...factorsByStadium].sort((a, b) => b.factors[stat] - a.factors[stat])
      const rank = sorted.findIndex((entry) => entry.name === selectedStadiumKey) + 1
      ranks[stat] = { rank, total: sorted.length }
    }
    return ranks
  }, [selectedStadiumKey, parkFactors, allStadiumPasByName, timeFilteredAllPas])

  const teamParkFactorRows = useMemo(() => {
    if (!selectedStadiumKey) return []
    const byPlayerAtPark = groupBy(selectedStadiumPas, 'player_id')
    const byPlayerAll = groupBy(timeFilteredAllPas, 'player_id')
    const byPlayerStintsAtPark = groupBy(selectedStadiumStints, 'player_id')
    const timeFilteredAllStints = ballparkTimeFilter === 'day'
      ? filteredPitching.filter((s) => !gameIsNightMap[String(s.game_id)])
      : ballparkTimeFilter === 'night'
        ? filteredPitching.filter((s) => gameIsNightMap[String(s.game_id)])
        : filteredPitching
    const byPlayerStintsAll = groupBy(timeFilteredAllStints, 'player_id')
    return Object.entries(byPlayerAtPark).map(([playerId, parkPas]) => {
      const allPas = byPlayerAll[playerId] || []
      const parkBatting = summarizeBatting(parkPas)
      parkBatting.ops = parkBatting.obp + parkBatting.slg
      const overallBatting = summarizeBatting(allPas)
      overallBatting.ops = overallBatting.obp + overallBatting.slg
      const player = playersById[playerId]
      const parkHrPa = parkBatting.plateAppearances ? parkBatting.homeRuns / parkBatting.plateAppearances : 0
      const overallHrPa = overallBatting.plateAppearances ? overallBatting.homeRuns / overallBatting.plateAppearances : 0
      const parkPitching = summarizePitching(byPlayerStintsAtPark[playerId] || [])
      const overallPitching = summarizePitching(byPlayerStintsAll[playerId] || [])
      return {
        playerId,
        name: player?.name || 'Unknown',
        parkPa: parkBatting.plateAppearances,
        parkAvg: parkBatting.avg,
        parkOps: parkBatting.ops,
        parkHrPa,
        overallAvg: overallBatting.avg,
        overallOps: overallBatting.ops,
        overallHrPa,
        opsDiff: parkBatting.ops - overallBatting.ops,
        avgDiff: parkBatting.avg - overallBatting.avg,
        hrPaDiff: parkHrPa - overallHrPa,
        parkPitching,
        overallPitching,
        eraAtPark: parkPitching.era,
        eraOverall: overallPitching.era,
        eraDiff: (Number.isFinite(parkPitching.era) && Number.isFinite(overallPitching.era)) ? parkPitching.era - overallPitching.era : null,
        whipAtPark: parkPitching.whip,
        whipOverall: overallPitching.whip,
        whipDiff: (Number.isFinite(parkPitching.whip) && Number.isFinite(overallPitching.whip)) ? parkPitching.whip - overallPitching.whip : null,
        parkIp: parkPitching.innings,
      }
    }).filter((row) => row.parkPa >= 3 || row.parkIp > 0)
  }, [selectedStadiumKey, selectedStadiumPas, selectedStadiumStints, timeFilteredAllPas, filteredPitching, ballparkTimeFilter, gameIsNightMap, playersById])

  const charParkFactorRows = useMemo(() => {
    if (!selectedStadiumKey) return []
    const byCharAtPark = groupBy(selectedStadiumPas, 'character_id')
    const byCharAll = groupBy(timeFilteredAllPas, 'character_id')
    const byCharStintsAtPark = groupBy(selectedStadiumStints, 'character_id')
    const timeFilteredAllStints = ballparkTimeFilter === 'day'
      ? filteredPitching.filter((s) => !gameIsNightMap[String(s.game_id)])
      : ballparkTimeFilter === 'night'
        ? filteredPitching.filter((s) => gameIsNightMap[String(s.game_id)])
        : filteredPitching
    const byCharStintsAll = groupBy(timeFilteredAllStints, 'character_id')
    return Object.entries(byCharAtPark).map(([charId, parkPas]) => {
      const allPas = byCharAll[charId] || []
      const char = characters.find((c) => String(c.id) === String(charId))
      const parkBatting = summarizeBatting(parkPas)
      parkBatting.ops = parkBatting.obp + parkBatting.slg
      const overallBatting = summarizeBatting(allPas)
      overallBatting.ops = overallBatting.obp + overallBatting.slg
      const parkHrPa = parkBatting.plateAppearances ? parkBatting.homeRuns / parkBatting.plateAppearances : 0
      const overallHrPa = overallBatting.plateAppearances ? overallBatting.homeRuns / overallBatting.plateAppearances : 0
      const parkPitching = summarizePitching(byCharStintsAtPark[charId] || [])
      const overallPitching = summarizePitching(byCharStintsAll[charId] || [])
      return {
        id: char?.id || charId,
        name: char?.name || 'Unknown',
        parkPa: parkBatting.plateAppearances,
        parkAvg: parkBatting.avg,
        parkOps: parkBatting.ops,
        parkHrPa,
        overallAvg: overallBatting.avg,
        overallOps: overallBatting.ops,
        overallHrPa,
        opsDiff: parkBatting.ops - overallBatting.ops,
        avgDiff: parkBatting.avg - overallBatting.avg,
        hrPaDiff: parkHrPa - overallHrPa,
        parkPitching,
        overallPitching,
        eraAtPark: parkPitching.era,
        eraOverall: overallPitching.era,
        eraDiff: (Number.isFinite(parkPitching.era) && Number.isFinite(overallPitching.era)) ? parkPitching.era - overallPitching.era : null,
        whipAtPark: parkPitching.whip,
        whipOverall: overallPitching.whip,
        whipDiff: (Number.isFinite(parkPitching.whip) && Number.isFinite(overallPitching.whip)) ? parkPitching.whip - overallPitching.whip : null,
        parkIp: parkPitching.innings,
      }
    }).filter((row) => row.parkPa >= 3 || row.parkIp > 0)
  }, [selectedStadiumKey, selectedStadiumPas, selectedStadiumStints, timeFilteredAllPas, filteredPitching, ballparkTimeFilter, gameIsNightMap, characters])

  const toggleSort = (setter, column) => {
    setter((current) => (
      current.key === column.key
        ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, direction: column.type === 'string' ? 'asc' : (column.defaultDirection || 'desc') }
    ))
  }

  const positiveMetric = (value) => <ValueBadge color={getPositiveMetricColor(value)} value={Number.isFinite(value) ? value : '-'} />
  const inverseMetric = (value) => <ValueBadge color={getInverseMetricColor(value)} value={Number.isFinite(value) ? value : '-'} />

  const playerColumns = useMemo(() => ({
    batting: [
      { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
      { key: 'gamesPlayed', group: 'Record', label: 'G', sortValue: (row) => row.gamesPlayed, value: (row) => row.gamesPlayed },
      { key: 'runsFor', group: 'Runs', label: 'RS', sortValue: (row) => row.runsFor, value: (row) => row.runsFor },
      { key: 'runsAgainst', group: 'Runs', label: 'RA', sortValue: (row) => row.runsAgainst, value: (row) => row.runsAgainst },
      { key: 'runDiff', group: 'Runs', label: 'RD', sortValue: (row) => row.runDiff, value: (row) => row.runDiff },
      { key: 'plateAppearances', group: 'Batting', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
      { key: 'atBats', group: 'Batting', label: 'AB', sortValue: (row) => row.batting.atBats, value: (row) => row.batting.atBats },
      { key: 'hits', group: 'Batting', label: 'H', sortValue: (row) => row.batting.hits, value: (row) => row.batting.hits },
      { key: 'singles', group: 'Batting', label: '1B', sortValue: (row) => row.batting.singles, value: (row) => row.batting.singles },
      { key: 'doubles', group: 'Batting', label: '2B', sortValue: (row) => row.batting.doubles, value: (row) => row.batting.doubles },
      { key: 'triples', group: 'Batting', label: '3B', sortValue: (row) => row.batting.triples, value: (row) => row.batting.triples },
      { key: 'homeRuns', group: 'Batting', label: 'HR', sortValue: (row) => row.batting.homeRuns, value: (row) => row.batting.homeRuns },
      { key: 'runs', group: 'Batting', label: 'R', sortValue: (row) => row.batting.runs, value: (row) => row.batting.runs },
      { key: 'rbi', group: 'Batting', label: 'RBI', sortValue: (row) => row.batting.rbi, value: (row) => row.batting.rbi },
      { key: 'walks', group: 'Discipline', label: 'BB', sortValue: (row) => row.batting.walks, value: (row) => row.batting.walks },
      { key: 'hbp', group: 'Discipline', label: 'HBP', sortValue: (row) => row.batting.hbp, value: (row) => row.batting.hbp },
      { key: 'strikeouts', group: 'Discipline', label: 'SO', sortValue: (row) => row.batting.strikeouts, value: (row) => row.batting.strikeouts },
      { key: 'sacrificeFlies', group: 'Situational', label: 'SF', sortValue: (row) => row.batting.sacrificeFlies, value: (row) => row.batting.sacrificeFlies },
      { key: 'sacrificeHits', group: 'Situational', label: 'SH', sortValue: (row) => row.batting.sacrificeHits, value: (row) => row.batting.sacrificeHits },
      { key: 'totalBases', group: 'Situational', label: 'TB', sortValue: (row) => row.batting.totalBases, value: (row) => row.batting.totalBases },
      { key: 'avg', group: 'Rates', label: 'AVG', sortValue: (row) => row.batting.avg, value: (row) => formatDecimal(row.batting.avg) },
      { key: 'obp', group: 'Rates', label: 'OBP', sortValue: (row) => row.batting.obp, value: (row) => formatDecimal(row.batting.obp) },
      { key: 'slg', group: 'Rates', label: 'SLG', sortValue: (row) => row.batting.slg, value: (row) => formatDecimal(row.batting.slg) },
      { key: 'ops', group: 'Rates', label: 'OPS', sortValue: (row) => row.batting.ops, value: (row) => formatDecimal(row.batting.ops) },
      { key: 'babip', group: 'Advanced', label: 'BABIP', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.babip : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.babip) : '--' },
      { key: 'iso', group: 'Advanced', label: 'ISO', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.iso : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.iso) : '--' },
      { key: 'woba', group: 'Advanced', label: 'wOBA', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.woba : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.woba) : '--' },
      { key: 'wrcPlus', group: 'Advanced', label: 'wRC+', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.wrcPlus : null, render: (row) => qualifiesAdvancedBatting(row) ? positiveMetric(row.advancedBatting.wrcPlus) : '--' },
      { key: 'opsPlus', group: 'Advanced', label: 'OPS+', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.opsPlus : null, render: (row) => qualifiesAdvancedBatting(row) ? positiveMetric(row.advancedBatting.opsPlus) : '--' },
      { key: 'kPct', group: 'Advanced', label: 'K%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.kPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.kPct, 1) : '--' },
      { key: 'bbPct', group: 'Advanced', label: 'BB%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.bbPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.bbPct, 1) : '--' },
      { key: 'bbkRatio', group: 'Advanced', label: 'BB/K', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.bbkRatio : null, value: (row) => qualifiesAdvancedBatting(row) ? formatDecimal(row.advancedBatting.bbkRatio, 2) : '--' },
      { key: 'xbh', group: 'Advanced', label: 'XBH', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.xbh : null, value: (row) => qualifiesAdvancedBatting(row) ? formatInteger(row.advancedBatting.xbh) : '--' },
      { key: 'xbhPct', group: 'Advanced', label: 'XBH%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.xbhPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.xbhPct, 1) : '--' },
      { key: 'hrPerPa', group: 'Advanced', label: 'HR/PA', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.hrPerPa : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.hrPerPa) : '--' },
      { key: 'rc3', group: 'Advanced', label: 'RC/3', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.rc3 : null, render: (row) => qualifiesAdvancedBatting(row) ? <span title="Runs Created per 3-inning game">{formatTooltipNumber(row.advancedBatting.rc3, 1)}</span> : '--' },
    ],
    pitching: [
      { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
      { key: 'games', group: 'Usage', label: 'G', sortValue: (row) => row.pitching.games, value: (row) => row.pitching.games },
      { key: 'innings', group: 'Usage', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
      { key: 'wins', group: 'Decisions', label: 'W', sortValue: (row) => row.pitching.wins, value: (row) => row.pitching.wins },
      { key: 'losses', group: 'Decisions', label: 'L', sortValue: (row) => row.pitching.losses, value: (row) => row.pitching.losses },
      { key: 'saves', group: 'Decisions', label: 'SV', sortValue: (row) => row.pitching.saves, value: (row) => row.pitching.saves },
      { key: 'completeGames', group: 'Decisions', label: 'CG', sortValue: (row) => row.pitching.completeGames, value: (row) => row.pitching.completeGames },
      { key: 'shutouts', group: 'Decisions', label: 'SHO', sortValue: (row) => row.pitching.shutouts, value: (row) => row.pitching.shutouts },
      { key: 'strikeouts', group: 'Line', label: 'K', sortValue: (row) => row.pitching.strikeouts, value: (row) => row.pitching.strikeouts },
      { key: 'hitsAllowed', group: 'Line', label: 'H', sortValue: (row) => row.pitching.hitsAllowed, value: (row) => row.pitching.hitsAllowed },
      { key: 'runsAllowed', group: 'Line', label: 'R', sortValue: (row) => row.pitching.runsAllowed, value: (row) => row.pitching.runsAllowed },
      { key: 'earnedRuns', group: 'Line', label: 'ER', sortValue: (row) => row.pitching.earnedRuns, value: (row) => row.pitching.earnedRuns },
      { key: 'walks', group: 'Line', label: 'BB', sortValue: (row) => row.pitching.walks, value: (row) => row.pitching.walks },
      { key: 'homeRunsAllowed', group: 'Line', label: 'HR', sortValue: (row) => row.pitching.homeRunsAllowed, value: (row) => row.pitching.homeRunsAllowed },
      { key: 'era', group: 'Rates', label: 'ERA/3', sortValue: (row) => row.pitching.era, value: (row) => formatDecimal(row.pitching.era, 2) },
      { key: 'whip', group: 'Rates', label: 'WHIP', sortValue: (row) => row.pitching.whip, value: (row) => formatDecimal(row.pitching.whip, 2) },
      { key: 'fip', group: 'Rates', label: 'FIP', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fip : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.fip, 2) : '--' },
      { key: 'fipMinus', group: 'Rates', label: 'FIP-', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fipMinus : null, render: (row) => qualifiesAdvancedPitching(row) ? inverseMetric(row.advancedPitching.fipMinus) : '--' },
      { key: 'eraMinus', group: 'Rates', label: 'ERA-', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.eraMinus : null, render: (row) => qualifiesAdvancedPitching(row) ? inverseMetric(row.advancedPitching.eraMinus) : '--' },
      { key: 'kPer3', group: 'Rates', label: 'K/3', sortValue: (row) => row.pitching.kPer3, value: (row) => formatDecimal(row.pitching.kPer3, 2) },
      { key: 'bb3', group: 'Rates', label: 'BB/3', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.bb3 : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.bb3, 2) : '--' },
      { key: 'h3', group: 'Rates', label: 'H/3', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.h3 : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.h3, 2) : '--' },
      { key: 'hrPer3', group: 'Rates', label: 'HR/3', sortValue: (row) => row.pitching.hrPer3, value: (row) => formatDecimal(row.pitching.hrPer3, 2) },
      { key: 'kPct', group: 'Rates', label: 'K%', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.kPct : null, value: (row) => qualifiesAdvancedPitching(row) ? formatPercent(row.advancedPitching.kPct, 1) : '--' },
      { key: 'bbPct', group: 'Rates', label: 'BB%', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.bbPct : null, value: (row) => qualifiesAdvancedPitching(row) ? formatPercent(row.advancedPitching.bbPct, 1) : '--' },
      { key: 'kBB', group: 'Rates', label: 'K/BB', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.kBB : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.kBB, 2) : '--' },
      { key: 'babipAllowed', group: 'Rates', label: 'BABIP Allowed', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.babipAllowed : null, value: (row) => qualifiesAdvancedPitching(row) ? formatAverageStyle(row.advancedPitching.babipAllowed) : '--' },
    ],
    fielding: [
      { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
      { key: 'games', group: 'Fielding', label: 'G', sortValue: (row) => row.fielding.games, value: (row) => row.fielding.games },
      { key: 'chances', group: 'Fielding', label: 'Chances', sortValue: (row) => row.fielding.chances, value: (row) => row.fielding.chances },
      { key: 'putouts', group: 'Fielding', label: 'PO', sortValue: (row) => row.fielding.putouts, value: (row) => row.fielding.putouts },
      { key: 'assists', group: 'Fielding', label: 'A', sortValue: (row) => row.fielding.assists, value: (row) => row.fielding.assists },
      { key: 'errors', group: 'Fielding', label: 'Errors', sortValue: (row) => row.fielding.errors, value: (row) => row.fielding.errors },
      { key: 'fieldingPct', group: 'Fielding', label: 'Fielding %', sortValue: (row) => row.fielding.fieldingPct, value: (row) => formatAverageStyle(row.fielding.fieldingPct) },
      { key: 'rangeFactor', group: 'Fielding', label: 'Range Factor', sortValue: (row) => row.fielding.rangeFactor, value: (row) => formatDecimal(row.fielding.rangeFactor, 2) },
      { key: 'buddyJumps', group: 'Fielding', label: 'Buddy Jumps', sortValue: (row) => row.fielding.buddyJumps, value: (row) => row.fielding.buddyJumps },
      { key: 'hrRobberies', group: 'Fielding', label: 'HR Rob', sortValue: (row) => row.fielding.hrRobberies, value: (row) => row.fielding.hrRobberies },
    ],
  }), [identitiesByPlayerId, playersById])

  const characterColumns = useMemo(() => ({
    batting: [
      { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
      { key: 'plateAppearances', group: 'Batting', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
      { key: 'atBats', group: 'Batting', label: 'AB', sortValue: (row) => row.batting.atBats, value: (row) => row.batting.atBats },
      { key: 'hits', group: 'Batting', label: 'H', sortValue: (row) => row.batting.hits, value: (row) => row.batting.hits },
      { key: 'singles', group: 'Batting', label: '1B', sortValue: (row) => row.batting.singles, value: (row) => row.batting.singles },
      { key: 'doubles', group: 'Batting', label: '2B', sortValue: (row) => row.batting.doubles, value: (row) => row.batting.doubles },
      { key: 'triples', group: 'Batting', label: '3B', sortValue: (row) => row.batting.triples, value: (row) => row.batting.triples },
      { key: 'homeRuns', group: 'Batting', label: 'HR', sortValue: (row) => row.batting.homeRuns, value: (row) => row.batting.homeRuns },
      { key: 'walks', group: 'Discipline', label: 'BB', sortValue: (row) => row.batting.walks, value: (row) => row.batting.walks },
      { key: 'hbp', group: 'Discipline', label: 'HBP', sortValue: (row) => row.batting.hbp, value: (row) => row.batting.hbp },
      { key: 'strikeouts', group: 'Discipline', label: 'SO', sortValue: (row) => row.batting.strikeouts, value: (row) => row.batting.strikeouts },
      { key: 'runs', group: 'Production', label: 'R', sortValue: (row) => row.batting.runs, value: (row) => row.batting.runs },
      { key: 'rbi', group: 'Production', label: 'RBI', sortValue: (row) => row.batting.rbi, value: (row) => row.batting.rbi },
      { key: 'sacrificeFlies', group: 'Production', label: 'SF', sortValue: (row) => row.batting.sacrificeFlies, value: (row) => row.batting.sacrificeFlies },
      { key: 'sacrificeHits', group: 'Production', label: 'SH', sortValue: (row) => row.batting.sacrificeHits, value: (row) => row.batting.sacrificeHits },
      { key: 'totalBases', group: 'Production', label: 'TB', sortValue: (row) => row.batting.totalBases, value: (row) => row.batting.totalBases },
      { key: 'avg', group: 'Rates', label: 'AVG', sortValue: (row) => row.batting.avg, value: (row) => formatDecimal(row.batting.avg) },
      { key: 'obp', group: 'Rates', label: 'OBP', sortValue: (row) => row.batting.obp, value: (row) => formatDecimal(row.batting.obp) },
      { key: 'slg', group: 'Rates', label: 'SLG', sortValue: (row) => row.batting.slg, value: (row) => formatDecimal(row.batting.slg) },
      { key: 'ops', group: 'Rates', label: 'OPS', sortValue: (row) => row.batting.ops, value: (row) => formatDecimal(row.batting.ops) },
      { key: 'babip', group: 'Advanced', label: 'BABIP', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.babip : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.babip) : '--' },
      { key: 'iso', group: 'Advanced', label: 'ISO', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.iso : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.iso) : '--' },
      { key: 'wrcPlus', group: 'Advanced', label: 'wRC+', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.wrcPlus : null, render: (row) => qualifiesAdvancedBatting(row) ? positiveMetric(row.advancedBatting.wrcPlus) : '--' },
      { key: 'owner', group: 'Identity', label: 'Owner', type: 'string', sortValue: (row) => row.ownerName, render: (row) => row.currentOwner ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.currentOwner.player_id} playersById={playersById} /> : row.ownerName },
    ],
    pitching: [
      { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
      { key: 'games', group: 'Usage', label: 'G', sortValue: (row) => row.pitching.games, value: (row) => row.pitching.games },
      { key: 'innings', group: 'Usage', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
      { key: 'wins', group: 'Decisions', label: 'W', sortValue: (row) => row.pitching.wins, value: (row) => row.pitching.wins },
      { key: 'losses', group: 'Decisions', label: 'L', sortValue: (row) => row.pitching.losses, value: (row) => row.pitching.losses },
      { key: 'saves', group: 'Decisions', label: 'SV', sortValue: (row) => row.pitching.saves, value: (row) => row.pitching.saves },
      { key: 'completeGames', group: 'Decisions', label: 'CG', sortValue: (row) => row.pitching.completeGames, value: (row) => row.pitching.completeGames },
      { key: 'shutouts', group: 'Decisions', label: 'SHO', sortValue: (row) => row.pitching.shutouts, value: (row) => row.pitching.shutouts },
      { key: 'strikeouts', group: 'Line', label: 'K', sortValue: (row) => row.pitching.strikeouts, value: (row) => row.pitching.strikeouts },
      { key: 'hitsAllowed', group: 'Line', label: 'H', sortValue: (row) => row.pitching.hitsAllowed, value: (row) => row.pitching.hitsAllowed },
      { key: 'runsAllowed', group: 'Line', label: 'R', sortValue: (row) => row.pitching.runsAllowed, value: (row) => row.pitching.runsAllowed },
      { key: 'earnedRuns', group: 'Line', label: 'ER', sortValue: (row) => row.pitching.earnedRuns, value: (row) => row.pitching.earnedRuns },
      { key: 'walks', group: 'Line', label: 'BB', sortValue: (row) => row.pitching.walks, value: (row) => row.pitching.walks },
      { key: 'homeRunsAllowed', group: 'Line', label: 'HR', sortValue: (row) => row.pitching.homeRunsAllowed, value: (row) => row.pitching.homeRunsAllowed },
      { key: 'era', group: 'Rates', label: 'ERA/3', sortValue: (row) => row.pitching.era, value: (row) => formatDecimal(row.pitching.era, 2) },
      { key: 'whip', group: 'Rates', label: 'WHIP', sortValue: (row) => row.pitching.whip, value: (row) => formatDecimal(row.pitching.whip, 2) },
      { key: 'fip', group: 'Rates', label: 'FIP', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fip : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.fip, 2) : '--' },
      { key: 'fipMinus', group: 'Rates', label: 'FIP-', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fipMinus : null, render: (row) => qualifiesAdvancedPitching(row) ? inverseMetric(row.advancedPitching.fipMinus) : '--' },
      { key: 'kPer3', group: 'Rates', label: 'K/3', sortValue: (row) => row.pitching.kPer3, value: (row) => formatDecimal(row.pitching.kPer3, 2) },
      { key: 'hrPer3', group: 'Rates', label: 'HR/3', sortValue: (row) => row.pitching.hrPer3, value: (row) => formatDecimal(row.pitching.hrPer3, 2) },
      { key: 'owner', group: 'Identity', label: 'Owner', type: 'string', sortValue: (row) => row.ownerName, render: (row) => row.currentOwner ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.currentOwner.player_id} playersById={playersById} /> : row.ownerName },
    ],
    fielding: [
      { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
      { key: 'games', group: 'Fielding', label: 'G', sortValue: (row) => row.fielding.games, value: (row) => row.fielding.games },
      { key: 'chances', group: 'Fielding', label: 'Chances', sortValue: (row) => row.fielding.chances, value: (row) => row.fielding.chances },
      { key: 'putouts', group: 'Fielding', label: 'PO', sortValue: (row) => row.fielding.putouts, value: (row) => row.fielding.putouts },
      { key: 'assists', group: 'Fielding', label: 'A', sortValue: (row) => row.fielding.assists, value: (row) => row.fielding.assists },
      { key: 'errors', group: 'Fielding', label: 'Errors', sortValue: (row) => row.fielding.errors, value: (row) => row.fielding.errors },
      { key: 'fieldingPct', group: 'Fielding', label: 'Fielding %', sortValue: (row) => row.fielding.fieldingPct, value: (row) => formatAverageStyle(row.fielding.fieldingPct) },
      { key: 'rangeFactor', group: 'Fielding', label: 'Range Factor', sortValue: (row) => row.fielding.rangeFactor, value: (row) => formatDecimal(row.fielding.rangeFactor, 2) },
      { key: 'buddyJumps', group: 'Fielding', label: 'Buddy Jumps', sortValue: (row) => row.fielding.buddyJumps, value: (row) => row.fielding.buddyJumps },
      { key: 'hrRobberies', group: 'Fielding', label: 'HR Rob', sortValue: (row) => row.fielding.hrRobberies, value: (row) => row.fielding.hrRobberies },
      { key: 'owner', group: 'Identity', label: 'Owner', type: 'string', sortValue: (row) => row.ownerName, render: (row) => row.currentOwner ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.currentOwner.player_id} playersById={playersById} /> : row.ownerName },
    ],
  }), [identitiesByPlayerId, playersById])

  // Dedicated Stars rail sections -- batting/pitching star usage gets its own
  // page instead of living duplicated inside the Overview tables.
  const starsBattingPlayerCols = useMemo(() => ([
    { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
    { key: 'starHitUsed', group: 'Stars', label: <><StarIcon />HA</>, sortValue: (row) => row.starHit.used, value: (row) => row.starHit.used },
    { key: 'starHitConnected', group: 'Stars', label: <><StarIcon />HC</>, sortValue: (row) => row.starHit.connected, value: (row) => row.starHit.connected },
    { key: 'starHitSuccessful', group: 'Stars', label: <><StarIcon />HH</>, sortValue: (row) => row.starHit.successful, value: (row) => row.starHit.successful },
    { key: 'starHitRbi', group: 'Stars', label: <><StarIcon />HRBI</>, sortValue: (row) => row.starHit.totalRbi, value: (row) => row.starHit.totalRbi },
    { key: 'starHitSuccessRate', group: 'Stars', label: <><StarIcon />H%</>, sortValue: (row) => row.starHit.successRate, value: (row) => formatPercent(row.starHit.successRate, 1) },
  ]), [identitiesByPlayerId, playersById])
  const starsPitchingPlayerCols = useMemo(() => ([
    { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
    { key: 'starPitchUsed', group: 'Stars', label: <><StarIcon />PA</>, sortValue: (row) => row.starPitch.used, value: (row) => row.starPitch.used },
    { key: 'starPitchPaUsed', group: 'Stars', label: <><StarIcon />PPA</>, sortValue: (row) => row.starPitch.paUsed, value: (row) => row.starPitch.paUsed },
    { key: 'starPitchOuts', group: 'Stars', label: <><StarIcon />PO</>, sortValue: (row) => row.starPitch.outsOnStarPitch, value: (row) => row.starPitch.outsOnStarPitch },
    { key: 'starPitchHits', group: 'Stars', label: <><StarIcon />PH</>, sortValue: (row) => row.starPitch.hitsAllowedOnStarPitch, value: (row) => row.starPitch.hitsAllowedOnStarPitch },
    { key: 'starPitchSuccessRate', group: 'Stars', label: <><StarIcon />P%</>, sortValue: (row) => row.starPitch.successRate, value: (row) => formatPercent(row.starPitch.successRate, 1) },
  ]), [identitiesByPlayerId, playersById])
  const starsBattingCharCols = useMemo(() => ([
    { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
    { key: 'starHitUsed', group: 'Stars', label: <><StarIcon />HA</>, sortValue: (row) => row.starHit.used, value: (row) => row.starHit.used },
    { key: 'starHitConnected', group: 'Stars', label: <><StarIcon />HC</>, sortValue: (row) => row.starHit.connected, value: (row) => row.starHit.connected },
    { key: 'starHitSuccessful', group: 'Stars', label: <><StarIcon />HH</>, sortValue: (row) => row.starHit.successful, value: (row) => row.starHit.successful },
    { key: 'starHitRbi', group: 'Stars', label: <><StarIcon />HRBI</>, sortValue: (row) => row.starHit.totalRbi, value: (row) => row.starHit.totalRbi },
    { key: 'starHitSuccessRate', group: 'Stars', label: <><StarIcon />H%</>, sortValue: (row) => row.starHit.successRate, value: (row) => formatPercent(row.starHit.successRate, 1) },
  ]), [])
  const starsPitchingCharCols = useMemo(() => ([
    { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
    { key: 'starPitchUsed', group: 'Stars', label: <><StarIcon />PA</>, sortValue: (row) => row.starPitch.used, value: (row) => row.starPitch.used },
    { key: 'starPitchPaUsed', group: 'Stars', label: <><StarIcon />PPA</>, sortValue: (row) => row.starPitch.paUsed, value: (row) => row.starPitch.paUsed },
    { key: 'starPitchOuts', group: 'Stars', label: <><StarIcon />PO</>, sortValue: (row) => row.starPitch.outsOnStarPitch, value: (row) => row.starPitch.outsOnStarPitch },
    { key: 'starPitchHits', group: 'Stars', label: <><StarIcon />PH</>, sortValue: (row) => row.starPitch.hitsAllowedOnStarPitch, value: (row) => row.starPitch.hitsAllowedOnStarPitch },
    { key: 'starPitchSuccessRate', group: 'Stars', label: <><StarIcon />P%</>, sortValue: (row) => row.starPitch.successRate, value: (row) => formatPercent(row.starPitch.successRate, 1) },
  ]), [])
  const starsFieldingPlayerCols = useMemo(() => ([
    { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
    { key: 'starHitErrors', group: 'Stars', label: <><StarIcon />Errors</>, sortValue: (row) => row.fielding.starHitErrors, value: (row) => row.fielding.starHitErrors },
    { key: 'adjustedFieldingPct', group: 'Stars', label: <><StarIcon />Adj Fielding %</>, sortValue: (row) => row.fielding.adjustedFieldingPct, value: (row) => formatAverageStyle(row.fielding.adjustedFieldingPct) },
  ]), [identitiesByPlayerId, playersById])
  const starsFieldingCharCols = useMemo(() => ([
    { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> },
    { key: 'starHitErrors', group: 'Stars', label: <><StarIcon />Errors</>, sortValue: (row) => row.fielding.starHitErrors, value: (row) => row.fielding.starHitErrors },
    { key: 'adjustedFieldingPct', group: 'Stars', label: <><StarIcon />Adj Fielding %</>, sortValue: (row) => row.fielding.adjustedFieldingPct, value: (row) => formatAverageStyle(row.fielding.adjustedFieldingPct) },
  ]), [])

  const sortedStarsBattingPlayer = useMemo(() => sortRows(playerRows.filter(hasBattingData), starsBattingPlayerCols, starsBattingPlayerSort, 'name'), [playerRows, starsBattingPlayerCols, starsBattingPlayerSort])
  const sortedStarsPitchingPlayer = useMemo(() => sortRows(playerRows.filter(hasPitchingData), starsPitchingPlayerCols, starsPitchingPlayerSort, 'name'), [playerRows, starsPitchingPlayerCols, starsPitchingPlayerSort])
  const sortedStarsBattingChar = useMemo(() => sortRows(characterRows, starsBattingCharCols, starsBattingCharacterSort, 'name'), [characterRows, starsBattingCharCols, starsBattingCharacterSort])
  const sortedStarsPitchingChar = useMemo(() => sortRows(characterRows, starsPitchingCharCols, starsPitchingCharacterSort, 'name'), [characterRows, starsPitchingCharCols, starsPitchingCharacterSort])
  const sortedStarsFieldingPlayer = useMemo(() => sortRows(playerRows, starsFieldingPlayerCols, starsFieldingPlayerSort, 'name'), [playerRows, starsFieldingPlayerCols, starsFieldingPlayerSort])
  const sortedStarsFieldingChar = useMemo(() => sortRows(characterRows, starsFieldingCharCols, starsFieldingCharacterSort, 'name'), [characterRows, starsFieldingCharCols, starsFieldingCharacterSort])

  const advancedBattingColumns = useMemo(() => ([
    { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 190, sortValue: (row) => row.name, render: (row) => row.isLeagueRow ? <div><div style={{ fontWeight: 800, color: '#FDE68A' }}>League Avg</div><div className="muted" style={{ fontSize: 12 }}>AVG {formatAverageStyle(leagueConstants.lgAVG)} / OBP {formatAverageStyle(leagueConstants.lgOBP)} / SLG {formatAverageStyle(leagueConstants.lgSLG)}</div></div> : <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
    { key: 'plateAppearances', group: 'Profile', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'babip', group: 'Profile', label: 'BABIP', sortValue: (row) => row.advancedBatting.babip, value: (row) => Number.isFinite(row.advancedBatting.babip) ? formatAverageStyle(row.advancedBatting.babip) : '--' },
    { key: 'iso', group: 'Profile', label: 'ISO', sortValue: (row) => row.advancedBatting.iso, value: (row) => Number.isFinite(row.advancedBatting.iso) ? formatAverageStyle(row.advancedBatting.iso) : '--' },
    { key: 'woba', group: 'Profile', label: 'wOBA', sortValue: (row) => row.advancedBatting.woba, value: (row) => Number.isFinite(row.advancedBatting.woba) ? formatAverageStyle(row.advancedBatting.woba) : formatAverageStyle(leagueConstants.lgwOBA) },
    { key: 'wrcPlus', group: 'Profile', label: 'wRC+', sortValue: (row) => row.advancedBatting.wrcPlus, render: (row) => positiveMetric(row.advancedBatting.wrcPlus) },
    { key: 'opsPlus', group: 'Profile', label: 'OPS+', sortValue: (row) => row.advancedBatting.opsPlus, render: (row) => positiveMetric(row.advancedBatting.opsPlus) },
    { key: 'kPct', group: 'Discipline', label: 'K%', sortValue: (row) => row.advancedBatting.kPct, value: (row) => Number.isFinite(row.advancedBatting.kPct) ? formatPercent(row.advancedBatting.kPct, 1) : '--' },
    { key: 'bbPct', group: 'Discipline', label: 'BB%', sortValue: (row) => row.advancedBatting.bbPct, value: (row) => Number.isFinite(row.advancedBatting.bbPct) ? formatPercent(row.advancedBatting.bbPct, 1) : '--' },
    { key: 'bbkRatio', group: 'Discipline', label: 'BB/K', sortValue: (row) => row.advancedBatting.bbkRatio, value: (row) => Number.isFinite(row.advancedBatting.bbkRatio) ? row.advancedBatting.bbkRatio.toFixed(2) : '--' },
    { key: 'xbh', group: 'Power', label: 'XBH', sortValue: (row) => row.advancedBatting.xbh, value: (row) => Number.isFinite(row.advancedBatting.xbh) ? row.advancedBatting.xbh : '--' },
    { key: 'xbhPct', group: 'Power', label: 'XBH%', sortValue: (row) => row.advancedBatting.xbhPct, value: (row) => Number.isFinite(row.advancedBatting.xbhPct) ? formatPercent(row.advancedBatting.xbhPct, 1) : '--' },
    { key: 'hrPerPa', group: 'Power', label: 'HR/PA', sortValue: (row) => row.advancedBatting.hrPerPa, value: (row) => Number.isFinite(row.advancedBatting.hrPerPa) ? formatAverageStyle(row.advancedBatting.hrPerPa) : '--' },
    { key: 'rc3', group: 'Creation', label: 'RC/3', sortValue: (row) => row.advancedBatting.rc3, render: (row) => <span title="Runs Created per 3-inning game">{Number.isFinite(row.advancedBatting.rc3) ? formatTooltipNumber(row.advancedBatting.rc3, 1) : '--'}</span> },
  ]), [identitiesByPlayerId, playersById, leagueConstants])

  const advancedPitchingColumns = useMemo(() => ([
    { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 190, sortValue: (row) => row.name, render: (row) => row.isLeagueRow ? <div><div style={{ fontWeight: 800, color: '#FDE68A' }}>League Avg</div><div className="muted" style={{ fontSize: 12 }}>ERA/3 {formatDecimal(leagueConstants.lgERA, 2)} / FIP {formatDecimal(leaguePitchingSummary.fip, 2)}</div></div> : <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> },
    { key: 'innings', group: 'Workload', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
    { key: 'era3', group: 'Prevention', label: 'ERA/3', sortValue: (row) => row.advancedPitching.era3, value: (row) => formatDecimal(row.advancedPitching.era3, 2) },
    { key: 'fip', group: 'Prevention', label: 'FIP', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.fip, value: (row) => formatDecimal(row.advancedPitching.fip, 2) },
    { key: 'fipMinus', group: 'Prevention', label: 'FIP-', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.fipMinus, render: (row) => inverseMetric(row.advancedPitching.fipMinus) },
    { key: 'eraMinus', group: 'Prevention', label: 'ERA-', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.eraMinus, render: (row) => inverseMetric(row.advancedPitching.eraMinus) },
    { key: 'whip', group: 'Prevention', label: 'WHIP', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.whip, value: (row) => formatDecimal(row.advancedPitching.whip, 2) },
    { key: 'k3', group: 'Miss Bats', label: 'K/3', sortValue: (row) => row.advancedPitching.k3, value: (row) => formatDecimal(row.advancedPitching.k3, 2) },
    { key: 'bb3', group: 'Contact', label: 'BB/3', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.bb3, value: (row) => formatDecimal(row.advancedPitching.bb3, 2) },
    { key: 'h3', group: 'Contact', label: 'H/3', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.h3, value: (row) => formatDecimal(row.advancedPitching.h3, 2) },
    { key: 'hr3', group: 'Contact', label: 'HR/3', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.hr3, value: (row) => formatDecimal(row.advancedPitching.hr3, 2) },
    { key: 'kPct', group: 'Miss Bats', label: 'K%', sortValue: (row) => row.advancedPitching.kPct, value: (row) => formatPercent(row.advancedPitching.kPct, 1) },
    { key: 'bbPct', group: 'Contact', label: 'BB%', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.bbPct, value: (row) => formatPercent(row.advancedPitching.bbPct, 1) },
    { key: 'kBB', group: 'Miss Bats', label: 'K/BB', sortValue: (row) => row.advancedPitching.kBB, value: (row) => formatDecimal(row.advancedPitching.kBB, 2) },
    { key: 'babipAllowed', group: 'Contact', label: 'BABIP Allowed', defaultDirection: 'asc', sortValue: (row) => row.advancedPitching.babipAllowed, value: (row) => formatAverageStyle(row.advancedPitching.babipAllowed) },
  ]), [identitiesByPlayerId, playersById, leagueConstants, leaguePitchingSummary])

  const playerIdentityCol = { key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> }
  const charIdentityCol = { key: 'name', group: 'Identity', label: 'Character', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 48, sortValue: (row) => row.name, render: (row) => <CharacterCell compact name={row.name} /> }

  const bbBattingCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bip', group: 'Profile', label: 'BIP', sortValue: (row) => row.battedBall.total, value: (row) => row.battedBall.total },
    { key: 'ld', group: 'Trajectory', label: 'LD', sortValue: (row) => row.battedBall.lineDrives, value: (row) => row.battedBall.lineDrives },
    { key: 'gb', group: 'Trajectory', label: 'GB', sortValue: (row) => row.battedBall.groundBalls, value: (row) => row.battedBall.groundBalls },
    { key: 'fb', group: 'Trajectory', label: 'FB', sortValue: (row) => row.battedBall.flyBalls, value: (row) => row.battedBall.flyBalls },
    { key: 'ldPct', group: 'Trajectory', label: 'LD%', sortValue: (row) => row.battedBall.ldRate, value: (row) => formatPercent(row.battedBall.ldRate) },
    { key: 'gbPct', group: 'Trajectory', label: 'GB%', sortValue: (row) => row.battedBall.gbRate, value: (row) => formatPercent(row.battedBall.gbRate) },
    { key: 'fbPct', group: 'Trajectory', label: 'FB%', sortValue: (row) => row.battedBall.fbRate, value: (row) => formatPercent(row.battedBall.fbRate) },
    { key: 'pull', group: 'Direction', label: 'Pull', sortValue: (row) => row.sprayProfile.pull, value: (row) => row.sprayProfile.pull },
    { key: 'ctr', group: 'Direction', label: 'Ctr', sortValue: (row) => row.sprayProfile.center, value: (row) => row.sprayProfile.center },
    { key: 'oppo', group: 'Direction', label: 'Oppo', sortValue: (row) => row.sprayProfile.oppo, value: (row) => row.sprayProfile.oppo },
    { key: 'pullPct', group: 'Direction', label: 'Pull%', sortValue: (row) => row.sprayProfile.pullRate, value: (row) => formatPercent(row.sprayProfile.pullRate) },
    { key: 'ctrPct', group: 'Direction', label: 'Ctr%', sortValue: (row) => row.sprayProfile.centerRate, value: (row) => formatPercent(row.sprayProfile.centerRate) },
    { key: 'oppoPct', group: 'Direction', label: 'Oppo%', sortValue: (row) => row.sprayProfile.oppoRate, value: (row) => formatPercent(row.sprayProfile.oppoRate) },
  ], [identitiesByPlayerId, playersById])

  const bbPitchingCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bip', group: 'Profile', label: 'BIP Allowed', sortValue: (row) => row.pitchingBattedBall.total, value: (row) => row.pitchingBattedBall.total },
    { key: 'ld', group: 'Trajectory', label: 'LD', sortValue: (row) => row.pitchingBattedBall.lineDrives, value: (row) => row.pitchingBattedBall.lineDrives },
    { key: 'gb', group: 'Trajectory', label: 'GB', sortValue: (row) => row.pitchingBattedBall.groundBalls, value: (row) => row.pitchingBattedBall.groundBalls },
    { key: 'fb', group: 'Trajectory', label: 'FB', sortValue: (row) => row.pitchingBattedBall.flyBalls, value: (row) => row.pitchingBattedBall.flyBalls },
    { key: 'ldPct', group: 'Trajectory', label: 'LD%', sortValue: (row) => row.pitchingBattedBall.ldRate, value: (row) => formatPercent(row.pitchingBattedBall.ldRate) },
    { key: 'gbPct', group: 'Trajectory', label: 'GB%', sortValue: (row) => row.pitchingBattedBall.gbRate, value: (row) => formatPercent(row.pitchingBattedBall.gbRate) },
    { key: 'fbPct', group: 'Trajectory', label: 'FB%', sortValue: (row) => row.pitchingBattedBall.fbRate, value: (row) => formatPercent(row.pitchingBattedBall.fbRate) },
    { key: 'pull', group: 'Direction', label: 'Pull', sortValue: (row) => row.pitchingSpray.pull, value: (row) => row.pitchingSpray.pull },
    { key: 'ctr', group: 'Direction', label: 'Ctr', sortValue: (row) => row.pitchingSpray.center, value: (row) => row.pitchingSpray.center },
    { key: 'oppo', group: 'Direction', label: 'Oppo', sortValue: (row) => row.pitchingSpray.oppo, value: (row) => row.pitchingSpray.oppo },
    { key: 'pullPct', group: 'Direction', label: 'Pull%', sortValue: (row) => row.pitchingSpray.pullRate, value: (row) => formatPercent(row.pitchingSpray.pullRate) },
    { key: 'ctrPct', group: 'Direction', label: 'Ctr%', sortValue: (row) => row.pitchingSpray.centerRate, value: (row) => formatPercent(row.pitchingSpray.centerRate) },
    { key: 'oppoPct', group: 'Direction', label: 'Oppo%', sortValue: (row) => row.pitchingSpray.oppoRate, value: (row) => formatPercent(row.pitchingSpray.oppoRate) },
  ], [identitiesByPlayerId, playersById])

  const bbBattingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bip', group: 'Profile', label: 'BIP', sortValue: (row) => row.battedBall.total, value: (row) => row.battedBall.total },
    { key: 'ld', group: 'Trajectory', label: 'LD', sortValue: (row) => row.battedBall.lineDrives, value: (row) => row.battedBall.lineDrives },
    { key: 'gb', group: 'Trajectory', label: 'GB', sortValue: (row) => row.battedBall.groundBalls, value: (row) => row.battedBall.groundBalls },
    { key: 'fb', group: 'Trajectory', label: 'FB', sortValue: (row) => row.battedBall.flyBalls, value: (row) => row.battedBall.flyBalls },
    { key: 'ldPct', group: 'Trajectory', label: 'LD%', sortValue: (row) => row.battedBall.ldRate, value: (row) => formatPercent(row.battedBall.ldRate) },
    { key: 'gbPct', group: 'Trajectory', label: 'GB%', sortValue: (row) => row.battedBall.gbRate, value: (row) => formatPercent(row.battedBall.gbRate) },
    { key: 'fbPct', group: 'Trajectory', label: 'FB%', sortValue: (row) => row.battedBall.fbRate, value: (row) => formatPercent(row.battedBall.fbRate) },
    { key: 'pull', group: 'Direction', label: 'Pull', sortValue: (row) => row.sprayProfile.pull, value: (row) => row.sprayProfile.pull },
    { key: 'ctr', group: 'Direction', label: 'Ctr', sortValue: (row) => row.sprayProfile.center, value: (row) => row.sprayProfile.center },
    { key: 'oppo', group: 'Direction', label: 'Oppo', sortValue: (row) => row.sprayProfile.oppo, value: (row) => row.sprayProfile.oppo },
    { key: 'pullPct', group: 'Direction', label: 'Pull%', sortValue: (row) => row.sprayProfile.pullRate, value: (row) => formatPercent(row.sprayProfile.pullRate) },
    { key: 'ctrPct', group: 'Direction', label: 'Ctr%', sortValue: (row) => row.sprayProfile.centerRate, value: (row) => formatPercent(row.sprayProfile.centerRate) },
    { key: 'oppoPct', group: 'Direction', label: 'Oppo%', sortValue: (row) => row.sprayProfile.oppoRate, value: (row) => formatPercent(row.sprayProfile.oppoRate) },
  ], [])

  const bbPitchingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bip', group: 'Profile', label: 'BIP Allowed', sortValue: (row) => row.pitchingBattedBall.total, value: (row) => row.pitchingBattedBall.total },
    { key: 'ld', group: 'Trajectory', label: 'LD', sortValue: (row) => row.pitchingBattedBall.lineDrives, value: (row) => row.pitchingBattedBall.lineDrives },
    { key: 'gb', group: 'Trajectory', label: 'GB', sortValue: (row) => row.pitchingBattedBall.groundBalls, value: (row) => row.pitchingBattedBall.groundBalls },
    { key: 'fb', group: 'Trajectory', label: 'FB', sortValue: (row) => row.pitchingBattedBall.flyBalls, value: (row) => row.pitchingBattedBall.flyBalls },
    { key: 'ldPct', group: 'Trajectory', label: 'LD%', sortValue: (row) => row.pitchingBattedBall.ldRate, value: (row) => formatPercent(row.pitchingBattedBall.ldRate) },
    { key: 'gbPct', group: 'Trajectory', label: 'GB%', sortValue: (row) => row.pitchingBattedBall.gbRate, value: (row) => formatPercent(row.pitchingBattedBall.gbRate) },
    { key: 'fbPct', group: 'Trajectory', label: 'FB%', sortValue: (row) => row.pitchingBattedBall.fbRate, value: (row) => formatPercent(row.pitchingBattedBall.fbRate) },
    { key: 'pull', group: 'Direction', label: 'Pull', sortValue: (row) => row.pitchingSpray.pull, value: (row) => row.pitchingSpray.pull },
    { key: 'ctr', group: 'Direction', label: 'Ctr', sortValue: (row) => row.pitchingSpray.center, value: (row) => row.pitchingSpray.center },
    { key: 'oppo', group: 'Direction', label: 'Oppo', sortValue: (row) => row.pitchingSpray.oppo, value: (row) => row.pitchingSpray.oppo },
    { key: 'pullPct', group: 'Direction', label: 'Pull%', sortValue: (row) => row.pitchingSpray.pullRate, value: (row) => formatPercent(row.pitchingSpray.pullRate) },
    { key: 'ctrPct', group: 'Direction', label: 'Ctr%', sortValue: (row) => row.pitchingSpray.centerRate, value: (row) => formatPercent(row.pitchingSpray.centerRate) },
    { key: 'oppoPct', group: 'Direction', label: 'Oppo%', sortValue: (row) => row.pitchingSpray.oppoRate, value: (row) => formatPercent(row.pitchingSpray.oppoRate) },
  ], [])

  const powerBattingCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'avgDist', group: 'Distance', label: 'Avg Dist', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.avgDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.avgDistance} ft` : '-' },
    { key: 'maxDist', group: 'Distance', label: 'Longest', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.maxDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.maxDistance} ft` : '-' },
    { key: 'hardHitRate', group: 'Distance', label: 'Hard-Hit%', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.hardHitRate : null, value: (row) => qualifiesForPower(row) ? formatPercent(row.distanceProfile.hardHitRate) : '-' },
    { key: 'parkAdjustedDistance', group: 'Distance', label: 'Park-Adj Dist', sortValue: (row) => qualifiesForPower(row) ? row.parkAdjustedDistance : null, value: (row) => qualifiesForPower(row) ? `${row.parkAdjustedDistance} ft` : '-' },
    { key: 'hitPowerIndex', group: 'Power', label: 'Power Index', sortValue: (row) => qualifiesForPower(row) ? row.hitPowerIndex : null, value: (row) => qualifiesForPower(row) ? row.hitPowerIndex : '-' },
    { key: 'avgSprayAngle', group: 'Power', label: 'Avg Spray Angle', sortValue: (row) => row.sprayProfile.avgSprayAngle, value: (row) => row.sprayProfile.avgSprayAngle != null ? `${row.sprayProfile.avgSprayAngle}°` : '-' },
  ], [identitiesByPlayerId, playersById])

  const powerBattingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'avgDist', group: 'Distance', label: 'Avg Dist', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.avgDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.avgDistance} ft` : '-' },
    { key: 'maxDist', group: 'Distance', label: 'Longest', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.maxDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.maxDistance} ft` : '-' },
    { key: 'hardHitRate', group: 'Distance', label: 'Hard-Hit%', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.hardHitRate : null, value: (row) => qualifiesForPower(row) ? formatPercent(row.distanceProfile.hardHitRate) : '-' },
    { key: 'parkAdjustedDistance', group: 'Distance', label: 'Park-Adj Dist', sortValue: (row) => qualifiesForPower(row) ? row.parkAdjustedDistance : null, value: (row) => qualifiesForPower(row) ? `${row.parkAdjustedDistance} ft` : '-' },
    { key: 'hitPowerIndex', group: 'Power', label: 'Power Index', sortValue: (row) => qualifiesForPower(row) ? row.hitPowerIndex : null, value: (row) => qualifiesForPower(row) ? row.hitPowerIndex : '-' },
    { key: 'avgSprayAngle', group: 'Power', label: 'Avg Spray Angle', sortValue: (row) => row.sprayProfile.avgSprayAngle, value: (row) => row.sprayProfile.avgSprayAngle != null ? `${row.sprayProfile.avgSprayAngle}°` : '-' },
  ], [])

  const exitVeloCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'avgExitVelo', group: 'Exit Velo', label: 'Avg EV', sortValue: (row) => row.exitVeloProfile.avgExitVelocity, value: (row) => row.exitVeloProfile.avgExitVelocity != null ? `${row.exitVeloProfile.avgExitVelocity} mph` : '-' },
    { key: 'maxExitVelo', group: 'Exit Velo', label: 'Max EV', sortValue: (row) => row.exitVeloProfile.maxExitVelocity, value: (row) => row.exitVeloProfile.maxExitVelocity != null ? `${row.exitVeloProfile.maxExitVelocity} mph` : '-' },
    { key: 'avgLaunchAngle', group: 'Exit Velo', label: 'Avg Launch', sortValue: (row) => row.exitVeloProfile.avgLaunchAngle, value: (row) => row.exitVeloProfile.avgLaunchAngle != null ? `${row.exitVeloProfile.avgLaunchAngle}°` : '-' },
  ], [identitiesByPlayerId, playersById])

  const exitVeloCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'avgExitVelo', group: 'Exit Velo', label: 'Avg EV', sortValue: (row) => row.exitVeloProfile.avgExitVelocity, value: (row) => row.exitVeloProfile.avgExitVelocity != null ? `${row.exitVeloProfile.avgExitVelocity} mph` : '-' },
    { key: 'maxExitVelo', group: 'Exit Velo', label: 'Max EV', sortValue: (row) => row.exitVeloProfile.maxExitVelocity, value: (row) => row.exitVeloProfile.maxExitVelocity != null ? `${row.exitVeloProfile.maxExitVelocity} mph` : '-' },
    { key: 'avgLaunchAngle', group: 'Exit Velo', label: 'Avg Launch', sortValue: (row) => row.exitVeloProfile.avgLaunchAngle, value: (row) => row.exitVeloProfile.avgLaunchAngle != null ? `${row.exitVeloProfile.avgLaunchAngle}°` : '-' },
  ], [])

  const contactQualityCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'barrelRate', group: 'Contact Quality', label: 'Barrel%', sortValue: (row) => row.contactQuality.barrelRate, value: (row) => row.contactQuality.barrelRate != null ? formatPercent(row.contactQuality.barrelRate) : '-' },
    { key: 'hardHitVeloRate', group: 'Contact Quality', label: 'Hard-Hit% (EV)', sortValue: (row) => row.contactQuality.hardHitRate, value: (row) => row.contactQuality.hardHitRate != null ? formatPercent(row.contactQuality.hardHitRate) : '-' },
    { key: 'sweetSpotRate', group: 'Contact Quality', label: 'Sweet-Spot%', sortValue: (row) => row.contactQuality.sweetSpotRate, value: (row) => row.contactQuality.sweetSpotRate != null ? formatPercent(row.contactQuality.sweetSpotRate) : '-' },
  ], [identitiesByPlayerId, playersById])

  const contactQualityCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.distanceProfile.sampleSize, value: (row) => row.distanceProfile.sampleSize ?? '-' },
    { key: 'barrelRate', group: 'Contact Quality', label: 'Barrel%', sortValue: (row) => row.contactQuality.barrelRate, value: (row) => row.contactQuality.barrelRate != null ? formatPercent(row.contactQuality.barrelRate) : '-' },
    { key: 'hardHitVeloRate', group: 'Contact Quality', label: 'Hard-Hit% (EV)', sortValue: (row) => row.contactQuality.hardHitRate, value: (row) => row.contactQuality.hardHitRate != null ? formatPercent(row.contactQuality.hardHitRate) : '-' },
    { key: 'sweetSpotRate', group: 'Contact Quality', label: 'Sweet-Spot%', sortValue: (row) => row.contactQuality.sweetSpotRate, value: (row) => row.contactQuality.sweetSpotRate != null ? formatPercent(row.contactQuality.sweetSpotRate) : '-' },
  ], [])

  // Luck = actual minus expected: positive means the player/character has
  // out-hit what their contact quality says they should have (fortunate),
  // negative means they've under-hit it (unlucky) -- e.g. hard-hit balls
  // finding gloves instead of grass.
  const baDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xBA != null ? row.batting.avg - row.expectedBatting.xBA : null
  const slgDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xSLG != null ? row.batting.slg - row.expectedBatting.xSLG : null
  const wobaDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xwOBA != null ? row.advancedBatting.woba - row.expectedBatting.xwOBA : null

  const expectedCols = useMemo(() => [
    playerIdentityCol,
    { key: 'pa', group: 'Sample', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'xBA', group: 'Expected', label: 'xBA', sortValue: (row) => row.expectedBatting.xBA, value: (row) => row.expectedBatting.xBA != null ? formatAverageStyle(row.expectedBatting.xBA) : '-' },
    { key: 'xSLG', group: 'Expected', label: 'xSLG', sortValue: (row) => row.expectedBatting.xSLG, value: (row) => row.expectedBatting.xSLG != null ? formatAverageStyle(row.expectedBatting.xSLG) : '-' },
    { key: 'xwOBA', group: 'Expected', label: 'xwOBA', sortValue: (row) => row.expectedBatting.xwOBA, value: (row) => row.expectedBatting.xwOBA != null ? formatAverageStyle(row.expectedBatting.xwOBA) : '-' },
    { key: 'baDiff', group: 'Luck', label: 'AVG -xBA', sortValue: baDiff, render: (row) => <ValueBadge color={getLuckColor(baDiff(row))} value={formatSignedAverageStyle(baDiff(row))} /> },
    { key: 'slgDiff', group: 'Luck', label: 'SLG -xSLG', sortValue: slgDiff, render: (row) => <ValueBadge color={getLuckColor(slgDiff(row))} value={formatSignedAverageStyle(slgDiff(row))} /> },
    { key: 'wobaDiff', group: 'Luck', label: 'wOBA -xwOBA', sortValue: wobaDiff, render: (row) => <ValueBadge color={getLuckColor(wobaDiff(row))} value={formatSignedAverageStyle(wobaDiff(row))} /> },
  ], [identitiesByPlayerId, playersById])

  const expectedCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'pa', group: 'Sample', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'xBA', group: 'Expected', label: 'xBA', sortValue: (row) => row.expectedBatting.xBA, value: (row) => row.expectedBatting.xBA != null ? formatAverageStyle(row.expectedBatting.xBA) : '-' },
    { key: 'xSLG', group: 'Expected', label: 'xSLG', sortValue: (row) => row.expectedBatting.xSLG, value: (row) => row.expectedBatting.xSLG != null ? formatAverageStyle(row.expectedBatting.xSLG) : '-' },
    { key: 'xwOBA', group: 'Expected', label: 'xwOBA', sortValue: (row) => row.expectedBatting.xwOBA, value: (row) => row.expectedBatting.xwOBA != null ? formatAverageStyle(row.expectedBatting.xwOBA) : '-' },
    { key: 'baDiff', group: 'Luck', label: 'AVG -xBA', sortValue: baDiff, render: (row) => <ValueBadge color={getLuckColor(baDiff(row))} value={formatSignedAverageStyle(baDiff(row))} /> },
    { key: 'slgDiff', group: 'Luck', label: 'SLG -xSLG', sortValue: slgDiff, render: (row) => <ValueBadge color={getLuckColor(slgDiff(row))} value={formatSignedAverageStyle(slgDiff(row))} /> },
    { key: 'wobaDiff', group: 'Luck', label: 'wOBA -xwOBA', sortValue: wobaDiff, render: (row) => <ValueBadge color={getLuckColor(wobaDiff(row))} value={formatSignedAverageStyle(wobaDiff(row))} /> },
  ], [])

  const buildLocCols = (getLocations, identityCol) => [
    identityCol,
    { key: 'bipTotal', group: 'Profile', label: 'BIP', sortValue: (row) => getLocations(row).total, value: (row) => getLocations(row).total },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pos) => ({
      key: `loc${pos}`,
      group: 'Location',
      label: POSITION_LABELS[pos],
      sortValue: (row) => locationDisplayMode === 'pct' ? getLocations(row).rates[pos] : getLocations(row).counts[pos],
      value: (row) => locationDisplayMode === 'pct' ? formatPercent(getLocations(row).rates[pos]) : formatInteger(getLocations(row).counts[pos]),
    })),
  ]

  const locBattingPlayerCols = buildLocCols((row) => row.hitLocations, playerIdentityCol)
  const locPitchingPlayerCols = buildLocCols((row) => row.pitchingHitLocations, playerIdentityCol)
  const locBattingCharCols = buildLocCols((row) => row.hitLocations, charIdentityCol)
  const locPitchingCharCols = buildLocCols((row) => row.pitchingHitLocations, charIdentityCol)

  const discBattingPlayerCols = useMemo(() => [
    playerIdentityCol,
    { key: 'pa', group: 'Usage', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.plateDiscipline.totalPitches, value: (row) => row.plateDiscipline.totalPitches },
    { key: 'pitchesPerPa', group: 'Usage', label: 'P/PA', sortValue: (row) => row.plateDiscipline.pitchesPerPa, value: (row) => formatDecimal(row.plateDiscipline.pitchesPerPa, 2) },
    { key: 'whiffRate', group: 'Contact', label: 'Whiff%', sortValue: (row) => row.plateDiscipline.whiffRate, value: (row) => formatPercent(row.plateDiscipline.whiffRate) },
    { key: 'foulRate', group: 'Contact', label: 'Foul%', sortValue: (row) => row.plateDiscipline.foulRate, value: (row) => formatPercent(row.plateDiscipline.foulRate) },
    { key: 'kRate', group: 'Strikeouts', label: 'K%', sortValue: (row) => row.plateDiscipline.kRate, value: (row) => formatPercent(row.plateDiscipline.kRate) },
    { key: 'ksRate', group: 'Strikeouts', label: 'KS%', sortValue: (row) => row.plateDiscipline.ksRate, value: (row) => formatPercent(row.plateDiscipline.ksRate) },
    { key: 'klRate', group: 'Strikeouts', label: 'KL%', sortValue: (row) => row.plateDiscipline.klRate, value: (row) => formatPercent(row.plateDiscipline.klRate) },
    { key: 'bbRate', group: 'Walks', label: 'BB%', sortValue: (row) => row.plateDiscipline.bbRate, value: (row) => formatPercent(row.plateDiscipline.bbRate) },
  ], [identitiesByPlayerId, playersById])

  const discPitchingPlayerCols = useMemo(() => [
    playerIdentityCol,
    { key: 'bf', group: 'Usage', label: 'BF', sortValue: (row) => row.pitchingBf, value: (row) => row.pitchingBf },
    { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.pitchMix.totalPitches, value: (row) => row.pitchMix.totalPitches },
    { key: 'pitchesPerBatter', group: 'Usage', label: 'P/BF', sortValue: (row) => row.pitchMix.pitchesPerBatter, value: (row) => formatDecimal(row.pitchMix.pitchesPerBatter, 2) },
    { key: 'strikeRate', group: 'Zone', label: 'Strike%', sortValue: (row) => row.pitchMix.strikeRate, value: (row) => formatPercent(row.pitchMix.strikeRate) },
    { key: 'ballRate', group: 'Zone', label: 'Ball%', sortValue: (row) => row.pitchMix.ballRate, value: (row) => formatPercent(row.pitchMix.ballRate) },
    { key: 'firstPitchStrikeRate', group: 'Zone', label: '1stStr%', sortValue: (row) => row.pitchMix.firstPitchStrikeRate, value: (row) => formatPercent(row.pitchMix.firstPitchStrikeRate) },
    { key: 'swingingMissRate', group: 'Miss', label: 'Whiff%', sortValue: (row) => row.pitchMix.swingingMissRate, value: (row) => formatPercent(row.pitchMix.swingingMissRate) },
    { key: 'foulRate', group: 'Miss', label: 'Foul%', sortValue: (row) => row.pitchMix.foulRate, value: (row) => formatPercent(row.pitchMix.foulRate) },
  ], [identitiesByPlayerId, playersById])

  const discBattingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'pa', group: 'Usage', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.plateDiscipline.totalPitches, value: (row) => row.plateDiscipline.totalPitches },
    { key: 'pitchesPerPa', group: 'Usage', label: 'P/PA', sortValue: (row) => row.plateDiscipline.pitchesPerPa, value: (row) => formatDecimal(row.plateDiscipline.pitchesPerPa, 2) },
    { key: 'whiffRate', group: 'Contact', label: 'Whiff%', sortValue: (row) => row.plateDiscipline.whiffRate, value: (row) => formatPercent(row.plateDiscipline.whiffRate) },
    { key: 'foulRate', group: 'Contact', label: 'Foul%', sortValue: (row) => row.plateDiscipline.foulRate, value: (row) => formatPercent(row.plateDiscipline.foulRate) },
    { key: 'kRate', group: 'Strikeouts', label: 'K%', sortValue: (row) => row.plateDiscipline.kRate, value: (row) => formatPercent(row.plateDiscipline.kRate) },
    { key: 'ksRate', group: 'Strikeouts', label: 'KS%', sortValue: (row) => row.plateDiscipline.ksRate, value: (row) => formatPercent(row.plateDiscipline.ksRate) },
    { key: 'klRate', group: 'Strikeouts', label: 'KL%', sortValue: (row) => row.plateDiscipline.klRate, value: (row) => formatPercent(row.plateDiscipline.klRate) },
    { key: 'bbRate', group: 'Walks', label: 'BB%', sortValue: (row) => row.plateDiscipline.bbRate, value: (row) => formatPercent(row.plateDiscipline.bbRate) },
  ], [])

  const discPitchingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'bf', group: 'Usage', label: 'BF', sortValue: (row) => row.pitchingBf, value: (row) => row.pitchingBf },
    { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.pitchMix.totalPitches, value: (row) => row.pitchMix.totalPitches },
    { key: 'pitchesPerBatter', group: 'Usage', label: 'P/BF', sortValue: (row) => row.pitchMix.pitchesPerBatter, value: (row) => formatDecimal(row.pitchMix.pitchesPerBatter, 2) },
    { key: 'strikeRate', group: 'Zone', label: 'Strike%', sortValue: (row) => row.pitchMix.strikeRate, value: (row) => formatPercent(row.pitchMix.strikeRate) },
    { key: 'ballRate', group: 'Zone', label: 'Ball%', sortValue: (row) => row.pitchMix.ballRate, value: (row) => formatPercent(row.pitchMix.ballRate) },
    { key: 'firstPitchStrikeRate', group: 'Zone', label: '1stStr%', sortValue: (row) => row.pitchMix.firstPitchStrikeRate, value: (row) => formatPercent(row.pitchMix.firstPitchStrikeRate) },
    { key: 'swingingMissRate', group: 'Miss', label: 'Whiff%', sortValue: (row) => row.pitchMix.swingingMissRate, value: (row) => formatPercent(row.pitchMix.swingingMissRate) },
    { key: 'foulRate', group: 'Miss', label: 'Foul%', sortValue: (row) => row.pitchMix.foulRate, value: (row) => formatPercent(row.pitchMix.foulRate) },
  ], [])

  const bpBattingPlayerCols = useMemo(() => [
    playerIdentityCol,
    { key: 'gamesAtPark', group: 'Park', label: 'G', sortValue: (row) => row.gamesAtPark, value: (row) => row.gamesAtPark },
    { key: 'plateAppearances', group: 'Batting', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'hits', group: 'Batting', label: 'H', sortValue: (row) => row.batting.hits, value: (row) => row.batting.hits },
    { key: 'homeRuns', group: 'Batting', label: 'HR', sortValue: (row) => row.batting.homeRuns, value: (row) => row.batting.homeRuns },
    { key: 'rbi', group: 'Batting', label: 'RBI', sortValue: (row) => row.batting.rbi, value: (row) => row.batting.rbi },
    { key: 'runs', group: 'Batting', label: 'R', sortValue: (row) => row.batting.runs, value: (row) => row.batting.runs },
    { key: 'walks', group: 'Batting', label: 'BB', sortValue: (row) => row.batting.walks, value: (row) => row.batting.walks },
    { key: 'strikeouts', group: 'Batting', label: 'SO', sortValue: (row) => row.batting.strikeouts, value: (row) => row.batting.strikeouts },
    { key: 'avg', group: 'Rates', label: 'AVG', sortValue: (row) => row.batting.avg, value: (row) => formatDecimal(row.batting.avg) },
    { key: 'obp', group: 'Rates', label: 'OBP', sortValue: (row) => row.batting.obp, value: (row) => formatDecimal(row.batting.obp) },
    { key: 'slg', group: 'Rates', label: 'SLG', sortValue: (row) => row.batting.slg, value: (row) => formatDecimal(row.batting.slg) },
    { key: 'ops', group: 'Rates', label: 'OPS', sortValue: (row) => row.batting.ops, value: (row) => formatDecimal(row.batting.ops) },
  ], [identitiesByPlayerId, playersById])

  const bpBattingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'plateAppearances', group: 'Batting', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
    { key: 'hits', group: 'Batting', label: 'H', sortValue: (row) => row.batting.hits, value: (row) => row.batting.hits },
    { key: 'homeRuns', group: 'Batting', label: 'HR', sortValue: (row) => row.batting.homeRuns, value: (row) => row.batting.homeRuns },
    { key: 'rbi', group: 'Batting', label: 'RBI', sortValue: (row) => row.batting.rbi, value: (row) => row.batting.rbi },
    { key: 'runs', group: 'Batting', label: 'R', sortValue: (row) => row.batting.runs, value: (row) => row.batting.runs },
    { key: 'walks', group: 'Batting', label: 'BB', sortValue: (row) => row.batting.walks, value: (row) => row.batting.walks },
    { key: 'strikeouts', group: 'Batting', label: 'SO', sortValue: (row) => row.batting.strikeouts, value: (row) => row.batting.strikeouts },
    { key: 'avg', group: 'Rates', label: 'AVG', sortValue: (row) => row.batting.avg, value: (row) => formatDecimal(row.batting.avg) },
    { key: 'obp', group: 'Rates', label: 'OBP', sortValue: (row) => row.batting.obp, value: (row) => formatDecimal(row.batting.obp) },
    { key: 'slg', group: 'Rates', label: 'SLG', sortValue: (row) => row.batting.slg, value: (row) => formatDecimal(row.batting.slg) },
    { key: 'ops', group: 'Rates', label: 'OPS', sortValue: (row) => row.batting.ops, value: (row) => formatDecimal(row.batting.ops) },
  ], [])

  const bpPitchingPlayerCols = useMemo(() => [
    playerIdentityCol,
    { key: 'games', group: 'Usage', label: 'G', sortValue: (row) => row.pitching.games, value: (row) => row.pitching.games },
    { key: 'innings', group: 'Usage', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
    { key: 'wins', group: 'Record', label: 'W', sortValue: (row) => row.pitching.wins, value: (row) => row.pitching.wins },
    { key: 'losses', group: 'Record', label: 'L', sortValue: (row) => row.pitching.losses, value: (row) => row.pitching.losses },
    { key: 'strikeouts', group: 'Line', label: 'K', sortValue: (row) => row.pitching.strikeouts, value: (row) => row.pitching.strikeouts },
    { key: 'hitsAllowed', group: 'Line', label: 'H', sortValue: (row) => row.pitching.hitsAllowed, value: (row) => row.pitching.hitsAllowed },
    { key: 'earnedRuns', group: 'Line', label: 'ER', sortValue: (row) => row.pitching.earnedRuns, value: (row) => row.pitching.earnedRuns },
    { key: 'walks', group: 'Line', label: 'BB', sortValue: (row) => row.pitching.walks, value: (row) => row.pitching.walks },
    { key: 'homeRunsAllowed', group: 'Line', label: 'HR', sortValue: (row) => row.pitching.homeRunsAllowed, value: (row) => row.pitching.homeRunsAllowed },
    { key: 'era', group: 'Rates', label: 'ERA/3', sortValue: (row) => row.pitching.era, value: (row) => formatDecimal(row.pitching.era, 2) },
    { key: 'whip', group: 'Rates', label: 'WHIP', sortValue: (row) => row.pitching.whip, value: (row) => formatDecimal(row.pitching.whip, 2) },
    { key: 'kPer3', group: 'Rates', label: 'K/3', sortValue: (row) => row.pitching.kPer3, value: (row) => formatDecimal(row.pitching.kPer3, 2) },
  ], [identitiesByPlayerId, playersById])

  const bpPitchingCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'games', group: 'Usage', label: 'G', sortValue: (row) => row.pitching.games, value: (row) => row.pitching.games },
    { key: 'innings', group: 'Usage', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
    { key: 'wins', group: 'Record', label: 'W', sortValue: (row) => row.pitching.wins, value: (row) => row.pitching.wins },
    { key: 'losses', group: 'Record', label: 'L', sortValue: (row) => row.pitching.losses, value: (row) => row.pitching.losses },
    { key: 'strikeouts', group: 'Line', label: 'K', sortValue: (row) => row.pitching.strikeouts, value: (row) => row.pitching.strikeouts },
    { key: 'hitsAllowed', group: 'Line', label: 'H', sortValue: (row) => row.pitching.hitsAllowed, value: (row) => row.pitching.hitsAllowed },
    { key: 'earnedRuns', group: 'Line', label: 'ER', sortValue: (row) => row.pitching.earnedRuns, value: (row) => row.pitching.earnedRuns },
    { key: 'walks', group: 'Line', label: 'BB', sortValue: (row) => row.pitching.walks, value: (row) => row.pitching.walks },
    { key: 'homeRunsAllowed', group: 'Line', label: 'HR', sortValue: (row) => row.pitching.homeRunsAllowed, value: (row) => row.pitching.homeRunsAllowed },
    { key: 'era', group: 'Rates', label: 'ERA/3', sortValue: (row) => row.pitching.era, value: (row) => formatDecimal(row.pitching.era, 2) },
    { key: 'whip', group: 'Rates', label: 'WHIP', sortValue: (row) => row.pitching.whip, value: (row) => formatDecimal(row.pitching.whip, 2) },
    { key: 'kPer3', group: 'Rates', label: 'K/3', sortValue: (row) => row.pitching.kPer3, value: (row) => formatDecimal(row.pitching.kPer3, 2) },
  ], [])

  const renderDelta = (value, digits = 3) => {
    if (!Number.isFinite(value)) return '-'
    const color = Math.abs(value) < 0.005 ? '#94A3B8' : value > 0 ? '#22C55E' : '#EF4444'
    const sign = value > 0 ? '+' : ''
    return <span style={{ color, fontWeight: 700 }}>{sign}{value.toFixed(digits)}</span>
  }

  const bpFactorsTeamCols = useMemo(() => [
    playerIdentityCol,
    { key: 'parkPa', group: 'Park', label: 'PA', sortValue: (row) => row.parkPa, value: (row) => row.parkPa },
    { key: 'parkAvg', group: 'At Park', label: 'AVG', sortValue: (row) => row.parkAvg, value: (row) => formatDecimal(row.parkAvg) },
    { key: 'parkOps', group: 'At Park', label: 'OPS', sortValue: (row) => row.parkOps, value: (row) => formatDecimal(row.parkOps) },
    { key: 'parkHrPa', group: 'At Park', label: 'HR/PA', sortValue: (row) => row.parkHrPa, value: (row) => formatDecimal(row.parkHrPa) },
    { key: 'overallAvg', group: 'Overall', label: 'AVG', sortValue: (row) => row.overallAvg, value: (row) => formatDecimal(row.overallAvg) },
    { key: 'overallOps', group: 'Overall', label: 'OPS', sortValue: (row) => row.overallOps, value: (row) => formatDecimal(row.overallOps) },
    { key: 'overallHrPa', group: 'Overall', label: 'HR/PA', sortValue: (row) => row.overallHrPa, value: (row) => formatDecimal(row.overallHrPa) },
    { key: 'opsDiff', group: 'Delta', label: 'OPS Δ', sortValue: (row) => row.opsDiff, render: (row) => renderDelta(row.opsDiff) },
    { key: 'avgDiff', group: 'Delta', label: 'AVG Δ', sortValue: (row) => row.avgDiff, render: (row) => renderDelta(row.avgDiff) },
    { key: 'hrPaDiff', group: 'Delta', label: 'HR/PA Δ', sortValue: (row) => row.hrPaDiff, render: (row) => renderDelta(row.hrPaDiff) },
  ], [identitiesByPlayerId, playersById])

  const bpFactorsCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'parkPa', group: 'Park', label: 'PA', sortValue: (row) => row.parkPa, value: (row) => row.parkPa },
    { key: 'parkAvg', group: 'At Park', label: 'AVG', sortValue: (row) => row.parkAvg, value: (row) => formatDecimal(row.parkAvg) },
    { key: 'parkOps', group: 'At Park', label: 'OPS', sortValue: (row) => row.parkOps, value: (row) => formatDecimal(row.parkOps) },
    { key: 'parkHrPa', group: 'At Park', label: 'HR/PA', sortValue: (row) => row.parkHrPa, value: (row) => formatDecimal(row.parkHrPa) },
    { key: 'overallAvg', group: 'Overall', label: 'AVG', sortValue: (row) => row.overallAvg, value: (row) => formatDecimal(row.overallAvg) },
    { key: 'overallOps', group: 'Overall', label: 'OPS', sortValue: (row) => row.overallOps, value: (row) => formatDecimal(row.overallOps) },
    { key: 'overallHrPa', group: 'Overall', label: 'HR/PA', sortValue: (row) => row.overallHrPa, value: (row) => formatDecimal(row.overallHrPa) },
    { key: 'opsDiff', group: 'Delta', label: 'OPS Δ', sortValue: (row) => row.opsDiff, render: (row) => renderDelta(row.opsDiff) },
    { key: 'avgDiff', group: 'Delta', label: 'AVG Δ', sortValue: (row) => row.avgDiff, render: (row) => renderDelta(row.avgDiff) },
    { key: 'hrPaDiff', group: 'Delta', label: 'HR/PA Δ', sortValue: (row) => row.hrPaDiff, render: (row) => renderDelta(row.hrPaDiff) },
  ], [])

  const bpFactorsPitTeamCols = useMemo(() => [
    playerIdentityCol,
    { key: 'parkIp', group: 'Park', label: 'IP', sortValue: (row) => row.parkIp, value: (row) => formatDecimal(row.parkIp, 1) },
    { key: 'eraAtPark', group: 'At Park', label: 'ERA/3', defaultDirection: 'asc', sortValue: (row) => row.eraAtPark, value: (row) => formatDecimal(row.eraAtPark, 2) },
    { key: 'whipAtPark', group: 'At Park', label: 'WHIP', defaultDirection: 'asc', sortValue: (row) => row.whipAtPark, value: (row) => formatDecimal(row.whipAtPark, 2) },
    { key: 'eraOverall', group: 'Overall', label: 'ERA/3', defaultDirection: 'asc', sortValue: (row) => row.eraOverall, value: (row) => formatDecimal(row.eraOverall, 2) },
    { key: 'whipOverall', group: 'Overall', label: 'WHIP', defaultDirection: 'asc', sortValue: (row) => row.whipOverall, value: (row) => formatDecimal(row.whipOverall, 2) },
    { key: 'eraDiff', group: 'Delta', label: 'ERA Δ', defaultDirection: 'asc', sortValue: (row) => row.eraDiff, render: (row) => row.eraDiff != null ? renderDelta(-row.eraDiff, 2) : '-' },
    { key: 'whipDiff', group: 'Delta', label: 'WHIP Δ', defaultDirection: 'asc', sortValue: (row) => row.whipDiff, render: (row) => row.whipDiff != null ? renderDelta(-row.whipDiff, 2) : '-' },
  ], [identitiesByPlayerId, playersById])

  const bpFactorsPitCharCols = useMemo(() => [
    charIdentityCol,
    { key: 'parkIp', group: 'Park', label: 'IP', sortValue: (row) => row.parkIp, value: (row) => formatDecimal(row.parkIp, 1) },
    { key: 'eraAtPark', group: 'At Park', label: 'ERA/3', defaultDirection: 'asc', sortValue: (row) => row.eraAtPark, value: (row) => formatDecimal(row.eraAtPark, 2) },
    { key: 'whipAtPark', group: 'At Park', label: 'WHIP', defaultDirection: 'asc', sortValue: (row) => row.whipAtPark, value: (row) => formatDecimal(row.whipAtPark, 2) },
    { key: 'eraOverall', group: 'Overall', label: 'ERA/3', defaultDirection: 'asc', sortValue: (row) => row.eraOverall, value: (row) => formatDecimal(row.eraOverall, 2) },
    { key: 'whipOverall', group: 'Overall', label: 'WHIP', defaultDirection: 'asc', sortValue: (row) => row.whipOverall, value: (row) => formatDecimal(row.whipOverall, 2) },
    { key: 'eraDiff', group: 'Delta', label: 'ERA Δ', defaultDirection: 'asc', sortValue: (row) => row.eraDiff, render: (row) => row.eraDiff != null ? renderDelta(-row.eraDiff, 2) : '-' },
    { key: 'whipDiff', group: 'Delta', label: 'WHIP Δ', defaultDirection: 'asc', sortValue: (row) => row.whipDiff, render: (row) => row.whipDiff != null ? renderDelta(-row.whipDiff, 2) : '-' },
  ], [])

  const visiblePlayerRows = useMemo(() => {
    if (playerView === PLAYER_VIEWS.batting) return playerRows.filter(hasBattingData)
    if (playerView === PLAYER_VIEWS.pitching) return playerRows.filter(hasPitchingData)
    return playerRows.filter(hasFieldingData)
  }, [playerRows, playerView])

  const visibleCharacterRows = useMemo(() => {
    if (characterView === CHARACTER_VIEWS.batting) return characterRows.filter(hasBattingData)
    if (characterView === CHARACTER_VIEWS.pitching) return characterRows.filter(hasPitchingData)
    return characterRows.filter(hasFieldingData)
  }, [characterRows, characterView])

  const activePlayerColumns = useMemo(() => playerColumns[playerView], [playerColumns, playerView])
  const activePlayerSort = playerSort
  const sortedPlayerRows = useMemo(() => sortRows(visiblePlayerRows, activePlayerColumns, activePlayerSort), [visiblePlayerRows, activePlayerColumns, activePlayerSort])
  const sortedCharacterRows = useMemo(() => sortRows(visibleCharacterRows, characterColumns[characterView], characterSort), [visibleCharacterRows, characterColumns, characterView, characterSort])
  const sortedAdvancedBattingRows = useMemo(() => sortRows(advancedBattingQualifiers, advancedBattingColumns, advancedBattingSort), [advancedBattingQualifiers, advancedBattingColumns, advancedBattingSort])
  const sortedAdvancedPitchingRows = useMemo(() => sortRows(advancedPitchingQualifiers, advancedPitchingColumns, advancedPitchingSort), [advancedPitchingQualifiers, advancedPitchingColumns, advancedPitchingSort])

  const playerRowsWithBatting = useMemo(() => playerRows.filter(hasBattingData), [playerRows])
  const playerRowsWithPitching = useMemo(() => playerRows.filter(hasPitchingData), [playerRows])
  const characterRowsWithBatting = useMemo(() => characterRows.filter(hasBattingData), [characterRows])
  const characterRowsWithPitching = useMemo(() => characterRows.filter(hasPitchingData), [characterRows])

  const sortedBbBattingPlayer = useMemo(() => sortRows(playerRowsWithBatting, bbBattingCols, bbPlayerSort, 'name'), [playerRowsWithBatting, bbBattingCols, bbPlayerSort])
  const sortedBbPitchingPlayer = useMemo(() => sortRows(playerRowsWithPitching, bbPitchingCols, bbPlayerSort, 'name'), [playerRowsWithPitching, bbPitchingCols, bbPlayerSort])
  const sortedBbBattingChar = useMemo(() => sortRows(characterRowsWithBatting, bbBattingCharCols, bbCharacterSort, 'name'), [characterRowsWithBatting, bbBattingCharCols, bbCharacterSort])
  const sortedBbPitchingChar = useMemo(() => sortRows(characterRowsWithPitching, bbPitchingCharCols, bbCharacterSort, 'name'), [characterRowsWithPitching, bbPitchingCharCols, bbCharacterSort])

  const sortedPowerBattingPlayer = useMemo(() => sortRows(playerRowsWithBatting, powerBattingCols, powerPlayerSort, 'name'), [playerRowsWithBatting, powerBattingCols, powerPlayerSort])
  const sortedPowerBattingChar = useMemo(() => sortRows(characterRowsWithBatting, powerBattingCharCols, powerCharacterSort, 'name'), [characterRowsWithBatting, powerBattingCharCols, powerCharacterSort])

  const sortedExitVeloPlayer = useMemo(() => sortRows(playerRowsWithBatting, exitVeloCols, exitVeloPlayerSort, 'name'), [playerRowsWithBatting, exitVeloCols, exitVeloPlayerSort])
  const sortedExitVeloChar = useMemo(() => sortRows(characterRowsWithBatting, exitVeloCharCols, exitVeloCharacterSort, 'name'), [characterRowsWithBatting, exitVeloCharCols, exitVeloCharacterSort])

  const sortedContactQualityPlayer = useMemo(() => sortRows(playerRowsWithBatting, contactQualityCols, contactQualityPlayerSort, 'name'), [playerRowsWithBatting, contactQualityCols, contactQualityPlayerSort])
  const sortedContactQualityChar = useMemo(() => sortRows(characterRowsWithBatting, contactQualityCharCols, contactQualityCharacterSort, 'name'), [characterRowsWithBatting, contactQualityCharCols, contactQualityCharacterSort])

  const sortedExpectedPlayer = useMemo(() => sortRows(playerRowsWithBatting, expectedCols, expectedPlayerSort, 'name'), [playerRowsWithBatting, expectedCols, expectedPlayerSort])
  const sortedExpectedChar = useMemo(() => sortRows(characterRowsWithBatting, expectedCharCols, expectedCharacterSort, 'name'), [characterRowsWithBatting, expectedCharCols, expectedCharacterSort])

  const sortedLocBattingPlayer = useMemo(() => sortRows(playerRowsWithBatting, locBattingPlayerCols, locPlayerSort, 'name'), [playerRowsWithBatting, locBattingPlayerCols, locPlayerSort])
  const sortedLocPitchingPlayer = useMemo(() => sortRows(playerRowsWithPitching, locPitchingPlayerCols, locPlayerSort, 'name'), [playerRowsWithPitching, locPitchingPlayerCols, locPlayerSort])
  const sortedLocBattingChar = useMemo(() => sortRows(characterRowsWithBatting, locBattingCharCols, locCharacterSort, 'name'), [characterRowsWithBatting, locBattingCharCols, locCharacterSort])
  const sortedLocPitchingChar = useMemo(() => sortRows(characterRowsWithPitching, locPitchingCharCols, locCharacterSort, 'name'), [characterRowsWithPitching, locPitchingCharCols, locCharacterSort])

  const sortedDiscBattingPlayer = useMemo(() => sortRows(playerRowsWithBatting, discBattingPlayerCols, discPlayerSort, 'name'), [playerRowsWithBatting, discBattingPlayerCols, discPlayerSort])
  const sortedDiscPitchingPlayer = useMemo(() => sortRows(playerRowsWithPitching, discPitchingPlayerCols, mixPlayerSort, 'name'), [playerRowsWithPitching, discPitchingPlayerCols, mixPlayerSort])
  const sortedDiscBattingChar = useMemo(() => sortRows(characterRowsWithBatting, discBattingCharCols, discCharacterSort, 'name'), [characterRowsWithBatting, discBattingCharCols, discCharacterSort])
  const sortedDiscPitchingChar = useMemo(() => sortRows(characterRowsWithPitching, discPitchingCharCols, mixCharacterSort, 'name'), [characterRowsWithPitching, discPitchingCharCols, mixCharacterSort])

  const sortedBpBattingPlayer = useMemo(() => sortRows(ballparkPlayerBattingRows, bpBattingPlayerCols, bpBattingPlayerSort, 'name'), [ballparkPlayerBattingRows, bpBattingPlayerCols, bpBattingPlayerSort])
  const sortedBpBattingChar = useMemo(() => sortRows(ballparkCharacterBattingRows, bpBattingCharCols, bpBattingCharacterSort, 'name'), [ballparkCharacterBattingRows, bpBattingCharCols, bpBattingCharacterSort])
  const sortedBpPitchingPlayer = useMemo(() => sortRows(ballparkPlayerPitchingRows, bpPitchingPlayerCols, bpPitchingPlayerSort, 'name'), [ballparkPlayerPitchingRows, bpPitchingPlayerCols, bpPitchingPlayerSort])
  const sortedBpPitchingChar = useMemo(() => sortRows(ballparkCharacterPitchingRows, bpPitchingCharCols, bpPitchingCharacterSort, 'name'), [ballparkCharacterPitchingRows, bpPitchingCharCols, bpPitchingCharacterSort])
  const sortedBpFactorsTeam = useMemo(() => sortRows(teamParkFactorRows, bpFactorsTeamCols, bpFactorsTeamSort, 'name'), [teamParkFactorRows, bpFactorsTeamCols, bpFactorsTeamSort])
  const sortedBpFactorsChar = useMemo(() => sortRows(charParkFactorRows, bpFactorsCharCols, bpFactorsCharSort, 'name'), [charParkFactorRows, bpFactorsCharCols, bpFactorsCharSort])
  const sortedBpFactorsPitTeam = useMemo(() => sortRows(teamParkFactorRows.filter((r) => r.parkIp > 0), bpFactorsPitTeamCols, bpFactorsPitTeamSort, 'name'), [teamParkFactorRows, bpFactorsPitTeamCols, bpFactorsPitTeamSort])
  const sortedBpFactorsPitChar = useMemo(() => sortRows(charParkFactorRows.filter((r) => r.parkIp > 0), bpFactorsPitCharCols, bpFactorsPitCharSort, 'name'), [charParkFactorRows, bpFactorsPitCharCols, bpFactorsPitCharSort])

  const battingGlossary = [
    { term: 'BABIP', definition: 'Batting average on balls in play, excluding strikeouts and home runs.' },
    { term: 'ISO', definition: 'Isolated power, or slugging minus batting average.' },
    { term: 'wOBA', definition: 'Weighted on-base average using linear weights for each offensive event.' },
    { term: 'wRC+', definition: 'Run creation index relative to league average, where 100 is average.' },
    { term: 'OPS+', definition: 'On-base plus slugging adjusted to league average, where 100 is average.' },
    { term: 'K%', definition: 'Strikeouts divided by plate appearances.' },
    { term: 'BB%', definition: 'Walks divided by plate appearances.' },
    { term: 'BB/K', definition: 'Walk-to-strikeout ratio.' },
    { term: 'XBH%', definition: 'Extra-base hit rate.' },
    { term: 'HR/PA', definition: 'Home runs divided by plate appearances.' },
    { term: 'RC/3', definition: 'Runs Created per 3-inning game (9 outs).' },
  ]

  const pitchingGlossary = [
    { term: 'ERA/3', definition: 'Earned Run Average per 3-inning game (9 outs).' },
    { term: 'FIP', definition: 'Fielding Independent Pitching scaled to the 3-inning environment.' },
    { term: 'FIP-', definition: 'FIP relative to league average, where lower than 100 is better.' },
    { term: 'ERA-', definition: 'ERA/3 relative to league average, where lower than 100 is better.' },
    { term: 'WHIP', definition: 'Walks plus hits allowed per inning pitched.' },
    { term: 'K/3', definition: 'Strikeouts per 3-inning game (9 outs).' },
    { term: 'BB/3', definition: 'Walks per 3-inning game (9 outs).' },
    { term: 'H/3', definition: 'Hits allowed per 3-inning game (9 outs).' },
    { term: 'HR/3', definition: 'Home runs allowed per 3-inning game (9 outs).' },
    { term: 'BABIP Allowed', definition: 'Approximate batting average on balls in play allowed.' },
  ]

  // The rail groups categories by discipline (Batting/Pitching/Fielding), each
  // of which maps to an existing statView plus, where that view has its own
  // batting/pitching split, the matching sub-view -- so picking a rail item
  // is a single action instead of a statView click followed by a second
  // in-page Batting/Pitching toggle.
  function selectStatsSection(discipline, view) {
    setStatDiscipline(discipline)
    setStatView(view)
    if (view === 'overview') {
      setPlayerView(discipline)
      setCharacterView(discipline)
    } else if (view === 'batted_ball') {
      setBbSubView(discipline)
    } else if (view === 'discipline') {
      setDiscSubView(discipline)
    } else if (view === 'ballparks') {
      setBallparkSubView(discipline)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <div></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select onChange={(event) => setSourceMode(event.target.value)} value={sourceMode}>
            <option value="all">All Stats</option>
            <option value="tournaments">Tournaments</option>
            <option value="seasons">Seasons</option>
          </select>
          {sourceMode === 'tournaments' ? (
            <select onChange={(event) => setSelectedTournamentId(event.target.value)} value={selectedTournamentValue}>
              {tournaments.map((tournament) => (
                <option key={tournament.id} value={tournament.id}>
                  Tournament {tournament.tournament_number}
                </option>
              ))}
            </select>
          ) : null}
          {sourceMode === 'seasons' ? (
            <select onChange={(event) => setSelectedSeasonId(event.target.value)} value={selectedSeasonValue}>
              {seasons.map((season) => (
                <option key={season.id} value={season.id}>
                  {season.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <div className="stats-shell">
        <nav className="stats-rail">
          <div className="stats-rail-toggle">
            <button className={`stats-rail-toggle-btn ${tab === 'players' ? 'stats-rail-toggle-btn-active' : ''}`} onClick={() => setTab('players')} type="button">Players</button>
            <button className={`stats-rail-toggle-btn ${tab === 'characters' ? 'stats-rail-toggle-btn-active' : ''}`} onClick={() => setTab('characters')} type="button">Characters</button>
          </div>
          <div className="stats-rail-group">
            <div className="stats-rail-label">Batting</div>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'overview' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'overview')} type="button">Overview</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'batted_ball' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'batted_ball')} type="button">Batted Ball</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'discipline' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'discipline')} type="button">Plate Discipline</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'power' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'power')} type="button">Power / Distance</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'exit_velocity' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'exit_velocity')} type="button">Exit Velocity</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'contact_quality' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'contact_quality')} type="button">Contact Quality</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'expected' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'expected')} type="button">Expected Stats</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'stars' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'stars')} type="button">Stars</button>
            <button className={`stats-rail-item ${statDiscipline === 'batting' && statView === 'ballparks' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('batting', 'ballparks')} type="button">Ballparks</button>
          </div>

          <div className="stats-rail-group">
            <div className="stats-rail-label">Pitching</div>
            <button className={`stats-rail-item ${statDiscipline === 'pitching' && statView === 'overview' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('pitching', 'overview')} type="button">Overview</button>
            <button className={`stats-rail-item ${statDiscipline === 'pitching' && statView === 'batted_ball' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('pitching', 'batted_ball')} type="button">Batted Ball Allowed</button>
            <button className={`stats-rail-item ${statDiscipline === 'pitching' && statView === 'discipline' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('pitching', 'discipline')} type="button">Pitch Mix</button>
            <button className={`stats-rail-item ${statDiscipline === 'pitching' && statView === 'stars' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('pitching', 'stars')} type="button">Stars</button>
            <button className={`stats-rail-item ${statDiscipline === 'pitching' && statView === 'ballparks' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('pitching', 'ballparks')} type="button">Ballparks</button>
          </div>

          <div className="stats-rail-group">
            <div className="stats-rail-label">Fielding</div>
            <button className={`stats-rail-item ${statDiscipline === 'fielding' && statView === 'overview' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('fielding', 'overview')} type="button">Overview</button>
            <button className={`stats-rail-item ${statDiscipline === 'fielding' && statView === 'stars' ? 'stats-rail-item-active' : ''}`} onClick={() => selectStatsSection('fielding', 'stars')} type="button">Stars</button>
          </div>
        </nav>

        <div className="stats-main">
      {statView === 'overview' && tab === 'players' ? (
        <section className="table-card">
          <SortableStatsTable
            columns={activePlayerColumns}
            emptyMessage="No player stats found for this view."
            onRowClick={(row) => setSelectedPlayerCardId(row.playerId)}
            onSort={(column) => toggleSort(setPlayerSort, column)}
            rowKey={(row) => row.playerId}
            rows={sortedPlayerRows}
            sortState={activePlayerSort}
          />
        </section>
      ) : null}

      {statView === 'overview' && tab === 'characters' ? (
        <section className="table-card">
          <SortableStatsTable columns={characterColumns[characterView]} emptyMessage="No character stats found for this view." onRowClick={(row) => openCharacterPage(row.id)} onSort={(column) => toggleSort(setCharacterSort, column)} rowKey={(row) => row.id} rows={sortedCharacterRows} sortState={characterSort} />
        </section>
      ) : null}

      {statView === 'batted_ball' ? (
        <section className="table-card">
          {bbSubView === 'batting' ? (
            <div className="page-stack">
              <div>
                <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Trajectory &amp; Direction</div>
                {tab === 'players' ? (
                  <SortableStatsTable columns={bbBattingCols} emptyMessage="No batted ball data." onSort={(col) => toggleSort(setBbPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBbBattingPlayer} sortState={bbPlayerSort} />
                ) : (
                  <SortableStatsTable columns={bbBattingCharCols} emptyMessage="No batted ball data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBbCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBbBattingChar} sortState={bbCharacterSort} />
                )}
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Hit Location</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => setLocationDisplayMode('pct')}
                      style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', background: locationDisplayMode === 'pct' ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)', color: locationDisplayMode === 'pct' ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
                    >%</button>
                    <button
                      type="button"
                      onClick={() => setLocationDisplayMode('count')}
                      style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', background: locationDisplayMode === 'count' ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)', color: locationDisplayMode === 'count' ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
                    >#</button>
                  </div>
                </div>
                {tab === 'players' ? (
                  <SortableStatsTable columns={locBattingPlayerCols} emptyMessage="No hit location data." onSort={(col) => toggleSort(setLocPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedLocBattingPlayer} sortState={locPlayerSort} />
                ) : (
                  <SortableStatsTable columns={locBattingCharCols} emptyMessage="No hit location data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setLocCharacterSort, col)} rowKey={(row) => row.id} rows={sortedLocBattingChar} sortState={locCharacterSort} />
                )}
              </div>
            </div>
          ) : (
            <div className="page-stack">
              <div>
                <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Trajectory &amp; Direction Allowed</div>
                {tab === 'players' ? (
                  <SortableStatsTable columns={bbPitchingCols} emptyMessage="No batted ball data." onSort={(col) => toggleSort(setBbPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBbPitchingPlayer} sortState={bbPlayerSort} />
                ) : (
                  <SortableStatsTable columns={bbPitchingCharCols} emptyMessage="No batted ball data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBbCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBbPitchingChar} sortState={bbCharacterSort} />
                )}
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Hit Location Allowed</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" onClick={() => setLocationDisplayMode('pct')} style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', background: locationDisplayMode === 'pct' ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)', color: locationDisplayMode === 'pct' ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>%</button>
                    <button type="button" onClick={() => setLocationDisplayMode('count')} style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', background: locationDisplayMode === 'count' ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)', color: locationDisplayMode === 'count' ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>#</button>
                  </div>
                </div>
                {tab === 'players' ? (
                  <SortableStatsTable columns={locPitchingPlayerCols} emptyMessage="No hit location data." onSort={(col) => toggleSort(setLocPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedLocPitchingPlayer} sortState={locPlayerSort} />
                ) : (
                  <SortableStatsTable columns={locPitchingCharCols} emptyMessage="No hit location data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setLocCharacterSort, col)} rowKey={(row) => row.id} rows={sortedLocPitchingChar} sortState={locCharacterSort} />
                )}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {statView === 'power' ? (
        <section className="table-card">
          {tab === 'players' ? (
            <SortableStatsTable columns={powerBattingCols} emptyMessage="No hit distance data tracked yet." onSort={(col) => toggleSort(setPowerPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedPowerBattingPlayer} sortState={powerPlayerSort} />
          ) : (
            <SortableStatsTable columns={powerBattingCharCols} emptyMessage="No hit distance data tracked yet." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setPowerCharacterSort, col)} rowKey={(row) => row.id} rows={sortedPowerBattingChar} sortState={powerCharacterSort} />
          )}
          <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, margin: '20px 0 8px' }}>Spray Chart (all tracked hits, this view)</div>
          <SprayChart plateAppearances={filteredPasWithCharacterNames} showCharacterName />
        </section>
      ) : null}

      {statView === 'exit_velocity' ? (
        <section className="table-card">
          <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>
            Exit Velocity ({MIN_PA_THRESHOLD}+ tracked BIP to qualify)
          </div>
          {tab === 'players' ? (
            <SortableStatsTable columns={exitVeloCols} emptyMessage="No exit velocity data tracked yet." onSort={(col) => toggleSort(setExitVeloPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedExitVeloPlayer} sortState={exitVeloPlayerSort} />
          ) : (
            <SortableStatsTable columns={exitVeloCharCols} emptyMessage="No exit velocity data tracked yet." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setExitVeloCharacterSort, col)} rowKey={(row) => row.id} rows={sortedExitVeloChar} sortState={exitVeloCharacterSort} />
          )}
        </section>
      ) : null}

      {statView === 'contact_quality' ? (
        <section className="table-card">
          <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>
            Contact Quality ({MIN_PA_THRESHOLD}+ tracked BIP to qualify)
          </div>
          {tab === 'players' ? (
            <SortableStatsTable columns={contactQualityCols} emptyMessage="No contact quality data tracked yet." onSort={(col) => toggleSort(setContactQualityPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedContactQualityPlayer} sortState={contactQualityPlayerSort} />
          ) : (
            <SortableStatsTable columns={contactQualityCharCols} emptyMessage="No contact quality data tracked yet." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setContactQualityCharacterSort, col)} rowKey={(row) => row.id} rows={sortedContactQualityChar} sortState={contactQualityCharacterSort} />
          )}
        </section>
      ) : null}

      {statView === 'expected' ? (
        <section className="table-card">
          <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>
            Expected Stats (modeled from contact quality, independent of actual outcome)
          </div>
          {tab === 'players' ? (
            <SortableStatsTable columns={expectedCols} emptyMessage="No expected stats tracked yet." onSort={(col) => toggleSort(setExpectedPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedExpectedPlayer} sortState={expectedPlayerSort} />
          ) : (
            <SortableStatsTable columns={expectedCharCols} emptyMessage="No expected stats tracked yet." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setExpectedCharacterSort, col)} rowKey={(row) => row.id} rows={sortedExpectedChar} sortState={expectedCharacterSort} />
          )}
        </section>
      ) : null}

      {statView === 'discipline' ? (
        <section className="table-card">
          {discSubView === 'batting' ? (
            tab === 'players' ? (
              <SortableStatsTable columns={discBattingPlayerCols} emptyMessage="No plate discipline data." onSort={(col) => toggleSort(setDiscPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedDiscBattingPlayer} sortState={discPlayerSort} />
            ) : (
              <SortableStatsTable columns={discBattingCharCols} emptyMessage="No plate discipline data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setDiscCharacterSort, col)} rowKey={(row) => row.id} rows={sortedDiscBattingChar} sortState={discCharacterSort} />
            )
          ) : (
            tab === 'players' ? (
              <SortableStatsTable columns={discPitchingPlayerCols} emptyMessage="No pitch mix data." onSort={(col) => toggleSort(setMixPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedDiscPitchingPlayer} sortState={mixPlayerSort} />
            ) : (
              <SortableStatsTable columns={discPitchingCharCols} emptyMessage="No pitch mix data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setMixCharacterSort, col)} rowKey={(row) => row.id} rows={sortedDiscPitchingChar} sortState={mixCharacterSort} />
            )
          )}
        </section>
      ) : null}

      {statView === 'stars' ? (
        <section className="table-card">
          {statDiscipline === 'batting' ? (
            tab === 'players' ? (
              <SortableStatsTable columns={starsBattingPlayerCols} emptyMessage="No star hit data." onRowClick={(row) => setSelectedPlayerCardId(row.playerId)} onSort={(col) => toggleSort(setStarsBattingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedStarsBattingPlayer} sortState={starsBattingPlayerSort} />
            ) : (
              <SortableStatsTable columns={starsBattingCharCols} emptyMessage="No star hit data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setStarsBattingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedStarsBattingChar} sortState={starsBattingCharacterSort} />
            )
          ) : statDiscipline === 'pitching' ? (
            tab === 'players' ? (
              <SortableStatsTable columns={starsPitchingPlayerCols} emptyMessage="No star pitch data." onRowClick={(row) => setSelectedPlayerCardId(row.playerId)} onSort={(col) => toggleSort(setStarsPitchingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedStarsPitchingPlayer} sortState={starsPitchingPlayerSort} />
            ) : (
              <SortableStatsTable columns={starsPitchingCharCols} emptyMessage="No star pitch data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setStarsPitchingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedStarsPitchingChar} sortState={starsPitchingCharacterSort} />
            )
          ) : (
            tab === 'players' ? (
              <SortableStatsTable columns={starsFieldingPlayerCols} emptyMessage="No star fielding data." onRowClick={(row) => setSelectedPlayerCardId(row.playerId)} onSort={(col) => toggleSort(setStarsFieldingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedStarsFieldingPlayer} sortState={starsFieldingPlayerSort} />
            ) : (
              <SortableStatsTable columns={starsFieldingCharCols} emptyMessage="No star fielding data." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setStarsFieldingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedStarsFieldingChar} sortState={starsFieldingCharacterSort} />
            )
          )}
        </section>
      ) : null}

      {statView === 'ballparks' ? (
        <div className="page-stack">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              onClick={() => setSelectedStadiumKey(null)}
              style={{
                padding: '8px 14px',
                borderRadius: 12,
                border: `1px solid ${selectedStadiumKey === null ? 'rgba(234,179,8,0.55)' : 'rgba(255,255,255,0.12)'}`,
                background: selectedStadiumKey === null ? 'rgba(234,179,8,0.14)' : 'rgba(255,255,255,0.04)',
                color: selectedStadiumKey === null ? '#FDE68A' : '#CBD5E1',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              All Stadiums
            </button>
            {orderedStadiums.map((stadium) => {
              const isSelected = selectedStadiumKey === stadium.name
              const gamesPlayed = stadiumStats[stadium.name]?.gamesPlayed || 0
              return (
                <button
                  key={stadium.id}
                  type="button"
                  onClick={() => setSelectedStadiumKey(stadium.name)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 12,
                    border: `1px solid ${isSelected ? 'rgba(234,179,8,0.55)' : 'rgba(255,255,255,0.12)'}`,
                    background: isSelected ? 'rgba(234,179,8,0.10)' : 'rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    minWidth: 90,
                  }}
                >
                  <div style={getStadiumSpriteStyle(stadium.name, { width: 44, height: 32 })} />
                  <div style={{ color: isSelected ? '#FDE68A' : '#F8FAFC', fontWeight: 700, fontSize: 11, textAlign: 'center', lineHeight: 1.2 }}>{stadium.name}</div>
                  <div style={{ color: '#64748B', fontSize: 10 }}>{gamesPlayed} {gamesPlayed === 1 ? 'game' : 'games'}</div>
                </button>
              )
            })}
          </div>

          {selectedStadiumKey ? (
            <div style={{ padding: '0.75rem 1rem', borderRadius: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
              {(() => {
                const stadium = stadiums.find((s) => s.name === selectedStadiumKey)
                if (!stadium) return null
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
                    <div style={getStadiumSpriteStyle(stadium.name, { width: 60, height: 44, flexShrink: 0 })} />
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontWeight: 800, color: '#F8FAFC', marginBottom: 4 }}>{stadium.name}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {stadium.lf_distance ? <span className="muted" style={{ fontSize: 11 }}>LF {stadium.lf_distance}ft</span> : null}
                        {stadium.cf_distance ? <span className="muted" style={{ fontSize: 11 }}>CF {stadium.cf_distance}ft</span> : null}
                        {stadium.rf_distance ? <span className="muted" style={{ fontSize: 11 }}>RF {stadium.rf_distance}ft</span> : null}
                        {stadium.night_only ? <span className="muted" style={{ fontSize: 11 }}>Night only</span> : null}
                        {stadium.day_only ? <span className="muted" style={{ fontSize: 11 }}>Day only</span> : null}
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          ) : null}

          {selectedStadiumKey && STADIUM_NAME_TO_KEY[selectedStadiumKey] ? (
            <section className="table-card">
              <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Who's Raked Here</div>
              <SprayChart
                plateAppearances={filteredPasWithCharacterNames.filter((pa) => pa.hit_stadium_key === STADIUM_NAME_TO_KEY[selectedStadiumKey])}
                initialStadiumKey={STADIUM_NAME_TO_KEY[selectedStadiumKey]}
                showCharacterName
              />
            </section>
          ) : null}

          <section className="table-card">
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`tab-button ${ballparkSubView === 'batting' ? 'tab-button-active' : ''}`} onClick={() => { setBallparkSubView('batting'); setStatDiscipline('batting') }} type="button">Batting</button>
                  <button className={`tab-button ${ballparkSubView === 'pitching' ? 'tab-button-active' : ''}`} onClick={() => { setBallparkSubView('pitching'); setStatDiscipline('pitching') }} type="button">Pitching</button>
                  <button className={`tab-button ${ballparkSubView === 'factors' ? 'tab-button-active' : ''}`} onClick={() => setBallparkSubView('factors')} type="button">Park Factors</button>
                </div>
                {(() => {
                  const stadium = selectedStadiumKey ? stadiums.find((s) => s.name === selectedStadiumKey) : null
                  const showToggle = !stadium || (!stadium.day_only && !stadium.night_only)
                  if (!showToggle) return null
                  return (
                    <div style={{ display: 'flex', gap: 4, borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 12 }}>
                      {[{ value: 'all', label: 'All' }, { value: 'day', label: 'Day' }, { value: 'night', label: 'Night' }].map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setBallparkTimeFilter(value)}
                          style={{ padding: '3px 11px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: ballparkTimeFilter === value ? 'rgba(234,179,8,0.16)' : 'rgba(255,255,255,0.04)', color: ballparkTimeFilter === value ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                        >{label}</button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              {selectedStadiumKey ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  Showing stats at {selectedStadiumKey} ({stadiumStats[selectedStadiumKey]?.gamesPlayed || 0} games)
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>Showing stats across all stadiums</div>
              )}
            </div>

            {ballparkSubView === 'batting' ? (
              tab === 'players' ? (
                <SortableStatsTable columns={bpBattingPlayerCols} emptyMessage="No batting data at this stadium." onSort={(col) => toggleSort(setBpBattingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBpBattingPlayer} sortState={bpBattingPlayerSort} />
              ) : (
                <SortableStatsTable columns={bpBattingCharCols} emptyMessage="No batting data at this stadium." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpBattingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBpBattingChar} sortState={bpBattingCharacterSort} />
              )
            ) : null}

            {ballparkSubView === 'pitching' ? (
              tab === 'players' ? (
                <SortableStatsTable columns={bpPitchingPlayerCols} emptyMessage="No pitching data at this stadium." onSort={(col) => toggleSort(setBpPitchingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBpPitchingPlayer} sortState={bpPitchingPlayerSort} />
              ) : (
                <SortableStatsTable columns={bpPitchingCharCols} emptyMessage="No pitching data at this stadium." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpPitchingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBpPitchingChar} sortState={bpPitchingCharacterSort} />
              )
            ) : null}

            {ballparkSubView === 'factors' ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {!selectedStadiumKey ? (
                  <p className="muted" style={{ padding: '1rem 0' }}>Select a stadium above to see its park factors.</p>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {['league', 'teams', 'characters'].map((view) => (
                        <button key={view} className={`tab-button ${parkFactorsSubView === view ? 'tab-button-active' : ''}`} onClick={() => setParkFactorsSubView(view)} type="button" style={{ textTransform: 'capitalize' }}>{view}</button>
                      ))}
                    </div>
                    {parkFactorsSubView === 'league' ? (
                      !parkFactors ? (
                        <p className="muted" style={{ padding: '0.5rem 0' }}>No data available for this stadium yet.</p>
                      ) : (
                        <div style={{ display: 'grid', gap: 8 }}>
                          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                            Park factors show how this stadium affects each outcome relative to the league average (1.00 = neutral, &gt;1.00 = favors that outcome).
                          </p>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginTop: 4 }}>
                            {[
                              { key: 'hr', label: 'Home Runs' },
                              { key: 'r', label: 'Runs' },
                              { key: 'h', label: 'Hits' },
                              { key: 'single', label: 'Singles' },
                              { key: 'double', label: 'Doubles' },
                              { key: 'triple', label: 'Triples' },
                              { key: 'walk', label: 'Walks' },
                              { key: 'strikeout', label: 'Strikeouts' },
                              { key: 'hbp', label: 'Hit By Pitch' },
                              { key: 'sacFly', label: 'Sac Flies' },
                              { key: 'sacHit', label: 'Sac Bunts' },
                              { key: 'error', label: 'Errors' },
                              { key: 'doublePlay', label: 'Double Plays' },
                              { key: 'reachedOnError', label: 'Reached on Error' },
                            ].map(({ key, label }) => {
                              const value = parkFactors[key]
                              const diff = value - 1
                              const color = Math.abs(diff) < 0.03 ? '#94A3B8' : diff > 0 ? '#22C55E' : '#EF4444'
                              const sign = diff > 0 ? '+' : ''
                              const rankInfo = parkFactorRankings?.[key]
                              return (
                                <div key={key} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '0.75rem 0.9rem', background: 'rgba(255,255,255,0.03)' }}>
                                  <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
                                  <div style={{ color, fontSize: 22, fontWeight: 800, marginTop: 4 }}>{value.toFixed(2)}</div>
                                  <div style={{ color, fontSize: 11, fontWeight: 700 }}>{sign}{(diff * 100).toFixed(0)}%</div>
                                  {rankInfo ? (
                                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{ordinal(rankInfo.rank)} of {rankInfo.total}</div>
                                  ) : null}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    ) : null}
                    {(parkFactorsSubView === 'teams' || parkFactorsSubView === 'characters') ? (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                        <button className={`tab-button ${parkFactorsBatPit === 'batting' ? 'tab-button-active' : ''}`} onClick={() => setParkFactorsBatPit('batting')} type="button">Batting</button>
                        <button className={`tab-button ${parkFactorsBatPit === 'pitching' ? 'tab-button-active' : ''}`} onClick={() => setParkFactorsBatPit('pitching')} type="button">Pitching</button>
                      </div>
                    ) : null}
                    {parkFactorsSubView === 'teams' ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {parkFactorsBatPit === 'batting' ? (
                          <>
                            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each team&apos;s batting stats at this park vs. their overall stats. Δ = park minus overall (green = better at park). Min 3 PA.</p>
                            <SortableStatsTable columns={bpFactorsTeamCols} emptyMessage="Not enough data yet (min 3 PA per team)." onSort={(col) => toggleSort(setBpFactorsTeamSort, col)} rowKey={(row) => row.playerId} rows={sortedBpFactorsTeam} sortState={bpFactorsTeamSort} />
                          </>
                        ) : (
                          <>
                            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each team&apos;s pitching stats at this park vs. their overall stats. ERA/WHIP Δ: green = performed better at this park (lower ERA/WHIP).</p>
                            <SortableStatsTable columns={bpFactorsPitTeamCols} emptyMessage="No pitching data at this park." onSort={(col) => toggleSort(setBpFactorsPitTeamSort, col)} rowKey={(row) => row.playerId} rows={sortedBpFactorsPitTeam} sortState={bpFactorsPitTeamSort} />
                          </>
                        )}
                      </div>
                    ) : null}
                    {parkFactorsSubView === 'characters' ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {parkFactorsBatPit === 'batting' ? (
                          <>
                            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each character&apos;s batting stats at this park vs. their overall stats. Δ = park minus overall (green = better at park). Min 3 PA.</p>
                            <SortableStatsTable columns={bpFactorsCharCols} emptyMessage="Not enough data yet (min 3 PA per character)." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpFactorsCharSort, col)} rowKey={(row) => String(row.id)} rows={sortedBpFactorsChar} sortState={bpFactorsCharSort} />
                          </>
                        ) : (
                          <>
                            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each character&apos;s pitching stats at this park vs. their overall stats. ERA/WHIP Δ: green = performed better at this park (lower ERA/WHIP).</p>
                            <SortableStatsTable columns={bpFactorsPitCharCols} emptyMessage="No pitching data at this park." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpFactorsPitCharSort, col)} rowKey={(row) => String(row.id)} rows={sortedBpFactorsPitChar} sortState={bpFactorsPitCharSort} />
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
        </div>
      </div>
      {selectedPlayerCard ? (
        <TeamStatCardModal
          row={selectedPlayerCard}
          identitiesByPlayerId={identitiesByPlayerId}
          playersById={playersById}
          onClose={() => setSelectedPlayerCardId(null)}
        />
      ) : null}
    </div>
  )
}
