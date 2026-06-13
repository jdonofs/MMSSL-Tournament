import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import {
  buildCharacterIntrinsics,
  buildCharacterHistory,
  buildStandings,
  computeLeagueConstants,
  groupBy,
  inningsAsDecimal,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizeFielding,
  summarizePitchMix,
  summarizePitching,
  summarizePlateDiscipline,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
} from '../utils/statsCalculator'
import { buildTournamentTeamIdentityMap, getTeamShortName } from '../utils/teamIdentity'
import SharedCharacterDetailModal from '../components/CharacterDetailModal'
import CharacterPortrait from '../components/CharacterPortrait'
import PlayerTag from '../components/PlayerTag'
import { getChemistry } from '../data/chemistry'
import { formatSeasonLabel } from '../utils/season'

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
    cleanPlays: 0,
    fieldingPct: 0,
    positionsPlayed: 0,
    primaryPosition: '-',
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
  return Number(row?.pitching?.games || 0) > 0 || Number(row?.pitchingThresholdIp || 0) > 0
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

    const characterId = charactersByName[resolvedCharacterName]?.id || null
    const characterEntry = ensureEntry(characterMap, resolvedCharacterName, { id: characterId, name: resolvedCharacterName })
    characterEntry.gamesSet.add(gameId)
    characterEntry.positionsSet.add(position)
    characterEntry.positionCounts[position] = (characterEntry.positionCounts[position] || 0) + 1
    characterEntry.chances += chances
    characterEntry.putouts += putouts
    characterEntry.assists += assists
    characterEntry.errors += errors
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

    if (pa.is_error) {
      const errorIndex = errorPosition ? positions.lastIndexOf(errorPosition) : -1
      const assistPositions = errorIndex >= 0 ? positions.slice(0, errorIndex) : positions
      // A fielder is credited with at most one assist per out, even if he
      // touches the ball more than once (e.g. a rundown).
      new Set(assistPositions).forEach((positionNumber) => {
        applyCreditFromFielder(pa, positionNumber, { chances: 1, assists: 1 })
      })

      const matchedError = errorPosition
        ? applyCreditFromFielder(pa, errorPosition, { chances: 1, errors: 1 })
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

    return {
      ...entry,
      games: entry.gamesSet.size,
      cleanPlays: Math.max(0, entry.chances - entry.errors),
      fieldingPct: entry.chances ? Math.max(0, entry.chances - entry.errors) / entry.chances : 0,
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
                    { label: 'BL%', value: `${(battingBattedBall.bloopRate * 100).toFixed(0)}%`, accent: '#F8FAFC' },
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
  const [selectedCharacterId, setSelectedCharacterId] = useState(null)
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
  const filteredPitching = useMemo(() => {
    if (isCombinedView) {
      return [...pitchingStints, ...seasonPitchingStints]
    }
    if (sourceMode === 'tournaments') {
      return pitchingStints.filter((stint) => String(gameById[stint.game_id]?.tournament_id) === String(selectedTournamentValue))
    }
    return seasonPitchingStints.filter((stint) => String(gameById[stint.game_id]?.tournament_id) === String(selectedSeasonValue))
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
    const starPitch = summarizeStarPitching(
      pitchingPas,
      filteredPitches.filter((pitch) => pitchingPaIds.has(String(pitch.pa_id))),
    )

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
    }
  }), [filteredPas, filteredPitches, leagueConstants, paByPlayer, pitchingByPlayer, playerFieldingById, standings])

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
      starPitch: summarizeStarPitching(pitchingPas, filteredPitches.filter((pitch) => pitch.pitcher_id === character.name)),
      fielding: characterFieldingByName[character.name] || createEmptyFieldingRow({ id: character.id, name: character.name }),
      currentOwner,
      ownerName: getTeamShortName(identitiesByPlayerId[currentOwner?.player_id]) || playersById[currentOwner?.player_id]?.name || 'Undrafted',
      totalDrafts: allPicks.length,
      tournamentsDrafted: tournamentIdsDrafted.length,
      championshipsWon,
      intrinsics: buildCharacterIntrinsics(character),
    }
  }), [allCharacterHistory, characters, characterFieldingByName, draftPicks, filteredCharacterHistory, filteredPas, filteredPitching, filteredPitches, identitiesByPlayerId, leagueConstants, ownerDraftPicks, pitchingStints, plateAppearances, playersById, seasonPitchingStints, seasonPlateAppearances, tournaments])

  const selectedCharacter = useMemo(
    () => characterRows.find((row) => row.id === selectedCharacterId) || null,
    [characterRows, selectedCharacterId],
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
      { key: 'starHitUsed', group: 'Stars', label: 'SHU', sortValue: (row) => row.starHit.used, value: (row) => row.starHit.used },
      { key: 'starHitConnected', group: 'Stars', label: 'SHC', sortValue: (row) => row.starHit.connected, value: (row) => row.starHit.connected },
      { key: 'starHitSuccessful', group: 'Stars', label: 'SHH', sortValue: (row) => row.starHit.successful, value: (row) => row.starHit.successful },
      { key: 'starHitRbi', group: 'Stars', label: 'SHRBI', sortValue: (row) => row.starHit.totalRbi, value: (row) => row.starHit.totalRbi },
      { key: 'starHitSuccessRate', group: 'Stars', label: 'SH%', sortValue: (row) => row.starHit.successRate, value: (row) => formatPercent(row.starHit.successRate, 1) },
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
      { key: 'starPitchUsed', group: 'Stars', label: 'SPU', sortValue: (row) => row.starPitch.used, value: (row) => row.starPitch.used },
      { key: 'starPitchPaUsed', group: 'Stars', label: 'SPPA', sortValue: (row) => row.starPitch.paUsed, value: (row) => row.starPitch.paUsed },
      { key: 'starPitchOuts', group: 'Stars', label: 'SPO', sortValue: (row) => row.starPitch.outsOnStarPitch, value: (row) => row.starPitch.outsOnStarPitch },
      { key: 'starPitchHits', group: 'Stars', label: 'SPH', sortValue: (row) => row.starPitch.hitsAllowedOnStarPitch, value: (row) => row.starPitch.hitsAllowedOnStarPitch },
      { key: 'starPitchSuccessRate', group: 'Stars', label: 'SP%', sortValue: (row) => row.starPitch.successRate, value: (row) => formatPercent(row.starPitch.successRate, 1) },
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
      { key: 'starHitUsed', group: 'Stars', label: 'SHU', sortValue: (row) => row.starHit.used, value: (row) => row.starHit.used },
      { key: 'starHitConnected', group: 'Stars', label: 'SHC', sortValue: (row) => row.starHit.connected, value: (row) => row.starHit.connected },
      { key: 'starHitSuccessful', group: 'Stars', label: 'SHH', sortValue: (row) => row.starHit.successful, value: (row) => row.starHit.successful },
      { key: 'starHitRbi', group: 'Stars', label: 'SHRBI', sortValue: (row) => row.starHit.totalRbi, value: (row) => row.starHit.totalRbi },
      { key: 'starHitSuccessRate', group: 'Stars', label: 'SH%', sortValue: (row) => row.starHit.successRate, value: (row) => formatPercent(row.starHit.successRate, 1) },
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
      { key: 'starPitchUsed', group: 'Stars', label: 'SPU', sortValue: (row) => row.starPitch.used, value: (row) => row.starPitch.used },
      { key: 'starPitchPaUsed', group: 'Stars', label: 'SPPA', sortValue: (row) => row.starPitch.paUsed, value: (row) => row.starPitch.paUsed },
      { key: 'starPitchOuts', group: 'Stars', label: 'SPO', sortValue: (row) => row.starPitch.outsOnStarPitch, value: (row) => row.starPitch.outsOnStarPitch },
      { key: 'starPitchHits', group: 'Stars', label: 'SPH', sortValue: (row) => row.starPitch.hitsAllowedOnStarPitch, value: (row) => row.starPitch.hitsAllowedOnStarPitch },
      { key: 'starPitchSuccessRate', group: 'Stars', label: 'SP%', sortValue: (row) => row.starPitch.successRate, value: (row) => formatPercent(row.starPitch.successRate, 1) },
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
      { key: 'owner', group: 'Identity', label: 'Owner', type: 'string', sortValue: (row) => row.ownerName, render: (row) => row.currentOwner ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.currentOwner.player_id} playersById={playersById} /> : row.ownerName },
    ],
  }), [identitiesByPlayerId, playersById])

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

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          {isCombinedView ? <p className="muted">Stats include all tournaments and seasons.</p> : null}
        </div>
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

      <div className="tab-row">
        <button className={`tab-button ${tab === 'players' ? 'tab-button-active' : ''}`} onClick={() => setTab('players')} type="button">Players</button>
        <button className={`tab-button ${tab === 'characters' ? 'tab-button-active' : ''}`} onClick={() => setTab('characters')} type="button">Characters</button>
      </div>

      {tab === 'players' ? (
        <section className="table-card">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button className={`tab-button ${playerView === PLAYER_VIEWS.batting ? 'tab-button-active' : ''}`} onClick={() => setPlayerView(PLAYER_VIEWS.batting)} type="button">Batting</button>
            <button className={`tab-button ${playerView === PLAYER_VIEWS.pitching ? 'tab-button-active' : ''}`} onClick={() => setPlayerView(PLAYER_VIEWS.pitching)} type="button">Pitching</button>
            <button className={`tab-button ${playerView === PLAYER_VIEWS.fielding ? 'tab-button-active' : ''}`} onClick={() => setPlayerView(PLAYER_VIEWS.fielding)} type="button">Fielding</button>
          </div>

          <SortableStatsTable
            columns={activePlayerColumns}
            emptyMessage="No player stats found for this view."
            onSort={(column) => toggleSort(setPlayerSort, column)}
            rowKey={(row) => row.playerId}
            rows={sortedPlayerRows}
            sortState={activePlayerSort}
          />
        </section>
      ) : null}

      {tab === 'characters' ? (
        <section className="table-card">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className={`tab-button ${characterView === CHARACTER_VIEWS.batting ? 'tab-button-active' : ''}`} onClick={() => setCharacterView(CHARACTER_VIEWS.batting)} type="button">Batting</button>
            <button className={`tab-button ${characterView === CHARACTER_VIEWS.pitching ? 'tab-button-active' : ''}`} onClick={() => setCharacterView(CHARACTER_VIEWS.pitching)} type="button">Pitching</button>
            <button className={`tab-button ${characterView === CHARACTER_VIEWS.fielding ? 'tab-button-active' : ''}`} onClick={() => setCharacterView(CHARACTER_VIEWS.fielding)} type="button">Fielding</button>
          </div>
          <SortableStatsTable columns={characterColumns[characterView]} emptyMessage="No character stats found for this view." onRowClick={(row) => setSelectedCharacterId(row.id)} onSort={(column) => toggleSort(setCharacterSort, column)} rowKey={(row) => row.id} rows={sortedCharacterRows} sortState={characterSort} />
        </section>
      ) : null}
      {selectedCharacter ? (
        <SharedCharacterDetailModal
          character={selectedCharacter}
          allCharactersById={charactersByName}
          playersById={playersById}
          identitiesByPlayerId={identitiesByPlayerId}
          currentTournamentBatting={selectedCharacter.batting}
          currentTournamentPitching={selectedCharacter.pitching}
          allTimeBatting={selectedCharacter.allTimeBatting}
          allTimePitching={selectedCharacter.allTimePitching}
          allPitches={filteredPitches}
          allFielding={fieldingSummary}
          battingHistory={battingHistoryByCharacter[selectedCharacter.id] || []}
          pitchingHistory={pitchingHistoryByCharacter[selectedCharacter.id] || []}
          currentOwner={selectedCharacter.currentOwner}
          totalDrafts={selectedCharacter.totalDrafts}
          tournamentsDrafted={selectedCharacter.tournamentsDrafted}
          championshipsWon={selectedCharacter.championshipsWon}
          characterIntrinsics={selectedCharacter.intrinsics}
          onClose={() => setSelectedCharacterId(null)}
        />
      ) : null}
    </div>
  )
}
