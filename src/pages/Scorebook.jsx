import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, Moon, RotateCcw, RotateCw, Sun, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { fetchTeamLineup, upsertTeamLineup, TOURNAMENT_TEAM_LINEUPS, SEASON_TEAM_LINEUPS } from '../utils/teamLineups'
import { useGameSession } from '../context/GameSessionContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { useAuth } from '../context/AuthContext'
import { calculateOutsForPa, getCreditedRbiForPa, inningsPitchedFromOuts, normalizeRbiForPaResult, summarizeBatting, summarizePitching } from '../utils/statsCalculator'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import CharacterDetailModal from '../components/CharacterDetailModal'
import TeamLogo from '../components/TeamLogo'
import FieldPlayBuilder from '../components/FieldPlayBuilder'
import { DraggableRosterItem, FieldingView, FIELD_ID_TO_SCOREBOOK_POSITION, FIELD_POSITIONS, SCOREBOOK_POSITION_TO_FIELD_ID } from '../components/RosterLineupWidgets'
import { buildChemistryHighlightSet } from '../utils/chemistryHighlights'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import usePitchCount from '../hooks/usePitchCount'
import { assembleErrorNotation, assembleNotation } from '../utils/notation'
import { buildBettingEntityLabel, estimateLiveWinProbability, generateGameOdds, mergeOddsWithExistingRows, recalculateOdds } from '../utils/oddsEngine'
import { buildOddsGenerationContext as buildSharedOddsGenerationContext } from '../utils/oddsContext'
import { persistOddsRowsWithFallback } from '../utils/oddsPersistence'
import { formatPlateAppearanceResult } from '../utils/plateAppearance'
import { resolveFirstInningNoRun, reopenGameBets, resolveGameBets, resolveOnPA } from '../utils/betResolution'
import { advanceBracketOnGameComplete, reopenBracketAfterGameEdit } from '../utils/bracketProgression'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'
import { DEFAULT_REGULATION_INNINGS, getFinalStatusLabel, normalizeRegulationInnings } from '../utils/gameRules'
import {
  getOrderedStadiums,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
  normalizeIsNightForStadium,
  stadiumTimeToggleDisabled,
} from '../utils/stadiums'

// ─── Style constants ──────────────────────────────────────────────────────────
const C = {
  bg: '#0F172A', card: '#1E293B', border: '#334155',
  accent: '#EAB308', green: '#22C55E', red: '#EF4444',
  blue: '#3B82F6', text: '#FFFFFF', muted: '#94A3B8',
}

function StadiumLogo({ name, height = 56 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        ...getStadiumSpriteStyle(name, {
          width: '100%',
          height,
        }),
      }}
    />
  )
}

function StadiumHeaderPill({ stadium, isNight }) {
  if (!stadium) return null
  const timeLabel = getStadiumTimeLabel(stadium, isNight)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}CC`, maxWidth: '100%' }}>
      <div style={{ width: 74, flexShrink: 0 }}>
        <StadiumLogo name={stadium.name} height={28} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{stadium.name}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
        {timeLabel === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
        {timeLabel}
      </span>
    </div>
  )
}

const HIT_RESULTS  = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const WALK_RESULTS = new Set(['BB', 'HBP'])
const CONTACT_RESULTS = new Set(['foul', 'in_play'])
// Results that need runner-resolution panel (only when runners are on base)
const NEEDS_RESOLUTION = new Set(['1B', '2B', '3B'])
const TRAJECTORY_OPTIONS = [
  { value: 'L', label: 'L — Line Drive' },
  { value: 'G', label: 'G — Ground Ball' },
  { value: 'F', label: 'F — Fly Ball' },
  { value: 'B', label: 'B — Bloop' },
]
const IN_PLAY_OUT_OPTIONS = ['GO', 'FO', 'LO', 'SF', 'SH', 'FC']
const IN_PLAY_HIT_OPTIONS = [
  { value: '1B', label: '1B' },
  { value: '2B', label: '2B' },
  { value: '3B', label: '3B' },
  { value: 'HR', label: 'HR' },
  { value: 'IPHR', label: 'IPHR' },
]
// Unified "ball in play" outcome grid — every selectable result in one screen,
// color-coded by outcome family, so the scorer picks the real result in one tap
// instead of choosing Hit/Out/Error and then drilling into a sub-menu.
const IN_PLAY_RESULT_OPTIONS = [
  ...IN_PLAY_HIT_OPTIONS.map((option) => ({ ...option, resultType: 'hit', zone: 'green' })),
  ...IN_PLAY_OUT_OPTIONS.map((value) => ({ value, label: value, resultType: 'out', zone: 'red' })),
  { value: 'ROE', label: 'E', resultType: 'error', zone: 'blue' },
]
const OVER_THE_FENCE_HR_TRAJECTORIES = new Set(['L', 'F'])
const OVER_THE_FENCE_HR_POSITIONS = ['7', '8', '9']
const TWO_OUT_DISABLED_RESULTS = new Set(['SF', 'SH'])
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
const TRAJECTORY_LABELS = {
  L: 'Line Drive',
  G: 'Ground Ball',
  F: 'Fly Ball',
  B: 'Bloop',
}

const OUTCOME_BUTTONS = [
  { result: '1B', zone: 'green' }, { result: '2B', zone: 'green' },
  { result: '3B', zone: 'green' }, { result: 'HR',  zone: 'green' }, { result: 'IPHR', zone: 'green' },
  { result: 'K',  zone: 'red'   }, { result: 'GO',  zone: 'red'   },
  { result: 'FO', zone: 'red'   }, { result: 'LO',  zone: 'red'   },
  { result: 'BB', zone: 'blue'  }, { result: 'HBP', zone: 'blue'  },
  { result: 'SF',  zone: 'blue'  }, { result: 'SH',  zone: 'blue'  },
  { result: 'FC',  zone: 'blue'  },
]
const ZONE_COLOR = { green: C.green, red: C.red, blue: C.blue }

function stripDbManagedFields(row = {}) {
  const next = { ...row }
  delete next.id
  delete next.created_at
  return next
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

function deriveOffense(game, outsRecorded) {
  const halfInning = Math.floor(outsRecorded / 3)
  const isTop = halfInning % 2 === 0
  const inning = Math.floor(halfInning / 2) + 1
  // `home_away_swapped` flips which team bats in the top vs bottom of the inning
  // (i.e. who's "away"/"home") without touching team_a/team_b assignments.
  const awayPlayerId = game.home_away_swapped ? game.team_b_player_id : game.team_a_player_id
  const homePlayerId = game.home_away_swapped ? game.team_a_player_id : game.team_b_player_id
  return {
    battingPlayerId:  isTop ? awayPlayerId : homePlayerId,
    pitchingPlayerId: isTop ? homePlayerId : awayPlayerId,
    inning, isTop, halfLabel: `${isTop ? 'Top' : 'Bot'} ${inning}`,
  }
}

function getPaScoringRuns(pa = {}, runsByPaId = {}) {
  const trackedRuns = runsByPaId[String(pa.id)] || []
  if (trackedRuns.length) return trackedRuns.length
  return Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0)
}

function runsThisHalfFromPAs(pas, playerId, inning, runs = []) {
  if (runs.length) {
    return runs.filter((run) => (
      String(run.scoring_player_id) === String(playerId)
      && Number(run.inning || 1) === Number(inning || 1)
    )).length
  }
  return pas
    .filter((pa) => String(pa.player_id) === String(playerId) && Number(pa.inning || 1) === Number(inning || 1))
    .reduce((sum, pa) => sum + getPaScoringRuns(pa), 0)
}

function runsFromPAs(pas, playerId, runs = []) {
  if (runs.length) {
    return runs.filter((run) => String(run.scoring_player_id) === String(playerId)).length
  }
  return pas.filter(pa => pa.player_id === playerId)
    .reduce((s, pa) => s + getPaScoringRuns(pa), 0)
}
function hitsFromPAs(pas, playerId) {
  return pas.filter(pa => pa.player_id === playerId && HIT_RESULTS.has(pa.result)).length
}
function errorsFromPAs(pas, playerId, opponentPlayerId) {
  return pas.filter((pa) => pa.is_error && String(pa.player_id) === String(opponentPlayerId)).length
}
function inningRunsFromPAs(pas, playerId, runs = []) {
  const map = {}
  if (runs.length) {
    runs
      .filter((run) => String(run.scoring_player_id) === String(playerId))
      .forEach((run) => {
        const inning = Number(run.inning || 1)
        map[inning] = (map[inning] || 0) + 1
      })
    return map
  }
  pas.filter(pa => pa.player_id === playerId).forEach(pa => {
    map[pa.inning] = (map[pa.inning] || 0) + getPaScoringRuns(pa)
  })
  return map
}

function formatBaseballAverage(summary = {}) {
  const avg = Number(summary.atBats || 0) > 0 ? Number(summary.avg || 0) : 0
  const formatted = avg.toFixed(3)
  return avg < 1 ? formatted.replace(/^0/, '') : formatted
}

function formatHitsAtBats(summary = {}) {
  return `${Number(summary.hits || 0)}-${Number(summary.atBats || 0)}`
}

function getLineScoreCellValue({ inning, side, scoreMap = {}, completedHalfCount = 0 }) {
  const inningRuns = scoreMap[inning]
  if (inningRuns != null) return inningRuns
  const halfIndex = (inning - 1) * 2 + (side === 'home' ? 1 : 0)
  return halfIndex < completedHalfCount ? 0 : '-'
}

function formatGameStatusLabel(game, status, halfLabel = '', regulationInnings = DEFAULT_REGULATION_INNINGS) {
  if (status === 'complete') return getFinalStatusLabel(game, regulationInnings)
  if (status === 'active') return halfLabel || 'Live'
  if (status === 'pending') return 'Pregame'
  return status || 'Game'
}

function describeHitLocation(pa = {}) {
  const position = Number(pa.hit_location || pa.error_position || 0)
  const trajectory = String(pa.trajectory || '').toUpperCase()

  if (!position) return ''

  const infieldSpot = {
    1: 'pitcher',
    2: 'catcher',
    3: 'first',
    4: 'second',
    5: 'third',
    6: 'short',
  }
  const outfieldSpot = {
    7: 'left field',
    8: 'center field',
    9: 'right field',
  }

  if (trajectory === 'G') {
    if (position >= 7) return `on the ground to ${outfieldSpot[position] || 'the outfield'}`
    return `to ${infieldSpot[position] || 'the infield'}`
  }
  if (trajectory === 'L') {
    return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
  }
  if (trajectory === 'B') {
    return `to shallow ${outfieldSpot[position] || 'outfield'}`
  }
  if (trajectory === 'F') {
    return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
  }

  return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
}

function formatPlayResultText(pa = {}) {
  const location = describeHitLocation(pa)
  const suffix = location ? ` ${location}` : ''
  switch (pa.result) {
    case '1B': return `singled${suffix}`
    case '2B': return `doubled${suffix}`
    case '3B': return `tripled${suffix}`
    case 'HR': return `homered${suffix}`
    case 'IPHR': return `hit an inside-the-park homer${suffix}`
    case 'BB': return 'walked'
    case 'HBP': return 'was hit by a pitch'
    case 'SF': return `lifted a sac fly${suffix}`
    case 'SH': return `dropped a sac bunt${suffix}`
    case 'FC': return `reached on a fielder's choice${suffix}`
    case 'ROE': return `reached on an error${suffix}`
    case 'K':
      if (pa.strikeout_type === 'KL') return 'struck out looking'
      if (pa.strikeout_type === 'KS') return 'struck out swinging'
      return 'struck out'
    case 'DP': return `grounded into a double play${suffix}`
    case 'TP': return `grounded into a triple play${suffix}`
    case 'GO': return `grounded out${suffix}`
    case 'FO': return `flied out${suffix}`
    case 'LO': return `lined out${suffix}`
    default: return pa.result || 'made a play'
  }
}

function buildScoringPlayDescription(pa, scoringRuns, runEvents = [], charactersById = {}) {
  const batterName = charactersById[pa.character_id]?.name || 'Unknown batter'
  const isHomeRun = pa.result === 'HR' || pa.result === 'IPHR'
  const scorerNames = runEvents
    .filter((run) => !isHomeRun || String(run.scoring_character_id) !== String(pa.character_id))
    .map((run) => charactersById[run.scoring_character_id]?.name || null)
    .filter(Boolean)
  if (scorerNames.length) {
    return `${batterName} ${formatPlayResultText(pa)}; ${scorerNames.join(', ')} scored.`
  }
  const runText = scoringRuns === 1 ? '1 run scored' : `${scoringRuns} runs scored`
  return `${batterName} ${formatPlayResultText(pa)}; ${runText}.`
}

function isMeaningfulPitchingStint(stint = {}) {
  return [
    stint.innings_pitched,
    stint.hits_allowed,
    stint.runs_allowed,
    stint.earned_runs,
    stint.walks,
    stint.strikeouts,
    stint.hr_allowed,
    stint.win,
    stint.loss,
    stint.save,
  ].some((value) => Number(value || 0) > 0 || value === true)
}

function dedupePitchingStints(stints = []) {
  const grouped = stints.reduce((acc, stint) => {
    const key = `${stint.player_id}:${stint.character_id}`
    acc[key] = acc[key] || []
    acc[key].push(stint)
    return acc
  }, {})

  return Object.values(grouped).flatMap((group) => {
    if (group.length === 1) return group
    const meaningful = group.filter(isMeaningfulPitchingStint)
    if (meaningful.length) return meaningful
    return [group[group.length - 1]]
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
}

function estimateHomeWinProbability({
  homeScore = 0,
  awayScore = 0,
  currentInning = 1,
  isTop = true,
  outsInHalf = 0,
  regulationInnings = 3,
  runnersOccupied = 0,
  balls = 0,
  strikes = 0,
  status = 'active',
  paCount = 0,
  oddsContext = null,
}) {
  return estimateLiveWinProbability({
    game: oddsContext?.game,
    homeRoster: oddsContext?.homeRoster || [],
    awayRoster: oddsContext?.awayRoster || [],
    homeHistorical: oddsContext?.homeHistorical || {},
    awayHistorical: oddsContext?.awayHistorical || {},
    playerProps: oddsContext?.playerProps || {},
    state: {
      homeScore,
      awayScore,
      currentInning,
      isTop,
      outsInHalf,
      regulationInnings,
      runnersOccupied,
      balls,
      strikes,
      status,
      paCount,
    },
  })
}

function inningRunsFromRows(rows, playerId) {
  const map = {}
  rows
    .filter((row) => String(row.player_id) === String(playerId))
    .forEach((row) => {
      const inning = Number(row.inning || 1)
      map[inning] = (map[inning] || 0) + Number(row.runs || 0)
    })
  return map
}

// ─── Runner logic ─────────────────────────────────────────────────────────────
// Each runner: { characterId, playerId }
// pendingPA assignments: [{ id, runner, origin, destination, isBatter }]

function buildPendingAssignment(id, runner, origin, destination, isBatter = false) {
  return { id, runner, origin, destination, isBatter }
}

function computePendingState(result, runners, batter) {
  const { first, second, third } = runners
  const assignments = []
  const push = (id, runner, origin, destination, isBatter = false) => {
    if (!runner) return
    assignments.push(buildPendingAssignment(id, runner, origin, destination, isBatter))
  }

  const pushForcedFirstBaseAdvances = () => {
    if (first && second && third) {
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
      push('third', third, 'third', 'home')
    } else if (first && second) {
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
    } else if (first) {
      push('first', first, 'first', 'second')
      push('third', third, 'third', 'third')
    } else {
      push('second', second, 'second', 'second')
      push('third', third, 'third', 'third')
    }
  }

  const pushOneBaseErrorAdvance = () => {
    push('first', first, 'first', 'second')
    push('second', second, 'second', 'third')
    push('third', third, 'third', 'home')
  }

  switch (result) {
    case '1B':
      push('batter', batter, 'plate', 'first', true)
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '2B':
      push('batter', batter, 'plate', 'second', true)
      push('first', first, 'first', 'third')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '3B':
      push('batter', batter, 'plate', 'third', true)
      push('first', first, 'first', 'home')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case 'BB':
    case 'HBP':
      push('batter', batter, 'plate', 'first', true)
      pushForcedFirstBaseAdvances()
      return { result, assignments }
    case 'ROE':
      push('batter', batter, 'plate', 'first', true)
      pushOneBaseErrorAdvance()
      return { result, assignments }
    default:
      return { result, assignments: [] }
  }
}

function getRbiFromAssignments(assignments) {
  return assignments.filter((assignment) => assignment.destination === 'home' && !assignment.isBatter).length
}

function getPreviewRbiFromAssignments(result, assignments) {
  if (result === 'ROE') return 0
  const runnerRbi = getRbiFromAssignments(assignments)
  const batterScoresOnHit = HIT_RESULTS.has(result) && assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
  return runnerRbi + (batterScoresOnHit ? 1 : 0)
}

function didBatterScore(assignments) {
  return assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
}

// True when the only thing the runner-assignment panel would show is the
// batter going to the one base their hit type guarantees (bases empty, no
// runner to adjust) — nothing for the scorer to actually decide.
function isTrivialPendingResolution({ assignments }) {
  return assignments.length === 1 && assignments[0].isBatter
}

function extractNextRunners({ assignments }) {
  return assignments.reduce((next, assignment) => {
    if (assignment.destination === 'first') next.first = assignment.runner
    if (assignment.destination === 'second') next.second = assignment.runner
    if (assignment.destination === 'third') next.third = assignment.runner
    return next
  }, { first: null, second: null, third: null })
}

function getHomeAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'home')
}

function getOutAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'out')
}

function pendingLeavesRunnersOnBase(pending) {
  return hasAnyActiveRunners(extractNextRunners(pending))
}

function hasAnyActiveRunners(runners = {}) {
  return Boolean(runners.first || runners.second || runners.third)
}

function normalizeLiveRunner(runner = null) {
  if (!runner || runner.characterId == null || runner.playerId == null) return null
  return {
    characterId: Number(runner.characterId),
    playerId: runner.playerId,
  }
}

function normalizeLiveRunners(runners = {}) {
  return {
    first: normalizeLiveRunner(runners.first),
    second: normalizeLiveRunner(runners.second),
    third: normalizeLiveRunner(runners.third),
  }
}

function hasMeaningfulLiveStatePayload(liveState = null) {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return false
  const hasTrackedValue = [
    'inning',
    'isTop',
    'is_top',
    'outsInHalf',
    'outs_in_half',
    'balls',
    'strikes',
    'pitchNumber',
    'pitch_number',
    'paNumber',
    'pa_number',
    'batterCharacterId',
    'batter_character_id',
    'batterPlayerId',
    'batter_player_id',
    'onDeckCharacterId',
    'on_deck_character_id',
    'onDeckPlayerId',
    'on_deck_player_id',
    'updatedAt',
    'updated_at',
  ].some((key) => liveState[key] != null)

  return hasTrackedValue || hasAnyActiveRunners(normalizeLiveRunners(liveState.runners))
}

function normalizeLiveState(liveState = null) {
  if (!hasMeaningfulLiveStatePayload(liveState)) return null
  return {
    inning: Number(liveState.inning || 1),
    isTop: Boolean(liveState.isTop ?? liveState.is_top),
    outsInHalf: Number((liveState.outsInHalf ?? liveState.outs_in_half) || 0),
    balls: Number(liveState.balls || 0),
    strikes: Number(liveState.strikes || 0),
    pitchNumber: Number((liveState.pitchNumber ?? liveState.pitch_number) || 0),
    paNumber: Number((liveState.paNumber ?? liveState.pa_number) || 0),
    batterCharacterId: liveState.batterCharacterId ?? liveState.batter_character_id ?? null,
    batterPlayerId: liveState.batterPlayerId ?? liveState.batter_player_id ?? null,
    onDeckCharacterId: liveState.onDeckCharacterId ?? liveState.on_deck_character_id ?? null,
    onDeckPlayerId: liveState.onDeckPlayerId ?? liveState.on_deck_player_id ?? null,
    runners: normalizeLiveRunners(liveState.runners),
    updatedAt: liveState.updatedAt ?? liveState.updated_at ?? null,
  }
}

function getPersistedLiveStateValue(liveState = null, requireNonNullObject = false) {
  if (liveState && typeof liveState === 'object') return liveState
  return requireNonNullObject ? {} : null
}

function serializeLiveStateForComparison(liveState = null) {
  const normalized = normalizeLiveState(liveState)
  if (!normalized) return ''
  return JSON.stringify({
    ...normalized,
    updatedAt: null,
  })
}

function getNextBase(baseKey) {
  if (baseKey === 'first') return 'second'
  if (baseKey === 'second') return 'third'
  if (baseKey === 'third') return 'home'
  return baseKey
}

function getLeadForcedRunnerId(runners = {}) {
  if (runners.first && runners.second && runners.third) return 'third'
  if (runners.first && runners.second) return 'second'
  if (runners.first) return 'first'
  return null
}

function mapPositionToForcedBase(position) {
  const normalized = String(position || '')
  if (normalized === '2') return 'home'
  if (normalized === '5') return 'third'
  if (normalized === '4' || normalized === '6') return 'second'
  if (normalized === '1' || normalized === '3') return 'first'
  return null
}

function inferLikelyForcedOutId(putoutPosition, runners = {}) {
  const position = String(putoutPosition || '')
  if ((position === '4' || position === '6') && runners.first) return 'first'
  if (position === '5' && runners.first && runners.second) return 'second'
  if (position === '2' && runners.first && runners.second && runners.third) return 'third'
  if (position === '1' || position === '3') return 'batter'
  return null
}

function shouldResolveOutAssignments(result, runners = {}) {
  return hasAnyActiveRunners(runners) && ['GO', 'FO', 'LO', 'SF', 'SH', 'FC', 'DP'].includes(result)
}

function computePendingOutState(result, runners, batter, {
  primaryPosition = null,
  fielderChain = [],
} = {}) {
  const { first, second, third } = runners
  const assignments = []
  const push = (id, runner, origin, destination, isBatter = false) => {
    if (!runner) return
    assignments.push(buildPendingAssignment(id, runner, origin, destination, isBatter))
  }

  const putoutPosition = Array.isArray(fielderChain) && fielderChain.length
    ? fielderChain[fielderChain.length - 1]
    : primaryPosition
  const inferredOutId = inferLikelyForcedOutId(putoutPosition, runners)
  const fallbackForcedOutId = getLeadForcedRunnerId(runners)
  const resolvedRunnerOutId = inferredOutId && (result !== 'FC' || inferredOutId !== 'batter')
    ? inferredOutId
    : fallbackForcedOutId
  const touchedBases = (Array.isArray(fielderChain) ? fielderChain.slice(1) : [])
    .map(mapPositionToForcedBase)
    .filter(Boolean)
  const outIds = []
  let batterStillForced = true
  let firstStillOccupied = Boolean(first)
  let secondStillOccupied = Boolean(second)
  let thirdStillOccupied = Boolean(third)
  for (const touchedBase of touchedBases) {
    if (touchedBase === 'home' && firstStillOccupied && secondStillOccupied && thirdStillOccupied) {
      outIds.push('third')
      thirdStillOccupied = false
      continue
    }
    if (touchedBase === 'third' && firstStillOccupied && secondStillOccupied) {
      outIds.push('second')
      secondStillOccupied = false
      continue
    }
    if (touchedBase === 'second' && firstStillOccupied && batterStillForced) {
      outIds.push('first')
      firstStillOccupied = false
      continue
    }
    if (touchedBase === 'first' && batterStillForced) {
      outIds.push('batter')
      batterStillForced = false
    }
  }
  if (!outIds.length && resolvedRunnerOutId) outIds.push(resolvedRunnerOutId)
  const outIdSet = new Set(outIds)
  const isGrounderChoice = result === 'FC' || result === 'DP' || (result === 'GO' && (outIdSet.size > 0 || (resolvedRunnerOutId && inferredOutId !== 'batter')))
  const batterOut = result === 'SF' || result === 'SH' || (!isGrounderChoice && result !== 'FC')
  const forcedAtStart = {
    first: Boolean(first),
    second: Boolean(first && second),
    third: Boolean(first && second && third),
  }

  const batterSafe = !outIdSet.has('batter') && !batterOut
  if (!batterSafe) {
    push('batter', batter, 'plate', 'out', true)
  } else {
    push('batter', batter, 'plate', 'first', true)
  }

  const firstAdvances = Boolean(first && !outIdSet.has('first') && batterSafe)
  const secondAdvances = Boolean(second && !outIdSet.has('second') && firstAdvances)
  const thirdAdvances = Boolean(third && !outIdSet.has('third') && secondAdvances)

  const defaultRunnerDestination = (baseKey) => {
    if (result === 'SF') {
      return baseKey === 'third' ? 'home' : baseKey
    }
    if (result === 'SH') {
      return getNextBase(baseKey)
    }
    if (result === 'FO' || result === 'LO') {
      return baseKey
    }
    if (baseKey === 'first') {
      if (outIdSet.has('first')) return 'out'
      return firstAdvances ? 'second' : 'first'
    }
    if (baseKey === 'second') {
      if (outIdSet.has('second')) return 'out'
      return secondAdvances ? 'third' : 'second'
    }
    if (baseKey === 'third') {
      if (outIdSet.has('third')) return 'out'
      if (result === 'GO' || result === 'FC' || result === 'DP') {
        return thirdAdvances ? 'home' : 'third'
      }
      return forcedAtStart[baseKey] ? getNextBase(baseKey) : baseKey
    }
    if (isGrounderChoice || result === 'DP') {
      return baseKey
    }
    if (result === 'GO') {
      return forcedAtStart[baseKey] ? getNextBase(baseKey) : baseKey
    }
    return baseKey
  }

  push('first', first, 'first', defaultRunnerDestination('first'))
  push('second', second, 'second', defaultRunnerDestination('second'))
  push('third', third, 'third', defaultRunnerDestination('third'))

  return {
    result,
    assignments,
    outResolution: true,
    originalResult: result,
  }
}

function derivePendingResult(pending) {
  if (!pending?.outResolution) return pending?.result
  const outCount = getOutAssignments(pending).length
  const batterOut = pending.assignments.some((assignment) => assignment.isBatter && assignment.destination === 'out')
  const batterSafe = pending.assignments.some((assignment) => assignment.isBatter && assignment.destination !== 'out')

  if (outCount >= 3) return 'TP'
  if (outCount >= 2) return 'DP'
  if (pending.originalResult === 'SF') return 'SF'
  if (pending.originalResult === 'SH') return 'SH'
  if (batterSafe && outCount >= 1) return 'FC'
  if (pending.originalResult === 'FO' || pending.originalResult === 'LO') return pending.originalResult
  if (batterOut) return 'GO'
  return pending.originalResult || pending.result
}

function computeImmediateNextRunners(result, runners, batter) {
  const { first, second, third } = runners
  switch (result) {
    case 'HR':
    case 'IPHR':
    case 'TP':
      return { first: null, second: null, third: null }
    case 'SF':  return { first, second, third: null }
    case 'SH':  return { first: null, second: first, third: second }
    case 'FC':  return { first: batter, second, third }   // lead runner (first) out
    case 'DP':  return { first: null, second, third }     // runner on first out, batter out
    default:    return { first, second, third }           // K, GO, FO, LO — runners hold
  }
}

function getRunsScoredOnPa(pa) {
  return Number(pa?.rbi || 0) + (pa?.run_scored ? 1 : 0)
}

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function requiresInPlayFielderChain(result) {
  return result !== 'HR'
}

function getHomeRunLandingPosition(landingSpot) {
  if (!landingSpot || !Number.isFinite(Number(landingSpot.x))) return null
  const x = Number(landingSpot.x)
  if (x <= 34) return '7'
  if (x >= 66) return '9'
  return '8'
}

function canFinalizeInPlaySelection(state) {
  if (!state?.result || !state?.trajectory) return false
  if (state.result === 'HR') return Boolean(state?.landingSpot)
  if (!requiresInPlayFielderChain(state.result)) return true
  return Boolean(state?.fielderChain?.length)
}

function isOutcomeDisabledForOuts(result, outsInHalf = 0) {
  return outsInHalf >= 2 && TWO_OUT_DISABLED_RESULTS.has(result)
}

function isOutcomeDisabledForRunners(result, runners = {}) {
  return (result === 'SF' || result === 'SH' || result === 'FC' || result === 'DP') && !hasAnyActiveRunners(runners)
}

function getRunnerStateStorageKey(gameId, halfIdx) {
  return `scorebook-runners:${gameId}:${halfIdx}`
}

function getRunnerHistoryStorageKey(gameId, halfIdx) {
  return `scorebook-runners-history:${gameId}:${halfIdx}`
}

function getActivePaStorageKey(gameId) {
  return `scorebook-active-pa:${gameId}`
}

