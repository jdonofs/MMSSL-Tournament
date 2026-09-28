import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { createRefreshCoordinator } from '../utils/refreshCoordinator'
import {
  fetchSupersededTrackingPlayIds,
  onlyActiveTrackingFacts,
  onlyActiveTrackingPlays,
} from '../utils/activeTrackingVersions'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import {
  buildCharacterIntrinsics,
  buildCharacterHistory,
  buildFieldingAppearanceCredits,
  buildFielderSequenceCredits,
  buildStandings,
  calculateOutsForPa,
  calculateParkFactors,
  computeLeagueConstants,
  enrichPasWithPitchingContext,
  filterRunEventsForPlayer,
  groupBy,
  hasRispOpportunity,
  hasPitchingStatLine,
  qualifiesPerGameSample,
  qualifiesPitchingRate,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizeBattedBallProfile,
  summarizeBattedBallTypeProfile,
  summarizeDefensiveEfficiency,
  summarizeHitLocations,
  summarizePitchMix,
  summarizePitching,
  summarizePlateDiscipline,
  summarizeSprayContactProfile,
  summarizeSprayProfile,
  summarizeStarHits,
  summarizeStarPitching,
} from '../utils/statsCalculator'
import {
  calculateHitPowerIndex,
  calculateParkAdjustedDistance,
  summarizeContactQuality,
  summarizeExitVelocity,
  summarizeHitDistance,
} from '../utils/hitDistanceStats'
import { buildExpectedOutcomeModel, summarizeExpectedBatting, summarizeExpectedPitching } from '../utils/expectedStats'
import { computeDifficultySignal, computeRangeLeagueConstants, summarizeFieldingRange, MIN_RANGE_CHANCES } from '../utils/fieldingRange'
import {
  FEET_PER_SECOND_TO_MPH,
  summarizeAdvancedBaserunning,
  summarizeAdvancedFielding,
  summarizeMovementMetrics,
} from '../utils/advancedDefense'
import { parseErrorPositionsFromNotation } from '../utils/notation'
import { buildTournamentTeamIdentityMap, getTeamShortName } from '../utils/teamIdentity'
import { buildStadiumKeyByGameId, getOrderedStadiums, getStadiumSpriteStyle, STADIUM_NAME_TO_KEY } from '../utils/stadiums'
import { resolveSeasonPitchingDecisions, resolveTournamentPitchingDecisions, groupRunsByPaId } from '../utils/pitchingDecisions'
import VectorSprayChart from '../components/VectorSprayChart'
import CharacterPortrait from '../components/CharacterPortrait'
import MiddleClickLink from '../components/MiddleClickLink'
import PlayerTag from '../components/PlayerTag'
import StatLabel from '../components/StatLabel'
import StatFallbackLegend from '../components/StatFallbackLegend'
import ExperimentalWarPanel from '../components/ExperimentalWarPanel'
import { buildExperimentalWar } from '../utils/experimentalWar'
import UserValuePanel from '../components/UserValuePanel'
import { buildUserValueStats, USER_VALUE_VERSION } from '../utils/userValue'
import { summarizeMechanics } from '../utils/playerMechanics'
import {
  DOUBLE_PLAY_OPPORTUNITY_COLUMNS,
  FIELDING_OPPORTUNITY_COLUMNS,
  MOVEMENT_METRIC_COLUMNS,
  RUNNER_OPPORTUNITY_COLUMNS,
  TRACKING_THROW_COLUMNS,
  restoreQuality,
} from '../utils/trackingColumns'
import { shortenCharacterName } from '../utils/mii'
import { matchesNameFilter, resolveEffectiveSort } from '../utils/statsTableView'
import {
  dedupeStatRows,
  getStatGameKey,
  reconcileStatSource,
  selectPitchesForPlateAppearances,
  selectStatRowsForScope,
} from '../utils/statReconciliation'
import useIsCompactViewport from '../hooks/useIsCompactViewport'
import { formatGimmickLuckRuns, formatGimmickLuckScore, summarizeGimmickLuck } from '../utils/gimmickLuck'
import FinalStatEventsPanel from '../components/FinalStatEventsPanel'
import { fielderCoversPa } from '../utils/fielderStints.js'
import '../styles/stats-pages.css'

function abbreviateScopeLabel(prefix, value) {
  const match = String(value ?? '').match(/(\d+)\s*$/)
  return match ? `${prefix} ${match[1]}` : String(value ?? '')
}

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
const ALL_TEAMS_SPRAY_FILTER = '__all_teams__'

const DEFAULT_SORT = { key: 'name', direction: 'asc' }

// The page is laid out as rail sections, each holding one or more stat sets shown as tabs. A set
// with `table` renders SortableStatsTable from metricsBySet[`${section}.${set}`]; the rest have a
// dedicated view. `rows` picks the population (ROW_FILTERS), `filterable` shows the name filter,
// and `owner` appends the Owner column to the Characters table.
const STATS_SECTIONS = [
  { id: 'leaders', label: 'Leaders', sets: [] },
  {
    id: 'batting',
    label: 'Batting',
    sets: [
      { id: 'standard', label: 'Standard', table: true, rows: 'batting', filterable: true, owner: true },
      { id: 'advanced', label: 'Advanced', table: true, rows: 'batting', filterable: true, owner: true, legendNote: 'Batting rates need at least 1 PA per team game.' },
      { id: 'batted_ball', label: 'Batted Ball', table: true, rows: 'battedBall', rateToggle: 'Trajectory & direction', defaultSort: { key: 'bip', direction: 'desc' } },
      { id: 'contact', label: 'Contact Quality', table: true, rows: 'contact', defaultSort: { key: 'hitPowerIndex', direction: 'desc' } },
      { id: 'expected', label: 'Expected', table: true, rows: 'expected', defaultSort: { key: 'xwOBA', direction: 'desc' } },
      { id: 'discipline', label: 'Plate Discipline', table: true, rows: 'batting', defaultSort: { key: 'pitchesPerPa', direction: 'desc' } },
      { id: 'stars', label: 'Star Hits', table: true, rows: 'starHits', defaultSort: { key: 'starHitUsed', direction: 'desc' } },
      { id: 'spray', label: 'Spray & Location', table: true, view: 'spray', rows: 'spray', rateToggle: 'Hit locations', defaultSort: { key: 'bipLoc', direction: 'desc' } },
    ],
  },
  {
    id: 'pitching',
    label: 'Pitching',
    sets: [
      { id: 'standard', label: 'Standard', table: true, rows: 'pitching', filterable: true, owner: true },
      { id: 'advanced', label: 'Advanced', table: true, rows: 'pitching', filterable: true, owner: true, legendNote: 'Pitching rates need at least 1 IP per game pitched.' },
      { id: 'batted_ball', label: 'Batted Ball Allowed', table: true, rows: 'battedBallAllowed', rateToggle: 'Trajectory, direction & location', defaultSort: { key: 'bip', direction: 'desc' } },
      { id: 'expected', label: 'Expected Allowed', table: true, rows: 'expectedAllowed', defaultSort: { key: 'xwOBA', direction: 'desc' } },
      { id: 'pitch_mix', label: 'Pitch Mix', table: true, rows: 'pitchMix', defaultSort: { key: 'pitchesPerBatter', direction: 'desc' } },
      { id: 'stars', label: 'Star Pitches', table: true, rows: 'starPitches', defaultSort: { key: 'starPitchUsed', direction: 'desc' } },
    ],
  },
  {
    id: 'fielding',
    label: 'Fielding',
    sets: [
      { id: 'standard', label: 'Standard', table: true, rows: 'fielding', filterable: true, owner: true },
      { id: 'range', label: 'Range & OAA', table: true, rows: 'range', filterable: true, owner: true },
      { id: 'arm', label: 'Arm & Double Plays', table: true, rows: 'arm', filterable: true, owner: true },
      { id: 'jump', label: 'Jump & Positioning', table: true, rows: 'jump', filterable: true, owner: true },
    ],
  },
  {
    id: 'baserunning',
    label: 'Baserunning',
    sets: [
      { id: 'extra', label: 'Extra Bases', table: true, rows: 'extraBases', filterable: true },
      { id: 'speed', label: 'Speed', table: true, rows: 'speed', filterable: true },
    ],
  },
  {
    id: 'value',
    label: 'Value',
    sets: [
      { id: 'war', label: 'Experimental WAR' },
      { id: 'user', label: 'User Value' },
    ],
  },
  { id: 'ballparks', label: 'Ballparks', sets: [{ id: 'parks', label: 'Ballparks' }] },
  {
    id: 'events',
    label: 'Game Events',
    sets: [
      { id: 'stadium', label: 'Stadium Interactions' },
      { id: 'mechanics', label: 'Mechanics' },
      { id: 'gimmick', label: 'Gimmick Luck', table: true, rows: 'gimmick', defaultSort: { key: 'luckScore', direction: 'desc' }, emptyMessage: 'No confirmed gimmick interactions in this scope yet.' },
    ],
  },
]

// Desktop rail grouping; the compact viewport lists the same sections in one select.
const RAIL_GROUPS = [['leaders'], ['batting', 'pitching', 'fielding', 'baserunning'], ['value', 'ballparks', 'events']]

const EMPTY_CLOSE_PLAYS = Object.freeze({ closePlays: 0, closePlaysWon: 0, closePlaysLost: 0 })
const EMPTY_RUNNER_CLOSE_PLAYS = Object.freeze({ closePlaysRun: 0, closePlaysRunWon: 0, closePlaysRunLost: 0 })

// Only the close-play fields: the mechanics summary also carries Buddy counts
// whose names would otherwise land on the fielding line beside the official BJ.
function closePlayTotals(summary = {}) {
  return Object.fromEntries(Object.entries(summary).map(([id, row]) => [id, {
    closePlays: row.closePlays,
    closePlaysWon: row.closePlaysWon,
    closePlaysLost: row.closePlaysLost,
  }]))
}

// The same contests from the other side, onto the baserunning line. Kept apart
// from the fielding totals above because they are a different player: the
// fielder's loss is the runner's win, and one row cannot hold both readings.
function runnerClosePlayTotals(summary = {}) {
  return Object.fromEntries(Object.entries(summary).map(([id, row]) => [id, {
    closePlaysRun: row.closePlaysRun,
    closePlaysRunWon: row.closePlaysRunWon,
    closePlaysRunLost: row.closePlaysRunLost,
  }]))
}

function findStatsSet(setKey) {
  const [sectionId, setId] = String(setKey || '').split('.')
  return STATS_SECTIONS.find((entry) => entry.id === sectionId)?.sets.find((entry) => entry.id === setId) || null
}

// Each Leaders card is the top five of an existing table column, so a leader always matches the
// full table it links to. Rate stats only rank qualified rows; `positive` drops zero counts.
const LEADER_CARDS = [
  {
    id: 'batting',
    title: 'Batting',
    stats: [
      { set: 'batting.standard', key: 'avg', qualify: qualifiesAdvancedBatting },
      { set: 'batting.standard', key: 'homeRuns', positive: true },
      { set: 'batting.standard', key: 'rbi', positive: true },
      { set: 'batting.standard', key: 'ops', qualify: qualifiesAdvancedBatting },
      { set: 'batting.advanced', key: 'wrcPlus' },
      { set: 'batting.contact', key: 'avgExitVelo', qualify: qualifiesTrackedContact },
      { set: 'batting.contact', key: 'barrelRate', qualify: qualifiesTrackedContact },
      { set: 'batting.contact', key: 'maxDist' },
    ],
  },
  {
    id: 'pitching',
    title: 'Pitching',
    stats: [
      { set: 'pitching.standard', key: 'era', direction: 'asc', qualify: qualifiesAdvancedPitching },
      { set: 'pitching.standard', key: 'whip', direction: 'asc', qualify: qualifiesAdvancedPitching },
      { set: 'pitching.standard', key: 'strikeouts', positive: true },
      { set: 'pitching.standard', key: 'wins', positive: true },
      { set: 'pitching.advanced', key: 'fip', direction: 'asc' },
    ],
  },
  {
    id: 'fielding',
    title: 'Fielding',
    stats: [
      { set: 'fielding.range', key: 'oaa' },
      { set: 'fielding.range', key: 'frv', qualify: hasModeledFieldingOpportunity },
      { set: 'fielding.arm', key: 'armStrength' },
      { set: 'fielding.standard', key: 'nicePlays', positive: true },
    ],
  },
  {
    id: 'baserunning',
    title: 'Baserunning',
    stats: [
      { set: 'baserunning.speed', key: 'sprintSpeed' },
      { set: 'baserunning.extra', key: 'advances', positive: true },
      { set: 'baserunning.extra', key: 'rbaser' },
    ],
  },
  { id: 'value', title: 'Value', stats: [{ war: true }] },
]

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

function formatOptionalRate(value, digits = 3, fallback = '--') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
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

// Green = best, yellow = middle of the pack, red = worst -- a five-stop gradient
// (green -> lime -> yellow -> orange -> red) rather than a hard 3-color cutoff.
function getPositiveMetricColor(value) {
  if (!Number.isFinite(value)) return '#94A3B8'
  if (value >= 130) return '#22C55E'
  if (value >= 110) return '#84CC16'
  if (value >= 90) return '#EAB308'
  if (value >= 70) return '#F97316'
  return '#EF4444'
}

function getInverseMetricColor(value) {
  if (!Number.isFinite(value)) return '#94A3B8'
  if (value <= 70) return '#22C55E'
  if (value <= 90) return '#84CC16'
  if (value <= 110) return '#EAB308'
  if (value <= 130) return '#F97316'
  return '#EF4444'
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
    nicePlays: 0,
    nicePlayRate: null,
    rangeRuns: null,
    rangeable: 0,
    rangeFactorPlus: null,
    rangeConfidence: null,
    throws: 0,
    armStrengthMph: null,
    hardestThrowMph: null,
    buddyThrows: 0,
    hardestBuddyThrowMph: null,
    armOpportunities: 0,
    armHolds: 0,
    armKills: 0,
    armValue: null,
    doublePlayOpportunities: 0,
    doublePlays: 0,
    doublePlaysAdded: null,
    doublePlayRuns: null,
    fieldingOpportunities: 0,
    actualOuts: 0,
    expectedOuts: null,
    outsAboveAverage: null,
    fieldingRunValue: null,
    jumpSamples: 0,
    jumpDistanceFeet: null,
    jumpReactionFeet: null,
    jumpBurstFeet: null,
    jumpRouteEfficiency: null,
    defensiveEfficiencyOpportunities: 0,
    defensiveEfficiency: null,
    positioningSamples: 0,
    averagePositionDepthFeet: null,
    averagePositionAngleDeg: null,
    directionalOaa: {},
    directionalOpportunities: {},
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
  // A play can carry more than one "-E<n>" segment when multiple fielders
  // booted the same play — parseErrorPositionsFromNotation picks up all of
  // them. Rows saved before multi-error support (or with no notation at all)
  // fall back to the single error_position column.
  const notationErrorPositions = parseErrorPositionsFromNotation(notation)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  const errorPositions = notationErrorPositions.length
    ? notationErrorPositions
    : (Number(pa.error_position) > 0 ? [Number(pa.error_position)] : [])

  return {
    positions,
    errorPositions,
    errorPosition: errorPositions[0] ?? null,
  }
}