function sanitizeRunnersForOffense(nextRunners, offense) {
  if (!offense?.battingPlayerId) return nextRunners
  const isOffensiveRunner = (runner) => (
    runner
    && String(runner.playerId) === String(offense.battingPlayerId)
  )
  return {
    first: isOffensiveRunner(nextRunners?.first) ? nextRunners.first : null,
    second: isOffensiveRunner(nextRunners?.second) ? nextRunners.second : null,
    third: isOffensiveRunner(nextRunners?.third) ? nextRunners.third : null,
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Avatar({ name, size = 36, style: sx = {} }) {
  return <CharacterPortrait name={name} size={size} borderRadius={0} objectFit="contain" style={sx} />
}

function ResultBadge({ result, strikeoutType = null }) {
  const color = HIT_RESULTS.has(result) ? C.green : WALK_RESULTS.has(result) ? C.blue : C.red
  return (
    <span style={{ background: color + '22', color, border: `1px solid ${color}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {formatPlateAppearanceResult(result, strikeoutType)}
    </span>
  )
}

function CountDotRow({ count = 0, total = 3, activeColor = '#22C55E', inactiveColor = '#334155', label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label ? <span style={{ color: '#94A3B8', fontSize: 10, fontWeight: 800, minWidth: 10 }}>{label}</span> : null}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap' }}>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={`${label || 'dot'}-${index}`}
            style={{
              width: 10,
              minWidth: 10,
              height: 10,
              minHeight: 10,
              borderRadius: '50%',
              background: index < count ? activeColor : 'transparent',
              border: `2px solid ${index < count ? activeColor : inactiveColor}`,
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function FieldStatusCard({ title, children, accent = '#94A3B8' }) {
  return (
    <div
      style={{
        width: '100%',
        minHeight: 96,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        padding: '12px 14px',
        borderRadius: 14,
        border: `1px solid ${C.border}`,
        background: `${C.card}DD`,
        overflow: 'hidden',
      }}
    >
      {title ? (
        <div style={{ color: accent, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </div>
      ) : null}
      {children}
    </div>
  )
}

function CompactMatchupCard({ align = 'left', kicker, name, subtext, stats = [], accent = '#EAB308' }) {
  const justify = align === 'right' ? 'flex-end' : 'flex-start'
  const textAlign = align === 'right' ? 'right' : 'left'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'right' ? 'flex-end' : 'flex-start', justifyContent: 'center', minWidth: 0 }}>
      <div style={{ color: accent, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{kicker}</div>
      <div style={{ fontSize: 18, fontWeight: 800, textAlign, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{name}</div>
      <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', textAlign }}>{subtext}</div>
      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: justify, flexWrap: 'wrap', marginTop: 4 }}>
          {stats.map((stat) => (
            <span key={stat.label} style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>
              {stat.label} {stat.value}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function buildInPlaySelectionSummary(state) {
  if (!state) return []
  const items = []
  if (state.resultType) items.push({ label: 'Play', value: state.resultType.toUpperCase() })
  if (state.result) items.push({ label: 'Result', value: state.result })
  if (state.trajectory) items.push({ label: 'Shape', value: `${state.trajectory} - ${TRAJECTORY_LABELS[state.trajectory] || state.trajectory}` })
  if (state.fielderChain?.length) {
    items.push({
      label: state.fielderChain.length > 1 ? 'Fielders' : 'Fielded By',
      value: state.fielderChain.join(' → '),
    })
  }
  return items
}

function OutcomeBtn({ result, zone, onClick, disabled = false }) {
  const base = ZONE_COLOR[zone]
  return (
    <button
      onClick={() => onClick(result)} disabled={disabled}
      style={{ background: `${base}22`, color: disabled ? C.border : base, border: `1.5px solid ${disabled ? C.border : base + '55'}`, borderRadius: 8, minHeight: 54, fontWeight: 800, fontSize: 15, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}
      onPointerDown={e => { if (!disabled) e.currentTarget.style.background = `${base}44` }}
      onPointerUp={e => { e.currentTarget.style.background = `${base}22` }}
      onPointerLeave={e => { e.currentTarget.style.background = `${base}22` }}
    >
      {result}
    </button>
  )
}

// ─── Diamond ─────────────────────────────────────────────────────────────────
function Diamond({
  runners,
  pitcherChar,
  outs,
  previewHomeRunners = [],
  previewOuts = 0,
  onMoundDrop,
  onMoundDragOver,
  onMoundDragLeave,
  isDragOver,
  isScorekeeper,
  charactersById,
  selectedPitcher,
  onMoundClick,
  hideOutsRow = false,
  onRemoveRunner,
}) {
  // Actual field geometry and marker sizes. Increasing these changes the visible diamond,
  // not just the space around it.
  const bases = [
    { key: 'second', label: '2B', left: '50%', top: '10%' },
    { key: 'first',  label: '1B', left: '86%', top: '42%' },
    { key: 'third',  label: '3B', left: '14%', top: '42%' },
  ]
  const committedOuts = Math.min(outs, 3)
  const pendingOuts = Math.max(0, Math.min(previewOuts, 3 - committedOuts))
  const overflowOuts = Math.max(0, outs + previewOuts - 3)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '340px', aspectRatio: '1.12 / 1', margin: '0 auto' }}>
        {/* Base lines */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
          <polygon points="50,10 86,42 50,82 14,42" fill="rgba(148,163,184,0.05)" stroke={C.border} strokeWidth="1.8" />
          <line x1="50" y1="10" x2="50" y2="82" stroke="rgba(148,163,184,0.22)" strokeWidth="1.2" />
          <line x1="14" y1="42" x2="86" y2="42" stroke="rgba(148,163,184,0.16)" strokeWidth="1.2" />
        </svg>

        {/* Runner bases */}
        {bases.map(b => {
          const runner = runners[b.key]
          const showRemove = Boolean(isScorekeeper && runner)
          return (
            <div key={b.key} style={{ position: 'absolute', left: b.left, top: b.top, transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              {runner ? (
                <div style={{ position: 'relative', width: 44, height: 44 }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${C.accent}`, flexShrink: 0 }}>
                    <Avatar name={charactersById[runner.characterId]?.name} size={44} />
                  </div>
                  {showRemove && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveRunner?.(b.key)
                      }}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: `1px solid ${C.red}`,
                        background: `${C.red}EE`,
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 900,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                      }}
                      aria-label={`Remove runner from ${b.label}`}
                      title={`Remove runner from ${b.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ width: 18, height: 18, background: C.border, transform: 'rotate(45deg)', borderRadius: 2 }} />
              )}
            </div>
          )
        })}

        {/* Home plate */}
        <div style={{ position: 'absolute', left: '50%', top: '82%', transform: 'translate(-50%,-50%)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 18, height: 18, background: C.card, border: `2px solid ${previewHomeRunners.length ? C.accent : C.border}`, transform: 'rotate(45deg)', borderRadius: 2 }} />
            {previewHomeRunners.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {previewHomeRunners.slice(0, 3).map((assignment, index) => (
                  <div
                    key={assignment.id}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      border: `2px solid ${C.accent}`,
                      marginLeft: index === 0 ? 0 : -7,
                      background: C.card,
                      boxShadow: '0 0 0 2px rgba(15, 23, 42, 0.9)',
                    }}
                  >
                    <Avatar name={charactersById[assignment.runner.characterId]?.name} size={28} />
                  </div>
                ))}
                {previewHomeRunners.length > 3 && (
                  <div style={{ marginLeft: 4, fontSize: 9, color: C.accent, fontWeight: 800 }}>
                    +{previewHomeRunners.length - 3}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Pitcher mound — drop target + tap-to-confirm */}
        <div
          onDragOver={isScorekeeper ? onMoundDragOver : undefined}
          onDragLeave={isScorekeeper ? onMoundDragLeave : undefined}
          onDrop={isScorekeeper ? onMoundDrop : undefined}
          onClick={isScorekeeper && selectedPitcher ? onMoundClick : undefined}
          style={{ position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%,-50%)', cursor: selectedPitcher ? 'pointer' : 'default' }}
        >
          <div style={{ width: 60, height: 60, borderRadius: '50%', border: `2px ${isDragOver || selectedPitcher ? 'solid' : 'dashed'} ${isDragOver ? C.accent : selectedPitcher ? '#A78BFA' : C.border}`, background: isDragOver ? `${C.accent}20` : selectedPitcher ? '#A78BFA20' : `${C.bg}cc`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', transition: 'all 0.15s' }}>
            {pitcherChar
              ? <Avatar name={pitcherChar.name} size={56} />
              : <span style={{ fontSize: 22 }}>⚾</span>}
          </div>
        </div>
        {selectedPitcher && isScorekeeper && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: '#A78BFA', fontWeight: 800, textAlign: 'center', maxWidth: 72 }}>tap to confirm</div>
        )}
        {!selectedPitcher && pitcherChar && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: C.muted, fontWeight: 700, textAlign: 'center', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pitcherChar.name.split(' ')[0]}
          </div>
        )}
        {!selectedPitcher && !pitcherChar && isScorekeeper && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: C.border, textAlign: 'center', maxWidth: 72 }}>drag / tap pitcher</div>
        )}
      </div>

      {/* Outs row */}
      {!hideOutsRow && (
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: C.muted, fontWeight: 700, letterSpacing: '.04em' }}>OUTS</span>
          {[0, 1, 2].map(i => (
            <div
              key={i}
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: i < committedOuts ? '#F59E0B' : i < committedOuts + pendingOuts ? `${C.red}` : 'transparent',
                border: `2px solid ${i < committedOuts ? '#F59E0B' : i < committedOuts + pendingOuts ? C.red : C.border}`,
              }}
            />
          ))}
          {overflowOuts > 0 && (
            <span style={{ fontSize: 9, color: C.red, fontWeight: 800 }}>+{overflowOuts}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Lineup column ────────────────────────────────────────────────────────────
function LineupColumn({
  lineup,
  currentIdx,
  teamColor,
  stat,
  draggable: isDraggable,
  currentPitcherCharId,
  pendingPitcherCharId,
  onDragStart,
  onItemClick,
  onCharacterClick,
  charactersById,
  orientation = 'vertical',
  wrap = false,
}) {
  const isHorizontal = orientation === 'horizontal'
  const isCompact = isHorizontal && wrap
  const avatarSize = isCompact ? 30 : 36
  return (
    <div style={{
      display: 'flex',
      flexDirection: isHorizontal ? 'row' : 'column',
      alignItems: isHorizontal ? 'center' : 'center',
      gap: isHorizontal ? (isCompact ? 4 : 8) : 2,
      minWidth: 0,
      width: '100%',
    }}>
      <div style={{
        marginBottom: isHorizontal ? 0 : 2,
        flexShrink: 0,
        width: isHorizontal ? (isCompact ? 20 : 28) : 'auto',
        display: 'flex',
        justifyContent: 'center',
      }}>
        <StatIcon stat={stat} size={isCompact ? 14 : 16} style={{ opacity: 0.75 }} />
      </div>
      <div style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        flexWrap: isHorizontal && wrap ? 'wrap' : 'nowrap',
        gap: isCompact ? 2 : 3,
        overflowX: isHorizontal && !wrap ? 'auto' : 'visible',
        overflowY: isHorizontal ? 'hidden' : 'auto',
        scrollbarWidth: 'none',
        maxHeight: isHorizontal ? 'none' : 220,
        width: '100%',
        minWidth: 0,
        alignItems: isHorizontal && wrap ? 'flex-start' : 'center',
        paddingBottom: isHorizontal ? 2 : 0,
      }}>
        {lineup.map((entry, i) => {
          const char = charactersById[entry.character_id]
          const isCurrentPitcher = isDraggable && entry.character_id === currentPitcherCharId
          const isPending = isDraggable && entry.character_id === pendingPitcherCharId
          const isCurrent = isDraggable ? isCurrentPitcher : i === currentIdx
          const borderColor = isPending ? '#A78BFA' : isCurrent ? teamColor : C.border
          const shadow = isPending ? '0 0 8px #A78BFA' : isCurrent ? `0 0 6px ${teamColor}` : 'none'
          const handleClick = isDraggable && onItemClick
            ? () => onItemClick(entry.character_id, entry.player_id)
            : (!isDraggable && onCharacterClick ? () => onCharacterClick(entry.character_id, entry.player_id) : undefined)
          return (
            <div
              key={entry.character_id ?? entry.id ?? i}
              draggable={isDraggable}
              onDragStart={isDraggable ? onDragStart(entry.character_id, entry.player_id) : undefined}
              onClick={handleClick}
              title={char?.name}
              style={{ position: 'relative', cursor: handleClick ? 'pointer' : 'default', opacity: (isCurrent || isPending) ? 1 : 0.45, flexShrink: 0 }}
            >
              <div style={{ width: avatarSize, height: avatarSize, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${borderColor}`, boxShadow: shadow, transition: 'border-color 0.15s, box-shadow 0.15s' }}>
                <Avatar name={char?.name} size={avatarSize} />
              </div>
              <div style={{ position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%', background: isPending ? '#A78BFA' : isCurrent ? teamColor : C.card, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 900, color: (isCurrent || isPending) ? '#000' : C.muted }}>
                {i + 1}
              </div>
            </div>
          )
        })}
        {lineup.length === 0 && (
          <div style={{ fontSize: 10, color: C.border, textAlign: 'center', padding: 6 }}>—</div>
        )}
      </div>
    </div>
  )
}

// ─── Runner chip (used inside resolution panel) ───────────────────────────────
function RunnerChip({ slot, label, isHome, onToggle, charactersById }) {
  if (!slot) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div style={{ width: 34, height: 34, borderRadius: '50%', border: `2px dashed ${C.border}` }} />
      <div style={{ fontSize: 8, color: C.border, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 8, color: C.border }}>empty</div>
    </div>
  )

  const isOut    = slot.status === 'out'
  const isScored = slot.status === 'scored'
  const statusColor = isOut ? C.red : isScored ? C.accent : C.green
  const statusLabel = isOut ? 'OUT' : isScored ? 'SCORED' : 'SAFE'

  return (
    <button
      onClick={onToggle}
      type="button"
      style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: 0 }}
    >
      <div style={{ width: 38, height: 38, borderRadius: '50%', overflow: 'hidden', border: `2.5px solid ${statusColor}`, opacity: isOut ? 0.5 : 1 }}>
        <Avatar name={charactersById[slot.runner.characterId]?.name} size={38} />
      </div>
      <div style={{ fontSize: 8, color: C.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 9, fontWeight: 800, color: statusColor, background: statusColor + '22', borderRadius: 4, padding: '1px 5px', border: `1px solid ${statusColor}44` }}>
        {statusLabel}
      </div>
    </button>
  )
}