// Identity cell for the Characters tables. The portrait alone used to be the whole cell, which
// made every row anonymous — 28px of Mario is not a label. Portrait + name now, with the colour
// prefix abbreviated the same way TeamPage does it and the full name on hover for the ones that
// still have to ellipsis.
function CharacterCell({ name, to }) {
  const content = (
    <div className="stats-identity-cell" title={name}>
      <CharacterPortrait name={name} size={28} />
      <span className="stats-identity-name">{shortenCharacterName(name)}</span>
    </div>
  )
  if (!to) return content
  return (
    <MiddleClickLink to={to} stopPropagation style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
      {content}
    </MiddleClickLink>
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
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><StatLabel label={label} /></span>
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
  return Number(row?.fielding?.chances || 0) > 0
    || Number(row?.fielding?.errors || 0) > 0
    || Number(row?.fielding?.buddyJumps || 0) > 0
    || Number(row?.fielding?.fieldingOpportunities || 0) > 0
    || Number(row?.fielding?.armOpportunities || 0) > 0
    || Number(row?.fielding?.doublePlayOpportunities || 0) > 0
    || Number(row?.fielding?.throws || 0) > 0
}

function qualifiesAdvancedBatting(row) {
  return qualifiesPerGameSample(row?.batting?.plateAppearances, row?.teamGamesPlayed)
}

function qualifiesAdvancedPitching(row) {
  return qualifiesPitchingRate(row?.pitching)
}

function qualifiesForPower(row) {
  return qualifiesPerGameSample(row?.distanceProfile?.sampleSize, row?.teamGamesPlayed)
}

function qualifiesTrackedContact(row) {
  return qualifiesPerGameSample(getTrackedBipSample(row), row?.teamGamesPlayed)
}

// FRV reads 0 for a fielder with nothing modeled, which is not the same as an average fielder.
function hasModeledFieldingOpportunity(row) {
  return Number(row?.fielding?.fieldingOpportunities || 0) > 0
    || Number(row?.fielding?.armOpportunities || 0) > 0
    || Number(row?.fielding?.doublePlayOpportunities || 0) > 0
}

// The row population behind each table set (STATS_SECTIONS `rows`).
// A row appears in a table only when it has something to show in that table.
const ROW_FILTERS = {
  batting: hasBattingData,
  battedBall: (row) => row.battedBall.total > 0 || row.sprayProfile.total > 0,
  contact: (row) => getTrackedBipSample(row) > 0 || row.sprayProfile.total > 0,
  expected: (row) => row.expectedBatting.sampleSize > 0,
  starHits: (row) => row.starHit.used > 0,
  spray: (row) => row.hitLocations.total > 0,
  pitching: hasPitchingData,
  battedBallAllowed: (row) => row.pitchingBattedBall.total > 0 || row.pitchingSpray.total > 0
    || row.pitchingHitLocations.total > 0 || row.pitchingExitVelo.sampleSize > 0,
  expectedAllowed: (row) => row.expectedPitching.sampleSize > 0,
  pitchMix: (row) => row.pitchMix.totalPitches > 0 || row.pitchMix.averageVelocityMph != null,
  starPitches: (row) => row.starPitch.used > 0,
  fielding: hasFieldingData,
  range: (row) => row.fielding.rangeable >= MIN_RANGE_CHANCES || row.fielding.fieldingOpportunities > 0,
  arm: (row) => row.fielding.throws > 0 || row.fielding.buddyThrows > 0 || row.fielding.armOpportunities > 0
    || row.fielding.doublePlayOpportunities > 0 || row.fielding.doublePlays > 0,
  jump: (row) => row.fielding.jumpSamples > 0 || row.fielding.positioningSamples > 0,
  extraBases: (row) => row.baserunning.opportunities > 0 || row.baserunning.modeledOpportunities > 0 || row.batting.runs > 0,
  speed: (row) => row.movement.speedSamples > 0 || row.movement.homeToFirstSamples > 0 || row.movement.ninetyFootSplitSamples > 0,
  gimmick: (row) => row.gimmickLuck.totalEvents > 0 || row.gimmickLuck.pricedPlays > 0,
}

function getTrackedBipSample(row) {
  return Math.max(
    Number(row?.distanceProfile?.sampleSize || 0),
    Number(row?.exitVeloProfile?.sampleSize || 0),
    Number(row?.contactQuality?.sampleSize || 0),
  )
}

function qualifiesForSprayChart(pa) {
  if (!pa) return false
  const hasTappedLocation = pa.hit_stadium_key && pa.hit_x != null && pa.hit_y != null
  const hasProjectedLocation = pa.hit_distance_ft != null && pa.hit_angle_deg != null
  return Boolean(hasTappedLocation || hasProjectedLocation)
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
        doublePlays: 0,
        starHitErrors: 0,
        buddyJumps: 0,
        nicePlays: 0,
        rangeChances: [],
      }
    }
    return collection[key]
  }

  const findFielder = (pa = {}, positionNumber = null) => gameFielders.find((fielder) => (
    String(fielder.game_id) === String(pa.game_id) &&
    Number(fielder.position) === Number(positionNumber) &&
    fielderCoversPa(fielder, pa) &&
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
    doublePlays = 0,
    playerDoublePlays = 0,
    starHitErrors = 0,
    buddyJumps = 0,
    nicePlays = 0,
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
    // A player row represents the whole defensive club, so a completed DP is
    // counted once there. Character rows count participation for every fielder
    // in the turn. Sequence callers choose the first matched fielder to carry
    // the one club-level credit via playerDoublePlays.
    playerEntry.doublePlays += playerDoublePlays
    playerEntry.starHitErrors += starHitErrors
    playerEntry.buddyJumps += buddyJumps
    playerEntry.nicePlays += nicePlays

    const characterId = charactersByName[resolvedCharacterName]?.id || null
    const characterEntry = ensureEntry(characterMap, resolvedCharacterName, { id: characterId, name: resolvedCharacterName })
    characterEntry.gamesSet.add(gameId)
    characterEntry.positionsSet.add(position)
    characterEntry.positionCounts[position] = (characterEntry.positionCounts[position] || 0) + 1
    characterEntry.chances += chances
    characterEntry.putouts += putouts
    characterEntry.assists += assists
    characterEntry.errors += errors
    characterEntry.doublePlays += doublePlays
    characterEntry.starHitErrors += starHitErrors
    characterEntry.buddyJumps += buddyJumps
    characterEntry.nicePlays += nicePlays
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

  // A defensive appearance counts even when no ball was hit to that fielder.
  // Seed every recorded stint before applying the play-by-play credits.
  buildFieldingAppearanceCredits(gameFielders).forEach((appearance) => {
    applyCredit({
      ...appearance,
      playerName: appearance.playerName || playerNameById[String(appearance.playerId)] || 'Unknown',
    })
  })

  // Range Runs (see fieldingRange.js) only makes sense for the fielder who actually ranged to the
  // batted ball — the first fielder in the chain, mirroring buildFieldingChances' index===0 rule
  // in statsCalculator.js. Recorded on both the player and character entries so either table can
  // show it.
  const applyRangeChance = ({ playerId, playerName, characterName, positionNumber, isPutout, isAssist, difficulty }) => {
    if (!difficulty) return
    const resolvedPlayerId = String(playerId || playerIdByName[playerName] || playerName || 'unknown')
    const resolvedPlayerName = playerName || playerNameById[resolvedPlayerId] || 'Unknown'
    const resolvedCharacterName = characterName || 'Unknown'
    const chance = { position: Number(positionNumber), isPutout, isAssist, isBuddyJump: false, difficulty }

    const playerEntry = ensureEntry(playerMap, resolvedPlayerId, { playerId: resolvedPlayerId, name: resolvedPlayerName })
    playerEntry.rangeChances.push(chance)

    const characterId = charactersByName[resolvedCharacterName]?.id || null
    const characterEntry = ensureEntry(characterMap, resolvedCharacterName, { id: characterId, name: resolvedCharacterName })
    characterEntry.rangeChances.push(chance)
  }

  plateAppearances.forEach((pa) => {
    const gameId = String(pa.game_id)
    const { positions, errorPositions } = parseFieldingSequence(pa)
    const outsOnPlay = calculateOutsForPa(pa.result, pa.outs_on_play)
    const creditOutsOnPlay = !pa.is_error || outsOnPlay > 0

    const firstPosition = positions[0] ?? null
    if (firstPosition != null) {
      const difficulty = computeDifficultySignal(firstPosition, pa.hit_stadium_key, {
        hitDistanceFt: pa.hit_distance_ft,
        hitAngleDeg: pa.hit_angle_deg,
        fieldedX: pa.fielded_x,
        fieldedY: pa.fielded_y,
        hangTimeSec: pa.hang_time_sec,
        fieldedTimeSec: pa.fielded_video_sec != null && pa.contact_video_sec != null
          ? pa.fielded_video_sec - pa.contact_video_sec
          : null,
      })
      if (difficulty) {
        const fielder = findFielder(pa, firstPosition)
        if (fielder) {
          applyRangeChance({
            playerId: fielder.player_id || fielder.team_id,
            playerName: fielder.player_name || playerNameById[String(fielder.player_id || fielder.team_id)] || 'Unknown',
            characterName: fielder.character || 'Unknown',
            positionNumber: firstPosition,
            isPutout: creditOutsOnPlay && positions.length === 1,
            isAssist: creditOutsOnPlay && positions.length > 1,
            difficulty,
          })
        }
      }
    }

    // A nice/diving play only ever applies to the first fielder to touch the
    // ball — credited separately from chances/putouts/assists/errors so it
    // doesn't affect fielding percentage.
    if (pa.is_nice_play && positions.length) {
      applyCreditFromFielder(pa, positions[0], { nicePlays: 1 })
    }

    // Buddy Jump credit comes straight off its own columns rather than the
    // parsed notation chain, so it's tracked even before the play's shape
    // (and so its hit_notation) is resolved in the Exit Velocity tab.
    if (pa.is_buddy_jump) {
      if (pa.buddy_jump_assist_position) {
        applyCreditFromFielder(pa, pa.buddy_jump_assist_position, { buddyJumps: 1 })
      }
      if (pa.buddy_jump_putout_position) {
        applyCreditFromFielder(pa, pa.buddy_jump_putout_position, { buddyJumps: 1 })
      }
    }

    if (pa.is_error) {
      // Errors on a batter's star hit are tracked separately so fielding %
      // can be shown both as-is and adjusted for the harder-to-field star swing.
      const isStarHitError = pa.star_hit_connected === true
        || (pa.star_hit_connected == null && Boolean(pa.star_hit_used))
      const countsByPosition = new Map()

      const mergeCredit = (positionNumber, counts) => {
        if (positionNumber == null || positionNumber === '') return
        const key = String(positionNumber)
        const next = countsByPosition.get(key) || {
          positionNumber: Number(positionNumber),
          chances: 0,
          putouts: 0,
          assists: 0,
          errors: 0,
          doublePlays: 0,
          starHitErrors: 0,
        }
        if (counts.chances) next.chances = 1
        next.putouts = Math.max(next.putouts, counts.putouts || 0)
        next.assists = Math.max(next.assists, counts.assists || 0)
        next.errors = Math.max(next.errors, counts.errors || 0)
        next.doublePlays = Math.max(next.doublePlays, counts.doublePlays || 0)
        next.starHitErrors = Math.max(next.starHitErrors, counts.starHitErrors || 0)
        countsByPosition.set(key, next)
      }

      if (creditOutsOnPlay && positions.length) {
        buildFielderSequenceCredits(positions, outsOnPlay).forEach(({ positionNumber, ...counts }) => {
          mergeCredit(positionNumber, counts)
        })
      }

      // Every fielder actually charged with an error on the play (a relay
      // both players booted, say) gets their own error credited here.
      new Set(errorPositions).forEach((positionNumber) => {
        mergeCredit(positionNumber, { chances: 1, errors: 1, starHitErrors: isStarHitError ? 1 : 0 })
      })
      const matchedErrorPositions = new Set()
      let playerDoublePlayCredited = false
      countsByPosition.forEach((counts) => {
        counts.chances = counts.putouts + counts.assists + counts.errors || counts.chances
        const matched = applyCreditFromFielder(pa, counts.positionNumber, {
          ...counts,
          playerDoublePlays: counts.doublePlays && !playerDoublePlayCredited ? 1 : 0,
        })
        if (matched && counts.doublePlays) playerDoublePlayCredited = true
        if (matched && counts.errors) {
          matchedErrorPositions.add(counts.positionNumber)
        }
      })
      // error_position/error_character/error_player only ever describe the
      // first error on the play — used as a display fallback for whichever
      // position(s) above couldn't be matched to a known game fielder.
      if (errorPositions.length ? !matchedErrorPositions.has(errorPositions[0]) : true) {
        applyCredit({
          playerId: pa.defensive_team_id || playerIdByName[pa.error_player] || pa.error_player,
          playerName: pa.error_player || playerNameById[String(pa.defensive_team_id)] || 'Unknown',
          characterName: pa.error_character || 'Unknown',
          gameId,
          positionNumber: errorPositions[0] ?? null,
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

    let playerDoublePlayCredited = false
    buildFielderSequenceCredits(positions, outsOnPlay).forEach(({ positionNumber, ...counts }) => {
      const matched = applyCreditFromFielder(pa, positionNumber, {
        ...counts,
        playerDoublePlays: counts.doublePlays && !playerDoublePlayCredited ? 1 : 0,
      })
      if (matched && counts.doublePlays) playerDoublePlayCredited = true
    })
  })

  // League-wide baseline for Range Runs, built from every player's rangeable chances (equivalent
  // to characterMap's — the same underlying plays, just grouped differently) before any
  // per-entry filtering, matching computeFieldingLeagueConstants's ordering.
  const rangeLeagueConstants = computeRangeLeagueConstants(
    Object.values(playerMap).flatMap((entry) => entry.rangeChances),
  )

  const finalize = (entry) => {
    const primaryPosition = Object.entries(entry.positionCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '-'

    const games = entry.gamesSet.size
    const nonStarHitErrors = Math.max(0, entry.errors - entry.starHitErrors)
    const range = summarizeFieldingRange(entry.rangeChances, rangeLeagueConstants)
    const { rangeChances: _rangeChances, ...entryWithoutRangeChances } = entry
    return {
      ...entryWithoutRangeChances,
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
      nicePlayRate: entry.chances ? entry.nicePlays / entry.chances : null,
      // Difficulty-adjusted range (see fieldingRange.js) — distinct from the classic rangeFactor
      // counting stat above. rangeable/rangeRuns/rangeFactorPlus/rangeConfidence are null/0 until
      // MIN_RANGE_CHANCES worth of rangeable chances (hit_distance_ft/hang_time_sec/fielded_x
      // recorded on a play this entry ranged for) exist.
      rangeable: range.totalRangeable,
      rangeRuns: range.totalRangeRuns,
      rangeFactorPlus: range.rangeFactorPlus,
      rangeConfidence: range.confidence,
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
  rowLabel,
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
  // Sort state outlives a column-set change (sort Characters by HR, switch to Pitching), and
  // sortRows silently falls back to the name column when the key is gone. Mirror that fallback in
  // the header so the highlighted column always matches the order actually on screen, instead of
  // leaving every header blank over a table that just re-sorted itself.
  const { key: effectiveSortKey, direction: effectiveSortDirection } = resolveEffectiveSort(columns, sortState)
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
                scope="col"
                aria-sort={effectiveSortKey === column.key ? (effectiveSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={column.key === 'name' && column.group === 'Player' ? 'stats-player-col' : undefined}
                style={buildHeaderStyle(column)}
              >
                <SortHeaderButton
                  active={effectiveSortKey === column.key}
                  direction={effectiveSortDirection}
                  label={column.label}
                  onClick={() => onSort(column)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            // A row that navigates on click has to be operable from the keyboard too — the Players
            // tables have no link inside the identity cell, so without this the only way to open a
            // team profile from here was a mouse click. Keypresses that started inside a nested
            // link/button are left alone so the character link keeps its own behaviour.
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              {...(onRowClick ? {
                className: 'stat-row-clickable',
                role: 'link',
                tabIndex: 0,
                'aria-label': (() => {
                  // Must match what the identity cell actually shows, or voice control and a
                  // screen reader announce a different name than the one on screen.
                  const label = rowLabel ? rowLabel(row) : row.name
                  return label ? `Open ${label}` : undefined
                })(),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  if (event.target !== event.currentTarget) return
                  event.preventDefault()
                  onRowClick(row)
                },
              } : {})}
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

function BaserunningEvidencePanel({ selection, opportunities, trackingPlays, onClose }) {
  if (!selection) return null
  const idKey = selection.identity === 'player' ? 'runner_player_id' : 'runner_character_id'
  const matching = opportunities.filter((row) => {
    if (String(row[idKey]) !== selection.id) return false
    switch (selection.key) {
      case 'holds': return row.outcome === 'hold'
      case 'attempts': return Boolean(row.attempted)
      case 'advances': return row.outcome === 'advance_safe'
      case 'outs': return row.outcome === 'advance_out'
      case 'modeledOpportunities': return row.runner_run_value != null
      case 'opportunities': return true
      default: return row.opportunity_type === selection.key
    }
  })
  return <div className="panel" style={{ marginTop: 12, padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><h3 style={{ marginTop: 0 }}>{selection.name}: {matching.length} {selection.key} records</h3><button type="button" onClick={onClose}>Close</button></div>
    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
      {matching.map((row, index) => {
        const play = trackingPlays.find((item) => item.competition_type === row.competition_type && String(item.game_id) === String(row.game_id) && String(item.pa_id) === String(row.pa_id))
        const parkEvidence = play?.quality?.stadium_incidents?.[0]
        return <p key={`${row.competition_type}:${row.game_id}:${row.pa_id}:${row.runner_id}:${index}`} style={{ margin: '0 0 8px' }}>
          {row.competition_type || 'Unknown competition'} game {row.game_id}, PA {row.pa_id}, play {play?.play_ordinal ?? 'unknown'} · {parkEvidence?.park || 'Park unknown'} · {parkEvidence?.time_of_day || 'time unknown'} · runner {row.runner_character_id ?? 'unresolved'} · {row.opportunity_type?.replaceAll('_', ' ') || 'extra base'} · {row.origin_base} to {row.target_base}: {row.outcome?.replaceAll('_', ' ') || 'unknown'} · assignment recorded{row.runner_run_value == null ? ', run value not modeled' : ', run value modeled'}
        </p>
      })}
    </div>
  </div>
}

// The three states a stats page can be in before it has anything worth tabulating. Split out so
// "still loading", "nothing recorded yet" and "the query failed" never render as the same
// empty table.
function StatusPanel({ variant = 'loading', title, children, actions = null }) {
  return (
    <section className={`panel entity-status-panel ${variant === 'error' ? 'entity-status-error' : ''}`}>
      <h2 className="entity-status-title">{title}</h2>
      {variant === 'loading' && <div className="entity-status-progress" />}
      {children ? <p className="entity-status-body">{children}</p> : null}
      {actions ? <div className="entity-status-actions">{actions}</div> : null}
    </section>
  )
}

// Name filter for the tables split out of the old overview tables. Reports the match count so an over-narrow filter
// reads as "0 of 51 match" rather than an empty table that looks like missing data.
function OverviewFilterBar({ label, matches, onChange, total, value }) {
  const inputId = `overview-filter-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <div className="stats-filter-bar">
      <label className="stats-filter-label" htmlFor={inputId}>{label}</label>
      <input
        className="stats-filter-input"
        id={inputId}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Type a name…"
        type="search"
        value={value}
      />
      {value ? (
        <>
          <span className="stats-filter-count" role="status">{matches} of {total} match</span>
          <button className="stats-filter-clear" onClick={() => onChange('')} type="button">Clear</button>
        </>
      ) : (
        <span className="stats-filter-count">{total} shown</span>
      )}
    </div>
  )
}

function LeadersPanel({ cards }) {
  return (
    <div className="stats-leaders">
      {cards.map((card) => (
        <section aria-label={`${card.title} leaders`} className="stats-leaders-group" key={card.id}>
          <h3 className="stats-leaders-group-title">{card.title}</h3>
          <div className="stats-leaders-grid">
            {card.stats.map((stat) => (
              <article className="stats-leader-card" key={stat.id}>
                <header className="stats-leader-card-head">
                  <span className="stats-leader-card-label"><StatLabel label={stat.label} /></span>
                  <button aria-label={`Full table sorted by ${stat.label}`} className="stats-leader-card-link" onClick={stat.onOpen} type="button">Full table →</button>
                </header>
                {stat.leaders.length ? (
                  <ol className="stats-leader-list">
                    {stat.leaders.map((leader, index) => (
                      <li className={`stats-leader-row ${index === 0 ? 'stats-leader-row-first' : ''}`} key={leader.key}>
                        <span className="stats-leader-rank">{index + 1}</span>
                        <span className="stats-leader-identity">{leader.identity}</span>
                        <span className="stats-leader-value">{leader.value}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="stats-leader-empty">No qualified leaders yet.</p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function Stats() {
  const navigate = useNavigate()
  const location = useLocation()
  const isSeasonRoute = location.pathname.startsWith('/season')
  const { viewedTournament, currentTournament } = useTournament()
  const { viewedSeason, currentSeason, seasonTeams } = useSeason()
  const isCompact = useIsCompactViewport(900)
  // The Characters identity column matches the Players one (which has always been 160px wide and
  // shown a name); a touch narrower on compact viewports so the numbers still get some room.
  const charIdentityColBase = {
    key: 'name',
    group: 'Identity',
    label: 'Character',
    type: 'string',
    sticky: true,
    stickyLeft: 0,
    stickyWidth: isCompact ? 132 : 160,
    sortValue: (row) => row.name,
  }
  // Identity, section and set live in the query string too (?view=&section=&set=), so a refresh
  // or a Back from a player page reopens the same table.
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState(() => (searchParams.get('view') === 'characters' ? 'characters' : 'players'))
  // The open rail section, the tab last chosen inside each section, and one sort per identity and
  // tab (`${tab}:${section}.${set}`), so sorting one table never reorders another.
  const [section, setSection] = useState(() => searchParams.get('section') || 'leaders')
  const [setBySection, setSetBySection] = useState(() => {
    const urlSection = searchParams.get('section')
    const urlSet = searchParams.get('set')
    return urlSection && urlSet ? { [urlSection]: urlSet } : {}
  })
  const [sorts, setSorts] = useState({})
  const [baseEvidence, setBaseEvidence] = useState(null)
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])
  const [selectedStadiumKey, setSelectedStadiumKey] = useState(null)
  const [ballparkSubView, setBallparkSubView] = useState('batting')
  const [ballparkTimeFilter, setBallparkTimeFilter] = useState('all')
  const [selectedSprayChartTeamId, setSelectedSprayChartTeamId] = useState(ALL_TEAMS_SPRAY_FILTER)
  const [locationDisplayMode, setLocationDisplayMode] = useState('pct')
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
  const [runsScored, setRunsScored] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [pitches, setPitches] = useState([])
  const [gameFielders, setGameFielders] = useState([])
  const [seasonGames, setSeasonGames] = useState([])
  const [seasonRoster, setSeasonRoster] = useState([])
  const [seasonPlateAppearances, setSeasonPlateAppearances] = useState([])
  const [seasonRunsScored, setSeasonRunsScored] = useState([])
  const [seasonPitchingStints, setSeasonPitchingStints] = useState([])
  const [seasonPitches, setSeasonPitches] = useState([])
  const [seasonFielders, setSeasonFielders] = useState([])
  const [trackingPlays, setTrackingPlays] = useState([])
  const [trackingThrows, setTrackingThrows] = useState([])
  const [runnerOpportunities, setRunnerOpportunities] = useState([])
  const [doublePlayOpportunities, setDoublePlayOpportunities] = useState([])
  const [fieldingOpportunities, setFieldingOpportunities] = useState([])
  const [movementMetrics, setMovementMetrics] = useState([])
  const [selectedTournamentId, setSelectedTournamentId] = useState(() => String(viewedTournament?.id || currentTournament?.id || ''))
  const [tournaments, setTournaments] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => String(viewedSeason?.id || currentSeason?.id || ''))
  const [seasons, setSeasons] = useState([])
  const [sourceMode, setSourceMode] = useState(() => (isSeasonRoute ? 'seasons' : 'tournaments'))
  // 'loading' until the first load settles, then 'ready' or 'error'. Without this the page renders
  // a full set of "No stats found" tables while 26 queries are still in flight, so a slow load and
  // an genuinely empty league look identical — and a failed fetch looked like both.
  const [overviewFilter, setOverviewFilter] = useState('')
  const [loadStatus, setLoadStatus] = useState('loading')
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const loadGenerationRef = useRef(0)

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
    let disposed = false
    const snapshotCache = new Map()
    const snapshotVersions = new Map()
    const allSnapshotKeys = [
      'players', 'characters', 'games', 'draft_picks', 'plate_appearances', 'runs_scored',
      'pitching_stints', 'pitches', 'game_fielders', 'tournaments', 'seasons', 'season_schedule',
      'season_teams', 'season_roster', 'season_plate_appearances', 'season_runs_scored',
      'season_pitching_stints', 'season_pitches', 'season_game_fielders', 'stadiums',
      'stadium_game_log', 'tracking_plays', 'tracking_throws', 'runner_opportunities',
      'double_play_opportunities', 'fielding_opportunities', 'movement_metrics', 'tracking_sessions',
      'active_tracking_versions',
    ]
    const readSnapshot = async (key, loader) => {
      if (snapshotCache.has(key)) return snapshotCache.get(key)
      const version = snapshotVersions.get(key) || 0
      const result = await loader()
      if (!result?.error && version === (snapshotVersions.get(key) || 0)) snapshotCache.set(key, result)
      return result
    }
    const invalidateSnapshots = (...keys) => {
      keys.flat().forEach((key) => {
        snapshotCache.delete(key)
        snapshotVersions.set(key, (snapshotVersions.get(key) || 0) + 1)
      })
    }

    const loadStats = async (generation) => {
      const results = await Promise.all([
        readSnapshot('players', () => fetchAllRows(() => supabase.from('players').select('*'))),
        readSnapshot('characters', () => fetchAllRows(() => supabase
          .from('characters')
          .select('id, name, pitching, batting, fielding, speed, slap_contact, charge_contact, slap_power, charge_power, bunting, run_speed, throwing_speed, fielding_stat, curveball_speed, fastball_speed, curve, stamina, star_boost_pct, hitting_trajectory, character_class, is_captain'))),
        readSnapshot('games', () => fetchAllRows(() => supabase.from('games').select('*'))),
        readSnapshot('draft_picks', () => fetchAllRows(() => supabase.from('draft_picks').select('*'))),
        readSnapshot('plate_appearances', () => fetchAllRows(() => supabase.from('plate_appearances').select('*'))),
        readSnapshot('runs_scored', () => fetchAllRows(() => supabase.from('runs_scored').select('*'))),
        readSnapshot('pitching_stints', () => fetchAllRows(() => supabase.from('pitching_stints').select('*'))),
        readSnapshot('pitches', () => fetchAllRows(() => supabase.from('pitches').select('*'))),
        readSnapshot('game_fielders', () => fetchAllRows(() => supabase.from('game_fielders').select('*'))),
        readSnapshot('tournaments', () => fetchAllRows(() => supabase.from('tournaments').select('*').order('tournament_number', { ascending: false }))),
        readSnapshot('seasons', () => fetchAllRows(() => supabase.from('seasons').select('*').order('created_at', { ascending: false }))),
        readSnapshot('season_schedule', () => fetchAllRows(() => supabase.from('season_schedule').select('*'))),
        readSnapshot('season_teams', () => fetchAllRows(() => supabase.from('season_teams').select('*'))),
        readSnapshot('season_roster', () => fetchAllRows(() => supabase.from('season_roster').select('*'))),
        readSnapshot('season_plate_appearances', () => fetchAllRows(() => supabase.from('season_plate_appearances').select('*'))),
        readSnapshot('season_runs_scored', () => fetchAllRows(() => supabase.from('season_runs_scored').select('*'))),
        readSnapshot('season_pitching_stints', () => fetchAllRows(() => supabase.from('season_pitching_stints').select('*'))),
        readSnapshot('season_pitches', () => fetchAllRows(() => supabase.from('season_pitches').select('*'))),
        readSnapshot('season_game_fielders', () => fetchAllRows(() => supabase.from('season_game_fielders').select('*'))),
        readSnapshot('stadiums', () => fetchAllRows(() => supabase.from('stadiums').select('*'))),
        readSnapshot('stadium_game_log', () => fetchAllRows(() => supabase.from('stadium_game_log').select('game_id, stadium_id, is_night'), { orderColumn: 'game_id' })),
        readSnapshot('tracking_plays', () => fetchAllRows(() => supabase.from('tracking_plays').select('id,tracking_session_id,competition_type,game_id,pa_id,play_ordinal,quality'))),
        // Named columns rather than '*': these two are the widest tables in the
        // database and this page reads them league-wide, so '*' was costing
        // ~1.9 MB compressed a load on its own. src/utils/trackingColumns.js
        // owns the lists and says what to do when a metric needs a new one.
        readSnapshot('tracking_throws', () => fetchAllRows(() => supabase.from('tracking_throws').select(TRACKING_THROW_COLUMNS))),
        readSnapshot('runner_opportunities', () => fetchAllRows(() => supabase.from('runner_opportunities').select(RUNNER_OPPORTUNITY_COLUMNS))),
        readSnapshot('double_play_opportunities', () => fetchAllRows(() => supabase.from('double_play_opportunities').select(DOUBLE_PLAY_OPPORTUNITY_COLUMNS))),
        readSnapshot('fielding_opportunities', () => fetchAllRows(() => supabase.from('fielding_opportunities').select(FIELDING_OPPORTUNITY_COLUMNS))),
        readSnapshot('movement_metrics', () => fetchAllRows(() => supabase.from('movement_metrics').select(MOVEMENT_METRIC_COLUMNS))),
        readSnapshot('tracking_sessions', () => fetchAllRows(() => supabase.from('tracking_sessions').select('id,stadium_key'))),
        // Which tracking plays are no longer the authoritative version of
        // themselves. Resolves to { data: Set, error } like every read above,
        // so the failed-result check below covers it: a page that cannot tell
        // an active version from a superseded one shows the error banner over
        // whatever it already had rather than a line with the same play in it
        // twice. See src/utils/activeTrackingVersions.js.
        readSnapshot('active_tracking_versions', () => fetchSupersededTrackingPlayIds(supabase)),
      ])

      // fetchAllRows resolves with { data: null, error } rather than throwing, so without this
      // check a failed query just contributed an empty table and the page rendered as if the
      // league had no data.
      const failedResult = results.find((result) => result?.error)
      if (failedResult) throw failedResult.error

      const [
        { data: playersData },
        { data: charactersRaw },
        { data: gamesData },
        { data: picksData },
        { data: paData },
        { data: runsScoredData },
        { data: pitchingData },
        { data: pitchData },
        { data: fieldersData },
        { data: tournamentsData },
        { data: seasonsData },
        { data: seasonGamesData },
        { data: seasonTeamsData },
        { data: seasonRosterData },
        { data: seasonPaData },
        { data: seasonRunsScoredData },
        { data: seasonPitchingData },
        { data: seasonPitchData },
        { data: seasonFieldersData },
        { data: stadiumsData },
        { data: stadiumLogData },
        { data: trackingPlaysData },
        { data: trackingThrowsData },
        { data: runnerOpportunitiesData },
        { data: doublePlayOpportunitiesData },
        { data: fieldingOpportunitiesData },
        { data: movementMetricsData },
        { data: trackingSessionsData },
        { data: supersededTrackingPlays },
      ] = results

      const allPAs = paData || []
      const seasonTeamPlayerById = Object.fromEntries(
        (seasonTeamsData || []).map((team) => [String(team.id), team.player_id]),
      )
      const charactersByName = Object.fromEntries((charactersRaw || []).map((character) => [character.name, character]))
      // A pitching_stints row is created the moment a pitcher takes the mound (Scorebook's
      // mound-assignment bookkeeping), before they've necessarily thrown a pitch — if pulled again
      // without facing a batter, that stint sits at 0 IP forever but would still count as a "game"
      // pitched. Drop stints with no matching row in `pitches`/`season_pitches` (by game_id +
      // pitcher name, since pitches.pitcher_id is a name string, not character_id) before they feed
      // any pitching stat line. Historical/imported stints have no pitch-log rows at all, so also
      // keep any stint with a recorded innings_pitched > 0 — that's real evidence of an outing.
      const nameByCharId = Object.fromEntries((charactersRaw || []).map((character) => [String(character.id), character.name]))
      const gameIdsWithPitchesByName = new Set((pitchData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))
      const seasonGameIdsWithPitchesByName = new Set((seasonPitchData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))
      const allPitchingStints = (pitchingData || [])
        .filter((stint) => gameIdsWithPitchesByName.has(`${stint.game_id}:${nameByCharId[String(stint.character_id)]}`) || Number(stint.innings_pitched) > 0)
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
      const normalizedSeasonRunsScored = (seasonRunsScoredData || []).map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonPitching = (seasonPitchingData || [])
        .filter((stint) => seasonGameIdsWithPitchesByName.has(`${stint.game_id}:${nameByCharId[String(stint.character_id)]}`) || Number(stint.innings_pitched) > 0)
        .map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonPitches = (seasonPitchData || []).map((entry) => ({ ...entry, game_id: `season-${entry.game_id}` }))
      const normalizedSeasonFielders = (seasonFieldersData || []).map((entry) => ({
        ...entry,
        game_id: `season-${entry.game_id}`,
        player_id: seasonTeamPlayerById[String(entry.team_id)] || entry.player_id || null,
      }))
      const stadiumKeyByGameId = buildStadiumKeyByGameId(
        [...(gamesData || []), ...normalizedSeasonGames],
        stadiumsData || [],
        stadiumLogData || [],
      )
      const normalizedTournamentPas = enrichPasWithPitchingContext(allPAs, {
        pitchingStints: allPitchingStints,
        pitches: pitchData || [],
        charactersByName,
        stadiumKeyByGameId,
      })
      const enrichedSeasonPas = enrichPasWithPitchingContext(normalizedSeasonPas, {
        pitchingStints: normalizedSeasonPitching,
        pitches: normalizedSeasonPitches,
        charactersByName,
        seasonTeamPlayerById,
        stadiumKeyByGameId,
      })

      // Resolve win/loss/save (see pitchingDecisions.js) — most games here were bulk-imported or
      // backfilled rather than finished live through Scorebook's "mark complete" button, so their
      // pitching_stints rows were never flagged at all. Tournament and season are resolved
      // separately (rather than merged) because season_runs_scored/season_plate_appearances ids
      // aren't namespaced apart from the tournament tables' ids and could collide.
      const tournamentRunsByPaId = groupRunsByPaId(runsScoredData || [])
      const seasonRunsByPaId = groupRunsByPaId(normalizedSeasonRunsScored)
      const resolvedPitchingStints = resolveTournamentPitchingDecisions(allPitchingStints, gamesData || [], normalizedTournamentPas, tournamentRunsByPaId)
      const resolvedSeasonPitchingStints = resolveSeasonPitchingDecisions(normalizedSeasonPitching, normalizedSeasonGames, enrichedSeasonPas, seasonRunsByPaId, seasonTeamPlayerById)

      const officialTournament = reconcileStatSource({
        games: gamesData || [],
        plateAppearances: normalizedTournamentPas,
        pitchingStints: resolvedPitchingStints,
        pitches: pitchData || [],
        runs: runsScoredData || [],
        gameFielders: fieldersData || [],
        includeActiveGames: true,
      })
      const officialSeason = reconcileStatSource({
        games: normalizedSeasonGames,
        plateAppearances: enrichedSeasonPas,
        pitchingStints: resolvedSeasonPitchingStints,
        pitches: normalizedSeasonPitches,
        runs: normalizedSeasonRunsScored,
        gameFielders: normalizedSeasonFielders,
        includeActiveGames: true,
      })
      const visibleGameKeys = new Set([
        ...officialTournament.games.map(getStatGameKey),
        // Season games are namespaced for combined table aggregation, while persisted
        // advanced rows still carry the source schedule id. Match them on that source id.
        ...officialSeason.games.map((game) => getStatGameKey({
          ...game,
          id: game.source_game_id ?? game.id,
        })),
      ])
      const selectVisibleAdvancedRows = (rows) => dedupeStatRows(rows || [])
        .filter((row) => visibleGameKeys.has(getStatGameKey(row)))

      // Realtime refreshes can overlap. Only the newest complete snapshot may replace the
      // displayed tables; otherwise a slower response can roll the page back after a later edit.
      if (disposed || generation !== loadGenerationRef.current) return false

      setPlayers(playersData || [])
      setCharacters(charactersRaw || [])
      setGames(gamesData || [])
      setDraftPicks(picksData || [])
      setPlateAppearances(officialTournament.plateAppearances)
      setRunsScored(officialTournament.runs)
      setPitchingStints(officialTournament.pitchingStints)
      setPitches(officialTournament.pitches)
      setGameFielders(officialTournament.gameFielders)
      setTournaments(tournamentsData || [])
      setSeasons(seasonsData || [])
      setSeasonGames(normalizedSeasonGames)
      setSeasonRoster(seasonRosterData || [])
      setSeasonPlateAppearances(officialSeason.plateAppearances)
      setSeasonRunsScored(officialSeason.runs)
      setSeasonPitchingStints(officialSeason.pitchingStints)
      setSeasonPitches(officialSeason.pitches)
      setSeasonFielders(officialSeason.gameFielders)
      setStadiums(stadiumsData || [])
      setStadiumGameLog(stadiumLogData || [])
      const parkBySession = new Map((trackingSessionsData || []).map((session) => [String(session.id), session.stadium_key]))
      setTrackingPlays(selectVisibleAdvancedRows(
        onlyActiveTrackingPlays(trackingPlaysData, supersededTrackingPlays))
        .map((play) => ({ ...play, park: parkBySession.get(String(play.tracking_session_id)) || null })))
      // A superseded tracking version and an unfinished replacement both keep
      // their facts on disk, so the same play was entering a character's line
      // once per version. Only the active version's rows are counted.
      // restoreQuality puts the selected `quality->…` flags back inside
      // `quality`, which is the shape every reader downstream expects.
      setTrackingThrows(selectVisibleAdvancedRows(
        onlyActiveTrackingFacts(restoreQuality(trackingThrowsData), supersededTrackingPlays)))
      setRunnerOpportunities(selectVisibleAdvancedRows(restoreQuality(runnerOpportunitiesData)))
      setDoublePlayOpportunities(selectVisibleAdvancedRows(restoreQuality(doublePlayOpportunitiesData)))
      setFieldingOpportunities(selectVisibleAdvancedRows(
        onlyActiveTrackingFacts(restoreQuality(fieldingOpportunitiesData), supersededTrackingPlays)))
      setMovementMetrics(selectVisibleAdvancedRows(
        onlyActiveTrackingFacts(restoreQuality(movementMetricsData), supersededTrackingPlays)))
      return true
    }

    const runLoad = async (isBackground) => {
      if (disposed) return
      const generation = loadGenerationRef.current + 1
      loadGenerationRef.current = generation
      if (!isBackground) {
        setLoadStatus('loading')
        setLoadError('')
      }
      try {
        const applied = await loadStats(generation)
        if (!applied || disposed || generation !== loadGenerationRef.current) return
        setLoadStatus('ready')
        setLoadError('')
      } catch (error) {
        if (disposed || generation !== loadGenerationRef.current) return
        // Either way the status goes to 'error'; the render decides how loudly to say so. With
        // rows already on screen it's a banner over stale data, with nothing loaded it's the
        // whole page. A background failure must not blank a working table.
        setLoadStatus('error')
        setLoadError(error?.message || 'Failed to load stats.')
      }
    }

    let initialLoad = true
    const refreshCoordinator = createRefreshCoordinator({
      run: async () => {
        const background = !initialLoad
        initialLoad = false
        await runLoad(background)
      },
      delayMs: 750,
      maxWaitMs: 2000,
      isPaused: () => document.visibilityState === 'hidden',
      onError: () => {}, // runLoad owns the visible error state.
    })
    const refresh = (...keys) => {
      invalidateSnapshots(keys)
      refreshCoordinator.request()
    }
    const refreshAll = () => {
      invalidateSnapshots(allSnapshotKeys)
      refreshCoordinator.request({ immediate: true })
    }
    refreshCoordinator.request({ immediate: true })
    let hasSubscribed = false
    const channel = supabase
      .channel(`stats-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => refresh('players'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, () => refresh('characters'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, () => refresh('games'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, () => refresh('draft_picks'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, () => refresh('plate_appearances'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runs_scored' }, () => refresh('runs_scored'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, () => refresh('pitching_stints'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, () => refresh('pitches'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_fielders' }, () => refresh('game_fielders'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => refresh('tournaments'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, () => refresh('seasons'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule' }, () => refresh('season_schedule'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams' }, () => refresh('season_teams'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster' }, () => refresh('season_roster'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances' }, () => refresh('season_plate_appearances'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_runs_scored' }, () => refresh('season_runs_scored'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints' }, () => refresh('season_pitching_stints'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitches' }, () => refresh('season_pitches'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_game_fielders' }, () => refresh('season_game_fielders'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, () => refresh('stadiums'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadium_game_log' }, () => refresh('stadium_game_log'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tracking_plays' }, () => refresh('tracking_plays', 'active_tracking_versions'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tracking_throws' }, () => refresh('tracking_throws'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runner_opportunities' }, () => refresh('runner_opportunities'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'double_play_opportunities' }, () => refresh('double_play_opportunities'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fielding_opportunities' }, () => refresh('fielding_opportunities'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movement_metrics' }, () => refresh('movement_metrics'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tracking_sessions' }, () => refresh('tracking_sessions', 'active_tracking_versions'))
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) refreshAll()
        hasSubscribed = true
      })

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshAll()
    }
    const refreshWhenOnline = refreshAll
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('online', refreshWhenOnline)

    return () => {
      disposed = true
      loadGenerationRef.current += 1
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('online', refreshWhenOnline)
      refreshCoordinator.dispose()
      supabase.removeChannel(channel)
    }
  }, [reloadToken])

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

  // Keep the in-page scope selector following the navbar's season/tournament dropdown, so
  // picking a different season/tournament up top updates the stats being viewed here too.
  useEffect(() => {
    if (isSeasonRoute && viewedSeason?.id) {
      setSelectedSeasonId(String(viewedSeason.id))
      setSourceMode('seasons')
    }
  }, [viewedSeason?.id, isSeasonRoute])

  useEffect(() => {
    if (!isSeasonRoute && viewedTournament?.id) {
      setSelectedTournamentId(String(viewedTournament.id))
      setSourceMode('tournaments')
    }
  }, [viewedTournament?.id, isSeasonRoute])

  const playersById = useMemo(() => Object.fromEntries(players.map((player) => [player.id, player])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((character) => [character.id, character])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])
  const gameById = useMemo(() => Object.fromEntries([...games, ...seasonGames].map((game) => [game.id, game])), [games, seasonGames])

  const filteredGames = useMemo(() => {
    return selectStatRowsForScope({
      tournamentRows: games, seasonRows: seasonGames,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })
  }, [isCombinedView, sourceMode, games, seasonGames, selectedTournamentValue, selectedSeasonValue])
  const filteredPas = useMemo(() => {
    return selectStatRowsForScope({
      tournamentRows: plateAppearances, seasonRows: seasonPlateAppearances,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })
  }, [isCombinedView, sourceMode, plateAppearances, seasonPlateAppearances, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredPasWithCharacterNames = useMemo(
    () => filteredPas.map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name || null })),
    [filteredPas, charactersById],
  )
  const allPasWithCharacterNames = useMemo(
    () => [...plateAppearances, ...seasonPlateAppearances].map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name || null })),
    [plateAppearances, seasonPlateAppearances, charactersById],
  )
  // Built once from the current view's full batted-ball population so every row's
  // xBA/xSLG/xwOBA compares each batted ball against the same league sample.
  const expectedOutcomeModel = useMemo(() => buildExpectedOutcomeModel(filteredPas), [filteredPas])
  const filteredPitching = useMemo(() => {
    const raw = selectStatRowsForScope({
      tournamentRows: pitchingStints, seasonRows: seasonPitchingStints,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })

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
  // Scoped to the currently selected season/tournament/combined view (same pool as filteredPas/
  // filteredPitching) so "100" always represents the average of the cohort being displayed,
  // rather than an all-time average pulled in from every season and tournament ever played.
  const leagueConstants = useMemo(
    () => computeLeagueConstants(filteredPas, filteredPitching),
    [filteredPas, filteredPitching],
  )
  // Runs a batter scores by reaching base on an earlier PA and later scoring on a
  // teammate's play are recorded only here (scoring_player_id/scoring_character_id),
  // never on the batter's own pa.run_scored — see summarizeBatting's runEvents param.
  const filteredRunEvents = useMemo(() => {
    return selectStatRowsForScope({
      tournamentRows: runsScored, seasonRows: seasonRunsScored,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })
  }, [isCombinedView, sourceMode, runsScored, seasonRunsScored, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredPitches = useMemo(() => {
    return selectStatRowsForScope({
      tournamentRows: pitches, seasonRows: seasonPitches,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })
  }, [isCombinedView, sourceMode, pitches, seasonPitches, selectedTournamentValue, selectedSeasonValue, gameById])
  const filteredFielders = useMemo(() => {
    return selectStatRowsForScope({
      tournamentRows: gameFielders, seasonRows: seasonFielders,
      tournamentGames: games, seasonGames,
      sourceMode, tournamentId: selectedTournamentValue, seasonId: selectedSeasonValue,
    })
  }, [isCombinedView, sourceMode, gameFielders, seasonFielders, selectedTournamentValue, selectedSeasonValue, gameById])

  const filteredAdvanced = useMemo(() => {
    if (isCombinedView) {
      return {
        plays: trackingPlays,
        throws: trackingThrows,
        runners: runnerOpportunities,
        doublePlays: doublePlayOpportunities,
        fielding: fieldingOpportunities,
        movement: movementMetrics,
      }
    }
    const tournamentGameIds = new Set(filteredGames
      .filter((game) => game.source_game_id == null)
      .map((game) => String(game.id)))
    const seasonGameIds = new Set(filteredGames
      .filter((game) => game.source_game_id != null)
      .map((game) => String(game.source_game_id)))
    const include = (row) => (
      row.competition_type === 'season'
        ? sourceMode === 'seasons' && seasonGameIds.has(String(row.game_id))
        : sourceMode === 'tournaments' && tournamentGameIds.has(String(row.game_id))
    )
    return {
      plays: trackingPlays.filter(include),
      throws: trackingThrows.filter(include),
      runners: runnerOpportunities.filter(include),
      doublePlays: doublePlayOpportunities.filter(include),
      fielding: fieldingOpportunities.filter(include),
      movement: movementMetrics.filter(include),
    }
  }, [doublePlayOpportunities, fieldingOpportunities, filteredGames, isCombinedView, movementMetrics, runnerOpportunities, sourceMode, trackingPlays, trackingThrows])

  const gimmickLuckByPlayer = useMemo(
    () => summarizeGimmickLuck(filteredAdvanced.plays, 'player'),
    [filteredAdvanced],
  )
  const gimmickLuckByCharacter = useMemo(
    () => summarizeGimmickLuck(filteredAdvanced.plays, 'character'),
    [filteredAdvanced],
  )

  const experimentalWar = useMemo(() => buildExperimentalWar({
    games: filteredGames,
    plateAppearances: filteredPas,
    pitchingStints: filteredPitching,
    gameFielders: filteredFielders,
    runnerOpportunities: filteredAdvanced.runners,
    doublePlayOpportunities: filteredAdvanced.doublePlays,
    fieldingOpportunities: filteredAdvanced.fielding,
    characters,
  }), [filteredGames, filteredPas, filteredPitching, filteredFielders, filteredAdvanced, characters])
  const userValue = useMemo(() => ({
    version: USER_VALUE_VERSION,
    players: buildUserValueStats({
      plateAppearances: filteredPas,
      pitches: filteredPitches,
      movementMetrics: filteredAdvanced.movement,
      runnerOpportunities: filteredAdvanced.runners,
      fieldingOpportunities: filteredAdvanced.fielding,
      trackingPlays: filteredAdvanced.plays,
      identity: 'player',
    }),
    characters: buildUserValueStats({
      plateAppearances: filteredPas,
      pitches: filteredPitches,
      movementMetrics: filteredAdvanced.movement,
      runnerOpportunities: filteredAdvanced.runners,
      fieldingOpportunities: filteredAdvanced.fielding,
      trackingPlays: filteredAdvanced.plays,
      identity: 'character',
    }),
  }), [filteredAdvanced, filteredPas, filteredPitches])
  const advancedFieldingByPlayer = useMemo(() => summarizeAdvancedFielding({
    throws: filteredAdvanced.throws,
    runnerOpportunities: filteredAdvanced.runners,
    doublePlayOpportunities: filteredAdvanced.doublePlays,
    fieldingOpportunities: filteredAdvanced.fielding,
  }, 'player'), [filteredAdvanced])
  const advancedFieldingByCharacter = useMemo(() => summarizeAdvancedFielding({
    throws: filteredAdvanced.throws,
    runnerOpportunities: filteredAdvanced.runners,
    doublePlayOpportunities: filteredAdvanced.doublePlays,
    fieldingOpportunities: filteredAdvanced.fielding,
  }, 'character'), [filteredAdvanced])
  const movementByPlayer = useMemo(
    () => summarizeMovementMetrics(filteredAdvanced.movement, 'player'),
    [filteredAdvanced],
  )
  const movementByCharacter = useMemo(
    () => summarizeMovementMetrics(filteredAdvanced.movement, 'character'),
    [filteredAdvanced],
  )
  const baserunningByPlayer = useMemo(
    () => summarizeAdvancedBaserunning(filteredAdvanced.runners, 'player'),
    [filteredAdvanced],
  )
  // Close plays live on the tracking plays, not the plate appearances the rest
  // of the fielding line is built from, so they are merged in here. Summarized
  // once per identity and split two ways: the contest credits a fielder and a
  // runner, and each of them reads it from their own side.
  const mechanicsByPlayer = useMemo(
    () => summarizeMechanics(filteredAdvanced.plays, 'player'),
    [filteredAdvanced],
  )
  const mechanicsByCharacter = useMemo(
    () => summarizeMechanics(filteredAdvanced.plays, 'character'),
    [filteredAdvanced],
  )
  const closePlaysByPlayer = useMemo(() => closePlayTotals(mechanicsByPlayer), [mechanicsByPlayer])
  const closePlaysByCharacter = useMemo(() => closePlayTotals(mechanicsByCharacter), [mechanicsByCharacter])
  const runnerClosePlaysByPlayer = useMemo(() => runnerClosePlayTotals(mechanicsByPlayer), [mechanicsByPlayer])
  const runnerClosePlaysByCharacter = useMemo(() => runnerClosePlayTotals(mechanicsByCharacter), [mechanicsByCharacter])
  const baserunningByCharacter = useMemo(
    () => summarizeAdvancedBaserunning(filteredAdvanced.runners, 'character'),
    [filteredAdvanced],
  )

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
  const gamesPlayedByPlayerId = useMemo(
    () => Object.fromEntries(standings.map((standing) => [String(standing.playerId), standing.wins + standing.losses])),
    [standings],
  )
  const paByPlayer = useMemo(() => groupBy(filteredPasWithCharacterNames, 'player_id'), [filteredPasWithCharacterNames])
  const pitchingByPlayer = useMemo(() => groupBy(filteredPitching, 'player_id'), [filteredPitching])
  const allCharacterHistory = useMemo(
    () => buildCharacterHistory(
      [...plateAppearances, ...seasonPlateAppearances],
      [...pitchingStints, ...seasonPitchingStints],
      [...runsScored, ...seasonRunsScored],
      { allGameStints: [...pitchingStints, ...seasonPitchingStints] },
    ),
    [plateAppearances, seasonPlateAppearances, pitchingStints, seasonPitchingStints, runsScored, seasonRunsScored],
  )
  const filteredCharacterHistory = useMemo(
    () => buildCharacterHistory(filteredPas, filteredPitching, filteredRunEvents, { allGameStints: filteredPitching }),
    [filteredPas, filteredPitching, filteredRunEvents],
  )
  const fieldingRows = useMemo(
    () => {
      const base = buildFieldingRows({ plateAppearances: filteredPas, gameFielders: filteredFielders, players, charactersByName })
      return {
        playerRows: base.playerRows.map((row) => {
          const advanced = advancedFieldingByPlayer[String(row.playerId)] || {}
          return {
            ...row,
            ...advanced,
            ...(movementByPlayer[String(row.playerId)] || {}),
            // Traditional DP participation includes every completed multi-out
            // play. The advanced model intentionally covers only modeled DP
            // opportunities, so it must not erase the broader official total.
            doublePlays: Math.max(Number(row.doublePlays) || 0, Number(advanced.doublePlays) || 0),
          }
        }),
        characterRows: base.characterRows.map((row) => {
          const advanced = advancedFieldingByCharacter[String(row.id)] || {}
          return {
            ...row,
            ...advanced,
            ...(movementByCharacter[String(row.id)] || {}),
            doublePlays: Math.max(Number(row.doublePlays) || 0, Number(advanced.doublePlays) || 0),
          }
        }),
      }
    },
    [advancedFieldingByCharacter, advancedFieldingByPlayer, charactersByName, filteredPas, filteredFielders, movementByCharacter, movementByPlayer, players],
  )

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
    const pitchingPas = filteredPasWithCharacterNames.filter((pa) => String(pa.pitcher_player_id) === String(standing.playerId))
    const batting = summarizeBatting(battingPas, filterRunEventsForPlayer(filteredRunEvents, standing.playerId, battingPas))
    batting.ops = batting.obp + batting.slg
    const pitchingRisp = summarizeBatting(pitchingPas.filter((pa) => hasRispOpportunity(pa)))
    pitchingRisp.ops = pitchingRisp.obp + pitchingRisp.slg
    const pitching = summarizePitching(playerStints, {
      aggregation: 'team',
      allGameStints: playerStints,
    })
    const advancedBatting = sanitizeMetrics(summarizeAdvancedBatting(battingPas, leagueConstants))
    const advancedPitching = sanitizeMetrics(summarizeAdvancedPitching(playerStints, leagueConstants, { plateAppearances: pitchingPas }))
    const starHit = summarizeStarHits(battingPas)
    const pitcherPitches = selectPitchesForPlateAppearances(filteredPitches, pitchingPas)
    const starPitch = summarizeStarPitching(pitchingPas, pitcherPitches)
    const defensiveEfficiency = summarizeDefensiveEfficiency(pitchingPas)

    const batterPitches = selectPitchesForPlateAppearances(filteredPitches, battingPas)
    const distanceProfile = summarizeHitDistance(battingPas)
    const exitVeloProfile = summarizeExitVelocity(battingPas)
    const contactQuality = summarizeContactQuality(battingPas)
    const expectedBatting = summarizeExpectedBatting(battingPas, expectedOutcomeModel)
    const expectedPitching = summarizeExpectedPitching(pitchingPas, expectedOutcomeModel)

    return {
      ...standing,
      gamesPlayed: standing.wins + standing.losses,
      teamGamesPlayed: standing.wins + standing.losses,
      batting,
      advancedBatting,
      pitching,
      pitchingRisp,
      advancedPitching,
      starHit,
      starPitch,
      fielding: {
        ...(playerFieldingById[String(standing.playerId)] || createEmptyFieldingRow({ playerId: standing.playerId, name: standing.name })),
        ...(advancedFieldingByPlayer[String(standing.playerId)] || {}),
        ...(movementByPlayer[String(standing.playerId)] || {}),
        ...(closePlaysByPlayer[String(standing.playerId)] || EMPTY_CLOSE_PLAYS),
        doublePlays: Math.max(
          Number(playerFieldingById[String(standing.playerId)]?.doublePlays) || 0,
          Number(advancedFieldingByPlayer[String(standing.playerId)]?.doublePlays) || 0,
        ),
        defensiveEfficiencyOpportunities: defensiveEfficiency.opportunities,
        defensiveEfficiency: defensiveEfficiency.defensiveEfficiency,
      },
      baserunning: {
        ...(baserunningByPlayer[String(standing.playerId)] || { opportunities: 0, attempts: 0, holds: 0, advances: 0, outs: 0, attemptRate: null, successRate: null, baserunningRunValue: null }),
        ...(runnerClosePlaysByPlayer[String(standing.playerId)] || EMPTY_RUNNER_CLOSE_PLAYS),
      },
      movement: movementByPlayer[String(standing.playerId)] || { speedSamples: 0, sprintSpeedFps: null, maxSprintSpeedFps: null, bolts: 0, homeToFirstSamples: 0, homeToFirstSeconds: null, ninetyFootSplitSeconds: null },
      battedBall: summarizeBattedBallProfile(battingPas),
      sprayProfile: summarizeSprayProfile(battingPas),
      sprayContact: summarizeSprayContactProfile(battingPas),
      battedByType: summarizeBattedBallTypeProfile(battingPas),
      hitLocations: summarizeHitLocations(battingPas),
      distanceProfile,
      exitVeloProfile,
      contactQuality,
      expectedBatting,
      expectedPitching,
      gimmickLuck: gimmickLuckByPlayer[String(standing.playerId)] || {
        luckScore: 0, luckyEvents: 0, unluckyEvents: 0,
        totalEvents: 0, affectedPlays: 0, gimmickTypes: [],
        luckRuns: 0, pricedPlays: 0,
      },
      hitPowerIndex: calculateHitPowerIndex(distanceProfile),
      parkAdjustedDistance: calculateParkAdjustedDistance(battingPas, filteredPas),
      plateDiscipline: summarizePlateDiscipline(battingPas, batterPitches),
      pitchingBattedBall: summarizeBattedBallProfile(pitchingPas),
      pitchingSpray: summarizeSprayProfile(pitchingPas),
      pitchingHitLocations: summarizeHitLocations(pitchingPas),
      pitchMix: summarizePitchMix(pitchingPas, pitcherPitches),
      pitchingBf: pitchingPas.length,
      pitchingExitVelo: summarizeExitVelocity(pitchingPas),
      pitchingContactQuality: summarizeContactQuality(pitchingPas),
    }
  }), [advancedFieldingByPlayer, baserunningByPlayer, closePlaysByPlayer, runnerClosePlaysByPlayer, expectedOutcomeModel, filteredPas, filteredPasWithCharacterNames, filteredPitches, gimmickLuckByPlayer, leagueConstants, movementByPlayer, paByPlayer, pitchingByPlayer, playerFieldingById, standings])

  const characterRows = useMemo(() => characters.map((character) => {
    const battingPas = filteredPasWithCharacterNames.filter((pa) => pa.character_id === character.id)
    const characterStints = filteredPitching.filter((stint) => stint.character_id === character.id)
    const pitchingPas = filteredPasWithCharacterNames.filter((pa) => pa.pitcher_id === character.id)
    const batting = filteredCharacterHistory[character.id]?.batting || summarizeBatting([])
    batting.rawPas = battingPas
    batting.ops = batting.obp + batting.slg
    const pitchingRisp = summarizeBatting(pitchingPas.filter((pa) => hasRispOpportunity(pa)))
    pitchingRisp.ops = pitchingRisp.obp + pitchingRisp.slg
    const pitching = filteredCharacterHistory[character.id]?.pitching || summarizePitching([])
    pitching.rawPas = pitchingPas
    pitching.rawStints = characterStints
    const allTimeBatting = allCharacterHistory[character.id]?.batting || summarizeBatting([])
    allTimeBatting.rawPas = allPasWithCharacterNames.filter((pa) => pa.character_id === character.id)
    allTimeBatting.ops = allTimeBatting.obp + allTimeBatting.slg
    const allTimePitching = allCharacterHistory[character.id]?.pitching || summarizePitching([])
    allTimePitching.rawPas = allPasWithCharacterNames.filter((pa) => pa.pitcher_id === character.id)
    allTimePitching.rawStints = [...pitchingStints, ...seasonPitchingStints].filter((stint) => stint.character_id === character.id)
    const allPicks = draftPicks.filter((pick) => pick.character_id === character.id)
    const currentOwner = ownerDraftPicks.find((pick) => pick.character_id === character.id) || allPicks.at(-1) || null
    const teamGamesPlayed = gamesPlayedByPlayerId[String(currentOwner?.player_id)] || 0
    const tournamentIdsDrafted = [...new Set(allPicks.map((pick) => String(pick.tournament_id)))]
    const championshipsWon = tournamentIdsDrafted.filter((tournamentId) =>
      tournaments.some(
        (tournament) =>
          String(tournament.id) === tournamentId &&
          allPicks.some((pick) => String(pick.tournament_id) === tournamentId && pick.player_id === tournament.champion_player_id),
      ),
    ).length

    const charPitcherPitches = filteredPitches.filter((pitch) => pitch.pitcher_id === character.name)
    const charBatterPitches = selectPitchesForPlateAppearances(filteredPitches, battingPas)
    const distanceProfile = summarizeHitDistance(battingPas)
    const exitVeloProfile = summarizeExitVelocity(battingPas)
    const contactQuality = summarizeContactQuality(battingPas)
    const expectedBatting = summarizeExpectedBatting(battingPas, expectedOutcomeModel)
    const expectedPitching = summarizeExpectedPitching(pitchingPas, expectedOutcomeModel)

    return {
      ...character,
      miiColor: currentOwner?.mii_color || null,
      mii_color: currentOwner?.mii_color || null,
      battingRating: character.batting,
      pitchingRating: character.pitching,
      fieldingRating: character.fielding,
      speedRating: character.speed,
      teamGamesPlayed,
      batting,
      pitching,
      pitchingRisp,
      allTimeBatting,
      allTimePitching,
      advancedBatting: sanitizeMetrics(summarizeAdvancedBatting(battingPas, leagueConstants)),
      advancedPitching: sanitizeMetrics(summarizeAdvancedPitching(characterStints, leagueConstants, { plateAppearances: pitchingPas })),
      starHit: summarizeStarHits(battingPas),
      starPitch: summarizeStarPitching(pitchingPas, charPitcherPitches),
      fielding: {
        ...(characterFieldingByName[character.name] || createEmptyFieldingRow({ id: character.id, name: character.name })),
        ...(advancedFieldingByCharacter[String(character.id)] || {}),
        ...(movementByCharacter[String(character.id)] || {}),
        ...(closePlaysByCharacter[String(character.id)] || EMPTY_CLOSE_PLAYS),
        doublePlays: Math.max(
          Number(characterFieldingByName[character.name]?.doublePlays) || 0,
          Number(advancedFieldingByCharacter[String(character.id)]?.doublePlays) || 0,
        ),
      },
      baserunning: {
        ...(baserunningByCharacter[String(character.id)] || { opportunities: 0, attempts: 0, holds: 0, advances: 0, outs: 0, attemptRate: null, successRate: null, baserunningRunValue: null }),
        ...(runnerClosePlaysByCharacter[String(character.id)] || EMPTY_RUNNER_CLOSE_PLAYS),
      },
      movement: movementByCharacter[String(character.id)] || { speedSamples: 0, sprintSpeedFps: null, maxSprintSpeedFps: null, bolts: 0, homeToFirstSamples: 0, homeToFirstSeconds: null, ninetyFootSplitSeconds: null },
      currentOwner,
      ownerName: getTeamShortName(identitiesByPlayerId[currentOwner?.player_id]) || playersById[currentOwner?.player_id]?.name || 'Undrafted',
      totalDrafts: allPicks.length,
      tournamentsDrafted: tournamentIdsDrafted.length,
      championshipsWon,
      intrinsics: buildCharacterIntrinsics(character),
      battedBall: summarizeBattedBallProfile(battingPas),
      sprayProfile: summarizeSprayProfile(battingPas),
      sprayContact: summarizeSprayContactProfile(battingPas),
      battedByType: summarizeBattedBallTypeProfile(battingPas),
      hitLocations: summarizeHitLocations(battingPas),
      distanceProfile,
      exitVeloProfile,
      contactQuality,
      expectedBatting,
      expectedPitching,
      gimmickLuck: gimmickLuckByCharacter[String(character.id)] || {
        luckScore: 0, luckyEvents: 0, unluckyEvents: 0,
        totalEvents: 0, affectedPlays: 0, gimmickTypes: [],
        luckRuns: 0, pricedPlays: 0,
      },
      hitPowerIndex: calculateHitPowerIndex(distanceProfile),
      parkAdjustedDistance: calculateParkAdjustedDistance(battingPas, filteredPas),
      plateDiscipline: summarizePlateDiscipline(battingPas, charBatterPitches),
      pitchingBattedBall: summarizeBattedBallProfile(pitchingPas),
      pitchingSpray: summarizeSprayProfile(pitchingPas),
      pitchingHitLocations: summarizeHitLocations(pitchingPas),
      pitchMix: summarizePitchMix(pitchingPas, charPitcherPitches),
      pitchingBf: pitchingPas.length,
      pitchingExitVelo: summarizeExitVelocity(pitchingPas),
      pitchingContactQuality: summarizeContactQuality(pitchingPas),
    }
  }), [advancedFieldingByCharacter, allCharacterHistory, allPasWithCharacterNames, baserunningByCharacter, characters, closePlaysByCharacter, runnerClosePlaysByCharacter, characterFieldingByName, draftPicks, expectedOutcomeModel, filteredCharacterHistory, filteredPas, filteredPasWithCharacterNames, filteredPitching, filteredPitches, gamesPlayedByPlayerId, gimmickLuckByCharacter, identitiesByPlayerId, leagueConstants, movementByCharacter, ownerDraftPicks, pitchingStints, playersById, seasonPitchingStints, tournaments])

  const characterPathFor = useCallback((characterId) => (
    sourceMode === 'seasons' && selectedSeasonValue
      ? `/character/${characterId}/season/${selectedSeasonValue}`
      : sourceMode === 'tournaments' && selectedTournamentValue
        ? `/character/${characterId}/tournament/${selectedTournamentValue}`
        : `/character/${characterId}/career`
  ), [sourceMode, selectedSeasonValue, selectedTournamentValue])

  const openCharacterPage = useCallback((characterId) => {
    const row = characterRows.find((entry) => entry.id === characterId)
    if (!row) return
    const path = characterPathFor(characterId)
    navigate(path, {
      state: {
        backTo: window.location.pathname + window.location.search,
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
        // No profileData.fullPreset here (deliberately, unlike the character-meta fields above):
        // that preset predates the isHome/isPostseason/handedness tags useCharacterProfileData now
        // stamps onto every PA during its own fetch (Value Batting, Postseason, Splits, Awards-column
        // sections all depend on those tags) — a bundled preset would silently render those sections
        // blank. Letting CharacterPage fetch normally costs one extra round-trip but keeps every
        // section correct regardless of entry point.
      },
    })
  }, [characterRows, navigate, charactersByName, playersById, identitiesByPlayerId, characterPathFor])

  // Resolves the same text PlayerTag puts in the identity cell, so a row's accessible name and
  // its visible label agree.
  const teamRowLabel = useCallback(
    (playerId) => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || '',
    [identitiesByPlayerId, playersById],
  )

  const openTeamPage = useCallback((playerId) => {
    const state = { state: { backTo: window.location.pathname + window.location.search } }
    if (sourceMode === 'seasons' && selectedSeasonValue) navigate(`/teams/${playerId}/season/${selectedSeasonValue}`, state)
    else if (sourceMode === 'tournaments' && selectedTournamentValue) navigate(`/teams/${playerId}/tournament/${selectedTournamentValue}`, state)
    else navigate(`/teams/${playerId}/career`, state)
  }, [navigate, sourceMode, selectedSeasonValue, selectedTournamentValue])

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

  const selectedStadiumSprayChartPas = useMemo(() => {
    const stadiumKey = selectedStadiumKey ? STADIUM_NAME_TO_KEY[selectedStadiumKey] : null
    return selectedStadiumPas
      .filter((pa) => !selectedStadiumKey || pa.hit_stadium_key === stadiumKey)
      .map((pa) => ({ ...pa, character_name: charactersById[pa.character_id]?.name || null }))
  }, [selectedStadiumKey, selectedStadiumPas, charactersById])

  const selectedStadiumRunEvents = useMemo(() => {
    let runs = selectedStadiumKey
      ? filteredRunEvents.filter((run) => gameToStadiumNameMap[String(run.game_id)] === selectedStadiumKey)
      : filteredRunEvents
    if (ballparkTimeFilter === 'day') runs = runs.filter((run) => !gameIsNightMap[String(run.game_id)])
    if (ballparkTimeFilter === 'night') runs = runs.filter((run) => gameIsNightMap[String(run.game_id)])
    return runs
  }, [filteredRunEvents, selectedStadiumKey, gameToStadiumNameMap, ballparkTimeFilter, gameIsNightMap])

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
    const runsByPlayer = groupBy(selectedStadiumRunEvents, 'scoring_player_id')
    return Object.entries(byPlayer).map(([playerId, pas]) => {
      const player = playersById[playerId]
      const batting = summarizeBatting(pas, runsByPlayer[playerId] || [])
      batting.ops = batting.obp + batting.slg
      return { playerId, name: player?.name || 'Unknown', batting, gamesAtPark: new Set(pas.map((pa) => pa.game_id)).size }
    }).filter((row) => row.batting.plateAppearances > 0)
  }, [selectedStadiumPas, selectedStadiumRunEvents, playersById])

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
    const runsByChar = groupBy(selectedStadiumRunEvents, 'scoring_character_id')
    return Object.entries(byChar).map(([charId, pas]) => {
      const char = characters.find((c) => String(c.id) === String(charId))
      const batting = summarizeBatting(pas, runsByChar[charId] || [])
      batting.ops = batting.obp + batting.slg
      return { id: char?.id || charId, name: char?.name || 'Unknown', batting }
    }).filter((row) => row.batting.plateAppearances > 0)
  }, [selectedStadiumPas, selectedStadiumRunEvents, characters])

  const ballparkCharacterPitchingRows = useMemo(() => {
    const byChar = groupBy(selectedStadiumStints, 'character_id')
    return Object.entries(byChar).map(([charId, stints]) => {
      const char = characters.find((c) => String(c.id) === String(charId))
      const pitching = summarizePitching(stints)
      return { id: char?.id || charId, name: char?.name || 'Unknown', pitching }
    }).filter(hasPitchingData)
  }, [selectedStadiumStints, characters])

  const timeFilteredAllRunEvents = useMemo(() => {
    if (ballparkTimeFilter === 'day') return filteredRunEvents.filter((run) => !gameIsNightMap[String(run.game_id)])
    if (ballparkTimeFilter === 'night') return filteredRunEvents.filter((run) => gameIsNightMap[String(run.game_id)])
    return filteredRunEvents
  }, [filteredRunEvents, ballparkTimeFilter, gameIsNightMap])

  // Contact-quality park factors (hard-hit%/barrel% at this park vs. the league rate) —
  // calculateParkFactors itself only knows box-score-style counts-per-game, not per-batted-ball
  // rates, so these are computed alongside it with the same summarizeContactQuality primitive
  // used everywhere else contact quality is measured, then merged onto the same factors object.
  function withContactQualityFactors(factors, stadiumPas, allPas) {
    const stadiumQuality = summarizeContactQuality(stadiumPas)
    const leagueQuality = summarizeContactQuality(allPas)
    const rateFactor = (stadiumRate, leagueRate) => (leagueRate ? stadiumRate / leagueRate : 1)
    return {
      ...factors,
      hardHit: stadiumQuality.hardHitRate != null && leagueQuality.hardHitRate
        ? rateFactor(stadiumQuality.hardHitRate, leagueQuality.hardHitRate) : 1,
      barrel: stadiumQuality.barrelRate != null && leagueQuality.barrelRate
        ? rateFactor(stadiumQuality.barrelRate, leagueQuality.barrelRate) : 1,
    }
  }

  const parkFactors = useMemo(() => {
    if (!selectedStadiumKey || !selectedStadiumPas.length) return null
    const timeFilteredLeaguePas = ballparkTimeFilter === 'day'
      ? filteredPas.filter((pa) => !gameIsNightMap[String(pa.game_id)])
      : ballparkTimeFilter === 'night'
        ? filteredPas.filter((pa) => gameIsNightMap[String(pa.game_id)])
        : filteredPas
    const factors = calculateParkFactors(selectedStadiumPas, timeFilteredLeaguePas, selectedStadiumRunEvents, timeFilteredAllRunEvents)
    return withContactQualityFactors(factors, selectedStadiumPas, timeFilteredLeaguePas)
  }, [selectedStadiumKey, selectedStadiumPas, filteredPas, ballparkTimeFilter, gameIsNightMap, selectedStadiumRunEvents, timeFilteredAllRunEvents])

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

  const allStadiumRunEventsByName = useMemo(() => {
    const byStadium = {}
    for (const run of timeFilteredAllRunEvents) {
      const stadiumName = gameToStadiumNameMap[String(run.game_id)]
      if (!stadiumName) continue
      if (!byStadium[stadiumName]) byStadium[stadiumName] = []
      byStadium[stadiumName].push(run)
    }
    return byStadium
  }, [timeFilteredAllRunEvents, gameToStadiumNameMap])

  const parkFactorRankings = useMemo(() => {
    if (!selectedStadiumKey || !parkFactors) return null
    const allStadiumNames = Object.keys(allStadiumPasByName)
    const factorsByStadium = allStadiumNames.map((name) => ({
      name,
      factors: withContactQualityFactors(
        calculateParkFactors(allStadiumPasByName[name], timeFilteredAllPas, allStadiumRunEventsByName[name] || [], timeFilteredAllRunEvents),
        allStadiumPasByName[name],
        timeFilteredAllPas,
      ),
    }))
    const ranks = {}
    for (const stat of Object.keys(parkFactors)) {
      const sorted = [...factorsByStadium].sort((a, b) => b.factors[stat] - a.factors[stat])
      const rank = sorted.findIndex((entry) => entry.name === selectedStadiumKey) + 1
      ranks[stat] = { rank, total: sorted.length }
    }
    return ranks
  }, [selectedStadiumKey, parkFactors, allStadiumPasByName, timeFilteredAllPas, allStadiumRunEventsByName, timeFilteredAllRunEvents])

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

  const playerIdentityCol = useMemo(() => ({ key: 'name', group: 'Player', label: 'Player', type: 'string', sticky: true, stickyLeft: 0, stickyWidth: 160, sortValue: (row) => row.name, render: (row) => <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} responsiveAbbreviation /> }), [identitiesByPlayerId, playersById])
  const charIdentityCol = useMemo(() => ({ ...charIdentityColBase, render: (row) => <CharacterCell name={row.name} to={characterPathFor(row.id)} /> }), [isCompact, characterPathFor])
  const ownerCol = useMemo(() => ({ key: 'owner', group: 'Identity', label: 'Owner', type: 'string', sortValue: (row) => row.ownerName, render: (row) => row.currentOwner ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.currentOwner.player_id} playersById={playersById} /> : row.ownerName }), [identitiesByPlayerId, playersById])

  // Luck = actual minus expected: positive means the player/character has
  // out-hit what their contact quality says they should have (fortunate),
  // negative means they've under-hit it (unlucky) -- e.g. hard-hit balls
  // finding gloves instead of grass.
  const baDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xBA != null ? row.batting.avg - row.expectedBatting.xBA : null
  const slgDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xSLG != null ? row.batting.slg - row.expectedBatting.xSLG : null
  const wobaDiff = (row) => qualifiesAdvancedBatting(row) && row.expectedBatting.xwOBA != null ? row.advancedBatting.woba - row.expectedBatting.xwOBA : null

  // The metric columns of every table tab, keyed `section.set` (see STATS_SECTIONS). Written once
  // and shared by the Players and Characters tables: `only` keeps a column to one identity, and
  // columnsForSet adds the identity column (plus Owner for Characters where the set asks for it).
  const metricsBySet = useMemo(() => {
    const showRates = locationDisplayMode === 'pct'
    // One column that reads as a share or a count, following the %/# toggle.
    const countOrRate = (key, group, label, getCount, getRate) => ({
      key,
      group,
      label: showRates ? `${label}%` : label,
      sortValue: (row) => (showRates ? getRate(row) : getCount(row)),
      value: (row) => (showRates ? formatPercent(getRate(row)) : getCount(row)),
    })
    const locationCols = (getLocations) => [
      { key: 'bipLoc', group: 'Location', label: 'BIP', sortValue: (row) => getLocations(row).total, value: (row) => getLocations(row).total },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pos) => ({
        key: `loc${pos}`,
        group: 'Location',
        label: POSITION_LABELS[pos],
        sortValue: (row) => showRates ? getLocations(row).rates[pos] : getLocations(row).counts[pos],
        value: (row) => showRates ? formatPercent(getLocations(row).rates[pos]) : formatInteger(getLocations(row).counts[pos]),
      })),
    ]
    // Pull/Center/Oppo exit velocity + slugging-on-contact — the same direction buckets as the
    // Batted Ball direction columns, cross-tabbed with contact quality (e.g. "pull-side slugging").
    const sprayContactCols = (getSprayContact) => [
      { key: 'pullEv', group: 'By Direction', label: 'Pull EV', sortValue: (row) => getSprayContact(row).pull.avgExitVelocity, value: (row) => getSprayContact(row).pull.avgExitVelocity != null ? `${getSprayContact(row).pull.avgExitVelocity} mph` : '-' },
      { key: 'centerEv', group: 'By Direction', label: 'Ctr EV', sortValue: (row) => getSprayContact(row).center.avgExitVelocity, value: (row) => getSprayContact(row).center.avgExitVelocity != null ? `${getSprayContact(row).center.avgExitVelocity} mph` : '-' },
      { key: 'oppoEv', group: 'By Direction', label: 'Oppo EV', sortValue: (row) => getSprayContact(row).oppo.avgExitVelocity, value: (row) => getSprayContact(row).oppo.avgExitVelocity != null ? `${getSprayContact(row).oppo.avgExitVelocity} mph` : '-' },
      { key: 'pullSlg', group: 'By Direction', label: 'Pull SLG', sortValue: (row) => getSprayContact(row).pull.slgOnContact, value: (row) => getSprayContact(row).pull.slgOnContact != null ? formatAverageStyle(getSprayContact(row).pull.slgOnContact) : '-' },
      { key: 'oppoSlg', group: 'By Direction', label: 'Oppo SLG', sortValue: (row) => getSprayContact(row).oppo.slgOnContact, value: (row) => getSprayContact(row).oppo.slgOnContact != null ? formatAverageStyle(getSprayContact(row).oppo.slgOnContact) : '-' },
    ]
    // BABIP/wOBA-on-contact broken out by batted-ball trajectory (GB/FB/LD) — the same buckets as
    // the Trajectory columns, cross-tabbed with outcome quality.
    const battedTypeCols = (getBattedByType) => [
      { key: 'gbBabip', group: 'By Trajectory', label: 'GB BABIP', sortValue: (row) => getBattedByType(row).groundBall.babip, value: (row) => getBattedByType(row).groundBall.babip != null ? formatAverageStyle(getBattedByType(row).groundBall.babip) : '-' },
      { key: 'ldBabip', group: 'By Trajectory', label: 'LD BABIP', sortValue: (row) => getBattedByType(row).lineDrive.babip, value: (row) => getBattedByType(row).lineDrive.babip != null ? formatAverageStyle(getBattedByType(row).lineDrive.babip) : '-' },
      { key: 'fbBabip', group: 'By Trajectory', label: 'FB BABIP', sortValue: (row) => getBattedByType(row).flyBall.babip, value: (row) => getBattedByType(row).flyBall.babip != null ? formatAverageStyle(getBattedByType(row).flyBall.babip) : '-' },
      { key: 'ldWoba', group: 'By Trajectory', label: 'LD wOBA', sortValue: (row) => getBattedByType(row).lineDrive.wobaOnContact, value: (row) => getBattedByType(row).lineDrive.wobaOnContact != null ? formatAverageStyle(getBattedByType(row).lineDrive.wobaOnContact) : '-' },
      { key: 'fbWoba', group: 'By Trajectory', label: 'FB wOBA', sortValue: (row) => getBattedByType(row).flyBall.wobaOnContact, value: (row) => getBattedByType(row).flyBall.wobaOnContact != null ? formatAverageStyle(getBattedByType(row).flyBall.wobaOnContact) : '-' },
    ]
    // Contact quality allowed / exit velocity allowed — the same summarizeContactQuality/
    // summarizeExitVelocity primitives used for a batter's own contact, run over the pitcher's
    // full allowed-PA line instead of just the star-pitch subset summarizeStarPitching covers.
    const contactAllowedCols = (getExitVeloAllowed, getContactAllowed) => [
      { key: 'avgEvAllowed', group: 'Contact Allowed', label: 'Avg EV Allowed', sortValue: (row) => getExitVeloAllowed(row).avgExitVelocity, value: (row) => getExitVeloAllowed(row).avgExitVelocity != null ? `${getExitVeloAllowed(row).avgExitVelocity} mph` : '-' },
      { key: 'barrelRateAllowed', group: 'Contact Allowed', label: 'Barrel% Allowed', sortValue: (row) => getContactAllowed(row).barrelRate, value: (row) => getContactAllowed(row).barrelRate != null ? formatPercent(getContactAllowed(row).barrelRate) : '-' },
      { key: 'hardHitRateAllowed', group: 'Contact Allowed', label: 'Hard-Hit% Allowed', sortValue: (row) => getContactAllowed(row).hardHitRate, value: (row) => getContactAllowed(row).hardHitRate != null ? formatPercent(getContactAllowed(row).hardHitRate) : '-' },
    ]
    const evidenceButton = (row, key, number) => number ? <button type="button" aria-label={`Show ${number} ${key} opportunities for ${row.name}`} onClick={(event) => { event.stopPropagation(); setBaseEvidence({ id: String(row.playerId ?? row.id), identity: row.playerId != null ? 'player' : 'character', key, name: row.name }) }}>{number}</button> : 0
    const xbtCount = (key, label) => ({ key, group: 'Extra Bases', label, sortValue: (row) => row.baserunning[key], render: (row) => evidenceButton(row, key, row.baserunning[key] || 0) })
    const xbtRate = (key, label) => ({ key, group: 'Rates', label, sortValue: (row) => row.baserunning[key], value: (row) => row.baserunning[key] == null ? '—' : formatPercent(row.baserunning[key], 1) })
    const xbtSplit = (type, label) => ({
      key: type, group: 'Opportunity Type', label,
      sortValue: (row) => row.baserunning.byType?.[type]?.opportunities || 0,
      render: (row) => {
        const item = row.baserunning.byType?.[type]
        return item ? <span>{evidenceButton(row, type, item.opportunities)}/{item.holds}/{item.attempts}/{item.advances}/{item.outs}</span> : '—'
      },
    })
    const directionalOaa = (key, direction, label) => ({ key, group: 'Directional OAA', label, sortValue: (row) => row.fielding.directionalOpportunities?.[direction] ? row.fielding.directionalOaa?.[direction] : null, value: (row) => row.fielding.directionalOpportunities?.[direction] ? formatSignedAverageStyle(row.fielding.directionalOaa[direction], 2) : '—' })

    return {
      'batting.standard': [
        { key: 'gamesPlayed', only: 'players', group: 'Batting', label: 'G', sortValue: (row) => row.gamesPlayed, value: (row) => row.gamesPlayed },
        { key: 'gamesPlayed', only: 'characters', group: 'Batting', label: 'G', sortValue: (row) => row.batting.games, value: (row) => row.batting.games },
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
      ],
      'batting.advanced': [
        { key: 'plateAppearances', group: 'Sample', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
        { key: 'woba', group: 'Run Value', label: 'wOBA', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.woba : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.woba) : '--' },
        { key: 'wrcPlus', group: 'Run Value', label: 'wRC+', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.wrcPlus : null, render: (row) => qualifiesAdvancedBatting(row) ? positiveMetric(row.advancedBatting.wrcPlus) : '--' },
        { key: 'opsPlus', group: 'Run Value', label: 'OPS+', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.opsPlus : null, render: (row) => qualifiesAdvancedBatting(row) ? positiveMetric(row.advancedBatting.opsPlus) : '--' },
        { key: 'rc3', group: 'Run Value', label: 'RC/3', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.rc3 : null, render: (row) => qualifiesAdvancedBatting(row) ? <span title="Runs Created per 3-inning game">{formatTooltipNumber(row.advancedBatting.rc3, 1)}</span> : '--' },
        { key: 'babip', group: 'Power & Contact', label: 'BABIP', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.babip : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.babip) : '--' },
        { key: 'iso', group: 'Power & Contact', label: 'ISO', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.iso : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.iso) : '--' },
        { key: 'xbh', group: 'Power & Contact', label: 'XBH', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.xbh : null, value: (row) => qualifiesAdvancedBatting(row) ? formatInteger(row.advancedBatting.xbh) : '--' },
        { key: 'xbhPct', group: 'Power & Contact', label: 'XBH%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.xbhPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.xbhPct, 1) : '--' },
        { key: 'hrPerPa', group: 'Power & Contact', label: 'HR/PA', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.hrPerPa : null, value: (row) => qualifiesAdvancedBatting(row) ? formatAverageStyle(row.advancedBatting.hrPerPa) : '--' },
        { key: 'kPct', group: 'Discipline', label: 'K%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.kPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.kPct, 1) : '--' },
        { key: 'bbPct', group: 'Discipline', label: 'BB%', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.bbPct : null, value: (row) => qualifiesAdvancedBatting(row) ? formatPercent(row.advancedBatting.bbPct, 1) : '--' },
        { key: 'bbkRatio', group: 'Discipline', label: 'BB/K', sortValue: (row) => qualifiesAdvancedBatting(row) ? row.advancedBatting.bbkRatio : null, value: (row) => qualifiesAdvancedBatting(row) ? formatDecimal(row.advancedBatting.bbkRatio, 2) : '--' },
        { key: 'rispAvg', group: 'Situational', label: 'RISP AVG', sortValue: (row) => row.batting.rispAtBats ? row.batting.rispAvg : null, value: (row) => formatOptionalRate(row.batting.rispAtBats ? row.batting.rispAvg : null) },
      ],
      'batting.batted_ball': [
        { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.battedBall.total, value: (row) => row.battedBall.total },
        countOrRate('ld', 'Trajectory', 'LD', (row) => row.battedBall.lineDrives, (row) => row.battedBall.ldRate),
        countOrRate('gb', 'Trajectory', 'GB', (row) => row.battedBall.groundBalls, (row) => row.battedBall.gbRate),
        countOrRate('fb', 'Trajectory', 'FB', (row) => row.battedBall.flyBalls, (row) => row.battedBall.fbRate),
        countOrRate('pull', 'Direction', 'Pull', (row) => row.sprayProfile.pull, (row) => row.sprayProfile.pullRate),
        countOrRate('ctr', 'Direction', 'Ctr', (row) => row.sprayProfile.center, (row) => row.sprayProfile.centerRate),
        countOrRate('oppo', 'Direction', 'Oppo', (row) => row.sprayProfile.oppo, (row) => row.sprayProfile.oppoRate),
        ...battedTypeCols((row) => row.battedByType),
      ],
      'batting.contact': [
        { key: 'bip', group: 'Sample', label: 'BIP', sortValue: getTrackedBipSample, value: (row) => getTrackedBipSample(row) || '-' },
        { key: 'avgExitVelo', group: 'Exit Velo', label: 'Avg EV', sortValue: (row) => row.exitVeloProfile.avgExitVelocity, value: (row) => row.exitVeloProfile.avgExitVelocity != null ? `${row.exitVeloProfile.avgExitVelocity} mph` : '-' },
        { key: 'maxExitVelo', group: 'Exit Velo', label: 'Max EV', sortValue: (row) => row.exitVeloProfile.maxExitVelocity, value: (row) => row.exitVeloProfile.maxExitVelocity != null ? `${row.exitVeloProfile.maxExitVelocity} mph` : '-' },
        { key: 'avgLaunchAngle', group: 'Exit Velo', label: 'Avg Launch', sortValue: (row) => row.exitVeloProfile.avgLaunchAngle, value: (row) => row.exitVeloProfile.avgLaunchAngle != null ? `${row.exitVeloProfile.avgLaunchAngle}°` : '-' },
        { key: 'avgDist', group: 'Distance', label: 'Avg Dist', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.avgDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.avgDistance} ft` : '-' },
        { key: 'maxDist', group: 'Distance', label: 'Longest', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.maxDistance : null, value: (row) => qualifiesForPower(row) ? `${row.distanceProfile.maxDistance} ft` : '-' },
        { key: 'hardHitRateDist', group: 'Distance', label: 'Hard-Hit% (Dist)', sortValue: (row) => qualifiesForPower(row) ? row.distanceProfile.hardHitRate : null, value: (row) => qualifiesForPower(row) ? formatPercent(row.distanceProfile.hardHitRate) : '-' },
        { key: 'parkAdjustedDistance', group: 'Distance', label: 'Park-Adj Dist', sortValue: (row) => qualifiesForPower(row) ? row.parkAdjustedDistance : null, value: (row) => qualifiesForPower(row) ? `${row.parkAdjustedDistance} ft` : '-' },
        { key: 'hitPowerIndex', group: 'Quality', label: 'Power Index', sortValue: (row) => qualifiesForPower(row) ? row.hitPowerIndex : null, value: (row) => qualifiesForPower(row) ? row.hitPowerIndex : '-' },
        { key: 'barrelRate', group: 'Quality', label: 'Barrel%', sortValue: (row) => row.contactQuality.barrelRate, value: (row) => row.contactQuality.barrelRate != null ? formatPercent(row.contactQuality.barrelRate) : '-' },
        { key: 'hardHitRateEv', group: 'Quality', label: 'Hard-Hit% (EV)', sortValue: (row) => row.contactQuality.hardHitRate, value: (row) => row.contactQuality.hardHitRate != null ? formatPercent(row.contactQuality.hardHitRate) : '-' },
        { key: 'sweetSpotRate', group: 'Quality', label: 'Sweet-Spot%', sortValue: (row) => row.contactQuality.sweetSpotRate, value: (row) => row.contactQuality.sweetSpotRate != null ? formatPercent(row.contactQuality.sweetSpotRate) : '-' },
        { key: 'avgSprayAngle', group: 'By Direction', label: 'Spray Angle', sortValue: (row) => row.sprayProfile.avgSprayAngle, value: (row) => row.sprayProfile.avgSprayAngle != null ? `${row.sprayProfile.avgSprayAngle}°` : '-' },
        ...sprayContactCols((row) => row.sprayContact),
      ],
      'batting.expected': [
        { key: 'pa', group: 'Sample', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
        { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.expectedBatting.sampleSize, value: (row) => row.expectedBatting.sampleSize },
        { key: 'xBA', group: 'Expected', label: 'xBA', sortValue: (row) => row.expectedBatting.xBA, value: (row) => row.expectedBatting.xBA != null ? formatAverageStyle(row.expectedBatting.xBA) : '-' },
        { key: 'xSLG', group: 'Expected', label: 'xSLG', sortValue: (row) => row.expectedBatting.xSLG, value: (row) => row.expectedBatting.xSLG != null ? formatAverageStyle(row.expectedBatting.xSLG) : '-' },
        { key: 'xwOBA', group: 'Expected', label: 'xwOBA', sortValue: (row) => row.expectedBatting.xwOBA, value: (row) => row.expectedBatting.xwOBA != null ? formatAverageStyle(row.expectedBatting.xwOBA) : '-' },
        { key: 'baDiff', group: 'Luck', label: 'AVG -xBA', sortValue: baDiff, render: (row) => <ValueBadge color={getLuckColor(baDiff(row))} value={formatSignedAverageStyle(baDiff(row))} /> },
        { key: 'slgDiff', group: 'Luck', label: 'SLG -xSLG', sortValue: slgDiff, render: (row) => <ValueBadge color={getLuckColor(slgDiff(row))} value={formatSignedAverageStyle(slgDiff(row))} /> },
        { key: 'wobaDiff', group: 'Luck', label: 'wOBA -xwOBA', sortValue: wobaDiff, render: (row) => <ValueBadge color={getLuckColor(wobaDiff(row))} value={formatSignedAverageStyle(wobaDiff(row))} /> },
      ],
      'batting.discipline': [
        { key: 'pa', group: 'Usage', label: 'PA', sortValue: (row) => row.batting.plateAppearances, value: (row) => row.batting.plateAppearances },
        { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.plateDiscipline.totalPitches, value: (row) => row.plateDiscipline.totalPitches },
        { key: 'pitchesPerPa', group: 'Usage', label: 'P/PA', sortValue: (row) => row.plateDiscipline.pitchesPerPa, value: (row) => formatDecimal(row.plateDiscipline.pitchesPerPa, 2) },
        { key: 'whiffRate', group: 'Contact', label: 'Whiff%', sortValue: (row) => row.plateDiscipline.whiffRate, value: (row) => formatPercent(row.plateDiscipline.whiffRate) },
        { key: 'foulRate', group: 'Contact', label: 'Foul%', sortValue: (row) => row.plateDiscipline.foulRate, value: (row) => formatPercent(row.plateDiscipline.foulRate) },
        { key: 'kRate', group: 'Outcomes', label: 'K%', sortValue: (row) => row.plateDiscipline.kRate, value: (row) => formatPercent(row.plateDiscipline.kRate) },
        { key: 'ksRate', group: 'Outcomes', label: 'KS%', sortValue: (row) => row.plateDiscipline.ksRate, value: (row) => formatPercent(row.plateDiscipline.ksRate) },
        { key: 'klRate', group: 'Outcomes', label: 'KL%', sortValue: (row) => row.plateDiscipline.klRate, value: (row) => formatPercent(row.plateDiscipline.klRate) },
        { key: 'bbRate', group: 'Outcomes', label: 'BB%', sortValue: (row) => row.plateDiscipline.bbRate, value: (row) => formatPercent(row.plateDiscipline.bbRate) },
      ],
      'batting.stars': [
        { key: 'starHitUsed', group: 'Star Hits', label: <><StarIcon />HA</>, sortValue: (row) => row.starHit.used, value: (row) => row.starHit.used },
        { key: 'starHitConnected', group: 'Star Hits', label: <><StarIcon />HC</>, sortValue: (row) => row.starHit.connected, value: (row) => row.starHit.connected },
        { key: 'starHitContactRate', group: 'Star Hits', label: <><StarIcon />Contact%</>, sortValue: (row) => row.starHit.contactRate, value: (row) => formatPercent(row.starHit.contactRate, 1) },
        { key: 'starHitSuccessful', group: 'Star Hits', label: <><StarIcon />HH</>, sortValue: (row) => row.starHit.successful, value: (row) => row.starHit.successful },
        { key: 'starHitRbi', group: 'Star Hits', label: <><StarIcon />HRBI</>, sortValue: (row) => row.starHit.totalRbi, value: (row) => row.starHit.totalRbi },
        { key: 'starHitRbiPerUse', group: 'Star Hits', label: <><StarIcon />RBI/Use</>, sortValue: (row) => row.starHit.avgRbiPerUse, value: (row) => formatDecimal(row.starHit.avgRbiPerUse, 2) },
        { key: 'starHitAvg', group: 'Star Hits', label: <><StarIcon />AVG</>, sortValue: (row) => row.starHit.slashLine.avg, value: (row) => formatDecimal(row.starHit.slashLine.avg) },
        { key: 'starHitObp', group: 'Star Hits', label: <><StarIcon />OBP</>, sortValue: (row) => row.starHit.slashLine.obp, value: (row) => formatDecimal(row.starHit.slashLine.obp) },
        { key: 'starHitSlg', group: 'Star Hits', label: <><StarIcon />SLG</>, sortValue: (row) => row.starHit.slashLine.slg, value: (row) => formatDecimal(row.starHit.slashLine.slg) },
        { key: 'starHitOps', group: 'Star Hits', label: <><StarIcon />OPS</>, sortValue: (row) => row.starHit.slashLine.ops, value: (row) => formatDecimal(row.starHit.slashLine.ops) },
        { key: 'starHitAvgExitVelo', group: 'Star Hits', label: <><StarIcon />Avg EV</>, sortValue: (row) => row.starHit.avgExitVelo ?? -1, value: (row) => row.starHit.avgExitVelo != null ? `${row.starHit.avgExitVelo} mph` : '-' },
        { key: 'starHitMaxExitVelo', group: 'Star Hits', label: <><StarIcon />Max EV</>, sortValue: (row) => row.starHit.maxExitVelo ?? -1, value: (row) => row.starHit.maxExitVelo != null ? `${row.starHit.maxExitVelo} mph` : '-' },
        { key: 'starHitAvgLaunchAngle', group: 'Star Hits', label: <><StarIcon />Avg LA</>, sortValue: (row) => row.starHit.avgLaunchAngle ?? -999, value: (row) => row.starHit.avgLaunchAngle != null ? `${row.starHit.avgLaunchAngle}°` : '-' },
        { key: 'starHitAvgDistance', group: 'Star Hits', label: <><StarIcon />Avg Dist</>, sortValue: (row) => row.starHit.avgDistance ?? -1, value: (row) => row.starHit.avgDistance != null ? `${row.starHit.avgDistance} ft` : '-' },
        { key: 'starHitMaxDistance', group: 'Star Hits', label: <><StarIcon />Max Dist</>, sortValue: (row) => row.starHit.maxDistance ?? -1, value: (row) => row.starHit.maxDistance != null ? `${row.starHit.maxDistance} ft` : '-' },
      ],
      'batting.spray': locationCols((row) => row.hitLocations),
      'pitching.standard': [
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
        { key: 'kPer3', group: 'Rates', label: 'K/3', sortValue: (row) => row.pitching.kPer3, value: (row) => formatDecimal(row.pitching.kPer3, 2) },
      ],
      'pitching.advanced': [
        { key: 'innings', group: 'Sample', label: 'IP', sortValue: (row) => row.pitching.innings, value: (row) => formatDecimal(row.pitching.innings, 1) },
        { key: 'fip', group: 'Run Prevention', label: 'FIP', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fip : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.fip, 2) : '--' },
        { key: 'fipMinus', group: 'Run Prevention', label: 'FIP-', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.fipMinus : null, render: (row) => qualifiesAdvancedPitching(row) ? inverseMetric(row.advancedPitching.fipMinus) : '--' },
        { key: 'eraMinus', group: 'Run Prevention', label: 'ERA-', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.eraMinus : null, render: (row) => qualifiesAdvancedPitching(row) ? inverseMetric(row.advancedPitching.eraMinus) : '--' },
        { key: 'bb3', group: 'Per 3 Innings', label: 'BB/3', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.bb3 : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.bb3, 2) : '--' },
        { key: 'h3', group: 'Per 3 Innings', label: 'H/3', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.h3 : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.h3, 2) : '--' },
        { key: 'hrPer3', group: 'Per 3 Innings', label: 'HR/3', sortValue: (row) => row.pitching.hrPer3, value: (row) => formatDecimal(row.pitching.hrPer3, 2) },
        { key: 'kPct', group: 'Strikeouts & Walks', label: 'K%', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.kPct : null, value: (row) => qualifiesAdvancedPitching(row) ? formatPercent(row.advancedPitching.kPct, 1) : '--' },
        { key: 'bbPct', group: 'Strikeouts & Walks', label: 'BB%', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.bbPct : null, value: (row) => qualifiesAdvancedPitching(row) ? formatPercent(row.advancedPitching.bbPct, 1) : '--' },
        { key: 'kBB', group: 'Strikeouts & Walks', label: 'K/BB', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.kBB : null, value: (row) => qualifiesAdvancedPitching(row) ? formatDecimal(row.advancedPitching.kBB, 2) : '--' },
        { key: 'babipAllowed', group: 'Contact', label: 'BABIP Allowed', sortValue: (row) => qualifiesAdvancedPitching(row) ? row.advancedPitching.babipAllowed : null, value: (row) => qualifiesAdvancedPitching(row) ? formatAverageStyle(row.advancedPitching.babipAllowed) : '--' },
        { key: 'oppRispAvg', group: 'Contact', label: 'Opp RISP AVG', sortValue: (row) => row.pitchingRisp.atBats ? row.pitchingRisp.avg : null, value: (row) => formatOptionalRate(row.pitchingRisp.atBats ? row.pitchingRisp.avg : null) },
      ],
      'pitching.batted_ball': [
        { key: 'bip', group: 'Sample', label: 'BIP Allowed', sortValue: (row) => row.pitchingBattedBall.total, value: (row) => row.pitchingBattedBall.total },
        countOrRate('ld', 'Trajectory', 'LD', (row) => row.pitchingBattedBall.lineDrives, (row) => row.pitchingBattedBall.ldRate),
        countOrRate('gb', 'Trajectory', 'GB', (row) => row.pitchingBattedBall.groundBalls, (row) => row.pitchingBattedBall.gbRate),
        countOrRate('fb', 'Trajectory', 'FB', (row) => row.pitchingBattedBall.flyBalls, (row) => row.pitchingBattedBall.fbRate),
        countOrRate('pull', 'Direction', 'Pull', (row) => row.pitchingSpray.pull, (row) => row.pitchingSpray.pullRate),
        countOrRate('ctr', 'Direction', 'Ctr', (row) => row.pitchingSpray.center, (row) => row.pitchingSpray.centerRate),
        countOrRate('oppo', 'Direction', 'Oppo', (row) => row.pitchingSpray.oppo, (row) => row.pitchingSpray.oppoRate),
        ...contactAllowedCols((row) => row.pitchingExitVelo, (row) => row.pitchingContactQuality),
        ...locationCols((row) => row.pitchingHitLocations),
      ],
      'pitching.expected': [
        { key: 'pa', group: 'Sample', label: 'BF', sortValue: (row) => row.pitchingBf, value: (row) => row.pitchingBf },
        { key: 'bip', group: 'Sample', label: 'BIP', sortValue: (row) => row.expectedPitching.sampleSize, value: (row) => row.expectedPitching.sampleSize },
        { key: 'xBA', group: 'Expected Allowed', label: 'xBAA', sortValue: (row) => row.expectedPitching.xBAAllowed, value: (row) => row.expectedPitching.xBAAllowed != null ? formatAverageStyle(row.expectedPitching.xBAAllowed) : '-' },
        { key: 'xSLG', group: 'Expected Allowed', label: 'xSLGA', sortValue: (row) => row.expectedPitching.xSLGAllowed, value: (row) => row.expectedPitching.xSLGAllowed != null ? formatAverageStyle(row.expectedPitching.xSLGAllowed) : '-' },
        { key: 'xwOBA', group: 'Expected Allowed', label: 'xwOBAA', sortValue: (row) => row.expectedPitching.xwOBAAllowed, value: (row) => row.expectedPitching.xwOBAAllowed != null ? formatAverageStyle(row.expectedPitching.xwOBAAllowed) : '-' },
      ],
      'pitching.pitch_mix': [
        { key: 'bf', group: 'Usage', label: 'BF', sortValue: (row) => row.pitchingBf, value: (row) => row.pitchingBf },
        { key: 'pitches', group: 'Usage', label: 'Pitches', sortValue: (row) => row.pitchMix.totalPitches, value: (row) => row.pitchMix.totalPitches },
        { key: 'pitchesPerBatter', group: 'Usage', label: 'P/BF', sortValue: (row) => row.pitchMix.pitchesPerBatter, value: (row) => formatDecimal(row.pitchMix.pitchesPerBatter, 2) },
        { key: 'avgVelo', group: 'Velocity', label: 'Avg Velo', sortValue: (row) => row.pitchMix.averageVelocityMph, value: (row) => row.pitchMix.averageVelocityMph != null ? `${formatDecimal(row.pitchMix.averageVelocityMph, 1)} mph` : '-' },
        { key: 'maxVelo', group: 'Velocity', label: 'Max Velo', sortValue: (row) => row.pitchMix.maxVelocityMph, value: (row) => row.pitchMix.maxVelocityMph != null ? `${formatDecimal(row.pitchMix.maxVelocityMph, 1)} mph` : '-' },
        { key: 'trackedPct', group: 'Velocity', label: 'Tracked %', sortValue: (row) => row.pitchMix.trackingCoverage, value: (row) => row.pitchMix.trackingCoverage != null ? formatPercent(row.pitchMix.trackingCoverage) : '-' },
        { key: 'strikeRate', group: 'Zone', label: 'Strike%', sortValue: (row) => row.pitchMix.strikeRate, value: (row) => formatPercent(row.pitchMix.strikeRate) },
        { key: 'ballRate', group: 'Zone', label: 'Ball%', sortValue: (row) => row.pitchMix.ballRate, value: (row) => formatPercent(row.pitchMix.ballRate) },
        { key: 'firstPitchStrikeRate', group: 'Zone', label: '1stStr%', sortValue: (row) => row.pitchMix.firstPitchStrikeRate, value: (row) => formatPercent(row.pitchMix.firstPitchStrikeRate) },
        { key: 'swingingMissRate', group: 'Miss', label: 'Whiff%', sortValue: (row) => row.pitchMix.swingingMissRate, value: (row) => formatPercent(row.pitchMix.swingingMissRate) },
        { key: 'foulRate', group: 'Miss', label: 'Foul%', sortValue: (row) => row.pitchMix.foulRate, value: (row) => formatPercent(row.pitchMix.foulRate) },
      ],
      'pitching.stars': [
        { key: 'starPitchUsed', group: 'Star Pitches', label: <><StarIcon />PA</>, sortValue: (row) => row.starPitch.used, value: (row) => row.starPitch.used },
        { key: 'starPitchPaUsed', group: 'Star Pitches', label: <><StarIcon />PPA</>, sortValue: (row) => row.starPitch.paUsed, value: (row) => row.starPitch.paUsed },
        { key: 'starPitchOuts', group: 'Star Pitches', label: <><StarIcon />PO</>, sortValue: (row) => row.starPitch.outsOnStarPitch, value: (row) => row.starPitch.outsOnStarPitch },
        { key: 'starPitchHits', group: 'Star Pitches', label: <><StarIcon />PH</>, sortValue: (row) => row.starPitch.hitsAllowedOnStarPitch, value: (row) => row.starPitch.hitsAllowedOnStarPitch },
        { key: 'starPitchSuccessRate', group: 'Star Pitches', label: <><StarIcon />P%</>, sortValue: (row) => row.starPitch.successRate, value: (row) => formatPercent(row.starPitch.successRate, 1) },
        { key: 'starPitchOppAvg', group: 'Star Pitches', label: <><StarIcon />OppAVG</>, sortValue: (row) => row.starPitch.oppSlashLine.avg, value: (row) => formatDecimal(row.starPitch.oppSlashLine.avg) },
        { key: 'starPitchOppObp', group: 'Star Pitches', label: <><StarIcon />OppOBP</>, sortValue: (row) => row.starPitch.oppSlashLine.obp, value: (row) => formatDecimal(row.starPitch.oppSlashLine.obp) },
        { key: 'starPitchOppSlg', group: 'Star Pitches', label: <><StarIcon />OppSLG</>, sortValue: (row) => row.starPitch.oppSlashLine.slg, value: (row) => formatDecimal(row.starPitch.oppSlashLine.slg) },
        { key: 'starPitchOppOps', group: 'Star Pitches', label: <><StarIcon />OppOPS</>, sortValue: (row) => row.starPitch.oppSlashLine.ops, value: (row) => formatDecimal(row.starPitch.oppSlashLine.ops) },
        { key: 'starPitchAvgExitVeloAllowed', group: 'Star Pitches', label: <><StarIcon />Avg EV</>, sortValue: (row) => row.starPitch.avgExitVeloAllowed ?? -1, value: (row) => row.starPitch.avgExitVeloAllowed != null ? `${row.starPitch.avgExitVeloAllowed} mph` : '-' },
        { key: 'starPitchAvgLaunchAngleAllowed', group: 'Star Pitches', label: <><StarIcon />Avg LA</>, sortValue: (row) => row.starPitch.avgLaunchAngleAllowed ?? -999, value: (row) => row.starPitch.avgLaunchAngleAllowed != null ? `${row.starPitch.avgLaunchAngleAllowed}°` : '-' },
        { key: 'starPitchAvgDistanceAllowed', group: 'Star Pitches', label: <><StarIcon />Avg Dist</>, sortValue: (row) => row.starPitch.avgDistanceAllowed ?? -1, value: (row) => row.starPitch.avgDistanceAllowed != null ? `${row.starPitch.avgDistanceAllowed} ft` : '-' },
      ],
      'fielding.standard': [
        { key: 'games', group: 'Fielding', label: 'G', sortValue: (row) => row.fielding.games, value: (row) => row.fielding.games },
        { key: 'chances', group: 'Fielding', label: 'Chances', sortValue: (row) => row.fielding.chances, value: (row) => row.fielding.chances },
        { key: 'putouts', group: 'Fielding', label: 'PO', sortValue: (row) => row.fielding.putouts, value: (row) => row.fielding.putouts },
        { key: 'assists', group: 'Fielding', label: 'A', sortValue: (row) => row.fielding.assists, value: (row) => row.fielding.assists },
        { key: 'errors', group: 'Fielding', label: 'E', sortValue: (row) => row.fielding.errors, value: (row) => row.fielding.errors },
        { key: 'fieldingPct', group: 'Fielding', label: 'FLD%', sortValue: (row) => row.fielding.fieldingPct, value: (row) => formatAverageStyle(row.fielding.fieldingPct) },
        { key: 'rangeFactor', group: 'Efficiency', label: 'Range Factor', sortValue: (row) => row.fielding.rangeFactor, value: (row) => formatDecimal(row.fielding.rangeFactor, 2) },
        { key: 'der', only: 'players', group: 'Efficiency', label: 'DER', sortValue: (row) => row.fielding.defensiveEfficiency, value: (row) => row.fielding.defensiveEfficiency != null ? formatAverageStyle(row.fielding.defensiveEfficiency) : '—' },
        { key: 'buddyJumps', group: 'Highlights', label: 'BJ', sortValue: (row) => row.fielding.buddyJumps, value: (row) => row.fielding.buddyJumps },
        { key: 'nicePlays', group: 'Highlights', label: 'Nice Plays', sortValue: (row) => row.fielding.nicePlays, value: (row) => row.fielding.nicePlays },
        { key: 'nicePlayRate', group: 'Highlights', label: 'Nice Play %', sortValue: (row) => row.fielding.nicePlayRate, value: (row) => formatPercent(row.fielding.nicePlayRate, 1) },
        { key: 'closePlays', group: 'Highlights', label: 'Close Plays', sortValue: (row) => row.fielding.closePlays, value: (row) => row.fielding.closePlays },
        { key: 'closePlaysWon', group: 'Highlights', label: 'CP Won', sortValue: (row) => row.fielding.closePlaysWon, value: (row) => row.fielding.closePlaysWon },
        { key: 'closePlaysLost', group: 'Highlights', label: 'CP Lost', sortValue: (row) => row.fielding.closePlaysLost, value: (row) => row.fielding.closePlaysLost },
        { key: 'starHitErrors', group: 'Star Hits', label: <><StarIcon />E</>, sortValue: (row) => row.fielding.starHitErrors, value: (row) => row.fielding.starHitErrors },
        { key: 'adjustedFieldingPct', group: 'Star Hits', label: <><StarIcon />Adj FLD%</>, sortValue: (row) => row.fielding.adjustedFieldingPct, value: (row) => formatAverageStyle(row.fielding.adjustedFieldingPct) },
      ],
      'fielding.range': [
        { key: 'rangeRuns', group: 'Range', label: 'Range Runs', sortValue: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES ? row.fielding.rangeRuns : null), value: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES && row.fielding.rangeRuns != null ? (row.fielding.rangeRuns > 0 ? `+${row.fielding.rangeRuns}` : row.fielding.rangeRuns) : '—') },
        { key: 'rangeFactorPlus', group: 'Range', label: 'Range+', sortValue: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES ? row.fielding.rangeFactorPlus : null), value: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES && row.fielding.rangeFactorPlus != null ? row.fielding.rangeFactorPlus : '—') },
        { key: 'rangeConfidence', group: 'Range', label: 'Rng Conf', sortValue: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES ? row.fielding.rangeConfidence : null), value: (row) => (row.fielding.rangeable >= MIN_RANGE_CHANCES && row.fielding.rangeConfidence != null ? `${row.fielding.rangeConfidence}%` : '—') },
        { key: 'oaaSamples', group: 'Outs Above Average', label: 'OAA Opp', sortValue: (row) => row.fielding.fieldingOpportunities, value: (row) => row.fielding.fieldingOpportunities ?? '—' },
        { key: 'actualOuts', group: 'Outs Above Average', label: 'Actual Outs', sortValue: (row) => row.fielding.actualOuts, value: (row) => row.fielding.fieldingOpportunities ? row.fielding.actualOuts : '—' },
        { key: 'expectedOuts', group: 'Outs Above Average', label: 'Expected Outs', sortValue: (row) => row.fielding.fieldingOpportunities ? row.fielding.expectedOuts : null, value: (row) => row.fielding.fieldingOpportunities ? formatDecimal(row.fielding.expectedOuts, 2) : '—' },
        { key: 'oaa', group: 'Outs Above Average', label: 'OAA', sortValue: (row) => row.fielding.fieldingOpportunities ? row.fielding.outsAboveAverage : null, value: (row) => row.fielding.fieldingOpportunities ? formatSignedAverageStyle(row.fielding.outsAboveAverage, 2) : '—' },
        { key: 'frv', group: 'Outs Above Average', label: 'FRV', sortValue: (row) => row.fielding.fieldingRunValue, value: (row) => row.fielding.fieldingRunValue != null ? formatSignedAverageStyle(row.fielding.fieldingRunValue, 2) : '—' },
        directionalOaa('oaaBackLeft', 'back_left', 'Back-L OAA'),
        directionalOaa('oaaBack', 'back', 'Back OAA'),
        directionalOaa('oaaBackRight', 'back_right', 'Back-R OAA'),
        directionalOaa('oaaInLeft', 'in_left', 'In-L OAA'),
        directionalOaa('oaaIn', 'in', 'In OAA'),
        directionalOaa('oaaInRight', 'in_right', 'In-R OAA'),
      ],
      'fielding.arm': [
        { key: 'trackedThrows', group: 'Throws', label: 'Throws', sortValue: (row) => row.fielding.throws, value: (row) => row.fielding.throws ?? '—' },
        { key: 'armStrength', group: 'Throws', label: 'Arm Strength', sortValue: (row) => row.fielding.armStrengthMph, value: (row) => row.fielding.armStrengthMph != null ? `${formatDecimal(row.fielding.armStrengthMph, 1)} mph` : '—' },
        { key: 'maxThrow', group: 'Throws', label: 'Max Throw', sortValue: (row) => row.fielding.hardestThrowMph, value: (row) => row.fielding.hardestThrowMph != null ? `${formatDecimal(row.fielding.hardestThrowMph, 1)} mph` : '—' },
        { key: 'buddyThrows', group: 'Buddy Throws', label: 'Buddy Throws', sortValue: (row) => row.fielding.buddyThrows, value: (row) => row.fielding.buddyThrows ?? '—' },
        { key: 'maxBuddyThrow', group: 'Buddy Throws', label: 'Max Buddy', sortValue: (row) => row.fielding.hardestBuddyThrowMph, value: (row) => row.fielding.hardestBuddyThrowMph != null ? `${formatDecimal(row.fielding.hardestBuddyThrowMph, 1)} mph` : '—' },
        { key: 'armOpportunities', group: 'Runners', label: 'Arm Opp', sortValue: (row) => row.fielding.armOpportunities, value: (row) => row.fielding.armOpportunities ?? '—' },
        { key: 'armHolds', group: 'Runners', label: 'Holds', sortValue: (row) => row.fielding.armHolds, value: (row) => row.fielding.armHolds || 0 },
        { key: 'armKills', group: 'Runners', label: 'Runner Outs', sortValue: (row) => row.fielding.armKills, value: (row) => row.fielding.armKills || 0 },
        { key: 'armAdvances', group: 'Runners', label: 'Adv Allowed', sortValue: (row) => row.fielding.armAdvances, value: (row) => row.fielding.armAdvances ?? '—' },
        { key: 'armValue', group: 'Runners', label: 'Arm Value', sortValue: (row) => row.fielding.armOpportunities ? row.fielding.armValue : null, value: (row) => row.fielding.armOpportunities ? formatSignedAverageStyle(row.fielding.armValue, 2) : '—' },
        { key: 'dpOpps', group: 'Double Plays', label: 'DP Opp', sortValue: (row) => row.fielding.doublePlayOpportunities, value: (row) => row.fielding.doublePlayOpportunities || 0 },
        { key: 'doublePlays', group: 'Double Plays', label: 'DP', sortValue: (row) => row.fielding.doublePlays, value: (row) => row.fielding.doublePlays || 0 },
        { key: 'dpAdded', group: 'Double Plays', label: 'DP Added', sortValue: (row) => row.fielding.doublePlayOpportunities ? row.fielding.doublePlaysAdded : null, value: (row) => row.fielding.doublePlayOpportunities ? formatSignedAverageStyle(row.fielding.doublePlaysAdded, 2) : '—' },
        { key: 'dpRuns', group: 'Double Plays', label: 'DP Runs', sortValue: (row) => row.fielding.doublePlayOpportunities ? row.fielding.doublePlayRuns : null, value: (row) => row.fielding.doublePlayOpportunities ? formatSignedAverageStyle(row.fielding.doublePlayRuns, 2) : '—' },
      ],
      'fielding.jump': [
        { key: 'jumpSamples', group: 'Jump', label: 'Jump Samples', sortValue: (row) => row.fielding.jumpSamples, value: (row) => row.fielding.jumpSamples ?? '—' },
        { key: 'jump', group: 'Jump', label: 'Jump', sortValue: (row) => row.fielding.jumpDistanceFeet, value: (row) => row.fielding.jumpDistanceFeet != null ? `${formatDecimal(row.fielding.jumpDistanceFeet, 1)} ft` : '—' },
        { key: 'jumpReaction', group: 'Jump', label: 'Reaction', sortValue: (row) => row.fielding.jumpReactionFeet, value: (row) => row.fielding.jumpReactionFeet == null ? '—' : `${formatDecimal(row.fielding.jumpReactionFeet, 1)} ft` },
        { key: 'jumpBurst', group: 'Jump', label: 'Burst', sortValue: (row) => row.fielding.jumpBurstFeet, value: (row) => row.fielding.jumpBurstFeet == null ? '—' : `${formatDecimal(row.fielding.jumpBurstFeet, 1)} ft` },
        { key: 'jumpRoute', group: 'Jump', label: 'Route Eff.', sortValue: (row) => row.fielding.jumpRouteEfficiency, value: (row) => row.fielding.jumpRouteEfficiency == null ? '—' : formatDecimal(row.fielding.jumpRouteEfficiency, 2) },
        { key: 'positionSamples', group: 'Positioning', label: 'Position Samples', sortValue: (row) => row.fielding.positioningSamples, value: (row) => row.fielding.positioningSamples ?? '—' },
        { key: 'positionDepth', group: 'Positioning', label: 'Depth', sortValue: (row) => row.fielding.averagePositionDepthFeet, value: (row) => row.fielding.averagePositionDepthFeet != null ? `${formatDecimal(row.fielding.averagePositionDepthFeet, 1)} ft` : '—' },
        { key: 'positionAngle', group: 'Positioning', label: 'Angle', sortValue: (row) => row.fielding.averagePositionAngleDeg, value: (row) => row.fielding.averagePositionAngleDeg != null ? `${formatDecimal(row.fielding.averagePositionAngleDeg, 1)}°` : '—' },
      ],
      'baserunning.extra': [
        { key: 'runs', group: 'Results', label: 'R', sortValue: (row) => row.batting.runs, value: (row) => row.batting.runs || 0 },
        xbtCount('opportunities', 'XBT Opp'), xbtCount('holds', 'XBT Holds'), xbtCount('attempts', 'XBT Att'), xbtCount('advances', 'XBT Safe'), xbtCount('outs', 'XBT Outs'),
        xbtRate('attemptRate', 'XBT Attempt %'), xbtRate('successRate', 'XBT Safe/Att'), xbtRate('safeRate', 'XBT Safe/Opp'),
        ...[
          ['first_to_third_on_single', '1st→3rd 1B'], ['second_to_home_on_single', '2nd→H 1B'],
          ['first_to_home_on_double', '1st→H 2B'], ['tag_first_to_second', 'Tag 1st→2nd'],
          ['tag_second_to_third', 'Tag 2nd→3rd'], ['tag_third_to_home', 'Tag 3rd→H'],
        ].map(([type, label]) => xbtSplit(type, label)),
        { key: 'modeled', group: 'Model', label: 'Modeled Opp', sortValue: (row) => row.baserunning.modeledOpportunities || 0, render: (row) => evidenceButton(row, 'modeledOpportunities', row.baserunning.modeledOpportunities || 0) },
        { key: 'modelCoverage', group: 'Model', label: 'Modeled %', sortValue: (row) => row.baserunning.modeledCoverage, value: (row) => row.baserunning.modeledCoverage == null ? '—' : formatPercent(row.baserunning.modeledCoverage, 1) },
        { key: 'rbaser', group: 'Model', label: 'Exp. Rbaser', sortValue: (row) => row.baserunning.baserunningRunValue, value: (row) => row.baserunning.baserunningRunValue == null ? '—' : formatSignedAverageStyle(row.baserunning.baserunningRunValue, 2) },
        // The runner's half of a close play. CP Won here is the ball knocked
        // loose, which is the same event as the fielder's CP Lost on the
        // Fielding line -- read from the other end.
        { key: 'closePlaysRun', group: 'Close Plays', label: 'CP', sortValue: (row) => row.baserunning.closePlaysRun, value: (row) => row.baserunning.closePlaysRun || 0 },
        { key: 'closePlaysRunWon', group: 'Close Plays', label: 'CP Won', sortValue: (row) => row.baserunning.closePlaysRunWon, value: (row) => row.baserunning.closePlaysRunWon || 0 },
        { key: 'closePlaysRunLost', group: 'Close Plays', label: 'CP Lost', sortValue: (row) => row.baserunning.closePlaysRunLost, value: (row) => row.baserunning.closePlaysRunLost || 0 },
      ],
      'baserunning.speed': [
        { key: 'speedSamples', group: 'Sprint', label: 'Speed Runs', sortValue: (row) => row.movement.speedSamples, value: (row) => row.movement.speedSamples || 0 },
        { key: 'sprintSpeed', group: 'Sprint', label: 'Sprint Speed', sortValue: (row) => row.movement.sprintSpeedFps, value: (row) => row.movement.sprintSpeedFps == null ? '—' : `${formatDecimal(row.movement.sprintSpeedFps * FEET_PER_SECOND_TO_MPH, 1)} mph` },
        { key: 'maxSprintSpeed', group: 'Sprint', label: 'Max Speed', sortValue: (row) => row.movement.maxSprintSpeedFps, value: (row) => row.movement.maxSprintSpeedFps == null ? '—' : `${formatDecimal(row.movement.maxSprintSpeedFps * FEET_PER_SECOND_TO_MPH, 1)} mph` },
        { key: 'bolts', group: 'Sprint', label: 'Bolts', sortValue: (row) => row.movement.speedSamples ? row.movement.bolts : null, value: (row) => row.movement.speedSamples ? row.movement.bolts : '—' },
        { key: 'homeToFirstSamples', group: 'Home to First', label: 'H→1 Samples', sortValue: (row) => row.movement.homeToFirstSamples, value: (row) => row.movement.homeToFirstSamples || 0 },
        { key: 'homeToFirst', group: 'Home to First', label: 'Home-to-First', sortValue: (row) => row.movement.homeToFirstSeconds == null ? null : -row.movement.homeToFirstSeconds, value: (row) => row.movement.homeToFirstSeconds == null ? '—' : `${formatDecimal(row.movement.homeToFirstSeconds, 2)} s` },
        { key: 'ninetySamples', group: '90 Feet', label: '90-ft Samples', sortValue: (row) => row.movement.ninetyFootSplitSamples, value: (row) => row.movement.ninetyFootSplitSamples || 0 },
        { key: 'ninetySplit', group: '90 Feet', label: '90-ft Split', sortValue: (row) => row.movement.ninetyFootSplitSeconds == null ? null : -row.movement.ninetyFootSplitSeconds, value: (row) => row.movement.ninetyFootSplitSeconds == null ? '—' : `${formatDecimal(row.movement.ninetyFootSplitSeconds, 2)} s` },
      ],
      'events.gimmick': [
        { key: 'luckScore', group: 'Gimmick Luck', label: 'Net', sortValue: (row) => row.gimmickLuck.luckScore, render: (row) => <ValueBadge color={getLuckColor(row.gimmickLuck.luckScore)} value={formatGimmickLuckScore(row.gimmickLuck.luckScore)} /> },
        { key: 'luckyEvents', group: 'Gimmick Luck', label: 'Lucky', sortValue: (row) => row.gimmickLuck.luckyEvents, value: (row) => row.gimmickLuck.luckyEvents },
        { key: 'unluckyEvents', group: 'Gimmick Luck', label: 'Unlucky', sortValue: (row) => row.gimmickLuck.unluckyEvents, value: (row) => row.gimmickLuck.unluckyEvents },
        { key: 'luckRuns', group: 'Stadium Runs', label: 'Runs', sortValue: (row) => (row.gimmickLuck.pricedPlays ? row.gimmickLuck.luckRuns : null), render: (row) => <ValueBadge color={getLuckColor(row.gimmickLuck.luckRuns)} value={formatGimmickLuckRuns(row.gimmickLuck.luckRuns, row.gimmickLuck.pricedPlays)} /> },
        { key: 'pricedPlays', group: 'Stadium Runs', label: 'Priced', sortValue: (row) => row.gimmickLuck.pricedPlays, value: (row) => row.gimmickLuck.pricedPlays },
        { key: 'totalEvents', group: 'Exposure', label: 'Touches', sortValue: (row) => row.gimmickLuck.totalEvents, value: (row) => row.gimmickLuck.totalEvents },
        { key: 'affectedPlays', group: 'Exposure', label: 'Plays', sortValue: (row) => row.gimmickLuck.affectedPlays, value: (row) => row.gimmickLuck.affectedPlays },
        { key: 'gimmickTypes', group: 'Evidence', label: 'Detected gimmicks', sortValue: (row) => row.gimmickLuck.gimmickTypes.length, value: (row) => row.gimmickLuck.gimmickTypes.join(', ') || '-' },
      ],
    }
  }, [locationDisplayMode])

  const columnsForSet = useCallback((setKey, identity) => {
    const metrics = (metricsBySet[setKey] || []).filter((column) => !column.only || column.only === identity)
    if (identity === 'players') return [playerIdentityCol, ...metrics]
    return [charIdentityCol, ...metrics, ...(findStatsSet(setKey)?.owner ? [ownerCol] : [])]
  }, [charIdentityCol, metricsBySet, ownerCol, playerIdentityCol])

  const rowsForSet = useCallback((setKey, identity) => {
    const set = findStatsSet(setKey)
    const rows = identity === 'players' ? playerRows : characterRows
    const include = ROW_FILTERS[set?.rows]
    return include ? rows.filter(include) : rows
  }, [characterRows, playerRows])

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

  // Finding one of ~50 characters (or one team) in a wide table meant scrolling the whole
  // thing. Matching is on the full name and on the abbreviated form the identity cell shows, so
  // typing what you can see works.
  const matchesOverviewFilter = useCallback(
    (name) => matchesNameFilter(name, overviewFilter),
    [overviewFilter],
  )

  const activeSection = STATS_SECTIONS.find((entry) => entry.id === section) || STATS_SECTIONS[0]
  const activeSet = activeSection.sets.find((entry) => entry.id === setBySection[activeSection.id]) || activeSection.sets[0] || null
  const activeSetKey = activeSet ? `${activeSection.id}.${activeSet.id}` : null
  const activeSortKey = `${tab}:${activeSetKey}`
  const activeSort = sorts[activeSortKey] || activeSet?.defaultSort || DEFAULT_SORT
  const activeColumns = useMemo(
    () => (activeSet?.table ? columnsForSet(activeSetKey, tab) : []),
    [activeSet, activeSetKey, columnsForSet, tab],
  )
  const activeRows = useMemo(
    () => (activeSet?.table ? rowsForSet(activeSetKey, tab) : []),
    [activeSet, activeSetKey, rowsForSet, tab],
  )
  const filteredActiveRows = useMemo(() => (
    activeSet?.filterable
      ? activeRows.filter((row) => matchesOverviewFilter(tab === 'players' ? (teamRowLabel(row.playerId) || row.name) : row.name))
      : activeRows
  ), [activeRows, activeSet, matchesOverviewFilter, tab, teamRowLabel])
  const sortedActiveRows = useMemo(
    () => sortRows(filteredActiveRows, activeColumns, activeSort),
    [filteredActiveRows, activeColumns, activeSort],
  )

  // On a phone the tab strip scrolls sideways, and a remembered tab can sit off-screen with
  // nothing showing which table is open.
  const setTabsRef = useRef(null)
  useEffect(() => {
    setTabsRef.current?.querySelector('.stats-set-tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeSetKey])

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    next.set('view', tab)
    next.set('section', activeSection.id)
    if (activeSet) next.set('set', activeSet.id)
    else next.delete('set')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [activeSection.id, activeSet, searchParams, setSearchParams, tab])

  const selectSet = useCallback((sectionId, setId) => {
    setSetBySection((current) => ({ ...current, [sectionId]: setId }))
  }, [])

  const toggleActiveSort = (column) => {
    setSorts((current) => {
      const now = current[activeSortKey] || activeSet?.defaultSort || DEFAULT_SORT
      const next = now.key === column.key
        ? { key: column.key, direction: now.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, direction: column.type === 'string' ? 'asc' : (column.defaultDirection || 'desc') }
      return { ...current, [activeSortKey]: next }
    })
  }

  const openLeaderTable = useCallback((setKey, sort) => {
    const [sectionId, setId] = setKey.split('.')
    setSection(sectionId)
    selectSet(sectionId, setId)
    if (sort) setSorts((current) => ({ ...current, [`${tab}:${setKey}`]: sort }))
    window.scrollTo({ top: 0 })
  }, [selectSet, tab])

  const leaderCards = useMemo(() => {
    if (section !== 'leaders') return []
    const identityCol = tab === 'players' ? playerIdentityCol : charIdentityCol
    return LEADER_CARDS.map((card) => ({
      ...card,
      stats: card.stats.map((stat) => {
        if (stat.war) {
          const warRows = (experimentalWar[tab] || [])
            .filter((row) => Number.isFinite(row.war))
            .sort((a, b) => b.war - a.war)
            .slice(0, 5)
          return {
            id: 'war',
            label: 'Exp. WAR',
            onOpen: () => openLeaderTable('value.war'),
            leaders: warRows.map((row) => ({
              key: row.id,
              identity: tab === 'players'
                ? <PlayerTag height={STATS_PLAYER_TAG_HEIGHT} identitiesByPlayerId={identitiesByPlayerId} playerId={row.id} playersById={playersById} responsiveAbbreviation />
                : <CharacterCell name={charactersById[row.id]?.name || row.id} to={characterPathFor(row.id)} />,
              value: row.war.toFixed(2),
            })),
          }
        }
        const columns = columnsForSet(stat.set, tab)
        const column = columns.find((entry) => entry.key === stat.key)
        const sort = { key: stat.key, direction: stat.direction || 'desc' }
        const leaders = sortRows(rowsForSet(stat.set, tab), columns, sort)
          .filter((row) => {
            const value = column.sortValue(row)
            if (value == null || !Number.isFinite(Number(value))) return false
            if (stat.positive && !(value > 0)) return false
            return stat.qualify ? stat.qualify(row) : true
          })
          .slice(0, 5)
        return {
          id: `${stat.set}.${stat.key}`,
          label: column.label,
          onOpen: () => openLeaderTable(stat.set, sort),
          leaders: leaders.map((row) => ({
            key: tab === 'players' ? row.playerId : row.id,
            identity: identityCol.render(row),
            value: column.render ? column.render(row) : column.value(row),
          })),
        }
      }),
    }))
  }, [section, tab, playerIdentityCol, charIdentityCol, experimentalWar, openLeaderTable, identitiesByPlayerId, playersById, charactersById, characterPathFor, columnsForSet, rowsForSet])

  const playerRowsWithBatting = useMemo(() => playerRows.filter(hasBattingData), [playerRows])
  const sprayChartCountsByTeam = useMemo(() => {
    const counts = new Map()
    filteredPasWithCharacterNames.forEach((pa) => {
      if (!qualifiesForSprayChart(pa) || pa.player_id == null) return
      const key = String(pa.player_id)
      counts.set(key, (counts.get(key) || 0) + 1)
    })
    return counts
  }, [filteredPasWithCharacterNames])
  const totalSprayChartCount = useMemo(
    () => [...sprayChartCountsByTeam.values()].reduce((sum, count) => sum + count, 0),
    [sprayChartCountsByTeam],
  )
  const sprayChartTeamOptions = useMemo(
    () => playerRowsWithBatting
      .map((row) => ({
        playerId: String(row.playerId),
        name: row.name,
        chartCount: sprayChartCountsByTeam.get(String(row.playerId)) || 0,
      }))
      .filter((row) => row.chartCount > 0)
      .sort((a, b) => b.chartCount - a.chartCount || a.name.localeCompare(b.name)),
    [playerRowsWithBatting, sprayChartCountsByTeam],
  )
  const activeSprayChartTeamId = sprayChartTeamOptions.some((row) => row.playerId === String(selectedSprayChartTeamId))
    ? String(selectedSprayChartTeamId)
    : ALL_TEAMS_SPRAY_FILTER
  const filteredSprayChartPas = useMemo(
    () => (
      activeSprayChartTeamId === ALL_TEAMS_SPRAY_FILTER
        ? filteredPasWithCharacterNames
        : filteredPasWithCharacterNames.filter((pa) => String(pa.player_id) === activeSprayChartTeamId)
    ),
    [activeSprayChartTeamId, filteredPasWithCharacterNames],
  )

  const sortedBpBattingPlayer = useMemo(() => sortRows(ballparkPlayerBattingRows, bpBattingPlayerCols, bpBattingPlayerSort, 'name'), [ballparkPlayerBattingRows, bpBattingPlayerCols, bpBattingPlayerSort])
  const sortedBpBattingChar = useMemo(() => sortRows(ballparkCharacterBattingRows, bpBattingCharCols, bpBattingCharacterSort, 'name'), [ballparkCharacterBattingRows, bpBattingCharCols, bpBattingCharacterSort])
  const sortedBpPitchingPlayer = useMemo(() => sortRows(ballparkPlayerPitchingRows, bpPitchingPlayerCols, bpPitchingPlayerSort, 'name'), [ballparkPlayerPitchingRows, bpPitchingPlayerCols, bpPitchingPlayerSort])
  const sortedBpPitchingChar = useMemo(() => sortRows(ballparkCharacterPitchingRows, bpPitchingCharCols, bpPitchingCharacterSort, 'name'), [ballparkCharacterPitchingRows, bpPitchingCharCols, bpPitchingCharacterSort])
  const sortedBpFactorsTeam = useMemo(() => sortRows(teamParkFactorRows, bpFactorsTeamCols, bpFactorsTeamSort, 'name'), [teamParkFactorRows, bpFactorsTeamCols, bpFactorsTeamSort])
  const sortedBpFactorsChar = useMemo(() => sortRows(charParkFactorRows, bpFactorsCharCols, bpFactorsCharSort, 'name'), [charParkFactorRows, bpFactorsCharCols, bpFactorsCharSort])
  const sortedBpFactorsPitTeam = useMemo(() => sortRows(teamParkFactorRows.filter((r) => r.parkIp > 0), bpFactorsPitTeamCols, bpFactorsPitTeamSort, 'name'), [teamParkFactorRows, bpFactorsPitTeamCols, bpFactorsPitTeamSort])
  const sortedBpFactorsPitChar = useMemo(() => sortRows(charParkFactorRows.filter((r) => r.parkIp > 0), bpFactorsPitCharCols, bpFactorsPitCharSort, 'name'), [charParkFactorRows, bpFactorsPitCharCols, bpFactorsPitCharSort])

  // Nothing has arrived yet: show the load/error state on its own rather than a rail wrapped
  // around 40 columns of "no stats found".
  const hasAnyLoadedData = players.length > 0 || characters.length > 0
  if (loadStatus === 'loading' && !hasAnyLoadedData) {
    return (
      <div className="page-stack">
        <StatusPanel title="Loading stats…">
          Reading plate appearances, pitching, fielding and tracking tables for every season and tournament.
        </StatusPanel>
      </div>
    )
  }

  if (loadStatus === 'error' && !hasAnyLoadedData) {
    return (
      <div className="page-stack">
        <StatusPanel
          actions={(
            <button className="entity-status-button entity-status-button-primary" onClick={() => setReloadToken((token) => token + 1)} type="button">
              Retry
            </button>
          )}
          title="Couldn't load stats"
          variant="error"
        >
          {loadError || 'The stats queries failed.'} Nothing below would be accurate, so no tables are shown.
        </StatusPanel>
      </div>
    )
  }

  return (
    <div className="page-stack">
      {loadStatus === 'error' && hasAnyLoadedData ? (
        <div className="entity-stale-banner" role="status">
          <span>Showing the last loaded stats — a refresh failed{loadError ? `: ${loadError}` : '.'}</span>
          <button className="entity-status-button" onClick={() => setReloadToken((token) => token + 1)} type="button">Retry</button>
        </div>
      ) : null}
      <div className="stats-shell">
        <nav className="stats-rail">
          <select
            className="stats-rail-scope-select"
            onChange={(event) => {
              const value = event.target.value
              if (value === 'all') {
                setSourceMode('all')
              } else if (value.startsWith('tournament-')) {
                setSourceMode('tournaments')
                setSelectedTournamentId(value.slice('tournament-'.length))
              } else if (value.startsWith('season-')) {
                setSourceMode('seasons')
                setSelectedSeasonId(value.slice('season-'.length))
              }
            }}
            value={isCombinedView ? 'all' : sourceMode === 'tournaments' ? `tournament-${selectedTournamentValue}` : `season-${selectedSeasonValue}`}
          >
            <option value="all">All Stats</option>
            <optgroup label="Seasons">
              {seasons.map((season) => (
                <option key={season.id} value={`season-${season.id}`}>
                  {isCompact ? abbreviateScopeLabel('MSL', season.name) : season.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Tournaments">
              {tournaments.map((tournament) => (
                <option key={tournament.id} value={`tournament-${tournament.id}`}>
                  {isCompact ? `MST ${tournament.tournament_number}` : `Tournament ${tournament.tournament_number}`}
                </option>
              ))}
            </optgroup>
          </select>
          <div className="stats-rail-toggle">
            <button className={`stats-rail-toggle-btn ${tab === 'players' ? 'stats-rail-toggle-btn-active' : ''}`} onClick={() => setTab('players')} type="button">Players</button>
            <button className={`stats-rail-toggle-btn ${tab === 'characters' ? 'stats-rail-toggle-btn-active' : ''}`} onClick={() => setTab('characters')} type="button">Characters</button>
          </div>
          {isCompact ? (
            <div className="stats-rail-mobile-controls">
              <select
                aria-label="Stats section"
                className="stats-rail-scope-select"
                onChange={(event) => setSection(event.target.value)}
                value={activeSection.id}
              >
                {STATS_SECTIONS.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </div>
          ) : (
            RAIL_GROUPS.map((sectionIds) => (
              <div className="stats-rail-group" key={sectionIds[0]}>
                {sectionIds.map((sectionId) => {
                  const entry = STATS_SECTIONS.find((candidate) => candidate.id === sectionId)
                  const isActive = activeSection.id === sectionId
                  return (
                    <button
                      aria-current={isActive ? 'page' : undefined}
                      className={`stats-rail-item ${isActive ? 'stats-rail-item-active' : ''}`}
                      key={sectionId}
                      onClick={() => setSection(sectionId)}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </nav>

        <div className="stats-main">
          <header className="stats-section-head">
            <h2 className="stats-section-title">{activeSection.label}</h2>
            {activeSection.sets.length > 1 ? (
              <div className="stats-set-tabs" ref={setTabsRef}>
                {activeSection.sets.map((entry) => {
                  const isActive = entry.id === activeSet?.id
                  return (
                    <button
                      aria-label={entry.label}
                      aria-pressed={isActive}
                      className={`stats-set-tab ${isActive ? 'stats-set-tab-active' : ''}`}
                      key={entry.id}
                      onClick={() => selectSet(activeSection.id, entry.id)}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </header>

      {section === 'leaders' ? <LeadersPanel cards={leaderCards} /> : null}
      {activeSetKey === 'value.war' ? <ExperimentalWarPanel model={experimentalWar} identity={tab} players={players} characters={characters} /> : null}
      {activeSetKey === 'value.user' ? <UserValuePanel model={userValue} identity={tab} players={players} characters={characters} /> : null}
      {activeSetKey === 'events.stadium' || activeSetKey === 'events.mechanics' ? (
        <FinalStatEventsPanel
          charactersById={charactersById}
          identity={tab === 'players' ? 'player' : 'character'}
          key={activeSetKey}
          kind={activeSetKey === 'events.mechanics' ? 'mechanics' : 'stadium'}
          plays={filteredAdvanced.plays}
          playersById={playersById}
        />
      ) : null}

      {activeSet?.table ? (
        <section className="table-card">
          {activeSet.view === 'spray' ? (
            <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setSelectedSprayChartTeamId(ALL_TEAMS_SPRAY_FILTER)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.18)',
                    background: activeSprayChartTeamId === ALL_TEAMS_SPRAY_FILTER ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)',
                    color: activeSprayChartTeamId === ALL_TEAMS_SPRAY_FILTER ? '#FDE68A' : '#94A3B8',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  All Teams ({totalSprayChartCount})
                </button>
                {sprayChartTeamOptions.map((team) => {
                  const isActive = activeSprayChartTeamId === team.playerId
                  return (
                    <button
                      key={team.playerId}
                      type="button"
                      onClick={() => setSelectedSprayChartTeamId(team.playerId)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 12px',
                        borderRadius: 999,
                        border: '1px solid rgba(255,255,255,0.18)',
                        background: isActive ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)',
                        color: isActive ? '#FDE68A' : '#CBD5E1',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      <PlayerTag
                        height={20}
                        identitiesByPlayerId={identitiesByPlayerId}
                        playerId={team.playerId}
                        playersById={playersById}
                        textStyle={{ fontSize: 12, fontWeight: 700 }}
                      />
                      <span style={{ color: isActive ? '#FDE68A' : '#94A3B8' }}>({team.chartCount})</span>
                    </button>
                  )
                })}
              </div>
              <VectorSprayChart plateAppearances={filteredSprayChartPas} showCharacterName />
            </div>
          ) : null}
          {activeSet.rateToggle ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>{activeSet.rateToggle}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[['pct', '%'], ['count', '#']].map(([mode, symbol]) => (
                  <button
                    aria-pressed={locationDisplayMode === mode}
                    key={mode}
                    onClick={() => setLocationDisplayMode(mode)}
                    style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', background: locationDisplayMode === mode ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)', color: locationDisplayMode === mode ? '#FDE68A' : '#94A3B8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
                    type="button"
                  >{symbol}</button>
                ))}
              </div>
            </div>
          ) : null}
          {activeSet.filterable ? (
            <OverviewFilterBar
              label={tab === 'players' ? 'Filter teams' : 'Filter characters'}
              matches={sortedActiveRows.length}
              onChange={setOverviewFilter}
              total={activeRows.length}
              value={overviewFilter}
            />
          ) : null}
          <SortableStatsTable
            columns={activeColumns}
            emptyMessage={activeSet.filterable && overviewFilter.trim()
              ? `No ${tab === 'players' ? 'teams' : 'characters'} match "${overviewFilter.trim()}".`
              : (activeSet.emptyMessage || 'No stats recorded for this table in this scope yet.')}
            onRowClick={tab === 'players' ? (row) => openTeamPage(row.playerId) : (row) => openCharacterPage(row.id)}
            onSort={toggleActiveSort}
            rowKey={tab === 'players' ? (row) => row.playerId : (row) => row.id}
            rowLabel={tab === 'players' ? (row) => teamRowLabel(row.playerId) : (row) => row.name}
            rows={sortedActiveRows}
            sortState={activeSort}
          />
          {activeSetKey === 'baserunning.extra' && baseEvidence?.identity === (tab === 'players' ? 'player' : 'character') ? (
            <BaserunningEvidencePanel selection={baseEvidence} opportunities={filteredAdvanced.runners} trackingPlays={filteredAdvanced.plays} onClose={() => setBaseEvidence(null)} />
          ) : null}
          {activeSet.filterable && sortedActiveRows.length > 0 ? <StatFallbackLegend note={activeSet.legendNote || null} /> : null}
        </section>
      ) : null}

      {section === 'ballparks' ? (
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

          <section className="table-card">
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className={`tab-button ${ballparkSubView === 'batting' ? 'tab-button-active' : ''}`} onClick={() => setBallparkSubView('batting')} type="button">Batting</button>
                  <button className={`tab-button ${ballparkSubView === 'pitching' ? 'tab-button-active' : ''}`} onClick={() => setBallparkSubView('pitching')} type="button">Pitching</button>
                  <button className={`tab-button ${ballparkSubView === 'spray_charts' ? 'tab-button-active' : ''}`} onClick={() => setBallparkSubView('spray_charts')} type="button">Spray Charts</button>
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
                <SortableStatsTable columns={bpBattingPlayerCols} emptyMessage="No batting data at this stadium." onRowClick={(row) => openTeamPage(row.playerId)} rowLabel={(row) => teamRowLabel(row.playerId)} onSort={(col) => toggleSort(setBpBattingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBpBattingPlayer} sortState={bpBattingPlayerSort} />
              ) : (
                <SortableStatsTable columns={bpBattingCharCols} emptyMessage="No batting data at this stadium." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpBattingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBpBattingChar} sortState={bpBattingCharacterSort} />
              )
            ) : null}

            {ballparkSubView === 'pitching' ? (
              tab === 'players' ? (
                <SortableStatsTable columns={bpPitchingPlayerCols} emptyMessage="No pitching data at this stadium." onRowClick={(row) => openTeamPage(row.playerId)} rowLabel={(row) => teamRowLabel(row.playerId)} onSort={(col) => toggleSort(setBpPitchingPlayerSort, col)} rowKey={(row) => row.playerId} rows={sortedBpPitchingPlayer} sortState={bpPitchingPlayerSort} />
              ) : (
                <SortableStatsTable columns={bpPitchingCharCols} emptyMessage="No pitching data at this stadium." onRowClick={(row) => openCharacterPage(row.id)} onSort={(col) => toggleSort(setBpPitchingCharacterSort, col)} rowKey={(row) => row.id} rows={sortedBpPitchingChar} sortState={bpPitchingCharacterSort} />
              )
            ) : null}

            {ballparkSubView === 'spray_charts' ? (
              selectedStadiumKey && !STADIUM_NAME_TO_KEY[selectedStadiumKey] ? (
                <p className="muted" style={{ padding: '1rem 0' }}>Select a stadium above to see its spray chart.</p>
              ) : (
                <VectorSprayChart
                  key={selectedStadiumKey ? STADIUM_NAME_TO_KEY[selectedStadiumKey] : 'all-stadiums'}
                  plateAppearances={selectedStadiumSprayChartPas}
                  initialStadiumKey={selectedStadiumKey ? STADIUM_NAME_TO_KEY[selectedStadiumKey] : null}
                  showCharacterName
                />
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
                              { key: 'hardHit', label: 'Hard-Hit Rate' },
                              { key: 'barrel', label: 'Barrel Rate' },
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
                            <SortableStatsTable columns={bpFactorsTeamCols} emptyMessage="Not enough data yet (min 3 PA per team)." onRowClick={(row) => openTeamPage(row.playerId)} rowLabel={(row) => teamRowLabel(row.playerId)} onSort={(col) => toggleSort(setBpFactorsTeamSort, col)} rowKey={(row) => row.playerId} rows={sortedBpFactorsTeam} sortState={bpFactorsTeamSort} />
                          </>
                        ) : (
                          <>
                            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each team&apos;s pitching stats at this park vs. their overall stats. ERA/WHIP Δ: green = performed better at this park (lower ERA/WHIP).</p>
                            <SortableStatsTable columns={bpFactorsPitTeamCols} emptyMessage="No pitching data at this park." onRowClick={(row) => openTeamPage(row.playerId)} rowLabel={(row) => teamRowLabel(row.playerId)} onSort={(col) => toggleSort(setBpFactorsPitTeamSort, col)} rowKey={(row) => row.playerId} rows={sortedBpFactorsPitTeam} sortState={bpFactorsPitTeamSort} />
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
    </div>
  )
}