// ─── Runner resolution panel ──────────────────────────────────────────────────
function RunnerResolutionPanel({ pendingPA, onToggleBase, onToggleScored, onConfirm, onCancel, charactersById }) {
  const { result, first, second, third, scored } = pendingPA
  const rbi = scored.filter(s => s.status === 'scored').length

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={result} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Tap to toggle scored / out</span>
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}>
          <X size={16} />
        </button>
      </div>

      {/* Diamond layout for resolution */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        {/* Row 1: 3B | 2B | 1B */}
        <RunnerChip slot={third}  label="3B" onToggle={() => onToggleBase('third')}  charactersById={charactersById} />
        <RunnerChip slot={second} label="2B" onToggle={() => onToggleBase('second')} charactersById={charactersById} />
        <RunnerChip slot={first}  label="1B" onToggle={() => onToggleBase('first')}  charactersById={charactersById} />
      </div>

      {/* Home plate runners */}
      {scored.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: C.muted, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, textAlign: 'center', letterSpacing: '.04em' }}>
            🏠 Home Plate
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            {scored.map((s, i) => (
              <RunnerChip key={i} slot={s} label="HOME" isHome onToggle={() => onToggleScored(i)} charactersById={charactersById} />
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
          {rbi > 0
            ? <span style={{ color: C.accent }}>{rbi} RBI</span>
            : <span style={{ color: C.muted }}>0 RBI</span>}
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', color: C.muted, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={onConfirm} type="button" style={{ background: C.accent, color: '#000', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          Save PA →
        </button>
      </div>
    </div>
  )
}

function RunnerAssignmentChip({ assignment, onSetDestination, charactersById, readOnly = false }) {
  const destinationMeta = {
    first: { color: C.green, label: '1B' },
    second: { color: C.green, label: '2B' },
    third: { color: C.green, label: '3B' },
    home: { color: C.accent, label: 'HOME' },
    out: { color: C.red, label: 'OUT' },
  }
  const current = destinationMeta[assignment.destination] || destinationMeta.out
  const destinationButtons = [
    { key: 'first', label: '1B' },
    { key: 'second', label: '2B' },
    { key: 'third', label: '3B' },
    { key: 'home', label: 'HOME' },
    { key: 'out', label: 'OUT' },
  ]

  return (
    <div style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 10, border: `1px solid ${C.border}`, background: `${current.color}12` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 38, height: 38, borderRadius: '50%', overflow: 'hidden', border: `2.5px solid ${current.color}`, opacity: assignment.destination === 'out' ? 0.5 : 1 }}>
          <Avatar name={charactersById[assignment.runner.characterId]?.name} size={38} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: 'uppercase' }}>
            {assignment.isBatter ? 'Batter' : `${assignment.origin.toUpperCase()} Runner`}
          </div>
          <div style={{ fontSize: 12, color: current.color, fontWeight: 800 }}>{current.label}</div>
        </div>
      </div>
      {readOnly ? null : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {destinationButtons.map((button) => (
            <button
              key={button.key}
              onClick={() => onSetDestination(assignment.id, button.key)}
              type="button"
              style={{
                background: assignment.destination === button.key ? current.color : 'transparent',
                color: assignment.destination === button.key ? '#000' : C.muted,
                border: `1px solid ${assignment.destination === button.key ? current.color : C.border}`,
                borderRadius: 999,
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RunnerAssignmentsPanel({ pendingPA, onSetDestination, onConfirm, onCancel, charactersById }) {
  const { assignments } = pendingPA
  const displayResult = derivePendingResult(pendingPA)
  const rbi = getPreviewRbiFromAssignments(displayResult, assignments)
  const isTrivial = isTrivialPendingResolution(pendingPA)

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={displayResult} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>
            {isTrivial ? 'Set where the runner ended up' : 'Assign each runner to a base, home, or out'}
          </span>
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        {assignments.map((assignment) => (
          <RunnerAssignmentChip
            key={assignment.id}
            assignment={assignment}
            onSetDestination={onSetDestination}
            charactersById={charactersById}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
          {rbi > 0
            ? <span style={{ color: C.accent }}>{rbi} RBI</span>
            : <span style={{ color: C.muted }}>0 RBI</span>}
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', color: C.muted, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={onConfirm} type="button" style={{ background: C.accent, color: '#000', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          Save PA →
        </button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
function SectionCard({ title, subtitle = '', right = null, children }) {
  return (
    <section style={{ background: 'linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))', border: `1px solid ${C.border}`, borderRadius: 18, padding: 16, boxShadow: '0 14px 28px rgba(2,6,23,0.22)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          {title ? <div style={{ color: '#F8FAFC', fontSize: 15, fontWeight: 800 }}>{title}</div> : null}
          {subtitle ? <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{subtitle}</div> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function BaseStateDiamond({ runners, charactersById, size = 88 }) {
  const baseSize = Math.max(10, Math.round(size * 0.14))
  const runnerSize = Math.max(20, Math.round(size * 0.28))
  const baseNode = (runner) => (
    runner
      ? (
          <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}`, boxShadow: '0 0 0 2px rgba(15,23,42,0.88)' }}>
            <Avatar name={charactersById[runner.characterId]?.name} size={runnerSize} />
          </div>
        )
      : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 2 }} />
  )

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100">
        <polygon points="50,8 88,46 50,84 12,46" fill="rgba(148,163,184,0.04)" stroke={C.border} strokeWidth="2" />
      </svg>
      <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%, 0)' }}>{baseNode(runners.second)}</div>
      <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translate(0, -50%)' }}>{baseNode(runners.first)}</div>
      <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translate(0, -50%)' }}>{baseNode(runners.third)}</div>
      <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translate(-50%, 0)' }}>
        <div style={{ width: baseSize, height: baseSize, background: C.card, border: `1.5px solid ${C.border}`, transform: 'rotate(45deg)', borderRadius: 2 }} />
      </div>
    </div>
  )
}

function BoxScoreTable({
  innings,
  scores,
  completedHalfCount,
  currentInning,
  teamAAbbreviation,
  teamBAbbreviation,
  teamAColor,
  teamBColor,
  teamALogoKey,
  teamALogoUrl,
  teamBLogoKey,
  teamBLogoUrl,
  teamAName,
  teamBName,
  compact = false,
  swapped = false,
}) {
  const cellPad = compact ? '7px 0' : '10px 0'
  const cellFontSize = compact ? 11 : 13
  const headerFontSize = compact ? 10 : 11
  const teamColMinWidth = compact ? 76 : 112
  // `swapped` reflects the game's `home_away_swapped` flag — it determines which
  // team actually bats in the top of the inning. The "away" row is always shown
  // first, "home" second.
  const teamARow = {
    key: 'teamA',
    abbreviation: teamAAbbreviation,
    color: teamAColor,
    logoKey: teamALogoKey,
    logoUrl: teamALogoUrl,
    teamName: teamAName,
    scoreMap: scores.aByInning,
    runs: scores.a,
    hits: scores.aHits,
    errors: scores.aErrors,
    battingSide: swapped ? 'home' : 'away',
  }
  const teamBRow = {
    key: 'teamB',
    abbreviation: teamBAbbreviation,
    color: teamBColor,
    logoKey: teamBLogoKey,
    logoUrl: teamBLogoUrl,
    teamName: teamBName,
    scoreMap: scores.bByInning,
    runs: scores.b,
    hits: scores.bHits,
    errors: scores.bErrors,
    battingSide: swapped ? 'away' : 'home',
  }
  const displayRows = teamARow.battingSide === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: compact ? 320 : 520, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: `0 0 ${compact ? 6 : 10}px`, color: C.muted, fontSize: headerFontSize, fontWeight: 800 }}>Team</th>
            {innings.map((inning) => (
              <th key={inning} style={{ padding: `0 ${compact ? 4 : 0}px ${compact ? 6 : 10}px`, color: inning === currentInning ? C.accent : C.muted, fontSize: headerFontSize, fontWeight: 800 }}>{inning}</th>
            ))}
            {['R', 'H', 'E'].map((label) => (
              <th key={label} style={{ padding: `0 ${compact ? 4 : 0}px ${compact ? 6 : 10}px`, color: C.muted, fontSize: headerFontSize, fontWeight: 800 }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((team) => (
            <tr key={team.key}>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 8, minWidth: teamColMinWidth }}>
                  <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.teamName} height={compact ? 16 : 20} />
                  <span style={{ color: team.color, fontSize: compact ? 11 : 12, fontWeight: 800 }}>{team.abbreviation}</span>
                </div>
              </td>
              {innings.map((inning) => (
                <td key={`${team.key}-${inning}`} style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', color: inning === currentInning ? '#F8FAFC' : '#CBD5E1', fontSize: cellFontSize, fontWeight: 700 }}>
                  {getLineScoreCellValue({ inning, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}
                </td>
              ))}
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', color: team.color, fontSize: cellFontSize, fontWeight: 900 }}>{team.runs}</td>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: cellFontSize, fontWeight: 700 }}>{team.hits}</td>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: cellFontSize, fontWeight: 700 }}>{team.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LineupStatsTable({
  title,
  lineup,
  statsByEntryKey,
  currentEntryKey = null,
  teamColor,
  charactersById,
  onCharacterClick,
}) {
  return (
    <SectionCard title={title}>
      {!lineup.length ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No lineup set.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 320, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0 0 10px', color: C.muted, fontSize: 11, fontWeight: 800 }}>Batter</th>
                {['AB', 'R', 'H', 'RBI', 'BB', 'AVG'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lineup.map((entry, index) => {
                const key = `${entry.player_id}:${entry.character_id}`
                const stats = statsByEntryKey[key] || { game: summarizeBatting([]), source: summarizeBatting([]) }
                const isCurrent = key === currentEntryKey
                return (
                  <tr key={key}>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                      <div
                        onClick={onCharacterClick ? () => onCharacterClick(entry.character_id, entry.player_id) : undefined}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: onCharacterClick ? 'pointer' : 'default' }}
                      >
                        <span style={{ width: 18, color: isCurrent ? teamColor : C.muted, fontSize: 11, fontWeight: 800 }}>{index + 1}</span>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${isCurrent ? teamColor : C.border}` }}>
                          <Avatar name={charactersById[entry.character_id]?.name} size={30} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: isCurrent ? teamColor : '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.character_id]?.name || 'Unknown'}</div>
                          {isCurrent ? <div style={{ color: C.muted, fontSize: 11 }}>Current batter</div> : null}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.atBats}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.runs}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.hits}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.rbi}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.walks}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatBaseballAverage(stats.source)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

function PitchingStatsTable({ title, stints, decisionLabels, charactersById, onCharacterClick }) {
  return (
    <SectionCard title={title}>
      {!stints.length ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No pitching lines yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 320, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0 0 10px', color: C.muted, fontSize: 11, fontWeight: 800 }}>Pitcher</th>
                {['IP', 'H', 'R', 'ER', 'BB', 'K'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stints.map((stint) => (
                <tr key={stint.id}>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                    <div
                      onClick={onCharacterClick ? () => onCharacterClick(stint.character_id, stint.player_id) : undefined}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: onCharacterClick ? 'pointer' : 'default' }}
                    >
                      <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.border}` }}>
                        <Avatar name={charactersById[stint.character_id]?.name} size={30} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[stint.character_id]?.name || 'Unknown'}</div>
                        {decisionLabels[stint.id] ? <div style={{ color: C.accent, fontSize: 11, fontWeight: 800 }}>{decisionLabels[stint.id]}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.innings_pitched ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.hits_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.runs_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.earned_runs ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.walks ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.strikeouts ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

function WinProbabilityCard({ points, currentHomeProbability, homeLabel, awayLabel, homeColor, awayColor }) {
  const safePoints = points.length ? points : [{ label: 'Start', probability: currentHomeProbability, description: 'Game start' }]
  const chartUid = useId()
  const chartWidth = 300
  const chartHeight = 150
  const chartPadding = { top: 8, right: 12, bottom: 8, left: 34 }
  const innerWidth = chartWidth - chartPadding.left - chartPadding.right
  const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom
  const midY = chartPadding.top + (innerHeight / 2)
  const [selectedIndex, setSelectedIndex] = useState(safePoints.length - 1)

  useEffect(() => {
    setSelectedIndex(safePoints.length - 1)
  }, [safePoints.length])

  const clampedIndex = Math.min(Math.max(selectedIndex, 0), safePoints.length - 1)
  const selectedPoint = safePoints[clampedIndex] || safePoints[safePoints.length - 1]

  const getIndexFromClientX = useCallback((clientX, rect) => {
    if (!rect.width || safePoints.length <= 1) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - ((chartPadding.left / chartWidth) * rect.width)) / ((innerWidth / chartWidth) * rect.width)))
    return Math.round(ratio * (safePoints.length - 1))
  }, [safePoints.length, chartPadding.left, chartWidth, innerWidth])

  const handleChartPointer = useCallback((clientX, rect) => {
    setSelectedIndex(getIndexFromClientX(clientX, rect))
  }, [getIndexFromClientX])

  const path = safePoints.map((point, index) => {
    const x = safePoints.length === 1
      ? chartPadding.left + (innerWidth / 2)
      : chartPadding.left + ((index / (safePoints.length - 1)) * innerWidth)
    const y = chartPadding.top + ((1 - point.probability) * innerHeight)
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const fillPath = `${path} L ${chartPadding.left + innerWidth} ${chartPadding.top + innerHeight} L ${chartPadding.left} ${chartPadding.top + innerHeight} Z`
  const homePct = (currentHomeProbability * 100).toFixed(1)
  const awayPct = (100 - currentHomeProbability * 100).toFixed(1)

  return (
    <SectionCard
      title="Win Probability"
      subtitle={`${homeLabel} vs ${awayLabel}`}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700 }}>
          <span style={{ color: awayColor }}>{awayLabel} {awayPct}%</span>
          <span style={{ color: homeColor }}>{homeLabel} {homePct}%</span>
        </div>
        <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: `${C.card}AA`, padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 800 }}>{selectedPoint.label}</div>
            <div style={{ color: selectedPoint.probability >= 0.5 ? homeColor : awayColor, fontSize: 14, fontWeight: 900 }}>
              {selectedPoint.probability >= 0.5 ? (selectedPoint.probability * 100).toFixed(1) : ((1 - selectedPoint.probability) * 100).toFixed(1)}% {selectedPoint.probability >= 0.5 ? homeLabel : awayLabel}
            </div>
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>
            {selectedPoint.description || 'Game state update'}
          </div>
          {selectedPoint.score ? (
            <div style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700, marginTop: 6 }}>{selectedPoint.score}</div>
          ) : null}
        </div>
        <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.72)', padding: 10 }}>
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            preserveAspectRatio="none"
            style={{ width: '100%', aspectRatio: '2 / 1', display: 'block', touchAction: 'none', cursor: 'pointer' }}
            onMouseMove={(event) => handleChartPointer(event.clientX, event.currentTarget.getBoundingClientRect())}
            onClick={(event) => handleChartPointer(event.clientX, event.currentTarget.getBoundingClientRect())}
            onTouchStart={(event) => handleChartPointer(event.touches[0].clientX, event.currentTarget.getBoundingClientRect())}
            onTouchMove={(event) => handleChartPointer(event.touches[0].clientX, event.currentTarget.getBoundingClientRect())}
          >
            <defs>
              <clipPath id={`wp-top-${chartUid}`}>
                <rect x={0} y={0} width={chartWidth} height={midY} />
              </clipPath>
              <clipPath id={`wp-bottom-${chartUid}`}>
                <rect x={0} y={midY} width={chartWidth} height={chartHeight - midY} />
              </clipPath>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((mark) => {
              const y = chartPadding.top + ((1 - mark) * innerHeight)
              const isCenter = mark === 0.5
              return <line key={mark} x1={chartPadding.left} x2={chartPadding.left + innerWidth} y1={y} y2={y} stroke={isCenter ? 'rgba(148,163,184,0.4)' : 'rgba(148,163,184,0.18)'} strokeWidth="1" strokeDasharray={isCenter ? undefined : '4 4'} />
            })}
            {[
              { mark: 1, label: '100', color: homeColor },
              { mark: 0.75, label: '75', color: homeColor },
              { mark: 0.5, label: '50', color: C.muted },
              { mark: 0.25, label: '75', color: awayColor },
              { mark: 0, label: '100', color: awayColor },
            ].map(({ mark, label, color }) => {
              const y = chartPadding.top + ((1 - mark) * innerHeight)
              return (
                <text key={`label-${mark}-${label}`} x={chartPadding.left - 6} y={y + 4} textAnchor="end" fill={color} fontSize="9" fontWeight="700">
                  {label}
                </text>
              )
            })}
            <g clipPath={`url(#wp-top-${chartUid})`}>
              <path d={fillPath} fill={`${homeColor}26`} />
              <path d={path} fill="none" stroke={homeColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            <g clipPath={`url(#wp-bottom-${chartUid})`}>
              <path d={fillPath} fill={`${awayColor}26`} />
              <path d={path} fill="none" stroke={awayColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            {safePoints.map((point, index) => {
              const x = safePoints.length === 1
                ? chartPadding.left + (innerWidth / 2)
                : chartPadding.left + ((index / (safePoints.length - 1)) * innerWidth)
              const y = chartPadding.top + ((1 - point.probability) * innerHeight)
              const active = index === clampedIndex
              const pointColor = point.probability >= 0.5 ? homeColor : awayColor
              return (
                <circle
                  key={`${point.label}-${index}`}
                  cx={x}
                  cy={y}
                  r={active ? 5 : 3}
                  fill={active ? '#F8FAFC' : pointColor}
                  stroke={pointColor}
                  strokeWidth={active ? 2 : 0}
                />
              )
            })}
          </svg>
        </div>
      </div>
    </SectionCard>
  )
}

export default function Scorebook() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const gameSession = useGameSession()
  const scorebookTables = gameSession?.tables || {}
  const isSeasonGame = gameSession?.sourceType === 'season'
  const addSourceFields = useCallback((payload = {}) => {
    if (!isSeasonGame) return payload
    return {
      ...payload,
      season_id: gameSession?.sourceId || payload.season_id || null,
    }
  }, [isSeasonGame, gameSession?.sourceId])
  const betResolutionConfig = useMemo(() => (
    isSeasonGame
      ? {
          betsTable: scorebookTables.bets,
          gameOddsTable: scorebookTables.gameOdds,
          ledgerTable: scorebookTables.bettingLedger,
          plateAppearancesTable: scorebookTables.plateAppearances,
          runsScoredTable: scorebookTables.runsScored,
          enableCalibrationLogging: false,
          enableWeightAdjustment: false,
          wagerField: 'wager_dollars',
          payoutField: 'potential_payout_dollars',
          ledgerChangeField: 'dollars_change',
          sourceIdField: 'season_id',
          sourceIdValue: gameSession?.sourceId || null,
        }
      : {}
  ), [isSeasonGame, scorebookTables, gameSession?.sourceId])
  const { viewedTournament, currentTournament } = useTournament()
  const tournament = viewedTournament || currentTournament
  const { player, session } = useAuth()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(tournament?.id)
  const isCommissioner = player?.is_commissioner === true
  const isScorekeeper = Boolean(player && (player.is_commissioner || player.scorebook_access))

  // ── Data state ─────────────────────────────────────────────────────────────
  const [games, setGames] = useState([])
  const [players, setPlayers] = useState([])
  const [lineups, setLineups] = useState([])
  const [characters, setCharacters] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [pitches, setPitches] = useState([])
  const [gameFielders, setGameFielders] = useState([])
  const [runsScored, setRunsScored] = useState([])
  const [inningScores, setInningScores] = useState([])
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])
  const [gameBets, setGameBets] = useState([])
  const [dataLoaded, setDataLoaded] = useState(false)

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedGameId, setSelectedGameId] = useState(gameSession?.gameId ? String(gameSession.gameId) : '')
  const [viewMode, setViewMode] = useState(() => (player && (player.is_commissioner || player.scorebook_access) ? 'scorebook' : 'game'))
  const [viewedInning, setViewedInning] = useState(null)
  const [overrideBatterIdx, setOverrideBatterIdx] = useState(null)
  const [showOutsBanner, setShowOutsBanner] = useState(false)
  const [gameEndBanner, setGameEndBanner] = useState(null)
  const [editingPa, setEditingPa] = useState(null)
  const [adminRunnerBase, setAdminRunnerBase] = useState('first')
  const [adminRunnerCharacterId, setAdminRunnerCharacterId] = useState('')
  const [showAddGame, setShowAddGame] = useState(false)
  const [addGameForm, setAddGameForm] = useState({ teamA: '', teamB: '', stage: '', stadiumId: '', isNight: false })
  const [starPitchActive, setStarPitchActive] = useState(false)
  const [starHitUsed, setStarHitUsed] = useState(false)
  const [starHitPending, setStarHitPending] = useState(false)
  const [starHitConnected, setStarHitConnected] = useState(false)
  const [pitchActionSheet, setPitchActionSheet] = useState(null)
  const [pendingPitchEvent, setPendingPitchEvent] = useState(null)
  const [paPitchRows, setPaPitchRows] = useState([])
  const [inPlayState, setInPlayState] = useState(null)
  const [rbiOverlay, setRbiOverlay] = useState(null)
  const [autoAdvanceDiamond] = useState(false)

  // ── Runner state ───────────────────────────────────────────────────────────
  // Each slot: { characterId, playerId } | null
  const [runners, setRunners] = useState({ first: null, second: null, third: null })
  const [runnersHistory, setRunnersHistory] = useState([])
  const [pendingPA, setPendingPA] = useState(null)
  const [isDragOverMound, setIsDragOverMound] = useState(false)
  const [selectedPitcher, setSelectedPitcher] = useState(null) // { charId, playerId }
  const [viewedCharacterId, setViewedCharacterId] = useState(null)
  const [viewedLineupSide, setViewedLineupSide] = useState('A')
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 720)
  useEffect(() => {
    const handleResize = () => setIsNarrowViewport(window.innerWidth <= 720)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  const [showEndGameConfirm, setShowEndGameConfirm] = useState(false)
  const [showReopenGameConfirm, setShowReopenGameConfirm] = useState(false)
  const [runnerStateLoadedScope, setRunnerStateLoadedScope] = useState(null)
  const [activePaLoadedScope, setActivePaLoadedScope] = useState(null)
  const [redoAction, setRedoAction] = useState(null)

  const outsRef = useRef(0)
  const autoPitcherAssignRef = useRef(null)
  const lastPublishedLiveStateRef = useRef('')
  const pendingLiveStateRef = useRef(null)
  const liveStatePublishTimeoutRef = useRef(null)
  const liveStatePublishSeqRef = useRef(0)
  const isSavingRef = useRef(false)
  const saveWatchdogRef = useRef(null)
  const pitchActionPendingRef = useRef(false)
  const pitchActionUnlockRef = useRef(null)
  const deferRealtimeUntilRef = useRef(0)
  const isSyncingLineupsRef = useRef(false)
  const lastSyncedLineupSignatureRef = useRef(null)
  const [isPitchActionPending, setIsPitchActionPending] = useState(false)

  // Tournament settings
  const regulationInnings = normalizeRegulationInnings(
    gameSession?.innings ?? tournament?.innings,
    DEFAULT_REGULATION_INNINGS,
  )
  const mercyOn  = gameSession?.mercyRule ?? tournament?.mercy_rule !== false
  const mercyLimit = Math.max(1, Number(gameSession?.mercyRuleDifferential || 10))

  const pushRunners = useCallback((next) => {
    setRunnersHistory(prev => [...prev, { ...runners }])
    setRunners(next)
  }, [runners])

  const popRunners = useCallback(() => {
    setRunnersHistory(prev => {
      if (!prev.length) return prev
      const last = prev[prev.length - 1]
      queueMicrotask(() => setRunners(last))
      return prev.slice(0, -1)
    })
  }, [])

  const resetRunners = useCallback((clearHistory = true) => {
    setRunners({ first: null, second: null, third: null })
    if (clearHistory) setRunnersHistory([])
  }, [])

  const unlockPitchActions = useCallback(() => {
    pitchActionPendingRef.current = false
    setIsPitchActionPending(false)
    if (pitchActionUnlockRef.current) {
      clearTimeout(pitchActionUnlockRef.current)
      pitchActionUnlockRef.current = null
    }
  }, [])

  const lockPitchActions = useCallback((unlockAfterMs = null) => {
    pitchActionPendingRef.current = true
    setIsPitchActionPending(true)
    if (pitchActionUnlockRef.current) clearTimeout(pitchActionUnlockRef.current)
    if (unlockAfterMs != null) {
      pitchActionUnlockRef.current = setTimeout(() => {
        unlockPitchActions()
      }, unlockAfterMs)
    } else {
      pitchActionUnlockRef.current = null
    }
  }, [unlockPitchActions])

  const deferRealtimeHydration = useCallback((holdMs = 1200) => {
    deferRealtimeUntilRef.current = Date.now() + holdMs
  }, [])

  const removeRunnerFromBase = useCallback((baseKey) => {
    if (!['first', 'second', 'third'].includes(baseKey)) return
    setRunners((current) => ({ ...current, [baseKey]: null }))
  }, [])

  // ── Load data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const {
        games: gamesData = [],
        players: playersData = [],
        lineups: lineupsData = [],
        characters: charsData = [],
        draftPicks: picksData = [],
        plateAppearances: pasData = [],
        pitchingStints: pitchData = [],
        pitches: pitchRowsData = [],
        gameFielders: fieldersData = [],
        runsScored: runsData = [],
        inningScores: inningScoresData = [],
        stadiums: stadiumsData = [],
        stadiumGameLog: stadiumLogData = [],
      } = await gameSession.loadScorebookData()
      setGames(gamesData || [])
      setPlayers(playersData || [])
      // Lineups/characters are refetched on every season-data refresh (e.g. live_state
      // pushes during scoring). A transient empty result shouldn't blank out the
      // already-rendered lineup/batter — keep the previous data in that case. And if
      // we just saved a lineup/fielding change locally, this refetch may hit a
      // lagging replica — keep our optimistic rows for the selected game until the
      // defer window passes so the recording page doesn't revert to stale data.
      const preserveSelectedGameRows = (prevRows, nextRows) => {
        if (!selectedGameId) return nextRows
        if (Date.now() >= deferRealtimeUntilRef.current) return nextRows
        const currentGameRows = prevRows.filter((row) => String(row.game_id) === String(selectedGameId))
        if (!currentGameRows.length) return nextRows
        return [...nextRows.filter((row) => String(row.game_id) !== String(selectedGameId)), ...currentGameRows]
      }
      setLineups(prev => preserveSelectedGameRows(prev, (lineupsData && lineupsData.length) ? lineupsData : (prev.length ? prev : lineupsData)))
      setCharacters(prev => (charsData && charsData.length) ? charsData : (prev.length ? prev : charsData))
      setDraftPicks(picksData || [])
      setPlateAppearances(pasData || [])
      setPitchingStints(pitchData || [])
      setPitches(pitchRowsData || [])
      setGameFielders(prev => preserveSelectedGameRows(prev, (fieldersData && fieldersData.length) ? fieldersData : (prev.length ? prev : fieldersData)))
      setRunsScored(runsData || [])
      setInningScores(inningScoresData || [])
      setStadiums(getOrderedStadiums(stadiumsData || []))
      setStadiumGameLog(stadiumLogData || [])
      setDataLoaded(true)
    }
    load()
  }, [gameSession, tournament?.id])

  useEffect(() => {
    setSelectedGameId(gameSession?.gameId ? String(gameSession.gameId) : '')
  }, [gameSession?.gameId])

  // PART C — load currently-open bets for this game so live odds recalculation
  // can apply volume-based line movement/liability caps, same as BettingTab.
  useEffect(() => {
    if (!selectedGameId || !scorebookTables.bets) {
      setGameBets([])
      return
    }
    let cancelled = false
    async function load() {
      const { data } = await supabase.from(scorebookTables.bets).select('*').eq('game_id', selectedGameId)
      if (!cancelled) setGameBets(data || [])
    }
    load()
    const channel = supabase
      .channel(`sb-bets-${selectedGameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.bets, filter: `game_id=eq.${selectedGameId}` }, load)
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [selectedGameId, scorebookTables.bets])

  const shouldDeferRealtimeMerge = useCallback((currentRows = [], nextRows = [], getId = (row) => row.id) => {
    if (Date.now() > deferRealtimeUntilRef.current) return false
    if (nextRows.length < currentRows.length) return true
    if (nextRows.length !== currentRows.length) return false
    const currentIds = currentRows.map((row) => String(getId(row))).sort()
    const nextIds = nextRows.map((row) => String(getId(row))).sort()
    return currentIds.length > 0 && currentIds.every((id, index) => id === nextIds[index])
  }, [])

  // ── Realtime ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedGameId) return
    const channel = supabase
      .channel(`sb-${selectedGameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.lineups, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.lineups).select('*').eq('game_id', selectedGameId).order('batting_order')
        const nextRows = data || []
        setLineups((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.plateAppearances, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGameId).order('created_at')
        const nextRows = data || []
        setPlateAppearances((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitchingStints, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.pitchingStints).select('*').eq('game_id', selectedGameId).order('created_at')
        const nextRows = data || []
        setPitchingStints((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitches, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGameId).order('created_at')
        const nextRows = data || []
        setPitches((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.gameFielders, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.gameFielders).select('*').eq('game_id', selectedGameId).order('created_at')
        const nextRows = data || []
        setGameFielders((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.runsScored, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGameId).order('created_at')
        const nextRows = data || []
        setRunsScored((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.inningScores, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const query = supabase.from(scorebookTables.inningScores).select('*').eq('game_id', selectedGameId).order('inning')
        const { data } = isSeasonGame
          ? await query.eq('season_id', gameSession?.sourceId)
          : await query
        const normalized = isSeasonGame
          ? (data || []).map((entry) => ({
              ...entry,
              player_id: gameSession.playerIdByTeamId?.[entry.team_id] || null,
            }))
          : (data || [])
        setInningScores((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, normalized, (row) => `${row.inning}:${row.player_id || row.team_id || row.id}`)) {
            return current
          }
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...normalized]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: scorebookTables.games, filter: `id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.games).select('*').eq('id', selectedGameId).single()
        if (!data) return
        const stadiumByName = Object.fromEntries(stadiums.map((stadium) => [stadium.name, stadium]))
        const normalized = isSeasonGame
          ? {
              ...data,
              source_id: data.season_id,
              tournament_id: data.season_id,
              stadium_id: stadiumByName[data.stadium]?.id || null,
              game_code: data.stage ? `S${data.season_id}-${data.stage}` : `R${data.round_number}-G${data.id}`,
              team_a_player_id: gameSession.playerIdByTeamId?.[data.away_team_id] || null,
              team_b_player_id: gameSession.playerIdByTeamId?.[data.home_team_id] || null,
              winner_player_id: gameSession.playerIdByTeamId?.[data.winner_team_id] || null,
              team_a_runs: Number(data.away_score || 0),
              team_b_runs: Number(data.home_score || 0),
              status: data.status === 'completed' ? 'complete' : data.status === 'in_progress' ? 'active' : data.status === 'scheduled' ? 'pending' : data.status,
            }
          : data
        setGames((current) => current.map((game) => (String(game.id) === String(normalized.id) ? normalized : game)))
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [selectedGameId, scorebookTables, isSeasonGame, gameSession?.sourceId, gameSession?.playerIdByTeamId, stadiums, shouldDeferRealtimeMerge])

  useEffect(() => {
    if (!gameSession?.sourceId || !scorebookTables.draftPicks) return
    const sourceField = isSeasonGame ? 'season_id' : 'tournament_id'
    const orderField = isSeasonGame ? 'created_at' : 'pick_number'
    const channel = supabase
      .channel(`scorebook-roster-${gameSession.sourceId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.draftPicks, filter: `${sourceField}=eq.${gameSession.sourceId}` }, async () => {
        const { data } = await supabase.from(scorebookTables.draftPicks).select('*').eq(sourceField, gameSession.sourceId).order(orderField)
        setDraftPicks(data || [])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [gameSession?.sourceId, scorebookTables.draftPicks, isSeasonGame])

  useEffect(() => {
    const channel = supabase
      .channel(`scorebook-stadiums-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, async () => {
        const { data } = await supabase.from('stadiums').select('*')
        setStadiums(getOrderedStadiums(data || []))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.stadiumGameLog, filter: isSeasonGame ? `season_id=eq.${gameSession?.sourceId}` : undefined }, async () => {
        const query = supabase.from(scorebookTables.stadiumGameLog).select('*').order('created_at')
        const { data } = isSeasonGame ? await query.eq('season_id', gameSession?.sourceId) : await query
        setStadiumGameLog(data || [])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [scorebookTables.stadiumGameLog, isSeasonGame, gameSession?.sourceId])

  // ── Derived state ──────────────────────────────────────────────────────────
  const filteredGames = useMemo(
    () => games.filter(g => !gameSession?.sourceId || g.tournament_id === gameSession.sourceId),
    [games, gameSession?.sourceId],
  )
  const selectedGame  = filteredGames.find(g => String(g.id) === String(selectedGameId))
  const isGameComplete = selectedGame?.status === 'complete' || selectedGame?.status === 'completed'
  const canEditScorebook = Boolean(isScorekeeper && selectedGame && !isGameComplete)
  const selectedGameLiveState = useMemo(
    () => normalizeLiveState(selectedGame?.live_state),
    [selectedGame?.live_state],
  )
  const playersById   = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((stadium) => [stadium.id, stadium])), [stadiums])
  const selectedStadium = selectedGame?.stadium_id ? stadiumsById[selectedGame.stadium_id] : null
  const selectedAddGameStadium = addGameForm.stadiumId ? stadiumsById[addGameForm.stadiumId] : stadiums[0] || null

  useEffect(() => {
    setViewedInning(null)
    setGameEndBanner(null)
    setPendingPA(null)
    resetRunners()
    setSelectedPitcher(null)
  }, [selectedGameId, resetRunners])

  useEffect(() => {
    if (!stadiums.length) return
    setAddGameForm((current) => {
      if (current.stadiumId && stadiumsById[current.stadiumId]) {
        return {
          ...current,
          isNight: normalizeIsNightForStadium(stadiumsById[current.stadiumId], current.isNight),
        }
      }
      return {
        ...current,
        stadiumId: stadiums[0].id,
        isNight: normalizeIsNightForStadium(stadiums[0], current.isNight),
      }
    })
  }, [stadiums, stadiumsById])

  const gamePAs = useMemo(
    () => plateAppearances.filter(p => String(p.game_id) === String(selectedGameId)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    [plateAppearances, selectedGameId],
  )
  const gamePitching = useMemo(
    () => pitchingStints.filter(p => String(p.game_id) === String(selectedGameId)),
    [pitchingStints, selectedGameId],
  )
  const gamePitches = useMemo(
    () => pitches.filter((pitch) => String(pitch.game_id) === String(selectedGameId)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    [pitches, selectedGameId],
  )
  const gameFielderRows = useMemo(
    () => gameFielders.filter((fielder) => String(fielder.game_id) === String(selectedGameId)),
    [gameFielders, selectedGameId],
  )
  const gameRuns = useMemo(
    () => runsScored.filter((run) => String(run.game_id) === String(selectedGameId)),
    [runsScored, selectedGameId],
  )
  const gameInningScores = useMemo(
    () => inningScores.filter((row) => String(row.game_id) === String(selectedGameId)),
    [inningScores, selectedGameId],
  )
  const gameLineups = useMemo(
    () => lineups.filter(l => String(l.game_id) === String(selectedGameId)).sort((a, b) => a.batting_order - b.batting_order),
    [lineups, selectedGameId],
  )

  // Which team bats first (top of inning 1) — stored on the game row so it's
  // shared across every scorekeeper's device and every recorded plate appearance
  // uses the same batting order. Can only be flipped before the first PA is
  // recorded, since changing it mid-game would re-attribute completed innings to
  // the wrong team.
  const homeAwaySwapped = !!selectedGame?.home_away_swapped
  const toggleHomeAwaySwap = useCallback(async () => {
    if (!selectedGame) return
    if (gamePAs.length > 0) {
      pushToast({ title: 'Cannot swap now', message: 'Home/Away can only be swapped before the first plate appearance is recorded.', type: 'error' })
      return
    }
    const next = !selectedGame.home_away_swapped
    const { error } = await supabase.from(scorebookTables.games).update({ home_away_swapped: next }).eq('id', selectedGame.id)
    if (error) {
      pushToast({ title: 'Swap failed', message: error.message, type: 'error' })
      return
    }
    setGames((current) => current.map((g) => (String(g.id) === String(selectedGame.id) ? { ...g, home_away_swapped: next } : g)))
  }, [selectedGame, gamePAs.length, scorebookTables.games, pushToast])

  const outsRecorded = useMemo(() => gamePAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0), [gamePAs])
  useEffect(() => { outsRef.current = outsRecorded }, [outsRecorded])

  const outsInHalf = outsRecorded % 3
  const selectionOutsInHalf = useMemo(() => {
    if (!editingPa) return outsInHalf
    const editingIndex = gamePAs.findIndex((pa) => String(pa.id) === String(editingPa.id))
    if (editingIndex === -1) return outsInHalf
    const outsBeforeEditingPa = gamePAs
      .slice(0, editingIndex)
      .reduce((sum, pa) => sum + calculateOutsForPa(pa.result), 0)
    return outsBeforeEditingPa % 3
  }, [editingPa, gamePAs, outsInHalf])
  const offense = useMemo(() => selectedGame ? deriveOffense(selectedGame, outsRecorded) : null, [selectedGame, outsRecorded])

  // Batting/pitching team display info
  const battingPlayer  = selectedGame ? playersById[offense?.battingPlayerId]  : null
  const pitchingPlayer = selectedGame ? playersById[offense?.pitchingPlayerId] : null
  const teamAPlayer    = selectedGame ? playersById[selectedGame.team_a_player_id] : null
  const teamBPlayer    = selectedGame ? playersById[selectedGame.team_b_player_id] : null
  const teamAName      = teamAPlayer?.name || 'Team A'
  const teamBName      = teamBPlayer?.name || 'Team B'
  const teamAIdentity  = identitiesByPlayerId[selectedGame?.team_a_player_id] || null
  const teamBIdentity  = identitiesByPlayerId[selectedGame?.team_b_player_id] || null
  const battingIdentity  = identitiesByPlayerId[offense?.battingPlayerId] || null
  const pitchingIdentity = identitiesByPlayerId[offense?.pitchingPlayerId] || null
  const teamAColor     = getTeamPrimaryColor(teamAIdentity, teamAPlayer?.color) || C.blue
  const teamBColor     = getTeamPrimaryColor(teamBIdentity, teamBPlayer?.color) || C.red
  const teamAAbbreviation = teamAPlayer?.team_abbreviation || teamAName.slice(0, 4).toUpperCase()
  const teamBAbbreviation = teamBPlayer?.team_abbreviation || teamBName.slice(0, 4).toUpperCase()
  const teamALogoUrl   = teamAIdentity?.teamLogoUrl || teamAPlayer?.team_logo_url || null
  const teamBLogoUrl   = teamBIdentity?.teamLogoUrl || teamBPlayer?.team_logo_url || null
  const teamALogoKey   = teamAIdentity?.teamLogoKey || null
  const teamBLogoKey   = teamBIdentity?.teamLogoKey || null
  const battingColor   = getTeamPrimaryColor(battingIdentity, battingPlayer?.color)   || C.accent
  const pitchingColor  = getTeamPrimaryColor(pitchingIdentity, pitchingPlayer?.color) || C.muted

  const currentInning  = offense?.inning || 1
  const currentHalfIdx = Math.floor(outsRecorded / 3)

  // Current (batting) lineup — offensive team
  const currentLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.battingPlayerId),
    [gameLineups, offense],
  )
  // Defensive lineup — pitching team (draggable to mound)
  const defensiveLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.pitchingPlayerId),
    [gameLineups, offense],
  )

  const autoIdx = useMemo(() => {
    if (!currentLineup.length) return 0
    return gamePAs.filter(pa => pa.player_id === offense?.battingPlayerId).length % currentLineup.length
  }, [gamePAs, currentLineup, offense])
  const currentHalfPaCount = useMemo(
    () => gamePAs.filter(
      (pa) => Number(pa.inning) === Number(currentInning) && String(pa.player_id) === String(offense?.battingPlayerId),
    ).length,
    [gamePAs, currentInning, offense?.battingPlayerId],
  )

  const effectiveBatterIdx = overrideBatterIdx !== null
    ? overrideBatterIdx % Math.max(currentLineup.length, 1)
    : autoIdx
  const currentBatter  = currentLineup[effectiveBatterIdx]
  const onDeckBatter   = currentLineup[(effectiveBatterIdx + 1) % Math.max(currentLineup.length, 1)]

  // Current pitcher (last stint for defensive team this game)
  const currentPitcherStint = useMemo(() => {
    if (!offense) return null
    const stints = gamePitching.filter(s => s.player_id === offense.pitchingPlayerId)
    return stints[stints.length - 1] ?? null
  }, [gamePitching, offense])
  const currentPitcherChar = currentPitcherStint ? charactersById[currentPitcherStint.character_id] : null
  const openPaEditor = useCallback((pa) => {
    if (!pa) return
    const batter = gameLineups.find((lineupEntry) => (
      String(lineupEntry.character_id) === String(pa.character_id)
      && String(lineupEntry.player_id) === String(pa.player_id)
    ))
    setEditingPa(pa)
    setViewMode('scorebook')
    if (batter) {
      const idx = currentLineup.findIndex((lineupEntry) => String(lineupEntry.id) === String(batter.id))
      if (idx >= 0) setOverrideBatterIdx(idx)
    }
  }, [gameLineups, currentLineup])
  const adminRunnerOptions = useMemo(() => {
    const occupiedIds = new Set([
      runners.first?.characterId,
      runners.second?.characterId,
      runners.third?.characterId,
    ].filter(Boolean).map(String))
    return currentLineup.filter((entry) => !occupiedIds.has(String(entry.character_id)))
  }, [currentLineup, runners.first?.characterId, runners.second?.characterId, runners.third?.characterId])
  const addAdminRunner = useCallback(() => {
    const selectedEntry = currentLineup.find((entry) => String(entry.character_id) === String(adminRunnerCharacterId))
    if (!selectedEntry) {
      pushToast({ title: 'Pick a runner', message: 'Choose a batter from the current offensive lineup first.', type: 'error' })
      return
    }
    if (!['first', 'second', 'third'].includes(adminRunnerBase)) {
      pushToast({ title: 'Pick a base', message: 'Choose which base to populate.', type: 'error' })
      return
    }
    if (runners[adminRunnerBase]) {
      pushToast({ title: 'Base occupied', message: 'Clear that base before adding a new runner.', type: 'error' })
      return
    }
    setRunners((current) => ({
      ...current,
      [adminRunnerBase]: {
        characterId: selectedEntry.character_id,
        playerId: selectedEntry.player_id,
        chargedToPitcherId: currentPitcherStint?.character_id ?? null,
        chargedToPitcherPlayerId: currentPitcherStint?.player_id ?? null,
      },
    }))
    setAdminRunnerCharacterId('')
  }, [adminRunnerBase, adminRunnerCharacterId, currentLineup, currentPitcherStint, pushToast, runners])
  const currentPitcherPitchRows = useMemo(() => (
    currentPitcherChar
      ? gamePitches.filter((pitch) => pitch.pitcher_id === currentPitcherChar.name)
      : []
  ), [gamePitches, currentPitcherChar])
  useEffect(() => {
    if (!adminRunnerCharacterId) return
    if (!currentLineup.some((entry) => String(entry.character_id) === String(adminRunnerCharacterId))) {
      setAdminRunnerCharacterId('')
    }
  }, [adminRunnerCharacterId, currentLineup])
  const activePaNumber = editingPa?.pa_number ?? (gamePAs.length + 1)
  const currentPitcherStorageKey = currentPitcherStint?.id || currentPitcherStint?.character_id || 'none'
  const currentActivePaScope = selectedGameId && currentBatter?.id
    ? `${selectedGameId}:${activePaNumber}:${currentBatter.id}`
    : null
  const {
    balls,
    strikes,
    pitchNumber,
    resetPa: resetPitchCount,
    restoreState: restorePitchState,
    recordBall,
    recordStrike,
    recordFoul,
    recordHbp,
    recordInPlay,
    undoPitch,
  } = usePitchCount({
    pitcherKey: currentPitcherStorageKey,
    initialPitchNumber: currentPitcherPitchRows.length,
  })
  const clearRedoAction = useCallback(() => {
    setRedoAction(null)
  }, [])

  const restoreActivePaSnapshot = useCallback((snapshot) => {
    if (!snapshot) return
    restorePitchState({
      balls: Number(snapshot.balls || 0),
      strikes: Number(snapshot.strikes || 0),
      pitchNumber: Number(snapshot.pitchNumber || 0),
    })
    setPaPitchRows(Array.isArray(snapshot.paPitchRows) ? snapshot.paPitchRows : [])
    setPendingPA(snapshot.pendingPA || null)
    setPitchActionSheet(snapshot.pitchActionSheet || null)
    setPendingPitchEvent(snapshot.pendingPitchEvent || null)
    setInPlayState(snapshot.inPlayState || null)
    setRbiOverlay(snapshot.rbiOverlay || null)
    setStarPitchActive(Boolean(snapshot.starPitchActive))
    setStarHitUsed(Boolean(snapshot.starHitUsed))
    setStarHitPending(Boolean(snapshot.starHitPending))
    setStarHitConnected(Boolean(snapshot.starHitConnected))
  }, [restorePitchState])

  const buildActivePaSnapshot = useCallback(() => ({
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
  }), [
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
  ])

  const cancelPendingResolution = useCallback(() => {
    if (pendingPA?.rollbackSnapshot) {
      restoreActivePaSnapshot(pendingPA.rollbackSnapshot)
      return
    }
    setPendingPA(null)
  }, [pendingPA, restoreActivePaSnapshot])

  const cancelInPlaySelection = useCallback(() => {
    if (inPlayState?.rollbackSnapshot) {
      restoreActivePaSnapshot(inPlayState.rollbackSnapshot)
      return
    }
    setInPlayState(null)
    setPendingPitchEvent(null)
  }, [inPlayState, restoreActivePaSnapshot])

  const activeDefensiveFielders = useMemo(() => {
    if (!offense) return {}
    const defensiveTeamId = isSeasonGame
      ? gameSession.teamIdByPlayerId?.[offense.pitchingPlayerId] || null
      : offense.pitchingPlayerId
    return gameFielderRows.reduce((acc, row) => {
      if (
        String(row.team_id) === String(defensiveTeamId) &&
        Number(row.inning_from || 1) <= Number(currentInning) &&
        (row.inning_to == null || Number(row.inning_to) >= Number(currentInning))
      ) {
        acc[String(row.position)] = row
      }
      return acc
    }, {})
  }, [gameFielderRows, offense, currentInning, isSeasonGame, gameSession.teamIdByPlayerId])

  const currentHalfHasError = useMemo(() => (
    offense
      ? gamePAs.some((pa) => Number(pa.inning) === Number(currentInning) && String(pa.player_id) === String(offense.battingPlayerId) && pa.is_error)
      : false
  ), [gamePAs, offense, currentInning])

  const teamRosters = useMemo(() => {
    if (!selectedGame) return { teamA: [], teamB: [] }
    const picks = draftPicks.filter(p => p.tournament_id === selectedGame.tournament_id)
    return {
      teamA: picks.filter(p => p.player_id === selectedGame.team_a_player_id),
      teamB: picks.filter(p => p.player_id === selectedGame.team_b_player_id),
    }
  }, [draftPicks, selectedGame])

  const buildRosterCharMap = useCallback((picks) => Object.fromEntries(
    picks
      .filter((p) => p.character_id && charactersById[p.character_id])
      .map((p) => {
        const character = charactersById[p.character_id]
        return [p.character_id, {
          ...character,
          miiColor: p.mii_color,
          displayName: formatCharacterDisplayName(character.name, p.mii_color),
          chemistryName: getCharacterChemistryName(character.name, p.mii_color),
        }]
      }),
  ), [charactersById])

  const rosterCharMaps = useMemo(() => ({
    A: buildRosterCharMap(teamRosters.teamA),
    B: buildRosterCharMap(teamRosters.teamB),
  }), [buildRosterCharMap, teamRosters])

  const inningScoreMaps = useMemo(() => {
    if (!selectedGame) return { a: {}, b: {} }
    if (!gameInningScores.length) {
      return {
        a: inningRunsFromPAs(gamePAs, selectedGame.team_a_player_id, gameRuns),
        b: inningRunsFromPAs(gamePAs, selectedGame.team_b_player_id, gameRuns),
      }
    }
    return {
      a: inningRunsFromRows(gameInningScores, selectedGame.team_a_player_id),
      b: inningRunsFromRows(gameInningScores, selectedGame.team_b_player_id),
    }
  }, [selectedGame, gameInningScores, gamePAs, gameRuns])

  const scores = useMemo(() => {
    if (!selectedGame) return { a: 0, b: 0, aByInning: {}, bByInning: {}, aHits: 0, bHits: 0, aErrors: 0, bErrors: 0 }
    if (selectedGame.status === 'complete') {
      return {
        a: Number(selectedGame.team_a_runs || 0),
        b: Number(selectedGame.team_b_runs || 0),
        aByInning: inningScoreMaps.a,
        bByInning: inningScoreMaps.b,
        aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
        bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
        aErrors: errorsFromPAs(gamePAs, selectedGame.team_a_player_id, selectedGame.team_b_player_id),
        bErrors: errorsFromPAs(gamePAs, selectedGame.team_b_player_id, selectedGame.team_a_player_id),
      }
    }
    return {
      a: runsFromPAs(gamePAs, selectedGame.team_a_player_id, gameRuns),
      b: runsFromPAs(gamePAs, selectedGame.team_b_player_id, gameRuns),
      aByInning: inningScoreMaps.a,
      bByInning: inningScoreMaps.b,
      aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
      bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
      aErrors: errorsFromPAs(gamePAs, selectedGame.team_a_player_id, selectedGame.team_b_player_id),
      bErrors: errorsFromPAs(gamePAs, selectedGame.team_b_player_id, selectedGame.team_a_player_id),
    }
  }, [gamePAs, selectedGame, inningScoreMaps, gameRuns])

  // Home/Away ordering for the line score strip. `homeAwaySwapped` (from the
  // game row) determines which team actually bats in the top of the inning —
  // the "away" row is always drawn first, "home" second.
  const lineScoreRows = useMemo(() => {
    const teamARow = { battingSide: homeAwaySwapped ? 'home' : 'away', abbreviation: teamAAbbreviation, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl, teamName: teamAName, scoreMap: scores.aByInning, runs: scores.a, hits: scores.aHits, errors: scores.aErrors }
    const teamBRow = { battingSide: homeAwaySwapped ? 'away' : 'home', abbreviation: teamBAbbreviation, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl, teamName: teamBName, scoreMap: scores.bByInning, runs: scores.b, hits: scores.bHits, errors: scores.bErrors }
    return teamARow.battingSide === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
  }, [homeAwaySwapped, teamAAbbreviation, teamAColor, teamALogoKey, teamALogoUrl, teamAName, teamBAbbreviation, teamBColor, teamBLogoKey, teamBLogoUrl, teamBName, scores])

  const tournamentGameIds = useMemo(
    () => new Set(filteredGames.map(g => String(g.id))),
    [filteredGames],
  )

  const characterSeasonStats = useMemo(() => {
    if (!currentBatter) return null
    const tournPAs = plateAppearances.filter(pa =>
      pa.character_id === currentBatter.character_id &&
      tournamentGameIds.has(String(pa.game_id)),
    )
    return summarizeBatting(tournPAs)
  }, [plateAppearances, currentBatter, tournamentGameIds])

  const characterCareerStats = useMemo(() => {
    if (!currentBatter) return null
    return summarizeBatting(plateAppearances.filter(pa => pa.character_id === currentBatter.character_id))
  }, [plateAppearances, currentBatter])

  const currentBatterGamePAs = useMemo(() => {
    if (!currentBatter) return []
    return gamePAs.filter(pa => pa.character_id === currentBatter.character_id && pa.player_id === currentBatter.player_id)
  }, [gamePAs, currentBatter])
  const currentBatterGameSummary = useMemo(
    () => summarizeBatting(currentBatterGamePAs),
    [currentBatterGamePAs],
  )

  const teamALineup = useMemo(
    () => gameLineups.filter((entry) => String(entry.player_id) === String(selectedGame?.team_a_player_id)),
    [gameLineups, selectedGame?.team_a_player_id],
  )
  const teamBLineup = useMemo(
    () => gameLineups.filter((entry) => String(entry.player_id) === String(selectedGame?.team_b_player_id)),
    [gameLineups, selectedGame?.team_b_player_id],
  )

  // ── Live lineup/fielding editor (commissioner & scorekeepers) ──────────────
  // Mirrors the Roster tab's lineup ordering + fielding diamond (DraggableRosterItem / FieldingView)
  const teamAId = isSeasonGame ? gameSession.teamIdByPlayerId?.[selectedGame?.team_a_player_id] : selectedGame?.team_a_player_id
  const teamBId = isSeasonGame ? gameSession.teamIdByPlayerId?.[selectedGame?.team_b_player_id] : selectedGame?.team_b_player_id

  const [lineupDrafts, setLineupDrafts] = useState({ A: { order: [], fielding: {} }, B: { order: [], fielding: {} } })
  const [selectedLineupMoveId, setSelectedLineupMoveId] = useState({ A: null, B: null })
  const [selectedFieldingPlayer, setSelectedFieldingPlayer] = useState({ A: null, B: null })
  const [lineupSaveStatus, setLineupSaveStatus] = useState({ A: 'idle', B: 'idle' })
  // Tracks whether each team's draft has unsaved local edits, so realtime-driven
  // draft rebuilds (from someone else's edits) don't clobber our in-flight edit.
  const lineupDirtyRef = useRef({ A: false, B: false })
  // Tracks the last { lineupOrder, fieldingPositions } JSON synced to/from
  // team_lineups/season_team_lineups for each team, to avoid save loops with
  // the Roster/SeasonRoster realtime sync.
  const lastSyncedTeamLineupRef = useRef({ A: null, B: null })
  const changePitcherRef = useRef(null)

  const buildLineupDraft = useCallback((team) => {
    const lineupRows = team === 'A' ? teamALineup : teamBLineup
    const teamId = team === 'A' ? teamAId : teamBId
    const order = lineupRows.map((row) => row.character_id)
    const fielding = {}
    lineupRows.forEach((row) => {
      const charName = charactersById[row.character_id]?.name
      const activeRow = gameFielderRows.find((r) => (
        String(r.team_id) === String(teamId)
        && r.character === charName
        && Number(r.inning_from || 1) <= Number(currentInning)
        && (r.inning_to == null || Number(r.inning_to) >= Number(currentInning))
      ))
      const fieldId = activeRow ? SCOREBOOK_POSITION_TO_FIELD_ID[Number(activeRow.position)] : null
      if (fieldId) fielding[fieldId] = row.character_id
    })

    // There's no bench in Sluggers — every player in the lineup fields a
    // position. Fill any positions left empty (e.g. no game_fielders rows
    // yet) with the remaining lineup players in batting order.
    const placedIds = new Set(Object.values(fielding))
    const unplaced = order.filter((charId) => !placedIds.has(charId))
    const emptyFieldIds = FIELD_POSITIONS.map((p) => p.id).filter((fieldId) => !fielding[fieldId])
    unplaced.forEach((charId, index) => {
      if (emptyFieldIds[index]) fielding[emptyFieldIds[index]] = charId
    })

    return { order, fielding }
  }, [teamALineup, teamBLineup, teamAId, teamBId, charactersById, gameFielderRows, currentInning])

  // Rebuild the draft for a team whenever the underlying lineup/fielder rows
  // change (including via realtime updates from other editors) — unless that
  // team's draft has unsaved local edits in flight.
  useEffect(() => {
    if (viewMode !== 'lineups' || !selectedGame) return
    setLineupDrafts((current) => ({
      A: lineupDirtyRef.current.A ? current.A : buildLineupDraft('A'),
      B: lineupDirtyRef.current.B ? current.B : buildLineupDraft('B'),
    }))
  }, [viewMode, selectedGame?.id, buildLineupDraft])

  useEffect(() => {
    if (viewMode !== 'lineups' || !selectedGame) return
    setSelectedLineupMoveId({ A: null, B: null })
    setSelectedFieldingPlayer({ A: null, B: null })
    lineupDirtyRef.current = { A: false, B: false }
    setLineupSaveStatus({ A: 'idle', B: 'idle' })
  }, [viewMode, selectedGame?.id])


  const handleLineupDragStart = useCallback((characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
    e.dataTransfer.setData('lineupCharacterId', String(characterId))
  }, [])

  const reorderLineupDraft = useCallback((team, characterId, targetIndex) => {
    setLineupDrafts((current) => {
      const order = [...current[team].order]
      const sourceIdx = order.indexOf(characterId)
      if (sourceIdx === -1) return current
      order.splice(sourceIdx, 1)
      order.splice(targetIndex, 0, characterId)
      lineupDirtyRef.current = { ...lineupDirtyRef.current, [team]: true }
      return { ...current, [team]: { ...current[team], order } }
    })
  }, [])

  const handleLineupNumberClick = useCallback((team, charId, index) => {
    setSelectedLineupMoveId((current) => {
      const sel = current[team]
      if (sel === null) return { ...current, [team]: charId }
      if (sel === charId) return { ...current, [team]: null }
      reorderLineupDraft(team, sel, index)
      return { ...current, [team]: null }
    })
  }, [reorderLineupDraft])

  const handleDropOnLineupSlot = useCallback((team, index) => (e) => {
    e.preventDefault()
    const characterId = parseInt(e.dataTransfer.getData('lineupCharacterId'), 10)
    if (characterId) reorderLineupDraft(team, characterId, index)
  }, [reorderLineupDraft])

  const setFieldingPositionsForTeam = useCallback((team) => (updater) => {
    setLineupDrafts((current) => {
      const fielding = typeof updater === 'function' ? updater(current[team].fielding) : updater
      lineupDirtyRef.current = { ...lineupDirtyRef.current, [team]: true }
      return { ...current, [team]: { ...current[team], fielding } }
    })
  }, [])

  const setSelectedFieldingPlayerForTeam = useCallback((team) => (updater) => {
    setSelectedFieldingPlayer((current) => {
      const value = typeof updater === 'function' ? updater(current[team]) : updater
      return { ...current, [team]: value }
    })
  }, [])

  // Applies a lineup order + fielding assignment for `team` to the
  // lineups/game_fielders tables (and mirrors it into team_lineups unless
  // `skipMirror` is set, e.g. when the change originated from team_lineups
  // itself via the Roster/SeasonRoster realtime sync below).
  const applyLineupToGame = useCallback(async (team, order, fielding, { skipMirror = false } = {}) => {
    if (!selectedGame) return
    const teamId = team === 'A' ? teamAId : teamBId
    const playerId = team === 'A' ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
    const lineupRows = team === 'A' ? teamALineup : teamBLineup

    const lineupUpdates = order
      .map((characterId, i) => {
        const row = lineupRows[i]
        if (!row) return null
        if (row.character_id === characterId && row.batting_order === i + 1) return null
        return supabase.from(scorebookTables.lineups).update({ character_id: characterId, batting_order: i + 1 }).eq('id', row.id).select()
      })
      .filter(Boolean)

    const results = await Promise.all(lineupUpdates)
    const failed = results.find((r) => r.error)
    if (failed) {
      pushToast({ title: 'Lineup save failed', message: failed.error.message, type: 'error' })
      return
    }
    const noRowsUpdated = results.find((r) => !r.data || r.data.length === 0)
    if (noRowsUpdated) {
      pushToast({ title: 'Lineup save failed', message: 'No lineup rows were updated. You may not have permission to edit this lineup.', type: 'error' })
      return
    }

    const openRows = gameFielderRows.filter((r) => String(r.team_id) === String(teamId) && r.inning_to == null)
    const toClose = openRows.filter((r) => Number(r.inning_from || 1) < Number(currentInning))
    const toDelete = openRows.filter((r) => Number(r.inning_from || 1) >= Number(currentInning))

    if (toClose.length) {
      const { error } = await supabase.from(scorebookTables.gameFielders).update({ inning_to: Number(currentInning) - 1 }).in('id', toClose.map((r) => r.id)).select()
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
    }
    if (toDelete.length) {
      const { error } = await supabase.from(scorebookTables.gameFielders).delete().in('id', toDelete.map((r) => r.id)).select()
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
    }

    const newFielderRows = Object.entries(fielding)
      .filter(([, characterId]) => characterId)
      .map(([fieldId, characterId]) => ({
        game_id: selectedGame.id,
        team_id: teamId,
        player_name: playersById[playerId]?.name || '',
        character: charactersById[characterId]?.name || '',
        position: FIELD_ID_TO_SCOREBOOK_POSITION[fieldId],
        inning_from: currentInning,
        inning_to: null,
      }))

    let insertedFielderRows = []
    if (newFielderRows.length) {
      const { data, error } = await supabase.from(scorebookTables.gameFielders).insert(newFielderRows.map(addSourceFields)).select()
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
      insertedFielderRows = data || newFielderRows.map(addSourceFields)
    }

    // Hold off on merging the realtime echo of this save — a read against a lagging
    // replica could otherwise return pre-update rows and clobber the optimistic state below.
    deferRealtimeHydration()

    const closedIds = new Set(toClose.map((r) => String(r.id)))
    const deletedIds = new Set(toDelete.map((r) => String(r.id)))
    setLineups((current) => current.map((row) => {
      const idx = lineupRows.findIndex((r) => String(r.id) === String(row.id))
      if (idx === -1) return row
      return { ...row, character_id: order[idx], batting_order: idx + 1 }
    }))
    setGameFielders((current) => [
      ...current
        .filter((row) => !deletedIds.has(String(row.id)))
        .map((row) => (closedIds.has(String(row.id)) ? { ...row, inning_to: Number(currentInning) - 1 } : row)),
      ...insertedFielderRows,
    ])

    // Mirror this lineup/fielding change into team_lineups (or
    // season_team_lineups), so Roster/SeasonRoster pick it up live, and the
    // other team's Scorebook session re-syncs its draft. Skipped when the
    // change originated from team_lineups itself, to avoid an echo loop.
    if (!skipMirror) {
      const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
      const teamLineupPayload = JSON.stringify({ lineupOrder: order, fieldingPositions: fielding })
      if (teamLineupPayload !== lastSyncedTeamLineupRef.current[team]) {
        lastSyncedTeamLineupRef.current[team] = teamLineupPayload
        upsertTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId, lineupOrder: order, fieldingPositions: fielding })
      }
    }

    // If this team is currently on defense and the pitcher assignment
    // changed, record an actual pitching change so the mound, game view,
    // scorebook field diagram, and bets tab all update.
    const newPitcherCharId = fielding.pitcher ? Number(fielding.pitcher) : null
    if (newPitcherCharId && offense?.pitchingPlayerId === playerId && newPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      changePitcherRef.current?.(playerId, newPitcherCharId)
    }
  }, [selectedGame, teamAId, teamBId, teamALineup, teamBLineup, scorebookTables.lineups, scorebookTables.gameFielders, gameFielderRows, currentInning, playersById, charactersById, addSourceFields, pushToast, teamAName, teamBName, isSeasonGame, gameSession, offense, currentPitcherStint])

  const saveTeamLineup = useCallback((team) => {
    const { order, fielding } = lineupDrafts[team]
    return applyLineupToGame(team, order, fielding)
  }, [lineupDrafts, applyLineupToGame])

  const applyLineupToGameRef = useRef(null)
  useEffect(() => { applyLineupToGameRef.current = applyLineupToGame }, [applyLineupToGame])

  // Shared handler for an incoming team_lineups/season_team_lineups row
  // (from realtime or from the polling fallback below): updates this
  // Scorebook session's draft, and — if this session can write to
  // lineups/game_fielders — applies it there too.
  const applyIncomingTeamLineup = useCallback((team, lineupOrder, fieldingPositions) => {
    const payloadJson = JSON.stringify({ lineupOrder, fieldingPositions })
    if (payloadJson === lastSyncedTeamLineupRef.current[team]) return
    lastSyncedTeamLineupRef.current[team] = payloadJson

    if (!lineupDirtyRef.current[team]) {
      setLineupDrafts((current) => ({ ...current, [team]: { order: lineupOrder, fielding: fieldingPositions } }))
    }
    // Only a scorekeeper/commissioner session can write to
    // lineups/game_fielders (per RLS) — other viewers just update their
    // local draft above and pick up the lineups/game_fielders rows via
    // those tables' own realtime subscriptions once a scorekeeper
    // session applies the change.
    if (canEditScorebook) {
      applyLineupToGameRef.current?.(team, lineupOrder, fieldingPositions, { skipMirror: true })
    }
  }, [canEditScorebook])

  // Realtime: pick up lineup/fielding edits made via Roster/SeasonRoster (or
  // another Scorebook session) for either team in this game, and apply them
  // to lineups/game_fielders so the Lineups tab, field diagram, game view,
  // and bets tab all update live.
  useEffect(() => {
    const sourceId = gameSession?.sourceId
    const teamAPlayerId = selectedGame?.team_a_player_id
    const teamBPlayerId = selectedGame?.team_b_player_id
    if (!sourceId || (!teamAPlayerId && !teamBPlayerId)) return

    const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
    const channel = supabase
      .channel(`scorebook-team-lineups-${sourceId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: teamLineupsTable.table,
        filter: `${teamLineupsTable.idField}=eq.${sourceId}`,
      }, (payload) => {
        const row = payload.new
        if (!row) return
        let team = null
        if (String(row.player_id) === String(teamAPlayerId)) team = 'A'
        else if (String(row.player_id) === String(teamBPlayerId)) team = 'B'
        if (!team) return

        const lineupOrder = Array.isArray(row.lineup_order) ? row.lineup_order : []
        const fieldingPositions = row.fielding_positions && typeof row.fielding_positions === 'object' ? row.fielding_positions : {}
        applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
      })
      .subscribe()

    // Realtime postgres_changes can silently fail to deliver in some
    // environments (and browsers throttle websockets on backgrounded tabs),
    // so poll both teams' saved lineup/fielding as a fallback to guarantee
    // they stay in sync everywhere — including a pitcher change made while
    // that team was batting, which gets applied the moment they take the
    // mound via the offense-change effect below.
    const pollTeamLineups = () => {
      const teams = [
        ['A', teamAPlayerId],
        ['B', teamBPlayerId],
      ]
      teams.forEach(([team, playerId]) => {
        if (!playerId) return
        fetchTeamLineup({ ...teamLineupsTable, sourceId, playerId }).then((saved) => {
          if (!saved) return
          const lineupOrder = Array.isArray(saved.lineupOrder) ? saved.lineupOrder : []
          const fieldingPositions = saved.fieldingPositions && typeof saved.fieldingPositions === 'object' ? saved.fieldingPositions : {}
          applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
        })
      })
    }
    const pollInterval = setInterval(pollTeamLineups, 5000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(pollInterval)
    }
  }, [gameSession?.sourceId, isSeasonGame, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, applyIncomingTeamLineup])

  // A pitcher swap made while a team was batting can't be applied to
  // pitching_stints right away (they're not the pitching team yet). Once
  // that team takes the mound, check their saved fielding.pitcher against
  // the active pitching stint and apply the change then.
  useEffect(() => {
    if (!offense?.pitchingPlayerId || !canEditScorebook) return
    const team = String(offense.pitchingPlayerId) === String(selectedGame?.team_a_player_id) ? 'A'
      : String(offense.pitchingPlayerId) === String(selectedGame?.team_b_player_id) ? 'B' : null
    if (!team) return
    const desiredPitcherCharId = lineupDrafts[team]?.fielding?.pitcher ? Number(lineupDrafts[team].fielding.pitcher) : null
    if (desiredPitcherCharId && desiredPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      changePitcherRef.current?.(offense.pitchingPlayerId, desiredPitcherCharId)
    }
  }, [offense?.pitchingPlayerId, canEditScorebook, lineupDrafts, currentPitcherStint, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id])

  // Auto-save lineup/fielding edits a moment after the user stops editing —
  // every other viewer's Lineups tab picks this up via the realtime
  // subscriptions on `lineups`/`game_fielders` (and rebuilds its draft above).
  useEffect(() => {
    if (viewMode !== 'lineups' || !selectedGame) return
    const teams = ['A', 'B'].filter((team) => lineupDirtyRef.current[team])
    if (!teams.length) return

    const timeout = setTimeout(() => {
      teams.forEach((team) => {
        setLineupSaveStatus((current) => ({ ...current, [team]: 'saving' }))
        saveTeamLineup(team).finally(() => {
          lineupDirtyRef.current = { ...lineupDirtyRef.current, [team]: false }
          setLineupSaveStatus((current) => ({ ...current, [team]: 'saved' }))
        })
      })
    }, 600)

    return () => clearTimeout(timeout)
  }, [viewMode, selectedGame, lineupDrafts, saveTeamLineup])

  const currentEntryKey = currentBatter ? `${currentBatter.player_id}:${currentBatter.character_id}` : null
  const lineupStatsByEntryKey = useMemo(() => {
    const next = {}
    gameLineups.forEach((entry) => {
      const key = `${entry.player_id}:${entry.character_id}`
      const gameStats = summarizeBatting(gamePAs.filter((pa) => String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id)))
      const sourceStats = summarizeBatting(plateAppearances.filter((pa) => tournamentGameIds.has(String(pa.game_id)) && String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id)))
      next[key] = { game: gameStats, source: sourceStats }
    })
    return next
  }, [gameLineups, gamePAs, plateAppearances, tournamentGameIds])

  const runsByPaId = useMemo(() => (
    gameRuns.reduce((acc, run) => {
      const key = String(run.pa_id || '')
      if (!key) return acc
      acc[key] = acc[key] || []
      acc[key].push(run)
      return acc
    }, {})
  ), [gameRuns])

  const scoringSummary = useMemo(() => {
    if (!selectedGame) return []
    let awayScore = 0
    let homeScore = 0
    let lastLeaderPlayerId = null
    return gamePAs.reduce((rows, pa) => {
      const scoringRuns = getPaScoringRuns(pa, runsByPaId)
      if (!scoringRuns) return rows

      const isAwayBatting = String(pa.player_id) === String(selectedGame.team_a_player_id)
      if (isAwayBatting) awayScore += scoringRuns
      else homeScore += scoringRuns

      const leaderPlayerId = awayScore === homeScore
        ? null
        : awayScore > homeScore
          ? selectedGame.team_a_player_id
          : selectedGame.team_b_player_id

      rows.push({
        id: pa.id,
        inning: Number(pa.inning || 1),
        half: isAwayBatting ? 'top' : 'bottom',
        battingPlayerId: pa.player_id,
        batterCharacterId: pa.character_id,
        awayScore,
        homeScore,
        scoringRuns,
        leaderPlayerId,
        leaderChanged: leaderPlayerId !== lastLeaderPlayerId,
        createdAt: pa.created_at,
        pitcherId: pa.pitcher_id,
        pitcherPlayerId: pa.pitcher_player_id,
        chargedToPitcherId: runsByPaId[String(pa.id)]?.[0]?.charged_to_pitcher_id || pa.pitcher_id || null,
        chargedToPitcherPlayerId: runsByPaId[String(pa.id)]?.[0]?.charged_to_pitcher_player_id || pa.pitcher_player_id || null,
        description: buildScoringPlayDescription(pa, scoringRuns, runsByPaId[String(pa.id)] || [], charactersById),
      })
      lastLeaderPlayerId = leaderPlayerId
      return rows
    }, [])
  }, [selectedGame, gamePAs, runsByPaId, charactersById])

  const effectiveGameStatus = useMemo(() => {
    if (!selectedGame) return 'pending'
    if (isGameComplete) return 'complete'
    if (selectedGame.status === 'active') return 'active'
    if (selectedGameLiveState || gamePAs.length > 0) return 'active'
    return selectedGame.status || 'pending'
  }, [selectedGame, isGameComplete, selectedGameLiveState, gamePAs.length])

  const displayBalls = canEditScorebook ? balls : Number(selectedGameLiveState?.balls || 0)
  const displayStrikes = canEditScorebook ? strikes : Number(selectedGameLiveState?.strikes || 0)
  const displayPitchNumber = canEditScorebook
    ? pitchNumber
    : Number(selectedGameLiveState?.pitchNumber ?? currentPitcherPitchRows.length)
  const displayOutsInHalf = canEditScorebook ? outsInHalf : Number(selectedGameLiveState?.outsInHalf ?? outsInHalf)
  const displayRunners = useMemo(() => {
    const nextRunners = canEditScorebook
      ? runners
      : (selectedGameLiveState?.runners || { first: null, second: null, third: null })
    if (displayOutsInHalf === 0 && currentHalfPaCount === 0) {
      return { first: null, second: null, third: null }
    }
    return nextRunners
  }, [canEditScorebook, runners, selectedGameLiveState?.runners, displayOutsInHalf, currentHalfPaCount])
  const gameWinProbabilityContext = useMemo(() => {
    if (!selectedGame) return null
    return buildSharedOddsGenerationContext({
      game: selectedGame,
      draftPicks,
      charactersById,
      gamePAs,
      gamePitching,
      allGames: games,
      allPAs: plateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      totalInnings: regulationInnings,
      bets: gameBets,
    })
  }, [
    selectedGame,
    draftPicks,
    charactersById,
    gamePAs,
    gamePitching,
    games,
    plateAppearances,
    pitchingStints,
    stadiumsById,
    stadiumGameLog,
    playersById,
    currentInning,
    scores,
    regulationInnings,
    gameBets,
  ])

  // estimateHomeWinProbability assumes "away" = team A and "home" = team B, with
  // `isTop` meaning the away team (team A) is batting. `offense.isTop` only tells
  // us whether it's structurally the top of the inning, which (when swapped) can
  // mean team B is batting — so derive isTop from which team is actually batting.
  const isTeamABatting = offense ? String(offense.battingPlayerId) === String(selectedGame?.team_a_player_id) : true
  const currentWinProbability = useMemo(() => estimateHomeWinProbability({
    homeScore: scores.b,
    awayScore: scores.a,
    currentInning,
    isTop: isTeamABatting,
    outsInHalf: displayOutsInHalf,
    regulationInnings,
    runnersOccupied: [displayRunners.first, displayRunners.second, displayRunners.third].filter(Boolean).length,
    balls: displayBalls,
    strikes: displayStrikes,
    status: effectiveGameStatus,
    paCount: gamePAs.length,
    oddsContext: gameWinProbabilityContext,
  }), [
    scores.b,
    scores.a,
    currentInning,
    isTeamABatting,
    displayOutsInHalf,
    regulationInnings,
    displayRunners.first,
    displayRunners.second,
    displayRunners.third,
    displayBalls,
    displayStrikes,
    effectiveGameStatus,
    gamePAs.length,
    gameWinProbabilityContext,
  ])

  const winProbabilityPoints = useMemo(() => {
    if (!selectedGame) return []
    const points = [{
      label: 'Start',
      probability: estimateHomeWinProbability({
        homeScore: 0,
        awayScore: 0,
        currentInning: 1,
        isTop: true,
        outsInHalf: 0,
        regulationInnings,
        status: 'pending',
        paCount: 0,
        oddsContext: gameWinProbabilityContext,
      }),
      description: 'Game start',
      score: `${teamAAbbreviation} 0 - ${teamBAbbreviation} 0`,
    }]
    let teamAScore = 0
    let teamBScore = 0
    let outsBefore = 0
    const swapped = !!selectedGame.home_away_swapped

    gamePAs.forEach((pa, index) => {
      const scoringRuns = getPaScoringRuns(pa, runsByPaId)
      const isTeamABatting = String(pa.player_id) === String(selectedGame.team_a_player_id)
      // Team A bats in the top of the inning unless home/away is swapped.
      const isTop = swapped ? !isTeamABatting : isTeamABatting
      const outsAfter = outsBefore + calculateOutsForPa(pa.result)
      if (scoringRuns) {
        if (isTeamABatting) teamAScore += scoringRuns
        else teamBScore += scoringRuns
      }
      const batterName = charactersById[pa.character_id]?.name || 'Unknown'
      points.push({
        label: `${isTop ? 'Top' : 'Bot'} ${Number(pa.inning || 1)}`,
        description: scoringRuns > 0
          ? buildScoringPlayDescription(pa, scoringRuns, runsByPaId[String(pa.id)] || [], charactersById)
          : `${batterName} ${formatPlayResultText(pa)}`,
        probability: estimateHomeWinProbability({
          homeScore: swapped ? teamAScore : teamBScore,
          awayScore: swapped ? teamBScore : teamAScore,
          currentInning: Number(pa.inning || 1),
          isTop,
          outsInHalf: outsAfter % 3,
          regulationInnings,
          status: 'active',
          paCount: index + 1,
          oddsContext: gameWinProbabilityContext,
        }),
        score: `${teamAAbbreviation} ${teamAScore} - ${teamBAbbreviation} ${teamBScore}`,
      })
      outsBefore = outsAfter
    })

    const finalLabel = effectiveGameStatus === 'complete'
      ? getFinalStatusLabel(selectedGame, regulationInnings)
      : (offense?.halfLabel || 'Live')
    // currentWinProbability is team B's win probability (swap-independent); the
    // chart's home/away labels and colors flip with the swap, so the plotted
    // probability needs to flip too — same conversion as `currentHomeProbability`.
    const currentHomeProbability = swapped ? 1 - currentWinProbability : currentWinProbability
    if (points.length > 1) {
      const lastPoint = points[points.length - 1]
      lastPoint.label = finalLabel
      lastPoint.probability = currentHomeProbability
      lastPoint.score = `${teamAAbbreviation} ${scores.a} - ${teamBAbbreviation} ${scores.b}`
      if (effectiveGameStatus === 'complete') lastPoint.description = 'Game complete'
    } else {
      points.push({
        label: finalLabel,
        probability: currentHomeProbability,
        description: effectiveGameStatus === 'complete' ? 'Game complete' : 'Game start',
        score: `${teamAAbbreviation} ${scores.a} - ${teamBAbbreviation} ${scores.b}`,
      })
    }
    return points
  }, [selectedGame, gamePAs, regulationInnings, offense?.halfLabel, currentWinProbability, runsByPaId, charactersById, teamAAbbreviation, teamBAbbreviation, scores.a, scores.b, effectiveGameStatus, gameWinProbabilityContext])

  const teamAPitching = useMemo(
    () => dedupePitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_a_player_id)),
    ),
    [gamePitching, selectedGame?.team_a_player_id],
  )
  const teamBPitching = useMemo(
    () => dedupePitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_b_player_id)),
    ),
    [gamePitching, selectedGame?.team_b_player_id],
  )

  const pitcherDecisionSummary = useMemo(() => {
    if (!selectedGame || selectedGame.status !== 'complete') return { winning: null, losing: null }
    const flaggedWinning = gamePitching.find((stint) => stint.win)
    const flaggedLosing = gamePitching.find((stint) => stint.loss)
    if (flaggedWinning || flaggedLosing) {
      return { winning: flaggedWinning || null, losing: flaggedLosing || null }
    }

    const winnerPlayerId = selectedGame.winner_player_id || (scores.a > scores.b ? selectedGame.team_a_player_id : scores.b > scores.a ? selectedGame.team_b_player_id : null)
    if (!winnerPlayerId) return { winning: null, losing: null }

    let decisivePlay = null
    for (const play of scoringSummary) {
      if (play.leaderChanged && String(play.leaderPlayerId) === String(winnerPlayerId)) {
        decisivePlay = play
      }
    }
    if (!decisivePlay) {
      return {
        winning: [...gamePitching].filter((stint) => String(stint.player_id) === String(winnerPlayerId)).slice(-1)[0] || null,
        losing: null,
      }
    }

    const winningCandidates = [...gamePitching]
      .filter((stint) => String(stint.player_id) === String(winnerPlayerId) && new Date(stint.created_at).getTime() <= new Date(decisivePlay.createdAt).getTime())
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const winning = winningCandidates[winningCandidates.length - 1]
      || [...gamePitching].filter((stint) => String(stint.player_id) === String(winnerPlayerId)).slice(-1)[0]
      || null

    let losing = null
    if (decisivePlay.chargedToPitcherId || decisivePlay.chargedToPitcherPlayerId) {
      const losingCandidates = [...gamePitching]
        .filter((stint) => (
          (!decisivePlay.chargedToPitcherId || Number(stint.character_id) === Number(decisivePlay.chargedToPitcherId))
          && (!decisivePlay.chargedToPitcherPlayerId || String(stint.player_id) === String(decisivePlay.chargedToPitcherPlayerId))
        ))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      losing = losingCandidates[losingCandidates.length - 1] || null
    }

    if (!losing) {
      const losingPlayerId = String(winnerPlayerId) === String(selectedGame.team_a_player_id) ? selectedGame.team_b_player_id : selectedGame.team_a_player_id
      const fallbackCandidates = [...gamePitching]
        .filter((stint) => String(stint.player_id) === String(losingPlayerId) && new Date(stint.created_at).getTime() <= new Date(decisivePlay.createdAt).getTime())
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      losing = fallbackCandidates[fallbackCandidates.length - 1]
        || [...gamePitching].filter((stint) => String(stint.player_id) === String(losingPlayerId)).slice(-1)[0]
        || null
    }

    return { winning, losing }
  }, [selectedGame, gamePitching, scoringSummary, scores.a, scores.b])

  const pitcherDecisionLabels = useMemo(() => {
    const labels = {}
    if (pitcherDecisionSummary.winning?.id != null) labels[pitcherDecisionSummary.winning.id] = 'W'
    if (pitcherDecisionSummary.losing?.id != null) labels[pitcherDecisionSummary.losing.id] = 'L'
    const savePitcher = gamePitching.find((stint) => stint.save)
    if (savePitcher?.id != null) labels[savePitcher.id] = 'SV'
    return labels
  }, [pitcherDecisionSummary, gamePitching])

  useEffect(() => {
    if (!offense?.battingPlayerId) return
    setRunners((current) => sanitizeRunnersForOffense(current, offense))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offense?.battingPlayerId])

  useEffect(() => {
    if (!selectedGameId || !currentActivePaScope) {
      setActivePaLoadedScope(null)
      return
    }
    const storageKey = getActivePaStorageKey(selectedGameId)
    try {
      const raw = sessionStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : null
      const shouldHydrateFromLiveState = selectedGameLiveState
        && (!selectedGameLiveState.batterPlayerId || String(selectedGameLiveState.batterPlayerId) === String(currentBatter?.player_id))
        && (!selectedGameLiveState.batterCharacterId || String(selectedGameLiveState.batterCharacterId) === String(currentBatter?.character_id))
      if (parsed?.scope === currentActivePaScope) {
        const shouldReuseStoredPitchCount = String(parsed.pitcherKey || '') === String(currentPitcherStorageKey)
        setStarPitchActive(Boolean(parsed.starPitchActive))
        setPitchActionSheet(parsed.pitchActionSheet || null)
        setPendingPitchEvent(parsed.pendingPitchEvent || null)
        setPaPitchRows(Array.isArray(parsed.paPitchRows) ? parsed.paPitchRows : [])
        setInPlayState(parsed.inPlayState || null)
        setRbiOverlay(parsed.rbiOverlay || null)
        setStarHitUsed(Boolean(parsed.starHitUsed))
        setStarHitPending(Boolean(parsed.starHitPending))
        setStarHitConnected(Boolean(parsed.starHitConnected))
        restorePitchState({
          balls: Number(parsed.balls || 0),
          strikes: Number(parsed.strikes || 0),
          pitchNumber: shouldReuseStoredPitchCount
            ? Number(parsed.pitchNumber ?? currentPitcherPitchRows.length)
            : Number(currentPitcherPitchRows.length),
        })
      } else {
        setStarPitchActive(false)
        setPitchActionSheet(null)
        setPendingPitchEvent(null)
        setPaPitchRows([])
        setInPlayState(null)
        setRbiOverlay(null)
        setStarHitUsed(false)
        setStarHitPending(false)
        setStarHitConnected(false)
        restorePitchState({
          balls: shouldHydrateFromLiveState ? Number(selectedGameLiveState.balls || 0) : 0,
          strikes: shouldHydrateFromLiveState ? Number(selectedGameLiveState.strikes || 0) : 0,
          pitchNumber: shouldHydrateFromLiveState
            ? Number(selectedGameLiveState.pitchNumber ?? currentPitcherPitchRows.length)
            : Number(currentPitcherPitchRows.length),
        })
        if (!shouldHydrateFromLiveState) {
          sessionStorage.removeItem(storageKey)
        }
      }
    } catch {
      setStarPitchActive(false)
      setPitchActionSheet(null)
      setPendingPitchEvent(null)
      setPaPitchRows([])
      setInPlayState(null)
      setRbiOverlay(null)
      setStarHitUsed(false)
      setStarHitPending(false)
      setStarHitConnected(false)
      restorePitchState({
        balls: 0,
        strikes: 0,
        pitchNumber: Number(currentPitcherPitchRows.length),
      })
    }
    setActivePaLoadedScope(currentActivePaScope)
  }, [selectedGameId, currentActivePaScope, currentPitcherPitchRows.length, currentPitcherStorageKey, restorePitchState, selectedGameLiveState, currentBatter?.player_id, currentBatter?.character_id])

  useEffect(() => {
    if (!selectedGameId || !currentActivePaScope) return
    if (activePaLoadedScope !== currentActivePaScope) return
    const storageKey = getActivePaStorageKey(selectedGameId)
    try {
      if (
        !paPitchRows.length &&
        !starHitUsed &&
        !starHitConnected &&
        !starPitchActive &&
        !pitchActionSheet &&
        !pendingPitchEvent &&
        !inPlayState &&
        !rbiOverlay
      ) {
        sessionStorage.removeItem(storageKey)
        return
      }
      sessionStorage.setItem(storageKey, JSON.stringify({
        scope: currentActivePaScope,
        pitcherKey: currentPitcherStorageKey,
        balls,
        strikes,
        pitchNumber,
        paPitchRows,
        starHitUsed,
        starHitPending,
        starHitConnected,
        starPitchActive,
        pitchActionSheet,
        pendingPitchEvent,
        inPlayState,
        rbiOverlay,
      }))
    } catch {}
  }, [
    selectedGameId,
    currentActivePaScope,
    activePaLoadedScope,
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    starHitUsed,
    starHitPending,
    starHitConnected,
    starPitchActive,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    currentPitcherStorageKey,
  ])

  useEffect(() => {
    if (!redoAction) return
    if (redoAction.type === 'pa' && String(redoAction.gameId) !== String(selectedGameId)) {
      setRedoAction(null)
      return
    }
    if (redoAction.type === 'pitch' && redoAction.scope !== currentActivePaScope) {
      setRedoAction(null)
    }
  }, [redoAction, selectedGameId, currentActivePaScope])

  const previewRunners = useMemo(
    () => (pendingPA?.assignments?.length ? extractNextRunners(pendingPA) : runners),
    [pendingPA, runners],
  )

  const previewHomeRunners = useMemo(
    () => (pendingPA?.assignments?.length ? getHomeAssignments(pendingPA) : []),
    [pendingPA],
  )

  const previewOuts = useMemo(
    () => (pendingPA?.assignments?.length ? getOutAssignments(pendingPA).length : 0),
    [pendingPA],
  )

  const inPlayTrajectoryOptions = useMemo(() => {
    if (inPlayState?.result === 'GO') {
      return TRAJECTORY_OPTIONS.filter((option) => option.value === 'G')
    }
    if (inPlayState?.result === 'LO') {
      return TRAJECTORY_OPTIONS.filter((option) => option.value === 'L')
    }
    if (inPlayState?.result === 'FO') {
      return TRAJECTORY_OPTIONS.filter((option) => option.value === 'F' || option.value === 'B')
    }
    if (inPlayState?.result === 'HR') {
      return TRAJECTORY_OPTIONS.filter((option) => OVER_THE_FENCE_HR_TRAJECTORIES.has(option.value))
    }
    return TRAJECTORY_OPTIONS
  }, [inPlayState?.result])

  const shouldShowTrajectoryChooser = useMemo(
    () => !(inPlayState?.result === 'GO' || inPlayState?.result === 'LO'),
    [inPlayState?.result],
  )

  const inPlayAllowedPositions = useMemo(() => {
    if (inPlayState?.result === 'HR') return OVER_THE_FENCE_HR_POSITIONS
    return null
  }, [inPlayState?.result])

  useEffect(() => {
    if (!selectedGameId) return
    if (runnerStateLoadedScope === `${selectedGameId}:${currentHalfIdx}`) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      const stored = sessionStorage.getItem(runnerKey)
      const storedHistory = sessionStorage.getItem(historyKey)
      const parsed = stored ? JSON.parse(stored) : null
      const parsedHistory = storedHistory ? JSON.parse(storedHistory) : []
      const storedBattingPlayerId = parsed?.runners ? parsed.battingPlayerId : null
      const storedRunners = parsed?.runners ?? parsed
      const storedUpdatedAt = parsed?.runners ? parsed.updatedAt : null
      const rawHistory = Array.isArray(parsedHistory?.history) ? parsedHistory.history : (Array.isArray(parsedHistory) ? parsedHistory : [])
      const historyBattingPlayerId = Array.isArray(parsedHistory?.history) ? parsedHistory.battingPlayerId : null
      const normalizedRunners = {
        first: storedRunners?.first || null,
        second: storedRunners?.second || null,
        third: storedRunners?.third || null,
      }
      const shouldTrustStoredRunners = !storedBattingPlayerId || String(storedBattingPlayerId) === String(offense?.battingPlayerId)
      const shouldTrustStoredHistory = !historyBattingPlayerId || String(historyBattingPlayerId) === String(offense?.battingPlayerId)
      const shouldTrustLiveStateRunners = selectedGameLiveState
        && (!selectedGameLiveState.batterPlayerId || String(selectedGameLiveState.batterPlayerId) === String(offense?.battingPlayerId))
      const fallbackRunners = shouldTrustLiveStateRunners
        ? normalizeLiveRunners(selectedGameLiveState.runners)
        : { first: null, second: null, third: null }
      // Prefer whichever source is fresher: a same-tab sessionStorage cache vs.
      // the durable DB live_state. This stops a stale local cache from
      // clobbering a more recent write (e.g. from another tab/device), while
      // still allowing the local cache to win for fast same-session reloads.
      const storedTime = storedUpdatedAt ? Date.parse(storedUpdatedAt) : NaN
      const liveStateTime = selectedGameLiveState?.updatedAt ? Date.parse(selectedGameLiveState.updatedAt) : NaN
      const storedIsFresher = !Number.isNaN(storedTime) && (Number.isNaN(liveStateTime) || storedTime >= liveStateTime)
      const useStoredRunners = shouldTrustStoredRunners && stored
        && (storedIsFresher || !shouldTrustLiveStateRunners)
      setRunners(sanitizeRunnersForOffense(
        useStoredRunners
          ? normalizedRunners
          : fallbackRunners,
        offense,
      ))
      setRunnersHistory(
        shouldTrustStoredHistory
          ? rawHistory.map((entry) => sanitizeRunnersForOffense(entry, offense))
          : [],
      )
    } catch {
      setRunners({ first: null, second: null, third: null })
      setRunnersHistory([])
    }
    setRunnerStateLoadedScope(`${selectedGameId}:${currentHalfIdx}`)
  }, [selectedGameId, currentHalfIdx, offense, selectedGameLiveState, runnerStateLoadedScope])

  useEffect(() => {
    if (!selectedGameId || runnerStateLoadedScope !== `${selectedGameId}:${currentHalfIdx}`) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      sessionStorage.setItem(runnerKey, JSON.stringify({
        battingPlayerId: offense?.battingPlayerId || null,
        runners: sanitizeRunnersForOffense(runners, offense),
        updatedAt: new Date().toISOString(),
      }))
      sessionStorage.setItem(historyKey, JSON.stringify({
        battingPlayerId: offense?.battingPlayerId || null,
        history: runnersHistory.map((entry) => sanitizeRunnersForOffense(entry, offense)),
      }))
    } catch {}
  }, [selectedGameId, currentHalfIdx, runnerStateLoadedScope, runners, runnersHistory, offense])

  const [isSaving, setIsSaving] = useState(false)
  const canRecordOutcome = Boolean(currentPitcherStint) && !isSaving && !isPitchActionPending && canEditScorebook

  useEffect(() => () => {
    if (saveWatchdogRef.current) clearTimeout(saveWatchdogRef.current)
    if (pitchActionUnlockRef.current) clearTimeout(pitchActionUnlockRef.current)
    if (liveStatePublishTimeoutRef.current) clearTimeout(liveStatePublishTimeoutRef.current)
  }, [])

  useEffect(() => {
    lastPublishedLiveStateRef.current = serializeLiveStateForComparison(selectedGame?.live_state)
  }, [selectedGame?.id, selectedGame?.live_state])

  useEffect(() => {
    if (!selectedGame || !canEditScorebook || isGameComplete || !offense || !currentBatter) return undefined

    const normalizedRunners = sanitizeRunnersForOffense(
      normalizeLiveRunners(runners),
      offense,
    )
    const hasLiveContext = hasAnyActiveRunners(normalizedRunners)
      || balls > 0
      || strikes > 0
      || paPitchRows.length > 0
      || Boolean(pendingPA)
      || Boolean(pitchActionSheet)
      || Boolean(pendingPitchEvent)
      || Boolean(inPlayState)
      || Boolean(rbiOverlay)
      || starPitchActive
      || starHitPending
      || starHitConnected
    const nextLiveState = hasLiveContext
      ? {
          inning: offense.inning,
          isTop: offense.isTop,
          outsInHalf,
          balls,
          strikes,
          pitchNumber,
          paNumber: activePaNumber,
          batterCharacterId: currentBatter.character_id,
          batterPlayerId: currentBatter.player_id,
          onDeckCharacterId: onDeckBatter?.character_id ?? null,
          onDeckPlayerId: onDeckBatter?.player_id ?? null,
          runners: normalizedRunners,
          updatedAt: new Date().toISOString(),
        }
      : null
    const nextSerialized = serializeLiveStateForComparison(nextLiveState)
    const targetStatus = isSeasonGame ? 'in_progress' : 'active'
    const shouldPromoteStatus = ['pending', 'scheduled'].includes(String(selectedGame.status || '')) && (hasLiveContext || gamePAs.length > 0)
    const shouldClearLiveState = !hasLiveContext && Boolean(selectedGameLiveState)

    if (nextSerialized === lastPublishedLiveStateRef.current && !shouldPromoteStatus && !shouldClearLiveState) {
      return undefined
    }

    const updatePayload = {}
    if (nextSerialized !== lastPublishedLiveStateRef.current || shouldClearLiveState) {
      updatePayload.live_state = getPersistedLiveStateValue(nextLiveState, isSeasonGame)
    }
    if (shouldPromoteStatus) {
      updatePayload.status = targetStatus
    }
    if (!Object.keys(updatePayload).length) return undefined

    pendingLiveStateRef.current = { gameId: selectedGame.id, updatePayload }
    lastPublishedLiveStateRef.current = nextSerialized

    // Debounce the write so rapid pitch sequences (e.g. ball-ball-strikeout)
    // collapse into a single update reflecting the final count, rather than
    // racing multiple in-flight writes that can resolve out of order and
    // leave a stale balls/strikes value stuck in live_state.
    if (liveStatePublishTimeoutRef.current) clearTimeout(liveStatePublishTimeoutRef.current)
    const publishSeq = ++liveStatePublishSeqRef.current
    liveStatePublishTimeoutRef.current = setTimeout(() => {
      liveStatePublishTimeoutRef.current = null
      supabase.from(scorebookTables.games).update(updatePayload).eq('id', selectedGame.id).then(({ error }) => {
        if (liveStatePublishSeqRef.current !== publishSeq) return
        if (error) {
          lastPublishedLiveStateRef.current = serializeLiveStateForComparison(selectedGame?.live_state)
        } else if (pendingLiveStateRef.current?.gameId === selectedGame.id && pendingLiveStateRef.current?.updatePayload === updatePayload) {
          pendingLiveStateRef.current = null
        }
      })
    }, 180)

    return undefined
  }, [
    selectedGame,
    canEditScorebook,
    isGameComplete,
    offense,
    currentBatter,
    onDeckBatter,
    runners,
    balls,
    strikes,
    pitchNumber,
    paPitchRows.length,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitPending,
    starHitConnected,
    activePaNumber,
    outsInHalf,
    gamePAs.length,
    isSeasonGame,
    scorebookTables.games,
    selectedGameLiveState,
    selectedGame?.live_state,
  ])

  // ── Best-effort flush of any in-flight live_state write on tab close ───────
  useEffect(() => {
    const flushPendingLiveState = () => {
      const pending = pendingLiveStateRef.current
      const accessToken = session?.access_token
      if (!pending || !accessToken) return
      const { gameId, updatePayload } = pending
      pendingLiveStateRef.current = null
      const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/${scorebookTables.games}?id=eq.${gameId}`
      fetch(url, {
        method: 'PATCH',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(updatePayload),
      }).catch(() => {})
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingLiveState()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', flushPendingLiveState)
    window.addEventListener('beforeunload', flushPendingLiveState)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', flushPendingLiveState)
      window.removeEventListener('beforeunload', flushPendingLiveState)
    }
  }, [session?.access_token, scorebookTables.games])

  useEffect(() => {
    if (!isScorekeeper) {
      setViewMode('game')
    }
  }, [isScorekeeper])

  useEffect(() => {
    setViewedCharacterId(null)
  }, [viewMode, selectedGameId])

  useEffect(() => {
    if (!isGameComplete) return
    setEditingPa(null)
    setPendingPA(null)
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setSelectedPitcher(null)
    setIsDragOverMound(false)
    setOverrideBatterIdx(null)
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setPaPitchRows([])
    setInPlayState(null)
    setRbiOverlay(null)
    setShowEndGameConfirm(false)
    resetPitchCount()
    if (selectedGame?.id) {
      try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    }
  }, [isGameComplete, selectedGame?.id, resetPitchCount])

  const completedHalfCount = Math.floor(outsRecorded / 3)

  const displayedPAs = useMemo(() => {
    const base = [...gamePAs].reverse()
    return viewedInning ? base.filter(pa => pa.inning === viewedInning) : base
  }, [gamePAs, viewedInning])

  const [halfInningOverrides, setHalfInningOverrides] = useState({})
  const halfInningPaGroups = useMemo(() => {
    if (!selectedGame) return []
    const groups = []
    const groupByKey = {}
    const swapped = !!selectedGame.home_away_swapped
    displayedPAs.forEach((pa) => {
      const inning = Number(pa.inning || 1)
      const isTeamABatting = String(pa.player_id) === String(selectedGame.team_a_player_id)
      // `isTop` (top/bottom of the inning) flips with the swap, but
      // `isTeamABatting` always reflects which team actually made the PA.
      const isTop = swapped ? !isTeamABatting : isTeamABatting
      const key = `${inning}-${isTeamABatting ? 'A' : 'B'}`
      if (!groupByKey[key]) {
        const group = { key, inning, isTop, isTeamABatting, pas: [], runs: 0 }
        groupByKey[key] = group
        groups.push(group)
      }
      const group = groupByKey[key]
      group.pas.push(pa)
      group.runs += (runsByPaId[String(pa.id)] || []).length
    })
    return groups.map((group) => {
      const halfIndex = (group.inning - 1) * 2 + (group.isTop ? 0 : 1)
      return { ...group, isCompleted: halfIndex < completedHalfCount }
    })
  }, [selectedGame, displayedPAs, runsByPaId, completedHalfCount])

  const maxInning = useMemo(() => {
    const completedInnings = Math.ceil(completedHalfCount / 2)
    const highestPlayedInning = Math.max(currentInning, completedInnings, 1)
    return Math.max(regulationInnings, highestPlayedInning > regulationInnings ? highestPlayedInning : 0)
  }, [completedHalfCount, regulationInnings, currentInning])
  const innings   = useMemo(() => Array.from({ length: maxInning }, (_, i) => i + 1), [maxInning])

  const backPath = isSeasonGame
    ? (selectedGame?.stage ? '/season/schedule?view=playoffs' : '/season/schedule')
    : '/bracket'
  const backLabel = isSeasonGame
    ? (selectedGame?.stage ? 'Back to Season Playoffs' : 'Back to Season Schedule')
    : 'Back to Tournament Bracket'
  const scorebookToolbar = null

  // ── Game-end check ─────────────────────────────────────────────────────────
  const checkGameEnd = useCallback(({
    inning,
    isTop,
    halfCompleted = false,
    currentScores,
    previousScores = currentScores,
  }) => {
    if (!selectedGame || isGameComplete || !currentScores) return null

    // `isTop`/`currentScores.a`/`currentScores.b` are swap-independent (team A /
    // team B totals, top of inning is structural). Map them to away/home using
    // the swap flag so "home" always means the team batting in the bottom half.
    const swapped = !!selectedGame.home_away_swapped
    const awayPlayerId = swapped ? selectedGame.team_b_player_id : selectedGame.team_a_player_id
    const homePlayerId = swapped ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
    const awayScore = Number((swapped ? currentScores.b : currentScores.a) || 0)
    const homeScore = Number((swapped ? currentScores.a : currentScores.b) || 0)
    if (awayScore === homeScore) return null

    const awayBefore = Number((swapped ? previousScores?.b : previousScores?.a) || 0)
    const homeBefore = Number((swapped ? previousScores?.a : previousScores?.b) || 0)
    const winnerId = awayScore > homeScore ? awayPlayerId : homePlayerId
    const diff = Math.abs(awayScore - homeScore)
    const homeWonAfterTop = Boolean(halfCompleted && isTop && Number(inning || 0) >= regulationInnings && homeScore > awayScore)
    const homeWalkOff = Boolean(!halfCompleted && !isTop && Number(inning || 0) >= regulationInnings && homeScore > awayScore && homeBefore <= awayBefore)
    const inningEndedWithWinner = Boolean(halfCompleted && !isTop && Number(inning || 0) >= regulationInnings)
    const mercyEndedGame = Boolean(
      mercyOn
      && diff >= mercyLimit
      && halfCompleted
      && (
        !isTop
        || homeWonAfterTop
      ),
    )

    if (homeWalkOff) {
      return { type: 'regulation', winnerId: homePlayerId, inning }
    }
    if (mercyEndedGame) {
      return { type: 'mercy', winnerId, inning }
    }
    if (homeWonAfterTop || inningEndedWithWinner) {
      return { type: 'regulation', winnerId, inning }
    }
    return null
  }, [selectedGame, isGameComplete, mercyOn, mercyLimit, regulationInnings])

  // ── Sync scores ────────────────────────────────────────────────────────────
  async function syncScores(freshPAs, game, freshRuns = []) {
    const awayRuns = runsFromPAs(freshPAs, game.team_a_player_id, freshRuns)
    const homeRuns = runsFromPAs(freshPAs, game.team_b_player_id, freshRuns)
    const payload = isSeasonGame
      ? { away_score: awayRuns, home_score: homeRuns }
      : { team_a_runs: awayRuns, team_b_runs: homeRuns }
    setGames((current) => current.map((entry) => (
      String(entry.id) === String(game.id)
        ? {
            ...entry,
            ...(isSeasonGame
              ? {
                  away_score: awayRuns,
                  home_score: homeRuns,
                  team_a_runs: awayRuns,
                  team_b_runs: homeRuns,
                }
              : {
                  team_a_runs: awayRuns,
                  team_b_runs: homeRuns,
                }),
          }
        : entry
    )))
    await supabase.from(scorebookTables.games).update(payload).eq('id', game.id)
  }

  async function syncInningScores({ freshPAs = [], freshRuns = [], game }) {
    if (!game || !scorebookTables.inningScores) return

    const rows = freshRuns.length
      ? freshRuns.reduce((acc, run) => {
          const key = `${run.inning}:${run.scoring_player_id}`
          acc[key] = acc[key] || { inning: Number(run.inning || 1), playerId: run.scoring_player_id, runs: 0 }
          acc[key].runs += 1
          return acc
        }, {})
      : freshPAs.reduce((acc, pa) => {
          const runs = Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0)
          if (!runs) return acc
          const key = `${pa.inning}:${pa.player_id}`
          acc[key] = acc[key] || { inning: Number(pa.inning || 1), playerId: pa.player_id, runs: 0 }
          acc[key].runs += runs
          return acc
        }, {})

    await supabase.from(scorebookTables.inningScores).delete().eq('game_id', game.id)
    const payload = Object.values(rows).map((entry) => (
      isSeasonGame
        ? addSourceFields({
            game_id: game.id,
            team_id: gameSession.teamIdByPlayerId?.[entry.playerId] || null,
            inning: entry.inning,
            runs: entry.runs,
          })
        : {
            game_id: game.id,
            player_id: entry.playerId,
            inning: entry.inning,
            runs: entry.runs,
      }
    )).filter((entry) => (isSeasonGame ? entry.team_id : entry.player_id))

    const normalizedRows = payload.map((entry) => ({
      ...entry,
      player_id: entry.player_id || gameSession.playerIdByTeamId?.[entry.team_id] || null,
    }))

    setInningScores((current) => [
      ...current.filter((row) => String(row.game_id) !== String(game.id)),
      ...normalizedRows,
    ])

    if (!payload.length) return
    const { error } = await supabase.from(scorebookTables.inningScores).insert(payload)
    if (error) throw error
  }

  // ── Save plate appearance ──────────────────────────────────────────────────
  const buildOddsGenerationContext = useCallback((overridePitching = gamePitching, overridePAs = gamePAs) => {
    return buildSharedOddsGenerationContext({
      game: selectedGame,
      draftPicks,
      charactersById,
      gamePAs: overridePAs,
      gamePitching: overridePitching,
      allGames: games,
      allPAs: plateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      bets: gameBets,
    })
  }, [
    charactersById,
    currentInning,
    gamePAs,
    gamePitching,
    draftPicks,
    games,
    pitchingStints,
    plateAppearances,
    playersById,
    scores,
    selectedGame,
    stadiumGameLog,
    stadiumsById,
    gameBets,
  ])

  const upsertChangedOdds = useCallback(async (changedRows) => {
    if (!selectedGame || !changedRows.length) return
    const { data: existingOdds } = await supabase.from(scorebookTables.gameOdds).select('*').eq('game_id', selectedGame.id)
    const payload = mergeOddsWithExistingRows(changedRows, existingOdds || []).map((row) => {
      const sanitized = Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
      )
      return sanitized
    })
    const toUpdate = Object.values(
      payload
        .filter((row) => row.id != null)
        .reduce((acc, row) => {
          acc[row.id] = row
          return acc
        }, {}),
    )
    const toInsert = Object.values(
      payload
        .filter((row) => row.id == null)
        .reduce((acc, row) => {
          acc[`${row.bet_type}::${row.target_entity || 'game'}`] = row
          return acc
        }, {}),
    )

    await persistOddsRowsWithFallback({
      supabase,
      table: scorebookTables.gameOdds,
      updates: toUpdate,
      inserts: toInsert,
    })
  }, [selectedGame, scorebookTables.gameOdds])

  const ensureLiveOdds = useCallback(async (overridePitching = gamePitching, overridePAs = gamePAs) => {
    if (!selectedGame) return []
    const { data: currentOdds } = await supabase.from(scorebookTables.gameOdds).select('*').eq('game_id', selectedGame.id)
    if ((currentOdds || []).length) return currentOdds || []

    const generationContext = buildOddsGenerationContext(overridePitching, overridePAs)
    if (!generationContext) return []

    const generatedRows = generateGameOdds(
      generationContext.game,
      generationContext.homeRoster,
      generationContext.awayRoster,
      generationContext.homeHistorical,
      generationContext.awayHistorical,
      generationContext.playerProps,
      { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 },
    )

    await upsertChangedOdds(generatedRows)
    return generatedRows
  }, [selectedGame, gamePitching, gamePAs, buildOddsGenerationContext, upsertChangedOdds])

  useEffect(() => {
    if (!selectedGame || selectedGame.status === 'complete') return
    ensureLiveOdds().catch((error) => {
      pushToast({ title: 'Odds sync failed', message: error.message, type: 'error' })
    })
  }, [selectedGame?.id, selectedGame?.status, ensureLiveOdds, pushToast])

  // Reflect the current count and baserunners in live odds (run line, total, moneyline)
  // even mid at-bat, so the board doesn't sit frozen between plate appearances.
  const syncLiveOddsForCount = useCallback(async (nextBalls, nextStrikes) => {
    if (!selectedGame || effectiveGameStatus === 'complete' || !gameWinProbabilityContext) return
    try {
      const currentOdds = await ensureLiveOdds(gamePitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        oddsContext: gameWinProbabilityContext,
        liveState: {
          homeScore: scores.b,
          awayScore: scores.a,
          currentInning,
          isTop: isTeamABatting,
          outsInHalf,
          regulationInnings,
          runnersOccupied: [runners?.first, runners?.second, runners?.third].filter(Boolean).length,
          balls: nextBalls,
          strikes: nextStrikes,
          paCount: gamePAs.length,
          status: 'active',
        },
      })
      await upsertChangedOdds(changedRows)
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
  }, [selectedGame, effectiveGameStatus, gameWinProbabilityContext, ensureLiveOdds, gamePitching, gamePAs, scores.a, scores.b, currentInning, isTeamABatting, outsInHalf, regulationInnings, runners, upsertChangedOdds, pushToast])

  const recomputePitchingStatsForGame = useCallback(async (overridePAs, overridePitching = gamePitching, overrideRuns = gameRuns) => {
    if (!selectedGame || !overridePitching.length) return

    const stints = [...overridePitching].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const pas = [...overridePAs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const nextStatsByStintId = Object.fromEntries(
      stints.map((stint) => [stint.id, {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        _outsRecorded: 0,
      }]),
    )

    let outsBeforePa = 0
    pas.forEach((pa) => {
      const defense = deriveOffense(selectedGame, outsBeforePa)
      const eligibleStints = stints.filter(
        (stint) =>
          String(stint.player_id) === String(defense.pitchingPlayerId) &&
          new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime(),
      )
      const activeStint = eligibleStints[eligibleStints.length - 1]
      if (activeStint) {
        const next = nextStatsByStintId[activeStint.id]
        const outs = calculateOutsForPa(pa.result)
        const paRuns = overrideRuns.filter((run) => String(run.pa_id) === String(pa.id))
        const chargedRuns = paRuns.filter((run) => Number(run.charged_to_pitcher_id) === Number(activeStint.character_id))
        const earnedRuns = chargedRuns.filter((run) => run.is_earned_run !== false)

        next._outsRecorded += outs
        next.runs_allowed += chargedRuns.length
        next.earned_runs += earnedRuns.length
        if (HIT_RESULTS.has(pa.result)) next.hits_allowed += 1
        if (isHomeRunResult(pa.result)) next.hr_allowed += 1
        if (pa.result === 'BB') next.walks += 1
        if (pa.result === 'K') next.strikeouts += 1
      }
      outsBeforePa += calculateOutsForPa(pa.result)
    })

    Object.values(nextStatsByStintId).forEach((entry) => {
      entry.innings_pitched = inningsPitchedFromOuts(entry._outsRecorded)
      delete entry._outsRecorded
    })

    await Promise.all(
      stints.map((stint) =>
        supabase
          .from(scorebookTables.pitchingStints)
          .update(nextStatsByStintId[stint.id])
          .eq('id', stint.id),
      ),
    )

    setPitchingStints((current) => current.map((stint) => (
      nextStatsByStintId[stint.id]
        ? { ...stint, ...nextStatsByStintId[stint.id] }
        : stint
    )))
  }, [selectedGame, gamePitching, gameRuns])

  const savePA = useCallback(async (result, rbi, runScored, nextRunners = runners) => {
    if (!selectedGame || !offense || !currentBatter || isGameComplete) return

    // Capture before any awaits — see comment in saveEnhancedPA.
    const outsBeforePa = outsRef.current

    const paPayload = {
      game_id: selectedGame.id,
      player_id: currentBatter.player_id,
      character_id: currentBatter.character_id,
      inning: offense.inning,
      pa_number: editingPa?.pa_number ?? (gamePAs.length + 1),
      result,
      rbi: normalizeRbiForPaResult(result, rbi),
      run_scored: runScored || false,
    }

    const query = editingPa
      ? supabase.from(scorebookTables.plateAppearances).update(addSourceFields(paPayload)).eq('id', editingPa.id).select().single()
      : supabase.from(scorebookTables.plateAppearances).insert(addSourceFields(paPayload)).select().single()
    const { data: savedPa, error } = await query
    if (error) { pushToast({ title: 'Save failed', message: error.message, type: 'error' }); return }
    clearRedoAction()

    const [{ data: freshPAs }, { data: freshRuns }] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*')
        .eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*')
        .eq('game_id', selectedGame.id).order('created_at'),
    ])
    const allPAs = freshPAs || []
    const allRuns = freshRuns || []
    setPlateAppearances(cur => [
      ...cur.filter(p => String(p.game_id) !== String(selectedGame.id)),
      ...allPAs,
    ])
    setRunsScored(cur => [
      ...cur.filter(run => String(run.game_id) !== String(selectedGame.id)),
      ...allRuns,
    ])
    await syncScores(allPAs, selectedGame, allRuns)
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns)

    if (!editingPa) {
      try {
        await resolveOnPA(selectedGame.id, { ...paPayload, id: savedPa?.id }, betResolutionConfig)
        const currentOdds = await ensureLiveOdds(gamePitching, allPAs)
        const recalcOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0)
        const recalcOffense = deriveOffense(selectedGame, recalcOuts)
        // The odds model's "home"/"away"/isTop convention is team-A=away/team-B=home,
        // independent of the swap — so derive these from which team is batting,
        // not the structural top/bottom of the inning.
        const recalcIsTeamABatting = String(recalcOffense.battingPlayerId) === String(selectedGame.team_a_player_id)
        const recalcHomeScore = runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns)
        const recalcAwayScore = runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns)
        const freshOddsContext = buildSharedOddsGenerationContext({
          game: selectedGame,
          draftPicks,
          charactersById,
          gamePAs: allPAs,
          gamePitching,
          allGames: games,
          allPAs: plateAppearances,
          allPitching: pitchingStints,
          stadiumsById,
          stadiumGameLog,
          playersById,
          currentInning: recalcOffense.inning,
          scores: { a: recalcAwayScore, b: recalcHomeScore },
          totalInnings: regulationInnings,
          bets: gameBets,
        })
        const changedRows = recalculateOdds(currentOdds || [], {
          battingSide: isTeamABatting ? 'away' : 'home',
          isTop: isTeamABatting,
          paCount: allPAs.length,
          runsThisHalf: runsThisHalfFromPAs(allPAs, currentBatter.player_id, offense.inning, allRuns),
          generationContext: { ...freshOddsContext, weights: { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 } },
          oddsContext: freshOddsContext,
          liveState: {
            homeScore: recalcHomeScore,
            awayScore: recalcAwayScore,
            currentInning: recalcOffense.inning,
            isTop: recalcIsTeamABatting,
            outsInHalf: recalcOuts % 3,
            regulationInnings,
            runnersOccupied: [nextRunners?.first, nextRunners?.second, nextRunners?.third].filter(Boolean).length,
            balls: 0,
            strikes: 0,
            paCount: allPAs.length,
            status: 'active',
          },
        }, paPayload)
        await upsertChangedOdds(changedRows)
      } catch (bettingError) {
        pushToast({ title: 'Betting update failed', message: bettingError.message, type: 'error' })
      }
    }

    const newOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0)
    const prevHalf = Math.floor(outsBeforePa / 3)
    const newHalf  = Math.floor(newOuts / 3)
    const halfCompleted = newHalf > prevHalf
    const nextScores = {
      a: runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns),
      b: runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns),
    }
    const end = checkGameEnd({
      inning: offense.inning,
      isTop: offense.isTop,
      halfCompleted,
      currentScores: nextScores,
      previousScores: scores,
    })
    if (end) {
      setGameEndBanner(end)
      setShowOutsBanner(false)
    } else if (halfCompleted) {
      setShowOutsBanner(true)
    }

    if (result === 'HR') {
      pushToast({ title: 'Home run!', message: 'HR prop bets can be resolved on the betting board.', type: 'success' })
    } else {
      pushToast({ title: `${charactersById[currentBatter.character_id]?.name || 'Batter'} — ${formatPlateAppearanceResult(result, editingPa?.strikeout_type)}`, type: 'success' })
    }
    if (navigator.vibrate) navigator.vibrate(50)
    setEditingPa(null)
    setOverrideBatterIdx(null)
  }, [selectedGame, offense, currentBatter, editingPa, gamePAs, charactersById, playersById, pushToast, upsertChangedOdds, ensureLiveOdds, gamePitching, recomputePitchingStatsForGame, clearRedoAction, isGameComplete, gameWinProbabilityContext, regulationInnings, checkGameEnd, scores])

  // ── Handle outcome button ──────────────────────────────────────────────────
  const handleOutcome = useCallback((result) => {
    if (!canEditScorebook || !currentBatter || !offense) return
    if (!currentPitcherStint) {
      pushToast({ title: 'Select a pitcher', message: 'Choose the active pitcher on the mound before recording an outcome.', type: 'error' })
      return
    }
    if (!editingPa && isOutcomeDisabledForOuts(result, selectionOutsInHalf)) {
      pushToast({ title: 'Outcome unavailable', message: `${result} cannot be recorded with two outs.`, type: 'error' })
      return
    }

    // Edit mode: save directly, preserve RBI if result type unchanged
    if (editingPa) {
      const rbi = editingPa.result === result ? editingPa.rbi : 0
      savePA(result, rbi, result === 'HR' || result === 'IPHR')
      return
    }

    const batter = { characterId: currentBatter.character_id, playerId: currentBatter.player_id }

    // HR / IPHR: all runners score automatically
    if (result === 'HR' || result === 'IPHR') {
      const batterRunner = {
        characterId: currentBatter.character_id,
        playerId: currentBatter.player_id,
        chargedToPitcherId: currentPitcherStint?.character_id,
        chargedToPitcherPlayerId: currentPitcherStint?.player_id,
      }
      const runnersToScore = [runners.first, runners.second, runners.third, batterRunner].filter(Boolean)
      const rbi = runnersToScore.length - 1
      saveEnhancedPA({
        result,
        rbi,
        runScored: true,
        pitchRows: paPitchRows,
        runEvents: runnersToScore
          .filter((runner) => runner?.characterId && runner?.playerId)
          .map((runner) => ({
            playerId: runner.playerId,
            characterId: runner.characterId,
            chargedToPitcherId: runner.chargedToPitcherId ?? currentPitcherStint?.character_id,
            chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId ?? currentPitcherStint?.player_id,
            isEarnedRun: !runner.reachedOnError,
          })),
        nextRunners: { first: null, second: null, third: null },
      })
      pushRunners({ first: null, second: null, third: null })
      return
    }

    // Hits: always show runner assignment, even with empty bases.
    if (NEEDS_RESOLUTION.has(result)) {
      setPendingPA({ result, ...computePendingState(result, runners, batter) })
      return
    }

    // Walks / HBP: always show runner assignment, even with empty bases.
    if (result === 'BB' || result === 'HBP') {
      setPendingPA({ result, ...computePendingState(result, runners, batter) })
      return
    }

    // SF: runner on third scores
    if (result === 'SF') {
      const sfNextRunners = computeImmediateNextRunners('SF', runners, null)
      const scoringRunner = runners.third
      saveEnhancedPA({
        result: 'SF',
        rbi: scoringRunner ? 1 : 0,
        runScored: false,
        pitchRows: paPitchRows,
        isOfficialAb: false,
        runEvents: scoringRunner?.characterId && scoringRunner?.playerId ? [{
          playerId: scoringRunner.playerId,
          characterId: scoringRunner.characterId,
          chargedToPitcherId: scoringRunner.chargedToPitcherId ?? currentPitcherStint?.character_id,
          chargedToPitcherPlayerId: scoringRunner.chargedToPitcherPlayerId ?? currentPitcherStint?.player_id,
          isEarnedRun: !scoringRunner.reachedOnError,
        }] : [],
        nextRunners: sfNextRunners,
      })
      pushRunners(sfNextRunners)
      return
    }

    // SH: batter bunts out, all runners advance one base, runner on third scores
    if (result === 'SH') {
      const shNextRunners = { first: null, second: runners.first, third: runners.second }
      const scoringRunner = runners.third
      saveEnhancedPA({
        result: 'SH',
        rbi: scoringRunner ? 1 : 0,
        runScored: false,
        pitchRows: paPitchRows,
        isOfficialAb: false,
        runEvents: scoringRunner?.characterId && scoringRunner?.playerId ? [{
          playerId: scoringRunner.playerId,
          characterId: scoringRunner.characterId,
          chargedToPitcherId: scoringRunner.chargedToPitcherId ?? currentPitcherStint?.character_id,
          chargedToPitcherPlayerId: scoringRunner.chargedToPitcherPlayerId ?? currentPitcherStint?.player_id,
          isEarnedRun: !scoringRunner.reachedOnError,
        }] : [],
        nextRunners: shNextRunners,
      })
      pushRunners(shNextRunners)
      return
    }

    // All other outs (K, GO, FO, LO, DP, FC)
    const outNextRunners = computeImmediateNextRunners(result, runners, batter)
    savePA(result, 0, false, outNextRunners)
    pushRunners(outNextRunners)
  }, [canEditScorebook, currentBatter, offense, editingPa, runners, savePA, saveEnhancedPA, pushRunners, currentPitcherStint, pushToast, selectionOutsInHalf, paPitchRows])

  // ── Runner resolution toggles ──────────────────────────────────────────────
  const handleSetRunnerDestination = useCallback((assignmentId, destination) => {
    setPendingPA(prev => {
      if (!prev) return prev
      const duplicateBaseOwner = ['first', 'second', 'third'].includes(destination)
        ? prev.assignments.find((assignment) => assignment.id !== assignmentId && assignment.destination === destination)
        : null

      return {
        ...prev,
        assignments: prev.assignments.map((assignment) => {
          if (assignment.id === assignmentId) return { ...assignment, destination }
          if (duplicateBaseOwner && assignment.id === duplicateBaseOwner.id) return { ...assignment, destination: 'out' }
          return assignment
        }),
      }
    })
  }, [])

  const buildBatterRunner = useCallback((reachedOnError = false) => ({
    characterId: currentBatter?.character_id,
    playerId: currentBatter?.player_id,
    chargedToPitcherId: currentPitcherStint?.character_id,
    chargedToPitcherPlayerId: currentPitcherStint?.player_id,
    reachedOnError,
  }), [currentBatter, currentPitcherStint])

  const buildRunEvent = useCallback((runner, earnedOverride) => {
    if (!runner?.characterId || !runner?.playerId) return null
    return {
      playerId: runner.playerId,
      characterId: runner.characterId,
      chargedToPitcherId: runner.chargedToPitcherId,
      chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId,
      isEarnedRun: earnedOverride ?? !runner.reachedOnError,
    }
  }, [])

  // Shared by the confirm button (user-reviewed) and the auto-skip path
  // (bases empty, nothing to decide) so both commit identically.
  const commitPendingPA = useCallback(async (pending) => {
    if (!pending || !currentBatter || !canEditScorebook) return false
    const resolvedResult = derivePendingResult(pending)
    const outAssignments = getOutAssignments(pending)
    const batterOut = pending.assignments.some((assignment) => assignment.isBatter && assignment.destination === 'out')
    const inningEndsOnThisPlay = pending.outResolution && (selectionOutsInHalf + outAssignments.length >= 3)
    const wipeRunsOnPlay = inningEndsOnThisPlay && batterOut
    const occupiedBases = pending.assignments
      .filter((assignment) => ['first', 'second', 'third'].includes(assignment.destination))
      .map((assignment) => assignment.destination)
    if (new Set(occupiedBases).size !== occupiedBases.length) {
      pushToast({ title: 'Runner conflict', message: 'Only one runner can occupy each base.', type: 'error' })
      return false
    }
    if (pending.outResolution && outAssignments.length < 1) {
      pushToast({ title: 'Missing out', message: 'This play needs at least one out assigned before it can be saved.', type: 'error' })
      return false
    }
    if (pending.outResolution && outAssignments.length > 3) {
      pushToast({ title: 'Too many outs', message: 'Only one, two, or three outs can be recorded on a single play.', type: 'error' })
      return false
    }
    const { result, assignments, paMeta = {}, pitchRows = paPitchRows } = pending
    const creditedAssignments = wipeRunsOnPlay ? [] : assignments
    const runEvents = creditedAssignments
      .filter((assignment) => assignment.destination === 'home')
      .map((assignment) => buildRunEvent(assignment.runner, paMeta.isEarnedRun))
      .filter(Boolean)
    await saveEnhancedPA({
      result: resolvedResult || result,
      rbi: result === 'ROE' ? 0 : getRbiFromAssignments(creditedAssignments),
      runScored: !wipeRunsOnPlay && didBatterScore(assignments),
      pitchRows,
      runEvents,
      ...paMeta,
      isOfficialAb: pending.outResolution ? !['SF', 'SH'].includes(resolvedResult) : paMeta.isOfficialAb,
      fielderChoiceOut: pending.outResolution ? resolvedResult === 'FC' : paMeta.fielderChoiceOut,
      nextRunners: inningEndsOnThisPlay ? { first: null, second: null, third: null } : extractNextRunners(pending),
    })
    if (!inningEndsOnThisPlay) pushRunners(extractNextRunners(pending))
    return true
  }, [canEditScorebook, currentBatter, paPitchRows, buildRunEvent, saveEnhancedPA, pushRunners, pushToast, selectionOutsInHalf])

  const confirmPendingPA = useCallback(async () => {
    if (!pendingPA) return
    const committed = await commitPendingPA(pendingPA)
    if (committed) setPendingPA(null)
  }, [pendingPA, commitPendingPA])

  const inferDirectionFromPosition = useCallback((position) => {
    if (['5', '6', '7'].includes(String(position))) return 'Pull'
    if (['1', '2', '8'].includes(String(position))) return 'Center'
    if (['3', '4', '9'].includes(String(position))) return 'Oppo'
    return null
  }, [])

  const appendPitchEvent = useCallback((event) => {
    if (!event) return event
    clearRedoAction()
    const enrichedEvent = {
      ...event,
      pitcherCharacterId: currentPitcherStint?.character_id || null,
      pitcherPlayerId: currentPitcherStint?.player_id || null,
      pitcherId: currentPitcherChar?.name || '',
      pitcherPlayer: playersById[currentPitcherStint?.player_id]?.name || '',
    }
    setPaPitchRows((current) => [...current, enrichedEvent])
    setStarPitchActive(false)
    return enrichedEvent
  }, [clearRedoAction, currentPitcherChar?.name, currentPitcherStint?.character_id, currentPitcherStint?.player_id, playersById])

  const handlePitchBall = useCallback(() => {
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    lockPitchActions(160)
    const pitchEvent = appendPitchEvent(recordBall(starPitchActive))
    if (!pitchEvent) {
      unlockPitchActions()
      return
    }
    if (!pitchEvent.completedPa) {
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()

    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('BB', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner, false))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'BB',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: [...paPitchRows, pitchEvent],
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordBall, starPitchActive, appendPitchEvent, buildBatterRunner, runners, paPitchRows, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, syncLiveOddsForCount, lockPitchActions, unlockPitchActions])

  const handlePitchFoul = useCallback(() => {
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    lockPitchActions(160)
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordFoul(starPitchActive))
    if (!pitchEvent) {
      unlockPitchActions()
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitConnected(true)
      setStarHitUsed(false)
    }
    syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
  }, [canEditScorebook, recordFoul, starPitchActive, appendPitchEvent, starHitUsed, syncLiveOddsForCount, lockPitchActions, unlockPitchActions])

  const handlePitchHbp = useCallback(() => {
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    lockPitchActions(160)
    const pitchEvent = appendPitchEvent(recordHbp(starPitchActive))
    if (!pitchEvent) {
      unlockPitchActions()
      return
    }
    lockPitchActions()
    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('HBP', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner, false))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'HBP',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: [...paPitchRows, pitchEvent],
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordHbp, starPitchActive, appendPitchEvent, buildBatterRunner, runners, paPitchRows, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, lockPitchActions, unlockPitchActions])

  const handleStrikeChoice = useCallback((type) => {
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    lockPitchActions(160)
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordStrike(type, starPitchActive))
    if (!pitchEvent) {
      unlockPitchActions()
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitUsed(false)
    }
    setPitchActionSheet(null)
    if (!pitchEvent.completedPa) {
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()
    saveEnhancedPA({
      result: 'K',
      strikeoutType: pitchEvent.completedPa.strikeoutType,
      pitchRows: [...paPitchRows, pitchEvent],
      starPitchUsed: starPitchActive,
      starHitResult: usedStarHitOnPitch || starHitPending ? 'Out' : null,
    })
  }, [canEditScorebook, recordStrike, starPitchActive, appendPitchEvent, paPitchRows, saveEnhancedPA, starHitPending, starHitUsed, syncLiveOddsForCount, lockPitchActions, unlockPitchActions])

  const handlePitchInPlay = useCallback(() => {
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    // "In play" ends the pitch immediately, but the scorer may still back out of
    // the provisional result picker. Keep a pre-pitch snapshot so backing out
    // restores count + pitch history instead of leaking phantom pitches.
    lockPitchActions(160)
    const rollbackSnapshot = buildActivePaSnapshot()
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordInPlay(starPitchActive))
    if (!pitchEvent) {
      unlockPitchActions()
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitConnected(true)
      setStarHitUsed(false)
    }
    setPendingPitchEvent(pitchEvent)
    setInPlayState({
      stage: 'result',
      pitchEvent,
      pitchRows: [...paPitchRows, pitchEvent],
      usedStarHit: usedStarHitOnPitch || starHitPending,
      resultType: null,
      result: null,
      trajectory: null,
      landingSpot: null,
      fielderChain: [],
      rollbackSnapshot,
    })
  }, [canEditScorebook, buildActivePaSnapshot, recordInPlay, starPitchActive, appendPitchEvent, paPitchRows, starHitPending, starHitUsed, lockPitchActions, unlockPitchActions])

  const finalizeInPlay = useCallback(async (state) => {
    if (!canEditScorebook || !canFinalizeInPlaySelection(state)) return
    const usedStarHit = Boolean(state.usedStarHit || starHitPending || starHitUsed)
    const fielderChain = state.fielderChain || []
    const primaryPosition = state.result === 'HR'
      ? getHomeRunLandingPosition(state.landingSpot)
      : (fielderChain[0] || null)
    const direction = primaryPosition ? inferDirectionFromPosition(primaryPosition) : null
    const notation = state.result === 'HR'
      ? ''
      : (primaryPosition ? assembleNotation(state.trajectory, fielderChain) : '')
    const batterRunner = buildBatterRunner(state.resultType === 'error')

    if (isHomeRunResult(state.result)) {
      const runnersToScore = [runners.first, runners.second, runners.third, batterRunner].filter(Boolean)
      await saveEnhancedPA({
        result: state.result,
        rbi: runnersToScore.length - 1,
        runScored: true,
        trajectory: state.trajectory,
        hitLocation: primaryPosition,
        hitNotation: notation,
        direction,
        pitchRows: state.pitchRows,
        runEvents: runnersToScore.map((runner) => buildRunEvent(runner, true)).filter(Boolean),
        starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
        starHitResult: usedStarHit ? state.result : null,
        starHitRbi: usedStarHit ? runnersToScore.length : 0,
        nextRunners: { first: null, second: null, third: null },
      })
      pushRunners({ first: null, second: null, third: null })
      return
    }

    if (state.resultType === 'hit' && NEEDS_RESOLUTION.has(state.result)) {
      const pending = {
        result: state.result,
        ...computePendingState(state.result, runners, batterRunner),
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation: notation,
          direction,
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? state.result : null,
          starHitRbi: usedStarHit ? 0 : 0,
        },
      }
      setInPlayState(null)
      setPendingPA(pending)
      return
    }

    if (state.resultType === 'error') {
      const resolvedErrorPosition = fielderChain[0] || primaryPosition
      const errorFielder = activeDefensiveFielders[String(resolvedErrorPosition)]
      const pending = {
        result: 'ROE',
        ...computePendingState('ROE', runners, batterRunner),
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation: notation,
          direction,
          isError: true,
          errorPosition: resolvedErrorPosition,
          errorCharacter: errorFielder?.character || null,
          errorPlayer: errorFielder?.player_name || null,
          errorNotation: assembleErrorNotation(state.trajectory, fielderChain, resolvedErrorPosition),
          isEarnedRun: false,
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? 'Error' : null,
        },
      }
      setInPlayState(null)
      setPendingPA(pending)
      return
    }

    if (shouldResolveOutAssignments(state.result, runners)) {
      const pending = {
        ...computePendingOutState(state.result, runners, batterRunner, {
          primaryPosition,
          fielderChain,
        }),
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation: notation,
          direction,
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? 'Out' : null,
        },
      }
      if (!pendingLeavesRunnersOnBase(pending)) {
        const committed = await commitPendingPA(pending)
        if (committed) return
      }
      setInPlayState(null)
      setPendingPA(pending)
      return
    }

    const nextRunners = state.result === 'SH'
      ? { first: null, second: runners.first, third: runners.second }
      : computeImmediateNextRunners(state.result, runners, batterRunner)
    const thirdScores = (state.result === 'SF' || state.result === 'SH') && runners.third
    const runEvents = thirdScores ? [buildRunEvent(runners.third, true)] : []
    await saveEnhancedPA({
      result: state.result,
      rbi: thirdScores ? 1 : 0,
      trajectory: state.trajectory,
      hitLocation: primaryPosition,
      hitNotation: notation,
      direction,
      pitchRows: state.pitchRows,
      isOfficialAb: !['SF', 'SH'].includes(state.result),
      fielderChoiceOut: state.result === 'FC',
      runEvents,
      starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
      starHitResult: usedStarHit ? 'Out' : null,
      nextRunners,
    })
    pushRunners(nextRunners)
  }, [canEditScorebook, inferDirectionFromPosition, buildBatterRunner, runners, saveEnhancedPA, pushRunners, activeDefensiveFielders, buildRunEvent, starHitPending, starHitUsed, commitPendingPA])

  // ── Next half-inning ───────────────────────────────────────────────────────
  const handleNextHalfInning = useCallback(async () => {
    if (!canEditScorebook || !selectedGame) return
    const newHalfIdx = Math.floor(outsRecorded / 3)
    if (selectedGame && newHalfIdx >= 2 && scores.a + scores.b === 0) {
      try {
        await resolveFirstInningNoRun(selectedGame.id, betResolutionConfig)
      } catch (error) {
        pushToast({ title: 'First inning resolution failed', message: error.message, type: 'error' })
      }
    }
    if (newHalfIdx > 0) {
      const justFinishedTop = newHalfIdx % 2 === 1
      const justFinishedInning = justFinishedTop ? Math.ceil(newHalfIdx / 2) : (newHalfIdx / 2)
      const end = checkGameEnd({
        inning: justFinishedInning,
        isTop: justFinishedTop,
        halfCompleted: true,
        currentScores: scores,
        previousScores: scores,
      })
      if (end) {
        setGameEndBanner(end)
        setShowOutsBanner(false)
        setOverrideBatterIdx(null)
        resetRunners(true)
        return
      }
    }
    setShowOutsBanner(false)
    setOverrideBatterIdx(null)
    setPendingPA(null)
    setSelectedPitcher(null)
    resetRunners(true)
  }, [canEditScorebook, outsRecorded, selectedGame, scores, checkGameEnd, pushToast, resetRunners])

  // Auto-advance to the next half-inning instead of showing a "3 outs" confirmation.
  useEffect(() => {
    if (showOutsBanner && !gameEndBanner) {
      handleNextHalfInning()
    }
  }, [showOutsBanner, gameEndBanner, handleNextHalfInning])

  // ── Undo last PA ───────────────────────────────────────────────────────────

  async function saveEnhancedPA({
    result,
    rbi = 0,
    runScored = false,
    trajectory = null,
    hitLocation = null,
    hitNotation = null,
    direction = null,
    starHitResult = null,
    starHitRbi = 0,
    starPitchUsed = false,
    isError = false,
    errorPosition = null,
    errorCharacter = null,
    errorPlayer = null,
    errorNotation = null,
    isEarnedRun = true,
    strikeoutType = null,
    isOfficialAb = true,
    fielderChoiceOut = false,
    pitchRows = [],
    runEvents = [],
    nextRunners = runners,
  }) {
    if (!selectedGame || !offense || !currentBatter || !currentPitcherStint || isGameComplete) {
      return { halfCompleted: false, end: null }
    }
    if (isSavingRef.current) return { halfCompleted: false, end: null }
    isSavingRef.current = true
    // Capture outs-before-this-PA synchronously, before any awaits below run.
    // Otherwise React can flush the `outsRef.current = outsRecorded` effect
    // (triggered by setPlateAppearances further down) while we're awaiting,
    // making outsRef already reflect this PA's outs by the time we read it —
    // which makes halfCompleted always false and the half/game-end checks
    // never fire.
    const outsBeforePa = outsRef.current
    setIsSaving(true)
    lockPitchActions()
    if (saveWatchdogRef.current) clearTimeout(saveWatchdogRef.current)
    saveWatchdogRef.current = setTimeout(() => {
      if (!isSavingRef.current) return
      isSavingRef.current = false
      setIsSaving(false)
      unlockPitchActions()
      pushToast({
        title: 'Scorebook request timed out',
        message: 'The save took too long. Controls were re-enabled so you can retry after checking the play log.',
        type: 'error',
      })
    }, 15000)

    try {
    const paPayload = {
      game_id: selectedGame.id,
      player_id: currentBatter.player_id,
      character_id: currentBatter.character_id,
      batting_team_id: gameSession.teamIdByPlayerId?.[currentBatter.player_id] ?? null,
      defensive_team_id: gameSession.teamIdByPlayerId?.[offense.pitchingPlayerId] ?? null,
      pitcher_id: currentPitcherStint.character_id,
      pitcher_player_id: currentPitcherStint.player_id,
      inning: offense.inning,
      pa_number: editingPa?.pa_number ?? (gamePAs.length + 1),
      result,
      rbi: normalizeRbiForPaResult(result, rbi, isError),
      run_scored: runScored || false,
      trajectory,
      hit_location: hitLocation,
      hit_notation: hitNotation,
      direction,
      star_hit_used: Boolean(starHitPending || starHitUsed),
      star_hit_connected: Boolean(starHitConnected),
      star_hit_result: starHitResult,
      star_hit_rbi: Number(starHitRbi || 0),
      star_pitch_used: Boolean(starPitchUsed),
      star_pitch_successful: Boolean(starPitchUsed && calculateOutsForPa(result) > 0),
      is_error: Boolean(isError),
      error_position: errorPosition,
      error_character: errorCharacter,
      error_player: errorPlayer,
      error_notation: errorNotation,
      is_earned_run: Boolean(isEarnedRun),
      strikeout_type: strikeoutType,
      is_official_ab: Boolean(isOfficialAb),
      fielder_choice_out: Boolean(fielderChoiceOut),
    }

    const query = editingPa
      ? supabase.from(scorebookTables.plateAppearances).update(addSourceFields(paPayload)).eq('id', editingPa.id).select().single()
      : supabase.from(scorebookTables.plateAppearances).insert(addSourceFields(paPayload)).select().single()
    const { data: savedPa, error } = await query
    if (error) {
      if (
        error.message?.includes('trajectory')
        || error.message?.includes('hit_location')
        || error.message?.includes('star_hit_used')
        || error.message?.includes('pitcher_id')
        || error.message?.includes('is_official_ab')
      ) {
        pushToast({
          title: 'Missing scorebook migration',
          message: 'Your Supabase schema is behind. Apply the scorebook overhaul migration, then save again.',
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
      pushToast({ title: 'Save failed', message: error.message, type: 'error' })
      return { halfCompleted: false, end: null }
    }
    clearRedoAction()

    if (pitchRows.length) {
      const pitchPayload = pitchRows.map((pitch, index) => ({
        game_id: selectedGame.id,
        pa_id: savedPa.id,
        pitcher_id: pitch.pitcherId || currentPitcherChar?.name || '',
        pitcher_player: pitch.pitcherPlayer || playersById[pitch.pitcherPlayerId || currentPitcherStint.player_id]?.name || '',
        batter_id: charactersById[currentBatter.character_id]?.name || '',
        inning: offense.inning,
        half: offense.isTop ? 'top' : 'bottom',
        pitch_number_pa: pitch.pitchNumberPa || index + 1,
        pitch_number_game: pitch.pitchNumberGame || pitchNumber,
        is_star_pitch: Boolean(pitch.pitch?.is_star_pitch),
        result: pitch.pitch?.result,
        count_balls_before: pitch.pitch?.count_balls_before ?? 0,
        count_strikes_before: pitch.pitch?.count_strikes_before ?? 0,
        count_balls_after: pitch.pitch?.count_balls_after ?? 0,
        count_strikes_after: pitch.pitch?.count_strikes_after ?? 0,
      }))
      const { error: pitchInsertError } = await supabase.from(scorebookTables.pitches).insert(pitchPayload.map(addSourceFields))
      if (pitchInsertError) {
        pushToast({
          title: 'Pitch save failed',
          message: pitchInsertError.message,
          type: 'error',
        })
      }
    }

    if (runEvents.length) {
      const runPayload = runEvents.map((run) => ({
        game_id: selectedGame.id,
        pa_id: savedPa.id,
        inning: offense.inning,
        half: offense.isTop ? 'top' : 'bottom',
        scoring_player_id: run.playerId,
        scoring_character_id: run.characterId,
        charged_to_pitcher_id: run.chargedToPitcherId ?? currentPitcherStint.character_id,
        charged_to_pitcher_player_id: run.chargedToPitcherPlayerId ?? currentPitcherStint.player_id,
        is_earned_run: run.isEarnedRun !== false,
      }))
      const { error: runsInsertError } = await supabase.from(scorebookTables.runsScored).insert(runPayload.map(addSourceFields))
      if (runsInsertError) {
        pushToast({
          title: 'Run save failed',
          message: runsInsertError.message,
          type: 'error',
        })
      }
    }

    const [{ data: freshPAs }, { data: freshPitches }, { data: freshRuns }] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGame.id).order('created_at'),
    ])
    const allPAs = freshPAs || []
    const allPitches = freshPitches || []
    const allRuns = freshRuns || []
    deferRealtimeHydration()
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    await syncScores(allPAs, selectedGame, allRuns)
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns)

    if (!editingPa) {
      try {
        await resolveOnPA(selectedGame.id, { ...paPayload, id: savedPa.id }, betResolutionConfig)
        const currentOdds = await ensureLiveOdds(gamePitching, allPAs)
        const recalcOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0)
        const recalcOffense = deriveOffense(selectedGame, recalcOuts)
        // The odds model's "home"/"away"/isTop convention is team-A=away/team-B=home,
        // independent of the swap — so derive these from which team is batting,
        // not the structural top/bottom of the inning.
        const recalcIsTeamABatting = String(recalcOffense.battingPlayerId) === String(selectedGame.team_a_player_id)
        const recalcHomeScore = runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns)
        const recalcAwayScore = runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns)
        const freshOddsContext = buildSharedOddsGenerationContext({
          game: selectedGame,
          draftPicks,
          charactersById,
          gamePAs: allPAs,
          gamePitching,
          allGames: games,
          allPAs: plateAppearances,
          allPitching: pitchingStints,
          stadiumsById,
          stadiumGameLog,
          playersById,
          currentInning: recalcOffense.inning,
          scores: { a: recalcAwayScore, b: recalcHomeScore },
          totalInnings: regulationInnings,
          bets: gameBets,
        })
        const changedRows = recalculateOdds(currentOdds || [], {
          battingSide: isTeamABatting ? 'away' : 'home',
          isTop: isTeamABatting,
          paCount: allPAs.length,
          runsThisHalf: runsThisHalfFromPAs(allPAs, currentBatter.player_id, offense.inning, allRuns),
          generationContext: { ...freshOddsContext, weights: { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 } },
          oddsContext: freshOddsContext,
          liveState: {
            homeScore: recalcHomeScore,
            awayScore: recalcAwayScore,
            currentInning: recalcOffense.inning,
            isTop: recalcIsTeamABatting,
            outsInHalf: recalcOuts % 3,
            regulationInnings,
            runnersOccupied: [nextRunners?.first, nextRunners?.second, nextRunners?.third].filter(Boolean).length,
            balls: 0,
            strikes: 0,
            paCount: allPAs.length,
            status: 'active',
          },
        }, paPayload)
        await upsertChangedOdds(changedRows)
      } catch (bettingError) {
        pushToast({ title: 'Betting update failed', message: bettingError.message, type: 'error' })
      }
    }

    const nextScores = {
      a: runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns),
      b: runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns),
    }
    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result), 0)
    const prevHalf = Math.floor(outsBeforePa / 3)
    const newHalf = Math.floor(newOuts / 3)
    const halfCompleted = newHalf > prevHalf
    const end = checkGameEnd({
      inning: offense.inning,
      isTop: offense.isTop,
      halfCompleted,
      currentScores: nextScores,
      previousScores: scores,
    })
    if (end) {
      setGameEndBanner(end)
      setShowOutsBanner(false)
    } else if (halfCompleted) {
      setShowOutsBanner(true)
    }
    if (end || halfCompleted) resetRunners(false)

    if (navigator.vibrate) navigator.vibrate(50)
    setEditingPa(null)
    setOverrideBatterIdx(null)
    setStarPitchActive(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setPaPitchRows([])
    setInPlayState(null)
    setRbiOverlay(null)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    resetPitchCount()
    if (selectedGame?.id) {
      try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    }
    return { halfCompleted, end }
    } finally {
      if (saveWatchdogRef.current) {
        clearTimeout(saveWatchdogRef.current)
        saveWatchdogRef.current = null
      }
      isSavingRef.current = false
      setIsSaving(false)
      unlockPitchActions()
    }
  }

  const currentPitcherGameLine = useMemo(() => ({
    ip: currentPitcherStint?.innings_pitched ?? 0,
    h: currentPitcherStint?.hits_allowed ?? 0,
    r: currentPitcherStint?.runs_allowed ?? 0,
    er: currentPitcherStint?.earned_runs ?? 0,
    bb: currentPitcherStint?.walks ?? 0,
    k: currentPitcherStint?.strikeouts ?? 0,
  }), [currentPitcherStint])

  const undoLastPA = useCallback(async () => {
    if (isGameComplete || !gamePAs.length || !selectedGame) return
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const redoSnapshot = {
      type: 'pa',
      gameId: String(selectedGame.id),
      pa: stripDbManagedFields(last),
      pitches: gamePitches
        .filter((pitch) => String(pitch.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runs: gameRuns
        .filter((run) => String(run.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runnersAfter: { ...runners },
    }
    const { error } = await supabase.from(scorebookTables.plateAppearances).delete().eq('id', last.id)
    if (error) { pushToast({ title: 'Undo failed', message: error.message, type: 'error' }); return }
    setRedoAction(redoSnapshot)
    const [{ data: freshPAs }, { data: freshPitches }, { data: freshRuns }] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGame.id).order('created_at'),
    ])
    const allPAs = freshPAs || []
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...(freshPitches || [])])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...(freshRuns || [])])
    await syncScores(allPAs, selectedGame, freshRuns || [])
    await syncInningScores({ freshPAs: allPAs, freshRuns: freshRuns || [], game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, freshRuns || [])
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    setPaPitchRows([])
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    popRunners()
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    if (navigator.vibrate) navigator.vibrate(30)
  }, [isGameComplete, gamePAs, selectedGame, gamePitches, gameRuns, runners, pushToast, popRunners, recomputePitchingStatsForGame, gamePitching])

  const undoLastPitch = useCallback(() => {
    if (isGameComplete || !paPitchRows.length) return
    const removedPitch = paPitchRows[paPitchRows.length - 1]
    setRedoAction({
      type: 'pitch',
      scope: currentActivePaScope,
      snapshot: {
        balls,
        strikes,
        pitchNumber,
        paPitchRows,
        pendingPA,
        pitchActionSheet,
        pendingPitchEvent,
        inPlayState,
        rbiOverlay,
        starPitchActive,
        starHitUsed,
        starHitPending,
        starHitConnected,
      },
    })
    undoPitch(removedPitch)
    setPaPitchRows((current) => current.slice(0, -1))
    setPendingPA(null)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    setStarPitchActive(false)
    if (paPitchRows.length <= 1) {
      setStarHitUsed(false)
      setStarHitPending(false)
      setStarHitConnected(false)
    }
    if (navigator.vibrate) navigator.vibrate(20)
  }, [isGameComplete, balls, strikes, pitchNumber, paPitchRows, pendingPA, pitchActionSheet, pendingPitchEvent, inPlayState, rbiOverlay, starPitchActive, starHitUsed, starHitPending, starHitConnected, currentActivePaScope, undoPitch])

  const canRedoAction = Boolean(
    redoAction
    && (
      (redoAction.type === 'pa' && String(redoAction.gameId) === String(selectedGameId))
      || (redoAction.type === 'pitch' && redoAction.scope === currentActivePaScope)
    )
  )

  const handleRedoAction = useCallback(async () => {
    if (isGameComplete || !redoAction) return

    // Capture before any awaits — see comment in saveEnhancedPA.
    const outsBeforeRedo = outsRef.current

    if (redoAction.type === 'pitch') {
      if (redoAction.scope !== currentActivePaScope) return
      restoreActivePaSnapshot(redoAction.snapshot)
      clearRedoAction()
      if (navigator.vibrate) navigator.vibrate(20)
      return
    }

    if (!selectedGame || String(redoAction.gameId) !== String(selectedGame.id)) return

    const { data: restoredPa, error } = await supabase
      .from(scorebookTables.plateAppearances)
      .insert(redoAction.pa)
      .select()
      .single()
    if (error) {
      pushToast({ title: 'Redo failed', message: error.message, type: 'error' })
      return
    }

    if (redoAction.pitches?.length) {
      const { error: pitchInsertError } = await supabase
        .from(scorebookTables.pitches)
        .insert(redoAction.pitches.map((pitch) => ({ ...pitch, pa_id: restoredPa.id })))
      if (pitchInsertError) {
        pushToast({ title: 'Pitch restore failed', message: pitchInsertError.message, type: 'error' })
      }
    }

    if (redoAction.runs?.length) {
      const { error: runsInsertError } = await supabase
        .from(scorebookTables.runsScored)
        .insert(redoAction.runs.map((run) => ({ ...run, pa_id: restoredPa.id })))
      if (runsInsertError) {
        pushToast({ title: 'Run restore failed', message: runsInsertError.message, type: 'error' })
      }
    }

    const [{ data: freshPAs }, { data: freshPitches }, { data: freshRuns }] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGame.id).order('created_at'),
    ])
    const allPAs = freshPAs || []
    const allPitches = freshPitches || []
    const allRuns = freshRuns || []
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    await syncScores(allPAs, selectedGame, allRuns)
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns)

    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result), 0)
    const prevHalf = Math.floor(outsBeforeRedo / 3)
    const newHalf = Math.floor(newOuts / 3)

    setShowOutsBanner(newHalf > prevHalf)
    setGameEndBanner(null)
    setPendingPA(null)
    setPaPitchRows([])
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    pushRunners(redoAction.runnersAfter || { first: null, second: null, third: null })
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    clearRedoAction()
    if (navigator.vibrate) navigator.vibrate(30)
  }, [isGameComplete, redoAction, currentActivePaScope, selectedGame, restoreActivePaSnapshot, clearRedoAction, pushToast, recomputePitchingStatsForGame, gamePitching, pushRunners])

  const handleUndoAction = useCallback(() => {
    if (!canEditScorebook) return
    if (paPitchRows.length) {
      undoLastPitch()
      return
    }
    undoLastPA()
  }, [canEditScorebook, paPitchRows.length, undoLastPitch, undoLastPA])

  // ── Auto-seed lineups ──────────────────────────────────────────────────────
  const syncGameLineupsFromRoster = useCallback(async () => {
    if (!canEditScorebook) return
    if (!selectedGame || isGameComplete) return
    if (gamePAs.length > 0) return
    // Once a lineup and its fielding assignments exist for this game, leave them
    // alone — re-running the roster-based seed here would silently overwrite any
    // manual edits made in the Lineups tab (e.g. after navigating away and back).
    if (gameLineups.length > 0 && gameFielderRows.length > 0) return
    if (isSyncingLineupsRef.current) return
    isSyncingLineupsRef.current = true
    try {
      const defaultPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9]
      const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
      const [savedTeamA, savedTeamB] = await Promise.all([
        fetchTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId: selectedGame.team_a_player_id }),
        fetchTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId: selectedGame.team_b_player_id }),
      ])
      const buildRows = (roster, playerId, saved) => {
        let picks = roster.filter(p => p.character_id)
        if (saved && Array.isArray(saved.lineupOrder) && saved.lineupOrder.length) {
          const byCharId = Object.fromEntries(picks.map(p => [p.character_id, p]))
          const ordered = saved.lineupOrder.map(id => byCharId[id]).filter(Boolean)
          const rest = picks.filter(p => !saved.lineupOrder.includes(p.character_id))
          picks = [...ordered, ...rest]
        }
        return picks.slice(0, 9).map((pick, i) => ({
          game_id: selectedGame.id,
          player_id: playerId,
          character_id: pick.character_id,
          batting_order: i + 1,
        }))
      }

      const desiredPayload = [
        ...buildRows(teamRosters.teamA, selectedGame.team_a_player_id, savedTeamA),
        ...buildRows(teamRosters.teamB, selectedGame.team_b_player_id, savedTeamB),
      ]

      if (!desiredPayload.length) return

      const currentSignature = gameLineups
        .map((row) => `${row.player_id}:${row.character_id}:${row.batting_order}`)
        .join('|')
      const desiredSignature = desiredPayload
        .map((row) => `${row.player_id}:${row.character_id}:${row.batting_order}`)
        .join('|')

      if (currentSignature === desiredSignature && gameFielderRows.length > 0) return
      // Avoid re-running the delete/insert cycle while the realtime echo of our own
      // previous sync is still propagating back (which would otherwise transiently
      // empty `lineups` and re-trigger this effect, causing the lineup to flicker).
      if (lastSyncedLineupSignatureRef.current === desiredSignature) return

      const lineupPayload = desiredPayload.map(addSourceFields)
      const fielderPayload = desiredPayload.map((row, index) => ({
        game_id: selectedGame.id,
        team_id: isSeasonGame ? gameSession.teamIdByPlayerId?.[row.player_id] || null : row.player_id,
        player_name: playersById[row.player_id]?.name || '',
        character: charactersById[row.character_id]?.name || '',
        position: defaultPositions[index % defaultPositions.length],
        inning_from: 1,
        inning_to: null,
      }))

      const [deleteLineupsResult, deleteFieldersResult] = await Promise.all([
        supabase.from(scorebookTables.lineups).delete().eq('game_id', selectedGame.id),
        supabase.from(scorebookTables.gameFielders).delete().eq('game_id', selectedGame.id),
      ])

      if (deleteLineupsResult.error) {
        pushToast({ title: 'Lineup sync failed', message: deleteLineupsResult.error.message, type: 'error' })
        return
      }
      if (deleteFieldersResult.error) {
        pushToast({ title: 'Fielder sync failed', message: deleteFieldersResult.error.message, type: 'error' })
        return
      }

      const { data: insertedLineups, error: lineupError } = await supabase.from(scorebookTables.lineups).insert(lineupPayload).select()
      if (lineupError) {
        pushToast({ title: 'Lineup sync failed', message: lineupError.message, type: 'error' })
        return
      }

      const { data: insertedFielders, error: fielderError } = await supabase.from(scorebookTables.gameFielders).insert(fielderPayload.map(addSourceFields)).select()
      if (fielderError) {
        pushToast({ title: 'Fielder sync failed', message: fielderError.message, type: 'error' })
        return
      }

      deferRealtimeHydration()
      setLineups((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGame.id)), ...(insertedLineups || lineupPayload)])
      setGameFielders((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGame.id)), ...(insertedFielders || fielderPayload)])
      lastSyncedLineupSignatureRef.current = desiredSignature
    } finally {
      isSyncingLineupsRef.current = false
    }
  }, [canEditScorebook, selectedGame, isGameComplete, gamePAs.length, gameLineups, gameFielderRows.length, teamRosters, gameSession, addSourceFields, playersById, charactersById, scorebookTables.lineups, scorebookTables.gameFielders, pushToast, isSeasonGame, deferRealtimeHydration])

  useEffect(() => {
    lastSyncedLineupSignatureRef.current = null
  }, [selectedGame?.id])

  useEffect(() => {
    if (!canEditScorebook) return
    if (!selectedGame) return
    const total = teamRosters.teamA.length + teamRosters.teamB.length
    if (total === 0) return
    syncGameLineupsFromRoster()
  }, [canEditScorebook, selectedGame?.id, teamRosters.teamA.length, teamRosters.teamB.length, gameLineups.length, gamePAs.length, gameFielderRows.length, syncGameLineupsFromRoster])

  // ── Mark game complete ─────────────────────────────────────────────────────
  const markGameComplete = useCallback(async (winnerId, finalInning, isExtra) => {
    if (!selectedGame) return
    const resolved = winnerId ?? (scores.a === scores.b ? null : scores.a > scores.b ? selectedGame.team_a_player_id : selectedGame.team_b_player_id)
    const clearedLiveState = getPersistedLiveStateValue(null, isSeasonGame)
    const completionUpdate = isSeasonGame
      ? {
          status: 'completed',
          live_state: clearedLiveState,
          winner_team_id: resolved ? gameSession.teamIdByPlayerId?.[resolved] || null : null,
          away_score: scores.a,
          home_score: scores.b,
          final_inning: finalInning || currentInning,
          is_extra_innings: isExtra || false,
        }
      : {
          status: 'complete',
          live_state: clearedLiveState,
          winner_player_id: resolved,
          team_a_runs: scores.a,
          team_b_runs: scores.b,
          final_inning: finalInning || currentInning,
          is_extra_innings: isExtra || false,
        }
    const { error } = await supabase.from(scorebookTables.games).update(completionUpdate).eq('id', selectedGame.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    const completedGame = {
      ...selectedGame,
      status: 'complete',
      winner_player_id: resolved,
      team_a_runs: scores.a,
      team_b_runs: scores.b,
      final_inning: finalInning || currentInning,
      is_extra_innings: isExtra || false,
      live_state: clearedLiveState,
    }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? completedGame : g))
    setGameEndBanner(null)
    if (selectedGame.stadium_id || selectedGame.stadium) {
      const stadiumLogPayload = isSeasonGame
        ? {
            game_id: selectedGame.id,
            season_id: gameSession?.sourceId,
            stadium: selectedStadium?.name || selectedGame.stadium || null,
            is_night: Boolean(selectedGame.is_night),
            total_runs: scores.a + scores.b,
            confidence: 1.0,
          }
        : {
            game_id: selectedGame.id,
            stadium_id: selectedGame.stadium_id,
            is_night: Boolean(selectedGame.is_night),
            total_runs: scores.a + scores.b,
            confidence: 1.0,
          }
      const { error: stadiumLogError } = await supabase.from(scorebookTables.stadiumGameLog).insert(stadiumLogPayload)
      if (stadiumLogError) {
        pushToast({ title: 'Stadium log failed', message: stadiumLogError.message, type: 'error' })
      }
    }
    try {
      const pitcherKTotals = {}
      gamePitching.forEach((stint) => {
        const key = buildBettingEntityLabel(charactersById[stint.character_id], playersById[stint.player_id])
        pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
      })
      const hrTotals = {}
      const hitTotals = {}
      gamePAs.forEach((pa) => {
        const key = buildBettingEntityLabel(charactersById[pa.character_id], playersById[pa.player_id])
        if (pa.result === 'HR' || pa.result === 'IPHR') hrTotals[key] = Number(hrTotals[key] || 0) + 1
        if (HIT_RESULTS.has(pa.result)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
      })
      await resolveGameBets(
        selectedGame.id,
        resolved === selectedGame.team_b_player_id ? 'home' : 'away',
        scores.a + scores.b,
        pitcherKTotals,
        Math.abs(scores.a - scores.b),
        betResolutionConfig,
        hrTotals,
        hitTotals,
      )
    } catch (bettingError) {
      pushToast({ title: 'Bet resolution failed', message: bettingError.message, type: 'error' })
    }
    try {
      if (isSeasonGame) {
        await gameSession.onGameComplete({ selectedGame: completedGame, scores })
      } else {
        const createdGames = await advanceBracketOnGameComplete({
          supabase,
          tournament,
          games: games.map((game) => (game.id === selectedGame.id ? completedGame : game)),
          completedGame,
        })
        if (createdGames.length) {
          setGames((current) => {
            const existingById = new Map(current.map((game) => [game.id, game]))
            createdGames.forEach((game) => existingById.set(game.id, game))
            return Array.from(existingById.values())
          })
        }
      }
    } catch (bracketError) {
      pushToast({ title: isSeasonGame ? 'Season update failed' : 'Bracket update failed', message: bracketError.message, type: 'error' })
    }
    pushToast({ title: 'Game complete', type: 'success' })
  }, [selectedGame, scores, currentInning, pushToast, gamePitching, charactersById, playersById, tournament, games, isSeasonGame, gameSession, scorebookTables.games, scorebookTables.stadiumGameLog, selectedStadium, betResolutionConfig])

  const reopenCompletedGame = useCallback(async () => {
    if (!selectedGame || !isGameComplete) return

    const reopenedStatus = isSeasonGame ? 'in_progress' : 'active'
    const clearedLiveState = getPersistedLiveStateValue(null, isSeasonGame)
    const reopenUpdate = isSeasonGame
      ? {
          status: reopenedStatus,
          live_state: clearedLiveState,
          winner_team_id: null,
          away_score: scores.a,
          home_score: scores.b,
          final_inning: null,
          is_extra_innings: false,
        }
      : {
          status: reopenedStatus,
          live_state: clearedLiveState,
          winner_player_id: null,
          team_a_runs: scores.a,
          team_b_runs: scores.b,
          final_inning: null,
          is_extra_innings: false,
        }

    const { error } = await supabase.from(scorebookTables.games).update(reopenUpdate).eq('id', selectedGame.id)
    if (error) {
      pushToast({ title: 'Reopen failed', message: error.message, type: 'error' })
      return
    }

    const reopenedGame = {
      ...selectedGame,
      status: 'active',
      winner_player_id: null,
      team_a_runs: scores.a,
      team_b_runs: scores.b,
      final_inning: null,
      is_extra_innings: false,
      live_state: clearedLiveState,
    }

    setGames((current) => current.map((game) => (game.id === selectedGame.id ? reopenedGame : game)))
    setShowReopenGameConfirm(false)
    setGameEndBanner(null)
    setShowOutsBanner(false)

    try {
      const { error: stadiumLogError } = await supabase.from(scorebookTables.stadiumGameLog).delete().eq('game_id', selectedGame.id)
      if (stadiumLogError) throw stadiumLogError
    } catch (stadiumError) {
      pushToast({ title: 'History cleanup failed', message: stadiumError.message, type: 'error' })
    }

    try {
      await reopenGameBets(selectedGame.id, betResolutionConfig)
    } catch (bettingError) {
      pushToast({ title: 'Bet reopen failed', message: bettingError.message, type: 'error' })
    }

    try {
      if (isSeasonGame) {
        await gameSession.onGameReopen?.({ selectedGame: reopenedGame })
      } else {
        if (tournament && (tournament.status === 'complete' || tournament.champion_player_id != null)) {
          const { error: tournamentError } = await supabase
            .from('tournaments')
            .update({ champion_player_id: null, status: 'active' })
            .eq('id', tournament.id)
          if (tournamentError) throw tournamentError
        }

        const syncedGames = await reopenBracketAfterGameEdit({
          supabase,
          tournament,
          games: games.map((game) => (game.id === selectedGame.id ? reopenedGame : game)),
          reopenedGame,
        })

        if (syncedGames.length) {
          setGames((current) => {
            const existingById = new Map(current.map((game) => [game.id, game]))
            syncedGames.forEach((game) => existingById.set(game.id, game))
            return Array.from(existingById.values())
          })
        }
      }
    } catch (syncError) {
      pushToast({ title: isSeasonGame ? 'Season reopen failed' : 'Bracket reopen failed', message: syncError.message, type: 'error' })
    }

    pushToast({ title: 'Game reopened', type: 'success' })
  }, [selectedGame, isGameComplete, isSeasonGame, scores.a, scores.b, scorebookTables.games, scorebookTables.stadiumGameLog, pushToast, betResolutionConfig, gameSession, tournament, games])

  // ── Swap home / away teams ────────────────────────────────────────────────
  const swapTeams = useCallback(async () => {
    if (!selectedGame) return
    const { error } = await supabase.from(scorebookTables.games).update({
      team_a_player_id: selectedGame.team_b_player_id,
      team_b_player_id: selectedGame.team_a_player_id,
      team_a_runs: selectedGame.team_b_runs,
      team_b_runs: selectedGame.team_a_runs,
    }).eq('id', selectedGame.id)
    if (error) { pushToast({ title: 'Swap failed', message: error.message, type: 'error' }); return }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? {
      ...g,
      team_a_player_id: g.team_b_player_id,
      team_b_player_id: g.team_a_player_id,
      team_a_runs: g.team_b_runs,
      team_b_runs: g.team_a_runs,
    } : g))
    pushToast({ title: 'Teams swapped — Away/Home flipped', type: 'success' })
  }, [selectedGame, pushToast, scorebookTables.games])

  // ── Pitcher change (drag to mound or double-tap) ──────────────────────────
  const changePitcher = useCallback(async (playerId, characterId) => {
    if (!selectedGame || !canEditScorebook) return
    if (Number(currentPitcherStint?.character_id) === Number(characterId)) return
    const previousPitcherStint = currentPitcherStint
    const newStint = {
      game_id: selectedGame.id, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0,
    }
    const { data, error } = await supabase.from(scorebookTables.pitchingStints).insert(addSourceFields(newStint)).select().single()
    if (error) { pushToast({ title: 'Pitcher change failed', message: error.message, type: 'error' }); return }
    // Optimistic update — don't wait for realtime to refresh the mound
    if (data) setPitchingStints(cur => [...cur, data])
    try {
      const nextPitching = data ? [...gamePitching, data] : gamePitching
      const generationContext = buildOddsGenerationContext(nextPitching, gamePAs)
      const currentOdds = await ensureLiveOdds(nextPitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        pitcherSwap: true,
        generationContext: generationContext ? { ...generationContext, weights: { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 } } : null,
      })
      await upsertChangedOdds(changedRows)

      // The old pitcher can no longer rack up strikeouts — if nobody has bet
      // on their k_prop yet, remove it entirely instead of leaving it locked.
      if (previousPitcherStint && Number(previousPitcherStint.character_id) !== Number(characterId)) {
        const oldChar = charactersById[previousPitcherStint.character_id]
        const oldPlayer = playersById[previousPitcherStint.player_id]
        const oldLabel = oldChar ? buildBettingEntityLabel(oldChar, oldPlayer) : null
        const staleKProp = oldLabel
          ? (currentOdds || []).find((row) => row.bet_type === 'k_prop' && row.target_entity === oldLabel)
          : null
        if (staleKProp?.id) {
          const { data: relatedBets } = await supabase.from(scorebookTables.bets).select('id').eq('game_odds_id', staleKProp.id).limit(1)
          if (!relatedBets || relatedBets.length === 0) {
            await supabase.from(scorebookTables.gameOdds).delete().eq('id', staleKProp.id)
          }
        }
      }
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
    pushToast({ title: `Pitcher → ${charactersById[characterId]?.name}`, type: 'success' })
  }, [selectedGame, canEditScorebook, charactersById, playersById, pushToast, gamePitching, currentPitcherStint, buildOddsGenerationContext, gamePAs, upsertChangedOdds, ensureLiveOdds, scorebookTables.pitchingStints, scorebookTables.bets, scorebookTables.gameOdds, addSourceFields])

  // Keep a stable ref to the latest changePitcher so saveTeamLineup (defined
  // earlier in the component) can trigger pitcher changes without a circular
  // dependency.
  useEffect(() => { changePitcherRef.current = changePitcher }, [changePitcher])

  const handleMoundDragOver = useCallback((e) => { e.preventDefault(); setIsDragOverMound(true) }, [])
  const handleMoundDragLeave = useCallback(() => setIsDragOverMound(false), [])
  const handleMoundDrop = useCallback(async (e) => {
    if (!canEditScorebook) return
    e.preventDefault()
    setIsDragOverMound(false)
    const charId   = parseInt(e.dataTransfer.getData('pitcherCharId'), 10)
    const playerId = e.dataTransfer.getData('pitcherPlayerId')
    if (!charId || !playerId) return
    if (playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team\'s players can be dragged to the mound.', type: 'error' })
      return
    }
    if (charId === currentPitcherStint?.character_id) return
    await changePitcher(playerId, charId)
  }, [canEditScorebook, offense, currentPitcherStint, changePitcher, pushToast])

  const handlePitcherDragStart = useCallback((charId, playerId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('pitcherCharId', String(charId))
    e.dataTransfer.setData('pitcherPlayerId', String(playerId))
  }, [])

  // Tap-to-select pitcher: first tap selects (purple), second tap confirms change
  const handlePitcherItemClick = useCallback(async (charId, playerId) => {
    if (!canEditScorebook) return
    if (charId === currentPitcherStint?.character_id) return // already pitching
    if (selectedPitcher?.charId === charId) {
      // Second tap — confirm
      await changePitcher(playerId, charId)
      setSelectedPitcher(null)
    } else {
      // First tap — select
      setSelectedPitcher({ charId, playerId })
    }
  }, [canEditScorebook, currentPitcherStint, selectedPitcher, changePitcher])

  // Mound click still works as an alternative confirm
  const handleMoundClick = useCallback(async () => {
    if (!canEditScorebook) return
    if (!selectedPitcher) return
    if (selectedPitcher.playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team can be assigned to the mound.', type: 'error' })
      setSelectedPitcher(null)
      return
    }
    await changePitcher(selectedPitcher.playerId, selectedPitcher.charId)
    setSelectedPitcher(null)
  }, [canEditScorebook, selectedPitcher, offense, changePitcher, pushToast])

  useEffect(() => {
    if (!selectedGame || isGameComplete || !offense?.pitchingPlayerId || currentPitcherStint || !defensiveLineup.length) return

    const assignKey = `${selectedGame.id}-${offense.pitchingPlayerId}`
    if (autoPitcherAssignRef.current === assignKey) return

    autoPitcherAssignRef.current = assignKey
    const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
    fetchTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId: offense.pitchingPlayerId }).then((saved) => {
      const savedPitcherCharId = saved?.fieldingPositions?.pitcher ? Number(saved.fieldingPositions.pitcher) : null
      const savedPitcher = defensiveLineup.find((entry) => Number(entry.character_id) === Number(savedPitcherCharId))
      const fallbackPitcher = defensiveLineup[0] || null
      const pitcherToUse = savedPitcher || fallbackPitcher
      if (!pitcherToUse?.character_id) {
        autoPitcherAssignRef.current = null
        return
      }
      changePitcher(offense.pitchingPlayerId, pitcherToUse.character_id).finally(() => {
        if (autoPitcherAssignRef.current === assignKey) autoPitcherAssignRef.current = null
      })
    })
  }, [selectedGame?.id, isGameComplete, offense?.pitchingPlayerId, currentPitcherStint?.id, defensiveLineup, isSeasonGame, gameSession?.sourceId, changePitcher])

  // ── Add game ───────────────────────────────────────────────────────────────
  const addGame = useCallback(async () => {
    if (!tournament || !selectedAddGameStadium) return
    const highestCode = Math.max(...filteredGames.map(g => parseInt(String(g.game_code || '').replace(/\D/g, '') || '0')), 0)
    const { data, error } = await supabase.from('games').insert({
      tournament_id: tournament.id,
      game_code: `G${highestCode + 1}`,
      stage: addGameForm.stage || 'Game',
      team_a_player_id: addGameForm.teamA || null,
      team_b_player_id: addGameForm.teamB || null,
      stadium_id: selectedAddGameStadium.id,
      is_night: normalizeIsNightForStadium(selectedAddGameStadium, addGameForm.isNight),
      team_a_runs: 0, team_b_runs: 0, status: 'pending',
    }).select().single()
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, data])
    setShowAddGame(false)
    setAddGameForm({
      teamA: '',
      teamB: '',
      stage: '',
      stadiumId: selectedAddGameStadium.id,
      isNight: normalizeIsNightForStadium(selectedAddGameStadium, false),
    })
    pushToast({ title: `${data.game_code} added`, type: 'success' })
    navigate(buildScorebookPath({ gameId: data.id, source: isSeasonGame ? 'season' : 'tournament' }))
  }, [tournament, filteredGames, addGameForm, pushToast, selectedAddGameStadium, navigate, isSeasonGame])

  // ─── Loading state ──────────────────────────────────────────────────────────
  if (!dataLoaded) {
    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted">Loading scorebook…</p>
        </section>
      </div>
    )
  }

  // ─── Empty state ────────────────────────────────────────────────────────────
  if (!selectedGame) {
    const emptyMessage = filteredGames.length === 0
      ? (isSeasonGame ? 'No games are available for this season yet.' : 'No games created yet for this tournament.')
      : `This scorebook view needs a specific game. Open one from ${isSeasonGame ? 'the season schedule or playoff bracket' : 'the tournament bracket'}.`

    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 16 }}>{emptyMessage}</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="ghost-button" onClick={() => navigate(backPath)} type="button">{backLabel}</button>
            {!isSeasonGame && filteredGames.length === 0 && isCommissioner && (
              <button className="solid-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
            )}
          </div>
        </section>
        {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      </div>
    )
  }

  if (!selectedGame && filteredGames.length === 0) {
    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 16 }}>No games created yet for this tournament.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="ghost-button" onClick={() => navigate('/bracket')} type="button">Go to Bracket →</button>
            {isCommissioner && (
              <button className="solid-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
            )}
          </div>
        </section>
        {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      </div>
    )
  }

  // ── Spectator mode ──────────────────────────────────────────────────────────
  const viewTabs = isScorekeeper ? (
    <div style={{ padding: '10px 12px 0' }}>
      <div style={{ display: 'inline-flex', gap: 6, padding: 4, borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}DD` }}>
        {[
          { key: 'game', label: 'Game View' },
          { key: 'scorebook', label: 'Scorebook' },
          { key: 'lineups', label: 'Lineups' },
          { key: 'admin', label: 'Admin' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setViewMode(tab.key)}
            style={{
              border: 'none',
              borderRadius: 999,
              padding: '8px 14px',
              cursor: 'pointer',
              background: viewMode === tab.key ? C.accent : 'transparent',
              color: viewMode === tab.key ? '#000' : '#E2E8F0',
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  ) : null

  const renderGameView = () => (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {scorebookToolbar}
      {viewTabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        <SectionCard
          title={selectedGame.stage ? normalizeStageLabel(selectedGame.stage) : ''}
          right={(
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: effectiveGameStatus === 'complete' ? C.green : effectiveGameStatus === 'active' ? C.accent : '#93C5FD', fontSize: 12, fontWeight: 800, textTransform: 'uppercase' }}>
                {formatGameStatusLabel(selectedGame, effectiveGameStatus, offense?.halfLabel, regulationInnings)}
              </div>
            </div>
          )}
        >
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} />
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {(() => {
                const teamARow = { key: homeAwaySwapped ? 'home' : 'away', abbreviation: teamAAbbreviation, name: teamAName, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl, score: scores.a, playerId: selectedGame.team_a_player_id }
                const teamBRow = { key: homeAwaySwapped ? 'away' : 'home', abbreviation: teamBAbbreviation, name: teamBName, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl, score: scores.b, playerId: selectedGame.team_b_player_id }
                return teamARow.key === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
              })().map((team) => (
                <div key={team.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.name} height={30} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: team.color, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{team.abbreviation} · {team.key === 'away' ? 'Away' : 'Home'}</div>
                      <div style={{ color: '#F8FAFC', fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getTeamShortName(identitiesByPlayerId[team.playerId]) || team.name}</div>
                    </div>
                  </div>
                  <div style={{ color: team.color, fontSize: 34, fontWeight: 900, lineHeight: 1 }}>{team.score}</div>
                </div>
              ))}
            </div>
            {effectiveGameStatus === 'complete' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                {[
                  { label: 'Winning Pitcher', tone: C.green, stint: pitcherDecisionSummary.winning },
                  { label: 'Losing Pitcher', tone: C.red, stint: pitcherDecisionSummary.losing },
                ].map((entry) => (
                  <div
                    key={entry.label}
                    onClick={entry.stint ? () => setViewedCharacterId(entry.stint.character_id) : undefined}
                    style={{ borderRadius: 14, border: `1px solid ${entry.tone}44`, background: `${entry.tone}14`, padding: 12, display: 'flex', alignItems: 'center', gap: 10, cursor: entry.stint ? 'pointer' : 'default' }}
                  >
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${entry.tone}` }}>
                      <Avatar name={charactersById[entry.stint?.character_id]?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: entry.tone, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{entry.label}</div>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.stint?.character_id]?.name || 'Not recorded'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>{entry.stint ? `IP ${entry.stint.innings_pitched ?? 0} / H ${entry.stint.hits_allowed ?? 0} / R ${entry.stint.runs_allowed ?? 0}` : 'Decision unavailable'}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                    <TeamLogo logoKey={battingIdentity?.teamLogoKey} logoUrl={battingIdentity?.teamLogoUrl || battingPlayer?.team_logo_url} teamName={battingPlayer?.name} height={14} />
                    Current Batter
                  </div>
                  <div
                    onClick={currentBatter ? () => setViewedCharacterId(currentBatter.character_id) : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentBatter ? 'pointer' : 'default' }}
                  >
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}` }}>
                      <Avatar name={charactersById[currentBatter?.character_id]?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[currentBatter?.character_id]?.name || 'Waiting on lineup'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>{currentBatter ? `AVG ${formatBaseballAverage(lineupStatsByEntryKey[currentEntryKey]?.source || {})} / ${formatHitsAtBats(currentBatterGameSummary)}` : 'No batter yet'}</div>
                    </div>
                  </div>
                </div>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12, display: 'grid', justifyItems: 'center', gap: 8 }}>
                  <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{offense?.halfLabel || 'Top 1'}</div>
                  <BaseStateDiamond runners={displayRunners} charactersById={charactersById} />
                  <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                    <CountDotRow label="B" count={Math.min(displayBalls, 3)} total={3} activeColor={C.green} inactiveColor={C.border} />
                    <CountDotRow label="S" count={Math.min(displayStrikes, 2)} total={2} activeColor={C.accent} inactiveColor={C.border} />
                    <CountDotRow label="O" count={Math.min(displayOutsInHalf, 2)} total={2} activeColor={C.red} inactiveColor={C.border} />
                  </div>
                </div>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                    <TeamLogo logoKey={pitchingIdentity?.teamLogoKey} logoUrl={pitchingIdentity?.teamLogoUrl || pitchingPlayer?.team_logo_url} teamName={pitchingPlayer?.name} height={14} />
                    Current Pitcher
                  </div>
                  <div
                    onClick={currentPitcherChar ? () => setViewedCharacterId(currentPitcherStint.character_id) : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentPitcherChar ? 'pointer' : 'default' }}
                  >
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${pitchingColor}` }}>
                      <Avatar name={currentPitcherChar?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentPitcherChar?.name || 'Waiting on pitcher'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>IP {currentPitcherGameLine.ip ?? 0} / H {currentPitcherGameLine.h ?? 0} / R {currentPitcherGameLine.r ?? 0} / K {currentPitcherGameLine.k ?? 0}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>Pitch Count {displayPitchNumber}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SectionCard>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <SectionCard title="Box Score" subtitle="Line score by inning">
            <BoxScoreTable
              innings={innings}
              scores={scores}
              completedHalfCount={completedHalfCount}
              currentInning={currentInning}
              teamAAbbreviation={teamAAbbreviation}
              teamBAbbreviation={teamBAbbreviation}
              teamAColor={teamAColor}
              teamBColor={teamBColor}
              teamALogoKey={teamALogoKey}
              teamALogoUrl={teamALogoUrl}
              teamBLogoKey={teamBLogoKey}
              teamBLogoUrl={teamBLogoUrl}
              teamAName={teamAName}
              teamBName={teamBName}
              compact={isNarrowViewport}
              swapped={homeAwaySwapped}
            />
          </SectionCard>
          <WinProbabilityCard
            points={winProbabilityPoints}
            currentHomeProbability={homeAwaySwapped ? 1 - currentWinProbability : currentWinProbability}
            homeLabel={homeAwaySwapped ? teamAAbbreviation : teamBAbbreviation}
            awayLabel={homeAwaySwapped ? teamBAbbreviation : teamAAbbreviation}
            homeColor={homeAwaySwapped ? teamAColor : teamBColor}
            awayColor={homeAwaySwapped ? teamBColor : teamAColor}
          />
        </div>

        {isNarrowViewport ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {[
                { side: 'A', abbreviation: teamAAbbreviation, name: teamAName, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl },
                { side: 'B', abbreviation: teamBAbbreviation, name: teamBName, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl },
              ].map(({ side, abbreviation, name, color, logoKey, logoUrl }) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => setViewedLineupSide(side)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 12,
                    border: `2px solid ${viewedLineupSide === side ? color : C.border}`,
                    background: viewedLineupSide === side ? `${color}22` : 'transparent',
                    color: viewedLineupSide === side ? color : C.muted,
                    fontWeight: 800, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  <TeamLogo logoKey={logoKey} logoUrl={logoUrl} teamName={name} height={24} />
                  {abbreviation}
                </button>
              ))}
            </div>
            {viewedLineupSide === 'A' ? (
              <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
            ) : (
              <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
            <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <PitchingStatsTable title={`${teamAAbbreviation} Pitchers`} stints={teamAPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
          <PitchingStatsTable title={`${teamBAbbreviation} Pitchers`} stints={teamBPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} onCharacterClick={(characterId) => setViewedCharacterId(characterId)} />
        </div>
      </div>
      {viewedCharacterId != null && (
        <BatterStatsModal
          characterId={viewedCharacterId}
          plateAppearances={plateAppearances}
          pitchingStints={pitchingStints}
          draftPicks={draftPicks}
          tournamentGameIds={tournamentGameIds}
          charactersById={charactersById}
          playersById={playersById}
          identitiesByPlayerId={identitiesByPlayerId}
          onClose={() => setViewedCharacterId(null)}
        />
      )}
    </div>
  )

  const renderLineupTeamCard = (team) => {
    const teamName = team === 'A' ? teamAName : teamBName
    const draft = lineupDrafts[team]
    const rosterCharMap = rosterCharMaps[team]
    const rosterCharsArray = Object.values(rosterCharMap)
    const rosterNames = rosterCharsArray.map((c) => c.chemistryName || c.name)
    const selectedFieldingCharId = selectedFieldingPlayer[team]
    const chemistryHighlightIds = buildChemistryHighlightSet(selectedFieldingCharId || null, rosterCharsArray)
    const positionByCharId = Object.fromEntries(Object.entries(draft.fielding).map(([fieldId, charId]) => [charId, fieldId]))

    return (
      <SectionCard title={teamName} subtitle="Batting order & fielding positions">
        <div className="roster-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {draft.order.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: C.muted, fontSize: 12 }}>No lineup set yet.</div>
            ) : (
              draft.order.map((charId, index) => {
                const character = rosterCharMap[charId]
                if (!character) return null
                return (
                  <div
                    key={charId}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={handleDropOnLineupSlot(team, index)}
                    style={{ borderRadius: 8 }}
                  >
                    <DraggableRosterItem
                      character={character}
                      onDragStart={handleLineupDragStart(charId)}
                      rosterNames={rosterNames}
                      onOpenCard={() => setViewedCharacterId(charId)}
                      compact
                      lineupNumber={index + 1}
                      positionLabel={positionByCharId[charId] || null}
                      onLineupNumberClick={() => handleLineupNumberClick(team, charId, index)}
                      lineupNumberSelected={selectedLineupMoveId[team] === charId}
                      lineupNumberAriaLabel={`Lineup spot ${index + 1}`}
                      lineupNumberTitle={selectedLineupMoveId[team] === charId ? 'Selected lineup slot' : 'Tap to move this player or move another player here'}
                      showChemistryNote={chemistryHighlightIds.has(charId)}
                      highlighted={selectedLineupMoveId[team] === charId}
                    />
                  </div>
                )
              })
            )}
          </div>

          <FieldingView
            charactersById={rosterCharMap}
            fieldingPositions={draft.fielding}
            setFieldingPositions={setFieldingPositionsForTeam(team)}
            selectedPlayer={selectedFieldingCharId}
            setSelectedPlayer={setSelectedFieldingPlayerForTeam(team)}
            fieldingAssignMode={false}
            selectedForFielding={null}
            onAssignPosition={() => {}}
            editable
            chemistryHighlightIds={chemistryHighlightIds}
          />
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: C.muted, textAlign: 'right' }}>
          {lineupSaveStatus[team] === 'saving' ? 'Saving…' : lineupSaveStatus[team] === 'saved' ? 'Saved' : ''}
        </div>
      </SectionCard>
    )
  }

  const renderLineupsView = () => (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {scorebookToolbar}
      {viewTabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to manage lineups.</div>
        ) : (
          <>
            <div style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>
              Changes apply starting in inning {currentInning} and update the scorebook, spectator view, and odds immediately.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
              {renderLineupTeamCard('A')}
              {renderLineupTeamCard('B')}
            </div>
          </>
        )}
      </div>
    </div>
  )

  const renderAdminView = () => {
    const sortedPAs = [...gamePAs].sort((a, b) => Number(b.pa_number || 0) - Number(a.pa_number || 0))
    return (
      <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
        {scorebookToolbar}
        {viewTabs}
        <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
          {!selectedGame ? (
            <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to manage scorebook corrections.</div>
          ) : (
            <>
              <SectionCard
                title="Scorebook Admin"
                subtitle={canEditScorebook ? 'Manual corrections for the active batting side and recorded plate appearances.' : 'Reopen the game to apply corrections.'}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                  <div style={{ display: 'grid', gap: 12 }}>
                    <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 14, display: 'grid', gap: 10 }}>
                      <div>
                        <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Current offense</div>
                        <div style={{ color: battingColor, fontSize: 16, fontWeight: 800 }}>
                          {getTeamShortName(battingIdentity) || battingPlayer?.name || 'Batting team'}
                        </div>
                      </div>
                      {[
                        { key: 'first', label: '1B' },
                        { key: 'second', label: '2B' },
                        { key: 'third', label: '3B' },
                      ].map((base) => {
                        const runner = runners[base.key]
                        return (
                          <div key={base.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', borderRadius: 10, border: `1px solid ${C.border}`, background: `${C.bg}AA` }}>
                            <div>
                              <div style={{ color: C.muted, fontSize: 11, fontWeight: 800 }}>{base.label}</div>
                              <div style={{ color: '#E2E8F0', fontSize: 13, fontWeight: 700 }}>
                                {runner ? charactersById[runner.characterId]?.name || 'Runner' : 'Empty'}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={!canEditScorebook || !runner}
                              onClick={() => removeRunnerFromBase(base.key)}
                            >
                              Clear
                            </button>
                          </div>
                        )
                      })}
                      <div style={{ display: 'grid', gap: 8 }}>
                        <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Add runner</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8 }}>
                          <select value={adminRunnerBase} onChange={(event) => setAdminRunnerBase(event.target.value)} disabled={!canEditScorebook}>
                            <option value="first">1st Base</option>
                            <option value="second">2nd Base</option>
                            <option value="third">3rd Base</option>
                          </select>
                          <select value={adminRunnerCharacterId} onChange={(event) => setAdminRunnerCharacterId(event.target.value)} disabled={!canEditScorebook}>
                            <option value="">Select batter</option>
                            {adminRunnerOptions.map((entry) => (
                              <option key={entry.id || `${entry.player_id}:${entry.character_id}`} value={entry.character_id}>
                                {charactersById[entry.character_id]?.name || `Character ${entry.character_id}`}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button type="button" className="solid-button" disabled={!canEditScorebook || !adminRunnerCharacterId} onClick={addAdminRunner}>
                          Add Runner
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <button type="button" className="ghost-button" disabled={!canEditScorebook || (!gamePAs.length && !paPitchRows.length)} onClick={handleUndoAction}>
                        Undo Latest Action
                      </button>
                      {isGameComplete ? (
                        <button type="button" className="solid-button" onClick={() => setShowReopenGameConfirm(true)}>
                          Reopen Game
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 14, display: 'grid', gap: 10, minHeight: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                      <div>
                        <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Plate appearances</div>
                        <div style={{ color: '#F8FAFC', fontSize: 15, fontWeight: 800 }}>Edit from Admin only</div>
                      </div>
                      <span style={{ color: C.muted, fontSize: 12 }}>{sortedPAs.length} logged</span>
                    </div>
                    <div style={{ display: 'grid', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
                      {!sortedPAs.length ? (
                        <div style={{ color: C.muted, fontSize: 13, textAlign: 'center', padding: '16px 0' }}>No plate appearances yet.</div>
                      ) : sortedPAs.map((pa) => {
                        const canEditThisPa = canEditScorebook
                          && Number(pa.inning) === Number(offense?.inning)
                          && String(pa.player_id) === String(offense?.battingPlayerId)
                        return (
                          <div key={pa.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: `${C.bg}AA` }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                PA #{pa.pa_number} · {charactersById[pa.character_id]?.name || 'Unknown batter'}
                              </div>
                              <div style={{ color: C.muted, fontSize: 12 }}>
                                Inning {pa.inning} · {formatPlayResultText(pa)}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={!canEditThisPa}
                              onClick={() => openPaEditor(pa)}
                              title={canEditThisPa ? 'Edit this plate appearance' : 'Only the current half-inning batting side can be edited in place right now.'}
                            >
                              Edit
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    <div style={{ color: C.muted, fontSize: 11 }}>
                      Older or opposite-side plate appearances should be corrected with undo/reopen until full historical PA editing is added.
                    </div>
                  </div>
                </div>
              </SectionCard>
            </>
          )}
        </div>
      </div>
    )
  }

  if (viewMode === 'lineups' && isScorekeeper) {
    return renderLineupsView()
  }

  if (viewMode === 'admin' && isScorekeeper) {
    return renderAdminView()
  }

  if (viewMode === 'game' || !isScorekeeper) {
    return renderGameView()
  }

  // ── Scorekeeper mode ────────────────────────────────────────────────────────
  return (
    <div className="scorebook-page-wrapper" style={{ color: C.text, paddingBottom: 90, margin: '-1.25rem -1.25rem 0' }}>
      {scorebookToolbar}
      {viewTabs}

      {/* ── Sticky header: score + inning strip ── */}
      <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} />
            {isScorekeeper && (
              <button
                type="button"
                className="ghost-button"
                onClick={toggleHomeAwaySwap}
                disabled={gamePAs.length > 0}
                title={gamePAs.length > 0
                  ? 'Home/Away can only be swapped before the first plate appearance is recorded.'
                  : 'Swap which team bats first (top of the inning) — updates the batting order, line score, and game view for everyone.'}
                style={{ fontSize: 11, padding: '6px 10px', opacity: gamePAs.length > 0 ? 0.5 : 1 }}
              >
                ⇄ Swap Home/Away
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: '0 12px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: 16, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}`, flexShrink: 0 }}>
                <Avatar name={charactersById[currentBatter?.character_id]?.name} size={48} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: battingColor, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <TeamLogo logoKey={battingIdentity?.teamLogoKey} logoUrl={battingIdentity?.teamLogoUrl || battingPlayer?.team_logo_url} teamName={battingPlayer?.name} height={14} />
                  Batter
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[currentBatter?.character_id]?.name || 'No batter'}</div>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>{currentBatter ? `${getTeamShortName(identitiesByPlayerId[currentBatter.player_id]) || playersById[currentBatter.player_id]?.name || ''} · #${currentBatter.batting_order}` : 'Waiting'}</div>
                {characterSeasonStats ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>AVG {formatBaseballAverage({ atBats: 1, avg: characterSeasonStats.avg })}</span>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>HR {characterSeasonStats.homeRuns}</span>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>RBI {characterSeasonStats.rbi}</span>
                  </div>
                ) : null}
              </div>
            </div>
            {/* ── Mini runner diamond ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              {/* diamond */}
              <div style={{ position: 'relative', width: 72, height: 72 }}>
                <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 72 72">
                  <polygon points="36,6 62,32 36,62 10,32" fill="rgba(148,163,184,0.04)" stroke={C.border} strokeWidth="1.5" />
                </svg>
                {/* 2B — top */}
                <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%,0)' }}>
                  {displayRunners.second
                    ? <div style={{ width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[displayRunners.second.characterId]?.name} size={22} /></div>
                    : <div style={{ width: 10, height: 10, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
                </div>
                {/* 1B — right */}
                <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translate(0,-50%)' }}>
                  {displayRunners.first
                    ? <div style={{ width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[displayRunners.first.characterId]?.name} size={22} /></div>
                    : <div style={{ width: 10, height: 10, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
                </div>
                {/* 3B — left */}
                <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translate(0,-50%)' }}>
                  {displayRunners.third
                    ? <div style={{ width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[displayRunners.third.characterId]?.name} size={22} /></div>
                    : <div style={{ width: 10, height: 10, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
                </div>
                {/* Home — bottom */}
                <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translate(-50%,0)' }}>
                  <div style={{ width: 8, height: 8, background: C.card, border: `1.5px solid ${C.border}`, transform: 'rotate(45deg)', borderRadius: 1 }} />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ minWidth: 0, textAlign: 'right' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: pitchingColor, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  Pitcher
                  <TeamLogo logoKey={pitchingIdentity?.teamLogoKey} logoUrl={pitchingIdentity?.teamLogoUrl || pitchingPlayer?.team_logo_url} teamName={pitchingPlayer?.name} height={14} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentPitcherChar?.name || 'No pitcher'}</div>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>{getTeamShortName(identitiesByPlayerId[currentPitcherStint?.player_id]) || playersById[currentPitcherStint?.player_id]?.name || 'Waiting'}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>IP {currentPitcherGameLine.ip ?? '0.0'}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>H {currentPitcherGameLine.h ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>R {currentPitcherGameLine.r ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>ER {currentPitcherGameLine.er ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>BB {currentPitcherGameLine.bb ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>K {currentPitcherGameLine.k ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>P {displayPitchNumber}</span>
                </div>
              </div>
              <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${pitchingColor}`, flexShrink: 0 }}>
                <Avatar name={currentPitcherChar?.name} size={48} />
              </div>
            </div>
          </div>
        </div>
        {/* Inning score strip */}
        <div style={{ overflowX: 'auto', scrollbarWidth: 'none' }}>
          <div style={{ display: 'flex', minWidth: 'max-content', padding: '2px 8px 4px', gap: 1, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 6, paddingTop: 18 }}>
              {lineScoreRows.map((team) => (
                <div key={team.battingSide} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 4, color: team.color, fontSize: 10, fontWeight: 700 }}>
                  <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.teamName} height={18} />
                  <span>{team.abbreviation}</span>
                </div>
              ))}
            </div>
            {innings.map(inn => {
              const isActive = inn === (viewedInning ?? currentInning)
              const isExtra  = inn > regulationInnings
              return (
                <div key={inn} onClick={() => setViewedInning(viewedInning === inn ? null : inn)} style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', width: 30 }}>
                  <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: inn === currentInning ? 700 : 400, color: inn === currentInning ? C.accent : isExtra ? '#F97316' : C.muted, borderBottom: isActive ? `2px solid ${C.accent}` : isExtra ? '2px solid #F97316' : '2px solid transparent' }}>{inn}</div>
                  {lineScoreRows.map((team) => (
                    <div key={team.battingSide} style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isActive ? `${C.accent}20` : 'transparent', border: isExtra ? '1px solid #F9731644' : 'none', borderRadius: 3, fontSize: 13, fontWeight: 700, color: C.text }}>{getLineScoreCellValue({ inning: inn, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}</div>
                  ))}
                </div>
              )
            })}
            {/* R / H / E totals */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8 }}>
              <div style={{ height: 18, display: 'flex', gap: 4 }}>{['R', 'H', 'E'].map(l => <div key={l} style={{ width: 24, textAlign: 'center', fontSize: 10, color: C.muted, fontWeight: 700 }}>{l}</div>)}</div>
              {lineScoreRows.map((team) => (
                <div key={team.battingSide} style={{ height: 26, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 800, color: team.color }}>{team.runs}</div>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{team.hits}</div>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{team.errors}</div>
                </div>
              ))}
            </div>
            <div style={{ marginLeft: 10, padding: '8px 10px', borderRadius: 12, border: `1px solid ${C.border}`, background: `${C.card}DD`, display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'center' }}>
              <CountDotRow label="B" count={Math.min(displayBalls, 3)} total={3} activeColor={C.green} inactiveColor={C.border} />
              <CountDotRow label="S" count={Math.min(displayStrikes, 2)} total={2} activeColor={C.accent} inactiveColor={C.border} />
              <CountDotRow label="O" count={Math.min(displayOutsInHalf, 2)} total={2} activeColor={C.red} inactiveColor={C.border} />
            </div>
          </div>
        </div>
        {viewedInning && viewedInning !== currentInning && (
          <button onClick={() => setViewedInning(null)} style={{ display: 'block', width: '100%', background: `${C.accent}22`, color: C.accent, border: 'none', padding: '5px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Jump to Current (Inn. {currentInning}) →
          </button>
        )}
      </div>

      {/* ── Main content ── */}
      <div style={{ padding: '8px 10px 0' }}>

        {/* Loading lineups indicator */}
        {!gameLineups.length && (
          <div style={{ background: `${C.accent}18`, border: `1px solid ${C.accent}44`, borderRadius: 10, padding: '8px 14px', marginBottom: 8 }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13 }}>Loading lineup…</div>
          </div>
        )}

        {/* ── Three-column: batting lineup | diamond | pitching lineup ── */}
        <div style={{ display: 'grid', gap: 8, marginBottom: 10, width: '100%' }}>

          {/* Left: batting team lineup */}
          <LineupColumn
            lineup={currentLineup}
            currentIdx={effectiveBatterIdx}
            teamColor={battingColor}
            stat="batting"
            draggable={false}
            charactersById={charactersById}
            orientation="horizontal"
            wrap={isNarrowViewport}
          />

          {/* Center: diamond */}
          {/* Right: pitching team lineup (drag to mound or tap to select) */}
          <LineupColumn
            lineup={defensiveLineup}
            currentIdx={-1}
            currentPitcherCharId={currentPitcherChar?.id}
            pendingPitcherCharId={selectedPitcher?.charId}
            teamColor={pitchingColor}
            stat="pitching"
            draggable={canEditScorebook}
            onDragStart={handlePitcherDragStart}
            onItemClick={canEditScorebook ? handlePitcherItemClick : undefined}
            charactersById={charactersById}
            orientation="horizontal"
            wrap={isNarrowViewport}
          />
        </div>

        {selectedGame && !gameLineups.length && <div style={{ background: C.card, borderRadius: 10, padding: 16, textAlign: 'center', marginBottom: 10, color: C.muted }}>No lineup set.</div>}
        {isGameComplete && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: `${C.green}18`, border: `1px solid ${C.green}44`, borderRadius: 10, padding: '10px 14px', marginBottom: 10, color: C.green, fontWeight: 700, fontSize: 13 }}>
            <span>Game complete. The scorebook is locked for viewing only.</span>
            {isScorekeeper && (
              <button
                type="button"
                onClick={() => setShowReopenGameConfirm(true)}
                style={{ background: C.card, color: C.green, border: `1px solid ${C.green}55`, borderRadius: 8, padding: '8px 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Reopen Game
              </button>
            )}
          </div>
        )}

        {/* ── Runner resolution panel ── */}
        {canEditScorebook && pendingPA && !showOutsBanner && !gameEndBanner && (
          <RunnerAssignmentsPanel
            pendingPA={pendingPA}
            onSetDestination={handleSetRunnerDestination}
            onConfirm={confirmPendingPA}
            onCancel={cancelPendingResolution}
            charactersById={charactersById}
          />
        )}

        {/* ── Game-end banner ── */}
        {gameEndBanner && !showOutsBanner && (
          <div style={{ background: `${C.green}18`, border: `2px solid ${C.green}`, borderRadius: 14, padding: 20, marginBottom: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: C.green, marginBottom: 4 }}>
              {gameEndBanner.type === 'mercy' ? '⚡ Mercy Rule!' : '🏁 Game Over!'}
            </div>
            <div style={{ color: C.text, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              {getTeamShortName(identitiesByPlayerId[gameEndBanner.winnerId]) || playersById[gameEndBanner.winnerId]?.name} wins {scores.a}–{scores.b}
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
              {gameEndBanner.type === 'mercy'
                ? `Mercy rule after ${gameEndBanner.inning} inning${gameEndBanner.inning !== 1 ? 's' : ''}`
                : gameEndBanner.inning > regulationInnings ? `Walk-off in extra inning ${gameEndBanner.inning}` : `Final after ${gameEndBanner.inning} innings`}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => markGameComplete(gameEndBanner.winnerId, gameEndBanner.inning, gameEndBanner.inning > regulationInnings)}
                style={{ background: C.green, color: '#000', border: 'none', borderRadius: 8, padding: '12px 24px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                Mark Complete ✓
              </button>
              <button onClick={() => setGameEndBanner(null)}
                style={{ background: C.card, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                Continue Playing
              </button>
            </div>
          </div>
        )}

        {canEditScorebook && !pendingPA && !pitchActionSheet && !inPlayState && !showOutsBanner && !gameEndBanner && currentBatter && (
          <div style={{ position: 'sticky', bottom: 0, zIndex: 22, marginBottom: 10 }}>
            {editingPa && (
              <div style={{ background: `${C.blue}18`, border: `1px solid ${C.blue}44`, borderRadius: 8, padding: '7px 12px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: C.blue, fontSize: 13 }}>Editing PA #{editingPa.pa_number} - {charactersById[editingPa.character_id]?.name}</span>
                <button onClick={() => setEditingPa(null)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={15} /></button>
              </div>
            )}
            <div style={{ background: 'rgba(15,23,42,0.98)', border: `1px solid ${C.border}`, borderRadius: 18, padding: 12, boxShadow: '0 -8px 30px rgba(0,0,0,0.28)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
                <button type="button" disabled={isSaving || isPitchActionPending} onClick={() => setStarPitchActive((current) => !current)} style={{ width: '100%', minHeight: 56, borderRadius: 14, border: `1px solid ${starPitchActive ? C.accent : C.border}`, background: starPitchActive ? `${C.accent}22` : C.card, color: starPitchActive ? C.accent : C.text, fontWeight: 800, opacity: isSaving || isPitchActionPending ? 0.55 : 1, cursor: isSaving || isPitchActionPending ? 'not-allowed' : 'pointer' }}>
                  {starPitchActive ? 'STAR PITCH ON' : 'STAR PITCH'}
                </button>
                <button type="button" disabled={isSaving || isPitchActionPending} onClick={() => setStarHitUsed((current) => {
                  if (current) setStarHitConnected(false)
                  return !current
                })} style={{ width: '100%', minHeight: 56, borderRadius: 14, border: `1px solid ${starHitUsed ? C.accent : C.border}`, background: starHitUsed ? `${C.accent}22` : C.card, color: starHitUsed ? C.accent : C.text, fontWeight: 800, opacity: isSaving || isPitchActionPending ? 0.55 : 1, cursor: isSaving || isPitchActionPending ? 'not-allowed' : 'pointer' }}>
                  {starHitUsed ? 'STAR HIT ON' : 'STAR HIT'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
                <button type="button" onClick={handlePitchBall} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>BALL</button>
                <button type="button" onClick={() => handleStrikeChoice('swinging')} disabled={!canRecordOutcome} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>SWING</button>
                <button type="button" onClick={() => handleStrikeChoice('looking')} disabled={!canRecordOutcome || starHitUsed} title={starHitUsed ? 'A star hit requires swinging.' : undefined} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.red}22`, color: starHitUsed ? C.muted : C.red, fontWeight: 800, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>LOOK</button>
                <button type="button" onClick={handlePitchFoul} disabled={!canRecordOutcome} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>FOUL</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                <button type="button" onClick={handlePitchHbp} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>HBP</button>
                <button type="button" onClick={handlePitchInPlay} disabled={!canRecordOutcome} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${C.border}`, background: `${C.green}22`, color: C.green, fontWeight: 800, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>IN PLAY</button>
              </div>
            </div>
          </div>
        )}


        {canEditScorebook && inPlayState && !showOutsBanner && !gameEndBanner && (
          <div style={{ background: 'rgba(15,23,42,0.98)', border: `1px solid ${C.border}`, borderRadius: 18, padding: 14, marginBottom: 10 }}>
            {buildInPlaySelectionSummary(inPlayState).length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                {buildInPlaySelectionSummary(inPlayState).map((item) => (
                  <div key={item.label} style={{ padding: '7px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}DD` }}>
                    <span style={{ color: C.muted, fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{item.label}</span>
                    <span style={{ marginLeft: 6, color: C.text, fontSize: 12, fontWeight: 700 }}>{item.value}</span>
                  </div>
                ))}
              </div>
            )}
            {inPlayState.stage === 'result' && (
              <>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>Ball In Play — Result</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                  {IN_PLAY_RESULT_OPTIONS.map((option) => {
                    const color = ZONE_COLOR[option.zone]
                    const disabledForOuts = isOutcomeDisabledForOuts(option.value, selectionOutsInHalf)
                    const disabledForRunners = isOutcomeDisabledForRunners(option.value, runners)
                    const disabled = disabledForOuts || disabledForRunners
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={disabled}
                        title={disabled ? (disabledForOuts ? `${option.label} is not available with two outs.` : `${option.label} requires a runner on base.`) : undefined}
                        onClick={() => {
                          if (disabled) return
                          setInPlayState((current) => ({
                            ...current,
                            stage: 'details',
                            resultType: option.resultType,
                            result: option.value,
                            trajectory: option.value === 'GO' ? 'G' : option.value === 'LO' ? 'L' : null,
                            landingSpot: null,
                            fielderChain: [],
                          }))
                        }}
                        style={{
                          minHeight: 52,
                          borderRadius: 14,
                          border: `1px solid ${disabled ? `${C.border}99` : color}`,
                          background: disabled ? 'rgba(148,163,184,0.12)' : `${color}22`,
                          color: disabled ? C.muted : color,
                          fontWeight: 800,
                          opacity: disabled ? 0.5 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                <button type="button" onClick={cancelInPlaySelection} style={{ width: '100%', minHeight: 48, marginTop: 8, borderRadius: 12, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700 }}>BACK</button>
              </>
            )}
            {inPlayState.stage === 'details' && (
              <div>
                {shouldShowTrajectoryChooser ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
                    {inPlayTrajectoryOptions.map((option) => <button key={option.value} type="button" onClick={() => setInPlayState((current) => ({ ...current, trajectory: option.value }))} style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${inPlayState.trajectory === option.value ? C.accent : C.border}`, background: inPlayState.trajectory === option.value ? `${C.accent}22` : C.card, color: inPlayState.trajectory === option.value ? C.accent : C.text, fontWeight: 800 }}>{option.label}</button>)}
                  </div>
                ) : null}
                <FieldPlayBuilder
                  fieldersByPosition={activeDefensiveFielders}
                  fielderChain={inPlayState.fielderChain || []}
                  landingSpot={inPlayState.landingSpot}
                  onFieldTap={(spot) => setInPlayState((current) => ({ ...current, landingSpot: spot }))}
                  onToggleFielder={(position) => setInPlayState((current) => {
                    const chain = current.fielderChain || []
                    const nextChain = chain.includes(position) ? chain.filter((p) => p !== position) : [...chain, position]
                    return { ...current, fielderChain: nextChain }
                  })}
                  notation={inPlayState.fielderChain?.length
                    ? (inPlayState.resultType === 'error'
                      ? assembleErrorNotation(inPlayState.trajectory, inPlayState.fielderChain, inPlayState.fielderChain[0])
                      : assembleNotation(inPlayState.trajectory, inPlayState.fielderChain))
                    : ''}
                  accent={C.accent}
                  label={inPlayState.result === 'HR' ? 'Mark Where The Ball Landed' : 'Build The Play'}
                  allowedPositions={inPlayAllowedPositions}
                  allowFielderSelection={inPlayState.result !== 'HR'}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => setInPlayState((current) => ({ ...current, stage: 'result', resultType: null, result: null, trajectory: null, landingSpot: null, fielderChain: [] }))} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700 }}>BACK</button>
                  <button type="button" disabled={!canFinalizeInPlaySelection(inPlayState)} onClick={() => finalizeInPlay(inPlayState)} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: `1px solid ${C.accent}`, background: `${C.accent}22`, color: C.accent, fontWeight: 800, opacity: !canFinalizeInPlaySelection(inPlayState) ? 0.5 : 1 }}>CONFIRM</button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* ── Undo + End game ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={handleUndoAction} disabled={!canEditScorebook || (!gamePAs.length && !paPitchRows.length)}
            style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canEditScorebook && (gamePAs.length || paPitchRows.length) ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canEditScorebook && (gamePAs.length || paPitchRows.length) ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <RotateCcw size={14} /> Undo
          </button>
          <button onClick={handleRedoAction} disabled={!canEditScorebook || !canRedoAction}
            style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canEditScorebook && canRedoAction ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canEditScorebook && canRedoAction ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <RotateCw size={14} /> Redo
          </button>
          <button onClick={() => setShowEndGameConfirm(true)} disabled={isGameComplete}
            style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: isGameComplete ? C.muted : C.text, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: isGameComplete ? 'not-allowed' : 'pointer', fontSize: 13 }}>
            End Game
          </button>
        </div>

        {/* ── PA Log ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>PA Log {viewedInning ? `· Inn. ${viewedInning}` : ''}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {canEditScorebook ? <span style={{ color: C.muted, fontSize: 11 }}>Edit from the Admin tab.</span> : null}
              {viewedInning && <button onClick={() => setViewedInning(null)} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 12, cursor: 'pointer' }}>Show All</button>}
            </div>
          </div>
          {halfInningPaGroups.length === 0 && <div style={{ color: C.muted, fontSize: 14, textAlign: 'center', padding: '16px 0' }}>No plate appearances yet.</div>}
          {halfInningPaGroups.map((group) => {
            const isExpanded = halfInningOverrides[group.key] ?? !group.isCompleted
            const sideLabel = group.isTop ? `Top ${group.inning}` : `Bottom ${group.inning}`
            const sideAbbreviation = group.isTeamABatting ? teamAAbbreviation : teamBAbbreviation
            const sideColor = group.isTeamABatting ? teamAColor : teamBColor
            return (
              <div key={group.key} style={{ marginBottom: 6, border: `1px solid ${C.border}33`, borderRadius: 10, overflow: 'hidden' }}>
                <div
                  onClick={() => setHalfInningOverrides(prev => ({ ...prev, [group.key]: !isExpanded }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', background: `${C.card}AA` }}
                >
                  {isExpanded ? <ChevronDown size={16} color={C.muted} /> : <ChevronRight size={16} color={C.muted} />}
                  <span style={{ color: sideColor, fontWeight: 800, fontSize: 13 }}>{sideLabel} · {sideAbbreviation}</span>
                  <span style={{ color: C.muted, fontSize: 12 }}>{group.pas.length} PA{group.pas.length === 1 ? '' : 's'}</span>
                  {group.runs > 0 && <span style={{ color: C.green, fontSize: 12, fontWeight: 700 }}>{group.runs} run{group.runs === 1 ? '' : 's'}</span>}
                  {group.isCompleted && <span style={{ color: C.muted, fontSize: 11, marginLeft: 'auto' }}>Final</span>}
                </div>
                {isExpanded && (
                  <div style={{ padding: '0 12px' }}>
                    {group.pas.map(pa => (
                      <div
                        key={pa.id}
                        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}22` }}
                      >
                        <Avatar name={charactersById[pa.character_id]?.name} size={30} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{charactersById[pa.character_id]?.name}</span>
                        </div>
                        <ResultBadge result={pa.result} strikeoutType={pa.strikeout_type} />
                        {getCreditedRbiForPa(pa) > 0 && <span style={{ color: C.accent, fontSize: 12, fontWeight: 700, minWidth: 36 }}>+{getCreditedRbiForPa(pa)}</span>}
                        {pa.run_scored && <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>R</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Add Game Modal ── */}
      {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}

      {/* ── Scorebook Access Modal ── */}
      {/* ── End Game Confirmation Modal ── */}
      {showEndGameConfirm && (
        <EndGameConfirmModal
          scores={scores}
          teamAName={teamAName}
          teamBName={teamBName}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          onConfirm={() => { setShowEndGameConfirm(false); markGameComplete() }}
          onClose={() => setShowEndGameConfirm(false)}
        />
      )}
      {showReopenGameConfirm && (
        <ReopenGameConfirmModal
          scores={scores}
          teamAName={teamAName}
          teamBName={teamBName}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          onConfirm={() => reopenCompletedGame()}
          onClose={() => setShowReopenGameConfirm(false)}
        />
      )}
    </div>
  )
}

// ─── Add Game Modal (shared) ──────────────────────────────────────────────────
function StadiumSelectionFields({ stadiums, selectedStadiumId, isNight, onSelectStadium, onToggleTime }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(selectedStadiumId)) || orderedStadiums[0] || null

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stadium</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedStadium?.name || 'Select a stadium'}</div>
        </div>
        <button
          onClick={onToggleTime}
          disabled={!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)}
          type="button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            borderRadius: 999,
            border: `1px solid ${C.border}`,
            background: selectedStadium && normalizeIsNightForStadium(selectedStadium, isNight) ? 'rgba(59,130,246,0.18)' : 'rgba(234,179,8,0.16)',
            color: C.text,
            padding: '10px 14px',
            cursor: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 'not-allowed' : 'pointer',
            opacity: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 0.65 : 1,
            fontWeight: 700,
          }}
        >
          {selectedStadium && normalizeIsNightForStadium(selectedStadium, isNight) ? <Moon size={16} /> : <Sun size={16} />}
          {selectedStadium ? getStadiumTimeLabel(selectedStadium, isNight) : 'Day'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {orderedStadiums.map((stadium) => {
          const active = String(selectedStadiumId) === String(stadium.id)
          const stadiumIsNight = normalizeIsNightForStadium(stadium, active ? isNight : false)
          return (
            <button
              key={stadium.id}
              onClick={() => onSelectStadium(stadium)}
              type="button"
              style={{
                textAlign: 'left',
                padding: 14,
                borderRadius: 14,
                border: `1.5px solid ${active ? C.accent : C.border}`,
                background: active ? 'rgba(234,179,8,0.12)' : C.bg,
                color: C.text,
                cursor: 'pointer',
              }}
            >
              <StadiumLogo name={stadium.name} height={52} />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{stadium.name}</div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>LF {stadium.lf_distance} / CF {stadium.cf_distance} / RF {stadium.rf_distance}</div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
                  {stadiumIsNight ? <Moon size={12} /> : <Sun size={12} />}
                  {getStadiumTimeLabel(stadium, stadiumIsNight)}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 10, gap: 10 }}>
                <span style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>
                  {stadium.night_only ? 'Night only' : stadium.day_only ? 'Day only' : 'Day or night'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

function AddGameModal({ players, stadiums, addGameForm, setAddGameForm, onAdd, onClose }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(addGameForm.stadiumId)) || orderedStadiums[0] || null

  const setStadium = (stadium) => {
    setAddGameForm((current) => ({
      ...current,
      stadiumId: stadium.id,
      isNight: normalizeIsNightForStadium(stadium, current.isNight),
    }))
  }

  const toggleTime = () => {
    if (!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)) return
    setAddGameForm((current) => ({
      ...current,
      isNight: !normalizeIsNightForStadium(selectedStadium, current.isNight),
    }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Add Game</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stage / Round</span>
            <input type="text" placeholder="e.g. Winners Final" value={addGameForm.stage}
              onChange={e => setAddGameForm(cur => ({ ...cur, stage: e.target.value }))}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }} />
          </label>
          {[{ label: 'Team A', key: 'teamA' }, { label: 'Team B', key: 'teamB' }].map(f => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>{f.label}</span>
              <select value={addGameForm[f.key]} onChange={e => setAddGameForm(cur => ({ ...cur, [f.key]: e.target.value }))}
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ))}
        </div>

        <StadiumSelectionFields
          stadiums={stadiums}
          selectedStadiumId={addGameForm.stadiumId}
          isNight={addGameForm.isNight}
          onSelectStadium={setStadium}
          onToggleTime={toggleTime}
        />

        <button onClick={onAdd} disabled={!selectedStadium} style={{ width: '100%', background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '14px 0', fontWeight: 800, fontSize: 16, cursor: selectedStadium ? 'pointer' : 'not-allowed', marginTop: 20, opacity: selectedStadium ? 1 : 0.6 }}>
          Add Game
        </button>
      </div>
    </div>
  )
}

// ─── End Game Confirmation Modal ─────────────────────────────────────────────
function EndGameConfirmModal({ scores, teamAName, teamBName, teamAColor, teamBColor, onConfirm, onClose }) {
  const tied = scores.a === scores.b
  const winner = scores.a > scores.b ? teamAName : scores.b > scores.a ? teamBName : null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>End Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, fontSize: 22, fontWeight: 900 }}>
          <span style={{ color: teamAColor }}>{teamAName} {scores.a}</span>
          <span style={{ color: C.muted, fontWeight: 400 }}>–</span>
          <span style={{ color: teamBColor }}>{teamBName} {scores.b}</span>
        </div>
        {tied ? (
          <div style={{ color: '#F97316', fontWeight: 700, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            ⚠ Game is tied — ending will record no winner.
          </div>
        ) : (
          <div style={{ color: C.muted, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            <span style={{ color: winner === teamAName ? teamAColor : teamBColor, fontWeight: 700 }}>{winner}</span> wins.
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onConfirm} style={{ flex: 1, background: C.green, color: '#000', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Confirm End
          </button>
          <button onClick={onClose} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Batter Stats Modal ───────────────────────────────────────────────────────
function ReopenGameConfirmModal({ scores, teamAName, teamBName, teamAColor, teamBColor, onConfirm, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Reopen Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, fontSize: 22, fontWeight: 900 }}>
          <span style={{ color: teamAColor }}>{teamAName} {scores.a}</span>
          <span style={{ color: C.muted, fontWeight: 400 }}>-</span>
          <span style={{ color: teamBColor }}>{teamBName} {scores.b}</span>
        </div>
        <div style={{ color: C.muted, textAlign: 'center', marginBottom: 16, fontSize: 14, lineHeight: 1.5 }}>
          Reopening will unlock the scorebook, clear the final result, and roll back postgame standings, bracket advancement, and bet settlement so you can fix mistakes.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onConfirm} style={{ flex: 1, background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Confirm Reopen
          </button>
          <button onClick={onClose} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function BatterStatsModal({ characterId, plateAppearances, pitchingStints, draftPicks, tournamentGameIds, charactersById, playersById, identitiesByPlayerId, onClose }) {
  const char = charactersById[characterId]
  if (!char) return null

  const charPAs = plateAppearances.filter((pa) => pa.character_id === characterId && tournamentGameIds.has(String(pa.game_id)))
  const charStints = pitchingStints.filter((stint) => stint.character_id === characterId && tournamentGameIds.has(String(stint.game_id)))
  const battingStats = summarizeBatting(charPAs)
  battingStats.ops = battingStats.obp + battingStats.slg
  const pitchingStats = summarizePitching(charStints)

  const ownerPick = (draftPicks || []).find((pick) => Number(pick.character_id) === Number(characterId) && pick.is_active !== false) || null
  const currentOwner = ownerPick ? { player_id: ownerPick.player_id } : null

  return (
    <CharacterDetailModal
      character={char}
      allCharactersById={charactersById}
      playersById={playersById}
      identitiesByPlayerId={identitiesByPlayerId}
      currentTournamentBatting={{ ...battingStats, rawPas: charPAs }}
      currentTournamentPitching={{ ...pitchingStats, rawStints: charStints }}
      allTimeBatting={{ ...battingStats, rawPas: charPAs }}
      allTimePitching={{ ...pitchingStats, rawStints: charStints }}
      currentOwner={currentOwner}
      onClose={onClose}
    />
  )
}



